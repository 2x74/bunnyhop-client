#pragma once
// The bunny's leg layer (web player/bunny/legs.ts): presentation-only corrections on the skinning matrices after the
// body animation, before the ears, the gun, the knife and the inspect read them. Nothing here reaches the simulation.
//
//   foot planting   standing, stopping and turning slowly on the ground, a foot that touches down locks to its spot in
//                   the world; two-bone IK keeps it there while the body moves on. A lock that drifts too far or turns
//                   too much becomes a short lifted step, one foot at a time. Corrections are bounded and eased. With a
//                   ground probe each planted foot sits on the ground under it.
//   jump phases     in the air the feet extend after take-off, tuck at the apex and reach for the ground on the way
//                   down (crouched: a steady tuck).
//   landings        a landing where the player stays down sinks the pelvis with the feet planted, by how hard it was;
//                   a hard contact the player jumps straight out of compresses the legs for ~0.1 s.
//   idle            after a moment standing still, a slow seeded weight shift from foot to foot.
//   climb / swim    on a ladder the feet step with the climb, swimming they kick slowly. Without those flags motion
//                   that isn't ballistic only leaves the jump phases out: push lifts look the same as ladders.
//
// Everything is smoothed exactly in dt, so 60 and 240 fps agree. The arithmetic follows the web's own rounding
// (bone matrices in float, joints in double) so the oracle test can compare the two closely.
#include <algorithm>
#include <array>
#include <cmath>
#include <functional>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace native_actor_anim {

enum class LegMode { ground, air, floating, climb, swim };

// Ground height (Source z) under a world point, or nothing when there's no ground within reach.
using GroundProbe = std::function<std::optional<double>(double x, double y, double z)>;

struct LegInput {
    double dt = 0;
    bool snap = false, grounded = true, crouched = false;
    // Velocity (Source u/s) and the feet origin (Source world).
    std::array<double, 3> velocity{}, position{};
    // The model's feet yaw and its bank about the hips (degrees), and the bank's pivot height above the feet.
    double yaw = 0, bank = 0, bank_hip = 36;
    // The visual clock (s): the idle shift's phase.
    double time = 0;
    // On a ladder / the water level (2+ swims), when the source knows.
    bool ladder = false;
    int water = 0;
    // Reduced motion scales the idle shift, the jump phases and the rebound (1 = full).
    double motion = 1;
};

// Landing strength 0..1 from the vertical speed before touchdown: a plain jump landed ~0.35, a drop more.
inline double land_strength(double vz) {
    constexpr double gentle_fall_speed = 150, strength_scale_speed = 350;
    const double over = -vz - gentle_fall_speed;
    return over > 0 ? 1 - std::exp(-over / strength_scale_speed) : 0;
}

inline double leg_smooth01(double x) {
    const double t = std::clamp(x, 0., 1.);
    return t * t * (3 - 2 * t);
}

// How hard a contact is for the rebound: nothing for ordinary hops, from 400 u/s, full by ~1100.
inline double contact_hardness(double vz) {
    constexpr double rebound_from_speed = 400, rebound_span_speed = 700;
    return leg_smooth01((-vz - rebound_from_speed) / rebound_span_speed);
}

class LegLayer {
public:
    // Planting fades in below plant_speed (u/s) and is full below plant_full_speed.
    static constexpr double plant_speed = 200, plant_full_speed = 110;
    // A locked foot steps when the animation's foot is this far from it (units) or turned this far (degrees).
    static constexpr double step_distance = 7, step_yaw_degrees = 26;
    // A lock further than this from the animated foot is let go.
    static constexpr double max_reach = 12;
    // Pelvis drop (units) at full landing strength.
    static constexpr double land_drop = 4.2;
    // The ankle's height above the ground in the standing pose.
    static constexpr double ankle_height = 4.35;

    // This frame's pelvis offset (model z), planting weight, body movement and steps since the last reset.
    double pelvis_drop = 0, plant = 0;
    LegMode mode = LegMode::ground;
    int steps = 0;
    // The feet's world positions after the layer (Source), left then right.
    std::array<double, 6> feet_world{};

    LegLayer(std::span<const std::string> names, std::span<const float> bind, double seed = 0)
        : bind_(bind.begin(), bind.end())
        , seed_(seed) {
        auto index = [&](const std::string &name) {
            const auto found = std::find(names.begin(), names.end(), name);
            return found == names.end() ? -1 : int(found - names.begin());
        };
        for (int side = 0; side < 2; ++side) {
            const std::string prefix = side ? "ValveBiped.Bip01_R_" : "ValveBiped.Bip01_L_";
            auto &foot = feet_[size_t(side)];
            foot.thigh = index(prefix + "Thigh");
            foot.calf = index(prefix + "Calf");
            foot.foot = index(prefix + "Foot");
            foot.toe = index(prefix + "Toe0");
            for (int bone : {foot.thigh, foot.calf, foot.foot, foot.toe})
                if (bone >= 0) foot.bones[size_t(foot.bone_count++)] = bone;
        }
        bones_ = int(names.size());
    }

    void set_seed(double seed) { seed_ = seed; }

    void set_ground_probe(GroundProbe probe) { probe_ = std::move(probe); }

    void reset() {
        for (auto &foot : feet_) {
            foot.locked = foot.has_previous = false;
            foot.step_time = -1;
            foot.weight = 0;
        }
        steps = 0;
        ground_time_ = contact_time_ = air_time_ = idle_time_ = climb_ = 0;
        ground_frames_ = 0;
        landed_ = true;
        land_time_ = rebound_time_ = far_past;
        land_strength_ = rebound_strength_ = air_weight_ = float_weight_ = plant_weight_ = acceleration_age_ = 0;
        pelvis_drop = plant = 0;
    }

    // Applies the layer to `skin`: the rig's model-space skinning matrices (3x4, Source axes).
    void apply(std::span<float> skin, const LegInput &input) {
        if (input.snap) {
            reset();
            // A snap onto the ground counts as standing already, not as touching down.
            if (input.grounded) {
                ground_frames_ = 1;
                contact_time_ = grace_seconds;
                landed_ = true;
            }
        }
        const double dt = input.snap ? 0 : input.dt;
        track_contact(input, dt);
        Pelvis pelvis = move_pelvis(skin, input, dt);
        place_feet(skin, input, dt, pelvis);
    }

private:
    struct Foot {
        int thigh = -1, calf = -1, foot = -1, toe = -1;
        std::array<int, 4> bones{};
        int bone_count = 0;
        bool locked = false;
        // The lock's world position and the model yaw when it locked.
        double lock_x = 0, lock_y = 0, lock_z = 0, lock_yaw = 0;
        // A step in progress: its time (s, < 0 = none) and where and how it started.
        double step_time = -1, step_x = 0, step_y = 0, step_z = 0, step_yaw = 0;
        double weight = 0;
        // The animated ankle's world position last frame (its stance test).
        double previous_x = 0, previous_y = 0;
        bool has_previous = false;
    };

    struct Pelvis {
        double dz = 0, dy = 0, rebound = 0;
    };

    struct Frame {
        double cos_yaw, sin_yaw, cos_bank, sin_bank, hip;
    };

    using Vec = std::array<double, 3>;
    using Matrix = std::array<float, 12>;

    static constexpr double far_past = 1e9, grace_seconds = .025, min_air_seconds = .2, acceleration_span = .04;
    static constexpr double still_speed = 40, still_body_share = .7, step_seconds = .2, step_lift = 2.6;
    static constexpr double rebound_units = 5, max_pelvis = 6, degrees = 3.14159265358979323846 / 180;

    std::vector<float> bind_;
    std::array<Foot, 2> feet_;
    int bones_ = 0;
    GroundProbe probe_;
    double seed_ = 0;
    double ground_time_ = 0, contact_time_ = 0, air_time_ = 0, air_vz_ = 0, acceleration_vz_ = 0;
    double acceleration_age_ = 0, land_time_ = far_past, land_strength_ = 0, rebound_time_ = far_past;
    double rebound_strength_ = 0, air_weight_ = 0, float_weight_ = 0, plant_weight_ = 0, idle_time_ = 0, climb_ = 0;
    int ground_frames_ = 0;
    bool landed_ = true;

    static double toward(double current, double target, double rate, double dt) {
        return current + (target - current) * (1 - std::exp(-rate * dt));
    }

    // Starts flat from zero, peaks (1) at `peak` and eases out by ~4 peaks.
    static double envelope(double t, double peak) {
        constexpr double envelope_end = 8;
        const double x = t / peak;
        return x <= 0 || x > envelope_end ? 0 : x * x * std::exp(2 * (1 - x));
    }

    static double wrap180(double a) { return std::fmod(std::fmod(a + 180, 360.) + 360, 360.) - 180; }

    bool stable(const LegInput &input) const {
        return input.grounded && ground_frames_ >= 2 && contact_time_ >= grace_seconds - 1e-6;
    }

    // Contact bookkeeping in contact time, not frames, apart from the two-frame bhop guard.
    void track_contact(const LegInput &input, double dt) {
        const double vz = input.velocity[2];
        contact_time_ = input.grounded && ground_frames_ > 0 ? contact_time_ + dt
                        : input.grounded && input.snap       ? contact_time_
                                                             : 0;
        ground_frames_ = input.grounded ? ground_frames_ + 1 : 0;
        ground_time_ = input.grounded ? ground_time_ + dt : 0;
        land_time_ += dt;
        rebound_time_ += dt;
        if (!input.grounded)
            track_air(vz, dt);
        else
            track_ground(input, vz, dt);
        const bool climbing = input.ladder, swimming = !climbing && input.water >= 2;
        const bool floating = !climbing && !swimming && !input.grounded && float_weight_ > .5;
        mode = climbing         ? LegMode::climb
               : swimming       ? LegMode::swim
               : floating       ? LegMode::floating
               : input.grounded ? LegMode::ground
                                : LegMode::air;
        // Rises as soon as the feet leave, falls only once the player is really on the ground.
        const bool settled = stable(input);
        air_weight_ = dt > 0 ? toward(air_weight_, settled ? 0 : 1, settled ? 22 : 18, dt) : input.grounded ? 0 : 1;
        if (input.snap && !input.grounded) air_time_ = 1;
    }

    // Airborne without gravity (a ladder, water, a push lift): measured over at least acceleration_span, since the
    // velocity is often constant within a tick and per-frame changes at 240 fps would read as no gravity.
    void track_air(double vz, double dt) {
        constexpr double floating_acceleration = 60, floating_speed = 260, float_in_rate = 5, float_out_rate = 12;
        acceleration_age_ += dt;
        if (acceleration_age_ >= acceleration_span) {
            const double acceleration = std::abs(vz - acceleration_vz_) / acceleration_age_;
            const bool floating = acceleration < floating_acceleration && std::abs(vz) < floating_speed;
            float_weight_ = toward(
                    float_weight_, floating ? 1 : 0, floating ? float_in_rate : float_out_rate, acceleration_age_
            );
            acceleration_vz_ = vz;
            acceleration_age_ = 0;
        }
        air_time_ += dt;
        air_vz_ = vz;
        landed_ = false;
    }

    void track_ground(const LegInput &input, double vz, double dt) {
        constexpr double float_out_rate = 12;
        // Touchdown: a hard one rebounds at once, also when the player jumps straight out of it.
        if (ground_frames_ == 1 && air_time_ >= min_air_seconds) {
            rebound_strength_ = contact_hardness(air_vz_) * input.motion;
            rebound_time_ = 0;
        }
        if (!landed_ && stable(input)) {
            landed_ = true;
            if (air_time_ >= min_air_seconds) {
                land_time_ = contact_time_ - grace_seconds;
                land_strength_ = land_strength(air_vz_);
            }
            air_time_ = 0;
        }
        float_weight_ = toward(float_weight_, 0, float_out_rate, dt);
        acceleration_vz_ = vz;
        acceleration_age_ = 0;
    }

    // Landing sink, hard rebound and the idle weight shift, applied to every bone.
    Pelvis move_pelvis(std::span<float> skin, const LegInput &input, double dt) {
        constexpr double sink_peak = .09, rebound_peak = .045, crouched_sink = .4, release_rate = 30;
        constexpr double grounded_rebound = .5, airborne_rebound = .35;
        Pelvis pelvis;
        // A jump out of a landing lets the sink go quickly.
        if (!input.grounded) land_strength_ *= std::exp(-release_rate * dt);
        const double sink =
                land_drop * land_strength_ * envelope(land_time_, sink_peak) * (input.crouched ? crouched_sink : 1);
        pelvis.rebound = rebound_units * rebound_strength_ * envelope(rebound_time_, rebound_peak);
        pelvis.dz -= sink + (input.grounded ? pelvis.rebound * grounded_rebound : pelvis.rebound * airborne_rebound);
        idle_shift(input, dt, pelvis);
        pelvis.dz = std::clamp(pelvis.dz, -max_pelvis, max_pelvis);
        pelvis_drop = pelvis.dz;
        if (pelvis.dz != 0 || pelvis.dy != 0)
            for (int i = 0; i < bones_; i++) {
                skin[size_t(i) * 12 + 7] = float(skin[size_t(i) * 12 + 7] + pelvis.dy);
                skin[size_t(i) * 12 + 11] = float(skin[size_t(i) * 12 + 11] + pelvis.dz);
            }
        return pelvis;
    }

    // Two incommensurate periods with a per-model phase: never a visible loop, never in step with another bunny.
    void idle_shift(const LegInput &input, double dt, Pelvis &pelvis) {
        constexpr double idle_speed = 5, shift_after = 1.2, shift_ease = 1.5, two_pi = 6.283;
        constexpr double sway_units = .75, slow_sway_units = .25, dip_units = .35;
        constexpr double sway_rate = 1.13, slow_sway_rate = .47, slow_phase = 1.7;
        const double speed = std::hypot(input.velocity[0], input.velocity[1]);
        const bool idle = input.grounded && speed < idle_speed && !input.ladder;
        idle_time_ = idle ? idle_time_ + dt : 0;
        const double weight = leg_smooth01((idle_time_ - shift_after) / shift_ease) * input.motion;
        if (weight <= 0) return;
        const double phase = seed_ * two_pi;
        pelvis.dy = weight
                    * (sway_units * std::sin(input.time * sway_rate + phase)
                       + slow_sway_units * std::sin(input.time * slow_sway_rate + phase * slow_phase));
        pelvis.dz -= weight * dip_units * std::abs(std::sin(input.time * sway_rate + phase));
    }

    void place_feet(std::span<float> skin, const LegInput &input, double dt, const Pelvis &pelvis) {
        constexpr double plant_in_rate = 10, plant_out_rate = 16;
        const double speed = std::hypot(input.velocity[0], input.velocity[1]);
        const bool climbing = input.ladder, swimming = !climbing && input.water >= 2;
        const double plant_target = stable(input) && !climbing && !swimming
                                            ? leg_smooth01((plant_speed - speed) / (plant_speed - plant_full_speed))
                                            : 0;
        plant_weight_ = dt > 0 ? toward(plant_weight_,
                                        plant_target,
                                        plant_target > plant_weight_ ? plant_in_rate : plant_out_rate,
                                        dt)
                               : plant_target;
        plant = plant_weight_;
        if (!plant_weight_)
            for (auto &foot : feet_) {
                foot.locked = false;
                foot.step_time = -1;
            }
        climb_ += dt * std::abs(input.velocity[2]);
        const Frame frame = {
                std::cos(input.yaw * degrees),
                std::sin(input.yaw * degrees),
                std::cos(input.bank * degrees),
                std::sin(input.bank * degrees),
                input.bank_hip
        };
        for (size_t k = 0; k < 2; k++)
            place_foot(skin, input, dt, pelvis, frame, k, speed);
    }

    void place_foot(
            std::span<float> skin,
            const LegInput &input,
            double dt,
            const Pelvis &pelvis,
            const Frame &frame,
            size_t k,
            double speed
    ) {
        auto &foot = feet_[k];
        if (foot.foot < 0 || foot.calf < 0 || foot.thigh < 0) return;
        const Vec animated = joint(skin, foot.foot);
        Vec target = animated;
        // On the ground the pelvis sink and shift move the body, not the feet.
        const double on_ground = 1 - air_weight_;
        target[2] -= pelvis.dz * on_ground;
        target[1] -= pelvis.dy * on_ground;
        air_pose(input, pelvis, k, target);
        double yaw_fix = 0;
        if (plant_weight_ > .001)
            yaw_fix = planted(input, dt, pelvis, frame, k, speed, animated, target);
        else {
            foot.weight = 0;
            foot.has_previous = false;
        }
        solve_leg(skin, k, target, yaw_fix);
        const Vec placed = joint(skin, foot.foot);
        feet_world[k * 3] = world_x(placed, input, frame);
        feet_world[k * 3 + 1] = world_y(placed, input, frame);
        feet_world[k * 3 + 2] = input.position[2] + placed[2];
    }

    // In the air: the jump phases, or the climb / swim motion.
    void air_pose(const LegInput &input, const Pelvis &pelvis, size_t k, Vec &target) const {
        const double weight = air_weight_ * (1 - plant_weight_);
        if (weight <= .001) return;
        double ox = 0, oz = 0;
        if (mode == LegMode::climb) {
            constexpr double units_per_climb_step = 24, climb_lift = 5, climb_reach = 1.5;
            const double cycle = std::fmod(climb_ / units_per_climb_step + double(k) * .5, 1.);
            oz = climb_lift * std::max(0., std::sin(cycle * 3.14159265358979323846 * 2));
            ox = climb_reach;
        } else if (mode == LegMode::swim) {
            constexpr double kick_units = 1.6, kick_rate = 3.1, swim_trail = -2;
            oz = kick_units * std::sin(input.time * kick_rate + double(k) * 3.14159265358979323846);
            ox = swim_trail;
        } else if (input.crouched) {
            constexpr double crouched_tuck = 1.5;
            oz = crouched_tuck;
        } else if (mode != LegMode::floating) {
            jump_phase(input, ox, oz);
            // The hard rebound compresses the legs right after the contact.
            constexpr double rebound_share = .65;
            oz += pelvis.rebound * rebound_share;
        }
        target[0] += ox * weight;
        target[2] += oz * weight;
    }

    // Take-off: extend down and back; apex: tuck up and forward; descent: reach down and forward for the ground.
    static void jump_phase(const LegInput &input, double &ox, double &oz) {
        constexpr double rise_speed = 280, apex_speed = 260, fall_speed = 420;
        const double vz = input.velocity[2];
        const double rise = leg_smooth01(vz / rise_speed), apex = 1 - leg_smooth01(std::abs(vz) / apex_speed);
        const double fall = leg_smooth01(-vz / fall_speed);
        oz = (-2.2 * rise * (1 - apex) + 4.5 * apex - 3 * fall * (1 - apex)) * input.motion;
        ox = (-1.5 * rise * (1 - apex) + 1.8 * apex + 2.2 * fall) * input.motion;
    }

    // On the ground and slow: planting. Moves `target` toward the planted spot; returns the foot's yaw correction.
    double
    planted(const LegInput &input,
            double dt,
            const Pelvis &pelvis,
            const Frame &frame,
            size_t k,
            double speed,
            const Vec &animated,
            Vec &target) {
        constexpr double contact_height = 1.4, release_height = 3, locked_heel_lift = .6, barely_moving_speed = 20;
        auto &foot = feet_[k];
        const double wx = world_x(animated, input, frame), wy = world_y(animated, input, frame);
        const double ground_here = ground(wx, wy, input);
        // In stance: down, and the animation has the foot nearly still in the world (a walk's planted foot), or the
        // body is barely moving at all.
        const bool still =
                !foot.has_previous || dt <= 0
                || std::hypot(wx - foot.previous_x, wy - foot.previous_y) / dt < still_speed + still_body_share * speed
                || speed < barely_moving_speed;
        const double sunk = std::max(0., -pelvis.dz);
        const bool contact = animated[2] - ankle_height < contact_height + sunk && still;
        update_lock(foot, input, dt, wx, wy, ground_here, contact, animated[2] - ankle_height > release_height + sunk);
        Vec goal = {wx, wy, ground_here};
        double goal_yaw = input.yaw, lift = 0;
        hold_or_step(k, input, wx, wy, goal, goal_yaw);
        if (foot.step_time >= 0) {
            const double e = leg_smooth01(foot.step_time / step_seconds);
            goal = {foot.step_x + (wx - foot.step_x) * e,
                    foot.step_y + (wy - foot.step_y) * e,
                    foot.step_z + (ground_here - foot.step_z) * e};
            goal_yaw = foot.step_yaw + wrap180(input.yaw - foot.step_yaw) * e;
            lift = step_lift * std::sin(3.14159265358979323846 * e);
        }
        const Vec model = to_model(goal[0], goal[1], goal[2] + ankle_height + lift, input, frame);
        // The animated foot's height above its plane is kept (a heel lifting in the animation stays lifted).
        const double animation_lift = std::max(0., animated[2] - ankle_height);
        const double w = plant_weight_;
        target[0] += (model[0] - target[0]) * w;
        target[1] += (model[1] - target[1]) * w;
        target[2] +=
                (model[2] + (foot.locked ? std::min(animation_lift, locked_heel_lift) : animation_lift) - target[2])
                * w;
        foot.weight = w;
        foot.previous_x = wx;
        foot.previous_y = wy;
        foot.has_previous = true;
        return wrap180(goal_yaw - input.yaw) * w;
    }

    void update_lock(
            Foot &foot,
            const LegInput &input,
            double dt,
            double wx,
            double wy,
            double ground_here,
            bool contact,
            bool lifted
    ) const {
        if (foot.step_time >= 0) {
            foot.step_time += dt;
            if (foot.step_time >= step_seconds) {
                foot.step_time = -1;
                lock(foot, input, wx, wy, ground_here);
            }
        } else if (!foot.locked && contact)
            lock(foot, input, wx, wy, ground_here);
        else if (foot.locked && lifted)
            foot.locked = false;  // the animation lifts it: let go
    }

    static void lock(Foot &foot, const LegInput &input, double wx, double wy, double ground_here) {
        foot.locked = true;
        foot.lock_x = wx;
        foot.lock_y = wy;
        foot.lock_z = ground_here;
        foot.lock_yaw = input.yaw;
    }

    // A locked foot holds its spot, or starts a step when it drifted or turned too far (one foot at a time).
    void hold_or_step(size_t k, const LegInput &input, double wx, double wy, Vec &goal, double &goal_yaw) {
        auto &foot = feet_[k];
        if (!foot.locked) return;
        const double distance = std::hypot(wx - foot.lock_x, wy - foot.lock_y);
        const double turn = std::abs(wrap180(input.yaw - foot.lock_yaw));
        if ((distance > step_distance || turn > step_yaw_degrees) && feet_[1 - k].step_time < 0) {
            foot.locked = false;
            foot.step_time = 0;
            steps++;
            foot.step_x = foot.lock_x;
            foot.step_y = foot.lock_y;
            foot.step_z = foot.lock_z;
            foot.step_yaw = foot.lock_yaw;
        } else if (distance > max_reach)
            foot.locked = false;
        else {
            goal = {foot.lock_x, foot.lock_y, foot.lock_z};
            goal_yaw = foot.lock_yaw;
        }
    }

    // Ground z under (x, y) relative to the feet origin: the probe's within reach of the feet, else the feet's plane.
    double ground(double x, double y, const LegInput &input) const {
        constexpr double probe_above = 24, ground_reach = 14;
        if (!probe_) return 0;
        const auto height = probe_(x, y, input.position[2] + probe_above);
        if (height && std::abs(*height - input.position[2]) < ground_reach) return *height - input.position[2];
        return 0;
    }

    // Model -> world: the bank about x (pivot at hip height), then the yaw about z.
    static double world_x(const Vec &p, const LegInput &input, const Frame &f) {
        const double banked_y = p[1] * f.cos_bank - (p[2] - f.hip) * f.sin_bank;
        return input.position[0] + p[0] * f.cos_yaw - banked_y * f.sin_yaw;
    }

    static double world_y(const Vec &p, const LegInput &input, const Frame &f) {
        const double banked_y = p[1] * f.cos_bank - (p[2] - f.hip) * f.sin_bank;
        return input.position[1] + p[0] * f.sin_yaw + banked_y * f.cos_yaw;
    }

    // World (x, y) and a z relative to the feet origin -> model space (undo the yaw, then the bank about the hips).
    static Vec to_model(double x, double y, double z_relative, const LegInput &input, const Frame &f) {
        const double lx = x - input.position[0], ly = y - input.position[1];
        const double mx = lx * f.cos_yaw + ly * f.sin_yaw, banked_y = -lx * f.sin_yaw + ly * f.cos_yaw;
        const double zb = z_relative - f.hip;
        return {mx, banked_y * f.cos_bank + zb * f.sin_bank, -banked_y * f.sin_bank + zb * f.cos_bank + f.hip};
    }

    // A bone's joint (its bind origin through a skinning matrix), model space.
    Vec joint_of(const float *m, int bone) const {
        const size_t b = size_t(bone) * 12;
        const double x = bind_[b + 3], y = bind_[b + 7], z = bind_[b + 11];
        Vec out;
        for (size_t r = 0; r < 3; r++)
            out[r] = double(m[r * 4]) * x + double(m[r * 4 + 1]) * y + double(m[r * 4 + 2]) * z + double(m[r * 4 + 3]);
        return out;
    }

    Vec joint(std::span<const float> skin, int bone) const { return joint_of(skin.data() + size_t(bone) * 12, bone); }

    // out = a * b for 3x4 rigid transforms, summed in double and stored in float like the web's Float32Arrays.
    static void concat(const float *a, const float *b, float *out) {
        float result[12];
        for (int r = 0; r < 3; r++) {
            const double a0 = a[r * 4], a1 = a[r * 4 + 1], a2 = a[r * 4 + 2], a3 = a[r * 4 + 3];
            for (int c = 0; c < 3; c++)
                result[r * 4 + c] = float(a0 * b[c] + a1 * b[4 + c] + a2 * b[8 + c]);
            result[r * 4 + 3] = float(a0 * b[3] + a1 * b[7] + a2 * b[11] + a3);
        }
        std::copy(result, result + 12, out);
    }

    static void premultiply(const Matrix &m, std::span<float> skin, int bone) {
        concat(m.data(), skin.data() + size_t(bone) * 12, skin.data() + size_t(bone) * 12);
    }

    // The shortest-arc rotation taking direction a onto direction b, about `pivot`.
    static Matrix rotation(Vec a, Vec b, const Vec &pivot) {
        const double la = std::hypot(a[0], a[1], a[2]), lb = std::hypot(b[0], b[1], b[2]);
        for (int k = 0; k < 3; k++) {
            a[size_t(k)] /= la ? la : 1;
            b[size_t(k)] /= lb ? lb : 1;
        }
        double x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
        const double s = std::hypot(x, y, z), c = std::clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1., 1.);
        if (s < 1e-9) return {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0};
        x /= s;
        y /= s;
        z /= s;
        const double t = 1 - c;
        const double r[9] = {
                t * x * x + c,
                t * x * y - s * z,
                t * x * z + s * y,
                t * x * y + s * z,
                t * y * y + c,
                t * y * z - s * x,
                t * x * z - s * y,
                t * y * z + s * x,
                t * z * z + c
        };
        Matrix out{};
        for (size_t row = 0; row < 3; row++) {
            for (size_t col = 0; col < 3; col++)
                out[row * 4 + col] = float(r[row * 3 + col]);
            out[row * 4 + 3] =
                    float(pivot[row] - (r[row * 3] * pivot[0] + r[row * 3 + 1] * pivot[1] + r[row * 3 + 2] * pivot[2]));
        }
        return out;
    }

    // A turn of `angle` radians about the vertical through `from`, then a move from `from` to `to`.
    static Matrix yaw_about(double angle, const Vec &from, const Vec &to) {
        const double c = std::cos(angle), s = std::sin(angle);
        return {float(c),
                float(-s),
                0,
                float(to[0] - (c * from[0] - s * from[1])),
                float(s),
                float(c),
                0,
                float(to[1] - (s * from[0] + c * from[1])),
                0,
                0,
                1,
                float(to[2] - from[2])};
    }

    // Two-bone IK for leg k: the ankle to `target` (clamped to the leg's reach) by turning the thigh about the hip and
    // the calf about the knee in the leg's own plane; the foot and toe keep the animation's orientation, turned by
    // `yaw` degrees about the vertical (a planted foot's lock).
    void solve_leg(std::span<float> skin, size_t k, const Vec &target, double yaw) const {
        const auto &f = feet_[k];
        const Vec hip = joint(skin, f.thigh), knee = joint(skin, f.calf), ankle = joint(skin, f.foot);
        if (std::abs(target[0] - ankle[0]) + std::abs(target[1] - ankle[1]) + std::abs(target[2] - ankle[2]) < 1e-4
            && std::abs(yaw) < 1e-4)
            return;
        Matrix foot0{}, toe0{};
        std::copy_n(skin.data() + size_t(f.foot) * 12, 12, foot0.data());
        if (f.toe >= 0) std::copy_n(skin.data() + size_t(f.toe) * 12, 12, toe0.data());
        const double thigh = distance(knee, hip), calf = distance(ankle, knee);
        Vec dir = {target[0] - hip[0], target[1] - hip[1], target[2] - hip[2]};
        const double length = std::hypot(dir[0], dir[1], dir[2]);
        const double reach = std::clamp(length, std::abs(thigh - calf) + .5, thigh + calf - .05);
        if (length < 1e-6) return;
        for (auto &v : dir)
            v /= length;
        const Vec new_knee = knee_position(hip, knee, dir, thigh, calf, reach);
        // Thigh: (knee - hip) onto (new knee - hip) about the hip; the calf, foot and toe come along.
        const Matrix turn_thigh = rotation(minus(knee, hip), minus(new_knee, hip), hip);
        for (int i = 0; i < f.bone_count; i++)
            premultiply(turn_thigh, skin, f.bones[size_t(i)]);
        // Calf: the moved ankle onto the target about the new knee.
        const Vec moved = joint(skin, f.foot);
        const Vec end = {hip[0] + dir[0] * reach, hip[1] + dir[1] * reach, hip[2] + dir[2] * reach};
        const Matrix turn_calf = rotation(minus(moved, new_knee), minus(end, new_knee), new_knee);
        for (int i = 0; i < f.bone_count; i++)
            if (f.bones[size_t(i)] != f.thigh) premultiply(turn_calf, skin, f.bones[size_t(i)]);
        // Foot and toe: the animation's orientation, turned about the vertical through the ankle, at the new ankle.
        const Vec placed = joint(skin, f.foot), original = joint_of(foot0.data(), f.foot);
        const Matrix place = yaw_about(yaw * degrees, original, placed);
        concat(place.data(), foot0.data(), skin.data() + size_t(f.foot) * 12);
        if (f.toe >= 0) concat(place.data(), toe0.data(), skin.data() + size_t(f.toe) * 12);
    }

    // The knee: on the circle around the hip-to-target line, on the side the current knee is (straight: forward).
    static Vec knee_position(const Vec &hip, const Vec &knee, const Vec &dir, double thigh, double calf, double reach) {
        Vec pole = minus(knee, hip);
        const double along = pole[0] * dir[0] + pole[1] * dir[1] + pole[2] * dir[2];
        for (int k = 0; k < 3; k++)
            pole[size_t(k)] -= along * dir[size_t(k)];
        const double pole_length = std::hypot(pole[0], pole[1], pole[2]);
        if (pole_length < 1e-4)
            pole = {1, 0, 0};
        else
            for (auto &v : pole)
                v /= pole_length;
        const double a = (thigh * thigh - calf * calf + reach * reach) / (2 * reach);
        const double h = std::sqrt(std::max(0., thigh * thigh - a * a));
        return {hip[0] + dir[0] * a + pole[0] * h,
                hip[1] + dir[1] * a + pole[1] * h,
                hip[2] + dir[2] * a + pole[2] * h};
    }

    static Vec minus(const Vec &a, const Vec &b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }

    static double distance(const Vec &a, const Vec &b) { return std::hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
};

}  // namespace native_actor_anim
