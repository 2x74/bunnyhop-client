//! Physics v16 on bhop_cooksassistant (`game/map_fixes.rs` `NONLINEAR_OBJECTIVES`, `game/vscript.rs`): the native
//! emulation of DanZay's VScript objective system. Four ingredient triggers (*4..*7, nonlinear_objective.nut) each count
//! once; the start room's reset trigger (*8, nonlinear_reset.nut) and script runner (*9, RunScriptFile nonlinear.nut)
//! clear them; the two doorways into the cook's kitchen (the end zone) are a rebound gate (*10 south, *12 east) in
//! front of a teleport gate (*3, *11), all named "4". v15 runs no scripts: the end is a short walk from the start
//! (research/RELEASE-MAPS-DISCORD-1024.md). The map is gitignored; each test skips when it is absent.
//! research/COOKSASSISTANT-1025.md.

use bunnyhop_core::game::{
    PHYSICS_V15, PHYSICS_V16, map_nonlinear_objectives_for, map_nonlinear_objectives_table, map_player_io_for,
};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

const EVENT_TELEPORTED: u32 = 1;
const IN_JUMP: u32 = 1 << 1;
const MAP: &str = "bhop_cooksassistant";

/// The ingredient triggers *4..*7 (entity index, a point the standing player overlaps them from).
const INGREDIENTS: [(usize, [f32; 3]); 4] =
    [(44, [6082.0, 6336.0, 20.0]), (45, [7541.0, 4744.0, 136.0]), (46, [1468.0, 6396.0, 172.0]), (47, [1924.0, 6774.0, 572.0])];
/// The start room (on the reset trigger *8 and the script runner *9), = the start zone.
const START: [f32; 3] = [5504.0, 896.0, 130.0];
/// Inside the castle's east entrance hall, outside both gates and away from every script trigger.
const HALL: [f32; 3] = [5072.0, 1232.0, 240.0];
/// Start -> castle east entrance -> hall -> east doorway (gates *12, *11 at x 4902..4978) -> inner passage -> kitchen.
const ROUTE_FROM_START: [[f32; 2]; 7] =
    [[5300.0, 1232.0], [5072.0, 1232.0], [5072.0, 1408.0], [4820.0, 1408.0], [4820.0, 1232.0], [4572.0, 1232.0], [4572.0, 1488.0]];

fn load(version: u32) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{MAP}.bsp"));
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping {MAP}: {} not found", path.display());
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

fn collect(game: &mut Game, which: &[usize]) {
    for &k in which {
        visit(game, INGREDIENTS[k].1, 20);
    }
}

fn in_end_zone(p: [f32; 3]) -> bool {
    // maps/bhop_cooksassistant.zones.json: the map's own mod_zone_end (*14).
    (4528.0..=4616.0).contains(&p[0]) && (1424.0..=1552.0).contains(&p[1]) && (236.0 - 72.0..=332.0).contains(&p[2])
}

/// A deterministic walker (not an input search): hold forward towards each waypoint in turn, jump only when stuck
/// (under 60 u/s for 20 ticks). Returns (tick the end zone was entered, gate teleports + rebounds seen).
fn walk(game: &mut Game, route: &[[f32; 2]], ticks: u32) -> (Option<u32>, u32) {
    let (mut wp, mut slow, mut gated) = (0, 0, 0);
    for i in 0..ticks {
        let s = game.state.position;
        if (route[wp][0] - s[0]).hypot(route[wp][1] - s[1]) < 20.0 && wp + 1 < route.len() {
            wp += 1;
        }
        let yaw = (route[wp][1] - s[1]).atan2(route[wp][0] - s[0]).to_degrees();
        let v = game.state.velocity;
        slow = if v[0].hypot(v[1]) < 60.0 { slow + 1 } else { 0 };
        let buttons = if slow > 20 { IN_JUMP } else { 0 };
        game.step(Cmd { forward: if i < 5 { 0.0 } else { 450.0 }, yaw, buttons, ..Cmd::default() }).unwrap();
        // A rebound turns a walker's velocity around by more than 600 u/s in one tick; nothing else on this route does.
        let dv = (game.state.velocity[0] - v[0]).hypot(game.state.velocity[1] - v[1]);
        if std::mem::take(&mut game.events) & EVENT_TELEPORTED != 0 || dv > 600.0 {
            gated += 1;
        }
        if in_end_zone(game.state.position) {
            return (Some(i), gated);
        }
    }
    (None, gated)
}

#[test]
fn cooks_table_and_scripted_triggers() {
    assert_eq!(map_nonlinear_objectives_table(), [MAP]);
    let Some(game) = load(PHYSICS_V16) else { return };
    assert_eq!(map_nonlinear_objectives_for(&game.entities), Some(MAP));
    assert_eq!(map_player_io_for(&game.entities), None, "not a PLAYER_IO map");
    assert_eq!(game.objective_triggers(), INGREDIENTS.map(|(i, _)| i));
    // The PLAYER_IO maps and an ordinary map are not in the table.
    for map in ["bhop_synthetic_fix", "bhop_wonderland", "bhop_lego3", "bhop_eazy", "bhop_montana_fix"] {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{map}.bsp"));
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let game = Game::load(&bunnyhop_core::parse_bsp(&bytes).unwrap()).unwrap();
        assert_eq!(map_nonlinear_objectives_for(&game.entities), None, "{map}");
        assert!(game.objective_triggers().is_empty(), "{map}");
    }
}

#[test]
fn cooks_walk_from_start_without_ingredients_is_blocked_from_v16() {
    // The bypass found on 2026-10-24 (a 33.5 s bot walk; this walker takes about 15 s, 13.1 s on the timer): v15 walks
    // from the start room through the east doorway into the kitchen. v16's rebound gate keeps bouncing it back.
    let Some(mut old) = load(PHYSICS_V15) else { return };
    old.set_position(START, 90.0);
    let (reached, _) = walk(&mut old, &ROUTE_FROM_START, 3000);
    assert!(reached.is_some_and(|t| t < 2000), "v15: the walk reaches the end zone ({reached:?})");

    let Some(mut new) = load(PHYSICS_V16) else { return };
    new.set_position(START, 90.0);
    let (reached, gated) = walk(&mut new, &ROUTE_FROM_START, 6000);
    assert_eq!(reached, None, "v16: 60 s of walking never reaches the end zone");
    assert!(gated >= 10, "v16: the east rebound gate keeps bouncing the walker back ({gated})");
    assert!(new.state.position[0] > 4978.0, "v16: still east of the doorway ({:?})", new.state.position);
    assert!(new.objectives_collected().is_empty());
    // v15 sees no gate on the same walk.
    let Some(mut old) = load(PHYSICS_V15) else { return };
    old.set_position(START, 90.0);
    assert_eq!(walk(&mut old, &ROUTE_FROM_START, 3000).1, 0);
}

#[test]
fn cooks_doors_open_with_all_four_ingredients() {
    let route = &ROUTE_FROM_START[2..];
    let Some(mut game) = load(PHYSICS_V16) else { return };
    // Three of four (any three): still shut.
    for missing in 0..4 {
        game.reset();
        let three: Vec<usize> = (0..4).filter(|&k| k != missing).collect();
        collect(&mut game, &three);
        assert_eq!(game.objectives_collected().len(), 3);
        game.place_player(HALL);
        assert_eq!(walk(&mut game, route, 2500).0, None, "without ingredient {missing} the doors stay shut");
    }
    // All four, in any order (each counts once; touching one again doesn't count twice): open.
    for order in [[0, 1, 2, 3], [3, 1, 0, 2]] {
        game.reset();
        collect(&mut game, &[order[0], order[0]]);
        assert_eq!(game.objectives_collected().len(), 1, "an ingredient counts once");
        collect(&mut game, &order[1..]);
        assert_eq!(game.objectives_collected().len(), 4);
        game.place_player(HALL);
        let (reached, gated) = walk(&mut game, route, 2500);
        assert!(reached.is_some(), "4 ingredients ({order:?}): the east doorway lets the player through");
        assert_eq!(gated, 0);
    }
}

#[test]
fn cooks_south_teleport_gate_puts_a_fast_player_back() {
    // South doorway: rebound gate *10 (y 1104..1164) then teleport gate *3 (y 1164..1180), whose entity origin
    // (4576, 1004, 240.81) is 160 units south, outside. The scripts run when the event queue serves the touch's
    // CallScriptFunction (touch outputs are on the player's clock, 6 ticks ahead at 100 tick, like every touch output
    // in the core). At 2000 u/s the player is past the rebound's +y face by then, so the rebound throws it north
    // (+500, into the kitchen), and the teleport gate behind it ("if they manage to bug the rebound") puts it back.
    for (ingredients, through) in [(0, false), (4, true)] {
        let Some(mut game) = load(PHYSICS_V16) else { return };
        collect(&mut game, &(0..ingredients).collect::<Vec<_>>());
        game.place_player([4576.0, 1040.0, 233.0]);
        game.state.velocity = [0.0, 2000.0, 0.0];
        let mut teleported = None;
        for t in 0..20 {
            game.step(Cmd { yaw: 90.0, ..Cmd::default() }).unwrap();
            if std::mem::take(&mut game.events) & EVENT_TELEPORTED != 0 && teleported.is_none() {
                teleported = Some((t, game.state.position, game.state.velocity));
            }
        }
        if through {
            assert_eq!(teleported, None, "4 ingredients: no gate");
            assert!(game.state.position[1] > 1180.0, "4 ingredients: through the doorway ({:?})", game.state.position);
        } else {
            let (_, p, v) = teleported.expect("no ingredients: the teleport gate fires");
            assert!((p[0] - 4576.0).abs() < 1.0 && (p[1] - 1004.0).abs() < 1.0, "put at the gate's origin ({p:?})");
            assert_eq!([v[0], v[1]], [0.0, 0.0], "with zero velocity");
        }
    }
}

#[test]
fn cooks_rebound_gate_bounces_a_walker_back() {
    // East doorway, walking west into the rebound gate *12 (x 4918..4978): the player's centre is east of the gate's
    // +x face, so its x velocity becomes +500 (east).
    let Some(mut game) = load(PHYSICS_V16) else { return };
    game.place_player([5040.0, 1408.0, 233.0]);
    let mut max_vx = f32::MIN;
    for _ in 0..80 {
        game.step(Cmd { forward: 450.0, yaw: 180.0, ..Cmd::default() }).unwrap();
        max_vx = max_vx.max(game.state.velocity[0]);
    }
    assert!(max_vx > 400.0, "bounced east (max vx {max_vx})");
    assert!(game.state.position[0] > 4978.0 - 16.0, "never got through ({:?})", game.state.position);
    // v15: nothing there.
    let Some(mut old) = load(PHYSICS_V15) else { return };
    old.place_player([5040.0, 1408.0, 233.0]);
    for _ in 0..80 {
        old.step(Cmd { forward: 450.0, yaw: 180.0, ..Cmd::default() }).unwrap();
        assert!(old.state.velocity[0] <= 0.0);
    }
    assert!(old.state.position[0] < 4900.0, "v15 walks through ({:?})", old.state.position);
}

#[test]
fn cooks_ingredients_reset_on_restart_respawn_and_the_start_room() {
    let Some(mut game) = load(PHYSICS_V16) else { return };
    collect(&mut game, &[0, 1, 2, 3]);
    assert_eq!(game.objectives_collected().len(), 4);
    // Back in the start room: *8 (ResetObjectivesCollected) and *9 (RunScriptFile nonlinear.nut) clear them.
    visit(&mut game, START, 20);
    assert!(game.objectives_collected().is_empty(), "the start room clears the ingredients");
    // A restart (reset) and a start-zone restart (set_position -> respawn) start with none.
    collect(&mut game, &[0, 1]);
    game.reset();
    assert!(game.objectives_collected().is_empty(), "reset");
    collect(&mut game, &[2, 3]);
    game.set_position(START, 90.0);
    assert!(game.objectives_collected().is_empty(), "start-zone restart");
    // Saved state (practice checkpoints, replay keyframes) carries them and digests the same after a restore.
    collect(&mut game, &[0, 1, 2]);
    let saved = game.save_state();
    let digest = game.snapshot_bytes();
    collect(&mut game, &[3]);
    assert_eq!(game.objectives_collected().len(), 4);
    assert_ne!(game.snapshot_bytes(), digest, "the digest covers the ingredients");
    game.restore_state(&saved);
    assert_eq!(game.objectives_collected().len(), 3);
    assert_eq!(game.snapshot_bytes(), digest);
    // v15: nothing is ever collected.
    let Some(mut old) = load(PHYSICS_V15) else { return };
    collect(&mut old, &[0, 1, 2, 3]);
    assert!(old.objectives_collected().is_empty());
}

#[test]
fn cooks_is_deterministic() {
    // Two identical runs (walk with all four ingredients, then back into a gate without them) digest identically.
    let run = || {
        let mut game = load(PHYSICS_V16)?;
        collect(&mut game, &[1, 3, 0, 2]);
        game.place_player(HALL);
        walk(&mut game, &ROUTE_FROM_START[2..], 600);
        game.set_position(START, 90.0);
        walk(&mut game, &ROUTE_FROM_START, 1600);
        Some((game.snapshot_bytes(), game.state.position))
    };
    let Some(a) = run() else { return };
    assert_eq!(Some(a), run());
}

