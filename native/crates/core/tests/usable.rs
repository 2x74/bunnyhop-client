//! +use (IN_USE) on the real maps it matters for. Maps (gitignored) and the content cache's collision models are
//! needed; each test skips when its map is absent. Timings are the real engine's (tools/parity `ivyuse2`).

use bunnyhop_core::{
    Cmd, Game, Settings,
    game::{IN_ATTACK, IN_JUMP, IN_USE, PHYSICS_LATEST},
};
use std::path::PathBuf;

fn load(name: &str) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    if !path.exists() {
        eprintln!("skipping {name}: {} not found", path.display());
        return None;
    }
    Some(bunnyhop_core::content::load_game(&path).expect("map loads"))
}

fn entity(game: &Game, name: &str) -> usize {
    game.entities.iter().position(|e| e.get("targetname") == Some(name)).expect("entity exists")
}

const IVY_START: [f32; 3] = [-140.742, -4266.41, -1180.0];
const IVY_YAW: f32 = 297.8;

/// Stands at bhop_ivy_final's fail31 destination facing door_01, presses +use on tick 5, waits, then walks through
/// the doorway. Returns the door's yaw after every tick and the game.
fn ivy_door_run(ticks: usize, use_tick: usize, walk_from: usize) -> Option<(Vec<f32>, Game)> {
    let mut game = load("bhop_ivy_final")?;
    let door = entity(&game, "door_01");
    game.place_player(IVY_START);
    let mut yaws = Vec::new();
    for t in 0..ticks {
        let buttons = if t == use_tick { IN_USE } else { 0 };
        let forward = if t >= walk_from && t < walk_from + 120 { 450.0 } else { 0.0 };
        game.step(Cmd { forward, side: 0.0, yaw: IVY_YAW, pitch: 0.0, buttons }).expect("step");
        yaws.push(game.entity_transform(door).unwrap().1[1]);
    }
    Some((yaws, game))
}

#[test]
fn ivy_door_opens_on_use_like_the_engine() {
    let Some((yaws, _)) = ivy_door_run(1400, 5, 126) else { return };
    // Engine (ivyuse2): first rotation in the frame of command 40, 1 deg per tick away from the player
    // (270 -> 180), fully open after command 129; auto-closes 10.1 s later (commands 1141..1230).
    assert_eq!(yaws[39], 270.0, "still closed during the open animation");
    assert_eq!(yaws[40], 269.0);
    assert_eq!(yaws[129], 180.0);
    assert_eq!(yaws[1140], 180.0);
    assert_eq!(yaws[1141], 181.0);
    assert_eq!(yaws[1230], 270.0);
}

#[test]
fn ivy_door_needs_a_fresh_press_and_blocks_when_closed() {
    let Some(mut game) = load("bhop_ivy_final") else { return };
    let door = entity(&game, "door_01");
    game.place_player(IVY_START);
    // Walking into the closed door: it stops the player.
    for _ in 0..150 {
        game.step(Cmd { forward: 450.0, side: 0.0, yaw: IVY_YAW, pitch: 0.0, buttons: 0 }).unwrap();
    }
    let y = game.state.position[1];
    assert!(y > -4332.0 + 15.0, "the closed door blocks the player (y {y})");
    assert_eq!(game.entity_transform(door).unwrap().1[1], 270.0);
    // Holding +use from a press opens it once (IMPULSE_USE: the press edge only).
    for _ in 0..200 {
        game.step(Cmd { forward: 0.0, side: 0.0, yaw: IVY_YAW, pitch: 0.0, buttons: IN_USE }).unwrap();
    }
    assert_eq!(game.entity_transform(door).unwrap().1[1], 180.0, "opened");
    // Walk through.
    for _ in 0..80 {
        game.step(Cmd { forward: 450.0, side: 0.0, yaw: IVY_YAW, pitch: 0.0, buttons: IN_USE }).unwrap();
    }
    assert!(game.state.position[1] < -4340.0, "walked through the open doorway (y {})", game.state.position[1]);
}

#[test]
fn ivy_use_is_deterministic() {
    let run = || {
        let (_, mut game) = ivy_door_run(600, 5, 130)?;
        // Some hops for good measure.
        for t in 0..300 {
            let buttons = if t % 40 < 2 { IN_JUMP } else { 0 } | if t % 97 == 0 { IN_USE } else { 0 };
            game.step(Cmd { forward: 0.0, side: if t % 60 < 30 { 450.0 } else { -450.0 }, yaw: 200.0 + t as f32, pitch: 10.0, buttons }).unwrap();
        }
        Some(game.snapshot_bytes())
    };
    let (Some(a), Some(b)) = (run(), run()) else { return };
    assert_eq!(a, b);
}

/// kz_bhop_yonkoma's falling rock (spawn hub): stepping on it fires EnableMotion; it drops onto its pillars, then
/// falls when they break (real engine: tools/parity `yk_rock`, rests 54u lower after ~0.4 s, falls at ~3.5 s).
fn yonkoma_rock_run() -> Option<(Vec<f32>, Game)> {
    let mut game = load("kz_bhop_yonkoma")?;
    let rock = game
        .entities
        .iter()
        .position(|e| e.get("targetname") == Some("fallrock1") && e.get("origin") == Some("-7568 6688 -9088"))
        .expect("fallrock1");
    game.place_player([-7568.0, 6688.0, -9030.0]);
    let mut z = Vec::new();
    for t in 0..700 {
        let buttons = if t % 90 == 0 { IN_USE } else { 0 };
        game.step(Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons }).unwrap();
        z.push(game.entity_transform(rock).unwrap().0[2]);
    }
    Some((z, game))
}

#[test]
fn yonkoma_rock_falls_and_is_deterministic() {
    let Some((z, a)) = yonkoma_rock_run() else { return };
    assert_eq!(z[20], -9088.0, "motion disabled until touched");
    assert!(z[120] < -9100.0 && z[120] == z[200], "dropped onto its pillars and rests ({})", z[120]);
    assert!(z[600] < -9900.0, "falls once the pillars break ({})", z[600]);
    let (_, b) = yonkoma_rock_run().unwrap();
    assert_eq!(a.snapshot_bytes(), b.snapshot_bytes());
}

/// kz_bhop_yonkoma's crane lever (func_rot_button, +use activates, roll 45 deg at 32 deg/s, stays pressed).
#[test]
fn yonkoma_lever_rotates_on_use() {
    let Some(mut game) = load("kz_bhop_yonkoma") else { return };
    let lever = game.entities.iter().position(|e| e.get("origin") == Some("-10474 4544 -9476") && e.classname() == "func_rot_button");
    let lever = lever.expect("lever");
    game.place_player([-10520.0, 4544.0, -9470.0]);
    for t in 0..300 {
        let buttons = if t == 50 { IN_USE } else { 0 };
        game.step(Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 30.0, buttons }).unwrap();
    }
    let a = game.entity_transform(lever).unwrap().1;
    assert!((a[2].abs() - 45.0).abs() < 0.01, "lever rolled 45 degrees ({a:?})");
}

/// bhop_badges2's start boost (player report 2026-10-12, "can't press boost button at the start"): func_button *272
/// (spawnflags 1025: don't move + use activates, on the pit room's south wall at x -3302, y -3376..-3372,
/// z -848..-832) fires `!activator,AddOutput,targetname rand1`; trigger_push *425 (filter rand1, 1200 up, the whole
/// pit) lifts the player to the ceiling and trigger_push *275 (filter rand1, 200 west, z -568..-496) carries them
/// through the exit hole onto stage 1 (floor -568 past x -3584). +use only, like CS:S: +attack does nothing, and the
/// button must be within PLAYER_USE_RADIUS (80u from the eye), so it can't be pressed from across the room.
#[test]
fn badges2_start_boost_button() {
    let Some(mut game) = load("bhop_badges2") else { return };
    game.set_settings(Settings { physics_version: PHYSICS_LATEST, ..Settings::css_bhop() });
    // Facing the button (yaw 270) from `y`, press `buttons` once; the player's name after the event queue runs.
    let press = |game: &mut Game, y: f32, buttons: u32| {
        game.reset();
        game.place_player([-3302.0, y, -895.0]);
        for t in 0..20 {
            game.step(Cmd { forward: 0.0, side: 0.0, yaw: 270.0, pitch: 0.0, buttons: if t == 10 { buttons } else { 0 } }).unwrap();
        }
        game.player_name.clone()
    };
    assert_eq!(press(&mut game, -3200.0, IN_USE), "", "out of +use reach (~170u from the button)");
    assert_eq!(press(&mut game, -3330.0, IN_ATTACK), "", "+attack doesn't press a use-only button");
    assert_eq!(press(&mut game, -3330.0, IN_USE), "rand1", "+use presses it");
    // Ride the push to the ceiling, step north into the westward push, land on stage 1.
    for t in 0..300 {
        let forward = if (120..145).contains(&t) { 450.0 } else { 0.0 };
        game.step(Cmd { forward, side: 0.0, yaw: 90.0, pitch: 0.0, buttons: 0 }).unwrap();
    }
    let p = game.state.position;
    assert!(p[0] < -3600.0 && (p[2] + 568.0).abs() < 1.0 && game.state.ground.is_some(), "landed on stage 1 ({p:?})");
}
