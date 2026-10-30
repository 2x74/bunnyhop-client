#pragma once
// Sun shadows of the Enhanced and Cinematic looks (web graphics/shadows.ts): a depth map of the world and the players
// from the sun, square around the camera and snapped to its texels so it doesn't shimmer as you move. The world shader
// darkens its baked lighting where the map says shadowed, and the lighting profiles add their sun and sky fill on top.
// Included from renderer.hpp after Gl.
#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>

class SunShadowMap {
    Gl &gl;
    GLuint framebuffer = 0, depth = 0;
    int size_ = 0;

    void allocate(int size) {
        gl.BindTexture(GL_TEXTURE_2D, depth);
        gl.TexImage2D(GL_TEXTURE_2D, 0, GL_DEPTH_COMPONENT24, size, size, 0, GL_DEPTH_COMPONENT, GL_FLOAT, nullptr);
        gl.BindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        gl.FramebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, depth, 0);
        gl.DrawBuffer(GL_NONE);
        gl.ReadBuffer(GL_NONE);
        if (gl.CheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
            throw std::runtime_error("Sun shadow target incomplete");
        size_ = size;
    }

public:
    explicit SunShadowMap(Gl &g) : gl(g) {
        gl.GenFramebuffers(1, &framebuffer);
        gl.GenTextures(1, &depth);
        gl.BindTexture(GL_TEXTURE_2D, depth);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_COMPARE_MODE, GL_COMPARE_REF_TO_TEXTURE);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_COMPARE_FUNC, GL_LEQUAL);
        // A 1x1 map until shadows are drawn, so the world shader's shadow sampler always has a depth texture.
        allocate(1);
        gl.BindFramebuffer(GL_FRAMEBUFFER, 0);
    }

    SunShadowMap(const SunShadowMap &) = delete;
    SunShadowMap &operator=(const SunShadowMap &) = delete;

    ~SunShadowMap() {
        gl.DeleteFramebuffers(1, &framebuffer);
        gl.DeleteTextures(1, &depth);
    }

    // Binds the map at `size` texels square, cleared, for the casters' depth.
    void begin(int size) {
        if (size != size_) allocate(size);
        gl.BindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        gl.Viewport(0, 0, size_, size_);
        gl.DepthMask(GL_TRUE);
        gl.Clear(GL_DEPTH_BUFFER_BIT);
    }

    GLuint texture() const { return depth; }

    int size() const { return size_; }
};
