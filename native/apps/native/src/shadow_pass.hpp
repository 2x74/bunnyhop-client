#pragma once

class ShadowPass {
    Gl &gl;
    gfx::Context &context;
    RenderResources &resources;
    RenderUniforms &uniforms;
    WorldPass &world;

public:
    ShadowPass(Gl &g, gfx::Context &ctx, RenderResources &r, RenderUniforms &u, WorldPass &w)
        : gl(g)
        , context(ctx)
        , resources(r)
        , uniforms(u)
        , world(w) {}

    GLuint depthProgram = 0;
    // Sun shadows of the composer looks (sun_shadows.hpp), on their own texture unit.
    std::unique_ptr<SunShadowMap> sunShadows;
    GLuint cutoutDepthProgram = 0;
    static constexpr GLint sun_shadow_unit = 11;

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
        const GLuint shader = cutouts ? cutoutDepthProgram : depthProgram;
        if (cutouts) {
            const auto &m = world.materials[material];
            gl.BindTexture(GL_TEXTURE_2D, m.texture < 0 ? resources.white : resources.texture(m.texture));
            gl.Uniform1f(
                    uniforms.loc(shader, "cutoff"), (m.flags & world.material_alpha_test) ? m.alpha_ref : cutout_alpha
            );
        }
        gl.BindVertexArray(mesh.vao);
        gl.UniformMatrix4fv(uniforms.loc(shader, "model"), 1, GL_FALSE, matrix.data());
        gl.DrawElements(GL_TRIANGLES, count, GL_UNSIGNED_INT, reinterpret_cast<void *>(uintptr_t(first) * 4));
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
            const GLuint shader = cutouts ? cutoutDepthProgram : depthProgram;
            gl.UseProgram(shader);
            gl.UniformMatrix4fv(uniforms.loc(shader, "viewProjection"), 1, GL_FALSE, lightVp.data());
            if (!cutouts) gl.Uniform1f(uniforms.loc(shader, "clipHeight"), render_no_clip_height);
            gl.ActiveTexture(GL_TEXTURE0);
            gl.Uniform1i(uniforms.loc(shader, "baseTexture"), 0);
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
        for (const auto &actor : roomActors)
            if (actor.ghost_slot < 0) viewmodel->draw_actor(actor, lightVp, eye, seconds);
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
        gl.UseProgram(world.program);
        gl.Uniform1i(uniforms.loc(world.program, "sunActive"), terms.active);
        if (!terms.active) return;
        gl.Uniform1i(uniforms.loc(world.program, "sunShadowActive"), terms.shadows);
        gl.Uniform1f(uniforms.loc(world.program, "sunSkyFill"), terms.fill);
        gl.Uniform1f(uniforms.loc(world.program, "sunBakedScale"), terms.baked);
        gl.Uniform1f(uniforms.loc(world.program, "sunDirectStrength"), terms.direct);
        gl.Uniform1f(uniforms.loc(world.program, "sunShadowStrength"), terms.strength);
        gl.Uniform3fv(uniforms.loc(world.program, "sunLightDirection"), 1, frameSun.direction.data());
        const auto &color = !frameSun.from_pack && terms.direct > 0 ? world.mapSun.irradiance : frameSun.color;
        gl.Uniform3fv(uniforms.loc(world.program, "sunLightColor"), 1, color.data());
        gl.Uniform3fv(uniforms.loc(world.program, "sunAmbientColor"), 1, frameSun.ambient.data());
        if (!terms.shadows) return;
        const int size = graphics.look.shadow_size;
        const float range = std::clamp(graphics.look.shadow_distance, 256.f, 4096.f);
        const auto lightVp = sun_view_projection({eye[0], eye[1], eye[2]}, frameSun.direction, range, size);
        GLint drawTarget = 0, readTarget = 0;
        gl.GetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &drawTarget);
        gl.GetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &readTarget);
        sunShadows->begin(size);
        gl.Disable(GL_BLEND);
        gl.Disable(GL_CULL_FACE);
        gl.Enable(GL_DEPTH_TEST);
        gl.Enable(GL_POLYGON_OFFSET_FILL);
        gl.PolygonOffset(2, 4);
        draw_shadow_casters(lightVp, range, eye, seconds, viewmodel, roomActors);
        gl.Disable(GL_POLYGON_OFFSET_FILL);
        gl.BindFramebuffer(GL_DRAW_FRAMEBUFFER, GLuint(drawTarget));
        gl.BindFramebuffer(GL_READ_FRAMEBUFFER, GLuint(readTarget));
        gl.UseProgram(world.program);
        gl.UniformMatrix4fv(uniforms.loc(world.program, "sunShadowMatrix"), 1, GL_FALSE, lightVp.data());
        gl.Uniform1f(uniforms.loc(world.program, "sunShadowTexel"), 1.f / float(size));
        gl.Uniform1f(uniforms.loc(world.program, "sunShadowRadius"), size <= 512 ? 1.f : 2.f);
        gl.Uniform1f(uniforms.loc(world.program, "sunShadowBias"), shadow_bias);
        sunShadows->bind(sun_shadow_unit);
        gl.ActiveTexture(GL_TEXTURE0);
    }

    void prepare_depth_program() {
        depthProgram = link_program(gl, native_render::depth_vertex, native_render::depth_fragment);
    }

    void prepare_resources() {
        sunShadows = std::make_unique<SunShadowMap>(context);
        cutoutDepthProgram = link_program(gl, native_render::cutout_depth_vertex, native_render::cutout_depth_fragment);
        gl.UseProgram(world.program);
        gl.Uniform1i(uniforms.loc(world.program, "sunShadowMap"), sun_shadow_unit);
        gl.Uniform1i(uniforms.loc(world.program, "sunActive"), 0);
    }
};
