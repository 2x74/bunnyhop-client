#pragma once
#include "bunnyhop_native.h"
#include <nlohmann/json.hpp>
#include <chrono>
#include <functional>
#include <memory>
#include <optional>
#include <string>

struct SDL_Window;

namespace native {

struct Options;
struct Gl;
class GameSession;
class NativeHud;
class MenuWebView;
class MenuBackdrop;
struct ReplayPlayer;
struct Input;
struct MapDownloadResult;
template <class T>
class MapJobs;

int run_presentation_smoke(const Options &opt, SDL_Window *window, Gl &gl, GameSession &game, NativeHud &hud);
// Replays a recorded room session (DIR/room.jsonl) and saves the frames in DIR/shots.json.
int run_room_smoke(const Options &opt, SDL_Window *window, Gl &gl, GameSession &game, NativeHud &hud);

struct VideoSmokeState {
    const Options &opt;
    GameSession &game;
    ReplayPlayer &viewer;
    BhState &curr;
    BhState &prev;
    Input &camera_controls;
    nlohmann::json &preferences;
};

class VideoSmoke : private VideoSmokeState {
public:
    VideoSmoke(VideoSmokeState state, std::function<void()> refresh_playback_pose);
    void begin();
    void frame(bool &running);

private:
    std::function<void()> refresh_playback_pose_;
    int video_smoke_stage = 0;
    std::string video_smoke_encoder;
    std::chrono::steady_clock::time_point video_smoke_started;
    void check_restored() const;
};

class MenuSmoke {
public:
    using Clock = std::chrono::steady_clock;

    struct Context {
        SDL_Window *window;
        GameSession &game;
        const BhState &curr;
        const std::unique_ptr<MenuWebView> &menu;
        const std::unique_ptr<MenuBackdrop> &backdrop;
        const std::string &backdrop_source;
        const std::string &backdrop_shown;
        const std::string &backdrop_png;
        const bool &gameplay_backdrop_due;
        const bool &menu_ready;
        const MapJobs<MapDownloadResult> &download;
        const std::string &error;
        bool &running;
    };

    explicit MenuSmoke(const Options &opt);
    bool requested = false;
    bool passed = false;
    bool snapshot_pending = false;

    void bind(Context context);
    void receive(nlohmann::json &message);
    void snapshot(const nlohmann::json &message);
    void frame(Clock::time_point now, Clock::time_point started);

private:
    const Options &opt;
    std::optional<Context> context_;
    bool map_requested = false;
    void request_map();
    void capture_images();
    void request();
};

}  // namespace native
