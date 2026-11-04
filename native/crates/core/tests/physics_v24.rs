//! Physics v24. Maps are gitignored; each test skips (with a note) when its map is absent.
//!
//! - The player's `basevelocity` / `origin` keyvalues are read as Source's `UTIL_StringToVector` reads them (atof per
//!   token, missing tokens 0): bhop_weed_funhouse's boosters (`basevelocity boostAmountX boostAmountY 1550`) launch the
//!   player as on srcds (tools/parity `weed_drop`, `weed_airon`: bit-exact for 200 / 250 ticks), and did nothing before.
//! - bhop_playboy_csgo (`map_fixes::PARENTED_DOORS_V24`): the spiral room's steps turn with their column, rot2.
//! - `map_fixes::CS_DELETED_PROPS_V24`: props CS:S deletes at spawn (bhop_hell's barrels) are gone.
//! - `map_fixes::EVENT_CLOCK_V24`: bhop_4tele's boost pads on EventQueueFix's clock.
//! - `map_fixes::PARENTED_PROPS_V24`: bhop_dtt_trainning2's crate blocks ride their sinking doors.
//! - Every map: shots don't use up the clip (bhoptimer `shavit_misc_weaponcommands 5`), so no reload ever starts.

use bunnyhop_core::game::{map_cs_deleted_props_v24, map_event_clock_v24_for, map_parented_doors_v24_for, map_parented_props_v24_for, EVENT_TELEPORTED, PHYSICS_V23, PHYSICS_V24};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

fn load(name: &str, version: u32) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../maps/{name}.bsp"));
    if !path.exists() {
        eprintln!("skipping: {} not present", path.display());
        return None;
    }
    let mut game = bunnyhop_core::content::load_game(&path).unwrap();
    game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
    game.reset();
    Some(game)
}

/// Falls onto booster *1 (a 512 x 512 x 8 trigger_multiple on the floor at z 64) moving forward, as tools/parity
/// `weed_airon` does on srcds: the highest upward speed over 250 commands.
fn weed_launch(version: u32) -> Option<f32> {
    let mut game = load("bhop_weed_funhouse", version)?;
    game.set_position([4300.0, -1700.0, 300.0], -90.0);
    game.state.velocity = [150.0, -400.0, 0.0];
    let mut top = f32::MIN;
    for _ in 0..250 {
        game.step(Cmd { forward: 400.0, side: 0.0, yaw: -90.0, pitch: 0.0, buttons: 0 }).unwrap();
        top = top.max(game.state.velocity[2]);
    }
    Some(top)
}

#[test]
fn weed_funhouse_boosters_launch_from_v24() {
    let (Some(v23), Some(v24)) = (weed_launch(PHYSICS_V23), weed_launch(PHYSICS_V24)) else { return };
    assert!(v23 < 1.0, "v23 keeps ignoring the malformed basevelocity, top vz {v23}");
    // srcds: 1549.75 on the landing tick's next command (1550 * 1.005 minus a tick of gravity).
    assert!((v24 - 1549.75).abs() < 0.01, "v24 launches as on srcds, top vz {v24}");
}

fn brush(game: &Game, model: u32) -> ([f32; 3], [f32; 3]) {
    let b = game.brush_transforms().into_iter().find(|b| b.0 == model).unwrap();
    (b.1, b.2)
}

const COLUMN: [f32; 2] = [-2755.0, -4093.0];
const ROT2: u32 = 395;
const STEP: u32 = 466;

/// Starts rot2 (trigger *524 at the room's floor), lets it turn for `ticks`, then stands the player on step *466 where it
/// is drawn now and idles 9 commands (a bhop step starts to sink 10 commands after it is touched, and a rider who stays
/// sinks into the gap teleport like on any bhop block). Returns (teleported, how far the player turned around the column
/// in degrees).
fn ride_step(version: u32, ticks: u32) -> Option<(bool, f32)> {
    let mut game = load("bhop_playboy_csgo", version)?;
    game.set_position([-2600.0, -4300.0, 600.0], 0.0);
    for _ in 0..ticks {
        game.step(Cmd::default()).unwrap();
    }
    let (o, _) = brush(&game, STEP);
    game.set_position([o[0], o[1], o[2] + 7.0], 0.0);
    let angle = |p: [f32; 3]| (p[1] - COLUMN[1]).atan2(p[0] - COLUMN[0]).to_degrees();
    let a0 = angle(game.state.position);
    let mut teleported = false;
    for _ in 0..9 {
        game.step(Cmd::default()).unwrap();
        teleported |= game.events & EVENT_TELEPORTED != 0;
    }
    Some((teleported, angle(game.state.position) - a0))
}

#[test]
fn playboy_steps_turn_with_their_column_from_v24() {
    let Some(game) = load("bhop_playboy_csgo", PHYSICS_V24) else { return };
    assert_eq!(map_parented_doors_v24_for(&game.entities), Some("bhop_playboy_csgo"));
    for (version, follows) in [(PHYSICS_V23, false), (PHYSICS_V24, true)] {
        let mut game = load("bhop_playboy_csgo", version).unwrap();
        game.set_position([-2600.0, -4300.0, 600.0], 0.0);
        for _ in 0..200 {
            game.step(Cmd::default()).unwrap();
        }
        let column_yaw = brush(&game, ROT2).1[1];
        let step_yaw = brush(&game, STEP).1[1];
        assert!(column_yaw < -70.0, "rot2 runs (reverse, 40 deg/s): {column_yaw}");
        assert_eq!((step_yaw - column_yaw).abs() < 0.01, follows, "v{version}: step yaw {step_yaw}, column {column_yaw}");
    }
    // Riding a step: on v24 the player turns with it and stays on the course; on v23 the column's teleport sweeps the
    // still step and sends the player back to level212.
    let mut v23_sent_back = 0;
    for start in [100, 200, 300, 400, 500, 600] {
        let (teleported, turned) = ride_step(PHYSICS_V24, start).unwrap();
        assert!(!teleported, "v24 ride from tick {start} teleported");
        assert!(turned < -2.5, "v24 ride from tick {start} turned {turned} deg");
        let (sent_back, turned) = ride_step(PHYSICS_V23, start).unwrap();
        eprintln!("v23 ride from tick {start}: teleported {sent_back}, turned {turned:.1}");
        v23_sent_back += sent_back as u32;
    }
    assert!(v23_sent_back > 0, "v23 never sent a step rider back");
}

/// Where a player dropped onto bhop_hell's middle barrel (-3296, 3320, floor z 360) comes to rest.
fn hell_barrel_rest(version: u32) -> Option<f32> {
    let mut game = load("bhop_hell", version)?;
    game.set_position([-3296.0, 3320.0, 480.0], 0.0);
    for _ in 0..200 {
        game.step(Cmd::default()).unwrap();
    }
    assert!(game.state.ground.is_some());
    Some(game.state.position[2])
}

#[test]
fn hell_barrels_are_gone_from_v24() {
    let (Some(v23), Some(v24)) = (hell_barrel_rest(PHYSICS_V23), hell_barrel_rest(PHYSICS_V24)) else { return };
    assert!(v23 > 380.0, "v23 stands on the barrel at z {v23}");
    // srcds: a trace down through the barrel's centre hits the floor at z 361.
    assert!((v24 - 361.0).abs() < 2.0, "v24 falls to the floor, z {v24}");
}

#[test]
fn every_deleted_prop_row_matches_its_build() {
    for (map, n) in [("bhop_hell", 7), ("bhop_ecodus", 3), ("bhop_mirrorsedge_chpt1", 1), ("bhop_mist_4", 2), ("bhop_sina_fix", 1),
        ("kz_bhop_strafe_comjump2_v2", 1), ("surf_prelude_fix", 1)] {
        let Some(game) = load(map, PHYSICS_V24) else { continue };
        assert_eq!(map_cs_deleted_props_v24(&game.entities).len(), n, "{map}");
        for i in map_cs_deleted_props_v24(&game.entities) {
            assert!(!game.entity_visible(i), "{map} prop {i} still drawn on v24");
        }
        let old = load(map, PHYSICS_V23).unwrap();
        for i in map_cs_deleted_props_v24(&old.entities) {
            assert!(old.entity_visible(i), "{map} prop {i} hidden on v23");
        }
    }
    let Some(eazy) = load("bhop_eazy", PHYSICS_V24) else { return };
    assert!(map_cs_deleted_props_v24(&eazy.entities).is_empty());
}

/// tools/parity `adds_dtt_drop`: dropped at (-19.3, 404.5, 75) onto the crate on door `a`. srcds lands on the crate at z 66.0
/// on tick 15 (ground entity: the prop) and rides the door down; returns (first grounded tick, z there, teleported).
fn dtt_drop(version: u32) -> Option<(Option<u32>, f32, bool)> {
    let mut game = load("bhop_dtt_trainning2", version)?;
    game.place_player([-19.3, 404.5, 75.0]);
    let mut teleported = false;
    for t in 1..=40u32 {
        game.step(Cmd { forward: 0.0, side: 0.0, yaw: 90.0, pitch: 0.0, buttons: 0 }).unwrap();
        teleported |= game.events & EVENT_TELEPORTED != 0;
        if game.state.ground.is_some() && !teleported {
            return Some((Some(t), game.state.position[2], teleported));
        }
    }
    Some((None, game.state.position[2], teleported))
}

#[test]
fn dtt_trainning2_crates_carry_the_player_from_v24() {
    let Some(game) = load("bhop_dtt_trainning2", PHYSICS_V24) else { return };
    assert_eq!(map_parented_props_v24_for(&game.entities), Some("bhop_dtt_trainning2"));
    let (v23, v24) = (dtt_drop(PHYSICS_V23).unwrap(), dtt_drop(PHYSICS_V24).unwrap());
    assert!(v23.0.is_none() && v23.2, "v23 falls through the crate into the teleport: {v23:?}");
    let (tick, z, _) = v24;
    assert_eq!((tick, z), (Some(15), 66.0), "v24 lands on the crate like srcds (z 66.0 on tick 15, bit-exact to tick 22)");
    assert!(game.render_props().iter().filter(|p| p.4 != 0).count() >= 36, "the crates are drawn, moving");
}

#[test]
fn four_tele_is_on_the_event_clock_from_v24() {
    let Some(game) = load("bhop_4tele", PHYSICS_V24) else { return };
    assert_eq!(map_event_clock_v24_for(&game.entities), Some("bhop_4tele"));
}

/// Holds +attack with a USP (12-round clip) given by a weapon command for 600 ticks on bhop_eazy: (shots, reloads started,
/// clip at the end).
fn usp_spray(version: u32) -> Option<(u32, u32, f32)> {
    use bunnyhop_core::game::{EVENT_ATTACK, IN_ATTACK, IN_GIVE_SHIFT};
    let mut game = load("bhop_eazy", version)?;
    for _ in 0..20 {
        game.step(Cmd::default()).unwrap();
    }
    game.step(Cmd { buttons: 3 << IN_GIVE_SHIFT, ..Cmd::default() }).unwrap();
    let (mut shots, mut reloads, mut reloading) = (0, 0, false);
    for t in 0..600u32 {
        // Pistols fire once per click: press on even ticks.
        game.step(Cmd { buttons: if t % 2 == 0 { IN_ATTACK } else { 0 }, ..Cmd::default() }).unwrap();
        shots += (game.events & EVENT_ATTACK != 0) as u32;
        // weapon_report [7]: reload ticks left.
        let now = game.weapon_report()[7] > 0.0;
        reloads += (now && !reloading) as u32;
        reloading = now;
    }
    Some((shots, reloads, game.weapon_report()[5]))
}

#[test]
fn clips_never_run_out_from_v24() {
    let (Some(v23), Some(v24)) = (usp_spray(PHYSICS_V23), usp_spray(PHYSICS_V24)) else { return };
    assert!(v23.1 > 0, "v23 empties the clip and reloads: {v23:?}");
    assert_eq!((v24.1, v24.2), (0, 12.0), "v24 never reloads and the clip stays full: {v24:?}");
    assert!(v24.0 > v23.0, "v24 fires more in the same time: {v24:?} vs {v23:?}");
}
