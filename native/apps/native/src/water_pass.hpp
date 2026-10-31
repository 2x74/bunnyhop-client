#pragma once

class WaterPass {
    gfx::Context &context;
    BhContext *&core;

public:
    WaterPass(gfx::Context &ctx, BhContext *&c) : context(ctx), core(c) { endPipeline = context.create_pipeline({}); }

    ~WaterPass() {
        context.destroy(refraction);
        context.destroy(resolved);
        context.destroy(refractionColorSampler);
        context.destroy(refractionDepthSampler);
        context.destroy(planesTexture);
        context.destroy(planesSampler);
        context.destroy(endPipeline);
    }

    struct Volume {
        std::array<float, 3> lo{}, hi{}, color{.2f, .3f, .35f};
        std::array<float, 2> range{0, 400}, span{};
    };

    gfx::RenderTarget refraction, resolved;
    gfx::Sampler refractionColorSampler, refractionDepthSampler;
    int refractWidth = 0, refractHeight = 0, refractionSamples = 0, waterQuality = 1;
    bool hasWaterMaterials = false, waterBeneathFaces = false;
    // The Source look's water captures (water_capture.hpp). sceneCaptured: the scene pass being drawn has refraction.
    native_render::WaterCapturePlanner waterPlanner;
    native_render::WaterCapturePlan waterPlan;
    std::unique_ptr<WaterReflectionTarget> waterReflection;
    bool reflectionDrawn = false, sceneCaptured = false;
    gfx::Texture planesTexture;
    gfx::Sampler planesSampler;
    gfx::Pipeline endPipeline;
    std::vector<Volume> volumes;
    std::vector<size_t> waterOrder;
    std::vector<std::array<float, 4>> waterRects;

    // Upward-facing world water, per cell, for the capture distance and plane choice (water_capture.hpp).
    void load_water_cells(
            const float *vertices,
            const uint32_t *indices,
            std::span<const BhGroup> groups,
            std::span<const BhMaterial> materials,
            std::span<const BhMaterialExtra> extras
    ) {
        constexpr size_t stride = 10, normal_z = 5;
        native_render::WaterCellBuilder builder;
        for (const auto &g : groups) {
            if (g.sky3d || g.model || g.material >= materials.size() || g.material >= extras.size()) continue;
            if (materials[g.material].kind != 2 || !extras[g.material].above_water) continue;
            for (size_t t = g.first_index; t + 2 < size_t(g.first_index) + g.index_count; t += 3) {
                std::array<native_render::Vec3, 3> corners;
                for (int c = 0; c < 3; c++) {
                    const size_t at = size_t(indices[t + c]) * stride;
                    corners[c] = {vertices[at], vertices[at + 1], vertices[at + 2]};
                }
                builder.add_triangle(g.material, corners, vertices[size_t(indices[t]) * stride + normal_z]);
            }
        }
        waterPlanner.load(builder.cells(), materials.size());
    }

    struct WaterValues {
        std::array<float, 3> camera{};
        std::array<float, 2> viewport{};
        int32_t count = 0;
        std::array<float, 72> minimum{}, maximum{}, color{};
        std::array<float, 48> range{}, span{};
        std::array<float, 96> rect{};
    } values;

    struct UniformBinding {
        std::array<gfx::ConstantBinding, 25> counts;

        void release(gfx::Context &context) {
            for (auto &binding : counts)
                context.destroy(binding);
        }
    };

    UniformBinding water_constants(gfx::Program program) {
        static constexpr gfx::ConstantField fields[] = {
                {"cameraPosition", offsetof(WaterValues, camera), 12, gfx::ConstantType::float3, 1, 0},
                {"viewportSize", offsetof(WaterValues, viewport), 8, gfx::ConstantType::float2, 1, 0},
                {"waterCount", offsetof(WaterValues, count), 4, gfx::ConstantType::int1, 1, 0},
                {"waterMin", offsetof(WaterValues, minimum), 288, gfx::ConstantType::float3, 24, 12},
                {"waterMax", offsetof(WaterValues, maximum), 288, gfx::ConstantType::float3, 24, 12},
                {"waterColor", offsetof(WaterValues, color), 288, gfx::ConstantType::float3, 24, 12},
                {"waterRange", offsetof(WaterValues, range), 192, gfx::ConstantType::float2, 24, 8},
                {"waterSpan", offsetof(WaterValues, span), 192, gfx::ConstantType::float2, 24, 8},
                {"waterRect", offsetof(WaterValues, rect), 384, gfx::ConstantType::float4, 24, 16},
        };
        context.texture_unit(program, "waterPlanes", 6);
        UniformBinding result;
        std::array<gfx::ConstantField, std::size(fields)> selected;
        std::copy(std::begin(fields), std::end(fields), selected.begin());
        for (uint32_t count = 0; count < result.counts.size(); ++count) {
            for (size_t i = 3; i < selected.size(); ++i) {
                selected[i].count = count;
                selected[i].size = count * selected[i].array_stride;
            }
            const size_t size = count ? selected.size() : 3;
            result.counts[count] = context.create_constants(program, {{selected.data(), size}, sizeof(WaterValues)});
        }
        return result;
    }

    void prepare_water_values(const float eye[3], const native::Matrix &vp, int width, int height) {
        std::copy_n(eye, 3, values.camera.begin());
        values.viewport = {float(width), float(height)};
        auto &order = waterOrder;
        auto &rects = waterRects;
        order.clear();
        for (size_t i = 0; i < volumes.size(); i++)
            if (native_render::screen_rect({volumes[i].lo, volumes[i].hi}, vp, rects[i])) order.push_back(i);
        auto distance = [&](size_t i) {
            float d = 0;
            for (int k = 0; k < 3; k++) {
                const float n = std::max({volumes[i].lo[k] - eye[k], 0.f, eye[k] - volumes[i].hi[k]});
                d += n * n;
            }
            return d;
        };
        std::sort(order.begin(), order.end(), [&](size_t a, size_t b) {
            const float left = distance(a), right = distance(b);
            return left == right ? a < b : left < right;
        });
        if (order.size() > 24) order.resize(24);
        auto &lo = values.minimum;
        auto &hi = values.maximum;
        auto &color = values.color;
        auto &range = values.range;
        auto &span = values.span;
        auto &rect = values.rect;
        for (size_t n = 0; n < order.size(); n++) {
            const auto &v = volumes[order[n]];
            for (int k = 0; k < 4; k++)
                rect[n * 4 + k] = rects[order[n]][k];
            for (int k = 0; k < 3; k++) {
                lo[n * 3 + k] = v.lo[k];
                hi[n * 3 + k] = v.hi[k];
                color[n * 3 + k] = v.color[k];
            }
            for (int k = 0; k < 2; k++) {
                range[n * 2 + k] = v.range[k];
                span[n * 2 + k] = v.span[k];
            }
        }
        values.count = int32_t(order.size());
    }

    void
    water_uniforms(const UniformBinding &binding, const float eye[3], const native::Matrix &vp, int width, int height) {
        prepare_water_values(eye, vp, width, height);
        context.constants(binding.counts[size_t(values.count)], &values);
        context.bind_texture(6, planesTexture, planesSampler);
    }

    uint64_t refractionCaptures = 0;

    void prepare_refraction(const gfx::TargetView &source, int width, int height) {
        const auto depth = source.desc.depth == gfx::Format::none ? gfx::Format::depth24 : source.desc.depth;
        if (refractWidth == width && refractHeight == height && refraction.desc.depth == depth
            && refractionSamples == source.desc.samples)
            return;
        context.destroy(refraction);
        context.destroy(resolved);
        refraction = context.create_target({width, height, gfx::Format::rgba16f, depth});
        if (source.desc.samples > 1) resolved = context.create_target({width, height, source.desc.color, depth});
        refractWidth = width;
        refractHeight = height;
        refractionSamples = source.desc.samples;
    }

    void bind_refraction() {
        context.bind_texture(4, refraction.color, refractionColorSampler);
        context.bind_texture(5, refraction.depth, refractionDepthSampler);
    }

    template <class RefractionSource>
    void capture_refraction(int width, int height, RefractionSource source) {
        ++refractionCaptures;
        const auto restore = context.current_target();
        auto input = source();
        prepare_refraction(input, width, height);
        if (input.desc.samples > 1) {
            context.resolve_color(input, resolved);
            context.resolve_depth(input, resolved);
            input = resolved;
        }
        context.copy_color(input, {0, 0, width, height}, refraction.color);
        context.resolve_depth(input, refraction);
        context.bind_target(restore);
        bind_refraction();
    }

    std::vector<native_render::WaterSurface> water_surfaces(
            const float *verts,
            const uint32_t *indices,
            std::span<const BhGroup> groups,
            std::span<const BhMaterial> materials,
            std::span<const BhMaterialExtra> extras
    ) {
        std::vector<native_render::WaterSurface> waterSurfaces;
        for (const auto &g : groups) {
            if (g.material >= materials.size() || materials[g.material].kind != 2 || g.material >= extras.size()
                || !extras[g.material].above_water)
                continue;
            for (size_t t = g.first_index; t < size_t(g.first_index) + g.index_count; t += 3) {
                const size_t a = size_t(indices[t]) * 10, b = size_t(indices[t + 1]) * 10,
                             d = size_t(indices[t + 2]) * 10;
                if (verts[a + 5] < .9f) continue;
                native_render::WaterSurface surface;
                for (int k = 0; k < 3; k++) {
                    surface.center[k] = (verts[a + k] + verts[b + k] + verts[d + k]) / 3;
                    surface.color[k] = materials[g.material].color[k];
                }
                surface.range = {extras[g.material].fog_start, extras[g.material].fog_end};
                if (!(surface.range[1] > surface.range[0])) surface.range = {0, 400};
                waterSurfaces.push_back(surface);
            }
        }
        return waterSurfaces;
    }

    void upload_water_planes(std::vector<float> planes) {
        if (planes.empty()) planes.resize(4);
        if (planes.size() / 4 > size_t(context.max_texture_size()))
            throw std::runtime_error("Native water plane texture exceeds GPU size");
        const void *data[] = {planes.data()};
        planesTexture = context.create_texture({int(planes.size() / 4), 1, gfx::Format::rgba32f}, data);
        gfx::SamplerDesc sampling;
        sampling.minification = gfx::Filter::nearest;
        sampling.magnification = gfx::Filter::nearest;
        planesSampler = context.create_sampler(sampling);
    }

    ResourceLoading prepare_water(
            std::span<const BhGroup> groups,
            std::span<const BhMaterial> materials,
            std::span<const BhMaterialExtra> extras
    ) {
        size_t vertex_count = 0, index_count = 0;
        const auto *verts = bh_vertices(core, &vertex_count);
        const auto *indices = bh_indices(core, &index_count);
        const auto waterSurfaces = water_surfaces(verts, indices, groups, materials, extras);
        co_yield "resource";
        load_water_cells(verts, indices, groups, materials, extras);
        co_yield "resource";
        std::vector<float> planes;
        size_t waterBytes = 0;
        const auto *water = bh_water_json(core, &waterBytes);
        if (water && waterBytes) {
            const auto json = nlohmann::json::parse(water, water + waterBytes);
            const auto boxes = json.value("volumes", nlohmann::json::array()),
                       allPlanes = json.value("planes", nlohmann::json::array());
            for (size_t i = 0; i < boxes.size(); i++) {
                if (boxes[i].size() != 6) continue;
                Volume volume;
                for (int k = 0; k < 3; k++) {
                    volume.lo[k] = boxes[i][k];
                    volume.hi[k] = boxes[i][k + 3];
                }
                volume.span[0] = planes.size() / 4;
                if (i < allPlanes.size())
                    for (const auto &p : allPlanes[i])
                        if (p.size() == 4)
                            for (int k = 0; k < 4; k++)
                                planes.push_back(p[k].get<float>());
                volume.span[1] = planes.size() / 4 - volume.span[0];
                if (const auto *surface = native_render::water_surface({volume.lo, volume.hi}, waterSurfaces)) {
                    volume.color = surface->color;
                    volume.range = surface->range;
                }
                volumes.push_back(volume);
            }
        }
        refractionColorSampler = context.create_sampler({});
        refractionDepthSampler = context.create_sampler({gfx::Filter::nearest, gfx::Filter::nearest});
        upload_water_planes(std::move(planes));
        waterOrder.reserve(volumes.size());
        waterRects.resize(volumes.size());
    }

    void plan_water(const float eye[3], const native::Matrix &vp, bool capturesEnabled, bool reflectionsEnabled) {
        reflectionDrawn = false;
        if (!capturesEnabled) {
            waterPlanner.clear();
            waterPlan = {};
            return;
        }
        waterPlan = waterPlanner.plan({eye[0], eye[1], eye[2]}, vp);
        if (!reflectionsEnabled) waterPlan.reflection_height.reset();
    }

    template <class DrawSky, class DrawWorld, class DrawActors>
    void draw_reflection(
            const float eye[3],
            int width,
            int height,
            int &viewportWidth,
            int &viewportHeight,
            float &clipHeight,
            DrawSky drawSky,
            DrawWorld drawWorld,
            DrawActors drawActors
    ) {
        if (!waterReflection) waterReflection = std::make_unique<WaterReflectionTarget>(context);
        const auto restore = context.current_target();
        const float plane = *waterPlan.reflection_height;
        const float mirroredEye[3] = {eye[0], eye[1], 2 * plane - eye[2]};
        waterReflection->begin(width, height);
        viewportWidth = waterReflection->width();
        viewportHeight = waterReflection->height();
        drawSky(mirroredEye, plane);
        clipHeight = plane;
        drawWorld(mirroredEye);
        drawActors(mirroredEye);
        context.pipeline(endPipeline);
        clipHeight = gfx::no_clip_height;
        viewportWidth = width;
        viewportHeight = height;
        context.bind_target(restore);
        context.viewport({0, 0, width, height});
        reflectionDrawn = true;
    }
};
