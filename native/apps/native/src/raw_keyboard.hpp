#pragma once
#include <SDL3/SDL.h>

namespace native {

// Windows: gameplay keys come from SDL's raw-input thread, stamped when read, and key-ups survive window-mode
// switches. Enabled only while playing captured. Chat (SDL text input) and the WebView menu keep the message loop, so
// IME and menu typing are unchanged: in raw mode SDL 3.4 drops key-downs while text input is active, and a WebView
// child can hold the Win32 focus while SDL still believes it has keyboard focus.
// SDL applies this hint at any time; other platforms ignore it.
inline void set_raw_keyboard(bool on) {
    SDL_SetHint(SDL_HINT_WINDOWS_RAW_KEYBOARD, on ? "1" : "0");
}

}  // namespace native
