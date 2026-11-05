//! Research repro (bhop_tranquility crouch jump, 2026-11-04, /tmp/bh-crouch/report.md). Scripted, no search:
//! a bhop landing on the z=32 floor at the arch exit, autohop jump held, at ~616 u/s towards the z=96 ledge
//! (face x=4016), duck pressed k ticks after the jump and held. Sweeps the landing phase (drop height) and the
//! takeoff distance; reports whether the player ends up standing on the ledge top (z >= 96).
//!
//!   crouchledge <map> [--physics N] [--speed 616] [--yaw 0] [--y 4256] [--csv out.csv]
use bunnyhop_core::content::load_game;
use bunnyhop_core::game::{IN_DUCK, IN_JUMP, PHYSICS_LATEST};
use bunnyhop_core::Cmd;
use std::io::Write;
use std::path::PathBuf;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let opt = |name: &str, d: f32| a.iter().position(|x| x == name).and_then(|i| a.get(i + 1)).and_then(|v| v.parse().ok()).unwrap_or(d);
    let physics = opt("--physics", PHYSICS_LATEST as f32) as u32;
    let speed = opt("--speed", 616.0);
    let yaw = opt("--yaw", 0.0);
    let y0 = opt("--y", 4256.0);
    let csv = a.iter().position(|x| x == "--csv").map(|i| a[i + 1].clone());
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut game = load_game(&root.join("maps").join(format!("{}.bsp", a[1]))).expect("load map");
    game.set_settings(bunnyhop_core::Settings { physics_version: physics, ..bunnyhop_core::Settings::css_bhop() });
    let mut out = csv.map(|p| std::fs::File::create(p).unwrap());
    if let Some(f) = out.as_mut() {
        writeln!(f, "start_x,drop,duck_tick,jump_x,jump_z,peak_z,face_z,result").unwrap();
    }
    let (s, c) = (yaw.to_radians().sin(), yaw.to_radians().cos());
    let mut summary: std::collections::BTreeMap<u32, (u32, u32)> = Default::default();
    let mut best_peak = f32::MIN;
    let mut worst_peak = f32::MAX;
    let mut phases_any: (u32, u32) = (0, 0);
    // Takeoff distance: start x of the fall (the jump comes ~0-1 tick later). Landing phase: drop height 0..2.4 above
    // the floor with a bhop's -290 u/s fall, in 0.1 steps (covers every sub-tick landing phase).
    for drop10 in 0..=24 {
        let drop = drop10 as f32 * 0.1;
        let mut any = false;
        for start_x in (3700..=3840).step_by(4) {
            for &k in &[1u32, 3, 6, 10, 15, 20, 25, 30] {
                game.reset();
                game.set_position([start_x as f32, y0, 40.0], yaw);
                game.state.position = [start_x as f32, y0, 32.031_25 + drop];
                game.state.velocity = [speed * c, speed * s, -290.0];
                game.state.ground = None;
                game.state.jump_latched = false;
                let mut jumped: Option<(u32, [f32; 3])> = None;
                let mut peak = f32::MIN;
                let mut face_z = f32::NAN;
                let mut result = "short";
                for t in 0..200u32 {
                    let duck = jumped.is_some_and(|(jt, _)| t >= jt + k);
                    let cmd = Cmd { forward: 0.0, side: 0.0, yaw, pitch: 0.0, buttons: IN_JUMP | if duck { IN_DUCK } else { 0 } };
                    let before = game.state;
                    game.step(cmd).unwrap();
                    let st = game.state;
                    if jumped.is_none() && st.velocity[2] > 200.0 && before.velocity[2] <= 0.0 {
                        jumped = Some((t, before.position));
                        if before.position[2] > 34.1 || before.position[2] < 32.0 { result = "nojump"; break; }
                    }
                    if jumped.is_some() {
                        peak = peak.max(st.position[2]);
                        let hs = (st.velocity[0].powi(2) + st.velocity[1].powi(2)).sqrt();
                        if hs < speed * 0.5 && face_z.is_nan() { face_z = st.position[2]; result = "blocked"; }
                        if st.ground.is_some() && st.position[2] > 95.9 { result = "ON LEDGE"; break; }
                        if st.ground.is_some() && st.position[2] < 95.0 && t > jumped.unwrap().0 + 2 { if result != "blocked" { result = "fell"; } break; }
                    }
                }
                if result == "nojump" { continue; }
                let (jt, jp) = jumped.unwrap_or((0, [f32::NAN; 3]));
                let _ = jt;
                if let Some(f) = out.as_mut() {
                    writeln!(f, "{start_x},{drop:.1},{k},{:.2},{:.3},{:.3},{:.3},{result}", jp[0], jp[2], peak, face_z).unwrap();
                }
                let e = summary.entry(k).or_default();
                e.1 += 1;
                if result == "ON LEDGE" { e.0 += 1; any = true; }
                if peak.is_finite() { best_peak = best_peak.max(peak - jp[2]); worst_peak = worst_peak.min(peak - jp[2]); }
            }
        }
        phases_any.1 += 1;
        if any { phases_any.0 += 1; }
        println!("drop {drop:.1}: {}", if any { "some takeoff/duck timing clears" } else { "nothing clears" });
    }
    println!("physics {physics} speed {speed} yaw {yaw}: landing phases with any clearing line: {}/{}", phases_any.0, phases_any.1);
    for (k, (ok, n)) in summary { println!("  duck {k:>2} ticks after jump: {ok}/{n} clear"); }
    println!("  feet rise above takeoff (incl. duck lift): {worst_peak:.3} .. {best_peak:.3}");
}
