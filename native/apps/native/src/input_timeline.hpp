#pragma once
#include "event_stamps.hpp"
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
    static constexpr double kMaxFrameSeconds = .25;

    bool timed() const { return timed_; }
    const TimedInput &queue() const { return queue_; }
    TimedInput &queue() { return queue_; }
    const BindTable &binds() const { return binds_; }
    const EventStamps &stamps() const { return stamps_; }

    // Once, after SDL_Init: which event times this video backend gets right.
    void configure_stamps(std::string_view video_driver) { stamps_.configure(video_driver); }

    // Whether a key event is a repeat as far as the game is concerned (KeyPresses).
    bool key_repeat(size_t scancode, bool down, bool sdl_repeat) { return presses_.repeat(scancode, down, sdl_repeat); }

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

    // Where the next tick starts on SDL's clock: |accumulator| seconds of simulation are still due at |wall_ns|.
    // A tick's boundary is its end.
    static uint64_t tick_start_ns(uint64_t wall_ns, double accumulator) {
        const uint64_t behind_ns = uint64_t(std::max(0.0, accumulator) * 1e9);
        return behind_ns < wall_ns ? wall_ns - behind_ns : 0;
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
    void key(std::set<std::string> &held_codes, const std::string &code, bool down, bool wheel, uint64_t stamp,
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
        if (frames_mode) {
            commit_pending(input);
            input.consume_all();
            return;
        }
        const uint64_t start = sim_ns;
        sim_ns += tick_ns;
        if (timed_) {
            queue_.take(int64_t(sim_ns), [&input](double x, double p) { input.apply_report(x, p); });
        } else {
            input.take_tick(start, sim_ns);
        }
    }

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
        queue_.peek([&view](double x, double p) { view.apply_report(x, p); });
        return view;
    }

    double pending_counts(const Input &input) const { return input.pending_counts() + queue_.pending_x; }

    // ---- barriers: every client transition uses one; none may leave a released key held -----------------------

    // Capture on or off (menu, focus change, replay controls), chat open or close: nothing held, nothing pending.
    // Key-ups that arrive afterwards are no-ops, and the first press afterwards counts even if SDL calls it a repeat.
    // Held keys are cleared rather than resynced from SDL_GetKeyboardState: a key-up lost while the menu had focus or
    // while SDL restarted its raw-input thread is missing from SDL's state too, so a resync would invent a hold.
    void release(Input &input, std::set<std::string> &held_codes) {
        presses_.clear();
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
    TimedInput queue_;
    BindTable binds_;
    EventStamps stamps_;
    KeyPresses presses_;
    std::vector<std::string> held_scratch_;

    void commit_pending(Input &input) {
        queue_.flush([&input](double x, double p) { input.apply_report(x, p); });
    }
};

}  // namespace native
