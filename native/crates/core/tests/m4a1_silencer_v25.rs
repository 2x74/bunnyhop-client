//! Physics v25: the M4A1's silencer (`CWeaponM4A1::SecondaryAttack`, research/WEAPONS.md): +attack2 flips it at once
//! and locks both attacks for v_rif_m4a1.mdl's attach / detach sequence (61 frames at 30 fps = 2.0 s = 200 ticks at 100
//! tick); silenced shots are attack mode 2 (CS:S Secondary_Mode). Before v25 +attack2 does nothing on the M4A1, so
//! v1-v24 runs are unchanged. The USP's (v7) is unchanged by v25.
//! Needs maps/bhop_eazy.bsp (gitignored); skips when absent.

use bunnyhop_core::game::{
    EVENT_ATTACK, IN_ATTACK, IN_ATTACK2, IN_GIVE_MODE, IN_GIVE_RESTORE, IN_GIVE_SHIFT, M4A1_SILENCER_TIME, PHYSICS_V24,
    PHYSICS_V25, USP_SILENCER_TIME, WEAPON_EVENT_SILENCER,
};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

const USP: u32 = 3;
const M4A1: u32 = 18;
/// 200: round(2.0 / 0.01).
const M4A1_TICKS: u32 = 200;
/// 308: round(3.0811 / 0.01).
const USP_TICKS: u32 = 308;

fn give(id: u32) -> u32 {
    id << IN_GIVE_SHIFT
}

fn load(version: u32) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps/bhop_eazy.bsp");
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping: {} not found", path.display());
        return None;
    };
    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("bsp parses");
    let mut game = Game::load(&bsp).expect("game loads");
    game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
    game.reset();
    Some(game)
}

fn step(game: &mut Game, buttons: u32) {
    game.step(Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons }).unwrap();
}

fn idle(game: &mut Game, ticks: u32) {
    for _ in 0..ticks {
        step(game, 0);
    }
}

/// Ticks from now until the first EVENT_ATTACK while `buttons` is held (None within `limit`), and its mode.
fn ticks_to_attack(game: &mut Game, buttons: u32, limit: u32) -> Option<(u32, u8)> {
    for t in 0..limit {
        step(game, buttons);
        if game.events & EVENT_ATTACK != 0 {
            return Some((t, game.attack.map_or(0, |a| a.mode)));
        }
    }
    None
}

#[test]
fn m4a1_silencer_takes_its_css_sequence_length_and_blocks_both_attacks() {
    assert_eq!((M4A1_SILENCER_TIME / 0.01).round() as u32, M4A1_TICKS);
    let Some(mut game) = load(PHYSICS_V25) else { return };
    step(&mut game, give(M4A1));
    idle(&mut game, 120);
    // Attach: the state flips at once, the lock-out starts; the report counts the ticks left after this one.
    step(&mut game, IN_ATTACK2);
    let r = game.weapon_report();
    assert_ne!(r[0] as u32 & WEAPON_EVENT_SILENCER, 0);
    assert_eq!((r[1], r[10], r[11]), (18.0, 1.0, (M4A1_TICKS - 1) as f32));
    // +attack held fires exactly when the lock-out ends, a silenced shot (Secondary_Mode).
    let (t, mode) = ticks_to_attack(&mut game, IN_ATTACK, 400).expect("fires after the attach");
    assert_eq!((t + 1, mode), (M4A1_TICKS, 2));
    assert_eq!(game.attack.unwrap().weapon, 18);
    // Automatic: held fire keeps firing silenced at the cycle time.
    let (t, mode) = ticks_to_attack(&mut game, IN_ATTACK, 50).expect("next round");
    assert_eq!((t + 1, mode), (9, 2));
    // Detach: same length, then plain shots.
    idle(&mut game, 20);
    step(&mut game, IN_ATTACK2);
    assert_eq!(game.weapon_report()[10], 0.0);
    let (t, mode) = ticks_to_attack(&mut game, IN_ATTACK, 400).expect("fires after the detach");
    assert_eq!((t + 1, mode), (M4A1_TICKS, 1));
}

#[test]
fn held_attack2_toggles_again_and_a_switch_keeps_the_new_state() {
    let Some(mut game) = load(PHYSICS_V25) else { return };
    step(&mut game, give(M4A1));
    idle(&mut game, 120);
    let mut toggles = Vec::new();
    for t in 0..450u32 {
        step(&mut game, IN_ATTACK2);
        if game.weapon_report()[0] as u32 & WEAPON_EVENT_SILENCER != 0 {
            toggles.push(t);
        }
    }
    assert_eq!(toggles, vec![0, M4A1_TICKS, 2 * M4A1_TICKS]);
    assert_eq!(game.weapon_report()[10], 1.0, "on (third toggle)");
    // Switching away mid-attach keeps the new state and ends the lock-out; the M4A1 comes back silenced.
    step(&mut game, 3 << 14);
    assert_eq!((game.weapon_report()[1], game.weapon_report()[11]), (1.0, 0.0));
    idle(&mut game, 5);
    step(&mut game, 1 << 14);
    assert_eq!((game.weapon_report()[1], game.weapon_report()[10]), (18.0, 1.0));
}

#[test]
fn v24_m4a1_ignores_attack2_and_runs_are_unchanged() {
    let (Some(mut a), Some(mut b)) = (load(PHYSICS_V24), load(PHYSICS_V24)) else { return };
    step(&mut a, give(M4A1));
    step(&mut b, give(M4A1));
    for t in 0..500u32 {
        let fire = if t % 40 == 0 { IN_ATTACK } else { 0 };
        step(&mut a, fire | if t > 120 { IN_ATTACK2 } else { 0 });
        step(&mut b, fire);
        assert_eq!(a.weapon_report(), b.weapon_report(), "tick {t}");
        assert_eq!((a.events, a.attack.map(|x| x.mode)), (b.events, b.attack.map(|x| x.mode)), "tick {t}");
    }
    assert_eq!(a.weapon_report()[10], 0.0, "no silencer before v25");
    // (The snapshot also holds the buttons, so it isn't compared; v1-v24 identity is tools/verify/wasm-identity.ts.)
    assert_eq!((a.state.position, a.state.velocity), (b.state.position, b.state.velocity));
}

#[test]
fn v25_keeps_the_usp_silencer_as_it_was() {
    assert_eq!((USP_SILENCER_TIME / 0.01).round() as u32, USP_TICKS);
    let Some(mut game) = load(PHYSICS_V25) else { return };
    step(&mut game, give(USP));
    idle(&mut game, 120);
    step(&mut game, IN_ATTACK2);
    assert_eq!(game.weapon_report()[11], (USP_TICKS - 1) as f32);
    let (t, mode) = ticks_to_attack(&mut game, IN_ATTACK, 400).expect("fires after the attach");
    assert_eq!((t + 1, mode), (USP_TICKS, 2));
}

#[test]
fn a_restart_restore_brings_the_m4a1_back_silenced_from_v25() {
    // v10 restore: in the first ticks after a reset, IN_GIVE_RESTORE puts the gun in hand drawn, IN_GIVE_MODE its
    // +attack2 mode on (what the client remembered: weapon-rules.ts takes it from WeaponReport.silencer).
    for (version, silenced) in [(PHYSICS_V24, 0.0), (PHYSICS_V25, 1.0)] {
        let Some(mut game) = load(version) else { return };
        step(&mut game, give(M4A1) | IN_GIVE_RESTORE | IN_GIVE_MODE);
        let r = game.weapon_report();
        assert_eq!((r[1], r[10], r[11]), (18.0, silenced, 0.0), "physics {version}");
        // In hand, ready at once; silenced (v25) shots are mode 2.
        let (t, mode) = ticks_to_attack(&mut game, IN_ATTACK, 20).expect("ready at once");
        assert_eq!((t, mode), (0, if silenced == 1.0 { 2 } else { 1 }), "physics {version}");
    }
}
