#pragma once
#include "gfx_types.hpp"
#include "gfx_gl_api.hpp"
#include <algorithm>
#include <cstring>
#include <string>
#include <vector>

namespace native::gfx {
class OpenGlContext {
    Gl &gl_;
    TargetView target_;

    template <typename Function>
    static uintptr_t generate(Function function) {
        GLuint name = 0;
        function(1, &name);
        return name;
    }

    template <typename Function>
    static void release(Function function, uintptr_t value) {
        const auto name = GLuint(value);
        function(1, &name);
    }

    struct PixelFormat {
        GLenum internal, channels, type;
        size_t bytes;
    };

    static PixelFormat pixel_format(Format format) {
        switch (format) {
            case Format::r8:
                return {GL_R8, GL_RED, GL_UNSIGNED_BYTE, 1};
            case Format::rgba8:
                return {GL_RGBA8, GL_RGBA, GL_UNSIGNED_BYTE, 4};
            case Format::rgba16f:
                return {GL_RGBA16F, GL_RGBA, GL_HALF_FLOAT, 8};
            case Format::rgba32f:
                return {GL_RGBA32F, GL_RGBA, GL_FLOAT, 16};
            case Format::r32f:
                return {GL_R32F, GL_RED, GL_FLOAT, 4};
            case Format::depth24:
                return {GL_DEPTH_COMPONENT24, GL_DEPTH_COMPONENT, GL_FLOAT, 4};
            case Format::depth32f:
                return {GL_DEPTH_COMPONENT32F, GL_DEPTH_COMPONENT, GL_FLOAT, 4};
            case Format::depth24_stencil8:
                return {GL_DEPTH24_STENCIL8, GL_DEPTH_STENCIL, GL_UNSIGNED_INT_24_8, 4};
            default:
                throw std::runtime_error("Missing texture format");
        }
    }

    static GLenum texture_target(const TextureDesc &desc) {
        if (desc.samples > 1) return GL_TEXTURE_2D_MULTISAMPLE;
        return desc.kind == TextureKind::cube ? GL_TEXTURE_CUBE_MAP : GL_TEXTURE_2D;
    }

    static GLenum comparison(Compare value) {
        if (value == Compare::less) return GL_LESS;
        return value == Compare::less_equal ? GL_LEQUAL : GL_ALWAYS;
    }

    static GLenum factor(BlendFactor value) {
        switch (value) {
            case BlendFactor::zero:
                return GL_ZERO;
            case BlendFactor::one:
                return GL_ONE;
            case BlendFactor::source_alpha:
                return GL_SRC_ALPHA;
            case BlendFactor::inverse_source_alpha:
                return GL_ONE_MINUS_SRC_ALPHA;
        }
        return GL_ONE;
    }

    static GLenum primitive(Primitive value) {
        if (value == Primitive::lines) return GL_LINES;
        return value == Primitive::triangle_strip ? GL_TRIANGLE_STRIP : GL_TRIANGLES;
    }

    void enabled(GLenum capability, bool value) {
        if (value)
            gl_.Enable(capability);
        else
            gl_.Disable(capability);
    }

    void attach(GLenum attachment, const Texture &texture) {
        if (texture.id)
            gl_.FramebufferTexture2D(GL_FRAMEBUFFER, attachment, texture_target(texture.desc), texture.id, 0);
    }

    void blit(const TargetView &source, const TargetView &destination, GLbitfield mask) {
        gl_.BindFramebuffer(GL_READ_FRAMEBUFFER, source.id);
        gl_.BindFramebuffer(GL_DRAW_FRAMEBUFFER, destination.id);
        target_ = destination;
        gl_.BlitFramebuffer(
                0,
                0,
                source.desc.width,
                source.desc.height,
                0,
                0,
                destination.desc.width,
                destination.desc.height,
                mask,
                GL_NEAREST
        );
    }

public:
    explicit OpenGlContext(Gl &gl) : gl_(gl) {}

    static Backend backend() { return Backend::opengl; }

    int max_samples(Format color = Format::rgba8, Format depth = Format::depth24) const {
        GLint result = 1, limit = 1;
        gl_.GetIntegerv(GL_MAX_SAMPLES, &result);
        if (color != Format::none) {
            gl_.GetIntegerv(GL_MAX_COLOR_TEXTURE_SAMPLES, &limit);
            result = std::min(result, limit);
        }
        if (depth != Format::none) {
            gl_.GetIntegerv(GL_MAX_DEPTH_TEXTURE_SAMPLES, &limit);
            result = std::min(result, limit);
        }
        return result;
    }

    TargetView current_target() const {
        GLint framebuffer = 0;
        gl_.GetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &framebuffer);
        if (uintptr_t(framebuffer) == target_.id) return target_;
        return {uintptr_t(framebuffer), {}};
    }

    int max_texture_size() const {
        GLint result = 0;
        gl_.GetIntegerv(GL_MAX_TEXTURE_SIZE, &result);
        return result;
    }

    void check_error(const char *message) {
        if (gl_.GetError() != GL_NO_ERROR) throw std::runtime_error(message);
    }

    Program create_program(const ProgramDesc &source) { return {link_program(gl_, source.vertex, source.fragment)}; }

    void destroy(Program &program) {
        if (program.id) gl_.DeleteProgram(program.id);
        program = {};
    }

    void bind_program(Program program) { gl_.UseProgram(program.id); }

    ConstantBinding create_constants(Program program, const ConstantLayout &layout) {
        ConstantBinding result;
        result.byte_size = layout.byte_size;
        for (const auto &field : layout.fields) {
            const uint32_t size = field.type == ConstantType::matrix4  ? 64
                                  : field.type == ConstantType::float4 ? 16
                                  : field.type == ConstantType::float3 ? 12
                                  : field.type == ConstantType::float2 ? 8
                                                                       : 4;
            const uint32_t stride = field.array_stride ? field.array_stride : size;
            if (!field.name || !field.count || field.offset % 4 || stride < size || stride % 4
                || field.size < uint64_t(field.count - 1) * stride + size
                || uint64_t(field.offset) + field.size > layout.byte_size
                || (field.type == ConstantType::matrix4 && field.matrix_stride != 16))
                throw std::runtime_error("Invalid reflected constant layout");
            for (uint32_t i = 0; i < field.count; ++i) {
                const std::string name =
                        field.count == 1 ? field.name : std::string(field.name) + "[" + std::to_string(i) + "]";
                result.fields.push_back(
                        {gl_.GetUniformLocation(program.id, name.c_str()), field.offset + i * stride, field.type}
                );
            }
        }
        return result;
    }

    // The matching program must be bound. Layout validation and name lookup happen at creation only.
    void constants(const ConstantBinding &binding, const void *bytes) {
        for (const auto &field : binding.fields) {
            const auto *data = static_cast<const std::byte *>(bytes) + field.offset;
            const auto *floats = reinterpret_cast<const float *>(data);
            switch (field.type) {
                case ConstantType::float1:
                    gl_.Uniform1f(field.location, *floats);
                    break;
                case ConstantType::float2:
                    gl_.Uniform2fv(field.location, 1, floats);
                    break;
                case ConstantType::float3:
                    gl_.Uniform3fv(field.location, 1, floats);
                    break;
                case ConstantType::float4:
                    gl_.Uniform4fv(field.location, 1, floats);
                    break;
                case ConstantType::int1:
                    gl_.Uniform1i(field.location, *reinterpret_cast<const int32_t *>(data));
                    break;
                case ConstantType::bool32:
                    gl_.Uniform1i(field.location, *reinterpret_cast<const uint32_t *>(data) != 0 ? 1 : 0);
                    break;
                case ConstantType::matrix4:
                    gl_.UniformMatrix4fv(field.location, 1, GL_FALSE, floats);
                    break;
            }
        }
    }

    void texture_unit(Program program, const char *name, unsigned unit) {
        bind_program(program);
        gl_.Uniform1i(gl_.GetUniformLocation(program.id, name), GLint(unit));
    }

    Pipeline create_pipeline(const PipelineState &state) { return {state}; }

    void destroy(Pipeline &pipeline) { pipeline = {}; }

    void pipeline(const Pipeline &pipeline) {
        const auto &state = pipeline.state;
        enabled(GL_BLEND, state.blend.enabled);
        gl_.BlendFunc(factor(state.blend.source), factor(state.blend.destination));
        enabled(GL_DEPTH_TEST, state.depth.test);
        gl_.DepthFunc(comparison(state.depth.compare));
        depth_write(state.depth.write);
        enabled(GL_CULL_FACE, state.raster.cull != Cull::none);
        if (state.raster.cull != Cull::none) gl_.CullFace(state.raster.cull == Cull::front ? GL_FRONT : GL_BACK);
        gl_.FrontFace(state.raster.winding == Winding::counter_clockwise ? GL_CCW : GL_CW);
        enabled(GL_POLYGON_OFFSET_FILL, state.raster.offset);
        if (state.raster.offset) gl_.PolygonOffset(state.raster.slope_bias, state.raster.constant_bias);
        const auto &write = state.color_write;
        gl_.ColorMask(write[0], write[1], write[2], write[3]);
    }

    void depth_write(bool enabled) { gl_.DepthMask(enabled ? GL_TRUE : GL_FALSE); }

    void depth_test(bool value) { enabled(GL_DEPTH_TEST, value); }

    void blend(bool value) { enabled(GL_BLEND, value); }

    Texture create_texture(const TextureDesc &desc, std::span<const void *const> faces = {}) {
        if (desc.width < 1 || desc.height < 1 || desc.samples < 1 || desc.levels < 1 || desc.levels > 31
            || (desc.samples > 1 && (desc.kind == TextureKind::cube || desc.levels != 1 || !faces.empty()))
            || (desc.kind == TextureKind::cube && desc.width != desc.height))
            throw std::runtime_error("Invalid texture dimensions");
        const size_t face_count = desc.kind == TextureKind::cube ? 6 : 1;
        if (!faces.empty() && faces.size() != face_count) throw std::runtime_error("Incomplete texture faces");
        const auto format = pixel_format(desc.format);
        Texture result{0, desc};
        result.id = generate(gl_.GenTextures);
        const GLenum target = texture_target(desc);
        gl_.BindTexture(target, result.id);
        if (desc.samples > 1) {
            gl_.TexImage2DMultisample(target, desc.samples, format.internal, desc.width, desc.height, GL_TRUE);
        } else {
            gl_.PixelStorei(GL_UNPACK_ALIGNMENT, 1);
            for (size_t face = 0; face < face_count; ++face)
                for (int level = 0; level < desc.levels; ++level)
                    gl_.TexImage2D(
                            desc.kind == TextureKind::cube ? GLenum(GL_TEXTURE_CUBE_MAP_POSITIVE_X + face) : target,
                            level,
                            GLint(format.internal),
                            std::max(1, desc.width >> level),
                            std::max(1, desc.height >> level),
                            0,
                            format.channels,
                            format.type,
                            level == 0 && !faces.empty() ? faces[face] : nullptr
                    );
            gl_.TexParameteri(target, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            gl_.TexParameteri(target, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            gl_.TexParameteri(target, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            gl_.TexParameteri(target, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            if (desc.kind == TextureKind::cube) gl_.TexParameteri(target, GL_TEXTURE_WRAP_R, GL_CLAMP_TO_EDGE);
        }
        return result;
    }

    void generate_mips(Texture texture) {
        const auto target = texture_target(texture.desc);
        gl_.BindTexture(target, texture.id);
        gl_.GenerateMipmap(target);
    }

    void destroy(Texture &texture) {
        if (texture.id) release(gl_.DeleteTextures, texture.id);
        texture = {};
    }

    Sampler create_sampler(const SamplerDesc &desc) {
        Sampler result;
        result.id = generate(gl_.GenSamplers);
        GLenum minification = desc.minification == Filter::linear ? GL_LINEAR : GL_NEAREST;
        if (desc.mipmapped) {
            if (desc.minification == Filter::linear)
                minification = desc.mip_filter == Filter::linear ? GL_LINEAR_MIPMAP_LINEAR : GL_LINEAR_MIPMAP_NEAREST;
            else
                minification = desc.mip_filter == Filter::linear ? GL_NEAREST_MIPMAP_LINEAR : GL_NEAREST_MIPMAP_NEAREST;
        }
        gl_.SamplerParameteri(result.id, GL_TEXTURE_MIN_FILTER, GLint(minification));
        gl_.SamplerParameteri(
                result.id, GL_TEXTURE_MAG_FILTER, desc.magnification == Filter::linear ? GL_LINEAR : GL_NEAREST
        );
        const GLenum address = desc.address == Address::clamp    ? GL_CLAMP_TO_EDGE
                               : desc.address == Address::mirror ? GL_MIRRORED_REPEAT
                               : desc.address == Address::border ? GL_CLAMP_TO_BORDER
                                                                 : GL_REPEAT;
        gl_.SamplerParameteri(result.id, GL_TEXTURE_WRAP_S, address);
        gl_.SamplerParameteri(result.id, GL_TEXTURE_WRAP_T, address);
        gl_.SamplerParameteri(result.id, GL_TEXTURE_WRAP_R, address);
        gl_.SamplerParameteri(result.id, GL_TEXTURE_COMPARE_MODE, desc.compare ? GL_COMPARE_REF_TO_TEXTURE : GL_NONE);
        gl_.SamplerParameteri(result.id, GL_TEXTURE_COMPARE_FUNC, comparison(desc.comparison));
        gl_.SamplerParameterf(result.id, GL_TEXTURE_MIN_LOD, desc.min_lod);
        gl_.SamplerParameterf(result.id, GL_TEXTURE_MAX_LOD, desc.max_lod);
        gl_.SamplerParameterfv(result.id, GL_TEXTURE_BORDER_COLOR, desc.border_color.data());
        return result;
    }

    void destroy(Sampler &sampler) {
        if (sampler.id) release(gl_.DeleteSamplers, sampler.id);
        sampler = {};
    }

    void bind_texture(unsigned slot, Texture texture, Sampler sampler = {}) {
        gl_.ActiveTexture(GL_TEXTURE0 + slot);
        gl_.BindTexture(texture_target(texture.desc), texture.id);
        gl_.BindSampler(slot, sampler.id);
    }

    void unbind_sampler(unsigned slot) { gl_.BindSampler(slot, 0); }

    RenderTarget create_target(const TargetDesc &desc) {
        RenderTarget result;
        result.desc = desc;
        try {
            result.id = generate(gl_.GenFramebuffers);
            gl_.BindFramebuffer(GL_FRAMEBUFFER, result.id);
            if (desc.color != Format::none)
                result.color = create_texture({desc.width, desc.height, desc.color, TextureKind::image, desc.samples});
            if (desc.depth != Format::none)
                result.depth = create_texture({desc.width, desc.height, desc.depth, TextureKind::image, desc.samples});
            attach(GL_COLOR_ATTACHMENT0, result.color);
            attach(desc.depth == Format::depth24_stencil8 ? GL_DEPTH_STENCIL_ATTACHMENT : GL_DEPTH_ATTACHMENT,
                   result.depth);
            if (desc.color == Format::none) {
                gl_.DrawBuffer(GL_NONE);
                gl_.ReadBuffer(GL_NONE);
            }
            if (gl_.CheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
                throw std::runtime_error("Render target is incomplete");
        } catch (...) {
            destroy(result);
            throw;
        }
        target_ = result;
        return result;
    }

    void destroy(RenderTarget &target) {
        if (target_.id == target.id) target_ = {};
        if (target.id) release(gl_.DeleteFramebuffers, target.id);
        destroy(target.color);
        destroy(target.depth);
        target = {};
    }

    static TargetView window_target(int width, int height) { return {0, {width, height}}; }

    // Borrowed WGL interop targets stay owned by LowLatencyPresenter.
    static TargetView borrow_target(uintptr_t framebuffer, const TargetDesc &desc) { return {framebuffer, desc}; }

    void bind_target(const TargetView &target) {
        gl_.BindFramebuffer(GL_FRAMEBUFFER, target.id);
        target_ = target;
    }

    void viewport(Rect rect) { gl_.Viewport(rect.x, rect.y, rect.width, rect.height); }

    void clear_color(std::array<float, 4> color) {
        gl_.ClearColor(color[0], color[1], color[2], color[3]);
        gl_.Clear(GL_COLOR_BUFFER_BIT);
    }

    void clear_depth() { gl_.Clear(GL_DEPTH_BUFFER_BIT); }

    void resolve_color(const TargetView &source, const TargetView &destination) {
        blit(source, destination, GL_COLOR_BUFFER_BIT);
    }

    // Matches the existing GL blit: the implementation selects a depth sample, never averages depth.
    void resolve_depth(const TargetView &source, const TargetView &destination) {
        blit(source, destination, GL_DEPTH_BUFFER_BIT);
    }

    void copy_color(const TargetView &source, Rect region, Texture destination, int x = 0, int y = 0) {
        gl_.BindFramebuffer(GL_READ_FRAMEBUFFER, source.id);
        gl_.BindTexture(texture_target(destination.desc), destination.id);
        gl_.CopyTexSubImage2D(
                texture_target(destination.desc), 0, x, y, region.x, region.y, region.width, region.height
        );
    }

    Geometry create_geometry(size_t stride, std::span<const VertexAttribute> attributes) {
        Geometry result;
        result.array = generate(gl_.GenVertexArrays);
        result.vertices = generate(gl_.GenBuffers);
        gl_.BindVertexArray(result.array);
        gl_.BindBuffer(GL_ARRAY_BUFFER, result.vertices);
        for (const auto &attribute : attributes) {
            gl_.EnableVertexAttribArray(attribute.location);
            gl_.VertexAttribPointer(
                    attribute.location,
                    GLint(attribute.components),
                    GL_FLOAT,
                    GL_FALSE,
                    GLsizei(stride),
                    reinterpret_cast<const void *>(attribute.offset)
            );
            gl_.VertexAttribDivisor(attribute.location, attribute.instance_step);
        }
        return result;
    }

    void destroy(Geometry &geometry) {
        if (geometry.vertices) release(gl_.DeleteBuffers, geometry.vertices);
        if (geometry.indices) release(gl_.DeleteBuffers, geometry.indices);
        if (geometry.array) release(gl_.DeleteVertexArrays, geometry.array);
        geometry = {};
    }

    void bind_geometry(Geometry geometry) { gl_.BindVertexArray(geometry.array); }

    void stream_vertices(Geometry geometry, std::span<const std::byte> data) {
        gl_.BindBuffer(GL_ARRAY_BUFFER, geometry.vertices);
        gl_.BufferData(GL_ARRAY_BUFFER, GLsizeiptr(data.size()), data.data(), GL_STREAM_DRAW);
    }

    void upload_indices(Geometry &geometry, std::span<const std::byte> data) {
        bind_geometry(geometry);
        if (!geometry.indices) geometry.indices = generate(gl_.GenBuffers);
        gl_.BindBuffer(GL_ELEMENT_ARRAY_BUFFER, geometry.indices);
        gl_.BufferData(GL_ELEMENT_ARRAY_BUFFER, GLsizeiptr(data.size()), data.data(), GL_STATIC_DRAW);
    }

    void draw(Primitive topology, int first, int count) { gl_.DrawArrays(primitive(topology), first, count); }

    void draw_instanced(Primitive topology, int first, int count, int instances) {
        gl_.DrawArraysInstanced(primitive(topology), first, count, instances);
    }

    void draw_indexed(Primitive topology, IndexType type, size_t byte_offset, int count, int instances = 1) {
        const auto indices = type == IndexType::u16 ? GL_UNSIGNED_SHORT : GL_UNSIGNED_INT;
        const auto *offset = reinterpret_cast<const void *>(byte_offset);
        if (instances == 1)
            gl_.DrawElements(primitive(topology), count, indices, offset);
        else
            gl_.DrawElementsInstanced(primitive(topology), count, indices, offset, instances);
    }

    Fence signal() { return {reinterpret_cast<uintptr_t>(gl_.FenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0))}; }

    Wait wait(Fence fence, uint64_t timeout_ns = 0, bool flush = false) {
        if (!fence.id) return Wait::failed;
        const auto result = gl_.ClientWaitSync(
                reinterpret_cast<GLsync>(fence.id), flush ? GL_SYNC_FLUSH_COMMANDS_BIT : 0, timeout_ns
        );
        if (result == GL_TIMEOUT_EXPIRED) return Wait::pending;
        return result == GL_WAIT_FAILED ? Wait::failed : Wait::ready;
    }

    void destroy(Fence &fence) {
        if (fence.id) gl_.DeleteSync(reinterpret_cast<GLsync>(fence.id));
        fence = {};
    }

    Readback create_readback(int width, int height, Format format = Format::rgba8) {
        if (width < 1 || height < 1) throw std::runtime_error("Invalid readback dimensions");
        pixel_format(format);
        Readback result;
        result.width = width;
        result.height = height;
        result.format = format;
        result.buffer = generate(gl_.GenBuffers);
        gl_.BindBuffer(GL_PIXEL_PACK_BUFFER, result.buffer);
        gl_.BufferData(GL_PIXEL_PACK_BUFFER, GLsizeiptr(readback_bytes(result)), nullptr, GL_STREAM_READ);
        gl_.BindBuffer(GL_PIXEL_PACK_BUFFER, 0);
        return result;
    }

    static size_t readback_bytes(const Readback &readback) {
        return size_t(readback.width) * readback.height * pixel_format(readback.format).bytes;
    }

    void enqueue_readback(const TargetView &source, Readback &readback, int x = 0, int y = 0) {
        if (readback.fence.id || readback.mapped) throw std::runtime_error("Readback slot is busy");
        gl_.BindFramebuffer(GL_READ_FRAMEBUFFER, source.id);
        gl_.PixelStorei(GL_PACK_ALIGNMENT, 1);
        gl_.BindBuffer(GL_PIXEL_PACK_BUFFER, readback.buffer);
        const auto format = pixel_format(readback.format);
        gl_.ReadPixels(x, y, readback.width, readback.height, format.channels, format.type, nullptr);
        gl_.BindBuffer(GL_PIXEL_PACK_BUFFER, 0);
        readback.fence = signal();
        check_error("OpenGL readback failed");
    }

    bool pending(const Readback &readback) const { return readback.fence.id != 0; }

    Wait poll(const Readback &readback, bool flush = false) { return wait(readback.fence, 0, flush); }

    MappedPixels map(Readback &readback) {
        if (readback.mapped || poll(readback) != Wait::ready) throw std::runtime_error("Readback is not ready to map");
        gl_.BindBuffer(GL_PIXEL_PACK_BUFFER, readback.buffer);
        const auto *data =
                gl_.MapBufferRange(GL_PIXEL_PACK_BUFFER, 0, GLsizeiptr(readback_bytes(readback)), GL_MAP_READ_BIT);
        gl_.BindBuffer(GL_PIXEL_PACK_BUFFER, 0);
        if (!data) throw std::runtime_error("Cannot map readback");
        readback.mapped = true;
        return {static_cast<const std::byte *>(data),
                size_t(readback.width) * pixel_format(readback.format).bytes,
                RowOrigin::bottom};
    }

    void unmap(Readback &readback) {
        gl_.BindBuffer(GL_PIXEL_PACK_BUFFER, readback.buffer);
        const bool valid = gl_.UnmapBuffer(GL_PIXEL_PACK_BUFFER) == GL_TRUE;
        gl_.BindBuffer(GL_PIXEL_PACK_BUFFER, 0);
        readback.mapped = false;
        destroy(readback.fence);
        if (!valid) throw std::runtime_error("Readback data became invalid");
    }

    void collect(Readback &readback, std::span<std::byte> destination, RowOrigin origin, uint64_t timeout_ns) {
        if (destination.size() != readback_bytes(readback)) throw std::runtime_error("Readback size differs");
        if (wait(readback.fence, timeout_ns, true) != Wait::ready)
            throw std::runtime_error("The GPU did not finish the readback");
        const auto pixels = map(readback);
        const size_t row_bytes = size_t(readback.width) * pixel_format(readback.format).bytes;
        for (int y = 0; y < readback.height; ++y) {
            const int source_y = origin == pixels.origin ? y : readback.height - 1 - y;
            std::memcpy(
                    destination.data() + size_t(y) * row_bytes,
                    pixels.data + size_t(source_y) * pixels.row_pitch,
                    row_bytes
            );
        }
        unmap(readback);
    }

    void destroy(Readback &readback) {
        if (readback.mapped) {
            gl_.BindBuffer(GL_PIXEL_PACK_BUFFER, readback.buffer);
            gl_.UnmapBuffer(GL_PIXEL_PACK_BUFFER);
            gl_.BindBuffer(GL_PIXEL_PACK_BUFFER, 0);
        }
        destroy(readback.fence);
        if (readback.buffer) release(gl_.DeleteBuffers, readback.buffer);
        readback = {};
    }
};
}  // namespace native::gfx
