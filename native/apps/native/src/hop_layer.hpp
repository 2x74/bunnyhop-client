#pragma once
// Draws hop effects (web player/hop-layer.ts HopLayer): a fixed ring of particle records the GPU animates from their
// age, one instanced draw for every burst, and per emitter a clock slot. With nothing alive it draws nothing, and with
// hop effects off it is never made.
#include "hop_effects.hpp"
#include "native_math.hpp"
#include "player_material.hpp"

namespace native_hop {

// three.js (x, y, z) is Source (x, -z, y).
inline native::Matrix source_from_web_matrix() {
    return {1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1};
}

// The camera's view of three.js world space: rotation from the view-projection's rows, translation from the eye.
inline native::Matrix web_model_view(const native::Matrix &view_projection, const float eye[3]) {
    auto view = native_render::web_view(view_projection);
    const auto at = native_render::to_web_space(eye);
    for (int r = 0; r < 3; ++r)
        view[size_t(12 + r)] = -(view[size_t(r)] * at[0] + view[size_t(4 + r)] * at[1] + view[size_t(8 + r)] * at[2]);
    return view;
}

// The inverse of a rotation and translation, taken back to Source space: projection = vp * this.
inline native::Matrix inverse_rigid(const native::Matrix &m) {
    native::Matrix inverse = native::identity();
    for (int r = 0; r < 3; ++r)
        for (int c = 0; c < 3; ++c)
            inverse[size_t(c * 4 + r)] = m[size_t(r * 4 + c)];
    for (int r = 0; r < 3; ++r)
        inverse[size_t(12 + r)] =
                -(inverse[size_t(r)] * m[12] + inverse[size_t(4 + r)] * m[13] + inverse[size_t(8 + r)] * m[14]);
    return native::multiply(source_from_web_matrix(), inverse);
}

class Layer {
    Gl &gl;
    const Recipes &recipes;
    GLuint program = 0, vao = 0, quad = 0, quad_indices = 0, instances = 0;
    GLint clock_location = -1, model_view_location = -1, projection_location = -1;
    std::vector<float> records;
    std::vector<float> clocks;
    std::vector<double> until;
    std::vector<bool> used;
    size_t next = 0;
    size_t dirty_from = SIZE_MAX, dirty_to = 0;
    int frame_bursts = 0;

    static constexpr size_t attributes = record_floats / 4;

public:
    Layer(Gl &gl, const Recipes &recipes, const std::filesystem::path &assets)
        : gl(gl)
        , recipes(recipes)
        , records(recipes.pool * record_floats, 0.f)
        , clocks(recipes.slots, 0.f)
        , until(recipes.slots, -1e18)
        , used(recipes.slots, false) {
        const auto vertex = native_render::PlayerShaderSources::read(assets / "hop-vertex.glsl");
        const auto fragment = native_render::PlayerShaderSources::read(assets / "hop-fragment.glsl");
        program = link_program(gl, vertex.c_str(), fragment.c_str());
        clock_location = gl.GetUniformLocation(program, "uClock");
        model_view_location = gl.GetUniformLocation(program, "modelViewMatrix");
        projection_location = gl.GetUniformLocation(program, "projectionMatrix");
        create_buffers();
    }

    Layer(const Layer &) = delete;
    Layer &operator=(const Layer &) = delete;

    ~Layer() {
        gl.DeleteBuffers(1, &instances);
        gl.DeleteBuffers(1, &quad);
        gl.DeleteBuffers(1, &quad_indices);
        gl.DeleteVertexArrays(1, &vao);
        gl.DeleteProgram(program);
    }

    // A clock slot for an emitter, or none when all are taken.
    std::optional<int> claim() {
        for (size_t slot = 0; slot < used.size(); ++slot)
            if (!used[slot]) {
                used[slot] = true;
                until[slot] = -1e18;
                return int(slot);
            }
        return std::nullopt;
    }

    // Gives a slot back; its pieces die at once.
    void release(int slot) {
        if (slot < 0 || size_t(slot) >= used.size() || !used[size_t(slot)]) return;
        used[size_t(slot)] = false;
        until[size_t(slot)] = -1e18;
        constexpr size_t life = 7, clock_slot = 24, born = 3;
        for (size_t i = 0; i < recipes.pool; ++i) {
            float *record = records.data() + i * record_floats;
            if (record[life] > 0 && record[clock_slot] == float(slot)) {
                record[life] = 0;
                record[born] = 0;
                mark(i, 1);
            }
        }
    }

    void set_clock(int slot, double seconds) {
        if (slot < 0 || size_t(slot) >= clocks.size()) return;
        clocks[size_t(slot)] = float(seconds);
        if (seconds > until[size_t(slot)]) until[size_t(slot)] = -1e18;
    }

    bool alive() const {
        for (size_t slot = 0; slot < until.size(); ++slot)
            if (until[slot] > clocks[slot]) return true;
        return false;
    }

    // A burst of `parts` at `s`; false when this frame's cap is reached.
    bool burst(const std::vector<Part> &parts, const Spawn &s) {
        if (s.slot < 0 || size_t(s.slot) >= used.size() || !used[size_t(s.slot)]) return false;
        if (frame_bursts >= recipes.frame_cap) return false;
        ++frame_bursts;
        double last = s.t;
        spawn(parts, recipes, s, hop_seed(s.x, s.z, s.t), [&](const Record &record) {
            std::copy(record.begin(), record.end(), records.begin() + long(next * record_floats));
            last = std::max(last, double(record[3]) + record[7]);
            mark(next, 1);
            next = (next + 1) % recipes.pool;
        });
        until[size_t(s.slot)] = std::max(until[size_t(s.slot)], last);
        return true;
    }

    void clear() {
        std::fill(records.begin(), records.end(), 0.f);
        std::fill(until.begin(), until.end(), -1e18);
        mark(0, recipes.pool);
    }

    // Map load: one draw of the (all dead) pool with colour and depth writes off, so the driver finishes the program's
    // draw-time state now and not in the frame of the first hop effect (web hop-layer.ts prewarmHopLayer).
    void prewarm() {
        dirty_from = 0;
        dirty_to = recipes.pool;
        upload();
        const native::Matrix identity{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
        gl.UseProgram(program);
        gl.Uniform1fv(clock_location, GLsizei(clocks.size()), clocks.data());
        gl.UniformMatrix4fv(model_view_location, 1, GL_FALSE, identity.data());
        gl.UniformMatrix4fv(projection_location, 1, GL_FALSE, identity.data());
        gl.ColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_FALSE);
        gl.DepthMask(GL_FALSE);
        gl.BindVertexArray(vao);
        gl.DrawElementsInstanced(GL_TRIANGLES, 6, GL_UNSIGNED_INT, nullptr, 1);
        gl.BindVertexArray(0);
        gl.ColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
        gl.DepthMask(GL_TRUE);
    }

    // Draws every live piece. `view_projection` and `eye` are the frame's camera (Source space).
    void draw(const native::Matrix &view_projection, const float eye[3]) {
        frame_bursts = 0;
        if (!alive()) return;
        upload();
        const auto model_view = web_model_view(view_projection, eye);
        const auto projection = native::multiply(view_projection, inverse_rigid(model_view));
        gl.UseProgram(program);
        gl.Uniform1fv(clock_location, GLsizei(clocks.size()), clocks.data());
        gl.UniformMatrix4fv(model_view_location, 1, GL_FALSE, model_view.data());
        gl.UniformMatrix4fv(projection_location, 1, GL_FALSE, projection.data());
        gl.Enable(GL_BLEND);
        gl.BlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
        gl.DepthMask(GL_FALSE);
        gl.Enable(GL_DEPTH_TEST);
        gl.Disable(GL_CULL_FACE);
        gl.Enable(GL_POLYGON_OFFSET_FILL);
        gl.PolygonOffset(-1, -2);
        gl.BindVertexArray(vao);
        gl.DrawElementsInstanced(GL_TRIANGLES, 6, GL_UNSIGNED_INT, nullptr, GLsizei(recipes.pool));
        gl.Disable(GL_POLYGON_OFFSET_FILL);
        gl.DepthMask(GL_TRUE);
        gl.Disable(GL_BLEND);
    }

private:
    void create_buffers() {
        constexpr float corners[] = {-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0};
        constexpr GLuint order[] = {0, 1, 2, 2, 1, 3};
        gl.GenVertexArrays(1, &vao);
        gl.BindVertexArray(vao);
        gl.GenBuffers(1, &quad);
        gl.BindBuffer(GL_ARRAY_BUFFER, quad);
        gl.BufferData(GL_ARRAY_BUFFER, sizeof(corners), corners, GL_STATIC_DRAW);
        gl.EnableVertexAttribArray(0);
        gl.VertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 3 * sizeof(float), nullptr);
        gl.GenBuffers(1, &quad_indices);
        gl.BindBuffer(GL_ELEMENT_ARRAY_BUFFER, quad_indices);
        gl.BufferData(GL_ELEMENT_ARRAY_BUFFER, sizeof(order), order, GL_STATIC_DRAW);
        gl.GenBuffers(1, &instances);
        gl.BindBuffer(GL_ARRAY_BUFFER, instances);
        gl.BufferData(GL_ARRAY_BUFFER, GLsizeiptr(records.size() * sizeof(float)), records.data(), GL_DYNAMIC_DRAW);
        for (GLuint a = 0; a < attributes; ++a) {
            gl.EnableVertexAttribArray(a + 1);
            gl.VertexAttribPointer(
                    a + 1,
                    4,
                    GL_FLOAT,
                    GL_FALSE,
                    GLsizei(record_floats * sizeof(float)),
                    reinterpret_cast<void *>(size_t(a) * 4 * sizeof(float))
            );
            gl.VertexAttribDivisor(a + 1, 1);
        }
        gl.BindVertexArray(0);
    }

    void mark(size_t from, size_t count) {
        dirty_from = std::min(dirty_from, from);
        dirty_to = std::max(dirty_to, from + count);
    }

    void upload() {
        if (dirty_from >= dirty_to) return;
        gl.BindBuffer(GL_ARRAY_BUFFER, instances);
        gl.BufferSubData(
                GL_ARRAY_BUFFER,
                GLintptr(dirty_from * record_floats * sizeof(float)),
                GLsizeiptr((dirty_to - dirty_from) * record_floats * sizeof(float)),
                records.data() + dirty_from * record_floats
        );
        dirty_from = SIZE_MAX;
        dirty_to = 0;
    }
};

}  // namespace native_hop
