#include "gfx.hpp"
#include <cassert>
#include <iostream>

namespace {
std::array<unsigned, 8> calls{};

unsigned image_calls = 0, sampler_calls = 0, active_calls = 0;

void APIENTRY active(GLenum unit) {
    assert(unit == GL_TEXTURE0 + 2);
    ++active_calls;
}

void APIENTRY image(GLenum target, GLuint texture) {
    assert(target == GL_TEXTURE_2D && texture == 17);
    ++image_calls;
}

void APIENTRY sampler(GLuint unit, GLuint value) {
    assert(unit == 2 && value == 19);
    ++sampler_calls;
}

GLint APIENTRY location(GLuint, const char *name) {
    if (std::strcmp(name, "packed") == 0) return 1;
    if (std::strcmp(name, "palette") == 0) return 2;
    if (std::strcmp(name, "pairs") == 0) return 3;
    if (std::strcmp(name, "flags") == 0) return 4;
    if (std::strcmp(name, "scalar") == 0) return 5;
    if (std::strcmp(name, "integer") == 0) return 6;
    return std::strcmp(name, "boolean") == 0 ? 7 : -1;
}

void APIENTRY scalar_float(GLint slot, GLfloat value) {
    assert(slot == 5 && value == .25f);
    ++calls[size_t(slot)];
}

void APIENTRY scalar_integer(GLint slot, GLint value) {
    assert((slot == 6 && value == 3) || (slot == 7 && value == 1));
    ++calls[size_t(slot)];
}

void APIENTRY vectors3(GLint slot, GLsizei count, const GLfloat *data) {
    ++calls[size_t(slot)];
    assert(count == (slot == 1 ? 24 : 8));
    for (int i = 0; i < count * 3; ++i)
        assert(data[i] == (slot == 1 ? float(i) : float(i / 3 + 1 + i % 3)));
}

void APIENTRY vectors2(GLint slot, GLsizei count, const GLfloat *data) {
    ++calls[size_t(slot)];
    assert(slot == 3 && count == 24);
    for (int i = 0; i < count * 2; ++i)
        assert(data[i] == float(i));
}

void APIENTRY integers(GLint slot, GLsizei count, const GLint *data) {
    ++calls[size_t(slot)];
    assert(slot == 4 && count == 4);
    assert(data[0] == 1 && data[1] == 0 && data[2] == 1 && data[3] == 0);
}
}  // namespace

int main() {
    using namespace native::gfx;
    native::Gl gl;
    gl.GetUniformLocation = location;
    gl.ActiveTexture = active;
    gl.BindTexture = image;
    gl.BindSampler = sampler;
    gl.Uniform3fv = vectors3;
    gl.Uniform2fv = vectors2;
    gl.Uniform1iv = integers;
    gl.Uniform1f = scalar_float;
    gl.Uniform1i = scalar_integer;
    Context default_context(gl);
    assert(default_context.backend() == Backend::opengl);
#if defined(_WIN32) || defined(BUNNYHOP_GFX_DISPATCH)
    Context fallback(gl, nullptr, Backend::d3d11);
    assert(fallback.backend() == Backend::opengl);
#endif
    OpenGlContext context(gl);
    context.bind_sampler(2, {19});
    assert(sampler_calls == 1 && image_calls == 0 && active_calls == 0);
    context.bind_image(2, {17, {}});
    assert(sampler_calls == 1 && image_calls == 1 && active_calls == 1);
    context.bind_sampler(2, {19});
    assert(sampler_calls == 2 && image_calls == 1 && active_calls == 1);

    struct Block {
        std::array<float, 72> packed;
        std::array<std::array<float, 4>, 8> palette;
        std::array<float, 48> pairs;
        std::array<std::array<uint32_t, 2>, 4> flags;
        float scalar = .25f;
        int32_t integer = 3;
        uint32_t boolean = 8;
    } block{};

    for (size_t i = 0; i < block.packed.size(); ++i)
        block.packed[i] = float(i);
    for (size_t i = 0; i < block.palette.size(); ++i)
        block.palette[i] = {float(i + 1), float(i + 2), float(i + 3), 999};
    for (size_t i = 0; i < block.pairs.size(); ++i)
        block.pairs[i] = float(i);
    block.flags = {{{7, 999}, {0, 999}, {5, 999}, {0, 999}}};
    const ConstantField fields[] = {
            {"packed", offsetof(Block, packed), sizeof(block.packed), ConstantType::float3, 24, 12},
            {"palette", offsetof(Block, palette), sizeof(block.palette), ConstantType::float3, 8, 16},
            {"pairs", offsetof(Block, pairs), sizeof(block.pairs), ConstantType::float2, 24, 8},
            {"flags", offsetof(Block, flags), sizeof(block.flags), ConstantType::bool32, 4, 8},
            {"scalar", offsetof(Block, scalar), 4, ConstantType::float1},
            {"integer", offsetof(Block, integer), 4, ConstantType::int1},
            {"boolean", offsetof(Block, boolean), 4, ConstantType::bool32},
            {"absent", 0, 4, ConstantType::float1}
    };
    auto binding = context.create_constants({1}, {fields, sizeof(block)});
    assert(binding && binding.fields.size() == 7);
    const auto *floats = binding.packed_floats.data();
    const auto *integer_storage = binding.packed_integers.data();
    context.constants(binding, &block);
    context.constants(binding, &block);
    assert((calls == std::array<unsigned, 8>{0, 2, 2, 2, 2, 2, 2, 2}));
    assert(floats == binding.packed_floats.data() && integer_storage == binding.packed_integers.data());
    context.destroy(binding);
    assert(!binding);
    std::cout << "Packed and padded arrays use one GL upload per field without reallocating\n";
}
