#pragma once
// Closest position: where on a ghost's route the player is right now, for the time and speed difference against it.
// A port of apps/web/src/closest-pos.ts, kept line for line against it so both clients read the same numbers
// (closest_pos_tests.cpp compares them bit for bit). Display only: it reads recorded frames and the player's position,
// and nothing here reaches the simulation, the replay file or the anticheat.
//
// shavit's timer asks a k-d tree for the nearest frame in 3D, which jumps on a route that loops or a level straight
// above another. Here the search stays near the last match:
//
//   cost(t) = d²(player, frame t) + (penalty * route distance outside the window around the last match)²
//
// A frame further along the route has to be closer by that much to win, so a later pass over the same spot doesn't, and
// a player who really is somewhere else still gets there: when the near route is further than lost_units (near_units
// after a teleport), the search runs again with no penalty. Route distance, not time: a ghost that stood still for 10 s
// went nowhere. Height counts height_weight times: a level above isn't the same place as a spot that far along the
// floor.
//
// The index is a binary tree of bounding boxes over runs of consecutive ticks, plus the route distance at each tick.
// build() does a slice at a time, so a long replay costs no frame, and find() allocates nothing. Until the index is
// built, find() scans the route around the last match.
//
// The arithmetic is double over 32-bit stored values, as in JavaScript: every operation is IEEE-exact, so nothing may
// contract it into an FMA (the targets that build this set -ffp-contract=off).
#include "bunnyhop_native.h"
#include "hud_text.hpp"
#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <span>
#include <vector>

namespace native {

/** Further from the route than this (units, height weighted) there is no match. */
inline constexpr double closest_pos_lost_units = 512;

class ClosestPos {
public:
    /** Route tick of the match, with the fraction along the path (valid after find() returned true). */
    double tick = 0;
    /** Height-weighted distance from the player to the match (units). */
    double distance = 0;
    /** The ghost's horizontal speed at the match (u/s); NaN when its route teleports there. */
    double speed = std::numeric_limits<double>::quiet_NaN();

    /** `frames` and `teleports` must outlive the search. `teleports`: per tick, the route teleported into it. */
    ClosestPos(
            std::span<const BhGhostFrame> frames,
            uint32_t start_tick,
            uint32_t end_tick,
            double tick_interval,
            std::span<const uint8_t> teleports = {}
    )
        : frames_(frames)
        , teleports_(teleports.size() >= frames.size() ? teleports : std::span<const uint8_t>{})
        , tick_interval_(tick_interval) {
        const int count = int(frames.size());
        first_ = std::max(0, std::min(count - 1, int(start_tick)));
        last_ = std::max(first_, std::min(count - 1, int(end_tick)));
        const int span_ticks = last_ - first_ + 1;
        arc_.assign(size_t(span_ticks), 0);
        leaves_ = (span_ticks + leaf_ticks - 1) / leaf_ticks;
        while (capacity_ < leaves_) {
            capacity_ *= 2;
            ++height_;
        }
        boxes_.assign(size_t(capacity_) * 2 * box_floats, 0);
        for (int leaf = leaves_; leaf < capacity_; ++leaf) {
            float *box = box_at(capacity_ + leaf);
            std::fill_n(box, 3, std::numeric_limits<float>::infinity());
            std::fill_n(box + 3, 3, -std::numeric_limits<float>::infinity());
        }
        next_inner_ = capacity_ - 1;
        reset();
    }

    bool ready() const { return next_inner_ < 1 && built_ > last_ - first_; }

    /** The route starts over (restart, a new run, a load): the next search starts from its first tick. */
    void reset() {
        at_ = first_;
        fresh_ = true;
        lost_ = false;
        speed = std::numeric_limits<double>::quiet_NaN();
    }

    /** Builds the index, up to `max_frames` more route frames' worth. Returns whether it's done. */
    bool build(int64_t max_frames = std::numeric_limits<int64_t>::max()) {
        int64_t budget = max_frames;
        const int count = last_ - first_ + 1;
        while (built_ < count && budget > 0) {
            build_leaf();
            budget -= leaf_ticks;
        }
        if (built_ < count) return false;
        // Inner nodes, children first. Missing leaves are empty boxes (constructor), so a merge needs no special case.
        while (next_inner_ >= 1 && budget > 0) {
            merge_children(next_inner_--);
            budget -= 2;
        }
        return ready();
    }

    /**
     * The route point nearest (x, y, z) that continues from the last match. True: `tick`, `distance` and `speed` are
     * set, and the next search continues from here. False: no route within closest_pos_lost_units; the next search may
     * go anywhere.
     */
    bool find(double x, double y, double z) {
        if (frames_.empty()) return false;
        const double dx = x - last_x_, dy = y - last_y_, dz = z - last_z_;
        const bool may_go_far = lost_ || (!fresh_ && dx * dx + dy * dy + dz * dz > teleport_units * teleport_units);
        last_x_ = x;
        last_y_ = y;
        last_z_ = z;
        fresh_ = false;
        const int from = at_;
        int best = search(x, y, z, penalty_per_route_unit);
        const double reach = may_go_far ? near_units : closest_pos_lost_units;
        if (distance_squared(best, x, y, z) > reach * reach) {
            best = search(x, y, z, 0);
        } else if (ready() && outside_window(best)) {
            // It left the window: the penalty pulled the answer back a little. From there, it's the plain nearest.
            at_ = best;
            best = search(x, y, z, penalty_per_route_unit);
        }
        const double squared = distance_squared(best, x, y, z);
        lost_ = squared > closest_pos_lost_units * closest_pos_lost_units;
        if (lost_) {
            at_ = from;
            return false;
        }
        at_ = best;
        distance = std::sqrt(squared);
        tick = double(best) + sub_tick(best, x, y, z);
        speed = speed_at(best);
        return true;
    }

private:
    static constexpr int leaf_ticks = 32;
    static constexpr size_t box_floats = 6;
    static constexpr double height_weight = 2;
    /** Route (units) around the last match that costs nothing. Enough for a player much faster than the ghost. */
    static constexpr double window_ahead_units = 600;
    static constexpr double window_behind_units = 150;
    /** Units of distance one unit of route outside the window has to win back. */
    static constexpr double penalty_per_route_unit = 1. / 6;
    /** Per tick from the last match. Only so that the nearer tick wins a tie, as where a ghost stood still. */
    static constexpr double tie_per_tick = 1e-3;
    /** The player moved this far since the last search: a teleport. */
    static constexpr double teleport_units = 512;
    /** After a teleport, a match further than this isn't where the ghost's own teleport landed: the search goes far. */
    static constexpr double near_units = 128;
    /** A frame-to-frame move over this (|dx| + |dy| + |dz|) is a teleport in the ghost's route. */
    static constexpr double route_teleport_units = 200;
    /** How much route find() scans around the last match until the index is built (ticks). */
    static constexpr int scan_behind_ticks = 300;
    static constexpr int scan_ahead_ticks = 600;
    static constexpr double unit_length_squared_min = 1e-6;
    static constexpr size_t stack_depth = 64;

    struct Query {
        double x = 0, y = 0, z = 0;
        double penalty = 0;
        /** Route distance at the last match. */
        double here = 0;
    };

    struct Best {
        int tick = 0;
        double cost = 0;
    };

    double frame_x(int t) const { return frames_[size_t(t)].position[0]; }

    double frame_y(int t) const { return frames_[size_t(t)].position[1]; }

    double frame_z(int t) const { return frames_[size_t(t)].position[2]; }

    double arc_at(int t) const { return arc_[size_t(t - first_)]; }

    float *box_at(int node) { return boxes_.data() + size_t(node) * box_floats; }

    const float *box_at(int node) const { return boxes_.data() + size_t(node) * box_floats; }

    void build_leaf() {
        const int leaf = built_ / leaf_ticks;
        const int from = first_ + leaf * leaf_ticks;
        const int to = std::min(last_, from + leaf_ticks - 1);
        const float infinity = std::numeric_limits<float>::infinity();
        std::array<float, box_floats> box = {infinity, infinity, infinity, -infinity, -infinity, -infinity};
        for (int t = from; t <= to; ++t) {
            const float *position = frames_[size_t(t)].position;
            for (size_t axis = 0; axis < 3; ++axis) {
                if (position[axis] < box[axis]) box[axis] = position[axis];
                if (position[axis] > box[axis + 3]) box[axis + 3] = position[axis];
            }
            if (t > first_) extend_arc(t);
        }
        std::copy(box.begin(), box.end(), box_at(capacity_ + leaf));
        built_ += to - from + 1;
    }

    void extend_arc(int t) {
        const double dx = frame_x(t) - frame_x(t - 1);
        const double dy = frame_y(t) - frame_y(t - 1);
        const double dz = frame_z(t) - frame_z(t - 1);
        const double step = jump_between(t - 1, t) ? 0 : std::sqrt(dx * dx + dy * dy + dz * dz);
        arc_[size_t(t - first_)] = float(arc_at(t - 1) + step);
    }

    void merge_children(int node) {
        float *box = box_at(node);
        const float *left = box_at(node * 2);
        const float *right = box_at(node * 2 + 1);
        for (size_t axis = 0; axis < 3; ++axis) {
            box[axis] = std::min(left[axis], right[axis]);
            box[axis + 3] = std::max(left[axis + 3], right[axis + 3]);
        }
    }

    bool outside_window(int t) const {
        const double along_route = arc_at(t) - arc_at(at_);
        return along_route > window_ahead_units || along_route < -window_behind_units;
    }

    /** Height-weighted squared distance to a frame. */
    double distance_squared(int t, double x, double y, double z) const {
        const double dx = frame_x(t) - x, dy = frame_y(t) - y, dz = (frame_z(t) - z) * height_weight;
        return dx * dx + dy * dy + dz * dz;
    }

    int search(double x, double y, double z, double penalty) {
        if (!ready()) return scan(x, y, z);
        const Query query{x, y, z, penalty, arc_at(at_)};
        Best best{at_, distance_squared(at_, x, y, z)};
        size_t top = 0;
        nodes_[top] = 1;
        bounds_[top++] = 0;
        while (top > 0) {
            --top;
            if (bounds_[top] >= best.cost) continue;
            const int node = nodes_[top];
            if (node >= capacity_)
                visit_leaf(node, query, best);
            else
                push_children(node, query, best, top);
        }
        return best.tick;
    }

    void visit_leaf(int node, const Query &query, Best &best) const {
        const int from = first_ + (node - capacity_) * leaf_ticks;
        const int to = std::min(last_, from + leaf_ticks - 1);
        for (int t = from; t <= to; ++t) {
            const double squared = distance_squared(t, query.x, query.y, query.z);
            if (squared >= best.cost) continue;
            const double along_route = arc_at(t) - query.here;
            const double outside = along_route > window_ahead_units     ? along_route - window_ahead_units
                                   : along_route < -window_behind_units ? -along_route - window_behind_units
                                                                        : 0;
            const double penalty = query.penalty * outside;
            const double cost = squared + penalty * penalty + tie_per_tick * std::abs(t - at_);
            if (cost < best.cost) best = {t, cost};
        }
    }

    /** The lowest cost any tick under `child` can have; `spans_down` is how many levels of leaves it holds. */
    double child_bound(int child, int spans_down, const Query &query) const {
        const int first_leaf = (child << spans_down) - capacity_;
        if (first_leaf >= leaves_) return std::numeric_limits<double>::infinity();
        const int t0 = first_ + first_leaf * leaf_ticks;
        const int t1 = std::min(last_, t0 + (leaf_ticks << spans_down) - 1);
        const float *box = box_at(child);
        const double qx = gap_to_box(query.x, box[0], box[3]);
        const double qy = gap_to_box(query.y, box[1], box[4]);
        const double qz = gap_to_box(query.z, box[2], box[5]) * height_weight;
        const double ahead = arc_at(t0) - query.here - window_ahead_units;
        const double behind = query.here - arc_at(t1) - window_behind_units;
        const double penalty = query.penalty * (ahead > 0 ? ahead : behind > 0 ? behind : 0);
        const double tick_gap = at_ < t0 ? t0 - at_ : at_ > t1 ? at_ - t1 : 0;
        return qx * qx + qy * qy + qz * qz + penalty * penalty + tie_per_tick * tick_gap;
    }

    static double gap_to_box(double value, double low, double high) {
        return value < low ? low - value : value > high ? value - high : 0;
    }

    void push_children(int node, const Query &query, const Best &best, size_t &top) {
        // A node at depth d spans 2^(height - d) leaves.
        const int depth = std::bit_width(unsigned(node)) - 1;
        const int spans_down = height_ - depth - 1;
        const int left = node * 2;
        const double left_bound = child_bound(left, spans_down, query);
        const double right_bound = child_bound(left + 1, spans_down, query);
        // The nearer child first: it tightens the best cost for the other. (Far child pushed first, popped second.)
        const bool left_first = left_bound <= right_bound;
        const double far_bound = left_first ? right_bound : left_bound;
        const double near_bound = left_first ? left_bound : right_bound;
        if (far_bound < best.cost) {
            nodes_[top] = left_first ? left + 1 : left;
            bounds_[top++] = far_bound;
        }
        if (near_bound < best.cost) {
            nodes_[top] = left_first ? left : left + 1;
            bounds_[top++] = near_bound;
        }
    }

    /** The search while the index isn't built yet: the nearest frame of the route around the last match. */
    int scan(double x, double y, double z) const {
        const int to = std::min(last_, at_ + scan_ahead_ticks);
        int best_tick = at_;
        double best = std::numeric_limits<double>::infinity();
        for (int t = std::max(first_, at_ - scan_behind_ticks); t <= to; ++t) {
            const double squared = distance_squared(t, x, y, z);
            if (squared < best) {
                best = squared;
                best_tick = t;
            }
        }
        return best_tick;
    }

    /** The route teleports between neighbouring ticks i and j. */
    bool jump_between(int i, int j) const {
        if (!teleports_.empty() && teleports_[size_t(std::max(i, j))]) return true;
        return std::abs(frame_x(j) - frame_x(i)) + std::abs(frame_y(j) - frame_y(i)) + std::abs(frame_z(j) - frame_z(i))
               > route_teleport_units;
    }

    /** Projects the player on the segment toward the better neighbour, for progress between ticks. Never across a
     * teleport. */
    double sub_tick(int t, double x, double y, double z) const {
        if (t < last_ && !jump_between(t, t + 1)) {
            const double along_segment = along(t, t + 1, x, y, z);
            if (along_segment > 0) return std::min(1., along_segment);
        }
        if (t > first_ && !jump_between(t, t - 1)) {
            const double along_segment = along(t, t - 1, x, y, z);
            if (along_segment > 0) return -std::min(1., along_segment);
        }
        return 0;
    }

    double along(int a, int b, double x, double y, double z) const {
        const double ax = frame_x(a), ay = frame_y(a), az = frame_z(a);
        const double sx = frame_x(b) - ax, sy = frame_y(b) - ay, sz = frame_z(b) - az;
        const double length_squared = sx * sx + sy * sy + sz * sz;
        if (length_squared <= unit_length_squared_min) return 0;
        return ((x - ax) * sx + (y - ay) * sy + (z - az) * sz) / length_squared;
    }

    /**
     * Horizontal speed from the move into tick t, as the website and shavit read it off replay frames. A teleport takes
     * the next move instead; both sides teleporting has no speed.
     */
    double speed_at(int t) const {
        int a = t - 1;
        int b = t;
        if (a < 0 || jump_between(a, b)) {
            a = t;
            b = t + 1;
            if (size_t(b) >= frames_.size() || jump_between(a, b)) return std::numeric_limits<double>::quiet_NaN();
        }
        const double dx = frame_x(b) - frame_x(a);
        const double dy = frame_y(b) - frame_y(a);
        return std::sqrt(dx * dx + dy * dy) / tick_interval_;
    }

    std::span<const BhGhostFrame> frames_;
    std::span<const uint8_t> teleports_;
    double tick_interval_;
    int first_ = 0;
    int last_ = 0;
    /** Boxes: [min x, min y, min z, max x, max y, max z] per node. Node 1 is the root; leaves start at capacity_. */
    std::vector<float> boxes_;
    /** Route distance at each tick from first_ (teleports add nothing). */
    std::vector<float> arc_;
    int capacity_ = 1;
    int leaves_ = 0;
    int height_ = 0;
    std::array<int, stack_depth> nodes_{};
    std::array<double, stack_depth> bounds_{};
    /** Frames built so far (build()), then the next inner node to fill going down from capacity_ - 1. */
    int built_ = 0;
    int next_inner_ = 0;
    /** The last match (whole tick). */
    int at_ = 0;
    double last_x_ = 0, last_y_ = 0, last_z_ = 0;
    /** No position to compare the next one with (the route just started over). */
    bool fresh_ = true;
    /** The last search found nothing: the next may go far, wherever the player has got to. */
    bool lost_ = false;
};

/** JavaScript's Math.round: halves go up, so -0.5 reads 0. Display only, so -0 doesn't matter. */
inline int round_speed_diff(double speed_difference) {
    const double below = std::floor(speed_difference);
    return int(speed_difference - below >= .5 ? below + 1 : below);
}

/** "+42" / "-17" / "+0": a speed difference as the HUD shows it (shavit's "(+42)"). */
inline HudLabel<16> speed_diff_text(double speed_difference) {
    HudLabel<16> result;
    result.format("%+d", round_speed_diff(speed_difference));
    return result;
}

}  // namespace native
