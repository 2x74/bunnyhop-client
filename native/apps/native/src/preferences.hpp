#pragma once
#include <nlohmann/json.hpp>

namespace native {
// Built from validated settings when they change. JSON remains the persisted/menu form.
struct Preferences {
    double sensitivity;
    double vertical_sensitivity;
    bool separate_vertical;
    bool invert_y;
    bool timed_input;
    bool mouse_diagnostics;
    bool limit_queued_frames;
    bool vsync;
    int fps_limit;
    float fov;
    float hud_scale;
    bool hud;
    bool crosshair;
    bool viewmodel;
    bool source_look;
    bool jump_stats;
    bool strafe_trainer;
    bool strafe_trainer_hints;
    bool practice_keep_velocity;
    bool hold_restart;
    bool show_ghost;
    float ghost_opacity;
    bool ghost_near_fade;
    bool ghost_tag;
    bool capture_pb_screenshots;
    bool always_on_top;
    bool remember_window_bounds;
    static Preferences from_settings(const nlohmann::json &settings);
};
}  // namespace native
