#pragma once
#include "bunnyhop_native.h"
#include "native_input.hpp"
#include "native_math.hpp"
#include "render_shaders.hpp"
#include "scene_draw_list.hpp"
#include "render_math.hpp"
#include "water_capture.hpp"
#include "texture_bleed.hpp"
#include "ghost_trails.hpp"
#include "graphics_settings.hpp"
#include "runner_view.hpp"
#include "paint.hpp"
#include "measure.hpp"
#include "scene_lighting.hpp"
#include "sky_image.hpp"
#include "zone_effects.hpp"
#include "resource_loading.hpp"
#include "actor_anim.hpp"
#include "tp_inspect.hpp"
#include "third_person_events.hpp"
#include "knife_spinner.hpp"
#include "inspect_cues.hpp"
#include <span>
#include "nlohmann/json.hpp"
#include <filesystem>
#include <chrono>
#include <sstream>
#include <regex>
#include <zlib.h>
#include <memory>
#include <optional>
#include <future>
#include <thread>
#include <array>
#include <SDL3/SDL.h>
#include <SDL3/SDL_opengl.h>
#include "player_material.hpp"
#include "ponytail_motion.hpp"
#include <algorithm>
#include <cmath>
#include <deque>
#include <fstream>
#include <iostream>
#include <limits>
#include <numeric>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "gfx.hpp"

namespace native {
#include "native_presentation.hpp"
#include "native_viewmodel.hpp"
#include "native_map_effects.hpp"
#include "ghost_route.hpp"
// Standard headers must be included at file scope before these GL-dependent definitions.
#include "source_hdr.hpp"
#include "enhanced_look.hpp"
#include "sun_shadows.hpp"
#include "water_reflection.hpp"
#include "render_uniforms.hpp"
#include "water_pass.hpp"
#include "render_resources.hpp"
#include "render_profile.hpp"
#include "world_pass.hpp"
#include "sky_pass.hpp"
#include "shadow_pass.hpp"
#include "presentation_pass.hpp"

class Renderer {
    RenderProfile profile;
    Gl &gl;
    gfx::Context graphicsContext;
    RenderUniforms uniforms{gl};
    BhContext *core;
    RenderResources resources{gl, core};
    WaterPass water{gl, uniforms, core};
    WorldPass world{gl, core, resources, uniforms, profile};
    SkyPass sky{gl, core, resources, uniforms};
    ShadowPass shadows{gl, resources, uniforms, world};
    PresentationPass presentationPass{gl, core, profile};
    bool flashlightEnabled = false;
    float fieldOfView = 90;
    std::vector<native_render::Actor> roomActors;
    std::optional<native_render::Actor> replayActor, compareActor;
    std::string outfit, packedLoadout;
    static constexpr float no_clip_height = render_no_clip_height;
    float clipHeight = no_clip_height;
    std::unique_ptr<NativeViewmodel> viewmodel;
    bool viewmodelVisible = true, floorWeaponsVisible = true;
    std::optional<uint32_t> viewmodelWeapon;
    std::optional<native_render::Actor> spectatedActor;
    uint32_t spectatedTick = ~0u, spectatedFlags = 0;
    bool spectatedSilenced = false, viewmodelLeftHand = false;
    native_render::EventQueue<unsigned, 32> spectatedAttacks;
    // Source look (source_hdr.hpp): CS:S's exposure and bloom on maps whose lightmap came from HDR lighting.
    bool sourceLook = true, hdrUnavailable = false;
    std::unique_ptr<SourceHdr> hdr;
    double lastSeconds = -1;

    // CS:S's exposure and bloom on maps with HDR lighting: the Source look's own pass, and the first step of the
    // Enhanced and Cinematic looks.
    SourceHdr *hdr_object() {
        if (!sourceLook || graphics.potato || graphics.fullbright || !world.lightmapInfo.hdr || hdrUnavailable)
            return nullptr;
        if (!hdr) try {
                hdr = std::make_unique<SourceHdr>(graphicsContext, gl);
            } catch (const std::exception &e) {
                hdrUnavailable = true;
                std::cerr << "Native HDR unavailable, drawing straight: " << e.what() << '\n';
                return nullptr;
            }
        if (hdr) hdr->bloom = graphics.bloom;
        return hdr.get();
    }

    SourceHdr *hdr_pass() { return graphics.look.composer() ? nullptr : hdr_object(); }

    // The Enhanced and Cinematic looks (enhanced_look.hpp). Potato draws plainly, as on the website.
    std::unique_ptr<EnhancedLook> enhanced;
    bool enhancedUnavailable = false;
    // The pass drawing this frame's world, for the water's refraction copy.
    EnhancedLook *frameLook = nullptr;

    EnhancedLook *enhanced_pass() {
        if (!graphics.look.composer() || graphics.potato || enhancedUnavailable) return nullptr;
        if (!enhanced) try {
                enhanced = std::make_unique<EnhancedLook>(graphicsContext, gl);
            } catch (const std::exception &e) {
                enhancedUnavailable = true;
                std::cerr << "Enhanced look unavailable, drawing the Source look: " << e.what() << '\n';
                return nullptr;
            }
        return enhanced.get();
    }

    std::string mapName, mapSha;
    native::SceneSun frameSun;
    native::GraphicsSettings graphics, chosenGraphics;
    std::optional<native::RunnerView> runnerView;
    std::unique_ptr<GraphicsTarget> graphicsTarget;
    bool anisotropySupported = false;
    uint32_t queuedWeaponFlags = 0, queuedAttackMode = 0;
    bool queuedAttack = false;

    int viewportWidth = 1, viewportHeight = 1;
    // Window pixels per point: the route's line widths are in points, like the website's CSS pixels.
    float pixelDensity = 1;

    void water_uniforms(GLuint target, const float eye[3], const native::Matrix &vp) {
        water.water_uniforms(target, eye, vp, viewportWidth, viewportHeight);
    }

    void capture_refraction() {
        water.capture_refraction(viewportWidth, viewportHeight, resources.ownedTextures, [&] {
            if (frameLook)
                frameLook->refraction_source();
            else if (auto *hdr = hdr_pass())
                hdr->refraction_source(viewportWidth, viewportHeight);
            else if (graphics.target_needed())
                graphicsTarget->refraction_source();
        });
    }

    double lastYaw = 0, lastPitch = 0;

public:
    nlohmann::json surface_tools_state() { return presentationPass.surface_tools_state(); }

    const char *
    surface_tool(std::string_view action, const BhState &state, const native::Input &input, bool held = false) {
        return presentationPass.surface_tool(action, state, input, held);
    }

    const char *tool_key(
            std::string_view code,
            bool down,
            bool repeat,
            const BhState &state,
            const native::Input &input,
            bool can_paint
    ) {
        return presentationPass.tool_key(code, down, repeat, state, input, can_paint);
    }

    void surface_tools_frame(const BhState &state, const native::Input &input, bool active, bool spectating) {
        presentationPass.surface_tools_frame(state, input, active, spectating);
    }

    std::string
    tool_message(const nlohmann::json &message, const BhState &state, const native::Input &input, bool can_paint) {
        return presentationPass.tool_message(message, state, input, can_paint);
    }

    template <class Hud>
    void draw_measure_label(Hud &hud, const native::Matrix &vp, const float eye[3], int width, int height) {
        presentationPass.draw_measure_label(hud, vp, eye, width, height, graphics);
    }

    const native_render::GhostPath &ghost_path(unsigned slot) const { return presentationPass.ghost_path(slot); }

    void set_ghost_path(unsigned slot, native_render::GhostPath path) {
        presentationPass.set_ghost_path(slot, std::move(path));
    }

    void route_context(uint32_t track, const std::string &style, bool visible) {
        presentationPass.route_context(track, style, visible);
    }

    void clear_ghosts() { presentationPass.clear_ghosts(); }

    void register_ghost(
            unsigned slot,
            uint32_t handle,
            const nlohmann::json &info,
            native_render::GhostSource source = native_render::GhostSource::custom
    ) {
        presentationPass.register_ghost(slot, handle, info, source);
    }

    void ghost_enabled(unsigned slot, bool enabled) { presentationPass.ghost_enabled(slot, enabled); }

    bool ghost_visible(unsigned slot) const { return presentationPass.ghost_visible(slot); }

    const std::string &ghost_name(unsigned slot) const { return presentationPass.ghost_name(slot); }

    const std::string &ghost_loadout(unsigned slot) const { return presentationPass.ghost_loadout(slot); }

    void decorate_ghost(native_render::Actor &actor, unsigned slot) const {
        presentationPass.decorate_ghost(actor, slot, packedLoadout);
    }

    void set_zones(const std::vector<BhZone> &zones) { presentationPass.set_zones(zones); }

    void set_zone_state(uint32_t track, const BhRunState &state, bool gold = false) {
        presentationPass.set_zone_state(track, state, gold);
    }

    void set_color_blind(const std::string &mode) { presentationPass.set_color_blind(mode); }

    void set_zones_visible(bool value) { presentationPass.set_zones_visible(value); }

    void set_triggers_visible(bool value) { presentationPass.set_triggers_visible(value); }

    void set_clips_visible(bool value) { presentationPass.set_clips_visible(value); }

    void set_effects_visible(bool value) { presentationPass.set_effects_visible(value); }

    void draw_presentation(const native::Matrix &vp, const float eye[3], double seconds) {
        const PresentationPass::View view{
                graphics,
                lastYaw,
                lastPitch,
                viewmodelVisible,
                replayActor,
                roomActors,
                viewportWidth,
                viewportHeight,
                pixelDensity
        };
        presentationPass.draw_presentation(vp, eye, seconds, view, water);
    }

    nlohmann::json graphics_limits() const {
        GLint maximumSamples = 0;
        gl.GetIntegerv(GL_MAX_SAMPLES, &maximumSamples);
        float maximumAnisotropy = 1;
        if (anisotropySupported) gl.GetFloatv(0x84ff, &maximumAnisotropy);
        return {{"msaaMax", std::min(8, maximumSamples)},
                {"anisotropyMax", maximumAnisotropy},
                {"waterReflections", false},
                {"models", {"bunny"}},
                {"msaaRestartRequired", false}};
    }

    uint64_t refraction_captures() const { return water.refractionCaptures; }

    native::GraphicsView output_view(int width, int height) const {
        return native::graphics_view(graphics, width, height);
    }

    const native::GraphicsSettings &current_graphics() const { return graphics; }

    bool tag_visible(bool ghost) const { return ghost || graphics.tags_players; }

    bool tags_through_walls() const { return graphics.tags_through_walls; }

    void set_profiling(bool enabled) { profile.profiling = enabled; }

    nlohmann::json profile_json() const {
        const auto &p = profile.frameProfile;
        return {{"lightmapRefreshMs", p.lightmapRefresh},
                {"lightmapUploadMs", p.lightmapUpload},
                {"skyMs", p.sky},
                {"waterReflectionMs", p.waterReflection},
                {"drawSceneBuildCullMs", p.buildCull},
                {"drawSceneSortMs", p.sort},
                {"drawSceneSubmitMs", p.submit},
                {"presentationMs", p.presentation},
                {"floorReportMs", p.floorReport},
                {"floorDrawMs", p.floorDraw},
                {"floorCount", p.floorCount},
                {"actorDrawMs", p.actorDraw},
                {"presentationBuildMs", p.presentationBuild},
                {"presentationWaterUniformsMs", p.presentationWaterUniforms},
                {"presentationSubmitMs", p.presentationSubmit},
                {"viewmodelMs", p.viewmodel},
                {"hdrFinishMs", p.hdrFinish},
                {"groups", p.groups},
                {"survivors", p.survivors},
                {"drawCalls", p.drawCalls},
                {"triangles", p.triangles},
                {"atlasUpdateBytes", p.atlasUpdateBytes},
                {"hdrAuthored", p.hdrAuthored},
                {"hdrEffective", p.hdrEffective},
                {"waterVolumes", p.waterVolumes}};
    }

    void set_actor_models(const std::string &player, const std::string &ghost) {
        if (viewmodel) viewmodel->actor_models(player, ghost);
    }

    void set_player_glow(std::optional<native_render::Glow> glow) {
        if (viewmodel) viewmodel->player_glow(std::move(glow));
    }

    void set_glow_visible(bool show, bool firstPerson) {
        if (viewmodel) viewmodel->glow_visibility(show, firstPerson);
    }

    void set_ghost_cosmetics(const std::string &ghostId, const std::string &trailId) {
        if (viewmodel) {
            viewmodel->ghost_cosmetics(ghostId);
            presentationPass.trailColors = viewmodel->cosmetic_colors(trailId);
            presentationPass.ghostRouteColor = viewmodel->cosmetic_colors(ghostId)[0];
        }
    }

    nlohmann::json water_diagnostics() const {
        auto out = nlohmann::json::array();
        for (const auto &v : water.volumes)
            out.push_back({{"mins", v.lo}, {"maxs", v.hi}, {"color", v.color}, {"fogRange", v.range}});
        return out;
    }

    void set_water_quality(int value) { water.waterQuality = std::clamp(value, 0, 1); }

    void set_flashlight(bool value) { flashlightEnabled = value; }

    void set_viewmodel_bob(float value) {
        if (viewmodel) viewmodel->set_bob(value);
    }

    ResourceLoading loading;

    Renderer(
            Gl &g,
            BhContext *c,
            const std::filesystem::path &assetRoot = BUNNYHOP_NATIVE_ASSET_ROOT,
            bool deferred = false,
            std::unique_ptr<NativeViewmodel> prepared_viewmodel = {}
    )
        : gl(g)
        , graphicsContext(g)
        , core(c) {
        viewmodel = std::move(prepared_viewmodel);
        loading = prepare_resources(assetRoot);
        if (!deferred) {
            while (!poll_loading()) {
            }
        }
    }

    gfx::Context &graphics_context() { return graphicsContext; }

    bool poll_loading() {
        constexpr auto frame_budget = std::chrono::milliseconds(2);
        const auto start = std::chrono::steady_clock::now();
        do {
            if (loading.step()) return true;
        } while (std::chrono::steady_clock::now() - start < frame_budget);
        return false;
    }

    void prepare_sky() {
        sky.prepare_sky();
        world.prepare_lightmap();
    }

    ResourceLoading prepare_world() { return world.prepare_world(water); }

    ResourceLoading prepare_props() { return world.prepare_props(); }

    ResourceLoading prepare_textures() { return world.prepare_textures(); }

    void prepare_uniforms() { world.prepare_uniforms(); }

    ResourceLoading load_normals() { return world.load_normals(); }

    void draw_scene(const native::Matrix &vp, const float eye[3], bool skyPass, double time, bool reflection = false) {
        const WorldPass::View view{
                graphics,
                sky.skyInfo,
                sky.hasSky,
                flashlightEnabled,
                lastYaw,
                lastPitch,
                clipHeight,
                viewportWidth,
                viewportHeight
        };
        world.draw_scene(vp, eye, skyPass, time, reflection, view, water, [&] { capture_refraction(); });
    }

    ResourceLoading prepare_scene() {
        resources.prepare_fallback_textures();
        auto worldLoading = prepare_world();
        while (!worldLoading.step())
            co_yield "world geometry";
        auto props = prepare_props();
        while (!props.step())
            co_yield "prop geometry";
        prepare_sky();
        co_yield "lightmap";
        auto textures = prepare_textures();
        while (!textures.step())
            co_yield "texture";
        auto waterLoading = water.prepare_water(world.groups, world.materials, world.extras);
        while (!waterLoading.step())
            co_yield "water";
        prepare_uniforms();
    }

    void print_geometry() {
        size_t nv = 0, pv = 0, sv = 0;
        bh_vertices(core, &nv);
        bh_prop_vertices(core, &pv);
        bh_sky_vertices(core, &sv);
        std::cout << "Native renderer: " << nv / 10 << " BSP vertices, " << pv / 8 << " prop vertices, " << sv / 3
                  << " sky vertices, " << water.volumes.size() << " water volumes, 3D sky=" << sky.hasSky << "\n";
    }

    ResourceLoading prepare_resources(std::filesystem::path assetRoot) {
        presentationPass.measureLabel.reserve(100);
        world.prepare_program();
        co_yield "world shader";
        sky.prepare_program();
        shadows.prepare_depth_program();
        co_yield "sky shader";
        auto scene = prepare_scene();
        while (!scene.step())
            co_yield "scene";
        co_yield "normals";
        auto normal_loading = load_normals();
        while (!normal_loading.step())
            co_yield "normal texture";
        co_yield "resource";
        gl.UseProgram(world.program);
        gl.Uniform1i(uniforms.loc(world.program, "normalTexture"), 7);
        gl.Uniform3fv(uniforms.loc(world.program, "sunDirection"), 1, world.sunDirection.data());
        shadows.prepare_resources();
        presentationPass.presentation = std::make_unique<NativePresentation>(graphicsContext);
        presentationPass.mapEffects.load(core);

        anisotropySupported = SDL_GL_ExtensionSupported("GL_EXT_texture_filter_anisotropic");
        co_yield "viewmodel";
        if (viewmodel)
            viewmodel->prepare_graphics();
        else
            viewmodel = std::make_unique<NativeViewmodel>(gl, assetRoot);
        co_yield "resource";
        gl.Enable(GL_DEPTH_TEST);
        gl.DepthFunc(GL_LEQUAL);
        gl.CullFace(GL_BACK);
        gl.FrontFace(GL_CCW);
        print_geometry();
    }

    ~Renderer() {
        loading = {};
        presentationPass.ghostRoutes.reset();
        graphicsTarget.reset();
        presentationPass.presentation.reset();
        hdr.reset();
        viewmodel.reset();
        resources.destroy(world.worldMesh);
        resources.destroy(world.propMesh);
        resources.destroy(sky.skyMesh);
        if (!resources.ownedTextures.empty())
            gl.DeleteTextures(resources.ownedTextures.size(), resources.ownedTextures.data());
        if (water.planesTexture) gl.DeleteTextures(1, &water.planesTexture);
        if (resources.emptyVao) gl.DeleteVertexArrays(1, &resources.emptyVao);
        if (world.program) gl.DeleteProgram(world.program);
        if (sky.skyProgram) gl.DeleteProgram(sky.skyProgram);
        if (shadows.depthProgram) gl.DeleteProgram(shadows.depthProgram);
        if (shadows.cutoutDepthProgram) gl.DeleteProgram(shadows.cutoutDepthProgram);
    }

    // A replay watched in the runner's view: their shape and fit over the viewer's own graphics settings.
    void use_runner_view(const std::optional<native::RunnerView> &view) {
        if (view == runnerView) return;
        runnerView = view;
        graphics = runnerView ? native::runner_view_graphics(chosenGraphics, *runnerView) : chosenGraphics;
    }

    void graphics_settings(const nlohmann::json &settings) {
        chosenGraphics = native::GraphicsSettings::read(settings);
        graphics = runnerView ? native::runner_view_graphics(chosenGraphics, *runnerView) : chosenGraphics;
        presentationPass.graphics_settings(settings);
        hdr_pass();
        // The looks' passes link with the settings (at map load or when the look changes), never in a run's frame.
        enhanced_pass();
        if (graphics.target_needed() && !graphicsTarget)
            graphicsTarget = std::make_unique<GraphicsTarget>(graphicsContext, gl);
        sourceLook = graphics.source;
        if (hdr) hdr->bloom = graphics.bloom;
        if (anisotropySupported) {
            constexpr GLenum anisotropy = 0x84fe, maximumAnisotropy = 0x84ff;
            float maximum = 1;
            gl.GetFloatv(maximumAnisotropy, &maximum);
            for (GLuint texture : resources.ownedTextures) {
                gl.BindTexture(GL_TEXTURE_2D, texture);
                gl.TexParameterf(GL_TEXTURE_2D, anisotropy, std::min(float(graphics.anisotropy), maximum));
            }
        }
    }

    // The Source look on or off (the Plain look). The Enhanced and Cinematic looks build on the Source look.
    void set_source_look(bool value) {
        sourceLook = value;
        if (!value)
            graphics.look.look = native::Look::classic;
        else if (graphics.look.look == native::Look::classic)
            graphics.look.look = native::Look::source;
    }

    // The map's name and build hash, for the looks' per-map lighting profiles (look_settings.hpp).
    void set_map_identity(std::string name, std::string sha) {
        mapName = std::move(name);
        mapSha = std::move(sha);
    }

    void use_sky(const std::string &id, const native::SkyPicture *picture) { sky.use_sky(id, picture); }

    void set_pixel_density(float value) { pixelDensity = std::isfinite(value) && value > 0 ? value : 1; }

    // Current Source-look exposure (1 off maps with HDR lighting or with the look off).
    float exposure() const { return hdr && sourceLook && world.lightmapInfo.hdr ? hdr->current_exposure() : 1; }

    // Scope FOV is presentation only; persisted player FOV remains 60–130.
    void set_camera_fov(float value) {
        if (std::isfinite(value)) fieldOfView = std::clamp(value, 15.f, 130.f);
    }

    void set_fov(float value) {
        if (std::isfinite(value)) fieldOfView = std::clamp(value, 60.f, 130.f);
    }

    void set_viewmodel(
            float fov = 54,
            float x = .6f,
            float y = 1.5f,
            float z = -.9f,
            bool left = false,
            bool visible = true,
            float bob = 1,
            float sway = 1
    ) {
        viewmodelLeftHand = left;
        viewmodelVisible = visible;
        if (viewmodel) {
            viewmodel->settings(fov, x, y, z, left);
            viewmodel->set_bob(bob);
            viewmodel->set_sway(sway);
        }
    }

    void reset_presentation() {
        spectatedAttacks.clear();
        spectatedFlags = 0;
        lastSeconds = -1;
        if (hdr) hdr->reset();
        presentationPass.ghostTrails.clear();
        presentationPass.mapEffects.reset();
        presentationPass.attackEvents.clear();
        presentationPass.shotEffects.clear();
        queuedWeaponFlags = queuedAttackMode = 0;
        queuedAttack = false;
        if (viewmodel) viewmodel->reset_presentation();
    }

    // The first-person inspect's sound cues heard since the last clear.
    std::span<const native_render::InspectCue> inspect_cues() const {
        return viewmodel ? viewmodel->inspect_cues().cues() : std::span<const native_render::InspectCue>();
    }

    void clear_inspect_cues() {
        if (viewmodel) viewmodel->inspect_cues().clear();
    }

    void inspect_press() {
        if (viewmodel) viewmodel->inspect_press();
    }

    void inspect_held(bool value) {
        if (viewmodel) viewmodel->inspect_held(value);
    }

    void set_cosmetics(const std::string &value, const std::string &loadout) {
        outfit = value;
        packedLoadout = loadout;
        if (viewmodel) viewmodel->cosmetics(value, loadout);
    }

    void set_replay_actor(const BhSnapshot *snapshot, float yaw, float pitch, float opacity = .45f) {
        if (!snapshot) {
            replayActor.reset();
            return;
        }
        native_render::Actor actor;
        actor.id = "replay";
        actor.name = "Replay";
        actor.opacity = std::clamp(opacity, 0.f, 1.f);
        for (int i = 0; i < 3; i++) {
            actor.frame.position[i] = snapshot->player.position[i];
            actor.frame.velocity[i] = snapshot->player.velocity[i];
        }
        actor.frame.yaw = yaw;
        actor.frame.pitch = pitch;
        actor.frame.tick = snapshot->player.tick;
        actor.frame.flags = (snapshot->player.crouched ? 1 : 0) | (snapshot->player.grounded ? 2 : 0);
        actor.frame.weapon = 1;
        actor.outfit = outfit;
        actor.loadout = packedLoadout;
        decorate_ghost(actor, 0);
        replayActor = actor;
    }

    void set_replay_actor(
            const BhGhostFrame &frame, const std::string &actorOutfit, const std::string &loadout, float opacity = .45f
    ) {
        native_render::Actor actor;
        actor.id = "replay";
        actor.name = "Replay";
        actor.frame = frame;
        actor.outfit = actorOutfit;
        actor.loadout = loadout;
        actor.opacity = opacity;
        decorate_ghost(actor, 0);
        replayActor = std::move(actor);
    }

    void set_compare_actor(const native_render::Actor *actor) {
        if (!actor) {
            compareActor.reset();
            return;
        }
        if (!compareActor) compareActor.emplace();
        *compareActor = *actor;
    }

    void set_room_actors(const std::vector<native_render::Actor> &actors) {
        roomActors = actors;
        if (roomActors.size() > 64) roomActors.resize(64);
        for (const auto &actor : roomActors)
            queue_remote_shot(actor);
    }

    // Another player's shot (net/players.ts shot): a tracer along their view from their gun's muzzle (as posed last
    // frame) to where it meets the world here, with the flash and the impact. Your own comes from simulation_tick.
    void queue_remote_shot(const native_render::Actor &actor) {
        constexpr float shot_range_units = 8192;
        constexpr float standing_eye_units = 64, crouched_eye_units = 46;
        if (actor.attack != native_render::gun_shot_pulse || actor.frame.weapon < native_render::first_gun_weapon
            || actor.id.starts_with("ghost-") || actor.id == native_render::own_actor_id)
            return;
        const bool crouched = actor.frame.flags & 1;
        const float pitch = actor.frame.pitch * float(native::radians), yaw = actor.frame.yaw * float(native::radians);
        const native_render::Vec3 forward = {
                std::cos(pitch) * std::cos(yaw), std::cos(pitch) * std::sin(yaw), -std::sin(pitch)
        };
        float eye[3] = {actor.frame.position[0], actor.frame.position[1], actor.frame.position[2]};
        eye[2] += crouched ? crouched_eye_units : standing_eye_units;
        float shot_end[3];
        for (int k = 0; k < 3; ++k)
            shot_end[k] = eye[k] + forward[k] * shot_range_units;
        float fraction = 1;
        if (!bh_trace_camera(core, eye, shot_end, 0, &fraction)) fraction = 1;
        BhAttackReport report{};
        report.weapon = actor.frame.weapon;
        report.hit = fraction < 1;
        for (int k = 0; k < 3; ++k) {
            report.start[k] = eye[k];
            report.end[k] = eye[k] + forward[k] * shot_range_units * fraction;
            report.normal[k] = -forward[k];
        }
        native_render::Vec3 from = remote_muzzle(actor, forward, crouched);
        auto basis = native_render::shot_basis(from, {report.end[0], report.end[1], report.end[2]}, false);
        basis.muzzle = from;
        presentationPass.attackEvents.push({report, basis, true});
    }

    // The muzzle of the bunny's posed gun, else about where it would be (in front of the right hip).
    native_render::Vec3
    remote_muzzle(const native_render::Actor &actor, const native_render::Vec3 &forward, bool crouched) const {
        if (viewmodel)
            if (const auto muzzle = viewmodel->actor_muzzle(actor.id)) return *muzzle;
        constexpr float ahead_units = 26, side_units = 7, standing_hand_units = 46, crouched_hand_units = 30;
        const float flat = std::hypot(forward[0], forward[1]);
        const float length = flat > 0 ? flat : 1;
        const native_render::Vec3 right = {forward[1] / length, -forward[0] / length, 0};
        native_render::Vec3 out{};
        for (int k = 0; k < 2; ++k)
            out[k] = actor.frame.position[k] + forward[k] / length * ahead_units + right[k] * side_units;
        out[2] = actor.frame.position[2] + (crouched ? crouched_hand_units : standing_hand_units);
        return out;
    }

    native::Matrix camera(const float eye[3], double yaw, double pitch, float aspect) {
        if (graphics.aspect > 0) aspect = graphics.aspect;
        auto vp = native::camera_matrix(eye, yaw, pitch, aspect);
        const float scale = 1 / std::tan(float(fieldOfView * native::radians * .5));
        for (int c = 0; c < 4; c++) {
            vp[c * 4] *= scale;
            vp[c * 4 + 1] *= scale;
        }
        return vp;
    }

    void set_spectated_actor(std::optional<native_render::Actor> actor) {
        const bool changed =
                bool(actor) != bool(spectatedActor) || (actor && spectatedActor && actor->id != spectatedActor->id);
        if (changed) {
            spectatedTick = ~0u;
            spectatedFlags = 0;
            spectatedAttacks.clear();
            if (viewmodel) {
                viewmodel->reset_presentation();
                if (!actor) viewmodel->inspect_held(false);
            }
        }
        if (actor) { /* Actor pulses are already fenced by RoomState, independently of interpolated pose ticks. */
            if (viewmodel && actor->inspect) viewmodel->inspect_press();
            if (actor->attack) spectatedAttacks.push(actor->attack);
            if (spectatedTick != ~0u && actor->silenced != spectatedSilenced) spectatedFlags |= 256;
            spectatedTick = actor->frame.tick;
            spectatedSilenced = actor->silenced;
            if (viewmodel) viewmodel->inspect_held(actor->inspectHeld);
        }
        spectatedActor = std::move(actor);
    }

    void set_viewmodel_weapon(std::optional<uint32_t> value) { viewmodelWeapon = value; }

    void set_viewmodel_visible(bool value) { viewmodelVisible = value; }

    void set_floor_weapons_visible(bool value) { floorWeaponsVisible = value; }

    void simulation_tick() {
        BhWeaponReport weapon{};
        BhAttackReport attack{};
        if (bh_weapon_report(core, &weapon)) queuedWeaponFlags |= weapon.flags;
        if (bh_attack_report(core, &attack)) {
            queuedAttack = true;
            queuedAttackMode = attack.mode;
            presentationPass.attackEvents.push(
                    {attack,
                     native_render::shot_basis(
                             {attack.start[0], attack.start[1], attack.start[2]},
                             {attack.end[0], attack.end[1], attack.end[2]},
                             viewmodelLeftHand
                     )}
            );
        }
    }

    // Geometry/materials remain tied to the loaded map; playback may supply another context of that map.
    void set_simulation_context(BhContext *context) {
        if (!context) throw std::runtime_error("Null renderer simulation context");
        core = context;
        reset_presentation();
    }

    // Source look with Water reflections, like the website's SOURCE_WATER. The native Water: Refracted setting still
    // refracts in either look.
    bool water_reflections_enabled() const { return sourceLook && graphics.water_reflections && !graphics.potato; }

    bool water_captures_enabled() const {
        return water.hasWaterMaterials && !graphics.potato && (water_reflections_enabled() || water.waterQuality > 0);
    }

    void plan_water(const float eye[3], const native::Matrix &vp) {
        water.plan_water(eye, vp, water_captures_enabled(), water_reflections_enabled());
    }

    bool panorama_drawn() const { return sky.panorama_drawn(graphics); }

    void draw_sky_backdrop(const float eye[3], const native::Matrix &vp, float aspect, bool mirrored) {
        const SkyPass::View view{
                graphics,
                lastYaw,
                lastPitch,
                fieldOfView,
                world.sunDirection,
                world.hasSun,
                viewportWidth,
                viewportHeight
        };
        sky.draw_sky_backdrop(eye, vp, aspect, mirrored, view, water, world.materials);
    }

    void draw_3d_sky(const float eye[3], float aspect, double seconds, std::optional<float> mirror_height = {}) {
        sky.draw_3d_sky(
                eye,
                seconds,
                graphics,
                clipHeight,
                mirror_height,
                [&](const float skyEye[3]) { return camera(skyEye, lastYaw, lastPitch, aspect); },
                [&](const native::Matrix &vp, const float skyEye[3], double time, bool reflection) {
                    draw_scene(vp, skyEye, true, time, reflection);
                }
        );
    }

    void draw_sky_depth(const native::Matrix &vp) { sky.draw_sky_depth(vp, shadows.depthProgram, clipHeight); }

    void prepare_sun_light(const float eye[3], double seconds) {
        shadows.prepare_sun_light(eye, seconds, graphics, frameSun, visual_profile(), viewmodel.get(), roomActors);
    }

    native::VisualProfile visual_profile() const {
        return native::resolve_visual_profile(graphics.look, mapName, mapSha, world.mapSun.present);
    }

    // This frame's sky turn and sun for the composer looks; material detail follows the pack's sun when it lights.
    void resolve_look_lighting() {
        const bool panorama = panorama_drawn();
        const bool lit =
                graphics.look.composer() && native::pack_lights_scene(graphics.look, visual_profile(), panorama);
        sky.frameSkyYaw = panorama ? native::sky_yaw(graphics.look, lit, sky.skyPanoramaInfo, world.mapSun) : 0;
        const float exposure = sky.skyPanoramaInfo.exposure * std::exp2(std::clamp(graphics.sky_exposure, -4.f, 4.f));
        frameSun = native::resolve_scene_sun(
                world.mapSun, panorama ? &sky.skyPanoramaInfo : nullptr, lit, sky.frameSkyYaw, exposure
        );
        gl.UseProgram(world.program);
        gl.Uniform3fv(
                uniforms.loc(world.program, "sunDirection"),
                1,
                (frameSun.from_pack ? frameSun.direction : world.sunDirection).data()
        );
    }

    // The post-processing of one Enhanced or Cinematic frame (web composer-pipeline.ts applyAppearance).
    LookFrame look_frame(const native::Matrix &vp, const float eye[3], float aspect) const {
        static constexpr float contact_shading_strength = .22f, sun_shafts_strength = .006f, default_haze = .08f;
        const auto config = native::look_config(graphics.look.look);
        const auto profile = visual_profile();
        LookFrame frame;
        frame.bloom_strength = graphics.bloom ? config.bloom * profile.bloom_scale : 0;
        frame.saturation = profile.saturation >= 0 ? profile.saturation : config.saturation;
        frame.contrast = profile.contrast >= 0 ? profile.contrast : config.contrast;
        frame.exposure = profile.exposure;
        frame.shoulder = profile.highlight_shoulder;
        frame.haze = graphics.look.atmosphere ? (profile.haze >= 0 ? profile.haze : default_haze) : 0;
        frame.haze_distance = profile.haze_distance;
        frame.contact_strength = graphics.look.contact_shading ? contact_shading_strength : 0;
        frame.spatial_aa = graphics.look.spatial_aa;
        const float scale = 1 / std::tan(float(fieldOfView * native::radians * .5));
        const float cot = 4.f / 3.f * scale, shownAspect = graphics.aspect > 0 ? graphics.aspect : aspect;
        frame.projection_scale = {cot / shownAspect, cot};
        if (graphics.look.sun_shafts && frameSun.present) {
            const float cp = std::cos(lastPitch * native::radians), sp = std::sin(lastPitch * native::radians);
            const float forward[3] = {
                    cp * float(std::cos(lastYaw * native::radians)),
                    cp * float(std::sin(lastYaw * native::radians)),
                    -sp
            };
            if (const auto at = native::project_sun(vp, eye, forward, frameSun.direction)) {
                frame.sun_uv = *at;
                frame.sun_color = frameSun.color;
                frame.shafts = sun_shafts_strength;
            }
        }
        return frame;
    }

    // Players, ghosts and the replay runner in the water's mirror, as the website's scene capture shows them.
    void draw_reflected_actors(const native::Matrix &vp, const float eye[3], double seconds) {
        if (!viewmodel) return;
        if (replayActor) viewmodel->draw_actor(*replayActor, vp, eye, seconds);
        if (compareActor) viewmodel->draw_actor(*compareActor, vp, eye, seconds);
        for (const auto &actor : roomActors)
            viewmodel->draw_actor(actor, vp, eye, seconds);
    }

    void draw_water_reflection(const float eye[3], float aspect, int width, int height, double seconds) {
        auto phaseStart = profile.profile_now();
        const double scenePhases =
                profile.frameProfile.buildCull + profile.frameProfile.sort + profile.frameProfile.submit;
        const float plane = *water.waterPlan.reflection_height;
        const auto vp = native::multiply(camera(eye, lastYaw, lastPitch, aspect), native_render::mirror_matrix(plane));
        water.draw_reflection(
                eye,
                width,
                height,
                viewportWidth,
                viewportHeight,
                clipHeight,
                [&](const float mirroredEye[3], float reflectionPlane) {
                    draw_sky_backdrop(mirroredEye, vp, aspect, true);
                    gl.Enable(GL_CLIP_DISTANCE0);
                    draw_3d_sky(eye, aspect, seconds, reflectionPlane);
                },
                [&](const float mirroredEye[3]) {
                    gl.ActiveTexture(GL_TEXTURE7);
                    gl.BindTexture(GL_TEXTURE_2D, resources.white);
                    draw_sky_depth(vp);
                    draw_scene(vp, mirroredEye, false, seconds, true);
                },
                [&](const float mirroredEye[3]) { draw_reflected_actors(vp, mirroredEye, seconds); }
        );
        profile.profile_elapsed(profile.frameProfile.waterReflection, phaseStart);
        if (profile.profiling) {
            const double sceneTime = profile.frameProfile.buildCull + profile.frameProfile.sort
                                     + profile.frameProfile.submit - scenePhases;
            profile.frameProfile.waterReflection -= sceneTime;
        }
    }

    void
    draw(int width,
         int height,
         const float eye[3],
         const native::Input &input,
         const BhSnapshot *state = nullptr,
         double seconds = -1) {
        if (width <= 0 || height <= 0) return;
        const int outputWidth = width, outputHeight = height;
        GLint outputTarget = 0;
        gl.GetIntegerv(GL_FRAMEBUFFER_BINDING, &outputTarget);
        const auto graphicsView = native::graphics_view(graphics, width, height);
        if (graphics.target_needed()) {
            graphicsTarget->begin(graphicsView, graphics.samples);
            width = graphicsView.width;
            height = graphicsView.height;
        }
        viewportWidth = width;
        viewportHeight = height;
        if (seconds < 0) seconds = SDL_GetTicks() / 1000.;
        lastYaw = input.yaw();
        lastPitch = input.pitch;
        if (viewmodel) viewmodel->view_angles(float(lastYaw), float(lastPitch));
        if (profile.profiling) {
            profile.frameProfile = {};
            profile.frameProfile.hdrAuthored = world.lightmapInfo.hdr;
            profile.frameProfile.waterVolumes = water.volumes.size();
        }
        auto phaseStart = profile.profile_now();
        BhImage changedLightmap{};
        const int lightmapChanged = bh_lightmap_update(core, &changedLightmap);
        profile.profile_elapsed(profile.frameProfile.lightmapRefresh, phaseStart);
        phaseStart = profile.profile_now();
        if (lightmapChanged > 0) {
            if (profile.profiling) profile.frameProfile.atlasUpdateBytes = changedLightmap.byte_count;
            gl.ActiveTexture(GL_TEXTURE1);
            gl.BindTexture(GL_TEXTURE_2D, world.lightmap);
            gl.TexImage2D(
                    GL_TEXTURE_2D,
                    0,
                    GL_SRGB8_ALPHA8,
                    changedLightmap.width,
                    changedLightmap.height,
                    0,
                    GL_RGBA,
                    GL_UNSIGNED_BYTE,
                    changedLightmap.rgba
            );
        }
        profile.profile_elapsed(profile.frameProfile.lightmapUpload, phaseStart);
        const double dt = lastSeconds < 0 ? 0 : std::max(0., seconds - lastSeconds);
        lastSeconds = seconds;
        const float aspect = float(width) / height;
        const auto vp = camera(eye, lastYaw, lastPitch, aspect);
        resolve_look_lighting();
        prepare_sun_light(eye, seconds);
        gl.Viewport(0, 0, width, height);
        plan_water(eye, vp);
        if (water.waterPlan.reflection_height) draw_water_reflection(eye, aspect, width, height, seconds);
        GLint frameTarget = 0;
        gl.GetIntegerv(GL_FRAMEBUFFER_BINDING, &frameTarget);
        SourceHdr *pass = hdr_pass();
        frameLook = enhanced_pass();
        if (profile.profiling) profile.frameProfile.hdrEffective = pass != nullptr || (frameLook && hdr_object());
        if (frameLook) {
            frameLook->samples(graphics.samples);
            frameLook->begin(width, height);
        } else if (pass) {
            pass->samples(graphics.samples);
            pass->begin(width, height);
        }
        phaseStart = profile.profile_now();
        gl.Viewport(0, 0, width, height);
        gl.ColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
        gl.DepthMask(GL_TRUE);
        if (graphics.potato)
            gl.ClearColor(.616f, .733f, .847f, 1);
        else
            gl.ClearColor(.24, .34, .45, 1);
        gl.Clear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        draw_sky_backdrop(eye, vp, aspect, false);
        const double skySceneBefore =
                profile.frameProfile.buildCull + profile.frameProfile.sort + profile.frameProfile.submit;
        draw_3d_sky(eye, aspect, seconds);
        gl.ActiveTexture(GL_TEXTURE7);
        gl.BindTexture(GL_TEXTURE_2D, resources.white);
        draw_sky_depth(vp);
        profile.profile_elapsed(profile.frameProfile.sky, phaseStart);
        if (profile.profiling)
            profile.frameProfile.sky -= profile.frameProfile.buildCull + profile.frameProfile.sort
                                        + profile.frameProfile.submit - skySceneBefore;
        draw_scene(vp, eye, false, seconds);
        phaseStart = profile.profile_now();
        if (viewmodel) {
            auto detailStart = profile.profile_now();
            size_t floorCount = 0;
            const auto *floor = bh_floor_weapons(core, &floorCount);
            profile.profile_elapsed(profile.frameProfile.floorReport, detailStart);
            if (profile.profiling) profile.frameProfile.floorCount = floorCount;
            detailStart = profile.profile_now();
            for (size_t i = 0; floorWeaponsVisible && floor && i < floorCount; i++)
                viewmodel->draw_floor(floor[i], vp, eye, seconds);
            profile.profile_elapsed(profile.frameProfile.floorDraw, detailStart);
            detailStart = profile.profile_now();
            if (replayActor) viewmodel->draw_actor(*replayActor, vp, eye, seconds);
            if (compareActor) viewmodel->draw_actor(*compareActor, vp, eye, seconds);
            for (const auto &actor : roomActors)
                viewmodel->draw_actor(actor, vp, eye, seconds);
            profile.profile_elapsed(profile.frameProfile.actorDraw, detailStart);
        }
        draw_presentation(vp, eye, seconds);
        profile.profile_elapsed(profile.frameProfile.presentation, phaseStart);
        phaseStart = profile.profile_now();
        if (frameLook)
            frameLook->finish(GLuint(frameTarget), look_frame(vp, eye, aspect), hdr_object(), dt);
        else if (pass)
            pass->finish(GLuint(frameTarget), width, height, dt);
        frameLook = nullptr;
        profile.profile_elapsed(profile.frameProfile.hdrFinish, phaseStart);
        phaseStart = profile.profile_now();
        auto viewmodelStart = profile.profile_now();
        BhSnapshot snapshot{};
        if (state)
            snapshot = *state;
        else
            bh_snapshot(core, &snapshot);
        BhWeaponReport weapon{};
        BhAttackReport attack{};
        bh_weapon_report(core, &weapon);
        bh_attack_report(core, &attack);
        if (viewmodel && viewmodelVisible) {
            if (spectatedActor) {
                BhWeaponReport remote{};
                remote.active = spectatedActor->frame.weapon;
                remote.silencer = spectatedActor->silenced ? 1 : 0;
                snapshot.player.tick = spectatedActor->frame.tick;
                const auto pulses = spectatedAttacks.take();
                const unsigned mode = pulses.empty() ? 0 : pulses.back();
                viewmodel->draw(
                        width,
                        height,
                        snapshot,
                        remote.active,
                        spectatedFlags,
                        !pulses.empty(),
                        mode,
                        seconds,
                        &remote,
                        !pulses.empty() || spectatedFlags != 0
                );
                spectatedFlags = 0;
            } else
                viewmodel->draw(
                        width,
                        height,
                        snapshot,
                        viewmodelWeapon.value_or(weapon.active),
                        viewmodelWeapon ? 0 : weapon.flags | queuedWeaponFlags,
                        viewmodelWeapon ? false : queuedAttack || attack.weapon != 0,
                        viewmodelWeapon ? 0
                        : queuedAttack  ? queuedAttackMode
                                        : attack.mode,
                        seconds,
                        viewmodelWeapon ? nullptr : &weapon
                );
        }
        profile.profile_elapsed(profile.frameProfile.viewmodel, viewmodelStart);
        profile.profile_elapsed(profile.frameProfile.presentation, phaseStart);
        spectatedAttacks.clear();
        spectatedFlags = 0;  // Hidden third-person viewmodels must not replay stale pulses on return to eye mode.
        queuedWeaponFlags = queuedAttackMode = 0;
        queuedAttack = false;
        gl.DepthMask(GL_TRUE);
        gl.Enable(GL_DEPTH_TEST);
        gl.Disable(GL_BLEND);
        gl.Disable(GL_POLYGON_OFFSET_FILL);
        if (graphics.target_needed()) {
            graphicsTarget->finish(GLuint(outputTarget), outputWidth, outputHeight, graphicsView, graphics);
        }
    }

    void screenshot(const std::string &path, int width, int height) {
        if (width <= 0 || height <= 0) throw std::runtime_error("Cannot capture empty framebuffer");
        std::vector<uint8_t> pixels(size_t(width) * height * 3);
        gl.PixelStorei(GL_PACK_ALIGNMENT, 1);
        gl.ReadPixels(0, 0, width, height, GL_RGB, GL_UNSIGNED_BYTE, pixels.data());
        std::ofstream file(path, std::ios::binary);
        if (!file) throw std::runtime_error("Cannot write screenshot: " + path);
        file << "P6\n" << width << ' ' << height << "\n255\n";
        for (int y = height - 1; y >= 0; y--)
            file.write(reinterpret_cast<const char *>(pixels.data() + size_t(y) * width * 3), width * 3);
        if (!file) throw std::runtime_error("Screenshot write failed: " + path);
        std::cout << "Screenshot: " << path << '\n';
    }
};
}  // namespace native
