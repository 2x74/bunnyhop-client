#include "room_bridge.hpp"
#include "options.hpp"
#include "menu_webview.hpp"
#include "tutorial_runner.hpp"
#include "room_styles.hpp"

namespace native {
namespace {

constexpr auto presence_interval = std::chrono::milliseconds(250);

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
    native::discord::Status status;
    status.kind = map_id.empty() ? "menu" : playback ? "replay" : (!captured || menu_visible) ? "paused" : "playing";
    status.mode = playback ? "replay" : !room.id.empty() ? "multiplayer" : tutorial_practice ? "practice" : "solo";
    status.map = map_id == native::TutorialRunner::map_id ? "the tutorial" : map_id;
    status.style = wire_style_name(active_style);
    status.started_at = presence_started;
    status.room = room.id;
    return native::discord::build_activity(status, discord_settings, hash_room, unix_now);
}

void RoomBridge::publish_practice(bool practicing) {
    // A reloaded menu starts out not practising.
    if (!menu_ || !menu_ready_ || !*menu_ready_) {
        practice_sent_ = false;
        return;
    }
    if (practicing == practice_sent_) return;
    practice_sent_ = practicing;
    menu_->evaluate_js(
            practicing ? "window.bunnyhopNativeMenu?.onRoomPractice?.(true)"
                       : "window.bunnyhopNativeMenu?.onRoomPractice?.(false)"
    );
}

void RoomBridge::publish_tick(
        MenuWebView *menu,
        bool menu_ready,
        const std::string &map_id,
        bool spectator,
        const BhState &curr,
        const BhCmd &cmd,
        const BhRunState &run_state,
        const BhWeaponReport &weapon,
        const std::string &active_style
) {
    if (room.generation != pose_generation_) {
        poses_.clear();
        pose_generation_ = room.generation;
    }
    const bool sending = menu && menu_ready && !spectator && !room.id.empty() && room.map == map_id;
    if (!poses_.advance(sending)) return;
    RoomPoseSample sample;
    std::copy(std::begin(curr.position), std::end(curr.position), sample.position.begin());
    std::copy(std::begin(curr.velocity), std::end(curr.velocity), sample.velocity.begin());
    // The command's view, as web sends: the angles the tick was simulated with.
    sample.yaw = cmd.yaw;
    sample.pitch = cmd.pitch;
    sample.flags = room_events | (curr.grounded ? room_flag_grounded : 0) | (curr.crouched ? room_flag_crouched : 0);
    room_events = 0;
    poses_.add(sample);
    if (!poses_.batch_due()) return;
    auto meta = room_pose_meta(run_state, curr.tick, active_style);
    meta.weapon = weapon.active;
    meta.silenced = weapon.silencer != 0;
    const auto message = room_pose_message(room.generation, room.id, map_id, poses_.samples(), meta);
    menu->evaluate_js("window.bunnyhopNativeMenu?.onRoomPose?.(" + message.dump() + ")");
    poses_.clear();
}

}  // namespace native
