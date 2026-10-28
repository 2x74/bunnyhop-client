//! Physics v5 entity details found by the v0.0.10 map checks (research/WEAPONS.md, crates/core/src/game/weapons.rs):
//! - a picked-up gun loses its targetname (SDK `CBaseCombatWeapon::OnPickedUp`: SetName(NULL_STRING)), so a map's
//!   `Kill` on the spawner's name (bhop_badges / bhop_badges_mini, 5 s after a spawner fires) leaves the gun in hand;
//! - func_breakable "break on touch" (`CBreakable::BreakTouch`): bhop_hive's fake floor `bodenbreak1` over the fail
//!   teleports, respawned by a point_template from v5, breaks under the player as in CS:S instead of holding them.
//! Needs the maps in maps/ (gitignored); skips when absent.

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

fn idle(game: &mut Game, ticks: u32) {
    for _ in 0..ticks {
        game.step(Cmd { forward: 0.0, side: 0.0, yaw: 90.0, pitch: 0.0, buttons: 0 }).unwrap();
    }
}

#[test]
fn a_picked_up_gun_survives_the_spawners_kill() {
    // bhop_badges_mini's first segment-18 spawner: its trigger kills `glock` and ForceSpawns a new one, which the player
    // picks up at once; 5 s later the spawner's `glock,Kill` runs.
    let Some(mut game) = map("bhop_badges_mini", PHYSICS_V5) else { return };
    game.set_position([9052.0, -736.0, 11618.0], 90.0);
    idle(&mut game, 20);
    assert_eq!(game.weapon_report()[3], 2.0, "holding the Glock");
    game.place_player([1720.0, -3540.0, 14990.0]); // away from the spawner (the start room)
    idle(&mut game, 800);
    let r = game.weapon_report();
    assert_eq!((r[1], r[3]), (2.0, 2.0), "still holding and drawing the Glock 8 s later");
}

/// Drops the player onto bhop_hive's fake floor after `wait` ticks; returns the first teleport tick (None: never).
fn hive_drop(version: u32, wait: u32) -> Option<Option<u32>> {
    let mut game = map("bhop_hive", version)?;
    idle(&mut game, wait);
    game.place_player([-8048.0, 13336.0, -2950.0]);
    for t in 0..500u32 {
        game.step(Cmd { forward: 450.0, side: 0.0, yaw: t as f32 * 1.5, pitch: 0.0, buttons: 0 }).unwrap();
        if game.events & EVENT_TELEPORTED != 0 {
            return Some(Some(t));
        }
    }
    Some(None)
}

#[test]
fn hive_fake_floor_breaks_under_the_player() {
    let Some(v4) = hive_drop(PHYSICS_V4, 500) else { return };
    assert!(v4.is_some(), "v4: the floor was killed at map start, the fail teleport catches the player");
    let v5 = hive_drop(PHYSICS_V5, 500).unwrap();
    assert!(v5.is_some_and(|t| t < 200), "v5: the respawned floor breaks on touch, then the fail teleport ({v5:?})");
}
