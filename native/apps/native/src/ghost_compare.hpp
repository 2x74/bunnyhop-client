#pragma once
// The HUD's comparison with the race ghosts: where the player is on each ghost's route, the time difference against it,
// and which ghost the split and the speed difference use. The website's GhostManager.frame (apps/web/src/ghost.ts).
// Display only: it reads recorded frames and the player's position, and nothing here reaches the simulation.
#include "closest_pos.hpp"
#include "ghost_trails.hpp"
#include "native_input.hpp"
#include <algorithm>
#include <array>
#include <cstdlib>
#include <limits>
#include <optional>

namespace native {

// BhRunState::status.
inline constexpr uint32_t ghost_run_idle = 0;
inline constexpr uint32_t ghost_run_running = 1;
inline constexpr uint32_t ghost_run_finished = 2;

/** What the comparison needs of this frame. */
struct GhostCompareFrame {
    uint32_t status = ghost_run_idle;
    /** Ticks elapsed in the current or finished run. */
    int elapsed_ticks = 0;
    double tick_interval = 0;
    std::array<float, 3> position{};
    /** Horizontal speed over the last tick's move (u/s, what the ghost's is measured from); none across a teleport. */
    std::optional<double> player_speed;
};

/** This frame's values from the run and the two states around the last tick. */
inline GhostCompareFrame
ghost_compare_frame(const BhRunState &run, const BhState &previous, const BhState &current, double tick_interval) {
    GhostCompareFrame frame;
    frame.status = run.status;
    const uint32_t until = run.status == ghost_run_finished ? run.end_tick : run.last_tick;
    const bool timed = run.status != ghost_run_idle && until >= run.start_tick;
    frame.elapsed_ticks = timed ? int(until - run.start_tick) : 0;
    frame.tick_interval = tick_interval;
    std::copy_n(current.position, 3, frame.position.begin());
    if (previous.tick != current.tick && !(current.events & teleported)) {
        const double dx = double(current.position[0]) - previous.position[0];
        const double dy = double(current.position[1]) - previous.position[1];
        frame.player_speed = std::sqrt(dx * dx + dy * dy) / tick_interval;
    }
    return frame;
}

class GhostCompare {
public:
    static constexpr unsigned slot_count = 4;
    /** A slot's route for this frame; null when that ghost isn't racing on this track. */
    using Racing = std::array<const native_render::GhostPath *, slot_count>;

    /** A new run or a restart: every route search starts over. */
    void restart() {
        for (auto &route : routes_) {
            if (route.search) route.search->reset();
            route.delta.reset();
            route.match_speed = no_speed;
        }
        split_.reset();
        speed_delta_.reset();
        last_split_tick_ = -1;
        last_speed_tick_ = -1;
    }

    /** `choice`: Compare with. None is Auto: PB, else WR, else custom. */
    void frame(const Racing &racing, native_render::GhostSource choice, const GhostCompareFrame &now) {
        const bool sample =
                now.status == ghost_run_running
                && (last_split_tick_ < 0 || std::abs(now.elapsed_ticks - last_split_tick_) >= split_every_ticks);
        if (sample) last_split_tick_ = now.elapsed_ticks;
        int primary = -1;
        for (unsigned slot = 0; slot < slot_count; ++slot) {
            if (!racing[slot]) continue;
            update_route(routes_[slot], *racing[slot], now, sample);
            if (compares_with(*racing[slot], primary < 0 ? nullptr : racing[size_t(primary)], choice))
                primary = int(slot);
        }
        split_ = primary < 0 ? std::nullopt : routes_[size_t(primary)].delta;
        update_speed_delta(primary, now, sample);
    }

    /** Elapsed time minus the compared ghost's at the same point (s; negative = ahead). None: nothing to compare. */
    std::optional<double> split() const { return split_; }

    /** The player's speed minus the compared ghost's at the same point (u/s). None: nothing to compare. */
    std::optional<double> speed_delta() const { return speed_delta_; }

    /** Elapsed time minus this slot's ghost's (s), for its name tag. */
    std::optional<double> delta(unsigned slot) const { return routes_[slot].delta; }

private:
    /** Live deltas every this many ticks. */
    static constexpr int split_every_ticks = 4;
    /** The speed difference changes this often (s), like shavit's 10 Hz: readable, where every tick is a blur. */
    static constexpr double speed_difference_every_seconds = .1;
    /** Route frames of a search's index built per rendered frame. A fraction of a millisecond at worst. */
    static constexpr int64_t build_slice_frames = 2048;
    static constexpr double no_speed = std::numeric_limits<double>::quiet_NaN();

    struct Route {
        uint64_t revision = 0;
        std::optional<ClosestPos> search;
        std::optional<double> delta;
        double match_speed = no_speed;
    };

    static int ghost_rank(native_render::GhostSource source) {
        if (source == native_render::GhostSource::pb) return 0;
        return source == native_render::GhostSource::wr ? 1 : 2;
    }

    static bool compares_with(
            const native_render::GhostPath &path,
            const native_render::GhostPath *primary,
            native_render::GhostSource choice
    ) {
        if (choice != native_render::GhostSource::none) return path.source == choice;
        return !primary || ghost_rank(path.source) < ghost_rank(primary->source);
    }

    // Made on first use, so a ghost that never races costs nothing; only a newly loaded ghost allocates.
    static void bind_route(Route &route, const native_render::GhostPath &path) {
        if (route.revision == path.revision && route.search) return;
        route = {};
        route.revision = path.revision;
        route.search.emplace(path.frames, path.start, path.end, path.interval, path.teleports);
    }

    static void
    update_route(Route &route, const native_render::GhostPath &path, const GhostCompareFrame &now, bool sample) {
        bind_route(route, path);
        auto &search = *route.search;
        if (!search.ready()) search.build(build_slice_frames);
        if (sample) {
            const auto &position = now.position;
            if (search.find(position[0], position[1], position[2])) {
                route.match_speed = search.speed;
                route.delta = (now.elapsed_ticks - (search.tick - double(path.start))) * path.interval;
            } else {
                route.match_speed = no_speed;
            }
        } else if (now.status == ghost_run_finished) {
            route.delta = (now.elapsed_ticks - int(path.end - path.start)) * now.tick_interval;
        } else if (now.status == ghost_run_idle) {
            route.delta.reset();
        }
    }

    void update_speed_delta(int primary, const GhostCompareFrame &now, bool sample) {
        if (primary < 0 || now.status != ghost_run_running) {
            speed_delta_.reset();
            return;
        }
        if (!sample) return;
        const int since_last = std::abs(now.elapsed_ticks - last_speed_tick_);
        if (last_speed_tick_ >= 0 && since_last < speed_difference_every_seconds / now.tick_interval) return;
        last_speed_tick_ = now.elapsed_ticks;
        const double ghost_speed = routes_[size_t(primary)].match_speed;
        if (std::isnan(ghost_speed))
            speed_delta_.reset();
        else if (now.player_speed)
            speed_delta_ = *now.player_speed - ghost_speed;
    }

    std::array<Route, slot_count> routes_;
    std::optional<double> split_;
    std::optional<double> speed_delta_;
    int last_split_tick_ = -1;
    int last_speed_tick_ = -1;
};

}  // namespace native
