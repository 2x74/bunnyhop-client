//! Map sounds (`game/map_sounds.rs`): what the map's I/O asked its ambient_generics to do, read by the client. Display
//! only: reading it, and the map firing it, must not change the run.
//!
//! Needs the maps in maps/ (gitignored); each test skips when its map is absent.

use bunnyhop_core::game::{MAP_SOUND_ACTIVE, PHYSICS_LATEST};
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

fn total_starts(g: &Game) -> u32 {
    g.map_sound_states().map(|(a, _)| a.starts).sum()
}

/// bhop_waterfall: logic_timers fire PlaySound on start-silent, non-looping ambient_generics.
#[test]
fn timers_reach_ambient_generics() {
    let Some(mut g) = load("bhop_waterfall") else { return };
    assert!(g.map_sound_states().count() > 0);
    assert_eq!(total_starts(&g), 0);
    let serial = g.map_sound_serial();
    let idle = Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons: 0 };
    for _ in 0..(120.0 / g.settings.tick_interval) as usize {
        g.step(idle).unwrap();
    }
    assert!(total_starts(&g) > 0, "two minutes of timers started nothing");
    assert_ne!(g.map_sound_serial(), serial);
}

/// Restart and snapshot both bring the state back.
#[test]
fn reset_and_snapshots_restore_the_state() {
    let Some(mut g) = load("bhop_waterfall") else { return };
    let idle = Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons: 0 };
    let ticks = (60.0 / g.settings.tick_interval) as usize;
    for _ in 0..ticks {
        g.step(idle).unwrap();
    }
    let at = total_starts(&g);
    let snap = g.save_state();
    let serial = g.map_sound_serial();
    for _ in 0..ticks {
        g.step(idle).unwrap();
    }
    assert!(total_starts(&g) > at);
    g.restore_state(&snap);
    assert_eq!(total_starts(&g), at);
    assert_ne!(g.map_sound_serial(), serial, "the client has to notice a restore");
    g.reset();
    assert_eq!(total_starts(&g), 0);
    assert!(g.map_sound_states().all(|(a, removed)| removed || a.stops == 0));
}

/// Reading the states every tick changes nothing: the same commands land on the same position and velocity.
#[test]
fn reading_changes_nothing() {
    let Some(mut a) = load("bhop_waterfall") else { return };
    let Some(mut b) = load("bhop_waterfall") else { return };
    let cmd = Cmd { forward: 200.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons: 0 };
    let mut seen = 0u32;
    for _ in 0..4000 {
        a.step(cmd).unwrap();
        b.step(cmd).unwrap();
        seen = seen.wrapping_add(b.map_sound_states().map(|(s, _)| s.flags() & MAP_SOUND_ACTIVE).sum::<u32>());
        let _ = b.take_map_sound_commands();
        assert_eq!(a.state.player().position, b.state.player().position);
        assert_eq!(a.state.player().velocity, b.state.player().velocity);
    }
    let _ = seen;
}
