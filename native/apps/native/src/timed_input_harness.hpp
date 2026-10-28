#pragma once
// Test harness: the client's frame loop input path (client.cpp run(): pump, accumulator, ticks) on a scripted clock.
#include "settings.hpp"
#include "input_timeline.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <set>
#include <string>
#include <vector>

namespace native::test {

constexpr int64_t ms = 1'000'000;
constexpr int64_t tick_ns = 10 * ms;
constexpr double tick_seconds = .01;

struct ScriptedEvent {
    int64_t stamp = 0;
    int64_t arrival = 0;
    bool key = false;
    double x = 0;
    double y = 0;
    std::string code;
    bool down = false;
};

struct TickRow {
    int64_t boundary = 0;
    double counts = 0;
    double pitch = 0;
    double yaw = 0;
    uint32_t held = 0;
    uint32_t reports = 0;
};

class LoopHarness {
public:
    Input input;
    std::set<std::string> held_codes;
    InputTimeline timeline;
    InputScheduler scheduler;
    std::vector<TickRow> rows;
    // Called after each tick's command, like the core reporting teleport/pusher events (Input::events).
    std::function<void(Input &, size_t tick)> after_tick;

    LoopHarness() {
        timeline.rebuild_binds(default_settings().at("binds"));
        timeline.queue().holdback_ms = 0;
    }

    void motion(int64_t stamp, double x, double y = 0, int64_t arrival = -1) {
        ScriptedEvent event;
        event.stamp = stamp;
        event.arrival = arrival < 0 ? stamp : arrival;
        event.x = x;
        event.y = y;
        add(event);
    }

    void key(int64_t stamp, const std::string &code, bool down, int64_t arrival = -1) {
        ScriptedEvent event;
        event.stamp = stamp;
        event.arrival = arrival < 0 ? stamp : arrival;
        event.key = true;
        event.code = code;
        event.down = down;
        add(event);
    }

    // Delivers what has arrived by |now| (the pump), then runs the ticks due, as run() does.
    void frame(int64_t now) {
        scheduler.frame(uint64_t(now), true, uint64_t(tick_ns));
        timeline.begin_pump(input, uint64_t(now), scheduler, uint64_t(tick_ns));
        pump(now);
        last_frame_ = now;
        uint64_t &sim_ns = scheduler.sim_ns;
        timeline.begin_frame(input, true, uint64_t(now));
        while (scheduler.due(uint64_t(tick_ns))) {
            const double before = input.yaw_counts;
            const uint32_t reports_before = input.motion_events;
            timeline.take_tick(input, sim_ns, uint64_t(tick_ns), false);
            input.held = timeline.held(held_codes);
            const BhCmd command = input.command();
            TickRow row;
            row.boundary = int64_t(sim_ns);
            row.counts = input.yaw_counts - before;
            row.pitch = command.pitch;
            row.yaw = input.yaw();
            row.held = command.buttons;
            row.reports = input.motion_events - reports_before;
            input.look_sample();
            rows.push_back(row);
            if (after_tick) {
                after_tick(input, rows.size() - 1);
            }
            scheduler.consume(uint64_t(tick_ns));
        }
    }

    // Frames every |period| ns from the last frame up to |until|; frames inside [gap_from, gap_to) are skipped.
    void run(int64_t until, int64_t period, int64_t gap_from = 0, int64_t gap_to = 0) {
        for (int64_t t = last_frame_ + period; t <= until; t += period) {
            if (t >= gap_from && t < gap_to) {
                continue;
            }
            frame(t);
        }
    }

    // Everything delivered so far, without running ticks (a client barrier happens between pumps).
    void pump(int64_t now) {
        while (next_ < events_.size() && events_[next_].arrival <= now) {
            const ScriptedEvent &event = events_[next_++];
            const auto stamp = uint64_t(event.stamp);
            const auto arrival = uint64_t(event.arrival);
            if (event.key) {
                timeline.key(held_codes, event.code, event.down, false, stamp, arrival);
            } else {
                timeline.motion(input, stamp, arrival, event.x, event.y);
            }
        }
    }

    void start_at(int64_t now) {
        last_frame_ = now;
        scheduler.reset(uint64_t(now));
    }
    int64_t last_frame() const { return last_frame_; }

private:
    std::vector<ScriptedEvent> events_;
    size_t next_ = 0;
    int64_t last_frame_ = 0;

    void add(const ScriptedEvent &event) {
        const auto by_arrival = [](const ScriptedEvent &a, const ScriptedEvent &b) { return a.arrival < b.arrival; };
        const auto at = std::upper_bound(events_.begin() + std::ptrdiff_t(next_), events_.end(), event, by_arrival);
        events_.insert(at, event);
    }
};

}  // namespace native::test
