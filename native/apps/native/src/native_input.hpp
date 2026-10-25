#pragma once
#include "bunnyhop_native.h"
#include <algorithm>
#include <cmath>
#include <deque>
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
private:
    struct Report {
        uint64_t time;
        double x, y, k, pitch_sensitivity;
        bool frame;
    };
    std::deque<Report> pending;
    std::optional<uint64_t> reset_time;
    double yaw_k=2*.022;
    void enqueue(Report report) {
        // Equal timestamps retain SDL delivery order. Also tolerate late reports
        // without allowing a future report to block an earlier tick's input.
        if(reset_time&&report.time<=*reset_time)return;
        const auto at=std::upper_bound(pending.begin(),pending.end(),report.time,
            [](uint64_t time,const Report &r){return time<r.time;});
        pending.insert(at,report);
    }
    void rebase_scale(double k) {
        if(k==yaw_k)return;
        const double at=yaw();yaw_k=k;set_yaw(at,4);
    }
    void apply(const Report &report) {
        if(report.frame){frame();return;}
        // A queued report keeps the settings with which it was received.
        rebase_scale(report.k);
        if(motion_events<std::numeric_limits<uint32_t>::max())++motion_events;
        yaw_counts+=report.x;
        pitch=std::clamp(pitch+report.y*report.pitch_sensitivity*.022,-89.0,89.0);
    }
public:
    // Match replay.ts norm360's two remainders, including its double rounding.
    static double normalize(double v) { return std::fmod(std::fmod(v,360.0)+360.0,360.0); }
    double yaw() const { return normalize(yaw_base - yaw_counts * yaw_k); }
    void set_yaw(double v,uint32_t reason=5) { yaw_base = normalize(v); yaw_counts = 0; ++epoch;kind=reason; }
    void set_sensitivity(double v) { if(v==sensitivity)return;sensitivity=v;rebase_scale(v*.022); }
    void set_angles(double p, double y,uint32_t reason=1) { pitch = std::clamp(p, -89.0, 89.0); set_yaw(y,reason); }
    void motion(double x, double y) {
        if(!std::isfinite(x)||!std::isfinite(y))return;
        apply({0,x,y,sensitivity*.022,separate_vertical?vertical_sensitivity:sensitivity,false});
    }
    void motion_at(uint64_t time,double x,double y) {
        if(!std::isfinite(x)||!std::isfinite(y))return;
        enqueue({time,x,y,sensitivity*.022,separate_vertical?vertical_sensitivity:sensitivity,false});
    }
    void frame_at(uint64_t time) { enqueue({time,0,0,0,0,true}); }
    // A report on the boundary belongs to the tick ending at that boundary.
    void consume_until(uint64_t time) {
        while(!pending.empty()&&pending.front().time<=time){apply(pending.front());pending.pop_front();}
    }
    void consume_all() { consume_until(std::numeric_limits<uint64_t>::max()); }
    void frame() {if(frames<std::numeric_limits<uint16_t>::max())++frames;}
    std::optional<BhLookSample> look_sample() {
        const auto f=frames,e=motion_events;frames=motion_events=0;
        // SDL preserves trackpad fractional deltas. Never round those into invented integer mouse counts.
        if(!std::isfinite(yaw_counts)||yaw_counts!=std::floor(yaw_counts)||
            yaw_counts<std::numeric_limits<int32_t>::min()||yaw_counts>std::numeric_limits<int32_t>::max())return std::nullopt;
        return BhLookSample{yaw_base,yaw_k,int32_t(yaw_counts),epoch,kind,f,e,e};
    }
    void button(uint32_t bit, bool down) { if (down) held |= bit; else held &= ~bit; }
    void clear() { held=pulse=frames=motion_events=0;pending.clear(); }
    // Reject already-delivered SDL events from before a focus/menu/restart reset.
    void clear_at(uint64_t time) { clear();reset_time=reset_time?std::max(*reset_time,time):time; }
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
