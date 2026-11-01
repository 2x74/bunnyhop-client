#pragma once
#include "renderer_choice.hpp"

namespace native {
#ifdef _WIN32
RendererChoice ask_renderer();
#endif
}  // namespace native
