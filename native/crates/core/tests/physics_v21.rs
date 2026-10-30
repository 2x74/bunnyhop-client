//! Physics v21: on the maps in `PARENTED_DOORS_V21`, a func_door with a move parent follows it in collision and drawing
//! (bhop_wayz's level 10 floor, its rolling logs). Every other map and every older version keep the brush still.
//! Maps are gitignored; each test skips (with a note) when its map is absent.

use bunnyhop_core::game::{
    map_entity_fingerprint, map_parented_doors_v21_for, map_parented_doors_v21_table, EVENT_TELEPORTED, PHYSICS_V19,
    PHYSICS_V20, PHYSICS_V21,
};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

const AXIS: [f32; 2] = [3955.0, -1622.0];
const FLOOR: u32 = 148;
const ROTOR: u32 = 66;
const TELEPORT: u32 = 3;
const PAD: [f32; 3] = [3944.0, -1619.0, 1423.0];
/// (name, top of the floor, radius and rest angle of its hole around the axis).
const FLOORS: [(&str, f32, f32, f32); 3] =
    [("floor 1", 1246.0, 368.0, -132.0), ("floor 2", 869.0, 368.0, -68.0), ("floor 3", 485.0, 369.0, 175.0)];

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

fn brush(game: &Game, model: u32) -> ([f32; 3], [f32; 3]) {
    let b = game.brush_transforms().into_iter().find(|b| b.0 == model).unwrap();
    (b.1, b.2)
}

fn yaw(game: &Game, model: u32) -> f32 {
    brush(game, model).1[1].rem_euclid(360.0)
}

fn idle(game: &mut Game, ticks: u32) {
    for _ in 0..ticks {
        game.step(Cmd::default()).unwrap();
    }
}

/// Waits on the pad, inside the trigger that runs the rotor, until the rotor reaches `angle`.
fn turn_rotor_to(game: &mut Game, angle: f32) {
    game.set_position(PAD, 0.0);
    for _ in 0..4000 {
        if yaw(game, ROTOR) >= angle {
            return;
        }
        game.step(Cmd::default()).unwrap();
    }
    panic!("rotor never reached {angle}");
}

/// Drops onto a floor's hole from just above it, leading the hole by how far it turns during the fall. The player falls
/// past the whole floor without being placed again: "through", "teleported" or "landed".
fn drop_through(game: &mut Game, floor: (&str, f32, f32, f32)) -> &'static str {
    let lead = (yaw(game, ROTOR) + floor.3 + 2.5).to_radians();
    game.set_position([AXIS[0] + floor.2 * lead.cos(), AXIS[1] + floor.2 * lead.sin(), floor.1 + 16.0], 0.0);
    for _ in 0..60 {
        game.step(Cmd::default()).unwrap();
        if game.events & EVENT_TELEPORTED != 0 {
            return "teleported";
        }
        if game.state.position[2] < floor.1 - 40.0 {
            return "through";
        }
        if game.state.ground.is_some() {
            return "landed";
        }
    }
    "landed"
}

#[test]
fn the_floor_turns_with_its_teleports_only_from_v21() {
    let Some(mut game) = load("bhop_wayz", PHYSICS_V21) else { return };
    assert_eq!(map_parented_doors_v21_for(&game.entities), Some("bhop_wayz"));
    turn_rotor_to(&mut game, 45.0);
    let rotor = yaw(&game, ROTOR);
    assert!((yaw(&game, FLOOR) - rotor).abs() < 0.01, "v21 floor {} rotor {rotor}", yaw(&game, FLOOR));
    assert!((yaw(&game, TELEPORT) - rotor).abs() < 0.01, "the teleports turn with it");
    assert_eq!(brush(&game, FLOOR).0, [AXIS[0], AXIS[1], 1230.0], "it turns about the axis");

    for version in [1, 12, 18, PHYSICS_V19, PHYSICS_V20] {
        game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
        assert_eq!(yaw(&game, ROTOR), 0.0, "v{version}: crossing the v21 boundary restarts the map");
        turn_rotor_to(&mut game, 45.0);
        assert_eq!(yaw(&game, FLOOR), 0.0, "v{version}: the brush stays still");
        assert!(yaw(&game, TELEPORT) > 40.0, "v{version}: the teleports turn");
        assert_eq!(brush(&game, FLOOR).0, [AXIS[0], AXIS[1], 1230.0]);
        game.set_settings(Settings { physics_version: PHYSICS_V21, ..Settings::css_bhop() });
        assert_eq!(yaw(&game, ROTOR), 0.0, "back to v21 restarts it too");
        turn_rotor_to(&mut game, 45.0);
    }
}

/// Every floor, at rotor angles all the way round, from a drop onto it. The last floor's fall carries on into the end zone
/// (x 3504..4382, y -2122..-1099, z -671..161).
#[test]
fn every_floor_clears_at_every_rotor_angle() {
    let Some(mut game) = load("bhop_wayz", PHYSICS_V21) else { return };
    for step in 0..24 {
        let angle = step as f32 * 15.0;
        game.reset();
        turn_rotor_to(&mut game, angle);
        for floor in FLOORS {
            assert_eq!(drop_through(&mut game, floor), "through", "rotor {angle}: {}", floor.0);
        }
        idle(&mut game, 300);
        let p = game.state.position;
        assert!(
            (3504.0..4382.0).contains(&p[0]) && (-2122.0..-1099.0).contains(&p[1]) && (-680.0..161.0).contains(&p[2]),
            "rotor {angle}: {p:?}"
        );
    }
}

/// The bug, kept for old replays: the still floor's hole is under a teleport at every angle away from rest.
#[test]
fn v20_still_teleports_through_the_still_holes_away_from_rest() {
    let Some(mut game) = load("bhop_wayz", PHYSICS_V20) else { return };
    for angle in [30.0, 90.0, 180.0, 270.0] {
        game.reset();
        turn_rotor_to(&mut game, angle);
        let hole = FLOORS[0].3.to_radians();
        game.set_position([AXIS[0] + 368.0 * hole.cos(), AXIS[1] + 368.0 * hole.sin(), 1262.0], 0.0);
        let mut teleported = false;
        for _ in 0..60 {
            game.step(Cmd::default()).unwrap();
            teleported |= game.events & EVENT_TELEPORTED != 0;
        }
        assert!(teleported, "rotor {angle}");
    }
}

#[test]
fn the_rolling_logs_roll_only_from_v21() {
    // (rotor, log, a point in the trigger that starts both)
    for (rotor, log, start) in [(95, 96, [745.0, 1500.0, 0.0]), (91, 92, [2878.0, 1500.0, 0.0])] {
        for version in [PHYSICS_V20, PHYSICS_V21] {
            let Some(mut game) = load("bhop_wayz", version) else { return };
            game.set_position(start, 0.0);
            idle(&mut game, 60);
            assert_ne!(brush(&game, rotor).1, [0.0, 90.0, 0.0], "v{version}: rotor {rotor} runs");
            if version == PHYSICS_V21 {
                assert_ne!(brush(&game, log).1, [0.0; 3], "v21: log {log} rolls");
            } else {
                assert_eq!(brush(&game, log).1, [0.0; 3], "v20: log {log} stays still");
            }
        }
    }
}

/// `PARENTED_DOORS_V21` is bhop_wayz alone; the other maps with the setup (research/parented-doors-v21/scan.json) are unchanged.
#[test]
fn no_other_map_with_a_parented_door_changes_on_v21() {
    assert_eq!(map_parented_doors_v21_table(), ["bhop_wayz"]);
    for name in ["bhop_guly", "bhop_addict_v2", "bhop_eazy_v2", "bhop_monster_jam", "bhop_mario_fxd"] {
        let Some(mut game) = load(name, PHYSICS_V21) else { continue };
        assert_eq!(map_parented_doors_v21_for(&game.entities), None, "{name} isn't in the table");
        let mut other = load(name, PHYSICS_V20).unwrap();
        for tick in 0..600 {
            game.step(Cmd::default()).unwrap();
            other.step(Cmd::default()).unwrap();
            assert_eq!(game.brush_transforms(), other.brush_transforms(), "{name} tick {tick}");
            assert_eq!(game.state.position, other.state.position, "{name} tick {tick}");
        }
    }
}

/// bhop_areaportal_v1's green train: from its checkpoint, W + jump onto it at the 12 train phases that board it. Before
/// v21 its 180-degree push turns the rider around at 7 of them; from v21 at none, with the same boardings and no longer
/// rides (not a bigger ride window: the map's fall trigger still ends each one).
#[test]
fn the_green_train_stops_turning_riders_only_from_v21() {
    let Some(mut game) = load("bhop_areaportal_v1", PHYSICS_V20) else { return };
    let train = game.entities.iter().position(|e| e.get("targetname") == Some("gamstvonorm")).unwrap();
    let on_train = |g: &Game| g.state.ground.and_then(|h| h.support).is_some_and(|s| (s & 0xff_ffff_ffff) as usize == train);
    let mut boarded_at = Vec::new();
    for version in [PHYSICS_V19, PHYSICS_V20, PHYSICS_V21] {
        game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
        game.reset();
        idle(&mut game, 100);
        game.place_player([-6949.0, -6501.0, -424.0]);
        let wait = |g: &mut Game, ticks: u32| {
            for _ in 0..ticks {
                g.step(Cmd { yaw: 90.0, ..Cmd::default() }).unwrap();
            }
        };
        wait(&mut game, 40);
        let base = game.save_state();
        let (mut boarded, mut flipped) = (Vec::new(), 0);
        for phase in 460..480 {
            game.restore_state(&base);
            wait(&mut game, phase);
            let (mut on, mut turned, mut rode) = (false, 0.0f32, 0);
            for k in 0..358 {
                let (forward, buttons) = (if k <= 180 { 450.0 } else { 0.0 }, if k == 58 { 2 } else { 0 });
                game.step(Cmd { yaw: 90.0, forward, buttons, ..Cmd::default() }).unwrap();
                turned += game.view_angle_change[1].abs();
                if on_train(&game) {
                    on = true;
                    rode += 1;
                }
                if game.events & EVENT_TELEPORTED != 0 && k > 58 {
                    break;
                }
            }
            assert!(rode < 100, "v{version} phase {phase}: the fall trigger still ends the ride");
            if on {
                boarded.push(phase);
            }
            if turned != 0.0 {
                assert_eq!(turned, 180.0, "v{version} phase {phase}");
                flipped += 1;
            }
        }
        assert_eq!(boarded.len(), 12, "v{version}");
        assert_eq!(flipped, if version >= PHYSICS_V21 { 0 } else { 7 }, "v{version}");
        if boarded_at.is_empty() {
            boarded_at = boarded;
        } else {
            assert_eq!(boarded, boarded_at, "v{version}: the same phases board");
        }
    }
}

/// A changed entity build doesn't get the fix.
#[test]
fn the_fix_is_pinned_to_the_exact_entity_build() {
    let Some(game) = load("bhop_wayz", PHYSICS_V21) else { return };
    let mut entities = game.entities.clone();
    assert_eq!(map_parented_doors_v21_for(&entities), Some("bhop_wayz"));
    let print = map_entity_fingerprint(&entities);
    entities[0].pairs.push(("mapversion".into(), "changed".into()));
    assert_ne!(map_entity_fingerprint(&entities), print);
    assert_eq!(map_parented_doors_v21_for(&entities), None);
}
