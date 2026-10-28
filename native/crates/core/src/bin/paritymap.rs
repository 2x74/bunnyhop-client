//! Map facts for building parity scenarios (tools/parity/scenarios.ts): world brush volumes with a given contents
//! mask (water 0x20, ladder 0x20000000, ...) as axial bounds, plus the core's spawn. JSON on stdout.
//!
//! usage: paritymap <map.bsp> [contents-mask-hex]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let bytes = std::fs::read(&args[0]).expect("read map");
    let mask = args.get(1).map(|m| u32::from_str_radix(m.trim_start_matches("0x"), 16).expect("hex mask")).unwrap_or(0x20);
    let bsp = bunnyhop_core::parse_bsp(&bytes).expect("parse map");
    let world = bunnyhop_core::physics::build(&bsp).expect("physics").world;
    let mut boxes = Vec::new();
    for &b in &world.world_brushes {
        let brush = &world.brushes[b];
        if brush.contents & mask == 0 {
            continue;
        }
        let (mut lo, mut hi) = ([f32::NAN; 3], [f32::NAN; 3]);
        for side in &world.sides[brush.first_side..brush.first_side + brush.side_count] {
            let p = world.planes[side.plane];
            for k in 0..3 {
                if p.normal[k] == 1.0 {
                    hi[k] = p.distance;
                } else if p.normal[k] == -1.0 {
                    lo[k] = -p.distance;
                }
            }
        }
        if lo.iter().chain(&hi).all(|v| v.is_finite()) {
            boxes.push(format!("{{\"brush\":{b},\"contents\":{},\"mins\":{lo:?},\"maxs\":{hi:?}}}", brush.contents));
        }
    }
    let game = bunnyhop_core::Game::load(&bsp).expect("load");
    if let Some(i) = args.iter().position(|a| a == "--teleports") {
        let p: Vec<f32> = args[i + 1..i + 4].iter().map(|s| s.parse().unwrap()).collect();
        for t in game.teleports() {
            if (0..3).all(|k| p[k] + 40.0 >= t.mins[k] && p[k] - 40.0 <= t.maxs[k]) {
                eprintln!("{t:?} entity {:?}", game.entities[t.entity].pairs);
            }
        }
    }
    println!("{{\"spawn\":{:?},\"volumes\":[{}]}}", game.spawn_origin, boxes.join(","));
}
