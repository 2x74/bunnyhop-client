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

    struct Look {
        std::string outfit = "outfit-cream", knife = "carrot", glove = "knit", gloveId = "glove-knit", hat,
                    body = "classic";
        int finish = 0, crown = 0;
        std::array<float, 24> palette{};
        std::array<float, 15> gloveColors{};
        std::array<float, 3> accent{};
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
    GLuint boundProgram = 0, bonesTexture = 0, identityBonesTexture = 0;
    std::unordered_map<int, GLuint> programs;
    std::unordered_map<std::string, Entry> entries;
    std::unordered_map<std::string, Mesh> meshes;
    std::vector<std::string> weapons;
    std::vector<float> data, pose;
    nlohmann::json metadata;
    std::string hatVp, hatVn, hatVt, hatFp, hatFs;
    std::optional<native_render::Glow> localGlow;
    bool showGlow = true, firstPersonGlow = true;
    std::string vp, vm, fp, fa, fl, glowNoise, glowFragment;
    Look equipped;
    std::string previewLoadout;
    std::array<float, 3> ghostColor{1, .54f, .047f}, ghostRim{1, .54f, .047f};

    struct ActorParts {
        std::string id, outfit, loadout;
        uint32_t weapon = 0;
        bool silenced = false, used = false;
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
            && parts->weapon == actor.frame.weapon && parts->silenced == actor.silenced) {
            return {parts->names.data(), parts->count};
        }
        if (!parts) parts = &actorParts[nextActorParts++ % actorParts.size()];
        parts->used = true;
        parts->id = actor.id;
        parts->outfit = actor.outfit;
        parts->loadout = actor.loadout;
        parts->weapon = actor.frame.weapon;
        parts->silenced = actor.silenced;
        parts->count = 0;
        const std::string body = look.outfit == "outfit-tek"     ? "tek"
                                 : look.outfit == "outfit-plush" ? "plush"
                                 : look.outfit == "outfit-bune"  ? "bune"
                                                                 : "bunny";
        parts->names[parts->count++] =
                "body:" + body + ":" + (body == "bunny" ? look.body : "classic") + ":" + look.glove;
        if (look.crown && look.hat.empty()) parts->names[parts->count++] = "crown:" + std::to_string(look.crown);
        if (!look.hat.empty()) parts->names[parts->count++] = look.hat;
        const auto &gun = weapons[std::min(size_t(actor.frame.weapon), weapons.size() - 1)];
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

    static std::string textFile(const std::filesystem::path &path) {
        std::ifstream file(path);
        if (!file) throw std::runtime_error("Native cosmetic shader absent: " + path.string());
        return std::string(std::istreambuf_iterator<char>(file), {});
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
                if (f.size() > 5 && meshes.count(f[5])) out.hat = f[5];
                if (f.size() > 6 && f[6] == "body-b") out.body = "feminine";
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
        cached.look = std::move(out);
        return cached.look;
    }

    GLuint program(const Look &look) {
        const int key = look.finish + (look.glove != "knit" ? 32 : 0);
        if (programs.count(key)) return programs.at(key);
        std::string defs = "#version 330 core\n";
        if (look.finish) defs += "#define FINISH " + std::to_string(look.finish) + "\n";
        if (look.glove != "knit") defs += "#define GLOVE\n";
        const std::string vs = defs + R"(
layout(location=0)in vec3 position;layout(location=1)in vec3 normal;layout(location=2)in vec3 partColor;layout(location=3)in vec4 boneIds;layout(location=4)in vec4 weights;layout(location=5)in float accent;
uniform sampler2D boneMatrices;uniform mat4 projection,model;uniform vec3 offset,uPalette[8],uAccent;uniform float mirror,auraPass,auraSize;uniform float glowTime;uniform bool headwear;uniform vec3 headwearScale,headwearOffset;
layout(location=7)in vec3 glowNormal;out vec3 vColor,normalV,positionV;out float vGlow,vGlowAlpha,vHalo;out vec2 vAuraCoord;
)" + vp + hatVp + glowNoise + R"(
mat4 bone(int i){vec4 a=texelFetch(boneMatrices,ivec2(0,i),0),b=texelFetch(boneMatrices,ivec2(1,i),0),c=texelFetch(boneMatrices,ivec2(2,i),0);return transpose(mat4(a,b,c,vec4(0,0,0,1)));}
void main(){vec3 transformed=position,objectNormal=auraPass>.5?glowNormal:normal;
)" + hatVn + hatVt + R"(
vHalo=auraPass>1.5?1.:0.;vGlowAlpha=1.5;vAuraCoord=vec2(transformed.x+transformed.y*.47,transformed.z);
if(auraPass>1.5){
 float width=.85+float(gl_InstanceID)*.52;
 vec2 flow=vAuraCoord*vec2(.27,.13)-vec2(0,glowTime*2.4);
 flow.x+=sin(flow.y*1.7+glowTime*.9)*.32;
 float tongue=smoothstep(.27,.78,auraFlow(flow));
 transformed+=normalize(objectNormal)*width*(.5+tongue*.75)*auraSize;
 transformed.z+=width*(.15+tongue*1.4)*auraSize;
 transformed.x+=sin(flow.y*2.1+glowTime)*width*.16*tongue*auraSize;
 vGlowAlpha=.08*pow(1.-float(gl_InstanceID)/8.,1.15);
}else if(auraPass>.5){transformed+=normalize(objectNormal)*.45*auraSize;}
if(headwear){transformed=transformed*headwearScale+headwearOffset;objectNormal=normalize(objectNormal/headwearScale);}
mat4 m=bone(int(boneIds.x))*weights.x+bone(int(boneIds.y))*weights.y+bone(int(boneIds.z))*weights.z+bone(int(boneIds.w))*weights.w;vec3 p=(m*vec4(transformed,1)).xyz+offset;p.y*=mirror;vec3 n=mat3(m)*objectNormal;n.y*=mirror;normalV=mat3(model)*n;positionV=(model*vec4(p,1)).xyz;
vGlow=accent>1.5&&accent<2.5?1.:0.;vColor=accent>15.5?uPalette[6]:accent>10.5?partColor:accent>2.5?uPalette[int(accent-2.5)]:accent>.5?uAccent:partColor;
)" + vm + R"(
gl_Position=projection*vec4(positionV,1);}
)";
        const std::string fs = defs + R"(
in vec3 vColor,normalV,positionV;in float vGlow,vGlowAlpha,vHalo;uniform bool ghostStyle;in vec2 vAuraCoord;out vec4 color;vec3 encodeGlow(vec3 c){return mix(c*12.92,1.055*pow(max(c,vec3(0)),vec3(1./2.4))-.055,step(vec3(.0031308),c));}uniform vec3 cameraPosition,ghostColor,ghostRim;uniform float opacity;uniform bool playerGlowEnabled;uniform vec3 playerGlowColor;uniform float playerGlowIntensity,auraPass,glowTime;uniform float uGlowDistance;uniform vec3 uAxisA,uAxisB;uniform vec2 uNearFade;
)" + fp + hatFp + glowNoise + glowFragment
                               +
                               R"(
void main(){vec3 n=normalize(normalV);float back=gl_FrontFacing?1.:.38;if(!gl_FrontFacing)n=-n;vec3 V=normalize(cameraPosition-positionV),L=normalize(vec3(.42,-.46,.78));float key=smoothstep(-.05,.55,dot(n,L));vec3 ambient=mix(vec3(.30,.27,.26),vec3(.70,.76,.88),n.z*.5+.5)*.62;vec3 albedo=vColor;
)" + fa + R"(
vec3 col=albedo*(ambient+key*vec3(.78,.74,.68));col+=pow(1.-max(dot(n,V),0.),3.)*.22*vec3(1,.86,.65);col*=back;
)" + fl + hatFs + R"(
#ifdef FINISH
if(abs(vFin.z-1.)<.5)col=finishShade(vec3(n.x,n.z,-n.y),vec3(V.x,V.z,-V.y),vec3(L.x,L.z,-L.y),ambient,key)*back;
#endif
if(playerGlowEnabled&&auraPass>.5){color=glowShade();return;}
float alpha=opacity;
if(ghostStyle){
 float fres=pow(1.-clamp(abs(dot(n,V)),0.,1.),2.2);
 float lum=dot(vColor,vec3(.2126,.7152,.0722));
 float up=n.z*.5+.5;
 col=ghostColor*(.3+.7*sqrt(max(lum,0.)))*(.7+.45*up);
 vec3 rimC=ghostRim+(ghostRim-ghostColor)*.6;
 col=max(col+rimC*fres*1.6,0.)+vec3(1)*fres*fres*.35;
 col+=mix(ghostColor,vec3(1),.45)*vGlow*1.1;
 alpha=clamp(opacity*(.38+.62*fres)+vGlow*.35*opacity,0.,1.);
 if(alpha<.004)discard;
}
col=max(col,vec3(0));color=vec4(mix(col*12.92,1.055*pow(col,vec3(1./2.4))-.055,step(vec3(.0031308),col)),alpha);}
)";
        GLuint id = link_program(gl, vs.c_str(), fs.c_str());
        programs.emplace(key, id);
        return id;
    }

    void mesh(const std::string &name, int instances = 1) {
        if (boundProgram)
            gl.Uniform1i(
                    gl.GetUniformLocation(boundProgram, "headwear"),
                    name.rfind("hat-", 0) == 0 || name.rfind("crown:", 0) == 0
            );
        auto at = meshes.find(name);
        if (at == meshes.end()) return;
        auto &m = at->second;
        if (!m.vao) {
            gl.GenVertexArrays(1, &m.vao);
            gl.BindVertexArray(m.vao);
            gl.GenBuffers(1, &m.vbo);
            gl.BindBuffer(GL_ARRAY_BUFFER, m.vbo);
            gl.BufferData(GL_ARRAY_BUFFER, m.vertices * 22 * sizeof(float), data.data() + m.offset, GL_STATIC_DRAW);
            for (int a = 0; a < 7; a++) {
                const int size[7] = {3, 3, 3, 4, 4, 1, 4}, offset[7] = {0, 3, 6, 9, 13, 17, 18};
                gl.EnableVertexAttribArray(a);
                gl.VertexAttribPointer(
                        a,
                        size[a],
                        GL_FLOAT,
                        GL_FALSE,
                        22 * sizeof(float),
                        reinterpret_cast<void *>(size_t(offset[a]) * 4)
                );
            }
            gl.GenBuffers(1, &m.glowVbo);
            gl.BindBuffer(GL_ARRAY_BUFFER, m.glowVbo);
            gl.BufferData(GL_ARRAY_BUFFER, m.vertices * 3 * sizeof(float), data.data() + m.glowOffset, GL_STATIC_DRAW);
            gl.EnableVertexAttribArray(7);
            gl.VertexAttribPointer(7, 3, GL_FLOAT, GL_FALSE, 3 * sizeof(float), nullptr);
            // finishUV is declared by generated shader source, so bind its named location separately.
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

    void draw_glow(std::span<const std::string> parts, GLuint program, bool aura, float scale) {
        gl.Uniform1f(gl.GetUniformLocation(program, "auraSize"), scale);
        gl.Enable(GL_BLEND);
        gl.BlendFunc(GL_SRC_ALPHA, GL_ONE);
        gl.DepthMask(GL_FALSE);
        gl.Enable(GL_CULL_FACE);
        gl.CullFace(GL_FRONT);
        gl.Uniform1f(gl.GetUniformLocation(program, "auraPass"), 1);
        for (const auto &part : parts) {
            mesh(part);
        }
        if (aura && !parts.empty()) {
            gl.Uniform1f(gl.GetUniformLocation(program, "auraPass"), 2);
            mesh(parts.front(), native_render::glow_halo_layers);
        }
        gl.CullFace(GL_BACK);
        gl.Disable(GL_CULL_FACE);
        gl.Uniform1f(gl.GetUniformLocation(program, "auraPass"), 0);
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

    GLuint
    bind(const Look &look,
         const native::Matrix &projection,
         const native::Matrix &model,
         const float eye[3],
         double seconds,
         float opacity,
         const float offset[3],
         float mirror,
         const native_render::Glow *glow = nullptr,
         GLuint poseTexture = 0) {
        gl.ActiveTexture(GL_TEXTURE0);
        gl.BindTexture(GL_TEXTURE_2D, poseTexture ? poseTexture : bonesTexture);
        GLuint p = program(look);
        boundProgram = p;
        gl.UseProgram(p);
        auto loc = [&](const char *n) {
            return gl.GetUniformLocation(p, n);
        };
        gl.UniformMatrix4fv(loc("projection"), 1, GL_FALSE, projection.data());
        gl.UniformMatrix4fv(loc("model"), 1, GL_FALSE, model.data());
        gl.Uniform3fv(loc("offset"), 1, offset);
        gl.Uniform3fv(loc("cameraPosition"), 1, eye);
        gl.Uniform1f(loc("mirror"), mirror);
        gl.Uniform1f(loc("auraPass"), 0);
        gl.Uniform1i(loc("ghostStyle"), 0);
        gl.Uniform1f(loc("auraSize"), 1);
        gl.Uniform1f(loc("uGlowDistance"), 1);
        gl.Uniform2f(loc("uNearFade"), 0, 0);
        const auto fit = native_render::hat_fit(look.outfit, look.hat);
        gl.Uniform3fv(loc("headwearScale"), 1, fit.scale.data());
        gl.Uniform3fv(loc("headwearOffset"), 1, fit.offset.data());
        gl.Uniform1i(loc("playerGlowEnabled"), showGlow && glow && glow->enabled);
        if (glow) {
            float rgb[3];
            for (int k = 0; k < 3; k++)
                rgb[k] = glow->color[k] <= .04045f ? glow->color[k] / 12.92f
                                                   : std::pow((glow->color[k] + .055f) / 1.055f, 2.4f);
            gl.Uniform3fv(loc("playerGlowColor"), 1, rgb);
            gl.Uniform1f(loc("playerGlowIntensity"), glow->intensity);
        }
        gl.Uniform1f(loc("opacity"), opacity);
        gl.Uniform3fv(loc("ghostColor"), 1, ghostColor.data());
        gl.Uniform3fv(loc("ghostRim"), 1, ghostRim.data());
        gl.Uniform1f(loc("uFinTime"), seconds);
        gl.Uniform1f(loc("glowTime"), seconds);
        gl.Uniform1i(loc("boneMatrices"), 0);
        gl.Uniform3fv(loc("uPalette"), 8, look.palette.data());
        gl.Uniform3fv(loc("uAccent"), 1, look.accent.data());
        gl.Uniform3fv(loc("uGlove"), 5, look.gloveColors.data());
        return p;
    }

public:
    explicit NativeViewmodel(Gl &g, const std::filesystem::path &assetRoot = BUNNYHOP_NATIVE_ASSET_ROOT) : gl(g) {
        if (std::filesystem::exists(assetRoot / "actor-animations.json"))
            actorAnimationData = std::make_shared<native_actor_anim::Data>(assetRoot.string());
        std::ifstream file(assetRoot / "viewmodels.json");
        if (!file) throw std::runtime_error("Native asset bundle absent; run native asset compiler");
        file >> metadata;
        if (metadata.at("version") != 2 || metadata.at("stride") != 22)
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
                || m.offset + m.vertices * 22 > data.size() || m.indexOffset + m.indices > data.size())
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

        glowNoise = textFile(assetRoot / "glow-noise.glsl");
        glowFragment = textFile(assetRoot / "glow-fragment.glsl");
        const auto main = glowFragment.find("void main()");
        glowFragment = glowFragment.substr(main);
        const std::pair<std::string, std::string> substitutions[] = {
                {"void main()", "vec4 glowShade()"},
                {"vNormalW", "normalV"},
                {"vWorldPos", "positionV"},
                {"uFinTime", "glowTime"},
                {"uGlowStrength", "playerGlowIntensity"},
                {"uOpacity", "opacity"},
                {"uGlowColor", "playerGlowColor"},
                {"gl_FragColor=", "return "}
        };
        for (const auto &[from, to] : substitutions) {
            size_t at = 0;
            while ((at = glowFragment.find(from, at)) != std::string::npos) {
                glowFragment.replace(at, from.size(), to);
                at += to.size();
            }
        }
        vp = textFile(assetRoot / "cosmetic-vertex-pars.glsl");
        vp = std::string(vp).replace(vp.find("in vec4 finishUV;"), 17, "layout(location=6)in vec4 finishUV;");
        vm = textFile(assetRoot / "cosmetic-vertex-main.glsl");
        fp = textFile(assetRoot / "cosmetic-fragment-pars.glsl");
        fa = textFile(assetRoot / "cosmetic-fragment-albedo.glsl");
        fl = textFile(assetRoot / "cosmetic-fragment-light.glsl");
        const auto optionalShader = [&](const char *name) {
            const auto path = assetRoot / name;
            return std::filesystem::exists(path) ? textFile(path) : std::string();
        };
        hatVp = optionalShader("hat-vertex-pars.glsl");
        hatVn = optionalShader("hat-vertex-normal.glsl");
        hatVt = optionalShader("hat-vertex-position.glsl");
        hatFp = optionalShader("hat-fragment-pars.glsl");
        hatFs = optionalShader("hat-fragment-solid.glsl");
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
        program(equipped);
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
        for (auto [key, p] : programs)
            gl.DeleteProgram(p);
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
        const float zero[3] = {};
        const auto &plain = look("outfit-cream", "");
        bind(plain, projection, native::model_matrix(t), eye, seconds, 1, zero, 1, nullptr, identityBonesTexture);
        gl.Enable(GL_DEPTH_TEST);
        gl.DepthMask(GL_TRUE);
        gl.Disable(GL_BLEND);
        gl.Disable(GL_CULL_FACE);
        mesh("worldgun:" + weapons[weapon.weapon]);
        gl.ActiveTexture(GL_TEXTURE0);
        gl.BindTexture(GL_TEXTURE_2D, bonesTexture);
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
        if (!std::isfinite(actor.opacity) || actor.opacity <= 0) return;
        for (float v : actor.frame.position)
            if (!std::isfinite(v)) return;
        for (float v : actor.frame.velocity)
            if (!std::isfinite(v)) return;
        if (!std::isfinite(actor.frame.yaw) || !std::isfinite(actor.frame.pitch)) return;
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
            if (!c) return;
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
                state->pose(input, seconds, actor.snapped, actor.attack != 0, pose, acting);
                actorYaw = float(state->feetYaw);
            }
            actor_actions(actor, l, seconds);
        }
        BhTransform t{};
        std::copy(frame.position, frame.position + 3, t.origin);
        t.angles[1] = actorYaw + spin;
        auto model = native::model_matrix(t);
        for (int r = 0; r < 3; r++) {
            model[r] *= 1 - squash * .5f;
            model[4 + r] *= 1 - squash * .5f;
            model[8 + r] *= 1 + squash;
        }
        const float zero[3] = {};
        bind(l,
             projection,
             model,
             eye,
             seconds,
             std::clamp(actor.opacity, 0.f, 1.f),
             zero,
             1,
             actor.playerGlow ? &*actor.playerGlow : nullptr);
        const auto actorProgram = program(l);
        const auto &motion = actorActions[actor.id].accessory;
        const float capy[4] = {motion.alert, motion.squash, motion.lean, float(seconds)};
        gl.Uniform4fv(gl.GetUniformLocation(actorProgram, "uCapybara"), 1, capy);
        gl.Uniform1f(gl.GetUniformLocation(actorProgram, "uPropellerAngle"), float(motion.angle));
        const auto source = actor.source == native_render::GhostSource::none
                                            && (actor.id == "replay" || actor.id.starts_with("ghost-"))
                                    ? native_render::GhostSource::custom
                                    : actor.source;
        gl.Uniform1i(gl.GetUniformLocation(actorProgram, "ghostStyle"), source != native_render::GhostSource::none);
        if (source != native_render::GhostSource::none) {
            const auto color = source == native_render::GhostSource::pb
                                       ? ghostColor
                                       : native_render::linear_color(native_render::ghost_source_color(source));
            const auto rim = source == native_render::GhostSource::pb ? ghostRim : color;
            gl.Uniform3fv(gl.GetUniformLocation(actorProgram, "ghostColor"), 1, color.data());
            gl.Uniform3fv(gl.GetUniformLocation(actorProgram, "ghostRim"), 1, rim.data());
        }
        const auto visibleParts = parts_for(actor, l);
        gl.Enable(GL_DEPTH_TEST);
        gl.Disable(GL_CULL_FACE);
        gl.DepthFunc(GL_LEQUAL);
        if (showGlow && actor.playerGlow && actor.playerGlow->enabled && actor.opacity >= .999f) {
            const float distance = std::hypot(
                    std::hypot(eye[0] - frame.position[0], eye[1] - frame.position[1]), eye[2] - frame.position[2]
            );
            gl.Uniform2f(gl.GetUniformLocation(actorProgram, "uNearFade"), 14, 60);
            gl.Uniform1f(gl.GetUniformLocation(actorProgram, "uGlowDistance"), native_render::glow_distance(distance));
            gl.Uniform3fv(gl.GetUniformLocation(actorProgram, "uAxisA"), 1, frame.position);
            const float top[3] = {frame.position[0], frame.position[1], frame.position[2] + 64};
            gl.Uniform3fv(gl.GetUniformLocation(actorProgram, "uAxisB"), 1, top);
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
        bind(
                equipped,
                native::multiply(perspective, sourceView),
                [&] {
                    BhTransform turn{};
                    turn.angles[1] = previewYaw;
                    turn.angles[0] = previewPitch;
                    return native::model_matrix(turn);
                }(),
                eye,
                seconds,
                1,
                offset,
                leftHand ? -1 : 1,
                firstPersonGlow && localGlow ? &*localGlow : nullptr
        );
        gl.FrontFace(leftHand ? GL_CW : GL_CCW);
        for (const auto &part : entry.meshes)
            mesh(part);
        if (showGlow && firstPersonGlow && localGlow && localGlow->enabled) {
            draw_glow(entry.meshes, program(equipped), localGlow->aura, .2f);
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
