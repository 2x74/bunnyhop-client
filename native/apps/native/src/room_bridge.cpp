#include "room_bridge.hpp"
#include "options.hpp"
#include "native_input.hpp"
#include "menu_webview.hpp"
#include "tutorial_runner.hpp"
#include <map>

namespace native {
namespace {

constexpr auto presence_interval = std::chrono::milliseconds(250);
constexpr auto pose_interval = std::chrono::milliseconds(50);
constexpr int pose_tick_ms = 10;

std::string hash_room(const std::string &text) {
    char hex[65]{};
    bh_sha256(reinterpret_cast<const uint8_t *>(text.data()), text.size(), hex);
    return std::string(hex);
}

}  // namespace

RoomBridge::RoomBridge() {
    discord.on_join = std::bind_front(&RoomBridge::join, this);
}

void RoomBridge::bind_presence(
        const Options &options, MenuWebView *menu, const bool &menu_ready, std::function<void(bool)> show_menu
) {
    // Hidden and scripted runs must never publish activity to the player's profile.
    discord_allowed = !options.frames && !options.hidden && options.menu_smoke.empty();
    menu_ = menu;
    menu_ready_ = &menu_ready;
    show_menu_ = std::move(show_menu);
}

void RoomBridge::join(const std::string &id) {
    if (!menu_ || !*menu_ready_) return;
    show_menu_(true);
    menu_->evaluate_js("window.bunnyhopNativeMenu?.joinRoom?.(" + nlohmann::json(id).dump() + ")");
}

void RoomBridge::update_presence(
        Clock::time_point now,
        const std::string &map_id,
        const std::string &active_style,
        bool playback,
        bool captured,
        bool menu_visible,
        bool tutorial_practice
) {
    if (now - presence_time >= presence_interval) {
        presence_time = now;
        const auto unix_now = int64_t(
                std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch())
                        .count()
        );
        if (map_id != presence_map) {
            presence_map = map_id;
            presence_started = unix_now;
        }
        const auto &settings = discord_settings;
        nlohmann::json activity;
        if (discord_allowed && settings.enabled && !settings.privacy) {
            activity = presence_activity(
                    map_id, active_style, playback, captured, menu_visible, tutorial_practice, unix_now
            );
        }
        discord.update(discord_allowed && settings.enabled && !settings.privacy, activity);
    }
}

nlohmann::json RoomBridge::presence_activity(
        const std::string &map_id,
        const std::string &active_style,
        bool playback,
        bool captured,
        bool menu_visible,
        bool tutorial_practice,
        int64_t unix_now
) const {
    static const std::map<std::string, std::string> style_names = {
            {"autohop", "Normal"},
            {"legit", "EZ Scroll"},
            {"scroll", "Legit Scroll"},
            {"wonly", "W-Only"},
            {"sideways", "Sideways"},
            {"hsw", "Half-Sideways"},
            {"lowgrav", "Low Gravity"},
            {"segmented", "Segmented"},
            {"autostrafe", "Auto-strafe"}
    };
    native::discord::Status status;
    status.kind = map_id.empty() ? "menu" : playback ? "replay" : (!captured || menu_visible) ? "paused" : "playing";
    status.mode = playback ? "replay" : !room.id.empty() ? "multiplayer" : tutorial_practice ? "practice" : "solo";
    status.map = map_id == native::TutorialRunner::map_id ? "the tutorial" : map_id;
    const auto named = style_names.find(active_style);
    status.style = named == style_names.end() ? active_style : named->second;
    status.started_at = presence_started;
    status.room = room.id;
    return native::discord::build_activity(status, discord_settings, hash_room, unix_now);
}

void RoomBridge::publish_pose(
        Clock::time_point now,
        Clock::time_point started,
        MenuWebView *menu,
        bool menu_ready,
        BhContext *core,
        const std::string &map_id,
        bool playback,
        bool spectator,
        const BhState &curr,
        const Input &input,
        const BhRunState &run_state,
        const std::string &active_style
) {
    if (menu && menu_ready && core && !playback && !spectator && !room.id.empty() && room.map == map_id
        && now - room_time >= pose_interval) {
        BhWeaponReport weapon{};
        bh_weapon_report(core, &weapon);
        const auto tick =
                uint32_t(std::chrono::duration_cast<std::chrono::milliseconds>(now - started).count() / pose_tick_ms);
        const nlohmann::json pose = {
                {"generation", room.generation},
                {"id", room.id},
                {"map", map_id},
                {"sample",
                 {{"tick", tick},
                  {"x", curr.position[0]},
                  {"y", curr.position[1]},
                  {"z", curr.position[2]},
                  {"vx", curr.velocity[0]},
                  {"vy", curr.velocity[1]},
                  {"vz", curr.velocity[2]},
                  {"yaw", input.yaw()},
                  {"pitch", input.pitch},
                  {"flags", room_events | (curr.grounded ? 1 : 0) | (curr.crouched ? 2 : 0)}}},
                {"meta",
                 {{"style", active_style},
                  {"track", run_state.track},
                  {"timer",
                   run_state.status == 2   ? 3
                   : run_state.status == 1 ? 2
                   : run_state.in_start    ? 1
                                           : 0},
                  {"timerTicks",
                   run_state.status ? (run_state.status == 2 ? run_state.end_tick : curr.tick) - run_state.start_tick
                                    : 0}}},
                {"weapon", weapon.active},
                {"silenced", weapon.silencer != 0}
        };
        menu->evaluate_js("window.bunnyhopNativeMenu?.onRoomPose?.(" + pose.dump() + ")");
        room_events = 0;
        room_time = now;
    }
}

}  // namespace native
