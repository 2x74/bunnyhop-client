//! Map overlays (the client's !showtriggers / !showclips): which brushes trigger or block the player, for drawing them.
//!
//! Read-only queries over the loaded map and the live entity state. Nothing in `step` calls them and they change no
//! state, so a run with the overlays on simulates exactly like one without (ranked runs stay valid).
//!
//! What counts is what the simulation itself uses: the triggers `touch_triggers_at` tests (with the per-map trigger
//! boxes in place of their brushes where the physics version uses them), the brushes the player's solid mask hits.
//! Triggers that can never fire for the player (no client spawnflag) and trigger_multiple / trigger_once without
//! outputs or an emulated script role (they do nothing; timer zones are drawn by the client from its own zone data)
//! are left out.

use super::{Data, Game, PHYSICS_FIX_MAP_TRIGGERS, RtEnt, TriggerKind, MAX_HEALTH};
use super::vscript::ScriptRole;
use playsrc_collision::{CONTENTS_PLAYERCLIP, World as CollisionWorld};

/// trigger_teleport, trigger_hurt that kills within a second (damage >= 100: a reset) and triggers whose outputs move
/// the player (AddOutput origin, point_teleport).
pub const OVERLAY_TELEPORT: u32 = 0;
/// trigger_push and basevelocity boosters (AddOutput basevelocity on the player).
pub const OVERLAY_PUSH: u32 = 1;
/// trigger_gravity, AddOutput gravity and player_speedmod ModifySpeed.
pub const OVERLAY_GRAVITY: u32 = 2;
/// Any other trigger with an effect (outputs, non-lethal trigger_hurt, trigger_playermovement).
pub const OVERLAY_OTHER: u32 = 3;
/// Player clip brushes (CONTENTS_PLAYERCLIP without solid contents).
pub const OVERLAY_CLIP: u32 = 4;
/// Solid brushes with nothing drawn (all sides nodraw / tool textures), and func_brush walls while disabled but solid.
pub const OVERLAY_WALL: u32 = 5;

/// `OverlayBrush::flags`: the brush only counts while its entity is hidden (a drawn func_brush that stays solid).
pub const OVERLAY_WHEN_HIDDEN: u32 = 1;

/// `overlay_state` bits per entity.
pub const OVERLAY_STATE_ACTIVE: u32 = 1;
pub const OVERLAY_STATE_VISIBLE: u32 = 2;

/// One convex volume to draw: outward planes (normal, distance) in its model's space.
#[derive(Clone, Debug)]
pub struct OverlayBrush {
    pub kind: u32,
    /// Entity index (`Game::entities` order), or None for world brushes.
    pub entity: Option<usize>,
    /// Brush model whose transform places the planes (`brush_transforms`), or None when they are already in world
    /// space (world brushes, per-map trigger boxes).
    pub model: Option<usize>,
    pub flags: u32,
    pub planes: Vec<([f32; 3], f32)>,
}

/// Solid contents a player collides with, other than playerclip.
fn blocking(mask: u32) -> u32 {
    mask & !CONTENTS_PLAYERCLIP
}

/// The sides of brush `b` that bound it (not the bevel planes vbsp adds for box traces). The side's `bevel` is a byte:
/// v21 (CS:GO) maps keep a `thin` byte after it, which the vendored record reads as the high byte of an i16.
fn faces(world: &CollisionWorld, b: usize) -> impl Iterator<Item = &playsrc_collision::Side> {
    let brush = &world.brushes[b];
    world.sides[brush.first_side..brush.first_side + brush.side_count].iter().filter(|s| s.bevel & 0xff == 0)
}

/// Whether every side of brush `b` draws nothing: `drawn[texinfo]` from `mesh::texinfo_drawn`.
fn undrawn(world: &CollisionWorld, b: usize, drawn: &[bool]) -> bool {
    faces(world, b).all(|s| s.texture_info < 0 || !drawn.get(s.texture_info as usize).copied().unwrap_or(false))
}

fn brush_planes(world: &CollisionWorld, b: usize) -> Vec<([f32; 3], f32)> {
    faces(world, b).filter_map(|s| world.planes.get(s.plane).map(|p| (p.normal, p.distance))).collect()
}

/// What a trigger's own outputs do to the player, as an overlay kind.
fn output_kind(e: &RtEnt, classes: &dyn Fn(&str) -> bool) -> Option<u32> {
    let mut kind = None;
    for o in e.outputs.iter() {
        let input = o.input.to_ascii_lowercase();
        let key = o.param.trim().split_whitespace().next().unwrap_or("").to_ascii_lowercase();
        let k = match (input.as_str(), key.as_str()) {
            ("addoutput", "origin") => OVERLAY_TELEPORT,
            ("teleport", _) if classes(&o.target) => OVERLAY_TELEPORT,
            ("addoutput", "basevelocity") => OVERLAY_PUSH,
            ("addoutput", "gravity") | ("modifyspeed", _) => OVERLAY_GRAVITY,
            _ => OVERLAY_OTHER,
        };
        kind = Some(kind.map_or(k, |old: u32| old.min(k)));
    }
    kind
}

impl Game {
    /// The overlay kind of trigger entity `i`, or None if it never affects the player.
    fn trigger_overlay_kind(&self, i: usize) -> Option<u32> {
        let e = &self.ents[i];
        let Data::Trigger(t) = &e.data else { return None };
        // CTriggerGravity touches any player; every other trigger needs a client spawnflag (`trigger_passes`).
        let clients = t.spawnflags & (1 | 64 | 512) != 0 && t.spawnflags & 32 == 0;
        if !clients && !matches!(t.kind, TriggerKind::Gravity { .. }) {
            return None;
        }
        let teleporter = |name: &str| self.ents.iter().any(|x| x.class == "point_teleport" && x.name.eq_ignore_ascii_case(name));
        match &t.kind {
            TriggerKind::Teleport { .. } | TriggerKind::TeleportRelative { .. } => Some(OVERLAY_TELEPORT),
            TriggerKind::Push { .. } => Some(OVERLAY_PUSH),
            TriggerKind::Gravity { .. } => Some(OVERLAY_GRAVITY),
            TriggerKind::Hurt { damage, .. } => {
                Some(if *damage >= MAX_HEALTH { OVERLAY_TELEPORT } else { output_kind(e, &teleporter).unwrap_or(OVERLAY_OTHER) })
            }
            TriggerKind::PlayerMovement { .. } => Some(output_kind(e, &teleporter).unwrap_or(OVERLAY_OTHER)),
            TriggerKind::Multiple { .. } => output_kind(e, &teleporter).or_else(|| {
                if !self.objectives_on() {
                    return None;
                }
                self.script_triggers.iter().find(|(j, _)| *j == i).map(|(_, role)| match role {
                    ScriptRole::GateTeleport => OVERLAY_TELEPORT,
                    ScriptRole::GateRebound => OVERLAY_PUSH,
                    ScriptRole::Objective | ScriptRole::Reset => OVERLAY_OTHER,
                })
            }),
        }
    }

    /// Every volume the overlays draw. `drawn[texinfo]`: whether faces with that texinfo are drawn
    /// (`mesh::texinfo_drawn`; sky counts as drawn), for telling invisible walls from visible ones.
    pub fn overlay_brushes(&self, drawn: &[bool]) -> Vec<OverlayBrush> {
        let world = &self.world;
        let mask = self.config.solid_mask;
        let solid = blocking(mask);
        let clips = mask & CONTENTS_PLAYERCLIP;
        let mut out = Vec::new();
        let static_kind = |b: usize| {
            let contents = world.brushes[b].contents;
            if contents & solid != 0 {
                undrawn(world, b, drawn).then_some(OVERLAY_WALL)
            } else if contents & clips != 0 {
                Some(OVERLAY_CLIP)
            } else {
                None
            }
        };
        for &b in &world.world_brushes {
            if let Some(kind) = static_kind(b) {
                out.push(OverlayBrush { kind, entity: None, model: None, flags: 0, planes: brush_planes(world, b) });
            }
        }
        let map_boxes =
            if self.settings.physics_fixes() & PHYSICS_FIX_MAP_TRIGGERS != 0 { self.map_trigger_boxes.as_slice() } else { &[] };
        for (i, e) in self.ents.iter().enumerate() {
            let Some(model) = e.brush.as_ref().map(|b| b.model) else { continue };
            if model == 0 || model >= world.model_brushes.len() {
                continue;
            }
            if matches!(e.data, Data::Trigger(_)) {
                let Some(kind) = self.trigger_overlay_kind(i) else { continue };
                if let Some((_, b)) = map_boxes.iter().find(|(j, _)| *j == i) {
                    out.push(OverlayBrush { kind, entity: Some(i), model: None, flags: 0, planes: b.planes.clone() });
                    continue;
                }
                for &b in &world.model_brushes[model] {
                    out.push(OverlayBrush { kind, entity: Some(i), model: Some(model), flags: 0, planes: brush_planes(world, b) });
                }
                continue;
            }
            // Brush entities that block the player at some point (solid at spawn, or a toggling wall): their clips and
            // undrawn brushes count while the entity is solid; a func_brush that stays solid while disabled
            // ("Solidity" always) is an invisible wall while it's hidden. Effects (func_dustmotes, func_illusionary,
            // trigger_soundscape, ...) never block.
            let toggles = matches!(e.class.as_str(), "func_brush" | "func_wall_toggle");
            if !toggles && !e.solid && !self.initial_ents.get(i).is_some_and(|x| x.solid) {
                continue;
            }
            let hidden_solid = e.class == "func_brush" && e.solidity == 2;
            for &b in &world.model_brushes[model] {
                let (kind, flags) = match static_kind(b) {
                    Some(k) => (k, 0),
                    None if hidden_solid && world.brushes[b].contents & solid != 0 => (OVERLAY_WALL, OVERLAY_WHEN_HIDDEN),
                    None => continue,
                };
                out.push(OverlayBrush { kind, entity: Some(i), model: Some(model), flags, planes: brush_planes(world, b) });
            }
        }
        out
    }

    /// `OVERLAY_STATE_*` bits of entity `i` now: active (an enabled trigger, a solid brush entity; not removed) and
    /// visible (drawn).
    pub fn overlay_state(&self, i: usize) -> u32 {
        let Some(e) = self.ents.get(i) else { return 0 };
        if e.removed {
            return 0;
        }
        let active = match &e.data {
            Data::Trigger(t) => t.enabled,
            _ => e.solid,
        };
        (active as u32 * OVERLAY_STATE_ACTIVE) | (e.visible as u32 * OVERLAY_STATE_VISIBLE)
    }

    /// `overlay_state` of every entity, in entity order.
    pub fn overlay_states(&self) -> impl Iterator<Item = u32> + '_ {
        (0..self.ents.len()).map(|i| self.overlay_state(i))
    }
}
