#pragma once
#include "event_stamps.hpp"
#include "input_scheduler.hpp"
#include "input_binds.hpp"
#include "key_routing.hpp"
#include "native_input.hpp"
#include "timed_input.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <set>
#include <string>
#include <string_view>
#include <vector>

namespace native {

// The frame loop's input side: which tick each mouse report and movement-key edge belongs to.
//
// Timed (the default) queues every report and edge at its SDL event time; each tick takes what was stamped up to its
// boundary (timed_input.hpp). Legacy, kept as a comparator (--legacy-input, setting timedInput=false), shares each
// frame's motion over its ticks by time (Input::take_tick) and gives ticks the keys as last polled.
//
// Per frame, the client calls motion() and key() while pumping SDL events, begin_frame() once it knows whether the
// simulation runs, then take_tick() and held() for each tick.
class InputTimeline {
public:
    bool timed() const { return timed_; }

    const TimedInput &queue() const { return queue_; }

    TimedInput &queue() { return queue_; }

    const BindTable &binds() const { return binds_; }

    const EventStamps &stamps() const { return stamps_; }

    // Once, after SDL_Init: which event times this video backend gets right.
    void configure_stamps(std::string_view video_driver) { stamps_.configure(video_driver); }

    // Whether a key event is a repeat as far as the game is concerned (KeyPresses).
    bool key_repeat(size_t scancode, bool down, bool sdl_repeat) { return presses_.repeat(scancode, down, sdl_repeat); }

    void keyboard_focus_lost() { presses_.clear(); }

    void rebuild_binds(const nlohmann::json &binds) { binds_.rebuild(binds); }

    // Switching paths hands everything pending to the view first; the keys held now carry over.
    void set_timed(bool on, Input &input, const std::set<std::string> &held_codes) {
        if (on == timed_) {
            return;
        }
        commit_pending(input);
        input.consume_all();
        timed_ = on;
        restart(input, held_codes);
    }

    void begin_pump(Input &input, uint64_t now, const InputScheduler &scheduler, uint64_t tick_ns) {
        stamps_.begin_pump(now);
        queue_.begin_pump(int64_t(scheduler.first_boundary(tick_ns)), int64_t(tick_ns), scheduler.capped, input.pitch);
    }

    // A gameplay SDL motion event, stamped |stamp| and read from SDL's queue at |received|.
    void motion(Input &input, uint64_t stamp, uint64_t received, double x, double y) {
        if (!timed_) {
            input.accumulate(x, y);
            return;
        }
        if (!std::isfinite(x) || !std::isfinite(y)) {
            return;
        }
        const uint64_t event_time = stamps_.time(EventStamps::kMotion, stamp, received);
        const int64_t at = queue_.stamp(int64_t(event_time), int64_t(received), queue_.motion_tail());
        queue_.add_motion(at, x, input.pitch_degrees(y));
    }

    // A key or mouse button went down or up. A movement key's change of state is queued for the tick it was made in.
    // Repeats and wheel notches are not edges.
    void
    key(std::set<std::string> &held_codes,
        const std::string &code,
        bool down,
        bool wheel,
        uint64_t stamp,
        uint64_t received) {
        const bool changes = down != held_codes.contains(code);
        if (timed_ && changes && !wheel && binds_.of(code)) {
            const uint64_t event_time = stamps_.time(EventStamps::kKeys, stamp, received);
            const int64_t at = queue_.stamp(int64_t(event_time), int64_t(received), queue_.edge_tail());
            queue_.add_edge(at, code, down);
        }
        if (down) {
            held_codes.insert(code);
        } else {
            held_codes.erase(code);
        }
    }

    // Before the frame's ticks. When nothing will tick, pending input goes to the view now.
    void begin_frame(Input &input, bool simulating, uint64_t wall_ns) {
        if (!simulating) {
            commit_pending(input);
            input.consume_all();
        } else if (!timed_) {
            input.arrived(wall_ns);
        }
    }

    // The input for the tick starting at |sim_ns|; advances |sim_ns| to its end. --frames is deterministic with no
    // wall clock to place events on, so each of its ticks takes everything waiting.
    void take_tick(Input &input, uint64_t &sim_ns, uint64_t tick_ns, bool frames_mode) {
        tick_contributed_ = false;
        if (frames_mode) {
            commit_pending(input);
            input.consume_all();
            return;
        }
        const uint64_t start = sim_ns;
        sim_ns += tick_ns;
        if (timed_) {
            const size_t edges = queue_.pending_edges();
            const auto reports =
                    queue_.take(int64_t(sim_ns), [&input](const TimedInput::Report &report) { apply(input, report); });
            const bool folded_edges = queue_.take_folded_edges();
            tick_contributed_ = reports != 0 || edges != queue_.pending_edges() || folded_edges;
        } else {
            input.take_tick(start, sim_ns);
        }
    }

    bool tick_contributed() const { return tick_contributed_; }

    // The movement buttons a tick holds: its own key state, or (legacy) the keys as last polled.
    uint32_t held(const std::set<std::string> &held_codes) const {
        return timed_ ? binds_.held(queue_.keys) : binds_.held(held_codes);
    }

    // Motion still pending was made at the old sensitivity, so it goes into the view first.
    void set_sensitivity(Input &input, double sensitivity) {
        if (sensitivity == input.sensitivity) {
            return;
        }
        commit_pending(input);
        input.set_sensitivity(sensitivity);
    }

    // The render camera's view: the input plus everything not yet in a tick. The queue keeps it.
    Input preview(const Input &input) const {
        Input view = input;
        view.consume_all();
        queue_.peek([&view](const TimedInput::Report &report) { apply(view, report); });
        return view;
    }

    double pending_counts(const Input &input) const { return input.pending_counts() + queue_.pending_x; }

    // ---- barriers: every client transition uses one; none may leave a released key held -----------------------

    // Capture on or off (menu, focus change, replay controls), chat open or close: nothing held, nothing pending.
    // Action repeat suppression survives capture changes; losing keyboard ownership resets it separately.
    // Held keys are cleared rather than resynced from SDL_GetKeyboardState: a key-up lost while the menu had focus or
    // while SDL restarted its raw-input thread is missing from SDL's state too, so a resync would invent a hold.
    void release(Input &input, std::set<std::string> &held_codes) {
        held_codes.clear();
        input.clear();
        queue_.reset();
    }

    // A new attempt, seek or the end of spectating: the clock and pending input start again, physical holds carry
    // over.
    void restart(Input &input, const std::set<std::string> &held_codes) {
        input.clear();
        queue_.reset();
        held_scratch_.clear();
        for (const auto &code : held_codes) {
            if (binds_.of(code)) {
                held_scratch_.push_back(code);
            }
        }
        queue_.seed_keys(held_scratch_);
    }

    // Settings applied (the binds may have changed): keys and pulses released, pending view motion kept.
    void settings_changed(Input &input, std::set<std::string> &held_codes) {
        input.held = 0;
        input.pulse = 0;
        held_codes.clear();
        queue_.release_keys();
    }

private:
    bool timed_ = true;
    bool tick_contributed_ = false;
    TimedInput queue_;
    BindTable binds_;
    EventStamps stamps_;
    KeyPresses presses_;
    std::vector<std::string> held_scratch_;

    static void apply(Input &input, const TimedInput::Report &report) {
        input.motion_events += report.reports;
        input.yaw_counts += report.x;
        input.pitch = std::clamp(input.pitch + report.p, report.pitch_min, report.pitch_max);
    }

    void commit_pending(Input &input) {
        queue_.flush([&input](const TimedInput::Report &report) { apply(input, report); });
    }
};

}  // namespace native
