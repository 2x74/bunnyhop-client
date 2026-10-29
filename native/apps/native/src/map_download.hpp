#pragma once
#include "map_jobs.hpp"
#include "online.hpp"
#include <mutex>
#include <optional>

namespace native {

struct MapDownloadResult {
    std::optional<DownloadedMap> map;
    std::string error;
};

// The progress state outlives every worker. Cancelled workers keep their own
// token, so a late callback cannot overwrite a replacement map's progress.
struct MapDownload {
    std::mutex mutex;
    std::string loading, requested;
    nlohmann::json progress = nullptr;
    bool preparing = false;
    MapJobs<MapDownloadResult> jobs;

    bool loading_map(const std::string &id) const { return jobs.valid() && requested == id; }

    void cancel() {
        jobs.cancel();
        preparing = false;
        std::lock_guard lock(mutex);
        loading.clear();
        progress = nullptr;
    }

    void message(const std::string &text, const std::atomic_bool &cancel) {
        std::lock_guard lock(mutex);
        if (!cancel) loading = text;
    }

    void update(const std::string &id, const LoadProgress &value, const std::atomic_bool &cancel) {
        std::lock_guard lock(mutex);
        if (cancel) return;
        loading = value.message;
        progress = {
                {"map", id},
                {"stage", value.stage},
                {"message", value.message},
                {"received", value.received},
                {"total", value.total},
                {"filesDone", value.filesDone},
                {"filesTotal", value.filesTotal},
                {"cached", value.cached},
                {"offline", value.offline}
        };
    }

    template <class LockCache>
    void
    start(const std::string &id,
          const std::filesystem::path &cache,
          LockCache &lock_cache,
          const DownloadFetch &fetch = {}) {
        if (!valid_map_id(id)) throw std::runtime_error("Invalid map name");
        if (loading_map(id)) return;
        cancel();
        requested = id;
        {
            std::lock_guard lock(mutex);
            loading = "Reading " + id;
            progress = {{"map", id}, {"stage", "metadata"}, {"message", loading}};
        }
        jobs.start([this, id, cache, &lock_cache, fetch](const std::atomic_bool &cancel) -> MapDownloadResult {
            try {
                const auto lock = lock_cache(cancel);
                return {download_map(
                                id,
                                cache,
                                [this, &cancel](const std::string &text) { message(text, cancel); },
                                &cancel,
                                {},
                                [this, &cancel, id](const LoadProgress &value) { update(id, value, cancel); },
                                fetch
                        ),
                        {}};
            } catch (const std::exception &error) {
                return {std::nullopt, error.what()};
            }
        });
    }
};
}  // namespace native
