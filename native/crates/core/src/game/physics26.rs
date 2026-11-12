//! Physics 26's exact-build subset. Immutable build metadata is outside GameState;
//! reset reconstructs the same existing Trigger state, so snapshots need no new fields.
use super::*;
impl Game {
    pub(super) fn coast_v26(&self) -> bool {
        self.settings.physics_version >= PHYSICS_V26 && self.map_build_v26.is_some_and(|b| b.coast)
    }

    pub(super) fn initialize_coast_v26(&mut self) {
        if !self.coast_v26() { return; }
        for (i, e) in self.entities.iter().enumerate() {
            if e.classname() != "trigger_momentum_teleport" { continue; }
            // Fail closed even within the exact-build guard. No modes, landmarks, outputs,
            // end-touch flags or angle/velocity variants beyond the reviewed 19 resets.
            if e.get("stop") != Some("1") || e.get("resetang") != Some("1")
                || e.int("spawnflags") != 1 || e.get("landmark").is_some_and(|s| !s.is_empty())
                || !self.ents[i].outputs.is_empty() { continue; }
            self.ents[i].data = Data::Trigger(Trigger {
                kind: TriggerKind::Teleport { target: e.get("target").unwrap_or("").to_string(), landmark: None },
                enabled: e.int("StartDisabled") == 0, spawnflags: 1,
                filter: e.get("filtername").filter(|s| !s.is_empty()).map(str::to_string),
                linked: false, touching: false, touch_tick: u32::MAX,
            });
        }
    }
}

// Momentum map 81, zones v4, format 1, dataTimestamp 1774298282018,
// zone SHA1 29a4aa77c02cbb1b50b413f6a5f5d1a1cc75154a. Original polygon
// coordinates retained, including the rotated last checkpoint. Policy belongs to
// this exact build/version, never to generic timer rules or historical replays.
struct Region { points: [[f32; 2]; 4], bottom: f32, height: f32 }
impl Region {
    fn touches(&self, p: [f32; 3], hull: Hull) -> bool {
        if p[2] + hull.maxs[2] < self.bottom || p[2] + hull.mins[2] > self.bottom + self.height { return false; }
        // Convex polygon vs axis-aligned player hull: separating axes from both
        // shapes. This does not replace the rotated polygon with its enclosing box.
        let lo = [p[0] + hull.mins[0], p[1] + hull.mins[1]];
        let hi = [p[0] + hull.maxs[0], p[1] + hull.maxs[1]];
        let mut axes = vec![[1.0, 0.0], [0.0, 1.0]];
        for i in 0..4 { let a = self.points[i]; let b = self.points[(i+1)%4]; axes.push([a[1]-b[1], b[0]-a[0]]); }
        axes.into_iter().all(|a| {
            let dots = self.points.map(|q| q[0]*a[0] + q[1]*a[1]);
            let min = dots.into_iter().fold(f32::INFINITY, f32::min);
            let max = dots.into_iter().fold(f32::NEG_INFINITY, f32::max);
            let box_min = (if a[0] >= 0.0 {lo[0]} else {hi[0]})*a[0] + (if a[1] >= 0.0 {lo[1]} else {hi[1]})*a[1];
            let box_max = (if a[0] >= 0.0 {hi[0]} else {lo[0]})*a[0] + (if a[1] >= 0.0 {hi[1]} else {lo[1]})*a[1];
            box_max >= min && box_min <= max
        })
    }
}
const COAST_CHECKPOINTS: [Region; 9] = [
Region { points: [[-10149.0, -10400.0], [-10149.0, -10640.0], [-9765.0, -10640.0], [-9765.0, -10400.0]], bottom: -14221.0, height: 128.0 },
Region { points: [[-1199.0, -12929.0], [-1199.0, -13371.0], [-591.0, -13371.0], [-591.0, -12929.0]], bottom: -12800.0, height: 324.0 },
Region { points: [[3448.0, -3264.0], [3448.0, -977.57763671875], [2850.0, -977.57763671875], [2850.0, -3264.0]], bottom: -9520.0, height: 5044.0 },
Region { points: [[7296.0, -9392.0], [7417.1201171875, -9392.0], [7417.1201171875, -8880.0], [7296.0, -8880.0]], bottom: -2247.90673828125, height: 203.90673828125 },
Region { points: [[2112.0, 8640.0], [1990.0001220703125, 8640.0], [1990.0001220703125, 8000.0], [2112.0, 8000.0]], bottom: 3008.0, height: 353.0 },
Region { points: [[-14012.0, 6448.0], [-14012.0, 6112.0], [-13500.0, 6112.0], [-13500.0, 6448.0]], bottom: 9443.0, height: 282.0 },
Region { points: [[-8832.0, -7536.0], [-8960.0, -7536.0], [-8960.0, -8048.0], [-8832.0, -8048.0]], bottom: 14449.158203125, height: 204.841796875 },
Region { points: [[10311.0, -11136.0], [10311.0, -10976.0], [9788.0, -10976.0], [9788.0, -11136.0]], bottom: 14080.0, height: 603.0 },
Region { points: [[-10444.3701171875, -11155.6298828125], [-10697.57421875, -10902.42578125], [-10788.083984375, -10992.935546875], [-10534.8798828125, -11246.1396484375]], bottom: 3584.0, height: 773.0 }
];
const COAST_END: Region = Region { points: [[-11918.0, 127.0], [-11918.0, -369.0], [-11627.0, -369.0], [-11627.0, 127.0]], bottom: -1065.0, height: 256.0 };

impl Game {
    /// Extra::objectives is already ordered, saved/restored and digested; coast
    /// has no nonlinear-objective script, so its indices 0..8 are unambiguous.
    pub(super) fn coast_progress_v26(&mut self) {
        if !self.coast_v26() { return; }
        let p = self.state.position;
        let hull = self.current_hull();
        if COAST_CANCEL.touches(p, hull) {
            self.extra.objectives.clear();
            self.events |= EVENT_RESPAWNED;
            return;
        }
        if COAST_CHECKPOINTS[0].touches(p, hull) {
            self.extra.objectives.clear();
            self.extra.objectives.push(0);
        }
        let next = self.extra.objectives.len();
        if next > 0 && next < COAST_CHECKPOINTS.len() && COAST_CHECKPOINTS[next].touches(p, hull) {
            self.extra.objectives.push(next as u32);
        }
        if COAST_END.touches(p, hull) && self.extra.objectives.len() != COAST_CHECKPOINTS.len() {
            self.extra.objectives.clear();
            // A lobby/portal shortcut cancels the run before RunTimer observes
            // the end: die() sets EVENT_RESPAWNED, which stops timing from
            // timer rules 5 (apps/web/src/timer.ts), like the cancel region.
            self.die();
        }
    }
}

const COAST_CANCEL: Region = Region { points: [[-9877.0, -10640.0], [-9973.0, -10640.0], [-9973.0, -10720.0], [-9877.0, -10720.0]], bottom: -14221.0, height: 108.0 };

#[cfg(test)]
mod tests {
    use super::*;
    fn load(name: &str, version: u32) -> Option<Game> {
        let mut g = crate::content::load_game(&crate::test_maps::map(name)?).unwrap();
        g.set_settings(Settings { physics_version: version, ..Settings::css_bhop() }); g.reset(); Some(g)
    }
    #[test]
    fn selector_identity_renames_wildcards_negation_multi_and_targets() {
        let Some(mut g) = load("ahop_coast", PHYSICS_V26) else { return };
        let f = g.ents.iter().position(|e| e.name == "filter_triggers").unwrap();
        for name in ["", "renamed", "!player"] {
            assert!(g.filter_entity_passes(f, name, "renamed_class", true, 0));
            assert!(!g.filter_entity_passes(f, name, "player", false, 0));
        }
        g.ents[f].data = Data::Filter { kind: FilterKind::Name("player_*".into()), negated: false };
        assert!(g.filter_entity_passes(f, "player_42", "player", true, 0));
        assert!(!g.filter_entity_passes(f, "renamed", "player", true, 0));
        g.ents[f].data = Data::Filter { kind: FilterKind::Name("!player".into()), negated: true };
        assert!(!g.filter_entity_passes(f, "renamed", "player", true, 0));
        let multi = g.ents.len();
        let mut e = g.ents[f].clone(); e.name = "multi".into();
        e.data = Data::Filter { kind: FilterKind::Multi { all: true, filters: vec!["filter_triggers".into()] }, negated: true };
        g.ents.push(e);
        assert!(g.filter_entity_passes(multi, "renamed", "player", true, 0));
        assert!(!g.filter_entity_passes(multi, "renamed", "player", false, 0));
        g.settings.physics_version = PHYSICS_V25;
        assert!(g.filter_entity_passes(f, "renamed", "player", true, 0)); // old literal test, inverted
        assert!(!g.filter_entity_passes(f, "!player", "player", true, 0));
        g.settings.physics_version = PHYSICS_V26;
        for token in ["!activator", "!caller", "!self", "!pvsplayer", "!picker"] {
            assert!(!g.filter_name_matches(token, "renamed", true));
        }
        assert_eq!(g.resolve_targets("!activator", Actor::Player, Actor::Entity(f)), vec![Actor::Player]);
        assert_eq!(g.resolve_targets("!caller", Actor::Player, Actor::Entity(f)), vec![Actor::Entity(f)]);
        assert_eq!(g.resolve_targets("!self", Actor::Player, Actor::Entity(f)), vec![Actor::Entity(f)]);
        for t in ["!player", "!pvsplayer", "!picker"] { assert_eq!(g.resolve_targets(t, Actor::None, Actor::None), vec![Actor::Player]); }
    }
    #[test]
    fn coast_reset_subset_is_versioned_stops_turns_and_restores() {
        let Some(mut g) = load("ahop_coast", PHYSICS_V26) else { return };
        let ids: Vec<_> = g.ents.iter().enumerate().filter(|(_,e)| e.class == "trigger_momentum_teleport").map(|(i,_)| i).collect();
        assert_eq!(ids.len(), 19);
        for &i in &ids {
            assert!(matches!(g.ents[i].data, Data::Trigger(_)));
            let target = g.entities[i].get("target").unwrap();
            let dest = g.find_named(target).unwrap();
            let expected_angles = g.ents[dest].angles;
            g.state.velocity = [999.0, -777.0, -1200.0]; g.last_angles = [33.0, 44.0, 0.0];
            assert!(g.teleport_through(i));
            assert_eq!(g.state.velocity, [0.0;3]); assert_eq!(g.teleport_angles, expected_angles);
            assert!(g.events & EVENT_TELEPORTED != 0);
        }
        let snapshot = g.save_state(); let bytes = g.snapshot_bytes();
        g.step(Cmd::default()).unwrap(); g.restore_state(&snapshot); assert_eq!(g.snapshot_bytes(), bytes);
        g.set_settings(Settings { physics_version: PHYSICS_V25, ..Settings::css_bhop() });
        assert!(ids.iter().all(|&i| matches!(g.ents[i].data, Data::Other)));
    }
    fn visit(g: &mut Game, n: usize) {
        let r = &COAST_CHECKPOINTS[n];
        g.place_player([r.points.iter().map(|p|p[0]).sum::<f32>()/4.0, r.points.iter().map(|p|p[1]).sum::<f32>()/4.0, r.bottom+2.0]);
        g.coast_progress_v26();
    }
    #[test]
    fn coast_checkpoints_reject_skips_reordering_lobby_and_allow_saved_segments() {
        let Some(mut g) = load("ahop_coast", PHYSICS_V26) else { return };
        visit(&mut g, 2); assert!(g.extra.objectives.is_empty());
        visit(&mut g, 0); visit(&mut g, 2); assert_eq!(g.extra.objectives, [0]);
        visit(&mut g, 1); let segment = g.save_state();
        for i in 2..9 { visit(&mut g,i); }
        assert_eq!(g.extra.objectives, (0..9).collect::<Vec<_>>());
        g.state.position = [-11770.0,-120.0,-1060.0]; g.events=0; g.coast_progress_v26(); assert_eq!(g.events & EVENT_RESPAWNED,0);
        g.restore_state(&segment); for i in 2..9 { visit(&mut g,i); } assert_eq!(g.extra.objectives.len(),9);
        visit(&mut g,0); g.state.position = [-11770.0,-120.0,-1060.0]; g.events=0; g.coast_progress_v26(); assert_ne!(g.events & EVENT_RESPAWNED,0);
        visit(&mut g,0);visit(&mut g,1);g.state.position=[-9925.0,-10700.0,-14220.0];g.events=0;g.coast_progress_v26();assert!(g.extra.objectives.is_empty());assert_ne!(g.events & EVENT_RESPAWNED,0);
        visit(&mut g,0);visit(&mut g,1);g.respawn_player();assert!(g.extra.objectives.is_empty());
        let r=&COAST_CHECKPOINTS[8]; assert!(!r.touches([-10445.0,-10903.0,3600.0],g.current_hull()),"rotated polygon excludes enclosing-box corner");
    }
}

#[cfg(test)]
mod touch_tests {
    use super::*;
    #[test]
    fn coast_fall_reset_touch_is_start_only_and_obeys_enable_filter() {
        let Some(path)=crate::test_maps::map("ahop_coast") else { return };
        let mut g=crate::content::load_game(&path).unwrap();g.set_settings(Settings{physics_version:26,..Settings::css_bhop()});g.reset();
        let ids:Vec<_>=g.ents.iter().enumerate().filter(|(_,e)|e.class=="trigger_momentum_teleport").map(|(i,_)|i).collect();
        let mut falls=0;
        for i in ids {
            let Some((lo,hi))=g.entity_bounds(i) else {continue};g.reset();
            g.place_player([(lo[0]+hi[0])*0.5,(lo[1]+hi[1])*0.5,hi[2]+64.0]);g.state.velocity=[0.0,0.0,-500.0];
            let before=falls;
            for _ in 0..120 {g.step(Cmd::default()).unwrap();if g.events & EVENT_TELEPORTED!=0 {assert_eq!(g.events & EVENT_MAP_TELEPORT,0,"Momentum reset is not RNGFix stock telehop");falls+=1;break;}}
            if falls==before { eprintln!("unreached fall reset {} {:?} from {:?} final {:?}",i,g.entities[i].get("target"),hi,g.state.position); }
        }
        eprintln!("coast falling reset probes caught {falls}/19");assert!(falls>0);
        let i=g.ents.iter().position(|e|e.class=="trigger_momentum_teleport").unwrap();
        g.reset();let (lo,hi)=g.entity_bounds(i).unwrap();let p=[(lo[0]+hi[0])*0.5,(lo[1]+hi[1])*0.5,lo[2]+2.0];
        g.place_player(p);g.trigger_mut(i).enabled=false;g.events=0;g.touch_triggers_at();assert_eq!(g.events & EVENT_TELEPORTED,0);
        g.trigger_mut(i).enabled=true;g.trigger_mut(i).filter=Some("filter_triggers".into());g.player_name="renamed".into();
        g.touch_triggers_at();assert_ne!(g.events & EVENT_TELEPORTED,0);
        // A live link is not a second StartTouch, even after an external reposition.
        g.place_player(p);g.events=0;g.touch_triggers_at();assert_eq!(g.events & EVENT_TELEPORTED,0);
    }
}
