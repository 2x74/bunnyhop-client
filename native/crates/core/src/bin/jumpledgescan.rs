//! Physics v25 skip scan (research/NATIVE-JUMP-OFFSET-V25.md): ledges whose reach changes when every ground jump starts
//! at floor + 1.5. Geometry first: the walkable top faces of the map's solid brushes (world and solid brush entities at
//! their spawn position; no displacements or props), paired with walkable faces 55-66 units lower within `reach`
//! horizontally. Then each pair is played, not searched: a bhop landing on the lower face at a fixed landing phase,
//! moving straight at the ledge at a few speeds, jump held (and duck held for crouch jumps), from a sweep of takeoff
//! spots. Three ways: v24 with a low landing (0.03 above the floor), v24 with a high one (1.98 above), v25 (any landing:
//! the jump starts at 1.53). One JSON line per map.
//!
//!   jumpledgescan <map.bsp> [reach 384] [seconds 120]
//!
//! A pair is reported when v25 changes something: `gained` (v25 lands on the ledge, v24 only from a high landing or not
//! at all) or `lost` (v24 from a high landing, v25 never). Floors or ledges inside an enabled trigger_teleport are skipped.
//! Rises of exactly 64 or 56 (the usual block heights) are only counted (`std64`, `std56`): reachable on v24 from any
//! landing, so only the window changes. JLS_DEBUG=1 prints every played pair to stderr. research/NATIVE-JUMP-OFFSET-V25.md
//! and the v0.0.37 report have the catalogue run (3 workers, ~5 CPU-minutes for 1,109 maps).

use bunnyhop_core::content::load_game;
use bunnyhop_core::game::{EVENT_RESPAWNED, EVENT_TELEPORTED, IN_DUCK, IN_JUMP, PHYSICS_V24, PHYSICS_V25};
use bunnyhop_core::{Cmd, Game, Settings};
use playsrc_collision::{Hull, MASK_PLAYERSOLID};
use std::fmt::Write as _;
use std::path::Path;

const STAND: Hull = Hull { mins: [-16.0, -16.0, 0.0], maxs: [16.0, 16.0, 62.0] };
const DUCK: Hull = Hull { mins: [-16.0, -16.0, 0.0], maxs: [16.0, 16.0, 45.0] };

/// A walkable top face: its polygon (world space) and plane.
struct Face {
    poly: Vec<[f32; 3]>,
    normal: [f32; 3],
    dist: f32,
    lo: [f32; 3],
    hi: [f32; 3],
}

impl Face {
    fn z_at(&self, x: f32, y: f32) -> f32 {
        (self.dist - self.normal[0] * x - self.normal[1] * y) / self.normal[2]
    }
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// The brush side on plane (n, d) as a polygon: a big square on the plane clipped by every other side (n_j . x <= d_j).
fn side_polygon(n: [f32; 3], d: f32, others: &[([f32; 3], f32)]) -> Vec<[f32; 3]> {
    // Basis on the plane.
    let up = if n[2].abs() < 0.9 { [0.0, 0.0, 1.0] } else { [1.0, 0.0, 0.0] };
    let cross = |a: [f32; 3], b: [f32; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let u = cross(n, up);
    let ul = dot(u, u).sqrt();
    let u = [u[0] / ul, u[1] / ul, u[2] / ul];
    let v = cross(n, u);
    let c = [n[0] * d, n[1] * d, n[2] * d];
    const S: f32 = 65536.0;
    let mut poly: Vec<[f64; 3]> = [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)]
        .iter()
        .map(|&(a, b): &(f32, f32)| {
            [
                (c[0] + (u[0] * a + v[0] * b) * S) as f64,
                (c[1] + (u[1] * a + v[1] * b) * S) as f64,
                (c[2] + (u[2] * a + v[2] * b) * S) as f64,
            ]
        })
        .collect();
    for &(m, e) in others {
        let side = |p: [f64; 3]| m[0] as f64 * p[0] + m[1] as f64 * p[1] + m[2] as f64 * p[2] - e as f64;
        let mut out = Vec::with_capacity(poly.len() + 1);
        for i in 0..poly.len() {
            let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
            let (sa, sb) = (side(a), side(b));
            if sa <= 0.01 {
                out.push(a);
            }
            if (sa < -0.01 && sb > 0.01) || (sa > 0.01 && sb < -0.01) {
                let t = sa / (sa - sb);
                out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
            }
        }
        poly = out;
        if poly.len() < 3 {
            return Vec::new();
        }
    }
    poly.into_iter().map(|p| [p[0] as f32, p[1] as f32, p[2] as f32]).collect()
}

fn faces(game: &Game) -> Vec<Face> {
    let w = game.collision_world();
    let mut out = Vec::new();
    let add_brush = |b: usize, offset: [f32; 3], out: &mut Vec<Face>| {
        let brush = &w.brushes[b];
        if brush.contents & MASK_PLAYERSOLID == 0 {
            return;
        }
        let sides: Vec<([f32; 3], f32)> = (brush.first_side..brush.first_side + brush.side_count)
            .map(|s| {
                let p = w.planes[w.sides[s].plane];
                (p.normal, p.distance + dot(p.normal, offset))
            })
            .collect();
        for (i, &(n, d)) in sides.iter().enumerate() {
            if n[2] < 0.7 || w.sides[brush.first_side + i].bevel != 0 {
                continue;
            }
            let others: Vec<_> = sides.iter().enumerate().filter(|&(j, _)| j != i).map(|(_, s)| *s).collect();
            let poly = side_polygon(n, d, &others);
            if poly.len() < 3 {
                continue;
            }
            let mut lo = [f32::MAX; 3];
            let mut hi = [f32::MIN; 3];
            for p in &poly {
                for k in 0..3 {
                    lo[k] = lo[k].min(p[k]);
                    hi[k] = hi[k].max(p[k]);
                }
            }
            // A hull has to fit on it (32 x 32), give or take an edge overhang: skip slivers.
            if hi[0] - lo[0] < 8.0 || hi[1] - lo[1] < 8.0 || lo[0].abs() > 30000.0 || lo[1].abs() > 30000.0 {
                continue;
            }
            out.push(Face { poly, normal: n, dist: d, lo, hi });
        }
    };
    for &b in &w.world_brushes {
        add_brush(b, [0.0; 3], &mut out);
    }
    // Solid brush entities at their spawn transform (unrotated only).
    let transforms = game.brush_transforms();
    let mut k = 0;
    for index in 0.. {
        if game.entity_transform(index).is_none() {
            break;
        }
        if game.entity_bounds(index).is_none() {
            continue;
        }
        let (model, origin, angles) = transforms[k];
        k += 1;
        if angles != [0.0; 3] || !game.entity_solidity(index).is_some_and(|(solid, _)| solid) {
            continue;
        }
        if let Some(list) = w.model_brushes.get(model as usize) {
            for &b in list {
                add_brush(b, origin, &mut out);
            }
        }
    }
    out
}

/// Closest points between two convex polygons' projections on the xy plane (vertex-to-edge both ways).
fn closest_2d(a: &[[f32; 3]], b: &[[f32; 3]]) -> (f32, [f32; 2], [f32; 2]) {
    let seg = |p: [f32; 2], s0: [f32; 2], s1: [f32; 2]| {
        let (dx, dy) = (s1[0] - s0[0], s1[1] - s0[1]);
        let l = dx * dx + dy * dy;
        let t = if l > 0.0 { (((p[0] - s0[0]) * dx + (p[1] - s0[1]) * dy) / l).clamp(0.0, 1.0) } else { 0.0 };
        [s0[0] + dx * t, s0[1] + dy * t]
    };
    let inside = |p: [f32; 2], poly: &[[f32; 3]]| {
        let mut sign = 0.0f32;
        for i in 0..poly.len() {
            let (s0, s1) = (poly[i], poly[(i + 1) % poly.len()]);
            let c = (s1[0] - s0[0]) * (p[1] - s0[1]) - (s1[1] - s0[1]) * (p[0] - s0[0]);
            if c.abs() < 1e-3 {
                continue;
            }
            if sign == 0.0 {
                sign = c.signum();
            } else if c.signum() != sign {
                return false;
            }
        }
        true
    };
    let mut best = (f32::MAX, [0.0; 2], [0.0; 2]);
    for (p, q, flip) in [(a, b, false), (b, a, true)] {
        for v in p {
            let v2 = [v[0], v[1]];
            if inside(v2, q) {
                let r = if flip { (0.0, v2, v2) } else { (0.0, v2, v2) };
                if r.0 < best.0 {
                    best = r;
                }
                continue;
            }
            for i in 0..q.len() {
                let c = seg(v2, [q[i][0], q[i][1]], [q[(i + 1) % q.len()][0], q[(i + 1) % q.len()][1]]);
                let d = ((c[0] - v2[0]).powi(2) + (c[1] - v2[1]).powi(2)).sqrt();
                if d < best.0 {
                    best = if flip { (d, c, v2) } else { (d, v2, c) };
                }
            }
        }
    }
    best
}

/// Where a hull dropped at (x, y) from `top` rests, if on a walkable surface near `expect`.
fn rest(game: &Game, x: f32, y: f32, top: f32, expect: f32, hull: Hull) -> Option<f32> {
    let t = game.trace_hull([x, y, top], [x, y, expect - 4.0], hull, MASK_PLAYERSOLID);
    (!t.start_solid && t.fraction < 1.0 && t.normal.is_some_and(|n| n[2] >= 0.7) && (t.end[2] - expect).abs() < 1.5).then_some(t.end[2])
}

fn in_teleport(boxes: &[([f32; 3], [f32; 3])], p: [f32; 3]) -> bool {
    boxes.iter().any(|(lo, hi)| {
        p[0] + 16.0 > lo[0] && p[0] - 16.0 < hi[0] && p[1] + 16.0 > lo[1] && p[1] - 16.0 < hi[1] && p[2] + 1.0 > lo[2] && p[2] < hi[2]
    })
}

#[derive(Default, Clone, Copy)]
struct Tally {
    low: u32,
    high: u32,
    v25: u32,
    tries: u32,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = Path::new(&args[1]);
    let reach: f32 = args.get(2).map_or(384.0, |v| v.parse().unwrap());
    let seconds: f32 = args.get(3).map_or(120.0, |v| v.parse().unwrap());
    let name = path.file_stem().unwrap().to_string_lossy().to_string();
    let began = std::time::Instant::now();
    let Ok(mut game) = load_game(path) else {
        println!("{{\"map\":\"{name}\",\"error\":\"load\"}}");
        return;
    };
    // A saved state carries its settings, so each version restores its own.
    game.set_settings(Settings { physics_version: PHYSICS_V24, ..Settings::css_bhop() });
    game.reset();
    let fresh24 = game.save_state();
    game.set_settings(Settings { physics_version: PHYSICS_V25, ..Settings::css_bhop() });
    game.reset();
    let fresh25 = game.save_state();
    let teleports: Vec<_> = game.teleports().into_iter().filter(|t| t.enabled && t.filter.is_none()).map(|t| (t.mins, t.maxs)).collect();
    let faces = faces(&game);
    // Faces by top height, for the band queries.
    let mut order: Vec<usize> = (0..faces.len()).collect();
    order.sort_by(|&a, &b| faces[a].hi[2].total_cmp(&faces[b].hi[2]));
    let (mut pairs, mut checked, mut truncated, mut std64, mut std56) = (0u32, 0u32, false, 0u32, 0u32);
    // Pairs in the band. Each ledge spot and floor height is played once (adjacent brushes split floors): by the nearest
    // floor piece that passes the standing checks below.
    let mut list: Vec<((i32, i32, i32, i32), f32, usize, usize, [f32; 2], [f32; 2], f32, f32)> = Vec::new();
    for &li in &order {
        let l = &faces[li];
        for &fi in &order {
            let f = &faces[fi];
            // Height band: 54-67 under the ledge (both bands with margin; the simulation decides).
            if f.hi[2] < l.lo[2] - 67.0 || f.lo[2] > l.hi[2] - 54.0 {
                continue;
            }
            if f.lo[0] > l.hi[0] + reach || f.hi[0] < l.lo[0] - reach || f.lo[1] > l.hi[1] + reach || f.hi[1] < l.lo[1] - reach {
                continue;
            }
            let (gap, fp, lp) = closest_2d(&f.poly, &l.poly);
            if gap > reach {
                continue;
            }
            let (zf, zl) = (f.z_at(fp[0], fp[1]), l.z_at(lp[0], lp[1]));
            if !(54.0..=67.0).contains(&(zl - zf)) {
                continue;
            }
            pairs += 1;
            let key = ((lp[0] / 48.0).round() as i32, (lp[1] / 48.0).round() as i32, (zl * 4.0).round() as i32, (zf * 4.0).round() as i32);
            list.push((key, gap, fi, li, fp, lp, zf, zl));
        }
    }
    list.sort_by(|a, b| a.1.total_cmp(&b.1));
    let mut done = std::collections::HashSet::new();
    let mut rows = String::new();
    for (key, gap, fi, li, fp, lp, zf, zl) in list {
        if done.contains(&key) {
            continue;
        }
        if began.elapsed().as_secs_f32() > seconds {
            truncated = true;
            break;
        }
        let (f, l) = (&faces[fi], &faces[li]);
        {
            // Direction from the floor spot to the ledge spot; adjacent faces: centroid to centroid.
            let (mut dx, mut dy) = (lp[0] - fp[0], lp[1] - fp[1]);
            if (dx * dx + dy * dy).sqrt() < 1.0 {
                let c = |p: &Face| {
                    let n = p.poly.len() as f32;
                    [p.poly.iter().map(|v| v[0]).sum::<f32>() / n, p.poly.iter().map(|v| v[1]).sum::<f32>() / n]
                };
                let (cf, cl) = (c(f), c(l));
                dx = cl[0] - cf[0];
                dy = cl[1] - cf[1];
            }
            let dl = (dx * dx + dy * dy).sqrt();
            if dl < 1.0 {
                continue;
            }
            let dir = [dx / dl, dy / dl];
            // The ledge spot: 18 units in from its edge along the direction (the hull must be on it).
            // The ledge spot 18 units in from its edge along the direction (the hull on it), the floor spot 17 back (the hull's
            // centre over the floor). The closest points are often corners against a wall: slide both sideways until a hull
            // stands on each.
            let side = [-dir[1], dir[0]];
            let Some((ledge, zl_rest, edge, zf_rest)) = [0.0f32, 16.0, -16.0, 32.0, -32.0, 48.0, -48.0, 64.0, -64.0].iter().find_map(|&o| {
                let ledge = [lp[0] + dir[0] * 18.0 + side[0] * o, lp[1] + dir[1] * 18.0 + side[1] * o];
                let edge = [fp[0] - dir[0] * 17.0 + side[0] * o, fp[1] - dir[1] * 17.0 + side[1] * o];
                let zl_rest = rest(&game, ledge[0], ledge[1], zl + 66.0, zl + 0.03125, DUCK)?;
                let zf_rest = rest(&game, edge[0], edge[1], zf + 64.0, zf + 0.03125, STAND)?;
                Some((ledge, zl_rest, edge, zf_rest))
            }) else {
                continue;
            };
            if in_teleport(&teleports, [edge[0], edge[1], zf_rest]) || in_teleport(&teleports, [ledge[0], ledge[1], zl_rest]) {
                if std::env::var_os("JLS_DEBUG").is_some() {
                    eprintln!("teleport-skip floor {edge:?} {zf_rest:.2} ledge {ledge:?} {zl_rest:.2}");
                }
                continue;
            }
            done.insert(key);
            let rise = zl_rest - zf_rest;
            // Exact 64 / 56 rises (the usual block heights) are the tranquility case: reachable on v24 from any landing,
            // through a window that grows with the landing height; v25 gives every landing the 1.5 one. Counted, not
            // played. Other rises below 64 are a v24 crouch jump from any landing, above 66.2 nobody's.
            if (rise - 64.0).abs() <= 0.05 {
                std64 += 1;
                continue;
            }
            if (rise - 56.0).abs() <= 0.05 {
                std56 += 1;
                continue;
            }
            let crouch = if rise > 64.05 && rise <= 66.2 {
                true
            } else if rise > 55.55 && rise <= 57.6 {
                false
            } else {
                continue;
            };
            checked += 1;
            let mut tally = Tally::default();
            let mut best_speed = 0.0f32;
            let mut min_speed = f32::MAX;
            for speed in [280.0f32, 450.0, 700.0, 1000.0] {
                for step in 0..24 {
                    // Takeoff `back` units behind the floor's edge, so the face is met 0.12-0.58 s into the jump.
                    let t = 0.12 + step as f32 * 0.02;
                    let back = speed * t - gap - 17.0;
                    if back < 0.0 {
                        continue;
                    }
                    let start = [edge[0] - dir[0] * back, edge[1] - dir[1] * back];
                    // The takeoff spot must be on this floor (same height, walkable, no teleport).
                    if rest(&game, start[0], start[1], zf + 64.0, zf + 0.03125, STAND).is_none() || in_teleport(&teleports, [start[0], start[1], zf_rest]) {
                        continue;
                    }
                    tally.tries += 1;
                    for (mode, version, drop) in [(0, PHYSICS_V24, 0.0f32), (1, PHYSICS_V24, 1.95), (2, PHYSICS_V25, 0.0)] {
                        game.restore_state(if version == PHYSICS_V25 { &fresh25 } else { &fresh24 });
                        // Placed `drop` over the floor's rest height: the move's CategorizePosition grounds it there, so it jumps from
                        // exactly that landing phase on the first tick (as crates/core/src/bin/crouchledge.rs).
                        game.place_player([start[0], start[1], zf_rest + drop]);
                        game.state.velocity = [dir[0] * speed, dir[1] * speed, -290.0];
                        game.state.ground = None;
                        game.state.jump_latched = false;
                        let yaw = dir[1].atan2(dir[0]).to_degrees();
                        let mut jumped = false;
                        let mut on = false;
                        for _ in 0..90 {
                            let buttons = IN_JUMP | if crouch && jumped { IN_DUCK } else { 0 };
                            if game.step(Cmd { forward: 0.0, side: 0.0, yaw, pitch: 0.0, buttons }).is_err() {
                                break;
                            }
                            if game.events & (EVENT_TELEPORTED | EVENT_RESPAWNED) != 0 {
                                break;
                            }
                            jumped |= game.events & 2 != 0;
                            if jumped && game.state.ground.is_some() {
                                // The first landing after the jump decides: the ledge, or anything else.
                                let p = game.state.position;
                                on = (p[2] - zl_rest).abs() < 1.0 && (p[0] - ledge[0]).abs() < 96.0 + speed * 0.1 && (p[1] - ledge[1]).abs() < 96.0 + speed * 0.1;
                                break;
                            }
                        }
                        if on {
                            match mode {
                                0 => tally.low += 1,
                                1 => tally.high += 1,
                                _ => {
                                    tally.v25 += 1;
                                    best_speed = best_speed.max(speed);
                                    min_speed = min_speed.min(speed);
                                }
                            }
                        }
                    }
                }
            }
            if std::env::var_os("JLS_DEBUG").is_some() {
                eprintln!("pair floor {edge:?} {zf_rest:.2} ledge {ledge:?} {zl_rest:.2} gap {gap:.0} rise {rise:.2} tries {} low {} high {} v25 {}", tally.tries, tally.low, tally.high, tally.v25);
            }
            let kind = if tally.v25 > 0 && tally.low == 0 {
                "gained"
            } else if tally.v25 == 0 && tally.high > 0 {
                "lost"
            } else if tally.v25 > 0 && tally.v25 > tally.low {
                "wider"
            } else if tally.v25 == 0 && tally.high == 0 && tally.low == 0 {
                "none"
            } else {
                "same"
            };
            if !rows.is_empty() {
                rows.push(',');
            }
            let _ = write!(
                rows,
                "{{\"kind\":\"{kind}\",\"jump\":\"{}\",\"rise\":{rise:.2},\"floor\":[{:.0},{:.0},{:.2}],\"ledge\":[{:.0},{:.0},{:.2}],\"gap\":{gap:.0},\"tries\":{},\"v24low\":{},\"v24high\":{},\"v25\":{},\"speed\":{best_speed},\"minSpeed\":{}}}",
                if crouch { "crouch" } else { "stand" },
                edge[0], edge[1], zf_rest, ledge[0], ledge[1], zl_rest, tally.tries, tally.low, tally.high, tally.v25, if min_speed == f32::MAX { 0.0 } else { min_speed }
            );
        }
    }
    println!(
        "{{\"map\":\"{name}\",\"faces\":{},\"pairs\":{pairs},\"std64\":{std64},\"std56\":{std56},\"checked\":{checked},\"truncated\":{truncated},\"seconds\":{:.1},\"errors\":{},\"rows\":[{rows}]}}",
        faces.len(),
        began.elapsed().as_secs_f32(),
        game.movement_errors
    );
}
