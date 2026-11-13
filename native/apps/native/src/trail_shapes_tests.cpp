// The trail shapes (trail_shapes.hpp) against the website's player/trail.ts: the same mark hash, the shape names, and
// how many quads each shape lays on a straight path.
#include "trail_shapes.hpp"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <vector>

namespace {
using native_render::TrailShape;

void test_hash_matches_the_website() {
    // trail.ts hash(n, salt) for (0, 0), (7, 1), (123456, 21), (399, 14).
    assert(std::abs(native_render::trail_hash(0, 0) - .774970364f) < 1e-6f);
    assert(std::abs(native_render::trail_hash(7, 1) - .942073885f) < 1e-6f);
    assert(std::abs(native_render::trail_hash(123456, 21) - .788590266f) < 1e-6f);
    assert(std::abs(native_render::trail_hash(4 * 99 + 3, 14) - .379990984f) < 1e-6f);
}

void test_shape_names() {
    assert(native_render::trail_shape_of("shape-petals") == TrailShape::petals);
    assert(native_render::trail_shape_of("clover") == TrailShape::clover);
    assert(native_render::trail_shape_of("shape-ribbon") == TrailShape::ribbon);
    assert(native_render::trail_shape_of("trail-gold") == TrailShape::ribbon);
}

size_t quads(TrailShape shape, int64_t phase) {
    std::vector<native_render::Vec3> points;
    for (int i = 0; i < 40; i++)
        points.push_back({float(i) * 20, 0, 0});
    const float eye[3] = {400, -600, 200};
    native_render::TrailShapes shapes;
    size_t count = 0;
    shapes.build(shape, points, eye, {{1, 1, 1}, {1, 1, 1}}, 1, 2.5f, phase, [&](const native_render::TrailQuad &) {
        ++count;
    });
    return count;
}

void test_quad_counts() {
    assert(quads(TrailShape::ribbon, 0) == 39);
    assert(quads(TrailShape::comet, 0) == 39);
    assert(quads(TrailShape::twin, 0) == 78);
    // Dashes: three samples in every six, laid by sample number, so they stay put as the window slides.
    assert(quads(TrailShape::dashes, 0) == 21);
    assert(quads(TrailShape::dashes, 3) == 18);
    assert(quads(TrailShape::seeds, 0) > 0 && quads(TrailShape::petals, 0) > 0);
    // Clover: the stem plus four leaves of two quads on every n-th sample.
    assert((quads(TrailShape::clover, 0) - 39) % 8 == 0 && quads(TrailShape::clover, 0) > 39);
}
}  // namespace

int main() {
    test_hash_matches_the_website();
    test_shape_names();
    test_quad_counts();
    std::puts("trail shapes: hash, names and quad counts match the website");
    return 0;
}
