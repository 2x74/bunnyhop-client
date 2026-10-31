#pragma once

class WaterPass {
    // Temporary bridge until world and sky programs use reflected water constants.
    Gl &gl;
    gfx::Context &context;
    RenderUniforms &uniforms;
    BhContext *&core;

public:
    WaterPass(Gl &g, gfx::Context &ctx, RenderUniforms &u, BhContext *&c) : gl(g), context(ctx), uniforms(u), core(c) {}

    struct Volume {
        std::array<float, 3> lo{}, hi{}, color{.2f, .3f, .35f};
        std::array<float, 2> range{0, 400}, span{};
    };

    GLuint refractColor = 0, refractDepth = 0;
    int refractWidth = 0, refractHeight = 0, waterQuality = 1;
    bool hasWaterMaterials = false, waterBeneathFaces = false;
    // The Source look's water captures (water_capture.hpp). sceneCaptured: the scene pass being drawn has refraction.
    native_render::WaterCapturePlanner waterPlanner;
    native_render::WaterCapturePlan waterPlan;
    std::unique_ptr<WaterReflectionTarget> waterReflection;
    bool reflectionDrawn = false, sceneCaptured = false;
    gfx::Texture planesTexture;
    gfx::Sampler planesSampler;
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

    gfx::ConstantBinding water_constants(gfx::Program program) {
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
        return context.create_constants(program, {fields, sizeof(WaterValues)});
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

    void water_uniforms(
            const gfx::ConstantBinding &binding, const float eye[3], const native::Matrix &vp, int width, int height
    ) {
        prepare_water_values(eye, vp, width, height);
        context.constants(binding, &values);
        context.bind_texture(6, planesTexture, planesSampler);
    }

    // Temporary bridge for the world and sky programs while their constant blocks are converted.
    void water_uniforms(uint32_t target, const float eye[3], const native::Matrix &vp, int width, int height) {
        prepare_water_values(eye, vp, width, height);
        gl.Uniform3fv(uniforms.loc(target, "cameraPosition"), 1, values.camera.data());
        gl.Uniform2fv(uniforms.loc(target, "viewportSize"), 1, values.viewport.data());
        gl.Uniform1i(uniforms.loc(target, "waterCount"), values.count);
        gl.Uniform4fv(uniforms.loc(target, "waterRect"), values.count, values.rect.data());
        if (values.count) {
            gl.Uniform3fv(uniforms.loc(target, "waterMin"), values.count, values.minimum.data());
            gl.Uniform3fv(uniforms.loc(target, "waterMax"), values.count, values.maximum.data());
            gl.Uniform3fv(uniforms.loc(target, "waterColor"), values.count, values.color.data());
            gl.Uniform2fv(uniforms.loc(target, "waterRange"), values.count, values.range.data());
            gl.Uniform2fv(uniforms.loc(target, "waterSpan"), values.count, values.span.data());
        }
        context.bind_texture(6, planesTexture, planesSampler);
        gl.Uniform1i(uniforms.loc(target, "waterPlanes"), 6);
    }

    uint64_t refractionCaptures = 0;

    template <class RefractionSource>
    void capture_refraction(
            int viewportWidth, int viewportHeight, std::vector<GLuint> &ownedTextures, RefractionSource source
    ) {
        ++refractionCaptures;
        GLint read_target = 0, draw_target = 0;
        gl.GetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &read_target);
        gl.GetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw_target);
        source();
        for (int i = 0; i < 2; i++) {
            GLuint &id = i ? refractDepth : refractColor;
            if (!id) {
                gl.GenTextures(1, &id);
                ownedTextures.push_back(id);
            }
            gl.ActiveTexture(GL_TEXTURE4 + i);
            gl.BindTexture(GL_TEXTURE_2D, id);
            gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, i ? GL_NEAREST : GL_LINEAR);
            gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, i ? GL_NEAREST : GL_LINEAR);
            gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            if (refractWidth != viewportWidth || refractHeight != viewportHeight)
                gl.CopyTexImage2D(
                        GL_TEXTURE_2D, 0, i ? GL_DEPTH_COMPONENT24 : GL_RGBA16F, 0, 0, viewportWidth, viewportHeight, 0
                );
            else
                gl.CopyTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, 0, 0, viewportWidth, viewportHeight);
        }
        refractWidth = viewportWidth;
        refractHeight = viewportHeight;
        gl.BindFramebuffer(GL_READ_FRAMEBUFFER, GLuint(read_target));
        gl.BindFramebuffer(GL_DRAW_FRAMEBUFFER, GLuint(draw_target));
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
        GLint drawTarget = 0, readTarget = 0;
        gl.GetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &drawTarget);
        gl.GetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &readTarget);
        const float plane = *waterPlan.reflection_height;
        const float mirroredEye[3] = {eye[0], eye[1], 2 * plane - eye[2]};
        waterReflection->begin(width, height);
        viewportWidth = waterReflection->width();
        viewportHeight = waterReflection->height();
        gl.FrontFace(GL_CW);
        drawSky(mirroredEye, plane);
        clipHeight = plane;
        drawWorld(mirroredEye);
        gl.Disable(GL_CLIP_DISTANCE0);
        drawActors(mirroredEye);
        gl.FrontFace(GL_CCW);
        clipHeight = render_no_clip_height;
        viewportWidth = width;
        viewportHeight = height;
        gl.BindFramebuffer(GL_DRAW_FRAMEBUFFER, GLuint(drawTarget));
        gl.BindFramebuffer(GL_READ_FRAMEBUFFER, GLuint(readTarget));
        gl.Viewport(0, 0, width, height);
        reflectionDrawn = true;
    }
};
