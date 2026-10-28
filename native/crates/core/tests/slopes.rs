//! Slopes, ramps, steps, ceilings and the optional timer-plugin fixes, on synthetic brush scenes.

mod common;

use bunnyhop_core::Settings;
use bunnyhop_core::physics::ConvexBrush;
use common::{Scene, Sim, floor, ramp_down, ramp_up};
use playsrc_movement::MovementFixes;

fn settings() -> Settings {
    Settings::css_bhop()
}

/// Horizontal speed right after landing on a slope, for many sub-tick landing phases.
fn landing_speeds(scene: &Scene, fixes: MovementFixes, start_x: f32, surface_z: impl Fn(f32) -> f32, vx: f32, vz: f32) -> Vec<f32> {
    (0..60)
        .map(|i| {
            let z = surface_z(start_x) + 30.0 + i as f32 * 0.137;
            let mut sim = Sim::new(scene, settings(), [start_x, 0.0, z], [vx, 0.0, vz]);
            sim.configuration.fixes = fixes;
            for _ in 0..200 {
                sim.idle();
                if sim.state.ground.is_some() {
                    return sim.hspeed();
                }
            }
            panic!("never landed from z {z}");
        })
        .collect()
}

fn spread(v: &[f32]) -> (f32, f32) {
    let lo = v.iter().copied().fold(f32::INFINITY, f32::min);
    let hi = v.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    (lo, hi)
}

#[test]
fn downhill_landing_is_random_in_vanilla_and_consistent_with_the_fix() {
    let angle = 30.0f32;
    let scene = Scene::new(vec![floor(), ramp_down(0.0, 0.0, 4096.0, 2048.0, angle)]);
    let top = 4096.0 * angle.to_radians().tan();
    let surface = |x: f32| top - x * angle.to_radians().tan();
    let vanilla = landing_speeds(&scene, MovementFixes::default(), 400.0, surface, 400.0, -500.0);
    let fixed = landing_speeds(&scene, MovementFixes { downhill: true, ..Default::default() }, 400.0, surface, 400.0, -500.0);
    let (vlo, vhi) = spread(&vanilla);
    let (flo, fhi) = spread(&fixed);
    eprintln!("downhill vanilla {vlo:.1}..{vhi:.1}, fixed {flo:.1}..{fhi:.1}");
    // Vanilla: some phases collide with the slope (clip boost), others land through the 2-unit
    // probe (no boost).
    assert!(vhi - vlo > 20.0, "vanilla downhill landings vary with the sub-tick phase");
    assert!(vlo < 402.0, "some vanilla landings get no boost");
    // Fixed: always the boosted outcome.
    // Fixed: always the boosted outcome (it still depends a little on the vertical speed at
    // the landing tick, exactly like the vanilla collide outcome does).
    assert!(fhi - flo < 10.0, "fixed downhill landings are consistent");
    assert!(flo > vlo + 100.0, "the fix always gives a boosted outcome");
}

#[test]
fn uphill_landing_is_random_in_vanilla_and_consistent_with_the_fix() {
    let angle = 30.0f32;
    let scene = Scene::new(vec![floor(), ramp_up(0.0, 0.0, 4096.0, 2048.0, angle)]);
    let surface = |x: f32| x * angle.to_radians().tan();
    let vanilla = landing_speeds(&scene, MovementFixes::default(), 400.0, surface, 400.0, -300.0);
    let fixed = landing_speeds(&scene, MovementFixes { uphill: true, ..Default::default() }, 400.0, surface, 400.0, -300.0);
    let (vlo, vhi) = spread(&vanilla);
    let (flo, fhi) = spread(&fixed);
    eprintln!("uphill vanilla {vlo:.1}..{vhi:.1}, fixed {flo:.1}..{fhi:.1}");
    assert!(vhi - vlo > 20.0, "vanilla uphill landings vary with the sub-tick phase");
    assert!(fhi - flo < 2.0, "fixed uphill landings are consistent");
    assert!(flo > 399.0, "the fix keeps the horizontal speed");
}

/// Standing on a walkable 30 degree ramp does not slide (grounded: no gravity, vz = 0).
#[test]
fn standing_on_a_walkable_ramp_does_not_slide() {
    let scene = Scene::new(vec![floor(), ramp_up(0.0, 0.0, 1024.0, 1024.0, 30.0)]);
    let z = 512.0 * 30f32.to_radians().tan() + 8.0;
    let mut sim = Sim::new(&scene, settings(), [512.0, 0.0, z], [0.0; 3]);
    for _ in 0..100 {
        sim.idle();
    }
    let p = sim.state.position;
    for _ in 0..200 {
        sim.idle();
    }
    assert!(sim.state.ground.is_some());
    assert_eq!(sim.state.position, p, "at rest on the slope");
}

/// A 50 degree ramp (normal z 0.64 < 0.7) is not standable: the player surfs down it, gaining
/// g * sin(angle) per second along the slope (clip each tick, no friction).
#[test]
fn steep_ramp_slides_with_gravity_along_the_slope() {
    let angle = 50.0f32;
    let scene = Scene::new(vec![floor(), ramp_down(0.0, 0.0, 4096.0, 1024.0, angle)]);
    let top = 4096.0 * angle.to_radians().tan();
    let x = 200.0;
    // Highest point under the hull is at its back edge (x - 16).
    let z = top - (x - 16.0) * angle.to_radians().tan() + 2.0;
    let mut sim = Sim::new(&scene, settings(), [x, 0.0, z], [0.0; 3]);
    let ticks = 100;
    let mut grounded = 0;
    for _ in 0..ticks {
        sim.idle();
        grounded += sim.state.ground.is_some() as u32;
    }
    let v = sim.state.velocity;
    let along = (v[0] * v[0] + v[2] * v[2]).sqrt();
    let expected = 800.0 * angle.to_radians().sin() * ticks as f32 * 0.01;
    eprintln!("steep ramp: speed along slope {along:.2}, analytical {expected:.2}");
    assert_eq!(grounded, 0, "never standable");
    assert!(v[0] > 0.0 && v[2] < 0.0, "slides down");
    assert!((along - expected).abs() / expected < 0.03, "{along} vs {expected}");
}

/// Ground movement climbs an 18-unit step but not a 19-unit one.
#[test]
fn walking_steps_up_18_units_but_not_19() {
    for (height, climbs) in [(16.0, true), (18.0, true), (19.0, false)] {
        let scene = Scene::new(vec![floor(), ConvexBrush::aabb([64.0, -512.0, 0.0], [1024.0, 512.0, height])]);
        let mut sim = Sim::new(&scene, settings(), [0.0, 0.0, 0.0], [0.0; 3]);
        for _ in 0..100 {
            sim.step(400.0, 0.0, 0.0, false, false);
        }
        let on_step = sim.state.position[0] > 100.0 && (sim.state.position[2] - height).abs() < 0.1;
        assert_eq!(on_step, climbs, "step {height}: ended at {:?}", sim.state.position);
    }
}

/// Bhopping into a step: the airborne player does not step up (no StepMove in the air); they
/// clip against the riser and keep the tangential speed, or land on top if high enough.
#[test]
fn airborne_player_does_not_step_up() {
    let scene = Scene::new(vec![floor(), ConvexBrush::aabb([64.0, -512.0, 0.0], [1024.0, 512.0, 16.0])]);
    let mut sim = Sim::new(&scene, settings(), [8.0, 0.0, 3.0], [400.0, 0.0, 150.0]);
    let mut hit_riser = false;
    for _ in 0..20 {
        let r = sim.idle();
        hit_riser |= r.contacts.iter().any(|c| c.normal == [-1.0, 0.0, 0.0]);
    }
    assert!(hit_riser, "collided with the riser");
    assert!(sim.state.position[0] < 64.0 - 16.0 + 0.1, "stopped at the riser: {:?}", sim.state.position);
}

/// Jumping into a ceiling ("bonk") zeroes the upward velocity and keeps horizontal speed.
#[test]
fn ceiling_bonk_stops_upward_velocity() {
    let scene = Scene::new(vec![floor(), ConvexBrush::aabb([-1024.0, -1024.0, 62.0 + 30.0], [1024.0, 1024.0, 200.0])]);
    let mut sim = Sim::new(&scene, settings(), [0.0, 0.0, 0.0], [300.0, 0.0, 0.0]);
    sim.idle();
    sim.step(0.0, 0.0, 0.0, true, false);
    assert!(sim.state.velocity[2] > 250.0, "jumped");
    let mut bonked = false;
    for _ in 0..30 {
        let r = sim.idle();
        if r.contacts.iter().any(|c| c.normal[2] < -0.99) {
            bonked = true;
            assert!(sim.state.velocity[2] <= 0.0, "upward velocity removed: {:?}", sim.state.velocity);
            break;
        }
    }
    assert!(bonked);
    assert!(sim.state.position[2] + 62.0 <= 92.0, "below the ceiling");
    assert!(sim.hspeed() > 250.0, "horizontal speed kept");
}

/// Strafing across the seam between two coplanar surf-ramp brushes never stops the player
/// with the rampbug fix on (and vanilla, on this clean seam, should not either).
#[test]
fn ramp_seams_do_not_stop_the_player() {
    let angle = 55.0f32;
    let mut brushes = vec![floor()];
    // Ramps descending along +x, split into segments along y with seams every 128 units.
    for i in 0..16 {
        let y0 = -1024.0 + i as f32 * 128.0;
        let mut b = ramp_down(0.0, 0.0, 2048.0, 128.0, angle);
        for (n, d) in b.planes.iter_mut() {
            *d += n[1] * (y0 + 64.0);
        }
        b.mins[1] += y0 + 64.0;
        b.maxs[1] += y0 + 64.0;
        brushes.push(b);
    }
    let scene = Scene::new(brushes);
    let top = 2048.0 * angle.to_radians().tan();
    for fixes in [MovementFixes::default(), MovementFixes { rampbug: true, ..Default::default() }] {
        let x = 300.0;
        let z = top - (x - 16.0) * angle.to_radians().tan() + 4.0;
        let mut sim = Sim::new(&scene, settings(), [x, -900.0, z], [0.0, 1200.0, 0.0]);
        sim.configuration.fixes = fixes;
        let mut min_speed = f32::INFINITY;
        for _ in 0..120 {
            sim.idle();
            if sim.state.position[2] < 32.0 {
                break;
            }
            let v = sim.state.velocity;
            min_speed = min_speed.min((v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt());
        }
        eprintln!("ramp seams {fixes:?}: min speed {min_speed:.1}");
        assert!(min_speed > 1000.0, "no dead stop crossing seams ({fixes:?}): {min_speed}");
    }
}

/// An ice floor (`$surfaceprop ice`, friction 0.1): player surface friction 0.125 scales both
/// ground friction and ground acceleration (SDK CategorizeGroundSurface, Friction, Accelerate).
#[test]
fn ice_floor_scales_friction_and_acceleration() {
    let mut ice = floor();
    ice.surface = bunnyhop_core::physics::surface_index("ice");
    let scene = Scene::new(vec![ice]);
    let mut sim = Sim::new(&scene, settings(), [0.0, 0.0, 0.0], [0.0; 3]);
    sim.idle();
    assert_eq!(sim.state.surface_friction, 0.125);
    // Acceleration from rest holding W: accelspeed = accelerate * dt * wishspeed * sf.
    sim.step(400.0, 0.0, 0.0, false, false);
    assert!((sim.hspeed() - 5.0 * 0.01 * 260.0 * 0.125).abs() < 1e-3, "{}", sim.hspeed());
    // Sliding at 400 with no input: drop = speed * friction * sf * dt per tick.
    sim.state.velocity = [400.0, 0.0, 0.0];
    let mut expected = 400.0f32;
    for _ in 0..50 {
        sim.idle();
        let control = expected.max(75.0);
        expected = (expected - control * 4.0 * 0.125 * 0.01).max(0.0);
    }
    assert!((sim.hspeed() - expected).abs() < 0.05, "{} vs {expected}", sim.hspeed());
    // Normal ground loses 8x more per tick.
    let normal = Scene::new(vec![floor()]);
    let mut sim = Sim::new(&normal, settings(), [0.0, 0.0, 0.0], [0.0; 3]);
    sim.idle();
    sim.state.velocity = [400.0, 0.0, 0.0];
    sim.idle();
    assert!((sim.hspeed() - 384.0).abs() < 1e-3);
}

/// New recordings enable downhill fixes without an out-of-band server rule. Old recordings
/// keep the original tick-phase-dependent landing speed, with or without jump held.
#[test]
fn v13_boosts_every_landing_phase_with_and_without_autohop() {
    use bunnyhop_core::game::{PHYSICS_V11, PHYSICS_V13};
    let angle = 30.0f32;
    let scene = Scene::new(vec![floor(), ramp_down(0.0, 0.0, 4096.0, 2048.0, angle)]);
    let surface = (4096.0 - 400.0) * angle.to_radians().tan();
    for jump in [false, true] {
        for version in [PHYSICS_V11, PHYSICS_V13] {
            let mut speeds = Vec::new();
            for phase in 0..60 {
                let mut cfg = settings();
                cfg.physics_version = version;
                let mut sim = Sim::new(&scene, cfg, [400.0, 0.0, surface + 30.0 + phase as f32 * 0.137], [400.0, 0.0, -500.0]);
                let mut landed = false;
                for _ in 0..200 {
                    sim.step(0.0, 0.0, 0.0, jump, false);
                    if sim.state.ground.is_some() {
                        let speed = sim.hspeed();
                        if jump {
                            sim.step(0.0, 0.0, 0.0, true, false);
                            assert!(sim.state.ground.is_none(), "autohop takes off");
                            assert!((sim.hspeed() - speed).abs() < 0.01, "boost survives takeoff");
                        }
                        speeds.push(speed);
                        landed = true;
                        break;
                    }
                }
                assert!(landed, "phase {phase} never landed");
            }
            let (low, high) = spread(&speeds);
            if version == PHYSICS_V13 {
                assert!(low > 530.0 && high - low < 10.0, "v13 jump={jump}: {low}..{high}");
            } else {
                assert!(low < 402.0 && high > 530.0, "v11 jump={jump}: {low}..{high}");
            }
        }
    }
}
