//! Physics v10 (research/WEAPONS.md "Weapon commands"): a restart keeps the guns in hand. The client re-gives the guns
//! the player had on the first commands after a restart with `IN_GIVE_RESTORE` (and `IN_GIVE_MODE` for a silenced USP
//! or a Glock / FAMAS in burst mode); within `WEAPON_RESTORE_TICKS` of the reset the gun is in hand without the draw, in
//! that mode, with no silencer lock-out. Later, or before v10, the flags change nothing.
//! Needs maps/bhop_eazy.bsp (gitignored); skips when absent.

use bunnyhop_core::game::{
    EVENT_ATTACK, IN_ATTACK, IN_ATTACK2, IN_GIVE_MODE, IN_GIVE_RESTORE, IN_GIVE_SHIFT, PHYSICS_V9, PHYSICS_V10,
    WEAPON_COMMAND_COOLDOWN, WEAPON_EVENT_GIVEN, WEAPON_EVENT_PICKED_UP, WEAPON_EVENT_RESTORED, WEAPON_EVENT_SILENCER,
    WEAPON_EVENT_SWITCHED, WEAPON_RESTORE_TICKS,
};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

const GLOCK: u32 = 2;
const USP: u32 = 3;
const AK47: u32 = 17;
const SILENCER_TICKS: u32 = 308;

fn give(id: u32) -> u32 {
    id << IN_GIVE_SHIFT
}

fn restore(id: u32, mode: bool) -> u32 {
    give(id) | IN_GIVE_RESTORE | if mode { IN_GIVE_MODE } else { 0 }
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

/// Ticks from now until the first EVENT_ATTACK while `buttons` is held, and its mode.
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
fn a_restored_usp_is_in_hand_with_its_silencer_as_it_was() {
    let Some(mut game) = load(PHYSICS_V10) else { return };
    step(&mut game, restore(USP, true));
    let r = game.weapon_report();
    let flags = r[0] as u32;
    assert_eq!(flags & (WEAPON_EVENT_GIVEN | WEAPON_EVENT_RESTORED), WEAPON_EVENT_GIVEN | WEAPON_EVENT_RESTORED);
    assert_eq!(flags & (WEAPON_EVENT_SWITCHED | WEAPON_EVENT_PICKED_UP | WEAPON_EVENT_SILENCER), 0, "no draw, pickup or attach");
    assert_eq!((r[1], r[3], r[5], r[10], r[11]), (3.0, 3.0, 12.0, 1.0, 0.0), "USP out, full clip, silencer on, no lock-out");
    // Already drawn: +attack from the next command fires at once, a silenced shot.
    assert_eq!(ticks_to_attack(&mut game, IN_ATTACK, 10), Some((0, 2)));
    // Detaching it works like any silenced USP: the full lock-out, then plain shots.
    idle(&mut game, 20);
    step(&mut game, IN_ATTACK2);
    assert_eq!(game.weapon_report()[10], 0.0);
    let (t, mode) = ticks_to_attack(&mut game, IN_ATTACK, 400).expect("fires after the detach");
    assert_eq!((t + 1, mode), (SILENCER_TICKS, 1));

    // Restored without IN_GIVE_MODE: the silencer stays off.
    game.reset();
    step(&mut game, restore(USP, false));
    let r = game.weapon_report();
    assert_eq!((r[1], r[10]), (3.0, 0.0));
    assert_eq!(ticks_to_attack(&mut game, IN_ATTACK, 10), Some((0, 1)));
}

#[test]
fn restored_guns_keep_burst_mode_and_the_last_one_is_in_hand() {
    let Some(mut game) = load(PHYSICS_V10) else { return };
    // Practice: the AK-47 and a burst-mode Glock, one per cooldown like the client's KeptWeapons.
    step(&mut game, restore(AK47, false));
    idle(&mut game, WEAPON_COMMAND_COOLDOWN - 1);
    step(&mut game, restore(GLOCK, true));
    let r = game.weapon_report();
    assert_eq!((r[1], r[2], r[3], r[8]), (2.0, 17.0, 2.0, 1.0), "Glock in hand in burst mode, the AK in its slot");
    assert_ne!(r[0] as u32 & WEAPON_EVENT_RESTORED, 0);
    assert_eq!(ticks_to_attack(&mut game, IN_ATTACK, 10).map(|(t, _)| t), Some(0));
}

#[test]
fn a_restore_late_in_the_attempt_is_an_ordinary_command() {
    let Some(mut game) = load(PHYSICS_V10) else { return };
    idle(&mut game, WEAPON_RESTORE_TICKS);
    step(&mut game, restore(USP, true));
    let r = game.weapon_report();
    assert_eq!(r[0] as u32 & (WEAPON_EVENT_SWITCHED | WEAPON_EVENT_RESTORED), WEAPON_EVENT_SWITCHED, "drawn, not restored");
    assert_eq!((r[1], r[10]), (3.0, 0.0), "silencer off like any given USP");
    assert_eq!(ticks_to_attack(&mut game, IN_ATTACK, 200), Some((99, 1)), "the 1 s draw");

    // The last tick of the window still restores; a restart opens it again.
    game.reset();
    idle(&mut game, WEAPON_RESTORE_TICKS - 1);
    step(&mut game, restore(USP, true));
    assert_eq!(game.weapon_report()[10], 1.0);
}

#[test]
fn v9_ignores_the_restore_flags() {
    let (Some(mut flagged), Some(mut plain)) = (load(PHYSICS_V9), load(PHYSICS_V9)) else { return };
    for t in 0..300u32 {
        let give_at = |id: u32| if t == 0 { id } else { 0 };
        let attack = if t % 2 == 0 { IN_ATTACK } else { 0 };
        step(&mut flagged, give_at(restore(USP, true)) | attack);
        step(&mut plain, give_at(give(USP)) | attack);
        // (The snapshot bytes differ only by the last command's buttons, which they include.)
        assert_eq!(flagged.weapon_report(), plain.weapon_report(), "tick {t}");
        assert_eq!((flagged.state.position, flagged.state.velocity), (plain.state.position, plain.state.velocity));
    }
    assert_eq!(flagged.weapon_report()[10], 0.0, "v9: the silencer stays off");
}

#[test]
fn v10_without_the_flags_is_v9() {
    let (Some(mut v10), Some(mut v9)) = (load(PHYSICS_V10), load(PHYSICS_V9)) else { return };
    for t in 0..400u32 {
        let buttons = if t == 3 { give(USP) } else { 0 } | if t > 150 && t < 160 { IN_ATTACK2 } else { 0 } | if t % 3 == 0 { IN_ATTACK } else { 0 };
        step(&mut v10, buttons);
        step(&mut v9, buttons);
        assert_eq!(v10.weapon_report(), v9.weapon_report(), "tick {t}");
        assert_eq!(v10.snapshot_bytes(), v9.snapshot_bytes(), "tick {t}");
    }
}
