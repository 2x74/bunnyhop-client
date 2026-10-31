#pragma once
#include "gfx_types.hpp"
#include "gfx_opengl.hpp"
#if defined(_WIN32) || defined(BUNNYHOP_GFX_DISPATCH)
#include "gfx_d3d11.hpp"
#include <optional>

namespace native::gfx {
class Context {
    Backend backend_;
    std::optional<OpenGlContext> opengl_;
    D3D11Context *d3d11_ = nullptr;

public:
    explicit Context(Gl &gl, D3D11Context *d3d11 = nullptr, Backend requested = Backend::opengl)
        : backend_(requested == Backend::d3d11 && d3d11 ? Backend::d3d11 : Backend::opengl)
        , opengl_(std::in_place, gl)
        , d3d11_(d3d11) {}

    explicit Context(D3D11Context &context) : backend_(Backend::d3d11), d3d11_(&context) {}

    Backend backend() const { return backend_; }

    static TargetView window_target(int width, int height) { return OpenGlContext::window_target(width, height); }

    static TargetView borrow_target(uintptr_t framebuffer, const TargetDesc &desc) {
        return OpenGlContext::borrow_target(framebuffer, desc);
    }

    static TargetView borrow_d3d11_target(void *rtv, const TargetDesc &desc, void *dsv = nullptr) {
        return D3D11Context::borrow_target(rtv, desc, dsv);
    }

    static size_t readback_bytes(const Readback &readback) { return OpenGlContext::readback_bytes(readback); }

    int max_texture_size() const {
        if (backend_ == Backend::opengl) return opengl_->max_texture_size();
        return d3d11_->max_texture_size();
    }

    void check_error(const char *message) {
        if (backend_ == Backend::opengl) return opengl_->check_error(message);
        return d3d11_->check_error(message);
    }

    Program create_program(const ProgramDesc &source) {
        if (backend_ == Backend::opengl) return opengl_->create_program(source);
        return d3d11_->create_program(source);
    }

    void destroy(Program &program) {
        if (backend_ == Backend::opengl) return opengl_->destroy(program);
        return d3d11_->destroy(program);
    }

    void bind_program(Program program) {
        if (backend_ == Backend::opengl) return opengl_->bind_program(program);
        return d3d11_->bind_program(program);
    }

    ConstantBinding create_constants(Program program, const ConstantLayout &layout) {
        if (backend_ == Backend::opengl) return opengl_->create_constants(program, layout);
        return d3d11_->create_constants(program, layout);
    }

    void constants(const ConstantBinding &binding, const void *bytes) {
        if (backend_ == Backend::opengl) return opengl_->constants(binding, bytes);
        return d3d11_->constants(binding, bytes);
    }

    void texture_unit(Program program, const char *name, unsigned unit) {
        if (backend_ == Backend::opengl) return opengl_->texture_unit(program, name, unit);
        return d3d11_->texture_unit(program, name, unit);
    }

    Pipeline create_pipeline(const PipelineState &state) {
        if (backend_ == Backend::opengl) return opengl_->create_pipeline(state);
        return d3d11_->create_pipeline(state);
    }

    void destroy(Pipeline &pipeline) {
        if (backend_ == Backend::opengl) return opengl_->destroy(pipeline);
        return d3d11_->destroy(pipeline);
    }

    void pipeline(const Pipeline &pipeline) {
        if (backend_ == Backend::opengl) return opengl_->pipeline(pipeline);
        return d3d11_->pipeline(pipeline);
    }

    void depth_write(bool enabled) {
        if (backend_ == Backend::opengl) return opengl_->depth_write(enabled);
        return d3d11_->depth_write(enabled);
    }

    void depth_test(bool enabled) {
        if (backend_ == Backend::opengl) return opengl_->depth_test(enabled);
        return d3d11_->depth_test(enabled);
    }

    void blend(bool enabled) {
        if (backend_ == Backend::opengl) return opengl_->blend(enabled);
        return d3d11_->blend(enabled);
    }

    Texture create_texture(const TextureDesc &desc, std::span<const void *const> faces = {}) {
        if (backend_ == Backend::opengl) return opengl_->create_texture(desc, faces);
        return d3d11_->create_texture(desc, faces);
    }

    void generate_mips(Texture texture) {
        if (backend_ == Backend::opengl) return opengl_->generate_mips(texture);
        return d3d11_->generate_mips(texture);
    }

    void destroy(Texture &texture) {
        if (backend_ == Backend::opengl) return opengl_->destroy(texture);
        return d3d11_->destroy(texture);
    }

    Sampler create_sampler(const SamplerDesc &desc) {
        if (backend_ == Backend::opengl) return opengl_->create_sampler(desc);
        return d3d11_->create_sampler(desc);
    }

    void destroy(Sampler &sampler) {
        if (backend_ == Backend::opengl) return opengl_->destroy(sampler);
        return d3d11_->destroy(sampler);
    }

    void bind_texture(unsigned slot, Texture texture, Sampler sampler = {}) {
        if (backend_ == Backend::opengl) return opengl_->bind_texture(slot, texture, sampler);
        return d3d11_->bind_texture(slot, texture, sampler);
    }

    void unbind_sampler(unsigned slot) {
        if (backend_ == Backend::opengl) return opengl_->unbind_sampler(slot);
        return d3d11_->unbind_sampler(slot);
    }

    RenderTarget create_target(const TargetDesc &desc) {
        if (backend_ == Backend::opengl) return opengl_->create_target(desc);
        return d3d11_->create_target(desc);
    }

    void destroy(RenderTarget &target) {
        if (backend_ == Backend::opengl) return opengl_->destroy(target);
        return d3d11_->destroy(target);
    }

    void bind_target(const TargetView &target) {
        if (backend_ == Backend::opengl) return opengl_->bind_target(target);
        return d3d11_->bind_target(target);
    }

    void viewport(Rect rect) {
        if (backend_ == Backend::opengl) return opengl_->viewport(rect);
        return d3d11_->viewport(rect);
    }

    void clear_color(std::array<float, 4> color) {
        if (backend_ == Backend::opengl) return opengl_->clear_color(color);
        return d3d11_->clear_color(color);
    }

    void clear_depth() {
        if (backend_ == Backend::opengl) return opengl_->clear_depth();
        return d3d11_->clear_depth();
    }

    void resolve_color(const TargetView &source, const TargetView &destination) {
        if (backend_ == Backend::opengl) return opengl_->resolve_color(source, destination);
        return d3d11_->resolve_color(source, destination);
    }

    void resolve_depth(const TargetView &source, const TargetView &destination) {
        if (backend_ == Backend::opengl) return opengl_->resolve_depth(source, destination);
        return d3d11_->resolve_depth(source, destination);
    }

    void copy_color(const TargetView &source, Rect region, Texture destination, int x = 0, int y = 0) {
        if (backend_ == Backend::opengl) return opengl_->copy_color(source, region, destination, x, y);
        return d3d11_->copy_color(source, region, destination, x, y);
    }

    Geometry create_geometry(size_t stride, std::span<const VertexAttribute> attributes) {
        if (backend_ == Backend::opengl) return opengl_->create_geometry(stride, attributes);
        return d3d11_->create_geometry(stride, attributes);
    }

    void destroy(Geometry &geometry) {
        if (backend_ == Backend::opengl) return opengl_->destroy(geometry);
        return d3d11_->destroy(geometry);
    }

    void bind_geometry(Geometry geometry) {
        if (backend_ == Backend::opengl) return opengl_->bind_geometry(geometry);
        return d3d11_->bind_geometry(geometry);
    }

    void stream_vertices(Geometry geometry, std::span<const std::byte> data) {
        if (backend_ == Backend::opengl) return opengl_->stream_vertices(geometry, data);
        return d3d11_->stream_vertices(geometry, data);
    }

    void upload_indices(Geometry &geometry, std::span<const std::byte> data) {
        if (backend_ == Backend::opengl) return opengl_->upload_indices(geometry, data);
        return d3d11_->upload_indices(geometry, data);
    }

    void draw(Primitive topology, int first, int count) {
        if (backend_ == Backend::opengl) return opengl_->draw(topology, first, count);
        return d3d11_->draw(topology, first, count);
    }

    void draw_instanced(Primitive topology, int first, int count, int instances) {
        if (backend_ == Backend::opengl) return opengl_->draw_instanced(topology, first, count, instances);
        return d3d11_->draw_instanced(topology, first, count, instances);
    }

    void draw_indexed(Primitive topology, IndexType type, size_t byte_offset, int count, int instances = 1) {
        if (backend_ == Backend::opengl) return opengl_->draw_indexed(topology, type, byte_offset, count, instances);
        return d3d11_->draw_indexed(topology, type, byte_offset, count, instances);
    }

    Fence signal() {
        if (backend_ == Backend::opengl) return opengl_->signal();
        return d3d11_->signal();
    }

    Wait wait(Fence fence, uint64_t timeout_ns = 0, bool flush = false) {
        if (backend_ == Backend::opengl) return opengl_->wait(fence, timeout_ns, flush);
        return d3d11_->wait(fence, timeout_ns, flush);
    }

    void destroy(Fence &fence) {
        if (backend_ == Backend::opengl) return opengl_->destroy(fence);
        return d3d11_->destroy(fence);
    }

    Readback create_readback(int width, int height, Format format = Format::rgba8) {
        if (backend_ == Backend::opengl) return opengl_->create_readback(width, height, format);
        return d3d11_->create_readback(width, height, format);
    }

    void enqueue_readback(const TargetView &source, Readback &readback, int x = 0, int y = 0) {
        if (backend_ == Backend::opengl) return opengl_->enqueue_readback(source, readback, x, y);
        return d3d11_->enqueue_readback(source, readback, x, y);
    }

    bool pending(const Readback &readback) const {
        if (backend_ == Backend::opengl) return opengl_->pending(readback);
        return d3d11_->pending(readback);
    }

    Wait poll(const Readback &readback) {
        if (backend_ == Backend::opengl) return opengl_->poll(readback);
        return d3d11_->poll(readback);
    }

    MappedPixels map(Readback &readback) {
        if (backend_ == Backend::opengl) return opengl_->map(readback);
        return d3d11_->map(readback);
    }

    void unmap(Readback &readback) {
        if (backend_ == Backend::opengl) return opengl_->unmap(readback);
        return d3d11_->unmap(readback);
    }

    void collect(Readback &readback, std::span<std::byte> destination, RowOrigin origin, uint64_t timeout_ns) {
        if (backend_ == Backend::opengl) return opengl_->collect(readback, destination, origin, timeout_ns);
        return d3d11_->collect(readback, destination, origin, timeout_ns);
    }

    void destroy(Readback &readback) {
        if (backend_ == Backend::opengl) return opengl_->destroy(readback);
        return d3d11_->destroy(readback);
    }
};
}  // namespace native::gfx
#else
namespace native::gfx {
using Context = OpenGlContext;
}
#endif
