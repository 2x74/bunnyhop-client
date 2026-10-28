//! Physics v7 point_template name fixup (`PHYSICS_FIX_TEMPLATE_NAMES`, fix bit 13): the SDK's
//! `Templates_ReconnectIOForGroup` renames (`name&0001`) only the template entities that another keyvalue in the same
//! template targets; v5 and v6 rename every named one (kept, so recorded v5 / v6 runs replay as they were played).
//! bhop_monster_jam respawns its two button walls from point_templates at map start (`tbw` at 15 s, `tdi` at 23 s,
//! neither with "preserve names"), and the buttons break them by name:
//! - use button *60: `bw,Break` after 1 s (the wall between the Germany and France flags; tbw respawns it 14 s later);
//! - use button *75: `db,Break` after 20.5 s (the monster truck crashes through; behind it the teleport to the next
//!   section).
//! v5 / v6 rename them `bw&0001` / `db&0002`: the Break reaches nothing and the walls stay solid (player report,
//! 2026-10-08; no v5 / v6 main-track run of the map exists). The player positions are darkrider's at their presses in
//! their v4 run HiRiGOzVVO-cWyEg. Needs maps/bhop_monster_jam.bsp (gitignored); skips when absent.

use bunnyhop_core::game::{IN_USE, PHYSICS_V5, PHYSICS_V6, PHYSICS_V7};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

/// bw (func_breakable, model *581) and db (model *539).
const BW_MODEL: u32 = 581;
const DB_MODEL: u32 = 539;

fn monster_jam(version: u32) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps/bhop_monster_jam.bsp");
    if !path.exists() {
        eprintln!("skipping: {} not found", path.display());
        return None;
    }
    let mut game = bunnyhop_core::content::load_game(&path).expect("map loads");
    game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
    game.reset();
    Some(game)
}

fn idle(game: &mut Game, ticks: u32, yaw: f32) {
    for _ in 0..ticks {
        game.step(Cmd { forward: 0.0, side: 0.0, yaw, pitch: 0.0, buttons: 0 }).unwrap();
    }
}

fn solid(game: &Game, model: u32) -> bool {
    game.brush_states().iter().find(|s| s.0 == model).map(|s| s.2).expect("model is a brush entity")
}

/// Stands at `at`, presses +use at `button` for 5 ticks, then idles; returns the wall's solidity at each check tick
/// (counted from the press).
fn press(version: u32, at: [f32; 3], button: [f32; 3], wall: u32, checks: &[u32]) -> Option<Vec<bool>> {
    let mut game = monster_jam(version)?;
    idle(&mut game, 2500, 0.0); // 25 s: both templates have spawned their walls
    game.set_position(at, 0.0);
    idle(&mut game, 20, 0.0);
    let eye = [game.state.position[0], game.state.position[1], game.state.position[2] + 64.0];
    let d = [button[0] - eye[0], button[1] - eye[1], button[2] - eye[2]];
    let yaw = d[1].atan2(d[0]).to_degrees();
    let pitch = -d[2].atan2(d[0].hypot(d[1])).to_degrees();
    assert!(solid(&game, wall), "the wall stands before the press");
    for _ in 0..5 {
        game.step(Cmd { forward: 0.0, side: 0.0, yaw, pitch, buttons: IN_USE }).unwrap();
    }
    let mut out = Vec::new();
    let mut t = 5;
    for &c in checks {
        idle(&mut game, c - t, yaw);
        t = c;
        out.push(solid(&game, wall));
    }
    Some(out)
}

#[test]
fn bw_breaks_a_second_after_its_button_and_comes_back() {
    let (at, button) = ([3625.0, -3554.0, 4992.0], [3568.0, -3568.0, 5028.0]);
    let checks = [90, 120, 1500];
    let Some(v5) = press(PHYSICS_V5, at, button, BW_MODEL, &checks) else { return };
    assert_eq!(v5, [true, true, true], "v5: Break targets `bw`, the respawned wall is `bw&0001`");
    let v6 = press(PHYSICS_V6, at, button, BW_MODEL, &checks).unwrap();
    assert_eq!(v6, [true, true, true], "v6 keeps v5's names: the wall stays");
    let v7 = press(PHYSICS_V7, at, button, BW_MODEL, &checks).unwrap();
    assert_eq!(v7, [true, false, true], "v7: gone 1 s after the press, respawned by tbw 14 s after it");
}

#[test]
fn db_breaks_twenty_seconds_after_its_button() {
    let (at, button) = ([10652.0, -5160.0, 7768.0], [10656.0, -5208.0, 7780.0]);
    let checks = [2000, 2100];
    let Some(v5) = press(PHYSICS_V5, at, button, DB_MODEL, &checks) else { return };
    assert_eq!(v5, [true, true], "v5: Break targets `db`, the respawned wall is `db&0002`");
    let v6 = press(PHYSICS_V6, at, button, DB_MODEL, &checks).unwrap();
    assert_eq!(v6, [true, true], "v6 keeps v5's names: the wall stays");
    let v7 = press(PHYSICS_V7, at, button, DB_MODEL, &checks).unwrap();
    assert_eq!(v7, [true, false], "v7: gone 20.5 s after the press");
}
