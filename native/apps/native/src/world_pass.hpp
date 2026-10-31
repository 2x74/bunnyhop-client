#pragma once

class WorldPass {
    gfx::Context &context;
    BhContext *&core;
    RenderResources &resources;
    RenderProfile &profile;

public:
    WorldPass(gfx::Context &ctx, BhContext *&c, RenderResources &r, RenderProfile &p)
        : context(ctx)
        , core(c)
        , resources(r)
        , profile(p) {}

    gfx::Program program;
    gfx::Texture lightmap;
    RenderGeometry worldMesh, propMesh;
    std::vector<BhGroup> groups;
    std::vector<BhPropGroup> propGroups;
    std::vector<gfx::Texture> normals;
    std::array<float, 3> sunDirection{.35f, .45f, .82f};
    bool hasSun = false;
    native::MapSun mapSun;
    std::vector<BhMaterial> materials;
    std::vector<BhMaterialExtra> extras;
    BhLightmapInfo lightmapInfo{1, 0};
    std::unordered_map<uint64_t, std::array<float, 3>> centers;
    std::unordered_map<uint64_t, native_render::Bounds> groupBounds;

    struct View {
        const native::GraphicsSettings &graphics;
        const BhSkyInfo &skyInfo;
        bool hasSky, flashlightEnabled;
        double lastYaw, lastPitch;
        float clipHeight;
        int viewportWidth, viewportHeight;
    };

    // BhMaterial flags (bunnyhop_core's MAT_TRANSLUCENT, MAT_ALPHATEST).
    static constexpr uint32_t material_translucent = 1, material_alpha_test = 2;

    std::string normal_path(std::string name, int depth = 0) {
        if (depth > 6) return {};
        std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return char(std::tolower(c)); });
        std::replace(name.begin(), name.end(), '\\', '/');
        if (name.rfind("materials/", 0) == 0) name.erase(0, 10);
        if (name.ends_with(".vmt")) name.resize(name.size() - 4);
        const std::string path = "materials/" + name + ".vmt";
        size_t count = 0;
        const auto *raw = bh_content_read(core, path.c_str(), &count);
        if (!raw || !count) return {};
        std::string text(reinterpret_cast<const char *>(raw), count);
        text = std::regex_replace(text, std::regex(R"(//[^\r\n]*)"), "");
        if (std::regex_search(text, std::regex(R"("?\$ssbump"?\s+"?1\b)", std::regex::icase))
            || std::regex_search(text, std::regex(R"("?\$bumptransform"?\s+)", std::regex::icase)))
            return {};
        std::smatch match;
        if (std::regex_search(text, match, std::regex(R"rx("?\$bumpmap"?\s+"([^"\r\n]+)")rx", std::regex::icase))) {
            std::string bump = match[1];
            std::transform(bump.begin(), bump.end(), bump.begin(), [](unsigned char c) {
                return char(std::tolower(c));
            });
            std::replace(bump.begin(), bump.end(), '\\', '/');
            if (bump.rfind("materials/", 0) == 0) bump.erase(0, 10);
            if (bump.ends_with(".vtf")) bump.resize(bump.size() - 4);
            return "materials/" + bump + ".vtf";
        }
        if (std::regex_search(text, match, std::regex(R"rx("?include"?\s+"([^"\r\n]+)")rx", std::regex::icase)))
            return normal_path(match[1], depth + 1);
        return {};
    }

    ResourceLoading load_normals() {
        size_t count = 0;
        const char *raw = bh_entities_json(core, &count);
        if (raw && count) {
            const auto entities = nlohmann::json::parse(raw, raw + count);
            for (const auto &e : entities) {
                if (e.value("classname", "") != "light_environment") continue;
                float pitch = 0, yaw = 0, roll = 0;
                std::stringstream angles(e.value("angles", "0 0 0"));
                angles >> pitch >> yaw >> roll;
                if (e.contains("pitch")) try {
                        pitch = std::stof(e.at("pitch").get<std::string>());
                    } catch (...) {
                        break;
                    }
                if (std::isfinite(pitch) && std::isfinite(yaw)) {
                    pitch *= native::radians;
                    yaw *= native::radians;
                    sunDirection = {
                            -std::cos(pitch) * std::cos(yaw), -std::cos(pitch) * std::sin(yaw), -std::sin(pitch)
                    };
                    hasSun = true;
                }
                break;
            }
            mapSun = native::read_map_sun(entities, sunDirection, hasSun);
        }
        normals.resize(materials.size());
        if (!hasSun) co_return;
        raw = bh_material_names_json(core, &count);
        if (!raw || !count) co_return;
        const auto names = nlohmann::json::parse(raw, raw + count);
        std::unordered_map<std::string, gfx::Texture> cached;
        for (size_t i = 0; i < normals.size() && i < names.size(); i++) {
            co_yield "normal texture";
            const auto path = normal_path(names[i]);
            if (path.empty()) continue;
            if (cached.count(path)) {
                normals[i] = cached.at(path);
                continue;
            }
            size_t bytes = 0;
            const auto *vtf = bh_content_read(core, path.c_str(), &bytes);
            if (!vtf || bytes < 64 || vtf[0] != 'V' || vtf[1] != 'T' || vtf[2] != 'F' || vtf[3] != 0) continue;
            const uint32_t f = uint32_t(vtf[52]) | (uint32_t(vtf[53]) << 8) | (uint32_t(vtf[54]) << 16)
                               | (uint32_t(vtf[55]) << 24);
            if (f != 0 && f != 1 && f != 2 && f != 3 && f != 11 && f != 12 && f != 13 && f != 14 && f != 15 && f != 16
                && f != 20)
                continue;
            BhImage image{};
            if (bh_texture_path(core, path.c_str(), &image)) {
                normals[i] = resources.upload(image, true, false);
                cached.emplace(path, normals[i]);
            }
        }
        std::cout << "Native embedded normal textures: " << cached.size() << "\n";
    }

    bool transparent(const BhMaterial &m) const {
        return (m.flags & (1 | 8)) || m.kind == 2 || m.kind == 3 || m.alpha < 1;
    }

    struct MaterialValues {
        native::Matrix model{};
        uint32_t hasNormal = 0;
        uint32_t hasSecondary = 0;
        uint32_t hasDetail = 0;
        float detailScale = 0;
        float detailBlend = 0;
        std::array<float, 3> tint{};
        float opacity = 0;
        float cutoff = 0;
        uint32_t unlit = 0;
        uint32_t props = 0;
        int32_t kind = 0;
        uint32_t aboveWater = 0;
        uint32_t additive = 0;
        std::array<float, 3> flatColor{};
        uint32_t captureReady = 0;
        float waterFogEnd = 0;
    } materialValues;

    struct SceneValues {
        native::Matrix viewProjection{};
        float clipHeight = gfx::no_clip_height;
        float timeSeconds = 0;
        uint32_t reflectionReady = 0;
        float reflectionHeight = 0;
        uint32_t fullbright = 0;
        uint32_t potato = 0;
        uint32_t skyPass = 0;
        uint32_t flashlight = 0;
        std::array<float, 3> flashDirection{};
        std::array<float, 3> skyFogColor{};
        std::array<float, 3> skyFogRange{};
        std::array<float, 2> cameraNearFar{native::camera_near_plane, native::camera_far_plane};
        float lightmapScale = 1;
        std::array<float, 3> sunDirection{};
    } sceneValues;

    struct SunValues {
        uint32_t sunActive = 0;
        uint32_t sunShadowActive = 0;
        float sunSkyFill = 0;
        float sunBakedScale = 1;
        float sunDirectStrength = 0;
        float sunShadowStrength = 0;
        std::array<float, 3> sunLightDirection{};
        std::array<float, 3> sunLightColor{};
        std::array<float, 3> sunAmbientColor{};
        native::Matrix sunShadowMatrix{};
        float sunShadowTexel = 0;
        float sunShadowRadius = 0;
        float sunShadowBias = 0;
    } sunValues;

    std::array<gfx::ConstantBinding, 4> materialConstants;
    gfx::ConstantBinding sceneConstants, sunConstants, waterConstants;
    std::array<gfx::Pipeline, 32> pipelines;
    unsigned activePipeline = ~0u;
    std::array<gfx::Pipeline, 2> endPipelines;

    ~WorldPass() {
        for (auto &binding : materialConstants)
            context.destroy(binding);
        context.destroy(sceneConstants);
        context.destroy(sunConstants);
        context.destroy(waterConstants);
        for (auto &pipeline : pipelines)
            context.destroy(pipeline);
        for (auto &pipeline : endPipelines)
            context.destroy(pipeline);
        context.destroy(program);
    }

    void prepare_material_constants() {
        static constexpr gfx::ConstantField fields[] = {
                {"model", offsetof(MaterialValues, model), 64, gfx::ConstantType::matrix4},
                {"hasNormal", offsetof(MaterialValues, hasNormal), 4, gfx::ConstantType::bool32},
                {"hasSecondary", offsetof(MaterialValues, hasSecondary), 4, gfx::ConstantType::bool32},
                {"hasDetail", offsetof(MaterialValues, hasDetail), 4, gfx::ConstantType::bool32},
                {"detailScale", offsetof(MaterialValues, detailScale), 4, gfx::ConstantType::float1},
                {"detailBlend", offsetof(MaterialValues, detailBlend), 4, gfx::ConstantType::float1},
                {"tint", offsetof(MaterialValues, tint), 12, gfx::ConstantType::float3},
                {"opacity", offsetof(MaterialValues, opacity), 4, gfx::ConstantType::float1},
                {"cutoff", offsetof(MaterialValues, cutoff), 4, gfx::ConstantType::float1},
                {"unlit", offsetof(MaterialValues, unlit), 4, gfx::ConstantType::bool32},
                {"props", offsetof(MaterialValues, props), 4, gfx::ConstantType::bool32},
                {"kind", offsetof(MaterialValues, kind), 4, gfx::ConstantType::int1},
                {"aboveWater", offsetof(MaterialValues, aboveWater), 4, gfx::ConstantType::bool32},
                {"additive", offsetof(MaterialValues, additive), 4, gfx::ConstantType::bool32},
                {"flatColor", offsetof(MaterialValues, flatColor), 12, gfx::ConstantType::float3},
                {"captureReady", offsetof(MaterialValues, captureReady), 4, gfx::ConstantType::bool32},
                {"waterFogEnd", offsetof(MaterialValues, waterFogEnd), 4, gfx::ConstantType::float1},
        };
        for (unsigned variant = 0; variant < materialConstants.size(); ++variant) {
            std::vector<gfx::ConstantField> selected(fields, fields + 14);
            if (variant & 1) selected.push_back(fields[14]);
            if (variant & 2) selected.insert(selected.end(), fields + 15, std::end(fields));
            materialConstants[variant] = context.create_constants(program, {selected, sizeof(MaterialValues)});
        }
    }

    void prepare_scene_constants() {
        static constexpr gfx::ConstantField fields[] = {
                {"viewProjection", offsetof(SceneValues, viewProjection), 64, gfx::ConstantType::matrix4},
                {"clipHeight", offsetof(SceneValues, clipHeight), 4, gfx::ConstantType::float1},
                {"timeSeconds", offsetof(SceneValues, timeSeconds), 4, gfx::ConstantType::float1},
                {"reflectionReady", offsetof(SceneValues, reflectionReady), 4, gfx::ConstantType::bool32},
                {"reflectionHeight", offsetof(SceneValues, reflectionHeight), 4, gfx::ConstantType::float1},
                {"fullbright", offsetof(SceneValues, fullbright), 4, gfx::ConstantType::bool32},
                {"potato", offsetof(SceneValues, potato), 4, gfx::ConstantType::bool32},
                {"skyPass", offsetof(SceneValues, skyPass), 4, gfx::ConstantType::bool32},
                {"flashlight", offsetof(SceneValues, flashlight), 4, gfx::ConstantType::bool32},
                {"flashDirection", offsetof(SceneValues, flashDirection), 12, gfx::ConstantType::float3},
                {"skyFogColor", offsetof(SceneValues, skyFogColor), 12, gfx::ConstantType::float3},
                {"skyFogRange", offsetof(SceneValues, skyFogRange), 12, gfx::ConstantType::float3},
                {"cameraNearFar", offsetof(SceneValues, cameraNearFar), 8, gfx::ConstantType::float2},
                {"lightmapScale", offsetof(SceneValues, lightmapScale), 4, gfx::ConstantType::float1},
                {"sunDirection", offsetof(SceneValues, sunDirection), 12, gfx::ConstantType::float3},
        };
        sceneConstants = context.create_constants(program, {fields, sizeof(SceneValues)});
    }

    void prepare_sun_constants() {
        static constexpr gfx::ConstantField fields[] = {
                {"sunActive", offsetof(SunValues, sunActive), 4, gfx::ConstantType::bool32},
                {"sunShadowActive", offsetof(SunValues, sunShadowActive), 4, gfx::ConstantType::bool32},
                {"sunSkyFill", offsetof(SunValues, sunSkyFill), 4, gfx::ConstantType::float1},
                {"sunBakedScale", offsetof(SunValues, sunBakedScale), 4, gfx::ConstantType::float1},
                {"sunDirectStrength", offsetof(SunValues, sunDirectStrength), 4, gfx::ConstantType::float1},
                {"sunShadowStrength", offsetof(SunValues, sunShadowStrength), 4, gfx::ConstantType::float1},
                {"sunLightDirection", offsetof(SunValues, sunLightDirection), 12, gfx::ConstantType::float3},
                {"sunLightColor", offsetof(SunValues, sunLightColor), 12, gfx::ConstantType::float3},
                {"sunAmbientColor", offsetof(SunValues, sunAmbientColor), 12, gfx::ConstantType::float3},
                {"sunShadowMatrix", offsetof(SunValues, sunShadowMatrix), 64, gfx::ConstantType::matrix4},
                {"sunShadowTexel", offsetof(SunValues, sunShadowTexel), 4, gfx::ConstantType::float1},
                {"sunShadowRadius", offsetof(SunValues, sunShadowRadius), 4, gfx::ConstantType::float1},
                {"sunShadowBias", offsetof(SunValues, sunShadowBias), 4, gfx::ConstantType::float1},
        };
        sunConstants = context.create_constants(program, {fields, sizeof(SunValues)});
    }

    void upload_sun() {
        context.bind_program(program);
        context.constants(sunConstants, &sunValues);
    }

    void prepare_pipelines() {
        for (unsigned variant = 0; variant < pipelines.size(); ++variant) {
            gfx::PipelineState state;
            state.raster.offset = variant & 1;
            state.raster.slope_bias = -1;
            state.raster.constant_bias = -4;
            state.raster.cull = variant & 2 ? gfx::Cull::none : gfx::Cull::back;
            state.blend.destination = variant & 4 ? gfx::BlendFactor::one : gfx::BlendFactor::inverse_source_alpha;
            state.blend.enabled = variant & 8;
            state.depth.write = !(variant & 8);
            state.raster.winding = variant & 16 ? gfx::Winding::clockwise : gfx::Winding::counter_clockwise;
            pipelines[variant] = context.create_pipeline(state);
        }
        for (unsigned mirror = 0; mirror < endPipelines.size(); ++mirror) {
            gfx::PipelineState state;
            state.raster.winding = mirror ? gfx::Winding::clockwise : gfx::Winding::counter_clockwise;
            endPipelines[mirror] = context.create_pipeline(state);
        }
    }

    void bind_material(
            uint32_t index,
            bool prop,
            bool translucent,
            bool mirrored,
            const native::GraphicsSettings &graphics,
            const WaterPass &water
    ) {
        const BhMaterial fallback = {-1, 1, 0, 1, .5f, {1, 1, 1}};
        const auto &m = index < materials.size() ? materials[index] : fallback;
        if (graphics.potato) {
            const auto found = resources.textureAverages.find(m.texture);
            const std::array<float, 3> fallbackColor = {.5f, .5f, .5f};
            materialValues.flatColor = found == resources.textureAverages.end() ? fallbackColor : found->second;
        }
        const BhMaterialExtra empty = {-1, -1, 4, 1, 0, 400, 1};
        const auto &e = index < extras.size() ? extras[index] : empty;
        resources.bind(
                0, m.texture < 0 ? (m.kind == 1 ? resources.checker : resources.white) : resources.texture(m.texture)
        );
        resources.bind(2, resources.texture(e.texture2));
        resources.bind(3, resources.texture(e.detail, true));
        resources.bind(7, index < normals.size() && normals[index] ? normals[index] : resources.white);
        const bool hasNormal = graphics.material_response && index < normals.size() && normals[index];
        materialValues.hasNormal = hasNormal;
        materialValues.hasSecondary = e.texture2 >= 0;
        materialValues.hasDetail = e.detail >= 0 && !graphics.potato;
        materialValues.detailScale = e.detail_scale;
        materialValues.detailBlend = e.detail_blend;
        std::copy_n(m.color, 3, materialValues.tint.begin());
        materialValues.opacity = m.alpha;
        materialValues.cutoff = (m.flags & 2) ? m.alpha_ref : 0;
        materialValues.unlit = (m.flags & 16) != 0 || (!prop && lightmap == resources.white);
        materialValues.props = prop;
        materialValues.kind = m.kind;
        materialValues.aboveWater = e.above_water;
        if (m.kind == 2) {
            materialValues.captureReady = water.sceneCaptured && water.waterPlanner.ready(index);
            materialValues.waterFogEnd = std::max(1.f, e.fog_end);
        }
        materialValues.additive = (m.flags & 8) != 0;
        const bool doubleSided =
                m.kind == 2 ? native_render::water_face_double_sided(water.waterBeneathFaces, e.above_water)
                            : (m.flags & 4) != 0;
        const unsigned variant = unsigned(m.kind == 2) | (unsigned(doubleSided) << 1)
                                 | (unsigned((m.flags & 8) != 0) << 2) | (unsigned(translucent) << 3)
                                 | (unsigned(mirrored) << 4);
        if (variant != activePipeline) {
            context.pipeline(pipelines[variant]);
            activePipeline = variant;
        }
        const unsigned constants = unsigned(graphics.potato) | (unsigned(m.kind == 2) << 1);
        context.constants(materialConstants[constants], &materialValues);
    }

    struct SceneTransform {
        BhTransform value{};
        uint64_t scene = 0;
    };

    // Reused by every scene pass (3D sky, reflection, world) so drawing doesn't allocate each frame.
    native_render::SceneDrawList sceneDrawList;
    std::unordered_map<uint64_t, SceneTransform> sceneTransforms;
    uint64_t sceneNumber = 0;

    const BhTransform &scene_transform(bool prop, int32_t entity, uint32_t model) {
        const uint64_t key = (uint64_t(prop) << 63) | uint32_t(prop ? entity : model);
        auto &cached = sceneTransforms[key];
        if (cached.scene != sceneNumber) {
            cached.value = {};
            cached.value.visible = 1;
            if (prop && entity >= 0)
                bh_prop_transform(core, entity, &cached.value);
            else if (!prop && model)
                bh_model_transform(core, model, &cached.value);
            cached.scene = sceneNumber;
        }
        return cached.value;
    }

    void bind_scene_textures(WaterPass &water) {
        resources.bind(1, lightmap, false);
        context.bind_texture(6, water.planesTexture, water.planesSampler);
        if (water.reflectionDrawn)
            water.waterReflection->bind(8);
        else
            resources.bind(8, resources.white);
        if (water.sceneCaptured) water.bind_refraction();
    }

    void prepare_scene_values(
            const native::Matrix &vp,
            const float eye[3],
            bool sky,
            double time,
            bool reflection,
            const View &view,
            WaterPass &water
    ) {
        const auto &skyInfo = view.skyInfo;
        context.bind_program(program);
        sceneValues.viewProjection = vp;
        sceneValues.clipHeight = reflection ? view.clipHeight : gfx::no_clip_height;
        water.water_uniforms(waterConstants, eye, vp, view.viewportWidth, view.viewportHeight);
        sceneValues.timeSeconds = time;
        sceneValues.reflectionReady = !sky && !reflection && water.reflectionDrawn;
        sceneValues.reflectionHeight = water.waterPlan.reflection_height.value_or(0);
        if (water.reflectionDrawn)
            water.waterReflection->bind(8);
        else
            resources.bind(8, resources.white);
        sceneValues.fullbright = view.graphics.fullbright;
        sceneValues.potato = view.graphics.potato;
        sceneValues.skyPass = sky && view.hasSky && skyInfo.fog_enable;
        sceneValues.flashlight = view.flashlightEnabled && !sky;
        sceneValues.flashDirection = {
                float(std::cos(view.lastPitch * native::radians) * std::cos(view.lastYaw * native::radians)),
                float(std::cos(view.lastPitch * native::radians) * std::sin(view.lastYaw * native::radians)),
                float(-std::sin(view.lastPitch * native::radians))
        };
        float fog[3] = {skyInfo.fog_color[0] / 255.f, skyInfo.fog_color[1] / 255.f, skyInfo.fog_color[2] / 255.f};
        if (skyInfo.fog_blend) {
            const float dx = std::cos(view.lastPitch * native::radians) * std::cos(view.lastYaw * native::radians),
                        dy = std::cos(view.lastPitch * native::radians) * std::sin(view.lastYaw * native::radians),
                        dz = -std::sin(view.lastPitch * native::radians);
            const float len = std::hypot(std::hypot(skyInfo.fog_dir[0], skyInfo.fog_dir[1]), skyInfo.fog_dir[2]);
            const float t = len > 0 ? std::clamp(
                                              .5f
                                                      + .5f
                                                                * (dx * skyInfo.fog_dir[0] + dy * skyInfo.fog_dir[1]
                                                                   + dz * skyInfo.fog_dir[2])
                                                                / len,
                                              0.f,
                                              1.f
                                      )
                                    : 0;
            for (int k = 0; k < 3; k++)
                fog[k] = (skyInfo.fog_color[k] * t + skyInfo.fog_color2[k] * (1 - t)) / 255.f;
        }
        std::copy_n(fog, 3, sceneValues.skyFogColor.begin());
        sceneValues.skyFogRange = {
                skyInfo.fog_start / std::max(skyInfo.scale, .001f),
                skyInfo.fog_end / std::max(skyInfo.scale, .001f),
                skyInfo.fog_max_density
        };
        sceneValues.lightmapScale = lightmapInfo.scale;
        context.constants(sceneConstants, &sceneValues);
        bind_scene_textures(water);
    }

    void
    collect_scene_draws(const native::Matrix &vp, const float eye[3], bool sky, bool reflection, const View &view) {
        auto phaseStart = profile.profile_now();
        ++sceneNumber;
        sceneDrawList.begin(groups.size() + propGroups.size());
        auto &draws = sceneDrawList.draws;
        for (const auto &g : groups)
            if (bool(g.sky3d) == sky) sceneDrawList.add({g.material, g.first_index, g.index_count, false, -1, g.model});
        for (const auto &g : propGroups)
            if (bool(g.sky3d) == sky) sceneDrawList.add({g.material, g.first_index, g.index_count, true, g.entity, 0});
        if (profile.profiling) profile.frameProfile.groups += draws.size();
        // Cull transformed bounds before submission; sort translucency from current, transformed centres.
        draws.erase(
                std::remove_if(
                        draws.begin(),
                        draws.end(),
                        [&](native_render::SceneDraw &d) {
                            const auto &transform = scene_transform(d.prop, d.entity, d.model);
                            if (!transform.visible) return true;
                            const auto model = native::model_matrix(transform);
                            const uint64_t key = (uint64_t(d.prop) << 63) | d.first;
                            const auto at = groupBounds.find(key);
                            if (at != groupBounds.end()) {
                                const auto bounds = native_render::transformed_bounds(at->second, model);
                                // The reflection clips away everything below its plane.
                                if (reflection && bounds.hi[2] < view.clipHeight) return true;
                                std::array<float, 4> rect;
                                if (!native_render::screen_rect(bounds, vp, rect)) return true;
                                for (int k = 0; k < 3; k++) {
                                    const float n = (bounds.lo[k] + bounds.hi[k]) * .5f - eye[k];
                                    d.distance += n * n;
                                }
                            }
                            return false;
                        }
                ),
                draws.end()
        );
        if (profile.profiling) profile.frameProfile.survivors += draws.size();
        profile.profile_elapsed(profile.frameProfile.buildCull, phaseStart);
    }

    void submit_draws(bool translucent, bool reflection, const View &view, const WaterPass &water) {
        for (const auto &d : sceneDrawList.draws) {
            const auto &m = d.material < materials.size() ? materials[d.material] : materials.front();
            if (transparent(m) != translucent || (reflection && m.kind == 2)) continue;
            const auto &transform = scene_transform(d.prop, d.entity, d.model);
            if (!transform.visible) continue;
            const auto model = native::model_matrix(transform);
            materialValues.model = model;
            bind_material(d.material, d.prop, translucent, reflection, view.graphics, water);
            context.bind_geometry(d.prop ? propMesh.geometry : worldMesh.geometry);
            context.draw_indexed(
                    gfx::Primitive::triangles, gfx::IndexType::u32, size_t(d.first) * sizeof(uint32_t), int(d.count)
            );
            if (profile.profiling) {
                profile.frameProfile.drawCalls++;
                profile.frameProfile.triangles += d.count / 3;
            }
        }
    }

    template <class CaptureRefraction>
    void draw_scene(
            const native::Matrix &vp,
            const float eye[3],
            bool sky,
            double time,
            bool reflection,
            const View &view,
            WaterPass &water,
            CaptureRefraction capture_refraction
    ) {
        water.sceneCaptured = false;
        activePipeline = ~0u;
        prepare_scene_values(vp, eye, sky, time, reflection, view, water);
        collect_scene_draws(vp, eye, sky, reflection, view);
        auto &draws = sceneDrawList.draws;
        const bool visibleWater = water.hasWaterMaterials
                                  && std::any_of(draws.begin(), draws.end(), [&](const native_render::SceneDraw &d) {
                                         return d.material < materials.size() && materials[d.material].kind == 2;
                                     });
        for (int pass = 0; pass < 2; pass++) {
            const double sortBefore = profile.frameProfile.sort;
            auto phaseStart = profile.profile_now();
            if (pass) {
                if (!sky && !reflection && water.waterPlan.refract && visibleWater) {
                    capture_refraction();
                    water.sceneCaptured = true;
                    context.bind_program(program);
                    activePipeline = ~0u;
                    bind_scene_textures(water);
                }
                auto sortStart = profile.profile_now();
                sceneDrawList.back_to_front();
                profile.profile_elapsed(profile.frameProfile.sort, sortStart);
            }
            submit_draws(pass != 0, reflection, view, water);
            profile.profile_elapsed(profile.frameProfile.submit, phaseStart);
            if (profile.profiling) profile.frameProfile.submit -= profile.frameProfile.sort - sortBefore;
        }
        context.pipeline(endPipelines[unsigned(reflection)]);
        // Legacy skinned meshes use texture parameters for their single-level bone texture.
        context.unbind_sampler(0);
    }

    void record_group_bounds(
            uint64_t key,
            uint32_t first,
            uint32_t count,
            const float *v,
            size_t floats,
            int stride,
            const uint32_t *ix,
            size_t n
    ) {
        if (uint64_t(first) + count > n) throw std::runtime_error("Native draw range exceeds index buffer");
        native_render::Bounds bounds;
        bounds.lo.fill(1e30f);
        bounds.hi.fill(-1e30f);
        for (size_t i = first; i < size_t(first) + count; i++) {
            const size_t at = size_t(ix[i]) * stride;
            if (at + 2 >= floats) throw std::runtime_error("Native group vertex invalid");
            for (int k = 0; k < 3; k++) {
                bounds.lo[k] = std::min(bounds.lo[k], v[at + k]);
                bounds.hi[k] = std::max(bounds.hi[k], v[at + k]);
            }
        }
        std::array<float, 3> mid{};
        for (int k = 0; k < 3; k++)
            mid[k] = (bounds.lo[k] + bounds.hi[k]) * .5f;
        centers[key] = mid;
        groupBounds[key] = bounds;
    }

    ResourceLoading prepare_world(WaterPass &water) {
        size_t nv = 0, ni = 0, ng = 0, nm = 0, ne = 0, nb = 0;
        const float *verts = bh_vertices(core, &nv);
        const uint32_t *indices = bh_indices(core, &ni);
        const auto *rawGroups = bh_groups(core, &ng);
        const auto *rawMaterials = bh_materials(core, &nm);
        const auto *rawExtras = bh_material_extras(core, &ne);
        const float *blend = bh_blend(core, &nb);
        if (!nv || !ni || !ng || !rawGroups) throw std::runtime_error("Map has no drawable native mesh");
        if (rawMaterials && nm) materials.assign(rawMaterials, rawMaterials + nm);
        if (materials.empty()) materials.push_back({-1, 1, 0, 1, .5f, {1, 1, 1}});
        if (rawExtras && ne) extras.assign(rawExtras, rawExtras + ne);
        groups.assign(rawGroups, rawGroups + ng);
        water.hasWaterMaterials =
                std::any_of(materials.begin(), materials.end(), [](const BhMaterial &m) { return m.kind == 2; });
        for (size_t i = 0; i < materials.size() && i < extras.size(); i++)
            water.waterBeneathFaces |= materials[i].kind == 2 && !extras[i].above_water;
        co_yield "geometry";
        worldMesh = resources.geometry(verts, nv, 10, indices, ni, blend, nb);
        co_yield "resource";
        for (const auto &item : groups) {
            record_group_bounds(item.first_index, item.first_index, item.index_count, verts, nv, 10, indices, ni);
            co_yield "resource";
        }
    }

    ResourceLoading prepare_props() {
        size_t pv = 0, pi = 0, pg = 0;
        const float *propVertices = bh_prop_vertices(core, &pv);
        const auto *propIndices = bh_prop_indices(core, &pi);
        const auto *rawProps = bh_prop_groups(core, &pg);
        propMesh = resources.geometry(propVertices, pv, 8, propIndices, pi);
        if (rawProps && pg) propGroups.assign(rawProps, rawProps + pg);
        co_yield "resource";
        for (const auto &item : propGroups) {
            record_group_bounds(
                    (uint64_t(1) << 63) | item.first_index,
                    item.first_index,
                    item.index_count,
                    propVertices,
                    pv,
                    8,
                    propIndices,
                    pi
            );
            co_yield "resource";
        }
    }

    ResourceLoading prepare_textures() {
        for (const auto &m : materials)
            if (m.flags & (material_translucent | material_alpha_test)) resources.cutoutTextures.insert(m.texture);
        co_yield "resource";
        for (const auto &m : materials) {
            auto texture_loading = resources.cache_texture(m.texture);
            while (!texture_loading.step())
                co_yield "texture";
            co_yield "texture";
        }
        for (const auto &e : extras) {
            auto secondary_loading = resources.cache_texture(e.texture2);
            while (!secondary_loading.step())
                co_yield "secondary texture";
            auto detail_loading = resources.cache_texture(e.detail, true);
            while (!detail_loading.step())
                co_yield "detail texture";
        }
    }

    void prepare_uniforms() {
        const std::pair<const char *, unsigned> textures[] = {
                {"baseTexture", 0},
                {"lightTexture", 1},
                {"secondaryTexture", 2},
                {"detailTexture", 3},
                {"sceneColor", 4},
                {"sceneDepth", 5},
                {"normalTexture", 7},
                {"reflectionTexture", 8},
                {"sunShadowMap", 11}
        };
        for (const auto &[name, unit] : textures)
            context.texture_unit(program, name, unit);
    }

    void prepare_program(WaterPass &water) {
        program = context.create_program(
                {{"world", ""}, native_render::world_vertex, native_render::world_fragment().c_str()}
        );
        prepare_material_constants();
        prepare_scene_constants();
        prepare_sun_constants();
        prepare_pipelines();
        waterConstants = water.water_constants(program);
    }

    void prepare_lightmap() {
        // The atlas is sRGB-encoded linear light times its scale (bunnyhop_core::lightmap): decode, then divide.
        BhImage image{};
        lightmap = bh_lightmap(core, &image) ? resources.upload(image, false, true) : resources.white;
        if (lightmap == resources.white || !bh_lightmap_info(core, &lightmapInfo)) lightmapInfo = {1, 0};
    }
};
