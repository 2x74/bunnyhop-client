#pragma once
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

enum class StrafeHint { less_deadtime, strafe_more, strafe_less, direction, unsupported };
enum class TrainerCue { ready, keys, direction, slow, good, fast, unsupported };

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
};

inline unsigned trainer_band(double pace, double width = 10) {
    const double off = std::abs(pace - trainer_target_pace);
    return off <= width ? 2 : off <= width * trainer_ok_span ? 1 : 0;
}

inline double trainer_position(double pace, int side, bool follow) {
    const double position = std::clamp(pace, 0., trainer_pace_max) / trainer_pace_max;
    return follow && side < 0 ? 1 - position : position;
}

inline HudLabel<32> trainer_text(const StrafeReading &reading) {
    HudLabel<32> text;
    if (!reading.has_pace)
        text.assign("—");
    else {
        const int pace = int(std::floor(reading.percent + .5));
        text.format("%d%s%%", pace, pace >= trainer_pace_max ? "+" : "");
    }
    return text;
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
    unsigned smoothing_ = 8;

    void clear() {
        size_ = 0;
        sum_ = 0;
    }

    void idle(TrainerCue cue, std::optional<StrafeHint> hint = {}) {
        clear();
        side_ = 0;
        reading = {0, hint, cue, 0, false};
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
        const auto cue = good ? TrainerCue::good : pace < trainer_target_pace ? TrainerCue::slow : TrainerCue::fast;
        const std::optional<StrafeHint> hint =
                good ? std::nullopt
                     : std::optional{pace < trainer_target_pace ? StrafeHint::strafe_more : StrafeHint::strafe_less};
        reading = {pace, hint, cue, side, true};
    }

public:
    static constexpr unsigned max_smoothing = trainer_max_smoothing;
    static constexpr uint32_t left_bit = ssj_in_moveleft, right_bit = ssj_in_moveright;
    double zone = 10;
    StrafeReading reading{0, {}, TrainerCue::ready, 0, false};

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
        if (!std::isfinite(sample.speed) || !std::isfinite(sample.dt) || !std::isfinite(sample.max_speed)
            || !std::isfinite(sample.air_accelerate) || !std::isfinite(command.yaw) || !std::isfinite(command.side)
            || sample.dt <= 0 || sample.interrupted || !continuous || !std::isfinite(previous_yaw)) {
            air_sum_ = 0;
            air_ticks_ = 0;
            return idle(TrainerCue::ready);
        }
        if (sample.style != "autohop" && sample.style != "legit" && sample.style != "scroll" && sample.style != "hsw")
            return idle(TrainerCue::unsupported, StrafeHint::unsupported);
        if (sample.grounded || sample.on_ladder || sample.jumped) {
            if (!sample.on_ladder && air_ticks_ >= trainer_landing_min_ticks) landed_ = air_sum_ / air_ticks_;
            air_sum_ = 0;
            air_ticks_ = 0;
        }
        if (sample.grounded || sample.on_ladder || sample.speed < trainer_min_speed) return idle(TrainerCue::ready);
        const int side = (command.side > 0) - (command.side < 0);
        if (!side) return idle(TrainerCue::keys, StrafeHint::less_deadtime);
        const double delta = std::fmod(std::fmod(command.yaw - previous_yaw + 540, 360) + 360, 360) - 180;
        if (std::abs(delta) > trainer_turn_deadzone_degrees && ((delta > 0) - (delta < 0)) == side)
            return idle(TrainerCue::direction, StrafeHint::direction);
        const double push = std::min(
                {double(air_wish_cap), sample.max_speed, sample.air_accelerate * sample.max_speed * sample.dt}
        );
        if (push <= 0) return idle(TrainerCue::ready);
        constexpr double degrees_per_radian = 180 / ssj_detail::pi;
        const double ideal = std::atan2(push, sample.speed) * degrees_per_radian;
        const double raw = std::min(trainer_pace_max, trainer_target_pace * std::abs(delta) / ideal);
        air_sum_ += raw;
        ++air_ticks_;
        average(raw, side);
    }
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

inline int strafe_band(float percent) {
    return 2 - int(trainer_band(percent));
}
}  // namespace native
