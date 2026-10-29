#pragma once
// Which water gets the Source look's detailed surface this frame, ported from the website's water-capture.ts.
// Like CS:S's cheap water distance (r_cheapwaterend), the refraction and the reflection only run for water seen from
// above and within capture distance; farther water draws the plain surface. A reflection draws the scene a second
// time, so only the plane nearest the eye in height reflects.
#include "render_math.hpp"
#include <map>
#include <optional>
#include <tuple>
#include <vector>

namespace native_render {
constexpr float water_capture_distance = 1536;
// Keeps capturing a little farther once started, so the surface doesn't switch every frame at the edge.
constexpr float water_capture_margin = 256;
// One material's water spread over a map (canals, a moat) is many cells, so only the part near the view counts.
constexpr float water_cell_size = 1024;
// Triangles flatter than this reflect; the rest refract only.
constexpr float water_flat_normal_z = .99f;
// A reflection plane must be at least this far below the eye.
constexpr float water_reflection_clearance = .1f;
// Surface heights are matched to a tenth of a unit.
constexpr float water_height_steps_per_unit = 10;

struct WaterCell {
    uint32_t material = 0;
    std::optional<float> height;
    Bounds bounds;
};

struct WaterCapturePlan {
    bool refract = false;
    std::optional<float> reflection_height;
};

inline float distance_to_bounds(const Bounds &bounds, const Vec3 &point) {
    float squared = 0;
    for (int k = 0; k < 3; k++) {
        const float outside = std::max({bounds.lo[k] - point[k], 0.f, point[k] - bounds.hi[k]});
        squared += outside * outside;
    }
    return std::sqrt(squared);
}

// Reflects world space through the plane z = height (column-major, like native::Matrix).
inline native::Matrix mirror_matrix(float height) {
    auto mirror = native::identity();
    mirror[10] = -1;
    mirror[14] = 2 * height;
    return mirror;
}

class WaterCellBuilder {
    using Key = std::tuple<uint32_t, bool, long, long, long>;
    std::map<Key, WaterCell> cells_;

public:
    void add_triangle(uint32_t material, const std::array<Vec3, 3> &corners, float normal_z) {
        Vec3 centre{};
        for (const auto &corner : corners)
            for (int k = 0; k < 3; k++)
                centre[k] += corner[k] / 3;
        const bool flat = normal_z > water_flat_normal_z;
        const long height_step = flat ? std::lround(centre[2] * water_height_steps_per_unit) : 0;
        const Key key{
                material,
                flat,
                height_step,
                long(std::floor(centre[0] / water_cell_size)),
                long(std::floor(centre[1] / water_cell_size))
        };
        auto [found, added] = cells_.try_emplace(key);
        WaterCell &cell = found->second;
        if (added) {
            cell.material = material;
            if (flat) cell.height = float(height_step) / water_height_steps_per_unit;
            cell.bounds = {corners[0], corners[0]};
        }
        for (const auto &corner : corners)
            for (int k = 0; k < 3; k++) {
                cell.bounds.lo[k] = std::min(cell.bounds.lo[k], corner[k]);
                cell.bounds.hi[k] = std::max(cell.bounds.hi[k], corner[k]);
            }
    }

    std::vector<WaterCell> cells() const {
        std::vector<WaterCell> out;
        out.reserve(cells_.size());
        for (const auto &[key, cell] : cells_)
            out.push_back(cell);
        return out;
    }
};

class WaterCapturePlanner {
    std::vector<WaterCell> cells_;
    std::vector<uint8_t> ready_;
    bool near_ = false;

    bool captures(const WaterCell &cell, const Vec3 &eye, const native::Matrix &view_projection, float limit) const {
        if (cell.height && eye[2] <= *cell.height) return false;
        if (distance_to_bounds(cell.bounds, eye) > limit) return false;
        std::array<float, 4> rect;
        return screen_rect(cell.bounds, view_projection, rect);
    }

public:
    void load(std::vector<WaterCell> cells, size_t material_count) {
        cells_ = std::move(cells);
        ready_.assign(material_count, 0);
        near_ = false;
    }

    WaterCapturePlan plan(const Vec3 &eye, const native::Matrix &view_projection) {
        WaterCapturePlan out;
        std::fill(ready_.begin(), ready_.end(), 0);
        const float limit = water_capture_distance + (near_ ? water_capture_margin : 0);
        for (const auto &cell : cells_) {
            if (!captures(cell, eye, view_projection, limit)) continue;
            out.refract = true;
            if (cell.material < ready_.size()) ready_[cell.material] = 1;
            if (!cell.height || eye[2] <= *cell.height + water_reflection_clearance) continue;
            if (!out.reflection_height || std::abs(eye[2] - *cell.height) < std::abs(eye[2] - *out.reflection_height))
                out.reflection_height = cell.height;
        }
        near_ = out.refract;
        return out;
    }

    void clear() {
        std::fill(ready_.begin(), ready_.end(), 0);
        near_ = false;
    }

    bool ready(uint32_t material) const { return material < ready_.size() && ready_[material]; }
};
}  // namespace native_render
