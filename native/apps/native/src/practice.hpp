#pragma once
#include "hud_text.hpp"
#include "bunnyhop_native.h"
#include <algorithm>
#include <string>
#include <vector>

namespace native {
// Host-only v27 practice policy. The bridge owns snapshots; nothing here changes
// canonical movement, recorded input, replay simulation or ranked timer rules.
struct Practice {
    struct Checkpoint {
        uint32_t handle;
        std::string selected, style;
        uint32_t track;
    };

    bool mode = false, active = false, noclip = false, menu_open = false;
    std::string tool;
    BhNoclipState flight{};
    std::vector<Checkpoint> checkpoints;
    size_t current = 0;
    int64_t hinted_run = -1;

    bool key_allowed(const std::string &action, bool timed) const {
        // Noclip works mid-run in any mode: it stops the timer (bh_practice_enter).
        return action == "save" || action == "noclip" || !timed || active || menu_open;
    }

    void restart() {
        active = mode;
        noclip = false;
        tool.clear();
        hinted_run = -1;
    }

    void clear(BhContext *core) {
        if (core)
            for (const auto &cp : checkpoints)
                bh_practice_free(core, cp.handle);
        *this = Practice{};
    }

    void retain(Checkpoint cp) {
        checkpoints.push_back(std::move(cp));
        current = checkpoints.size() - 1;
    }

    void step(int delta) {
        if (!checkpoints.empty()) current = size_t(std::clamp(int(current) + delta, 0, int(checkpoints.size()) - 1));
    }

    size_t number() const { return checkpoints.empty() ? 0 : current + 1; }
};

inline std::string practice_unavailable(bool core, bool playback, bool room, bool tutorial, bool gauntlet) {
    if (!core) return "Load a map to use practice.";
    if (playback) return "Practice isn't available in the replay viewer.";
    if (room) return "Practice is for solo play, not servers.";
    if (tutorial) return "Practice isn't available in the tutorial.";
    if (gauntlet) return "No practice during a gauntlet.";
    return {};
}

// Run reset/stop must always pass so pending service replies can be invalidated.
inline bool practice_allows_event(bool active, const std::string &type) {
    return !active || (type != "beat" && type != "finish");
}

template <class Hud>
void draw_checkpoint_menu(Hud &hud, float /*width*/, float height, const Practice &practice, bool keep_velocity) {
    const float x = 26;
    const float y = height * .30f;
    constexpr std::array<float, 4> cream = {.94f, .91f, .86f, 1};
    constexpr std::array<float, 4> dim = {.63f, .65f, .70f, 1};
    constexpr std::array<float, 4> amber = {1, .71f, .24f, 1};
    hud.overlay_rect(x - 10, y - 8, 320, 220, {.03f, .03f, .05f, .8f});
    hud.overlay_text(x, y, "Checkpoints", 19, cream);
    HudLabel<96> label;
    label.format("1. Save checkpoint (%zu/100)", std::min(size_t(100), practice.checkpoints.size() + 1));
    hud.overlay_text(x, y + 34, label.view(), 14, cream);
    label.format("2. Teleport to checkpoint (%zu)", std::max(size_t(1), practice.number()));
    hud.overlay_text(x, y + 56, label.view(), 14, practice.checkpoints.empty() ? dim : cream);
    hud.overlay_text(x, y + 78, "3. Previous", 14, practice.number() <= 1 ? dim : cream);
    hud.overlay_text(x, y + 100, "4. Next", 14, practice.number() >= practice.checkpoints.size() ? dim : cream);
    label.format("5. Noclip: %s", practice.noclip ? "on" : "off");
    hud.overlay_text(x, y + 122, label.view(), 14, cream);
    label.format("6. Keep speed: %s", keep_velocity ? "on" : "off");
    hud.overlay_text(x, y + 144, label.view(), 14, cream);
    hud.overlay_text(x, y + 166, "0. Close", 14, cream);
    hud.overlay_text(x, y + 196, "Teleport / noclip makes a run practice.", 11, amber);
}
}  // namespace native
