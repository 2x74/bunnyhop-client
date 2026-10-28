#pragma once
#include <algorithm>
#include <cmath>

namespace native {
struct MusicEnvelope {
    double fade_elapsed = 0, fade_duration = 0, duck_hold = 0;
    float duck_target = 1, duck_gain = 1;

    void crossfade(double seconds) {
        fade_elapsed = 0;
        fade_duration = std::max(0., seconds);
    }

    void duck(float depth = .35f, double hold = 2.5) {
        if (!std::isfinite(depth) || !std::isfinite(hold)) return;
        duck_target = std::clamp(depth, 0.f, 1.f);
        duck_hold = std::max(0., hold);
    }

    void advance(double seconds, bool paused = false) {
        if (!std::isfinite(seconds) || seconds <= 0) return;
        if (!paused) fade_elapsed = std::min(fade_duration, fade_elapsed + seconds);
        const double attack = std::min(seconds, duck_hold);
        if (attack > 0) {
            duck_gain = duck_target + (duck_gain - duck_target) * float(std::exp(-attack / .06));
            duck_hold -= attack;
        }
        if (seconds > attack) duck_gain = 1 + (duck_gain - 1) * float(std::exp(-(seconds - attack) / .5));
    }

    float incoming() const { return fade_duration <= 0 ? 1 : float(std::clamp(fade_elapsed / fade_duration, 0., 1.)); }

    float outgoing() const { return 1 - incoming(); }

    bool fading() const { return incoming() < 1; }
};
}  // namespace native
