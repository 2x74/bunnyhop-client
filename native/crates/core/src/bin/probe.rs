//! Debug tool: place the player somewhere and print every tick.
//!
//! usage: probe <map.bsp> <x> <y> <z> [--ticks N] [--vel x,y,z] [--cmd forward,side,yaw,buttons]
use bunnyhop_core::{Cmd, Game};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert!(args.len() >= 5, "usage: probe <map.bsp> <x> <y> <z> [--ticks N] [--vel x,y,z] [--cmd f,s,yaw,buttons]");
    let bytes = std::fs::read(&args[1]).expect("read map");
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let mut game = Game::load(&bsp).unwrap();
    let pos: [f32; 3] = [args[2].parse().unwrap(), args[3].parse().unwrap(), args[4].parse().unwrap()];
    let floats = |s: &str| s.split(',').map(|v| v.parse::<f32>().unwrap()).collect::<Vec<_>>();
    let mut ticks: usize = 40;
    let mut vel = [0.0f32; 3];
    let mut cmd = Cmd::default();
    let mut cmds: Vec<Cmd> = Vec::new();
    let mut i = 5;
    while i < args.len() {
        match args[i].as_str() {
            "--ticks" => ticks = args[i + 1].parse::<usize>().unwrap(),
            "--vel" => {
                let v = floats(&args[i + 1]);
                vel = [v[0], v[1], v[2]];
            }
            "--cmd" => {
                let v = floats(&args[i + 1]);
                cmd = Cmd { forward: v[0], side: v[1], yaw: v[2], pitch: 0.0, buttons: v[3] as u32 };
            }
            "--cmds" => {
                for c in args[i + 1].split(';') {
                    let v = floats(c);
                    cmds.push(Cmd { forward: v[0], side: v[1], yaw: v[2], pitch: 0.0, buttons: v[3] as u32 });
                }
            }
            a => panic!("unknown arg {a}"),
        }
        i += 2;
    }
    if std::env::var_os("PROBE_DISP").is_some() {
        for (c, n) in bunnyhop_core::physics::displacement_centers(&bsp) {
            let d = ((c[0] - pos[0]).powi(2) + (c[1] - pos[1]).powi(2) + (c[2] - pos[2]).powi(2)).sqrt();
            if d < 800.0 {
                println!("disp centre {c:?} n {n:?} dist {d:.0}");
            }
        }
    }
    game.place_player(pos);
    game.state.velocity = vel;
    if !cmds.is_empty() {
        ticks = cmds.len();
    }
    for t in 0..ticks {
        game.step(cmds.get(t).copied().unwrap_or(cmd)).unwrap();
        let s = &game.state;
        let stuck = game.trace_player_hull(s.position, s.position);
        if stuck.start_solid {
            println!("     stuck in hit {:x?} contents {:#x}", stuck.hit, stuck.contents);
        }
        println!(
            "{t:4} crouch {:?} pos [{:.3} {:.3} {:.3}] vel [{:.2} {:.2} {:.2}] ground {} sf {:.3} base [{:.1} {:.1} {:.1}] ev {}",
            s.crouch.phase,
            s.position[0],
            s.position[1],
            s.position[2],
            s.velocity[0],
            s.velocity[1],
            s.velocity[2],
            s.ground.map(|g| format!("n[{:.3} {:.3} {:.3}] hit {:x?}", g.normal[0], g.normal[1], g.normal[2], g.support)).unwrap_or("-".into()),
            s.surface_friction,
            s.base_velocity[0],
            s.base_velocity[1],
            s.base_velocity[2],
            game.events
        );
    }
}
