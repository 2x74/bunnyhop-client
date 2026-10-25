#pragma once
// Strafe trainer: how fast you turned in the air, against the turn rate that
// gains the most speed at your current speed.
//
// In Source air movement the wish speed is capped at 30 (see ssj.hpp), so the
// most speed a tick can add comes from turning by atan(30 / speed) per tick:
// turn slower and you leave gain on the table, turn faster and the wish
// direction swings past the velocity and starts eating it. 100% is that ideal.
//
// Display only. Like the jump stats it reads the pre-tick state and the
// command already stepped, and feeds nothing back.
#include <cmath>
#include <optional>

namespace native {

class StrafeTrainer {
public:
    /** Air ticks averaged into one reading: 0.1 s at 100 tick. */
    static constexpr unsigned window = 10;
    /** Below this the ideal angle is meaningless (and atan(30/0) is 90°). */
    static constexpr float min_speed = 30.0f;

    /** One tick. |grounded| and |speed| are from before it, |yaw| is the command's, in degrees. */
    std::optional<float> tick(bool grounded, float speed, float yaw) {
        std::optional<float> reading;
        if (grounded) {
            sum_ = 0;
            ticks_ = 0;
        } else if (have_yaw_ && speed >= min_speed) {
            const float turned = std::fabs(std::remainder(yaw - last_yaw_, 360.0f));
            sum_ += turned / ideal_degrees(speed) * 100.0f;
            if (++ticks_ >= window) {
                reading = sum_ / float(ticks_);
                sum_ = 0;
                ticks_ = 0;
            }
        }
        last_yaw_ = yaw;
        have_yaw_ = true;
        return reading;
    }

    void reset() {
        sum_ = 0;
        ticks_ = 0;
        have_yaw_ = false;
    }

    /** Degrees per tick that gain the most speed at |speed| u/s. */
    static float ideal_degrees(float speed) {
        return float(std::atan(30.0 / double(speed)) * 180.0 / 3.14159265358979323846);
    }

private:
    float sum_ = 0, last_yaw_ = 0;
    unsigned ticks_ = 0;
    bool have_yaw_ = false;
};

/** 0: within 10% of ideal, 1: within 25%, 2: further off. */
inline int strafe_band(float percent) {
    const float off = std::fabs(percent - 100.0f);
    return off <= 10.0f ? 0 : off <= 25.0f ? 1 : 2;
}

}  // namespace native
