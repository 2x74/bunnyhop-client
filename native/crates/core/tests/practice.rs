//! Practice mode noclip (`Game::practice_noclip_tick` / `practice_noclip_exit`): the player goes exactly where the
//! client puts it, the world keeps ticking, and leaving noclip inside solid finds free space nearby.
//! Maps are gitignored; each test skips (with a note) when its map is absent.

use bunnyhop_core::{Cmd, Game};
use std::path::PathBuf;

fn load(name: &str) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping {name}: {} not found", path.display());
        return None;
    };
    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("bsp parses");
    Some(Game::load(&bsp).expect("game loads"))
}

const IDLE: Cmd = Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons: 0 };

#[test]
fn noclip_tick_places_the_player_and_advances_the_world() {
    let Some(mut g) = load("bhop_eazy") else { return };
    for _ in 0..50 {
        g.step(IDLE).unwrap();
    }
    let start = g.state.position;
    let tick = g.tick;
    // Fly straight down through the floor: no collision stops it.
    let v = [0.0, 0.0, -800.0];
    let mut p = start;
    for i in 0..30 {
        p[2] -= 8.0;
        g.practice_noclip_tick(p, v);
        assert_eq!(g.tick, tick + i + 1);
        assert_eq!(g.state.position, p);
        assert_eq!(g.state.velocity, v);
        assert!(g.state.ground.is_none());
    }
    assert!(g.state.position[2] < start[2] - 200.0);
}

#[test]
fn noclip_exit_in_solid_finds_free_space_and_play_continues() {
    let Some(mut g) = load("bhop_eazy") else { return };
    for _ in 0..50 {
        g.step(IDLE).unwrap();
    }
    let feet = g.state.position;
    assert!(g.state.ground.is_some(), "settled on the spawn floor");
    // 20 units into the floor below the spawn: stuck standing; straight up (pitch 89: forward is down, up is
    // forward-ish) or any other direction must find space within 100 units.
    let inside = [feet[0], feet[1], feet[2] - 20.0];
    let r = g.practice_noclip_exit(inside, [0.0; 3], 0.0, 0.0);
    assert!(r == 1 || r == 2, "found free space ({r})");
    assert_ne!(g.state.position, inside);
    // Normal play resumes: the player falls back onto the floor.
    for _ in 0..200 {
        g.step(IDLE).unwrap();
    }
    assert!(g.state.ground.is_some());
    assert!((g.state.position[2] - feet[2]).abs() < 1.0, "back on the floor: {:?} vs {:?}", g.state.position, feet);

    // Free space: left exactly where it is, keeping the velocity.
    let air = [feet[0], feet[1], feet[2] + 40.0];
    assert_eq!(g.practice_noclip_exit(air, [100.0, 0.0, 0.0], 90.0, 0.0), 1);
    assert_eq!(g.state.position, air);
    assert_eq!(g.state.velocity, [100.0, 0.0, 0.0]);
}

#[test]
fn a_run_without_practice_calls_is_unchanged_by_a_practice_session_on_another_game() {
    // The practice functions only touch the Game they're called on: a second instance stepping the same commands is
    // bit-identical to a third that never shared a process with noclip (guards against hidden global state).
    let (Some(mut a), Some(mut b), Some(mut c)) = (load("bhop_eazy"), load("bhop_eazy"), load("bhop_eazy")) else { return };
    let cmd = |t: u32| Cmd { forward: 450.0, side: if (t / 50) % 2 == 0 { 450.0 } else { -450.0 }, yaw: (t as f32 * 0.7) % 360.0, pitch: 0.0, buttons: 2 };
    for t in 0..300 {
        c.practice_noclip_tick([t as f32, 0.0, 500.0], [0.0; 3]);
        a.step(cmd(t)).unwrap();
        b.step(cmd(t)).unwrap();
        assert_eq!(a.snapshot_bytes(), b.snapshot_bytes(), "tick {t}");
    }
    c.practice_noclip_exit([0.0, 0.0, 500.0], [0.0; 3], 0.0, 0.0);
    a.step(cmd(300)).unwrap();
    b.step(cmd(300)).unwrap();
    assert_eq!(a.snapshot_bytes(), b.snapshot_bytes());
}
