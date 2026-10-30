use bunnyhop_core::{Cmd, Game, Settings};
fn load(name: &str, version: u32) -> Option<Game> {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../maps")
        .join(format!("{name}.bsp"));
    let Ok(bytes) = std::fs::read(&p) else {
        eprintln!("skipping {name}: {} not found", p.display());
        return None;
    };
    let b = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let mut g =
        Game::load_with_content(&b, bunnyhop_core::content::cached_physics_content(&p)).unwrap();
    g.set_settings(Settings {
        physics_version: version,
        ..Settings::css_bhop()
    });
    g.reset();
    Some(g)
}
#[test]
fn profane_uses_csgo_crouch_lift_only_in_v19() {
    let Some(mut game) = load("bhop_profane", 19) else {
        return;
    };
    assert_eq!(
        bunnyhop_core::game::map_mechanics_v19_for(&game.entities),
        Some("bhop_profane")
    );
    for version in (1..=19).rev() {
        game.set_settings(Settings {
            physics_version: version,
            ..Settings::css_bhop()
        });
        game.reset();
        game.set_position([240.0, 48.0, -127.0], 0.0);
        let start = game.state.position[2];
        game.step(Cmd {
            buttons: 4,
            ..Cmd::default()
        })
        .unwrap();
        let mut top = start;
        for _ in 0..90 {
            game.step(Cmd {
                buttons: 6,
                ..Cmd::default()
            })
            .unwrap();
            top = top.max(game.state.position[2]);
        }
        let rise = top - start;
        assert!(
            (rise - if version == 19 { 65.99748 } else { 65.49748 }).abs() < 0.001,
            "v{version}: {rise}"
        );
    }
}

#[test]
fn playboy_wrapped_destination_pitch_is_signed_only_in_v19() {
    let Some(mut game) = load("bhop_playboy_csgo", 19) else {
        return;
    };
    assert_eq!(
        bunnyhop_core::game::map_mechanics_v19_for(&game.entities),
        Some("bhop_playboy_csgo")
    );
    for version in (1..=19).rev() {
        game.set_settings(Settings {
            physics_version: version,
            ..Settings::css_bhop()
        });
        game.reset();
        let t = game
            .teleports()
            .into_iter()
            .find(|t| t.target == "level1" && t.enabled && t.filter.is_none())
            .unwrap();
        game.place_player(std::array::from_fn(|k| (t.mins[k] + t.maxs[k]) * 0.5));
        game.step(Cmd::default()).unwrap();
        assert!(game.events & 1 != 0, "v{version}: actual teleport");
        assert_eq!(
            game.teleport_angles[0],
            if version == 19 { -10.0 } else { 350.0 },
            "v{version}"
        );
    }
}

#[test]
fn altered_entity_builds_do_not_match() {
    for name in ["bhop_profane", "bhop_playboy_csgo"] {
        let Some(game) = load(name, 19) else { continue };
        let mut changed = game.entities.clone();
        changed[0]
            .pairs
            .push(("review_mutation".into(), "1".into()));
        assert_eq!(bunnyhop_core::game::map_mechanics_v19_for(&changed), None);
    }
}
/// Original BSP's 66-unit step (floor 0 -> 66), ordinary commands and no state/velocity injection.
#[test]
fn profane_actual_sixty_six_unit_ledge_is_clearable() {
    for version in [18, 19] {
        let Some(mut game) = load("bhop_profane", version) else {
            return;
        };
        game.set_position([-2841.0, -4512.0, 1.0], 0.0);
        game.step(Cmd {
            buttons: 4,
            ..Cmd::default()
        })
        .unwrap();
        let mut reached = false;
        for _ in 0..100 {
            game.step(Cmd {
                forward: 450.0,
                buttons: 6,
                ..Cmd::default()
            })
            .unwrap();
            reached |= game.state.position[0] > -2840.0
                && game.state.position[2] >= 66.0
                && game.state.ground.is_some();
        }
        assert_eq!(
            reached,
            version == 19,
            "v{version}: {:?}",
            game.state.position
        );
    }
}
