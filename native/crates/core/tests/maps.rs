//! Map-driven tests. Test maps are gitignored; each test skips (with a note) when its map is absent.
//! Put the BSPs in `<repo>/maps/` (see tools/gamebanana/README.md).

use bunnyhop_core::{
    Cmd, Game,
    game::{BhopBlockMode, EVENT_RESPAWNED, EVENT_TELEPORTED, IN_JUMP, Rules},
};
use std::path::PathBuf;

const MAPS: [&str; 5] = ["bhop_eazy", "bhop_eazy_v2", "bhop_arcane_v1", "bhop_badges_mini", "bhop_strafingonlegos"];

fn map_bytes(name: &str) -> Option<Vec<u8>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    match std::fs::read(&path) {
        Ok(b) => Some(b),
        Err(_) => {
            eprintln!("skipping {name}: {} not found", path.display());
            None
        }
    }
}

fn load(name: &str) -> Option<Game> {
    let bytes = map_bytes(name)?;
    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("bsp parses");
    Some(Game::load(&bsp).expect("game loads"))
}

fn idle(game: &mut Game, buttons: u32) {
    game.step(Cmd { buttons, ..Default::default() }).expect("step");
}

#[test]
fn spawn_settles_on_ground() {
    for name in MAPS {
        let Some(mut game) = load(name) else { continue };
        for _ in 0..300 {
            idle(&mut game, 0);
        }
        let z = game.state.position[2];
        for _ in 0..100 {
            idle(&mut game, 0);
        }
        assert!(game.state.ground.is_some(), "{name}: grounded after settling");
        assert_eq!(game.state.position[2], z, "{name}: resting height is stable");
        assert_eq!(game.horizontal_speed(), 0.0, "{name}: at rest");
        assert!((game.state.position[2] - game.spawn_origin[2]).abs() < 64.0, "{name}: settled near spawn");
    }
}

/// Every trigger_teleport resolves its destination, and touching it (with the activator name its
/// filter wants) teleports the player.
#[test]
fn teleports_resolve_and_fire_on_each_map() {
    for name in MAPS {
        let Some(mut game) = load(name) else { continue };
        let teleports = game.teleports();
        assert!(!teleports.is_empty(), "{name}: has teleports");
        let mut fired = 0;
        for t in &teleports {
            assert!(t.destination.is_some(), "{name}: teleport {} target {:?} unresolved", t.entity, t.target);
            if !t.enabled {
                continue;
            }
            // Trigger models need not fill their bounds (several brushes), so probe a grid.
            // Feet low in the trigger first; then hull placements that together span its height.
            let zs = [t.mins[2] + ((t.maxs[2] - t.mins[2]) * 0.25).min(8.0), t.mins[2] - 31.0, t.mins[2] + 30.0];
            let hit = grid(t.mins, t.maxs).into_iter().chain(fine_grid(t.mins, t.maxs)).any(|[x, y]| {
                zs.iter().any(|&z| {
                    game.reset();
                    if let Some(required) = &t.required_name {
                        game.player_name = required.clone();
                    }
                    game.place_player([x, y, z]);
                    idle(&mut game, 0);
                    game.events & EVENT_TELEPORTED != 0
                })
            });
            if hit {
                fired += 1;
            } else {
                eprintln!("{name}: teleport {} did not fire (filter {:?})", t.entity, t.filter);
            }
        }
        let enabled = teleports.iter().filter(|t| t.enabled).count();
        assert_eq!(fired, enabled, "{name}: {fired}/{enabled} teleports fired");
    }
}

/// trigger_teleport keeps the player's velocity (Source's "BUGBUG": `pVelocity = NULL`). This is
/// the default rule (decided by the user); the HL1-style zeroing is an opt-in rule.
#[test]
fn teleports_keep_velocity_by_default() {
    assert!(Rules::default().teleport_keeps_velocity, "default rule keeps velocity");
    let Some(mut game) = load("bhop_eazy") else { return };
    let velocity = [300.0, 100.0, -50.0];
    // Samples next to a wall clip the velocity in the move itself (CS:S pushes 1/32 off the wall), so look for a
    // teleport sample whose move was free: the horizontal velocity then survives the teleport untouched.
    let mut try_teleport = |game: &mut Game, want: Option<[f32; 2]>| -> Option<[f32; 3]> {
        for t in game.teleports().iter().filter(|t| t.enabled && t.filter.is_none()) {
            for [x, y] in grid(t.mins, t.maxs) {
                game.reset();
                game.place_player([x, y, t.mins[2] + 4.0]);
                game.state.velocity = velocity;
                idle(game, 0);
                let v = game.state.velocity;
                if game.events & EVENT_TELEPORTED != 0 && want.is_none_or(|w| [v[0], v[1]] == w) {
                    return Some(v);
                }
            }
        }
        None
    };
    let kept = try_teleport(&mut game, Some([velocity[0], velocity[1]])).expect("a teleport fired");
    assert_eq!([kept[0], kept[1]], [velocity[0], velocity[1]], "horizontal velocity kept through the teleport");
    assert!(kept[2] <= 0.0, "still falling (or landed inside the trigger)");

    game.set_rules(Rules { teleport_keeps_velocity: false, ..Rules::default() });
    let zeroed = try_teleport(&mut game, None).expect("a teleport fired");
    assert_eq!(zeroed, [0.0; 3], "opt-in rule zeroes velocity");
}

/// bhop_badges_mini has playable floor at y = -16000: the out-of-world kill must not fire there
/// (it used to at |coord| > 16000, respawning players mid-run).
#[test]
fn far_edges_of_the_world_are_playable() {
    let Some(mut game) = load("bhop_badges_mini") else { return };
    game.place_player([2533.5, -16000.46, 8080.04]);
    for _ in 0..50 {
        game.step(Cmd { side: -400.0, buttons: IN_JUMP, ..Default::default() }).unwrap();
        assert_eq!(game.events & EVENT_RESPAWNED, 0, "respawned at {:?}", game.state.position);
    }
}

/// Grid of XY sample points inside the bounds, centre first. Includes points near the edges:
/// many trigger models are rings or strips rather than filled boxes.
fn grid(mins: [f32; 3], maxs: [f32; 3]) -> Vec<[f32; 2]> {
    const F: [f32; 7] = [0.5, 0.01, 0.99, 0.1, 0.9, 0.3, 0.7];
    let mut points = Vec::new();
    for fx in F {
        for fy in F {
            points.push([mins[0] + (maxs[0] - mins[0]) * fx, mins[1] + (maxs[1] - mins[1]) * fy]);
        }
    }
    points
}

/// Dense fallback (lazily evaluated) for triggers made of thin/diagonal brushes.
fn fine_grid(mins: [f32; 3], maxs: [f32; 3]) -> impl Iterator<Item = [f32; 2]> {
    let step = |k: usize| ((maxs[k] - mins[k]) / 96.0).max(8.0);
    let (sx, sy) = (step(0), step(1));
    let nx = ((maxs[0] - mins[0]) / sx) as usize + 1;
    let ny = ((maxs[1] - mins[1]) / sy) as usize + 1;
    (0..nx).flat_map(move |i| (0..ny).map(move |j| [mins[0] + i as f32 * sx, mins[1] + j as f32 * sy]))
}

#[test]
fn simulation_is_bit_deterministic() {
    for name in ["bhop_eazy", "bhop_badges_mini"] {
        let Some(bytes) = map_bytes(name) else { continue };
        let run = || {
            let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
            let mut game = Game::load(&bsp).unwrap();
            let mut seed = 0xC0FF_EE11u32;
            let mut yaw = game.spawn_angles[1];
            let mut out = Vec::new();
            for _ in 0..3000 {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                yaw += ((seed >> 16) as f32 / 65_536.0 - 0.5) * 6.0;
                let side = if seed & 1 == 0 { 400.0 } else { -400.0 };
                let forward = if seed & 6 == 0 { 400.0 } else { 0.0 };
                game.step(Cmd {
                    forward,
                    side,
                    yaw,
                    pitch: 0.0,
                    buttons: IN_JUMP | if seed & 0xF0 == 0 { 4 } else { 0 },
                })
                .unwrap();
                out.extend(game.snapshot_bytes());
                out.extend(game.events.to_le_bytes());
            }
            // Reset must restore the exact initial simulation.
            game.reset();
            out.extend(game.snapshot_bytes());
            out
        };
        let (a, b) = (run(), run());
        assert!(a == b, "{name}: two identical runs diverged");
    }
}

fn first_block(game: &Game) -> [f32; 3] {
    let tops = game.bhop_block_tops();
    assert!(!tops.is_empty(), "map has fix-managed bhop blocks");
    tops[0]
}

/// Ticks until the first teleport (or None) for a player dropped on top of a bhop block.
fn ticks_to_teleport(game: &mut Game, top: [f32; 3], buttons: u32, limit: u32) -> Option<u32> {
    game.reset();
    game.place_player([top[0], top[1], top[2] + 0.5]);
    for n in 0..limit {
        idle(game, buttons);
        if game.events & EVENT_TELEPORTED != 0 {
            return Some(n + 1);
        }
    }
    None
}

#[test]
fn bhop_block_fix_teleports_standing_players_only() {
    let Some(mut game) = load("bhop_eazy") else { return };
    let (blocks, with_teleport) = game.bhop_block_stats();
    assert_eq!((blocks, with_teleport), (188, 188), "every eazy block has a teleport below it");
    let top = first_block(&game);
    let origins = game.brush_origins();
    // Standing: grace = 0.1 s = 10 ticks on the block (+1 tick to land from 0.5u above).
    let t = ticks_to_teleport(&mut game, top, 0, 200).expect("standing player is teleported");
    assert!((10..=12).contains(&t), "teleported after {t} ticks");
    // Hopping in place with autohop: one ground tick per landing, never teleported.
    assert_eq!(ticks_to_teleport(&mut game, top, IN_JUMP, 1000), None, "hopping player is never teleported");
    // The blocks never move in fix mode.
    assert_eq!(origins, game.brush_origins());
}

#[test]
fn bhop_block_vanilla_mode_sinks_under_the_player() {
    let Some(mut game) = load("bhop_eazy") else { return };
    let top = first_block(&game);
    game.set_rules(Rules { bhop_blocks: BhopBlockMode::Vanilla, ..Rules::default() });
    assert_eq!(game.bhop_block_stats().0, 0);
    let origins = game.brush_origins();
    game.place_player([top[0], top[1], top[2] + 0.5]);
    let mut sank = 0.0f32;
    let mut teleported_at = None;
    for n in 0..2000 {
        idle(&mut game, 0);
        for (a, b) in origins.iter().zip(game.brush_origins()) {
            sank = sank.max(a.1[2] - b.1[2]);
        }
        if game.events & EVENT_TELEPORTED != 0 {
            teleported_at = Some(n + 1);
            break;
        }
    }
    let t = teleported_at.expect("standing on a sinking block ends in the teleport below");
    assert!(sank > 1.0, "the touched func_door moved down ({sank} units)");
    assert!(t > 12, "stock blocks take longer than the fix grace ({t} ticks)");
}

/// bhop_badges_mini gates its teleports with `!activator AddOutput targetname activator` (0.09 s)
/// then `targetname default` (0.1 s) from a trigger_multiple on each block plus a
/// filter_activator_name on the trigger_teleport: standing ~9 ticks teleports, hopping does not.
#[test]
fn filtered_activator_name_teleports() {
    for name in ["bhop_badges_mini", "bhop_arcane_v1"] {
        let Some(mut game) = load(name) else { continue };
        let filtered: Vec<_> =
            game.teleports().into_iter().filter(|t| t.enabled && t.required_name.is_some()).collect();
        assert!(!filtered.is_empty(), "{name}: has name-filtered teleports");
        let (mut checked, mut hop_checked) = (0, 0);
        for t in filtered.iter().take(40) {
            // Find a spot where the player actually stands on the floor under the trigger.
            let spot = grid(t.mins, t.maxs).into_iter().find(|[x, y]| {
                game.reset();
                game.place_player([*x, *y, t.mins[2] + 0.5]);
                idle(&mut game, 0);
                game.state.ground.is_some()
            });
            let Some([x, y]) = spot else { continue };
            let p = [x, y, t.mins[2] + 0.5];
            game.reset();
            game.place_player(p);
            let mut first = None;
            for n in 0..60 {
                idle(&mut game, 0);
                if game.events & EVENT_TELEPORTED != 0 {
                    first = Some((n + 1, game.player_name.clone()));
                    break;
                }
            }
            let Some((n, who)) = first else { continue };
            // The 0.09 s AddOutput is fired on the player's clock (5 ticks ahead of the server at 100 tick) and
            // serviced on the server clock, with f32 fire times: the real engine teleports a player standing on these
            // gates after 11 to 16 ticks (tools/parity gate_* scenarios: badges_mini 11, exodus 16; core matches
            // the engine tick for tick there). research/PARITY.md, "Entity I/O timing".
            assert!((9..=17).contains(&n), "{name}: filtered teleport after {n} ticks");
            assert_eq!(Some(who), t.required_name, "{name}: teleported with the filter's name");
            checked += 1;
            // Thin floor-level teleports are block gates: hopping on the spot never stays long
            // enough. (Tall ones, like arcane's 65-unit "lava" floors, catch a hop's first 0.09 s
            // too, exactly as in Source.)
            if t.maxs[2] - t.mins[2] > 4.0 {
                continue;
            }
            game.reset();
            game.place_player(p);
            for n in 0..400 {
                idle(&mut game, IN_JUMP);
                assert_eq!(
                    game.events & EVENT_TELEPORTED,
                    0,
                    "{name}: hopping player was teleported at {p:?} tick {n}"
                );
            }
            hop_checked += 1;
        }
        assert!(checked > 0, "{name}: at least one standing-gated teleport exercised");
        if name == "bhop_badges_mini" {
            assert!(hop_checked > 0, "{name}: at least one hop-gated block exercised");
        }
    }
}

/// Stage checkpoints that rename the player's classname (`!activator,AddOutput,classname N`) gate the fall
/// teleports through filter_activator_class (bhop_egyptiantemple: before this worked, every fall that missed a
/// bhop block left the player stuck at the bottom of the pit).
#[test]
fn filtered_activator_class_teleports() {
    let name = "bhop_egyptiantemple";
    let Some(mut game) = load(name) else { return };
    // (stage start = its info_teleport_destination, walking yaw off the platform, classname set at the exit)
    for (stage, start, yaw) in [
        ("1", [160.0, 112.0, 49.0], 270.0),
        ("2", [160.0, -1056.0, 49.0], 270.0),
        ("3", [160.0, -1160.0, 481.0], 90.0),
        ("4", [160.0, 384.0, 521.0], 90.0),
    ] {
        game.reset();
        game.place_player(start);
        let teleported = (0..300).any(|_| {
            game.step(Cmd { forward: 400.0, yaw, ..Default::default() }).expect("step");
            game.events & EVENT_TELEPORTED != 0
        });
        assert!(teleported, "{name}: fell off stage {stage} without a teleport (stuck at {:?})", game.state.position);
        assert_eq!(game.player_class, stage, "{name}: stage {stage} checkpoint renamed the player");
        assert_eq!(game.state.position, start, "{name}: stage {stage} pit teleports back to its start");
    }
    // A player who never crossed a checkpoint falls through the class-filtered pit untouched.
    game.reset();
    game.place_player([160.0, -1600.0, 100.0]);
    let teleported = (0..200).any(|_| {
        idle(&mut game, 0);
        game.events & EVENT_TELEPORTED != 0
    });
    assert!(!teleported, "{name}: c2 pit ignores a player still classed \"player\"");
    game.reset();
    assert_eq!(game.player_class, "player", "{name}: reset restores the stock classname");
}

#[test]
fn bsp_v19_header_parses() {
    // No v19 bhop map was obtainable (every GameBanana bhop upload checked is v20), so patch the
    // header of a v20 map: the lumps this engine reads have identical layouts in v19.
    let Some(mut bytes) = map_bytes("bhop_eazy") else { return };
    bytes[4..8].copy_from_slice(&19i32.to_le_bytes());
    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("v19 accepted");
    assert_eq!(bsp.container_version, 19);
    let mut game = Game::load(&bsp).unwrap();
    for _ in 0..200 {
        idle(&mut game, 0);
    }
    assert!(game.state.ground.is_some());
    bytes[4..8].copy_from_slice(&18i32.to_le_bytes());
    assert!(bunnyhop_core::parse_bsp(&bytes).is_err(), "v18 is still rejected");
}

/// Replays record the settled restart point and re-simulation settles it again: settling a settled point must give
/// it back bit for bit (bhop_ananas / bhop_badges_ausbhop zone centres used to move 1 ulp in z, desyncing every run
/// started there).
#[test]
fn restart_point_resettles_identically() {
    for (name, target) in [
        // The zone-centre restart targets (start zone mins z + 1) plus points around them.
        ("bhop_ananas", [9072.0, -5923.0, -28.968]),
        ("bhop_badges_ausbhop", [-4576.0, -700.0, -29.968]),
        ("bhop_kz_ravine", [0.0, -1156.0, -125.968]),
    ] {
        let Some(mut game) = load(name) else { continue };
        for dx in [-64.0f32, -17.5, 0.0, 9.25, 48.0] {
            for dz in [0.0f32, 0.5, 3.0] {
                let p = [target[0] + dx, target[1] - dx * 0.5, target[2] + dz];
                game.reset();
                game.set_position(p, 0.0);
                let (a, _) = game.restart_point().expect("restart point");
                game.reset();
                game.set_position(a, 0.0);
                let (b, _) = game.restart_point().expect("restart point");
                assert!(a.iter().zip(&b).all(|(x, y)| x.to_bits() == y.to_bits()), "{name}: settle({p:?}) = {a:?} re-settles to {b:?}");
            }
        }
    }
}

/// The trigger touch pass after the move happens where the move ended, before a trigger_teleport in that pass moves
/// the player (bhop_badges: the "end" teleport covers 94% of the end zone; the run timer checks `touch_origin`).
#[test]
fn touch_origin_is_before_the_teleport() {
    let name = "bhop_badges";
    let Some(mut game) = load(name) else { return };
    // bhop_badges' end zone (maps/bhop_badges.zones.json: -1249..-1183, 7647..7713, -96..-78) is over trigger_teleport
    // *391 -> end.
    game.reset();
    game.set_position([-1216.0, 7680.0, -95.0], 0.0);
    assert!(game.touch_origin[0].is_nan(), "{name}: no touch pass before the first step");
    let teleported = (0..20).any(|_| {
        idle(&mut game, 0);
        game.events & EVENT_TELEPORTED != 0
    });
    assert!(teleported, "{name}: the end zone's teleport fires");
    let d = (0..3).map(|k| (game.touch_origin[k] - game.state.position[k]).abs()).fold(0.0f32, f32::max);
    assert!(d > 64.0 && (game.touch_origin[0] + 1216.0).abs() < 1.0 && (game.touch_origin[1] - 7680.0).abs() < 1.0, "{name}: touch origin {:?} is where the teleport was touched (now at {:?})", game.touch_origin, game.state.position);
}

/// bhoptimer's bhop_japan map fix (shavit_zones_resetclassname_main "beginner"): with the restart names the start
/// zone's class-filtered teleport (*133 -> begin) leaves the player alone; without them it sends them away, and the
/// names survive a respawn at the restart point but not a reset.
#[test]
fn restart_names_pass_class_filters() {
    let name = "bhop_japan";
    let Some(mut game) = load(name) else { return };
    let centre = [2304.0, -7328.0, 482.031];
    let teleported = |game: &mut Game| {
        (0..100).any(|_| {
            idle(game, 0);
            game.events & EVENT_TELEPORTED != 0
        })
    };
    game.reset();
    game.set_position(centre, 0.0);
    assert!(teleported(&mut game), "{name}: a fresh \"player\" is teleported out of the start zone");
    game.reset();
    game.set_position(centre, 0.0);
    game.set_restart_names("", "beginner");
    assert_eq!(game.player_class, "beginner");
    assert!(!teleported(&mut game), "{name}: a \"beginner\" stays in the start zone");
    game.respawn_player();
    assert_eq!(game.player_class, "beginner", "{name}: respawning at the restart point keeps its names");
    game.reset();
    assert_eq!(game.player_class, "player", "{name}: reset clears the restart names");
}
