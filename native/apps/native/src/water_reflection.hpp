#pragma once

// Reflections retain the world shaders' gamma-encoded colour at half resolution, like Source water.
class WaterReflectionTarget {
    static constexpr float scale = .5f;
    static constexpr int max_size = 2048;

    gfx::Context &context;
    gfx::RenderTarget target;
    gfx::Sampler sampler;
    gfx::Pipeline clearPipeline;
    int width_ = 0, height_ = 0;

    void allocate(int width, int height) {
        context.destroy(target);
        target = context.create_target({width, height, gfx::Format::rgba16f, gfx::Format::depth24});
        width_ = width;
        height_ = height;
    }

public:
    explicit WaterReflectionTarget(gfx::Context &graphics) : context(graphics) {
        sampler = context.create_sampler({});
        clearPipeline = context.create_pipeline({});
    }

    WaterReflectionTarget(const WaterReflectionTarget &) = delete;
    WaterReflectionTarget &operator=(const WaterReflectionTarget &) = delete;

    ~WaterReflectionTarget() {
        context.destroy(target);
        context.destroy(sampler);
        context.destroy(clearPipeline);
    }

    void begin(int frame_width, int frame_height) {
        const int width = std::clamp(int(std::lround(frame_width * scale)), 1, max_size);
        const int height = std::clamp(int(std::lround(frame_height * scale)), 1, max_size);
        if (width != width_ || height != height_) allocate(width, height);
        context.bind_target(target);
        context.viewport({0, 0, width, height});
        context.pipeline(clearPipeline);
        context.clear_color({0, 0, 0, 0});
        context.clear_depth();
    }

    void bind(unsigned unit) { context.bind_texture(unit, target.color, sampler); }

    gfx::Texture texture() const { return target.color; }

    int width() const { return width_; }

    int height() const { return height_; }
};
