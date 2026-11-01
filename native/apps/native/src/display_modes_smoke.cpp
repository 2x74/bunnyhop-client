#include "smoke_graphics.hpp"
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
    native::gfx::Context &graphics_;
    native::gfx::TargetView prior_;
    native::gfx::RenderTarget target_;

public:
    Target(native::gfx::Context &graphics, int width, int height)
        : graphics_(graphics)
        , prior_(graphics.current_target())
        , target_(graphics.create_target(
                  {width, height, native::gfx::Format::rgba8, native::gfx::Format::depth24_stencil8}
          )) {
        graphics_.bind_target(target_);
    }

    ~Target() {
        graphics_.bind_target(prior_);
        graphics_.destroy(target_);
    }
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
        native::gfx::Context &gl,
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
    gl.check_error("Display fixture");
    renderer.screenshot((output / (std::string(shot.name) + ".ppm")).string(), shot.width, shot.height);
}

}  // namespace

int main(int argc, char **argv) {
    try {
        if (argc != 5) throw std::runtime_error("usage: display-modes-smoke MAP CONTENT_ROOT ASSETS OUTPUT_DIRECTORY");
        if (!SDL_Init(SDL_INIT_VIDEO)) throw std::runtime_error(SDL_GetError());
        native::SmokeGraphics surface(640, 360);
        auto &graphics = surface.context();
        std::unique_ptr<BhContext, decltype(&bh_destroy)> core(bh_create(), &bh_destroy);
        if (!core || !bh_load_map(core.get(), argv[1], argv[2]))
            throw std::runtime_error(core ? bh_last_error(core.get()) : "No core");
        BhSnapshot spawn{};
        bh_snapshot(core.get(), &spawn);
        const std::filesystem::path output(argv[4]);
        std::filesystem::create_directories(output);
        {
            const auto renderer_storage = std::make_unique<native::Renderer>(graphics, core.get());
            auto &renderer = *renderer_storage;
            renderer.set_viewmodel_visible(false);
            auto &hud_graphics = graphics;
            native::NativeHud hud(hud_graphics, argv[3]);
            hud.preferences(native::default_settings());
            for (const auto &shot : cases)
                render_case(graphics, renderer, hud, spawn, shot, output);
        }
        std::cout << std::size(cases) << " display fixtures; GL_NO_ERROR\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
