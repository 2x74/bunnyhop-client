//! Foreground native half of research/areaportal-v19/verify.ts; fixed-size scripted ride, no route search.
use bunnyhop_core::{Cmd, Settings, content};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut game = content::load_game(std::path::Path::new("maps/bhop_areaportal_v1.bsp")).unwrap();
    game.set_settings(Settings {
        physics_version: args[0].parse().unwrap(),
        ..Settings::css_bhop()
    });
    game.reset();
    let train = game
        .entities
        .iter()
        .position(|e| e.get("targetname") == Some("rede3da"))
        .unwrap();
    for _ in 0..60 {
        game.step(Cmd::default()).unwrap();
    }
    let c = game.entity_transform(train).unwrap().0;
    let dx: f32 = args[1].parse().unwrap();
    let dy: f32 = args[2].parse().unwrap();
    game.set_position([c[0] + dx, c[1] + dy, c[2] + 10.5], 37.0);
    game.state.velocity = [0.0, 1000.0, 0.0];
    // Save immediately before the first reversal, replay 80 steps after restoring.
    let mut saved = None;
    for tick in 0..730 {
        if tick == 200 {
            saved = Some(game.save_state());
        }
        if tick == 650 {
            game.restore_state(saved.as_ref().unwrap());
        }
        game.step(Cmd {
            yaw: 37.0,
            ..Cmd::default()
        })
        .unwrap();
        let (origin, angles) = game.entity_transform(train).unwrap();
        for f in game
            .state
            .position
            .into_iter()
            .chain(game.state.velocity)
            .chain(game.view_angle_change)
            .chain(origin)
            .chain(angles)
        {
            print!("{},", f.to_bits());
        }
        println!("{},{}", game.state.ground.is_some() as u32, game.events);
    }
}
