#include "eye_clearance.hpp"
#include "replay_camera.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <cmath>

namespace {
constexpr float standing_eye_units = 64, ducked_eye_units = 47;

struct Sweep {
    float start[3], end[3], radius;
};

// A flat ceiling for the cube sweep: the cube's top face hits it, or the cube starts inside it.
float ceiling_z = 1e6f;
Sweep last_sweep{};
unsigned sweeps = 0;

bool near(float a, float b) {
    return std::abs(a - b) < .001f;
}

float clear(float ceiling, float top_z, float eye_z) {
    ceiling_z = ceiling;
    return native::clear_eye_z(reinterpret_cast<BhContext *>(1), 0, 0, top_z, eye_z);
}

void away_from_ceilings() {
    ceiling_z = 1e6f;
    const float eye = native::clear_eye_z(reinterpret_cast<BhContext *>(1), 5, 7, 162, 164);
    assert(eye == 164);
    // 30x30 like CS:S, from the hull's top to 12 units above the eye, straight up.
    assert(last_sweep.start[0] == 5 && last_sweep.start[1] == 7 && last_sweep.start[2] == 147);
    assert(last_sweep.end[0] == 5 && last_sweep.end[1] == 7 && last_sweep.end[2] == 161);
    assert(last_sweep.radius == 15);
}

void under_a_ceiling() {
    constexpr float top = 100 + native::standing_hull_top_units, eye = 100 + standing_eye_units;
    assert(near(clear(172, top, eye), 160));          // CS:S standing in a 72-unit corridor sees from 60.
    assert(near(clear(162.03f, top, eye), 150.03f));  // Hull against the ceiling: the eye would be through it.
    assert(clear(176.5f, top, eye) == eye);           // Out of reach.
    assert(near(clear(176, top, eye), eye));          // Right at reach: no step as a ceiling comes into range.
}

void ducked_and_mid_duck() {
    constexpr float top = 100 + native::ducked_hull_top_units;
    assert(near(clear(145.03f, top, 100 + ducked_eye_units), 133.03f));
    assert(clear(172, 162, 155) == 155);  // A lower eye on its way down stays where it is.
}

void start_inside_something() {
    assert(clear(150, 162, 164) == 150);
}

void without_a_map() {
    const auto before = sweeps;
    assert(native::clear_eye_z(nullptr, 0, 0, 162, 164) == 164);
    assert(sweeps == before);
}

void blended_hull_top() {
    BhState prev{}, curr{};
    prev.position[2] = 100;
    curr.position[2] = 100;
    curr.crouched = 1;
    assert(native::blended_hull_top_z(prev, curr, 0) == 162);
    assert(native::blended_hull_top_z(prev, curr, 1) == 145);
    assert(near(native::blended_hull_top_z(prev, curr, .5f), 153.5f));
}

void replay_in_eye_camera() {
    native::ReplayCamera camera;
    camera.mode = "eye";
    BhState state{};
    state.position[2] = 100;
    state.view_offset_z = standing_eye_units;
    native::Input view;
    float eye[3];
    ceiling_z = 162.03f;
    camera.sample(reinterpret_cast<BhContext *>(1), state, 0, 0, 0, eye, view, .01);
    assert(near(eye[2], 150.03f));
    ceiling_z = 1e6f;
    camera.sample(nullptr, state, 0, 0, .01, eye, view, .01);
    assert(eye[2] == 164);
}
}  // namespace

extern "C" int bh_trace_camera(BhContext *, const float start[3], const float end[3], float radius, float *fraction) {
    ++sweeps;
    last_sweep = {{start[0], start[1], start[2]}, {end[0], end[1], end[2]}, radius};
    const float top = start[2] + radius;
    *fraction = top >= ceiling_z ? 0 : std::min(1.f, (ceiling_z - top) / (end[2] - start[2]));
    return 1;
}

int main() {
    away_from_ceilings();
    under_a_ceiling();
    ducked_and_mid_duck();
    start_inside_something();
    without_a_map();
    blended_hull_top();
    replay_in_eye_camera();
}
