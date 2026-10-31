#pragma once
#include "native_log.hpp"
#include <SDL3/SDL.h>
#include <string>

namespace native::log {

inline void SDLCALL write_sdl_output(void *userdata, int category, SDL_LogPriority priority, const char *message) {
    SDL_GetDefaultLogOutputFunction()(userdata, category, priority, message);
    try {
        write(std::string("SDL: ") + (message ? message : ""));
    } catch (...) {
    }
}

// SDL's own log lines also go to the log file.
inline void capture_sdl_output() {
    SDL_SetLogOutputFunction(write_sdl_output, nullptr);
}

}  // namespace native::log
