//! Physics v25 research probe (research/NATIVE-JUMP-OFFSET-V25.md): a bhop on a thin floor booster. The player falls onto
//! the middle of the trigger box `mins..maxs` from a sweep of heights (every landing phase), jump held, and the speed 12
//! ticks after the first jump is reported per version: v24 gives a spread of outcomes by landing phase, v25 one.
//!
//!   boosterprobe <map.bsp> <minx miny minz> <maxx maxy maxz>
use bunnyhop_core::content::load_game;
use bunnyhop_core::game::{IN_JUMP, PHYSICS_V24, PHYSICS_V25};
use bunnyhop_core::{Cmd, Settings};
use std::path::Path;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let f = |i: usize| a[i].parse::<f32>().unwrap();
    let (lo, hi) = ([f(2), f(3), f(4)], [f(5), f(6), f(7)]);
    let mut game = load_game(Path::new(&a[1])).expect("load");
    let c = [(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5];
    // The floor under the box's centre.
    let floor = game.trace_hull([c[0], c[1], hi[2] + 64.0], [c[0], c[1], lo[2] - 64.0], playsrc_collision::Hull { mins: [-16.0, -16.0, 0.0], maxs: [16.0, 16.0, 62.0] }, playsrc_collision::MASK_PLAYERSOLID);
    if floor.start_solid || floor.fraction >= 1.0 {
        println!("{{\"error\":\"no floor\"}}");
        return;
    }
    let mut out = String::new();
    for version in [PHYSICS_V24, PHYSICS_V25] {
        game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
        game.reset();
        let fresh = game.save_state();
        let mut results: Vec<String> = Vec::new();
        for k in 0..40 {
            game.restore_state(&fresh);
            game.place_player([c[0], c[1], floor.end[2] + 3.0 + k as f32 * 0.073]);
            game.state.velocity = [0.0, 0.0, -300.0];
            let mut jumped = None;
            let mut res = "no jump".to_string();
            for t in 0..120u32 {
                if game.step(Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons: IN_JUMP }).is_err() {
                    break;
                }
                if jumped.is_none() && game.events & 2 != 0 {
                    jumped = Some(t);
                }
                if jumped.is_some_and(|j| t == j + 12) {
                    let v = game.state.velocity;
                    res = format!("{:.0}/{:.0}", (v[0] * v[0] + v[1] * v[1]).sqrt(), v[2]);
                    break;
                }
            }
            results.push(res);
        }
        let mut uniq: Vec<(String, usize)> = Vec::new();
        for r in &results {
            match uniq.iter_mut().find(|(s, _)| s == r) {
                Some(e) => e.1 += 1,
                None => uniq.push((r.clone(), 1)),
            }
        }
        out += &format!("v{version}: {} ", uniq.iter().map(|(s, n)| format!("{s} x{n}")).collect::<Vec<_>>().join(", "));
    }
    println!("{out}");
}
