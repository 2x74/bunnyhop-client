//! Bounded synthetic landfix measurement on an empty flat floor. No route search.
#[path = "../../tests/common/mod.rs"]
mod common;
use bunnyhop_core::{Settings, physics::ConvexBrush};
use common::{Scene, Sim};
use playsrc_movement::Event;

fn main() {
    println!("mode,cadence,jump,tick,air_ticks,speed,gain,sync");
    let scene = Scene::new(vec![ConvexBrush::aabb([-1000000.0, -1000000.0, -64.0], [1000000.0, 1000000.0, 0.0])]);
    for cadence in [0.55_f32, 1.1, 2.0] {
        for on in [false, true] {
            let mut sim = Sim::new(&scene, Settings { physics_version: 27, ..Settings::css_bhop() }, [0.0, 0.0, 0.03125], [300.0, 0.0, 0.0]);
            if !on { sim.policy.jump_z_offset = None; }
            let (mut count, mut synced, mut gain, mut jumps) = (0, 0, 0.0_f32, 0);
            for i in 0..1000 {
                let phase = i % 80;
                let yaw = if phase < 40 { phase } else { 80 - phase } as f32 * cadence;
                let side = if phase < 40 { -450.0 } else { 450.0 };
                let pre = sim.state;
                // SSJ: sample air ticks and the first ground tick on which autohop jumps.
                let (sn, cs) = yaw.to_radians().sin_cos();
                let (wx, wy) = (sn * side, -cs * side);
                let inv = 1.0 / (wx * wx + wy * wy + 1e-10).sqrt();
                let current = pre.velocity[0] * wx * inv + pre.velocity[1] * wy * inv;
                count += 1;
                if current < 30.0 { synced += 1; gain += (30.0 - current.abs()) / 30.0; }
                let result = sim.step(0.0, side, yaw, true, false);
                if result.events.iter().any(|e| matches!(e, Event::Jumped)) {
                    jumps += 1;
                    let speed = pre.velocity[0].hypot(pre.velocity[1]);
                    println!("{},{cadence},{jumps},{i},{count},{speed:.6},{:.6},{:.6}", if on {"on"} else {"off"}, gain / count as f32 * 100.0, synced as f32 / count as f32 * 100.0);
                    (count, synced, gain) = (0, 0, 0.0);
                }
            }
        }
    }
}
