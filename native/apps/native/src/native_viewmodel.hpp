#pragma once
#include "actor_anim.hpp"
#include "tp_inspect.hpp"
#include <span>
#ifndef BUNNYHOP_NATIVE_ASSET_ROOT
#define BUNNYHOP_NATIVE_ASSET_ROOT "target/native-assets"
#endif
// Original meshes/pose clips and cosmetic shader recipes are compiled to data at build time.
// This runtime uses native OpenGL GPU skinning; it embeds no JavaScript or web renderer.
class NativeViewmodel {
    struct Clip {
        std::string name;
        double duration = 0;
        size_t frames = 0, offset = 0;
    };

    struct Entry {
        size_t bones = 0;
        std::vector<std::string> meshes;
        std::vector<Clip> clips;
    };

    struct Mesh {
        GLuint vao = 0, vbo = 0, ebo = 0;
        size_t vertices = 0, offset = 0, indices = 0, indexOffset = 0, glowOffset = 0;
        GLuint glowVbo = 0;
    };

    struct HeadwearFit {
        std::array<float, 3> scale{1, 1, 1}, offset{}, faceScale{1, 1, 1}, faceOffset{};
    };

    struct Look {
        std::string outfit = "outfit-cream", knife = "carrot", glove = "knit", gloveId = "glove-knit", hat,
                    body = "classic", bodyLook = "bunny", hatMesh;
        int finish = 0, crown = 0;
        // The standard bunny lowers its hood for a wig (loadout.ts isWig).
        bool hoodDown = false;
        std::array<float, 24> palette{};
        std::array<float, 15> gloveColors{};
        std::array<float, 3> accent{}, hairColor{};
        // The ponytail's length over the built one (loadout.hairLength / 100).
        float hairLength = 1;
        HeadwearFit fit;
    };

    struct CachedLook {
        std::string outfit, packed;
        Look look;
        bool used = false;
    };

    std::array<CachedLook, 128> lookCache;
    size_t nextLook = 0;
    std::vector<float> basePose;
    std::unique_ptr<NativePresentation> gunFx;
    double gunFlashStarted = -100;
    std::shared_ptr<native_actor_anim::Data> actorAnimationData;
    std::unordered_map<std::string, std::unique_ptr<native_actor_anim::State>> actorAnimationStates;
    Gl &gl;
    using PlayerProgram = native_render::PlayerProgram;
    using PlayerMaterial = native_render::PlayerMaterial;
    static constexpr size_t vertex_floats = 23;
    // The metals' scene reflection sampler: a black cube on its own unit, read only when a look turns reflections on.
    static constexpr GLint reflection_unit = 9;
    GLuint bonesTexture = 0, identityBonesTexture = 0, reflectionCube = 0;
    std::unordered_map<int, PlayerProgram> programs;
    std::unique_ptr<native_render::PlayerShaderSources> shaders;
    // Detail by graphics look (finishes/detail.ts tierOf, player/look-tier.ts lookTierOf): Potato, Plain, Source.
    int cosmeticsTier = 2, playerLookTier = 1;
    std::unordered_map<std::string, Entry> entries;
    std::unordered_map<std::string, Mesh> meshes;
    std::vector<std::string> weapons;
    std::vector<float> data, pose;
    nlohmann::json metadata;
    std::optional<native_render::Glow> localGlow;
    bool showGlow = true, firstPersonGlow = true;
    Look equipped;
    std::string previewLoadout;
    std::array<float, 3> ghostColor{1, .54f, .047f}, ghostRim{1, .54f, .047f};

    struct ActorParts {
        std::string id, outfit, loadout;
        uint32_t weapon = 0;
        bool silenced = false, emptyHand = false, used = false;
        std::array<std::string, 5> names;
        size_t count = 0;
    };

    std::array<ActorParts, 68> actorParts;
    size_t nextActorParts = 0;

    std::span<const std::string> parts_for(const native_render::Actor &actor, const Look &look) {
        ActorParts *parts = nullptr;
        for (auto &cached : actorParts) {
            if (cached.used && cached.id == actor.id) {
                parts = &cached;
                break;
            }
        }
        if (parts && parts->outfit == actor.outfit && parts->loadout == actor.loadout
            && parts->weapon == actor.frame.weapon && parts->silenced == actor.silenced
            && parts->emptyHand == actor.emptyHand) {
            return {parts->names.data(), parts->count};
        }
        if (!parts) parts = &actorParts[nextActorParts++ % actorParts.size()];
        parts->used = true;
        parts->id = actor.id;
        parts->outfit = actor.outfit;
        parts->loadout = actor.loadout;
        parts->weapon = actor.frame.weapon;
        parts->silenced = actor.silenced;
        parts->emptyHand = actor.emptyHand;
        parts->count = 0;
        const auto &body = look.bodyLook;
        parts->names[parts->count++] = "body:" + body + ":" + (body == "bunny" ? look.body : "classic") + ":"
                                       + look.glove + (look.hoodDown ? ":down" : "");
        if (!look.hatMesh.empty()) parts->names[parts->count++] = look.hatMesh;
        const auto &gun = weapons[std::min(size_t(actor.frame.weapon), weapons.size() - 1)];
        if (actor.emptyHand) return {parts->names.data(), parts->count};
        parts->names[parts->count++] = gun.empty() || gun == "knife" ? "tpknife:" + look.knife : "tpgun:" + gun;
        if (actor.silenced && !gun.empty() && gun != "knife") parts->names[parts->count++] = "tpsilencer:" + gun;
        return {parts->names.data(), parts->count};
    }

    std::array<std::array<float, 3>, 2> previewTrail{{{1, .761f, .239f}, {1, .761f, .239f}}};
    bool previewTrailVisible = true;
    std::vector<std::string> actorNames;
    std::vector<int> actorParents;
    std::vector<float> actorBind;
    nlohmann::json tpInspects;

    struct ActorAction {
        native_tp::Combo gesture;
        double last = -1;
        double attack = -100, inspect = -100;
        unsigned mode = 0, weapon = 0;
        std::string knife;
        int inspectIndex = -1;
        unsigned inspectLoops = 0;
        native_render::AccessoryMotion accessory;
        native_render::PonytailMotion ponytail;
    };

    std::unordered_map<std::string, ActorAction> actorActions;
    float previewYaw = 0, previewPitch = 0;
    float bobScale = 1, swayScale = 1, swayYaw = 0, swayPitch = 0, previousYaw = 0, previousPitch = 0;
    bool viewInitialized = false;
    float fov = 54, offsetX = .6f, offsetY = 1.5f, offsetZ = -.9f;
    bool leftHand = false;
    uint32_t previousClip = 0;
    bool gunSilenced = false;
    uint32_t previousWeapon = 0, previousTick = ~0u;
    int inspectIndex = -1;
    bool inspectQueued = false, inspectHeld = false;
    uint32_t inspectPresses = 0, inspectLoops = 0;
    std::string previousEntry, action = "idle";
    double started = 0;

    const Clip *clip(const Entry &entry, const std::string &name) const {
        for (const auto &c : entry.clips)
            if (c.name == name) return &c;
        for (const auto &c : entry.clips)
            if (c.name == "idle") return &c;
        return entry.clips.empty() ? nullptr : &entry.clips.front();
    }

    static std::string body_look(const std::string &outfit) {
        return outfit == "outfit-tek"     ? "tek"
               : outfit == "outfit-plush" ? "plush"
               : outfit == "outfit-bune"  ? "bune"
                                          : "bunny";
    }

    static bool listed(const nlohmann::json &list, const std::string &id) {
        return std::find(list.begin(), list.end(), id) != list.end();
    }

    // Packed loadout fields 8 and 9 (loadout.ts packLoadout): a wig's colour as six hex digits, the ponytail's length
    // as a whole percent. Both only count for the hats that take them.
    void read_hair(const std::vector<std::string> &fields, Look &out) const {
        const auto &hair = metadata.at("hair");
        linearColor(hair.at("defaultColor").get<uint32_t>(), out.hairColor.data());
        if (out.hat.empty() || !listed(hair.at("hats"), out.hat)) return;
        const auto &color = fields.size() > 8 ? fields[8] : std::string();
        if (color.size() == 6 && color.find_first_not_of("0123456789abcdefABCDEF") == std::string::npos)
            linearColor(uint32_t(std::stoul(color, nullptr, 16)), out.hairColor.data());
        const auto &length = fields.size() > 9 ? fields[9] : std::string();
        if (!listed(hair.at("lengthHats"), out.hat) || length.empty() || length.size() > 3
            || length.find_first_not_of("0123456789") != std::string::npos)
            return;
        const auto &limits = hair.at("length");
        const int percent = std::clamp(std::stoi(length), limits.at("min").get<int>(), limits.at("max").get<int>());
        out.hairLength = float(percent) / 100;
    }

    static std::array<float, 3> vector3(const nlohmann::json &value) {
        return {value.at(0).get<float>(), value.at(1).get<float>(), value.at(2).get<float>()};
    }

    // The website's hat fit for this body (player/bunny/hat-fit.ts, exported per look and hat) and which mesh it wears.
    void fit_headwear(Look &out) const {
        out.bodyLook = body_look(out.outfit);
        if (!out.hat.empty()) {
            const auto &byLook = metadata.at("hats").at(out.hat);
            if (byLook.contains(out.bodyLook)) out.hatMesh = byLook.at(out.bodyLook);
            out.hoodDown = out.bodyLook == "bunny" && listed(metadata.at("hair").at("hats"), out.hat);
        } else if (out.crown)
            out.hatMesh = "crown:" + std::to_string(out.crown);
        const auto &fits = metadata.at("hatFits").at(out.bodyLook);
        const auto &fit = fits.contains(out.hat) ? fits.at(out.hat) : fits.at("");
        out.fit.scale = vector3(fit.at("scale"));
        out.fit.offset = vector3(fit.at("offset"));
        out.fit.faceScale = out.fit.scale;
        out.fit.faceOffset = out.fit.offset;
        if (fit.contains("face")) {
            out.fit.faceScale = vector3(fit.at("face").at("scale"));
            out.fit.faceOffset = vector3(fit.at("face").at("offset"));
        }
    }

    const Look &look(const std::string &outfit, const std::string &packed) {
        for (const auto &cached : lookCache) {
            if (cached.used && cached.outfit == outfit && cached.packed == packed) return cached.look;
        }
        auto &cached = lookCache[nextLook++ % lookCache.size()];
        cached.outfit = outfit;
        cached.packed = packed;
        cached.used = true;
        Look out;
        if (metadata.at("outfits").contains(outfit)) out.outfit = outfit;
        std::vector<std::string> f;
        std::stringstream stream(packed.size() <= 200 ? packed : "");
        std::string part;
        while (std::getline(stream, part, ';'))
            f.push_back(part);
        if (f.size() >= 4 && (f[0] == "2" || (f[0] == "1" && f.size() >= 6))) {
            const auto knife = f[1].rfind("knife-", 0) == 0 ? f[1].substr(6) : f[1];
            if (meshes.count("fpknife:" + knife)) out.knife = knife;
            if (metadata.at("finishes").contains(f[2])) out.finish = metadata["finishes"][f[2]];
            const auto id = f[f[0] == "2" ? 3 : 5];
            if (metadata.at("gloves").contains(id)) {
                out.gloveId = id;
                out.glove = metadata["gloves"][id]["style"];
            }
            const size_t crown = f[0] == "2" ? 4 : 6;
            if (f.size() > crown && f[crown].size() == 1 && f[crown][0] >= '1' && f[crown][0] <= '3')
                out.crown = f[crown][0] - '0';
            if (f[0] == "2") {
                if (f.size() > 5 && metadata.at("hats").contains(f[5])) out.hat = f[5];
                if (f.size() > 6 && f[6] == "body-b") out.body = "feminine";
                read_hair(f, out);
            }
        }
        // These two character outfits ship with matching paws in the site's default loadout.
        if (out.glove == "knit" && (out.outfit == "outfit-plush" || out.outfit == "outfit-bune")) {
            out.glove = out.outfit.substr(7);
            out.gloveId = "glove-" + out.glove;
        }
        const auto &palette = metadata.at("outfits").at(out.outfit);
        const char *slots[] = {"hoodie", "trim", "pants", "pantsTrim", "shoe", "face", "glove", "detail"};
        for (size_t slot = 0; slot < 8; ++slot)
            linearColor(palette.at(slots[slot]), out.palette.data() + slot * 3);
        linearColor(palette.at("accent"), out.accent.data());
        const auto &glove = metadata.at("gloves").at(out.gloveId);
        const char *gloveSlots[] = {"base", "fingers", "tips", "strap", "detail"};
        for (size_t slot = 0; slot < 5; ++slot)
            linearColor(glove.at(gloveSlots[slot]), out.gloveColors.data() + slot * 3);
        fit_headwear(out);
        cached.look = std::move(out);
        return cached.look;
    }

    PlayerProgram link_player_program(int finish, bool glove, bool detail, PlayerMaterial material) {
        const auto defines = native_render::player_defines(finish, glove, detail, material);
        const bool gun = material == PlayerMaterial::gun || material == PlayerMaterial::world_gun;
        const auto vertex = defines + (gun ? shaders->gunVertex : shaders->vertex);
        const auto fragment = defines
                              + (material == PlayerMaterial::ghost ? shaders->ghost
                                 : gun                             ? shaders->gun
                                                                   : shaders->solid);
        PlayerProgram p;
        p.id = link_program(gl, vertex.c_str(), fragment.c_str());
        auto at = [&](const char *name) {
            return gl.GetUniformLocation(p.id, name);
        };
        p.projection = at("projection");
        p.model = at("model");
        p.modelMatrix = at("modelMatrix");
        p.viewMatrix = at("viewMatrix");
        p.cameraPosition = at("cameraPosition");
        p.offset = at("offset");
        p.mirror = at("mirror");
        p.auraPass = at("auraPass");
        p.auraSize = at("auraSize");
        p.glowTime = at("glowTime");
        p.boneMatrices = at("boneMatrices");
        p.palette = at("uPalette");
        p.accent = at("uAccent");
        p.glove = at("uGlove");
        p.finTime = at("uFinTime");
        p.cosTier = at("uCosTier");
        p.playerLook = at("uPlayerLook");
        p.fabric = at("uFabric");
        p.headwearScale = at("uHeadwearScale");
        p.headwearOffset = at("uHeadwearOffset");
        p.headwearFaceScale = at("uHeadwearFaceScale");
        p.headwearFaceOffset = at("uHeadwearFaceOffset");
        p.hairColor = at("uHairColor");
        p.propellerAngle = at("uPropellerAngle");
        p.capybara = at("uCapybara");
        p.ponytail = at("uPonytail");
        p.finEnvOn = at("uFinEnvOn");
        p.cosEnvOn = at("uCosEnvOn");
        p.playerEnvOn = at("uPlayerEnvOn");
        p.finSunDir = at("uFinSunDir");
        p.finSunColor = at("uFinSunColor");
        p.finEnv = at("uFinEnv");
        p.cosEnv = at("uCosEnv");
        p.playerEnv = at("uPlayerEnv");
        p.gunFlash = at("uGunFlash");
        p.gunFlashPos = at("uGunFlashPos");
        p.glowEnabled = at("playerGlowEnabled");
        p.glowColor = at("playerGlowColor");
        p.glowIntensity = at("playerGlowIntensity");
        p.glowOpacity = at("glowOpacity");
        p.glowAxisA = at("glowAxisA");
        p.glowAxisB = at("glowAxisB");
        p.glowNearFade = at("glowNearFade");
        p.glowDistance = at("uGlowDistance");
        p.ghost = at("uGhost");
        p.ghostRim = at("uGhostRim");
        p.opacity = at("uOpacity");
        p.axisA = at("uAxisA");
        p.axisB = at("uAxisB");
        p.nearFade = at("uNearFade");
        return p;
    }

    const PlayerProgram &program(const Look &look, PlayerMaterial material, bool detail = false) {
        const bool glove = look.glove != "knit";
        // Guns take no finish (the knife's finish stays on the knife), as on the website.
        const int finish = material == PlayerMaterial::solid ? look.finish : 0;
        const int key = native_render::player_program_key(finish, glove, detail, material);
        if (const auto found = programs.find(key); found != programs.end()) return found->second;
        return programs.emplace(key, link_player_program(finish, glove, detail, material)).first->second;
    }

    void mesh(const std::string &name, int instances = 1) {
        auto at = meshes.find(name);
        if (at == meshes.end()) return;
        auto &m = at->second;
        if (!m.vao) {
            gl.GenVertexArrays(1, &m.vao);
            gl.BindVertexArray(m.vao);
            gl.GenBuffers(1, &m.vbo);
            gl.BindBuffer(GL_ARRAY_BUFFER, m.vbo);
            gl.BufferData(
                    GL_ARRAY_BUFFER, m.vertices * vertex_floats * sizeof(float), data.data() + m.offset, GL_STATIC_DRAW
            );
            // position, normal, partColor, skinIndex, skinWeight, accent, finishUV, then headwear at location 8
            // (location 7 is the glow's smooth normal, in its own buffer).
            constexpr std::array<GLuint, 8> location = {0, 1, 2, 3, 4, 5, 6, 8};
            constexpr std::array<int, 8> size = {3, 3, 3, 4, 4, 1, 4, 1}, offset = {0, 3, 6, 9, 13, 17, 18, 22};
            for (size_t a = 0; a < location.size(); a++) {
                gl.EnableVertexAttribArray(location[a]);
                gl.VertexAttribPointer(
                        location[a],
                        size[a],
                        GL_FLOAT,
                        GL_FALSE,
                        vertex_floats * sizeof(float),
                        reinterpret_cast<void *>(size_t(offset[a]) * 4)
                );
            }
            gl.GenBuffers(1, &m.glowVbo);
            gl.BindBuffer(GL_ARRAY_BUFFER, m.glowVbo);
            gl.BufferData(GL_ARRAY_BUFFER, m.vertices * 3 * sizeof(float), data.data() + m.glowOffset, GL_STATIC_DRAW);
            gl.EnableVertexAttribArray(7);
            gl.VertexAttribPointer(7, 3, GL_FLOAT, GL_FALSE, 3 * sizeof(float), nullptr);
            if (m.indices) {
                gl.GenBuffers(1, &m.ebo);
                gl.BindBuffer(GL_ELEMENT_ARRAY_BUFFER, m.ebo);
                gl.BufferData(GL_ELEMENT_ARRAY_BUFFER, m.indices * 4, data.data() + m.indexOffset, GL_STATIC_DRAW);
            }
        }
        gl.BindVertexArray(m.vao);
        if (instances > 1) {
            if (m.indices)
                gl.DrawElementsInstanced(GL_TRIANGLES, m.indices, GL_UNSIGNED_INT, nullptr, instances);
            else
                gl.DrawArraysInstanced(GL_TRIANGLES, 0, m.vertices, instances);
        } else if (m.indices)
            gl.DrawElements(GL_TRIANGLES, m.indices, GL_UNSIGNED_INT, nullptr);
        else
            gl.DrawArrays(GL_TRIANGLES, 0, m.vertices);
    }

    void draw_glow(std::span<const std::string> parts, const PlayerProgram &program, bool aura, float scale) {
        gl.Uniform1f(program.auraSize, scale);
        gl.Enable(GL_BLEND);
        gl.BlendFunc(GL_SRC_ALPHA, GL_ONE);
        gl.DepthMask(GL_FALSE);
        gl.Enable(GL_CULL_FACE);
        gl.CullFace(GL_FRONT);
        gl.Uniform1f(program.auraPass, 1);
        for (const auto &part : parts) {
            mesh(part);
        }
        if (aura && !parts.empty()) {
            gl.Uniform1f(program.auraPass, 2);
            mesh(parts.front(), native_render::glow_halo_layers);
        }
        gl.CullFace(GL_BACK);
        gl.Disable(GL_CULL_FACE);
        gl.Uniform1f(program.auraPass, 0);
        gl.Disable(GL_BLEND);
        gl.DepthMask(GL_TRUE);
    }

    void sample(const Entry &entry, const Clip &c, double t, bool loop) {
        if (loop && c.duration > 0) t = std::fmod(std::max(0., t), c.duration);
        const double frame =
                c.duration > 0 ? std::clamp(t / c.duration * double(c.frames - 1), 0., double(c.frames - 1)) : 0;
        const size_t a = size_t(frame), b = std::min(a + 1, c.frames - 1);
        const float f = float(frame - a);
        pose.resize(entry.bones * 12);
        for (size_t i = 0; i < pose.size(); i++) {
            const float x = data[c.offset + a * pose.size() + i], y = data[c.offset + b * pose.size() + i];
            pose[i] = x + (y - x) * f;
        }
        gl.ActiveTexture(GL_TEXTURE0);
        gl.BindTexture(GL_TEXTURE_2D, bonesTexture);
        gl.TexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, 3, entry.bones, 0, GL_RGBA, GL_FLOAT, pose.data());
    }

    void actor_actions(const native_render::Actor &actor, const Look &look, double seconds) {
        auto &state = actorActions[actor.id];
        if (actor.snapped || seconds < state.last || state.knife != look.knife || state.weapon != actor.frame.weapon)
            state = {};
        const double dt = state.last < 0 ? 0 : std::clamp(seconds - state.last, 0., .1);
        state.last = seconds;
        state.knife = look.knife;
        state.weapon = actor.frame.weapon;
        if (actor.attack) state.gesture.cancel();
        if (actor.frame.weapon == 1 && tpInspects.contains(look.knife)) {
            const auto &spec = tpInspects[look.knife];
            if (actor.id == "menu-preview")
                for (unsigned n = 0; n < std::min(actor.inspect, 4u); n++)
                    state.gesture.press(spec["clips"]);
            else
                state.gesture.remote(actor.inspect, spec["clips"]);
            state.gesture.update(dt, actor.inspectHeld, spec);
            native_tp::apply(state.gesture, spec, actorNames, actorParents, actorBind, pose);
        } else
            state.gesture.reset();
        native_render::advance_accessory(
                state.accessory,
                seconds,
                std::hypot(actor.frame.velocity[0], actor.frame.velocity[1]),
                bool(actor.frame.flags & 2),
                actor.snapped
        );
        native_render::advance_ponytail(
                state.ponytail, actor.frame.velocity, actor.frame.yaw, dt, actor.snapped || dt <= 0, look.hairLength
        );
        gl.ActiveTexture(GL_TEXTURE0);
        gl.BindTexture(GL_TEXTURE_2D, bonesTexture);
        gl.TexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, 3, pose.size() / 12, 0, GL_RGBA, GL_FLOAT, pose.data());
        if (actorActions.size() > 256) {
            actorActions.clear();
            actorAnimationStates.clear();
        }
    }

    static void linearColor(uint32_t hex, float *out) {
        for (int k = 0; k < 3; k++) {
            float c = float((hex >> (16 - k * 8)) & 255) / 255;
            out[k] = c <= .04045f ? c / 12.92f : std::pow((c + .055f) / 1.055f, 2.4f);
        }
    }

    struct BindOptions {
        PlayerMaterial material = PlayerMaterial::solid;
        bool detail = false;
        float opacity = 1, mirror = 1;
        std::array<float, 3> offset{};
        const native_render::Glow *glow = nullptr;
        GLuint poseTexture = 0;
    };

    // Uniforms every player program reads, the same for each draw of a frame.
    void bind_shared(const PlayerProgram &p, double seconds) {
        constexpr float sun_direction[3] = {.4196f, .7792f, .4596f}, sun_color[3] = {1, .96f, .9f};
        gl.Uniform1i(p.boneMatrices, 0);
        gl.Uniform1f(p.auraPass, 0);
        gl.Uniform1f(p.auraSize, 1);
        gl.Uniform1f(p.glowTime, float(seconds));
        gl.Uniform1f(p.finTime, float(std::fmod(seconds, 3600.)));
        gl.Uniform1f(p.cosTier, float(cosmeticsTier));
        gl.Uniform1f(p.playerLook, float(playerLookTier));
        gl.Uniform1f(p.fabric, 0);
        // The scene reflections of the Enhanced and Cinematic looks have no native equivalent: metals keep the studio.
        gl.Uniform1f(p.finEnvOn, 0);
        gl.Uniform1f(p.cosEnvOn, 0);
        gl.Uniform1f(p.playerEnvOn, 0);
        gl.Uniform3fv(p.finSunDir, 1, sun_direction);
        gl.Uniform3fv(p.finSunColor, 1, sun_color);
        gl.Uniform1i(p.finEnv, reflection_unit);
        gl.Uniform1i(p.cosEnv, reflection_unit);
        gl.Uniform1i(p.playerEnv, reflection_unit);
        const float noFlash[4] = {1, .72f, .4f, 0}, origin[3] = {};
        gl.Uniform4fv(p.gunFlash, 1, noFlash);
        gl.Uniform3fv(p.gunFlashPos, 1, origin);
        gl.Uniform1f(p.glowDistance, 1);
        gl.Uniform2f(p.glowNearFade, 0, 0);
        gl.Uniform2f(p.nearFade, 0, 0);
    }

    void bind_look(const PlayerProgram &p, const Look &look) {
        gl.Uniform3fv(p.palette, 8, look.palette.data());
        gl.Uniform3fv(p.accent, 1, look.accent.data());
        gl.Uniform3fv(p.glove, 5, look.gloveColors.data());
        gl.Uniform3fv(p.hairColor, 1, look.hairColor.data());
        gl.Uniform3fv(p.headwearScale, 1, look.fit.scale.data());
        gl.Uniform3fv(p.headwearOffset, 1, look.fit.offset.data());
        gl.Uniform3fv(p.headwearFaceScale, 1, look.fit.faceScale.data());
        gl.Uniform3fv(p.headwearFaceOffset, 1, look.fit.faceOffset.data());
        const float ponytail[4] = {0, 0, look.hairLength, 0};
        gl.Uniform4fv(p.ponytail, 1, ponytail);
    }

    void bind_glow(const PlayerProgram &p, const native_render::Glow *glow, float opacity) {
        gl.Uniform1i(p.glowEnabled, showGlow && glow && glow->enabled);
        gl.Uniform1f(p.glowOpacity, opacity);
        if (!glow) return;
        float rgb[3];
        for (int k = 0; k < 3; k++)
            rgb[k] = native_render::srgb_linear(glow->color[k]);
        gl.Uniform3fv(p.glowColor, 1, rgb);
        gl.Uniform1f(p.glowIntensity, glow->intensity);
    }

    const PlayerProgram &
    bind(const Look &look,
         const native::Matrix &projection,
         const native::Matrix &model,
         const float eye[3],
         double seconds,
         const BindOptions &options) {
        gl.ActiveTexture(GL_TEXTURE0 + reflection_unit);
        gl.BindTexture(GL_TEXTURE_CUBE_MAP, reflectionCube);
        gl.ActiveTexture(GL_TEXTURE0);
        gl.BindTexture(GL_TEXTURE_2D, options.poseTexture ? options.poseTexture : bonesTexture);
        const auto &p = program(look, options.material, options.detail);
        gl.UseProgram(p.id);
        const auto webModel = native_render::web_model(model), webView = native_render::web_view(projection);
        const auto camera = native_render::to_web_space(eye);
        gl.UniformMatrix4fv(p.projection, 1, GL_FALSE, projection.data());
        gl.UniformMatrix4fv(p.model, 1, GL_FALSE, model.data());
        gl.UniformMatrix4fv(p.modelMatrix, 1, GL_FALSE, webModel.data());
        gl.UniformMatrix4fv(p.viewMatrix, 1, GL_FALSE, webView.data());
        gl.Uniform3fv(p.cameraPosition, 1, camera.data());
        gl.Uniform3fv(p.offset, 1, options.offset.data());
        gl.Uniform1f(p.mirror, options.mirror);
        gl.Uniform1f(p.opacity, options.opacity);
        bind_shared(p, seconds);
        bind_look(p, look);
        bind_glow(p, options.glow, options.opacity);
        return p;
    }

public:
    explicit NativeViewmodel(Gl &g, const std::filesystem::path &assetRoot = BUNNYHOP_NATIVE_ASSET_ROOT) : gl(g) {
        if (std::filesystem::exists(assetRoot / "actor-animations.json"))
            actorAnimationData = std::make_shared<native_actor_anim::Data>(assetRoot.string());
        std::ifstream file(assetRoot / "viewmodels.json");
        if (!file) throw std::runtime_error("Native asset bundle absent; run native asset compiler");
        file >> metadata;
        if (metadata.at("version") != 3 || metadata.at("stride") != vertex_floats)
            throw std::runtime_error("Unsupported native asset format");
        const size_t bytes = metadata.value("bytes", size_t(0));
        if (bytes) {
            if (bytes > 768 * 1024 * 1024 || bytes % 4) throw std::runtime_error("Invalid native asset length");
            std::ifstream binary(assetRoot / "viewmodels.bin.z", std::ios::binary);
            std::vector<uint8_t> compressed(std::istreambuf_iterator<char>(binary), {});
            data.resize(bytes / 4);
            uLongf count = bytes;
            if (uncompress(reinterpret_cast<Bytef *>(data.data()), &count, compressed.data(), compressed.size()) != Z_OK
                || count != bytes)
                throw std::runtime_error("Invalid compressed native assets");
        } else {
            std::ifstream binary(assetRoot / "viewmodels.bin", std::ios::binary | std::ios::ate);
            const auto n = binary.tellg();
            if (!binary || n < 0 || n > 768 * 1024 * 1024 || n % 4) throw std::runtime_error("Invalid native assets");
            data.resize(size_t(n) / 4);
            binary.seekg(0);
            binary.read(reinterpret_cast<char *>(data.data()), n);
            if (!binary) throw std::runtime_error("Truncated native assets");
        }
        {
            std::ifstream tracks(assetRoot / "tp-inspects.json");
            if (!tracks) throw std::runtime_error("Native inspect tracks absent; run native asset compiler");
            nlohmann::json raw;
            tracks >> raw;
            if (raw.at("version") != 1) throw std::runtime_error("Invalid inspect tracks");
            tpInspects = raw.at("knives");
        }
        weapons = metadata.at("weapons").get<std::vector<std::string>>();
        if (metadata.contains("actorRig")) {
            const auto &rig = metadata["actorRig"];
            actorNames = rig["names"].get<std::vector<std::string>>();
            actorParents = rig["parent"].get<std::vector<int>>();
            actorBind = rig["bind"].get<std::vector<float>>();
            if (actorParents.size() != actorNames.size() || actorBind.size() != actorNames.size() * 12)
                throw std::runtime_error("Invalid actor rig metadata");
            for (size_t i = 0; i < actorParents.size(); i++)
                if (actorParents[i] >= int(i)) throw std::runtime_error("Invalid actor rig hierarchy");
        }
        for (const auto &[name, raw] : metadata.at("meshes").items()) {
            Mesh m;
            m.vertices = raw.at("vertices");
            m.offset = size_t(raw.at("offset")) / 4;
            m.glowOffset = raw.at("glowOffset").get<size_t>() / 4;
            m.indices = raw.value("indices", size_t(0));
            m.indexOffset = raw.value("indexOffset", size_t(0)) / 4;
            if (m.glowOffset + m.vertices * 3 > data.size() || !m.vertices || m.vertices > 4000000
                || m.offset + m.vertices * vertex_floats > data.size() || m.indexOffset + m.indices > data.size())
                throw std::runtime_error("Invalid native mesh range");
            meshes.emplace(name, m);
        }
        for (const auto &[name, raw] : metadata.at("entries").items()) {
            Entry e;
            e.bones = raw.at("bones");
            e.meshes = raw.at("meshes").get<std::vector<std::string>>();
            if (!e.bones || e.bones > 256) throw std::runtime_error("Invalid native rig");
            for (const auto &c : raw.at("clips")) {
                Clip t{c.at("name"), c.at("duration"), c.at("frames"), size_t(c.at("offset")) / 4};
                if (!t.frames || t.frames > 1024 || !std::isfinite(t.duration) || t.duration < 0
                    || t.offset + t.frames * e.bones * 12 > data.size())
                    throw std::runtime_error("Invalid native pose range");
                e.clips.push_back(t);
            }
            entries.emplace(name, std::move(e));
        }

        shaders = std::make_unique<native_render::PlayerShaderSources>(assetRoot);
        gl.GenTextures(1, &reflectionCube);
        gl.BindTexture(GL_TEXTURE_CUBE_MAP, reflectionCube);
        const uint8_t black[4] = {0, 0, 0, 255};
        for (GLenum face = 0; face < 6; ++face)
            gl.TexImage2D(
                    GL_TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, GL_RGBA8, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, black
            );
        gl.TexParameteri(GL_TEXTURE_CUBE_MAP, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_CUBE_MAP, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        gunFx = std::make_unique<NativePresentation>(gl);
        gl.GenTextures(1, &bonesTexture);
        gl.BindTexture(GL_TEXTURE_2D, bonesTexture);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        // Floor weapons share a rigid identity pose. Keep it separate from the mutable animated rig
        // so drawing each weapon does not redefine a texture still in use by earlier draws.
        const float identity[12] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0};
        gl.GenTextures(1, &identityBonesTexture);
        gl.BindTexture(GL_TEXTURE_2D, identityBonesTexture);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        gl.TexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, 3, 1, 0, GL_RGBA, GL_FLOAT, identity);
        gl.BindTexture(GL_TEXTURE_2D, bonesTexture);
        pose.reserve(256 * 12);
        basePose.reserve(256 * 12);
        equipped = look("outfit-cream", "");
        program(equipped, PlayerMaterial::solid);
        std::cout << "Native models: " << meshes.size() << " original meshes, " << entries.size()
                  << " pose sets, GPU skinning/cosmetics\n";
    }

    ~NativeViewmodel() {
        gunFx.reset();
        for (auto &[name, m] : meshes) {
            if (m.glowVbo) gl.DeleteBuffers(1, &m.glowVbo);
            if (m.ebo) gl.DeleteBuffers(1, &m.ebo);
            if (m.vbo) gl.DeleteBuffers(1, &m.vbo);
            if (m.vao) gl.DeleteVertexArrays(1, &m.vao);
        }
        for (const auto &[key, p] : programs)
            gl.DeleteProgram(p.id);
        if (reflectionCube) gl.DeleteTextures(1, &reflectionCube);
        if (bonesTexture) gl.DeleteTextures(1, &bonesTexture);
        if (identityBonesTexture) gl.DeleteTextures(1, &identityBonesTexture);
    }

    std::array<std::array<float, 3>, 2> cosmetic_colors(const std::string &id) const {
        std::array<std::array<float, 3>, 2> out{{{1, .761f, .239f}, {1, .761f, .239f}}};
        if (!metadata.contains("ghostColors") || !metadata["ghostColors"].contains(id)) return out;
        const auto &colors = metadata["ghostColors"][id];
        for (int i = 0; i < 2; i++)
            try {
                const std::string text = colors[i];
                if (text.size() == 7 && text[0] == '#') {
                    const auto hex = std::stoul(text.substr(1), nullptr, 16);
                    for (int k = 0; k < 3; k++)
                        out[i][k] = float((hex >> (16 - 8 * k)) & 255) / 255;
                }
            } catch (...) {
            }
        return out;
    }

    // Persisted retired model choices always resolve to the equipped bunny.
    void actor_models(const std::string &, const std::string &) {}

    void ghost_cosmetics(const std::string &id) {
        const auto colors = cosmetic_colors(id);
        auto toLinear = [](float c) {
            return c <= .04045f ? c / 12.92f : std::pow((c + .055f) / 1.055f, 2.4f);
        };
        for (int k = 0; k < 3; k++) {
            ghostColor[k] = toLinear(colors[0][k]);
            ghostRim[k] = toLinear(colors[1][k]);
        }
    }

    void trail_cosmetics(const std::string &id) {
        previewTrailVisible = id != "trail-none";
        previewTrail = cosmetic_colors(id);
    }

    void player_glow(std::optional<native_render::Glow> value) { localGlow = std::move(value); }

    void glow_visibility(bool show, bool firstPerson) {
        showGlow = show;
        firstPersonGlow = firstPerson;
    }

    void cosmetics(const std::string &outfit, const std::string &packed) {
        equipped = look(outfit, packed);
        previewLoadout = packed;
    }

    void set_sway(float value) {
        if (std::isfinite(value)) swayScale = std::clamp(value, 0.f, 2.f);
    }

    void view_angles(float yaw, float pitch) {
        if (viewInitialized) {
            float dy = std::remainder(yaw - previousYaw, 360.f);
            swayYaw = std::clamp(swayYaw * .72f + dy * .025f, -.45f, .45f);
            swayPitch = std::clamp(swayPitch * .72f + (pitch - previousPitch) * .025f, -.45f, .45f);
        }
        previousYaw = yaw;
        previousPitch = pitch;
        viewInitialized = true;
    }

    void set_bob(float value) {
        if (std::isfinite(value)) bobScale = std::clamp(value, 0.f, 2.f);
    }

    void settings(float field, float x, float y, float z, bool left) {
        if (!std::isfinite(field) || !std::isfinite(x) || !std::isfinite(y) || !std::isfinite(z)) return;
        fov = std::clamp(field, 30.f, 100.f);
        offsetX = std::clamp(x, -10.f, 10.f);
        offsetY = std::clamp(y, -10.f, 10.f);
        offsetZ = std::clamp(z, -10.f, 10.f);
        leftHand = left;
    }

    void reset_presentation() {
        gunFlashStarted = -100;
        actorActions.clear();
        actorAnimationStates.clear();
        viewInitialized = false;
        swayYaw = swayPitch = 0;
        previousWeapon = 0;
        previousTick = ~0u;
        previousEntry.clear();
        action = "idle";
        started = 0;
        inspectIndex = -1;
        inspectQueued = inspectHeld = false;
        inspectPresses = inspectLoops = 0;
    }

    void inspect_press() { inspectPresses = std::min(inspectPresses + 1, 4u); }

    void inspect_held(bool held) { inspectHeld = held; }

    void draw_preview(
            int width,
            int height,
            const std::string &kind,
            double seconds = 2,
            uint32_t weapon = 1,
            const std::string &previewAction = "idle",
            float previewSpeed = 0
    ) {
        if (kind == "actor" || kind == "hat" || kind == "ghost") {
            native_render::Actor actor;
            actor.id = "asset-preview";
            actor.opacity = kind == "ghost" ? .55f : 1.f;
            actor.source = kind == "ghost" ? native_render::GhostSource::pb : native_render::GhostSource::none;
            actor.playerGlow = localGlow;
            actor.frame.velocity[0] = previewSpeed;
            actor.outfit = equipped.outfit;
            actor.loadout = previewLoadout;
            actor.frame.flags = 2;
            actor.frame.weapon = weapon;
            actor.inspect = previewAction == "inspect" && seconds == 0 ? 1 : 0;
            actor.attack = previewAction == "fire" && seconds == 0 ? 1 : 0;
            actor.frame.view_offset_z = 64;
            const float eye[3] = {
                    kind == "hat" ? 35.f : 105.f, kind == "hat" ? -52.f : -160.f, kind == "hat" ? 87.f : 82.f
            };
            const auto vp = native::camera_matrix(eye, 120, 9, float(width) / height);
            draw_actor(actor, vp, eye, seconds);
        } else {
            BhSnapshot state{};
            state.player.tick = 1;
            draw(width, height, state, weapon, 0, false, 0, 0);
            action = previewAction;
            started = 0;
            gl.Clear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
            state.player.tick = 2;
            draw(width, height, state, weapon, 0, false, 0, seconds);
        }
    }

    // Dedicated menu instance only: real mesh rotation and the gameplay inspect chain.
    void draw_menu_preview(
            int width,
            int height,
            const std::string &kind,
            double seconds,
            float yaw,
            float pitch,
            unsigned presses,
            bool held
    ) {
        previewYaw = std::remainder(yaw, 360.f);
        previewPitch = std::clamp(pitch, -45.f, 45.f);
        if (kind == "bunny" || kind == "ghost") {
            native_render::Actor actor;
            actor.id = "menu-preview";
            actor.opacity = kind == "ghost" ? .55f : 1.f;
            actor.source = kind == "ghost" ? native_render::GhostSource::pb : native_render::GhostSource::none;
            actor.playerGlow = localGlow;
            actor.outfit = equipped.outfit;
            actor.loadout = previewLoadout;
            actor.frame.flags = 2;
            actor.frame.weapon = 1;
            actor.frame.view_offset_z = 64;
            actor.frame.yaw = previewYaw;
            actor.frame.pitch = previewPitch;
            actor.inspect = presses;
            actor.inspectHeld = held;
            const float eye[3] = {65.f, -100.f, 74.f};
            const auto projection = native::camera_matrix(eye, 120, 9, float(width) / height);
            draw_actor(actor, projection, eye, seconds);
            gunFx->clear();
            constexpr unsigned segments = 64;
            constexpr float radius = 28;
            for (unsigned segment = 0; segment < segments; ++segment) {
                const float from = float(segment) * float(native::radians) * 360 / segments;
                const float to = float(segment + 1) * float(native::radians) * 360 / segments;
                const native_render::Vec3 a = {std::cos(from) * radius, std::sin(from) * radius, .5f};
                const native_render::Vec3 b = {std::cos(to) * radius, std::sin(to) * radius, .5f};
                gunFx->ribbon(a, b, .6f, {.55f, .6f, .7f, .3f}, eye);
                if (kind == "ghost" && previewTrailVisible && segment < 48) {
                    const float fraction = float(segment) / 48;
                    auto head = a, tail = b;
                    head[2] = tail[2] = 6;
                    const auto color = native_render::trail_color(previewTrail, fraction, .55f, 200);
                    gunFx->ribbon(head, tail, 2.5f * (.15f + .85f * fraction), color, eye);
                }
            }
            gunFx->draw(projection, eye);
        } else {
            settings(kind == "close" ? 50.f : 65.f, -4.f, 1.5f, 0.f, false);
            for (unsigned n = 0; n < std::min(presses, 4u); n++)
                inspect_press();
            inspect_held(held);
            BhSnapshot state{};
            state.player.tick = uint32_t(seconds * 60) + 1;
            draw(width, height, state, 1, 0, false, 0, seconds);
        }
        previewYaw = previewPitch = 0;
    }

    void draw_onboarding_preview(int width, int height, const nlohmann::json &stage, double seconds, unsigned signal) {
        native_render::Actor actor;
        actor.id = "onboarding";
        actor.opacity = 1;
        actor.outfit = equipped.outfit;
        actor.loadout = previewLoadout;
        actor.frame.weapon = 1;
        actor.frame.view_offset_z = 64;
        actor.frame.flags = (stage.value("crouched", false) ? 1u : 0u) | (stage.value("grounded", true) ? 2u : 0u);
        actor.jumped = stage.value("jumped", false);
        actor.inspect = signal;
        const auto position = stage.at("position").get<std::array<float, 3>>(),
                   velocity = stage.at("velocity").get<std::array<float, 3>>();
        std::copy(position.begin(), position.end(), actor.frame.position);
        std::copy(velocity.begin(), velocity.end(), actor.frame.velocity);
        actor.frame.yaw = stage.value("yaw", -58.f);
        actor.frame.pitch = stage.value("pitch", 4.f);
        native_actor_anim::Acting acting;
        const auto &a = stage.at("acting");
        acting.chestPitch = a.value("chestPitch", 0.);
        acting.chestYaw = a.value("chestYaw", 0.);
        acting.chestRoll = a.value("chestRoll", 0.);
        acting.headPitch = a.value("headPitch", 0.);
        acting.headYaw = a.value("headYaw", 0.);
        acting.headRoll = a.value("headRoll", 0.);
        acting.earL = a.value("earL", 0.);
        acting.earR = a.value("earR", 0.);
        // Same 28-degree camera and framing as the web intro. Hor+ scaling preserves the vertical field.
        const float aspect = float(width) / height, zoom = std::max(1.f, .8f / aspect),
                    eye[3] = {79 * zoom, -295 * zoom, 122 * zoom};
        const float pitch = float(std::atan2(eye[2] - 68, std::hypot(eye[0], eye[1])) / native::radians);
        auto projection = native::camera_matrix(eye, std::atan2(295., -79.) / native::radians, pitch, aspect);
        const float scale = (1.f / std::tan(14.f * float(native::radians))) / (4.f / 3.f);
        for (int c = 0; c < 4; c++) {
            projection[c * 4] *= scale;
            projection[c * 4 + 1] *= scale;
        }
        draw_actor(actor, projection, eye, seconds, &acting, stage.value("squash", 0.f), stage.value("spin", 0.f));
    }

    void draw_floor(const BhFloorWeapon &weapon, const native::Matrix &projection, const float eye[3], double seconds) {
        if (!weapon.weapon || weapon.weapon >= weapons.size() || weapons[weapon.weapon].empty()
            || weapons[weapon.weapon] == "knife")
            return;
        BhTransform t{};
        std::copy(weapon.position, weapon.position + 3, t.origin);
        std::copy(weapon.angles, weapon.angles + 3, t.angles);
        const auto &plain = look("outfit-cream", "");
        BindOptions options;
        options.material = PlayerMaterial::world_gun;
        options.poseTexture = identityBonesTexture;
        bind(plain, projection, native::model_matrix(t), eye, seconds, options);
        gl.Enable(GL_DEPTH_TEST);
        gl.DepthMask(GL_TRUE);
        gl.Disable(GL_BLEND);
        gl.Disable(GL_CULL_FACE);
        mesh("worldgun:" + weapons[weapon.weapon]);
        gl.ActiveTexture(GL_TEXTURE0);
        gl.BindTexture(GL_TEXTURE_2D, bonesTexture);
    }

    // The website's ghost near fade (player/materials.ts nearFade): hidden within 14 units of the camera, measured to
    // the body's feet-to-head axis, fully shown from 64.
    void ghost_uniforms(const PlayerProgram &p, const native_render::Actor &actor, native_render::GhostSource source) {
        constexpr float hidden_units = 14, shown_units = 64, body_height_units = 64;
        const auto color = source == native_render::GhostSource::pb
                                   ? ghostColor
                                   : native_render::linear_color(native_render::ghost_source_color(source));
        const auto rim = source == native_render::GhostSource::pb ? ghostRim : color;
        gl.Uniform3fv(p.ghost, 1, color.data());
        gl.Uniform3fv(p.ghostRim, 1, rim.data());
        const auto &position = actor.frame.position;
        const float top[3] = {position[0], position[1], position[2] + body_height_units};
        const auto feet = native_render::to_web_space(position), head = native_render::to_web_space(top);
        gl.Uniform3fv(p.axisA, 1, feet.data());
        gl.Uniform3fv(p.axisB, 1, head.data());
        if (actor.near_fade)
            gl.Uniform2f(p.nearFade, hidden_units, shown_units);
        else
            gl.Uniform2f(p.nearFade, 0, 0);
    }

    static native_render::GhostSource ghost_source_of(const native_render::Actor &actor) {
        const bool ghostId = actor.id == "replay" || actor.id.starts_with("ghost-");
        return actor.source == native_render::GhostSource::none && ghostId ? native_render::GhostSource::custom
                                                                           : actor.source;
    }

    void draw_actor(
            const native_render::Actor &actor,
            const native::Matrix &projection,
            const float eye[3],
            double seconds,
            const native_actor_anim::Acting *acting = nullptr,
            float squash = 0,
            float spin = 0
    ) {
        const float actorYaw = pose_actor(actor, seconds, acting);
        if (std::isfinite(actorYaw)) draw_posed_actor(actor, projection, eye, seconds, actorYaw, squash, spin);
    }

    // Avatar pictures (avatar_stage.hpp): what a posed actor is made of, for framing it.
    static constexpr size_t vertex_floats = 22;

    std::span<const std::string> actor_parts(const native_render::Actor &actor) {
        return parts_for(actor, look(actor.outfit, actor.loadout));
    }

    // A mesh's vertices, `vertex_floats` each: position, normal, colour, then four bone ids. Empty when absent.
    std::span<const float> mesh_vertices(const std::string &name) const {
        const auto at = meshes.find(name);
        if (at == meshes.end()) return {};
        return {data.data() + at->second.offset, at->second.vertices * vertex_floats};
    }

    native_render::HatFit actor_hat_fit(const native_render::Actor &actor) {
        const auto &l = look(actor.outfit, actor.loadout);
        return native_render::hat_fit(l.outfit, l.hat);
    }

    const std::vector<float> &actor_pose() const { return pose; }

    void upload_actor_pose(const std::vector<float> &bones) {
        pose = bones;
        gl.ActiveTexture(GL_TEXTURE0);
        gl.BindTexture(GL_TEXTURE_2D, bonesTexture);
        gl.TexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, 3, GLsizei(pose.size() / 12), 0, GL_RGBA, GL_FLOAT, pose.data());
    }

    int actor_bone(const std::string &name) const {
        const auto at = std::find(actorNames.begin(), actorNames.end(), name);
        return at == actorNames.end() ? -1 : int(at - actorNames.begin());
    }

    std::span<const float> actor_bind() const { return actorBind; }

    // Drops an actor's animation and gesture state, so its next pose starts from scratch.
    void forget_actor(const std::string &id) {
        actorAnimationStates.erase(id);
        actorActions.erase(id);
    }

    // The weapon slot that holds gun `id` ("usp", "awp"), or 0.
    uint32_t gun_slot(const std::string &id) const {
        for (size_t slot = 2; slot < weapons.size(); ++slot)
            if (weapons[slot] == id) return uint32_t(slot);
        return 0;
    }

    // Poses `actor` at `seconds` and uploads its bones without drawing it (avatar_stage.hpp steps a pose this way).
    // Returns the feet's yaw, or NaN when the actor can't be drawn.
    float
    pose_actor(const native_render::Actor &actor, double seconds, const native_actor_anim::Acting *acting = nullptr) {
        constexpr float not_posed = std::numeric_limits<float>::quiet_NaN();
        if (!std::isfinite(actor.opacity) || actor.opacity <= 0) return not_posed;
        for (float v : actor.frame.position)
            if (!std::isfinite(v)) return not_posed;
        for (float v : actor.frame.velocity)
            if (!std::isfinite(v)) return not_posed;
        if (!std::isfinite(actor.frame.yaw) || !std::isfinite(actor.frame.pitch)) return not_posed;
        const auto &l = look(actor.outfit, actor.loadout);
        const auto &frame = actor.frame;
        float actorYaw = frame.yaw;
        {
            const auto &entry = entries.at("bunny");
            const float speed = std::hypot(frame.velocity[0], frame.velocity[1]);
            const std::string gait = frame.flags & 1      ? "crouch"
                                     : !(frame.flags & 2) ? (frame.velocity[2] > 0 ? "air" : "fall")
                                     : speed > 5          ? "run"
                                                          : "idle";
            const double phase = seconds * (gait == "run" ? std::clamp(speed / 250.f, .1f, 3.f) : 1);
            const auto *c = clip(entry, gait + ":0");
            if (!c) return not_posed;
            sample(entry, *c, phase, true);
            if (std::isfinite(frame.pitch) && std::abs(frame.pitch) > .01) {
                basePose = pose;
                const auto *tilt = clip(entry, gait + (frame.pitch < 0 ? ":-60" : ":60"));
                sample(entry, *tilt, phase, true);
                const float amount = std::min(std::abs(frame.pitch) / 60.f, 1.f);
                for (size_t i = 0; i < pose.size(); i++)
                    pose[i] = basePose[i] + (pose[i] - basePose[i]) * amount;
                gl.TexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, 3, entry.bones, 0, GL_RGBA, GL_FLOAT, pose.data());
            }
            if (actorAnimationData) {
                auto &state = actorAnimationStates[actor.id];
                if (!state) state = std::make_unique<native_actor_anim::State>(*actorAnimationData);
                native_actor_anim::Input input;
                std::copy(frame.position, frame.position + 3, input.position.begin());
                std::copy(frame.velocity, frame.velocity + 3, input.velocity.begin());
                input.yaw = frame.yaw;
                input.pitch = frame.pitch;
                input.ducking = bool(frame.flags & 1);
                input.grounded = bool(frame.flags & 2);
                input.jumped = actor.jumped;
                state->hood(l.hoodDown);
                state->pose(input, seconds, actor.snapped, actor.attack != 0, pose, acting);
                actorYaw = float(state->feetYaw);
            }
            actor_actions(actor, l, seconds);
        }
        return actorYaw;
    }

    // Draws `actor` in the pose the last pose_actor call uploaded.
    void draw_posed_actor(
            const native_render::Actor &actor,
            const native::Matrix &projection,
            const float eye[3],
            double seconds,
            float actorYaw,
            float squash = 0,
            float spin = 0
    ) {
        const auto &l = look(actor.outfit, actor.loadout);
        const auto &frame = actor.frame;
        BhTransform t{};
        std::copy(frame.position, frame.position + 3, t.origin);
        t.angles[1] = actorYaw + spin;
        auto model = native::model_matrix(t);
        for (int r = 0; r < 3; r++) {
            model[r] *= 1 - squash * .5f;
            model[4 + r] *= 1 - squash * .5f;
            model[8 + r] *= 1 + squash;
        }
        const auto source = ghost_source_of(actor);
        BindOptions options;
        options.material = source == native_render::GhostSource::none ? PlayerMaterial::solid : PlayerMaterial::ghost;
        options.opacity = std::clamp(actor.opacity, 0.f, 1.f);
        options.glow = actor.playerGlow ? &*actor.playerGlow : nullptr;
        const auto &actorProgram = bind(l, projection, model, eye, seconds, options);
        const auto &motion = actorActions[actor.id].accessory;
        const float capy[4] = {motion.alert, motion.squash, motion.lean, float(seconds)};
        gl.Uniform4fv(actorProgram.capybara, 1, capy);
        gl.Uniform1f(actorProgram.propellerAngle, float(motion.angle));
        const auto &tail = actorActions[actor.id].ponytail;
        const float ponytail[4] = {float(tail.pitch), float(tail.side), l.hairLength, 0};
        gl.Uniform4fv(actorProgram.ponytail, 1, ponytail);
        if (source != native_render::GhostSource::none) ghost_uniforms(actorProgram, actor, source);
        const auto visibleParts = parts_for(actor, l);
        gl.Enable(GL_DEPTH_TEST);
        gl.Disable(GL_CULL_FACE);
        gl.DepthFunc(GL_LEQUAL);
        if (showGlow && actor.playerGlow && actor.playerGlow->enabled && actor.opacity >= .999f) {
            const float distance = std::hypot(
                    std::hypot(eye[0] - frame.position[0], eye[1] - frame.position[1]), eye[2] - frame.position[2]
            );
            gl.Uniform2f(actorProgram.glowNearFade, 14, 60);
            gl.Uniform1f(actorProgram.glowDistance, native_render::glow_distance(distance));
            const float top[3] = {frame.position[0], frame.position[1], frame.position[2] + 64};
            const auto feet = native_render::to_web_space(frame.position), head = native_render::to_web_space(top);
            gl.Uniform3fv(actorProgram.glowAxisA, 1, feet.data());
            gl.Uniform3fv(actorProgram.glowAxisB, 1, head.data());
            draw_glow(visibleParts, actorProgram, actor.playerGlow->aura && distance < 650, 1);
        }
        if (actor.opacity < 1) {
            gl.ColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_FALSE);
            gl.Disable(GL_BLEND);
            gl.DepthMask(GL_TRUE);
            for (const auto &part : visibleParts)
                mesh(part);
            gl.ColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
            gl.Enable(GL_BLEND);
            gl.BlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
            gl.DepthMask(GL_FALSE);
        } else {
            gl.Disable(GL_BLEND);
            gl.DepthMask(GL_TRUE);
        }
        for (const auto &part : visibleParts)
            mesh(part);
        gl.DepthMask(GL_TRUE);
        gl.Disable(GL_BLEND);
    }

    void
    draw(int width,
         int height,
         const BhSnapshot &snapshot,
         uint32_t active,
         uint32_t flags,
         bool shot,
         uint32_t mode,
         double seconds,
         const BhWeaponReport *report = nullptr,
         bool presentationEvent = false) {
        if (active >= weapons.size() || !active) return;
        const auto name = active == 1 ? "knife:" + equipped.knife + ":" + equipped.glove
                                      : "gun:" + weapons[active] + ":" + equipped.glove;
        const auto at = entries.find(name);
        if (at == entries.end()) return;
        const auto &entry = at->second;
        if (active != previousWeapon || previousEntry != name) {
            action = "draw";
            started = seconds;
            previousWeapon = active;
            previousEntry = name;
            inspectIndex = -1;
            inspectQueued = false;
        }
        const bool shellGun = std::any_of(entry.clips.begin(), entry.clips.end(), [](const Clip &c) {
            return c.name == "shellStart";
        });
        if (report) gunSilenced = report->silencer != 0;
        if (snapshot.player.tick != previousTick || presentationEvent) {
            if (active > 1 && report && (flags & 256)) {
                action = gunSilenced ? "silencerOn" : "silencerOff";
                started = seconds;
            } else if (shot) {
                if (active > 1) gunFlashStarted = seconds;
                inspectIndex = -1;
                inspectQueued = false;
                action = active == 1 ? (mode == 2 ? "stab" : snapshot.player.tick % 2 ? "slash1" : "slash2") : "fire";
                started = seconds;
            } else if (flags & 4) {
                inspectIndex = -1;
                inspectQueued = false;
                action = shellGun ? "shellStart" : report && report->clip == 0 ? "reloadEmpty" : "reload";
                started = seconds;
            } else if (active > 1 && shellGun && report) {
                if (flags & 8) {
                    action = "shellEnd";
                    started = seconds;
                } else if (report->reload_ticks && report->clip > previousClip) {
                    action = "shellInsert";
                    started = seconds;
                }
            }
            if (report) previousClip = report->clip;
            previousTick = snapshot.player.tick;
        }
        if (active == 1) {
            const auto &chain = metadata.at("inspects").at(equipped.knife);
            if (inspectPresses) {
                if (inspectIndex < 0) {
                    inspectIndex = 0;
                    action = "inspect0";
                    started = seconds;
                    inspectLoops = 0;
                } else if (size_t(inspectIndex + 1) < chain.size())
                    inspectQueued = true;
                inspectPresses = 0;
            }
            if (inspectIndex >= 0) {
                const auto &spec = chain.at(inspectIndex);
                double t = std::max(0., seconds - started);
                if (inspectHeld && !inspectQueued && spec.contains("loop") && !spec["loop"].is_null()
                    && inspectLoops < 6) {
                    const double from = spec["loop"][0], to = spec["loop"][1];
                    if (t >= to && to > from) {
                        started += to - from;
                        t -= to - from;
                        inspectLoops++;
                    }
                }
                if (inspectQueued && t >= spec.at("exit").get<double>() && size_t(inspectIndex + 1) < chain.size()) {
                    inspectIndex++;
                    action = "inspect" + std::to_string(inspectIndex);
                    started = seconds - chain.at(inspectIndex).at("enter").get<double>();
                    inspectLoops = 0;
                    inspectQueued = false;
                } else if (t >= spec.at("duration").get<double>()) {
                    inspectIndex = -1;
                    inspectQueued = false;
                    action = "idle";
                    started = seconds;
                }
            }
        } else {
            inspectIndex = -1;
            if (inspectPresses) {
                action = "inspect";
                started = seconds;
            }
            inspectPresses = 0;
        }
        std::string clipName = action;
        if (active > 1 && gunSilenced) {
            const auto named = action + ":silenced";
            if (std::any_of(entry.clips.begin(), entry.clips.end(), [&](const Clip &c) { return c.name == named; }))
                clipName = named;
        }
        const Clip *c = clip(entry, clipName);
        if (!c) return;
        double time = std::max(0., seconds - started);
        if (c->duration > 0 && time >= c->duration) {
            action = shellGun && report && report->reload_ticks && (action == "shellStart" || action == "shellInsert")
                             ? "shellInsert"
                             : "idle";
            started = seconds;
            c = clip(entry, action + (gunSilenced ? ":silenced" : ""));
            time = 0;
        }
        sample(entry, *c, time, false);
        gl.Clear(GL_DEPTH_BUFFER_BIT);
        gl.Enable(GL_DEPTH_TEST);
        gl.DepthMask(GL_TRUE);
        gl.Disable(GL_BLEND);
        gl.Disable(GL_CULL_FACE);
        const float cot = (4.f / 3.f) / std::tan(float(fov * native::radians * .5));
        const native::Matrix
                perspective =
                        {cot / (float(width) / height), 0, 0, 0, 0, cot, 0, 0, 0, 0, -1.00376f, -1, 0, 0, -1.50282f, 0},
                sourceView = {0, 0, -1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1};
        const float speed = std::hypot(snapshot.player.velocity[0], snapshot.player.velocity[1]),
                    bob = std::min(speed / 350.f, 1.f) * bobScale;
        const float offset[3] =
                {offsetY,
                 -offsetX + swayYaw * swayScale + float(std::sin(seconds * 7)) * .15f * bob,
                 offsetZ + swayPitch * swayScale + float(std::abs(std::sin(seconds * 7))) * .28f * bob},
                    eye[3] = {};
        BhTransform turn{};
        turn.angles[1] = previewYaw;
        turn.angles[0] = previewPitch;
        BindOptions options;
        options.material = active == 1 ? PlayerMaterial::solid : PlayerMaterial::gun;
        // First-person detail shading (finishes/detail.ts VM_DETAIL), as the website's viewmodels compile.
        options.detail = true;
        options.offset = {offset[0], offset[1], offset[2]};
        options.mirror = leftHand ? -1.f : 1.f;
        options.glow = firstPersonGlow && localGlow ? &*localGlow : nullptr;
        const auto &handsProgram = bind(
                equipped, native::multiply(perspective, sourceView), native::model_matrix(turn), eye, seconds, options
        );
        gl.FrontFace(leftHand ? GL_CW : GL_CCW);
        for (const auto &part : entry.meshes)
            mesh(part);
        if (showGlow && firstPersonGlow && localGlow && localGlow->enabled) {
            draw_glow(entry.meshes, handsProgram, localGlow->aura, .2f);
        }
        gl.FrontFace(GL_CCW);
        const double flashAge = seconds - gunFlashStarted;
        if (active > 1 && flashAge >= 0 && flashAge < .055 && metadata.contains("gunMuzzles")
            && metadata["gunMuzzles"].contains(weapons[active])) {
            const auto &info = metadata["gunMuzzles"][weapons[active]];
            const bool quiet = gunSilenced && info.contains("silPoint");
            const auto &point = info[quiet ? "silPoint" : "point"];
            const size_t bone = size_t(info[quiet ? "silPart" : "part"].get<unsigned>()) * 12;
            if (bone + 11 < pose.size()) {
                native_render::Vec3 muzzle{};
                for (int r = 0; r < 3; r++)
                    muzzle[r] = pose[bone + r * 4] * point[0].get<float>()
                                + pose[bone + r * 4 + 1] * point[1].get<float>()
                                + pose[bone + r * 4 + 2] * point[2].get<float>() + pose[bone + r * 4 + 3] + offset[r];
                muzzle[1] *= leftHand ? -1.f : 1.f;
                gunFx->clear();
                gunFx->billboard(
                        muzzle,
                        quiet ? 1.2f : 2.2f,
                        quiet ? std::array<float, 4>{.6f, .65f, .7f, float(1 - flashAge / .055) * .25f}
                              : std::array<float, 4>{1, .64f, .15f, float(1 - flashAge / .055) * .95f},
                        {0, 1, 0},
                        {0, 0, 1}
                );
                gunFx->draw(native::multiply(perspective, sourceView), eye);
            }
        }
    }
};
