// Offline pictures of each display shape and fit with the HUD and crosshair, for checking layouts by eye. Each
// case renders into its own framebuffer at the size the game window would have; nothing changes the real display
// mode, and nothing enters a simulation recording or a server.
#include "hud.hpp"
#include "hud_area.hpp"
#include "renderer.hpp"
#include "runner_view.hpp"
#include "settings.hpp"
#include <filesystem>
#include <iostream>

namespace {

struct Case {
    const char *name;
    int width;
    int height;
    const char *aspect;
    const char *fit;
};

// Window sizes in pixels: a 1920×1080 monitor in borderless, or the exclusive mode's own size.
constexpr Case cases[] = {
        {"borderless-16x9-native", 1920, 1080, "native", "stretch"},
        {"borderless-4x3-stretched", 1920, 1080, "4:3", "stretch"},
        {"borderless-4x3-bars", 1920, 1080, "4:3", "bars"},
        {"borderless-16x10-bars", 1920, 1080, "16:10", "bars"},
        {"exclusive-1280x960", 1280, 960, "native", "stretch"},
        {"exclusive-1024x768", 1024, 768, "native", "stretch"},
        {"exclusive-1680x1050", 1680, 1050, "native", "stretch"},
};

class Target {
public:
    Target(native::Gl &gl, int width, int height) : gl_(gl) {
        gl_.GenFramebuffers(1, &framebuffer_);
        gl_.GenRenderbuffers(1, &color_);
        gl_.GenRenderbuffers(1, &depth_);
        gl_.BindRenderbuffer(GL_RENDERBUFFER, color_);
        gl_.RenderbufferStorage(GL_RENDERBUFFER, GL_RGBA8, width, height);
        gl_.BindRenderbuffer(GL_RENDERBUFFER, depth_);
        gl_.RenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH24_STENCIL8, width, height);
        gl_.BindFramebuffer(GL_FRAMEBUFFER, framebuffer_);
        gl_.FramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, color_);
        gl_.FramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, depth_);
        if (gl_.CheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
            throw std::runtime_error("Smoke framebuffer incomplete");
    }

    ~Target() {
        gl_.BindFramebuffer(GL_FRAMEBUFFER, 0);
        gl_.DeleteRenderbuffers(1, &depth_);
        gl_.DeleteRenderbuffers(1, &color_);
        gl_.DeleteFramebuffers(1, &framebuffer_);
    }

    Target(const Target &) = delete;
    Target &operator=(const Target &) = delete;

private:
    native::Gl &gl_;
    GLuint framebuffer_ = 0, color_ = 0, depth_ = 0;
};

void draw_hud(native::NativeHud &hud, const BhSnapshot &spawn, int width, int height) {
    BhRunState run{};
    run.status = 1;
    run.seconds = 12.345;
    run.jumps = 17;
    run.strafes = 23;
    run.sync_percent = 91.2;
    hud.draw(width, height, spawn, run, BhCmd{}, "bhop_eazy", "autohop", "", 999, true, true, false, BhWeaponReport{});
}

void render_case(
        native::Gl &gl,
        native::Renderer &renderer,
        native::NativeHud &hud,
        const BhSnapshot &spawn,
        const Case &shot,
        const std::filesystem::path &output
) {
    auto graphics = native::default_graphics_settings();
    graphics["graphicsAntialias"] = false;
    graphics["graphicsAspect"] = shot.aspect;
    graphics["graphicsAspectFit"] = shot.fit;
    renderer.graphics_settings(graphics);
    Target target(gl, shot.width, shot.height);
    const float eye[] = {spawn.player.position[0], spawn.player.position[1], spawn.player.position[2] + 64};
    native::Input input;
    input.set_angles(5, 30);
    renderer.draw(shot.width, shot.height, eye, input, &spawn, 4);
    const auto area = native::hud_area(renderer.output_view(shot.width, shot.height), shot.width, shot.height);
    {
        native::HudViewport viewport(gl, area, shot.width, shot.height);
        draw_hud(hud, spawn, area.width, area.height);
    }
    if (gl.GetError() != GL_NO_ERROR) throw std::runtime_error(std::string("GL error in ") + shot.name);
    renderer.screenshot((output / (std::string(shot.name) + ".ppm")).string(), shot.width, shot.height);
}

}  // namespace

int main(int argc, char **argv) {
    try {
        if (argc != 5) throw std::runtime_error("usage: display-modes-smoke MAP CONTENT_ROOT ASSETS OUTPUT_DIRECTORY");
        if (!SDL_Init(SDL_INIT_VIDEO)) throw std::runtime_error(SDL_GetError());
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
        SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
        auto *window = SDL_CreateWindow("Display mode fixtures", 640, 360, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
        if (!window) throw std::runtime_error(SDL_GetError());
        const auto context = SDL_GL_CreateContext(window);
        if (!context) throw std::runtime_error(SDL_GetError());
        SDL_GL_MakeCurrent(window, context);
        native::Gl gl;
        gl.load();
        std::unique_ptr<BhContext, decltype(&bh_destroy)> core(bh_create(), &bh_destroy);
        if (!core || !bh_load_map(core.get(), argv[1], argv[2]))
            throw std::runtime_error(core ? bh_last_error(core.get()) : "No core");
        BhSnapshot spawn{};
        bh_snapshot(core.get(), &spawn);
        const std::filesystem::path output(argv[4]);
        std::filesystem::create_directories(output);
        {
            native::Renderer renderer(gl, core.get());
            renderer.set_viewmodel_visible(false);
            native::NativeHud hud(gl, argv[3]);
            hud.preferences(native::default_settings());
            for (const auto &shot : cases)
                render_case(gl, renderer, hud, spawn, shot, output);
        }
        SDL_GL_DestroyContext(context);
        SDL_DestroyWindow(window);
        SDL_Quit();
        std::cout << std::size(cases) << " display fixtures; GL_NO_ERROR\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
