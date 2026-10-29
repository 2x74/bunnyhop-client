#pragma once
#include <algorithm>
#include <cstdint>
#include <vector>

namespace native_render {

struct SceneDraw {
    uint32_t material, first, count;
    bool prop;
    int32_t entity;
    uint32_t model;
    float distance = 0;
    size_t order = 0;
};

// Scene lists keep their allocation across frames. Order breaks distance ties exactly like stable_sort,
// without its temporary allocation. Opaque submissions still use the original material order.
class SceneDrawList {
public:
    std::vector<SceneDraw> draws;

    void begin(size_t capacity) {
        draws.clear();
        draws.reserve(capacity);
    }

    void add(SceneDraw draw) {
        draw.order = draws.size();
        draws.push_back(draw);
    }

    void back_to_front() {
        std::sort(draws.begin(), draws.end(), [](const SceneDraw &a, const SceneDraw &b) {
            if (a.distance != b.distance) return a.distance > b.distance;
            return a.order < b.order;
        });
    }
};

}  // namespace native_render
