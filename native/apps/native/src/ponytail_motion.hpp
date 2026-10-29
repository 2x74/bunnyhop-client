#pragma once
#include <algorithm>
#include <array>
#include <cmath>

// The Ponytail's secondary motion, ported from the website (player/hat-fx.ts advancePonytail): a damped pendulum per
// player, two angles about the tie (pitch: + lifts the tail up and back; side: + swings the tip toward the bunny's
// right). It is driven by the body's acceleration in the head's frame (so the tail floats in the air and is jerked down
// on takeoff), wind against the horizontal velocity, and the head's turn. The shader bends the tail by these
// (uPonytail).
namespace native_render {

struct PonytailMotion {
    double pitch = 0, pitchVelocity = 0, side = 0, sideVelocity = 0;
    std::array<double, 3> filteredVelocity{};
    double yawRate = 0, yaw = 0, time = 0;
    bool initialized = false;
};

struct PonytailLimits {
    double pitchLow = 0, pitchHigh = 0, side = 0;
};

namespace ponytail {
// Natural frequency (Hz), damping ratio, lever length (units), coupling to the body's acceleration up and to the side.
inline constexpr double frequency_hz = 1.7, damping = .24, lever_units = 6, up_coupling = .3, side_coupling = .14;
// Velocity low-pass (s), acceleration saturation (u/s^2), strongest wind (u/s^2) and its speed scale (u/s).
inline constexpr double velocity_seconds = .06, saturation = 1400, wind_strength = 800, wind_speed = 650;
inline constexpr double turn_seconds = .05, max_step_seconds = .1, substep_seconds = 1. / 120;
inline constexpr double pitch_low = -.3, pitch_high = .95, side_limit = .6;
inline constexpr double pi = 3.141592653589793;

inline double clamped_length(double length) {
    return std::clamp(std::isfinite(length) ? length : 1., .3, 2.5);
}
}  // namespace ponytail

// Angle limits for a tail `length` times the built one: a long tail drops and swings less, a short one is perkier.
inline PonytailLimits ponytail_limits(double length) {
    const double l = ponytail::clamped_length(length);
    return {std::max(-.45, ponytail::pitch_low / std::pow(l, 1.5)),
            ponytail::pitch_high - .4 * std::clamp(l - 1, 0., 1.),
            std::min(.75, ponytail::side_limit / std::sqrt(l))};
}

inline void reset_ponytail(PonytailMotion &s, const std::array<double, 3> &velocity, double yaw) {
    s.pitch = s.pitchVelocity = s.side = s.sideVelocity = 0;
    s.filteredVelocity = velocity;
    s.yaw = yaw;
    s.yawRate = 0;
    s.time = 0;
    s.initialized = true;
}

// The force on the tail's tip relative to the head, as pitch and side drives.
inline std::array<double, 2> ponytail_drive(PonytailMotion &s, const std::array<double, 3> &v, double yaw, double h) {
    using namespace ponytail;
    const double k = 1 - std::exp(-h / velocity_seconds);
    std::array<double, 3> acceleration{};
    for (size_t i = 0; i < 3; ++i) {
        acceleration[i] = (v[i] - s.filteredVelocity[i]) * k / h;
        s.filteredVelocity[i] += (v[i] - s.filteredVelocity[i]) * k;
    }
    const auto limit = [](double x) {
        return saturation * std::tanh(x / saturation);
    };
    double turn = yaw - s.yaw;
    turn = std::atan2(std::sin(turn), std::cos(turn));
    s.yaw = yaw;
    const double rate = turn / h, smoothing = 1 - std::exp(-h / turn_seconds);
    const double turnAcceleration = (rate - s.yawRate) * smoothing / h;
    s.yawRate += (rate - s.yawRate) * smoothing;
    const double cy = std::cos(yaw), sy = std::sin(yaw);
    const auto toHead = [&](double x, double y) {
        return std::array<double, 2>{-sy * x + cy * y, -(cy * x + sy * y)};
    };
    const auto headAcceleration = toHead(acceleration[0], acceleration[1]);
    const double speed = std::hypot(v[0], v[1]);
    const auto headVelocity = toHead(v[0], v[1]);
    const double wind = wind_strength * (1 - std::exp(-speed / wind_speed));
    const double fx = -limit(headAcceleration[0]) - (speed > 1 ? headVelocity[0] / speed * wind * .35 : 0);
    const double fy = -limit(headAcceleration[1]) - (speed > 1 ? headVelocity[1] / speed * wind : 0);
    const double fz = -limit(std::isfinite(acceleration[2]) ? acceleration[2] : 0);
    return {up_coupling * (.75 * fy + .67 * fz) / lever_units,
            side_coupling * -fx / lever_units - .005 * turnAcceleration};
}

inline void advance_ponytail(
        PonytailMotion &s, const float velocity[3], float yawDegrees, double dt, bool snap, double length = 1
) {
    using namespace ponytail;
    const double h = std::clamp(std::isfinite(dt) ? dt : 0., 0., max_step_seconds);
    std::array<double, 3> v{};
    for (size_t k = 0; k < 3; ++k)
        v[k] = std::isfinite(velocity[k]) ? velocity[k] : 0;
    const double yaw = (std::isfinite(yawDegrees) ? yawDegrees : 0) * pi / 180;
    if (snap || !s.initialized) {
        reset_ponytail(s, v, yaw);
        return;
    }
    if (h <= 0) return;
    const auto [pitchDrive, sideDrive] = ponytail_drive(s, v, yaw, h);
    s.time = std::fmod(s.time + h, pi * 200);
    const double idle = std::exp(-std::hypot(v[0], v[1]) / 120);
    const auto limits = ponytail_limits(length);
    const double w0 = 2 * pi * frequency_hz / std::sqrt(clamped_length(length)), spring = w0 * w0,
                 friction = 2 * damping * w0;
    const double pitchRest = .035 * idle * std::sin(s.time * 1.7), sideRest = .06 * idle * std::sin(s.time * 1.1);
    const int substeps = std::max(1, int(std::ceil(h / substep_seconds)));
    const double step = h / substeps;
    for (int i = 0; i < substeps; ++i) {
        s.pitchVelocity += (pitchDrive - spring * (s.pitch - pitchRest) - friction * s.pitchVelocity) * step;
        s.sideVelocity += (sideDrive - spring * (s.side - sideRest) - friction * s.sideVelocity) * step;
        s.pitch += s.pitchVelocity * step;
        s.side += s.sideVelocity * step;
        if (s.pitch < limits.pitchLow) {
            s.pitch = limits.pitchLow;
            s.pitchVelocity = std::max(0., s.pitchVelocity) * .3;
        }
        if (s.pitch > limits.pitchHigh) {
            s.pitch = limits.pitchHigh;
            s.pitchVelocity = std::min(0., s.pitchVelocity) * .3;
        }
        if (std::abs(s.side) > limits.side) {
            s.side = std::copysign(limits.side, s.side);
            s.sideVelocity *= -.2;
        }
    }
}

}  // namespace native_render
