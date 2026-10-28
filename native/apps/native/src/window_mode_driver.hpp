#pragma once
#include "window_modes.hpp"
#include "window_sdl.hpp"
#include <iostream>
#include <optional>
#include <string>

namespace native {

// Applies WindowModePolicy to the SDL window for client.cpp: launch, the Esc
// menu, focus and minimize events, settings changes and Alt+Enter.
template<class Controller>
class BasicWindowModeDriver {
public:
    BasicWindowModeDriver(Controller& controller, const std::string& chosen)
        : controller_(controller), policy_(chosen) {}

    const WindowModePolicy& policy() const {
        return policy_;
    }

    // Launch opens the home menu (when there is one), so start as it will be shown.
    // On failure the policy follows whatever mode the window kept.
    bool launch(const WindowJson& preferences, bool menu, const std::optional<WindowBounds>& saved) {
        policy_.menu_open = menu;
        if (controller_.apply(policy_.effective(preferences), true, saved))
            return true;
        policy_.choose(controller_.mode());
        return false;
    }

    // Shows what the policy wants, unless the window is minimized.
    void sync(const WindowJson& preferences) {
        if (!policy_.request())
            return;
        const WindowJson want = policy_.effective(preferences);
        if (controller_.mode() == want.at("windowMode").get<std::string>())
            return;
        if (!controller_.apply(want))
            std::cerr << "Window: " << controller_.error() << '\n';
    }

    // The Esc menu opened or closed. When focus loss opened it, the mode change
    // waits until the window has focus again.
    void set_menu(bool open, bool from_focus_loss, const WindowJson& preferences) {
        policy_.menu_open = open;
        if (from_focus_loss) {
            policy_.waiting_for_focus = true;
            policy_.pending = true;
        }
        else
            sync(preferences);
    }

    void focus_lost(bool minimized) {
        policy_.minimized = minimized;
    }

    void minimized() {
        policy_.minimized = true;
    }

    // Focus gained or the window restored.
    void resumed(const WindowJson& preferences) {
        if (policy_.resume())
            sync(preferences);
        if (pending_refit_) {
            pending_refit_ = false;
            controller_.refit();
        }
    }

    // `preferences` with its windowMode applied (a settings change). The result
    // is what to keep; nullopt when the window manager refused (controller error()).
    std::optional<WindowJson> choose(const WindowJson& preferences) {
        auto next = policy_;
        next.choose(preferences.value("windowMode", std::string("windowed")));
        if (!next.request()) {
            policy_ = next;
            return preferences;
        }
        if (!controller_.apply(next.effective(preferences)))
            return std::nullopt;
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
        if (policy_.minimized || policy_.waiting_for_focus) {
            pending_refit_ = true;
            return;
        }
        controller_.refit();
    }

private:
    Controller& controller_;
    bool pending_refit_ = false;
    WindowModePolicy policy_;
};

using WindowModeDriver = BasicWindowModeDriver<WindowController>;

}
