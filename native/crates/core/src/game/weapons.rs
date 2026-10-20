//! The player's weapons (the knife from physics v4, guns from v5). CS:S `CWeaponCSBase::ItemPostFrame` runs from
//! `CBasePlayer::PostThink` after the command's movement and touches, on the player's clock. The client contract (ids,
//! inputs, reports, floor items) is research/WEAPONS.md.
//!
//! The knife (`PHYSICS_FIX_KNIFE`): CS:S `CKnife::PrimaryAttack` / `SecondaryAttack` -> `SwingOrStab` (cstrike
//! weapon_knife.cpp).
//! - +attack2 (stab, 32u) has priority over +attack (swing, 48u) when both are held and the knife is ready.
//! - A line trace from the eye (`Weapon_ShootPosition`) along the view, MASK_SOLID; on a miss a head-hull box trace
//!   (+-16, +-16, +-18), refined by `FindHullIntersection` (line traces to the duck-hull corners around the box hit)
//!   when it hit the world or a brush entity.
//! - The next attack is ready 0.5 s (swing hit) / 0.4 s (swing miss) / 1.1 s (stab hit) / 1.0 s (stab miss) later;
//!   every swing and stab sets both the primary and the secondary time. Holding the button attacks again then.
//!
//! Guns (`PHYSICS_FIX_WEAPONS`), like on a CS:S server:
//! - The inventory has a primary, a secondary and the knife. A spawn gives the knife only. `weapon_*` entities are
//!   picked up on touch into an empty slot (`CCSPlayer::BumpWeapon`; the weapon's box bloated by 36 units like
//!   `UseTriggerBounds`), `game_player_equip` (Use) gives its listed weapons, `player_weaponstrip` (Strip) takes all.
//!   A new weapon becomes active when it outranks the active one (`FShouldSwitchWeapon`: primary > secondary > knife).
//! - A picked-up weapon loses its targetname (`CBaseCombatWeapon::OnPickedUp`: SetName(NULL_STRING), "we don't want
//!   to delete weapons the player has picked up"): bhop_badges' `gunN,Kill` 5 s after a spawner fires only removes
//!   the copy still lying there. A drop puts the same entity back on the floor, nameless; if the map has respawned a
//!   new copy into that entity meanwhile, the dropped gun just disappears.
//! - Buttons bits 14..15 request a slot (1 primary, 2 secondary, 3 knife), bit 12 drops the active gun, bit 13 is
//!   IN_RELOAD. A switch (deploy) delays the next attack by 1 s and cancels a reload.
//! - Shots: one line trace from the eye along the view with `CS_MASK_SHOOT` (MASK_SOLID | DEBRIS), the weapon's range;
//!   damage `damage * pellets * rangeModifier ^ (distance / 500)`. No spread, recoil or penetration (deterministic;
//!   shotgun pellets follow the centre line). Cycle times, clip sizes and reload times from the CS:S weapon scripts;
//!   reserve ammo is infinite. Pistols fire once per click (`m_iShotsFired`); the others repeat while held. An empty
//!   clip dry-fires while attack is held and reloads itself once both attack buttons are released
//!   (`ReloadOrSwitchWeapons`). Shotguns load shell by shell; a shot interrupts that once a shell is in. The Glock and
//!   the FAMAS toggle burst mode on +attack2 (3 rounds 0.1 s apart, the next burst 0.5 s later, also while held).
//!   v6 (`PHYSICS_FIX_GLOCK_BURST`, measured on srcds with tools/parity): the Glock's burst rounds go 6 ticks apart and a
//!   burst is one trigger pull, like a pistol shot (holding +attack doesn't fire the next burst; a press made before the
//!   gun is ready fires once it is). The FAMAS keeps the v5 rule (srcds differs there too: research/maps/
//!   badges-real-replays.md section 6).
//!
//! Damage (`take_damage`): `func_button` (`CBaseButton::OnTakeDamage`: OnDamaged with the button's previous activator,
//! so the first hit on a never-activated button has none (v6: the attacker, EventQueueFix); then a button with
//! SF_BUTTON_DAMAGE_ACTIVATES (512) or a health value presses, as `ButtonResponseToTouch` allows) and `func_breakable`
//! (`CBreakable::OnTakeDamage`: health > 0 and not break-on-trigger-only; OnBreak and gone at 0). Knife damage 15
//! (swing) / 65 (stab).
//!
//! Weapon commands (v7, `PHYSICS_FIX_WEAPON_COMMANDS`): bhoptimer's `Command_Weapon` (shavit-misc.sp: sm_usp, sm_glock,
//! sm_knife; the client offers any gun outside ranked runs). Buttons bits 16..20 carry a weapon id for one tick; before
//! the command's PlayerRunCommand (a console command runs between usercmds) the weapon in that slot is removed
//! (`RemovePlayerItem` + Kill), the new one given (`GivePlayerItem`: a full clip, silencer off; reserve is infinite
//! anyway, bhoptimer's `SetWeaponAmmo`) and switched to (`use weapon_x`: a deploy, 1 s). A command less than 10 ticks
//! after the last accepted one does nothing (`GetGameTickCount() - gI_LastWeaponTick < 10`).
//!
//! Restored guns (v10, `PHYSICS_FIX_WEAPON_RESTORE`): a bhop server's `!r` only resets the timer and moves the player,
//! so the gun in hand stays drawn, silencer and burst mode as they were. The core resets to the knife, so the client
//! re-gives the guns the player had on the first commands after a restart (apps/web/src/weapon-rules.ts KeptWeapons)
//! with `IN_GIVE_RESTORE` (bit 21) and, for a silenced USP or a Glock / FAMAS in burst mode, `IN_GIVE_MODE` (bit 22).
//! Such a command, accepted within `WEAPON_RESTORE_TICKS` of the reset, gives the gun as an ordinary one would, but in
//! that mode and in hand without the deploy (attacks ready at once, no silencer lock-out). Later in the attempt (or
//! before v10) the flags do nothing and the command is an ordinary one: a restore can't skip a draw or a lock-out mid-run.
//!
//! The USP's silencer (v7, `PHYSICS_FIX_USP_SILENCER`): `CWeaponUSP::SecondaryAttack` flips m_bSilencerOn at once and
//! locks both attacks for the attach / detach sequence (v_pist_usp.mdl add_silencer / detach_silencer: 115 frames at 37
//! fps, 3.08 s). It needs both attack times passed and no reload (`DefaultReload` and `DefaultDeploy` set both). Held
//! +attack2 toggles again when the lock-out ends, like CS:S. The state belongs to the weapon: a dropped USP keeps it.
//! Silenced shots use CS:S's Secondary_Mode (attack report mode 2: the quiet sound); the weapon script's damage, range
//! and range modifier are the same either way (only the spread, not simulated, has *Alt values).
//!
//! Not simulated: the knife's draw time after a (re)spawn, the CT spawn pistol, grenades, the M4A1's silencer, scopes
//! (client zoom only), weapon speeds, throwing a dropped weapon, reserve ammo.

use super::*;
use std::sync::Arc;

/// MASK_SOLID: SOLID | WINDOW | GRATE | MOVEABLE | MONSTER.
const MASK_SOLID: u32 = 0x1 | 0x2 | 0x8 | 0x4000 | 0x200_0000;
/// CS_MASK_SHOOT: MASK_SOLID | CONTENTS_DEBRIS.
const MASK_SHOOT: u32 = MASK_SOLID | 0x400_0000;
const SWING_RANGE: f32 = 48.0;
const STAB_RANGE: f32 = 32.0;
/// head_hull_mins / head_hull_maxs.
const HEAD_HULL: Hull = Hull { mins: [-16.0, -16.0, -18.0], maxs: [16.0, 16.0, 18.0] };
const POINT: Hull = Hull { mins: [0.0; 3], maxs: [0.0; 3] };
/// SF_BUTTON_DAMAGE_ACTIVATES.
const SF_BUTTON_DAMAGE_ACTIVATES: i64 = 512;
/// SF_BUTTON_TOGGLE.
const SF_BUTTON_TOGGLE: i64 = 32;
/// SF_BREAK_TRIGGER_ONLY.
const SF_BREAK_TRIGGER_ONLY: i64 = 1;
/// SF_BREAK_TOUCH: breaks when the player runs into it.
const SF_BREAK_TOUCH: i64 = 2;
/// SF_BREAK_PRESSURE: breaks `pressuredelay` s after the player stands on it.
const SF_BREAK_PRESSURE: i64 = 4;
/// SF_PHYSBOX_DEBRIS: COLLISION_GROUP_DEBRIS.
const SF_PHYSBOX_DEBRIS: i64 = 0x4000;
/// CONTENTS_DEBRIS (in CS_MASK_SHOOT, not in MASK_SOLID).
const CONTENTS_DEBRIS: u32 = 0x400_0000;
/// DMG_BULLET and DMG_NEVERGIB: the damage type of CS:S bullets (`FireBullet`) and knife hits (`SwingOrStab`).
const DMG_BULLET: i64 = 2;
const DMG_NEVERGIB: i64 = 4096;
/// Weapon draw (deploy) time after a switch, s.
const DEPLOY_TIME: f32 = 1.0;
/// Weapon touch box around a weapon entity's origin: a world model (about +-16, +-16, +-6) bloated by 36 units.
const PICKUP_HALF: [f32; 3] = [52.0, 52.0, 42.0];

/// Legacy weapon class bits (`Game::weapons`; physics v4 clients before research/WEAPONS.md).
pub const WEAPON_KNIFE: u8 = 1;
pub const WEAPON_PISTOL: u8 = 2;
pub const WEAPON_SNIPER: u8 = 4;
/// Buttons bit 12: drop the active weapon (one tick).
pub const IN_DROP: u32 = 1 << 12;
/// Buttons bit 13: IN_RELOAD (Source's bit).
pub const IN_RELOAD: u32 = 1 << 13;
/// Buttons bits 14..15: a weapon slot request (1 = primary, 2 = secondary, 3 = knife).
pub const IN_SLOT_SHIFT: u32 = 14;
pub const IN_SLOT_MASK: u32 = 3 << IN_SLOT_SHIFT;
/// Buttons bits 16..20 (v7): a weapon command for one tick, the weapon id to give (1 knife, a gun id; 0 = none).
pub const IN_GIVE_SHIFT: u32 = 16;
pub const IN_GIVE_MASK: u32 = 0x1f << IN_GIVE_SHIFT;
/// Ticks between accepted weapon commands (bhoptimer: `GetGameTickCount() - gI_LastWeaponTick[client] < 10` returns).
pub const WEAPON_COMMAND_COOLDOWN: u32 = 10;
/// Buttons bit 21 (v10): the weapon command in bits 16..20 restores a gun the player had before the restart: in hand,
/// no draw (`PHYSICS_FIX_WEAPON_RESTORE`).
pub const IN_GIVE_RESTORE: u32 = 1 << 21;
/// Buttons bit 22 (v10, with `IN_GIVE_RESTORE`): the restored gun's +attack2 mode is on: the USP's silencer, the Glock's
/// or FAMAS's burst mode.
pub const IN_GIVE_MODE: u32 = 1 << 22;
/// v10: a restore counts only on the first ticks after a reset: the client re-gives at most two guns (primary and
/// secondary), one per command cooldown, from the restart's first command (ticks 0 and 10).
pub const WEAPON_RESTORE_TICKS: u32 = 2 * WEAPON_COMMAND_COOLDOWN;
/// The USP's silencer attach / detach time, s: v_pist_usp.mdl `add_silencer` / `detach_silencer` are 115 frames at 37 fps
/// (`SequenceDuration()` = 114 / 37), read from the CS:S dedicated server's model (research/WEAPONS.md).
pub const USP_SILENCER_TIME: f32 = 114.0 / 37.0;

/// `weapon_report` flags (`EVENT_WEAPON`).
pub const WEAPON_EVENT_SWITCHED: u32 = 1;
pub const WEAPON_EVENT_PICKED_UP: u32 = 2;
pub const WEAPON_EVENT_RELOAD_STARTED: u32 = 4;
pub const WEAPON_EVENT_RELOAD_FINISHED: u32 = 8;
pub const WEAPON_EVENT_DRY_FIRE: u32 = 16;
pub const WEAPON_EVENT_DROPPED: u32 = 32;
pub const WEAPON_EVENT_LOST: u32 = 64;
pub const WEAPON_EVENT_MODE: u32 = 128;
/// v7: the USP's silencer started going on or off.
pub const WEAPON_EVENT_SILENCER: u32 = 256;
/// v7: a weapon command gave a weapon.
pub const WEAPON_EVENT_GIVEN: u32 = 512;
/// v10: that weapon command restored a gun (`IN_GIVE_RESTORE`): it is in hand without a draw (no `WEAPON_EVENT_SWITCHED`).
pub const WEAPON_EVENT_RESTORED: u32 = 1024;

/// Weapon ids (research/WEAPONS.md).
pub const KNIFE: u8 = 1;

/// `floor_report` item flags (research/WEAPONS.md "Floor weapons"): the item is in the world now, and what happened to
/// it since the previous report.
pub const FLOOR_PRESENT: u8 = 1;
pub const FLOOR_PICKED_UP: u8 = 2;
/// Appeared: a point_template ForceSpawn (or the first report / a restart).
pub const FLOOR_SPAWNED: u8 = 4;
/// The player dropped it here.
pub const FLOOR_DROPPED: u8 = 8;
/// Gone without a pickup (a Kill, the map's template spawn rules).
pub const FLOOR_REMOVED: u8 = 16;
/// Moved while lying in the world (a parent moved it, a re-drop).
pub const FLOOR_MOVED: u8 = 32;
/// weapon spawnflag 1 "Start constrained": the item stays where the map put it (no physics fall).
const SF_WEAPON_CONSTRAINED: i64 = 1;

/// A floor weapon item as last reported (`Game::floor_report`). Presentation only.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct FloorSeen {
    present: bool,
    origin: [f32; 3],
    /// Where it rests (the origin settled onto the floor below, for items CS:S physics would drop).
    rest: [f32; 3],
    /// FLOOR_PICKED_UP / FLOOR_DROPPED since the last report (set by the simulation's pickup / drop).
    marks: u8,
}

/// One floor weapon item (`Game::floor_report`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FloorItem {
    /// Entity index: stable per item (a point_template respawn and a re-drop reuse it).
    pub ent: usize,
    /// Weapon id (research/WEAPONS.md).
    pub weapon: u8,
    /// FLOOR_* flags.
    pub flags: u8,
    /// Where the item rests (Source units).
    pub position: [f32; 3],
    /// pitch, yaw, roll (degrees).
    pub angles: [f32; 3],
}

/// A gun's CS:S weapon-script numbers.
#[derive(Clone, Copy, Debug)]
pub struct Gun {
    pub id: u8,
    pub name: &'static str,
    /// 1 = primary, 2 = secondary.
    pub slot: u8,
    /// Fires once per click (pistols).
    pub semi: bool,
    pub cycle: f32,
    pub clip: u8,
    /// Full reload time, s; shotguns: (start, per shell).
    pub reload: f32,
    pub shells: Option<(f32, f32)>,
    pub damage: f32,
    pub pellets: u8,
    pub range: f32,
    pub range_modifier: f32,
    /// Burst mode on +attack2 (Glock, FAMAS): rounds 0.1 s apart, the next burst after `burst_cycle`.
    pub burst: bool,
    /// Sniper rifle (legacy WEAPON_SNIPER class).
    pub sniper: bool,
}

const fn gun(
    id: u8,
    name: &'static str,
    slot: u8,
    semi: bool,
    cycle: f32,
    clip: u8,
    reload: f32,
    damage: f32,
    range: f32,
    range_modifier: f32,
) -> Gun {
    Gun { id, name, slot, semi, cycle, clip, reload, shells: None, damage, pellets: 1, range, range_modifier, burst: false, sniper: false }
}

/// Weapon id of the Glock (`GUNS`).
const GLOCK: u8 = 2;
/// Weapon id of the USP (`GUNS`).
const USP: u8 = 3;
/// v6: ticks between a burst-mode Glock's rounds at 100 tick, measured on srcds (tools/parity, 2026-10-07: rounds on
/// commands n, n + 6, n + 12 wherever the burst starts; the next burst 50 ticks after the first round).
const GLOCK_BURST_ROUND_TICKS: u32 = 6;

/// CS:S weapons (cstrike/scripts/weapon_*.txt: CycleTime, clip_size, Damage, Range, RangeModifier; reload times are
/// the reload sequences' lengths).
pub const GUNS: &[Gun] = &[
    Gun { burst: true, ..gun(2, "glock", 2, true, 0.15, 20, 2.2, 25.0, 4096.0, 0.75) },
    gun(3, "usp", 2, true, 0.15, 12, 2.7, 34.0, 4096.0, 0.79),
    gun(4, "p228", 2, true, 0.15, 13, 2.7, 40.0, 4096.0, 0.8),
    gun(5, "deagle", 2, true, 0.225, 7, 2.2, 54.0, 4096.0, 0.81),
    gun(6, "elite", 2, true, 0.12, 30, 4.5, 36.0, 4096.0, 0.75),
    gun(7, "fiveseven", 2, true, 0.15, 20, 2.7, 25.0, 4096.0, 0.885),
    Gun { shells: Some((0.55, 0.5)), pellets: 9, ..gun(8, "m3", 1, false, 0.88, 8, 0.0, 26.0, 3000.0, 0.7) },
    Gun { shells: Some((0.55, 0.3)), pellets: 6, ..gun(9, "xm1014", 1, false, 0.25, 7, 0.0, 22.0, 3048.0, 0.7) },
    gun(10, "mac10", 1, false, 0.075, 30, 3.15, 29.0, 4096.0, 0.82),
    gun(11, "tmp", 1, false, 0.07, 30, 2.12, 26.0, 4096.0, 0.84),
    gun(12, "mp5navy", 1, false, 0.075, 30, 2.63, 26.0, 4096.0, 0.84),
    gun(13, "ump45", 1, false, 0.105, 25, 3.5, 30.0, 4096.0, 0.82),
    gun(14, "p90", 1, false, 0.066, 50, 3.4, 26.0, 4096.0, 0.84),
    gun(15, "galil", 1, false, 0.09, 35, 2.65, 30.0, 8192.0, 0.98),
    Gun { burst: true, ..gun(16, "famas", 1, false, 0.09, 25, 3.3, 30.0, 8192.0, 0.96) },
    gun(17, "ak47", 1, false, 0.1, 30, 2.5, 36.0, 8192.0, 0.98),
    gun(18, "m4a1", 1, false, 0.09, 30, 3.05, 33.0, 8192.0, 0.97),
    gun(19, "sg552", 1, false, 0.09, 30, 2.8, 33.0, 8192.0, 0.955),
    gun(20, "aug", 1, false, 0.09, 30, 3.3, 32.0, 8192.0, 0.96),
    Gun { sniper: true, ..gun(21, "scout", 1, false, 1.25, 10, 2.0, 75.0, 8192.0, 0.98) },
    Gun { sniper: true, ..gun(22, "awp", 1, false, 1.455, 10, 3.7, 115.0, 8192.0, 0.99) },
    Gun { sniper: true, ..gun(23, "g3sg1", 1, false, 0.25, 20, 4.5, 80.0, 8192.0, 0.98) },
    Gun { sniper: true, ..gun(24, "sg550", 1, false, 0.25, 30, 3.8, 70.0, 8192.0, 0.98) },
    gun(25, "m249", 1, false, 0.08, 100, 4.7, 32.0, 8192.0, 0.97),
];

pub fn gun_by_id(id: u8) -> Option<&'static Gun> {
    GUNS.iter().find(|g| g.id == id)
}

/// The weapon id of a CS:S item class (`weapon_usp`, ...): the knife or a gun. Grenades and the C4 are not given.
pub fn weapon_id(class: &str) -> Option<u8> {
    let name = class.trim().to_ascii_lowercase();
    let name = name.strip_prefix("weapon_")?;
    if name == "knife" {
        return Some(KNIFE);
    }
    GUNS.iter().find(|g| g.name == name).map(|g| g.id)
}

/// A gun in the inventory.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Held {
    pub id: u8,
    pub clip: u8,
    /// Burst mode (Glock, FAMAS).
    pub burst: bool,
    /// The weapon entity it was picked up from (dropping puts it back), and that entity's targetname then (a Kill on
    /// it removes the held weapon).
    pub ent: Option<usize>,
    pub name: Option<Arc<str>>,
    /// v7: the USP's silencer is on.
    pub silenced: bool,
}

/// The player's weapons (v4). Defaults (spawn, and always before v4): the knife only.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Arms {
    pub primary: Option<Held>,
    pub secondary: Option<Held>,
    pub knife: bool,
    /// Active slot: 0 none, 1 primary, 2 secondary, 3 knife.
    pub active: u8,
    /// The slot active before the last switch (client "last weapon").
    pub last: u8,
    /// m_flNextPrimaryAttack / m_flNextSecondaryAttack as a tick: attacks are possible from this tick on.
    pub next_attack_tick: u32,
    /// m_flNextSecondaryAttack for the burst toggle.
    pub next_secondary_tick: u32,
    /// A pistol shot since both attack buttons were last released (CS:S m_iShotsFired > 0).
    pub shot_latched: bool,
    /// Reload in progress: done at this tick (shotguns: the next shell); 0 = none.
    pub reload_tick: u32,
    /// Burst rounds still to fire and when the next one goes.
    pub burst_left: u8,
    pub burst_tick: u32,
    /// The weapon entity the player just dropped can't be picked up again before this tick.
    pub drop_block: Option<(usize, u32)>,
    /// v7: the tick of the last accepted weapon command (bhoptimer's 10-tick cooldown).
    pub command_tick: Option<u32>,
    /// v7: the silencer attach / detach in progress ends at this tick (0 = none).
    pub silencer_tick: u32,
    /// v7: weapon entities lying in the world as a silenced USP (dropped with the silencer on).
    pub floor_silenced: Vec<usize>,
}

impl Default for Arms {
    fn default() -> Self {
        Self {
            primary: None,
            secondary: None,
            knife: true,
            active: 3,
            last: 0,
            next_attack_tick: 0,
            next_secondary_tick: 0,
            shot_latched: false,
            reload_tick: 0,
            burst_left: 0,
            burst_tick: 0,
            drop_block: None,
            command_tick: None,
            silencer_tick: 0,
            floor_silenced: Vec::new(),
        }
    }
}

impl Arms {
    pub fn bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for h in [&self.primary, &self.secondary] {
            match h {
                Some(h) => {
                    out.extend_from_slice(&[h.id, h.clip, h.burst as u8]);
                    out.extend_from_slice(&h.ent.map_or(u32::MAX, |e| e as u32).to_le_bytes());
                    out.extend_from_slice(h.name.as_deref().unwrap_or("").as_bytes());
                    out.push(0);
                }
                None => out.push(0),
            }
        }
        out.extend_from_slice(&[self.knife as u8, self.active, self.last, self.shot_latched as u8, self.burst_left]);
        for t in [self.next_attack_tick, self.next_secondary_tick, self.reload_tick, self.burst_tick] {
            out.extend_from_slice(&t.to_le_bytes());
        }
        if let Some((e, t)) = self.drop_block {
            out.extend_from_slice(&(e as u32).to_le_bytes());
            out.extend_from_slice(&t.to_le_bytes());
        }
        // v7 state, only when used: the bytes of every earlier run stay as they were.
        let silenced = [&self.primary, &self.secondary].map(|h| h.as_ref().is_some_and(|h| h.silenced));
        if self.command_tick.is_some() || self.silencer_tick != 0 || silenced.contains(&true) || !self.floor_silenced.is_empty() {
            out.push(0xa7);
            out.extend_from_slice(&self.command_tick.unwrap_or(u32::MAX).to_le_bytes());
            out.extend_from_slice(&self.silencer_tick.to_le_bytes());
            out.extend_from_slice(&[silenced[0] as u8, silenced[1] as u8]);
            for &e in &self.floor_silenced {
                out.extend_from_slice(&(e as u32).to_le_bytes());
            }
        }
        out
    }

    fn slot(&self, slot: u8) -> Option<&Held> {
        match slot {
            1 => self.primary.as_ref(),
            2 => self.secondary.as_ref(),
            _ => None,
        }
    }

    fn slot_mut(&mut self, slot: u8) -> Option<&mut Held> {
        match slot {
            1 => self.primary.as_mut(),
            2 => self.secondary.as_mut(),
            _ => None,
        }
    }

    fn has(&self, slot: u8) -> bool {
        match slot {
            1 => self.primary.is_some(),
            2 => self.secondary.is_some(),
            3 => self.knife,
            _ => false,
        }
    }

    /// The active weapon's id (0 none, 1 knife, a gun id).
    pub fn active_id(&self) -> u8 {
        match self.active {
            3 if self.knife => KNIFE,
            s => self.slot(s).map_or(0, |h| h.id),
        }
    }

    /// Legacy class bits: (held, active).
    pub fn legacy(&self) -> (u8, u8) {
        let class = |id: u8| match id {
            KNIFE => WEAPON_KNIFE,
            0 => 0,
            id if gun_by_id(id).is_some_and(|g| g.slot == 2) => WEAPON_PISTOL,
            _ => WEAPON_SNIPER,
        };
        let mut held = 0;
        if self.knife {
            held |= WEAPON_KNIFE;
        }
        for h in [&self.primary, &self.secondary].into_iter().flatten() {
            held |= class(h.id);
        }
        (held, class(self.active_id()))
    }
}

/// What the player's attack did this tick (`EVENT_ATTACK`): for the client's swing, sound and impact effects.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AttackReport {
    /// Weapon id (research/WEAPONS.md): 1 knife, 2.. guns.
    pub weapon: u8,
    /// 1 = primary (swing, shot), 2 = secondary (stab).
    pub mode: u8,
    pub hit: bool,
    /// Trace start (the eye) and end (hit point, or the end of the range on a miss).
    pub start: [f32; 3],
    pub end: [f32; 3],
    /// Hit plane normal ([0; 3] on a miss).
    pub normal: [f32; 3],
    /// Brush entity hit, or -1 (world, prop, miss).
    pub entity: i32,
}

/// CS:S weight order for auto-switching: primary > secondary > knife > none.
fn rank(slot: u8) -> u8 {
    match slot {
        1 => 3,
        2 => 2,
        3 => 1,
        _ => 0,
    }
}

impl Game {
    fn weapon_trace(&self, start: [f32; 3], end: [f32; 3], hull: Hull, mask: u32) -> Option<Trace> {
        self.weapon_trace_skip(start, end, hull, mask, &[])
    }

    /// A weapon trace (COLLISION_GROUP_NONE, the player skipped). v9 (`PHYSICS_FIX_PHYSBOX_DAMAGE`): it also sees the
    /// physboxes players don't collide with (`shootable_physbox`).
    fn weapon_trace_skip(&self, start: [f32; 3], end: [f32; 3], hull: Hull, mask: u32, skip: &[usize]) -> Option<Trace> {
        let scene = self.scene(0.0);
        if self.settings.physics_fixes() & PHYSICS_FIX_PHYSBOX_DAMAGE != 0 {
            let extra: Vec<usize> = (0..self.ents.len()).filter(|&i| self.shootable_physbox(i, mask)).collect();
            if !extra.is_empty() {
                let solid: Vec<usize> = self.solid.iter().copied().chain(extra).collect();
                // No broadphase region: every candidate is tested (the same hits as the region's subset).
                return Scene { solid: &solid, region: None, ..scene }.trace_filtered(start, end, hull, mask, skip).ok();
            }
        }
        scene.trace_filtered(start, end, hull, mask, skip).ok()
    }

    /// A func_physbox the player's movement doesn't collide with but a weapon trace with `mask` hits (v9):
    /// func_physbox_multiplayer (COLLISION_GROUP_PUSHAWAY, which `CCSGameRules::ShouldCollide` only drops for players)
    /// and debris physboxes (SF_PHYSBOX_DEBRIS: COLLISION_GROUP_DEBRIS, hit only by masks with CONTENTS_DEBRIS, i.e.
    /// shots). "notsolid" ones (FSOLID_NOT_SOLID) are never hit.
    fn shootable_physbox(&self, i: usize, mask: u32) -> bool {
        let e = &self.ents[i];
        if e.solid || e.removed || e.brush.is_none() || !e.class.starts_with("func_physbox") {
            return false;
        }
        let keys = &self.entities[i];
        if keys.int("notsolid") != 0 {
            return false;
        }
        e.class == "func_physbox_multiplayer" || (keys.int("spawnflags") & SF_PHYSBOX_DEBRIS != 0 && mask & CONTENTS_DEBRIS != 0)
    }

    fn eye_and_forward(&self, cmd: Cmd) -> ([f32; 3], [f32; 3]) {
        let (sp, cp) = playsrc_collision::math::sin_cos(cmd.pitch.to_radians());
        let (sy, cy) = playsrc_collision::math::sin_cos(cmd.yaw.to_radians());
        let p = self.state.position;
        let o = self.state.view_offset;
        ([p[0] + o[0], p[1] + o[1], p[2] + o[2]], [cp * cy, cp * sy, -sp])
    }

    /// The weapon report flags of this tick (`EVENT_WEAPON`).
    fn weapon_event(&mut self, flags: u32) {
        self.events |= EVENT_WEAPON;
        self.weapon_events |= flags;
    }

    /// PlayerRunCommand, before the move: slot requests (`SelectItem`) and drops.
    pub(super) fn weapon_pre_think(&mut self, cmd: Cmd, pressed: u32) {
        let want = ((cmd.buttons & IN_SLOT_MASK) >> IN_SLOT_SHIFT) as u8;
        if want != 0 && self.arms.has(want) && self.arms.active != want {
            self.switch_weapon(want);
        }
        if pressed & IN_DROP != 0 {
            self.drop_active(cmd);
        }
    }

    /// Weapon_Switch -> Deploy: the new weapon is ready after its draw; a reload or burst stops.
    fn switch_weapon(&mut self, slot: u8) {
        if self.arms.active != slot {
            self.arms.last = self.arms.active;
        }
        self.arms.active = slot;
        self.arms.next_attack_tick = self.tick + self.delay_ticks(DEPLOY_TIME);
        self.arms.reload_tick = 0;
        self.arms.burst_left = 0;
        self.cancel_silencer();
        self.weapon_event(WEAPON_EVENT_SWITCHED);
    }

    /// A silencer attach / detach stops with its weapon (switched away, dropped): its lock-out was the USP's own
    /// m_flNextSecondaryAttack, so the next weapon's +attack2 isn't held up by it (v7).
    fn cancel_silencer(&mut self) {
        if self.arms.silencer_tick != 0 {
            self.arms.silencer_tick = 0;
            self.arms.next_secondary_tick = 0;
        }
    }

    /// A weapon command (v7): bhoptimer's `Command_Weapon` for weapon `id` (1 knife, a gun id). Unknown ids and commands
    /// within the 10-tick cooldown do nothing. `buttons`: the command's, for the v10 restore flags (`IN_GIVE_RESTORE`,
    /// `IN_GIVE_MODE`).
    pub(super) fn weapon_command(&mut self, id: u8, buttons: u32) {
        let slot = if id == KNIFE {
            3
        } else {
            match gun_by_id(id) {
                Some(g) => g.slot,
                None => return,
            }
        };
        if self.arms.command_tick.is_some_and(|t| self.tick.wrapping_sub(t) < WEAPON_COMMAND_COOLDOWN) {
            return;
        }
        self.arms.command_tick = Some(self.tick);
        // v10: a restart's re-give of the gun the player had (only right after the reset), in its +attack2 mode.
        let restore = buttons & IN_GIVE_RESTORE != 0
            && self.settings.physics_fixes() & PHYSICS_FIX_WEAPON_RESTORE != 0
            && self.tick < WEAPON_RESTORE_TICKS;
        let mode = restore && buttons & IN_GIVE_MODE != 0;
        // RemovePlayerItem + Kill: whatever is in that slot is gone (a map weapon's entity stays removed). Then
        // GivePlayerItem: a fresh weapon, full clip, silencer off (a restore: the mode it had); "use weapon_x" deploys it.
        let gun = gun_by_id(id);
        let fresh = || Held {
            id,
            clip: gun.map_or(0, |g| g.clip),
            burst: mode && gun.is_some_and(|g| g.burst),
            ent: None,
            name: None,
            silenced: mode && id == USP,
        };
        match slot {
            1 => self.arms.primary = Some(fresh()),
            2 => self.arms.secondary = Some(fresh()),
            _ => self.arms.knife = true,
        }
        if restore {
            self.weapon_event(WEAPON_EVENT_GIVEN | WEAPON_EVENT_RESTORED);
            self.restore_weapon(slot);
        } else {
            self.weapon_event(WEAPON_EVENT_PICKED_UP | WEAPON_EVENT_GIVEN);
            self.switch_weapon(slot);
        }
    }

    /// v10: a restored gun is in hand as it was before the restart (CS:S keeps it drawn over `!r`): active without the
    /// deploy, attacks ready now, no reload, burst or silencer lock-out carried over from what was in hand before.
    fn restore_weapon(&mut self, slot: u8) {
        if self.arms.active != slot {
            self.arms.last = self.arms.active;
        }
        self.arms.active = slot;
        self.arms.next_attack_tick = self.tick;
        self.arms.next_secondary_tick = self.tick;
        self.arms.reload_tick = 0;
        self.arms.burst_left = 0;
        self.arms.silencer_tick = 0;
    }

    /// Puts a weapon into its empty slot; false when the slot is taken.
    fn give_weapon(&mut self, id: u8, ent: Option<usize>, name: Option<Arc<str>>) -> bool {
        let slot = if id == KNIFE {
            if self.arms.knife {
                return false;
            }
            self.arms.knife = true;
            3
        } else {
            let Some(g) = gun_by_id(id) else { return false };
            if self.arms.has(g.slot) {
                return false;
            }
            // v7: a USP dropped with its silencer on still has it (the state is the weapon entity's).
            let silenced = ent.is_some_and(|e| self.arms.floor_silenced.contains(&e));
            if let Some(e) = ent {
                self.arms.floor_silenced.retain(|&x| x != e);
            }
            let held = Held { id, clip: g.clip, burst: false, ent, name, silenced };
            if g.slot == 1 {
                self.arms.primary = Some(held);
            } else {
                self.arms.secondary = Some(held);
            }
            g.slot
        };
        self.weapon_event(WEAPON_EVENT_PICKED_UP);
        if rank(slot) > rank(if self.arms.has(self.arms.active) { self.arms.active } else { 0 }) {
            self.switch_weapon(slot);
        }
        true
    }

    /// game_player_equip Use: give the listed weapons to the player.
    pub(super) fn equip_player(&mut self, i: usize) {
        let mut items: Vec<u8> = Vec::new();
        for (key, value) in self.entities[i].pairs.iter() {
            let Some(w) = weapon_id(key) else { continue };
            if value.trim().parse::<i32>().unwrap_or(1) > 0 && !items.contains(&w) {
                items.push(w);
            }
        }
        for w in items {
            self.give_weapon(w, None, None);
        }
    }

    /// player_weaponstrip Strip: no weapons at all (not even the knife) until the map gives some again.
    pub(super) fn strip_player(&mut self) {
        let had = self.arms.knife || self.arms.primary.is_some() || self.arms.secondary.is_some();
        self.arms.primary = None;
        self.arms.secondary = None;
        self.arms.knife = false;
        self.arms.active = 0;
        self.arms.reload_tick = 0;
        self.arms.burst_left = 0;
        if had {
            self.weapon_event(WEAPON_EVENT_LOST);
        }
    }

    /// A `Kill` on `target`: held weapons picked up from entities with that name are gone too.
    pub(super) fn kill_held_weapons(&mut self, target: &str) {
        let mut lost = false;
        for slot in [1u8, 2] {
            let hit = self.arms.slot(slot).and_then(|h| h.name.as_deref()).is_some_and(|n| name_matches(target, n));
            if hit {
                if slot == 1 {
                    self.arms.primary = None;
                } else {
                    self.arms.secondary = None;
                }
                lost = true;
                if self.arms.active == slot {
                    self.arms.active = 0;
                    self.arms.reload_tick = 0;
                    self.arms.burst_left = 0;
                }
            }
        }
        if lost {
            self.weapon_event(WEAPON_EVENT_LOST);
        }
    }

    /// CCSPlayer::DropWeapon for the active gun: its entity goes back on the floor in front of the player.
    fn drop_active(&mut self, cmd: Cmd) {
        let slot = self.arms.active;
        let Some(held) = (match slot {
            1 => self.arms.primary.take(),
            2 => self.arms.secondary.take(),
            _ => None,
        }) else {
            return;
        };
        self.arms.active = 0;
        self.arms.reload_tick = 0;
        self.arms.burst_left = 0;
        self.cancel_silencer();
        self.weapon_event(WEAPON_EVENT_DROPPED);
        // The entity it came from, unless a point_template has respawned a new copy into it meanwhile.
        if let Some(e) = held.ent.filter(|&e| self.ents[e].removed) {
            let (sy, cy) = playsrc_collision::math::sin_cos(cmd.yaw.to_radians());
            let p = self.state.position;
            let from = [p[0], p[1], p[2] + 32.0];
            let to = [p[0] + cy * 48.0, p[1] + sy * 48.0, p[2] + 32.0];
            let small = Hull { mins: [-6.0; 3], maxs: [6.0; 3] };
            let ahead = self.weapon_trace(from, to, small, MASK_SOLID).map_or(from, |t| t.end);
            let down = self.weapon_trace(ahead, [ahead[0], ahead[1], ahead[2] - 512.0], small, MASK_SOLID).map_or(ahead, |t| t.end);
            let ent = &mut self.ents[e];
            ent.removed = false;
            ent.origin = [down[0], down[1], down[2] - 2.0];
            ent.local_origin = ent.origin;
            self.arms.drop_block = Some((e, self.tick + self.delay_ticks(1.0)));
            if held.silenced && !self.arms.floor_silenced.contains(&e) {
                self.arms.floor_silenced.push(e);
            }
            self.floor_mark(e, FLOOR_DROPPED);
        }
        // CS:S switches to the best remaining weapon.
        let best = [1u8, 2, 3].into_iter().filter(|&s| self.arms.has(s)).max_by_key(|&s| rank(s));
        if let Some(s) = best {
            self.switch_weapon(s);
        }
    }

    /// Weapon pickups (CBaseCombatWeapon touch -> CCSPlayer::BumpWeapon), after the command's touches.
    pub(super) fn weapon_pickups(&mut self) {
        if self.weapon_ents.is_empty() {
            return;
        }
        let hull = self.current_hull();
        let p = self.state.position;
        let lo = [p[0] + hull.mins[0], p[1] + hull.mins[1], p[2] + hull.mins[2]];
        let hi = [p[0] + hull.maxs[0], p[1] + hull.maxs[1], p[2] + hull.maxs[2]];
        for k in 0..self.weapon_ents.len() {
            let (i, id) = self.weapon_ents[k];
            let e = &self.ents[i];
            if e.removed || (0..3).any(|a| hi[a] < e.origin[a] - PICKUP_HALF[a] || lo[a] > e.origin[a] + PICKUP_HALF[a]) {
                continue;
            }
            if self.arms.drop_block.is_some_and(|(b, until)| b == i && self.tick < until) {
                continue;
            }
            // CBaseCombatWeapon::OnPickedUp: SetName(NULL_STRING), so the map's Kill on the name can't take it.
            if self.give_weapon(id, Some(i), None) {
                self.ents[i].removed = true;
                self.ents[i].name.clear();
                if let Some(seen) = self.floor_seen.get_mut(k) {
                    seen.marks |= FLOOR_PICKED_UP;
                }
                self.io_time = self.player_time();
                self.fire_output(i, "onplayerpickup", Actor::Player);
            }
        }
    }

    /// CWeaponCSBase::ItemPostFrame for the active weapon.
    pub(super) fn weapon_post_frame(&mut self, cmd: Cmd) {
        let attack = cmd.buttons & (IN_ATTACK | IN_ATTACK2);
        let guns = self.settings.physics_fixes() & PHYSICS_FIX_WEAPONS != 0;
        if !guns {
            // v4 knife without guns (diagnostic versions): the knife alone.
            if attack != 0 && self.tick >= self.arms.next_attack_tick && self.arms.active == 3 && self.arms.knife {
                self.knife_attack(cmd);
            }
            return;
        }
        let slot = self.arms.active;
        if slot == 3 || slot == 0 {
            if attack != 0 && slot == 3 && self.arms.knife && self.tick >= self.arms.next_attack_tick {
                self.knife_attack(cmd);
            }
            return;
        }
        let Some(gun) = self.arms.slot(slot).and_then(|h| gun_by_id(h.id)).copied() else { return };
        // A burst in progress (CWeaponGlock::FireRemaining): one round every 0.1 s (v6 Glock: 6 ticks).
        let glock_burst_fix = self.settings.physics_fixes() & PHYSICS_FIX_GLOCK_BURST != 0 && gun.id == GLOCK;
        let burst_round_ticks = if glock_burst_fix { GLOCK_BURST_ROUND_TICKS } else { self.delay_ticks(0.1) };
        if self.arms.burst_left > 0 && self.tick >= self.arms.burst_tick {
            self.arms.burst_left -= 1;
            self.arms.burst_tick = self.tick + burst_round_ticks;
            if self.arms.slot(slot).is_some_and(|h| h.clip > 0) {
                self.fire_bullet(cmd, &gun, slot);
            } else {
                self.arms.burst_left = 0;
            }
        }
        // Reloads finish (or load the next shell).
        if self.arms.reload_tick != 0 && self.tick >= self.arms.reload_tick {
            let h = self.arms.slot_mut(slot).expect("active gun");
            match gun.shells {
                Some((_, per)) => {
                    h.clip = (h.clip + 1).min(gun.clip);
                    let full = h.clip >= gun.clip;
                    self.arms.reload_tick = if full { 0 } else { self.tick + self.delay_ticks(per) };
                    if full {
                        self.weapon_event(WEAPON_EVENT_RELOAD_FINISHED);
                    }
                }
                None => {
                    h.clip = gun.clip;
                    self.arms.reload_tick = 0;
                    self.weapon_event(WEAPON_EVENT_RELOAD_FINISHED);
                }
            }
        }
        let clip = self.arms.slot(slot).map_or(0, |h| h.clip);
        if attack == 0 {
            self.arms.shot_latched = false;
        }
        // +attack2: burst toggle (Glock / FAMAS).
        if cmd.buttons & IN_ATTACK2 != 0 && gun.burst && self.tick >= self.arms.next_secondary_tick {
            let h = self.arms.slot_mut(slot).expect("active gun");
            h.burst = !h.burst;
            self.arms.next_secondary_tick = self.tick + self.delay_ticks(0.3);
            self.weapon_event(WEAPON_EVENT_MODE);
            return;
        }
        // v7: the silencer attach / detach finishes; +attack2 starts the next one (CWeaponUSP::SecondaryAttack).
        if self.arms.silencer_tick != 0 && self.tick >= self.arms.silencer_tick {
            self.arms.silencer_tick = 0;
        }
        if cmd.buttons & IN_ATTACK2 != 0
            && gun.id == USP
            && self.settings.physics_fixes() & PHYSICS_FIX_USP_SILENCER != 0
            && self.tick >= self.arms.next_attack_tick.max(self.arms.next_secondary_tick)
            && self.arms.reload_tick == 0
        {
            let h = self.arms.slot_mut(slot).expect("active gun");
            h.silenced = !h.silenced;
            let done = self.tick + self.delay_ticks(USP_SILENCER_TIME);
            self.arms.next_attack_tick = done;
            self.arms.next_secondary_tick = done;
            self.arms.silencer_tick = done;
            self.weapon_event(WEAPON_EVENT_SILENCER);
            return;
        }
        let reloading = self.arms.reload_tick != 0;
        if cmd.buttons & IN_ATTACK != 0 && self.tick >= self.arms.next_attack_tick {
            if reloading && !(gun.shells.is_some() && clip > 0) {
                return;
            }
            if clip == 0 {
                // PlayEmptySound; m_flNextPrimaryAttack = curtime + 0.2.
                self.arms.next_attack_tick = self.tick + self.delay_ticks(0.2);
                self.weapon_event(WEAPON_EVENT_DRY_FIRE);
                return;
            }
            let burst = self.arms.slot(slot).is_some_and(|h| h.burst);
            // Pistols fire once per trigger pull; v5 let a held burst-mode Glock fire the next burst (v6: also once).
            if gun.semi && (!burst || glock_burst_fix) {
                if self.arms.shot_latched {
                    return;
                }
                self.arms.shot_latched = true;
            }
            self.arms.reload_tick = 0;
            let cycle = if burst { 0.5 } else { gun.cycle };
            self.arms.next_attack_tick = self.tick + self.delay_ticks(cycle).max(1);
            self.fire_bullet(cmd, &gun, slot);
            if burst {
                self.arms.burst_left = 2;
                self.arms.burst_tick = self.tick + burst_round_ticks;
            }
            return;
        }
        // Reload: IN_RELOAD with a partly empty clip, or an empty clip once no attack button is held.
        let want = (cmd.buttons & IN_RELOAD != 0 && clip < gun.clip) || (clip == 0 && attack == 0);
        if want && !reloading && self.tick >= self.arms.next_attack_tick && self.arms.burst_left == 0 {
            let first = match gun.shells {
                Some((start, _)) => start,
                None => gun.reload,
            };
            self.arms.reload_tick = self.tick + self.delay_ticks(first).max(1);
            self.weapon_event(WEAPON_EVENT_RELOAD_STARTED);
        }
    }

    /// CKnife::SwingOrStab.
    fn knife_attack(&mut self, cmd: Cmd) {
        let stab = cmd.buttons & IN_ATTACK2 != 0;
        let (eye, forward) = self.eye_and_forward(cmd);
        let range = if stab { STAB_RANGE } else { SWING_RANGE };
        let end = [eye[0] + forward[0] * range, eye[1] + forward[1] * range, eye[2] + forward[2] * range];
        let mut tr = self.weapon_trace(eye, end, POINT, MASK_SOLID);
        if tr.is_some_and(|t| t.fraction >= 1.0) {
            if let Some(hull_tr) = self.weapon_trace(eye, end, HEAD_HULL, MASK_SOLID).filter(|t| t.fraction < 1.0) {
                // Every hit here is the world, a static prop or a brush model: FindHullIntersection.
                tr = Some(self.find_hull_intersection(eye, hull_tr));
            }
        }
        let hit = tr.filter(|t| t.fraction < 1.0);
        let delay = match (stab, hit.is_some()) {
            (true, true) => 1.1,
            (true, false) => 1.0,
            (false, true) => 0.5,
            (false, false) => 0.4,
        };
        self.arms.next_attack_tick = self.tick + self.delay_ticks(delay).max(1);
        self.report_attack(KNIFE, if stab { 2 } else { 1 }, eye, end, hit);
        let damage = if stab { 65.0 } else { 15.0 };
        self.damage_hit(hit, damage);
    }

    /// CCSPlayer::FireBullet: one trace for the whole shot (no spread or penetration).
    fn fire_bullet(&mut self, cmd: Cmd, gun: &Gun, slot: u8) {
        if let Some(h) = self.arms.slot_mut(slot) {
            h.clip = h.clip.saturating_sub(1);
        }
        let (eye, forward) = self.eye_and_forward(cmd);
        let end = [eye[0] + forward[0] * gun.range, eye[1] + forward[1] * gun.range, eye[2] + forward[2] * gun.range];
        let mut hit = self.weapon_trace(eye, end, POINT, MASK_SHOOT).filter(|t| t.fraction < 1.0);
        // Coincident brushes (bhop_lost_world's VR5: each box button sits inside an identical func_wall_toggle):
        // the engine's entity order lets the shot reach the button; here a damageable brush at the same hit
        // distance wins over a non-damageable one.
        if let Some(first) = hit.and_then(|t| t.hit).and_then(hit_entity).filter(|&i| i < self.ents.len() && !self.damageable(i)) {
            let again = self.weapon_trace_skip(eye, end, POINT, MASK_SHOOT, &[first]).filter(|t| t.fraction < 1.0);
            if let Some(t) = again {
                let same = (t.fraction - hit.map_or(1.0, |h| h.fraction)) * gun.range < 1.0;
                if same && t.hit.and_then(hit_entity).is_some_and(|i| i < self.ents.len() && self.damageable(i)) {
                    hit = Some(t);
                }
            }
        }
        // A silenced USP fires in CS:S's Secondary_Mode (its quiet sound); the damage is the same.
        let silenced = self.arms.slot(slot).is_some_and(|h| h.silenced);
        self.report_attack(gun.id, if silenced { 2 } else { 1 }, eye, end, hit);
        // Damage falls off with distance: damage * rangeModifier ^ (distance / 500).
        let distance = hit.map_or(gun.range, |t| t.fraction * gun.range);
        let damage = gun.damage * f32::from(gun.pellets) * playsrc_collision::math::pow(gun.range_modifier, distance / 500.0);
        self.damage_hit(hit, damage);
    }

    fn report_attack(&mut self, weapon: u8, mode: u8, start: [f32; 3], end: [f32; 3], hit: Option<Trace>) {
        self.events |= EVENT_ATTACK;
        self.attack = Some(AttackReport {
            weapon,
            mode,
            hit: hit.is_some(),
            start,
            end: hit.map_or(end, |t| t.end),
            normal: hit.and_then(|t| t.normal).unwrap_or([0.0; 3]),
            entity: hit.and_then(|t| t.hit).and_then(hit_entity).filter(|&i| i < self.ents.len()).map_or(-1, |i| i as i32),
        });
    }

    fn damage_hit(&mut self, hit: Option<Trace>, damage: f32) {
        let Some(target) = hit.and_then(|t| t.hit).and_then(hit_entity).filter(|&i| i < self.ents.len()) else { return };
        // PostThink runs inside the player's usercmd, on the player's clock (like touches and +use).
        self.io_time = self.player_time();
        self.in_attack = true;
        self.take_damage(target, damage);
        self.in_attack = false;
        self.rebuild_solid();
    }

    /// `FindHullIntersection(vecSrc, tr, VEC_DUCK_HULL_MIN, VEC_DUCK_HULL_MAX)`: the line to twice the box hit, else
    /// the nearest hit of the lines to the duck hull's corners around that point; the box trace when none hits.
    fn find_hull_intersection(&self, src: [f32; 3], tr: Trace) -> Trace {
        let hull_end = [0, 1, 2].map(|k| src[k] + (tr.end[k] - src[k]) * 2.0);
        if let Some(t) = self.weapon_trace(src, hull_end, POINT, MASK_SOLID).filter(|t| t.fraction < 1.0) {
            return t;
        }
        let duck = self.policy.crouched_hull;
        let minmaxs = [duck.mins, duck.maxs];
        let mut best = tr;
        let mut distance = 1e6f32;
        for i in 0..2 {
            for j in 0..2 {
                for k in 0..2 {
                    let corner = [hull_end[0] + minmaxs[i][0], hull_end[1] + minmaxs[j][1], hull_end[2] + minmaxs[k][2]];
                    let Some(t) = self.weapon_trace(src, corner, POINT, MASK_SOLID).filter(|t| t.fraction < 1.0) else { continue };
                    let d = [t.end[0] - src[0], t.end[1] - src[1], t.end[2] - src[2]];
                    let this = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
                    if this < distance {
                        best = t;
                        distance = this;
                    }
                }
            }
        }
        best
    }

    /// Entities a shot can damage here (func_button, func_breakable; v9 func_physbox*).
    fn damageable(&self, i: usize) -> bool {
        let physbox = self.settings.physics_fixes() & PHYSICS_FIX_PHYSBOX_DAMAGE != 0 && self.ents[i].class.starts_with("func_physbox");
        !self.ents[i].removed
            && (self.ents[i].class == "func_breakable" || physbox || matches!(&self.ents[i].data, Data::Mover(m) if m.button))
    }

    /// The player's damage on entity `i` (`CBaseEntity::TakeDamage` -> `OnTakeDamage`).
    fn take_damage(&mut self, i: usize, damage: f32) {
        if self.ents[i].removed {
            return;
        }
        let guns = self.settings.physics_fixes() & PHYSICS_FIX_WEAPONS != 0;
        if self.settings.physics_fixes() & PHYSICS_FIX_PHYSBOX_DAMAGE != 0 {
            // CBaseEntity::TakeDamage: the damage filter first (bullets and the knife: DMG_BULLET | DMG_NEVERGIB).
            if !self.passes_damage_filter(i, DMG_BULLET | DMG_NEVERGIB) {
                return;
            }
            // CPhysBox::OnTakeDamage: CBreakable's damage (health, not simulated), then OnDamaged with the attacker
            // as activator whenever there is an inflictor (the player).
            if self.ents[i].class.starts_with("func_physbox") {
                self.fire_output(i, "ondamaged", Actor::Player);
                return;
            }
        }
        if self.ents[i].class == "func_breakable" {
            if guns {
                self.breakable_damage(i, damage);
            }
            return;
        }
        if !matches!(&self.ents[i].data, Data::Mover(m) if m.button) {
            return;
        }
        // CBaseButton::OnTakeDamage: OnDamaged with the button's previous m_hActivator (none before its first
        // activation), then the attacker becomes the activator if the button responds. v6 (EventQueueFix's
        // OnTakeDamage pre-hook): the attacker is the activator before OnDamaged fires, on every hit.
        let attacker_first = self.settings.physics_fixes() & PHYSICS_FIX_DAMAGE_ACTIVATOR != 0;
        let previous =
            if attacker_first || !guns || self.extra.button_activator.contains(&i) { Actor::Player } else { Actor::None };
        self.fire_output(i, "ondamaged", previous);
        let sf = self.entities[i].int("spawnflags");
        if sf & SF_BUTTON_DAMAGE_ACTIVATES == 0 && self.entities[i].int("health") == 0 {
            return;
        }
        let m = self.mover_mut(i).clone();
        // ButtonResponseToTouch: nothing while moving or while pushed in (unless a toggle button that can return).
        let toggle = sf & SF_BUTTON_TOGGLE != 0;
        let stay_pushed = m.wait < 0.0;
        let returns = match m.phase {
            MoverPhase::Opening | MoverPhase::Closing => return,
            MoverPhase::Open { .. } if toggle && !stay_pushed => true,
            MoverPhase::Open { .. } => return,
            MoverPhase::Closed => false,
        };
        self.note_button_activator(i);
        if m.locked {
            return;
        }
        if returns {
            self.fire_output(i, "onpressed", Actor::Player);
            self.mover_go_down(i, Actor::Player);
        } else {
            // ButtonActivate (OnPressed fires in mover_go_up).
            self.mover_go_up(i, Actor::Player);
        }
    }

    /// The player became button `i`'s m_hActivator (use, touch, damage), v4.
    pub(super) fn note_button_activator(&mut self, i: usize) {
        if self.settings.physics_fixes() & PHYSICS_FIX_WEAPONS != 0 {
            self.extra.button_activator.insert(i);
        }
    }

    /// CBreakable::BreakTouch (physics v5): the player touches solid func_breakable `i` (`standing` on it).
    /// SF_BREAK_TOUCH: `OnTakeDamage(speed * 0.01, DMG_CRUSH)` when that reaches its health, called directly (not
    /// through TakeDamage), so a health-0 breakable breaks on any touch. SF_BREAK_PRESSURE: standing on it breaks it
    /// `pressuredelay` s later (SetThink(Die); the touch is off until then).
    pub(super) fn breakable_touch(&mut self, i: usize, standing: bool) {
        if self.ents[i].removed || !self.ents[i].solid || self.ents[i].class != "func_breakable" {
            return;
        }
        let sf = self.entities[i].int("spawnflags");
        if sf & SF_BREAK_TOUCH != 0 {
            let v = self.state.velocity;
            let damage = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt() * 0.01;
            let health = *self.extra.breakable_health.entry(i).or_insert_with(|| self.entities[i].float("health").unwrap_or(0.0));
            if damage >= health && damage >= self.entities[i].float("minhealthdmg").unwrap_or(0.0) {
                self.extra.breakable_health.insert(i, health - damage);
                self.fire_output(i, "onhealthchanged", Actor::Player);
                self.fire_output(i, "onbreak", Actor::Player);
                self.ents[i].removed = true;
                self.rebuild_solid();
                return;
            }
        }
        if sf & SF_BREAK_PRESSURE != 0 && standing && self.extra.pressure_breaks.insert(i) {
            let delay = self.entities[i].float("pressuredelay").unwrap_or(0.0);
            self.seq += 1;
            self.queue.push(QueuedEvent {
                fire_time: self.io_time + delay.max(0.0),
                seq: self.seq,
                target: Arc::from("!self"),
                input: Arc::from("break"),
                param: Arc::from(""),
                activator: Actor::Player,
                caller: Actor::Entity(i),
            });
        }
    }

    /// CBreakable::OnTakeDamage: a breakable with health (0 = unbreakable) loses it; at 0 it breaks (OnBreak) and is
    /// gone. SF_BREAK_TRIGGER_ONLY breakables only break on their Break input.
    fn breakable_damage(&mut self, i: usize, damage: f32) {
        let sf = self.entities[i].int("spawnflags");
        let health = *self.extra.breakable_health.entry(i).or_insert_with(|| self.entities[i].float("health").unwrap_or(0.0));
        if health <= 0.0 || sf & SF_BREAK_TRIGGER_ONLY != 0 || damage < self.entities[i].float("minhealthdmg").unwrap_or(0.0) {
            return;
        }
        let left = health - damage;
        self.extra.breakable_health.insert(i, left);
        self.fire_output(i, "onhealthchanged", Actor::Player);
        if left <= 0.0 {
            self.fire_output(i, "onbreak", Actor::Player);
            self.ents[i].removed = true;
        }
    }

    /// `weapon_report`: [flags, active id, primary id, secondary id, has knife, clip, clip size, reload ticks left,
    /// burst mode, floor items changed since the last `floor_report` (0/1), silencer on (v7), silencer ticks left (v7)]
    /// (research/WEAPONS.md).
    pub fn weapon_report(&self) -> [f32; 12] {
        let a = &self.arms;
        let active = a.slot(a.active);
        let clip_size = active.and_then(|h| gun_by_id(h.id)).map_or(0, |g| g.clip);
        [
            self.weapon_events as f32,
            f32::from(a.active_id()),
            f32::from(a.primary.as_ref().map_or(0, |h| h.id)),
            f32::from(a.secondary.as_ref().map_or(0, |h| h.id)),
            a.knife as u32 as f32,
            f32::from(active.map_or(0, |h| h.clip)),
            f32::from(clip_size),
            if a.reload_tick == 0 { 0.0 } else { a.reload_tick.saturating_sub(self.tick) as f32 },
            active.is_some_and(|h| h.burst) as u32 as f32,
            self.floor_changed() as u32 as f32,
            active.is_some_and(|h| h.silenced) as u32 as f32,
            if a.silencer_tick == 0 { 0.0 } else { a.silencer_tick.saturating_sub(self.tick) as f32 },
        ]
    }
}

/// Floor weapon items for the client (research/WEAPONS.md "Floor weapons"). Presentation only: nothing here feeds back
/// into the simulation, and no allocation per call.
impl Game {
    fn floor_mark(&mut self, ent: usize, mark: u8) {
        if let Ok(k) = self.weapon_ents.binary_search_by_key(&ent, |&(i, _)| i) {
            self.floor_seen[k].marks |= mark;
        }
    }

    /// Whether any weapon item appeared, went or moved since the last `floor_report` (cheap; for the per-tick report).
    pub fn floor_changed(&self) -> bool {
        self.weapon_ents.iter().zip(&self.floor_seen).any(|(&(i, _), seen)| {
            let e = &self.ents[i];
            seen.marks != 0 || seen.present == e.removed || (!e.removed && seen.origin != e.origin)
        })
    }

    /// Every weapon_* item of the map (in entity order, present or not; the count never changes after load) with what
    /// happened to it since the previous call, to `f`. Items that CS:S physics would drop (unparented, not "start
    /// constrained") are reported where they rest on the floor below their origin.
    pub fn floor_report(&mut self, mut f: impl FnMut(FloorItem)) {
        for k in 0..self.weapon_ents.len() {
            let (i, weapon) = self.weapon_ents[k];
            let (present, origin, angles) = (!self.ents[i].removed, self.ents[i].origin, self.ents[i].angles);
            let seen = self.floor_seen[k];
            let mut flags = seen.marks;
            let mut rest = seen.rest;
            if present {
                flags |= FLOOR_PRESENT;
                if !seen.present && flags & FLOOR_DROPPED == 0 {
                    flags |= FLOOR_SPAWNED;
                } else if seen.present && seen.origin != origin {
                    flags |= FLOOR_MOVED;
                }
                if !seen.present || seen.origin != origin {
                    rest = self.floor_rest(i, origin);
                }
            } else if seen.present && flags & FLOOR_PICKED_UP == 0 {
                flags |= FLOOR_REMOVED;
            }
            self.floor_seen[k] = FloorSeen { present, origin, rest, marks: 0 };
            f(FloorItem { ent: i, weapon, flags, position: if present { rest } else { origin }, angles });
        }
    }

    /// Where item `i` at `origin` is drawn: on the floor below it (up to 512 units for a free item that CS:S physics
    /// drops, 16 for a "start constrained" one placed a little above the floor), at its origin when parented or higher.
    fn floor_rest(&self, i: usize, origin: [f32; 3]) -> [f32; 3] {
        if self.ents[i].parent.is_some() {
            return origin;
        }
        let reach = if self.entities[i].int("spawnflags") & SF_WEAPON_CONSTRAINED != 0 { 16.0 } else { 512.0 };
        let small = Hull { mins: [-4.0, -4.0, 0.0], maxs: [4.0, 4.0, 4.0] };
        match self.weapon_trace(origin, [origin[0], origin[1], origin[2] - reach], small, MASK_SOLID) {
            Some(t) if !t.start_solid && t.fraction < 1.0 => t.end,
            _ => origin,
        }
    }
}
