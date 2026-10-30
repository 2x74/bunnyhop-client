#pragma once
#include "video_export.hpp"
#include "video_queue.hpp"
#include "replay_camera.hpp"
#include <functional>
#include <future>
#include <memory>
#include <optional>

namespace native {

class GameSession;
class ReplayDirectorJob;
struct ReplayPlayer;
struct Options;

// Video export for the game: requests go to the export queue (video_queue.hpp), which renders them in a separate
// process. The game keeps only the auto-director's camera preparation for the replay viewer.
class VideoController {
public:
    struct Context {
        GameSession &game;
        ReplayPlayer &viewer;
        BhState &curr;
        const nlohmann::json &preferences;
        const std::string &outfit;
        const std::filesystem::path &assets;
        const std::filesystem::path &cache;
        const Options &opt;
    };

    explicit VideoController(ReplayCamera &playback_camera);
    ~VideoController();
    VideoController(const VideoController &) = delete;
    VideoController &operator=(const VideoController &) = delete;

    VideoAvailability available{false, "Checking FFmpeg…", "ffmpeg", {}};
    std::unique_ptr<ReplayDirectorJob> director_job;
    nlohmann::json music_catalog = nlohmann::json::array();
    std::string error;

    void bind(Context context, std::function<void()> refresh_playback_pose);
    // The replay open in the viewer.
    void request(VideoOptions options, const std::string &title);
    // A replay from the vault, without opening it: the export process loads its map.
    void request_file(const std::filesystem::path &replay, const std::string &map, VideoOptions options);
    // The menu's videoExport message: start, file (a vault replay), cancel or clear. Failures show in state().
    void message(const nlohmann::json &message, const std::filesystem::path &replays);
    void cancel(uint64_t id = 0);
    void clear_finished();
    void cancel_preparation();

    bool preparing() const { return bool(director_job); }

    bool exporting() const { return queue_.busy(); }

    nlohmann::json state() const;
    void prepare_viewer_camera();
    // Once per frame. `playing`: the player is in a run, so the export slows to a trickle to stay out of its way.
    void step(bool playing);
    void wait_probe();
    void poll_probe();

private:
    ReplayCamera &playback_camera_;
    std::future<VideoAvailability> probe_;
    VideoQueue queue_;
    std::optional<Context> context_;
    std::function<void()> refresh_playback_pose_;

    VideoQueue::Context queue_context() const;
    std::filesystem::path output_folder() const;
};

}  // namespace native
