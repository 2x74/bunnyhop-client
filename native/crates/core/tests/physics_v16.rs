//! Physics v16: the player's own outputs and filter tests on the maps in `game/map_fixes.rs` `PLAYER_IO`
//! (`PHYSICS_FIX_MAP_PLAYER_IO`). Each map counts collected items with outputs added to the player
//! (`!activator,AddOutput,OnUser1 <filter>:testactivator::0:1`), fired by `!activator,FireUser1`, through filter
//! `TestActivator` chains into a math_counter whose max renames the player; only that name gets past the gate.
//! v15 stays as it was (the counter never moves, the gate sends everyone back). Maps are gitignored; each test skips
//! (with a note) when its map is absent. research/SYNTHETIC-DOOR-1025.md.

use bunnyhop_core::game::{PHYSICS_V15, PHYSICS_V16, map_player_io_for, map_player_io_table};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

const EVENT_TELEPORTED: u32 = 1;

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

/// Put the player at `p` and run `ticks` idle ticks; true if a teleport happened.
fn visit(game: &mut Game, p: [f32; 3], ticks: u32) -> bool {
    game.place_player(p);
    let mut teleported = false;
    for _ in 0..ticks {
        game.step(Cmd::default()).unwrap();
        teleported |= std::mem::take(&mut game.events) & EVENT_TELEPORTED != 0;
    }
    teleported
}

/// bhop_synthetic_fix stage 3 (s3c4): the checkpoint platform (teleport_12, on reset_trigger *99), then the potions
/// (trigger_multiple *100..*102, floating in the air: the player passes through each), in `order`.
fn collect_potions(game: &mut Game, order: &[usize]) {
    const POTIONS: [[f32; 3]; 3] = [[-11731.5, -8577.0, 11222.0], [-11479.5, -7838.0, 11222.0], [-11731.5, -7099.0, 11222.0]];
    game.reset();
    visit(game, [-11000.5, -9985.0, 11967.0], 20);
    assert_eq!(game.player_name, "s3c4", "the checkpoint platform names the player s3c4");
    for &i in order {
        visit(game, POTIONS[i], 30);
        assert_eq!(game.player_name.starts_with("pot"), true, "potion {} renames the player ({})", i + 1, game.player_name);
    }
}

/// Fly at the door (trigger_teleport *98 at y -6637, filter_potpass: everyone not named potpass goes back to
/// teleport_12) from 63 units in front of it, at 400 u/s; true if it sent the player back.
fn door_sends_back(game: &mut Game) -> bool {
    game.place_player([-11500.0, -6700.0, 10900.0]);
    game.state.velocity = [0.0, 400.0, 0.0];
    for _ in 0..40 {
        game.step(Cmd { forward: 450.0, yaw: 90.0, ..Cmd::default() }).unwrap();
        if std::mem::take(&mut game.events) & EVENT_TELEPORTED != 0 {
            return true;
        }
    }
    assert!(game.state.position[1] > -6600.0, "the player crossed the door plane ({:?})", game.state.position);
    false
}

#[test]
fn synthetic_potion_door_opens_from_v16() {
    let Some(mut old) = load("bhop_synthetic_fix", PHYSICS_V15) else { return };
    let Some(mut new) = load("bhop_synthetic_fix", PHYSICS_V16) else { return };
    assert_eq!(map_player_io_for(&new.entities), Some("bhop_synthetic_fix"), "table entry");
    // v15: the counter never moves (no player outputs, FireUser or TestActivator), so the door sends the player back,
    // which is what players saw (feedback 2026-10-25, GothQueen).
    collect_potions(&mut old, &[0, 1, 2]);
    assert_eq!(old.player_name, "pot3");
    assert!(door_sends_back(&mut old), "v15: the door sends the player back");
    // v16: the third potion takes counter_potcount to its max (0 -> 1 -> 3), which renames the player potpass.
    collect_potions(&mut new, &[0, 1, 2]);
    assert_eq!(new.player_name, "potpass", "v16: three potions open the door");
    assert!(!door_sends_back(&mut new), "v16: the door lets the player through");
    // Any order works: each potion adds one per potion collected before it.
    collect_potions(&mut new, &[2, 0, 1]);
    assert_eq!(new.player_name, "potpass", "v16: any order");
}

#[test]
fn synthetic_door_still_needs_three_potions() {
    let Some(mut game) = load("bhop_synthetic_fix", PHYSICS_V16) else { return };
    // Two potions: counter 1, door closed.
    collect_potions(&mut game, &[0, 1]);
    assert_eq!(game.player_name, "pot2");
    assert!(door_sends_back(&mut game), "two potions don't open the door");
    // The same potion twice in a row doesn't count (its trigger's filter_potion1_x skips a player named pot1), and
    // going back for an earlier one spends its count (CS:S: the OnUser1 it re-tests fails and isn't re-added).
    collect_potions(&mut game, &[0, 1, 0]);
    assert_ne!(game.player_name, "potpass", "1, 2, 1 is not three potions");
    // Back on the checkpoint platform the reset trigger clears the count: three more are needed.
    collect_potions(&mut game, &[0, 1]);
    visit(&mut game, [-11000.5, -9985.0, 11967.0], 20);
    assert_eq!(game.player_name, "s3c4");
    visit(&mut game, [-11731.5, -7099.0, 11222.0], 30);
    assert_eq!(game.player_name, "pot3", "the reset trigger spent the earlier potions");
}

#[test]
fn synthetic_saved_state_keeps_the_potions() {
    // Practice checkpoints (save_state / restore_state) carry the outputs the player holds.
    let Some(mut game) = load("bhop_synthetic_fix", PHYSICS_V16) else { return };
    collect_potions(&mut game, &[0, 1]);
    let saved = game.save_state();
    let digest = game.snapshot_bytes();
    visit(&mut game, [-11731.5, -7099.0, 11222.0], 30);
    assert_eq!(game.player_name, "potpass");
    game.restore_state(&saved);
    assert_eq!(game.player_name, "pot2");
    assert_eq!(game.snapshot_bytes(), digest, "restored state digests the same");
    visit(&mut game, [-11731.5, -7099.0, 11222.0], 30);
    assert_eq!(game.player_name, "potpass", "the restored outputs still count");
    // A restart drops them.
    game.reset();
    assert_eq!(game.player_name, "");
    collect_potions(&mut game, &[2]);
    assert_eq!(game.player_name, "pot3");
}

#[test]
fn wonderland_key_room_opens_from_v16() {
    // The cp3 key room: keys *241..*243 (any order), then checking_trigger *247 counts the keys held; at 3 the player is
    // renamed ng0_pass and the floor teleport *244 (filter anti_glitch_filter_0_passed) takes them to cp4a.
    const KEYS: [[f32; 3]; 3] = [[-1488.0, 13943.0, -6640.0], [-2720.0, 12335.0, -6605.0], [-2996.0, 14084.0, -6475.0]];
    const CHECK: [f32; 3] = [-3468.0, 13332.0, -6900.0];
    for (version, opens) in [(PHYSICS_V15, false), (PHYSICS_V16, true)] {
        let Some(mut game) = load("bhop_wonderland", version) else { return };
        if version == PHYSICS_V16 {
            assert_eq!(map_player_io_for(&game.entities), Some("bhop_wonderland"), "table entry");
        }
        for k in KEYS {
            visit(&mut game, k, 15);
        }
        let teleported = visit(&mut game, CHECK, 60);
        assert_eq!(game.player_name == "ng0_pass", opens, "v{version}: name {}", game.player_name);
        assert_eq!(teleported, opens, "v{version}: the exit teleport");
        if opens {
            let p = game.state.position;
            assert!((p[0] + 674.0).abs() < 64.0 && (p[1] - 1444.0).abs() < 64.0, "v16 arrives at cp4a ({p:?})");
        }
    }
}

#[test]
fn lego3_coins_open_from_v16() {
    // Three coins (*3..*5), then checking_trigger *171: at 3 the player is renamed ng0_pass, which the denied teleport
    // *178 and the push *177 (filter anti_glitch_filter_0_passed_n) let through.
    const COINS: [[f32; 3]; 3] = [[-4928.0, 6000.0, 170.0], [-4816.0, 7280.0, 234.0], [-3920.0, 5872.0, 202.0]];
    const CHECK: [f32; 3] = [-5300.0, 6320.0, 20.0];
    for (version, opens) in [(PHYSICS_V15, false), (PHYSICS_V16, true)] {
        let Some(mut game) = load("bhop_lego3", version) else { return };
        for c in COINS {
            visit(&mut game, c, 15);
        }
        visit(&mut game, CHECK, 10);
        assert_eq!(game.player_name == "ng0_pass", opens, "v{version}: name {}", game.player_name);
        // Walk west through the denied teleport (x -5568..-5536).
        let mut sent_back = false;
        for _ in 0..150 {
            game.step(Cmd { forward: 450.0, yaw: 180.0, ..Cmd::default() }).unwrap();
            sent_back |= std::mem::take(&mut game.events) & EVENT_TELEPORTED != 0;
        }
        let x = game.state.position[0];
        assert_eq!(sent_back || x > -5536.0, !opens, "v{version}: the gate (x {x}, teleported {sent_back})");
    }
}

#[test]
fn other_maps_are_not_in_the_table() {
    assert_eq!(map_player_io_table(), ["bhop_synthetic_fix", "bhop_wonderland", "bhop_lego3"]);
    // bhop_lego / bhop_space / kz_bhop_minimal use TestActivator too, and bhop_synthetic (the older build) the same
    // potion room: none of them is in the table, so v16 plays them exactly like v15.
    for map in ["bhop_eazy", "bhop_montana_fix", "bhop_lego", "bhop_space", "kz_bhop_minimal", "bhop_synthetic"] {
        let Some(game) = load(map, PHYSICS_V16) else { continue };
        assert_eq!(map_player_io_for(&game.entities), None, "{map}");
    }
}
