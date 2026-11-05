//! Research probe (bhop_tranquility crouch jump, 2026-11-04): floor heights on a grid, then wall faces along a line.
//!
//!   ledgeprobe <map> grid <x0> <x1> <y0> <y1> <step> [ztop] [zbot]
//!   ledgeprobe <map> wall <x> <y0> <y1> <z0> <z1> <zstep>   (point traces along +y at each z: first hit y)
//!   ledgeprobe <map> hull <x> <y> <ztop>                     (standing-hull drop: settled feet z)
use bunnyhop_core::content::load_game;
use playsrc_collision::Hull;
use std::path::PathBuf;

const POINT: Hull = Hull { mins: [0.0; 3], maxs: [0.0; 3] };
const STAND: Hull = Hull { mins: [-16.0, -16.0, 0.0], maxs: [16.0, 16.0, 62.0] };

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let f = |i: usize| a[i].parse::<f32>().unwrap();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut game = load_game(&root.join("maps").join(format!("{}.bsp", a[1]))).expect("load map");
    game.set_settings(bunnyhop_core::Settings { physics_version: bunnyhop_core::game::PHYSICS_LATEST, ..bunnyhop_core::Settings::css_bhop() });
    game.reset();
    let mask = playsrc_collision::MASK_PLAYERSOLID;
    match a[2].as_str() {
        "grid" => {
            let (x0, x1, y0, y1, step) = (f(3), f(4), f(5), f(6), f(7));
            let ztop = a.get(8).map(|s| s.parse().unwrap()).unwrap_or(200.0f32);
            let zbot = a.get(9).map(|s| s.parse().unwrap()).unwrap_or(-200.0f32);
            print!("{:>7}", "y\\x");
            let mut x = x0;
            while x <= x1 { print!("{:>7.0}", x); x += step; }
            println!();
            let mut y = y1;
            while y >= y0 {
                print!("{:>7.0}", y);
                let mut x = x0;
                while x <= x1 {
                    let t = game.trace_hull([x, y, ztop], [x, y, zbot], POINT, mask);
                    if t.start_solid { print!("{:>7}", "S") } else if t.fraction >= 1.0 { print!("{:>7}", "-") } else { print!("{:>7.1}", t.end[2]) }
                    x += step;
                }
                println!();
                y -= step;
            }
        }
        "wall" => {
            let (x, y0, y1, z0, z1, zs) = (f(3), f(4), f(5), f(6), f(7), f(8));
            let mut z = z0;
            while z <= z1 {
                let t = game.trace_hull([x, y0, z], [x, y1, z], POINT, mask);
                println!("z {:7.2}: frac {:.4} hit y {:8.3} normal {:?} start_solid {}", z, t.fraction, t.end[1], t.normal, t.start_solid);
                z += zs;
            }
        }
        "ray" => {
            let t = game.trace_hull([f(3), f(4), f(5)], [f(6), f(7), f(8)], POINT, mask);
            println!("ray frac {:.5} end {:?} normal {:?} start_solid {} contents {:#x}", t.fraction, t.end, t.normal, t.start_solid, t.contents);
        }
        "hull" => {
            let t = game.trace_hull([f(3), f(4), f(5)], [f(3), f(4), f(5) - 400.0], STAND, mask);
            println!("stand hull settles at z {:.3} (frac {:.4}, normal {:?}, start_solid {})", t.end[2], t.fraction, t.normal, t.start_solid);
        }
        _ => panic!("mode"),
    }
}
