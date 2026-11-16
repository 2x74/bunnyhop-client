#pragma once
// Key sounds and the perfect jump sound (web audio/keysound-policy.ts, perfect-policy.ts; Settings → Audio → Sounds).
// Key sounds: a short sound as a key the style strafes with goes down (or any movement key), left a semitone down and
// right a semitone up. The perfect jump sound: one sound on each perfect jump in the two scroll styles, rising half a
// semitone per jump in a row up to the streak length's top. Both play at their own level under the master volume.
#include "native_input.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <string>
#include <string_view>

namespace native {

inline constexpr std::array<std::string_view, 4> key_sound_sets = {"thock", "click", "wood", "blip"};
inline constexpr std::array<std::string_view, 4> perfect_sound_sets = {"ping", "marimba", "chime", "pop"};
// A semitone down and up (KEY_RATE_LEFT / KEY_RATE_RIGHT).
inline const double key_rate_left = std::pow(2., -1. / 12), key_rate_right = std::pow(2., 1. / 12);
// The level curve for these sounds' volume sliders (web sliderGain).
inline constexpr double feedback_volume_exponent = 1.7;
// The streak's rise: semitones per perfect jump in a row, and the tops (STREAK_STEP, STREAK_TOP, SOUND_TOP).
inline constexpr double streak_step_semitones = .5;
inline constexpr double streak_top_short = 4, streak_top_long = 7;
inline constexpr std::array<double, 4> perfect_sound_tops = {5, 7, 3, 7};

// The keys a style strafes with (web styles.ts strafeKeys): A / D, W / S in Sideways, W in W-only.
enum class StrafeKeys { ad, ws, w };

inline StrafeKeys strafe_keys_of(std::string_view style) {
    if (style == "wonly") return StrafeKeys::w;
    if (style == "sideways") return StrafeKeys::ws;
    return StrafeKeys::ad;
}

// The set's sound id, the default set for anything unknown (keySoundId / perfectSoundId).
inline std::string key_sound_id(std::string_view set) {
    const bool known = std::find(key_sound_sets.begin(), key_sound_sets.end(), set) != key_sound_sets.end();
    return "key_" + std::string(known ? set : key_sound_sets[0]);
}

inline std::string perfect_sound_id(std::string_view set) {
    const bool known = std::find(perfect_sound_sets.begin(), perfect_sound_sets.end(), set) != perfect_sound_sets.end();
    return "perfect_" + std::string(known ? set : perfect_sound_sets[0]);
}

// Playback rate for keys going down that hold `bits` (the core's buttons), or 0 for no sound. Several keys at once
// make one sound: a strafe key's if there is one (keySoundRate).
inline double key_sound_rate(uint32_t bits, bool all_movement, StrafeKeys strafe) {
    constexpr uint32_t movement_bits = forward | back | left | right | jump | duck;
    if (strafe == StrafeKeys::w) {
        if (bits & forward) return 1;
    } else {
        const uint32_t low = strafe == StrafeKeys::ws ? forward : left, high = strafe == StrafeKeys::ws ? back : right;
        if (bits & low) return key_rate_left;
        if (bits & high) return key_rate_right;
    }
    return all_movement && (bits & movement_bits) ? 1 : 0;
}

// Semitones up for the `n`th perfect jump in a row (1 = the first, at the sound's own pitch).
inline double streak_semitones(unsigned n, bool long_rise, std::string_view set) {
    const auto at = std::find(perfect_sound_sets.begin(), perfect_sound_sets.end(), set);
    const double sound_top =
            at == perfect_sound_sets.end() ? 0 : perfect_sound_tops[size_t(at - perfect_sound_sets.begin())];
    const double rise = double(n > 0 ? n - 1 : 0) * streak_step_semitones;
    return std::min({rise, long_rise ? streak_top_long : streak_top_short, sound_top});
}

inline double streak_rate(unsigned n, bool long_rise, std::string_view set) {
    constexpr double semitones_per_octave = 12;
    return std::pow(2., streak_semitones(n, long_rise, set) / semitones_per_octave);
}

// Consecutive perfect jumps (PerfectStreak), broken like the announcer's: a measured jump that wasn't perfect, a stop
// on the ground as long as the timer stops measuring at (ceil(0.1 s / tick) ticks), or a broken tick.
class PerfectStreak {
public:
    unsigned count = 0;

    // One tick. `hop`: 1 a perfect jump this tick, 0 a measured jump that wasn't, -1 none. Returns the streak length
    // when this tick's jump is perfect, else 0.
    unsigned tick(int hop, bool grounded, double dt, bool broken) {
        constexpr double measured_ground_seconds = .1;
        if (broken) {
            reset();
            return 0;
        }
        ground_ = grounded ? ground_ + 1 : 0;
        if (ground_ >= unsigned(std::ceil(double(float(measured_ground_seconds / dt))))) count = 0;
        if (hop == 0) count = 0;
        if (hop != 1) return 0;
        return ++count;
    }

    void reset() {
        count = 0;
        ground_ = 0;
    }

private:
    unsigned ground_ = 0;
};

}  // namespace native
