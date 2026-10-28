//! Movement-relevant map entities on the real maps that use them: point_teleport,
//! trigger_gravity, trigger_playermovement, prop_dynamic collision, start-zone restarts.
//! Test maps are gitignored; each test skips (with a note) when its map is absent.

use bunnyhop_core::{Cmd, Game, game::EVENT_TELEPORTED};
use std::path::PathBuf;

fn load(name: &str) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping {name}: {} not found", path.display());
        return None;
    };
    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("bsp parses");
    Some(Game::load(&bsp).expect("game loads"))
}

fn of_class(game: &Game, class: &str) -> Vec<usize> {
    game.entities.iter().enumerate().filter(|(_, e)| e.classname().eq_ignore_ascii_case(class)).map(|(i, _)| i).collect()
}

/// metal_v2 and redwood use point_teleport entities as trigger_teleport destinations: they resolve,
/// and touching the trigger lands on the point_teleport's origin with its angles.
#[test]
fn point_teleport_destinations() {
    for map in ["bhop_metal_v2", "bhop_redwood"] {
        let Some(mut game) = load(map) else { continue };
        let points: Vec<_> = of_class(&game, "point_teleport").into_iter().map(|i| game.entities[i].clone()).collect();
        assert!(!points.is_empty(), "{map}: has point_teleport");
        let mut landed = 0;
        for t in game.teleports() {
            let Some(p) = points.iter().find(|p| p.get("targetname").is_some_and(|n| n.eq_ignore_ascii_case(&t.target))) else { continue };
            assert_eq!(t.destination, Some(p.origin()), "{map}: {} resolves to its point_teleport", t.target);
            game.reset();
            game.place_player([(t.mins[0] + t.maxs[0]) * 0.5, (t.mins[1] + t.maxs[1]) * 0.5, t.mins[2] + 2.0]);
            game.step(Cmd::default()).unwrap();
            if game.events & EVENT_TELEPORTED != 0 && game.state.position == p.origin() {
                assert_eq!(game.teleport_angles, p.angles());
                landed += 1;
            }
        }
        assert!(landed > 0, "{map}: a trigger_teleport landed on a point_teleport");
    }
}

/// point_teleport's Teleport input (CPointTeleport::InputTeleport) needs a target; without one it
/// does nothing.
#[test]
fn point_teleport_without_target_does_nothing() {
    let Some(mut game) = load("bhop_metal_v2") else { return };
    let before = game.state.position;
    game.events = 0;
    game.fire_input("1_1", "Teleport", "");
    assert_eq!(game.state.position, before);
    assert_eq!(game.events & EVENT_TELEPORTED, 0);
}

/// trigger_gravity sets the player's gravity multiplier on touch, and it persists after leaving.
#[test]
fn trigger_gravity_sets_player_gravity() {
    let Some(mut game) = load("bhop_lost_world") else { return };
    let ids = of_class(&game, "trigger_gravity");
    assert!(!ids.is_empty());
    let mut tested = 0;
    for i in ids {
        let g = game.entities[i].float("gravity").unwrap_or(1.0);
        let Some((lo, hi)) = game.entity_bounds(i) else { continue };
        game.reset();
        game.place_player([(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5, lo[2] + 1.0]);
        game.step(Cmd::default()).unwrap();
        if game.events & EVENT_TELEPORTED != 0 {
            continue;
        }
        let expected = if g == 0.0 { 1.0 } else { g };
        if game.gravity_scale == expected && expected != 1.0 {
            tested += 1;
        } else if expected != 1.0 {
            eprintln!("lost_world trigger_gravity {i} (gravity {g}): scale {}", game.gravity_scale);
        }
    }
    assert!(tested > 0, "a trigger_gravity changed the player's gravity");
}

/// trigger_playermovement: ytt_space's (spawnflags 129) disable auto movement (no step-up) while
/// touching, and the override ends when the player leaves.
#[test]
fn trigger_playermovement_disables_auto_movement() {
    let Some(mut game) = load("bhop_ytt_space") else { return };
    let ids = of_class(&game, "trigger_playermovement");
    assert!(!ids.is_empty());
    let mut tested = 0;
    for i in ids {
        let flags = game.entities[i].int("spawnflags");
        let Some((lo, hi)) = game.entity_bounds(i) else { continue };
        game.reset();
        game.place_player([(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5, lo[2] + 1.0]);
        game.step(Cmd::default()).unwrap();
        if game.events & EVENT_TELEPORTED != 0 {
            continue;
        }
        assert_eq!(game.movement_overrides(), (flags & 2048 != 0, flags & 128 != 0), "trigger {i}");
        game.place_player([hi[0] + 200.0, hi[1] + 200.0, hi[2] + 200.0]);
        game.step(Cmd::default()).unwrap();
        assert_eq!(game.movement_overrides(), (false, false), "cleared on EndTouch");
        tested += 1;
    }
    assert!(tested > 0);
}

/// prop_dynamic with a packed collision model is solid, and DisableCollision turns it off.
#[test]
fn prop_dynamic_collision_toggles() {
    for map in ["bhop_ambience", "bhop_monster_jam"] {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{map}.bsp"));
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
        let mut game = Game::load(&bsp).unwrap();
        let props = bunnyhop_core::physics::build(&bsp).unwrap().props;
        let (mut solid, mut toggled) = (0, 0);
        for b in props.brushes.iter().filter(|b| b.prop & bunnyhop_core::physics::ENTITY_PROP != 0) {
            let top = [(b.mins[0] + b.maxs[0]) * 0.5, (b.mins[1] + b.maxs[1]) * 0.5, b.maxs[2]];
            let (start, end) = ([top[0], top[1], top[2] + 40.0], [top[0], top[1], top[2] - 40.0]);
            let before = game.trace_player_hull(start, end);
            if std::env::var_os("PROP_DEBUG").is_some() { eprintln!("{map} prop top {top:?} -> {before:?}"); }
            if before.start_solid || before.fraction >= 1.0 || before.hit.is_none_or(|h| h & (1 << 41) == 0) {
                continue;
            }
            solid += 1;
            let e = game.entities[(b.prop & !bunnyhop_core::physics::ENTITY_PROP) as usize].clone();
            let Some(name) = e.get("targetname").filter(|n| !n.is_empty()) else { continue };
            game.fire_input(name, "DisableCollision", "");
            let after = game.trace_player_hull(start, end);
            assert!(after.fraction > before.fraction || after.hit != before.hit, "{map}: {name} stops blocking");
            game.fire_input(name, "EnableCollision", "");
            assert_eq!(game.trace_player_hull(start, end).fraction, before.fraction);
            toggled += 1;
        }
        eprintln!("{map}: {solid} solid prop_dynamic tops, {toggled} named ones toggled");
        assert!(solid > 0, "{map}: packed prop_dynamic models are solid");
    }
}

/// Start-zone restart: set_position settles onto the floor, zeroes velocity, survives deaths
/// (respawns there) and is cleared by reset.
#[test]
fn set_position_restarts_in_the_start_zone() {
    let Some(mut game) = load("bhop_eazy") else { return };
    // bhop_eazy's srcwr start zone: (-480,-480,65) - (-224,-224,192).
    game.reset();
    game.state.velocity = [500.0, 0.0, 0.0];
    game.set_position([-352.0, -352.0, 100.0], 90.0);
    let p = game.state.position;
    assert_eq!([p[0], p[1]], [-352.0, -352.0]);
    assert!(p[2] < 100.0 && p[2] > 63.0, "settled onto the floor: {p:?}");
    assert_eq!(game.state.velocity, [0.0; 3]);
    assert_eq!(game.teleport_angles, [0.0, 90.0, 0.0]);
    assert_eq!(game.restart_point(), Some((p, 90.0)));
    for _ in 0..20 {
        game.step(Cmd::default()).unwrap();
    }
    assert!(game.state.ground.is_some());
    game.respawn_player();
    assert_eq!(game.state.position, p, "deaths respawn at the restart point");
    game.reset();
    assert_eq!(game.restart_point(), None);
    assert_eq!(game.state.position, game.spawn_origin);
    // A point inside solid is lifted out.
    game.set_position([-352.0, -352.0, 40.0], 0.0);
    assert!(!game.trace_player_hull(game.state.position, game.state.position).start_solid);
}

/// Axis-aligned bounds of every world brush whose contents match `mask`.
fn brush_boxes(map: &str, mask: u32) -> Option<(Game, Vec<([f32; 3], [f32; 3])>)> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{map}.bsp"));
    let bytes = std::fs::read(&path).ok()?;
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let world = bunnyhop_core::physics::build(&bsp).unwrap().world;
    let mut boxes = Vec::new();
    for &b in &world.world_brushes {
        let brush = &world.brushes[b];
        if brush.contents & mask == 0 {
            continue;
        }
        let (mut lo, mut hi) = ([f32::NAN; 3], [f32::NAN; 3]);
        for side in &world.sides[brush.first_side..brush.first_side + brush.side_count] {
            let p = world.planes[side.plane];
            for k in 0..3 {
                if p.normal[k] == 1.0 {
                    hi[k] = p.distance;
                } else if p.normal[k] == -1.0 {
                    lo[k] = -p.distance;
                }
            }
        }
        if lo.iter().chain(&hi).all(|v| v.is_finite()) {
            boxes.push((lo, hi));
        }
    }
    Some((Game::load(&bsp).unwrap(), boxes))
}

/// func_ladder brushes (CONTENTS_LADDER): walking into one attaches (MOVETYPE_LADDER) and holding
/// forward climbs at the SDK's 200 u/s (MAX_CLIMB_SPEED, looking level: the up component of
/// forward is 0, so climbing comes from the into-the-ladder conversion).
#[test]
fn ladders_attach_and_climb() {
    let mut climbed = 0;
    for map in ["kz_bhop_indiana", "bhop_ancient", "bhop_caves_original"] {
        let Some((mut game, ladders)) = brush_boxes(map, 0x2000_0000) else { continue };
        for (lo, hi) in ladders {
            let c = [(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5];
            for (dx, dy, yaw) in [(1.0f32, 0.0f32, 180.0f32), (-1.0, 0.0, 0.0), (0.0, 1.0, 270.0), (0.0, -1.0, 90.0)] {
                let x = if dx > 0.0 { hi[0] + 17.0 } else if dx < 0.0 { lo[0] - 17.0 } else { c[0] };
                let y = if dy > 0.0 { hi[1] + 17.0 } else if dy < 0.0 { lo[1] - 17.0 } else { c[1] };
                game.reset();
                game.place_player([x, y, lo[2] + 8.0]);
                let z0 = game.state.position[2];
                let mut on_ladder = 0;
                for _ in 0..40 {
                    game.step(Cmd { forward: 400.0, yaw, ..Default::default() }).unwrap();
                    on_ladder += (game.state.mode == playsrc_movement::Mode::Ladder) as u32;
                    if game.events & EVENT_TELEPORTED != 0 {
                        break;
                    }
                }
                if on_ladder > 20 && game.state.position[2] - z0 > 40.0 {
                    climbed += 1;
                    break;
                }
            }
        }
    }
    eprintln!("ladders climbed: {climbed}");
    assert!(climbed > 0, "climbed some ladder");
}

/// Water brushes: a player inside sinks slowly (water friction, no gravity when swimming) and
/// holding jump swims up (CheckJumpButton in water: vz = 100, then WaterMove).
#[test]
fn water_swims() {
    let mut swam = 0;
    for map in ["kz_bhop_indiana", "bhop_ancient", "bhop_caves_original", "bhop_arcane_v1"] {
        let Some((mut game, water)) = brush_boxes(map, 0x20) else { continue };
        for (lo, hi) in water {
            if hi[2] - lo[2] < 120.0 || hi[0] - lo[0] < 64.0 || hi[1] - lo[1] < 64.0 {
                continue;
            }
            let p = [(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5, (lo[2] + hi[2]) * 0.5 - 31.0];
            game.reset();
            game.place_player(p);
            if game.trace_player_hull(p, p).start_solid {
                continue;
            }
            for _ in 0..30 {
                game.step(Cmd::default()).unwrap();
            }
            if game.state.water_level < 2 || game.events & EVENT_TELEPORTED != 0 {
                continue;
            }
            assert!(game.state.velocity[2].abs() < 100.0, "{map}: slow sink in water, vz {}", game.state.velocity[2]);
            game.step(Cmd { buttons: bunnyhop_core::game::IN_JUMP, ..Default::default() }).unwrap();
            if game.state.water_level >= 2 {
                // CheckJumpButton sets vz = 100, then WaterMove accelerates toward the up wish.
                let vz = game.state.velocity[2];
                assert!((100.0..200.0).contains(&vz), "{map}: swim up speed {vz}");
                swam += 1;
            }
        }
    }
    eprintln!("water volumes swum in: {swam}");
    assert!(swam > 0);
}

/// kz_bhop_essence's long-jump counter has min 5 and max 0 (a mapper's typo for max 5). Leaving the floor trigger in
/// front of the long jump adds 1 to it; that used to panic (f32::clamp with min > max) and freeze the game. It must
/// clamp like Source's macro instead and keep simulating.
#[test]
fn math_counter_with_min_above_max_does_not_panic() {
    let Some(mut game) = load("kz_bhop_essence") else { return };
    game.reset();
    // The reported spot: the drop there ends in the pit teleport, which leaves the counted floor trigger.
    game.set_position([3531.6, -2350.1, 160.0], 90.0);
    for _ in 0..200 {
        game.step(Cmd::default()).unwrap();
    }
    // And walking straight across the counted trigger and off its far edge.
    game.reset();
    game.place_player([3520.0, -2420.0, 106.0]);
    for _ in 0..300 {
        game.step(Cmd { forward: 400.0, yaw: 90.0, ..Cmd::default() }).unwrap();
    }
}

/// Synthetic uses a solid brush with $surfaceprop ladder rather than CONTENTS_LADDER.
#[test]
fn synthetic_material_ladder_is_versioned() {
    use bunnyhop_core::{Settings, game::{PHYSICS_V17, PHYSICS_V18}};
    let Some(mut game) = load("bhop_synthetic_fix") else { return };
    for version in [PHYSICS_V17, PHYSICS_V18] {
        game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
        game.reset();
        game.place_player([-12052.5, 13065.0, 7690.0]);
        let start = game.state.position;
        let mut ladder_ticks = 0;
        for _ in 0..20 {
            game.step(Cmd { forward: 400.0, yaw: 0.0, pitch: 0.0, ..Default::default() }).unwrap();
            ladder_ticks += usize::from(game.state.mode == playsrc_movement::Mode::Ladder);
        }
        eprintln!("v{version}: {start:?} -> {:?}, ladder ticks {ladder_ticks}", game.state.position);
        if version == PHYSICS_V18 {
            assert!(ladder_ticks > 10, "attach to the reported ladder");
            assert!(game.state.position[2] > start[2] + 25.0, "climb the ladder");
        } else {
            assert_eq!(ladder_ticks, 0, "old replays keep the original behavior");
        }
    }
}
