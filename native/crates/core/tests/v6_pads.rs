//! Physics v6 shot-pad rule (research/maps/badges-real-replays.md section 6), against the real engine (tools/parity,
//! 2026-10-07): a bot with a USP in the air above bhop_badges pad *577 (OnDamaged: `!activator` AddOutput `targetname
//! upboost` now, `targetname default` 0.5 s later; the column's trigger_push only pushes `upboost`) shoots straight
//! down on chosen commands. srcds results, "after command n" (0-based):
//! - stock CS:S, one shot at 10: OnDamaged fires with no activator (the button's previous m_hActivator), nobody is
//!   renamed, no push;
//! - with EventQueueFix's button hook (m_hActivator = attacker before OnDamaged), one shot at 10: upboost after
//!   command 16, default after command 66, pushed after commands 16..=65;
//! - hook, shots at 10 and 54: the same (the first hit's own `default` ends the boost; the second hit, inside the
//!   window, doesn't extend it);
//! - stock, shots at 10, 30, 74: upboost after 36 (the second hit), default after 86 (that hit's own default).
//! - hook, burst-mode Glock: presses 10-24, 54-73, 100-119 give rounds on 10, 16, 22, 60, 66, 72, 110, 116, 122 and one
//!   unbroken push (upboost after 16, default after 166); +attack held from 10 gives one burst only.
//! v5 is stock, v6 is the hook (and the srcds Glock burst). Scenarios: `bun tools/parity/pads.ts`. Set PAD_DEBUG=1 for a
//! per-command trace. Needs maps/bhop_badges.bsp (gitignored); skips when absent.

use bunnyhop_core::game::{PHYSICS_V5, PHYSICS_V6};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

const IN_ATTACK: u32 = 1;
const IN_ATTACK2: u32 = 1 << 11;

fn badges_with(version: u32, weapon: &str) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps/bhop_badges.bsp");
    if !path.exists() {
        eprintln!("skipping: {} not found", path.display());
        return None;
    }
    let bytes = std::fs::read(&path).expect("read map");
    // Where the player spawns, to put a USP there (a CS:S spawn pistol; the map hands out none).
    let spawn = {
        let mut g = bunnyhop_core::content::load_game(&path).expect("map loads");
        g.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
        g.reset();
        g.state.position
    };
    let mut bsp = bunnyhop_core::parse_bsp(&bytes).expect("parse map");
    let mut list = bunnyhop_core::physics::entity_list_with_outputs(&bsp, true);
    list.entities.push(bunnyhop_core::entities::Entity {
        pairs: vec![
            ("classname".into(), weapon.into()),
            ("origin".into(), format!("{} {} {}", spawn[0], spawn[1], spawn[2] + 16.0)),
            ("spawnflags".into(), "1".into()),
        ],
    });
    list.outputs.push(Vec::new());
    bsp.release_lump_payload(0);
    let content = bunnyhop_core::content::cached_physics_content(&path);
    let mut game = Game::load_with_entities(&bsp, content, list, false).expect("load map");
    game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
    game.reset();
    Some(game)
}

/// Picks up and draws the USP, then puts the player over pad *577 and fires on `shots`. Returns the player's name
/// after each command and the commands after which the push is on (base velocity z > 0).
fn pad_run(version: u32, shots: &[usize], n: usize) -> Option<(Vec<String>, Vec<usize>)> {
    pad_run_with(version, "weapon_usp", None, |i| if shots.contains(&i) { IN_ATTACK } else { 0 }, n).map(|(a, b, _)| (a, b))
}

/// `pad_run` with any weapon, an optional +attack2 command (burst toggle) before the run, and buttons per command.
/// Also returns the commands whose shot hit something.
fn pad_run_with(
    version: u32,
    weapon: &str,
    attack2_before: Option<()>,
    buttons_at: impl Fn(usize) -> u32,
    n: usize,
) -> Option<(Vec<String>, Vec<usize>, Vec<usize>)> {
    let mut game = badges_with(version, weapon)?;
    for i in 0..200 {
        let buttons = if attack2_before.is_some() && i == 190 { IN_ATTACK2 } else { 0 };
        game.step(Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons }).unwrap();
    }
    let id = if weapon == "weapon_glock" { 2.0 } else { 3.0 };
    assert_eq!(game.weapon_report()[1], id, "holding the {weapon}");
    game.place_player([3200.0, -6336.0, -13700.0]);
    let (mut names, mut pushed, mut hits) = (Vec::new(), Vec::new(), Vec::new());
    for i in 0..n {
        let buttons = buttons_at(i);
        game.step(Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 89.0, buttons }).unwrap();
        names.push(game.player_name.clone());
        if game.state.base_velocity[2] > 0.0 {
            pushed.push(i);
        }
        if game.attack.is_some_and(|a| a.hit) {
            hits.push(i);
        }
        if std::env::var("PAD_DEBUG").is_ok() {
            eprintln!("{i} {} z {:.1} vz {:.1} bz {:.0} attack {:?} queued {}", game.player_name, game.state.position[2], game.state.velocity[2], game.state.base_velocity[2], game.attack.map(|a| (a.hit, a.entity)), game.queued_events());
        }
    }
    Some((names, pushed, hits))
}

/// (first command after which the name is `name`, ...) as a compact timeline of changes.
fn changes(names: &[String]) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut prev = String::new();
    for (i, n) in names.iter().enumerate() {
        if *n != prev {
            out.push((i, n.clone()));
            prev = n.clone();
        }
    }
    out
}

fn span(pushed: &[usize]) -> Option<(usize, usize)> {
    Some((*pushed.first()?, *pushed.last()?))
}

#[test]
fn v5_first_hit_renames_nobody_like_stock_css() {
    let Some((names, pushed)) = pad_run(PHYSICS_V5, &[10], 120) else { return };
    assert!(changes(&names).is_empty(), "v5: no rename ({:?})", changes(&names));
    assert!(pushed.is_empty());
}

#[test]
fn v5_second_hit_renames_and_its_window_is_not_extended() {
    let Some((names, pushed)) = pad_run(PHYSICS_V5, &[10, 30, 74], 180) else { return };
    let c = changes(&names);
    eprintln!("v5 10,30,74: {c:?} pushed {:?}", span(&pushed));
    assert_eq!(c, vec![(36, "upboost".to_string()), (86, "default".to_string())]);
    assert_eq!(span(&pushed), Some((36, 85)));
}

#[test]
fn v6_first_hit_renames_the_attacker() {
    let Some((names, pushed)) = pad_run(PHYSICS_V6, &[10], 120) else { return };
    let c = changes(&names);
    eprintln!("v6 10: {c:?} pushed {:?}", span(&pushed));
    assert_eq!(c, vec![(16, "upboost".to_string()), (66, "default".to_string())]);
    assert_eq!(span(&pushed), Some((16, 65)));
}

#[test]
fn v6_boost_ends_with_the_earlier_hits_window() {
    let Some((names, pushed)) = pad_run(PHYSICS_V6, &[10, 54], 160) else { return };
    let c = changes(&names);
    eprintln!("v6 10,54: {c:?} pushed {:?}", span(&pushed));
    assert_eq!(c, vec![(16, "upboost".to_string()), (66, "default".to_string())]);
    assert_eq!(span(&pushed), Some((16, 65)));
}

#[test]
fn v6_glock_burst_every_half_second_chains_the_boost() {
    // srcds (hook on): Glock in burst mode, presses on 10..=24, 54..=73, 100..=119 (a recorded player's rhythm: 44-46
    // apart, held 15-20). The bursts go at 10, 60, 110 (the gun is ready 0.5 s after a burst; a press made before that
    // fires when it is ready); upboost after 16, default after 166: one unbroken 150-tick push, three windows. Each
    // newer hit's upboost and the hit 0.5 s older's default land on the same command; the older event runs first.
    let presses = [(10, 24), (54, 73), (100, 119)];
    let held = |i: usize| presses.iter().any(|&(a, b)| (a..=b).contains(&i));
    let Some((names, pushed, hits)) =
        pad_run_with(PHYSICS_V6, "weapon_glock", Some(()), |i| if held(i) { IN_ATTACK } else { 0 }, 220)
    else {
        return;
    };
    let c = changes(&names);
    eprintln!("v6 glock burst: {c:?} pushed {:?} hits {hits:?}", span(&pushed));
    // srcds: rounds on 10, 16, 22 | 60, 66, 72 | 110, 116, 122.
    assert_eq!(hits, vec![10, 16, 22, 60, 66, 72, 110, 116, 122]);
    assert_eq!(c, vec![(16, "upboost".to_string()), (166, "default".to_string())]);
    assert_eq!(span(&pushed), Some((16, 165)));
    assert_eq!(pushed.len(), 150, "no gap");
}

#[test]
fn v6_held_glock_fires_one_burst() {
    // srcds: burst mode, +attack held from 10 on: one burst (10, 16, 22), no more; upboost after 16, default after 66.
    let Some((names, pushed, hits)) =
        pad_run_with(PHYSICS_V6, "weapon_glock", Some(()), |i| if i >= 10 { IN_ATTACK } else { 0 }, 160)
    else {
        return;
    };
    assert_eq!(hits, vec![10, 16, 22]);
    assert_eq!(changes(&names), vec![(16, "upboost".to_string()), (66, "default".to_string())]);
    assert_eq!(span(&pushed), Some((16, 65)));
    // v5 (unchanged for its replays): rounds 10 ticks apart, and holding fires a burst every 0.5 s.
    let (_, _, hits5) =
        pad_run_with(PHYSICS_V5, "weapon_glock", Some(()), |i| if i >= 10 { IN_ATTACK } else { 0 }, 160).unwrap();
    assert_eq!(&hits5[..6], &[10, 20, 30, 60, 70, 80]);
}
