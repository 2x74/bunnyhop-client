#pragma once
#include <string>
#ifdef _WIN32
#include <windows.h>
#include <winternl.h>
#else
#include <sys/utsname.h>
#endif

inline std::string benchmark_os() {
#ifdef _WIN32
    using Version = LONG(WINAPI *)(PRTL_OSVERSIONINFOW);
    const auto function = reinterpret_cast<Version>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
    RTL_OSVERSIONINFOW version{};
    version.dwOSVersionInfoSize = sizeof version;
    if (function && function(&version) == 0)
        return "Windows " + std::to_string(version.dwMajorVersion) + "." + std::to_string(version.dwMinorVersion)
               + " build " + std::to_string(version.dwBuildNumber);
    return "Windows (build unavailable)";
#else
    utsname version{};
    if (uname(&version) != 0) return SDL_GetPlatform();
    return std::string(version.sysname) + " " + version.release + " " + version.version;
#endif
}

inline int64_t benchmark_qpc() {
#ifdef _WIN32
    LARGE_INTEGER value{};
    QueryPerformanceCounter(&value);
    return value.QuadPart;
#else
    return 0;
#endif
}
