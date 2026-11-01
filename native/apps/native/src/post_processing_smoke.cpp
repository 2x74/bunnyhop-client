#include "gfx.hpp"
#include "graphics_settings.hpp"
#include "native_math.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <deque>
#include <iostream>
#include <memory>
#include <numeric>

namespace native {
#include "source_hdr.hpp"
#include "enhanced_look.hpp"
}  // namespace native

namespace {
using namespace native;
constexpr int width = 32, height = 20;
constexpr uint64_t timeout_ns = 5'000'000'000;

void require(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}

void complete(gfx::Context &context) {
    auto fence = context.signal();
    const auto state = context.wait(fence, timeout_ns, true);
    context.destroy(fence);
    require(state == gfx::Wait::ready, "Postprocessing GPU work did not complete");
}

void exposure(gfx::Context &context) {
    auto output = context.create_target({width, height});
    SourceHdr hdr(context, 4);
    constexpr double dt = .13;
    float expected = 1;
    for (int frame = 0; frame < 24; ++frame) {
        // Resize and toggle MSAA/bloom while the exposure readback ring wraps.
        const int scene_width = frame % 2 ? width : width / 2;
        hdr.samples(frame % 2 ? 4 : 0);
        hdr.bloom = frame % 3 != 0;
        hdr.begin(scene_width, height);
        context.clear_color({0, 0, 0, 1});
        hdr.finish(output, scene_width, height, dt);
        if (frame > 0) expected *= std::exp2(std::log2(2.f / expected) * float(1.2f * dt));
        require(std::abs(hdr.current_exposure() - expected) < 1e-6f, "Exposure readback cadence changed");
        complete(context);
    }
    require(hdr.current_exposure() > 1.9f, "Dark scene exposure did not adapt");
    for (int frame = 0; frame < 48; ++frame) {
        hdr.begin(width, height);
        context.clear_color({1, 1, 1, 1});
        hdr.finish(output, width, height, dt);
        complete(context);
    }
    require(hdr.current_exposure() < .7f, "Bright scene exposure did not adapt");
    hdr.reset();
    require(hdr.current_exposure() == 1, "Exposure reset changed");
    context.destroy(output);
}

void enhanced(gfx::Context &context) {
    auto output = context.create_target({width, height});
    SourceHdr hdr(context, 4);
    EnhancedLook look(context, 4);
    LookFrame frame;
    frame.contact_strength = .22f;
    frame.bloom_strength = .4f;
    for (int mode = 0; mode < 8; ++mode) {
        const int scene_width = mode % 2 ? width : width / 2;
        look.samples(mode % 2 ? 4 : 0);
        frame.spatial_aa = mode % 3 != 0;
        look.begin(scene_width, height);
        context.depth_write(true);
        context.clear_color({.25f, .5f, .75f, 1});
        context.clear_depth();
        look.refraction_source();
        look.finish(output, frame, mode < 4 ? &hdr : nullptr, .13);
        complete(context);
    }
    context.destroy(output);
}
}  // namespace

int main(int argc, char **argv) {
#if defined(_WIN32)
    if (argc > 1 && std::string_view(argv[1]) == "--warp") {
        try {
            auto device = gfx::D3D11Context::warp();
            gfx::Context context(*device);
            exposure(context);
            enhanced(context);
            context.check_error("Postprocessing D3D11 error");
            std::cout << "WARP exposure ring, resize, MSAA and Enhanced checks passed\n";
            return 0;
        } catch (const std::exception &error) {
            std::cerr << error.what() << '\n';
            return 1;
        }
    }
#else
    (void)argc;
    (void)argv;
#endif
    SDL_SetHint(SDL_HINT_MAC_BACKGROUND_APP, "1");
    if (!SDL_Init(SDL_INIT_VIDEO)) return 77;

    struct Sdl {
        ~Sdl() { SDL_Quit(); }
    } sdl;

    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
    const std::unique_ptr<SDL_Window, decltype(&SDL_DestroyWindow)> window(
            SDL_CreateWindow("Postprocessing offscreen check", width, height, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN),
            SDL_DestroyWindow
    );
    if (!window) return 77;

    struct GlContext {
        SDL_GLContext value;

        ~GlContext() { SDL_GL_DestroyContext(value); }
    } gl_context{SDL_GL_CreateContext(window.get())};

    if (!gl_context.value) return 77;
    native::Gl gl;
    try {
        gl.load();
    } catch (const std::exception &error) {
        // CI runners without a GPU only offer OpenGL 1.1, which can't run the renderer at all.
        std::cerr << error.what() << '\n';
        return 77;
    }
    try {
        gfx::Context context(gl);
        exposure(context);
        enhanced(context);
        context.check_error("Postprocessing GL error");
        std::cout << "Exposure ring, resizing, MSAA and Enhanced postprocessing checks passed\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
