#pragma once
#include <algorithm>
#include <array>
#include <cmath>

namespace native {
struct SpatialMix {
    float gain = 0, pan = 0;
};

inline SpatialMix spatial_mix(const float source[3], const float listener[3], double yaw) {
    const double dx = source[0] - listener[0], dy = source[1] - listener[1], dz = source[2] - listener[2],
                 distance = std::hypot(std::hypot(dx, dy), dz);
    if (!std::isfinite(distance) || !std::isfinite(yaw) || distance > 1600) return {};
    const double rad = yaw * 3.141592653589793 / 180, right = dx * std::sin(rad) - dy * std::cos(rad);
    return {float(std::pow(std::clamp(1 - (distance - 80) / 1520, 0., 1.), 2)),
            float(distance > 1 ? std::clamp(right / distance, -1., 1.) : 0)};
}

inline std::array<float, 2> pan_gains(float pan) {
    return {std::sqrt(std::clamp(1 - pan, 0.f, 1.f)), std::sqrt(std::clamp(1 + pan, 0.f, 1.f))};
}
}  // namespace native
