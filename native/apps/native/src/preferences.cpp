#include "preferences.hpp"
#include <nlohmann/json.hpp>

namespace native {
Preferences Preferences::from_settings(const nlohmann::json &settings) {
    Preferences preferences;
    preferences.sensitivity = settings.at("sensitivity").get<double>();
    preferences.vertical_sensitivity = settings.at("verticalSensitivity").get<double>();
    preferences.separate_vertical = settings.at("separateVertical").get<bool>();
    preferences.invert_y = settings.at("invertY").get<bool>();
    preferences.input_backend = input_backend_choice(settings.value("inputBackend", std::string("auto")));
    preferences.timed_input = settings.value("timedInput", true);
    preferences.mouse_diagnostics = settings.at("mouseDiagnostics").get<bool>();
    preferences.limit_queued_frames = settings.at("limitQueuedFrames").get<bool>();
    preferences.low_latency_mode = settings.value("lowLatencyMode", std::string("off"));
    preferences.reflex_flash = settings.value("reflexFlash", false);
    preferences.vsync = settings.at("vsync").get<bool>();
    preferences.fps_limit = settings.at("fpsLimit").get<int>();
    preferences.fov = settings.at("fov").get<float>();
    preferences.hud_scale = settings.at("hudScale").get<float>();
    preferences.hud = settings.at("hud").get<bool>();
    preferences.crosshair = settings.at("crosshair").get<bool>();
    preferences.viewmodel = settings.at("viewmodel").get<bool>();
    preferences.source_look = settings.at("sourceLook").get<bool>();
    preferences.jump_stats = settings.at("jumpStats").get<bool>();
    preferences.strafe_trainer = settings.at("strafeTrainer").get<bool>();
    preferences.strafe_trainer_hints = settings.at("strafeTrainerHints").get<bool>();
    preferences.practice_keep_velocity = settings.at("practiceKeepVelocity").get<bool>();
    preferences.hold_restart = settings.at("holdRestart").get<bool>();
    preferences.show_ghost = settings.value("showGhost", true);
    preferences.ghost_opacity = settings.value("ghostOpacity", .4f);
    preferences.ghost_near_fade = settings.value("ghostNearFade", true);
    preferences.ghost_tag = settings.value("ghostTag", true);
    preferences.capture_pb_screenshots = settings.value("capturePbScreenshots", false);
    preferences.always_on_top = settings.value("alwaysOnTop", false);
    preferences.remember_window_bounds = settings.value("rememberWindowBounds", true);
    return preferences;
}
}  // namespace native
