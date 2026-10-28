#pragma once
#include "settings.hpp"
#include <filesystem>
#include <string>
#include <system_error>

namespace native {

// Display defaults. New installs: VSync off and a 500 FPS cap. VSync adds one or more refresh periods of input
// latency (more where the driver queues frames); a cap above every common refresh rate (up to 480 Hz panels) keeps
// frames fresh without running a light map at thousands of FPS. Timed input makes what each tick takes independent
// of the frame rate either way.
//
// Players who already have the game keep what they had. Their settings file stores its own values; an older install
// that never saved settings still had VSync on and no cap, so it keeps those.
inline bool existing_install(const std::filesystem::path &data_dir) {
    static const char *const markers[] = {
        "settings.json", "window-state.json", "tutorial-progress.json", "start-points.json", "replays", "run-vault",
    };
    for (const char *marker : markers) {
        std::error_code error;
        if (std::filesystem::exists(data_dir / marker, error)) {
            return true;
        }
    }
    return false;
}

// Settings for this launch: the saved file, or defaults (with the old display defaults for an existing install).
inline Json startup_settings(const std::filesystem::path &data_dir) {
    const auto file = data_dir / "settings.json";
    if (std::filesystem::exists(file)) {
        return load_settings(file);
    }
    auto settings = default_settings();
    if (existing_install(data_dir)) {
        settings["vsync"] = true;
        settings["fpsLimit"] = 0;
    }
    return settings;
}

}  // namespace native
