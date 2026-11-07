#pragma once
#include "jhud.hpp"
#include "ssj.hpp"
#include "hud_geometry.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string_view>

namespace native {
inline constexpr double trainer_pace_max = 200;
inline constexpr double trainer_target_pace = 100;
inline constexpr double trainer_min_speed = 100;
inline constexpr double trainer_turn_deadzone_degrees = .001;
inline constexpr unsigned trainer_landing_min_ticks = 5;
inline constexpr unsigned trainer_ok_span = 3;
inline constexpr unsigned trainer_max_smoothing = 50;
inline constexpr double trainer_bar_empty = 1e-6;
inline constexpr double trainer_bar_fill_steps = 1000;
// The on-pace width of the Bar's hints and jump sound, whatever the zone setting says.
inline constexpr double trainer_bar_zone = 10;
// Speed changes this small are float roundoff, measured on real replays while coasting (largest 0.0000195 u/s).
inline constexpr double trainer_bar_speed_epsilon = .0001;
inline constexpr double trainer_bar_perfect_gain = .99;
inline constexpr double trainer_bar_good_gain = .9;

enum class StrafeHint { less_deadtime, strafe_more, strafe_less, direction, unsupported };
enum class TrainerCue { ready, keys, direction, slow, good, fast, unsupported };
enum class TrainerBarBand { perfect, good, ok, low, high };

inline const char *strafe_hint_text(StrafeHint hint) {
    switch (hint) {
        case StrafeHint::less_deadtime:
            return "A / D";
        case StrafeHint::strafe_more:
            return "turn more";
        case StrafeHint::strafe_less:
            return "ease turn";
        case StrafeHint::direction:
            return "match your turn";
        case StrafeHint::unsupported:
            return "manual A/D only";
    }
    return "";
}

struct StrafeReading {
    double percent = 0;
    std::optional<StrafeHint> hint;
    TrainerCue cue = TrainerCue::ready;
    int side = 0;
    bool has_pace = true;
    // The Bar look's own average, where a tick with nothing to judge counts as 0. Empty when it is 0 and in previews,
    // where the Bar shows the pace and side above.
    std::optional<double> bar;
    int bar_side = 0;
    // The average pace of the last finished jump, the number under the Bar.
    std::optional<double> last_jump;
    // This tick's gain as a share of the best possible, the Bar's colour. Empty when it can't be judged.
    std::optional<double> gain;
};

struct TrainerSample {
    double speed = 0;
    bool grounded = false;
    bool on_ladder = false;
    int64_t tick = 0;
    double dt = .01;
    double max_speed = 260;
    double air_accelerate = 1000;
    std::string_view style = "autohop";
    bool interrupted = false;
    bool jumped = false;
    // The core's AirAccelerate observation. NaN when it has nothing to judge.
    double air_speed_gain = NAN;
    double air_best_gain = NAN;
};

inline unsigned trainer_band(double pace, double width = 10) {
    const double off = std::abs(pace - trainer_target_pace);
    return off <= width ? 2 : off <= width * trainer_ok_span ? 1 : 0;
}

inline double trainer_position(double pace, int side, bool follow) {
    const double position = std::clamp(pace, 0., trainer_pace_max) / trainer_pace_max;
    return follow && side < 0 ? 1 - position : position;
}

inline HudLabel<32> trainer_pace_text(std::optional<double> percent) {
    HudLabel<32> text;
    if (!percent)
        text.assign("—");
    else {
        const int pace = int(std::floor(*percent + .5));
        text.format("%d%s%%", pace, pace >= trainer_pace_max ? "+" : "");
    }
    return text;
}

inline HudLabel<32> trainer_text(const StrafeReading &reading) {
    return trainer_pace_text(reading.has_pace ? std::optional{reading.percent} : std::nullopt);
}

// The share of the Bar's track filled: 100% pace reaches the centre tick. Written so NaN is an empty track.
inline double trainer_bar_fill(double value) {
    return value > 0 ? std::min(1., value / trainer_pace_max) : 0;
}

// Written so an unavailable observation is empty, never a guess from the pace. Roundoff is removed in u/s, before the
// division, so the tolerance doesn't depend on how much gain was possible.
inline std::optional<double> trainer_bar_gain(double delta, double best) {
    if (!std::isfinite(delta) || !std::isfinite(best) || best <= 0) return std::nullopt;
    return std::abs(delta) <= trainer_bar_speed_epsilon ? 0 : delta / best;
}

// Red is a loss and white is no change or nothing to judge. Any real gain is at least orange.
inline TrainerBarBand trainer_bar_band(const std::optional<double> &gain) {
    if (!gain || !std::isfinite(*gain) || *gain == 0) return TrainerBarBand::low;
    if (*gain < 0) return TrainerBarBand::high;
    if (*gain > trainer_bar_perfect_gain) return TrainerBarBand::perfect;
    return *gain > trainer_bar_good_gain ? TrainerBarBand::good : TrainerBarBand::ok;
}

// What the Bar look draws for a reading. Turning right (D) fills from the left, turning left (A) from the right.
struct TrainerBarView {
    double fill = 0;
    bool from_left = true;
    std::optional<TrainerBarBand> band;
};

inline std::optional<double> trainer_bar_value(const StrafeReading &reading) {
    if (reading.bar) return reading.bar;
    return reading.has_pace ? std::optional{reading.percent} : std::nullopt;
}

inline TrainerBarView trainer_bar_view(const StrafeReading &reading) {
    const auto value = trainer_bar_value(reading);
    TrainerBarView view;
    view.from_left = (reading.bar ? reading.bar_side : reading.side) >= 0;
    if (!value) return view;
    view.fill = std::floor(trainer_bar_fill(*value) * trainer_bar_fill_steps + .5) / trainer_bar_fill_steps;
    view.band = trainer_bar_band(reading.gain);
    return view;
}

// The Bar's hints follow its own average, and only while there is a gain to go with it.
inline std::optional<StrafeHint> trainer_bar_hint(const StrafeReading &reading) {
    if (reading.cue == TrainerCue::unsupported) return StrafeHint::unsupported;
    const auto value = trainer_bar_value(reading);
    if (!reading.gain || !value || std::abs(*value - trainer_target_pace) <= trainer_bar_zone) return std::nullopt;
    return *value < trainer_target_pace ? StrafeHint::strafe_more : StrafeHint::strafe_less;
}

// One observation per simulated tick, using the post-tick speed and grounded state.
class StrafeTrainer {
    std::array<double, trainer_max_smoothing> window_{};
    unsigned size_ = 0;
    double sum_ = 0;
    double yaw_ = NAN;
    int64_t tick_ = -1;
    int side_ = 0;
    double air_sum_ = 0;
    unsigned air_ticks_ = 0;
    std::optional<double> landed_;
    std::optional<double> last_jump_;
    unsigned smoothing_ = 8;
    // Room for one past the longest window: a tick goes in before the oldest comes out, as on the website.
    std::array<double, trainer_max_smoothing + 1> bar_window_{};
    unsigned bar_size_ = 0;
    double bar_sum_ = 0;
    int bar_side_ = 0;
    unsigned ground_ticks_ = 0;

    void clear() {
        size_ = 0;
        sum_ = 0;
    }

    void clear_bar() {
        bar_size_ = 0;
        bar_sum_ = 0;
        bar_side_ = 0;
    }

    // The window's empty part counts as 0, so the fill grows out of its edge after a strafe switch.
    double push_bar(double raw) {
        bar_window_[bar_size_++] = raw;
        bar_sum_ += raw;
        while (bar_size_ > smoothing_) {
            bar_sum_ -= bar_window_[0];
            std::move(bar_window_.begin() + 1, bar_window_.begin() + bar_size_, bar_window_.begin());
            --bar_size_;
        }
        return bar_sum_ / smoothing_;
    }

    void idle(TrainerCue cue, std::optional<StrafeHint> hint = {}) {
        clear();
        side_ = 0;
        reading = {};
        reading.hint = hint;
        reading.cue = cue;
        reading.has_pace = false;
    }

    void average(double raw, int side) {
        if (side != side_) clear();
        side_ = side;
        if (size_ == window_.size()) {
            sum_ -= window_[0];
            std::move(window_.begin() + 1, window_.end(), window_.begin());
            --size_;
        }
        window_[size_++] = raw;
        sum_ += raw;
        while (size_ > smoothing_) {
            sum_ -= window_[0];
            std::move(window_.begin() + 1, window_.begin() + size_, window_.begin());
            --size_;
        }
        const double pace = sum_ / size_;
        const bool good = trainer_band(pace, zone) == 2;
        reading = {};
        reading.percent = pace;
        reading.cue = good ? TrainerCue::good : pace < trainer_target_pace ? TrainerCue::slow : TrainerCue::fast;
        reading.side = side;
        if (!good) reading.hint = pace < trainer_target_pace ? StrafeHint::strafe_more : StrafeHint::strafe_less;
    }

    static bool supported_style(std::string_view style) {
        return style == "autohop" || style == "legit" || style == "scroll" || style == "hsw";
    }

    static double turn_degrees(float yaw, double previous_yaw) {
        return std::fmod(std::fmod(yaw - previous_yaw + 540, 360) + 360, 360) - 180;
    }

    static double air_push(const TrainerSample &sample) {
        return std::min({double(air_wish_cap), sample.max_speed, sample.air_accelerate * sample.max_speed * sample.dt});
    }

    static double raw_pace(double turn, double push, double speed) {
        constexpr double degrees_per_radian = 180 / ssj_detail::pi;
        const double ideal = std::atan2(push, speed) * degrees_per_radian;
        return std::min(trainer_pace_max, trainer_target_pace * std::abs(turn) / ideal);
    }

    static bool samples_finite(const SsjCmd &command, const TrainerSample &sample) {
        return std::isfinite(sample.speed) && std::isfinite(sample.dt) && std::isfinite(sample.max_speed)
               && std::isfinite(sample.air_accelerate) && std::isfinite(command.yaw) && std::isfinite(command.side)
               && sample.dt > 0;
    }

    // The reading of the classic, detailed and minimal looks, and the jump averages.
    void feed_pace(const SsjCmd &command, const TrainerSample &sample, double previous_yaw, bool continuous) {
        if (!samples_finite(command, sample) || sample.interrupted || !continuous || !std::isfinite(previous_yaw)) {
            air_sum_ = 0;
            air_ticks_ = 0;
            return idle(TrainerCue::ready);
        }
        if (!supported_style(sample.style)) return idle(TrainerCue::unsupported, StrafeHint::unsupported);
        if (sample.grounded || sample.on_ladder || sample.jumped) {
            if (!sample.on_ladder && air_ticks_ >= trainer_landing_min_ticks) {
                landed_ = air_sum_ / air_ticks_;
                last_jump_ = landed_;
            }
            air_sum_ = 0;
            air_ticks_ = 0;
        }
        if (sample.grounded || sample.on_ladder || sample.speed < trainer_min_speed) return idle(TrainerCue::ready);
        const int side = (command.side > 0) - (command.side < 0);
        if (!side) return idle(TrainerCue::keys, StrafeHint::less_deadtime);
        const double turn = turn_degrees(command.yaw, previous_yaw);
        if (std::abs(turn) > trainer_turn_deadzone_degrees && ((turn > 0) - (turn < 0)) == side)
            return idle(TrainerCue::direction, StrafeHint::direction);
        const double push = air_push(sample);
        if (push <= 0) return idle(TrainerCue::ready);
        const double raw = raw_pace(turn, push, sample.speed);
        air_sum_ += raw;
        ++air_ticks_;
        average(raw, side);
    }

    // The Bar's fill and colour. W or S alone counts, and turning against a key fades the fill but is still judged.
    // The colour is this tick's: averaging it would carry a red through a landing or a trigger.
    void feed_bar(const SsjCmd &command, const TrainerSample &sample, double previous_yaw, bool continuous) {
        if (!samples_finite(command, sample) || !std::isfinite(command.forward) || sample.interrupted || !continuous
            || !std::isfinite(previous_yaw) || !supported_style(sample.style))
            return clear_bar();
        const bool active = !sample.grounded && !sample.on_ladder && sample.speed >= trainer_min_speed
                            && (command.side != 0 || command.forward != 0);
        if (active) reading.gain = trainer_bar_gain(sample.air_speed_gain, sample.air_best_gain);
        const double turn = turn_degrees(command.yaw, previous_yaw);
        const int key_side = (command.side > 0) - (command.side < 0);
        const int turn_sign = (turn > 0) - (turn < 0);
        const bool against = key_side && std::abs(turn) > trainer_turn_deadzone_degrees && turn_sign == key_side;
        const double push = air_push(sample);
        double bar = 0;
        if (active && !against && push > 0) {
            // Without A or D, the turn says which way: then the side it was on when the mouse is still.
            const int side = key_side ? key_side : turn_sign ? -turn_sign : bar_side_ ? bar_side_ : 1;
            if (side != bar_side_) clear_bar();
            bar_side_ = side;
            bar = push_bar(raw_pace(turn, push, sample.speed));
        } else {
            // The one ground tick of a hop holds the fill: only staying down or a tick off the keys lowers it.
            bar = ground_ticks_ == 1 ? bar_sum_ / smoothing_ : push_bar(0);
        }
        if (bar <= trainer_bar_empty) return;
        reading.bar = bar;
        reading.bar_side = bar_side_;
    }

public:
    static constexpr unsigned max_smoothing = trainer_max_smoothing;
    static constexpr uint32_t left_bit = ssj_in_moveleft, right_bit = ssj_in_moveright;
    double zone = 10;
    StrafeReading reading{.has_pace = false};

    unsigned smoothing() const { return smoothing_; }

    void set_smoothing(unsigned ticks) { smoothing_ = std::clamp(ticks, 1u, max_smoothing); }

    void reset() {
        const auto smoothing = smoothing_;
        const auto width = zone;
        *this = {};
        smoothing_ = smoothing;
        zone = width;
    }

    std::optional<double> take_landing() {
        const auto result = landed_;
        landed_.reset();
        return result;
    }

    void feed(const SsjCmd &command, const TrainerSample &sample) {
        const double previous_yaw = yaw_;
        const bool continuous = tick_ + 1 == sample.tick;
        yaw_ = command.yaw;
        tick_ = sample.tick;
        ground_ticks_ = sample.grounded ? ground_ticks_ + 1 : 0;
        feed_pace(command, sample, previous_yaw, continuous);
        feed_bar(command, sample, previous_yaw, continuous);
        reading.last_jump = last_jump_;
    }
};

// Presentation state has the same lifetime as its observed tick history. A seek
// skips that history, so no jump number or partial trainer window is presented
// until a start-zone or a full grounded reset supplies a known chain boundary.
struct MovementFeedback {
    SsjTracker ssj;
    JhudTracker jhud;
    std::string ssj_line;
    std::optional<float> ssj_gain;
    bool ssj_was_in_start = false, ssj_was_noclip = false;
    StrafeTrainer strafe_trainer;
    std::optional<StrafeReading> strafe_reading;
    unsigned strafe_ground_ticks = 0, history_ground_ticks = 0;
    bool incomplete_history = false;

    void reset(bool in_start = false, bool noclip = false, bool incomplete = false) {
        ssj.reset();
        jhud.reset();
        ssj_line.clear();
        ssj_gain.reset();
        strafe_trainer.reset();
        strafe_reading.reset();
        strafe_ground_ticks = history_ground_ticks = 0;
        ssj_was_in_start = in_start;
        ssj_was_noclip = noclip;
        incomplete_history = incomplete;
    }

    // A checkpoint or replay takeover moves the pre-state without discarding the hop chain.
    void moved(bool in_start, bool noclip) {
        strafe_trainer.reset();
        strafe_reading.reset();
        strafe_ground_ticks = 0;
        ssj_was_in_start = in_start;
        ssj_was_noclip = noclip;
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

inline int strafe_band(float percent) {
    return 2 - int(trainer_band(percent));
}
}  // namespace native
