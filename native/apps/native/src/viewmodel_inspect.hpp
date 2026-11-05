#pragma once
// The first-person knife inspect chain, ported from the website (viewmodel/inspects/combo.ts InspectCombo and the
// cancel timing of inspects/runtime.ts): tap for the knife's first trick, press again during it for the next, hold to
// keep a loop going; an attack blends it out, a draw stops it at once.
//
// The quiet style (Settings, Viewmodel, Inspect: Quiet) puts a restrained blade check in front of the knife's own
// tricks. It is yours only: replays and the third-person bunny start with the knife's own first trick, so a chain
// started from your own press decides whether it is quiet, and other presses (a replay's) never are.
#include "inspect_cues.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <span>
#include <vector>

namespace native_vm {

// One trick (combo.ts TrickSpec): its length, where it reaches and leaves the shared presented pose, when a re-press
// queues the next trick, the hold loop and the sound cues.
struct TrickSpec {
    double length = 0, enter = 0, exit = 0, open = 0;
    bool has_loop = false;
    double loop_from = 0, loop_to = 0;
    std::vector<std::pair<double, native_render::InspectCue>> cues;
};

// An exported trick ({duration, enter, exit, open, loop, cues: [[seconds, type]]}).
inline TrickSpec trick_from_json(const nlohmann::json &spec) {
    TrickSpec trick;
    trick.length = spec.at("duration").get<double>();
    trick.enter = spec.at("enter").get<double>();
    trick.exit = spec.at("exit").get<double>();
    trick.open = spec.at("open").get<double>();
    if (spec.contains("loop") && spec.at("loop").is_array()) {
        trick.has_loop = true;
        trick.loop_from = spec.at("loop").at(0).get<double>();
        trick.loop_to = spec.at("loop").at(1).get<double>();
    }
    for (const auto &cue : spec.value("cues", nlohmann::json::array())) {
        const auto type = cue.at(1).get<std::string>();
        const auto kind = type == "flip"   ? native_render::InspectCue::flip
                          : type == "spin" ? native_render::InspectCue::spin
                                           : native_render::InspectCue::regrip;
        trick.cues.emplace_back(cue.at(0).get<double>(), kind);
    }
    return trick;
}

// Blend times (s): an attack's cancel with the knife in the fist, its longest (mid-toss, turned round), a chain switch.
inline constexpr double cancel_blend_seconds = .065, cancel_blend_max_seconds = .17, chain_blend_seconds = .14;
inline constexpr unsigned max_hold_loops = 6;

inline double smooth_step(double x) {
    return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
}

// The cancel's blend for a knife `distance` units and `angle` radians from where the fist holds it.
inline double cancel_blend(double distance, double angle) {
    constexpr double far_units = 6, far_radians = 2.4;
    const double reach = std::min(1., std::max(distance / far_units, angle / far_radians));
    return cancel_blend_seconds + (cancel_blend_max_seconds - cancel_blend_seconds) * smooth_step(reach);
}

struct ComboSlot {
    int trick = -1;
    double t = 0;
};

// What to pose this frame: the trick playing, the one crossfading out of a chain switch, the mix between them and the
// inspect's weight against the base pose (1 while playing, falling to 0 through a cancel).
struct ComboPose {
    bool playing = false, crossfading = false;
    ComboSlot current, previous;
    double mix = 1, weight = 0;
};

// What one call caused: tricks that started (indices into the chain) and the cues they passed.
struct ComboEvents {
    std::array<int, 4> started{};
    size_t started_count = 0;
    native_render::InspectCueQueue *cues = nullptr;

    void start(int trick) {
        if (started_count < started.size()) started[started_count++] = trick;
    }
};

class InspectCombo {
public:
    // The chain to play (it must outlive its use); a different one cancels anything playing.
    void set_chain(std::span<const TrickSpec> chain) {
        if (chain.data() == chain_.data() && chain.size() == chain_.size()) return;
        chain_ = chain;
        reset();
    }

    std::span<const TrickSpec> chain() const { return chain_; }

    bool active() const { return playing_ && fade_length_ == 0; }

    int trick() const { return active() ? current_.trick : -1; }

    bool holding() const { return held_ && active(); }

    void reset() {
        playing_ = crossfading_ = false;
        fade_length_ = 0;
        buffered_ = queued_ = false;
        loops_ = 0;
    }

    void press(ComboEvents &events) {
        if (chain_.empty()) return;
        if (!active()) {
            begin(0, 0);
            events.start(0);
            return;
        }
        if (size_t(current_.trick + 1) >= chain_.size() || queued_) return;
        const auto &spec = chain_[size_t(current_.trick)];
        if (current_.t >= spec.exit)
            advance(events);
        else if (current_.t >= spec.open)
            queued_ = true;
        else
            buffered_ = true;
    }

    // An attack: blends out over `blend` seconds (cancel_blend).
    void cancel_attack(double blend) {
        if (!playing_) return;
        const bool was_active = active();
        buffered_ = queued_ = false;
        if (was_active) {
            fade_length_ = std::max(1e-3, blend);
            fade_ = 0;
        }
    }

    // A draw: stops at once (off screen).
    void cancel_draw() {
        buffered_ = queued_ = false;
        playing_ = crossfading_ = false;
        fade_length_ = 0;
    }

    void update(double dt, bool held, ComboEvents &events) {
        held_ = held;
        if (!playing_) return;
        if (fade_length_ > 0) {
            fade_ += dt;
            if (fade_ >= fade_length_) {
                playing_ = crossfading_ = false;
                fade_length_ = 0;
            }
            return;
        }
        if (crossfading_) {
            crossfade_seconds_ += dt;
            previous_.t = std::min(previous_.t + dt, chain_[size_t(previous_.trick)].length);
            if (crossfade_seconds_ >= chain_blend_seconds) crossfading_ = false;
        }
        advance_time(dt, held, events);
    }

    ComboPose pose() const {
        ComboPose out;
        out.playing = playing_;
        out.crossfading = crossfading_;
        out.current = current_;
        out.previous = previous_;
        out.mix = crossfading_ ? smooth_step(crossfade_seconds_ / chain_blend_seconds) : 1;
        out.weight = !playing_ ? 0 : fade_length_ > 0 ? 1 - smooth_step(fade_ / fade_length_) : 1;
        return out;
    }

private:
    void advance_time(double dt, bool held, ComboEvents &events) {
        const auto &spec = chain_[size_t(current_.trick)];
        const double t0 = current_.t;
        double t1 = t0 + dt;
        if (buffered_ && t1 >= spec.open) {
            buffered_ = false;
            if (size_t(current_.trick + 1) < chain_.size()) queued_ = true;
        }
        if (spec.has_loop && held && !queued_ && loops_ < max_hold_loops && t0 <= spec.loop_to && t1 > spec.loop_to) {
            cues(current_.trick, t0, spec.loop_to, events, false);
            t1 = spec.loop_from + (t1 - spec.loop_to);
            loops_++;
            cues(current_.trick, spec.loop_from, t1, events, true);
            current_.t = t1;
            return;
        }
        if (queued_ && t1 >= spec.exit) {
            cues(current_.trick, t0, spec.exit, events, false);
            current_.t = spec.exit;
            const double rest = t1 - spec.exit;
            advance(events);
            if (rest > 0) {
                const double from = current_.t;
                current_.t = std::min(chain_[size_t(current_.trick)].length, current_.t + rest);
                cues(current_.trick, from, current_.t, events, false);
            }
            return;
        }
        cues(current_.trick, t0, t1, events, false);
        if (t1 >= spec.length) {
            playing_ = crossfading_ = false;
            buffered_ = queued_ = false;
            return;
        }
        current_.t = t1;
    }

    void begin(int trick, double t) {
        crossfading_ = playing_;
        if (playing_) {
            previous_ = current_;
            crossfade_seconds_ = 0;
        }
        playing_ = true;
        current_ = {trick, t};
        fade_length_ = 0;
        buffered_ = queued_ = false;
        loops_ = 0;
    }

    void advance(ComboEvents &events) {
        const int next = current_.trick + 1;
        begin(next, chain_[size_t(next)].enter);
        events.start(next);
    }

    void cues(int trick, double from, double to, ComboEvents &events, bool from_inclusive) const {
        if (!events.cues) return;
        for (const auto &[seconds, cue] : chain_[size_t(trick)].cues)
            if ((from_inclusive ? seconds >= from : seconds > from) && seconds <= to) events.cues->push(cue);
    }

    std::span<const TrickSpec> chain_;
    bool playing_ = false, crossfading_ = false;
    ComboSlot current_, previous_;
    double crossfade_seconds_ = 0, fade_ = 0, fade_length_ = 0;
    bool buffered_ = false, queued_ = false, held_ = false;
    unsigned loops_ = 0;
};

}  // namespace native_vm
