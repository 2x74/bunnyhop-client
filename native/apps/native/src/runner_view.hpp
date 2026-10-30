#pragma once
#include "display_modes.hpp"
#include "graphics_settings.hpp"
#include <nlohmann/json.hpp>
#include <cmath>
#include <cstdio>
#include <optional>
#include <string>

namespace native {

// What the runner saw: the shape the game drew (`aspect`), the shape of the monitor it was shown on (`screen`),
// how one filled the other, and the FOV. Sent with a finished run in diagnostics `play.view`, so a replay can be
// watched as the runner played it ("4:3 stretched" on a 16:9 monitor).
struct RunnerView {
    double aspect = 0;
    double screen = 0;
    bool bars = false;
    double fov = 90;

    bool stretched() const { return !bars && std::abs(aspect - screen) >= aspect_match; }

    bool operator==(const RunnerView &) const = default;
};

// The window as it was shown: its size in pixels, and in exclusive fullscreen the mode and the monitor's own
// desktop size (a 1280×960 mode on a 2560×1440 monitor is scaled by the monitor or the graphics card).
struct ShownWindow {
    int width = 0;
    int height = 0;
    bool exclusive = false;
    int desktop_width = 0;
    int desktop_height = 0;
    bool exclusive_bars = false;
};

inline constexpr double runner_view_min_aspect = .5;
inline constexpr double runner_view_max_aspect = 4;
inline constexpr double runner_view_min_fov = 60;
inline constexpr double runner_view_max_fov = 130;

inline RunnerView runner_view(const GraphicsSettings &graphics, const ShownWindow &window, double fov) {
    RunnerView view;
    view.fov = fov;
    const double window_aspect = window.height > 0 ? double(window.width) / window.height : 0;
    const bool scaled_mode = window.exclusive && window.desktop_height > 0
                             && !same_shape(window.width, window.height, window.desktop_width, window.desktop_height);
    view.screen = scaled_mode ? double(window.desktop_width) / window.desktop_height : window_aspect;
    view.aspect = graphics.aspect > 0 ? graphics.aspect : window_aspect;
    view.bars = graphics.aspect > 0 && graphics.bars;
    if (scaled_mode && !view.bars) view.bars = window.exclusive_bars;
    return view;
}

inline double rounded(double value, double per_unit) {
    return std::round(value * per_unit) / per_unit;
}

inline nlohmann::json runner_view_json(const RunnerView &view) {
    constexpr double aspect_per_unit = 1000, fov_per_unit = 10;
    return {{"aspect", rounded(view.aspect, aspect_per_unit)},
            {"screen", rounded(view.screen, aspect_per_unit)},
            {"fit", view.bars ? "bars" : "stretch"},
            {"fov", rounded(view.fov, fov_per_unit)}};
}

inline bool runner_view_number(const nlohmann::json &value, double low, double high) {
    return value.is_number() && value.get<double>() >= low && value.get<double>() <= high;
}

// A `play.view` from a run's diagnostics or the replay vault, or nullopt when it is missing or out of range.
inline std::optional<RunnerView> read_runner_view(const nlohmann::json &value) {
    if (!value.is_object()) return std::nullopt;
    const auto aspect = value.value("aspect", nlohmann::json());
    const auto screen = value.value("screen", nlohmann::json());
    const auto fit = value.value("fit", nlohmann::json());
    const auto fov = value.value("fov", nlohmann::json());
    if (!runner_view_number(aspect, runner_view_min_aspect, runner_view_max_aspect)
        || !runner_view_number(screen, runner_view_min_aspect, runner_view_max_aspect)
        || !runner_view_number(fov, runner_view_min_fov, runner_view_max_fov) || (fit != "stretch" && fit != "bars"))
        return std::nullopt;
    return RunnerView{aspect.get<double>(), screen.get<double>(), fit == "bars", fov.get<double>()};
}

// The viewer's graphics settings changed to draw the runner's picture: their shape, stretched or with bars.
// On a monitor of the runner's shape this gives the runner's exact picture; on another it keeps their shape
// and fills the screen the way they did.
inline GraphicsSettings runner_view_graphics(GraphicsSettings graphics, const RunnerView &view) {
    graphics.aspect = float(view.aspect);
    graphics.bars = view.bars;
    return graphics;
}

// "4:3 stretched", "4:3 black bars" or "16:9", for labels.
inline std::string runner_view_label(const RunnerView &view) {
    constexpr int label_denominator = 1000;
    std::string shape(aspect_name(int(std::lround(view.aspect * label_denominator)), label_denominator));
    if (shape.empty()) {
        char text[16];
        std::snprintf(text, sizeof text, "%.2f:1", view.aspect);
        shape = text;
    }
    if (view.stretched()) return shape + " stretched";
    if (view.bars && std::abs(view.aspect - view.screen) >= aspect_match) return shape + " black bars";
    return shape;
}

}  // namespace native
