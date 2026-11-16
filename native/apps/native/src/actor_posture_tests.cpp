// The bunny's posture, follow-through and pose continuity (actor_posture.hpp) against the website's tests
// (apps/web/test bunny-posture, bunny-follow, bunny-continuity). The whole chain on the real rig is compared frame by
// frame in actor_pose_tests.cpp; these pin the layers' own numbers.
#include "actor_posture.hpp"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <vector>

namespace {

using native_actor_anim::FollowThrough;
using native_actor_anim::PoseContinuity;
using native_actor_anim::Posture;

constexpr double jump_speed = 301.993, gravity = 800;

bool near(double a, double b, double tolerance) {
    return std::abs(a - b) <= tolerance;
}

void posture_shares() {
    Posture p;
    p.update(0, true, true, true, false, 0);
    assert(near(p.share, .62, 1e-12) && near(p.lift, 1.6, 1e-12));
    p.update(0, true, true, true, false, 250);
    assert(near(p.share, .5, 1e-12) && near(p.lift, .8, 1e-12));
    p.update(0, true, true, false, false, 250);
    assert(near(p.share, .42, 1e-12));
    p.update(0, true, true, false, false, 800);
    assert(near(p.share, .3, 1e-12));
    p.update(0, true, true, true, true, 0);
    assert(near(p.share, .3, 1e-12) && near(p.lift, 0, 1e-12));
    p.update(0, true, false, true, false, 0);
    assert(p.share == 0 && p.lift == 0);
    // Off the ground at once, back on it slowly: one ground tick in a hop barely moves it.
    p.update(0, true, true, false, false, 400);
    const double air = p.share;
    p.update(.01, false, true, true, false, 400);
    assert(std::abs(p.share - air) < .01);
}

// The load sampled on a 60 Hz grid at `fps`, falling into a bhop's bounce at 1 s on a 100 Hz tick grid.
std::vector<double> bounce_loads(int fps) {
    const auto vz = [](double t) {
        const double tick = std::floor(t * 100 + 1e-6) / 100;
        return tick < 1 ? -jump_speed - gravity * (tick - 1) : jump_speed - gravity * (tick - 1);
    };
    FollowThrough follow(.3);
    std::vector<double> out;
    for (int i = 0; i <= int(std::lround(1.7 * fps)); i++) {
        const double t = double(i) / fps;
        follow.update(i ? 1. / fps : 0, i == 0, true, vz(t), false, 400, t);
        if (std::abs(t * 60 - std::round(t * 60)) < 1e-6) out.push_back(follow.load);
    }
    return out;
}

void follow_bounce() {
    const auto loads = bounce_loads(240);
    double before = 0, peak = -1, low = 1;
    size_t when = 0;
    for (size_t i = 0; i < loads.size(); i++) {
        if (i < 60) before = std::max(before, std::abs(loads[i]));
        if (loads[i] > peak) {
            peak = loads[i];
            when = i;
        }
        low = std::min(low, loads[i]);
    }
    std::printf("bounce: peak %.3f at %.3f s, low %.3f\n", peak, double(when) / 60, low);
    assert(before < .01);
    assert(peak > .85 && peak < 1.05);
    assert(double(when) / 60 > 1.05 && double(when) / 60 < 1.11);
    assert(low < -.12 && low > -.3);
    assert(std::abs(loads[99]) < .03);
    const auto at60 = bounce_loads(60), at144 = bounce_loads(144);
    for (size_t i = 0; i < at60.size(); i++)
        assert(std::abs(at60[i] - loads[i]) < .08);
    for (size_t k = 0; k < at144.size() && k * 5 < at60.size(); k++)
        assert(std::abs(at60[k * 5] - at144[k]) < .08);
}

void follow_lift_is_not_a_jolt() {
    for (int fps : {30, 60, 240}) {
        FollowThrough follow;
        for (int i = 0; i <= int(1.5 * fps); i++) {
            const double t = double(i) / fps;
            follow.update(i ? 1. / fps : 0, i == 0, true, 1000 * std::min(1., t), false, 400, t);
            assert(std::abs(follow.load) < .01);
        }
    }
}

void follow_breathes_standing_still() {
    FollowThrough follow(.25);
    follow.update(0, true, true, 0, true, 0, 0);
    assert(near(follow.breath, std::sin(.25 * 2 * 3.141592653589793), 1e-9));
    follow.update(.1, false, true, 0, true, 300, .1);
    follow.update(1, false, true, 0, true, 300, 1.1);
    assert(std::abs(follow.breath) < .01);
}

void continuity_eases_a_snap() {
    PoseContinuity continuity;
    std::vector<float> skin(24, 1);
    continuity.apply(skin, 24, "ACT_RUN", 0, 0, true);
    assert(continuity.weight == 0);
    std::vector<float> jumped(24, 3);
    continuity.apply(jumped, 24, "ACT_HOP", 1, 1. / 60, false);
    assert(continuity.weight == 1 && near(jumped[5], 1, 1e-6));
    std::vector<float> half(24, 3);
    continuity.apply(half, 24, "ACT_HOP", 1, .05 - 1. / 60, false);
    std::vector<float> later(24, 3);
    continuity.apply(later, 24, "ACT_HOP", 1, 1. / 60, false);
    assert(near(continuity.weight, .5, 1e-9) && near(later[0], 2, 1e-5));
    std::vector<float> done(24, 3);
    continuity.apply(done, 24, "ACT_HOP", 1, .06, false);
    assert(continuity.weight == 0 && done[0] == 3);
    std::vector<float> teleported(24, 9);
    continuity.apply(teleported, 24, "ACT_IDLE", 1, 1. / 60, true);
    assert(continuity.weight == 0 && teleported[0] == 9);
}

}  // namespace

int main() {
    posture_shares();
    follow_bounce();
    follow_lift_is_not_a_jolt();
    follow_breathes_standing_still();
    continuity_eases_a_snap();
    std::puts("actor posture: web numbers match");
}
