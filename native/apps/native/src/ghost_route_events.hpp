#pragma once
#include "ghost_trails.hpp"

namespace native_render {
inline constexpr uint8_t route_teleported = 1, route_jumped = 2;

// The frame ABI contains ground flags only. Read exact events on the import worker's private replay context so
// short teleports and jumps on the timer's first tick match the website without changing the shared ABI or core.
inline bool load_route_events(
        GhostPath &path, BhContext *core, const std::string &file, const std::atomic_bool *cancelled = nullptr
) {
    if (!bh_replay_load(core, file.c_str())) throw std::runtime_error(bh_last_error(core));
    path.motion_events.resize(path.frames.size());
    BhSnapshot snapshot{};
    for (size_t tick = 0; tick < path.frames.size(); ++tick) {
        if (cancelled && cancelled->load(std::memory_order_relaxed)) return false;
        const bool read = tick ? bh_replay_step(core, &snapshot) : bh_snapshot(core, &snapshot);
        if (!read) throw std::runtime_error(bh_last_error(core));
        path.motion_events[tick] = uint8_t(snapshot.player.events);
        path.teleports[tick] = (snapshot.player.events & route_teleported) != 0;
    }
    path.build_route();
    return true;
}
}  // namespace native_render
