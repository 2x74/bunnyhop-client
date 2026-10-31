#pragma once

class ShadowPass {
    gfx::Context &context;
    RenderResources &resources;
    WorldPass &world;

public:
    ShadowPass(gfx::Context &ctx, RenderResources &r, WorldPass &w) : context(ctx), resources(r), world(w) {}

    RenderDepthProgram depthProgram{context};
    // Sun shadows of the composer looks (sun_shadows.hpp), on their own texture unit.
    std::unique_ptr<SunShadowMap> sunShadows;
    RenderDepthProgram cutoutDepthProgram{context};
    gfx::Pipeline casterPipeline, endPipeline;
    static constexpr unsigned sun_shadow_unit = 11;

    ~ShadowPass() {
        context.destroy(casterPipeline);
        context.destroy(endPipeline);
    }

    struct SunTerms {
        bool active = false, shadows = false;
        float direct = 0, fill = 0, baked = 1, strength = 0;
    };

    // How strongly the profile's sun and sky light the map (web composer-pipeline.ts renderFrame's SunShadows).
    SunTerms sun_terms(
            const native::GraphicsSettings &graphics,
            const native::SceneSun &frameSun,
            const native::VisualProfile &profile
    ) const {
        SunTerms terms;
        const auto &look = graphics.look;
        if (!look.composer() || graphics.potato || graphics.fullbright || !frameSun.present) return terms;
        terms.fill = std::clamp(profile.sky_fill * std::clamp(look.ambient_contribution, 0.f, 2.f), 0.f, .3f);
        terms.shadows = look.dynamic_shadows;
        terms.active = terms.shadows || terms.fill > 0;
        if (!terms.shadows) return terms;
        terms.direct = std::clamp(profile.sun_direct * std::clamp(look.direct_contribution, 0.f, 2.f), 0.f, 2.f);
        terms.baked = std::clamp(profile.baked_scale, .4f, 1.f);
        terms.strength = std::clamp(look.shadow_strength, 0.f, .4f);
        return terms;
    }

    // Whether a material casts into the sun's depth map: solid, or cut out by its texture's alpha (leaves, fences).
    enum class Caster { none, solid, cutout };

    Caster caster(uint32_t material) const {
        static constexpr uint32_t additive = 8;
        if (material >= world.materials.size()) return Caster::none;
        const auto &m = world.materials[material];
        if (m.kind == 2 || m.kind == 3 || (m.flags & additive)) return Caster::none;
        return (m.flags & (world.material_translucent | world.material_alpha_test)) || m.alpha < 1 ? Caster::cutout
                                                                                                   : Caster::solid;
    }

    void cast_group(
            const RenderGeometry &mesh,
            bool prop,
            uint32_t material,
            uint32_t first,
            uint32_t count,
            int32_t entity,
            uint32_t model,
            const native::Matrix &lightVp,
            float range,
            bool cutouts
    ) {
        static constexpr float cutout_alpha = .5f;
        const auto kind = caster(material);
        if (kind == Caster::none || (kind == Caster::cutout) != cutouts) return;
        const auto &transform = world.scene_transform(prop, entity, model);
        if (!transform.visible) return;
        const auto matrix = native::model_matrix(transform);
        const auto bounds = world.groupBounds.find((uint64_t(prop) << 63) | first);
        if (bounds != world.groupBounds.end() && !native_render::in_light_box(bounds->second, matrix, lightVp, range))
            return;
        auto &shader = cutouts ? cutoutDepthProgram : depthProgram;
        float cutoff = 0;
        if (cutouts) {
            const auto &materialInfo = world.materials[material];
            resources.bind(0, materialInfo.texture < 0 ? resources.white : resources.texture(materialInfo.texture));
            cutoff = materialInfo.flags & world.material_alpha_test ? materialInfo.alpha_ref : cutout_alpha;
        }
        context.bind_geometry(mesh.geometry);
        shader.model(matrix, cutoff);
        context.draw_indexed(
                gfx::Primitive::triangles, gfx::IndexType::u32, size_t(first) * sizeof(uint32_t), int(count)
        );
    }

    // World groups, props and players into the sun's depth map: solid surfaces, then cut-outs by their alpha.
    void draw_shadow_casters(
            const native::Matrix &lightVp,
            float range,
            const float eye[3],
            double seconds,
            NativeViewmodel *viewmodel,
            std::span<const native_render::Actor> roomActors
    ) {
        ++world.sceneNumber;
        for (const bool cutouts : {false, true}) {
            auto &shader = cutouts ? cutoutDepthProgram : depthProgram;
            shader.bind(lightVp);
            for (const auto &g : world.groups)
                if (!g.sky3d)
                    cast_group(
                            world.worldMesh,
                            false,
                            g.material,
                            g.first_index,
                            g.index_count,
                            -1,
                            g.model,
                            lightVp,
                            range,
                            cutouts
                    );
            for (const auto &g : world.propGroups)
                if (!g.sky3d)
                    cast_group(
                            world.propMesh,
                            true,
                            g.material,
                            g.first_index,
                            g.index_count,
                            g.entity,
                            0,
                            lightVp,
                            range,
                            cutouts
                    );
        }
        if (!viewmodel) return;
        // Legacy skinned meshes use texture parameters for their single-level bone texture.
        context.unbind_sampler(0);
        for (const auto &actor : roomActors)
            if (actor.ghost_slot < 0) viewmodel->draw_actor(actor, lightVp, eye, seconds);
    }

    void set_sun_values(const SunTerms &terms, const native::SceneSun &frameSun) {
        world.sunValues.sunShadowActive = terms.shadows;
        world.sunValues.sunSkyFill = terms.fill;
        world.sunValues.sunBakedScale = terms.baked;
        world.sunValues.sunDirectStrength = terms.direct;
        world.sunValues.sunShadowStrength = terms.strength;
        world.sunValues.sunLightDirection = frameSun.direction;
        const auto &color = !frameSun.from_pack && terms.direct > 0 ? world.mapSun.irradiance : frameSun.color;
        world.sunValues.sunLightColor = color;
        world.sunValues.sunAmbientColor = frameSun.ambient;
    }

    // The sun's depth map around the camera and the world shader's sun terms for this frame.
    void prepare_sun_light(
            const float eye[3],
            double seconds,
            const native::GraphicsSettings &graphics,
            const native::SceneSun &frameSun,
            const native::VisualProfile &profile,
            NativeViewmodel *viewmodel,
            std::span<const native_render::Actor> roomActors
    ) {
        static constexpr float shadow_bias = .0003f;
        const auto terms = sun_terms(graphics, frameSun, profile);
        context.bind_program(world.program);
        world.sunValues.sunActive = terms.active;
        if (!terms.active) {
            world.upload_sun();
            return;
        }
        set_sun_values(terms, frameSun);
        if (!terms.shadows) {
            world.upload_sun();
            return;
        }
        const int size = graphics.look.shadow_size;
        const float range = std::clamp(graphics.look.shadow_distance, 256.f, 4096.f);
        const auto lightVp = sun_view_projection({eye[0], eye[1], eye[2]}, frameSun.direction, range, size);
        const auto restore = context.current_target();
        const auto viewport = context.current_viewport();
        sunShadows->begin(size);
        context.pipeline(casterPipeline);
        draw_shadow_casters(lightVp, range, eye, seconds, viewmodel, roomActors);
        context.pipeline(endPipeline);
        context.bind_target(restore);
        context.viewport(viewport);
        world.sunValues.sunShadowMatrix = lightVp;
        world.sunValues.sunShadowTexel = 1.f / float(size);
        world.sunValues.sunShadowRadius = size <= 512 ? 1.f : 2.f;
        world.sunValues.sunShadowBias = shadow_bias;
        world.upload_sun();
        sunShadows->bind(sun_shadow_unit);
    }

    void prepare_depth_program() {
        depthProgram.program =
                context.create_program({{"depth", ""}, native_render::depth_vertex, native_render::depth_fragment});
        depthProgram.prepare_constants();
    }

    void prepare_resources() {
        sunShadows = std::make_unique<SunShadowMap>(context);
        cutoutDepthProgram.program = context.create_program(
                {{"cutout-depth", ""}, native_render::cutout_depth_vertex, native_render::cutout_depth_fragment}
        );
        cutoutDepthProgram.prepare_constants();
        context.texture_unit(cutoutDepthProgram.program, "baseTexture", 0);
        gfx::PipelineState state;
        state.raster.offset = true;
        state.raster.slope_bias = 2;
        state.raster.constant_bias = 4;
        casterPipeline = context.create_pipeline(state);
        endPipeline = context.create_pipeline({});
        context.bind_program(world.program);
        world.sunValues.sunActive = 0;
    }
};
