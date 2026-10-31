#pragma once

class SkyPass {
    gfx::Context &context;
    BhContext *&core;
    RenderResources &resources;

public:
    SkyPass(gfx::Context &ctx, BhContext *&c, RenderResources &r) : context(ctx), core(c), resources(r) {}

    RenderGeometry skyMesh;
    std::array<gfx::Pipeline, 2> depthPipelines, depthEndPipelines;
    gfx::Program skyProgram;
    gfx::ConstantBinding skyConstants;
    WaterPass::UniformBinding waterConstants;
    std::array<gfx::Pipeline, 2> backdropPipelines;
    float frameSkyYaw = 0;
    static constexpr unsigned sky_panorama_unit = 10;
    std::vector<BhGroup> skyGroups;
    std::array<int32_t, 6> skyMaterials{-1, -1, -1, -1, -1, -1};
    BhSkyInfo skyInfo{};
    bool hasSky = false;
    // The picked sky pack (sky_library.hpp), uploaded once per sky.
    gfx::Texture skyPanorama;
    gfx::Sampler panoramaSampler;
    std::string skyPanoramaId;
    native::SkyPicture skyPanoramaInfo;

    struct SkyValues {
        std::array<float, 3> forward{};
        std::array<float, 3> right{};
        std::array<float, 3> up{};
        float skyExposure = 0;
        float aspect = 0;
        float cot = 0;
        std::array<int32_t, 6> skyPresent{};
        std::array<int32_t, 6> skyHalf{};
        std::array<float, 3> proceduralSun{};
        uint32_t panoramaShown = 0;
        float panoramaYaw = 0;
        float panoramaExposure = 0;
    } values;

    struct View {
        const native::GraphicsSettings &graphics;
        double lastYaw, lastPitch;
        float fieldOfView;
        const std::array<float, 3> &sunDirection;
        bool hasSun;
        int viewportWidth, viewportHeight;
    };

    ~SkyPass() {
        context.destroy(skyConstants);
        waterConstants.release(context);
        context.destroy(skyProgram);
        for (auto &pipeline : backdropPipelines)
            context.destroy(pipeline);
        context.destroy(skyPanorama);
        context.destroy(panoramaSampler);
        for (auto &pipeline : depthPipelines)
            context.destroy(pipeline);
        for (auto &pipeline : depthEndPipelines)
            context.destroy(pipeline);
    }

    void panorama_sampling(float anisotropy) {
        context.destroy(panoramaSampler);
        gfx::SamplerDesc desc;
        desc.wrap_s = gfx::Address::repeat;
        desc.max_anisotropy = anisotropy;
        panoramaSampler = context.create_sampler(desc);
    }

    bool panorama_drawn(const native::GraphicsSettings &graphics) const {
        return graphics.look.composer() && !graphics.potato && graphics.look.sky_mode == native::SkyMode::pack
               && skyPanorama && skyPanoramaId == graphics.look.sky_pack_id;
    }

    void prepare_sky() {
        size_t sv = 0, si = 0, sg = 0;
        const float *skyVertices = bh_sky_vertices(core, &sv);
        const auto *skyIndices = bh_sky_indices(core, &si);
        const auto *rawSky = bh_sky_groups(core, &sg);
        skyMesh = resources.geometry(skyVertices, sv, 3, skyIndices, si);
        if (rawSky && sg) skyGroups.assign(rawSky, rawSky + sg);
        hasSky = bh_sky_info(core, &skyInfo) != 0;
        size_t skyCount = 0;
        const auto *sky = bh_sky_materials(core, &skyCount);
        if (sky && skyCount == 6) std::copy(sky, sky + 6, skyMaterials.begin());
    }

    // The sky pack to draw when the look shows one (sky_library.hpp). Uploads once per sky.
    void use_sky(const std::string &id, const native::SkyPicture *picture) {
        if (id == skyPanoramaId || !picture || picture->pixels.empty()) return;
        context.destroy(skyPanorama);
        // Expanding the half-float pixels preserves every RGB value while using a native D3D11 texture format.
        std::vector<uint16_t> pixels(size_t(picture->width) * picture->height * 4, 0x3c00);
        for (size_t i = 0; i < pixels.size() / 4; ++i)
            std::copy_n(picture->pixels.data() + i * 3, 3, pixels.data() + i * 4);
        const void *faces[] = {pixels.data()};
        skyPanorama = context.create_texture({picture->width, picture->height, gfx::Format::rgba16f}, faces);
        panorama_sampling(1);
        skyPanoramaInfo.width = picture->width;
        skyPanoramaInfo.height = picture->height;
        skyPanoramaInfo.lighting = picture->lighting;
        skyPanoramaInfo.rotation = picture->rotation;
        skyPanoramaInfo.exposure = picture->exposure;
        skyPanoramaId = id;
    }

    void sky_panorama_uniforms(const View &view) {
        static constexpr std::array<float, 3> default_sun{.45f, .6f, .35f};
        const auto sun = view.hasSun ? view.sunDirection : default_sun;
        const float length = std::hypot(std::hypot(sun[0], sun[1]), sun[2]);
        values.proceduralSun = {sun[0] / length, sun[1] / length, sun[2] / length};
        const bool shown = panorama_drawn(view.graphics);
        values.panoramaShown = shown;
        values.panoramaYaw = frameSkyYaw;
        values.panoramaExposure = skyPanoramaInfo.exposure;
        if (shown)
            context.bind_texture(sky_panorama_unit, skyPanorama, panoramaSampler);
        else
            resources.bind(sky_panorama_unit, resources.white);
    }

    // The 2D skybox, or the procedural sky, behind everything. mirrored: as the water reflection sees it.
    void draw_sky_backdrop(
            const float eye[3],
            const native::Matrix &vp,
            float aspect,
            bool mirrored,
            const View &view,
            WaterPass &water,
            std::span<const BhMaterial> materials
    ) {
        context.pipeline(backdropPipelines[unsigned(mirrored)]);
        context.bind_program(skyProgram);
        context.bind_geometry(resources.emptyGeometry);
        water.water_uniforms(waterConstants, eye, vp, view.viewportWidth, view.viewportHeight);
        const float cy = std::cos(view.lastYaw * native::radians), sy = std::sin(view.lastYaw * native::radians),
                    cp = std::cos(view.lastPitch * native::radians), sp = std::sin(view.lastPitch * native::radians);
        const float flip = mirrored ? -1.f : 1.f;
        values.forward = {cp * cy, cp * sy, -sp * flip};
        values.right = {sy, -cy, 0};
        values.up = {sp * cy, sp * sy, cp * flip};
        values.skyExposure = view.graphics.sky_exposure;
        values.aspect = aspect;
        values.cot = (4.f / 3.f) / std::tan(float(view.fieldOfView * native::radians * .5));
        values.skyPresent.fill(0);
        values.skyHalf.fill(0);
        // Procedural daylight (Enhanced and Cinematic) draws the fallback sky in place of the map's faces.
        const bool procedural =
                view.graphics.look.composer() && view.graphics.look.sky_mode == native::SkyMode::procedural;
        for (int i = 0; i < 6; i++) {
            gfx::Texture id = resources.white;
            const int32_t m = procedural ? -1 : skyMaterials[i];
            if (m >= 0 && size_t(m) < materials.size()) {
                const auto t = materials[m].texture;
                if (t >= 0 && resources.texture(t) != resources.checker) {
                    id = resources.texture(t);
                    values.skyPresent[i] = 1;
                    const auto wh = resources.textureSizes[t];
                    values.skyHalf[i] = i < 4 && wh.first == wh.second * 2;
                }
            }
            resources.bind(unsigned(i), id, false);
        }
        sky_panorama_uniforms(view);
        context.constants(skyConstants, &values);
        if (!view.graphics.potato) context.draw(gfx::Primitive::triangles, 0, 3);
        context.pipeline(depthEndPipelines[unsigned(mirrored)]);
    }

    // The 3D skybox (sky_camera) around its origin. mirror_height: the water reflection's plane in world units.
    template <class Camera, class DrawScene>
    void draw_3d_sky(
            const float eye[3],
            double seconds,
            const native::GraphicsSettings &graphics,
            float &clipHeight,
            std::optional<float> mirror_height,
            Camera camera,
            DrawScene drawScene
    ) {
        if (!hasSky || graphics.potato || skyInfo.scale <= 0) return;
        float skyEye[3];
        for (int k = 0; k < 3; k++)
            skyEye[k] = skyInfo.origin[k] + eye[k] / skyInfo.scale;
        auto vp = camera(skyEye);
        if (mirror_height) {
            const float skyHeight = skyInfo.origin[2] + *mirror_height / skyInfo.scale;
            vp = native::multiply(vp, native_render::mirror_matrix(skyHeight));
            skyEye[2] = 2 * skyHeight - skyEye[2];
            clipHeight = skyHeight;
        }
        drawScene(vp, skyEye, seconds, mirror_height.has_value());
        context.clear_depth();
    }

    // Sky brushes write only depth so the world behind them stays hidden as in Source.
    void draw_sky_depth(const native::Matrix &vp, RenderDepthProgram &depth, float clipHeight, bool mirrored) {
        if (!skyMesh.geometry) return;
        context.pipeline(depthPipelines[unsigned(mirrored)]);
        depth.bind(vp, clipHeight);
        context.bind_geometry(skyMesh.geometry);
        for (const auto &item : skyGroups) {
            if (item.sky3d) continue;
            BhTransform transform{};
            transform.visible = 1;
            if (item.model) bh_model_transform(core, item.model, &transform);
            if (!transform.visible) continue;
            depth.model(native::model_matrix(transform));
            context.draw_indexed(
                    gfx::Primitive::triangles,
                    gfx::IndexType::u32,
                    size_t(item.first_index) * sizeof(uint32_t),
                    int(item.index_count)
            );
        }
        context.pipeline(depthEndPipelines[unsigned(mirrored)]);
    }

    void prepare_depth_pipelines() {
        for (unsigned mirror = 0; mirror < depthPipelines.size(); ++mirror) {
            gfx::PipelineState state;
            state.raster.offset = true;
            state.raster.slope_bias = 1;
            state.raster.constant_bias = 2;
            state.raster.winding = mirror ? gfx::Winding::clockwise : gfx::Winding::counter_clockwise;
            state.raster.clip_distance = true;
            state.color_write = {false, false, false, false};
            depthPipelines[mirror] = context.create_pipeline(state);
            state.raster.offset = false;
            state.raster.clip_distance = false;
            state.color_write = {true, true, true, true};
            depthEndPipelines[mirror] = context.create_pipeline(state);
        }
    }

    void prepare_constants() {
        static constexpr gfx::ConstantField fields[] = {
                {"forward", offsetof(SkyValues, forward), 12, gfx::ConstantType::float3, 1},
                {"right", offsetof(SkyValues, right), 12, gfx::ConstantType::float3, 1},
                {"up", offsetof(SkyValues, up), 12, gfx::ConstantType::float3, 1},
                {"skyExposure", offsetof(SkyValues, skyExposure), 4, gfx::ConstantType::float1, 1},
                {"aspect", offsetof(SkyValues, aspect), 4, gfx::ConstantType::float1, 1},
                {"cot", offsetof(SkyValues, cot), 4, gfx::ConstantType::float1, 1},
                {"skyPresent", offsetof(SkyValues, skyPresent), 24, gfx::ConstantType::int1, 6},
                {"skyHalf", offsetof(SkyValues, skyHalf), 24, gfx::ConstantType::int1, 6},
                {"proceduralSun", offsetof(SkyValues, proceduralSun), 12, gfx::ConstantType::float3, 1},
                {"panoramaShown", offsetof(SkyValues, panoramaShown), 4, gfx::ConstantType::bool32, 1},
                {"panoramaYaw", offsetof(SkyValues, panoramaYaw), 4, gfx::ConstantType::float1, 1},
                {"panoramaExposure", offsetof(SkyValues, panoramaExposure), 4, gfx::ConstantType::float1, 1},
        };
        skyConstants = context.create_constants(skyProgram, {fields, sizeof(SkyValues)});
    }

    void prepare_program(WaterPass &water) {
        prepare_depth_pipelines();
        skyProgram =
                context.create_program({{"sky", ""}, native_render::sky_vertex, native_render::sky_fragment().c_str()});
        prepare_constants();
        waterConstants = water.water_constants(skyProgram);
        static constexpr const char *faces[] = {"sky0", "sky1", "sky2", "sky3", "sky4", "sky5"};
        for (unsigned i = 0; i < std::size(faces); ++i)
            context.texture_unit(skyProgram, faces[i], i);
        context.texture_unit(skyProgram, "panorama", sky_panorama_unit);
        for (unsigned mirror = 0; mirror < backdropPipelines.size(); ++mirror) {
            gfx::PipelineState state;
            state.depth = {false, false};
            state.raster.winding = mirror ? gfx::Winding::clockwise : gfx::Winding::counter_clockwise;
            backdropPipelines[mirror] = context.create_pipeline(state);
        }
    }
};
