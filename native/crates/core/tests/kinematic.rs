//! Kinematic movers (crates/core/src/game/kin.rs) on the real maps that use them: func_rotating platforms
//! carrying and turning the player, func_door_rotating, func_movelinear, func_tracktrain on path_track,
//! func_conveyor, physics objects, and determinism of all of it.
//! Maps are gitignored; each test skips (with a note) when its map is absent.

use bunnyhop_core::{Cmd, Game, game::EVENT_ANGLES_CHANGED};
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

fn find(game: &Game, class: &str, key: &str, value: &str) -> Option<usize> {
    game.entities
        .iter()
        .position(|e| e.classname().eq_ignore_ascii_case(class) && e.get(key).is_some_and(|v| v.eq_ignore_ascii_case(value)))
}

fn idle() -> Cmd {
    Cmd::default()
}

const ENTITY_HIT: u64 = 1 << 40;

/// Start-on, solid, yaw func_rotating platforms (bhop_eject, bhop_drop, bhop_fly_lovers, ...): they start
/// 0.2 s after spawn (SUB_CallUseToggle) at full speed (no ACCDCC), and a player standing on one is carried
/// around its axis and has its view turned by the same yaw (FIXANGLE_RELATIVE).
#[test]
fn rotating_platform_carries_and_turns_the_player() {
    let mut tested = 0;
    for map in ["bhop_eject", "bhop_drop", "bhop_fly_lovers", "bhop_areaportal_v1", "bhop_frost_bite_v1"] {
        let Some(mut game) = load(map) else { continue };
        let candidates: Vec<usize> = (0..game.entities.len())
            .filter(|&i| {
                let e = &game.entities[i];
                let sf = e.int("spawnflags");
                e.classname() == "func_rotating" && sf & 1 != 0 && sf & (4 | 8 | 16 | 64) == 0
            })
            .collect();
        for i in candidates {
            game.reset();
            let (center, a0) = game.entity_transform(i).unwrap();
            let (lo, hi) = game.entity_bounds(i).unwrap();
            if a0 != [0.0; 3] || hi[0] - lo[0] < 120.0 || hi[1] - lo[1] < 120.0 {
                continue;
            }
            let r = ((hi[0] - lo[0]).min(hi[1] - lo[1]) * 0.25).min(100.0);
            game.place_player([center[0] + r, center[1], hi[2] + 0.5]);
            for _ in 0..10 {
                game.step(idle()).unwrap();
            }
            let on = game.state.ground.and_then(|g| g.support).is_some_and(|s| s & ENTITY_HIT != 0 && (s & 0xff_ffff_ffff) as usize == i);
            if !on {
                eprintln!("{map} {i}: not on it (ground {:?}, at {:?}, top {})", game.state.ground.map(|g| g.support), game.state.position, hi[2]);
                continue;
            }
            let speed = game.entities[i].float("maxspeed").unwrap().abs();
            // Run until the start think has fired, then measure 1 s.
            while game.tick < 30 {
                game.step(idle()).unwrap();
            }
            // Flush with the world floor: the ground trace keeps the world (ties go to the world in
            // CEngineTrace), so Source doesn't carry the player either.
            let on = game.state.ground.and_then(|g| g.support).is_some_and(|s| s & ENTITY_HIT != 0 && (s & 0xff_ffff_ffff) as usize == i);
            if !on {
                continue;
            }
            let start = game.state.position;
            let a_start = game.entity_transform(i).unwrap().1[1];
            let mut view = 0.0f32;
            // 10 ticks: SOLID_VPHYSICS fans push the rider's AABB mins corner, so the rider orbits faster than
            // the fan and drifts outward until the push gets blocked (the real engine does the same; see
            // tools/parity eject_ride and research/ENTITIES.md).
            for _ in 0..10 {
                game.step(idle()).unwrap();
                if game.events & EVENT_ANGLES_CHANGED != 0 {
                    view += game.view_angle_change[1];
                }
            }
            let turned = game.entity_transform(i).unwrap().1[1] - a_start;
            assert!(turned.abs() <= speed * 0.1 + 0.05 && turned.abs() >= speed * 0.05, "{map} {i}: 0.1 s at {speed} deg/s, turned {turned}");
            assert!((view - turned).abs() < 0.01, "{map} {i}: view turned {view} vs platform {turned}");
            let ang = |p: [f32; 3]| (p[1] - center[1]).atan2(p[0] - center[0]).to_degrees();
            let p = game.state.position;
            let mut moved = ang(p) - ang(start);
            moved -= (moved / 360.0).round() * 360.0;
            assert!(moved * turned > 0.0, "{map} {i}: carried {moved} deg vs {turned}");
            eprintln!("{map} {i}: ridden, turned {turned}");
            tested += 1;
        }
    }
    eprintln!("{tested} rotating platforms ridden");
    assert!(tested > 0 || load("bhop_eject").is_none());
}

/// Two loads stepping the same inputs stay bit-identical on maps with movers.
#[test]
fn kinematic_maps_are_deterministic() {
    for map in ["bhop_veritas", "bhop_danmark", "bhop_null", "bhop_crash_egypt", "bhop_slope_v2", "bhop_highfly"] {
        let Some(mut a) = load(map) else { continue };
        let mut b = load(map).unwrap();
        for t in 0..1500u32 {
            let cmd = Cmd {
                forward: if t % 200 < 150 { 450.0 } else { 0.0 },
                side: if (t / 37) % 2 == 0 { 300.0 } else { -300.0 },
                yaw: (t as f32 * 1.3) % 360.0 - 180.0,
                pitch: 0.0,
                buttons: if t % 3 == 0 { 2 } else { 0 },
            };
            a.step(cmd).unwrap();
            b.step(cmd).unwrap();
            assert_eq!(a.snapshot_bytes(), b.snapshot_bytes(), "{map}: diverged at tick {t}");
        }
    }
}

fn of_class(game: &Game, class: &str) -> Vec<usize> {
    game.entities.iter().enumerate().filter(|(_, e)| e.classname().eq_ignore_ascii_case(class)).map(|(i, _)| i).collect()
}

/// bhop_danmark's six func_physbox are `notsolid 1` weapon displays (FSOLID_NOT_SOLID): players pass through.
#[test]
fn danmark_physboxes_are_not_solid() {
    let Some(game) = load("bhop_danmark") else { return };
    let boxes = of_class(&game, "func_physbox");
    assert_eq!(boxes.len(), 6);
    for i in boxes {
        assert_eq!(game.entity_solidity(i).map(|s| s.0), Some(false), "physbox {i}");
    }
}

/// prop_physics_multiplayer is COLLISION_GROUP_PUSHAWAY: never solid to players.
#[test]
fn multiplayer_physics_objects_are_not_solid() {
    let Some(game) = load("bhop_cobblestone") else { return };
    let props = of_class(&game, "prop_physics_multiplayer");
    assert!(!props.is_empty());
    for i in props {
        assert_eq!(game.entity_solidity(i).map(|s| s.0), Some(false));
    }
}

/// Stock collision models from the content cache make bhop_kz_ocean's motion-disabled prop_physics solid.
#[test]
fn prop_physics_collide_with_cached_models() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps/bhop_kz_ocean.bsp");
    if !path.exists() {
        return;
    }
    let game = bunnyhop_core::content::load_game(&path).expect("load");
    if game.physics_files().is_empty() || !game.missing_prop_models().is_empty() {
        eprintln!("skipping: no cached physics content (run tools/content/extract.ts)");
        return;
    }
    let poses = game.entity_prop_poses();
    let physics: Vec<_> = poses.iter().filter(|p| game.entities[p.0].classname().starts_with("prop_physics")).collect();
    assert!(!physics.is_empty(), "prop_physics have collision");
    for (_, _, origin, _) in physics {
        let start = [origin[0], origin[1], origin[2] + 200.0];
        let t = game.trace_player_hull(start, [origin[0], origin[1], origin[2] - 50.0]);
        assert!(t.fraction < 1.0, "prop at {origin:?} blocks");
    }
}

/// bhop_highfly: the hinged phys_motor spins its func_physbox at the motor speed (200 deg/s after the 1 s
/// spin-up) about the motor's vertical axis.
#[test]
fn phys_motor_spins_hinged_physbox() {
    let Some(mut game) = load("bhop_highfly") else { return };
    let i = find(&game, "func_physbox", "targetname", "lvl2rotate1").expect("lvl2rotate1");
    for _ in 0..200 {
        game.step(idle()).unwrap();
    }
    let a0 = game.entity_transform(i).unwrap().1;
    game.step(idle()).unwrap();
    let a1 = game.entity_transform(i).unwrap().1;
    let mut d = a1[1] - a0[1];
    d -= (d / 360.0).round() * 360.0;
    assert!((d.abs() - 2.0).abs() < 0.01, "2 deg per tick at 200 deg/s, got {d}");
}

/// func_conveyor (bhop_slope_v2): standing on one gives the player its velocity as base velocity.
#[test]
fn conveyor_pushes_player() {
    let Some(mut game) = load("bhop_slope_v2") else { return };
    let mut pushed = 0;
    for i in of_class(&game, "func_conveyor") {
        game.reset();
        let (lo, hi) = game.entity_bounds(i).unwrap();
        game.place_player([(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5, hi[2] + 2.0]);
        let start = game.state.position;
        for _ in 0..50 {
            game.step(idle()).unwrap();
        }
        let p = game.state.position;
        if (p[0] - start[0]).hypot(p[1] - start[1]) > 50.0 {
            pushed += 1;
        }
    }
    assert!(pushed > 0, "a conveyor moved the player");
}
