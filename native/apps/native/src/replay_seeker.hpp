#pragma once
// A replay seek spread over frames. The first jump into a part of a replay that hasn't played yet steps every tick up
// to there (bh_replay_seek_toward keeps keyframes for the next time): about four seconds on a 20-minute run of a busy
// map and minutes on an 8-hour one. The frame loop keeps drawing and taking input while it goes on.
#include "bunnyhop_native.h"
#include <chrono>
#include <cstdint>
#include <optional>

namespace native {

class ReplaySeeker {
public:
    // Ticks per core call: a few milliseconds on the busiest maps (about 40 us a tick), so the budget holds.
    static constexpr uint32_t slice_ticks = 64;
    static constexpr std::chrono::milliseconds frame_budget{20};

    // Seek to `tick`, first stepping to `approach` (where the camera pre-roll starts).
    void start(uint32_t tick, uint32_t approach) {
        target_ = tick;
        approach_ = approach;
    }

    void cancel() { target_.reset(); }

    bool seeking() const { return target_.has_value(); }

    // Steps toward the approach for up to frame_budget. Returns the tick to finish the seek at once the approach is
    // reached, or on a core error (finishing the seek reports it).
    std::optional<uint32_t> advance(BhContext *core) {
        if (!target_) return std::nullopt;
        const auto deadline = std::chrono::steady_clock::now() + frame_budget;
        BhSnapshot snapshot{};
        do {
            if (bh_replay_seek_toward(core, approach_, slice_ticks, &snapshot) != 2) return finish();
        } while (std::chrono::steady_clock::now() < deadline);
        return std::nullopt;
    }

private:
    std::optional<uint32_t> target_;
    uint32_t approach_ = 0;

    std::optional<uint32_t> finish() {
        const auto tick = target_;
        target_.reset();
        return tick;
    }
};

}  // namespace native
