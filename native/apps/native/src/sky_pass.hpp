#pragma once

class SkyPass {
    Gl &gl;
    gfx::Context &context;
    BhContext *&core;
    RenderResources &resources;
    RenderUniforms &uniforms;

public:
    SkyPass(Gl &g, gfx::Context &ctx, BhContext *&c, RenderResources &r, RenderUniforms &u)
        : gl(g)
        , context(ctx)
        , core(c)
        , resources(r)
        , uniforms(u) {}

    RenderGeometry skyMesh;
    GLuint skyProgram = 0;
    float frameSkyYaw = 0;
    static constexpr GLint sky_panorama_unit = 10;
    std::vector<BhGroup> skyGroups;
    std::array<int32_t, 6> skyMaterials{-1, -1, -1, -1, -1, -1};
    BhSkyInfo skyInfo{};
    bool hasSky = false;
    // The picked sky pack (sky_library.hpp), uploaded once per sky.
    gfx::Texture skyPanorama;
    gfx::Sampler panoramaSampler;
    std::string skyPanoramaId;
    native::SkyPicture skyPanoramaInfo;

    struct View {
        const native::GraphicsSettings &graphics;
        double lastYaw, lastPitch;
        float fieldOfView;
        const std::array<float, 3> &sunDirection;
        bool hasSun;
        int viewportWidth, viewportHeight;
    };

    ~SkyPass() {
        context.destroy(skyPanorama);
        context.destroy(panoramaSampler);
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
        gl.Uniform3f(uniforms.loc(skyProgram, "proceduralSun"), sun[0] / length, sun[1] / length, sun[2] / length);
        const bool shown = panorama_drawn(view.graphics);
        gl.Uniform1i(uniforms.loc(skyProgram, "panoramaShown"), shown);
        gl.Uniform1f(uniforms.loc(skyProgram, "panoramaYaw"), frameSkyYaw);
        gl.Uniform1f(uniforms.loc(skyProgram, "panoramaExposure"), skyPanoramaInfo.exposure);
        if (shown)
            context.bind_texture(sky_panorama_unit, skyPanorama, panoramaSampler);
        else
            resources.bind(sky_panorama_unit, resources.white);
        gl.Uniform1i(uniforms.loc(skyProgram, "panorama"), sky_panorama_unit);
        gl.ActiveTexture(GL_TEXTURE0);
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
        static constexpr const char *face_uniforms[6] = {"sky0", "sky1", "sky2", "sky3", "sky4", "sky5"};
        gl.Disable(GL_BLEND);
        gl.Disable(GL_CULL_FACE);
        gl.Disable(GL_DEPTH_TEST);
        gl.DepthMask(GL_FALSE);
        gl.UseProgram(skyProgram);
        context.bind_geometry(resources.emptyGeometry);
        water.water_uniforms(skyProgram, eye, vp, view.viewportWidth, view.viewportHeight);
        const float cy = std::cos(view.lastYaw * native::radians), sy = std::sin(view.lastYaw * native::radians),
                    cp = std::cos(view.lastPitch * native::radians), sp = std::sin(view.lastPitch * native::radians);
        const float flip = mirrored ? -1.f : 1.f;
        gl.Uniform3f(uniforms.loc(skyProgram, "forward"), cp * cy, cp * sy, -sp * flip);
        gl.Uniform3f(uniforms.loc(skyProgram, "right"), sy, -cy, 0);
        gl.Uniform3f(uniforms.loc(skyProgram, "up"), sp * cy, sp * sy, cp * flip);
        gl.Uniform1f(uniforms.loc(skyProgram, "skyExposure"), view.graphics.sky_exposure);
        gl.Uniform1f(uniforms.loc(skyProgram, "aspect"), aspect);
        gl.Uniform1f(
                uniforms.loc(skyProgram, "cot"), (4.f / 3.f) / std::tan(float(view.fieldOfView * native::radians * .5))
        );
        GLint present[6]{}, half[6]{};
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
                    present[i] = 1;
                    const auto wh = resources.textureSizes[t];
                    half[i] = i < 4 && wh.first == wh.second * 2;
                }
            }
            resources.bind(unsigned(i), id, false);
            gl.Uniform1i(uniforms.loc(skyProgram, face_uniforms[i]), i);
        }
        gl.Uniform1iv(uniforms.loc(skyProgram, "skyPresent"), 6, present);
        gl.Uniform1iv(uniforms.loc(skyProgram, "skyHalf"), 6, half);
        sky_panorama_uniforms(view);
        if (!view.graphics.potato) gl.DrawArrays(GL_TRIANGLES, 0, 3);
        gl.Enable(GL_DEPTH_TEST);
        gl.DepthMask(GL_TRUE);
        gl.DepthFunc(GL_LEQUAL);
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
        gl.Clear(GL_DEPTH_BUFFER_BIT);
    }

    // Sky brush faces only write depth, so the world behind them stays hidden as in Source.
    void draw_sky_depth(const native::Matrix &vp, GLuint depthProgram, float clipHeight) {
        if (!skyMesh.geometry) return;
        gl.Disable(GL_BLEND);
        gl.DepthMask(GL_TRUE);
        gl.UseProgram(depthProgram);
        gl.UniformMatrix4fv(uniforms.loc(depthProgram, "viewProjection"), 1, GL_FALSE, vp.data());
        gl.Uniform1f(uniforms.loc(depthProgram, "clipHeight"), clipHeight);
        gl.ColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_FALSE);
        gl.Disable(GL_CULL_FACE);
        gl.Enable(GL_POLYGON_OFFSET_FILL);
        gl.PolygonOffset(1, 2);
        context.bind_geometry(skyMesh.geometry);
        for (const auto &item : skyGroups) {
            if (item.sky3d) continue;
            BhTransform t{};
            t.visible = 1;
            if (item.model) bh_model_transform(core, item.model, &t);
            if (!t.visible) continue;
            const auto model = native::model_matrix(t);
            gl.UniformMatrix4fv(uniforms.loc(depthProgram, "model"), 1, GL_FALSE, model.data());
            const auto first = reinterpret_cast<void *>(uintptr_t(item.first_index) * sizeof(uint32_t));
            gl.DrawElements(GL_TRIANGLES, item.index_count, GL_UNSIGNED_INT, first);
        }
        gl.ColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
        gl.Disable(GL_POLYGON_OFFSET_FILL);
    }

    void prepare_program() {
        skyProgram = link_program(gl, native_render::sky_vertex, native_render::sky_fragment().c_str());
    }
};
