//! What the map's I/O asked its animated props to play, for the client to pose (apps/web/src/map-props.ts).
//!
//! Display only, like map_sounds.rs: `entity_input` writes here and goes on with what it was doing. Nothing in the
//! simulation reads it and it isn't part of `snapshot_bytes`, so runs simulate exactly as they did without it
//! (tools/verify/wasm-identity.ts). It is part of the saved state, so a replay seek or a practice checkpoint brings the
//! props back to what they were playing at that tick. Collision is untouched: a prop_dynamic's collision stays the
//! static model it always was (no bone followers), as in CS:S.
//!
//! CDynamicProp (game/server/props.cpp, CBaseAnimating in baseanimating.cpp):
//! * Spawn plays `DefaultAnim` from cycle 0 (PropSetAnim -> FinishSetSequence: cycle 0, playback rate 1). Every prop
//!   starts at map spawn, so props on the same sequence run in step, as in CS:S.
//! * SetAnimation plays another sequence the same way; SetDefaultAnimation only changes the name a prop goes back to
//!   when a non-looping sequence ends (AnimThink).
//! * SetPlaybackRate changes the rate from the current cycle on.
//! * TurnOff / Disable hide it, TurnOn / Enable show it (EF_NODRAW only; "these do nothing about collisions"), and
//!   StartDisabled starts it hidden. Kill removes it (`RtEnt::removed`).
//! * RandomAnimation (`m_bRandomAnimator`) props switch between their ACT_IDLE sequences at MinAnimTime..MaxAnimTime
//!   intervals instead of playing DefaultAnim. The switching itself is time-based, so the client derives it from the
//!   map, the entity and the visual time (apps/web/src/map-props.ts `RandomAnimator`); this only tracks whether the
//!   map's I/O has since set a sequence (`PROP_ANIM_SET`), which the client then follows instead.
//!
//! Sequence lengths, loop flags and activity lookups live in the model, so the client turns sequence time into cycles.

use super::Game;
use crate::entities::Entity;

/// `prop_anim_states` flags.
pub const PROP_ANIM_HIDDEN: u32 = 1;
pub const PROP_ANIM_REMOVED: u32 = 2;
/// The map's I/O set a sequence (SetAnimation): a RandomAnimation prop follows that from then on.
pub const PROP_ANIM_SET: u32 = 4;

#[derive(Clone, Debug)]
pub struct PropAnim {
    /// Entity index (`Game::entities` order).
    pub ent: u32,
    /// The sequence playing (a sequence or activity name, as the map wrote it).
    pub anim: String,
    /// What a non-looping sequence goes back to when it ends (empty: it holds its last frame).
    pub default_anim: String,
    /// Sequence time in ticks (already scaled by the playback rate) at `since_tick`.
    pub base: f32,
    pub since_tick: u32,
    pub rate: f32,
    /// EF_NODRAW.
    pub hidden: bool,
    /// SetAnimation has been received (`PROP_ANIM_SET`).
    pub set: bool,
    pub body: u32,
    pub skin: i32,
}

#[derive(Clone, Debug, Default)]
pub struct PropAnims {
    /// In entity order.
    pub props: Vec<PropAnim>,
}

const ANIM_INPUTS: [&str; 12] = ["setanimation", "setdefaultanimation", "setplaybackrate", "setanimationnoreset", "kill", "killhierarchy", "turnoff", "turnon", "disable", "enable", "setbodygroup", "skin"];

/// Props that need their own presentation state: animation, initial hiding, or visibility/body I/O.
/// A static batch cannot remove a single killed prop.
fn animated(e: &Entity, io_targets: &[String]) -> bool {
    if e.classname() == "info_particle_system" { return true; }
    if !e.classname().to_ascii_lowercase().starts_with("prop_dynamic") {
        return false;
    }
    if e.get("DefaultAnim").is_some_and(|a| !a.trim().is_empty()) || e.int("RandomAnimation") != 0 || e.int("StartDisabled") != 0 {
        return true;
    }
    let name = e.get("targetname").unwrap_or("");
    !name.is_empty() && io_targets.iter().any(|t| super::name_matches(t, name))
}

impl PropAnims {
    pub fn new(entities: &[Entity], outputs: &[&[crate::entities::Output]]) -> Self {
        let io_targets: Vec<String> = outputs
            .iter()
            .flat_map(|o| o.iter())
            .filter(|o| ANIM_INPUTS.iter().any(|i| o.input.eq_ignore_ascii_case(i)))
            .map(|o| o.target.to_string())
            .collect();
        let props = entities
            .iter()
            .enumerate()
            .filter(|(_, e)| animated(e, &io_targets))
            .map(|(i, e)| {
                PropAnim::new(i, e)
            })
            .collect();
        Self { props }
    }

    pub fn contains(&self, ent: usize) -> bool {
        self.props.binary_search_by_key(&(ent as u32), |p| p.ent).is_ok()
    }
}

impl PropAnim {
    fn new(i: usize, e: &Entity) -> Self {
        let particle = e.classname() == "info_particle_system";
        let anim = e.get(if particle { "effect_name" } else { "DefaultAnim" }).unwrap_or("").trim().to_string();
        Self { ent: i as u32, default_anim: anim.clone(), anim, base: 0.0, since_tick: 0,
            rate: 1.0, hidden: if particle { e.int("start_active") == 0 } else { e.int("StartDisabled") != 0 },
            set: particle && e.int("start_active") != 0,
            body: e.int("SetBodyGroup").max(0) as u32, skin: e.int("skin") as i32 }
    }

    /// Sequence time (ticks) at `tick`.
    fn time_at(&self, tick: u32) -> f32 {
        self.base + tick.saturating_sub(self.since_tick) as f32 * self.rate
    }

    fn input(&mut self, input: &str, param: &str, tick: u32) {
        match input {
            // PropSetAnim -> FinishSetSequence: cycle 0, rate 1. SetAnimationNoReset (later engines) only differs when
            // the sequence is already playing.
            "setanimation" | "setanimationnoreset" => {
                let anim = param.trim();
                if input == "setanimationnoreset" && anim.eq_ignore_ascii_case(&self.anim) {
                    return;
                }
                self.anim = anim.to_string();
                (self.base, self.since_tick, self.rate) = (0.0, tick, 1.0);
                self.set = true;
            }
            "setdefaultanimation" => self.default_anim = param.trim().to_string(),
            "setplaybackrate" => {
                let rate = param.trim().parse::<f32>().unwrap_or(0.0);
                self.base = self.time_at(tick);
                self.since_tick = tick;
                self.rate = if rate.is_finite() { rate } else { 0.0 };
            }
            "start" => { self.since_tick = tick; self.base = 0.0; self.set = true; self.hidden = false; },
            "stop" | "stopplayendcap" | "destroyparticles" => self.hidden = true,
            "setbodygroup" => self.body = param.trim().parse::<u32>().unwrap_or(0),
            "skin" => self.skin = param.trim().parse::<i32>().unwrap_or(0).max(0),
            "turnoff" | "disable" => self.hidden = true,
            "turnon" | "enable" => self.hidden = false,
            _ => {}
        }
    }
}

impl Game {
    /// Display-only registration of a maker copy, including reuse of a dead slot.
    pub(super) fn prop_anim_spawn(&mut self, i: usize) {
        let e = &self.entities[i];
        if e.classname() != "info_particle_system" {
            if let Ok(at) = self.prop_anims.props.binary_search_by_key(&(i as u32), |p| p.ent) {
                self.prop_anims.props.remove(at);
                self.prop_anim_serial = self.prop_anim_serial.wrapping_add(1);
            }
            return;
        }
        let mut p = PropAnim::new(i, e);
        p.since_tick = self.tick;
        match self.prop_anims.props.binary_search_by_key(&(i as u32), |p| p.ent) {
            Ok(at) => self.prop_anims.props[at] = p,
            Err(at) => self.prop_anims.props.insert(at, p),
        }
        self.prop_anim_serial = self.prop_anim_serial.wrapping_add(1);
    }

    /// Called for every input an entity receives, before it is handled. Changes nothing but `prop_anims`.
    pub(super) fn prop_anim_input(&mut self, i: usize, input: &str, param: &str) {
        if !matches!(input, "setanimation" | "setanimationnoreset" | "setdefaultanimation" | "setplaybackrate" | "turnoff" | "turnon" | "disable" | "enable" | "setbodygroup" | "skin" | "start" | "stop" | "stopplayendcap" | "destroyparticles") {
            return;
        }
        let Ok(at) = self.prop_anims.props.binary_search_by_key(&(i as u32), |p| p.ent) else { return };
        let tick = self.tick;
        self.prop_anims.props[at].input(input, param, tick);
        self.prop_anim_serial = self.prop_anim_serial.wrapping_add(1);
    }

    /// Animated props (entity order) with their flags (`PROP_ANIM_*`) and sequence time now:
    /// (prop, flags, base seconds, since seconds, rate); sequence seconds at time t = base + (t - since) * rate.
    pub fn prop_anim_states(&self) -> impl Iterator<Item = (&PropAnim, u32, f32, f32, f32)> + '_ {
        let dt = self.settings.tick_interval;
        self.prop_anims.props.iter().map(move |p| {
            let removed = self.ents.get(p.ent as usize).is_none_or(|e| e.removed);
            let flags = (p.hidden as u32 * PROP_ANIM_HIDDEN) | (removed as u32 * PROP_ANIM_REMOVED) | (p.set as u32 * PROP_ANIM_SET);
            (p, flags, p.base * dt, p.since_tick as f32 * dt, p.rate)
        })
    }

    /// Bumped whenever `prop_anim_states` may read differently (inputs, Kill, reset, state restore).
    pub fn prop_anim_serial(&self) -> u32 {
        // Kill only flips `removed`, which the inputs above don't see: fold which props are removed in.
        let removed = self.prop_anims.props.iter().filter(|p| self.ents.get(p.ent as usize).is_none_or(|e| e.removed)).fold(0u32, |h, p| h.wrapping_add((p.ent + 1).wrapping_mul(0x9e37_79b9)));
        self.prop_anim_serial.wrapping_add(removed)
    }

    /// Whether entity `index` is an animated prop (drawn on its own, see `render_props`).
    pub fn is_animated_prop(&self, index: usize) -> bool {
        self.prop_anims.contains(index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_kill_targets_wildcards_and_start_disabled_props_get_owners() {
        let list = crate::entities::parse_with_outputs(r#"{ "classname" "prop_dynamic" "targetname" "crate_1" }
            { "classname" "prop_dynamic" "targetname" "crate_2" }
            { "classname" "prop_dynamic" "StartDisabled" "1" }
            { "classname" "prop_dynamic" "targetname" "decoration" }
            { "classname" "logic_relay" "OnTrigger" "crate_*,Kill,,0,-1" }"#, true);
        let outputs: Vec<&[crate::entities::Output]> = list.outputs.iter().map(|v|v.as_slice()).collect();
        let props = PropAnims::new(&list.entities, &outputs);
        assert!(props.contains(0) && props.contains(1) && props.contains(2));
        assert!(!props.contains(3));assert!(props.props[2].hidden);
    }

    #[test]
    fn rate_changes_keep_the_cycle() {
        let mut p = PropAnim { ent: 0, anim: "idle".into(), default_anim: "idle".into(), base: 0.0, since_tick: 0, rate: 1.0, hidden: false, set: false, body: 0, skin: 0 };
        p.input("setplaybackrate", "2", 100);
        assert_eq!(p.time_at(100), 100.0);
        assert_eq!(p.time_at(110), 120.0);
        p.input("setplaybackrate", "0", 110);
        assert_eq!(p.time_at(500), 120.0);
        p.input("setanimation", "open", 600);
        assert_eq!((p.anim.as_str(), p.time_at(600), p.rate, p.set), ("open", 0.0, 1.0, true));
        p.input("setdefaultanimation", " closed ", 601);
        assert_eq!(p.default_anim, "closed");
        p.input("turnoff", "", 602);
        assert!(p.hidden);
        p.input("enable", "", 603);
        assert!(!p.hidden);
    }
}
