#include "smoke_graphics.hpp"
// Offline rendering fixture. Synthetic poses never enter the simulation, recorder or a server.
#include "renderer.hpp"
#include "online.hpp"
#include "menu_backdrop.hpp"
#include "loadout_preview.hpp"

static native_render::GhostPath fixture_path(const BhSnapshot &spawn, unsigned slot) {
    native_render::GhostPath path;
    path.source = slot == 0   ? native_render::GhostSource::pb
                  : slot == 1 ? native_render::GhostSource::wr
                              : native_render::GhostSource::custom;
    path.enabled = true;
    path.interval = .01;
    path.end = 400;
    path.frames.resize(401);
    path.teleports.resize(401);
    for (size_t tick = 0; tick < path.frames.size(); ++tick) {
        auto &frame = path.frames[tick];
        frame.tick = uint32_t(tick);
        const float fraction = float(tick) / 400;
        frame.position[0] = spawn.player.position[0] + 50 + fraction * 130;
        frame.position[1] = spawn.player.position[1] + 65 + float(slot) * 75 + std::sin(fraction * 8) * 20;
        frame.position[2] = spawn.player.position[2] + 40 + std::sin(fraction * 6) * 20;
        frame.flags = 2;
        frame.weapon = 1;
        frame.yaw = 180;
        frame.view_offset_z = 64;
    }
    // An explicit short teleport catches bridging mistakes in the recorded-data renderer too.
    path.teleports[200] = 1;
    return path;
}

int main(int argc, char **argv) {
    try {
        if (argc != 4) {
            throw std::runtime_error("usage: effects-render-smoke MAP CONTENT_ROOT OUTPUT_DIRECTORY");
        }
        if (!SDL_Init(SDL_INIT_VIDEO)) {
            throw std::runtime_error(SDL_GetError());
        }

        struct Sdl {
            ~Sdl() { SDL_Quit(); }
        } sdl;

        native::SmokeGraphics surface(1280, 720);
        auto &graphics = surface.context();
        std::unique_ptr<BhContext, decltype(&bh_destroy)> core(bh_create(), &bh_destroy);
        if (!core || !bh_load_map(core.get(), argv[1], argv[2])) {
            throw std::runtime_error(core ? bh_last_error(core.get()) : "No core");
        }
        BhSettings settings{};
        bh_default_settings(&settings);
        if (!bh_set_settings(core.get(), &settings)) {
            throw std::runtime_error(bh_last_error(core.get()));
        }
        BhSnapshot spawn{};
        bh_snapshot(core.get(), &spawn);
        const auto renderer_storage = std::make_unique<native::Renderer>(graphics, core.get());
        auto &renderer = *renderer_storage;
        renderer.set_viewmodel_visible(false);
        renderer.set_zones_visible(false);
        renderer.set_ghost_cosmetics("ghost-geode", "trail-geode");
        std::vector<native_render::Actor> actors;
        for (unsigned slot = 0; slot < 3; ++slot) {
            auto path = fixture_path(spawn, slot);
            native_render::Actor actor;
            actor.id = "ghost-" + std::to_string(slot);
            actor.frame = path.frames.back();
            actor.outfit = "outfit-cream";
            actor.loadout = "2;knife-carrot;fin-garden;glove-knit";
            actor.opacity = .55f;
            renderer.set_ghost_path(slot, std::move(path));
            renderer.decorate_ghost(actor, slot);
            actors.push_back(actor);
        }
        const float eye[] = {spawn.player.position[0], spawn.player.position[1] + 125, spawn.player.position[2] + 115};
        native::Input input;
        input.set_angles(15, 0);
        const auto output = std::filesystem::path(argv[3]);
        std::filesystem::create_directories(output);
        auto preferences = native::default_graphics_settings();
        preferences["graphicsAntialias"] = false;
        preferences["ghostTrail"] = false;
        auto capture = [&](const char *name) {
            renderer.graphics_settings(preferences);
            renderer.set_room_actors(actors);
            renderer.draw(1280, 720, eye, input, &spawn, 4);
            graphics.check_error("Effect fixture");
            renderer.screenshot((output / (std::string(name) + ".ppm")).string(), 1280, 720);
            const auto png = native::target_png(graphics, graphics.current_target(), 1280, 720);
            std::ofstream file(output / (std::string(name) + ".png"), std::ios::binary);
            file.write(png.data(), std::streamsize(png.size()));
        };
        capture("ghost-colours-pb-wr-custom");
        preferences["ghostTrail"] = true;
        capture("recorded-trails");
        preferences["ghostRoute"] = true;
        preferences["ghostRouteMode"] = "path";
        capture("route-guide");
        preferences["ghostWr"] = false;
        // Model visibility is governed by the host's ghost_visible call, as in client.cpp.
        actors[1].opacity = 0;
        capture("wr-hidden");
        actors.clear();
        native_render::Actor supporter;
        supporter.id = "supporter";
        supporter.frame = fixture_path(spawn, 1).frames.back();
        supporter.outfit = "outfit-cream";
        supporter.loadout = "2;knife-carrot;fin-garden;glove-knit;;hat-halo";
        supporter.opacity = 1;
        supporter.playerGlow =
                native_render::parse_glow({{"enabled", true}, {"aura", true}, {"intensity", 1}, {"color", "violet"}});
        actors.push_back(supporter);
        preferences["ghostRoute"] = false;
        renderer.clear_ghosts();
        capture("supporter-glow");
        actors[0].playerGlow->aura = false;
        capture("supporter-outline");
        actors.clear();
        preferences.update({{"graphicsAspect", "4:3"}, {"graphicsAspectFit", "stretch"}});
        capture("graphics-4x3-stretched");
        preferences["graphicsAspectFit"] = "bars";
        capture("graphics-4x3-bars");
        preferences.update(
                {{"graphicsAspect", "native"},
                 {"graphicsAntialias", true},

                 {"graphicsBrightness", 1.2},
                 {"graphicsGamma", 1.15},
                 {"graphicsVibrance", 1.4},
                 {"graphicsResolutionScale", .75}}
        );
        capture("graphics-msaa-grade-scale");
        preferences.update(
                {{"graphicsBrightness", 1},
                 {"graphicsGamma", 1},
                 {"graphicsVibrance", 1},
                 {"graphicsAntialias", false},
                 {"graphicsResolutionScale", 1},
                 {"graphicsFullbright", true}}
        );
        capture("graphics-fullbright");
        preferences.update({{"graphicsFullbright", false}, {"graphicsPotato", true}});
        capture("graphics-potato");
        preferences["graphicsPotato"] = false;
        native::Input aim;
        aim.set_angles(50, 0);
        renderer.tool_message({{"type", "paint"}, {"action", "stamp"}}, spawn.player, aim, true);
        renderer.tool_message({{"type", "measure"}, {"action", "point"}}, spawn.player, aim, true);
        aim.set_angles(40, 20);
        renderer.tool_message({{"type", "measure"}, {"action", "point"}}, spawn.player, aim, true);
        const auto tools = renderer.surface_tools_state();
        if (tools.at("paintMarks") != 1 || tools.at("measurePoints") != 2) {
            throw std::runtime_error("Surface picking/paint/measure fixture failed");
        }
        capture("paint-and-measure");
        std::ofstream(output / "surface-tools.json") << tools.dump(2);
        std::cout << "12 rendering effect fixtures; GL_NO_ERROR\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
