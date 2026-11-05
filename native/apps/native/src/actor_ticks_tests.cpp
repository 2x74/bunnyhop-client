// Tick presentation (actor_ticks.hpp): between two posed ticks the bunny is shown part of the way from one to the
// other (skinning, feet yaw across 0/360, bank, root), a teleport holds the tick before until it's all the way there,
// and the first tick after a reset stands for both.
#include "actor_ticks.hpp"
#include <cassert>
#include <cmath>
#include <iostream>

namespace {
using native_actor_anim::TickPresentation;

bool close_to(double a, double b) {
    return std::abs(a - b) < 1e-5;
}

bool same_angle(double a, double b) {
    return std::abs(std::remainder(a - b, 360.)) < 1e-5;
}

void test_blend() {
    TickPresentation ticks;
    const std::vector<float> first(12, 0), second(12, 10);
    ticks.keep(first, 350, 2, {0, 0, 0}, false);
    std::vector<float> shown(12, -1);
    auto pose = ticks.present(.5, shown);
    assert(close_to(shown[0], 0) && same_angle(pose.feet_yaw, 350) && close_to(pose.root[0], 0));
    ticks.keep(second, 10, 4, {10, 0, 2}, false);
    pose = ticks.present(.25, shown);
    assert(close_to(shown[0], 2.5) && close_to(shown[11], 2.5));
    assert(same_angle(pose.feet_yaw, 355) && close_to(pose.bank, 2.5));
    assert(close_to(pose.root[0], 2.5) && close_to(pose.root[2], .5));
    pose = ticks.present(1.5, shown);
    assert(close_to(shown[0], 10) && same_angle(pose.feet_yaw, 10) && close_to(pose.root[0], 10));
}

void test_teleport_holds() {
    TickPresentation ticks;
    const std::vector<float> before(12, 1), after(12, 7);
    ticks.keep(before, 0, 0, {0, 0, 0}, false);
    ticks.keep(after, 90, 0, {500, 0, 0}, true);
    std::vector<float> shown(12);
    auto pose = ticks.present(.9, shown);
    assert(close_to(shown[0], 1) && close_to(pose.root[0], 0) && same_angle(pose.feet_yaw, 0));
    pose = ticks.present(1, shown);
    assert(close_to(shown[0], 7) && close_to(pose.root[0], 500));
    ticks.reset();
    ticks.keep(after, 90, 0, {500, 0, 0}, false);
    ticks.present(0, shown);
    assert(close_to(shown[0], 7));
}
}  // namespace

int main() {
    test_blend();
    test_teleport_holds();
    std::cout << "Tick presentation blends, wraps, holds teleports and restarts cleanly\n";
    return 0;
}
