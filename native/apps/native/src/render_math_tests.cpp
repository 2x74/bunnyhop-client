#include "render_math.hpp"
#include <cassert>
#include <iostream>

int main() {
    const float eye[3] = {0, 0, 32};
    const auto vp = native::camera_matrix(eye, 0, 0, 16.f / 9);
    std::array<float, 4> rect;
    assert(native_render::screen_rect({{100, -10, 20}, {120, 10, 40}}, vp, rect));
    assert(rect[0] < 0 && rect[2] > 0);
    assert(!native_render::screen_rect({{-120, -10, 20}, {-100, 10, 40}}, vp, rect));
    assert(!native_render::screen_rect({{100, 10000, 20}, {120, 10010, 40}}, vp, rect));
    assert(native_render::screen_rect({{-5, -10, 20}, {20, 10, 40}}, vp, rect));
    assert(rect[0] < -1000 && rect[2] > 1000);  // camera/near-plane crossing must stay conservative
    std::vector<native_render::WaterSurface> surfaces = {
            {{5, 5, 10}, {.2f, .3f, .4f}, {150, 2200}}, {{105, 105, 20}, {.3f, .4f, .5f}, {50, 800}}
    };
    const auto *s = native_render::water_surface({{0, 0, 0}, {10, 10, 10}}, surfaces);
    assert(s == &surfaces[0] && s->range[0] == 150 && s->range[1] == 2200);
    assert(native_render::water_surface({{100, 100, 0}, {110, 110, 20}}, surfaces) == &surfaces[1]);
    assert(native_render::water_surface({{200, 200, 0}, {210, 210, 20}}, surfaces) == &surfaces.front());
    assert(native_render::water_surface({{0, 0, 0}, {1, 1, 1}}, {}) == nullptr);
    assert(native_render::water_face_double_sided(false, true));
    assert(!native_render::water_face_double_sided(true, true));
    assert(!native_render::water_face_double_sided(false, false));
    native_render::EventQueue<int, 3> queue;
    queue.push(1);
    queue.push(2);
    queue.push(3);
    queue.push(4);
    auto events = queue.take();
    assert((events == std::vector<int>{2, 3, 4}));
    assert(queue.size() == 0);
    BhTransform t{};
    t.origin[0] = 100;
    t.angles[1] = 90;
    auto moved = native_render::transformed_bounds({{0, 0, 0}, {10, 20, 30}}, native::model_matrix(t));
    assert(std::abs(moved.lo[0] - 80) < .001 && std::abs(moved.hi[1] - 10) < .001);
    assert(native_render::particle_random(10, 2) == native_render::particle_random(10, 2));
    assert(native_render::particle_random(10, 2) != native_render::particle_random(11, 2));
    auto cube = native_render::convex_triangles(
            {{1, 0, 0, 10}, {-1, 0, 0, 0}, {0, 1, 0, 10}, {0, -1, 0, 0}, {0, 0, 1, 10}, {0, 0, -1, 0}}
    );
    assert(cube.size() == 12);
    for (const auto &triangle : cube)
        for (const auto &p : triangle)
            for (float x : p)
                assert(x >= -.001f && x <= 10.001f);
    const auto shotRight = native_render::shot_basis({10, 20, 30}, {110, 20, 30}, false),
               shotLeft = native_render::shot_basis({10, 20, 30}, {110, 20, 30}, true);
    assert(shotRight.muzzle[1] == 15 && shotLeft.muzzle[1] == 25);
    assert(shotRight.muzzle[2] == 26 && shotLeft.muzzle[2] == 26);
    assert(shotRight.right[1] == -shotLeft.right[1]);
    assert(native_render::ghost_trail_alpha(0, 1) == 0);
    assert(std::abs(native_render::ghost_trail_alpha(.4f, 1) - .48f) < .0001f);
    assert(native_render::ghost_trail_alpha(1, 1) == 1);
    std::cout << "Native render math: visibility, authored water ranges, bounded events, transformed bounds, "
                 "deterministic particles passed\n";
}
