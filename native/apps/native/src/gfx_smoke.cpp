#include "gfx.hpp"
#include <iostream>
#include <memory>
#include <filesystem>
#include <fstream>
#include "render_math.hpp"
#include "render_shaders.hpp"
#include "video_frames.hpp"

namespace native {
#include "native_presentation.hpp"
}

namespace {
using namespace native::gfx;
constexpr int width = 16, height = 8;
std::filesystem::path evidence;
#if defined(_WIN32)
bool warp_backend = false;
#endif
constexpr uint64_t timeout_ns = 5'000'000'000;

void require(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}

void save(const std::string &name, std::span<const std::byte> rgba, int w, int h) {
    if (evidence.empty()) return;
    std::filesystem::create_directories(evidence);
    std::vector<std::byte> top(rgba.size());
    for (int y = 0; y < h; ++y)
        std::memcpy(top.data() + size_t(y) * w * 4, rgba.data() + size_t(h - 1 - y) * w * 4, size_t(w) * 4);
    std::ofstream file(evidence / (name + ".ppm"), std::ios::binary);
    file << "P6\n" << w << ' ' << h << "\n255\n";
    for (size_t pixel = 0; pixel < top.size(); pixel += 4)
        file.write(reinterpret_cast<const char *>(top.data() + pixel), 3);
    require(bool(file), "Cannot write graphics evidence");
}

std::vector<std::byte> read(Context &context, const RenderTarget &target, RowOrigin origin) {
    auto readback = context.create_readback(width, height);
    context.enqueue_readback(target, readback);
    bool rejected = false;
    try {
        context.enqueue_readback(target, readback);
    } catch (const std::runtime_error &) {
        rejected = true;
    }
    require(rejected, "Pending readback was overwritten");
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
    auto pipeline = context.create_pipeline({});
    context.pipeline(pipeline);
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
    auto floating = context.create_target({width, height, Format::rgba16f});
    context.bind_target(floating);
    context.clear_color({.25f, .5f, .75f, 1});
    context.copy_color(floating, {2, 1, width - 4, height - 2}, copied.color, 2, 1);
    require(read(context, copied, RowOrigin::bottom) == pixels, "Float-to-UNORM color copy changed pixels");
    context.destroy(floating);
    auto depth = context.create_readback(width, height, Format::depth32f);
    context.enqueue_readback(resolved, depth);
    std::vector<float> depth_values(size_t(width) * height);
    context.collect(depth, std::as_writable_bytes(std::span(depth_values)), RowOrigin::bottom, timeout_ns);
    require(std::all_of(depth_values.begin(), depth_values.end(), [](float value) { return value == 1; }),
            "Depth resolve changed cleared depth");
#if defined(_WIN32)
    if (warp_backend) {
        auto program = context.create_program({{"internal-depth-pattern", ""}});
        auto geometry = context.create_geometry(0, {});
        context.bind_target(source);
        context.viewport({0, 0, width, height});
        context.pipeline(pipeline);
        context.bind_program(program);
        context.bind_geometry(geometry);
        context.clear_depth();
        context.draw(Primitive::triangles, 0, 3);
        context.resolve_depth(source, resolved);
        context.enqueue_readback(resolved, depth);
        context.collect(depth, std::as_writable_bytes(std::span(depth_values)), RowOrigin::bottom, timeout_ns);
        require(std::all_of(
                        depth_values.begin(),
                        depth_values.end(),
                        [](float value) { return std::abs(value - .625f) < .000001f; }
                ),
                "MSAA depth resolve did not choose sample zero");
        context.destroy(geometry);
        context.destroy(program);
    }
#endif
    context.destroy(depth);
    context.destroy(copied);
    context.destroy(resolved);
    context.destroy(source);
    context.destroy(pipeline);
    save("msaa-copy", pixels, width, height);
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
    auto pipeline = context.create_pipeline({{}, {false, false}, {}});
    context.pipeline(pipeline);
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
    const std::array<uint16_t, 3> indices = {0, 1, 2};
    context.upload_indices(geometry, std::as_bytes(std::span(indices)));
    context.bind_target(target);
    context.bind_program(program);
    context.bind_geometry(geometry);
    context.clear_color({0, 0, 0, 1});
    context.draw_indexed(Primitive::triangles, IndexType::u16, 0, 3, 2);
    require(read(context, target, RowOrigin::bottom) == bottom, "Indexed instancing changed pixels");
    context.destroy(target);
    context.destroy(geometry);
    context.destroy(program);
    context.destroy(pipeline);
    save("instancing", bottom, width, height);
}

void cubes(Context &context) {
    static constexpr const char *cube_vertex = R"(#version 330 core
uniform samplerCube vertexCube;
uniform sampler2D boneMatrices;
flat out vec4 fromVertex;
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));
fromVertex=vec4(textureLod(vertexCube,vec3(1,0,0),0).b+texelFetch(boneMatrices,ivec2(2,1),0).r-1.);
gl_Position=vec4(p*2.-1.,0,1);})";
    static constexpr const char *cube_fragment = R"(#version 330 core
uniform samplerCube uFinEnv,uCosEnv,uPlayerEnv;
flat in vec4 fromVertex;
out vec4 color;
void main(){int f=int(gl_FragCoord.x)/2;vec3 d;
if(f==0)d=vec3(1,.5,.25);else if(f==1)d=vec3(-1,.5,.25);
else if(f==2)d=vec3(.25,1,.5);else if(f==3)d=vec3(.25,-1,.5);
else if(f==4)d=vec3(.25,.5,1);else d=vec3(.25,.5,-1);
color=(texture(uFinEnv,d)+texture(uCosEnv,d)+texture(uPlayerEnv,d))/3.*fromVertex;})";
    auto program = context.create_program({{"gfx-cube", ""}, cube_vertex, cube_fragment});
    for (const auto *name : {"vertexCube", "uFinEnv", "uCosEnv", "uPlayerEnv"})
        context.texture_unit(program, name, 9);
    context.texture_unit(program, "boneMatrices", 3);
    std::array<std::array<uint8_t, 64>, 6> faces{};
    std::array<const void *, 6> pointers{};
    for (size_t f = 0; f < faces.size(); ++f) {
        pointers[f] = faces[f].data();
        for (size_t y = 0; y < 4; ++y)
            for (size_t x = 0; x < 4; ++x) {
                const size_t offset = (y * 4 + x) * 4;
                faces[f][offset] = uint8_t(32 * f + x * 6);
                faces[f][offset + 1] = uint8_t(y * 40);
                faces[f][offset + 2] = 255;
                faces[f][offset + 3] = 255;
            }
    }
    auto cube = context.create_texture({4, 4, Format::rgba8, TextureKind::cube}, pointers);
    std::array<float, 24> bones{};
    bones[20] = 1;
    const void *bone_face[] = {bones.data()};
    auto bone_texture = context.create_texture({3, 2, Format::rgba32f}, bone_face);
    auto sampler = context.create_sampler({Filter::nearest, Filter::nearest});
    auto geometry = context.create_geometry(0, {});
    auto target = context.create_target({width, height});
    auto pipeline = context.create_pipeline({{}, {false, false}, {Cull::back}});
    context.bind_target(target);
    context.viewport({0, 0, width, height});
    context.clear_color({0, 0, 0, 1});
    context.pipeline(pipeline);
    context.bind_program(program);
    context.bind_texture(9, cube, sampler);
    context.bind_texture(3, bone_texture, sampler);
    context.bind_geometry(geometry);
    context.draw(Primitive::triangles, 0, 3);
    const auto pixels = read(context, target, RowOrigin::bottom);
    require(channel(pixels, 0, 0, 2) == 255 && channel(pixels, 10, 0, 0) > 150,
            "Cube fanout, vertex textures, bone texture or front-face winding changed");
    save("cube-faces", pixels, width, height);
    context.destroy(target);
    context.destroy(geometry);
    context.destroy(pipeline);
    context.destroy(bone_texture);
    context.destroy(cube);
    context.destroy(sampler);
    context.destroy(program);
}

void video(Context &context, int supersample, int samples) {
    constexpr int w = 160, h = 90;
    native::VideoFrameTargets targets(context, w, h, supersample, samples);
    native::NativePresentation presentation(context);
    const std::array<native_render::Vec3, 4> quad = {{{-.8f, -.7f, 0}, {.2f, -.7f, 0}, {.2f, .5f, 0}, {-.8f, .5f, 0}}};
    const float eye[] = {0, 0, 2};
    for (size_t frame = 0; frame < 6; ++frame) {
        targets.begin_frame();
        for (int sample = 0; sample < samples; ++sample) {
            targets.bind_scene();
            context.depth_write(true);
            context.clear_color({.125f, .25f, .5f + float(sample) * .125f, 1});
            context.clear_depth();
            presentation.clear();
            presentation.quad(quad, {1, .25f, float(frame) * .125f, .75f});
            presentation.quad({{{.3f, -.6f, 0}, {.9f, -.6f, 0}, {.9f, .6f, 0}, {.3f, .6f, 0}}}, {.2f, 1, .2f, .9f}, 1);
            presentation.draw(native::identity(), eye);
            targets.add_sample(samples);
        }
        targets.resolve();
        const size_t slot = frame % native::VideoFrameTargets::readback_slots;
        require(!targets.pending(slot), "Video ring overwrote a pending readback");
        targets.read_back(slot);
        if (frame < 2) continue;
        const size_t oldest = (frame - 2) % native::VideoFrameTargets::readback_slots;
        std::vector<uint8_t> pixels;
        targets.collect(oldest, pixels);
        save("video-" + std::to_string(supersample) + "x-" + std::to_string(samples) + "-" + std::to_string(frame - 2),
             std::as_bytes(std::span(pixels)),
             w,
             h);
    }
    for (size_t frame = 4; frame < 6; ++frame) {
        std::vector<uint8_t> pixels;
        targets.collect(frame % native::VideoFrameTargets::readback_slots, pixels);
        require(pixels[0] == 32 && pixels[1] == 64, "Video accumulation or SRV/output hazard changed pixels");
        save("video-" + std::to_string(supersample) + "x-" + std::to_string(samples) + "-" + std::to_string(frame),
             std::as_bytes(std::span(pixels)),
             w,
             h);
    }
}

void run(Context &context) {
    targets(context);
    draws(context);
    cubes(context);
    video(context, 1, 1);
    video(context, 2, 3);
    auto fence = context.signal();
    require(context.wait(fence, timeout_ns, true) == Wait::ready, "Standalone fence timed out");
    context.destroy(fence);
    context.check_error("Graphics seam error");
    std::cout << "Graphics/subsystem checks passed\n";
}
}  // namespace

int main(int argc, char **argv) {
    if (argc > 1) evidence = argv[1];
#if defined(_WIN32)
    if (argc > 2 && std::string_view(argv[2]) == "--warp") {
        try {
            warp_backend = true;
            auto device = D3D11Context::warp();
            Context context(*device);
            run(context);
            return 0;
        } catch (const std::exception &error) {
            std::cerr << error.what() << '\n';
            return 1;
        }
    }
#endif

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
        run(context);
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
