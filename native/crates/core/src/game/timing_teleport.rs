//! Run timing of teleport finishes (observation only, research/MS-TIMING.md "Teleport finishes"): when a
//! trigger_teleport in the touch pass after the player's move sends the player somewhere, where in the tick the player's
//! box first touched that trigger along the tick's accepted movement path.
//!
//! Recorded only while `observe_timing` is on, never read by `step`, and not part of a saved state: a run simulates the
//! same with or without it. The contact uses the touch pass's own overlap rule (`touch_triggers_in`: the trigger's brush
//! model at its transform during the pass, or its per-map box) with the physics hull of each path segment, so the
//! contact phase and the touch that fired the teleport can't disagree about the trigger's shape. When the accepted path
//! isn't available (a solver branch the observer doesn't follow, e.g. a move with base velocity from a trigger_push),
//! the straight line from where the movement step started to where it ended is swept instead (bhoptimer's trace between
//! two origins, the run timer's "chord"), with the hull of the touch pass.
//!
//! The tick's movement and touches see every trigger where the previous tick's movers left it (movers advance after
//! the touches), so a trigger on a moving platform is measured where the simulation had it during the move.

use super::{Game, PHYSICS_FIX_MAP_TRIGGERS};
use crate::physics::ConvexBrush;
use playsrc_collision::{Hull, Transform};

/// A trigger_teleport's Touch that moved the player this tick, and where in the tick the player first touched it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TeleportTouch {
    /// The trigger (entity index).
    pub trigger: usize,
    /// Where the teleport (and anything in the touch pass after it) put the player.
    pub destination: [f32; 3],
    /// Phase in [0, 1] of the tick at which the player's box first touched the trigger, or why it isn't measured.
    pub phase: Result<f64, &'static str>,
    /// The phase was measured on the straight move (the accepted path wasn't available).
    pub chord: bool,
}

/// A box at `position` against a per-map trigger box, as `physics::clip_box_to_brush` decides overlap: (distance at
/// `start`, distance at `end`) to every plane, positive outside.
fn box_distances(b: &ConvexBrush, start: [f32; 3], end: [f32; 3], hull: Hull) -> Vec<(f32, f32)> {
    let center = [(hull.mins[0] + hull.maxs[0]) * 0.5, (hull.mins[1] + hull.maxs[1]) * 0.5, (hull.mins[2] + hull.maxs[2]) * 0.5];
    let ext = [(hull.maxs[0] - hull.mins[0]) * 0.5, (hull.maxs[1] - hull.mins[1]) * 0.5, (hull.maxs[2] - hull.mins[2]) * 0.5];
    let s = [start[0] + center[0], start[1] + center[1], start[2] + center[2]];
    let e = [end[0] + center[0], end[1] + center[1], end[2] + center[2]];
    let dot = |a: [f32; 3], b: [f32; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    b.planes
        .iter()
        .map(|&(n, dist)| {
            let offset = ext[0] * n[0].abs() + ext[1] * n[1].abs() + ext[2] * n[2].abs();
            (dot(s, n) - dist - offset, dot(e, n) - dist - offset)
        })
        .collect()
}

impl Game {
    /// Called by the touch pass when trigger `i`'s teleport moved the player. `position` / `hull`: where the pass tested
    /// overlaps; `linked`: the player already touched the trigger before this pass; `main`: the pass after the
    /// player's move (not RNGFix's ground-gap pass).
    pub(super) fn note_teleport_touch(&mut self, i: usize, position: [f32; 3], hull: Hull, linked: bool, main: bool) {
        if !self.observe_timing {
            return;
        }
        let (phase, chord) = if !main || position != self.touch_origin {
            (Err("not-touch-pass"), false)
        } else if linked {
            // Already touching before this tick's pass: the teleport fired on a later Touch (a filter or a re-enable),
            // not when the player reached the trigger.
            (Err("already-touching"), false)
        } else {
            match self.path_contact(i, position, hull) {
                Err("path-unsupported" | "path-incomplete" | "no-path") => (self.chord_contact(i, position, hull), true),
                other => (other, false),
            }
        };
        self.timing_teleport = Some(TeleportTouch { trigger: i, destination: self.state.position, phase, chord });
    }

    /// The first fraction of the straight move from `from` to `to` at which a box `hull` touches trigger `i`, as the
    /// touch pass tests overlap.
    fn trigger_contact(&self, i: usize, from: [f32; 3], to: [f32; 3], hull: Hull) -> Result<Option<f64>, &'static str> {
        let map_box = (self.settings.physics_fixes() & PHYSICS_FIX_MAP_TRIGGERS != 0)
            .then(|| self.map_trigger_boxes.iter().find(|(j, _)| *j == i).map(|(_, b)| b))
            .flatten();
        match (map_box, self.ents[i].brush.as_ref()) {
            (Some(b), _) => Ok(playsrc_collision::first_inside(&box_distances(b, from, to, hull))),
            (None, Some(b)) => self
                .world
                .first_contact_transformed_model_hull(b.model, Transform { origin: b.origin, angles: b.angles }, from, to, hull)
                .map_err(|_| "trigger-geometry"),
            (None, None) => Err("trigger-geometry"),
        }
    }

    /// The straight move of this tick's movement step, when it ended where the touch pass happened.
    fn chord_contact(&self, i: usize, position: [f32; 3], hull: Hull) -> Result<f64, &'static str> {
        let (from, to) = self.timing_move.ok_or("no-move")?;
        if to != position || from.iter().any(|v| !v.is_finite()) {
            return Err("moved-before-touch");
        }
        self.trigger_contact(i, from, to, hull)?.ok_or("no-contact")
    }

    /// The first phase of this tick's accepted path at which the player's box touched trigger `i`.
    fn path_contact(&self, i: usize, position: [f32; 3], hull: Hull) -> Result<f64, &'static str> {
        let path = self.timing_path.as_ref().ok_or("no-path")?;
        if path.unsupported.is_some() {
            return Err("path-unsupported");
        }
        let segs = &path.segments;
        let mut phase = 0.0;
        for (k, s) in segs.iter().enumerate() {
            let finite = s.from.iter().chain(&s.to).all(|v| v.is_finite()) && s.t0.is_finite() && s.t1.is_finite();
            if !finite || s.t0 != phase || s.t1 < s.t0 || s.t1 > 1.0 || (s.discrete && s.t0 != s.t1) || (k > 0 && segs[k - 1].to != s.from) {
                return Err("path-incomplete");
            }
            phase = s.t1;
        }
        let last = segs.last().ok_or("path-incomplete")?;
        if phase != 1.0 || last.to != position || last.hull != hull {
            return Err("path-incomplete");
        }
        for s in segs {
            // A discrete segment (a solver phase change) has no elapsed movement: only its destination counts.
            let from = if s.discrete { s.to } else { s.from };
            if let Some(f) = self.trigger_contact(i, from, s.to, s.hull)? {
                return Ok(s.t0 + f * (s.t1 - s.t0));
            }
        }
        Err("no-contact")
    }

    /// This tick's teleport touch for the run timer: the trigger_teleport whose Touch moved the player in the touch pass
    /// after their move, if nothing moved them after it. None when no trigger_teleport moved the player this tick.
    pub fn timing_teleport(&self) -> Option<TeleportTouch> {
        let t = self.timing_teleport?;
        Some(if t.destination == self.state.position { t } else { TeleportTouch { phase: Err("moved-after"), ..t } })
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Cmd, Data, Game, PHYSICS_LATEST, PHYSICS_V8, TriggerKind, EVENT_TELEPORTED};
    use crate::Settings;
    use playsrc_collision::{Hull, Transform};

    fn load(name: &str, physics: u32) -> Option<Game> {
        let path = crate::test_maps::map(name)?;
        let bsp = crate::parse_bsp(&std::fs::read(path).ok()?).ok()?;
        let mut game = Game::load(&bsp).ok()?;
        game.set_settings(Settings { physics_version: physics, ..Settings::css_bhop() });
        game.reset();
        Some(game)
    }

    fn teleports(game: &Game) -> Vec<usize> {
        (0..game.ents.len())
            .filter(|&i| matches!(&game.ents[i].data, Data::Trigger(t) if matches!(t.kind, TriggerKind::Teleport { .. }) && t.enabled) && !game.ents[i].removed && game.ents[i].brush.is_some())
            .collect()
    }

    fn overlaps(game: &Game, i: usize, p: [f32; 3], hull: Hull) -> bool {
        let b = game.ents[i].brush.as_ref().unwrap();
        game.world.overlaps_transformed_model_hull(b.model, Transform { origin: b.origin, angles: b.angles }, p, hull).unwrap()
    }

    fn lerp(a: [f32; 3], b: [f32; 3], t: f64) -> [f32; 3] {
        std::array::from_fn(|k| (f64::from(a[k]) + (f64::from(b[k]) - f64::from(a[k])) * t) as f32)
    }

    /// The analytic first contact agrees with the touch pass's own overlap test on either side of it, for every
    /// trigger_teleport of bhop_eazy and moves from several directions into its middle.
    #[test]
    fn contact_matches_the_touch_overlap_rule() {
        let Some(game) = load("bhop_eazy", PHYSICS_LATEST) else { return };
        let hull = game.policy.standing_hull;
        let mut checked = 0;
        for i in teleports(&game) {
            let (lo, hi) = game.ents[i].brush.as_ref().unwrap().world_bounds();
            let mid = [(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5, lo[2] + 1.0];
            for d in [[300.0, 0.0, 0.0], [0.0, -300.0, 0.0], [0.0, 0.0, 400.0], [170.0, 120.0, 90.0], [-90.0, 210.0, -60.0]] {
                let from = [mid[0] + d[0], mid[1] + d[1], mid[2] + d[2]];
                if overlaps(&game, i, from, hull) || !overlaps(&game, i, mid, hull) {
                    continue;
                }
                let b = game.ents[i].brush.as_ref().unwrap();
                let t = game
                    .world
                    .first_contact_transformed_model_hull(b.model, Transform { origin: b.origin, angles: b.angles }, from, mid, hull)
                    .unwrap()
                    .expect("ends inside");
                assert!(t > 0.0 && t <= 1.0, "trigger {i}: {t}");
                let len = (0..3).map(|k| f64::from(mid[k] - from[k]).powi(2)).sum::<f64>().sqrt();
                let step = 0.01 / len;
                assert!(overlaps(&game, i, lerp(from, mid, (t + step).min(1.0)), hull), "trigger {i}: inside just after {t}");
                assert!(!overlaps(&game, i, lerp(from, mid, t - step), hull), "trigger {i}: outside just before {t}");
                checked += 1;
            }
        }
        assert!(checked >= 10, "only {checked} moves checked");
    }

    /// A fall into a trigger_teleport: the phase is where the falling box first touches it, the destination is where
    /// the player ended up, and observing changes nothing.
    #[test]
    fn falling_into_a_teleport() {
        let (Some(mut seen), Some(mut blind)) = (load("bhop_eazy", PHYSICS_LATEST), load("bhop_eazy", PHYSICS_LATEST)) else { return };
        seen.observe_timing = true;
        let mut measured = 0;
        for i in teleports(&seen) {
            let (lo, hi) = seen.ents[i].brush.as_ref().unwrap().world_bounds();
            // 3 units above the trigger, falling at 600 u/s: about 6 units a tick, so it's reached inside the tick.
            let start = [(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5, hi[2] + 3.0];
            for g in [&mut seen, &mut blind] {
                g.reset();
                g.place_player(start);
                g.state.velocity = [0.0, 0.0, -600.0];
            }
            let p0 = seen.state.position;
            if p0 != start || overlaps(&seen, i, p0, seen.policy.standing_hull) {
                continue;
            }
            seen.step(Cmd::default()).unwrap();
            blind.step(Cmd::default()).unwrap();
            assert_eq!((seen.state.position, seen.state.velocity, seen.events), (blind.state.position, blind.state.velocity, blind.events));
            if seen.events & EVENT_TELEPORTED == 0 || blind.timing_teleport().is_some() {
                continue;
            }
            let t = seen.timing_teleport().expect("teleport observed");
            assert_eq!(t.destination, seen.state.position);
            // Overlapping triggers: the pass touched another one last (one the player may have started inside).
            if t.trigger != i {
                continue;
            }
            let phase = t.phase.expect("measured");
            assert!(!t.chord && phase > 0.0 && phase < 1.0, "{phase}");
            // Along the accepted path (the fall may land on the floor inside the trigger first).
            let path = seen.timing_path.as_ref().unwrap();
            let at = |phase: f64| {
                let s = path.segments.iter().find(|s| s.t0 <= phase && phase <= s.t1).unwrap();
                lerp(s.from, s.to, (phase - s.t0) / (s.t1 - s.t0))
            };
            let hull = seen.policy.standing_hull;
            assert!(overlaps(&seen, i, at(phase + 1e-3), hull) && !overlaps(&seen, i, at(phase - 1e-3), hull), "trigger {i} phase {phase} path {path:?}");
            measured += 1;
        }
        assert!(measured > 0);
    }

    #[test]
    fn touches_not_measured() {
        let Some(mut g) = load("bhop_eazy", PHYSICS_LATEST) else { return };
        g.observe_timing = true;
        let i = teleports(&g)[0];
        let (p, hull) = (g.state.position, g.policy.standing_hull);
        g.touch_origin = p;
        g.note_teleport_touch(i, p, hull, true, true);
        assert_eq!(g.timing_teleport().unwrap().phase, Err("already-touching"));
        g.note_teleport_touch(i, p, hull, false, false);
        assert_eq!(g.timing_teleport().unwrap().phase, Err("not-touch-pass"));
        g.note_teleport_touch(i, [p[0] + 1.0, p[1], p[2]], hull, false, true);
        assert_eq!(g.timing_teleport().unwrap().phase, Err("not-touch-pass"));
        g.state.position[0] += 5.0;
        assert_eq!(g.timing_teleport().unwrap().phase, Err("moved-after"));
        g.observe_timing = false;
        g.timing_teleport = None;
        g.note_teleport_touch(i, p, hull, false, true);
        assert!(g.timing_teleport().is_none());
    }

    /// bhop_2easy's stage-end rooms (physics v8 per-map trigger boxes): walking into the room box is measured against
    /// the box, not the original brush.
    #[test]
    fn per_map_trigger_box() {
        let Some(mut g) = load("bhop_2easy", PHYSICS_V8.max(PHYSICS_LATEST)) else { return };
        g.observe_timing = true;
        let (i, b) = g.map_trigger_boxes[0].clone();
        // Walk along +y into the box's front face, on its floor, 5 units short of it, at 800 u/s.
        let x = (b.mins[0] + b.maxs[0]) * 0.5;
        g.place_player([x, b.mins[1] - 16.0 - 5.0, b.mins[2] + 1.0]);
        let p0 = g.state.position;
        g.state.velocity = [0.0, 800.0, 0.0];
        g.step(Cmd::default()).unwrap();
        let t = g.timing_teleport().expect("teleported");
        assert_eq!(t.trigger, i);
        let phase = t.phase.expect("measured");
        // The box face is 5 units away, 8 units a tick (minus friction): touched a little past the middle of the tick.
        let to = g.touch_origin;
        let hull = g.policy.standing_hull;
        let inside = |p: [f32; 3]| crate::physics::clip_box_to_brush(&b, p, p, hull).is_some_and(|t| t.start_solid);
        assert!(inside(lerp(p0, to, phase + 1e-3)) && !inside(lerp(p0, to, phase - 1e-3)), "{phase}");
    }
}
