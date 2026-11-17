//! Physics v30, per-map changes (`game/map_fixes.rs`). Maps are gitignored; each test skips (with a note) when its map
//! is absent. Low Gravity: low_gravity_v30.rs; bhop_iso: physics_v30_iso.rs; the out-of-world line:
//! physics_v30_world_edge.rs.
//!
//! bhop_4triedsame (`EVENT_CLOCK_V30`): the "ускоритель" pad `*865` has `OnStartTouch !activator,AddOutput,basevelocity
//! 1455.21 -363,8.03438e+28,0`. Before v30 the 8e28 s delay never comes. From v30 the map runs on eventqueuefix's clock
//! and the overflowing delay fires on the next command, as the plugin's INT_MIN tick count does.
//!
//! bhop_theory_hard (`STALE_TOUCH_HULL_V30`): stage 10's playerclip (z 32..40) has the teleport `*80` (to the pyramid,
//! `stage10_2`) at 40..45 and the stage reset `*33` at 45..50 on top of it. CS:S tests triggers with the collision bounds
//! of the last PostThink, so the command that ducks in the air (feet lifted 8.5) still touches with the 62-unit standing
//! box: with the head at the clip that box reaches `*80`. From v30 the core does the same on this map.

use bunnyhop_core::game::{
    map_entity_fingerprint, map_event_clock_v23_table, map_event_clock_v29_table, map_event_clock_v30_for, map_event_clock_v30_table,
    map_stale_touch_hull_v30_for, map_stale_touch_hull_v30_table, EVENT_TELEPORTED, IN_DUCK, IN_JUMP, PHYSICS_LATEST, PHYSICS_V29,
    PHYSICS_V30,
};
use bunnyhop_core::{Cmd, Game, Settings};

fn load(name: &str, version: u32) -> Option<Game> {
    load_with(name, Settings { physics_version: version, ..Settings::css_bhop() })
}

fn load_with(name: &str, settings: Settings) -> Option<Game> {
    let path = bunnyhop_core::test_maps::bsp(name);
    if !path.exists() {
        return None;
    }
    let mut game = bunnyhop_core::content::load_game(&path).unwrap();
    game.set_settings(settings);
    game.reset();
    Some(game)
}

#[test]
fn v30_is_the_latest_and_the_clock_lists_only_4triedsame() {
    assert_eq!(PHYSICS_LATEST, PHYSICS_V30);
    assert_eq!(map_event_clock_v30_table(), vec![("bhop_4triedsame", 0x0c832785)]);
    // The older lists are unchanged.
    assert_eq!(map_event_clock_v29_table(), vec![("bhop_bistro_6", 0xfccd7e4e), ("bhop_bistro_7", 0x863ea0a0)]);
    assert_eq!(map_event_clock_v23_table().len(), 23);
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn the_v30_entry_matches_its_bsp() {
    let Some(game) = load("bhop_4triedsame", PHYSICS_V30) else { return };
    assert_eq!(map_entity_fingerprint(&game.entities), 0x0c832785, "the pinned build");
    assert_eq!(map_event_clock_v30_for(&game.entities), Some("bhop_4triedsame"));
    for other in ["bhop_4tele", "bhop_bistro_7", "kz_bhop_minimal", "bhop_eazy", "bhop_3d"] {
        let Some(game) = load(other, PHYSICS_V30) else { continue };
        assert_eq!(map_event_clock_v30_for(&game.entities), None, "{other} is not on the v30 clock");
    }
}

/// Walk east from the respawn room into the pad: (the highest horizontal speed seen, the command it came on, the first
/// command touching the pad).
fn walk_into_pad(version: u32) -> Option<(f32, u32, u32)> {
    let mut game = load("bhop_4triedsame", version)?;
    // In the nerdzplarz room (floor z 12416), 60 u west of the pad (x -10016..-9952, y 14176..14576).
    game.set_position([-10_100.0, 14_400.0, 12_420.0], 0.0);
    for _ in 0..40 {
        game.step(Cmd::default()).unwrap();
    }
    let (mut best, mut at, mut touch) = (0.0f32, 0, u32::MAX);
    for t in 0..60 {
        game.step(Cmd { forward: 400.0, yaw: 0.0, ..Cmd::default() }).unwrap();
        let x = game.state.position[0];
        if touch == u32::MAX && x + 16.0 >= -10_016.0 {
            touch = t;
        }
        let h = game.state.velocity[0].hypot(game.state.velocity[1]);
        if h > best {
            (best, at) = (h, t);
        }
    }
    Some((best, at, touch))
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn bhop_4triedsame_booster_fires_from_v30() {
    let Some(old) = walk_into_pad(PHYSICS_V29) else { return };
    let new = walk_into_pad(PHYSICS_V30).unwrap();
    eprintln!("bhop_4triedsame *865 (best speed, at, first touch): v29 {old:?}, v30 {new:?}");
    assert!(old.0 < 300.0, "v29: no boost, {old:?}");
    assert!(new.0 > 1450.0, "v30: the 1455 / -363 boost, {new:?}");
    assert!(new.1 <= new.2 + 2, "v30: on the command after the touch, {new:?}");
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn theory_hard_entry_matches_its_bsp() {
    assert_eq!(map_stale_touch_hull_v30_table(), vec![("bhop_theory_hard", 0x7cdad20a)]);
    let Some(game) = load("bhop_theory_hard", PHYSICS_V30) else { return };
    assert_eq!(map_entity_fingerprint(&game.entities), 0x7cdad20a);
    assert_eq!(map_stale_touch_hull_v30_for(&game.entities), Some("bhop_theory_hard"));
    for other in ["bhop_eazy", "bhop_4triedsame", "bhop_theory"] {
        let Some(game) = load(other, PHYSICS_V30) else { continue };
        assert_eq!(map_stale_touch_hull_v30_for(&game.entities), None, "{other}");
    }
}

const STAGE10_2: [f32; 3] = [-14048.0, -6208.0, 64.0];
const STAGE10: [f32; 3] = [-14448.0, -6208.0, -52.0];

/// From block `1111` (top -96, under the clip) jump, air jump on command `air` if Some (Infinite), press duck on command
/// `press` and hold it. Returns where a teleport sent the player, if one did before landing.
struct Stage10 {
    game: Game,
    start: bunnyhop_core::game::GameState,
}

impl Stage10 {
    fn new(settings: Settings) -> Option<Self> {
        let mut game = load_with("bhop_theory_hard", settings)?;
        game.set_position([-12448.0, -6544.0, -96.0], 0.0);
        for _ in 0..5 {
            game.step(Cmd::default()).unwrap();
        }
        let start = game.save_state();
        Some(Self { game, start })
    }

    fn run(&mut self, air: Option<u32>, press: u32) -> Option<[f32; 3]> {
        let game = &mut self.game;
        game.restore_state(&self.start);
        game.events = 0;
        for t in 0..150u32 {
            let jump = t < 2 || air.is_some_and(|a| t >= a && t < a + 2);
            let buttons = if jump { IN_JUMP } else { 0 } | if t >= press { IN_DUCK } else { 0 };
            game.step(Cmd { buttons, ..Cmd::default() }).unwrap();
            if game.events & EVENT_TELEPORTED != 0 {
                return Some(game.state.position);
            }
            if t > air.unwrap_or(0) + 3 && game.state.ground.is_some() {
                break;
            }
        }
        None
    }
}

fn at(p: [f32; 3], q: [f32; 3]) -> bool {
    (0..3).all(|k| (p[k] - q[k]).abs() < 2.0)
}

/// Infinite: an air jump puts the head against the clip (feet -30.03); a duck press there, or on the last rising
/// commands before it, reaches `*80` at v30 and never `*33`; v29 reaches neither.
#[cfg_attr(ci, ignore = "map library")]
#[test]
fn theory_hard_duck_under_the_clip_reaches_the_pyramid_from_v30() {
    let infinite = |version| Settings { physics_version: version, air_jump: true, ..Settings::css_bhop() };
    let Some(mut v30) = Stage10::new(infinite(PHYSICS_V30)) else { return };
    let mut v29 = Stage10::new(infinite(PHYSICS_V29)).unwrap();
    let hit = v30.run(Some(20), 28);
    assert!(hit.is_some_and(|p| at(p, STAGE10_2)), "v30, press at the bonk: {hit:?}");
    let mut window = Vec::new();
    for press in 20..60 {
        let new = v30.run(Some(20), press);
        let old = v29.run(Some(20), press);
        assert_eq!(old, None, "v29 press {press}");
        if let Some(p) = new {
            assert!(at(p, STAGE10_2) && !at(p, STAGE10), "v30 press {press}: {p:?}");
            window.push(press);
        }
    }
    eprintln!("bhop_theory_hard: air jump on 20, duck presses reaching *80: {window:?}");
    assert!(window.contains(&27) && window.contains(&28) && window.len() <= 4, "{window:?}");
}

/// Normal: a standing jump from these blocks peaks with the head at about z 23, so even the stale standing box of a
/// duck press (feet + 8.5 + 62) stays under 40 and touches nothing, on either version (reports/mapbugs.md assumed a
/// 72-unit standing hull; CS:S's is 62).
#[cfg_attr(ci, ignore = "map library")]
#[test]
fn theory_hard_standing_jump_reaches_neither_trigger() {
    for version in [PHYSICS_V29, PHYSICS_V30] {
        let Some(mut stage) = Stage10::new(Settings { physics_version: version, ..Settings::css_bhop() }) else { return };
        for press in 20..80 {
            assert_eq!(stage.run(None, press), None, "v{version} press {press}");
        }
    }
}
