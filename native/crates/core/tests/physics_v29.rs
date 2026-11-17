//! Physics v29, per-map changes only (`map_fixes::EVENT_CLOCK_V29`). Maps are gitignored; each test skips (with a note)
//! when its map is absent.
//!
//! bhop_bistro_7's gravity lift `*2` and bhop_bistro_6's `*7` are trigger_multiples with OnStartTouch `!activator AddOutput
//! "gravity -1"` and OnEndTouch `"gravity 1"`, both with no delay. With the player clock lead (5 commands at 100 tick) the
//! start output lands after the end output when the hull touches the shaft for 1 to 4 ticks, so the player keeps
//! gravity -1 and floats to the ceiling (v28). From v29 these two builds run on EventQueueFix's clock: gravity -1 lands on
//! the command after the first touch and gravity 1 on the command after the last, so every graze ends at gravity 1.

use bunnyhop_core::game::{map_entity_fingerprint, map_event_clock_v29_for, map_event_clock_v29_table, PHYSICS_LATEST, PHYSICS_V28, PHYSICS_V29};
use bunnyhop_core::{Cmd, Game, Settings};

fn load(name: &str, version: u32) -> Option<Game> {
    let path = bunnyhop_core::test_maps::bsp(name);
    if !path.exists() {
        return None;
    }
    let mut game = bunnyhop_core::content::load_game(&path).unwrap();
    game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
    game.reset();
    Some(game)
}

/// A map's lift: name, the shaft's world bounds (trigger origin + model bounds) and a start height inside its z range.
struct Lift {
    map: &'static str,
    lo: [f32; 3],
    hi: [f32; 3],
    z: f32,
}

const BISTRO_7: Lift = Lift { map: "bhop_bistro_7", lo: [3785.0, 2962.0, -176.0], hi: [4268.0, 3445.0, 294.0], z: 0.0 };
const BISTRO_6: Lift = Lift { map: "bhop_bistro_6", lo: [-13344.0, 8192.0, -352.0], hi: [-12864.0, 8672.0, 80.0], z: -150.0 };

/// What one pass across the shaft's corner did.
#[derive(Debug)]
struct Graze {
    /// Commands whose end position has the standing hull overlapping the shaft.
    touched: Vec<u32>,
    /// (command, gravity after it) each time the player's gravity changed.
    changes: Vec<(u32, f32)>,
    /// Gravity 150 commands later.
    last: f32,
}

/// The player crosses the shaft's (min x, min y) corner diagonally at 1000 u/s on each axis, no input, `offset` units from
/// a pass that just misses it: a larger offset cuts deeper into the corner and touches it for more ticks. Placed with
/// `practice_noclip_exit` (a harness only, as the maps lane's probe `tools/maps-requested-1116/bistro7-graze.ts` does).
fn graze(lift: &Lift, version: u32, offset: f32) -> Option<Graze> {
    let mut game = load(lift.map, version)?;
    game.practice_noclip_exit([lift.lo[0] - 66.0, lift.lo[1] + 34.0 + offset, lift.z], [1000.0, -1000.0, 0.0], 0.0, 0.0);
    let inside = |p: [f32; 3]| {
        p[0] + 16.0 >= lift.lo[0] && p[0] - 16.0 <= lift.hi[0] && p[1] + 16.0 >= lift.lo[1] && p[1] - 16.0 <= lift.hi[1]
            && p[2] + 72.0 >= lift.lo[2] && p[2] <= lift.hi[2]
    };
    let (mut touched, mut changes, mut g) = (Vec::new(), Vec::new(), game.gravity_scale);
    assert_eq!(g, 1.0, "{}: gravity 1 before the lift", lift.map);
    for t in 0..150u32 {
        game.step(Cmd::default()).unwrap();
        if inside(game.state.position) {
            touched.push(t);
        }
        if game.gravity_scale != g {
            g = game.gravity_scale;
            changes.push((t, g));
        }
    }
    Some(Graze { touched, changes, last: g })
}

const OFFSETS: [f32; 9] = [5.0, 15.0, 25.0, 35.0, 45.0, 55.0, 65.0, 75.0, 95.0];

fn grazes(lift: &Lift, version: u32) -> Option<Vec<Graze>> {
    OFFSETS.iter().map(|&o| graze(lift, version, o)).collect()
}

/// v28: a 1 to 4 tick touch leaves the player at gravity -1; longer touches end at 1. v29: every touch ends at 1, gravity -1
/// lands on the command after the first touch and gravity 1 on the command after the last.
fn check(lift: &Lift) {
    let (Some(old), Some(new)) = (grazes(lift, PHYSICS_V28), grazes(lift, PHYSICS_V29)) else { return };
    let mut stuck = 0;
    for (o, (a, b)) in OFFSETS.iter().zip(old.iter().zip(&new)) {
        eprintln!("{} offset {o}: v28 {a:?}\n{} offset {o}: v29 {b:?}", lift.map, lift.map);
        assert_eq!(a.touched, b.touched, "{} offset {o}: the same pass on both versions until the lift fires", lift.map);
        let n = a.touched.len();
        assert!(n > 0, "{} offset {o}: the pass touches the shaft", lift.map);
        if n <= 4 {
            assert_eq!(a.last, -1.0, "{} offset {o}: a {n}-tick touch is stuck at gravity -1 on v28", lift.map);
            stuck += 1;
        } else {
            assert_eq!(a.last, 1.0, "{} offset {o}: a {n}-tick touch ends at gravity 1 on v28", lift.map);
        }
        let (first, last) = (b.touched[0], *b.touched.last().unwrap());
        assert_eq!(b.changes, vec![(first + 1, -1.0), (last + 2, 1.0)], "{} offset {o}: v29 lifts on the next command and resets after leaving", lift.map);
        assert_eq!(b.last, 1.0, "{} offset {o}: v29 ends at gravity 1", lift.map);
    }
    assert!(stuck >= 3, "{}: the v28 short-touch case is reproduced ({stuck} stuck passes)", lift.map);
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn bistro_7_lift_graze_ends_at_gravity_1_from_v29() {
    check(&BISTRO_7);
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn bistro_6_lift_graze_ends_at_gravity_1_from_v29() {
    check(&BISTRO_6);
}

#[test]
fn v29_is_the_latest_and_lists_only_the_two_bistro_builds() {
    assert_eq!(PHYSICS_LATEST, PHYSICS_V29);
    assert_eq!(map_event_clock_v29_table(), vec![("bhop_bistro_6", 0xfccd7e4e), ("bhop_bistro_7", 0x863ea0a0)]);
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn every_v29_entry_matches_its_bsp() {
    for (map, fingerprint) in map_event_clock_v29_table() {
        let Some(game) = load(map, PHYSICS_V29) else { continue };
        assert_eq!(map_entity_fingerprint(&game.entities), fingerprint, "{map}: the pinned build");
        assert_eq!(map_event_clock_v29_for(&game.entities), Some(map));
    }
    // Neighbours from the same pack and the v23/v24 maps are not on the v29 list.
    for other in ["bhop_bistro_1", "bhop_bistro_3", "bhop_bistro_5", "bhop_bistro_8", "bhop_4tele", "kz_bhop_minimal", "bhop_eazy"] {
        let Some(game) = load(other, PHYSICS_V29) else { continue };
        assert_eq!(map_event_clock_v29_for(&game.entities), None, "{other} is not on the v29 clock");
    }
}
