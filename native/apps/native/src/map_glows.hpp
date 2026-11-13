#pragma once

// The map's sprites, light glows and spotlight beams (core dressing.rs places them; bh_dressing_glows), drawn as the
// website draws them (map-glows.ts, map-beams.ts), which follows CS:S:
//
// * env_sprite: a quad of its texture's size times `scale`, facing the view as its material's `$spriteorientation`
//   says, tinted by rendercolor and renderamt, blended by rendermode. Glow mode keeps its size on screen and dims with
//   distance unless renderfx is No Dissipation. Animated sprites play their VTF frames at `framerate` from the map's
//   start.
// * env_lightglow: added, the size it would have 100 units ahead of the view, faded in from MinDist to MaxDist and out
//   to OuterMaxDist, hidden from behind when one-sided.
// * point_spotlight: a ribbon of `sprites/glow_test02` from the light along its angles, turned to the view, narrowing
//   to where something stops it, brightness 64, shading out toward its end, added, fading as the view nears its line.
//
// The glow modes and light glows draw over everything, faded in and out over 0.15 s by whether the world's drawn
// opaque brushes hide their origin from the view (the core's render-only trace, a couple of dozen a frame). On a map
// without trace data they are depth tested instead, pulled toward the view by their proxy size. Additive ones fog
// towards black. Missing materials leave their glows out.

class MapGlows {
public:
    // What the renderer knows of a glow's material, or nothing when it isn't loaded.
    struct Texture {
        GLuint id = 0;
        float width = 64, height = 64;
        // Frames 1.. of an animated sprite's VTF (frame 0 is `id`).
        std::vector<GLuint> frames;
        bool additive = false, translucent = false, alpha_test = false;
        uint32_t orientation = 0;
    };

    enum class Layer { solid, blended, overlay };

    struct View {
        const native::Matrix &vp;
        const float *eye, *right, *up;
        double seconds;
        std::array<float, 3> fog_color, fog_range;
    };

    explicit MapGlows(Gl &gl) : gl_(gl) {}

    MapGlows(const MapGlows &) = delete;
    MapGlows &operator=(const MapGlows &) = delete;

    ~MapGlows() {
        for (GLuint buffer : {vbo_, ebo_, vis_buffer_, beam_vbo_, beam_ebo_})
            if (buffer) gl_.DeleteBuffers(1, &buffer);
        for (GLuint vao : {vao_, beam_vao_})
            if (vao) gl_.DeleteVertexArrays(1, &vao);
        for (GLuint program : {program_, beam_program_})
            if (program) gl_.DeleteProgram(program);
    }

    // `texture_of(material, animated)`: the material's texture (its frames when `animated`), or nullopt. `traced`: the
    // map has trace data for visibility (bh_dressing_glow_visibility answers).
    template <class TextureOf>
    void load(std::span<const BhDressingGlow> glows, TextureOf texture_of, bool traced) {
        traced_ = traced;
        build_sprites(glows, texture_of);
        build_beams(glows, texture_of);
    }

    bool empty() const { return batches_.empty() && !beam_count_; }

    size_t glow_count() const { return glow_count_; }

    size_t beam_count() const { return beam_count_; }

    // Visibility of the glows drawn over everything, from the main view, once a frame (wall clock seconds).
    void observe(const BhContext *core, const float eye[3], const native::Matrix &vp, double now) {
        if (watched_.empty()) return;
        const bool first = last_observed_ < 0;
        const double dt = first ? 1 : std::clamp(now - last_observed_, 0., 1.);
        last_observed_ = now;
        size_t budget = first ? watched_.size() : visibility_per_frame;
        for (size_t seen = 0; seen < watched_.size() && budget > 0; ++seen) {
            if (cursor_ >= watched_.size()) cursor_ = 0;
            auto &w = watched_[cursor_++];
            if (!first && !shows(w, eye, vp)) continue;
            float target = 0;
            bh_dressing_glow_visibility(core, eye[0], eye[1], eye[2], w.glow, 1, &target);
            w.target = target;
            --budget;
        }
        const float step = float(dt / visibility_fade_seconds);
        bool changed = false;
        for (auto &w : watched_) {
            const float next = first ? w.target : w.now + std::clamp(w.target - w.now, -step, step);
            if (next == w.now) continue;
            w.now = next;
            std::fill_n(vis_.begin() + std::ptrdiff_t(w.vertex), 4, next);
            changed = true;
        }
        if (changed) {
            gl_.BindBuffer(GL_ARRAY_BUFFER, vis_buffer_);
            gl_.BufferData(GL_ARRAY_BUFFER, vis_.size() * sizeof(float), vis_.data(), GL_DYNAMIC_DRAW);
        }
    }

    void draw(Layer layer, const View &view, BhContext *core) {
        if (layer == Layer::blended) draw_beams(view);
        if (batches_.empty()) return;
        gl_.UseProgram(program_);
        set_view_uniforms(program_, view);
        gl_.BindVertexArray(vao_);
        gl_.Disable(GL_CULL_FACE);
        gl_.ActiveTexture(GL_TEXTURE0);
        for (auto &batch : batches_) {
            if (layer_of(batch) != layer) continue;
            BhTransform at{};
            const auto model = batch_model(batch, core, at);
            if (!at.visible) continue;
            gl_.UniformMatrix4fv(location(program_, "model"), 1, GL_FALSE, model.data());
            gl_.Uniform1f(location(program_, "kind"), float(batch.kind));
            gl_.Uniform1f(location(program_, "orient"), float(batch.texture.orientation));
            gl_.Uniform1f(location(program_, "alphaTest"), batch.blend == Blend::test ? .5f : 0);
            gl_.Uniform1i(location(program_, "additive"), batch.blend == Blend::add);
            gl_.BindTexture(GL_TEXTURE_2D, frame_of(batch, view.seconds));
            set_blend(batch, layer);
            gl_.DrawElements(
                    GL_TRIANGLES,
                    GLsizei(batch.index_count),
                    GL_UNSIGNED_INT,
                    reinterpret_cast<void *>(uintptr_t(batch.first_index) * sizeof(uint32_t))
            );
        }
        gl_.Enable(GL_DEPTH_TEST);
        gl_.DepthMask(GL_TRUE);
        gl_.Disable(GL_BLEND);
        gl_.BlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    }

private:
    enum class Blend { add, alpha, test, opaque };

    struct Batch {
        uint32_t kind = 0, material = 0;
        Blend blend = Blend::add;
        float framerate = 0;
        int32_t parent = -1;
        bool overlay = false;
        Texture texture;
        native::Matrix spawn_inverse = native::identity();
        size_t first_index = 0, index_count = 0;
    };

    struct Watched {
        size_t glow = 0, vertex = 0;
        float now = 0, target = 0;
        BhDressingGlow data{};
    };

    static constexpr uint32_t kind_sprite = 0, kind_light_glow = 1, kind_spotlight = 2;
    static constexpr uint32_t render_normal = 0, render_glow = 3, render_trans_alpha = 4, render_world_glow = 9;
    static constexpr uint32_t fx_no_dissipation = 14;
    static constexpr float beam_brightness = 64.f / 255, beam_widest = 102.3f;
    static constexpr double visibility_fade_seconds = .15;
    static constexpr size_t visibility_per_frame = 24;
    static constexpr int glow_vertex_floats = 25, beam_vertex_floats = 14;

    Gl &gl_;
    bool traced_ = false;
    GLuint program_ = 0, vao_ = 0, vbo_ = 0, ebo_ = 0, vis_buffer_ = 0;
    GLuint beam_program_ = 0, beam_vao_ = 0, beam_vbo_ = 0, beam_ebo_ = 0;
    std::vector<Batch> batches_;
    std::vector<Watched> watched_;
    std::vector<float> vis_;
    Texture beam_texture_;
    size_t glow_count_ = 0, beam_count_ = 0, cursor_ = 0;
    double last_observed_ = -1;
    std::unordered_map<std::string, GLint> locations_;

    GLint location(GLuint program, const char *name) {
        auto key = std::to_string(program) + name;
        const auto found = locations_.find(key);
        if (found != locations_.end()) return found->second;
        const GLint value = gl_.GetUniformLocation(program, name);
        locations_.emplace(std::move(key), value);
        return value;
    }

    // The Sprite shader's blend by rendermode; Normal follows the material.
    static Blend sprite_blend(uint32_t mode, const Texture &t) {
        if (mode == render_normal)
            return t.additive ? Blend::add : t.translucent ? Blend::alpha : t.alpha_test ? Blend::test : Blend::opaque;
        if (mode == 1 || mode == 2 || mode == render_trans_alpha) return Blend::alpha;
        return Blend::add;
    }

    Layer layer_of(const Batch &batch) const {
        if (batch.overlay && traced_) return Layer::overlay;
        return batch.blend == Blend::add || batch.blend == Blend::alpha ? Layer::blended : Layer::solid;
    }

    static float srgb_to_linear(float value) {
        const float c = value / 255;
        return c <= .04045f ? c / 12.92f : std::pow((c + .055f) / 1.055f, 2.4f);
    }

    static native::Matrix rigid_inverse(const native::Matrix &m) {
        native::Matrix out = native::identity();
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                out[size_t(c * 4 + r)] = m[size_t(r * 4 + c)];
        for (int r = 0; r < 3; ++r)
            out[size_t(12 + r)] = -(out[size_t(r)] * m[12] + out[size_t(4 + r)] * m[13] + out[size_t(8 + r)] * m[14]);
        return out;
    }

    template <class TextureOf>
    void build_sprites(std::span<const BhDressingGlow> glows, TextureOf &texture_of) {
        std::map<std::string, Batch> grouped;
        std::map<std::string, std::vector<size_t>> members;
        for (size_t index = 0; index < glows.size(); ++index) {
            const auto &g = glows[index];
            if (g.kind != kind_sprite && g.kind != kind_light_glow) continue;
            if (g.kind == kind_light_glow && (g.size <= 0 || g.size2 <= 0)) continue;
            const bool animated = g.kind == kind_sprite && g.size2 > 0;
            auto texture = texture_of(g.material, animated);
            if (!texture) continue;
            const Blend blend = g.kind == kind_light_glow ? Blend::add : sprite_blend(g.render_mode, *texture);
            const float framerate = g.kind == kind_sprite && !texture->frames.empty() ? g.size2 : 0;
            const bool overlay =
                    g.kind == kind_light_glow || g.render_mode == render_glow || g.render_mode == render_world_glow;
            const auto key = std::to_string(g.kind) + ":" + std::to_string(g.material) + ":"
                             + std::to_string(int(blend)) + ":" + std::to_string(framerate) + ":"
                             + std::to_string(g.parent_model) + ":" + std::to_string(overlay);
            auto &batch = grouped[key];
            if (members[key].empty()) {
                batch = {g.kind, g.material, blend, framerate, g.parent_model, overlay, *texture};
                if (g.parent_model >= 0) {
                    BhTransform spawn{
                            {g.parent_origin[0], g.parent_origin[1], g.parent_origin[2]},
                            {g.parent_angles[0], g.parent_angles[1], g.parent_angles[2]},
                            1
                    };
                    batch.spawn_inverse = rigid_inverse(native::model_matrix(spawn));
                }
            }
            members[key].push_back(index);
        }
        if (grouped.empty()) return;
        std::vector<float> vertices;
        std::vector<uint32_t> indices;
        for (auto &[key, batch] : grouped) {
            batch.first_index = indices.size();
            for (const size_t index : members[key]) {
                const uint32_t base = uint32_t(vertices.size() / glow_vertex_floats);
                add_glow_quad(vertices, glows[index], batch);
                for (const uint32_t corner : {0u, 1u, 2u, 0u, 2u, 3u})
                    indices.push_back(base + corner);
                if (batch.overlay && traced_) watched_.push_back({index, base, 0, 0, glows[index]});
                ++glow_count_;
            }
            batch.index_count = indices.size() - batch.first_index;
            batches_.push_back(std::move(batch));
        }
        // Shown, except the traced ones, which start hidden until the first look traces them.
        vis_.assign(vertices.size() / glow_vertex_floats, 1.f);
        for (const auto &w : watched_)
            std::fill_n(vis_.begin() + std::ptrdiff_t(w.vertex), 4, 0.f);
        upload_sprites(vertices, indices);
    }

    void add_glow_quad(std::vector<float> &out, const BhDressingGlow &g, const Batch &batch) const {
        std::array<float, 2> half{};
        std::array<float, 4> color{};
        std::array<float, 4> params{}, fade{};
        std::array<float, 3> axis_u{}, axis_v{};
        if (g.kind == kind_light_glow) {
            half = {g.size, g.size2};
            color = {srgb_to_linear(g.color[0]), srgb_to_linear(g.color[1]), srgb_to_linear(g.color[2]), 1};
            fade = {g.dist[0], g.dist[1], g.dist[2], (g.spawnflags & 1) ? 1.f : 0.f};
            params = {0, 0, traced_ ? 0 : g.dist[3], 0};
            axis_u = {g.dir[0], g.dir[1], g.dir[2]};
        } else {
            const float scale = g.size > 0 ? g.size : 1;
            half = {batch.texture.width * scale / 2, batch.texture.height * scale / 2};
            const float alpha = g.render_mode == render_normal ? 1 : std::clamp(g.alpha / 255, 0.f, 1.f);
            color = {srgb_to_linear(g.color[0]), srgb_to_linear(g.color[1]), srgb_to_linear(g.color[2]), alpha};
            const bool glow_mode = g.render_mode == render_glow || g.render_mode == render_world_glow;
            params = {
                    g.render_mode == render_glow ? 1.f : 0.f,
                    g.render_mode == render_glow && g.render_fx != fx_no_dissipation ? 1.f : 0.f,
                    glow_mode && !traced_ ? std::max(g.dist[0], .5f) : 0.f,
                    0
            };
            // Oriented sprites lie in the entity's own axes: right (minus left) and up.
            const BhTransform turn{{0, 0, 0}, {g.dir[0], g.dir[1], g.dir[2]}, 1};
            const auto m = native::model_matrix(turn);
            axis_u = {-m[4], -m[5], -m[6]};
            axis_v = {m[8], m[9], m[10]};
        }
        constexpr std::array<std::array<float, 2>, 4> corners = {{{-1, -1}, {1, -1}, {1, 1}, {-1, 1}}};
        for (const auto &corner : corners) {
            out.insert(out.end(), {g.origin[0], g.origin[1], g.origin[2], corner[0], corner[1], half[0], half[1]});
            out.insert(out.end(), color.begin(), color.end());
            out.insert(out.end(), params.begin(), params.end());
            out.insert(out.end(), fade.begin(), fade.end());
            out.insert(out.end(), axis_u.begin(), axis_u.end());
            out.insert(out.end(), axis_v.begin(), axis_v.end());
        }
    }

    static GLuint vertex_array(
            Gl &gl, GLuint &vbo, GLuint &ebo, const std::vector<float> &vertices, const std::vector<uint32_t> &indices
    ) {
        GLuint vao = 0;
        gl.GenVertexArrays(1, &vao);
        gl.BindVertexArray(vao);
        gl.GenBuffers(1, &vbo);
        gl.BindBuffer(GL_ARRAY_BUFFER, vbo);
        gl.BufferData(GL_ARRAY_BUFFER, vertices.size() * sizeof(float), vertices.data(), GL_STATIC_DRAW);
        gl.GenBuffers(1, &ebo);
        gl.BindBuffer(GL_ELEMENT_ARRAY_BUFFER, ebo);
        gl.BufferData(GL_ELEMENT_ARRAY_BUFFER, indices.size() * sizeof(uint32_t), indices.data(), GL_STATIC_DRAW);
        return vao;
    }

    static void attributes(Gl &gl, std::span<const int> sizes, int stride) {
        size_t offset = 0;
        for (size_t location = 0; location < sizes.size(); ++location) {
            gl.EnableVertexAttribArray(GLuint(location));
            gl.VertexAttribPointer(
                    GLuint(location),
                    sizes[location],
                    GL_FLOAT,
                    GL_FALSE,
                    GLsizei(stride * sizeof(float)),
                    reinterpret_cast<void *>(offset * sizeof(float))
            );
            offset += size_t(sizes[location]);
        }
    }

    void upload_sprites(const std::vector<float> &vertices, const std::vector<uint32_t> &indices) {
        program_ = link_program(gl_, glow_vertex_shader, glow_fragment_shader);
        vao_ = vertex_array(gl_, vbo_, ebo_, vertices, indices);
        // position, corner, size, color, params, fade, axisU, axisV
        constexpr std::array<int, 8> sizes = {3, 2, 2, 4, 4, 4, 3, 3};
        attributes(gl_, sizes, glow_vertex_floats);
        gl_.GenBuffers(1, &vis_buffer_);
        gl_.BindBuffer(GL_ARRAY_BUFFER, vis_buffer_);
        gl_.BufferData(GL_ARRAY_BUFFER, vis_.size() * sizeof(float), vis_.data(), GL_DYNAMIC_DRAW);
        constexpr GLuint vis_location = 8;
        gl_.EnableVertexAttribArray(vis_location);
        gl_.VertexAttribPointer(vis_location, 1, GL_FLOAT, GL_FALSE, sizeof(float), nullptr);
        gl_.BindVertexArray(0);
    }

    // CPointSpotlight's beam: from the light along its angles to what stops it (`size2`), `size` wide at the light.
    template <class TextureOf>
    void build_beams(std::span<const BhDressingGlow> glows, TextureOf &texture_of) {
        std::vector<float> vertices;
        std::vector<uint32_t> indices;
        for (const auto &g : glows) {
            if (g.kind != kind_spotlight || g.size <= 0 || g.size2 <= 0) continue;
            if (!beam_texture_.id) {
                auto texture = texture_of(g.material, false);
                if (!texture) return;
                beam_texture_ = *texture;
            }
            const float longest = g.dist[0] > 0 ? g.dist[0] : g.size2;
            const float end_width = std::min(beam_widest, g.size * (g.size2 / longest));
            const std::array<float, 3> color = {
                    srgb_to_linear(g.color[0]) * beam_brightness,
                    srgb_to_linear(g.color[1]) * beam_brightness,
                    srgb_to_linear(g.color[2]) * beam_brightness
            };
            const uint32_t base = uint32_t(vertices.size() / beam_vertex_floats);
            constexpr std::array<std::array<float, 2>, 4> corners = {{{0, -1}, {0, 1}, {1, 1}, {1, -1}}};
            for (const auto &along : corners) {
                vertices.insert(vertices.end(), {g.origin[0], g.origin[1], g.origin[2], g.dir[0], g.dir[1], g.dir[2]});
                vertices.insert(vertices.end(), {g.size2, g.size, end_width, along[0], along[1]});
                vertices.insert(vertices.end(), color.begin(), color.end());
            }
            for (const uint32_t corner : {0u, 1u, 2u, 0u, 2u, 3u})
                indices.push_back(base + corner);
            ++beam_count_;
        }
        if (!beam_count_) return;
        beam_program_ = link_program(gl_, beam_vertex_shader, beam_fragment_shader);
        beam_vao_ = vertex_array(gl_, beam_vbo_, beam_ebo_, vertices, indices);
        // position, dir, beam (length, start width, end width), along, color
        constexpr std::array<int, 5> sizes = {3, 3, 3, 2, 3};
        attributes(gl_, sizes, beam_vertex_floats);
        gl_.BindVertexArray(0);
    }

    // One draw call, added, depth tested without writing depth, with the world's blended surfaces.
    void draw_beams(const View &view) {
        if (!beam_count_) return;
        gl_.UseProgram(beam_program_);
        set_view_uniforms(beam_program_, view);
        gl_.Uniform1i(location(beam_program_, "additive"), 1);
        gl_.BindVertexArray(beam_vao_);
        gl_.Disable(GL_CULL_FACE);
        gl_.ActiveTexture(GL_TEXTURE0);
        gl_.BindTexture(GL_TEXTURE_2D, beam_texture_.id);
        gl_.Enable(GL_BLEND);
        gl_.BlendFunc(GL_SRC_ALPHA, GL_ONE);
        gl_.Enable(GL_DEPTH_TEST);
        gl_.DepthMask(GL_FALSE);
        gl_.DrawElements(GL_TRIANGLES, GLsizei(beam_count_ * 6), GL_UNSIGNED_INT, nullptr);
        gl_.DepthMask(GL_TRUE);
        gl_.Disable(GL_BLEND);
        gl_.BlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    }

    void set_view_uniforms(GLuint program, const View &view) {
        gl_.UniformMatrix4fv(location(program, "viewProjection"), 1, GL_FALSE, view.vp.data());
        gl_.Uniform3fv(location(program, "cameraPosition"), 1, view.eye);
        gl_.Uniform3fv(location(program, "viewRight"), 1, view.right);
        gl_.Uniform3fv(location(program, "viewUp"), 1, view.up);
        gl_.Uniform3fv(location(program, "fogColor"), 1, view.fog_color.data());
        gl_.Uniform3fv(location(program, "fogRange"), 1, view.fog_range.data());
        gl_.Uniform1i(location(program, "map"), 0);
        const auto identity = native::identity();
        gl_.UniformMatrix4fv(location(program, "model"), 1, GL_FALSE, identity.data());
    }

    // Sprites riding a brush entity follow it: its transform now, after the one it spawned with.
    native::Matrix batch_model(const Batch &batch, BhContext *core, BhTransform &at) const {
        at.visible = 1;
        if (batch.parent < 0) return native::identity();
        if (!bh_model_transform(core, uint32_t(batch.parent), &at)) {
            at.visible = 1;
            return native::identity();
        }
        return native::multiply(native::model_matrix(at), batch.spawn_inverse);
    }

    GLuint frame_of(const Batch &batch, double seconds) const {
        if (batch.framerate <= 0 || batch.texture.frames.empty()) return batch.texture.id;
        const size_t count = batch.texture.frames.size() + 1;
        const size_t frame = size_t(std::floor(std::max(0., seconds) * batch.framerate)) % count;
        return frame ? batch.texture.frames[frame - 1] : batch.texture.id;
    }

    void set_blend(const Batch &batch, Layer layer) {
        const bool blended = batch.blend == Blend::add || batch.blend == Blend::alpha;
        if (blended) {
            gl_.Enable(GL_BLEND);
            gl_.BlendFunc(GL_SRC_ALPHA, batch.blend == Blend::add ? GL_ONE : GL_ONE_MINUS_SRC_ALPHA);
        } else
            gl_.Disable(GL_BLEND);
        gl_.DepthMask(blended ? GL_FALSE : GL_TRUE);
        if (layer == Layer::overlay)
            gl_.Disable(GL_DEPTH_TEST);
        else
            gl_.Enable(GL_DEPTH_TEST);
    }

    // Worth a trace this frame: in the view (generous bounds, as a glow keeps its size on screen) and, for a light
    // glow, within its distance range.
    bool shows(const Watched &w, const float eye[3], const native::Matrix &vp) const {
        const auto &g = w.data;
        const float dx = g.origin[0] - eye[0], dy = g.origin[1] - eye[1], dz = g.origin[2] - eye[2];
        const float distance = std::hypot(dx, dy, dz);
        if (g.kind == kind_light_glow && light_glow_fade(distance, g.dist[0], g.dist[1], g.dist[2]) <= 0) return false;
        constexpr float smallest_radius = 64;
        const float radius = std::max(smallest_radius, distance * .5f);
        for (int plane = 0; plane < 6; ++plane) {
            const int row = plane / 2;
            const float sign = plane % 2 ? -1.f : 1.f;
            std::array<float, 4> p{};
            for (int c = 0; c < 4; ++c)
                p[size_t(c)] = vp[size_t(c * 4 + 3)] + sign * vp[size_t(c * 4 + row)];
            const float length = std::hypot(p[0], p[1], p[2]);
            if (length <= 0) continue;
            if ((p[0] * g.origin[0] + p[1] * g.origin[1] + p[2] * g.origin[2] + p[3]) / length < -radius) return false;
        }
        return true;
    }

public:
    // C_LightGlowOverlay: in from MinDist to MaxDist, then out to OuterMaxDist when that is beyond MaxDist.
    static float light_glow_fade(float distance, float fade_in, float full, float fade_out) {
        if (fade_out > full && distance > full) return 1 - std::clamp((distance - full) / (fade_out - full), 0.f, 1.f);
        return std::clamp((distance - fade_in) / std::max(full - fade_in, 1e-3f), 0.f, 1.f);
    }

private:
    // The website's map-glows.ts shader in Source space (z up). params: x keeps its size on screen, y dims with
    // distance, z pulls the quad toward the view (untraced maps).
    static constexpr const char *glow_vertex_shader = R"(#version 330 core
layout(location=0) in vec3 position;layout(location=1) in vec2 corner;layout(location=2) in vec2 size;
layout(location=3) in vec4 color;layout(location=4) in vec4 params;layout(location=5) in vec4 fade;
layout(location=6) in vec3 axisU;layout(location=7) in vec3 axisV;layout(location=8) in float vis;
uniform mat4 viewProjection,model;uniform vec3 cameraPosition,viewRight,viewUp;uniform float kind,orient;
out vec2 uv;out vec4 tint;out float depth;
void main(){
 vec3 c=(model*vec4(position,1)).xyz;vec3 toCam=cameraPosition-c;float dist=max(length(toCam),1e-3);
 vec2 hs=size;vec4 col=color*vis;
 if(kind<.5){
  if(params.x>.5)hs*=dist/200.;
  if(params.y>.5)col.rgb*=clamp(19000./(dist*dist),.05,1.);
 }else{
  hs*=dist/100.;
  float f=(fade.z>fade.y&&dist>fade.y)?1.-clamp((dist-fade.y)/(fade.z-fade.y),0.,1.):clamp((dist-fade.x)/max(fade.y-fade.x,1e-3),0.,1.);
  if(fade.w>.5&&dot(toCam,mat3(model)*axisU)<0.)f=0.;
  col.rgb*=f;
 }
 if(max(col.r,max(col.g,col.b))*col.a<=0.){gl_Position=vec4(2,2,2,1);uv=vec2(0);tint=vec4(0);depth=0.;return;}
 vec3 right,up;
 if(orient>1.5){right=normalize(mat3(model)*axisU);up=normalize(mat3(model)*axisV);}
 else if(orient>.5){up=vec3(0,0,1);right=normalize(cross(up,toCam));}
 else{right=viewRight;up=viewUp;}
 vec3 p=c+right*corner.x*hs.x+up*corner.y*hs.y;
 if(params.z>0.)p+=normalize(toCam)*min(params.z,.5*dist);
 gl_Position=viewProjection*vec4(p,1);depth=gl_Position.w;
 uv=vec2(corner.x*.5+.5,.5-corner.y*.5);tint=col;
}
)";

    // Gamma-space output and fog, as the website's glows (the world's fog, additive ones towards black).
    static constexpr const char *glow_fragment_shader = R"(#version 330 core
in vec2 uv;in vec4 tint;in float depth;uniform sampler2D map;uniform float alphaTest;uniform bool additive;
uniform vec3 fogColor,fogRange;out vec4 color;
vec3 encodeOut(vec3 c){c=max(c,vec3(0));return mix(c*12.92,1.055*pow(c,vec3(1./2.4))-.055,step(vec3(.0031308),c));}
void main(){
 vec4 c=texture(map,uv)*tint;if(c.a<=alphaTest)discard;
 vec3 col=encodeOut(c.rgb);
 if(fogRange.z>0.){float f=clamp(min(fogRange.z,(depth-fogRange.x)/max(fogRange.y-fogRange.x,1e-3)),0.,1.);col=mix(col,additive?vec3(0):fogColor,f);}
 color=vec4(col,c.a);
}
)";

    // The website's map-beams.ts shader in Source space.
    static constexpr const char *beam_vertex_shader = R"(#version 330 core
layout(location=0) in vec3 position;layout(location=1) in vec3 dir;layout(location=2) in vec3 beam;
layout(location=3) in vec2 along;layout(location=4) in vec3 color;
uniform mat4 viewProjection,model;uniform vec3 cameraPosition;
out vec2 uv;out vec4 tint;out float depth;
void main(){
 vec3 s=(model*vec4(position,1)).xyz;vec3 d=normalize(mat3(model)*dir);vec3 p=s+d*beam.x*along.x;
 vec3 n=cross(p-cameraPosition,d);float nl=length(n);
 vec3 toEye=cameraPosition-s;float line=length(toEye-d*dot(toEye,d));float threshold=beam.y*4.;
 float fade=line>=threshold?1.:clamp((line-beam.y)/max(threshold-beam.y,1e-3),0.,1.);
 tint=vec4(color*fade*(1.-along.x),1);
 if(nl<1e-4||fade<=0.){gl_Position=vec4(2,2,2,1);uv=vec2(0);depth=0.;return;}
 float w=mix(beam.y,beam.z,along.x)*.5;
 gl_Position=viewProjection*vec4(p+n/nl*w*along.y,1);depth=gl_Position.w;
 uv=vec2(along.y*.5+.5,along.x);
}
)";

    static constexpr const char *beam_fragment_shader = R"(#version 330 core
in vec2 uv;in vec4 tint;in float depth;uniform sampler2D map;uniform vec3 fogColor,fogRange;out vec4 color;
vec3 encodeOut(vec3 c){c=max(c,vec3(0));return mix(c*12.92,1.055*pow(c,vec3(1./2.4))-.055,step(vec3(.0031308),c));}
void main(){
 vec4 t=texture(map,uv);vec3 col=encodeOut(t.rgb*tint.rgb);
 if(fogRange.z>0.){float f=clamp(min(fogRange.z,(depth-fogRange.x)/max(fogRange.y-fogRange.x,1e-3)),0.,1.);col=mix(col,vec3(0),f);}
 color=vec4(col,t.a);
}
)";
};
