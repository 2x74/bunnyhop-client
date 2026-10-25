//! Kinematic (MOVETYPE_PUSH) brush entities that rotate or follow paths, and the Source pusher that
//! moves the player with them. Ported from the public SDK 2013 server code:
//!
//! - `CBaseEntity::PhysicsPusher` / `PerformPush` / `PhysicsPushMove` / `PhysicsPushRotate`
//!   (physics_main.cpp): local time, move-done time, rotate-then-move, blocking.
//! - `CPhysicsPushedEntities` (physics_main.cpp): who gets pushed (standing on a pusher in the
//!   hierarchy, or overlapping a solid pusher at its new transform), the push trace with the
//!   pushers hidden, the final validity test, rollback when blocked, and the relative view-angle
//!   change (`FIXANGLE_RELATIVE`) of a player pushed by a rotation.
//! - `CFuncRotating` (bmodels.cpp), `CRotDoor` / `CBaseDoor` (doors.cpp), `CFuncMoveLinear`
//!   (func_movelinear.cpp), `CFuncTrackTrain` / `CFuncTankTrain` (trains.cpp, tanktrain.cpp) and
//!   `CPathTrack` (pathtrack.cpp), `CBaseToggle::LinearMove` / `AngularMove` (subs.cpp).
//! - `CPhysMotor` (phys_controller.cpp) driving a hinged physics object: approximated as a
//!   kinematic rotation about the hinge axis at the motor's ramped target speed (see
//!   research/ENTITIES.md).
//!
//! Everything is f32 and tick based; the Source float arithmetic (local time accumulation, the
//! `double` literals of the spin-up formulas, anglemod) is followed where it affects results.

use super::*;
use playsrc_collision::Transform;

// ------------------------------------------------------------------ small math

pub(super) fn v_add(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
pub(super) fn v_sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub(super) fn v_scale(a: [f32; 3], s: f32) -> [f32; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}
pub(super) fn v_len(a: [f32; 3]) -> f32 {
    (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
}
fn v_dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn is_zero(a: [f32; 3]) -> bool {
    a == [0.0; 3]
}

/// mathlib `anglemod`.
pub(super) fn anglemod(a: f32) -> f32 {
    ((360.0f64 / 65536.0) * ((((a as f64) * (65536.0 / 360.0)) as i32 & 65535) as f64)) as f32
}

/// `UTIL_AngleDistance`.
fn angle_distance(next: f32, cur: f32) -> f32 {
    let delta = next - cur;
    if delta < -180.0 {
        delta + 360.0
    } else if delta > 180.0 {
        delta - 360.0
    } else {
        delta
    }
}

/// `UTIL_AngleMod` + `UTIL_ApproachAngle`.
fn approach_angle(target: f32, value: f32, speed: f32) -> f32 {
    let util_anglemod = |a: f32| {
        let a = a.rem_euclid(360.0);
        if a < 0.0 { a + 360.0 } else { a }
    };
    let target = util_anglemod(target);
    let value = util_anglemod(value);
    let speed = speed.abs();
    let mut delta = target - value;
    if delta < -180.0 {
        delta += 360.0;
    } else if delta > 180.0 {
        delta -= 360.0;
    }
    if delta > speed {
        value + speed
    } else if delta < -speed {
        value - speed
    } else {
        target
    }
}

/// `UTIL_Approach`.
fn approach(target: f32, value: f32, speed: f32) -> f32 {
    let delta = target - value;
    if delta > speed {
        value + speed
    } else if delta < -speed {
        value - speed
    } else {
        target
    }
}

/// mathlib `VectorAngles` (pitch, yaw; roll 0).
pub(super) fn vector_angles(f: [f32; 3]) -> [f32; 3] {
    if f[1] == 0.0 && f[0] == 0.0 {
        return [if f[2] > 0.0 { 270.0 } else { 90.0 }, 0.0, 0.0];
    }
    let mut yaw = playsrc_collision::math::atan264(f[1] as f64, f[0] as f64).to_degrees() as f32;
    if yaw < 0.0 {
        yaw += 360.0;
    }
    let tmp = (f[0] * f[0] + f[1] * f[1]).sqrt();
    let mut pitch = playsrc_collision::math::atan264(-(f[2] as f64), tmp as f64).to_degrees() as f32;
    if pitch < 0.0 {
        pitch += 360.0;
    }
    [pitch, yaw, 0.0]
}

fn fixup_angles(a: [f32; 3]) -> [f32; 3] {
    a.map(anglemod)
}

fn normalized(v: [f32; 3]) -> [f32; 3] {
    let l = v_len(v);
    if l > 0.0 { v_scale(v, 1.0 / l) } else { v }
}

/// `SimpleSplineRemapVal(p, 0, 1, 0, 1)`.
fn simple_spline(p: f32) -> f32 {
    let s = p * p;
    3.0 * s - 2.0 * s * p
}

fn xf(origin: [f32; 3], angles: [f32; 3]) -> Transform {
    Transform { origin, angles }
}

// ------------------------------------------------------------------ state

/// MOVETYPE_PUSH simulation state of one entity (CBaseEntity fields).
#[derive(Clone, Debug, Default)]
pub(super) struct Push {
    /// `m_flLocalTime`.
    pub local_time: f32,
    /// `m_flMoveDoneTime` (entity local time; negative = none).
    pub move_done: f32,
    /// Local linear velocity (`m_vecVelocity`, parent space).
    pub velocity: [f32; 3],
    /// Local angular velocity in degrees per second (`m_vecAngVelocity`).
    pub avelocity: [f32; 3],
    /// Next think tick (`PhysicsRunThink`).
    pub think: Option<u32>,
    /// `m_pBlocker` is the player.
    pub blocked: bool,
    /// `FL_UNBLOCKABLE_BY_PLAYER`.
    pub unblockable: bool,
    /// The player's view rotates with this pusher (MOVETYPE_PUSH: yes; vphysics motors: no).
    pub fixangle: bool,
    /// First tick the pusher runs after a move started from inside the player's +use (player clock, ahead of the
    /// server): the real engine moves it from the next frame (tools/parity `yk_lever`).
    pub start_tick: u32,
}

#[derive(Clone, Debug)]
pub(super) struct Kin {
    pub push: Push,
    pub kind: KinKind,
}

#[derive(Clone, Debug)]
pub(super) enum KinKind {
    Rotating(Rotating),
    RotDoor(RotDoor),
    MoveLinear(MoveLinear),
    Train(Train),
    Motor(Motor),
    PropDoor(super::propdoor::PropDoor),
    RotButton(super::propdoor::RotButton),
    Fall(Fall),
}

/// A func_physbox handed to VPhysics at runtime (EnableMotion / Wake): approximated as a rigid body that falls
/// straight down under sv_gravity (no rotation, no constraints or thrusters) until something stops it, carrying
/// riders like a pusher. `active` false = asleep / motion disabled / settled at load (static).
#[derive(Clone, Debug)]
pub(super) struct Fall {
    pub(super) active: bool,
    vz: f32,
    /// Physics-object triggers (SF_TRIGGER_ALLOW_PHYSICS) it is inside.
    touching: Vec<usize>,
    /// Contact probes (model space): every corner of the body's collision brushes plus a 16u grid over their
    /// downward-facing sides. The body stops where the first probe, cast straight down, hits something.
    probes: std::rc::Rc<Vec<[f32; 3]>>,
    /// Held by a constraint (hinge, rope, pulley, ...) or driven by a thruster / torque: the motion those would
    /// give it isn't simulated, so it stays where it is.
    pub(super) constrained: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum RotDone {
    None,
    SpinUp,
    SpinDown,
    Reverse,
    Rotate,
}

#[derive(Clone, Debug)]
pub(super) struct Rotating {
    move_ang: [f32; 3],
    speed: f32,
    target_speed: f32,
    max_speed: f32,
    fan_friction: f32,
    block_damage: f32,
    reversed: bool,
    accdcc: bool,
    stop_at_start: bool,
    ang_start: [f32; 3],
    done: RotDone,
    pub(super) hurt: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Toggle {
    AtBottom,
    GoingUp,
    AtTop,
    GoingDown,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum DoorDone {
    None,
    HitTop,
    HitBottom,
    GoDown,
}

#[derive(Clone, Debug)]
pub(super) struct RotDoor {
    angle1: [f32; 3],
    angle2: [f32; 3],
    move_ang: [f32; 3],
    pub(super) state: Toggle,
    speed: f32,
    wait: f32,
    block_damage: f32,
    locked: bool,
    force_closed: bool,
    spawnflags: i64,
    final_angle: [f32; 3],
    angular: bool,
    done: DoorDone,
    /// `SetTouch(DoorTouch)` active.
    pub(super) touchable: bool,
    /// `m_hActivator` is the player.
    activator_player: bool,
    mins: [f32; 3],
    maxs: [f32; 3],
}

#[derive(Clone, Debug)]
pub(super) struct MoveLinear {
    pos1: [f32; 3],
    pos2: [f32; 3],
    final_dest: [f32; 3],
    speed: f32,
    block_damage: f32,
    linear: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum TrainThink {
    None,
    Find,
    Next,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum TrainDone {
    None,
    DeadEnd,
}

#[derive(Clone, Debug)]
pub(super) struct Train {
    target: String,
    path: Option<usize>,
    dir: f32,
    speed: f32,
    old_speed: f32,
    max_speed: f32,
    height: f32,
    length: f32,
    bank: f32,
    block_damage: f32,
    velocity_type: i64,
    orientation_type: i64,
    manual: bool,
    accel: f32,
    decel: f32,
    desired_speed: f32,
    accel_to_speed: bool,
    fwd_modifier: f32,
    unmodified_desired: f32,
    spawnflags: i64,
    tank: bool,
    think: TrainThink,
    done: TrainDone,
}

/// phys_motor driving a hinged physics object (approximated kinematically).
#[derive(Clone, Debug)]
pub(super) struct Motor {
    /// Hinge point and axis (world space, unit).
    origin: [f32; 3],
    axis: [f32; 3],
    /// Target speed (`m_flSpeed`) and the ramped controller speed (`m_motor.m_speed`), deg/s.
    target: f32,
    speed: f32,
    accel: f32,
    on: bool,
    /// The attached object's spawn transform and the accumulated rotation about the hinge.
    base_origin: [f32; 3],
    base_angles: [f32; 3],
    angle: f32,
}

/// path_track (CPathTrack).
#[derive(Clone, Debug)]
pub(super) struct PathTrack {
    pub next: Option<usize>,
    pub prev: Option<usize>,
    pub alt: Option<usize>,
    pub speed: f32,
    pub spawnflags: i64,
    pub orientation_type: i64,
    target: String,
    alt_name: String,
}

const SF_PATH_DISABLED: i64 = 0x1;
const SF_PATH_ALTREVERSE: i64 = 0x4;
const SF_PATH_DISABLE_TRAIN: i64 = 0x8;
const SF_PATH_TELEPORT: i64 = 0x10;
const SF_PATH_ALTERNATE: i64 = 0x8000;

const SF_TRACKTRAIN_NOPITCH: i64 = 0x1;
const SF_TRACKTRAIN_NOCONTROL: i64 = 0x2;
const SF_TRACKTRAIN_FIXED_ORIENTATION: i64 = 0x10;

const SF_DOOR_START_OPEN_OBSOLETE: i64 = 1;
const SF_DOOR_ROTATE_BACKWARDS: i64 = 2;
const SF_DOOR_ONEWAY: i64 = 16;
const SF_DOOR_NO_AUTO_RETURN: i64 = 32;
const SF_DOOR_ROTATE_ROLL: i64 = 64;
const SF_DOOR_ROTATE_PITCH: i64 = 128;
pub(super) const SF_DOOR_PTOUCH: i64 = 1024;
const SF_DOOR_LOCKED: i64 = 2048;

// ------------------------------------------------------------------ spawn

impl Kin {
    fn new(kind: KinKind) -> Self {
        Self { push: Push { move_done: -1.0, fixangle: true, ..Push::default() }, kind }
    }
}

/// Builds the kinematic state for the classes this module simulates. Returns (data, solid).
pub(super) fn build(class: &str, e: &Entity, brush: Option<&BrushModel>, tick_interval: f32) -> Option<(Data, bool)> {
    let spawnflags = e.int("spawnflags");
    let size = brush.map(|b| v_sub(b.maxs, b.mins)).unwrap_or([0.0; 3]);
    let angles = e.angles();
    match class {
        "func_rotating" => {
            let friction = e.float("fanfriction").unwrap_or(0.0) / 100.0;
            let mut move_ang = if spawnflags & 4 != 0 {
                [0.0, 0.0, 1.0]
            } else if spawnflags & 8 != 0 {
                [1.0, 0.0, 0.0]
            } else {
                [0.0, 1.0, 0.0]
            };
            if spawnflags & 2 != 0 {
                move_ang = v_scale(move_ang, -1.0);
            }
            let max_speed = match e.float("maxspeed").unwrap_or(0.0).abs() {
                0.0 => 100.0,
                s => s,
            };
            let mut kin = Kin::new(KinKind::Rotating(Rotating {
                move_ang,
                speed: 0.0,
                target_speed: 0.0,
                max_speed,
                fan_friction: if friction == 0.0 { 1.0 } else { friction },
                block_damage: e.float("dmg").unwrap_or(0.0),
                reversed: false,
                accdcc: spawnflags & 16 != 0,
                stop_at_start: false,
                ang_start: angles,
                done: RotDone::None,
                hurt: spawnflags & 32 != 0,
            }));
            if spawnflags & 1 != 0 {
                // SUB_CallUseToggle 0.2 s after spawn ("leave a magic delay for client to start up").
                kin.push.think = Some((0.2 / tick_interval).round() as u32);
            }
            Some((Data::Kin(Box::new(kin)), spawnflags & 64 == 0))
        }
        "func_door_rotating" => {
            let mut move_ang = if spawnflags & SF_DOOR_ROTATE_ROLL != 0 {
                [0.0, 0.0, 1.0]
            } else if spawnflags & SF_DOOR_ROTATE_PITCH != 0 {
                [1.0, 0.0, 0.0]
            } else {
                [0.0, 1.0, 0.0]
            };
            if spawnflags & SF_DOOR_ROTATE_BACKWARDS != 0 {
                move_ang = v_scale(move_ang, -1.0);
            }
            let distance = e.float("distance").unwrap_or(0.0);
            let mut angle1 = angles;
            let mut angle2 = v_add(angles, v_scale(move_ang, distance));
            let mut state = Toggle::AtBottom;
            if spawnflags & SF_DOOR_START_OPEN_OBSOLETE != 0 {
                std::mem::swap(&mut angle1, &mut angle2);
                move_ang = v_scale(move_ang, -1.0);
            } else if e.int("spawnpos") == 1 {
                state = Toggle::AtTop;
            }
            let speed = match e.float("speed").unwrap_or(0.0) {
                0.0 => 100.0,
                s => s,
            };
            let kin = Kin::new(KinKind::RotDoor(RotDoor {
                angle1,
                angle2,
                move_ang,
                state,
                speed,
                wait: e.float("wait").unwrap_or(0.0),
                block_damage: e.float("dmg").unwrap_or(0.0),
                locked: spawnflags & SF_DOOR_LOCKED != 0,
                force_closed: e.int("forceclosed") != 0,
                spawnflags,
                final_angle: angles,
                angular: false,
                done: DoorDone::None,
                touchable: true,
                activator_player: false,
                mins: brush.map(|b| b.mins).unwrap_or([0.0; 3]),
                maxs: brush.map(|b| b.maxs).unwrap_or([0.0; 3]),
            }));
            // SF_DOOR_PASSABLE (8) -> FSOLID_NOT_SOLID; SF_DOOR_NONSOLID_TO_PLAYER (4) is treated as
            // non-solid to the player like func_door (game.rs build_entity).
            Some((Data::Kin(Box::new(kin)), spawnflags & (4 | 8) == 0))
        }
        // func_water_analog is a CFuncMoveLinear too ("so we can raise/lower the water level"): never solid
        // (FSOLID_VOLUME_CONTENTS); its water counts from physics v4, and so do its inputs (game.rs entity_input).
        "func_movelinear" | "momentary_door" | "func_water_analog" => {
            let dir = angle_vectors_forward(e.vec3("movedir").unwrap_or([0.0; 3]));
            let speed = match e.float("speed").unwrap_or(0.0) {
                s if s <= 0.0 => 100.0,
                s => s,
            };
            let mut distance = e.float("movedistance").unwrap_or(0.0);
            if distance <= 0.0 {
                let lip = e.float("lip").unwrap_or(0.0);
                distance = dir[0].abs() * size[0] + dir[1].abs() * size[1] + dir[2].abs() * size[2] - lip;
            }
            let origin = e.origin();
            let start = e.float("startposition").unwrap_or(0.0);
            let pos1 = v_sub(origin, v_scale(dir, distance * start));
            let pos2 = v_add(pos1, v_scale(dir, distance));
            let kin = Kin::new(KinKind::MoveLinear(MoveLinear {
                pos1,
                pos2,
                final_dest: origin,
                speed,
                block_damage: e.float("blockdamage").unwrap_or(0.0),
                linear: false,
            }));
            Some((Data::Kin(Box::new(kin)), spawnflags & 8 == 0 && class != "func_water_analog"))
        }
        "prop_door_rotating" => {
            let (kin, _) = super::propdoor::build_prop_door(e);
            Some((Data::Kin(Box::new(kin)), true))
        }
        "func_rot_button" => {
            let (kin, solid) = super::propdoor::build_rot_button(e);
            Some((Data::Kin(Box::new(kin)), solid))
        }
        "func_physbox" | "func_physbox_multiplayer" => {
            // CPhysBox::Spawn: "notsolid" (m_bNotSolidToWorld) adds FSOLID_NOT_SOLID; the debris flag
            // (SF_PHYSBOX_DEBRIS 0x4000) puts it in COLLISION_GROUP_DEBRIS, which players don't collide with.
            // CPhysBoxMultiplayer::Activate: COLLISION_GROUP_PUSHAWAY, which CS:S players never collide with.
            let solid = class == "func_physbox" && e.int("notsolid") == 0 && spawnflags & 0x4000 == 0;
            let mut kin = Kin::new(KinKind::Fall(Fall { active: false, vz: 0.0, touching: Vec::new(), probes: Default::default(), constrained: false }));
            kin.push.fixangle = false;
            Some((Data::Kin(Box::new(kin)), solid))
        }
        "func_tracktrain" | "func_tanktrain" => {
            let speed = e.float("speed").unwrap_or(0.0);
            let mut max_speed = e.float("startspeed").unwrap_or(0.0);
            if max_speed == 0.0 {
                max_speed = if speed == 0.0 { 100.0 } else { speed };
            }
            let mut kin = Kin::new(KinKind::Train(Train {
                target: e.get("target").unwrap_or("").to_string(),
                path: None,
                dir: 1.0,
                speed,
                old_speed: 0.0,
                max_speed,
                height: e.float("height").unwrap_or(0.0),
                length: e.float("wheels").unwrap_or(0.0),
                bank: e.float("bank").unwrap_or(0.0),
                block_damage: e.float("dmg").unwrap_or(0.0),
                velocity_type: e.get("velocitytype").map(|_| e.int("velocitytype")).unwrap_or(0),
                orientation_type: e.get("orientationtype").map(|_| e.int("orientationtype")).unwrap_or(1),
                manual: e.int("manualspeedchanges") != 0,
                accel: e.float("manualaccelspeed").unwrap_or(0.0),
                decel: e.float("manualdecelspeed").unwrap_or(0.0),
                desired_speed: 0.0,
                accel_to_speed: false,
                fwd_modifier: 1.0,
                unmodified_desired: 0.0,
                spawnflags,
                tank: class == "func_tanktrain",
                think: TrainThink::Find,
                done: TrainDone::None,
            }));
            kin.push.think = Some(0);
            kin.push.unblockable = spawnflags & 0x200 != 0;
            Some((Data::Kin(Box::new(kin)), spawnflags & 8 == 0))
        }
        _ => None,
    }
}

pub(super) fn build_path_track(e: &Entity) -> Data {
    Data::PathTrack(PathTrack {
        next: None,
        prev: None,
        alt: None,
        speed: e.float("speed").unwrap_or(0.0),
        spawnflags: e.int("spawnflags"),
        orientation_type: e.get("orientationtype").map(|_| e.int("orientationtype")).unwrap_or(1),
        target: e.get("target").unwrap_or("").to_string(),
        alt_name: e.get("altpath").unwrap_or("").to_string(),
    })
}

// ------------------------------------------------------------------ Game integration

impl Game {
    pub(super) fn kin(&self, i: usize) -> &Kin {
        match &self.ents[i].data {
            Data::Kin(k) => k,
            _ => unreachable!("not a kinematic entity"),
        }
    }

    pub(super) fn kin_mut(&mut self, i: usize) -> &mut Kin {
        match &mut self.ents[i].data {
            Data::Kin(k) => k,
            _ => unreachable!("not a kinematic entity"),
        }
    }

    fn path(&self, i: usize) -> Option<&PathTrack> {
        match &self.ents.get(i)?.data {
            Data::PathTrack(p) if !self.ents[i].removed => Some(p),
            _ => None,
        }
    }

    /// CPathTrack::Activate / Link for every named path_track, and phys_motor attachments.
    pub(super) fn link_kinematics(&mut self) {
        for i in 0..self.ents.len() {
            let Data::PathTrack(p) = &self.ents[i].data else { continue };
            if self.ents[i].name.is_empty() {
                continue;
            }
            let (target, alt_name) = (p.target.clone(), p.alt_name.clone());
            if !target.is_empty() {
                if let Some(t) = self.find_named(&target).filter(|&t| t != i) {
                    if matches!(self.ents[t].data, Data::PathTrack(_)) {
                        if let Data::PathTrack(p) = &mut self.ents[i].data {
                            p.next = Some(t);
                        }
                        self.path_set_previous(t, i);
                    }
                }
            }
            if !alt_name.is_empty() {
                if let Some(t) = self.find_named(&alt_name) {
                    if matches!(self.ents[t].data, Data::PathTrack(_)) {
                        if let Data::PathTrack(p) = &mut self.ents[i].data {
                            p.alt = Some(t);
                        }
                        self.path_set_previous(t, i);
                    }
                }
            }
        }
        // phys_motor: CPhysMotor::Spawn (axis) + Activate (attach, hinge), as a kinematic rotator.
        for m in 0..self.entities.len() {
            let e = &self.entities[m];
            if !e.classname().eq_ignore_ascii_case("phys_motor") {
                continue;
            }
            let origin = e.origin();
            let mut axis = v_sub(e.vec3("axis").unwrap_or(origin), origin);
            let len = v_len(axis);
            if len <= 1.0 {
                continue; // "does not have a valid axis helper, and self-destructed"
            }
            axis = v_scale(axis, 1.0 / len);
            // UTIL_SnapDirectionToAxis (epsilon 0.002).
            for k in 0..3 {
                if (axis[k].abs() - 1.0).abs() < 0.002 {
                    axis = [0.0; 3];
                    axis[k] = if e.vec3("axis").unwrap_or(origin)[k] - origin[k] < 0.0 { -1.0 } else { 1.0 };
                    break;
                }
            }
            let spawnflags = e.int("spawnflags");
            let speed = e.float("speed").unwrap_or(0.0);
            let spinup = e.float("spinup").unwrap_or(0.0);
            let accel = if spinup != 0.0 { (speed / spinup).abs() } else { speed.abs() };
            let Some(attach) = e.get("attach1").and_then(|n| self.find_named(n)) else { continue };
            // Only hinged physboxes / physics props that this module can carry.
            let class = self.ents[attach].class.clone();
            if spawnflags & 4 == 0 || !(class.starts_with("func_physbox") || class.starts_with("prop_physics")) {
                continue;
            }
            if self.ents[attach].brush.is_none() || self.ents[attach].parent.is_some() {
                continue;
            }
            let (base_origin, base_angles) = (self.ents[attach].origin, self.ents[attach].angles);
            let mut kin = Kin::new(KinKind::Motor(Motor {
                origin,
                axis,
                target: speed,
                speed: 0.0,
                accel,
                on: false,
                base_origin,
                base_angles,
                angle: 0.0,
            }));
            kin.push.fixangle = false;
            kin.push.unblockable = true;
            if spawnflags & 1 != 0 {
                kin.push.think = Some(0);
            }
            let motor_name = e.get("targetname").filter(|n| !n.is_empty()).map(str::to_string);
            self.ents[attach].data = Data::Kin(Box::new(kin));
            self.ents[attach].motor_name = motor_name;
            self.ents[m].data = Data::MotorRef(attach);
        }
    }

    fn path_set_previous(&mut self, t: usize, prev: usize) {
        let prev_name = self.ents[prev].name.clone();
        if let Data::PathTrack(p) = &mut self.ents[t].data {
            if !prev_name.eq_ignore_ascii_case(&p.alt_name) {
                p.prev = Some(prev);
            }
        }
    }

    fn path_next(&self, i: usize) -> Option<usize> {
        let p = self.path(i)?;
        if p.alt.is_some() && p.spawnflags & SF_PATH_ALTERNATE != 0 && p.spawnflags & SF_PATH_ALTREVERSE == 0 {
            return p.alt;
        }
        p.next.filter(|&n| self.path(n).is_some())
    }

    fn path_prev(&self, i: usize) -> Option<usize> {
        let p = self.path(i)?;
        if p.alt.is_some() && p.spawnflags & SF_PATH_ALTERNATE != 0 && p.spawnflags & SF_PATH_ALTREVERSE != 0 {
            return p.alt;
        }
        p.prev.filter(|&n| self.path(n).is_some())
    }

    fn path_in_dir(&self, i: usize, forward: bool) -> Option<usize> {
        if forward { self.path_next(i) } else { self.path_prev(i) }
    }

    fn path_valid(&self, p: Option<usize>, test: bool) -> Option<usize> {
        let p = p?;
        if test && self.path(p)?.spawnflags & SF_PATH_DISABLED != 0 {
            return None;
        }
        Some(p)
    }

    fn path_origin(&self, i: usize) -> [f32; 3] {
        self.ents[i].local_origin
    }

    /// CPathTrack::LookAhead.
    fn path_look_ahead(&self, start: usize, origin: &mut [f32; 3], dist: f32, mv: bool, next_next: &mut Option<usize>) -> Option<usize> {
        let mut current = start;
        let original = dist;
        let mut dist = dist;
        let mut pos = *origin;
        let mut forward = true;
        if dist < 0.0 {
            dist = -dist;
            forward = false;
        }
        let mut guard = 0;
        while dist > 0.0 {
            guard += 1;
            if guard > 10_000 {
                return None;
            }
            let Some(n) = self.path_valid(self.path_in_dir(current, forward), mv) else {
                if !mv {
                    // Project(pcurrent->GetNextInDir(!bForward), pcurrent, origin, dist)
                    if let Some(s) = self.path_in_dir(current, !forward) {
                        let d = normalized(v_sub(self.path_origin(current), self.path_origin(s)));
                        *origin = v_add(self.path_origin(current), v_scale(d, dist));
                    }
                }
                return None;
            };
            let dir = v_sub(self.path_origin(n), pos);
            let length = v_len(dir);
            if length == 0.0 && self.path_valid(self.path_in_dir(n, forward), mv).is_none() {
                *next_next = None;
                if dist == original {
                    return None;
                }
                return Some(n);
            }
            if length > dist {
                *origin = v_add(pos, v_scale(dir, dist / length));
                *next_next = Some(n);
                return Some(current);
            }
            dist -= length;
            pos = self.path_origin(n);
            current = n;
            *origin = pos;
        }
        *next_next = self.path_in_dir(current, forward);
        Some(current)
    }

    /// CPathTrack::GetOrientation.
    fn path_orientation(&self, i: usize, forward: bool) -> [f32; 3] {
        if self.path(i).is_some_and(|p| p.orientation_type == 2) {
            return self.ents[i].local_angles;
        }
        let (prev, next) = match self.path_in_dir(i, forward) {
            Some(n) => (i, n),
            None => match self.path_in_dir(i, !forward) {
                Some(p) => (p, i),
                None => return [0.0; 3],
            },
        };
        vector_angles(v_sub(self.path_origin(next), self.path_origin(prev)))
    }

    // -------------------------------------------------------------- transforms / hierarchy

    /// Recomputes the abs transform of `i` from its local transform and its parent, then of all its
    /// descendants (CBaseEntity::CalcAbsolutePosition, invalidated recursively).
    pub(super) fn relink(&mut self, i: usize) {
        let local = xf(self.ents[i].local_origin, self.ents[i].local_angles);
        let abs = match self.ents[i].parent {
            Some(p) => xf(self.ents[p].origin, self.ents[p].angles).compose(local).unwrap_or(local),
            None => local,
        };
        let e = &mut self.ents[i];
        e.origin = abs.origin;
        e.angles = abs.angles;
        if let Some(b) = e.brush.as_mut() {
            if !e.door_brush {
                b.origin = abs.origin;
                b.angles = abs.angles;
            }
        }
        if let Some(p) = e.prop.as_mut() {
            p.place(abs.origin, abs.angles, physics::ENTITY_PROP | i as u32);
        }
        for k in 0..self.ents[i].children.len() {
            let c = self.ents[i].children[k];
            self.relink(c);
        }
    }

    /// Whether the solid collision of entity `j` (brush model or moving prop) overlaps `hull` at `at`.
    pub(super) fn ent_overlaps(&self, j: usize, at: [f32; 3], hull: Hull) -> bool {
        let e = &self.ents[j];
        if let Some(b) = &e.brush {
            return self.world.overlaps_transformed_model_hull(b.model, xf(b.origin, b.angles), at, hull).unwrap_or(false);
        }
        e.prop.as_ref().is_some_and(|p| p.overlaps(at, hull))
    }

    /// The entity and all its descendants (SetupAllInHierarchy order).
    fn hierarchy(&self, root: usize) -> Vec<usize> {
        let mut out = vec![root];
        let mut k = 0;
        while k < out.len() {
            let i = out[k];
            out.extend(self.ents[i].children.iter().copied().filter(|&c| !self.ents[c].removed));
            k += 1;
        }
        out
    }

    pub(super) fn abs_velocity(&self, i: usize) -> [f32; 3] {
        ent_abs_velocity(&self.ents, i)
    }

    // -------------------------------------------------------------- per tick

    /// PhysicsRunThink + PhysicsPusher for every kinematic entity, in entity order.
    pub(super) fn advance_kinematics(&mut self) {
        let dt = self.settings.tick_interval;
        for k in 0..self.kins.len() {
            let i = self.kins[k];
            if self.ents[i].removed {
                continue;
            }
            if self.kin(i).push.think.is_some_and(|t| t <= self.tick) {
                self.kin_mut(i).push.think = None;
                self.kin_think(i);
            }
            if self.ents[i].removed || !matches!(self.ents[i].data, Data::Kin(_)) {
                continue;
            }
            if self.tick < self.kin(i).push.start_tick {
                continue;
            }
            let landing = self.fall_prepare(i);
            let p = &self.kin(i).push;
            let movetime = if p.move_done >= 0.0 { (p.move_done - p.local_time).min(dt) } else { -1.0 };
            self.perform_push(i, movetime);
            if let Some(landed) = landing {
                self.fall_finish(i, landed);
            }
        }
    }

    /// Sets this tick's fall velocity of an active `Fall` body: gravity (semi-implicit Euler, like VPhysics'
    /// integrator), limited by what is below it (world, props, solid brush entities; the player is the pusher's
    /// business). Returns Some(landed) for fall bodies.
    fn fall_prepare(&mut self, i: usize) -> Option<bool> {
        let KinKind::Fall(f) = &self.kin(i).kind else { return None };
        if !f.active || f.constrained || self.ents[i].parent.is_some() {
            return None;
        }
        let dt = self.settings.tick_interval;
        // VPhysics max speed (k_flMaxVelocity 2000 in vphysics).
        let vz = (f.vz - self.settings.gravity * dt).max(-2000.0);
        let want = -vz * dt;
        let probes = f.probes.clone();
        let hier = self.hierarchy(i);
        self.rebuild_solid();
        let b = self.ents[i].brush.as_ref()?;
        let t = xf(b.origin, b.angles);
        let point = Hull { mins: [0.0; 3], maxs: [0.0; 3] };
        let mut drop = want;
        let scene = self.scene(0.0);
        for &p in probes.iter() {
            let Ok(w) = t.transform_point(p) else { continue };
            // From just inside the body (a probe exactly on a resting surface would start solid).
            let start = [w[0], w[1], w[2] + 1.0];
            let end = [w[0], w[1], w[2] - drop];
            let Ok(r) = scene.trace_filtered(start, end, point, playsrc_collision::MASK_SOLID, &hier) else { continue };
            if r.start_solid {
                continue;
            }
            if r.fraction < 1.0 {
                drop = drop.min(((start[2] - r.end[2]) - 1.0).max(0.0));
            }
        }
        let landed = drop < want;
        let dz = -drop;
        if let KinKind::Fall(f) = &mut self.kin_mut(i).kind {
            f.vz = vz;
        }
        let p = &mut self.kin_mut(i).push;
        p.velocity = [0.0, 0.0, dz / dt];
        p.move_done = p.local_time + 1.0e6;
        Some(landed)
    }

    fn fall_finish(&mut self, i: usize, landed: bool) {
        if let KinKind::Fall(f) = &mut self.kin_mut(i).kind {
            if landed {
                f.vz = 0.0;
            }
        }
        let p = &mut self.kin_mut(i).push;
        p.velocity = [0.0; 3];
        p.move_done = -1.0;
        self.fall_touch_triggers(i);
    }

    /// Contact probes of every falling body (see `Fall::probes`), from the collision brushes of its model.
    pub(super) fn init_fall_probes(&mut self) {
        const HOLDERS: [&str; 10] = [
            "phys_hinge", "phys_ballsocket", "phys_lengthconstraint", "phys_pulleyconstraint", "phys_constraint",
            "phys_slideconstraint", "phys_ragdollconstraint", "phys_spring", "phys_thruster", "phys_torque",
        ];
        let mut held: Vec<String> = Vec::new();
        for e in &self.entities {
            if HOLDERS.iter().any(|c| e.classname().eq_ignore_ascii_case(c)) {
                for key in ["attach1", "attach2"] {
                    if let Some(n) = e.get(key).filter(|n| !n.is_empty()) {
                        held.push(n.to_string());
                    }
                }
            }
        }
        for i in 0..self.ents.len() {
            let name = self.ents[i].name.clone();
            let constrained = !name.is_empty() && held.iter().any(|h| name_matches(h, &name));
            if let Data::Kin(k) = &mut self.ents[i].data {
                if let KinKind::Fall(f) = &mut k.kind {
                    f.constrained = constrained;
                }
            }
        }
        for i in 0..self.ents.len() {
            let Data::Kin(k) = &self.ents[i].data else { continue };
            if !matches!(k.kind, KinKind::Fall(_)) {
                continue;
            }
            let Some(model) = self.ents[i].brush.as_ref().map(|b| b.model) else { continue };
            let probes = std::rc::Rc::new(brush_probes(&self.world, model));
            if let KinKind::Fall(f) = &mut self.kin_mut(i).kind {
                f.probes = probes;
            }
        }
    }

    /// World AABB of a brush entity from its rotated model bounds (no padding).
    pub(super) fn tight_bounds(&self, i: usize) -> Option<([f32; 3], [f32; 3])> {
        let b = self.ents[i].brush.as_ref()?;
        let t = xf(b.origin, b.angles);
        let (mut lo, mut hi) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
        for c in 0..8 {
            let corner = [0, 1, 2].map(|k| if c >> k & 1 != 0 { b.maxs[k] } else { b.mins[k] });
            let w = t.transform_point(corner).ok()?;
            for k in 0..3 {
                lo[k] = lo[k].min(w[k]);
                hi[k] = hi[k].max(w[k]);
            }
        }
        Some((lo, hi))
    }

    /// Physics objects touch triggers with SF_TRIGGER_ALLOW_PHYSICS (8): StartTouch (OnStartTouch, OnTrigger) when
    /// its bounds first overlap the trigger's, EndTouch when they stop; the physbox is the activator.
    fn fall_touch_triggers(&mut self, i: usize) {
        let Some((lo, hi)) = self.tight_bounds(i) else { return };
        let mut now = Vec::new();
        for k in 0..self.triggers.len() {
            let t = self.triggers[k];
            let e = &self.ents[t];
            let Data::Trigger(tr) = &e.data else { continue };
            if e.removed || !tr.enabled || tr.spawnflags & 8 == 0 || tr.filter.is_some() {
                continue;
            }
            let Some((tlo, thi)) = self.tight_bounds(t) else { continue };
            if (0..3).all(|k| lo[k] < thi[k] && hi[k] > tlo[k]) {
                now.push(t);
            }
        }
        let before = match &self.kin(i).kind {
            KinKind::Fall(f) => f.touching.clone(),
            _ => return,
        };
        for &t in &now {
            if !before.contains(&t) {
                self.fire_output(t, "onstarttouch", Actor::Entity(i));
                self.fire_output(t, "ontrigger", Actor::Entity(i));
            }
        }
        for &t in &before {
            if !now.contains(&t) {
                self.fire_output(t, "onendtouch", Actor::Entity(i));
            }
        }
        if let KinKind::Fall(f) = &mut self.kin_mut(i).kind {
            f.touching = now;
        }
    }

    /// CBaseEntity::PerformPush.
    fn perform_push(&mut self, i: usize, movetime: f32) {
        if movetime > 0.0 {
            let prev_blocked = self.kin(i).push.blocked;
            let (vel, avel) = (self.kin(i).push.velocity, self.kin(i).push.avelocity);
            let blocked = if !is_zero(avel) {
                if !is_zero(vel) {
                    let initial = self.kin(i).push.local_time;
                    let mut b = self.push_rotate(i, movetime);
                    if !b {
                        let rotate_time = self.kin(i).push.local_time;
                        self.kin_mut(i).push.local_time = initial;
                        b = self.push_move(i, movetime);
                        let p = &mut self.kin_mut(i).push;
                        if p.local_time < rotate_time {
                            p.local_time = rotate_time;
                        }
                    }
                    b
                } else {
                    self.push_rotate(i, movetime)
                }
            } else {
                self.push_move(i, movetime)
            };
            self.kin_mut(i).push.blocked = blocked;
            if blocked != prev_blocked {
                if prev_blocked {
                    self.kin_end_blocked(i);
                }
                if blocked {
                    self.kin_start_blocked(i);
                }
            }
            if blocked {
                self.kin_blocked(i);
            }
        }
        if !matches!(self.ents[i].data, Data::Kin(_)) {
            return;
        }
        let p = &mut self.kin_mut(i).push;
        if p.move_done <= p.local_time && p.move_done > 0.0 {
            p.move_done = -1.0;
            self.kin_move_done(i);
        }
    }

    /// CBaseEntity::PhysicsPushMove. Returns true when blocked.
    fn push_move(&mut self, i: usize, movetime: f32) -> bool {
        self.kin_mut(i).push.local_time += movetime;
        if is_zero(self.kin(i).push.velocity) {
            return false;
        }
        let blocked = self.pusher_push(i, movetime, false);
        if blocked {
            self.kin_mut(i).push.local_time -= movetime;
        }
        blocked
    }

    /// CBaseEntity::PhysicsPushRotate. Returns true when blocked.
    fn push_rotate(&mut self, i: usize, movetime: f32) -> bool {
        self.kin_mut(i).push.local_time += movetime;
        if is_zero(self.kin(i).push.avelocity) {
            return false;
        }
        let blocked = self.pusher_push(i, movetime, true);
        if blocked {
            self.kin_mut(i).push.local_time -= movetime;
        }
        blocked
    }

    /// CPhysicsPushedEntities::PerformRotatePush / PerformLinearPush with the player as the only
    /// pushable entity. Moves the root, then pushes the player if it stands on the hierarchy or
    /// overlaps a solid member at its new transform. Returns true (everything restored) if the
    /// player blocks the move.
    fn pusher_push(&mut self, root: usize, movetime: f32, rotate: bool) -> bool {
        let start_abs = xf(self.ents[root].origin, self.ents[root].angles);
        let (start_local_origin, start_local_angles) = (self.ents[root].local_origin, self.ents[root].local_angles);
        let (vel, avel) = (self.kin(root).push.velocity, self.kin(root).push.avelocity);
        let amove = v_scale(avel, movetime);
        // Motors rotate about their hinge, which isn't the object's origin.
        if let KinKind::Motor(m) = &mut self.kin_mut(root).kind {
            m.angle += amove[1];
            let (origin, angles) = motor_transform(m);
            self.ents[root].local_origin = origin;
            self.ents[root].local_angles = angles;
        } else if rotate {
            self.ents[root].local_angles = v_add(start_local_angles, amove);
        } else {
            self.ents[root].local_origin = v_add(start_local_origin, v_scale(vel, movetime));
        }
        self.relink(root);
        let end_abs = xf(self.ents[root].origin, self.ents[root].angles);
        let abs_push = if rotate { [0.0; 3] } else { v_scale(self.abs_velocity(root), movetime) };

        let restore = |game: &mut Game| {
            if let KinKind::Motor(m) = &mut game.kin_mut(root).kind {
                m.angle -= amove[1];
            }
            game.ents[root].local_origin = start_local_origin;
            game.ents[root].local_angles = start_local_angles;
            game.relink(root);
        };

        let hier = self.hierarchy(root);
        let solid: Vec<usize> = hier
            .iter()
            .copied()
            .filter(|&j| self.ents[j].solid && !self.ents[j].removed && (self.ents[j].brush.is_some() || self.ents[j].prop.is_some()))
            .collect();
        if solid.is_empty() {
            return false;
        }
        let hull = self.current_hull();
        let mask = self.config.solid_mask;
        let p = self.state.position;
        let standing = self.state.ground.and_then(|g| g.support).and_then(hit_entity).is_some_and(|g| hier.contains(&g));
        let overlaps = |game: &Game, at: [f32; 3]| solid.iter().any(|&j| game.ent_overlaps(j, at, hull));
        if !standing && !overlaps(self, p) {
            return false;
        }
        let push = if rotate {
            // ComputeRotationalPushDirection: the point rotated with the pusher is the player's collision
            // origin, except for SOLID_VPHYSICS roots (most func_rotating, func_door_rotating), where Source
            // "uses move dir to guess which corner of the box determines contact": the AABB corner picked by
            // the sign of the push vector, which on the first (only) pushed entity is the still-zero local
            // `vecAbsPush`, so always the mins corner. The real engine shows exactly this (tools/parity
            // eject_ride: the rider orbits 1.06 deg/tick on a 0.8 deg/tick fan and drifts outward).
            let vphysics_root = self.ents[root].brush.as_ref().map_or(self.ents[root].prop.is_some(), |b| b.vphysics);
            let start = if vphysics_root { v_add(p, hull.mins) } else { p };
            let local = start_abs.inverse_transform_point(start).unwrap_or(start);
            v_sub(end_abs.transform_point(local).unwrap_or(start), start)
        } else {
            abs_push
        };
        self.rebuild_solid();
        let unblockable = self.kin(root).push.unblockable;
        let dest = v_add(p, push);
        let trace = self.scene(0.0).trace_filtered(p, dest, hull, mask, &hier).ok();
        let mut pos = p;
        if unblockable {
            pos = dest;
        } else if let Some(t) = &trace {
            if t.fraction != 0.0 {
                pos = t.end;
            }
        }
        let fraction = trace.as_ref().map_or(0.0, |t| t.fraction);
        let valid = |game: &Game, at: [f32; 3]| {
            game.scene(0.0).trace_filtered(at, at, hull, mask, &[]).is_ok_and(|t| !t.start_solid)
        };
        let accepted = if !unblockable && !rotate && fraction == 1.0 {
            true
        } else if valid(self, pos) {
            true
        } else if unblockable {
            // "if the player is blocking the train try nudging him around to fix accumulated error"
            let basis = |k: usize| end_abs_axis(end_abs, k);
            let mut found = None;
            for check in 0..4 {
                let factor = if check & 1 != 0 { -0.5 } else { 0.5 };
                let q = v_add(pos, v_scale(basis(check >> 1), factor));
                if valid(self, q) {
                    found = Some(q);
                    break;
                }
            }
            pos = found.unwrap_or(dest);
            true
        } else {
            false
        };
        if !accepted {
            restore(self);
            return true;
        }
        if pos != p {
            self.state.position = pos;
        }
        if rotate && self.kin(root).push.fixangle {
            // FinishRotPushedEntity: pl.fixangle = FIXANGLE_RELATIVE; pl.anglechange += amove.
            for k in 0..3 {
                self.view_angle_change[k] += amove[k];
            }
            self.events |= EVENT_ANGLES_CHANGED;
        }
        false
    }

    // -------------------------------------------------------------- dispatch

    fn kin_think(&mut self, i: usize) {
        let kind = &self.kin(i).kind;
        match kind {
            KinKind::Rotating(_) => self.rotating_use(i),
            KinKind::Train(t) => match t.think {
                TrainThink::Find => self.train_find(i),
                TrainThink::Next => self.train_next(i),
                TrainThink::None => {}
            },
            KinKind::Motor(_) => self.motor_think(i),
            KinKind::PropDoor(_) => self.prop_door_anim_think(i),
            KinKind::RotButton(b) => {
                if b.return_think {
                    self.rot_button_return(i);
                }
            }
            _ => {}
        }
    }

    fn kin_move_done(&mut self, i: usize) {
        match &self.kin(i).kind {
            KinKind::Rotating(r) => match r.done {
                RotDone::SpinUp => self.rotating_spin_up(i),
                RotDone::SpinDown => self.rotating_spin_down_move(i),
                RotDone::Reverse => self.rotating_reverse_move(i),
                RotDone::Rotate => self.rotating_rotate_move(i),
                RotDone::None => {}
            },
            KinKind::RotDoor(_) => {
                self.toggle_move_done(i);
                let done = match &self.kin(i).kind {
                    KinKind::RotDoor(d) => d.done,
                    _ => DoorDone::None,
                };
                match done {
                    DoorDone::HitTop => self.door_hit_top(i),
                    DoorDone::HitBottom => self.door_hit_bottom(i),
                    DoorDone::GoDown => self.door_go_down(i),
                    DoorDone::None => {}
                }
            }
            KinKind::MoveLinear(_) => self.movelinear_move_done(i),
            KinKind::Train(t) => {
                if t.done == TrainDone::DeadEnd {
                    self.train_dead_end(i);
                }
            }
            KinKind::Motor(_) => {}
            KinKind::PropDoor(_) => self.prop_door_move_done(i),
            KinKind::RotButton(_) => self.rot_button_move_done(i),
            KinKind::Fall(_) => {}
        }
    }

    fn kin_start_blocked(&mut self, i: usize) {
        match &self.kin(i).kind {
            KinKind::RotDoor(d) => {
                let event = if d.state == Toggle::GoingDown { "onblockedclosing" } else { "onblockedopening" };
                self.fire_output(i, event, Actor::Player);
            }
            KinKind::PropDoor(_) => self.prop_door_start_blocked(i),
            _ => {}
        }
    }

    fn kin_end_blocked(&mut self, i: usize) {
        match &self.kin(i).kind {
            KinKind::RotDoor(d) => {
                let event = if d.state == Toggle::GoingDown { "onunblockedclosing" } else { "onunblockedopening" };
                self.fire_output(i, event, Actor::Entity(i));
            }
            KinKind::PropDoor(_) => self.prop_door_end_blocked(i),
            _ => {}
        }
    }

    /// `Blocked(player)` of each class.
    fn kin_blocked(&mut self, i: usize) {
        match &self.kin(i).kind {
            KinKind::Rotating(r) => {
                let dmg = r.block_damage;
                self.damage_player(dmg);
            }
            KinKind::RotDoor(_) => self.door_blocked(i),
            KinKind::MoveLinear(m) => {
                let dmg = m.block_damage;
                if dmg != 0.0 {
                    self.damage_player(dmg);
                }
            }
            KinKind::Train(t) => {
                if t.tank {
                    return;
                }
                let (speed, dmg) = (t.speed, t.block_damage);
                let on_this = self.state.ground.and_then(|g| g.support).and_then(hit_entity) == Some(i);
                if on_this {
                    let delta = speed.abs().min(50.0);
                    if self.state.velocity[2] == 0.0 {
                        self.state.velocity[2] += delta;
                    }
                    return;
                }
                let away = normalized(v_sub(self.state.position, self.ents[i].origin));
                self.state.velocity = v_scale(away, dmg);
                if self.kin(i).push.unblockable {
                    return;
                }
                if dmg > 0.0 {
                    self.damage_player(dmg);
                }
            }
            KinKind::Motor(_) | KinKind::PropDoor(_) | KinKind::RotButton(_) | KinKind::Fall(_) => {}
        }
    }

    /// CTakeDamageInfo(DMG_CRUSH) on the player.
    pub(super) fn damage_player(&mut self, amount: f32) {
        if amount <= 0.0 || !amount.is_finite() {
            return;
        }
        self.health -= amount;
        if self.health <= 0.0 {
            self.die();
        }
    }

    /// Inputs of the kinematic classes. Returns true if handled.
    pub(super) fn kin_input(&mut self, i: usize, input: &str, param: &str, activator: Actor) -> bool {
        let value = || param.trim().parse::<f32>().unwrap_or(0.0);
        match &self.kin(i).kind {
            KinKind::Rotating(_) => {
                match input {
                    "setspeed" => {
                        let v = value();
                        let r = self.rotating_mut(i);
                        r.stop_at_start = false;
                        r.reversed = v < 0.0;
                        let target = v.abs().clamp(0.0, 1.0) * r.max_speed;
                        self.rotating_set_target_speed(i, target);
                    }
                    "start" => {
                        self.rotating_mut(i).stop_at_start = false;
                        let max = self.rotating_mut(i).max_speed;
                        self.rotating_set_target_speed(i, max);
                    }
                    "startforward" => {
                        self.rotating_mut(i).reversed = false;
                        let max = self.rotating_mut(i).max_speed;
                        self.rotating_set_target_speed(i, max);
                    }
                    "startbackward" => {
                        let r = self.rotating_mut(i);
                        r.stop_at_start = false;
                        r.reversed = true;
                        let max = r.max_speed;
                        self.rotating_set_target_speed(i, max);
                    }
                    "stop" => {
                        self.rotating_mut(i).stop_at_start = false;
                        self.rotating_set_target_speed(i, 0.0);
                    }
                    "stopatstartpos" => {
                        self.rotating_mut(i).stop_at_start = true;
                        self.rotating_set_target_speed(i, 0.0);
                        let next = self.rotating_next_interval(i);
                        self.set_move_done_time(i, next);
                    }
                    "toggle" => {
                        let r = self.rotating_mut(i);
                        let target = if r.speed > 0.0 { 0.0 } else { r.max_speed };
                        self.rotating_set_target_speed(i, target);
                    }
                    "reverse" => {
                        let r = self.rotating_mut(i);
                        r.stop_at_start = false;
                        r.reversed = !r.reversed;
                        let s = r.speed;
                        self.rotating_set_target_speed(i, s);
                    }
                    "use" => self.rotating_use(i),
                    _ => return false,
                }
                true
            }
            KinKind::RotDoor(_) => {
                match input {
                    "open" => {
                        let d = self.door(i);
                        if d.state != Toggle::AtTop && d.state != Toggle::GoingUp && !d.locked {
                            self.door_go_up(i);
                        }
                    }
                    "close" => {
                        if self.door(i).state != Toggle::AtBottom {
                            self.door_go_down(i);
                        }
                    }
                    "toggle" => {
                        let d = self.door(i);
                        if !d.locked {
                            match d.state {
                                Toggle::AtBottom => self.door_go_up(i),
                                Toggle::AtTop => self.door_go_down(i),
                                _ => {}
                            }
                        }
                    }
                    "lock" => self.door_mut(i).locked = true,
                    "unlock" => self.door_mut(i).locked = false,
                    "setspeed" => self.door_mut(i).speed = value(),
                    "use" => {
                        // CBaseDoor::Use: a player activator needs SF_DOOR_PUSE (256).
                        if activator == Actor::Player && self.door(i).spawnflags & 256 == 0 {
                            return true;
                        }
                        if activator == Actor::Player {
                            self.door_mut(i).activator_player = true;
                        }
                        let d = self.door(i);
                        let allow = d.state == Toggle::AtBottom || (d.spawnflags & SF_DOOR_NO_AUTO_RETURN != 0 && d.state == Toggle::AtTop);
                        if allow {
                            if self.door(i).locked {
                                self.fire_output(i, "onlockeduse", activator);
                            } else {
                                self.door_activate(i);
                            }
                        }
                    }
                    _ => return false,
                }
                true
            }
            KinKind::MoveLinear(_) => {
                match input {
                    "open" => {
                        let (pos2, speed) = (self.movelinear(i).pos2, self.movelinear(i).speed);
                        if self.ents[i].local_origin != pos2 {
                            self.movelinear_move_to(i, pos2, speed);
                        }
                    }
                    "close" => {
                        let (pos1, speed) = (self.movelinear(i).pos1, self.movelinear(i).speed);
                        if self.ents[i].local_origin != pos1 {
                            self.movelinear_move_to(i, pos1, speed);
                        }
                    }
                    "setposition" => {
                        let m = self.movelinear(i);
                        let target = v_add(m.pos1, v_scale(v_sub(m.pos2, m.pos1), value()));
                        let speed = m.speed;
                        if v_len(v_sub(target, self.ents[i].local_origin)) > 0.001 {
                            self.movelinear_move_to(i, target, speed);
                        }
                    }
                    "setspeed" => {
                        let v = value();
                        let m = self.movelinear_mut(i);
                        m.speed = v;
                        let dest = m.final_dest;
                        let d = v_sub(dest, self.ents[i].origin);
                        if v_dot(d, d) > f32::EPSILON * f32::EPSILON {
                            self.linear_move(i, dest, v);
                        }
                    }
                    _ => return false,
                }
                true
            }
            KinKind::Train(_) => {
                match input {
                    "stop" => self.train_stop(i),
                    "resume" => {
                        let t = self.train_mut(i);
                        t.speed = t.old_speed;
                        self.train_start(i, activator);
                    }
                    "reverse" => {
                        let forward = self.train(i).dir == 1.0;
                        self.train_set_dir(i, !forward);
                        let s = self.train(i).speed;
                        self.train_set_speed(i, s, false);
                    }
                    "startforward" => {
                        self.train_set_dir(i, true);
                        let s = self.train(i).max_speed;
                        self.train_set_speed(i, s, false);
                    }
                    "startbackward" => {
                        self.train_set_dir(i, false);
                        let s = self.train(i).max_speed;
                        self.train_set_speed(i, s, false);
                    }
                    "toggle" => {
                        let t = self.train(i);
                        let s = if t.speed == 0.0 { t.max_speed } else { 0.0 };
                        self.train_set_speed(i, s, false);
                    }
                    "setspeed" => {
                        let s = self.train(i).max_speed * value().clamp(0.0, 1.0);
                        self.train_set_speed(i, s, false);
                    }
                    "setspeedreal" => {
                        let s = value().clamp(0.0, self.train(i).max_speed);
                        self.train_set_speed(i, s, false);
                    }
                    "setspeeddir" | "setspeeddiraccel" => {
                        let v = value();
                        self.train_set_dir(i, v >= 0.0);
                        let s = self.train(i).max_speed * v.abs().clamp(0.0, 1.0);
                        self.train_set_speed(i, s, input == "setspeeddiraccel");
                    }
                    "setspeedforwardmodifier" => {
                        let t = self.train_mut(i);
                        t.fwd_modifier = value().abs().clamp(0.0, 1.0);
                        let s = t.unmodified_desired;
                        self.train_set_speed(i, s, true);
                    }
                    "teleporttopathtrack" => {
                        if let Some(p) = self.find_named(param.trim()).filter(|&p| self.path(p).is_some()) {
                            self.train_teleport_to_path(i, p);
                            self.train_mut(i).path = Some(p);
                        }
                    }
                    _ => return false,
                }
                true
            }
            KinKind::Motor(_) => false,
            KinKind::PropDoor(_) => self.prop_door_input(i, input, param, activator),
            KinKind::RotButton(_) => self.rot_button_input(i, input, activator),
            KinKind::Fall(f) => {
                let active = match input {
                    // CPhysBox::InputEnableMotion / InputWake / InputDisableMotion / InputSleep.
                    "enablemotion" | "wake" => true,
                    "disablemotion" | "sleep" => false,
                    _ => return false,
                };
                if active != f.active {
                    if let KinKind::Fall(f) = &mut self.kin_mut(i).kind {
                        f.active = active;
                        f.vz = 0.0;
                    }
                    // A woken body that was carrying no hierarchy stays where it is until gravity moves it.
                    let p = &mut self.kin_mut(i).push;
                    p.velocity = [0.0; 3];
                    p.move_done = -1.0;
                }
                true
            }
        }
    }

    /// phys_motor inputs (routed by the motor's name to its attached object).
    pub(super) fn motor_input(&mut self, i: usize, input: &str, param: &str) {
        match input {
            "turnon" => self.motor_turn_on(i),
            "turnoff" => {
                let m = self.motor_mut(i);
                m.speed = 0.0;
                m.on = false;
                self.kin_mut(i).push.think = None;
                self.motor_apply_speed(i);
            }
            "setspeed" => {
                let v = param.trim().parse::<f32>().unwrap_or(0.0);
                let m = self.motor_mut(i);
                if m.target != v {
                    m.target = v;
                    m.accel = m.target.abs(); // CalculateAcceleration with spinup kept at its spawn ratio below
                    self.kin_mut(i).push.think = Some(self.tick);
                }
            }
            _ => {}
        }
    }

    // -------------------------------------------------------------- move helpers

    fn set_move_done_time(&mut self, i: usize, delay: f32) {
        let p = &mut self.kin_mut(i).push;
        p.move_done = if delay >= 0.0 { p.local_time + delay } else { -1.0 };
    }

    /// CBaseToggle::LinearMove.
    fn linear_move(&mut self, i: usize, dest: [f32; 3], speed: f32) {
        if let KinKind::MoveLinear(m) = &mut self.kin_mut(i).kind {
            m.final_dest = dest;
            m.linear = true;
        }
        if dest == self.ents[i].local_origin {
            self.toggle_move_done(i);
            self.kin_move_done_callback(i);
            return;
        }
        let delta = v_sub(dest, self.ents[i].local_origin);
        let travel = v_len(delta) / speed;
        self.set_move_done_time(i, travel);
        self.kin_mut(i).push.velocity = v_scale(delta, 1.0 / travel);
    }

    /// A move started inside the player's +use waits for the next frame (`Push::start_tick`).
    pub(super) fn defer_if_in_use(&mut self, i: usize) {
        if self.in_use {
            let t = self.tick + 1;
            self.kin_mut(i).push.start_tick = t;
        }
    }

    /// CBaseToggle::AngularMove.
    fn angular_move(&mut self, i: usize, dest: [f32; 3], speed: f32) {
        self.defer_if_in_use(i);
        if let KinKind::RotDoor(d) = &mut self.kin_mut(i).kind {
            d.final_angle = dest;
            d.angular = true;
        }
        if dest == self.ents[i].local_angles {
            self.toggle_move_done(i);
            self.kin_move_done_callback(i);
            return;
        }
        let delta = v_sub(dest, self.ents[i].local_angles);
        let mut travel = v_len(delta) / speed;
        if travel < 0.01 {
            travel = 0.01;
        }
        self.set_move_done_time(i, travel);
        self.kin_mut(i).push.avelocity = v_scale(delta, (1.0f64 / travel as f64) as f32);
    }

    /// CBaseToggle::MoveDone, movement part (LinearMoveDone / AngularMoveDone).
    fn toggle_move_done(&mut self, i: usize) {
        match &mut self.kin_mut(i).kind {
            KinKind::RotDoor(d) if d.angular => {
                d.angular = false;
                let a = d.final_angle;
                self.ents[i].local_angles = a;
                let p = &mut self.kin_mut(i).push;
                p.avelocity = [0.0; 3];
                p.move_done = -1.0;
                self.relink(i);
            }
            KinKind::MoveLinear(m) if m.linear => {
                m.linear = false;
                let o = m.final_dest;
                self.ents[i].local_origin = o;
                let p = &mut self.kin_mut(i).push;
                p.velocity = [0.0; 3];
                p.move_done = -1.0;
                self.relink(i);
            }
            _ => {}
        }
    }

    /// The class `m_pfnMoveDone` after an immediate (zero-length) move.
    fn kin_move_done_callback(&mut self, i: usize) {
        match &self.kin(i).kind {
            KinKind::RotDoor(d) => match d.done {
                DoorDone::HitTop => self.door_hit_top(i),
                DoorDone::HitBottom => self.door_hit_bottom(i),
                DoorDone::GoDown => self.door_go_down(i),
                DoorDone::None => {}
            },
            KinKind::MoveLinear(_) => self.movelinear_outputs(i),
            _ => {}
        }
    }

    // -------------------------------------------------------------- func_rotating

    fn rotating_mut(&mut self, i: usize) -> &mut Rotating {
        match &mut self.kin_mut(i).kind {
            KinKind::Rotating(r) => r,
            _ => unreachable!(),
        }
    }

    fn rotating_next_interval(&mut self, i: usize) -> f32 {
        if self.rotating_mut(i).stop_at_start { self.settings.tick_interval } else { 0.1 }
    }

    fn rotating_use(&mut self, i: usize) {
        let r = self.rotating_mut(i);
        let target = if r.speed != 0.0 { 0.0 } else { r.max_speed };
        self.rotating_set_target_speed(i, target);
    }

    /// CFuncRotating::UpdateSpeed.
    fn rotating_update_speed(&mut self, i: usize, new_speed: f32) {
        let local = self.ents[i].local_angles;
        let dt = self.settings.tick_interval;
        let r = self.rotating_mut(i);
        let old = r.speed;
        r.speed = new_speed.clamp(-r.max_speed, r.max_speed);
        let mut snap = None;
        if r.stop_at_start {
            let axis = if r.move_ang[0] != 0.0 { 0 } else if r.move_ang[1] != 0.0 { 1 } else { 2 };
            let mut delta = anglemod(local[axis] - r.ang_start[axis]);
            if delta > 180.0 {
                delta -= 360.0;
            }
            if new_speed < 100.0 {
                if new_speed <= 25.0 && delta.abs() < 1.0 {
                    r.target_speed = 0.0;
                    r.stop_at_start = false;
                    r.speed = 0.0;
                    snap = Some(r.ang_start);
                } else if delta.abs() > 90.0 {
                    r.speed = old;
                } else {
                    let min = delta.abs().max(20.0);
                    r.speed = if old > 0.0 { min } else { -min };
                }
            }
        }
        let avel = v_scale(r.move_ang, r.speed);
        let _ = dt;
        self.kin_mut(i).push.avelocity = avel;
        if let Some(a) = snap {
            self.ents[i].local_angles = a;
            self.relink(i);
        }
    }

    /// CFuncRotating::SetTargetSpeed.
    fn rotating_set_target_speed(&mut self, i: usize, speed: f32) {
        let r = self.rotating_mut(i);
        let mut speed = speed.abs();
        if r.reversed {
            speed = -speed;
        }
        r.target_speed = speed;
        if !r.accdcc {
            self.rotating_update_speed(i, speed);
            self.rotating_mut(i).done = RotDone::Rotate;
        } else {
            let r = self.rotating_mut(i);
            r.done = if (r.speed > 0.0 && r.target_speed < 0.0) || (r.speed < 0.0 && r.target_speed > 0.0) {
                RotDone::Reverse
            } else if r.speed.abs() < r.target_speed.abs() {
                RotDone::SpinUp
            } else if r.speed.abs() > r.target_speed.abs() {
                RotDone::SpinDown
            } else {
                RotDone::Rotate
            };
        }
        let next = self.rotating_next_interval(i);
        self.set_move_done_time(i, next);
    }

    /// CFuncRotating::SpinUpMove.
    fn rotating_spin_up(&mut self, i: usize) {
        let r = self.rotating_mut(i);
        let mut done = false;
        let mut new = (r.speed.abs() as f64 + 0.2 * r.max_speed as f64 * r.fan_friction as f64) as f32;
        if new.abs() >= r.target_speed.abs() {
            new = r.target_speed;
            done = !r.stop_at_start;
        } else if r.target_speed < 0.0 {
            new = -new;
        }
        self.rotating_update_speed(i, new);
        if done {
            self.rotating_mut(i).done = RotDone::Rotate;
            self.rotating_rotate_move(i);
        }
        let next = self.rotating_next_interval(i);
        self.set_move_done_time(i, next);
    }

    /// CFuncRotating::SpinDown.
    fn rotating_spin_down(&mut self, i: usize, target: f32) -> bool {
        let r = self.rotating_mut(i);
        let mut done = false;
        let mut new = (r.speed.abs() as f64 - 0.1 * r.max_speed as f64 * r.fan_friction as f64) as f32;
        if new < 0.0 {
            new = 0.0;
        }
        if new.abs() <= target.abs() {
            new = target;
            done = !r.stop_at_start;
        } else if r.speed < 0.0 {
            new = -new;
        }
        self.rotating_update_speed(i, new);
        done
    }

    fn rotating_spin_down_move(&mut self, i: usize) {
        let target = self.rotating_mut(i).target_speed;
        if self.rotating_spin_down(i, target) {
            self.rotating_mut(i).done = RotDone::Rotate;
            self.rotating_rotate_move(i);
        } else {
            let next = self.rotating_next_interval(i);
            self.set_move_done_time(i, next);
        }
    }

    fn rotating_reverse_move(&mut self, i: usize) {
        if self.rotating_spin_down(i, 0.0) {
            let target = self.rotating_mut(i).target_speed;
            self.rotating_set_target_speed(i, target);
        } else {
            let next = self.rotating_next_interval(i);
            self.set_move_done_time(i, next);
        }
    }

    /// CFuncRotating::RotateMove.
    fn rotating_rotate_move(&mut self, i: usize) {
        self.set_move_done_time(i, 10.0);
        if !self.rotating_mut(i).stop_at_start {
            return;
        }
        let next = self.rotating_next_interval(i);
        self.set_move_done_time(i, next);
        let local = self.ents[i].local_angles;
        let avel = self.kin(i).push.avelocity;
        let dt = self.settings.tick_interval;
        let r = self.rotating_mut(i);
        let axis = if r.move_ang[0] != 0.0 { 0 } else if r.move_ang[1] != 0.0 { 1 } else { 2 };
        let mut delta = anglemod(local[axis] - r.ang_start[axis]);
        if delta > 180.0 {
            delta -= 360.0;
        }
        if delta.abs() < (avel[axis] * dt).abs() {
            let start = r.ang_start;
            self.rotating_set_target_speed(i, 0.0);
            self.ents[i].local_angles = start;
            self.relink(i);
            self.rotating_mut(i).stop_at_start = false;
        }
    }

    /// CFuncRotating::HurtTouch (SF_BRUSH_HURT).
    pub(super) fn rotating_hurt_touch(&mut self, i: usize) {
        let damage = v_len(self.kin(i).push.avelocity) / 10.0;
        self.rotating_mut(i).block_damage = damage;
        self.damage_player(damage);
        let center = self.ents[i]
            .brush
            .as_ref()
            .map(|b| {
                let (lo, hi) = b.world_bounds();
                [(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5, (lo[2] + hi[2]) * 0.5]
            })
            .unwrap_or(self.ents[i].origin);
        let dir = normalized(v_sub(self.state.position, center));
        self.state.velocity = v_scale(dir, damage);
    }

    // -------------------------------------------------------------- func_door_rotating

    fn door(&self, i: usize) -> &RotDoor {
        match &self.kin(i).kind {
            KinKind::RotDoor(d) => d,
            _ => unreachable!(),
        }
    }

    fn door_mut(&mut self, i: usize) -> &mut RotDoor {
        match &mut self.kin_mut(i).kind {
            KinKind::RotDoor(d) => d,
            _ => unreachable!(),
        }
    }

    /// CBaseDoor::DoorTouch for a player touching the door.
    pub(super) fn door_touch(&mut self, i: usize) {
        let d = self.door(i);
        if !d.touchable || d.spawnflags & SF_DOOR_PTOUCH == 0 {
            return;
        }
        if d.locked {
            self.fire_output(i, "onlockeduse", Actor::Player);
            return;
        }
        self.door_mut(i).activator_player = true;
        if self.door_activate(i) {
            self.door_mut(i).touchable = false;
        }
    }

    /// CBaseDoor::DoorActivate.
    fn door_activate(&mut self, i: usize) -> bool {
        let d = self.door(i);
        if d.spawnflags & SF_DOOR_NO_AUTO_RETURN != 0 && d.state == Toggle::AtTop {
            self.door_go_down(i);
        } else if d.state != Toggle::AtTop && d.state != Toggle::GoingUp {
            self.door_go_up(i);
        }
        true
    }

    /// CBaseDoor::DoorGoUp (rotating).
    fn door_go_up(&mut self, i: usize) {
        self.door_mut(i).state = Toggle::GoingUp;
        self.door_mut(i).done = DoorDone::HitTop;
        let mut sign = 1.0;
        let d = self.door(i);
        if d.activator_player && d.spawnflags & SF_DOOR_ONEWAY == 0 && d.move_ang[1] != 0.0 {
            // "Point right hand at door hinge, curl hand towards closest spot on door, if thumb is up,
            // open door CW."
            let player = self.state.position;
            let t = xf(self.ents[i].origin, self.ents[i].angles);
            let local = t.inverse_transform_point(player).unwrap_or(player);
            let clamped = [0, 1, 2].map(|k| local[k].clamp(d.mins[k], d.maxs[k]));
            let nearest = t.transform_point(clamped).unwrap_or(player);
            let mut to_nearest = v_sub(nearest, player);
            to_nearest[2] = 0.0;
            let mut to_origin = v_sub(self.ents[i].origin, player);
            to_origin[2] = 0.0;
            let cross_z = to_origin[0] * to_nearest[1] - to_origin[1] * to_nearest[0];
            if cross_z > 0.0 {
                sign = -1.0;
            }
        }
        let (dest, speed) = (v_scale(self.door(i).angle2, sign), self.door(i).speed);
        self.angular_move(i, dest, speed);
        self.fire_output(i, "onopen", Actor::Entity(i));
    }

    /// CBaseDoor::DoorHitTop.
    fn door_hit_top(&mut self, i: usize) {
        let d = self.door_mut(i);
        d.state = Toggle::AtTop;
        let (no_auto, wait, start_open) =
            (d.spawnflags & SF_DOOR_NO_AUTO_RETURN != 0, d.wait, d.spawnflags & SF_DOOR_START_OPEN_OBSOLETE != 0);
        if no_auto {
            self.door_mut(i).touchable = true;
        } else {
            self.set_move_done_time(i, wait);
            self.door_mut(i).done = DoorDone::GoDown;
        }
        self.fire_output(i, if start_open { "onfullyclosed" } else { "onfullyopen" }, Actor::Entity(i));
    }

    /// CBaseDoor::DoorGoDown (rotating).
    fn door_go_down(&mut self, i: usize) {
        let d = self.door_mut(i);
        d.state = Toggle::GoingDown;
        d.done = DoorDone::HitBottom;
        let (dest, speed) = (d.angle1, d.speed);
        self.angular_move(i, dest, speed);
        self.fire_output(i, "onclose", Actor::Entity(i));
    }

    /// CBaseDoor::DoorHitBottom.
    fn door_hit_bottom(&mut self, i: usize) {
        let d = self.door_mut(i);
        d.state = Toggle::AtBottom;
        d.touchable = true;
        let start_open = d.spawnflags & SF_DOOR_START_OPEN_OBSOLETE != 0;
        let activator = if d.activator_player { Actor::Player } else { Actor::None };
        self.fire_output(i, if start_open { "onfullyopen" } else { "onfullyclosed" }, activator);
    }

    /// CBaseDoor::Blocked by the player.
    fn door_blocked(&mut self, i: usize) {
        let d = self.door(i);
        let (dmg, force_closed, wait) = (d.block_damage, d.force_closed, d.wait);
        if dmg != 0.0 {
            self.damage_player(dmg);
        }
        if force_closed {
            return;
        }
        if wait >= 0.0 {
            if self.door(i).state == Toggle::GoingDown {
                self.door_go_up(i);
            } else {
                self.door_go_down(i);
            }
        }
        // Block all door pieces with the same targetname.
        let name = self.ents[i].name.clone();
        if name.is_empty() {
            return;
        }
        let (move_ang, vel, avel, angles) = (
            self.door(i).move_ang,
            self.kin(i).push.velocity,
            self.kin(i).push.avelocity,
            self.ents[i].local_angles,
        );
        let group: Vec<usize> = (0..self.ents.len())
            .filter(|&j| j != i && !self.ents[j].removed && name_matches(&name, &self.ents[j].name))
            .filter(|&j| matches!(&self.ents[j].data, Data::Kin(k) if matches!(k.kind, KinKind::RotDoor(_))))
            .collect();
        for j in group {
            if self.door(j).wait < 0.0 {
                continue;
            }
            if self.door(j).move_ang == move_ang && self.kin(j).push.velocity == vel && self.kin(j).push.avelocity == avel {
                self.ents[j].local_angles = angles;
                self.kin_mut(j).push.avelocity = [0.0; 3];
                self.relink(j);
            }
            if self.door(j).state == Toggle::GoingDown {
                self.door_go_up(j);
            } else {
                self.door_go_down(j);
            }
        }
    }

    // -------------------------------------------------------------- func_movelinear

    fn movelinear(&self, i: usize) -> &MoveLinear {
        match &self.kin(i).kind {
            KinKind::MoveLinear(m) => m,
            _ => unreachable!(),
        }
    }

    fn movelinear_mut(&mut self, i: usize) -> &mut MoveLinear {
        match &mut self.kin_mut(i).kind {
            KinKind::MoveLinear(m) => m,
            _ => unreachable!(),
        }
    }

    fn movelinear_move_to(&mut self, i: usize, pos: [f32; 3], speed: f32) {
        if speed != 0.0 {
            self.linear_move(i, pos, speed);
        }
    }

    /// CFuncMoveLinear::MoveDone.
    fn movelinear_move_done(&mut self, i: usize) {
        self.toggle_move_done(i);
        self.movelinear_outputs(i);
    }

    fn movelinear_outputs(&mut self, i: usize) {
        let m = self.movelinear(i);
        let o = self.ents[i].origin;
        if o == m.pos2 {
            self.fire_output(i, "onfullyopen", Actor::Entity(i));
        } else if o == m.pos1 {
            self.fire_output(i, "onfullyclosed", Actor::Entity(i));
        }
    }

    // -------------------------------------------------------------- func_tracktrain

    fn train(&self, i: usize) -> &Train {
        match &self.kin(i).kind {
            KinKind::Train(t) => t,
            _ => unreachable!(),
        }
    }

    fn train_mut(&mut self, i: usize) -> &mut Train {
        match &mut self.kin_mut(i).kind {
            KinKind::Train(t) => t,
            _ => unreachable!(),
        }
    }

    fn train_set_think(&mut self, i: usize, think: TrainThink, at: Option<u32>) {
        self.train_mut(i).think = think;
        self.kin_mut(i).push.think = at;
    }

    /// Entity::Teleport for a train (no push).
    fn teleport_entity(&mut self, i: usize, origin: [f32; 3], angles: [f32; 3]) {
        self.ents[i].local_origin = origin;
        self.ents[i].local_angles = angles;
        self.relink(i);
    }

    /// CFuncTrackTrain::Find.
    fn train_find(&mut self, i: usize) {
        let target = self.train(i).target.clone();
        let Some(path) = self.find_named(&target).filter(|&p| self.path(p).is_some()) else {
            self.train_mut(i).path = None;
            return;
        };
        self.train_mut(i).path = Some(path);
        let mut next_pos = self.path_origin(path);
        let mut look = next_pos;
        let length = self.train(i).length;
        let mut nn = None;
        self.path_look_ahead(path, &mut look, length, false, &mut nn);
        let height = self.train(i).height;
        next_pos[2] += height;
        look[2] += height;
        let flags = self.train(i).spawnflags;
        let angles = if flags & SF_TRACKTRAIN_FIXED_ORIENTATION != 0 {
            self.ents[i].local_angles
        } else {
            let mut a = vector_angles(v_sub(look, next_pos));
            if flags & SF_TRACKTRAIN_NOPITCH != 0 {
                a[0] = 0.0;
            }
            a
        };
        self.teleport_entity(i, next_pos, angles);
        self.train_arrive_at_node(i, path);
        if self.train(i).speed != 0.0 {
            let at = self.tick + self.delay_ticks(0.1);
            self.train_set_think(i, TrainThink::Next, Some(at));
        }
    }

    /// Physics v14 reset (`PHYSICS_FIX_TRAIN_SPAWN`): every train still waiting for its spawn think runs `Find` now,
    /// before the map's spawn outputs, like Source's spawn-frame Find ahead of logic_auto's 0.2 s think.
    pub(super) fn find_train_paths(&mut self) {
        for k in 0..self.kins.len() {
            let i = self.kins[k];
            if self.ents[i].removed {
                continue;
            }
            let waiting = matches!(&self.kin(i).kind, KinKind::Train(t) if t.think == TrainThink::Find);
            if waiting && self.kin(i).push.think.is_some() {
                self.kin_mut(i).push.think = None;
                self.train_find(i);
            }
        }
    }

    /// CFuncTrackTrain::ArriveAtNode.
    fn train_arrive_at_node(&mut self, i: usize, node: usize) {
        // FirePassInputs(node, node->GetNext(), true): InPass on `node`.
        self.fire_output(node, "onpass", Actor::Entity(i));
        let (node_flags, node_speed) = match self.path(node) {
            Some(p) => (p.spawnflags, p.speed),
            None => return,
        };
        if node_flags & SF_PATH_DISABLE_TRAIN != 0 {
            self.train_mut(i).spawnflags |= SF_TRACKTRAIN_NOCONTROL;
        }
        if self.train(i).spawnflags & SF_TRACKTRAIN_NOCONTROL != 0 && node_speed != 0.0 {
            self.train_set_speed(i, node_speed, false);
        }
    }

    fn train_set_dir(&mut self, i: usize, forward: bool) {
        let (dir, path) = (self.train(i).dir, self.train(i).path);
        if forward && dir != 1.0 {
            if let Some(p) = path.and_then(|p| self.path_prev(p)) {
                self.train_mut(i).path = Some(p);
            }
            self.train_mut(i).dir = 1.0;
        } else if !forward && dir != -1.0 {
            if let Some(n) = path.and_then(|p| self.path_next(p)) {
                self.train_mut(i).path = Some(n);
            }
            self.train_mut(i).dir = -1.0;
        }
    }

    /// CFuncTrackTrain::SetSpeed.
    fn train_set_speed(&mut self, i: usize, speed: f32, accel: bool) {
        let t = self.train_mut(i);
        t.accel_to_speed = accel;
        t.unmodified_desired = speed;
        let old = t.speed;
        let mut speed = speed;
        if t.fwd_modifier < 1.0 && t.dir > 0.0 {
            speed *= t.fwd_modifier;
        }
        if accel {
            t.desired_speed = speed.abs() * t.dir;
            if t.speed == 0.0 && t.desired_speed.abs() > 0.0 {
                t.speed = 0.1;
            }
            self.train_start(i, Actor::Entity(i));
            return;
        }
        t.speed = speed.abs() * t.dir;
        if t.speed != old {
            if t.speed != 0.0 {
                if old == 0.0 {
                    self.train_start(i, Actor::Entity(i));
                } else {
                    self.train_next(i);
                }
            } else {
                self.train_stop(i);
            }
        }
    }

    fn train_start(&mut self, i: usize, _activator: Actor) {
        self.fire_output(i, "onstart", Actor::Entity(i));
        self.train_next(i);
    }

    /// CFuncTrackTrain::Stop.
    fn train_stop(&mut self, i: usize) {
        let p = &mut self.kin_mut(i).push;
        p.velocity = [0.0; 3];
        p.avelocity = [0.0; 3];
        let t = self.train_mut(i);
        t.old_speed = t.speed;
        t.speed = 0.0;
        self.train_set_think(i, TrainThink::None, None);
    }

    /// CFuncTrackTrain::Next (think every tick while moving).
    fn train_next(&mut self, i: usize) {
        if self.train(i).speed == 0.0 {
            return;
        }
        let Some(path) = self.train(i).path else {
            self.train_mut(i).speed = 0.0;
            return;
        };
        let height = self.train(i).height;
        let speed = self.train(i).speed;
        let mut next_pos = self.ents[i].local_origin;
        next_pos[2] -= height;
        let mut next_next = None;
        let mut next = self.path_look_ahead(path, &mut next_pos, speed * 0.1, true, &mut next_next);
        let t = self.train(i);
        if t.manual && ((speed < 0.0) != (t.desired_speed < 0.0)) && next.is_none() {
            next = Some(path);
        }
        next_pos[2] += height;
        let dt = self.settings.tick_interval;
        if let Some(n) = next {
            self.train_update_velocity(i, n, next_next, next_pos);
            self.train_update_orientation(i, n, next_next, next_pos, dt);
            if Some(n) != self.train(i).path {
                self.train_mut(i).path = Some(n);
                self.train_arrive_at_node(i, n);
                if let Some(tp) = self.path_next(n) {
                    if self.path(tp).is_some_and(|p| p.spawnflags & SF_PATH_TELEPORT != 0) {
                        self.train_teleport_to_path(i, tp);
                    }
                }
            }
            self.fire_output(i, "onnextpoint", Actor::Entity(n));
            let tick = self.tick;
            self.train_set_think(i, TrainThink::Next, Some(tick + 1));
            self.set_move_done_time(i, 0.5);
            self.train_mut(i).done = TrainDone::None;
        } else {
            // Dead end: move onto it, then stop.
            let vel = v_sub(next_pos, self.ents[i].local_origin);
            let distance = v_len(vel);
            let t = self.train_mut(i);
            t.old_speed = t.speed;
            t.speed = 0.0;
            let old = t.old_speed;
            self.kin_mut(i).push.avelocity = [0.0; 3];
            if distance > 0.0 {
                let time = distance / old.abs();
                self.kin_mut(i).push.velocity = v_scale(vel, old / distance);
                self.train_mut(i).done = TrainDone::DeadEnd;
                self.train_set_think(i, TrainThink::None, None);
                self.set_move_done_time(i, time);
            } else {
                self.kin_mut(i).push.velocity = vel;
                self.train_dead_end(i);
            }
        }
    }

    /// CFuncTrackTrain::UpdateTrainVelocity.
    fn train_update_velocity(&mut self, i: usize, prev: usize, next: Option<usize>, next_pos: [f32; 3]) {
        let origin = self.ents[i].local_origin;
        let dt = self.settings.tick_interval;
        let vtype = self.train(i).velocity_type;
        if vtype == 1 || vtype == 2 {
            let t = self.train(i);
            if t.accel_to_speed {
                let (prev_speed, next_speed) = (t.speed, t.desired_speed);
                if prev_speed != next_speed {
                    let change = if next_speed.abs() > prev_speed.abs() { t.accel } else { t.decel };
                    let s = approach(t.desired_speed, t.speed, change * dt);
                    self.train_mut(i).speed = s;
                }
            } else if let Some(next) = next {
                let prev_track = self.path(prev).map_or(0.0, |p| p.speed);
                let next_track = self.path(next).map_or(0.0, |p| p.speed);
                let mut prev_speed = t.speed;
                if prev_track != 0.0 {
                    prev_speed = prev_track;
                }
                let mut next_speed = prev_speed;
                if next_track != 0.0 {
                    next_speed = next_track;
                }
                let dir = t.dir;
                if prev_speed != next_speed {
                    let segment = v_len(v_sub(self.path_origin(next), self.path_origin(prev)));
                    if segment != 0.0 {
                        let mut p = v_len(v_sub(origin, self.path_origin(prev))) / segment;
                        if vtype == 2 {
                            p = simple_spline(p);
                        }
                        self.train_mut(i).speed = dir * (prev_speed * (1.0 - p) + next_speed * p);
                    }
                } else {
                    self.train_mut(i).speed = dir * prev_speed;
                }
            }
        }
        let speed = self.train(i).speed.abs();
        self.kin_mut(i).push.velocity = v_scale(normalized(v_sub(next_pos, origin)), speed);
    }

    /// CFuncTrackTrain::UpdateTrainOrientation.
    fn train_update_orientation(&mut self, i: usize, prev: usize, next: Option<usize>, next_pos: [f32; 3], interval: f32) {
        let t = self.train(i);
        if t.spawnflags & SF_TRACKTRAIN_FIXED_ORIENTATION != 0 {
            return;
        }
        let forward = t.dir == 1.0;
        match t.orientation_type {
            0 => {}
            1 => {
                let Some(path) = t.path else { return };
                let origin = self.ents[i].local_origin;
                let (height, length) = (t.height, t.length);
                let mut front = origin;
                front[2] -= height;
                let mut nn = None;
                let la = if length > 0.0 { if forward { length } else { -length } } else if forward { 100.0 } else { -100.0 };
                let next_node = self.path_look_ahead(path, &mut front, la, false, &mut nn);
                front[2] += height;
                let mut face = v_sub(front, origin);
                if !forward {
                    face = v_scale(face, -1.0);
                }
                let mut angles = fixup_angles(vector_angles(face));
                if self.train(i).manual {
                    if let Some(nn) = next_node.filter(|&n| self.path(n).is_some_and(|p| p.orientation_type == 2)) {
                        angles = self.path_orientation(nn, forward);
                    }
                }
                let cur = fixup_angles(self.ents[i].local_angles);
                if face[0] == 0.0 && face[1] == 0.0 {
                    angles = cur;
                }
                let _ = (prev, next_pos);
                self.train_do_update_orientation(i, cur, angles, interval);
            }
            otype => {
                let ang_prev = fixup_angles(self.path_orientation(prev, forward));
                let mut ang_next = match next {
                    Some(n) => fixup_angles(self.path_orientation(n, forward)),
                    None => ang_prev,
                };
                let nopitch = t.spawnflags & SF_TRACKTRAIN_NOPITCH != 0;
                if nopitch {
                    ang_next[0] = ang_prev[0];
                }
                let mut p = 0.0;
                if let Some(n) = next {
                    if ang_prev != ang_next {
                        let segment = v_len(v_sub(self.path_origin(n), self.path_origin(prev)));
                        if segment != 0.0 {
                            p = v_len(v_sub(self.ents[i].local_origin, self.path_origin(prev))) / segment;
                        }
                    }
                }
                if otype == 3 {
                    p = simple_spline(p);
                }
                let mut new = ang_next;
                let qa = quat_from_angles(ang_prev);
                let qb = quat_from_angles(ang_next);
                if quat_angle_diff(qa, qb) != 0.0 {
                    new = angles_from_quat(quat_slerp(qa, qb, p));
                }
                if nopitch {
                    new[0] = ang_prev[0];
                }
                let cur = self.ents[i].local_angles;
                self.train_do_update_orientation(i, cur, new, interval);
            }
        }
    }

    /// CFuncTrackTrain::DoUpdateOrientation.
    fn train_do_update_orientation(&mut self, i: usize, cur: [f32; 3], angles: [f32; 3], interval: f32) {
        let t = self.train(i);
        let mut vx = if t.spawnflags & SF_TRACKTRAIN_NOPITCH == 0 { angle_distance(angles[0], cur[0]) } else { 0.0 };
        let mut vy = angle_distance(angles[1], cur[1]);
        if vx.abs() < 0.1 {
            vx = 0.0;
        }
        if vy.abs() < 0.1 {
            vy = 0.0;
        }
        let interval = if interval == 0.0 { 0.1 } else { interval };
        let bank = t.bank;
        let mut avel = [vx / interval, vy / interval, self.kin(i).push.avelocity[2]];
        if bank != 0.0 {
            avel[2] = if avel[1] < -5.0 {
                angle_distance(approach_angle(-bank, cur[2], bank * 2.0), cur[2])
            } else if avel[1] > 5.0 {
                angle_distance(approach_angle(bank, cur[2], bank * 2.0), cur[2])
            } else {
                angle_distance(approach_angle(0.0, cur[2], bank * 4.0), cur[2]) * 4.0
            };
        }
        self.kin_mut(i).push.avelocity = avel;
    }

    /// CFuncTrackTrain::TeleportToPathTrack.
    fn train_teleport_to_path(&mut self, i: usize, p: usize) {
        let cur = self.ents[i].local_angles;
        let next_pos = self.path_origin(p);
        let mut look = next_pos;
        let mut nn = None;
        let length = self.train(i).length;
        self.path_look_ahead(p, &mut look, length, false, &mut nn);
        let flags = self.train(i).spawnflags;
        let forward = self.train(i).dir == 1.0;
        let angles = if flags & SF_TRACKTRAIN_FIXED_ORIENTATION != 0 || look == next_pos {
            cur
        } else {
            let mut a = self.path_orientation(p, forward);
            if flags & SF_TRACKTRAIN_NOPITCH != 0 {
                a[0] = cur[0];
            }
            a
        };
        self.teleport_entity(i, next_pos, angles);
        self.kin_mut(i).push.avelocity = [0.0; 3];
        self.fire_output(p, "onteleport", Actor::Entity(i));
    }

    /// CFuncTrackTrain::DeadEnd.
    fn train_dead_end(&mut self, i: usize) {
        let mut track = self.train(i).path;
        let backward = self.train(i).old_speed < 0.0;
        if let Some(mut t) = track {
            let mut guard = 0;
            while let Some(n) = self.path_valid(if backward { self.path_prev(t) } else { self.path_next(t) }, true) {
                t = n;
                guard += 1;
                if guard > 10_000 {
                    break;
                }
            }
            track = Some(t);
        }
        let p = &mut self.kin_mut(i).push;
        p.velocity = [0.0; 3];
        p.avelocity = [0.0; 3];
        self.train_mut(i).done = TrainDone::None;
        if let Some(t) = track {
            self.fire_output(t, "onpass", Actor::Entity(i));
        }
    }

    // -------------------------------------------------------------- phys_motor

    fn motor_mut(&mut self, i: usize) -> &mut Motor {
        match &mut self.kin_mut(i).kind {
            KinKind::Motor(m) => m,
            _ => unreachable!(),
        }
    }

    fn motor_turn_on(&mut self, i: usize) {
        self.motor_mut(i).on = true;
        // m_lastTime = curtime - TICK_INTERVAL; Think()
        self.motor_step(i, self.settings.tick_interval);
    }

    fn motor_think(&mut self, i: usize) {
        if !self.motor_mut(i).on {
            self.motor_turn_on(i);
            return;
        }
        self.motor_step(i, self.settings.tick_interval);
    }

    /// CPhysMotor::Think: the controller speed approaches the target at the spin-up rate. The object
    /// follows it exactly (an ideal motor; VPhysics lags it slightly).
    fn motor_step(&mut self, i: usize, elapsed: f32) {
        let tick = self.tick;
        let m = self.motor_mut(i);
        m.speed = approach(m.target, m.speed, m.accel * elapsed);
        let more = m.speed != m.target;
        self.kin_mut(i).push.think = if more { Some(tick + 1) } else { None };
        self.motor_apply_speed(i);
    }

    fn motor_apply_speed(&mut self, i: usize) {
        let speed = self.motor_mut(i).speed;
        let p = &mut self.kin_mut(i).push;
        // The accumulated hinge angle lives in avelocity[1]; motor_transform turns it into a transform.
        p.avelocity = [0.0, speed, 0.0];
        p.move_done = if speed != 0.0 { p.local_time + 1.0e6 } else { -1.0 };
    }
}

/// Contact probes of a brush model (model space): the corners of its collision brushes and a grid (16u, coarser for
/// big bodies: at most ~512 probes) over their downward-facing sides.
fn brush_probes(world: &playsrc_collision::World, model: usize) -> Vec<[f32; 3]> {
    let Some(brushes) = world.model_brushes.get(model) else { return Vec::new() };
    let mut out: Vec<[f32; 3]> = Vec::new();
    let mut bottoms: Vec<([f32; 3], f32, Vec<[f32; 3]>)> = Vec::new();
    for &bi in brushes {
        let Some(b) = world.brushes.get(bi) else { continue };
        let planes: Vec<([f32; 3], f32)> = (b.first_side..b.first_side + b.side_count)
            .filter_map(|s| world.sides.get(s))
            .filter(|s| s.bevel == 0)
            .filter_map(|s| world.planes.get(s.plane))
            .map(|p| (p.normal, p.distance))
            .collect();
        let mut corners: Vec<[f32; 3]> = Vec::new();
        let n = planes.len();
        for a in 0..n {
            for c in a + 1..n {
                for d in c + 1..n {
                    let Some(p) = intersect3(planes[a], planes[c], planes[d]) else { continue };
                    if planes.iter().all(|(nn, dd)| v_dot(*nn, p) <= dd + 0.01) && !corners.iter().any(|q| v_len(v_sub(*q, p)) < 0.01) {
                        corners.push(p);
                    }
                }
            }
        }
        for &(nrm, dist) in &planes {
            if nrm[2] < -0.3 {
                let face: Vec<[f32; 3]> = corners.iter().copied().filter(|p| (v_dot(nrm, *p) - dist).abs() < 0.02).collect();
                if face.len() >= 3 {
                    bottoms.push((nrm, dist, face));
                }
            }
        }
        out.extend(corners);
    }
    // Grid spacing so the grid stays around 512 probes.
    let area: f32 = bottoms
        .iter()
        .map(|(_, _, f)| {
            let (lo, hi) = f.iter().fold(([f32::MAX; 2], [f32::MIN; 2]), |(lo, hi), p| ([lo[0].min(p[0]), lo[1].min(p[1])], [hi[0].max(p[0]), hi[1].max(p[1])]));
            (hi[0] - lo[0]) * (hi[1] - lo[1])
        })
        .sum();
    let spacing = 16.0f32.max((area / 512.0).sqrt());
    for (nrm, dist, face) in &bottoms {
        // Convex polygon in xy: order the corners around their centroid.
        let c = face.iter().fold([0.0f32; 3], |a, p| v_add(a, *p));
        let c = v_scale(c, 1.0 / face.len() as f32);
        let mut poly = face.clone();
        poly.sort_by(|p, q| playsrc_collision::math::atan2(p[1] - c[1], p[0] - c[0]).total_cmp(&playsrc_collision::math::atan2(q[1] - c[1], q[0] - c[0])));
        let (lo, hi) = poly.iter().fold(([f32::MAX; 2], [f32::MIN; 2]), |(lo, hi), p| ([lo[0].min(p[0]), lo[1].min(p[1])], [hi[0].max(p[0]), hi[1].max(p[1])]));
        let inside = |x: f32, y: f32| {
            (0..poly.len()).all(|k| {
                let (a, b) = (poly[k], poly[(k + 1) % poly.len()]);
                (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) >= -0.01
            })
        };
        let mut x = lo[0] + spacing * 0.5;
        while x < hi[0] {
            let mut y = lo[1] + spacing * 0.5;
            while y < hi[1] {
                if inside(x, y) && nrm[2] != 0.0 {
                    // On the side's plane: n.p = d.
                    let z = (dist - nrm[0] * x - nrm[1] * y) / nrm[2];
                    out.push([x, y, z]);
                }
                y += spacing;
            }
            x += spacing;
        }
    }
    out
}

fn intersect3(a: ([f32; 3], f32), b: ([f32; 3], f32), c: ([f32; 3], f32)) -> Option<[f32; 3]> {
    let cross = |u: [f32; 3], v: [f32; 3]| [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    let bc = cross(b.0, c.0);
    let det = v_dot(a.0, bc);
    if det.abs() < 1e-6 {
        return None;
    }
    let p = v_add(v_add(v_scale(bc, a.1), v_scale(cross(c.0, a.0), b.1)), v_scale(cross(a.0, b.0), c.1));
    Some(v_scale(p, 1.0 / det))
}

/// Abs linear velocity of an entity (CBaseEntity::CalcAbsoluteVelocity) for doors and kinematic movers:
/// the ground velocity the player inherits when leaving it.
pub(super) fn ent_abs_velocity(ents: &[RtEnt], i: usize) -> [f32; 3] {
    let local = match &ents[i].data {
        Data::Kin(k) => k.push.velocity,
        Data::Mover(m) => match m.phase {
            MoverPhase::Opening => v_scale(m.dir, m.speed),
            MoverPhase::Closing => v_scale(m.dir, -m.speed),
            _ => [0.0; 3],
        },
        _ => [0.0; 3],
    };
    match ents[i].parent {
        None => local,
        Some(p) => {
            let rotated = xf([0.0; 3], ents[p].angles).transform_point(local).unwrap_or(local);
            v_add(rotated, ent_abs_velocity(ents, p))
        }
    }
}

/// World transform of a motor-driven object after rotating `m.angle` degrees about the hinge.
fn motor_transform(m: &Motor) -> ([f32; 3], [f32; 3]) {
    let q = quat_axis_angle(m.axis, m.angle);
    let base = quat_from_angles(m.base_angles);
    let rel = v_sub(m.base_origin, m.origin);
    let origin = v_add(m.origin, quat_rotate(q, rel));
    (origin, angles_from_quat(quat_mul(q, base)))
}

fn end_abs_axis(t: Transform, k: usize) -> [f32; 3] {
    let mut unit = [0.0; 3];
    unit[k] = 1.0;
    t.transform_point(unit).map(|p| v_sub(p, t.origin)).unwrap_or(unit)
}

// ------------------------------------------------------------------ quaternions (mathlib)

type Quat = [f32; 4];

/// mathlib AngleQuaternion.
fn quat_from_angles(a: [f32; 3]) -> Quat {
    let (sy, cy) = playsrc_collision::math::sin_cos(a[1].to_radians() * 0.5);
    let (sp, cp) = playsrc_collision::math::sin_cos(a[0].to_radians() * 0.5);
    let (sr, cr) = playsrc_collision::math::sin_cos(a[2].to_radians() * 0.5);
    let srxcp = sr * cp;
    let crxsp = cr * sp;
    let crxcp = cr * cp;
    let srxsp = sr * sp;
    [srxcp * cy - crxsp * sy, crxsp * cy + srxcp * sy, crxcp * sy - srxsp * cy, crxcp * cy + srxsp * sy]
}

fn quat_axis_angle(axis: [f32; 3], degrees: f32) -> Quat {
    let (s, c) = playsrc_collision::math::sin_cos(degrees.to_radians() * 0.5);
    [axis[0] * s, axis[1] * s, axis[2] * s, c]
}

fn quat_mul(p: Quat, q: Quat) -> Quat {
    [
        p[0] * q[3] + p[1] * q[2] - p[2] * q[1] + p[3] * q[0],
        -p[0] * q[2] + p[1] * q[3] + p[2] * q[0] + p[3] * q[1],
        p[0] * q[1] - p[1] * q[0] + p[2] * q[3] + p[3] * q[2],
        -p[0] * q[0] - p[1] * q[1] - p[2] * q[2] + p[3] * q[3],
    ]
}

fn quat_rotate(q: Quat, v: [f32; 3]) -> [f32; 3] {
    let u = [q[0], q[1], q[2]];
    let s = q[3];
    let cross = |a: [f32; 3], b: [f32; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let t = v_scale(cross(u, v), 2.0);
    v_add(v_add(v, v_scale(t, s)), cross(u, t))
}

/// mathlib QuaternionMatrix + MatrixAngles.
fn angles_from_quat(q: Quat) -> [f32; 3] {
    let m00 = 1.0 - 2.0 * q[1] * q[1] - 2.0 * q[2] * q[2];
    let m10 = 2.0 * q[0] * q[1] + 2.0 * q[3] * q[2];
    let m20 = 2.0 * q[0] * q[2] - 2.0 * q[3] * q[1];
    let m21 = 2.0 * q[1] * q[2] + 2.0 * q[3] * q[0];
    let m22 = 1.0 - 2.0 * q[0] * q[0] - 2.0 * q[1] * q[1];
    let m01 = 2.0 * q[0] * q[1] - 2.0 * q[3] * q[2];
    let m11 = 1.0 - 2.0 * q[0] * q[0] - 2.0 * q[2] * q[2];
    let xy = (m00 * m00 + m10 * m10).sqrt();
    if xy > 0.001 {
        [
            playsrc_collision::math::atan2(-m20, xy).to_degrees(),
            playsrc_collision::math::atan2(m10, m00).to_degrees(),
            playsrc_collision::math::atan2(m21, m22).to_degrees(),
        ]
    } else {
        [playsrc_collision::math::atan2(-m20, xy).to_degrees(), playsrc_collision::math::atan2(-m01, m11).to_degrees(), 0.0]
    }
}

fn quat_angle_diff(p: Quat, q: Quat) -> f32 {
    let qinv = [-q[0], -q[1], -q[2], q[3]];
    let d = quat_mul(p, qinv);
    let sin = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt().min(1.0);
    (2.0 * playsrc_collision::math::asin(sin)).to_degrees()
}

/// mathlib QuaternionSlerp (with QuaternionAlign).
fn quat_slerp(p: Quat, q: Quat, t: f32) -> Quat {
    // QuaternionAlign
    let a: f32 = (0..4).map(|k| (p[k] - q[k]) * (p[k] - q[k])).sum();
    let b: f32 = (0..4).map(|k| (p[k] + q[k]) * (p[k] + q[k])).sum();
    let q = if a > b { [-q[0], -q[1], -q[2], -q[3]] } else { q };
    let cosom = p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3];
    let (sclp, sclq);
    let mut qt = [0.0; 4];
    if 1.0 + cosom > 0.000001 {
        if 1.0 - cosom > 0.000001 {
            let omega = playsrc_collision::math::acos(cosom);
            let sinom = playsrc_collision::math::sin(omega);
            sclp = playsrc_collision::math::sin((1.0 - t) * omega) / sinom;
            sclq = playsrc_collision::math::sin(t * omega) / sinom;
        } else {
            sclp = 1.0 - t;
            sclq = t;
        }
        for k in 0..4 {
            qt[k] = sclp * p[k] + sclq * q[k];
        }
    } else {
        qt = [-q[1], q[0], -q[3], q[2]];
        let sp = playsrc_collision::math::sin((1.0 - t) * 0.5 * std::f32::consts::PI);
        let sq = playsrc_collision::math::sin(t * 0.5 * std::f32::consts::PI);
        for k in 0..3 {
            qt[k] = sp * p[k] + sq * qt[k];
        }
    }
    qt
}

impl Game {
    /// func_physbox that VPhysics simulates from spawn (motion enabled, awake, not following a parent, not
    /// driven by a phys_motor): dropped straight down onto what's below it (the world, props, other brush
    /// entities), like the props in `physics::PropCollision::build`. A box resting on a surface doesn't
    /// move; one placed in mid-air ends up where it lands. It then stays put (players don't push it; see
    /// research/ENTITIES.md).
    pub(super) fn settle_physboxes(&mut self) {
        for i in 0..self.ents.len() {
            let e = &self.ents[i];
            let fall = matches!(&e.data, Data::Kin(k) if matches!(k.kind, KinKind::Fall(_)));
            if e.class != "func_physbox" || !e.solid || e.parent.is_some() || !fall {
                continue;
            }
            let spawnflags = self.entities[i].int("spawnflags");
            // SF_PHYSBOX_ASLEEP (0x1000), SF_PHYSBOX_MOTIONDISABLED (0x8000)
            if spawnflags & (0x1000 | 0x8000) != 0 {
                continue;
            }
            let Some(b) = e.brush.as_ref() else { continue };
            let (lo, hi) = b.world_bounds();
            let origin = e.origin;
            let hull = Hull { mins: v_sub(lo, origin), maxs: v_sub(hi, origin) };
            let end = [origin[0], origin[1], origin[2] - 8192.0];
            self.rebuild_solid();
            let Ok(t) = self.scene(0.0).trace_filtered(origin, end, hull, playsrc_collision::MASK_SOLID, &[i]) else { continue };
            if t.start_solid || t.fraction >= 1.0 || t.fraction <= 0.0 {
                continue;
            }
            self.ents[i].local_origin = t.end;
            self.relink(i);
        }
    }
}
