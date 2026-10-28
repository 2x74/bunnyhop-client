//! Movement anomaly hunter: drives deterministic pseudo-random bhop bots around maps and reports
//! things that feel wrong in play: ending a tick inside solid (stuck), position pops without a
//! teleport, ground/air flicker without jumping, sudden airborne speed loss, step errors.
//!
//! usage: fuzz [--ticks N] [--bots N] [--tick-interval S] <map.bsp>...
use bunnyhop_core::{
    Cmd, Game, Settings,
    game::{EVENT_JUMPED, EVENT_RESPAWNED, EVENT_TELEPORTED, IN_DUCK, IN_JUMP, IN_USE},
};
use std::collections::BTreeMap;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 32) as u32
    }
    fn unit(&mut self) -> f32 {
        self.next() as f32 / u32::MAX as f32
    }
}

#[derive(Default)]
struct Report {
    ticks: u64,
    stuck: u64,
    pops: u64,
    flicker: u64,
    air_stops: u64,
    errors: u64,
    respawns: u64,
    examples: BTreeMap<&'static str, Vec<String>>,
}

impl Report {
    fn note(&mut self, kind: &'static str, msg: String) {
        let list = self.examples.entry(kind).or_default();
        if list.len() < 6 {
            list.push(msg);
        }
    }
}

fn main() {
    let mut ticks = 20_000u32;
    let mut bots = 8u32;
    let mut interval = 0.01f32;
    let mut maps = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--ticks" => ticks = args.next().unwrap().parse().unwrap(),
            "--bots" => bots = args.next().unwrap().parse().unwrap(),
            "--tick-interval" => interval = args.next().unwrap().parse().unwrap(),
            _ => maps.push(a),
        }
    }
    for path in maps {
        let bytes = std::fs::read(&path).unwrap();
        let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
        let mut game = Game::load_with_content(&bsp, bunnyhop_core::content::cached_physics_content(std::path::Path::new(&path))).unwrap();
        game.set_settings(Settings { tick_interval: interval, ..Settings::css_bhop() });
        let mut starts: Vec<([f32; 3], f32)> = vec![(game.spawn_origin, game.spawn_angles[1])];
        for t in game.teleports() {
            if let Some(d) = t.destination {
                starts.push((d, 0.0));
            }
        }
        starts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        starts.dedup_by(|a, b| a.0 == b.0);
        let mut report = Report::default();
        let t0 = std::time::Instant::now();
        for bot in 0..bots {
            run_bot(&mut game, &starts, bot, ticks, &mut report);
        }
        let elapsed = t0.elapsed();
        println!(
            "== {path} ({} ticks, {:.0} ticks/s): stuck {} pops {} flicker {} air-stops {} errors {} respawns {}",
            report.ticks,
            report.ticks as f64 / elapsed.as_secs_f64(),
            report.stuck,
            report.pops,
            report.flicker,
            report.air_stops,
            report.errors,
            report.respawns
        );
        for (kind, list) in &report.examples {
            for m in list {
                println!("  {kind}: {m}");
            }
        }
    }
}

fn run_bot(game: &mut Game, starts: &[([f32; 3], f32)], bot: u32, ticks: u32, report: &mut Report) {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15 ^ (bot as u64 + 1).wrapping_mul(0x1000_0000_01b3));
    game.reset();
    let (start, yaw0) = starts[bot as usize % starts.len()];
    if bot > 0 {
        game.place_player(start);
    }
    let mut yaw = yaw0;
    let mut turn = 0.0f32;
    let mut mode = 0u32;
    let mut mode_ticks = 0u32;
    let mut history: Vec<(bool, bool)> = Vec::new(); // (grounded, jump pressed)
    let dt = game.settings.tick_interval;
    let mut trail: Vec<String> = Vec::new();
    let mut history_states: Vec<(playsrc_movement::State, Cmd)> = Vec::new();
    let verbose = std::env::var_os("FUZZ_TRAIL").is_some();
    for n in 0..ticks {
        if mode_ticks == 0 {
            mode = rng.next() % 6;
            mode_ticks = 20 + rng.next() % 200;
            turn = (rng.unit() - 0.5) * 6.0;
            if rng.next() % 40 == 0 {
                let (p, y) = starts[(rng.next() as usize) % starts.len()];
                game.place_player(p);
                yaw = y;
            }
        }
        mode_ticks -= 1;
        // Strafe-sync turning with alternating direction, sometimes forward, sometimes duck.
        let side = if (n / 37) % 2 == 0 { 400.0 } else { -400.0 };
        let (forward, side, buttons) = match mode {
            0 => (400.0, 0.0, IN_JUMP),
            1 => (0.0, side, IN_JUMP),
            2 => (0.0, side, IN_JUMP | IN_DUCK),
            3 => (400.0, side * 0.5, 0),
            4 => (0.0, side, IN_JUMP | if n % 3 == 0 { IN_DUCK } else { 0 }),
            _ => (-400.0 * (rng.unit() - 0.3), side, if rng.next() % 2 == 0 { IN_JUMP } else { 0 }),
        };
        yaw += if side > 0.0 { -turn.abs() } else { turn.abs() };
        let before = game.state;
        // +use now and then (doors, buttons).
        let buttons = buttons | if n % 47 < 2 { IN_USE } else { 0 };
        let cmd = Cmd { forward, side, yaw, pitch: 0.0, buttons };
        history_states.push((before, cmd));
        if history_states.len() > 4 {
            history_states.remove(0);
        }
        let errors_before = game.movement_errors;
        let result = game.step(cmd);
        report.ticks += 1;
        if game.movement_errors != errors_before {
            report.errors += 1;
            report.note("error", format!("{} at {:?}", game.last_movement_error, before.position));
        }
        if let Err(e) = result {
            report.errors += 1;
            report.note("error", format!("{e} at {:?}", before.position));
            game.place_player(start);
            continue;
        }
        let s = game.state;
        let ev = game.events;
        if ev & EVENT_RESPAWNED != 0 {
            report.respawns += 1;
            report.note("respawn", format!("from {:?} vel {:?} health {}", before.position, before.velocity, game.health));
        }
        if ev & (EVENT_TELEPORTED | EVENT_RESPAWNED) != 0 || s.base_velocity != [0.0; 3] || before.base_velocity != [0.0; 3] {
            history.clear();
            continue;
        }
        // Stuck: the tick ended with the hull overlapping solid.
        let t = game.trace_player_hull(s.position, s.position);
        if verbose {
            trail.push(format!("tick {n} pos {:?} vel {:?} ground {} cmd ({forward},{side},{yaw:.1},{buttons})", s.position, s.velocity, s.ground.is_some()));
            if trail.len() > 12 {
                trail.remove(0);
            }
        }
        if t.start_solid {
            if verbose && report.stuck == 0 {
                println!("first stuck, trail:\n  {}", trail.join("\n  "));
                println!("  before: {before:?}");
                println!("  after: {s:?}");
                println!("  stuck hit {:x?} contents {:#x}", t.hit, t.contents);
                let saved = game.state;
                game.state = history_states[0].0;
                for (st, c) in history_states.clone() {
                    println!("  replay from {:?} {:?} cmd {c:?}", st.position, st.crouch.phase);
                    game.step(c).unwrap();
                    let free = !game.trace_player_hull(game.state.position, game.state.position).start_solid;
                    println!("    -> {:?} {:?} ground {} free {free}", game.state.position, game.state.crouch.phase, game.state.ground.is_some());
                }
                game.state = saved;
            }
            report.stuck += 1;
            report.note("stuck", format!("{:?} vel {:?} ground {}", s.position, s.velocity, s.ground.is_some()));
        }
        // Pops: moved much further than velocity allows (movers carry up to their speed).
        let moved = ((s.position[0] - before.position[0]).powi(2)
            + (s.position[1] - before.position[1]).powi(2)
            + (s.position[2] - before.position[2]).powi(2))
        .sqrt();
        let vmax = before.velocity.iter().chain(&s.velocity).map(|v| v.abs()).fold(0.0, f32::max) * 1.8;
        let allowed = vmax * dt + 19.0;
        if moved > allowed {
            report.pops += 1;
            report.note("pop", format!("{:?} -> {:?} ({moved:.1} > {allowed:.1})", before.position, s.position));
        }
        // Airborne speed loss: more than half the horizontal speed gone in one airborne tick
        // (walls do this legitimately; reported for review).
        let h = |v: [f32; 3]| (v[0] * v[0] + v[1] * v[1]).sqrt();
        if before.ground.is_none() && s.ground.is_none() && h(before.velocity) > 300.0 && h(s.velocity) < h(before.velocity) * 0.5 {
            report.air_stops += 1;
            report.note("air-stop", format!("{:?} {:.0} -> {:.0}", s.position, h(before.velocity), h(s.velocity)));
        }
        // Ground flicker: grounded, airborne, grounded again within 3 ticks without a jump.
        let jumped = ev & EVENT_JUMPED != 0;
        history.push((s.ground.is_some(), jumped));
        if history.len() > 4 {
            history.remove(0);
        }
        if history.len() == 4 {
            let g: Vec<bool> = history.iter().map(|h| h.0).collect();
            let any_jump = history.iter().any(|h| h.1);
            if !any_jump && g[0] && !g[1] && (g[2] || g[3]) && s.velocity[2].abs() < 200.0 {
                if verbose && report.flicker == 0 {
                    println!("first flicker, trail:\n  {}", trail.join("\n  "));
                }
                report.flicker += 1;
                report.note("flicker", format!("{:?} vel {:?}", s.position, s.velocity));
                history.clear();
            }
        }
    }
}
