//! RNGFix sub-tick sweeps (research/RNGFIX-1025.md): starts an airborne player at many sub-tick offsets along their
//! horizontal velocity, holds jump (autohop) with no other input, and reports what the first slope / ledge / ground
//! interaction leaves them with, per physics version. Small and targeted: one spot, a few hundred short runs.
//!
//!   rngfixsim <map.bsp> floor <x> <y> <ztop>
//!   rngfixsim <map.bsp> sweep --pos x,y,z --vel x,y,z [--versions 16,17] [--phases 60] [--step U] [--dz U]
//!                             [--ticks 60] [--after 10] [--no-jump] [-v]
//!
//! `floor` prints what a standing hull lands on below (x, y, ztop). `sweep` runs `--phases` starts: the i-th is
//! `pos + dir * i * step + (0, 0, i * dz)` (dir: the horizontal velocity's direction; `step` defaults to one tick's
//! travel / phases, so the starts cover every sub-tick phase once). Per run it reports the first tick where the
//! horizontal speed changed by more than 1 u/s or the player touched the ground ("impact"), the horizontal speed
//! right after it, `--after` ticks later, and the largest vz in between (sent up the slope or not).

use bunnyhop_core::game::{IN_JUMP, PHYSICS_V1};
use bunnyhop_core::{Cmd, Game, Settings};

fn floats(s: &str) -> Vec<f32> {
    s.split(',').map(|v| v.trim().parse::<f32>().expect("number")).collect()
}

struct Run {
    impact_tick: Option<u32>,
    impact_pos: [f32; 3],
    speed_impact: f32,
    speed_after: f32,
    max_vz: f32,
    landed: bool,
}

fn run(game: &mut Game, pos: [f32; 3], vel: [f32; 3], yaw: f32, jump: bool, ticks: u32, after: u32) -> Run {
    game.reset();
    game.place_player(pos);
    game.state.velocity = vel;
    let h = |v: [f32; 3]| v[0].hypot(v[1]);
    let mut out = Run { impact_tick: None, impact_pos: [0.0; 3], speed_impact: h(vel), speed_after: h(vel), max_vz: f32::MIN, landed: false };
    let mut prev = h(vel);
    for t in 0..ticks {
        let cmd = Cmd { forward: 0.0, side: 0.0, yaw, pitch: 0.0, buttons: if jump { IN_JUMP } else { 0 } };
        game.step(cmd).expect("step");
        let s = &game.state;
        let speed = h(s.velocity);
        if std::env::var_os("RNGFIXSIM_TRACE").is_some() {
            eprintln!("  t{t} pos {:?} vel {:?} ground {:?} events {}", s.position, s.velocity, s.ground.map(|g| g.normal), game.events);
        }
        match out.impact_tick {
            None => {
                if (speed - prev).abs() > 1.0 || s.ground.is_some() {
                    out.impact_tick = Some(t);
                    out.impact_pos = s.position;
                    out.speed_impact = speed;
                    out.speed_after = speed;
                    out.max_vz = s.velocity[2];
                    out.landed = s.ground.is_some();
                }
            }
            Some(i) if t <= i + after => {
                out.speed_after = speed;
                out.max_vz = out.max_vz.max(s.velocity[2]);
                out.landed |= s.ground.is_some();
            }
            _ => break,
        }
        prev = speed;
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert!(args.len() >= 3, "usage: rngfixsim <map.bsp> floor|sweep ...");
    let bytes = std::fs::read(&args[1]).expect("read map");
    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("parse map");
    let mut game = Game::load(&bsp).expect("load map");
    match args[2].as_str() {
        "floor" => {
            let v: Vec<f32> = args[3..6].iter().map(|a| a.parse().unwrap()).collect();
            let t = game.trace_player_hull([v[0], v[1], v[2]], [v[0], v[1], v[2] - 4096.0]);
            println!("end {:?} normal {:?} fraction {} start_solid {}", t.end, t.normal, t.fraction, t.start_solid);
        }
        "normals" => {
            // Reads "<id> <tick> x y z ..." lines (scripts' landing dumps) on stdin and appends the normal of what a
            // standing hull finds within 4 units below (the plane it landed on, or clipped on).
            use std::io::BufRead;
            for line in std::io::stdin().lock().lines() {
                let line = line.unwrap();
                let f: Vec<&str> = line.split_whitespace().collect();
                let p: [f32; 3] = [f[2].parse().unwrap(), f[3].parse().unwrap(), f[4].parse().unwrap()];
                let t = game.trace_player_hull([p[0], p[1], p[2] + 0.5], [p[0], p[1], p[2] - 4.0]);
                let n = t.normal.unwrap_or([0.0; 3]);
                println!("{line} n {:.3} {:.3} {:.3}", n[0], n[1], n[2]);
            }
        }
        "fan" => {
            // fan <x,y,z> <speed> <yaw0> <yaw1> <step> [version...]: standing at (x, y, z) with `speed` along each yaw,
            // jump held (autohop) and no other input for 150 ticks; prints every tick that loses more than 150 u/s of
            // horizontal speed (no teleport) with where and on what ground.
            let pos: [f32; 3] = floats(&args[3]).try_into().unwrap();
            let speed: f32 = args[4].parse().unwrap();
            let (y0, y1, ys): (f32, f32, f32) = (args[5].parse().unwrap(), args[6].parse().unwrap(), args[7].parse().unwrap());
            let versions: Vec<u32> = if args.len() > 8 { args[8..].iter().map(|v| v.parse().unwrap()).collect() } else { vec![16, 17] };
            for &version in &versions {
                game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
                let mut yaw = y0;
                while yaw <= y1 + 1e-3 {
                    game.reset();
                    game.place_player(pos);
                    let r = yaw.to_radians();
                    game.state.velocity = [speed * r.cos(), speed * r.sin(), 0.0];
                    let h = |v: [f32; 3]| v[0].hypot(v[1]);
                    let mut prev = speed;
                    for t in 0..150 {
                        game.step(Cmd { forward: 0.0, side: 0.0, yaw, pitch: 0.0, buttons: IN_JUMP }).expect("step");
                        let s = &game.state;
                        let sp = h(s.velocity);
                        if game.events & 1 != 0 {
                            println!("v{version} yaw {yaw:6.1} t{t:3} teleported to {:?}", s.position.map(|v| v.round()));
                            break;
                        }
                        if prev - sp > 150.0 {
                            println!(
                                "v{version} yaw {yaw:6.1} t{t:3} at [{:.0} {:.0} {:.0}] {prev:.0} -> {sp:.0} vz {:.0} ground {:?}",
                                s.position[0], s.position[1], s.position[2], s.velocity[2], s.ground.map(|g| g.normal.map(|n| (n * 1000.0).round() / 1000.0))
                            );
                            break;
                        }
                        prev = sp;
                    }
                    yaw += ys;
                }
            }
        }
        "sweep" => {
            let mut pos = [0.0; 3];
            let mut vel = [0.0; 3];
            let mut versions = vec![16, 17];
            let (mut phases, mut step, mut dz, mut ticks, mut after, mut jump, mut verbose) = (60usize, None, 0.0f32, 80u32, 10u32, true, false);
            let mut i = 3;
            while i < args.len() {
                let next = args.get(i + 1).cloned().unwrap_or_default();
                match args[i].as_str() {
                    "--pos" => pos = floats(&next).try_into().unwrap(),
                    "--vel" => vel = floats(&next).try_into().unwrap(),
                    "--versions" => versions = floats(&next).into_iter().map(|v| v as u32).collect(),
                    "--phases" => phases = next.parse().unwrap(),
                    "--step" => step = Some(next.parse::<f32>().unwrap()),
                    "--dz" => dz = next.parse().unwrap(),
                    "--ticks" => ticks = next.parse().unwrap(),
                    "--after" => after = next.parse().unwrap(),
                    "--no-jump" => {
                        jump = false;
                        i += 1;
                        continue;
                    }
                    "-v" => {
                        verbose = true;
                        i += 1;
                        continue;
                    }
                    a => panic!("unknown arg {a}"),
                }
                i += 2;
            }
            let hs = vel[0].hypot(vel[1]);
            let dir = [vel[0] / hs, vel[1] / hs];
            let yaw = vel[1].atan2(vel[0]).to_degrees();
            let step = step.unwrap_or(hs * 0.01 / phases as f32);
            for &version in &versions {
                let settings = Settings { physics_version: version.max(PHYSICS_V1), ..Settings::css_bhop() };
                game.set_settings(settings);
                let mut results = Vec::new();
                for k in 0..phases {
                    let p = [pos[0] + dir[0] * step * k as f32, pos[1] + dir[1] * step * k as f32, pos[2] + dz * k as f32];
                    let r = run(&mut game, p, vel, yaw, jump, ticks, after);
                    if verbose {
                        println!(
                            "v{version} phase {k:3} impact t{:?} at [{:.1} {:.1} {:.1}] speed {:.0} -> {:.0} after {after} ticks, max vz {:.0}{}",
                            r.impact_tick, r.impact_pos[0], r.impact_pos[1], r.impact_pos[2], r.speed_impact, r.speed_after, r.max_vz,
                            if r.landed { ", landed" } else { "" }
                        );
                    }
                    results.push(r);
                }
                let s: Vec<f32> = results.iter().map(|r| r.speed_after).collect();
                let lo = s.iter().copied().fold(f32::INFINITY, f32::min);
                let hi = s.iter().copied().fold(f32::NEG_INFINITY, f32::max);
                let mean = s.iter().sum::<f32>() / s.len() as f32;
                let below = |x: f32| s.iter().filter(|&&v| v < x).count();
                println!(
                    "v{version}: {} runs, speed {after} ticks after impact {lo:.0}..{hi:.0} (mean {mean:.0}); < 300: {}, < 500: {}, >= {:.0}: {}",
                    s.len(),
                    below(300.0),
                    below(500.0),
                    hs - 1.0,
                    s.iter().filter(|&&v| v >= hs - 1.0).count()
                );
            }
        }
        a => panic!("unknown command {a}"),
    }
}
