#pragma once
// func_precipitation snow and rain (website map-effects/precipitation.ts, research/PRECIPITATION.md): the volumes, the
// particle fields, the column map and spans, translated line for line so the native client draws the same particles in
// the same places (precipitation_tests.cpp checks them against the website's numbers). GL-free; the drawing is
// precipitation_render.hpp.
//
// Every particle is a pure function of time: a field that repeats every 2 * half units, anchored to the world and
// falling through it, evaluated in the vertex shader. Particles may be only inside a volume's cell column (traced once
// through the core at map load).
#include "nlohmann/json.hpp"
#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <numeric>
#include <optional>
#include <string>
#include <vector>

namespace native_precip {

enum class Kind { snowfall = 0, rain = 1, snow = 2 };
inline constexpr std::array<Kind, 3> kinds = {Kind::snowfall, Kind::rain, Kind::snow};
inline constexpr const char *kind_names[3] = {"snowfall", "rain", "snow"};

/** Every particle's motion repeats exactly after this many seconds, so time is wrapped to it without a jump. */
inline constexpr double period = 600;
/** Volumes a particle is tested against (the nearest ones around the camera). */
inline constexpr int max_active = 16;
inline constexpr double empty_column = 1e9;
/** How far above the eye CS:S emits rain (ComputeEmissionArea). */
inline constexpr double streak_emit_above = 512;
inline constexpr double pi = 3.14159265358979323846, tau = 2 * pi;

/** JavaScript's Math.round, including its negative zero (-0.4 and -0 round to -0). */
inline double js_round(double v) {
    const double rounded = std::floor(v + .5);
    return rounded == 0 && std::signbit(v) ? -0. : rounded;
}

/** JavaScript's Number(text): surrounding white space ignored, "" is 0, anything else unparsable is NaN. */
inline double js_number(const std::string &text) {
    size_t a = 0, b = text.size();
    while (a < b && std::isspace(static_cast<unsigned char>(text[a]))) ++a;
    while (b > a && std::isspace(static_cast<unsigned char>(text[b - 1]))) --b;
    if (a == b) return 0;
    const std::string s = text.substr(a, b - a);
    if (s == "Infinity" || s == "+Infinity") return std::numeric_limits<double>::infinity();
    if (s == "-Infinity") return -std::numeric_limits<double>::infinity();
    for (char c : s)
        if (!(std::isdigit(static_cast<unsigned char>(c)) || c == '.' || c == '-' || c == '+' || c == 'e' || c == 'E'))
            return std::numeric_limits<double>::quiet_NaN();
    char *end = nullptr;
    const double v = std::strtod(s.c_str(), &end);
    return end == s.c_str() + s.size() ? v : std::numeric_limits<double>::quiet_NaN();
}

/** Which kind a preciptype draws as, or none (ash 2 and the undefined 4). */
inline std::optional<Kind> kind_of(double type) {
    if (!std::isfinite(type)) return Kind::rain;
    const double t = std::trunc(type);
    if (t == 3) return Kind::snowfall;
    if (t == 1) return Kind::snow;
    if (t == 0) return Kind::rain;
    // CPrecipitation::Spawn: `if (type < 0 || type > NUM_PRECIPITATION_TYPES) type = RAIN` (NUM = 4).
    if (t < 0 || t > 4) return Kind::rain;
    return std::nullopt;
}

struct Field {
    std::array<double, 3> half;
    double density;
    int max;
    std::array<double, 2> fall;
    double drift;
    double swirl_share;
    std::array<double, 2> swirl_radius, swirl_speed;
    std::array<double, 2> size;
    /** Streak length in seconds of its velocity; 0 draws round sprites. */
    double length;
    /** sRGB 0..255. */
    std::array<int, 3> color;
    double alpha;
    /** View depths over which particles fade in. */
    std::array<double, 2> near_fade;
    double min_pixels;
};

/** The website's PRECIP_FIELDS (SDK 2013 c_effects.cpp numbers; see precipitation.ts). */
inline const Field &field(Kind kind) {
    static const std::array<Field, 3> fields = {
            Field{{640, 640, 384},
                  4.2e-6,
                  8192,
                  {37.5, 52.5},
                  5,
                  1,
                  {3, 8},
                  {.5, 1.4},
                  {.75, 1.25},
                  0,
                  {150, 175, 200},
                  .95,
                  {16, 64},
                  1},
            Field{{768, 768, 512},
                  .001 / 600,
                  8192,
                  {600, 600},
                  12,
                  0,
                  {0, 0},
                  {0, 0},
                  {.5, .5},
                  .1,
                  {129, 128, 129},
                  std::pow(.4, .8),
                  {8, 32},
                  1},
            Field{{768, 768, 512},
                  .001 / 600,
                  8192,
                  {600, 600},
                  0,
                  .5,
                  {28, 28},
                  {pi * 1.1, pi * 1.15},
                  {.5, .5},
                  .03,
                  {255, 255, 255},
                  std::pow(.4, .8),
                  {8, 32},
                  1},
    };
    return fields[size_t(kind)];
}

/** How far a streak falls per unit of volume height (CS:S: height / m_Speed seconds at r_rainspeed 600). */
inline double streak_fall(Kind kind) {
    return kind == Kind::rain ? 600. / 425 : kind == Kind::snow ? 600. / 80 : 0;
}

struct Volume {
    Kind kind = Kind::rain;
    /** Entity index (the core's order). */
    size_t entity = 0;
    std::array<double, 3> min{}, max{};
    /** renderamt (streak density; snowfall ignores it). */
    double amount = 255;
};

/** The website's map-effects/smoke.ts value(): the first key equal to `key` ignoring case, if it's a string. */
inline const nlohmann::json *entity_value(const nlohmann::json &e, const char *key) {
    if (!e.is_object()) return nullptr;
    for (auto it = e.begin(); it != e.end(); ++it) {
        const auto &name = it.key();
        size_t i = 0;
        for (; key[i] && i < name.size(); ++i)
            if (std::tolower(static_cast<unsigned char>(name[i])) != std::tolower(static_cast<unsigned char>(key[i])))
                break;
        if (!key[i] && i == name.size()) return &it.value();
    }
    return nullptr;
}

inline std::string entity_text(const nlohmann::json &e, const char *key, const std::string &fallback) {
    const auto *v = entity_value(e, key);
    return v && v->is_string() ? v->get<std::string>() : fallback;
}

/** The map's precipitation volumes that draw (bh_entities_json, bh_models_json: each model's dmodel mins / maxs). */
inline std::vector<Volume> volumes(const nlohmann::json &entities, const nlohmann::json &models) {
    std::vector<Volume> out;
    if (!entities.is_array()) return out;
    for (size_t i = 0; i < entities.size(); ++i) {
        const auto &e = entities[i];
        auto classname = entity_text(e, "classname", "");
        std::transform(classname.begin(), classname.end(), classname.begin(), [](unsigned char c) {
            return char(std::tolower(c));
        });
        if (classname != "func_precipitation") continue;
        const auto kind = kind_of(js_number(entity_text(e, "preciptype", "0")));
        const auto model = entity_text(e, "model", "");
        if (!kind || model.size() < 2 || model[0] != '*'
            || !std::all_of(model.begin() + 1, model.end(), [](unsigned char c) { return std::isdigit(c); }))
            continue;
        const size_t index = size_t(std::strtoull(model.c_str() + 1, nullptr, 10));
        if (!models.is_array() || index >= models.size()) continue;
        const auto &m = models[index];
        if (!m.contains("mins") || !m.contains("maxs")) continue;
        Volume v;
        v.kind = *kind;
        v.entity = i;
        bool empty = false;
        for (int k = 0; k < 3; ++k) {
            const double lo = m["mins"][k].get<float>(), hi = m["maxs"][k].get<float>();
            empty = empty || hi < lo;
            // vbsp pads model bounds by a unit on every side.
            v.min[size_t(k)] = lo + 1;
            v.max[size_t(k)] = hi - 1;
        }
        if (empty) continue;
        if (v.max[0] - v.min[0] < 1 || v.max[1] - v.min[1] < 1 || v.max[2] - v.min[2] < 1) continue;
        const double amount = js_number(entity_text(e, "renderamt", "255"));
        v.amount = std::isfinite(amount) ? amount : 255;
        out.push_back(v);
    }
    return out;
}

/** Instances of `kind` at full density, given its volumes' largest renderamt (streaks; snowfall ignores it). */
inline int field_count(Kind kind, double amount = 255) {
    const auto &f = field(kind);
    const double volume = 8 * f.half[0] * f.half[1] * f.half[2];
    // CS:S clamps the rain density at 0.01 (renderamt 2550).
    const double scale = kind == Kind::snowfall ? 1 : std::min(10., std::max(0., amount / 255));
    return int(std::min(double(f.max), js_round(f.density * volume * scale)));
}

/** A speed made a whole number of field repeats per period (so the field repeats exactly in time too). */
inline double periodic_speed(double speed, double repeat) {
    return js_round(speed * period / repeat) * repeat / period;
}
/** An angular speed made a whole number of turns per period. */
inline double periodic_turn(double w) { return js_round(w * period / tau) * tau / period; }

/** The website's smoke.ts particleRandom (a 32-bit integer hash), in [0, 1). */
inline double particle_random(uint32_t id, uint32_t channel) {
    uint32_t h = (id ^ ((channel + 1) * 0x9e3779b9u)) * 0x85ebca6bu;
    h = (h ^ (h >> 16)) * 0xc2b2ae35u;
    return double(h ^ (h >> 16)) / 4294967296.;
}

/** Floats per instance: base xyz + swirl phase; velocity xyz + swirl speed; size, swirl radius, density draw, alpha. */
inline constexpr size_t instance_floats = 12;

/** Per-instance data (website fieldInstances): a lower density draws a subset of a higher one. */
inline std::vector<float> instances(Kind kind, int count) {
    const auto &f = field(kind);
    const uint32_t seed = (uint32_t(kind) + 1) * 0x9e37u;
    const double p[3] = {f.half[0] * 2, f.half[1] * 2, f.half[2] * 2};
    std::vector<float> out(size_t(std::max(0, count)) * instance_floats);
    for (int i = 0; i < count; ++i) {
        const auto r = [&](uint32_t c) { return particle_random(uint32_t(i) * 13 + seed, c); };
        float *o = out.data() + size_t(i) * instance_floats;
        o[0] = float(r(0) * p[0]);
        o[1] = float(r(1) * p[1]);
        o[2] = float(r(2) * p[2]);
        o[3] = float(r(3) * tau);
        o[4] = float(periodic_speed(f.drift * (2 * r(4) - 1), p[0]));
        o[5] = float(periodic_speed(f.drift * (2 * r(5) - 1), p[1]));
        o[6] = float(-periodic_speed(f.fall[0] + (f.fall[1] - f.fall[0]) * r(6), p[2]));
        const bool swirls = r(9) < f.swirl_share;
        o[7] = swirls ? float(periodic_turn(f.swirl_speed[0] + (f.swirl_speed[1] - f.swirl_speed[0]) * r(7))) : 0.f;
        o[8] = float(f.size[0] + (f.size[1] - f.size[0]) * r(8));
        o[9] = swirls ? float(f.swirl_radius[0] + (f.swirl_radius[1] - f.swirl_radius[0]) * r(10)) : 0.f;
        o[10] = float(r(11));
        o[11] = float(.7 + .3 * r(12));
    }
    return out;
}

inline double wrap(double v, double repeat) { return v - std::floor(v / repeat) * repeat; }

struct Layout {
    int x = 0, y = 0, cols = 1, rows = 1;
    double cell = 16;
};

/** The air column of each cell of each volume: [lowest z, highest z] (RG floats), packed into one atlas. */
struct Columns {
    std::vector<float> data;
    int width = 1, height = 1;
    std::vector<Layout> layout;
    int traces = 0;
    bool truncated = false;
};

/**
 * For each cell (centre) of each volume, the first air below the volume's top and how far down it reaches (website
 * buildColumns, the same search and the same trace budget). `trace(sx, sy, sz, ex, ey, ez)`: the fraction of the line
 * travelled before a solid, 0 when it starts in one (the core's bh_trace_camera with radius 0).
 */
template <class Trace>
Columns build_columns(
        const std::vector<Volume> &vols, Trace &&trace, int max_cells = 131072, int max_traces = 400000,
        int atlas_width = 2048
) {
    double area = 0;
    for (const auto &v : vols)
        area += (v.max[0] - v.min[0]) * (v.max[1] - v.min[1]);
    const double base = std::min(64., std::max(16., std::ceil(std::sqrt(area / max_cells))));
    Columns out;
    out.layout.resize(vols.size());
    for (size_t i = 0; i < vols.size(); ++i) {
        const auto &v = vols[i];
        auto &l = out.layout[i];
        l.cell = std::max(base, std::ceil(std::max(v.max[0] - v.min[0], v.max[1] - v.min[1]) / atlas_width));
        l.cols = std::max(1, int(std::ceil((v.max[0] - v.min[0]) / l.cell)));
        l.rows = std::max(1, int(std::ceil((v.max[1] - v.min[1]) / l.cell)));
    }
    // Shelf packing, tallest first (a stable sort, as the website's Array.sort).
    std::vector<size_t> order(vols.size());
    std::iota(order.begin(), order.end(), size_t(0));
    std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) {
        return out.layout[a].rows > out.layout[b].rows;
    });
    int x = 0, y = 0, shelf = 0, width = 1;
    for (const size_t i : order) {
        auto &l = out.layout[i];
        if (x + l.cols > atlas_width) {
            x = 0;
            y += shelf;
            shelf = 0;
        }
        l.x = x;
        l.y = y;
        x += l.cols;
        shelf = std::max(shelf, l.rows);
        width = std::max(width, x);
    }
    out.width = width;
    out.height = std::max(1, y + shelf);
    out.data.resize(size_t(out.width) * size_t(out.height) * 2);
    for (size_t i = 0; i < out.data.size(); i += 2) {
        out.data[i] = float(empty_column);
        out.data[i + 1] = float(-empty_column);
    }
    const auto t = [&](double sx, double sy, double sz, double ex, double ey, double ez) {
        ++out.traces;
        return double(trace(sx, sy, sz, ex, ey, ez));
    };
    for (size_t vi = 0; vi < vols.size(); ++vi) {
        const auto &v = vols[vi];
        const auto &l = out.layout[vi];
        // Snowfall stays in the volume; a streak's column goes down to the first solid, however far.
        const double top = v.max[2], bottom = v.kind == Kind::snowfall ? v.min[2] : std::min(v.min[2], -16384.);
        for (int r = 0; r < l.rows; ++r)
            for (int c = 0; c < l.cols; ++c) {
                const double px = std::min(v.max[0], v.min[0] + (c + .5) * l.cell),
                             py = std::min(v.max[1], v.min[1] + (r + .5) * l.cell);
                const size_t o = (size_t(l.y + r) * size_t(out.width) + size_t(l.x + c)) * 2;
                if (out.traces >= max_traces) {
                    out.truncated = true;
                    out.data[o] = float(v.min[2]);
                    out.data[o + 1] = float(top);
                    continue;
                }
                const double start = top - .5;
                const double f = t(px, py, start, px, py, bottom);
                if (f > 0) {
                    out.data[o] = float(start + (bottom - start) * f);
                    out.data[o + 1] = float(top);
                    continue;
                }
                // The top is inside a solid (sky, roof, the void): step down to the first air, then find that solid's
                // underside. Snowfall looks only within the volume's height; a streak anywhere below, in at most 16 steps.
                const double lowest = v.kind == Kind::snowfall ? v.min[2] : bottom;
                double above = start, step = 32, z = start - step;
                int probes = 0;
                while (z > lowest && probes++ < 16 && out.traces < max_traces) {
                    const double g = t(px, py, z, px, py, bottom);
                    if (g > 0) {
                        const double up = t(px, py, z, px, py, above);
                        out.data[o] = float(z + (bottom - z) * g);
                        out.data[o + 1] = float(z + (above - z) * up);
                        break;
                    }
                    above = z;
                    if (start - z >= 128) step = std::min(step * 2, 512.);
                    z -= step;
                }
            }
    }
    return out;
}

struct Span {
    double floor, top;
};

/** Where a particle at (x, y, z) may be drawn, as the shaders test (website precipitationSpan). */
inline std::optional<Span> span(
        Kind kind, const std::vector<Volume> &vols, const Columns &columns, double x, double y, double z, double eye_z
) {
    for (size_t i = 0; i < vols.size(); ++i) {
        const auto &v = vols[i];
        if (v.kind != kind || x < v.min[0] || y < v.min[1] || x >= v.max[0] || y >= v.max[1]) continue;
        if (kind == Kind::snowfall && (z < v.min[2] || z >= v.max[2])) continue;
        const auto &l = columns.layout[i];
        const int c = std::min(l.cols - 1, std::max(0, int(std::floor((x - v.min[0]) / l.cell))));
        const int r = std::min(l.rows - 1, std::max(0, int(std::floor((y - v.min[1]) / l.cell))));
        const size_t o = (size_t(l.y + r) * size_t(columns.width) + size_t(l.x + c)) * 2;
        double floor = columns.data[o], top = columns.data[o + 1];
        if (kind != Kind::snowfall) {
            top = std::min(top, eye_z + streak_emit_above);
            floor = std::max(floor, top - (v.max[2] - v.min[2]) * streak_fall(kind));
        }
        if (z >= floor && z <= top) return Span{floor, top};
    }
    return std::nullopt;
}

/** Settings → Graphics → Snow and rain (graphicsPrecipitation): the share of the particles drawn. */
inline double density_of(const std::string &level) { return level == "full" ? 1 : level == "light" ? .5 : 0; }

/**
 * The website's PRESET_PRECIPITATION for the Quality preset these settings match (graphicsPreset: Lowest / Low off,
 * Medium light, High full), else full: what saved settings from before the setting get.
 */
inline std::string preset_level(const nlohmann::json &settings) {
    const auto value = [&](const char *key, const nlohmann::json &fallback) {
        return settings.is_object() && settings.contains(key) ? settings.at(key) : fallback;
    };
    const bool potato = value("graphicsPotato", false).is_boolean() && value("graphicsPotato", false).get<bool>();
    const bool antialias =
            !value("graphicsAntialias", true).is_boolean() || value("graphicsAntialias", true).get<bool>();
    const bool reflections =
            !value("graphicsWaterReflections", true).is_boolean() || value("graphicsWaterReflections", true).get<bool>();
    const auto number = [&](const char *key, double fallback) {
        const auto v = value(key, fallback);
        return v.is_number() ? v.get<double>() : fallback;
    };
    const double anisotropy = number("graphicsAnisotropy", 8), scale = number("graphicsResolutionScale", 1);
    struct Preset {
        bool potato, antialias;
        double anisotropy, scale;
        bool reflections;
        const char *level;
    };
    constexpr Preset presets[] = {
            {true, false, 1, .5, false, "off"},
            {true, false, 1, 1, false, "off"},
            {false, false, 4, 1, false, "light"},
            {false, true, 8, 1, true, "full"},
    };
    for (const auto &p : presets)
        if (p.potato == potato && p.antialias == antialias && p.anisotropy == anisotropy && p.scale == scale
            && p.reflections == reflections)
            return p.level;
    return "full";
}

}  // namespace native_precip
