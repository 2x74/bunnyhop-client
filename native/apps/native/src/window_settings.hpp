#pragma once
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace native {
using WindowJson = nlohmann::json;

inline bool valid_window_mode(const std::string &mode) {
    return mode == "windowed" || mode == "borderless" || mode == "fullscreen";
}

// Exclusive fullscreen's display mode. A width of 0 is the display's desktop mode; a refresh rate of 0 is the
// highest the size offers. `display` is the monitor's name and `display_index` its place in SDL's display list,
// which tells two monitors of the same model apart.
struct FullscreenMode {
    std::string display;
    int display_index = -1;
    int width = 0;
    int height = 0;
    double refresh_hz = 0;

    bool operator==(const FullscreenMode &) const = default;
};

inline constexpr int fullscreen_mode_max_side_px = 16384;
inline constexpr double fullscreen_mode_max_refresh_hz = 1000;
inline constexpr size_t fullscreen_mode_max_display_name = 128;
inline constexpr int fullscreen_mode_max_display_index = 64;

inline WindowJson fullscreen_mode_json(const FullscreenMode &mode) {
    return {{"display", mode.display},
            {"displayIndex", mode.display_index},
            {"width", mode.width},
            {"height", mode.height},
            {"refreshHz", mode.refresh_hz}};
}

inline bool fullscreen_side_valid(const WindowJson &value) {
    if (!value.is_number_integer()) return false;
    const auto side = value.get<int64_t>();
    return side == 0 || (side >= 240 && side <= fullscreen_mode_max_side_px);
}

inline std::optional<FullscreenMode> read_fullscreen_mode(const WindowJson &value) {
    if (!value.is_object() || value.size() > 5) return std::nullopt;
    const auto display = value.value("display", WindowJson(""));
    const auto index = value.value("displayIndex", WindowJson(-1));
    const auto width = value.value("width", WindowJson(0));
    const auto height = value.value("height", WindowJson(0));
    const auto refresh = value.value("refreshHz", WindowJson(0));
    if (!display.is_string() || display.get_ref<const std::string &>().size() > fullscreen_mode_max_display_name)
        return std::nullopt;
    if (!index.is_number_integer() || index.get<int64_t>() < -1
        || index.get<int64_t>() > fullscreen_mode_max_display_index)
        return std::nullopt;
    if (!fullscreen_side_valid(width) || !fullscreen_side_valid(height) || (width == 0) != (height == 0))
        return std::nullopt;
    if (!refresh.is_number() || !(refresh.get<double>() >= 0) || refresh.get<double>() > fullscreen_mode_max_refresh_hz)
        return std::nullopt;
    return FullscreenMode{
            display.get<std::string>(), index.get<int>(), width.get<int>(), height.get<int>(), refresh.get<double>()
    };
}

// How a fullscreen resolution of another shape than the monitor fills it.
inline bool valid_fullscreen_scaling(const std::string &scaling) {
    return scaling == "stretch" || scaling == "bars";
}

inline WindowJson default_window_settings() {
    return {{"windowMode", "windowed"},
            {"alwaysOnTop", false},
            {"rememberWindowBounds", true},
            {"minimizeOnFocusLoss", false},
            {"fullscreenMode", fullscreen_mode_json({})},
            {"fullscreenScaling", "stretch"}};
}

inline FullscreenMode fullscreen_mode_setting(const WindowJson &settings) {
    if (!settings.contains("fullscreenMode")) return {};
    return read_fullscreen_mode(settings.at("fullscreenMode")).value_or(FullscreenMode{});
}

inline std::string fullscreen_scaling_setting(const WindowJson &settings) {
    const auto scaling = settings.value("fullscreenScaling", std::string("stretch"));
    return valid_fullscreen_scaling(scaling) ? scaling : "stretch";
}

inline void patch_window_settings(WindowJson &target, const WindowJson &patch) {
    if (!patch.is_object()) return;
    if (patch.contains("windowMode") && patch["windowMode"].is_string()) {
        const auto mode = patch["windowMode"].get<std::string>();
        if (valid_window_mode(mode)) target["windowMode"] = mode;
    }
    for (const char *key : {"alwaysOnTop", "rememberWindowBounds", "minimizeOnFocusLoss"})
        if (patch.contains(key) && patch[key].is_boolean()) target[key] = patch[key];
    if (patch.contains("fullscreenMode")) {
        if (const auto mode = read_fullscreen_mode(patch["fullscreenMode"]))
            target["fullscreenMode"] = fullscreen_mode_json(*mode);
    }
    if (patch.contains("fullscreenScaling") && patch["fullscreenScaling"].is_string()
        && valid_fullscreen_scaling(patch["fullscreenScaling"].get<std::string>()))
        target["fullscreenScaling"] = patch["fullscreenScaling"];
}

struct WindowBounds {
    int x = 0, y = 0, width = 1280, height = 720;
    bool maximized = false;
};

struct WindowArea {
    int x = 0, y = 0, width = 0, height = 0;
};

inline std::optional<WindowBounds> read_window_bounds(const WindowJson &value) {
    if (!value.is_object()) return std::nullopt;
    for (const char *key : {"x", "y", "width", "height"})
        if (!value.contains(key) || !value[key].is_number_integer()) return std::nullopt;
    auto within = [&](const char *key, int64_t low, int64_t high) {
        const auto &n = value[key];
        if (n.is_number_unsigned()) {
            const auto v = n.get<uint64_t>();
            return v <= uint64_t(high) && (low < 0 || v >= uint64_t(low));
        }
        const auto v = n.get<int64_t>();
        return v >= low && v <= high;
    };
    for (const char *key : {"x", "y"})
        if (!within(key, -100000, 100000)) return std::nullopt;
    for (const char *key : {"width", "height"})
        if (!within(key, 240, 16384)) return std::nullopt;
    if (value.contains("maximized") && !value["maximized"].is_boolean()) return std::nullopt;
    return WindowBounds{
            value["x"].get<int>(),
            value["y"].get<int>(),
            value["width"].get<int>(),
            value["height"].get<int>(),
            value.value("maximized", false)
    };
}

inline WindowJson window_bounds_json(const WindowBounds &b) {
    return {{"x", b.x}, {"y", b.y}, {"width", b.width}, {"height", b.height}, {"maximized", b.maximized}};
}

inline WindowBounds clamp_window_bounds(WindowBounds b, const std::vector<WindowArea> &areas) {
    if (areas.empty()) return {0, 0, std::clamp(b.width, 640, 3840), std::clamp(b.height, 480, 2160), b.maximized};
    const WindowArea *best = nullptr;
    int64_t overlap = -1;
    for (const auto &a : areas) {
        if (a.width <= 0 || a.height <= 0) continue;
        const int64_t w = std::max<int64_t>(
                              0, std::min<int64_t>(int64_t(b.x) + b.width, int64_t(a.x) + a.width) - std::max(b.x, a.x)
                      ),
                      h = std::max<int64_t>(
                              0,
                              std::min<int64_t>(int64_t(b.y) + b.height, int64_t(a.y) + a.height) - std::max(b.y, a.y)
                      );
        if (w * h > overlap) {
            overlap = w * h;
            best = &a;
        }
    }
    if (!best) return {0, 0, std::clamp(b.width, 640, 3840), std::clamp(b.height, 480, 2160), b.maximized};
    b.width = std::clamp(b.width, std::min(640, best->width), best->width);
    b.height = std::clamp(b.height, std::min(480, best->height), best->height);
    b.x = std::clamp(b.x, best->x, best->x + best->width - b.width);
    b.y = std::clamp(b.y, best->y, best->y + best->height - b.height);
    return b;
}

inline std::string toggled_window_mode(const std::string &current) {
    return current == "windowed" ? "borderless" : "windowed";
}
}  // namespace native
