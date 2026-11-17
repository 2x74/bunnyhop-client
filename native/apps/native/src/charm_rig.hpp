#pragma once
// A charm on the knife in hand (web viewmodel/charms/rig.ts CharmRig and knife.ts KnifeCharm): where it is tied on the
// knife this frame, the chain swung from there, and its six bones (the wrap, the cord's two halves, the charm, its
// moving part, the crimp) as column-major 4x4s in the eye's frame, ready to draw.
#include "charms.hpp"

namespace native_charm {

// meshes.ts CB: the charm skeleton's bones.
enum Bone : size_t { mount_bone = 0, cord_upper = 1, cord_lower = 2, body_bone = 3, part_bone = 4, link_bone = 5 };

constexpr size_t bone_count = 6;

// knife.ts REST_CONE: a tied charm leans on the fist at rest, so its swing limit must not hold it inside the hand.
constexpr double rest_cone = 82 * degrees;

// anchors.ts CharmCollider, on the viewmodel's bones (indices).
struct HangCollider {
    V3 a{};
    std::optional<V3> b;
    double r = 0;
    int bone = 0, bone_b = -1;
    bool hand = false;
};

// anchors.ts CharmHang: the knot on its bone, the wrap's mesh, the colliders.
struct Hang {
    int bone = 0;
    V3 at{};
    std::string mount_mesh;
    std::vector<HangCollider> colliders;
};

struct Joint {
    int bone = 0;
    V3 at{};
};

// One knife, hilt and glove: where it hangs at the guard and at the pommel, the fingers at rest, and what it rests
// against (knife-local).
struct Fit {
    Hang guard;
    std::optional<Hang> pommel;
    std::vector<Joint> joints;
    bool offers_guard = true, offers_pommel = false;
    PointCloud solid, hands;
};

// anchors.ts charmHang: the guard's tie or the pommel's as chosen, the one place where a knife offers one.
inline const Hang &hang_of(const Fit &fit, bool pommel) {
    if (!fit.offers_guard && fit.pommel) return *fit.pommel;
    if (pommel && fit.offers_pommel && fit.pommel) return *fit.pommel;
    return fit.guard;
}

// The hardware's measures (hardware.ts TOP_DROP, BOTTOM_RISE) and the cord at 100% (meshes.ts CORD_LENGTH).
struct Hardware {
    double top_drop = .05, bottom_rise = .116, cord_length = 1.3, scale = 1.2;
};

// rig.ts cordOf: the cord grows a little slower than its option, so the longest still hangs in view.
inline double cord_of(double percent, double cord_length) {
    constexpr double growth = .8;
    return cord_length * std::pow(percent / 100, growth);
}

// What a charm needs each frame from the viewmodel.
struct Frame {
    double dt = 0, clock = 0;
    V3 velocity{};
    double yaw = 0, pitch = 0;
    // The viewmodel's bones in model space (3x4 row-major each, float as the website keeps them).
    const std::vector<float> *bones = nullptr;
    // The feel matrix (view space, 3x4) with the offsets (forward, sideways, up) and the mirrored hand.
    Matrix34 view{};
    V3 offset{};
    bool left = false;
    int knife_bone = 0;
};

namespace rig_detail {

inline V3 add(const V3 &a, const V3 &b) {
    return {a[0] + b[0], a[1] + b[1], a[2] + b[2]};
}

inline V3 sub(const V3 &a, const V3 &b) {
    return {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
}

inline V3 scale(const V3 &a, double s) {
    return {a[0] * s, a[1] * s, a[2] * s};
}

inline double dot(const V3 &a, const V3 &b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

inline V3 lerp(const V3 &a, const V3 &b, double t) {
    return {a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t};
}

inline std::optional<V3> norm(const V3 &a) {
    const double l = chain_detail::length(a[0], a[1], a[2]);
    if (!(l > 1e-9)) return std::nullopt;
    return V3{a[0] / l, a[1] / l, a[2] / l};
}

// Two unit vectors across z.
inline std::pair<V3, V3> perp(const V3 &z) {
    const V3 u = norm(z).value_or(V3{0, 0, 1});
    const V3 ref = std::abs(u[0]) < .9 ? V3{1, 0, 0} : V3{0, 1, 0};
    const V3 x = *norm(chain_detail::cross(ref, u));
    return {x, chain_detail::cross(u, x)};
}

// v turned about the unit axis a by t radians.
inline V3 rotate(const V3 &v, const V3 &a, double t) {
    const double c = std::cos(t), s = std::sin(t), d = dot(v, a);
    const V3 x = chain_detail::cross(a, v);
    return {v[0] * c + x[0] * s + a[0] * d * (1 - c),
            v[1] * c + x[1] * s + a[1] * d * (1 - c),
            v[2] * c + x[2] * s + a[2] * d * (1 - c)};
}

// Row-major 3x3 rotation about an axis.
inline std::array<double, 9> rotation(const V3 &axis, double t) {
    const V3 a = norm(axis).value_or(V3{0, 0, 1});
    const double c = std::cos(t), s = std::sin(t), C = 1 - c, x = a[0], y = a[1], z = a[2];
    return {c + x * x * C,
            x * y * C - z * s,
            x * z * C + y * s,
            y * x * C + z * s,
            c + y * y * C,
            y * z * C - x * s,
            z * x * C - y * s,
            z * y * C + x * s,
            c + z * z * C};
}

// a * b for two 3x4s (rig.ts concat), kept as floats as the website keeps them.
inline Matrix34 concat(const float *a, const float *b) {
    Matrix34 out{};
    for (size_t r = 0; r < 3; r++) {
        const double a0 = a[r * 4], a1 = a[r * 4 + 1], a2 = a[r * 4 + 2], a3 = a[r * 4 + 3];
        out[r * 4] = float(a0 * b[0] + a1 * b[4] + a2 * b[8]);
        out[r * 4 + 1] = float(a0 * b[1] + a1 * b[5] + a2 * b[9]);
        out[r * 4 + 2] = float(a0 * b[2] + a1 * b[6] + a2 * b[10]);
        out[r * 4 + 3] = float(a0 * b[3] + a1 * b[7] + a2 * b[11] + a3);
    }
    return out;
}

// The inverse of a rigid 3x4 (rig.ts invert34).
inline Matrix34 invert(const float *m) {
    const double r00 = m[0], r01 = m[1], r02 = m[2], tx = m[3], r10 = m[4], r11 = m[5], r12 = m[6], ty = m[7];
    const double r20 = m[8], r21 = m[9], r22 = m[10], tz = m[11];
    return {float(r00),
            float(r10),
            float(r20),
            float(-(r00 * tx + r10 * ty + r20 * tz)),
            float(r01),
            float(r11),
            float(r21),
            float(-(r01 * tx + r11 * ty + r21 * tz)),
            float(r02),
            float(r12),
            float(r22),
            float(-(r02 * tx + r12 * ty + r22 * tz))};
}

inline V3 transform(const Matrix34 &m, const V3 &p) {
    return {m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
            m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
            m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]};
}

}  // namespace rig_detail

class CharmRig {
public:
    Chain chain;
    // Bone matrices in the eye's frame, column-major 4x4 each.
    std::array<float, bone_count * 16> bones{};

    const CharmDef *worn() const { return def; }

    bool pommel() const { return on_pommel; }

    // The charm and its options (rig.ts set); null hides it.
    void set(const CharmDef *charm, const Options &o, const Hardware &hardware) {
        if (charm != def) {
            def = charm;
            chain.clear();
            lag_on = false;
        }
        if (!def) return;
        size = o.size / 100. * hardware.scale;
        this->hardware = hardware;
        Shape shape;
        shape.cord = cord_of(o.length, hardware.cord_length);
        shape.link = def->link * size;
        shape.radius = def->radius * size;
        for (const auto &b : def->balls)
            shape.balls.push_back({b.t / def->link, b.r * size});
        if (shape.cord != chain.shape.cord || shape.link != chain.shape.link || o.pommel != on_pommel) chain.clear();
        chain.shape = std::move(shape);
        chain.tune = tune_of(o.swing);
        chain.tune.cone = std::max(chain.tune.cone, rest_cone);
        on_pommel = o.pommel;
    }

    void reset() {
        chain.clear();
        lag_on = false;
    }

    // `bone`: the knot's bone in the eye's frame; `at` the knot on it.
    void
    update(double dt,
           double clock,
           const Frame &f,
           const Matrix34 &bone,
           const V3 &at,
           const std::vector<Collider> &colliders,
           const std::vector<CloudInput> &clouds) {
        if (!def) return;
        const auto anchor = rig_detail::transform(bone, at);
        ChainInput in;
        in.dt = dt;
        in.anchor = anchor;
        in.yaw = f.yaw;
        in.pitch = f.pitch;
        in.velocity = f.velocity;
        in.colliders = &colliders;
        in.clouds = &clouds;
        chain.update(in);
        write(mount_bone,
              {bone[0], bone[4], bone[8]},
              {bone[1], bone[5], bone[9]},
              {bone[2], bone[6], bone[10]},
              anchor);
        pose_cord(anchor);
        pose_body(dt, clock);
    }

private:
    const CharmDef *def = nullptr;
    Hardware hardware;
    double size = 1;
    bool on_pommel = false, lag_on = false;
    std::array<double, 6> lag{};

    V3 point(size_t i) const { return {chain.out[i * 3], chain.out[i * 3 + 1], chain.out[i * 3 + 2]}; }

    void write(size_t bone, const V3 &x, const V3 &y, const V3 &z, const V3 &t) {
        float *o = bones.data() + bone * 16;
        const std::array<const V3 *, 4> columns = {&x, &y, &z, &t};
        for (size_t c = 0; c < 4; c++) {
            for (size_t r = 0; r < 3; r++)
                o[c * 4 + r] = float((*columns[c])[r]);
            o[c * 4 + 3] = c == 3 ? 1.f : 0.f;
        }
    }

    // The cord from under the crimp to the charm's ring, its two halves stretched along what is left; the crimp.
    void pose_cord(const V3 &anchor) {
        using namespace rig_detail;
        const V3 p0 = point(0), p1 = point(1), p2 = point(2);
        const double l1 = chain_detail::length(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
        const double l2 = chain_detail::length(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]), total = l1 + l2;
        const auto along = [&](double d) {
            if (d <= l1) return lerp(p0, p1, l1 > 1e-6 ? d / l1 : 0);
            return lerp(p1, p2, l2 > 1e-6 ? std::min(1., (d - l1) / l2) : 1);
        };
        const double d0 = std::min(total, hardware.top_drop);
        const double d2 = std::max(d0, total - hardware.bottom_rise * size);
        const V3 q0 = along(d0), qm = along((d0 + d2) / 2), q2 = along(d2);
        const std::array<std::tuple<size_t, V3, V3>, 2> halves = {
                std::tuple{size_t(cord_upper), q0, qm}, std::tuple{size_t(cord_lower), qm, q2}
        };
        for (const auto &[bone, a, b] : halves) {
            V3 z = sub(b, a);
            if (dot(z, z) < 1e-8) z = scale(norm(sub(p2, p0)).value_or(V3{0, 0, -1}), 1e-3);
            const auto [x, y] = perp(z);
            write(bone, x, y, z, a);
        }
        const V3 up = norm(sub(p0, q0)).value_or(norm(sub(p0, p2)).value_or(V3{0, 0, 1}));
        const auto [lx, ly] = perp(up);
        write(link_bone, lx, ly, up, anchor);
    }

    // The charm at its loop: up along its link, its face toward the eye, turned by the twist; then its moving part.
    void pose_body(double dt, double clock) {
        using namespace rig_detail;
        const V3 loop = point(2), c = point(3);
        const V3 zc = norm(sub(loop, c)).value_or(V3{0, 0, 1});
        const V3 to_eye = norm({-c[0], -c[1], -c[2]}).value_or(V3{-1, 0, 0});
        V3 yc = norm(sub(scale(zc, dot(to_eye, zc)), to_eye)).value_or(V3{1, 0, 0});
        yc = rotate(yc, zc, chain.twist_out + spin_angle(clock));
        const V3 xc = chain_detail::cross(yc, zc);
        write(body_bone, scale(xc, size), scale(yc, size), scale(zc, size), loop);
        life(dt, clock, xc, yc, zc);
    }

    // A turning charm faces you, then once every `rate` seconds turns a full turn over `amount` seconds.
    double spin_angle(double clock) const {
        const auto &l = def->life;
        if (l.kind != LifeKind::spin) return 0;
        const double u = std::fmod(clock, l.rate) - (l.rate - l.amount);
        if (u <= 0) return 0;
        const double f = u / l.amount;
        return 2 * pi * f * f * (3 - 2 * f);
    }

    // The angle (and scale) of the moving part this frame; false when it only rides on the body.
    bool part_motion(double dt, double clock, const V3 &xc, const V3 &yc, const V3 &zc, V3 &axis, double &angle, V3 &s);

    void life(double dt, double clock, const V3 &xc, const V3 &yc, const V3 &zc) {
        using namespace rig_detail;
        float *part = bones.data() + part_bone * 16;
        const float *body = bones.data() + body_bone * 16;
        std::copy(body, body + 16, part);
        V3 axis = def->life.axis, s = {1, 1, 1};
        double angle = 0;
        if (!part_motion(dt, clock, xc, yc, zc, axis, angle, s)) return;
        // part = body * T(at) * R(axis, angle) * S(s) * T(-at), in charm-local units.
        const auto R = rotation(axis, angle);
        std::array<double, 9> M{};
        for (size_t r = 0; r < 3; r++)
            for (size_t c = 0; c < 3; c++)
                M[r * 3 + c] = R[r * 3 + c] * s[c];
        const V3 at = {def->life.at[0], def->life.at[1], def->life.at[2] + def->lift};
        const V3 applied = {
                M[0] * at[0] + M[1] * at[1] + M[2] * at[2],
                M[3] * at[0] + M[4] * at[1] + M[5] * at[2],
                M[6] * at[0] + M[7] * at[1] + M[8] * at[2]
        };
        const V3 tl = sub(at, applied);
        const V3 BX = {body[0], body[1], body[2]}, BY = {body[4], body[5], body[6]}, BZ = {body[8], body[9], body[10]};
        const V3 BT = {body[12], body[13], body[14]};
        const auto column = [&](size_t j) {
            return add(scale(BX, M[j]), add(scale(BY, M[3 + j]), scale(BZ, M[6 + j])));
        };
        const V3 T = add(BT, add(scale(BX, tl[0]), add(scale(BY, tl[1]), scale(BZ, tl[2]))));
        write(part_bone, column(0), column(1), column(2), T);
    }
};

inline bool CharmRig::part_motion(
        double dt, double clock, const V3 &xc, const V3 &yc, const V3 &zc, V3 &axis, double &angle, V3 &s
) {
    using namespace rig_detail;
    const auto &l = def->life;
    switch (l.kind) {
        case LifeKind::none:
        case LifeKind::spin:
            return false;
        case LifeKind::lag: {
            // A lagged copy of the charm's down vector: the part swings behind the body.
            constexpr double lag_damping = .3, lag_step_seconds = 1. / 240;
            const V3 down = scale(zc, -1);
            if (!lag_on || !(dt > 0)) {
                lag = {down[0], down[1], down[2], 0, 0, 0};
                lag_on = true;
            } else {
                const double w = 2 * pi * l.rate;
                const int n = std::max(1, int(std::ceil(dt / lag_step_seconds)));
                const double h = dt / n;
                for (int k = 0; k < n; k++)
                    for (size_t a = 0; a < 3; a++) {
                        lag[3 + a] += (w * w * (down[a] - lag[a]) - 2 * lag_damping * w * lag[3 + a]) * h;
                        lag[a] += lag[3 + a] * h;
                    }
            }
            const V3 c = chain_detail::cross(down, {lag[0], lag[1], lag[2]});
            const double m = chain_detail::length(c[0], c[1], c[2]);
            if (m < 1e-6) return false;
            axis = {dot(c, xc) / m, dot(c, yc) / m, dot(c, zc) / m};
            angle = std::min(l.amount, 2 * m) * (l.axis[2] > 0 ? -1 : 1);
            return true;
        }
        case LifeKind::flick: {
            constexpr double flick_seconds = .4;
            const double u = std::fmod(clock, l.rate) / flick_seconds;
            angle = u < 1 ? l.amount * std::sin(pi * u) * std::sin(2 * pi * u) : 0;
            return true;
        }
        case LifeKind::beat: {
            const double u = std::fmod(clock, l.rate);
            const auto pulse = [&](double centre, double width) {
                return std::exp(-((u - centre) * (u - centre)) / (width * width));
            };
            const double f = 1 + l.amount * (pulse(.12, .06) + .6 * pulse(.34, .06));
            s = {f, f, f};
            return true;
        }
        case LifeKind::blink: {
            constexpr double blink_seconds = .14;
            const double u = std::fmod(clock, l.rate);
            s = {1, 1, u < blink_seconds ? std::max(l.amount, std::abs(std::cos(pi * u / blink_seconds))) : 1};
            return true;
        }
        case LifeKind::bob:
        case LifeKind::rock:
            angle = l.amount * std::sin(2 * pi * l.rate * clock);
            return true;
    }
    return false;
}

// knife.ts KnifeCharm: the charm hung on the knife in hand from its fit, stepped each frame.
class KnifeCharm {
public:
    CharmRig rig;

    // The charm and its options, and the fit of the knife, hilt and glove in hand (null: none to hang it on).
    void set(const CharmDef *charm, const Options &options, const Hardware &hardware, const Fit *knife_fit) {
        rig.set(charm, options, hardware);
        if (knife_fit != fit) {
            fit = knife_fit;
            hang = nullptr;
            rig.reset();
        }
        place();
    }

    const Hang *placed() const { return hang; }

    void reset() { rig.reset(); }

    void update(const Frame &f) {
        if (!rig.worn() || !place()) return;
        const auto &W = *f.bones;
        Matrix34 M = f.view;
        M[3] += float(f.offset[0]);
        M[7] += float(f.offset[1]);
        M[11] += float(f.offset[2]);
        if (f.left)
            for (const size_t i : {1, 5, 9})
                M[i] = -M[i];
        const auto bone = [&](int index) {
            return W.data() + size_t(index) * 12;
        };
        const auto E = rig_detail::concat(M.data(), bone(hang->bone));
        const auto C = rig_detail::concat(M.data(), bone(f.knife_bone));
        const auto Ei = rig_detail::invert(C.data());
        const bool held = holds_as_at_rest(W, f.knife_bone);
        clouds.clear();
        if (!fit->solid.empty()) clouds.push_back({&fit->solid, Ei});
        if (held && !fit->hands.empty()) clouds.push_back({&fit->hands, Ei});
        colliders.clear();
        for (const auto &c : hang->colliders) {
            if (c.hand && held) continue;
            auto at = rig_detail::concat(M.data(), bone(c.bone));
            const auto a = rig_detail::transform(at, c.a);
            if (c.b && c.bone_b >= 0) at = rig_detail::concat(M.data(), bone(c.bone_b));
            colliders.push_back({a, c.b ? std::optional<V3>(rig_detail::transform(at, *c.b)) : std::nullopt, c.r});
        }
        rig.update(f.dt, f.clock, f, E, hang->at, colliders, clouds);
    }

private:
    const Fit *fit = nullptr;
    const Hang *hang = nullptr;
    std::optional<bool> hang_pommel;
    std::vector<Collider> colliders;
    std::vector<CloudInput> clouds;

    // knife.ts place: the hang for the place chosen, measured again only when the knife, hilt, glove or place changes.
    const Hang *place() {
        if (!rig.worn() || !fit) return hang = nullptr;
        if (hang && hang_pommel == rig.pommel()) return hang;
        hang = &hang_of(*fit, rig.pommel());
        hang_pommel = rig.pommel();
        rig.reset();
        return hang;
    }

    // Whether the hand holds the knife as at rest: its finger joints where the rest hold has them, in the knife's
    // frame.
    bool holds_as_at_rest(const std::vector<float> &W, int knife_bone) const {
        constexpr double tolerance = .3;
        const auto Wk = rig_detail::invert(W.data() + size_t(knife_bone) * 12);
        for (const auto &j : fit->joints) {
            const float *o = W.data() + size_t(j.bone) * 12;
            const double x = o[3], y = o[7], z = o[11];
            const double lx = Wk[0] * x + Wk[1] * y + Wk[2] * z + Wk[3] - j.at[0];
            const double ly = Wk[4] * x + Wk[5] * y + Wk[6] * z + Wk[7] - j.at[1];
            const double lz = Wk[8] * x + Wk[9] * y + Wk[10] * z + Wk[11] - j.at[2];
            if (lx * lx + ly * ly + lz * lz > tolerance * tolerance) return false;
        }
        return true;
    }
};

}  // namespace native_charm
