//! Deterministic CS:S bunnyhop simulation: map collision, brush entities, entity I/O, triggers
//! and movement. Everything is tick-based; no wall-clock time is read anywhere.
//!
//! Per-tick order (a Source server frame: Physics_RunThinkFunctions runs the player's usercmd first, then
//! every other entity, then ServiceEventQueue; we start the tick at the event queue, which is the same cycle):
//! 1. service the entity I/O event queue (events due at or before this tick),
//! 2. run player movement (vendored SDK 2013 gamemovement port with CS:S policy),
//! 3. touch solid brush entities (ground + impact contacts) and the bhop-block fix,
//! 4. touch triggers (StartTouch / Touch / EndTouch semantics, filters, outputs),
//! 5. advance movers (func_door / func_button, then the kinematic movers of `game/kin.rs`) and push the
//!    player with them (CPhysicsPushedEntities).

mod kin;
mod minigame;
mod weapons;
mod propdoor;
mod usable;
// Per-map trigger fixes (physics v8).
mod map_fixes;
// Practice mode noclip (never called by `step`; see the module docs).
mod practice;
// DanZay's VScript objective gates, emulated natively on bhop_cooksassistant (physics v16).
mod vscript;
// Trigger / clip overlays for the client (never called by `step`; see the module docs).
mod overlay;
pub use overlay::{
    OVERLAY_CLIP, OVERLAY_GRAVITY, OVERLAY_OTHER, OVERLAY_PUSH, OVERLAY_STATE_ACTIVE, OVERLAY_STATE_VISIBLE, OVERLAY_TELEPORT,
    OVERLAY_WALL, OVERLAY_WHEN_HIDDEN, OverlayBrush,
};

use crate::entities::{Entity, EntityList, Output, name_matches};
use playsrc_bsp::{Bsp, LumpData, Model};
use crate::physics::{self, PropCollision};
use playsrc_collision::{Hull, ObjectTraceRequest, Transform, World as CollisionWorld};
use playsrc_movement::{
    self as movement, Command, Configuration, CrouchCommandCrop, Error as MoveError, Player, Policy, State, StepInput,
    Trace, Tracer,
};

pub const IN_JUMP: u32 = 1 << 1;
pub const IN_DUCK: u32 = 1 << 2;
/// +use (Source IN_USE): CBasePlayer::PlayerUse, see `game/usable.rs`.
pub const IN_USE: u32 = 1 << 5;
/// +attack (Source IN_ATTACK): knife swing / gun shot from physics v4, see `game/weapons.rs`.
pub const IN_ATTACK: u32 = 1 << 0;
/// +attack2 (Source IN_ATTACK2): knife stab from physics v4.
pub const IN_ATTACK2: u32 = 1 << 11;
pub use weapons::{
    AttackReport, FLOOR_DROPPED, FLOOR_MOVED, FLOOR_PICKED_UP, FLOOR_PRESENT, FLOOR_REMOVED, FLOOR_SPAWNED, FloorItem, GUNS,
    Gun, IN_DROP, IN_GIVE_MASK, IN_GIVE_MODE, IN_GIVE_RESTORE, IN_GIVE_SHIFT, IN_RELOAD, IN_SLOT_MASK, IN_SLOT_SHIFT,
    USP_SILENCER_TIME, WEAPON_COMMAND_COOLDOWN, WEAPON_EVENT_DRY_FIRE, WEAPON_EVENT_GIVEN, WEAPON_EVENT_RESTORED,
    WEAPON_EVENT_SILENCER, WEAPON_EVENT_DROPPED, WEAPON_RESTORE_TICKS,
    WEAPON_EVENT_LOST, WEAPON_EVENT_MODE, WEAPON_EVENT_PICKED_UP, WEAPON_EVENT_RELOAD_FINISHED, WEAPON_EVENT_RELOAD_STARTED,
    WEAPON_EVENT_SWITCHED, WEAPON_KNIFE, WEAPON_PISTOL, WEAPON_SNIPER, gun_by_id, weapon_id,
};

pub const EVENT_TELEPORTED: u32 = 1 << 0;
pub const EVENT_JUMPED: u32 = 1 << 1;
pub const EVENT_LANDED: u32 = 1 << 2;
/// The player died (lethal trigger_hurt / left the world) and was respawned at the spawn point.
pub const EVENT_RESPAWNED: u32 = 1 << 3;
/// A rotating pusher turned the player's view this tick (FIXANGLE_RELATIVE): add `Game::view_angle_change`
/// to the view angles.
pub const EVENT_ANGLES_CHANGED: u32 = 1 << 4;
/// The player attacked this tick (knife swing / stab, gun shot; physics v4): see `Game::attack`.
pub const EVENT_ATTACK: u32 = 1 << 5;
/// The player's inventory changed this tick (switch, pickup, reload, drop, ...; physics v4): see `Game::weapon_report`.
pub const EVENT_WEAPON: u32 = 1 << 6;

/// The player entity's classname until a map renames it with `AddOutput classname`.
const PLAYER_CLASS: &str = "player";

/// Hit identities handed to the movement code (`Trace::hit`, ground support):
/// - bits 0..40: world brush index, or entity index with `ENTITY_HIT`,
/// - `WORLD_SURFACE_HIT`: displacement / static prop (part of the world, no brush index),
/// - bits 48..64: surface-property table index (`physics::SURFACE_PROPS`) of the hit surface.
const ENTITY_HIT: u64 = 1 << 40;
const WORLD_SURFACE_HIT: u64 = 1 << 41;
const INDEX_MASK: u64 = (1 << 40) - 1;
const SURFACE_SHIFT: u32 = 48;
/// CONTENTS_SOLID | CONTENTS_WINDOW | CONTENTS_GRATE | CONTENTS_MONSTER | CONTENTS_PLAYERCLIP:
/// trace masks that should collide with static props.
const PROP_MASK: u32 = 0x1 | 0x2 | 0x8 | 0x2000000 | 0x10000;
/// CONTENTS_WATER | CONTENTS_SLIME: what a func_water_analog volume contributes to point contents.
const WATER_CONTENTS: u32 = 0x20 | 0x10;

/// Entity index of a hit identity, if it is a brush entity.
fn hit_entity(hit: u64) -> Option<usize> {
    (hit & ENTITY_HIT != 0).then_some((hit & INDEX_MASK) as usize)
}
const MAX_HEALTH: f32 = 100.0;
/// Box traces against SOLID_VPHYSICS brush entities see every face pulled in by this much (real-engine
/// measurement, tools/parity: a player stands 0.5 u "into" a func_door / func_brush; point rays are exact).
const VPHYSICS_INSET: f32 = 0.5;
/// Beyond this the player has left the sealed world (maps extend to +-16384, MAX_COORD_INTEGER;
/// playable space on e.g. bhop_badges_mini reaches y = -16000). Leaves room for the eye-height
/// point queries the movement code makes above the origin.
const OUT_OF_WORLD: f32 = movement::MAX_COORDINATE - 80.0;
/// Guard against output loops (A fires B fires A with zero delay).
const MAX_EVENTS_PER_TICK: usize = 4096;

/// Physics versions. Every replay is re-simulated with the version it was recorded with (replay header `physics`,
/// apps/web/src/replay.ts), so a movement fix never changes an existing run. research/MOVEMENT_AUDIT.md
/// "Physics versions".
/// v1: the original port (every replay recorded before physics versions; replays without the field).
pub const PHYSICS_V1: u32 = 1;
/// v2 = v1 + player movement collides with playerclip brushes (MASK_PLAYERSOLID) + CS:S jumps during the unduck
/// transition (ducking in the air and releasing as you land no longer blocks the jump).
pub const PHYSICS_V2: u32 = 2;
/// v3 = v2 + VPhysics separation: a box trace that starts a hair inside the 1/32 contact band above a func_door /
/// func_brush (SOLID_VPHYSICS) and isn't moving toward it no longer "hits" it at fraction 0, which zeroed the player's
/// velocity on some landings (bhop_redwood's first blocks) and froze stuck tests (tools/parity: bit-exact with the
/// real engine where v2 dead-stops).
pub const PHYSICS_V3: u32 = 3;
/// v4 = v3 + the knife: +attack / +attack2 swing and stab like CS:S's knife and damage the func_button they hit
/// (OnDamaged; damage-activated buttons press, e.g. the keypad that opens bhop_hive's first door) + func_water_analog
/// is water: its brush is a water volume at its current position, moving with it and its parent (the lab that
/// floods on bhop_lost_world) + CS:S ladders (`PHYSICS_FIX_LADDER`). Shipped in v0.0.9.
pub const PHYSICS_V4: u32 = 4;
/// v5 = v4 + map-given weapons (floor pickups, game_player_equip, pistols, shotguns, SMGs, rifles, snipers; shots damage
/// func_button / func_breakable), the SDK water-jump push, game_ui / point_template / pushable boxes, SDK output order
/// (bhop_badges, bhop_badges_mini, bhop_lost_world) and solid func_lod (bhop_2flocci2furious). Shipped in v0.0.10.
pub const PHYSICS_V5: u32 = 5;
/// v6 = v5 + a damaged func_button fires OnDamaged with the attacker as `!activator`, every hit, like the bhop servers'
/// EventQueueFix (stock Source used the button's previous activator, so the first shot at a bhop_badges /
/// bhop_badges_mini pad renamed nobody and did nothing) + the burst-mode Glock's timing as on srcds (6 ticks between
/// rounds, one burst per trigger pull). research/maps/badges-real-replays.md section 6.
pub const PHYSICS_V6: u32 = 6;
/// v7 = v6 + weapon commands (bhoptimer's `sm_usp` / `sm_glock` / `sm_knife`, and any gun outside ranked runs: a give
/// request in buttons bits 16..20, `PHYSICS_FIX_WEAPON_COMMANDS`) + the USP's silencer on +attack2
/// (`PHYSICS_FIX_USP_SILENCER`). research/WEAPONS.md. Also the SDK's point_template name fixup
/// (`PHYSICS_FIX_TEMPLATE_NAMES`; bhop_monster_jam's button walls break again).
pub const PHYSICS_V7: u32 = 7;
/// v8 = v7 + per-map trigger fixes (`PHYSICS_FIX_MAP_TRIGGERS`, `game/map_fixes.rs`): bhop_2easy's stage-end teleports
/// cover their end room's back wall, floor to ceiling, instead of the map's 80x80x16 spot in the middle (players jumped
/// over it or walked past it; CS:S is the same, verified on srcds).
pub const PHYSICS_V8: u32 = 8;
/// v9 = v8 + shots and knife hits damage func_physbox / func_physbox_multiplayer (`PHYSICS_FIX_PHYSBOX_DAMAGE`):
/// OnDamaged fires with the attacker as `!activator`, through the physbox's damage filter. bhop_tesquo_v2's neon
/// stage boosts the player who shoots the platform under them (`!activator,AddOutput,gravity -0.8`); v1..v8 never fired
/// it (feedback 2026-10-09).
pub const PHYSICS_V9: u32 = 9;
/// v10 = v9 + a restart keeps the guns in hand (`PHYSICS_FIX_WEAPON_RESTORE`): the client's re-give of the guns the
/// player had (a weapon command with `IN_GIVE_RESTORE`, in the first ticks after a reset) puts the gun in hand already
/// drawn, with the USP's silencer (or the Glock / FAMAS burst mode) as it was (`IN_GIVE_MODE`), like a bhop server's `!r`
/// (feedback 2026-10-10: "the silencer gets detached when you restart"). research/WEAPONS.md.
pub const PHYSICS_V10: u32 = 10;
/// v11: FinishDuck/FinishUnDuck recategorize support before movement.
pub const PHYSICS_V11: u32 = 11;
/// v12: linear func_door honors StartOpen / spawnpos, including collision and child transforms.
pub const PHYSICS_V12: u32 = 12;
/// v13: consistent downhill ramp landing boosts, including early ground probes.
pub const PHYSICS_V13: u32 = 13;
/// v14: per-map sv_maxvelocity (`PHYSICS_FIX_MAP_MAX_VELOCITY`) and func_tracktrains that find their path before the
/// map's spawn outputs (`PHYSICS_FIX_TRAIN_SPAWN`).
pub const PHYSICS_V14: u32 = 14;
/// v15: Source's signed door / button travel on the maps that need it (`PHYSICS_FIX_MAP_DOOR_TRAVEL`,
/// `game/map_fixes.rs` `SIGNED_DOOR_TRAVEL`): bhop_montana_fix's "UP" block rises and launches the player.
pub const PHYSICS_V15: u32 = 15;
/// v16: the player's own outputs and filter tests on the maps that need them (`PHYSICS_FIX_MAP_PLAYER_IO`,
/// `game/map_fixes.rs` `PLAYER_IO`): bhop_synthetic_fix's potion door, bhop_wonderland's key room and bhop_lego3's coins
/// open once all three items are collected. Same bit: DanZay's VScript objective gates on the maps in
/// `NONLINEAR_OBJECTIVES` (`game/vscript.rs`): bhop_cooksassistant's kitchen doors need its 4 ingredients.
pub const PHYSICS_V16: u32 = 16;
/// The version new recordings use.
pub const PHYSICS_LATEST: u32 = PHYSICS_V16;
/// Diagnostic pseudo-versions (never valid in a replay, whose field is a u8): `PHYSICS_DIAG | fix bits` turns on only
/// the listed fixes, to tell which fix changes a replay (tools: /tmp physics-v2 analysis). The fix bits are the low 26
/// (`PHYSICS_DIAG_FIXES`); before v16 the base was 1 << 25 with 25 fix bits, before v15 1 << 24 with 24, before v8
/// 0x1_0000 with 16 (and 0x100 with 8 before v5), and those old diagnostic numbers are not versions any more. The mask is never stored: replays carry
/// the u8 version, run hashes fold only the commands, and the state digest has no settings in it.
pub const PHYSICS_DIAG: u32 = 1 << 26;
/// The fix bits a diagnostic pseudo-version may carry.
pub const PHYSICS_DIAG_FIXES: u32 = PHYSICS_DIAG - 1;
/// Fix bit: MASK_PLAYERSOLID / matching ladder mask (playerclips are solid).
pub const PHYSICS_FIX_PLAYERCLIP: u32 = 1 << 0;
/// Fix bit: jump while unducking, air unduck from a partial duck, vz replaced while unducking.
pub const PHYSICS_FIX_UNDUCK_JUMP: u32 = 1 << 1;
/// Fix bit (v3): VPhysics brush-entity traces that don't move toward a face they start outside of never hit it
/// (playsrc-collision `trace_brush_model_vphysics`).
pub const PHYSICS_FIX_VPHYSICS_SEPARATION: u32 = 1 << 2;
/// Fix bit (v4): IN_ATTACK / IN_ATTACK2 swing / stab the knife (`game/weapons.rs`).
pub const PHYSICS_FIX_KNIFE: u32 = 1 << 3;
/// Fix bit (v4): func_water_analog brushes add their water contents to point contents (CFuncMoveLinear with
/// FSOLID_VOLUME_CONTENTS).
pub const PHYSICS_FIX_WATER_ANALOG: u32 = 1 << 4;
/// Fix bit (v5): map-given weapons: game_player_equip / player_weaponstrip, pistol and sniper shots, weapon slots,
/// damage to func_breakable (`game/weapons.rs`).
pub const PHYSICS_FIX_WEAPONS: u32 = 1 << 5;
/// Fix bit (v5): SDK `CGameMovement::WaterJump` keeps the water-jump push (m_vecWaterJumpVel) on the tick the jump
/// ends; the port zeroed it (the player lost the 50 u/s toward the ledge at the top of the jump).
pub const PHYSICS_FIX_WATER_JUMP: u32 = 1 << 6;
/// Fix bit (v5): game_ui, point_template ForceSpawn and pushable physics boxes (`game/minigame.rs`).
pub const PHYSICS_FIX_GAME_ENTITIES: u32 = 1 << 7;
/// Fix bit (v5): an output's connections are queued in reverse keyvalue order, like the SDK's (`CBaseEntityOutput::
/// AddEventAction` prepends, `FireOutput` walks the list from the head), so same-delay targets run last-defined first
/// (bhop_badges_mini's spawners: `glock,Kill` before `spawner,ForceSpawn`).
pub const PHYSICS_FIX_OUTPUT_ORDER: u32 = 1 << 8;
/// Fix bit (v4): CS:S ladders (`Policy::cs_ladders`): an unpressed key axis is 0 on a ladder (the port took
/// `signum(0) = 1`: W climbed like W+D and slid off narrow ladders; bhop_monster_jam), ducked climbing at 68 u/s,
/// sv_ladder_dampen, LadderDistance 10, LadderMask without player clips, flat tops aren't ladders. Matches the real
/// engine on 7 ladder scenarios (research/maps/monster_jam-ladder.md).
pub const PHYSICS_FIX_LADDER: u32 = 1 << 9;
/// Fix bit (v5): func_lod is solid (SOLID_BSP, the exact brush) unless its "Solid" key is non-zero, like CS:S
/// (`CFunc_LOD::Spawn` sets SOLID_BSP; `KeyValue("Solid")` adds FSOLID_NOT_SOLID only for a non-zero value). The port
/// made every func_lod non-solid: bhop_2flocci2furious's 88 stepping tiles let the player fall into the fail teleport.
/// Bit-exact with the real engine on 4 scenarios (research/maps/2flocci2furious.md).
pub const PHYSICS_FIX_FUNC_LOD: u32 = 1 << 10;
/// Fix bit (v6): `CBaseButton::OnTakeDamage` fires OnDamaged with the attacker as activator. Stock Source fires it with
/// the button's previous m_hActivator (nobody before the button's first activation) and sets the attacker only
/// afterwards; EventQueueFix (hermansimensen/eventqueue-fix, run by the bhop servers the recorded badges runs come from)
/// sets m_hActivator = attacker in an OnTakeDamage pre-hook "for bhop_badges level 13 and the booster in the ladder
/// room". Evidence: research/maps/badges-real-replays.md section 6.
pub const PHYSICS_FIX_DAMAGE_ACTIVATOR: u32 = 1 << 11;
/// Fix bit (v6): the burst-mode Glock as on srcds (tools/parity): its 3 rounds go 6 ticks apart (v5: 10), and a burst
/// is one trigger pull (v5 fired the next burst every 0.5 s while +attack was held; CS:S needs a new press, which fires
/// as soon as the gun is ready). bhop_badges_mini hands out Glocks; CS:S players climb its columns and bhop_badges' with
/// a burst every 0.5 s.
pub const PHYSICS_FIX_GLOCK_BURST: u32 = 1 << 12;
/// Fix bit (v7): point_template ForceSpawn renames only the template entities the SDK's name fixup renames
/// (`Templates_ReconnectIOForGroup`: those a keyvalue of an entity in the same template targets). v5 / v6 rename every
/// named one, so outputs from outside the template miss the respawned copy: bhop_monster_jam's walls `bw` and `db`
/// (point_templates `tbw` / `tdi`, respawned at map start) never break when their buttons fire `bw,Break` /
/// `db,Break` (`game/minigame.rs`).
pub const PHYSICS_FIX_TEMPLATE_NAMES: u32 = 1 << 13;
/// Fix bit (v7): weapon commands, as bhoptimer's `Command_Weapon` (shavit-misc.sp): buttons bits 16..20 carry a weapon
/// id for one tick (`IN_GIVE_MASK`); the weapon in that slot is removed, the new one given with a full clip and switched
/// to ("use weapon_x": a deploy). At most one command per 10 ticks (`GetGameTickCount() - last < 10` is ignored).
pub const PHYSICS_FIX_WEAPON_COMMANDS: u32 = 1 << 14;
/// Fix bit (v7): the USP's silencer (`CWeaponUSP::SecondaryAttack`): +attack2 toggles it, locking both attacks for the
/// viewmodel sequence's length (3.08 s); the state is per weapon (kept through drops) and silenced shots report mode 2.
pub const PHYSICS_FIX_USP_SILENCER: u32 = 1 << 15;
/// Fix bit (v8): per-map trigger fixes (`game/map_fixes.rs`). A map whose entity lump matches a fix exactly gets the
/// listed brush triggers replaced by world-space boxes for the touch test (the same start-solid box-vs-brush test as any
/// trigger). Data, not code per map: bhop_2easy's five stage-end teleports.
pub const PHYSICS_FIX_MAP_TRIGGERS: u32 = 1 << 16;
/// Fix bit (v9): weapon damage reaches func_physbox / func_physbox_multiplayer (`CPhysBox::OnTakeDamage`: OnDamaged with
/// the attacker as activator, after `CBaseEntity::TakeDamage`'s damage filter). Shots and knife hits see
/// func_physbox_multiplayer (COLLISION_GROUP_PUSHAWAY: players walk through it, COLLISION_GROUP_NONE traces don't) and
/// debris physboxes (shots only: CS_MASK_SHOOT has CONTENTS_DEBRIS). Every entity's `damagefilter` applies to weapon
/// damage (filter_damage_type compares the type: CS:S bullets and the knife are DMG_BULLET | DMG_NEVERGIB). Physbox
/// health and breaking are not simulated.
pub const PHYSICS_FIX_PHYSBOX_DAMAGE: u32 = 1 << 17;
/// Fix bit (v10): a weapon command with `IN_GIVE_RESTORE` (buttons bit 21) in the first `WEAPON_RESTORE_TICKS` ticks after
/// a reset restores a gun the player had before the restart: in hand without the deploy (no draw, attacks ready), and
/// with `IN_GIVE_MODE` (bit 22) the USP's silencer on / the Glock's or FAMAS's burst mode on, without the lock-out. A bhop
/// server's `!r` only moves the player, so the gun never leaves their hand; the core resets to the knife, and the client
/// re-gives it through the replay-recorded input (`game/weapons.rs`). Later, or before v10, the flags are ignored and the
/// command is an ordinary one (drawn, silencer off).
pub const PHYSICS_FIX_WEAPON_RESTORE: u32 = 1 << 18;
const PHYSICS_FIX_V4: u32 = PHYSICS_FIX_PLAYERCLIP
    | PHYSICS_FIX_UNDUCK_JUMP
    | PHYSICS_FIX_VPHYSICS_SEPARATION
    | PHYSICS_FIX_KNIFE
    | PHYSICS_FIX_WATER_ANALOG
    | PHYSICS_FIX_LADDER;
const PHYSICS_FIX_V5: u32 = PHYSICS_FIX_PLAYERCLIP
    | PHYSICS_FIX_UNDUCK_JUMP
    | PHYSICS_FIX_VPHYSICS_SEPARATION
    | PHYSICS_FIX_KNIFE
    | PHYSICS_FIX_WATER_ANALOG
    | PHYSICS_FIX_WEAPONS
    | PHYSICS_FIX_WATER_JUMP
    | PHYSICS_FIX_GAME_ENTITIES
    | PHYSICS_FIX_OUTPUT_ORDER
    | PHYSICS_FIX_LADDER
    | PHYSICS_FIX_FUNC_LOD;
const PHYSICS_FIX_V6: u32 = PHYSICS_FIX_V5 | PHYSICS_FIX_DAMAGE_ACTIVATOR | PHYSICS_FIX_GLOCK_BURST;
const PHYSICS_FIX_V7: u32 =
    PHYSICS_FIX_V6 | PHYSICS_FIX_TEMPLATE_NAMES | PHYSICS_FIX_WEAPON_COMMANDS | PHYSICS_FIX_USP_SILENCER;
const PHYSICS_FIX_V8: u32 = PHYSICS_FIX_V7 | PHYSICS_FIX_MAP_TRIGGERS;
const PHYSICS_FIX_V9: u32 = PHYSICS_FIX_V8 | PHYSICS_FIX_PHYSBOX_DAMAGE;
const PHYSICS_FIX_V10: u32 = PHYSICS_FIX_V9 | PHYSICS_FIX_WEAPON_RESTORE;
pub const PHYSICS_FIX_CROUCH_GROUND: u32 = 1 << 19;
const PHYSICS_FIX_V11: u32 = PHYSICS_FIX_V10 | PHYSICS_FIX_CROUCH_GROUND;
/// Source CBaseDoor::Spawn starts linear doors at position2 when StartOpen / spawnpos=1 is set.
pub const PHYSICS_FIX_DOOR_START_OPEN: u32 = 1 << 20;
const PHYSICS_FIX_V12: u32 = PHYSICS_FIX_V11 | PHYSICS_FIX_DOOR_START_OPEN;
/// Downhill landings receive the collision boost even when caught by a ground probe.
pub const PHYSICS_FIX_DOWNHILL: u32 = 1 << 21;
const PHYSICS_FIX_V13: u32 = PHYSICS_FIX_V12 | PHYSICS_FIX_DOWNHILL;
/// Fix bit (v14): the map's own sv_maxvelocity (`game/map_fixes.rs` `MAX_VELOCITY`) replaces the server's 3500 for the
/// whole map. The maps that run `sv_maxvelocity 10000` through a point_servercommand (bhop_sandtrap, bhop_icetrap, ...)
/// are built for it; Momentum Mod sets the same per map. Matched on the entity lump like the trigger fixes.
pub const PHYSICS_FIX_MAP_MAX_VELOCITY: u32 = 1 << 22;
/// Fix bit (v14): func_tracktrain / func_tanktrain run `CFuncTrackTrain::Find` before the map's spawn outputs fire. In
/// Source, Find thinks on the spawn frame and logic_auto fires 0.2 s later (`CLogicAuto::Spawn`), so a train started by
/// `logic_auto -> StartForward` already has its path; before v14 the input came first, `Next` found no path and zeroed
/// the speed, and the train never moved (bhop_areaportal_v1's green platform, feedback 2026-10-23).
pub const PHYSICS_FIX_TRAIN_SPAWN: u32 = 1 << 23;
const PHYSICS_FIX_V14: u32 = PHYSICS_FIX_V13 | PHYSICS_FIX_MAP_MAX_VELOCITY | PHYSICS_FIX_TRAIN_SPAWN;
/// Fix bit (v15): on the maps in `game/map_fixes.rs` `SIGNED_DOOR_TRAVEL`, a func_door whose lip is larger than its
/// brush along movedir moves the difference the other way (`CBaseDoor::Spawn` has no clamp), and so does a func_button
/// when that is 1 unit or more (`CBaseButton::Spawn`). Elsewhere, and before v15, the travel is clamped at 0.
pub const PHYSICS_FIX_MAP_DOOR_TRAVEL: u32 = 1 << 24;
const PHYSICS_FIX_V15: u32 = PHYSICS_FIX_V14 | PHYSICS_FIX_MAP_DOOR_TRAVEL;
/// Fix bit (v16): on the maps in `game/map_fixes.rs` `PLAYER_IO`, the player keeps the outputs `AddOutput` gives it
/// (`!activator,AddOutput,OnUser1 target:input:param:delay:times`) and fires them on `FireUser1..4`
/// (`CBaseEntity::InputFireUser1`), and filters answer `TestActivator` with `OnPass` / `OnFail`
/// (`CBaseFilter::InputTestActivator`), all with the input's activator. Elsewhere, and before v16, all three are ignored.
/// On the maps in `game/map_fixes.rs` `NONLINEAR_OBJECTIVES` the same bit runs the native emulation of their VScript
/// objective triggers and gates (`game/vscript.rs`); elsewhere, and before v16, scripts do nothing.
pub const PHYSICS_FIX_MAP_PLAYER_IO: u32 = 1 << 25;
const PHYSICS_FIX_ALL: u32 = PHYSICS_FIX_V15 | PHYSICS_FIX_MAP_PLAYER_IO;

/// The per-map fix (`game/map_fixes.rs`) a parsed entity lump matches, by map name (tests, tools).
pub fn map_fix_for(entities: &[Entity]) -> Option<&'static str> {
    map_fixes::find(entities).map(|(fix, _)| fix.map)
}

/// The map's own sv_maxvelocity entry (`game/map_fixes.rs` `MAX_VELOCITY`) a parsed entity lump matches, as
/// (map name, value) (tests, tools).
pub fn map_max_velocity_for(entities: &[Entity]) -> Option<(&'static str, f32)> {
    map_fixes::max_velocity(entities).map(|m| (m.map, m.max_velocity))
}

/// The map a parsed entity lump matches in `game/map_fixes.rs` `PLAYER_IO` (tests, tools).
pub fn map_player_io_for(entities: &[Entity]) -> Option<&'static str> {
    map_fixes::player_io(entities).map(|m| m.map)
}

/// Every map in `game/map_fixes.rs` `PLAYER_IO` (tests, tools).
pub fn map_player_io_table() -> Vec<&'static str> {
    map_fixes::PLAYER_IO.iter().map(|m| m.map).collect()
}

/// The map a parsed entity lump matches in `game/map_fixes.rs` `NONLINEAR_OBJECTIVES` (tests, tools).
pub fn map_nonlinear_objectives_for(entities: &[Entity]) -> Option<&'static str> {
    map_fixes::nonlinear_objectives(entities).map(|m| m.map)
}

/// Every map in `game/map_fixes.rs` `NONLINEAR_OBJECTIVES` (tests, tools).
pub fn map_nonlinear_objectives_table() -> Vec<&'static str> {
    map_fixes::NONLINEAR_OBJECTIVES.iter().map(|m| m.map).collect()
}

/// The map a parsed entity lump matches in `game/map_fixes.rs` `SIGNED_DOOR_TRAVEL` (tests, tools).
pub fn map_signed_door_travel_for(entities: &[Entity]) -> Option<&'static str> {
    map_fixes::signed_door_travel(entities).map(|m| m.map)
}

/// Every map's own sv_maxvelocity (`game/map_fixes.rs` `MAX_VELOCITY`), as (map name, value) (tests, tools).
pub fn map_max_velocity_table() -> Vec<(&'static str, f32)> {
    map_fixes::MAX_VELOCITY.iter().map(|m| (m.map, m.max_velocity)).collect()
}

/// The fixes a physics version turns on; None for unknown versions.
pub fn physics_fixes(version: u32) -> Option<u32> {
    match version {
        PHYSICS_V1 => Some(0),
        PHYSICS_V2 => Some(PHYSICS_FIX_PLAYERCLIP | PHYSICS_FIX_UNDUCK_JUMP),
        PHYSICS_V3 => Some(PHYSICS_FIX_PLAYERCLIP | PHYSICS_FIX_UNDUCK_JUMP | PHYSICS_FIX_VPHYSICS_SEPARATION),
        PHYSICS_V4 => Some(PHYSICS_FIX_V4),
        PHYSICS_V5 => Some(PHYSICS_FIX_V5),
        PHYSICS_V6 => Some(PHYSICS_FIX_V6),
        PHYSICS_V7 => Some(PHYSICS_FIX_V7),
        PHYSICS_V8 => Some(PHYSICS_FIX_V8),
        PHYSICS_V9 => Some(PHYSICS_FIX_V9),
        PHYSICS_V10 => Some(PHYSICS_FIX_V10),
        PHYSICS_V11 => Some(PHYSICS_FIX_V11),
        PHYSICS_V12 => Some(PHYSICS_FIX_V12),
        PHYSICS_V13 => Some(PHYSICS_FIX_V13),
        PHYSICS_V14 => Some(PHYSICS_FIX_V14),
        PHYSICS_V15 => Some(PHYSICS_FIX_V15),
        PHYSICS_V16 => Some(PHYSICS_FIX_ALL),
        v if v & !PHYSICS_DIAG_FIXES == PHYSICS_DIAG && v & PHYSICS_DIAG_FIXES & !PHYSICS_FIX_ALL == 0 => Some(v & PHYSICS_DIAG_FIXES),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Settings {
    pub tick_interval: f32,
    pub air_accelerate: f32,
    pub accelerate: f32,
    pub friction: f32,
    pub stop_speed: f32,
    pub gravity: f32,
    pub max_speed: f32,
    pub autohop: bool,
    pub stamina: bool,
    /// Physics version (`PHYSICS_V1`, `PHYSICS_V2`, ...). Must be one `physics_fixes` knows (`Game::set_settings`
    /// callers check; unknown versions run as v1 here).
    pub physics_version: u32,
}

impl Settings {
    /// Typical CS:S bhop server: 100 tick, sv_airaccelerate 1000, autobhop, no stamina.
    pub fn css_bhop() -> Self {
        Self {
            tick_interval: 0.01,
            air_accelerate: 1000.0,
            accelerate: 5.0,
            friction: 4.0,
            stop_speed: 75.0,
            gravity: 800.0,
            max_speed: 260.0,
            autohop: true,
            stamina: false,
            // v1 unless a caller selects a version: the web client always does (DEFAULT_SETTINGS.physics, replay
            // headers), so native tools and tests that don't keep the original behaviour.
            physics_version: PHYSICS_V1,
        }
    }

    /// `PHYSICS_FIX_*` bits of this version (unknown versions: none, i.e. v1).
    pub fn physics_fixes(&self) -> u32 {
        physics_fixes(self.physics_version).unwrap_or(0)
    }

    pub fn configuration(&self) -> Configuration {
        // v2: MASK_PLAYERSOLID (CONTENTS_SOLID | MOVEABLE | WINDOW | MONSTER | GRATE | PLAYERCLIP). The vendored
        // default 0x0204000b (v1) has CONTENTS_CURRENT_0 instead of MOVEABLE and no PLAYERCLIP, so player movement
        // walked through every playerclip brush (found with tools/parity on bhop_limit / arcane's stop boxes).
        let (solid_mask, ladder_mask) = if self.physics_fixes() & PHYSICS_FIX_PLAYERCLIP != 0 {
            (playsrc_collision::MASK_PLAYERSOLID, playsrc_collision::MASK_PLAYERSOLID | movement::CONTENTS_LADDER)
        } else {
            let d = Configuration::default();
            (d.solid_mask, d.ladder_mask)
        };
        Configuration {
            tick_interval: self.tick_interval,
            acceleration: self.accelerate,
            air_acceleration: self.air_accelerate,
            css_stamina: self.stamina,
            friction: self.friction,
            stop_speed: self.stop_speed,
            gravity: self.gravity,
            maximum_velocity: 3500.0, // sv_maxvelocity
            server_max_speed: 320.0,
            // CS:S ClipVelocity leaves clipped velocity 1/32 u/s away from the plane (tools/parity measurement).
            clip_push_out: 0.03125,
            solid_mask,
            ladder_mask,
            fixes: movement::MovementFixes {
                downhill: self.physics_fixes() & PHYSICS_FIX_DOWNHILL != 0,
                ..Default::default()
            },
            ..Configuration::default()
        }
    }

    /// CS:S player rules on top of the SDK 2013 base movement. See research/MOVEMENT_AUDIT.md.
    pub fn policy(&self) -> Policy {
        let standing_hull = Hull { mins: [-16.0, -16.0, 0.0], maxs: [16.0, 16.0, 62.0] };
        let crouched_hull = Hull { mins: [-16.0, -16.0, 0.0], maxs: [16.0, 16.0, 45.0] };
        Policy {
            maximum_speed: self.max_speed,
            air_speed_cap: 30.0,
            bunnyhop_speed_cap: None,   // TF2 PreventBunnyJumping; CS:S has none
            jump_impulse: 301.993_38,   // sqrt(2 * 800 * 57)
            ground_detach_speed: 140.0, // NON_JUMP_VELOCITY
            standing_hull,
            crouched_hull,
            standing_view: [0.0, 0.0, 64.0],
            crouched_view: [0.0, 0.0, 47.0],
            duck_duration: 0.4,
            unduck_duration: 0.2,
            crouched_command_factor: 0.34, // CS:S DUCK_SPEED_MULTIPLIER
            crouch_command_crop: CrouchCommandCrop::AnyDuckState,
            clamp_ground_speed: false,
            // CS:S: the airborne duck shrinks the hull around its centre (crouch-jump +8.5).
            air_crouch_lift: Some((standing_hull.maxs[2] - crouched_hull.maxs[2]) * 0.5),
            unduck_checks_destination: true,
            recategorize_after_crouch: self.physics_fixes() & PHYSICS_FIX_CROUCH_GROUND != 0,
            // v2: CS:S jumps in the unduck transition (landing ducked and releasing duck hops instead of losing the
            // jump for 0.2 s) and unducks in the air from a partial duck (tools/parity crouch-hops).
            jump_while_unducking: self.physics_fixes() & PHYSICS_FIX_UNDUCK_JUMP != 0,
            air_unduck_from_transition: self.physics_fixes() & PHYSICS_FIX_UNDUCK_JUMP != 0,
            // v4: SDK WaterJump keeps the water-jump push on its last tick (tools/parity on bhop_lost_world's tank:
            // the engine leaves the water at 50 u/s toward the ledge, v1-v3 at 0 then 30).
            cs_ladders: self.physics_fixes() & PHYSICS_FIX_LADDER != 0,
            water: movement::WaterPolicy {
                keep_water_jump_velocity: self.physics_fixes() & PHYSICS_FIX_WATER_JUMP != 0,
                ..movement::WaterPolicy::default()
            },
            ..Policy::default()
        }
    }
}

/// How classic touch-activated bhop blocks (func_door / func_button that sink when touched) behave.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BhopBlockMode {
    /// Stock Source: touching starts the door/button moving; players ride it down.
    Vanilla,
    /// Bhop-server block fix: blocks never move while being hopped on. Standing on one for
    /// `bhop_block_grace` seconds teleports the player through the trigger_teleport below the
    /// block, or (if none is found) starts the stock movement so the player drops.
    Fix,
}

/// Map/server rules that are not movement constants.
#[derive(Clone, Copy, Debug)]
pub struct Rules {
    pub bhop_blocks: BhopBlockMode,
    pub bhop_block_grace: f32,
    /// Source trigger_teleport keeps the player's velocity ("BUGBUG" in triggers.cpp). When false,
    /// velocity is zeroed on teleport (HL1 behaviour).
    pub teleport_keeps_velocity: bool,
    /// Per-material surface properties (`$surfaceprop` friction / jump factor). Vanilla: on.
    pub surface_properties: bool,
    /// Timer-plugin movement fixes (vanilla: all off). See research/MOVEMENT_AUDIT.md.
    /// slopefix / RNGFix "downhill": landing on a downhill slope always gets the clip boost.
    pub downhill_fix: bool,
    /// RNGFix "uphill": landing on an uphill slope never loses speed to the collision clip.
    pub uphill_fix: bool,
    /// Rampbug fix (surf): no dead stops from float error on ramp seams.
    pub rampbug_fix: bool,
    /// RNGFix "telehop": a trigger_teleport touched in the same tick as a wall collision keeps
    /// the speed the collision took away.
    pub telehop_fix: bool,
    /// Player clock lead in ticks (None = the CS:S default for the tick rate). A client's usercmds run at
    /// m_nTickBase, which AdjustPlayerTimeBase keeps sv_clockcorrection_msecs (60 ms) ahead of the server tick: 5
    /// ticks during the command at 100 tick. Outputs fired by the player's touches are timed on that clock, the
    /// event queue is serviced on the server clock, so a touch-fired "0.09 s" AddOutput lands 9 + 5 ticks later.
    /// Measured with tools/parity (the harness bot is forced to the same lead). research/PARITY.md.
    pub player_clock_lead: Option<u32>,
    /// Server tick number of the first step after reset (absolute server time, gpGlobals->tickcount). Event times are
    /// f32 seconds like the engine's, so their rounding depends on it; the parity harness sets the real server's.
    pub server_tick_base: u32,
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            bhop_blocks: BhopBlockMode::Fix,
            bhop_block_grace: 0.1,
            teleport_keeps_velocity: true,
            surface_properties: true,
            downhill_fix: false,
            uphill_fix: false,
            rampbug_fix: false,
            telehop_fix: false,
            player_clock_lead: None,
            server_tick_base: 0,
        }
    }
}

impl Rules {
    fn movement_fixes(&self, settings: Settings) -> movement::MovementFixes {
        movement::MovementFixes {
            downhill: self.downhill_fix || settings.physics_fixes() & PHYSICS_FIX_DOWNHILL != 0,
            uphill: self.uphill_fix,
            rampbug: self.rampbug_fix,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Cmd {
    pub forward: f32,
    pub side: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub buttons: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Actor {
    None,
    Player,
    Entity(usize),
}

impl PartialEq for QueuedEvent {
    fn eq(&self, other: &Self) -> bool {
        self.fire_time.to_bits() == other.fire_time.to_bits() && self.seq == other.seq
    }
}
impl Eq for QueuedEvent {}
impl PartialOrd for QueuedEvent {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for QueuedEvent {
    /// Reversed so `BinaryHeap` pops the earliest (fire time, seq) first: CEventQueue keeps events sorted by fire
    /// time and inserts after existing events with the same time.
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        other.fire_time.total_cmp(&self.fire_time).then(other.seq.cmp(&self.seq))
    }
}

#[derive(Clone, Debug)]
struct QueuedEvent {
    /// CEventQueue fire time: the firing clock (`Game::io_time`) + delay, in f32 seconds like gpGlobals->curtime.
    fire_time: f32,
    seq: u64,
    /// Shared with the output that queued it (an output can queue hundreds of thousands of events at once).
    target: std::sync::Arc<str>,
    input: std::sync::Arc<str>,
    param: std::sync::Arc<str>,
    activator: Actor,
    caller: Actor,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum MoverPhase {
    /// At position 1 (door closed / button out).
    Closed,
    /// Travelling to position 2.
    Opening,
    /// At position 2 until `until_tick` (u32::MAX = stays).
    Open { until_tick: u32 },
    /// Travelling back to position 1.
    Closing,
}

#[derive(Clone, Debug)]
struct Mover {
    button: bool,
    dir: [f32; 3],
    distance: f32,
    speed: f32,
    wait: f32,
    phase: MoverPhase,
    offset: f32,
    locked: bool,
    touch_activates: bool,
    no_auto_return: bool,
    /// OnUseLocked fires at most every 0.5 s (m_flUseLockedTime, as a tick).
    use_locked_until: u32,
    /// Present when the bhop-block fix manages this mover.
    bhop: Option<BhopBlock>,
    /// First tick the current Opening/Closing travel advances. A door activated by the player's touch (on the
    /// player clock, ahead of the server) starts moving in the next frame's think; one activated by an event or
    /// its own think moves in the same frame (measured with tools/parity on bhop_eazy).
    start_tick: u32,
}

#[derive(Clone, Debug)]
struct BhopBlock {
    standing_ticks: u32,
    /// trigger_teleport found below the block.
    teleport: Option<usize>,
}

#[derive(Clone, Debug)]
enum TriggerKind {
    /// trigger_multiple / trigger_once (wait < 0 = once).
    Multiple {
        wait: f32,
        next_tick: u32,
    },
    Teleport {
        target: String,
        landmark: Option<String>,
    },
    Push {
        dir: [f32; 3],
        speed: f32,
        once: bool,
    },
    Hurt {
        damage: f32,
        next_tick: u32,
    },
    /// trigger_gravity: Touch sets the player's gravity multiplier (kept after leaving).
    Gravity {
        gravity: f32,
    },
    /// trigger_playermovement: while touching, force duck (sf 2048) and/or disable auto
    /// movement, i.e. step-up (sf 128).
    PlayerMovement {
        auto_duck: bool,
        no_auto_movement: bool,
    },
}

#[derive(Clone, Debug)]
struct Trigger {
    kind: TriggerKind,
    enabled: bool,
    spawnflags: i64,
    filter: Option<String>,
    /// Engine touch link (hull overlaps the trigger this tick).
    linked: bool,
    /// In the trigger's touching list (passed filters at StartTouch).
    touching: bool,
    /// Tick of the last touch (engine touchstamp): links not refreshed by the end of the frame are EndTouched.
    touch_tick: u32,
}

#[derive(Clone, Debug)]
enum FilterKind {
    Name(String),
    Class(String),
    Multi { all: bool, filters: Vec<String> },
    PassAll,
    /// filter_damage_type: passes every activator (its PassesFilterImpl; the filter's negation is not applied there,
    /// as before v9); as a damage filter (v9) the damage type must equal `damage_type`, negated by `negated`.
    DamageType { damage_type: i64, negated: bool },
}

#[derive(Clone, Debug)]
enum Data {
    Static,
    Mover(Mover),
    Trigger(Trigger),
    Filter {
        kind: FilterKind,
        negated: bool,
    },
    Counter {
        value: f32,
        min: f32,
        max: f32,
        enabled: bool,
    },
    Relay {
        enabled: bool,
        once: bool,
    },
    /// logic_compare (CLogicCompare): input value vs compare value.
    Compare {
        value: f32,
        compare: f32,
    },
    /// `next_tick == u32::MAX`: schedule from `refire` seconds on the next service.
    Timer {
        enabled: bool,
        refire: f32,
        next_tick: u32,
    },
    Auto {
        once: bool,
    },
    /// point_teleport: input Teleport moves its target to this entity's spawn origin/angles
    /// (velocity kept, CPointTeleport::InputTeleport).
    PointTeleport {
        target: String,
    },
    /// prop_dynamic(_override) with collision (solid 6 with a packed .phy, or solid 2 bbox);
    /// DisableCollision / EnableCollision / Kill toggle it. Collision lives in `Game::props`.
    Prop,
    /// Kinematic MOVETYPE_PUSH movers (func_rotating, func_door_rotating, func_movelinear,
    /// func_tracktrain / func_tanktrain, phys_motor-driven physics objects): see `game/kin.rs`.
    Kin(Box<kin::Kin>),
    PathTrack(kin::PathTrack),
    /// phys_motor: inputs go to the attached object (entity index) that `kin` rotates.
    MotorRef(usize),
    /// func_conveyor (CFuncConveyor): FL_CONVEYOR unless visual-only; players standing on it get
    /// `dir * speed` as base velocity (CPlayerMove::CheckMovingGround).
    Conveyor {
        dir: [f32; 3],
        speed: f32,
        active: bool,
    },
    Other,
}

#[derive(Clone, Debug)]
struct BrushModel {
    model: usize,
    origin: [f32; 3],
    base_origin: [f32; 3],
    angles: [f32; 3],
    /// Model-local bounds.
    mins: [f32; 3],
    maxs: [f32; 3],
    /// SOLID_VPHYSICS (true) or SOLID_BSP (false). Box traces see VPhysics brushes slightly shrunk in
    /// CS:S (research/PARITY.md); the collision layer applies that rule per this flag.
    vphysics: bool,
}

impl BrushModel {
    fn world_bounds(&self) -> ([f32; 3], [f32; 3]) {
        let mut lo = [0.0; 3];
        let mut hi = [0.0; 3];
        for i in 0..3 {
            lo[i] = self.mins[i] + self.origin[i];
            hi[i] = self.maxs[i] + self.origin[i];
        }
        // Rotated models may extend beyond the axial bounds; pad generously.
        if self.angles != [0.0; 3] {
            let r = (0..3).map(|i| self.mins[i].abs().max(self.maxs[i].abs())).fold(0.0f32, f32::max) * 1.7321;
            for i in 0..3 {
                lo[i] = self.origin[i] - r;
                hi[i] = self.origin[i] + r;
            }
        }
        (lo, hi)
    }
}

#[derive(Clone, Debug)]
struct RtEnt {
    class: String,
    name: String,
    origin: [f32; 3],
    angles: [f32; 3],
    /// Shared copy-on-write (`Arc::make_mut` where outputs change: fire counts, AddOutput): `ents`, `initial_ents`
    /// and state snapshots don't each hold a copy (maps with hundreds of thousands of outputs).
    outputs: std::sync::Arc<Vec<Output>>,
    removed: bool,
    brush: Option<BrushModel>,
    solid: bool,
    visible: bool,
    /// func_brush "Solidity": 0 toggle, 1 never, 2 always.
    solidity: i64,
    /// SOLID_VPHYSICS in the real engine (func_door, func_brush, func_rotating, ...): box traces see the brush
    /// shrunk by `VPHYSICS_INSET` on every face (measured with tools/parity; research/PARITY.md).
    vphysics: bool,
    data: Data,
    /// Move parent (`parentname`, resolved on load like CBaseEntity::SetParent in Activate).
    parent: Option<usize>,
    children: Vec<usize>,
    /// Transform relative to the parent (the abs transform when unparented). `origin`/`angles`
    /// hold the current abs transform.
    local_origin: [f32; 3],
    local_angles: [f32; 3],
    /// func_door / func_button: the brush origin is driven by `Mover` (base origin + offset).
    door_brush: bool,
    /// Name of the phys_motor driving this object, if any.
    motor_name: Option<String>,
    /// Collision of a moving prop (prop_door_rotating), placed at the entity's current transform.
    prop: Option<Box<DynProp>>,
}

/// A moving prop's collision (`physics::DynamicHulls`) placed at `at` (origin, angles).
#[derive(Clone, Debug)]
struct DynProp {
    hulls: std::rc::Rc<physics::DynamicHulls>,
    brushes: Vec<physics::ConvexBrush>,
    lo: [f32; 3],
    hi: [f32; 3],
    at: ([f32; 3], [f32; 3]),
}

impl DynProp {
    fn new(hulls: std::rc::Rc<physics::DynamicHulls>, origin: [f32; 3], angles: [f32; 3], tag: u32) -> Self {
        let (brushes, lo, hi) = hulls.place(origin, angles, tag);
        Self { hulls, brushes, lo, hi, at: (origin, angles) }
    }

    fn place(&mut self, origin: [f32; 3], angles: [f32; 3], tag: u32) {
        if self.at != (origin, angles) {
            (self.brushes, self.lo, self.hi) = self.hulls.place(origin, angles, tag);
            self.at = (origin, angles);
        }
    }

    /// Whether `hull` at `position` overlaps the prop (CM_ClipBoxToBrush start-solid on any convex).
    fn overlaps(&self, position: [f32; 3], hull: Hull) -> bool {
        swept_overlap(position, position, hull, self.lo, self.hi)
            && self.brushes.iter().any(|b| physics::clip_box_to_brush(b, position, position, hull).is_some_and(|t| t.start_solid))
    }
}

/// Collision view combining the static world with solid brush entities at their current positions.
struct Scene<'a> {
    world: &'a CollisionWorld,
    props: &'a PropCollision,
    texinfo_surface: &'a [u16],
    surfaces: bool,
    ents: &'a [RtEnt],
    solid: &'a [usize],
    /// Solid moving props (`RtEnt::prop`).
    dyn_solid: &'a [usize],
    /// Broadphase for this tick's movement: solid entities (with world bounds) overlapping
    /// `region`. Traces whose swept box lies inside `region` only test these.
    near: &'a [(usize, [f32; 3], [f32; 3])],
    region: Option<([f32; 3], [f32; 3])>,
    time: f32,
    /// Physics v3 `PHYSICS_FIX_VPHYSICS_SEPARATION`.
    vphysics_separation: bool,
    /// Water volumes added to point contents (physics v4 `PHYSICS_FIX_WATER_ANALOG`; empty before v4).
    water: &'a [usize],
}

fn swept_overlap(start: [f32; 3], end: [f32; 3], hull: Hull, lo: [f32; 3], hi: [f32; 3]) -> bool {
    (0..3).all(|i| {
        let a = start[i].min(end[i]) + hull.mins[i] - 1.0;
        let b = start[i].max(end[i]) + hull.maxs[i] + 1.0;
        a <= hi[i] && b >= lo[i]
    })
}

impl Scene<'_> {
    /// Surface-table index of a collision trace's surface, shifted into hit-identity position.
    fn surface_of(&self, t: &playsrc_collision::Trace) -> u64 {
        let index = match t.surface {
            Some(s) if s.registry == physics::SURFACEPROP_REGISTRY => s.index as usize,
            Some(s) if s.registry == playsrc_collision::TEXINFO_SURFACE_REGISTRY => {
                self.texinfo_surface.get(s.index as usize).copied().unwrap_or(0) as usize
            }
            _ => 0,
        };
        (index as u64) << SURFACE_SHIFT
    }

    fn convert(&self, t: playsrc_collision::Trace, base: Option<u64>) -> Trace {
        let hit = base.or(if t.displacement.is_some() { Some(WORLD_SURFACE_HIT) } else { None });
        Trace {
            fraction: t.fraction,
            start_solid: t.start_solid,
            all_solid: t.all_solid,
            end: t.end,
            normal: t.plane.map(|p| p.normal),
            hit: hit.map(|h| h | self.surface_of(&t)),
            contents: t.contents,
        }
    }

    fn trace_filtered(
        &self,
        start: [f32; 3],
        end: [f32; 3],
        hull: Hull,
        mask: u32,
        skip: &[usize],
    ) -> Result<Trace, MoveError> {
        let malformed = |_| MoveError::new(movement::Operation::Trace, movement::FailureKind::Malformed, "collision");
        let t = self.world.trace_hull(start, end, hull, mask).map_err(malformed)?;
        let mut best = self.convert(t, t.brush.map(|b| b as u64));
        if best.start_solid {
            // The engine returns the world trace as-is when it starts solid: static props and entities are not
            // traced at all (measured with tools/parity/trace.ts).
            return Ok(best);
        }
        let merge = |best: &mut Trace, t: Trace| {
            if t.start_solid || t.fraction < best.fraction {
                let closer = t.fraction < best.fraction;
                *best = Trace {
                    fraction: t.fraction.min(best.fraction),
                    start_solid: best.start_solid || t.start_solid,
                    all_solid: best.all_solid || t.all_solid,
                    end: if closer { t.end } else { best.end },
                    normal: if closer { t.normal } else { best.normal },
                    hit: if closer || best.hit.is_none() { t.hit } else { best.hit },
                    contents: if closer { t.contents } else { best.contents },
                };
            }
        };
        // Props and brush entities are traced like the engine's entity pass: each one against the ray shortened
        // to the closest hit so far, with the fraction scaled back (measured bit for bit with tools/parity/trace.ts).
        // Starting inside an entity and not getting out of it within the shortened ray is therefore all-solid.
        let delta = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
        let shortened = |scale: f32| -> [f32; 3] {
            if scale >= 1.0 {
                end
            } else {
                [start[0] + delta[0] * scale, start[1] + delta[1] * scale, start[2] + delta[2] * scale]
            }
        };
        if mask & PROP_MASK != 0 && !best.all_solid {
            let enabled = |tag: u32| {
                self.ents.get((tag & !physics::ENTITY_PROP) as usize).is_some_and(|e| e.solid && !e.removed)
            };
            let scale = best.fraction;
            if let Some(p) = self.props.trace_filtered(start, shortened(scale), hull, &enabled) {
                let fraction = if scale < 1.0 { p.fraction * scale } else { p.fraction };
                let stop = playsrc_collision::trace_endpoint(start, end, hull, fraction);
                merge(
                    &mut best,
                    Trace {
                        fraction,
                        start_solid: p.start_solid,
                        all_solid: p.all_solid,
                        end: stop,
                        normal: p.normal,
                        hit: Some(WORLD_SURFACE_HIT | (p.surface as u64) << SURFACE_SHIFT),
                        contents: 1,
                    },
                );
            }
        }
        let inside = self.region.is_some_and(|(rlo, rhi)| {
            (0..3).all(|k| {
                start[k].min(end[k]) + hull.mins[k] - 1.0 >= rlo[k] && start[k].max(end[k]) + hull.maxs[k] + 1.0 <= rhi[k]
            })
        });
        let full;
        let candidates: &[(usize, [f32; 3], [f32; 3])] = if inside {
            self.near
        } else {
            full = self
                .solid
                .iter()
                .filter_map(|&i| self.ents[i].brush.as_ref().map(|b| {
                    let (lo, hi) = b.world_bounds();
                    (i, lo, hi)
                }))
                .collect::<Vec<_>>();
            &full
        };
        for &(index, lo, hi) in candidates {
            if skip.contains(&index) {
                continue;
            }
            let Some(b) = &self.ents[index].brush else { continue };
            if !swept_overlap(start, end, hull, lo, hi) {
                continue;
            }
            if best.all_solid {
                break;
            }
            let scale = best.fraction;
            let request = ObjectTraceRequest {
                identity: ENTITY_HIT | index as u64,
                transform: Transform { origin: b.origin, angles: b.angles },
                start,
                end: shortened(scale),
                hull,
                mask,
            };
            let inset = if self.ents[index].vphysics { VPHYSICS_INSET } else { 0.0 };
            let t = self
                .world
                .trace_brush_model_vphysics(b.model, request, inset, self.vphysics_separation)
                .map_err(malformed)?;
            let mut t = self.convert(t, Some(ENTITY_HIT | index as u64));
            if scale < 1.0 && !t.all_solid {
                if t.fraction < 1.0 {
                    t.fraction *= scale;
                } else {
                    t.fraction = scale;
                }
            }
            t.end = if t.all_solid { start } else { playsrc_collision::trace_endpoint(start, end, hull, t.fraction) };
            merge(&mut best, t);
        }
        if mask & PROP_MASK != 0 {
            for &index in self.dyn_solid {
                let Some(p) = &self.ents[index].prop else { continue };
                if skip.contains(&index) || !swept_overlap(start, end, hull, p.lo, p.hi) {
                    continue;
                }
                for b in &p.brushes {
                    let Some(t) = physics::clip_box_to_brush(b, start, end, hull) else { continue };
                    let f = t.fraction;
                    let stop = [start[0] + (end[0] - start[0]) * f, start[1] + (end[1] - start[1]) * f, start[2] + (end[2] - start[2]) * f];
                    merge(
                        &mut best,
                        Trace {
                            fraction: f,
                            start_solid: t.start_solid,
                            all_solid: t.all_solid,
                            end: stop,
                            normal: t.normal,
                            hit: Some(ENTITY_HIT | index as u64 | (t.surface as u64) << SURFACE_SHIFT),
                            contents: 1,
                        },
                    );
                }
            }
        }
        Ok(best)
    }
}

impl Tracer for Scene<'_> {
    fn trace(&self, start: [f32; 3], end: [f32; 3], hull: Hull, mask: u32) -> Result<Trace, MoveError> {
        self.trace_filtered(start, end, hull, mask, &[])
    }

    fn is_world(&self, hit: u64) -> bool {
        hit & ENTITY_HIT == 0
    }

    /// IEngineTrace::GetPointContents: the world's contents plus, from physics v4, the water of the func_water_analog
    /// brushes containing the point (FSOLID_VOLUME_CONTENTS brush entities at their current transform).
    fn point_contents(&self, point: [f32; 3]) -> Result<u32, MoveError> {
        let point_hull = Hull { mins: [0.0; 3], maxs: [0.0; 3] };
        let mut contents = self.trace(point, point, point_hull, u32::MAX)?.contents;
        for &i in self.water {
            let e = &self.ents[i];
            let Some(b) = &e.brush else { continue };
            if e.removed {
                continue;
            }
            let (lo, hi) = b.world_bounds();
            if (0..3).any(|k| point[k] < lo[k] - 1.0 || point[k] > hi[k] + 1.0) {
                continue;
            }
            let request = ObjectTraceRequest {
                identity: 0,
                transform: Transform { origin: b.origin, angles: b.angles },
                start: point,
                end: point,
                hull: point_hull,
                mask: WATER_CONTENTS,
            };
            if let Ok(t) = self.world.trace_brush_model(b.model, request) {
                if t.start_solid {
                    contents |= t.contents & WATER_CONTENTS;
                }
            }
        }
        Ok(contents)
    }

    fn ground_surface(&self, trace: &Trace) -> Option<movement::SurfaceProperties> {
        let index = (trace.hit? >> SURFACE_SHIFT) as usize;
        if index == 0 || !self.surfaces {
            return None; // default: player surface friction 1, jump factor 1
        }
        let p = physics::SURFACE_PROPS.get(index)?;
        Some(movement::SurfaceProperties { friction: p.friction, jump_factor: p.jump_factor })
    }

    /// Needed by the stuck-recovery path when the player is embedded in a brush entity.
    fn movement_time(&self) -> Option<f32> {
        Some(self.time)
    }

    /// Ground entity abs velocity (CGameMovement::SetGroundEntity adds it to the base velocity when the
    /// player leaves the ground, and subtracts it on landing).
    fn support_velocity(&self, support: u64) -> Result<[f32; 3], MoveError> {
        Ok(hit_entity(support).filter(|&i| i < self.ents.len()).map_or([0.0; 3], |i| kin::ent_abs_velocity(self.ents, i)))
    }

    /// FL_CONVEYOR ground (CPlayerMove::CheckMovingGround).
    fn conveyor_velocity(&self, support: u64) -> Result<Option<[f32; 3]>, MoveError> {
        let Some(e) = hit_entity(support).and_then(|i| self.ents.get(i)) else { return Ok(None) };
        Ok(match e.data {
            Data::Conveyor { dir, speed, active: true } if !e.removed => Some([dir[0] * speed, dir[1] * speed, dir[2] * speed]),
            _ => None,
        })
    }
}

fn angle_vectors_forward(angles: [f32; 3]) -> [f32; 3] {
    let (sp, cp) = playsrc_collision::math::sin_cos(angles[0].to_radians());
    let (sy, cy) = playsrc_collision::math::sin_cos(angles[1].to_radians());
    [cp * cy, cp * sy, -sp]
}

fn parse_bool_negated(value: Option<&str>) -> bool {
    let v = value.unwrap_or("0").trim();
    v == "1" || v.to_ascii_lowercase().starts_with("disallow")
}

/// Summary of a trigger_teleport for tooling/tests.
#[derive(Clone, Debug)]
pub struct TeleportInfo {
    pub entity: usize,
    pub enabled: bool,
    pub mins: [f32; 3],
    pub maxs: [f32; 3],
    pub target: String,
    pub filter: Option<String>,
    /// Names the filter requires on the activator (filter_activator_name), if any.
    pub required_name: Option<String>,
    pub destination: Option<[f32; 3]>,
}

pub struct Game {
    world: CollisionWorld,
    props: PropCollision,
    /// What `props` is built from (static props + entity props), for `rebuild_props`.
    prop_sources: Vec<physics::PropSource>,
    texinfo_surface: Vec<u16>,
    /// Collision content that could not be built (unpacked prop models, ...).
    pub physics_diagnostics: Vec<String>,
    /// Number of displacement patches with collision.
    pub displacement_count: usize,
    /// Whether prop collision keeps its triangle soup (`load_with_entities`).
    prop_mesh: bool,
    pub entities: Vec<Entity>,
    ents: Vec<RtEnt>,
    initial_ents: Vec<RtEnt>,
    solid: Vec<usize>,
    dyn_solid: Vec<usize>,
    /// Min-heap on (tick, seq): CEventQueue order. Maps schedule tens of thousands of events at
    /// once (bhop_miku_v2's music relay queues ~90k Toggles), so popping must not be O(n).
    queue: std::collections::BinaryHeap<QueuedEvent>,
    seq: u64,
    pub state: State,
    pub settings: Settings,
    pub rules: Rules,
    config: Configuration,
    policy: Policy,
    pub spawn_origin: [f32; 3],
    pub spawn_angles: [f32; 3],
    pub tick: u32,
    pub events: u32,
    /// Observational only: a clean, unmodified movement tick for local jump statistics. Never feeds physics.
    pub jumpstats_valid: bool,
    /// View angles forced by the last teleport (pitch, yaw, roll).
    pub teleport_angles: [f32; 3],
    /// The player's targetname (bhop maps rename `!activator` to gate filtered teleports).
    pub player_name: String,
    /// The player's classname ("player"; bhop maps `AddOutput classname N` on `!activator` to gate
    /// filter_activator_class teleports per stage).
    pub player_class: String,
    pub health: f32,
    /// Player gravity multiplier (`AddOutput gravity X`).
    pub gravity_scale: f32,
    /// player_speedmod `ModifySpeed` (lagged movement value).
    pub speed_scale: f32,
    last_angles: [f32; 3],
    /// Scratch: hit identities touched by this tick's move.
    contacts: Vec<u64>,
    /// `set_position` restart point since the last reset (feet position, yaw).
    restart_point: Option<([f32; 3], f32)>,
    /// Targetname / classname the player gets at the restart point (`set_restart_names`; bhoptimer's
    /// `shavit_zones_resettargetname_*` / `resetclassname_*` map fixes). None = cleared ("" / "player").
    restart_names: Option<(String, String)>,
    /// Feet position and crouched hull of this tick's trigger touch pass after the player's move
    /// (PhysicsTouchTriggers): every trigger overlapping it is touched, even if one of them (a trigger_teleport)
    /// moves the player away in the same pass. Bhop timers' zones are triggers in that pass, so the run timer
    /// checks end zones here too. NaN before the first step after a reset / respawn at the restart point.
    pub touch_origin: [f32; 3],
    pub touch_crouched: bool,
    /// Where the last movement step left the player (SDK m_vecPreviouslyPredictedOrigin); NaN = never moved.
    last_move_origin: [f32; 3],
    /// gpGlobals->curtime of whatever is firing outputs right now (player clock during touches, server clock during
    /// event service and entity thinks); event fire times are this + delay.
    io_time: f32,
    /// Inside the player's touch processing (player clock).
    in_touch: bool,
    /// Inside the player's +use (PlayerUse in PreThink, player clock).
    in_use: bool,
    /// Player state right after this step's command (move + touches), before entities think and push it: what
    /// the engine's OnPlayerRunCmdPost sees (tools/parity compares this).
    pub state_after_command: State,
    /// Movement steps that failed (state kept, velocity zeroed) and the last failure.
    pub movement_errors: u32,
    pub last_movement_error: String,
    /// trigger_playermovement state (ForceButtons(IN_DUCK) / m_bAllowAutoMovement = false).
    forced_duck: bool,
    auto_movement_disabled: bool,
    near: Vec<(usize, [f32; 3], [f32; 3])>,
    near_region: Option<([f32; 3], [f32; 3])>,
    /// Entity indices by kind (an entity's kind never changes).
    triggers: Vec<usize>,
    /// func_water_analog brush entities (water volumes from physics v4).
    water: Vec<usize>,
    movers: Vec<usize>,
    timers: Vec<usize>,
    /// Kinematic movers (`Data::Kin`), in entity order.
    kins: Vec<usize>,
    /// View angle change applied by rotating pushers this tick (pitch, yaw, roll; FIXANGLE_RELATIVE).
    pub view_angle_change: [f32; 3],
    /// Buttons of the previous command (`m_afButtonLast`), for +use press / release edges.
    last_buttons: u32,
    /// Inside the player's attack (ItemPostFrame in PostThink, player clock).
    in_attack: bool,
    /// The player's weapons and attack timer (physics v4; the knife alone before).
    arms: weapons::Arms,
    /// What the player's attack did this tick (`EVENT_ATTACK`), for the client's effects; None otherwise.
    pub attack: Option<AttackReport>,
    /// Physics v4 world state outside the entity list (breakable health, game_ui, templates, pushable boxes).
    extra: Extra,
    /// WEAPON_EVENT_* flags of this tick (`EVENT_WEAPON`).
    weapon_events: u32,
    /// weapon_* entities and their weapon ids.
    weapon_ents: Vec<(usize, u8)>,
    /// Those items as last reported to the client (`floor_report`; presentation only, the simulation never reads it).
    floor_seen: Vec<weapons::FloorSeen>,
    /// point_template entities and their template entities (by name, at load).
    templates: Vec<minigame::Template>,
    /// The per-map fix this map matched (`game/map_fixes.rs`), if any; its triggers' boxes replace their brushes in
    /// the touch test from physics v8 (`PHYSICS_FIX_MAP_TRIGGERS`). Fixed at load, never part of the state.
    map_fix: Option<&'static str>,
    map_trigger_boxes: Vec<(usize, physics::ConvexBrush)>,
    /// The map's sv_maxvelocity (`map_fixes::MAX_VELOCITY`), if it has one; used from physics v14
    /// (`PHYSICS_FIX_MAP_MAX_VELOCITY`). Fixed at load.
    map_max_velocity: Option<f32>,
    /// The map is in `map_fixes::SIGNED_DOOR_TRAVEL`: from physics v15 (`PHYSICS_FIX_MAP_DOOR_TRAVEL`) its movers use
    /// Source's signed travel. Fixed at load.
    map_signed_door_travel: bool,
    /// The map is in `map_fixes::PLAYER_IO`: from physics v16 (`PHYSICS_FIX_MAP_PLAYER_IO`) the player keeps and fires
    /// its own outputs and filters answer TestActivator. Fixed at load.
    map_player_io: bool,
    /// The map is in `map_fixes::NONLINEAR_OBJECTIVES`: its scripted triggers (entity, role); from physics v16
    /// (`PHYSICS_FIX_MAP_PLAYER_IO`) `game/vscript.rs` runs their scripts. Empty elsewhere. Fixed at load.
    script_triggers: Vec<(usize, vscript::ScriptRole)>,
}

/// Physics v4 world state the entity list doesn't hold; saved with the game state, cleared on reset.
#[derive(Clone, Debug, Default)]
struct Extra {
    /// func_breakable health left after damage (entity -> health); absent = its keyvalue.
    breakable_health: std::collections::BTreeMap<usize, f32>,
    /// func_buttons whose m_hActivator is the player (it used, touched or damaged them): OnDamaged's activator.
    button_activator: std::collections::BTreeSet<usize>,
    /// point_template ForceSpawns with name fixup so far (`name&0001`, ...).
    template_instances: u32,
    /// The game_ui controlling the player.
    game_ui: Option<minigame::ActiveUi>,
    /// func_breakables (SF_BREAK_PRESSURE) the player stood on, breaking after their pressuredelay (v5).
    pressure_breaks: std::collections::BTreeSet<usize>,
    /// Outputs `AddOutput` gave the player (v16, `PHYSICS_FIX_MAP_PLAYER_IO` maps), in the order added; spent ones
    /// (times 0) are dropped, as `CBaseEntityOutput::FireOutput` deletes them.
    player_outputs: Vec<Output>,
    /// Objective triggers the player collected (v16, `NONLINEAR_OBJECTIVES` maps: the script scope's
    /// `nl_collectedObjectives`), entity indices in the order collected.
    objectives: Vec<u32>,
}

impl Extra {
    fn bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for (i, h) in &self.breakable_health {
            out.extend_from_slice(&(*i as u32).to_le_bytes());
            out.extend_from_slice(&h.to_le_bytes());
        }
        for i in &self.button_activator {
            out.extend_from_slice(&(*i as u32).to_le_bytes());
        }
        out.extend_from_slice(&self.template_instances.to_le_bytes());
        if let Some(ui) = self.game_ui {
            out.extend_from_slice(&(ui.ent as u32).to_le_bytes());
            out.extend_from_slice(&ui.last.unwrap_or(u32::MAX).to_le_bytes());
        }
        // (Empty before v5: the digest of older states is unchanged.)
        for i in &self.pressure_breaks {
            out.extend_from_slice(&(*i as u32 | 0x8000_0000).to_le_bytes());
        }
        // (Empty before v16 and on every map outside `map_fixes::PLAYER_IO`: those digests are unchanged.)
        for o in &self.player_outputs {
            for s in [&o.event, &o.target, &o.input, &o.param] {
                out.extend_from_slice(s.as_bytes());
                out.push(0);
            }
            out.extend_from_slice(&o.delay.to_le_bytes());
            out.extend_from_slice(&o.times.to_le_bytes());
        }
        // (Empty before v16 and on every map outside `map_fixes::NONLINEAR_OBJECTIVES`: those digests are unchanged.)
        if !self.objectives.is_empty() {
            out.extend_from_slice(b"objectives\0");
            for i in &self.objectives {
                out.extend_from_slice(&i.to_le_bytes());
            }
        }
        out
    }
}

impl Game {
    pub fn load(bsp: &Bsp) -> Result<Self, String> {
        Self::load_with_content(bsp, None)
    }

    /// Like `load`, with stock game files searched after the map's pakfile for prop collision models
    /// (`.phy`, `.mdl`): the client's hosted content, or the cached content of native tools.
    pub fn load_with_content(bsp: &Bsp, content: Option<crate::vfs::Source>) -> Result<Self, String> {
        Self::load_with_entities(bsp, content, physics::entity_list_with_outputs(bsp, true), true)
    }

    /// `load_with_content` with the entity lump already parsed (`physics::entity_list_with_outputs`), so a caller
    /// can release the lump's bytes before the build (`Bsp::release_lump_payload`; the verifier's memory peak).
    /// `prop_mesh` = false skips the prop collision triangle soup (`prop_collision_mesh`, rendering only).
    pub fn load_with_entities(bsp: &Bsp, content: Option<crate::vfs::Source>, list: EntityList, prop_mesh: bool) -> Result<Self, String> {
        let EntityList { entities, outputs } = list;
        let (map_fix, map_trigger_boxes) = match map_fixes::find(&entities) {
            Some((fix, boxes)) => (Some(fix.map), boxes),
            None => (None, Vec::new()),
        };
        let map_max_velocity = map_fixes::max_velocity(&entities).map(|m| m.max_velocity);
        let map_signed_door_travel = map_fixes::signed_door_travel(&entities).is_some();
        let map_player_io = map_fixes::player_io(&entities).is_some();
        let script_triggers = vscript::script_triggers(&entities);
        let physics::MapPhysics { prop_sources, world, texinfo_surface, props, diagnostics, displacement_count } =
            physics::build_with_entities(bsp, content, &entities, prop_mesh)?;
        let models: &[Model] = match bsp.lump(playsrc_bsp::MODELS).map(|l| &l.records) {
            Some(LumpData::Models(m)) => m,
            _ => &[],
        };
        let tick_interval = Settings::css_bhop().tick_interval;
        let ents: Vec<RtEnt> = entities.iter().zip(outputs).map(|(e, outputs)| build_entity(e, models, tick_interval, outputs)).collect();

        let spawn = ["info_player_counterterrorist", "info_player_terrorist", "info_player_start"]
            .iter()
            .find_map(|class| entities.iter().find(|e| e.classname() == *class))
            .map(|e| (e.origin(), e.angles()))
            .unwrap_or(([0.0; 3], [0.0; 3]));

        let settings = Settings::css_bhop();
        let policy = settings.policy();
        let mut game = Self {
            world,
            props,
            prop_sources,
            texinfo_surface,
            physics_diagnostics: diagnostics,
            displacement_count,
            prop_mesh,
            entities,
            ents,
            initial_ents: Vec::new(),
            solid: Vec::new(),
            dyn_solid: Vec::new(),
            queue: std::collections::BinaryHeap::new(),
            seq: 0,
            state: State::from_player(
                Player { position: spawn.0, velocity: [0.0; 3], grounded: false, crouched: false, jump_latched: false },
                policy,
            ),
            config: Configuration { record_queries: false, ..settings.configuration() },
            policy,
            settings,
            rules: Rules::default(),
            spawn_origin: spawn.0,
            spawn_angles: spawn.1,
            tick: 0,
            events: 0,
            jumpstats_valid: false,
            teleport_angles: spawn.1,
            player_name: String::new(),
            player_class: PLAYER_CLASS.to_string(),
            health: MAX_HEALTH,
            gravity_scale: 1.0,
            speed_scale: 1.0,
            last_angles: spawn.1,
            contacts: Vec::new(),
            restart_point: None,
            restart_names: None,
            touch_origin: [f32::NAN; 3],
            touch_crouched: false,
            last_move_origin: [f32::NAN; 3],
            io_time: 0.0,
            in_touch: false,
            in_use: false,
            state_after_command: State::from_player(
                Player { position: spawn.0, velocity: [0.0; 3], grounded: false, crouched: false, jump_latched: false },
                policy,
            ),
            forced_duck: false,
            auto_movement_disabled: false,
            movement_errors: 0,
            last_movement_error: String::new(),
            near: Vec::new(),
            near_region: None,
            triggers: Vec::new(),
            water: Vec::new(),
            movers: Vec::new(),
            timers: Vec::new(),
            kins: Vec::new(),
            view_angle_change: [0.0; 3],
            last_buttons: 0,
            in_attack: false,
            arms: weapons::Arms::default(),
            attack: None,
            extra: Extra::default(),
            weapon_events: 0,
            weapon_ents: Vec::new(),
            floor_seen: Vec::new(),
            templates: Vec::new(),
            map_fix,
            map_trigger_boxes,
            map_max_velocity,
            map_signed_door_travel,
            map_player_io,
            script_triggers,
        };
        game.link_hierarchy();
        game.link_templates();
        game.link_kinematics();
        game.attach_dynamic_props();
        game.init_fall_probes();
        game.settle_physboxes();
        for (i, e) in game.ents.iter().enumerate() {
            match e.data {
                Data::Trigger(_) => game.triggers.push(i),
                Data::Mover(_) => game.movers.push(i),
                Data::Timer { .. } => game.timers.push(i),
                Data::Kin(_) => game.kins.push(i),
                _ => {}
            }
            if e.class == "func_water_analog" && e.brush.is_some() {
                game.water.push(i);
            }
            if let Some(id) = weapons::weapon_id(&e.class) {
                game.weapon_ents.push((i, id));
            }
        }
        game.floor_seen = vec![weapons::FloorSeen::default(); game.weapon_ents.len()];
        game.link_bhop_blocks();
        game.initial_ents = game.ents.clone();
        game.reset();
        Ok(game)
    }

    pub fn set_settings(&mut self, settings: Settings) {
        let spawn_changed = (self.settings.physics_fixes() ^ settings.physics_fixes())
            & (PHYSICS_FIX_DOOR_START_OPEN | PHYSICS_FIX_TRAIN_SPAWN | PHYSICS_FIX_MAP_DOOR_TRAVEL)
            != 0;
        self.settings = settings;
        self.config = Configuration {
            fixes: self.rules.movement_fixes(settings),
            record_queries: false,
            ..settings.configuration()
        };
        if let Some(v) = self.map_max_velocity.filter(|_| settings.physics_fixes() & PHYSICS_FIX_MAP_MAX_VELOCITY != 0) {
            self.config.maximum_velocity = v;
        }
        self.policy = settings.policy();
        // load_map starts at v1; the client selects its version before building the rendered world.
        // Spawn geometry and spawn-time entity state must follow that selection immediately, even before an explicit restart.
        if spawn_changed {
            self.reset();
        }
    }

    pub fn set_rules(&mut self, rules: Rules) {
        self.rules = rules;
        self.config.fixes = rules.movement_fixes(self.settings);
        self.ents = self.initial_ents.clone();
        self.link_bhop_blocks();
        self.initial_ents = self.ents.clone();
        self.reset();
    }

    /// Restart the map: entity state, event queue and player.
    pub fn reset(&mut self) {
        self.jumpstats_valid = false;
        self.restart_point = None;
        self.restart_names = None;
        self.ents = self.initial_ents.clone();
        if self.map_signed_door_travel && self.settings.physics_fixes() & PHYSICS_FIX_MAP_DOOR_TRAVEL != 0 {
            for k in 0..self.movers.len() {
                let i = self.movers[k];
                apply_signed_travel(&self.entities[i], &mut self.ents[i]);
            }
        }
        if self.settings.physics_fixes() & PHYSICS_FIX_DOOR_START_OPEN != 0 {
            // SDK doors.cpp CBaseDoor::Spawn: StartOpen is position2 / TS_AT_TOP,
            // without scheduling a return or firing movement outputs. Close/Open keep their usual meaning.
            for k in 0..self.movers.len() {
                let i = self.movers[k];
                if initialize_linear_door_spawn(&self.entities[i], &mut self.ents[i]) {
                    for child in 0..self.ents[i].children.len() {
                        self.relink(self.ents[i].children[child]);
                    }
                }
            }
        }
        self.queue.clear();
        self.seq = 0;
        self.tick = 0;
        self.last_buttons = 0;
        self.extra = Extra::default();
        // Map spawn (v4): point_template entities wait for their ForceSpawn.
        if self.settings.physics_fixes() & PHYSICS_FIX_GAME_ENTITIES != 0 {
            self.remove_templates();
        }
        self.respawn_player();
        self.state_after_command = self.state;
        self.events = EVENT_TELEPORTED;
        self.io_time = self.server_time(-1);
        if self.settings.physics_fixes() & PHYSICS_FIX_TRAIN_SPAWN != 0 {
            self.find_train_paths();
        }
        for i in 0..self.ents.len() {
            if let Data::Auto { once } = self.ents[i].data {
                for event in ["onmapspawn", "onnewgame", "onmultinewmap", "onmultinewround"] {
                    self.fire_output(i, event, Actor::None);
                }
                if once {
                    self.ents[i].removed = true;
                }
            }
        }
        // v5: func_lod with "Solid" 0 (or none) is solid. build_entity runs at load, before the version is known.
        if self.settings.physics_fixes() & PHYSICS_FIX_FUNC_LOD != 0 {
            for i in 0..self.ents.len() {
                if self.ents[i].class == "func_lod" && self.ents[i].brush.is_some() && self.entities[i].int("Solid") == 0 {
                    self.ents[i].solid = true;
                }
            }
        }
        self.rebuild_solid();
    }

    /// Respawn the player at the spawn point (map entity state is kept, as on a Source respawn).
    pub fn respawn_player(&mut self) {
        let (origin, angles) = match self.restart_point {
            Some((p, yaw)) => (p, [0.0, yaw, 0.0]),
            None => (self.spawn_origin, self.spawn_angles),
        };
        self.state = State::from_player(
            Player {
                position: origin,
                velocity: [0.0; 3],
                grounded: false,
                crouched: false,
                jump_latched: false,
            },
            self.policy,
        );
        self.teleport_angles = angles;
        self.last_angles = angles;
        self.last_move_origin = [f32::NAN; 3];
        self.player_name.clear();
        self.player_class.clear();
        self.player_class.push_str(PLAYER_CLASS);
        // A restart is a fresh player: no outputs from the last attempt (v16; always empty elsewhere), and no objectives
        // (v16 NONLINEAR_OBJECTIVES maps; in CS:S a respawn lands in the start room's script triggers, which clear them).
        self.extra.player_outputs.clear();
        self.extra.objectives.clear();
        if let (Some(_), Some((name, class))) = (self.restart_point, &self.restart_names) {
            self.player_name.clone_from(name);
            self.player_class.clone_from(class);
        }
        self.touch_origin = [f32::NAN; 3];
        self.touch_crouched = false;
        self.arms = weapons::Arms::default();
        self.health = MAX_HEALTH;
        self.gravity_scale = 1.0;
        self.speed_scale = 1.0;
        self.forced_duck = false;
        self.auto_movement_disabled = false;
        for e in &mut self.ents {
            if let Data::Trigger(t) = &mut e.data {
                t.linked = false;
                t.touching = false;
            }
            if let Data::Mover(Mover { bhop: Some(b), .. }) = &mut e.data {
                b.standing_ticks = 0;
            }
        }
    }

    /// Restart point (bhop-server style start-zone restart): respawns the player at `position`
    /// facing `yaw`, with zero velocity, no ground, standing, fresh name/health/gravity, and makes
    /// it the respawn point (deaths respawn here) until the next `reset()`. The position is settled
    /// deterministically: lifted out of solid (up to 64 units) and dropped onto the floor below
    /// (up to 256 units). Replays record it in their header and re-apply it right after reset.
    pub fn set_position(&mut self, position: [f32; 3], yaw: f32) {
        let settled = self.settle(position);
        self.restart_point = Some((settled, yaw));
        self.respawn_player();
        self.events |= EVENT_TELEPORTED;
    }

    /// Names the player gets at the restart point (now and on every respawn there) until the next `reset()`:
    /// bhoptimer's restart puts the player in the start zone with `shavit_zones_resettargetname_*` /
    /// `shavit_zones_resetclassname_*` (empty = "" / "player"), which its map fixes set per map (bhop_japan:
    /// classname "beginner", else the start zone's teleport sends every fresh player back to the spawn room).
    /// Call after `set_position`. Replays record the names with the restart point.
    pub fn set_restart_names(&mut self, targetname: &str, classname: &str) {
        let class = if classname.is_empty() { PLAYER_CLASS } else { classname };
        self.restart_names = Some((targetname.to_string(), class.to_string()));
        self.player_name = targetname.to_string();
        self.player_class = class.to_string();
    }

    /// The restart point set since the last reset, as (feet position, yaw).
    pub fn restart_point(&self) -> Option<([f32; 3], f32)> {
        self.restart_point
    }

    /// Idempotent settle: `settle(settle(p)) == settle(p)` bit for bit. Replays record the settled restart point
    /// and re-simulation settles it again, so a point that is already settled must come back unchanged.
    ///
    /// `settle_once` alone isn't idempotent: its floor trace ends at `start + fraction * (end - start)` in f32, which
    /// depends on the start height, so re-settling a settled point can move z by an ulp (-30.968748 -> -30.96875).
    /// Here a point is returned as is when `settle_once` would move it by at most `SETTLE_EPSILON` (it is already
    /// resting on the floor), else the result is settled again until that holds. For any `p` whose `settle_once` is
    /// a fixed point (every restart point a verified replay recorded: the verifier re-settles it and checks the
    /// trajectory bit for bit), the result is exactly `settle_once(p)` = `p`, as before.
    fn settle(&self, position: [f32; 3]) -> [f32; 3] {
        /// Well below the 1/32 unit (DIST_EPSILON) gap a floor trace leaves, well above f32 rounding at map scale
        /// (one ulp at |z| = 16384 is 0.002).
        const SETTLE_EPSILON: f32 = 1.0 / 64.0;
        if position.iter().any(|v| !v.is_finite() || v.abs() > OUT_OF_WORLD) {
            return self.spawn_origin;
        }
        let close = |a: [f32; 3], b: [f32; 3]| (0..3).all(|k| (a[k] - b[k]).abs() <= SETTLE_EPSILON);
        let mut p = position;
        for _ in 0..8 {
            let q = self.settle_once(p);
            if close(p, q) {
                return p;
            }
            p = q;
        }
        p
    }

    fn settle_once(&self, position: [f32; 3]) -> [f32; 3] {
        if position.iter().any(|v| !v.is_finite() || v.abs() > OUT_OF_WORLD) {
            return self.spawn_origin;
        }
        let hull = self.policy.standing_hull;
        let scene = self.scene(0.0);
        let mask = self.config.solid_mask;
        let free = |p: [f32; 3]| scene.trace_filtered(p, p, hull, mask, &[]).is_ok_and(|t| !t.start_solid);
        let Some(lift) = (0..=64).map(|dz| dz as f32).find(|dz| free([position[0], position[1], position[2] + dz])) else {
            return position;
        };
        let start = [position[0], position[1], position[2] + lift];
        match scene.trace_filtered(start, [start[0], start[1], start[2] - 256.0], hull, mask, &[]) {
            Ok(t) if !t.start_solid && t.fraction < 1.0 => t.end,
            _ => start,
        }
    }

    /// Place the player at `position` (feet) with zero velocity; used by tools/tests.
    pub fn place_player(&mut self, position: [f32; 3]) {
        self.state.position = position;
        self.state.velocity = [0.0; 3];
        self.state.base_velocity = [0.0; 3];
        self.state.ground = None;
        self.unstick();
    }

    fn scene(&self, time: f32) -> Scene<'_> {
        Scene {
            world: &self.world,
            props: &self.props,
            texinfo_surface: &self.texinfo_surface,
            surfaces: self.rules.surface_properties,
            ents: &self.ents,
            solid: &self.solid,
            dyn_solid: &self.dyn_solid,
            near: &self.near,
            region: self.near_region,
            time,
            vphysics_separation: self.settings.physics_fixes() & PHYSICS_FIX_VPHYSICS_SEPARATION != 0,
            water: if self.settings.physics_fixes() & PHYSICS_FIX_WATER_ANALOG != 0 { &self.water } else { &[] },
        }
    }

    /// Collect the solid brush entities the coming movement step can possibly touch.
    fn update_broadphase(&mut self) {
        let dt = self.settings.tick_interval * self.speed_scale.max(1.0);
        let v = self.state.velocity;
        let b = self.state.base_velocity;
        // Generous: velocity (+ a jump impulse, base velocity) over the tick, step-up and
        // stay-on-ground probes, stuck nudges, crouch lifts.
        let reach = ((v[0].abs() + v[1].abs() + v[2].abs() + b[0].abs() + b[1].abs() + b[2].abs() + 600.0) * dt * 2.0
            + 128.0)
            .min(4096.0);
        let p = self.state.position;
        let lo = [p[0] - 16.0 - reach, p[1] - 16.0 - reach, p[2] - reach];
        let hi = [p[0] + 16.0 + reach, p[1] + 16.0 + reach, p[2] + 72.0 + reach];
        self.near.clear();
        for &i in &self.solid {
            let Some(brush) = &self.ents[i].brush else { continue };
            let (blo, bhi) = brush.world_bounds();
            if (0..3).all(|k| blo[k] <= hi[k] + 1.0 && bhi[k] >= lo[k] - 1.0) {
                self.near.push((i, blo, bhi));
            }
        }
        self.near_region = Some((lo, hi));
    }

    /// After a teleport: if the player's hull is embedded (typically a destination exactly on the
    /// floor plane, which CM_ClipBoxToBrush treats as start-solid), nudge it free right away.
    /// Source leaves this to CheckStuck, which on a server runs only once per second
    /// (CHECK_STUCK_INTERVAL), freezing the player for up to 1 s after such teleports.
    fn unstick(&mut self) {
        let hull = self.current_hull();
        let mask = self.config.solid_mask;
        let p = self.state.position;
        let scene = self.scene(0.0);
        let free = |q: [f32; 3]| scene.trace_filtered(q, q, hull, mask, &[]).is_ok_and(|t| !t.start_solid);
        if free(p) {
            return;
        }
        const UP: [f32; 11] = [0.125, 0.25, 0.5, 1.0, 2.0, 4.0, 6.0, 8.0, 12.0, 16.0, 18.0];
        let mut candidates: Vec<[f32; 3]> = UP.iter().map(|&z| [0.0, 0.0, z]).collect();
        for z in [0.0, 1.0, 6.0] {
            for (x, y) in [(2.0, 0.0), (-2.0, 0.0), (0.0, 2.0), (0.0, -2.0), (2.0, 2.0), (-2.0, -2.0), (2.0, -2.0), (-2.0, 2.0)] {
                candidates.push([x, y, z]);
            }
        }
        candidates.push([0.0, 0.0, -0.125]);
        if let Some(c) = candidates.into_iter().map(|o| [p[0] + o[0], p[1] + o[1], p[2] + o[2]]).find(|&q| free(q)) {
            self.state.position = c;
        }
    }

    fn current_hull(&self) -> Hull {
        if self.state.crouch.uses_crouched_hull() { self.policy.crouched_hull } else { self.policy.standing_hull }
    }

    fn rebuild_solid(&mut self) {
        self.solid.clear();
        self.dyn_solid.clear();
        for (i, e) in self.ents.iter().enumerate() {
            if e.solid && !e.removed {
                if e.brush.is_some() {
                    self.solid.push(i);
                } else if e.prop.is_some() {
                    self.dyn_solid.push(i);
                }
            }
        }
    }

    pub fn step(&mut self, cmd: Cmd) -> Result<(), String> {
        self.jumpstats_valid = false;
        let before_events = self.state;
        self.events = 0;
        self.attack = None;
        self.weapon_events = 0;
        self.view_angle_change = [0.0; 3];
        self.last_angles = [cmd.pitch, cmd.yaw, 0.0];

        self.service_events();
        self.rebuild_solid();

        // Fell out of the world (or a non-finite state): Source would kill the player.
        if self.state.position.iter().chain(&self.state.velocity).any(|v| !v.is_finite())
            || self.state.position.iter().any(|v| v.abs() > OUT_OF_WORLD)
        {
            self.die();
        }

        let was_grounded = self.state.ground.is_some();
        let clean_before = before_events.position == self.state.position
            && before_events.velocity == self.state.velocity
            && self.state.water_level == 0 && self.state.base_velocity == [0.0; 3]
            && self.gravity_scale == 1.0 && self.speed_scale == 1.0 && self.settings.gravity == 800.0
            && self.state.ground.is_none_or(|g| g.support.is_none_or(|hit| hit_entity(hit).is_none()) && g.normal[2] >= 0.99 && g.jump_factor == 1.0);
        // Historical autohop mode (also used by our srcds parity plugin): IN_JUMP is stripped while the
        // player is airborne at the start of the tick (not on a ladder, water level < 2), so the engine's
        // jump latch is clear on the landing tick and holding jump re-jumps at once. Shavit instead clears old jump
        // buttons without stripping the current command; that separate server-policy choice is not enabled here. The strip uses the
        // pre-move ground state: a tick that starts airborne never jumps, even if the player is categorized onto the
        // ground before moving (after a teleport). Verified against srcds (tools/parity).
        let mut buttons = cmd.buttons;
        if self.settings.autohop
            && buttons & IN_JUMP != 0
            && !was_grounded
            && self.state.mode != movement::Mode::Ladder
            && self.state.water_level < 2
        {
            buttons &= !IN_JUMP;
        }

        // CBasePlayer::PreThink -> ItemPreFrame -> PlayerUse, before the movement of this command.
        let (pressed, released) = (cmd.buttons & !self.last_buttons, self.last_buttons & !cmd.buttons);
        self.last_buttons = cmd.buttons;
        // A weapon command (v7: bhoptimer's !usp / !glock / !knife, a console command run between usercmds), then
        // PlayerRunCommand: a weapon slot request (ucmd->weaponselect) or a drop, before the move (v4).
        if self.settings.physics_fixes() & PHYSICS_FIX_WEAPON_COMMANDS != 0 && cmd.buttons & IN_GIVE_MASK != 0 {
            self.weapon_command(((cmd.buttons & IN_GIVE_MASK) >> IN_GIVE_SHIFT) as u8, cmd.buttons);
        }
        if self.settings.physics_fixes() & PHYSICS_FIX_WEAPONS != 0 && (cmd.buttons & IN_SLOT_MASK != 0 || pressed & IN_DROP != 0) {
            self.weapon_pre_think(cmd, pressed);
        }
        if (cmd.buttons | pressed | released) & IN_USE != 0 {
            // PreThink runs inside the player's usercmd, on the player's clock (like touches).
            self.io_time = self.player_time();
            self.in_use = true;
            self.player_use(cmd, pressed, released);
            self.in_use = false;
            self.rebuild_solid();
        }

        self.contacts.clear();
        let pre_velocity = self.state.velocity;
        let mut wall_hit = false;
        if self.speed_scale > 0.0 {
            // game_ui's FL_ATCONTROLS (v4): no movement from the command.
            let (cmd_forward, cmd_side) = if self.at_controls() { (0.0, 0.0) } else { (cmd.forward, cmd.side) };
            let (forward, side) = self.avoid_pushaway_props(cmd_forward, cmd_side, cmd.pitch, cmd.yaw);
            let input = StepInput {
                command_number: self.tick,
                command: Command {
                    forward: forward.clamp(-movement::MAX_COMMAND_MAGNITUDE, movement::MAX_COMMAND_MAGNITUDE),
                    side: side.clamp(-movement::MAX_COMMAND_MAGNITUDE, movement::MAX_COMMAND_MAGNITUDE),
                    yaw_degrees: cmd.yaw,
                    jump: buttons & IN_JUMP != 0,
                    crouch: cmd.buttons & IN_DUCK != 0 || self.forced_duck,
                },
                pitch_degrees: cmd.pitch,
                // SDK SetupMove: the origin differs from where the last move left it (teleport, respawn,
                // pusher, AddOutput origin) -> CategorizePosition before moving (measured with tools/parity).
                game_code_moved: self.state.position != self.last_move_origin,
                ..Default::default()
            };
            let mut config = self.config;
            config.gravity_scale = self.gravity_scale;
            config.lagged_movement_scale = self.speed_scale;
            config.allow_auto_movement = !self.auto_movement_disabled;
            self.update_broadphase();
            let scene = self.scene(self.tick as f32 * self.settings.tick_interval);
            let result = match movement::step(&scene, self.state, input, config, self.policy) {
                Ok(r) => r,
                Err(e) => {
                    // Never wedge the client on a movement failure: keep the position, drop the
                    // velocity (deterministically) and report it.
                    self.movement_errors += 1;
                    self.last_movement_error = format!("{e:?}");
                    self.state.velocity = [0.0; 3];
                    self.state.ground = None;
                    self.near_region = None;
                    self.io_time = self.player_time();
                    self.note_touch_origin();
                    self.touch_triggers();
                    self.rebuild_solid();
                    self.advance_all_movers();
                    self.untouch_triggers();
                    self.tick += 1;
                    return Ok(());
                }
            };
            if result.jump_velocity != [0.0; 3] {
                self.events |= EVENT_JUMPED;
            }
            self.jumpstats_valid = clean_before && result.state.water_level == 0
                && result.state.base_velocity == [0.0; 3] && result.mover_result.is_none()
                // CheckJumpButton adds 0.15 to the view's step smoothing even on a flat takeoff.
                && result.climbed_step <= if result.jump_velocity != [0.0; 3] { 0.15 } else { 0.0 }
                && result.contacts.iter().all(|c| c.normal[2] >= 0.99);
            self.contacts.extend(result.contacts.iter().filter_map(|c| c.hit));
            self.last_move_origin = result.state.position;
            wall_hit = result.contacts.iter().any(|c| c.normal[2].abs() < 0.7);
            self.state = result.state;
            self.near_region = None;
        }
        if !was_grounded && self.state.ground.is_some() {
            self.events |= EVENT_LANDED;
        }

        // Touches run inside the player's usercmd, on the player's clock.
        let after_movement = self.state;
        self.io_time = self.player_time();
        self.in_touch = true;
        let contacts = std::mem::take(&mut self.contacts);
        self.touch_solids(&contacts);
        self.contacts = contacts;
        self.note_touch_origin();
        self.touch_triggers();
        if self.settings.physics_fixes() & PHYSICS_FIX_WEAPONS != 0 {
            self.weapon_pickups();
        }
        self.in_touch = false;
        // CBasePlayer::PostThink -> ItemPostFrame: the active weapon, after the command's movement and touches (v4).
        if self.settings.physics_fixes() & PHYSICS_FIX_KNIFE != 0 && !self.weapon_hidden() {
            self.weapon_post_frame(cmd);
        }
        self.state_after_command = self.state;
        if self.rules.telehop_fix && wall_hit && self.events & EVENT_TELEPORTED != 0 && self.events & EVENT_RESPAWNED == 0
        {
            // RNGFix-style telehop: the wall hit and the teleport happened in the same tick; keep
            // the horizontal velocity from before the collision (if it was faster).
            let h = |v: [f32; 3]| v[0] * v[0] + v[1] * v[1];
            if h(pre_velocity) > h(self.state.velocity) && self.rules.teleport_keeps_velocity {
                self.state.velocity[0] = pre_velocity[0];
                self.state.velocity[1] = pre_velocity[1];
            }
        }
        self.rebuild_solid();
        self.advance_all_movers();
        // game_ui Think (v4), with the other entity thinks after the player.
        if self.settings.physics_fixes() & PHYSICS_FIX_GAME_ENTITIES != 0 && self.extra.game_ui.is_some() {
            self.game_ui_think(cmd, pressed);
        }
        self.untouch_triggers();
        self.jumpstats_valid &= self.state.position == after_movement.position
            && self.state.velocity == after_movement.velocity && self.state.base_velocity == [0.0; 3]
            && self.gravity_scale == 1.0 && self.speed_scale == 1.0
            && self.state.ground.is_none_or(|g| g.support.is_none_or(|hit| hit_entity(hit).is_none()) && g.normal[2] >= 0.99 && g.jump_factor == 1.0);
        self.tick += 1;
        Ok(())
    }

    /// Brush entities simulate after the player within a server frame (Physics_RunThinkFunctions runs
    /// the players' commands first, then every other entity; verified against the real engine with
    /// tools/parity): func_door / func_button movers, then the kinematic movers in entity order.
    fn advance_all_movers(&mut self) {
        // Entity thinks run after the players, on the server clock of this frame.
        self.io_time = self.server_time(i64::from(self.tick));
        self.advance_movers();
        self.advance_kinematics();
        self.rebuild_solid();
    }

    /// obstacle_pushaway.cpp `AvoidPushawayProps`, which CS:S applies to every usercmd: a SOLID-mode
    /// prop_physics_multiplayer the player's box touches (or comes within 5 units of) adds a push away from it to
    /// forwardmove / sidemove (sv_pushaway_player_force 200000 / distance, scaled by mass/30 clamped to
    /// 10..30 kg, at most sv_pushaway_max_player_force 10000). Verified on the real engine (tools/parity
    /// cobble_prop: the player stops in front of a barrel it can't collide with). The props stay at their
    /// (settled) spawn pose here; in CS:S a player moving faster than 75 u/s also pushes them
    /// (PerformObstaclePushaway). Returns the new (forward, side); the magnitude is limited to the movement
    /// code's command range while keeping the direction (CheckParameters scales to maxspeed anyway).
    fn avoid_pushaway_props(&self, forward: f32, side: f32, pitch: f32, yaw: f32) -> (f32, f32) {
        if self.props.pushaway.is_empty() {
            return (forward, side);
        }
        let hull = self.current_hull();
        let p = self.state.position;
        let lo = [p[0] + hull.mins[0], p[1] + hull.mins[1], p[2] + hull.mins[2]];
        let hi = [p[0] + hull.maxs[0], p[1] + hull.maxs[1], p[2] + hull.maxs[2]];
        let center = [(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5, (lo[2] + hi[2]) * 0.5];
        let (sp, cp) = playsrc_collision::math::sin_cos(pitch.to_radians());
        let (sy, cy) = playsrc_collision::math::sin_cos(yaw.to_radians());
        let dir = [cp * cy, cp * sy, -sp];
        let right = [sy, -cy, 0.0];
        let (mut forward, mut side) = (forward, side);
        for prop in &self.props.pushaway {
            let i = (prop.tag & !physics::ENTITY_PROP) as usize;
            if self.ents.get(i).is_none_or(|e| e.removed) {
                continue;
            }
            let t = Transform { origin: prop.origin, angles: prop.angles };
            // Partition query: the prop's world AABB (TransformAABB of its OBB) against the player's box.
            let (mut wlo, mut whi) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
            for c in 0..8 {
                let corner = [
                    if c & 1 != 0 { prop.maxs[0] } else { prop.mins[0] },
                    if c & 2 != 0 { prop.maxs[1] } else { prop.mins[1] },
                    if c & 4 != 0 { prop.maxs[2] } else { prop.mins[2] },
                ];
                let w = t.transform_point(corner).unwrap_or(prop.origin);
                for k in 0..3 {
                    wlo[k] = wlo[k].min(w[k]);
                    whi[k] = whi[k].max(w[k]);
                }
            }
            if (0..3).any(|k| whi[k] < lo[k] || wlo[k] > hi[k]) {
                continue;
            }
            // CollisionProp()->CalcNearestPoint on the prop's OBB, then on the player's box.
            let local = t.inverse_transform_point(center).unwrap_or(center);
            let clamped = [0, 1, 2].map(|k| local[k].clamp(prop.mins[k], prop.maxs[k]));
            let prop_point = t.transform_point(clamped).unwrap_or(prop.origin);
            let player_point = [0, 1, 2].map(|k| prop_point[k].clamp(lo[k], hi[k]));
            let normalize = |v: [f32; 3]| {
                let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
                if l > 0.0 { ([v[0] / l, v[1] / l, v[2] / l], l) } else { ([0.0; 3], 0.0) }
            };
            let (mut push, mut dist) = normalize([0, 1, 2].map(|k| player_point[k] - prop_point[k]));
            let inside = (0..3).all(|k| prop_point[k] >= lo[k] && prop_point[k] <= hi[k]);
            if dist > 5.0 && !inside {
                continue;
            }
            if push == [0.0; 3] {
                (push, dist) = normalize([0, 1, 2].map(|k| center[k] - prop_point[k]));
            }
            if push == [0.0; 3] {
                let (wc_lo, wc_hi) = (wlo, whi);
                let prop_center = [0, 1, 2].map(|k| (wc_lo[k] + wc_hi[k]) * 0.5);
                (push, dist) = normalize([0, 1, 2].map(|k| center[k] - prop_center[k]));
            }
            let dist = dist.max(1.0);
            let mass = prop.mass.clamp(10.0, 30.0) / 30.0;
            let force = (200_000.0 / dist * mass).min(10_000.0);
            let v = push.map(|c| c * force);
            forward += v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2];
            side += v[0] * right[0] + v[1] * right[1] + v[2] * right[2];
        }
        let m = movement::MAX_COMMAND_MAGNITUDE;
        let len = forward.abs().max(side.abs());
        if len > m {
            forward *= m / len;
            side *= m / len;
        }
        (forward, side)
    }

    fn die(&mut self) {
        self.respawn_player();
        self.events |= EVENT_TELEPORTED | EVENT_RESPAWNED;
    }

    // ---------------------------------------------------------------- entity I/O

    fn delay_ticks(&self, delay: f32) -> u32 {
        (delay / self.settings.tick_interval).round().max(0.0) as u32
    }

    fn fire_output(&mut self, ent: usize, event: &str, activator: Actor) {
        let mut queued = Vec::new();
        let mut counted = false;
        for o in self.ents[ent].outputs.iter() {
            if &*o.event != event || o.times == 0 {
                continue;
            }
            counted |= o.times > 0;
            queued.push((o.target.clone(), o.input.clone(), o.param.clone(), o.delay));
        }
        if self.settings.physics_fixes() & PHYSICS_FIX_OUTPUT_ORDER != 0 {
            queued.reverse();
        }
        // Limited outputs (times > 0) lose one fire; only then is the shared list copied.
        if counted {
            for o in std::sync::Arc::make_mut(&mut self.ents[ent].outputs).iter_mut() {
                if &*o.event == event && o.times > 0 {
                    o.times -= 1;
                }
            }
        }
        for (target, input, param, delay) in queued {
            let fire_time = self.io_time + delay.max(0.0);
            self.seq += 1;
            self.queue.push(QueuedEvent {
                fire_time,
                seq: self.seq,
                target,
                input,
                param,
                activator,
                caller: Actor::Entity(ent),
            });
        }
    }

    /// v16: the player's own outputs and filter tests run on this map (`map_fixes::PLAYER_IO`, `PHYSICS_FIX_MAP_PLAYER_IO`).
    fn player_io(&self) -> bool {
        self.map_player_io && self.settings.physics_fixes() & PHYSICS_FIX_MAP_PLAYER_IO != 0
    }

    /// `fire_output` for the outputs `AddOutput` gave the player (v16): caller = the player; spent outputs are removed.
    fn fire_player_output(&mut self, event: &str, activator: Actor) {
        let mut queued: Vec<_> = self
            .extra
            .player_outputs
            .iter()
            .filter(|o| &*o.event == event && o.times != 0)
            .map(|o| (o.target.clone(), o.input.clone(), o.param.clone(), o.delay))
            .collect();
        // CBaseEntityOutput::AddEventAction prepends, so the SDK fires the newest first (v16 always has OUTPUT_ORDER).
        if self.settings.physics_fixes() & PHYSICS_FIX_OUTPUT_ORDER != 0 {
            queued.reverse();
        }
        for o in self.extra.player_outputs.iter_mut() {
            if &*o.event == event && o.times > 0 {
                o.times -= 1;
            }
        }
        self.extra.player_outputs.retain(|o| o.times != 0);
        for (target, input, param, delay) in queued {
            let fire_time = self.io_time + delay.max(0.0);
            self.seq += 1;
            self.queue.push(QueuedEvent { fire_time, seq: self.seq, target, input, param, activator, caller: Actor::Player });
        }
    }

    /// Server time (gpGlobals->curtime) of server frame `frame` ticks after the reset tick: TICKS_TO_TIME.
    fn server_time(&self, frame: i64) -> f32 {
        let tick = i64::from(self.rules.server_tick_base) + frame;
        (tick as f32) * self.settings.tick_interval
    }

    /// The player's usercmd clock for this step (tickbase = server tick + lead).
    fn player_time(&self) -> f32 {
        self.server_time(i64::from(self.tick) + i64::from(self.player_clock_lead()))
    }

    /// Ticks the player's usercmd clock leads the server clock by.
    fn player_clock_lead(&self) -> u32 {
        self.rules.player_clock_lead.unwrap_or_else(|| {
            // TIME_TO_TICKS(sv_clockcorrection_msecs 60 ms), minus the command being run.
            (((0.06 / self.settings.tick_interval) + 0.5) as u32).saturating_sub(1)
        })
    }

    /// CEventQueue::ServiceEvents at the end of the previous server frame (start of this step).
    fn service_events(&mut self) {
        let now = self.server_time(i64::from(self.tick) - 1);
        self.io_time = now;
        for _ in 0..MAX_EVENTS_PER_TICK {
            // Earliest due event; ties keep insertion order (CEventQueue semantics).
            if self.queue.peek().is_none_or(|e| e.fire_time > now) {
                break;
            }
            let event = self.queue.pop().expect("peeked");
            if self.settings.physics_fixes() & PHYSICS_FIX_WEAPONS != 0
                && (event.input.eq_ignore_ascii_case("kill") || event.input.eq_ignore_ascii_case("killhierarchy"))
            {
                self.kill_held_weapons(&event.target);
            }
            for target in self.resolve_targets(&event.target, event.activator, event.caller) {
                self.accept_input(target, &event.input, &event.param, event.activator, event.caller);
            }
        }
        for k in 0..self.timers.len() {
            let i = self.timers[k];
            if let Data::Timer { enabled: true, refire, next_tick } = self.ents[i].data {
                let ticks = self.delay_ticks(refire).max(1);
                let due = next_tick != u32::MAX && self.tick >= next_tick;
                if !self.ents[i].removed && (due || next_tick == u32::MAX) {
                    if let Data::Timer { next_tick, .. } = &mut self.ents[i].data {
                        *next_tick = self.tick + ticks;
                    }
                    if due {
                        self.fire_output(i, "ontimer", Actor::None);
                    }
                }
            }
        }
    }

    fn resolve_targets(&self, target: &str, activator: Actor, caller: Actor) -> Vec<Actor> {
        if target.trim().is_empty() {
            return Vec::new();
        }
        let lower = target.to_ascii_lowercase();
        match lower.as_str() {
            "!activator" => return if activator == Actor::None { vec![] } else { vec![activator] },
            "!caller" | "!self" => return if caller == Actor::None { vec![] } else { vec![caller] },
            "!player" | "!pvsplayer" | "!picker" => return vec![Actor::Player],
            _ => {}
        }
        let mut out: Vec<Actor> = self
            .ents
            .iter()
            .enumerate()
            .filter(|(_, e)| !e.removed && name_matches(target, &e.name))
            .map(|(i, _)| Actor::Entity(i))
            .collect();
        if name_matches(target, &self.player_name) {
            out.push(Actor::Player);
        }
        if out.is_empty() {
            // FindEntityGeneric falls back to classname.
            out = self
                .ents
                .iter()
                .enumerate()
                .filter(|(_, e)| !e.removed && name_matches(target, &e.class))
                .map(|(i, _)| Actor::Entity(i))
                .collect();
            if name_matches(target, &self.player_class) {
                out.push(Actor::Player);
            }
        }
        out
    }

    fn accept_input(&mut self, target: Actor, input: &str, param: &str, activator: Actor, _caller: Actor) {
        let input = input.to_ascii_lowercase();
        match target {
            Actor::None => {}
            Actor::Player => self.player_input(&input, param, activator),
            Actor::Entity(i) => self.entity_input(i, &input, param, activator),
        }
    }

    fn player_input(&mut self, input: &str, param: &str, activator: Actor) {
        match input {
            // v16 (`PHYSICS_FIX_MAP_PLAYER_IO` maps): `AddOutput "OnUser1 target:input:param:delay:times"` gives the
            // player an output (CBaseEntity::InputAddOutput -> KeyValue -> the output's ParseEventAction).
            "addoutput" if self.player_io() && Output::parse_add_output(param).is_some() => {
                self.extra.player_outputs.extend(Output::parse_add_output(param));
            }
            "fireuser1" | "fireuser2" | "fireuser3" | "fireuser4" if self.player_io() => {
                let event = format!("onuser{}", &input[8..]);
                self.fire_player_output(&event, activator);
            }
            // v16 (`NONLINEAR_OBJECTIVES` maps): the start room's `!activator,RunScriptFile,danzay/nonlinear.nut`.
            "runscriptfile" if self.objectives_on() => self.run_script_file(param),
            "addoutput" => {
                let (key, value) = param.trim().split_once(char::is_whitespace).unwrap_or((param.trim(), ""));
                let value = value.trim();
                match key.to_ascii_lowercase().as_str() {
                    "targetname" => {
                        if std::env::var_os("PARITY_DEBUG").is_some() {
                            eprintln!("tick {} player name {:?} -> {value:?}", self.tick, self.player_name);
                        }
                        self.player_name = value.to_string()
                    }
                    // CBaseEntity::KeyValue "classname" sets m_iClassname (filter_activator_class reads it).
                    "classname" => self.player_class = value.to_string(),
                    "gravity" => {
                        let g = value.parse::<f32>().unwrap_or(1.0);
                        // CBaseEntity::KeyValue "gravity" is a plain atof: negative values make StartGravity /
                        // FinishGravity accelerate the player upward (bhop_alt_saimaa's jump pad: -0.5 for 0.55 s,
                        // apex 570.8 on the real engine, tools/parity). Only the 0 -> 1 default is special.
                        self.gravity_scale = if g == 0.0 || !g.is_finite() { 1.0 } else { g.clamp(-100.0, 100.0) };
                    }
                    "basevelocity" => {
                        // CBaseEntity keyfield m_vecBaseVelocity without FL_BASEVELOCITY: the next
                        // PlayerMove turns it into a one-off velocity impulse (basevelocity boosters).
                        let v: Vec<f32> = value.split_whitespace().filter_map(|s| s.parse().ok()).collect();
                        if v.len() == 3 && v.iter().all(|x| x.is_finite()) {
                            self.state.base_velocity = [v[0], v[1], v[2]];
                            self.state.base_velocity_applied = false;
                        }
                    }
                    "origin" => {
                        let v: Vec<f32> = value.split_whitespace().filter_map(|s| s.parse().ok()).collect();
                        if v.len() == 3 && v.iter().all(|x| x.is_finite()) {
                            self.state.position = [v[0], v[1], v[2]];
                            self.state.ground = None;
                            self.events |= EVENT_TELEPORTED;
                            self.teleport_angles = self.last_angles;
                            self.unstick();
                        }
                    }
                    _ => {}
                }
            }
            "kill" => self.die(),
            "sethealth" => {
                self.health = param.trim().parse::<f32>().unwrap_or(MAX_HEALTH).min(MAX_HEALTH);
                if self.health <= 0.0 {
                    self.die();
                }
            }
            "modifyspeed" => self.set_speed_scale(param),
            _ => {} // SetDamageFilter, SetFogController, ...: no gameplay effect here
        }
    }

    fn set_speed_scale(&mut self, param: &str) {
        let v = param.trim().parse::<f32>().unwrap_or(1.0);
        self.speed_scale = if v.is_finite() { v.clamp(0.0, 10.0) } else { 1.0 };
    }

    fn entity_input(&mut self, i: usize, input: &str, param: &str, activator: Actor) {
        if self.ents[i].removed {
            return;
        }
        // v16 (`NONLINEAR_OBJECTIVES` maps): a scripted trigger's ConnectOutput action runs its script function.
        if input == "callscriptfunction" && self.objectives_on() && self.call_script_function(i, param, activator) {
            return;
        }
        // point_template / game_ui (v4).
        if self.settings.physics_fixes() & PHYSICS_FIX_GAME_ENTITIES != 0 {
            match (self.ents[i].class.as_str(), input) {
                ("point_template", "forcespawn") => return self.force_spawn(i, activator),
                ("game_ui", _) => {
                    if self.game_ui_input(i, input, param, activator) {
                        return;
                    }
                }
                _ => {}
            }
        }
        // Map-given weapons (v4): CGamePlayerEquip::Use / CStripWeapons::InputStripWeapons on the activating player.
        if self.settings.physics_fixes() & PHYSICS_FIX_WEAPONS != 0 && activator == Actor::Player {
            match (self.ents[i].class.as_str(), input) {
                ("game_player_equip", "use") => return self.equip_player(i),
                ("player_weaponstrip", "strip" | "stripweaponsandsuit") => return self.strip_player(),
                _ => {}
            }
        }
        // v16 (`PHYSICS_FIX_MAP_PLAYER_IO` maps): CBaseFilter::InputTestActivator fires OnPass or OnFail with the
        // input's activator, by the same PassesFilter test triggers use, applied to that activator.
        if input == "testactivator" && matches!(self.ents[i].data, Data::Filter { .. }) && self.player_io() {
            let pass = match activator {
                Actor::None => return,
                Actor::Player => self.filter_entity_passes(i, &self.player_name, &self.player_class, 0),
                Actor::Entity(j) => self.filter_entity_passes(i, &self.ents[j].name, &self.ents[j].class, 0),
            };
            self.fire_output(i, if pass { "onpass" } else { "onfail" }, activator);
            return;
        }
        // Inputs every entity accepts.
        match input {
            "kill" | "killhierarchy" => {
                self.ents[i].removed = true;
                return;
            }
            "addoutput" => {
                if let Some(output) = Output::parse_add_output(param) {
                    std::sync::Arc::make_mut(&mut self.ents[i].outputs).push(output);
                } else if let Some((key, value)) = param.trim().split_once(char::is_whitespace) {
                    if key.eq_ignore_ascii_case("targetname") {
                        self.ents[i].name = value.trim().to_string();
                    }
                }
                return;
            }
            "fireuser1" | "fireuser2" | "fireuser3" | "fireuser4" => {
                let n = &input[8..];
                self.fire_output(i, &format!("onuser{n}"), activator);
                return;
            }
            "setparent" => {
                let name = param.split(',').next().unwrap_or("").trim().to_string();
                self.set_parent(i, &name);
                self.relink(i);
                return;
            }
            "clearparent" => {
                self.set_parent(i, "");
                return;
            }
            "use" => {
                // CBaseEntity::InputUse -> Use(activator, caller, USE_TOGGLE).
                self.use_entity(i, usable::UseType::Toggle, activator);
                return;
            }
            _ => {}
        }
        // func_water_analog moves on its inputs only from physics v4 (before, it was inert: nothing moved it).
        let inert_water = self.ents[i].class == "func_water_analog" && self.settings.physics_fixes() & PHYSICS_FIX_WATER_ANALOG == 0;
        if matches!(self.ents[i].data, Data::Kin(_)) && !inert_water && self.kin_input(i, input, param, activator) {
            return;
        }
        if let Data::MotorRef(attached) = self.ents[i].data {
            if matches!(self.ents[attached].data, Data::Kin(_)) {
                self.motor_input(attached, input, param);
            }
            return;
        }
        if let Data::PathTrack(p) = &mut self.ents[i].data {
            const DISABLED: i64 = 0x1;
            const ALTERNATE: i64 = 0x8000;
            let has_alt = p.alt.is_some();
            match input {
                "enablepath" => p.spawnflags &= !DISABLED,
                "disablepath" => p.spawnflags |= DISABLED,
                "togglepath" => p.spawnflags ^= DISABLED,
                "enablealternatepath" if has_alt => p.spawnflags |= ALTERNATE,
                "disablealternatepath" if has_alt => p.spawnflags &= !ALTERNATE,
                "togglealternatepath" if has_alt => p.spawnflags ^= ALTERNATE,
                "inpass" => self.fire_output(i, "onpass", activator),
                "inteleport" => self.fire_output(i, "onteleport", activator),
                _ => {}
            }
            return;
        }
        if let Data::Conveyor { speed, .. } = &mut self.ents[i].data {
            match input {
                "toggledirection" => *speed = -*speed,
                "setspeed" => *speed = param.trim().parse::<f32>().unwrap_or(0.0),
                _ => {}
            }
            return;
        }
        if let Data::PointTeleport { target } = &self.ents[i].data {
            if input == "teleport" {
                let (origin, angles) = (self.ents[i].origin, self.ents[i].angles);
                let target = target.clone();
                for t in self.resolve_targets(&target, activator, Actor::Entity(i)) {
                    if t == Actor::Player {
                        self.state.position = origin;
                        self.state.ground = None;
                        self.teleport_angles = angles;
                        self.events |= EVENT_TELEPORTED;
                        self.unstick();
                    }
                }
            }
            return;
        }
        if matches!(self.ents[i].data, Data::Prop) {
            match input {
                "disablecollision" => self.ents[i].solid = false,
                "enablecollision" => self.ents[i].solid = !self.ents[i].class.starts_with("prop_physics_multiplayer"),
                // CBreakableProp::InputBreak: the prop is gone.
                "break" => self.ents[i].removed = true,
                _ => {}
            }
            return;
        }
        let class = self.ents[i].class.clone();
        if class == "player_speedmod" && input == "modifyspeed" {
            if activator == Actor::Player {
                self.set_speed_scale(param);
            }
            return;
        }
        if matches!(self.ents[i].data, Data::Mover(_)) {
            match input {
                "lock" => self.mover_mut(i).locked = true,
                "unlock" => self.mover_mut(i).locked = false,
                "setspeed" => self.mover_mut(i).speed = param.trim().parse::<f32>().unwrap_or(100.0).max(0.0),
                "open" | "press" | "pressin" => {
                    let m = self.mover_mut(i);
                    if !m.locked && matches!(m.phase, MoverPhase::Closed | MoverPhase::Closing) {
                        self.mover_go_up(i, activator);
                    }
                }
                "close" | "pressout" => {
                    if self.mover_mut(i).phase != MoverPhase::Closed {
                        self.mover_go_down(i, activator);
                    }
                }
                "toggle" => {
                    let m = self.mover_mut(i);
                    if !m.locked {
                        match m.phase {
                            MoverPhase::Closed => self.mover_go_up(i, activator),
                            MoverPhase::Open { .. } => self.mover_go_down(i, activator),
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
            return;
        }
        let mut fire: Vec<&str> = Vec::new();
        let mut remove = false;
        let tick_interval = self.settings.tick_interval;
        let tick = self.tick;
        match &mut self.ents[i].data {
            Data::Trigger(t) => match input {
                "enable" => t.enabled = true,
                "disable" | "disableandendtouch" => t.enabled = false,
                "toggle" => t.enabled = !t.enabled,
                _ => {}
            },
            Data::Mover(_) => {}
            Data::Counter { value, min, max, enabled } => {
                let old = *value;
                let amount = param.trim().parse::<f32>().unwrap_or(0.0);
                match input {
                    "add" if *enabled => *value += amount,
                    "subtract" if *enabled => *value -= amount,
                    "setvalue" | "setvaluenofire" if *enabled => *value = amount,
                    "enable" => *enabled = true,
                    "disable" => *enabled = false,
                    _ => {}
                }
                if *max != 0.0 || *min != 0.0 {
                    // Source's clamp macro (CMathCounter::UpdateOutValue): below min -> min, else above max -> max. Unlike
                    // f32::clamp it takes min > max without panicking: kz_bhop_essence's lj_counter_1 has "min" 5 and no
                    // max (its twin lj_counter_2 has "max" 5), and every long-jump attempt adds to it; f32::clamp aborted
                    // the WASM core there (the game froze, 0 runs on the map until 0.0.16). Same result whenever min <= max.
                    let v = *value;
                    *value = if v < *min { *min } else if v > *max { *max } else { v };
                    if *value >= *max && old < *max && input != "setvaluenofire" {
                        fire.push("onhitmax");
                    }
                    if *value <= *min && old > *min && input != "setvaluenofire" {
                        fire.push("onhitmin");
                    }
                }
            }
            Data::Compare { value, compare } => {
                let amount = param.trim().parse::<f32>().unwrap_or(0.0);
                let run = match input {
                    "setvalue" => {
                        *value = amount;
                        false
                    }
                    "setvaluecompare" => {
                        *value = amount;
                        true
                    }
                    "setcomparevalue" => {
                        *compare = amount;
                        false
                    }
                    "compare" => true,
                    _ => false,
                };
                if run {
                    // CLogicCompare::CompareValues.
                    fire.push(if *value == *compare { "onequalto" } else { "onnotequalto" });
                    if *value < *compare {
                        fire.push("onlessthan");
                    } else if *value > *compare {
                        fire.push("ongreaterthan");
                    }
                }
            }
            Data::Relay { enabled, once } => match input {
                "enable" => *enabled = true,
                "disable" => *enabled = false,
                "toggle" => *enabled = !*enabled,
                "trigger" if *enabled => {
                    fire.push("ontrigger");
                    remove = *once;
                }
                _ => {}
            },
            Data::Timer { enabled, refire, next_tick } => match input {
                "enable" => {
                    *enabled = true;
                    *next_tick = u32::MAX;
                }
                "disable" => *enabled = false,
                "toggle" => {
                    *enabled = !*enabled;
                    *next_tick = u32::MAX;
                }
                "fire" => fire.push("ontimer"),
                "refiretime" => {
                    *refire = param.trim().parse::<f32>().unwrap_or(1.0).max(tick_interval);
                    *next_tick = u32::MAX;
                }
                _ => {}
            },
            Data::Static
            | Data::Other
            | Data::Filter { .. }
            | Data::Auto { .. }
            | Data::PointTeleport { .. }
            | Data::Prop
            | Data::Kin(_)
            | Data::PathTrack(_)
            | Data::MotorRef(_)
            | Data::Conveyor { .. } => {}
        }
        let _ = tick;
        if remove {
            self.ents[i].removed = true;
        }
        for event in fire {
            self.fire_output(i, event, activator);
        }
        // Visibility / solidity toggles for brush entities.
        let e = &mut self.ents[i];
        match (class.as_str(), input) {
            ("func_brush", "enable" | "turnon") => {
                e.visible = true;
                e.solid = e.solidity != 1;
            }
            ("func_brush", "disable" | "turnoff") => {
                e.visible = false;
                e.solid = e.solidity == 2;
            }
            ("func_brush", "toggle") => {
                e.visible = !e.visible;
                e.solid = if e.visible { e.solidity != 1 } else { e.solidity == 2 };
            }
            ("func_wall_toggle", "turnon") => (e.visible, e.solid) = (true, true),
            ("func_wall_toggle", "turnoff") => (e.visible, e.solid) = (false, false),
            ("func_wall_toggle", "toggle") => (e.visible, e.solid) = (!e.visible, !e.visible),
            ("func_breakable" | "func_physbox", "break") | ("func_breakable_surf", "shatter" | "break") => {
                // v5: CBreakable::InputBreak -> Break fires OnBreak (e.g. bhop_hive's respawning fake floor).
                let fire = !e.removed && class == "func_breakable" && self.settings.physics_fixes() & PHYSICS_FIX_GAME_ENTITIES != 0;
                e.removed = true;
                if fire {
                    self.fire_output(i, "onbreak", activator);
                }
            }
            _ => {}
        }
    }

    fn mover_mut(&mut self, i: usize) -> &mut Mover {
        match &mut self.ents[i].data {
            Data::Mover(m) => m,
            _ => unreachable!("not a mover"),
        }
    }

    fn mover_go_up(&mut self, i: usize, activator: Actor) {
        let start = self.tick + u32::from(self.in_touch || self.in_use || self.in_attack);
        let button = {
            let m = self.mover_mut(i);
            m.phase = MoverPhase::Opening;
            m.start_tick = start;
            m.button
        };
        self.fire_output(i, if button { "onpressed" } else { "onopen" }, activator);
        // Zero-length travel reaches the end this tick.
        if self.mover_mut(i).distance <= 0.0 {
            self.mover_reached_top(i);
        }
    }

    fn mover_go_down(&mut self, i: usize, activator: Actor) {
        let start = self.tick + u32::from(self.in_touch || self.in_use || self.in_attack);
        let button = {
            let m = self.mover_mut(i);
            m.phase = MoverPhase::Closing;
            m.start_tick = start;
            m.button
        };
        if !button {
            self.fire_output(i, "onclose", activator);
        }
        if self.mover_mut(i).offset <= 0.0 {
            self.mover_reached_bottom(i);
        }
    }

    fn mover_reached_top(&mut self, i: usize) {
        let tick = self.tick;
        let dt = self.settings.tick_interval;
        let m = self.mover_mut(i);
        m.offset = m.distance;
        let stays = m.wait < 0.0 || m.no_auto_return;
        let wait_ticks = (m.wait.max(0.0) / dt).round() as u32;
        m.phase = MoverPhase::Open { until_tick: if stays { u32::MAX } else { tick + wait_ticks } };
        let button = m.button;
        self.fire_output(i, if button { "onin" } else { "onfullyopen" }, Actor::Player);
    }

    fn mover_reached_bottom(&mut self, i: usize) {
        let m = self.mover_mut(i);
        m.offset = 0.0;
        m.phase = MoverPhase::Closed;
        let button = m.button;
        self.fire_output(i, if button { "onout" } else { "onfullyclosed" }, Actor::Player);
    }

    fn advance_movers(&mut self) {
        let dt = self.settings.tick_interval;
        let support = self
            .state
            .ground
            .and_then(|g| g.support)
            .and_then(hit_entity);
        for k in 0..self.movers.len() {
            let i = self.movers[k];
            let Data::Mover(m) = &self.ents[i].data else { continue };
            if self.ents[i].removed {
                continue;
            }
            let (before, phase) = (m.offset, m.phase);
            if matches!(phase, MoverPhase::Opening | MoverPhase::Closing) && self.tick < m.start_tick {
                continue;
            }
            match phase {
                MoverPhase::Closed => continue,
                MoverPhase::Opening => {
                    let m = self.mover_mut(i);
                    m.offset = (m.offset + m.speed * dt).min(m.distance);
                    if m.offset >= m.distance {
                        self.mover_reached_top(i);
                    }
                }
                MoverPhase::Open { until_tick } => {
                    if self.tick >= until_tick {
                        self.mover_go_down(i, Actor::None);
                    }
                }
                MoverPhase::Closing => {
                    let m = self.mover_mut(i);
                    m.offset = (m.offset - m.speed * dt).max(0.0);
                    if m.offset <= 0.0 {
                        self.mover_reached_bottom(i);
                    }
                }
            }
            let (dir, offset) = match &self.ents[i].data {
                Data::Mover(m) => (m.dir, m.offset),
                _ => unreachable!(),
            };
            let Some(b) = self.ents[i].brush.as_mut() else { continue };
            let old_origin = b.origin;
            for k in 0..3 {
                b.origin[k] = b.base_origin[k] + dir[k] * offset;
            }
            let delta = [b.origin[0] - old_origin[0], b.origin[1] - old_origin[1], b.origin[2] - old_origin[2]];
            let new_origin = b.origin;
            if offset != before && delta != [0.0; 3] {
                self.ents[i].origin = new_origin;
                self.ents[i].local_origin = new_origin;
                for k in 0..self.ents[i].children.len() {
                    let c = self.ents[i].children[k];
                    self.relink(c);
                }
                self.carry_player(i, delta, support == Some(i));
            }
        }
    }

    /// SV_PushMove-style: a mover carries the player standing on it and pushes a player it moves into.
    fn carry_player(&mut self, mover: usize, delta: [f32; 3], riding: bool) {
        let hull = self.current_hull();
        let position = self.state.position;
        let pushed = !riding
            && self.ents[mover].solid
            && self.ents[mover]
                .brush
                .as_ref()
                .is_some_and(|b| {
                    let inset = if self.ents[mover].vphysics { VPHYSICS_INSET } else { 0.0 };
                    let request = ObjectTraceRequest {
                        identity: 0,
                        transform: Transform { origin: b.origin, angles: b.angles },
                        start: position,
                        end: position,
                        hull,
                        mask: u32::MAX,
                    };
                    self.world.trace_brush_model_inset(b.model, request, inset).is_ok_and(|t| t.start_solid)
                });
        if !riding && !pushed {
            return;
        }
        self.rebuild_solid();
        let scene = self.scene(0.0);
        let end = [position[0] + delta[0], position[1] + delta[1], position[2] + delta[2]];
        let mut moved = false;
        if let Ok(t) = scene.trace_filtered(position, end, hull, self.config.solid_mask, &[mover]) {
            if !t.all_solid {
                moved = t.end != position;
                self.state.position = t.end;
            }
        }
        if moved {
            // The pusher's SetAbsOrigin on the player touches triggers at once (on the server clock): a sinking bhop
            // block hands the rider to the trigger_teleport below before its next command (tools/parity, eazy).
            self.touch_triggers();
        }
    }

    // ---------------------------------------------------------------- touching

    fn touch_solids(&mut self, contacts: &[u64]) {
        let support = self
            .state
            .ground
            .and_then(|g| g.support)
            .and_then(hit_entity);
        let mut touched: Vec<usize> =
            contacts.iter().filter_map(|h| hit_entity(*h)).collect();
        touched.extend(support);
        touched.sort_unstable();
        touched.dedup();

        // Bhop-block fix bookkeeping for every managed block.
        let grace = (self.rules.bhop_block_grace / self.settings.tick_interval).round().max(1.0) as u32;
        let mut expired = Vec::new();
        for &i in &self.movers {
            if let Data::Mover(Mover { bhop: Some(b), phase, .. }) = &mut self.ents[i].data {
                if support == Some(i) && *phase == MoverPhase::Closed {
                    b.standing_ticks += 1;
                    if b.standing_ticks >= grace {
                        b.standing_ticks = 0;
                        expired.push((i, b.teleport));
                    }
                } else {
                    b.standing_ticks = 0;
                }
            }
        }
        for (block, teleport) in expired {
            match teleport {
                Some(trigger) => {
                    self.teleport_through(trigger);
                }
                None => self.mover_go_up(block, Actor::Player),
            }
        }

        for &i in &touched {
            if self.ents[i].removed {
                continue;
            }
            if let Data::Kin(k) = &self.ents[i].data {
                match &k.kind {
                    kin::KinKind::RotDoor(_) => self.door_touch(i),
                    kin::KinKind::Rotating(r) if r.hurt => self.rotating_hurt_touch(i),
                    kin::KinKind::RotButton(_) => self.rot_button_touch(i),
                    _ => {}
                }
            }
        }
        // v5: CBreakable::BreakTouch (func_breakable break on touch / pressure).
        if self.settings.physics_fixes() & PHYSICS_FIX_GAME_ENTITIES != 0 {
            for &i in &touched {
                self.breakable_touch(i, support == Some(i));
            }
        }
        for i in touched {
            let Data::Mover(m) = &self.ents[i].data else { continue };
            if self.ents[i].removed
                || !m.touch_activates
                || m.bhop.is_some()
                || m.locked
                || m.phase != MoverPhase::Closed
            {
                continue;
            }
            if m.button {
                self.note_button_activator(i);
            }
            self.mover_go_up(i, Actor::Player);
        }
    }

    fn passes_filter(&self, filter: Option<&str>, depth: u32) -> bool {
        self.passes_filter_as(filter, &self.player_name, &self.player_class, depth)
    }

    /// `passes_filter` for an entity with targetname `name` and classname `class` (the player, or a TestActivator
    /// activator).
    fn passes_filter_as(&self, filter: Option<&str>, name: &str, class: &str, depth: u32) -> bool {
        let Some(filter) = filter else { return true };
        if depth > 8 {
            return true;
        }
        let Some(f) = self
            .ents
            .iter()
            .position(|e| !e.removed && matches!(e.data, Data::Filter { .. }) && name_matches(filter, &e.name))
        else {
            return true; // unresolved filter: m_hFilter is NULL, so everything passes
        };
        self.filter_entity_passes(f, name, class, depth)
    }

    /// CBaseFilter::PassesFilter of filter entity `f` for an entity named `name` of class `class`.
    fn filter_entity_passes(&self, f: usize, name: &str, class: &str, depth: u32) -> bool {
        let Data::Filter { kind, negated } = &self.ents[f].data else { return true };
        let pass = match kind {
            FilterKind::Name(n) => name_matches(n, name),
            FilterKind::Class(c) => name_matches(c, class),
            FilterKind::Multi { all, filters } => {
                let mut results = filters.iter().map(|n| self.passes_filter_as(Some(n), name, class, depth + 1));
                if *all { results.all(|r| r) } else { results.any(|r| r) }
            }
            FilterKind::PassAll | FilterKind::DamageType { .. } => true,
        };
        pass != *negated
    }

    /// `CBaseEntity::PassesDamageFilter` for the player's weapon damage of type `damage_type` on entity `i` (v9): its
    /// `damagefilter` (resolved by name; unresolved passes), `CBaseFilter::PassesDamageFilter` with the attacker as
    /// the entity tested (filter_multi asks each member's damage filter).
    fn passes_damage_filter(&self, i: usize, damage_type: i64) -> bool {
        let filter = self.entities[i].get("damagefilter").filter(|s| !s.is_empty());
        self.damage_filter_passes(filter, damage_type, 0)
    }

    fn damage_filter_passes(&self, filter: Option<&str>, damage_type: i64, depth: u32) -> bool {
        let Some(name) = filter else { return true };
        if depth > 8 {
            return true;
        }
        let Some(f) = self
            .ents
            .iter()
            .find(|e| !e.removed && matches!(e.data, Data::Filter { .. }) && name_matches(name, &e.name))
        else {
            return true;
        };
        let Data::Filter { kind, negated } = &f.data else { unreachable!() };
        let pass = match kind {
            FilterKind::Name(n) => name_matches(n, &self.player_name),
            FilterKind::Class(c) => name_matches(c, &self.player_class),
            FilterKind::Multi { all, filters } => {
                let mut results = filters.iter().map(|n| self.damage_filter_passes(Some(n), damage_type, depth + 1));
                if *all { results.all(|r| r) } else { results.any(|r| r) }
            }
            FilterKind::PassAll => true,
            FilterKind::DamageType { damage_type: want, negated } => return (damage_type == *want) != *negated,
        };
        pass != *negated
    }

    fn trigger_passes(&self, t: &Trigger) -> bool {
        // SF_TRIGGER_ALLOW_CLIENTS (1) / ALLOW_ALL (64) / ONLY_CLIENTS_OUT_OF_VEHICLES (512);
        // ONLY_CLIENTS_IN_VEHICLES (32) never matches a walking player.
        let flags_ok = t.spawnflags & (1 | 64 | 512) != 0 && t.spawnflags & 32 == 0;
        flags_ok && self.passes_filter(t.filter.as_deref(), 0)
    }

    /// Records where the touch pass after the player's move happens (`touch_origin`).
    fn note_touch_origin(&mut self) {
        self.touch_origin = self.state.position;
        self.touch_crouched = self.state.crouch.uses_crouched_hull();
    }

    /// PhysicsTouchTriggers after the player's move (CMoveHelperServer::ProcessImpacts).
    fn touch_triggers(&mut self) {
        self.touch_triggers_at();
    }

    /// One PhysicsTouchTriggers at the player's current position, as the engine does it (verified with
    /// tools/parity): the list of overlapping triggers is collected first and every one of them is touched, even
    /// if an earlier touch teleported the player away. The destination's triggers are only touched after the next
    /// move (arcane's chained stop-box teleports take one tick per hop). Links are touch-stamped; EndTouch for links
    /// that were not refreshed happens at the end of the frame (`untouch_triggers`). Returns true if the player
    /// died.
    fn touch_triggers_at(&mut self) -> bool {
        let hull = self.current_hull();
        let position = self.state.position;
        let map_boxes: &[(usize, physics::ConvexBrush)] =
            if self.settings.physics_fixes() & PHYSICS_FIX_MAP_TRIGGERS != 0 { &self.map_trigger_boxes } else { &[] };
        let mut list = Vec::new();
        for k in 0..self.triggers.len() {
            let i = self.triggers[k];
            let Data::Trigger(t) = &self.ents[i].data else { continue };
            let e = &self.ents[i];
            // v8 per-map fix: the box replaces the brush (`game/map_fixes.rs`).
            let map_box = map_boxes.iter().find(|(j, _)| *j == i).map(|(_, b)| b);
            let overlapping = !e.removed
                && t.enabled
                && match map_box {
                    Some(b) => {
                        swept_overlap(position, position, hull, b.mins, b.maxs)
                            && physics::clip_box_to_brush(b, position, position, hull).is_some_and(|t| t.start_solid)
                    }
                    None => e.brush.as_ref().is_some_and(|b| {
                        let (lo, hi) = b.world_bounds();
                        swept_overlap(position, position, hull, lo, hi)
                            && self
                                .world
                                .overlaps_transformed_model_hull(
                                    b.model,
                                    Transform { origin: b.origin, angles: b.angles },
                                    position,
                                    hull,
                                )
                                .unwrap_or(false)
                    }),
                };
            if overlapping {
                list.push(i);
            }
        }
        for i in list {
            let Data::Trigger(t) = &self.ents[i].data else { continue };
            if self.ents[i].removed || !t.enabled {
                continue;
            }
            let linked = t.linked;
            // CTriggerGravity replaces Touch with GravityTouch, which only checks IsPlayer().
            let passes = matches!(t.kind, TriggerKind::Gravity { .. }) || self.trigger_passes(t);
            let tick = self.tick;
            self.trigger_mut(i).touch_tick = tick;
            if !linked {
                self.trigger_mut(i).linked = true;
                if passes {
                    self.trigger_mut(i).touching = true;
                    if let TriggerKind::PlayerMovement { auto_duck, no_auto_movement } = self.trigger_mut(i).kind {
                        self.forced_duck |= auto_duck;
                        self.auto_movement_disabled |= no_auto_movement;
                    }
                    self.fire_output(i, "onstarttouch", Actor::Player);
                    // v16 NONLINEAR_OBJECTIVES maps: the script's ConnectOutput("OnStartTouch", ...) action.
                    if !self.script_triggers.is_empty() {
                        self.script_start_touch(i);
                    }
                    self.fire_output(i, "onstarttouchall", Actor::Player);
                }
            }
            if !passes {
                continue;
            }
            // Touch()
            let kind = match &self.ents[i].data {
                Data::Trigger(t) => t.kind.clone(),
                _ => unreachable!(),
            };
            match kind {
                TriggerKind::Multiple { wait, next_tick } => {
                    if self.tick < next_tick {
                        continue;
                    }
                    self.fire_output(i, "ontrigger", Actor::Player);
                    if wait > 0.0 {
                        let due = self.tick + self.delay_ticks(wait).max(1);
                        if let TriggerKind::Multiple { next_tick, .. } = &mut self.trigger_mut(i).kind {
                            *next_tick = due;
                        }
                    } else {
                        // trigger_once (or wait < 0): removed after firing.
                        self.ents[i].removed = true;
                    }
                }
                TriggerKind::Teleport { .. } => {
                    self.teleport_through(i);
                }
                TriggerKind::Push { dir, speed, once } => {
                    // CTriggerPush stores pushdir in entity space and rotates it back by the
                    // same transform on Touch, so the push is along the world-space pushdir.
                    let push = dir.map(|d| d * speed);
                    if once {
                        for k in 0..3 {
                            self.state.velocity[k] += push[k];
                        }
                        if push[2] > 0.0 {
                            self.state.ground = None;
                        }
                        self.ents[i].removed = true;
                        continue;
                    }
                    // FL_BASEVELOCITY already set this frame (by another pusher): accumulate.
                    let mut v = push;
                    if self.state.base_velocity_applied {
                        for k in 0..3 {
                            v[k] += self.state.base_velocity[k];
                        }
                    }
                    if v[2] > 0.0 && self.state.ground.is_some() {
                        self.state.ground = None;
                        self.state.position[2] += 1.0;
                    }
                    // Picked up by the next movement step (prepare_base_velocity keeps it while flagged).
                    self.state.base_velocity = v;
                    self.state.base_velocity_applied = true;
                }
                TriggerKind::Gravity { gravity } => {
                    // SetGravity; 0 means "default" for the player (StartGravity: g ? g : 1).
                    self.gravity_scale = if gravity == 0.0 || !gravity.is_finite() { 1.0 } else { gravity };
                }
                TriggerKind::PlayerMovement { .. } => {}
                TriggerKind::Hurt { damage, next_tick } => {
                    if self.tick < next_tick {
                        continue;
                    }
                    let due = self.tick + self.delay_ticks(0.5).max(1);
                    if let TriggerKind::Hurt { next_tick, .. } = &mut self.trigger_mut(i).kind {
                        *next_tick = due;
                    }
                    let amount = damage * 0.5;
                    self.health = (self.health - amount).min(MAX_HEALTH);
                    self.fire_output(i, "onhurtplayer", Actor::Player);
                    if self.health <= 0.0 {
                        self.die();
                        return true;
                    }
                }
            }
        }
        false
    }

    /// End of the server frame (PhysicsCheckForEntityUntouch): trigger links not touched this frame end, on the
    /// server clock.
    fn untouch_triggers(&mut self) {
        let tick = self.tick;
        for k in 0..self.triggers.len() {
            let i = self.triggers[k];
            let Data::Trigger(t) = &self.ents[i].data else { continue };
            if !t.linked || t.touch_tick == tick {
                continue;
            }
            let touching = t.touching;
            let t = self.trigger_mut(i);
            t.linked = false;
            t.touching = false;
            if touching {
                if let TriggerKind::PlayerMovement { auto_duck, no_auto_movement } = self.trigger_mut(i).kind {
                    self.forced_duck &= !auto_duck;
                    self.auto_movement_disabled &= !no_auto_movement;
                }
                self.fire_output(i, "onendtouch", Actor::Player);
                self.fire_output(i, "onendtouchall", Actor::Player);
            }
        }
    }

    fn trigger_mut(&mut self, i: usize) -> &mut Trigger {
        match &mut self.ents[i].data {
            Data::Trigger(t) => t,
            _ => unreachable!("not a trigger"),
        }
    }

    fn find_named(&self, name: &str) -> Option<usize> {
        self.ents.iter().position(|e| !e.removed && name_matches(name, &e.name))
    }

    /// CTriggerTeleport::Touch body (filters already checked). Returns true if the player moved.
    fn teleport_through(&mut self, trigger: usize) -> bool {
        let Data::Trigger(Trigger { kind: TriggerKind::Teleport { target, landmark }, spawnflags, .. }) =
            &self.ents[trigger].data
        else {
            return false;
        };
        let preserve_angles = spawnflags & 32 != 0;
        let Some(dest) = self.find_named(target) else { return false };
        if std::env::var_os("PARITY_DEBUG").is_some() {
            eprintln!("tick {} teleport via {trigger} ({}) to {target} at {:?} from {:?}", self.tick, self.ents[trigger].name, self.ents[dest].origin, self.state.position);
        }
        let landmark = landmark.as_deref().and_then(|l| self.find_named(l));
        let mut origin = self.ents[dest].origin;
        let mut angles = self.last_angles;
        match landmark {
            Some(l) => {
                for k in 0..3 {
                    origin[k] += self.state.position[k] - self.ents[l].origin[k];
                }
            }
            None => {
                if !preserve_angles {
                    angles = self.ents[dest].angles;
                }
                if !self.rules.teleport_keeps_velocity {
                    self.state.velocity = [0.0; 3];
                }
            }
        }
        self.state.position = origin;
        self.state.ground = None;
        self.teleport_angles = angles;
        self.events |= EVENT_TELEPORTED;
        self.unstick();
        true
    }

    /// Gives every moving prop (prop_door_rotating) its collision from `props.dynamic` at its current transform.
    fn attach_dynamic_props(&mut self) {
        for e in &mut self.ents {
            e.prop = None;
        }
        for (tag, hulls) in self.props.dynamic.clone() {
            let i = (tag & !physics::ENTITY_PROP) as usize;
            let Some(e) = self.ents.get_mut(i) else { continue };
            e.prop = Some(Box::new(DynProp::new(hulls, e.origin, e.angles, tag)));
            self.prop_door_collision_ready(i);
        }
    }

    /// CBaseEntity::SetParent for every `parentname` (Activate): the child keeps its abs transform
    /// and stores it relative to the parent.
    fn link_hierarchy(&mut self) {
        for i in 0..self.entities.len() {
            let Some(name) = self.entities[i].get("parentname").map(|p| p.split(',').next().unwrap_or("").trim().to_string()) else {
                continue;
            };
            if name.is_empty() {
                continue;
            }
            self.set_parent(i, &name);
        }
    }

    fn set_parent(&mut self, i: usize, name: &str) {
        if let Some(old) = self.ents[i].parent.take() {
            self.ents[old].children.retain(|&c| c != i);
            self.ents[i].local_origin = self.ents[i].origin;
            self.ents[i].local_angles = self.ents[i].angles;
        }
        let Some(p) = self.find_named(name).filter(|&p| p != i) else { return };
        // No cycles.
        let mut a = Some(p);
        while let Some(x) = a {
            if x == i {
                return;
            }
            a = self.ents[x].parent;
        }
        let abs = Transform { origin: self.ents[i].origin, angles: self.ents[i].angles };
        let parent = Transform { origin: self.ents[p].origin, angles: self.ents[p].angles };
        let Ok(local) = abs.relative_to(parent) else { return };
        self.ents[i].parent = Some(p);
        self.ents[i].local_origin = local.origin;
        self.ents[i].local_angles = local.angles;
        self.ents[p].children.push(i);
    }

    /// Attach the bhop-block fix to sinking touch blocks and find the teleport below each one.
    fn link_bhop_blocks(&mut self) {
        let teleports: Vec<(usize, [f32; 3], [f32; 3])> = self
            .ents
            .iter()
            .enumerate()
            .filter_map(|(i, e)| match &e.data {
                Data::Trigger(Trigger { kind: TriggerKind::Teleport { target, .. }, .. })
                    if self.ents.iter().any(|d| name_matches(target, &d.name)) =>
                {
                    let (lo, hi) = e.brush.as_ref()?.world_bounds();
                    Some((i, lo, hi))
                }
                _ => None,
            })
            .collect();
        let fix = self.rules.bhop_blocks == BhopBlockMode::Fix;
        for i in 0..self.ents.len() {
            let candidate = {
                let e = &self.ents[i];
                match &e.data {
                    Data::Mover(m) => {
                        fix && m.touch_activates
                            && m.dir[2] < -0.7
                            && m.distance > 0.0
                            && e.outputs.is_empty()
                            && e.name.is_empty()
                    }
                    _ => false,
                }
            };
            let bounds = self.ents[i].brush.as_ref().map(|b| b.world_bounds());
            let Data::Mover(m) = &mut self.ents[i].data else { continue };
            if !candidate {
                m.bhop = None;
                continue;
            }
            let (lo, hi) = bounds.expect("movers have brushes");
            let below = teleports
                .iter()
                .filter(|(_, tlo, thi)| {
                    tlo[0] < hi[0] + 16.0
                        && thi[0] > lo[0] - 16.0
                        && tlo[1] < hi[1] + 16.0
                        && thi[1] > lo[1] - 16.0
                        && thi[2] <= hi[2] + 1.0
                        && thi[2] > lo[2] - 1024.0
                })
                .max_by(|a, b| a.2[2].total_cmp(&b.2[2]))
                .map(|(t, _, _)| *t);
            m.bhop = Some(BhopBlock { standing_ticks: 0, teleport: below });
        }
    }

    // ---------------------------------------------------------------- queries

    /// Current origin of every brush entity model, as (model, origin).
    pub fn brush_origins(&self) -> Vec<(u32, [f32; 3])> {
        self.ents.iter().filter_map(|e| e.brush.as_ref().map(|b| (b.model as u32, b.origin))).collect()
    }

    /// Abs transform of entity `index` (origin, angles), e.g. a moving brush entity.
    pub fn entity_transform(&self, index: usize) -> Option<([f32; 3], [f32; 3])> {
        let e = self.ents.get(index)?;
        Some((e.origin, e.angles))
    }

    /// Whether entity `index` currently collides with the player, and whether it is a SOLID_VPHYSICS
    /// (vs SOLID_BSP) brush entity.
    pub fn entity_solidity(&self, index: usize) -> Option<(bool, bool)> {
        let e = self.ents.get(index)?;
        Some((e.solid && !e.removed, e.brush.as_ref().is_some_and(|b| b.vphysics)))
    }

    /// Current transform of every brush entity model, as (model, origin, angles).
    pub fn brush_transforms(&self) -> Vec<(u32, [f32; 3], [f32; 3])> {
        self.ents.iter().filter_map(|e| e.brush.as_ref().map(|b| (b.model as u32, b.origin, b.angles))).collect()
    }

    /// The per-map fix this map matched (`game/map_fixes.rs`), whatever the physics version.
    pub fn map_fix(&self) -> Option<&'static str> {
        self.map_fix
    }

    /// The sv_maxvelocity in effect: the map's own from physics v14 (`map_fixes::MAX_VELOCITY`), else 3500.
    pub fn max_velocity(&self) -> f32 {
        self.config.maximum_velocity
    }

    /// The triggers that fix replaces (entity index, box mins, box maxs); the boxes count from physics v8.
    pub fn map_trigger_boxes(&self) -> Vec<(usize, [f32; 3], [f32; 3])> {
        self.map_trigger_boxes.iter().map(|(i, b)| (*i, b.mins, b.maxs)).collect()
    }

    /// (model, visible, solid) for every brush entity model.
    pub fn brush_states(&self) -> Vec<(u32, bool, bool)> {
        self.ents
            .iter()
            .filter_map(|e| e.brush.as_ref().map(|b| (b.model as u32, e.visible && !e.removed, e.solid && !e.removed)))
            .collect()
    }

    /// Sweep the player's current hull through the full collision scene (world, displacements,
    /// static props, solid brush entities) with MASK_PLAYERSOLID.
    pub fn trace_player_hull(&self, start: [f32; 3], end: [f32; 3]) -> Trace {
        self.scene(0.0)
            .trace_filtered(start, end, self.current_hull(), self.config.solid_mask, &[])
            .unwrap_or(Trace { fraction: 0.0, start_solid: true, all_solid: true, end: start, normal: None, hit: None, contents: 0 })
    }

    /// Sweep an arbitrary box through the full collision scene with `mask` (tools: the parity trace oracle).
    pub fn trace_hull(&self, start: [f32; 3], end: [f32; 3], hull: Hull, mask: u32) -> Trace {
        self.scene(0.0)
            .trace_filtered(start, end, hull, mask, &[])
            .unwrap_or(Trace { fraction: 0.0, start_solid: true, all_solid: true, end: start, normal: None, hit: None, contents: 0 })
    }

    /// The collision world (tools / diagnostics).
    pub fn collision_world(&self) -> &CollisionWorld {
        &self.world
    }

    /// Whether a trace hit identity is a brush entity (as opposed to the world, a displacement or a static prop).
    pub fn hit_is_entity(hit: u64) -> bool {
        hit_entity(hit).is_some()
    }

    /// trigger_playermovement effects currently on the player: (forced duck, auto movement off).
    pub fn movement_overrides(&self) -> (bool, bool) {
        (self.forced_duck, self.auto_movement_disabled)
    }

    /// World-space bounds of entity `index`'s brush model (triggers, func_*), if it has one.
    pub fn entity_bounds(&self, index: usize) -> Option<([f32; 3], [f32; 3])> {
        self.ents.get(index)?.brush.as_ref().map(|b| b.world_bounds())
    }

    /// Send `input(param)` to every entity named `target` right now, with the player as activator
    /// (tools/tests; maps do this through their own outputs).
    pub fn fire_input(&mut self, target: &str, input: &str, param: &str) {
        for t in self.resolve_targets(target, Actor::Player, Actor::None) {
            self.accept_input(t, input, param, Actor::Player, Actor::None);
        }
    }

    /// Most common pending events as (count, "target.input(param)") (diagnostics).
    pub fn queue_histogram(&self) -> Vec<(usize, String)> {
        let mut h: std::collections::BTreeMap<String, usize> = Default::default();
        for e in &self.queue {
            *h.entry(format!("{}.{}({}) caller {:?}", e.target, e.input, e.param, e.caller)).or_default() += 1;
        }
        let mut v: Vec<(usize, String)> = h.into_iter().map(|(k, n)| (n, k)).collect();
        v.sort_by(|a, b| b.0.cmp(&a.0));
        v.truncate(8);
        v
    }

    /// Pending entity I/O events (diagnostics).
    pub fn queued_events(&self) -> usize {
        self.queue.len()
    }

    /// Collision files (`.phy`, or `.mdl` for bbox props) every prop needs, deduplicated and sorted:
    /// what the hosted content and the verifier's physics BSP must provide (tools/content/extract.ts).
    pub fn physics_files(&self) -> Vec<String> {
        let mut v: Vec<String> = self.prop_sources.iter().map(|p| p.collision_file()).collect();
        v.sort();
        v.dedup();
        v
    }

    /// Prop models whose collision file wasn't available when prop collision was built.
    pub fn missing_prop_models(&self) -> &[String] {
        &self.props.missing_models
    }

    /// Rebuilds prop collision with `fs` (the map pakfile followed by stock content), e.g. once hosted
    /// collision models arrived after `load`. Deterministic: same files, same collision. Resets the map.
    pub fn rebuild_props(&mut self, fs: &crate::vfs::Vfs) {
        let mut diagnostics = Vec::new();
        self.props = PropCollision::build_with_mesh(&self.prop_sources, fs, &self.world, &mut diagnostics, self.prop_mesh);
        self.physics_diagnostics.retain(|d| !d.starts_with("prop "));
        self.physics_diagnostics.extend(diagnostics.into_iter().filter(|d| d.starts_with("prop ")));
        self.ents = self.initial_ents.clone();
        self.attach_dynamic_props();
        self.initial_ents = self.ents.clone();
        self.reset();
    }

    /// Solid entity props at their (settled) pose: (entity index, model, origin, angles), for rendering.
    pub fn entity_prop_poses(&self) -> Vec<(usize, String, [f32; 3], [f32; 3])> {
        let mut out = Vec::new();
        for &(tag, origin, angles) in &self.props.poses {
            if tag & physics::ENTITY_PROP == 0 {
                continue;
            }
            let i = (tag & !physics::ENTITY_PROP) as usize;
            if let Some(model) = self.entities.get(i).and_then(|e| e.get("model")) {
                out.push((i, model.replace('\\', "/").to_ascii_lowercase(), origin, angles));
            }
        }
        out
    }

    /// Current transform of every moving entity prop (prop_door_rotating): (entity, origin, angles).
    pub fn moving_prop_transforms(&self) -> Vec<(usize, [f32; 3], [f32; 3])> {
        self.ents
            .iter()
            .enumerate()
            .filter(|(_, e)| matches!(&e.data, Data::Kin(k) if matches!(k.kind, kin::KinKind::PropDoor(_))))
            .map(|(i, e)| (i, e.origin, e.angles))
            .collect()
    }

    /// Entity props to draw with the static props, at their (settled) pose: (model, origin, angles, skin, owner).
    /// prop_dynamic*, prop_physics*, prop_physics_multiplayer, prop_door_rotating; props following a parent
    /// and `rendermode 10` (don't render) / `disableshadows`-only helpers excluded. `owner` is 0, or entity index
    /// + 1 for props that move (drawn at `moving_prop_transforms`).
    pub fn render_props(&self) -> Vec<(String, [f32; 3], [f32; 3], i32, u32)> {
        let poses: std::collections::HashMap<u32, ([f32; 3], [f32; 3])> =
            self.props.poses.iter().map(|&(tag, o, a)| (tag, (o, a))).collect();
        let mut out = Vec::new();
        for (i, e) in self.entities.iter().enumerate() {
            let class = e.classname().to_ascii_lowercase();
            // prop_ragdoll: drawn at its spawn pose (the model's reference pose), without ragdoll physics.
            if !(class.starts_with("prop_dynamic") || class.starts_with("prop_physics") || class == "prop_door_rotating" || class == "prop_ragdoll") {
                continue;
            }
            let Some(model) = e.get("model").filter(|m| m.to_ascii_lowercase().ends_with(".mdl")) else { continue };
            if e.get("parentname").is_some_and(|p| !p.is_empty()) || e.int("rendermode") == 10 {
                continue;
            }
            if self.ents.get(i).is_some_and(|r| !r.visible) {
                continue;
            }
            let (origin, angles) = poses.get(&(physics::ENTITY_PROP | i as u32)).copied().unwrap_or((e.origin(), e.angles()));
            let moving = class == "prop_door_rotating";
            out.push((model.replace('\\', "/").to_ascii_lowercase(), origin, angles, e.int("skin") as i32, if moving { i as u32 + 1 } else { 0 }));
        }
        out
    }

    /// Whether entity `index` (a prop) is currently drawn / solid.
    pub fn entity_visible(&self, index: usize) -> bool {
        self.ents.get(index).is_some_and(|e| e.visible && !e.removed)
    }

    /// Static props that collide (their collision model was available).
    pub fn solid_static_props(&self) -> usize {
        self.props.solid_props
    }

    /// Prop collision hull faces (9 floats per triangle, world space).
    pub fn prop_collision_mesh(&self) -> &[f32] {
        &self.props.mesh
    }

    /// Convex solids built from static-prop collision models.
    pub fn static_prop_solids(&self) -> usize {
        self.props.brushes.len()
    }

    pub fn horizontal_speed(&self) -> f32 {
        (self.state.velocity[0].powi(2) + self.state.velocity[1].powi(2)).sqrt()
    }

    pub fn teleports(&self) -> Vec<TeleportInfo> {
        self.ents
            .iter()
            .enumerate()
            .filter_map(|(i, e)| {
                let Data::Trigger(t) = &e.data else { return None };
                let TriggerKind::Teleport { target, .. } = &t.kind else { return None };
                let (mins, maxs) = e.brush.as_ref()?.world_bounds();
                let filter = t.filter.clone();
                let required_name = filter.as_deref().and_then(|f| {
                    self.ents.iter().find(|x| name_matches(f, &x.name)).and_then(|x| match &x.data {
                        Data::Filter { kind: FilterKind::Name(n), negated: false } => Some(n.clone()),
                        _ => None,
                    })
                });
                Some(TeleportInfo {
                    entity: i,
                    enabled: t.enabled && !e.removed,
                    mins,
                    maxs,
                    target: target.clone(),
                    filter,
                    required_name,
                    destination: self.find_named(target).map(|d| self.ents[d].origin),
                })
            })
            .collect()
    }

    /// Number of touch blocks managed by the bhop-block fix, and how many have a teleport below.
    pub fn bhop_block_stats(&self) -> (usize, usize) {
        let blocks: Vec<&BhopBlock> = self
            .ents
            .iter()
            .filter_map(|e| match &e.data {
                Data::Mover(Mover { bhop: Some(b), .. }) => Some(b),
                _ => None,
            })
            .collect();
        (blocks.len(), blocks.iter().filter(|b| b.teleport.is_some()).count())
    }

    /// Top-centre of each fix-managed bhop block (for tests/tools).
    pub fn bhop_block_tops(&self) -> Vec<[f32; 3]> {
        self.ents
            .iter()
            .filter(|e| matches!(e.data, Data::Mover(Mover { bhop: Some(_), .. })))
            .filter_map(|e| e.brush.as_ref().map(|b| b.world_bounds()))
            .map(|(lo, hi)| [(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5, hi[2]])
            .collect()
    }

    /// Captures the complete mutable simulation state (keyframes for fast replay seeking). Restoring it with
    /// `restore_state` and stepping is bit-identical to never having left that tick.
    pub fn save_state(&self) -> GameState {
        GameState {
            ents: self.ents.clone(),
            queue: self.queue.clone(),
            seq: self.seq,
            state: self.state,
            settings: self.settings,
            rules: self.rules,
            config: self.config,
            policy: self.policy,
            spawn_origin: self.spawn_origin,
            spawn_angles: self.spawn_angles,
            tick: self.tick,
            events: self.events,
            teleport_angles: self.teleport_angles,
            player_name: self.player_name.clone(),
            player_class: self.player_class.clone(),
            health: self.health,
            gravity_scale: self.gravity_scale,
            speed_scale: self.speed_scale,
            last_angles: self.last_angles,
            restart_point: self.restart_point,
            restart_names: self.restart_names.clone(),
            touch_origin: self.touch_origin,
            touch_crouched: self.touch_crouched,
            last_move_origin: self.last_move_origin,
            movement_errors: self.movement_errors,
            last_movement_error: self.last_movement_error.clone(),
            forced_duck: self.forced_duck,
            auto_movement_disabled: self.auto_movement_disabled,
            view_angle_change: self.view_angle_change,
            last_buttons: self.last_buttons,
            arms: self.arms.clone(),
            extra: self.extra.clone(),
        }
    }

    /// The player's weapons (WEAPON_* bits held) and the active one (a WEAPON_* bit, 0 = none). Physics v4 maps can
    /// change them (game_player_equip / player_weaponstrip); otherwise the knife.
    pub fn weapons(&self) -> (u8, u8) {
        self.arms.legacy()
    }

    /// Restores a `save_state` capture (taken on this map, with the same rules). Derived scratch state (solid list,
    /// broadphase, contacts) is rebuilt exactly as `step` would see it.
    pub fn restore_state(&mut self, s: &GameState) {
        self.ents.clone_from(&s.ents);
        self.queue.clone_from(&s.queue);
        self.seq = s.seq;
        self.state = s.state;
        self.settings = s.settings;
        self.rules = s.rules;
        self.config = s.config;
        self.policy = s.policy;
        self.spawn_origin = s.spawn_origin;
        self.spawn_angles = s.spawn_angles;
        self.tick = s.tick;
        self.events = s.events;
        self.teleport_angles = s.teleport_angles;
        self.player_name.clone_from(&s.player_name);
        self.player_class.clone_from(&s.player_class);
        self.health = s.health;
        self.gravity_scale = s.gravity_scale;
        self.speed_scale = s.speed_scale;
        self.last_angles = s.last_angles;
        self.restart_point = s.restart_point;
        self.restart_names.clone_from(&s.restart_names);
        self.touch_origin = s.touch_origin;
        self.touch_crouched = s.touch_crouched;
        self.last_move_origin = s.last_move_origin;
        self.movement_errors = s.movement_errors;
        self.last_movement_error.clone_from(&s.last_movement_error);
        self.forced_duck = s.forced_duck;
        self.auto_movement_disabled = s.auto_movement_disabled;
        self.view_angle_change = s.view_angle_change;
        self.last_buttons = s.last_buttons;
        self.arms.clone_from(&s.arms);
        self.extra.clone_from(&s.extra);
        self.contacts.clear();
        self.near.clear();
        self.near_region = None;
        self.rebuild_solid();
    }

    /// Sweeps a cube of half-size `radius` from `start` to `end` through the world, displacements, static props
    /// and solid brush entities at their current positions, with MASK_SOLID (player clips are ignored: this is
    /// for cameras, CS:S chase cam style). Returns the unobstructed fraction (1 = clear, 0 = blocked/start solid).
    pub fn trace_camera(&self, start: [f32; 3], end: [f32; 3], radius: f32) -> f32 {
        let r = radius.max(0.0);
        let hull = Hull { mins: [-r, -r, -r], maxs: [r, r, r] };
        match self.scene(0.0).trace_filtered(start, end, hull, playsrc_collision::MASK_SOLID, &[]) {
            Ok(t) if t.start_solid => 0.0,
            Ok(t) => t.fraction.clamp(0.0, 1.0),
            Err(_) => 0.0,
        }
    }

    /// Deterministic digest of the full simulation state (player + entities + queue).
    pub fn snapshot_bytes(&self) -> Vec<u8> {
        let mut bytes = self.state.snapshot_bytes();
        // Preserve legacy state digests for styles without stamina. Saved GameState already contains this field.
        if self.settings.stamina {
            bytes.extend_from_slice(&self.state.stamina_ms.to_le_bytes());
        }
        bytes.extend_from_slice(&self.tick.to_le_bytes());
        bytes.extend_from_slice(self.player_name.as_bytes());
        bytes.extend_from_slice(self.player_class.as_bytes());
        for v in [self.health, self.gravity_scale, self.speed_scale] {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        for v in self.state.base_velocity {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        for e in &self.ents {
            bytes.push(e.removed as u8 | (e.solid as u8) << 1 | (e.visible as u8) << 2);
            if let Some(b) = &e.brush {
                for v in b.origin.iter().chain(&b.angles) {
                    bytes.extend_from_slice(&v.to_le_bytes());
                }
            }
            if let Data::Kin(k) = &e.data {
                for v in k.push.velocity.iter().chain(&k.push.avelocity).chain([&k.push.local_time, &k.push.move_done]) {
                    bytes.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
        bytes.extend_from_slice(&(self.queue.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&self.last_buttons.to_le_bytes());
        bytes.extend(self.arms.bytes());
        bytes.extend(self.extra.bytes());
        bytes
    }
}

/// Opaque full-state capture (`Game::save_state`): player movement state, every runtime entity (doors, buttons,
/// brush visibility/solidity, triggers incl. touch links and refire ticks, counters, relays, timers, outputs with
/// their remaining fire counts), the entity I/O event queue and the player's name/health/gravity/speed modifiers.
#[derive(Clone)]
pub struct GameState {
    ents: Vec<RtEnt>,
    queue: std::collections::BinaryHeap<QueuedEvent>,
    seq: u64,
    state: State,
    settings: Settings,
    rules: Rules,
    config: Configuration,
    policy: Policy,
    spawn_origin: [f32; 3],
    spawn_angles: [f32; 3],
    tick: u32,
    events: u32,
    teleport_angles: [f32; 3],
    player_name: String,
    player_class: String,
    health: f32,
    gravity_scale: f32,
    speed_scale: f32,
    last_angles: [f32; 3],
    restart_point: Option<([f32; 3], f32)>,
    restart_names: Option<(String, String)>,
    touch_origin: [f32; 3],
    touch_crouched: bool,
    last_move_origin: [f32; 3],
    movement_errors: u32,
    last_movement_error: String,
    forced_duck: bool,
    auto_movement_disabled: bool,
    view_angle_change: [f32; 3],
    last_buttons: u32,
    arms: weapons::Arms,
    extra: Extra,
}

impl GameState {
    /// Tick the capture was taken at.
    pub fn tick(&self) -> u32 {
        self.tick
    }

    /// Approximate heap + inline size in bytes (callers budget how many keyframes they keep).
    pub fn approx_bytes(&self) -> usize {
        use std::mem::size_of;
        let ents: usize = self
            .ents
            .iter()
            .map(|e| {
                size_of::<RtEnt>()
                    + e.class.len()
                    + e.name.len()
                    // Output lists still shared with the game (unchanged since load) cost the snapshot nothing.
                    + if std::sync::Arc::strong_count(&e.outputs) > 1 {
                        0
                    } else {
                        e.outputs.iter().map(|o| size_of::<Output>() + o.event.len() + o.target.len() + o.input.len() + o.param.len()).sum::<usize>()
                    }
            })
            .sum();
        let queue: usize = self.queue.iter().map(|q| size_of::<QueuedEvent>() + q.target.len() + q.input.len() + q.param.len()).sum();
        size_of::<Self>() + ents + queue + self.player_name.len() + self.player_class.len() + self.last_movement_error.len()
    }
}

/// `PHYSICS_FIX_MAP_DOOR_TRAVEL`: Source's signed travel for a func_door / func_button whose travel `build_entity`
/// clamped at 0 (lip larger than the brush along movedir): it moves the difference against movedir. A button that
/// would move under 1 unit, or has "Don't move", stays put (`CBaseButton::Spawn`). Run on a fresh copy at every reset.
fn apply_signed_travel(entity: &Entity, ent: &mut RtEnt) {
    let Some((mins, maxs)) = ent.brush.as_ref().map(|b| (b.mins, b.maxs)) else { return };
    let Data::Mover(m) = &mut ent.data else { return };
    let dir = angle_vectors_forward(entity.vec3("movedir").unwrap_or([0.0; 3]));
    let size = [maxs[0] - mins[0], maxs[1] - mins[1], maxs[2] - mins[2]];
    let lip = entity.float("lip").unwrap_or(0.0);
    let travel = (dir[0] * size[0]).abs() + (dir[1] * size[1]).abs() + (dir[2] * size[2]).abs() - lip;
    if travel >= 0.0 || (m.button && (entity.int("spawnflags") & 1 != 0 || travel > -1.0)) {
        return;
    }
    m.dir = [-dir[0], -dir[1], -dir[2]];
    m.distance = -travel;
}

/// Position2 is the open endpoint for linear doors, including the legacy StartOpen flag.
/// Reference: https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/game/server/doors.cpp (CBaseDoor::Spawn).
fn initialize_linear_door_spawn(entity: &Entity, ent: &mut RtEnt) -> bool {
    if ent.class != "func_door" || (entity.int("spawnflags") & 1 == 0 && entity.int("spawnpos") != 1) {
        return false;
    }
    let Data::Mover(m) = &mut ent.data else { return false };
    m.offset = m.distance;
    m.phase = MoverPhase::Open { until_tick: u32::MAX };
    let (dir, offset) = (m.dir, m.offset);
    if let Some(b) = ent.brush.as_mut() {
        for axis in 0..3 {
            b.origin[axis] = b.base_origin[axis] + dir[axis] * offset;
        }
        ent.origin = b.origin;
        ent.local_origin = b.origin;
    }
    true
}

fn build_entity(e: &Entity, models: &[Model], tick_interval: f32, outputs: Vec<Output>) -> RtEnt {
    let class = e.classname().to_ascii_lowercase();
    let spawnflags = e.int("spawnflags");
    let disabled = e.int("StartDisabled") != 0;
    // Classes whose Spawn() zeroes the angles (CFuncWall and subclasses incl. func_conveyor,
    // CBreakable, func_illusionary); func_door / func_button move along movedir and never rotate.
    let zero_angles = matches!(
        class.as_str(),
        "func_door" | "func_button" | "func_wall" | "func_wall_toggle" | "func_conveyor" | "func_breakable" | "func_breakable_surf" | "func_illusionary"
    );
    let mut angles = if zero_angles { [0.0; 3] } else { e.angles() };
    if class == "prop_door_rotating" {
        // DoorTeleportToSpawnPosition.
        angles = propdoor::build_prop_door(e).1;
    }
    // Solid type (tools/parity/solidtypes.ts on the real engine): SOLID_BSP for func_button, func_wall(_toggle),
    // func_breakable, func_conveyor and solidbsp=1 rotators; SOLID_VPHYSICS for doors, func_brush, physboxes,
    // trains, func_movelinear and other func_rotating.
    let vphysics = !matches!(class.as_str(), "func_lod" | "func_button" | "func_wall" | "func_wall_toggle" | "func_breakable" | "func_breakable_surf" | "func_conveyor")
        && !(matches!(class.as_str(), "func_rotating" | "func_door_rotating") && e.int("solidbsp") != 0)
        && !(class == "func_tracktrain" && spawnflags & 0x80 != 0);
    let brush = e.brush_model().and_then(|model| {
        let m = models.get(model)?;
        Some(BrushModel {
            model,
            origin: e.origin(),
            base_origin: e.origin(),
            angles,
            mins: [m.mins.x.value(), m.mins.y.value(), m.mins.z.value()],
            maxs: [m.maxs.x.value(), m.maxs.y.value(), m.maxs.z.value()],
            vphysics,
        })
    });
    let mut solid = false;
    let mut visible = true;
    let solidity = e.int("Solidity");
    let filter = e.get("filtername").filter(|f| !f.is_empty()).map(str::to_string);
    let trigger = |kind| {
        Data::Trigger(Trigger {
            kind,
            enabled: !disabled,
            spawnflags,
            filter: filter.clone(),
            linked: false,
            touching: false,
            touch_tick: u32::MAX,
        })
    };
    let kinematic = kin::build(&class, e, brush.as_ref(), tick_interval);
    let data = match class.as_str() {
        _ if kinematic.is_some() => {
            let (data, s) = kinematic.expect("checked");
            solid = s;
            data
        }
        "path_track" => kin::build_path_track(e),
        "func_conveyor" => {
            // CFuncConveyor::Spawn: SF_CONVEYOR_VISUAL (1) = no FL_CONVEYOR, SF_CONVEYOR_NOTSOLID (2).
            solid = spawnflags & 2 == 0;
            Data::Conveyor {
                dir: angle_vectors_forward(e.vec3("movedir").unwrap_or([0.0; 3])),
                speed: match e.float("speed").unwrap_or(0.0) {
                    0.0 => 100.0,
                    s => s,
                },
                active: spawnflags & 1 == 0,
            }
        }
        "func_wall" | "func_train" | "func_breakable" | "func_breakable_surf" | "func_detail" => {
            solid = true;
            Data::Static
        }
        "func_wall_toggle" => {
            visible = spawnflags & 1 == 0;
            solid = visible;
            Data::Static
        }
        "func_brush" => {
            visible = !disabled;
            solid = if disabled { solidity == 2 } else { solidity != 1 };
            Data::Static
        }
        "func_door" | "func_button" => {
            let button = class == "func_button";
            let dir = angle_vectors_forward(e.vec3("movedir").unwrap_or([0.0; 3]));
            let (mins, maxs) = brush.as_ref().map(|b| (b.mins, b.maxs)).unwrap_or(([0.0; 3], [0.0; 3]));
            let size = [maxs[0] - mins[0], maxs[1] - mins[1], maxs[2] - mins[2]];
            let lip = e.float("lip").unwrap_or(0.0);
            let travel = (dir[0] * size[0]).abs() + (dir[1] * size[1]).abs() + (dir[2] * size[2]).abs() - lip;
            let dont_move = button && (spawnflags & 1 != 0 || travel < 1.0);
            let speed = e.float("speed").unwrap_or(0.0);
            solid = button || spawnflags & (4 | 8) == 0; // door: non-solid / passable flags
            Data::Mover(Mover {
                button,
                dir,
                distance: if dont_move { 0.0 } else { travel.max(0.0) },
                speed: if speed <= 0.0 { if button { 40.0 } else { 100.0 } } else { speed },
                wait: e.float("wait").unwrap_or(0.0),
                phase: MoverPhase::Closed,
                offset: 0.0,
                locked: spawnflags & 2048 != 0,
                touch_activates: if button { spawnflags & 256 != 0 } else { spawnflags & 1024 != 0 },
                no_auto_return: spawnflags & 32 != 0,
                use_locked_until: 0,
                bhop: None,
                start_tick: 0,
            })
        }
        "trigger_multiple" => trigger(TriggerKind::Multiple {
            wait: match e.float("wait").unwrap_or(0.0) {
                w if w == 0.0 => 0.2,
                w => w,
            },
            next_tick: 0,
        }),
        "trigger_once" => trigger(TriggerKind::Multiple { wait: -1.0, next_tick: 0 }),
        "trigger_teleport" => trigger(TriggerKind::Teleport {
            target: e.get("target").unwrap_or("").to_string(),
            landmark: e.get("landmark").filter(|l| !l.is_empty()).map(str::to_string),
        }),
        "trigger_push" => trigger(TriggerKind::Push {
            dir: angle_vectors_forward(e.vec3("pushdir").unwrap_or([0.0; 3])),
            speed: e.float("speed").unwrap_or(40.0),
            once: spawnflags & 128 != 0,
        }),
        "trigger_hurt" => trigger(TriggerKind::Hurt { damage: e.float("damage").unwrap_or(10.0), next_tick: 0 }),
        "trigger_gravity" => trigger(TriggerKind::Gravity { gravity: e.float("gravity").unwrap_or(1.0) }),
        "trigger_playermovement" => trigger(TriggerKind::PlayerMovement {
            auto_duck: spawnflags & 2048 != 0,
            no_auto_movement: spawnflags & 128 != 0,
        }),
        "point_teleport" => Data::PointTeleport { target: e.get("target").unwrap_or("").to_string() },
        "prop_dynamic" | "prop_dynamic_override" => {
            // Collision itself is built by physics::PropCollision (physics::prop_sources).
            solid = e.get("solid").map(|v| v.trim() != "0").unwrap_or(true) && spawnflags & 256 == 0;
            Data::Prop
        }
        "prop_physics" | "prop_physics_override" | "prop_physics_respawnable" => {
            // COLLISION_GROUP_NONE (debris, spawnflag 4: COLLISION_GROUP_DEBRIS, never hits players).
            solid = !(class.starts_with("prop_physics") && spawnflags & 4 != 0);
            Data::Prop
        }
        "prop_physics_multiplayer" => {
            // COLLISION_GROUP_PUSHAWAY: players move through it (CGameRules::ShouldCollide).
            solid = false;
            Data::Prop
        }
        "filter_activator_name" => Data::Filter {
            kind: FilterKind::Name(e.get("filtername").unwrap_or("").to_string()),
            negated: parse_bool_negated(e.get("Negated")),
        },
        "filter_activator_class" => Data::Filter {
            kind: FilterKind::Class(e.get("filterclass").unwrap_or("").to_string()),
            negated: parse_bool_negated(e.get("Negated")),
        },
        "filter_multi" => Data::Filter {
            kind: FilterKind::Multi {
                all: e.int("FilterType") == 0,
                filters: (1..=5)
                    .filter_map(|n| e.get(&format!("Filter0{n}")).filter(|s| !s.is_empty()).map(str::to_string))
                    .collect(),
            },
            negated: parse_bool_negated(e.get("Negated")),
        },
        "filter_damage_type" => Data::Filter {
            kind: FilterKind::DamageType { damage_type: e.int("damagetype"), negated: parse_bool_negated(e.get("Negated")) },
            negated: false,
        },
        c if c.starts_with("filter_") => Data::Filter { kind: FilterKind::PassAll, negated: false },
        "math_counter" => Data::Counter {
            value: e.float("startvalue").unwrap_or(0.0),
            min: e.float("min").unwrap_or(0.0),
            max: e.float("max").unwrap_or(0.0),
            enabled: !disabled,
        },
        "logic_relay" => Data::Relay { enabled: !disabled, once: spawnflags & 1 != 0 },
        "logic_compare" => Data::Compare {
            value: e.float("InitialValue").unwrap_or(0.0),
            compare: e.float("CompareValue").unwrap_or(0.0),
        },
        "logic_auto" => Data::Auto { once: spawnflags & 1 != 0 },
        "logic_timer" => Data::Timer {
            enabled: !disabled,
            refire: e.float("RefireTime").unwrap_or(1.0).max(0.0),
            next_tick: u32::MAX,
        },
        _ => Data::Other,
    };
    let door_brush = class == "func_door" || class == "func_button";
    RtEnt {
        class,
        name: e.get("targetname").unwrap_or("").to_string(),
        origin: e.origin(),
        angles,
        outputs: std::sync::Arc::new(outputs),
        removed: false,
        brush,
        solid,
        visible,
        solidity,
        vphysics: matches!(
            e.classname().to_ascii_lowercase().as_str(),
            "func_door" | "func_brush" | "func_door_rotating" | "func_rotating" | "func_physbox" | "func_tracktrain"
                | "func_movelinear" | "func_physbox_multiplayer"
        ),
        data,
        parent: None,
        children: Vec::new(),
        local_origin: e.origin(),
        local_angles: angles,
        door_brush,
        motor_name: None,
        prop: None,
    }
}


#[cfg(test)]
mod linear_door_spawn_tests {
    use super::*;
    use playsrc_bsp::{Float32, Vector3};

    fn vec3(v: [f32; 3]) -> Vector3 {
        Vector3 { x: Float32(v[0].to_bits()), y: Float32(v[1].to_bits()), z: Float32(v[2].to_bits()) }
    }
    fn door(class: &str, flags: &str, spawnpos: &str) -> (Entity, RtEnt) {
        let e = Entity { pairs: [("classname", class), ("model", "*0"), ("origin", "10 20 30"),
            ("movedir", "0 0 0"), ("lip", "12"), ("wait", "0"), ("spawnflags", flags), ("spawnpos", spawnpos)]
            .into_iter().map(|(k,v)| (k.into(),v.into())).collect() };
        let model = Model { mins: vec3([-32.0,-4.0,0.0]), maxs: vec3([32.0,4.0,72.0]), origin: vec3([0.0;3]),
            head_node: 0, first_face: 0, face_count: 0 };
        let rt = build_entity(&e, &[model], 0.01, Vec::new());
        (e,rt)
    }
    #[test]
    fn start_open_flag_and_spawnpos_initialize_open_transform_without_a_return_timer() {
        for (flags,pos) in [("1","0"),("0","1")] {
            let (e,mut rt) = door("func_door",flags,pos);
            assert!(initialize_linear_door_spawn(&e,&mut rt));
            assert_eq!(rt.origin,[62.0,20.0,30.0]);
            assert_eq!(rt.local_origin,rt.origin);
            assert_eq!(rt.brush.as_ref().unwrap().origin,rt.origin);
            let Data::Mover(m) = rt.data else { panic!("door mover") };
            assert_eq!(m.offset,52.0);
            assert_eq!(m.phase,MoverPhase::Open{until_tick:u32::MAX});
            assert_eq!(m.dir,[1.0,0.0,0.0],"linear door endpoints are not reversed");
        }
    }
    #[test]
    fn ordinary_closed_door_and_button_keep_their_authored_transform() {
        for (class,flags,pos) in [("func_door","0","0"),("func_door","0","2"),("func_button","1","0")] {
            let (e,mut rt) = door(class,flags,pos);
            assert!(!initialize_linear_door_spawn(&e,&mut rt));
            assert_eq!(rt.origin,[10.0,20.0,30.0]);
            let Data::Mover(m) = rt.data else { panic!("mover") };
            assert_eq!(m.offset,0.0);
            assert_eq!(m.phase,MoverPhase::Closed);
        }
    }
}
