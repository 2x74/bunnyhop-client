#pragma once
// Strafe trainer: how fast you turned in the air, against the turn rate that
// gains the most speed at your current speed.
//
// In Source air movement the wish speed is capped at 30 (see ssj.hpp), so the
// most speed a tick can add comes from turning by atan(30 / speed) per tick:
// turn slower and you leave gain on the table, turn faster and the wish
// direction swings past the velocity and starts eating it. 100% is that ideal.
//
// A reading comes out every air tick. By default it is that tick alone; a
// smoothing window averages the last N air ticks (a rolling mean, so it still
// moves every tick rather than jumping once per window).
//
// Hints look at a longer window so they don't flicker: too many air ticks
// without effective movement is dead time; otherwise the average
// turn rate decides between "turn more" and "turn less".
//
// Display only. Like the jump stats it reads the pre-tick state and the
// command already stepped, and feeds nothing back.
#include "ssj.hpp"
#include "hud_geometry.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <deque>
#include <optional>

namespace native {

enum class StrafeHint { less_deadtime, strafe_more, strafe_less };

inline const char *strafe_hint_text(StrafeHint hint) {
    switch (hint) {
        case StrafeHint::less_deadtime:
            return "Less deadtime!";
        case StrafeHint::strafe_more:
            return "Strafe more!";
        case StrafeHint::strafe_less:
            return "Strafe less!";
    }
    return "";
}

struct StrafeReading {
    float percent = 0;
    std::optional<StrafeHint> hint;
};

class StrafeTrainer {
public:
    static constexpr unsigned max_smoothing = 50;
    /** Air ticks the hints look back over: 0.3 s at 100 tick. */
    static constexpr unsigned hint_window = 30;
    /** Below this the ideal angle is meaningless (and atan(30/0) is 90°). */
    static constexpr float min_speed = 30.0f;
    /** Ground ticks after which a chain is over and the windows start again. */
    static constexpr unsigned ground_reset = 10;
    /** Share of dead air ticks that earns "Less deadtime!". */
    static constexpr float dead_limit = 0.25f;
    /** Average turn rate outside this band earns "Strafe more!" / "Strafe less!". */
    static constexpr float low_limit = 80.0f, high_limit = 120.0f;

    // Source IN_MOVELEFT / IN_MOVERIGHT.
    static constexpr std::uint32_t left_bit = 1u << 9, right_bit = 1u << 10;

    unsigned smoothing() const { return smoothing_; }

    void set_smoothing(unsigned n) { smoothing_ = std::clamp(n, 1u, max_smoothing); }

    /** One tick, using movement AFTER style filtering (W-only/HSW/auto-strafe included). */
    std::optional<StrafeReading> tick(bool grounded, float speed, float yaw, float forward, float side) {
        std::optional<StrafeReading> reading;
        if (grounded) {
            if (++ground_ticks_ > ground_reset) clear_windows();
        } else {
            ground_ticks_ = 0;
            if (have_yaw_ && speed >= min_speed) {
                const float turned = std::fabs(std::remainder(yaw - last_yaw_, 360.0f));
                const float percent = turned / ideal_degrees(speed) * 100.0f;
                samples_.push_back({percent, forward == 0 && side == 0});
                while (samples_.size() > std::max<std::size_t>(max_smoothing, hint_window))
                    samples_.pop_front();
                reading = StrafeReading{mean(smoothing_), hint()};
            }
        }
        last_yaw_ = yaw;
        have_yaw_ = true;
        return reading;
    }

    std::optional<StrafeReading> tick(bool grounded, float speed, float yaw, std::uint32_t buttons) {
        return tick(
                grounded,
                speed,
                yaw,
                450.f * (int(bool(buttons & ssj_in_forward)) - int(bool(buttons & ssj_in_back))),
                450.f * (int(bool(buttons & right_bit)) - int(bool(buttons & left_bit)))
        );
    }

    void reset() {
        clear_windows();
        have_yaw_ = false;
        ground_ticks_ = 0;
    }

    /** Degrees per tick that gain the most speed at |speed| u/s. */
    static float ideal_degrees(float speed) {
        return float(std::atan(30.0 / double(speed)) * 180.0 / 3.14159265358979323846);
    }

private:
    struct Sample {
        float percent;
        bool dead;
    };

    void clear_windows() { samples_.clear(); }

    float mean(unsigned n) const {
        n = std::min<unsigned>(n, unsigned(samples_.size()));
        float sum = 0;
        for (auto it = samples_.end() - n; it != samples_.end(); ++it)
            sum += it->percent;
        return sum / float(n);
    }

    std::optional<StrafeHint> hint() const {
        // Not enough of this chain yet to say anything fair.
        if (samples_.size() < hint_window) return std::nullopt;
        unsigned dead = 0;
        for (auto it = samples_.end() - hint_window; it != samples_.end(); ++it)
            dead += it->dead;
        if (float(dead) / float(hint_window) > dead_limit) return StrafeHint::less_deadtime;
        const float average = mean(hint_window);
        if (average < low_limit) return StrafeHint::strafe_more;
        if (average > high_limit) return StrafeHint::strafe_less;
        return std::nullopt;
    }

    HudSamples<Sample, max_smoothing> samples_;
    float last_yaw_ = 0;
    unsigned smoothing_ = 1, ground_ticks_ = 0;
    bool have_yaw_ = false;
};

// Presentation state has the same lifetime as its observed tick history. A seek
// skips that history, so no jump number or partial trainer window is presented
// until a start-zone or a full grounded reset supplies a known chain boundary.
struct MovementFeedback {
    SsjTracker ssj;
    std::string ssj_line;
    std::optional<float> ssj_gain;
    bool ssj_was_in_start = false, ssj_was_noclip = false;
    StrafeTrainer strafe_trainer;
    std::optional<StrafeReading> strafe_reading;
    unsigned strafe_ground_ticks = 0, history_ground_ticks = 0;
    bool incomplete_history = false;

    void reset(bool in_start = false, bool noclip = false, bool incomplete = false) {
        ssj.reset();
        ssj_line.clear();
        ssj_gain.reset();
        strafe_trainer.reset();
        strafe_reading.reset();
        strafe_ground_ticks = history_ground_ticks = 0;
        ssj_was_in_start = in_start;
        ssj_was_noclip = noclip;
        incomplete_history = incomplete;
    }

    bool history_ready(bool grounded, bool in_start, bool noclip) {
        if (!incomplete_history) return true;
        history_ground_ticks = grounded && !noclip ? history_ground_ticks + 1 : 0;
        if (!noclip && ((grounded && in_start) || history_ground_ticks > bhop_frames + 1)) {
            incomplete_history = false;
            history_ground_ticks = 0;
        }
        return !incomplete_history;
    }
};

/** 0: within 10% of ideal, 1: within 25%, 2: further off. */
inline int strafe_band(float percent) {
    const float off = std::fabs(percent - 100.0f);
    return off <= 10.0f ? 0 : off <= 25.0f ? 1 : 2;
}

}  // namespace native
