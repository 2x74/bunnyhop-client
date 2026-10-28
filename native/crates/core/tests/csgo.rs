//! CS:GO (BSP v21) maps. The maps are gitignored and not part of the catalogue (research/CSGO-MAPS.md); each test
//! skips when its map is absent. bhop_spooktober: GameBanana 78512.

use bunnyhop_core::{Cmd, Game};
use std::path::PathBuf;

fn load(name: &str) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    if !path.exists() {
        eprintln!("skipping {name}: {} not found", path.display());
        return None;
    }
    Some(bunnyhop_core::content::load_game(&path).expect("map loads"))
}

/// Drops the player from `z` above (x, y) and returns where it comes to rest.
fn land(game: &mut Game, x: f32, y: f32, z: f32) -> f32 {
    game.place_player([x, y, z]);
    for _ in 0..300 {
        game.step(Cmd::default()).expect("step");
    }
    game.state.position[2]
}

#[test]
fn spooktober_scaled_static_props_collide_at_their_scale() {
    let Some(mut game) = load("bhop_spooktober") else { return };
    let bsp = bunnyhop_core::parse_bsp(&std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps/bhop_spooktober.bsp")).unwrap()).unwrap();
    let props = playsrc_bsp::parse_static_props(&bsp, Default::default()).unwrap().unwrap();
    assert_eq!(props.version, 11);
    let scales: Vec<f32> = props.occurrences.iter().map(|o| o.uniform_scale.value()).collect();
    assert!(scales.iter().any(|&s| s > 3.0), "v11 scales decoded: {scales:?}");
    // The two hallo pumpkins at (-1028, 1184) x2.16 and (-964, 1116) x2.38 stand on the same floor (z ~864): the
    // player rests on top of each, higher on the bigger one, about in proportion to the scale.
    let floor = land(&mut game, -1100.0, 1150.0, 900.0);
    let small = land(&mut game, -1028.0, 1184.0, 1000.0) - floor;
    let big = land(&mut game, -964.0, 1116.0, 1000.0) - floor;
    eprintln!("floor {floor}, pumpkin x2.16 top +{small}, x2.38 top +{big}");
    assert!(small > 20.0 && big > small, "pumpkins are solid at their scale ({small}, {big})");
    let ratio = big / small;
    assert!((ratio - 2.38 / 2.16).abs() < 0.05, "heights scale with the props ({ratio})");
}
