//! Physics v24. Maps are gitignored; each test skips (with a note) when its map is absent.
//!
//! - The player's `basevelocity` / `origin` keyvalues are read as Source's `UTIL_StringToVector` reads them (atof per
//!   token, missing tokens 0): bhop_weed_funhouse's boosters (`basevelocity boostAmountX boostAmountY 1550`) launch the
//!   player, and did nothing before.
//! - `map_fixes::END_TOUCH_OUTPUTS_V24`: those two boosters fire on OnEndTouch, as the mapper meant: leaving the pad launches
//!   the player, as srcds does on a copy of the BSP with the key renamed (tools/parity `weed_et_*`, bit-exact).
//! - bhop_playboy_csgo (`map_fixes::PARENTED_DOORS_V24`): the spiral room's steps turn with their column, rot2.
//! - `map_fixes::CS_DELETED_PROPS_V24`: props CS:S deletes at spawn (bhop_hell's barrels) are gone.
//! - `map_fixes::EVENT_CLOCK_V24`: bhop_4tele's boost pads on EventQueueFix's clock.
//! - `map_fixes::PARENTED_PROPS_V24`: bhop_dtt_trainning2's crate blocks ride their sinking doors.
//! - Every map: shots don't use up the clip (bhoptimer `shavit_misc_weaponcommands 5`), so no reload ever starts.

use bunnyhop_core::game::{map_cs_deleted_props_v24, map_end_touch_outputs_v24, map_event_clock_v24_for, map_parented_doors_v24_for, map_parented_props_v24_for, EVENT_TELEPORTED, PHYSICS_V23, PHYSICS_V24};
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

/// Runs `cmds` on bhop_weed_funhouse from `origin` with `velocity`, autohop on. Returns every command's upward speed.
fn weed_run(version: u32, origin: [f32; 3], yaw: f32, velocity: [f32; 3], cmds: &[Cmd]) -> Option<Vec<f32>> {
    let mut game = load("bhop_weed_funhouse", version)?;
    game.set_position(origin, yaw);
    game.state.velocity = velocity;
    Some(cmds.iter().map(|&c| { game.step(c).unwrap(); game.state.velocity[2] }).collect())
}

fn cmds(n: usize, forward: f32, yaw: f32, buttons: u32) -> Vec<Cmd> {
    vec![Cmd { forward, side: 0.0, yaw, pitch: 0.0, buttons }; n]
}

const IN_JUMP: u32 = 2;
const IN_DUCK: u32 = 4;

/// Booster *1 is a 512 x 512 x 8 trigger_multiple on the floor at z 64 (x 4192..4704, y -2148..-1636). Its
/// `OnStartTouch !activator,AddOutput,Basevelocity boostAmountX boostAmountY 1550` fires on EndTouch from v24
/// (`map_fixes::END_TOUCH_OUTPUTS_V24`). Expected values are srcds on a copy of the BSP with the key renamed OnEndTouch
/// (tools/parity, /tmp/bh-0036/funhouse-report.md; the core is bit-exact with it on every case).
#[test]
fn weed_funhouse_boosters_fire_on_end_touch_from_v24() {
    let pad = [4448.0, -1892.0, 66.0];
    // Dropped onto the pad and standing on it: no boost (srcds weed_et_drop: vz stays 0 for 200 commands).
    let Some(drop) = weed_run(PHYSICS_V24, [4448.0, -1892.0, 120.0], 90.0, [0.0; 3], &cmds(200, 0.0, 90.0, 0)) else { return };
    assert!(drop.iter().all(|&v| v <= 0.0), "standing on the pad does nothing until the player leaves it");

    // Jumping off: the jump's command, two commands climbing through the 8 u pad, then EndTouch at the end of the frame
    // whose move took the feet above it; its AddOutput runs before the next command, which gets the 1550 u/s on top of the jump
    // (srcds weed_et_jumpoff: 289.99, 281.99, 273.99, 1823.74).
    let mut jump = cmds(30, 0.0, 90.0, 0);
    jump.push(Cmd { buttons: IN_JUMP, ..jump[0] });
    jump.extend(cmds(20, 0.0, 90.0, 0));
    let up = weed_run(PHYSICS_V24, pad, 90.0, [0.0; 3], &jump).unwrap();
    let j = 30;
    let srcds = [289.99, 281.99, 273.99, 1823.74];
    assert!(up[j..j + 4].iter().zip(srcds).all(|(a, b)| (a - b).abs() < 0.01), "jumping off launches as on srcds: {:?}", &up[j - 1..j + 5]);

    // Walking off the pad's edge: the boost on the command after the hull leaves it (srcds weed_et_walkoff: 1545.75).
    let walk = weed_run(PHYSICS_V24, pad, 90.0, [0.0; 3], &cmds(150, 400.0, 90.0, 0)).unwrap();
    let top = walk.iter().cloned().fold(f32::MIN, f32::max);
    assert!((top - 1545.75).abs() < 0.01, "walking off launches as on srcds, top vz {top}");
    let launch = walk.iter().position(|&v| v > 1000.0).unwrap();
    assert!(walk[..launch].iter().all(|&v| v <= 0.0), "no boost before the player leaves the pad");

    // Ducked jump off (srcds weed_et_duckoff: 1835.74).
    let mut duck = cmds(30, 0.0, 90.0, 0);
    duck.push(Cmd { buttons: IN_JUMP | IN_DUCK, ..duck[0] });
    duck.extend(cmds(20, 0.0, 90.0, IN_DUCK));
    let top = weed_run(PHYSICS_V24, pad, 90.0, [0.0; 3], &duck).unwrap().into_iter().fold(f32::MIN, f32::max);
    assert!((top - 1835.74).abs() < 0.01, "duck-jumping off launches as on srcds, top vz {top}");

    // Landing on the pad with jump held (autohop): launched on the way up from the hop.
    let top = weed_run(PHYSICS_V24, [4448.0, -1892.0, 120.0], 90.0, [0.0; 3], &cmds(60, 0.0, 90.0, IN_JUMP))
        .unwrap().into_iter().fold(f32::MIN, f32::max);
    assert!((top - 1823.74).abs() < 0.01, "bhopping off the pad launches as on srcds, top vz {top}");

    // v23 never applied the malformed basevelocity at all.
    let v23 = weed_run(PHYSICS_V23, pad, 90.0, [0.0; 3], &jump).unwrap().into_iter().fold(f32::MIN, f32::max);
    assert!(v23 < 300.0, "v23 keeps ignoring the boosters, top vz {v23}");
}

/// Only the two boosters on this build; the map's other outputs and every other map are unchanged.
#[test]
fn weed_funhouse_end_touch_table_pins_the_two_boosters() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps/bhop_weed_funhouse.bsp");
    if !path.exists() {
        eprintln!("skipping: {} not present", path.display());
        return;
    }
    let bsp = bunnyhop_core::parse_bsp(&std::fs::read(&path).unwrap()).unwrap();
    let list = bunnyhop_core::physics::entity_list_with_outputs(&bsp, true);
    let hits = map_end_touch_outputs_v24(&list.entities);
    let models: Vec<_> = hits.iter().map(|&i| list.entities[i].get("model").unwrap_or("")).collect();
    assert_eq!(models, ["*1", "*2"]);
    for &i in &hits {
        assert!(list.outputs[i].iter().all(|o| &*o.event == "onstarttouch"), "the build's boosters still say OnStartTouch");
    }
    for other in ["bhop_eazy", "bhop_4tele", "bhop_finalmap_strange_fixed2"] {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../maps/{other}.bsp"));
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
        assert!(map_end_touch_outputs_v24(&bunnyhop_core::physics::entity_list_with_outputs(&bsp, true).entities).is_empty(), "{other}");
    }
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
