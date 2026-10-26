use bunnyhop_core::{Cmd, Game};
use std::path::PathBuf;

fn load(name: &str) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    let bytes = std::fs::read(&path).map_err(|_| eprintln!("skipping {name}: {} not found", path.display())).ok()?;
    Some(Game::load(&bunnyhop_core::parse_bsp(&bytes).unwrap()).unwrap())
}

/// Synthetic uses a solid brush with $surfaceprop ladder rather than CONTENTS_LADDER.
#[test]
fn synthetic_material_ladder_is_versioned() {
    use bunnyhop_core::{Settings, game::{PHYSICS_V17, PHYSICS_V18}};
    let Some(mut game) = load("bhop_synthetic_fix") else { return };
    for version in [PHYSICS_V17, PHYSICS_V18] {
        game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
        game.reset();
        game.place_player([-12052.5, 13065.0, 7690.0]);
        let start = game.state.position;
        let mut ladder_ticks = 0;
        for _ in 0..20 {
            game.step(Cmd { forward: 400.0, yaw: 0.0, pitch: 0.0, ..Default::default() }).unwrap();
            ladder_ticks += usize::from(game.state.mode == playsrc_movement::Mode::Ladder);
        }
        eprintln!("v{version}: {start:?} -> {:?}, ladder ticks {ladder_ticks}", game.state.position);
        if version == PHYSICS_V18 {
            assert!(ladder_ticks > 10, "attach to the reported ladder");
            assert!(game.state.position[2] > start[2] + 25.0, "climb the ladder");
        } else {
            assert_eq!(ladder_ticks, 0, "old replays keep the original behavior");
        }
    }
}
