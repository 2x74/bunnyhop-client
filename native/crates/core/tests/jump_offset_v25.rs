//! Physics v25: Momentum Mod's `sv_jump_z_offset` 1.5 (`Policy::jump_z_offset`, research/NATIVE-JUMP-OFFSET-V25.md).
//! After a ground jump's impulse and FinishGravity, the active hull is traced 2.1 down to the floor and, if it fits
//! 1.5 above it, the jump starts there. Air jumps (Infinite), ladder and swim jumps are untouched.
//!
//! Synthetic scenes first (every version from the same start), then the real maps when present (maps are gitignored;
//! those tests skip with a note): bhop_tranquility's +64 crouch-jump ledge, thin teleports and bhop blocks.
mod common;

use bunnyhop_core::game::{EVENT_JUMPED, EVENT_TELEPORTED, IN_DUCK, IN_JUMP, PHYSICS_LATEST, PHYSICS_V24, PHYSICS_V25};
use bunnyhop_core::physics::ConvexBrush;
use bunnyhop_core::{Cmd, Game, Settings};
use common::{Scene, Sim, floor, ramp_up};
use playsrc_collision::Hull;
use playsrc_movement::{self as movement, Command, Error, Event, Mode, Player, State, StepInput, Trace, Tracer, CONTENTS_LADDER, CONTENTS_WATER};
use std::path::PathBuf;

/// Where a trace from above stops on a floor at z = 0 (DIST_EPSILON).
const REST: f32 = 0.031_25;
/// v25's jump start on that floor.
const LIFTED: f32 = REST + 1.5;

fn settings(version: u32) -> Settings {
    Settings { physics_version: version, ..Settings::css_bhop() }
}

fn grounded(scene: &Scene, version: u32, position: [f32; 3], crouched: bool) -> Sim<'_> {
    let mut sim = Sim::new(scene, settings(version), position, [0.0; 3]);
    sim.state = State::from_player(Player { position, velocity: [0.0; 3], grounded: true, crouched, jump_latched: false }, sim.policy);
    sim
}

fn jumped(r: &movement::StepResult) -> bool {
    r.events.iter().any(|e| matches!(e, Event::Jumped))
}

/// Jumps from the ground at `position` and returns (the step's lift, the feet's highest z).
fn jump_peak(scene: &Scene, version: u32, position: [f32; 3], crouched: bool) -> (Option<movement::JumpOffset>, f32) {
    let mut sim = grounded(scene, version, position, crouched);
    let r = sim.step(0.0, 0.0, 0.0, true, crouched);
    assert!(jumped(&r), "v{version} at {position:?} must jump");
    let lift = r.jump_offset;
    let mut peak = sim.state.position[2];
    for _ in 0..80 {
        sim.step(0.0, 0.0, 0.0, false, crouched);
        peak = peak.max(sim.state.position[2]);
    }
    (lift, peak)
}

#[test]
fn v25_is_the_latest_and_only_v25_lifts() {
    assert_eq!(PHYSICS_LATEST, 27);
    let scene = Scene::new(vec![floor()]);
    for version in 1..=PHYSICS_LATEST {
        let (lift, _) = jump_peak(&scene, version, [0.0, 0.0, 0.7], false);
        assert_eq!(lift.is_some(), version >= PHYSICS_V25, "v{version}");
    }
    assert_eq!(settings(PHYSICS_V24).policy().jump_z_offset, None);
    assert_eq!(settings(PHYSICS_V25).policy().jump_z_offset, Some(1.5));
    // Diagnostic pseudo-versions (fix masks) never lift: the rule is on the version number, not a fix bit.
    assert_eq!(settings(bunnyhop_core::game::PHYSICS_DIAG | bunnyhop_core::game::physics_fixes(PHYSICS_V24).unwrap()).policy().jump_z_offset, None);
}

/// Every landing phase a grounded player can be in (0.03 to 2.0 above the floor): v25 starts the jump at floor + 1.5,
/// lowering a player who is higher, so the peak is the same bit for bit. v24's peak follows the start height.
#[test]
fn every_ground_jump_starts_at_floor_plus_offset() {
    let scene = Scene::new(vec![floor()]);
    let heights = [REST, 0.2, 0.5, 1.0, 1.4, LIFTED, 1.6, 1.9, 1.99];
    let mut peaks = Vec::new();
    for h in heights {
        let (lift, peak) = jump_peak(&scene, PHYSICS_V25, [0.0, 0.0, h], false);
        let lift = lift.expect("lifted");
        assert_eq!(lift.from, [0.0, 0.0, h]);
        assert_eq!((lift.to[0], lift.to[1]), (0.0, 0.0));
        assert!((lift.to[2] - LIFTED).abs() < 1e-5, "from {h}: lifted to {}", lift.to[2]);
        peaks.push(peak);
        let (none, old) = jump_peak(&scene, PHYSICS_V24, [0.0, 0.0, h], false);
        assert!(none.is_none());
        assert!((old - h - 55.5).abs() < 0.02, "v24 peak {old} from {h}");
    }
    // The floor trace's end carries the sweep's float rounding (about 1e-6), nothing more.
    assert!(peaks.windows(2).all(|w| (w[0] - w[1]).abs() < 1e-4), "v25 peaks differ: {peaks:?}");
    assert!((peaks[0] - (LIFTED + 55.5)).abs() < 0.02, "v25 peak {}", peaks[0]);
}

/// Ducked on the ground: the crouched hull is traced and lifted the same way.
#[test]
fn crouched_ground_jump_is_lifted() {
    let scene = Scene::new(vec![floor()]);
    for h in [REST, 1.0, 1.9] {
        let (lift, _) = jump_peak(&scene, PHYSICS_V25, [0.0, 0.0, h], true);
        let lift = lift.expect("lifted");
        assert_eq!(lift.hull.maxs[2], 45.0);
        assert!((lift.to[2] - LIFTED).abs() < 1e-5, "{}", lift.to[2]);
    }
}

/// Inclines: the hull rests on the slope where the down trace stops; the lift is straight up from there, never
/// sideways, and the peak over the takeoff spot no longer depends on how high the landing left the player.
#[test]
fn slopes_lift_straight_up_from_where_the_hull_rests() {
    for angle in [10.0f32, 30.0, 44.0] {
        let scene = Scene::new(vec![floor(), ramp_up(0.0, 0.0, 1024.0, 1024.0, angle)]);
        // A box on a ramp rising along +x rests on its +x bottom edge (x + 16).
        let x = 400.0f32;
        let surface = (x + 16.0) * angle.to_radians().tan();
        let mut tops = Vec::new();
        for h in [0.05f32, 0.8, 1.7] {
            let mut sim = grounded(&scene, PHYSICS_V25, [x, 0.0, surface + h], false);
            let r = sim.step(0.0, 0.0, 0.0, true, false);
            assert!(jumped(&r), "{angle}° from {h}");
            let lift = r.jump_offset.unwrap_or_else(|| panic!("{angle}° from {h}: not lifted"));
            assert_eq!((lift.to[0], lift.to[1]), (lift.from[0], lift.from[1]), "{angle}°: the lift is vertical");
            assert!((lift.to[2] - surface - 1.5).abs() < 0.05, "{angle}° from {h}: lifted to {} over {surface}", lift.to[2]);
            tops.push(lift.to[2]);
        }
        assert!(tops.windows(2).all(|w| (w[0] - w[1]).abs() < 1e-3), "{angle}°: {tops:?}");
    }
}

/// A ceiling with no room for the lift: the jump starts where the landing left it, exactly as on v24.
#[test]
fn low_ceiling_keeps_the_stock_start() {
    for (crouched, hull_top) in [(false, 62.0f32), (true, 45.0)] {
        for (room, lifts) in [(0.5f32, false), (1.4, false), (1.6, true), (8.0, true)] {
            let ceiling = ConvexBrush::aabb([-256.0, -256.0, REST + hull_top + room], [256.0, 256.0, 512.0]);
            let scene = Scene::new(vec![floor(), ceiling]);
            let mut a = grounded(&scene, PHYSICS_V24, [0.0, 0.0, REST], crouched);
            let mut b = grounded(&scene, PHYSICS_V25, [0.0, 0.0, REST], crouched);
            let (ra, rb) = (a.step(0.0, 0.0, 0.0, true, crouched), b.step(0.0, 0.0, 0.0, true, crouched));
            assert!(jumped(&ra) && jumped(&rb));
            assert_eq!(rb.jump_offset.is_some(), lifts, "crouched {crouched} room {room}");
            if !lifts {
                assert_eq!(ra.state, rb.state, "crouched {crouched} room {room}: a blocked lift is a v24 jump");
            }
        }
    }
}

/// Infinite's air jump is not a ground jump: v24 and v25 are identical for a whole airborne flight of presses.
#[test]
fn infinite_air_jumps_are_unchanged() {
    let scene = Scene::new(vec![floor()]);
    let run = |version: u32| {
        let s = Settings { physics_version: version, air_jump: true, autohop: false, ..Settings::css_bhop() };
        let mut sim = Sim::new(&scene, s, [0.0, 0.0, 600.0], [900.0, 0.0, -50.0]);
        let mut out = Vec::new();
        for t in 0..120u32 {
            let r = sim.step(0.0, 0.0, 0.0, t % 10 < 3, false);
            assert!(r.jump_offset.is_none());
            assert!(sim.state.ground.is_none(), "stays airborne");
            out.push(sim.state);
        }
        out
    };
    assert_eq!(run(PHYSICS_V24), run(PHYSICS_V25));
}

/// A floor at z = 0 and water below `surface` (point contents).
struct Pool {
    scene: Scene,
    surface: f32,
}

impl Tracer for Pool {
    fn trace(&self, start: [f32; 3], end: [f32; 3], hull: Hull, mask: u32) -> Result<Trace, Error> {
        self.scene.trace(start, end, hull, mask)
    }
    fn point_contents(&self, point: [f32; 3]) -> Result<u32, Error> {
        Ok(if point[2] < self.surface { CONTENTS_WATER } else { 0 })
    }
    fn movement_time(&self) -> Option<f32> {
        Some(0.0)
    }
}

fn pool_step(pool: &Pool, version: u32, state: State, jump: bool) -> movement::StepResult {
    let s = settings(version);
    let input = StepInput { command: Command { forward: 0.0, side: 0.0, yaw_degrees: 0.0, jump, crouch: false }, ..Default::default() };
    movement::step(pool, state, input, s.configuration(), s.policy()).unwrap()
}

/// Swimming (water level 2+) jumps swim up, as on every version. Standing on the floor in shallow water (level 1) is a
/// ground jump, which Momentum also lifts (CheckJumpButton's water branch only takes level 2+).
#[test]
fn swim_jumps_are_unchanged_and_wading_jumps_lift() {
    let deep = Pool { scene: Scene::new(vec![floor()]), surface: 200.0 };
    let policy = settings(PHYSICS_V25).policy();
    for start in [[0.0f32, 0.0, 40.0], [0.0, 0.0, REST]] {
        let mut a = State::from_player(Player { position: start, velocity: [0.0; 3], grounded: start[2] < 1.0, crouched: false, jump_latched: false }, policy);
        let mut b = a;
        for t in 0..60 {
            let (ra, rb) = (pool_step(&deep, PHYSICS_V24, a, t % 4 != 0), pool_step(&deep, PHYSICS_V25, b, t % 4 != 0));
            assert!(rb.jump_offset.is_none(), "swimming never lifts");
            assert_eq!(ra.state, rb.state, "tick {t} from {start:?}");
            (a, b) = (ra.state, rb.state);
        }
        assert!(a.water_level >= 2);
    }
    let shallow = Pool { scene: Scene::new(vec![floor()]), surface: 10.0 };
    let wading = State::from_player(Player { position: [0.0, 0.0, REST], velocity: [0.0; 3], grounded: true, crouched: false, jump_latched: false }, policy);
    let settle = pool_step(&shallow, PHYSICS_V25, wading, false).state;
    assert_eq!(settle.water_level, 1);
    let r = pool_step(&shallow, PHYSICS_V25, settle, true);
    assert!(jumped(&r));
    assert!(r.jump_offset.is_some_and(|l| (l.to[2] - LIFTED).abs() < 1e-5));
}

/// A ladder face at x = 32 (the movement crate's ladder probe), on a floor.
struct Ladder {
    scene: Scene,
}

impl Tracer for Ladder {
    fn trace(&self, start: [f32; 3], end: [f32; 3], hull: Hull, mask: u32) -> Result<Trace, Error> {
        let d = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
        if mask & CONTENTS_LADDER != 0 && d[2] == 0.0 && d[1] == 0.0 && d[0] > 0.0 && start[0] + 16.0 + d[0] >= 32.0 {
            let fraction = ((32.0 - 16.0 - start[0]) / d[0]).clamp(0.0, 1.0);
            return Ok(Trace { fraction, start_solid: false, all_solid: false, end: [start[0] + d[0] * fraction, start[1], start[2]], normal: Some([-1.0, 0.0, 0.0]), hit: Some(77), contents: CONTENTS_LADDER });
        }
        self.scene.trace(start, end, hull, mask)
    }
    fn movement_time(&self) -> Option<f32> {
        Some(0.0)
    }
}

/// Climbing then jumping off a ladder (LadderMove's push away), and jumping with the feet on the floor while on the
/// ladder: identical on v24 and v25, never lifted.
#[test]
fn ladder_jumps_are_unchanged() {
    let ladder = Ladder { scene: Scene::new(vec![floor()]) };
    for start in [[15.0f32, 0.0, 100.0], [15.0, 0.0, REST]] {
        let run = |version: u32| {
            let s = settings(version);
            let mut state = State::from_player(Player { position: start, velocity: [0.0; 3], grounded: start[2] < 1.0, crouched: false, jump_latched: false }, s.policy());
            let mut modes = Vec::new();
            for t in 0..40u32 {
                let input = StepInput { command: Command { forward: 450.0, side: 0.0, yaw_degrees: 0.0, jump: t >= 20, crouch: false }, pitch_degrees: 0.0, ..Default::default() };
                let r = movement::step(&ladder, state, input, s.configuration(), s.policy()).unwrap();
                if r.state.mode == Mode::Ladder || state.mode == Mode::Ladder {
                    assert!(r.jump_offset.is_none(), "a ladder jump is never lifted");
                }
                modes.push(r.state.mode);
                state = r.state;
            }
            (state, modes)
        };
        let (a, b) = (run(PHYSICS_V24), run(PHYSICS_V25));
        assert!(a.1.contains(&Mode::Ladder), "the probe must attach from {start:?}");
        // From the floor the ladder detaches once the feet leave it; from then on it is a normal airborne player.
        assert_eq!(a.1, b.1, "same modes from {start:?}");
        if start[2] > 1.0 {
            assert_eq!(a.0, b.0, "from {start:?}");
        }
    }
}

/// Jumpbug: falling with duck held, releasing it right above the floor unducks into ground range and jumps with no
/// landing tick. That is a ground jump: v25 starts it at floor + 1.5 (sjlandfix lifts jumpbugs too).
#[test]
fn jumpbug_starts_at_floor_plus_offset() {
    let scene = Scene::new(vec![floor()]);
    let mut lifted = 0;
    // Crouched in the air the origin is the crouched hull's feet; unducking moves it 8.5 down.
    for feet in [0.2f32, 0.8, 1.4, 1.9] {
        for version in [PHYSICS_V24, PHYSICS_V25] {
            let mut sim = Sim::new(&scene, settings(version), [0.0, 0.0, 200.0], [0.0; 3]);
            sim.state = State::from_player(Player { position: [0.0, 0.0, feet + 8.5], velocity: [0.0, 0.0, -290.0], grounded: false, crouched: true, jump_latched: false }, sim.policy);
            let r = sim.step(0.0, 0.0, 0.0, true, false);
            if jumped(&r) && version == PHYSICS_V25 {
                let to = r.jump_offset.map(|l| l.to[2]);
                assert!(to.is_some_and(|z| (z - LIFTED).abs() < 1e-5), "jumpbug from feet {feet}: {to:?}");
                lifted += 1;
            }
        }
    }
    assert_eq!(lifted, 4, "every case is a jumpbug");
}

/// Flat-ground bunnyhopping: no speed is gained or lost. The jump's height above the floor is fixed, so every hop has
/// the same airtime; on v24 it depends on the landing phase.
#[test]
fn flat_bhop_airtime_is_constant_and_speed_unchanged() {
    let scene = Scene::new(vec![floor()]);
    let hops = |version: u32| {
        let mut sim = Sim::new(&scene, settings(version), [0.0, 0.0, 0.5], [0.0; 3]);
        let (mut last, mut air) = (None::<u32>, Vec::new());
        for t in 0..2000u32 {
            let r = sim.step(450.0, if t % 50 < 25 { 450.0 } else { -450.0 }, (t % 50) as f32 * 1.2, true, false);
            if jumped(&r) {
                if let Some(l) = last { air.push(t - l); }
                last = Some(t);
            }
        }
        (air, sim.hspeed())
    };
    let (a24, s24) = hops(PHYSICS_V24);
    let (a25, s25) = hops(PHYSICS_V25);
    eprintln!("v24 hop ticks {:?} speed {s24}\nv25 hop ticks {:?} speed {s25}", &a24[..8.min(a24.len())], &a25[..8.min(a25.len())]);
    assert!(a25[1..].windows(2).all(|w| w[0] == w[1]), "v25 hops all take the same ticks: {a25:?}");
}

/// The lift is vertical only (Sol review P3): from the same ground state, a v25 jump keeps exactly v24's velocity and
/// horizontal position, with or without movement keys, from a floor landing and a high one; only z differs, by the lift.
#[test]
fn jump_offset_changes_height_only() {
    let scene = Scene::new(vec![floor()]);
    for (forward, side, yaw) in [(0.0, 0.0, 0.0), (450.0, 450.0, 37.0), (0.0, -450.0, 210.0)] {
        for h in [REST, 0.9] {
            let step = |version: u32| {
                let s = settings(version);
                let player = Player { position: [0.0, 0.0, h], velocity: [300.0, 80.0, 0.0], grounded: true, crouched: false, jump_latched: false };
                let input = StepInput { command: Command { forward, side, yaw_degrees: yaw, jump: true, crouch: false }, ..Default::default() };
                movement::step(&scene, State::from_player(player, s.policy()), input, s.configuration(), s.policy()).unwrap()
            };
            let (a, b) = (step(PHYSICS_V24), step(PHYSICS_V25));
            assert!(jumped(&a) && jumped(&b), "both jump from {h} with keys {forward}/{side}");
            assert_eq!(a.state.velocity, b.state.velocity, "velocity from {h} with keys {forward}/{side}");
            assert_eq!(a.state.position[..2], b.state.position[..2], "horizontal position from {h}");
            let lift = b.state.position[2] - a.state.position[2];
            assert!((lift - (LIFTED - h)).abs() < 1e-4, "from {h}: v25 is higher by {lift}, expected {}", LIFTED - h);
        }
    }
}

// ---- Real maps (skipped when absent) ----

fn load(name: &str, version: u32) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../maps/{name}.bsp"));
    if !path.exists() {
        eprintln!("skipping: {} not present", path.display());
        return None;
    }
    let mut game = bunnyhop_core::content::load_game(&path).unwrap();
    game.set_settings(settings(version));
    game.reset();
    Some(game)
}

/// One bhop_tranquility attempt (PonyTrap, 2026-11-04): a bhop landing on the z = 32 floor at `drop` above it, at 616 u/s
/// toward the z = 96 ledge (face x = 4016), jump held, duck from `duck` ticks after the jump. True if it ends on the
/// ledge top.
fn tranquility_clears(game: &mut Game, start_x: f32, drop: f32, duck: u32) -> Option<bool> {
    game.reset();
    game.set_position([start_x, 4256.0, 40.0], 0.0);
    game.state.position = [start_x, 4256.0, 32.031_25 + drop];
    game.state.velocity = [616.0, 0.0, -290.0];
    game.state.ground = None;
    game.state.jump_latched = false;
    let mut jumped: Option<u32> = None;
    for t in 0..200u32 {
        let duck_now = jumped.is_some_and(|j| t >= j + duck);
        let before = game.state;
        game.step(Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons: IN_JUMP | if duck_now { IN_DUCK } else { 0 } }).unwrap();
        if jumped.is_none() && game.events & EVENT_JUMPED != 0 {
            if before.position[2] > 34.1 || before.position[2] < 32.0 {
                return None; // jumped from somewhere else
            }
            jumped = Some(t);
        }
        if jumped.is_some() && game.state.ground.is_some() {
            if game.state.position[2] > 95.9 {
                return Some(true);
            }
            if t > jumped.unwrap() + 2 {
                return Some(false);
            }
        }
    }
    Some(false)
}

/// The tranquility ledge is +64.0, a 100-tick crouch jump's apex. On v24 the takeoff window (start x, 4 u steps at 616 u/s)
/// depends on the landing phase, from a few units to the widest; on v25 it is the same for every phase.
#[test]
fn tranquility_ledge_window_is_constant_on_v25() {
    let Some(mut v24) = load("bhop_tranquility", PHYSICS_V24) else { return };
    let mut v25 = load("bhop_tranquility", PHYSICS_V25).unwrap();
    let drops = [0.0f32, 0.3, 0.6, 1.0, 1.5, 1.9];
    let (mut w24, mut w25) = (Vec::new(), Vec::new());
    for &drop in &drops {
        for (game, out) in [(&mut v24, &mut w24), (&mut v25, &mut w25)] {
            let mut clears = 0;
            for x in (3700..=3840).step_by(4) {
                for duck in [1u32, 10] {
                    clears += u32::from(tranquility_clears(game, x as f32, drop, duck) == Some(true));
                }
            }
            out.push(clears);
        }
    }
    eprintln!("tranquility clears per landing phase {drops:?}: v24 {w24:?}, v25 {w25:?}");
    assert!(w25.windows(2).all(|w| w[0] == w[1]), "v25 window must not depend on the landing phase: {w25:?}");
    assert!(w25[0] > 20, "v25 clears from a wide window: {w25:?}");
    assert!(w24[0] < w25[0] / 2, "v24 from a floor-level landing is the narrow case: {w24:?}");
    assert!(w24.windows(2).all(|w| w[0] <= w[1]), "v24 window grows with the landing height: {w24:?}");
}

/// Thin teleports on block tops (RNGFix's trigger jump, bhop block teleports): a falling player lands on a 2-unit-or-thinner
/// teleport. The landing tick is untouched by v25 (the lift belongs to the jump after it), so a teleport that fires on
/// or before the first jump fires on the same tick at the same place on v25. Teleports after the jump may differ: that
/// jump starts higher (a ceiling teleport is reached sooner), which is the point of v25.
#[test]
fn thin_teleports_fire_on_the_same_landing_tick() {
    let (mut sites, mut fired, mut later) = (0, 0, 0);
    for map in ["bhop_null_fix", "bhop_eazy", "bhop_eazy_v2", "bhop_2easy"] {
        let Some(mut game) = load(map, PHYSICS_V25) else { continue };
        let pads: Vec<_> = game.teleports().into_iter().filter(|t| t.enabled && t.filter.is_none() && t.maxs[2] - t.mins[2] <= 2.0).take(40).collect();
        for pad in &pads {
            let (cx, cy) = ((pad.mins[0] + pad.maxs[0]) * 0.5, (pad.mins[1] + pad.maxs[1]) * 0.5);
            for (drop, vz) in [(4.0f32, -300.0f32), (9.0, -300.0), (20.0, -100.0)] {
                let run = |game: &mut Game, version: u32| {
                    game.set_settings(settings(version));
                    game.reset();
                    game.place_player([cx, cy, pad.mins[2] + drop]);
                    game.state.velocity = [0.0, 0.0, vz];
                    let mut jump = None;
                    for t in 0..20 {
                        game.step(Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons: IN_JUMP }).unwrap();
                        if game.events & EVENT_JUMPED != 0 {
                            jump.get_or_insert(t);
                        }
                        if game.events & EVENT_TELEPORTED != 0 {
                            return (Some(t), jump, game.state.position);
                        }
                    }
                    (None, jump, game.state.position)
                };
                let (a, ja, pa) = run(&mut game, PHYSICS_V24);
                let (b, jb, pb) = run(&mut game, PHYSICS_V25);
                sites += 1;
                assert_eq!(ja.min(a), jb.min(b), "{map} pad {:?} drop {drop}: the landing goes the same way", pad.mins);
                match a {
                    Some(t) if ja.is_none_or(|j| t <= j) => {
                        fired += 1;
                        assert_eq!((a, pa), (b, pb), "{map} pad {:?} drop {drop}", pad.mins);
                    }
                    Some(_) => later += 1,
                    None => {}
                }
            }
        }
    }
    eprintln!("thin teleports: {sites} drops, {fired} teleport on the landing on v24 and identically on v25, {later} after the jump");
    if sites > 0 {
        assert!(fired > 0);
    }
}

/// Bhop blocks (func_door / func_button movers under the block fix, and stock sinking blocks): three autohops off the
/// first blocks of a few maps. No movement errors, the jump starts 1.5 over the block top, and v25 only differs from v24
/// from the first jump on.
#[test]
fn bhop_blocks_hop_from_floor_plus_offset() {
    let mut checked = 0;
    for map in ["bhop_eazy", "bhop_eazy_v2", "bhop_null_fix", "bhop_2easy", "bhop_dtt_trainning2"] {
        let Some(mut game) = load(map, PHYSICS_V25) else { continue };
        for top in game.bhop_block_tops().into_iter().take(12) {
            let run = |game: &mut Game, version: u32| {
                game.set_settings(settings(version));
                game.reset();
                game.place_player([top[0], top[1], top[2] + 6.0]);
                let mut first_jump = None;
                let mut states = Vec::new();
                for t in 0..120u32 {
                    game.step(Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons: IN_JUMP }).unwrap();
                    states.push(game.state.position);
                    if game.events & EVENT_JUMPED != 0 {
                        first_jump.get_or_insert(t);
                    }
                }
                assert_eq!(game.movement_errors, 0, "{map} block {top:?} v{version}");
                (first_jump, states)
            };
            let (j24, s24) = run(&mut game, PHYSICS_V24);
            let (j25, s25) = run(&mut game, PHYSICS_V25);
            let Some(j) = j24.filter(|&j| j > 0) else { continue };
            checked += 1;
            assert_eq!(j24, j25, "{map} block {top:?}: same first jump tick");
            let j = j as usize;
            assert_eq!(&s24[..j], &s25[..j], "{map} block {top:?}: identical before the first jump");
            // Same velocity on the jump tick, so the end of that tick differs by the lift alone.
            let before = s24[j - 1];
            let start = before[2] + (s25[j][2] - s24[j][2]);
            let floor = game.trace_player_hull(before, [before[0], before[1], before[2] - 2.1]);
            assert!(floor.fraction < 1.0, "{map} block {top:?}: grounded before the jump");
            assert!((start - (floor.end[2] + 1.5)).abs() < 0.01, "{map} block {top:?}: v25 jump start {start}, floor {}", floor.end[2]);
        }
        assert_eq!(game.movement_errors, 0, "{map}");
    }
    eprintln!("bhop blocks hopped: {checked}");
}

/// The start zone: on timer rules 2+ a run starts on the takeoff from the zone. The lift moves the player 1.5 at most
/// before that tick's move, inside the zone's footprint, so a takeoff still leaves on the jump tick or later. Checked
/// in the timer tests (apps/web) and the ranked timing identity (research/NATIVE-JUMP-OFFSET-V25.md); here only that
/// the lift is a phase-0 discrete step at the front of the accepted path.
#[test]
fn observed_path_chains_through_the_lift() {
    let scene = Scene::new(vec![floor()]);
    for h in [REST, 0.9, 1.9] {
        let s = settings(PHYSICS_V25);
        let state = State::from_player(Player { position: [0.0, 0.0, h], velocity: [300.0, 0.0, 0.0], grounded: true, crouched: false, jump_latched: false }, s.policy());
        let input = StepInput { command: Command { forward: 450.0, side: 0.0, yaw_degrees: 0.0, jump: true, crouch: false }, ..Default::default() };
        let plain = movement::step(&scene, state, input, s.configuration(), s.policy()).unwrap();
        let mut seen = movement::step_observed(&scene, state, input, s.configuration(), s.policy()).unwrap();
        let path = seen.accepted_path.take().unwrap();
        assert_eq!(plain, seen, "observation must not change the step");
        assert_eq!(path.unsupported, None, "from {h}: {path:?}");
        let first = &path.segments[0];
        assert!(first.discrete && first.t0 == 0.0 && first.t1 == 0.0);
        assert_eq!(first.from, [0.0, 0.0, h]);
        assert!((first.to[2] - LIFTED).abs() < 1e-5);
        for w in path.segments.windows(2) {
            assert_eq!(w[0].to, w[1].from);
        }
        assert_eq!(path.segments.last().unwrap().to, plain.state.position);
    }
}
