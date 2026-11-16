// Key sounds and the perfect jump sound against the website's rules (test/key-sounds.test.ts): which presses sound and
// at what pitch, the perfect streak and its rise.
#include "key_sounds.hpp"
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace {
void check(bool value, const std::string &message) {
    if (value) return;
    std::fprintf(stderr, "%s\n", message.c_str());
    std::exit(1);
}

void check_rates() {
    using native::StrafeKeys;
    const double left = native::key_rate_left, right = native::key_rate_right;
    check(std::abs(right / left - std::pow(2., 2. / 12)) < 1e-12, "a tone apart");
    check(native::key_sound_rate(native::left, false, StrafeKeys::ad) == left, "A plays low");
    check(native::key_sound_rate(native::right, false, StrafeKeys::ad) == right, "D plays high");
    for (const uint32_t bit : {native::forward, native::back, native::jump, native::duck})
        check(native::key_sound_rate(bit, false, StrafeKeys::ad) == 0, "strafe keys only");
    check(native::key_sound_rate(native::forward, false, StrafeKeys::ws) == left, "Sideways W");
    check(native::key_sound_rate(native::back, false, StrafeKeys::ws) == right, "Sideways S");
    check(native::key_sound_rate(native::left, false, StrafeKeys::ws) == 0, "Sideways A");
    check(native::key_sound_rate(native::forward, false, StrafeKeys::w) == 1, "W-only W");
    check(native::key_sound_rate(native::left, false, StrafeKeys::w) == 0, "W-only A");
    for (const uint32_t bits : {native::forward, native::back, native::jump, native::duck, native::jump | native::duck})
        check(native::key_sound_rate(bits, true, StrafeKeys::ad) == 1, "all movement keys");
    check(native::key_sound_rate(native::left, true, StrafeKeys::ad) == left, "a strafe key keeps its pitch");
    check(native::key_sound_rate(native::right | native::jump, true, StrafeKeys::ad) == right, "strafe key wins");
    check(native::key_sound_rate(native::left, true, StrafeKeys::w) == 1, "W-only all keys");
    for (const bool all : {false, true})
        for (const uint32_t bits : {native::use, native::attack, 0u})
            check(native::key_sound_rate(bits, all, StrafeKeys::ad) == 0, "never use or the weapon");
    check(native::strafe_keys_of("sideways") == StrafeKeys::ws && native::strafe_keys_of("wonly") == StrafeKeys::w
                  && native::strafe_keys_of("adonly") == StrafeKeys::ad,
          "style strafe keys");
    check(native::key_sound_id("wood") == "key_wood" && native::key_sound_id("typewriter") == "key_thock", "ids");
    check(native::perfect_sound_id("pop") == "perfect_pop" && native::perfect_sound_id("x") == "perfect_ping", "ids");
}

void check_streak() {
    const double dt = double(.01f);
    native::PerfectStreak streak;
    const auto hop = [&](bool perfect) {
        unsigned n = streak.tick(perfect ? 1 : 0, false, dt, false);
        for (int i = 0; i < 70; ++i)
            n = streak.tick(-1, false, dt, false) ? streak.count : n;
        return n;
    };
    for (unsigned want = 1; want <= 6; ++want)
        check(hop(true) == want, "one more per perfect jump");
    check(hop(false) == 0 && hop(true) == 1, "a miss starts over");
    for (int i = 0; i < 9; ++i)
        streak.tick(-1, true, dt, false);
    check(streak.tick(1, false, dt, false) == 2, "9 ground ticks: still measured");
    for (int i = 0; i < 10; ++i)
        streak.tick(-1, true, dt, false);
    check(streak.tick(1, false, dt, false) == 1, "0.1 s on the ground starts over");
    check(streak.tick(-1, false, dt, true) == 0 && streak.tick(1, false, dt, true) == 0, "a broken tick never sounds");
    check(streak.tick(1, false, dt, false) == 1, "and starts over");
}

void check_rise() {
    std::vector<double> marimba;
    for (unsigned n = 1; n <= 20; ++n)
        marimba.push_back(native::streak_semitones(n, true, "marimba"));
    const std::vector<double> want = {0, .5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7, 7, 7, 7, 7};
    check(marimba == want, "marimba Long climbs to +7 at the 15th and holds");
    check(native::streak_semitones(9, false, "pop") == 4 && native::streak_semitones(8, false, "pop") == 3.5
                  && native::streak_semitones(20, false, "pop") == 4,
          "Short tops out at +4 on the 9th");
    check(native::streak_semitones(20, true, "ping") == 5, "ping tops out at +5");
    check(native::streak_semitones(20, true, "chime") == 3 && native::streak_semitones(20, false, "chime") == 3,
          "chime");
    check(native::streak_rate(1, true, "ping") == 1, "the first at the sound's own pitch");
    check(std::abs(native::streak_rate(15, true, "marimba") - std::pow(2., 7. / 12)) < 1e-12, "rate");
    check(native::streak_semitones(0, true, "ping") == 0, "zero");
}
}  // namespace

int main() {
    check_rates();
    check_streak();
    check_rise();
    return 0;
}
