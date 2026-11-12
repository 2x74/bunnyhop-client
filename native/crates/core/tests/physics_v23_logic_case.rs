//! Physics v23: bhop_crutle5_css's first level ends in a trigger_teleport with no target; touching it runs a logic_case
//! PickRandom that gives it one (research/MAPS-FINISH-V34.md). Skips when the BSP isn't local (maps/ is gitignored).
use bunnyhop_core::{Cmd, Settings, content::load_game, game::{EVENT_TELEPORTED, PHYSICS_V22, PHYSICS_V23}};

fn run(physics: u32) -> Option<Vec<[f32; 3]>> {
    let path = bunnyhop_core::test_maps::bsp("bhop_crutle5_css");
    let mut game = load_game(&path).ok()?;
    game.set_settings(Settings { physics_version: physics, ..Settings::css_bhop() });
    game.reset();
    // Heading into the trigger (x -1328..-1296, y 720..752) the way a real run does (public replay frame 7629).
    game.place_player([-1284.0, 755.0, -80.0]);
    game.state.velocity = [-300.0, 0.0, 0.0];
    let mut arrivals = Vec::new();
    for _ in 0..20 {
        game.step(Cmd { forward: 0.0, side: 0.0, yaw: 180.0, pitch: 0.0, buttons: 0 }).unwrap();
        if game.events & EVENT_TELEPORTED != 0 {
            arrivals.push(game.state.position);
        }
    }
    Some(arrivals)
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn the_trigger_gets_a_target_on_v23_only() {
    let Some(old) = run(PHYSICS_V22) else { return eprintln!("bhop_crutle5_css.bsp not local: skipped") };
    assert!(old.is_empty(), "v22 stays as it was: {old:?}");
    let new = run(PHYSICS_V23).unwrap();
    let at = *new.first().expect("v23 teleports");
    // info_teleport_destination 1.1 (-320 -312 -224) or 1.4 (-320 368 -224).
    assert!(at[0] == -320.0 && (at[1] == -312.0 || at[1] == 368.0), "{at:?}");
}
