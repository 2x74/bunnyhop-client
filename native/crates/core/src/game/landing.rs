//! Landing spot (the client's "Landing spot" aid, v0.0.38): where the player would land with no further input.
//!
//! A read-only query over the loaded map and the live entity state, like the overlays (`overlay.rs`). Nothing in `step`
//! calls it and it changes no state, so a run with the aid on simulates exactly like one without, and replays and the
//! verifier never see it.
//!
//! The path is the ballistic arc from a position and velocity under the player's gravity (`Settings::gravity` times
//! the map's `gravity_scale`, which Low Gravity and trigger_gravity set), with no air acceleration. It is swept with the
//! player's hull (standing or crouched) through the same collision scene and solid mask as movement (world,
//! displacements, props, solid brush entities, player clips), in chords short enough that the arc never strays more
//! than `SAGITTA` units from them. A hit on a standable surface (normal z >= `standable_normal`) while not rising
//! faster than the ground-detach speed (NON_JUMP_VELOCITY, 140 u/s) lands; any other hit clips the velocity off the
//! surface (TryPlayerMove's ClipVelocity, no bounce) and the arc carries on from there, so walls and surf ramps slide.
//!
//! Triggers on the way are checked against the hull swept along each chord:
//!   - a trigger the overlays draw as a teleport (trigger_teleport, a lethal trigger_hurt, outputs that move the
//!     player: `trigger_overlay_kind` == OVERLAY_TELEPORT) ends the path there, as `LANDING_TELEPORT`;
//!   - trigger_gravity changes the gravity for the rest of the path (it keeps after leaving, as in the game).
//! Triggers the hull already touches at the start are ignored (you're in them already; their effect has happened).
//!
//! Not modelled (limits): boosters (trigger_push, basevelocity outputs), water, ladders, moving platforms' motion
//! (they're traced where they are now), per-tick discretisation (the game lands on a tick boundary within one tick's
//! movement of the swept contact), the 2-unit ground probe and edge-landing rules, and triggers too thin for the
//! game's once-per-tick touch to catch (the sweep catches them, the game may not).

use super::overlay::OVERLAY_TELEPORT;
use super::*;

/// The path reached a standable surface.
pub const LANDING_GROUND: u32 = 1;
/// The path entered a teleport / reset volume first.
pub const LANDING_TELEPORT: u32 = 2;
/// Nothing within the time / step budget (or the start is embedded).
pub const LANDING_NONE: u32 = 0;

/// Most the arc strays from a chord, units. One unit keeps the swept chords within a hair of the true path.
const SAGITTA: f32 = 1.0;
/// Shortest and longest chord, seconds (very high or very low gravity).
const CHORD_MIN_S: f32 = 1.0 / 66.0;
const CHORD_MAX_S: f32 = 0.25;
/// Steps (chords + wall clips) one query may take.
const MAX_STEPS: usize = 64;
/// Upward speed above which a standable hit doesn't land (NON_JUMP_VELOCITY).
const NON_JUMP_VELOCITY: f32 = 140.0;

/// One piece of the path: where it starts, its velocity there, its acceleration (gravity, or gravity along a ramp it
/// slides on) and how long it lasts: start + velocity t + acceleration t^2 / 2 for t in 0..seconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LandingPiece {
    pub start: [f32; 3],
    pub velocity: [f32; 3],
    pub acceleration: [f32; 3],
    pub seconds: f32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LandingPrediction {
    /// LANDING_GROUND, LANDING_TELEPORT or LANDING_NONE.
    pub kind: u32,
    /// Feet origin where the path ends (the landing spot, the point it enters the teleport, or where it gave up).
    pub position: [f32; 3],
    /// Surface normal at the landing ([0, 0, 0] for the others).
    pub normal: [f32; 3],
    /// Seconds from the start to `position`.
    pub seconds: f32,
    /// Hull traces the query made (cost).
    pub traces: u32,
    /// The path, piece by piece.
    pub pieces: Vec<LandingPiece>,
}

/// Chord length while sliding along a ramp, seconds.
const SLIDE_S: f32 = 0.05;
/// How far below the path the ramp it slides on must still be, units.
const CONTACT: f32 = 0.5;
/// How far a clipped path steps off the surface it slid on, units.
const PUSH_OFF: f32 = 1.0 / 32.0;

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn scale(a: [f32; 3], k: f32) -> [f32; 3] {
    [a[0] * k, a[1] * k, a[2] * k]
}

fn clip(v: [f32; 3], n: [f32; 3]) -> [f32; 3] {
    let back = dot(v, n);
    [v[0] - n[0] * back, v[1] - n[1] * back, v[2] - n[2] * back]
}

impl Game {
    /// Where a player at feet origin `position` moving at `velocity` (crouched hull if `crouched`) would land within
    /// `max_seconds` with no further input. Read-only. See the module notes for what it models.
    pub fn predict_landing(&self, position: [f32; 3], velocity: [f32; 3], crouched: bool, max_seconds: f32) -> LandingPrediction {
        let hull = if crouched { self.policy.crouched_hull } else { self.policy.standing_hull };
        let mask = self.config.solid_mask;
        let max_v = self.config.maximum_velocity;
        let standable = self.config.standable_normal;
        let scene = self.scene(0.0);
        let mut out = LandingPrediction { position, ..Default::default() };
        let finite = position.iter().chain(&velocity).all(|v| v.is_finite());
        if !finite || !(max_seconds > 0.0) {
            return out;
        }
        let trace = |a: [f32; 3], b: [f32; 3], n: &mut u32| {
            *n += 1;
            scene.trace_filtered(a, b, hull, mask, &[]).ok()
        };
        // What each trigger does to the path, worked out the first time the path's bounds reach it: 0 not yet, 1 nothing
        // (or the hull is in it already at the start: its effect has happened), 2 a teleport / reset, 3 trigger_gravity.
        let mut roles = vec![0u8; self.triggers.len()];
        let role = |k: usize| {
            let i = self.triggers[k];
            let Data::Trigger(t) = &self.ents[i].data else { return 1 };
            if self.ents[i].removed || !t.enabled || self.landing_trigger_entry(i, position, position, hull).is_some() {
                return 1;
            }
            if matches!(t.kind, TriggerKind::Gravity { .. }) {
                3
            } else if self.trigger_overlay_kind(i) == Some(OVERLAY_TELEPORT) && self.trigger_passes(t) {
                2
            } else {
                1
            }
        };

        let mut p = position;
        let mut v = velocity;
        let mut g = self.settings.gravity * self.gravity_scale;
        let mut elapsed = 0.0f32;
        let mut stuck = 0;
        // The plane the last step clipped against, and whether the path slides along it (gravity presses into it).
        let mut last_plane: Option<[f32; 3]> = None;
        let mut slide: Option<[f32; 3]> = None;
        for _ in 0..MAX_STEPS {
            if elapsed >= max_seconds {
                break;
            }
            // Chord length: the arc's sagitta g dt^2 / 8 stays within SAGITTA. Sliding along a ramp, gravity runs along
            // it (the part into the plane is what the plane holds up), in shorter chords so leaving the ramp's edge
            // costs little.
            let base = if g.abs() > 1e-3 { (8.0 * SAGITTA / g.abs()).sqrt() } else { CHORD_MAX_S };
            let (acc, dt) = match slide {
                Some(n) => (clip([0.0, 0.0, -g], n), base.min(SLIDE_S)),
                None => ([0.0, 0.0, -g], base),
            };
            let dt = dt.clamp(CHORD_MIN_S, CHORD_MAX_S).min(max_seconds - elapsed);
            // sv_maxvelocity (per axis, as the game clamps it).
            let advance = |t: f32| {
                let v_end: [f32; 3] = std::array::from_fn(|k| (v[k] + acc[k] * t).clamp(-max_v, max_v));
                let p_end: [f32; 3] = std::array::from_fn(|k| p[k] + (v[k] + v_end[k]) * 0.5 * t);
                (p_end, v_end)
            };
            let (end, v_end) = advance(dt);
            let Some(t) = trace(p, end, &mut out.traces) else { break };
            if t.start_solid && out.pieces.is_empty() {
                // Embedded at the start (an interpolated origin inside a moving platform, say): no prediction.
                return out;
            }
            let f = if t.start_solid { 0.0 } else { t.fraction.clamp(0.0, 1.0) };
            let reached = if f < 1.0 { t.end } else { end };
            // A teleport / gravity volume on the way, before whatever the trace hit.
            let mut gravity_change = None;
            for k in 0..self.triggers.len() {
                if roles[k] == 1 {
                    continue;
                }
                let i = self.triggers[k];
                let Some(s) = self.landing_trigger_entry(i, p, reached, hull) else { continue };
                if roles[k] == 0 {
                    roles[k] = role(k);
                }
                if roles[k] == 2 {
                    out.pieces.push(LandingPiece { start: p, velocity: v, acceleration: acc, seconds: dt * f * s });
                    out.kind = LANDING_TELEPORT;
                    out.position = std::array::from_fn(|k| p[k] + (reached[k] - p[k]) * s);
                    out.seconds = elapsed + dt * f * s;
                    return out;
                }
                if roles[k] == 3 {
                    if let Data::Trigger(Trigger { kind: TriggerKind::Gravity { gravity }, .. }) = &self.ents[i].data {
                        if gravity_change.is_none_or(|(at, _)| s < at) {
                            gravity_change = Some((s, *gravity));
                        }
                    }
                }
            }
            let seconds = dt * f;
            out.pieces.push(LandingPiece { start: p, velocity: v, acceleration: acc, seconds });
            elapsed += seconds;
            v = if f >= 1.0 { v_end } else { advance(seconds).1 };
            p = reached;
            if let Some((_, scale)) = gravity_change {
                // CTriggerGravity: the player's gravity multiplier (0 / non-finite = normal), from here on.
                let scale = if scale == 0.0 || !scale.is_finite() { 1.0 } else { scale.clamp(-100.0, 100.0) };
                g = self.settings.gravity * scale;
            }
            if f >= 1.0 {
                stuck = 0;
                // Still on the ramp it slides along? Off its edge, the path falls freely again; on it, a standable ramp
                // lands once the path stops rising fast.
                let on = slide.and_then(|n| {
                    let probe: [f32; 3] = std::array::from_fn(|k| p[k] - n[k] * CONTACT);
                    trace(p, probe, &mut out.traces).filter(|c| c.fraction < 1.0 && c.normal.is_some_and(|m| dot(m, n) > 0.99)).map(|c| (n, c))
                });
                match on {
                    Some((n, c)) if n[2] >= standable && v[2] <= NON_JUMP_VELOCITY => {
                        out.kind = LANDING_GROUND;
                        out.position = c.end;
                        out.normal = n;
                        out.seconds = elapsed;
                        return out;
                    }
                    Some(_) => {}
                    None => {
                        slide = None;
                        last_plane = None;
                    }
                }
                continue;
            }
            let n = t.normal.unwrap_or([0.0, 0.0, 1.0]);
            if n[2] >= standable && v[2] <= NON_JUMP_VELOCITY {
                out.kind = LANDING_GROUND;
                out.position = p;
                out.normal = n;
                out.seconds = elapsed;
                return out;
            }
            // ClipVelocity (overbounce 1): slide along the wall / ramp / ceiling. Into a crease between this plane and
            // the last one (a corner): along the crease, as TryPlayerMove does with two planes.
            v = clip(v, n);
            slide = (n[2] > 0.05).then_some(n);
            if let Some(m) = last_plane.filter(|m| dot(*m, n) < 0.999 && dot(v, *m) < 0.0) {
                let d = cross(m, n);
                let len = dot(d, d).sqrt();
                v = if len > 1e-4 { scale(d, dot(d, v) / (len * len)) } else { [0.0; 3] };
                slide = None;
            }
            last_plane = Some(n);
            // Off the surface by a hair, so the next chord doesn't start touching it (CS:S's ClipVelocity push-out does
            // the same job with the velocity).
            p = std::array::from_fn(|k| p[k] + n[k] * PUSH_OFF);
            if f <= 0.0 {
                stuck += 1;
                if stuck >= 3 || dot(v, v) < 1.0 {
                    break;
                }
            } else {
                stuck = 0;
            }
        }
        out.position = p;
        out.seconds = elapsed;
        out
    }

    /// The fraction 0..1 along `a`→`b` where `hull` first overlaps trigger `i`, or None. Bounds first, then the brush
    /// itself sampled every 8 units (as `touch_triggers_in` tests it at one position).
    fn landing_trigger_entry(&self, i: usize, a: [f32; 3], b: [f32; 3], hull: Hull) -> Option<f32> {
        let e = &self.ents[i];
        let map_box = (self.settings.physics_fixes() & PHYSICS_FIX_MAP_TRIGGERS != 0)
            .then(|| self.map_trigger_boxes.iter().find(|(j, _)| *j == i).map(|(_, b)| b))
            .flatten();
        let (lo, hi) = match map_box {
            Some(b) => (b.mins, b.maxs),
            None => e.brush.as_ref()?.world_bounds(),
        };
        if !swept_overlap(a, b, hull, lo, hi) {
            return None;
        }
        let overlaps = |q: [f32; 3]| match map_box {
            Some(bx) => {
                swept_overlap(q, q, hull, bx.mins, bx.maxs)
                    && physics::clip_box_to_brush(bx, q, q, hull).is_some_and(|t| t.start_solid)
            }
            None => e.brush.as_ref().is_some_and(|br| {
                swept_overlap(q, q, hull, lo, hi)
                    && self
                        .world
                        .overlaps_transformed_model_hull(br.model, Transform { origin: br.origin, angles: br.angles }, q, hull)
                        .unwrap_or(false)
            }),
        };
        let len = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2) + (b[2] - a[2]).powi(2)).sqrt();
        let n = ((len / 8.0).ceil() as usize).clamp(1, 512);
        (0..=n).map(|k| k as f32 / n as f32).find(|&s| overlaps([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s]))
    }
}
