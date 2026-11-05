#pragma once
#include "bunnyhop_native.h"
#include <array>
#include <cmath>

namespace native {
using Matrix = std::array<float, 16>;
constexpr double radians = 3.14159265358979323846 / 180.0;
constexpr float camera_near_plane = 2.0f, camera_far_plane = 60000.0f;

inline Matrix identity() {
    return {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
}

inline Matrix multiply(const Matrix &a, const Matrix &b) {
    Matrix out{};
    for (int c = 0; c < 4; ++c)
        for (int r = 0; r < 4; ++r)
            for (int k = 0; k < 4; ++k)
                out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return out;
}

inline Matrix model_matrix(const BhTransform &t) {
    const float sp = std::sin(t.angles[0] * radians), cp = std::cos(t.angles[0] * radians);
    const float sy = std::sin(t.angles[1] * radians), cy = std::cos(t.angles[1] * radians);
    const float sr = std::sin(t.angles[2] * radians), cr = std::cos(t.angles[2] * radians);
    return {cp * cy,
            cp * sy,
            -sp,
            0,
            sr * sp * cy - cr * sy,
            sr * sp * sy + cr * cy,
            sr * cp,
            0,
            cr * sp * cy + sr * sy,
            cr * sp * sy - sr * cy,
            cr * cp,
            0,
            t.origin[0],
            t.origin[1],
            t.origin[2],
            1};
}

// A model turned by `t`'s angles about a pivot `pivot_height` above its origin instead of the origin itself: the
// third-person bunny banks (rolls) about its hips, so its feet and head swing opposite ways.
inline Matrix model_matrix_about(const BhTransform &t, float pivot_height) {
    auto model = model_matrix(t);
    for (int r = 0; r < 3; r++)
        model[12 + r] -= pivot_height * model[8 + r];
    model[14] += pivot_height;
    return model;
}

// A model-space point through a model matrix (column-major), into world space.
inline std::array<float, 3> transform_point(const Matrix &m, const std::array<float, 3> &p) {
    std::array<float, 3> out{};
    for (int r = 0; r < 3; r++)
        out[size_t(r)] = m[size_t(r)] * p[0] + m[size_t(4 + r)] * p[1] + m[size_t(8 + r)] * p[2] + m[size_t(12 + r)];
    return out;
}

inline Matrix camera_matrix(const float eye[3], double yaw, double pitch, float aspect) {
    const float cy = std::cos(yaw * radians), sy = std::sin(yaw * radians);
    const float cp = std::cos(pitch * radians), sp = std::sin(pitch * radians);
    const float r[3] = {sy, -cy, 0}, u[3] = {sp * cy, sp * sy, cp}, f[3] = {cp * cy, cp * sy, -sp};
    Matrix view = {
            r[0],
            u[0],
            -f[0],
            0,
            r[1],
            u[1],
            -f[1],
            0,
            r[2],
            u[2],
            -f[2],
            0,
            -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]),
            -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]),
            f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2],
            1
    };
    // Source fov_desired=90 at 4:3: fixed vertical FOV, Hor+ on wide windows.
    constexpr float cot = 4.0f / 3.0f, near_plane = camera_near_plane, far_plane = camera_far_plane;
    Matrix projection = {
            cot / aspect,
            0,
            0,
            0,
            0,
            cot,
            0,
            0,
            0,
            0,
            (far_plane + near_plane) / (near_plane - far_plane),
            -1,
            0,
            0,
            2 * far_plane * near_plane / (near_plane - far_plane),
            0
    };
    return multiply(projection, view);
}
}  // namespace native
