#pragma once
#include "window_modes.hpp"
#include "window_sdl.hpp"
#include <functional>
#include <iostream>
#include <optional>
#include <string>
#include <utility>

namespace native {

// Applies WindowModePolicy to the SDL window for client.cpp: launch, the Esc
// menu, focus and minimize events, settings changes and Alt+Enter.
template <class Controller>
class BasicWindowModeDriver {
public:
    BasicWindowModeDriver(Controller &controller, const std::string &chosen)
        : controller_(controller)
        , policy_(chosen) {}

    const WindowModePolicy &policy() const { return policy_; }

    // Whether the window shows `mode` ("windowed", "borderless" or "fullscreen") right now.
    bool shows(const std::string &mode) const { return controller_.mode() == mode; }

    // Told what the window is about to show before each change, and when a change didn't happen (display_check.hpp).
    struct Listener {
        std::function<void(const WindowJson &shown)> before_show;
        std::function<void()> not_shown;
    };

    void listen(Listener listener) { listener_ = std::move(listener); }

    // Launch opens the home menu (when there is one), so start as it will be shown. A borderless or fullscreen
    // window the system refuses starts windowed instead (take_fallback).
    bool launch(const WindowJson &preferences, bool menu, const std::optional<WindowBounds> &saved) {
        policy_.menu_open = menu;
        return show_or_windowed(policy_.effective(preferences), true, saved);
    }

    // Shows what the policy wants, unless the window is minimized. A switch to borderless or fullscreen that fails
    // (the menu closing over exclusive fullscreen, a resumed window) goes back to windowed.
    void sync(const WindowJson &preferences) {
        policy_.minimized = policy_.minimized || controller_.is_minimized();
        if (!policy_.request()) return;
        show_or_windowed(policy_.effective(preferences));
    }

    // The window went back to windowed after a failed switch. True once per fallback, for the caller to save
    // windowed and tell the player.
    bool take_fallback() { return std::exchange(fell_back_, false); }

    // The mode shown doesn't present frames (display_check.hpp): windowed now, whatever was chosen.
    void fall_back(WindowJson preferences) {
        preferences["windowMode"] = "windowed";
        policy_.choose("windowed");
        policy_.pending = false;
        policy_.waiting_for_focus = false;
        show(policy_.effective(preferences));
    }

    // The Esc menu opened or closed. When focus loss opened it, the mode change
    // waits until the window has focus again.
    void set_menu(bool open, bool from_focus_loss, const WindowJson &preferences) {
        policy_.menu_open = open;
        if (from_focus_loss) {
            policy_.waiting_for_focus = true;
            policy_.pending = true;
        } else
            sync(preferences);
    }

    void focus_lost(bool minimized) { policy_.minimized = minimized; }

    void minimized() { policy_.minimized = true; }

    // Focus gained or the window restored.
    void resumed(const WindowJson &preferences) {
        if (controller_.is_minimized()) return;
        if (policy_.resume()) sync(preferences);
        if (pending_refit_) {
            pending_refit_ = false;
            controller_.refit();
        }
    }

    // `preferences` with its windowMode applied (a settings change). The result
    // is what to keep; nullopt when the window manager refused (controller error()).
    std::optional<WindowJson> choose(const WindowJson &preferences) {
        auto next = policy_;
        next.minimized = next.minimized || controller_.is_minimized();
        next.choose(preferences.value("windowMode", std::string("windowed")));
        if (!next.request()) {
            policy_ = next;
            return preferences;
        }
        if (!show(next.effective(preferences))) {
            // The controller put the previous mode back, which was showing.
            if (listener_.not_shown) listener_.not_shown();
            return std::nullopt;
        }
        policy_ = next;
        return preferences;
    }

    // Alt+Enter and the menu's fullscreen toggle.
    std::optional<WindowJson> toggle(WindowJson preferences) {
        preferences["windowMode"] = policy_.alt_enter_target();
        return choose(preferences);
    }

    // Windows borderless follows its display after a resolution, scale or monitor change.
    void display_changed() {
        if (policy_.minimized || controller_.is_minimized() || policy_.waiting_for_focus) {
            pending_refit_ = true;
            return;
        }
        controller_.refit();
    }

private:
    Controller &controller_;
    bool pending_refit_ = false;
    bool fell_back_ = false;
    WindowModePolicy policy_;
    Listener listener_;

    bool show(const WindowJson &want, bool restore = false, const std::optional<WindowBounds> &saved = std::nullopt) {
        if (listener_.before_show) listener_.before_show(want);
        return controller_.apply(want, restore, saved);
    }

    bool show_or_windowed(
            const WindowJson &want, bool restore = false, const std::optional<WindowBounds> &saved = std::nullopt
    ) {
        if (show(want, restore, saved)) return true;
        std::cerr << "Window: " << controller_.error() << '\n';
        if (want.value("windowMode", std::string("windowed")) == "windowed") {
            policy_.choose(controller_.mode());
            return false;
        }
        WindowJson windowed = want;
        windowed["windowMode"] = "windowed";
        policy_.choose("windowed");
        if (!show(windowed, restore, saved)) std::cerr << "Window: " << controller_.error() << '\n';
        fell_back_ = true;
        return false;
    }
};

using WindowModeDriver = BasicWindowModeDriver<WindowController>;
}  // namespace native
