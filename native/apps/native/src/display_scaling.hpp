#pragma once
#include <SDL3/SDL.h>

namespace native {

// How a fullscreen resolution of another shape than the monitor (1280×960 on a 16:9 screen) fills it.
enum class DisplayScaling { stretch, bars };

// Asks Windows to scale the current exclusive mode this way, for this mode change only. Drivers may ignore it:
// NVIDIA and AMD follow their own scaling setting when it is set to override applications. Black bars can't be
// requested this way (Windows offers stretch, centre or the driver's default), so they leave the default.
// Returns whether Windows took the request. Elsewhere the monitor or the driver decides, and this returns false.
#ifdef _WIN32
bool request_display_scaling(SDL_Window *window, DisplayScaling scaling);
#else
inline bool request_display_scaling(SDL_Window *, DisplayScaling) {
    return false;
}
#endif

}  // namespace native
