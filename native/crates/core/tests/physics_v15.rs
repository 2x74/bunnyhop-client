//! Physics v15: Source's signed door travel on the maps in `game/map_fixes.rs` `SIGNED_DOOR_TRAVEL`
//! (`PHYSICS_FIX_MAP_DOOR_TRAVEL`): bhop_montana_fix's level 3 "UP" block (func_door *20, movedir down, 2 units thick,
//! lip 10, speed 300) rises 8 units when touched, and a jump off it as it rises carries its 300 u/s up, enough for the
//! next row of blocks 143 units higher. v14 stays as it was (the block never moves). Maps are gitignored; each test
//! skips (with a note) when its map is absent.

use bunnyhop_core::game::{IN_JUMP, PHYSICS_V14, PHYSICS_V15, map_signed_door_travel_for};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

fn load(name: &str, version: u32) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping {name}: {} not found", path.display());
        return None;
    };
    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("bsp parses");
    let mut game = Game::load(&bsp).expect("game loads");
    game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
    game.reset();
    Some(game)
}

/// Put the player on the UP block (top z 357, centre -3132.5 1710.5): (feet height after 6 ticks of standing, highest
/// point of a jump held from the first tick, which leaves the block as it starts to rise).
fn up_block(game: &mut Game) -> (f32, f32) {
    game.reset();
    game.place_player([-3132.0, 1710.0, 357.5]);
    // Its rename trigger teleports a player who stays 0.1 s, so stand for fewer than 10 ticks.
    for _ in 0..6 {
        game.step(Cmd::default()).unwrap();
    }
    let standing = game.state.position[2];
    game.reset();
    game.place_player([-3132.0, 1710.0, 357.5]);
    let mut top = game.state.position[2];
    for _ in 0..120 {
        game.step(Cmd { buttons: IN_JUMP, ..Cmd::default() }).unwrap();
        top = top.max(game.state.position[2]);
    }
    (standing, top)
}

#[test]
fn montana_up_block_launches_from_v15() {
    let Some(mut old) = load("bhop_montana_fix", PHYSICS_V14) else { return };
    let Some(mut new) = load("bhop_montana_fix", PHYSICS_V15) else { return };
    assert_eq!(map_signed_door_travel_for(&new.entities), Some("bhop_montana_fix"), "table entry");
    let (old_stand, old_top) = up_block(&mut old);
    let (new_stand, new_top) = up_block(&mut new);
    // v14: the travel is clamped at 0, so the block stays at 357 and a jump peaks about 57 units up.
    assert!((356.0..358.0).contains(&old_stand), "v14 stands on the block at its spawn height ({old_stand})");
    assert!(old_top < 420.0, "v14: a plain jump ({old_top})");
    // v15: the block rose 8 units (2 thick - lip 10) and the jump carried its 300 u/s: the next row (top 500.6) is in
    // reach, as on CS:S (bhop.rip recording: ~598 u/s up off the block, 228 units of climb).
    assert!(new_stand > old_stand + 6.0 && new_stand < old_stand + 9.0, "v15 rides the block up 8 units ({new_stand})");
    assert!(new_top > 560.0 && new_top < 600.0, "v15: the block launches the jump ({new_top})");
}

#[test]
fn other_maps_are_not_in_the_table() {
    for map in ["bhop_eazy", "bhop_frost_bite_v1", "bhop_areaportal_v1", "bhop_2easy"] {
        let Some(game) = load(map, PHYSICS_V15) else { continue };
        assert_eq!(map_signed_door_travel_for(&game.entities), None, "{map}");
    }
}
