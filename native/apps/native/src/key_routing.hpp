#pragma once
#include <array>
#include <cstddef>
#include <optional>

namespace native {

// Whether SDL key events belong to the game. An embedded menu (the WebView2 child window, the WKWebView subview) owns
// the keyboard while it is shown: it handles Esc itself, and Windows raw keys can still reach SDL while the child has
// focus. The separate GTK menu window doesn't share the game window's focus, so the game window keeps its keys.
inline bool game_owns_keyboard(bool menu_visible, bool menu_embedded) {
    return !(menu_visible && menu_embedded);
}

// Tells real key repeats from presses SDL mislabels as repeats.
//
// SDL marks a key-down as a repeat when its own key state still says the key is down. That state goes stale when a
// key-up never reaches SDL: released while the WebView2 menu had focus, or lost while SDL 3.4 restarts its Windows
// raw-input thread on a relative-mode toggle. The next real press then arrives with repeat set. This filter tracks
// what the game has seen since the last input barrier, so the first press after one always counts.
class KeyPresses {
public:
    static constexpr size_t kScancodes = 512;

    // Returns whether this key event is a repeat as far as the game is concerned.
    bool repeat(size_t scancode, bool down, bool sdl_repeat) {
        if (scancode >= kScancodes) {
            return sdl_repeat;
        }
        const bool was_down = down_[scancode];
        down_[scancode] = down;
        return down && sdl_repeat && was_down;
    }

    // Raw SDL events can still arrive while the embedded menu owns Win32 focus.
    // They must not seed repeat suppression for the next gameplay press.
    std::optional<bool> route(size_t scancode, bool down, bool sdl_repeat, bool owns_keyboard) {
        if (!owns_keyboard) {
            clear();
            return std::nullopt;
        }
        return repeat(scancode, down, sdl_repeat);
    }

    // An input barrier: keys released while the game wasn't listening may never report their key-up.
    void clear() { down_.fill(false); }

private:
    std::array<bool, kScancodes> down_{};
};

}  // namespace native
