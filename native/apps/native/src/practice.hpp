#pragma once
#include "hud_text.hpp"
#include "bunnyhop_native.h"
#include "infinite_flight.hpp"
#include <algorithm>
#include <string>
#include <vector>

namespace native {
// The bridge keeps at most this many checkpoints (practice.rs MAX_CHECKPOINTS, as on the web). Saving past it, or
// past its byte budget, drops the oldest.
constexpr size_t max_checkpoints = 1000;

// The bridge owns snapshots, replay paths and timer rules for practice and Segmented.
struct Practice {
    struct Checkpoint {
        uint32_t handle;
        std::string selected, style;
        uint32_t track;
    };

    bool mode = false, active = false, noclip = false, menu_open = false;
    bool segmented = false;
    int segment_loads = -1;
    HudLabel<80> segment_label;
    std::string tool;
    BhNoclipState flight{};
    // Infinite's noclip flies in the core and isn't practice; it lives here because the same key and menu drive it.
    InfiniteFlight infinite_flight;
    std::vector<Checkpoint> checkpoints;
    size_t current = 0;
    int64_t hinted_run = -1;

    bool key_allowed(const std::string &action, bool timed) const {
        // Noclip works mid-run in any mode: it stops the timer (bh_practice_enter, or Infinite's first flight tick).
        return action == "save" || (!segmented && action == "noclip") || !timed || active || menu_open
               || (segmented && (action == "tele" || action == "prev" || action == "next"));
    }

    void segment_status(int loads) {
        const bool clean = !active && loads >= 0;
        if (segmented == clean && segment_loads == loads) return;
        segmented = clean;
        segment_loads = loads;
        segment_label.assign(clean ? "Segmented" : "");
        if (clean && loads > 0) segment_label.format("Segmented · %d load%s", loads, loads == 1 ? "" : "s");
    }

    void restart() {
        active = mode;
        segmented = false;
        segment_loads = -1;
        segment_label.assign("");
        noclip = false;
        infinite_flight.restart();
        tool.clear();
        hinted_run = -1;
    }

    // Drops the checkpoints and practice state. The attempt itself goes on (a room join, a gauntlet, a replay), so
    // what it flew stays with it until it restarts, as the website's PracticeAttempt only resets with the attempt.
    void clear(BhContext *core) {
        if (core)
            for (const auto &cp : checkpoints)
                bh_practice_free(core, cp.handle);
        const auto flight = infinite_flight;
        *this = Practice{};
        infinite_flight = flight;
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

// Rooms allow practice: the others see a practice tag, and a practice attempt is never submitted.
inline std::string practice_unavailable(bool core, bool playback, bool tutorial, bool gauntlet) {
    if (!core) return "Load a map to use practice.";
    if (playback) return "Practice isn't available in the replay viewer.";
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
    hud.overlay_text(x, y, practice.segmented ? "Segmented checkpoints" : "Checkpoints", 19, cream);
    HudLabel<96> label;
    label.format(
            "1. Save checkpoint (%zu/%zu)", std::min(max_checkpoints, practice.checkpoints.size() + 1), max_checkpoints
    );
    hud.overlay_text(x, y + 34, label.view(), 14, cream);
    label.format("2. Teleport to checkpoint (%zu)", std::max(size_t(1), practice.number()));
    hud.overlay_text(x, y + 56, label.view(), 14, practice.checkpoints.empty() ? dim : cream);
    hud.overlay_text(x, y + 78, "3. Previous", 14, practice.number() <= 1 ? dim : cream);
    hud.overlay_text(x, y + 100, "4. Next", 14, practice.number() >= practice.checkpoints.size() ? dim : cream);
    label.format("5. Noclip: %s", practice.noclip || practice.infinite_flight.on() ? "on" : "off");
    hud.overlay_text(x, y + 122, label.view(), 14, cream);
    label.format("6. Keep speed: %s", practice.segmented ? "always" : keep_velocity ? "on" : "off");
    hud.overlay_text(x, y + 144, label.view(), 14, cream);
    hud.overlay_text(x, y + 166, "0. Close", 14, cream);
    hud.overlay_text(
            x,
            y + 196,
            practice.segmented ? "Teleport rewinds timer / replay. Noclip is practice."
                               : "Teleport / noclip makes a run practice.",
            11,
            practice.segmented ? cream : amber
    );
}
}  // namespace native
