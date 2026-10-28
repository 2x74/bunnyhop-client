#pragma once
#include <cstdint>
#include <utility>

namespace native {

// Keeps at most one finished frame waiting on the GPU (setting "limitQueuedFrames").
//
// With VSync off, GL drivers (Windows especially) queue several swapped frames, so the frame on screen was built
// from input one or more frames older than the newest. After swapping frame N the pacer waits for the fence placed
// after frame N-1's swap, then fences N, before the loop pumps input and builds N+1. The wait is capped so a stuck
// driver costs a frame, not the game.
template <class Gl> class FramePacer {
public:
    using Sync = decltype(std::declval<Gl &>().FenceSync(0u, 0u));

    static constexpr uint32_t kSyncGpuCommandsComplete = 0x9117;
    static constexpr uint32_t kSyncFlushCommandsBit = 0x1;
    static constexpr uint64_t kMaxWaitNs = 100'000'000;

    // Call right after SDL_GL_SwapWindow.
    void after_swap(Gl &gl, bool enabled) {
        if (!enabled) {
            release(gl);
            return;
        }
        if (previous_) {
            gl.ClientWaitSync(previous_, kSyncFlushCommandsBit, kMaxWaitNs);
            gl.DeleteSync(previous_);
        }
        previous_ = gl.FenceSync(kSyncGpuCommandsComplete, 0u);
    }

    // Before the GL context goes away, or when pacing is turned off.
    void release(Gl &gl) {
        if (previous_) {
            gl.DeleteSync(previous_);
        }
        previous_ = nullptr;
    }

private:
    // The fence after the last swapped frame.
    Sync previous_ = nullptr;
};

}  // namespace native
