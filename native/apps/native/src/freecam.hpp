#pragma once
// Freecam (!freecam, !fc, !freelook; an unbound Settings → Keys bind): the camera leaves your body and flies through
// walls while the body keeps simulating and the timer keeps running. Turning it off snaps the camera back.
//
// A run stays ranked because every command the body gets while the camera flies is one a player who lets go of
// everything sends, the same contract as the website's (web freecam.ts):
//
//   R1 neutral body       neutral_command(): forward 0, side 0, buttons 0, the counted view unchanged
//   R2 no view change     InputTimeline::divert takes the mouse before the counted view, the timed queue and the stats
//   R3 no carried input   InputTimeline::release_until_keyup on entry and exit
//   R4 nothing set        the camera never moves, teleports or sets anything in the core
//   R5 only where R1-R3 hold: freecam_unavailable()
#include "free_look.hpp"
#include "hud_layout.hpp"
#include "hud_text.hpp"
#include "input_timeline.hpp"
#include <algorithm>
#include <array>
#include <set>
#include <string>
#include <string_view>

namespace native {

struct FreecamPlace {
    bool map_loaded = false;
    bool tutorial = false;
    bool replay = false;
};

// Why freecam can't turn on here (one line for a toast), or nothing.
inline std::string_view freecam_unavailable(const FreecamPlace &place) {
    if (!place.map_loaded) return "Load a map to use freecam.";
    if (place.tutorial) return "Freecam isn't available in the tutorial.";
    if (place.replay) return "The replay viewer has its own free camera.";
    return {};
}

// Bound actions that would act through the body: they do nothing while the camera flies. Restarts and style switches
// still work, and end it.
inline bool freecam_blocks_action(std::string_view action) {
    static constexpr std::array<std::string_view, 21> blocked = {
            "inspect",    "setStart", "clearStart", "thirdPerson", "practice",  "noclip",     "cpSave",
            "cpTeleport", "cpPrev",   "cpNext",     "giveUsp",     "giveGlock", "gunMenu",    "slot1",
            "slot2",      "slot3",    "lastWeapon", "drop",        "reload",    "nextWeapon", "prevWeapon"
    };
    return std::find(blocked.begin(), blocked.end(), action) != blocked.end();
}

// R1: the command of a player who let go of everything. No movement and no buttons (jump, duck, use, attack, turn
// binds, weapon slot, drop, reload and give bits), at the counted view, which only the sim itself still turns (a
// teleport or a rotating platform, as for a still mouse). It equals Input::command() with nothing held or pressed.
inline BhCmd neutral_command(Input &input) {
    input.held = 0;
    input.pulse = 0;
    input.w_release.reset();
    return {0, 0, float(input.yaw()), float(input.pitch), 0};
}

class Freecam {
public:
    bool active() const { return active_; }

    FreeLook &view() { return view_; }

    // R2, R3: the mouse turns the camera and the keys fly it, starting from the view on screen.
    void begin(const FreeLookInput &controls) {
        if (active_) return;
        controls.take(view_);
        active_ = true;
    }

    // R3: the keys held while flying let go; the mouse turns the view again.
    void end(const FreeLookInput &controls) {
        if (!active_) return;
        active_ = false;
        controls.give_back();
    }

    // The HUD's line in the practice slot: "Freecam · 500 u/s · <bind or !freecam> to go back". Rebuilt only when it
    // changes.
    std::string_view hud_line(std::string_view bound_code) {
        const double speed = view_.speed_ups();
        if (speed != line_speed_ups_ || bound_code != line_code_.view()) {
            line_speed_ups_ = speed;
            line_code_.assign(bound_code);
            const std::string back = bound_code.empty() ? std::string("!freecam") : hud_key_label(bound_code);
            line_.format("Freecam \xc2\xb7 %.0f u/s \xc2\xb7 %s to go back", speed, back.c_str());
        }
        return line_.view();
    }

private:
    FreeLook view_;
    bool active_ = false;
    HudLabel<96> line_;
    HudLabel<48> line_code_;
    double line_speed_ups_ = -1;
};

}  // namespace native
