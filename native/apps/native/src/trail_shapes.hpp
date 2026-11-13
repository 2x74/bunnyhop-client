#pragma once
#include "render_math.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
#include <span>
#include <string_view>
#include <vector>

namespace native_render {

// Trail shapes (website player/trail.ts, v0.0.41; the Loadout's Trail shape, "shape-*"): the colour and the shape are
// separate picks. The ribbon is the trail as it always was (GhostTrails and NativePresentation::ribbon draw it);
// the others are built here, in Source space, as camera-facing quads:
//   comet   a wide head that narrows at once into a long hairline
//   twin    two thin rails
//   dashes  the ribbon cut into dashes that stay where they were laid
//   seeds   small seeds scattered off the path, spreading and falling as they age
//   petals  petals shed to either side, tumbling down
//   clover  a thin stem strung with four-leaf clovers
// Everything but the comet is laid per path sample, so it stays put in the world while the bunny moves on (`phase`).

enum class TrailShape { ribbon, comet, twin, dashes, seeds, petals, clover };

inline TrailShape trail_shape_of(std::string_view id) {
    if (id.starts_with("shape-")) id.remove_prefix(6);
    constexpr std::array<std::pair<std::string_view, TrailShape>, 6> shapes = {
            {{"comet", TrailShape::comet},
             {"twin", TrailShape::twin},
             {"dashes", TrailShape::dashes},
             {"seeds", TrailShape::seeds},
             {"petals", TrailShape::petals},
             {"clover", TrailShape::clover}}
    };
    for (const auto &[name, shape] : shapes)
        if (id == name) return shape;
    return TrailShape::ribbon;
}

// A quad as the website draws it: triangles (0, 1, 2) and (1, 3, 2). Corners here are in fan order 0, 1, 3, 2.
struct TrailQuad {
    std::array<Vec3, 4> corners;
    std::array<float, 3> color;
    std::array<float, 4> alpha;
};

// The website's hash: a stable 0..1 from a sample number and a salt, so a mark never changes while it's on screen.
inline float trail_hash(int64_t n, uint32_t salt) {
    uint32_t x = uint32_t(n) ^ (uint32_t(salt + 1) * 0x9e3779b1u);
    x *= 0x85ebca6bu;
    x ^= x >> 13;
    x *= 0xc2b2ae35u;
    x ^= x >> 16;
    return float(double(x) / 4294967296.);
}

class TrailShapes {
public:
    struct Colors {
        std::array<float, 3> head, tail;
    };

    // `points` oldest first (feet, Source space), `eye` the camera, `width` the ribbon's half width at the head,
    // `phase` the sample number of points[0]. Calls `emit(const TrailQuad &)` per quad.
    template <class Emit>
    void
    build(TrailShape shape,
          std::span<const Vec3> points,
          const float eye[3],
          const Colors &colors,
          float opacity,
          float width,
          int64_t phase,
          Emit &&emit) {
        if (points.size() < 2) return;
        frame(shape, points, eye, colors, opacity);
        switch (shape) {
            case TrailShape::ribbon:
                strip(points, width, 0, ribbon_width, ribbon_alpha, std::nullopt, emit);
                break;
            case TrailShape::comet:
                strip(points, width, 0, comet_width, comet_alpha, std::nullopt, emit);
                break;
            case TrailShape::twin:
                strip(points, width, -1, twin_width, twin_alpha, std::nullopt, emit);
                strip(points, width, 1, twin_width, twin_alpha, std::nullopt, emit);
                break;
            case TrailShape::dashes:
                strip(points, width, 0, dash_width, soft_alpha, phase, emit);
                break;
            case TrailShape::seeds:
                seeds(points, width, phase, emit);
                break;
            case TrailShape::petals:
                petals(points, width, phase, emit);
                break;
            case TrailShape::clover:
                strip(points, width, 0, stem_width, soft_alpha, std::nullopt, emit);
                clovers(points, width, phase, emit);
                break;
        }
    }

private:
    // Per point: side and along (both across the line of sight), age fraction (0 tail .. 1 head), alpha and colour.
    struct Frame {
        Vec3 side, along;
        float age, alpha;
        std::array<float, 3> color;
    };

    std::vector<Frame> frames_;

    static float ribbon_width(float f) { return .15f + .85f * f; }

    static float ribbon_alpha(float f) { return f * f; }

    static float comet_width(float f) { return .22f + 2.4f * std::pow(f, 9.f); }

    static float comet_alpha(float f) { return std::min(1.f, .9f * f + .6f * std::pow(f, 8.f)); }

    static float twin_width(float f) { return .36f * (.3f + .7f * f); }

    static float twin_alpha(float f) { return std::pow(f, 1.2f); }

    static float dash_width(float f) { return .9f * (.35f + .65f * f); }

    static float soft_alpha(float f) { return std::pow(f, 1.5f); }

    static float stem_width(float f) { return .3f * (.4f + .6f * f); }

    static bool laid(TrailShape shape) {
        return shape == TrailShape::seeds || shape == TrailShape::petals || shape == TrailShape::clover;
    }

    void
    frame(TrailShape shape, std::span<const Vec3> points, const float eye[3], const Colors &colors, float opacity) {
        const size_t count = points.size();
        frames_.resize(count);
        // Marks start fading farther out than the ribbon: a petal right in front of the eye fills the view.
        const float fade_from = laid(shape) ? 70.f : 40.f, fade_over = laid(shape) ? 260.f : 160.f;
        for (size_t i = 0; i < count; i++) {
            const auto &prev = points[i ? i - 1 : 0];
            const auto &next = points[std::min(count - 1, i + 1)];
            const Vec3 t{next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]};
            const Vec3 v{eye[0] - points[i][0], eye[1] - points[i][1], eye[2] - points[i][2]};
            Vec3 side{t[1] * v[2] - t[2] * v[1], t[2] * v[0] - t[0] * v[2], t[0] * v[1] - t[1] * v[0]};
            const float length = std::hypot(side[0], side[1], side[2]);
            for (auto &value : side)
                value /= length > 0 ? length : 1.f;
            const float distance = std::max(std::hypot(v[0], v[1], v[2]), 1e-6f);
            auto &out = frames_[i];
            out.side = side;
            out.along = {
                    (v[1] * side[2] - v[2] * side[1]) / distance,
                    (v[2] * side[0] - v[0] * side[2]) / distance,
                    (v[0] * side[1] - v[1] * side[0]) / distance
            };
            out.age = float(i) / float(count - 1);
            // Fades near the camera (a trail passing under or through the eye reads as a smear).
            const float near_fade = std::clamp((distance - fade_from) / fade_over, 0.f, 1.f);
            out.alpha = opacity * near_fade * near_fade;
            // Two-tone: the head keeps the main colour for its brightest stretch, then shifts to the tail colour.
            const float m = std::clamp((.92f - out.age) * 2.4f, 0.f, 1.f), s = m * m * (3 - 2 * m);
            for (int k = 0; k < 3; k++)
                out.color[k] = colors.head[k] + (colors.tail[k] - colors.head[k]) * s;
        }
    }

    // A ribbon along the path, `offset` widths to the side, its half width and alpha by age. With `dash` (the sample
    // number of point 0) only three samples in every six are drawn.
    template <class Emit>
    void
    strip(std::span<const Vec3> points,
          float width,
          float offset,
          float (*width_of)(float),
          float (*alpha_of)(float),
          std::optional<int64_t> dash,
          Emit &emit) const {
        constexpr int64_t dash_cycle = 6, dash_on = 3;
        for (size_t i = 0; i + 1 < points.size(); i++) {
            if (dash && (((*dash + int64_t(i)) % dash_cycle) + dash_cycle) % dash_cycle >= dash_on) continue;
            TrailQuad quad{};
            for (int end = 0; end < 2; end++) {
                const size_t j = i + size_t(end);
                const auto &f = frames_[j];
                const float shift = offset * width, half = width_of(f.age) * width;
                for (int side = 0; side < 2; side++) {
                    const float sign = side ? -1.f : 1.f;
                    // Web vertex order (+i, -i, +i+1, -i+1) as a fan: 0, 1, 3, 2.
                    const int corner = end ? (side ? 2 : 3) : side;
                    for (int k = 0; k < 3; k++)
                        quad.corners[corner][k] = points[j][k] + f.side[k] * (shift + sign * half);
                    quad.alpha[corner] = f.alpha * alpha_of(f.age);
                }
            }
            quad.color = frames_[i + 1].color;
            emit(quad);
        }
    }

    // How many marks the stretch from fixed sample i to the next carries, `spacing` units apart on average (at most
    // `cap`): by distance, so a trail is as full at 300 u/s as at 3,000, and from the sample's number alone.
    static int marks_on(std::span<const Vec3> points, size_t i, int64_t sample, float spacing, int cap) {
        const auto &a = points[i], &b = points[i + 1];
        const float length = std::hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        return std::min(cap, int(std::floor(length / spacing + trail_hash(sample, 0))));
    }

    struct Mark {
        float along_path, across, forward, drop, turn, length, breadth, tint, alpha;
    };

    // A mark facing the camera `along_path` of the way from point i to the next, moved across / forward and `drop`
    // units down, its outline (u along its length, v across) turned by `turn`. Outlines are quads of four corners.
    template <class Emit>
    void mark(std::span<const Vec3> points, size_t i, const Mark &m, std::span<const float> outline, Emit &emit) const {
        const auto &f = frames_[i];
        const auto &a = points[i], &b = points[i + 1];
        Vec3 centre{};
        for (int k = 0; k < 3; k++)
            centre[k] = a[k] + (b[k] - a[k]) * m.along_path + f.side[k] * m.across + f.along[k] * m.forward;
        centre[2] -= m.drop;
        const float c = std::cos(m.turn), s = std::sin(m.turn);
        Vec3 length_axis{}, width_axis{};
        for (int k = 0; k < 3; k++) {
            length_axis[k] = (f.along[k] * c + f.side[k] * s) * m.length;
            width_axis[k] = (f.side[k] * c - f.along[k] * s) * m.breadth;
        }
        TrailQuad quad{};
        for (int k = 0; k < 3; k++)
            quad.color[k] = f.color[k] + (1 - f.color[k]) * m.tint;
        quad.alpha.fill(std::min(1.f, f.alpha * m.alpha));
        constexpr std::array<int, 4> fan = {0, 1, 3, 2};
        for (size_t first = 0; first + 8 <= outline.size(); first += 8) {
            for (int corner = 0; corner < 4; corner++) {
                const float u = outline[first + size_t(corner) * 2], v = outline[first + size_t(corner) * 2 + 1];
                for (int k = 0; k < 3; k++)
                    quad.corners[size_t(fan[size_t(corner)])][k] = centre[k] + length_axis[k] * u + width_axis[k] * v;
            }
            emit(quad);
        }
    }

    template <class Emit>
    void seeds(std::span<const Vec3> points, float width, int64_t phase, Emit &emit) const {
        constexpr std::array<float, 8> kite = {-.5f, 0, 0, -1, 0, 1, .5f, 0};
        const size_t count = points.size();
        for (size_t i = count - 2; i-- > 0;) {
            const float f = frames_[i].age, age = 1 - f;
            const float grow = std::min(1.f, float(count - 2 - i) / 2);
            const int marks = marks_on(points, i, phase + int64_t(i), width * 2.6f, 4);
            for (int s = 0; s < marks; s++) {
                const int64_t j = (phase + int64_t(i)) * 4 + s;
                const float h1 = trail_hash(j, 1), h2 = trail_hash(j, 2), h3 = trail_hash(j, 3), h4 = trail_hash(j, 4);
                const float size = width * (1.5f + h3) * grow * (.55f + .45f * f);
                const Mark m{
                        (float(s) + h2) / float(marks),
                        (h1 * 2 - 1) * width * (.8f + 4.5f * age),
                        0,
                        width * 4 * age * age * (.4f + h3),
                        h4 * 6.283f + age * (h1 - .5f) * 9,
                        size,
                        size * .3f,
                        .3f * h2,
                        1.4f * std::pow(f, .9f) * (.65f + .35f * h4)
                };
                mark(points, i, m, kite, emit);
            }
        }
    }

    template <class Emit>
    void petals(std::span<const Vec3> points, float width, int64_t phase, Emit &emit) const {
        constexpr std::array<float, 16> petal = {
                -.5f, 0, .05f, -.9f, .05f, .9f, .38f, -.62f, .38f, -.62f, .5f, -.08f, .05f, .9f, .38f, .62f
        };
        const size_t count = points.size();
        for (size_t i = count - 2; i-- > 0;) {
            const float f = frames_[i].age, age = 1 - f;
            const float grow = std::min(1.f, float(count - 2 - i) / 3);
            const int marks = marks_on(points, i, phase + int64_t(i), width * 4, 2);
            for (int s = 0; s < marks; s++) {
                const int64_t j = (phase + int64_t(i)) * 4 + s;
                const float h1 = trail_hash(j, 11), h2 = trail_hash(j, 12), h3 = trail_hash(j, 13);
                const float h4 = trail_hash(j, 14);
                const float length = width * (2.7f + 1.5f * h4) * grow;
                // The tumble: the petal turns about its length, so its width opens and closes.
                const float open = .25f + .75f * std::abs(std::cos(h2 * 6.283f + age * (5 + 7 * h3)));
                const Mark m{
                        (float(s) + h2) / float(marks),
                        (h1 < .5f ? -1.f : 1.f) * width * (.6f + 5 * age * (.35f + .65f * h2)),
                        0,
                        width * 7 * std::pow(age, 1.5f) * (.35f + .65f * h3),
                        h1 * 6.283f + age * (h4 - .5f) * 7,
                        length,
                        length * .3f * open,
                        .45f * h3,
                        1.4f * std::min(1.f, f * 2.2f)
                };
                mark(points, i, m, petal, emit);
            }
        }
    }

    template <class Emit>
    void clovers(std::span<const Vec3> points, float width, int64_t phase, Emit &emit) const {
        constexpr std::array<float, 16> leaf = {
                0, 0, .6f, -.48f, .8f, 0, .98f, -.36f, 0, 0, .8f, 0, .6f, .48f, .98f, .36f
        };
        constexpr float quarter_turn = 1.5708f;
        const size_t count = points.size();
        for (size_t i = count - 2; i-- > 0;) {
            const int64_t sample = phase + int64_t(i);
            const auto &a = points[i], &b = points[i + 1];
            const float length = std::hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
            const auto every = std::max<int64_t>(2, std::llround(width * 22 / std::max(length, 1e-3f)));
            if (((sample % every) + every) % every) continue;
            const float f = frames_[i].age;
            const float grow = std::min(1.f, float(count - 2 - i) / 3);
            const float size = width * 2.9f * grow * (.6f + .4f * f);
            const float turn = trail_hash(sample, 21) * 1.571f + (1 - f) * 1.4f;
            for (int part = 0; part < 4; part++) {
                const Mark m{
                        0, 0, 0, 0, turn + float(part) * quarter_turn, size, size, 0, 1.4f * std::min(1.f, f * 2.2f)
                };
                mark(points, i, m, leaf, emit);
            }
        }
    }
};

}  // namespace native_render
