#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <string_view>

// Sprung hair (Spiky Hair, Long Hair), ported from the website (player/hair-fx.ts advanceHair): two damped springs per
// player in the head's bind frame (x the bunny's left, y back, z up), a loose slow one and a stiff quick one. They feel
// minus the head's acceleration (so hair floats in the air), wind against the motion and a turn of the head. The shader
// bends each lock about its pivot toward a mix of the two by its looseness (uHairSway, uHairFlex).
namespace native_render {

struct HairMotion {
    std::array<double, 3> loose{}, looseVelocity{}, stiff{}, stiffVelocity{}, filteredVelocity{};
    double yawRate = 0, yaw = 0, time = 0;
    bool initialized = false;
};

namespace hair {
struct Spring {
    double hz, zeta;
    std::array<double, 3> coupling;
    double max_bend;
};

// hair-fx.ts HAIR_SPRING.
inline constexpr Spring loose_spring{1.8, .26, {.06, .1, .085}, .95};
inline constexpr Spring stiff_spring{4.2, .22, {.1, .11, .1}, .5};
// Velocity low-pass (s), acceleration saturation (u/s^2), wind at its strongest (u/s^2) and its speed scale (u/s).
inline constexpr double velocity_seconds = .06, saturation = 1400, wind_strength = 760, wind_speed = 650;
inline constexpr double turn_seconds = .05, max_step_seconds = .1, substep_seconds = 1. / 120;
inline constexpr double side_wind_share = .4, turn_force_scale = 9, turn_force_limit = 900;
// The idle sway of the loose spring standing still (amplitude, rate) and the speed it fades over (u/s).
inline constexpr double idle_fade_speed = 120, idle_side = .03, idle_back = .016, idle_side_rate = 1.15,
                        idle_back_rate = .8, idle_back_phase = 1;
// A soft stop: past the limit the bend keeps this much of its speed.
inline constexpr double stop_keep = .4;
inline constexpr double pi = 3.141592653589793;
inline constexpr double clock_wrap = pi * 200;

inline double finite(double v) {
    return std::isfinite(v) ? v : 0;
}

inline void step_spring(
        std::array<double, 3> &bend,
        std::array<double, 3> &velocity,
        const Spring &spring,
        const std::array<double, 3> &force,
        const std::array<double, 3> &target,
        double dt,
        int substeps
) {
    const double omega = 2 * pi * spring.hz, stiffness = omega * omega, damping = 2 * spring.zeta * omega;
    for (int i = 0; i < substeps; i++) {
        for (size_t j = 0; j < 3; j++) {
            velocity[j] +=
                    (spring.coupling[j] * force[j] - stiffness * (bend[j] - target[j]) - damping * velocity[j]) * dt;
            bend[j] += velocity[j] * dt;
        }
        const double size = std::hypot(std::hypot(bend[0], bend[1]), bend[2]);
        if (size > spring.max_bend) {
            const double r = spring.max_bend / size;
            for (size_t j = 0; j < 3; j++) {
                bend[j] *= r;
                velocity[j] *= stop_keep;
            }
        }
    }
}
}  // namespace hair

// Steps both springs. `velocity`: the body's (Source axes, u/s); `yaw_degrees`: the view yaw; `snap`: restart at rest.
inline void advance_hair(HairMotion &s, const float velocity[3], double yaw_degrees, double dt, bool snap) {
    using namespace hair;
    const double h = std::clamp(finite(dt), 0., max_step_seconds);
    const std::array<double, 3> v = {finite(velocity[0]), finite(velocity[1]), finite(velocity[2])};
    const double yaw = finite(yaw_degrees) * pi / 180;
    if (snap || !s.initialized) {
        s = {};
        s.filteredVelocity = v;
        s.yaw = yaw;
        s.initialized = true;
        return;
    }
    if (h <= 0) return;
    const double k = 1 - std::exp(-h / velocity_seconds);
    std::array<double, 3> a{};
    for (size_t i = 0; i < 3; i++) {
        a[i] = (v[i] - s.filteredVelocity[i]) * k / h;
        s.filteredVelocity[i] += (v[i] - s.filteredVelocity[i]) * k;
    }
    const auto saturate = [](double x) {
        return saturation * std::tanh(x / saturation);
    };
    const double turn = std::atan2(std::sin(yaw - s.yaw), std::cos(yaw - s.yaw));
    s.yaw = yaw;
    const double kr = 1 - std::exp(-h / turn_seconds), rate = turn / h;
    const double yaw_acceleration = (rate - s.yawRate) * kr / h;
    s.yawRate += (rate - s.yawRate) * kr;
    // World (yaw 0 = +x forward) into the head's frame: x = left, y = back.
    const double cy = std::cos(yaw), sy = std::sin(yaw);
    const auto to_head = [&](double x, double y) {
        return std::array<double, 2>{-sy * x + cy * y, -(cy * x + sy * y)};
    };
    const auto ah = to_head(a[0], a[1]), vh = to_head(v[0], v[1]);
    const double speed = std::hypot(v[0], v[1]);
    const double wind = wind_strength * (1 - std::exp(-speed / wind_speed));
    const bool moving = speed > 1;
    const std::array<double, 3> force = {
            -saturate(ah[0]) - (moving ? vh[0] / speed * wind * side_wind_share : 0)
                    + std::clamp(yaw_acceleration * turn_force_scale, -turn_force_limit, turn_force_limit),
            -saturate(ah[1]) - (moving ? vh[1] / speed * wind : 0),
            -saturate(a[2])
    };
    s.time = std::fmod(s.time + h, clock_wrap);
    const double idle = std::exp(-speed / idle_fade_speed);
    const std::array<double, 3> rest = {
            idle_side * idle * std::sin(s.time * idle_side_rate),
            idle_back * idle * std::sin(s.time * idle_back_rate + idle_back_phase),
            0
    };
    const int substeps = std::max(1, int(std::ceil(h / substep_seconds)));
    step_spring(s.loose, s.looseVelocity, loose_spring, force, rest, h / substeps, substeps);
    step_spring(s.stiff, s.stiffVelocity, stiff_spring, force, {}, h / substeps, substeps);
}

// The length a sprung style draws for a saved length percent (hair-fx.ts lengthFactor): `min` at 40, 1 at 100, `max`
// at 300. Styles without a range draw the percent over 100.
inline double hair_length_factor(double percent, double min, double max, bool ranged) {
    const double p = std::isfinite(percent) ? std::clamp(percent, 40., 300.) : 100;
    if (!ranged) return p / 100;
    return p <= 100 ? min + (1 - min) * (p - 40) / 60 : 1 + (max - 1) * (p - 100) / 200;
}

// The hat's own option in a packed loadout (loadout.ts unpackHead, the 16th field): two characters of 12 bits for a
// wig's highlight colour, or "f" for a mask worn over the face.
struct HeadOption {
    bool mask_on = false;
    bool has_highlight = false;
    unsigned highlight = 0;
};

inline int head_digit(char c) {
    constexpr std::string_view alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
    const auto at = alphabet.find(c);
    return at == std::string_view::npos ? -1 : int(at);
}

inline HeadOption unpack_head(std::string_view field) {
    HeadOption out;
    if (field == "f") {
        out.mask_on = true;
        return out;
    }
    if (field.size() != 2) return out;
    const int high = head_digit(field[0]), low = head_digit(field[1]);
    if (high < 0 || low < 0) return out;
    const unsigned n = unsigned(high * 64 + low);
    constexpr unsigned nibble_to_byte = 17;
    out.highlight =
            ((n >> 8) & 15) * nibble_to_byte << 16 | ((n >> 4) & 15) * nibble_to_byte << 8 | (n & 15) * nibble_to_byte;
    out.has_highlight = true;
    return out;
}

}  // namespace native_render
