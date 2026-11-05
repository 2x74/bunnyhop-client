#pragma once
// The run's last moments before a cut (a seek, an export's first frame). The smoothed cameras and the bunny pre-roll
// through them, so they arrive where continuous playback would have them instead of snapping and easing in from rest
// (web viewer/cameras.ts CameraRig.preroll and player/model.ts PlayerModel.preroll). A teleport cuts the past short:
// nothing before it is played.
#include "bunnyhop_native.h"
#include <cmath>
#include <vector>

namespace native {

constexpr double replay_preroll_seconds = .6;

struct PrerollFrame {
    BhSnapshot snapshot{};
    BhCmd view{};
};

// Steps the loaded replay from replay_preroll_seconds before `tick` up to it and returns those ticks (`tick` itself
// excluded). The replay is left at `tick`, or wherever reading stopped: seek it to `tick` afterwards.
inline std::vector<PrerollFrame> gather_replay_preroll(BhContext *core, uint32_t tick, double tick_seconds) {
    constexpr uint32_t teleported_event = 1;
    std::vector<PrerollFrame> frames;
    if (!core || !(tick_seconds > 0)) return frames;
    const auto span = uint32_t(std::lround(replay_preroll_seconds / tick_seconds));
    const uint32_t from = tick > span ? tick - span : 0;
    PrerollFrame frame;
    if (from >= tick || !bh_replay_seek(core, from, &frame.snapshot)) return frames;
    frames.reserve(span);
    while (frame.snapshot.player.tick < tick) {
        if (frame.snapshot.player.events & teleported_event) frames.clear();
        bh_last_command(core, &frame.view);
        frames.push_back(frame);
        if (!bh_replay_step(core, &frame.snapshot)) return {};
    }
    // A teleport onto the cut itself: there's no run before it to play.
    if (frame.snapshot.player.events & teleported_event) frames.clear();
    return frames;
}

}  // namespace native
