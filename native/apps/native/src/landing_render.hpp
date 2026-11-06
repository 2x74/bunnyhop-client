#pragma once
#include "landing_marker.hpp"

inline void draw_landing(
        const native_render::LandingMarker &marker,
        NativePresentation &geometry,
        const float eye[3],
        float pixels_per_unit,
        const native_render::Vec3 &right,
        const native_render::Vec3 &up,
        const native::SemanticColor &loss
) {
    using namespace native_render;
    if (!marker.visible) return;
    const auto &result = marker.result;
    const float distance =
            std::hypot(result.position[0] - eye[0], result.position[1] - eye[1], result.position[2] - eye[2]);
    const float scale = landing_scale(distance, pixels_per_unit);
    auto color = result.kind == 2 ? loss : marker.color;
    const auto at = [&](Vec3 point) {
        return landing_point(point, result, scale);
    };
    for (size_t ring = 0; ring < landing_rings; ring++) {
        for (size_t segment = 0; segment < landing_segments; segment++) {
            const std::array<LandingVertex, 4> vertices{
                    landing_vertex(ring, segment),
                    landing_vertex(ring, segment + 1),
                    landing_vertex(ring + 1, segment + 1),
                    landing_vertex(ring + 1, segment)
            };
            const std::array<Vec3, 4> points{
                    at(vertices[0].position),
                    at(vertices[1].position),
                    at(vertices[2].position),
                    at(vertices[3].position)
            };
            const Vec3 a{points[1][0] - points[0][0], points[1][1] - points[0][1], points[1][2] - points[0][2]};
            const Vec3 b{points[3][0] - points[0][0], points[3][1] - points[0][1], points[3][2] - points[0][2]};
            const Vec3 normal{a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
            float facing = 0;
            for (int i = 0; i < 3; i++)
                facing += normal[i] * (eye[i] - points[0][i]);
            if (facing <= 0) continue;
            geometry.quad(
                    points, color, 0, {vertices[0].alpha, vertices[1].alpha, vertices[2].alpha, vertices[3].alpha}
            );
        }
    }
    color[3] = .75f;
    constexpr double pi = 3.141592653589793;
    const float line_half_width = distance / std::max(1.f, pixels_per_unit);
    for (size_t segment = 0; segment < landing_segments; segment++) {
        const double a = double(segment) / landing_segments * 2 * pi;
        const double b = double(segment + 1) / landing_segments * 2 * pi;
        geometry.ribbon(
                at({landing_radius * float(std::cos(a)), landing_radius * float(std::sin(a)), .5f}),
                at({landing_radius * float(std::cos(b)), landing_radius * float(std::sin(b)), .5f}),
                line_half_width,
                color,
                eye
        );
    }
    if (result.kind == 2) {
        constexpr float cross = landing_radius * .55f;
        color[3] = .95f;
        geometry.ribbon(at({-cross, -cross, .6f}), at({cross, cross, .6f}), line_half_width, color, eye);
        geometry.ribbon(at({-cross, cross, .6f}), at({cross, -cross, .6f}), line_half_width, color, eye);
    }
    if (marker.path) {
        std::array<Vec3, landing_dots> dots;
        const auto count = landing_arc(
                std::span(marker.pieces).first(std::min(size_t(result.piece_count), marker.pieces.size())), dots
        );
        color[3] = .55f;
        for (size_t i = 0; i < count; i++)
            geometry.billboard(dots[i], 1.5f, color, right, up, 1);
    }
}
