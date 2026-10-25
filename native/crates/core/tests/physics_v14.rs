//! Physics v14: per-map sv_maxvelocity (`PHYSICS_FIX_MAP_MAX_VELOCITY`, `game/map_fixes.rs` `MAX_VELOCITY`) and trains
//! that find their path before the map's spawn outputs (`PHYSICS_FIX_TRAIN_SPAWN`). v13 stays as it was.
//! Maps are gitignored; each test skips (with a note) when its map is absent.

use bunnyhop_core::game::{IN_JUMP, PHYSICS_V13, PHYSICS_V14, map_max_velocity_for, map_max_velocity_table};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

const ENTITY_HIT: u64 = 1 << 40;

fn load(name: &str, version: u32) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping {name}: {} not found", path.display());
        return None;
    };
    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("bsp parses");
    let mut game = Game::load(&bsp).expect("game loads");
    game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
    game.reset();
    Some(game)
}

/// One airborne tick at `speed` u/s from just above the spawn, along each horizontal axis (the best axis is the one
/// with room for the move). The movement step refuses a state faster than the map's sv_maxvelocity on any axis
/// (validate_input; real play never gets there, CheckVelocity clamps every tick) and the game then drops the
/// velocity, so a speed survives the tick only under the limit in effect.
fn speed_after_tick(game: &mut Game, speed: f32) -> f32 {
    let mut best: f32 = 0.0;
    for (axis, sign) in [(0, 1.0), (0, -1.0), (1, 1.0), (1, -1.0)] {
        game.reset();
        for _ in 0..5 {
            game.step(Cmd::default()).unwrap();
        }
        let p = game.state.position;
        game.place_player([p[0], p[1], p[2] + 32.0]);
        let mut v = [0.0; 3];
        v[axis] = sign * speed;
        game.state.velocity = v;
        game.step(Cmd::default()).unwrap();
        best = best.max(game.state.velocity[axis].abs());
    }
    best
}

#[test]
fn sandtrap_maps_run_at_ten_thousand_from_v14() {
    let mut tested = 0;
    for map in ["bhop_sandtrap", "bhop_sandtrap2", "bhop_sandtrap3", "bhop_icetrap", "bhop_goldsrc"] {
        let Some(mut old) = load(map, PHYSICS_V13) else { continue };
        let Some(mut new) = load(map, PHYSICS_V14) else { continue };
        assert_eq!(map_max_velocity_for(&new.entities), Some((map, 10000.0)), "{map}: table entry");
        assert_eq!(old.max_velocity(), 3500.0, "{map} v13");
        assert_eq!(new.max_velocity(), 10000.0, "{map} v14");
        assert_eq!(speed_after_tick(&mut old, 3400.0), 3400.0, "{map}: v13 keeps 3400");
        assert_eq!(speed_after_tick(&mut old, 6000.0), 0.0, "{map}: v13 refuses 6000");
        assert_eq!(speed_after_tick(&mut new, 6000.0), 6000.0, "{map}: v14 keeps 6000");
        assert_eq!(speed_after_tick(&mut new, 9900.0), 9900.0, "{map}: v14 keeps 9900");
        tested += 1;
    }
    eprintln!("{tested} maps tested");
}

/// The client / room copy (apps/web/src/map-max-velocity.ts) lists the same maps and values as the core's table.
#[test]
fn web_table_matches_the_core() {
    let ts = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/src/map-max-velocity.ts")).unwrap();
    let body = &ts[ts.find("MAP_MAX_VELOCITY").unwrap()..];
    let body = &body[body.find('{').unwrap() + 1..body.find('}').unwrap()];
    let mut web: Vec<(String, f32)> = body
        .lines()
        .filter_map(|l| l.trim().trim_end_matches(',').split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().parse().unwrap()))
        .collect();
    let mut core: Vec<(String, f32)> = map_max_velocity_table().into_iter().map(|(m, v)| (m.to_string(), v)).collect();
    web.sort_by(|a, b| a.0.cmp(&b.0));
    core.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(web, core);
}

#[test]
fn other_maps_keep_3500() {
    for map in ["bhop_areaportal_v1", "bhop_eject", "bhop_arcane_v1"] {
        let Some(mut game) = load(map, PHYSICS_V14) else { continue };
        assert_eq!(map_max_velocity_for(&game.entities), None, "{map}");
        assert_eq!(game.max_velocity(), 3500.0, "{map}");
        assert_eq!(speed_after_tick(&mut game, 6000.0), 0.0, "{map}: 6000 is over its limit");
    }
}

fn train(game: &Game, name: &str) -> usize {
    game.entities.iter().position(|e| e.get("targetname") == Some(name)).unwrap()
}

/// bhop_areaportal_v1's green platform (`gamstvonorm`: speed 0, startspeed 1000) is started only by
/// `logic_auto OnMapSpawn -> StartForward`. v13 delivered the input before the train's Find think, so it never moved.
#[test]
fn areaportal_green_platform_moves_from_v14() {
    for version in [PHYSICS_V13, PHYSICS_V14] {
        let Some(mut game) = load("bhop_areaportal_v1", version) else { return };
        let i = train(&game, "gamstvonorm");
        let mut ys = Vec::new();
        for _ in 0..800 {
            game.step(Cmd::default()).unwrap();
            ys.push(game.entity_transform(i).unwrap().0[1]);
        }
        let (lo, hi) = ys.iter().fold((f32::MAX, f32::MIN), |(a, b), &y| (a.min(y), b.max(y)));
        if version == PHYSICS_V13 {
            assert_eq!(hi - lo, 0.0, "v13: the green platform stays put");
        } else {
            // path_track gamatb1 (y -6281) <-> gamatb2 (y -2443) at 1000 u/s; like the real engine (tools/parity) it turns
            // back about 90 u before each end (the 0.1 s look-ahead wraps around the two-node loop).
            assert!(lo < -6150.0 && hi > -2600.0, "v14: green platform travels its path, y {lo}..{hi}");
        }
    }
}

/// Riding the areaportal platforms as on the real engine (tools/parity jobs ap_rideA / B / C, bit-identical player
/// paths): a player who lands with the platform's 1000 u/s stays on it standing or hopping (a jump keeps the platform's
/// velocity, CGameMovement::SetGroundEntity), and one who drops onto it at rest slides off the back (landing subtracts
/// the platform's velocity), as in CS:S.
#[test]
fn areaportal_platforms_carry_riders_moving_with_them() {
    for name in ["rede3da", "gamstvonorm"] {
        for (hop, matched) in [(false, true), (true, true), (false, false)] {
            let Some(mut game) = load("bhop_areaportal_v1", PHYSICS_V14) else { return };
            let i = train(&game, name);
            // Mid-path, moving: 60 ticks after the start.
            for _ in 0..60 {
                game.step(Cmd::default()).unwrap();
            }
            let c0 = game.entity_transform(i).unwrap().0;
            game.step(Cmd::default()).unwrap();
            let c = game.entity_transform(i).unwrap().0;
            let v = [(c[0] - c0[0]) / 0.01, (c[1] - c0[1]) / 0.01, 0.0];
            assert!(v[1].abs() > 900.0, "{name} is moving ({v:?})");
            game.place_player([c[0], c[1], c[2] + 10.5]);
            if matched {
                game.state.velocity = v;
            }
            let mut on_ticks = 0;
            let mut max_off: f32 = 0.0;
            for t in 0..100 {
                let buttons = if hop && t >= 10 { IN_JUMP } else { 0 };
                game.step(Cmd { buttons, ..Cmd::default() }).unwrap();
                let c = game.entity_transform(i).unwrap().0;
                let p = game.state.position;
                max_off = max_off.max((p[1] - c[1]).abs());
                if game.state.ground.and_then(|g| g.support).is_some_and(|s| s & ENTITY_HIT != 0 && (s & 0xff_ffff_ffff) as usize == i) {
                    on_ticks += 1;
                }
            }
            if matched {
                assert!(max_off < 20.0, "{name} hop={hop}: stays with the platform (max offset {max_off})");
                assert!(on_ticks > 0, "{name} hop={hop}: lands on it");
            } else {
                assert!(max_off > 66.0, "{name}: a rider dropped at rest slides off (max offset {max_off})");
            }
        }
    }
}

/// Every map whose trains a spawn output starts (`PHYSICS_FIX_TRAIN_SPAWN`; an audit of the 26 maps with trains, v13 vs
/// v14, research/MAX-VELOCITY.md): each of these moves on the real engine (tools/parity jobs tr_<map>) and from v14,
/// and stood still before.
#[test]
fn trains_started_at_spawn_move_like_the_engine() {
    let cases: &[(&str, &[&str])] = &[
        ("bhop_areaportal_v1", &["gamstvonorm"]),
        ("bhop_dreamtour2", &["dreamtour2"]),
        ("bhop_pharma", &["box2", "loota1x"]),
    ];
    for (map, names) in cases {
        for version in [PHYSICS_V13, PHYSICS_V14] {
            let Some(mut game) = load(map, version) else { continue };
            let ids: Vec<usize> = names.iter().map(|n| train(&game, n)).collect();
            let start: Vec<[f32; 3]> = ids.iter().map(|&i| game.entity_transform(i).unwrap().0).collect();
            let mut moved = vec![false; ids.len()];
            for _ in 0..1500 {
                game.step(Cmd::default()).unwrap();
                for (k, &i) in ids.iter().enumerate() {
                    let p = game.entity_transform(i).unwrap().0;
                    moved[k] |= (p[0] - start[k][0]).abs() + (p[1] - start[k][1]).abs() + (p[2] - start[k][2]).abs() > 50.0;
                }
            }
            for (k, name) in names.iter().enumerate() {
                assert_eq!(moved[k], version == PHYSICS_V14, "{map} {name} v{version}: moved {}", moved[k]);
            }
        }
    }
}
