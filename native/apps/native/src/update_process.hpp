#pragma once
// Starting and waiting for the programs an update needs: the archive tool that unpacks a package, the update
// helper that swaps the install once the game has closed, and the relaunched game.
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <shellapi.h>
#else
#include <cerrno>
#include <csignal>
#include <spawn.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
#endif

namespace native::update_process {
namespace fs = std::filesystem;
inline constexpr auto poll_interval = std::chrono::milliseconds(50);

enum class Window { hidden, own_console };

#ifdef _WIN32
// Quotes one argument the way CommandLineToArgvW and the MSVC runtime read it back.
inline std::wstring quote_argument(const std::wstring &argument) {
    if (!argument.empty() && argument.find_first_of(L" \t\n\v\"") == std::wstring::npos) return argument;
    std::wstring quoted = L"\"";
    size_t backslashes = 0;
    for (const wchar_t c : argument) {
        if (c == L'\\') {
            ++backslashes;
            continue;
        }
        if (c == L'"') backslashes = backslashes * 2 + 1;
        quoted.append(backslashes, L'\\');
        backslashes = 0;
        quoted += c;
    }
    quoted.append(backslashes * 2, L'\\');
    quoted += L'"';
    return quoted;
}

inline std::wstring widen(const std::string &utf8) {
    if (utf8.empty()) return {};
    const int length = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), int(utf8.size()), nullptr, 0);
    std::wstring wide(size_t(length), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8.data(), int(utf8.size()), wide.data(), length);
    return wide;
}
#endif

class Child {
#ifdef _WIN32
    HANDLE process_ = nullptr;
#else
    pid_t pid_ = -1;
#endif
    std::optional<int> exit_code_;

public:
    Child() = default;
    Child(const Child &) = delete;
    Child &operator=(const Child &) = delete;

    Child(Child &&other) noexcept { *this = std::move(other); }

    Child &operator=(Child &&other) noexcept {
#ifdef _WIN32
        std::swap(process_, other.process_);
#else
        std::swap(pid_, other.pid_);
#endif
        std::swap(exit_code_, other.exit_code_);
        return *this;
    }

    ~Child() {
#ifdef _WIN32
        if (process_) CloseHandle(process_);
#endif
    }

    // Arguments are UTF-8. On Windows a tool runs without a console window; the game gets its own console, as
    // relaunch.hpp starts it.
    static Child
    start(const fs::path &program,
          const std::vector<std::string> &arguments,
          [[maybe_unused]] Window window = Window::hidden) {
        Child child;
#ifdef _WIN32
        std::wstring command = quote_argument(program.wstring());
        for (const auto &argument : arguments)
            command += L" " + quote_argument(widen(argument));
        STARTUPINFOW startup{};
        startup.cb = sizeof startup;
        PROCESS_INFORMATION process{};
        const auto directory = program.parent_path().wstring();
        if (!CreateProcessW(
                    program.c_str(),
                    command.data(),
                    nullptr,
                    nullptr,
                    FALSE,
                    window == Window::own_console ? CREATE_NEW_CONSOLE : CREATE_NO_WINDOW,
                    nullptr,
                    directory.c_str(),
                    &startup,
                    &process
            ))
            throw std::runtime_error("Cannot start " + program.filename().string());
        CloseHandle(process.hThread);
        child.process_ = process.hProcess;
#else
        const std::string path = program.string();
        std::vector<std::string> storage{path};
        storage.insert(storage.end(), arguments.begin(), arguments.end());
        std::vector<char *> argv;
        for (auto &argument : storage)
            argv.push_back(argument.data());
        argv.push_back(nullptr);
        if (posix_spawn(&child.pid_, path.c_str(), nullptr, nullptr, argv.data(), environ) != 0)
            throw std::runtime_error("Cannot start " + program.filename().string());
#endif
        return child;
    }

    // The exit code once the program has ended, or nothing if it is still running after `timeout`.
    std::optional<int> wait_for(std::chrono::milliseconds timeout) {
        if (exit_code_) return exit_code_;
#ifdef _WIN32
        if (!process_) return std::nullopt;
        if (WaitForSingleObject(process_, DWORD(timeout.count())) != WAIT_OBJECT_0) return std::nullopt;
        DWORD code = 1;
        GetExitCodeProcess(process_, &code);
        exit_code_ = int(code);
#else
        if (pid_ <= 0) return std::nullopt;
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        for (;;) {
            int status = 0;
            const pid_t done = waitpid(pid_, &status, WNOHANG);
            if (done == pid_) {
                exit_code_ = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
                break;
            }
            if (done < 0 && errno != EINTR) {
                exit_code_ = 1;
                break;
            }
            if (std::chrono::steady_clock::now() >= deadline) return std::nullopt;
            std::this_thread::sleep_for(poll_interval);
        }
#endif
        return exit_code_;
    }

    void kill() {
#ifdef _WIN32
        if (process_ && !exit_code_) TerminateProcess(process_, 1);
#else
        if (pid_ > 0 && !exit_code_) ::kill(pid_, SIGKILL);
#endif
        wait_for(std::chrono::seconds(5));
    }
};

// Runs a short tool to completion. A tool that outlives `timeout` is killed and counts as failed.
inline int run(const fs::path &program, const std::vector<std::string> &arguments, std::chrono::milliseconds timeout) {
    auto child = Child::start(program, arguments);
    if (const auto code = child.wait_for(timeout)) return *code;
    child.kill();
    throw std::runtime_error(program.filename().string() + " took too long");
}

inline uint64_t current_process_id() {
#ifdef _WIN32
    return GetCurrentProcessId();
#else
    return uint64_t(getpid());
#endif
}

// Waits for another process (the game that started the update helper) to end. On POSIX the helper is that
// process's child, so a changed parent also means it ended, even before its own parent has reaped it.
inline bool wait_for_exit(uint64_t process_id, std::chrono::milliseconds timeout) {
#ifdef _WIN32
    HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, DWORD(process_id));
    if (!process) return true;
    const bool ended = WaitForSingleObject(process, DWORD(timeout.count())) == WAIT_OBJECT_0;
    CloseHandle(process);
    return ended;
#else
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    for (;;) {
        if (uint64_t(getppid()) != process_id) return true;
        if (::kill(pid_t(process_id), 0) != 0 && errno == ESRCH) return true;
        if (std::chrono::steady_clock::now() >= deadline) return false;
        std::this_thread::sleep_for(poll_interval);
    }
#endif
}
}  // namespace native::update_process
