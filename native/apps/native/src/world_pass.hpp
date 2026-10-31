#pragma once

class WorldPass {
    Gl &gl;
    BhContext *&core;
    RenderResources &resources;
    RenderUniforms &uniforms;
    RenderProfile &profile;

public:
    WorldPass(Gl &g, BhContext *&c, RenderResources &r, RenderUniforms &u, RenderProfile &p)
        : gl(g), core(c), resources(r), uniforms(u), profile(p) {}

    GLuint program = 0, lightmap = 0;
    RenderGeometry worldMesh, propMesh;
    std::vector<BhGroup> groups;
    std::vector<BhPropGroup> propGroups;
    std::vector<GLuint> normals;
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
        std::unordered_map<std::string, GLuint> cached;
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
                normals[i] = resources.upload(image, true, true, false);
                cached.emplace(path, normals[i]);
            }
        }
        std::cout << "Native embedded normal textures: " << cached.size() << "\n";
    }

    bool transparent(const BhMaterial &m) const {
        return (m.flags & (1 | 8)) || m.kind == 2 || m.kind == 3 || m.alpha < 1;
    }

    // Per-draw uniforms of the world program, looked up once: bind_material runs for every draw of every pass.
    struct MaterialUniforms {
        GLint model = -1, flatColor = -1, hasNormal = -1, hasSecondary = -1, hasDetail = -1, detailScale = -1;
        GLint detailBlend = -1, tint = -1, opacity = -1, cutoff = -1, unlit = -1, props = -1, kind = -1;
        GLint aboveWater = -1, captureReady = -1, waterFogEnd = -1, additive = -1;

        void read(Gl &gl, GLuint program) {
            const std::pair<GLint *, const char *> uniforms[] = {
                    {&model, "model"},
                    {&flatColor, "flatColor"},
                    {&hasNormal, "hasNormal"},
                    {&hasSecondary, "hasSecondary"},
                    {&hasDetail, "hasDetail"},
                    {&detailScale, "detailScale"},
                    {&detailBlend, "detailBlend"},
                    {&tint, "tint"},
                    {&opacity, "opacity"},
                    {&cutoff, "cutoff"},
                    {&unlit, "unlit"},
                    {&props, "props"},
                    {&kind, "kind"},
                    {&aboveWater, "aboveWater"},
                    {&captureReady, "captureReady"},
                    {&waterFogEnd, "waterFogEnd"},
                    {&additive, "additive"},
            };
            for (const auto &[location, name] : uniforms)
                *location = gl.GetUniformLocation(program, name);
        }
    } materialUniforms;

    void bind_material(
            uint32_t index, bool prop, const native::GraphicsSettings &graphics, const WaterPass &water
    ) {
        const BhMaterial fallback = {-1, 1, 0, 1, .5f, {1, 1, 1}};
        const auto &m = index < materials.size() ? materials[index] : fallback;
        if (graphics.potato) {
            const auto found = resources.textureAverages.find(m.texture);
            const std::array<float, 3> fallbackColor = {.5f, .5f, .5f};
            gl.Uniform3fv(
                    materialUniforms.flatColor,
                    1,
                    found == resources.textureAverages.end() ? fallbackColor.data() : found->second.data()
            );
        }
        const BhMaterialExtra empty = {-1, -1, 4, 1, 0, 400, 1};
        const auto &e = index < extras.size() ? extras[index] : empty;
        gl.ActiveTexture(GL_TEXTURE0);
        gl.BindTexture(
                GL_TEXTURE_2D,
                m.texture < 0 ? (m.kind == 1 ? resources.checker : resources.white) : resources.texture(m.texture)
        );
        gl.ActiveTexture(GL_TEXTURE2);
        gl.BindTexture(GL_TEXTURE_2D, resources.texture(e.texture2));
        gl.ActiveTexture(GL_TEXTURE3);
        gl.BindTexture(GL_TEXTURE_2D, resources.texture(e.detail, true));
        gl.ActiveTexture(GL_TEXTURE7);
        gl.BindTexture(GL_TEXTURE_2D, index < normals.size() && normals[index] ? normals[index] : resources.white);
        const bool hasNormal = graphics.material_response && index < normals.size() && normals[index];
        gl.Uniform1i(materialUniforms.hasNormal, hasNormal);
        gl.Uniform1i(materialUniforms.hasSecondary, e.texture2 >= 0);
        gl.Uniform1i(materialUniforms.hasDetail, e.detail >= 0 && !graphics.potato);
        gl.Uniform1f(materialUniforms.detailScale, e.detail_scale);
        gl.Uniform1f(materialUniforms.detailBlend, e.detail_blend);
        gl.Uniform3fv(materialUniforms.tint, 1, m.color);
        gl.Uniform1f(materialUniforms.opacity, m.alpha);
        gl.Uniform1f(materialUniforms.cutoff, (m.flags & 2) ? m.alpha_ref : 0);
        gl.Uniform1i(materialUniforms.unlit, (m.flags & 16) != 0 || (!prop && lightmap == resources.white));
        gl.Uniform1i(materialUniforms.props, prop);
        gl.Uniform1i(materialUniforms.kind, m.kind);
        gl.Uniform1i(materialUniforms.aboveWater, e.above_water);
        if (m.kind == 2) {
            gl.Uniform1i(materialUniforms.captureReady, water.sceneCaptured && water.waterPlanner.ready(index));
            gl.Uniform1f(materialUniforms.waterFogEnd, std::max(1.f, e.fog_end));
        }
        gl.Uniform1i(materialUniforms.additive, (m.flags & 8) != 0);
        const bool doubleSided = m.kind == 2
                                         ? native_render::water_face_double_sided(water.waterBeneathFaces, e.above_water)
                                         : (m.flags & 4) != 0;
        if (doubleSided)
            gl.Disable(GL_CULL_FACE);
        else
            gl.Enable(GL_CULL_FACE);
        gl.BlendFunc(GL_SRC_ALPHA, (m.flags & 8) ? GL_ONE : GL_ONE_MINUS_SRC_ALPHA);
        if (m.kind == 2) {
            gl.Enable(GL_POLYGON_OFFSET_FILL);
            gl.PolygonOffset(-1, -4);
        } else
            gl.Disable(GL_POLYGON_OFFSET_FILL);
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

    // reflection: the mirrored scene for the water reflection, without the water itself.
    template <class CaptureRefraction>
    void draw_scene(
            const native::Matrix &vp, const float eye[3], bool sky, double time, bool reflection,
            const View &view, WaterPass &water, CaptureRefraction capture_refraction
    ) {
        const auto &skyInfo = view.skyInfo;
        auto phaseStart = profile.profile_now();
        water.sceneCaptured = false;
        gl.UseProgram(program);
        gl.UniformMatrix4fv(uniforms.loc(program, "viewProjection"), 1, GL_FALSE, vp.data());
        gl.Uniform1f(uniforms.loc(program, "clipHeight"), view.clipHeight);
        water.water_uniforms(program, eye, vp, view.viewportWidth, view.viewportHeight);
        gl.Uniform1f(uniforms.loc(program, "timeSeconds"), time);
        gl.Uniform1i(uniforms.loc(program, "reflectionReady"), !sky && !reflection && water.reflectionDrawn);
        gl.Uniform1f(uniforms.loc(program, "reflectionHeight"), water.waterPlan.reflection_height.value_or(0));
        gl.ActiveTexture(GL_TEXTURE8);
        gl.BindTexture(GL_TEXTURE_2D, water.reflectionDrawn ? water.waterReflection->texture() : resources.white);
        gl.Uniform1i(uniforms.loc(program, "fullbright"), view.graphics.fullbright);
        gl.Uniform1i(uniforms.loc(program, "potato"), view.graphics.potato);
        gl.Uniform1i(uniforms.loc(program, "skyPass"), sky && view.hasSky && skyInfo.fog_enable);
        gl.Uniform1i(uniforms.loc(program, "flashlight"), view.flashlightEnabled && !sky);
        gl.Uniform3f(
                uniforms.loc(program, "flashDirection"),
                std::cos(view.lastPitch * native::radians) * std::cos(view.lastYaw * native::radians),
                std::cos(view.lastPitch * native::radians) * std::sin(view.lastYaw * native::radians),
                -std::sin(view.lastPitch * native::radians)
        );
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
        gl.Uniform3fv(uniforms.loc(program, "skyFogColor"), 1, fog);
        gl.Uniform3f(
                uniforms.loc(program, "skyFogRange"),
                skyInfo.fog_start / std::max(skyInfo.scale, .001f),
                skyInfo.fog_end / std::max(skyInfo.scale, .001f),
                skyInfo.fog_max_density
        );
        gl.ActiveTexture(GL_TEXTURE1);
        gl.BindTexture(GL_TEXTURE_2D, lightmap);
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
        const bool visibleWater =
                water.hasWaterMaterials
                && std::any_of(draws.begin(), draws.end(), [&](const native_render::SceneDraw &d) {
                    return d.material < materials.size() && materials[d.material].kind == 2;
                });
        for (int pass = 0; pass < 2; pass++) {
            const double sortBefore = profile.frameProfile.sort;
            phaseStart = profile.profile_now();
            if (pass) {
                if (!sky && !reflection && water.waterPlan.refract && visibleWater) {
                    capture_refraction();
                    water.sceneCaptured = true;
                }
                gl.Enable(GL_BLEND);
                gl.DepthMask(GL_FALSE);
                auto sortStart = profile.profile_now();
                sceneDrawList.back_to_front();
                profile.profile_elapsed(profile.frameProfile.sort, sortStart);
            } else {
                gl.Disable(GL_BLEND);
                gl.DepthMask(GL_TRUE);
            }
            for (const auto &d : draws) {
                const auto &m = d.material < materials.size() ? materials[d.material] : materials.front();
                if (transparent(m) != (pass != 0) || (reflection && m.kind == 2)) continue;
                const auto &transform = scene_transform(d.prop, d.entity, d.model);
                if (!transform.visible) continue;
                const auto model = native::model_matrix(transform);
                gl.UniformMatrix4fv(materialUniforms.model, 1, GL_FALSE, model.data());
                bind_material(d.material, d.prop, view.graphics, water);
                gl.BindVertexArray(d.prop ? propMesh.vao : worldMesh.vao);
                gl.DrawElements(
                        GL_TRIANGLES,
                        d.count,
                        GL_UNSIGNED_INT,
                        reinterpret_cast<void *>(uintptr_t(d.first) * sizeof(uint32_t))
                );
                if (profile.profiling) {
                    profile.frameProfile.drawCalls++;
                    profile.frameProfile.triangles += d.count / 3;
                }
            }
            profile.profile_elapsed(profile.frameProfile.submit, phaseStart);
            if (profile.profiling) profile.frameProfile.submit -= profile.frameProfile.sort - sortBefore;
        }
        gl.DepthMask(GL_TRUE);
        gl.Disable(GL_POLYGON_OFFSET_FILL);
        gl.Disable(GL_BLEND);
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
        gl.UseProgram(program);
        gl.Uniform1i(uniforms.loc(program, "baseTexture"), 0);
        gl.Uniform1i(uniforms.loc(program, "lightTexture"), 1);
        gl.Uniform1i(uniforms.loc(program, "secondaryTexture"), 2);
        gl.Uniform1i(uniforms.loc(program, "detailTexture"), 3);
        gl.Uniform1i(uniforms.loc(program, "sceneColor"), 4);
        gl.Uniform1i(uniforms.loc(program, "sceneDepth"), 5);
        gl.Uniform1i(uniforms.loc(program, "reflectionTexture"), 8);
        gl.Uniform2f(uniforms.loc(program, "cameraNearFar"), native::camera_near_plane, native::camera_far_plane);
        gl.Uniform1f(uniforms.loc(program, "lightmapScale"), lightmapInfo.scale);
    }

    void prepare_program() {
        program = link_program(gl, native_render::world_vertex, native_render::world_fragment().c_str());
        materialUniforms.read(gl, program);
    }

    void prepare_lightmap() {
        // The atlas is sRGB-encoded linear light times its scale (bunnyhop_core::lightmap): decode, then divide.
        BhImage image{};
        lightmap = bh_lightmap(core, &image) ? resources.upload(image, false, false, true) : resources.white;
        if (lightmap == resources.white || !bh_lightmap_info(core, &lightmapInfo)) lightmapInfo = {1, 0};
    }
};
