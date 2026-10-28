//! Floor weapon items for the client (`Game::floor_report`, wasm `floor_weapons`; research/WEAPONS.md "Floor
//! weapons"): every weapon_* item with its presence and what happened to it (pickup, drop, template respawn), and the
//! per-tick "changed" bit in `weapon_report`. Presentation only: the report never changes the simulation. Needs
//! maps/bhop_badges_mini.bsp (gitignored); skips when absent.

use bunnyhop_core::game::{
    FLOOR_DROPPED, FLOOR_PICKED_UP, FLOOR_PRESENT, FLOOR_SPAWNED, FloorItem, IN_DROP, PHYSICS_V5,
};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

fn mini() -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps/bhop_badges_mini.bsp");
    if !path.exists() {
        eprintln!("skipping: {} not found", path.display());
        return None;
    }
    let mut game = bunnyhop_core::content::load_game(&path).expect("map loads");
    game.set_settings(Settings { physics_version: PHYSICS_V5, ..Settings::css_bhop() });
    game.reset();
    Some(game)
}

fn report(game: &mut Game) -> Vec<FloorItem> {
    let mut out = Vec::new();
    game.floor_report(|it| out.push(it));
    out
}

fn idle(game: &mut Game, ticks: u32, buttons: u32) {
    for _ in 0..ticks {
        game.step(Cmd { forward: 0.0, side: 0.0, yaw: 90.0, pitch: 0.0, buttons }).unwrap();
    }
}

#[test]
fn floor_report_follows_pickups_and_drops() {
    let Some(mut game) = mini() else { return };
    let first = report(&mut game);
    assert_eq!(first.len(), 24, "every weapon_* item, present or not");
    assert!(first.iter().all(|it| it.weapon == 2), "bhop_badges_mini only has Glocks");
    let present: Vec<_> = first.iter().filter(|it| it.flags & FLOOR_PRESENT != 0).collect();
    assert!(!present.is_empty() && present.len() < first.len(), "point_template items wait for their ForceSpawn");
    assert!(present.iter().all(|it| it.flags & FLOOR_SPAWNED != 0), "first report: present items appeared");
    // Nothing happens: the next report is quiet and the per-tick bit stays clear.
    idle(&mut game, 5, 0);
    assert_eq!(game.weapon_report()[9], 0.0);
    assert!(report(&mut game).iter().all(|it| it.flags & !FLOOR_PRESENT == 0));

    // Stand on a start-room Glock: picked up, gone from the floor.
    let glock = *present.iter().min_by(|a, b| a.position[2].total_cmp(&b.position[2]).reverse()).unwrap();
    game.set_position([glock.position[0], glock.position[1], glock.position[2] + 2.0], 90.0);
    idle(&mut game, 20, 0);
    assert_eq!(game.weapon_report()[2 + 1], 2.0, "the Glock is in the secondary slot");
    assert_eq!(game.weapon_report()[9], 1.0, "floor changed since the last report");
    let r = report(&mut game);
    let it = r.iter().find(|it| it.ent == glock.ent).unwrap();
    assert_eq!(it.flags, FLOOR_PICKED_UP, "picked up, not present");
    assert_eq!(game.weapon_report()[9], 0.0, "reported");

    // Drop it: back on the floor in front of the player (no pickup for 1 s), flagged as dropped, not spawned.
    idle(&mut game, 120, 0); // deploy
    idle(&mut game, 1, IN_DROP);
    idle(&mut game, 1, 0);
    let r = report(&mut game);
    let it = r.iter().find(|it| it.ent == glock.ent).unwrap();
    assert_eq!(it.flags, FLOOR_PRESENT | FLOOR_DROPPED, "dropped: {it:?}");
}

#[test]
fn floor_report_does_not_change_the_simulation() {
    let (Some(mut a), Some(mut b)) = (mini(), mini()) else { return };
    let start = report(&mut a).into_iter().find(|it| it.flags & FLOOR_PRESENT != 0).unwrap().position;
    for g in [&mut a, &mut b] {
        g.set_position([start[0], start[1], start[2] + 2.0], 90.0);
    }
    for t in 0..400u32 {
        let buttons = if t == 200 { IN_DROP } else { 0 };
        let cmd = Cmd { forward: if t > 210 { 200.0 } else { 0.0 }, side: 0.0, yaw: 90.0, pitch: 0.0, buttons };
        a.step(cmd).unwrap();
        b.step(cmd).unwrap();
        report(&mut a); // every tick on one game only
        assert_eq!(a.snapshot_bytes(), b.snapshot_bytes(), "tick {t}");
    }
}

#[test]
fn floor_report_sees_template_respawns() {
    // The first segment-18 spawner (research/maps/badges.md): its trigger kills `glock` and ForceSpawns the template next
    // to the player, who picks the new Glock up in the same tick (touches, then BumpWeapon): an item that came and went
    // between two reports is only "picked up", never drawn.
    let Some(mut game) = mini() else { return };
    let first = report(&mut game);
    let item = *first.iter().find(|it| it.flags & FLOOR_PRESENT == 0 && (it.position[0] - 9052.0).abs() < 1.0).unwrap();
    game.set_position([item.position[0], item.position[1], item.position[2] + 2.0], 90.0);
    let (mut spawned, mut picked) = (None, None);
    for t in 0..200 {
        idle(&mut game, 1, 0);
        let it = report(&mut game).into_iter().find(|it| it.ent == item.ent).unwrap();
        if it.flags & FLOOR_SPAWNED != 0 {
            spawned.get_or_insert(t);
        }
        if it.flags & FLOOR_PICKED_UP != 0 {
            picked.get_or_insert(t);
        }
    }
    assert!(picked.is_some() && spawned.is_none(), "spawned {spawned:?}, picked up {picked:?}");
    assert_eq!(game.weapon_report()[3], 2.0, "holding the Glock");
}
