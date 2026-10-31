#include "gfx.hpp"
#include <iostream>
#include <memory>

namespace {
using namespace native::gfx;
constexpr int width = 16, height = 8;
constexpr uint64_t timeout_ns = 5'000'000'000;

void require(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}

std::vector<std::byte> read(Context &context, const RenderTarget &target, RowOrigin origin) {
    auto readback = context.create_readback(width, height);
    context.enqueue_readback(target, readback);
    std::vector<std::byte> result(Context::readback_bytes(readback));
    context.collect(readback, result, origin, timeout_ns);
    require(!context.pending(readback), "Collected readback remained pending");
    context.destroy(readback);
    return result;
}

unsigned channel(const std::vector<std::byte> &pixels, int x, int y, int component) {
    return std::to_integer<unsigned>(pixels[(size_t(y) * width + x) * 4 + component]);
}

void targets(Context &context) {
    auto source = context.create_target({width, height, Format::rgba8, Format::depth24, 4});
    auto resolved = context.create_target({width, height, Format::rgba8, Format::depth24});
    context.bind_target(source);
    context.viewport({0, 0, width, height});
    context.pipeline(context.create_pipeline({}));
    context.clear_color({.25f, .5f, .75f, 1});
    context.clear_depth();
    context.resolve_color(source, resolved);
    context.resolve_depth(source, resolved);
    auto pixels = read(context, resolved, RowOrigin::bottom);
    require(channel(pixels, 0, 0, 0) == 64 && channel(pixels, 0, 0, 1) == 128 && channel(pixels, 0, 0, 2) == 191,
            "MSAA color resolve changed");
    auto copied = context.create_target({width, height});
    context.copy_color(resolved, {0, 0, width, height}, copied.color);
    require(read(context, copied, RowOrigin::bottom) == pixels, "Framebuffer-to-texture copy changed pixels");
    auto depth = context.create_readback(width, height, Format::depth32f);
    context.enqueue_readback(resolved, depth);
    std::vector<float> depth_values(size_t(width) * height);
    context.collect(depth, std::as_writable_bytes(std::span(depth_values)), RowOrigin::bottom, timeout_ns);
    require(std::all_of(depth_values.begin(), depth_values.end(), [](float value) { return value == 1; }),
            "Depth resolve changed cleared depth");
    context.destroy(depth);
    context.destroy(copied);
    context.destroy(resolved);
    context.destroy(source);
}

void draws(Context &context) {
    static constexpr const char *vertex = R"(#version 330 core
layout(location=0) in vec2 point;
uniform vec3 shift[2];
void main(){gl_Position=vec4(point+shift[gl_InstanceID].xy,0,1);})";
    static constexpr const char *fragment = R"(#version 330 core
uniform vec4 tint;
uniform bool enabled;
out vec4 color;
void main(){color=enabled?tint:vec4(0);})";
    auto program = context.create_program({{"gfx-smoke", ""}, vertex, fragment});

    struct alignas(16) Constants {
        std::array<float, 4> shift[2];
        std::array<float, 4> tint;
        uint32_t enabled = 5;
        std::array<float, 3> padding{};
    };

    static constexpr ConstantField fields[] = {
            {"shift", 0, 32, ConstantType::float3, 2, 16},
            {"tint", 32, 16, ConstantType::float4},
            {"enabled", 48, 4, ConstantType::bool32},
            {"optimizedOut", 52, 4, ConstantType::float1}
    };
    auto binding = context.create_constants(program, {fields, sizeof(Constants)});
    const Constants constants = {{{-.5f, -.5f, 0, 0}, {.5f, .5f, 0, 0}}, {1, 0, 0, 1}};
    context.bind_program(program);
    context.constants(binding, &constants);
    static constexpr VertexAttribute attributes[] = {{0, 2, 0}};
    auto geometry = context.create_geometry(2 * sizeof(float), attributes);
    const std::array<float, 6> vertices = {-.4f, -.4f, .4f, -.4f, 0, .4f};
    context.stream_vertices(geometry, std::as_bytes(std::span(vertices)));
    auto target = context.create_target({width, height});
    context.bind_target(target);
    context.viewport({0, 0, width, height});
    context.pipeline(context.create_pipeline({{}, {false, false}, {}}));
    context.clear_color({0, 0, 0, 1});
    context.bind_geometry(geometry);
    context.draw_instanced(Primitive::triangles, 0, 3, 2);
    const auto bottom = read(context, target, RowOrigin::bottom);
    const auto top = read(context, target, RowOrigin::top);
    require(channel(bottom, 4, 1, 0) == 255 && channel(bottom, 12, 5, 0) == 255,
            "Instanced draw or reflected constant array changed");
    for (int y = 0; y < height; ++y)
        for (int x = 0; x < width; ++x)
            require(channel(bottom, x, y, 0) == channel(top, x, height - 1 - y, 0), "Readback Y flip changed");
    context.destroy(target);
    context.destroy(geometry);
    context.destroy(program);
}
}  // namespace

int main() {
    SDL_SetHint(SDL_HINT_MAC_BACKGROUND_APP, "1");
    if (!SDL_Init(SDL_INIT_VIDEO)) return 77;

    struct Sdl {
        ~Sdl() { SDL_Quit(); }
    } sdl;

    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
    const std::unique_ptr<SDL_Window, decltype(&SDL_DestroyWindow)> window(
            SDL_CreateWindow("Graphics offscreen check", width, height, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN),
            SDL_DestroyWindow
    );
    if (!window) return 77;

    struct GlContext {
        SDL_GLContext value;

        ~GlContext() { SDL_GL_DestroyContext(value); }
    } gl_context{SDL_GL_CreateContext(window.get())};

    if (!gl_context.value) return 77;
    native::Gl gl;
    try {
        gl.load();
    } catch (const std::exception &error) {
        // CI runners without a GPU only offer OpenGL 1.1, which can't run the renderer at all.
        std::cerr << error.what() << '\n';
        return 77;
    }
    try {
        Context context(gl);
        targets(context);
        draws(context);
        context.check_error("Graphics seam GL error");
        std::cout << "Graphics resolve/copy/constants/instancing/readback checks passed\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
