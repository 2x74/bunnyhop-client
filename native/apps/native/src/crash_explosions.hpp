#pragma once
#include "crash_particles.hpp"

// Included after Gl: authored sprite textures and stateless PCF samples share the normal world render target.
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
        float position[3], tint[4], uv[2];
    };

    Gl &gl;
    GLuint shader_ = 0, vao_ = 0, buffer_ = 0;
    std::vector<native_crash::Definition> definitions_;
    std::array<std::vector<Leaf>, 2> leaves_;
    std::vector<Source> sources_;
    std::vector<BhPropAnimState> states_;
    std::vector<Vertex> vertices_;
    static constexpr size_t particle_budget = 4096;
    static constexpr uint32_t removed_flag = 2, set_flag = 4;

public:
    explicit CrashExplosions(Gl &gl) : gl(gl) {}

    ~CrashExplosions() {
        if (buffer_) gl.DeleteBuffers(1, &buffer_);
        if (vao_) gl.DeleteVertexArrays(1, &vao_);
        if (shader_) gl.DeleteProgram(shader_);
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
        states_.resize(RuntimePropCopies::entity_limit);
        vertices_.reserve(native_crash::birth_limit * 6);
        prepare_graphics();
    }

    void
    draw(const native::Matrix &vp,
         BhContext *core,
         const RuntimePropCopies &copies,
         const native_render::Vec3 &right,
         const native_render::Vec3 &up,
         double now,
         bool visible) {
        if (!shader_ || !visible) return;
        const auto count = bh_prop_anim_states(core, states_.data(), states_.size());
        gl.UseProgram(shader_);
        gl.UniformMatrix4fv(gl.GetUniformLocation(shader_, "viewProjection"), 1, GL_FALSE, vp.data());
        gl.ActiveTexture(GL_TEXTURE0);
        gl.Uniform1i(gl.GetUniformLocation(shader_, "map"), 0);
        gl.BindVertexArray(vao_);
        gl.BindBuffer(GL_ARRAY_BUFFER, buffer_);
        gl.Enable(GL_DEPTH_TEST);
        gl.DepthMask(GL_FALSE);
        gl.Disable(GL_CULL_FACE);
        gl.Enable(GL_BLEND);
        size_t budget = particle_budget;
        for (size_t i = 0; i < count && budget; ++i) {
            const auto &state = states_[i];
            if (!(state.flags & set_flag) || (state.flags & removed_flag) || now < state.since
                || now - state.since > native_crash::event_seconds)
                continue;
            const auto *copy = copies.find(int32_t(state.entity));
            const auto source = copy ? copy->source : state.entity;
            if (source >= sources_.size() || sources_[source].kind < 0) continue;
            const auto origin = copy ? native_crash::Point{copy->origin[0], copy->origin[1], copy->origin[2]}
                                     : sources_[source].origin;
            const auto angles = copy ? native_crash::Point{copy->angles[0], copy->angles[1], copy->angles[2]}
                                     : sources_[source].angles;
            const uint32_t seed = (state.entity + 1) * 31u ^ uint32_t(std::floor(double(state.since) * 1000 + .5));
            for (const auto &leaf : leaves_[size_t(sources_[source].kind)])
                draw_leaf(leaf, now - state.since, seed, origin, angles, right, up, budget);
        }
        gl.DepthMask(GL_TRUE);
        gl.Disable(GL_BLEND);
        gl.BlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    }

private:
    template <class Resolve>
    void collect(const std::string &name, double delay, std::vector<Leaf> &leaves, Resolve &resolve, size_t depth) {
        if (depth > 32) throw std::runtime_error("Crash particle child cycle");
        for (size_t i = 0; i < definitions_.size(); ++i) {
            const auto &d = definitions_[i];
            if (d.name != name) continue;
            if (!d.births.empty()) {
                const auto texture = resolve(d.material);
                if (texture) leaves.push_back({i, delay, texture});
            }
            for (const auto &[child, offset] : d.children)
                collect(child, delay + offset, leaves, resolve, depth + 1);
            return;
        }
        throw std::runtime_error("Missing authored Crash particle child: " + name);
    }

    void draw_leaf(
            const Leaf &leaf,
            double age,
            uint32_t seed,
            native_crash::Point origin,
            native_crash::Point angles,
            const native_render::Vec3 &right,
            const native_render::Vec3 &up,
            size_t &budget
    ) {
        const auto &definition = definitions_[leaf.definition];
        vertices_.clear();
        for (size_t i = 0; i < definition.births.size() && budget; ++i) {
            auto particle = native_crash::sample(
                    definition, uint32_t(i), age - leaf.delay - definition.births[i], seed, angles
            );
            if (!particle) continue;
            for (size_t k = 0; k < 3; ++k)
                particle->position[k] += origin[k];
            append(*particle, definition, right, up);
            --budget;
        }
        if (vertices_.empty()) return;
        gl.BindTexture(GL_TEXTURE_2D, leaf.texture);
        gl.BlendFunc(GL_SRC_ALPHA, definition.additive ? GL_ONE : GL_ONE_MINUS_SRC_ALPHA);
        gl.BufferData(GL_ARRAY_BUFFER, vertices_.size() * sizeof(Vertex), vertices_.data(), GL_STREAM_DRAW);
        gl.DrawArrays(GL_TRIANGLES, 0, GLsizei(vertices_.size()));
    }

    void
    append(const native_crash::Sample &particle,
           const native_crash::Definition &d,
           const native_render::Vec3 &right,
           const native_render::Vec3 &up) {
        constexpr std::array<std::array<double, 2>, 4> signs{{{-1, -1}, {1, -1}, {1, 1}, {-1, 1}}};
        constexpr std::array<size_t, 6> triangles{0, 1, 2, 0, 2, 3};
        std::array<Vertex, 4> corners{};
        double vx = 0, vy = 0;
        for (size_t k = 0; k < 3; ++k) {
            vx += right[k] * particle.velocity[k];
            vy += up[k] * particle.velocity[k];
        }
        const double length = std::hypot(vx, vy);
        const double dx = length > 0 ? vx / length : 0, dy = length > 0 ? vy / length : 1;
        const double trail =
                d.trail_renderer ? std::clamp(
                                           std::hypot(particle.velocity[0], particle.velocity[1], particle.velocity[2])
                                                   * particle.trail,
                                           d.min_trail,
                                           d.max_trail
                                   )
                                 : 0;
        const double stretch = trail > 0 ? std::max(1., trail / std::max(particle.radius, .01)) : 1;
        const double cs = std::cos(particle.roll), sn = std::sin(particle.roll);
        for (size_t i = 0; i < corners.size(); ++i) {
            double x = cs * signs[i][0] + sn * signs[i][1], y = -sn * signs[i][0] + cs * signs[i][1];
            if (trail > 0) {
                const auto next_x = -dy * x + dx * y * stretch;
                y = dx * x + dy * y * stretch;
                x = next_x;
            }
            for (size_t k = 0; k < 3; ++k) {
                const auto offset = d.horizontal ? (k == 0 ? x : k == 1 ? y : 0) : right[k] * x + up[k] * y;
                corners[i].position[k] = float(particle.position[k] + particle.radius * offset);
                corners[i].tint[k] = float(particle.color[k]);
            }
            corners[i].tint[3] = float(particle.alpha);
            corners[i].uv[0] = float(particle.uv[i == 1 || i == 2 ? 2 : 0]);
            corners[i].uv[1] = float(particle.uv[i < 2 ? 3 : 1]);
        }
        for (const auto i : triangles)
            vertices_.push_back(corners[i]);
    }

    void prepare_graphics() {
        const char *vertex = R"(#version 330 core
layout(location=0) in vec3 position; layout(location=1) in vec4 tint; layout(location=2) in vec2 texcoord;
uniform mat4 viewProjection; out vec4 vTint; out vec2 uv;
void main(){gl_Position=viewProjection*vec4(position,1);vTint=tint;uv=texcoord;}
)";
        const char *fragment = R"(#version 330 core
uniform sampler2D map; in vec4 vTint; in vec2 uv; out vec4 color;
vec3 srgb(vec3 c){return mix(12.92*c,1.055*pow(max(c,vec3(0)),vec3(1./2.4))-.055,step(vec3(.0031308),c));}
void main(){vec4 p=texture(map,uv)*vTint;if(p.a<.002)discard;color=vec4(srgb(p.rgb),p.a);}
)";
        shader_ = link_program(gl, vertex, fragment);
        gl.GenVertexArrays(1, &vao_);
        gl.GenBuffers(1, &buffer_);
        gl.BindVertexArray(vao_);
        gl.BindBuffer(GL_ARRAY_BUFFER, buffer_);
        constexpr int sizes[] = {3, 4, 2};
        constexpr size_t offsets[] = {0, 3, 7};
        for (GLuint i = 0; i < 3; ++i) {
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
