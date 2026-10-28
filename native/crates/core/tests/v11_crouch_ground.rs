//! Regression fixture: CS:S air-unduck enters the two-unit ground probe before movement.
//! State fixtures test physics only; they are not replay completion evidence.
use bunnyhop_core::{
    Cmd, Game,
    game::{EVENT_JUMPED, IN_JUMP, PHYSICS_V10, PHYSICS_V11},
};
use playsrc_movement::CrouchState;
fn game(version: u32, autohop: bool, crouched: bool, latched: bool) -> Option<Game> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../maps/bhop_monument_valley.bsp");
    if !path.is_file() {
        eprintln!("skipping optional Monument fixture: {}", path.display());
        return None;
    }
    let mut g = bunnyhop_core::content::load_game(&path).expect("fixture BSP");
    let mut s = g.settings;
    s.physics_version = version;
    s.autohop = autohop;
    g.set_settings(s);
    g.reset();
    g.state.position = [
        -2500.1203613,
        -146.9965668,
        if crouched {
            1578.310546875
        } else {
            1569.810546875
        },
    ];
    g.state.velocity = [906.25665, -456.77893, -190.00662];
    g.state.ground = None;
    g.state.jump_latched = latched;
    g.state.crouch = if crouched {
        CrouchState::CROUCHED
    } else {
        CrouchState::STANDING
    };
    Some(g)
}
fn release(g: &mut Game) -> u32 {
    g.step(Cmd {
        side: 400.0,
        yaw: -26.507446,
        pitch: 13.111854,
        buttons: IN_JUMP,
        ..Cmd::default()
    })
    .unwrap();
    g.events
}
#[test]
fn v11_scroll_unduck_recategorizes_and_jumps_on_current_command() {
    let (Some(mut old), Some(mut new)) = (
        game(PHYSICS_V10, false, true, false),
        game(PHYSICS_V11, false, true, false),
    ) else {
        return;
    };
    assert_eq!(release(&mut old) & EVENT_JUMPED, 0);
    assert_ne!(release(&mut new) & EVENT_JUMPED, 0);
    assert!((new.state.position[2] - 1572.750488).abs() < 0.001);
}
#[test]
fn v11_keeps_historical_autohop_airborne_strip() {
    for v in [PHYSICS_V10, PHYSICS_V11] {
        let Some(mut g) = game(v, true, true, false) else {
            return;
        };
        assert_eq!(release(&mut g) & EVENT_JUMPED, 0);
    }
}
#[test]
fn scroll_held_jump_is_not_rearmed_by_unduck() {
    let Some(mut g) = game(PHYSICS_V11, false, true, true) else {
        return;
    };
    assert_eq!(release(&mut g) & EVENT_JUMPED, 0);
}
#[test]
fn teleport_ground_categorization_keeps_autohop_policy() {
    for v in [PHYSICS_V10, PHYSICS_V11] {
        let Some(mut g) = game(v, true, false, false) else {
            return;
        };
        assert_eq!(release(&mut g) & EVENT_JUMPED, 0);
    }
}
