#pragma once
#include "freecam.hpp"
#include <string_view>

namespace native {

// Freecam, owned by the client loop.
struct FreeCameras {
    Freecam freecam;

    // !freecam or its bind. Returns why it can't turn on, if so.
    std::string_view toggle(const FreecamPlace &place, const FreeLookInput &controls) {
        if (freecam.active()) {
            freecam.end(controls);
            return {};
        }
        const auto refusal = freecam_unavailable(place);
        if (refusal.empty()) freecam.begin(controls);
        return refusal;
    }

    // Once a frame: freecam goes off where it can't stay on (a replay opened, a tutorial lesson started).
    void keep_available(const FreecamPlace &place, const FreeLookInput &controls) {
        if (freecam.active() && !freecam_unavailable(place).empty()) freecam.end(controls);
    }

    // Whether a camera flies now (the mouse and keys are its).
    bool flying() const { return freecam.active(); }

    // Wheel notches step a flying camera's speed instead of reaching a bind; returns false when none flies.
    bool wheel(double notches) {
        if (!flying()) return false;
        freecam.view().wheel(notches);
        return true;
    }

    // This frame's freecam line, in |extras|.
    template <class Extras>
    void hud(Extras &extras, const BindTable &binds) {
        const auto &codes = binds.codes("freecam");
        const std::string_view code = codes.empty() ? std::string_view() : std::string_view(codes.front());
        extras.freecam_line.assign(freecam.active() ? freecam.hud_line(code) : std::string_view());
    }

    // After the frame placed its own view in |eye| and |view|: a flying camera takes over (returns true).
    bool place(float eye[3], Input &view, const FreeLookKeys &keys, const Input &player, double seconds) {
        if (!freecam.active()) return false;
        freecam.view().match_mouse(player);
        freecam.view().place(eye, view, keys, seconds);
        return true;
    }
};

}  // namespace native
