#pragma once

// The Source look's planar water reflection target (water_capture.hpp picks the plane). It holds the same
// gamma-encoded colour the world shaders write, at half the frame's size like the website's SOURCE_WATER.
// Included from renderer.hpp after Gl.

class WaterReflectionTarget {
    static constexpr float scale = .5f;
    static constexpr int max_size = 2048;

    Gl &gl;
    GLuint framebuffer = 0, color = 0, depth = 0;
    int width_ = 0, height_ = 0;

    void allocate(int w, int h) {
        gl.BindTexture(GL_TEXTURE_2D, color);
        gl.TexImage2D(GL_TEXTURE_2D, 0, GL_RGBA16F, w, h, 0, GL_RGBA, GL_HALF_FLOAT, nullptr);
        gl.BindRenderbuffer(GL_RENDERBUFFER, depth);
        gl.RenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, w, h);
        gl.BindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        gl.FramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, color, 0);
        gl.FramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, depth);
        if (gl.CheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
            throw std::runtime_error("Water reflection target incomplete");
        width_ = w;
        height_ = h;
    }

public:
    explicit WaterReflectionTarget(Gl &g) : gl(g) {
        gl.GenFramebuffers(1, &framebuffer);
        gl.GenTextures(1, &color);
        gl.GenRenderbuffers(1, &depth);
        gl.BindTexture(GL_TEXTURE_2D, color);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    }

    WaterReflectionTarget(const WaterReflectionTarget &) = delete;
    WaterReflectionTarget &operator=(const WaterReflectionTarget &) = delete;

    ~WaterReflectionTarget() {
        gl.DeleteFramebuffers(1, &framebuffer);
        gl.DeleteTextures(1, &color);
        gl.DeleteRenderbuffers(1, &depth);
    }

    // Binds the target sized for a frame of frame_width x frame_height and clears it.
    void begin(int frame_width, int frame_height) {
        const int w = std::clamp(int(std::lround(frame_width * scale)), 1, max_size);
        const int h = std::clamp(int(std::lround(frame_height * scale)), 1, max_size);
        if (w != width_ || h != height_) allocate(w, h);
        gl.BindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        gl.Viewport(0, 0, w, h);
        gl.ColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
        gl.DepthMask(GL_TRUE);
        gl.Clear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    }

    GLuint texture() const { return color; }

    int width() const { return width_; }

    int height() const { return height_; }
};
