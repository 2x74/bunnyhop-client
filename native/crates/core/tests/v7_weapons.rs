//! Physics v7 (research/WEAPONS.md): weapon commands (bhoptimer's sm_usp / sm_glock / sm_knife, shavit-misc.sp
//! `Command_Weapon`: replace the slot's weapon, give it with a full clip, switch to it; one per 10 ticks) as a one-tick
//! give request in buttons bits 16..20, and the USP's silencer (CWeaponUSP::SecondaryAttack: +attack2 flips it and locks
//! both attacks for the v_pist_usp.mdl attach / detach sequence, 114 / 37 s = 308 ticks at 100 tick). v6 ignores both.
//! Needs maps/bhop_eazy.bsp and maps/bhop_badges.bsp (gitignored); skips when absent.

use bunnyhop_core::game::{
    EVENT_ATTACK, IN_ATTACK, IN_ATTACK2, IN_DROP, IN_GIVE_SHIFT, IN_RELOAD, PHYSICS_V6, PHYSICS_V7, USP_SILENCER_TIME,
    WEAPON_COMMAND_COOLDOWN, WEAPON_EVENT_GIVEN, WEAPON_EVENT_SILENCER, WEAPON_EVENT_SWITCHED,
};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

const KNIFE: u32 = 1;
const GLOCK: u32 = 2;
const USP: u32 = 3;
const AK47: u32 = 17;
const AWP: u32 = 22;
/// 308: round(3.0811 / 0.01).
const SILENCER_TICKS: u32 = 308;

fn give(id: u32) -> u32 {
    id << IN_GIVE_SHIFT
}

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

fn step(game: &mut Game, buttons: u32) {
    game.step(Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons }).unwrap();
}

fn idle(game: &mut Game, ticks: u32) {
    for _ in 0..ticks {
        step(game, 0);
    }
}

/// [flags, active, primary, secondary, knife, clip, clip size, reload ticks, burst, floor changed, silencer, silencer ticks]
fn report(game: &Game) -> [f32; 12] {
    game.weapon_report()
}

/// Ticks from now until the first EVENT_ATTACK while `buttons` is held (None within `limit`).
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
fn usp_command_gives_draws_and_fires() {
    let Some(mut game) = load("bhop_eazy", PHYSICS_V7) else { return };
    idle(&mut game, 5);
    assert_eq!(report(&game)[1], 1.0, "spawn: the knife");
    step(&mut game, give(USP));
    let r = report(&game);
    assert_eq!(r[0] as u32 & (WEAPON_EVENT_GIVEN | WEAPON_EVENT_SWITCHED), WEAPON_EVENT_GIVEN | WEAPON_EVENT_SWITCHED);
    assert_eq!((r[1], r[3], r[4], r[5], r[6]), (3.0, 3.0, 1.0, 12.0, 12.0), "USP out, full clip, knife kept");
    // "use weapon_usp" is a deploy: 1 s before the first shot (the command tick counts as the first).
    let (t, mode) = ticks_to_attack(&mut game, IN_ATTACK, 200).expect("fires after the draw");
    assert_eq!((t, mode), (99, 1));
    assert_eq!(game.attack.unwrap().weapon, 3);
    assert_eq!(report(&game)[5], 11.0);
}

#[test]
fn commands_replace_the_slot_and_have_a_10_tick_cooldown() {
    let Some(mut game) = load("bhop_eazy", PHYSICS_V7) else { return };
    step(&mut game, give(USP));
    // 9 ticks later: ignored (bhoptimer `GetGameTickCount() - last < 10`).
    idle(&mut game, WEAPON_COMMAND_COOLDOWN - 2);
    step(&mut game, give(GLOCK));
    assert_eq!(report(&game)[3], 3.0, "within the cooldown: still the USP");
    step(&mut game, give(GLOCK));
    let r = report(&game);
    assert_eq!((r[1], r[3], r[5]), (2.0, 2.0, 20.0), "10 ticks after the last accepted command: the Glock replaced it");
    // A primary goes to its own slot and is drawn; the Glock stays in the secondary slot.
    idle(&mut game, 9);
    step(&mut game, give(AK47));
    let r = report(&game);
    assert_eq!((r[1], r[2], r[3]), (17.0, 17.0, 2.0));
    idle(&mut game, 9);
    step(&mut game, give(AWP));
    assert_eq!(report(&game)[2], 22.0, "replaces the AK");
    // !knife with the knife in the slot: a fresh knife, drawn.
    idle(&mut game, 9);
    step(&mut game, give(KNIFE));
    let r = report(&game);
    assert_eq!((r[1], r[2], r[3], r[4]), (1.0, 22.0, 2.0, 1.0));
    // Unknown ids (0 = none, 26..31) do nothing, not even the cooldown.
    idle(&mut game, 9);
    step(&mut game, give(26));
    step(&mut game, give(USP));
    assert_eq!(report(&game)[3], 3.0);
}

#[test]
fn a_given_gun_reloads_like_a_map_gun_and_vanishes_on_drop() {
    let Some(mut game) = load("bhop_eazy", PHYSICS_V7) else { return };
    step(&mut game, give(GLOCK));
    idle(&mut game, 100);
    for _ in 0..5 {
        step(&mut game, IN_ATTACK);
        idle(&mut game, 20);
    }
    assert_eq!(report(&game)[5], 15.0);
    step(&mut game, IN_RELOAD);
    assert!(report(&game)[7] > 0.0, "reloading");
    idle(&mut game, 230);
    assert_eq!(report(&game)[5], 20.0, "full clip; the reserve is infinite");
    step(&mut game, IN_DROP);
    let r = report(&game);
    assert_eq!((r[1], r[3]), (1.0, 0.0), "dropped (gone: no map entity), back to the knife");
}

#[test]
fn v6_ignores_weapon_commands_and_the_silencer() {
    let (Some(mut v6), Some(mut plain)) = (load("bhop_eazy", PHYSICS_V6), load("bhop_eazy", PHYSICS_V6)) else { return };
    for t in 0..400u32 {
        let extra = if t % 37 == 0 { give(USP) } else { 0 } | if t > 200 { IN_ATTACK2 } else { 0 };
        step(&mut v6, extra);
        step(&mut plain, if t > 200 { IN_ATTACK2 } else { 0 });
        assert_eq!(v6.weapon_report(), plain.weapon_report(), "tick {t}");
        assert_eq!(v6.state.position, plain.state.position);
    }
    assert_eq!(v6.weapon_report()[1], 1.0, "still the knife");
}

#[test]
fn silencer_takes_the_css_sequence_length_and_blocks_both_attacks() {
    assert_eq!((USP_SILENCER_TIME / 0.01).round() as u32, SILENCER_TICKS);
    let Some(mut game) = load("bhop_eazy", PHYSICS_V7) else { return };
    step(&mut game, give(USP));
    idle(&mut game, 120);
    // Attach: the state flips at once (m_bSilencerOn), the lock-out starts.
    step(&mut game, IN_ATTACK2);
    let r = report(&game);
    assert_ne!(r[0] as u32 & WEAPON_EVENT_SILENCER, 0);
    // Ticks left after this one (like the reload ticks): the 308th command from the toggle is the first that can fire.
    assert_eq!((r[10], r[11]), (1.0, (SILENCER_TICKS - 1) as f32));
    // +attack held from the next tick fires exactly when the lock-out ends, a silenced shot (Secondary_Mode).
    let (t, mode) = ticks_to_attack(&mut game, IN_ATTACK, 400).expect("fires after the attach");
    assert_eq!((t + 1, mode), (SILENCER_TICKS, 2));
    assert_eq!(report(&game)[11], 0.0);
    // Detach: same length; then plain shots again.
    idle(&mut game, 20);
    step(&mut game, IN_ATTACK2);
    assert_eq!(report(&game)[10], 0.0);
    let (t, mode) = ticks_to_attack(&mut game, IN_ATTACK, 400).expect("fires after the detach");
    assert_eq!((t + 1, mode), (SILENCER_TICKS, 1));
}

#[test]
fn silencer_waits_for_reloads_and_draws_and_is_per_weapon() {
    let Some(mut game) = load("bhop_eazy", PHYSICS_V7) else { return };
    step(&mut game, give(USP));
    // During the draw: nothing.
    step(&mut game, IN_ATTACK2);
    assert_eq!(report(&game)[10], 0.0, "no toggle while drawing");
    idle(&mut game, 120);
    step(&mut game, IN_ATTACK);
    idle(&mut game, 20);
    step(&mut game, IN_RELOAD);
    step(&mut game, IN_ATTACK2);
    assert_eq!(report(&game)[10], 0.0, "no toggle while reloading");
    idle(&mut game, 300);
    // Held +attack2 toggles again when the lock-out ends (CS:S keeps attaching / detaching).
    let mut toggles = Vec::new();
    for t in 0..700u32 {
        step(&mut game, IN_ATTACK2);
        if report(&game)[0] as u32 & WEAPON_EVENT_SILENCER != 0 {
            toggles.push(t);
        }
    }
    assert_eq!(toggles, vec![0, SILENCER_TICKS, 2 * SILENCER_TICKS]);
    assert_eq!(report(&game)[10], 1.0);
    // Switching away mid-attach keeps the new state; the USP comes back silenced, the lock-out gone.
    step(&mut game, 3 << 14); // slot 3: the knife
    assert_eq!((report(&game)[1], report(&game)[11]), (1.0, 0.0));
    idle(&mut game, 5);
    step(&mut game, 2 << 14);
    assert_eq!((report(&game)[1], report(&game)[10]), (3.0, 1.0));
    // A new USP from the command has its silencer off; the Glock's +attack2 is still its burst toggle.
    idle(&mut game, 20);
    step(&mut game, give(USP));
    assert_eq!(report(&game)[10], 0.0);
    idle(&mut game, 20);
    step(&mut game, give(GLOCK));
    idle(&mut game, 120);
    step(&mut game, IN_ATTACK2);
    let r = report(&game);
    assert_eq!((r[8], r[10], r[11]), (1.0, 0.0, 0.0), "Glock: burst on, no silencer");
}

#[test]
fn state_bytes_of_runs_without_the_new_features_are_unchanged() {
    // The v7 inventory fields only reach snapshot_bytes once used, so v1-v6 state bytes stay as they were.
    let (Some(mut a), Some(mut b)) = (load("bhop_eazy", PHYSICS_V6), load("bhop_eazy", PHYSICS_V7)) else { return };
    for _ in 0..50 {
        step(&mut a, IN_ATTACK);
        step(&mut b, IN_ATTACK);
    }
    assert_eq!(a.snapshot_bytes(), b.snapshot_bytes());
    step(&mut b, give(USP));
    step(&mut a, give(USP));
    assert_ne!(a.snapshot_bytes(), b.snapshot_bytes());
}

#[test]
fn badges_usp_command_shoots_the_first_pad() {
    // bhop_badges runs on bhop servers take the USP with !usp from level 2 on (research/maps/badges-real-replays.md).
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps/bhop_badges.bsp");
    if !path.exists() {
        eprintln!("skipping: {} not found", path.display());
        return;
    }
    let mut game = bunnyhop_core::content::load_game(&path).expect("map loads");
    game.set_settings(Settings { physics_version: PHYSICS_V7, ..Settings::css_bhop() });
    game.reset();
    step(&mut game, give(USP));
    idle(&mut game, 150);
    assert_eq!(game.weapon_report()[1], 3.0);
    game.place_player([3200.0, -6336.0, -13700.0]);
    let mut pushed = None;
    for i in 0..120 {
        let buttons = if i == 10 { IN_ATTACK } else { 0 };
        game.step(Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 89.0, buttons }).unwrap();
        if pushed.is_none() && game.state.base_velocity[2] > 0.0 {
            pushed = Some(i);
        }
    }
    assert_eq!(pushed, Some(16), "v7 keeps v6's pads: the first hit boosts (upboost after command 16)");
}
