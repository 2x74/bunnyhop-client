//! Physics versions (`game::PHYSICS_V1` / `PHYSICS_V2` / `PHYSICS_V3`): v2 fixes two movement bugs confirmed against a
//! real CS:S server, v1 keeps the original behaviour bit for bit (every replay recorded before v2 re-simulates with it).
//! 1. Playerclip brushes block the player (MASK_PLAYERSOLID; v1's mask lacked CONTENTS_PLAYERCLIP).
//! 2. Ducking in the air and releasing duck as you land still jumps (v1 refused the jump during the 0.2 s unduck).
//! v3 adds:
//! 3. VPhysics separation: landing on a func_door (bhop_redwood's first blocks) no longer zeroes the velocity when the
//!    landing leaves the player a hair inside the 1/32 contact band (v1/v2 dead-stop; the real engine keeps moving).
//! v4 adds:
//! 4. The knife: +attack / +attack2 swing / stab and damage the func_button they hit (bhop_hive's keypad opens its
//!    first door; v1-v3 ignore the buttons).
//! 5. func_water_analog is water (bhop_lost_world's lab tank floods when its valve is turned; v1-v3 have no water there).
//! The playerclip / redwood / hive / lost_world tests need their maps in maps/ (gitignored); they skip when absent.

use bunnyhop_core::game::{
    IN_ATTACK, IN_ATTACK2, IN_USE, PHYSICS_DIAG, PHYSICS_DIAG_FIXES, PHYSICS_FIX_GAME_ENTITIES, PHYSICS_FIX_MAP_TRIGGERS, PHYSICS_FIX_PHYSBOX_DAMAGE, PHYSICS_FIX_KNIFE, PHYSICS_FIX_OUTPUT_ORDER,
    PHYSICS_FIX_PLAYERCLIP, PHYSICS_FIX_UNDUCK_JUMP, PHYSICS_FIX_VPHYSICS_SEPARATION, PHYSICS_FIX_WATER_ANALOG,
    PHYSICS_FIX_DAMAGE_ACTIVATOR, PHYSICS_FIX_FUNC_LOD, PHYSICS_FIX_GLOCK_BURST, PHYSICS_FIX_LADDER, PHYSICS_FIX_WATER_JUMP,
    PHYSICS_FIX_TEMPLATE_NAMES, PHYSICS_FIX_USP_SILENCER, PHYSICS_FIX_WEAPON_COMMANDS, PHYSICS_FIX_WEAPON_RESTORE, PHYSICS_FIX_WEAPONS,
    PHYSICS_LATEST, PHYSICS_V1, PHYSICS_V2, PHYSICS_V3, PHYSICS_V4, PHYSICS_V5, PHYSICS_V6, PHYSICS_V7, PHYSICS_V8, PHYSICS_V9,
    PHYSICS_V10, PHYSICS_V11, PHYSICS_V12, PHYSICS_V13, PHYSICS_V14, PHYSICS_V15, PHYSICS_V16, PHYSICS_V17, PHYSICS_V18, PHYSICS_V19, PHYSICS_FIX_SURFACE_LADDER, PHYSICS_FIX_MAP_PLAYER_IO, PHYSICS_FIX_INCLINE, PHYSICS_FIX_EDGE, PHYSICS_FIX_TRIGGER_JUMP, PHYSICS_FIX_TELEHOP, PHYSICS_FIX_DOWNHILL, PHYSICS_FIX_MAP_MAX_VELOCITY, PHYSICS_FIX_TRAIN_SPAWN, PHYSICS_FIX_MAP_DOOR_TRAVEL, PHYSICS_FIX_DOOR_START_OPEN, PHYSICS_FIX_CROUCH_GROUND, physics_fixes,
};
use bunnyhop_core::game::{EVENT_MAP_TELEPORT, EVENT_TELEPORTED, IN_JUMP};
use bunnyhop_core::physics::ConvexBrush;
use bunnyhop_core::{Cmd, Game, Settings};
use playsrc_collision::Hull;
use playsrc_movement::{self as movement, Command, Error, Player, State, StepInput, Trace, Tracer};
use std::path::PathBuf;

mod common;

const CONTENTS_SOLID: u32 = 0x1;
const CONTENTS_PLAYERCLIP: u32 = 0x10000;

fn v(version: u32) -> Settings {
    Settings { physics_version: version, ..Settings::css_bhop() }
}

#[test]
fn versions_and_fix_bits() {
    assert_eq!(Settings::css_bhop().physics_version, PHYSICS_V1, "native default stays v1");
    assert_eq!(PHYSICS_LATEST, PHYSICS_V19);
    assert_eq!(physics_fixes(PHYSICS_V1), Some(0));
    assert_eq!(physics_fixes(PHYSICS_V2), Some(PHYSICS_FIX_PLAYERCLIP | PHYSICS_FIX_UNDUCK_JUMP));
    assert_eq!(
        physics_fixes(PHYSICS_V3),
        Some(PHYSICS_FIX_PLAYERCLIP | PHYSICS_FIX_UNDUCK_JUMP | PHYSICS_FIX_VPHYSICS_SEPARATION)
    );
    let v4 = PHYSICS_FIX_PLAYERCLIP
        | PHYSICS_FIX_UNDUCK_JUMP
        | PHYSICS_FIX_VPHYSICS_SEPARATION
        | PHYSICS_FIX_KNIFE
        | PHYSICS_FIX_WATER_ANALOG
        | PHYSICS_FIX_LADDER;
    assert_eq!(physics_fixes(PHYSICS_V4), Some(v4));
    let v5 = v4 | PHYSICS_FIX_WEAPONS | PHYSICS_FIX_WATER_JUMP | PHYSICS_FIX_GAME_ENTITIES | PHYSICS_FIX_OUTPUT_ORDER | PHYSICS_FIX_FUNC_LOD;
    assert_eq!(physics_fixes(PHYSICS_V5), Some(v5));
    let v6 = v5 | PHYSICS_FIX_DAMAGE_ACTIVATOR | PHYSICS_FIX_GLOCK_BURST;
    assert_eq!(physics_fixes(PHYSICS_V6), Some(v6));
    assert_eq!(physics_fixes(PHYSICS_V6).unwrap() & PHYSICS_FIX_TEMPLATE_NAMES, 0, "v6 keeps v5's template names");
    let v7 = v6 | PHYSICS_FIX_TEMPLATE_NAMES | PHYSICS_FIX_WEAPON_COMMANDS | PHYSICS_FIX_USP_SILENCER;
    assert_eq!(physics_fixes(PHYSICS_V7), Some(v7));
    let v8 = v7 | PHYSICS_FIX_MAP_TRIGGERS;
    assert_eq!(physics_fixes(PHYSICS_V8), Some(v8));
    let v9 = v8 | PHYSICS_FIX_PHYSBOX_DAMAGE;
    assert_eq!(physics_fixes(PHYSICS_V9), Some(v9));
    let v10 = v9 | PHYSICS_FIX_WEAPON_RESTORE;
    assert_eq!(physics_fixes(PHYSICS_V10), Some(v10));
    let v11 = v10 | PHYSICS_FIX_CROUCH_GROUND;
    assert_eq!(physics_fixes(PHYSICS_V11), Some(v11));
    assert_eq!(physics_fixes(PHYSICS_V12), Some(v11 | PHYSICS_FIX_DOOR_START_OPEN));
    let v13 = v11 | PHYSICS_FIX_DOOR_START_OPEN | PHYSICS_FIX_DOWNHILL;
    assert_eq!(physics_fixes(PHYSICS_V13), Some(v13));
    let v14 = v13 | PHYSICS_FIX_MAP_MAX_VELOCITY | PHYSICS_FIX_TRAIN_SPAWN;
    assert_eq!(physics_fixes(PHYSICS_V14), Some(v14));
    let v15 = v14 | PHYSICS_FIX_MAP_DOOR_TRAVEL;
    assert_eq!(physics_fixes(PHYSICS_V15), Some(v15));
    let v16 = v15 | PHYSICS_FIX_MAP_PLAYER_IO;
    assert_eq!(physics_fixes(PHYSICS_V16), Some(v16));
    let rngfix = PHYSICS_FIX_INCLINE | PHYSICS_FIX_EDGE | PHYSICS_FIX_TRIGGER_JUMP | PHYSICS_FIX_TELEHOP;
    assert_eq!(physics_fixes(PHYSICS_V17), Some(v16 | rngfix));
    for version in PHYSICS_V1..=PHYSICS_V12 {
        assert!(!v(version).configuration().fixes.downhill);
    }
    assert!(v(PHYSICS_V13).configuration().fixes.downhill);
    for version in PHYSICS_V1..=PHYSICS_V16 {
        let fixes = v(version).configuration().fixes;
        assert!(!fixes.rngfix_incline && !fixes.rngfix_edge && !fixes.uphill, "v{version} keeps the old slopes");
    }
    assert_eq!(physics_fixes(PHYSICS_V18), Some(v16 | rngfix | PHYSICS_FIX_SURFACE_LADDER));
    assert_eq!(physics_fixes(PHYSICS_V19), physics_fixes(PHYSICS_V18));
    let v17 = v(PHYSICS_V17).configuration().fixes;
    assert!(v17.downhill && v17.rngfix_incline && v17.rngfix_edge);
    assert!(!v17.uphill && !v17.rampbug, "v17 uses RNGFix's uphill, not the optional rule's");
    assert_eq!(physics_fixes(PHYSICS_DIAG | PHYSICS_FIX_TEMPLATE_NAMES), Some(PHYSICS_FIX_TEMPLATE_NAMES));
    assert_eq!(physics_fixes(PHYSICS_DIAG | PHYSICS_FIX_USP_SILENCER), Some(PHYSICS_FIX_USP_SILENCER));
    assert_eq!(physics_fixes(PHYSICS_DIAG | PHYSICS_FIX_DAMAGE_ACTIVATOR), Some(PHYSICS_FIX_DAMAGE_ACTIVATOR));
    assert_eq!(physics_fixes(PHYSICS_DIAG | PHYSICS_FIX_PLAYERCLIP), Some(PHYSICS_FIX_PLAYERCLIP));
    assert_eq!(physics_fixes(PHYSICS_DIAG | PHYSICS_FIX_KNIFE), Some(PHYSICS_FIX_KNIFE));
    assert_eq!(physics_fixes(PHYSICS_DIAG | PHYSICS_FIX_VPHYSICS_SEPARATION), Some(PHYSICS_FIX_VPHYSICS_SEPARATION));
    assert_eq!(physics_fixes(0), None);
    assert_eq!(physics_fixes(20), None);
    // v7 used all 16 bits of the old diagnostic mask (base 0x1_0000); v8's fix is bit 16, so the base moved to bit 24
    // with 24 fix bits; v15's fix is bit 24, so it moved again to bit 25 with 25 fix bits, v16's is bit 25, so it moved
    // to bit 26, and v17's four are bits 26..29, so it is now bit 30 with 30 fix bits. Versions keep their fix sets bit
    // for bit (above), and the mask is never serialized.
    assert_eq!(v7, 0xffff);
    assert_eq!(PHYSICS_DIAG, 1 << 31);
    assert_eq!(PHYSICS_DIAG_FIXES, 0x7fff_ffff);
    assert_eq!(v8, 0x1_ffff);
    assert_eq!(v8 & !PHYSICS_DIAG_FIXES, 0, "every fix fits the diagnostic mask");
    assert_eq!(physics_fixes(PHYSICS_DIAG | 0xffff), Some(0xffff), "v7's fixes alone");
    assert_eq!(physics_fixes(PHYSICS_DIAG | v8), Some(v8));
    assert_eq!(physics_fixes(PHYSICS_DIAG | PHYSICS_FIX_MAP_TRIGGERS), Some(PHYSICS_FIX_MAP_TRIGGERS));
    assert_eq!(v9, 0x3_ffff);
    assert_eq!(physics_fixes(PHYSICS_DIAG | v9), Some(v9));
    assert_eq!(physics_fixes(PHYSICS_DIAG | PHYSICS_FIX_PHYSBOX_DAMAGE), Some(PHYSICS_FIX_PHYSBOX_DAMAGE));
    assert_eq!(v10, 0x7_ffff);
    assert_eq!(physics_fixes(PHYSICS_DIAG | v10), Some(v10));
    assert_eq!(physics_fixes(PHYSICS_DIAG | PHYSICS_FIX_WEAPON_RESTORE), Some(PHYSICS_FIX_WEAPON_RESTORE));
    // v14 used the last two bits of the old 24-bit diagnostic mask; v15 adds bit 24, v16 bit 25.
    assert_eq!(physics_fixes(PHYSICS_V14), Some(0x00ff_ffff), "v14 sets every bit of the old 24-bit mask");
    assert_eq!(physics_fixes(PHYSICS_V15), Some(0x01ff_ffff), "v15 sets every bit of the old 25-bit mask");
    assert_eq!(physics_fixes(PHYSICS_V16), Some(0x03ff_ffff), "v16 sets every bit of the old 26-bit mask");
    assert_eq!(physics_fixes(PHYSICS_V17), Some(0x3fff_ffff), "v17 preserves its original fix bits");
    for fix in [PHYSICS_FIX_INCLINE, PHYSICS_FIX_EDGE, PHYSICS_FIX_TRIGGER_JUMP, PHYSICS_FIX_TELEHOP] {
        assert_eq!(physics_fixes(PHYSICS_DIAG | fix), Some(fix));
    }
    assert_eq!(physics_fixes((1 << 26) | PHYSICS_FIX_TRAIN_SPAWN), None, "the 26-bit diagnostic base is not a version");
    assert_eq!(physics_fixes(PHYSICS_DIAG | PHYSICS_FIX_TRAIN_SPAWN), Some(PHYSICS_FIX_TRAIN_SPAWN));
    assert_eq!(physics_fixes(PHYSICS_DIAG | PHYSICS_FIX_MAP_DOOR_TRAVEL), Some(PHYSICS_FIX_MAP_DOOR_TRAVEL));
    assert_eq!(physics_fixes(PHYSICS_DIAG | PHYSICS_FIX_MAP_PLAYER_IO), Some(PHYSICS_FIX_MAP_PLAYER_IO));
    assert_eq!(physics_fixes((1 << 24) | PHYSICS_FIX_TRAIN_SPAWN), None, "the 24-bit diagnostic base is not a version");
    assert_eq!(physics_fixes((1 << 25) | PHYSICS_FIX_TRAIN_SPAWN), None, "nor is the 25-bit one");
    assert_eq!(physics_fixes(PHYSICS_DIAG | PHYSICS_DIAG_FIXES), Some(PHYSICS_DIAG_FIXES));
    assert_eq!(physics_fixes(0x100), None, "the 8-bit diagnostic base is not a version");
    assert_eq!(physics_fixes(0x1_0000 | 0xffff), None, "nor is the 16-bit one");
    assert_eq!(physics_fixes(0x1_0000), None);
    // v1 is exactly the original configuration (vendored default masks, SDK unduck rules).
    let (c1, p1) = (v(PHYSICS_V1).configuration(), v(PHYSICS_V1).policy());
    assert_eq!(c1.solid_mask, 0x0204_000b);
    assert_eq!(c1.ladder_mask, 0x0204_000b | movement::CONTENTS_LADDER);
    assert!(!p1.jump_while_unducking && !p1.air_unduck_from_transition);
    let (c2, p2) = (v(PHYSICS_V2).configuration(), v(PHYSICS_V2).policy());
    assert_eq!(c2.solid_mask, playsrc_collision::MASK_PLAYERSOLID);
    assert_ne!(c2.solid_mask & CONTENTS_PLAYERCLIP, 0);
    assert_eq!(c2.ladder_mask, playsrc_collision::MASK_PLAYERSOLID | movement::CONTENTS_LADDER);
    assert!(p2.jump_while_unducking && p2.air_unduck_from_transition);
}

// ---- 1. playerclips ------------------------------------------------------------------------------------------------

fn load(name: &str) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping {name}: {} not found", path.display());
        return None;
    };
    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("bsp parses");
    Some(Game::load(&bsp).expect("game loads"))
}

/// Axis-aligned bounds of the world's playerclip-only brushes (at least 8 units thick on every axis).
fn playerclip_boxes(game: &Game) -> Vec<([f32; 3], [f32; 3])> {
    let w = game.collision_world();
    let mut out = Vec::new();
    for &b in &w.world_brushes {
        let br = &w.brushes[b];
        if br.contents & CONTENTS_PLAYERCLIP == 0 || br.contents & CONTENTS_SOLID != 0 {
            continue;
        }
        let (mut lo, mut hi) = ([-1e9f32; 3], [1e9f32; 3]);
        for s in &w.sides[br.first_side..br.first_side + br.side_count] {
            let p = &w.planes[s.plane as usize];
            for a in 0..3 {
                if p.normal[a] == 1.0 {
                    hi[a] = hi[a].min(p.distance);
                }
                if p.normal[a] == -1.0 {
                    lo[a] = lo[a].max(-p.distance);
                }
            }
        }
        if (0..3).all(|a| hi[a] - lo[a] >= 8.0 && hi[a] - lo[a] < 1e8) {
            out.push((lo, hi));
        }
    }
    out
}

/// Runs into +x at 400 u/s for 20 ticks from `start` (airborne, no settle; falls 16 units) and returns the furthest
/// x reached.
fn run_into(game: &mut Game, start: [f32; 3]) -> f32 {
    game.reset();
    game.state.position = start;
    game.state.velocity = [400.0, 0.0, 0.0];
    game.state.ground = None;
    let mut max_x = start[0];
    for _ in 0..20 {
        game.step(Cmd { forward: 400.0, ..Default::default() }).expect("step");
        max_x = max_x.max(game.state.position[0]);
    }
    max_x
}

#[test]
fn playerclips_block_the_player_in_v2_only() {
    let Some(mut game) = load("bhop_fps_max") else { return };
    let hull = Hull { mins: [-16.0, -16.0, 0.0], maxs: [16.0, 16.0, 62.0] };
    let boxes = playerclip_boxes(&game);
    assert!(!boxes.is_empty(), "bhop_fps_max has playerclip brushes");
    let (mut tested, mut v1_through, mut v2_blocked) = (0, 0, 0);
    for (lo, hi) in boxes {
        // Sweep the standing hull through the middle of the brush along +x, from open space 8 units in front of it,
        // head just under the brush top (so it still overlaps the brush after falling for 20 ticks).
        if hi[2] - lo[2] < 24.0 || hi[1] - lo[1] < 40.0 {
            continue;
        }
        let start = [lo[0] - 16.0 - 8.0, (lo[1] + hi[1]) * 0.5, hi[2] - 63.0];
        let end = [hi[0] + 16.0 + 48.0, start[1], start[2]];
        let clip_x = lo[0] - 16.0;
        if game.trace_hull(start, start, hull, playsrc_collision::MASK_PLAYERSOLID).start_solid {
            continue;
        }
        // Only brushes that are the first thing in the way (nothing solid in front of them).
        let full = game.trace_hull(start, end, hull, playsrc_collision::MASK_PLAYERSOLID);
        let solid_only = game.trace_hull(start, end, hull, 0x0204_000b);
        if (full.end[0] - clip_x).abs() >= 1.0 || solid_only.end[0] <= clip_x + 8.0 {
            continue;
        }
        tested += 1;
        game.set_settings(v(PHYSICS_V1));
        assert!(game.trace_player_hull(start, end).end[0] > clip_x + 8.0, "v1 player trace passes the clip");
        let x1 = run_into(&mut game, start);
        game.set_settings(v(PHYSICS_V2));
        assert!((game.trace_player_hull(start, end).end[0] - clip_x).abs() < 1.0, "v2 player trace stops at the clip");
        let x2 = run_into(&mut game, start);
        if tested <= 3 {
            eprintln!(
                "playerclip x {:.0}..{:.0} y {:.0}..{:.0} z {:.0}..{:.0}: from x {:.0} v1 reached x {x1:.1}, v2 x {x2:.1} (clip face {clip_x:.1})",
                lo[0], hi[0], lo[1], hi[1], lo[2], hi[2], start[0]
            );
        }
        v1_through += (x1 > clip_x + 8.0) as u32;
        v2_blocked += (x2 <= clip_x + 0.1) as u32;
        assert!(x2 <= clip_x + 0.1, "v2: running into the playerclip at x {clip_x} stops at its face (reached {x2})");
    }
    eprintln!("bhop_fps_max: {tested} playerclip brushes run into: v1 went through {v1_through}, v2 blocked {v2_blocked}");
    assert!(tested > 0 && v1_through > 0, "v1 (the original port) walks through bhop_fps_max's playerclips");
    assert_eq!(v2_blocked, tested);
}

// ---- 2. duck released on landing ----------------------------------------------------------------------------------

const DIST_EPSILON: f32 = 0.03125;

/// Solid half-space below z = 0.
struct Floor;

impl Tracer for Floor {
    fn trace(&self, start: [f32; 3], end: [f32; 3], hull: Hull, _mask: u32) -> Result<Trace, Error> {
        let bottom = |p: [f32; 3]| p[2] + hull.mins[2];
        let (s, e) = (bottom(start), bottom(end));
        let miss = Trace { fraction: 1.0, start_solid: false, all_solid: false, end, normal: None, hit: None, contents: 0 };
        if s < 0.0 {
            let n = Some([0.0, 0.0, 1.0]);
            return Ok(Trace { fraction: 0.0, start_solid: true, all_solid: e < 0.0, end: start, normal: n, hit: Some(0), contents: 1 });
        }
        if e >= DIST_EPSILON || e >= s {
            return Ok(miss);
        }
        let fraction = ((s - DIST_EPSILON) / (s - e)).clamp(0.0, 1.0);
        let end = [
            start[0] + (end[0] - start[0]) * fraction,
            start[1] + (end[1] - start[1]) * fraction,
            start[2] + (end[2] - start[2]) * fraction,
        ];
        Ok(Trace { fraction, start_solid: false, all_solid: false, end, normal: Some([0.0, 0.0, 1.0]), hit: Some(0), contents: 1 })
    }
}

/// Autohop with jump held, no strafing, from 400 u/s on the ground; duck pressed from the 5th air tick and released on
/// the first grounded tick (duck in the air, release as you land). Returns the horizontal speed at each takeoff.
fn duck_release_hops(settings: Settings, ticks: u32) -> Vec<f32> {
    let (configuration, policy) = (settings.configuration(), settings.policy());
    let mut state = State::from_player(
        Player { position: [0.0; 3], velocity: [400.0, 0.0, 0.0], grounded: true, crouched: false, jump_latched: false },
        policy,
    );
    let (mut air, mut hops) = (0u32, Vec::new());
    for tick in 0..ticks {
        let grounded = state.ground.is_some();
        air = if grounded { 0 } else { air + 1 };
        // Game::step with autohop: the jump is never latched.
        state.jump_latched = false;
        state.previous_jump = false;
        let command = Command { forward: 0.0, side: 0.0, yaw_degrees: 0.0, jump: true, crouch: !grounded && air >= 5 };
        let input = StepInput { command_number: tick, command, ..Default::default() };
        let r = movement::step(&Floor, state, input, configuration, policy).expect("step");
        if r.jump_velocity != [0.0; 3] {
            hops.push((r.state.velocity[0].powi(2) + r.state.velocity[1].powi(2)).sqrt());
        }
        state = r.state;
    }
    hops
}

#[test]
fn duck_released_on_landing_keeps_speed_in_v2_only() {
    let v1 = duck_release_hops(v(PHYSICS_V1), 1000);
    let v2 = duck_release_hops(v(PHYSICS_V2), 1000);
    eprintln!("v1 takeoff speeds: {:?}", &v1[..v1.len().min(6)]);
    eprintln!("v2 takeoff speeds: {:?}", &v2[..v2.len().min(6)]);
    // v2 (CS:S): every landing hops at once, no ground friction: 400 u/s on every hop.
    assert!(v2.len() > 10);
    assert!(v2.iter().all(|&s| (s - 400.0).abs() < 0.01), "v2 keeps 400 u/s on every hop: {v2:?}");
    // v1: the jump waits out the 0.2 s unduck on the ground, so friction eats speed on every hop after the first.
    assert!(v1.len() < v2.len(), "v1 loses ground time to the unduck ({} vs {} hops)", v1.len(), v2.len());
    assert!((v1[0] - 400.0).abs() < 0.01, "the first (standing) takeoff is 400");
    assert!(v1[1] < 400.0 * 0.6, "v1's second hop lost > 40% to friction: {}", v1[1]);
}

/// `Game::set_settings` picks the version up and `reset` keeps it (the playerclip test above runs both versions
/// through `Game::step`).
#[test]
fn game_follows_the_selected_version() {
    let Some(mut game) = load("bhop_fps_max") else { return };
    game.set_settings(v(PHYSICS_V2));
    assert_eq!(game.settings.physics_version, PHYSICS_V2);
    game.reset();
    assert_eq!(game.settings.physics_version, PHYSICS_V2, "reset keeps the version");
    game.set_settings(v(PHYSICS_V1));
    assert_eq!(game.settings.physics_version, PHYSICS_V1);
}

/// bhop_redwood, Half-Sideways hop onto the third block from the start (func_door *4, SOLID_VPHYSICS). The landing
/// trace stops 1 % short of the tick and leaves the feet 2 ulps inside the 1/32 contact band; the rest of the move
/// (the clipped, tiny upward velocity) then "hit" the block's bottom face at fraction 0 and v1/v2 zeroed the velocity:
/// the next hop leaves at ~30 u/s (the player report). The real CS:S engine (tools/parity rw_land1) keeps moving and
/// lands at exactly the v3 position and velocity below.
#[test]
fn redwood_block_landing_keeps_speed() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps/bhop_redwood.bsp");
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping: {} not found", path.display());
        return;
    };
    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("bsp parses");
    let land = |version: u32| {
        let mut game = Game::load(&bsp).expect("game loads");
        game.set_settings(v(version));
        game.set_position([1720.0, -1600.0, 74.0], 180.0);
        game.state.position = [1327.093_3, -1621.425_8, 58.481_556];
        game.state.velocity = [-114.748_07, -94.947_525, -294.006_62];
        game.state.ground = None;
        game.step(Cmd { forward: 450.0, side: -450.0, yaw: 115.6195, pitch: 0.0, buttons: 2 | 8 | 512 }).expect("step");
        (game.state.position, game.state.velocity, game.state.ground.is_some())
    };
    for old in [PHYSICS_V1, PHYSICS_V2] {
        let (_, vel, grounded) = land(old);
        assert!(grounded);
        assert_eq!(vel, [0.0; 3], "v{old} keeps its dead stop (existing replays)");
    }
    let (pos, vel, grounded) = land(PHYSICS_V3);
    assert!(grounded);
    // Real engine (bit patterns 44a5be44 c4cacc02 425e2001 / c2e57f03 c2bde522 0).
    assert_eq!(pos.map(f32::to_bits), [0x44a5_be44, 0xc4ca_cc02, 0x425e_2001]);
    assert_eq!(vel.map(f32::to_bits), [0xc2e5_7f03, 0xc2bd_e522, 0]);
}

// ---- 4. the knife (v4) ---------------------------------------------------------------------------------------------

fn map_game(name: &str) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    if !path.exists() {
        eprintln!("skipping {name}: {} not found", path.display());
        return None;
    }
    Some(bunnyhop_core::content::load_game(&path).expect("map loads"))
}

/// bhop_hive's first door (`tür2`, locked) only opens when its keypad, a damage-activated func_button (spawnflags 513,
/// OnDamaged -> tür2 Unlock / Open after 2 s), takes damage: CS:S players shoot or knife it. Stands in front of the
/// keypad (from the start zone side), presses `buttons` for 3 ticks, waits 4 s and walks through the doorway. Returns
/// the door's height drop and how far south the player got.
fn hive_keypad(version: u32, buttons: u32) -> Option<(f32, f32)> {
    let mut game = map_game("bhop_hive")?;
    game.set_settings(v(version));
    let door = game.entities.iter().position(|e| e.get("classname") == Some("func_door") && e.get("hammerid") == Some("23839")).expect("door");
    let keypad = game.entities.iter().position(|e| e.get("hammerid") == Some("333652")).expect("keypad");
    let (lo, hi) = game.entity_bounds(keypad).expect("keypad brush");
    let c = [0, 1, 2].map(|k| (lo[k] + hi[k]) * 0.5);
    game.set_position([-13720.0, 13240.0, -1200.0], 270.0);
    let p = game.state.position;
    let d = [c[0] - p[0], c[1] - p[1], c[2] - (p[2] + 64.0)];
    let yaw = d[1].atan2(d[0]).to_degrees();
    let pitch = -d[2].atan2((d[0] * d[0] + d[1] * d[1]).sqrt()).to_degrees();
    let z0 = game.entity_transform(door).unwrap().0[2];
    for t in 0..400 {
        let b = if (5..8).contains(&t) { buttons } else { 0 };
        game.step(Cmd { forward: 0.0, side: 0.0, yaw, pitch, buttons: b }).unwrap();
    }
    let drop = z0 - game.entity_transform(door).unwrap().0[2];
    for _ in 0..300 {
        let p = game.state.position;
        let target = if (p[0] + 13696.0).abs() > 4.0 && p[1] > 13215.0 { [-13696.0, 13225.0] } else { [-13696.0, 12900.0] };
        let yaw = (target[1] - p[1]).atan2(target[0] - p[0]).to_degrees();
        game.step(Cmd { forward: 450.0, side: 0.0, yaw, pitch: 0.0, buttons: 0 }).unwrap();
    }
    Some((drop, game.state.position[1]))
}

#[test]
fn hive_knife_opens_the_first_door_from_v4() {
    // v4: the swing and the stab both reach the keypad; the door sinks into the floor (144 u) and the player walks
    // through the doorway (y 13186..13190) into the next room.
    for buttons in [IN_ATTACK, IN_ATTACK2] {
        let Some((drop, y)) = hive_keypad(PHYSICS_V4, buttons) else { return };
        assert!(drop > 140.0, "v4 buttons {buttons:#x}: door opened (dropped {drop})");
        assert!(y < 13150.0, "v4 buttons {buttons:#x}: walked through the doorway (y {y})");
    }
    // v1-v3 ignore the knife buttons (existing replays), and +use never worked on this keypad (it isn't usable).
    for version in [PHYSICS_V1, PHYSICS_V2, PHYSICS_V3] {
        let Some((drop, y)) = hive_keypad(version, IN_ATTACK | IN_ATTACK2) else { return };
        assert_eq!(drop, 0.0, "v{version}: door stays shut");
        assert!(y > 13190.0, "v{version}: the closed door blocks (y {y})");
    }
    let Some((drop, _)) = hive_keypad(PHYSICS_V4, IN_USE) else { return };
    assert_eq!(drop, 0.0, "+use doesn't press a damage-only button (CS:S: not FCAP_IMPULSE_USE)");
}

#[test]
fn knife_swings_at_the_knife_rate() {
    // Holding +attack at the keypad from tick 10: the first swing at once, then every 0.5 s (a hit). Each hit fires OnDamaged
    // (5 outputs on hive's keypad) on the player clock.
    let Some(mut game) = map_game("bhop_hive") else { return };
    game.set_settings(v(PHYSICS_V4));
    game.set_position([-13720.0, 13240.0, -1200.0], 270.0);
    let mut fired = Vec::new();
    for t in 0..120u32 {
        let before = game.queued_events();
        let buttons = if t >= 10 { IN_ATTACK } else { 0 };
        game.step(Cmd { forward: 0.0, side: 0.0, yaw: 237.875, pitch: 1.78, buttons }).unwrap();
        if game.queued_events() >= before + 5 {
            fired.push(t);
        }
    }
    assert_eq!(fired, [10, 60, 110], "swings at once, after 0.5 s and 1 s");
}

// ---- 5. func_water_analog (v4) -------------------------------------------------------------------------------------

/// bhop_lost_world's lab: a 450-deep tank (x 6440..7384, y 7112..7880, floor z -384) whose water is a func_water_analog
/// parented to `water_movelin01`; the valve (`rot_button01`, +use) raises it 208 u for 30 s. Drops the player into the
/// tank (after turning the valve when `valve`), lets it settle for 4 s, then swims up (+jump) for 4 s. Returns the
/// deepest water level seen, the lowest feet height, the water entity's height and the feet height after swimming up.
fn lost_world_tank(version: u32, valve: bool) -> Option<(u8, f32, f32, f32)> {
    let mut game = map_game("bhop_lost_world")?;
    game.set_settings(v(version));
    let water = game.entities.iter().position(|e| e.get("classname") == Some("func_water_analog")).expect("water");
    if valve {
        // Stand in front of the valve (on the floor of the room west of the tank), look at it, press +use.
        let hull = Hull { mins: [-16.0, -16.0, 0.0], maxs: [16.0, 16.0, 62.0] };
        let floor = game.trace_hull([6342.0, 7480.0, 152.0], [6342.0, 7480.0, -8.0], hull, 0x0201_400b).end;
        game.place_player(floor);
        let p = game.state.position;
        let pitch = -(144.0 - (p[2] + 64.0)).atan2(6382.0 - p[0]).to_degrees();
        game.step(Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch, buttons: 0 }).unwrap();
        game.step(Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch, buttons: IN_USE }).unwrap();
        for _ in 0..1100 {
            game.step(Cmd::default()).unwrap();
        }
    }
    let water_z = game.entity_transform(water).unwrap().0[2];
    game.place_player([6900.0, 7600.0, 120.0]);
    let (mut deepest, mut lowest) = (0, f32::MAX);
    for t in 0..800 {
        let buttons = if t >= 400 { 2 } else { 0 };
        game.step(Cmd { buttons, ..Cmd::default() }).unwrap();
        deepest = deepest.max(game.state.water_level);
        lowest = lowest.min(game.state.position[2]);
    }
    Some((deepest, lowest, water_z, game.state.position[2]))
}

#[test]
fn lost_world_tank_holds_water_from_v4() {
    // Before the valve: water from z -592 to -144 at the bottom of the tank; a player dropping in lands in it.
    let Some((deepest, lowest, water_z, swum)) = lost_world_tank(PHYSICS_V4, false) else { return };
    assert_eq!(water_z, -368.0);
    assert_eq!(deepest, 3, "v4: under water");
    assert!(lowest > -384.0, "v4: the water breaks the fall (lowest feet {lowest})");
    assert!((-190.0..-140.0).contains(&swum), "v4: swims up to the surface at z -144 (feet {swum})");
    // After the valve: the water (and its parent) rose 208 u; swimming up reaches the new surface (z 64).
    let Some((deepest, lowest, water_z, swum)) = lost_world_tank(PHYSICS_V4, true) else { return };
    assert_eq!(water_z, -160.0, "the valve raised the water 208 u");
    assert_eq!(deepest, 3, "v4: under water in the flooded tank");
    assert!(lowest > -384.0, "v4: never touches the tank floor (lowest feet {lowest})");
    assert!((20.0..64.0).contains(&swum), "v4: swims up to the raised surface (feet {swum})");
    // v1-v3: no water at all; the player drops to the tank floor and stays there (existing replays).
    for version in [PHYSICS_V1, PHYSICS_V2, PHYSICS_V3] {
        let Some((deepest, lowest, _, swum)) = lost_world_tank(version, true) else { return };
        assert_eq!(deepest, 0, "v{version}: no water");
        assert!(lowest < -250.0, "v{version}: falls to the bottom of the tank (lowest feet {lowest})");
        assert!(swum < -150.0, "v{version}: can't swim up, only hop on the bottom (feet {swum})");
    }
}

/// func_water_analog is a CFuncMoveLinear: bhop_crash_egypt's tide (`water_analog1`, 26 pools, Open at map spawn,
/// then Close / Open on OnFullyOpen / OnFullyClosed) rises 72 u from v4; before v4 its inputs did nothing.
#[test]
fn crash_egypt_tide_moves_from_v4() {
    for (version, rises) in [(PHYSICS_V3, false), (PHYSICS_V4, true)] {
        let Some(mut game) = map_game("bhop_crash_egypt") else { return };
        game.set_settings(v(version));
        game.reset();
        let pool = game.entities.iter().position(|e| e.get("targetname") == Some("water_analog1")).expect("pool");
        let z0 = game.entity_transform(pool).unwrap().0[2];
        let mut top = z0;
        for _ in 0..400 {
            game.step(Cmd::default()).unwrap();
            top = top.max(game.entity_transform(pool).unwrap().0[2]);
        }
        let rise = top - z0;
        assert!(if rises { (rise - 72.0).abs() < 0.01 } else { rise == 0.0 }, "v{version}: rose {rise}");
    }
}


#[test]
fn portal_start_open_door_is_clear_from_v12_and_old_versions_stay_closed() {
    let Some(mut game) = map_game("bhop_ln_portal") else { return };
    let door = game.entities.iter().position(|e| e.get("targetname") == Some("door_right_a00")).expect("reported door");
    let closed_origin = game.entity_transform(door).unwrap().0;
    for version in [PHYSICS_V11, PHYSICS_V12, PHYSICS_V11, PHYSICS_V12] {
        game.set_settings(v(version));
        game.reset();
        let open_origin = game.entity_transform(door).unwrap().0;
        assert_eq!(open_origin != closed_origin, version == PHYSICS_V12, "v{version}: door spawn transform");
        game.set_position([982.5, -560.2, -15692.0], 249.7);
        for _ in 0..100 {
            game.step(Cmd { forward: 450.0, yaw: 249.7, pitch: 8.4, ..Default::default() }).expect("walk");
        }
        let y = game.state.position[1];
        assert!(if version == PHYSICS_V12 { y < -740.0 } else { y > -701.0 }, "v{version}: reached y={y}");
    }
    // The current map uses the legacy flag; the newer spawnpos key follows the same endpoint.
    game.entities[door].pairs.retain(|(key,_)| !key.eq_ignore_ascii_case("spawnflags"));
    game.entities[door].pairs.push(("spawnpos".into(),"1".into()));
    game.reset();
    assert_ne!(game.entity_transform(door).unwrap().0, closed_origin, "spawnpos1 opens the door");
    game.fire_input("door_right_a00", "Close", "");
    for _ in 0..100 { game.step(Cmd::default()).unwrap(); }
    assert_eq!(game.entity_transform(door).unwrap().0, closed_origin, "Close returns to authored position1");
    game.fire_input("door_right_a00", "Open", "");
    for _ in 0..100 { game.step(Cmd::default()).unwrap(); }
    assert_ne!(game.entity_transform(door).unwrap().0, closed_origin, "Open returns to position2");
}

#[test]
fn start_open_door_children_follow_parent_at_spawn_and_reset() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps/bhop_ln_portal.bsp");
    let Ok(bytes) = std::fs::read(&path) else { eprintln!("skipping {}: map absent",path.display()); return };
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let mut list = bunnyhop_core::physics::entity_list_with_outputs(&bsp,true);
    let door = list.entities.iter().position(|e| e.get("targetname") == Some("door_right_a00")).unwrap();
    let child = list.entities.len();
    list.entities.push(bunnyhop_core::entities::Entity { pairs: [("classname","info_target"),("targetname","test_door_child"),
        ("parentname","door_right_a00"),("origin","940 -720 -15600")].into_iter().map(|(k,v)|(k.into(),v.into())).collect() });
    list.outputs.push(Vec::new());
    let mut game = Game::load_with_entities(&bsp,None,list,false).unwrap();
    let original_parent = game.entity_transform(door).unwrap().0;
    let original_child = game.entity_transform(child).unwrap().0;
    game.set_settings(v(PHYSICS_V12)); // Startup initialization happens before rendering, without an explicit restart.
    for _ in 0..2 {
        let parent = game.entity_transform(door).unwrap().0;
        let moved_child = game.entity_transform(child).unwrap().0;
        for axis in 0..3 {
            assert_eq!(moved_child[axis] - original_child[axis], parent[axis] - original_parent[axis]);
        }
        assert_ne!(parent,original_parent);
        game.reset();
    }
}

// ---- v17: RNGFix parity (research/RNGFIX-1025.md) -------------------------------------------------------------------

fn spread(v: &[f32]) -> (f32, f32) {
    (v.iter().copied().fold(f32::INFINITY, f32::min), v.iter().copied().fold(f32::NEG_INFINITY, f32::max))
}

/// Synthetic uphill landings (RNGFix "Uphill Incline", `PHYSICS_FIX_INCLINE`): falling onto a 30 degree ramp while moving
/// up it at 400 u/s, from 60 heights a fraction of a tick apart. v16: the move either clips into the slope (loses speed)
/// or ends within 2 units above it and the ground probe lands it (keeps it), by sub-tick phase. v17: never the clip.
#[test]
fn uphill_landing_keeps_speed_from_v17() {
    use common::{Scene, Sim, floor, ramp_up};
    let scene = Scene::new(vec![floor(), ramp_up(0.0, 0.0, 4096.0, 2048.0, 30.0)]);
    let surface = 400.0 * 30f32.to_radians().tan();
    let landings = |version: u32| -> Vec<f32> {
        (0..60)
            .map(|i| {
                let mut sim = Sim::new(&scene, v(version), [400.0, 0.0, surface + 30.0 + i as f32 * 0.137], [400.0, 0.0, -300.0]);
                (0..200).find_map(|_| {
                    sim.idle();
                    sim.state.ground.is_some().then(|| sim.hspeed())
                })
                .expect("lands")
            })
            .collect()
    };
    let (lo16, hi16) = spread(&landings(PHYSICS_V16));
    let (lo17, hi17) = spread(&landings(PHYSICS_V17));
    eprintln!("uphill landing speed: v16 {lo16:.1}..{hi16:.1}, v17 {lo17:.1}..{hi17:.1}");
    assert!(lo16 < 300.0 && hi16 > 399.0, "v16 keeps or loses the speed by sub-tick phase");
    assert!(lo17 > 399.0 && hi17 - lo17 < 0.01, "v17 always lands with the horizontal speed");
}

/// The sub-tick sweep of `tools`' rngfixsim (crates/core/src/bin/rngfixsim.rs) on a real map: `phases` airborne starts
/// spread over one tick of travel along `vel`, jump held (autohop); the horizontal speed 3 ticks after the first change.
fn slope_sweep(game: &mut Game, version: u32, pos: [f32; 3], vel: [f32; 3], phases: usize) -> Vec<f32> {
    game.set_settings(v(version));
    let h = |v: [f32; 3]| v[0].hypot(v[1]);
    let dir = [vel[0] / h(vel), vel[1] / h(vel)];
    let step = h(vel) * 0.01 / phases as f32;
    let yaw = vel[1].atan2(vel[0]).to_degrees();
    (0..phases)
        .map(|k| {
            game.reset();
            game.place_player([pos[0] + dir[0] * step * k as f32, pos[1] + dir[1] * step * k as f32, pos[2]]);
            game.state.velocity = vel;
            let mut prev = h(vel);
            let mut impact = None;
            for t in 0..120 {
                game.step(Cmd { yaw, buttons: IN_JUMP, ..Cmd::default() }).unwrap();
                let speed = h(game.state.velocity);
                if impact.is_none() && ((speed - prev).abs() > 1.0 || game.state.ground.is_some()) {
                    impact = Some(t);
                }
                if impact.is_some_and(|i| t >= i + 3) {
                    return speed;
                }
                prev = speed;
            }
            panic!("no impact from phase {k}");
        })
        .collect()
}

/// GothQueen's report (Discord 2026-10-25, bhop_null_fix: "most direct jumps on bunnyhop.lol kill the speed", video at
/// 693 u/s): her own runs meet the 45 degree face n = (0, -0.707, 0.707) at (-3960, 3015, 422) at ~690 u/s; one landed
/// on it (kept 693), another clipped (675 -> 447 -> 348). A straight jump into it at 693 u/s, vz -200: v16 0..485 by
/// phase (most under 300: her 173 / 137), v17 always lands and launches up the slope. Also Maharero's bhop_lego2 run
/// onto the 30 degree slope brick at (-2900, -3945, 1030) (479 -> 307 in the run): v16 keeps or loses ~170, v17 keeps;
/// and a bevelled beam on bhop_letour.
#[test]
fn reported_slope_jumps_keep_speed_from_v17() {
    if let Some(mut game) = map_game("bhop_null_fix") {
        let (pos, vel) = ([-3955.0, 2955.0, 440.0], [0.0, 693.0, -200.0]);
        let (lo16, hi16) = spread(&slope_sweep(&mut game, PHYSICS_V16, pos, vel, 60));
        let (lo17, hi17) = spread(&slope_sweep(&mut game, PHYSICS_V17, pos, vel, 60));
        eprintln!("bhop_null_fix: v16 {lo16:.0}..{hi16:.0}, v17 {lo17:.0}..{hi17:.0}");
        assert!(lo16 < 300.0 && hi16 > 480.0, "v16 kills the speed on some phases");
        assert!(lo17 > 480.0 && hi17 - lo17 < 1.0, "v17: the same launch on every phase");
    }
    if let Some(mut game) = map_game("bhop_lego2") {
        let (pos, vel) = ([-2917.174, -3916.63, 1037.473], [459.546, -149.903, -206.007]);
        let (lo16, hi16) = spread(&slope_sweep(&mut game, PHYSICS_V16, pos, vel, 60));
        let (lo17, hi17) = spread(&slope_sweep(&mut game, PHYSICS_V17, pos, vel, 60));
        eprintln!("bhop_lego2: v16 {lo16:.0}..{hi16:.0}, v17 {lo17:.0}..{hi17:.0}");
        assert!(lo16 < 350.0 && hi16 > 480.0, "v16 loses ~170 u/s on some phases");
        assert!(lo17 > 480.0 && hi17 - lo17 < 1.0, "v17 keeps the speed on every phase");
    }
    // GothQueen's bhop_letour ("most of the slopes hit weird"; no finished run to replay): its blocks' top edges are
    // 13-unit 45 degree bevels, e.g. the beam at x 2379..2453, y 9208..11501 (top 1816). Dropping onto it across the bevel.
    if let Some(mut game) = map_game("bhop_letour") {
        let (pos, vel) = ([2290.0, 10000.0, 1850.0], [600.0, 0.0, -200.0]);
        let (lo16, hi16) = spread(&slope_sweep(&mut game, PHYSICS_V16, pos, vel, 60));
        let (lo17, hi17) = spread(&slope_sweep(&mut game, PHYSICS_V17, pos, vel, 60));
        eprintln!("bhop_letour: v16 {lo16:.0}..{hi16:.0}, v17 {lo17:.0}..{hi17:.0}");
        assert!(lo16 < 300.0 && hi16 > 570.0, "v16 clips on the bevel on some phases");
        assert!(lo17 > 570.0 && hi17 - lo17 < 1.0, "v17 lands on the bevel on every phase");
    }
}

/// RNGFix's downhill computation (`PHYSICS_FIX_INCLINE` on top of v13's): a landing on a downhill slope through the
/// ground probe with a base velocity (a trigger_push / conveyor) deflects velocity + base velocity and takes the base
/// velocity out again (`DoInclineCollisionFixes` / `SetVelocity`); v13..v16 deflect the player's own velocity only.
/// Same phases, same landings: without a base velocity the two agree (up to the CS:S push-out v13 adds); with 200 u/s
/// along +x on the 30 degree slope (normal (0.5, 0, 0.866)) v17's own vx is 0.25 * 200 = 50 lower.
#[test]
fn downhill_landing_counts_base_velocity_from_v17() {
    use common::{Scene, Sim, floor, ramp_down};
    let angle = 30f32;
    let scene = Scene::new(vec![floor(), ramp_down(0.0, 0.0, 4096.0, 2048.0, angle)]);
    let surface = (4096.0 - 400.0) * angle.to_radians().tan();
    // Own vx right after each phase's landing, None when the move collided with the slope (not a probe landing).
    let land = |version: u32, base: [f32; 3]| -> Vec<Option<f32>> {
        (0..60)
            .map(|i| {
                let mut sim = Sim::new(&scene, v(version), [400.0, 0.0, surface + 30.0 + i as f32 * 0.137], [400.0, 0.0, -500.0]);
                for _ in 0..200 {
                    sim.state.base_velocity = base;
                    sim.state.base_velocity_applied = base != [0.0; 3];
                    let r = sim.idle();
                    if sim.state.ground.is_some() {
                        return r.contacts.is_empty().then_some(sim.state.velocity[0]);
                    }
                }
                panic!("never landed")
            })
            .collect()
    };
    let base = [200.0, 0.0, 0.0];
    let (plain16, plain17, pushed16, pushed17) = (land(PHYSICS_V16, [0.0; 3]), land(PHYSICS_V17, [0.0; 3]), land(PHYSICS_V16, base), land(PHYSICS_V17, base));
    let mut probes = 0;
    for i in 0..60 {
        if let (Some(a), Some(b)) = (plain16[i], plain17[i]) {
            assert!(a > 500.0 && (a - b).abs() < 0.1, "phase {i}: both boost a plain probe landing ({a} / {b})");
        }
        if let (Some(a), Some(b)) = (pushed16[i], pushed17[i]) {
            probes += 1;
            assert!((a - b - 50.0).abs() < 0.1, "phase {i}: v17 deflects velocity + base velocity ({a} / {b})");
        }
    }
    assert!(probes > 0, "some phases land through the probe");
}

/// RNGFix "Edge Bugs" (`PHYSICS_FIX_EDGE`): falling onto the far edge of a flat platform at speed. When the move hits the
/// top and the rest of the tick slides past the edge, v16 loses the vertical speed without landing (no jump: an edge
/// bug); v17 starts the move a fraction of a tick back so it lands on the edge and the autohop jump happens.
#[test]
fn edge_bug_still_jumps_from_v17() {
    use common::{Scene, Sim};
    let scene = Scene::new(vec![ConvexBrush::aabb([-1024.0, -512.0, -64.0], [0.0, 512.0, 0.0])]);
    let jumped = |version: u32| -> (usize, usize) {
        let (mut jumps, mut edge_bugs) = (0, 0);
        for i in 0..80 {
            // The hull's back edge reaches x = 0 (the platform's edge) at x = 16.
            // Feet reach the top (z 0) at 3/4 of the first tick; the start x sweeps where that is relative to the edge.
            let mut sim = Sim::new(&scene, v(version), [4.0 + i as f32 * 0.1, 0.0, 3.0], [800.0, 0.0, -400.0]);
            let mut clipped = false;
            for _ in 0..10 {
                let before = sim.state.velocity[2];
                sim.step(0.0, 0.0, 0.0, true, false);
                if sim.state.velocity[2] > 200.0 {
                    jumps += 1;
                    break;
                }
                clipped |= before < -100.0 && sim.state.velocity[2] > before + 100.0 && sim.state.ground.is_none();
            }
            edge_bugs += usize::from(clipped);
        }
        (jumps, edge_bugs)
    };
    let (j16, e16) = jumped(PHYSICS_V16);
    let (j17, e17) = jumped(PHYSICS_V17);
    eprintln!("edge: v16 {j16}/80 jumped, {e16} edge bugs; v17 {j17}/80 jumped, {e17} edge bugs");
    assert!(e16 > 0 && j16 < 80, "v16 edge-bugs off the platform on some phases");
    assert!(e17 == 0, "v17 never edge-bugs");
    assert_eq!(j17, j16 + e16, "every v16 edge bug is a jump in v17; the other phases are past the edge either way");
}

/// RNGFix "Trigger Jumping" (`PHYSICS_FIX_TRIGGER_JUMP`): bhop_null_fix's 1-unit teleport pad *288 (x -816..-752,
/// y 80..144, z 160..161) on a block top at z 160. Dropped onto it from 40 heights, jump held: the landing tick ends
/// 0..2 units above the block, so in v16 the pad (the hull doesn't reach it) teleports only some first landings; v17
/// touches triggers in the landing gap, every first landing teleports.
#[test]
fn landing_touches_thin_triggers_from_v17() {
    let Some(mut game) = map_game("bhop_null_fix") else { return };
    let first_landing_teleports = |game: &mut Game, version: u32| -> usize {
        game.set_settings(v(version));
        (0..40)
            .filter(|k| {
                game.reset();
                game.place_player([-784.0, 112.0, 260.0 + *k as f32 * 0.1]);
                for _ in 0..80 {
                    let grounded = game.state.ground.is_some();
                    game.step(Cmd { buttons: IN_JUMP, ..Cmd::default() }).unwrap();
                    if game.events & EVENT_TELEPORTED != 0 {
                        return true;
                    }
                    if grounded {
                        return false; // the tick after the first landing jumps away
                    }
                }
                panic!("never landed");
            })
            .count()
    };
    let (n16, n17) = (first_landing_teleports(&mut game, PHYSICS_V16), first_landing_teleports(&mut game, PHYSICS_V17));
    eprintln!("thin teleport pad: first landing teleports v16 {n16}/40, v17 {n17}/40");
    assert!(n16 > 0 && n16 < 40, "v16 misses the pad on some landings");
    assert_eq!(n17, 40, "v17 always touches it");
}

/// RNGFix "Telehops" (`PHYSICS_FIX_TELEHOP`), with only that fix on top of v16 (diagnostic version) so trigger jumping
/// doesn't change which landings touch the pad: when the landing and the pad's teleport happen on the same tick, v16
/// teleports the player with the landing's vz = 0; v17 restores the velocity the move started with (plus half a tick of
/// gravity), as if the teleport had come first, and flags the map teleport (`EVENT_MAP_TELEPORT`) for the next tick.
#[test]
fn telehop_keeps_the_landing_velocity_from_v17() {
    let Some(mut game) = map_game("bhop_null_fix") else { return };
    let telehop = PHYSICS_DIAG | physics_fixes(PHYSICS_V16).unwrap() | PHYSICS_FIX_TELEHOP;
    let landing_teleports = |game: &mut Game, version: u32| -> Vec<([f32; 3], u32)> {
        game.set_settings(v(version));
        (0..40)
            .filter_map(|k| {
                game.reset();
                game.place_player([-784.0, 112.0, 260.0 + k as f32 * 0.1]);
                for _ in 0..80 {
                    let grounded = game.state.ground.is_some();
                    game.step(Cmd::default()).unwrap();
                    if game.events & EVENT_TELEPORTED != 0 {
                        return Some((game.state.velocity, game.events));
                    }
                    if grounded {
                        return None;
                    }
                }
                None
            })
            .collect()
    };
    let (t16, t17) = (landing_teleports(&mut game, PHYSICS_V16), landing_teleports(&mut game, telehop));
    assert!(!t16.is_empty() && t16.len() == t17.len(), "the same landings teleport ({} / {})", t16.len(), t17.len());
    for ((v16, e16), (v17, e17)) in t16.iter().zip(&t17) {
        assert_eq!(v16[2], 0.0, "v16: the landing zeroed vz before the teleport");
        assert!(v17[2] < -300.0, "v17: the fall speed is restored ({v17:?})");
        assert_eq!((v16[0], v16[1], v17[0], v17[1]), (0.0, 0.0, 0.0, 0.0));
        assert_eq!(e16 & EVENT_MAP_TELEPORT, 0, "v16 never sets the v17 event");
        assert_ne!(e17 & EVENT_MAP_TELEPORT, 0);
    }
}
