#include "renderer_launch.hpp"
#include <cassert>
#include <filesystem>
#include <fstream>
#include <iostream>

namespace {
void first_choice(const std::filesystem::path &root) {
    const auto path = root / "choice-settings.json";
    auto saved = native::default_settings();
    saved["renderer"] = "d3d11";
    native::choose_renderer_once(root, path, saved, [] { return native::RendererChoice::opengl; });
    assert(native::load_settings(path)["renderer"] == "opengl");
    native::choose_renderer_once(root, path, saved, []() -> native::RendererChoice {
        assert(false && "A saved answer must not show the choice again");
        return native::RendererChoice::d3d11;
    });
    std::filesystem::remove(root / "renderer-choice-v1.done");
    native::choose_renderer_once(root, path, saved, [] { return native::RendererChoice::d3d11; });
    assert(native::load_settings(path)["renderer"] == "d3d11");
}

void crash_guard(const std::filesystem::path &root) {
    {
        native::RendererGuard guard(root);
        assert(!guard.blocked());
        guard.starting();
        guard.presented();
        guard.presented();
    }
    {
        native::RendererGuard guard(root);
        assert(guard.failures() == 1 && !guard.blocked());
        guard.starting();
    }
    {
        native::RendererGuard guard(root);
        assert(guard.failures() == 2 && guard.blocked());
        guard.starting();
        guard.presented();
        guard.presented();
        guard.presented();
    }
    {
        native::RendererGuard guard(root);
        assert(guard.failures() == 0);
        guard.starting();
        guard.clear();
    }
    assert(!native::RendererGuard(root).blocked());
    assert(!std::filesystem::exists(root / "d3d11-startup.pending"));
}

void selection_and_recovery(const std::filesystem::path &root) {
    auto settings = native::default_settings();
    settings["renderer"] = "d3d11";
    native::save_settings(root / "settings.json", settings);
    native::Options options;
    options.renderer = "opengl";
    {
        native::RendererLaunch launch(options, root);
        assert(launch.backend == native::gfx::Backend::opengl);
    }
    options.renderer.reset();
#ifdef _WIN32
    for (unsigned attempt = 0; attempt < 2; ++attempt) {
        native::RendererLaunch launch(options, root);
        assert(launch.backend == native::gfx::Backend::d3d11);
    }
    {
        native::RendererLaunch launch(options, root);
        assert(launch.backend == native::gfx::Backend::opengl);
        assert(!launch.notice.empty());
    }
    assert(native::load_settings(root / "settings.json")["renderer"] == "d3d11");
    options.renderer = "d3d11";
    {
        native::RendererLaunch launch(options, root);
        assert(launch.backend == native::gfx::Backend::d3d11);
        for (unsigned frame = 0; frame < 3; ++frame)
            launch.presented();
        assert(launch.ready);
    }
    assert(!std::filesystem::exists(root / "d3d11-startup.pending"));
#else
    native::RendererLaunch launch(options, root);
    assert(launch.backend == native::gfx::Backend::opengl);
    assert(!std::filesystem::exists(root / "d3d11-startup.pending"));
#endif
}
}  // namespace

int main() {
    const auto root = std::filesystem::current_path() / "renderer-startup-test";
    std::filesystem::create_directories(root);

    struct Cleanup {
        const std::filesystem::path &root;

        ~Cleanup() {
            std::error_code error;
            std::filesystem::remove_all(root, error);
        }
    } cleanup{root};

    first_choice(root);
    crash_guard(root);
    selection_and_recovery(root);
    std::cout << "Renderer defaults, override and two-launch startup recovery passed\n";
}
