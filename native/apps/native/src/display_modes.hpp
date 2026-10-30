#pragma once
#include "window_settings.hpp"
#include <cmath>
#include <cstdlib>
#include <optional>
#include <span>
#include <string_view>

namespace native {

// One mode a monitor offers for exclusive fullscreen, in pixels.
struct DisplayModeOption {
    int width = 0;
    int height = 0;
    double refresh_hz = 0;
};

// Two refresh rates closer than this are the same rate (59.94 and 60 Hz are not).
inline constexpr double refresh_match_hz = .01;
// Shapes closer than this are the same shape (1366×768 is 16:9).
inline constexpr double aspect_match = .01;

// The name players use for a resolution's shape, or empty for an unusual one.
inline std::string_view aspect_name(int width, int height) {
    if (width <= 0 || height <= 0) return {};

    struct Shape {
        int across;
        int down;
        std::string_view name;
    };

    static constexpr Shape shapes[] = {
            {4, 3, "4:3"}, {5, 4, "5:4"}, {16, 10, "16:10"}, {16, 9, "16:9"}, {21, 9, "21:9"}, {32, 9, "32:9"}
    };
    const double aspect = double(width) / height;
    for (const auto &shape : shapes) {
        if (std::abs(aspect - double(shape.across) / shape.down) < aspect_match * 2) return shape.name;
    }
    // 2560×1080 and 3440×1440 are sold as 21:9 though they are 64:27 and 43:18.
    constexpr double ultrawide_low = 2.3, ultrawide_high = 2.45;
    if (aspect > ultrawide_low && aspect < ultrawide_high) return "21:9";
    return {};
}

inline bool same_shape(int width, int height, int other_width, int other_height) {
    if (width <= 0 || height <= 0 || other_width <= 0 || other_height <= 0) return true;
    return std::abs(double(width) / height - double(other_width) / other_height) < aspect_match;
}

// The offered mode that matches `want`: its exact size, at its refresh rate when offered, otherwise the highest
// rate of that size. nullopt when the size isn't offered (another monitor, or one that was unplugged).
inline std::optional<size_t> matching_mode(std::span<const DisplayModeOption> modes, const FullscreenMode &want) {
    std::optional<size_t> best;
    for (size_t index = 0; index < modes.size(); ++index) {
        const auto &mode = modes[index];
        if (mode.width != want.width || mode.height != want.height) continue;
        if (want.refresh_hz > 0 && std::abs(mode.refresh_hz - want.refresh_hz) < refresh_match_hz) return index;
        if (!best || mode.refresh_hz > modes[*best].refresh_hz) best = index;
    }
    return best;
}

// A monitor as the settings name it: by name and place, then by name alone (it moved in the list), then by place.
struct DisplayIdentity {
    std::string_view name;
    int index = 0;
};

inline std::optional<size_t> matching_display(std::span<const DisplayIdentity> displays, const FullscreenMode &want) {
    if (want.display.empty() && want.display_index < 0) return std::nullopt;
    for (size_t index = 0; index < displays.size(); ++index) {
        if (displays[index].name == want.display && displays[index].index == want.display_index) return index;
    }
    for (size_t index = 0; index < displays.size(); ++index) {
        if (!want.display.empty() && displays[index].name == want.display) return index;
    }
    for (size_t index = 0; index < displays.size(); ++index) {
        if (displays[index].index == want.display_index) return index;
    }
    return std::nullopt;
}

}  // namespace native
