#pragma once
#include "gfx_types.hpp"
#include <memory>

namespace native::gfx {
// The presenter retains device, immediate-context, swapchain and Present ownership.
struct D3D11Device {
    void *device = nullptr, *immediate_context = nullptr;
};

class D3D11Context {
    struct Impl;
    std::unique_ptr<Impl> impl_;

public:
    explicit D3D11Context(D3D11Device borrowed);
    ~D3D11Context();
    D3D11Context(const D3D11Context &) = delete;
    D3D11Context &operator=(const D3D11Context &) = delete;
    static std::unique_ptr<D3D11Context> warp();
    int max_texture_size() const;
    void check_error(const char *message);
    Program create_program(const ProgramDesc &source);
    void destroy(Program &program);
    void bind_program(Program program);
    ConstantBinding create_constants(Program program, const ConstantLayout &layout);
    void constants(const ConstantBinding &binding, const void *bytes);
    void texture_unit(Program program, const char *name, unsigned unit);
    Pipeline create_pipeline(const PipelineState &state);
    void destroy(Pipeline &pipeline);
    void pipeline(const Pipeline &pipeline);
    void depth_write(bool enabled);
    void depth_test(bool enabled);
    void blend(bool enabled);
    Texture create_texture(const TextureDesc &desc, std::span<const void *const> faces = {});
    void generate_mips(Texture texture);
    void destroy(Texture &texture);
    Sampler create_sampler(const SamplerDesc &desc);
    void destroy(Sampler &sampler);
    void bind_texture(unsigned slot, Texture texture, Sampler sampler = {});
    void unbind_sampler(unsigned slot);
    RenderTarget create_target(const TargetDesc &desc);
    void destroy(RenderTarget &target);
    // RTV/DSV remain valid until the presenter resizes. Reborrow after each resize.
    static TargetView borrow_target(void *rtv, const TargetDesc &desc, void *dsv = nullptr);
    void bind_target(const TargetView &target);
    void viewport(Rect rect);
    void clear_color(std::array<float, 4> color);
    void clear_depth();
    void resolve_color(const TargetView &source, const TargetView &destination);
    void resolve_depth(const TargetView &source, const TargetView &destination);
    void copy_color(const TargetView &source, Rect region, Texture destination, int x = 0, int y = 0);
    Geometry create_geometry(size_t stride, std::span<const VertexAttribute> attributes);
    void destroy(Geometry &geometry);
    void bind_geometry(Geometry geometry);
    void stream_vertices(Geometry geometry, std::span<const std::byte> data);
    void upload_indices(Geometry &geometry, std::span<const std::byte> data);
    void draw(Primitive topology, int first, int count);
    void draw_instanced(Primitive topology, int first, int count, int instances);
    void draw_indexed(Primitive topology, IndexType type, size_t byte_offset, int count, int instances = 1);
    Fence signal();
    Wait wait(Fence fence, uint64_t timeout_ns = 0, bool flush = false);
    void destroy(Fence &fence);
    Readback create_readback(int width, int height, Format format = Format::rgba8);
    static size_t readback_bytes(const Readback &readback);
    void enqueue_readback(const TargetView &source, Readback &readback, int x = 0, int y = 0);
    bool pending(const Readback &readback) const;
    Wait poll(const Readback &readback);
    MappedPixels map(Readback &readback);
    void unmap(Readback &readback);
    void collect(Readback &readback, std::span<std::byte> destination, RowOrigin origin, uint64_t timeout_ns);
    void destroy(Readback &readback);
};
}  // namespace native::gfx
