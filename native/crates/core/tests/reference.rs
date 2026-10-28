//! Cross-check: a small clean-room transcription of the public SDK 2013 `CGameMovement` walk/air
//! path (PlayerMove -> FullWalkMove: StartGravity, CheckJumpButton, Friction, WalkMove /
//! StepMove / StayOnGround, AirMove / AirAccelerate, TryPlayerMove, CategorizePosition with the
//! quadrant probes, FinishGravity) with CS:S constants, written independently of the vendored
//! port, run against the same synthetic brush scenes. Reports the max per-tick deviation.
//! Ducking, water, ladders and base velocity are out of scope here.

mod common;

use bunnyhop_core::Settings;
use bunnyhop_core::physics::ConvexBrush;
use common::{Scene, Sim, floor, ramp_down, ramp_up};
use playsrc_collision::Hull;
use playsrc_movement::{MovementFixes, Trace, Tracer};

const DIST_EPSILON: f32 = 0.03125;
const NON_JUMP_VELOCITY: f32 = 140.0;
const HULL: Hull = Hull { mins: [-16.0, -16.0, 0.0], maxs: [16.0, 16.0, 62.0] };

#[derive(Clone, Copy, Debug)]
struct Ref {
    origin: [f32; 3],
    velocity: [f32; 3],
    ground: bool,
    surface_friction: f32,
    old_jump: bool,
}

struct Cvars {
    dt: f32,
    gravity: f32,
    accelerate: f32,
    airaccelerate: f32,
    friction: f32,
    stopspeed: f32,
    maxspeed: f32,
    maxvelocity: f32,
    jump: f32,
}

fn cvars(s: Settings) -> Cvars {
    Cvars {
        dt: s.tick_interval,
        gravity: s.gravity,
        accelerate: s.accelerate,
        airaccelerate: s.air_accelerate,
        friction: s.friction,
        stopspeed: s.stop_speed,
        maxspeed: s.max_speed,
        maxvelocity: 3500.0,
        jump: (2.0f32 * 800.0 * 57.0).sqrt(),
    }
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn vlen(a: [f32; 3]) -> f32 {
    dot(a, a).sqrt()
}

fn trace(scene: &Scene, start: [f32; 3], end: [f32; 3], hull: Hull) -> Trace {
    scene.trace(start, end, hull, 0x0201_400b).unwrap()
}

fn clip_velocity(input: [f32; 3], normal: [f32; 3], overbounce: f32) -> [f32; 3] {
    let backoff = dot(input, normal) * overbounce;
    let mut out = [0.0; 3];
    for i in 0..3 {
        out[i] = input[i] - normal[i] * backoff;
    }
    let adjust = dot(out, normal);
    if adjust < 0.0 {
        for i in 0..3 {
            out[i] -= normal[i] * adjust;
        }
    }
    out
}

fn check_velocity(v: &mut [f32; 3], max: f32) {
    for x in v.iter_mut() {
        if x.is_nan() {
            *x = 0.0;
        }
        *x = x.clamp(-max, max);
    }
}

/// AngleVectors for yaw only (pitch 0): forward, right.
fn angle_vectors(yaw: f32) -> ([f32; 3], [f32; 3]) {
    let (sy, cy) = yaw.to_radians().sin_cos();
    ([cy, sy, 0.0], [sy, -cy, 0.0])
}

fn try_player_move(scene: &Scene, s: &mut Ref, c: &Cvars) {
    let mut planes: Vec<[f32; 3]> = Vec::new();
    let mut original = s.velocity;
    let primal = s.velocity;
    let mut all_fraction = 0.0;
    let mut time_left = c.dt;
    for _bump in 0..4 {
        if vlen(s.velocity) == 0.0 {
            break;
        }
        let end = [
            s.origin[0] + time_left * s.velocity[0],
            s.origin[1] + time_left * s.velocity[1],
            s.origin[2] + time_left * s.velocity[2],
        ];
        let pm = trace(scene, s.origin, end, HULL);
        all_fraction += pm.fraction;
        if pm.all_solid {
            s.velocity = [0.0; 3];
            return;
        }
        if pm.fraction > 0.0 {
            if pm.fraction == 1.0 {
                let stuck = trace(scene, pm.end, pm.end, HULL);
                if stuck.start_solid || stuck.fraction != 1.0 {
                    s.velocity = [0.0; 3];
                    break;
                }
            }
            s.origin = pm.end;
            original = s.velocity;
            planes.clear();
        }
        if pm.fraction == 1.0 {
            break;
        }
        time_left -= time_left * pm.fraction;
        if planes.len() >= 5 {
            s.velocity = [0.0; 3];
            break;
        }
        let normal = pm.normal.unwrap_or([0.0; 3]);
        planes.push(normal);
        if planes.len() == 1 && !s.ground {
            let new = if planes[0][2] > 0.7 {
                clip_velocity(original, planes[0], 1.0)
            } else {
                clip_velocity(original, planes[0], 1.0) // sv_bounce 0
            };
            s.velocity = new;
            original = new;
        } else {
            let mut i = 0;
            while i < planes.len() {
                s.velocity = clip_velocity(original, planes[i], 1.0);
                let ok = (0..planes.len()).all(|j| j == i || dot(s.velocity, planes[j]) >= 0.0);
                if ok {
                    break;
                }
                i += 1;
            }
            if i == planes.len() {
                if planes.len() != 2 {
                    s.velocity = [0.0; 3];
                    break;
                }
                let (a, b) = (planes[0], planes[1]);
                let mut dir = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
                let l = vlen(dir);
                for x in dir.iter_mut() {
                    *x /= l;
                }
                let d = dot(dir, s.velocity);
                s.velocity = [dir[0] * d, dir[1] * d, dir[2] * d];
            }
            if dot(s.velocity, primal) <= 0.0 {
                s.velocity = [0.0; 3];
                break;
            }
        }
    }
    if all_fraction == 0.0 {
        s.velocity = [0.0; 3];
    }
}

fn stay_on_ground(scene: &Scene, s: &mut Ref) {
    let up = [s.origin[0], s.origin[1], s.origin[2] + 2.0];
    let end = [s.origin[0], s.origin[1], s.origin[2] - 18.0];
    let t = trace(scene, s.origin, up, HULL);
    let t = trace(scene, t.end, end, HULL);
    if t.fraction > 0.0 && t.fraction < 1.0 && !t.start_solid && t.normal.is_some_and(|n| n[2] >= 0.7) {
        if (s.origin[2] - t.end[2]).abs() > 0.5 / 32.0 {
            s.origin = t.end;
        }
    }
}

fn step_move(scene: &Scene, s: &mut Ref, c: &Cvars) {
    let (pos, vel) = (s.origin, s.velocity);
    try_player_move(scene, s, c);
    let (down_pos, down_vel) = (s.origin, s.velocity);
    s.origin = pos;
    s.velocity = vel;
    let up_end = [s.origin[0], s.origin[1], s.origin[2] + 18.0 + DIST_EPSILON];
    let t = trace(scene, s.origin, up_end, HULL);
    if !t.start_solid && !t.all_solid {
        s.origin = t.end;
    }
    try_player_move(scene, s, c);
    let down_end = [s.origin[0], s.origin[1], s.origin[2] - 18.0 - DIST_EPSILON];
    let t = trace(scene, s.origin, down_end, HULL);
    if t.normal.map(|n| n[2]).unwrap_or(0.0) < 0.7 {
        s.origin = down_pos;
        s.velocity = down_vel;
        return;
    }
    if !t.start_solid && !t.all_solid {
        s.origin = t.end;
    }
    let up_pos = s.origin;
    let h = |p: [f32; 3]| (p[0] - pos[0]) * (p[0] - pos[0]) + (p[1] - pos[1]) * (p[1] - pos[1]);
    if h(down_pos) > h(up_pos) {
        s.origin = down_pos;
        s.velocity = down_vel;
    } else {
        s.velocity[2] = down_vel[2];
    }
}

fn wish(c: &Cvars, fmove: f32, smove: f32, yaw: f32) -> ([f32; 3], f32) {
    let (forward, right) = angle_vectors(yaw);
    let mut wishvel = [forward[0] * fmove + right[0] * smove, forward[1] * fmove + right[1] * smove, 0.0];
    let mut wishspeed = vlen(wishvel);
    let mut wishdir = wishvel;
    if wishspeed != 0.0 {
        for x in wishdir.iter_mut() {
            *x /= wishspeed;
        }
    }
    if wishspeed != 0.0 && wishspeed > c.maxspeed {
        for x in wishvel.iter_mut() {
            *x *= c.maxspeed / wishspeed;
        }
        wishspeed = c.maxspeed;
    }
    (wishdir, wishspeed)
}

fn walk_move(scene: &Scene, s: &mut Ref, c: &Cvars, fmove: f32, smove: f32, yaw: f32) {
    let (wishdir, wishspeed) = wish(c, fmove, smove, yaw);
    s.velocity[2] = 0.0;
    // Accelerate
    let current = dot(s.velocity, wishdir);
    let add = wishspeed - current;
    if add > 0.0 {
        let accel = (c.accelerate * c.dt * wishspeed * s.surface_friction).min(add);
        for i in 0..3 {
            s.velocity[i] += accel * wishdir[i];
        }
    }
    s.velocity[2] = 0.0;
    if vlen(s.velocity) < 1.0 {
        s.velocity = [0.0; 3];
        return;
    }
    let dest = [s.origin[0] + s.velocity[0] * c.dt, s.origin[1] + s.velocity[1] * c.dt, s.origin[2]];
    let pm = trace(scene, s.origin, dest, HULL);
    if pm.fraction == 1.0 {
        s.origin = pm.end;
        stay_on_ground(scene, s);
        return;
    }
    step_move(scene, s, c);
    stay_on_ground(scene, s);
}

fn air_move(scene: &Scene, s: &mut Ref, c: &Cvars, fmove: f32, smove: f32, yaw: f32) {
    let (wishdir, wishspeed) = wish(c, fmove, smove, yaw);
    let wishspd = wishspeed.min(30.0);
    let current = dot(s.velocity, wishdir);
    let add = wishspd - current;
    if add > 0.0 {
        let accel = (c.airaccelerate * wishspeed * c.dt * s.surface_friction).min(add);
        for i in 0..3 {
            s.velocity[i] += accel * wishdir[i];
        }
    }
    try_player_move(scene, s, c);
}

fn categorize_position(scene: &Scene, s: &mut Ref) {
    s.surface_friction = 1.0;
    let point = [s.origin[0], s.origin[1], s.origin[2] - 2.0];
    if s.velocity[2] > NON_JUMP_VELOCITY {
        s.ground = false;
        return;
    }
    let standable = |t: &Trace| t.hit.is_some() && t.normal.is_some_and(|n| n[2] >= 0.7);
    let mut pm = trace(scene, s.origin, point, HULL);
    if !standable(&pm) {
        let (mn, mx) = (HULL.mins, HULL.maxs);
        let quadrants = [
            Hull { mins: mn, maxs: [mx[0].min(0.0), mx[1].min(0.0), mx[2]] },
            Hull { mins: [mn[0].max(0.0), mn[1].max(0.0), mn[2]], maxs: mx },
            Hull { mins: [mn[0], mn[1].max(0.0), mn[2]], maxs: [mx[0].min(0.0), mx[1], mx[2]] },
            Hull { mins: [mn[0].max(0.0), mn[1], mn[2]], maxs: [mx[0], mx[1].min(0.0), mx[2]] },
        ];
        let mut found = false;
        for q in quadrants {
            let t = trace(scene, s.origin, point, q);
            if standable(&t) {
                pm = t;
                found = true;
                break;
            }
        }
        if !found {
            s.ground = false;
            if s.velocity[2] > 0.0 {
                s.surface_friction = 0.25;
            }
            return;
        }
    }
    let _ = pm;
    // SetGroundEntity
    s.ground = true;
    s.velocity[2] = 0.0;
}

/// One PlayerMove. `jump` = IN_JUMP held; autohop clears the old-buttons jump bit every tick.
fn player_move(scene: &Scene, s: &mut Ref, c: &Cvars, fmove: f32, smove: f32, yaw: f32, jump: bool) {
    // CheckParameters: scale the command down to maxspeed.
    let spd = fmove * fmove + smove * smove;
    let (mut fmove, mut smove) = (fmove, smove);
    if spd != 0.0 && spd > c.maxspeed * c.maxspeed {
        let ratio = c.maxspeed / spd.sqrt();
        fmove *= ratio;
        smove *= ratio;
    }
    // sv_optimizedmovement
    if s.velocity[2] > 250.0 {
        s.ground = false;
    }
    s.old_jump = false; // autohop
    // FullWalkMove
    s.velocity[2] -= c.gravity * 0.5 * c.dt;
    check_velocity(&mut s.velocity, c.maxvelocity);
    if jump {
        if !s.ground {
            s.old_jump = true;
        } else if !s.old_jump {
            s.ground = false;
            s.velocity[2] += c.jump;
            // FinishGravity inside CheckJumpButton
            s.velocity[2] -= c.gravity * c.dt * 0.5;
            check_velocity(&mut s.velocity, c.maxvelocity);
            s.old_jump = true;
        }
    }
    if s.ground {
        s.velocity[2] = 0.0;
        let speed = vlen(s.velocity);
        if speed >= 0.1 {
            let control = if speed < c.stopspeed { c.stopspeed } else { speed };
            let drop = control * (c.friction * s.surface_friction) * c.dt;
            let newspeed = (speed - drop).max(0.0);
            if newspeed != speed {
                let k = newspeed / speed;
                for x in s.velocity.iter_mut() {
                    *x *= k;
                }
            }
        }
    }
    check_velocity(&mut s.velocity, c.maxvelocity);
    if s.ground {
        walk_move(scene, s, c, fmove, smove, yaw);
    } else {
        air_move(scene, s, c, fmove, smove, yaw);
    }
    categorize_position(scene, s);
    check_velocity(&mut s.velocity, c.maxvelocity);
    s.velocity[2] -= c.gravity * c.dt * 0.5;
    check_velocity(&mut s.velocity, c.maxvelocity);
    if s.ground {
        s.velocity[2] = 0.0;
    }
}

struct Deviation {
    position: f32,
    velocity: f32,
    ground_mismatches: u32,
}

/// Run both implementations with the same commands; returns the max deviations.
fn compare(
    scene: &Scene,
    settings: Settings,
    start: [f32; 3],
    velocity: [f32; 3],
    ticks: u32,
    cmd: impl Fn(u32) -> (f32, f32, f32, bool),
) -> Deviation {
    let c = cvars(settings);
    let mut sim = Sim::new(scene, settings, start, velocity);
    sim.configuration.fixes = MovementFixes::default();
    let mut r = Ref { origin: start, velocity, ground: false, surface_friction: 1.0, old_jump: false };
    let mut dev = Deviation { position: 0.0, velocity: 0.0, ground_mismatches: 0 };
    for n in 0..ticks {
        let (f, sd, yaw, jump) = cmd(n);
        player_move(scene, &mut r, &c, f, sd, yaw, jump);
        sim.step(f, sd, yaw, jump, false);
        let p = sim.state.position;
        let v = sim.state.velocity;
        for k in 0..3 {
            dev.position = dev.position.max((p[k] - r.origin[k]).abs());
            dev.velocity = dev.velocity.max((v[k] - r.velocity[k]).abs());
        }
        dev.ground_mismatches += (sim.state.ground.is_some() != r.ground) as u32;
        if std::env::var_os("REF_DEBUG").is_some() && (dev.position > 0.01 || dev.ground_mismatches > 0) {
            eprintln!("tick {n}: port {p:?} {v:?} ground {} | ref {:?} {:?} ground {}", sim.state.ground.is_some(), r.origin, r.velocity, r.ground);
            if n > 3 && dev.position > 0.01 {
                panic!("diverged");
            }
        }
    }
    dev
}

fn report(name: &str, d: &Deviation) {
    eprintln!(
        "reference {name}: max |dpos| {:.6}, max |dvel| {:.6}, ground mismatches {}",
        d.position, d.velocity, d.ground_mismatches
    );
}

#[test]
fn flat_ground_strafe_jumping_matches_the_reference() {
    let scene = Scene::new(vec![floor()]);
    for (name, settings) in [("100 tick", Settings::css_bhop()), ("66 tick", Settings { tick_interval: 0.015, ..Settings::css_bhop() })] {
        let d = compare(&scene, settings, [0.0, 0.0, DIST_EPSILON], [250.0, 0.0, 0.0], 1500, |n| {
            let side = if (n / 60) % 2 == 0 { 400.0 } else { -400.0 };
            let yaw = (n as f32 * 1.3).sin() * 40.0 + if side > 0.0 { -((n % 60) as f32) } else { (n % 60) as f32 };
            (if n < 30 { 400.0 } else { 0.0 }, side, yaw, true)
        });
        report(&format!("strafe-jump {name}"), &d);
        assert_eq!(d.ground_mismatches, 0);
        assert!(d.position < 0.01 && d.velocity < 0.01, "{name}");
    }
}

#[test]
fn ramp_slide_matches_the_reference() {
    let angle = 50.0f32;
    let scene = Scene::new(vec![floor(), ramp_down(0.0, 0.0, 4096.0, 1024.0, angle)]);
    let top = 4096.0 * angle.to_radians().tan();
    let z = top - (200.0 - 16.0) * angle.to_radians().tan() + 2.0;
    let d = compare(&scene, Settings::css_bhop(), [200.0, 0.0, z], [100.0, 300.0, 0.0], 300, |n| {
        (0.0, if n % 80 < 40 { 400.0 } else { -400.0 }, 90.0 + (n % 80) as f32 * 0.5, false)
    });
    report("ramp slide", &d);
    assert_eq!(d.ground_mismatches, 0);
    assert!(d.position < 0.05 && d.velocity < 0.05);
}

#[test]
fn stairs_and_landing_on_slopes_match_the_reference() {
    // Stairs: 12 steps of 12 units, then a 30 degree ramp up and a ramp down.
    let mut brushes = vec![floor()];
    for i in 0..12 {
        let x = 64.0 + i as f32 * 24.0;
        brushes.push(ConvexBrush::aabb([x, -256.0, 0.0], [x + 24.0, 256.0, 12.0 * (i + 1) as f32]));
    }
    brushes.push(ConvexBrush::aabb([352.0, -256.0, 0.0], [800.0, 256.0, 144.0]));
    brushes.push(ramp_up(800.0, 0.0, 400.0, 512.0, 30.0));
    let scene = Scene::new(brushes);
    let walk = compare(&scene, Settings::css_bhop(), [0.0, 0.0, DIST_EPSILON], [0.0; 3], 400, |_| (400.0, 0.0, 0.0, false));
    report("stairs walk", &walk);
    let hop = compare(&scene, Settings::css_bhop(), [0.0, 0.0, DIST_EPSILON], [0.0; 3], 400, |n| (400.0, if n % 50 < 25 { 200.0 } else { -200.0 }, 0.0, true));
    report("stairs bhop", &hop);
    let scene = Scene::new(vec![floor(), ramp_up(0.0, 0.0, 4096.0, 2048.0, 30.0), ramp_down(-4096.0, 0.0, 4096.0, 2048.0, 30.0)]);
    let slopes = compare(&scene, Settings::css_bhop(), [-3000.0, 0.0, 2500.0], [500.0, 0.0, 0.0], 800, |n| (0.0, if n % 40 < 20 { 400.0 } else { -400.0 }, (n % 40) as f32, true));
    report("slope landings", &slopes);
    for d in [&walk, &hop, &slopes] {
        assert_eq!(d.ground_mismatches, 0);
        assert!(d.position < 0.05 && d.velocity < 0.05);
    }
}
