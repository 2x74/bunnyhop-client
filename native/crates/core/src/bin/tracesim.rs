//! Runs a parity trace job (tools/parity/trace.ts: a batch of hull traces) through bunnyhop-core's collision scene
//! (world brushes, displacements, static props, solid brush entities at their spawn positions) and writes the same
//! CSV the SourceMod plugin writes from the engine's IEngineTrace.
//!
//! usage: tracesim <job file> <out.csv> [--maps DIR]
use bunnyhop_core::Game;
use playsrc_collision::Hull;
use std::fmt::Write as _;

fn bits(s: &str) -> f32 {
    f32::from_bits(s.parse::<i64>().expect("float bits") as u32)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    assert!(args.len() >= 2, "usage: tracesim <job> <out.csv> [--maps DIR]");
    let world_only = args.iter().any(|a| a == "--world-only");
    let maps = args.iter().position(|a| a == "--maps").map(|i| args[i + 1].clone()).unwrap_or_else(|| "maps".into());
    let text = std::fs::read_to_string(&args[0]).expect("read job");
    let mut map = String::new();
    let mut traces = Vec::new();
    let mut in_traces = false;
    for line in text.lines() {
        let p: Vec<&str> = line.split_whitespace().collect();
        if p.is_empty() || p[0].starts_with('#') {
            continue;
        }
        if in_traces {
            let f: Vec<f32> = p[..12].iter().map(|s| bits(s)).collect();
            traces.push((f, p[12].parse::<i64>().unwrap() as u32));
        } else if p[0] == "map" {
            map = p[1].to_string();
        } else if p[0] == "traces" {
            in_traces = true;
        }
    }
    let bytes = std::fs::read(format!("{maps}/{map}.bsp")).expect("read map");
    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("parse map");
    let game = Game::load(&bsp).expect("load map");
    if let Ok(list) = std::env::var("TRACESIM_BRUSHES") {
        let w = game.collision_world();
        for b in list.split(',').filter_map(|x| x.parse::<usize>().ok()) {
            let brush = &w.brushes[b];
            eprintln!("brush {b}: {} sides contents {:#x}", brush.side_count, brush.contents);
            for k in brush.first_side..brush.first_side + brush.side_count {
                let side = w.sides[k];
                eprintln!("  side {k}: {:?} bevel {} texinfo {}", w.planes[side.plane], side.bevel, side.texture_info);
            }
        }
    }
    if std::env::var("TRACESIM_MODELS").is_ok() {
        let w = game.collision_world();
        let world: std::collections::HashSet<usize> = w.world_brushes.iter().copied().collect();
        for (m, brushes) in w.model_brushes.iter().enumerate().skip(1) {
            let shared = brushes.iter().filter(|b| world.contains(b)).count();
            if shared > 0 {
                eprintln!("model {m}: {} brushes, {shared} also in the world list", brushes.len());
            }
        }
        eprintln!("world brushes: {}", w.world_brushes.len());
    }
    let mut out = String::from("i,fraction,ex,ey,ez,nx,ny,nz,startsolid,allsolid,leftsolid,entity\n");
    let b = |v: f32| v.to_bits() as i32;
    for (i, (f, mask)) in traces.iter().enumerate() {
        let hull = Hull { mins: [f[6], f[7], f[8]], maxs: [f[9], f[10], f[11]] };
        let t = if world_only {
            let w = game.collision_world().trace_hull([f[0], f[1], f[2]], [f[3], f[4], f[5]], hull, *mask).expect("trace");
            playsrc_movement::Trace {
                fraction: w.fraction,
                start_solid: w.start_solid,
                all_solid: w.all_solid,
                end: w.end,
                normal: w.plane.map(|p| p.normal),
                hit: w.brush.map(|b| b as u64),
                contents: w.contents,
            }
        } else {
            game.trace_hull([f[0], f[1], f[2]], [f[3], f[4], f[5]], hull, *mask)
        };
        if std::env::var("TRACESIM_DEBUG").ok().and_then(|v| v.parse::<usize>().ok()) == Some(i) && world_only {
            let w = game.collision_world().trace_hull([f[0], f[1], f[2]], [f[3], f[4], f[5]], hull, *mask).expect("trace");
            eprintln!("world trace {i}: brush {:?} plane {:?}", w.brush, w.plane);
        }
        if std::env::var("TRACESIM_DEBUG").ok().and_then(|v| v.parse::<usize>().ok()) == Some(i) {
            eprintln!("trace {i}: {t:?}");
        }
        let n = t.normal.unwrap_or([0.0; 3]);
        let entity = match t.hit {
            Some(h) if Game::hit_is_entity(h) => 1,
            Some(_) => 0,
            None => -1,
        };
        let _ = writeln!(
            out,
            "{i},{},{},{},{},{},{},{},{},{},0,{entity}",
            b(t.fraction),
            b(t.end[0]),
            b(t.end[1]),
            b(t.end[2]),
            b(n[0]),
            b(n[1]),
            b(n[2]),
            t.start_solid as u8,
            t.all_solid as u8
        );
    }
    std::fs::write(&args[1], out).expect("write csv");
}
