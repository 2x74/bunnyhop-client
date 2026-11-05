//! Ramp-stop probe (physics v25 ramp fix, research/NATIVE-RAMP-V25.md). Places the player at a point with a velocity,
//! feeds commands and reports, while airborne:
//! - stops: speed falls from >= 50 to < 5 u/s in one tick;
//! - hard stops: speed falls from > 400 to < 40 u/s in one tick (a slide stopped dead);
//! - kills: horizontal speed falls from >= 80 to under 30% of itself in one tick;
//! - freezes: the player doesn't move for 3+ ticks in a row (longest streak).
//!
//! A teleport (> 64 units in one tick) ends the scenario.
//!
//!   rampslide <map.bsp> <physics> x y z vx vy vz yaw forward side buttons ticks [-v]
//!   rampslide <map.bsp> <physics> --grid <file>     one scenario per line: x y z vx vy vz yaw forward side buttons ticks
//!   rampslide <map.bsp> <physics> --slices <file>   one per line: "id x y z vx vy vz|f s yaw pitch buttons;..." (slices of
//!                                                    real runs, e.g. perturbed bhoptimer replays)
//!
//! `-v` prints every tick (position, velocity, horizontal / total speed, ground); env `RAMPSLIDE_EVENTS` prints each kill.
use bunnyhop_core::{Cmd, Game};

struct Scenario {
    id: String,
    origin: [f32; 3],
    velocity: [f32; 3],
    cmds: Vec<Cmd>,
}

fn parse_grid(i: usize, v: &[&str]) -> Scenario {
    let f = |k: usize| v[k].parse::<f32>().expect("number");
    let cmd = Cmd { yaw: f(6), pitch: 0.0, forward: f(7), side: f(8), buttons: v[9].parse().expect("buttons") };
    let ticks: usize = v[10].parse().expect("ticks");
    Scenario { id: format!("#{i}"), origin: [f(0), f(1), f(2)], velocity: [f(3), f(4), f(5)], cmds: vec![cmd; ticks] }
}

fn parse_slice(line: &str) -> Scenario {
    let (head, cmds) = line.split_once('|').expect("id x y z vx vy vz|cmds");
    let h: Vec<&str> = head.split_whitespace().collect();
    let v: Vec<f32> = h[1..7].iter().map(|x| x.parse().expect("number")).collect();
    let cmds = cmds
        .split(';')
        .filter(|c| !c.trim().is_empty())
        .map(|c| {
            let p: Vec<f32> = c.split_whitespace().map(|x| x.parse().expect("number")).collect();
            Cmd { forward: p[0], side: p[1], yaw: p[2], pitch: p[3], buttons: p[4] as u32 }
        })
        .collect();
    Scenario { id: h[0].to_string(), origin: [v[0], v[1], v[2]], velocity: [v[3], v[4], v[5]], cmds }
}

#[derive(Default)]
struct Outcome {
    stops: u32,
    hard_stops: u32,
    kills: u32,
    frozen_ticks: u32,
    longest_freeze: u32,
    first: String,
    end: [f32; 3],
    distance: f32,
}

fn length(v: [f32; 3]) -> f32 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

fn run(game: &mut Game, physics: u32, s: &Scenario, verbose: bool, events: bool) -> Outcome {
    let mut settings = game.settings;
    settings.physics_version = physics;
    settings.autohop = true;
    game.set_settings(settings);
    game.reset();
    game.state.position = s.origin;
    game.state.velocity = s.velocity;
    game.state.ground = None;
    let mut out = Outcome::default();
    let mut previous = (s.origin, s.velocity);
    let mut streak = 0;
    for (tick, cmd) in s.cmds.iter().enumerate() {
        if game.step(*cmd).is_err() {
            break;
        }
        let p = game.state.position;
        let v = game.state.velocity;
        let speed = length(v);
        let before = length(previous.1);
        let moved = length([p[0] - previous.0[0], p[1] - previous.0[1], p[2] - previous.0[2]]);
        let airborne = game.state.ground.is_none();
        if moved > 64.0 {
            break;
        }
        out.distance += moved;
        let note = |what: &str, out: &mut Outcome| {
            if out.first.is_empty() {
                out.first = format!("{what} t{tick} [{:.2} {:.2} {:.2}] from {before:.0}", p[0], p[1], p[2]);
            }
        };
        if airborne && before >= 50.0 && speed < 5.0 {
            out.stops += 1;
        }
        if airborne && before > 400.0 && speed < 40.0 {
            out.hard_stops += 1;
            note("hard-stop", &mut out);
        }
        let h_before = (previous.1[0].powi(2) + previous.1[1].powi(2)).sqrt();
        let h = (v[0] * v[0] + v[1] * v[1]).sqrt();
        if airborne && h_before >= 80.0 && h < 0.3 * h_before {
            out.kills += 1;
            if events {
                println!("kill {tick} {:.3} {:.3} {:.3} h {h_before:.1} -> {h:.1}", p[0], p[1], p[2]);
            }
        }
        if airborne && moved < 0.05 {
            streak += 1;
            out.frozen_ticks += 1;
            out.longest_freeze = out.longest_freeze.max(streak);
            if streak == 3 {
                note("freeze", &mut out);
            }
        } else {
            streak = 0;
        }
        if verbose {
            println!(
                "{tick:4} pos {:10.4} {:10.4} {:10.4} vel {:9.3} {:9.3} {:9.3} h {:7.2} s {:7.2} {}",
                p[0],
                p[1],
                p[2],
                v[0],
                v[1],
                v[2],
                h,
                speed,
                if airborne { "-" } else { "G" }
            );
        }
        previous = (p, v);
    }
    out.end = game.state.position;
    out
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    assert!(
        args.len() >= 3,
        "usage: rampslide <map.bsp> <physics> (x y z vx vy vz yaw forward side buttons ticks | --grid file | --slices file) [-v]"
    );
    let verbose = args.iter().any(|a| a == "-v");
    let events = std::env::var_os("RAMPSLIDE_EVENTS").is_some();
    let path = std::path::PathBuf::from(&args[0]);
    let bytes = std::fs::read(&path).expect("read map");
    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("parse map");
    let mut game = Game::load_with_content(&bsp, bunnyhop_core::content::cached_physics_content(&path)).expect("load map");
    let physics: u32 = args[1].parse().expect("physics");
    let lines = |file: &str| -> Vec<String> {
        std::fs::read_to_string(file)
            .expect("read scenarios")
            .lines()
            .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
            .map(str::to_string)
            .collect()
    };
    let scenarios: Vec<Scenario> = match args[2].as_str() {
        "--grid" => lines(&args[3]).iter().enumerate().map(|(i, l)| parse_grid(i, &l.split_whitespace().collect::<Vec<_>>())).collect(),
        "--slices" => lines(&args[3]).iter().map(|l| parse_slice(l)).collect(),
        _ => vec![parse_grid(0, &args[2..13].iter().map(String::as_str).collect::<Vec<_>>())],
    };
    let (mut stops, mut hard, mut kills, mut frozen, mut with_stop, mut with_freeze, mut longest) = (0, 0, 0, 0, 0, 0, 0);
    for s in &scenarios {
        let o = run(&mut game, physics, s, verbose, events);
        stops += o.stops;
        hard += o.hard_stops;
        kills += o.kills;
        frozen += o.frozen_ticks;
        longest = longest.max(o.longest_freeze);
        with_stop += u32::from(o.stops > 0 || o.hard_stops > 0 || o.kills > 0);
        with_freeze += u32::from(o.longest_freeze > 2);
        if scenarios.len() == 1 || o.stops > 0 || o.hard_stops > 0 || o.kills > 0 || o.longest_freeze > 2 || verbose {
            println!(
                "{} stops {} hard {} kills {} frozen {} longest {} distance {:.1} end {:.2} {:.2} {:.2} {}",
                s.id, o.stops, o.hard_stops, o.kills, o.frozen_ticks, o.longest_freeze, o.distance, o.end[0], o.end[1], o.end[2], o.first
            );
        }
    }
    println!(
        "scenarios {} with-stop {with_stop} with-freeze {with_freeze} stops {stops} hard-stops {hard} kills {kills} frozen-ticks {frozen} longest-freeze {longest}",
        scenarios.len()
    );
}
