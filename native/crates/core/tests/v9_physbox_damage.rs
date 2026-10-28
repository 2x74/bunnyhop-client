//! Physics v9 (`PHYSICS_FIX_PHYSBOX_DAMAGE`, fix bit 17): weapon damage on func_physbox / func_physbox_multiplayer.
//!
//! bhop_tesquo_v2's neon stage (feedback 8u1AHE2cIW_SQzqY, 2026-10-09: "booster doesnt work on neon part") is a climb of
//! shot boosters. A trigger_multiple over each platform names the player `canshoot` (StartTouch, and again 0.55 s later;
//! EndTouch names them `default`); the platform is a motion-disabled func_physbox (the first three) or
//! func_physbox_multiplayer (the rest, lying on a world floor; players walk through those) with `damagefilter canshoot`
//! (a filter_activator_name) and OnDamaged `!activator,AddOutput,gravity -0.8` (-0.9 .. -2.5 on later ones), `gravity 1`
//! 0.5 s later, and `targetname default` / `canshoot` 0.5 s later so one hit boosts once. Trigger *64 at the stage
//! entrance strips the player and hands out a Glock. In CS:S (`CPhysBox::OnTakeDamage`) a shot or knife hit fires
//! OnDamaged with the attacker as activator once `CBaseEntity::TakeDamage`'s damage filter passes; bullets trace with
//! COLLISION_GROUP_NONE, which hits COLLISION_GROUP_PUSHAWAY physboxes. Up to v8 weapon damage only reached func_button
//! and func_breakable and shots went through func_physbox_multiplayer, so no booster ever fired and the stage could not
//! be climbed. v9 fires them.
//!
//! Needs maps/bhop_tesquo_v2.bsp (gitignored); skips when absent.

use bunnyhop_core::game::{IN_ATTACK, IN_JUMP, PHYSICS_FIX_PHYSBOX_DAMAGE, PHYSICS_V8, PHYSICS_V9, physics_fixes};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

fn load(version: u32) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps/bhop_tesquo_v2.bsp");
    if !path.exists() {
        eprintln!("skipping: {} not found", path.display());
        return None;
    }
    let mut g = bunnyhop_core::content::load_game(&path).expect("map loads");
    g.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
    g.reset();
    Some(g)
}

/// Entity index of the brush entity with `model`.
fn model_entity(g: &Game, model: &str) -> i32 {
    g.entities.iter().position(|e| e.get("model") == Some(model)).expect("model") as i32
}

fn cmd(pitch: f32, buttons: u32) -> Cmd {
    Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch, buttons }
}

/// Picks up the stage's Glock (strip + equip trigger *64 at the entrance) and lets it deploy.
fn with_glock(version: u32) -> Option<Game> {
    let mut g = load(version)?;
    g.place_player([2584.0, 984.0, 4090.0]);
    for _ in 0..150 {
        g.step(cmd(0.0, 0)).unwrap();
    }
    assert_eq!(g.weapon_report()[1], 2.0, "holding the Glock");
    Some(g)
}

struct Boost {
    /// Highest feet z reached over the run.
    top: f32,
    /// Gravity scale after each command.
    gravity: Vec<f32>,
    /// The entity the shot hit (-1: the world or nothing).
    hit: i32,
}

/// Stands at `at` (above a booster platform, or anywhere), shoots straight down and jumps on the next command.
fn shoot_and_jump(g: &mut Game, at: [f32; 3]) -> Boost {
    g.place_player(at);
    for _ in 0..30 {
        g.step(cmd(89.0, 0)).unwrap();
    }
    assert!(g.state.ground.is_some(), "standing at {at:?}");
    let start = g.state.position[2];
    let (mut top, mut gravity, mut hit) = (start, Vec::new(), -1);
    for i in 0..200 {
        let buttons = match i {
            0 => IN_ATTACK,
            1 => IN_JUMP,
            _ => 0,
        };
        g.step(cmd(89.0, buttons)).unwrap();
        if i == 0 {
            hit = g.attack.map_or(-1, |a| a.entity);
        }
        gravity.push(g.gravity_scale);
        top = top.max(g.state.position[2]);
    }
    Boost { top: top - start, gravity, hit }
}

#[test]
fn v9_is_v8_plus_physbox_damage() {
    assert_eq!(physics_fixes(PHYSICS_V9), Some(physics_fixes(PHYSICS_V8).unwrap() | PHYSICS_FIX_PHYSBOX_DAMAGE));
    assert_eq!(physics_fixes(PHYSICS_V8).unwrap() & PHYSICS_FIX_PHYSBOX_DAMAGE, 0);
}

/// The first booster: func_physbox *53 (2736 1224, top z 4056), solid, `gravity -0.8` for 0.5 s.
#[test]
fn physbox_booster() {
    let at = [2736.0, 1224.0, 4060.0];
    let Some(mut v8) = with_glock(PHYSICS_V8) else { return };
    let b = shoot_and_jump(&mut v8, at);
    eprintln!("v8 *53: hit {} rise {:.1}", b.hit, b.top);
    assert_eq!(b.hit, model_entity(&v8, "*53"), "v8: the shot hits the platform");
    assert!(b.gravity.iter().all(|&s| s == 1.0), "v8: no boost");
    assert!(b.top < 60.0, "v8: a plain jump ({:.1})", b.top);

    let mut v9 = with_glock(PHYSICS_V9).unwrap();
    let b = shoot_and_jump(&mut v9, at);
    assert_eq!(b.hit, model_entity(&v9, "*53"));
    let boosted: Vec<usize> = (0..b.gravity.len()).filter(|&i| b.gravity[i] < 0.0).collect();
    eprintln!("v9 *53: hit {} rise {:.1} boosted {:?}..{:?}", b.hit, b.top, boosted.first(), boosted.last());
    assert!(b.gravity.iter().any(|&s| s == -0.8), "v9: gravity -0.8");
    // 0.5 s of -0.8 gravity, then back to 1 (AddOutput delays 0 and 0.5).
    assert_eq!(boosted.len(), 50);
    assert_eq!(*b.gravity.last().unwrap(), 1.0);
    // The next platform (*137) is 240 units up.
    assert!(b.top > 400.0, "v9: boosted ({:.1})", b.top);
}

/// A func_physbox_multiplayer booster: *56 (2680 456, z 4552..4568 on a world floor at 4552), `gravity -0.9`.
#[test]
fn physbox_multiplayer_booster() {
    let at = [2680.0, 456.0, 4556.0];
    let Some(mut v8) = with_glock(PHYSICS_V8) else { return };
    let b = shoot_and_jump(&mut v8, at);
    eprintln!("v8 *56: rise {:.1}", b.top);
    assert_eq!(b.hit, -1, "v8: the shot goes through the physbox to the world floor");
    assert!(b.gravity.iter().all(|&s| s == 1.0), "v8: the shot goes through it");

    let mut v9 = with_glock(PHYSICS_V9).unwrap();
    let b = shoot_and_jump(&mut v9, at);
    eprintln!("v9 *56: rise {:.1}", b.top);
    assert_eq!(b.hit, model_entity(&v9, "*56"), "v9: the shot hits the physbox");
    assert!(b.gravity.iter().any(|&s| s == -0.9), "v9: gravity -0.9");
    // Up the shaft to its ceiling (the trigger above the platform reaches z 4888).
    assert!(b.top > 280.0, "v9: boosted ({:.1})", b.top);
}

/// The damage filter: a player who isn't `canshoot` (off the platform, where the feedback's player stood) gets nothing.
#[test]
fn only_the_player_on_the_platform_is_boosted() {
    let Some(mut g) = with_glock(PHYSICS_V9) else { return };
    // Next to *53, outside its trigger, shooting the platform's edge.
    g.place_player([2914.0, 1100.0, 4060.0]);
    for _ in 0..30 {
        g.step(cmd(0.0, 0)).unwrap();
    }
    assert_ne!(g.player_name, "canshoot");
    // Aim at the platform's top (x 2592..2880, y 1120..1328, z 4056) from the eye.
    let eye = [g.state.position[0], g.state.position[1], g.state.position[2] + g.state.view_offset[2]];
    let d = [2860.0 - eye[0], 1140.0 - eye[1], 4055.0 - eye[2]];
    let pitch = (-d[2]).atan2((d[0] * d[0] + d[1] * d[1]).sqrt()).to_degrees();
    let yaw = d[1].atan2(d[0]).to_degrees();
    g.step(Cmd { forward: 0.0, side: 0.0, yaw, pitch, buttons: IN_ATTACK }).unwrap();
    assert_eq!(g.attack.map(|a| a.entity), Some(model_entity(&g, "*53")), "the shot hits the platform");
    for _ in 0..60 {
        g.step(cmd(0.0, 0)).unwrap();
        assert_eq!(g.gravity_scale, 1.0, "filtered: no boost");
    }
}
