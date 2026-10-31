#pragma once
#include "map_jobs.hpp"
#include "map_load_journal.hpp"
#include "online.hpp"
#include <chrono>
#include <iostream>
#include <mutex>
#include <optional>
#include <thread>

namespace native {

// How long a load may go without any progress before it ends in an error with Retry. Long enough for a slow disk to
// hash and copy one large file. The network has its own, shorter stall limit (online.cpp), so this mostly catches what
// that can't see: a stuck disk, or a worker that hasn't let go of the cache.
inline constexpr auto map_load_stall_limit = std::chrono::seconds(90);

struct MapDownloadResult {
    std::optional<DownloadedMap> map;
    std::string error;
};

// Every download_map call materializes files in the same content cache, so downloads take turns. Waiting gives up once
// its own download is cancelled, so neither worker can hold up shutdown.
class MapCacheLock {
public:
    std::unique_lock<std::mutex> operator()(const std::atomic_bool &cancel) {
        constexpr auto wait_poll_interval = std::chrono::milliseconds(20);
        std::unique_lock lock(mutex_, std::defer_lock);
        bool waiting = false;
        while (!lock.try_lock()) {
            if (cancel) throw std::runtime_error("Map download cancelled");
            if (!waiting) std::cerr << "Map cache: waiting for another download to let go\n";
            waiting = true;
            std::this_thread::sleep_for(wait_poll_interval);
        }
        if (cancel) throw std::runtime_error("Map download cancelled");
        return lock;
    }

private:
    std::mutex mutex_;
};

// The progress state outlives every worker. Cancelled workers keep their own
// token, so a late callback cannot overwrite a replacement map's progress.
struct MapDownload {
    using Clock = std::chrono::steady_clock;

    std::mutex mutex;
    std::string loading, requested;
    nlohmann::json progress = nullptr;
    bool preparing = false;
    MapJobs<MapDownloadResult> jobs;
    Clock::duration stall_limit = map_load_stall_limit;

    bool loading_map(const std::string &id) const { return jobs.valid() && requested == id; }

    void cancel() {
        const bool active = jobs.valid() || preparing;
        jobs.cancel();
        preparing = false;
        std::lock_guard lock(mutex);
        if (active) journal.cancelled();
        loading.clear();
        progress = nullptr;
    }

    // The download has an answer for the frame loop: it finished, or it stopped making progress.
    bool settled(Clock::time_point now) {
        if (!jobs.valid()) return false;
        if (jobs.wait_for(std::chrono::seconds(0)) == std::future_status::ready) return true;
        std::lock_guard lock(mutex);
        return now - last_progress > stall_limit;
    }

    // After settled(). A stalled worker is retired: it can't be stopped, but it no longer stands in the way of a retry.
    MapDownloadResult take() {
        if (jobs.wait_for(std::chrono::seconds(0)) == std::future_status::ready) {
            auto result = jobs.get();
            std::lock_guard lock(mutex);
            if (result.map) journal.files_ready();
            return result;
        }
        jobs.cancel();
        std::lock_guard lock(mutex);
        journal.stalled(stall_limit);
        const bool queued = progress.is_object() && progress.value("stage", std::string()) == queued_stage;
        return {std::nullopt,
                queued ? "Another download is still using the game data folder. Try again in a moment."
                       : "This map stopped loading: nothing happened for a while. Check your connection and "
                         "try again."};
    }

    void note_refused(const std::string &id, std::string_view reason) {
        std::lock_guard lock(mutex);
        journal.refused(id, reason);
    }

    void note_preparing() {
        std::lock_guard lock(mutex);
        journal.preparing();
    }

    void note_loaded() {
        std::lock_guard lock(mutex);
        journal.loaded();
    }

    void note_failed(const std::string &error) {
        std::lock_guard lock(mutex);
        journal.failed(error);
    }

    void note_left_map() {
        std::lock_guard lock(mutex);
        journal.left_map();
    }

    void message(const std::string &text, const std::atomic_bool &cancel) {
        std::lock_guard lock(mutex);
        if (cancel) return;
        if (loading != text) last_progress = Clock::now();
        loading = text;
    }

    void update(const std::string &id, const LoadProgress &value, const std::atomic_bool &cancel) {
        std::lock_guard lock(mutex);
        if (cancel) return;
        // Transfers report about once a second whether or not bytes moved, so only a change counts as progress.
        if (loading != value.message || last_received != value.received) last_progress = Clock::now();
        last_received = value.received;
        journal.progress(value);
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
            journal.requested(id);
            loading = "Reading " + id;
            progress = {{"map", id}, {"stage", queued_stage}, {"message", loading}};
            last_progress = Clock::now();
            last_received = 0;
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

private:
    // The stage before the worker has the cache to itself.
    static constexpr const char *queued_stage = "queue";

    MapLoadJournal journal;
    Clock::time_point last_progress;
    uint64_t last_received = 0;
};
}  // namespace native
