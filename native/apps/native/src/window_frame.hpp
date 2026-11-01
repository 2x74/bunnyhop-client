#pragma once
#include <SDL3/SDL.h>

namespace native {

// A bordered window asks the desktop compositor to draw its frame. Windows otherwise decides from the window's style
// and can fall back to the old theme-drawn frame, which looks like Windows 7. Borderless and fullscreen go back to that
// default, so they stay ordinary game windows. What the compositor reports goes in the log when it changes.
#ifdef _WIN32
void sync_window_frame(SDL_Window *window);
#else
inline void sync_window_frame(SDL_Window *) {
}
#endif

}  // namespace native
