//! Infinite flights (game/flight.rs, physics v24): `IN_FLIGHT` commands fly inside `Game::step`, deterministically, and
//! only for Infinite (`air_jump`) on v24+. Everywhere else the bit is inert. Maps are gitignored; each test skips (with a
//! note) when its map is absent.

use bunnyhop_core::game::{EVENT_FLIGHT, EVENT_FLIGHT_LANDED, FLIGHT_EXIT_CAP, FLIGHT_TOP_SPEED, IN_FLIGHT, PHYSICS_V23, PHYSICS_V24};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

fn load(name: &str, air_jump: bool, physics: u32) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping {name}: {} not found", path.display());
        return None;
    };
    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("bsp parses");
    let mut g = Game::load(&bsp).expect("game loads");
    g.set_settings(Settings { air_jump, physics_version: physics, ..Settings::css_bhop() });
    g.reset();
    Some(g)
}

const IDLE: Cmd = Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons: 0 };
const FLY_FORWARD: Cmd = Cmd { forward: 450.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons: IN_FLIGHT };
const FLY_DOWN: Cmd = Cmd { forward: 450.0, side: 0.0, yaw: 0.0, pitch: 89.0, buttons: IN_FLIGHT };

fn settle(g: &mut Game) {
    for _ in 0..50 {
        g.step(IDLE).unwrap();
    }
}

fn hspeed(v: [f32; 3]) -> f32 {
    (v[0] * v[0] + v[1] * v[1]).sqrt()
}

/// The same commands with and without IN_FLIGHT leave bit-identical states (and digests) where flights aren't allowed.
fn assert_inert(air_jump: bool, physics: u32) {
    let (Some(mut a), Some(mut b)) = (load("bhop_eazy", air_jump, physics), load("bhop_eazy", air_jump, physics)) else { return };
    for i in 0..400 {
        let mut cmd = Cmd { forward: 450.0, side: if i % 40 < 20 { 400.0 } else { -400.0 }, yaw: (i as f32 * 0.7) % 360.0, pitch: 0.0, buttons: if i % 7 == 0 { 2 } else { 0 } };
        a.step(cmd).unwrap();
        cmd.buttons |= IN_FLIGHT;
        b.step(cmd).unwrap();
        assert_eq!(a.events & EVENT_FLIGHT, 0);
        assert_eq!(b.events, a.events, "tick {i}");
        assert!(!b.flying());
        assert_eq!(a.state.position, b.state.position, "tick {i}");
        assert_eq!(a.state.velocity, b.state.velocity, "tick {i}");
    }
    assert_eq!(a.snapshot_bytes(), b.snapshot_bytes());
}

#[test]
fn flight_bit_is_inert_before_v24() {
    assert_inert(true, PHYSICS_V23);
}

#[test]
fn flight_bit_is_inert_outside_infinite() {
    assert_inert(false, PHYSICS_V24);
}

#[test]
fn infinite_flies_through_the_floor_and_lands_below() {
    let Some(mut g) = load("bhop_eazy", true, PHYSICS_V24) else { return };
    settle(&mut g);
    assert!(g.state.ground.is_some());
    let start = g.state.position;
    let tick = g.tick;
    for i in 0..40 {
        g.step(FLY_DOWN).unwrap();
        assert!(g.flying());
        assert_ne!(g.events & EVENT_FLIGHT, 0);
        assert_eq!(g.tick, tick + i + 1);
        assert!(g.state.ground.is_none());
    }
    assert!(g.state.position[2] < start[2] - 100.0, "flew down through the floor: {:?} from {start:?}", g.state.position);
    // Back up and land: the first command without the bit puts the player down and steps normally.
    let up = Cmd { pitch: -89.0, ..FLY_DOWN };
    while g.state.position[2] < start[2] + 40.0 {
        g.step(up).unwrap();
    }
    g.step(IDLE).unwrap();
    assert!(!g.flying());
    assert_eq!(g.events & EVENT_FLIGHT, 0);
    for _ in 0..200 {
        g.step(IDLE).unwrap();
    }
    assert!(g.state.ground.is_some(), "fell back onto the floor");
}

#[test]
fn flight_tops_out_at_3500_and_the_landing_caps_at_3510() {
    let Some(mut g) = load("bhop_eazy", true, PHYSICS_V24) else { return };
    settle(&mut g);
    let mut top = 0.0f32;
    for _ in 0..300 {
        g.step(Cmd { pitch: -10.0, ..FLY_FORWARD }).unwrap();
        let v = g.state.velocity;
        top = top.max((v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt());
    }
    assert!(top > 3000.0 && top <= FLIGHT_TOP_SPEED, "top speed {top}");
    // Arrive faster than the cap (a booster before the flight): the first flight tick brings it to the top speed, then
    // the landing keeps at most the exit cap.
    let Some(mut g) = load("bhop_eazy", true, PHYSICS_V24) else { return };
    settle(&mut g);
    g.state.velocity = [4000.0, 3000.0, 0.0];
    g.step(Cmd { forward: 0.0, ..FLY_FORWARD }).unwrap();
    assert!(hspeed(g.state.velocity) <= FLIGHT_TOP_SPEED, "the flight caps the speed: {:?}", g.state.velocity);
    let before = g.state.velocity;
    g.step(Cmd { pitch: -30.0, ..IDLE }).unwrap();
    assert!(!g.flying());
    // The landing tick's own air move may add a little; it starts from the capped speed.
    let after = hspeed(g.state.velocity);
    assert!(after <= FLIGHT_EXIT_CAP + 1.0, "landing kept {after} (flew at {before:?})");
}

#[test]
fn landing_inside_solid_keeps_flying_until_free() {
    for map in ["bhop_eazy", "bhop_badges", "bhop_arcane_v1", "bhop_mist_4", "bhop_monster_jam"] {
        if stuck_landing(map) {
            return;
        }
    }
    eprintln!("skipping: no deep solid near the spawn of any test map");
}

/// The stuck-landing check on `map`; false when the map is absent or has no spot to check it at.
fn stuck_landing(map: &str) -> bool {
    let Some(mut g) = load(map, true, PHYSICS_V24) else { return false };
    settle(&mut g);
    let feet = g.state.position;
    // A spot in solid with no free space within 100 units (the probe is practice_noclip_exit's search, which the
    // landing shares).
    let saved = g.save_state();
    let grid = (-32..=32).flat_map(|x| (-32..=32).flat_map(move |y| (-4..=4).map(move |z| [x, y, z])));
    let deep = grid.map(|[x, y, z]| [feet[0] + 128.0 * x as f32, feet[1] + 128.0 * y as f32, feet[2] + 128.0 * z as f32]).find(|&p| {
        g.restore_state(&saved);
        g.practice_noclip_exit(p, [0.0; 3], 0.0, 89.0) == 0
    });
    let Some(deep) = deep else { return false };
    eprintln!("{map}: stuck spot {deep:?}");
    g.restore_state(&saved);
    g.step(FLY_FORWARD).unwrap();
    g.state.position = deep;
    g.state.velocity = [0.0; 3];
    // Let go of the flight while stuck: still flying, and not moving without keys.
    for _ in 0..5 {
        g.step(Cmd { pitch: 89.0, ..IDLE }).unwrap();
        assert!(g.flying(), "stuck at {deep:?} must keep flying");
        assert_ne!(g.events & EVENT_FLIGHT, 0);
        assert_eq!(g.state.position, deep);
    }
    // Fly up out of it with the bit still clear: lands as soon as there is room.
    let mut ticks = 0;
    while g.flying() && ticks < 2000 {
        g.step(Cmd { forward: 450.0, side: 0.0, yaw: 0.0, pitch: -89.0, buttons: 0 }).unwrap();
        ticks += 1;
    }
    assert!(!g.flying(), "landed once free ({ticks} ticks)");
    true
}

#[test]
fn a_saved_flight_restores_bit_for_bit() {
    let Some(mut g) = load("bhop_eazy", true, PHYSICS_V24) else { return };
    settle(&mut g);
    for _ in 0..20 {
        g.step(FLY_FORWARD).unwrap();
    }
    let saved = g.save_state();
    let run = |g: &mut Game| {
        let mut out = Vec::new();
        for i in 0..60 {
            let cmd = if i < 30 { FLY_FORWARD } else { IDLE };
            g.step(cmd).unwrap();
            out.push((g.state.position, g.state.velocity, g.events, g.flying()));
        }
        out
    };
    let a = run(&mut g);
    g.restore_state(&saved);
    assert!(g.flying());
    let b = run(&mut g);
    assert_eq!(a, b);
    assert!(!a.last().unwrap().3);
}

#[test]
fn a_reset_ends_the_flight() {
    let Some(mut g) = load("bhop_eazy", true, PHYSICS_V24) else { return };
    g.step(FLY_FORWARD).unwrap();
    assert!(g.flying());
    g.reset();
    assert!(!g.flying());
}

/// The exact magnitude (f64; f32 squares are exact in it).
fn speed3(v: [f32; 3]) -> f64 {
    let [x, y, z] = v.map(f64::from);
    (x * x + y * y + z * z).sqrt()
}

/// Turns while flying (review 11-04: one degree per tick at pitch 0 reached 3640.86 u/s, five degrees per tick at pitch
/// -60 reached 3744.63 with 3637.30 vertical). The actual flight speed (3D) never passes the top speed.
fn assert_turning_capped(pitch: f32, degrees_per_tick: f32) {
    let Some(mut g) = load("bhop_eazy", true, PHYSICS_V24) else { return };
    settle(&mut g);
    let mut top = 0.0f64;
    for i in 0..1500u32 {
        let yaw = (i as f32 * degrees_per_tick) % 360.0;
        g.step(Cmd { forward: 450.0, side: 0.0, yaw, pitch, buttons: IN_FLIGHT }).unwrap();
        assert!(g.flying());
        let s = speed3(g.state.velocity);
        assert!(s <= f64::from(FLIGHT_TOP_SPEED), "tick {i}: {s} u/s {:?}", g.state.velocity);
        assert!(g.state.velocity[2].abs() <= FLIGHT_TOP_SPEED);
        top = top.max(s);
    }
    // The turning flight does reach the cap (it would go past it uncapped).
    assert!(top > f64::from(FLIGHT_TOP_SPEED) - 1.0, "top {top}");
}

#[test]
fn turning_flight_one_degree_per_tick_stays_within_top_speed() {
    assert_turning_capped(0.0, 1.0);
}

#[test]
fn turning_flight_five_degrees_per_tick_pitch_up_stays_within_top_speed() {
    assert_turning_capped(-60.0, 5.0);
}

/// A velocity faster than the top speed carried into a flight is capped on the flight's first tick.
#[test]
fn incoming_speed_is_capped_on_the_first_flight_tick() {
    let Some(mut g) = load("bhop_eazy", true, PHYSICS_V24) else { return };
    settle(&mut g);
    g.state.velocity = [6000.0, -2500.0, 3000.0];
    g.step(Cmd { forward: 0.0, ..FLY_FORWARD }).unwrap();
    assert!(g.flying());
    let s = speed3(g.state.velocity);
    assert!(s <= f64::from(FLIGHT_TOP_SPEED) && s > f64::from(FLIGHT_TOP_SPEED) - 1.0, "{s} {:?}", g.state.velocity);
}

/// The landing tick reports EVENT_FLIGHT_LANDED and the spot the landing put the player at, before the normal step
/// (review 11-04 P1: one tick into the floor, the landing search moves the player forward and up to about x=639).
#[test]
fn landing_reports_its_spot() {
    let Some(mut g) = load("bhop_eazy", true, PHYSICS_V24) else { return };
    g.step(Cmd { forward: 450.0, side: 0.0, yaw: 0.0, pitch: 89.0, buttons: IN_FLIGHT | 8 }).unwrap();
    assert!(g.flying());
    assert_eq!(g.events & EVENT_FLIGHT_LANDED, 0);
    assert!(g.flight_landing().is_none());
    let inside = g.state.position;
    g.step(Cmd { forward: 450.0, side: 0.0, yaw: 0.0, pitch: -1.0, buttons: 8 }).unwrap();
    assert!(!g.flying());
    assert_ne!(g.events & EVENT_FLIGHT_LANDED, 0);
    assert_eq!(g.events & EVENT_FLIGHT, 0);
    let (spot, _) = g.flight_landing().expect("landing spot");
    assert!(spot != inside && spot[2] > inside[2], "relocated out of the floor: {spot:?} from {inside:?}");
    // An output of that tick only.
    g.step(Cmd { forward: 450.0, side: 0.0, yaw: 0.0, pitch: -1.0, buttons: 8 }).unwrap();
    assert_eq!(g.events & EVENT_FLIGHT_LANDED, 0);
    assert!(g.flight_landing().is_none());
}
