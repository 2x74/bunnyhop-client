//! Physics v30, bhop_iso (`map_fixes::PLAYER_IO` entry with `min_physics` 30): its fail floors and one-jump pad run
//! through filter_activator_name `TestActivator` chains, which the core runs only on PLAYER_IO maps.
//! - `*49` (fail floor around the shaft) -> Checkpoint9 (`iso_checkpoint9*`) -> tele9, else Checkpoint8 -> tele8 / tele7;
//! - `*53` -> Checkpoint11 -> tele11 / tele10;
//! - `*50` (the one-jump pad, OnEndTouch OneJumpUsed): the first exit renames the player `iso_checkpoint9_jump1`, the
//!   second renames them back and teleports them to tele9.
//! Before v30 TestActivator does nothing there: falls land on the pit floor under `*49`. Maps are gitignored; each test
//! skips when `maps/bhop_iso.bsp` is missing.

use bunnyhop_core::game::{map_player_io_for, map_player_io_table, PHYSICS_V29, PHYSICS_V30, IN_JUMP, EVENT_TELEPORTED};
use bunnyhop_core::{Cmd, Game, Settings};

const TELE7: [f32; 3] = [544.592, 902.312, 50.85];
const TELE8: [f32; 3] = [364.072, -1850.56, -107.35];
const TELE9: [f32; 3] = [-634.036, 135.996, 96.05];
const TELE10: [f32; 3] = [-96.0, -1984.0, -1055.55];
const TELE11: [f32; 3] = [-1942.31, -5696.6, -513.15];

fn load(version: u32) -> Option<Game> {
    let path = bunnyhop_core::test_maps::bsp("bhop_iso");
    if !path.exists() {
        return None;
    }
    let mut game = bunnyhop_core::content::load_game(&path).unwrap();
    game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
    game.reset();
    Some(game)
}

fn near(p: [f32; 3], q: [f32; 3]) -> bool {
    (p[0] - q[0]).abs() < 1.0 && (p[1] - q[1]).abs() < 1.0 && (p[2] - q[2]).abs() < 4.0
}

/// Drop the player (named `name`) from `from` with no input until a teleport or `ticks` commands. Returns where the
/// player is after the teleport (or at the end) and whether a teleport happened.
fn drop_from(game: &mut Game, from: [f32; 3], name: &str, ticks: u32) -> ([f32; 3], bool) {
    game.reset();
    game.practice_noclip_exit(from, [0.0; 3], 0.0, 0.0);
    game.player_name = name.to_string();
    game.events = 0;
    for _ in 0..ticks {
        game.step(Cmd::default()).unwrap();
        if game.events & EVENT_TELEPORTED != 0 {
            return (game.state.position, true);
        }
    }
    (game.state.position, false)
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn the_entry_matches_iso_only_and_from_v30() {
    assert_eq!(map_player_io_table(), ["bhop_synthetic_fix", "bhop_wonderland", "bhop_lego3", "bhop_iso"]);
    let Some(game) = load(PHYSICS_V30) else { return };
    assert_eq!(map_player_io_for(&game.entities), Some("bhop_iso"));
    for other in ["bhop_eazy", "bhop_synthetic", "bhop_lego", "bhop_hex"] {
        let path = bunnyhop_core::test_maps::bsp(other);
        if !path.exists() {
            continue;
        }
        let g = bunnyhop_core::content::load_game(&path).unwrap();
        assert_eq!(map_player_io_for(&g.entities), None, "{other}");
    }
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn checkpoint_triggers_name_the_player_on_every_version() {
    for version in [PHYSICS_V29, PHYSICS_V30] {
        let Some(mut game) = load(version) else { return };
        for (at, name) in [
            (TELE7, "iso_checkpoint7"),
            (TELE8, "iso_checkpoint8"),
            (TELE9, "iso_checkpoint9"),
            (TELE10, "iso_checkpoint10"),
            (TELE11, "iso_checkpoint11"),
        ] {
            game.reset();
            game.practice_noclip_exit([at[0], at[1], at[2] + 1.0], [0.0; 3], 0.0, 0.0);
            for _ in 0..10 {
                game.step(Cmd::default()).unwrap();
            }
            assert_eq!(game.player_name, name, "v{version} at {at:?}");
        }
        game.reset();
        assert_eq!(game.player_name, "", "v{version}: a restart clears the name");
    }
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn fail_floor_49_sends_each_name_to_its_checkpoint_from_v30() {
    let Some(mut game) = load(PHYSICS_V30) else { return };
    for (name, to) in [
        ("", TELE7),
        ("iso_checkpoint7", TELE7),
        ("iso_checkpoint8", TELE8),
        ("iso_checkpoint9", TELE9),
        ("iso_checkpoint9_jump1", TELE9),
        ("ISO_CHECKPOINT9_JUMP1", TELE9),
        ("iso_checkpoint10", TELE7),
        ("iso_checkpoint11", TELE7),
    ] {
        let (at, teleported) = drop_from(&mut game, [0.0, -300.0, -600.0], name, 200);
        assert!(teleported && near(at, to), "v30 {name:?}: at {at:?}, want {to:?}");
    }
    let Some(mut old) = load(PHYSICS_V29) else { return };
    for name in ["", "iso_checkpoint8", "iso_checkpoint9"] {
        let (at, teleported) = drop_from(&mut old, [0.0, -300.0, -600.0], name, 200);
        assert!(!teleported && (at[2] + 670.5).abs() < 1.0 && old.state.ground.is_some(), "v29 {name:?}: lands on the pit floor, at {at:?}");
    }
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn the_hole_in_49_drops_onto_the_one_jump_pad() {
    for version in [PHYSICS_V29, PHYSICS_V30] {
        let Some(mut game) = load(version) else { return };
        for name in ["", "iso_checkpoint8"] {
            let (at, teleported) = drop_from(&mut game, [-632.0, -858.0, -600.0], name, 300);
            assert!(!teleported && (at[2] + 988.7).abs() < 0.5 && game.state.ground.is_some(), "v{version} {name:?}: {at:?}");
        }
    }
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn fail_floor_53_sends_each_name_to_its_checkpoint_from_v30() {
    let Some(mut game) = load(PHYSICS_V30) else { return };
    for (name, to) in [("iso_checkpoint11", TELE11), ("iso_checkpoint10", TELE10), ("", TELE10), ("iso_checkpoint9", TELE10)] {
        let (at, teleported) = drop_from(&mut game, [-1800.0, -3000.0, -560.0], name, 200);
        assert!(teleported && near(at, to), "v30 {name:?}: at {at:?}, want {to:?}");
    }
    let Some(mut old) = load(PHYSICS_V29) else { return };
    let (at, teleported) = drop_from(&mut old, [-1800.0, -3000.0, -560.0], "iso_checkpoint11", 200);
    assert!(!teleported, "v29: no teleport, at {at:?}");
}

/// On the pad as `iso_checkpoint9`: jump off it (moving forward), land on it again, jump off again. Returns the name
/// after each exit and where the second exit left the player.
fn two_exits(game: &mut Game) -> (String, String, [f32; 3], f32, bool) {
    game.reset();
    game.practice_noclip_exit([-632.0, -858.0, -900.0], [0.0; 3], 0.0, 0.0);
    game.player_name = "iso_checkpoint9".to_string();
    for _ in 0..60 {
        game.step(Cmd::default()).unwrap();
    }
    assert!(game.state.ground.is_some(), "standing on the pad");
    let mut names = Vec::new();
    let mut speed = 0.0;
    let mut teleported = false;
    for exit in 0..2 {
        // Jump with a little forward speed, wait for the landing back on the pad (or a teleport).
        game.events = 0;
        game.step(Cmd { forward: 100.0, buttons: IN_JUMP, ..Cmd::default() }).unwrap();
        for _ in 0..200 {
            speed = game.state.velocity[0].hypot(game.state.velocity[1]);
            game.step(Cmd::default()).unwrap();
            if game.events & EVENT_TELEPORTED != 0 {
                teleported = true;
                break;
            }
            if game.state.ground.is_some() {
                break;
            }
        }
        names.push(game.player_name.clone());
        if teleported || exit == 1 {
            break;
        }
        for _ in 0..20 {
            game.step(Cmd::default()).unwrap();
        }
    }
    let after = game.state.velocity[0].hypot(game.state.velocity[1]);
    let _ = speed;
    (names[0].clone(), names.get(1).cloned().unwrap_or_default(), game.state.position, after, teleported)
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn one_jump_pad_allows_one_exit_from_v30() {
    let Some(mut game) = load(PHYSICS_V30) else { return };
    let (first, second, at, speed, teleported) = two_exits(&mut game);
    assert_eq!(first, "iso_checkpoint9_jump1", "the first exit only renames");
    assert!(teleported && near(at, TELE9), "the second exit teleports to tele9: at {at:?}");
    assert_eq!(second, "iso_checkpoint9", "and renames back");
    assert!(speed > 0.0, "point_teleport keeps the velocity");
    let Some(mut old) = load(PHYSICS_V29) else { return };
    let (first, second, at, _, teleported) = two_exits(&mut old);
    assert!(!teleported && first == "iso_checkpoint9" && second == "iso_checkpoint9", "v29: nothing happens, at {at:?}");
}

/// Checkpoint9's filtername `iso_checkpoint9*`: the core's name filter takes a trailing `*` as Source's NamesMatch does
/// (case-insensitive prefix), so both of the pad's names pass and the other checkpoints don't.
#[test]
fn trailing_wildcard_filter_matches_as_source() {
    use bunnyhop_core::entities::name_matches;
    for name in ["iso_checkpoint9", "iso_checkpoint9_jump1", "ISO_CHECKPOINT9_JUMP1", "Iso_Checkpoint9x"] {
        assert!(name_matches("iso_checkpoint9*", name), "{name}");
    }
    for name in ["iso_checkpoint8", "", "iso_checkpoint", "iso_checkpoint10"] {
        assert!(!name_matches("iso_checkpoint9*", name), "{name}");
    }
    assert!(name_matches("iso_checkpoint8", "ISO_CHECKPOINT8") && !name_matches("iso_checkpoint8", "iso_checkpoint8_x"));
}
