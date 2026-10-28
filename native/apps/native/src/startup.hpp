#pragma once
#include "options.hpp"
#include "data_location.hpp"
#include <SDL3/SDL.h>
#include <nlohmann/json.hpp>
#include <filesystem>
#include <memory>
#include <string>
#include <type_traits>

namespace native {
class SdlSession {
public:
    SdlSession();
    ~SdlSession();
    SdlSession(const SdlSession &) = delete;
    SdlSession &operator=(const SdlSession &) = delete;
};

struct GlContextDeleter {
    void operator()(SDL_GLContext context) const;
};

using WindowPtr = std::unique_ptr<SDL_Window, decltype(&SDL_DestroyWindow)>;
using ContextPtr = std::unique_ptr<std::remove_pointer_t<SDL_GLContext>, GlContextDeleter>;

struct WindowAndGl {
    WindowPtr window;
    ContextPtr context;
};

WindowAndGl create_window_and_gl(const Options &opt);

struct DataPaths {
    std::filesystem::path default_root;
    std::filesystem::path cache;
    data_location::Location location;
    std::string notice;
    bool unavailable;
};

class DataMoveProgress {
public:
    virtual ~DataMoveProgress() = default;
    virtual void draw(const std::filesystem::path &destination, double total, double done) = 0;
};

DataPaths resolve_data_folder(const Options &opt, SDL_Window *window, DataMoveProgress &display);
std::string read_text(const std::filesystem::path &path);
std::string file_hash(const std::filesystem::path &path, const std::string &mode = "sha256");
std::filesystem::path executable_path();
nlohmann::json load_release_identity(
        const std::filesystem::path &manifest_path,
        const std::filesystem::path &menu_path,
        const std::filesystem::path &assets
);
}  // namespace native
