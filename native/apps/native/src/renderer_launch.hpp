#pragma once
#include "data_location.hpp"
#include "display_defaults.hpp"
#include "options.hpp"
#include "renderer_choice.hpp"
#include "renderer_guard.hpp"
#include "renderer_prompt.hpp"
#include "renderer_preference.hpp"
#include "settings.hpp"
#include <SDL3/SDL.h>
#include <iostream>
#include <memory>

namespace native {
class RendererLaunch {
    std::unique_ptr<RendererGuard> guard_;
    unsigned frames_ = 0;

    static std::filesystem::path preferences_root(std::filesystem::path root) {
        if (!root.empty()) return root;
        char *path = SDL_GetPrefPath("bunnyhop.lol", "Bunnyhop Native");
        if (!path) throw std::runtime_error("Cannot find renderer preferences");
        root = data_location::from_utf8(path);
        SDL_free(path);
        return root;
    }

public:
    gfx::Backend backend = gfx::Backend::opengl;
    std::string notice, recovery;
    bool device_lost = false;
    bool ready = false;

    explicit RendererLaunch(const Options &options, const std::filesystem::path &root_override = {}) {
#ifndef _WIN32
        (void)options;
        (void)root_override;
#else
        try {
            const auto root = preferences_root(root_override);
            auto active = data_location::read(root).active;
            if (!std::filesystem::is_directory(active)) active = root;
            const bool scripted = options.frames || options.hidden;
            auto saved = scripted ? default_settings() : startup_settings(active);
            if (!scripted && !options.renderer && root_override.empty())
                choose_renderer_once(root, active / "settings.json", saved, ask_renderer);
            const auto choice = options.renderer.value_or(saved.value("renderer", std::string("opengl")));
            backend = renderer_backend(renderer_choice(choice));
            if (backend != gfx::Backend::d3d11 || scripted) return;
            guard_ = std::make_unique<RendererGuard>(root);
            if (guard_->blocked() && !options.renderer) {
                fallback("Direct3D 11 did not start twice. Using OpenGL. Your renderer setting is unchanged.", false);
                return;
            }
            guard_->starting();
        } catch (const std::exception &error) {
            fallback(std::string(error.what()) + ". Using OpenGL.");
        }
#endif
    }

    void show_notice(const Options &options) const {
        if (!notice.empty() && !options.hidden && !options.frames)
            SDL_ShowSimpleMessageBox(SDL_MESSAGEBOX_INFORMATION, "Bunnyhop Native", notice.c_str(), nullptr);
    }

    void presented() {
        if (guard_) guard_->presented();
        if (++frames_ >= 3) ready = true;
    }

    void fallback(std::string reason, bool clear_guard = true) {
        backend = gfx::Backend::opengl;
        notice = std::move(reason);
        if (guard_ && clear_guard) guard_->clear();
        std::cerr << notice << '\n';
    }
};
}  // namespace native
