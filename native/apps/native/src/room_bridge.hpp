#pragma once
#include "room_state.hpp"
#include "room_modes.hpp"
#include "discord_rpc.hpp"
#include "room_pose.hpp"
#include <chrono>
#include <functional>
#include <optional>
#include <string>

namespace native {

struct Options;
class MenuWebView;

class RoomBridge {
public:
    using Clock = std::chrono::steady_clock;

    RoomBridge();
    RoomBridge(const RoomBridge &) = delete;
    RoomBridge &operator=(const RoomBridge &) = delete;

    RoomState room;
    RoomModes room_modes;
    NameTagSights tag_sights;
    std::optional<unsigned> observed_spectator;
    uint32_t room_events = 8;
    discord::Settings discord_settings;
    discord::Client discord;
    bool discord_allowed = false;

    void bind_presence(
            const Options &options, MenuWebView *menu, const bool &menu_ready, std::function<void(bool)> show_menu
    );
    // Once a frame: tells the menu when this attempt turns into practice or back, so the room shows your practice tag.
    void publish_practice(bool practicing);
    void update_presence(
            Clock::time_point now,
            const std::string &map_id,
            const std::string &active_style,
            bool playback,
            bool captured,
            bool menu_visible,
            bool tutorial_practice
    );
    // Once per simulated tick (not during replay playback): samples your movement and sends a batch when one is due.
    void publish_tick(
            MenuWebView *menu,
            bool menu_ready,
            const std::string &map_id,
            bool spectator,
            const BhState &curr,
            const BhCmd &cmd,
            const BhRunState &run_state,
            const BhWeaponReport &weapon,
            const std::string &active_style
    );

private:
    RoomPoseBatcher poses_;
    uint64_t pose_generation_ = 0;
    Clock::time_point presence_time{};
    std::string presence_map;
    int64_t presence_started = 0;
    MenuWebView *menu_ = nullptr;
    const bool *menu_ready_ = nullptr;
    std::function<void(bool)> show_menu_;
    bool practice_sent_ = false;

    void join(const std::string &id);
    nlohmann::json presence_activity(
            const std::string &map_id,
            const std::string &active_style,
            bool playback,
            bool captured,
            bool menu_visible,
            bool tutorial_practice,
            int64_t unix_now
    ) const;
};

}  // namespace native
