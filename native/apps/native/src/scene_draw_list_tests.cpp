#include "scene_draw_list.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <random>

int main() {
    native_render::SceneDrawList list;
    constexpr size_t groups = 1024;
    list.begin(groups);
    std::mt19937 random(42);
    for (size_t index = 0; index < groups; ++index)
        list.add({uint32_t(index), 0, 3, false, -1, 0, float(random() % 16)});
    auto reference = list.draws;
    std::stable_sort(reference.begin(), reference.end(), [](const auto &a, const auto &b) {
        return a.distance > b.distance;
    });
    const auto *storage = list.draws.data();
    list.back_to_front();
    assert(list.draws.data() == storage);
    for (size_t index = 0; index < groups; ++index)
        assert(list.draws[index].material == reference[index].material);
    for (unsigned frame = 0; frame < 100; ++frame) {
        list.begin(groups);
        assert(list.draws.empty() && list.draws.data() == storage);
        for (size_t index = 0; index < groups; ++index)
            list.add({uint32_t(index), 0, 3, false, -1, 0, float(index % 16)});
        for (size_t index = 0; index < groups; ++index)
            assert(list.draws[index].material == index);
        list.back_to_front();
        assert(list.draws.data() == storage);
    }
}
