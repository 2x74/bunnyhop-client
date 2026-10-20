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
bool valid_map_id(const std::string &id);
bool safe_content_path(const std::string &path);
// Public, immutable game content only. Account cookies stay in the menu's web view.
// Run on a worker thread; never call the native simulation or SDL from this callback.
DownloadedMap download_map(const std::string &id, const std::filesystem::path &cache,
                           const std::function<void(const std::string &)> &progress,
                           const std::atomic_bool *cancel = nullptr);
}
