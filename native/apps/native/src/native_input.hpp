#pragma once
#include "bunnyhop_native.h"
#include <algorithm>
#include <array>
#include <span>
#include <cmath>
#include <chrono>
#include <string_view>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>

namespace native {
constexpr uint32_t attack = 1u, jump = 1u << 1, duck = 1u << 2;
constexpr uint32_t forward = 1u << 3, back = 1u << 4, use = 1u << 5;
constexpr uint32_t left = 1u << 9, right = 1u << 10, attack2 = 1u << 11;
constexpr uint32_t turn_left = 1u << 7, turn_right = 1u << 8;
constexpr uint32_t turn_fast = 1u << 6;
constexpr uint32_t turn_mask = turn_fast | turn_left | turn_right;
constexpr double max_turn_rate = 720.0 * 4.0;
constexpr uint32_t teleported = 1u, angles_changed = 1u << 4;
// m_yaw and m_pitch: view degrees per mouse count at sensitivity 1.
constexpr double kDegreesPerCount = 0.022;

// Held keys are supplied oldest first. One physical key bound to both directions still cancels.
inline uint32_t resolve_null_binds(std::span<const uint32_t> presses) {
    uint32_t bits = 0;
    for (const uint32_t press : presses)
        bits |= press;
    for (const uint32_t axis : {left | right, forward | back}) {
        if ((bits & axis) != axis)
            continue;
        for (auto press = presses.rbegin(); press != presses.rend(); ++press) {
            if (*press & axis) {
                bits = (bits & ~axis) | (*press & axis);
                break;
            }
        }
    }
    return bits;
}
inline bool null_binds_allowed(std::string_view style, bool practice) {
    return style != "scroll" || practice;
}

class NullBindPresses {
    struct Press {
        uint64_t code = 0;
        uint32_t bits = 0;
    };
    std::array<Press, 128> held_{};
    size_t count_ = 0;

  public:
    void clear() {
        count_ = 0;
    }
    void edge(std::string_view code, uint32_t bits, bool down) {
        uint64_t identity = 1469598103934665603ull;
        for (unsigned char character : code) {
            identity ^= character;
            identity *= 1099511628211ull;
        }
        for (size_t i = 0; i < count_; ++i) {
            if (held_[i].code != identity)
                continue;
            if (down)
                return;
            std::move(held_.begin() + i + 1, held_.begin() + count_, held_.begin() + i);
            --count_;
            return;
        }
        if (down && bits && count_ < held_.size())
            held_[count_++] = {identity, bits};
    }
    uint32_t resolve() const {
        std::array<uint32_t, 128> presses{};
        for (size_t i = 0; i < count_; ++i)
            presses[i] = held_[i].bits;
        return resolve_null_binds(std::span(presses.data(), count_));
    }
};

template <class Timeline> uint32_t null_bind_buttons(const Timeline &timeline, const NullBindPresses &legacy) {
    if (!timeline.timed())
        return legacy.resolve();
    std::array<uint32_t, 128> presses{};
    size_t count = 0;
    for (const auto &code : timeline.queue().keys) {
        if (count == presses.size())
            break;
        presses[count++] = timeline.binds().of(code);
    }
    return resolve_null_binds(std::span(presses.data(), count));
}

// Reset the wall-clock baseline along with accumulated simulation time. Work
// done before a restart/capture transition must never become catch-up ticks.
struct InputClock {
    using Clock = std::chrono::steady_clock;
    Clock::time_point last = Clock::now();
    void reset(Clock::time_point now = Clock::now()) { last = now; }
    double elapsed(Clock::time_point now) {
        const double seconds = std::max(0.0, std::chrono::duration<double>(now-last).count());
        last = std::max(last,now);
        return seconds;
    }
};

inline bool turn_binds_allowed(std::string_view style, bool practice) {
    return style != "scroll" || practice;
}

// Turnbinds in Legit Scroll keep the attempt local, including pre-start ticks.
struct TurnAdmission {
    bool local_only = false;
    void reset() { local_only = false; }
    bool observe(double rate, bool restricted_style = false) {
        const bool first = !local_only && rate != 0 && restricted_style;
        local_only |= first;
        return first;
    }
    bool allows_event(std::string_view type) const {
        return !local_only || (type != "beat" && type != "finish");
    }
};

// Keep fractional SDL deltas; recomputing from a double base avoids accumulating
// a float rounding error for every mouse report. Only SDL relative motion feeds this.
struct Input {
    double yaw_base = 0, yaw_counts = 0, pitch = 0, sensitivity = 2, vertical_sensitivity=2;
    bool separate_vertical=false,invert_y=false;
    uint32_t epoch=0,kind=1,frames=0,motion_events=0;
    uint32_t held = 0, pulse = 0;
    NullBindPresses null_presses;
    std::optional<uint32_t> sampled_epoch;
    // Match replay.ts norm360's two remainders, including its double rounding.
    static double normalize(double v) { return std::fmod(std::fmod(v,360.0)+360.0,360.0); }
    // A map or physics pitch (input-view.ts mapViewPitch): signed degrees first, so 357/358 look up 3/2 degrees
    // rather than clamping to straight down, then the view's ±89.
    static double view_pitch(double p) {
        double signed_p = std::fmod(p, 360.0);
        if (signed_p >= 180) {
            signed_p -= 360;
        }
        if (signed_p < -180) {
            signed_p += 360;
        }
        return std::clamp(signed_p, -89.0, 89.0);
    }
    double yaw() const { return normalize(yaw_base - yaw_counts * (sensitivity * 0.022)); }
    void set_yaw(double v,uint32_t reason=5) { yaw_base = normalize(v); yaw_counts = 0; ++epoch;kind=reason; }
    // v29 records frozen turn rates separately. Preserve provenance from any other rebase in this command.
    void turn(double rate, double dt) {
        if (!std::isfinite(rate) || !std::isfinite(dt) || rate == 0 || dt <= 0 ||
            std::abs(rate) > max_turn_rate || !std::isfinite(rate * dt)) return;
        yaw_base = normalize(yaw_base + rate * dt);
        kind = sampled_epoch == epoch ? 6u : kind | 128u;
        ++epoch;
        pulse |= rate > 0 ? turn_left : turn_right;
    }
    void set_sensitivity(double v) {
        if (v == sensitivity) {
            return;
        }
        const double at = yaw();
        sensitivity = v;
        set_yaw(at, 4);
    }
    void set_angles(double p, double y, uint32_t reason = 1) {
        pitch = view_pitch(p);
        set_yaw(y, reason);
    }
    // A report's pitch change in degrees, with the current inversion and (separate) vertical sensitivity.
    double pitch_degrees(double y) const {
        const double scale = separate_vertical ? vertical_sensitivity : sensitivity;
        return (invert_y ? -y : y) * scale * kDegreesPerCount;
    }
    void apply_report(double x, double p) {
        ++motion_events;
        yaw_counts += x;
        pitch = std::clamp(pitch + p, -89.0, 89.0);
    }
    void motion(double x, double y) {
        if (!std::isfinite(x) || !std::isfinite(y)) {
            return;
        }
        apply_report(x, pitch_degrees(y));
    }

    // ---- per-tick proration (Momentum's m_rawinput 2) ------------------
    //
    // SDL hands over mouse motion when it is polled, once per rendered
    // frame. Giving a frame's whole motion to the first tick after the poll
    // makes how a flick divides between ticks follow the frame rate: at 50
    // fps and 100 Hz one tick gets twenty counts and the next gets none.
    //
    // As in Momentum's m_rawinput 2, motion accumulates per frame and each
    // tick takes an even share of it by time: the part of the span from where
    // the previous tick's share ended to when this frame's motion arrived
    // that the tick covers. A tick that reaches the arrival takes the rest;
    // whatever a tick doesn't reach waits for the next one. Nothing is
    // invented or lost, only moved between ticks.
    //
    // Whole-report streams keep integer shares. Once fractional reports enter
    // a pending span, share that axis exactly even if its total is integral.
    double acc_x = 0, acc_y = 0;   // polled, not yet given to a tick
    uint32_t acc_events = 0;
    bool fractional_x = false, fractional_y = false;
    uint64_t arrival_ns = 0;       // when the newest poll handed it over
    uint64_t split_ns = 0;         // where the previous tick's share ended
    bool have_split = false;

    void accumulate(double x, double y) {
        if(!std::isfinite(x)||!std::isfinite(y))return;
        fractional_x |= x != std::floor(x); fractional_y |= y != std::floor(y);
        acc_x+=x;acc_y+=y;++acc_events;
    }
    // Marks everything accumulated so far as having arrived at |now_ns|.
    void arrived(uint64_t now_ns) { arrival_ns=now_ns; }

    // Gives the tick covering [start_ns, end_ns] its share.
    void take_tick(uint64_t start_ns, uint64_t end_ns) {
        if(!have_split||split_ns<start_ns){split_ns=start_ns;have_split=true;}
        double share=1;
        if(end_ns<arrival_ns&&arrival_ns>split_ns)
            share=end_ns<=split_ns?0:double(end_ns-split_ns)/double(arrival_ns-split_ns);
        split_ns=std::max(split_ns,end_ns);
        give(share);
    }

    // Gives everything waiting to the input now. Used when nothing is ticking
    // (paused, --frames) and by the render camera on a copy, so the view shows
    // the newest motion without waiting for a tick to claim it.
    void consume_all() { give(1); have_split=false; }

    void give(double share) {
        auto part=[&](double &acc, bool &fractional){
            double s=share>=1?acc:acc*share;
            if(share<1&&!fractional)s=std::round(s);
            acc-=s;if(share>=1)fractional=false;return s;
        };
        const double x=part(acc_x,fractional_x),y=part(acc_y,fractional_y);
        const uint32_t e=share>=1?acc_events:std::min(acc_events,uint32_t(std::lround(acc_events*share)));
        acc_events-=e;
        if(x==0&&y==0&&e==0)return;
        motion_events+=e;yaw_counts+=x;
        pitch = std::clamp(pitch + pitch_degrees(y), -89.0, 89.0);
    }

    double pending_counts() const { return acc_x; }

    void frame() {if(frames<std::numeric_limits<uint16_t>::max())++frames;}
    std::optional<BhLookSampleV2> look_sample() {
        const auto f=frames,e=motion_events;frames=motion_events=0;sampled_epoch=epoch;
        // SDL preserves trackpad fractional deltas. Never round those into invented integer mouse counts.
        if(!std::isfinite(yaw_counts)||std::abs(yaw_counts)>0x3fffffff)return std::nullopt;
        return BhLookSampleV2{yaw_base,sensitivity*.022,yaw_counts,epoch,kind,f,e,e};
    }
    void button(uint32_t bit, bool down) { if (down) held |= bit; else held &= ~bit; }
    // Every caller is a state reset — capture changed, run restarted, settings
    // reapplied — so motion from before it must not survive into the next tick.
    void clear() {
        held = 0;
        pulse = 0;
        null_presses.clear();
        acc_x = 0;
        acc_y = 0;
        acc_events = 0;
        frames = 0;
        motion_events = 0;
        fractional_x = false;
        fractional_y = false;
        arrival_ns = 0;
        split_ns = 0;
        have_split = false;
    }
    BhCmd command() {
        const uint32_t bits = held | pulse;
        pulse = 0;
        return {450.0f * (int(bool(bits & forward)) - int(bool(bits & back))),
                450.0f * (int(bool(bits & right)) - int(bool(bits & left))),
                float(yaw()), float(pitch), bits};
    }
    void events(const BhState &s) {
        if (s.events & teleported) set_angles(s.teleport_angles[0], s.teleport_angles[1],2);
        else if (s.events & angles_changed) set_angles(pitch + s.angle_change[0], yaw() + s.angle_change[1],3);
    }
};
template <class Timeline>
bool apply_null_binds(Input &input, const Timeline &timeline, bool enabled, std::string_view style, bool practice) {
    if (!enabled || !null_binds_allowed(style, practice))
        return false;
    input.held = null_bind_buttons(timeline, input.null_presses) & ~turn_mask;
    return true;
}
}
