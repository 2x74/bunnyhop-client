#pragma once
#include "gfx_types.hpp"
#include <SDL3/SDL.h>
#include <stdexcept>

namespace native::gfx {
inline SDL_WindowFlags window_flags(Backend backend = selected_backend) {
    if (!available(backend)) throw std::runtime_error("The requested graphics backend is not built");
    return backend == Backend::opengl ? SDL_WINDOW_OPENGL : 0;
}

inline void configure_window(Backend backend = selected_backend) {
    if (!available(backend)) throw std::runtime_error("The requested graphics backend is not built");
    if (backend != Backend::opengl) return;
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS, SDL_GL_CONTEXT_FORWARD_COMPATIBLE_FLAG);
    SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);
    SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
    SDL_GL_SetAttribute(SDL_GL_STENCIL_SIZE, 8);
}
}  // namespace native::gfx
