#pragma once
#include "renderer_choice.hpp"
#include "settings.hpp"

namespace native {
inline void choose_renderer_once(
        const std::filesystem::path &root,
        const std::filesystem::path &settings_path,
        Json &saved,
        RendererChoice (*choose)()
) {
    const auto answered = root / "renderer-choice-v1.done";
    if (std::filesystem::exists(answered)) return;
    saved["renderer"] = choose() == RendererChoice::d3d11 ? "d3d11" : "opengl";
    save_settings(settings_path, saved);
    atomic_write_file(answered, "Renderer choice saved\n");
}
}  // namespace native
