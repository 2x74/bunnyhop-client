//! `Game::service_events` fast-forwards zero-length doors looping on themselves (`skip_idle_door_loops`,
//! bhop_overground_fix). The skip must change nothing: each scene runs the same input with and without it and
//! compares every tick, including when something in the loop changes partway through.
//! Maps are gitignored; each test skips (with a note) when its map is absent.

use bunnyhop_core::{Cmd, Game, game::IN_JUMP};
use std::path::PathBuf;

const MAP: &str = "bhop_overground_fix";

fn bsp_bytes() -> Option<Vec<u8>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{MAP}.bsp"));
    match std::fs::read(&path) {
        Ok(b) => Some(b),
        Err(_) => {
            eprintln!("skipping {MAP}: {} not found", path.display());
            None
        }
    }
}

/// The map with its entity lump rewritten by `edit`, as the skipping and the exact game.
fn games(edit: impl Fn(&str) -> String) -> Option<(Game, Game)> {
    let bytes = bsp_bytes()?;
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let Some(playsrc_bsp::LumpData::EntityBytes(lump)) = bsp.lump(playsrc_bsp::ENTITIES).map(|l| &l.records) else { panic!("no entity lump") };
    let text = edit(&String::from_utf8_lossy(lump));
    let load = || {
        let list = bunnyhop_core::entities::parse_with_outputs(&text, true);
        Game::load_with_entities(&bsp, None, list, false).unwrap()
    };
    let (skipping, mut exact) = (load(), load());
    exact.exact_event_loops = true;
    Some((skipping, exact))
}

fn input(n: u32, yaw: &mut f32) -> Cmd {
    let side = if (n / 40) % 2 == 0 { 400.0 } else { -400.0 };
    *yaw += if side > 0.0 { -1.0 } else { 1.0 };
    Cmd { forward: if n < 20 { 400.0 } else { 0.0 }, side, yaw: *yaw, pitch: 0.0, buttons: IN_JUMP }
}

/// Runs both to `ticks`, comparing every tick; `script` runs on both first (fire inputs at chosen ticks).
fn same(scene: &str, (mut a, mut b): (Game, Game), ticks: u32, script: impl Fn(&mut Game, u32)) {
    let mut yaw = a.spawn_angles[1];
    for n in 0..ticks {
        script(&mut a, n);
        script(&mut b, n);
        let cmd = input(n, &mut yaw);
        a.step(cmd).unwrap();
        b.step(cmd).unwrap();
        assert_eq!(a.events_fired(), b.events_fired(), "{scene}: event count at tick {n}");
        assert_eq!(a.queue_order(), b.queue_order(), "{scene}: queue at tick {n}");
        assert_eq!(a.snapshot_bytes(), b.snapshot_bytes(), "{scene}: state at tick {n}");
    }
}

#[test]
fn the_map_itself() {
    let Some(games) = games(str::to_string) else { return };
    same("as shipped", games, 1500, |_, _| {});
}

#[test]
fn nearly_every_event_is_skipped() {
    let Some((mut game, mut exact)) = games(str::to_string) else { return };
    let cmd = Cmd::default();
    for _ in 0..100 {
        game.step(cmd).unwrap();
        exact.step(cmd).unwrap();
    }
    assert_eq!(exact.events_skipped, 0);
    assert!(game.events_skipped > 95 * 4000, "skipped {} of {}", game.events_skipped, game.events_fired());
}

#[test]
fn every_physics_version_and_a_restart() {
    for version in 1..=bunnyhop_core::game::PHYSICS_LATEST {
        let Some((mut a, mut b)) = games(str::to_string) else { return };
        for g in [&mut a, &mut b] {
            g.set_settings(bunnyhop_core::Settings { physics_version: version, ..bunnyhop_core::Settings::css_bhop() });
            g.reset();
        }
        same(&format!("physics {version}"), (a, b), 250, |g, n| {
            if n == 120 {
                g.reset();
            }
        });
    }
}

#[test]
fn the_cap_is_still_spent() {
    let Some((mut game, _)) = games(str::to_string) else { return };
    let cmd = Cmd::default();
    game.step(cmd).unwrap();
    game.step(cmd).unwrap();
    let before = game.events_fired();
    for _ in 0..10 {
        game.step(cmd).unwrap();
    }
    assert_eq!(game.events_fired() - before, 10 * 4096);
}

#[test]
fn inputs_that_break_into_the_loop() {
    for (scene, target, input, param) in [
        ("lock", "d2", "Lock", ""),
        ("unlock", "d2", "Unlock", ""),
        ("kill", "d3", "Kill", ""),
        ("spent output", "d4", "AddOutput", "OnFullyOpen d4:Close::0:1"),
        ("extra output", "d4", "AddOutput", "OnOpen d5:Open::0:-1"),
        ("delayed output", "d6", "AddOutput", "OnFullyClosed d6:Open::0.5:-1"),
        ("renamed", "d7", "AddOutput", "targetname other"),
        ("a second event", "d8", "Open", ""),
        ("a close too", "d8", "Close", ""),
        ("all doors", "d*", "Toggle", ""),
    ] {
        let Some(games) = games(str::to_string) else { return };
        same(scene, games, 700, |g, n| {
            if n == 300 {
                g.fire_input(target, input, param);
            }
        });
    }
}

#[test]
fn doors_that_are_not_quite_the_loop() {
    // A counted output runs out; two outputs fan out; another door shares the target name; a real door joins the loop.
    for (scene, from, to) in [
        ("counted", "\"OnFullyOpen\" \"d1,Close,,0,-1\"", "\"OnFullyOpen\" \"d1,Close,,0,500\""),
        ("two targets", "\"OnFullyClosed\" \"d2,Open,,0,-1\"", "\"OnFullyClosed\" \"d2,Open,,0,-1\"\n\"OnFullyClosed\" \"d3,Open,,0,-1\""),
        ("delayed", "\"OnFullyOpen\" \"d4,Close,,0,-1\"", "\"OnFullyOpen\" \"d4,Close,,0.01,-1\""),
        ("shared name", "\"targetname\" \"d5\"", "\"targetname\" \"d6\""),
        ("wildcard", "\"OnFullyOpen\" \"d7,Close,,0,-1\"", "\"OnFullyOpen\" \"d7*,Close,,0,-1\""),
        ("no lip", "\"lip\" \"256\"", "\"lip\" \"0\""),
    ] {
        let Some(games) = games(|lump| {
            assert!(lump.contains(from), "{scene}: the map no longer has {from}");
            lump.replacen(from, to, 1)
        }) else {
            return;
        };
        same(scene, games, 900, |_, _| {});
    }
}

#[test]
fn saved_states_keep_the_order() {
    let Some((mut a, mut b)) = games(str::to_string) else { return };
    let cmd = Cmd { buttons: IN_JUMP, ..Cmd::default() };
    for _ in 0..50 {
        a.step(cmd).unwrap();
        b.step(cmd).unwrap();
    }
    let (sa, sb) = (a.save_state(), b.save_state());
    for _ in 0..50 {
        a.step(cmd).unwrap();
        b.step(cmd).unwrap();
    }
    a.restore_state(&sa);
    b.restore_state(&sb);
    for n in 0..200 {
        a.step(cmd).unwrap();
        b.step(cmd).unwrap();
        assert_eq!(a.snapshot_bytes(), b.snapshot_bytes(), "tick {n} after restore");
        assert_eq!(a.queue_order(), b.queue_order(), "queue, tick {n} after restore");
    }
}
