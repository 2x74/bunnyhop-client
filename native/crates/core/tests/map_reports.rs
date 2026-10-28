//! Regression tests for player-reported map bugs (in-game feedback, v0.0.3). Each scenario was also run on the real
//! CS:S engine (tools/parity) and the numbers asserted here are the engine's. Test maps are gitignored; each test
//! skips (with a note) when its map is absent.

use bunnyhop_core::{
    Cmd, Game, Settings,
    game::{EVENT_TELEPORTED, IN_JUMP, PHYSICS_V1, PHYSICS_V2},
};
use std::path::PathBuf;

fn load(name: &str, physics_version: u32) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping {name}: {} not found", path.display());
        return None;
    };
    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("bsp parses");
    let mut game = Game::load_with_content(&bsp, bunnyhop_core::content::cached_physics_content(&path)).expect("game loads");
    game.set_settings(Settings { physics_version, ..game.settings });
    Some(game)
}

/// Runs `ticks` steps holding `buttons` (autohop), returns (max z, teleported).
fn run(game: &mut Game, ticks: u32, buttons: u32) -> (f32, bool) {
    let mut max_z = f32::MIN;
    let mut teleported = false;
    for _ in 0..ticks {
        game.step(Cmd { buttons, ..Default::default() }).expect("step");
        teleported |= game.events & EVENT_TELEPORTED != 0;
        max_z = max_z.max(game.state.position[2]);
    }
    (max_z, teleported)
}

/// bhop_alt_saimaa: the jump pad (trigger_multiple OnEndTouch `!activator AddOutput gravity -0.5`, then `gravity 1`
/// 0.55 s later) must lift the player to the next level (floor z 512). The core clamped the entity gravity to >= 0,
/// so the pad only switched gravity off: apex 402.6 and the map was unfinishable. The real engine (CS:S, 100 tick)
/// reaches 570.92 from a standing jump on the pad (tools/parity, bit-exact with the core now). Not version-gated: no
/// production replay used a negative gravity.
#[test]
fn saimaa_jump_pad_negative_gravity() {
    for version in [PHYSICS_V1, PHYSICS_V2] {
        let Some(mut game) = load("bhop_alt_saimaa", version) else { return };
        // Standing jump in the middle of the pad.
        game.reset();
        game.set_position([-64.0, -4800.0, 192.03125], 0.0);
        let mut min_gravity = f32::MAX;
        let mut max_z = f32::MIN;
        for _ in 0..150 {
            game.step(Cmd { buttons: IN_JUMP, ..Default::default() }).expect("step");
            min_gravity = min_gravity.min(game.gravity_scale);
            max_z = max_z.max(game.state.position[2]);
            if game.state.velocity[2] < 0.0 && game.state.position[2] < 300.0 {
                break;
            }
        }
        assert_eq!(min_gravity, -0.5, "v{version}: the pad's AddOutput gravity -0.5 applies as is");
        assert!((max_z - 570.92).abs() < 0.1, "v{version}: pad apex {max_z} (real engine 570.92; clamped gravity gave 402.6)");
        assert_eq!(game.gravity_scale, 1.0, "v{version}: gravity restored after 0.55 s");

        // Leaving the pad toward +x lands on the next level (z 512), like a player using it.
        game.reset();
        game.set_position([0.0, -4800.0, 192.03125], 0.0);
        game.state.velocity = [300.0, 0.0, 0.0];
        let mut landed = None;
        for _ in 0..200 {
            game.step(Cmd { buttons: IN_JUMP, ..Default::default() }).expect("step");
            if game.state.ground.is_some() && game.state.position[2] > 500.0 {
                landed = Some(game.state.position);
                break;
            }
        }
        let p = landed.unwrap_or_else(|| panic!("v{version}: never reached the next level (at {:?})", game.state.position));
        assert!((p[2] - 512.0).abs() < 1.0 && p[0] > 400.0, "v{version}: landed at {p:?}");
    }
}

/// bhop_christmas: the stage-14 jump pad is a playerclip brush (top z -990) over the pit's trigger_teleport (top
/// -1012). Physics v1 walks through playerclips, so a player hopping onto the pad fell into the pit and was teleported
/// back (s_13) before the activator_boost name (0.01 s AddOutput, +5 ticks player clock) let the 2800 u/s
/// trigger_push act: the map was unfinishable. v2 (MASK_PLAYERSOLID) lands on the pad and is launched, bit-exact with
/// the real engine (tools/parity bhfix_xmas2 / xmas3: engine apex -526.1).
#[test]
fn christmas_jump_pad_is_playerclip() {
    for (version, launches) in [(PHYSICS_V1, false), (PHYSICS_V2, true)] {
        let Some(mut game) = load("bhop_christmas", version) else { return };
        game.reset();
        game.set_position([-7720.0, 7872.0, -992.0], 0.0);
        game.state.velocity = [300.0, 0.0, 0.0];
        let (max_z, teleported) = run(&mut game, 250, IN_JUMP);
        if launches {
            assert!(!teleported, "v{version}: the pad's pit teleport fired");
            assert!(max_z > -560.0, "v{version}: pad launch apex {max_z} (engine -526.1)");
        } else {
            assert!(teleported && max_z < -870.0, "v{version}: v1 falls through the playerclip pad into the pit (apex {max_z})");
        }
    }
}

/// bhop_awful3 ("teleport missing, impossible to finish"): the maze floor (z -3008, under teleport `bilbo`) and the
/// landing under `baggins` (z -4224) are playerclip brushes. In v1 the player fell through the maze floor to z -4032,
/// where no trigger_teleport reaches (stuck for good), and through the `baggins` floor into an earlier stage's pit.
#[test]
fn awful3_playerclip_floors() {
    for (version, solid) in [(PHYSICS_V1, false), (PHYSICS_V2, true)] {
        let Some(mut game) = load("bhop_awful3", version) else { return };
        for (what, spot, floor) in [("maze", [-1650.0, 300.0, -3000.0], -3008.0), ("baggins", [-11392.0, 1280.0, -4160.0], -4224.0)] {
            game.reset();
            game.place_player(spot);
            let (_, teleported) = run(&mut game, 200, 0);
            let z = game.state.position[2];
            if solid {
                assert!(!teleported && game.state.ground.is_some() && (z - floor).abs() < 2.0, "v{version} {what}: standing at {z} (floor {floor})");
            } else {
                assert!(teleported || z < floor - 100.0, "v{version} {what}: v1 falls through the playerclip floor (at {z})");
            }
        }
    }
}

/// bhop_absolutebhop_v4 (feedback 2026-10-14, "teleport in ground makes u appear outside the map, cant be completed"):
/// the rainbow pit at the end of level 3 is the trigger_teleport to `sky1`, the map's sky level (z ~11500): a
/// toolsskybox room whose platforms are faceless func_door plates, each marked only by an env_smokestack cloud. The
/// core resolves the teleport as CS:S does (bit-exact destination, velocity kept); the bug was the client drawing no
/// env_smokestack, so the level looked empty. This pins the map facts the client's smokestacks.ts relies on: the pit
/// leads to sky1, and every sky-level plate has no render faces and an InitialState-1 smokestack on it.
#[test]
fn absolutebhop_sky_level_platforms_are_smoke_marked() {
    let name = "bhop_absolutebhop_v4";
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping {name}: {} not found", path.display());
        return;
    };
    let Some(mut game) = load(name, bunnyhop_core::game::PHYSICS_LATEST) else { return };
    // Drop into the pit: one teleport, to the sky1 info_teleport_destination, the falling speed kept.
    game.reset();
    game.place_player([-4580.0, 1994.0, 0.0]);
    let mut landed = None;
    for _ in 0..200 {
        game.step(Cmd::default()).expect("step");
        if game.events & EVENT_TELEPORTED != 0 {
            landed = Some((game.state.position, game.state.velocity));
            break;
        }
    }
    let (at, vel) = landed.expect("the pit teleports");
    assert_eq!(at, [-6218.0, 66.0, 11516.0], "sky1");
    assert!(vel[2] < -300.0, "trigger_teleport keeps the velocity (CS:S), got {vel:?}");
    // And the player stands there (an invisible world ledge under the start cloud).
    for _ in 0..20 {
        game.step(Cmd::default()).expect("step");
    }
    assert!(game.state.ground.is_some() && game.state.position[2] > 11500.0, "standing in the sky level: {:?}", game.state.position);

    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("bsp parses");
    let mesh = bunnyhop_core::mesh::build(&bsp);
    let drawn: std::collections::HashSet<u32> = mesh.groups.iter().map(|g| g.model).collect();
    let stacks: Vec<[f32; 3]> = game
        .entities
        .iter()
        .filter(|e| e.classname() == "env_smokestack" && e.int("InitialState") == 1)
        .map(|e| e.origin())
        .collect();
    let plates: Vec<_> = game
        .entities
        .iter()
        .filter(|e| e.classname() == "func_door" && e.origin()[2] > 11000.0)
        .collect();
    assert!(plates.len() >= 20, "sky level plates: {}", plates.len());
    for e in plates {
        let model = e.brush_model().expect("brush door") as u32;
        assert!(!drawn.contains(&model), "plate *{model} has render faces");
        let o = e.origin();
        assert!(
            stacks.iter().any(|s| (s[0] - o[0]).hypot(s[1] - o[1]) < 1.0 && (s[2] - o[2]).abs() < 16.0),
            "plate *{model} at {o:?} has no smokestack"
        );
    }
}
