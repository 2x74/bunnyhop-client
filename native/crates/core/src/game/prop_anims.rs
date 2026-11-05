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
//!
//! Sequence lengths, loop flags and activity lookups live in the model, so the client turns sequence time into cycles.

use super::Game;
use crate::entities::Entity;

/// `prop_anim_states` flags.
pub const PROP_ANIM_HIDDEN: u32 = 1;
pub const PROP_ANIM_REMOVED: u32 = 2;

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
}

#[derive(Clone, Debug, Default)]
pub struct PropAnims {
    /// In entity order.
    pub props: Vec<PropAnim>,
}

const ANIM_INPUTS: [&str; 4] = ["setanimation", "setdefaultanimation", "setplaybackrate", "setanimationnoreset"];

/// Whether `e` is a prop_dynamic the client animates: it has a DefaultAnim, or the map's I/O sends it an animation input.
fn animated(e: &Entity, io_targets: &[String]) -> bool {
    if !e.classname().to_ascii_lowercase().starts_with("prop_dynamic") {
        return false;
    }
    if e.get("DefaultAnim").is_some_and(|a| !a.trim().is_empty()) {
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
                let anim = e.get("DefaultAnim").unwrap_or("").trim().to_string();
                PropAnim { ent: i as u32, default_anim: anim.clone(), anim, base: 0.0, since_tick: 0, rate: 1.0, hidden: e.int("StartDisabled") != 0 }
            })
            .collect();
        Self { props }
    }

    pub fn contains(&self, ent: usize) -> bool {
        self.props.binary_search_by_key(&(ent as u32), |p| p.ent).is_ok()
    }
}

impl PropAnim {
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
            }
            "setdefaultanimation" => self.default_anim = param.trim().to_string(),
            "setplaybackrate" => {
                let rate = param.trim().parse::<f32>().unwrap_or(0.0);
                self.base = self.time_at(tick);
                self.since_tick = tick;
                self.rate = if rate.is_finite() { rate } else { 0.0 };
            }
            "turnoff" | "disable" => self.hidden = true,
            "turnon" | "enable" => self.hidden = false,
            _ => {}
        }
    }
}

impl Game {
    /// Called for every input an entity receives, before it is handled. Changes nothing but `prop_anims`.
    pub(super) fn prop_anim_input(&mut self, i: usize, input: &str, param: &str) {
        if !matches!(input, "setanimation" | "setanimationnoreset" | "setdefaultanimation" | "setplaybackrate" | "turnoff" | "turnon" | "disable" | "enable") {
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
            let flags = (p.hidden as u32 * PROP_ANIM_HIDDEN) | (removed as u32 * PROP_ANIM_REMOVED);
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
    fn rate_changes_keep_the_cycle() {
        let mut p = PropAnim { ent: 0, anim: "idle".into(), default_anim: "idle".into(), base: 0.0, since_tick: 0, rate: 1.0, hidden: false };
        p.input("setplaybackrate", "2", 100);
        assert_eq!(p.time_at(100), 100.0);
        assert_eq!(p.time_at(110), 120.0);
        p.input("setplaybackrate", "0", 110);
        assert_eq!(p.time_at(500), 120.0);
        p.input("setanimation", "open", 600);
        assert_eq!((p.anim.as_str(), p.time_at(600), p.rate), ("open", 0.0, 1.0));
        p.input("setdefaultanimation", " closed ", 601);
        assert_eq!(p.default_anim, "closed");
        p.input("turnoff", "", 602);
        assert!(p.hidden);
        p.input("enable", "", 603);
        assert!(!p.hidden);
    }
}
