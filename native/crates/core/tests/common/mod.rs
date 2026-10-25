//! Synthetic collision scenes built from convex solids (`physics::ConvexBrush`), swept with the
//! same `CM_ClipBoxToBrush` arithmetic (DIST_EPSILON 1/32, bevel planes) as BSP brushes.
#![allow(dead_code)]

use bunnyhop_core::Settings;
use bunnyhop_core::physics::{ConvexBrush, PropCollision};
use playsrc_collision::Hull;
use playsrc_movement::{self as movement, Command, Configuration, Error, Player, Policy, State, StepInput, Trace, Tracer};

pub struct Scene {
    pub solids: PropCollision,
}

impl Scene {
    pub fn new(brushes: Vec<ConvexBrush>) -> Self {
        Self { solids: PropCollision::from_brushes(brushes) }
    }
}

impl Tracer for Scene {
    fn trace(&self, start: [f32; 3], end: [f32; 3], hull: Hull, _mask: u32) -> Result<Trace, Error> {
        let Some(t) = self.solids.trace(start, end, hull) else {
            return Ok(Trace { fraction: 1.0, start_solid: false, all_solid: false, end, normal: None, hit: None, contents: 0 });
        };
        let f = t.fraction;
        Ok(Trace {
            fraction: f,
            start_solid: t.start_solid,
            all_solid: t.all_solid,
            end: [start[0] + (end[0] - start[0]) * f, start[1] + (end[1] - start[1]) * f, start[2] + (end[2] - start[2]) * f],
            normal: t.normal,
            hit: t.brush.map(|b| b as u64),
            contents: 1,
        })
    }

    fn movement_time(&self) -> Option<f32> {
        Some(0.0)
    }

    fn ground_surface(&self, trace: &Trace) -> Option<movement::SurfaceProperties> {
        let surface = self.solids.brushes.get(trace.hit? as usize)?.surface;
        let p = bunnyhop_core::physics::SURFACE_PROPS.get(surface as usize).filter(|_| surface != 0)?;
        Some(movement::SurfaceProperties { friction: p.friction, jump_factor: p.jump_factor })
    }
}

/// A big floor slab with its top at z = 0.
pub fn floor() -> ConvexBrush {
    ConvexBrush::aabb([-8192.0, -8192.0, -64.0], [8192.0, 8192.0, 0.0])
}

/// A ramp rising along +x (or -x when `angle_deg` is negative is not supported: use `ramp_down`)
/// from (x0, z = base) with slope `angle_deg`, `length` long (horizontal) and `width` wide
/// (centred on y = 0). Wedge: bottom face at `base`, vertical back face at x0 + length.
pub fn ramp_up(x0: f32, base: f32, length: f32, width: f32, angle_deg: f32) -> ConvexBrush {
    let h = length * angle_deg.to_radians().tan();
    let (y0, y1) = (-width / 2.0, width / 2.0);
    let x1 = x0 + length;
    ConvexBrush::from_points(
        &[
            [x0, y0, base],
            [x0, y1, base],
            [x1, y0, base],
            [x1, y1, base],
            [x1, y0, base + h],
            [x1, y1, base + h],
        ],
        0,
    )
    .expect("ramp")
}

/// Mirror of `ramp_up`: highest at x0, descending along +x.
pub fn ramp_down(x0: f32, base: f32, length: f32, width: f32, angle_deg: f32) -> ConvexBrush {
    let h = length * angle_deg.to_radians().tan();
    let (y0, y1) = (-width / 2.0, width / 2.0);
    let x1 = x0 + length;
    ConvexBrush::from_points(
        &[
            [x0, y0, base],
            [x0, y1, base],
            [x1, y0, base],
            [x1, y1, base],
            [x0, y0, base + h],
            [x0, y1, base + h],
        ],
        0,
    )
    .expect("ramp")
}

pub struct Sim<'a> {
    pub scene: &'a Scene,
    pub configuration: Configuration,
    pub policy: Policy,
    pub autohop: bool,
    pub state: State,
    pub tick: u32,
}

impl<'a> Sim<'a> {
    pub fn new(scene: &'a Scene, settings: Settings, position: [f32; 3], velocity: [f32; 3]) -> Self {
        let policy = settings.policy();
        let state = State::from_player(
            Player { position, velocity, grounded: false, crouched: false, jump_latched: false },
            policy,
        );
        Self { scene, configuration: settings.configuration(), policy, autohop: settings.autohop, state, tick: 0 }
    }

    pub fn step(&mut self, forward: f32, side: f32, yaw: f32, jump: bool, crouch: bool) -> movement::StepResult {
        if self.autohop {
            self.state.jump_latched = false;
            self.state.previous_jump = false;
        }
        let input = StepInput {
            command_number: self.tick,
            command: Command { forward, side, yaw_degrees: yaw, jump, crouch },
            ..Default::default()
        };
        let result = movement::step(self.scene, self.state, input, self.configuration, self.policy)
            .unwrap_or_else(|e| panic!("{e:?}\nstate before: {:?}", self.state));
        self.state = result.state;
        self.tick += 1;
        result
    }

    pub fn idle(&mut self) -> movement::StepResult {
        self.step(0.0, 0.0, 0.0, false, false)
    }

    pub fn hspeed(&self) -> f32 {
        (self.state.velocity[0].powi(2) + self.state.velocity[1].powi(2)).sqrt()
    }
}
