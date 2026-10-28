//! Low Gravity is a settings preset on the unchanged simulation, including map gravity multipliers.
use bunnyhop_core::{Cmd, Game, Settings};

#[test]
fn half_gravity_composes_with_map_scale_and_resets() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../maps/bhop_eazy.bsp");
    let bytes = std::fs::read(path).expect("bhop_eazy fixture");
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let mut game = Game::load(&bsp).unwrap();
    for gravity in [800.0, 400.0] {
        let mut settings = Settings::css_bhop();
        settings.gravity = gravity;
        game.set_settings(settings);
        for scale in [1.0, 0.5, 2.0] {
            game.reset();
            // A clear airborne point in stage 2; zero horizontal motion avoids all map triggers.
            game.state.position = [600.0, -352.0, 200.0];
            game.state.velocity = [0.0; 3];
            game.state.ground = None;
            game.gravity_scale = scale;
            game.step(Cmd::default()).unwrap();
            assert!((game.state.velocity[2] + gravity * scale * settings.tick_interval).abs() < 0.001,
                    "gravity {gravity}, map scale {scale}: {:?}", game.state.velocity);
        }
        game.reset();
        assert_eq!(game.gravity_scale, 1.0);
        assert_eq!(game.settings.gravity, gravity);
    }
}
