#pragma once
#include "gfx_types.hpp"
#include <cstdint>
#include <utility>

namespace native {

// Keeps at most one finished frame waiting on the GPU (setting "limitQueuedFrames").
//
// With VSync off, GL drivers (Windows especially) queue several swapped frames, so the frame on screen was built
// from input one or more frames older than the newest. After swapping frame N the pacer waits for the fence placed
// after frame N-1's swap, then fences N, before the loop pumps input and builds N+1. The wait is capped so a stuck
// driver costs a frame, not the game.
template <class Context>
class FramePacer {
public:
    using Sync = decltype(std::declval<Context &>().signal());

    static constexpr uint64_t kMaxWaitNs = 100'000'000;

    // Call right after the presenter swaps.
    void after_swap(Context &context, bool enabled) {
        if (!enabled) {
            release(context);
            return;
        }
        if (pending_) {
            context.wait(previous_, kMaxWaitNs, true);
            context.destroy(previous_);
        }
        previous_ = context.signal();
        pending_ = true;
    }

    // Before the graphics context goes away, or when pacing is turned off.
    void release(Context &context) {
        if (pending_) {
            context.destroy(previous_);
        }
        previous_ = {};
        pending_ = false;
    }

private:
    // The fence after the last swapped frame.
    Sync previous_{};
    bool pending_ = false;
};

}  // namespace native
