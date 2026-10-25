// Framebuffer evidence for the home backdrop: a real local BSP through the
// same MenuBackdrop the client uses (own context, native Renderer, web tour).
// No network, menu, gameplay core, timer or recording.
#include "renderer.hpp"
#include "online.hpp"
#include "menu_backdrop.hpp"
#include <thread>
int main(int argc, char **argv) {
    try {
        std::string map, content, output;
        for (int i = 1; i < argc; ++i) {
            const std::string arg = argv[i];
            auto value = [&] { if (++i >= argc) throw std::runtime_error("missing value for " + arg); return std::string(argv[i]); };
            if (arg == "--map") map = value(); else if (arg == "--content-root") content = value(); else if (arg == "--out") output = value();
            else throw std::runtime_error("unknown option " + arg);
        }
        if (map.empty() || output.empty()) throw std::runtime_error("usage: menu-backdrop-smoke --map FILE.bsp [--content-root DIR] --out FILE.png");
        if (!SDL_Init(SDL_INIT_VIDEO)) throw std::runtime_error(SDL_GetError());
        struct Quit { ~Quit() { SDL_Quit(); } } quit;
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3); SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS, SDL_GL_CONTEXT_FORWARD_COMPATIBLE_FLAG); SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
        using Window = std::unique_ptr<SDL_Window, decltype(&SDL_DestroyWindow)>;
        Window window(SDL_CreateWindow("Menu backdrop test", 1280, 720, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN), SDL_DestroyWindow);
        if (!window) throw std::runtime_error(SDL_GetError());
        auto context = SDL_GL_CreateContext(window.get()); if (!context) throw std::runtime_error(SDL_GetError());
        struct Context { SDL_GLContext c; ~Context() { SDL_GL_DestroyContext(c); } } cleanup{context};
        Gl gl; gl.load();
        int width = 0, height = 0; SDL_GetWindowSizeInPixels(window.get(), &width, &height);
        std::atomic_int loads{0};
        MenuBackdrop backdrop(gl, BUNNYHOP_NATIVE_ASSET_ROOT, [&](const std::string &id, const std::atomic_bool &cancel) {
            ++loads;
            if (id == "cancelled") { while (!cancel) std::this_thread::sleep_for(std::chrono::milliseconds(5)); throw std::runtime_error("cancelled"); }
            return native::DownloadedMap{id, map, content, {}};
        });
        auto settle = [&] {
            for (int i = 0; i < 2000 && backdrop.status() == MenuBackdrop::Status::loading; ++i) { backdrop.poll(true); std::this_thread::sleep_for(std::chrono::milliseconds(5)); }
        };
        // A pending load gives way to a new request without blocking.
        backdrop.request("cancelled");
        if (!backdrop.request("smoke") || backdrop.request("smoke")) throw std::runtime_error("request de-duplication");
        // Held back while a gameplay download would own the cache.
        for (int i = 0; i < 100; ++i) { backdrop.poll(false); std::this_thread::sleep_for(std::chrono::milliseconds(2)); }
        if (backdrop.status() != MenuBackdrop::Status::loading) throw std::runtime_error("backdrop built during a gameplay download");
        settle();
        if (backdrop.status() != MenuBackdrop::Status::ready) throw std::runtime_error("backdrop did not load: " + backdrop.error());
        auto frame = [&](double dt, bool still) {
            if (!backdrop.draw(width, height, dt, still)) throw std::runtime_error("ready backdrop drew nothing");
            std::vector<unsigned char> pixels(size_t(width) * height * 3);
            gl.PixelStorei(GL_PACK_ALIGNMENT, 1);
            gl.ReadPixels(0, 0, width, height, GL_RGB, GL_UNSIGNED_BYTE, pixels.data());
            return pixels;
        };
        const auto fixed = frame(0, true);
        if (fixed != frame(5, true)) throw std::runtime_error("reduced-motion frame changed");
        size_t lit = 0; for (size_t i = 0; i < fixed.size(); i += 3) lit += fixed[i] + fixed[i + 1] + fixed[i + 2] > 30;
        if (lit < fixed.size() / 3 / 10) throw std::runtime_error("backdrop frame is mostly black");
        const auto first = frame(.016, false);
        std::vector<unsigned char> later;
        for (int i = 0; i < 30; ++i) later = frame(.1, false);
        if (first == later) throw std::runtime_error("live tour camera did not move");
        frame(0, true);
        gl.PixelStorei(GL_PACK_ALIGNMENT, 8);
        const auto png = backbuffer_png(gl, width, height);
        int alignment = 0; gl.GetIntegerv(GL_PACK_ALIGNMENT, &alignment);
        if (alignment != 8) throw std::runtime_error("capture leaked pixel-pack state");
        if (png.size() < 1000 || 22 + (png.size() + 2) / 3 * 4 > 2000000) throw std::runtime_error("unexpected capture size");
        if (!backbuffer_png(gl, 0, 0).empty()) throw std::runtime_error("empty drawable was captured");
        backdrop.draw(0, 0, 0, false);
        if (gl.GetError() != GL_NO_ERROR) throw std::runtime_error("backdrop caused a GL error");
        std::ofstream out(output, std::ios::binary); out.write(png.data(), std::streamsize(png.size()));
        if (!out) throw std::runtime_error("could not write PNG");
        const auto shots = backdrop.shots();
        backdrop.release();
        if (backdrop.status() != MenuBackdrop::Status::idle || backdrop.draw(width, height, 0, false)) throw std::runtime_error("release kept the scene");
        std::cout << "Menu backdrop: " << map << ", " << shots << " tour shots, " << loads << " loads, still stable, camera moves, PNG "
                  << png.size() << " bytes, GL_NO_ERROR\n";
    } catch (const std::exception &e) { std::cerr << "Menu backdrop smoke: " << e.what() << '\n'; return 1; }
}
