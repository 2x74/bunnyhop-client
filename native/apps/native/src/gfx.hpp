#pragma once
#include "gfx_types.hpp"
#include "gfx_opengl.hpp"

namespace native::gfx {
// Selection happens once at build/startup, never through a virtual call in the draw path.
using Context = OpenGlContext;
}  // namespace native::gfx
