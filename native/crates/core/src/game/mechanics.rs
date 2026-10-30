//! Reviewed v19 equivalents, never active under historical versions or on unlisted entity builds.
//! SDK references and supported subsets: research/MAP-MECHANICS-V19.md.
use super::*;

impl Game {
    pub(super) fn mechanics_on(&self) -> bool {
        (PHYSICS_V19..=PHYSICS_LATEST).contains(&self.settings.physics_version) && self.map_mechanics.is_some()
    }

    /// CEventAction's constructor maps a map-file fire count of zero to EVENT_FIRE_ALWAYS.
    /// Preserve the historical parser for v1..18. Ceaseless uses zero on every velocity-script connection.
    pub(super) fn initialize_velocity_scripts(&mut self) {
        if !self.mechanics_on() || !self.map_mechanics.is_some_and(|m| m.velocity_scripts || m.player_io()) {
            return;
        }
        for e in &mut self.ents {
            for o in std::sync::Arc::make_mut(&mut e.outputs) {
                if o.times == 0 {
                    o.times = -1;
                }
            }
        }
    }

    pub(super) fn mechanics_input(
        &mut self,
        i: usize,
        input: &str,
        param: &str,
        activator: Actor,
    ) -> bool {
        if !self.mechanics_on() {
            return false;
        }
        let m = self.map_mechanics.unwrap();
        // No script file exists in either original BSP or stock CS:S for these references.
        // Match only the reviewed undefined call; never infer what a missing script might have done.
        if input == "runscriptcode" && param.trim() == "MessageStart()"
            && self.ents[i].class == "logic_script"
            && matches!((m.map, self.ents[i].name.as_str()), ("bhop_k2", "say") | ("bhop_k3", "twitch"))
        {
            return true;
        }
        if m.map == "bhop_api_kowka" && self.ents[i].class == "logic_script"
            && self.ents[i].name == "boosterscript" && input == "runscriptcode" {
            if activator == Actor::Player {
                match param.trim() {
                    "PlayerBoost()" => self.state.velocity[1] += if self.state.velocity[1] < 0.0 { -600.0 } else { 600.0 },
                    "PlayerStop()" if self.state.velocity[2] != 0.0 => self.state.velocity = [0.0; 3],
                    _ => {}
                }
            }
            return true;
        }
        if m.velocity_scripts
            && self.ents[i].class == "logic_script"
            && self.ents[i].name == "vscript"
            && input == "runscriptcode"
        {
            if activator == Actor::Player {
                match param.trim() {
                    "SpeedReset()" => self.state.velocity = [0.0; 3],
                    "Boost(500)" => {
                        let [x, y, _] = self.state.velocity;
                        let length = (x * x + y * y).sqrt();
                        if length > 0.01 {
                            // Squirrel Vector.Norm then Vector(x + dir.x * amount, ...).
                            self.state.velocity[0] = x + (x / length) * 500.0;
                            self.state.velocity[1] = y + (y / length) * 500.0;
                        }
                    }
                    _ => {} // No eval, prefix matching, or general script execution.
                }
            }
            return true;
        }
        if m.makers && self.ents[i].class == "env_entity_maker" {
            match input {
                "forcespawn" => {
                    self.maker_spawn(i, self.ents[i].origin, self.ents[i].angles);
                    return true;
                }
                "forcespawnatentityorigin" => {
                    if let Some(target) = self
                        .resolve_targets(param, activator, Actor::Entity(i))
                        .first()
                        .copied()
                    {
                        let transform = match target {
                            Actor::Player => {
                                Some((self.state.position, [0.0, self.last_angles[1], 0.0]))
                            }
                            Actor::Entity(j) => Some((self.ents[j].origin, self.ents[j].angles)),
                            Actor::None => None,
                        };
                        if let Some((origin, angles)) = transform {
                            self.maker_spawn(i, origin, angles);
                        }
                    }
                    return true;
                }
                _ => {}
            }
        }
        false
    }

    /// CEnvEntityMaker::SpawnEntity -> CPointTemplate::CreateInstance. Multiple instances coexist.
    /// Subset: explicit inputs, no automatic respawn / room / facing tests, no post-spawn launch.
    /// Reviewed templates contain triggers, breakable brushes, zero-travel slide stoppers, weapons and cosmetics.
    fn maker_spawn(&mut self, maker: usize, origin: [f32; 3], angles: [f32; 3]) {
        let e = &self.entities[maker];
        if e.int("spawnflags") != 0 || e.float("PostSpawnSpeed").unwrap_or(0.0) != 0.0 {
            return;
        }
        let Some(name) = e.get("EntityTemplate") else {
            return;
        };
        let Some(template) = self
            .templates
            .iter()
            .find(|t| self.ents[t.ent].name.eq_ignore_ascii_case(name))
            .cloned()
        else {
            return;
        };
        let base = Transform {
            origin: self.entities[template.ent].origin(),
            angles: self.entities[template.ent].angles(),
        };
        let at = Transform { origin, angles };
        let fixup = self.entities[template.ent].int("spawnflags") & 2 == 0;
        self.extra.template_instances += 1;
        let mut members = Vec::new();
        let mut renames = Vec::new();
        for &source in &template.members {
            let mut fresh = self.initial_ents[source].clone();
            let Ok(local) = (Transform {
                origin: fresh.origin,
                angles: fresh.angles,
            })
            .relative_to(base) else {
                return;
            };
            let Ok(placed) = at.compose(local) else {
                return;
            };
            fresh.origin = placed.origin;
            fresh.angles = placed.angles;
            fresh.local_origin = placed.origin;
            fresh.local_angles = placed.angles;
            fresh.parent = None;
            fresh.children.clear();
            fresh.removed = false;
            if fixup && template.fixup.contains(&source) && !fresh.name.is_empty() {
                let new = format!("{}&{:04}", fresh.name, self.extra.template_instances);
                renames.push((fresh.name.clone(), new.clone()));
                fresh.name = new;
            }
            if let Some(b) = &mut fresh.brush {
                b.origin = placed.origin;
                b.base_origin = placed.origin;
                b.angles = placed.angles;
            }
            // Rebuild the mover at its new spawn origin, not with the template's absolute endpoints.
            let mut definition = self.entities[source].clone();
            definition.pairs.retain(|(k, _)| {
                !k.eq_ignore_ascii_case("origin") && !k.eq_ignore_ascii_case("angles")
            });
            definition.pairs.push((
                "origin".into(),
                placed.origin.map(|v| v.to_string()).join(" "),
            ));
            definition.pairs.push((
                "angles".into(),
                placed.angles.map(|v| v.to_string()).join(" "),
            ));
            if let Some((data, solid)) = kin::build(
                &fresh.class,
                &definition,
                fresh.brush.as_ref(),
                self.settings.tick_interval,
            ) {
                fresh.data = data;
                fresh.solid = solid;
            }
            // Reuse a dead instance only when no queued event retains its identity. IDs held by old callbacks
            // must never name a newly spawned teleporter (Source EHANDLE generation semantics).
            let slot = (self.initial_ents.len()..self.ents.len()).find(|&j| {
                self.ents[j].removed
                    && !self
                        .queue
                        .iter()
                        .any(|q| q.caller == Actor::Entity(j) || q.activator == Actor::Entity(j))
            });
            let i = if let Some(j) = slot {
                self.extra.instance_sources[j - self.initial_ents.len()] = source;
                self.ents[j] = fresh;
                self.entities[j] = self.entities[source].clone();
                self.extra.breakable_health.remove(&j);
                self.extra.pressure_breaks.remove(&j);
                self.arms.floor_silenced.retain(|&i| i != j);
                if self.arms.drop_block.is_some_and(|(i, _)| i == j) {
                    self.arms.drop_block = None;
                }
                j
            } else {
                let j = self.ents.len();
                self.ents.push(fresh);
                self.entities.push(self.entities[source].clone());
                self.extra.instance_sources.push(source);
                j
            };
            members.push(i);
        }
        for &i in &members {
            for o in std::sync::Arc::make_mut(&mut self.ents[i].outputs) {
                if let Some((_, new)) = renames
                    .iter()
                    .find(|(old, _)| old.eq_ignore_ascii_case(&o.target))
                {
                    o.target = std::sync::Arc::from(new.as_str());
                }
            }
        }
        self.reindex_instances();
        self.rebuild_solid();
        // Maker output activator/caller = maker; point_template OnEntitySpawned is only for its own ForceSpawn.
        self.fire_output(maker, "onentityspawned", Actor::Entity(maker));
    }

    /// Runtime indices are derived, including after keyframe restore and reset. Original order is preserved.
    pub(super) fn reindex_instances(&mut self) {
        self.triggers.clear();
        self.movers.clear();
        self.timers.clear();
        self.kins.clear();
        self.water.clear();
        self.weapon_ents.clear();
        for (i, e) in self.ents.iter().enumerate() {
            match e.data {
                Data::Trigger(_) => self.triggers.push(i),
                Data::Mover(_) => self.movers.push(i),
                Data::Timer { .. } => self.timers.push(i),
                Data::Kin(_) => self.kins.push(i),
                _ => {}
            }
            if e.class == "func_water_analog" && e.brush.is_some() {
                self.water.push(i);
            }
            if let Some(id) = weapons::weapon_id(&e.class) {
                self.weapon_ents.push((i, id));
            }
        }
        self.floor_seen
            .resize(self.weapon_ents.len(), weapons::FloorSeen::default());
        self.near.clear();
        self.near_region = None;
    }

    pub(super) fn restore_instance_sources(&mut self) {
        self.entities.truncate(self.initial_ents.len());
        for &i in &self.extra.instance_sources {
            self.entities.push(self.entities[i].clone());
        }
        self.reindex_instances();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn load(map: &str, version: u32) -> Option<Game> {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../maps/{map}.bsp"));
        if !path.exists() {
            eprintln!("skip {map}: BSP absent");
            return None;
        }
        let mut game = crate::content::load_game(&path).unwrap();
        game.set_settings(Settings {
            physics_version: version,
            ..Settings::css_bhop()
        });
        game.reset();
        Some(game)
    }
    #[test]
    fn reviewed_builds_match_in_full_and_verifier_loaders() {
        for m in map_fixes::MECHANICS_V19 {
            let Some(game) = load(m.map, PHYSICS_V19) else {
                continue;
            };
            assert_eq!(
                game.map_mechanics.map(|m| m.map),
                Some(m.map),
                "{} fingerprint",
                m.map
            );
            let mut entities = game.entities.clone();
            for e in &mut entities {
                e.pairs.retain(|(k, v)| Output::parse(k, v).is_none());
            }
            assert_eq!(
                map_fixes::mechanics_v19(&entities).map(|m| m.map),
                Some(m.map)
            );
            entities[0]
                .pairs
                .push(("mapversion".into(), "changed".into()));
            assert!(
                map_fixes::mechanics_v19(&entities).is_none(),
                "changed entity builds don't match"
            );
        }
    }
    #[test]
    fn v20_inherits_v19_mechanics_and_keeps_instances_when_switching_versions() {
        if let Some(mut game) = load("bhop_ceaseless", PHYSICS_V18) {
            // Crossing the v19 boundary must reinitialize zero-count outputs and scoped scripts.
            game.set_settings(Settings { physics_version: PHYSICS_V20, ..Settings::css_bhop() });
            let script = game.find_named("vscript").unwrap();
            game.state.velocity = [300.0, 400.0, 123.0];
            game.entity_input(script, "runscriptcode", "Boost(500)", Actor::Player);
            assert_eq!(game.state.velocity, [600.0, 800.0, 123.0]);
            assert!(game.ents.iter().flat_map(|e| e.outputs.iter()).all(|o| o.times != 0));
        }
        for map in ["bhop_cutekittenz2", "bhop_vandora", "bhop_ponpon_fix"] {
            let Some(mut game) = load(map, PHYSICS_V19) else { continue; };
            let maker = game.find_named("teleport_maker_1").unwrap();
            let base = game.ents.len();
            game.place_player([1000.0, 1000.0, 1000.0]);
            game.entity_input(maker, "forcespawnatentityorigin", "!activator", Actor::Player);
            assert_eq!(game.ents.len(), base + 1);
            game.set_settings(Settings { physics_version: PHYSICS_V20, ..Settings::css_bhop() });
            assert_eq!(game.ents.len(), base + 1, "v19 -> v20 must preserve the active instance");
            game.entity_input(maker, "forcespawnatentityorigin", "!activator", Actor::Player);
            assert_eq!(game.ents.len(), base + 2, "v20 keeps makers enabled");
            game.set_settings(Settings { physics_version: PHYSICS_V18, ..Settings::css_bhop() });
            assert_eq!(game.ents.len(), base, "v20 -> v18 restores historical spawn state");
        }
        for map in ["bhop_profane", "bhop_playboy_csgo", "bhop_api_kowka", "kz_bhop_liminal", "bhop_treason"] {
            let Some(game) = load(map, PHYSICS_V20) else { continue; };
            assert!(game.mechanics_on(), "{map} keeps its reviewed mechanics in v20");
        }
    }
    #[test]
    fn missing_message_scripts_are_explicit_noops_only_on_reviewed_v19_builds() {
        for (map, target) in [("bhop_k2", "say"), ("bhop_k3", "twitch")] {
            let Some(mut g) = load(map, PHYSICS_V19) else { continue; };
            let i = g.find_named(target).unwrap();
            g.state.velocity = [123.0, -456.0, 78.0];
            assert!(g.mechanics_input(i, "runscriptcode", "MessageStart()", Actor::None));
            assert_eq!(g.state.velocity, [123.0, -456.0, 78.0]);
            assert!(!g.mechanics_input(i, "runscriptcode", "SpeedReset()", Actor::Player));
            g.set_settings(Settings { physics_version: PHYSICS_V18, ..Settings::css_bhop() });
            assert!(!g.mechanics_input(i, "runscriptcode", "MessageStart()", Actor::None));
        }
    }
    #[test]
    fn ceaseless_scripts_are_exact_and_versioned() {
        let Some(mut game) = load("bhop_ceaseless", PHYSICS_V19) else {
            return;
        };
        let i = game.find_named("vscript").unwrap();
        game.state.velocity = [300.0, 400.0, 123.0];
        game.entity_input(i, "runscriptcode", "Boost(500)", Actor::Player);
        assert_eq!(game.state.velocity, [600.0, 800.0, 123.0]);
        for v in [[0.0, 0.0, 456.0], [0.01, 0.0, -100.0]] {
            game.state.velocity = v;
            game.entity_input(i, "runscriptcode", "Boost(500)", Actor::Player);
            assert_eq!(game.state.velocity, v);
        }
        game.entity_input(i, "runscriptcode", "SpeedReset()", Actor::Player);
        assert_eq!(game.state.velocity, [0.0; 3]);
        game.state.velocity = [50.0; 3];
        game.entity_input(i, "runscriptcode", "SpeedReset(); other()", Actor::Player);
        assert_eq!(game.state.velocity, [50.0; 3]);
        game.entity_input(i, "runscriptcode", "SpeedReset()", Actor::None);
        assert_eq!(game.state.velocity, [50.0; 3]);
        for version in PHYSICS_V1..=PHYSICS_V18 {
            game.set_settings(Settings {
                physics_version: version,
                ..Settings::css_bhop()
            });
            game.reset();
            game.state.velocity = [50.0; 3];
            game.entity_input(i, "runscriptcode", "SpeedReset()", Actor::Player);
            assert_eq!(game.state.velocity, [50.0; 3], "v{version}");
        }
    }
    #[test]
    fn ceaseless_zero_count_outputs_reset_every_time() {
        let Some(mut game) = load("bhop_ceaseless", PHYSICS_V19) else {
            return;
        };
        let i = game
            .ents
            .iter()
            .position(|e| {
                e.outputs
                    .iter()
                    .any(|o| &*o.input == "RunScriptCode" && &*o.param == "SpeedReset()")
            })
            .unwrap();
        for _ in 0..2 {
            game.state.velocity = [100.0; 3];
            game.fire_output(i, "onstarttouch", Actor::Player);
            for _ in 0..12 {
                game.step(Cmd {
                    forward: 0.0,
                    side: 0.0,
                    yaw: 0.0,
                    pitch: 0.0,
                    buttons: 0,
                })
                .unwrap();
            }
            // Gravity resumes after the reset; X/Y must have been reset by the event queue.
            assert_eq!(game.state.velocity[0], 0.0);
            assert_eq!(game.state.velocity[1], 0.0);
        }
    }
    #[test]
    fn maker_instances_coexist_transform_filter_expire_and_restore() {
        for map in ["bhop_cutekittenz2", "bhop_vandora", "bhop_ponpon_fix"] {
            let Some(mut game) = load(map, PHYSICS_V19) else {
                continue;
            };
            let maker = game.find_named("teleport_maker_1").unwrap();
            let base = game.ents.len();
            game.place_player([1000.0, 1000.0, 1000.0]);
            game.entity_input(
                maker,
                "forcespawnatentityorigin",
                "!activator",
                Actor::Player,
            );
            assert_eq!(game.ents.len(), base + 1, "{map}");
            let first = game.ents[base].clone();
            assert_eq!(
                first.origin,
                [1000.0, 1000.0, 983.0],
                "template offset preserved"
            );
            game.place_player([2000.0, 2000.0, 1000.0]);
            game.entity_input(
                maker,
                "forcespawnatentityorigin",
                "!activator",
                Actor::Player,
            );
            assert_eq!(game.ents.len(), base + 2);
            assert_eq!(
                game.ents[base].origin, first.origin,
                "earlier instance stays put"
            );
            assert_eq!(
                game.ents[base].name,
                game.ents[base + 1].name,
                "SDK preserves names without internal references"
            );
            let snap = game.save_state();
            let digest = game.snapshot_bytes();
            let mut fresh = load(map, PHYSICS_V19).unwrap();
            fresh.restore_state(&snap);
            assert_eq!(fresh.snapshot_bytes(), digest, "fresh-instance restore");
            game.reset();
            assert_eq!(game.ents.len(), base);
            game.restore_state(&snap);
            assert_eq!(game.snapshot_bytes(), digest);
            assert!(game.triggers.contains(&base) && game.triggers.contains(&(base + 1)));
            // The maker's FireUser1 wildcard output schedules both clones' self-kills after 4 seconds.
            for _ in 0..430 {
                game.step(Cmd {
                    forward: 0.0,
                    side: 0.0,
                    yaw: 0.0,
                    pitch: 0.0,
                    buttons: 0,
                })
                .unwrap();
            }
            assert!(
                game.ents[base].removed && game.ents[base + 1].removed,
                "expiry on each instance"
            );
            game.set_settings(Settings {
                physics_version: PHYSICS_V18,
                ..Settings::css_bhop()
            });
            game.reset();
            game.entity_input(
                maker,
                "forcespawnatentityorigin",
                "!activator",
                Actor::Player,
            );
            assert_eq!(game.ents.len(), base, "v18 inert");
        }
    }
}
