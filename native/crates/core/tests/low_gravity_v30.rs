//! Physics v30 Low Gravity (`Settings::style_gravity`, `Game::style_gravity_rule`): a replay header's `gravity 400` is
//! bhoptimer's Low Gravity, sv_gravity 800 with a player multiplier of 0.5 that shavit-core's PreThinkPost puts back each
//! command when the multiplier reads 1 or 0 or the player just left a ladder. A map's own value (a lift's -1.9, a slam's
//! 40, a 0.35 zone) runs at full strength. `low_gravity.rs` keeps the v1..v29 composition (400 x the map's value).
//! Maps are gitignored; a test whose map is missing skips with a note.

use bunnyhop_core::game::{PHYSICS_V29, PHYSICS_V30, IN_DUCK, IN_JUMP};
use bunnyhop_core::{Cmd, Game, Settings};

const DT: f32 = 0.01;

fn settings(version: u32, gravity: f32) -> Settings {
    Settings { physics_version: version, gravity, ..Settings::css_bhop() }
}

fn load(name: &str, s: Settings) -> Option<Game> {
    let path = bunnyhop_core::test_maps::bsp(name);
    if !path.exists() {
        return None;
    }
    let mut game = bunnyhop_core::content::load_game(&path).unwrap();
    game.set_settings(s);
    game.reset();
    Some(game)
}

/// Model `*N`'s world bounds.
fn model_bounds(game: &Game, model: &str) -> ([f32; 3], [f32; 3]) {
    let i = game.entities.iter().position(|e| e.get("model") == Some(model)).unwrap_or_else(|| panic!("{model}"));
    game.entity_bounds(i).unwrap()
}

/// In the open air of bhop_eazy's stage 2, at rest, with the multiplier `scale`; one command with no input.
fn fall_one_tick(game: &mut Game, scale: f32) -> f32 {
    game.reset();
    game.practice_noclip_exit([600.0, -352.0, 200.0], [0.0; 3], 0.0, 0.0);
    game.gravity_scale = scale;
    game.step(Cmd::default()).unwrap();
    game.state.velocity[2]
}

#[test]
fn style_gravity_is_v30_low_gravity_only() {
    assert_eq!(settings(PHYSICS_V30, 400.0).style_gravity(), Some(0.5));
    assert_eq!(settings(PHYSICS_V30, 400.0).sv_gravity(), 800.0);
    assert_eq!(settings(PHYSICS_V30, 800.0).style_gravity(), None);
    assert_eq!(settings(PHYSICS_V30, 800.0).sv_gravity(), 800.0);
    for v in 1..=PHYSICS_V29 {
        assert_eq!(settings(v, 400.0).style_gravity(), None, "v{v}");
        assert_eq!(settings(v, 400.0).sv_gravity(), 400.0, "v{v}");
        assert_eq!(settings(v, 400.0).configuration().gravity, 400.0, "v{v}");
    }
    assert_eq!(settings(PHYSICS_V30, 400.0).configuration().gravity, 800.0);
    // The product every integrator site forms first is the same float.
    assert_eq!(800.0f32 * 0.5, 400.0f32 * 1.0);
}

#[test]
fn shavit_rule_resets_1_and_0_and_keeps_map_values() {
    let Some(mut game) = load("bhop_eazy", settings(PHYSICS_V30, 400.0)) else { return };
    assert_eq!(game.gravity_scale, 0.5, "restart: SetEntityGravity(style)");
    // 1 (a map's "gravity 1" reset, or a fresh player) is the style's before this command's move.
    let vz = fall_one_tick(&mut game, 1.0);
    assert_eq!(vz, -800.0 * 0.5 * DT);
    assert_eq!(game.gravity_scale, 0.5);
    // Values a map sets stay, at sv_gravity 800.
    for scale in [40.0, -1.9, 0.5, 0.35, 2.0, -1.0] {
        let vz = fall_one_tick(&mut game, scale);
        assert_eq!(vz, -800.0 * scale * DT, "map value {scale}");
        assert_eq!(game.gravity_scale, scale, "map value {scale} kept");
        game.step(Cmd::default()).unwrap();
        assert_eq!(game.gravity_scale, scale, "map value {scale} still kept");
    }
    // AddOutput "gravity 0" (stored as 1, the player's default) and "gravity 1".
    for param in ["gravity 0", "gravity 1"] {
        fall_one_tick(&mut game, -1.9);
        game.fire_input("!activator", "AddOutput", param);
        assert_eq!(game.gravity_scale, 1.0, "{param}");
        let before = game.state.velocity[2];
        game.step(Cmd::default()).unwrap();
        assert_eq!(game.gravity_scale, 0.5, "{param}");
        assert_eq!(game.state.velocity[2], before - 400.0 * DT, "{param}");
    }
    // shavit's clientg == 0.0 branch (the core never stores 0 itself).
    fall_one_tick(&mut game, 0.0);
    assert_eq!(game.gravity_scale, 0.5);
}

#[test]
fn ladder_dismount_resets_a_map_value() {
    let Some(mut game) = load("bhop_eazy", settings(PHYSICS_V30, 400.0)) else { return };
    game.practice_noclip_exit([600.0, -352.0, 200.0], [0.0; 3], 0.0, 0.0);
    game.gravity_scale = -1.0;
    // A ladder command: the rule writes nothing and remembers LADDER. In the open air the move drops back to WALK.
    game.state.mode = playsrc_movement::Mode::Ladder;
    game.step(Cmd::default()).unwrap();
    assert_eq!(game.gravity_scale, -1.0, "nothing written on a ladder command");
    assert_eq!(game.state.mode, playsrc_movement::Mode::Walk);
    game.step(Cmd::default()).unwrap();
    assert_eq!(game.gravity_scale, 0.5, "the first WALK command after LADDER takes the style's");
    // Normal at v30 and Low Gravity before v30: no rule.
    for s in [settings(PHYSICS_V30, 800.0), settings(PHYSICS_V29, 400.0)] {
        game.set_settings(s);
        game.reset();
        assert_eq!(game.gravity_scale, 1.0);
        game.practice_noclip_exit([600.0, -352.0, 200.0], [0.0; 3], 0.0, 0.0);
        game.gravity_scale = -1.0;
        game.state.mode = playsrc_movement::Mode::Ladder;
        game.step(Cmd::default()).unwrap();
        game.step(Cmd::default()).unwrap();
        assert_eq!(game.gravity_scale, -1.0, "v{} gravity {}", s.physics_version, s.gravity);
        let vz = fall_one_tick(&mut game, 1.0);
        assert_eq!(vz, -s.gravity * DT);
        assert_eq!(game.gravity_scale, 1.0);
    }
}

#[test]
fn switching_style_without_a_restart_swaps_the_multiplier() {
    let Some(mut game) = load("bhop_eazy", settings(PHYSICS_V30, 400.0)) else { return };
    assert_eq!(game.gravity_scale, 0.5);
    game.set_settings(settings(PHYSICS_V30, 800.0));
    assert_eq!(game.gravity_scale, 1.0, "Normal holds no Low Gravity multiplier");
    game.set_settings(settings(PHYSICS_V30, 400.0));
    assert_eq!(game.gravity_scale, 0.5);
    game.set_settings(settings(PHYSICS_V29, 400.0));
    assert_eq!(game.gravity_scale, 1.0, "v29 Low Gravity is 400 x 1");
    game.gravity_scale = -1.9;
    game.set_settings(settings(PHYSICS_V30, 400.0));
    assert_eq!(game.gravity_scale, -1.9, "a map's value stays");
}

/// A scripted run on bhop_eazy (no player gravity entities): air strafes that follow the turn, jumping, ducking,
/// standing still, walking forward.
fn scripted(t: u32) -> Cmd {
    let phase = t % 500;
    // Turn one way for 90 commands, then the other: 1.5 degrees per command, strafing into the turn.
    let dir = if (t / 90) % 2 == 0 { 1.0 } else { -1.0 };
    let yaw = ((t % 180) as f32).min(90.0) * 1.5 - ((t % 180) as f32 - 90.0).max(0.0) * 1.5 + (t / 180) as f32 * 7.0;
    let mut buttons = 0;
    if phase < 420 && (t / 9) % 6 != 0 {
        buttons |= IN_JUMP;
    }
    if (phase / 41) % 5 == 4 {
        buttons |= IN_DUCK;
    }
    let (forward, side) = match phase {
        0..40 => (400.0, 0.0),
        440..500 => (0.0, 0.0),
        _ => (0.0, -400.0 * dir),
    };
    Cmd { forward, side, yaw, pitch: 0.0, buttons }
}

#[test]
fn eazy_low_gravity_moves_bit_identically_on_v29_and_v30() {
    let (Some(mut old), Some(mut new)) = (load("bhop_eazy", settings(PHYSICS_V29, 400.0)), load("bhop_eazy", settings(PHYSICS_V30, 400.0)))
    else { return };
    let (mut airborne, mut jumps, mut moved, mut teleports) = (0, 0, 0.0f32, 0);
    for t in 0..6000 {
        let cmd = scripted(t);
        old.step(cmd).unwrap();
        new.step(cmd).unwrap();
        assert_eq!(old.state.position, new.state.position, "tick {t}");
        assert_eq!(old.state.velocity, new.state.velocity, "tick {t}");
        assert_eq!(old.state.ground.is_some(), new.state.ground.is_some(), "tick {t}");
        assert_eq!(old.events, new.events, "tick {t}");
        assert_eq!(old.touch_origin, new.touch_origin, "tick {t}");
        assert_eq!((old.gravity_scale, new.gravity_scale), (1.0, 0.5), "tick {t}: the multiplier never leaves 1 / 0.5 here");
        airborne += old.state.ground.is_none() as u32;
        jumps += (old.events & bunnyhop_core::game::EVENT_JUMPED != 0) as u32;
        let h = old.state.velocity[0].hypot(old.state.velocity[1]);
        moved += h * DT;
        teleports += (old.events & bunnyhop_core::game::EVENT_TELEPORTED != 0) as u32;
    }
    // The script really plays: jumps, long airborne stretches, distance covered.
    eprintln!("jumps {jumps}, airborne {airborne}, path {moved}, teleports {teleports}");
    assert!(jumps > 25 && airborne > 2000 && moved > 2000.0, "jumps {jumps}, airborne {airborne}, path {moved}");
}

#[test]
fn normal_is_identical_on_v29_and_v30() {
    let (Some(mut old), Some(mut new)) = (load("bhop_eazy", settings(PHYSICS_V29, 800.0)), load("bhop_eazy", settings(PHYSICS_V30, 800.0)))
    else { return };
    for t in 0..3000 {
        let cmd = scripted(t);
        old.step(cmd).unwrap();
        new.step(cmd).unwrap();
        assert_eq!(old.snapshot_bytes(), new.snapshot_bytes(), "tick {t}");
    }
}

/// What a standing jump from a booster pad does: the highest feet z and every z the player landed at.
#[derive(Debug)]
#[allow(dead_code)]
struct Launch {
    floor: f32,
    apex: f32,
    landings: Vec<f32>,
    lowest_scale: f32,
}

/// Stand on pad `model` (bhoptimer restart point: the first point of a grid over the pad, from its centre out, where the
/// player stands with the hull in the pad), jump straight up (jump held 3 commands) and follow the player for `ticks`
/// commands.
fn launch(map: &str, model: &str, s: Settings, ticks: u32) -> Option<Launch> {
    let mut game = load(map, s)?;
    let (lo, hi) = model_bounds(&game, model);
    let mut grid: Vec<[f32; 2]> = (0..=8)
        .flat_map(|i| (0..=8).map(move |j| [lo[0] + 16.0 + (hi[0] - lo[0] - 32.0) * i as f32 / 8.0, lo[1] + 16.0 + (hi[1] - lo[1] - 32.0) * j as f32 / 8.0]))
        .collect();
    let centre = [(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5];
    grid.sort_by(|a, b| (a[0] - centre[0]).hypot(a[1] - centre[1]).total_cmp(&(b[0] - centre[0]).hypot(b[1] - centre[1])));
    let spot = grid.into_iter().find(|p| {
        game.set_position([p[0], p[1], hi[2]], 0.0);
        for _ in 0..20 {
            game.step(Cmd::default()).unwrap();
        }
        let z = game.state.position[2];
        game.state.ground.is_some() && z <= hi[2] && z >= lo[2] - 0.5
    }).unwrap_or_else(|| panic!("{map} {model}: no floor in the pad"));
    game.set_position([spot[0], spot[1], hi[2]], 0.0);
    for _ in 0..20 {
        game.step(Cmd::default()).unwrap();
    }
    let floor = game.state.position[2];
    let (mut apex, mut landings, mut lowest_scale) = (floor, Vec::new(), game.gravity_scale);
    for t in 0..ticks {
        let grounded = game.state.ground.is_some();
        game.step(Cmd { buttons: if t < 3 { IN_JUMP } else { 0 }, ..Cmd::default() }).unwrap();
        apex = apex.max(game.state.position[2]);
        lowest_scale = lowest_scale.min(game.gravity_scale);
        if !grounded && game.state.ground.is_some() {
            landings.push(game.state.position[2]);
        }
        if t > 30 && game.state.ground.is_some() && game.state.velocity == [0.0; 3] {
            break;
        }
    }
    Some(Launch { floor, apex, landings, lowest_scale })
}

/// The pad launches today's Low Gravity short of what the route needs (`need`: the rise from the pad's floor to the
/// ledge the Normal route lands on, from the maps' Normal records, reports/lowgrav.md), and v30 Low Gravity past it.
fn check_booster(map: &str, model: &str, lift: f32, need: f32) {
    let Some(normal) = launch(map, model, settings(PHYSICS_V30, 800.0), 1500) else { return };
    let old = launch(map, model, settings(PHYSICS_V29, 400.0), 1500).unwrap();
    let new = launch(map, model, settings(PHYSICS_V30, 400.0), 1500).unwrap();
    let rise = |l: &Launch| l.apex - l.floor;
    eprintln!("{map} {model}: need {need}, rise normal {} / v29 Low Gravity {} / v30 Low Gravity {}", rise(&normal), rise(&old), rise(&new));
    for l in [&normal, &old, &new] {
        assert_eq!(l.lowest_scale, lift, "{map}: the pad's lift (v30 keeps it at full strength; v29 multiplies it by 400)");
    }
    assert!(rise(&normal) >= need, "{map}: Normal clears it");
    assert!(rise(&old) < need, "{map}: v29 Low Gravity tops out short");
    assert!(rise(&new) >= need, "{map}: v30 Low Gravity clears it");
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn bhop_24_booster_reaches_the_ledge() {
    // *2: OnEndTouch AddOutput gravity -1.9, then gravity 1 after 0.5 s. The ledge is at z -1400, the pad at -2352.
    check_booster("bhop_24", "*2", -1.9, 952.0);
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn bhop_gigaheish_fix_booster_reaches_the_platform() {
    // *41: OnEndTouch AddOutput gravity -1.5, then gravity 1 after 0.75 s. The platform is at z -6656, the pad at -7936.
    check_booster("bhop_gigaheish_fix", "*41", -1.5, 1280.0);
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn bhop_sativa_boosters_reach_their_ledges() {
    // *38: gravity -1.3 for 0.5 s, the Normal route rises 688. *40: gravity -1.7 for 0.5 s, about 867. (*70 carries the
    // same outputs but is a func_dustmotes: nothing touches it, in CS:S either.)
    check_booster("bhop_sativa", "*38", -1.3, 688.0);
    check_booster("bhop_sativa", "*40", -1.7, 867.0);
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn bhop_ponpon_fix_booster_reaches_the_ledge() {
    // *314: gravity -1.5 for 0.5 s, the Normal route rises 704.
    check_booster("bhop_ponpon_fix", "*314", -1.5, 704.0);
}

/// bhop_kirous's second-floor slam (*37: OnStartTouch AddOutput gravity 40 at 0.2 s, gravity 1 at 0.3 s): the slam
/// drives the player onto a 45 degree ramp of a half-pipe, which turns the fall into speed, and the far ramp turns that
/// into the rise to the top floor (z 576). The commands of sapphire's Segmented run from just above the block
/// (`low_gravity_v30/kirous_slam.txt`), replayed in each mode from the same placement. Returns the highest floor
/// landed on and the best horizontal speed.
fn kirous_slam(s: Settings) -> Option<(f32, f32)> {
    let text = include_str!("low_gravity_v30/kirous_slam.txt");
    let mut game = load("bhop_kirous", s)?;
    let vec3 = |l: &str| -> [f32; 3] {
        let v: Vec<f32> = l.split_whitespace().skip(1).map(|x| x.parse().unwrap()).collect();
        [v[0], v[1], v[2]]
    };
    let mut lines = text.lines().filter(|l| !l.starts_with('#'));
    let (position, velocity) = (vec3(lines.next().unwrap()), vec3(lines.next().unwrap()));
    let cmds: Vec<Cmd> = lines
        .map(|l| {
            let p: Vec<&str> = l.split_whitespace().collect();
            Cmd { forward: p[0].parse().unwrap(), side: p[1].parse().unwrap(), yaw: p[2].parse().unwrap(), pitch: p[3].parse().unwrap(), buttons: p[4].parse().unwrap() }
        })
        .collect();
    game.practice_noclip_exit(position, velocity, cmds[0].yaw, cmds[0].pitch);
    let (mut top, mut speed) = (f32::NEG_INFINITY, 0.0f32);
    for cmd in cmds {
        let grounded = game.state.ground.is_some();
        game.step(cmd).unwrap();
        speed = speed.max(game.state.velocity[0].hypot(game.state.velocity[1]));
        if !grounded && game.state.ground.is_some() {
            top = top.max(game.state.position[2]);
        }
    }
    Some((top, speed))
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn bhop_kirous_slam_reaches_the_top_floor() {
    let Some(normal) = kirous_slam(settings(PHYSICS_V30, 800.0)) else { return };
    let old = kirous_slam(settings(PHYSICS_V29, 400.0)).unwrap();
    let new = kirous_slam(settings(PHYSICS_V30, 400.0)).unwrap();
    eprintln!("bhop_kirous (highest landing, best horizontal speed): normal {normal:?}, v29 Low Gravity {old:?}, v30 Low Gravity {new:?}");
    assert!(normal.0 >= 575.0, "Normal lands on the top floor");
    assert!(old.0 < 575.0 && old.1 < 1000.0, "v29 Low Gravity: the halved slam leaves the player on the second floor");
    assert!(new.0 >= 575.0 && new.1 > 1400.0, "v30 Low Gravity lands on the top floor");
}

/// The strafe trainer's gain (`air_speed_gain`, display only) is reported in Low Gravity, at v29 and v30, on the same
/// ticks Normal reports it; jump stats (`jumpstats_valid`, which the anticheat reads) stay off in Low Gravity as before.
#[test]
fn strafe_gain_is_reported_in_low_gravity_and_jump_stats_stay_off() {
    let mut counts = Vec::new();
    for s in [settings(PHYSICS_V30, 800.0), settings(PHYSICS_V29, 400.0), settings(PHYSICS_V30, 400.0)] {
        let Some(mut game) = load("bhop_eazy", s) else { return };
        game.practice_noclip_exit([600.0, -352.0, 1200.0], [300.0, 0.0, 0.0], 0.0, 0.0);
        let (mut gains, mut valid) = (0, 0);
        for t in 0..60u32 {
            // Strafe right, turning right: a clean AirAccelerate tick every command.
            let cmd = Cmd { side: 400.0, yaw: -(t as f32) * 2.0, ..Cmd::default() };
            game.step(cmd).unwrap();
            if let Some([gain, best]) = game.air_speed_gain {
                assert!(gain.is_finite() && best > 0.0, "{s:?} tick {t}");
                gains += 1;
            }
            valid += game.jumpstats_valid as u32;
        }
        assert_eq!(valid == 0, s.gravity != 800.0, "jump stats: Normal only ({s:?}, {valid})");
        counts.push(gains);
    }
    assert!(counts[0] > 50, "Normal reports the gain: {counts:?}");
    assert_eq!(counts[1], counts[0], "v29 Low Gravity reports it on the same ticks");
    assert_eq!(counts[2], counts[0], "v30 Low Gravity reports it on the same ticks");
}
