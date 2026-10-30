#include "native_cosmetics.hpp"
#include <cassert>
#include <limits>

int main() {
    using namespace native_render;
    assert(!parse_glow(nullptr));
    assert(!parse_glow("violet"));
    auto a = parse_glow({{"enabled", true}, {"aura", false}, {"color", "#12AB34"}, {"intensity", 4}});
    assert(a && a->enabled && !a->aura && a->intensity == 1);
    assert(std::abs(a->color[0] - 18.f / 255) < .001);
    auto b = parse_glow({{"enabled", "yes"}, {"aura", 7}, {"color", nullptr}, {"intensity", -.5}});
    assert(b && !b->enabled && b->aura && b->intensity == .25f);
    assert(parse_glow({{"color", "cyan"}})->color[2] > .9f);
    AccessoryMotion motion;
    advance_accessory(motion, 0, 0, true);
    advance_accessory(motion, .1, 1000, false);
    assert(motion.angle > 1 && motion.squash > 0 && motion.alert > 0);
    const auto before = motion.angle;
    advance_accessory(motion, .11, 1000, false);
    assert(motion.angle > before);
    advance_accessory(motion, .12, 1000, true);
    assert(motion.squash < 0);
    advance_accessory(motion, 0, 0, true, true);
    assert(motion.angle == 0 && motion.squash == 0);
    advance_accessory(motion, .1, std::numeric_limits<float>::quiet_NaN(), true);
    assert(std::isfinite(motion.angle));
    assert(packed_outfit("2;knife-carrot;fin-garden;glove-knit;;hat-ponytail;;outfit-neon;f29bbf;120")
           == "outfit-neon");
    assert(packed_outfit("2;knife-carrot;fin-garden;glove-knit;;;;outfit-bune") == "outfit-bune");
    assert(!packed_outfit("2;knife-carrot;fin-garden;glove-knit;1;hat-tophat"));
    assert(!packed_outfit("2;knife-carrot;fin-garden;glove-knit;;;;;f29bbf"));
}
