//! Physics v16 (`PHYSICS_FIX_MAP_PLAYER_IO`), maps in `map_fixes::NONLINEAR_OBJECTIVES` only: a native emulation of
//! DanZay's VScript "non-linear objective" system (`scripts/vscripts/danzay/nonlinear*.nut`, packed in the map), not a
//! VScript interpreter. research/COOKSASSISTANT-1025.md has the scripts and how each line maps to this file.
//!
//! - A trigger with `vscripts danzay/nonlinear_<role>.nut` connects its OnStartTouch to the script's `OnStartTouch`
//!   (`self.ConnectOutput("OnStartTouch", "OnStartTouch")`). In Source that adds an event action
//!   `!self,CallScriptFunction,OnStartTouch` (delay 0) to the output, so the function runs when the event queue is
//!   serviced, with the toucher as activator, like any output (a touch output is on the player's clock, so at 100 tick
//!   it runs 6 ticks after the touch, `Game::player_clock_lead`). `Game::touch_triggers_at` queues that event
//!   (`script_start_touch`) and `entity_input` runs it (`call_script_function`).
//! - The functions run in the player's script scope, where `nl_collectedObjectives` holds the objective triggers
//!   touched (each once). Here that is `Extra::objectives` (entity indices in the order collected): saved with the game
//!   state, cleared on reset and respawn.
//! - `!activator,RunScriptFile,danzay/nonlinear.nut` (the start room's `*9`) re-runs `nl_collectedObjectives <- []`:
//!   the list starts empty again (`run_script_file`).
//!
//! Roles: objective (add itself to the list if absent), reset (clear the list), teleport gate and rebound gate (named
//! the number of objectives required; with fewer, the teleport gate puts the player at the gate entity's origin with
//! zero velocity, the rebound gate sets one velocity component to +-500 away from the face the player came from).
//! Messages and sounds (`PrintGameText`, `PlaySound`) are cosmetic and not emulated.

use super::*;

/// `const nl_reboundVelocity = 500` (nonlinear.nut): the speed a rebound gate sets.
const REBOUND_VELOCITY: f32 = 500.0;

/// What a scripted trigger's `vscripts` file does on OnStartTouch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ScriptRole {
    /// nonlinear_objective.nut -> `OnObjectiveTouch(self)`.
    Objective,
    /// nonlinear_reset.nut -> `ResetObjectivesCollected()`.
    Reset,
    /// nonlinear_gate_teleport.nut -> `OnObjectiveGateTeleportTouch(self)`.
    GateTeleport,
    /// nonlinear_gate_rebound.nut -> `OnObjectiveGateReboundTouch(self)`.
    GateRebound,
}

impl ScriptRole {
    /// The role of a trigger by its `vscripts` keyvalue (exactly one of the four scripts).
    pub(super) fn of(entity: &Entity) -> Option<Self> {
        let script = entity.get("vscripts")?.trim().to_ascii_lowercase();
        Some(match script.strip_suffix(".nut").unwrap_or(&script) {
            "danzay/nonlinear_objective" => Self::Objective,
            "danzay/nonlinear_reset" => Self::Reset,
            "danzay/nonlinear_gate_teleport" => Self::GateTeleport,
            "danzay/nonlinear_gate_rebound" => Self::GateRebound,
            _ => return None,
        })
    }
}

/// The scripted triggers of a `NONLINEAR_OBJECTIVES` map (entity index, role), in entity order; empty elsewhere.
pub(super) fn script_triggers(entities: &[Entity]) -> Vec<(usize, ScriptRole)> {
    if map_fixes::nonlinear_objectives(entities).is_none() {
        return Vec::new();
    }
    entities
        .iter()
        .enumerate()
        .filter(|(_, e)| e.classname().eq_ignore_ascii_case("trigger_multiple"))
        .filter_map(|(i, e)| ScriptRole::of(e).map(|r| (i, r)))
        .collect()
}

impl Game {
    /// v16 on a `NONLINEAR_OBJECTIVES` map: the objective scripts run.
    pub(super) fn objectives_on(&self) -> bool {
        !self.script_triggers.is_empty() && self.settings.physics_fixes() & PHYSICS_FIX_MAP_PLAYER_IO != 0
    }

    fn script_role(&self, i: usize) -> Option<ScriptRole> {
        self.script_triggers.iter().find(|(j, _)| *j == i).map(|(_, r)| *r)
    }

    /// OnStartTouch of trigger `i` by the player: the event action `ConnectOutput` added
    /// (`!self,CallScriptFunction,OnStartTouch`, delay 0, activator = the player, caller = the trigger).
    pub(super) fn script_start_touch(&mut self, i: usize) {
        if !self.objectives_on() || self.script_role(i).is_none() {
            return;
        }
        self.seq += 1;
        self.queue.push(QueuedEvent {
            fire_time: self.io_time,
            seq: self.seq,
            target: "!self".into(),
            input: "CallScriptFunction".into(),
            param: "OnStartTouch".into(),
            activator: Actor::Player,
            caller: Actor::Entity(i),
        });
    }

    /// `CallScriptFunction OnStartTouch` on scripted trigger `i`: the script's function, in the activator's scope
    /// (`activator.GetScriptScope()`). Returns false if `i` has no script (the input is then not handled here).
    pub(super) fn call_script_function(&mut self, i: usize, param: &str, activator: Actor) -> bool {
        let Some(role) = self.script_role(i) else { return false };
        // Only the player has the objective scope (the script errors for anything else).
        if activator != Actor::Player || !param.trim().eq_ignore_ascii_case("onstarttouch") {
            return true;
        }
        let collected = self.extra.objectives.len();
        // `touchedGate.GetName().tointeger()`: a name that isn't an integer throws, and nothing happens.
        let required = || self.ents[i].name.trim().parse::<i64>().ok();
        match role {
            ScriptRole::Objective => {
                // OnObjectiveTouch: IsInArray (same handle) -> "already got this ingredient"; else append.
                let id = i as u32;
                if !self.extra.objectives.contains(&id) {
                    self.extra.objectives.push(id);
                }
            }
            ScriptRole::Reset => self.extra.objectives.clear(),
            ScriptRole::GateTeleport => {
                if required().is_some_and(|n| (collected as i64) < n) {
                    // TeleportPlayerTo(touchedGate): self.SetOrigin(destEntity.GetOrigin()); SetVelocityToZero(self).
                    // The gate entity's origin, not its brush: on bhop_cooksassistant it sits 160+ units outside the
                    // doorway, so the player is put back in front of the door.
                    self.state.position = self.ents[i].origin;
                    self.state.ground = None;
                    self.events |= EVENT_TELEPORTED;
                    self.teleport_angles = self.last_angles;
                    self.unstick();
                    self.state.velocity = [0.0; 3];
                }
            }
            ScriptRole::GateRebound => {
                if required().is_some_and(|n| (collected as i64) < n) {
                    self.rebound(i);
                }
            }
        }
        true
    }

    /// misc.nut `Rebound(touchedTrigger)`: compares the player's centre with the gate's centre +- its bounding maxs
    /// (`GetBoundingMaxs`: the collision OBB's maxs, model-local; the engine spreads a brush model's bounds by 1 unit,
    /// `Mod_LoadSubmodels`) on -x, +x, -y, +y, -z in that order (else +z) and sets that velocity component to +-500,
    /// keeping the others (`SetVelocity`, ground untouched).
    fn rebound(&mut self, gate: usize) {
        let Some(b) = &self.ents[gate].brush else { return };
        let origin = b.origin;
        let bounds = [b.maxs[0] + 1.0, b.maxs[1] + 1.0, b.maxs[2] + 1.0];
        let center: [f32; 3] = std::array::from_fn(|k| origin[k] + (b.mins[k] + b.maxs[k]) * 0.5);
        let hull = self.current_hull();
        let p = self.state.position;
        let player: [f32; 3] = std::array::from_fn(|k| p[k] + (hull.mins[k] + hull.maxs[k]) * 0.5);
        let v = &mut self.state.velocity;
        if player[0] < center[0] - bounds[0] {
            v[0] = -REBOUND_VELOCITY;
        } else if player[0] > center[0] + bounds[0] {
            v[0] = REBOUND_VELOCITY;
        } else if player[1] < center[1] - bounds[1] {
            v[1] = -REBOUND_VELOCITY;
        } else if player[1] > center[1] + bounds[1] {
            v[1] = REBOUND_VELOCITY;
        } else if player[2] < center[2] - bounds[2] {
            v[2] = -REBOUND_VELOCITY;
        } else {
            v[2] = REBOUND_VELOCITY;
        }
    }

    /// `!activator,RunScriptFile,<file>` on the player. danzay/nonlinear.nut (re)creates the scope's
    /// `nl_collectedObjectives <- []`; misc.nut and nonlinear_resource.nut only define functions and strings.
    pub(super) fn run_script_file(&mut self, file: &str) {
        let file = file.trim().to_ascii_lowercase();
        if file.strip_suffix(".nut").unwrap_or(&file) == "danzay/nonlinear" {
            self.extra.objectives.clear();
        }
    }

    /// The objective triggers collected so far (entity indices, in order) on a `NONLINEAR_OBJECTIVES` map (tests,
    /// tools, the client HUD).
    pub fn objectives_collected(&self) -> &[u32] {
        &self.extra.objectives
    }

    /// The map's objective triggers (entity indices), if it is a `NONLINEAR_OBJECTIVES` map (tests, tools).
    pub fn objective_triggers(&self) -> Vec<usize> {
        self.script_triggers.iter().filter(|(_, r)| *r == ScriptRole::Objective).map(|(i, _)| *i).collect()
    }
}
