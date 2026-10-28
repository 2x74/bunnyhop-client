//! Keyframe snapshots (replay viewer seeking): `save_state` / `restore_state` must be bit-exact. Restoring a
//! capture and stepping has to reproduce the continuous run exactly, tick for tick (player state, every entity,
//! the I/O queue), on the same Game and on a second instance of the same map.
//! Maps are gitignored; each test skips (with a note) when its map is absent.

use bunnyhop_core::{Cmd, Game, game::IN_JUMP};
use std::path::PathBuf;

const MAPS: [&str; 4] = ["bhop_eazy", "bhop_eazy_v2", "bhop_arcane_v1", "bhop_badges_mini"];

fn load(name: &str) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping {name}: {} not found", path.display());
        return None;
    };
    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("bsp parses");
    Some(Game::load(&bsp).expect("game loads"))
}

/// Deterministic bhop-ish input: hold jump + forward, sweep the view and alternate strafes (xorshift noise so
/// the path wanders through doors, bhop blocks and triggers).
fn cmd(tick: u32) -> Cmd {
    let mut x = tick.wrapping_mul(2654435761) ^ 0x9e37_79b9;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    let phase = (tick / 40) % 2 == 0;
    Cmd {
        forward: if tick % 300 < 120 { 450.0 } else { 0.0 },
        side: if phase { -450.0 } else { 450.0 },
        yaw: (tick as f32 * 0.9 + (x % 7) as f32).rem_euclid(360.0) - 180.0,
        pitch: 0.0,
        buttons: if x % 5 != 0 { IN_JUMP } else { 0 },
    }
}

/// Steps ticks `from..to`, returning a full-state digest (player, entities, queue length, events) per tick.
fn run(game: &mut Game, from: u32, to: u32) -> Vec<Vec<u8>> {
    (from..to)
        .map(|t| {
            game.step(cmd(t)).expect("step");
            let mut d = game.snapshot_bytes();
            d.extend_from_slice(&game.events.to_le_bytes());
            d
        })
        .collect()
}

#[test]
fn restore_then_step_matches_continuous_run() {
    const SNAP_AT: u32 = 700;
    const END: u32 = 2500;
    for name in MAPS {
        let Some(mut game) = load(name) else { continue };
        let mut other = load(name).unwrap();
        run(&mut game, 0, SNAP_AT);
        let snap = game.save_state();
        assert_eq!(snap.tick(), SNAP_AT);
        assert!(snap.approx_bytes() > 0);
        let continuous = run(&mut game, SNAP_AT, END);
        let final_pos = game.state.position;

        // Same instance, after it moved on.
        game.restore_state(&snap);
        assert_eq!(game.tick, SNAP_AT);
        let replayed = run(&mut game, SNAP_AT, END);
        for (i, (a, b)) in continuous.iter().zip(&replayed).enumerate() {
            assert!(a == b, "{name}: state diverged {} ticks after restore", i + 1);
        }
        assert_eq!(game.state.position.map(f32::to_bits), final_pos.map(f32::to_bits));

        // A fresh instance of the same map (the viewer restores keyframes into its own core).
        other.restore_state(&snap);
        let fresh = run(&mut other, SNAP_AT, END);
        assert!(continuous == fresh, "{name}: fresh instance diverged after restore");

        // Restoring into the past after a reset (seek backwards) also matches.
        game.reset();
        run(&mut game, 0, 37);
        game.restore_state(&snap);
        assert!(run(&mut game, SNAP_AT, END) == continuous, "{name}: diverged after reset + restore");
    }
}

#[test]
fn camera_trace_hits_floor_and_clears_in_open_air() {
    for name in MAPS {
        let Some(game) = load(name) else { continue };
        let eye = [game.spawn_origin[0], game.spawn_origin[1], game.spawn_origin[2] + 64.0];
        // Straight down from the eye hits the floor the spawn stands on.
        let down = game.trace_camera(eye, [eye[0], eye[1], eye[2] - 4096.0], 6.0);
        assert!(down > 0.0 && down < 0.1, "{name}: floor below spawn ({down})");
        // A zero-length trace in free space is clear.
        assert_eq!(game.trace_camera(eye, eye, 6.0), 1.0, "{name}: eye is in open space");
        // A sealed map blocks a sweep that leaves the world.
        let far = game.trace_camera(eye, [eye[0] + 40000.0, eye[1], eye[2]], 6.0);
        assert!(far < 1.0, "{name}: sealed map blocks a long sweep");
    }
}
