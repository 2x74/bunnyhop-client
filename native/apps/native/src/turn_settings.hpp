#pragma once
#include "native_input.hpp"
#include <nlohmann/json.hpp>

namespace native {

struct TurnSettings {
    static constexpr float default_yaw_speed = 210;
    static constexpr float default_angle_speed_key = 2;
    float yaw_speed = default_yaw_speed;
    float angle_speed_key = default_angle_speed_key;

    static TurnSettings from_settings(const nlohmann::json &settings) {
        return {settings.at("yawSpeed").get<float>(), settings.at("angleSpeedKey").get<float>()};
    }

    double rate(uint32_t buttons) const {
        const bool left = buttons & turn_left;
        const bool right = buttons & turn_right;
        if (left == right) {
            return 0;
        }
        const double direction = left ? 1 : -1;
        return direction * double(yaw_speed) * (buttons & turn_fast ? double(angle_speed_key) : 1);
    }

    double apply(Input &input, uint32_t buttons, double seconds, bool allowed) const {
        buttons |= input.pulse & turn_mask;
        input.pulse &= ~turn_mask;
        input.held = buttons & ~turn_mask;
        const double speed = allowed ? rate(buttons) : 0;
        if (speed != 0) {
            input.turn(speed, seconds);
            input.pulse |= buttons & turn_fast;
        }
        return speed;
    }
};

}  // namespace native
