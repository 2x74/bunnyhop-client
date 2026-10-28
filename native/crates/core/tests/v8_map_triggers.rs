//! Physics v8 per-map trigger fixes (`PHYSICS_FIX_MAP_TRIGGERS`, fix bit 16, `game/map_fixes.rs`): bhop_2easy's
//! stage-end teleports.
//!
//! Each stage of bhop_2easy ends in a 512 x 192 room (walls at the stage's centre x +- 256, back wall y 2048, floor z 64).
//! The teleport to the next stage is an 80 x 80 x 16 trigger_teleport in its middle (x +- 40, y 1912..1992, z 72..88).
//! The player hull touches it only with the origin within x +- 56, y 1896..2008 and the feet below z 88: walking in
//! off-centre goes past it to the back wall, and bunnyhopping straight down the centre line clears it. The real engine
//! does exactly the same (tools/parity, srcds, bit-exact on all seven of these scenarios: walks at x = +-55 / +-57 / 58,
//! a fly-over and an autohop run in), so v1..v7 keep it. v8 replaces the five triggers' brushes with their room behind
//! the original front face (y 1912..2048), wall to wall, floor to ceiling (z 64..330).
//!
//! Needs maps/bhop_2easy.bsp (gitignored); the map tests skip when it is absent.

use bunnyhop_core::game::{IN_JUMP, PHYSICS_FIX_MAP_TRIGGERS, PHYSICS_V5, PHYSICS_V6, PHYSICS_V7, PHYSICS_V8, map_fix_for, physics_fixes};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

const CENTRES: [f32; 5] = [0.0, -1024.0, -2048.0, -3072.0, -4096.0];
/// Where each room's teleport sends the player (info_teleport_destination origins).
const DESTINATIONS: [[f32; 3]; 5] =
    [[-1024.0, 96.0, 96.0], [-2048.0, -928.0, 96.0], [-3072.0, -928.0, 96.0], [-4096.0, -928.0, 96.0], [-1312.0, -768.0, 224.0]];

fn maps_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps")
}

fn bsp_bytes(name: &str) -> Option<Vec<u8>> {
    let path = maps_dir().join(format!("{name}.bsp"));
    let bytes = std::fs::read(&path).ok();
    if bytes.is_none() {
        eprintln!("skipping: {} not found", path.display());
    }
    bytes
}

fn load(version: u32) -> Option<Game> {
    let bytes = bsp_bytes("bhop_2easy")?;
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let mut game = Game::load(&bsp).unwrap();
    game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
    game.reset();
    Some(game)
}

/// Places the player (airborne, like tools/parity's start state) and runs `cmd` for `ticks`; returns the tick and
/// pre-teleport origin of the first teleport (an origin jump of over 100 units) and the final origin.
fn run(game: &mut Game, origin: [f32; 3], velocity: [f32; 3], cmd: Cmd, ticks: u32) -> (Option<(u32, [f32; 3])>, [f32; 3]) {
    game.reset();
    game.state.position = origin;
    game.state.velocity = velocity;
    game.state.ground = None;
    let mut prev = origin;
    let mut hit = None;
    for t in 1..=ticks {
        game.step(cmd).unwrap();
        let p = game.state.position;
        if hit.is_none() && (0..3).map(|i| (p[i] - prev[i]).powi(2)).sum::<f32>().sqrt() > 100.0 {
            hit = Some((t, prev));
            break;
        }
        prev = p;
    }
    (hit, game.state.position)
}

const WALK: Cmd = Cmd { forward: 400.0, side: 0.0, yaw: 90.0, pitch: 0.0, buttons: 0 };

#[test]
fn v8_adds_the_map_trigger_fix_bit() {
    assert_eq!(PHYSICS_FIX_MAP_TRIGGERS, 1 << 16);
    for v in [PHYSICS_V5, PHYSICS_V6, PHYSICS_V7] {
        assert_eq!(physics_fixes(v).unwrap() & PHYSICS_FIX_MAP_TRIGGERS, 0, "v{v} has no map trigger fixes");
    }
    assert_eq!(physics_fixes(PHYSICS_V8), Some(physics_fixes(PHYSICS_V7).unwrap() | PHYSICS_FIX_MAP_TRIGGERS));
}

/// The fix's match keys pick out bhop_2easy and nothing else in maps/ (bhop_2_easy is a different map).
#[test]
fn only_bhop_2easy_matches() {
    let Ok(dir) = std::fs::read_dir(maps_dir()) else { return };
    let mut matched = Vec::new();
    let mut scanned = 0;
    for entry in dir.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "bsp") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Ok(bsp) = bunnyhop_core::parse_bsp(&bytes) else { continue };
        scanned += 1;
        let list = bunnyhop_core::physics::entity_list_with_outputs(&bsp, false);
        if let Some(fix) = map_fix_for(&list.entities) {
            matched.push((path.file_stem().unwrap().to_string_lossy().to_string(), fix));
        }
    }
    if scanned == 0 {
        eprintln!("skipping: no maps");
        return;
    }
    let has_2easy = maps_dir().join("bhop_2easy.bsp").exists();
    assert_eq!(matched, if has_2easy { vec![("bhop_2easy".to_string(), "bhop_2easy")] } else { vec![] }, "{scanned} maps scanned");
}

/// The verifier parses the entity lump without output pairs (`load_map_physics`); the fix matches the same triggers.
#[test]
fn the_verifier_load_matches_the_same_triggers() {
    let Some(bytes) = bsp_bytes("bhop_2easy") else { return };
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let full = Game::load(&bsp).unwrap();
    let list = bunnyhop_core::physics::entity_list_with_outputs(&bsp, false);
    let verifier = Game::load_with_entities(&bsp, None, list, false).unwrap();
    assert_eq!(full.map_fix(), Some("bhop_2easy"));
    assert_eq!(verifier.map_fix(), Some("bhop_2easy"));
    let boxes = full.map_trigger_boxes();
    assert_eq!(boxes, verifier.map_trigger_boxes());
    assert_eq!(boxes.len(), 5);
    for ((i, lo, hi), cx) in boxes.iter().zip(CENTRES) {
        assert_eq!(full.entities[*i].classname(), "trigger_teleport");
        assert_eq!(full.entities[*i].origin(), [cx, 1952.0, 80.0]);
        assert_eq!((*lo, *hi), ([cx - 256.0, 1912.0, 64.0], [cx + 256.0, 2048.0, 330.0]));
    }
}

/// Walking in off-centre: v7 (as CS:S) walks past the spot to the back wall; v8 teleports on reaching the original
/// trigger's front face (origin y 1896), in every room, to that room's destination.
#[test]
fn off_centre_walk_teleports_in_v8_only() {
    let (Some(mut v7), Some(mut v8)) = (load(PHYSICS_V7), load(PHYSICS_V8)) else { return };
    for (cx, dest) in CENTRES.into_iter().zip(DESTINATIONS) {
        for dx in [150.0, -150.0, 239.0] {
            let start = [cx + dx, 1866.0, 66.0];
            let (hit7, end7) = run(&mut v7, start, [0.0; 3], WALK, 160);
            assert!(hit7.is_none(), "v7 room {cx} dx {dx}: no teleport");
            assert!(end7[1] > 2031.0 && (end7[0] - start[0]).abs() < 0.01, "v7 reaches the back wall: {end7:?}");
            let (hit8, _) = run(&mut v8, start, [0.0; 3], WALK, 160);
            let (tick, at) = hit8.unwrap_or_else(|| panic!("v8 room {cx} dx {dx}: teleports"));
            assert_eq!(tick, 25, "v8 room {cx} dx {dx}");
            // The tick's move crosses origin y 1896 (hull front 1912), from y 1893.98 (as the centred walk, parity
            // 2e_walk_x55).
            assert!((at[1] - 1893.985).abs() < 0.01, "at the original front face: {at:?}");
            assert_eq!(v8.state.position, dest, "room {cx}: to its destination");
        }
    }
}

/// On the centre line the original trigger is reached on the same tick in both versions: the depth into the room is
/// the map's. (The real engine: 2e_walk_x55 teleports at tick 25 from y 1893.98.)
#[test]
fn centred_walk_is_unchanged() {
    let (Some(mut v7), Some(mut v8)) = (load(PHYSICS_V7), load(PHYSICS_V8)) else { return };
    for dx in [0.0, 55.0, -55.0] {
        let start = [dx, 1866.0, 66.0];
        let (hit7, _) = run(&mut v7, start, [0.0; 3], WALK, 160);
        let (hit8, _) = run(&mut v8, start, [0.0; 3], WALK, 160);
        assert!(hit7.is_some(), "dx {dx}: v7 teleports");
        assert_eq!(hit7, hit8, "dx {dx}: same tick, same place");
    }
    // Just outside the original's reach (bbox edge at 41): v7 misses, v8 doesn't (the parity run 2e_walk_x57).
    let (hit7, _) = run(&mut v7, [57.0, 1866.0, 66.0], [0.0; 3], WALK, 160);
    let (hit8, _) = run(&mut v8, [57.0, 1866.0, 66.0], [0.0; 3], WALK, 160);
    assert!(hit7.is_none() && hit8.is_some());
}

/// Bunnyhopping (autohop, jump held) straight down the centre line into the room: v7 (as CS:S, parity 2e_jump_in)
/// jumps over the spot and hops against the back wall; v8 teleports. The same for flying in high (2e_fly_over).
#[test]
fn hopping_over_the_spot_teleports_in_v8_only() {
    let (Some(mut v7), Some(mut v8)) = (load(PHYSICS_V7), load(PHYSICS_V8)) else { return };
    let hop = Cmd { buttons: IN_JUMP, ..WALK };
    let (hit7, end7) = run(&mut v7, [0.0, 1860.0, 66.0], [0.0, 300.0, 0.0], hop, 120);
    assert!(hit7.is_none(), "v7 clears the spot");
    assert!(end7[1] > 2031.0, "and ends at the back wall: {end7:?}");
    let (hit8, _) = run(&mut v8, [0.0, 1860.0, 66.0], [0.0, 300.0, 0.0], hop, 120);
    assert!(hit8.is_some(), "v8 teleports");
    let idle = Cmd { forward: 0.0, ..WALK };
    let (hit7, _) = run(&mut v7, [0.0, 1860.0, 95.0], [0.0, 600.0, 250.0], idle, 120);
    let (hit8, _) = run(&mut v8, [0.0, 1860.0, 95.0], [0.0, 600.0, 250.0], idle, 120);
    assert!(hit7.is_none() && hit8.is_some(), "fly-over: v7 {hit7:?} v8 {hit8:?}");
    assert_eq!(v8.state.position, DESTINATIONS[0]);
}

/// The fix never reaches outside the end rooms: the stage before (y < 1912) and the spawn room's wall teleport are as
/// in v7, and the first stage's floor teleport still sends a faller back to the stage start.
#[test]
fn nothing_else_changes() {
    let (Some(mut v7), Some(mut v8)) = (load(PHYSICS_V7), load(PHYSICS_V8)) else { return };
    // Standing at the room's entrance, 1 unit short of the box (hull front at y 1911).
    for cx in CENTRES {
        let a = run(&mut v7, [cx + 200.0, 1895.0, 66.0], [0.0; 3], Cmd { forward: 0.0, ..WALK }, 50);
        let b = run(&mut v8, [cx + 200.0, 1895.0, 66.0], [0.0; 3], Cmd { forward: 0.0, ..WALK }, 50);
        assert!(a.0.is_none() && b.0.is_none() && a.1 == b.1, "room {cx}: {a:?} {b:?}");
    }
    // Falling into stage 1's pit: the floor teleport back to the stage start, the same in both.
    let a = run(&mut v7, [100.0, 1000.0, 40.0], [0.0; 3], Cmd { forward: 0.0, ..WALK }, 50);
    let b = run(&mut v8, [100.0, 1000.0, 40.0], [0.0; 3], Cmd { forward: 0.0, ..WALK }, 50);
    assert!(a.0.is_some() && a == b, "{a:?} {b:?}");
}
