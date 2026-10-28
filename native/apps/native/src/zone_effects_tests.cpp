#include "zone_effects.hpp"
#include "settings.hpp"
#include <cassert>
#include <cmath>

int main() {
    auto near = [](double a, double b) {
        assert(std::abs(a - b) < 1e-5);
    };
    native::ZoneEffects z;
    z.add(0, 0);
    z.add(1, 0);
    z.add(0, 1);
    z.add(2, 0);
    z.frame(0, 0, 0);
    near(z.level(0), 1);
    near(z.level(3), .5);
    z.frame(1, 0, 1);
    z.frame(1, 0, 1.125);
    near(z.level(0), .25);
    near(z.level(2), 1);
    z.frame(1, 0, 1.25);
    near(z.level(0), 0);
    z.frame(2, 0, 2, true);
    z.frame(2, 0, 2.12, true);
    near(z.level(1), 2.6);
    const auto p = native::semantic_palette("redGreen");
    const auto gold = z.color(1, p.zones[1], 2.12);
    near(gold[0], 1);
    near(gold[1], 212. / 255);
    z.frame(2, 0, 2.4, true);
    near(z.level(1), 1);
    near(z.color(1, p.zones[1], 2.4)[1], p.zones[1][1]);
    z.frame(0, 0, 3);
    z.frame(0, 0, 3.125);
    near(z.level(0), .75);
    z.frame(0, 0, 3.25);
    near(z.level(0), 1);
    z.frame(1, 1, 4);
    z.frame(1, 1, 4.25);
    near(z.level(2), 0);
    near(z.level(0), 1);
    z.frame(0, 0, 0);
    near(z.level(2), 1);  // seek/reset clock rollback
    near(native::semantic_palette("unknown").zones[0][1], 221. / 255);
    near(p.gain[0], 86. / 255);
    near(native::semantic_palette("blueYellow").trainer[1][0], 200. / 255);
    const auto prefs = native::patch_settings(native::default_settings(), {{"colorBlind", "redGreen"}});
    assert(prefs["colorBlind"] == "redGreen");
    bool rejected = false;
    try {
        native::patch_settings(prefs, {{"colorBlind", "invalid"}});
    } catch (...) {
        rejected = true;
    }
    assert(rejected);
}
