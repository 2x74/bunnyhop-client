#pragma once
#include "online.hpp"

namespace native {

inline void prefetch_progress(const std::string &) {}

// download_map verifies downloaded and cached BSP bytes on this worker. Its
// verified manifest hash can be compared directly without rereading the BSP.
inline bool prefetch_map(const std::string &id, const std::string &expected_sha, const std::filesystem::path &cache,
                         const std::atomic_bool &cancel, const DownloadFetch &fetch = {}) {
    constexpr size_t prefetch_bsp_max_bytes = 64 * 1024 * 1024;
    constexpr size_t prefetch_content_max_bytes = 256 * 1024 * 1024;
    DownloadLimits limits;
    limits.bsp = prefetch_bsp_max_bytes;
    limits.content_total = prefetch_content_max_bytes;
    const auto result = download_map(id, cache, prefetch_progress, &cancel, limits, {}, fetch);
    return result.detail.at("sha256") == expected_sha;
}

} // namespace native
