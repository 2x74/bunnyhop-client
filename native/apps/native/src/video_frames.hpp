#pragma once
#include "gfx.hpp"
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

    VideoFrameTargets(gfx::Context &context, int width, int height, int supersample, int samples)
        : context_(context)
        , width_(width)
        , height_(height)
        , render_width_(width * supersample)
        , render_height_(height * supersample)
        , accumulate_(supersample > 1 || samples > 1) {
        const int limit = context_.max_texture_size();
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
        context_.bind_target(accumulation_);
        context_.viewport({0, 0, render_width_, render_height_});
        context_.clear_color({0, 0, 0, 0});
    }

    void bind_scene() {
        context_.bind_target(scene_);
        context_.viewport({0, 0, render_width_, render_height_});
    }

    // Adds the scene just drawn into the accumulation, weighted so `count` samples average.
    void add_sample(int count) {
        if (!accumulate_) return;
        context_.bind_target(accumulation_);
        context_.viewport({0, 0, render_width_, render_height_});
        draw_texture(scene_.color, 1.f / float(count), true);
        context_.blend(false);
    }

    // The averaged samples at video size; with 2x supersampling each pixel is the mean of its four.
    void resolve() {
        if (!accumulate_) return;
        context_.bind_target(output_);
        context_.viewport({0, 0, width_, height_});
        draw_texture(accumulation_.color, 1, false);
    }

    void bind_output() {
        context_.bind_target(accumulate_ ? output_ : scene_);
        context_.viewport({0, 0, width_, height_});
    }

    // Starts reading the finished frame into `slot` of the ring.
    void read_back(size_t slot) {
        bind_output();
        context_.enqueue_readback(accumulate_ ? output_ : scene_, readbacks_.at(slot));
    }

    bool pending(size_t slot) const { return context_.pending(readbacks_.at(slot)); }

    // Waits for the read in `slot` and copies the frame (bottom row first) into `pixels`.
    void collect(size_t slot, std::vector<uint8_t> &pixels) {
        constexpr uint64_t wait_nanoseconds = 5'000'000'000;
        pixels.resize(frame_bytes());
        context_.collect(
                readbacks_.at(slot), std::as_writable_bytes(std::span(pixels)), gfx::RowOrigin::bottom, wait_nanoseconds
        );
    }

    size_t frame_bytes() const { return size_t(width_) * height_ * 4; }

private:
    gfx::Context &context_;
    int width_, height_, render_width_, render_height_;
    bool accumulate_;
    gfx::RenderTarget scene_, accumulation_, output_;
    gfx::Program program_;
    gfx::Geometry geometry_;
    gfx::Sampler sampler_;
    gfx::Pipeline additive_pipeline_, resolve_pipeline_;
    gfx::ConstantBinding constants_;
    std::array<gfx::Readback, readback_slots> readbacks_{};

    void create() {
        scene_ = context_.create_target({render_width_, render_height_, gfx::Format::rgba8, gfx::Format::depth24});
        if (accumulate_) {
            accumulation_ = context_.create_target({render_width_, render_height_, gfx::Format::rgba16f});
            output_ = context_.create_target({width_, height_, gfx::Format::rgba8});
            create_program();
        }
        for (auto &readback : readbacks_)
            readback = context_.create_readback(width_, height_);
        context_.bind_target({});
        context_.check_error("Cannot create the video frame targets");
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
        program_ = context_.create_program({{"video", ""}, vertex, fragment});
        static constexpr gfx::ConstantField fields[] = {{"weight", 0, 4, gfx::ConstantType::float1}};
        constants_ = context_.create_constants(program_, {fields, 16});
        context_.texture_unit(program_, "image", 0);
        geometry_ = context_.create_geometry(0, {});
        sampler_ = context_.create_sampler({});
        additive_pipeline_ =
                context_.create_pipeline({{true, gfx::BlendFactor::one, gfx::BlendFactor::one}, {false, false}, {}});
        resolve_pipeline_ = context_.create_pipeline({{}, {false, false}, {}});
    }

    void draw_texture(gfx::Texture texture, float weight, bool additive) {
        context_.pipeline(additive ? additive_pipeline_ : resolve_pipeline_);
        context_.bind_program(program_);
        const std::array<float, 4> block = {weight, 0, 0, 0};
        context_.constants(constants_, block.data());
        context_.bind_texture(0, texture, sampler_);
        context_.bind_geometry(geometry_);
        context_.draw(gfx::Primitive::triangles, 0, 3);
        context_.unbind_sampler(0);
        context_.depth_write(true);
        context_.depth_test(true);
    }

    void release() {
        for (auto &readback : readbacks_)
            context_.destroy(readback);
        context_.destroy(scene_);
        context_.destroy(accumulation_);
        context_.destroy(output_);
        context_.destroy(program_);
        context_.destroy(geometry_);
        context_.destroy(sampler_);
        context_.destroy(additive_pipeline_);
        context_.destroy(resolve_pipeline_);
    }
};

}  // namespace native
