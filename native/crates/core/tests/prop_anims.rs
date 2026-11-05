//! Animated props (`game/prop_anims.rs`): the prop_dynamics the client poses and what the map's I/O asks them to play.
//! Display only: the inputs, and the props' own render groups, must not change the run.
//!
//! Needs the maps in maps/ (gitignored); each test skips when its map is absent.

use bunnyhop_core::game::{PHYSICS_LATEST, PROP_ANIM_HIDDEN, PROP_ANIM_REMOVED};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

fn load(name: &str) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../maps/{name}.bsp"));
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping: {} not found", path.display());
        return None;
    };
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let mut game = Game::load(&bsp).unwrap();
    game.set_settings(Settings { physics_version: PHYSICS_LATEST, ..Settings::css_bhop() });
    game.reset();
    Some(game)
}

const IDLE: Cmd = Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons: 0 };

/// bhop_ceaseless: the 14 butterflies (`babochka*`, DefaultAnim run..run8) are animated props, drawn on their own.
#[test]
fn ceaseless_butterflies_are_animated_props() {
    let Some(g) = load("bhop_ceaseless") else { return };
    let anims: Vec<_> = g.prop_anim_states().map(|(p, flags, ..)| (p.ent, p.anim.clone(), flags)).collect();
    assert_eq!(anims.len(), 14, "{anims:?}");
    assert!(anims.iter().all(|(_, a, f)| a.starts_with("run") && *f == 0));
    let owners: Vec<u32> = g.render_props().iter().filter(|p| p.0.contains("butterfly")).map(|p| p.4).collect();
    assert_eq!(owners.len(), 14);
    assert!(owners.iter().all(|&o| o != 0), "butterflies get their own groups");
    let moving: Vec<usize> = g.moving_prop_transforms().iter().map(|t| t.0).collect();
    for (ent, ..) in &anims {
        assert!(g.is_animated_prop(*ent as usize));
        assert!(moving.contains(&(*ent as usize)), "every animated prop is placed by prop_transforms");
    }
}

/// Animation inputs change what the client reads and nothing else: the simulation digest is the same with and without.
#[test]
fn inputs_are_display_only() {
    let Some(mut a) = load("bhop_ceaseless") else { return };
    let Some(mut b) = load("bhop_ceaseless") else { return };
    let serial = a.prop_anim_serial();
    for _ in 0..100 {
        a.step(IDLE).unwrap();
        b.step(IDLE).unwrap();
    }
    a.fire_input("babochka1", "SetPlaybackRate", "2");
    a.fire_input("babochka2", "SetAnimation", "run4");
    a.fire_input("babochka3", "SetDefaultAnimation", "run");
    a.fire_input("babochka4", "TurnOff", "");
    a.fire_input("babochka5", "Kill", "");
    for _ in 0..200 {
        a.step(IDLE).unwrap();
        b.step(IDLE).unwrap();
    }
    // Kill is the one input that touches the simulation's entity state (`removed`, as for every entity).
    b.fire_input("babochka5", "Kill", "");
    b.step(IDLE).unwrap();
    a.step(IDLE).unwrap();
    assert_eq!(a.snapshot_bytes(), b.snapshot_bytes());
    assert_ne!(a.prop_anim_serial(), serial);
    let dt = a.settings.tick_interval;
    let by = |name: &str| {
        let i = a.entities.iter().position(|e| e.get("targetname") == Some(name)).unwrap() as u32;
        a.prop_anim_states().find(|s| s.0.ent == i).map(|(p, f, base, since, rate)| (p.anim.clone(), p.default_anim.clone(), f, base, since, rate)).unwrap()
    };
    let (_, _, _, base, since, rate) = by("babochka1");
    assert_eq!(rate, 2.0);
    assert!((since - 100.0 * dt).abs() < 1e-3 && (base - 100.0 * dt).abs() < 1e-3, "rate change keeps the sequence time ({base}, {since})");
    let (anim, _, _, base, since, rate) = by("babochka2");
    assert_eq!((anim.as_str(), base, rate), ("run4", 0.0, 1.0));
    assert!((since - 100.0 * dt).abs() < 1e-3);
    assert_eq!(by("babochka3").1, "run");
    assert_eq!(by("babochka4").2, PROP_ANIM_HIDDEN);
    assert_eq!(by("babochka5").2 & PROP_ANIM_REMOVED, PROP_ANIM_REMOVED);
}

/// Restart and snapshots bring the animation state back.
#[test]
fn reset_and_snapshots_restore_the_state() {
    let Some(mut g) = load("bhop_ceaseless") else { return };
    let snap = g.save_state();
    g.fire_input("babochka1", "SetAnimation", "run2");
    let changed = |g: &Game| g.prop_anim_states().any(|(p, ..)| p.anim == "run2" && p.default_anim == "run");
    assert!(changed(&g));
    let serial = g.prop_anim_serial();
    g.restore_state(&snap);
    assert!(!changed(&g));
    assert_ne!(g.prop_anim_serial(), serial, "the client has to notice a restore");
    g.fire_input("babochka1", "SetAnimation", "run2");
    g.reset();
    assert!(!changed(&g));
}
