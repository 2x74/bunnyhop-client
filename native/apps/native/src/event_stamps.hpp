#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace native {

// Which SDL event times are on SDL_GetTicksNS's clock on this backend.
//
// - Windows: raw mouse events carry the raw-input thread's read time, spread over each batch. Raw keyboard events
//   (on while captured) carry the read time; message-loop keys carry the message clock, in whole milliseconds.
// - X11: relative motion is stamped in X server milliseconds, not SDL nanoseconds, so motion uses arrival time.
// - macOS, Wayland, X11 keys: stamped by SDL when the event is processed, close to arrival.
//
// A source whose stamps keep landing off the clock (in the future, or older than any hitch) falls back to arrival
// time for the session. Stamps that are merely old (a hitch's backlog) are kept; TimedInput::stamp places them.
class EventStamps {
public:
    enum Kind : size_t { kMotion = 0, kKeys = 1 };

    static constexpr uint32_t kOffClockLimit = 64;
    static constexpr uint64_t kFutureSlackNs = 1'000'000;
    static constexpr uint64_t kForeignClockNs = 10'000'000'000;

    struct Source {
        bool trusted = true;
        uint64_t off_clock = 0;
        uint32_t off_clock_in_row = 0;
        std::string_view reason;
    };

    void configure(std::string_view video_driver) {
        if (video_driver == "x11") {
            distrust(kMotion, "X11 relative motion is stamped in X server milliseconds");
        }
    }

    void begin_pump(uint64_t now) {
        // The oldest plausible event was produced just after the previous pump.
        backlog_floor_ns_ = last_pump_ns_;
        last_pump_ns_ = now;
    }

    // The event's own time if it is usable, else when it was read from SDL's queue.
    uint64_t time(Kind kind, uint64_t stamp, uint64_t received) {
        Source &source = sources_[kind];
        if (!source.trusted) {
            return received;
        }
        const bool future = stamp > received + kFutureSlackNs;
        const bool old = stamp < received && received - stamp > kForeignClockNs;
        const bool before_backlog = stamp < backlog_floor_ns_ && backlog_floor_ns_ - stamp > kForeignClockNs;
        const bool foreign = stamp == 0 || (old && before_backlog);
        if (!future && !foreign) {
            source.off_clock_in_row = 0;
            return stamp;
        }
        ++source.off_clock;
        if (++source.off_clock_in_row >= kOffClockLimit) {
            distrust(kind, "event times are not on SDL's clock");
        }
        return received;
    }

    const Source &source(Kind kind) const { return sources_[kind]; }

private:
    std::array<Source, 2> sources_{};
    uint64_t last_pump_ns_ = 0;
    uint64_t backlog_floor_ns_ = UINT64_MAX;

    void distrust(Kind kind, std::string_view reason) {
        sources_[kind].trusted = false;
        sources_[kind].reason = reason;
    }
};

}  // namespace native
