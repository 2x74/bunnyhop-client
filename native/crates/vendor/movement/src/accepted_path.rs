//! Observational accepted-path transport. No speculative trace is a motion segment.
use playsrc_collision::Hull;

pub const VERSION: u32 = 2;
#[derive(Clone, Debug, PartialEq)]
pub struct MotionSegment {
    pub discrete: bool,
    pub from: [f32; 3],
    pub to: [f32; 3],
    pub t0: f64,
    pub t1: f64,
    pub hull: Hull,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AcceptedPath {
    pub segments: Vec<MotionSegment>,
    pub unsupported: Option<&'static str>,
}
impl AcceptedPath {
    pub fn unsupported(reason: &'static str) -> Self {
        Self { unsupported: Some(reason), segments: Vec::new() }
    }
    pub fn reject(&mut self, reason: &'static str) {
        if self.unsupported.is_none() { self.unsupported = Some(reason); }
    }
    /// Solver phase change: destination-only overlap, never a sweep along from/to.
    pub fn phase_change(&mut self, from: [f32; 3], to: [f32; 3], hull: Hull, phase: f64, prepend: bool) {
        let s = MotionSegment { discrete: true, from, to, hull, t0: phase, t1: phase };
        if prepend { self.segments.insert(0, s); } else { self.segments.push(s); }
    }
    pub fn motion(from: [f32; 3], to: [f32; 3], hull: Hull) -> Self {
        Self { segments: vec![MotionSegment { discrete: false, from, to, hull, t0: 0.0, t1: 1.0 }], unsupported: None }
    }
}
