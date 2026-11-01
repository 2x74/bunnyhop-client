#pragma once
#include "gfx_types.hpp"
#include <string_view>

namespace native {
enum class RendererChoice { opengl, d3d11 };

inline RendererChoice renderer_choice(std::string_view value) {
    return value == "d3d11" ? RendererChoice::d3d11 : RendererChoice::opengl;
}

inline gfx::Backend renderer_backend(RendererChoice choice) {
    return choice == RendererChoice::d3d11 && gfx::available(gfx::Backend::d3d11) ? gfx::Backend::d3d11
                                                                                  : gfx::Backend::opengl;
}

inline const char *renderer_name(gfx::Backend backend) {
    return backend == gfx::Backend::d3d11 ? "d3d11" : "opengl";
}
}  // namespace native
