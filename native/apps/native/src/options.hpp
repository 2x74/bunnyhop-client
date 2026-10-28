#pragma once
#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <ostream>

namespace native {
struct Options {
    std::string map, content_root, screenshot, online_map, menu_html = BUNNYHOP_MENU_HTML, menu_smoke;
    uint64_t frames = 0;
    double sensitivity = 2;
    bool hidden = false, help = false, no_menu = false, windowed = false, sensitivity_set = false,
         menu_home_smoke = false;
    // Comparator: the pre-0.5.2 per-frame proration and latest-polled keys instead of timestamped input.
    bool legacy_input = false;
    std::string style = "autohop", replay, tutorial_lesson, runtime_smoke, video_smoke, presentation_smoke;
    bool tutorial_demo = false;
    // Render checks: a fixed eye (Source x, y, z) and pitch, yaw, with no HUD or viewmodel.
    std::optional<std::array<float, 5>> camera;
};

Options options(int argc, char **argv);
void print_help(std::ostream &output);
}  // namespace native
