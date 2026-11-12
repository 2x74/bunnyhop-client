//! Infinite is a settings preset on the unchanged simulation: `air_jump` lets every fresh jump press in the air
//! rise again at `AIR_JUMP_SPEED`, keeping the horizontal speed the player built up.
//!
//! The press has to be a real button edge. Autohop rearms the jump latch on every tick jump is held (v20+,
//! `Game::step`), so a latch-only rule would turn one held jump into continuous flight; `autohop_would_fly`
//! below is that hazard, and `press_edge_gate_stops_the_flight` is the gate `Game::step` applies for it.
mod common;

use bunnyhop_core::Settings;
use bunnyhop_core::game::AIR_JUMP_SPEED;
use common::{Scene, Sim, floor};

const START: [f32; 3] = [0.0, 0.0, 400.0];

fn settings(air_jump: bool, autohop: bool) -> Settings {
    Settings { air_jump, autohop, ..Settings::css_bhop() }
}

/// Airborne well above the floor, carrying `speed` along +x.
fn airborne<'a>(scene: &'a Scene, air_jump: bool, autohop: bool, speed: f32) -> Sim<'a> {
    Sim::new(scene, settings(air_jump, autohop), START, [speed, 0.0, -100.0])
}

#[test]
fn fresh_air_press_rises_and_keeps_horizontal_speed() {
    let scene = Scene::new(vec![floor()]);
    let mut sim = airborne(&scene, true, false, 1200.0);
    sim.step(0.0, 0.0, 0.0, true, false);
    let v = sim.state.velocity;
    assert!(v[2] > AIR_JUMP_SPEED - 20.0, "the jump must set the rise: {v:?}");
    assert!((v[0] - 1200.0).abs() < 0.001, "horizontal speed must survive the jump: {v:?}");
    assert!(v[1].abs() < 0.001, "{v:?}");
}

#[test]
fn the_rise_replaces_a_fast_fall() {
    let scene = Scene::new(vec![floor()]);
    let mut sim = Sim::new(&scene, settings(true, false), START, [0.0, 0.0, -2000.0]);
    sim.step(0.0, 0.0, 0.0, true, false);
    // Replaced, not added to: a jump taken while plummeting is worth the same as any other.
    assert!(sim.state.velocity[2] > AIR_JUMP_SPEED - 20.0, "{:?}", sim.state.velocity);
}

#[test]
fn a_held_press_jumps_once() {
    let scene = Scene::new(vec![floor()]);
    let mut sim = airborne(&scene, true, false, 0.0);
    sim.step(0.0, 0.0, 0.0, true, false);
    let risen = sim.state.velocity[2];
    for _ in 0..5 {
        sim.step(0.0, 0.0, 0.0, true, false);
    }
    assert!(sim.state.velocity[2] < risen - 20.0, "a held jump kept rising: {risen} -> {:?}", sim.state.velocity[2]);
}

#[test]
fn every_release_and_press_jumps_again() {
    let scene = Scene::new(vec![floor()]);
    let mut sim = airborne(&scene, true, false, 0.0);
    for attempt in 0..8 {
        sim.idle(); // release clears the latch
        sim.step(0.0, 0.0, 0.0, true, false);
        let v = sim.state.velocity[2];
        assert!(v > AIR_JUMP_SPEED - 20.0, "attempt {attempt} did not rise: {v}");
    }
    assert!(sim.state.ground.is_none(), "the player never landed");
}

#[test]
fn off_for_every_other_style() {
    let scene = Scene::new(vec![floor()]);
    let mut sim = airborne(&scene, false, false, 1200.0);
    let before = sim.state.velocity[2];
    sim.step(0.0, 0.0, 0.0, true, false);
    let v = sim.state.velocity;
    assert!(v[2] < before, "a jump press in the air did something: {v:?}");
    assert!((v[0] - 1200.0).abs() < 0.001, "{v:?}");
}

#[test]
fn autohop_would_fly_without_a_press_edge() {
    let scene = Scene::new(vec![floor()]);
    let mut sim = airborne(&scene, true, true, 0.0);
    for _ in 0..10 {
        sim.step(0.0, 0.0, 0.0, true, false);
    }
    // Documents the hazard: autohop clears the latch every tick, so a latch-only rule never stops rising.
    assert!(sim.state.velocity[2] > AIR_JUMP_SPEED - 20.0, "{:?}", sim.state.velocity);
}

#[test]
fn press_edge_gate_stops_the_flight() {
    let scene = Scene::new(vec![floor()]);
    let mut sim = airborne(&scene, true, true, 0.0);
    let impulse = sim.policy.air_jump_impulse;
    sim.step(0.0, 0.0, 0.0, true, false);
    let risen = sim.state.velocity[2];
    // As Game::step does: the impulse only survives on a tick where jump was newly pressed.
    sim.policy.air_jump_impulse = None;
    for _ in 0..5 {
        sim.step(0.0, 0.0, 0.0, true, false);
    }
    assert!(sim.state.velocity[2] < risen - 20.0, "the gate let a held jump fly: {:?}", sim.state.velocity);
    assert!(impulse.is_some(), "the style did set an impulse");
}

/// The real `Game::step` on a real map (the web/verifier path): with autohop, holding jump in the air rises once,
/// every fresh press rises again, and without `air_jump` the same commands never rise in the air.
#[test]
fn game_step_gates_air_jumps_on_a_press_edge() {
    use bunnyhop_core::game::{IN_JUMP, PHYSICS_V23};
    use bunnyhop_core::{Cmd, Game};
    let path = bunnyhop_core::test_maps::bsp("bhop_eazy");
    let bytes = std::fs::read(path).expect("bhop_eazy fixture");
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let mut game = Game::load(&bsp).unwrap();
    let held = Cmd { buttons: IN_JUMP, ..Cmd::default() };
    let airborne = |game: &mut Game| {
        game.reset();
        // The clear airborne point low_gravity.rs uses; no horizontal motion, so no map trigger is touched.
        game.state.position = [600.0, -352.0, 200.0];
        game.state.velocity = [0.0; 3];
        game.state.ground = None;
    };
    for air_jump in [true, false] {
        game.set_settings(Settings { air_jump, physics_version: PHYSICS_V23, ..Settings::css_bhop() });
        airborne(&mut game);
        game.step(held).unwrap();
        let first = game.state.velocity[2];
        for _ in 0..5 {
            game.step(held).unwrap();
        }
        let held_after = game.state.velocity[2];
        game.step(Cmd::default()).unwrap();
        game.step(held).unwrap();
        let repressed = game.state.velocity[2];
        if air_jump {
            assert!(first > AIR_JUMP_SPEED - 20.0, "the first press must rise: {first}");
            assert!(held_after < first - 20.0, "autohop + held jump must not fly: {first} -> {held_after}");
            assert!(repressed > AIR_JUMP_SPEED - 20.0, "a fresh press must rise again: {repressed}");
        } else {
            assert!(first < 0.0 && held_after < first && repressed < held_after, "no air jumps off Infinite: {first} {held_after} {repressed}");
        }
    }
}
