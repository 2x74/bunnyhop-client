#include "smoke_graphics.hpp"
#include "renderer.hpp"

namespace {
constexpr int width = 640, height = 360;
constexpr std::array<float, 3> camera{175, 1135, 80}, actor_position{371, 1135, 200};
constexpr float water_height_units = 58, camera_pitch_degrees = 45;
constexpr size_t minimum_reflected_pixels = 20, minimum_composed_pixels = 10;

struct SdlLifetime {
    SdlLifetime() {
        if (!SDL_Init(SDL_INIT_VIDEO)) throw std::runtime_error(SDL_GetError());
    }

    ~SdlLifetime() { SDL_Quit(); }
};

struct Device {
    SdlLifetime sdl;
    native::SmokeGraphics surface{width, height};
    native::gfx::Context &graphics = surface.context();
};

std::vector<std::byte> capture(Device &device, native::gfx::TargetView source, const std::filesystem::path &path) {
    const auto &desc = source.desc;
    auto slot = device.graphics.create_readback(desc.width, desc.height);
    std::vector<std::byte> rgba(native::gfx::Context::readback_bytes(slot));
    device.graphics.enqueue_readback(source, slot);
    device.graphics.collect(slot, rgba, native::gfx::RowOrigin::top, 5'000'000'000);
    device.graphics.destroy(slot);
    device.graphics.bind_target(device.surface.output(width, height));
    std::vector<std::byte> rgb(size_t(desc.width) * desc.height * 3);
    for (size_t i = 0; i < rgb.size() / 3; ++i)
        std::copy_n(rgba.data() + i * 4, 3, rgb.data() + i * 3);
    std::ofstream file(path, std::ios::binary);
    file << "P6\n" << desc.width << ' ' << desc.height << "\n255\n";
    file.write(reinterpret_cast<const char *>(rgb.data()), std::streamsize(rgb.size()));
    if (!file) throw std::runtime_error("Cannot write reflection capture");
    device.graphics.check_error("Reflection capture GL error");
    return rgb;
}

size_t changed_pixels(const std::vector<std::byte> &a, const std::vector<std::byte> &b) {
    if (a.size() != b.size()) throw std::runtime_error("Capture sizes differ");
    size_t changed = 0;
    for (size_t i = 0; i < a.size(); i += 3)
        changed += !std::equal(a.begin() + i, a.begin() + i + 3, b.begin() + i);
    return changed;
}

// Aero's clockwise water bypasses reflection in the native view. An explicit front face isolates the compositor.
class WaterSurface {
    Device &device;
    native::gfx::Program program;
    native::gfx::ConstantBinding constants;
    native::gfx::Geometry geometry;
    native::gfx::RenderTarget target;
    native::gfx::Pipeline pipeline;
    native::gfx::Texture color, depth, planes;
    native::gfx::Sampler linear, nearest, comparison;

    struct Values {
        native::Matrix projection = native::identity();
        native::Matrix model = native::identity();
        float clip = native::gfx::no_clip_height;
        std::array<float, 3> camera{0, 0, 100};
        std::array<float, 2> viewport{float(width), float(height)};
        std::array<float, 2> range{native::camera_near_plane, native::camera_far_plane};
        std::array<float, 3> tint{.2f, .5f, .6f};
        float opacity = 1;
        float scale = 1;
        float time = 2;
        int32_t kind = 2;
        uint32_t above = 1;
        uint32_t capture = 1;
        uint32_t reflection = 1;
        uint32_t unlit = 1;
        int32_t waterCount = 0;
        float waterHeight = water_height_units;
        float fogEnd = 400;
    } values;

    void prepare_constants() {
        static constexpr native::gfx::ConstantField fields[] = {
                {"viewProjection", offsetof(Values, projection), 64, native::gfx::ConstantType::matrix4},
                {"model", offsetof(Values, model), 64, native::gfx::ConstantType::matrix4},
                {"clipHeight", offsetof(Values, clip), 4, native::gfx::ConstantType::float1},
                {"cameraPosition", offsetof(Values, camera), 12, native::gfx::ConstantType::float3},
                {"viewportSize", offsetof(Values, viewport), 8, native::gfx::ConstantType::float2},
                {"cameraNearFar", offsetof(Values, range), 8, native::gfx::ConstantType::float2},
                {"tint", offsetof(Values, tint), 12, native::gfx::ConstantType::float3},
                {"opacity", offsetof(Values, opacity), 4, native::gfx::ConstantType::float1},
                {"lightmapScale", offsetof(Values, scale), 4, native::gfx::ConstantType::float1},
                {"timeSeconds", offsetof(Values, time), 4, native::gfx::ConstantType::float1},
                {"kind", offsetof(Values, kind), 4, native::gfx::ConstantType::int1},
                {"aboveWater", offsetof(Values, above), 4, native::gfx::ConstantType::bool32},
                {"captureReady", offsetof(Values, capture), 4, native::gfx::ConstantType::bool32},
                {"reflectionReady", offsetof(Values, reflection), 4, native::gfx::ConstantType::bool32},
                {"unlit", offsetof(Values, unlit), 4, native::gfx::ConstantType::bool32},
                {"waterCount", offsetof(Values, waterCount), 4, native::gfx::ConstantType::int1},
                {"reflectionHeight", offsetof(Values, waterHeight), 4, native::gfx::ConstantType::float1},
                {"waterFogEnd", offsetof(Values, fogEnd), 4, native::gfx::ConstantType::float1},
        };
        constants = device.graphics.create_constants(program, {fields, sizeof(Values)});
        values.projection[10] = 0;
    }

    void prepare_geometry() {
        struct Vertex {
            std::array<float, 3> position, normal;
            std::array<float, 2> uv, lightmap;
            float blend;
        };

        const Vertex vertices[] = {
                {{-1, -1, water_height_units}, {0, 0, 1}, {}, {}, 0},
                {{1, -1, water_height_units}, {0, 0, 1}, {}, {}, 0},
                {{1, 1, water_height_units}, {0, 0, 1}, {}, {}, 0},
                {{-1, 1, water_height_units}, {0, 0, 1}, {}, {}, 0}
        };
        const uint32_t indices[] = {0, 2, 1, 0, 3, 2};
        static constexpr native::gfx::VertexAttribute attributes[] = {
                {0, 3, offsetof(Vertex, position)},
                {1, 3, offsetof(Vertex, normal)},
                {2, 2, offsetof(Vertex, uv)},
                {3, 2, offsetof(Vertex, lightmap)},
                {4, 1, offsetof(Vertex, blend)}
        };
        geometry = device.graphics.create_geometry(sizeof(Vertex), attributes);
        device.graphics.upload_vertices(geometry, std::as_bytes(std::span(vertices)));
        device.graphics.upload_indices(geometry, std::as_bytes(std::span(indices)));
    }

    void prepare_inputs() {
        const uint8_t rgba[] = {120, 150, 180, 255};
        const float depthValue = 1;
        const std::array<float, 4> plane{};
        const void *pixels[] = {rgba}, *depthPixels[] = {&depthValue}, *planePixels[] = {plane.data()};
        color = device.graphics.create_texture({}, pixels);
        depth = device.graphics.create_texture({1, 1, native::gfx::Format::depth32f}, depthPixels);
        planes = device.graphics.create_texture({1, 1, native::gfx::Format::rgba32f}, planePixels);
        linear = device.graphics.create_sampler({});
        nearest = device.graphics.create_sampler({native::gfx::Filter::nearest, native::gfx::Filter::nearest});
        native::gfx::SamplerDesc sampling;
        sampling.compare = true;
        comparison = device.graphics.create_sampler(sampling);
        const std::pair<const char *, unsigned> units[] = {
                {"baseTexture", 0},
                {"lightTexture", 1},
                {"secondaryTexture", 2},
                {"detailTexture", 3},
                {"sceneColor", 4},
                {"sceneDepth", 5},
                {"waterPlanes", 6},
                {"normalTexture", 7},
                {"reflectionTexture", 8},
                {"sunShadowMap", 11}
        };
        for (const auto &[name, unit] : units)
            device.graphics.texture_unit(program, name, unit);
    }

public:
    explicit WaterSurface(Device &value) : device(value) {
        program = device.graphics.create_program(
                {{"world", ""}, native_render::world_vertex, native_render::world_fragment().c_str()}
        );
        prepare_constants();
        prepare_geometry();
        prepare_inputs();
        target = device.graphics.create_target({width, height});
        native::gfx::PipelineState state;
        state.depth = {false, false};
        state.raster.winding = native::gfx::Winding::clockwise;
        pipeline = device.graphics.create_pipeline(state);
    }

    ~WaterSurface() {
        auto &context = device.graphics;
        context.destroy(constants);
        context.destroy(program);
        context.destroy(geometry);
        context.destroy(target);
        context.destroy(pipeline);
        context.destroy(color);
        context.destroy(depth);
        context.destroy(planes);
        context.destroy(linear);
        context.destroy(nearest);
        context.destroy(comparison);
    }

    std::vector<std::byte> draw(native::gfx::Texture reflected, const std::filesystem::path &path) {
        auto &context = device.graphics;
        context.bind_target(target);
        context.viewport({0, 0, width, height});
        context.pipeline(pipeline);
        context.bind_program(program);
        context.constants(constants, &values);
        for (const unsigned unit : {0u, 1u, 2u, 3u, 4u, 7u})
            context.bind_texture(unit, color, linear);
        context.bind_texture(5, depth, nearest);
        context.bind_texture(6, planes, nearest);
        context.bind_texture(8, reflected, linear);
        context.bind_texture(11, depth, comparison);
        context.bind_geometry(geometry);
        context.draw_indexed(native::gfx::Primitive::triangles, native::gfx::IndexType::u32, 0, 6);
        return capture(device, target, path);
    }
};

struct SceneCapture {
    std::vector<std::byte> main, reflection, water;
};

SceneCapture
scene(Device &device,
      BhContext *core,
      const std::filesystem::path &assets,
      const std::filesystem::path &output,
      bool actor,
      bool reflected,
      const std::array<float, 3> &position) {
    native::Renderer renderer(device.graphics, core, assets);
    renderer.graphics_settings(
            {{"graphicsPreset", "source"}, {"graphicsAntialias", false}, {"graphicsWaterReflections", reflected}}
    );
    renderer.set_source_look(true);
    renderer.set_viewmodel_visible(false);
    if (actor) {
        native_render::Actor model;
        model.id = "reflection-fixture";
        model.outfit = "outfit-cream";
        model.loadout = "2;knife-carrot;fin-garden;glove-knit;;hat-halo";
        model.opacity = 1;
        std::copy(position.begin(), position.end(), model.frame.position);
        model.frame.flags = 2;
        model.frame.weapon = 1;
        model.playerGlow = native_render::Glow{true, true, 1};
        renderer.set_room_actors({model});
    }
    native::Input input;
    input.set_angles(camera_pitch_degrees, 0);
    BhSnapshot snapshot{};
    bh_snapshot(core, &snapshot);
    for (const double seconds : {0., 2.})
        renderer.draw(width, height, camera.data(), input, &snapshot, seconds);
    const std::string name = std::string(reflected ? "reflection-" : "direct-") + (actor ? "actor" : "empty");
    SceneCapture result;
    result.main = capture(device, device.surface.output(width, height), output / (name + ".ppm"));
    if (reflected) {
        result.reflection = capture(device, renderer.water_reflection_target(), output / (name + "-target.ppm"));
        WaterSurface surface(device);
        result.water = surface.draw(renderer.water_reflection_texture(), output / (name + "-water.ppm"));
    }
    return result;
}

void reflection_cases(
        Device &device,
        BhContext *core,
        const std::filesystem::path &assets,
        const std::filesystem::path &output,
        const std::array<float, 3> &position
) {
    const auto empty = scene(device, core, assets, output, false, true, position);
    const auto actor = scene(device, core, assets, output, true, true, position);
    const auto directEmpty = scene(device, core, assets, output, false, false, position);
    const auto directActor = scene(device, core, assets, output, true, false, position);
    const auto reflectedPixels = changed_pixels(empty.reflection, actor.reflection);
    const auto composedPixels = changed_pixels(empty.water, actor.water);
    const auto nativePixels = changed_pixels(empty.main, actor.main);
    const auto directPixels = changed_pixels(directEmpty.main, directActor.main);
    nlohmann::json evidence{
            {"reflectedActorPixels", reflectedPixels},
            {"composedActorPixels", composedPixels},
            {"nativeActorPixels", nativePixels},
            {"directActorPixels", directPixels},
            {"actorPosition", position},
            {"camera", camera}
    };
    std::ofstream(output / "coverage.json") << evidence.dump(2) << '\n';
    if (reflectedPixels < minimum_reflected_pixels || composedPixels < minimum_composed_pixels || directPixels)
        throw std::runtime_error("Actor must affect the water reflection and remain outside the direct view");
    std::cout << evidence << '\n';
}

void mirrored_cases(Device &device, const std::filesystem::path &assets, const std::filesystem::path &output) {
    native::NativeViewmodel model(device.graphics, assets);
    model.cosmetics("outfit-cream", "2;knife-bayonet;fin-geode;glove-sport-pandora");
    auto pipeline = device.graphics.create_pipeline({});
    for (const bool mirrored : {false, true}) {
        model.settings(54, .6f, 1.5f, -.9f, mirrored);
        for (const uint32_t weapon : {1u, 3u}) {
            model.reset_presentation();
            BhSnapshot snapshot{};
            model.draw(width, height, snapshot, weapon, 0, false, 0, 0);
            device.graphics.pipeline(pipeline);
            device.graphics.clear_color({.045f, .06f, .085f, 1});
            device.graphics.clear_depth();
            model.draw(width, height, snapshot, weapon, 0, false, 0, 2);
            const auto name = std::string(mirrored ? "mirrored-" : "right-") + (weapon == 1 ? "knife" : "gun");
            capture(device, device.surface.output(width, height), output / (name + ".ppm"));
        }
    }
    device.graphics.destroy(pipeline);
}
}  // namespace

int main(int argc, char **argv) {
    try {
        if (argc != 4) throw std::runtime_error("usage: reflection-render-smoke WATER_MAP ASSETS OUTPUT");
        Device device;
        std::unique_ptr<BhContext, decltype(&bh_destroy)> core(bh_create(), bh_destroy);
        const auto contentRoot = std::filesystem::path(argv[1]).parent_path().string();
        if (!core || !bh_load_map(core.get(), argv[1], contentRoot.c_str()))
            throw std::runtime_error("Cannot load reflection fixture map");
        const std::filesystem::path output = argv[3];
        std::filesystem::create_directories(output);
        reflection_cases(device, core.get(), argv[2], output, actor_position);
        mirrored_cases(device, argv[2], output);
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
