#pragma once
#include "renderer.hpp"
#include <array>
#include <cstring>
#include <stdexcept>
#include <vector>

namespace native {

// Offscreen targets for exported frames, independent of the window and the display. The scene renders at the
// supersampled size; motion-blur samples add into a half-float target; the resolve writes their average at the video
// size, where the HUD is drawn sharp once per frame. A ring of pixel buffers reads frames back without waiting for
// the GPU to finish the frame just drawn.
class VideoFrameTargets {
public:
    static constexpr size_t readback_slots = 3;

    VideoFrameTargets(Gl &gl, int width, int height, int supersample, int samples)
        : gl_(gl)
        , width_(width)
        , height_(height)
        , render_width_(width * supersample)
        , render_height_(height * supersample)
        , accumulate_(supersample > 1 || samples > 1) {
        GLint limit = 0;
        gl.GetIntegerv(GL_MAX_TEXTURE_SIZE, &limit);
        if (render_width_ > limit || render_height_ > limit)
            throw std::runtime_error(
                    "This GPU renders at most " + std::to_string(limit) + " px wide; lower the size or supersampling."
            );
        try {
            create();
        } catch (...) {
            release();
            throw;
        }
    }

    ~VideoFrameTargets() { release(); }

    VideoFrameTargets(const VideoFrameTargets &) = delete;
    VideoFrameTargets &operator=(const VideoFrameTargets &) = delete;

    int render_width() const { return render_width_; }

    int render_height() const { return render_height_; }

    void begin_frame() {
        if (!accumulate_) return;
        gl_.BindFramebuffer(GL_FRAMEBUFFER, accumulation_.framebuffer);
        gl_.Viewport(0, 0, render_width_, render_height_);
        gl_.ClearColor(0, 0, 0, 0);
        gl_.Clear(GL_COLOR_BUFFER_BIT);
    }

    void bind_scene() {
        gl_.BindFramebuffer(GL_FRAMEBUFFER, scene_.framebuffer);
        gl_.Viewport(0, 0, render_width_, render_height_);
    }

    // Adds the scene just drawn into the accumulation, weighted so `count` samples average.
    void add_sample(int count) {
        if (!accumulate_) return;
        gl_.BindFramebuffer(GL_FRAMEBUFFER, accumulation_.framebuffer);
        gl_.Viewport(0, 0, render_width_, render_height_);
        gl_.Enable(GL_BLEND);
        gl_.BlendFunc(GL_ONE, GL_ONE);
        draw_texture(scene_.color, 1.f / float(count));
        gl_.Disable(GL_BLEND);
    }

    // The averaged samples at video size; with 2x supersampling each pixel is the mean of its four.
    void resolve() {
        if (!accumulate_) return;
        gl_.BindFramebuffer(GL_FRAMEBUFFER, output_.framebuffer);
        gl_.Viewport(0, 0, width_, height_);
        gl_.Disable(GL_BLEND);
        draw_texture(accumulation_.color, 1);
    }

    void bind_output() {
        gl_.BindFramebuffer(GL_FRAMEBUFFER, accumulate_ ? output_.framebuffer : scene_.framebuffer);
        gl_.Viewport(0, 0, width_, height_);
    }

    // Starts reading the finished frame into `slot` of the ring.
    void read_back(size_t slot) {
        bind_output();
        gl_.PixelStorei(GL_PACK_ALIGNMENT, 1);
        gl_.BindBuffer(GL_PIXEL_PACK_BUFFER, pixel_buffers_[slot]);
        gl_.ReadPixels(0, 0, width_, height_, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
        gl_.BindBuffer(GL_PIXEL_PACK_BUFFER, 0);
        if (fences_[slot]) gl_.DeleteSync(fences_[slot]);
        fences_[slot] = gl_.FenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (gl_.GetError() != GL_NO_ERROR) throw std::runtime_error("OpenGL video capture failed");
    }

    bool pending(size_t slot) const { return fences_[slot] != nullptr; }

    // Waits for the read in `slot` and copies the frame (bottom row first) into `pixels`.
    void collect(size_t slot, std::vector<uint8_t> &pixels) {
        constexpr GLuint64 wait_nanoseconds = 5'000'000'000;
        if (!fences_[slot]) throw std::runtime_error("No video frame is waiting in that slot");
        const auto waited = gl_.ClientWaitSync(fences_[slot], GL_SYNC_FLUSH_COMMANDS_BIT, wait_nanoseconds);
        gl_.DeleteSync(fences_[slot]);
        fences_[slot] = nullptr;
        if (waited == GL_WAIT_FAILED || waited == GL_TIMEOUT_EXPIRED)
            throw std::runtime_error("The GPU did not finish a video frame");
        const size_t size = frame_bytes();
        pixels.resize(size);
        gl_.BindBuffer(GL_PIXEL_PACK_BUFFER, pixel_buffers_[slot]);
        const void *mapped = gl_.MapBufferRange(GL_PIXEL_PACK_BUFFER, 0, GLsizeiptr(size), GL_MAP_READ_BIT);
        if (!mapped) {
            gl_.BindBuffer(GL_PIXEL_PACK_BUFFER, 0);
            throw std::runtime_error("Cannot map a video frame");
        }
        std::memcpy(pixels.data(), mapped, size);
        gl_.UnmapBuffer(GL_PIXEL_PACK_BUFFER);
        gl_.BindBuffer(GL_PIXEL_PACK_BUFFER, 0);
    }

    size_t frame_bytes() const { return size_t(width_) * height_ * 4; }

private:
    struct Target {
        GLuint framebuffer = 0, color = 0, depth = 0;
    };

    Gl &gl_;
    int width_, height_, render_width_, render_height_;
    bool accumulate_;
    Target scene_, accumulation_, output_;
    GLuint program_ = 0, vertex_array_ = 0;
    GLint weight_location_ = -1, image_location_ = -1;
    std::array<GLuint, readback_slots> pixel_buffers_{};
    std::array<GLsync, readback_slots> fences_{};

    void create() {
        scene_ = target(render_width_, render_height_, GL_RGBA8, true);
        if (accumulate_) {
            accumulation_ = target(render_width_, render_height_, GL_RGBA16F, false);
            output_ = target(width_, height_, GL_RGBA8, false);
            create_program();
        }
        gl_.GenBuffers(GLsizei(pixel_buffers_.size()), pixel_buffers_.data());
        for (const GLuint buffer : pixel_buffers_) {
            gl_.BindBuffer(GL_PIXEL_PACK_BUFFER, buffer);
            gl_.BufferData(GL_PIXEL_PACK_BUFFER, GLsizeiptr(frame_bytes()), nullptr, GL_STREAM_READ);
        }
        gl_.BindBuffer(GL_PIXEL_PACK_BUFFER, 0);
        gl_.BindFramebuffer(GL_FRAMEBUFFER, 0);
        if (gl_.GetError() != GL_NO_ERROR) throw std::runtime_error("Cannot create the video frame targets");
    }

    Target target(int width, int height, GLenum format, bool depth) {
        Target result;
        gl_.GenFramebuffers(1, &result.framebuffer);
        gl_.BindFramebuffer(GL_FRAMEBUFFER, result.framebuffer);
        gl_.GenTextures(1, &result.color);
        gl_.BindTexture(GL_TEXTURE_2D, result.color);
        const GLenum type = format == GL_RGBA16F ? GL_HALF_FLOAT : GL_UNSIGNED_BYTE;
        gl_.TexImage2D(GL_TEXTURE_2D, 0, GLint(format), width, height, 0, GL_RGBA, type, nullptr);
        gl_.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        gl_.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        gl_.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        gl_.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        gl_.FramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, result.color, 0);
        if (depth) {
            gl_.GenRenderbuffers(1, &result.depth);
            gl_.BindRenderbuffer(GL_RENDERBUFFER, result.depth);
            gl_.RenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, width, height);
            gl_.FramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, result.depth);
        }
        if (gl_.CheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
            throw std::runtime_error("Video capture framebuffer is unavailable");
        return result;
    }

    void create_program() {
        static constexpr const char *vertex = R"(#version 330 core
out vec2 uv;
void main() {
    vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    uv = corner;
    gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
})";
        static constexpr const char *fragment = R"(#version 330 core
in vec2 uv;
out vec4 color;
uniform sampler2D image;
uniform float weight;
void main() {
    color = texture(image, uv) * weight;
})";
        program_ = link_program(gl_, vertex, fragment);
        weight_location_ = gl_.GetUniformLocation(program_, "weight");
        image_location_ = gl_.GetUniformLocation(program_, "image");
        gl_.GenVertexArrays(1, &vertex_array_);
    }

    void draw_texture(GLuint texture, float weight) {
        gl_.Disable(GL_DEPTH_TEST);
        gl_.Disable(GL_CULL_FACE);
        gl_.DepthMask(GL_FALSE);
        gl_.ColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
        gl_.UseProgram(program_);
        gl_.Uniform1f(weight_location_, weight);
        gl_.Uniform1i(image_location_, 0);
        gl_.ActiveTexture(GL_TEXTURE0);
        gl_.BindTexture(GL_TEXTURE_2D, texture);
        gl_.BindVertexArray(vertex_array_);
        gl_.DrawArrays(GL_TRIANGLES, 0, 3);
        gl_.DepthMask(GL_TRUE);
        gl_.Enable(GL_DEPTH_TEST);
    }

    void release_target(Target &value) {
        if (value.framebuffer) gl_.DeleteFramebuffers(1, &value.framebuffer);
        if (value.color) gl_.DeleteTextures(1, &value.color);
        if (value.depth) gl_.DeleteRenderbuffers(1, &value.depth);
        value = {};
    }

    void release() {
        for (auto &fence : fences_)
            if (fence) {
                gl_.DeleteSync(fence);
                fence = nullptr;
            }
        if (pixel_buffers_[0]) gl_.DeleteBuffers(GLsizei(pixel_buffers_.size()), pixel_buffers_.data());
        pixel_buffers_.fill(0);
        release_target(scene_);
        release_target(accumulation_);
        release_target(output_);
        if (program_) gl_.DeleteProgram(program_);
        if (vertex_array_) gl_.DeleteVertexArrays(1, &vertex_array_);
        program_ = vertex_array_ = 0;
    }
};

}  // namespace native
