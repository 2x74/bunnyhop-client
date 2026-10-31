//! Physics v22 skip scan (research/EDGEBUG-V22.md): synthetic drops onto real ledges next to the map's trigger_teleports.
//! Each ledge edge is found by casting a hull down beside a teleport's box and walking toward it until the ground stops. A drop
//! starts two ticks before the hull meets the ledge, moving over the edge, with no other input, at a few speeds, fall speeds and
//! sub-tick offsets, three ways: v21 jump released, v21 jump held, v22 jump released. A drop is placed, not played: the speed
//! may not be reachable there, and no strafing is modelled. Prints one JSON line per map.
//!
//!   edgescan <map.bsp> [max edges, 30] [seconds, 60]

use bunnyhop_core::game::{EVENT_EDGEBUG, EVENT_RESPAWNED, EVENT_TELEPORTED, IN_JUMP, PHYSICS_V21, PHYSICS_V22};
use bunnyhop_core::{Cmd, Game, Settings};
use std::fmt::Write as _;

#[derive(Clone, Copy, Debug)]
struct End {
    teleported: Option<u32>,
    edge_bug: bool,
    grounded: bool,
    jumped: bool,
    pos: [f32; 3],
    speed: f32,
}

fn sim(game: &mut Game, version: u32, jump: bool, start: [f32; 3], vel: [f32; 3], yaw: f32, ticks: u32, ledge: [f32; 3]) -> End {
    game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
    game.reset();
    game.place_player(start);
    game.state.velocity = vel;
    let mut out = End { teleported: None, edge_bug: false, grounded: false, jumped: false, pos: start, speed: 0.0 };
    for t in 0..ticks {
        let before = game.state.velocity[2];
        let _ = before;
        if game.step(Cmd { forward: 0.0, side: 0.0, yaw, pitch: 0.0, buttons: if jump { IN_JUMP } else { 0 } }).is_err() {
            break;
        }
        out.pos = game.state.position;
        out.speed = game.horizontal_speed();
        out.edge_bug |= game.events & EVENT_EDGEBUG != 0;
        out.jumped |= game.events & 2 != 0;
        if game.events & (EVENT_TELEPORTED | EVENT_RESPAWNED) != 0 {
            out.teleported = Some(t);
            return out;
        }
        // Down on something that isn't the ledge: done.
        let (dx, dy) = (out.pos[0] - ledge[0], out.pos[1] - ledge[1]);
        if game.state.ground.is_some() && (dx * dx + dy * dy > 40.0 * 40.0 || (out.pos[2] - ledge[2]).abs() > 2.5) {
            out.grounded = true;
            return out;
        }
    }
    out
}

/// Walkable ground under `p` within 2 units (a hull trace, as a landing).
fn ground_at(game: &Game, p: [f32; 3]) -> bool {
    let t = game.trace_player_hull(p, [p[0], p[1], p[2] - 2.0]);
    !t.start_solid && t.fraction < 1.0 && t.normal.is_some_and(|n| n[2] >= 0.7)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = &args[1];
    let max_edges: usize = args.get(2).map_or(30, |v| v.parse().unwrap());
    let seconds: f32 = args.get(3).map_or(60.0, |v| v.parse().unwrap());
    let name = path.rsplit('/').next().unwrap().trim_end_matches(".bsp").to_string();
    let bytes = std::fs::read(path).expect("read map");
    let bsp = match bunnyhop_core::parse_bsp(&bytes) {
        Ok(b) => b,
        Err(e) => { println!("{{\"map\":\"{name}\",\"error\":\"{e:?}\"}}"); return; }
    };
    let Ok(mut game) = Game::load(&bsp) else { println!("{{\"map\":\"{name}\",\"error\":\"load\"}}"); return; };
    game.set_settings(Settings { physics_version: PHYSICS_V22, ..Settings::css_bhop() });
    game.reset();
    let began = std::time::Instant::now();
    let teleports = game.teleports();
    // Edges: from around each teleport's box, the ground above or beside it, walked toward the box's centre.
    let mut edges: Vec<([f32; 3], [f32; 2])> = Vec::new();
    let mut rng = 0x9E37_79B9u32 ^ name.len() as u32;
    let mut next = move || { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; rng };
    let mut order: Vec<usize> = (0..teleports.len()).collect();
    for i in (1..order.len()).rev() { order.swap(i, next() as usize % (i + 1)); }
    'teleports: for &k in &order {
        let t = &teleports[k];
        if !t.enabled || t.filter.is_some() { continue; }
        let centre = [(t.mins[0] + t.maxs[0]) * 0.5, (t.mins[1] + t.maxs[1]) * 0.5];
        for side in 0..8 {
            let a = side as f32 * std::f32::consts::FRAC_PI_4;
            let (ca, sa) = (a.cos(), a.sin());
            // Start outside the box's edge along this direction.
            let rx = (t.maxs[0] - t.mins[0]) * 0.5 * std::f32::consts::SQRT_2 + 48.0;
            let ry = (t.maxs[1] - t.mins[1]) * 0.5 * std::f32::consts::SQRT_2 + 48.0;
            let (x, y) = (centre[0] + ca * rx, centre[1] + sa * ry);
            let top = t.maxs[2] + 512.0;
            let down = game.trace_player_hull([x, y, top], [x, y, t.mins[2] - 16.0]);
            if down.start_solid || down.fraction >= 1.0 || down.normal.is_none_or(|n| n[2] < 0.7) { continue; }
            let z = down.end[2];
            // Walk toward the box until there is no ground.
            let dir = { let (dx, dy) = (centre[0] - x, centre[1] - y); let l = (dx * dx + dy * dy).sqrt().max(1.0); [dx / l, dy / l] };
            let mut last = None;
            let mut d = 0.0;
            while d < rx + ry {
                let p = [x + dir[0] * d, y + dir[1] * d, z + 0.5];
                if !ground_at(&game, p) { break; }
                last = Some(d);
                d += 2.0;
            }
            let Some(edge_d) = last else { continue };
            if d >= rx + ry { continue; }
            let p = [x + dir[0] * edge_d, y + dir[1] * edge_d, z];
            // A real drop on the far side.
            let probe = [p[0] + dir[0] * 34.0, p[1] + dir[1] * 34.0, p[2] + 1.0];
            let below = game.trace_player_hull(probe, [probe[0], probe[1], probe[2] - 48.0]);
            if below.start_solid || below.fraction < 1.0 { continue; }
            edges.push((p, dir));
            if edges.len() >= max_edges { break 'teleports; }
        }
    }
    let (mut sims, mut fired, mut survive, mut lose, mut reach, mut done) = (0u32, 0u32, 0u32, 0u32, 0u32, 0usize);
    let (mut survive_faster, mut survive_shifted, mut survive_steered) = (0u32, 0u32, 0u32);
    let mut examples = String::new();
    'edges: for (p, dir) in &edges {
        for (speed, vz) in [(400.0f32, -300.0f32), (1000.0, -300.0), (400.0, -1200.0), (1000.0, -1200.0)] {
            let (dx, dz) = (speed * 0.01, vz * 0.01);
            for phase in [0.15f32, 0.5, 0.85] {
                if began.elapsed().as_secs_f32() > seconds { break 'edges; }
                // The hull meets the top `phase` of a tick of travel before the edge position, three ticks from the start.
                let hit = [p[0] - dir[0] * dx * phase, p[1] - dir[1] * dx * phase, p[2]];
                let start = [hit[0] - dir[0] * dx * 3.0, hit[1] - dir[1] * dx * 3.0, hit[2] - dz * 3.0 + 0.1];
                if game.trace_player_hull(start, start).start_solid { continue; }
                let vel = [dir[0] * speed, dir[1] * speed, vz];
                let yaw = dir[1].atan2(dir[0]).to_degrees();
                let a = sim(&mut game, PHYSICS_V21, false, start, vel, yaw, 260, *p);
                let b = sim(&mut game, PHYSICS_V21, true, start, vel, yaw, 260, *p);
                let c = sim(&mut game, PHYSICS_V22, false, start, vel, yaw, 260, *p);
                sims += 3;
                if !c.edge_bug { continue; }
                fired += 1;
                let mut flag = "";
                if c.teleported.is_none() && a.teleported.is_some() && b.teleported.is_some() {
                    survive += 1;
                    flag = "survive";
                    // The friction tick is worth 4% of speed. v21 with that much more speed, no strafing: the same gap?
                    let scale = 1.0 / 0.96 + 0.005;
                    let v = [vel[0] * scale, vel[1] * scale, vel[2]];
                    let faster = sim(&mut game, PHYSICS_V21, false, start, v, yaw, 260, *p);
                    if faster.teleported.is_none() && faster.grounded { survive_faster += 1; }
                    else {
                        // A path a little further out that never touches the ledge, on v21: the same place without any landing?
                        let mut found = false;
                        for k in 1..=8 {
                            let s = [start[0] + dir[0] * k as f32, start[1] + dir[1] * k as f32, start[2]];
                            if game.trace_player_hull(s, s).start_solid { continue; }
                            let o = sim(&mut game, PHYSICS_V21, false, s, vel, yaw, 260, *p);
                            if o.teleported.is_none() && o.grounded { found = true; break; }
                        }
                        if found { survive_shifted += 1; flag = "survive_shifted"; }
                        else {
                            // v21 with a little steering: speed -8%..+12%, turned up to 10 degrees either way (a player strafes).
                            let mut steered = false;
                            'steer: for scale in [0.92f32, 0.94, 0.96, 0.98, 1.0, 1.02, 1.04, 1.06, 1.08, 1.10, 1.12] {
                                for turn in [-10.0f32, -5.0, -2.0, 2.0, 5.0, 10.0, 0.0] {
                                    let (c, s) = (turn.to_radians().cos(), turn.to_radians().sin());
                                    let v = [(vel[0] * c - vel[1] * s) * scale, (vel[0] * s + vel[1] * c) * scale, vel[2]];
                                    let o = sim(&mut game, PHYSICS_V21, false, start, v, yaw + turn, 260, *p);
                                    if o.teleported.is_none() && o.grounded { steered = true; break 'steer; }
                                }
                            }
                            if steered { survive_steered += 1; flag = "survive_steered"; } else { flag = "survive_new"; }
                        }
                    }
                }
                if c.teleported.is_some() && a.teleported.is_none() { lose += 1; flag = "lose"; }
                if c.grounded && (!a.grounded || c.pos[2] > a.pos[2] + 8.0) && (!b.grounded || c.pos[2] > b.pos[2] + 8.0) { reach += 1; flag = if flag.is_empty() { "reach" } else { flag }; }
                if flag == "survive_new" || (!flag.is_empty() && examples.matches("flag").count() < 8) {
                    let _ = write!(examples, "{}{{\"flag\":\"{flag}\",\"edge\":[{:.0},{:.0},{:.0}],\"dir\":[{:.2},{:.2}],\"speed\":{speed},\"vz\":{vz},\"phase\":{phase},\"v21\":[{},{:.0},{:.0},{:.0}],\"v21held\":[{},{:.0},{:.0},{:.0}],\"v22\":[{},{:.0},{:.0},{:.0}]}}",
                        if examples.is_empty() { "" } else { "," }, p[0], p[1], p[2], dir[0], dir[1],
                        a.teleported.is_some(), a.pos[0], a.pos[1], a.pos[2], b.teleported.is_some(), b.pos[0], b.pos[1], b.pos[2], c.teleported.is_some(), c.pos[0], c.pos[1], c.pos[2]);
                }
            }
        }
        done += 1;
    }
    println!("{{\"map\":\"{name}\",\"teleports\":{},\"edges\":{},\"edgesDone\":{done},\"sims\":{sims},\"fired\":{fired},\"survive\":{survive},\"surviveFaster\":{survive_faster},\"surviveShifted\":{survive_shifted},\"surviveSteered\":{survive_steered},\"lose\":{lose},\"reach\":{reach},\"secs\":{:.1},\"examples\":[{examples}]}}", teleports.len(), edges.len(), began.elapsed().as_secs_f32());
}
