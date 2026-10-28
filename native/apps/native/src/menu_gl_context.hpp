#pragma once
#include <SDL3/SDL.h>
#include <exception>
#include <stdexcept>
#include <string>

namespace native {
// Main-thread GTK scopes only. The caller owns the SDL window/context and must
// keep both alive until the scope ends (including while GTK dispatches signals).
// Never cache a context in the menu: it may outlive the renderer's context.
class GlContextRelease {
public:
    GlContextRelease() : window_(SDL_GL_GetCurrentWindow()), context_(SDL_GL_GetCurrentContext()) {
        // Nested GTK calls see SDL's cleared TLS and leave restoration to the
        // outer scope. Detach through SDL so its MakeCurrent fast path cannot
        // mistake a GTK/EGL context for the still-current renderer context.
        if (context_ && !SDL_GL_MakeCurrent(nullptr, nullptr))
            throw std::runtime_error(std::string("Releasing SDL OpenGL context for GTK failed: ") + SDL_GetError());
    }

    ~GlContextRelease() noexcept {
        if (context_ && !SDL_GL_MakeCurrent(window_, context_)) {
            // Rendering cannot safely resume after a failed restore. Report the
            // SDL error even during exception unwinding; never silently continue
            // or throw a second exception from this cleanup path.
            SDL_LogCritical(
                    SDL_LOG_CATEGORY_VIDEO, "Restoring SDL OpenGL context after GTK failed: %s", SDL_GetError()
            );
            std::terminate();
        }
    }

    GlContextRelease(const GlContextRelease &) = delete;
    GlContextRelease &operator=(const GlContextRelease &) = delete;

private:
    SDL_Window *window_;
    SDL_GLContext context_;
};
}  // namespace native
