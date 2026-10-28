// Framebuffer evidence for the home backdrop: a real local BSP through the
// same native::MenuBackdrop the client uses (own context, native native::Renderer, web tour).
// No network, menu, gameplay context, live timer or recording.
#include "renderer.hpp"
#include "online.hpp"
#include "menu_backdrop.hpp"
#include <thread>

int main(int argc, char **argv) {
    try {
        std::string map, content, output, replay, broken_replay;
        for (int i = 1; i < argc; ++i) {
            const std::string arg = argv[i];
            auto value = [&] {
                if (++i >= argc) throw std::runtime_error("missing value for " + arg);
                return std::string(argv[i]);
            };
            if (arg == "--map")
                map = value();
            else if (arg == "--content-root")
                content = value();
            else if (arg == "--out")
                output = value();
            else if (arg == "--replay")
                replay = value();
            else if (arg == "--broken-replay")
                broken_replay = value();
            else
                throw std::runtime_error("unknown option " + arg);
        }
        if (map.empty() || output.empty())
            throw std::runtime_error(
                    "usage: menu-backdrop-smoke --map FILE.bsp [--content-root DIR] [--replay COMPLETED.bhr] "
                    "[--broken-replay BAD_CHECKPOINT.bhr] --out FILE.png"
            );
        // Sparse local file: the 32 MiB guard must run before native BSP parsing.
        const auto oversized = output + ".oversized.bsp";

        struct Remove {
            std::string path;

            ~Remove() {
                std::error_code ec;
                std::filesystem::remove(path, ec);
            }
        } remove_oversized{oversized};

        {
            std::ofstream file(oversized, std::ios::binary);
            file.seekp(32u << 20);
            file.put('\0');
            if (!file) throw std::runtime_error("could not create BSP limit fixture");
        }
        bool bounded_bsp = false;
        try {
            native::load_backdrop_map(oversized, {});
        } catch (const std::exception &e) {
            bounded_bsp = std::string(e.what()) == "Backdrop BSP exceeds 32 MiB";
        }
        if (!bounded_bsp) throw std::runtime_error("backdrop ignored local BSP size budget");
        if (!SDL_Init(SDL_INIT_VIDEO)) throw std::runtime_error(SDL_GetError());

        struct Quit {
            ~Quit() { SDL_Quit(); }
        } quit;

        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS, SDL_GL_CONTEXT_FORWARD_COMPATIBLE_FLAG);
        SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
        using Window = std::unique_ptr<SDL_Window, decltype(&SDL_DestroyWindow)>;
        Window window(
                SDL_CreateWindow("Menu backdrop test", 1280, 720, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN),
                SDL_DestroyWindow
        );
        if (!window) throw std::runtime_error(SDL_GetError());
        auto context = SDL_GL_CreateContext(window.get());
        if (!context) throw std::runtime_error(SDL_GetError());

        struct Context {
            SDL_GLContext c;

            ~Context() { SDL_GL_DestroyContext(c); }
        } cleanup{context};

        native::Gl gl;
        gl.load();
        int width = 0, height = 0;
        SDL_GetWindowSizeInPixels(window.get(), &width, &height);
        std::atomic_int loads{0}, cancelled{0};
        std::atomic_bool cancelling_started{false};
        native::MenuBackdrop backdrop(
                gl, BUNNYHOP_NATIVE_ASSET_ROOT, [&](const std::string &id, const std::atomic_bool &cancel) {
                    ++loads;
                    if (id == "cancelled") {
                        cancelling_started = true;
                        while (!cancel)
                            std::this_thread::sleep_for(std::chrono::milliseconds(1));
                        ++cancelled;
                        throw std::runtime_error("cancelled");
                    }
                    return native::DownloadedMap{id, map, content, {}};
                }
        );
        auto settle = [&] {
            for (int i = 0; i < 2000 && backdrop.status() == native::MenuBackdrop::Status::loading; ++i) {
                backdrop.poll(true);
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
            }
        };
        // A pending load gives way to a new request without blocking.
        backdrop.request("cancelled", replay);
        for (int i = 0; i < 2000 && !cancelling_started; ++i)
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        if (!cancelling_started) throw std::runtime_error("cancellation worker never started");
        const auto cancel_start = std::chrono::steady_clock::now();
        if (!backdrop.request("smoke") || backdrop.request("smoke")) throw std::runtime_error("request de-duplication");
        if (std::chrono::steady_clock::now() - cancel_start > std::chrono::milliseconds(100))
            throw std::runtime_error("request blocked on retired worker");
        // A gameplay download interrupts the loading tour; when it fails, the same tour resumes once.
        if (backdrop.resume()) throw std::runtime_error("resumed a tour nothing interrupted");
        if (!backdrop.cancel_loading() || backdrop.status() != native::MenuBackdrop::Status::idle
            || !backdrop.map().empty())
            throw std::runtime_error("gameplay download did not interrupt the tour");
        if (!backdrop.resume() || backdrop.status() != native::MenuBackdrop::Status::loading
            || backdrop.map() != "smoke" || backdrop.resume())
            throw std::runtime_error("interrupted tour did not resume exactly once");
        // Held back while a gameplay download would own the cache.
        for (int i = 0; i < 100; ++i) {
            backdrop.poll(false);
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
        if (backdrop.status() != native::MenuBackdrop::Status::loading)
            throw std::runtime_error("backdrop built during a gameplay download");
        settle();
        if (backdrop.status() != native::MenuBackdrop::Status::ready)
            throw std::runtime_error("backdrop did not load: " + backdrop.error());
        if (cancelled != 1 || backdrop.state("native").at("kind") != "tour")
            throw std::runtime_error("cancelled replay worker replaced current tour");
        auto frame = [&](double dt, bool still) {
            if (!backdrop.draw(width, height, dt, still)) throw std::runtime_error("ready backdrop drew nothing");
            std::vector<unsigned char> pixels(size_t(width) * height * 3);
            gl.PixelStorei(GL_PACK_ALIGNMENT, 1);
            gl.ReadPixels(0, 0, width, height, GL_RGB, GL_UNSIGNED_BYTE, pixels.data());
            return pixels;
        };
        const auto fixed = frame(0, true);
        if (fixed != frame(5, true)) throw std::runtime_error("reduced-motion frame changed");
        size_t lit = 0;
        for (size_t i = 0; i < fixed.size(); i += 3)
            lit += fixed[i] + fixed[i + 1] + fixed[i + 2] > 30;
        if (lit < fixed.size() / 3 / 10) throw std::runtime_error("backdrop frame is mostly black");
        const auto first = frame(.016, false);
        std::vector<unsigned char> later;
        for (int i = 0; i < 30; ++i)
            later = frame(.1, false);
        if (first == later) throw std::runtime_error("live tour camera did not move");
        // Invalid replay initialization still yields a useful, static tour.
        if (!backdrop.request("smoke", output + ".missing.bhr"))
            throw std::runtime_error("same-map changed PB did not reload");
        settle();
        if (backdrop.status() != native::MenuBackdrop::Status::ready || backdrop.state("native").at("kind") != "tour"
            || backdrop.state("native").at("replayError") == "")
            throw std::runtime_error("invalid PB did not fall back to tour");
        if (frame(0, true) != frame(5, true)) throw std::runtime_error("fallback tour reduced motion changed");
        if (!broken_replay.empty()) {
            backdrop.request("smoke", broken_replay);
            settle();
            if (backdrop.state("native").at("kind") != "pb")
                throw std::runtime_error("late-checkpoint fixture failed during init");
            for (int i = 0; i < 20 && backdrop.state("native").at("kind") == "pb"; ++i)
                frame(.1, false);
            if (backdrop.status() != native::MenuBackdrop::Status::ready
                || backdrop.state("native").at("kind") != "tour" || backdrop.state("native").at("replayError") == "")
                throw std::runtime_error("late checkpoint failure did not restore tour");
            if (frame(0, true) != frame(5, true)) throw std::runtime_error("runtime-fallback tour is unstable");
        }
        if (!replay.empty()) {
            if (!backdrop.request("smoke", replay) || backdrop.request("smoke", replay))
                throw std::runtime_error("same-map PB request identity");
            // A gameplay download must preserve the PB path on resume.
            if (!backdrop.cancel_loading() || !backdrop.resume() || backdrop.request("smoke", replay))
                throw std::runtime_error("resume lost PB path");
            settle();
            if (backdrop.status() != native::MenuBackdrop::Status::ready || backdrop.state("native").at("kind") != "pb")
                throw std::runtime_error("valid PB failed: " + backdrop.state("native").dump());
            const auto initial = frame(0, true);
            if (initial != frame(5, true) || backdrop.cut(false))
                throw std::runtime_error("PB reduced motion/cut changed");
            frame(.1, false);
            if (backdrop.state("native").at("replayTick") == 0) throw std::runtime_error("PB did not advance");
            if (!backdrop.seek_replay(0) || initial != frame(0, true))
                throw std::runtime_error("PB seek retained presentation history");
            const auto total = backdrop.state("native").at("replayTicks").get<uint32_t>();
            if (backdrop.seek_replay(total + 1) || !backdrop.seek_replay(total))
                throw std::runtime_error("PB seek bounds");
            frame(.1, false);
            const auto looped = backdrop.state("native");
            if (looped.at("kind") != "pb" || looped.at("replayTick") >= total)
                throw std::runtime_error("PB loop failed");
            if (frame(0, true) != frame(5, true)) throw std::runtime_error("looped PB reduced motion changed");
            // Distinct immutable cache paths are distinct replay selections.
            const auto alternate =
                    (std::filesystem::path(replay).parent_path() / "." / std::filesystem::path(replay).filename())
                            .string();
            if (!backdrop.request("smoke", alternate)) throw std::runtime_error("same-map replacement PB ignored");
            settle();
            if (backdrop.state("native").at("kind") != "pb" || initial != frame(0, true))
                throw std::runtime_error("replacement PB did not reinitialize");
        }
        frame(0, true);
        gl.PixelStorei(GL_PACK_ALIGNMENT, 8);
        const auto png = backbuffer_png(gl, width, height);
        int alignment = 0;
        gl.GetIntegerv(GL_PACK_ALIGNMENT, &alignment);
        if (alignment != 8) throw std::runtime_error("capture leaked pixel-pack state");
        if (png.size() < 1000 || 22 + (png.size() + 2) / 3 * 4 > 2000000)
            throw std::runtime_error("unexpected capture size");
        if (!backbuffer_png(gl, 0, 0).empty()) throw std::runtime_error("empty drawable was captured");
        backdrop.draw(0, 0, 0, false);
        if (gl.GetError() != GL_NO_ERROR) throw std::runtime_error("backdrop caused a GL error");
        std::ofstream out(output, std::ios::binary);
        out.write(png.data(), std::streamsize(png.size()));
        if (!out) throw std::runtime_error("could not write PNG");
        const auto shots = backdrop.shots();
        backdrop.release();
        if (backdrop.status() != native::MenuBackdrop::Status::idle || backdrop.draw(width, height, 0, false))
            throw std::runtime_error("release kept the scene");
        std::cout << "Menu backdrop: " << map << ", " << shots << " tour shots, " << loads
                  << " loads, still stable, camera moves, PNG " << png.size()
                  << " bytes, BSP limit enforced, worker cancelled, invalid PB tour fallback"
                  << (broken_replay.empty() ? "" : ", late checkpoint tour fallback")
                  << (replay.empty() ? "" : ", PB seeks/loops/replacement stable") << ", GL_NO_ERROR\n";
    } catch (const std::exception &e) {
        std::cerr << "Menu backdrop smoke: " << e.what() << '\n';
        return 1;
    }
}
