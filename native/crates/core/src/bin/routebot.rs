//! Route bot: finds inputs that take a player through a map, for finishability proofs (tools/verify/route-proof.ts
//! records them through the WASM core and the verifier).
//!
//!   routebot <map> <route.txt> <out.json> [--physics 4] [--seed 1] [-v]
//!
//! Deterministic (seeded xorshift; the native core is the same code as the WASM build). The route file is a list of
//! steps, one per line (`#` comments):
//!
//! - `spawn x y z yaw`: restart point (the client's start-zone restart: `Game::set_position`). Must come first.
//! - `goto x y z [radius] [air]`: beam search (below) until the player is within `radius` (default 64) of the point,
//!   on the ground unless `air`.
//! - `dest name [radius]`: `goto` an info_teleport_destination / info_target.
//! - `zone x0 y0 z0 x1 y1 z1`: beam search until the player's feet are inside the box (e.g. the end zone).
//! - `walk x y [buttons] [maxticks]`: walk straight there (no search).
//! - `look yaw pitch`: the view for the raw steps below.
//! - `cmd ticks forward side buttons`: raw commands (with the current view).
//! - `use x y z`: look at the point and press +use for 2 ticks.
//! - `aim x y z`: look at the point (for `cmd` / `fire`).
//! - `fire n interval buttons`: n shots (IN_ATTACK pulses) `interval` ticks apart, with `buttons` held.
//! - `climb x y z ztop [maxticks] [steer]`: ride a shot-activated push (bhop_badges pads): aim at the pad, re-fire as
//!   each boost window closes, steer toward it, until the feet reach `ztop`.
//! - `rise x y ztop [radius]`: beam search (score: the way to the column plus the height left, no nav) until the feet
//!   are at `ztop` within `radius` of (x, y); rollouts shoot the nearest pad in rhythm when a gun is held.
//! - `path radius x y z x y z ...`: beam search along a polyline (air routes the floor nav can't see).
//! - `caps min max`: set search steering speed caps (ordinary inputs only).
//! - `path-land-speed min_speed radius x y z ...`: require grounded contact with minimum XY speed.
//! - `land x y z [radius]`: local recorded landing search, actual ground and +/-32u z; no whole-map nav.
//! - `zone-direct x0 y0 z0 x1 y1 z1`: local direct-target end-zone search; no whole-map nav.
//! - `path-land radius x y z ...`: same guidance, but finish on the ground within 32u of the final height.
//! - `path3d-land radius x y z ...`: optional XYZ guidance for vertical routes; eightfold off-path penalty.
//! - `area x0 y0 z0 x1 y1 z1`: the navigation region of the next search (default: around start and goal).
//! - `beam width rollouts iterations`: search sizes for the next searches.
//!
//! Search: a floor grid (32u cells; standing-hull traces) with walk / jump edges and the map's enabled unfiltered
//! teleports gives every floor point a path distance to the goal (Dijkstra). A beam of game states is advanced by
//! random rollouts (strafe-hops, walks, single jumps, waits toward a look-ahead point of lower distance) and the best
//! states by distance survive (one per 64u cell). With a gun, rollouts often shoot the nearest damage-activated button,
//! mostly in rhythm (again as soon as the player's boost name is gone). `NAVDUMP=file` writes the nav (floor points
//! with their distance, teleports, pushes, damage buttons) for a top-down plot.
use bunnyhop_core::{Cmd, Game, Settings, game::{GameState, TeleportInfo}};
use playsrc_collision::Hull;
use std::collections::{BinaryHeap, HashMap};
use std::rc::Rc;

const IN_JUMP: u32 = 1 << 1;
const IN_DUCK: u32 = 1 << 2;
const IN_FORWARD: u32 = 1 << 3;
const IN_BACK: u32 = 1 << 4;
const IN_USE: u32 = 1 << 5;
const IN_MOVELEFT: u32 = 1 << 9;
const IN_MOVERIGHT: u32 = 1 << 10;
const IN_ATTACK: u32 = 1 << 0;
const MASK: u32 = 0x0201_400b | 0x10000;
const STAND: Hull = Hull { mins: [-16.0, -16.0, 0.0], maxs: [16.0, 16.0, 62.0] };
const CELL: f32 = 16.0;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn f(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u64 << 24) as f32
    }
    fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.f()
    }
}

/// A command as recorded: forward, side, yaw, pitch, buttons (movement key bits match forward / side).
type Rec = [f32; 5];

fn cmd(forward: f32, side: f32, yaw: f32, pitch: f32, buttons: u32) -> Cmd {
    let mut b = buttons & !(IN_FORWARD | IN_BACK | IN_MOVELEFT | IN_MOVERIGHT);
    if forward > 0.0 {
        b |= IN_FORWARD;
    } else if forward < 0.0 {
        b |= IN_BACK;
    }
    if side > 0.0 {
        b |= IN_MOVERIGHT;
    } else if side < 0.0 {
        b |= IN_MOVELEFT;
    }
    Cmd { forward, side, yaw: wrap(yaw), pitch, buttons: b }
}

fn wrap(a: f32) -> f32 {
    let mut a = a % 360.0;
    if a > 180.0 {
        a -= 360.0;
    } else if a < -180.0 {
        a += 360.0;
    }
    a
}

struct Nav {
    x0: f32,
    y0: f32,
    nx: usize,
    ny: usize,
    /// Node indices per column.
    cols: Vec<Vec<u32>>,
    pos: Vec<[f32; 3]>,
    dist: Vec<f32>,
    /// The next floor point on the shortest path (u32::MAX: none), and whether that step is a teleport.
    next: Vec<u32>,
    tele: Vec<bool>,
    /// Ladder brush bounds in the region.
    ladders: Vec<([f32; 3], [f32; 3])>,
    /// trigger_push volumes: (mins, maxs, push direction, the floor points the push carries the player to). Air
    /// positions inside one score as the best of those targets plus the way left along the push (rising in a column
    /// the gun keeps switching on has no floor point nearby).
    pushes: Vec<([f32; 3], [f32; 3], [f32; 3], Vec<u32>)>,
}

impl Nav {
    /// Recording/path scoring supplies its own metric and look-ahead. It does
    /// not need a whole-map floor grid (and many surf/boost paths have no such
    /// grid route). Collision still runs normally in every rollout.
    fn recording(g: &Game) -> Nav {
        let ladders = g.entities.iter().enumerate()
            .filter(|(_, e)| matches!(e.classname(), "func_ladder" | "func_useableladder"))
            .filter_map(|(i, _)| g.entity_bounds(i)).collect();
        Nav { x0: 0.0, y0: 0.0, nx: 0, ny: 0, cols: Vec::new(), pos: Vec::new(),
              dist: Vec::new(), next: Vec::new(), tele: Vec::new(), ladders, pushes: Vec::new() }
    }
    fn build(g: &Game, lo: [f32; 3], hi: [f32; 3], goal: &dyn Fn([f32; 3]) -> bool, verbose: bool) -> Nav {
        let t0 = std::time::Instant::now();
        let nx = ((hi[0] - lo[0]) / CELL).ceil().max(1.0) as usize;
        let ny = ((hi[1] - lo[1]) / CELL).ceil().max(1.0) as usize;
        let mut cols = vec![Vec::new(); nx * ny];
        let mut pos: Vec<[f32; 3]> = Vec::new();
        for j in 0..ny {
            for i in 0..nx {
                let x = lo[0] + (i as f32 + 0.5) * CELL;
                let y = lo[1] + (j as f32 + 0.5) * CELL;
                let mut z = hi[2];
                let mut n = 0;
                while z > lo[2] && n < 6 {
                    let t = g.trace_hull([x, y, z], [x, y, lo[2]], STAND, MASK);
                    if t.start_solid {
                        z -= 16.0;
                        continue;
                    }
                    if t.fraction >= 1.0 {
                        break;
                    }
                    if t.normal.is_some_and(|nm| nm[2] >= 0.7) {
                        cols[j * nx + i].push(pos.len() as u32);
                        pos.push(t.end);
                        n += 1;
                    }
                    z = t.end[2] - 66.0;
                }
            }
        }
        // ROUTEBOT_ALL_TELEPORTS=1: also route through filtered teleports (filter_activator_name etc.) in the nav, as if
        // their filters pass; rollouts still run the real game, so a teleport that doesn't fire just doesn't help.
        let all = std::env::var_os("ROUTEBOT_ALL_TELEPORTS").is_some();
        let teleports: Vec<TeleportInfo> =
            g.teleports().into_iter().filter(|t| t.enabled && (all || (t.required_name.is_none() && t.filter.is_none()))).collect();
        let mut virt_cols: std::collections::HashSet<usize> = std::collections::HashSet::new();
        // Teleports over a pit (no floor inside): a virtual floor point at the volume's bottom centre, so jumps into
        // them are edges.
        for t in &teleports {
            // Feet height at which a standing hull (72u) reaches 8u into the volume: a jump at that height touches it.
            let c = [(t.mins[0] + t.maxs[0]) * 0.5, (t.mins[1] + t.maxs[1]) * 0.5, t.maxs[2].min(t.mins[2] + 8.0) - 72.0];
            if (0..3).any(|k| c[k] < lo[k] || c[k] > hi[k]) {
                continue;
            }
            let i = ((c[0] - lo[0]) / CELL).floor() as usize;
            let j = ((c[1] - lo[1]) / CELL).floor() as usize;
            if i >= nx || j >= ny {
                continue;
            }
            let inside = cols[j * nx + i].iter().any(|&k| {
                let q = pos[k as usize];
                q[2] + 72.0 > t.mins[2] && q[2] < t.maxs[2]
            });
            if !inside {
                cols[j * nx + i].push(pos.len() as u32);
                virt_cols.insert(j * nx + i);
                pos.push(c);
            }
        }
        let n = pos.len();
        // Reverse edges: rev[b] = (a, cost) for a -> b.
        let mut rev: Vec<Vec<(u32, f32)>> = vec![Vec::new(); n];
        let col_of = |p: [f32; 3]| -> Option<(usize, usize)> {
            let i = ((p[0] - lo[0]) / CELL).floor();
            let j = ((p[1] - lo[1]) / CELL).floor();
            (i >= 0.0 && j >= 0.0 && (i as usize) < nx && (j as usize) < ny).then(|| (i as usize, j as usize))
        };
        // ROUTEBOT_JUMP=<units>: the longest gap the nav links with a jump edge (default 360: a jump from a run-up;
        // bhop maps built for speed have longer gaps, up to the 480u search reach).
        let jump_reach: f32 = std::env::var("ROUTEBOT_JUMP").ok().and_then(|v| v.parse().ok()).unwrap_or(360.0);
        let reach = (480.0f32.max(jump_reach) / CELL) as i32;
        // Platform-edge floor points (a missing same-height neighbour): jumps start and land there (interior jumps
        // are walks to the edge plus an edge jump).
        let mut edge = vec![false; n];
        for (k, p) in pos.iter().enumerate() {
            let Some((ci, cj)) = col_of(*p) else { continue };
            let mut same = 0;
            for dj in -1i32..=1 {
                for di in -1i32..=1 {
                    let (i, j) = (ci as i32 + di, cj as i32 + dj);
                    let has = i >= 0
                        && j >= 0
                        && (i as usize) < nx
                        && (j as usize) < ny
                        && cols[j as usize * nx + i as usize].iter().any(|&b| (pos[b as usize][2] - p[2]).abs() < 8.0);
                    if !has {
                        edge[k] = true;
                    } else {
                        same += 1;
                    }
                }
            }
            // Small platforms (bhop blocks, pillars) may have no point in an even cell: jumps target them anyway.
            if same <= 4 {
                virt_cols.insert(cj * nx + ci);
            }
        }
        let edges_of = |a: usize| -> Vec<(u32, f32)> {
            let mut out: Vec<(u32, f32)> = Vec::new();
            let p = pos[a];
            // Standing in a teleport: the only way on is its destination.
            if let Some(t) = teleports.iter().find(|t| {
                p[0] + 16.0 > t.mins[0] && p[0] - 16.0 < t.maxs[0] && p[1] + 16.0 > t.mins[1] && p[1] - 16.0 < t.maxs[1] && p[2] + 72.0 > t.mins[2] && p[2] < t.maxs[2]
            }) {
                if let Some(d) = t.destination {
                    if let Some((ci, cj)) = col_of(d) {
                        // The floor the destination drops the player onto: just below it, in or next to its column.
                        let mut best: Option<(f32, u32)> = None;
                        for dj in -2i32..=2 {
                            for di in -2i32..=2 {
                                let (i, j) = (ci as i32 + di, cj as i32 + dj);
                                if i < 0 || j < 0 || i as usize >= nx || j as usize >= ny {
                                    continue;
                                }
                                for &b in &cols[j as usize * nx + i as usize] {
                                    let q = pos[b as usize];
                                    let below = d[2] - q[2];
                                    if (-8.0..=96.0).contains(&below) {
                                        let cost = below + ((q[0] - d[0]).powi(2) + (q[1] - d[1]).powi(2)).sqrt();
                                        if best.is_none_or(|(c, _)| cost < c) {
                                            best = Some((cost, b));
                                        }
                                    }
                                }
                            }
                        }
                        if let Some((_, b)) = best {
                            out.push((b, 32.0));
                        }
                    }
                }
                return out;
            }
            let Some((ci, cj)) = col_of(p) else { return out };
            for dj in -reach..=reach {
                for di in -reach..=reach {
                    let (i, j) = (ci as i32 + di, cj as i32 + dj);
                    if i < 0 || j < 0 || i as usize >= nx || j as usize >= ny {
                        continue;
                    }
                    // Jumps: every other cell (32u apart) is enough; walks: the 8 neighbours.
                    if (di.abs() > 1 || dj.abs() > 1) && (i % 2 != 0 || j % 2 != 0) && !virt_cols.contains(&(j as usize * nx + i as usize)) {
                        continue;
                    }
                    let h = ((di * di + dj * dj) as f32).sqrt() * CELL;
                    if h > 480.0f32.max(jump_reach) {
                        continue;
                    }
                    if di == 0 && dj == 0 {
                        continue;
                    }
                    for &b in &cols[j as usize * nx + i as usize] {
                        let q = pos[b as usize];
                        let up = q[2] - p[2];
                        let adjacent = di.abs() <= 1 && dj.abs() <= 1;
                        if !adjacent && !(edge[a] && edge[b as usize]) {
                            continue;
                        }
                        let mut ok = if adjacent { up <= 18.0 } else { up <= 56.0 && h <= jump_reach + (-up).max(0.0) * 0.8 };
                        if ok && (!adjacent || up < -18.0) {
                            // Clearance: across at jump height above the higher floor, then down onto the target.
                            // As high as the headroom allows (low ceilings), but above both floors.
                            let a1 = g.trace_hull([p[0], p[1], p[2] + 2.0], [p[0], p[1], p[2].max(q[2]) + 40.0], STAND, MASK);
                            let top = a1.end[2];
                            if a1.start_solid || top < p[2].max(q[2]) + 2.0 {
                                ok = false;
                            } else {
                                let a2 = g.trace_hull([p[0], p[1], top], [q[0], q[1], top], STAND, MASK);
                                let a3 = g.trace_hull([q[0], q[1], top], [q[0], q[1], q[2]], STAND, MASK);
                                ok = a2.fraction >= 1.0 && !a3.start_solid && (a3.end[2] - q[2]).abs() < 2.0;
                            }
                            if !ok && up < -40.0 {
                                // Drop first, then across (a ledge under an overhang, e.g. a gap beside a wall that
                                // only opens lower down): step off the edge, fall to just above the target floor,
                                // move across, land.
                                let d = [q[0] - p[0], q[1] - p[1]];
                                let k = (40.0 / h).min(1.0);
                                let e = [p[0] + d[0] * k, p[1] + d[1] * k, p[2] + 2.0];
                                let f = [e[0], e[1], q[2] + 8.0];
                                let segs = [([p[0], p[1], p[2] + 2.0], e), (e, f), (f, [q[0], q[1], q[2] + 8.0])];
                                ok = segs.iter().all(|&(s0, s1)| {
                                    let t = g.trace_hull(s0, s1, STAND, MASK);
                                    t.fraction >= 1.0 && !t.start_solid
                                });
                            }
                        }
                        if ok && up > -800.0 {
                            let cost = if adjacent { h } else { h + 24.0 };
                            out.push((b, cost));
                        }
                    }
                }
            }
                    out
        };
        for a in 0..n {
            for (b, c) in edges_of(a) {
                rev[b as usize].push((a as u32, c));
            }
        }
        // Ladders: world brushes with CONTENTS_LADDER (axial bounds). Floor points near the ladder below its top get an
        // edge to the floor points near its top.
        let w = g.collision_world();
        let mut ladders = 0;
        let mut ladder_boxes = Vec::new();
        for brush in &w.brushes {
            if brush.contents & 0x2000_0000 == 0 {
                continue;
            }
            let (mut blo, mut bhi) = ([-1e9f32; 3], [1e9f32; 3]);
            for side in &w.sides[brush.first_side..brush.first_side + brush.side_count] {
                let pl = &w.planes[side.plane];
                for k in 0..3 {
                    if pl.normal[k] > 0.999 {
                        bhi[k] = bhi[k].min(pl.distance);
                    } else if pl.normal[k] < -0.999 {
                        blo[k] = blo[k].max(-pl.distance);
                    }
                }
            }
            if (0..3).any(|k| blo[k] < -1e8 || bhi[k] > 1e8 || bhi[k] < lo[k] || blo[k] > hi[k]) {
                continue;
            }
            ladder_boxes.push((blo, bhi));
            let near = |q: [f32; 3]| {
                let dx = (blo[0] - q[0]).max(q[0] - bhi[0]).max(0.0);
                let dy = (blo[1] - q[1]).max(q[1] - bhi[1]).max(0.0);
                (dx * dx + dy * dy).sqrt() <= 96.0
            };
            // Any floor point along the ladder (step off part-way up, or at the top).
            let along: Vec<u32> = (0..n as u32).filter(|&b| near(pos[b as usize]) && pos[b as usize][2] >= blo[2] - 72.0 && pos[b as usize][2] <= bhi[2] + 40.0).collect();
            for &a in &along {
                let p = pos[a as usize];
                for &b in &along {
                    let up = pos[b as usize][2] - p[2];
                    if up >= 40.0 {
                        rev[b as usize].push((a, up + 64.0));
                        ladders += 1;
                    }
                }
            }
        }
        if verbose {
            eprintln!("nav: ladder brushes in map {}", w.brushes.iter().filter(|b| b.contents & 0x2000_0000 != 0).count());
        }
        if verbose && ladders > 0 {
            eprintln!("nav: {ladders} ladder edges");
        }
        // trigger_push volumes (boost pads, wind, launchers; filtered ones too: the map renames the player to pass
        // them): floor points under / in the volume reach the points the push carries the player toward.
        let mut pushes = 0;
        let mut push_vols: Vec<([f32; 3], [f32; 3], [f32; 3], Vec<u32>)> = Vec::new();
        for i in 0..g.entities.len() {
            let e = &g.entities[i];
            if e.classname() != "trigger_push" || e.int("spawnflags") & 1 == 0 {
                continue;
            }
            let Some((plo, phi)) = g.entity_bounds(i) else { continue };
            if (0..3).any(|k| phi[k] < lo[k] || plo[k] > hi[k]) {
                continue;
            }
            let dir = e.vec3("pushdir").map(|a| {
                let (sp, cp) = a[0].to_radians().sin_cos();
                let (sy, cy) = a[1].to_radians().sin_cos();
                [cp * cy, cp * sy, -sp]
            }).unwrap_or([0.0, 0.0, 1.0]);
            let inside = |q: [f32; 3], m: f32| q[0] + 16.0 > plo[0] - m && q[0] - 16.0 < phi[0] + m && q[1] + 16.0 > plo[1] - m && q[1] - 16.0 < phi[1] + m;
            // Up columns are also entered from the side (a jump or fall into the column from a floor near it; the
            // badges pads sit under fail teleports, so the column is entered in the air and kept on by shooting).
            let margin = if dir[2] > 0.7 { 192.0 } else { 0.0 };
            let sources: Vec<usize> = (0..n).filter(|&a| inside(pos[a], margin) && pos[a][2] + 62.0 > plo[2] - 8.0 && pos[a][2] < phi[2]).collect();
            // Where it carries the player: up pushes to the column top (+ a jump's reach around it); sideways ones to
            // the far side of the volume and up to 600u beyond it.
            let targets: Vec<usize> = if dir[2] > 0.7 {
                // Up pushes: anywhere around the column from its floor to its top (they also carry a player across
                // gaps inside the column).
                (0..n).filter(|&b| inside(pos[b], 200.0) && pos[b][2] > plo[2] - 64.0 && pos[b][2] < phi[2] + 120.0).collect()
            } else {
                (0..n)
                    .filter(|&b| {
                        let q = pos[b];
                        let c = [(plo[0] + phi[0]) * 0.5, (plo[1] + phi[1]) * 0.5];
                        let along = (q[0] - c[0]) * dir[0] + (q[1] - c[1]) * dir[1];
                        let across = ((q[0] - c[0]) * dir[1] - (q[1] - c[1]) * dir[0]).abs();
                        along > 0.0 && along < 900.0 && across < 300.0 && q[2] < phi[2] + 120.0 && q[2] > plo[2] - 600.0
                    })
                    .collect()
            };
            push_vols.push((plo, phi, dir, targets.iter().map(|&b| b as u32).collect()));
            for &a in &sources {
                for &b in &targets {
                    let d = (0..3).map(|k| (pos[b][k] - pos[a][k]).powi(2)).sum::<f32>().sqrt();
                    if dir[2] > 0.7 && ((pos[b][0] - pos[a][0]).powi(2) + (pos[b][1] - pos[a][1]).powi(2)).sqrt() > 700.0 {
                        continue;
                    }
                    rev[b].push((a as u32, d * 0.5 + 64.0));
                    pushes += 1;
                }
            }
        }
        if verbose && pushes > 0 {
            eprintln!("nav: {pushes} push edges");
        }
        let mut dist = vec![f32::INFINITY; n];
        let mut heap = BinaryHeap::new();
        for (k, p) in pos.iter().enumerate() {
            if goal(*p) {
                dist[k] = 0.0;
                heap.push((std::cmp::Reverse(0u32), k as u32));
            }
        }
        while let Some((std::cmp::Reverse(dq), b)) = heap.pop() {
            let d = dq as f32 / 4.0;
            if d > dist[b as usize] {
                continue;
            }
            for &(a, c) in &rev[b as usize] {
                let nd = d + c;
                if nd < dist[a as usize] {
                    dist[a as usize] = nd;
                    heap.push((std::cmp::Reverse((nd * 4.0) as u32), a));
                }
            }
        }
        if let Ok(path) = std::env::var("NAVDUMP") {
            // Debug view (/tmp tools render it): floor points with their distance, teleports, pushes, damage buttons.
            let mut o = String::new();
            for k in 0..n {
                o += &format!("N {} {} {} {}\n", pos[k][0], pos[k][1], pos[k][2], if dist[k].is_finite() { dist[k] } else { -1.0 });
            }
            for t in g.teleports() {
                o += &format!("T {} {} {} {} {} {} {}\n", t.mins[0], t.mins[1], t.mins[2], t.maxs[0], t.maxs[1], t.maxs[2], (t.enabled && t.filter.is_none() && t.required_name.is_none()) as u8);
            }
            for i in 0..g.entities.len() {
                let c = g.entities[i].classname();
                if c == "trigger_push" || (c == "func_button" && g.entities[i].int("spawnflags") & 512 != 0) {
                    if let Some((a0, a1)) = g.entity_bounds(i) {
                        o += &format!("{} {} {} {} {} {} {}\n", if c == "trigger_push" { "P" } else { "B" }, a0[0], a0[1], a0[2], a1[0], a1[1], a1[2]);
                    }
                }
            }
            std::fs::write(path, o).expect("navdump");
        }
        if let Ok(spec) = std::env::var("NAVCOL") {
            for pt in spec.split(';') {
                let v: Vec<f32> = pt.split(',').map(|x| x.parse().unwrap()).collect();
                if let Some((i, j)) = col_of([v[0], v[1], 0.0]) {
                    let list: Vec<_> = cols[j * nx + i].iter().map(|&k| (pos[k as usize][2], rev[k as usize].len())).collect();
                    eprintln!("navcol {v:?}: {list:?}");
                }
            }
        }
        if let Ok(spec) = std::env::var("NAVGAP") {
            // Where the nav breaks: from the floor point under `x,y,z`, the forward-reachable points closest to the goal
            // set, and the goal-reaching points closest to the start.
            let v: Vec<f32> = spec.split(',').map(|x| x.parse().unwrap()).collect();
            let sp = [v[0], v[1], v[2]];
            let mut fwd: Vec<Vec<u32>> = vec![Vec::new(); n];
            for b in 0..n {
                for &(a, _) in &rev[b] {
                    fwd[a as usize].push(b as u32);
                }
            }
            let start = (0..n).min_by(|&a, &b| {
                let d = |k: usize| (0..3).map(|i| (pos[k][i] - sp[i]).powi(2)).sum::<f32>();
                d(a).total_cmp(&d(b))
            });
            if let Some(st) = start {
                let mut seen = vec![false; n];
                let mut stack = vec![st];
                seen[st] = true;
                while let Some(a) = stack.pop() {
                    for &b in &fwd[a] {
                        if !seen[b as usize] {
                            seen[b as usize] = true;
                            stack.push(b as usize);
                        }
                    }
                }
                let reach: Vec<usize> = (0..n).filter(|&k| seen[k]).collect();
                eprintln!("navgap: start node {:?}, {} reachable", pos[st].map(|v| v.round()), reach.len());
                let mut far: Vec<usize> = reach.clone();
                far.sort_by(|&a, &b| {
                    let d = |k: usize| (0..2).map(|i| (pos[k][i] - pos[st][i]).powi(2)).sum::<f32>();
                    d(b).total_cmp(&d(a))
                });
                for &k in far.iter().take(12) {
                    eprintln!("  reachable far {:?}", pos[k].map(|v| v.round()));
                }
                let zmax = v.get(3).copied().unwrap_or(f32::MAX);
                let mut high: Vec<usize> = reach.iter().copied().filter(|&k| pos[k][2] > pos[st][2] + 20.0 && pos[k][2] < zmax).collect();
                high.sort_by(|&a, &b| pos[b][2].total_cmp(&pos[a][2]));
                for &k in high.iter().take(12) {
                    eprintln!("  reachable high {:?}", pos[k].map(|v| v.round()));
                }
            }
        }
        let mut next = vec![u32::MAX; n];
        let mut tele = vec![false; n];
        let mut via = vec![f32::INFINITY; n];
        for b in 0..n {
            if !dist[b].is_finite() {
                continue;
            }
            for &(a, c) in &rev[b] {
                let cand = dist[b] + c;
                if cand < via[a as usize] {
                    via[a as usize] = cand;
                    next[a as usize] = b as u32;
                    tele[a as usize] = c == 32.0 && (pos[b][0] - pos[a as usize][0]).abs() + (pos[b][1] - pos[a as usize][1]).abs() > 400.0;
                }
            }
        }
        if verbose {
            let reached = dist.iter().filter(|d| d.is_finite()).count();
            eprintln!("nav {nx}x{ny} cols, {n} floor points, {reached} with a path, goal points {}, {:?}", dist.iter().filter(|&&d| d == 0.0).count(), t0.elapsed());
        }
        Nav { x0: lo[0], y0: lo[1], nx, ny, cols, pos, dist, next, tele, ladders: ladder_boxes, pushes: push_vols }
    }

    fn col(&self, p: [f32; 3]) -> Option<(i32, i32)> {
        let i = ((p[0] - self.x0) / CELL).floor() as i32;
        let j = ((p[1] - self.y0) / CELL).floor() as i32;
        (i >= 0 && j >= 0 && (i as usize) < self.nx && (j as usize) < self.ny).then_some((i, j))
    }

    /// Path distance of a player position: the best floor point within 3 cells at about the player's height.
    fn score(&self, p: [f32; 3]) -> f32 {
        let Some((ci, cj)) = self.col(p) else { return 1e9 };
        let mut best = f32::INFINITY;
        for dj in -6..=6 {
            for di in -6..=6 {
                let (i, j) = (ci + di, cj + dj);
                if i < 0 || j < 0 || i as usize >= self.nx || j as usize >= self.ny {
                    continue;
                }
                for &k in &self.cols[j as usize * self.nx + i as usize] {
                    let q = self.pos[k as usize];
                    if q[2] > p[2] + 24.0 || q[2] < p[2] - 96.0 {
                        continue;
                    }
                    let h = ((q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2)).sqrt();
                    best = best.min(self.dist[k as usize] + h + (p[2] - q[2]).abs() * 0.5);
                }
            }
        }
        for (plo, phi, dir, targets) in &self.pushes {
            if !(0..3).all(|k| p[k] + if k == 2 { 62.0 } else { 16.0 } > plo[k] && p[k] - if k == 2 { 0.0 } else { 16.0 } < phi[k]) {
                continue;
            }
            // The best target, plus the way left: up columns to their top, sideways pushes to their far end.
            let left = if dir[2] > 0.7 {
                phi[2] - p[2]
            } else {
                let far = [0, 1].map(|k| if dir[k] > 0.3 { phi[k] - p[k] } else if dir[k] < -0.3 { p[k] - plo[k] } else { 0.0 });
                far[0].max(far[1]).max(0.0)
            };
            let t = targets.iter().map(|&b| self.dist[b as usize]).fold(f32::INFINITY, f32::min);
            if t.is_finite() {
                best = best.min(t + 64.0 + left);
            }
        }
        if best.is_finite() { best } else { 1e8 }
    }

    /// The floor point the player stands on or over (best distance within 3 cells at about their height).
    fn node(&self, p: [f32; 3]) -> Option<u32> {
        let (ci, cj) = self.col(p)?;
        let mut best: Option<(f32, u32)> = None;
        for dj in -6..=6 {
            for di in -6..=6 {
                let (i, j) = (ci + di, cj + dj);
                if i < 0 || j < 0 || i as usize >= self.nx || j as usize >= self.ny {
                    continue;
                }
                for &k in &self.cols[j as usize * self.nx + i as usize] {
                    let q = self.pos[k as usize];
                    if q[2] > p[2] + 24.0 || q[2] < p[2] - 96.0 || !self.dist[k as usize].is_finite() {
                        continue;
                    }
                    let h = ((q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2)).sqrt();
                    let d = self.dist[k as usize] + h;
                    if best.is_none_or(|(bd, _)| d < bd) {
                        best = Some((d, k));
                    }
                }
            }
        }
        best.map(|(_, k)| k)
    }

    /// A look-ahead target: `radius` units along the shortest path from the player's floor point (stopping at a
    /// teleport, whose volume is the target then).
    fn target(&self, p: [f32; 3], radius: f32) -> Option<[f32; 3]> {
        let mut k = self.node(p)?;
        let mut walked = 0.0;
        for _ in 0..64 {
            let nk = self.next[k as usize];
            if nk == u32::MAX || self.tele[k as usize] {
                break;
            }
            let (a, b) = (self.pos[k as usize], self.pos[nk as usize]);
            walked += ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt();
            k = nk;
            if walked >= radius {
                break;
            }
        }
        Some(self.pos[k as usize])
    }
}

#[derive(Clone)]
struct Node {
    state: Rc<GameState>,
    cmds: Rc<Vec<Rec>>,
    score: f32,
    pos: [f32; 3],
    velocity: [f32; 3],
    /// Times this node was expanded (elitism: expanded nodes stay in the pool with a growing penalty).
    expanded: u32,
}

// Speed-constrained research searches must retain momentum near the final landing.
// These terms are disabled for every ordinary route/search directive.
fn speed_goal_penalty(pos: [f32; 3], velocity: [f32; 3], target: [f32; 3], min_speed: f32) -> f32 {
    if min_speed <= 0.0 { return 0.0; }
    let distance = (0..3).map(|k| (pos[k] - target[k]).powi(2)).sum::<f32>().sqrt();
    let proximity = (1.0 - distance / 768.0).clamp(0.0, 1.0);
    (min_speed - velocity[0].hypot(velocity[1])).max(0.0) * proximity
}

fn speed_goal_bucket(velocity: [f32; 3], min_speed: f32) -> (i32, i32) {
    if min_speed <= 0.0 { return (0, 0); }
    // Direction matters too: equally fast opposite approaches are different futures.
    ((velocity[0] / 200.0).floor() as i32, (velocity[1] / 200.0).floor() as i32)
}

struct Bot {
    g: Game,
    cmds: Vec<Rec>,
    rng: Rng,
    yaw: f32,
    pitch: f32,
    verbose: bool,
    area: Option<([f32; 3], [f32; 3])>,
    beam: (usize, usize, usize),
    caps: Option<(f32, f32)>,
    /// Damage-activated func_button bounds (shooting targets).
    pads: Vec<([f32; 3], [f32; 3])>,
    /// Boxes the player must never enter (e.g. the start zone after leaving it: re-entering restarts the timer).
    avoid: Vec<([f32; 3], [f32; 3])>,
    /// Player names the damage buttons give at once (OnDamaged `!activator AddOutput targetname X` with delay 0):
    /// while the player has one, a boost window is open.
    boost_names: Vec<String>,
}

/// Random rollout parameters.
struct Params {
    cap: f32,
    alt: u32,
    duck_air: bool,
    prespeed: f32,
    /// Air-stop when the target is closer than this (0 = never).
    brake: f32,
    /// Shoot the nearest damage-activated button every this many ticks (0 = never).
    shoot: u32,
    /// Rhythm fire instead: shoot again as soon as the pad's boost name is gone (the window closed), the badges way.
    rhythm: bool,
    /// Which visible pad to shoot (0 = nearest, 1 = second nearest, ...).
    pad_rank: usize,
}

#[derive(Clone, Copy, Debug)]
enum Mode {
    Hop,
    HopW,
    /// W toward the target looking up (ladders).
    Climb,
    Walk,
    Jump(u32),
    Still,
}

impl Bot {
    fn step(&mut self, c: Cmd, out: &mut Vec<Rec>) {
        self.g.step(c).expect("step");
        out.push([c.forward, c.side, c.yaw, c.pitch, c.buttons as f32]);
    }

    fn run(&mut self, c: Cmd) {
        let mut out = std::mem::take(&mut self.cmds);
        self.step(c, &mut out);
        self.cmds = out;
    }

    /// One strafe-hop / walk controller tick toward `t`.
    /// One controller tick toward `t` (see `Params`).
    fn control(&self, mode: Mode, t: [f32; 3], k: &Params, tick: u32, nav: &Nav) -> Cmd {
        let s = &self.g.state;
        let p = s.position;
        let heading = (t[1] - p[1]).atan2(t[0] - p[0]).to_degrees();
        let to_target = ((t[0] - p[0]).powi(2) + (t[1] - p[1]).powi(2)).sqrt();
        let grounded = s.ground.is_some();
        let v = s.velocity;
        let speed = (v[0] * v[0] + v[1] * v[1]).sqrt();
        let vel = v[1].atan2(v[0]).to_degrees();
        let duck = if k.duck_air && !grounded { IN_DUCK } else { 0 };
        match mode {
            Mode::Still => cmd(0.0, 0.0, heading, 0.0, 0),
            Mode::Walk => cmd(450.0, 0.0, heading, 0.0, 0),
            Mode::Climb => {
                // Into the nearest ladder (jumping off the ground), climb with W looking up until level with the
                // target, then step off toward it.
                let ladder = nav
                    .ladders
                    .iter()
                    .map(|(a, b)| [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, b[2]])
                    .min_by(|a, b| {
                        let da = (a[0] - p[0]).powi(2) + (a[1] - p[1]).powi(2);
                        let db = (b[0] - p[0]).powi(2) + (b[1] - p[1]).powi(2);
                        da.total_cmp(&db)
                    })
                    .filter(|c| ((c[0] - p[0]).powi(2) + (c[1] - p[1]).powi(2)).sqrt() < 400.0);
                match ladder {
                    Some(c) if p[2] < t[2] - 4.0 => {
                        let h = (c[1] - p[1]).atan2(c[0] - p[0]).to_degrees();
                        let jump = if grounded && tick >= k.alt { IN_JUMP } else { 0 };
                        cmd(450.0, 0.0, h, -60.0, jump)
                    }
                    _ => cmd(450.0, 0.0, heading, 0.0, 0),
                }
            }
            Mode::Jump(at) => {
                let b = if tick == at { IN_JUMP } else { 0 } | if k.duck_air && !grounded && tick > at { IN_DUCK } else { 0 };
                cmd(450.0, 0.0, heading, 0.0, b)
            }
            Mode::Hop | Mode::HopW => {
                if grounded {
                    if speed < k.prespeed {
                        // Build ground speed first (a jump from a standstill keeps ~30 u/s with W alone).
                        return cmd(450.0, 0.0, heading, 0.0, 0);
                    }
                    return cmd(450.0, 0.0, heading, 0.0, IN_JUMP);
                }
                // Air stop over the target: back along the velocity (1000 airaccelerate: one tick leaves ~30 u/s).
                if k.brake > 0.0 && to_target < k.brake && speed > 45.0 {
                    return cmd(-450.0, 0.0, vel, 0.0, IN_JUMP | duck);
                }
                if speed > k.cap {
                    return cmd(0.0, 0.0, heading, 0.0, IN_JUMP | duck);
                }
                if matches!(mode, Mode::HopW) || speed < 20.0 {
                    return cmd(450.0, 0.0, heading, 0.0, IN_JUMP | duck);
                }
                let a = wrap(heading - vel);
                let turn = (30.0f32 / speed).atan().to_degrees();
                let side = if a.abs() > turn { a.signum() } else if (tick / k.alt.max(1)) % 2 == 0 { 1.0 } else { -1.0 };
                // Look along the velocity; A (side -450) turns left (wish = yaw + 90), D turns right.
                cmd(0.0, -450.0 * side, vel, 0.0, IN_JUMP | duck)
            }
        }
    }

    fn search(&mut self, goal: &dyn Fn(&Game) -> bool, goal_point: [f32; 3], nav_goal: &dyn Fn([f32; 3]) -> bool, label: &str) {
        self.search_scored(goal, goal_point, nav_goal, None, None, 0.0, label)
    }

    /// `search` with an optional score of its own (lower is better) instead of the nav's path distance.
    fn search_scored(&mut self, goal: &dyn Fn(&Game) -> bool, goal_point: [f32; 3], nav_goal: &dyn Fn([f32; 3]) -> bool, own: Option<&dyn Fn([f32; 3]) -> f32>, own_target: Option<&dyn Fn([f32; 3], f32) -> [f32; 3]>, min_speed: f32, label: &str) {
        let start = self.g.state.position;
        let (lo, hi) = self.area.take().unwrap_or_else(|| {
            let mut lo = [start[0].min(goal_point[0]) - 1024.0, start[1].min(goal_point[1]) - 1024.0, start[2].min(goal_point[2]) - 700.0];
            let mut hi = [start[0].max(goal_point[0]) + 1024.0, start[1].max(goal_point[1]) + 1024.0, start[2].max(goal_point[2]) + 500.0];
            // The current section: the fail teleports that send the player back near where it is now (their union
            // outlines the section's floor).
            for t in self.g.teleports() {
                let Some(d) = t.destination else { continue };
                if !t.enabled || t.filter.is_some() || (0..3).map(|k| (d[k] - start[k]).powi(2)).sum::<f32>().sqrt() > 600.0 {
                    continue;
                }
                for k in 0..3 {
                    let m = if k == 2 { 200.0 } else { 512.0 };
                    lo[k] = lo[k].min(t.mins[k] - m);
                    hi[k] = hi[k].max(t.maxs[k] + m + if k == 2 { 300.0 } else { 0.0 });
                }
            }
            (lo, hi)
        });
        let nav = if own.is_some() && own_target.is_some() {
            Nav::recording(&self.g)
        } else {
            Nav::build(&self.g, lo, hi, nav_goal, self.verbose)
        };
        if std::env::var_os("NAVDBG").is_some() {
            eprintln!("goal point {goal_point:?}");
            for (k, d) in nav.dist.iter().enumerate() {
                if *d == 0.0 {
                    eprintln!("  goal node {:?}", nav.pos[k].map(|v| v.round()));
                }
            }
            if let Some((ci, cj)) = nav.col(start) {
                for dj in -3..=3 {
                    for di in -3..=3 {
                        let (i, j) = (ci + di, cj + dj);
                        if i < 0 || j < 0 || i as usize >= nav.nx || j as usize >= nav.ny { continue; }
                        for &k in &nav.cols[j as usize * nav.nx + i as usize] {
                            eprintln!("  node {:?} dist {}", nav.pos[k as usize].map(|v| v.round()), nav.dist[k as usize]);
                        }
                    }
                }
            }
        }
        if std::env::var_os("NAVPATH").is_some() {
            let mut k = nav.node(start);
            let mut out = Vec::new();
            for _ in 0..200 {
                let Some(kk) = k else { break };
                out.push(nav.pos[kk as usize].map(|v| v.round()));
                let nk = nav.next[kk as usize];
                if nk == u32::MAX || nav.dist[kk as usize] == 0.0 {
                    break;
                }
                k = Some(nk);
            }
            eprintln!("navpath ({} steps): {:?}", out.len(), out);
        }
        if let Ok(spec) = std::env::var("NAVPROBE") {
            for pt in spec.split(';') {
                let v: Vec<f32> = pt.split(',').map(|x| x.parse().unwrap()).collect();
                eprintln!("  navprobe {:?}: score {}", v, nav.score([v[0], v[1], v[2]]));
            }
        }
        let (width, rollouts, iterations) = self.beam;
        let score_of = |p: [f32; 3]| own.map_or_else(|| nav.score(p), |f| f(p));
        let root = Node { state: Rc::new(self.g.save_state()), cmds: Rc::new(Vec::new()), score: score_of(start) + speed_goal_penalty(start, self.g.state.velocity, goal_point, min_speed), pos: start, velocity: self.g.state.velocity, expanded: 0 };
        let mut beam = vec![root];
        let mut best_ever = f32::INFINITY;
        let mut stale = 0u32;
        for it in 0..iterations {
            let mut cands: Vec<Node> = Vec::new();
            for (rank, node) in beam.iter().enumerate() {
                // Stuck: many more tries from the best few nodes (single precise jumps are rare finds).
                let tries = if stale >= 4 && rank < 3 { rollouts * 12 } else { rollouts };
                for _ in 0..tries {
                    self.g.restore_state(&node.state);
                    let mut out: Vec<Rec> = Vec::new();
                    let r = self.rng.f();
                    let mode = if r < 0.45 {
                        Mode::Hop
                    } else if r < 0.7 {
                        Mode::HopW
                    } else if r < 0.77 {
                        Mode::Climb
                    } else if r < 0.84 {
                        Mode::Walk
                    } else if r < 0.95 {
                        Mode::Jump(self.rng.range(0.0, 40.0) as u32)
                    } else {
                        Mode::Still
                    };
                    let k = self.rng.range(20.0, 140.0) as u32;
                    let params = Params {
                        // Keep precision approaches, but also allow ordinary
                        // strafe acceleration to build the >1000u/s momentum
                        // seen in gap-heavy public routes. This is a controller
                        // cap only: no speed setting or velocity injection.
                        cap: if let Some((min, max)) = self.caps { self.rng.range(min, max) } else if self.rng.f() < 0.25 { self.rng.range(1500.0, 3500.0) } else { self.rng.range(250.0, 900.0) },
                        alt: self.rng.range(3.0, 25.0) as u32,
                        duck_air: self.rng.f() < 0.15,
                        prespeed: if self.rng.f() < 0.5 { self.rng.range(0.0, 250.0) } else { 0.0 },
                        brake: if self.rng.f() < 0.4 { self.rng.range(4.0, 24.0) } else { 0.0 },
                        shoot: if self.has_gun() && self.rng.f() < 0.8 { self.rng.range(12.0, 60.0) as u32 } else { 0 },
                        rhythm: self.rng.f() < 0.7,
                        pad_rank: if self.rng.f() < 0.6 { 0 } else if self.rng.f() < 0.6 { 1 } else { 2 },
                    };
                    let mut pressed = false;
                    let look = self.rng.range(96.0, 420.0);
                    let j = if params.brake > 0.0 { 12.0 } else { 32.0 };
                    let jitter = [self.rng.range(-j, j), self.rng.range(-j, j)];
                    let ahead = |p: [f32; 3]| own_target.map(|f| f(p, look)).or_else(|| nav.target(p, look));
                    let mut target = ahead(node.pos).unwrap_or(goal_point);
                    target[0] += jitter[0];
                    target[1] += jitter[1];
                    let mut done = false;
                    let mut t = 0u32;
                    let mut airborne = false;
                    let hop = matches!(mode, Mode::Hop | Mode::HopW) && self.rng.f() < 0.75;
                    while t < k + 200 {
                        if t % 16 == 0 && t > 0 {
                            if let Some(mut q) = ahead(self.g.state.position) {
                                q[0] += jitter[0];
                                q[1] += jitter[1];
                                target = q;
                            }
                        }
                        let mut c = self.control(mode, target, &params, t, &nav);
                        if params.shoot > 0 {
                            // Pistols fire once per click: a press needs a released tick before it.
                            let boosted = self.boost_names.iter().any(|n| *n == self.g.player_name);
                            let fire = if params.rhythm { !boosted && !pressed } else { t % params.shoot == 0 };
                            pressed = false;
                            if let Some((yaw, pitch)) = self.aim_pad(params.pad_rank) {
                                c.yaw = wrap(yaw);
                                c.pitch = pitch;
                                if fire {
                                    c.buttons |= IN_ATTACK;
                                    pressed = true;
                                }
                            }
                        }
                        self.step(c, &mut out);
                        t += 1;
                        if goal(&self.g) {
                            done = true;
                            break;
                        }
                        let q = self.g.state.position;
                        if self.avoid.iter().any(|(lo, hi)| (0..3).all(|k| q[k] + 16.0 > lo[k] && q[k] - 16.0 < hi[k])) {
                            break;
                        }
                        let grounded = self.g.state.ground.is_some();
                        // One hop per rollout (most of the time): stop at the first landing.
                        if hop && airborne && grounded {
                            break;
                        }
                        airborne |= !grounded;
                        if t >= k && grounded {
                            break;
                        }
                    }
                    if std::env::var_os("ROLLDBG").is_some() && it == 8 {
                        eprintln!("    from {:?} mode {mode:?} cap {:.0} pre {:.0} brake {:.0} target {:?} -> {:?} ground {} tele {}", node.pos.map(|v| v.round()), params.cap, params.prespeed, params.brake, target.map(|v| v.round()), self.g.state.position.map(|v| v.round()), self.g.state.ground.is_some(), self.g.events & 1);
                    }
                    let mut cmds = (*node.cmds).clone();
                    cmds.extend_from_slice(&out);
                    if done {
                        if self.verbose {
                            eprintln!("{label}: reached after {it} iterations, {} ticks", cmds.len());
                        }
                        self.cmds.extend_from_slice(&cmds);
                        return;
                    }
                    let pos = self.g.state.position;
                    let forbidden = self.avoid.iter().any(|(lo, hi)| (0..3).all(|k| pos[k] + 16.0 > lo[k] && pos[k] - 16.0 < hi[k]));
                    let velocity = self.g.state.velocity;
                    let score = score_of(pos) + speed_goal_penalty(pos, velocity, goal_point, min_speed) + if self.g.state.ground.is_none() { 64.0 } else { 0.0 } + if forbidden { 1e9 } else { 0.0 };
                    cands.push(Node { state: Rc::new(self.g.save_state()), cmds: Rc::new(cmds), score, pos, velocity, expanded: 0 });
                }
            }
            // Elitism: the expanded nodes compete again, a little worse each time.
            for node in &beam {
                let mut kept = node.clone();
                kept.expanded += 1;
                kept.score += 24.0 * kept.expanded as f32;
                cands.push(kept);
            }
            cands.sort_by(|a, b| a.score.total_cmp(&b.score).then(a.cmds.len().cmp(&b.cmds.len())));
            let mut seen: HashMap<(i32, i32, i32, i32, i32), ()> = HashMap::new();
            beam.clear();
            for c in cands {
                let (vx, vy) = speed_goal_bucket(c.velocity, min_speed);
                let key = ((c.pos[0] / 64.0).floor() as i32, (c.pos[1] / 64.0).floor() as i32, (c.pos[2] / 64.0).floor() as i32, vx, vy);
                if seen.insert(key, ()).is_none() {
                    beam.push(c);
                    if beam.len() >= width {
                        break;
                    }
                }
            }
            if let Some(b) = beam.first() {
                if self.verbose && (it % 5 == 0 || b.score < best_ever) {
                    eprintln!("{label}: iteration {it} best {:.0} at {:?} ({} ticks)", b.score, b.pos.map(|v| v.round()), b.cmds.len());
                }
                if b.score < best_ever - 1.0 {
                    stale = 0;
                } else {
                    stale += 1;
                }
                best_ever = best_ever.min(b.score);
            }
        }
        // Not reached: the output keeps the commands up to here (resume with `replay`); the best attempt ended at:
        if let Some(b) = beam.first() {
            eprintln!("{label}: best attempt ended at {:?}", b.pos.map(|v| v.round()));
        }
        eprintln!("{label}: NOT reached (best score {best_ever:.0})");
        write_out(self, "FAILED");
        std::process::exit(2);
    }

    fn has_gun(&self) -> bool {
        self.g.weapons().1 & 0b110 != 0
    }

    /// View angles at the nearest damage-activated func_button in sight (within 1500u), if any.
    fn aim_pad(&self, rank: usize) -> Option<(f32, f32)> {
        let s = &self.g.state;
        let e = [s.position[0], s.position[1], s.position[2] + s.view_offset[2]];
        let mut seen: Vec<(f32, [f32; 3])> = Vec::new();
        for &(lo, hi) in &self.pads {
            // The point of the box nearest the eye, nudged toward its centre (thin pads: the middle).
            let q = [0, 1, 2].map(|k| {
                let inset = ((hi[k] - lo[k]) * 0.5).min(1.0);
                e[k].clamp(lo[k] + inset, hi[k] - inset)
            });
            let d = (0..3).map(|k| (q[k] - e[k]).powi(2)).sum::<f32>().sqrt();
            if d > 1500.0 {
                continue;
            }
            let t = self.g.trace_hull(e, q, Hull { mins: [0.0; 3], maxs: [0.0; 3] }, 0x1 | 0x2 | 0x8 | 0x4000 | 0x200_0000);
            let reached = (0..3).map(|k| (t.end[k] - q[k]).powi(2)).sum::<f32>().sqrt() < 4.0;
            if t.fraction >= 0.999 || reached {
                seen.push((d, q));
            }
        }
        seen.sort_by(|a, b| a.0.total_cmp(&b.0));
        let (_, q) = *seen.get(rank.min(seen.len().saturating_sub(1)))?;
        let d = [q[0] - e[0], q[1] - e[1], q[2] - e[2]];
        Some((d[1].atan2(d[0]).to_degrees(), -(d[2].atan2((d[0] * d[0] + d[1] * d[1]).sqrt())).to_degrees()))
    }

    fn aim(&mut self, p: [f32; 3]) {
        let s = &self.g.state;
        let e = [s.position[0], s.position[1], s.position[2] + s.view_offset[2]];
        let d = [p[0] - e[0], p[1] - e[1], p[2] - e[2]];
        self.yaw = d[1].atan2(d[0]).to_degrees();
        self.pitch = -(d[2].atan2((d[0] * d[0] + d[1] * d[1]).sqrt())).to_degrees();
    }
}

static mut OUT_PATH: String = String::new();

fn write_out(bot: &Bot, status: &str) {
    let spawn = bot.g.restart_point().map(|(p, yaw)| format!("{{\"position\":[{},{},{}],\"yaw\":{}}}", p[0], p[1], p[2], yaw)).unwrap_or("null".into());
    let cmds = bot.cmds.iter().map(|c| format!("[{},{},{},{},{}]", c[0], c[1], c[2], c[3], c[4])).collect::<Vec<_>>().join(",");
    let s = &bot.g.state;
    let json = format!(
        "{{\"status\":\"{status}\",\"ticks\":{},\"spawn\":{spawn},\"final\":[{},{},{}],\"cmds\":[{cmds}]}}\n",
        bot.cmds.len(),
        s.position[0],
        s.position[1],
        s.position[2]
    );
    #[allow(static_mut_refs)]
    std::fs::write(unsafe { &OUT_PATH }, json).expect("write output");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert!(args.len() >= 4, "usage: routebot <map> <route.txt> <out.json> [--physics N] [--seed N] [-v]");
    let mut physics = 4u32;
    let mut seed = 1u64;
    let verbose = args.iter().any(|a| a == "-v");
    for i in 4..args.len() {
        match args[i].as_str() {
            "--physics" => physics = args[i + 1].parse().unwrap(),
            "--seed" => seed = args[i + 1].parse().unwrap(),
            _ => {}
        }
    }
    unsafe { OUT_PATH = args[3].clone() };
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut g = bunnyhop_core::content::load_game(&root.join("maps").join(format!("{}.bsp", args[1]))).expect("load map");
    g.set_settings(Settings { physics_version: physics, ..Settings::css_bhop() });
    g.reset();
    let route = std::fs::read_to_string(&args[2]).expect("read route");
    let mut bot = Bot { g, cmds: Vec::new(), rng: Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1), yaw: 0.0, pitch: 0.0, verbose, area: None, beam: (16, 24, 200), caps: None, pads: Vec::new(), avoid: Vec::new(), boost_names: Vec::new() };
    bot.pads = (0..bot.g.entities.len())
        .filter(|&i| bot.g.entities[i].classname() == "func_button" && bot.g.entities[i].int("spawnflags") & 512 != 0)
        .filter_map(|i| bot.g.entity_bounds(i))
        .collect();
    for e in bot.g.entities.iter().filter(|e| e.classname() == "func_button" && e.int("spawnflags") & 512 != 0) {
        for (k, v) in &e.pairs {
            let f: Vec<&str> = v.split([',', '\x1b']).collect();
            if k.eq_ignore_ascii_case("OnDamaged") && f.len() >= 4 && f[1].eq_ignore_ascii_case("AddOutput") && f[3].trim().parse::<f32>().unwrap_or(1.0) == 0.0 {
                if let Some(name) = f[2].strip_prefix("targetname ") {
                    if !bot.boost_names.iter().any(|n| n == name) {
                        bot.boost_names.push(name.to_string());
                    }
                }
            }
        }
    }
    if verbose {
        eprintln!("{} damage buttons, boost names {:?}", bot.pads.len(), bot.boost_names);
    }
    for line in route.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let w: Vec<&str> = line.split_whitespace().collect();
        let n = |k: usize| w[k].parse::<f32>().unwrap_or_else(|_| panic!("bad number in `{line}`"));
        let opt = |k: usize, d: f32| w.get(k).and_then(|s| s.parse::<f32>().ok()).unwrap_or(d);
        let t0 = std::time::Instant::now();
        match w[0] {
            "spawn" => {
                bot.g.set_position([n(1), n(2), n(3)], n(4));
                bot.yaw = n(4);
            }
            "replay" => {
                // Replays a previous output's commands (its spawn must match this route's).
                let text = std::fs::read_to_string(w[1]).expect("read replay json");
                let start = text.find("\"cmds\":[").expect("cmds") + 8;
                let body = &text[start..text.rfind(']').expect("end")];
                for c in body.split("],[") {
                    let v: Vec<f32> = c.trim_matches(|ch| ch == '[' || ch == ']').split(',').filter(|x| !x.is_empty()).map(|x| x.parse().unwrap()).collect();
                    if v.len() == 5 {
                        bot.run(Cmd { forward: v[0], side: v[1], yaw: v[2], pitch: v[3], buttons: v[4] as u32 });
                    }
                }
            }
            "avoid" => bot.avoid.push(([n(1), n(2), n(3)], [n(4), n(5), n(6)])),
            "wait" => {
                for _ in 0..n(1) as u32 {
                    let c = cmd(0.0, 0.0, bot.yaw, bot.pitch, 0);
                    bot.run(c);
                }
            }
            "area" => bot.area = Some(([n(1), n(2), n(3)], [n(4), n(5), n(6)])),
            "caps" => {
                let (min, max) = (n(1), n(2));
                assert!(min.is_finite() && max.is_finite() && min >= 0.0 && max >= min, "invalid caps");
                bot.caps = Some((min, max));
            }
            "beam" => bot.beam = (n(1) as usize, n(2) as usize, n(3) as usize),
            "goto" | "dest" => {
                let (p, r, air) = if w[0] == "dest" {
                    let i = (0..bot.g.entities.len())
                        .find(|&i| {
                            let e = &bot.g.entities[i];
                            e.get("targetname") == Some(w[1]) && matches!(e.classname(), "info_teleport_destination" | "info_target")
                        })
                        .unwrap_or_else(|| panic!("no destination {}", w[1]));
                    (bot.g.entities[i].origin(), opt(2, 96.0), false)
                } else {
                    ([n(1), n(2), n(3)], opt(4, 64.0), w.get(5) == Some(&"air"))
                };
                let goal = move |g: &Game| {
                    let q = g.state.position;
                    let h = ((q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2)).sqrt();
                    // Destinations float up to ~100u over their floor.
                    h <= r && (-130.0..=72.0).contains(&(q[2] - p[2])) && (air || g.state.ground.is_some())
                };
                let nav_goal = move |q: [f32; 3]| ((q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2)).sqrt() <= r.max(48.0) && (-130.0..=72.0).contains(&(q[2] - p[2]));
                bot.search(&goal, p, &nav_goal, line);
            }
            "rise" => {
                // rise x y ztop [radius]: beam search (no nav distance) until the feet are at ztop or higher within
                // `radius` (default 192) of (x, y): climbing a shot-activated column. Score: the horizontal way to the
                // column plus the height left.
                let (p, r) = ([n(1), n(2), n(3)], opt(4, 192.0));
                let goal = move |g: &Game| {
                    let q = g.state.position;
                    ((q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2)).sqrt() <= r && q[2] >= p[2]
                };
                let own = move |q: [f32; 3]| (((q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2)).sqrt() - r).max(0.0) + (p[2] - q[2]).max(0.0) * 2.0;
                bot.search_scored(&goal, p, &|_| false, Some(&own), None, 0.0, line);
            }
            "path" | "path-land" | "path-land-speed" | "path3d-land" => {
                // path radius x y z x y z ...: beam search along a polyline (air routes the floor nav can't see, e.g.
                // a pit crossed on shot-activated pushes). Score: the polyline length left after the player's
                // projection plus the height below the line; done within `radius` of the last point.
                let speed_goal = w[0] == "path-land-speed";
                let three_d = w[0] == "path3d-land";
                let distance = move |a: [f32; 3], b: [f32; 3]| {
                    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)
                        + if three_d { (a[2] - b[2]).powi(2) } else { 0.0 }).sqrt()
                };
                let min_speed = if speed_goal { n(1) } else { 0.0 };
                assert!(min_speed.is_finite() && min_speed >= 0.0, "invalid minimum speed");
                let offset = if speed_goal { 3 } else { 2 };
                let r = n(offset - 1);
                let land = w[0] != "path";
                let pts: Vec<[f32; 3]> = (0..(w.len() - offset) / 3).map(|k| [n(offset + 3 * k), n(offset + 1 + 3 * k), n(offset + 2 + 3 * k)]).collect();
                let last = *pts.last().expect("path points");
                let proj = {
                    let pts = pts.clone();
                    move |q: [f32; 3]| -> (f32, [f32; 3], usize, f32) {
                        // (length left, closest point, segment, t) over the segments.
                        let mut best = (f32::INFINITY, pts[0], 0usize, 0.0f32, f32::INFINITY);
                        for k in 0..pts.len().saturating_sub(1) {
                            let (a, b) = (pts[k], pts[k + 1]);
                            let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                            let l2 = (ab[0] * ab[0] + ab[1] * ab[1]
                                + if three_d { ab[2] * ab[2] } else { 0.0 }).max(1.0);
                            let dot = (q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]
                                + if three_d { (q[2] - a[2]) * ab[2] } else { 0.0 };
                            let t = (dot / l2).clamp(0.0, 1.0);
                            let c = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
                            let off = distance(q, c);
                            if off < best.4 - 1.0 || (off < best.4 + 1.0 && k > best.2) {
                                let mut left = (1.0 - t) * l2.sqrt();
                                for m in k + 1..pts.len() - 1 {
                                    left += distance(pts[m + 1], pts[m]);
                                }
                                best = (left, c, k, t, off);
                            }
                        }
                        (best.0 + best.4 * if three_d { 8.0 } else { 1.0 }, best.1, best.2, best.3)
                    }
                };
                let own = {
                    let proj = proj.clone();
                    move |q: [f32; 3]| {
                        let (left, c, _, _) = proj(q);
                        left + if three_d { 0.0 } else { (c[2] - q[2]).max(0.0) }
                    }
                };
                let ahead = {
                    let pts = pts.clone();
                    let proj = proj.clone();
                    move |q: [f32; 3], look: f32| {
                        let (_, c, k, _) = proj(q);
                        // `look` units further along the line.
                        let mut cur = c;
                        let mut left = look;
                        for m in k + 1..pts.len() {
                            let d = distance(pts[m], cur);
                            if d >= left {
                                let f = left / d.max(1e-3);
                                return [cur[0] + (pts[m][0] - cur[0]) * f, cur[1] + (pts[m][1] - cur[1]) * f, cur[2] + (pts[m][2] - cur[2]) * f];
                            }
                            left -= d;
                            cur = pts[m];
                        }
                        cur
                    }
                };
                let goal = move |g: &Game| {
                    let q = g.state.position;
                    ((q[0] - last[0]).powi(2) + (q[1] - last[1]).powi(2)).sqrt() <= r
                        && (q[2] - last[2]).abs() <= if land { 32.0 } else { 96.0 }
                        && (!land || g.state.ground.is_some())
                        && g.state.velocity[0].hypot(g.state.velocity[1]) >= min_speed
                };
                bot.search_scored(&goal, last, &|_| false, Some(&own), Some(&ahead), min_speed, line);
            }
            "land" => {
                // Recorded landing point: a local collision search, not a
                // global floor graph and not an enforced airborne trajectory.
                let p = [n(1), n(2), n(3)];
                let radius = opt(4, 48.0);
                let goal = move |g: &Game| g.state.ground.is_some()
                    && ((g.state.position[0] - p[0]).powi(2) + (g.state.position[1] - p[1]).powi(2)).sqrt() <= radius
                    && (g.state.position[2] - p[2]).abs() <= 32.0;
                let metric = move |q: [f32; 3]| ((q[0]-p[0]).powi(2) + (q[1]-p[1]).powi(2)).sqrt()
                    + (p[2]-q[2]).max(0.0)*2.0 + (q[2]-p[2]).abs()*0.2;
                let ahead = move |_q: [f32; 3], _look: f32| p;
                bot.search_scored(&goal, p, &|_| false, Some(&metric), Some(&ahead), 0.0, line);
            }
            "zone" | "zone-direct" => {
                let (lo, hi) = ([n(1), n(2), n(3)], [n(4), n(5), n(6)]);
                let inside = move |q: [f32; 3]| (0..3).all(|k| q[k] >= lo[k] - 16.0 && q[k] <= hi[k] + 16.0);
                let goal = move |g: &Game| inside(g.state.position);
                let center = [(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5, lo[2]];
                if w[0] == "zone-direct" {
                    let metric = move |q: [f32; 3]| (0..3).map(|k| (lo[k]-q[k]).max(0.0).max(q[k]-hi[k])).sum::<f32>();
                    let ahead = move |_q: [f32; 3], _look: f32| center;
                    bot.search_scored(&goal, center, &inside, Some(&metric), Some(&ahead), 0.0, line);
                } else {
                    bot.search(&goal, center, &inside, line);
                }
            }
            "walk" => {
                let (x, y) = (n(1), n(2));
                let b = opt(3, 0.0) as u32;
                for _ in 0..opt(4, 3000.0) as u32 {
                    let p = bot.g.state.position;
                    if ((x - p[0]).powi(2) + (y - p[1]).powi(2)).sqrt() < 12.0 {
                        break;
                    }
                    let yaw = (y - p[1]).atan2(x - p[0]).to_degrees();
                    bot.run(cmd(450.0, 0.0, yaw, 0.0, b));
                }
            }
            "look" => {
                bot.yaw = n(1);
                bot.pitch = n(2);
            }
            "aim" => bot.aim([n(1), n(2), n(3)]),
            "cmd" => {
                for _ in 0..n(1) as u32 {
                    let c = cmd(n(2), n(3), bot.yaw, bot.pitch, n(4) as u32);
                    bot.run(c);
                }
            }
            "use" => {
                bot.aim([n(1), n(2), n(3)]);
                for b in [0, IN_USE, IN_USE, 0] {
                    let c = cmd(0.0, 0.0, bot.yaw, bot.pitch, b);
                    bot.run(c);
                }
            }
            "climb" => {
                // climb x y z ztop [maxticks] [hold]: ride a shot-activated push. Aim at (x, y, z) (the pad / panel),
                // re-fire as soon as the boost name is gone (one click per window, pistols need a released tick),
                // steer horizontally toward (x, y) unless `hold` is 0 (then no movement keys), until the feet are
                // at ztop or higher.
                let (p, ztop, max, steer) = ([n(1), n(2), n(3)], n(4), opt(5, 1500.0) as u32, opt(6, 1.0) != 0.0);
                let mut pressed = false;
                for _ in 0..max {
                    let s = &bot.g.state;
                    if s.position[2] >= ztop {
                        break;
                    }
                    let e = [s.position[0], s.position[1], s.position[2] + s.view_offset[2]];
                    let d = [p[0] - e[0], p[1] - e[1], p[2] - e[2]];
                    let h = (d[0] * d[0] + d[1] * d[1]).sqrt();
                    let yaw = d[1].atan2(d[0]).to_degrees();
                    let pitch = -(d[2].atan2(h)).to_degrees();
                    let boosted = bot.boost_names.iter().any(|nm| *nm == bot.g.player_name);
                    let fire = !boosted && !pressed;
                    pressed = fire;
                    let fwd = if steer && h > 24.0 { 450.0 } else { 0.0 };
                    let c = cmd(fwd, 0.0, yaw, pitch.clamp(-89.0, 89.0), if fire { IN_ATTACK } else { 0 });
                    bot.run(c);
                }
            }
            "fire" => {
                let (count, interval, held) = (n(1) as u32, n(2) as u32, opt(3, 0.0) as u32);
                for _ in 0..count {
                    for t in 0..interval.max(2) {
                        let b = held | if t == 0 { IN_ATTACK } else { 0 };
                        let c = cmd(0.0, 0.0, bot.yaw, bot.pitch, b);
                        bot.run(c);
                    }
                }
            }
            other => panic!("unknown route step `{other}`"),
        }
        let s = &bot.g.state;
        eprintln!("[{:>6}] {line}  ->  pos {:?} vel {:?} ground {} weapons {:?} ({:.1?})", bot.cmds.len(), s.position.map(|v| v.round()), s.velocity.map(|v| v.round()), s.ground.is_some(), bot.g.weapons(), t0.elapsed());
        write_out(&bot, "partial");
    }
    write_out(&bot, "ok");
}

#[cfg(test)]
mod speed_goal_tests {
    use super::{speed_goal_bucket, speed_goal_penalty};

    #[test]
    fn ordinary_search_keeps_position_only_behavior() {
        assert_eq!(speed_goal_penalty([0.0; 3], [0.0; 3], [0.0; 3], 0.0), 0.0);
        assert_eq!(speed_goal_bucket([1200.0, -900.0, 0.0], 0.0), (0, 0));
    }

    #[test]
    fn near_landing_fast_candidate_beats_stationary_candidate() {
        let landing = [100.0, 200.0, -680.0];
        let slow = speed_goal_penalty(landing, [0.0; 3], landing, 750.0);
        let fast = speed_goal_penalty(landing, [0.0, -800.0, 0.0], landing, 750.0);
        assert!(slow > fast);
        assert_eq!(fast, 0.0);
        // Building speed far away must not displace following the route geometry.
        assert_eq!(speed_goal_penalty([100.0, 1200.0, -680.0], [0.0; 3], landing, 750.0), 0.0);
    }

    #[test]
    fn same_position_can_retain_fast_and_opposite_approaches() {
        assert_ne!(speed_goal_bucket([0.0; 3], 750.0), speed_goal_bucket([0.0, -800.0, 0.0], 750.0));
        assert_ne!(speed_goal_bucket([0.0, 800.0, 0.0], 750.0), speed_goal_bucket([0.0, -800.0, 0.0], 750.0));
    }
}
