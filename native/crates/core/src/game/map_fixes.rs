//! Per-map trigger fixes (physics v8, `PHYSICS_FIX_MAP_TRIGGERS`): data, not code per map.
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
