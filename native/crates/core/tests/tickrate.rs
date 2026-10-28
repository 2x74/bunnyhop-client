//! 100 tick (0.01) vs 66.67 tick (0.015): both work, and the differences are the expected
//! discretisation effects (documented in research/MOVEMENT_AUDIT.md).

mod common;

use bunnyhop_core::Settings;
use common::{Scene, Sim, floor};

fn at(tick_interval: f32) -> Settings {
    Settings { tick_interval, ..Settings::css_bhop() }
}

/// Discrete Source jump: v_k = v0 - g*dt*k per tick with v0 = impulse - g*dt/2 - g*dt/2.
fn discrete_apex(dt: f32) -> f32 {
    let mut v = 301.993_38f32 - 800.0 * dt;
    let mut z = 0.0f32;
    while v > 0.0 {
        z += v * dt;
        v -= 800.0 * dt;
    }
    z
}

fn jump(dt: f32) -> (f32, u32) {
    let scene = Scene::new(vec![floor()]);
    let mut sim = Sim::new(&scene, at(dt), [0.0, 0.0, 0.03125], [0.0; 3]);
    for _ in 0..20 {
        sim.idle();
    }
    let z0 = sim.state.position[2];
    sim.step(0.0, 0.0, 0.0, true, false);
    let (mut apex, mut air) = (0.0f32, 1u32);
    while sim.state.ground.is_none() {
        sim.idle();
        apex = apex.max(sim.state.position[2] - z0);
        air += 1;
    }
    (apex, air)
}

#[test]
fn jump_height_and_airtime_per_tickrate() {
    for dt in [0.01f32, 0.015] {
        let (apex, air) = jump(dt);
        eprintln!("dt {dt}: apex {apex:.3} (discrete {:.3}), airtime {air} ticks = {:.3} s", discrete_apex(dt), air as f32 * dt);
        assert!((apex - discrete_apex(dt)).abs() < 0.01, "dt {dt}");
        // ~0.755 s continuous; both rates within a tick of it.
        assert!((air as f32 * dt - 0.755).abs() < 2.0 * dt, "dt {dt}: {air}");
    }
}

/// Perfect-sync strafing: |v|^2 grows by 30^2 per tick, so per second 100 tick gains 1.5x as much
/// speed^2 as 66 tick.
#[test]
fn air_strafe_gain_per_second() {
    for dt in [0.01f32, 0.015] {
        let scene = Scene::new(vec![]);
        let mut sim = Sim::new(&scene, at(dt), [0.0, 0.0, 10_000.0], [260.0, 0.0, 0.0]);
        sim.configuration.gravity = 0.0;
        let ticks = (1.0 / dt).round() as u32;
        for _ in 0..ticks {
            let v = sim.state.velocity;
            let yaw = v[1].atan2(v[0]).to_degrees();
            // Wish exactly perpendicular (strafe right with yaw along velocity).
            sim.step(0.0, 400.0, yaw, false, false);
        }
        let expected = (260.0f32 * 260.0 + 900.0 * ticks as f32).sqrt();
        eprintln!("dt {dt}: speed after 1 s of perfect sync {:.2} (expected {expected:.2})", sim.hspeed());
        assert!((sim.hspeed() - expected).abs() < 0.5, "dt {dt}");
    }
}

/// Ground friction per second is tick-rate independent to first order (400 u/s slide).
#[test]
fn friction_per_second_is_close() {
    let mut speeds = Vec::new();
    for dt in [0.01f32, 0.015] {
        let scene = Scene::new(vec![floor()]);
        let mut sim = Sim::new(&scene, at(dt), [0.0, 0.0, 0.03125], [0.0; 3]);
        sim.idle();
        sim.state.velocity = [400.0, 0.0, 0.0];
        for _ in 0..(0.3 / dt).round() as u32 {
            sim.idle();
        }
        speeds.push(sim.hspeed());
        eprintln!("dt {dt}: 400 u/s slide after 0.3 s: {:.2}", sim.hspeed());
    }
    // Continuous: 400 * exp(-4 * 0.3) = 120.5.
    assert!((speeds[0] - speeds[1]).abs() < 6.0);
}
