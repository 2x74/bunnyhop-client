#pragma once
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace native {

// Timestamped input: the web's timed input (bunnyhop apps/web/src/timed-input.ts, PR #55) on SDL's event clock.
//
// Why: SDL hands the client a frame's mouse reports and key edges once per rendered frame. Before this, each tick
// took an even share of the frame's motion (Input::take_tick) and the keys as last polled, so where a flick or an
// A/D switch landed followed the frame rate. SDL already stamps every event on the SDL_GetTicksNS clock (on Windows
// the raw-input thread spreads each GetRawInputBuffer batch over its read span; Linux and macOS stamp on arrival).
//
// How: every gameplay motion report and movement-key edge is queued with its stamp. The tick whose boundary is T
// takes the reports and edges stamped at or before T - holdback, in order; the camera previews everything at once.
// A report that arrives after its tick already ran counts in the next one, so committed ticks never change. Counts
// stay as SDL delivered them: integers stay integers and trackpad fractions stay exact.
//
// Holdback: a report reaches the queue a little after its stamp. The holdback makes each tick wait that long in
// command time, adapted from the share of reports that arrive late. SDL's raw thread shares the pump's clock, so
// native starts at 1 ms with a 4 ms ceiling (the web uses 2 / 8 ms for browser pipelines).
//
// Clocks: see stamp(). If reports are still late at the largest holdback for several windows, the stamps are no use
// on this machine and the session falls back to arrival times.
class TimedInput {
public:
    static constexpr double holdback_start_ms = 1;
    static constexpr double holdback_limit_ms = 4;
    static constexpr uint32_t window = 400;
    static constexpr uint32_t lower_after = 4;
    static constexpr uint32_t stuck_windows = 3;
    static constexpr double late_high = .01;
    static constexpr double late_low = .001;
    static constexpr double raise_ms = .5;
    static constexpr double lower_ms = .25;
    static constexpr double give_up_share = .05;
    static constexpr int64_t max_age_ns = 250'000'000;
    static constexpr int64_t future_slack_ns = 1'000'000;

    // x: yaw counts. p: pitch degrees, with the sensitivity and inversion in effect when it was received.
    struct Report {
        int64_t t;
        double x;
        double p;
    };
    struct Edge {
        int64_t t;
        std::string code;
        bool down;
    };

    double holdback_ms = holdback_start_ms;
    double holdback_max_ms = holdback_limit_ms;
    // Motion received but not yet in a tick: what the camera shows beyond the last tick.
    double pending_x = 0;
    double pending_p = 0;
    // Movement-key codes held as of the last tick, in press order.
    std::vector<std::string> keys;
    // Since the session began.
    uint64_t reports = 0;
    uint64_t late = 0;
    uint64_t edges_seen = 0;
    bool unreliable = false;

    // Room for a long frame at 8 kHz and a burst of key edges, so a frame never allocates.
    TimedInput() {
        motion_.reserve(4096);
        edges_.reserve(64);
        keys.reserve(16);
    }

    int64_t holdback_ns() const { return int64_t(std::llround(holdback_ms * 1e6)); }

    // |t| as a usable time on the clock it was received at (|now|); |tail| is the newest stamp still queued.
    // - 0 or in the future: received now.
    // - older than max_age (a hitch's backlog, or another clock): now - max_age. The frame loop keeps at most that much
    //   of a long gap, so the backlog lands in the first retained tick (PR #55 "capped gap"). The web uses now here.
    // - older than the queue's newest: received now, so the queue stays in order.
    int64_t stamp(int64_t t, int64_t now, int64_t tail) const {
        if (unreliable || t <= 0 || t > now + future_slack_ns) {
            return now;
        }
        t = std::max(std::min(t, now), now - max_age_ns);
        return t < tail ? now : t;
    }
    int64_t motion_tail() const { return head_ < motion_.size() ? motion_.back().t : 0; }
    int64_t edge_tail() const { return edge_head_ < edges_.size() ? edges_.back().t : 0; }
    size_t pending() const { return motion_.size() - head_; }
    size_t pending_edges() const { return edges_.size() - edge_head_; }

    void add_motion(int64_t t, double x, double p) {
        const bool is_late = have_cut_ && t <= cut_;
        ++reports;
        ++window_seen_;
        if (is_late) {
            ++late;
            ++window_late_;
        }
        if (window_seen_ >= window) {
            adapt();
        }
        insert(motion_, head_, Report{t, x, p});
        pending_x += x;
        pending_p += p;
    }

    void add_edge(int64_t t, const std::string &code, bool down) {
        ++edges_seen;
        insert(edges_, edge_head_, Edge{t, code, down});
    }

    // The tick whose boundary is |at|: applies the motion (|apply(x, p)| per report, in order) and the key edges
    // stamped at or before at - holdback. Returns how many reports it took.
    template <class Apply> uint32_t take(int64_t at, Apply &&apply) {
        const int64_t until = at - holdback_ns();
        if (!have_cut_ || until > cut_) {
            cut_ = until;
            have_cut_ = true;
        }
        uint32_t taken = 0;
        while (head_ < motion_.size() && motion_[head_].t <= until) {
            const Report &report = motion_[head_++];
            pending_x -= report.x;
            pending_p -= report.p;
            apply(report.x, report.p);
            ++taken;
        }
        settle_motion();
        while (edge_head_ < edges_.size() && edges_[edge_head_].t <= until) {
            apply_edge(edges_[edge_head_++]);
        }
        if (edge_head_ == edges_.size()) {
            edges_.clear();
            edge_head_ = 0;
        }
        return taken;
    }

    // Pending motion in order, without taking it (the render camera's preview).
    template <class Apply> void peek(Apply &&apply) const {
        for (size_t i = head_; i < motion_.size(); ++i) {
            apply(motion_[i].x, motion_[i].p);
        }
    }

    // Everything pending, now: nothing is ticking, the sensitivity changed, or --frames. Key edges fold into |keys|.
    template <class Apply> uint32_t flush(Apply &&apply) {
        uint32_t taken = 0;
        for (; head_ < motion_.size(); ++head_) {
            apply(motion_[head_].x, motion_[head_].p);
            ++taken;
        }
        settle_motion();
        for (; edge_head_ < edges_.size(); ++edge_head_) {
            apply_edge(edges_[edge_head_]);
        }
        edges_.clear();
        edge_head_ = 0;
        return taken;
    }

    // No held movement keys and no pending edges.
    void release_keys() {
        keys.clear();
        edges_.clear();
        edge_head_ = 0;
    }

    // The keys physically held right now become the tick state, with no edge pending for them.
    template <class Codes> void seed_keys(const Codes &codes) {
        release_keys();
        for (const auto &code : codes) {
            keys.push_back(code);
        }
    }

    // Back to the start. The holdback keeps what it learned.
    void reset() {
        motion_.clear();
        head_ = 0;
        pending_x = 0;
        pending_p = 0;
        release_keys();
        have_cut_ = false;
        cut_ = 0;
    }

private:
    std::vector<Report> motion_;
    size_t head_ = 0;
    std::vector<Edge> edges_;
    size_t edge_head_ = 0;
    // The newest cutoff: a report stamped at or before it is late.
    int64_t cut_ = 0;
    bool have_cut_ = false;
    uint32_t window_seen_ = 0;
    uint32_t window_late_ = 0;
    uint32_t calm_ = 0;
    uint32_t stuck_ = 0;

    // Sorted insert from the back: reports nearly always arrive in order.
    template <class T> static void insert(std::vector<T> &queue, size_t from, T value) {
        size_t i = queue.size();
        while (i > from && queue[i - 1].t > value.t) {
            --i;
        }
        queue.insert(queue.begin() + std::ptrdiff_t(i), std::move(value));
    }

    void settle_motion() {
        if (head_ == motion_.size()) {
            motion_.clear();
            head_ = 0;
            // No float drift once nothing is pending.
            pending_x = 0;
            pending_p = 0;
        } else if (head_ > 1024) {
            motion_.erase(motion_.begin(), motion_.begin() + std::ptrdiff_t(head_));
            head_ = 0;
        }
    }

    // A press moves the key to the newest.
    void apply_edge(const Edge &edge) {
        keys.erase(std::remove(keys.begin(), keys.end(), edge.code), keys.end());
        if (edge.down) {
            keys.push_back(edge.code);
        }
    }

    void adapt() {
        const double share = double(window_late_) / window_seen_;
        window_seen_ = 0;
        window_late_ = 0;
        if (holdback_ms >= holdback_max_ms && share > give_up_share) {
            if (++stuck_ >= stuck_windows) {
                unreliable = true;
            }
        } else {
            stuck_ = 0;
        }
        if (share > late_high) {
            holdback_ms = std::min(holdback_max_ms, holdback_ms + raise_ms);
            calm_ = 0;
        } else if (share < late_low) {
            if (++calm_ >= lower_after) {
                holdback_ms = std::max(0.0, holdback_ms - lower_ms);
                calm_ = 0;
            }
        } else {
            calm_ = 0;
        }
    }
};

}  // namespace native
