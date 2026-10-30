//! Native half of tools/verify/map-mechanics-parity.ts (local, read-only).
use bunnyhop_core::{Cmd, Settings, content};
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    assert!(
        args.len() == 11 || args.len() == 12,
        "mechanicsprobe MAP PHYSICS X Y Z YAW NAME VX VY VZ TICKS [BRUSH_MODELS]"
    );
    let n = |i: usize| args[i].parse::<f32>().expect("number");
    let mut game =
        content::load_game(std::path::Path::new(&format!("maps/{}.bsp", args[0]))).expect("map");
    game.set_settings(Settings {
        physics_version: args[1].parse().unwrap(),
        ..Settings::css_bhop()
    });
    game.reset();
    game.set_position([n(2), n(3), n(4)], n(5));
    game.set_restart_names(&args[6], "");
    game.state.velocity = [n(7), n(8), n(9)];
    for _ in 0..args[10].parse::<usize>().unwrap() {
        game.step(Cmd {
            yaw: n(5),
            ..Cmd::default()
        })
        .unwrap();
        let s = &game.state;
        for f in s.position.into_iter().chain(s.velocity) {
            print!("{},", f.to_bits());
        }
        print!("{},{}", s.ground.is_some() as u32, game.entities.len());
        if let Some(models) = args.get(11) {
            let transforms = game.brush_transforms();
            for model in models.split(',').map(|s| s.parse::<u32>().unwrap()) {
                let (_, origin, angles) = transforms.iter().find(|(m, _, _)| *m == model).unwrap();
                for value in origin.iter().chain(angles) { print!(",{}", value.to_bits()); }
            }
        }
        println!();
    }
}
