#pragma once
// What a charm rests against (web viewmodel/charms/anchors.ts measure): the knife's own surface and a living hilt's
// pieces, and the hand at rest, as points over their triangles in the knife's frame. The website samples the same
// meshes the client draws, so the client samples its own copies rather than shipping a few hundred thousand points per
// knife and glove. Where a charm is tied and what it collides with come from the exported fits (export-charms.ts).
#include "charm_rig.hpp"
#include <cstring>
#include <set>
#include <span>

namespace native_charm {

// anchors.ts SAMPLE: the furthest apart two samples of a triangle may be (under the cord's width).
constexpr double sample_spacing = .07;
constexpr int most_samples_per_edge = 24;

// anchors.ts sampleTri: points over a triangle (its corners included), no further apart than the spacing.
inline void sample_triangle(const std::array<double, 9> &p, std::vector<float> &out) {
    const auto edge = [&](size_t a, size_t b) {
        return chain_detail::length(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]);
    };
    const double longest = std::max({edge(0, 3), edge(3, 6), edge(6, 0)});
    const int k = std::max(1, std::min(most_samples_per_edge, int(std::ceil(longest / sample_spacing))));
    for (int i = 0; i <= k; i++)
        for (int j = 0; j <= k - i; j++) {
            const double a = double(i) / k, b = double(j) / k, c = 1 - a - b;
            for (size_t axis = 0; axis < 3; axis++)
                out.push_back(float(p[axis] * a + p[3 + axis] * b + p[6 + axis] * c));
        }
}

// An exported mesh as the client keeps it: interleaved vertices and the triangles' indices.
struct MeshView {
    std::span<const float> vertices;
    size_t stride = 26;
    std::vector<uint32_t> indices;

    size_t triangles() const { return indices.size() / 3; }

    const float *vertex(size_t triangle, size_t corner) const {
        return vertices.data() + size_t(indices[triangle * 3 + corner]) * stride;
    }
};

// The viewmodel's vertex layout (export-viewmodels.ts STRIDE): position at 0, skin bones at 9, their weights at 13.
constexpr size_t skin_index_at = 9, skin_weight_at = 13;

inline V3 apply(const Matrix34 &m, const float *p) {
    return {m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
            m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
            m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]};
}

// The knife's points in its own frame, split by bone: on the knife's main bone (`solid`) and on its moving parts
// (`moving`: a balisong's other handle, a spinner), which rest with the hand. `to_local`: bind space to the knife's
// frame.
inline void knife_points(
        const MeshView &knife,
        const Matrix34 &to_local,
        int knife_bone,
        std::vector<float> &solid,
        std::vector<float> &moving
) {
    for (size_t t = 0; t < knife.triangles(); t++) {
        std::array<double, 9> corners{};
        for (size_t c = 0; c < 3; c++) {
            const auto p = apply(to_local, knife.vertex(t, c));
            std::copy(p.begin(), p.end(), corners.begin() + long(c * 3));
        }
        const int bone = int(knife.vertex(t, 0)[skin_index_at]);
        sample_triangle(corners, bone == knife_bone ? solid : moving);
    }
}

// A living hilt's pieces (their triangles in bind space, three corners each) in the knife's frame.
inline void hilt_points(std::span<const float> corners, const Matrix34 &to_local, std::vector<float> &out) {
    for (size_t t = 0; t + 8 < corners.size(); t += 9) {
        std::array<double, 9> p{};
        for (size_t c = 0; c < 3; c++) {
            const auto local = apply(to_local, corners.data() + t + c * 3);
            std::copy(local.begin(), local.end(), p.begin() + long(c * 3));
        }
        sample_triangle(p, out);
    }
}

// anchors.ts skinned: the hands and sleeves at rest in the knife's frame, within reach of a charm. `skins`: each bone's
// skinning matrix at rest (3x4), `knife_inverse` the knife bone's rest pose inverted, `knife_bones` the bones the knife
// itself rides on (its triangles are skipped).
inline std::vector<float> hand_points(
        const MeshView &hands,
        std::span<const float> skins,
        const Matrix34 &knife_inverse,
        const std::set<int> &knife_bones
) {
    constexpr double reach = 7, lowest = -9, highest = 7;
    std::vector<float> sampled, kept;
    std::vector<std::optional<Matrix34>> mats(skins.size() / 12);
    const auto mat = [&](int bone) -> const Matrix34 & {
        auto &m = mats[size_t(bone)];
        if (!m) m = rig_detail::concat(knife_inverse.data(), skins.data() + size_t(bone) * 12);
        return *m;
    };
    for (size_t t = 0; t < hands.triangles(); t++) {
        if (knife_bones.count(int(hands.vertex(t, 0)[skin_index_at]))) continue;
        std::array<double, 9> corners{};
        for (size_t c = 0; c < 3; c++) {
            const float *v = hands.vertex(t, c);
            for (size_t w = 0; w < 4; w++) {
                const double weight = v[skin_weight_at + w];
                if (weight <= 0) continue;
                const auto p = apply(mat(int(v[skin_index_at + w])), v);
                for (size_t axis = 0; axis < 3; axis++)
                    corners[c * 3 + axis] += weight * p[axis];
            }
        }
        sample_triangle(corners, sampled);
    }
    for (size_t i = 0; i + 2 < sampled.size(); i += 3)
        if (std::hypot(sampled[i], sampled[i + 1]) < reach && sampled[i + 2] > lowest && sampled[i + 2] < highest)
            kept.insert(kept.end(), sampled.begin() + long(i), sampled.begin() + long(i + 3));
    return kept;
}

}  // namespace native_charm
