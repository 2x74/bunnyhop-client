#include "native_log.hpp"
#include "data_location.hpp"
#include "log_scrub.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <streambuf>
#include <thread>
#include <utility>
#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/utsname.h>
#include <unistd.h>
#endif
#ifdef __APPLE__
#include <sys/sysctl.h>
#endif

namespace native::log {
namespace {
namespace fs = std::filesystem;
constexpr uint64_t file_byte_limit = 4 * 1024 * 1024;
constexpr int previous_sessions_kept = 2;
constexpr size_t queue_byte_limit = 2 * 1024 * 1024;
constexpr size_t queued_line_byte_limit = 16 * 1024;
constexpr size_t crash_context_bytes = 256;
constexpr size_t tail_bytes_read = 256;
constexpr std::string_view clean_exit_line = "Session ended";

#ifdef _WIN32
using FileHandle = HANDLE;
const FileHandle no_file = INVALID_HANDLE_VALUE;
#else
using FileHandle = int;
constexpr FileHandle no_file = -1;
#endif

// Written straight to the OS with no buffer in this process, so a crash loses only what is still in the queue.
class LogFile {
public:
    bool open(const fs::path &path) {
#ifdef _WIN32
        // Another program can read, rename or delete the file while the game runs.
        const HANDLE handle = CreateFileW(
                path.c_str(),
                FILE_APPEND_DATA,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                nullptr,
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                nullptr
        );
#else
        const int handle = ::open(path.c_str(), O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0644);
#endif
        handle_.store(handle, std::memory_order_release);
        return handle != no_file;
    }

    void close() {
        const auto handle = handle_.exchange(no_file, std::memory_order_acq_rel);
        if (handle == no_file) return;
#ifdef _WIN32
        CloseHandle(handle);
#else
        ::close(handle);
#endif
    }

    bool is_open() const { return handle_.load(std::memory_order_acquire) != no_file; }

    void append(const char *text, size_t size) noexcept {
        const auto handle = handle_.load(std::memory_order_acquire);
        if (handle == no_file) return;
#ifdef _WIN32
        DWORD written = 0;
        WriteFile(handle, text, DWORD(size), &written, nullptr);
#else
        while (size) {
            const auto written = ::write(handle, text, size);
            if (written <= 0) return;
            text += written;
            size -= size_t(written);
        }
#endif
    }

private:
    std::atomic<FileHandle> handle_{no_file};
};

std::string home_folder() {
    try {
#ifdef _WIN32
        constexpr DWORD longest_variable = 32767;
        std::wstring home(longest_variable, L'\0');
        const DWORD length = GetEnvironmentVariableW(L"USERPROFILE", home.data(), longest_variable);
        if (!length || length >= longest_variable) return {};
        home.resize(length);
        return data_location::utf8(fs::path(home));
#else
        const char *home = std::getenv("HOME");
        return home ? std::string(home) : std::string();
#endif
    } catch (...) {
        return {};
    }
}

struct Line {
    std::chrono::system_clock::time_point at;
    std::string text;
};

// Never destroyed: a worker the game couldn't stop may still log while the process exits, and a crash handler can run
// at any moment.
class Writer {
public:
    static Writer &instance() {
        static Writer &writer = *std::make_unique<Writer>().release();
        return writer;
    }

    void start() {
        std::lock_guard lock(mutex_);
        if (running_) return;
        stopping_ = false;
        opened_ = false;
        home_ = home_folder();
        thread_ = std::thread([this] { run(); });
        running_ = true;
    }

    void stop() {
        {
            std::lock_guard lock(mutex_);
            if (!running_) return;
            queue_.push_back({std::chrono::system_clock::now(), std::string(clean_exit_line)});
            ++enqueued_;
            stopping_ = true;
        }
        wake_.notify_all();
        thread_.join();
        std::lock_guard lock(mutex_);
        running_ = false;
        file_.close();
        queue_.clear();
        queued_bytes_ = 0;
        requested_.reset();
        last_text_.clear();
        repeats_ = 0;
        written_ = enqueued_;
    }

    void request_open(fs::path directory, std::vector<std::string> header) {
        {
            std::lock_guard lock(mutex_);
            if (opened_ || !running_) return;
            opened_ = true;
            requested_ = std::move(directory);
            header_ = std::move(header);
        }
        wake_.notify_all();
    }

    void enqueue(std::string_view text) {
        Line line{std::chrono::system_clock::now(), std::string(text.substr(0, queued_line_byte_limit))};
        {
            std::lock_guard lock(mutex_);
            if (!running_) return;
            if (queued_bytes_ + line.text.size() > queue_byte_limit) {
                ++dropped_;
                return;
            }
            queued_bytes_ += line.text.size();
            queue_.push_back(std::move(line));
            ++enqueued_;
        }
        wake_.notify_all();
    }

    bool wait_until_written(std::chrono::milliseconds limit) {
        std::unique_lock lock(mutex_);
        const auto target = enqueued_;
        return written_cv_.wait_for(lock, limit, [&] { return written_ >= target || !running_; });
    }

    std::string scrub_line(std::string_view line) {
        std::string home;
        {
            std::lock_guard lock(mutex_);
            home = home_.empty() ? home_folder() : home_;
        }
        return scrub(line, home);
    }

    void write_raw(const char *text, size_t size) noexcept { file_.append(text, size); }

private:
    void run() noexcept {
        std::unique_lock lock(mutex_);
        for (;;) {
            wake_.wait(lock, [&] { return stopping_ || requested_ || (file_ready_ && !queue_.empty()); });
            if (requested_) {
                const auto directory = std::move(*requested_);
                requested_.reset();
                lock.unlock();
                begin_session(directory);
                lock.lock();
                continue;
            }
            if (!queue_.empty() && (file_ready_ || stopping_)) {
                std::deque<Line> batch;
                batch.swap(queue_);
                queued_bytes_ = 0;
                const auto dropped = std::exchange(dropped_, 0);
                const auto batch_end = enqueued_;
                lock.unlock();
                write_batch(batch, dropped);
                lock.lock();
                written_ = batch_end;
                written_cv_.notify_all();
                continue;
            }
            if (stopping_) break;
        }
        written_ = enqueued_;
        written_cv_.notify_all();
        file_ready_ = false;
    }

    void begin_session(const fs::path &directory) noexcept {
        try {
            std::error_code error;
            fs::create_directories(directory, error);
            directory_ = directory;
            current_ = directory / fs::path(file_name);
            const bool unclean = last_session_was_unclean();
            rotate();
            if (open_current()) {
                write_header();
                if (unclean)
                    write_text("The session before this one ended without a clean exit. Its log is the .1 file here.");
            } else
                std::cerr << "Log file: could not open " << data_location::utf8(current_) << '\n';
        } catch (...) {
        }
        std::lock_guard lock(mutex_);
        file_ready_ = true;
    }

    bool last_session_was_unclean() const {
        std::ifstream file(current_, std::ios::binary);
        if (!file) return false;
        file.seekg(0, std::ios::end);
        const auto size = std::streamoff(file.tellg());
        if (size <= 0) return false;
        const auto read = std::min<std::streamoff>(size, tail_bytes_read);
        file.seekg(size - read);
        std::string tail(size_t(read), '\0');
        file.read(tail.data(), read);
        return tail.find(clean_exit_line) == tail.npos;
    }

    fs::path previous(int age) const {
        return directory_ / (fs::path(file_name).stem().string() + "." + std::to_string(age) + ".log");
    }

    void rotate() {
        std::error_code error;
        fs::remove(previous(previous_sessions_kept), error);
        for (int age = previous_sessions_kept; age > 1; --age)
            fs::rename(previous(age - 1), previous(age), error);
        fs::rename(current_, previous(1), error);
    }

    bool open_current() {
        if (!file_.open(current_)) return false;
        std::error_code error;
        const auto size = fs::file_size(current_, error);
        file_bytes_ = error ? 0 : size;
        return true;
    }

    void write_header() {
        std::vector<std::string> header;
        {
            std::lock_guard lock(mutex_);
            header = header_;
        }
        for (const auto &line : header)
            write_text(line);
    }

    void write_batch(const std::deque<Line> &batch, uint64_t dropped) noexcept {
        for (const auto &line : batch) {
            try {
                write_line(line);
            } catch (...) {
            }
        }
        try {
            if (dropped) write_text("The log couldn't keep up and dropped " + std::to_string(dropped) + " lines here.");
        } catch (...) {
        }
    }

    void write_line(const Line &line) {
        auto text = scrub(line.text, home_);
        if (text == last_text_) {
            ++repeats_;
            return;
        }
        finish_repeats(line.at);
        last_text_ = text;
        append_stamped(line.at, text);
    }

    void finish_repeats(std::chrono::system_clock::time_point at) {
        if (!repeats_) return;
        const auto count = std::exchange(repeats_, 0);
        append_stamped(at, "(the line above came " + std::to_string(count) + " more times)");
    }

    void write_text(const std::string &text) { append_stamped(std::chrono::system_clock::now(), scrub(text, home_)); }

    void append_stamped(std::chrono::system_clock::time_point at, const std::string &text) {
        std::array<char, timestamp_bytes> stamp{};
        format_timestamp(at, stamp.data());
        std::string record(stamp.data(), timestamp_bytes);
        record += ' ';
        record += text;
        record += '\n';
        if (file_bytes_ + record.size() > file_byte_limit && !start_next_file()) return;
        file_.append(record.data(), record.size());
        file_bytes_ += record.size();
    }

    // False when the file is full and something else holds it open: lines are dropped rather than grow it for good.
    bool start_next_file() {
        if (rolling_) return true;
        rolling_ = true;
        file_.close();
        rotate();
        const bool opened = open_current();
        const bool room = opened && file_bytes_ < file_byte_limit;
        if (room) write_header();
        rolling_ = false;
        return room;
    }

    std::mutex mutex_;
    std::condition_variable wake_, written_cv_;
    std::deque<Line> queue_;
    size_t queued_bytes_ = 0;
    uint64_t dropped_ = 0, enqueued_ = 0, written_ = 0;
    bool running_ = false, stopping_ = false, opened_ = false, file_ready_ = false;
    std::optional<fs::path> requested_;
    std::vector<std::string> header_;
    std::string home_;
    std::thread thread_;
    // The writer thread's own, apart from file_.append, which a crash handler may also call.
    LogFile file_;
    fs::path directory_, current_;
    uint64_t file_bytes_ = 0;
    std::string last_text_;
    uint64_t repeats_ = 0;
    bool rolling_ = false;
};

std::array<std::atomic<char>, crash_context_bytes> crash_context{};

// Sends whole lines to the log and everything on to the original stderr. A line is assembled per thread, because one
// std::cerr statement is several writes and other threads write in between.
class TeeBuffer : public std::streambuf {
public:
    void install() {
        if (!original_.load()) original_.store(std::cerr.rdbuf(this));
    }

    void remove() {
        if (auto *original = original_.exchange(nullptr)) std::cerr.rdbuf(original);
    }

protected:
    int_type overflow(int_type value) override {
        if (traits_type::eq_int_type(value, traits_type::eof())) return traits_type::not_eof(value);
        const char c = traits_type::to_char_type(value);
        xsputn(&c, 1);
        return value;
    }

    std::streamsize xsputn(const char *text, std::streamsize count) override {
        if (auto *original = original_.load()) original->sputn(text, count);
        collect({text, size_t(count)});
        return count;
    }

    int sync() override {
        auto *original = original_.load();
        return original ? original->pubsync() : 0;
    }

private:
    static void collect(std::string_view text) noexcept {
        try {
            thread_local std::string partial;
            for (size_t newline = text.find('\n'); newline != text.npos; newline = text.find('\n')) {
                partial += text.substr(0, newline);
                Writer::instance().enqueue(partial);
                partial.clear();
                text.remove_prefix(newline + 1);
            }
            partial += text;
        } catch (...) {
        }
    }

    std::atomic<std::streambuf *> original_{nullptr};
};

TeeBuffer &tee() {
    static TeeBuffer &buffer = *std::make_unique<TeeBuffer>().release();
    return buffer;
}

// The date of a day count from 1970-01-01 (Howard Hinnant's civil_from_days): plain arithmetic, so a signal handler can
// use it too.
struct CivilDate {
    int64_t year;
    unsigned month, day;
};

CivilDate civil_from_days(int64_t days) {
    constexpr int64_t days_per_era = 146097;
    days += 719468;
    const int64_t era = (days >= 0 ? days : days - days_per_era + 1) / days_per_era;
    const auto of_era = uint64_t(days - era * days_per_era);
    const auto year_of_era = (of_era - of_era / 1460 + of_era / 36524 - of_era / 146096) / 365;
    const auto day_of_year = of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    const auto shifted_month = (5 * day_of_year + 2) / 153;
    const unsigned day = unsigned(day_of_year - (153 * shifted_month + 2) / 5 + 1);
    const unsigned month = unsigned(shifted_month < 10 ? shifted_month + 3 : shifted_month - 9);
    return {int64_t(year_of_era) + era * 400 + (month <= 2 ? 1 : 0), month, day};
}

void put_digits(char *out, uint64_t value, int digits) noexcept {
    for (int index = digits - 1; index >= 0; --index) {
        out[index] = char('0' + value % 10);
        value /= 10;
    }
}
}  // namespace

std::filesystem::path folder(const std::filesystem::path &data) {
    return data / "logs";
}

Session::Session() {
    try {
        Writer::instance().start();
        tee().install();
    } catch (...) {
    }
}

Session::~Session() {
    try {
        tee().remove();
        Writer::instance().stop();
    } catch (...) {
    }
}

void open(const std::filesystem::path &data, std::vector<std::string> header) {
    try {
        Writer::instance().request_open(folder(data), std::move(header));
    } catch (...) {
    }
}

void write(std::string_view line) noexcept {
    try {
        Writer::instance().enqueue(line);
    } catch (...) {
    }
}

bool wait_until_written(std::chrono::milliseconds limit) noexcept {
    try {
        return Writer::instance().wait_until_written(limit);
    } catch (...) {
        return false;
    }
}

std::string scrub_line(std::string_view line) {
    return Writer::instance().scrub_line(line);
}

void write_raw(const char *text, size_t size) noexcept {
    Writer::instance().write_raw(text, size);
}

void set_crash_context(std::string_view text) noexcept {
    const size_t size = std::min(text.size(), crash_context.size() - 1);
    for (size_t index = 0; index < size; ++index)
        crash_context[index].store(text[index], std::memory_order_relaxed);
    crash_context[size].store('\0', std::memory_order_release);
}

size_t read_crash_context(char *out, size_t capacity) noexcept {
    size_t size = 0;
    while (size + 1 < capacity && size < crash_context.size()) {
        const char c = crash_context[size].load(std::memory_order_acquire);
        if (!c) break;
        out[size++] = c;
    }
    return size;
}

void format_timestamp(std::chrono::system_clock::time_point when, char *out) noexcept {
    using namespace std::chrono;
    const auto since_epoch = duration_cast<milliseconds>(when.time_since_epoch()).count();
    constexpr int64_t ms_per_day = 86'400'000;
    const int64_t days = (since_epoch >= 0 ? since_epoch : since_epoch - ms_per_day + 1) / ms_per_day;
    const int64_t of_day = since_epoch - days * ms_per_day;
    const auto date = civil_from_days(days);
    put_digits(out, uint64_t(date.year), 4);
    out[4] = '-';
    put_digits(out + 5, date.month, 2);
    out[7] = '-';
    put_digits(out + 8, date.day, 2);
    out[10] = 'T';
    put_digits(out + 11, uint64_t(of_day / 3'600'000), 2);
    out[13] = ':';
    put_digits(out + 14, uint64_t(of_day / 60'000 % 60), 2);
    out[16] = ':';
    put_digits(out + 17, uint64_t(of_day / 1000 % 60), 2);
    out[19] = '.';
    put_digits(out + 20, uint64_t(of_day % 1000), 3);
    out[23] = 'Z';
}

std::string os_description() {
#ifdef _WIN32
    using GetVersionFunction = LONG(WINAPI *)(OSVERSIONINFOW *);
    const auto get_version =
            reinterpret_cast<GetVersionFunction>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
    OSVERSIONINFOW info{};
    info.dwOSVersionInfoSize = sizeof(info);
    if (!get_version || get_version(&info) != 0) return "Windows";
    return "Windows " + std::to_string(info.dwMajorVersion) + "." + std::to_string(info.dwMinorVersion) + "."
           + std::to_string(info.dwBuildNumber);
#else
    std::string description;
#ifdef __APPLE__
    std::array<char, 64> version{};
    size_t version_size = version.size();
    if (sysctlbyname("kern.osproductversion", version.data(), &version_size, nullptr, 0) == 0)
        description = "macOS " + std::string(version.data());
#endif
    utsname kernel{};
    if (uname(&kernel) != 0) return description;
    if (description.empty()) description = std::string(kernel.sysname) + " " + kernel.release;
    return description + " " + kernel.machine;
#endif
}

}  // namespace native::log
