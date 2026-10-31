#pragma once
#include "gfx.hpp"

// Temporary bridges for the legacy renderer's sample limits and borrowed framebuffer arguments.
namespace native_post {
inline int maximum_samples(Gl &gl) {
    GLint maximum = 0;
    gl.GetIntegerv(GL_MAX_SAMPLES, &maximum);
    return maximum;
}

inline native::gfx::TargetView target(uint32_t framebuffer, int width, int height) {
    return native::gfx::Context::borrow_target(framebuffer, {width, height});
}

inline native::gfx::TargetView current_target(Gl &gl) {
    GLint framebuffer = 0;
    gl.GetIntegerv(GL_FRAMEBUFFER_BINDING, &framebuffer);
    return target(uint32_t(framebuffer), 1, 1);
}
}  // namespace native_post
