#pragma once
#include "data_location.hpp"
#include "options.hpp"
#include "renderer_choice.hpp"
#include "settings.hpp"
#include <atomic>
#include <condition_variable>
#include <fstream>
#include <iostream>
#include <mutex>
#include <thread>

namespace native {
// A startup-only marker survives driver faults, including Windows fail-fast exits.
class RendererLaunch {
    std::filesystem::path marker_;
    std::mutex mutex_;
    std::condition_variable changed_;
    bool finished_ = false;
    std::thread cleanup_;

    void clean_marker() {
        std::unique_lock lock(mutex_);
        changed_.wait(lock, [this] { return finished_; });
        lock.unlock();
        std::error_code error;
        std::filesystem::remove(marker_, error);
        if (error) std::cerr << "Renderer startup marker: " << error.message() << '\n';
    }

    std::filesystem::path preferences_root() {
        char *path = SDL_GetPrefPath("bunnyhop.lol", "Bunnyhop Native");
        if (!path) return {};
        const auto root = data_location::from_utf8(path);
        SDL_free(path);
        marker_ = root / "d3d11-startup.pending";
        return data_location::read(root).active;
    }

public:
    gfx::Backend backend = gfx::Backend::opengl;
    std::string notice;
    bool ready = false;

    explicit RendererLaunch(const Options &options) {
        try {
            const auto root = preferences_root();
            const bool scripted = options.frames || options.hidden;
            const auto saved = scripted || root.empty() ? default_settings() : load_settings(root / "settings.json");
            const auto choice = options.renderer.value_or(saved.value("renderer", std::string("opengl")));
            backend = renderer_backend(renderer_choice(choice));
            if (backend != gfx::Backend::d3d11 || marker_.empty() || scripted) return;
            if (std::filesystem::exists(marker_) && !scripted) {
                fallback("D3D11 did not finish starting last time. Using OpenGL.");
                return;
            }
            std::ofstream marker(marker_, std::ios::trunc);
            marker << "D3D11 render initialization\n";
            marker.close();
            if (!marker) {
                fallback("Could not save D3D11 startup recovery. Using OpenGL.");
                return;
            }
            cleanup_ = std::thread([this] { clean_marker(); });
        } catch (const std::exception &error) {
            fallback(std::string("Renderer preference could not be read: ") + error.what() + ". Using OpenGL.");
        }
    }

    ~RendererLaunch() {
        complete();
        if (cleanup_.joinable()) cleanup_.join();
    }

    void complete() {
        ready = true;
        {
            std::lock_guard lock(mutex_);
            finished_ = true;
        }
        changed_.notify_one();
    }

    void fallback(std::string reason) {
        backend = gfx::Backend::opengl;
        notice = std::move(reason);
        std::cerr << notice << '\n';
        if (!cleanup_.joinable() && !marker_.empty()) {
            std::error_code error;
            std::filesystem::remove(marker_, error);
        }
    }
};
}  // namespace native
