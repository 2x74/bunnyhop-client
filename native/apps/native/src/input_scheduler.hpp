#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>

namespace native {

// SDL event stamps and simulation boundaries share one integer nanosecond clock.
class InputScheduler {
public:
    static constexpr uint64_t max_frame_ns = 250'000'000;
    uint64_t accumulator_ns = 0;
    uint64_t sim_ns = 0;
    bool capped = false;

    void reset(uint64_t now) {
        accumulator_ns = 0;
        sim_ns = now;
        last_frame_ns_ = now;
        capped = false;
    }

    // `speed`: game time per real time (a replay's playback speed, practice timescale). 1 is real time.
    void frame(uint64_t now, bool active, uint64_t tick_ns, double speed = 1, bool frames_mode = false) {
        const uint64_t elapsed = now - std::min(now, last_frame_ns_);
        frame_from_ns_ = std::min(now, last_frame_ns_);
        frame_now_ns_ = now;
        speed_ = speed > 0 ? speed : 1;
        last_frame_ns_ = std::max(now, last_frame_ns_);
        capped = active && !frames_mode && elapsed > max_frame_ns;
        if (active) {
            const uint64_t retained = frames_mode ? tick_ns : std::min(elapsed, max_frame_ns);
            accumulator_ns += uint64_t(std::llround(double(retained) * speed));
        }
        sim_ns = now - std::min(now, accumulator_ns);
    }

    uint64_t first_boundary(uint64_t tick_ns) const { return sim_ns + tick_ns; }

    // A tick of game time spans tick_ns / speed of real time: what take_tick advances sim_ns by.
    uint64_t real_tick_ns(uint64_t tick_ns) const { return real_ns(tick_ns); }

    // Before each tick at a speed other than 1 (web practice-mode/timescale.ts runTicks): the tick ends at
    // now - (accumulator - tick) / speed on the real clock, never before the last frame (after a change of speed the
    // leftover was gathered at the old one). At 1 the boundaries run on from sim_ns exactly as before.
    void place_tick(uint64_t tick_ns) {
        if (speed_ == 1) return;
        const uint64_t ahead = real_ns(accumulator_ns - std::min(accumulator_ns, tick_ns));
        const uint64_t end = std::max(frame_from_ns_, frame_now_ns_ - std::min(frame_now_ns_, ahead));
        sim_ns = end - std::min(end, real_ns(tick_ns));
    }

    bool due(uint64_t tick_ns) const { return accumulator_ns >= tick_ns; }

    void consume(uint64_t tick_ns) { accumulator_ns -= tick_ns; }

    double seconds() const { return double(accumulator_ns) / 1e9; }

private:
    uint64_t real_ns(uint64_t game_ns) const {
        return speed_ == 1 ? game_ns : uint64_t(std::llround(double(game_ns) / speed_));
    }

    uint64_t last_frame_ns_ = 0, frame_from_ns_ = 0, frame_now_ns_ = 0;
    double speed_ = 1;
};

}  // namespace native
