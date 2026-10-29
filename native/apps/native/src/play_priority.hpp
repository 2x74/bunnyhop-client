#pragma once

namespace native {

// Windows settings that help steady frame pacing, held only while the player is in the game with the mouse
// captured, and given back in menus, replays' cursor mode and when the window loses focus:
// - a 1 ms system timer, for the waits drivers and the system make (SDL's precise frame limiter already sleeps on a
//   high-resolution waitable timer);
// - no power throttling (EcoQoS), which otherwise slows a process the system thinks is in the background and
//   coarsens its timers;
// - the multimedia scheduler's "Games" class for the thread that runs the frame loop.
// Each one that Windows refuses is skipped and logged. Elsewhere this does nothing.
class PlayPriority {
public:
    PlayPriority() = default;

    ~PlayPriority() { update(false); }

    PlayPriority(const PlayPriority &) = delete;
    PlayPriority &operator=(const PlayPriority &) = delete;

    // Call from the frame-loop thread once per frame; work happens only when `playing` changes.
    void update(bool playing) {
        if (playing == active_) return;
        active_ = playing;
        if (playing)
            begin();
        else
            end();
    }

    bool active() const { return active_; }

private:
    bool active_ = false;

#ifdef _WIN32
    bool timer_ = false;
    void *mmcss_ = nullptr;

    void begin();
    void end();
#else
    void begin() {}

    void end() {}
#endif
};

}  // namespace native
