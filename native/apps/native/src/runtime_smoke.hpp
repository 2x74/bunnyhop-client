#pragma once
#include "bunnyhop_native.h"
#include <nlohmann/json.hpp>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

struct SDL_Window;

namespace native {

struct Options;
struct Gl;
class Renderer;
class MenuWebView;
class NativeHud;
struct Input;
struct PracticeController;
struct ReplayPlayer;
struct LeaveHold;
struct RunHeartbeat;
class RoomState;
struct MapDownloadResult;
template <class T>
class MapJobs;

struct RuntimeSmokeState {
    const Options &opt;
    std::unique_ptr<BhContext, decltype(&bh_destroy)> &core;
    std::unique_ptr<Renderer> &renderer;
    const std::unique_ptr<MenuWebView> &menu;
    Gl &gl;
    NativeHud &hud;
    SDL_Window *window;
    Input &input;
    BhState &curr;
    BhState &prev;
    PracticeController &practice;
    bool &third_person;
    std::string &map_id;
    const std::string &active_style;
    const std::string &selected_style;
    const uint32_t &active_track;
    const std::string &gauntlet_id;
    ReplayPlayer &viewer;
    LeaveHold &leave_hold;
    MapJobs<MapDownloadResult> &download;
    std::mutex &progress_mutex;
    std::string &loading;
    RunHeartbeat &heartbeat;
    RoomState &room;
    std::vector<BhZone> &zones;
    std::string &pending_replay;
    std::string &pending_action;
    std::string &pending_tutorial;
    double tick_interval_seconds;
};

struct RuntimeSmokeActions {
    std::function<void(const std::string &, const std::string &, const std::string &, const nlohmann::json &)> load_map;
    std::function<std::string()> practice_reason;
    std::function<void(const std::string &, bool, bool)> action;
    std::function<void()> reset;
    std::function<void(const std::string &, bool, std::optional<bool>)> practice;
    std::function<void(const nlohmann::json &)> gauntlet_action;
    std::function<void(const std::filesystem::path &, const std::string &, unsigned, bool)> open_replay;
    std::function<void(uint32_t)> seek_playback;
    std::function<void()> leave_map;
    std::function<void(const nlohmann::json &)> apply_room_event;
};

class RuntimeSmoke : private RuntimeSmokeState {
public:
    RuntimeSmoke(RuntimeSmokeState state, RuntimeSmokeActions actions);
    int run();

private:
    RuntimeSmokeActions actions_;
    std::filesystem::path output;
    nlohmann::json detail;
    BhCmd command{};
    BhSnapshot snapshot{};
    int w = 0;
    int h = 0;

    void prepare();
    void check_practice();
    void draw_hud_fixture();
    void check_gauntlet();
    void check_replay();
    void start_timed_practice();
    void check_leave();
    void check_workers();
    void write_result();
    void act(const std::string &action, bool wheel = false);
    void practice_action(const std::string &action);
};

}  // namespace native
