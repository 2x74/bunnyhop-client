#pragma once

// Typed at load, sampled from tick time only. The web sampler supplies the cross-client test vectors.
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cctype>
#include <cstdlib>
#include <stdexcept>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

namespace native_crash {
using Json = nlohmann::json;
using Point = std::array<double, 3>;
inline constexpr const char *bsp_sha256 = "c2b3bc1e5a3f2507df4b7aa6ed71af7c2ac38edb12c41939547d25268ec9613e";
inline constexpr size_t birth_limit = 512;
inline constexpr double event_seconds = 3;
inline constexpr double pi = 3.14159265358979323846;

inline double number(const Json &object, const char *key, double fallback = 0) {
    const auto at = object.find(key);
    if (at == object.end()) return fallback;
    if (at->is_number()) return at->get<double>();
    if (!at->is_string()) return fallback;
    const auto &text = at->get_ref<const std::string &>();
    if (text.empty()) return 0;
    char *end = nullptr;
    const double value = std::strtod(text.c_str(), &end);
    while (end && std::isspace(static_cast<unsigned char>(*end)))
        ++end;
    return end != text.c_str() && end && *end == 0 && std::isfinite(value) ? value : fallback;
}

inline Point vector(const Json &object, const char *key, Point fallback = {}) {
    const auto at = object.find(key);
    if (at == object.end() || !at->is_string()) return fallback;
    std::istringstream stream(at->get<std::string>());
    for (auto &value : fallback)
        if (!(stream >> value)) break;
    return fallback;
}

inline const Json &group(const Json &object, const char *key) {
    static const Json empty = Json::object();
    const auto at = object.find(key);
    return at == object.end() ? empty : *at;
}

struct Random {
    uint32_t id;

    double operator()(uint32_t channel) const {
        uint32_t hash = (id ^ ((channel + 1) * 0x9e3779b9u)) * 0x85ebca6bu;
        hash = (hash ^ (hash >> 16)) * 0xc2b2ae35u;
        return double(hash ^ (hash >> 16)) / 4294967296.;
    }
};

inline double lerp(double a, double b, double t) {
    return a + (b - a) * t;
}

inline double fraction(double t, double a, double b) {
    return a == b ? double(t >= b) : std::clamp((t - a) / (b - a), 0., 1.);
}

inline double ease(double t) {
    return t * t * (3 - 2 * t);
}

struct Range {
    double low = 0, high = 0;

    double sample(Random random, uint32_t salt) const { return lerp(low, high, random(salt)); }
};

inline Range range(const Json &p, const char *low, const char *high, double fallback = 0) {
    return {number(p, low, fallback), number(p, high, fallback)};
}

inline Point rotate(Point v, Point angles) {
    const double pitch = angles[0] * pi / 180, yaw = angles[1] * pi / 180, roll = angles[2] * pi / 180;
    const double sp = std::sin(pitch), cp = std::cos(pitch), sy = std::sin(yaw), cy = std::cos(yaw),
                 sr = std::sin(roll), cr = std::cos(roll);
    return {cp * cy * v[0] + (sr * sp * cy - cr * sy) * v[1] + (cr * sp * cy + sr * sy) * v[2],
            cp * sy * v[0] + (sr * sp * sy + cr * cy) * v[1] + (cr * sp * sy - sr * cy) * v[2],
            -sp * v[0] + sr * cp * v[1] + cr * cp * v[2]};
}

struct Sheet {
    bool clamp = false;
    std::vector<std::array<double, 4>> frames;
};

struct Definition {
    std::string name, material;
    bool additive = false, box = false, offset = false, local_offset = false, color_fade = false;
    bool radius_ease = false, color_ease = false, oscillate = false, fit_lifetime = false;
    bool trail_renderer = false, horizontal = false;
    Range life, distance, speed, radius, alpha, rotation, spin, sequence, trail, oscillation;
    Point bias{1, 1, 1}, local_min{}, local_max{}, box_min{}, box_max{}, offset_min{}, offset_max{}, gravity{};
    Point color_min{255, 255, 255}, color_max{255, 255, 255}, color_target{255, 255, 255};
    double drag = 0, radius_start_time = 0, radius_end_time = 1, radius_start = 1, radius_end = 1, radius_bias = .5;
    double fade_in_start = 0, fade_in_end = 0, fade_out_start = 1, fade_out_end = 1, alpha_start = 1, alpha_end = 0;
    double color_start = 0, color_end = 1, frequency = 0, multiplier = 2, phase = 0;
    double initial_roll = 0, constant_spin = 0, spin_rate = 0, animation_rate = 1, min_trail = 0, max_trail = 512;
    std::vector<double> births;
    std::vector<Sheet> sheets;
    std::vector<std::pair<std::string, double>> children;
};

inline void compile_initializers(Definition &d, const Json &initializers) {
    d.life = range(group(initializers, "Lifetime Random"), "lifetime_min", "lifetime_max", 1);
    const auto &sphere = group(initializers, "Position Within Sphere Random");
    d.distance = range(sphere, "distance_min", "distance_max");
    d.speed = range(sphere, "speed_min", "speed_max");
    d.bias = vector(sphere, "distance_bias", {1, 1, 1});
    d.local_min = vector(sphere, "speed_in_local_coordinate_system_min");
    d.local_max = vector(sphere, "speed_in_local_coordinate_system_max");
    d.box = initializers.contains("Position Within Box Random");
    d.box_min = vector(group(initializers, "Position Within Box Random"), "min");
    d.box_max = vector(group(initializers, "Position Within Box Random"), "max");
    const auto &offset = group(initializers, "Position Modify Offset Random");
    d.offset = initializers.contains("Position Modify Offset Random");
    d.local_offset = number(offset, "offset in local space 0/1") != 0;
    d.offset_min = vector(offset, "offset min");
    d.offset_max = vector(offset, "offset max");
    d.radius = range(group(initializers, "Radius Random"), "radius_min", "radius_max", 5);
    d.alpha = range(group(initializers, "Alpha Random"), "alpha_min", "alpha_max", 255);
    d.color_min = vector(group(initializers, "Color Random"), "color1", {255, 255, 255});
    d.color_max = vector(group(initializers, "Color Random"), "color2", {255, 255, 255});
    const auto &rotation = group(initializers, "Rotation Random");
    d.rotation = range(rotation, "rotation_offset_min", "rotation_offset_max");
    d.initial_roll = number(rotation, "rotation_initial");
    const auto &spin = group(initializers, "Rotation Speed Random");
    d.spin = range(spin, "rotation_speed_random_min", "rotation_speed_random_max");
    d.constant_spin = number(spin, "rotation_speed_constant");
    d.sequence = range(group(initializers, "Sequence Random"), "sequence_min", "sequence_max");
    d.trail = range(group(initializers, "Trail Length Random"), "length_min", "length_max");
}

inline void compile_operators(Definition &d, const Json &operators) {
    d.gravity = vector(group(operators, "Movement Basic"), "gravity");
    d.drag = number(group(operators, "Movement Basic"), "drag");
    const auto &scale = group(operators, "Radius Scale");
    d.radius_start_time = number(scale, "start_time");
    d.radius_end_time = number(scale, "end_time", 1);
    d.radius_start = number(scale, "radius_start_scale", 1);
    d.radius_end = number(scale, "radius_end_scale", 1);
    d.radius_bias = number(scale, "scale_bias", .5);
    d.radius_ease = number(scale, "ease_in_and_out") != 0;
    const auto &alpha = group(operators, "Alpha Fade and Decay");
    d.fade_in_start = number(alpha, "start_fade_in_time");
    d.fade_in_end = number(alpha, "end_fade_in_time");
    d.fade_out_start = number(alpha, "start_fade_out_time", 1);
    d.fade_out_end = number(alpha, "end_fade_out_time", 1);
    d.alpha_start = number(alpha, "start_alpha", 1);
    d.alpha_end = number(alpha, "end_alpha");
    const auto &color = group(operators, "Color Fade");
    d.color_fade = operators.contains("Color Fade");
    d.color_target = vector(color, "color_fade", {255, 255, 255});
    d.color_start = number(color, "fade_start_time");
    d.color_end = number(color, "fade_end_time", 1);
    d.color_ease = number(color, "ease_in_and_out") != 0;
    const auto &osc = group(operators, "Oscillate Scalar");
    d.oscillate = operators.contains("Oscillate Scalar") && number(osc, "oscillation field") == 4;
    d.oscillation = range(osc, "oscillation rate min", "oscillation rate max");
    d.frequency = number(osc, "oscillation frequency min");
    d.multiplier = number(osc, "oscillation multiplier", 2);
    d.phase = number(osc, "oscillation start phase");
    d.spin_rate = number(group(operators, "Rotation Spin Roll"), "spin_rate_degrees");
}

inline Definition compile(const std::string &name, const Json &data) {
    Definition d;
    d.name = name;
    d.material = data.value("material", "");
    std::replace(d.material.begin(), d.material.end(), '\\', '/');
    std::transform(d.material.begin(), d.material.end(), d.material.begin(), [](unsigned char c) {
        return char(std::tolower(c));
    });
    if (d.material.ends_with(".vmt")) d.material.resize(d.material.size() - 4);
    if (d.material.starts_with("materials/")) d.material.erase(0, 10);
    d.additive = data.value("additive", false);
    compile_initializers(d, group(data, "initializers"));
    compile_operators(d, group(data, "operators"));
    for (const auto &[kind, params] : group(data, "emitters").items()) {
        const auto start = number(params, "emission_start_time"), rate = number(params, "emission_rate");
        const auto count = kind == "emit_instantaneously"
                                   ? number(params, "num_to_emit")
                                   : std::floor(rate * number(params, "emission_duration") + 1e-5);
        for (size_t i = 0; i < std::min(double(birth_limit), std::max(0., count)); ++i)
            d.births.push_back(start + (kind == "emit_instantaneously" ? 0 : (i + 1) / rate));
    }
    for (const auto &[sequence, sheet] : group(data, "sheet").items()) {
        const auto index = size_t(std::stoul(sequence));
        if (index > 255) throw std::runtime_error("Crash particle sheet sequence exceeds budget");
        if (d.sheets.size() <= index) d.sheets.resize(index + 1);
        d.sheets[index].clamp = sheet.value("clamp", false);
        for (const auto &frame : sheet.at("frames"))
            d.sheets[index].frames.push_back({frame[1], frame[2], frame[3], frame[4]});
    }
    for (const auto &child : group(data, "children"))
        d.children.emplace_back(child.at("child").get<std::string>(), number(child, "delay"));
    const auto &sprite = group(group(data, "renderers"), "render_animated_sprites");
    d.fit_lifetime = number(sprite, "animation_fit_lifetime") != 0;
    d.animation_rate = number(sprite, "animation rate", 1);
    d.horizontal = number(sprite, "orientation_type") == 2;
    const auto &trail = group(group(data, "renderers"), "render_sprite_trail");
    d.trail_renderer = group(data, "renderers").contains("render_sprite_trail");
    d.min_trail = number(trail, "min length");
    d.max_trail = number(trail, "max length", 512);
    return d;
}

struct Sample {
    Point position{}, velocity{}, color{};
    double radius = 0, alpha = 0, roll = 0, trail = 0;
    std::array<double, 4> uv{0, 0, 1, 1};
};

inline void motion(const Definition &d, Random random, double age, Point angles, Sample &p) {
    const double z = random(1) * 2 - 1, a = random(2) * 2 * pi, xy = std::sqrt(1 - z * z);
    const Point direction{z, xy * std::cos(a), xy * std::sin(a)};
    const double distance = d.distance.sample(random, 3), speed = d.speed.sample(random, 4);
    Point local{}, offset{};
    for (size_t i = 0; i < 3; ++i) {
        local[i] = lerp(d.local_min[i], d.local_max[i], random(5 + i));
        offset[i] = lerp(d.offset_min[i], d.offset_max[i], random(11 + i));
    }
    local = rotate(local, angles);
    if (d.local_offset) offset = rotate(offset, angles);
    const double travel = d.drag > 0 ? -std::expm1(-d.drag * age) / d.drag : age;
    for (size_t i = 0; i < 3; ++i) {
        p.velocity[i] = local[i] + direction[i] * speed;
        p.position[i] = direction[i] * distance * d.bias[i];
        if (d.box) p.position[i] += lerp(d.box_min[i], d.box_max[i], random(8 + i));
        if (d.offset) p.position[i] += offset[i];
        p.position[i] += p.velocity[i] * travel + d.gravity[i] * age * age / 2;
    }
}

inline void appearance(const Definition &d, Random random, double age, double t, Sample &p) {
    double rt = fraction(t, d.radius_start_time, d.radius_end_time);
    if (d.radius_ease)
        rt = ease(rt);
    else if (d.radius_bias > 0 && d.radius_bias < 1)
        rt = std::pow(rt, std::log(d.radius_bias) / std::log(.5));
    p.radius = d.radius.sample(random, 14) * lerp(d.radius_start, d.radius_end, rt);
    const double fade_in = fraction(t, d.fade_in_start, d.fade_in_end);
    const double fade_out = fraction(t, d.fade_out_start, d.fade_out_end);
    p.alpha = d.alpha.sample(random, 15) / 255 * lerp(d.alpha_start, 1, fade_in) * lerp(1, d.alpha_end, fade_out);
    double ct = fraction(t, d.color_start, d.color_end);
    if (d.color_ease) ct = ease(ct);
    for (size_t i = 0; i < 3; ++i) {
        p.color[i] = lerp(d.color_min[i], d.color_max[i], random(16)) / 255;
        if (d.color_fade) p.color[i] = lerp(p.color[i], d.color_target[i] / 255, ct);
    }
    if (d.oscillate)
        p.alpha *= std::clamp(
                1 + d.oscillation.sample(random, 17) * std::sin((t * d.frequency * d.multiplier + d.phase) * pi), 0., 1.
        );
    p.alpha = std::clamp(p.alpha, 0., 1.);
    p.roll = (d.rotation.sample(random, 18) + d.initial_roll
              + age * (d.spin.sample(random, 19) + d.constant_spin + d.spin_rate))
             * pi / 180;
    const auto sequence = size_t(std::floor(d.sequence.sample(random, 20) + .5));
    if (sequence < d.sheets.size() && !d.sheets[sequence].frames.empty()) {
        const auto &sheet = d.sheets[sequence];
        const auto frame = size_t(std::floor(d.fit_lifetime ? t * sheet.frames.size() : age * d.animation_rate));
        p.uv = sheet.frames[sheet.clamp ? std::min(sheet.frames.size() - 1, frame) : frame % sheet.frames.size()];
    }
    p.trail = d.trail.sample(random, 21);
}

inline std::optional<Sample> sample(const Definition &d, uint32_t index, double age, uint32_t seed, Point angles = {}) {
    if (age < 0) return std::nullopt;
    const Random random{seed ^ ((index + 1) * 0x9e3779b9u)};
    const auto life = d.life.sample(random, 0);
    if (age >= life || life <= 0) return std::nullopt;
    Sample p;
    motion(d, random, age, angles, p);
    appearance(d, random, age, age / life, p);
    return p;
}
}  // namespace native_crash
