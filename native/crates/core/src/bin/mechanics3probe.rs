//! Foreground native half of tools/maps-mech3/parity.ts. Scenario text is authored locally, never embedded code.
use bunnyhop_core::{Cmd,Settings,content};
fn main() {
    let args:Vec<String>=std::env::args().skip(1).collect();
    let mut g=content::load_game(std::path::Path::new(&format!("maps/{}.bsp",args[0]))).unwrap();
    g.set_settings(Settings{physics_version:args[1].parse().unwrap(),..Settings::css_bhop()});g.reset();
    let mut saved=None;
    for line in std::fs::read_to_string(&args[2]).unwrap().lines(){let s:Vec<_>=line.split_whitespace().collect();if s.is_empty()||s[0].starts_with('#'){continue;}let n=|i:usize|s[i].parse::<f32>().unwrap();
        match s[0]{
            "at"=>g.set_position([n(1),n(2),n(3)],n(4)),
            "vel"=>g.state.velocity=[n(1),n(2),n(3)],
            "name"=>g.set_restart_names(if s[1]=="_"{""}else{s[1]},if s[2]=="_"{""}else{s[2]}),
            "save"=>saved=Some(g.save_state()),
            "restore"=>g.restore_state(saved.as_ref().unwrap()),
            "step"=>for _ in 0..s[1].parse::<usize>().unwrap(){g.step(Cmd{forward:n(2),side:n(3),yaw:n(4),pitch:n(5),buttons:s[6].parse().unwrap()}).unwrap();
                for f in g.state.position.into_iter().chain(g.state.velocity).chain([g.gravity_scale]){print!("{},",f.to_bits());}
                println!("{},{},{}",g.state.ground.is_some() as u32,g.state.crouch.uses_crouched_hull() as u32,g.events);
            },
            _=>panic!("unknown authored command")
        }
    }
}
