#pragma once
// Starts a fresh copy of the game. Called from main() after run() returned, so
// the old instance has closed every file in its data folder first (Settings ->
// Game data -> "Move now" restarts to move the data at startup).
#include <cstdlib>
#include <filesystem>
#include <string>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <spawn.h>
#include <sys/types.h>
extern char **environ;
#endif

namespace native {
inline bool relaunch(std::filesystem::path exe) {
#ifdef _WIN32
    std::wstring command = L"\"" + exe.wstring() + L"\"";
    STARTUPINFOW startup{};
    startup.cb = sizeof startup;
    PROCESS_INFORMATION process{};
    const auto directory = exe.parent_path().wstring();
    if (!CreateProcessW(
                exe.c_str(),
                command.data(),
                nullptr,
                nullptr,
                FALSE,
                CREATE_NEW_CONSOLE,
                nullptr,
                directory.c_str(),
                &startup,
                &process
        ))
        return false;
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return true;
#else
    // An AppImage's /proc/self/exe lives in a mount that goes away on exit.
    if (const char *image = std::getenv("APPIMAGE"); image && *image) exe = image;
    const std::string path = exe.string();
    char *argv[] = {const_cast<char *>(path.c_str()), nullptr};
    pid_t pid = 0;
    return posix_spawn(&pid, path.c_str(), nullptr, nullptr, argv, environ) == 0;
#endif
}
}  // namespace native
