#pragma once
#include <SDL3/SDL.h>

namespace native {

// Bordered windows ask the desktop compositor to draw their frame. Borderless and fullscreen windows disable
// non-client rendering. What the compositor reports goes in the log when it changes.
#ifdef _WIN32
void sync_window_frame(SDL_Window *window);
#else
inline void sync_window_frame(SDL_Window *) {
}
#endif

}  // namespace native
