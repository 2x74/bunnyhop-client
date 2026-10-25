#pragma once
#include "bunnyhop_native.h"
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>

namespace native {
constexpr uint32_t attack = 1u, jump = 1u << 1, duck = 1u << 2;
constexpr uint32_t forward = 1u << 3, back = 1u << 4, use = 1u << 5;
constexpr uint32_t left = 1u << 9, right = 1u << 10, attack2 = 1u << 11;
constexpr uint32_t teleported = 1u, angles_changed = 1u << 4;

// Keep fractional SDL deltas; recomputing from a double base avoids accumulating
// a float rounding error for every mouse report. Only SDL relative motion feeds this.
struct Input {
    double yaw_base = 0, yaw_counts = 0, pitch = 0, sensitivity = 2, vertical_sensitivity=2;
    bool separate_vertical=false;
    uint32_t epoch=0,kind=1,frames=0,motion_events=0;
    uint32_t held = 0, pulse = 0;
    // Match replay.ts norm360's two remainders, including its double rounding.
    static double normalize(double v) { return std::fmod(std::fmod(v,360.0)+360.0,360.0); }
    double yaw() const { return normalize(yaw_base - yaw_counts * (sensitivity * 0.022)); }
    void set_yaw(double v,uint32_t reason=5) { yaw_base = normalize(v); yaw_counts = 0; ++epoch;kind=reason; }
    void set_sensitivity(double v) { if(v==sensitivity)return;const double at=yaw(); sensitivity=v; set_yaw(at,4); }
    void set_angles(double p, double y,uint32_t reason=1) { pitch = std::clamp(p, -89.0, 89.0); set_yaw(y,reason); }
    void motion(double x, double y) {
        if(!std::isfinite(x)||!std::isfinite(y))return;
        ++motion_events;yaw_counts += x;
        pitch = std::clamp(pitch + y * (separate_vertical?vertical_sensitivity:sensitivity) * 0.022, -89.0, 89.0);
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
    // Mouse counts stay integral, because BhLookSample has to: a share of
    // whole counts is rounded and the remainder stays queued. Fractional
    // (trackpad) motion is shared exactly.
    double acc_x = 0, acc_y = 0;   // polled, not yet given to a tick
    uint32_t acc_events = 0;
    uint64_t arrival_ns = 0;       // when the newest poll handed it over
    uint64_t split_ns = 0;         // where the previous tick's share ended
    bool have_split = false;

    void accumulate(double x, double y) {
        if(!std::isfinite(x)||!std::isfinite(y))return;
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
        auto part=[&](double &acc){
            double s=share>=1?acc:acc*share;
            if(share<1&&acc==std::floor(acc))s=std::round(s);
            acc-=s;return s;
        };
        const double x=part(acc_x),y=part(acc_y);
        const uint32_t e=share>=1?acc_events:std::min(acc_events,uint32_t(std::lround(acc_events*share)));
        acc_events-=e;
        if(x==0&&y==0&&e==0)return;
        motion_events+=e;yaw_counts+=x;
        pitch = std::clamp(pitch + y * (separate_vertical?vertical_sensitivity:sensitivity) * 0.022, -89.0, 89.0);
    }

    double pending_counts() const { return acc_x; }

    void frame() {if(frames<std::numeric_limits<uint16_t>::max())++frames;}
    std::optional<BhLookSample> look_sample() {
        const auto f=frames,e=motion_events;frames=motion_events=0;
        // SDL preserves trackpad fractional deltas. Never round those into invented integer mouse counts.
        if(!std::isfinite(yaw_counts)||yaw_counts!=std::floor(yaw_counts)||
            yaw_counts<std::numeric_limits<int32_t>::min()||yaw_counts>std::numeric_limits<int32_t>::max())return std::nullopt;
        return BhLookSample{yaw_base,sensitivity*.022,int32_t(yaw_counts),epoch,kind,f,e,e};
    }
    void button(uint32_t bit, bool down) { if (down) held |= bit; else held &= ~bit; }
    // Every caller is a state reset — capture changed, run restarted, settings
    // reapplied — so motion from before it must not survive into the next tick.
    void clear() { held = pulse = 0; acc_x = acc_y = 0; acc_events = 0; have_split = false; }
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
}
