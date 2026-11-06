#pragma once
#include "bunnyhop_native.h"
#include "render_math.hpp"
#include "semantic_palette.hpp"
#include "nlohmann/json.hpp"
#include <span>
#include <cstdlib>

namespace native_render {
inline constexpr float landing_radius = 14, landing_height = 9;
inline constexpr size_t landing_segments = 48, landing_rings = 6, landing_dots = 96;
inline constexpr double landing_ground_hold = .080;

struct LandingVertex {
    Vec3 position;
    float alpha;
};

inline LandingVertex landing_vertex(size_t ring, size_t segment) {
    constexpr double pi = 3.141592653589793;
    const double phi = double(ring) / landing_rings * pi / 2;
    const double theta = double(segment) / landing_segments * pi * 2;
    const double radius = landing_radius * std::cos(phi);
    return {{float(radius * std::cos(theta)), float(radius * std::sin(theta)), float(landing_height * std::sin(phi))},
            float(.42 + (.08 - .42) * std::sin(phi))};
}

inline float landing_scale(float distance, float pixels_per_unit) {
    const float pixels = 2 * landing_radius * pixels_per_unit / std::max(1.f, distance);
    return pixels >= 14 ? 1 : 14 / pixels;
}

inline Vec3 landing_point(Vec3 point, const BhLandingPrediction &result, float scale) {
    // Quaternion from +Z to the surface normal, matching setFromUnitVectors in landing/marker.ts.
    const bool flat = result.kind == 2 || !(result.normal[2] > .01f);
    Vec3 out = point;
    if (!flat) {
        const auto &n = result.normal;
        const float length = std::hypot(n[0], n[1], n[2]);
        const Vec3 axis{-n[1] / length, n[0] / length, 0};
        const float cosine = n[2] / length, k = 1 / (1 + cosine);
        const Vec3 cross{axis[1] * point[2], -axis[0] * point[2], axis[0] * point[1] - axis[1] * point[0]};
        const Vec3 twice{axis[1] * cross[2], -axis[0] * cross[2], axis[0] * cross[1] - axis[1] * cross[0]};
        for (int i = 0; i < 3; i++)
            out[i] += cross[i] + twice[i] * k;
    }
    for (int i = 0; i < 3; i++)
        out[i] = out[i] * scale + result.position[i];
    if (!flat) out[2] -= 16 * (std::abs(result.normal[0]) + std::abs(result.normal[1])) / result.normal[2];
    return out;
}

inline size_t landing_arc(std::span<const BhLandingPiece> pieces, std::span<Vec3> out) {
    constexpr double spacing = 24, skip = 64;
    double travelled = 0, next = skip;
    size_t count = 0;
    for (const auto &piece : pieces) {
        const double seconds = piece.seconds;
        const auto &v = piece.velocity, &a = piece.acceleration, &p = piece.start;
        const double speed = std::hypot(v[0], v[1], v[2]) + std::hypot(a[0], a[1], a[2]) * seconds;
        const int steps = std::clamp(int(std::ceil(speed * seconds / (spacing / 4))), 1, 256);
        std::array<double, 3> last{p[0], p[1], p[2]};
        for (int step = 1; step <= steps && count < out.size(); step++) {
            const double t = step * seconds / steps;
            std::array<double, 3> point;
            for (int i = 0; i < 3; i++)
                point[i] = p[i] + v[i] * t + .5 * a[i] * t * t;
            travelled += std::hypot(point[0] - last[0], point[1] - last[1], point[2] - last[2]);
            last = point;
            if (travelled >= next) {
                for (int i = 0; i < 3; i++)
                    out[count][i] = float(point[i]);
                count++;
                next += spacing;
            }
        }
    }
    return count;
}

struct LandingMarker {
    enum class Mode { off, practice, always };
    Mode mode = Mode::off;
    bool path = false, visible = false;
    native::SemanticColor color = native::semantic_rgb(0x4de1ff);
    BhLandingPrediction result{};
    std::array<BhLandingPiece, 64> pieces{};
    double air_at = -INFINITY;

    void settings(const nlohmann::json &settings) {
        const auto raw = settings.value("landing", nlohmann::json::object());
        const auto name = raw.value("mode", std::string("off"));
        mode = name == "always" ? Mode::always : name == "practice" ? Mode::practice : Mode::off;
        path = raw.value("arc", false);
        const auto hex = raw.value("color", std::string("#4de1ff"));
        if (hex.size() == 7 && hex.front() == '#') {
            char *end = nullptr;
            const auto rgb = std::strtoul(hex.c_str() + 1, &end, 16);
            if (end == hex.c_str() + 7) color = native::semantic_rgb(uint32_t(rgb));
        }
    }

    bool enabled(bool practicing, bool replay) const {
        return mode == Mode::always || (mode == Mode::practice && (practicing || replay));
    }

    bool frame(BhContext *core, const BhState &state, bool suppressed, bool practicing, bool replay, double now) {
        if (!enabled(practicing, replay) || suppressed || state.on_ladder) return visible = false;
        if (state.grounded) {
            if (now < air_at || now - air_at > landing_ground_hold) visible = false;
            return visible;
        }
        air_at = now;
        visible = bh_predict_landing(
                          core, state.position, state.velocity, state.crouched, 4, &result, pieces.data(), pieces.size()
                  )
                  && (result.kind == 1 || result.kind == 2);
        return visible;
    }
};
}  // namespace native_render
