#pragma once
#include "crash_particles.hpp"

// Included after Gl. All leaves use current observer state, so cuts and restores retain no particle history.
class CrashExplosions {
    struct Source {
        int kind = -1;
        native_crash::Point origin{}, angles{};
    };

    struct Leaf {
        size_t definition;
        double delay;
        GLuint texture;
    };

    struct Vertex {
        float position[3], tint[4], uv[2], uv_next[2], frame_blend;
    };

    struct Program {
        GLuint id = 0;
        GLint view_projection = -1, map = -1, scene = -1, scene_size = -1, refract = -1;
        GLint add_self = -1, overbright = -1, linear_output = -1;
    };

    struct Frame {
        const native::Matrix &vp;
        native_crash::Point eye, right, up;
        double now;
        int width, height;
        bool linear_output;
        size_t budget = particle_budget;
        GLuint scene = 0;
    };

    Gl &gl;
    Program sprite_, warp_;
    GLuint vao_ = 0, buffer_ = 0;
    std::vector<native_crash::Definition> definitions_;
    std::array<std::vector<Leaf>, 2> leaves_;
    size_t max_leaves_ = 0;
    std::vector<Source> sources_;
    std::vector<BhPropAnimState> states_;
    std::vector<native_crash::OrderedSample> samples_;
    std::vector<Vertex> vertices_;
    static constexpr size_t particle_budget = 4096;
    static constexpr uint32_t removed_flag = 2, set_flag = 4;

public:
    explicit CrashExplosions(Gl &gl) : gl(gl) {}

    ~CrashExplosions() {
        if (buffer_) gl.DeleteBuffers(1, &buffer_);
        if (vao_) gl.DeleteVertexArrays(1, &vao_);
        if (sprite_.id) gl.DeleteProgram(sprite_.id);
        if (warp_.id) gl.DeleteProgram(warp_.id);
    }

    template <class Resolve>
    void load(BhContext *core, const std::filesystem::path &assets, Resolve resolve) {
        char sha[65]{};
        if (!bh_map_sha256(core, sha) || std::string_view(sha) != native_crash::bsp_sha256) return;
        std::ifstream file(assets / "crash-particles.json");
        if (!file) throw std::runtime_error("Crash particle definitions absent; rebuild native assets");
        const auto data = nlohmann::json::parse(file);
        for (const auto &[name, value] : data.items())
            definitions_.push_back(native_crash::compile(name, value));
        collect("Explosion_Tnt", 0, leaves_[0], resolve, 0);
        collect("Explosion_Nitro", 0, leaves_[1], resolve, 0);
        max_leaves_ = std::max(leaves_[0].size(), leaves_[1].size());
        load_sources(core);
        states_.resize(RuntimePropCopies::entity_limit);
        samples_.reserve(native_crash::birth_limit);
        vertices_.reserve(native_crash::birth_limit * 6);
        prepare_graphics();
    }

    template <class Capture>
    void
    draw(const native::Matrix &vp,
         BhContext *core,
         const RuntimePropCopies &copies,
         const native_render::Vec3 &right,
         const native_render::Vec3 &up,
         const float eye[3],
         double now,
         bool visible,
         int width,
         int height,
         bool linear_output,
         Capture capture) {
        if (!sprite_.id || !visible) return;
        Frame frame{
                vp,
                {eye[0], eye[1], eye[2]},
                {right[0], right[1], right[2]},
                {up[0], up[1], up[2]},
                now,
                width,
                height,
                linear_output
        };
        const auto count = bh_prop_anim_states(core, states_.data(), states_.size());
        gl.BindVertexArray(vao_);
        gl.BindBuffer(GL_ARRAY_BUFFER, buffer_);
        gl.Enable(GL_DEPTH_TEST);
        gl.DepthMask(GL_FALSE);
        gl.Disable(GL_CULL_FACE);
        // PCF child order takes precedence over event/material order, including simultaneous blasts.
        for (size_t order = 0; order < max_leaves_ && frame.budget; ++order)
            for (size_t i = 0; i < count && frame.budget; ++i)
                draw_state(states_[i], order, copies, frame, capture);
        gl.DepthMask(GL_TRUE);
        gl.Disable(GL_BLEND);
        gl.BlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
        gl.ActiveTexture(GL_TEXTURE0);
    }

private:
    void load_sources(BhContext *core) {
        size_t bytes = 0;
        const char *raw = bh_entities_json(core, &bytes);
        const auto entities = raw && bytes ? nlohmann::json::parse(raw, raw + bytes) : nlohmann::json::array();
        sources_.resize(entities.size());
        for (size_t i = 0; i < entities.size(); ++i) {
            const auto &entity = entities[i];
            if (entity.value("classname", "") != "info_particle_system") continue;
            const auto effect = entity.value("effect_name", "");
            if (effect != "Explosion_Tnt" && effect != "Explosion_Nitro") continue;
            sources_[i] = {
                    effect == "Explosion_Tnt" ? 0 : 1,
                    native_crash::vector(entity, "origin"),
                    native_crash::vector(entity, "angles")
            };
        }
    }

    template <class Resolve>
    void collect(const std::string &name, double delay, std::vector<Leaf> &leaves, Resolve &resolve, size_t depth) {
        if (depth > 32) throw std::runtime_error("Crash particle child cycle");
        for (size_t i = 0; i < definitions_.size(); ++i) {
            const auto &d = definitions_[i];
            if (d.name != name) continue;
            if (!d.births.empty()) {
                const auto texture = resolve(d.normal_map.empty() ? d.material : d.normal_map, !d.normal_map.empty());
                if (texture) leaves.push_back({i, delay, texture});
            }
            for (const auto &[child, offset] : d.children)
                collect(child, delay + offset, leaves, resolve, depth + 1);
            return;
        }
        throw std::runtime_error("Missing authored Crash particle child: " + name);
    }

    template <class Capture>
    void draw_state(
            const BhPropAnimState &state, size_t order, const RuntimePropCopies &copies, Frame &frame, Capture &capture
    ) {
        if (!(state.flags & set_flag) || (state.flags & removed_flag) || frame.now < state.since
            || frame.now - state.since > native_crash::event_seconds)
            return;
        const auto *copy = copies.find(int32_t(state.entity));
        const auto source = copy ? copy->source : state.entity;
        if (source >= sources_.size() || sources_[source].kind < 0) return;
        const auto &leaves = leaves_[size_t(sources_[source].kind)];
        if (order >= leaves.size()) return;
        const auto origin =
                copy ? native_crash::Point{copy->origin[0], copy->origin[1], copy->origin[2]} : sources_[source].origin;
        const auto angles =
                copy ? native_crash::Point{copy->angles[0], copy->angles[1], copy->angles[2]} : sources_[source].angles;
        const uint32_t seed = (state.entity + 1) * 31u ^ uint32_t(std::floor(double(state.since) * 1000 + .5));
        const auto &leaf = leaves[order];
        sample_leaf(leaf, frame.now - state.since, seed, origin, angles, frame);
        if (samples_.empty()) return;
        const auto &d = definitions_[leaf.definition];
        // The shared water capture resolves MSAA and restores the read/draw framebuffer bindings.
        if (!d.normal_map.empty() && !frame.scene) frame.scene = capture();
        if (!d.normal_map.empty() && !frame.scene) return;
        submit(leaf, frame);
    }

    void sample_leaf(
            const Leaf &leaf,
            double age,
            uint32_t seed,
            native_crash::Point origin,
            native_crash::Point angles,
            Frame &frame
    ) {
        const auto &d = definitions_[leaf.definition];
        samples_.clear();
        for (size_t i = 0; i < d.births.size() && frame.budget; ++i) {
            const double particle_age = age - leaf.delay - d.births[i];
            auto p = native_crash::sample(d, uint32_t(i), particle_age, seed, angles);
            if (!p) continue;
            for (size_t k = 0; k < 3; ++k)
                p->position[k] += origin[k];
            samples_.push_back(
                    {*p, particle_age, uint32_t(i), native_crash::view_depth(*p, frame.eye, frame.right, frame.up)}
            );
            --frame.budget;
        }
        if (d.sort_particles) native_crash::sort_samples(samples_);
    }

    void submit(const Leaf &leaf, const Frame &frame) {
        const auto &d = definitions_[leaf.definition];
        const bool warp = !d.normal_map.empty();
        const auto &program = warp ? warp_ : sprite_;
        gl.UseProgram(program.id);
        gl.UniformMatrix4fv(program.view_projection, 1, GL_FALSE, frame.vp.data());
        gl.Uniform1i(program.map, 0);
        gl.ActiveTexture(GL_TEXTURE0);
        gl.BindTexture(GL_TEXTURE_2D, leaf.texture);
        if (warp) {
            gl.Disable(GL_BLEND);
            gl.Uniform1i(program.scene, 1);
            gl.Uniform2f(program.scene_size, float(frame.width), float(frame.height));
            gl.Uniform1f(program.refract, float(d.refract_amount));
            gl.ActiveTexture(GL_TEXTURE1);
            gl.BindTexture(GL_TEXTURE_2D, frame.scene);
        } else {
            gl.Enable(GL_BLEND);
            gl.BlendFunc(
                    d.add_self > 0 ? GL_ONE : GL_SRC_ALPHA,
                    d.additive && d.add_self <= 0 ? GL_ONE : GL_ONE_MINUS_SRC_ALPHA
            );
            gl.Uniform1f(program.add_self, float(d.add_self));
            gl.Uniform1f(program.overbright, float(d.overbright));
            gl.Uniform1i(program.linear_output, frame.linear_output);
        }
        vertices_.clear();
        for (const auto &sample : samples_)
            append(sample, d, frame);
        gl.BufferData(GL_ARRAY_BUFFER, vertices_.size() * sizeof(Vertex), vertices_.data(), GL_STREAM_DRAW);
        gl.DrawArrays(GL_TRIANGLES, 0, GLsizei(vertices_.size()));
    }

    void append(const native_crash::OrderedSample &sample, const native_crash::Definition &d, const Frame &frame) {
        constexpr std::array<std::array<double, 2>, 4> signs{{{-1, -1}, {1, -1}, {1, 1}, {-1, 1}}};
        constexpr std::array<size_t, 6> triangles{0, 1, 2, 0, 2, 3};
        const auto &p = sample.particle;
        const auto shape = native_crash::card_shape(
                d,
                p,
                sample.age,
                std::hypot(p.position[0] - frame.eye[0], p.position[1] - frame.eye[1], p.position[2] - frame.eye[2])
        );
        std::array<Vertex, 4> corners{};
        for (size_t i = 0; i < corners.size(); ++i) {
            const auto offset = native_crash::card_offset(d, p, shape, signs[i], frame.right, frame.up);
            for (size_t k = 0; k < 3; ++k) {
                corners[i].position[k] = float(p.position[k] + offset[k]);
                corners[i].tint[k] = float(std::pow(std::max(0., p.color[k]), 2.2) * shape.fade);
            }
            corners[i].tint[3] = float(p.alpha * shape.fade);
            const size_t u = i == 1 || i == 2 ? 2 : 0, v = i < 2 ? 3 : 1;
            corners[i].uv[0] = float(p.uv[u]);
            corners[i].uv[1] = float(p.uv[v]);
            corners[i].uv_next[0] = float(p.uv_next[u]);
            corners[i].uv_next[1] = float(p.uv_next[v]);
            corners[i].frame_blend = float(p.frame_blend);
        }
        for (const auto i : triangles)
            vertices_.push_back(corners[i]);
    }

    Program prepare_program(const char *vertex, const char *fragment) {
        Program p;
        p.id = link_program(gl, vertex, fragment);
        p.view_projection = gl.GetUniformLocation(p.id, "viewProjection");
        p.map = gl.GetUniformLocation(p.id, "map");
        p.scene = gl.GetUniformLocation(p.id, "sceneMap");
        p.scene_size = gl.GetUniformLocation(p.id, "sceneSize");
        p.refract = gl.GetUniformLocation(p.id, "refractAmount");
        p.add_self = gl.GetUniformLocation(p.id, "addSelf");
        p.overbright = gl.GetUniformLocation(p.id, "overbright");
        p.linear_output = gl.GetUniformLocation(p.id, "linearOutput");
        return p;
    }

    void prepare_graphics() {
        const char *vertex = R"(#version 330 core
layout(location=0) in vec3 position; layout(location=1) in vec4 tint; layout(location=2) in vec2 texcoord;
layout(location=3) in vec2 texcoordNext; layout(location=4) in float frameBlend;
uniform mat4 viewProjection; out vec4 vTint; out vec2 uv; out vec2 uvNext; out float vFrameBlend;
void main(){gl_Position=viewProjection*vec4(position,1);vTint=tint;uv=texcoord;uvNext=texcoordNext;vFrameBlend=frameBlend;}
)";
        const char *fragment = R"(#version 330 core
uniform sampler2D map; uniform float addSelf; uniform float overbright; uniform bool linearOutput;
in vec4 vTint; in vec2 uv; in vec2 uvNext; in float vFrameBlend; out vec4 color;
vec3 srgb(vec3 c){return mix(12.92*c,1.055*pow(max(c,vec3(0)),vec3(1./2.4))-.055,step(vec3(.0031308),c));}
void main(){
 vec4 p=mix(texture(map,uv),texture(map,uvNext),vFrameBlend);
 p.rgb*=overbright;p.a*=vTint.a;
 if(addSelf>0.)p.rgb*=p.a*(1.+overbright*addSelf*vTint.a);
 p.rgb*=vTint.rgb;
 if(p.a<.002)discard;color=vec4(linearOutput?p.rgb:srgb(p.rgb),p.a);
}
)";
        const char *warp = R"(#version 330 core
uniform sampler2D map; uniform sampler2D sceneMap; uniform vec2 sceneSize; uniform float refractAmount;
in vec4 vTint; in vec2 uv; out vec4 color;
void main(){
 vec4 normal=texture(map,uv);
 vec2 offset=(normal.rg*2.-1.)*normal.a*refractAmount*vTint.a;
 color=vec4(texture(sceneMap,clamp(gl_FragCoord.xy/sceneSize+offset,vec2(0),vec2(1))).rgb,1.);
}
)";
        sprite_ = prepare_program(vertex, fragment);
        warp_ = prepare_program(vertex, warp);
        gl.GenVertexArrays(1, &vao_);
        gl.GenBuffers(1, &buffer_);
        gl.BindVertexArray(vao_);
        gl.BindBuffer(GL_ARRAY_BUFFER, buffer_);
        constexpr int sizes[] = {3, 4, 2, 2, 1};
        constexpr size_t offsets[] = {0, 3, 7, 9, 11};
        for (GLuint i = 0; i < 5; ++i) {
            gl.EnableVertexAttribArray(i);
            gl.VertexAttribPointer(
                    i,
                    sizes[i],
                    GL_FLOAT,
                    GL_FALSE,
                    sizeof(Vertex),
                    reinterpret_cast<void *>(offsets[i] * sizeof(float))
            );
        }
    }
};
