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
// Where the Bar look's green and amber end, in on-pace zones from 100%, and the average below which its track is empty.
inline constexpr unsigned trainer_bar_good_span = 3;
inline constexpr unsigned trainer_bar_ok_span = 6;
inline constexpr double trainer_bar_empty = 1e-6;
inline constexpr double trainer_bar_fill_steps = 1000;

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

inline TrainerBarBand trainer_bar_band(double value, double width) {
    const double off = std::abs(value - trainer_target_pace);
    if (off <= width) return TrainerBarBand::perfect;
    if (off <= width * trainer_bar_good_span) return TrainerBarBand::good;
    if (off <= width * trainer_bar_ok_span) return TrainerBarBand::ok;
    return value >= trainer_target_pace ? TrainerBarBand::high : TrainerBarBand::low;
}

// What the Bar look draws for a reading. Turning right (D) fills from the left, turning left (A) from the right.
struct TrainerBarView {
    double fill = 0;
    bool from_left = true;
    std::optional<TrainerBarBand> band;
};

inline TrainerBarView trainer_bar_view(const StrafeReading &reading, double width) {
    const std::optional<double> value = reading.bar        ? reading.bar
                                        : reading.has_pace ? std::optional{reading.percent}
                                                           : std::nullopt;
    TrainerBarView view;
    view.from_left = (reading.bar ? reading.bar_side : reading.side) >= 0;
    if (!value) return view;
    view.fill = std::floor(trainer_bar_fill(*value) * trainer_bar_fill_steps + .5) / trainer_bar_fill_steps;
    view.band = trainer_bar_band(*value, width);
    return view;
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

    void publish_bar(double bar) {
        reading.last_jump = last_jump_;
        if (bar <= trainer_bar_empty) return;
        reading.bar = bar;
        reading.bar_side = bar_side_;
    }

    void idle(TrainerCue cue, std::optional<StrafeHint> hint = {}) {
        clear();
        side_ = 0;
        // The one ground tick of a hop holds the Bar: only staying down or a tick off the keys lowers it.
        const double bar = ground_ticks_ == 1 ? bar_sum_ / smoothing_ : push_bar(0);
        reading = {0, hint, cue, 0, false, {}, 0, {}};
        publish_bar(bar);
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
        reading = {pace, hint, cue, side, true, {}, 0, {}};
        if (side != bar_side_) clear_bar();
        bar_side_ = side;
        publish_bar(push_bar(raw));
    }

public:
    static constexpr unsigned max_smoothing = trainer_max_smoothing;
    static constexpr uint32_t left_bit = ssj_in_moveleft, right_bit = ssj_in_moveright;
    double zone = 10;
    StrafeReading reading{0, {}, TrainerCue::ready, 0, false, {}, 0, {}};

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
        if (!std::isfinite(sample.speed) || !std::isfinite(sample.dt) || !std::isfinite(sample.max_speed)
            || !std::isfinite(sample.air_accelerate) || !std::isfinite(command.yaw) || !std::isfinite(command.side)
            || sample.dt <= 0 || sample.interrupted || !continuous || !std::isfinite(previous_yaw)) {
            air_sum_ = 0;
            air_ticks_ = 0;
            clear_bar();
            return idle(TrainerCue::ready);
        }
        if (sample.style != "autohop" && sample.style != "legit" && sample.style != "scroll" && sample.style != "hsw") {
            clear_bar();
            return idle(TrainerCue::unsupported, StrafeHint::unsupported);
        }
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
