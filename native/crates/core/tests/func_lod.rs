//! func_lod solidity (physics v5 `PHYSICS_FIX_FUNC_LOD`; research/maps/2flocci2furious.md): CS:S makes a func_lod
//! SOLID_BSP unless its "Solid" key is non-zero. bhop_2flocci2furious's stepping tiles are such func_lod: from v5 the
//! player lands and hops on them (bit-exact with the real engine in tools/parity), v1-v4 keep falling through into the
//! fail teleport (existing replays). bhop_omniscient's func_lod are "Solid 1" and stay non-solid. Needs the maps in
//! maps/ (gitignored); skips when absent.

use bunnyhop_core::game::{EVENT_TELEPORTED, PHYSICS_V4, PHYSICS_V5};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

fn map(name: &str, version: u32) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    if !path.exists() {
        eprintln!("skipping {name}: {} not found", path.display());
        return None;
    }
    let mut game = bunnyhop_core::content::load_game(&path).expect("map loads");
    game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
    game.reset();
    Some(game)
}

/// fl_stand / fl_hop: dropped onto tile #536 from (1019, 467, -3880), no input or holding jump (autohop). Returns the
/// first teleport tick (None: never) and the final feet height.
fn on_tile(version: u32, buttons: u32, ticks: u32) -> Option<(Option<u32>, f32)> {
    let mut game = map("bhop_2flocci2furious", version)?;
    game.place_player([1019.0, 467.0, -3880.0]);
    let mut teleported = None;
    for t in 1..=ticks {
        game.step(Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons }).unwrap();
        if game.events & EVENT_TELEPORTED != 0 && teleported.is_none() {
            teleported = Some(t);
        }
    }
    Some((teleported, game.state.position[2]))
}

#[test]
fn flocci_tiles_hold_the_player_from_v5() {
    let Some((tp, z)) = on_tile(PHYSICS_V5, 0, 60) else { return };
    assert_eq!(tp, None, "v5 fl_stand: stays on the tile");
    assert!((z - -3882.56).abs() < 0.05, "v5 fl_stand: on the tile top like the engine (z {z})");
    let (tp, z) = on_tile(PHYSICS_V5, 1 << 1, 200).unwrap();
    assert_eq!(tp, None, "v5 fl_hop: hops on the tile, never reset (z {z})");
    let (tp, _) = on_tile(PHYSICS_V4, 0, 60).unwrap();
    assert!(tp.is_some_and(|t| t < 40), "v4 falls through into the fail teleport (tick {tp:?})");
}

#[test]
fn non_solid_func_lod_stay_non_solid() {
    let Some(game) = map("bhop_omniscient", PHYSICS_V5) else { return };
    let lods: Vec<usize> = (0..game.entities.len()).filter(|&i| game.entities[i].get("classname") == Some("func_lod")).collect();
    assert!(!lods.is_empty());
    assert!(lods.iter().all(|&i| !game.entity_solidity(i).is_some_and(|(solid, _)| solid)), "Solid 1 func_lod are not solid");
}
