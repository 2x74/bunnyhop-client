#pragma once
#include "gfx.hpp"
#include "low_latency.hpp"
#include "renderer_choice.hpp"
#include <memory>
#include <stdexcept>
#include <string>

namespace native {
class ClientGraphics {
    SDL_Window *window_;
    Gl gl_;
    LowLatencyPresenter presenter_;
#if defined(_WIN32)
    std::unique_ptr<gfx::D3D11Context> d3d11_;
#endif
    std::unique_ptr<gfx::Context> context_;

    void check_presenter() const {
        if (presenter_.failed())
            throw std::runtime_error("D3D11 stopped: " + presenter_.error() + ". Restart the game with OpenGL.");
    }

public:
    ClientGraphics(SDL_Window *window, gfx::Backend backend, bool warp = false) : window_(window) {
#ifdef _WIN32
        if (backend == gfx::Backend::d3d11) {
            if (!presenter_.initialize_native(window, warp)) throw std::runtime_error(presenter_.error());
            d3d11_ = std::make_unique<gfx::D3D11Context>(
                    gfx::D3D11Device{presenter_.device(), presenter_.immediate_context()}
            );
            context_ = std::make_unique<gfx::Context>(*d3d11_);
            begin();
            return;
        }
#else
        (void)backend;
        (void)warp;
#endif
        gl_.load();
        context_ = std::make_unique<gfx::Context>(gl_);
    }

    Gl &gl() { return gl_; }

    gfx::Context &context() { return *context_; }

    LowLatencyPresenter &presenter() { return presenter_; }

    const char *name() const { return renderer_name(context_->backend()); }

    std::string adapter() {
        if (presenter_.native_mode()) return presenter_.adapter_description();
        const auto *name = gl_.GetString(GL_RENDERER);
        return name ? reinterpret_cast<const char *>(name) : "";
    }

    std::string description() {
        if (presenter_.native_mode()) return adapter() + ", D3D11";
        const auto *version = gl_.GetString(GL_VERSION);
        return adapter() + ", OpenGL " + (version ? reinterpret_cast<const char *>(version) : "unknown");
    }

    void swap_interval(bool vsync) {
        if (!presenter_.native_mode()) SDL_GL_SetSwapInterval(vsync ? 1 : 0);
    }

    void begin() {
        int width = 0, height = 0;
        SDL_GetWindowSizeInPixels(window_, &width, &height);
        presenter_.render_start(width, height);
        check_presenter();
        if (!presenter_.native_mode()) return;
        context_->reset_state();
        const auto target = presenter_.native_target();
        context_->prepare_color_copy(target);
        context_->bind_target(target);
        context_->viewport({0, 0, width, height});
    }

    void present(bool vsync) {
        context_->check_error("Rendering frame");
        if (presenter_.active()) {
            presenter_.present(vsync);
            check_presenter();
            if (presenter_.native_mode()) context_->reset_state();
        } else if (!SDL_GL_SwapWindow(window_)) {
            throw std::runtime_error(std::string("Swapping framebuffer failed: ") + SDL_GetError());
        }
    }
};
}  // namespace native
