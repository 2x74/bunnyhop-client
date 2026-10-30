//! Physics v21: a func_door_rotating that starts open spawns at its open angles (`CRotDoor::Spawn` teleports it there).
//! bhop_collective's three hotel doors (`spawnpos` 1, locked, nothing else moves them) are the only such doors in the
//! catalogue, and every run goes through them. The numbers are the real engine's, from tools/parity jobs on a copy of the
//! map with its start-room teleport *299 disabled for the bot. v20 stays as it was: shut and solid. The map is gitignored;
//! each test skips (with a note) when it is absent.

use bunnyhop_core::game::{PHYSICS_V20, PHYSICS_V21};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

fn load(version: u32) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps/bhop_collective.bsp");
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping bhop_collective: {} not found", path.display());
        return None;
    };
    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("bsp parses");
    let mut game = Game::load(&bsp).expect("load");
    game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
    game.reset();
    Some(game)
}

fn yaw(game: &Game, model: u32) -> f32 {
    let (_, _, angles) = game.brush_transforms().into_iter().find(|b| b.0 == model).expect("model");
    assert_eq!((angles[0], angles[2]), (0.0, 0.0), "*{model} only turns around z");
    angles[1]
}

/// Free flight from `from` with no input for `ticks` ticks.
fn fly(game: &mut Game, from: [f32; 3], velocity: [f32; 3], ticks: usize) -> [f32; 3] {
    game.reset();
    game.state.position = from;
    game.state.velocity = velocity;
    game.state.ground = None;
    for _ in 0..ticks {
        game.step(Cmd::default()).unwrap();
    }
    game.state.position
}

#[test]
fn doors_spawn_at_the_engines_angles_only_from_v21() {
    let Some(mut game) = load(PHYSICS_V21) else { return };
    // Measured on srcds: 90, -68 and 75 at the first tick; *160 (the same door with spawnpos 0) stays shut.
    let doors = [(130, 90.0), (133, -68.0), (134, 75.0), (160, 0.0)];
    for (model, open) in doors {
        assert_eq!(yaw(&game, model), open, "*{model} at v21");
    }
    // The client picks the version after loading: both ways need the spawn state at once, without another restart.
    game.set_settings(Settings { physics_version: PHYSICS_V20, ..Settings::css_bhop() });
    for (model, _) in doors {
        assert_eq!(yaw(&game, model), 0.0, "*{model} at v20");
    }
    game.set_settings(Settings { physics_version: PHYSICS_V21, ..Settings::css_bhop() });
    for (model, open) in doors {
        assert_eq!(yaw(&game, model), open, "*{model} back at v21");
    }
}

#[test]
fn a_restart_keeps_them_open() {
    let Some(mut game) = load(PHYSICS_V21) else { return };
    for _ in 0..600 {
        game.step(Cmd::default()).unwrap();
    }
    assert_eq!(yaw(&game, 133), -68.0, "they don't close on their wait of 4 s");
    game.reset();
    assert_eq!(yaw(&game, 133), -68.0);
}

/// Flights along an external WR's line through each doorway; srcds passes all three.
const THROUGH: [([f32; 3], [f32; 3]); 3] = [
    ([10370.0, -10860.0, -13150.0], [0.0, -300.0, 100.0]), // *133
    ([9262.0, -10960.0, -13160.0], [0.0, 300.0, 100.0]),   // *134
    ([5700.0, -10910.0, -13130.0], [-300.0, 0.0, 50.0]),   // *130
];

#[test]
fn v20_stops_at_the_doors_and_v21_goes_through() {
    let (Some(mut old), Some(mut new)) = (load(PHYSICS_V20), load(PHYSICS_V21)) else { return };
    // 24 ticks at 300 u/s = 72 units along the flight: past the door plane in all three, before any open panel (srcds is
    // still in free flight there, and so is v21; v20 is stopped by the shut door).
    for (from, velocity) in THROUGH {
        let axis = if velocity[0] != 0.0 { 0 } else { 1 };
        let free = from[axis] + velocity[axis] * 0.24;
        let (stopped, through) = (fly(&mut old, from, velocity, 24), fly(&mut new, from, velocity, 24));
        assert!((through[axis] - free).abs() < 0.01, "v21 from {from:?}: {through:?}");
        assert!((stopped[axis] - free).abs() > 15.0, "v20 from {from:?}: {stopped:?}");
    }
}

/// The open panel is where the engine has it. *130 is open at 90 degrees, so the hull meets an axis-aligned face.
#[test]
fn the_open_panel_of_the_90_degree_door_stops_a_flight_where_srcds_does() {
    let Some(mut game) = load(PHYSICS_V21) else { return };
    let p = fly(&mut game, [5570.0, -10915.0, -13130.0], [0.0, -300.0, 50.0], 15);
    assert_eq!(p[1], -10936.469, "srcds stops at y -10936.47");
    let Some(mut old) = load(PHYSICS_V20) else { return };
    let p = fly(&mut old, [5570.0, -10915.0, -13130.0], [0.0, -300.0, 50.0], 30);
    assert!(p[1] < -10985.0, "shut, the panel isn't there: {p:?}");
}
