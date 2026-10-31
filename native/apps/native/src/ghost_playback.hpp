#pragma once
#include "ghost_trails.hpp"
#include <algorithm>
#include <cmath>
#include <optional>
#include <utility>

// Where a race ghost is shown, following the website's Ghost.update (apps/web/src/ghost.ts): parked on its start tick
// while your timer is idle, then its own run in step with yours, held on its finish once it gets there. Ticks are
// fractional so a ghost moves smoothly between simulation ticks at any frame rate.
namespace native_render {

inline constexpr unsigned run_status_idle = 0;
// A jump in shown ticks this large is a seek or a restart, not playback: the pose snaps instead of blending.
inline constexpr double ghost_snap_ticks = 200;
// Gaps up to this many ticks still count as live playback, so swings and inspects in between are shown.
inline constexpr double ghost_live_event_ticks = 50;

// Ticks into the run, or nullopt while the timer is idle (the ghost waits on its start).
inline std::optional<double> ghost_elapsed_ticks(unsigned run_status, uint32_t tick, uint32_t start_tick, float blend) {
    if (run_status == run_status_idle || tick < start_tick) return std::nullopt;
    return double(tick - start_tick) + std::clamp(double(blend), 0., 1.);
}

struct GhostPose {
    BhGhostFrame frame{};
    double tick = 0;
    bool moving = false, running = false;
};

inline float lerp_angle_degrees(float from, float to, float amount) {
    const float delta = std::remainder(to - from, 360.f);
    return from + delta * amount;
}

// The frame at fractional tick `tick` of a recorded path: positions and view angles blend between the two recorded
// ticks around it, except across a teleport. Velocity is zero while parked so the bunny stands idle.
inline bool sample_ghost_path(const GhostPath &path, double tick, bool moving, BhGhostFrame &out) {
    if (path.frames.empty() || !std::isfinite(tick)) return false;
    const double last = double(path.frames.size() - 1);
    tick = std::clamp(tick, 0., last);
    const auto lower = size_t(tick), upper = std::min(lower + 1, path.frames.size() - 1);
    const auto &a = path.frames[lower], &b = path.frames[upper];
    const bool cut = upper < path.teleports.size() && path.teleports[upper];
    const float amount = cut ? 0.f : float(tick - double(lower));
    out = a;
    for (int axis = 0; axis < 3; ++axis) {
        out.position[axis] = a.position[axis] + (b.position[axis] - a.position[axis]) * amount;
        out.velocity[axis] = moving ? a.velocity[axis] : 0.f;
    }
    out.yaw = lerp_angle_degrees(a.yaw, b.yaw, amount);
    out.pitch = a.pitch + (b.pitch - a.pitch) * amount;
    out.view_offset_z = a.view_offset_z + (b.view_offset_z - a.view_offset_z) * amount;
    return valid_ghost_position(out);
}

inline bool pose_ghost(const GhostPath &path, std::optional<double> elapsed, GhostPose &out) {
    const double start = path.start, end = std::max(path.start, path.end);
    out.running = elapsed.has_value();
    out.tick = elapsed ? std::min(start + std::max(0., *elapsed), end) : start;
    out.moving = elapsed && out.tick < end;
    return sample_ghost_path(path, out.tick, out.moving, out.frame);
}

// Recorded knife swings and inspects between the ticks shown on consecutive frames.
struct GhostEventCursor {
    double shown = -1, live_ticks = ghost_live_event_ticks;

    // Returns the tick range whose events belong to this frame, or nullopt when nothing new was played.
    std::optional<std::pair<uint32_t, uint32_t>> advance(double tick, bool moving, bool &snapped) {
        snapped = shown >= 0 && (tick < shown - 1 || tick - shown > ghost_snap_ticks);
        const bool live = moving && shown >= 0 && tick > shown && tick - shown < live_ticks;
        const double previous = shown;
        shown = tick;
        if (!live || uint32_t(tick) <= uint32_t(previous)) return std::nullopt;
        return std::pair{uint32_t(previous), uint32_t(tick)};
    }

    void reset() { shown = -1; }
};

}  // namespace native_render
