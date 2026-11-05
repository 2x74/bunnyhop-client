//! Physics v25 (Momentum's `sv_jump_z_offset`, research/NATIVE-JUMP-OFFSET-V25.md): PonyTrap's minimal case
//! (2026-11-04, /tmp/bh-crouch/report.md). Standstill on a flat floor next to a 64-unit box, hold W, jump held from
//! tick 0 (autohop), duck from tick 1, 5 or 15, land on the box and hop again. Stock CS:S at 100 tick (v1-v24) reaches
//! 64.0 above the takeoff only at the apex, so the box landing waits for it: 37 ticks (0.370 s) jump to jump. On v25 the
//! jump starts at floor + 1.5 and peaks at 65.5: 32 ticks (0.320 s; Momentum's stats say 0.330 s).
mod common;
use bunnyhop_core::Settings;
use bunnyhop_core::game::{PHYSICS_LATEST, PHYSICS_V25};
use bunnyhop_core::physics::ConvexBrush;
use common::{Scene, Sim, floor};

fn run(physics: u32, duck_from: u32, gap: f32) -> Option<u32> {
    let scene = Scene::new(vec![floor(), ConvexBrush::aabb([16.0 + gap, -256.0, 0.0], [512.0, 256.0, 64.0])]);
    let settings = Settings { physics_version: physics, ..Settings::css_bhop() };
    let mut sim = Sim::new(&scene, settings, [0.0, 0.0, 0.031_25], [0.0; 3]);
    for _ in 0..20 { sim.idle(); } // settle on the floor
    let mut first_jump = None;
    for t in 0..120u32 {
        let r = sim.step(450.0, 0.0, 0.0, true, t >= duck_from);
        if r.events.iter().any(|e| matches!(e, playsrc_movement::Event::Jumped)) {
            match first_jump {
                None => first_jump = Some(t),
                Some(first) => return Some(t - first),
            }
        }
    }
    None
}

#[test]
fn pony_box_v25_lands_in_32_ticks_older_versions_in_37() {
    assert_eq!(PHYSICS_LATEST, PHYSICS_V25);
    for physics in 1..=PHYSICS_LATEST {
        let want = if physics >= PHYSICS_V25 { 32 } else { 37 };
        for duck in [1u32, 5, 15] {
            for gap in [0.5f32, 4.0, 8.0] {
                assert_eq!(run(physics, duck, gap), Some(want), "physics {physics} duck from tick {duck} gap {gap}");
            }
        }
    }
}

