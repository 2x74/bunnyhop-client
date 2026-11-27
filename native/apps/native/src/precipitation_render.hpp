#pragma once
// Draws func_precipitation snow and rain (precipitation.hpp; website map-effects/precipitation.ts): one instanced draw
// per kind whose volumes are near the camera, every particle evaluated in the vertex shader from the time, so the CPU
// does no per-particle work and a frame allocates nothing. Included after the GL declarations (renderer.hpp).
//
// The column map is traced through the core once, when the effect is first on for the map (map load for most
// players). The main view only: never in water reflections, Potato mode, or with the setting off. renderer.hpp
// includes precipitation.hpp at file scope.

class NativePrecipitation {
public:
    static constexpr int max_active = native_precip::max_active;

private:
    struct KindDraw {
        native_precip::Kind kind = native_precip::Kind::rain;
        GLuint vao = 0, instance_buffer = 0;
        int full = 0, count = 0;
        /** Indices into the volume list, the density share of each (renderamt over the kind's largest). */
        std::vector<size_t> volumes;
        std::vector<float> share;
        /** Per volume: gap from the camera's box (0 when they overlap), reused every frame. */
        std::vector<double> gap;
    };

    struct Program {
        GLuint id = 0;
        GLint time = -1, cam = -1, cam_mod = -1, half = -1, proj = -1, min_px = -1, length = -1, fall = -1, fade = -1;
        GLint vol_count = -1, vol_min = -1, vol_max = -1, vol_grid = -1, columns = -1, view_projection = -1;
        GLint right = -1, up = -1, color = -1, alpha = -1;
    };

    Gl &gl;
    std::vector<native_precip::Volume> volumes_;
    native_precip::Columns columns_;
    std::vector<KindDraw> draws;
    Program sprites, streaks;
    GLuint corner_buffer = 0, index_buffer = 0, column_texture = 0;
    bool built = false;
    double density = 0;
    std::array<float, max_active * 4> vol_min{}, vol_max{}, vol_grid{};

public:
    explicit NativePrecipitation(Gl &g) : gl(g) {}
    NativePrecipitation(const NativePrecipitation &) = delete;
    NativePrecipitation &operator=(const NativePrecipitation &) = delete;
    ~NativePrecipitation() { release(); }

    /** The map's volumes (cheap: nothing is traced or uploaded until the effect is on). */
    void load(const nlohmann::json &entities, const nlohmann::json &models) {
        release();
        volumes_ = native_precip::volumes(entities, models);
    }

    bool empty() const { return volumes_.empty(); }

    /** Off, light or full (0, 0.5, 1). The first time it's on for this map, traces the columns and uploads. */
    void set_density(double value, BhContext *core) {
        density = std::isfinite(value) ? std::clamp(value, 0., 1.) : 0;
        if (density > 0 && !built && !volumes_.empty() && core) build(core);
        for (auto &d : draws)
            d.count = int(native_precip::js_round(d.full * density));
    }

    /**
     * The main view: `height` is the target's height in pixels, `time` the world's visual time (seconds; a replay's
     * or the game's). Returns the draw calls made.
     */
    int draw(const native::Matrix &vp, const float eye[3], const native_render::Vec3 &right,
             const native_render::Vec3 &up, int height, double time) {
        if (!built || density <= 0) return 0;
        const double wrapped = native_precip::wrap(time, native_precip::period);
        // Clip y per unit of the camera's up axis: the projection's focal scale, for the shaders' pixel sizes.
        const float focal = vp[1] * up[0] + vp[5] * up[1] + vp[9] * up[2];
        const float pixels_per_unit = focal * float(height) * .5f;
        int calls = 0;
        for (auto &d : draws) {
            if (d.count <= 0 || pick(d, eye) == 0) continue;
            const auto &program = d.kind == native_precip::Kind::snowfall ? sprites : streaks;
            if (calls == 0) begin_state();
            uniforms(program, d, vp, eye, right, up, pixels_per_unit, wrapped);
            gl.BindVertexArray(d.vao);
            gl.DrawElementsInstanced(GL_TRIANGLES, 6, GL_UNSIGNED_INT, nullptr, d.count);
            ++calls;
        }
        if (calls) end_state();
        return calls;
    }

private:
    static native_precip::Columns trace_columns(const std::vector<native_precip::Volume> &volumes, BhContext *core) {
        return native_precip::build_columns(
                volumes,
                [core](double sx, double sy, double sz, double ex, double ey, double ez) {
                    const float start[3] = {float(sx), float(sy), float(sz)}, end[3] = {float(ex), float(ey), float(ez)};
                    float fraction = 1;
                    // Radius 0: a line through world, props and solid brush entities, as the website's traceRay(..., 0).
                    if (!bh_trace_camera(core, start, end, 0, &fraction)) return 1.f;
                    return fraction;
                }
        );
    }

    void build(BhContext *core) {
        const auto started = std::chrono::steady_clock::now();
        columns_ = trace_columns(volumes_, core);
        upload_columns();
        make_quad();
        sprites = program(false);
        streaks = program(true);
        for (const auto kind : native_precip::kinds)
            add_kind(kind);
        built = true;
        const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
        int cells = 0;
        for (const auto &l : columns_.layout)
            cells += l.cols * l.rows;
        std::cerr << "Bunnyhop native: precipitation " << volumes_.size() << " volumes, columns " << columns_.width
                  << "x" << columns_.height << " (" << cells << " cells, " << columns_.traces << " traces"
                  << (columns_.truncated ? ", budget hit" : "") << ") in " << long(ms + .5) << " ms\n";
    }

    void add_kind(native_precip::Kind kind) {
        KindDraw d;
        d.kind = kind;
        double top = 0;
        for (size_t i = 0; i < volumes_.size(); ++i)
            if (volumes_[i].kind == kind) {
                d.volumes.push_back(i);
                top = std::max(top, std::max(0., volumes_[i].amount));
            }
        if (d.volumes.empty()) return;
        d.full = native_precip::field_count(kind, top);
        if (d.full <= 0) return;
        for (const size_t i : d.volumes) {
            const double amount = std::max(0., volumes_[i].amount);
            d.share.push_back(kind == native_precip::Kind::snowfall ? 1.f : float(top > 0 ? amount / top : 0));
        }
        d.gap.assign(d.volumes.size(), 0);
        const auto data = native_precip::instances(kind, d.full);
        gl.GenVertexArrays(1, &d.vao);
        gl.BindVertexArray(d.vao);
        gl.BindBuffer(GL_ARRAY_BUFFER, corner_buffer);
        gl.EnableVertexAttribArray(0);
        gl.VertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 2 * sizeof(float), nullptr);
        gl.BindBuffer(GL_ELEMENT_ARRAY_BUFFER, index_buffer);
        gl.GenBuffers(1, &d.instance_buffer);
        gl.BindBuffer(GL_ARRAY_BUFFER, d.instance_buffer);
        gl.BufferData(GL_ARRAY_BUFFER, GLsizeiptr(data.size() * sizeof(float)), data.data(), GL_STATIC_DRAW);
        constexpr GLsizei stride = GLsizei(native_precip::instance_floats * sizeof(float));
        for (GLuint a = 0; a < 3; ++a) {
            gl.EnableVertexAttribArray(a + 1);
            gl.VertexAttribPointer(
                    a + 1, 4, GL_FLOAT, GL_FALSE, stride, reinterpret_cast<void *>(size_t(a) * 4 * sizeof(float))
            );
            gl.VertexAttribDivisor(a + 1, 1);
        }
        gl.BindVertexArray(0);
        draws.push_back(std::move(d));
    }

    void make_quad() {
        constexpr float corners[] = {-1, -1, 1, -1, 1, 1, -1, 1};
        constexpr GLuint order[] = {0, 1, 2, 0, 2, 3};
        gl.GenBuffers(1, &corner_buffer);
        gl.BindBuffer(GL_ARRAY_BUFFER, corner_buffer);
        gl.BufferData(GL_ARRAY_BUFFER, sizeof(corners), corners, GL_STATIC_DRAW);
        gl.GenBuffers(1, &index_buffer);
        gl.BindBuffer(GL_ELEMENT_ARRAY_BUFFER, index_buffer);
        gl.BufferData(GL_ELEMENT_ARRAY_BUFFER, sizeof(order), order, GL_STATIC_DRAW);
    }

    void upload_columns() {
        gl.GenTextures(1, &column_texture);
        gl.BindTexture(GL_TEXTURE_2D, column_texture);
        gl.PixelStorei(GL_UNPACK_ALIGNMENT, 4);
        gl.TexImage2D(
                GL_TEXTURE_2D, 0, GL_RG32F, columns_.width, columns_.height, 0, GL_RG, GL_FLOAT, columns_.data.data()
        );
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    }

    Program program(bool streak) {
        Program p;
        const std::string defines = std::string("#version 330 core\n") + (streak ? "#define STREAK 1\n" : "");
        p.id = link_program(
                gl,
                (defines + native_precip::vertex_source).c_str(),
                (defines + native_precip::fragment_source).c_str()
        );
        const auto at = [&](const char *name) { return gl.GetUniformLocation(p.id, name); };
        p.time = at("uTime");
        p.cam = at("uCam");
        p.cam_mod = at("uCamMod");
        p.half = at("uHalf");
        p.proj = at("uProj");
        p.min_px = at("uMinPx");
        p.length = at("uLength");
        p.fall = at("uFall");
        p.fade = at("uNear");
        p.vol_count = at("uVolCount");
        p.vol_min = at("uVolMin");
        p.vol_max = at("uVolMax");
        p.vol_grid = at("uVolGrid");
        p.columns = at("uColumns");
        p.view_projection = at("uViewProjection");
        p.right = at("uRight");
        p.up = at("uUp");
        p.color = at("uColor");
        p.alpha = at("uAlpha");
        return p;
    }

    /** The overlapping volumes nearest the camera (up to max_active) into the uniform arrays; how many. */
    int pick(KindDraw &d, const float eye[3]) {
        const auto &f = native_precip::field(d.kind);
        // Streaks: the footprint only; they fall around the eye whatever the volume's height.
        const int axes = d.kind == native_precip::Kind::snowfall ? 3 : 2;
        int overlapping = 0;
        for (size_t k = 0; k < d.volumes.size(); ++k) {
            const auto &v = volumes_[d.volumes[k]];
            double gap = 0;
            for (int a = 0; a < axes; ++a)
                gap = std::max({gap, v.min[size_t(a)] - (eye[a] + f.half[size_t(a)]),
                                eye[a] - f.half[size_t(a)] - v.max[size_t(a)]});
            d.gap[k] = gap;
            if (gap <= 0) ++overlapping;
        }
        int count = 0;
        for (int slot = 0; slot < std::min(overlapping, max_active); ++slot) {
            int best = -1;
            for (size_t k = 0; k < d.volumes.size(); ++k)
                if (d.gap[k] <= 0 && (best < 0 || d.gap[k] < d.gap[size_t(best)])) best = int(k);
            if (best < 0) break;
            d.gap[size_t(best)] = 1;
            set_slot(count++, d, size_t(best));
        }
        active_slots = count;
        return count;
    }

    void set_slot(int slot, const KindDraw &d, size_t k) {
        const size_t i = d.volumes[k];
        const auto &v = volumes_[i];
        const auto &l = columns_.layout[i];
        const size_t o = size_t(slot) * 4;
        for (size_t a = 0; a < 3; ++a) {
            vol_min[o + a] = float(v.min[a]);
            vol_max[o + a] = float(v.max[a]);
        }
        vol_min[o + 3] = float(1 / l.cell);
        vol_max[o + 3] = d.share[k];
        vol_grid[o] = float(l.x);
        vol_grid[o + 1] = float(l.y);
        vol_grid[o + 2] = float(l.cols);
        vol_grid[o + 3] = float(l.rows);
    }

    int active_slots = 0;

    void uniforms(const Program &p, const KindDraw &d, const native::Matrix &vp, const float eye[3],
                  const native_render::Vec3 &right, const native_render::Vec3 &up, float pixels_per_unit,
                  double wrapped) {
        const auto &f = native_precip::field(d.kind);
        gl.UseProgram(p.id);
        gl.UniformMatrix4fv(p.view_projection, 1, GL_FALSE, vp.data());
        gl.Uniform1f(p.time, float(wrapped));
        gl.Uniform3fv(p.cam, 1, eye);
        gl.Uniform3f(p.cam_mod,
                     float(native_precip::wrap(eye[0], f.half[0] * 2)),
                     float(native_precip::wrap(eye[1], f.half[1] * 2)),
                     float(native_precip::wrap(eye[2], f.half[2] * 2)));
        gl.Uniform3f(p.half, float(f.half[0]), float(f.half[1]), float(f.half[2]));
        gl.Uniform1f(p.proj, pixels_per_unit);
        gl.Uniform1f(p.min_px, float(f.min_pixels));
        gl.Uniform1f(p.length, float(f.length));
        gl.Uniform1f(p.fall, float(native_precip::streak_fall(d.kind)));
        gl.Uniform2f(p.fade, float(f.near_fade[0]), float(f.near_fade[1]));
        gl.Uniform1i(p.vol_count, active_slots);
        gl.Uniform4fv(p.vol_min, max_active, vol_min.data());
        gl.Uniform4fv(p.vol_max, max_active, vol_max.data());
        gl.Uniform4fv(p.vol_grid, max_active, vol_grid.data());
        gl.Uniform3fv(p.right, 1, right.data());
        gl.Uniform3fv(p.up, 1, up.data());
        // sRGB, written as the other map effects write theirs (native_presentation.hpp).
        gl.Uniform3f(p.color, f.color[0] / 255.f, f.color[1] / 255.f, f.color[2] / 255.f);
        gl.Uniform1f(p.alpha, float(f.alpha));
        gl.ActiveTexture(GL_TEXTURE0 + column_unit);
        gl.BindTexture(GL_TEXTURE_2D, column_texture);
        gl.Uniform1i(p.columns, column_unit);
    }

    static constexpr GLint column_unit = 9;

    void begin_state() {
        gl.Enable(GL_DEPTH_TEST);
        gl.DepthFunc(GL_LEQUAL);
        gl.DepthMask(GL_FALSE);
        gl.Disable(GL_CULL_FACE);
        gl.Enable(GL_BLEND);
        gl.BlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    }

    void end_state() {
        gl.BindVertexArray(0);
        gl.ActiveTexture(GL_TEXTURE0);
        gl.DepthMask(GL_TRUE);
        gl.Disable(GL_BLEND);
    }

    void release() {
        for (auto &d : draws) {
            if (d.instance_buffer) gl.DeleteBuffers(1, &d.instance_buffer);
            if (d.vao) gl.DeleteVertexArrays(1, &d.vao);
        }
        draws.clear();
        for (auto *p : {&sprites, &streaks}) {
            if (p->id) gl.DeleteProgram(p->id);
            *p = {};
        }
        if (corner_buffer) gl.DeleteBuffers(1, &corner_buffer);
        if (index_buffer) gl.DeleteBuffers(1, &index_buffer);
        if (column_texture) gl.DeleteTextures(1, &column_texture);
        corner_buffer = index_buffer = column_texture = 0;
        columns_ = {};
        built = false;
    }
};
