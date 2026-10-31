#pragma once

// Sun shadows cover a texel-snapped square around the camera so movement does not make their edges shimmer.

class SunShadowMap {
    gfx::Context &context;
    gfx::RenderTarget target;
    gfx::Sampler sampler;
    int size_ = 0;

    void allocate(int size) {
        context.destroy(target);
        target = context.create_target({size, size, gfx::Format::none, gfx::Format::depth24});
        size_ = size;
    }

public:
    explicit SunShadowMap(gfx::Context &graphics) : context(graphics) {
        const auto restore = context.current_target();
        gfx::SamplerDesc sampling;
        sampling.compare = true;
        sampler = context.create_sampler(sampling);
        // The shader needs a depth input even before the first shadow frame.
        allocate(1);
        context.bind_target(restore);
    }

    SunShadowMap(const SunShadowMap &) = delete;
    SunShadowMap &operator=(const SunShadowMap &) = delete;

    ~SunShadowMap() {
        context.destroy(target);
        context.destroy(sampler);
    }

    void begin(int size) {
        if (size != size_) allocate(size);
        context.bind_target(target);
        context.viewport({0, 0, size_, size_});
        context.depth_write(true);
        context.clear_depth();
    }

    void bind(unsigned unit) { context.bind_texture(unit, target.depth, sampler); }

    int size() const { return size_; }
};
