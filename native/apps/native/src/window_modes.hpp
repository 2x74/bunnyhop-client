#pragma once
#include "window_settings.hpp"
#include <string>

namespace native {

// Which display mode the game window shows. The player chooses windowed,
// borderless or exclusive fullscreen; what is shown also depends on the menu
// and on the window state. window_modes_tests.cpp models every transition.
//
// - The menu (a WebView2/WKWebView child, or GTK's separate window) is drawn by
//   the desktop compositor, which exclusive fullscreen bypasses. While it is
//   open, "fullscreen" is shown as borderless and never always-on-top.
// - A minimized window is left alone. SDL minimizes exclusive fullscreen when it
//   loses focus (Alt+Tab); changing its mode then would restore it and pull it
//   back over the other app. The change waits until the window comes back.
// - Alt+Enter goes from windowed to the last non-windowed mode the player chose
//   (borderless if none), and from either of those back to windowed.
struct WindowModePolicy {
    std::string chosen = "windowed";
    std::string last_fullscreen = "borderless";
    bool menu_open = false;
    bool minimized = false;
    bool pending = false;
    bool waiting_for_focus = false;

    explicit WindowModePolicy(const std::string& mode = "windowed") {
        choose(mode);
    }

    void choose(const std::string& mode) {
        if (!valid_window_mode(mode))
            return;
        chosen = mode;
        if (mode != "windowed")
            last_fullscreen = mode;
    }

    std::string presented() const {
        if (menu_open && chosen == "fullscreen")
            return "borderless";
        return chosen;
    }

    std::string alt_enter_target() const {
        return chosen == "windowed" ? last_fullscreen : "windowed";
    }

    // The preferences as WindowController should apply them now.
    WindowJson effective(WindowJson preferences) const {
        preferences["windowMode"] = presented();
        if (menu_open)
            preferences["alwaysOnTop"] = false;
        return preferences;
    }

    // A change to what is shown: true when it may be applied now, false when
    // it waits for the window to come back.
    bool request() {
        pending = minimized || waiting_for_focus;
        return !pending;
    }

    // Focus gained or window restored: true when a waiting change should apply.
    bool resume() {
        minimized = false;
        waiting_for_focus = false;
        const bool waiting = pending;
        pending = false;
        return waiting;
    }
};

}
