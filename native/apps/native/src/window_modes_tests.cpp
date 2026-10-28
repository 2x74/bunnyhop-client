#include "window_modes.hpp"
#include <cassert>
#include <string>
#include <vector>

// Every window-mode transition the client makes, as a model of what the window
// shows and when a change is applied or waits. The Window below is driven the
// way WindowModeDriver (window_mode_driver.hpp) drives the SDL window.

namespace {

using native::WindowModePolicy;

const std::vector<std::string> modes{"windowed", "borderless", "fullscreen"};

struct Window {
    WindowModePolicy policy;
    std::string shown;
    bool on_top = false;
    int applies = 0;

    explicit Window(const std::string& chosen, bool menu = true) : policy(chosen) {
        policy.menu_open = menu;
        sync();
    }

    void sync() {
        if (!policy.request())
            return;
        const auto want = policy.effective({{"windowMode", policy.chosen}, {"alwaysOnTop", true}});
        if (want["windowMode"] != shown) {
            shown = want["windowMode"];
            ++applies;
        }
        on_top = want["alwaysOnTop"];
    }

    void menu(bool open, bool from_focus_loss = false) {
        policy.menu_open = open;
        if (from_focus_loss)
            policy.pending = true;
        else
            sync();
    }

    void focus_lost(bool minimized) {
        policy.minimized = minimized;
        menu(true, true);
    }

    void resumed() {
        if (policy.resume())
            sync();
    }

    void choose(const std::string& mode) {
        policy.choose(mode);
        sync();
    }

    void alt_enter() {
        choose(policy.alt_enter_target());
    }
};

void presentation() {
    // Exclusive fullscreen never shows under the open menu, and the menu never
    // shares the screen with an always-on-top window.
    for (const auto& mode : modes) {
        for (bool menu : {false, true}) {
            WindowModePolicy policy(mode);
            policy.menu_open = menu;
            const auto e = policy.effective({{"windowMode", "windowed"}, {"alwaysOnTop", true}});
            assert(e["windowMode"] == (menu && mode == "fullscreen" ? "borderless" : mode));
            assert(e["alwaysOnTop"] == !menu);
            assert(policy.chosen == mode);
        }
    }
}

void launch() {
    // The home menu is open at launch, so a saved fullscreen starts borderless.
    for (const auto& mode : modes) {
        Window w(mode);
        assert(w.shown == (mode == "fullscreen" ? "borderless" : mode));
    }
    // --windowed recovery replaces the saved mode before the policy starts.
    Window recovered("windowed");
    assert(recovered.shown == "windowed");
    assert(recovered.policy.last_fullscreen == "borderless");
}

void esc_menu() {
    for (const auto& mode : modes) {
        Window w(mode, false);
        assert(w.shown == mode);
        w.menu(true);
        assert(w.shown != "fullscreen");
        assert(!w.on_top);
        w.menu(false);
        assert(w.shown == mode);
        assert(w.on_top);
        const int before = w.applies;
        w.menu(false);
        assert(w.applies == before);
    }
    // Windowed and borderless never change mode for the menu.
    for (const std::string mode : {"windowed", "borderless"}) {
        Window w(mode, false);
        const int before = w.applies;
        w.menu(true);
        w.menu(false);
        assert(w.applies == before);
    }
}

void alt_enter() {
    {
        Window w("windowed", false);
        w.alt_enter();
        assert(w.policy.chosen == "borderless" && w.shown == "borderless");
        w.alt_enter();
        assert(w.shown == "windowed");
    }
    {
        // Back to exclusive fullscreen, not borderless.
        Window w("fullscreen", false);
        w.alt_enter();
        assert(w.shown == "windowed");
        w.alt_enter();
        assert(w.policy.chosen == "fullscreen" && w.shown == "fullscreen");
        // From the open menu it can't put exclusive fullscreen under the menu.
        w.menu(true);
        w.alt_enter();
        assert(w.shown == "windowed");
        w.alt_enter();
        assert(w.policy.chosen == "fullscreen" && w.shown == "borderless");
        w.menu(false);
        assert(w.shown == "fullscreen");
    }
    {
        // The target follows the last non-windowed mode chosen in Settings.
        Window w("windowed", false);
        w.choose("fullscreen");
        w.choose("windowed");
        w.alt_enter();
        assert(w.policy.chosen == "fullscreen");
        w.choose("borderless");
        w.alt_enter();
        w.alt_enter();
        assert(w.policy.chosen == "borderless");
    }
}

void settings() {
    // Choosing fullscreen in the open menu stays borderless until the menu closes.
    Window w("windowed");
    w.choose("fullscreen");
    assert(w.shown == "borderless");
    w.menu(false);
    assert(w.shown == "fullscreen");
}

void focus_and_minimize() {
    {
        // Alt+Tab out of exclusive fullscreen: SDL minimizes it. The menu opens
        // but the mode waits, so the window is not restored over the other app.
        Window w("fullscreen", false);
        const int before = w.applies;
        w.focus_lost(true);
        assert(w.policy.menu_open && w.shown == "fullscreen" && w.applies == before && w.policy.pending);
        w.resumed();
        assert(w.shown == "borderless" && !w.policy.pending && !w.policy.minimized);
        w.menu(false);
        assert(w.shown == "fullscreen");
    }
    {
        // Restored from the taskbar, then focused: applied once.
        Window w("fullscreen", false);
        w.focus_lost(true);
        w.resumed();
        assert(w.shown == "borderless");
        const int before = w.applies;
        w.resumed();
        assert(w.applies == before);
    }
    {
        // Focus lost without minimizing (another monitor): still waits for focus.
        Window w("fullscreen", false);
        w.focus_lost(false);
        assert(w.shown == "fullscreen");
        w.resumed();
        assert(w.shown == "borderless");
    }
    {
        // A minimized window takes no change, even an explicit one, until it returns.
        Window w("borderless", false);
        w.policy.minimized = true;
        w.choose("windowed");
        assert(w.shown == "borderless" && w.policy.pending);
        w.resumed();
        assert(w.shown == "windowed");
    }
    // Windowed or borderless: the menu opens, nothing to change.
    for (const std::string mode : {"windowed", "borderless"}) {
        Window w(mode, false);
        const int before = w.applies;
        w.focus_lost(false);
        w.resumed();
        assert(w.applies == before && w.shown == mode);
    }
}

void invalid_modes() {
    WindowModePolicy policy("fullscreen");
    policy.choose("exclusive");
    assert(policy.chosen == "fullscreen");
    WindowModePolicy fallback("bogus");
    assert(fallback.chosen == "windowed");
}

}

int main() {
    presentation();
    launch();
    esc_menu();
    alt_enter();
    settings();
    focus_and_minimize();
    invalid_modes();
}
