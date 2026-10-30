#include "water_capture.hpp"
#include <cassert>
#include <iostream>

namespace {
using native_render::Vec3;

// A flat 256-unit water square at height z, centred on (x, y).
void add_pool(native_render::WaterCellBuilder &builder, uint32_t material, float x, float y, float z) {
    constexpr float half = 128, flat = 1;
    const Vec3 a{x - half, y - half, z}, b{x + half, y - half, z}, c{x + half, y + half, z}, d{x - half, y + half, z};
    builder.add_triangle(material, {a, b, c}, flat);
    builder.add_triangle(material, {a, c, d}, flat);
}

native::Matrix looking_down_x(const Vec3 &eye) {
    const float position[3] = {eye[0], eye[1], eye[2]};
    return native::camera_matrix(position, 0, 30, 16.f / 9);
}

void test_cells() {
    native_render::WaterCellBuilder builder;
    add_pool(builder, 0, 300, 512, 100);
    add_pool(builder, 0, 3000, 512, 100);
    builder.add_triangle(1, {Vec3{300, 200, 0}, Vec3{300, 300, 0}, Vec3{300, 300, 100}}, 0);
    const auto cells = builder.cells();
    assert(cells.size() == 3);
    size_t flat = 0;
    for (const auto &cell : cells)
        if (cell.height) {
            assert(*cell.height == 100);
            flat++;
        }
    assert(flat == 2);
}

void test_distance_and_height() {
    native_render::WaterCellBuilder builder;
    add_pool(builder, 0, 600, 0, 100);
    add_pool(builder, 1, 600, 0, 40);
    native_render::WaterCapturePlanner planner;
    planner.load(builder.cells(), 2);
    const Vec3 above{0, 0, 164};
    auto plan = planner.plan(above, looking_down_x(above));
    assert(plan.refract && planner.ready(0) && planner.ready(1));
    assert(plan.reflection_height && *plan.reflection_height == 100);
    // Below the upper surface: only the lower one is seen from above.
    const Vec3 between{0, 0, 70};
    plan = planner.plan(between, looking_down_x(between));
    assert(!planner.ready(0) && planner.ready(1));
    assert(plan.reflection_height && *plan.reflection_height == 40);
    // Behind the camera: nothing on screen.
    plan = planner.plan(above, native::camera_matrix(std::array<float, 3>{0, 0, 164}.data(), 180, 30, 16.f / 9));
    assert(!plan.refract && !plan.reflection_height && !planner.ready(0));
}

void test_capture_distance_margin() {
    native_render::WaterCellBuilder builder;
    add_pool(builder, 0, 0, 0, 0);
    native_render::WaterCapturePlanner planner;
    planner.load(builder.cells(), 1);
    // 128 to the pool's edge plus 1600: out of reach until captures start, then kept within the margin.
    const Vec3 far_eye{-1728, 0, 20};
    assert(!planner.plan(far_eye, looking_down_x(far_eye)).refract);
    const Vec3 near_eye{-1000, 0, 20};
    assert(planner.plan(near_eye, looking_down_x(near_eye)).refract);
    assert(planner.plan(far_eye, looking_down_x(far_eye)).refract);
    const Vec3 beyond{-2000, 0, 20};
    assert(!planner.plan(beyond, looking_down_x(beyond)).refract);
}

void test_mirror() {
    const auto mirror = native_render::mirror_matrix(100);
    const auto on_plane = native_render::transform_point(mirror, {5, 6, 100});
    assert(on_plane[0] == 5 && on_plane[1] == 6 && on_plane[2] == 100);
    const auto above = native_render::transform_point(mirror, {5, 6, 130});
    assert(above[2] == 70);
}
}  // namespace

int main() {
    test_cells();
    test_distance_and_height();
    test_capture_distance_margin();
    test_mirror();
    std::cout << "Native water capture: cells, distance, height, margin and mirror passed\n";
}
