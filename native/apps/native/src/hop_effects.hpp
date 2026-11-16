#pragma once
// Hop effects (web player/hop-fx.ts spawnHop, player/hop-layer.ts HopEmitter): a burst at the feet each time a player
// hops. The recipes come from the website at build time (export-hop-effects.ts writes hop-fx.json with every default
// resolved). A burst is spawned once as records the GPU animates from their age (hop_layer.hpp draws them), so this is
// all the CPU does: the spawn maths, which must give the website's records for the same seed, and where the burst is.
#include "nlohmann/json.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace native_hop {

constexpr double pi = 3.141592653589793;
// hop-layer.ts hopQuality.motion under prefers-reduced-motion.
constexpr double reduced_motion = .35;
constexpr size_t record_floats = 52, reach_directions = 8;
using Record = std::array<float, record_floats>;
using Rgb = std::array<double, 3>;
using Reach = std::array<float, reach_directions>;

// One group of pieces (hop-fx.ts HopPart), defaults resolved. A colour with a negative first channel is the trail's
// first (-1) or second (-2) colour.
struct Part {
    int shape = 0, orient = 0, exit = 0, n = 1;
    std::array<double, 2> life{}, size{};
    std::optional<std::array<double, 2>> out, up;
    std::optional<double> aim;
    double jitter = 0, ease = 2, aspect = 1, swirl = 0, ring = 0, lift = 0, arc = 360, spread = 0, inherit = 0;
    double gravity = 0, drag = 0, tilt = 0, spin = 0, turn = 0, rock = 0, lean = 0;
    std::array<double, 2> flutter{};
    Rgb color{}, color2{};
    double white = 0, cool = 0, soft = 0, flicker = 0, char_amount = 0, alpha = 1, glow = 0, hold = 0;
    double pop = 0, over = 0, attack = 0, param = 0, wait = 0, delay = 0;
    bool rim = false, radial = false;
};

// hop-fx.ts HOP_ORIENTS: "face", "floor", "streak", "flip", "up".
enum Orient { face = 0, floor = 1, streak = 2, flip = 3, up = 4 };

struct Recipes {
    size_t pool = 1024, slots = 32;
    int frame_cap = 16;
    double gap = .12, inherit_cap = 140, glow_cap = .7, no_cut = 1e4;
    double reach_step = 12, reach_far = 96;
    int reach_steps = 4, reach_refine = 3;
    std::string default_trail = "trail-gold";
    std::unordered_map<std::string, std::vector<Part>> effects;

    static Recipes read(const nlohmann::json &json);

    static Recipes load(const std::filesystem::path &path) {
        std::ifstream file(path);
        if (!file) throw std::runtime_error("Native hop effects absent: " + path.string());
        return read(nlohmann::json::parse(file));
    }

    const std::vector<Part> *effect(const std::string &id) const {
        const auto found = effects.find(id);
        return found == effects.end() ? nullptr : &found->second;
    }
};

namespace detail {
inline std::array<double, 2> pair(const nlohmann::json &value) {
    return {value.at(0).get<double>(), value.at(1).get<double>()};
}

inline Rgb rgb(const nlohmann::json &value) {
    return {value.at(0).get<double>(), value.at(1).get<double>(), value.at(2).get<double>()};
}

inline Part part(const nlohmann::json &j) {
    Part p;
    p.shape = j.at("shape");
    p.orient = j.at("orient");
    p.exit = j.at("exit");
    p.n = j.at("n");
    p.life = pair(j.at("life"));
    p.size = pair(j.at("size"));
    if (!j.at("out").is_null()) p.out = pair(j.at("out"));
    if (!j.at("up").is_null()) p.up = pair(j.at("up"));
    if (!j.at("aim").is_null()) p.aim = j.at("aim").get<double>();
    const std::pair<const char *, double *> numbers[] = {
            {"jitter", &p.jitter}, {"ease", &p.ease},       {"aspect", &p.aspect},   {"swirl", &p.swirl},
            {"ring", &p.ring},     {"lift", &p.lift},       {"arc", &p.arc},         {"spread", &p.spread},
            {"inherit", &p.inherit}, {"gravity", &p.gravity}, {"drag", &p.drag},     {"tilt", &p.tilt},
            {"spin", &p.spin},     {"turn", &p.turn},       {"rock", &p.rock},       {"lean", &p.lean},
            {"white", &p.white},   {"cool", &p.cool},       {"soft", &p.soft},       {"flicker", &p.flicker},
            {"char", &p.char_amount}, {"alpha", &p.alpha},  {"glow", &p.glow},       {"hold", &p.hold},
            {"pop", &p.pop},       {"over", &p.over},       {"attack", &p.attack},   {"param", &p.param},
            {"wait", &p.wait},     {"delay", &p.delay},
    };
    for (const auto &[name, field] : numbers)
        *field = j.at(name).get<double>();
    p.flutter = pair(j.at("flutter"));
    p.color = rgb(j.at("color"));
    p.color2 = rgb(j.at("color2"));
    p.rim = j.at("rim");
    p.radial = j.at("radial");
    return p;
}
}  // namespace detail

inline Recipes Recipes::read(const nlohmann::json &json) {
    Recipes r;
    if (json.at("record").get<size_t>() != record_floats) throw std::runtime_error("Unsupported hop effect records");
    r.pool = json.at("pool");
    r.slots = json.at("slots");
    r.frame_cap = json.at("frameCap");
    r.gap = json.at("gap");
    r.inherit_cap = json.at("inheritCap");
    r.glow_cap = json.at("glowCap");
    r.no_cut = json.at("noCut");
    const auto &reach = json.at("reach");
    r.reach_step = reach.at("step");
    r.reach_steps = reach.at("steps");
    r.reach_refine = reach.at("refine");
    r.reach_far = reach.at("far");
    r.default_trail = json.at("defaultTrail");
    for (const auto &[id, parts] : json.at("effects").items())
        for (const auto &part : parts)
            r.effects[id].push_back(detail::part(part));
    return r;
}

// hop-fx.ts HopSpawn, in three.js space (y up).
struct Spawn {
    double x = 0, y = 0, z = 0, vx = 0, vz = 0, t = 0;
    int slot = 0;
    double quality = 1, motion = 1;
    Rgb tint{1, 1, 1}, tint2{1, 1, 1};
    double alpha = 1;
    std::optional<Reach> reach;
    std::optional<std::array<double, 2>> slope;
};

// hop-fx.ts rnd: mulberry32.
class Random {
    uint32_t state_;

public:
    explicit Random(int32_t seed) : state_(uint32_t(seed ? seed : 1)) {}

    double next() {
        state_ += 0x6d2b79f5u;
        uint32_t x = (state_ ^ (state_ >> 15)) * (1u | state_);
        x = (x + (x ^ (x >> 7)) * (61u | x)) ^ x;
        return double(x ^ (x >> 14)) / 4294967296.0;
    }

    double in(const std::optional<std::array<double, 2>> &range) {
        if (!range) return 0;
        return (*range)[0] + ((*range)[1] - (*range)[0]) * next();
    }
};

// JavaScript's Math.round then `| 0`.
inline int32_t js_round_int(double x) {
    const double rounded = std::floor(x + .5);
    if (!std::isfinite(rounded)) return 0;
    return int32_t(uint32_t(int64_t(std::fmod(rounded, 4294967296.0))));
}

// hop-fx.ts hopSeed: the same place and time make the same burst.
inline int32_t hop_seed(double x, double z, double t) {
    uint32_t h = uint32_t(js_round_int(x)) * 0x9e3779b1u ^ uint32_t(js_round_int(z)) * 0x85ebca6bu
                 ^ uint32_t(js_round_int(t * 100)) * 0xc2b2ae35u;
    h ^= h >> 15;
    return int32_t(h);
}

inline double reach_toward(const Reach &reach, double dx, double dz) {
    const double f = std::fmod(std::fmod(std::atan2(-dz, dx) / (pi / 4), 8.) + 8, 8.);
    const size_t k = size_t(std::floor(f)) % reach_directions;
    return reach[k] + (reach[(k + 1) % reach_directions] - reach[k]) * (f - std::floor(f));
}

namespace detail {
inline const Rgb &color_of(const Rgb &color, const Spawn &s) {
    if (color[0] == -1) return s.tint;
    if (color[0] == -2) return s.tint2;
    return color;
}

struct PieceContext {
    const Part &part;
    const Spawn &spawn;
    const Recipes &recipes;
    double start, inherit, zeta;
    int count;
    const Rgb &c1, &c2;
};

// One piece (spawnHop's inner loop). The random draws follow the website's order exactly.
inline void piece(const PieceContext &c, int k, Random &rnd, Record &rec) {
    const Part &p = c.part;
    const Spawn &s = c.spawn;
    const double m = s.motion;
    const bool floor_piece = p.orient == floor, grounded = floor_piece || p.orient == up;
    const double arc = p.arc * pi / 180;
    const double a = c.start + (k + .5 + (rnd.next() * 2 - 1) * p.spread) * arc / c.count;
    const double dx = std::sin(a), dz = std::cos(a);
    double r = p.ring * (p.rim || p.radial ? 1 : .45 + .55 * rnd.next());
    if (grounded && s.reach && r > 0) r = std::max(0., std::min(r, reach_toward(*s.reach, dx, dz) - 2));
    const double out = rnd.in(p.out) * m, rise = rnd.in(p.up) * m;
    const double x = s.x + dx * r, z = s.z + dz * r;
    const double sx = s.slope ? (*s.slope)[0] : 0, sz = s.slope ? (*s.slope)[1] : 0;
    const double js = 1 + (rnd.next() * 2 - 1) * p.jitter;
    const double rot = p.radial         ? pi / 2 - a
                       : p.orient == up ? p.lean / std::max(p.ring, 1.)
                                        : (rnd.next() * 2 - 1) * p.tilt;
    const double swirl = p.swirl * m;
    const double high = grounded ? 0 : p.lift * (c.count == 1 ? 1 : .4 + .6 * rnd.next());
    const auto f = [](double v) {
        return float(v);
    };
    rec[0] = f(x);
    rec[1] = f(s.y + (floor_piece ? .6 : grounded ? .3 + (x - s.x) * sx + (z - s.z) * sz : high));
    rec[2] = f(z);
    rec[3] = f(s.t + p.wait + k * p.delay);
    rec[4] = f(dx * out + dz * swirl + s.vx * c.inherit);
    rec[5] = f(rise);
    rec[6] = f(dz * out - dx * swirl + s.vz * c.inherit);
    rec[7] = f(rnd.in(p.life));
    rec[8] = f(p.size[0] * js);
    rec[9] = f(p.size[1] * js);
    rec[10] = f(p.gravity * m);
    rec[11] = f(p.drag);
    for (size_t i = 0; i < 3; ++i) {
        rec[12 + i] = f(c.c1[i]);
        rec[16 + i] = f(c.c2[i]);
    }
    rec[15] = f(p.alpha * s.alpha);
    rec[19] = f(std::min(p.glow, c.recipes.glow_cap));
    rec[20] = f(p.shape + 32 * p.orient + 256 * p.exit);
    rec[21] = f(p.rock);
    rec[22] = f(rot);
    const double sign = rnd.next() < .5 ? -1 : 1;
    const double piece_seed = rnd.next();
    rec[25] = f(p.rim ? (c.count > 1 ? double(k) / (c.count - 1) : .5) : piece_seed);
    rec[23] = f(p.orient == up ? (p.rim ? pi / 2 - a : piece_seed * 40) : p.spin * m * sign);
    rec[24] = f(s.slot);
    rec[26] = f(p.orient == face || p.orient == flip ? high : p.param);
    rec[27] = f(std::min(p.hold, .98));
    for (size_t i = 0; i < reach_directions; ++i)
        rec[28 + i] = floor_piece ? (s.reach ? (*s.reach)[i] : f(c.recipes.no_cut)) : -1;
    rec[36] = f(p.pop);
    rec[37] = f(c.zeta);
    rec[38] = f(p.attack);
    rec[39] = f(p.ease);
    rec[40] = f(s.x);
    rec[41] = f(s.z);
    rec[42] = f(sx);
    rec[43] = f(sz);
    rec[44] = f(p.white);
    rec[45] = f(p.cool);
    rec[46] = f(p.soft);
    rec[47] = f(std::min(p.flicker, .9) + 10 * std::floor(p.char_amount * 10 + .5));
    rec[48] = f(p.aspect);
    rec[49] = f(p.turn * m * (rnd.next() < .5 ? -1 : 1));
    rec[50] = f(p.flutter[0]);
    rec[51] = f(p.flutter[1] * m);
}
}  // namespace detail

// hop-fx.ts spawnHop: calls `write` once per piece; returns how many it wrote.
template <class Write>
int spawn(const std::vector<Part> &parts, const Recipes &recipes, const Spawn &s, int32_t seed, Write &&write) {
    Random rnd(seed);
    int written = 0;
    const double speed = std::hypot(s.vx, s.vz);
    const double heading = speed > 1 ? std::atan2(s.vx, s.vz) : 0;
    Record rec{};
    for (const auto &p : parts) {
        const int count = p.n == 1 ? 1 : std::max(1, int(std::floor(p.n * s.quality + .5)));
        const double arc = p.arc * pi / 180;
        const double start = p.aim ? heading + *p.aim * pi / 180 - arc / 2 : rnd.next() * pi * 2;
        const double zeta = std::max(
                .2, std::log(std::max(std::abs(1 - p.pop), 1e-3) / std::max(p.over, 1e-3))
        );
        const double inherit = speed > 0 ? std::min(p.inherit * speed, recipes.inherit_cap) / speed * s.motion : 0;
        const detail::PieceContext context{
                p, s, recipes, start, inherit, zeta, count, detail::color_of(p.color, s), detail::color_of(p.color2, s)
        };
        for (int k = 0; k < count; ++k) {
            detail::piece(context, k, rnd, rec);
            write(rec);
            ++written;
        }
    }
    return written;
}

// The ground under a point (Source units), or none: NativeViewmodel::ground_below.
using GroundProbe = std::function<std::optional<double>(double, double, double)>;

// hop-layer.ts constants: a jump's vertical speed and gravity, how far back a hop is traced, the tolerances of the
// takeoff's floor and of the floor round it, the margin a hop at an edge is moved in by, and the steepest slope
// followed.
constexpr double takeoff_vz = 298, gravity = 800, hop_back_seconds = .05, takeoff_tolerance = 6;
constexpr double hop_margin = 12, reach_tolerance = 4, slope_max = 1;
constexpr std::array<double, 3> settle_radii = {12, 20, 28};

// What a burst needs from where it happened (Source units): the takeoff, the floor round it and its slope.
struct Place {
    double x = 0, y = 0, z = 0;
    std::optional<Reach> reach;
    std::array<double, 2> slope{};
};

// hop-layer.ts HopEmitter.reach: how far the floor at height z goes from (x, y) in eight directions, and the slope.
inline std::optional<Reach>
floor_reach(const Recipes &recipes, const GroundProbe &probe, double x, double y, double z, std::array<double, 2> &slope) {
    if (!probe) return std::nullopt;
    constexpr double side = 6, above = 8;
    const auto xa = probe(x + side, y, z + above), xb = probe(x - side, y, z + above);
    const auto ya = probe(x, y + side, z + above), yb = probe(x, y - side, z + above);
    double gx = 0, gy = 0;
    if (xa && xb && ya && yb) {
        gx = (*xa - *xb) / (2 * side);
        gy = (*ya - *yb) / (2 * side);
        if (std::abs(*xa + *xb - 2 * z) > 2 || std::abs(*ya + *yb - 2 * z) > 2 || std::abs(gx) > slope_max
            || std::abs(gy) > slope_max)
            gx = gy = 0;
    }
    slope = {gx, gy ? -gy : 0};
    const auto on = [&](double cx, double cy, double r) {
        const double rise = (gx * cx + gy * cy) * r;
        const auto g = probe(x + cx * r, y + cy * r, z + rise + above);
        return g && std::abs(*g - z - rise) <= reach_tolerance;
    };
    Reach out{};
    for (size_t k = 0; k < reach_directions; ++k) {
        const double a = double(k) * pi / 4, cx = std::cos(a), cy = std::sin(a);
        double good = 0, bad = 0;
        for (int i = 1; i <= recipes.reach_steps && !bad; ++i) {
            if (on(cx, cy, i * recipes.reach_step))
                good = i * recipes.reach_step;
            else
                bad = i * recipes.reach_step;
        }
        if (!bad) {
            out[k] = float(recipes.reach_far);
            continue;
        }
        for (int i = 0; i < recipes.reach_refine; ++i) {
            const double mid = (good + bad) / 2;
            (on(cx, cy, mid) ? good : bad) = mid;
        }
        out[k] = float(good);
    }
    return out;
}

// hop-layer.ts HopEmitter.settle: a hop at a floor's edge (or off it, under an overhanging hull) moved onto the floor.
inline std::optional<std::array<double, 2>>
settle(const Recipes &recipes, const GroundProbe &probe, const Reach &reach, double x, double y, double z) {
    const auto on = [&](double px, double py) {
        const auto g = probe(px, py, z + 8);
        return g && std::abs(*g - z) <= reach_tolerance;
    };
    double nx = 0, ny = 0, far = 0;
    for (const double r : settle_radii) {
        double sx = 0, sy = 0;
        int held = 0;
        for (size_t k = 0; k < reach_directions; ++k) {
            const double cx = std::cos(double(k) * pi / 4), cy = std::sin(double(k) * pi / 4);
            if (r == recipes.reach_step ? reach[k] >= r : on(x + cx * r, y + cy * r)) {
                sx += cx;
                sy += cy;
                ++held;
            }
        }
        if (held == int(reach_directions)) return std::nullopt;
        const double l = std::hypot(sx, sy);
        if (!held || l < .5) continue;
        nx = sx / l;
        ny = sy / l;
        far = r;
        break;
    }
    if (!far) return std::nullopt;
    double first = 0;
    for (double step = 4; step <= far + hop_margin + 8; step += 4) {
        if (!on(x + nx * step, y + ny * step)) continue;
        if (!first) first = step;
        if (step < hop_margin || !on(x + nx * (step - hop_margin), y + ny * (step - hop_margin))) continue;
        first = step;
        break;
    }
    if (!first) return std::nullopt;
    return std::array<double, 2>{x + nx * first, y + ny * first};
}

// The pose a burst is placed from (Source units).
struct Pose {
    std::array<double, 3> position{}, velocity{};
    bool grounded = false;
};

// One player's hop effect (hop-layer.ts HopEmitter, minus the layer it draws into).
struct Emitter {
    double ground_at = -1e18, ground_z = 0, last_burst = -1e18;

    void reset() {
        ground_at = last_burst = -1e18;
    }

    // Before a burst: the floor it left, after `clock`'s update with `pose`. Returns where it happened, or nothing
    // (no jump, too soon after the last one).
    std::optional<Place> takeoff(
            const Recipes &recipes,
            const std::vector<Part> &parts,
            const Pose &pose,
            double clock,
            bool jumped,
            const GroundProbe &probe,
            double &back_seconds
    ) {
        if (pose.grounded) {
            ground_at = clock;
            ground_z = pose.position[2];
        }
        if (clock < last_burst) last_burst = -1e18;
        if (!jumped || clock - last_burst < recipes.gap) return std::nullopt;
        const auto &p = pose.position, &v = pose.velocity;
        back_seconds = std::min(hop_back_seconds, std::max(0., (takeoff_vz - v[2]) / gravity));
        const double back = back_seconds;
        Place place;
        place.x = p[0] - v[0] * back;
        place.y = p[1] - v[1] * back;
        place.z = ground_z;
        if (clock - ground_at >= .15) {
            place.z = p[2] - (v[2] * back + .5 * gravity * back * back);
            const auto under = probe ? probe(place.x, place.y, p[2] + 8) : std::nullopt;
            if (under && std::abs(*under - place.z) <= takeoff_tolerance) place.z = *under;
        }
        const bool on_ground = std::any_of(parts.begin(), parts.end(), [](const Part &part) {
            return part.orient == floor || part.orient == up;
        });
        if (on_ground) place.reach = floor_reach(recipes, probe, place.x, place.y, place.z, place.slope);
        if (place.reach) {
            if (const auto moved = settle(recipes, probe, *place.reach, place.x, place.y, place.z)) {
                place.x = (*moved)[0];
                place.y = (*moved)[1];
                place.reach = floor_reach(recipes, probe, place.x, place.y, place.z, place.slope);
            }
        }
        return place;
    }
};

}  // namespace native_hop
