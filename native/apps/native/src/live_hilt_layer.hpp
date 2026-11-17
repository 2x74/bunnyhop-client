#pragma once
// Draws a living hilt in first person (web viewmodel/hilts/live/index.ts LiveHilt): the held design's lit pieces and
// its additive glow, two more meshes on the knife's own skeleton, moved each frame by live_hilts.hpp. Nothing is
// loaded onto the GPU, compiled or drawn while no living hilt is held. Other players show the hilt's repainted grip,
// guard and pommel only (the ordinary hilt skin), as on the website.
#include "live_hilts.hpp"
#include "native_math.hpp"
#include "nlohmann/json.hpp"
#include "player_material.hpp"
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <vector>
#include <zlib.h>

namespace native_hilt {

// What the hilt reacts to this frame (the viewmodel's clock and input, as viewmodel.ts passes LiveHilt.update).
struct FrameInput {
    double dt = 0, clock = 0;
    PlayInput play;
    bool inspecting = false, still = false, mirrored = false;
};

// Where and how the knife is drawn this frame.
struct DrawInput {
    native::Matrix projection{}, model{};
    // The knife bone's skinning matrix (3x4 row-major), for the Watcher's look.
    std::array<float, 12> knife_skin{};
    std::array<float, 3> offset{}, map_light{};
    float mirror = 1;
    int cosmetics_tier = 2;
    GLint reflection_unit = 0;
};

class Layer {
public:
    // A build without the living hilts' assets (an older asset folder) draws none.
    Layer(Gl &gl, const std::filesystem::path &assets) : gl(gl), root(assets) {
        std::ifstream file(assets / "live-hilts.json");
        if (!file) return;
        file >> metadata;
        std::ifstream blob_file(assets / "live-hilts.bin", std::ios::binary);
        blob.assign(std::istreambuf_iterator<char>(blob_file), {});
        const auto &bind = metadata.at("knifeBind");
        for (size_t k = 0; k < knife_bind.size(); k++)
            knife_bind[k] = bind.at(k).get<float>();
        pieces.emplace(knife_bind);
    }

    Layer(const Layer &) = delete;
    Layer &operator=(const Layer &) = delete;

    ~Layer() {
        release();
        if (lit_program) gl.DeleteProgram(lit_program);
        if (glow_program) gl.DeleteProgram(glow_program);
    }

    bool active() const { return design.has_value(); }

    // The hilt id worn and the knife in hand; a hilt that isn't a living one clears the layer.
    void set(const std::string &hilt, const std::string &knife) {
        if (hilt == worn_hilt && knife == worn_knife) return;
        worn_hilt = hilt;
        worn_knife = knife;
        release();
        const auto found = design_named(hilt);
        if (!found || metadata.is_null()) return;
        const auto &knives = metadata.at("designs").at(hilt);
        if (!knives.contains(knife)) return;
        const auto &entry = knives.at(knife);
        lit = upload(entry.at("lit"), metadata.at("litLayout"));
        glow = upload(entry.at("glow"), metadata.at("glowLayout"));
        pivots = pivots_of(entry.at("pivots"));
        design = found;
        pieces.emplace(knife_bind);
        reset();
        animate(Design(*design), signals, *pieces, memory, pivots, 0);
    }

    // Back to the start: a replay seek, an export's first frame (viewmodel.ts idle()).
    void reset() {
        signals.reset();
        memory = {};
    }

    void update(const FrameInput &in) {
        if (!design) return;
        signals.still = in.still;
        signals.update(in.dt, in.clock, in.play, in.inspecting);
        animate(*design, signals, *pieces, memory, pivots, in.dt);
    }

    void draw(const DrawInput &in) {
        if (!design || (!lit.indices && !glow.indices)) return;
        if (!lit_program) compile();
        if (*design == Design::watcher) designs::watcher_look(camera_in_knife(in), pivots, *pieces, memory);
        if (lit.indices) draw_lit(in);
        if (glow.indices) draw_glow(in);
    }

private:
    struct Mesh {
        GLuint vao = 0, vbo = 0, ebo = 0;
        GLsizei indices = 0;
    };

    struct Program {
        GLint projection = -1, model = -1, model_matrix = -1, view_matrix = -1, camera = -1, offset = -1, mirror = -1;
        GLint bones = -1, piece = -1, morph = -1, chan = -1, live = -1, live_mirror = -1, tier = -1, env_on = -1;
        GLint env = -1, map_light = -1, model_view = -1, glow_projection = -1;
    };

    // Every piece rides on one bone with its whole weight: skinWeight is the constant (1, 0, 0, 0), set per draw (a
    // constant attribute is context state, not the vertex array's).
    static constexpr GLuint skin_weight_location = 4;
    Gl &gl;
    std::filesystem::path root;
    nlohmann::json metadata;
    std::vector<uint8_t> blob;
    std::array<float, 12> knife_bind{};
    std::string worn_hilt, worn_knife;
    std::optional<Design> design;
    Mesh lit, glow;
    Pivots pivots;
    PlaySignals signals;
    Memory memory;
    std::optional<Pieces> pieces;
    GLuint lit_program = 0, glow_program = 0;
    Program lit_uniforms, glow_uniforms;

    static Pivots pivots_of(const nlohmann::json &p) {
        Pivots out;
        const auto point = [&](const char *key, V3 &into) {
            if (!p.contains(key)) return;
            for (size_t k = 0; k < 3; k++)
                into[k] = p.at(key).at(k).get<double>();
        };
        point("eye", out.eye);
        point("balance", out.balance);
        point("escape", out.escape);
        point("gear", out.gear);
        point("lure", out.lure);
        point("tipRight", out.tip_right);
        point("tipLeft", out.tip_left);
        point("edgeRight", out.edge_right);
        point("edgeLeft", out.edge_left);
        out.flower_z = p.value("flower", 0.);
        out.grip_center = p.value("gripCenter", 0.);
        out.grip_half = p.value("gripHalf", 0.);
        return out;
    }

    // One exported block: interleaved vertices then 32-bit indices, deflated.
    Mesh upload(const nlohmann::json &block, const nlohmann::json &layout) {
        if (block.is_null()) return {};
        const size_t offset = block.at("offset"), bytes = block.at("bytes");
        const size_t vertices = block.at("vertices"), indices = block.at("indices");
        size_t stride = 0;
        for (const auto &attribute : layout)
            stride += attribute.at(1).get<size_t>();
        if (offset + bytes > blob.size()) throw std::runtime_error("Living hilt assets are truncated");
        std::vector<uint8_t> raw(vertices * stride * 4 + indices * 4);
        uLongf size = uLongf(raw.size());
        if (uncompress(raw.data(), &size, blob.data() + offset, uLong(bytes)) != Z_OK || size != raw.size())
            throw std::runtime_error("Living hilt assets are damaged");
        Mesh mesh;
        mesh.indices = GLsizei(indices);
        gl.GenVertexArrays(1, &mesh.vao);
        gl.BindVertexArray(mesh.vao);
        gl.GenBuffers(1, &mesh.vbo);
        gl.BindBuffer(GL_ARRAY_BUFFER, mesh.vbo);
        gl.BufferData(GL_ARRAY_BUFFER, GLsizeiptr(vertices * stride * 4), raw.data(), GL_STATIC_DRAW);
        gl.GenBuffers(1, &mesh.ebo);
        gl.BindBuffer(GL_ELEMENT_ARRAY_BUFFER, mesh.ebo);
        gl.BufferData(
                GL_ELEMENT_ARRAY_BUFFER, GLsizeiptr(indices * 4), raw.data() + vertices * stride * 4, GL_STATIC_DRAW
        );
        attributes(layout, stride);
        gl.BindVertexArray(0);
        return mesh;
    }

    // The layout's attributes at the locations its shaders were exported with.
    void attributes(const nlohmann::json &layout, size_t stride) {
        const bool lit_layout = layout.at(1).at(0) == "normal";
        const auto &locations = metadata.at(lit_layout ? "litLocations" : "glowLocations");
        size_t at = 0;
        for (const auto &attribute : layout) {
            const auto name = attribute.at(0).get<std::string>();
            const auto size = attribute.at(1).get<GLint>();
            const auto location = locations.at(name).get<GLuint>();
            gl.EnableVertexAttribArray(location);
            gl.VertexAttribPointer(
                    location, size, GL_FLOAT, GL_FALSE, GLsizei(stride * 4), reinterpret_cast<const void *>(at * 4)
            );
            at += size_t(size);
        }
    }

    void release() {
        for (auto *mesh : {&lit, &glow}) {
            if (mesh->vbo) gl.DeleteBuffers(1, &mesh->vbo);
            if (mesh->ebo) gl.DeleteBuffers(1, &mesh->ebo);
            if (mesh->vao) gl.DeleteVertexArrays(1, &mesh->vao);
            *mesh = {};
        }
        design.reset();
    }

    Program reflect(GLuint program) const {
        const auto at = [&](const char *name) {
            return gl.GetUniformLocation(program, name);
        };
        return {at("projection"),
                at("model"),
                at("modelMatrix"),
                at("viewMatrix"),
                at("cameraPosition"),
                at("offset"),
                at("mirror"),
                at("boneMatrices"),
                at("uPiece"),
                at("uMorph"),
                at("uChan"),
                at("uLive"),
                at("uMirror"),
                at("uCosTier"),
                at("uCosEnvOn"),
                at("uCosEnv"),
                at("uMapLight"),
                at("modelViewMatrix"),
                at("projectionMatrix")};
    }

    void compile() {
        const auto read = [&](const char *name) {
            return native_render::PlayerShaderSources::read(root / name);
        };
        // The lit pieces take the viewmodel's detail shading (material.ts litMaterial: VM_DETAIL).
        const std::string lit_header = "#version 330 core\n#define VM_DETAIL 1\n", header = "#version 330 core\n";
        lit_program = link_program(
                gl,
                (lit_header + read("live-hilt-vertex.glsl")).c_str(),
                (lit_header + read("live-hilt-fragment.glsl")).c_str()
        );
        glow_program = link_program(
                gl, (header + read("live-glow-vertex.glsl")).c_str(), (header + read("live-glow-fragment.glsl")).c_str()
        );
        lit_uniforms = reflect(lit_program);
        glow_uniforms = reflect(glow_program);
    }

    void shared_uniforms(const Program &p, const DrawInput &in) {
        const auto &u = pieces->u;
        gl.UniformMatrix4fv(p.projection, 1, GL_FALSE, in.projection.data());
        gl.UniformMatrix4fv(p.model, 1, GL_FALSE, in.model.data());
        gl.Uniform3fv(p.offset, 1, in.offset.data());
        gl.Uniform1f(p.mirror, in.mirror);
        gl.Uniform1i(p.bones, 0);
        gl.UniformMatrix4fv(p.piece, GLsizei(piece_count), GL_FALSE, u.piece[0].data());
        gl.Uniform4fv(p.chan, GLsizei(channel_count), u.chan[0].data());
    }

    void draw_lit(const DrawInput &in) {
        const auto &p = lit_uniforms;
        const auto &u = pieces->u;
        gl.UseProgram(lit_program);
        shared_uniforms(p, in);
        const auto web_model = native_render::web_model(in.model), web_view = native_render::web_view(in.projection);
        const float eye[3] = {};
        const auto camera = native_render::to_web_space(eye);
        gl.UniformMatrix4fv(p.model_matrix, 1, GL_FALSE, web_model.data());
        gl.UniformMatrix4fv(p.view_matrix, 1, GL_FALSE, web_view.data());
        gl.Uniform3fv(p.camera, 1, camera.data());
        gl.Uniform1fv(p.morph, GLsizei(piece_count), u.morph.data());
        gl.Uniform4fv(p.live, GLsizei(live_count), u.live[0].data());
        gl.Uniform1f(p.live_mirror, in.mirror < 0 ? 1.f : 0.f);
        gl.Uniform1f(p.tier, float(in.cosmetics_tier));
        // The scene reflections of the Enhanced and Cinematic looks have no native equivalent (as the player programs).
        gl.Uniform1f(p.env_on, 0);
        gl.Uniform1i(p.env, in.reflection_unit);
        gl.Uniform3fv(p.map_light, 1, in.map_light.data());
        gl.Enable(GL_DEPTH_TEST);
        gl.DepthMask(GL_TRUE);
        gl.Disable(GL_BLEND);
        gl.VertexAttrib4f(skin_weight_location, 1, 0, 0, 0);
        gl.BindVertexArray(lit.vao);
        gl.DrawElements(GL_TRIANGLES, lit.indices, GL_UNSIGNED_INT, nullptr);
    }

    // Additive light on the colour only (the canvas's alpha is left alone), behind the hands, without writing depth.
    void draw_glow(const DrawInput &in) {
        const auto &p = glow_uniforms;
        gl.UseProgram(glow_program);
        shared_uniforms(p, in);
        const auto view = source_view();
        const auto model_view = native::multiply(view, in.model);
        const auto projection = native::multiply(in.projection, transpose(view));
        gl.UniformMatrix4fv(p.model_view, 1, GL_FALSE, model_view.data());
        gl.UniformMatrix4fv(p.glow_projection, 1, GL_FALSE, projection.data());
        gl.Enable(GL_BLEND);
        gl.BlendFunc(GL_ONE, GL_ONE);
        gl.ColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_FALSE);
        gl.DepthMask(GL_FALSE);
        gl.VertexAttrib4f(skin_weight_location, 1, 0, 0, 0);
        gl.BindVertexArray(glow.vao);
        gl.DrawElements(GL_TRIANGLES, glow.indices, GL_UNSIGNED_INT, nullptr);
        gl.DepthMask(GL_TRUE);
        gl.ColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
        gl.Disable(GL_BLEND);
        gl.BindVertexArray(0);
    }

    // Source view space (x forward, y left, z up) to the GL camera's (x right, y up, looking down -z).
    static native::Matrix source_view() { return {0, 0, -1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1}; }

    static native::Matrix transpose(const native::Matrix &m) {
        native::Matrix out{};
        for (size_t r = 0; r < 4; r++)
            for (size_t c = 0; c < 4; c++)
                out[c * 4 + r] = m[r * 4 + c];
        return out;
    }

    // The camera seen from the knife (index.ts LiveHilt.look): the eye sits at the view's origin, so undo the model,
    // the mirror and the offset, then the knife bone's pose and its bind.
    CameraInKnife camera_in_knife(const DrawInput &in) const {
        Mat4 model{};
        for (size_t r = 0; r < 4; r++)
            for (size_t c = 0; c < 4; c++)
                model[r * 4 + c] = in.model[c * 4 + r];
        Mat4 skin = identity();
        for (size_t k = 0; k < 12; k++)
            skin[k] = in.knife_skin[k];
        Mat4 bind = identity();
        for (size_t k = 0; k < 12; k++)
            bind[k] = knife_bind[k];
        const auto eye_to_root = inverse_affine(model), root_to_knife = inverse_affine(multiply(skin, bind));
        const auto point = [&](const V3 &eye) {
            V3 root = apply(eye_to_root, eye, true);
            root[1] *= in.mirror;
            for (size_t k = 0; k < 3; k++)
                root[k] -= in.offset[k];
            return apply(root_to_knife, root, true);
        };
        const auto direction = [&](const V3 &eye) {
            V3 root = apply(eye_to_root, eye, false);
            root[1] *= in.mirror;
            const auto d = apply(root_to_knife, root, false);
            const double length = std::hypot(std::hypot(d[0], d[1]), d[2]);
            return length > 0 ? V3{d[0] / length, d[1] / length, d[2] / length} : d;
        };
        return {point({0, 0, 0}), direction({0, -1, 0}), direction({0, 0, 1})};
    }

    static V3 apply(const Mat4 &m, const V3 &v, bool translate) {
        V3 out{};
        for (size_t r = 0; r < 3; r++)
            out[r] = m[r * 4] * v[0] + m[r * 4 + 1] * v[1] + m[r * 4 + 2] * v[2] + (translate ? m[r * 4 + 3] : 0);
        return out;
    }
};

}  // namespace native_hilt
