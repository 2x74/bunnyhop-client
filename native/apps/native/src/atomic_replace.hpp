#pragma once
#include <filesystem>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cerrno>
#include <string_view>
#include <stdexcept>
#include <system_error>
#include <thread>
#ifdef _WIN32
#include <windows.h>
#endif

namespace native {

inline void atomic_replace(const std::filesystem::path &source, const std::filesystem::path &destination) {
#ifdef _WIN32
    // Windows refuses to replace a file while another save, an antivirus scan or the indexer briefly holds it.
    // Those holds clear within milliseconds, so retry before reporting a failure.
    constexpr int replace_attempts = 40;
    constexpr auto replace_retry_delay = std::chrono::milliseconds(5);
    for (int attempt = 1;; ++attempt) {
        if (MoveFileExW(source.c_str(), destination.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            return;
        const DWORD error = GetLastError();
        const bool held = error == ERROR_ACCESS_DENIED || error == ERROR_SHARING_VIOLATION;
        if (!held || attempt == replace_attempts)
            throw std::system_error(int(error), std::system_category(), "Replacing file");
        std::this_thread::sleep_for(replace_retry_delay);
    }
#else
    std::filesystem::rename(source, destination);
#endif
}

// Exclusive creation prevents concurrent saves from sharing a temporary file.
inline void atomic_write_file(const std::filesystem::path &destination, std::string_view text) {
    static std::atomic<unsigned long long> sequence = 0;
    auto temporary = destination;
    const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
    temporary += ".partial-" + std::to_string(stamp) + "-" + std::to_string(sequence.fetch_add(1));
#ifdef _WIN32
    FILE *output = _wfopen(temporary.c_str(), L"wbx");
#else
    FILE *output = std::fopen(temporary.c_str(), "wbx");
#endif
    if (!output) throw std::system_error(errno, std::generic_category(), "Creating temporary file");
    try {
        const bool written = std::fwrite(text.data(), 1, text.size(), output) == text.size();
        const bool closed = std::fclose(output) == 0;
        output = nullptr;
        if (!written || !closed) throw std::runtime_error("The file couldn't be written.");
        atomic_replace(temporary, destination);
    } catch (...) {
        if (output) std::fclose(output);
        std::error_code error;
        std::filesystem::remove(temporary, error);
        throw;
    }
}

}  // namespace native
