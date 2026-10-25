#pragma once
#include "bunnyhop_native.h"
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <limits>
#include <optional>
#include <set>
#include <string>

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

    // ---- tick-windowed motion ------------------------------------------
    //
    // SDL hands over mouse reports when it is polled, which is once per
    // rendered frame. Applying each report the moment it arrives means the
    // first simulation tick after a poll receives every report from that
    // frame and any later tick in the same catch-up receives none, so how a
    // flick is divided between ticks follows the frame rate rather than when
    // the mouse actually moved. At 100 Hz with a 1000 Hz mouse that is the
    // difference between ten even reports per tick and a burst of sixteen
    // followed by nothing.
    //
    // Reports therefore wait here carrying the timestamp SDL stamped on
    // them, and a tick applies only the ones that happened inside its own
    // window. A report is never divided between two ticks: a mouse count is
    // an integer and BhLookSample has to stay integral, so each report
    // belongs wholly to one tick.
    struct Report { uint64_t at_ns; double x, y; };

    // Enough for a quarter second of a 1000 Hz mouse. Past this the oldest
    // report is applied early rather than discarded — losing a report loses
    // aim the player made, which is worse than attributing it a tick late.
    static constexpr std::size_t max_pending = 4096;

    std::deque<Report> pending;

    void motion_at(uint64_t at_ns, double x, double y) {
        if(!std::isfinite(x)||!std::isfinite(y))return;
        if(pending.size()>=max_pending){const auto oldest=pending.front();pending.pop_front();motion(oldest.x,oldest.y);}
        // Keep the queue non-decreasing so consuming a window stays a prefix
        // walk; SDL does not promise ordered timestamps across devices.
        if(!pending.empty()&&at_ns<pending.back().at_ns) at_ns=pending.back().at_ns;
        pending.push_back({at_ns,x,y});
    }

    // ---- tick-windowed keys -------------------------------------------
    //
    // Keys and mouse buttons go through the same window as motion. Before,
    // a tick read which keys were held at the moment SDL was polled, while
    // its mouse motion came from its own window, so a tick that ended before
    // you switched A to D still got D. In CS:S both come from the same
    // instant (the usercmd). |tick_codes| is what the tick sees; the client
    // keeps its own poll-time set for everything that isn't a tick.
    struct KeyReport { uint64_t at_ns; std::string code; bool down; };
    std::deque<KeyReport> key_pending;
    std::set<std::string> tick_codes;
    // Set by clear(): the next tick starts again from the poll-time set.
    bool keys_resync = true;

    void key_at(uint64_t at_ns, std::string code, bool down) {
        if(key_pending.size()>=256){apply(key_pending.front());key_pending.pop_front();}
        if(!key_pending.empty()&&at_ns<key_pending.back().at_ns) at_ns=key_pending.back().at_ns;
        key_pending.push_back({at_ns,std::move(code),down});
    }
    void apply(const KeyReport &k) { if(k.down) tick_codes.insert(k.code); else tick_codes.erase(k.code); }

    // Applies every report stamped at or before |deadline_ns|.
    void consume_until(uint64_t deadline_ns) {
        while(!pending.empty()&&pending.front().at_ns<=deadline_ns){const auto next=pending.front();pending.pop_front();motion(next.x,next.y);}
        while(!key_pending.empty()&&key_pending.front().at_ns<=deadline_ns){apply(key_pending.front());key_pending.pop_front();}
    }

    // Applies everything still waiting. The render camera uses this on a copy
    // so the view keeps showing the newest motion and gains no latency from
    // the simulation holding a report back for its tick.
    void consume_all() {
        while(!pending.empty()){const auto next=pending.front();pending.pop_front();motion(next.x,next.y);}
        while(!key_pending.empty()){apply(key_pending.front());key_pending.pop_front();}
    }

    std::size_t pending_reports() const { return pending.size(); }
    void drop_pending() { pending.clear(); }

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
    // reapplied — so queued motion from before it must not survive into the
    // next tick.
    void clear() { held = pulse = 0; pending.clear(); key_pending.clear(); keys_resync = true; }
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
