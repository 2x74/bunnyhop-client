#include "startup.hpp"
#include "app_identity.hpp"
#include "app_icon.hpp"
#include "../packaging/executable_identity.hpp"
#include "../packaging/assets_identity.hpp"
#include "../packaging/release_identity.hpp"
#include <atomic>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <vector>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

namespace native {
SdlSession::SdlSession() {
    SDL_SetHint(SDL_HINT_MOUSE_RELATIVE_SYSTEM_SCALE, "0");
    SDL_SetHint(SDL_HINT_MOUSE_RELATIVE_SPEED_SCALE, "1");
    SDL_SetHint(SDL_HINT_MOUSE_RELATIVE_WARP_MOTION, "0");
    SDL_SetAppMetadata(native::app_name, nullptr, native::app_id);
    if (!SDL_Init(SDL_INIT_VIDEO))
        throw std::runtime_error(std::string("SDL initialization failed: ") + SDL_GetError());
}

SdlSession::~SdlSession() {
    SDL_Quit();
}

void GlContextDeleter::operator()(SDL_GLContext context) const {
    SDL_GL_DestroyContext(context);
}

WindowAndGl create_window_and_gl(const Options &opt) {
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS, SDL_GL_CONTEXT_FORWARD_COMPATIBLE_FLAG);
    SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);
    SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
    SDL_GL_SetAttribute(SDL_GL_STENCIL_SIZE, 8);
    SDL_WindowFlags flags = SDL_WINDOW_OPENGL | SDL_WINDOW_RESIZABLE | SDL_WINDOW_HIGH_PIXEL_DENSITY;
    if (opt.hidden) flags |= SDL_WINDOW_HIDDEN;
    WindowPtr window(SDL_CreateWindow(native::app_name, 1280, 720, flags), &SDL_DestroyWindow);
    if (!window) throw std::runtime_error(std::string("Creating SDL window failed: ") + SDL_GetError());
    if (!native::set_app_icon(window.get())) std::cerr << "Could not set native app icon: " << SDL_GetError() << '\n';
    ContextPtr context(SDL_GL_CreateContext(window.get()));
    if (!context) throw std::runtime_error(std::string("Creating OpenGL 3.3 core context failed: ") + SDL_GetError());
    if (!SDL_GL_MakeCurrent(window.get(), context.get())) throw std::runtime_error(SDL_GetError());
    SDL_GL_SetSwapInterval(opt.frames ? 0 : 1);
    return {std::move(window), std::move(context)};
}

DataPaths resolve_data_folder(const Options &opt, SDL_Window *window, DataMoveProgress &display) {
    char *pref_path = SDL_GetPrefPath("bunnyhop.lol", "Bunnyhop Native");
    if (!pref_path) throw std::runtime_error("Cannot find the native client data directory");
    const std::string isolated = !opt.runtime_smoke.empty()        ? opt.runtime_smoke
                                 : !opt.presentation_smoke.empty() ? opt.presentation_smoke
                                 : !opt.video_smoke.empty()        ? opt.video_smoke
                                                                   : opt.menu_smoke;
    const std::filesystem::path default_root = native::data_location::from_utf8(pref_path);
    SDL_free(pref_path);
    // Settings -> Game data: the folder may live elsewhere (another drive), and a
    // move chosen there runs here, before anything opens the data folder.
    auto location =
            isolated.empty() ? data_location::read(default_root) : data_location::Location{default_root, std::nullopt};
    std::string data_startup_notice;
    bool data_unavailable = false;
    auto folder_available = [](const std::filesystem::path &p) {
        std::error_code ec;
        return std::filesystem::is_directory(p, ec);
    };
    if (location.pending) {
        if (!folder_available(location.active) && !data_location::same(location.active, default_root))
            data_startup_notice = "Your game data couldn't move: " + data_location::utf8(location.active)
                                  + " isn't available. The move will run once it is.";
        else {
            const auto from = location.active, to = *location.pending;
            data_location::Progress progress;
            std::string error;
            std::atomic<bool> finished = false;
            std::thread worker([&] {
                try {
                    error = data_location::move(from, to, default_root, progress);
                } catch (const std::exception &e) {
                    error = e.what();
                }
                finished = true;
            });
            while (!finished) {
                // Quit is ignored: stopping halfway would leave data split across folders.
                SDL_Event ignored;
                while (SDL_PollEvent(&ignored)) {
                }
                display.draw(to, double(progress.total.load()), double(progress.done.load()));
                SDL_GL_SwapWindow(window);
                SDL_Delay(33);
            }
            worker.join();
            if (error.empty()) {
                location = {to, std::nullopt};
                data_startup_notice = "Game data moved to " + data_location::utf8(to);
            } else {
                location.pending.reset();
                data_startup_notice = "Moving game data failed and nothing changed: " + error;
            }
            try {
                data_location::write(default_root, location);
            } catch (const std::exception &e) {
                std::cerr << "Data folder: " << e.what() << '\n';
            }
            std::cerr << "Data folder: " << data_startup_notice << '\n';
        }
    }
    if (!data_location::same(location.active, default_root) && !folder_available(location.active)) {
        data_unavailable = true;
        data_startup_notice = "Your game data folder " + data_location::utf8(location.active)
                              + " isn't available (is the drive connected?). Using the default folder this session.";
    }
    const std::filesystem::path cache = !isolated.empty()  ? native::data_location::from_utf8(isolated) / "data"
                                        : data_unavailable ? default_root
                                                           : location.active;
    return {default_root, cache, std::move(location), std::move(data_startup_notice), data_unavailable};
}

std::string read_text(const std::filesystem::path &path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) throw std::runtime_error("Cannot open " + native::data_location::utf8(path));
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}

std::string file_hash(const std::filesystem::path &path, const std::string &mode) {
    const auto raw = read_text(path);
    const std::vector<uint8_t> source(raw.begin(), raw.end());
    const auto bytes = native::executable_identity_bytes(source, mode);
    char hash[65]{};
    if (!bh_sha256(reinterpret_cast<const uint8_t *>(bytes.data()), bytes.size(), hash))
        throw std::runtime_error("Could not hash " + native::data_location::utf8(path));
    return hash;
}

std::filesystem::path executable_path() {
#ifdef __APPLE__
    uint32_t count = 4096;
    std::vector<char> path(count);
    if (_NSGetExecutablePath(path.data(), &count) != 0) {
        path.resize(count);
        if (_NSGetExecutablePath(path.data(), &count) != 0) throw std::runtime_error("Cannot locate native executable");
    }
    return std::filesystem::weakly_canonical(path.data());
#elif defined(__linux__)
    return std::filesystem::read_symlink("/proc/self/exe");
#else
    return native::data_location::from_utf8(SDL_GetBasePath()) / "bunnyhop-native.exe";
#endif
}

nlohmann::json load_release_identity(
        const std::filesystem::path &manifest_path,
        const std::filesystem::path &menu_path,
        const std::filesystem::path &assets
) {
    nlohmann::json identity = {{"build", "bunnyhop-native/local"}, {"wasm", ""}};
    if (std::filesystem::exists(manifest_path)) {
        try {
            const auto manifest = nlohmann::json::parse(read_text(manifest_path));
            const auto executable = executable_path();
            native::verify_release_identity(
                    manifest,
                    file_hash(executable, native::release_hash_mode()),
                    file_hash(menu_path),
                    native::assets_identity_hash(assets)
            );
            identity = manifest;
        } catch (const std::exception &e) {
            std::cerr << "Native release manifest: " << e.what() << "; replays remain local\n";
        }
    }
    return identity;
}
}  // namespace native
