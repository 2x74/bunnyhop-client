//! Physics v25: the M4A1's silencer (`CWeaponM4A1::SecondaryAttack`, research/WEAPONS.md): +attack2 flips it at once
//! and locks both attacks for v_rif_m4a1.mdl's attach / detach sequence (61 frames at 30 fps = 2.0 s = 200 ticks at 100
//! tick); silenced shots are attack mode 2 (CS:S Secondary_Mode). Before v25 +attack2 does nothing on the M4A1, so
//! v1-v24 runs are unchanged. The USP's (v7) is unchanged by v25.
//! Interrupted changes (v25, USP too): a switch or drop before the change finishes puts the silencer back
//! (CWeaponUSP / CWeaponM4A1::Holster and ::Drop); v24 keeps the new state as it always did.
//! Needs maps/bhop_eazy.bsp (gitignored); skips when absent.

use bunnyhop_core::game::{
    EVENT_ATTACK, IN_ATTACK, IN_ATTACK2, IN_DROP, IN_GIVE_MODE, IN_GIVE_RESTORE, IN_GIVE_SHIFT, M4A1_SILENCED_RANGE_MODIFIER,
    M4A1_SILENCER_TIME, PHYSICS_V24, PHYSICS_V25, USP_SILENCER_TIME, WEAPON_EVENT_SILENCER, bullet_stats, gun_by_id,
};
use bunnyhop_core::{Cmd, Game, Settings};

const USP: u32 = 3;
const M4A1: u32 = 18;
/// 200: round(2.0 / 0.01).
const M4A1_TICKS: u32 = 200;
/// 308: round(3.0811 / 0.01).
const USP_TICKS: u32 = 308;

fn give(id: u32) -> u32 {
    id << IN_GIVE_SHIFT
}

fn map_bytes() -> Option<Vec<u8>> {
    let path = bunnyhop_core::test_maps::bsp("bhop_eazy");
    let bytes = std::fs::read(&path).ok();
    if bytes.is_none() {
        eprintln!("skipping: {} not found", path.display());
    }
    bytes
}

fn load(version: u32) -> Option<Game> {
    Some(load_bytes(&map_bytes()?, version))
}

fn load_bytes(bytes: &[u8], version: u32) -> Game {
    let bsp = bunnyhop_core::parse_bsp(bytes).expect("bsp parses");
    let mut game = Game::load(&bsp).expect("game loads");
    game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
    game.reset();
    game
}

/// The map with one more entity, `classname` at the spawn (in memory: the entity lump, lump 0, moved to the end).
fn with_map_gun(version: u32, classname: &str) -> Option<Game> {
    let bsp = map_bytes()?;
    let spawn = load_bytes(&bsp, version).state.position;
    let lump = |i: usize| u32::from_le_bytes(bsp[i..i + 4].try_into().unwrap()) as usize;
    let (off, len) = (lump(8), lump(12));
    let old = String::from_utf8_lossy(&bsp[off..off + len]).trim_end_matches('\0').to_string();
    let text = format!("{old}\n{{\n\"classname\" \"{classname}\"\n\"origin\" \"{} {} {}\"\n}}\n\0", spawn[0], spawn[1], spawn[2]);
    let mut bytes = bsp.clone();
    let at = bytes.len() as u32;
    bytes.extend_from_slice(text.as_bytes());
    bytes[8..12].copy_from_slice(&at.to_le_bytes());
    bytes[12..16].copy_from_slice(&(text.len() as u32).to_le_bytes());
    Some(load_bytes(&bytes, version))
}

/// Walks forward (+x, where a drop lands) for `ticks`.
fn walk(game: &mut Game, ticks: u32) {
    for _ in 0..ticks {
        game.step(Cmd { forward: 100.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons: 0 }).unwrap();
    }
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
fn held_attack2_toggles_again_and_a_switch_mid_change_puts_it_back() {
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
    assert_eq!(game.weapon_report()[10], 1.0, "on (third toggle, 50 ticks in)");
    // Switching away mid-attach ends the lock-out and puts the silencer back off (CWeaponM4A1::Holster).
    step(&mut game, 3 << 14);
    assert_eq!((game.weapon_report()[1], game.weapon_report()[11]), (1.0, 0.0));
    idle(&mut game, 5);
    step(&mut game, 1 << 14);
    assert_eq!((game.weapon_report()[1], game.weapon_report()[10]), (18.0, 0.0));
    let (_, mode) = ticks_to_attack(&mut game, IN_ATTACK, 200).expect("fires after the draw");
    assert_eq!(mode, 1);
}

/// Toggles once at `version`, then switches to the knife on the `k`-th command after it (1 = the next one) and back.
fn switch_after(game: &mut Game, k: u32) -> f32 {
    step(game, IN_ATTACK2);
    idle(game, k - 1);
    step(game, 3 << 14);
    idle(game, 5);
    step(game, 1 << 14);
    game.weapon_report()[10]
}

#[test]
fn switching_mid_attach_or_detach_puts_it_back_but_the_completion_tick_keeps_it() {
    if map_bytes().is_none() {
        return;
    }
    let ready = |gun: u32| {
        let mut g = load(PHYSICS_V25).expect("map");
        step(&mut g, give(gun));
        idle(&mut g, 120);
        g
    };
    // Attach interrupted at once and one tick before the end: back off. On the completion tick: kept on.
    for (k, on) in [(1, 0.0), (M4A1_TICKS - 1, 0.0), (M4A1_TICKS, 1.0)] {
        let mut g = ready(M4A1);
        assert_eq!(switch_after(&mut g, k), on, "attach, switch on command {k}");
    }
    // Detach (after a finished attach) interrupted: back on; on the completion tick: kept off.
    for (k, on) in [(1, 1.0), (M4A1_TICKS - 1, 1.0), (M4A1_TICKS, 0.0)] {
        let mut g = ready(M4A1);
        step(&mut g, IN_ATTACK2);
        idle(&mut g, M4A1_TICKS + 10);
        assert_eq!(g.weapon_report()[10], 1.0);
        assert_eq!(switch_after(&mut g, k), on, "detach, switch on command {k}");
    }
}

#[test]
fn the_usp_puts_an_interrupted_change_back_from_v25_only() {
    // v7-v24 keep the new state (unchanged); v25 matches CWeaponUSP::Holster.
    for (version, on) in [(PHYSICS_V24, 1.0), (PHYSICS_V25, 0.0)] {
        let Some(mut g) = load(version) else { return };
        step(&mut g, give(USP));
        idle(&mut g, 120);
        step(&mut g, IN_ATTACK2);
        idle(&mut g, 50);
        step(&mut g, 3 << 14);
        idle(&mut g, 5);
        step(&mut g, 2 << 14);
        assert_eq!(g.weapon_report()[10], on, "physics {version}");
    }
}

#[test]
fn dropping_mid_change_puts_it_back_before_it_hits_the_floor() {
    // A map gun at the spawn (picked up at once), attach, drop on the given command, walk onto it again.
    for (class, gun, ticks) in [("weapon_m4a1", 18.0, M4A1_TICKS), ("weapon_usp", 3.0, USP_TICKS)] {
        for (version, k, on) in [(PHYSICS_V25, 1, 0.0), (PHYSICS_V25, ticks - 1, 0.0), (PHYSICS_V25, ticks, 1.0), (PHYSICS_V24, 1, 1.0)] {
            let Some(mut g) = with_map_gun(version, class) else { return };
            idle(&mut g, 120);
            let r = g.weapon_report();
            if version == PHYSICS_V24 && gun == 18.0 {
                continue; // no M4A1 silencer before v25
            }
            assert_eq!(r[1], gun, "{class} picked up");
            step(&mut g, IN_ATTACK2);
            idle(&mut g, k - 1);
            step(&mut g, IN_DROP);
            assert_ne!(g.weapon_report()[1], gun, "{class} dropped");
            idle(&mut g, 101);
            walk(&mut g, 30);
            let r = g.weapon_report();
            assert_eq!((r[1], r[10]), (gun, on), "{class} physics {version}, drop on command {k}");
        }
    }
}

#[test]
fn a_restart_mid_attach_restores_what_the_client_remembered() {
    // CS:S keeps the gun drawn over !r (no holster), so the change isn't put back: the client remembers the weapon
    // report's state (on, mid-attach) and the restore gives it back on, ready at once.
    let Some(mut game) = load(PHYSICS_V25) else { return };
    step(&mut game, give(M4A1));
    idle(&mut game, 120);
    step(&mut game, IN_ATTACK2);
    idle(&mut game, 40);
    let remembered = game.weapon_report()[10] == 1.0;
    assert!(remembered);
    game.reset();
    step(&mut game, give(M4A1) | IN_GIVE_RESTORE | if remembered { IN_GIVE_MODE } else { 0 });
    let r = game.weapon_report();
    assert_eq!((r[1], r[10], r[11]), (18.0, 1.0, 0.0));
    let (t, mode) = ticks_to_attack(&mut game, IN_ATTACK, 20).expect("ready at once");
    assert_eq!((t, mode), (0, 2));
}

#[test]
fn secondary_mode_bullet_stats_from_v25() {
    // (The damage itself through the fire path: tests/secondary_mode_damage_v25.rs.)
    let [m4, usp, glock, famas] = [18, 3, 2, 16].map(|id| gun_by_id(id).expect("gun"));
    assert_eq!(bullet_stats(m4, true, PHYSICS_V25), (33.0, M4A1_SILENCED_RANGE_MODIFIER));
    assert_eq!(bullet_stats(m4, false, PHYSICS_V25), (33.0, 0.97));
    assert_eq!(bullet_stats(m4, true, PHYSICS_V24), (33.0, 0.97), "older versions keep the script's");
    assert_eq!(bullet_stats(usp, true, PHYSICS_V25), (30.0, usp.range_modifier));
    assert_eq!(bullet_stats(usp, true, PHYSICS_V24), (34.0, usp.range_modifier));
    assert_eq!(bullet_stats(glock, true, PHYSICS_V25), (18.0, 0.9));
    assert_eq!(bullet_stats(glock, false, PHYSICS_V25), (25.0, 0.75));
    assert_eq!(bullet_stats(glock, true, PHYSICS_V24), (25.0, 0.75));
    assert_eq!(bullet_stats(famas, true, PHYSICS_V25), (famas.damage, famas.range_modifier), "the FAMAS burst: no override");
    // At 500 units a 32-health breakable: one silenced M4A1 shot no longer breaks it (33 * 0.95 = 31.35).
    let at500 = |(d, rm): (f32, f32)| d * rm.powf(500.0 / 500.0);
    assert!(at500(bullet_stats(m4, true, PHYSICS_V25)) < 32.0);
    assert!(at500(bullet_stats(m4, false, PHYSICS_V25)) >= 32.0);
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
