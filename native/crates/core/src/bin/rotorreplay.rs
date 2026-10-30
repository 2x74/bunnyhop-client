//! Follows a stretch of a real recording with a func_rotating at each start angle, seated at the recorded state every
//! few frames: a recording doesn't say where the server's rotor was, so this finds the angles that reproduce it.
//! Not a route search: the commands are the recording's. Frames from research/parented-doors-v21/recording-job.ts.
//!
//!   rotorreplay <map.bsp> <physics> <frames.txt> <from> <to> <rotor model> <x> <y> <z> <step deg> [<seat every>] [<airaccel>]
//!
//! x y z: where the player waits inside the trigger that runs the rotor. One row per start angle: the recorded teleports
//! the map reproduced (within 3 ticks), the ones it missed, the ones it made that the recording doesn't have (the player is
//! seated back on the recording after each), the error before each seat, and the last position. Then the best angles.
use bunnyhop_core::game::EVENT_TELEPORTED;
use bunnyhop_core::{content, Cmd, Game};
use playsrc_movement::{CrouchState, Mode};

struct Frame {
    cmd: Cmd,
    pos: [f32; 3],
    vel: [f32; 3],
    flags: u32,
    teleport: bool,
}

fn seat(game: &mut Game, f: &Frame) {
    game.state.crouch = if f.flags & 2 != 0 { CrouchState::CROUCHED } else { CrouchState::STANDING };
    game.state.mode = Mode::Walk;
    let base = game.state.base_velocity;
    game.place_player(f.pos);
    game.state.base_velocity = base;
    game.state.velocity = f.vel.map(|v| v.clamp(-3500.0, 3500.0));
    game.state.fall_speed = if f.flags & 1 != 0 { 0.0 } else { (-f.vel[2]).max(0.0) };
    game.state.jump_latched = false;
    game.state_after_command = game.state;
}

#[derive(Default)]
struct Row {
    phase: f32,
    reproduced: Vec<usize>,
    missed: Vec<usize>,
    extra: Vec<usize>,
    worst: f32,
    p95: f32,
    last: [f32; 3],
}

fn follow(game: &mut Game, frames: &[Frame], from: usize, to: usize, every: usize) -> Row {
    let near = |a: usize, b: usize| a.abs_diff(b) <= 3;
    let recorded: Vec<usize> = (from + 1..to).filter(|&i| frames[i].teleport).collect();
    let mut row = Row::default();
    let (mut errors, mut since) = (Vec::new(), 0usize);
    seat(game, &frames[from]);
    for i in from + 1..to {
        let f = &frames[i];
        game.step(f.cmd).unwrap();
        let teleported = game.events & EVENT_TELEPORTED != 0;
        if teleported {
            if recorded.iter().any(|&r| near(r, i)) {
                row.reproduced.push(i);
            } else {
                row.extra.push(i);
            }
            seat(game, f);
            since = 0;
            continue;
        }
        if f.teleport {
            // A teleport the map didn't make here: follow the recording.
            seat(game, f);
            since = 0;
            continue;
        }
        since += 1;
        if since >= every {
            let p = game.state_after_command.position;
            errors.push((0..3).map(|k| (p[k] - f.pos[k]).powi(2)).sum::<f32>().sqrt());
            seat(game, f);
            since = 0;
        }
    }
    row.missed = recorded.iter().copied().filter(|&r| !row.reproduced.iter().any(|&i| near(r, i))).collect();
    errors.sort_by(f32::total_cmp);
    row.worst = errors.last().copied().unwrap_or(0.0);
    row.p95 = errors.get(errors.len() * 95 / 100).copied().unwrap_or(0.0);
    row.last = game.state.position;
    row
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let [map, physics, frames_path, from, to, rotor, x, y, z, step] = &a[1..11] else { panic!("see the header") };
    let every: usize = a.get(11).map_or(25, |s| s.parse().unwrap());
    let air: f32 = a.get(12).map_or(1337.0, |s| s.parse().unwrap());
    let (from, to, rotor, step): (usize, usize, u32, f32) =
        (from.parse().unwrap(), to.parse().unwrap(), rotor.parse().unwrap(), step.parse().unwrap());
    let pad: [f32; 3] = [x.parse().unwrap(), y.parse().unwrap(), z.parse().unwrap()];
    let mut game = content::load_game(std::path::Path::new(map)).unwrap();
    let mut settings = game.settings;
    settings.physics_version = physics.parse().unwrap();
    settings.autohop = true;
    settings.air_accelerate = air;
    settings.max_speed = 260.0;
    game.set_settings(settings);
    game.reset();
    let frames: Vec<Frame> = std::fs::read_to_string(frames_path)
        .unwrap()
        .lines()
        .map(|l| {
            let p: Vec<f32> = l.split_whitespace().map(|v| v.parse().unwrap()).collect();
            Frame {
                cmd: Cmd { forward: p[0], side: p[1], yaw: p[2], pitch: p[3], buttons: p[4] as u32 },
                pos: [p[5], p[6], p[7]],
                vel: [p[8], p[9], p[10]],
                flags: p[11] as u32,
                teleport: p[13] != 0.0,
            }
        })
        .collect();
    let to = to.min(frames.len());
    let angle = |g: &Game| {
        let t = g.brush_transforms().into_iter().find(|b| b.0 == rotor).unwrap().2;
        (if t[2] != 0.0 { t[2] } else { t[1] }).rem_euclid(360.0)
    };
    // The rotor only runs while the player is in its trigger: wait there, then try each start angle from a saved state.
    game.set_position(pad, 0.0);
    let (mut rows, mut wanted, mut guard) = (Vec::new(), 0.0f32, 0);
    while wanted < 360.0 && guard < 60000 {
        guard += 1;
        if (angle(&game) - wanted).rem_euclid(360.0) >= 180.0 {
            game.set_position(pad, 0.0);
            game.step(Cmd::default()).unwrap();
            continue;
        }
        let saved = game.save_state();
        let phase = angle(&game);
        let mut row = follow(&mut game, &frames, from, to, every);
        row.phase = phase;
        println!(
            "phase {phase:6.1} reproduced {:>2} missed {:>2} extra {:>2} worst {:7.1} p95 {:6.1} last {:.0},{:.0},{:.0} extra_at {:?} missed_at {:?}",
            row.reproduced.len(), row.missed.len(), row.extra.len(), row.worst, row.p95, row.last[0], row.last[1], row.last[2], row.extra, row.missed
        );
        rows.push(row);
        game.restore_state(&saved);
        wanted += step;
        game.set_position(pad, 0.0);
        game.step(Cmd::default()).unwrap();
    }
    let best = rows.iter().min_by_key(|r| (r.missed.len() + r.extra.len(), (r.p95 * 10.0) as i64)).unwrap();
    println!(
        "summary frames {from}..{to} physics {physics}: best start angle {:.1}: reproduced {}, missed {}, extra {}, worst {:.1}, p95 {:.1}, last {:?}",
        best.phase, best.reproduced.len(), best.missed.len(), best.extra.len(), best.worst, best.p95, best.last
    );
}
