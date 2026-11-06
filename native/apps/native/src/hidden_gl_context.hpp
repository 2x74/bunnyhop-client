#pragma once

namespace native {
// SDL creates/destroys windows and contexts on the main thread; a worker only binds its own context.
class HiddenGlContext {
    SDL_Window *window_ = nullptr;
    SDL_GLContext context_ = nullptr;

public:
    explicit HiddenGlContext(bool shared) {
        auto *previous_window = SDL_GL_GetCurrentWindow();
        const auto previous_context = SDL_GL_GetCurrentContext();
        int previous_share = 0;
        SDL_GL_GetAttribute(SDL_GL_SHARE_WITH_CURRENT_CONTEXT, &previous_share);
        SDL_GL_SetAttribute(SDL_GL_SHARE_WITH_CURRENT_CONTEXT, shared ? 1 : 0);
        window_ = SDL_CreateWindow("Cosmetic renderer", 32, 32, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
        if (window_) context_ = SDL_GL_CreateContext(window_);
        SDL_GL_SetAttribute(SDL_GL_SHARE_WITH_CURRENT_CONTEXT, previous_share);
        const bool restored = SDL_GL_MakeCurrent(previous_window, previous_context);
        if (!window_ || !context_ || !restored) {
            if (context_) SDL_GL_DestroyContext(context_);
            if (window_) SDL_DestroyWindow(window_);
            throw std::runtime_error("Could not create the cosmetic GL context");
        }
    }

    ~HiddenGlContext() {
        SDL_GL_DestroyContext(context_);
        SDL_DestroyWindow(window_);
    }

    HiddenGlContext(const HiddenGlContext &) = delete;
    HiddenGlContext &operator=(const HiddenGlContext &) = delete;

    void bind() {
        if (SDL_GL_GetCurrentContext() == context_) return;
        if (!SDL_GL_MakeCurrent(window_, context_)) throw std::runtime_error(SDL_GetError());
    }

    void bind_for_cleanup() noexcept { SDL_GL_MakeCurrent(window_, context_); }

    void unbind() { SDL_GL_MakeCurrent(window_, nullptr); }
};
}  // namespace native
