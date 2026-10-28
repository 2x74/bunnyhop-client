#pragma once
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string>
#include <optional>
#include <type_traits>
#include <stdexcept>
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
        uint32_t reports = 1;
        double pitch_min = -89;
        double pitch_max = 89;
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

    static constexpr size_t storage_limit = 4096;

    // Retained 250 ms at 8 kHz fits without compression or allocation.
    TimedInput() {
        motion_.reserve(storage_limit);
        edges_.reserve(storage_limit);
        keys.reserve(128);
    }

    void begin_pump(int64_t first_boundary, int64_t tick_ns, bool capped, double pitch = 0) {
        fold_pitch_ = pitch;
        first_cut_ = first_boundary - holdback_ns();
        tick_ns_ = tick_ns;
        fold_cut_ = capped ? std::optional<int64_t>(first_cut_) : std::nullopt;
        if (!capped) {
            return;
        }
        while (head_ < motion_.size() && motion_[head_].t <= first_cut_) {
            fold_report(motion_[head_++]);
        }
        settle_motion();
        while (edge_head_ < edges_.size() && edges_[edge_head_].t <= first_cut_) {
            folded_edges_ = true;
            apply_edge(edges_[edge_head_++]);
        }
        compact(edges_, edge_head_);
    }

    size_t motion_storage() const { return motion_.size(); }

    size_t edge_storage() const { return edges_.size(); }

    bool take_folded_edges() { return std::exchange(folded_edges_, false); }

    int64_t holdback_ns() const { return int64_t(std::llround(holdback_ms * 1e6)); }

    // |t| as a usable time on the clock it was received at (|now|); |tail| is the newest stamp still queued.
    // - 0 or in the future: received now.
    // - discarded-time input: the actual first retained cutoff, including remainder and holdback.
    // - without a capped frame: keep at most max_age of timestamp history.
    // - older than the queue's newest: received now, so the queue stays in order.
    int64_t stamp(int64_t t, int64_t now, int64_t tail) const {
        if (unreliable || t <= 0 || t > now + future_slack_ns) {
            return now;
        }
        if (fold_cut_ && t <= *fold_cut_) {
            return *fold_cut_;
        }
        t = std::max(std::min(t, now), now - max_age_ns);
        return t < tail ? now : t;
    }

    int64_t motion_tail() const { return head_ < motion_.size() ? motion_.back().t : 0; }

    int64_t edge_tail() const { return edge_head_ < edges_.size() ? edges_.back().t : 0; }

    size_t pending() const { return motion_.size() - head_ + bool(folded_); }

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
        const Report report{t, x, p};
        if (fold_cut_ && t <= *fold_cut_) {
            fold_report(report);
        } else {
            make_motion_room();
            insert(motion_, head_, report);
        }
        pending_x += x;
        pending_p += p;
    }

    void add_edge(int64_t t, const std::string &code, bool down) {
        ++edges_seen;
        if (fold_cut_ && t <= *fold_cut_) {
            folded_edges_ = true;
            apply_edge(Edge{t, code, down});
        } else {
            make_edge_room();
            insert(edges_, edge_head_, Edge{t, code, down});
        }
    }

    // The tick whose boundary is |at|: applies the motion (|apply(x, p)| per report, in order) and the key edges
    // stamped at or before at - holdback. Returns how many reports it took.
    template <class Apply>
    uint32_t take(int64_t at, Apply &&apply) {
        const int64_t until = at - holdback_ns();
        if (!have_cut_ || until > cut_) {
            cut_ = until;
            have_cut_ = true;
        }
        uint32_t taken = take_folded(until, apply);
        while (head_ < motion_.size() && motion_[head_].t <= until) {
            const Report &report = motion_[head_++];
            pending_x -= report.x;
            pending_p -= report.p;
            dispatch(apply, report);
            taken += report.reports;
        }
        settle_motion();
        while (edge_head_ < edges_.size() && edges_[edge_head_].t <= until) {
            apply_edge(edges_[edge_head_++]);
        }
        compact(edges_, edge_head_);
        return taken;
    }

    // Pending motion in order, without taking it (the render camera's preview).
    template <class Apply>
    void peek(Apply &&apply) const {
        if (folded_) {
            dispatch(apply, *folded_);
        }
        for (size_t i = head_; i < motion_.size(); ++i) {
            dispatch(apply, motion_[i]);
        }
    }

    // Everything pending, now: nothing is ticking, the sensitivity changed, or --frames. Key edges fold into |keys|.
    template <class Apply>
    uint32_t flush(Apply &&apply) {
        uint32_t taken = take_folded(INT64_MAX, apply);
        for (; head_ < motion_.size(); ++head_) {
            dispatch(apply, motion_[head_]);
            taken += motion_[head_].reports;
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
        folded_edges_ = false;
        keys.clear();
        edges_.clear();
        edge_head_ = 0;
    }

    // The keys physically held right now become the tick state, with no edge pending for them.
    template <class Codes>
    void seed_keys(const Codes &codes) {
        release_keys();
        folded_edges_ = false;
        for (const auto &code : codes) {
            keys.push_back(code);
        }
    }

    // Back to the start. The holdback keeps what it learned.
    void reset() {
        motion_.clear();
        folded_.reset();
        fold_cut_.reset();
        head_ = 0;
        pending_x = 0;
        pending_p = 0;
        release_keys();
        have_cut_ = false;
        cut_ = 0;
    }

private:
    double fold_pitch_ = 0;
    bool folded_edges_ = false;
    std::optional<Report> folded_;
    std::optional<int64_t> fold_cut_;
    int64_t first_cut_ = 0;
    int64_t tick_ns_ = 10'000'000;
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
    template <class T>
    static void insert(std::vector<T> &queue, size_t from, T value) {
        size_t i = queue.size();
        while (i > from && queue[i - 1].t > value.t) {
            --i;
        }
        queue.insert(queue.begin() + std::ptrdiff_t(i), std::move(value));
    }

    template <class Apply>
    static void dispatch(Apply &apply, const Report &report) {
        if constexpr (std::is_invocable_v<Apply, const Report &>) {
            apply(report);
        } else {
            apply(report.x, report.p);
        }
    }

    template <class T>
    static void compact(std::vector<T> &queue, size_t &head) {
        if (head == queue.size()) {
            queue.clear();
            head = 0;
        } else if (head >= 64) {
            queue.erase(queue.begin(), queue.begin() + std::ptrdiff_t(head));
            head = 0;
        }
    }

    void settle_motion() {
        compact(motion_, head_);
        if (motion_.empty() && !folded_) {
            pending_x = 0;
            pending_p = 0;
        }
    }

    // Composition preserves pitch clamps in arrival order, even across both pitch limits.
    static void combine(Report &prefix, const Report &next) {
        prefix.x += next.x;
        prefix.p += next.p;
        prefix.pitch_min = std::clamp(prefix.pitch_min + next.p, next.pitch_min, next.pitch_max);
        prefix.pitch_max = std::clamp(prefix.pitch_max + next.p, next.pitch_min, next.pitch_max);
        prefix.reports += next.reports;
        prefix.t = next.t;
    }

    void fold_report(const Report &report) {
        if (!folded_) {
            folded_ = report;
            const double pitch = std::clamp(fold_pitch_ + report.p, report.pitch_min, report.pitch_max);
            folded_->pitch_min = pitch;
            folded_->pitch_max = pitch;
        } else {
            combine(*folded_, report);
        }
        folded_->t = *fold_cut_;
    }

    template <class Apply>
    uint32_t take_folded(int64_t until, Apply &apply) {
        if (!folded_ || folded_->t > until) {
            return 0;
        }
        const Report report = *folded_;
        folded_.reset();
        pending_x -= report.x;
        pending_p -= report.p;
        dispatch(apply, report);
        return report.reports;
    }

    int64_t bucket(int64_t stamp) const { return stamp <= first_cut_ ? 0 : 1 + (stamp - first_cut_ - 1) / tick_ns_; }

    void make_motion_room() {
        if (motion_.size() < storage_limit) {
            return;
        }
        compact(motion_, head_);
        size_t kept = 0;
        for (size_t i = head_; i < motion_.size(); ++i) {
            if (kept && bucket(motion_[kept - 1].t) == bucket(motion_[i].t)) {
                combine(motion_[kept - 1], motion_[i]);
            } else {
                motion_[kept++] = motion_[i];
            }
        }
        motion_.resize(kept);
        head_ = 0;
        if (kept == storage_limit) {
            throw std::runtime_error("Input exceeds the retained tick window");
        }
    }

    void make_edge_room() {
        if (edges_.size() < storage_limit) {
            return;
        }
        compact(edges_, edge_head_);
        for (size_t i = edge_head_; i < edges_.size(); ++i) {
            for (size_t j = i + 1; j < edges_.size() && bucket(edges_[j].t) == bucket(edges_[i].t); ++j) {
                if (edges_[j].code == edges_[i].code) {
                    edges_.erase(edges_.begin() + std::ptrdiff_t(i));
                    return;
                }
            }
        }
        if (edges_.size() == storage_limit) {
            throw std::runtime_error("Input exceeds the retained key window");
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
