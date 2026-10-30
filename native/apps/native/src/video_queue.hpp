#pragma once
#include "video_export.hpp"
#include <SDL3/SDL.h>
#include <nlohmann/json.hpp>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace native {

// Exports run one after another in a separate process (video_worker.hpp), so rendering and encoding never take a
// frame from gameplay and a crash there can't end the session. The queue owns the jobs, starts the process and reads
// its progress on its own thread; the game reads a snapshot and sends cancels and the pace.
class VideoQueue {
public:
    struct Request {
        std::filesystem::path replay, bsp, content, output;
        std::string map, title;
        nlohmann::json detail = nlohmann::json::object();
        VideoOptions options;
    };

    // Shared by every job: what the export process needs to look like the game.
    struct Context {
        std::filesystem::path executable, assets, cache;
        nlohmann::json settings;
        std::string outfit;
        VideoAvailability available;
    };

    struct Item {
        uint64_t id = 0;
        std::string title, map, state = "queued", path, error, encoder, codec, note, stage;
        bool hardware = false;
        uint64_t frame = 0, frames = 0, bytes = 0;
        double eta = -1, fps = 0, elapsed = 0, seconds = 0;
    };

    VideoQueue() = default;
    ~VideoQueue();
    VideoQueue(const VideoQueue &) = delete;
    VideoQueue &operator=(const VideoQueue &) = delete;

    uint64_t add(Request request, const Context &context);
    // A queued job is dropped; the running one is told to stop. Zero means every job.
    void cancel(uint64_t id = 0);
    void clear_finished();

    // Frames per second the running export may render; zero lifts the limit.
    void set_pace(double fps) { pace_ = fps; }

    std::vector<Item> items() const;
    bool busy() const;
    // The worker's last event line, applied to an item (exposed for tests).
    static void apply_event(Item &item, const nlohmann::json &event);

private:
    struct Job {
        Item item;
        nlohmann::json spec;
        std::filesystem::path executable, folder;
    };

    mutable std::mutex mutex_;
    std::condition_variable wake_;
    std::deque<Job> jobs_;
    std::vector<Item> finished_;
    std::thread thread_;
    std::atomic_bool stopping_ = false, cancel_running_ = false;
    std::atomic<double> pace_ = 0;
    uint64_t next_id_ = 1;
    std::optional<uint64_t> running_;

    void loop();
    void run(const Job &job);
    void read_events(SDL_Process *process, uint64_t id);
    void update(uint64_t id, const nlohmann::json &event);
    void settle(uint64_t id, const std::filesystem::path &log);
    Item *find(uint64_t id);
};

}  // namespace native
