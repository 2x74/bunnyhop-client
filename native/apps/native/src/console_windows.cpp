#include "console_host.hpp"
#include <windows.h>
#include <io.h>
#include <cstdint>
#include <cstdio>
#include <iostream>
#include <string_view>

namespace native::console {
namespace {

bool redirected(DWORD standard_handle) {
    const HANDLE handle = GetStdHandle(standard_handle);
    if (!handle || handle == INVALID_HANDLE_VALUE) return false;
    const DWORD type = GetFileType(handle);
    return type == FILE_TYPE_DISK || type == FILE_TYPE_PIPE;
}

bool requested(int argc, char **argv) {
    for (int i = 1; i < argc; ++i)
        if (std::string_view(argv[i]) == "--console") return true;
    return false;
}

void write_to_console(FILE *stream, DWORD standard_handle) {
    FILE *reopened = nullptr;
    if (freopen_s(&reopened, "CONOUT$", "w", stream) != 0) return;
    // The C runtime only updates the process's handle by itself in a console program; SDL reads the process's handle.
    const intptr_t handle = _get_osfhandle(_fileno(stream));
    if (handle != -1) SetStdHandle(standard_handle, reinterpret_cast<HANDLE>(handle));
}

}  // namespace

void connect(int argc, char **argv) {
    const bool output_redirected = redirected(STD_OUTPUT_HANDLE);
    const bool errors_redirected = redirected(STD_ERROR_HANDLE);
    if (output_redirected && errors_redirected) return;
    if (!AttachConsole(ATTACH_PARENT_PROCESS)) {
        if (!requested(argc, argv) || !AllocConsole()) return;
        // Only a console this process owns: a parent's code page belongs to the parent.
        SetConsoleOutputCP(CP_UTF8);
    }
    if (!output_redirected) write_to_console(stdout, STD_OUTPUT_HANDLE);
    if (!errors_redirected) write_to_console(stderr, STD_ERROR_HANDLE);
    std::cout.clear();
    std::cerr.clear();
}

}  // namespace native::console
