//! CS:S movement checks against analytical expectations, on a synthetic infinite floor (z = 0).

use bunnyhop_core::Settings;
use playsrc_collision::Hull;
use playsrc_movement::{self as movement, Command, Error, Player, State, StepInput, Trace, Tracer};

const DIST_EPSILON: f32 = 0.03125;

/// Solid half-space below z = 0 (and optionally a ceiling).
struct Floor;

impl Tracer for Floor {
    fn trace(&self, start: [f32; 3], end: [f32; 3], hull: Hull, _mask: u32) -> Result<Trace, Error> {
        let bottom = |p: [f32; 3]| p[2] + hull.mins[2];
        let (s, e) = (bottom(start), bottom(end));
        let miss =
            Trace { fraction: 1.0, start_solid: false, all_solid: false, end, normal: None, hit: None, contents: 0 };
        if s < 0.0 {
            return Ok(Trace {
                fraction: 0.0,
                start_solid: true,
                all_solid: e < 0.0,
                end: start,
                normal: Some([0.0, 0.0, 1.0]),
                hit: Some(0),
                contents: 1,
            });
        }
        if e >= DIST_EPSILON || e >= s {
            return Ok(miss);
        }
        let fraction = ((s - DIST_EPSILON) / (s - e)).clamp(0.0, 1.0);
        let end = [
            start[0] + (end[0] - start[0]) * fraction,
            start[1] + (end[1] - start[1]) * fraction,
            start[2] + (end[2] - start[2]) * fraction,
        ];
        Ok(Trace {
            fraction,
            start_solid: false,
            all_solid: false,
            end,
            normal: Some([0.0, 0.0, 1.0]),
            hit: Some(0),
            contents: 1,
        })
    }
}

struct Sim {
    settings: Settings,
    state: State,
    tick: u32,
}

impl Sim {
    fn new(settings: Settings, position: [f32; 3], velocity: [f32; 3], grounded: bool) -> Self {
        let state = State::from_player(
            Player { position, velocity, grounded, crouched: false, jump_latched: false },
            settings.policy(),
        );
        Self { settings, state, tick: 0 }
    }

    fn step(&mut self, forward: f32, side: f32, yaw: f32, jump: bool, crouch: bool) -> movement::StepResult {
        if self.settings.autohop {
            self.state.jump_latched = false;
            self.state.previous_jump = false;
        }
        let input = StepInput {
            command_number: self.tick,
            command: Command { forward, side, yaw_degrees: yaw, jump, crouch },
            ..Default::default()
        };
        let result = movement::step(&Floor, self.state, input, self.settings.configuration(), self.settings.policy())
            .unwrap_or_else(|e| panic!("{e:?}\nstate before: {:?}", self.state));
        self.state = result.state;
        self.tick += 1;
        result
    }

    fn hspeed(&self) -> f32 {
        (self.state.velocity[0].powi(2) + self.state.velocity[1].powi(2)).sqrt()
    }
}

/// Discrete Source jump apex: per-tick displacement is v_k = v0 - g*dt*k with
/// v0 = start + impulse - g*dt (half gravity before the jump, half right after it).
fn expected_apex(v0: f32, settings: Settings) -> f32 {
    let dt = settings.tick_interval;
    let mut v = v0;
    let mut z = 0.0f32;
    while v > 0.0 {
        z += v * dt;
        v -= settings.gravity * dt;
    }
    z
}

fn settle(sim: &mut Sim) {
    for _ in 0..20 {
        sim.step(0.0, 0.0, 0.0, false, false);
    }
    assert!(sim.state.ground.is_some(), "settled on floor");
}

fn jump_apex(crouch_before: bool, crouch_in_air: bool) -> (f32, f32) {
    let settings = Settings::css_bhop();
    let mut sim = Sim::new(settings, [0.0, 0.0, 0.0], [0.0; 3], true);
    settle(&mut sim);
    if crouch_before {
        for _ in 0..60 {
            sim.step(0.0, 0.0, 0.0, false, true);
        }
        assert!(sim.state.crouch.uses_crouched_hull(), "fully crouched before the jump");
    }
    let z0 = sim.state.position[2];
    let r = sim.step(0.0, 0.0, 0.0, true, crouch_before);
    assert!(r.jump_velocity[2] > 0.0, "jumped");
    let mut apex = sim.state.position[2];
    for _ in 0..200 {
        sim.step(0.0, 0.0, 0.0, false, crouch_before || crouch_in_air);
        apex = apex.max(sim.state.position[2]);
        if sim.state.ground.is_some() {
            break;
        }
    }
    (apex - z0, z0)
}

#[test]
fn standing_jump_apex_matches_discrete_source_jump() {
    let s = Settings::css_bhop();
    let (height, _) = jump_apex(false, false);
    let dt = s.tick_interval;
    // CheckJumpButton adds the impulse to the -g*dt/2 left by StartGravity, then FinishGravity.
    let expected = expected_apex(-s.gravity * dt * 0.5 + 301.993_38 - s.gravity * dt * 0.5, s);
    assert!((height - expected).abs() < 0.05, "apex {height} vs expected {expected}");
    // sqrt(2*800*57) is the continuous 57-unit jump; the half-step gravity integration loses ~1.5u.
    assert!((55.0..57.0).contains(&height), "apex {height}");
}

#[test]
fn ducked_jump_replaces_vertical_velocity() {
    // SDK 2013: when FL_DUCKING the impulse replaces vz instead of adding to the -g*dt/2 residue.
    let s = Settings::css_bhop();
    let (height, _) = jump_apex(true, false);
    let expected = expected_apex(301.993_38 - s.gravity * s.tick_interval * 0.5, s);
    assert!((height - expected).abs() < 0.05, "crouched jump apex {height} vs {expected}");
    assert!((56.5..57.5).contains(&height));
}

#[test]
fn crouch_jump_lifts_feet_by_half_the_hull_difference() {
    let (standing, _) = jump_apex(false, false);
    let (crouch_jump, _) = jump_apex(false, true);
    let lift = crouch_jump - standing;
    assert!((lift - 8.5).abs() < 0.05, "CS:S air duck lift {lift} (standing {standing}, crouch-jump {crouch_jump})");
    // Community figure: ~65 units clearable with a crouch jump (64 + epsilon here).
    assert!((63.5..65.5).contains(&crouch_jump), "crouch jump {crouch_jump}");
}

#[test]
fn ground_speed_converges_to_maxspeed() {
    let settings = Settings { autohop: false, ..Settings::css_bhop() };
    let mut sim = Sim::new(settings, [0.0, 0.0, 0.0], [0.0; 3], true);
    settle(&mut sim);
    let mut speeds = Vec::new();
    for _ in 0..600 {
        sim.step(400.0, 0.0, 0.0, false, false);
        speeds.push(sim.hspeed());
    }
    let top = speeds.iter().cloned().fold(0.0f32, f32::max);
    assert!((top - 260.0).abs() < 0.01, "top ground speed {top}");
    assert!((speeds.last().unwrap() - 260.0).abs() < 0.01);
}

#[test]
fn ducked_ground_speed_is_034_of_maxspeed() {
    let settings = Settings { autohop: false, ..Settings::css_bhop() };
    let mut sim = Sim::new(settings, [0.0, 0.0, 0.0], [0.0; 3], true);
    settle(&mut sim);
    for _ in 0..600 {
        sim.step(400.0, 0.0, 0.0, false, true);
    }
    assert!((sim.hspeed() - 260.0 * 0.34).abs() < 0.01, "ducked speed {}", sim.hspeed());
}

#[test]
fn landing_fast_is_only_slowed_by_friction() {
    // TF2 clamps ground speed to maxspeed; SDK 2013 / CS:S only apply friction.
    let settings = Settings { autohop: false, ..Settings::css_bhop() };
    let mut sim = Sim::new(settings, [0.0, 0.0, DIST_EPSILON], [400.0, 0.0, 0.0], true);
    sim.step(400.0, 0.0, 0.0, false, false);
    let expected = 400.0 * (1.0 - settings.friction * settings.tick_interval);
    assert!((sim.hspeed() - expected).abs() < 0.01, "speed after one ground tick {} vs {expected}", sim.hspeed());
}

#[test]
fn one_tick_of_air_acceleration_is_capped_at_30() {
    let settings = Settings::css_bhop();
    let mut sim = Sim::new(settings, [0.0, 0.0, 1000.0], [300.0, 0.0, 0.0], false);
    // Pure strafe right at yaw 0: wishdir = (0, -1, 0), wishspeed 260 -> capped to 30 for addspeed;
    // accelspeed = 1000 * 260 * dt = 2600 > 30, so exactly 30 is added perpendicular.
    sim.step(0.0, 400.0, 0.0, false, false);
    let v = sim.state.velocity;
    assert!((v[0] - 300.0).abs() < 1e-3 && (v[1] + 30.0).abs() < 1e-3, "velocity {v:?}");
}

#[test]
fn air_acceleration_with_low_airaccelerate_uses_uncapped_wishspeed() {
    // sv_airaccelerate 10: accelspeed = 10 * 260 * 0.01 = 26 (< 30 cap).
    let settings = Settings { air_accelerate: 10.0, ..Settings::css_bhop() };
    let mut sim = Sim::new(settings, [0.0, 0.0, 1000.0], [300.0, 0.0, 0.0], false);
    sim.step(0.0, 400.0, 0.0, false, false);
    assert!((sim.state.velocity[1] + 26.0).abs() < 1e-3, "{:?}", sim.state.velocity);
    // CS:S crops the command by 0.34 whenever duck is held, also in the air: 26 * 0.34.
    let mut ducked = Sim::new(settings, [0.0, 0.0, 1000.0], [300.0, 0.0, 0.0], false);
    ducked.step(0.0, 400.0, 0.0, false, true);
    assert!((ducked.state.velocity[1] + 26.0 * 0.34).abs() < 1e-3, "{:?}", ducked.state.velocity);
}

#[test]
fn perfect_strafe_sync_gains_speed() {
    // Wishdir kept perpendicular to velocity maximises |v|: |v'|^2 = |v|^2 + 30^2 each tick.
    let settings = Settings::css_bhop();
    let mut sim = Sim::new(settings, [0.0, 0.0, 10_000.0], [260.0, 0.0, 0.0], false);
    let ticks = 100;
    for _ in 0..ticks {
        let v = sim.state.velocity;
        let yaw = v[1].atan2(v[0]).to_degrees();
        sim.step(0.0, 400.0, yaw, false, false);
    }
    let expected = (260.0f32 * 260.0 + ticks as f32 * 900.0).sqrt();
    assert!((sim.hspeed() - expected).abs() < 0.5, "speed {} vs {expected}", sim.hspeed());
    // A W-only hop (wishdir parallel to velocity) gains nothing above 30 u/s.
    let mut w = Sim::new(settings, [0.0, 0.0, 10_000.0], [260.0, 0.0, 0.0], false);
    for _ in 0..ticks {
        w.step(400.0, 0.0, 0.0, false, false);
    }
    assert!((w.hspeed() - 260.0).abs() < 1e-3);
}

#[test]
fn autohop_skips_ground_friction() {
    // Holding jump with autohop: the jump tick clears the ground before friction, so a bhop that
    // lands with 400 u/s leaves the ground with 400 u/s.
    let settings = Settings::css_bhop();
    let mut sim = Sim::new(settings, [0.0, 0.0, 30.0], [400.0, 0.0, 0.0], false);
    let mut landed_speed = None;
    for _ in 0..200 {
        let was_air = sim.state.ground.is_none();
        sim.step(0.0, 0.0, 0.0, true, false);
        if was_air && sim.state.ground.is_some() {
            landed_speed = Some(sim.hspeed());
        }
    }
    assert!(landed_speed.is_some(), "landed at least once");
    assert!((sim.hspeed() - 400.0).abs() < 1e-3, "speed preserved over hops: {}", sim.hspeed());
}

#[test]
fn movement_is_bit_deterministic() {
    let run = || {
        let mut sim = Sim::new(Settings::css_bhop(), [0.0, 0.0, 0.0], [0.0; 3], true);
        let mut seed = 0x1234_5678u32;
        let mut out = Vec::new();
        for _ in 0..2000 {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let yaw = (seed >> 8) as f32 / 16_777_216.0 * 360.0;
            let side = if seed & 1 == 0 { 400.0 } else { -400.0 };
            sim.step(if seed & 2 == 0 { 400.0 } else { 0.0 }, side, yaw, seed & 4 == 0, seed & 0x38 == 0);
            out.extend(sim.state.snapshot_bytes());
        }
        out
    };
    assert_eq!(run(), run());
}

#[test]
fn css_stamina_jump_penalty_recovers_and_resets_on_each_jump() {
    let settings = Settings { autohop: false, stamina: true, max_speed: 250.0, air_accelerate: 100.0, ..Settings::css_bhop() };
    let mut sim = Sim::new(settings, [0.0, 0.0, DIST_EPSILON], [0.0; 3], true);
    sim.step(0.0, 0.0, 0.0, true, false);
    let fresh = sim.state.velocity[2];
    assert!((sim.state.stamina_ms - 25.0 / 19.0 * 1000.0).abs() < 0.001);
    for _ in 0..100 {
        sim.step(0.0, 0.0, 0.0, false, false);
        if sim.state.ground.is_some() { break; }
    }
    assert!(sim.state.ground.is_some());
    let remaining = (sim.state.stamina_ms - 10.0).max(0.0);
    sim.step(0.0, 0.0, 0.0, true, false);
    // Jump scales vertical velocity before the two FinishGravity calls (4 units each).
    let expected = (fresh + 8.0) * ((100.0 - remaining / 1000.0 * 19.0) / 100.0) - 8.0;
    assert!((sim.state.velocity[2] - expected).abs() < 0.001);
    assert!(sim.state.velocity[2] < fresh);
    for _ in 0..150 { sim.step(0.0, 0.0, 0.0, false, false); }
    assert_eq!(sim.state.stamina_ms, 0.0);
    sim.step(0.0, 0.0, 0.0, true, false);
    assert_eq!(sim.state.velocity[2], fresh);
}

#[test]
fn css_stamina_ground_slowdown_matches_70hz_reference() {
    for dt in [0.01, 0.015] {
        let settings = Settings { stamina: true, tick_interval: dt, ..Settings::css_bhop() };
        let mut tired = Sim::new(settings, [0.0, 0.0, DIST_EPSILON], [200.0, 0.0, 0.0], true);
        tired.state.stamina_ms = 1000.0;
        let mut fresh = Sim::new(Settings { stamina: false, ..settings }, [0.0, 0.0, DIST_EPSILON], [200.0, 0.0, 0.0], true);
        tired.step(0.0, 0.0, 0.0, false, false);
        fresh.step(0.0, 0.0, 0.0, false, false);
        let ratio = ((100.0 - (1000.0 - dt * 1000.0) / 1000.0 * 19.0) / 100.0).powf(dt / (1.0 / 70.0));
        assert!((tired.hspeed() - fresh.hspeed() * ratio).abs() < 0.001);
    }
}
