//! Per-map fixes: trigger boxes (physics v8, `PHYSICS_FIX_MAP_TRIGGERS`), sv_maxvelocity (physics v14,
//! `PHYSICS_FIX_MAP_MAX_VELOCITY`), Source's signed door travel (physics v15, `PHYSICS_FIX_MAP_DOOR_TRAVEL`), the
//! player's own outputs and filter tests and DanZay's VScript objective gates (physics v16, `PHYSICS_FIX_MAP_PLAYER_IO`).
//! Data, not code per map.
//!
//! A fix names a map by keyvalues of its worldspawn and of every trigger it changes, and gives each of those triggers a
//! world-space box that replaces the brush in the touch test (`Game::touch_triggers_at`; the same start-solid
//! box-vs-brush test as any trigger, on an axis-aligned brush). Everything else about the trigger (target, filters,
//! outputs, enable / disable) is the map's. A fix applies only if every listed trigger is found exactly once, so a
//! different build of the map (moved or renamed entities) gets none of it.
//!
//! The core never sees the map's name or file hash (the verifier streams lumps), so the match is on the entity lump as
//! parsed. Only plain keys are compared: the verifier parses without output key/value pairs
//! (`entity_list_with_outputs(.., false)`). The map name is for tests and tools.
//!
//! Older physics versions never consult this table, so their replays re-simulate unchanged.

use crate::entities::Entity;
use crate::physics::ConvexBrush;

/// One trigger of a fix: how to find it (all keys must match exactly) and its box under the fix.
pub(crate) struct TriggerBox {
    pub classname: &'static str,
    /// The brush model ("*87"); keeps the match to the original brush entity.
    pub model: &'static str,
    pub origin: &'static str,
    pub target: &'static str,
    pub mins: [f32; 3],
    pub maxs: [f32; 3],
}

pub(crate) struct MapFix {
    pub map: &'static str,
    /// Worldspawn keyvalues that must match exactly.
    pub worldspawn: &'static [(&'static str, &'static str)],
    pub triggers: &'static [TriggerBox],
    /// Why, for the reader.
    #[allow(dead_code)]
    pub reason: &'static str,
}

/// A bhop_2easy stage-end teleport: its end room behind the original trigger's front face, wall to wall, floor to ceiling.
macro_rules! end_room {
    ($model:literal, $origin:literal, $target:literal, $cx:literal) => {
        TriggerBox {
            classname: "trigger_teleport",
            model: $model,
            origin: $origin,
            target: $target,
            mins: [$cx - 256.0, 1912.0, 64.0],
            maxs: [$cx + 256.0, 2048.0, 330.0],
        }
    };
}

/// bhop_2easy (srcwr FastDL build, sha1 3c8e3d83f69e...): each stage ends in a 512 x 192 room (walls at the stage's
/// centre x +- 256, back wall y 2048, floor z 64, ceiling z 330). The map's teleport to the next stage is an 80 x 80 x 16
/// trigger in the middle of it, 8 to 24 units above the floor, marked in CS:S only by two blue sprite trails spinning
/// around it. A bunnyhopping player clears it, and one who lands off-centre walks past it to the back wall (bit-exact on
/// srcds, tools/parity). Under the fix each one covers the room from the original trigger's front face (y 1912) to the
/// back wall, wall to wall, floor to ceiling: the same depth into the room, no need to be centred or low.
pub(crate) const MAP_FIXES: &[MapFix] = &[MapFix {
    map: "bhop_2easy",
    worldspawn: &[("message", "Map By: Hog329cc"), ("world_mins", "-4416 -1088 -64"), ("world_maxs", "320 2112 192")],
    triggers: &[
        end_room!("*87", "0 1952 80", "Level 2 Teleport", 0.0),
        end_room!("*89", "-1024 1952 80", "Level 3 Teleport", -1024.0),
        end_room!("*91", "-2048 1952 80", "Level 4 Teleport", -2048.0),
        end_room!("*93", "-3072 1952 80", "Level 5 Teleport", -3072.0),
        // The last room is the timer's end zone; its teleport (to the scout platform) gets the same box for consistency.
        end_room!("*95", "-4096 1952 80", "End Teleport", -4096.0),
    ],
    reason: "stage-end teleports are an unmarked 80x80x16 spot; players jump over or walk past it (feedback 2026-10-08)",
}];

/// The fix matching `entities`, with each fixed trigger's entity index and box brush; None if no fix matches fully.
pub(crate) fn find(entities: &[Entity]) -> Option<(&'static MapFix, Vec<(usize, ConvexBrush)>)> {
    let world = entities.iter().find(|e| e.classname().eq_ignore_ascii_case("worldspawn"))?;
    MAP_FIXES.iter().find_map(|fix| {
        if !fix.worldspawn.iter().all(|(k, v)| world.get(k) == Some(*v)) {
            return None;
        }
        let mut boxes = Vec::with_capacity(fix.triggers.len());
        for t in fix.triggers {
            let mut found = entities.iter().enumerate().filter(|(_, e)| {
                e.classname().eq_ignore_ascii_case(t.classname)
                    && e.get("model") == Some(t.model)
                    && e.get("origin") == Some(t.origin)
                    && e.get("target") == Some(t.target)
                    && e.get("parentname").is_none()
            });
            let (i, _) = found.next()?;
            if found.next().is_some() {
                return None;
            }
            boxes.push((i, ConvexBrush::aabb(t.mins, t.maxs)));
        }
        Some((fix, boxes))
    })
}

/// A map's own sv_maxvelocity (physics v14, `PHYSICS_FIX_MAP_MAX_VELOCITY`), matched by worldspawn keyvalues.
pub(crate) struct MaxVelocity {
    pub map: &'static str,
    /// Worldspawn keyvalues that must match exactly (bounds plus mapversion, or skyname when absent).
    pub worldspawn: &'static [(&'static str, &'static str)],
    pub max_velocity: f32,
    /// First physics version using this limit; historical replay masks stay unchanged.
    pub min_physics: u32,
    /// Why, for the reader.
    #[allow(dead_code)]
    pub reason: &'static str,
}

/// Maps built for more than the 3500 u/s default. Each of the first four runs `sv_maxvelocity 10000` from a logic_auto
/// OnMapSpawn through a point_servercommand (which the core doesn't execute); Momentum Mod's zone files set
/// `maxVelocity: 10000` for icetrap and all three sandtraps. v19 adds mapper requests and newly audited map commands;
/// see research/MAX-VELOCITY.md and research/MAX-VELOCITY-V19.md.
pub(crate) const MAX_VELOCITY: &[MaxVelocity] = &[
    MaxVelocity {
        map: "bhop_sandtrap",
        worldspawn: &[("world_mins", "-16224 -12160 -16320"), ("world_maxs", "9088 15328 15968"), ("mapversion", "209")],
        max_velocity: 10000.0,
        min_physics: 14,
        reason: "logic_auto: server,Command,sv_maxvelocity 10000",
    },
    MaxVelocity {
        map: "bhop_sandtrap3",
        worldspawn: &[("world_mins", "-11840 -15904 -14336"), ("world_maxs", "13792 15328 11744"), ("mapversion", "414")],
        max_velocity: 10000.0,
        min_physics: 14,
        reason: "logic_auto: server,Command,sv_maxvelocity 10000",
    },
    MaxVelocity {
        map: "bhop_icetrap",
        worldspawn: &[("world_mins", "-16128 -13440 -16000"), ("world_maxs", "16096 13408 13824"), ("mapversion", "539")],
        max_velocity: 10000.0,
        min_physics: 14,
        reason: "logic_auto: server,Command,sv_maxvelocity 10000",
    },
    MaxVelocity {
        map: "bhop_goldsrc",
        worldspawn: &[("world_mins", "-13275 -12984 -966"), ("world_maxs", "6840 14273 3936"), ("mapversion", "680")],
        max_velocity: 10000.0,
        min_physics: 14,
        reason: "logic_auto: server,Command,sm_cvar sv_maxvelocity 10000",
    },
    MaxVelocity {
        map: "bhop_sandtrap2",
        worldspawn: &[("world_mins", "-13152 -14816 -14848"), ("world_maxs", "13568 16160 11264"), ("mapversion", "201")],
        max_velocity: 10000.0,
        min_physics: 14,
        reason: "its logic_auto sets only sv_airaccelerate, but the map is built for 10k like sandtrap 1 and 3 (map \
                 description; Momentum Mod maxVelocity 10000)",
    },
    MaxVelocity {
        map: "bhop_gigaheish_fix",
        worldspawn: &[("world_mins", "-15360 -15872 -14336"), ("world_maxs", "15872 15872 14592"), ("skyname", "sky303")],
        max_velocity: 10000.0,
        min_physics: 19,
        reason: "mapper requests sv_maxvelocity 5000 or above (GameBanana 289140); v19 audit uses the existing 10k standard",
    },
    MaxVelocity {
        map: "bhop_accelerate",
        worldspawn: &[("world_mins", "-12096 -15488 -2688"), ("world_maxs", "12992 12480 1664"), ("mapversion", "754")],
        max_velocity: 10000.0,
        min_physics: 19,
        reason: "mapper requests maxvelocity above 3500 (GameBanana 124369); research/MAX-VELOCITY-V19.md",
    },
    MaxVelocity {
        map: "bhop_quack",
        worldspawn: &[("world_mins", "-7200 -16128 -16240"), ("world_maxs", "15680 13776 1536"), ("mapversion", "265")],
        max_velocity: 10000.0,
        min_physics: 19,
        reason: "logic_auto: servercmd,Command,sv_maxvelocity 10000 (popular batch 3; v19 audit)",
    },
    MaxVelocity {
        map: "bhop_rainbowroad_fix",
        worldspawn: &[("world_mins", "-15472 -10274 -5317"), ("world_maxs", "11456 12728 5928"), ("mapversion", "461")],
        max_velocity: 10000.0,
        min_physics: 19,
        reason: "logic_auto: server,Command,sv_maxvelocity 10000 (popular batch 3; v19 audit)",
    },
    MaxVelocity {
        map: "kz_bhop_global",
        worldspawn: &[("world_mins", "-14982 -15352 -8927"), ("world_maxs", "14715 11575 6084"), ("mapversion", "1508")],
        max_velocity: 20000.0,
        min_physics: 19,
        reason: "WR spends 24.96 s at the vertical cap; public reference route reaches 10482 u/s on Z, so 10k is insufficient; v19 audit",
    },
];

/// The map's own sv_maxvelocity entry, if `entities` is one of the `MAX_VELOCITY` builds.
pub(crate) fn max_velocity(entities: &[Entity]) -> Option<&'static MaxVelocity> {
    let world = entities.iter().find(|e| e.classname().eq_ignore_ascii_case("worldspawn"))?;
    MAX_VELOCITY.iter().find(|m| m.worldspawn.iter().all(|(k, v)| world.get(k) == Some(*v)))
}

/// Maps whose func_door / func_button travel follows Source's signed formula (physics v15,
/// `PHYSICS_FIX_MAP_DOOR_TRAVEL`), matched by worldspawn keyvalues like `MAX_VELOCITY`.
///
/// `CBaseDoor::Spawn` sets `m_vecPosition2 = m_vecPosition1 + m_vecMoveDir * (DotProductAbs(m_vecMoveDir, size) - m_flLip)`
/// with no clamp, so a lip larger than the brush along movedir moves the door that much the other way; a button moves
/// the other way too unless that is under 1 unit (`CBaseButton::Spawn`). The core clamps the travel at 0 (the door
/// never moves). A door that moves up quickly when touched launches a player who jumps off it (`SetGroundEntity` hands
/// its velocity to the jump). Audit of all 605 maps in maps/index.json (2026-10-24, research/RELEASE-MAPS-HOTFIX-1025.md):
/// bhop_montana_fix's level 3 "UP" block is the only such mover.
pub(crate) struct SignedDoorTravel {
    pub map: &'static str,
    /// Worldspawn keyvalues that must match exactly (bounds and Hammer's mapversion pin the build).
    pub worldspawn: &'static [(&'static str, &'static str)],
    /// Why, for the reader.
    #[allow(dead_code)]
    pub reason: &'static str,
}

pub(crate) const SIGNED_DOOR_TRAVEL: &[SignedDoorTravel] = &[SignedDoorTravel {
    map: "bhop_montana_fix",
    worldspawn: &[("world_mins", "-10444 -5316 -3932"), ("world_maxs", "5432 5586 4211"), ("mapversion", "158")],
    reason: "level 3's block marked UP (func_door *20: movedir down, 2 units thick, lip 10, speed 300) rises 8 units at \
             300 u/s when touched; jumping off it as it rises is the only way up to the next row of blocks, 143 units \
             higher (bhop.rip replay: 598 u/s up off the block). With the travel clamped at 0 the level can't be \
             finished (feedback 2026-10-15, Jman42).",
}];

/// The map's signed-door-travel entry, if `entities` is one of the `SIGNED_DOOR_TRAVEL` builds.
pub(crate) fn signed_door_travel(entities: &[Entity]) -> Option<&'static SignedDoorTravel> {
    let world = entities.iter().find(|e| e.classname().eq_ignore_ascii_case("worldspawn"))?;
    SIGNED_DOOR_TRAVEL.iter().find(|m| m.worldspawn.iter().all(|(k, v)| world.get(k) == Some(*v)))
}

/// Maps whose route needs the player's own outputs and filter tests (physics v16, `PHYSICS_FIX_MAP_PLAYER_IO`), matched
/// by worldspawn keyvalues like `MAX_VELOCITY`.
///
/// All three use the same "collect N items" prefab: touching an item renames the player and adds an output to the
/// player (`!activator,AddOutput,OnUser1 <filter>:testactivator::0:1`); the next `!activator,FireUser1` fires those
/// outputs, and a chain of filter_activator_name `TestActivator` inputs (`OnPass` / `OnFail`) adds 1 to a math_counter
/// per item held. At its max the counter renames the player (`!activator,AddOutput,targetname <pass name>`), and a
/// filtered trigger_teleport in front of the rest of the course lets only that name through. Before v16 the core
/// dropped all three links (player outputs, FireUser on the player, TestActivator), so the counter never moved and the
/// teleport sent every player back. Audit of every local BSP (2026-10-25, research/SYNTHETIC-DOOR-1025.md): these three
/// are the only maps that add outputs to the player and fire them.
pub(crate) struct PlayerIo {
    pub map: &'static str,
    /// Worldspawn keyvalues that must match exactly (bounds and Hammer's mapversion pin the build).
    pub worldspawn: &'static [(&'static str, &'static str)],
    /// Why, for the reader.
    #[allow(dead_code)]
    pub reason: &'static str,
}

pub(crate) const PLAYER_IO: &[PlayerIo] = &[
    PlayerIo {
        map: "bhop_synthetic_fix",
        worldspawn: &[("world_mins", "-15884 -16291 -14628"), ("world_maxs", "15856 16291 13654"), ("mapversion", "50")],
        reason: "stage 3's potion room: three potions (trigger_multiple *100..*102) feed counter_potcount, whose max \
                 renames the player potpass; the door (trigger_teleport *98, filter_potpass, the room's whole exit) \
                 sends everyone else back to teleport_12. Its stage 4 / 7 tick plates also send filter_*,TestActivator \
                 (feedback 2026-10-25, GothQueen: \"The door doesn't seem to open after collecting three bottles\")",
    },
    PlayerIo {
        map: "bhop_wonderland",
        worldspawn: &[("world_mins", "-11616 -16184 -13814"), ("world_maxs", "12588 15864 2454"), ("mapversion", "136")],
        reason: "the cp3 key room: three keys (*241..*243) feed counter, whose max renames the player ng0_pass; only \
                 that name takes the exit teleport *244 to cp4a",
    },
    PlayerIo {
        map: "bhop_lego3",
        worldspawn: &[("world_mins", "-13216 -4576 -3680"), ("world_maxs", "11136 12288 1856"), ("mapversion", "4978")],
        reason: "three coins (*3..*5) feed counter at checking_trigger *171, whose max renames the player ng0_pass; \
                 everyone else meets the denied teleport *178 and push *177",
    },
];

/// The map's player-I/O entry, if `entities` is one of the `PLAYER_IO` builds.
pub(crate) fn player_io(entities: &[Entity]) -> Option<&'static PlayerIo> {
    let world = entities.iter().find(|e| e.classname().eq_ignore_ascii_case("worldspawn"))?;
    PLAYER_IO.iter().find(|m| m.worldspawn.iter().all(|(k, v)| world.get(k) == Some(*v)))
}

/// Maps whose route goes through DanZay's VScript objective gates (`scripts/vscripts/danzay/nonlinear*.nut`), which
/// physics v16 emulates natively on these maps only (`PHYSICS_FIX_MAP_PLAYER_IO`, `game/vscript.rs`), matched by
/// worldspawn keyvalues like `PLAYER_IO`. The core runs no VScript; without the emulation the gates do nothing.
/// Scan of every catalogue BSP (2026-10-24, research/RELEASE-MAPS-DISCORD-1024.md): the only map with scripts.
pub(crate) struct NonlinearObjectives {
    pub map: &'static str,
    /// Worldspawn keyvalues that must match exactly (bounds and Hammer's mapversion pin the build).
    pub worldspawn: &'static [(&'static str, &'static str)],
    /// Why, for the reader.
    #[allow(dead_code)]
    pub reason: &'static str,
}

pub(crate) const NONLINEAR_OBJECTIVES: &[NonlinearObjectives] = &[NonlinearObjectives {
    map: "bhop_cooksassistant",
    worldspawn: &[("world_mins", "0 0 0"), ("world_maxs", "8192 8704 576"), ("mapversion", "1085")],
    reason: "the cook's kitchen (end zone) is behind two doorways, each a rebound gate (*10, *12) and a teleport gate \
             (*3, *11) named 4: 4 of the 4 ingredient triggers (*4..*7) must be touched since the start room's reset \
             (*8, *9). Without them the end is a 13 s walk from the start (SourceJump WR for the quest: 32.6 s)",
}];

/// The map's objective-system entry, if `entities` is one of the `NONLINEAR_OBJECTIVES` builds.
pub(crate) fn nonlinear_objectives(entities: &[Entity]) -> Option<&'static NonlinearObjectives> {
    let world = entities.iter().find(|e| e.classname().eq_ignore_ascii_case("worldspawn"))?;
    NONLINEAR_OBJECTIVES.iter().find(|m| m.worldspawn.iter().all(|(k, v)| world.get(k) == Some(*v)))
}

/// Physics v19 map-local mechanics. Entity fingerprint covers every retained key/value (including order),
/// excluding outputs, which the verifier stores separately. Completeness additionally pins the entire BSP SHA256.
pub(crate) struct MapMechanics {
    pub map: &'static str,
    pub fingerprint: u32,
    pub makers: bool,
    pub velocity_scripts: bool,
}

/// Owned Stripper-style map edits, applied to runtime spawn state only at physics 19.
/// The enclosing MapMechanics fingerprint pins the original retained entity build.
pub(crate) struct TrainOrientationEdit {
    pub map: &'static str,
    pub targetname: &'static str,
    pub model: &'static str,
    pub orientation_type: i64,
    /// First physics version using this edit; older versions keep the authored orientation.
    pub min_physics: u32,
}

pub(crate) const TRAIN_ORIENTATION_EDITS_V19: &[TrainOrientationEdit] = &[
    // bhop_areaportal_v1, BSP SHA256 d0e43b68978db9ed43222e01159d0ab7685cc78b02b7263b1266bb8f7a295416.
    // Stripper equivalent: match func_tracktrain / rede3da / *26, replace orientationtype "1" with "0".
    // srcds rolls its 180-degree push back in the following VPhysics shadow stage; our core lacks that stage.
    // This is our explicit map edit to retain translation without turning riders, NOT VPhysics emulation.
    // Keep speed, path_tracks, outputs and the shared pusher unchanged. research/MAP-REPORTS-0.0.30.md §1.
    TrainOrientationEdit { map: "bhop_areaportal_v1", targetname: "rede3da", model: "*26", orientation_type: 0, min_physics: 19 },
    // The same edit for the green train, physics 21 on: its 180-degree push turns riders around and leaves them turned.
    TrainOrientationEdit { map: "bhop_areaportal_v1", targetname: "gamstvonorm", model: "*30", orientation_type: 0, min_physics: 21 },
];

/// The map has spawn state that differs from physics v21 on, so crossing that version restarts it (`Game::set_settings`).
pub(crate) fn v21_spawn_edits(mechanics: Option<&MapMechanics>) -> bool {
    mechanics.is_some_and(|m| TRAIN_ORIENTATION_EDITS_V19.iter().any(|e| e.map == m.map && e.min_physics == super::PHYSICS_V21))
}
impl MapMechanics {
    pub fn player_io(&self) -> bool {
        self.makers || matches!(self.map, "bhop_crutle4_css" | "bhop_crutle3_css" | "bhop_enlightened2"
            | "bhop_balaco" | "bhop_4triedsame" | "kz_fastcombowombo" | "bhop_sina_fix" | "bhop_treason")
    }
}
pub(crate) const MECHANICS_V19: &[MapMechanics] = &[
    // Player reports, exact entity builds; no scripts/makers/player I/O enabled by these entries.
    MapMechanics { map: "bhop_areaportal_v1", fingerprint: 0xb83dc69d, makers: false, velocity_scripts: false },
    MapMechanics { map: "bhop_profane", fingerprint: 0x6282cf5e, makers: false, velocity_scripts: false },
    MapMechanics { map: "bhop_playboy_csgo", fingerprint: 0x7b264d5d, makers: false, velocity_scripts: false },
    MapMechanics { map: "bhop_ceaseless", fingerprint: 0x829ab1d3, makers: false, velocity_scripts: true },
    MapMechanics { map: "bhop_cutekittenz2", fingerprint: 0x7b2aa5ac, makers: true, velocity_scripts: false },
    MapMechanics { map: "bhop_vandora", fingerprint: 0x73333401, makers: true, velocity_scripts: false },
    MapMechanics { map: "bhop_ponpon_fix", fingerprint: 0x115add2e, makers: true, velocity_scripts: false },
    MapMechanics { map: "bhop_retrowave", fingerprint: 0x1341a8e6, makers: true, velocity_scripts: false },
    MapMechanics { map: "bhop_akb_tutorial", fingerprint: 0x0a2964d3, makers: true, velocity_scripts: false },
    // Original paks contain no .nut files; these exact missing-file calls have no side effects.
    MapMechanics { map: "bhop_k2", fingerprint: 0x157753a0, makers: false, velocity_scripts: false },
    MapMechanics { map: "bhop_k3", fingerprint: 0xd4a11278, makers: false, velocity_scripts: false },
    MapMechanics { map: "bhop_prig_skok_2", fingerprint: 0x022e7a8b, makers: false, velocity_scripts: false },
    MapMechanics { map: "bhop_rpg", fingerprint: 0xcf6581d7, makers: false, velocity_scripts: false },
    MapMechanics { map: "bhop_avantasia", fingerprint: 0x0b414fd1, makers: false, velocity_scripts: false },
    MapMechanics { map: "bhop_crutle4_css", fingerprint: 0x82e3aa85, makers: false, velocity_scripts: false },
    MapMechanics { map: "bhop_crutle3_css", fingerprint: 0x2014834a, makers: false, velocity_scripts: false },
    MapMechanics { map: "bhop_enlightened2", fingerprint: 0x0e8b64ba, makers: false, velocity_scripts: false },
    MapMechanics { map: "bhop_balaco", fingerprint: 0x18c4daa3, makers: false, velocity_scripts: false },
    MapMechanics { map: "bhop_4triedsame", fingerprint: 0x0c832785, makers: false, velocity_scripts: false },
    MapMechanics { map: "kz_fastcombowombo", fingerprint: 0x6488bde3, makers: false, velocity_scripts: false },
    MapMechanics { map: "bhop_sina_fix", fingerprint: 0xd39597cb, makers: false, velocity_scripts: false },
    MapMechanics { map: "bhop_collective", fingerprint: 0x9befc103, makers: false, velocity_scripts: false },
    MapMechanics { map: "bhop_api_kowka", fingerprint: 0xe3778369, makers: false, velocity_scripts: false },
    MapMechanics { map: "kz_bhop_liminal", fingerprint: 0x1b4bf86b, makers: false, velocity_scripts: false },
    MapMechanics { map: "bhop_surf_apex", fingerprint: 0x0382bb33, makers: false, velocity_scripts: false },
    MapMechanics { map: "bhop_treason", fingerprint: 0x3b951e2a, makers: false, velocity_scripts: false },
    MapMechanics { map: "bhop_prototype01", fingerprint: 0x4b656963, makers: false, velocity_scripts: false },
 ];

pub(crate) fn mechanics_v19(entities: &[Entity]) -> Option<&'static MapMechanics> {
    let fingerprint = entity_fingerprint(entities);
    MECHANICS_V19.iter().find(|m| m.fingerprint == fingerprint)
}

/// CRC of every retained key/value in order, without outputs, which the verifier stores separately.
pub(crate) fn entity_fingerprint(entities: &[Entity]) -> u32 {
    let mut hash = crc32fast::Hasher::new();
    for e in entities {
        for (k, v) in &e.pairs {
            if crate::entities::Output::parse(k, v).is_some() { continue; }
            hash.update(k.as_bytes()); hash.update(&[0]);
            hash.update(v.as_bytes()); hash.update(&[0]);
        }
        hash.update(&[255]);
    }
    hash.finalize()
}

/// Maps whose func_door / func_button brushes follow their move parent (physics v21). `CBaseDoor` is an ordinary
/// MOVETYPE_PUSH child in Source, so the door turns with its parent and travels in the parent's space. The core has
/// always held a door's brush at base origin + travel and never turned it. Not global: bhop_guly, bhop_addict_v2,
/// bhop_eazy_v2, bhop_monster_jam and bhop_mario_fxd have the same setup and real runs on some of their boards, see
/// research/parented-doors-v21/scan.json. Matched by entity fingerprint like `MECHANICS_V19`.
pub(crate) struct ParentedDoors {
    pub map: &'static str,
    pub fingerprint: u32,
    /// Why, for the reader.
    #[allow(dead_code)]
    pub reason: &'static str,
}

pub(crate) const PARENTED_DOORS_V21: &[ParentedDoors] = &[ParentedDoors {
    map: "bhop_wayz",
    fingerprint: 0x5a757368,
    reason: "level 10's three-layer floor (func_door *148) is parented to the rotator 10throll with the teleports *1 and \
             *3, all cut with the same holes. With the floor held still, the holes line up with the teleports' only near \
             rotor angle 0 and the map can't be finished (feedback 2026-10-30, lfyzl; bhop.rip's recording falls through \
             floor 1 at 10 different world angles). The rolling logs *79, *92 and *96 follow roll71, roll5 and roll2.",
}];

/// The map's parented-door entry, if `entities` is one of the `PARENTED_DOORS_V21` builds.
pub(crate) fn parented_doors_v21(entities: &[Entity]) -> Option<&'static ParentedDoors> {
    let fingerprint = entity_fingerprint(entities);
    PARENTED_DOORS_V21.iter().find(|m| m.fingerprint == fingerprint)
}

/// Maps whose player-activated outputs run on EventQueueFix's clock from physics v23: no player clock lead
/// (`Game::player_clock_lead`). A touch-fired "0.2 s" output lands 20 + 1 commands later, not 20 + 1 + 5.
///
/// Stock CS:S times outputs on the player's usercmd clock (60 ms ahead of the server), and the core, tools/parity and the
/// bot in srcds all agree on that. But real timer servers run eventqueuefix: on the anti-hop blocks of these maps
/// (`OnStartTouch gravity 40` at 0.2 s, `gravity 1` at 0.3 s) 11 recordings from Lodge, Yatta, Flappy, tommyhops and bhop.rip
/// show the slam exactly 21 commands after the touch 332 times (KawaiiClan Climb, without the plugin, shows 24 to 30). The core
/// had 26, so a player timing a block as on those servers jumped into the last 5 ticks of gravity 40: staff's "anti hop
/// triggers are way too long" on every kz_ map. Every delayed output moves with it, also `targetname` windows, as on those
/// servers: a block with an 0.09 s `targetname` gives 9 ticks to leave, not 14.
///
/// Two more maps, both reported as a broken booster and with no finisher yet. bhop_trampislow's `*280` names the player 0.01 s
/// after they touch it, and the 46 u tall `*279` above it pushes only that name, at +150 u/s a tick: with the lead the player has
/// nearly left it before the name lands (peak 952 u/s, the recording 1138). bhop_handsuplol's start booster lands 6 ticks after
/// the touch instead of at once.
pub(crate) struct EventClock {
    pub map: &'static str,
    pub fingerprint: u32,
}

macro_rules! event_clock {
    ($($map:literal $fingerprint:literal,)*) => { &[$(EventClock { map: $map, fingerprint: $fingerprint },)*] };
}

pub(crate) const EVENT_CLOCK_V23: &[EventClock] = event_clock![
    "bhop_handsuplol" 0x4a879cf8,
    "bhop_trampislow" 0x5f6f6f69,
    "kz_bhop_badg3s" 0x2ea8e001,
    // Same entity lump as bhop_benchmark, so that map is on this clock too: the same course.
    "kz_bhop_benchmark" 0x2093b2f4,
    "kz_bhop_cartooncastle_b1" 0xf00e4cde,
    "kz_bhop_delusional" 0x7bb19631,
    "kz_bhop_deserted" 0x060c9847,
    "kz_bhop_essence" 0x1945b858,
    "kz_bhop_global" 0x46491236,
    "kz_bhop_indiana" 0x07e6e0f5,
    "kz_bhop_kairo" 0xbf8a1b29,
    "kz_bhop_kantan" 0x332fb34d,
    "kz_bhop_knothard" 0x396b532d,
    "kz_bhop_learning" 0x5d96a09a,
    "kz_bhop_liminal" 0x1b4bf86b,
    "kz_bhop_lj" 0x331cffb3,
    "kz_bhop_minimal" 0xd275d4d9,
    "kz_bhop_nothing" 0x60c2e3e4,
    "kz_bhop_peaceful" 0x4ebea1df,
    "kz_bhop_proxy_null" 0xa9f690e6,
    "kz_bhop_solitude" 0x01365e71,
    "kz_bhop_strafe_comjump2_v2" 0xc4b8d28b,
    "kz_bhop_yonkoma" 0x46708c81,
];

/// The map's entry in `EVENT_CLOCK_V23`, if `fingerprint` (`entity_fingerprint`) is one of those builds.
pub(crate) fn event_clock_v23(fingerprint: u32) -> Option<&'static EventClock> {
    EVENT_CLOCK_V23.iter().find(|m| m.fingerprint == fingerprint)
}

/// A trigger_teleport sent somewhere else from physics v23. Only reviewed mapper mistakes; the map is otherwise CS:S's.
pub(crate) struct TeleportTargetEdit {
    #[allow(dead_code)]
    pub map: &'static str,
    pub fingerprint: u32,
    pub model: usize,
    pub from: &'static str,
    pub to: &'static str,
    /// Why, for the reader.
    #[allow(dead_code)]
    pub reason: &'static str,
}

pub(crate) const TELEPORT_TARGET_EDITS_V23: &[TeleportTargetEdit] = &[TeleportTargetEdit {
    map: "bhop_benchmark",
    fingerprint: 0x2093b2f4,
    model: 497,
    from: "67",
    to: "100",
    reason: "the xhop block *497 at (656, 2160, 2752) sends a player who stays on it to destination 67, a stage 20 minutes back \
             (1792, 12416, -152), where the map's other six teleports to 67 are. Every other teleport around it goes to 100, the \
             start of this stage (1008, 2432, 2632). maeson lost 21 minutes to it on 2026-10-31 on their 72:04 run. The same in \
             real CS:S, so the mapper's mistake, not ours. kz_bhop_benchmark has the same entity lump and the same trigger.",
}];

/// The destination of teleport `model` on this build under physics v23, if it has been edited.
pub(crate) fn teleport_target_v23(entities_fingerprint: u32, model: usize, target: &str) -> Option<&'static str> {
    TELEPORT_TARGET_EDITS_V23
        .iter()
        .find(|e| e.fingerprint == entities_fingerprint && e.model == model && e.from == target)
        .map(|e| e.to)
}

/// v23: reviewed builds whose route needs `logic_case` PickRandom and `AddOutput target` on a trigger_teleport (with a
/// `!activator` landmark, as these maps use it). bhop_crutle5_css's first level ends in a trigger_teleport with no
/// target: touching it picks a case that gives it one (research/MAPS-FINISH-V34.md). Exact entity builds only.
#[allow(dead_code)] // `map` documents the row, as in `ParentedDoors`.
pub(crate) struct LogicCaseV23 {
    pub map: &'static str,
    pub fingerprint: u32,
}
pub(crate) const LOGIC_CASE_V23: &[LogicCaseV23] = &[LogicCaseV23 { map: "bhop_crutle5_css", fingerprint: 0xdfb87918 }];
pub(crate) fn logic_case_v23(entities: &[crate::entities::Entity]) -> Option<&'static LogicCaseV23> {
    let fingerprint = entity_fingerprint(entities);
    LOGIC_CASE_V23.iter().find(|m| m.fingerprint == fingerprint)
}
