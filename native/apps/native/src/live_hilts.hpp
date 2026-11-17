#pragma once
// Living hilts (web viewmodel/hilts/live): what a living hilt reacts to (state.ts PlaySignals) and each design's motion
// (designs/*.ts animate, and the Watcher's look at the camera), written as the uniforms its exported meshes are drawn
// with. The pieces, their materials and the points each design turns them about are exported from the website
// (export-live-hilts.ts); live-hilts-oracle.ts checks this file against the website frame by frame.
//
// Nothing here reads the wall clock: the viewmodel's clock and its input drive it, so a replay or an export plays the
// same hilt every time.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string_view>

namespace native_hilt {

constexpr double pi = 3.141592653589793;
constexpr size_t piece_count = 12, channel_count = 12, live_count = 8;

using V3 = std::array<double, 3>;
// Row-major 4x4, doubles as three.js computes them; uploaded column-major as floats.
using Mat4 = std::array<double, 16>;

// state.ts: a landing kept going within this long is a clean hop; this long on the ground ends a chain; full speed.
constexpr double clean_hop_window_seconds = .12, chain_break_seconds = .35, full_speed = 1000;

struct PlayInput {
    std::array<double, 3> velocity{};
    bool grounded = true;
    // The vertical speed of a landing since the last frame (negative), or 0.
    double landed = 0;
    double yaw_degrees = 0;
};

inline double clamp(double v, double lo, double hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

inline double ease(double dt, double rate) {
    return 1 - std::exp(-dt * rate);
}

// state.ts PlaySignals.
struct PlaySignals {
    double t = 0, speed = 0, turn = 0;
    int lands = 0, chain = 0, hops = 0;
    double land_time = -1e9, land_hard = 0, chain_time = -1e9;
    bool grounded = true;
    double ground_seconds = 0, inspect = 0;
    // Reduced motion or cosmetics held still: the design shows its still pose.
    bool still = false;
    std::optional<double> yaw;
    bool pending_land = false;

    double speed01() const { return clamp(speed / full_speed, 0, 1); }

    double since_land() const { return t - land_time; }

    void reset() {
        const bool keep_still = still;
        *this = {};
        still = keep_still;
    }

    void update(double dt, double now, const PlayInput &in, bool inspecting) {
        constexpr double speed_rate = 8, turn_rate = 7, inspect_rate = 6, turn_limit = 1500, landing_floor = -40;
        constexpr double takeoff_speed = 40, hard_from = 150, hard_span = 650, late_take_off_seconds = .05;
        t = now;
        speed += (std::hypot(in.velocity[0], in.velocity[1]) - speed) * ease(dt, speed_rate);
        if (yaw && dt > 0) {
            double d = in.yaw_degrees - *yaw;
            d -= std::floor(d / 360 + .5) * 360;
            turn += (clamp(d / dt, -turn_limit, turn_limit) - turn) * ease(dt, turn_rate);
        }
        yaw = in.yaw_degrees;
        inspect += ((inspecting ? 1. : 0.) - inspect) * ease(dt, inspect_rate);
        const double vz = in.velocity[2];
        if (in.landed < landing_floor) {
            lands++;
            land_time = now;
            land_hard = clamp((-in.landed - hard_from) / hard_span, .2, 1);
            // Landed and already off again within the frame (a hop between two frames): a clean hop.
            if (!in.grounded && vz > takeoff_speed)
                clean(now);
            else
                pending_land = true;
        }
        if (grounded && !in.grounded && vz > takeoff_speed) {
            hops++;
            if (pending_land && now - land_time <= clean_hop_window_seconds + std::max(dt, 0.))
                clean(now);
            else if (ground_seconds > chain_break_seconds)
                set_chain(0, now);
            pending_land = false;
        }
        if (in.grounded) {
            ground_seconds += dt;
            if (ground_seconds > chain_break_seconds && chain) set_chain(0, now);
        } else
            ground_seconds = 0;
        if (pending_land && now - land_time > clean_hop_window_seconds + late_take_off_seconds && !in.grounded)
            pending_land = false;
        grounded = in.grounded;
    }

private:
    void clean(double now) {
        pending_land = false;
        set_chain(chain + 1, now);
    }

    void set_chain(int n, double now) {
        if (n == chain) return;
        chain = n;
        chain_time = now;
    }
};

// state.ts hash1: an integer to 0..1, as JavaScript's 32-bit integer arithmetic does it.
inline double hash1(double n) {
    uint32_t x = uint32_t(int64_t(n)) ^ 0x9e3779b9u;
    x *= 0x85ebca6bu;
    x ^= x >> 13;
    x *= 0xc2b2ae35u;
    x ^= x >> 16;
    return double(x) / 4294967296.;
}

struct Scheduled {
    double index, at, next;
};

// state.ts schedule: events lo..hi seconds apart, as a pure function of time.
inline Scheduled schedule(double t, double lo, double hi, double seed) {
    constexpr double seed_step = 7919;
    const auto at = [&](double j) {
        return j * hi + (hi - lo) * hash1(j * seed_step + seed);
    };
    double j = std::floor(t / hi);
    if (at(j) > t) j--;
    return {j, at(j), at(j + 1)};
}

// design.ts approach: a critically damped step toward a target, exact for any dt.
inline double approach(double v, double target, double rate, double dt) {
    return v + (target - v) * (1 - std::exp(-rate * dt));
}

// design.ts spring and kick: a damped spring stepped at a fixed 1/240 s, so every frame rate moves it the same.
struct Spring {
    std::optional<double> x;
    double v = 0, carried = 0;

    double step(double target, double hz, double zeta, double dt) {
        constexpr double step_seconds = 1. / 240;
        double position = x.value_or(target);
        carried += dt;
        const double w = 2 * pi * hz;
        while (carried >= step_seconds) {
            v += (w * w * (target - position) - 2 * zeta * w * v) * step_seconds;
            position += v * step_seconds;
            carried -= step_seconds;
        }
        x = position;
        return position;
    }

    void kick(double dv) { v += dv; }
};

// The uniforms a design writes each frame (material.ts LiveUniforms).
struct Uniforms {
    std::array<std::array<float, 16>, piece_count> piece{};
    std::array<float, piece_count> morph{};
    std::array<std::array<float, 4>, channel_count> chan{};
    std::array<std::array<float, 4>, live_count> live{};

    Uniforms() {
        for (auto &m : piece)
            m = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
        for (auto &c : chan)
            c = {1, 1, 1, 0};
        // (three.js's Vector4 starts as (0, 0, 0, 1).)
        for (auto &l : live)
            l = {0, 0, 0, 1};
    }
};

inline Mat4 identity() {
    return {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
}

inline Mat4 multiply(const Mat4 &a, const Mat4 &b) {
    Mat4 out{};
    for (size_t r = 0; r < 4; r++)
        for (size_t c = 0; c < 4; c++)
            for (size_t k = 0; k < 4; k++)
                out[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
    return out;
}

inline Mat4 translation(const V3 &p) {
    auto m = identity();
    m[3] = p[0];
    m[7] = p[1];
    m[11] = p[2];
    return m;
}

// three.js Matrix4.makeRotationAxis, the axis normalized first.
inline Mat4 rotation(const V3 &axis, double angle) {
    const double length = std::hypot(std::hypot(axis[0], axis[1]), axis[2]);
    const double x = length > 0 ? axis[0] / length : 0, y = length > 0 ? axis[1] / length : 0;
    const double z = length > 0 ? axis[2] / length : 0;
    const double c = std::cos(angle), s = std::sin(angle), t = 1 - c;
    return {t * x * x + c,
            t * x * y - s * z,
            t * x * z + s * y,
            0,
            t * x * y + s * z,
            t * y * y + c,
            t * y * z - s * x,
            0,
            t * x * z - s * y,
            t * y * z + s * x,
            t * z * z + c,
            0,
            0,
            0,
            0,
            1};
}

// The inverse of an affine matrix (a rotation, scale and translation).
inline Mat4 inverse_affine(const Mat4 &m) {
    const double a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
    const double det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    const double k = det != 0 ? 1 / det : 0;
    Mat4 out = {
            (e * i - f * h) * k,
            (c * h - b * i) * k,
            (b * f - c * e) * k,
            0,
            (f * g - d * i) * k,
            (a * i - c * g) * k,
            (c * d - a * f) * k,
            0,
            (d * h - e * g) * k,
            (b * g - a * h) * k,
            (a * e - b * d) * k,
            0,
            0,
            0,
            0,
            1
    };
    for (size_t r = 0; r < 3; r++)
        out[r * 4 + 3] = -(out[r * 4] * m[3] + out[r * 4 + 1] * m[7] + out[r * 4 + 2] * m[11]);
    return out;
}

// design.ts PieceCtx: per-frame writes over the uniforms, knife-local in and the viewmodel's bind space out.
class Pieces {
public:
    Uniforms u;

    // `knife_bind`: the knife bone's bind matrix, 3x4 row-major (the website's vmRig bind).
    explicit Pieces(const std::array<float, 12> &knife_bind) {
        knife = identity();
        for (size_t k = 0; k < 12; k++)
            knife[k] = knife_bind[k];
        knife_inverse = inverse_affine(knife);
    }

    // Piece i turned by `angle` about the axis through `pivot`, scaled by `s` about it, then moved by `move`.
    void piece(size_t i, const V3 &pivot, const V3 &axis, double angle, double s = 1, const V3 &move = {}) {
        auto turn = rotation(axis, angle);
        if (s != 1) turn = multiply(turn, scale(s));
        const V3 moved = {pivot[0] + move[0], pivot[1] + move[1], pivot[2] + move[2]};
        store(i, about(moved, turn, pivot));
    }

    // Piece i turned about axis1 by a1, then about axis2 by a2, both through `pivot`.
    void piece2(size_t i, const V3 &pivot, const V3 &axis1, double a1, const V3 &axis2, double a2) {
        store(i, about(pivot, multiply(rotation(axis2, a2), rotation(axis1, a1)), pivot));
    }

    void morph(size_t i, double w) { u.morph[i] = float(w); }

    void chan(size_t i, uint32_t hex, double k) {
        chan(i, {double((hex >> 16) & 255) / 255, double((hex >> 8) & 255) / 255, double(hex & 255) / 255}, k);
    }

    void chan(size_t i, const V3 &rgb, double k) {
        u.chan[i] = {float(rgb[0]), float(rgb[1]), float(rgb[2]), float(k)};
    }

    void live(size_t i, double x, double y, double z, double w) {
        u.live[i] = {float(x), float(y), float(z), float(w)};
    }

private:
    Mat4 knife{}, knife_inverse{};

    static Mat4 scale(double s) {
        auto m = identity();
        m[0] = m[5] = m[10] = s;
        return m;
    }

    Mat4 about(const V3 &to, const Mat4 &turn, const V3 &pivot) const {
        const auto local = multiply(multiply(translation(to), turn), translation({-pivot[0], -pivot[1], -pivot[2]}));
        return multiply(multiply(knife, local), knife_inverse);
    }

    void store(size_t i, const Mat4 &m) {
        for (size_t r = 0; r < 4; r++)
            for (size_t c = 0; c < 4; c++)
                u.piece[i][c * 4 + r] = float(m[r * 4 + c]);
    }
};

enum class Design { watcher, frostrune, clockwork, forge, deep, storm, bloom };

inline std::optional<Design> design_named(std::string_view id) {
    constexpr std::pair<std::string_view, Design> names[] = {
            {"hilt-watcher", Design::watcher},
            {"hilt-frostrune", Design::frostrune},
            {"hilt-clockwork", Design::clockwork},
            {"hilt-ember", Design::forge},
            {"hilt-deep", Design::deep},
            {"hilt-storm", Design::storm},
            {"hilt-bloom", Design::bloom},
    };
    for (const auto &[name, design] : names)
        if (name == id) return design;
    return std::nullopt;
}

// The knife-dependent points a design moves its pieces about (export-live-hilts.ts pivots), knife-local.
struct Pivots {
    V3 eye{}, balance{}, escape{}, gear{}, lure{}, tip_right{}, tip_left{}, edge_right{}, edge_left{};
    double flower_z = 0, grip_center = 0, grip_half = 0;
    int teeth = 15;
};

// The camera seen from the knife (knife-local): where it is and its right and up directions.
struct CameraInKnife {
    V3 position{}, right{0, 1, 0}, up{0, 0, 1};
};

// Each design's state between frames (the website keeps it in PieceCtx.mem; absent = not set yet).
struct Memory {
    std::optional<double> pupil, gaze_x, gaze_y, flare_chain_time, flare_time;
    std::array<std::optional<double>, 6> letters{};
    std::optional<double> phase, frequency, kick, heat, glow, wave, level, open;
    std::optional<int> lands;
    Spring yaw, pitch, leaf_up, leaf_down;
};

namespace designs {

inline V3 operator*(const V3 &v, double k) {
    return {v[0] * k, v[1] * k, v[2] * k};
}

inline void watcher(const PlaySignals &s, Pieces &c, Memory &m, double dt) {
    constexpr V3 iris = {.62, .78, .16};
    constexpr uint32_t aura = 0x8a4cff;
    const bool still = s.still;
    double w = 0;
    if (!still) {
        // A blink every 4..8 s; a landing squints, longer for a harder one; speed narrows the eye a little.
        const double e = s.t - schedule(s.t, 4, 8, 11).at;
        const double blink = e < .07 ? e / .07 : e < .11 ? 1 : e < .27 ? 1 - (e - .11) / .16 : 0;
        const double hold = .12 + .28 * s.land_hard, since = s.since_land();
        const double squint = .55 + .45 * s.land_hard;
        const double land = since < .05          ? since / .05 * squint
                            : since < .05 + hold ? squint * (1 - (since - .05) / hold)
                                                 : 0;
        w = std::max({blink, land, .18 * s.speed01()});
        w = w * (1 - s.inspect) - .42 * s.inspect;
    }
    c.morph(1, w);
    c.morph(2, w * .85);
    // The sleeping pommel eye twitches now and then and opens a crack in an inspect.
    double twitch = 0;
    if (!still) {
        const double e = s.t - schedule(s.t, 5, 11, 29).at;
        twitch = e < .6 ? std::sin(e / .6 * pi) * .25 : 0;
    }
    c.morph(5, 1 - twitch - (still ? 0 : .45 * s.inspect));
    c.morph(6, 1 - twitch * .5 - (still ? 0 : .3 * s.inspect));
    m.pupil = still ? .21 : approach(m.pupil.value_or(.21), .22 - .07 * s.speed01() - .06 * s.inspect, 6, dt);
    // Saccades to a new spot every 2..5 s (every third look is straight at you); a turn pulls the gaze sideways.
    double ox = 0, oy = 0;
    if (!still) {
        const double look = schedule(s.t, 2, 5, 3).index;
        const double away = hash1(look * 31 + 5) < .34 ? 0 : 1;
        ox = away * (hash1(look * 13 + 1) - .5) * 1.3;
        oy = away * (hash1(look * 17 + 2) - .5) * .7;
        ox = ox * (1 - s.inspect) - .55 * std::tanh(s.turn / 260);
        oy *= 1 - s.inspect;
    }
    m.gaze_x = approach(m.gaze_x.value_or(0), ox, 22, dt);
    m.gaze_y = approach(m.gaze_y.value_or(0), oy, 22, dt);
    const double inspect = still ? 0 : s.inspect;
    c.live(1, iris[0], iris[1], iris[2], .32 + .25 * inspect);
    c.live(2, .5, 0, 0, 0);
    c.chan(3, aura, .09 + .12 * inspect);
}

// The eye's gaze toward the camera (from its centre), offset by the saccade, and its pupil.
inline void watcher_look(const CameraInKnife &camera, const Pivots &p, Pieces &c, const Memory &m) {
    V3 d = {camera.position[0] - p.eye[0], camera.position[1] - p.eye[1], camera.position[2] - p.eye[2]};
    double length = std::hypot(std::hypot(d[0], d[1]), d[2]);
    if (length == 0) length = 1;
    d = d * (1 / length);
    const double gx = m.gaze_x.value_or(0), gy = m.gaze_y.value_or(0);
    V3 g{};
    for (size_t k = 0; k < 3; k++)
        g[k] = d[k] + camera.right[k] * gx + camera.up[k] * gy;
    c.live(0, g[0], g[1], g[2], m.pupil.value_or(.21));
}

inline void frostrune(const PlaySignals &s, Pieces &c, Memory &m, double dt) {
    constexpr int letters = 5;
    constexpr V3 frost = {.32, .7, 1.0};
    const double breath = .5 + .5 * std::sin(s.t * pi * 2 / 5.5);
    const double rest = .1 + .05 * breath;
    const double boost = .22 * s.speed01() + .25 * s.land_hard * std::max(0., 1 - s.since_land() / .4);
    // The flare runs along the word once each time the chain reaches the whole word.
    if (s.chain == letters && m.flare_chain_time.value_or(-1) != s.chain_time) {
        m.flare_chain_time = s.chain_time;
        m.flare_time = s.t;
    }
    const double flare = s.t - m.flare_time.value_or(-1e9);
    std::array<double, letters + 1> level{};
    for (int i = 0; i <= letters; i++) {
        auto &stored = m.letters[size_t(i)];
        double target;
        if (s.still)
            target = .5;
        else if (i < letters) {
            const bool awake = s.chain >= i + 1;
            // Going back to sleep: last letter first, one every 0.12 s after the chain ended.
            const bool hold =
                    !awake && s.chain == 0 && s.t - s.chain_time < (letters - 1 - i) * .12 && stored.value_or(0) > .5;
            target = std::min(1., (awake || hold ? .78 : rest) + boost);
            const double since = (flare - i * .07) / .09;
            target += .9 * std::exp(-since * since);
        } else
            target = std::min(1., .22 + .15 * breath + .5 * std::min(1., double(s.chain) / letters) + boost);
        const double current = stored.value_or(rest);
        const double v = s.still ? target : approach(current, target, target > current ? 16 : 3.2, dt);
        stored = v;
        level[size_t(i)] = v;
    }
    c.live(2, level[0], level[1], level[2], level[3]);
    c.live(3, level[4], level[5], 0, letters);
    c.chan(0, frost, 1);
    for (size_t i = 0; i <= letters; i++)
        c.chan(1 + i, frost, .04 + .62 * std::min(1.5, level[i]));
}

inline void clockwork(const PlaySignals &s, Pieces &c, Memory &m, const Pivots &p, double dt) {
    constexpr V3 across = {1, 0, 0};
    const double frequency = s.still ? 0 : .9 + 2.0 * s.speed01() + 1.2 * s.inspect;
    // The phase is the integral of the rate (trapezoid), the same at any frame rate.
    m.phase = m.phase.value_or(0) + dt * (frequency + m.frequency.value_or(frequency)) / 2;
    m.frequency = frequency;
    if (!s.still && m.lands.value_or(0) != s.lands) {
        m.lands = s.lands;
        m.kick = std::max(m.kick.value_or(0), .5 + .8 * s.land_hard);
    }
    m.kick = approach(m.kick.value_or(0), 0, 1.6, dt);
    const double amplitude = s.still ? .6 : .85 + *m.kick;
    const double phase = *m.phase;
    const double balance = std::sin(phase * pi * 2) * amplitude;
    // The escape wheel advances one tooth each half swing, eased over the first fifth of it.
    const double half = phase * 2, n = std::floor(half), into = std::min(1., (half - n) / .2);
    const double escape = -(n + into * into * (3 - 2 * into)) * pi * 2 / p.teeth;
    c.piece(1, p.balance, across, balance);
    c.piece(2, p.escape, across, escape);
    c.piece(3, p.gear, across, -escape * p.teeth / 10 * .73);
    c.chan(4, V3{1, .25, .35}, .12 + .1 * std::abs(std::cos(phase * pi * 2)));
}

inline void forge_spark(const PlaySignals &s, Pieces &c, size_t i) {
    constexpr size_t burst_sparks = 7;
    constexpr V3 ember = {1.0, .45, .1}, up = {0, 0, 1};
    const bool burst = i < burst_sparks;
    double age = -1, seed = 0, life = .9;
    if (s.still)
        age = -1;
    else if (burst) {
        age = s.since_land();
        seed = s.lands * 31 + double(i);
        life = .55 + .45 * hash1(seed * 3 + 1);
    } else {
        const double shifted = s.t + double(i) * .77;
        const auto lone = schedule(shifted, 2, 4, 50 + double(i));
        age = shifted - lone.at;
        seed = lone.index * 17 + double(i) * 101;
        life = 1.6;
    }
    if (age < 0 || age > life || (burst && s.lands == 0)) {
        c.chan(2 + i, ember, 0);
        return;
    }
    const auto h = [&](int k) {
        return hash1(seed * 7 + k) - .5;
    };
    const V3 v = burst ? V3{h(1) * 1.6, h(2) * 2.2, 1.2 + (h(3) + .5) * 1.8}
                       : V3{h(1) * .3, h(2) * .5, .45 + (h(3) + .5) * .3};
    // Rising embers slow down (drag) and drift a little.
    constexpr double drag = 2.2;
    const double e = (1 - std::exp(-drag * age)) / drag;
    const V3 at = {
            v[0] * e, v[1] * e + .08 * std::sin(age * 5 + seed), v[2] * e + (burst ? -.25 * age * age : .05 * age)
    };
    c.piece(2 + i, {}, up, 0, 1, at);
    const double f = age / life;
    c.chan(2 + i, V3{1, .55 + .35 * (1 - f), .2}, (burst ? 1.0 : .6) * (1 - f) * (1 - f) * std::min(1., age / .04));
}

inline void forge(const PlaySignals &s, Pieces &c, Memory &m, double dt) {
    constexpr size_t sparks = 10;
    constexpr V3 ember = {1.0, .45, .1};
    const double breath = .5 + .5 * std::sin(s.t * pi * 2 / 4);
    const double flash = s.land_hard * std::max(0., 1 - s.since_land() / .6);
    const double target = s.still ? .55 : .3 + .22 * breath + .55 * s.speed01() + .3 * flash;
    m.heat = s.still ? target : approach(m.heat.value_or(target), target, 3, dt);
    c.live(0, *m.heat, s.still ? 0 : s.t * .15, 0, 0);
    c.chan(1, ember, .05 + .13 * *m.heat);
    // A burst on each landing (the first seven), lone embers on a 2..4 s schedule (the rest).
    for (size_t i = 0; i < sparks; i++)
        forge_spark(s, c, i);
}

inline void deep(const PlaySignals &s, Pieces &c, Memory &m, const Pivots &p, double dt) {
    constexpr V3 lure = {.45, 1.0, .8};
    if (!s.still && m.lands.value_or(0) != s.lands) {
        m.lands = s.lands;
        m.pitch.kick(-2.2 * s.land_hard - .6);
    }
    // The lure leans against the turn (about the knife's z), back with speed, down on a landing.
    const double yaw_target = s.still ? 0 : -.5 * std::tanh(s.turn / 300);
    const double pitch_target = s.still ? 0 : .18 * s.speed01();
    const double yaw = s.still ? 0 : m.yaw.step(yaw_target, 1.4, .22, dt);
    const double pitch = s.still ? 0 : m.pitch.step(pitch_target, 1.7, .2, dt);
    c.piece2(1, p.lure, {1, 0, 0}, pitch, {0, 0, 1}, yaw);
    const double breath = .5 + .5 * std::sin(s.t * pi * 2 / 3.2);
    m.glow = s.still ? .7 : approach(m.glow.value_or(.6), .55 + .3 * breath + .25 * s.speed01(), 5, dt);
    c.chan(1, lure, *m.glow);
    m.wave = m.wave.value_or(0) + dt * (s.still ? 0 : 1.1 + 3 * s.speed01());
    c.live(0, *m.wave, s.still ? .9 : .8 + .4 * s.speed01(), 6, 0);
    c.chan(0, lure, 1);
}

// storm.ts wobble: smooth noise of one variable (sines at incommensurate rates).
inline double wobble(double t, double k) {
    return std::sin(t * 1.7 + k * 2.1) * .55 + std::sin(t * 2.9 + k * 4.3) * .3 + std::sin(t * 5.3 + k * 1.3) * .15;
}

inline void storm(const PlaySignals &s, Pieces &c, Memory &m, const Pivots &p, double dt) {
    constexpr int dots = 5;
    constexpr V3 arc = {.72, .6, 1.0};
    const double discharge = s.still ? 0 : s.land_hard * std::max(0., 1 - s.since_land() / .35) * (s.lands > 0 ? 1 : 0);
    const double level = s.still ? .45 : approach(m.level.value_or(.3), .28 + .5 * s.speed01(), 4, dt);
    m.level = level;
    // The arc's own clock runs faster with speed (integrated, so it never jumps).
    m.phase = m.phase.value_or(0) + dt * (s.still ? 0 : 1 + 2.2 * s.speed01() + 4 * discharge);
    const double phase = *m.phase;
    c.chan(1, arc, .35 + .5 * level + .8 * discharge);
    for (const int side : {1, -1}) {
        const V3 &from = side > 0 ? p.tip_right : p.tip_left, &to = side > 0 ? p.edge_right : p.edge_left;
        for (int j = 0; j < dots; j++) {
            const double t = (j + .5) / dots, k = side * 10 + j;
            // The bend: zero at both ends, wandering toward and away from the viewer and along the arc's normal.
            const double envelope = std::sin(t * pi), amplitude = (.09 + .14 * discharge) * envelope;
            const V3 at = {
                    from[0] + (to[0] - from[0]) * t + wobble(phase, k) * amplitude * 1.4,
                    from[1] + (to[1] - from[1]) * t + wobble(phase * 1.3, k + 5) * amplitude * .6,
                    from[2] + (to[2] - from[2]) * t + wobble(phase * .9, k + 9) * amplitude + .12 * envelope,
            };
            const size_t channel = size_t((side > 0 ? 2 : 7) + j);
            c.piece(channel, {}, {0, 0, 1}, 0, 1, at);
            // Brightness flows along the arc, so it reads as current rather than a still line.
            const double flow = .75 + .25 * std::sin(phase * 3 - j * 1.2 + side);
            c.chan(channel, arc, (.22 + .6 * level + 1.2 * discharge) * flow);
        }
    }
}

inline void bloom(const PlaySignals &s, Pieces &c, Memory &m, const Pivots &p, double dt) {
    constexpr V3 warm = {1, .75, .4}, across = {1, 0, 0};
    const double target = s.still ? .5 : std::min(1., .12 + .95 * s.speed01() + s.inspect);
    const double rate = target > m.open.value_or(0) ? 2.2 : 1.1;
    m.open = s.still ? target : approach(m.open.value_or(.12), target, rate, dt);
    c.morph(3, *m.open);
    if (!s.still && m.lands.value_or(0) != s.lands) {
        m.lands = s.lands;
        m.leaf_up.kick(-3 * s.land_hard - 1);
        m.leaf_down.kick(3 * s.land_hard + 1);
    }
    const double sway = s.still ? 0 : .35 * std::tanh(s.turn / 300);
    const double up = s.still ? 0 : m.leaf_up.step(sway + .05 * std::sin(s.t * 1.3), 1.8, .25, dt);
    const double down = s.still ? 0 : m.leaf_down.step(-sway + .05 * std::sin(s.t * 1.1 + 1), 1.6, .25, dt);
    const double reach = std::max(.35, p.grip_half + .05);
    c.piece(1, {0, p.grip_center + reach, p.flower_z - .2}, across, up);
    c.piece(2, {0, p.grip_center - reach, p.flower_z - .3}, across, down);
    c.chan(4, warm, .12 + .35 * *m.open);
    c.chan(3, warm, .2 + .6 * *m.open);
}

}  // namespace designs

// One design's frame (designs/*.ts animate), after the signals have been updated.
inline void animate(Design design, const PlaySignals &s, Pieces &c, Memory &m, const Pivots &p, double dt) {
    switch (design) {
        case Design::watcher:
            designs::watcher(s, c, m, dt);
            break;
        case Design::frostrune:
            designs::frostrune(s, c, m, dt);
            break;
        case Design::clockwork:
            designs::clockwork(s, c, m, p, dt);
            break;
        case Design::forge:
            designs::forge(s, c, m, dt);
            break;
        case Design::deep:
            designs::deep(s, c, m, p, dt);
            break;
        case Design::storm:
            designs::storm(s, c, m, p, dt);
            break;
        case Design::bloom:
            designs::bloom(s, c, m, p, dt);
            break;
    }
}

}  // namespace native_hilt
