#pragma once
// The bunny's bank into turns (web player/bunny/bank.ts): the view's yaw rate and the strafe key lean the whole body
// toward the turn about its hips, up to bank_max_degrees at speed in the air, about a third of that running on the
// ground, none standing. Only over the CS:S animations (`on`), eased in so content arriving mid-strafe brings it in
// smoothly. Exponential smoothing throughout, so the bank is the same at any frame rate.
#include <algorithm>
#include <cmath>
#include <limits>

namespace native_actor_anim {

constexpr double bank_max_degrees = 8;

class BodyBank {
public:
    // The bank now (degrees, + = leaning to the body's right).
    double bank = 0;

    // `on`: the CS:S animations pose the body. `motion` is the reduced-motion scale (1 = full).
    double
    update(double dt, double yaw, bool grounded, double speed, double sidemove, bool on, bool snap, double motion = 1) {
        if (snap || dt <= 0 || std::isnan(last_yaw_)) {
            last_yaw_ = yaw;
            if (snap) {
                rate_ = bank = 0;
                air_ = grounded ? 0 : 1;
                on_weight_ = on ? 1 : 0;
            }
            return bank;
        }
        double rate = wrap180(yaw - last_yaw_) / dt;
        last_yaw_ = yaw;
        if (std::abs(rate) > teleport_turn_degrees_per_second) rate = 0;
        rate_ += (rate - rate_) * (1 - std::exp(-rate_follow * dt));
        // Rises fast off the ground, falls slowly on it: a bhop touches the ground for one tick.
        air_ += ((grounded ? 0 : 1) - air_) * (1 - std::exp(-(grounded ? air_fall : air_rise) * dt));
        const double side = std::clamp(sidemove / full_sidemove, -1., 1.);
        on_weight_ += ((on ? 1 : 0) - on_weight_) * (1 - std::exp(-on_ease * dt));
        const double lean = std::clamp(
                -rate_ * degrees_per_turn_rate + side * degrees_per_strafe, -bank_max_degrees, bank_max_degrees
        );
        const double target =
                on_weight_ * lean * std::clamp(speed / full_speed, 0., 1.) * (ground_share + air_share * air_) * motion;
        bank += (target - bank) * (1 - std::exp(-bank_follow * dt));
        return bank;
    }

private:
    static constexpr double teleport_turn_degrees_per_second = 3000, rate_follow = 10, air_rise = 12, air_fall = 4;
    static constexpr double full_sidemove = 450, on_ease = 4, degrees_per_turn_rate = .018, degrees_per_strafe = 2.5;
    static constexpr double full_speed = 300, ground_share = .35, air_share = .65, bank_follow = 6;

    static double wrap180(double a) { return std::fmod(std::fmod(a + 180, 360.) + 360, 360.) - 180; }

    double rate_ = 0, air_ = 0, on_weight_ = 0, last_yaw_ = std::numeric_limits<double>::quiet_NaN();
};

}  // namespace native_actor_anim
