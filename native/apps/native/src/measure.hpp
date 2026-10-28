#pragma once
#include "paint.hpp"
#include <cstdio>

namespace native_render {
struct Measurement {
    float distance = 0, horizontal = 0, height = 0;
};
inline Measurement measure_distance(const Vec3 &a, const Vec3 &b) {
    const float x = b[0] - a[0], y = b[1] - a[1], height = b[2] - a[2];
    return {std::hypot(std::hypot(x, y), height), std::hypot(x, y), height};
}
class Measure {
    struct Point {
        SurfaceOwner owner;
        Vec3 local{};
    };
    std::array<Point, 2> points_{};
    size_t count_ = 0;
    std::array<char, 100> text_{};

  public:
    bool pick(BhContext *core, const SurfaceHit &hit) {
        native::Matrix matrix{};
        if (!hit.owner.matrix(core, matrix)) {
            return false;
        }
        if (count_ == 2) {
            clear();
        }
        points_[count_++] = {hit.owner, surface_local(matrix, hit.point)};
        return true;
    }
    std::optional<std::array<Vec3, 2>> positions(BhContext *core) const {
        std::array<Vec3, 2> result{};
        for (size_t index = 0; index < count_; ++index) {
            native::Matrix matrix{};
            if (!points_[index].owner.matrix(core, matrix)) {
                return std::nullopt;
            }
            result[index] = transform_point(matrix, points_[index].local);
        }
        return result;
    }
    const char *text(BhContext *core) {
        if (count_ != 2) {
            return "Point 1 set. Aim at the other edge and measure again.";
        }
        const auto points = positions(core);
        if (!points) {
            return "Measurement surface is hidden.";
        }
        const auto values = measure_distance((*points)[0], (*points)[1]);
        std::snprintf(text_.data(), text_.size(), "%.2f u, gap %.2f, %+.2f", values.distance, values.horizontal,
                      values.height);
        return text_.data();
    }
    template <class Presentation> void draw(BhContext *core, Presentation &presentation, const float eye[3]) const {
        const auto points = positions(core);
        if (!points) {
            return;
        }
        for (size_t index = 0; index < count_; ++index) {
            const auto &point = (*points)[index];
            const std::array<float, 4> color =
                index == 0 ? std::array<float, 4>{.612f, .925f, .718f, 1} : std::array<float, 4>{.647f, .792f, 1, 1};
            for (int axis = 0; axis < 3; ++axis) {
                auto from = point, to = point;
                from[axis] -= 2;
                to[axis] += 2;
                presentation.ribbon(from, to, .5f, color, eye);
            }
        }
        if (count_ == 2) {
            presentation.ribbon((*points)[0], (*points)[1], .7f, {1, 1, 1, .9f}, eye);
        }
    }
    size_t count() const {
        return count_;
    }
    void clear() {
        count_ = 0;
    }
};
} // namespace native_render
