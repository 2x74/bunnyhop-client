//! Exact packed Liminal script equivalents, no code evaluation. Source and connections retained in maps-mech3/audit.json.
use super::*;

#[derive(Clone, Debug, Default)]
pub(super) struct State {
    checkpoint: Option<u8>,
    ground_limit: Option<f32>,
    // caller.GetScriptScope(): each trigger keeps its player record and connected output across exits.
    anticj: std::collections::BTreeMap<usize, (u32, bool)>,
    singles: std::collections::BTreeSet<u32>,
    last_repeat: Option<u32>,
    processed: std::collections::BTreeMap<usize, f32>,
}
impl State {
    pub(super) fn digest(&self, out: &mut Vec<u8>) {
        // Historical state digests have no additional bytes.
        if self.checkpoint.is_none() && self.ground_limit.is_none() && self.anticj.is_empty() && self.singles.is_empty() && self.last_repeat.is_none() && self.processed.is_empty() { return; }
        out.extend_from_slice(b"scripts19\0");
        out.push(self.checkpoint.unwrap_or(0));
        out.extend_from_slice(&self.ground_limit.unwrap_or(-1.0).to_le_bytes());
        out.extend_from_slice(&(self.anticj.len() as u32).to_le_bytes());
        out.extend_from_slice(&(self.singles.len() as u32).to_le_bytes());
        for i in &self.singles { out.extend_from_slice(&i.to_le_bytes()); }
        out.extend_from_slice(&self.last_repeat.unwrap_or(u32::MAX).to_le_bytes());
        out.extend_from_slice(&(self.processed.len() as u32).to_le_bytes());
        for (i, time) in &self.processed { out.extend_from_slice(&(*i as u32).to_le_bytes()); out.extend_from_slice(&time.to_le_bytes()); }
        for (i, (buttons, ground)) in &self.anticj {
            out.extend_from_slice(&(*i as u32).to_le_bytes());
            out.extend_from_slice(&buttons.to_le_bytes()); out.push(*ground as u8);
        }
    }
}
impl Game {
    fn liminal19(&self) -> bool {
        self.mechanics_on() && self.map_mechanics.is_some_and(|m| m.map == "kz_bhop_liminal")
    }
    fn treason19(&self) -> bool {
        self.mechanics_on() && self.map_mechanics.is_some_and(|m| m.map == "bhop_treason")
    }
    pub(super) fn initialize_scripts19(&mut self) {
        if self.mechanics_on() && self.map_mechanics.is_some_and(|m| m.map == "bhop_collective") {
            for (i, e) in self.entities.iter().enumerate() {
                if e.classname() == "trigger_teleport_relative" {
                    self.ents[i].data = Data::Trigger(Trigger {
                        kind: TriggerKind::TeleportRelative { offset: e.vec3("teleportoffset").unwrap_or([0.0; 3]) },
                        enabled: e.int("StartDisabled") == 0,
                        spawnflags: e.int("spawnflags"),
                        filter: e.get("filtername").filter(|f| !f.is_empty()).map(str::to_string),
                        linked: false, touching: false, touch_tick: u32::MAX,
                    });
                }
            }
            self.reindex_instances();
        }
        if !self.liminal19() && !self.treason19() { return; }
        // mapspawn.nut includes bhopblocks_core_alt before bhopblocks_ent registers the five blocks.
        for (i, e) in self.entities.iter().enumerate() {
            if e.get("vscripts") == Some("bhopblocks_ent.nut") && e.get("targetname").is_some_and(|n| n.starts_with("block_multibhop_") || (self.treason19() && (n.starts_with("block_single_") || n.starts_with("block_repeatable_")))) {
                if let Data::Trigger(t) = &mut self.ents[i].data {
                    if let TriggerKind::Multiple { wait, .. } = &mut t.kind { *wait = 0.01; }
                }
                std::sync::Arc::make_mut(&mut self.ents[i].outputs).push(Output::parse("OnTrigger", "!self,CallScriptFunction,Touch,0,-1").unwrap());
            }
        }
    }
    pub(super) fn script19_input(&mut self, target: Actor, input: &str, param: &str, activator: Actor, caller: Actor) -> bool {
        if self.treason19() { return self.treason19_input(target, input, param, activator, caller); }
        if !self.liminal19() { return false; }
        let Actor::Entity(i) = target else { return false; };
        if self.ents[i].removed { return false; }
        if input == "runscriptcode" && self.ents[i].name == "3wayteleport_entity" {
            if activator == Actor::Player {
                match param.trim() {
                    "SetCheckpoint()" => {
                        self.extra.scripts19.checkpoint = match caller {
                            Actor::Entity(j) => match self.ents[j].name.as_str() { "setcp6" => Some(6), "setcp7" => Some(7), "setcp8" => Some(8), _ => None },
                            _ => return true,
                        };
                    }
                    "OnStartTouch()" => {
                        if let Some(cp) = self.extra.scripts19.checkpoint {
                            if let Some(dest) = self.find_named(&format!("greenstage_{cp}")) { self.script19_teleport(dest, true); }
                        }
                    }
                    _ => {}
                }
            }
            return true;
        }
        if input == "runscriptcode" && self.ents[i].name == "anticjscript" && param.trim() == "OnStartTouch()" {
            if activator == Actor::Player {
                if let Actor::Entity(j) = caller {
                    let first = !self.extra.scripts19.anticj.contains_key(&j);
                    self.extra.scripts19.anticj.insert(j, (0, self.state.ground.is_some()));
                    if first {
                        std::sync::Arc::make_mut(&mut self.ents[j].outputs).push(Output::parse("OnTrigger", "!self,CallScriptFunction,ThinkLoop,0,-1").unwrap());
                    }
                }
            }
            return true;
        }
        if input == "callscriptfunction" && param == "ThinkLoop" && self.entities[i].get("vscripts") == Some("anticj.nut") {
            let on_ground = self.state.ground.is_some();
            if let Some((last_buttons, was_ground)) = self.extra.scripts19.anticj.get_mut(&i) {
                *was_ground |= on_ground;
                let pressed = self.last_buttons & !*last_buttons;
                if *was_ground && !on_ground && pressed & (IN_JUMP | IN_DUCK) == (IN_JUMP | IN_DUCK) {
                    self.state.velocity = [0.0, 0.0, -150.0];
                }
                *last_buttons = self.last_buttons;
            }
            return true;
        }
        if input == "callscriptfunction" && param == "Touch" && self.entities[i].get("vscripts") == Some("bhopblocks_ent.nut") {
            if activator == Actor::Player {
                let time = self.player_time();
                if self.state.ground.is_some() {
                    if let Some(limit) = self.extra.scripts19.ground_limit {
                        if time >= limit {
                            let name = self.ents[i].name.strip_prefix("block_multibhop_").unwrap_or("").to_string();
                            if let Some(dest) = self.find_named(&name) { self.script19_teleport(dest, false); }
                            self.extra.scripts19.ground_limit = None;
                        }
                    } else { self.extra.scripts19.ground_limit = Some(time + 0.15); }
                } else { self.extra.scripts19.ground_limit = None; }
            }
            return true;
        }
        false
    }
    fn treason19_input(&mut self, target: Actor, input: &str, param: &str, activator: Actor, caller: Actor) -> bool {
        let Actor::Entity(i) = target else { return false; };
        if self.ents[i].removed { return false; }
        if input == "runscriptcode" && self.ents[i].name == "antipre" {
            if activator == Actor::Player && caller != Actor::None {
                match param.trim() {
                    "antipre()" => {
                        let [x,y,_] = self.state.velocity;
                        let speed = (x*x+y*y).sqrt();
                        if speed > 400.0 { let scale = 400.0 / speed; self.state.velocity[0] *= scale; self.state.velocity[1] *= scale; }
                    }
                    "plarantiabuse()" => { self.state.velocity[0] = 0.0; self.state.velocity[1] = 0.0; }
                    _ => {}
                }
            }
            return true;
        }
        if input == "runscriptcode" && self.ents[i].name == "bhopblocks" && param.trim() == "BhopblocksResetPlayer()" {
            if activator == Actor::Player { self.extra.scripts19 = State::default(); self.gravity_scale = 1.0; }
            return true;
        }
        if input != "callscriptfunction" || param != "Touch" || self.entities[i].get("vscripts") != Some("bhopblocks_ent.nut") { return false; }
        if activator != Actor::Player { return true; }
        let now = self.player_time();
        let state = &mut self.extra.scripts19;
        let immune = state.processed.get(&i).is_some_and(|time| now - time < 0.33);
        if !immune {
            let name = &self.ents[i].name;
            let mut failed = false;
            if let Some(id) = name.strip_prefix("block_single_").and_then(|id| id.parse::<u32>().ok()) {
                if !state.singles.insert(id) { failed = true; }
                else { state.last_repeat = None; }
            } else if let Some(id) = name.strip_prefix("block_repeatable_").and_then(|id| id.parse::<u32>().ok()) {
                if state.last_repeat == Some(id) { failed = true; }
                else { state.last_repeat = Some(id); }
            } else if name.starts_with("block_multibhop_") { state.last_repeat = None; }
            state.ground_limit = None;
            state.processed.insert(i, now);
            if failed { self.gravity_scale = 50.0; }
        }
        // The script resets the shared ground limit on each non-immune block check, then tests ground.
        if self.state.ground.is_some() {
            if let Some(limit) = state.ground_limit {
                if now >= limit { self.gravity_scale = 50.0; state.ground_limit = None; }
            } else { state.ground_limit = Some(now + 0.1); }
        } else { state.ground_limit = None; }
        true
    }
    fn script19_teleport(&mut self, dest: usize, stop: bool) {
        // SetOrigin/SetAngles, unlike CBaseEntity::Teleport, preserve velocity unless explicitly cleared.
        self.state.position = self.ents[dest].origin;
        self.state.ground = None;
        self.teleport_angles = self.ents[dest].angles;
        self.events |= EVENT_TELEPORTED;
        if stop { self.state.velocity = [0.0; 3]; }
        self.unstick();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn load(map: &str) -> Option<Game> {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../maps/{map}.bsp"));
        if !p.exists() { eprintln!("skip {map}: external BSP absent"); return None; }
        let mut g = crate::content::load_game(&p).unwrap();
        g.set_settings(Settings { physics_version: PHYSICS_V19, ..Settings::css_bhop() }); g.reset(); Some(g)
    }
    fn drain(g: &mut Game) { for _ in 0..12 { g.tick += 1; g.service_events(); } }
    #[test]
    fn player_connections_drive_original_gate_and_keep_snapshot_state() {
        for map in ["bhop_crutle4_css", "bhop_crutle3_css", "bhop_enlightened2", "bhop_balaco", "kz_fastcombowombo"] {
            let Some(mut g) = load(map) else { continue; };
            let items: Vec<_> = g.ents.iter().enumerate().filter(|(_,e)| e.outputs.iter().any(|o| &*o.input == "AddOutput" && o.param.starts_with("OnUser1 ")) && e.class == "trigger_multiple").map(|(i,_)| i).collect();
            assert!(items.len() >= 3, "{map}");
            for &i in &items { g.fire_output(i, "ontrigger", Actor::Player); drain(&mut g); }
            let check = g.find_named("checking_trigger").unwrap(); g.fire_output(check,"ontrigger",Actor::Player); drain(&mut g);
            assert!(g.player_name.ends_with("pass"), "{map}: {}", g.player_name);
            let saved = g.save_state(); let digest = g.snapshot_bytes(); g.reset(); g.restore_state(&saved); assert_eq!(g.snapshot_bytes(), digest);
            for version in 1..=18 {
                g.set_settings(Settings { physics_version: version, ..Settings::css_bhop() }); g.reset();
                assert!(!g.player_io(), "{map} v{version}");
                g.player_input("addoutput", "OnUser1 !activator:AddOutput:targetname wrong:0:1", Actor::Player);
                g.player_input("fireuser1", "", Actor::Player); drain(&mut g); assert_ne!(g.player_name, "wrong");
            }
        }
    }
    #[test]
    fn relative_teleports_use_brush_center_and_zero_velocity_only_in_v19() {
        let Some(mut g) = load("bhop_collective") else { return; };
        let ids: Vec<_> = g.ents.iter().enumerate().filter(|(_,e)| e.class == "trigger_teleport_relative").map(|(i,_)| i).collect();
        assert_eq!(ids.len(), 2);
        for &i in &ids {
            let b = g.ents[i].brush.as_ref().unwrap(); let (lo,hi) = b.world_bounds();
            let center = std::array::from_fn(|k| (lo[k]+hi[k])*0.5);
            let offset = g.entities[i].vec3("teleportoffset").unwrap();
            g.state.position = center; g.state.velocity = [123.0,456.0,78.0]; g.last_angles = [20.0,37.0,0.0];
            g.touch_triggers_at();
            assert_eq!(g.state.position, std::array::from_fn(|k| center[k]+offset[k]));
            assert_eq!(g.state.velocity, [0.0;3]); assert_eq!(g.teleport_angles,[20.0,37.0,0.0]);
        }
        for version in 1..=18 { g.set_settings(Settings { physics_version: version, ..Settings::css_bhop() }); g.reset(); for &i in &ids { assert!(matches!(g.ents[i].data,Data::Other)); } }
    }
    #[test]
    fn kowka_signed_boost_and_conditional_stop_are_exact() {
        let Some(mut g) = load("bhop_api_kowka") else { return; }; let i=g.find_named("boosterscript").unwrap();
        for (y,want) in [(-5.0,-605.0),(0.0,600.0),(5.0,605.0)] {
            g.state.velocity=[12.0,y,7.0];g.entity_input(i,"runscriptcode","PlayerBoost()",Actor::Player);assert_eq!(g.state.velocity,[12.0,want,7.0]);
        }
        g.state.velocity=[12.0,34.0,0.0];g.entity_input(i,"runscriptcode","PlayerStop()",Actor::Player);assert_eq!(g.state.velocity,[12.0,34.0,0.0]);
        g.state.velocity[2]=0.01;g.entity_input(i,"runscriptcode","PlayerStop()",Actor::Player);assert_eq!(g.state.velocity,[0.0;3]);
        for version in 1..=18 { g.set_settings(Settings {physics_version:version,..Settings::css_bhop()});g.state.velocity=[12.0;3];g.entity_input(i,"runscriptcode","PlayerBoost()",Actor::Player);assert_eq!(g.state.velocity,[12.0;3]); }
    }
    #[test]
    fn liminal_checkpoint_uses_caller_and_block_timeout_preserves_velocity() {
        let Some(mut g)=load("kz_bhop_liminal") else{return;}; let script=g.find_named("3wayteleport_entity").unwrap();
        let caller=g.find_named("setcp7").unwrap();
        g.accept_input(Actor::Entity(script),"RunScriptCode","SetCheckpoint()",Actor::Player,Actor::Entity(caller));
        assert_eq!(g.extra.scripts19.checkpoint,Some(7));
        g.state.velocity=[123.0;3];g.accept_input(Actor::Entity(script),"RunScriptCode","OnStartTouch()",Actor::Player,Actor::Entity(caller));
        assert_eq!(g.state.velocity,[0.0;3]);assert_eq!(g.state.position,g.ents[g.find_named("greenstage_7").unwrap()].origin);
        let block=g.find_named("block_multibhop_1_5").unwrap();g.set_position(g.spawn_origin,0.0);
        let ground=Some(movement::GroundState { support:None, normal:[0.0,0.0,1.0], surface_friction:1.0, jump_factor:1.0 }); g.state.ground=ground;
        g.script19_input(Actor::Entity(block),"callscriptfunction","Touch",Actor::Player,Actor::Entity(block));
        let limit=g.extra.scripts19.ground_limit.unwrap();let saved=g.save_state();let bytes=g.snapshot_bytes();
        g.tick+=20;g.state.ground=ground;g.state.velocity=[100.0,200.0,3.0];
        g.script19_input(Actor::Entity(block),"callscriptfunction","Touch",Actor::Player,Actor::Entity(block));
        assert_eq!(g.state.velocity,[100.0,200.0,3.0]); assert_eq!(g.state.position,g.ents[g.find_named("1_5").unwrap()].origin);
        g.restore_state(&saved);assert_eq!(g.snapshot_bytes(),bytes);assert_eq!(g.extra.scripts19.ground_limit,Some(limit));
        let anti=g.find_named("anticjscript").unwrap();let trigger=g.entities.iter().position(|e| e.get("vscripts")==Some("anticj.nut") && e.classname()=="trigger_multiple").unwrap();
        g.script19_input(Actor::Entity(anti),"runscriptcode","OnStartTouch()",Actor::Player,Actor::Entity(trigger));
        g.state.ground=None;g.last_buttons=IN_JUMP|IN_DUCK;g.state.velocity=[99.0;3];
        g.script19_input(Actor::Entity(trigger),"callscriptfunction","ThinkLoop",Actor::Player,Actor::Entity(trigger));assert_eq!(g.state.velocity,[0.0,0.0,-150.0]);
        g.state.velocity=[99.0;3];g.script19_input(Actor::Entity(trigger),"callscriptfunction","ThinkLoop",Actor::Player,Actor::Entity(trigger));assert_eq!(g.state.velocity,[99.0;3],"edge only");
        for version in 1..=18 {g.set_settings(Settings{physics_version:version,..Settings::css_bhop()});g.reset();assert!(!g.script19_input(Actor::Entity(script),"runscriptcode","SetCheckpoint()",Actor::Player,Actor::Entity(caller)));assert!(g.extra.scripts19.checkpoint.is_none());}
    }
    #[test]
    fn treason_immunity_single_repeatable_reset_and_antipre() {
        let Some(mut g)=load("bhop_treason") else{return;};let block=g.ents.iter().position(|e|e.name.starts_with("block_single_")).unwrap();
        let touch=|g:&mut Game,i|{g.script19_input(Actor::Entity(i),"callscriptfunction","Touch",Actor::Player,Actor::Entity(i));};
        g.state.ground=None;touch(&mut g,block);assert_eq!(g.gravity_scale,1.0);g.tick+=20;touch(&mut g,block);assert_eq!(g.gravity_scale,1.0,"0.33s immunity");g.tick+=20;touch(&mut g,block);assert_eq!(g.gravity_scale,50.0);
        let reset=g.find_named("bhopblocks").unwrap();g.script19_input(Actor::Entity(reset),"runscriptcode","BhopblocksResetPlayer()",Actor::Player,Actor::Entity(block));assert_eq!(g.gravity_scale,1.0);assert!(g.extra.scripts19.singles.is_empty());
        let repeat=g.ents.iter().position(|e|e.name.starts_with("block_repeatable_")).unwrap();touch(&mut g,repeat);g.tick+=40;touch(&mut g,repeat);assert_eq!(g.gravity_scale,50.0);
        let anti=g.find_named("antipre").unwrap();g.state.velocity=[300.0,400.0,17.0];g.script19_input(Actor::Entity(anti),"runscriptcode","antipre()",Actor::Player,Actor::Entity(block));assert_eq!(g.state.velocity,[240.0,320.0,17.0]);
        let saved=g.save_state();let digest=g.snapshot_bytes();g.reset();g.restore_state(&saved);assert_eq!(g.snapshot_bytes(),digest);
        for version in 1..=18 {g.set_settings(Settings{physics_version:version,..Settings::css_bhop()});g.reset();g.state.velocity=[300.0,400.0,17.0];assert!(!g.script19_input(Actor::Entity(anti),"runscriptcode","antipre()",Actor::Player,Actor::Entity(block)));assert_eq!(g.state.velocity,[300.0,400.0,17.0]);}
    }
}
