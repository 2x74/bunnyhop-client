#pragma once
#include "hud.hpp"
#include "hud_demo.hpp"
#include "hud_editor.hpp"
#include "look_menu.hpp"
#include "weapon_menu.hpp"
#include "preferences.hpp"
#include "spectate.hpp"

namespace native {

struct PracticeController;
struct MouseDiagnostics;
class FrameDiagnostics;
struct ReplayPlayer;
class RoomState;
class RoomModes;
class RacePicker;
struct LeaveHold;

struct HudFrame {
    BhContext *core;
    NativeHud &hud;
    const NativeHud::Layout &hud_layout;
    const Preferences &prefs;
    const PracticeController &practice;
    const MovementFeedback &feedback;
    const MouseDiagnostics &mouse_diagnostics;
    const FrameDiagnostics &frame_diagnostics;
    ReplayPlayer &viewer;
    Chat &chat;
    RoomState &room;
    RoomModes &room_modes;
    const NativeWeaponMenu &gun_menu;
    const NativeTriggerMenu &trigger_menu;
    const RacePicker &race_picker;
    const LeaveHold &leave_hold;
    const BhState &curr;
    const BhSnapshot &state;
    const BhRunState &display_run;
    const BhRunState &run_state;
    const std::string &map_id;
    const std::string &active_style;
    const std::string &display_style;
    const std::string &shown_notice;
    const std::string &gauntlet_line;
    const std::string &gauntlet_delta;
    bool gauntlet_good;
    double display_fps;
    double steady_seconds;
    int width;
    int height;
    bool visible;
    bool video_preparing;
    bool scoreboard;
    WeaponMenuContext weapon_menu_context;
    HudLayoutEditor &layout_editor;
    HudDemoState &layout_demo;
    float display_scale;
    std::string layout_editor_key;
    const SpectatePicker &spectate_picker;
    SpectatorBar spectator_bar;
    // Freecam or spectator free look: no crosshair, as nothing aims.
    bool free_camera = false;
    // !bright's quick menu, and the cursor over a menu a chat line opened (menu_cursor.hpp), for the row it's on.
    const LookMenu *look_menu = nullptr;
    std::optional<std::array<float, 2>> menu_pointer;

    void draw() const;

private:
    void draw_status(const BhCmd &shown, const BhWeaponReport &weapon) const;
    void draw_layout_editor() const;
    void draw_diagnostics() const;
    void draw_playback() const;
    void draw_chat() const;
    void draw_panels() const;
    void draw_notifications() const;
};

}  // namespace native
