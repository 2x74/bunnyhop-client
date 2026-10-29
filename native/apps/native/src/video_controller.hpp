#pragma once
#include "video_export.hpp"
#include "replay_camera.hpp"
#include <functional>
#include <future>
#include <memory>
#include <optional>

namespace native {

struct Gl;
class NativeHud;
class Audio;
class GameSession;
class VideoCapture;
class ReplayDirectorJob;
struct ReplayPlayer;
struct Options;
struct MapDownloadResult;
template <class T>
class MapJobs;

class VideoController {
public:
    struct Context {
        Gl &gl;
        GameSession &game;
        NativeHud &hud;
        ReplayPlayer &viewer;
        BhState &curr;
        const nlohmann::json &preferences;
        const std::string &active_style;
        const std::string &outfit;
        const std::filesystem::path &assets;
        const std::filesystem::path &cache;
        const Options &opt;
        Audio &audio;
        const MapJobs<MapDownloadResult> &download;
    };

    explicit VideoController(ReplayCamera &playback_camera);
    ~VideoController();
    VideoController(const VideoController &) = delete;
    VideoController &operator=(const VideoController &) = delete;

    NativeVideoExport encoder;
    VideoAvailability available{false, "Checking FFmpeg availability…", "ffmpeg"};
    std::unique_ptr<VideoCapture> capture;
    std::unique_ptr<ReplayDirectorJob> director_job;
    nlohmann::json music_catalog = nlohmann::json::array();
    std::string error;

    void bind(Context context, std::function<void(bool)> show_menu, std::function<void()> refresh_playback_pose);
    void cancel();
    nlohmann::json state() const;
    void request(VideoOptions options);
    void prepare_viewer_camera();
    void step();
    void wait_probe();
    void poll_probe();

private:
    ReplayCamera &playback_camera_;
    std::future<VideoAvailability> probe_;
    std::optional<VideoOptions> pending_video;
    ReplayCamera prepared_camera;
    bool director_only = false;
    std::optional<Context> context_;
    std::function<void(bool)> show_menu_;
    std::function<void()> refresh_playback_pose_;

    void begin(const VideoOptions &options);
    void step_director();
    void step_capture();
};

}  // namespace native
