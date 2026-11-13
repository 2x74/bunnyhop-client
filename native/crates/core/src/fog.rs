//! World fog (`env_fog_controller`), render-only: nothing here is read by collision, triggers or the sim.
//!
//! CS:S gives every player the map's master fog controller when they spawn (`CFogSystem::LevelInitPostEntity`: the
//! first controller with spawnflag 1, else the first one in the entity lump) and draws that controller's linear fog
//! over the main view when its `fogenable` is set. The 3D skybox has its own fog on the `sky_camera` (`skybox.rs`).
//!
//! A map can change the fog while it runs: the player input `SetFogController` (per-area fog on about 20 maps here),
//! or inputs sent to a controller (`TurnOn`, `SetColor`, ...). The sim doesn't track either, so those maps report no
//! fog (`find` returns None) and look as they did before, rather than showing the spawn fog where CS:S would not.

use crate::entities::{name_matches, Entity, Output};

/// The keys CS:S reads from the controller. Distances are in world units along the view axis.
#[derive(Clone, Debug, PartialEq)]
pub struct WorldFog {
    pub enable: bool,
    pub blend: bool,
    /// 0..255 (gamma space, like the keyvalue).
    pub color: [f32; 3],
    pub color2: [f32; 3],
    pub dir: [f32; 3],
    pub start: f32,
    pub end: f32,
    pub max_density: f32,
    /// Far clip distance (`farz`); -1 or 0 when the map sets none. Reported, not applied by this crate.
    pub far_z: f32,
}

/// C `atof`: the longest numeric prefix, 0 when there is none ("0,3" is 0, as in the engine).
fn atof(s: &str) -> f32 {
    let s = s.trim_start();
    let mut end = 0;
    let (mut dot, mut exp, mut digits) = (false, false, false);
    for (i, c) in s.char_indices() {
        let ok = match c {
            '0'..='9' => {
                digits = true;
                true
            }
            '+' | '-' => i == 0 || matches!(s.as_bytes()[i - 1], b'e' | b'E'),
            '.' => !dot && !exp && { dot = true; true },
            'e' | 'E' => digits && !exp && { exp = true; true },
            _ => false,
        };
        if !ok {
            break;
        }
        end = i + c.len_utf8();
    }
    let mut prefix = &s[..end];
    // A dangling exponent ("5e", "5e+") isn't part of the number.
    while prefix.ends_with(['e', 'E', '+', '-']) {
        prefix = &prefix[..prefix.len() - 1];
    }
    prefix.parse().unwrap_or(0.0)
}

fn number(e: &Entity, key: &str, default: f32) -> f32 {
    e.get(key).map_or(default, atof)
}

/// Colour keys are "r g b" (some maps add a fourth number); missing components are 0 like `UTIL_StringToColor32`.
fn color(e: &Entity, key: &str, default: [f32; 3]) -> [f32; 3] {
    let Some(v) = e.get(key) else { return default };
    let mut it = v.split_whitespace().map(atof);
    [it.next().unwrap_or(0.0), it.next().unwrap_or(0.0), it.next().unwrap_or(0.0)]
}

fn is_controller(e: &Entity) -> bool {
    e.classname().eq_ignore_ascii_case("env_fog_controller")
}

/// The master controller's fog, or None: no controller, or a map whose fog changes while it runs (module docs).
pub fn find(entities: &[Entity]) -> Option<WorldFog> {
    let controllers: Vec<&Entity> = entities.iter().filter(|e| is_controller(e)).collect();
    let master = controllers.iter().find(|e| e.int("spawnflags") & 1 != 0).or(controllers.first())?;
    let names: Vec<&str> = controllers.iter().filter_map(|e| e.get("targetname")).filter(|n| !n.is_empty()).collect();
    let dynamic = entities.iter().flat_map(|e| e.pairs.iter()).filter_map(|(k, v)| Output::parse(k, v)).any(|o| {
        o.input.eq_ignore_ascii_case("SetFogController") || names.iter().any(|n| name_matches(&o.target, n))
    });
    if dynamic {
        return None;
    }
    let e = *master;
    let mut dir = e.vec3("fogdir").unwrap_or([1.0, 0.0, 0.0]);
    if e.int("use_angles") != 0 {
        // CFogController::Activate: the direction from the entity's angles, negated.
        let [pitch, yaw, _] = e.angles().map(f32::to_radians);
        dir = [-(pitch.cos() * yaw.cos()), -(pitch.cos() * yaw.sin()), pitch.sin()];
    }
    Some(WorldFog {
        enable: e.int("fogenable") != 0,
        blend: e.int("fogblend") != 0,
        color: color(e, "fogcolor", [255.0; 3]),
        color2: color(e, "fogcolor2", [255.0; 3]),
        dir,
        start: number(e, "fogstart", 0.0),
        end: number(e, "fogend", 0.0),
        // The controller's constructor default; a key that doesn't parse is 0 (no fog), like atof.
        max_density: number(e, "fogmaxdensity", 1.0),
        far_z: number(e, "farz", -1.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::parse;

    #[test]
    fn atof_reads_the_numeric_prefix() {
        assert_eq!(atof("0.38"), 0.38);
        assert_eq!(atof(".3"), 0.3);
        assert_eq!(atof("0,3"), 0.0);
        assert_eq!(atof("  -243"), -243.0);
        assert_eq!(atof("5500.0 units"), 5500.0);
        assert_eq!(atof("1e3"), 1000.0);
        assert_eq!(atof("5e"), 5.0);
        assert_eq!(atof(""), 0.0);
        assert_eq!(atof("fog"), 0.0);
    }

    #[test]
    fn reads_the_first_controller() {
        let ents = parse(
            r#"{ "classname" "worldspawn" }
            { "classname" "env_fog_controller" "fogenable" "1" "fogcolor" "207 232 243" "fogstart" "1024" "fogend" "15000" "fogmaxdensity" "0.05" "farz" "-1" }
            { "classname" "env_fog_controller" "fogenable" "1" "fogcolor" "0 0 0" "fogstart" "1" "fogend" "2" }"#,
        );
        let fog = find(&ents).unwrap();
        assert!(fog.enable && !fog.blend);
        assert_eq!(fog.color, [207.0, 232.0, 243.0]);
        assert_eq!((fog.start, fog.end, fog.max_density, fog.far_z), (1024.0, 15000.0, 0.05, -1.0));
    }

    #[test]
    fn the_master_flag_wins_over_lump_order() {
        let ents = parse(
            r#"{ "classname" "env_fog_controller" "fogenable" "1" "fogcolor" "1 2 3" "fogstart" "0" "fogend" "100" }
            { "classname" "env_fog_controller" "spawnflags" "1" "fogenable" "0" "fogcolor" "255 255 255" "fogstart" "500" "fogend" "2000" }"#,
        );
        let fog = find(&ents).unwrap();
        assert!(!fog.enable);
        assert_eq!(fog.start, 500.0);
    }

    #[test]
    fn defaults_and_blend() {
        let ents = parse(
            r#"{ "classname" "env_fog_controller" "fogenable" "1" "fogblend" "1" "fogcolor" "10 20 30 300" "fogcolor2" "40 50 60" "use_angles" "1" "angles" "0 90 0" "fogstart" "100" "fogend" "200" }"#,
        );
        let fog = find(&ents).unwrap();
        assert!(fog.blend);
        assert_eq!(fog.color, [10.0, 20.0, 30.0]);
        assert_eq!(fog.color2, [40.0, 50.0, 60.0]);
        assert_eq!(fog.max_density, 1.0);
        assert!(fog.dir[0].abs() < 1e-6 && (fog.dir[1] + 1.0).abs() < 1e-6 && fog.dir[2].abs() < 1e-6);
        // A comma decimal reads as 0 in the engine: the fog is there but never visible.
        let ents = parse(r#"{ "classname" "env_fog_controller" "fogenable" "1" "fogmaxdensity" "0,3" "fogstart" "1" "fogend" "2" }"#);
        assert_eq!(find(&ents).unwrap().max_density, 0.0);
    }

    #[test]
    fn maps_that_change_fog_at_runtime_report_none() {
        let switched = parse(
            r#"{ "classname" "env_fog_controller" "targetname" "fog_off" "spawnflags" "1" "fogenable" "0" }
            { "classname" "env_fog_controller" "targetname" "fog_on" "fogenable" "1" "fogstart" "100" "fogend" "200" }
            { "classname" "trigger_multiple" "OnStartTouch" "!activator,SetFogController,fog_on,0,-1" }"#,
        );
        assert_eq!(find(&switched), None);
        let toggled = parse(
            "{ \"classname\" \"env_fog_controller\" \"targetname\" \"Fog\" \"fogenable\" \"1\" \"fogstart\" \"100\" \"fogend\" \"200\" }
            { \"classname\" \"trigger_once\" \"OnTrigger\" \"fog\x1bTurnOff\x1b\x1b0\x1b-1\" }",
        );
        assert_eq!(find(&toggled), None);
        // Outputs aimed elsewhere don't count.
        let plain = parse(
            r#"{ "classname" "env_fog_controller" "targetname" "fog" "fogenable" "1" "fogstart" "100" "fogend" "200" }
            { "classname" "trigger_once" "OnTrigger" "door,Open,,0,-1" }"#,
        );
        assert!(find(&plain).is_some());
        assert_eq!(find(&parse(r#"{ "classname" "worldspawn" }"#)), None);
    }
}
