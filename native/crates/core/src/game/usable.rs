//! +use (IN_USE): `CBasePlayer::PlayerUse` / `FindUseEntity` (SDK 2013 game/shared/baseplayer_shared.cpp, the
//! CSTRIKE_DLL contents mask) and the `ObjectCaps` use capabilities of the classes the core simulates.
//!
//! PlayerUse runs in the player's PreThink, before the command's movement: on a fresh press it looks for the
//! entity in front of the eye (a 1024u line trace, then 72u hull traces tilted down 45..-15 degrees, then
//! every `FCAP_USE_IN_RADIUS` entity within 80u that the view points at), and sends it `Use`:
//! - `FCAP_IMPULSE_USE` (buttons, doors): once per press, USE_TOGGLE;
//! - `FCAP_ONOFF_USE`: USE_ON on the press, USE_OFF on the release;
//! - `FCAP_CONTINUOUS_USE` (momentary_rot_button): every tick while held.
//!
//! Not simulated: sv_turbophysics pushes of physics props, ClearUseEntity (nothing can be held here) and
//! train controls (FCAP_DIRECTIONAL_USE trains are found but never driven).

use super::kin::{v_add, v_len, v_scale, v_sub};
use super::*;

pub(super) const FCAP_IMPULSE_USE: u32 = 0x10;
pub(super) const FCAP_CONTINUOUS_USE: u32 = 0x20;
pub(super) const FCAP_ONOFF_USE: u32 = 0x40;
pub(super) const FCAP_DIRECTIONAL_USE: u32 = 0x80;
pub(super) const FCAP_USE_ONGROUND: u32 = 0x100;
pub(super) const FCAP_USE_IN_RADIUS: u32 = 0x200;
/// PLAYER_USE_RADIUS (baseplayer_shared.h).
const PLAYER_USE_RADIUS: f32 = 80.0;
/// CS:S `useableContents`: MASK_NPCSOLID_BRUSHONLY | MASK_OPAQUE_AND_NPCS (SOLID, WINDOW, GRATE, OPAQUE,
/// MOVEABLE, MONSTERCLIP, MONSTER).
pub(super) const USE_MASK: u32 = 0x1 | 0x2 | 0x8 | 0x80 | 0x4000 | 0x2_0000 | 0x200_0000;

/// USE_TYPE.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum UseType {
    Off,
    On,
    Toggle,
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn normalized(v: [f32; 3]) -> [f32; 3] {
    let l = v_len(v);
    if l > 0.0 { v_scale(v, 1.0 / l) } else { v }
}

/// mathlib `CalcDistanceToLine` (distance from `p` to the infinite line through `a` and `b`).
fn distance_to_line(p: [f32; 3], a: [f32; 3], b: [f32; 3]) -> f32 {
    let dir = v_sub(b, a);
    let div = dot(dir, dir);
    let t = if div < 0.00001 { 0.0 } else { (dot(dir, p) - dot(dir, a)) / div };
    v_len(v_sub(p, v_add(a, v_scale(dir, t))))
}

/// `IntervalDistance`.
fn interval_distance(x: f32, x0: f32, x1: f32) -> f32 {
    let (x0, x1) = if x0 > x1 { (x1, x0) } else { (x0, x1) };
    if x < x0 {
        x0 - x
    } else if x > x1 {
        x - x1
    } else {
        0.0
    }
}

impl Game {
    /// `ObjectCaps()` use bits of entity `i` (0 = not usable).
    pub(super) fn use_caps(&self, i: usize) -> u32 {
        let e = &self.ents[i];
        if e.removed {
            return 0;
        }
        let sf = self.entities[i].int("spawnflags");
        let has = |f: i64| sf & f != 0;
        match e.class.as_str() {
            // CBaseButton / CRotButton: SF_BUTTON_USE_ACTIVATES.
            "func_button" | "func_rot_button" if has(1024) => FCAP_IMPULSE_USE | FCAP_USE_IN_RADIUS,
            "momentary_rot_button" if has(1024) => FCAP_CONTINUOUS_USE | FCAP_USE_IN_RADIUS,
            // CBaseDoor: SF_DOOR_PUSE.
            "func_door" | "func_door_rotating" if has(256) => FCAP_IMPULSE_USE | FCAP_USE_IN_RADIUS,
            // CBasePropDoor: unless SF_DOOR_IGNORE_USE.
            "prop_door_rotating" if !has(32768) => FCAP_IMPULSE_USE | FCAP_USE_IN_RADIUS,
            "func_tracktrain" => FCAP_DIRECTIONAL_USE,
            // Pickup output props (CanPickupObject is HL2-only: nothing else is usable in CS:S).
            "func_physbox" | "func_physbox_multiplayer" if has(0x80000) => FCAP_IMPULSE_USE,
            c if c.starts_with("prop_physics") && has(0x100) => FCAP_IMPULSE_USE,
            _ => 0,
        }
    }

    fn is_useable(&self, i: usize, required: u32) -> bool {
        let caps = self.use_caps(i);
        caps & (FCAP_IMPULSE_USE | FCAP_CONTINUOUS_USE | FCAP_ONOFF_USE | FCAP_DIRECTIONAL_USE) != 0 && caps & required == required
    }

    /// The entity's collision OBB (`CollisionProp()`): transform and entity-space bounds.
    fn use_obb(&self, i: usize) -> Option<(Transform, [f32; 3], [f32; 3])> {
        let e = &self.ents[i];
        if let Some(b) = &e.brush {
            return Some((Transform { origin: b.origin, angles: b.angles }, b.mins, b.maxs));
        }
        let p = e.prop.as_ref()?;
        Some((Transform { origin: p.at.0, angles: p.at.1 }, p.hulls.mins, p.hulls.maxs))
    }

    /// `CCollisionProperty::CalcNearestPoint`.
    fn nearest_point(&self, i: usize, p: [f32; 3]) -> Option<[f32; 3]> {
        let (t, mins, maxs) = self.use_obb(i)?;
        let local = t.inverse_transform_point(p).ok()?;
        let clamped = [0, 1, 2].map(|k| local[k].clamp(mins[k], maxs[k]));
        t.transform_point(clamped).ok()
    }

    /// World AABB of the collision OBB (the partition bounds a sphere query tests).
    fn obb_world_bounds(&self, i: usize) -> Option<([f32; 3], [f32; 3])> {
        let (t, mins, maxs) = self.use_obb(i)?;
        let (mut lo, mut hi) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
        for c in 0..8 {
            let corner = [0, 1, 2].map(|k| if c >> k & 1 != 0 { maxs[k] } else { mins[k] });
            let w = t.transform_point(corner).ok()?;
            for k in 0..3 {
                lo[k] = lo[k].min(w[k]);
                hi[k] = hi[k].max(w[k]);
            }
        }
        Some((lo, hi))
    }

    fn use_trace(&self, start: [f32; 3], end: [f32; 3], hull: Hull) -> Option<Trace> {
        self.scene(0.0).trace_filtered(start, end, hull, USE_MASK, &[]).ok()
    }

    /// CBasePlayer::FindUseEntity.
    pub(super) fn find_use_entity(&self, pitch: f32, yaw: f32) -> Option<usize> {
        let (sp, cp) = playsrc_collision::math::sin_cos(pitch.to_radians());
        let (sy, cy) = playsrc_collision::math::sin_cos(yaw.to_radians());
        let forward = [cp * cy, cp * sy, -sp];
        let up = [sp * cy, sp * sy, cp];
        let p = self.state.position;
        let eye = v_add(p, self.state.view_offset);
        let hull = self.current_hull();
        // WorldSpaceCenter().z + OBBMins/Maxs().z: the interval starts at the centre (Source's arithmetic).
        let center_z = p[2] + (hull.mins[2] + hull.maxs[2]) * 0.5;
        const TANGENTS: [f32; 8] = [0.0, 1.0, 0.577_350_26, 0.363_970_23, 0.267_949_2, 0.176_326_98, -0.176_326_98, -0.267_949_2];
        let mut nearest: Option<usize> = None;
        for (k, &tangent) in TANGENTS.iter().enumerate() {
            let tr = if k == 0 {
                self.use_trace(eye, v_add(eye, v_scale(forward, 1024.0)), Hull { mins: [0.0; 3], maxs: [0.0; 3] })
            } else {
                let down = normalized(v_sub(forward, v_scale(up, tangent)));
                self.use_trace(eye, v_add(eye, v_scale(down, 72.0)), Hull { mins: [-16.0; 3], maxs: [16.0; 3] })
            };
            let Some(tr) = tr else { continue };
            let mut object = tr.hit.and_then(hit_entity).filter(|&i| i < self.ents.len());
            let mut usable = object.is_some_and(|o| self.is_useable(o, 0));
            while let Some(o) = object.filter(|_| !usable) {
                object = self.ents[o].parent;
                usable = object.is_some_and(|o| self.is_useable(o, 0));
            }
            if !usable {
                continue;
            }
            let mut delta = v_sub(tr.end, eye);
            delta[2] = interval_distance(tr.end[2], center_z + hull.mins[2], center_z + hull.maxs[2]);
            if v_len(delta) < PLAYER_USE_RADIUS {
                nearest = object;
                if k == 0 {
                    return object;
                }
            }
        }
        if let Some(g) = self.state.ground.and_then(|g| g.support).and_then(hit_entity) {
            if g < self.ents.len() && self.is_useable(g, FCAP_USE_ONGROUND) {
                nearest = Some(g);
            }
        }
        let mut nearest_dist = f32::MAX;
        if let Some(n) = nearest {
            if let Some(point) = self.nearest_point(n, eye) {
                // CalcDistanceToLine( point, searchCenter, forward ): Source passes the direction as the line's
                // second point.
                nearest_dist = distance_to_line(point, eye, forward);
            }
        }
        // CEntitySphereQuery(searchCenter, PLAYER_USE_RADIUS).
        for i in 0..self.ents.len() {
            if !self.is_useable(i, FCAP_USE_IN_RADIUS) {
                continue;
            }
            let Some((lo, hi)) = self.obb_world_bounds(i) else { continue };
            let d2: f32 = (0..3).map(|k| (lo[k] - eye[k]).max(0.0).max(eye[k] - hi[k])).map(|d| d * d).sum();
            if d2 > PLAYER_USE_RADIUS * PLAYER_USE_RADIUS {
                continue;
            }
            let Some(point) = self.nearest_point(i, eye) else { continue };
            if dot(normalized(v_sub(point, eye)), forward) < 0.8 {
                continue;
            }
            let dist = distance_to_line(point, eye, forward);
            if dist < nearest_dist {
                // Not behind glass or a grate.
                let Some(tr) = self.use_trace(eye, point, Hull { mins: [0.0; 3], maxs: [0.0; 3] }) else { continue };
                if tr.fraction == 1.0 || tr.hit.and_then(hit_entity) == Some(i) {
                    nearest = Some(i);
                    nearest_dist = dist;
                }
            }
        }
        nearest
    }

    /// CBasePlayer::PlayerUse (game side), with this command's buttons and their press / release edges.
    pub(super) fn player_use(&mut self, cmd: Cmd, pressed: u32, released: u32) {
        let Some(target) = self.find_use_entity(cmd.pitch, cmd.yaw) else { return };
        let caps = self.use_caps(target);
        let held = cmd.buttons & IN_USE != 0;
        if (held && caps & FCAP_CONTINUOUS_USE != 0) || (pressed & IN_USE != 0 && caps & (FCAP_IMPULSE_USE | FCAP_ONOFF_USE) != 0) {
            let use_type = if caps & FCAP_ONOFF_USE != 0 { UseType::On } else { UseType::Toggle };
            self.use_entity(target, use_type, Actor::Player);
        } else if released & IN_USE != 0 && caps & FCAP_ONOFF_USE != 0 {
            self.use_entity(target, UseType::Off, Actor::Player);
        }
    }

    /// `Use(activator, caller, useType)` on entity `i` (the player's +use, or the `Use` input).
    pub(super) fn use_entity(&mut self, i: usize, use_type: UseType, activator: Actor) {
        if self.ents[i].removed {
            return;
        }
        if matches!(self.ents[i].data, Data::Mover(_)) {
            self.mover_use(i, activator);
            return;
        }
        if let Data::Kin(k) = &self.ents[i].data {
            match &k.kind {
                kin::KinKind::PropDoor(_) => self.prop_door_use(i, activator),
                kin::KinKind::RotButton(_) => self.rot_button_use(i, use_type, activator),
                kin::KinKind::Momentary(_) => self.momentary_use(i),
                _ => {
                    self.kin_input(i, "use", "", activator);
                }
            }
            return;
        }
        let class = self.ents[i].class.as_str();
        if class.starts_with("func_physbox") || class.starts_with("prop_physics") {
            // CPhysBox / CPhysicsProp::Use with the pickup output flag.
            if self.use_caps(i) & FCAP_IMPULSE_USE != 0 && activator == Actor::Player {
                self.fire_output(i, "onplayeruse", Actor::Entity(i));
            }
        }
    }

    /// CBaseButton::ButtonUse (func_button) / CBaseDoor::Use (func_door) on the touch-mover model.
    fn mover_use(&mut self, i: usize, activator: Actor) {
        let sf = self.entities[i].int("spawnflags");
        let m = self.mover_mut(i).clone();
        if m.button {
            // SetUse(ButtonUse) only with SF_BUTTON_USE_ACTIVATES.
            if sf & 1024 == 0 || matches!(m.phase, MoverPhase::Opening | MoverPhase::Closing) {
                return;
            }
            // ButtonUse: m_hActivator = pActivator.
            if activator == Actor::Player {
                self.note_button_activator(i);
            }
            if m.locked {
                // OnUseLocked, at most every 0.5 s (m_flUseLockedTime).
                if self.tick >= m.use_locked_until {
                    let until = self.tick + self.delay_ticks(0.5) + 1;
                    self.mover_mut(i).use_locked_until = until;
                    self.fire_output(i, "onuselocked", activator);
                }
                return;
            }
            match m.phase {
                MoverPhase::Open { .. } => {
                    if sf & 32 != 0 {
                        // SF_BUTTON_TOGGLE: OnPressed, then return.
                        self.fire_output(i, "onpressed", activator);
                        self.mover_go_down(i, activator);
                    }
                }
                _ => self.mover_go_up(i, activator),
            }
            return;
        }
        // CBaseDoor::Use: a player needs SF_DOOR_PUSE.
        if activator == Actor::Player && sf & 256 == 0 {
            return;
        }
        let allow = match m.phase {
            MoverPhase::Closed => true,
            MoverPhase::Closing => sf & 65536 != 0,
            MoverPhase::Open { .. } | MoverPhase::Opening => m.no_auto_return && (m.phase != MoverPhase::Opening || sf & 65536 != 0),
        };
        if !allow {
            return;
        }
        if m.locked {
            self.fire_output(i, "onlockeduse", activator);
            return;
        }
        // CBaseDoor::DoorActivate.
        match m.phase {
            MoverPhase::Open { .. } if m.no_auto_return => self.mover_go_down(i, activator),
            MoverPhase::Open { .. } | MoverPhase::Opening => {}
            _ => self.mover_go_up(i, activator),
        }
    }
}
