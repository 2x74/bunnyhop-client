#include "renderer_launch.hpp"
#include <cassert>
#include <filesystem>
#include <fstream>
#include <iostream>

namespace {
void selection_and_recovery(const std::filesystem::path &root) {
    auto settings = native::default_settings();
    native::save_settings(root / "settings.json", settings);
    native::Options options;
    {
        native::RendererLaunch launch(options, root);
        assert(launch.backend == native::gfx::Backend::opengl);
        assert(launch.notice.empty());
    }
    settings["renderer"] = "d3d11";
    native::save_settings(root / "settings.json", settings);
    options.renderer = "opengl";
    {
        native::RendererLaunch launch(options, root);
        assert(launch.backend == native::gfx::Backend::opengl);
    }
    options.renderer.reset();
    const auto marker = root / "d3d11-startup.pending";
#ifdef _WIN32
    {
        native::RendererLaunch launch(options, root);
        assert(launch.backend == native::gfx::Backend::d3d11);
        assert(std::filesystem::exists(marker));
        launch.complete();
    }
    assert(!std::filesystem::exists(marker));
    std::ofstream(marker) << "Interrupted D3D11 startup\n";
    {
        native::RendererLaunch launch(options, root);
        assert(launch.backend == native::gfx::Backend::opengl);
        assert(!launch.notice.empty());
    }
    assert(!std::filesystem::exists(marker));
#else
    native::RendererLaunch launch(options, root);
    assert(launch.backend == native::gfx::Backend::opengl);
    assert(!std::filesystem::exists(marker));
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

    selection_and_recovery(root);
    std::cout << "Renderer defaults, preference, override and startup recovery passed\n";
}
