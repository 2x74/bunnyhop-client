#pragma once
// The bunny's upper body over the CS:S animations (web player/bunny/posture.ts, follow.ts, continuity.ts, v0.0.42):
//   posture       the knife set's stoop taken partly out: the chest turns back by a share of its lean, the head stops
//                 at level eyes, the hips rise a little on the ground.
//   follow        the chest and arms answer upward jolts (a jump, a bhop's bounce, a landing) through one damped
//   spring,
//                 and breathe standing still.
//   continuity    the jump sequence's snaps eased out over a tenth of a second.
// Presentation only, on the skinning matrices (3x4 rows, model space, z up). Eased exactly in dt, so frame rates agree.
#include "actor_springs.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <string>
#include <vector>

namespace native_actor_anim {

constexpr double posture_degrees_per_radian = 180 / 3.141592653589793;

// The share of the animation's lean taken out by state, the hips' rise on the ground (units), how much of the eyes'
// pitch the head may carry, and the share of the turn given back at the shoulders (posture.ts POSTURE).
struct PostureTable {
    double stand = .62, run = .5, air = .42, air_fast = .3, crouch = .3;
    double lift_units = 1.6, lift_run_units = .8;
    double head_follow = .7, arms = .6;
    double air_slow_speed = 300, air_fast_speed = 800, run_speed = 250;
};

inline constexpr PostureTable posture_table{};

// follow.ts FOLLOW: the spring, the load per u/s of jolt, what isn't a jolt (u/s^2), the most load, the degrees at load
// 1, and the breath.
struct FollowTable {
    double omega = 16, zeta = .45, gain = .0462, smooth_acceleration = 1500, max_load = 1.6;
    double chest_degrees = 4.5, arms_degrees = 8, head_share = .6;
    double breath_period_seconds = 3.6, breath_tip_degrees = .7, breath_rise_units = .14;
    double idle_speed = 40, idle_in_rate = 1.5, idle_out_rate = 8, on_rate = 4;
};

inline constexpr FollowTable follow_table{};

// continuity.ts SNAP_BLEND.
constexpr double snap_blend_seconds = .1;

// A bone and every CS:S bone under it (parents come before their children).
inline std::vector<int> bone_subtree(const std::vector<int> &parents, int cs_bones, int root) {
    std::vector<int> out{root};
    if (root < 0) return {};
    for (int i = root + 1; i < cs_bones && size_t(i) < parents.size(); i++)
        if (std::find(out.begin(), out.end(), parents[size_t(i)]) != out.end()) out.push_back(i);
    return out;
}

// Rotates the bones `sub` by `degrees` about the level axis (ax, ay, 0) through `bone`'s posed joint (posture.ts
// turnLevel). The rotation is kept in float, as the website's Float32Array is.
inline void turn_level(
        std::vector<float> &skin,
        const std::vector<float> &bind,
        const std::vector<int> &sub,
        int bone,
        double ax,
        double ay,
        double degrees
) {
    if (!degrees || bone < 0 || skin.size() < size_t(bone + 1) * 12 || bind.size() < size_t(bone + 1) * 12) return;
    const size_t o = size_t(bone) * 12;
    const double bx = bind[o + 3], by = bind[o + 7], bz = bind[o + 11];
    const double px = skin[o] * bx + skin[o + 1] * by + skin[o + 2] * bz + skin[o + 3];
    const double py = skin[o + 4] * bx + skin[o + 5] * by + skin[o + 6] * bz + skin[o + 7];
    const double pz = skin[o + 8] * bx + skin[o + 9] * by + skin[o + 10] * bz + skin[o + 11];
    const double c = std::cos(degrees / posture_degrees_per_radian), s = std::sin(degrees / posture_degrees_per_radian);
    const double t = 1 - c;
    float m[12] = {};
    m[0] = float(t * ax * ax + c);
    m[1] = float(t * ax * ay);
    m[2] = float(s * ay);
    m[4] = float(t * ax * ay);
    m[5] = float(t * ay * ay + c);
    m[6] = float(-s * ax);
    m[8] = float(-s * ay);
    m[9] = float(s * ax);
    m[10] = float(c);
    m[3] = float(px - (m[0] * px + m[1] * py + m[2] * pz));
    m[7] = float(py - (m[4] * px + m[5] * py + m[6] * pz));
    m[11] = float(pz - (m[8] * px + m[9] * py + m[10] * pz));
    for (int i : sub) {
        float *b = skin.data() + size_t(i) * 12;
        float v[12];
        for (int r = 0; r < 3; r++)
            for (int col = 0; col < 4; col++)
                v[r * 4 + col] =
                        float(double(m[r * 4]) * b[col] + double(m[r * 4 + 1]) * b[4 + col]
                              + double(m[r * 4 + 2]) * b[8 + col] + (col == 3 ? double(m[r * 4 + 3]) : 0));
        std::copy(v, v + 12, b);
    }
}

// The bones the posture and follow-through turn: two spine joints, the head and both upper arms, with their subtrees.
struct UpperBody {
    int spine1 = -1, spine2 = -1, head = -1;
    std::vector<int> sub1, sub2, sub_head;
    std::array<int, 2> arms{-1, -1};
    std::array<std::vector<int>, 2> sub_arms;

    UpperBody() = default;

    UpperBody(const std::vector<std::string> &names, const std::vector<int> &parents, int cs_bones) {
        const auto find = [&](const char *name) {
            const auto at = std::find(names.begin(), names.end(), std::string("ValveBiped.Bip01_") + name);
            return at == names.end() ? -1 : int(at - names.begin());
        };
        spine1 = find("Spine1");
        spine2 = find("Spine2");
        head = find("Head1");
        sub1 = bone_subtree(parents, cs_bones, spine1);
        sub2 = bone_subtree(parents, cs_bones, spine2);
        sub_head = bone_subtree(parents, cs_bones, head);
        arms = {find("L_UpperArm"), find("R_UpperArm")};
        for (size_t i = 0; i < 2; i++)
            sub_arms[i] = bone_subtree(parents, cs_bones, arms[i]);
    }

    bool valid() const { return spine1 >= 0 && spine2 >= 0 && head >= 0 && arms[0] >= 0 && arms[1] >= 0; }

    // The level axis across the chest (the chest's forward, bind -y, crossed with up), or false when it points straight
    // up or down. `pitch`: the forward's pitch in degrees (< 0 leaning forward).
    bool chest_axis(const std::vector<float> &skin, double &ax, double &ay, double *pitch = nullptr) const {
        const size_t o = size_t(spine2) * 12;
        const double fx = -skin[o + 1], fy = -skin[o + 5], fz = -skin[o + 9];
        const double fh = std::hypot(fx, fy);
        constexpr double level_epsilon = 1e-4;
        if (fh < level_epsilon) return false;
        ax = fy / fh;
        ay = -fx / fh;
        if (pitch) *pitch = std::atan2(fz, fh) * posture_degrees_per_radian;
        return true;
    }

    // The pitch (degrees) of a bone's forward as posed.
    static double pitch_of(const std::vector<float> &skin, int bone) {
        const size_t o = size_t(bone) * 12;
        return std::atan2(-skin[o + 9], std::hypot(skin[o + 1], skin[o + 5])) * posture_degrees_per_radian;
    }
};

// Exponential ease of `current` toward `target` at `rate` (1/s); a snap jumps there.
inline double posture_ease(double current, double target, double rate, double dt, bool snap) {
    if (snap) return target;
    if (dt <= 0) return current;
    return current + (target - current) * (1 - std::exp(-rate * dt));
}

class Posture {
public:
    // This frame's share, the turn it came to (degrees) and the hips' rise wanted (units).
    double share = 0, turn = 0, lift = 0;

    // `on`: the CS:S animations pose the body.
    void update(double dt, bool snap, bool on, bool grounded, bool crouched, double speed) {
        const auto &p = posture_table;
        constexpr double on_rate = 4, air_rate = 14, ground_rate = 5, crouch_rate = 10, speed_rate = 10;
        on_weight = posture_ease(on_weight, on ? 1 : 0, on_rate, dt, snap);
        // Off the ground at once, back on it slowly: a bhop's one ground tick is not standing.
        air_weight = posture_ease(air_weight, grounded ? 0 : 1, grounded ? ground_rate : air_rate, dt, snap);
        crouch_weight = posture_ease(crouch_weight, crouched ? 1 : 0, crouch_rate, dt, snap);
        run_weight = posture_ease(run_weight, smooth(speed / p.run_speed), speed_rate, dt, snap);
        const double fast = smooth((speed - p.air_slow_speed) / (p.air_fast_speed - p.air_slow_speed));
        fast_weight = posture_ease(fast_weight, fast, speed_rate, dt, snap);
        const double ground = p.stand + (p.run - p.stand) * run_weight;
        const double air = p.air + (p.air_fast - p.air) * fast_weight;
        const double up = ground + (air - ground) * air_weight;
        share = on_weight * (up + (p.crouch - up) * crouch_weight);
        lift = on_weight * (1 - crouch_weight) * (p.lift_units + (p.lift_run_units - p.lift_units) * run_weight);
    }

    // Turns the upper body back. `eye_pitch`: the view's pitch (degrees, + = down).
    void apply(std::vector<float> &skin, const std::vector<float> &bind, const UpperBody &body, double eye_pitch) {
        turn = 0;
        constexpr double unseen_share = 1e-4;
        if (share < unseen_share || !body.valid()) return;
        double ax = 0, ay = 0, lean = 0;
        if (!body.chest_axis(skin, ax, ay, &lean) || lean >= 0) return;
        turn = -lean * share;
        const double head_before = UpperBody::pitch_of(skin, body.head);
        turn_level(skin, bind, body.sub1, body.spine1, ax, ay, turn / 2);
        turn_level(skin, bind, body.sub2, body.spine2, ax, ay, turn / 2);
        for (size_t i = 0; i < 2; i++)
            turn_level(skin, bind, body.sub_arms[i], body.arms[i], ax, ay, -turn * posture_table.arms);
        // The head came up with the chest: it stops at level eyes (or where it looked, if that was higher).
        const double cap = std::max(head_before, -eye_pitch * posture_table.head_follow);
        const double over = head_before + turn - cap;
        constexpr double unseen_degrees = 1e-3;
        if (over > unseen_degrees) turn_level(skin, bind, body.sub_head, body.head, ax, ay, -over);
    }

private:
    double on_weight = 0, air_weight = 0, crouch_weight = 0, run_weight = 0, fast_weight = 0;

    static double smooth(double x) {
        const double t = std::clamp(x, 0., 1.);
        return t * t * (3 - 2 * t);
    }
};

class FollowThrough {
public:
    // The load now (+ = compressed) and the breath (-1..1, 0 when moving).
    double load = 0, breath = 0;

    explicit FollowThrough(double seed = 0) : seed(seed) {}

    void set_seed(double value) { seed = value; }

    // `vz`: the body's vertical speed (u/s); `time`: the visual clock (s).
    void update(double dt, bool snap, bool on, double vz, bool grounded, double speed, double time) {
        const auto &f = follow_table;
        const bool idle = grounded && speed < f.idle_speed;
        if (snap || dt <= 0 || !has_vz) {
            last_vz = vz;
            has_vz = true;
            if (snap) {
                load = velocity = 0;
                on_weight = on ? 1 : 0;
                idle_weight = idle ? 1 : 0;
            }
        } else {
            // The spring over the step, then the jolt (the speed sampled now is the state at this frame's time).
            const double jolt = std::max(0., vz - last_vz - f.smooth_acceleration * dt);
            last_vz = vz;
            spring_step(load, velocity, 0, f.omega, f.zeta, dt);
            load = std::clamp(load, -f.max_load, f.max_load);
            velocity += jolt * f.gain;
            on_weight += ((on ? 1 : 0) - on_weight) * (1 - std::exp(-f.on_rate * dt));
            const double idle_rate = idle ? f.idle_in_rate : f.idle_out_rate;
            idle_weight += ((idle ? 1 : 0) - idle_weight) * (1 - std::exp(-idle_rate * dt));
        }
        constexpr double two_pi = 2 * 3.141592653589793;
        breath = idle_weight * std::sin((time / f.breath_period_seconds + seed) * two_pi);
    }

    // `motion`: the reduced-motion scale.
    void apply(std::vector<float> &skin, const std::vector<float> &bind, const UpperBody &body, double motion) const {
        const auto &f = follow_table;
        const double k = on_weight * motion, shown_load = load * k, shown_breath = breath * k;
        constexpr double unseen = 1e-4;
        if ((std::abs(shown_load) < unseen && std::abs(shown_breath) < unseen) || !body.valid()) return;
        double ax = 0, ay = 0;
        if (!body.chest_axis(skin, ax, ay)) return;
        const double nod = -shown_load * f.chest_degrees + shown_breath * f.breath_tip_degrees;
        turn_level(skin, bind, body.sub1, body.spine1, ax, ay, nod);
        if (shown_load)
            for (size_t i = 0; i < 2; i++)
                turn_level(skin, bind, body.sub_arms[i], body.arms[i], ax, ay, -shown_load * f.arms_degrees);
        // The head gives most of the nod back (the eyes stay on the route), and all of the breath's tip.
        const double head = shown_load * f.chest_degrees * f.head_share - shown_breath * f.breath_tip_degrees;
        turn_level(skin, bind, body.sub_head, body.head, ax, ay, head);
        if (shown_breath) {
            const float rise = float(shown_breath * f.breath_rise_units);
            for (int i : body.sub2)
                skin[size_t(i) * 12 + 11] += rise;
        }
    }

private:
    double velocity = 0, last_vz = 0, on_weight = 0, idle_weight = 0, seed = 0;
    bool has_vz = false;
};

// When the main sequence changes or restarts, the difference between last frame's pose and the new one is kept and
// eased out over snap_blend_seconds.
class PoseContinuity {
public:
    // The weight of the kept difference this frame (1 at the snap, 0 when done).
    double weight = 0;

    // `floats`: the CS:S bones' share of the skin (12 per bone). The main sequence changes or restarts when its
    // activity or the jump count changes.
    void apply(std::vector<float> &skin, size_t floats, const std::string &activity, int jumps, double dt, bool snap) {
        floats = std::min(floats, skin.size());
        if (kept.size() != floats) {
            kept.assign(floats, 0);
            difference.assign(floats, 0);
            has = false;
        }
        if (snap || !has)
            elapsed = snap_blend_seconds;
        else if (activity != last_activity || jumps != last_jumps) {
            for (size_t i = 0; i < floats; i++)
                difference[i] = kept[i] - skin[i];
            elapsed = 0;
        } else
            elapsed += dt;
        last_activity = activity;
        last_jumps = jumps;
        const double x = elapsed / snap_blend_seconds;
        weight = x >= 1 ? 0 : 1 - x * x * (3 - 2 * x);
        if (weight > 0)
            for (size_t i = 0; i < floats; i++)
                skin[i] += float(difference[i] * weight);
        std::copy_n(skin.begin(), floats, kept.begin());
        has = true;
    }

private:
    std::vector<float> kept, difference;
    std::string last_activity;
    int last_jumps = 0;
    double elapsed = snap_blend_seconds;
    bool has = false;
};

}  // namespace native_actor_anim
