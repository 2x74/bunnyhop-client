//! v20 adopts shavit-core's old-button policy. Fixtures are physics evidence, not route completion proofs.
use bunnyhop_core::{
    Cmd, Game, Settings,
    game::{EVENT_JUMPED, IN_JUMP, PHYSICS_V19, PHYSICS_V20},
};
use playsrc_movement::{CrouchState, Mode};

fn dom(version: u32, autohop: bool) -> Option<Game> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../maps/bhop_dom.bsp");
    if !path.is_file() {
        eprintln!("skipping optional bhop_dom fixture");
        return None;
    }
    let mut game = bunnyhop_core::content::load_game(&path).expect("dom BSP");
    game.set_settings(Settings {
        physics_version: version,
        autohop,
        ..Settings::css_bhop()
    });
    game.reset();
    Some(game)
}

/// PonyTrap UJ2mcyOKq1LxloTN, immediately before command 1096 (recorded v18).
fn ponytrap(game: &mut Game) {
    game.state.position = [-9934.1328125, -1850.15771484375, -37.95884704589844];
    game.state.velocity = [835.0971069335938, 478.4269714355469, -18.006622314453125];
    game.state.ground = None;
    game.state.crouch = CrouchState::CROUCHED;
    game.state.jump_latched = true;
}
fn command() -> Cmd {
    Cmd {
        side: 450.0,
        yaw: 32.03617858886719,
        pitch: 1.1283799409866333,
        buttons: 1026,
        ..Cmd::default()
    }
}
fn speed(game: &Game) -> f32 {
    game.state.velocity[0].hypot(game.state.velocity[1])
}

#[test]
fn ponytrap_1096_unduck_jumps_before_friction_only_in_v20() {
    for version in [18, PHYSICS_V19, PHYSICS_V20] {
        let Some(mut game) = dom(version, true) else {
            return;
        };
        ponytrap(&mut game);
        let before = speed(&game);
        game.step(command()).unwrap();
        if version < PHYSICS_V20 {
            assert_eq!(game.events & EVENT_JUMPED, 0);
            assert!(game.state.ground.is_some());
            assert!(
                (speed(&game) - 924.1162).abs() < 0.01,
                "v{version}: historical 4% friction tick"
            );
            game.step(command()).unwrap();
            assert_ne!(
                game.events & EVENT_JUMPED,
                0,
                "historical jump is one tick late"
            );
        } else {
            assert_ne!(game.events & EVENT_JUMPED, 0);
            assert!(game.state.ground.is_none());
            assert!(speed(&game) >= before, "v20 keeps {before} u/s");
            assert!(game.state.velocity[2] > 280.0);
        }
    }
}

#[test]
fn shallow_water_still_rearms_autohop() {
    let Some(mut game) = dom(PHYSICS_V20, true) else {
        return;
    };
    ponytrap(&mut game);
    game.state.water_level = 1;
    let before = speed(&game);
    game.step(command()).unwrap();
    assert_ne!(game.events & EVENT_JUMPED, 0);
    assert!(speed(&game) >= before);
}

#[test]
fn teleport_onto_floor_jumps_on_first_command_only_in_v20() {
    for version in [PHYSICS_V19, PHYSICS_V20] {
        let Some(mut game) = dom(version, true) else {
            return;
        };
        // Move in air with jump held, then game code teleports to a standing-hull floor destination.
        game.place_player([-9934.0, -1850.0, 100.0]);
        game.step(Cmd {
            buttons: IN_JUMP,
            ..Cmd::default()
        })
        .unwrap();
        game.place_player([-9934.0, -1850.0, -47.96875]);
        game.state.velocity = [962.4, 0.0, 0.0];
        assert!(game.state.ground.is_none());
        game.step(Cmd {
            buttons: IN_JUMP,
            ..Cmd::default()
        })
        .unwrap();
        assert_eq!(game.events & EVENT_JUMPED != 0, version == PHYSICS_V20);
        assert!(
            (speed(&game)
                - if version == PHYSICS_V20 {
                    962.4
                } else {
                    962.4 * 0.96
                })
            .abs()
                < 0.01
        );
    }
}

#[test]
fn scroll_unduck_and_teleport_require_a_fresh_jump_in_both_versions() {
    for version in [PHYSICS_V19, PHYSICS_V20] {
        for crouched in [false, true] {
            for latched in [false, true] {
                let Some(mut game) = dom(version, false) else {
                    return;
                };
                ponytrap(&mut game);
                if !crouched {
                    game.state.crouch = CrouchState::STANDING;
                    game.place_player([-9934.0, -1850.0, -47.96875]);
                    game.state.velocity = [962.4, 0.0, 0.0];
                }
                game.state.jump_latched = latched;
                game.step(command()).unwrap();
                assert_eq!(
                    game.events & EVENT_JUMPED != 0,
                    !latched,
                    "v{version}, crouched={crouched}"
                );
            }
        }
    }
}

#[test]
fn ladders_deep_water_and_released_jump_keep_v19_policy() {
    for (mode, water, buttons) in [
        (Mode::Ladder, 0, IN_JUMP),
        (Mode::Walk, 2, IN_JUMP),
        (Mode::Walk, 3, IN_JUMP),
        (Mode::Walk, 0, 0),
    ] {
        let mut results = Vec::new();
        for version in [PHYSICS_V19, PHYSICS_V20] {
            let Some(mut game) = dom(version, true) else {
                return;
            };
            ponytrap(&mut game);
            game.state.mode = mode;
            game.state.water_level = water;
            game.step(Cmd {
                buttons,
                ..Cmd::default()
            })
            .unwrap();
            results.push((game.state, game.events));
        }
        assert_eq!(
            results[0], results[1],
            "mode={mode:?}, water={water}, buttons={buttons}"
        );
    }
}
