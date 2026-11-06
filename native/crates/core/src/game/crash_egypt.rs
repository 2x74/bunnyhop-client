//! Regression fixtures for the exact Crash Egypt v26 build. No new generic movement policy.
#[cfg(test)]
mod tests {
    use super::super::*;
    fn load(version: u32) -> Game {
        let raw = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../maps/bhop_crash_egypt.bsp"
        ))
        .expect("required Crash Egypt BSP");
        let b = crate::parse_bsp(&raw).unwrap();
        let mut g = Game::load(&b).unwrap();
        g.set_settings(Settings {
            physics_version: version,
            ..Settings::css_bhop()
        });
        g.reset();
        g
    }
    fn ticks(g: &mut Game, n: usize) {
        for _ in 0..n {
            g.step(Cmd::default()).unwrap();
        }
    }
    fn counter(g: &Game) -> f32 {
        let Data::Counter { value, .. } = g.ents[935].data else {
            panic!()
        };
        value
    }
    #[test]
    fn health_zero_physbox_weapon_hit_runs_its_authored_kill_chain() {
        let mut g = load(26);
        ticks(&mut g, 100);
        g.place_player([148.0, 1408.0, -288.0]);
        g.step(Cmd {
            yaw: 180.0,
            pitch: 43.0,
            buttons: IN_ATTACK,
            ..Cmd::default()
        })
        .unwrap();
        assert_eq!(g.attack.map(|a| a.entity), Some(967));
        ticks(&mut g, 70);
        assert!(g.ents[967].removed);
        assert!(!g.entity_visible(968));
        assert!(g.entity_instances().any(|(_, source, ..)| source == 958));
    }
    #[test]
    fn nitro_timers_use_authored_random_intervals_and_restore_deterministically() {
        let mut g = load(26);
        ticks(&mut g, 1);
        let next: Vec<_> = g
            .timers
            .iter()
            .map(|&i| {
                let Data::Timer { next_tick, .. } = g.ents[i].data else {
                    panic!()
                };
                let lo = g.entities[i].float("LowerRandomBound").unwrap();
                let hi = g.entities[i].float("UpperRandomBound").unwrap();
                assert!(
                    next_tick as f32 * g.settings.tick_interval >= lo - g.settings.tick_interval
                );
                assert!(
                    next_tick as f32 * g.settings.tick_interval <= hi + g.settings.tick_interval
                );
                next_tick
            })
            .collect();
        assert_eq!(next.len(), 40);
        assert!(next.windows(2).any(|n| n[0] != n[1]));
        assert!(
            g.map_sound_states()
                .filter(|(a, _)| (706..=839).contains(&a.ent))
                .all(|(a, _)| a.starts == 0)
        );
        let snap = g.save_state();
        ticks(&mut g, 1200);
        let state = g.snapshot_bytes();
        g.restore_state(&snap);
        ticks(&mut g, 1200);
        assert_eq!(g.snapshot_bytes(), state);
        g.set_settings(Settings {
            physics_version: 25,
            ..Settings::css_bhop()
        });
        g.reset();
        ticks(&mut g, 1);
        assert!(
            g.timers
                .iter()
                .all(|&i| matches!(g.ents[i].data, Data::Timer { next_tick: 100, .. }))
        );
    }
    #[test]
    fn normal_fruit_disappears_counts_once_and_plays_at_pickup() {
        let mut g = load(26);
        assert_eq!(counter(&g), 50.0);
        assert!(g.ents[935].outputs.is_empty());
        g.place_player([0.0, 1632.0, -286.0]);
        ticks(&mut g, 12);
        assert!(!g.entity_visible(1047));
        assert_eq!(counter(&g), 51.0);
        let sounds: Vec<_> = g
            .entity_instances()
            .filter(|(_, s, ..)| *s == 1045)
            .collect();
        assert_eq!(sounds.len(), 1);
        assert!((sounds[0].2[1] - 1648.0).abs() < 1.0);
        assert!(
            g.map_sound_states()
                .any(|(a, removed)| a.ent as usize == sounds[0].0 && !removed && a.starts == 1)
        );
        ticks(&mut g, 20);
        assert_eq!(counter(&g), 51.0);
    }
    #[test]
    fn crate_touch_removes_collision_and_visual_and_requests_an_ordinary_jump() {
        let mut g = load(26);
        assert!(g.entity_visible(968));
        assert!(g.ents[967].solid);
        g.place_player([96.0, 1408.0, -255.0]);
        ticks(&mut g, 10);
        assert!(g.extra.map_jump);
        ticks(&mut g, 65);
        assert!(g.ents[967].removed);
        assert!(!g.entity_visible(968));
        assert!(g.prop_anims.contains(968));
        assert!(g.entity_instances().any(|(_, source, ..)| source == 965));
        assert!(g.entity_instances().any(|(_, source, ..)| source == 958));
        assert!(!g.extra.map_jump); // paired -jump, not an enduring boost
    }
    #[test]
    fn spawned_fruit_is_collectible_and_its_siblings_keep_distinct_names() {
        let mut g = load(26);
        g.place_player([0.0, 1408.0, -180.0]);
        g.fire_input(
            "fruit_?_spawn_maker",
            "forcespawnatentityorigin",
            "!activator",
        );
        let fruit: Vec<_> = g
            .entity_instances()
            .filter(|(_, s, ..)| g.entities[*s].classname() == "prop_dynamic")
            .collect();
        assert_eq!(fruit.len(), 5);
        let names: std::collections::HashSet<_> = fruit
            .iter()
            .map(|(i, ..)| g.ents[*i].name.clone())
            .collect();
        assert_eq!(names.len(), 5);
        let trigger = g.entity_instances().find(|(_, s, ..)| *s == 925).unwrap().0;
        let (lo, hi) = g.entity_bounds(trigger).unwrap();
        g.place_player([(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5, lo[2]]);
        ticks(&mut g, 12);
        assert!(counter(&g) > 50.0);
        assert!(fruit.iter().any(|(i, ..)| g.ents[*i].removed));
    }
    #[test]
    fn damage_maker_uses_output_caller_instead_of_makers_storage_room() {
        let mut g = load(26);
        let pose = g.ents[967].origin;
        g.accept_input(
            Actor::Entity(959),
            "forcespawnatentityorigin",
            "!caller",
            Actor::Player,
            Actor::Entity(967),
        );
        let instance = g.entity_instances().find(|(_, s, ..)| *s == 958).unwrap();
        // The template member is 32 units right of its template origin.
        assert!((instance.2[0] - pose[0]).abs() < 40.0);
        assert!((instance.2[1] - pose[1] - 16.0).abs() < 1.0);
    }
    #[test]
    fn instances_and_sound_channels_restore_reset_and_reuse() {
        let mut g = load(26);
        g.place_player([0.0, 1632.0, -286.0]);
        ticks(&mut g, 12);
        let snap = g.save_state();
        let count = g.entity_instances().count();
        let states: Vec<_> = g
            .map_sound_states()
            .map(|(s, r)| (s.ent, s.starts, r))
            .collect();
        ticks(&mut g, 200);
        g.restore_state(&snap);
        assert_eq!(g.entity_instances().count(), count);
        assert_eq!(
            g.map_sound_states()
                .map(|(s, r)| (s.ent, s.starts, r))
                .collect::<Vec<_>>(),
            states
        );
        g.reset();
        assert_eq!(g.entity_instances().count(), 0);
        assert_eq!(counter(&g), 50.0);
        assert!(g.entity_visible(1047));
        for _ in 0..3 {
            g.fire_input(
                "fruit_normal_sound_maker",
                "forcespawnatentityorigin",
                "!activator",
            );
            ticks(&mut g, 200);
        }
        assert!(
            g.entity_instances().count() <= 2,
            "dead sound slots are reusable"
        );
    }
    #[test]
    fn every_legacy_version_keeps_makers_and_jump_commands_inert() {
        let mut g = load(26);
        for version in 1..=25 {
            g.set_settings(Settings {
                physics_version: version,
                ..Settings::css_bhop()
            });
            g.reset();
            g.fire_input("sound_maker_generic", "forcespawn", " ");
            g.fire_input("Force Jump", "command", "+jump");
            assert_eq!(g.entity_instances().count(), 0, "v{version}");
            assert!(!g.extra.map_jump, "v{version}");
        }
    }
    #[test]
    fn jump_latch_is_saved_released_and_cleared_by_respawn() {
        let mut g = load(26);
        g.fire_input("Force Jump", "command", "+jump");
        assert!(g.extra.map_jump);
        let s = g.save_state();
        g.fire_input("Force Jump", "command", "-jump");
        assert!(!g.extra.map_jump);
        g.restore_state(&s);
        assert!(g.extra.map_jump);
        g.respawn_player();
        assert!(!g.extra.map_jump);
        g.fire_input("Force Jump", "command", "+jump;anything");
        assert!(!g.extra.map_jump);
    }
}
