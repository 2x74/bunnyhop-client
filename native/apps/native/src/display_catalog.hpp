#pragma once
#include "display_modes.hpp"
#include "runner_view.hpp"
#include <SDL3/SDL.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>

namespace native {

// The monitors and the exclusive fullscreen modes each offers, for Settings → Display. Rebuilt when a monitor,
// its mode or the window's monitor changes, never per frame. Sizes are pixels (a 2× macOS mode counts as its
// pixels), each size and rate once.
class DisplayCatalog {
public:
    static constexpr int max_displays = 16;
    static constexpr size_t max_modes_per_display = 160;

    void refresh(SDL_Window *window) {
        nlohmann::json displays = nlohmann::json::array();
        int count = 0;
        auto *ids = SDL_GetDisplays(&count);
        const SDL_DisplayID window_display = window ? SDL_GetDisplayForWindow(window) : 0;
        for (int index = 0; ids && index < count && index < max_displays; ++index)
            displays.push_back(describe(ids[index], index, ids[index] == window_display));
        SDL_free(ids);
        json_ = {{"displays", std::move(displays)}, {"exclusive", exclusive_mode(window)}};
    }

    const nlohmann::json &json() const { return json_; }

private:
    nlohmann::json json_ = {{"displays", nlohmann::json::array()}, {"exclusive", nullptr}};

    static double refresh_hz(const SDL_DisplayMode &mode) {
        constexpr double hundredths = 100;
        return std::round(double(mode.refresh_rate) * hundredths) / hundredths;
    }

    static nlohmann::json mode_json(const SDL_DisplayMode &mode) {
        return {{"width", int(std::lround(mode.w * mode.pixel_density))},
                {"height", int(std::lround(mode.h * mode.pixel_density))},
                {"refreshHz", refresh_hz(mode)}};
    }

    static nlohmann::json modes(SDL_DisplayID display) {
        nlohmann::json result = nlohmann::json::array();
        int count = 0;
        auto **offered = SDL_GetFullscreenDisplayModes(display, &count);
        for (int i = 0; offered && i < count && result.size() < max_modes_per_display; ++i) {
            auto mode = mode_json(*offered[i]);
            if (std::find(result.begin(), result.end(), mode) == result.end()) result.push_back(std::move(mode));
        }
        SDL_free(offered);
        return result;
    }

    static nlohmann::json describe(SDL_DisplayID display, int index, bool has_window) {
        const char *name = SDL_GetDisplayName(display);
        const auto *desktop = SDL_GetDesktopDisplayMode(display);
        return {{"name", name ? name : ""},
                {"index", index},
                {"window", has_window},
                {"primary", display == SDL_GetPrimaryDisplay()},
                {"desktop", desktop ? mode_json(*desktop) : nlohmann::json(nullptr)},
                {"modes", modes(display)}};
    }

    // The mode exclusive fullscreen shows now, or null when the window isn't in it.
    static nlohmann::json exclusive_mode(SDL_Window *window) {
        if (!window || !(SDL_GetWindowFlags(window) & SDL_WINDOW_FULLSCREEN)) return nullptr;
        const auto *mode = SDL_GetWindowFullscreenMode(window);
        return mode ? mode_json(*mode) : nlohmann::json(nullptr);
    }
};

// The window as the player sees it, for the runner's view sent with a run: its pixels and, in exclusive
// fullscreen, the monitor's own desktop size and the chosen scaling.
inline ShownWindow shown_window(SDL_Window *window, const WindowJson &settings) {
    ShownWindow shown;
    SDL_GetWindowSizeInPixels(window, &shown.width, &shown.height);
    shown.exclusive = (SDL_GetWindowFlags(window) & SDL_WINDOW_FULLSCREEN) && SDL_GetWindowFullscreenMode(window);
    if (!shown.exclusive) return shown;
    if (const auto *desktop = SDL_GetDesktopDisplayMode(SDL_GetDisplayForWindow(window))) {
        shown.desktop_width = int(std::lround(desktop->w * desktop->pixel_density));
        shown.desktop_height = int(std::lround(desktop->h * desktop->pixel_density));
    }
    shown.exclusive_bars = fullscreen_scaling_setting(settings) == "bars";
    return shown;
}

}  // namespace native
