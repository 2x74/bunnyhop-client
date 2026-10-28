//! Timing policy 1, ported from apps/web/src/run-timing.ts. Use f64 operations in
//! the same order as JavaScript, quantise phases, then round the score once.
use super::{BhState, BhTimingSegmentV2, BhZone};
use bunnyhop_core::Game;
use serde_json::{Value, json};

pub const POLICY: u32 = 1;
pub const FRACTION_UNITS: u32 = 1_000_000;
const TIMER_HALF_WIDTH: f64 = 16.0;
const TIMER_HEIGHT: f64 = 62.0;
const TIMER_HEIGHT_DUCKED: f64 = 45.0;
const MAX_SEGMENTS: usize = 32;

#[derive(Clone, Copy, Debug)]
pub struct Crossing {
    pub fraction: u32,
    pub method: &'static str,
}
impl Crossing {
    pub const fn boundary(fraction: u32) -> Self {
        Self {
            fraction,
            method: "boundary",
        }
    }
    pub fn json(self) -> Value {
        json!({"fraction": self.fraction, "method": self.method})
    }
}
pub fn quantize_phase(phase: f64) -> u32 {
    (phase * f64::from(FRACTION_UNITS) + 0.5)
        .floor()
        .clamp(0.0, f64::from(FRACTION_UNITS)) as u32
}
pub fn time_units(start_tick: u32, start: u32, end_tick: u32, end: u32) -> u64 {
    ((i64::from(end_tick) - i64::from(start_tick)) * i64::from(FRACTION_UNITS) + i64::from(end)
        - i64::from(start))
    .max(0) as u64
}
pub fn units_to_ms(units: u64, interval: f64) -> u64 {
    let tick_us = (f64::from(interval as f32) * 1e6).round();
    let per = f64::from(FRACTION_UNITS) * 1000.0 / tick_us;
    ((units as f64 + per / 2.0) / per).floor() as u64
}
fn crouched(segment: &BhTimingSegmentV2) -> bool {
    f64::from(segment.maxs[2]) - f64::from(segment.mins[2]) < 54.0
}
pub fn complete_path(path: &[BhTimingSegmentV2], end: [f32; 3], ducked: bool) -> bool {
    if path.is_empty() || path.len() > MAX_SEGMENTS {
        return false;
    }
    let mut phase = 0.0;
    let mut previous = None;
    for segment in path {
        if ![segment.t0, segment.t1].into_iter().all(f64::is_finite)
            || !segment
                .from
                .into_iter()
                .chain(segment.to)
                .chain(segment.mins)
                .chain(segment.maxs)
                .all(f32::is_finite)
            || segment.t0 != phase
            || segment.t1 < segment.t0
            || segment.t1 > 1.0
            || (segment.discrete != 0 && segment.t0 != segment.t1)
            || previous.is_some_and(|to| to != segment.from)
        {
            return false;
        }
        phase = segment.t1;
        previous = Some(segment.to);
    }
    phase == 1.0 && previous == Some(end) && crouched(path.last().unwrap()) == ducked
}
pub fn sweep(segment: &BhTimingSegmentV2, ducked: bool, zone: &BhZone) -> Option<[f64; 2]> {
    if segment.discrete != 0 {
        return zone
            .contains(segment.to, ducked)
            .then_some([segment.t1, segment.t1]);
    }
    let mins = [-TIMER_HALF_WIDTH, -TIMER_HALF_WIDTH, 0.0];
    let maxs = [
        TIMER_HALF_WIDTH,
        TIMER_HALF_WIDTH,
        if ducked {
            TIMER_HEIGHT_DUCKED
        } else {
            TIMER_HEIGHT
        },
    ];
    let mut enter: f64 = 0.0;
    let mut exit: f64 = 1.0;
    for axis in 0..3 {
        let lo = f64::from(zone.mins[axis]) - maxs[axis];
        let hi = f64::from(zone.maxs[axis]) - mins[axis];
        let from = f64::from(segment.from[axis]);
        let delta = f64::from(segment.to[axis]) - from;
        if delta == 0.0 {
            if from < lo || from > hi {
                return None;
            }
            continue;
        }
        let mut a = (lo - from) / delta;
        let mut b = (hi - from) / delta;
        if a > b {
            std::mem::swap(&mut a, &mut b);
        }
        enter = enter.max(a);
        exit = exit.min(b);
        if enter > exit {
            return None;
        }
    }
    Some([
        segment.t0 + enter * (segment.t1 - segment.t0),
        segment.t0 + exit * (segment.t1 - segment.t0),
    ])
}
pub fn crossing(
    path: Option<&[BhTimingSegmentV2]>,
    from: Option<[f32; 3]>,
    to: [f32; 3],
    ducked: bool,
    zones: impl Iterator<Item = BhZone>,
    entry: bool,
) -> Crossing {
    let path = path.filter(|segments| complete_path(segments, to, ducked));
    let chord = from.map(|from| BhTimingSegmentV2 {
        from,
        to,
        t1: 1.0,
        ..Default::default()
    });
    let mut best: Option<f64> = None;
    let mut measured = false;
    for zone in zones {
        if entry && !zone.contains(to, ducked) {
            continue;
        }
        let segments = match (path, chord.as_ref()) {
            (Some(path), _) => path,
            (_, Some(chord)) => std::slice::from_ref(chord),
            _ => continue,
        };
        measured = true;
        for segment in segments {
            if let Some([a, b]) = sweep(
                segment,
                if path.is_some() {
                    crouched(segment)
                } else {
                    ducked
                },
                &zone,
            ) {
                let phase = if entry { a } else { b };
                best = Some(best.map_or(phase, |old| {
                    if entry {
                        old.min(phase)
                    } else {
                        old.max(phase)
                    }
                }));
            }
        }
    }
    Crossing {
        fraction: best.map_or(if entry { FRACTION_UNITS } else { 0 }, quantize_phase),
        method: if best.is_some() {
            if path.is_some() { "path" } else { "chord" }
        } else if measured {
            "boundary"
        } else {
            "fallback"
        },
    }
}

// Read accepted segments only at a start/finish crossing. No per-tick copy or allocation.
pub fn measure(
    game: Option<&Game>,
    state: BhState,
    from: Option<[f32; 3]>,
    zones: &[BhZone],
    track: u32,
    entry: bool,
    pass_end: bool,
) -> Crossing {
    let touch = state.touch_position.iter().all(|value| value.is_finite());
    let to = if touch && (!entry || pass_end) {
        state.touch_position
    } else {
        state.position
    };
    let ducked = if touch && (!entry || pass_end) {
        state.touch_crouched != 0
    } else {
        state.crouched != 0
    };
    let teleported = state.events
        & (bunnyhop_core::game::EVENT_TELEPORTED | bunnyhop_core::game::EVENT_RESPAWNED)
        != 0;
    if !entry {
        if zones
            .iter()
            .any(|zone| zone.kind == 0 && zone.contains(to, ducked))
        {
            return Crossing::boundary(0);
        }
        if !touch && teleported {
            return Crossing {
                fraction: 0,
                method: "fallback",
            };
        }
    } else if !pass_end
        && (if touch {
            state.touch_position != state.position
        } else {
            teleported
        })
    {
        return Crossing::boundary(FRACTION_UNITS);
    }
    let mut segments = [BhTimingSegmentV2::default(); MAX_SEGMENTS];
    let path = game
        .and_then(|game| game.timing_path.as_ref())
        .filter(|path| path.unsupported.is_none() && path.segments.len() <= MAX_SEGMENTS)
        .map(|path| {
            for (out, segment) in segments.iter_mut().zip(&path.segments) {
                *out = BhTimingSegmentV2 {
                    t0: segment.t0,
                    t1: segment.t1,
                    from: segment.from,
                    to: segment.to,
                    mins: segment.hull.mins,
                    maxs: segment.hull.maxs,
                    discrete: u32::from(segment.discrete),
                    reserved: 0,
                };
            }
            &segments[..path.segments.len()]
        });
    crossing(
        path,
        from,
        to,
        ducked,
        zones.iter().copied().filter(|zone| {
            if entry {
                zone.kind == 1 && zone.track == track
            } else {
                zone.kind == 0
            }
        }),
        entry,
    )
}
