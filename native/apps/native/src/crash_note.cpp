#include "crash_note.hpp"
#include "native_log.hpp"
#include <array>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <exception>
#include <string>
#include <string_view>
#ifdef _WIN32
#include <windows.h>
#else
#include <signal.h>
#endif

namespace native::log {
namespace {
constexpr size_t note_bytes = 1024;
constexpr auto terminate_write_limit = std::chrono::milliseconds(200);
std::atomic_bool crash_noted{false};

// Builds one line on the stack: no allocation, no locks, so a signal handler may use it on a damaged heap.
class Note {
public:
    Note() {
        std::array<char, timestamp_bytes> stamp{};
        format_timestamp(std::chrono::system_clock::now(), stamp.data());
        add(stamp.data(), stamp.size());
        add(" Crash: ");
    }

    void add(const char *text, size_t size) noexcept {
        for (size_t index = 0; index < size && used_ < text_.size() - 1; ++index)
            text_[used_++] = text[index];
    }

    void add(const char *text) noexcept {
        for (; *text && used_ < text_.size() - 1; ++text)
            text_[used_++] = *text;
    }

    void add_number(uint64_t value) noexcept {
        std::array<char, 20> digits{};
        size_t count = 0;
        do {
            digits[count++] = char('0' + value % 10);
            value /= 10;
        } while (value);
        while (count)
            add(&digits[--count], 1);
    }

    void add_hex(uint64_t value) noexcept {
        constexpr std::string_view hex_digits = "0123456789abcdef";
        add("0x");
        bool started = false;
        for (int shift = 60; shift >= 0; shift -= 4) {
            const auto digit = (value >> shift) & 0xf;
            if (!digit && !started && shift) continue;
            started = true;
            add(&hex_digits[size_t(digit)], 1);
        }
    }

    void finish() noexcept {
        std::array<char, 256> context{};
        const size_t size = read_crash_context(context.data(), context.size());
        if (size) {
            add(". Last map state: ");
            add(context.data(), size);
        }
        text_[used_++] = '\n';
        write_raw(text_.data(), used_);
    }

private:
    std::array<char, note_bytes> text_{};
    size_t used_ = 0;
};

bool first_note() noexcept {
    return !crash_noted.exchange(true, std::memory_order_acq_rel);
}

std::string thrown_text() {
    try {
        const auto current = std::current_exception();
        if (!current) return "std::terminate";
        std::rethrow_exception(current);
    } catch (const std::exception &error) {
        return scrub_line(std::string("uncaught exception: ") + error.what());
    } catch (...) {
        return "uncaught exception of an unknown type";
    }
}

[[noreturn]] void on_terminate() noexcept {
    // Not a signal: the writer is still running, so what's queued can go first and the error text can be scrubbed.
    if (first_note()) {
        std::string reason = "std::terminate";
        try {
            reason = thrown_text();
        } catch (...) {
        }
        wait_until_written(terminate_write_limit);
        Note note;
        note.add(reason.c_str());
        note.finish();
    }
    std::abort();
}

#ifdef _WIN32
LONG WINAPI on_unhandled_exception(EXCEPTION_POINTERS *info) {
    if (first_note()) {
        Note note;
        note.add("Windows exception ");
        note.add_hex(info && info->ExceptionRecord ? info->ExceptionRecord->ExceptionCode : 0);
        note.add(" at ");
        note.add_hex(
                reinterpret_cast<uintptr_t>(
                        info && info->ExceptionRecord ? info->ExceptionRecord->ExceptionAddress : nullptr
                )
        );
        note.add(", game loaded at ");
        note.add_hex(reinterpret_cast<uintptr_t>(GetModuleHandleW(nullptr)));
        note.finish();
    }
    return EXCEPTION_CONTINUE_SEARCH;
}

void __cdecl on_abort(int) {
    if (!first_note()) return;
    Note note;
    note.add("abort");
    note.finish();
}

// Both of these end in a fail-fast exit otherwise, which reaches no other handler. The CRT carries on if they return.
void __cdecl on_invalid_parameter(const wchar_t *, const wchar_t *, const wchar_t *, unsigned, uintptr_t) {
    if (first_note()) {
        Note note;
        note.add("invalid parameter to a C runtime function");
        note.finish();
    }
    std::abort();
}

void __cdecl on_pure_call() {
    if (first_note()) {
        Note note;
        note.add("pure virtual function call");
        note.finish();
    }
    std::abort();
}

void install_platform_handlers() {
    SetUnhandledExceptionFilter(on_unhandled_exception);
    std::signal(SIGABRT, on_abort);
    _set_invalid_parameter_handler(on_invalid_parameter);
    _set_purecall_handler(on_pure_call);
}
#else
void on_fatal_signal(int number) {
    // The default action is back in place (SA_RESETHAND): returning repeats the fault, or lets abort() finish.
    if (!first_note()) return;
    Note note;
    note.add("signal ");
    note.add_number(uint64_t(number));
    note.finish();
}

void install_platform_handlers() {
    // A stack overflow leaves no stack for the handler on this thread.
    constexpr size_t alternate_stack_bytes = 64 * 1024;
    static std::array<char, alternate_stack_bytes> alternate_stack;
    stack_t stack{};
    stack.ss_sp = alternate_stack.data();
    stack.ss_size = alternate_stack.size();
    sigaltstack(&stack, nullptr);
    struct sigaction action{};
    action.sa_handler = on_fatal_signal;
    action.sa_flags = SA_RESETHAND | SA_ONSTACK;
    sigemptyset(&action.sa_mask);
    for (const int number : {SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT})
        sigaction(number, &action, nullptr);
}
#endif
}  // namespace

void install_crash_notes() {
    std::set_terminate(on_terminate);
    install_platform_handlers();
}

}  // namespace native::log
