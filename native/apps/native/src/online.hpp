#pragma once
#include <filesystem>
#include <functional>
#include <atomic>
#include <string>
#include <nlohmann/json.hpp>

namespace native {
struct DownloadedMap {
    std::string id;
    std::filesystem::path bsp, content_root;
    nlohmann::json detail;
};
// Byte budgets for one map download. The defaults are the gameplay limits; the
// menu backdrop passes smaller ones so a background never fetches a huge map.
struct DownloadLimits {
    size_t bsp = size_t(512) * 1024 * 1024;
    size_t content_file = size_t(256) * 1024 * 1024;
    size_t content_total = size_t(1024) * 1024 * 1024;
};
bool valid_map_id(const std::string &id);
bool safe_content_path(const std::string &path);
// Public, immutable game content only. Account cookies stay in the menu's web view.
// Run on a worker thread; never call the native simulation or SDL from this callback.
DownloadedMap download_map(const std::string &id, const std::filesystem::path &cache,
                           const std::function<void(const std::string &)> &progress,
                           const std::atomic_bool *cancel = nullptr, const DownloadLimits &limits = {});
}
