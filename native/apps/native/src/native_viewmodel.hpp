#pragma once
#include "actor_anim.hpp"
#include "tp_inspect.hpp"
#include "gun_hold.hpp"
#include "third_person_events.hpp"
#include <span>
#ifndef BUNNYHOP_NATIVE_ASSET_ROOT
#define BUNNYHOP_NATIVE_ASSET_ROOT "target/native-assets"
#endif
// Original meshes/pose clips and cosmetic shader recipes are compiled to data at build time.
// Animation and poses stay on the CPU; NativeViewmodelGpu owns the rendering resources.
#include "native_viewmodel_gpu.hpp"

class NativeViewmodel : private NativeViewmodelGpu {
    struct Clip {
        std::string name;
        double duration = 0;
        size_t frames = 0, offset = 0;
    };

    struct Entry {
        size_t bones = 0;
        std::vector<std::string> meshes;
        std::vector<const Mesh *> drawMeshes;
        std::vector<Clip> clips;
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
    std::unordered_map<std::string, Entry> entries;
    std::vector<std::string> weapons;
    std::vector<const Mesh *> floorMeshes;
    std::vector<float> pose;
    nlohmann::json metadata;
    native_render::KnifeSpinner spinner;
    std::unordered_map<std::string, std::vector<native_render::InspectTrickCues>> inspectCueTimes;
    native_render::InspectCueQueue inspectCueQueue;
    int cueTrick = -1;
    double cueTime = 0;
    std::optional<native_render::Glow> localGlow;
    bool firstPersonGlow = true;
    Look equipped;
    std::string previewLoadout;
    std::array<float, 3> ghostColor{1, .54f, .047f}, ghostRim{1, .54f, .047f};

    struct ActorParts {
        std::string id, outfit, loadout;
        uint32_t weapon = 0;
        bool silenced = false, emptyHand = false, used = false;
        std::array<std::string, 5> names;
        std::array<const Mesh *, 5> drawMeshes{};
        size_t count = 0;
    };

    std::array<ActorParts, 68> actorParts;
    size_t nextActorParts = 0;

    void resolve_parts(ActorParts &parts) {
        for (size_t i = 0; i < parts.count; ++i) {
            const auto at = meshes.find(parts.names[i]);
            parts.drawMeshes[i] = at == meshes.end() ? nullptr : &at->second;
        }
    }

    const ActorParts &parts_for(const native_render::Actor &actor, const Look &look) {
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
            return *parts;
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
        if (actor.emptyHand) {
            resolve_parts(*parts);
            return *parts;
        }
        parts->names[parts->count++] = gun.empty() || gun == "knife" ? "tpknife:" + look.knife : "tpgun:" + gun;
        if (actor.silenced && !gun.empty() && gun != "knife") parts->names[parts->count++] = "tpsilencer:" + gun;
        resolve_parts(*parts);
        return *parts;
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

    // The two-handed third-person gun hold (gun_hold.hpp): per gun data, and per actor its pose state and where its
    // muzzle was last drawn (world space), for the flash and tracer of its next shot.
    struct ActorHold {
        std::unique_ptr<native_gun::GunHold> hold;
        std::optional<std::array<float, 3>> muzzle;
        uint32_t noise = 0x9e3779b9u;
    };

    std::unordered_map<std::string, native_gun::GunHoldData> gunHolds;
    std::optional<native_gun::Rig> gunRig;
    std::unordered_map<std::string, ActorHold> actorHolds;
    std::vector<std::string> gunRigNames;
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

    void sample(const Entry &entry, const Clip &c, double t, bool loop, double spinDegrees = 0) {
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
        native_render::turn_spinner(pose, spinner, spinDegrees);
        upload_pose(pose);
    }

    void load_gun_holds(const nlohmann::json &metadata, size_t cs_bones) {
        if (!metadata.contains("gunHolds") || !metadata.contains("fists")) return;
        for (const auto &[id, raw] : metadata["gunHolds"].items())
            gunHolds.emplace(id, native_gun::parse_hold(raw));
        gunRig = native_gun::Rig{
                actorNames,
                actorParents,
                actorBind,
                std::min(cs_bones, actorNames.size()),
                native_gun::parse_fists(metadata["fists"])
        };
    }

    // A small per-actor random stream for the shot kick's jitter (the website uses Math.random).
    static double hold_noise(ActorHold &state) {
        state.noise ^= state.noise << 13;
        state.noise ^= state.noise >> 17;
        state.noise ^= state.noise << 5;
        return double(state.noise) / 4294967296.0;
    }

    // A shot's kick and a reload's gesture. A clip that rises is a tube gun's next shell, or a magazine just finished.
    static void
    play_gun_pulses(const native_render::ActorPulses &pulses, ActorHold &state, const native_gun::GunHoldData &gun) {
        auto &hold = *state.hold;
        if (pulses.shot) hold.shot(hold_noise(state), hold_noise(state));
        if (pulses.reload) {
            const bool shell = gun.shell_seconds.has_value();
            hold.reload(shell ? *gun.shell_seconds : gun.reload_seconds.value_or(2), shell);
        }
        const auto &own = pulses.own_reload;
        if (own && (!own->shell || gun.shell_seconds)) hold.reload(own->seconds, own->shell, own->empty);
    }

    // Appends the gun mesh's two bones to `pose`: the hold's when the actor has a gun, else the right hand's.
    void gun_layer(
            const native_render::Actor &actor,
            const native_render::ActorPulses &pulses,
            double dt,
            float feetYaw,
            const native_actor_anim::Acting *acting
    ) {
        const auto &gun = weapons[std::min(size_t(actor.frame.weapon), weapons.size() - 1)];
        const auto data = actor.frame.weapon >= 2 ? gunHolds.find(gun) : gunHolds.end();
        const size_t bones = pose.size() / 12;
        auto &state = actorHolds[actor.id];
        if (!gunRig || data == gunHolds.end() || bones != actorNames.size()) {
            const int hand = gunRig ? actor_bone("ValveBiped.Bip01_R_Hand") : -1;
            for (int copy = 0; copy < 2; ++copy)
                for (size_t i = 0; i < 12; ++i)
                    pose.push_back(hand >= 0 && size_t(hand) < bones ? pose[size_t(hand) * 12 + i] : float(i % 5 == 0));
            if (state.hold) state.hold->set_gun(nullptr, false);
            state.muzzle.reset();
            return;
        }
        const bool seen = state.hold != nullptr;
        if (!state.hold) state.hold = std::make_unique<native_gun::GunHold>(*gunRig);
        auto &hold = *state.hold;
        hold.set_gun(&data->second, seen && !pulses.snapped);
        play_gun_pulses(pulses, state, data->second);
        hold.silenced = actor.silenced && data->second.silencer_tip.has_value();
        native_gun::HoldInput input;
        input.yaw = actor.frame.yaw - feetYaw;
        input.pitch = actor.frame.pitch;
        input.dt = dt;
        input.snap = pulses.snapped;
        const bool arms_free = acting
                               && (acting->gesture.arms[0].turn || acting->gesture.arms[0].reach
                                   || acting->gesture.arms[1].turn || acting->gesture.arms[1].reach);
        hold.apply(pose, input, arms_free);
        pose.insert(pose.end(), hold.skin.begin(), hold.skin.end());
        const double yaw = feetYaw * native_gun::radians_per_degree;
        const auto &m = hold.muzzle;
        state.muzzle = std::array<float, 3>{
                actor.frame.position[0] + float(m[0] * std::cos(yaw) - m[1] * std::sin(yaw)),
                actor.frame.position[1] + float(m[0] * std::sin(yaw) + m[1] * std::cos(yaw)),
                actor.frame.position[2] + float(m[2])
        };
    }

    void actor_actions(
            const native_render::Actor &actor,
            const native_render::ActorPulses &pulses,
            const Look &look,
            double seconds,
            float feetYaw,
            const native_actor_anim::Acting *acting
    ) {
        auto &state = actorActions[actor.id];
        if (pulses.snapped || seconds < state.last || state.knife != look.knife || state.weapon != actor.frame.weapon)
            state = {};
        const double dt = state.last < 0 ? 0 : std::clamp(seconds - state.last, 0., .1);
        state.last = seconds;
        state.knife = look.knife;
        state.weapon = actor.frame.weapon;
        if (pulses.swing) state.gesture.cancel();
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
                pulses.snapped
        );
        native_render::advance_ponytail(
                state.ponytail, actor.frame.velocity, actor.frame.yaw, dt, pulses.snapped || dt <= 0, look.hairLength
        );
        gun_layer(actor, pulses, dt, feetYaw, acting);
        upload_pose(pose);
        if (actorActions.size() > 256) {
            actorActions.clear();
            actorAnimationStates.clear();
            actorHolds.clear();
        }
    }

    static void linearColor(uint32_t hex, float *out) {
        for (int k = 0; k < 3; k++) {
            float c = float((hex >> (16 - k * 8)) & 255) / 255;
            out[k] = c <= .04045f ? c / 12.92f : std::pow((c + .055f) / 1.055f, 2.4f);
        }
    }

    void read_model_data(const std::filesystem::path &assetRoot) {
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
    }

    void read_rig() {
        weapons = metadata.at("weapons").get<std::vector<std::string>>();
        spinner = native_render::parse_knife_spinner(metadata);
        inspectCueTimes = native_render::parse_inspect_cues(metadata.at("inspects"));
        if (metadata.contains("actorRig")) {
            const auto &rig = metadata["actorRig"];
            actorNames = rig["names"].get<std::vector<std::string>>();
            actorParents = rig["parent"].get<std::vector<int>>();
            actorBind = rig["bind"].get<std::vector<float>>();
            if (actorParents.size() != actorNames.size() || actorBind.size() != actorNames.size() * 12)
                throw std::runtime_error("Invalid actor rig metadata");
            for (size_t i = 0; i < actorParents.size(); i++)
                if (actorParents[i] >= int(i)) throw std::runtime_error("Invalid actor rig hierarchy");
            load_gun_holds(metadata, rig.value("csBones", actorNames.size()));
        }
    }

    void read_meshes() {
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
    }

    void read_entries() {
        for (const auto &[name, raw] : metadata.at("entries").items()) {
            Entry e;
            e.bones = raw.at("bones");
            e.meshes = raw.at("meshes").get<std::vector<std::string>>();
            e.drawMeshes.reserve(e.meshes.size());
            for (const auto &name : e.meshes) {
                const auto at = meshes.find(name);
                e.drawMeshes.push_back(at == meshes.end() ? nullptr : &at->second);
            }
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
    }

    void load_assets(const std::filesystem::path &assetRoot, bool cpu_only) {
        read_model_data(assetRoot);
        read_rig();
        read_meshes();
        floorMeshes.reserve(weapons.size());
        for (const auto &weapon : weapons) {
            const auto at = meshes.find("worldgun:" + weapon);
            floorMeshes.push_back(at == meshes.end() ? nullptr : &at->second);
        }
        read_entries();
        if (graphicsContext.backend() == gfx::Backend::opengl)
            shaders = std::make_unique<native_render::PlayerShaderSources>(assetRoot);
        if (!cpu_only) prepare_graphics();
    }

public:
    explicit NativeViewmodel(
            Gl &api, const std::filesystem::path &assetRoot = BUNNYHOP_NATIVE_ASSET_ROOT, bool cpu_only = false
    )
        : NativeViewmodelGpu(api) {
        load_assets(assetRoot, cpu_only);
    }

    explicit NativeViewmodel(
            gfx::Context &graphics,
            const std::filesystem::path &assetRoot = BUNNYHOP_NATIVE_ASSET_ROOT,
            bool cpu_only = false
    )
        : NativeViewmodelGpu(graphics) {
        load_assets(assetRoot, cpu_only);
    }

    void prepare_graphics() {
        prepare_resources();
        gunFx = std::make_unique<NativePresentation>(graphicsContext);
        pose.reserve(max_pose_bones * 12);
        basePose.reserve(max_pose_bones * 12);
        equipped = look("outfit-cream", "");
        program(equipped, PlayerMaterial::solid);
        release_samplers();
        std::cout << "Native models: " << meshes.size() << " original meshes, " << entries.size()
                  << " pose sets, GPU skinning/cosmetics\n";
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

    // The inspect's sound cues the trick passed this frame; the game plays them, then clears the queue.
    void hear_inspect_cues(double seconds) {
        const auto knife = inspectCueTimes.find(equipped.knife);
        if (inspectIndex < 0 || knife == inspectCueTimes.end() || size_t(inspectIndex) >= knife->second.size()) {
            cueTrick = -1;
            return;
        }
        const double t = std::max(0., seconds - started);
        if (cueTrick != inspectIndex) {
            cueTrick = inspectIndex;
            cueTime = t;
            return;
        }
        native_render::collect_inspect_cues(knife->second[size_t(inspectIndex)], cueTime, t, inspectCueQueue);
        cueTime = t;
    }

    native_render::InspectCueQueue &inspect_cues() { return inspectCueQueue; }

    const native_render::InspectCueQueue &inspect_cues() const { return inspectCueQueue; }

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
            graphicsContext.clear_color({0, 0, 0, 0});
            graphicsContext.clear_depth();
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
            bool held,
            gfx::Compare depth_compare = gfx::Compare::less_equal
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
            draw(width, height, state, 1, 0, false, 0, seconds, nullptr, false, depth_compare);
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
        options.identityPose = true;
        bind(plain, projection, native::model_matrix(t), eye, seconds, options);
        drawState = {};
        apply_draw_state();
        mesh(floorMeshes[weapon.weapon]);
        graphicsContext.bind_texture(0, bonesTexture, bonesSampler);
        release_samplers();
    }

    // The website's ghost near fade (player/materials.ts nearFade): hidden within 14 units of the camera, measured to
    // the body's feet-to-head axis, fully shown from 64.
    void ghost_uniforms(const PlayerProgram &p, const native_render::Actor &actor, native_render::GhostSource source) {
        constexpr float hidden_units = 14, shown_units = 64, body_height_units = 64;
        const auto color = source == native_render::GhostSource::pb
                                   ? ghostColor
                                   : native_render::linear_color(native_render::ghost_source_color(source));
        const auto rim = source == native_render::GhostSource::pb ? ghostRim : color;
        write_vector(p.values.ghost, color.data());
        write_vector(p.values.ghostRim, rim.data());
        const auto &position = actor.frame.position;
        const float top[3] = {position[0], position[1], position[2] + body_height_units};
        const auto feet = native_render::to_web_space(position), head = native_render::to_web_space(top);
        write_vector(p.values.axisA, feet.data());
        write_vector(p.values.axisB, head.data());
        if (actor.near_fade)
            p.values.nearFade = {hidden_units, shown_units};
        else
            p.values.nearFade = {0, 0};
        graphicsContext.constants(p.ghost, &p.values);
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
    std::span<const std::string> actor_parts(const native_render::Actor &actor) {
        const auto &parts = parts_for(actor, look(actor.outfit, actor.loadout));
        return {parts.names.data(), parts.count};
    }

    static constexpr size_t mesh_vertex_floats = vertex_floats;

    // A mesh's vertices, `mesh_vertex_floats` each: position, normal, colour, then four bone ids first. Empty when
    // absent.
    std::span<const float> mesh_vertices(const std::string &name) const {
        const auto at = meshes.find(name);
        if (at == meshes.end()) return {};
        return {data.data() + at->second.offset, at->second.vertices * vertex_floats};
    }

    // The website's per-body hat fit (fit_headwear), so framing matches how the headwear is drawn.
    const HeadwearFit &actor_hat_fit(const native_render::Actor &actor) {
        return look(actor.outfit, actor.loadout).fit;
    }

    const std::vector<float> &actor_pose() const { return pose; }

    void upload_actor_pose(const std::vector<float> &bones) {
        pose = bones;
        upload_pose(pose);
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
        actorHolds.erase(id);
    }

    // Where an actor's gun muzzle was last drawn (world space), while it holds a gun.
    std::optional<std::array<float, 3>> actor_muzzle(const std::string &id) const {
        const auto found = actorHolds.find(id);
        return found == actorHolds.end() ? std::nullopt : found->second.muzzle;
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
        const auto known = actorActions.find(actor.id);
        const bool posed_this_frame = known != actorActions.end() && known->second.last == seconds;
        const auto pulses = native_render::actor_pulses(actor, posed_this_frame, acting != nullptr);
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
                upload_pose(pose);
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
                state->pose(input, seconds, pulses.snapped, pulses.swing, pose, acting);
                actorYaw = float(state->feetYaw);
            }
            actor_actions(actor, pulses, l, seconds, actorYaw, acting);
        }
        return actorYaw;
    }

    void draw_actor_parts(
            const native_render::Actor &actor,
            std::span<const Mesh *const> visibleParts,
            const PlayerProgram &actorProgram,
            const float eye[3]
    ) {
        const auto &frame = actor.frame;
        if (showGlow && actor.playerGlow && actor.playerGlow->enabled && actor.opacity >= .999f) {
            const float distance = std::hypot(
                    std::hypot(eye[0] - frame.position[0], eye[1] - frame.position[1]), eye[2] - frame.position[2]
            );
            actorProgram.values.glowNearFade = {14, 60};
            actorProgram.values.glowDistance = native_render::glow_distance(distance);
            const float top[3] = {frame.position[0], frame.position[1], frame.position[2] + 64};
            const auto feet = native_render::to_web_space(frame.position), head = native_render::to_web_space(top);
            write_vector(actorProgram.values.glowAxisA, feet.data());
            write_vector(actorProgram.values.glowAxisB, head.data());
            graphicsContext.constants(actorProgram.actor_glow, &actorProgram.values);
            draw_glow(visibleParts, actorProgram, actor.playerGlow->aura && distance < 650, 1);
        }
        if (actor.opacity < 1) {
            drawState.color_write.fill(false);
            drawState.blend.enabled = false;
            drawState.depth.write = true;
            apply_draw_state();
            for (const auto &part : visibleParts)
                mesh(part);
            drawState.color_write.fill(true);
            drawState.blend = {true};
            drawState.depth.write = false;
            apply_draw_state();
        } else {
            drawState.blend.enabled = false;
            drawState.depth.write = true;
            apply_draw_state();
        }
        for (const auto &part : visibleParts)
            mesh(part);
        drawState.depth.write = true;
        drawState.blend.enabled = false;
        apply_draw_state();
        release_samplers();
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
        write_vector(actorProgram.values.capybara, capy);
        actorProgram.values.propellerAngle = float(motion.angle);
        const auto &tail = actorActions[actor.id].ponytail;
        const float ponytail[4] = {float(tail.pitch), float(tail.side), l.hairLength, 0};
        write_vector(actorProgram.values.ponytail, ponytail);
        graphicsContext.constants(actorProgram.accessory, &actorProgram.values);
        if (source != native_render::GhostSource::none) ghost_uniforms(actorProgram, actor, source);
        const auto &parts = parts_for(actor, l);
        const std::span<const Mesh *const> visibleParts(parts.drawMeshes.data(), parts.count);
        drawState = {};
        apply_draw_state();
        draw_actor_parts(actor, visibleParts, actorProgram, eye);
    }

    void draw_muzzle_flash(uint32_t active, double seconds, const float offset[3], const native::Matrix &projection) {
        const float eye[3] = {};
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
                gunFx->draw(projection, eye);
            }
        }
    }

    void draw_viewmodel(
            int width,
            int height,
            const BhSnapshot &snapshot,
            uint32_t active,
            double seconds,
            const Entry &entry,
            gfx::Compare depth_compare
    ) {
        graphicsContext.clear_depth();
        drawState = {};
        drawState.depth.compare = depth_compare;
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
        const auto projection = native::multiply(perspective, sourceView);
        const auto &handsProgram = bind(equipped, projection, native::model_matrix(turn), eye, seconds, options);
        drawState.raster.winding = leftHand ? gfx::Winding::clockwise : gfx::Winding::counter_clockwise;
        apply_draw_state();
        for (const auto *part : entry.drawMeshes)
            mesh(part);
        if (showGlow && firstPersonGlow && localGlow && localGlow->enabled) {
            draw_glow(entry.drawMeshes, handsProgram, localGlow->aura, .2f);
        }
        drawState.raster.winding = gfx::Winding::counter_clockwise;
        apply_draw_state();
        release_samplers();
        draw_muzzle_flash(active, seconds, offset, projection);
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
         bool presentationEvent = false,
         gfx::Compare depth_compare = gfx::Compare::less_equal) {
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
            hear_inspect_cues(seconds);
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
        const bool spins = active == 1 && spinner.spins(equipped.knife);
        sample(entry, *c, time, false, spins ? native_render::whirl_idle_degrees(spinner, seconds) : 0);
        draw_viewmodel(width, height, snapshot, active, seconds, entry, depth_compare);
    }
};
