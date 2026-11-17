#pragma once
// Charms (web viewmodel/charms, v0.0.43): a charm on a cord tied to the knife, swung by how the view and the player
// move. This is the CPU side the website runs each frame: the chain (physics.ts), the charm's little skeleton and its
// own life (rig.ts), and the glue that hangs it on the knife in hand (knife.ts). Where a charm is tied on each knife,
// the wraps, the colliders and the places a knife offers are exported from the website (export-charms.ts); what it
// rests against is sampled from the client's own meshes (charm_fit.hpp). charms-oracle.ts checks this file against the
// website frame by frame. Nothing here reaches the simulation or a replay's inputs.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace native_charm {

constexpr double pi = 3.141592653589793;
using V3 = std::array<double, 3>;
using Matrix34 = std::array<float, 12>;

// physics.ts: gravity at the viewmodel's real scale and the game's, the fixed step, the limits.
constexpr double gravity = 386, game_gravity = 800, step_seconds = 1. / 240;
constexpr int max_steps = 12, iterations = 3;
constexpr double max_speed = 600, snap_distance = 6, snap_turn_degrees = 60, omega_max = 25, omega_seconds = .03;
constexpr double max_acceleration = 6000;
constexpr double twist_hz = 1.6, twist_zeta = .35, twist_kick = .6, twist_limit = 1.3;
constexpr double degrees = pi / 180;

// How lively it swings, from the Swing option (physics.ts ChainTune).
struct Tune {
    double k_rot = 0, k_lin = 0, zeta = 0, cone = 0, k_hand = 0;
};

inline Tune tune_of(double swing) {
    const double s = std::clamp(swing / 100, 0., 1.);
    return {.015 + .3 * s * s, .1 + .65 * s * s, .7 - .45 * s, (35 + 45 * s) * degrees, .3 + .7 * s};
}

// A ball down the charm's axis: `t` along the link from its loop, `r` its radius (physics.ts ChainShape.balls).
struct Ball {
    double t = 1, r = 0;
};

struct Shape {
    double cord = 1.6, link = .8, radius = .8;
    std::vector<Ball> balls;
};

// A capsule a-b, or a sphere at a (no b), in the eye's frame.
struct Collider {
    V3 a{};
    std::optional<V3> b;
    double r = 0;
};

// physics.ts PointCloud: points a charm rests against, in cells so a ball only looks at what is near it.
class PointCloud {
public:
    static constexpr double point_radius = .045, cell_size = .3;

    PointCloud() = default;

    explicit PointCloud(std::vector<float> points) : pts(std::move(points)) {
        for (size_t i = 0; i + 2 < pts.size(); i += 3)
            cells[key(cell_of(pts[i]), cell_of(pts[i + 1]), cell_of(pts[i + 2]))].push_back(uint32_t(i));
    }

    bool empty() const { return pts.empty(); }

    size_t size() const { return pts.size() / 3; }

    // The push that takes a ball (x, y, z, radius r) out of the point it is deepest in.
    bool push(double x, double y, double z, double r, V3 &out) const {
        const double R = r + point_radius;
        const int i0 = cell_of(x - R), i1 = cell_of(x + R), j0 = cell_of(y - R), j1 = cell_of(y + R);
        const int k0 = cell_of(z - R), k1 = cell_of(z + R);
        double best = R * R;
        int64_t found = -1;
        for (int i = i0; i <= i1; i++)
            for (int j = j0; j <= j1; j++)
                for (int k = k0; k <= k1; k++) {
                    const auto cell = cells.find(key(i, j, k));
                    if (cell == cells.end()) continue;
                    for (const uint32_t o : cell->second) {
                        const double dx = x - pts[o], dy = y - pts[o + 1], dz = z - pts[o + 2];
                        const double d2 = dx * dx + dy * dy + dz * dz;
                        if (d2 < best) {
                            best = d2;
                            found = o;
                        }
                    }
                }
        if (found < 0) return false;
        const double d = std::sqrt(best);
        if (d < 1e-6) return false;
        const double k = (R - d) / d;
        const auto o = size_t(found);
        out = {(x - pts[o]) * k, (y - pts[o + 1]) * k, (z - pts[o + 2]) * k};
        return true;
    }

private:
    std::vector<float> pts;
    std::unordered_map<int32_t, std::vector<uint32_t>> cells;

    static int cell_of(double v) { return int(std::floor(v / cell_size)); }

    // physics.ts key, with JavaScript's 32-bit shifts.
    static int32_t key(int i, int j, int k) {
        constexpr int bias = 512;
        return int32_t(uint32_t(i + bias) << 20 | uint32_t(j + bias) << 10 | uint32_t(k + bias));
    }
};

// A cloud this frame: eye -> the cloud's own frame (a rigid 3x4, stored as floats like the website's).
struct CloudInput {
    const PointCloud *cloud = nullptr;
    Matrix34 to_local{};
};

struct ChainInput {
    double dt = 0;
    V3 anchor{};
    double yaw = 0, pitch = 0;
    V3 velocity{};
    const std::vector<Collider> *colliders = nullptr;
    const std::vector<CloudInput> *clouds = nullptr;
};

namespace chain_detail {

inline V3 cross(const V3 &a, const V3 &b) {
    return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}

inline double wrap(double a) {
    return std::atan2(std::sin(a), std::cos(a));
}

inline double length(double x, double y, double z) {
    return std::sqrt(x * x + y * y + z * z);
}

// Distance constraint between points i and j (inverse masses wi, wj; `slack`: only when longer).
inline void link(std::array<double, 12> &p, size_t i, size_t j, double L, double wi, double wj, bool slack) {
    const size_t a = i * 3, b = j * 3;
    const double dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
    const double d = length(dx, dy, dz);
    if (d < 1e-9 || (slack && d <= L)) return;
    const double w = wi + wj;
    if (w <= 0) return;
    const double k = (d - L) / (d * w);
    p[a] += dx * k * wi;
    p[a + 1] += dy * k * wi;
    p[a + 2] += dz * k * wi;
    p[b] -= dx * k * wj;
    p[b + 1] -= dy * k * wj;
    p[b + 2] -= dz * k * wj;
}

// Point j brought to within L of point i (exactly L unless `slack`).
inline void follow(std::array<double, 12> &p, size_t i, size_t j, double L, bool slack) {
    const size_t a = i * 3, b = j * 3;
    const double dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
    const double d = length(dx, dy, dz);
    if (d < 1e-9 || (slack && d <= L)) return;
    const double k = L / d;
    p[b] = p[a] + dx * k;
    p[b + 1] = p[a + 1] + dy * k;
    p[b + 2] = p[a + 2] + dz * k;
}

// The nearest point of a collider's capsule (or its sphere's centre) to s.
inline V3 closest(const Collider &c, double sx, double sy, double sz) {
    V3 at = c.a;
    if (!c.b) return at;
    const double ux = (*c.b)[0] - c.a[0], uy = (*c.b)[1] - c.a[1], uz = (*c.b)[2] - c.a[2];
    const double uu = ux * ux + uy * uy + uz * uz;
    const double k =
            uu > 1e-9 ? std::clamp(((sx - c.a[0]) * ux + (sy - c.a[1]) * uy + (sz - c.a[2]) * uz) / uu, 0., 1.) : 0;
    return {at[0] + ux * k, at[1] + uy * k, at[2] + uz * k};
}

// Point i (radius r) out of a capsule or sphere.
inline void push(std::array<double, 12> &p, size_t i, const Collider &c, double r) {
    const size_t o = i * 3;
    const auto cc = closest(c, p[o], p[o + 1], p[o + 2]);
    const double dx = p[o] - cc[0], dy = p[o + 1] - cc[1], dz = p[o + 2] - cc[2];
    const double d = length(dx, dy, dz), R = c.r + r;
    if (d >= R || d < 1e-9) return;
    const double k = (R - d) / d;
    p[o] += dx * k;
    p[o + 1] += dy * k;
    p[o + 2] += dz * k;
}

// A ball on the charm's axis (at t along the link from the loop) out of a collider, by moving the link's two ends.
inline void push_ball(std::array<double, 12> &p, double t, double r, const Collider &c) {
    const double w2 = 1 - t, w3 = t;
    const double sx = p[6] * w2 + p[9] * w3, sy = p[7] * w2 + p[10] * w3, sz = p[8] * w2 + p[11] * w3;
    const auto cc = closest(c, sx, sy, sz);
    const double dx = sx - cc[0], dy = sy - cc[1], dz = sz - cc[2];
    const double d = length(dx, dy, dz), R = c.r + r;
    if (d >= R || d < 1e-9) return;
    const double k = (R - d) / d / (w2 * w2 + w3 * w3);
    for (size_t a = 0; a < 3; a++) {
        const double delta = a == 0 ? dx : a == 1 ? dy : dz;
        p[6 + a] += delta * k * w2;
        p[9 + a] += delta * k * w3;
    }
}

// A push found in a cloud's frame for an eye-space point, turned back into the eye's frame.
inline bool cloud_push(double x, double y, double z, double r, const CloudInput &cl, V3 &out) {
    const auto &m = cl.to_local;
    V3 local{};
    const double lx = m[0] * x + m[1] * y + m[2] * z + m[3], ly = m[4] * x + m[5] * y + m[6] * z + m[7];
    const double lz = m[8] * x + m[9] * y + m[10] * z + m[11];
    if (!cl.cloud->push(lx, ly, lz, r, local)) return false;
    const double a = local[0], b = local[1], c = local[2];
    out = {m[0] * a + m[4] * b + m[8] * c, m[1] * a + m[5] * b + m[9] * c, m[2] * a + m[6] * b + m[10] * c};
    return true;
}

inline void cloud_point(std::array<double, 12> &p, size_t i, double r, const CloudInput &cl) {
    const size_t o = i * 3;
    V3 d{};
    if (!cloud_push(p[o], p[o + 1], p[o + 2], r, cl, d)) return;
    for (size_t a = 0; a < 3; a++)
        p[o + a] += d[a];
}

// A point f of the way along the cord from point i to point j out of a cloud, by moving its ends (the ring is fixed).
inline void cloud_span(std::array<double, 12> &p, size_t i, size_t j, double f, double r, const CloudInput &cl) {
    const size_t a = i * 3, b = j * 3;
    const double wi = i == 0 ? 0 : 1 - f, wj = f;
    V3 d{};
    const double x = p[a] + (p[b] - p[a]) * f, y = p[a + 1] + (p[b + 1] - p[a + 1]) * f;
    const double z = p[a + 2] + (p[b + 2] - p[a + 2]) * f;
    if (!cloud_push(x, y, z, r, cl, d)) return;
    const double k = 1 / ((1 - f) * wi + f * wj);
    for (size_t c = 0; c < 3; c++) {
        p[a + c] += d[c] * k * wi;
        p[b + c] += d[c] * k * wj;
    }
}

inline void cloud_ball(std::array<double, 12> &p, double t, double r, const CloudInput &cl) {
    const double w2 = 1 - t, w3 = t;
    V3 d{};
    if (!cloud_push(p[6] * w2 + p[9] * w3, p[7] * w2 + p[10] * w3, p[8] * w2 + p[11] * w3, r, cl, d)) return;
    const double k = 1 / (w2 * w2 + w3 * w3);
    for (size_t c = 0; c < 3; c++) {
        p[6 + c] += d[c] * k * w2;
        p[9 + c] += d[c] * k * w3;
    }
}

// Where along each half of the cord it is tested against the clouds.
constexpr std::array<double, 6> span = {.14, .28, .42, .57, .71, .86};

}  // namespace chain_detail

// physics.ts CharmChain: 0 the ring (pinned), 1 the cord's middle, 2 the charm's loop, 3 its centre, in the eye's
// frame.
class Chain {
public:
    std::array<double, 12> p{}, q{}, out{};
    double twist = 0, twist_out = 0;
    Shape shape;
    Tune tune = tune_of(30);
    int resets = 0;

    void reset(const V3 &anchor, double pitch = 0, double yaw = 0, const V3 &velocity = {}) {
        const double th = pitch * degrees;
        const V3 g = {std::sin(th), 0, -std::cos(th)};
        const std::array<double, 4> along = {0, shape.cord / 2, shape.cord, shape.cord + shape.link};
        for (size_t i = 0; i < 4; i++)
            for (size_t k = 0; k < 3; k++)
                p[i * 3 + k] = q[i * 3 + k] = last[i * 3 + k] = anchor[k] + g[k] * along[i];
        out = p;
        twist = twist_rate = last_twist = twist_out = 0;
        carried = 0;
        previous_anchor = anchor;
        previous_yaw = yaw;
        previous_pitch = pitch;
        previous_velocity = velocity;
        omega = {0, 0};
        pending_velocity = {};
        started = true;
        resets++;
    }

    void clear() { started = false; }

    void update(const ChainInput &s) {
        const double dt = s.dt;
        const auto &A = s.anchor;
        if (!started) return reset(A, s.pitch, s.yaw, s.velocity);
        if (!(dt > 0)) {
            draw(A);
            return;
        }
        const double dyaw = chain_detail::wrap((s.yaw - previous_yaw) * degrees);
        const double dpitch = (s.pitch - previous_pitch) * degrees;
        const double jump =
                chain_detail::length(A[0] - previous_anchor[0], A[1] - previous_anchor[1], A[2] - previous_anchor[2]);
        const bool finite = std::isfinite(A[0]) && std::isfinite(A[1]) && std::isfinite(A[2]);
        if (jump > snap_distance || std::abs(dyaw) > snap_turn_degrees * degrees
            || std::abs(dpitch) > snap_turn_degrees * degrees || !finite) {
            if (finite) reset(A, s.pitch, s.yaw, s.velocity);
            return;
        }
        const double ko = 1 - std::exp(-dt / omega_seconds);
        const std::array<double, 2> omega0 = omega;
        omega[0] += (std::clamp(dyaw / dt, -omega_max, omega_max) - omega[0]) * ko;
        omega[1] += (std::clamp(dpitch / dt, -omega_max, omega_max) - omega[1]) * ko;
        const std::array<double, 2> omega_dot = {(omega[0] - omega0[0]) / dt, (omega[1] - omega0[1]) / dt};
        for (size_t k = 0; k < 3; k++) {
            const double v = std::isfinite(s.velocity[k]) ? s.velocity[k] : previous_velocity[k];
            pending_velocity[k] += v - previous_velocity[k];
            previous_velocity[k] = v;
        }
        carried += dt;
        int n = int(std::floor(carried / step_seconds + 1e-9));
        if (n > max_steps) {
            n = max_steps;
            carried = n * step_seconds;
        }
        const double t0 = carried - dt;
        for (int i = 1; i <= n; i++)
            step_at(i, t0, s, dyaw, omega0, omega_dot);
        carried -= n * step_seconds;
        previous_anchor = A;
        previous_yaw = s.yaw;
        previous_pitch = s.pitch;
        draw(A);
    }

private:
    std::array<double, 12> last{};
    double twist_rate = 0, last_twist = 0, carried = 0;
    bool started = false;
    V3 previous_anchor{}, previous_velocity{}, pending_velocity{};
    double previous_yaw = 0, previous_pitch = 0;
    std::array<double, 2> omega{};

    // Step i of n through the frame: the anchor, the view and its rate interpolated to its time.
    void
    step_at(int i,
            double t0,
            const ChainInput &s,
            double dyaw,
            const std::array<double, 2> &omega0,
            const std::array<double, 2> &omega_dot) {
        const double u = std::clamp((i * step_seconds - t0) / s.dt, 0., 1.);
        const V3 a = {
                previous_anchor[0] + (s.anchor[0] - previous_anchor[0]) * u,
                previous_anchor[1] + (s.anchor[1] - previous_anchor[1]) * u,
                previous_anchor[2] + (s.anchor[2] - previous_anchor[2]) * u
        };
        const double yaw = previous_yaw * degrees + dyaw * u;
        const double pitch = (previous_pitch + (s.pitch - previous_pitch) * u) * degrees;
        const std::array<double, 2> rate = {
                omega0[0] + (omega[0] - omega0[0]) * u, omega0[1] + (omega[1] - omega0[1]) * u
        };
        last = p;
        last_twist = twist;
        // This step's share of the velocity change waiting.
        const double share = std::min(1., step_seconds / std::max(step_seconds, carried - (i - 1) * step_seconds));
        const V3 kick = {pending_velocity[0] * share, pending_velocity[1] * share, pending_velocity[2] * share};
        for (size_t k = 0; k < 3; k++)
            pending_velocity[k] -= kick[k];
        step_once(a, yaw, pitch, rate, omega_dot, kick, s.colliders, s.clouds);
    }

    void draw(const V3 &A) {
        const double f = std::min(1., carried / step_seconds);
        for (size_t i = 0; i < 12; i++)
            out[i] = last[i] + (p[i] - last[i]) * f;
        const double dx = A[0] - out[0], dy = A[1] - out[1], dz = A[2] - out[2];
        for (size_t i = 0; i < 4; i++) {
            out[i * 3] += dx;
            out[i * 3 + 1] += dy;
            out[i * 3 + 2] += dz;
        }
        twist_out = last_twist + (twist - last_twist) * f;
    }

    void integrate(
            double yaw,
            double pitch,
            const std::array<double, 2> &om,
            const std::array<double, 2> &om_dot,
            const V3 &kick_world,
            V3 &g,
            double &turn_z
    );

    void collide(const std::vector<Collider> *colliders, const std::vector<CloudInput> *clouds);

    void limit_swing(const V3 &g);

    void step_once(
            const V3 &a,
            double yaw,
            double pitch,
            const std::array<double, 2> &om,
            const std::array<double, 2> &om_dot,
            const V3 &kick_world,
            const std::vector<Collider> *colliders,
            const std::vector<CloudInput> *clouds
    ) {
        V3 g{};
        double turn_z = 0;
        integrate(yaw, pitch, om, om_dot, kick_world, g, turn_z);
        // The ring is where the knife has it; the rest is carried along by (1 - kHand) of the ring's move.
        const double carry = 1 - tune.k_hand;
        for (size_t k = 0; k < 3; k++) {
            const double move = (a[k] - p[k]) * carry;
            for (size_t i = 1; i < 4; i++) {
                p[i * 3 + k] += move;
                q[i * 3 + k] += move;
            }
            q[k] = p[k];
            p[k] = a[k];
        }
        collide(colliders, clouds);
        limit_swing(g);
        const double half = shape.cord / 2;
        chain_detail::follow(p, 0, 1, half, true);
        chain_detail::follow(p, 1, 2, half, true);
        chain_detail::follow(p, 2, 3, shape.link, false);
        // Twist: a spring back to facing the eye, kicked by the view's turn about the cord.
        const double wt = 2 * pi * twist_hz;
        twist_rate += (-wt * wt * twist - 2 * twist_zeta * wt * twist_rate - twist_kick * tune.k_rot * 4 * turn_z)
                      * step_seconds;
        twist += twist_rate * step_seconds;
        if (std::abs(twist) > twist_limit) {
            twist = std::copysign(twist_limit, twist);
            twist_rate *= -.3;
        }
    }
};

// Gravity, the player's change of velocity and the view's fictitious forces on the free points (Verlet).
inline void Chain::integrate(
        double yaw,
        double pitch,
        const std::array<double, 2> &om,
        const std::array<double, 2> &om_dot,
        const V3 &kick_world,
        V3 &g,
        double &turn_z
) {
    using chain_detail::cross;
    const double h = step_seconds;
    const double cy = std::cos(yaw), sy = std::sin(yaw), cp = std::cos(pitch), sp = std::sin(pitch);
    const V3 f = {cp * cy, cp * sy, -sp}, l = {-sy, cy, 0}, up = {sp * cy, sp * sy, cp};
    g = {gravity * sp, 0, -gravity * cp};
    const double gs = gravity / game_gravity;
    const double kx = kick_world[0] * gs, ky = kick_world[1] * gs, kz = kick_world[2] * gs;
    const V3 kick_eye = {
            f[0] * kx + f[1] * ky + f[2] * kz, l[0] * kx + l[1] * ky, up[0] * kx + up[1] * ky + up[2] * kz
    };
    const V3 w = {-om[0] * sp, om[1], om[0] * cp}, wd = {-om_dot[0] * sp, om_dot[1], om_dot[0] * cp};
    turn_z = wd[2];
    const double w0 = std::sqrt(gravity / std::max(.3, shape.cord + shape.link));
    const double keep = std::exp(-2 * tune.zeta * w0 * h);
    for (size_t i = 1; i < 4; i++) {
        const size_t o = i * 3;
        const V3 r = {p[o], p[o + 1], p[o + 2]};
        const V3 vel = {(p[o] - q[o]) / h, (p[o + 1] - q[o + 1]) / h, (p[o + 2] - q[o + 2]) / h};
        const auto e = cross(wd, r), c = cross(w, vel), cf = cross(w, cross(w, r));
        V3 acc{};
        for (size_t k = 0; k < 3; k++)
            acc[k] = g[k] - tune.k_rot * (e[k] + 2 * c[k] + cf[k]);
        const double am = chain_detail::length(acc[0], acc[1], acc[2]);
        if (am > max_acceleration)
            for (auto &value : acc)
                value *= max_acceleration / am;
        for (size_t k = 0; k < 3; k++) {
            const double limit = max_speed * h;
            const double dv = std::clamp((p[o + k] - q[o + k]) * keep - tune.k_lin * kick_eye[k] * h, -limit, limit);
            q[o + k] = p[o + k];
            p[o + k] += dv + acc[k] * h * h;
        }
    }
}

// The lengths (the cord may go slack), then what the charm and its cord may not pass through.
inline void Chain::collide(const std::vector<Collider> *colliders, const std::vector<CloudInput> *clouds) {
    using namespace chain_detail;
    constexpr double cord_point_radius = .12, cloud_point_radius = .05, cloud_span_radius = .055;
    const double half = shape.cord / 2;
    const bool balls = !shape.balls.empty();
    const std::vector<Ball> one = {{1, shape.radius}};
    for (int it = 0; it < iterations; it++) {
        link(p, 0, 1, half, 0, 1, true);
        link(p, 1, 2, half, 1, 1, true);
        link(p, 2, 3, shape.link, 1, .25, false);
        if (colliders) {
            for (size_t i = 1; i < (balls ? 3u : 4u); i++)
                for (const auto &c : *colliders)
                    push(p, i, c, i == 3 ? shape.radius : cord_point_radius);
            if (balls)
                for (const auto &b : shape.balls)
                    for (const auto &c : *colliders)
                        push_ball(p, b.t, b.r, c);
        }
        if (!clouds) continue;
        for (const auto &cl : *clouds) {
            for (size_t i = 1; i < 3; i++)
                cloud_point(p, i, cloud_point_radius, cl);
            for (const double f : span)
                cloud_span(p, 0, 1, f, cloud_span_radius, cl);
            for (const double f : span)
                cloud_span(p, 1, 2, f, cloud_span_radius, cl);
            for (const auto &b : balls ? shape.balls : one)
                cloud_ball(p, b.t, b.r, cl);
        }
    }
}

// Each point within `cone` of straight down from the ring, losing half its speed when it reaches it.
inline void Chain::limit_swing(const V3 &g) {
    const double gl = chain_detail::length(g[0], g[1], g[2]);
    const V3 gd = {g[0] / gl, g[1] / gl, g[2] / gl};
    const double cc = std::cos(tune.cone), sc = std::sin(tune.cone);
    for (size_t i = 1; i < 4; i++) {
        const size_t o = i * 3;
        const V3 d = {p[o] - p[0], p[o + 1] - p[1], p[o + 2] - p[2]};
        const double L = chain_detail::length(d[0], d[1], d[2]);
        if (L < 1e-9) continue;
        const double along = (d[0] * gd[0] + d[1] * gd[1] + d[2] * gd[2]) / L;
        if (along >= cc) continue;
        const V3 across = {d[0] / L - gd[0] * along, d[1] / L - gd[1] * along, d[2] / L - gd[2] * along};
        double al = chain_detail::length(across[0], across[1], across[2]);
        if (al == 0) al = 1;
        for (size_t k = 0; k < 3; k++) {
            const double np = p[k] + L * (gd[k] * cc + across[k] / al * sc);
            q[o + k] = np - (p[o + k] - q[o + k]) * .5;
            p[o + k] = np;
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The charm's own data and options.

enum class LifeKind { none, spin, lag, flick, beat, blink, bob, rock };

inline LifeKind life_named(std::string_view kind) {
    constexpr std::pair<std::string_view, LifeKind> names[] = {
            {"spin", LifeKind::spin},
            {"lag", LifeKind::lag},
            {"flick", LifeKind::flick},
            {"beat", LifeKind::beat},
            {"blink", LifeKind::blink},
            {"bob", LifeKind::bob},
            {"rock", LifeKind::rock},
    };
    for (const auto &[name, value] : names)
        if (name == kind) return value;
    return LifeKind::none;
}

// meshes.ts CharmLife: its moving part's pivot and axis (charm-local), its rate and size.
struct Life {
    LifeKind kind = LifeKind::none;
    V3 at{}, axis{0, 0, 1};
    double rate = 1, amount = 0;
};

// One charm as exported: its mesh and its measures (meshes.ts charmMetrics) at built size.
struct CharmDef {
    std::string id, mesh;
    double link = 0, radius = 0, lift = 0;
    std::vector<Ball> balls;  // `t` holds the depth below the loop here (charmMetrics.balls.d)
    Life life;
};

// The option ranges (progression.ts CHARM_LENGTH / SIZE / SWING).
struct Range {
    int min = 0, max = 0, fallback = 0, step = 1;
};

struct Options {
    std::string charm;
    int length = 100, size = 100, swing = 30;
    bool pommel = false;
};

// loadout.ts unpackLoadoutExt: "<charm>[;<two characters of options>]". A malformed option field keeps the defaults.
inline std::optional<Options>
unpack_options(std::string_view text, const Range &length, const Range &size, const Range &swing) {
    constexpr size_t longest = 200;
    constexpr std::string_view alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
    if (text.empty() || text.size() > longest) return std::nullopt;
    const auto split = text.find(';');
    Options out;
    out.charm = std::string(text.substr(0, split));
    out.length = length.fallback;
    out.size = size.fallback;
    out.swing = swing.fallback;
    if (out.charm.empty()) return std::nullopt;
    if (split == std::string_view::npos) return out;
    auto rest = text.substr(split + 1);
    rest = rest.substr(0, rest.find(';'));
    if (rest.size() != 2) return out;
    const auto hi = alphabet.find(rest[0]), lo = alphabet.find(rest[1]);
    if (hi == std::string_view::npos || lo == std::string_view::npos) return out;
    const int n = int(hi * 64 + lo);
    // (A value past its range is the default, as loadoutFor reads it.)
    const auto within = [](const Range &range, int value) {
        return value >= range.min && value <= range.max ? value : range.fallback;
    };
    out.length = within(length, length.min + (n & 15) * length.step);
    out.size = within(size, size.min + ((n >> 4) & 7) * size.step);
    out.swing = within(swing, swing.min + ((n >> 7) & 15) * swing.step);
    out.pommel = n & 2048;
    return out;
}

}  // namespace native_charm
