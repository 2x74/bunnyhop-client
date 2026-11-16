// Sprung hair and the 16th packed field against the website (hair-fx.ts advanceHair, lengthFactor, loadout.ts
// unpackHead). The spring vectors are the website's own output for the same inputs.
#include "hair_motion.hpp"
#include <cassert>
#include <cmath>
#include <cstdio>

namespace {

constexpr double step_seconds = 1. / 120;
constexpr double vector_tolerance = 5e-5;

bool near(double a, double b, double tolerance = vector_tolerance) {
    return std::abs(a - b) <= tolerance;
}

void expect(const std::array<double, 3> &got, const std::array<double, 3> &want, const char *what) {
    for (size_t k = 0; k < 3; k++)
        if (!near(got[k], want[k])) {
            std::fprintf(stderr, "%s[%zu]: %.6f, want %.6f\n", what, k, got[k], want[k]);
            assert(false);
        }
}

void run_at_speed() {
    native_render::HairMotion hair;
    const float velocity[3] = {900, 0, 0};
    native_render::advance_hair(hair, velocity, 0, 0, false);
    for (int i = 0; i < 240; i++)
        native_render::advance_hair(hair, velocity, 0, step_seconds, false);
    expect(hair.loose, {.00001, .44647, 0}, "running loose");
    expect(hair.stiff, {0, .08998, 0}, "running stiff");
}

void hops() {
    constexpr double jump_speed = 301.993, gravity = 800, hop_seconds = .75498;
    native_render::HairMotion hair;
    float velocity[3] = {0, -700, float(jump_speed)};
    native_render::advance_hair(hair, velocity, -90, 0, false);
    for (int i = 1; i <= 120; i++) {
        const double t = i * step_seconds;
        velocity[2] = float(jump_speed - gravity * std::fmod(t, hop_seconds));
        native_render::advance_hair(hair, velocity, -90, step_seconds, false);
    }
    expect(hair.loose, {.00008, .39501, -.59526}, "hopping loose");
    expect(hair.stiff, {0, .07909, .21404}, "hopping stiff");
}

void snaps_and_bad_input() {
    native_render::HairMotion hair;
    float velocity[3] = {900, 0, 0};
    native_render::advance_hair(hair, velocity, 0, 0, false);
    native_render::advance_hair(hair, velocity, 0, .5, false);
    native_render::advance_hair(hair, velocity, 0, .1, true);
    assert(hair.loose[1] == 0 && hair.stiff[1] == 0);
    velocity[0] = std::nanf("");
    native_render::advance_hair(hair, velocity, std::nan(""), .016, false);
    for (double v : hair.loose)
        assert(std::isfinite(v));
}

void length_factors() {
    const double spiky[] = {.55, .775, 1, 1.45, 1.9}, long_hair[] = {.5, .75, 1, 1.375, 1.75};
    const double percents[] = {40, 70, 100, 200, 300};
    for (size_t i = 0; i < 5; i++) {
        assert(near(native_render::hair_length_factor(percents[i], .55, 1.9, true), spiky[i], 1e-9));
        assert(near(native_render::hair_length_factor(percents[i], .5, 1.75, true), long_hair[i], 1e-9));
        assert(near(native_render::hair_length_factor(percents[i], 0, 0, false), percents[i] / 100, 1e-9));
    }
}

void head_field() {
    const auto colour = [](const char *field) {
        const auto head = native_render::unpack_head(field);
        assert(head.has_highlight && !head.mask_on);
        return head.highlight;
    };
    assert(colour("-z") == 0xffaa33);
    assert(colour("00") == 0x000000);
    assert(colour("__") == 0xffffff);
    assert(colour("Qz") == 0xdd2233);
    const auto mask = native_render::unpack_head("f");
    assert(mask.mask_on && !mask.has_highlight);
    for (const char *bad : {"", "x", "abc", ";;", "F", "z!"}) {
        const auto head = native_render::unpack_head(bad);
        assert(!head.mask_on && !head.has_highlight);
    }
}

}  // namespace

int main() {
    run_at_speed();
    hops();
    snaps_and_bad_input();
    length_factors();
    head_field();
    std::puts("hair motion: web vectors match");
}
