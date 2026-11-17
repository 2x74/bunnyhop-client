//! Physics v30: the out-of-world kill line moves from 16,304 to 16,352 on x and y (`OUT_OF_WORLD_XY_V30`); z stays at
//! 16,304. Source never removes a player for position; the line only keeps the movement code's point queries inside
//! its +-16,384 check. bhop_hex's last teleport (`*5`, y 16,329.6-16,349.9) is past the old line, as are wall-side spots
//! on bhop_depot, bhop_downdowndown, bhop_easyarchitecture_css and six more sealed maps. Maps are gitignored; each test
//! skips when its map is missing.

use bunnyhop_core::game::{PHYSICS_V29, PHYSICS_V30, EVENT_RESPAWNED, EVENT_TELEPORTED};
use bunnyhop_core::{Cmd, Game, Settings};

fn load(name: &str, version: u32) -> Option<Game> {
    let path = bunnyhop_core::test_maps::bsp(name);
    if !path.exists() {
        return None;
    }
    let mut game = bunnyhop_core::content::load_game(&path).unwrap();
    game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
    game.reset();
    Some(game)
}

fn model_bounds(game: &Game, model: &str) -> ([f32; 3], [f32; 3]) {
    let i = game.entities.iter().position(|e| e.get("model") == Some(model)).unwrap_or_else(|| panic!("{model}"));
    game.entity_bounds(i).unwrap()
}

/// bhop_hex: the course's last jump north into trigger_teleport `*5` (target `mapfkoff`, 5607.78 12800.5 -109). The WR
/// is at y 16,313.05 the frame before the teleport (offstyles recording, frame 10,247). Here the player flies north at
/// the WR's x and z, from y 16,250 at 400 u/s, no input.
fn hex_last_jump(version: u32) -> Option<(bool, bool, [f32; 3])> {
    let mut game = load("bhop_hex", version)?;
    let (lo, hi) = model_bounds(&game, "*5");
    assert!(lo[1] > 16_320.0 && hi[1] < 16_352.0, "*5 is past the old line: {lo:?}..{hi:?}");
    game.practice_noclip_exit([7774.36, 16_250.0, -95.05], [0.0, 400.0, 150.0], 90.0, 0.0);
    game.events = 0;
    let (mut teleported, mut died) = (false, false);
    for _ in 0..60 {
        game.step(Cmd { yaw: 90.0, ..Cmd::default() }).unwrap();
        died |= game.events & EVENT_RESPAWNED != 0;
        if game.events & EVENT_TELEPORTED != 0 {
            teleported = true;
            break;
        }
    }
    Some((teleported, died, game.state.position))
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn hex_last_teleport_works_from_v30() {
    let Some((teleported, died, at)) = hex_last_jump(PHYSICS_V30) else { return };
    assert!(teleported && !died, "v30: teleported, at {at:?}");
    assert!((at[0] - 5607.78).abs() < 1.0 && (at[1] - 12_800.5).abs() < 1.0, "v30: at mapfkoff, {at:?}");
    let (_, died, at) = hex_last_jump(PHYSICS_V29).unwrap();
    assert!(died, "v29: killed at the old line, at {at:?}");
}

/// The player's centre at `p` (feet), at rest, one command with no input: killed?
fn killed_at(game: &mut Game, p: [f32; 3]) -> bool {
    game.reset();
    game.practice_noclip_exit([0.0, 0.0, 0.0], [0.0; 3], 0.0, 0.0);
    game.state.position = p;
    game.state.velocity = [0.0; 3];
    game.state.ground = None;
    game.events = 0;
    game.step(Cmd::default()).unwrap();
    game.events & EVENT_RESPAWNED != 0
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn the_line_is_16352_on_x_and_y_and_16304_on_z_from_v30() {
    let Some(mut game) = load("bhop_eazy", PHYSICS_V30) else { return };
    for (p, dies) in [
        ([16_340.0, 0.0, 0.0], false),
        ([-16_351.0, 0.0, 0.0], false),
        ([0.0, 16_351.9, 0.0], false),
        ([16_352.5, 0.0, 0.0], true),
        ([0.0, -16_360.0, 0.0], true),
        ([0.0, 0.0, 16_310.0], true),
        ([0.0, 0.0, -16_305.0], true),
        ([0.0, 0.0, 16_300.0], false),
    ] {
        assert_eq!(killed_at(&mut game, p), dies, "v30 at {p:?}");
    }
    let Some(mut old) = load("bhop_eazy", PHYSICS_V29) else { return };
    for (p, dies) in [([16_305.0, 0.0, 0.0], true), ([0.0, -16_340.0, 0.0], true), ([16_300.0, 0.0, 0.0], false), ([0.0, 0.0, 16_310.0], true)] {
        assert_eq!(killed_at(&mut old, p), dies, "v29 at {p:?}");
    }
}

/// bhop_downdowndown's start room runs up to the west wall at x -16,336: walking into it from the spawn puts the
/// player's centre at -16,320. Before v30 that killed (and respawned) them; from v30 they stand against the wall.
#[cfg_attr(ci, ignore = "map library")]
#[test]
fn downdowndown_start_room_wall_from_v30() {
    for (version, dies) in [(PHYSICS_V30, false), (PHYSICS_V29, true)] {
        let Some(mut game) = load("bhop_downdowndown", version) else { return };
        game.events = 0;
        let (mut died, mut min_x) = (false, f32::INFINITY);
        for _ in 0..1500 {
            game.step(Cmd { forward: 400.0, yaw: 180.0, ..Cmd::default() }).unwrap();
            died |= game.events & EVENT_RESPAWNED != 0;
            min_x = min_x.min(game.state.position[0]);
        }
        eprintln!("v{version}: spawn {:?}, min x {min_x}, died {died}", game.spawn_origin);
        assert_eq!(died, dies, "v{version}: min x {min_x}");
        if !dies {
            assert!(min_x < -16_304.0 && min_x >= -16_336.0, "v{version}: against the wall, min x {min_x}");
        }
    }
}
