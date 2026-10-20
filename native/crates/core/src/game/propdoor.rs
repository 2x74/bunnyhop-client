//! prop_door_rotating (SDK 2013 game/server/props.cpp: CBasePropDoor, CPropDoorRotating) and func_rot_button
//! (game/server/buttons.cpp: CBaseButton with m_fRotating, CRotButton), as MOVETYPE_PUSH movers on the Source
//! pusher of `kin.rs`.
//!
//! prop_door_rotating: SOLID_VPHYSICS with the door model's `.phy` collision (`RtEnt::prop`), a yaw hinge at the
//! origin. +use (or the Use input) plays the model's "open" sequence; the door starts moving on its AE_DOOR_OPEN
//! animation event, dispatched by CDynamicProp::AnimThink every 0.1 s. Stock HL2 doors (door01_left: 13 frames at
//! 30 fps, event at cycle 2/3) reach the event on the third think, 0.3 s after the sequence started on the
//! player's clock; the real engine opened tools/parity's bhop_ivy_final door 35 frames after the +use (25 for some
//! use frames: the bot's command clock), the core `player_clock_lead` (5) + 30. The open direction is away
//! from the user (both-ways doors), checked against the swing volume; `returndelay` (+0.1 s) auto-closes it once
//! the full swing volume is free of the player (DoorCanClose).

use super::kin::{v_add, v_sub, Kin, KinKind, Push, Toggle};
use super::usable::UseType;
use super::*;

/// CDynamicProp::AnimThink interval.
const ANIM_THINK_TICKS: u32 = 10;
/// AE_DOOR_OPEN of the stock door "open" sequence: cycle 2/3 of a 12-frame-interval, 30 fps sequence, i.e. 26.7
/// ticks of animation time (cycle rate 2.5/s).
const DOOR_OPEN_EVENT_TICKS: u32 = 27;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum DoorState {
    Closed,
    Opening,
    Open,
    Closing,
    Ajar,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PropDoorDone {
    None,
    OpenMoveDone,
    CloseMoveDone,
    AutoClose,
}

#[derive(Clone, Debug)]
pub(super) struct PropDoor {
    pub(super) state: DoorState,
    closed: [f32; 3],
    open_fwd: [f32; 3],
    open_back: [f32; 3],
    goal: [f32; 3],
    distance: f32,
    speed: f32,
    return_delay: f32,
    /// 0 both ways, 1 forward only, 2 backward only.
    open_dir: i64,
    locked: bool,
    spawnflags: i64,
    /// m_vecForwardBoundsMin/Max, m_vecBackBoundsMin/Max (relative to the origin).
    fwd_bounds: ([f32; 3], [f32; 3]),
    back_bounds: ([f32; 3], [f32; 3]),
    pub(super) done: PropDoorDone,
    /// m_hActivator is the player.
    activator_player: bool,
    /// m_hBlocker (the player) and m_bFirstBlocked.
    blocked: bool,
    first_blocked: bool,
    /// The "open" sequence is playing: animation ticks accumulated by AnimThink since it started, the tick the
    /// animation time was last advanced to, whether AE_DOOR_OPEN fired.
    anim: Option<DoorAnim>,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct DoorAnim {
    elapsed: u32,
    anim_time: u32,
    fired: bool,
}

const SF_DOOR_START_OPEN: i64 = 1;
const SF_DOOR_LOCKED: i64 = 2048;
const SF_DOOR_USE_CLOSES: i64 = 8192;

/// Builds the kinematic state of a prop_door_rotating (CPropDoorRotating::Spawn up to the hinge side, which needs
/// the collision model: `prop_door_collision_ready`). Returns the spawn angles.
pub(super) fn build_prop_door(e: &Entity) -> (Kin, [f32; 3]) {
    let spawnflags = e.int("spawnflags");
    let closed = e.angles();
    let mut distance = e.float("distance").unwrap_or(0.0);
    if distance == 0.0 {
        distance = 90.0;
    }
    let distance = distance.abs();
    // CalcOpenAngles with the axis (0, 0, 1): vecMoveDir = (0, 1, 0), i.e. yaw.
    let open_fwd = [closed[0], closed[1] - distance, closed[2]];
    let open_back = [closed[0], closed[1] + distance, closed[2]];
    let spawnpos = e.int("spawnpos");
    let (state, spawn) = if spawnflags & SF_DOOR_START_OPEN != 0 || spawnpos == 1 {
        (DoorState::Open, open_fwd)
    } else if spawnpos == 2 {
        (DoorState::Open, open_back)
    } else if spawnpos == 3 {
        (DoorState::Ajar, e.vec3("ajarangles").unwrap_or(closed))
    } else {
        (DoorState::Closed, closed)
    };
    let speed = match e.float("speed").unwrap_or(0.0) {
        0.0 => 100.0,
        s => s,
    };
    let door = PropDoor {
        state,
        closed,
        open_fwd,
        open_back,
        goal: spawn,
        distance,
        speed,
        return_delay: e.float("returndelay").unwrap_or(-1.0),
        open_dir: e.int("opendir"),
        locked: spawnflags & SF_DOOR_LOCKED != 0,
        spawnflags,
        fwd_bounds: ([0.0; 3], [0.0; 3]),
        back_bounds: ([0.0; 3], [0.0; 3]),
        done: PropDoorDone::None,
        activator_player: false,
        blocked: false,
        first_blocked: false,
        anim: None,
    };
    let kin = Kin { push: Push { move_done: -1.0, fixangle: true, ..Push::default() }, kind: KinKind::PropDoor(door) };
    (kin, spawn)
}

impl Game {
    fn prop_door(&self, i: usize) -> &PropDoor {
        match &self.kin(i).kind {
            KinKind::PropDoor(d) => d,
            _ => unreachable!("not a prop door"),
        }
    }

    fn prop_door_mut(&mut self, i: usize) -> &mut PropDoor {
        match &mut self.kin_mut(i).kind {
            KinKind::PropDoor(d) => d,
            _ => unreachable!("not a prop door"),
        }
    }

    /// World AABB of the door's collision OBB at local angles `angles` (CollisionProp()->WorldSpaceAABB).
    fn prop_door_aabb(&self, i: usize, angles: [f32; 3]) -> Option<([f32; 3], [f32; 3])> {
        let p = self.ents[i].prop.as_ref()?;
        let t = Transform { origin: self.ents[i].origin, angles };
        let (mut lo, mut hi) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
        for c in 0..8 {
            let corner = [0, 1, 2].map(|k| if c >> k & 1 != 0 { p.hulls.maxs[k] } else { p.hulls.mins[k] });
            let w = t.transform_point(corner).ok()?;
            for k in 0..3 {
                lo[k] = lo[k].min(w[k]);
                hi[k] = hi[k].max(w[k]);
            }
        }
        Some((lo, hi))
    }

    /// CalculateDoorVolume(current angles, open angles), relative to the origin.
    fn prop_door_volume(&self, i: usize, open: [f32; 3]) -> ([f32; 3], [f32; 3]) {
        let cur = self.ents[i].local_angles;
        let (Some(a), Some(b)) = (self.prop_door_aabb(i, cur), self.prop_door_aabb(i, open)) else { return ([0.0; 3], [0.0; 3]) };
        let o = self.ents[i].origin;
        let lo = [0, 1, 2].map(|k| a.0[k].min(b.0[k]) - o[k]);
        let hi = [0, 1, 2].map(|k| a.1[k].max(b.1[k]) - o[k]);
        (lo, hi)
    }

    /// The rest of CPropDoorRotating::Spawn once the collision model is known: IsHingeOnLeft swaps the open
    /// directions, then the swing volumes.
    pub(super) fn prop_door_collision_ready(&mut self, i: usize) {
        if !matches!(&self.ents[i].data, Data::Kin(k) if matches!(k.kind, KinKind::PropDoor(_))) {
            return;
        }
        if let Some((lo, hi)) = self.prop_door_aabb(i, self.ents[i].local_angles) {
            let o = self.ents[i].origin;
            let mins = [lo[0] - o[0], lo[1] - o[1], 0.0];
            let maxs = [hi[0] - o[0], hi[1] - o[1], 0.0];
            let len2 = |v: [f32; 3]| v[0] * v[0] + v[1] * v[1];
            let check = if len2(mins) > len2(maxs) { mins } else { maxs };
            let (sy, cy) = playsrc_collision::math::sin_cos(self.ents[i].angles[1].to_radians());
            let (sp, cp) = playsrc_collision::math::sin_cos(self.ents[i].angles[0].to_radians());
            let (sr, cr) = playsrc_collision::math::sin_cos(self.ents[i].angles[2].to_radians());
            let right = [-sr * sp * cy + cr * sy, -sr * sp * sy - cr * cy, -sr * cp];
            if check[0] * right[0] + check[1] * right[1] + check[2] * right[2] > 0.0 {
                let d = self.prop_door_mut(i);
                std::mem::swap(&mut d.open_fwd, &mut d.open_back);
            }
        }
        let (fwd, back) = (self.prop_door(i).open_fwd, self.prop_door(i).open_back);
        let fb = self.prop_door_volume(i, fwd);
        let bb = self.prop_door_volume(i, back);
        let d = self.prop_door_mut(i);
        d.fwd_bounds = fb;
        d.back_bounds = bb;
    }

    /// CPropDoorRotating::CheckDoorClear: no entity but the door and its activator overlaps the swing volume
    /// (CTraceFilterDoor: entities only, MASK_SOLID; here the player and solid brush entities / moving props).
    fn prop_door_clear(&self, i: usize, which: Option<bool>) -> bool {
        let d = self.prop_door(i);
        let (lo, hi) = match which {
            Some(true) => d.fwd_bounds,
            Some(false) => d.back_bounds,
            None => (
                [0, 1, 2].map(|k| d.fwd_bounds.0[k].min(d.back_bounds.0[k])),
                [0, 1, 2].map(|k| d.fwd_bounds.1[k].max(d.back_bounds.1[k])),
            ),
        };
        let o = self.ents[i].origin;
        let box_hull = Hull { mins: lo, maxs: hi };
        // The player blocks the volume unless it is the door's activator (GetActivator() is ignored).
        let ignore_player = d.activator_player;
        if !ignore_player {
            let h = self.current_hull();
            let p = self.state.position;
            if (0..3).all(|k| p[k] + h.mins[k] < o[k] + hi[k] && p[k] + h.maxs[k] > o[k] + lo[k]) {
                return false;
            }
        }
        for &j in self.solid.iter().chain(&self.dyn_solid) {
            if j != i && self.ent_overlaps(j, o, box_hull) {
                return false;
            }
        }
        true
    }

    fn prop_door_open_state_fwd(&self, i: usize) -> bool {
        let d = self.prop_door(i);
        d.goal == d.open_fwd
    }

    /// CBasePropDoor::Use / OnUse.
    pub(super) fn prop_door_use(&mut self, i: usize, activator: Actor) {
        let d = self.prop_door(i);
        let player = activator == Actor::Player;
        if d.blocked && d.state == DoorState::Closing {
            self.prop_door_mut(i).activator_player = player;
            // DoorOpen(m_hBlocker): the blocker is the player.
            self.prop_door_open(i, Some(true));
            return;
        }
        let use_closes = d.spawnflags & SF_DOOR_USE_CLOSES != 0;
        if d.state == DoorState::Closed || (d.state == DoorState::Open && use_closes) {
            if d.locked {
                self.fire_output(i, "onlockeduse", activator);
            } else {
                self.prop_door_mut(i).activator_player = player;
                self.prop_door_start_open_sequence(i);
            }
        } else if d.state == DoorState::Opening && use_closes {
            self.prop_door_mut(i).activator_player = player;
            self.prop_door_close(i);
        } else if d.state == DoorState::Closing || d.state == DoorState::Ajar {
            self.prop_door_mut(i).activator_player = player;
            self.prop_door_open(i, Some(player));
        }
    }

    /// PropSetSequence(ACT_DOOR_OPEN): FinishSetSequence restarts the animation at the caller's clock; AnimThink
    /// is scheduled 0.1 s later unless a think is already pending.
    fn prop_door_start_open_sequence(&mut self, i: usize) {
        // gpGlobals->curtime: the player's clock inside its +use, else the server clock.
        let now = self.tick + if self.in_use { self.player_clock_lead() } else { 0 };
        self.prop_door_mut(i).anim = Some(DoorAnim { elapsed: 0, anim_time: now, fired: false });
        if self.kin(i).push.think.is_none_or(|t| t <= self.tick) {
            self.kin_mut(i).push.think = Some(now + ANIM_THINK_TICKS);
        }
    }

    /// CDynamicProp::AnimThink for the open sequence: StudioFrameAdvance (at most 0.2 s per think) and
    /// DispatchAnimEvents (AE_DOOR_OPEN -> DoorActivate). Thinks every 0.1 s until the sequence ends.
    pub(super) fn prop_door_anim_think(&mut self, i: usize) {
        let tick = self.tick;
        let Some(mut a) = self.prop_door(i).anim else { return };
        if tick > a.anim_time {
            a.elapsed += (tick - a.anim_time).min(20);
            a.anim_time = tick;
        }
        let fire = !a.fired && a.elapsed >= DOOR_OPEN_EVENT_TICKS;
        a.fired |= fire;
        // 12 frames at 30 fps: the sequence ends after 40 ticks of animation time.
        let finished = a.elapsed >= 40;
        self.prop_door_mut(i).anim = if finished { None } else { Some(a) };
        if !finished {
            self.kin_mut(i).push.think = Some(tick + ANIM_THINK_TICKS);
        }
        if fire {
            self.prop_door_activate(i);
        }
    }

    /// CBasePropDoor::DoorActivate.
    fn prop_door_activate(&mut self, i: usize) {
        if self.prop_door(i).state == DoorState::Open && self.prop_door_can_close(i, false) {
            self.prop_door_close(i);
        } else {
            let away = self.prop_door(i).activator_player.then_some(true);
            self.prop_door_open(i, away);
        }
    }

    fn prop_door_can_close(&self, i: usize, auto: bool) -> bool {
        self.prop_door_clear(i, if auto { None } else { Some(self.prop_door_open_state_fwd(i)) })
    }

    /// CBasePropDoor::DoorOpen + CPropDoorRotating::BeginOpening. `away_from_player`: open away from the player
    /// (Some(true)), or no entity to open away from (None).
    fn prop_door_open(&mut self, i: usize, away_from_player: Option<bool>) {
        let d = self.prop_door(i);
        if d.state == DoorState::Open || d.state == DoorState::Opening {
            return;
        }
        self.prop_door_mut(i).state = DoorState::Opening;
        self.prop_door_mut(i).done = PropDoorDone::OpenMoveDone;
        let d = self.prop_door(i);
        let mut fwd = true;
        if d.open_dir == 1 {
            fwd = true;
        } else if d.open_dir == 2 {
            fwd = false;
        } else {
            let away_player = away_from_player == Some(true);
            if away_player {
                let a = self.ents[i].angles;
                let (sp, cp) = playsrc_collision::math::sin_cos(a[0].to_radians());
                let (sy, cy) = playsrc_collision::math::sin_cos(a[1].to_radians());
                let f = [cp * cy, cp * sy, -sp];
                let p = self.state.position;
                let o = self.ents[i].origin;
                if f[0] * p[0] + f[1] * p[1] + f[2] * p[2] > f[0] * o[0] + f[1] * o[1] + f[2] * o[2] {
                    fwd = false;
                }
            }
            if self.prop_door(i).activator_player && away_player && !self.prop_door_clear(i, Some(fwd)) {
                fwd = !fwd;
            }
        }
        let goal = if fwd { self.prop_door(i).open_fwd } else { self.prop_door(i).open_back };
        let speed = self.prop_door(i).speed;
        self.prop_door_angular_move(i, goal, speed);
        self.fire_output(i, "onopen", Actor::Entity(i));
    }

    /// CBasePropDoor::DoorClose + BeginClosing.
    fn prop_door_close(&mut self, i: usize) {
        let d = self.prop_door(i);
        if d.state == DoorState::Closed || d.state == DoorState::Closing {
            return;
        }
        let (closed, speed) = (d.closed, d.speed);
        let dm = self.prop_door_mut(i);
        dm.state = DoorState::Closing;
        dm.done = PropDoorDone::CloseMoveDone;
        self.prop_door_angular_move(i, closed, speed);
        self.fire_output(i, "onclose", Actor::Entity(i));
    }

    /// CPropDoorRotating::AngularMove (no minimum travel time, unlike CBaseToggle).
    fn prop_door_angular_move(&mut self, i: usize, dest: [f32; 3], speed: f32) {
        self.defer_if_in_use(i);
        self.prop_door_mut(i).goal = dest;
        if dest == self.ents[i].local_angles {
            self.prop_door_move_done(i);
            return;
        }
        let delta = v_sub(dest, self.ents[i].local_angles);
        let travel = super::kin::v_len(delta) / speed;
        let p = &mut self.kin_mut(i).push;
        p.move_done = if travel >= 0.0 { p.local_time + travel } else { -1.0 };
        p.avelocity = super::kin::v_scale(delta, (1.0f64 / travel as f64) as f32);
    }

    /// CPropDoorRotating::MoveDone: snap to the goal, then the current m_pfnMoveDone.
    pub(super) fn prop_door_move_done(&mut self, i: usize) {
        let goal = self.prop_door(i).goal;
        self.ents[i].local_angles = goal;
        let p = &mut self.kin_mut(i).push;
        p.avelocity = [0.0; 3];
        p.move_done = -1.0;
        self.relink(i);
        match self.prop_door(i).done {
            PropDoorDone::OpenMoveDone => self.prop_door_open_move_done(i),
            PropDoorDone::CloseMoveDone => self.prop_door_close_move_done(i),
            PropDoorDone::AutoClose => self.prop_door_auto_close(i),
            PropDoorDone::None => {}
        }
    }

    fn prop_door_open_move_done(&mut self, i: usize) {
        let d = self.prop_door_mut(i);
        d.blocked = false;
        d.first_blocked = false;
        d.state = DoorState::Open;
        let delay = d.return_delay;
        if delay != -1.0 {
            // SetMoveDoneTime(m_flAutoReturnDelay + 0.1); SetMoveDone(DoorAutoCloseThink).
            self.prop_door_mut(i).done = PropDoorDone::AutoClose;
            let p = &mut self.kin_mut(i).push;
            p.move_done = p.local_time + (delay + 0.1);
        }
        self.fire_output(i, "onfullyopen", Actor::Entity(i));
        self.prop_door_mut(i).activator_player = false;
    }

    fn prop_door_auto_close(&mut self, i: usize) {
        if !self.prop_door_can_close(i, true) {
            let delay = self.prop_door(i).return_delay;
            let p = &mut self.kin_mut(i).push;
            p.move_done = p.local_time + (delay + 0.1);
            return;
        }
        self.prop_door_close(i);
    }

    fn prop_door_close_move_done(&mut self, i: usize) {
        let d = self.prop_door_mut(i);
        d.blocked = false;
        d.first_blocked = false;
        d.state = DoorState::Closed;
        let activator = if d.activator_player { Actor::Player } else { Actor::None };
        self.fire_output(i, "onfullyclosed", activator);
        self.prop_door_mut(i).activator_player = false;
    }

    /// StartBlocked / OnStartBlocked by the player (the door keeps pushing; Blocked does nothing to players).
    pub(super) fn prop_door_start_blocked(&mut self, i: usize) {
        let d = self.prop_door_mut(i);
        d.first_blocked = true;
        d.blocked = true;
        let event = if d.state == DoorState::Closing { "onblockedclosing" } else { "onblockedopening" };
        self.fire_output(i, event, Actor::Player);
    }

    /// EndBlocked.
    pub(super) fn prop_door_end_blocked(&mut self, i: usize) {
        let event = if self.prop_door(i).state == DoorState::Closing { "onunblockedclosing" } else { "onunblockedopening" };
        self.fire_output(i, event, Actor::Entity(i));
        if !self.prop_door(i).first_blocked {
            // DoorResume.
            let (goal, speed) = (self.prop_door(i).goal, self.prop_door(i).speed);
            self.prop_door_angular_move(i, goal, speed);
        }
    }

    /// prop_door_rotating inputs. Returns true if handled.
    pub(super) fn prop_door_input(&mut self, i: usize, input: &str, param: &str, activator: Actor) -> bool {
        match input {
            "open" => {
                let d = self.prop_door(i);
                if !d.locked && d.state != DoorState::Open && d.state != DoorState::Opening {
                    self.fire_output(i, "onopen", activator);
                    self.prop_door_open(i, None);
                }
            }
            "openawayfrom" => {
                let d = self.prop_door(i);
                if !d.locked && d.state != DoorState::Open && d.state != DoorState::Opening {
                    let away = self.resolve_targets(param.trim(), activator, Actor::Entity(i)).first() == Some(&Actor::Player);
                    self.fire_output(i, "onopen", activator);
                    self.prop_door_open(i, away.then_some(true));
                }
            }
            "close" => {
                if self.prop_door(i).state != DoorState::Closed {
                    self.fire_output(i, "onclose", activator);
                    self.prop_door_close(i);
                }
            }
            "toggle" => match self.prop_door(i).state {
                DoorState::Closed if !self.prop_door(i).locked => self.prop_door_open(i, None),
                DoorState::Open => self.prop_door_close(i),
                _ => {}
            },
            "lock" => self.prop_door_mut(i).locked = true,
            "unlock" => self.prop_door_mut(i).locked = false,
            "setspeed" => {
                let v = param.trim().parse::<f32>().unwrap_or(0.0);
                self.prop_door_mut(i).speed = v;
                let goal = self.prop_door(i).goal;
                if v != 0.0 {
                    self.prop_door_angular_move(i, goal, v);
                }
            }
            "setrotationdistance" => {
                let v = param.trim().parse::<f32>().unwrap_or(0.0);
                let d = self.prop_door_mut(i);
                d.distance = if v == 0.0 { 90.0 } else { v.abs() };
                let c = d.closed;
                d.open_fwd = [c[0], c[1] - d.distance, c[2]];
                d.open_back = [c[0], c[1] + d.distance, c[2]];
                let (fwd, back) = (d.open_fwd, d.open_back);
                let fb = self.prop_door_volume(i, fwd);
                let bb = self.prop_door_volume(i, back);
                let d = self.prop_door_mut(i);
                d.fwd_bounds = fb;
                d.back_bounds = bb;
            }
            "use" => self.prop_door_use(i, activator),
            _ => return false,
        }
        true
    }
}

// ------------------------------------------------------------------ func_rot_button

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ButtonDone {
    None,
    TriggerAndWait,
    BackHome,
}

/// CRotButton (CBaseButton with m_fRotating).
#[derive(Clone, Debug)]
pub(super) struct RotButton {
    angle1: [f32; 3],
    angle2: [f32; 3],
    final_angle: [f32; 3],
    speed: f32,
    wait: f32,
    locked: bool,
    spawnflags: i64,
    pub(super) state: Toggle,
    pub(super) done: ButtonDone,
    stay_pushed: bool,
    /// SetTouch(ButtonTouch) active.
    pub(super) touchable: bool,
    /// ButtonReturn is the pending think.
    pub(super) return_think: bool,
    activator_player: bool,
    /// m_flUseLockedTime (tick).
    use_locked_until: u32,
}

const SF_BUTTON_DONTMOVE: i64 = 1;
const SF_BUTTON_TOGGLE: i64 = 32;
const SF_BUTTON_TOUCH_ACTIVATES: i64 = 256;
const SF_BUTTON_LOCKED: i64 = 2048;

/// CRotButton::Spawn. Returns (kin, solid).
pub(super) fn build_rot_button(e: &Entity) -> (Kin, bool) {
    let sf = e.int("spawnflags");
    // CBaseToggle::AxisDir + SF_DOOR_ROTATE_BACKWARDS.
    let mut move_ang = if sf & 64 != 0 {
        [0.0, 0.0, 1.0]
    } else if sf & 128 != 0 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    if sf & 2 != 0 {
        move_ang = move_ang.map(|v: f32| -v);
    }
    let angles = e.angles();
    let distance = e.float("distance").unwrap_or(0.0);
    let speed = match e.float("speed").unwrap_or(0.0) {
        0.0 => 40.0,
        s => s,
    };
    let wait = match e.float("wait").unwrap_or(0.0) {
        0.0 => 1.0,
        w => w,
    };
    let b = RotButton {
        angle1: angles,
        angle2: v_add(angles, move_ang.map(|v| v * distance)),
        final_angle: angles,
        speed,
        wait,
        locked: sf & SF_BUTTON_LOCKED != 0,
        spawnflags: sf,
        state: Toggle::AtBottom,
        done: ButtonDone::None,
        stay_pushed: wait == -1.0,
        touchable: sf & SF_BUTTON_TOUCH_ACTIVATES != 0,
        return_think: false,
        activator_player: false,
        use_locked_until: 0,
    };
    let _ = SF_BUTTON_DONTMOVE;
    let kin = Kin { push: Push { move_done: -1.0, fixangle: true, ..Push::default() }, kind: KinKind::RotButton(b) };
    // SF_ROTBUTTON_NOTSOLID (1).
    (kin, sf & 1 == 0)
}

impl Game {
    fn rot_button(&self, i: usize) -> &RotButton {
        match &self.kin(i).kind {
            KinKind::RotButton(b) => b,
            _ => unreachable!("not a rot button"),
        }
    }

    fn rot_button_mut(&mut self, i: usize) -> &mut RotButton {
        match &mut self.kin_mut(i).kind {
            KinKind::RotButton(b) => b,
            _ => unreachable!("not a rot button"),
        }
    }

    fn actor_of(&self, player: bool) -> Actor {
        if player { Actor::Player } else { Actor::None }
    }

    /// CBaseToggle::AngularMove (0.01 s minimum travel time).
    fn rot_button_angular_move(&mut self, i: usize, dest: [f32; 3], speed: f32) {
        self.defer_if_in_use(i);
        self.rot_button_mut(i).final_angle = dest;
        if dest == self.ents[i].local_angles {
            self.rot_button_move_done(i);
            return;
        }
        let delta = v_sub(dest, self.ents[i].local_angles);
        let travel = (super::kin::v_len(delta) / speed).max(0.01);
        let p = &mut self.kin_mut(i).push;
        p.move_done = p.local_time + travel;
        p.avelocity = super::kin::v_scale(delta, (1.0f64 / travel as f64) as f32);
    }

    /// CBaseToggle::AngularMoveDone + the button's m_pfnMoveDone.
    pub(super) fn rot_button_move_done(&mut self, i: usize) {
        let a = self.rot_button(i).final_angle;
        self.ents[i].local_angles = a;
        let p = &mut self.kin_mut(i).push;
        p.avelocity = [0.0; 3];
        p.move_done = -1.0;
        self.relink(i);
        match self.rot_button(i).done {
            ButtonDone::TriggerAndWait => self.rot_button_trigger_and_wait(i),
            ButtonDone::BackHome => self.rot_button_back_home(i),
            ButtonDone::None => {}
        }
    }

    /// CBaseButton::ButtonActivate.
    fn rot_button_activate(&mut self, i: usize) {
        if self.rot_button(i).locked {
            return;
        }
        let b = self.rot_button_mut(i);
        b.state = Toggle::GoingUp;
        b.done = ButtonDone::TriggerAndWait;
        let (dest, speed) = (b.angle2, b.speed);
        self.rot_button_angular_move(i, dest, speed);
    }

    /// CBaseButton::TriggerAndWait.
    fn rot_button_trigger_and_wait(&mut self, i: usize) {
        if self.rot_button(i).locked {
            return;
        }
        let tick = self.tick;
        let wait_ticks = self.delay_ticks(self.rot_button(i).wait.max(0.0));
        let b = self.rot_button_mut(i);
        b.state = Toggle::AtTop;
        b.done = ButtonDone::None;
        if b.stay_pushed || b.spawnflags & SF_BUTTON_TOGGLE != 0 {
            b.touchable = b.spawnflags & SF_BUTTON_TOUCH_ACTIVATES != 0;
        } else {
            b.return_think = true;
            self.kin_mut(i).push.think = Some(tick + wait_ticks);
        }
        let activator = self.actor_of(self.rot_button(i).activator_player);
        self.fire_output(i, "onin", activator);
    }

    /// CBaseButton::ButtonReturn.
    pub(super) fn rot_button_return(&mut self, i: usize) {
        let b = self.rot_button_mut(i);
        b.return_think = false;
        b.state = Toggle::GoingDown;
        b.done = ButtonDone::BackHome;
        let (dest, speed) = (b.angle1, b.speed);
        self.rot_button_angular_move(i, dest, speed);
    }

    /// CBaseButton::ButtonBackHome.
    fn rot_button_back_home(&mut self, i: usize) {
        let b = self.rot_button_mut(i);
        b.state = Toggle::AtBottom;
        b.done = ButtonDone::None;
        b.touchable = b.spawnflags & SF_BUTTON_TOUCH_ACTIVATES != 0;
        let activator = self.actor_of(self.rot_button(i).activator_player);
        self.fire_output(i, "onout", activator);
    }

    /// CBaseButton::ButtonUse (CRotButton always has it).
    pub(super) fn rot_button_use(&mut self, i: usize, _use_type: UseType, activator: Actor) {
        let b = self.rot_button(i).clone();
        if b.state == Toggle::GoingUp || b.state == Toggle::GoingDown {
            return;
        }
        if b.locked {
            if self.tick > b.use_locked_until || b.use_locked_until == 0 {
                let until = self.tick + self.delay_ticks(0.5);
                self.rot_button_mut(i).use_locked_until = until;
                self.fire_output(i, "onuselocked", activator);
            }
            return;
        }
        self.rot_button_mut(i).activator_player = activator == Actor::Player;
        if b.state == Toggle::AtTop {
            if b.spawnflags & SF_BUTTON_TOGGLE != 0 {
                self.fire_output(i, "onpressed", activator);
                self.rot_button_return(i);
            }
        } else {
            self.fire_output(i, "onpressed", activator);
            self.rot_button_activate(i);
        }
    }

    /// CBaseButton::ButtonTouch by the player.
    pub(super) fn rot_button_touch(&mut self, i: usize) {
        let b = self.rot_button(i);
        if !b.touchable {
            return;
        }
        let toggle = b.spawnflags & SF_BUTTON_TOGGLE != 0;
        // ButtonResponseToTouch.
        let code = match b.state {
            Toggle::GoingUp | Toggle::GoingDown => 0,
            Toggle::AtTop if !b.stay_pushed && !toggle => 0,
            Toggle::AtTop => {
                if toggle && !b.stay_pushed {
                    2
                } else {
                    0
                }
            }
            Toggle::AtBottom => 1,
        };
        if code == 0 || b.locked {
            return;
        }
        let b = self.rot_button_mut(i);
        b.activator_player = true;
        b.touchable = false;
        self.fire_output(i, "onpressed", Actor::Player);
        if code == 2 {
            self.rot_button_return(i);
        } else {
            self.rot_button_activate(i);
        }
    }

    /// func_rot_button inputs (CBaseButton). Returns true if handled.
    pub(super) fn rot_button_input(&mut self, i: usize, input: &str, activator: Actor) -> bool {
        // CBaseButton::Press.
        let press = |game: &mut Game, code: u8| {
            let b = game.rot_button(i);
            let s = b.state;
            if (code == 3 && (s == Toggle::GoingUp || s == Toggle::GoingDown))
                || (code == 1 && (s == Toggle::GoingUp || s == Toggle::AtTop))
                || (code == 2 && (s == Toggle::GoingDown || s == Toggle::AtBottom))
            {
                return;
            }
            if b.locked {
                return;
            }
            game.rot_button_mut(i).touchable = false;
            game.rot_button_mut(i).activator_player = activator == Actor::Player;
            if (code == 3 && s == Toggle::AtTop) || (code == 2 && (s == Toggle::AtTop || s == Toggle::GoingUp)) {
                game.fire_output(i, "onpressed", activator);
                game.rot_button_return(i);
            } else if code == 3 || (code == 1 && (s == Toggle::AtBottom || s == Toggle::GoingDown)) {
                game.fire_output(i, "onpressed", activator);
                game.rot_button_activate(i);
            }
        };
        match input {
            "lock" => self.rot_button_mut(i).locked = true,
            "unlock" => self.rot_button_mut(i).locked = false,
            "press" => press(self, 3),
            "pressin" => press(self, 1),
            "pressout" => press(self, 2),
            "use" => self.rot_button_use(i, UseType::Toggle, activator),
            _ => return false,
        }
        true
    }
}
