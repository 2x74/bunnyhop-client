#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <string_view>
#include <vector>

namespace native::gfx {
enum class Backend { opengl, d3d11 };
inline constexpr Backend selected_backend = Backend::opengl;

inline constexpr bool available(Backend backend) {
#if defined(_WIN32)
    return backend == Backend::opengl || backend == Backend::d3d11;
#else
    return backend == Backend::opengl;
#endif
}

// Camera matrices and shader inputs retain OpenGL's [-w,+w] depth and bottom-left target/texture origin.
enum class RowOrigin { bottom, top };

struct Rect {
    int x = 0, y = 0, width = 0, height = 0;
};
enum class Format { none, r8, rgba8, rgba16f, rgba32f, r32f, depth24, depth32f, depth24_stencil8 };
enum class TextureKind { image, cube };
enum class Filter { nearest, linear };
enum class Address { clamp, repeat, mirror, border };
enum class Compare { less, less_equal, always };
enum class Cull { none, front, back };
enum class Winding { counter_clockwise, clockwise };
enum class BlendFactor { zero, one, source_alpha, inverse_source_alpha };
enum class Primitive { triangles, lines, triangle_strip };
enum class IndexType { u16, u32 };
enum class Wait { ready, pending, failed };

struct BlendState {
    bool enabled = false;
    BlendFactor source = BlendFactor::source_alpha, destination = BlendFactor::inverse_source_alpha;
};

struct DepthState {
    bool test = true, write = true;
    Compare compare = Compare::less_equal;
};

struct RasterState {
    Cull cull = Cull::none;
    Winding winding = Winding::counter_clockwise;
    bool offset = false;
    float slope_bias = 0, constant_bias = 0;
};

struct PipelineState {
    BlendState blend;
    DepthState depth;
    RasterState raster;
    std::array<bool, 4> color_write = {true, true, true, true};
};

struct TextureDesc {
    int width = 1, height = 1;
    Format format = Format::rgba8;
    TextureKind kind = TextureKind::image;
    int samples = 1, levels = 1;
};

struct SamplerDesc {
    Filter minification = Filter::linear, magnification = Filter::linear;
    Address address = Address::clamp;
    bool compare = false;
    Compare comparison = Compare::less_equal;
    bool mipmapped = false;
    Filter mip_filter = Filter::linear;
    float min_lod = -1000, max_lod = 1000;
    std::array<float, 4> border_color{};
};

struct TargetDesc {
    int width = 1, height = 1;
    Format color = Format::rgba8, depth = Format::none;
    int samples = 1;
};

struct VertexAttribute {
    unsigned location = 0, components = 3;
    size_t offset = 0;
    unsigned instance_step = 0;
};
enum class ConstantType { float1, float2, float3, float4, int1, bool32, matrix4 };
enum class ShaderStage { vertex, pixel, both };

// Offsets describe caller bytes. The backend scatters by name to each stage's reflected storage layout.
struct ConstantField {
    const char *name = nullptr;
    uint32_t offset = 0, size = 0;
    ConstantType type = ConstantType::float1;
    uint32_t count = 1, array_stride = 0, matrix_stride = 16;
};

struct ConstantLayout {
    std::span<const ConstantField> fields;
    uint32_t byte_size = 0;
    ShaderStage stage = ShaderStage::both;
};

struct ReflectedConstants {
    ConstantLayout layout;
    uint32_t slot = 0;
};

struct ReflectedTexture {
    const char *name = nullptr;
    ShaderStage stage = ShaderStage::pixel;
    int texture_slot = -1, sampler_slot = -1;
};

struct ProgramKey {
    std::string_view program, permutation;
};

struct ProgramDesc {
    ProgramKey key;
    // OpenGL fallback only. D3D11 looks up precompiled DXBC and reflection using key.
    const char *vertex = nullptr, *fragment = nullptr;
};

struct Program {
    uintptr_t id = 0;
};

struct Pipeline {
    PipelineState state;
    uintptr_t id = 0;
};

struct Texture {
    uintptr_t id = 0;
    TextureDesc desc;
};

struct Sampler {
    uintptr_t id = 0;
};

struct TargetView {
    uintptr_t id = 0;
    TargetDesc desc;
    uintptr_t native_depth = 0;
    bool borrowed = false;
};

struct RenderTarget : TargetView {
    Texture color, depth;
};

struct Geometry {
    uintptr_t array = 0, vertices = 0, indices = 0;
};

struct Fence {
    uintptr_t id = 0;
    bool borrowed = false;
};

struct Readback {
    uintptr_t buffer = 0;
    Fence fence;
    int width = 0, height = 0;
    Format format = Format::rgba8;
    bool mapped = false;
};

struct ConstantBinding {
    struct Field {
        int32_t location;
        uint32_t offset;
        ConstantType type;
        uint32_t count = 1, size = 4, stride = 4, packing_offset = 0;
        bool pack = false;
    };

    std::vector<Field> fields;
    mutable std::vector<float> packed_floats;
    mutable std::vector<int32_t> packed_integers;
    uint32_t byte_size = 0;
    uintptr_t id = 0;
};

inline constexpr float no_clip_height = -1e30f;

struct MappedPixels {
    const std::byte *data = nullptr;
    size_t row_pitch = 0;
    RowOrigin origin = RowOrigin::bottom;
};
}  // namespace native::gfx
