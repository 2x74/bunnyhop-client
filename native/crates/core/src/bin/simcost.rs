//! What one tick of a map costs the verifier, for finding maps like bhop_overground_fix: its entities, how many of its
//! brush entities move on their own, how many I/O events it fires per tick, and the simulated time per tick.
//!
//!   simcost [--ticks N] <map.bsp>...       one line per map, tab separated, one map at a time on one thread
//!
//! The input is simcli's scripted strafe-jump, which rarely leaves the spawn room. So after the timed ticks, every named
//! door, button, relay, counter and timer gets its usual inputs at once (`poked`), for what a run could wake up: the
//! peak events per tick, how many of the last 300 ticks stayed above 1000 events, and the time per tick over those.
use bunnyhop_core::{Cmd, Game, content::load_game, game::IN_JUMP};
use std::path::Path;

const POKE_TICKS: u32 = 600;
const SUSTAINED_EVENTS: u64 = 1000;

fn scripted(game: &mut Game, n: u32, yaw: &mut f32) -> bool {
    let side = if (n / 40) % 2 == 0 { 400.0 } else { -400.0 };
    *yaw += if side > 0.0 { -1.0 } else { 1.0 };
    let forward = if n < 20 { 400.0 } else { 0.0 };
    game.step(Cmd { forward, side, yaw: *yaw, pitch: 0.0, buttons: IN_JUMP }).is_ok()
}

fn poke(game: &mut Game) {
    let named: Vec<(String, String)> = game.entities.iter()
        .filter_map(|e| Some((e.get("targetname").filter(|n| !n.is_empty())?.to_string(), e.classname().to_ascii_lowercase())))
        .collect();
    for (name, class) in named {
        let inputs: &[(&str, &str)] = match class.as_str() {
            c if c.starts_with("func_door") || c == "func_movelinear" => &[("Open", ""), ("Close", "")],
            "func_button" | "func_rot_button" => &[("Press", "")],
            "logic_relay" => &[("Trigger", "")],
            "logic_timer" => &[("Enable", ""), ("FireTimer", "")],
            "math_counter" => &[("Add", "1")],
            _ => &[("FireUser1", "")],
        };
        for (input, param) in inputs {
            game.fire_input(&name, input, param);
        }
    }
}

fn main() {
    let mut ticks = 3000u32;
    let mut maps = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--ticks" => ticks = args.next().and_then(|s| s.parse().ok()).expect("--ticks N"),
            a => maps.push(a.to_string()),
        }
    }
    assert!(!maps.is_empty(), "usage: simcost [--ticks N] <map.bsp>...");
    println!("map\tents\tmovers\tmoving\tevents/tick\tqueue\tload_ms\tms/tick\tpoked_peak\tpoked_sustained\tpoked_ms/tick\tskipped");
    for path in maps {
        let name = Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let t0 = std::time::Instant::now();
        let mut game = match load_game(Path::new(&path)) {
            Ok(game) => game,
            Err(e) => {
                println!("{name}\tload failed: {e}");
                continue;
            }
        };
        let load_ms = t0.elapsed().as_secs_f64() * 1e3;
        let movers = game.entities.iter().filter(|e| {
            let c = e.classname().to_ascii_lowercase();
            c.starts_with("func_door") || matches!(c.as_str(), "func_rotating" | "func_tracktrain" | "func_movelinear" | "func_button" | "func_rot_button")
        }).count();
        let mut yaw = game.spawn_angles[1];
        let mut moving = 0;
        let t1 = std::time::Instant::now();
        let mut timed = 0.0;
        for n in 0..ticks {
            if !scripted(&mut game, n, &mut yaw) {
                break;
            }
            // A mover waiting at either end isn't moving: look across 2 s, outside the timing.
            if n == ticks / 2 {
                timed = t1.elapsed().as_secs_f64();
                let before = game.brush_transforms();
                let (save, mut y) = (game.save_state(), yaw);
                for k in 0..200 {
                    scripted(&mut game, n + k, &mut y);
                }
                moving = before.into_iter().zip(game.brush_transforms()).filter(|(a, b)| a != b).count();
                game.restore_state(&save);
                timed -= t1.elapsed().as_secs_f64();
            }
        }
        let ms = (t1.elapsed().as_secs_f64() + timed) * 1e3 / f64::from(ticks);
        let fired = game.events_fired() as f64 / f64::from(ticks);
        let queue = game.queued_events();
        let skipped = game.events_skipped;

        poke(&mut game);
        let (mut peak, mut sustained, mut poked_ms) = (0u64, 0u32, 0.0);
        let mut fired_before = game.events_fired();
        for n in 0..POKE_TICKS {
            let t = std::time::Instant::now();
            if !scripted(&mut game, ticks + n, &mut yaw) {
                break;
            }
            let dt = t.elapsed().as_secs_f64();
            let events = game.events_fired() - fired_before;
            fired_before = game.events_fired();
            peak = peak.max(events);
            if n >= POKE_TICKS - 300 {
                poked_ms += dt * 1e3 / 300.0;
                sustained += u32::from(events >= SUSTAINED_EVENTS);
            }
        }
        println!("{name}\t{}\t{movers}\t{moving}\t{fired:.1}\t{queue}\t{load_ms:.0}\t{ms:.4}\t{peak}\t{sustained}\t{poked_ms:.4}\t{skipped}", game.entities.len());
    }
}
