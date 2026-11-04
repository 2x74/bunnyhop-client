#pragma once
#include "input_binds.hpp"
#include "input_timeline.hpp"
#include "native_input.hpp"
#include "replay_camera.hpp"
#include <algorithm>
#include <cmath>
#include <set>
#include <string>
#include <string_view>

namespace native {

class FreeLook;

// The client's input that a free camera takes over while it is on.
struct FreeLookInput {
    InputTimeline &timeline;
    Input &input;
    std::set<std::string> &held_codes;

    // R2: the mouse turns |camera|. R3: the keys held now let go.
    void take(FreeLook &camera) const;

    // The mouse turns the view again, and the keys held while flying let go.
    void give_back() const {
        timeline.divert(nullptr);
        timeline.release_until_keyup(input, held_codes);
    }
};

// What flies a free camera this frame: the movement binds held, and Shift (faster) or Alt (slower) unless the player
// bound them to a movement key, which then flies instead (web freecam.ts freeIntentFromCodes).
struct FreeLookKeys {
    uint32_t held = 0;
    bool fast = false;
    bool slow = false;
};

template <class Codes>
FreeLookKeys free_look_keys(const BindTable &binds, const Codes &held_codes) {
    const auto modifier = [&](std::string_view code) {
        const std::string key(code);
        return held_codes.contains(key) && !binds.of(key);
    };
    return {binds.held(held_codes),
            modifier("ShiftLeft") || modifier("ShiftRight"),
            modifier("AltLeft") || modifier("AltRight")};
}

// The base speed after |notches| wheel notches (up is faster), clamped and rounded to whole units like the website's
// (viewer/cameras.ts freeSpeedStep).
inline double free_look_speed_step(double speed_ups, double notches) {
    constexpr double speed_factor_per_notch = 1.25;
    constexpr double slowest_ups = 100;
    constexpr double fastest_ups = 3200;
    return std::round(std::clamp(speed_ups * std::pow(speed_factor_per_notch, notches), slowest_ups, fastest_ups));
}

// A camera that flies on the player's movement keys and turns at their mouse settings: freecam and room spectating's
// free look (web viewer/cameras.ts FreeCam). It keeps its own view in |mouse()|, which InputTimeline::divert feeds, so
// it never turns the player's counted view.
class FreeLook {
public:
    static constexpr double base_speed_ups = 500;
    // As far as a map's coordinates go (protocol.ts WORLD_LIMIT).
    static constexpr float world_limit_units = 16303;

    // The next place() starts from the view on screen then.
    void start() { started_ = false; }

    bool started() const { return started_; }

    Input &mouse() { return mouse_; }

    double speed_ups() const { return speed_ups_; }

    void wheel(double notches) { speed_ups_ = free_look_speed_step(speed_ups_, notches); }

    // The player's sensitivity, vertical sensitivity and invert turn the camera too.
    void match_mouse(const Input &player) {
        mouse_.set_sensitivity(player.sensitivity);
        mouse_.vertical_sensitivity = player.vertical_sensitivity;
        mouse_.separate_vertical = player.separate_vertical;
        mouse_.invert_y = player.invert_y;
    }

    // Flies for |seconds| and shows the camera: |eye| and |view| hold this frame's view on the way in (where the first
    // frame starts) and the camera's on the way out.
    void place(float eye[3], Input &view, const FreeLookKeys &keys, double seconds) {
        if (!started_) begin_at(eye, view);
        mouse_.held = keys.held;
        camera_.move(mouse_, seconds, keys.fast, keys.slow, speed_ups_);
        for (int axis = 0; axis < 3; ++axis) {
            camera_.position[axis] = std::clamp(camera_.position[axis], -world_limit_units, world_limit_units);
            eye[axis] = camera_.position[axis];
        }
        view.set_angles(camera_.pitch, camera_.yaw, 5);
    }

private:
    ReplayCamera camera_;
    Input mouse_;
    double speed_ups_ = base_speed_ups;
    bool started_ = false;

    void begin_at(const float eye[3], const Input &view) {
        mouse_.clear();
        mouse_.set_angles(view.pitch, view.yaw());
        camera_.set_mode("free");
        camera_.position = {eye[0], eye[1], eye[2]};
        camera_.yaw = view.yaw();
        camera_.pitch = view.pitch;
        camera_.initialized = true;
        started_ = true;
    }
};

inline void FreeLookInput::take(FreeLook &camera) const {
    timeline.release_until_keyup(input, held_codes);
    camera.match_mouse(input);
    camera.start();
    timeline.divert(&camera.mouse());
}

}  // namespace native
