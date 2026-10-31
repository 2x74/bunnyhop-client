#pragma once

class PresentationPass {
    gfx::Context &context;
    BhContext *&core;
    RenderProfile &profile;

public:
    PresentationPass(gfx::Context &ctx, BhContext *&c, RenderProfile &p) : context(ctx), core(c), profile(p) {}

    ~PresentationPass() { context.destroy(waterConstants); }

    NativeMapEffects mapEffects;
    std::unique_ptr<NativePresentation> presentation;
    gfx::ConstantBinding waterConstants;
    static constexpr double paint_second_ns = 1'000'000'000;
    bool toolsVisible = true, paintHeld = false, paintVisible = true;
    std::string paintHeldCode;
    std::string measureLabel;
    native_render::SurfaceToolBindings toolBindings;
    native_render::Paint paint;
    native_render::Measure measure;

    struct View {
        const native::GraphicsSettings &graphics;
        double lastYaw, lastPitch;
        bool viewmodelVisible;
        const std::optional<native_render::Actor> &replayActor;
        std::span<const native_render::Actor> roomActors;
        int viewportWidth, viewportHeight;
        float pixelDensity;
    };

    native_render::GhostTrails ghostTrails;
    std::array<native_render::GhostPath, 4> ghostPaths;
    native_render::GhostOptions ghostOptions;
    std::unique_ptr<GhostRouteGeometry> ghostRoutes;
    std::array<bool, 4> routeAvailable{true, true, true, true};
    std::array<float, 3> ghostRouteColor{1, .761f, .239f};
    std::array<std::array<float, 3>, 2> trailColors{{{1, .761f, .239f}, {1, .761f, .239f}}};

    struct QueuedShot {
        BhAttackReport report;
        native_render::ShotBasis basis;
        // Another player's shot: its flash is drawn here, not by the viewmodel.
        bool remote = false;
    };

    struct ShotEffect {
        BhAttackReport report;
        native_render::ShotBasis basis;
        double started;
        bool remote = false;
    };

    native_render::EventQueue<QueuedShot, 128> attackEvents;
    std::vector<ShotEffect> shotEffects;

    struct Overlay {
        int entity = -1, model = -1;
        uint32_t kind = 0, flags = 0;
        std::vector<std::array<native_render::Vec3, 3>> triangles;
    };

    std::vector<Overlay> overlays;
    bool overlaysLoaded = false;
    std::vector<BhZone> timerZones;
    BhRunState zoneState{};
    uint32_t activeZoneTrack = 0;
    bool zonesVisible = true, effectsVisible = true, triggersVisible = false, clipsVisible = false;
    native::ZoneEffects zoneEffects;
    native::SemanticPalette semanticPalette = native::semantic_palette("off");
    bool zoneGold = false;

    void load_overlays() {
        if (overlaysLoaded) return;
        overlaysLoaded = true;
        size_t overlayBytes = 0;
        const auto *overlayJson = bh_overlay_json(core, &overlayBytes);
        if (overlayJson && overlayBytes) {
            const auto json = nlohmann::json::parse(overlayJson, overlayJson + overlayBytes);
            for (const auto &raw : json) {
                Overlay o;
                o.kind = raw.value("kind", 0u);
                o.flags = raw.value("flags", 0u);
                if (raw.contains("entity") && !raw["entity"].is_null()) o.entity = raw["entity"];
                if (raw.contains("model") && !raw["model"].is_null()) o.model = raw["model"];
                std::vector<native_render::Plane> planes;
                for (const auto &p : raw.value("planes", nlohmann::json::array()))
                    if (p.size() == 4) planes.push_back({p[0], p[1], p[2], p[3]});
                o.triangles = native_render::convex_triangles(planes);
                if (!o.triangles.empty()) overlays.push_back(std::move(o));
            }
        }
    }

    void draw_presentation(
            const native::Matrix &vp, const float eye[3], double seconds, const View &view, WaterPass &water
    ) {
        auto presentationStart = profile.profile_now();
        presentation->clear();
        const float cy = std::cos(view.lastYaw * native::radians), sy = std::sin(view.lastYaw * native::radians),
                    cp = std::cos(view.lastPitch * native::radians), sp = std::sin(view.lastPitch * native::radians);
        const native_render::Vec3 right = {sy, -cy, 0}, up = {sp * cy, sp * sy, cp};
        zoneEffects.frame(zoneState.status, zoneState.track, seconds, zoneGold);
        if (zonesVisible)
            for (size_t zi = 0; zi < timerZones.size(); ++zi) {
                const auto &z = timerZones[zi];
                const auto base = semanticPalette.zones[z.kind >= 2 ? 4 : z.kind + (z.track ? 2 : 0)];
                auto color = zoneEffects.color(zi, base, seconds);
                const float level = zoneEffects.level(zi);
                const float f = z.mins[2] + .5f,
                            h = std::min(
                                    std::max(1.f, z.maxs[2] - z.mins[2]), std::max(24.f, (z.maxs[2] - z.mins[2]) * .4f)
                            );
                const native_render::Vec3 corners[4] = {
                        {{z.mins[0], z.mins[1], f}},
                        {{z.maxs[0], z.mins[1], f}},
                        {{z.maxs[0], z.maxs[1], f}},
                        {{z.mins[0], z.maxs[1], f}}
                };
                for (int i = 0; i < 4; i++) {
                    const auto &a = corners[i], &b = corners[(i + 1) % 4];
                    presentation->ribbon(a, b, .45f, {base[0], base[1], base[2], .9f}, eye);
                    if (level > 0 && (b[1] - a[1]) * (eye[0] - a[0]) - (b[0] - a[0]) * (eye[1] - a[1]) > 0) {
                        auto hi = a, hb = b;
                        hi[2] += h;
                        hb[2] += h;
                        color[3] = .42f * level;
                        presentation->quad({a, b, hb, hi}, color, 3);
                    }
                }
            }
        for (const auto &event : attackEvents.take()) {
            if (shotEffects.size() == 128) shotEffects.erase(shotEffects.begin());
            shotEffects.push_back({event.report, event.basis, seconds, event.remote});
        }
        shotEffects.erase(
                std::remove_if(
                        shotEffects.begin(),
                        shotEffects.end(),
                        [&](const auto &e) { return seconds - e.started > 3 || seconds < e.started; }
                ),
                shotEffects.end()
        );
        if (effectsVisible)
            for (const auto &e : shotEffects) {
                const float age = float(seconds - e.started);
                const auto &r = e.report;
                if (r.weapon <= 1) continue;
                const auto from = e.basis.muzzle;
                native_render::Vec3 to{};
                for (int k = 0; k < 3; k++)
                    to[k] = r.end[k];
                if (age < .065f) {
                    presentation->ribbon(from, to, .4f, {1, .78f, .35f, (1 - age / .065f) * .65f}, eye);
                    if (!view.viewmodelVisible || e.remote)
                        presentation->billboard(from, 4.5f, {1, .7f, .2f, 1 - age / .065f}, right, up);
                }
                if (r.hit) {
                    native_render::Vec3 impact{};
                    for (int k = 0; k < 3; k++)
                        impact[k] = r.end[k] + r.normal[k] * .2f;
                    presentation->billboard(
                            impact, 2.2f, {.12f, .10f, .08f, std::min(1.f, (3 - age) * 2) * .8f}, right, up
                    );
                    if (age < .25f)
                        for (uint32_t i = 0; i < 4; i++) {
                            auto p = impact;
                            for (int k = 0; k < 3; k++)
                                p[k] += (native_render::particle_random(i, k) * 2 - 1) * age * 35
                                        + r.normal[k] * age * 20;
                            p[2] -= age * age * 80;
                            presentation->billboard(p, .65f, {1, .65f, .2f, 1 - age / .25f}, right, up);
                        }
                }
                if (age < 1.1f) {
                    auto shell = from;
                    shell[0] += e.basis.right[0] * age * 70;
                    shell[1] += e.basis.right[1] * age * 70;
                    shell[2] += age * 30 - age * age * 160;
                    presentation->billboard(shell, .65f, {.75f, .52f, .17f, 1}, right, up, false);
                }
            }
        if (effectsVisible && !view.graphics.potato && ghostOptions.trail) {
            if (view.replayActor) draw_ghost_trail(*view.replayActor, eye);
            for (const auto &actor : view.roomActors) {
                if (actor.ghost_slot >= 0) draw_ghost_trail(actor, eye);
            }
        }
        draw_ghost_route(vp, view);
        if (paintVisible) paint.draw(core, *presentation);
        if (toolsVisible) measure.draw(core, *presentation, eye);
        // Overlay kinds follow crates/core/src/game/overlay.rs: 0-3 are triggers
        // (!showtriggers), 4 player clips and 5 invisible walls (!showclips).
        if (triggersVisible || clipsVisible) {
            size_t count = 0;
            const auto *states = bh_overlay_states(core, &count);
            const auto &colors = semanticPalette.triggers;
            for (const auto &o : overlays) {
                if (!(o.kind >= 4 ? clipsVisible : triggersVisible)) continue;
                if (o.entity >= 0) {
                    if (!states || size_t(o.entity) >= count || !(states[o.entity] & 1)) continue;
                    if ((o.flags & 1) && (states[o.entity] & 2)) continue;
                }
                BhTransform t{};
                t.visible = 1;
                if (o.model > 0) bh_model_transform(core, uint32_t(o.model), &t);
                const auto model = native::model_matrix(t);
                const auto &c = colors[std::min(o.kind, 5u)];
                for (const auto &triangle : o.triangles) {
                    const auto a = native_render::transform_point(model, triangle[0]),
                               b = native_render::transform_point(model, triangle[1]),
                               c0 = native_render::transform_point(model, triangle[2]);
                    presentation->quad({a, b, c0, c0}, {c[0], c[1], c[2], .12f});
                }
            }
        }
        draw_map_effects(eye, seconds, right, up, view.graphics.potato);
        profile.profile_elapsed(profile.frameProfile.presentationBuild, presentationStart);
        presentationStart = profile.profile_now();
        context.bind_program(presentation->shader_program());
        water.water_uniforms(waterConstants, eye, vp, view.viewportWidth, view.viewportHeight);
        profile.profile_elapsed(profile.frameProfile.presentationWaterUniforms, presentationStart);
        presentationStart = profile.profile_now();
        presentation->draw(vp, eye);
        profile.profile_elapsed(profile.frameProfile.presentationSubmit, presentationStart);
    }

    void draw_ghost_trail(const native_render::Actor &actor, const float eye[3]) {
        if (actor.ghost_slot < 0 || actor.ghost_slot >= int(ghostPaths.size())) return;
        const auto &path = ghostPaths[size_t(actor.ghost_slot)];
        if (!path.enabled || !ghostOptions.visible(path.source)) return;
        const auto points = ghostTrails.recorded(path, actor.frame.tick);
        auto colors = trailColors;
        if (path.source != native_render::GhostSource::pb) {
            colors.fill(native_render::ghost_source_color(path.source));
        }
        for (size_t i = 1; i < points.size(); ++i) {
            const float progress = float(i) / float(points.size() - 1);
            const auto &point = points[i];
            const float distance = std::hypot(std::hypot(eye[0] - point[0], eye[1] - point[1]), eye[2] - point[2]);
            const auto color = native_render::trail_color(colors, progress, actor.opacity, distance);
            presentation->ribbon(points[i - 1], point, 2.5f * (.15f + .85f * progress), color, eye);
        }
    }

    void draw_ghost_route(const native::Matrix &projection, const View &view) {
        if (!ghostOptions.route || !ghostRoutes) return;
        int selected = -1;
        for (size_t slot = 0; slot < ghostPaths.size(); ++slot) {
            const auto &path = ghostPaths[slot];
            if (!routeAvailable[slot] || !path.enabled || path.frames.empty() || !ghostOptions.visible(path.source))
                continue;
            if (ghostOptions.route_source != native_render::GhostSource::none
                && path.source != ghostOptions.route_source)
                continue;
            if (selected < 0
                || native_render::route_priority(path.source)
                           < native_render::route_priority(ghostPaths[size_t(selected)].source))
                selected = int(slot);
        }
        if (selected < 0) return;
        const auto &path = ghostPaths[size_t(selected)];
        const auto color = path.source == native_render::GhostSource::pb
                                   ? ghostRouteColor
                                   : native_render::ghost_source_color(path.source);
        ghostRoutes->draw(
                unsigned(selected), projection, color, view.viewportWidth, view.viewportHeight, view.pixelDensity
        );
    }

    void draw_map_effects(
            const float eye[3],
            double seconds,
            const native_render::Vec3 &right,
            const native_render::Vec3 &up,
            bool potato
    ) {
        mapEffects.draw(*presentation, core, eye, seconds, right, up, effectsVisible && !potato);
    }

    nlohmann::json surface_tools_state() {
        return {{"paintMarks", paint.count()},
                {"measurePoints", measure.count()},
                {"measurement", measure.count() == 2 ? nlohmann::json(measure.text(core)) : nlohmann::json(nullptr)}};
    }

    const char *
    surface_tool(std::string_view action, const BhState &state, const native::Input &input, bool held = false) {
        if (action == "clearPaint") {
            paint.clear();
            return "Paint cleared.";
        }
        if (action == "clearMeasure") {
            measure.clear();
            return "Measurement cleared.";
        }
        const bool painting = action == "paint" || action == "paintOnce";
        if (painting && !paint.request(double(SDL_GetTicksNS()) / paint_second_ns, held)) return "Paint mark skipped.";
        const native_render::Vec3 eye = {state.position[0], state.position[1], state.position[2] + state.view_offset_z};
        const auto hit = native_render::pick_surface(core, eye, input.yaw(), input.pitch);
        if (!hit) return "No surface in range. Aim at a nearby wall or floor.";
        if (action == "measurePoint") {
            measure.pick(core, *hit);
            return measure.text(core);
        }
        return paint.stamp(core, *hit, held) ? "Paint mark placed." : "Paint mark skipped.";
    }

    const char *tool_key(
            std::string_view code,
            bool down,
            bool repeat,
            const BhState &state,
            const native::Input &input,
            bool can_paint
    ) {
        if (!down && code == paintHeldCode) {
            paintHeld = false;
            paintHeldCode.clear();
        }
        const int action = toolBindings.match(code);
        if (action < 0) return nullptr;
        if (action < 2 && !can_paint) {
            paintHeld = false;
            return nullptr;
        }
        if (action == 0 && down && !repeat) {
            paintHeld = true;
            paintHeldCode = code;
        }
        if (!down || repeat) return nullptr;
        return surface_tool(native_render::SurfaceToolBindings::actions[size_t(action)], state, input);
    }

    void surface_tools_frame(const BhState &state, const native::Input &input, bool active, bool spectating) {
        paintVisible = !spectating;
        if (!active) {
            paintHeld = false;
            paintHeldCode.clear();
            return;
        }
        const double seconds = double(SDL_GetTicksNS()) / paint_second_ns;
        if (paintHeld && paint.ready(seconds, true)) {
            surface_tool("paint", state, input, true);
        }
    }

    std::string
    tool_message(const nlohmann::json &message, const BhState &state, const native::Input &input, bool can_paint) {
        const auto type = message.at("type").get<std::string>();
        const auto action = message.at("action").get<std::string>();
        if (type == "paint" && action != "clear" && !can_paint)
            return "Paint is unavailable while spectating or watching a replay.";
        if (action != "clear" && action != (type == "paint" ? "stamp" : "point")) {
            throw std::runtime_error("Unknown surface tool action");
        }
        const auto bound = type == "paint" ? (action == "clear" ? "clearPaint" : "paintOnce")
                                           : (action == "clear" ? "clearMeasure" : "measurePoint");
        return surface_tool(bound, state, input, message.value("held", false));
    }

    template <class Hud>
    void draw_measure_label(
            Hud &hud,
            const native::Matrix &vp,
            const float eye[3],
            int width,
            int height,
            const native::GraphicsSettings &graphics
    ) {
        if (!toolsVisible || measure.count() != 2) return;
        const auto points = measure.positions(core);
        if (!points) return;
        native_render::Vec3 midpoint{};
        for (int axis = 0; axis < 3; ++axis)
            midpoint[axis] = ((*points)[0][axis] + (*points)[1][axis]) * .5f;
        float fraction = 0;
        if (!bh_trace_camera(core, eye, midpoint.data(), 0, &fraction) || fraction < .995f) return;
        float clip[4]{};
        for (int row = 0; row < 4; ++row) {
            clip[row] = vp[row] * midpoint[0] + vp[4 + row] * midpoint[1] + vp[8 + row] * midpoint[2] + vp[12 + row];
        }
        if (clip[3] <= 0 || std::abs(clip[0]) > clip[3] || std::abs(clip[1]) > clip[3]) return;
        measureLabel.assign(measure.text(core));
        hud.overlay_begin(width, height, 100);
        const auto view = native::graphics_view(graphics, width, height);
        hud.overlay_text(
                view.x + (clip[0] / clip[3] * .5f + .5f) * view.output_width,
                height - view.y - (clip[1] / clip[3] * .5f + .5f) * view.output_height,
                measureLabel,
                13,
                {1, 1, 1, 1},
                true
        );
        hud.overlay_end(width, height);
    }

    const native_render::GhostPath &ghost_path(unsigned slot) const { return ghostPaths.at(slot); }

    void set_ghost_path(unsigned slot, native_render::GhostPath path) {
        if (slot >= ghostPaths.size()) throw std::runtime_error("Invalid ghost slot");
        path.build_route();
        path.revision = native_render::next_ghost_path_revision();
        ghostPaths[slot] = std::move(path);
        if (ghostRoutes) ghostRoutes->upload(slot, ghostPaths[slot], ghostOptions.route_path);
    }

    void route_context(uint32_t track, const std::string &style, bool visible) {
        for (size_t slot = 0; slot < ghostPaths.size(); ++slot) {
            const auto &path = ghostPaths[slot];
            routeAvailable[slot] = visible && path.track == track
                                   && (path.source == native_render::GhostSource::custom || path.style == style);
        }
    }

    void clear_ghosts() {
        for (auto &path : ghostPaths)
            path = {};
    }

    void register_ghost(
            unsigned slot,
            uint32_t handle,
            const nlohmann::json &info,
            native_render::GhostSource source = native_render::GhostSource::custom
    ) {
        if (slot >= ghostPaths.size()) throw std::runtime_error("Invalid ghost slot");
        native_render::GhostPath path;
        path.load(core, handle, info, source);
        ghostPaths[slot] = std::move(path);
        if (ghostRoutes) ghostRoutes->upload(slot, ghostPaths[slot], ghostOptions.route_path);
    }

    void ghost_enabled(unsigned slot, bool enabled) {
        if (slot < ghostPaths.size()) ghostPaths[slot].enabled = enabled;
    }

    bool ghost_visible(unsigned slot) const {
        return slot < ghostPaths.size() && ghostPaths[slot].enabled && ghostOptions.visible(ghostPaths[slot].source);
    }

    const std::string &ghost_name(unsigned slot) const { return ghostPaths.at(slot).name; }

    const std::string &ghost_loadout(unsigned slot) const { return ghostPaths.at(slot).loadout; }

    void decorate_ghost(native_render::Actor &actor, unsigned slot, const std::string &packedLoadout) const {
        if (slot >= ghostPaths.size()) return;
        actor.ghost_slot = int(slot);
        actor.source = ghostPaths[slot].source;
        actor.near_fade = ghostOptions.near_fade;
        // As on the website: your PB ghost follows your loadout unless its replay carries one; other ghosts hold the
        // default carrot.
        if (actor.source == native_render::GhostSource::pb && actor.loadout.empty()) actor.loadout = packedLoadout;
        actor.tint = actor.source == native_render::GhostSource::pb ? ghostRouteColor
                                                                    : native_render::ghost_source_color(actor.source);
    }

    void set_zones(const std::vector<BhZone> &zones) {
        timerZones = zones;
        zoneEffects.clear();
        for (const auto &z : zones)
            zoneEffects.add(z.kind, z.track);
        zoneGold = false;
    }

    void set_zone_state(uint32_t track, const BhRunState &state, bool gold = false) {
        activeZoneTrack = track;
        zoneState = state;
        zoneGold = gold;
    }

    void set_color_blind(const std::string &mode) { semanticPalette = native::semantic_palette(mode); }

    void set_zones_visible(bool value) { zonesVisible = value; }

    void set_triggers_visible(bool value) {
        if (value) load_overlays();
        triggersVisible = value;
    }

    void set_clips_visible(bool value) {
        if (value) load_overlays();
        clipsVisible = value;
    }

    void set_effects_visible(bool value) { effectsVisible = value; }

    void graphics_settings(const nlohmann::json &settings) {
        const bool previousRoute = ghostOptions.route, previousPath = ghostOptions.route_path;
        ghostOptions.read(settings);
        if (ghostOptions.route) {
            if (!ghostRoutes) ghostRoutes = std::make_unique<GhostRouteGeometry>(context);
            if (!previousRoute || previousPath != ghostOptions.route_path) {
                for (unsigned slot = 0; slot < ghostPaths.size(); ++slot) {
                    ghostRoutes->upload(slot, ghostPaths[slot], ghostOptions.route_path);
                }
            }
        }
        paint.settings(settings);
        toolBindings.read(settings);
        toolsVisible = settings.value("hud", true);
    }
};
