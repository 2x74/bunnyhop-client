#pragma once
#include "native_input.hpp"
#include "hud_text.hpp"
#include "semantic_palette.hpp"

namespace native {
struct JumpReading {
    unsigned chain = 0;
    double speed = 0;
    double gain = 0;
};

class JumpHud {
    static constexpr unsigned chain_ground_ticks = 10;
    bool air_ = false;
    unsigned chain_ = 0, ground_ticks_ = 0, good_ = 0, total_ = 0;
    double last_speed_ = 0, last_sync_ = 0;
    float yaw_ = NAN;

    void land() { last_sync_ = total_ ? 100. * good_ / total_ : 0; }

public:
    void reset() { *this = {}; }

    double sync() const { return air_ && total_ ? 100. * good_ / total_ : last_sync_; }

    std::optional<JumpReading> feed(const BhCmd &command, const BhState &state) {
        if (air_ && !state.grounded && std::isfinite(yaw_)) {
            double delta = double(command.yaw) - yaw_;
            if (delta > 180)
                delta -= 360;
            else if (delta < -180)
                delta += 360;
            if (delta != 0) {
                ++total_;
                if ((delta > 0 && command.side < 0) || (delta < 0 && command.side > 0)) ++good_;
            }
        }
        yaw_ = command.yaw;
        if (state.events & jump) {
            if (air_) land();
            const bool chained = chain_ > 0 && ground_ticks_ < chain_ground_ticks;
            chain_ = chained ? chain_ + 1 : 1;
            const double speed = std::sqrt(
                    double(state.velocity[0]) * state.velocity[0] + double(state.velocity[1]) * state.velocity[1]
            );
            const JumpReading result{chain_, speed, chained ? speed - last_speed_ : 0};
            last_speed_ = speed;
            air_ = true;
            good_ = total_ = ground_ticks_ = 0;
            return result;
        }
        if (state.grounded) {
            if (air_) {
                land();
                air_ = false;
            }
            if (++ground_ticks_ >= chain_ground_ticks) chain_ = 0;
        }
        return std::nullopt;
    }
};

inline SemanticColor jump_sync_color(double sync, const SemanticPalette &palette) {
    const double rounded = std::floor(sync + .5);
    constexpr double good_sync = 85, near_sync = 65;
    return rounded >= good_sync ? palette.gain : rounded >= near_sync ? palette.sync : palette.loss;
}

inline HudLabel<32> jump_gain_text(double gain) {
    HudLabel<32> result;
    result.format("%s%.0f", gain > 0 ? "+" : "-", std::floor(std::abs(gain) + .5));
    return result;
}
}  // namespace native
