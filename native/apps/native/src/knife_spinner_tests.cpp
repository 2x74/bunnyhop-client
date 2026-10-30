#include "knife_spinner.hpp"
#include <cassert>
#include <cmath>
#include <vector>

namespace {

void test_spinner_idle_flicks() {
    native_render::KnifeSpinner spinner;
    assert(native_render::whirl_idle_degrees(spinner, 0) == 0);
    // Fifteen thirds of a turn by the end of each period: the same look as rest, so the wrap doesn't jump.
    const double end = native_render::whirl_idle_degrees(spinner, 6.5 - 1e-9);
    assert(std::abs(end - 15 * 120) < 1e-3);
    assert(native_render::whirl_idle_degrees(spinner, 6.5) < 1e-6);
    const double early = native_render::whirl_idle_degrees(spinner, .5);
    const double late = native_render::whirl_idle_degrees(spinner, 3);
    assert(early > 790 && early < 810 && late > early && late < 1800);
}

void test_spinner_turns_about_its_axle() {
    native_render::KnifeSpinner spinner;
    spinner.bone = 1;
    spinner.axis = {0, 0, 1};
    spinner.pivot = {2, 0, 0};
    std::vector<float> pose(24, 0);
    for (size_t bone = 0; bone < 2; ++bone)
        for (int row = 0; row < 3; ++row)
            pose[bone * 12 + size_t(row) * 5] = 1;
    native_render::turn_spinner(pose, spinner, 90);
    // The website turns the bone by -angle about its local x: a point one unit out along +x from the pivot goes to -y.
    const float point[3] = {3, 0, 0};
    float moved[3];
    for (int row = 0; row < 3; ++row)
        moved[row] = pose[12 + size_t(row) * 4] * point[0] + pose[12 + size_t(row) * 4 + 1] * point[1]
                     + pose[12 + size_t(row) * 4 + 2] * point[2] + pose[12 + size_t(row) * 4 + 3];
    assert(std::abs(moved[0] - 2) < 1e-5 && std::abs(moved[1] + 1) < 1e-5 && std::abs(moved[2]) < 1e-5);
    assert(pose[0] == 1 && pose[3] == 0);
    native_render::turn_spinner(pose, spinner, 270);
    assert(std::abs(pose[12] - 1) < 1e-5 && std::abs(pose[15]) < 1e-5);
}

}  // namespace

int main() {
    test_spinner_idle_flicks();
    test_spinner_turns_about_its_axle();
}
