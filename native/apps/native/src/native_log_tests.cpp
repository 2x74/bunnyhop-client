#include "crash_note.hpp"
#include "log_scrub.hpp"
#include "native_log.hpp"
#include "native_log_sdl.hpp"
#include <algorithm>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <exception>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {
namespace fs = std::filesystem;
constexpr auto written_limit = std::chrono::seconds(5);

void check(bool value, const std::string &message) {
    if (!value) throw std::runtime_error(message);
}

std::string read_text(const fs::path &path) {
    std::ifstream file(path, std::ios::binary);
    std::ostringstream out;
    out << file.rdbuf();
    return out.str();
}

bool contains(const std::string &text, const std::string &part) {
    return text.find(part) != text.npos;
}

struct TemporaryFolder {
    fs::path path =
            fs::temp_directory_path()
            / ("native-log-test-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));

    TemporaryFolder() { fs::create_directories(path); }

    ~TemporaryFolder() {
        std::error_code error;
        fs::remove_all(path, error);
    }

    fs::path log(const std::string &name = std::string(native::log::file_name)) const {
        return native::log::folder(path) / name;
    }
};

void check_scrub_removes(const std::string &line, const std::vector<std::string> &secrets, const std::string &kept) {
    const auto out = native::log::scrub(line, "/Users/jane.doe");
    for (const auto &secret : secrets)
        check(!contains(out, secret), "'" + secret + "' survived in: " + out);
    check(contains(out, kept), "'" + kept + "' was lost from: " + out);
}

void check_privacy() {
    check_scrub_removes("Bearer abc.def-123", {"abc.def-123"}, "Bearer");
    check_scrub_removes("Authorization: Bearer abc123 trailing", {"abc123", "trailing"}, "Authorization");
    check_scrub_removes("Set-Cookie: sid=abc123; Path=/; HttpOnly", {"abc123", "HttpOnly"}, "Set-Cookie");
    check_scrub_removes("cookie=abc123", {"abc123"}, "cookie");
    check_scrub_removes("{\"token\":\"tok_abc\",\"map\":\"bhop_a\"}", {"tok_abc"}, "bhop_a");
    check_scrub_removes("{\"password\":\"hunter2\"}", {"hunter2"}, "password");
    check_scrub_removes("Password: hunter2 rejected", {"hunter2"}, "rejected");
    check_scrub_removes("refreshToken=abc&map=bhop_a", {"abc"}, "bhop_a");
    check_scrub_removes("mail jane.doe+x@example.co.uk sent", {"jane.doe", "example.co.uk"}, "<email>");
    check_scrub_removes(
            "GET https://bunnyhop.lol/api/auth/discord/callback?code=abc123&state=xyz",
            {"abc123", "xyz", "?"},
            "/api/auth/discord/callback"
    );
    check_scrub_removes("https://user:pw@bunnyhop.lol/x#frag", {"user", "pw", "frag"}, "bunnyhop.lol/x");
    check_scrub_removes("Download /api/auth/x?signin=abc123: 404", {"abc123"}, "/api/auth/x");
    check_scrub_removes("join discord.gg/AbCd123 now", {"AbCd123"}, "discord.gg/");
    check_scrub_removes("discordCode: 482910 was used", {"482910"}, "was used");
    check_scrub_removes("{\"code\":\"deadbeef\"}", {"deadbeef"}, "code");
    check_scrub_removes("got eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 back", {"eyJhbGci"}, "back");
    check_scrub_removes("/Users/jane.doe/Library/x", {"jane.doe"}, "~/Library/x");
    check_scrub_removes("C:\\Users\\Jane Doe\\AppData\\x.bsp", {"Jane", "C:"}, "AppData");
    check_scrub_removes("{\"path\":\"C:\\\\Users\\\\Jane\\\\AppData\"}", {"Jane"}, "~");
    check_scrub_removes("file:///C:/Users/Jane/map.bsp", {"Jane"}, "map.bsp");
    check_scrub_removes("/home/someone else/x", {"someone"}, "/x");

    // The rest of the line stays useful: this is what the log is for.
    for (const auto *keep :
         {"Map load bhop_sqee: HTTP code: 404",
          "exit code: 3",
          "error code: 0x80070005",
          "Map content materials/metal/wall001a.vmt",
          "Content 064e592bf89dda68e9a6a5d7a805a85ceb9084154c0e4cd3d1d645ceada34a3d",
          "Build bunnyhop-native/7cbaeb08220488f11d610a55",
          "Invalid token at line 3",
          "bhop_lol_tutorial is up"})
        check(native::log::scrub(keep, "/Users/jane.doe") == keep, std::string("altered: ") + keep);

    const auto home = native::log::scrub("C:\\Users\\J\xc3\xb6rg\\AppData\\Bunnyhop", "C:\\Users\\J\xc3\xb6rg");
    check(home == "~\\AppData\\Bunnyhop", "a Windows home with an accent survived: " + home);

    const auto bytes = native::log::scrub(std::string("Acc\xe8s\tdenied\nnow"), "");
    check(bytes == "Acc?s denied now", "the line wasn't made printable: " + bytes);
    const auto long_line = native::log::scrub(std::string(100'000, 'x'), "");
    check(long_line.size() < 2100, "a long line wasn't bounded");
}

void check_session_file() {
    TemporaryFolder folder;
    {
        native::log::Session session;
        std::cerr << "before open" << " in two parts" << '\n';
        native::log::open(folder.path, {"Bunnyhop Native 0.6.4", "Data folder: " + folder.path.string()});
        std::cerr << "token=secret-value and " << "more" << '\n';
        std::cerr << "repeated\nrepeated\nrepeated\n";
        native::log::write("direct line");
        check(native::log::wait_until_written(written_limit), "the writer didn't catch up");
        const auto while_running = read_text(folder.log());
        check(contains(while_running, "direct line"), "a line didn't reach the file while the game ran");
    }
    const auto text = read_text(folder.log());
    const auto header = text.find("Bunnyhop Native 0.6.4");
    check(header != text.npos && header < text.find("before open"), "the header didn't come first");
    check(contains(text, "before open in two parts"), "a line from before open() was lost");
    check(!contains(text, "secret-value"), "a token reached the file through std::cerr");
    check(contains(text, "more"), "the rest of a scrubbed line was lost");
    check(contains(text, "(the line above came 2 more times)"), "repeats weren't folded");
    check(contains(text, "Session ended"), "a clean exit wasn't noted");
    // YYYY-MM-DDTHH:MM:SS.mmmZ at the start of every line.
    std::istringstream lines(text);
    for (std::string line; std::getline(lines, line);)
        check(line.size() > 24 && line[4] == '-' && line[10] == 'T' && line[23] == 'Z', "unstamped line: " + line);
}

void check_timestamp() {
    using namespace std::chrono;
    std::string stamp(native::log::timestamp_bytes, ' ');
    native::log::format_timestamp(system_clock::time_point(milliseconds(1793403372345)), stamp.data());
    check(stamp == "2026-10-30T23:36:12.345Z", "wrong timestamp: " + stamp);
    native::log::format_timestamp(system_clock::time_point(milliseconds(0)), stamp.data());
    check(stamp == "1970-01-01T00:00:00.000Z", "wrong epoch: " + stamp);
    native::log::format_timestamp(system_clock::time_point(milliseconds(1709164800000)), stamp.data());
    check(stamp == "2024-02-29T00:00:00.000Z", "wrong leap day: " + stamp);
}

void run_session(const TemporaryFolder &folder, const std::string &line) {
    native::log::Session session;
    native::log::open(folder.path);
    native::log::write(line);
}

void check_previous_sessions_kept() {
    TemporaryFolder folder;
    for (const auto *line : {"first session", "second session", "third session", "fourth session"})
        run_session(folder, line);
    check(contains(read_text(folder.log()), "fourth"), "the newest session isn't in the main file");
    check(contains(read_text(folder.log("bunnyhop-native.1.log")), "third"), "the last session wasn't kept");
    check(contains(read_text(folder.log("bunnyhop-native.2.log")), "second"), "the one before wasn't kept");
    check(!contains(
                  read_text(folder.log()) + read_text(folder.log("bunnyhop-native.1.log"))
                          + read_text(folder.log("bunnyhop-native.2.log")),
                  "first"
          ),
          "more sessions were kept than asked for");
    check(!fs::exists(folder.log("bunnyhop-native.3.log")), "the folder grows with every session");
}

void check_size_cap() {
    constexpr size_t line_bytes = 1000;
    constexpr int lines_per_batch = 1000;
    constexpr int batches = 12;
    constexpr uint64_t file_limit = 4u * 1024 * 1024;
    TemporaryFolder folder;
    {
        native::log::Session session;
        native::log::open(folder.path, {"header line"});
        for (int batch = 0; batch < batches; ++batch) {
            for (int index = 0; index < lines_per_batch; ++index)
                native::log::write(std::to_string(batch) + "." + std::to_string(index) + std::string(line_bytes, 'x'));
            check(native::log::wait_until_written(written_limit), "the writer didn't catch up with a long session");
        }
    }
    uint64_t total = 0;
    for (const auto &entry : fs::directory_iterator(native::log::folder(folder.path))) {
        check(entry.file_size() <= file_limit, "a log file passed its size limit");
        total += entry.file_size();
    }
    check(total <= 3 * file_limit, "the logs together passed their limit");
    const auto newest = read_text(folder.log());
    check(contains(newest, "header line"), "a rolled-over file lost the session header");
    check(contains(newest, "Session ended"), "the end of a long session wasn't in the newest file");
}

void check_unclean_exit_noted() {
    TemporaryFolder folder;
    fs::create_directories(native::log::folder(folder.path));
    std::ofstream(folder.log()) << "2026-10-30T00:00:00.000Z Map load bhop_a: requested\n";
    run_session(folder, "next launch");
    check(contains(read_text(folder.log()), "without a clean exit"), "a dead session went unnoticed");
    run_session(folder, "one more");
    check(!contains(read_text(folder.log()), "without a clean exit"), "a clean exit was called unclean");
}

void check_unusable_folder() {
    TemporaryFolder folder;
    std::ofstream(folder.path / "logs") << "a file where the folder should be";
    native::log::Session session;
    native::log::open(folder.path);
    std::cerr << "the game carries on\n";
    native::log::write("still fine");
    check(native::log::wait_until_written(written_limit), "a log that won't open held up its callers");
}

void check_sdl_output() {
    TemporaryFolder folder;
    {
        native::log::Session session;
        native::log::capture_sdl_output();
        native::log::open(folder.path);
        SDL_Log("a line from SDL with password=hidden-value");
    }
    const auto text = read_text(folder.log());
    check(contains(text, "SDL: a line from SDL"), "SDL's log didn't reach the file");
    check(!contains(text, "hidden-value"), "SDL's log wasn't scrubbed");
}

void check_threads_keep_lines_whole() {
    constexpr int line_count = 200;
    TemporaryFolder folder;
    {
        native::log::Session session;
        native::log::open(folder.path);
        const auto write_lines = [](char name) {
            for (int index = 0; index < line_count; ++index)
                std::cerr << "thread " << name << " line " << index << " end\n";
        };
        std::thread first(write_lines, 'a'), second(write_lines, 'b');
        first.join();
        second.join();
    }
    std::istringstream lines(read_text(folder.log()));
    int whole = 0;
    for (std::string line; std::getline(lines, line);) {
        if (!contains(line, "thread ")) continue;
        check(line.ends_with(" end") && contains(line, " line "), "a line from two threads got mixed: " + line);
        ++whole;
    }
    check(whole == 2 * line_count, "lines went missing under two threads");
}

#ifndef _WIN32
int crash_on_purpose(const std::string &mode, const fs::path &data) {
    native::log::Session session;
    native::log::install_crash_notes();
    native::log::open(data, {"Crash test"});
    native::log::set_crash_context("loading bhop_sqee, stage renderer");
    native::log::write("before the crash");
    if (mode == "signal") {
        native::log::wait_until_written(written_limit);
        std::raise(SIGSEGV);
    } else if (mode == "uncaught")
        throw std::runtime_error("token=hidden-value went wrong");
    std::terminate();
}

void check_crash_notes(const char *program) {
    for (const std::string mode : {"signal", "terminate", "uncaught"}) {
        TemporaryFolder folder;
        const auto command =
                "'" + std::string(program) + "' crash " + mode + " '" + folder.path.string() + "' 2>/dev/null";
        check(std::system(command.c_str()) != 0, "the crash test didn't crash: " + mode);
        const auto text = read_text(folder.log());
        check(contains(text, "before the crash"), "the line before the crash was lost: " + mode);
        check(contains(text, "Crash: "), "no crash note: " + mode);
        check(contains(text, "Last map state: loading bhop_sqee, stage renderer"), "no map state: " + mode);
        check(!contains(text, "hidden-value"), "the crash note carried a secret");
        if (mode == "uncaught") check(contains(text, "went wrong"), "the crash note lost the exception's text");
    }
}
#endif
}  // namespace

int main(int argc, char **argv) {
#ifndef _WIN32
    if (argc == 4 && std::string(argv[1]) == "crash") return crash_on_purpose(argv[2], argv[3]);
#endif
    try {
        check_privacy();
        check_timestamp();
        check_session_file();
        check_previous_sessions_kept();
        check_size_cap();
        check_unclean_exit_noted();
        check_unusable_folder();
        check_threads_keep_lines_whole();
        check_sdl_output();
#ifndef _WIN32
        check_crash_notes(argv[0]);
#endif
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
    (void)argc;
}
