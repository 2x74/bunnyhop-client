//! Trigger / clip overlays (`game/overlay.rs`): which volumes the client's !showtriggers / !showclips draw, and that
//! asking for them never changes the simulation.
//!
//! Needs the maps in maps/ (gitignored); each test skips when its map is absent.

use bunnyhop_core::game::{
    OVERLAY_CLIP, OVERLAY_GRAVITY, OVERLAY_OTHER, OVERLAY_PUSH, OVERLAY_STATE_ACTIVE, OVERLAY_TELEPORT, OVERLAY_WALL, OverlayBrush,
    PHYSICS_LATEST, PHYSICS_V1,
};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

fn load_version(name: &str, version: u32) -> Option<(Game, Vec<bool>)> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../maps/{name}.bsp"));
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping: {} not found", path.display());
        return None;
    };
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let mut game = Game::load(&bsp).unwrap();
    game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
    game.reset();
    Some((game, bunnyhop_core::mesh::texinfo_drawn(&bsp)))
}

fn load(name: &str) -> Option<(Game, Vec<bool>)> {
    load_version(name, PHYSICS_LATEST)
}

/// Volumes per kind (teleport, push, gravity, other, clip, wall).
fn counts(v: &[OverlayBrush]) -> [usize; 6] {
    let mut n = [0; 6];
    for b in v {
        n[b.kind as usize] += 1;
    }
    n
}

/// Classnames of the entities with volumes of `kind`.
fn classes(game: &Game, v: &[OverlayBrush], kind: u32) -> Vec<String> {
    let mut out: Vec<String> = v.iter().filter(|b| b.kind == kind).filter_map(|b| b.entity).map(|e| game.entities[e].classname().to_string()).collect();
    out.sort();
    out.dedup();
    out
}

#[test]
fn eazy_teleports_and_invisible_walls() {
    let Some((game, drawn)) = load("bhop_eazy") else { return };
    let v = game.overlay_brushes(&drawn);
    // 63 teleport brushes (the fall teleports under every stage), the seven toolsinvisible walls between the lanes of the
    // last stage, nothing else.
    assert_eq!(counts(&v), [63, 0, 0, 0, 0, 7]);
    assert_eq!(classes(&game, &v, OVERLAY_TELEPORT), ["trigger_teleport"]);
    // World brushes are only ever clips and walls; every volume is a closed brush.
    assert!(v.iter().filter(|b| b.entity.is_none()).all(|b| b.kind == OVERLAY_CLIP || b.kind == OVERLAY_WALL));
    assert!(v.iter().all(|b| b.planes.len() >= 4));
}

#[test]
fn boosters_gravity_and_other_triggers() {
    let Some((game, drawn)) = load("bhop_tesquo_v2") else { return };
    let v = game.overlay_brushes(&drawn);
    let n = counts(&v);
    assert!(n[OVERLAY_PUSH as usize] > 0 && n[OVERLAY_GRAVITY as usize] > 0 && n[OVERLAY_OTHER as usize] > 0, "{n:?}");
    assert_eq!(classes(&game, &v, OVERLAY_PUSH), ["trigger_push"]);
    // The neon booster pads: trigger_multiples whose outputs set the player's gravity, with the map's trigger_gravity.
    assert_eq!(classes(&game, &v, OVERLAY_GRAVITY), ["trigger_gravity", "trigger_multiple"]);
    // trigger_soundscape, func_dustmotes and the like never block or trigger the player.
    for kind in [OVERLAY_CLIP, OVERLAY_WALL] {
        assert!(classes(&game, &v, kind).iter().all(|c| c == "func_brush"), "{:?}", classes(&game, &v, kind));
    }
}

/// Playerclips block from physics v2 (MASK_PLAYERSOLID); before that they're not drawn as clips.
#[test]
fn clips_follow_the_physics_version() {
    let Some((game, drawn)) = load("bhop_arcane_v1") else { return };
    assert!(counts(&game.overlay_brushes(&drawn))[OVERLAY_CLIP as usize] > 0);
    let Some((v1, drawn)) = load_version("bhop_arcane_v1", PHYSICS_V1) else { return };
    assert_eq!(counts(&v1.overlay_brushes(&drawn))[OVERLAY_CLIP as usize], 0);
}

/// CS:GO (v21) brush sides keep a `thin` byte after `bevel`: read as one i16, every side would look like a bevel and
/// every brush like an invisible wall.
#[test]
fn csgo_map() {
    let Some((game, drawn)) = load("bhop_easystrafe_1_csgo") else { return };
    let v = game.overlay_brushes(&drawn);
    let n = counts(&v);
    assert!(n[OVERLAY_TELEPORT as usize] > 0, "{n:?}");
    assert!(n[OVERLAY_WALL as usize] < 10, "{n:?}");
}

/// Asking for the overlays (volumes and states) in the middle of a run leaves the run bit-identical.
#[test]
fn overlays_never_change_the_run() {
    let Some((mut a, drawn)) = load("bhop_eazy") else { return };
    let Some((mut b, _)) = load("bhop_eazy") else { return };
    let cmd = Cmd { forward: 450.0, side: 0.0, yaw: 90.0, pitch: 0.0, buttons: 1 << 1 };
    for tick in 0..2000 {
        a.step(cmd).unwrap();
        b.step(cmd).unwrap();
        if tick % 50 == 0 {
            let v = b.overlay_brushes(&drawn);
            let active = b.overlay_states().filter(|s| s & OVERLAY_STATE_ACTIVE != 0).count();
            assert!(!v.is_empty() && active > 0);
        }
        assert_eq!(a.state.position, b.state.position, "tick {tick}");
        assert_eq!(a.state.velocity, b.state.velocity, "tick {tick}");
        assert_eq!(a.tick, b.tick);
    }
}

/// v19 scripts use map outputs, or add runtime outputs for Liminal / Treason's bhop blocks. Both already draw.
#[test]
fn v19_script_connections_are_in_the_overlay() {
    for map in ["bhop_ceaseless", "bhop_retrowave", "bhop_k2", "bhop_k3", "bhop_api_kowka", "kz_bhop_liminal", "bhop_treason"] {
        let Some((game, drawn)) = load(map) else { continue };
        let before = game.snapshot_bytes();
        let brushes = game.overlay_brushes(&drawn);
        let mut scripted = 0;
        for (i, e) in game.entities.iter().enumerate() {
            if !matches!(e.classname(), "trigger_multiple" | "trigger_once") || e.get("model").is_none() {
                continue;
            }
            let connected = e.pairs.iter().any(|(k, v)| k.to_ascii_lowercase().starts_with("on") && v.to_ascii_lowercase().contains("script"));
            let block = e.get("vscripts") == Some("bhopblocks_ent.nut");
            if !connected && !block {
                continue;
            }
            scripted += 1;
            assert!(brushes.iter().any(|b| b.entity == Some(i) && b.kind <= OVERLAY_OTHER), "{map}: script trigger {i}");
        }
        if matches!(map, "bhop_ceaseless" | "bhop_api_kowka" | "kz_bhop_liminal" | "bhop_treason") {
            assert!(scripted > 0, "{map}: expected script connections");
        }
        assert_eq!(game.snapshot_bytes(), before, "{map}: overlay queries are read-only");
    }
}
