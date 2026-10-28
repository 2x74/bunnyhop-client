//! Headless smoke test: load maps, run a scripted strafe-jump pattern, print stats.
//!
//! usage: simcli [--ticks N] <map.bsp>...
use bunnyhop_core::{
    Cmd, Game,
    game::{EVENT_RESPAWNED, EVENT_TELEPORTED, IN_JUMP},
    mesh,
};

fn main() {
    let mut ticks = 1000u32;
    let mut maps = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--ticks" => ticks = args.next().and_then(|s| s.parse().ok()).expect("--ticks N"),
            // Backwards compatible `simcli map.bsp 1000`.
            a if a.parse::<u32>().is_ok() && !maps.is_empty() => ticks = a.parse().unwrap(),
            a => maps.push(a.to_string()),
        }
    }
    assert!(!maps.is_empty(), "usage: simcli [--ticks N] <map.bsp>...");
    for path in maps {
        run(&path, ticks);
    }
}

fn run(path: &str, ticks: u32) {
    println!("== {path}");
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => return println!("read failed: {e}"),
    };
    let t0 = std::time::Instant::now();
    let bsp = match bunnyhop_core::parse_bsp(&bytes) {
        Ok(b) => b,
        Err(e) => return println!("parse failed: {e}"),
    };
    let mut game = Game::load_with_content(&bsp, bunnyhop_core::content::cached_physics_content(std::path::Path::new(&path))).unwrap();
    let m = mesh::build(&bsp);
    let (blocks, with_teleport) = game.bhop_block_stats();
    let teleports = game.teleports();
    println!(
        "bsp v{} loaded in {:?}: {} ents, {} tris, {} materials, spawn {:?} angles {:?}",
        bsp.container_version,
        t0.elapsed(),
        game.entities.len(),
        m.indices.len() / 3,
        m.materials.len(),
        game.spawn_origin,
        game.spawn_angles
    );
    println!(
        "bhop blocks (fix): {blocks}, with teleport below: {with_teleport}; trigger_teleports: {} ({} unresolved)",
        teleports.len(),
        teleports.iter().filter(|t| t.destination.is_none()).count()
    );
    println!(
        "collision: {} displacements, {} solid static props ({} convex solids)",
        game.displacement_count,
        game.solid_static_props(),
        game.static_prop_solids()
    );
    for d in &game.physics_diagnostics {
        println!("  note: {d}");
    }
    let mut yaw = game.spawn_angles[1];
    let t1 = std::time::Instant::now();
    let mut max_speed = 0f32;
    let (mut teleported, mut respawned) = (0, 0);
    for n in 0..ticks {
        let side = if (n / 40) % 2 == 0 { 400.0 } else { -400.0 };
        yaw += if side > 0.0 { -1.0 } else { 1.0 };
        let forward = if n < 20 { 400.0 } else { 0.0 };
        if let Err(e) = game.step(Cmd { forward, side, yaw, pitch: 0.0, buttons: IN_JUMP }) {
            println!("step {n} failed: {e}");
            return;
        }
        teleported += (game.events & EVENT_TELEPORTED != 0) as u32;
        respawned += (game.events & EVENT_RESPAWNED != 0) as u32;
        max_speed = max_speed.max(game.horizontal_speed());
        if n % 250 == 0 {
            println!(
                "tick {n} pos {:?} hspeed {:.1} ground {} name {:?} queue {}",
                game.state.position,
                game.horizontal_speed(),
                game.state.ground.is_some(),
                game.player_name,
                game.queued_events()
            );
            if game.queued_events() > 1000 {
                println!("  queue: {:?}", game.queue_histogram());
            }
        }
    }
    println!(
        "{ticks} ticks in {:?}; max hspeed {max_speed:.1}; teleports {teleported}; respawns {respawned}",
        t1.elapsed()
    );
}
