// Read-only replay evidence: no recorder or submission service is started.
#include "ghost_actors.hpp"
#include "ghost_route_events.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>

int main(int argc, char **argv) {
    try {
        if (argc != 4 && argc != 5)
            throw std::runtime_error("usage: ghost-route-smoke MAP REPLAY OUTPUT_DIR [OTHER_MAP]");
        if (!SDL_Init(SDL_INIT_VIDEO)) throw std::runtime_error(SDL_GetError());

        struct Sdl {
            ~Sdl() { SDL_Quit(); }
        } sdl;

        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
        SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
        auto *window = SDL_CreateWindow("Route evidence", 1280, 720, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
        if (!window) throw std::runtime_error(SDL_GetError());

        struct Window {
            SDL_Window *w;

            ~Window() { SDL_DestroyWindow(w); }
        } window_guard{window};

        const auto context = SDL_GL_CreateContext(window);
        if (!context) throw std::runtime_error(SDL_GetError());

        struct Context {
            SDL_GLContext c;

            ~Context() { SDL_GL_DestroyContext(c); }
        } context_guard{context};

        SDL_GL_MakeCurrent(window, context);
        SDL_GL_SetSwapInterval(0);
        native::Gl gl;
        gl.load();
        std::unique_ptr<BhContext, decltype(&bh_destroy)> core(bh_create(), &bh_destroy);
        if (!core || !bh_load_map(core.get(), argv[1], nullptr)) throw std::runtime_error(bh_last_error(core.get()));
        BhSnapshot snapshot{};
        bh_snapshot(core.get(), &snapshot);
        auto owned_renderer = std::make_unique<native::Renderer>(gl, core.get());
        auto &renderer = *owned_renderer;
        renderer.set_viewmodel_visible(false);
        renderer.set_zones_visible(false);
        native::GhostSlots ghosts;
        const std::array sources = {
                native_render::GhostSource::pb, native_render::GhostSource::wr, native_render::GhostSource::custom
        };
        for (unsigned slot = 0; slot < sources.size(); ++slot) {
            ghosts.load(core.get(), argv[2], slot);
            native_render::GhostPath path;
            path.load(core.get(), ghosts.slots[slot].handle, ghosts.slots[slot].info, sources[slot]);
            native_render::load_route_events(path, core.get(), argv[2]);
            renderer.set_ghost_path(slot, std::move(path));
        }
        const auto &path = renderer.ghost_path(0);
        const auto output = std::filesystem::path(argv[3]);
        std::filesystem::create_directories(output);
        nlohmann::json frames = nlohmann::json::array();
        for (const auto &frame : path.frames)
            frames.push_back({frame.position[0], frame.position[1], frame.position[2], frame.flags});
        std::ofstream(output / "frames.json") << nlohmann::json{
                {"frames", frames},
                {"start", path.start},
                {"end", path.end},
                {"events", path.motion_events},
                {"info", ghosts.slots[0].info}
        };
        nlohmann::json route_data;
        for (const auto &link : path.jump_links)
            route_data["jumps"].push_back({link.from, link.to});
        path.path_segments([&](const native_render::GhostPath::Segment &link) {
            route_data["path"].push_back({link.from, link.to});
        });
        route_data["markers"] = path.jumps;
        std::ofstream(output / "route-data.json") << route_data;
        size_t float_count = 0, index_count = 0;
        const auto *vertices = bh_vertices(core.get(), &float_count);
        const auto *indices = bh_indices(core.get(), &index_count);
        nlohmann::json world;
        for (size_t i = 0; i < float_count; i += 10)
            world["positions"].push_back({vertices[i], vertices[i + 2], -vertices[i + 1]});
        world["indices"] = std::vector<uint32_t>(indices, indices + index_count);
        std::ofstream(output / "world.json") << world;
        const auto &start = path.frames[path.start];
        float eye[] = {start.position[0] - 150, start.position[1] + 60, start.position[2] + 110};
        native::Input input;
        input.set_angles(20, 0);
        BhRunState run{};
        std::string style = path.style, outfit = "outfit-cream";
        nlohmann::json results = nlohmann::json::array();
        auto preferences = native::default_graphics_settings();
        preferences["graphicsAntialias"] = false;
        preferences["ghostNearFade"] = false;
        preferences["ghostTrail"] = false;
        const uint32_t route_track = path.track;
        auto capture = [&](const std::string &name) {
            auto &renderer = *owned_renderer;
            renderer.graphics_settings(preferences);
            renderer.route_context(route_track, style, true);
            std::vector<native_render::Actor> actors;
            native::GhostFrameContext frame{core.get(), run, 0, 1, route_track, style, outfit, .55f};
            native::append_ghost_actors(ghosts, renderer, frame, actors);
            renderer.set_room_actors(actors);
            renderer.draw(1280, 720, eye, input, &snapshot, 0);
            if (gl.GetError() != GL_NO_ERROR) throw std::runtime_error("Route GL error: " + name);
            renderer.screenshot((output / (name + ".ppm")).string(), 1280, 720);
            const auto racing = native::racing_ghost_paths(ghosts, renderer, frame);
            unsigned comparisons = 0;
            for (const auto *raced : racing)
                comparisons += raced != nullptr;
            results.push_back(
                    {{"name", name},
                     {"selected", renderer.route_slot()},
                     {"actors", actors.size()},
                     {"comparisons", comparisons}}
            );
        };
        preferences["showGhost"] = false;
        capture("map-background");
        preferences["showGhost"] = true;
        const auto matrix = [&](const std::string &prefix) {
            for (const auto *source : {"auto", "pb", "wr", "custom"})
                for (const auto *mode : {"jumps", "path"})
                    for (bool on : {false, true})
                        for (bool only : {false, true}) {
                            preferences.update(
                                    {{"ghostRouteSource", source},
                                     {"ghostRouteMode", mode},
                                     {"ghostRoute", on},
                                     {"ghostRouteOnly", only}}
                            );
                            capture(prefix + std::string(source) + "-" + mode + (on ? "-on" : "-off")
                                    + (only ? "-only" : "-ghost"));
                        }
        };
        matrix("");
        preferences.update({{"ghostRoute", true}, {"ghostRouteOnly", true}, {"hud", false}});
        capture("hide-ui");
        if (!bh_reset(core.get())) throw std::runtime_error(bh_last_error(core.get()));
        preferences["hud"] = true;
        capture("restart");
        matrix("restart-");
        renderer.clear_ghosts();
        capture("map-cleared");
        for (unsigned slot = 0; slot < sources.size(); ++slot) {
            native_render::GhostPath path;
            path.load(core.get(), ghosts.slots[slot].handle, ghosts.slots[slot].info, sources[slot]);
            native_render::load_route_events(path, core.get(), argv[2]);
            renderer.set_ghost_path(slot, std::move(path));
        }
        capture("map-reloaded");
        if (argc == 5) {
            owned_renderer.reset();
            if (!bh_load_map(core.get(), argv[4], nullptr)) throw std::runtime_error(bh_last_error(core.get()));
            ghosts.slots = {};
            owned_renderer = std::make_unique<native::Renderer>(gl, core.get());
            owned_renderer->set_viewmodel_visible(false);
            owned_renderer->set_zones_visible(false);
            capture("other-map-no-route");
            owned_renderer.reset();
            if (!bh_load_map(core.get(), argv[1], nullptr)) throw std::runtime_error(bh_last_error(core.get()));
            owned_renderer = std::make_unique<native::Renderer>(gl, core.get());
            owned_renderer->set_viewmodel_visible(false);
            owned_renderer->set_zones_visible(false);
            for (unsigned slot = 0; slot < sources.size(); ++slot) {
                ghosts.load(core.get(), argv[2], slot);
                native_render::GhostPath reloaded;
                reloaded.load(core.get(), ghosts.slots[slot].handle, ghosts.slots[slot].info, sources[slot]);
                native_render::load_route_events(reloaded, core.get(), argv[2]);
                owned_renderer->set_ghost_path(slot, std::move(reloaded));
            }
            matrix("map-change-");
        }
        std::ofstream(output / "matrix.json") << results.dump(2) << '\n';
        std::cout << results.size() << " hidden route captures; GL_NO_ERROR\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
