#pragma once
#include "display_modes.hpp"
#include "display_scaling.hpp"
#include "window_settings.hpp"
#include <SDL3/SDL.h>
#include <string>
#include <vector>

namespace native {
// SDL window operations stay on the event/context thread. Preferences are only
// committed after apply() succeeds; failure rolls back the prior native mode.
class WindowController {
    // What exclusive fullscreen shows: the chosen mode and how a mode of another shape fills the monitor.
    struct ExclusiveTarget {
        FullscreenMode mode;
        std::string scaling = "stretch";

        bool operator==(const ExclusiveTarget &) const = default;
    };

    SDL_Window *window_;
    std::optional<WindowBounds> normal_;
    std::string desired_ = "windowed", error_;
    ExclusiveTarget exclusive_;

    static std::vector<WindowArea> areas() {
        std::vector<WindowArea> out;
        int count = 0;
        auto *displays = SDL_GetDisplays(&count);
        for (int i = 0; displays && i < count; i++) {
            SDL_Rect r{};
            if (SDL_GetDisplayUsableBounds(displays[i], &r)) out.push_back({r.x, r.y, r.w, r.h});
        }
        SDL_free(displays);
        return out;
    }

    bool set_mode(const std::string &mode, const ExclusiveTarget &target) {
        if (mode == "windowed")
            return SDL_SetWindowFullscreen(window_, false) && SDL_SetWindowFullscreenMode(window_, nullptr)
                   && SDL_SetWindowBordered(window_, true);
        if (mode == "borderless") {
#ifdef _WIN32
            // A borderless window over the display, not SDL desktop fullscreen: Windows'
            // fullscreen optimizations turn a GL window covering exactly the screen into
            // exclusive-style presentation (alt-tab flicker, black capture). One extra row
            // keeps it a normal composited window.
            if (!SDL_SetWindowFullscreen(window_, false) || !SDL_SetWindowFullscreenMode(window_, nullptr))
                return false;
            // Restore only from maximized: restoring a minimized window would show and
            // activate it (WindowModePolicy keeps mode changes off minimized windows).
            if (SDL_GetWindowFlags(window_) & SDL_WINDOW_MAXIMIZED) SDL_RestoreWindow(window_);
            const auto r = borderless_rect();
            if (!r) return false;
            return SDL_SetWindowBordered(window_, false) && SDL_SetWindowSize(window_, r->w, r->h)
                   && SDL_SetWindowPosition(window_, r->x, r->y);
#else
            return SDL_SetWindowFullscreenMode(window_, nullptr) && SDL_SetWindowFullscreen(window_, true);
#endif
        }
        return set_exclusive(target);
    }

    static SDL_DisplayID display_at(int index) {
        int count = 0;
        auto *displays = SDL_GetDisplays(&count);
        const SDL_DisplayID id = displays && index >= 0 && index < count ? displays[index] : 0;
        SDL_free(displays);
        return id;
    }

    // The monitor the settings name, or the one the window is on.
    SDL_DisplayID target_display(const FullscreenMode &mode) const {
        int count = 0;
        auto *displays = SDL_GetDisplays(&count);
        std::vector<DisplayIdentity> known;
        std::vector<std::string> names;
        names.reserve(size_t(std::max(count, 0)));
        for (int i = 0; displays && i < count; i++) {
            const char *name = SDL_GetDisplayName(displays[i]);
            names.emplace_back(name ? name : "");
        }
        for (int i = 0; i < int(names.size()); i++)
            known.push_back({names[size_t(i)], i});
        SDL_free(displays);
        if (const auto found = matching_display(known, mode)) return display_at(int(*found));
        return SDL_GetDisplayForWindow(window_);
    }

    // The display mode to switch to: the chosen size and refresh rate, or the desktop mode.
    std::optional<SDL_DisplayMode> exclusive_mode(const FullscreenMode &mode) {
        const SDL_DisplayID display = target_display(mode);
        if (!mode.width) {
            const auto *desktop = SDL_GetDesktopDisplayMode(display);
            if (!desktop) {
                error_ = SDL_GetError();
                return std::nullopt;
            }
            return *desktop;
        }
        int count = 0;
        auto **offered = SDL_GetFullscreenDisplayModes(display, &count);
        std::vector<DisplayModeOption> options;
        for (int i = 0; offered && i < count; i++) {
            const auto &m = *offered[i];
            options.push_back(
                    {int(std::lround(m.w * m.pixel_density)),
                     int(std::lround(m.h * m.pixel_density)),
                     double(m.refresh_rate)}
            );
        }
        std::optional<SDL_DisplayMode> result;
        if (const auto found = matching_mode(options, mode)) result = *offered[*found];
        SDL_free(offered);
        if (!result)
            error_ = "This monitor doesn't offer " + std::to_string(mode.width) + "×" + std::to_string(mode.height);
        return result;
    }

    // Exclusive fullscreen moves to another monitor from windowed: SDL puts a fullscreen window on the display
    // it is on.
    bool move_to_display(SDL_DisplayID display) {
        if (SDL_GetDisplayForWindow(window_) == display) return true;
        if (SDL_GetWindowFlags(window_) & SDL_WINDOW_FULLSCREEN) {
            if (!SDL_SetWindowFullscreen(window_, false) || !SDL_SyncWindow(window_)) return false;
        }
        return SDL_SetWindowPosition(
                       window_,
                       int(SDL_WINDOWPOS_CENTERED_DISPLAY(display)),
                       int(SDL_WINDOWPOS_CENTERED_DISPLAY(display))
               )
               && SDL_SyncWindow(window_);
    }

    bool set_exclusive(const ExclusiveTarget &target) {
        SDL_SetWindowBordered(window_, true);
        const auto mode = exclusive_mode(target.mode);
        if (!mode) return false;
        if (!move_to_display(mode->displayID)) return false;
        if (!SDL_SetWindowFullscreenMode(window_, &*mode) || !SDL_SetWindowFullscreen(window_, true)) return false;
        if (!SDL_SyncWindow(window_)) return false;
        request_display_scaling(window_, target.scaling == "bars" ? DisplayScaling::bars : DisplayScaling::stretch);
        return true;
    }

    static ExclusiveTarget exclusive_target(const WindowJson &settings) {
        return {fullscreen_mode_setting(settings), fullscreen_scaling_setting(settings)};
    }

    // Windows borderless: the display the window is on, one row taller (see set_mode).
    std::optional<SDL_Rect> borderless_rect() const {
        SDL_Rect r{};
        if (!SDL_GetDisplayBounds(SDL_GetDisplayForWindow(window_), &r)) return std::nullopt;
        r.h += 1;
        return r;
    }

    bool restore_bounds(WindowBounds b, bool requirePosition = false) {
        b = clamp_window_bounds(b, areas());
        if (!SDL_RestoreWindow(window_) || !SDL_SetWindowSize(window_, b.width, b.height)) return false;
        // Some compositors (notably Wayland) own placement: failure to position does
        // not make a valid resize/fullscreen change fail. Keep size restoration useful.
        if (!SDL_SetWindowPosition(window_, b.x, b.y) && requirePosition) return false;
        normal_ = b;
        if (b.maximized) return SDL_MaximizeWindow(window_);
        return true;
    }

public:
    explicit WindowController(SDL_Window *window) : window_(window) {
        observe_bounds();
        desired_ = mode();
    }

    bool is_minimized() const { return (SDL_GetWindowFlags(window_) & SDL_WINDOW_MINIMIZED) != 0; }

    const std::string &error() const { return error_; }

    std::string mode() const {
        const auto flags = SDL_GetWindowFlags(window_);
        if (!(flags & SDL_WINDOW_FULLSCREEN)) return flags & SDL_WINDOW_BORDERLESS ? "borderless" : "windowed";
        return SDL_GetWindowFullscreenMode(window_) ? "fullscreen" : "borderless";
    }

    bool
    apply(const WindowJson &settings, bool restore = false, const std::optional<WindowBounds> &saved = std::nullopt) {
        const auto requested = settings.value("windowMode", std::string("windowed"));
        if (!valid_window_mode(requested)) {
            error_ = "Invalid window mode";
            return false;
        }
        error_.clear();
        const auto old = mode();
        const bool oldTop = bool(SDL_GetWindowFlags(window_) & SDL_WINDOW_ALWAYS_ON_TOP);
        if (old == "windowed") observe_bounds();
        const auto oldNormal = normal_;
        const bool remember = settings.value("rememberWindowBounds", true);
        // Launching into borderless/fullscreen: place the window at its saved bounds
        // first, so it fills the display it was last on and returns there when windowed.
        if (restore && saved && remember && requested != "windowed" && old == "windowed") {
            if (!restore_bounds(*saved) || !SDL_SyncWindow(window_)) {
                error_ = SDL_GetError();
                return false;
            }
        }
        const auto oldExclusive = exclusive_;
        const auto wantExclusive = exclusive_target(settings);
        const bool changed = old != requested || (requested == "fullscreen" && wantExclusive != exclusive_);
        bool ok = true;
        if (changed) ok = set_mode(requested, wantExclusive);
        if (ok && changed && requested == "fullscreen") exclusive_ = wantExclusive;
        if (ok && changed) ok = SDL_SyncWindow(window_);
        if (ok) ok = SDL_SetWindowAlwaysOnTop(window_, settings.value("alwaysOnTop", false));
        // Back to windowed: this session's last windowed bounds (saved ones only when
        // remembered). Leaving borderless otherwise keeps a display-sized window whose
        // title bar is above the screen, which can't be moved.
        if (ok && requested == "windowed" && (changed || restore)) {
            const auto bounds = restore && saved && remember ? saved : normal_;
            if (bounds) ok = restore_bounds(*bounds);
        }
        if (!ok) {
            error_ = SDL_GetError();
            if (error_.empty()) error_ = "The window manager rejected this display mode";
            set_mode(old, oldExclusive);
            exclusive_ = oldExclusive;
            SDL_SetWindowAlwaysOnTop(window_, oldTop);
            normal_ = oldNormal;
            if (old == "windowed" && oldNormal) restore_bounds(*oldNormal);
            desired_ = old;
            return false;
        }
        desired_ = requested;
        return true;
    }

    std::optional<WindowBounds> observe_bounds() {
        const auto flags = SDL_GetWindowFlags(window_);
        if (desired_ != "windowed" || flags & (SDL_WINDOW_FULLSCREEN | SDL_WINDOW_MINIMIZED)) return std::nullopt;
        if (flags & SDL_WINDOW_MAXIMIZED) {
            if (normal_) {
                auto b = *normal_;
                b.maximized = true;
                return b;
            }
            return std::nullopt;
        }
        WindowBounds b;
        if (!SDL_GetWindowPosition(window_, &b.x, &b.y) || !SDL_GetWindowSize(window_, &b.width, &b.height))
            return std::nullopt;
        if (b.width < 240 || b.height < 240) return std::nullopt;
        normal_ = b;
        return b;
    }

    // Windows borderless follows its display's size: a resolution, scale or monitor
    // change re-fits it. Other modes are SDL's own fullscreen and follow by themselves.
    bool refit() {
#ifdef _WIN32
        if (mode() != "borderless" || (SDL_GetWindowFlags(window_) & SDL_WINDOW_MINIMIZED)) return false;
        const auto r = borderless_rect();
        SDL_Rect now{};
        if (!r || !SDL_GetWindowPosition(window_, &now.x, &now.y) || !SDL_GetWindowSize(window_, &now.w, &now.h))
            return false;
        if (now.x == r->x && now.y == r->y && now.w == r->w && now.h == r->h) return false;
        return SDL_SetWindowSize(window_, r->w, r->h) && SDL_SetWindowPosition(window_, r->x, r->y);
#else
        return false;
#endif
    }

    // The bounds to save while not windowed: the last windowed ones.
    std::optional<WindowBounds> saved_bounds() {
        if (auto bounds = observe_bounds()) return bounds;
        return normal_;
    }

    bool center() {
        error_.clear();
        if (mode() != "windowed") {
            error_ = "Centering is available in windowed mode";
            return false;
        }
        WindowBounds b;
        if (!SDL_GetWindowSize(window_, &b.width, &b.height)) {
            error_ = SDL_GetError();
            return false;
        }
        const auto display = SDL_GetDisplayForWindow(window_);
        SDL_Rect area{};
        if (!SDL_GetDisplayUsableBounds(display, &area)) {
            error_ = SDL_GetError();
            return false;
        }
        b.width = std::min(b.width, area.w);
        b.height = std::min(b.height, area.h);
        b.x = area.x + (area.w - b.width) / 2;
        b.y = area.y + (area.h - b.height) / 2;
        const bool ok = restore_bounds(b, true);
        if (!ok) error_ = SDL_GetError();
        return ok;
    }

    bool minimize() {
        error_.clear();
        const bool ok = SDL_MinimizeWindow(window_);
        if (!ok) error_ = SDL_GetError();
        return ok;
    }

    bool maximize() {
        error_.clear();
        if (mode() != "windowed") {
            error_ = "Maximize is available in windowed mode";
            return false;
        }
        const bool maximized = bool(SDL_GetWindowFlags(window_) & SDL_WINDOW_MAXIMIZED);
        if (!maximized) observe_bounds();
        const bool ok = maximized ? SDL_RestoreWindow(window_) : SDL_MaximizeWindow(window_);
        if (!ok) error_ = SDL_GetError();
        return ok;
    }

    bool focus_lost(const WindowJson &settings) {
        if (!settings.value("minimizeOnFocusLoss", false) || mode() == "windowed") return false;
        return SDL_MinimizeWindow(window_);
    }
};
}  // namespace native
