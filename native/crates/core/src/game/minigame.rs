//! Map game logic entities (physics v4, `PHYSICS_FIX_GAME_ENTITIES`): point_template and game_ui.
//!
//! point_template (CPointTemplate): the entities named by Template01..16 are templates. Without spawnflag 1
//! ("don't remove template entities") they are not in the world until a `ForceSpawn`. `ForceSpawn` puts a fresh copy
//! of each into the world (from its map-spawn state) and fires OnEntitySpawned. Without spawnflag 2 ("preserve
//! names") the copies get the SDK's name fixup (`name&0001`, numbered per spawn) and the copies' outputs that target
//! each other follow it. v5 / v6 rename every named template entity; the SDK (`Templates_ReconnectIOForGroup`,
//! TemplateEntities.cpp) renames only those whose name a keyvalue of an entity in the same template targets (an
//! output's target field, or a whole value), so a lone template entity keeps its name and the map's outputs still
//! reach the respawned copy. v7 (`PHYSICS_FIX_TEMPLATE_NAMES`) does that: bhop_monster_jam's `bw` / `db` walls
//! (point_templates `tbw` / `tdi`, respawned 15 s / 23 s after map start) break when their buttons fire `bw,Break` /
//! `db,Break`; v5 / v6 rename them `bw&0001` / `db&0002`, so they stay solid.
//!
//! Simplification: one copy of each template entity exists at a time (a second ForceSpawn
//! respawns it), which is what the maps that use it need (bhop_lost_world's boxes and guns: Kill, then ForceSpawn;
//! bhop_badges(_mini)'s gun spawners: a held gun is a separate inventory item, so a respawned floor copy and a held
//! one coexist).
//!
//! game_ui (CGameUI): `Activate` (the activator or the named player) hands the player's buttons to the map: every
//! tick (its Think, after the player) changed IN_FORWARD / IN_BACK / IN_MOVELEFT / IN_MOVERIGHT / IN_ATTACK /
//! IN_ATTACK2 fire Pressed* / Unpressed*; PlayerOn / PlayerOff on (de)activation. Spawnflags: 32 freezes the player
//! (FL_ATCONTROLS: forward/side move zeroed in the movement), 64 hides the weapon (the active weapon can't attack),
//! 128 / 256: +use / +jump pressed deactivates. FieldOfView > -1 deactivates when the player looks away. Not
//! simulated: the XAxis / YAxis / AttackAxis outputs.

use super::*;

/// game_ui spawnflags.
const SF_GAMEUI_FREEZE_PLAYER: i64 = 32;
const SF_GAMEUI_USE_DEACTIVATES: i64 = 128;
const SF_GAMEUI_JUMP_DEACTIVATES: i64 = 256;

/// The game_ui in control of the player (v4).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct ActiveUi {
    pub ent: usize,
    /// m_nLastButtonState (None until the first Think: m_bForceUpdate).
    pub last: Option<u32>,
}

/// A point_template and its template entities (at load).
#[derive(Clone, Debug)]
pub(super) struct Template {
    /// The point_template.
    pub ent: usize,
    /// Its template entities (Template01..16 names).
    pub members: Vec<usize>,
    /// The members the SDK's name fixup renames (`Templates_ReconnectIOForGroup`): those whose targetname a keyvalue of
    /// a member targets.
    pub fixup: Vec<usize>,
}

impl Game {
    /// Template entity indices per point_template (by Template01..16 names, at load).
    pub(super) fn link_templates(&mut self) {
        for i in 0..self.ents.len() {
            if self.ents[i].class != "point_template" {
                continue;
            }
            let names: Vec<String> = (1..=16)
                .filter_map(|n| self.entities[i].get(&format!("Template{n:02}")).filter(|s| !s.trim().is_empty()).map(|s| s.trim().to_string()))
                .collect();
            let members: Vec<usize> = (0..self.ents.len())
                .filter(|&j| j != i && !self.ents[j].name.is_empty() && names.iter().any(|n| n.eq_ignore_ascii_case(&self.ents[j].name)))
                .collect();
            if !members.is_empty() {
                let fixup = self.template_fixup_members(&members);
                self.templates.push(Template { ent: i, members, fixup });
            }
        }
    }

    /// `Templates_ReconnectIOForGroup`: every keyvalue of every member but its targetname is clipped to its target field
    /// (up to the first ESC, else the first ','; the whole value without either) and compared case-insensitively with
    /// the members' names; a match marks that member for name fixup.
    fn template_fixup_members(&self, members: &[usize]) -> Vec<usize> {
        let mut fixup = Vec::new();
        for &j in members {
            for (key, value) in &self.entities[j].pairs {
                if key.eq_ignore_ascii_case("targetname") {
                    continue;
                }
                let target = match value.find('\u{1b}').or_else(|| value.find(',')) {
                    Some(n) => &value[..n],
                    None => value.as_str(),
                };
                for &m in members {
                    if !fixup.contains(&m) && target.eq_ignore_ascii_case(&self.ents[m].name) {
                        fixup.push(m);
                    }
                }
            }
        }
        fixup
    }

    /// Map spawn (v4): template entities of point_templates without spawnflag 1 are not in the world.
    pub(super) fn remove_templates(&mut self) {
        for k in 0..self.templates.len() {
            let t = self.templates[k].ent;
            if self.entities[t].int("spawnflags") & 1 != 0 {
                continue;
            }
            for j in self.templates[k].members.clone() {
                self.ents[j].removed = true;
            }
        }
    }

    /// point_template ForceSpawn.
    pub(super) fn force_spawn(&mut self, t: usize, activator: Actor) {
        let Some(template) = self.templates.iter().find(|x| x.ent == t).cloned() else { return };
        let members = template.members;
        let fixup = self.entities[t].int("spawnflags") & 2 == 0;
        // v5 / v6 rename every named member; v7 only those the SDK fixes up.
        let sdk_names = self.settings.physics_fixes() & PHYSICS_FIX_TEMPLATE_NAMES != 0;
        let mut renames: Vec<(String, String)> = Vec::new();
        if fixup {
            self.extra.template_instances += 1;
        }
        // A respawned weapon is a new one: a silenced USP dropped into that entity before is gone (v7).
        if !self.arms.floor_silenced.is_empty() {
            self.arms.floor_silenced.retain(|e| !members.contains(e));
        }
        for &j in &members {
            let mut fresh = self.initial_ents[j].clone();
            fresh.removed = false;
            // Keep the current parent links (the hierarchy is resolved once, at load).
            fresh.parent = self.ents[j].parent;
            fresh.children = self.ents[j].children.clone();
            if fixup && !fresh.name.is_empty() && (!sdk_names || template.fixup.contains(&j)) {
                let renamed = format!("{}&{:04}", self.initial_ents[j].name, self.extra.template_instances);
                renames.push((self.initial_ents[j].name.clone(), renamed.clone()));
                fresh.name = renamed;
            }
            self.ents[j] = fresh;
        }
        if !renames.is_empty() {
            for &j in &members {
                let outputs = std::sync::Arc::make_mut(&mut self.ents[j].outputs);
                for o in outputs.iter_mut() {
                    if let Some((_, new)) = renames.iter().find(|(old, _)| old.eq_ignore_ascii_case(&o.target)) {
                        o.target = std::sync::Arc::from(new.as_str());
                    }
                }
            }
        }
        for &j in &members {
            if self.ents[j].parent.is_some() {
                self.relink(j);
            }
            // A fresh entity: a respawned breakable has its full health again and can be stood on again.
            self.extra.breakable_health.remove(&j);
            self.extra.pressure_breaks.remove(&j);
        }
        self.rebuild_solid();
        self.fire_output(t, "onentityspawned", activator);
    }

    /// game_ui inputs (v4). Returns true when handled.
    pub(super) fn game_ui_input(&mut self, i: usize, input: &str, param: &str, activator: Actor) -> bool {
        match input {
            "activate" => {
                let player = if param.trim().is_empty() {
                    activator == Actor::Player
                } else {
                    self.resolve_targets(param.trim(), activator, Actor::Entity(i)).contains(&Actor::Player)
                };
                if !player {
                    return true;
                }
                if let Some(ui) = self.extra.game_ui {
                    if ui.ent == i {
                        return true;
                    }
                    // One player: another game_ui already has them; CS:S lets both run. Keep the newest.
                    self.game_ui_deactivate();
                }
                self.extra.game_ui = Some(ActiveUi { ent: i, last: None });
                self.fire_output(i, "playeron", Actor::Player);
                true
            }
            "deactivate" => {
                if self.extra.game_ui.is_some_and(|ui| ui.ent == i) {
                    self.game_ui_deactivate();
                }
                true
            }
            _ => false,
        }
    }

    fn game_ui_deactivate(&mut self) {
        if let Some(ui) = self.extra.game_ui.take() {
            self.fire_output(ui.ent, "playeroff", Actor::Player);
        }
    }

    /// The player is frozen by a game_ui (FL_ATCONTROLS).
    pub(super) fn at_controls(&self) -> bool {
        self.extra.game_ui.is_some_and(|ui| self.entities[ui.ent].int("spawnflags") & SF_GAMEUI_FREEZE_PLAYER != 0)
    }

    /// The player's weapon is holstered by a game_ui (SF_GAMEUI_HIDE_WEAPON).
    pub(super) fn weapon_hidden(&self) -> bool {
        self.extra.game_ui.is_some_and(|ui| self.entities[ui.ent].int("spawnflags") & 64 != 0)
    }

    /// CGameUI::Think, after the player's command (entity thinks, server clock).
    pub(super) fn game_ui_think(&mut self, cmd: Cmd, pressed: u32) {
        let Some(ui) = self.extra.game_ui else { return };
        let i = ui.ent;
        if self.ents[i].removed {
            self.extra.game_ui = None;
            return;
        }
        let buttons = cmd.buttons;
        let last = ui.last.unwrap_or(buttons);
        let fov = self.entities[i].float("FieldOfView").unwrap_or(-1.0);
        if fov > -1.0 {
            let (sp, cp) = playsrc_collision::math::sin_cos(cmd.pitch.to_radians());
            let (sy, cy) = playsrc_collision::math::sin_cos(cmd.yaw.to_radians());
            let facing = [cp * cy, cp * sy, -sp];
            let p = self.state.position;
            let center = [p[0], p[1], p[2] + self.current_hull().maxs[2] * 0.5];
            let o = self.ents[i].origin;
            let d = [o[0] - center[0], o[1] - center[1], o[2] - center[2]];
            let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt().max(1e-6);
            if (facing[0] * d[0] + facing[1] * d[1] + facing[2] * d[2]) / len < fov {
                self.game_ui_deactivate();
                return;
            }
        }
        let sf = self.entities[i].int("spawnflags");
        if (pressed & IN_USE != 0 && sf & SF_GAMEUI_USE_DEACTIVATES != 0) || (pressed & IN_JUMP != 0 && sf & SF_GAMEUI_JUMP_DEACTIVATES != 0) {
            self.game_ui_deactivate();
            return;
        }
        const IN_MOVELEFT: u32 = 1 << 9;
        const IN_MOVERIGHT: u32 = 1 << 10;
        const IN_FORWARD: u32 = 1 << 3;
        const IN_BACK: u32 = 1 << 4;
        let changed = buttons ^ last;
        for (bit, name) in [
            (IN_MOVERIGHT, "moveright"),
            (IN_MOVELEFT, "moveleft"),
            (IN_FORWARD, "forward"),
            (IN_BACK, "back"),
            (IN_ATTACK, "attack"),
            (IN_ATTACK2, "attack2"),
        ] {
            if changed & bit != 0 {
                let event = if last & bit != 0 { format!("unpressed{name}") } else { format!("pressed{name}") };
                self.fire_output(i, &event, Actor::Player);
            }
        }
        if let Some(ui) = self.extra.game_ui.as_mut() {
            ui.last = Some(buttons);
        }
    }
}
