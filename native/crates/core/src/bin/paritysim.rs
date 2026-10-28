//! Runs a parity job (tools/parity: the exact input stream the srcds bot is fed) through bunnyhop-core and writes
//! the same per-tick CSV the SourceMod plugin (tools/parity/plugin/bunnyhop_parity.sp) writes, so the two can be
//! compared tick by tick (research/PARITY.md).
//!
//! usage: paritysim <job file> <out.csv> [--maps DIR] [--autohop core|strip] [--blocks vanilla|fix]
//!
//! `--autohop core` (default) runs the game's own autohop (`Settings::autohop`); `strip` turns it off and instead
//! strips IN_JUMP from the command while airborne (not on a ladder / in water), exactly like the plugin does on the
//! server, so autohop semantics can be compared separately from movement.
use bunnyhop_core::{
    Cmd, Game,
    game::{BhopBlockMode, IN_JUMP, Rules},
};
use std::fmt::Write as _;

struct Job {
    map: String,
    origin: [f32; 3],
    angles: [f32; 2],
    velocity: [f32; 3],
    autohop: bool,
    track: Vec<String>,
    cmds: Vec<(i32, i32, f32, f32, u32)>,
}

fn bits(s: &str) -> f32 {
    f32::from_bits(s.parse::<i64>().expect("float bits") as u32)
}

fn parse(text: &str) -> Job {
    let mut job = Job { map: String::new(), origin: [0.0; 3], angles: [0.0; 2], velocity: [0.0; 3], autohop: true, track: Vec::new(), cmds: Vec::new() };
    let mut in_cmds = false;
    for line in text.lines() {
        let p: Vec<&str> = line.split_whitespace().collect();
        if p.is_empty() || p[0].starts_with('#') {
            continue;
        }
        if in_cmds {
            job.cmds.push((p[0].parse().unwrap(), p[1].parse().unwrap(), bits(p[2]), bits(p[3]), p[4].parse().unwrap()));
            continue;
        }
        match p[0] {
            "map" => job.map = p[1].to_string(),
            "origin" => job.origin = [bits(p[1]), bits(p[2]), bits(p[3])],
            "angles" => job.angles = [bits(p[1]), bits(p[2])],
            "velocity" => job.velocity = [bits(p[1]), bits(p[2]), bits(p[3])],
            "autohop" => job.autohop = p[1] != "0",
            "track" if p.len() > 1 => job.track.push(p[1].to_ascii_lowercase()),
            "cmds" => in_cmds = true,
            _ => {}
        }
    }
    job
}

fn main() {
    let all: Vec<String> = std::env::args().skip(1).collect();
    // `paritysim --settle <map.bsp> x y z yaw`: prints the start-zone restart point core's set_position settles to
    // (replays' header.spawn), as float bits "x y z".
    if all.first().map(String::as_str) == Some("--settle") {
        let bytes = std::fs::read(&all[1]).expect("read map");
        let bsp = bunnyhop_core::parse_bsp(&bytes).expect("parse map");
        let mut game = Game::load(&bsp).expect("load map");
        let v: Vec<f32> = all[2..6].iter().map(|s| s.parse().expect("number")).collect();
        game.set_position([v[0], v[1], v[2]], v[3]);
        let p = game.state.position;
        println!("{} {} {}", p[0].to_bits() as i32, p[1].to_bits() as i32, p[2].to_bits() as i32);
        return;
    }
    let mut args = all.into_iter();
    let mut positional = Vec::new();
    let mut maps = "maps".to_string();
    let mut autohop_core = true;
    let mut blocks = BhopBlockMode::Vanilla;
    let mut tick_base = 0u32;
    // Physics version (`game::PHYSICS_V*`); a loaded map starts at v1.
    let mut physics = bunnyhop_core::game::PHYSICS_V1;
    let mut warmup = 0u32;
    while let Some(a) = args.next() {
        match a.as_str() {
            // Steps N idle ticks before placing the player, so movers (func_rotating, trains) are in the phase the
            // engine's are when its run starts (the plugin waits until curtime > 4 after the map load).
            "--warmup" => warmup = args.next().expect("--warmup N").parse().expect("ticks"),
            "--maps" => maps = args.next().expect("--maps DIR"),
            "--physics" => physics = args.next().and_then(|v| v.parse().ok()).expect("--physics N"),
            "--tick-base" => tick_base = args.next().and_then(|v| v.parse().ok()).expect("--tick-base N"),
            "--autohop" => autohop_core = args.next().as_deref() != Some("strip"),
            "--blocks" => {
                blocks = if args.next().as_deref() == Some("fix") { BhopBlockMode::Fix } else { BhopBlockMode::Vanilla }
            }
            _ => positional.push(a),
        }
    }
    assert!(positional.len() == 2, "usage: paritysim <job> <out.csv> [--maps DIR] [--autohop core|strip] [--blocks vanilla|fix]");
    let job = parse(&std::fs::read_to_string(&positional[0]).expect("read job"));
    let bytes = std::fs::read(format!("{maps}/{}.bsp", job.map)).expect("read map");
    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("parse map");
    let map_path = std::path::PathBuf::from(format!("{maps}/{}.bsp", job.map));
    let mut game = Game::load_with_content(&bsp, bunnyhop_core::content::cached_physics_content(&map_path)).expect("load map");
    // Absolute server tick of the first command (engine CSV row 1's gametick): event times are f32 like the engine's.
    game.set_rules(Rules { bhop_blocks: blocks, server_tick_base: tick_base, ..Rules::default() });
    let mut settings = game.settings;
    settings.autohop = job.autohop && autohop_core;
    settings.physics_version = physics;
    game.set_settings(settings);
    game.reset();
    for _ in 0..warmup {
        game.step(Cmd::default()).expect("warmup step");
    }
    game.state.position = job.origin;
    game.state.velocity = job.velocity;
    game.state.ground = None;

    // Tracked entities (the plugin's `track` patterns: classname or targetname, trailing `*` wildcard), logged
    // like the engine's phase-0 rows: the state after the command's tick, labelled with the next tick.
    let matches = |pat: &str, v: &str| match pat.strip_suffix('*') {
        Some(prefix) => v.to_ascii_lowercase().starts_with(prefix),
        None => v.eq_ignore_ascii_case(pat),
    };
    let tracked: Vec<usize> = (0..game.entities.len())
        .filter(|&i| {
            let e = &game.entities[i];
            let (class, name) = (e.classname().to_string(), e.get("targetname").unwrap_or("").to_string());
            job.track.iter().any(|p| matches(p, &class) || (!name.is_empty() && matches(p, &name)))
        })
        .collect();
    let mut ents_out = String::from("tick,phase,ent,classname,targetname,ox,oy,oz,ax,ay,az,vx,vy,vz,solid\n");
    let mut last: Vec<Option<([f32; 3], [f32; 3])>> = vec![None; tracked.len()];
    let mut log_ents = |game: &Game, tick: u32, out: &mut String| {
        for (k, &i) in tracked.iter().enumerate() {
            let Some(t) = game.entity_transform(i) else { continue };
            if last[k] == Some(t) {
                continue;
            }
            last[k] = Some(t);
            let e = &game.entities[i];
            let b = |v: f32| v.to_bits() as i32;
            let solid = game.entity_solidity(i).map_or(0, |(s, _)| s as u32);
            let _ = writeln!(
                out,
                "{tick},0,{i},{},{},{},{},{},{},{},{},0,0,0,{solid}",
                e.classname(),
                e.get("targetname").unwrap_or(""),
                b(t.0[0]),
                b(t.0[1]),
                b(t.0[2]),
                b(t.1[0]),
                b(t.1[1]),
                b(t.1[2]),
            );
        }
    };
    log_ents(&game, 0, &mut ents_out);
    let mut out = String::from(
        "tick,gametick,ox,oy,oz,vx,vy,vz,flags,movetype,waterlevel,ducked,ducking,ducktime,ground,bvx,bvy,bvz,maxspeed,buttons,stamina,fallvel,eyez,ptz,ptvz,name,events\n",
    );
    row(&mut out, &game, 0, 0);
    for (i, &(forward, side, yaw, pitch, buttons)) in job.cmds.iter().enumerate() {
        let mut buttons = buttons;
        if job.autohop && !autohop_core && buttons & IN_JUMP != 0 {
            let s = &game.state;
            let ladder = s.mode == playsrc_movement::Mode::Ladder;
            if s.ground.is_none() && !ladder && s.water_level < 2 {
                buttons &= !IN_JUMP;
            }
        }
        game.step(Cmd { forward: forward as f32, side: side as f32, yaw, pitch, buttons }).expect("step");
        row(&mut out, &game, i as u32 + 1, buttons);
        log_ents(&game, i as u32 + 1, &mut ents_out);
    }
    std::fs::write(&positional[1], out).expect("write csv");
    if !tracked.is_empty() {
        let path = positional[1].strip_suffix(".csv").unwrap_or(&positional[1]).to_string() + ".ents.csv";
        std::fs::write(path, ents_out).expect("write entity csv");
    }
}

fn row(out: &mut String, game: &Game, tick: u32, buttons: u32) {
    // The engine logs right after the player's command (before entities think and push the player).
    let s = if tick == 0 { &game.state } else { &game.state_after_command };
    let b = |v: f32| v.to_bits() as i32;
    let ducked = s.crouch.uses_crouched_hull();
    let ducking = matches!(s.crouch.phase, playsrc_movement::CrouchPhase::Ducking | playsrc_movement::CrouchPhase::Unducking);
    let flags = (s.ground.is_some() as u32) | (ducked as u32) << 1;
    let movetype = if s.mode == playsrc_movement::Mode::Ladder { 9 } else { 2 };
    let _ = writeln!(
        out,
        "{tick},{tick},{},{},{},{},{},{},{flags},{movetype},{},{},{},0,{},{},{},{},{},{buttons},0,{},{},0,0,{},{}",
        b(s.position[0]),
        b(s.position[1]),
        b(s.position[2]),
        b(s.velocity[0]),
        b(s.velocity[1]),
        b(s.velocity[2]),
        s.water_level,
        ducked as u32,
        ducking as u32,
        if s.ground.is_some() { 0 } else { -1 },
        b(s.base_velocity[0]),
        b(s.base_velocity[1]),
        b(s.base_velocity[2]),
        b(game.settings.max_speed),
        b(s.fall_speed),
        b(s.view_offset[2]),
        game.player_name,
        game.events,
    );
}
