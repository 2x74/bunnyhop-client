//! Walks a positional replay (one `x y z ducked` line per tick, Source units, feet origin; e.g. a CS:GO shavit
//! replay converted by tools/zones/shavit-replay.ts) through our collision with our player hull, and reports where
//! our world disagrees with the recorded path:
//!
//! - `inside`: a recorded position is inside our solid with our hull (CS:S 62 / 45 tall; CS:GO's is 72 / 54, so a CS:GO
//!   position should always fit ours unless the geometry differs, e.g. a func_door in another state).
//! - `blocked`: the straight sweep from one recorded position to the next hits something our hull can't pass (moves
//!   longer than `--teleport` units are teleports and skipped).
//!
//! Positions are the recording's, not a re-simulation: CS:GO movement (tick rate, air accelerate, stamina, hull) is not
//! ours, so this checks the geometry along the route, not the run.
//!
//!   posreplay <map> <positions.txt> [--teleport 128] [--every 1]
//!
//! The map is maps/<map>.bsp; prop collision comes from the content cache (`CONTENT_CACHE_DIR`).
use bunnyhop_core::content::load_game;
use playsrc_collision::Hull;
use std::path::PathBuf;

const MASK_PLAYERSOLID: u32 = 0x0201_400b;
const STAND: Hull = Hull { mins: [-16.0, -16.0, 0.0], maxs: [16.0, 16.0, 62.0] };
const DUCK: Hull = Hull { mins: [-16.0, -16.0, 0.0], maxs: [16.0, 16.0, 45.0] };

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert!(args.len() >= 3, "usage: posreplay <map> <positions.txt> [--teleport 128]");
    let opt = |name: &str, default: f32| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).and_then(|v| v.parse().ok()).unwrap_or(default);
    let teleport = opt("--teleport", 128.0);
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let game = load_game(&root.join("maps").join(format!("{}.bsp", args[1]))).expect("load map");
    let text = std::fs::read_to_string(&args[2]).expect("read positions");
    let frames: Vec<([f32; 3], bool)> = text
        .lines()
        .filter_map(|l| {
            let v: Vec<f32> = l.split_whitespace().filter_map(|x| x.parse().ok()).collect();
            (v.len() >= 4).then(|| ([v[0], v[1], v[2]], v[3] != 0.0))
        })
        .collect();
    let (mut inside, mut blocked, mut teleports) = (0usize, 0usize, 0usize);
    let mut last_report: Option<usize> = None;
    let mut report = |kind: &str, i: usize, p: [f32; 3], extra: String| {
        // One line per place: skip reports within 50 ticks of the previous one.
        if last_report.is_none_or(|l| i > l + 50) {
            println!("{kind} tick {i} at [{:.0}, {:.0}, {:.0}] {extra}", p[0], p[1], p[2]);
        }
        last_report = Some(i);
    };
    for i in 0..frames.len() {
        let (p, ducked) = frames[i];
        let hull = if ducked { DUCK } else { STAND };
        // Recorded origins rest on surfaces (Source keeps them 1/32 above): test from a hair above.
        let lifted = [p[0], p[1], p[2] + 0.1];
        let t = game.trace_hull(lifted, lifted, hull, MASK_PLAYERSOLID);
        if t.start_solid {
            inside += 1;
            report("inside", i, p, format!("({})", if ducked { "ducked" } else { "standing" }));
            continue;
        }
        let Some(&(q, _)) = frames.get(i + 1) else { break };
        let d = ((q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2) + (q[2] - p[2]).powi(2)).sqrt();
        if d > teleport {
            teleports += 1;
            continue;
        }
        let to = [q[0], q[1], q[2] + 0.1];
        let t = game.trace_hull(lifted, to, hull, MASK_PLAYERSOLID);
        if t.fraction < 0.99 && d * (1.0 - t.fraction) > 1.0 {
            blocked += 1;
            report("blocked", i, p, format!("-> [{:.0}, {:.0}, {:.0}] at {:.2} of {d:.1}u", q[0], q[1], q[2], t.fraction));
        }
    }
    println!("{} frames: {inside} inside our solid, {blocked} blocked moves, {teleports} teleports (> {teleport}u)", frames.len());
}
