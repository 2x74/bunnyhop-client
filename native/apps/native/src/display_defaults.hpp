#pragma once
#include "settings.hpp"
#include <filesystem>
#include <string>
#include <system_error>

namespace native {

// New installs use the website's display defaults: VSync off and a 1000 FPS cap.
// Saved values stay authoritative. An existing install without a settings file
// retains its earlier VSync-on, uncapped behavior.
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

struct StartupData {
    Json settings = default_settings();
    bool first_settings = true;
    std::string error;
};

inline StartupData initialize_data_directory(const std::filesystem::path &data_dir) {
    StartupData startup;
    startup.first_settings = !std::filesystem::exists(data_dir / "settings.json");
    try {
        startup.settings = startup_settings(data_dir);
    } catch (const std::exception &error) {
        startup.error = error.what();
    }
    // Detect the install before creating anything that counts as a previous launch.
    std::filesystem::create_directories(data_dir / "replays");
    for (const char *folder : {"sound", "bgm"}) {
        std::error_code error;
        std::filesystem::create_directories(data_dir / folder, error);
    }
    return startup;
}

}  // namespace native
