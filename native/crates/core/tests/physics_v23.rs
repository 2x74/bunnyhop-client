//! Physics v23, per-map changes only. Maps are gitignored; each test skips (with a note) when its map is absent.
//!
//! kz_ maps: outputs on EventQueueFix's clock. The anti-hop block of kz_bhop_minimal (`*287`: OnStartTouch `gravity 40` at
//! 0.2 s, `gravity 1` at 0.3 s) slams a hop 26 commands after the touch on v22, which is bit-exact with srcds (tools/parity
//! `kzmin`), and 21 on v23, which is what recordings from eventqueuefix servers show (`map_fixes::EVENT_CLOCK_V23`).

use bunnyhop_core::game::{map_entity_fingerprint, map_event_clock_v23_for, map_event_clock_v23_table, EVENT_TELEPORTED, IN_JUMP, PHYSICS_V22, PHYSICS_V23};
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

/// Commands from the first touch of the block until gravity 40 pulls a hop down, holding jump from above the block, the
/// drop starting `wait` ticks after the reset. Event times are f32 seconds, as in the engine, so a tick here and there rounds
/// one command later.
fn slam_after_touch(version: u32, wait: u32) -> Option<u32> {
    let mut game = load("kz_bhop_minimal", version)?;
    for _ in 0..wait {
        game.step(Cmd::default()).unwrap();
    }
    game.place_player([120.0, 224.0, 520.0]);
    let (mut touch, mut last_vz) = (None, game.state.velocity[2]);
    for t in 0..120u32 {
        game.step(Cmd { buttons: IN_JUMP, ..Cmd::default() }).unwrap();
        let s = &game.state;
        if touch.is_none() && s.position[2] <= 500.0 {
            touch = Some(t);
        }
        if s.velocity[2] - last_vz < -300.0 {
            return Some(t - touch.unwrap());
        }
        last_vz = s.velocity[2];
    }
    panic!("no slam on v{version}");
}

#[test]
fn kz_anti_hop_is_five_ticks_shorter_on_v23() {
    let Some(first) = slam_after_touch(PHYSICS_V22, 0) else { return };
    assert_eq!(first, 26, "v22 = stock CS:S (tools/parity kzmin)");
    let count = |version| {
        let mut n = [0u32; 40];
        for wait in 0..30 {
            n[slam_after_touch(version, wait).unwrap() as usize] += 1;
        }
        n
    };
    let (old, new) = (count(PHYSICS_V22), count(PHYSICS_V23));
    eprintln!("v22 {old:?}\nv23 {new:?}");
    assert!(old[26] + old[27] == 30, "{old:?}");
    assert!(new[21] + new[22] == 30, "{new:?}");
    assert!(new[21] >= 15, "{new:?}");
}

#[test]
fn every_event_clock_entry_matches_its_build() {
    for (map, fingerprint) in map_event_clock_v23_table() {
        let Some(game) = load(map, PHYSICS_V23) else { continue };
        assert_eq!(map_entity_fingerprint(&game.entities), fingerprint, "{map}");
        assert_eq!(map_event_clock_v23_for(&game.entities), Some(map), "{map}");
    }
}

#[test]
fn bhop_maps_keep_the_stock_clock_on_v23() {
    let Some(game) = load("bhop_eazy", PHYSICS_V23) else { return };
    assert_eq!(map_event_clock_v23_for(&game.entities), None);
}

/// Standing on bhop_benchmark's block *497 for 0.65 s: back to the stage's start on v23, 20 minutes back on v22.
fn block_497_destination(version: u32) -> Option<[f32; 3]> {
    let mut game = load("bhop_benchmark", version)?;
    game.place_player([656.0, 2160.0, 2753.0]);
    for _ in 0..120 {
        game.step(Cmd::default()).unwrap();
        if game.events & EVENT_TELEPORTED != 0 {
            return Some(game.state.position);
        }
    }
    panic!("block *497 didn't teleport on v{version}");
}

#[test]
fn benchmark_block_497_goes_to_this_stage_on_v23() {
    let Some(old) = block_497_destination(PHYSICS_V22) else { return };
    assert_eq!((old[0], old[1]), (1792.0, 12416.0), "v22: destination 67, as in CS:S");
    let new = block_497_destination(PHYSICS_V23).unwrap();
    assert_eq!((new[0], new[1]), (1008.0, 2432.0), "v23: destination 100");
}

/// Falling onto bhop_trampislow's plate `*280` with jump held: the fastest the 46 u tall push `*279` above it gets the player.
fn trampislow_peak(version: u32) -> Option<f32> {
    let mut game = load("bhop_trampislow", version)?;
    game.place_player([12683.0, -7675.0, -8145.0]);
    let mut peak = 0f32;
    for _ in 0..100 {
        game.step(Cmd { buttons: IN_JUMP, ..Cmd::default() }).unwrap();
        peak = peak.max(game.state.velocity[2]);
    }
    Some(peak)
}

#[test]
fn trampislow_booster_reaches_its_recorded_speed_on_v23() {
    let Some(old) = trampislow_peak(PHYSICS_V22) else { return };
    let new = trampislow_peak(PHYSICS_V23).unwrap();
    assert_eq!(trampislow_peak(25).unwrap(), new, "production v25 inherits the clock fix");
    assert_eq!(trampislow_peak(26).unwrap(), new, "v26 preserves the working booster");
    // bhop.rip's recording peaks at 1138 u/s here, from a slightly different landing.
    assert!((old - 952.0).abs() < 8.0, "v22 {old}");
    assert!((new - 1134.0).abs() < 8.0, "v23 {new}");
}
