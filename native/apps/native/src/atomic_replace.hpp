#pragma once
#include <filesystem>
#include <system_error>
#ifdef _WIN32
#include <windows.h>
#endif

namespace native {

inline void atomic_replace(const std::filesystem::path &source, const std::filesystem::path &destination) {
#ifdef _WIN32
    if (!MoveFileExW(source.c_str(), destination.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        throw std::system_error(int(GetLastError()), std::system_category(), "Replacing settings");
    }
#else
    std::filesystem::rename(source, destination);
#endif
}

}  // namespace native
