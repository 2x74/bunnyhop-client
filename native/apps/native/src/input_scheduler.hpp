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

    void frame(uint64_t now, bool active, uint64_t tick_ns, double speed = 1, bool frames_mode = false) {
        const uint64_t elapsed = now - std::min(now, last_frame_ns_);
        last_frame_ns_ = std::max(now, last_frame_ns_);
        capped = active && !frames_mode && elapsed > max_frame_ns;
        if (active) {
            const uint64_t retained = frames_mode ? tick_ns : std::min(elapsed, max_frame_ns);
            accumulator_ns += uint64_t(std::llround(double(retained) * speed));
        }
        sim_ns = now - std::min(now, accumulator_ns);
    }

    uint64_t first_boundary(uint64_t tick_ns) const { return sim_ns + tick_ns; }

    bool due(uint64_t tick_ns) const { return accumulator_ns >= tick_ns; }

    void consume(uint64_t tick_ns) { accumulator_ns -= tick_ns; }

    double seconds() const { return double(accumulator_ns) / 1e9; }

private:
    uint64_t last_frame_ns_ = 0;
};

}  // namespace native
