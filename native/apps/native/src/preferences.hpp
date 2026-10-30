#pragma once
#include <nlohmann/json.hpp>
#include "input_backend_choice.hpp"
#include "native_cosmetics.hpp"
#include <string>

namespace native {
// Built from validated settings when they change. JSON remains the persisted/menu form.
struct Preferences {
    double sensitivity;
    double vertical_sensitivity;
    bool separate_vertical;
    bool invert_y;
    bool timed_input;
    bool mouse_diagnostics;
    InputBackendChoice input_backend;
    bool limit_queued_frames;
    std::string low_latency_mode;
    bool reflex_flash;
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
    native_render::GhostSource ghost_compare;
    bool capture_pb_screenshots;
    bool always_on_top;
    bool remember_window_bounds;
    static Preferences from_settings(const nlohmann::json &settings);
};
}  // namespace native
