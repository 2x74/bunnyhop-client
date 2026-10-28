#pragma once
#include <filesystem>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cerrno>
#include <string_view>
#include <stdexcept>
#include <system_error>
#ifdef _WIN32
#include <windows.h>
#endif

namespace native {

inline void atomic_replace(const std::filesystem::path &source, const std::filesystem::path &destination) {
#ifdef _WIN32
    if (!MoveFileExW(source.c_str(), destination.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        throw std::system_error(int(GetLastError()), std::system_category(), "Replacing file");
    }
#else
    std::filesystem::rename(source, destination);
#endif
}

// Exclusive creation prevents concurrent saves from sharing a temporary file.
inline void atomic_write_file(const std::filesystem::path& destination, std::string_view text) {
    static std::atomic<unsigned long long> sequence = 0;
    auto temporary = destination;
    const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
    temporary += ".partial-" + std::to_string(stamp) + "-" + std::to_string(sequence.fetch_add(1));
#ifdef _WIN32
    FILE* output = _wfopen(temporary.c_str(), L"wbx");
#else
    FILE* output = std::fopen(temporary.c_str(), "wbx");
#endif
    if (!output)
        throw std::system_error(errno, std::generic_category(), "Creating temporary file");
    try {
        const bool written = std::fwrite(text.data(), 1, text.size(), output) == text.size();
        const bool closed = std::fclose(output) == 0;
        output = nullptr;
        if (!written || !closed)
            throw std::runtime_error("The file couldn't be written.");
        atomic_replace(temporary, destination);
    } catch (...) {
        if (output)
            std::fclose(output);
        std::error_code error;
        std::filesystem::remove(temporary, error);
        throw;
    }
}

}  // namespace native
