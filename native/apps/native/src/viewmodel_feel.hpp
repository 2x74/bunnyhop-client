#pragma once
// First-person movement feel, ported from the website: the knife viewmodel's bob, lag, tilt, crouch, landing dip,
// hard-landing settle and breathing (viewmodel/feel.ts ViewFeel), the gun's own response to speed, jumps, landings
// and strafes (viewmodel/guns/motion.ts GunMotion), the in-eye camera options (viewmodel/eye-feel.ts EyeFeel) and the
// hands' idle (viewmodel/idle.ts HandIdle, the grip idle in viewmodel/guns/anim.ts).
//
// Every spring and filter is solved exactly over a frame, so the same inputs at the same times give the same pose at
// 30 fps or 360. Nothing here allocates or reads a clock. viewmodel_feel_tests.cpp checks it against the website's
// code (viewmodel-feel-oracle.ts).
#include <algorithm>
#include <array>
#include <cmath>

namespace native_vm {

// Row-major 3x4: rotation columns forward, left, up of view space, translation in the last column.
using Matrix34 = std::array<float, 12>;

inline constexpr double pi = 3.14159265358979323846, euler = 2.71828182845904523536;
inline constexpr double radians_per_degree = pi / 180;
inline constexpr Matrix34 identity34 = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0};

// A damped spring: value and velocity.
struct Spring {
    double x = 0, v = 0;
};

// Advances `s` toward `target` by dt (omega in rad/s, zeta 1 = critical): exact for any dt, the target held.
inline void spring_step(Spring &s, double target, double omega, double zeta, double dt) {
    if (dt <= 0) return;
    const double y0 = s.x - target, v0 = s.v;
    double y = 0, vy = 0;
    if (zeta < .9999) {
        const double wd = omega * std::sqrt(1 - zeta * zeta);
        const double e = std::exp(-zeta * omega * dt);
        const double c = std::cos(wd * dt), sn = std::sin(wd * dt);
        const double b = (v0 + zeta * omega * y0) / wd;
        y = e * (y0 * c + b * sn);
        vy = e * (-zeta * omega * (y0 * c + b * sn) - y0 * wd * sn + b * wd * c);
    } else if (zeta <= 1.0001) {
        const double e = std::exp(-omega * dt);
        const double b = v0 + omega * y0;
        y = (y0 + b * dt) * e;
        vy = (b - omega * (y0 + b * dt)) * e;
    } else {
        const double r = omega * std::sqrt(zeta * zeta - 1);
        const double r1 = -zeta * omega + r, r2 = -zeta * omega - r;
        const double c2 = (v0 - r1 * y0) / (r2 - r1), c1 = y0 - c2;
        const double e1 = std::exp(r1 * dt), e2 = std::exp(r2 * dt);
        y = c1 * e1 + c2 * e2;
        vy = c1 * r1 * e1 + c2 * r2 * e2;
    }
    s.x = target + y;
    s.v = vy;
}

// spring_step with the target moving in a straight line from u0 to u1 over dt (exact).
inline void spring_ramp(Spring &s, double u0, double u1, double omega, double zeta, double dt) {
    if (dt <= 0) return;
    const double rate = (u1 - u0) / dt, lag = 2 * zeta * rate / omega;
    s.x -= u0 - lag;
    s.v -= rate;
    spring_step(s, 0, omega, zeta, dt);
    s.x += u1 - lag;
    s.v += rate;
}

// First-order lag toward an input moving in a straight line from u0 to u1 over dt (exact).
inline double follow(double x, double u0, double u1, double k, double dt) {
    if (dt <= 0) return x;
    const double kd = k * dt, e = std::exp(-kd);
    return e * x + (1 - e) * u0 + (u1 - u0) * (1 - (1 - e) / kd);
}

// How hard a landing reads, 0..1 from the vertical speed before touchdown (u/s, < 0): a flat bhop landing barely.
inline double land_impact(double vz) {
    const double over = -vz - 250;
    return over > 0 ? 1 - std::exp(-over / 600) : 0;
}

// How hard a landing is for the hard-landing responses: nothing below ~650 u/s, full by ~1200.
inline double hard_landing(double vz) {
    const double x = std::clamp((-vz - 650) / 550, 0., 1.);
    return x * x * (3 - 2 * x);
}

// A smooth cap: about x well under `limit`, levelling off at plus or minus `limit`.
inline double soft_limit(double x, double limit) {
    return limit > 0 ? limit * std::tanh(x / limit) : 0;
}

// Source angles (degrees) and an offset to a 3x4 (math.ts angleMatrix).
inline void angle_matrix(double pitch, double yaw, double roll, double ox, double oy, double oz, Matrix34 &out) {
    const double sp = std::sin(pitch * radians_per_degree), cp = std::cos(pitch * radians_per_degree);
    const double sy = std::sin(yaw * radians_per_degree), cy = std::cos(yaw * radians_per_degree);
    const double sr = std::sin(roll * radians_per_degree), cr = std::cos(roll * radians_per_degree);
    out = {float(cp * cy),
           float(sr * sp * cy - cr * sy),
           float(cr * sp * cy + sr * sy),
           float(ox),
           float(cp * sy),
           float(sr * sp * sy + cr * cy),
           float(cr * sp * sy - sr * cy),
           float(oy),
           float(-sp),
           float(sr * cp),
           float(cr * cp),
           float(oz)};
}

// out = a * b for 3x4s (rig.ts concat).
inline Matrix34 concat(const Matrix34 &a, const Matrix34 &b) {
    Matrix34 out{};
    for (int r = 0; r < 3; r++) {
        for (int c = 0; c < 4; c++) {
            float value = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c];
            if (c == 3) value += a[r * 4 + 3];
            out[r * 4 + c] = value;
        }
    }
    return out;
}

// What the feel reads each frame (viewmodel.ts ViewmodelInput).
struct FeelInput {
    std::array<double, 3> velocity{};
    bool grounded = true;
    // Eye height above the feet (64 standing, 46 ducked).
    double view_offset_z = 64;
    // Commanded side move (plus or minus 450).
    double sidemove = 0;
    double yaw = 0, pitch = 0;
    // Vertical speed of a landing since the last frame (negative), or 0.
    double landed = 0;
};

// The knife viewmodel's feel; the gun rides it too (clamp_gun_feel). feel.ts ViewFeel.
class ViewFeel {
public:
    void reset() {
        bob_time = bob_speed = vertical_bob = lateral_bob = 0;
        have_facing = have_duck = false;
        lag = {};
        tilt = shift = duck = 0;
        dip = hard = {};
    }

    // `time`: the viewmodel clock (s), for the breathing. Returns the view-space 3x4.
    const Matrix34 &update(double dt, const FeelInput &s, double bob_amount, double sway_amount, double time) {
        advance_bob(dt, s, bob_amount);
        advance_lag(dt, s, sway_amount);
        advance_body(dt, s, bob_amount, sway_amount);
        compose(s, bob_amount, time);
        return matrix;
    }

    const Matrix34 &value() const { return matrix; }

private:
    // CS:S cl_bob: cycle 0.8, bobup 0.5, the speed toward its target at 320 u/s per second.
    static constexpr double bob_speed_limit = 320, bob_cycle = .8, bob_up = .5;
    // Most the mouse lag may offset the hands (units, before Sway): feel.ts LAG_LIMIT.
    static constexpr double lag_limit = 2, lag_catch_up = 5, lag_max = 1.5, lag_offset_scale = 5;
    // Landing dip spring and its kick at land_impact 1; hard-landing settle (critically damped, soft-capped).
    static constexpr double dip_omega = 11, dip_zeta = .72, dip_kick = 48;
    static constexpr double hard_omega = 20, hard_max = .9;
    static constexpr double breathing_period_seconds = 3.8;

    void advance_bob(double dt, const FeelInput &s, double bob_amount) {
        const double horizontal = s.grounded ? std::hypot(s.velocity[0], s.velocity[1]) : 0;
        const double target = std::clamp(horizontal, -bob_speed_limit, bob_speed_limit), s0 = bob_speed;
        const double reach = std::abs(target - s0) / bob_speed_limit;
        double speed = target;
        if (reach >= dt) {
            speed = s0 + (target > s0 ? 1 : target < s0 ? -1 : 0) * bob_speed_limit * dt;
            bob_time += dt * (speed + s0) / (2 * bob_speed_limit);
        } else {
            bob_time += (reach * (s0 + target) * .5 + (dt - reach) * target) / bob_speed_limit;
        }
        bob_speed = speed;
        const double v = speed * .005;
        vertical_bob = std::clamp(v * .3 + v * .7 * std::sin(bob_phase(bob_time, bob_cycle)), -7., 4.) * bob_amount;
        lateral_bob = std::clamp(v * .3 + v * .7 * std::sin(bob_phase(bob_time, 2 * bob_cycle)), -7., 4.) * bob_amount;
    }

    void advance_lag(double dt, const FeelInput &s, double sway_amount) {
        const double cy = std::cos(s.yaw * radians_per_degree), sy = std::sin(s.yaw * radians_per_degree);
        const double cp = std::cos(s.pitch * radians_per_degree), sp = std::sin(s.pitch * radians_per_degree);
        const std::array<double, 3> forward = {cp * cy, cp * sy, -sp};
        // A view snapped (nearly) straight around would leave the lag stuck at full strength: start it over.
        if (!have_facing || distance(forward, facing) > 1.9) {
            facing = previous_forward = forward;
            have_facing = true;
        }
        if (dt > 0) {
            double k = lag_catch_up;
            const double before = distance(forward, facing);
            if (before > lag_max) k *= before / lag_max;
            for (int i = 0; i < 3; i++)
                facing[i] = follow(facing[i], previous_forward[i], forward[i], k, dt);
            const double length = std::hypot(facing[0], facing[1], facing[2]);
            for (auto &value : facing)
                value /= length > 0 ? length : 1;
        }
        previous_forward = forward;
        const double dx = forward[0] - facing[0], dy = forward[1] - facing[1], dz = forward[2] - facing[2];
        const double diff = std::hypot(dx, dy, dz);
        const double scale = diff > 1e-6 ? soft_limit(lag_offset_scale * diff, lag_limit) / diff * sway_amount : 0;
        const double ox = -dx * scale, oy = -dy * scale, oz = -dz * scale;
        lag[0] = ox * forward[0] + oy * forward[1] + oz * forward[2];
        lag[1] = -ox * sy + oy * cy;
        lag[2] = ox * sp * cy + oy * sp * sy + oz * cp;
    }

    // Strafe tilt and counter-shift, crouch, landing dip and the hard-landing settle.
    void advance_body(double dt, const FeelInput &s, double bob_amount, double sway_amount) {
        constexpr double strafe_rate = 7, strafe_tilt_degrees = 3.2, strafe_shift = .35, side_full = 450;
        constexpr double duck_rate = 10, duck_range = 18, standing_eye = 64;
        const double side = std::clamp(s.sidemove / side_full, -1., 1.);
        const double k = 1 - std::exp(-dt * strafe_rate);
        tilt += (side * strafe_tilt_degrees * sway_amount - tilt) * k;
        shift += (side * strafe_shift * sway_amount - shift) * k;
        const double duck_target = std::clamp((standing_eye - s.view_offset_z) / duck_range, 0., 1.);
        if (!(dt > 0) || !have_duck) {
            duck_in = duck_target;
            have_duck = true;
        }
        duck = follow(duck, duck_in, duck_target, duck_rate, dt);
        duck_in = duck_target;
        spring_step(dip, 0, dip_omega, dip_zeta, dt);
        spring_step(hard, 0, hard_omega, 1, dt);
        if (s.landed < 0) {
            dip.v -= land_impact(s.landed) * dip_kick * bob_amount;
            // Critically damped: a kick v peaks at v / (omega e).
            hard.v -= hard_landing(s.landed) * hard_max * hard_omega * euler * std::min(1., bob_amount / .5);
        }
    }

    void compose(const FeelInput &s, double bob_amount, double time) {
        const double dip_units = std::clamp(dip.x, -4., 2.);
        const double settle = soft_limit(hard.x, hard_max);
        const double breathe = std::sin(time * (2 * pi / breathing_period_seconds)) * bob_amount;
        const double pitch = s.pitch > 180 ? s.pitch - 360 : s.pitch;
        const double fx = vertical_bob * .4 + lag[0] - pitch * .035 - duck * .4;
        const double fy = -lateral_bob * .2 + lag[1] + pitch * .03 + shift + duck * .25;
        const double fz =
                vertical_bob * .1 + lag[2] - pitch * .02 - duck * .55 + dip_units * .7 + breathe * .07 + settle;
        const double angle_pitch = -vertical_bob * .4 + breathe * .12 + dip_units * -1.6 - settle * 1.4;
        const double angle_yaw = -lateral_bob * .3;
        const double angle_roll = vertical_bob * .5 + tilt - duck * 1.5;
        angle_matrix(angle_pitch, angle_yaw, angle_roll, fx, fy, fz, matrix);
    }

    static double distance(const std::array<double, 3> &a, const std::array<double, 3> &b) {
        return std::hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    }

    // cl_bob's phase (radians) for bob time `t` and cycle length `length`: a rise and a fall half.
    static double bob_phase(double t, double length) {
        const double c = std::fmod(t, length) / length;
        return c < bob_up ? pi * c / bob_up : pi + pi * (c - bob_up) / (1 - bob_up);
    }

    Matrix34 matrix = identity34;
    double bob_time = 0, bob_speed = 0, vertical_bob = 0, lateral_bob = 0;
    // CS:S m_vecLastFacing and the view's forward at the last update.
    std::array<double, 3> facing{}, previous_forward{};
    bool have_facing = false, have_duck = false;
    std::array<double, 3> lag{};
    double tilt = 0, shift = 0, duck = 0, duck_in = 0;
    Spring dip, hard;
};

// The knife's feel for a gun: its offset stays a nudge (guns/pose.ts clampFeel, FEEL_MAX).
inline Matrix34 clamp_gun_feel(const Matrix34 &feel) {
    constexpr float forward_max = 2, left_max = 2.5f, up_max = 2.5f, down_max = 4;
    Matrix34 out = feel;
    out[3] = std::clamp(out[3], -forward_max, forward_max);
    out[7] = std::clamp(out[7], -left_max, left_max);
    out[11] = std::clamp(out[11], -down_max, up_max);
    return out;
}

// Gun classes (guns/types.ts GunDef.cls), each with its weight on every response.
enum class GunClass { pistol, smg, shotgun, rifle, sniper };

inline double gun_weight(GunClass gun) {
    switch (gun) {
        case GunClass::pistol:
            return .8;
        case GunClass::smg:
            return 1;
        case GunClass::shotgun:
        case GunClass::rifle:
            return 1.15;
        case GunClass::sniper:
            return 1.3;
    }
    return 1;
}

// The gun's own feel (guns/motion.ts GunMotion): idle drift and the response to speed, jumps, landings and strafes,
// as a 3x4 in viewmodel space about the right grip.
class GunMotion {
public:
    // Bob and sway amounts, and the reduced-motion scale (reduced_motion.hpp).
    double bob = 1, sway = 1, motion = 1;

    void reset() {
        springs = {};
        targets = {};
        have_velocity = false;
        lateral_acceleration = 0;
    }

    // `input` null: idle drift only. `pivot`: the right grip in viewmodel space.
    const Matrix34 &update(double dt, GunClass gun, const FeelInput *input, const std::array<float, 3> &pivot) {
        const double weight = gun_weight(gun) * motion;
        const double bob_amount = bob * weight, sway_amount = sway * weight;
        clock += dt;
        Targets want{};
        Kicks kicks{};
        if (input && dt > 0) read_input(dt, *input, bob_amount, sway_amount, want, kicks);
        step_springs(dt, want);
        apply_kicks(kicks, bob_amount);
        compose(pivot, bob_amount);
        return matrix;
    }

private:
    static constexpr double lateral_rate = 8, spring_zeta = .7, position_limit = 1.2, angle_limit = 3;
    static constexpr int forward = 0, left = 1, up = 2, pitch = 3, yaw = 4, roll = 5;

    using Targets = std::array<double, 6>;

    struct Kicks {
        bool jumped = false;
        double tug = 1, landed = 0;
    };

    static double smooth(double a, double b, double x) {
        const double t = std::clamp((x - a) / (b - a), 0., 1.);
        return t * t * (3 - 2 * t);
    }

    void read_input(double dt, const FeelInput &input, double bob_amount, double sway_amount, Targets &want, Kicks &k) {
        constexpr double tuck_from = 300, tuck_full = 1000, air_speed = 300, jump_speed = 80, real_jump_seconds = .15;
        const double vx = input.velocity[0], vy = input.velocity[1], vz = input.velocity[2];
        const double fast = smooth(tuck_from, tuck_full, std::hypot(vx, vy));
        want[forward] -= .55 * fast * bob_amount;
        want[up] -= .25 * fast * bob_amount;
        want[pitch] += .5 * fast * bob_amount;
        if (!input.grounded) {
            const double air = std::clamp(vz / air_speed, -1., 1.) * (1 - .9 * fast);
            want[up] -= .35 * air * bob_amount;
            want[pitch] += .8 * air * bob_amount;
        }
        k.jumped = was_grounded && !input.grounded && vz > jump_speed;
        // A bhop touches the ground for a tick: its jump gives a fraction of a real jump's tug.
        k.tug = ground_seconds > real_jump_seconds ? 1 : .15;
        ground_seconds = input.grounded ? ground_seconds + dt : 0;
        k.landed = input.landed;
        was_grounded = input.grounded;
        read_strafe(dt, input, sway_amount, want);
    }

    // The strafe acceleration: the exact derivative of the velocity low-passed at lateral_rate.
    void read_strafe(double dt, const FeelInput &input, double sway_amount, Targets &want) {
        constexpr double acceleration_limit = 3000, acceleration_full = 1500;
        const double vx = input.velocity[0], vy = input.velocity[1];
        if (!have_velocity) {
            smoothed = last_velocity = {vx, vy};
            have_velocity = true;
        }
        smoothed[0] = follow(smoothed[0], last_velocity[0], vx, lateral_rate, dt);
        smoothed[1] = follow(smoothed[1], last_velocity[1], vy, lateral_rate, dt);
        last_velocity = {vx, vy};
        const double yaw_radians = input.yaw * radians_per_degree;
        const double lateral =
                lateral_rate
                * (-std::sin(yaw_radians) * (vx - smoothed[0]) + std::cos(yaw_radians) * (vy - smoothed[1]));
        lateral_acceleration = std::clamp(lateral, -acceleration_limit, acceleration_limit);
        const double amount = std::clamp(lateral_acceleration / acceleration_full, -1., 1.);
        want[left] -= .45 * amount * sway_amount;
        want[roll] -= 1.8 * amount * sway_amount;
    }

    void step_springs(double dt, const Targets &want) {
        const double omega = std::sqrt(90.);
        for (int i = 0; i < 6; i++) {
            const double from = i == yaw ? 0 : targets[i], to = i == yaw ? 0 : want[i];
            spring_ramp(springs[i], from, to, omega, spring_zeta, dt);
        }
        if (dt > 0)
            for (int i = 0; i < 6; i++)
                if (i != yaw) targets[i] = want[i];
    }

    void apply_kicks(const Kicks &k, double bob_amount) {
        if (k.jumped) {
            springs[up].v -= 5 * bob_amount * k.tug;
            springs[pitch].v += 22 * bob_amount * k.tug;
        }
        if (k.landed < 0) {
            const double hard = land_impact(k.landed) * 2;
            springs[up].v -= 4.5 * hard * bob_amount;
            springs[pitch].v += 16 * hard * bob_amount;
        }
    }

    void compose(const std::array<float, 3> &pivot, double bob_amount) {
        std::array<double, 6> out{};
        for (int i = 0; i < 3; i++)
            out[i] = soft_limit(springs[i].x, position_limit);
        for (int i = 3; i < 6; i++)
            out[i] = soft_limit(springs[i].x, angle_limit);
        const double t = clock;
        const double idle_pitch = (.22 * std::sin(t * 1.46) + .08 * std::sin(t * 2.71 + 1.3)) * bob_amount;
        const double idle_yaw = (.28 * std::sin(t * 1.03 + .7) + .06 * std::sin(t * 2.33)) * bob_amount;
        const double idle_roll = .35 * std::sin(t * 1.21 + 2.1) * bob_amount;
        const double idle_up = .05 * std::sin(t * 1.46 + .5) * bob_amount;
        angle_matrix(out[pitch] + idle_pitch, out[yaw] + idle_yaw, out[roll] + idle_roll, 0, 0, 0, matrix);
        const double px = pivot[0], py = pivot[1], pz = pivot[2];
        const double offset[3] = {out[forward], out[left], out[up] + idle_up};
        for (int r = 0; r < 3; r++)
            matrix[r * 4 + 3] =
                    float(pivot[r] - (matrix[r * 4] * px + matrix[r * 4 + 1] * py + matrix[r * 4 + 2] * pz)
                          + offset[r]);
    }

    Matrix34 matrix = identity34;
    double clock = 0;
    std::array<Spring, 6> springs{};
    // The springs' targets at the last update: each step ramps from these to this frame's.
    Targets targets{};
    bool was_grounded = true;
    // Seconds on the ground (a bhop touches it for a tick; a real jump starts from standing or running).
    double ground_seconds = 1;
    std::array<double, 2> smoothed{}, last_velocity{};
    bool have_velocity = false;
    double lateral_acceleration = 0;
};

// In-eye camera options (eye-feel.ts EyeFeel), both off by default and render only: neither touches the view angles,
// the simulation's eye, aim or input.
class EyeFeel {
public:
    static constexpr double settle_max_units = 1.8, speed_fov_degrees = 3;
    static constexpr double speed_fov_on = 750, speed_fov_off = 550;

    // Camera height offset this frame (units, <= 0) and FOV to add (degrees, >= 0).
    double z = 0, fov = 0;

    void reset() {
        settle = {};
        z = fov = 0;
        fast = false;
    }

    // `landed`: the vertical speed of a landing this frame (< 0) or 0; `speed`: the horizontal speed; `motion`: the
    // reduced-motion scale (the settle shrinks with it, the speed FOV only shows at full motion).
    void update(double dt, double landed, double speed, bool settle_on, bool speed_fov_on_setting, double motion = 1) {
        constexpr double settle_omega = 16, fov_ease_seconds = .7, fov_snap = .01;
        if (dt <= 0) return;
        spring_step(settle, 0, settle_omega, 1, dt);
        if (settle_on && landed < 0) {
            // A critically damped kick peaks at v / (w e): sized so the drop peaks at settle_max_units x hardness.
            const double hardness = hard_landing(landed) * motion;
            if (hardness > 0) settle.v -= settle_max_units * hardness * settle_omega * euler;
        }
        z = settle_on ? std::clamp(settle.x, -settle_max_units, 0.) : 0;
        if (!settle_on) settle = {};
        if (speed > speed_fov_on)
            fast = true;
        else if (speed < speed_fov_off)
            fast = false;
        const double want = speed_fov_on_setting && fast && motion >= 1 ? speed_fov_degrees : 0;
        fov += (want - fov) * (1 - std::exp(-dt / fov_ease_seconds));
        if (std::abs(fov - want) < fov_snap) fov = want;
    }

private:
    Spring settle;
    bool fast = false;
};

// The knife hand's idle (idle.ts HandIdle): the wrist relaxing and firming up, the index and pinky easing off the
// handle, and a small settle when an action hands back to idle. Angles in degrees for Arm.wrist / Arm.curl.
struct HandIdlePose {
    double flex = 0, deviation = 0, index = 0, pinky = 0;
};

class HandIdle {
public:
    void reset() {
        weight = 0;
        was_idle = true;
        settle = {};
    }

    void update(double dt, bool idle) {
        constexpr double fade_in = .6, fade_out = .08, settle_omega = 15, settle_zeta = .42, settle_kick = 34;
        if (dt <= 0) return;
        if (idle && !was_idle) settle.v -= settle_kick;
        was_idle = idle;
        weight = idle ? std::min(1., weight + dt / fade_in) : std::max(0., weight - dt / fade_out);
        spring_step(settle, 0, settle_omega, settle_zeta, dt);
    }

    // The pose at viewmodel time `t` scaled by `amount` (Bob over its default, at most 1.5); all zero when still.
    HandIdlePose pose(double t, double amount) const {
        constexpr double threshold = 1e-3, finger_threshold = .05;
        const double w = weight * weight * (3 - 2 * weight) * amount;
        const double settled = settle.x * amount;
        HandIdlePose out;
        if (w < threshold && std::abs(settled) < threshold) return out;
        out.flex = w * (1.2 * std::sin(t * .861 + .4) + .45 * std::sin(t * 1.21 + 2.2)) + settled;
        out.deviation = w * .9 * std::sin(t * .566 + 1.1);
        if (w > threshold) {
            const auto ease = [t](double rate, double phase) {
                return std::pow(std::max(0., std::sin(t * rate + phase)), 3);
            };
            const double index = 5 * w * ease(.94, .3), pinky = 4 * w * ease(.71, 2.6);
            if (index > finger_threshold) out.index = index;
            if (pinky > finger_threshold) out.pinky = pinky;
        }
        return out;
    }

private:
    double weight = 0;
    bool was_idle = true;
    Spring settle;
};

// The gun hands' grip idle (guns/anim.ts overlays): after a quiet second or two the trigger finger eases off the
// trigger and the support fingers relax; a clip handing back to idle ends with the support hand settling its grip.
struct GripIdlePose {
    // GunPose.indexOff and leftOpen (0..1 of each one's authored range).
    double index_off = 0, left_open = 0;
};

// Per frame, in the animator's order: events (quiet_reset), update(dt), a clip ending (clip_ended), then pose().
class GripIdle {
public:
    // A shot, a click or a clip starting: everything back at once.
    void quiet_reset() { quiet = 0; }

    // A clip handed back to idle; `settles`: it had the support hand working (reload, shotgun end, silencer, draw,
    // inspect), so the hand settles its grip.
    void clip_ended(bool settles) {
        quiet = 0;
        if (settles) settle_seconds = 0;
    }

    // A new gun, a restart or a seek: straight to a fresh idle.
    void reset() {
        quiet = clock = 0;
        settle_seconds = not_settling;
    }

    void update(double dt) {
        quiet += dt;
        clock += dt;
        settle_seconds += dt;
    }

    // `motion`: the reduced-motion scale.
    GripIdlePose pose(double motion = 1) const {
        constexpr double quiet_from = 1.2, quiet_fade = 1.5, settle_end = .5;
        GripIdlePose out;
        const double q = std::clamp((quiet - quiet_from) / quiet_fade, 0., 1.);
        const double w = q * q * (3 - 2 * q) * motion;
        const auto ease = [this](double rate, double phase) {
            return std::pow(std::max(0., std::sin(clock * rate + phase)), 2);
        };
        if (w > 0) {
            out.index_off = .28 * w * ease(.83, .6);
            out.left_open = .16 * w * ease(.61, 2.4);
        }
        if (settle_seconds < settle_end)
            out.left_open = std::max(out.left_open, .3 * bump(settle_seconds, .02, .45) * motion);
        return out;
    }

private:
    static constexpr double not_settling = 1e9;

    // inspects/kit.ts bump: 0 at a, a peak shortly after, back to 0 by b.
    static double bump(double t, double a, double b) {
        constexpr double decay = 2.2, peak_scale = 1.9;
        if (t <= a || t >= b) return 0;
        const double u = (t - a) / (b - a);
        return std::sin(pi * u) * std::exp(-decay * u) * peak_scale;
    }

    double quiet = 0, clock = 0, settle_seconds = not_settling;
};

// Landings for the feel: the lowest vertical speed of a tick that touched down since the last frame (main.ts landVz).
class LandingWatch {
public:
    void tick(bool grounded, double vertical_speed) {
        if (have_last && !last_grounded && grounded) landed = std::min(landed, last_vertical_speed);
        have_last = true;
        last_grounded = grounded;
        last_vertical_speed = vertical_speed;
    }

    // The landing since the last frame (< 0) or 0, and starts the next frame's.
    double take() {
        const double out = landed;
        landed = 0;
        return out;
    }

    void reset() {
        landed = 0;
        have_last = false;
    }

private:
    double landed = 0, last_vertical_speed = 0;
    bool have_last = false, last_grounded = true;
};

// The in-eye camera options in live play (main.ts): landings fed every simulation tick, the settle and FOV read every
// frame in first person.
class EyeCamera {
public:
    void configure(bool settle, bool speed_fov) {
        settle_on = settle;
        speed_fov_on = speed_fov;
    }

    void tick(bool grounded, double vertical_speed) { landing.tick(grounded, vertical_speed); }

    // A frame in your own eyes; `flying`: practice noclip or Infinite's flight, where the settle stays off.
    void frame(double dt, double horizontal_speed, bool flying, double motion) {
        feel.update(dt, landing.take(), horizontal_speed, settle_on && !flying, speed_fov_on, motion);
    }

    // A frame seen any other way (third person, a replay, spectating): the landing passes unused.
    void skip_frame() { landing.take(); }

    // Units to add to the rendered eye's height (<= 0) and degrees to add to the FOV.
    double height() const { return feel.z; }

    double fov() const { return feel.fov; }

    void reset() {
        feel.reset();
        landing.reset();
    }

private:
    EyeFeel feel;
    LandingWatch landing;
    bool settle_on = false, speed_fov_on = false;
};

}  // namespace native_vm
