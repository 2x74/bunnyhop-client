//! The v27 flag chooses only the ground jump lift; older physics ignores it.
use bunnyhop_core::game::{EVENT_JUMPED, IN_DUCK, IN_JUMP, IN_NO_LANDFIX, PHYSICS_V24, PHYSICS_V26, PHYSICS_V27};
use bunnyhop_core::{Cmd, Game, Settings};

const IDLE: Cmd = Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons: 0 };

fn load(physics: u32) -> Option<Game> {
    let path = bunnyhop_core::test_maps::bsp("bhop_eazy");
    if !path.exists() { eprintln!("bhop_eazy unavailable; skipping landfix integration fixture"); return None; }
    let mut g = bunnyhop_core::content::load_game(&path).unwrap();
    g.set_settings(Settings { physics_version: physics, ..Settings::css_bhop() });
    g.reset();
    g.set_position([560.0, -352.0, 70.0], 0.0);
    for _ in 0..40 { g.step(IDLE).unwrap(); }
    assert!(g.state.ground.is_some());
    Some(g)
}

#[test]
fn on_is_v26_off_is_stock_at_every_landing_phase() {
    for h in [0.03125, 0.3, 1.0, 1.5, 1.99] {
        for duck in [false, true] {
            let Some(mut on) = load(PHYSICS_V27) else { return };
            let mut old = load(PHYSICS_V26).unwrap();
            let mut off = load(PHYSICS_V27).unwrap();
            let mut stock = load(PHYSICS_V24).unwrap();
            let cmd = Cmd { forward: 0.0, side: 450.0, yaw: 37.0, buttons: IN_JUMP | if duck { IN_DUCK } else { 0 }, ..IDLE };
            for g in [&mut on, &mut old, &mut off, &mut stock] {
                g.state.position[2] = 64.0 + h;
                g.state.velocity = [300.0, 80.0, 0.0];
            }
            on.step(cmd).unwrap();
            old.step(cmd).unwrap();
            off.step(Cmd { buttons: cmd.buttons | IN_NO_LANDFIX, ..cmd }).unwrap();
            stock.step(cmd).unwrap();
            assert_ne!(on.events & EVENT_JUMPED, 0);
            assert_eq!(on.state, old.state, "ON phase {h}, duck {duck}");
            assert_eq!(off.state, stock.state, "OFF phase {h}, duck {duck}");
            assert_eq!(on.state.velocity, off.state.velocity, "lift never changes jump velocity");
            assert_eq!(on.state.position[..2], off.state.position[..2]);
        }
    }
}

#[test]
fn flag_cannot_change_legacy_movement() {
    for physics in 1..=26 {
        let Some(mut a) = load(physics) else { return };
        let mut b = load(physics).unwrap();
        for i in 0..180 {
            let cmd = Cmd { buttons: if i % 4 == 0 { IN_JUMP } else { 0 }, ..IDLE };
            a.step(cmd).unwrap();
            b.step(Cmd { buttons: cmd.buttons | IN_NO_LANDFIX, ..cmd }).unwrap();
            assert_eq!(a.state, b.state, "v{physics}, tick {i}");
            assert_eq!(a.events, b.events);
        }
    }
}

#[test]
fn toggling_each_hop_and_restoring_a_snapshot_replays_exactly() {
    let Some(mut g) = load(PHYSICS_V27) else { return };
    let snapshot = g.save_state();
    let mut history = Vec::new();
    let mut jumps = [0, 0];
    for i in 0..500 {
        let off = (i / 80) % 2 == 0;
        let cmd = Cmd { buttons: IN_JUMP | if off { IN_NO_LANDFIX } else { 0 }, ..IDLE };
        g.step(cmd).unwrap();
        if g.events & EVENT_JUMPED != 0 { jumps[usize::from(off)] += 1; }
        history.push((cmd, g.state, g.events));
    }
    assert!(jumps.iter().all(|n| *n >= 2), "both policies jump: {jumps:?}");
    g.restore_state(&snapshot);
    for (cmd, state, events) in history {
        g.step(cmd).unwrap();
        assert_eq!(g.state, state);
        assert_eq!(g.events, events);
    }
}
