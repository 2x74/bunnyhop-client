#pragma once
// SSJ ("speed of sixth jump") jump stats — the jump HUD bhop players know from
// the CS:S "SSJ: Advanced" plugin they type !ssj for.
//
// A port of apps/web/src/ssj/stats.ts, kept line for line against it so the
// native client reports the same numbers as the web game and as a CS:S server.
// Display only: computed from what the client already has each tick (the state
// before the tick, the command stepped, the tick's events) and never fed back
// into the simulation.
//
// On the arithmetic: the plugin is SourcePawn, whose floats are 32-bit, and the
// web reference reproduces that with Math.fround at every step. Here the
// arithmetic is simply float, which is the same thing as long as nothing widens
// it — so the targets that build this set -ffp-contract=off, and every
// intermediate below is a named float rather than one long expression.
//
// Bit-exactness with the web game is not claimed, and the web game does not
// claim it between JavaScript engines either: sample() needs cos and sin, whose
// last bit differs between implementations, which is why web/src/timer.ts
// confines itself to IEEE-exact operations and this file does not have to.
// Every reported field is truncated or rounded to two decimals, so a last-bit
// difference does not reach the HUD.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <optional>
#include <string>

namespace native {

/** 6th jump only, every jump, or every Nth jump (6, 12, 18 ... when N is 6). */
enum class SsjMode { sixth, every, every_nth, every_sixth = every_nth };

/** Ground ticks after which the jump count starts over (the plugins' BHOP_FRAMES). */
inline constexpr unsigned bhop_frames = 10;
/** Source's air acceleration caps the wish speed at 30 (CGameMovement::AirAccelerate). */
inline constexpr float air_wish_cap = 30.0f;
/** Gain this high gets the accent colour (bhop-get-stats calls 80-90 good). */
inline constexpr float good_gain = 80.0f;
/** JHUD colours (Settings -> Jump stats colours, on by default), by the gain the
 *  line shows: red 0-59%, orange 60-69%, green 70-79%, blue 80-89%, white 90%+. */
enum class GainBand { red, orange, green, blue, white };
inline GainBand gain_band(float gain) {
    return gain < 60 ? GainBand::red : gain < 70 ? GainBand::orange : gain < 80 ? GainBand::green : gain < 90 ? GainBand::blue : GainBand::white;
}

// Source IN_* bits. The same values native_input.hpp uses.
inline constexpr std::uint32_t ssj_in_jump = 1u << 1;
inline constexpr std::uint32_t ssj_in_forward = 1u << 3;
inline constexpr std::uint32_t ssj_in_back = 1u << 4;
inline constexpr std::uint32_t ssj_in_moveleft = 1u << 9;
inline constexpr std::uint32_t ssj_in_moveright = 1u << 10;

/** Player state before a tick. */
struct SsjState {
    const float *position = nullptr;
    const float *velocity = nullptr;
    bool grounded = false;
    bool on_ladder = false;
};

/** The command stepped this tick. Yaw in degrees. */
struct SsjCmd {
    float forward = 0, side = 0, yaw = 0;
    std::uint32_t buttons = 0;
};

struct SsjTick {
    bool jumped = false;
    /** The count starts over after a teleport. */
    bool teleported = false;
    /** Stood in a start zone before the tick: a jump from there starts the count over. */
    bool in_start = false;
    /** Practice noclip: like the plugins' MOVETYPE_NOCLIP, nothing is sampled. */
    bool noclip = false;
    /** Run time if the timer is running, for the time field. */
    std::optional<double> time;
};

struct SsjReport {
    /** Jump number in the chain (1 = the first after standing, or the last taken off in a start zone). */
    unsigned jump = 0;
    /** Horizontal speed at take-off, rounded down (u/s). */
    int speed = 0;
    /** Absent on jump 1 in "every jump" mode, where there is nothing to compare with. */
    std::optional<int> diff, height;
    std::optional<float> gain, sync, eff;
    std::optional<unsigned> strafes;
    std::optional<double> time;
};

/** Does |mode| report jump |n|? (6th: jump 6 only; every: all; every Nth: N, 2N, 3N ...) */
inline bool ssj_shows(SsjMode mode, unsigned n, unsigned interval = 6) {
    if (mode == SsjMode::every) return true;
    if (mode == SsjMode::sixth) return n == 6;
    return n > 0 && interval > 0 && n % interval == 0;
}

namespace ssj_detail {
inline constexpr float tick_interval = 0.01f;  // 100 tick; only the ratio of the distances is used
inline constexpr float eps = 1e-10f;
inline constexpr double pi = 3.14159265358979323846;

inline float len2(float x, float y) {
    const float sum = x * x + y * y;
    return float(std::sqrt(double(sum)));
}
/** SourcePawn RoundToFloor(x * 100.0 + 0.5) / 100.0. */
inline float round2(float v) {
    const float biased = v * 100.0f + 0.5f;
    return float(std::floor(double(biased)) / 100.0);
}
}  // namespace ssj_detail

class SsjTracker {
public:
    explicit SsjTracker(SsjMode mode = SsjMode::sixth) : mode_(mode) {}

    /** Jump number of the current chain (0 = none yet). */
    unsigned jump = 0;

    SsjMode mode() const { return mode_; }

    /** Switching modes starts the count over: each mode keeps its windows differently. */
    void set_mode(SsjMode mode) {
        if (mode == mode_) return;
        mode_ = mode;
        reset();
    }

    /** N for "every Nth jump" (at least 2; 1 would just be "every jump"). Changing it starts over. */
    unsigned interval() const { return interval_; }
    void set_interval(unsigned n) {
        n = std::max(2u, n);
        if (n == interval_) return;
        interval_ = n;
        reset();
    }

    /** Restart, teleport, a new replay: forget everything. */
    void reset() {
        clear_chain();
        ground_ticks_ = 0;
        prev_buttons_ = 0;
        initial_speed_ = initial_height_ = old_speed_ = old_height_ = 0;
    }

    /** One tick. |pre| is the state before it, |cmd| the command stepped. */
    std::optional<SsjReport> tick(const SsjState &pre, const SsjCmd &cmd, const SsjTick &t) {
        if (t.noclip) {
            ground_ticks_ = 0;
            prev_buttons_ = cmd.buttons;
            return std::nullopt;
        }
        if (!pre.grounded)
            for (const std::uint32_t key : {ssj_in_forward, ssj_in_moveleft, ssj_in_back, ssj_in_moveright})
                if ((cmd.buttons & key) && !(prev_buttons_ & key)) ++strafes_;
        prev_buttons_ = cmd.buttons;
        if (pre.grounded) {
            if (ground_ticks_++ > bhop_frames) clear_chain();
            if ((cmd.buttons & ssj_in_jump) && ground_ticks_ == 1) {
                if (t.in_start) clear_chain();
                sample(pre, cmd);
                ground_ticks_ = 0;
            }
        } else {
            if (!pre.on_ladder) sample(pre, cmd);
            ground_ticks_ = 0;
        }
        std::optional<SsjReport> report;
        if (t.jumped) report = on_jump(pre, t.time);
        if (t.teleported) reset();
        return report;
    }

private:
    void clear_chain() {
        jump = 0;
        clear_window();
    }
    void clear_window() {
        strafe_ticks_ = synced_ticks_ = 0;
        raw_gain_ = trajectory_ = dx_ = dy_ = 0;
        strafes_ = 0;
    }

    void sample(const SsjState &pre, const SsjCmd &cmd) {
        ++strafe_ticks_;
        const float vx = pre.velocity[0], vy = pre.velocity[1];
        dx_ = dx_ + vx * ssj_detail::tick_interval;
        dy_ = dy_ + vy * ssj_detail::tick_interval;
        trajectory_ = trajectory_ + ssj_detail::len2(vx, vy) * ssj_detail::tick_interval;
        // GetAngleVectors(angles, fore, side) flattened: forward (cos y, sin y), right (sin y, -cos y).
        const float y = float(double(cmd.yaw) * ssj_detail::pi / 180.0);
        const float c = float(std::cos(double(y)));
        const float s = float(std::sin(double(y)));
        const float wx = c * cmd.forward + s * cmd.side;
        const float wy = s * cmd.forward - c * cmd.side;
        // NormalizeVector is Source mathlib's VectorNormalize: |w| = sqrt(w·w + 1e-10). So with no
        // movement keys the wish speed is 1e-5, not 0, and the plugin counts a keyless air tick as
        // in sync with full gain. That is the observed server behaviour, not an oversight here.
        const float sq = wx * wx + wy * wy + ssj_detail::eps;
        const float inv = float(1.0 / std::sqrt(double(sq)));
        const float wishspeed = sq * inv;
        const float wishspd = std::min(wishspeed, air_wish_cap);
        const float current = vx * (wx * inv) + vy * (wy * inv);
        if (current < air_wish_cap) {
            ++synced_ticks_;
            raw_gain_ = raw_gain_ + (wishspd - std::fabs(current)) / wishspd;
        }
    }

    std::optional<SsjReport> on_jump(const SsjState &pre, std::optional<double> time) {
        // A second jump event with no air tick since the last one is ignored
        // (the plugin's double-fire guard).
        if (jump > 0 && strafe_ticks_ == 0) return std::nullopt;
        const unsigned n = ++jump;
        const float speed = ssj_detail::len2(pre.velocity[0], pre.velocity[1]);
        const float z = pre.position[2];
        std::optional<SsjReport> report;
        if (ssj_shows(mode_, n, interval_)) report = build(speed, z, time);
        // What the next report covers: every jump in "every", from jump 6 on in "6th" (only 6 is
        // shown), from each Nth jump in "every Nth".
        if ((mode_ == SsjMode::sixth && n >= 6) || mode_ == SsjMode::every ||
            (mode_ == SsjMode::every_nth && n % interval_ == 0)) {
            clear_window();
            old_speed_ = speed;
            old_height_ = z;
        }
        if ((mode_ == SsjMode::sixth && n == 1) || (mode_ == SsjMode::every_nth && n % interval_ == 1)) {
            initial_speed_ = speed;
            initial_height_ = z;
            dx_ = dy_ = 0;
        }
        return report;
    }

    SsjReport build(float speed, float z, std::optional<double> time) const {
        // "Every jump" shows only the speed on jump 1: there is no previous jump to compare with.
        const bool full = mode_ != SsjMode::every || jump > 1;
        const float ref_speed = mode_ == SsjMode::every ? old_speed_ : initial_speed_;
        const float ref_z = mode_ == SsjMode::every ? old_height_ : initial_height_;
        const unsigned ticks = strafe_ticks_;
        const float coeff = ticks > 0 ? (raw_gain_ / float(ticks)) * 100.0f : 0.0f;
        const float dist = std::min(ssj_detail::len2(dx_, dy_), trajectory_);
        const float eff = dist > 0 && trajectory_ > 0 ? (coeff * dist) / trajectory_ : 0.0f;
        SsjReport report;
        report.jump = jump;
        report.speed = int(std::floor(double(speed)));
        if (full) {
            report.diff = report.speed - int(std::floor(double(ref_speed)));
            report.height = int(std::floor(double(z))) - int(std::floor(double(ref_z)));
            report.strafes = strafes_;
        }
        if (full && ticks > 0) {
            report.gain = ssj_detail::round2(coeff);
            report.sync = (100.0f * float(synced_ticks_)) / float(ticks);
            report.eff = ssj_detail::round2(eff);
        }
        report.time = time;
        return report;
    }

    SsjMode mode_;
    unsigned interval_ = 6;
    unsigned ground_ticks_ = 0, strafe_ticks_ = 0, synced_ticks_ = 0, strafes_ = 0;
    float raw_gain_ = 0, trajectory_ = 0, dx_ = 0, dy_ = 0;
    std::uint32_t prev_buttons_ = 0;
    float initial_speed_ = 0, initial_height_ = 0, old_speed_ = 0, old_height_ = 0;
};

/** Which fields a report line shows, in the order they appear. */
struct SsjFields {
    bool speed = true, diff = true, gain = true, sync = true, strafes = true;
    bool eff = false, height = false, time = false;
};

namespace ssj_detail {
/** Shown precision is truncated, never rounded up: 99.96% sync is not "100%". */
inline std::string trunc1(float v) {
    char buffer[32];
    std::snprintf(buffer, sizeof(buffer), "%.1f", std::trunc(double(v) * 10.0) / 10.0);
    return buffer;
}
inline std::string signed_value(int v) { return (v > 0 ? "+" : "") + std::to_string(v); }
}  // namespace ssj_detail

/**
 * The report as one line: "Jump 6 · 1013 u/s (+87) · Gain 87.5% · Sync 92% · 5 strafes".
 * Fields without a value are left out.
 */
inline std::string ssj_text(const SsjReport &r, const SsjFields &fields) {
    static const std::string separator = " \xC2\xB7 ";  // " · "
    std::string out = "Jump " + std::to_string(r.jump);
    auto add = [&out](const std::string &item) { out += separator; out += item; };
    if (fields.speed) {
        std::string item = std::to_string(r.speed) + " u/s";
        if (fields.diff && r.diff) item += " (" + ssj_detail::signed_value(*r.diff) + ")";
        add(item);
    } else if (fields.diff && r.diff) {
        add(ssj_detail::signed_value(*r.diff) + " u/s");
    }
    if (fields.gain && r.gain) add("Gain " + ssj_detail::trunc1(*r.gain) + "%");
    if (fields.sync && r.sync) add("Sync " + std::to_string(int(std::trunc(double(*r.sync)))) + "%");
    if (fields.strafes && r.strafes) add(std::to_string(*r.strafes) + (*r.strafes == 1 ? " strafe" : " strafes"));
    if (fields.eff && r.eff) add("Eff " + std::to_string(int(std::trunc(double(*r.eff)))) + "%");
    if (fields.height && r.height) add("Height " + ssj_detail::signed_value(*r.height));
    return out;
}

}  // namespace native
