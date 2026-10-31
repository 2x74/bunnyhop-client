#pragma once
#include "gfx.hpp"
#include <SDL3/SDL.h>
#include <cstdlib>
#include <memory>
#include <stdexcept>
#include <string_view>

namespace native {
// Fixtures select WARP explicitly; unsupported requests fail instead of capturing OpenGL pixels.
class SmokeGraphics {
    struct WindowDelete {
        void operator()(SDL_Window *window) const { SDL_DestroyWindow(window); }
    };

    struct ContextDelete {
        void operator()(std::remove_pointer_t<SDL_GLContext> *context) const { SDL_GL_DestroyContext(context); }
    };

    std::unique_ptr<SDL_Window, WindowDelete> window_;
    std::unique_ptr<std::remove_pointer_t<SDL_GLContext>, ContextDelete> opengl_;
    Gl gl_;
#if defined(_WIN32) || defined(BUNNYHOP_GFX_DISPATCH)
    std::unique_ptr<gfx::D3D11Context> warp_;
#endif
    std::unique_ptr<gfx::Context> graphics_;
    gfx::RenderTarget target_;

public:
    SmokeGraphics(int width, int height) {
        const char *renderer = std::getenv("BUNNYHOP_TEST_RENDERER");
        if (renderer && std::string_view(renderer) == "d3d11") {
#if defined(_WIN32)
            warp_ = gfx::D3D11Context::warp();
            graphics_ = std::make_unique<gfx::Context>(*warp_);
            target_ = graphics_->create_target({width, height, gfx::Format::rgba8, gfx::Format::depth24_stencil8});
            graphics_->bind_target(target_);
            graphics_->viewport({0, 0, width, height});
            return;
#else
            throw std::runtime_error("D3D11 fixture requires Windows");
#endif
        }
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
        SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
        window_.reset(SDL_CreateWindow("Renderer fixtures", width, height, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN));
        if (!window_) throw std::runtime_error(SDL_GetError());
        opengl_.reset(SDL_GL_CreateContext(window_.get()));
        if (!opengl_ || !SDL_GL_MakeCurrent(window_.get(), opengl_.get())) throw std::runtime_error(SDL_GetError());
        SDL_GL_SetSwapInterval(0);
        gl_.load();
        graphics_ = std::make_unique<gfx::Context>(gl_);
    }

    ~SmokeGraphics() {
        if (target_) graphics_->destroy(target_);
    }

    gfx::Context &context() { return *graphics_; }

    gfx::TargetView output(int width, int height) const {
        if (target_) return target_;
        return gfx::Context::window_target(width, height);
    }
};
}  // namespace native
