use bunnyhop_core::{Cmd, Game, Settings};

fn load() -> Option<Game> {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../maps/bhop_areaportal_v1.bsp");
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping areaportal: {} missing", path.display());
        return None;
    };
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    Some(
        Game::load_with_content(&bsp, bunnyhop_core::content::cached_physics_content(&path))
            .unwrap(),
    )
}

#[test]
fn red_train_preserves_riders_through_both_turns_only_at_v19() {
    let Some(mut game) = load() else { return };
    let train = game
        .entities
        .iter()
        .position(|e| e.get("targetname") == Some("rede3da"))
        .unwrap();
    assert_eq!(
        bunnyhop_core::game::map_mechanics_v19_for(&game.entities),
        Some("bhop_areaportal_v1")
    );
    let mut altered = game.entities.clone();
    altered[train]
        .pairs
        .push(("review_mutation".into(), "1".into()));
    assert_eq!(bunnyhop_core::game::map_mechanics_v19_for(&altered), None);
    // The same loaded game switches back out of v19; no edited state may leak into historical replays.
    for version in [18, 19, 18, 19] {
        for offset in [[0.0, 0.0], [40.0, 25.0], [-40.0, -25.0], [20.0, -25.0]] {
            game.set_settings(Settings {
                physics_version: version,
                ..Settings::css_bhop()
            });
            game.reset();
            for _ in 0..60 {
                game.step(Cmd::default()).unwrap();
            }
            let c = game.entity_transform(train).unwrap().0;
            game.place_player([c[0] + offset[0], c[1] + offset[1], c[2] + 10.5]);
            game.state.velocity = [0.0, 1000.0, 0.0];
            let mut max_offset = 0.0_f32;
            let mut angle = 0.0_f32;
            let mut last = c[1];
            let mut dir = 1.0_f32;
            let mut turns = 0;
            for _ in 0..650 {
                game.step(Cmd {
                    yaw: 37.0,
                    ..Cmd::default()
                })
                .unwrap();
                let (c, _) = game.entity_transform(train).unwrap();
                max_offset = max_offset.max((game.state.position[1] - c[1]).abs());
                angle += game.view_angle_change[1].abs();
                let dy = c[1] - last;
                if dy * dir < 0.0 {
                    dir = -dir;
                    turns += 1;
                }
                if version == 19 {
                    assert_eq!(game.view_angle_change, [0.0; 3]);
                    assert!((game.state.position[0] - c[0] - offset[0]).abs() < 0.001);
                    assert!((game.state.position[1] - c[1] - offset[1]).abs() < 4.0);
                    assert!(
                        game.state.position[2] > c[2] + 9.0 && game.state.position[2] < c[2] + 11.0
                    );
                    assert!(
                        game.state
                            .ground
                            .and_then(|g| g.support)
                            .is_some_and(|s| (s & 0xff_ffff_ffff) as usize == train)
                    );
                    assert!(game.events & 1 == 0, "no fall/teleport");
                }
                last = c[1];
            }
            assert_eq!(turns, 2);
            if version == 19 {
                assert_eq!(angle, 0.0);
                assert!(max_offset < 30.0);
            } else {
                assert!(
                    angle >= 180.0,
                    "historical rider is turned (and may be thrown off)"
                );
            }
        }
    }
}

#[test]
fn other_areaportal_movers_keep_their_authored_motion() {
    let Some(mut before) = load() else { return };
    let Some(mut after) = load() else { return };
    before.set_settings(Settings {
        physics_version: 18,
        ..Settings::css_bhop()
    });
    after.set_settings(Settings {
        physics_version: 19,
        ..Settings::css_bhop()
    });
    let others: Vec<_> = before
        .entities
        .iter()
        .enumerate()
        .filter(|(_, e)| {
            e.classname() == "func_rotating" || e.get("targetname") == Some("gamstvonorm")
        })
        .map(|(i, _)| i)
        .collect();
    assert_eq!(others.len(), 16);
    let green = before
        .entities
        .iter()
        .position(|e| e.get("targetname") == Some("gamstvonorm"))
        .unwrap();
    let mut green_yaw = std::collections::BTreeSet::new();
    for _ in 0..900 {
        before.step(Cmd::default()).unwrap();
        after.step(Cmd::default()).unwrap();
        for &i in &others {
            assert_eq!(before.entity_transform(i), after.entity_transform(i));
        }
        green_yaw.insert(before.entity_transform(green).unwrap().1[1].to_bits());
    }
    assert!(
        green_yaw.len() > 1,
        "the green train's authored turn is still present"
    );
}

#[test]
fn entity_edit_matches_full_and_verifier_entities_but_rejects_an_altered_build() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../maps/bhop_areaportal_v1.bsp");
    let Ok(bytes) = std::fs::read(&path) else {
        return;
    };
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    for (keep_outputs, altered) in [(true, false), (false, false), (false, true)] {
        let mut list = bunnyhop_core::physics::entity_list_with_outputs(&bsp, keep_outputs);
        if altered {
            list.entities[0]
                .pairs
                .push(("review_mutation".into(), "1".into()));
        }
        let mut game = Game::load_with_entities(
            &bsp,
            bunnyhop_core::content::cached_physics_content(&path),
            list,
            false,
        )
        .unwrap();
        game.set_settings(Settings {
            physics_version: 19,
            ..Settings::css_bhop()
        });
        let train = game
            .entities
            .iter()
            .position(|e| e.get("targetname") == Some("rede3da"))
            .unwrap();
        for _ in 0..300 {
            game.step(Cmd::default()).unwrap();
        }
        assert_eq!(
            game.entity_transform(train).unwrap().1[1],
            if altered { 270.0 } else { 90.0 }
        );
        // The source entity lump stays original; only reset's versioned runtime state is edited.
        assert_eq!(game.entities[train].get("orientationtype"), Some("1"));
    }
}

#[test]
fn rider_can_jump_off_after_the_turn_with_train_speed() {
    let Some(mut game) = load() else { return };
    game.set_settings(Settings {
        physics_version: 19,
        ..Settings::css_bhop()
    });
    let train = game
        .entities
        .iter()
        .position(|e| e.get("targetname") == Some("rede3da"))
        .unwrap();
    for _ in 0..60 {
        game.step(Cmd::default()).unwrap();
    }
    let c = game.entity_transform(train).unwrap().0;
    game.set_position([c[0], c[1], c[2] + 10.5], 270.0);
    game.state.velocity = [0.0, 1000.0, 0.0];
    for _ in 0..280 {
        game.step(Cmd::default()).unwrap();
    }
    let before_jump = game.state.position;
    game.step(Cmd {
        forward: 450.0,
        yaw: 270.0,
        buttons: 2,
        ..Cmd::default()
    })
    .unwrap();
    assert!(game.state.ground.is_none());
    assert!(game.state.position[1] - before_jump[1] < -9.0);
    // Source retains ground base velocity during the jump step, then converts it to velocity next tick.
    game.step(Cmd {
        forward: 450.0,
        yaw: 270.0,
        buttons: 2,
        ..Cmd::default()
    })
    .unwrap();
    assert!(game.state.velocity[1] < -900.0 && game.state.velocity[2] > 250.0);
    assert_eq!(game.view_angle_change, [0.0; 3]);
}
