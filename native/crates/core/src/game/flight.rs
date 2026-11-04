//! Infinite flights (physics v24, v0.0.36): the style's noclip, simulated in the core from recorded commands so a run
//! after a flight re-simulates and verifies like any other.
//!
//! A command with `IN_FLIGHT` set flies: the player moves with CS:S FullNoClipMove (the same move as the web client's
//! practice noclip, apps/web/src/practice-mode/noclip.ts, at Infinite's 3500 u/s), passes through everything, touches
//! no trigger, and the world runs its tick around it (`Game::practice_noclip_tick`). The first command without the bit
//! lands: the player is put at the nearest free spot (CS:S FindPassableSpace, as `practice_noclip_exit`), the
//! horizontal speed is capped at `FLIGHT_EXIT_CAP`, and the same command then steps normally. With no free spot near,
//! the player keeps flying until there is one. Every flying tick reports `EVENT_FLIGHT`, which the timer reads to keep
//! flights out of runs (apps/web/src/timer.ts flightTick: a flight never starts or finishes a run, and ends a running one).
//! The landing tick reports `EVENT_FLIGHT_LANDED` and the spot it put the player at (`Game::flight_landing`), before the
//! normal step moved them: the timer keeps a start the flight armed only if that spot is still in the start zone, so a
//! landing relocation never stands in for crossing the start (timer.ts update).
//!
//! The flight's actual speed (3D) never exceeds `FLIGHT_TOP_SPEED`: `flight_move` caps the velocity after acceleration
//! and friction on every tick, which also brings a faster velocity carried into the flight down to the cap at once.
//!
//! Only Infinite (`Settings::air_jump`) on physics v24+ honours the bit (`Game::flight_allowed`); everywhere else it is an
//! inert button bit and the verifier rejects any replay that carries it (apps/web/src/verifier.ts). No replay recorded
//! before v24 can fly, so every older replay re-simulates exactly as before.

use super::*;

/// Command bit: this tick flies (Infinite noclip). Clear on every command of every other style.
pub const IN_FLIGHT: u32 = 1 << 24;
/// Event bit: the player flew this tick (the state after it is the flight's).
pub const EVENT_FLIGHT: u32 = 1 << 9;
/// Event bit: this tick ended a flight. The player was put at `Game::flight_landing` and then stepped normally.
pub const EVENT_FLIGHT_LANDED: u32 = 1 << 10;
/// Infinite's flight top speed (sv_noclipspeed 3500 / 320, as the native client's practice.rs). Both the wish speed
/// and the actual velocity magnitude (3D) of every flight tick are capped at it.
pub const FLIGHT_TOP_SPEED: f32 = 3500.0;
/// Horizontal speed a landing keeps at most: the Infinite start re-entry cap (timer.ts INFINITE_START_REENTRY_CAP).
pub const FLIGHT_EXIT_CAP: f32 = 3510.0;

/// sv_maxspeed of the CS:S noclip formula (not the style's 260: noclip.ts MAX_SPEED).
const NOCLIP_MAX_SPEED: f32 = 320.0;
/// sv_noclipaccelerate.
const NOCLIP_ACCELERATE: f32 = 5.0;
/// sv_friction of the flight.
const NOCLIP_FRICTION: f32 = 4.0;
/// Duck: a quarter of the speed (noclip.ts NOCLIP_DUCK_FACTOR).
const NOCLIP_DUCK_FACTOR: f32 = 0.25;
/// cl_upspeed while jump is held.
const NOCLIP_UP_MOVE: f32 = 450.0;
/// The flight stays inside the world (`OUT_OF_WORLD`, noclip.ts WORLD_LIMIT).
const FLIGHT_WORLD_LIMIT: f32 = 16384.0 - 80.0 - 1.0;

/// One tick of CS:S FullNoClipMove at `top` u/s (noclip.ts noclipMove, in f32): fly where the view points with the
/// movement keys, jump rises, duck is a quarter speed. Returns the new position and velocity. The velocity's magnitude
/// (3D) is then capped at `top` before it moves the player (`cap_speed`): FullNoClipMove only bounds the wish speed, so
/// turning while flying, or a faster velocity carried in, would otherwise go past it.
pub fn flight_move(position: [f32; 3], velocity: [f32; 3], cmd: Cmd, top: f32, dt: f32) -> ([f32; 3], [f32; 3]) {
    let (sy, cy) = playsrc_collision::math::sin_cos(cmd.yaw.to_radians());
    let (sp, cp) = playsrc_collision::math::sin_cos(cmd.pitch.to_radians());
    let forward = [cp * cy, cp * sy, -sp];
    let right = [sy, -cy, 0.0];
    let speed_factor = top / NOCLIP_MAX_SPEED;
    let slow = cmd.buttons & IN_DUCK != 0;
    let up = cmd.buttons & IN_JUMP != 0;
    let factor = if slow { speed_factor * NOCLIP_DUCK_FACTOR } else { speed_factor };
    let fmove = cmd.forward * factor;
    let smove = cmd.side * factor;
    let wish = [
        forward[0] * fmove + right[0] * smove,
        forward[1] * fmove + right[1] * smove,
        forward[2] * fmove + if up { NOCLIP_UP_MOVE * factor } else { 0.0 },
    ];
    let len = (wish[0] * wish[0] + wish[1] * wish[1] + wish[2] * wish[2]).sqrt();
    let dir = if len > 0.0 { [wish[0] / len, wish[1] / len, wish[2] / len] } else { [0.0; 3] };
    let max_speed = NOCLIP_MAX_SPEED * speed_factor;
    let wish_speed = len.min(if slow { max_speed * NOCLIP_DUCK_FACTOR } else { max_speed });
    let mut v = velocity;
    let current = v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2];
    let add = wish_speed - current;
    if add > 0.0 {
        let accel = (NOCLIP_ACCELERATE * dt * wish_speed).min(add);
        for i in 0..3 {
            v[i] += accel * dir[i];
        }
    }
    let speed = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if !(speed >= 1.0) {
        return (position, [0.0; 3]);
    }
    // At least a quarter of the top speed's worth of friction, so letting go stops quickly.
    let control = speed.max(max_speed * 0.25);
    let scale = (speed - control * NOCLIP_FRICTION * dt).max(0.0) / speed;
    for x in &mut v {
        *x *= scale;
    }
    let v = cap_speed(v, top);
    let mut p = position;
    for i in 0..3 {
        p[i] = (p[i] + v[i] * dt).clamp(-FLIGHT_WORLD_LIMIT, FLIGHT_WORLD_LIMIT);
    }
    (p, v)
}

/// `v` scaled down so its magnitude (3D) is at most `cap`; unchanged when it already is. The magnitude is measured in
/// f64 (exact squares of the f32 components; IEEE + and sqrt, deterministic everywhere), so the f32 velocity it returns
/// is within the cap exactly, not only after rounding.
pub fn cap_speed(v: [f32; 3], cap: f32) -> [f32; 3] {
    let len = |v: [f32; 3]| {
        let [x, y, z] = v.map(f64::from);
        (x * x + y * y + z * z).sqrt()
    };
    let speed = len(v);
    if !(speed > f64::from(cap)) {
        return v;
    }
    let mut f = cap / speed as f32;
    let mut out = [v[0] * f, v[1] * f, v[2] * f];
    // f32 rounding can leave the scaled magnitude a little above the cap: step the factor down until it isn't.
    while len(out) > f64::from(cap) {
        f = f32::from_bits(f.to_bits() - 1);
        out = [v[0] * f, v[1] * f, v[2] * f];
    }
    out
}

/// `v` with its horizontal speed scaled down to `cap` (vertical kept), as timer.ts caps a start.
pub fn cap_horizontal(v: [f32; 3], cap: f32) -> [f32; 3] {
    let speed = (v[0] * v[0] + v[1] * v[1]).sqrt();
    if speed > cap {
        let f = cap / speed;
        [v[0] * f, v[1] * f, v[2]]
    } else {
        v
    }
}

impl Game {
    /// Whether `IN_FLIGHT` flies: Infinite (`Settings::air_jump`, no other style sets it) on physics v24+.
    pub fn flight_allowed(&self) -> bool {
        self.settings.air_jump && (PHYSICS_V24..=PHYSICS_LATEST).contains(&self.settings.physics_version)
    }

    /// The player is flying (an `IN_FLIGHT` command, or a landing that found no free space yet).
    pub fn flying(&self) -> bool {
        self.extra.flying
    }

    /// The last tick ended a flight (`EVENT_FLIGHT_LANDED`): where the landing put the player and whether crouched,
    /// before that tick's normal step moved them. None on every other tick.
    pub fn flight_landing(&self) -> Option<([f32; 3], bool)> {
        self.extra.landing
    }

    /// `Game::step`'s flight part, before anything else in the tick. True when this tick was a flight tick (done);
    /// false when the tick steps normally (no flight, or the landing just put the player down).
    pub(super) fn flight_step(&mut self, cmd: Cmd) -> bool {
        if !self.flight_allowed() {
            self.extra.flying = false;
            return false;
        }
        let wants = cmd.buttons & IN_FLIGHT != 0;
        if !wants && !self.extra.flying {
            return false;
        }
        if !wants && self.flight_land(cmd) {
            return false;
        }
        self.flight_tick(cmd);
        true
    }

    /// One flying tick (`practice_noclip_tick` with the move computed here): no collision, no trigger touches, the
    /// world keeps running. Buttons other than jump and duck do nothing in flight.
    fn flight_tick(&mut self, cmd: Cmd) {
        self.timing_path = self.observe_timing.then(|| movement::accepted_path::AcceptedPath::unsupported("flight"));
        self.jumpstats_valid = false;
        self.air_speed_gain = None;
        self.categorized_ground_jump = None;
        self.last_angles = [cmd.pitch, cmd.yaw, 0.0];
        let (p, v) = flight_move(self.state.position, self.state.velocity, cmd, FLIGHT_TOP_SPEED, self.settings.tick_interval);
        self.extra.flying = true;
        self.practice_noclip_tick(p, v);
        self.last_buttons = cmd.buttons & !IN_FLIGHT;
        self.events |= EVENT_FLIGHT;
    }

    /// Ends the flight: the player at the nearest free spot along the view (`noclip_free_spot`), horizontal speed capped
    /// at `FLIGHT_EXIT_CAP`. False (still flying) when there is no free spot within reach.
    fn flight_land(&mut self, cmd: Cmd) -> bool {
        let Some((p, crouched)) = self.noclip_free_spot(self.state.position, cmd.yaw, cmd.pitch) else { return false };
        let v = cap_horizontal(self.state.velocity, FLIGHT_EXIT_CAP);
        self.place_noclip(p, v, crouched);
        self.extra.flying = false;
        self.extra.landing = Some((p, crouched));
        true
    }
}
