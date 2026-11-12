//! Physics v25 ramp fix (research/NATIVE-RAMP-V25.md): ramps and curves no longer stop the player dead or freeze them in
//! mid-air. Collision half: `playsrc_collision::TraceRules` (stationary and swept BSP-walk margins, real faces over
//! bevel planes); movement half: `MovementFixes::repeated_plane`. Every older version keeps the engine's behaviour.
//!
//! The scenarios are exact start states and commands (tools/parity job files, f32 bit patterns) that were also run on
//! the real CS:S engine (tools/parity, srcds 100 tick):
//! - bhop_kotodama's drop shaft, k189 and k27 (Throwtop's earlier report, research in /tmp/bh-0036/maps-report.md):
//!   v24 freezes in mid-air for 100+ ticks; CS:S never freezes (k27: one CS:S stop tick, k189: none).
//! - bhop_aux_a9's last-stage kicker (33452_26): CS:S slides through; v24 misses the ramp on a grazing sweep, ends a
//!   hair inside it and stops.
//! - bhop_badges_mini's quarter-pipe (Throwtop, 2026-11-04): CS:S and v24 both lose all horizontal speed at a seam of
//!   the curve (the next segment's bevel plane is reported instead of its face); Momentum Mod slides on.
//! - bhop_kotodama, falling along a wall (2936_3, a slice of the public CS:S WR): float rounding hits the same wall
//!   plane on every bump and v24 zeroes the velocity.
//!
//! Maps are gitignored: each real-map test skips with a note when its map is absent, and fails instead with
//! `BH_REQUIRE_MAPS=1` (release qualification: `BH_REQUIRE_MAPS=1 cargo test --release -p bunnyhop-core --test
//! ramp_v25`). The wedge and repeated-plane tests need no map.
//!
//! What this file pins: the listed v25 outcomes, the v24 trajectories of the same scenarios exactly (a digest of every
//! tick's position, velocity and ground state, plus the states at the checked ticks), and the version gates. It is a
//! regression suite for these scenarios, not proof that v1-v24 are unchanged everywhere: that is the replay identity
//! check (tools/verify/wasm-identity.ts), which stays a release requirement.
use bunnyhop_core::game::{BhopBlockMode, IN_JUMP, PHYSICS_LATEST, PHYSICS_V24, PHYSICS_V25, Rules};
use bunnyhop_core::{Cmd, Game, Settings};
use playsrc_collision::{Brush, Hull, MASK_PLAYERSOLID, Plane, Side, TraceRules, World};
use playsrc_movement::{self as movement, Command, Player, State, StepInput, Tracer};
use std::path::PathBuf;

const IN_MOVERIGHT: u32 = 1 << 10;

struct Job {
    map: String,
    origin: [f32; 3],
    velocity: [f32; 3],
    cmds: Vec<Cmd>,
}

fn bits(s: &str) -> f32 {
    f32::from_bits(s.parse::<i64>().expect("float bits") as u32)
}

/// A tools/parity job file (the format `paritysim` reads).
fn job(name: &str) -> Job {
    let text = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/ramp_v25").join(name)).unwrap();
    let mut job = Job { map: String::new(), origin: [0.0; 3], velocity: [0.0; 3], cmds: Vec::new() };
    let mut in_cmds = false;
    for line in text.lines() {
        let p: Vec<&str> = line.split_whitespace().collect();
        if p.is_empty() || p[0].starts_with('#') {
            continue;
        }
        if in_cmds {
            job.cmds.push(Cmd { forward: p[0].parse().unwrap(), side: p[1].parse().unwrap(), yaw: bits(p[2]), pitch: bits(p[3]), buttons: p[4].parse().unwrap() });
            continue;
        }
        match p[0] {
            "map" => job.map = p[1].to_string(),
            "origin" => job.origin = [bits(p[1]), bits(p[2]), bits(p[3])],
            "velocity" => job.velocity = [bits(p[1]), bits(p[2]), bits(p[3])],
            "cmds" => in_cmds = true,
            _ => {}
        }
    }
    job
}

/// A slice of a real run: "id x y z vx vy vz|forward side yaw pitch buttons;..." (decimal).
fn slice(name: &str, map: &str) -> Job {
    let text = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/ramp_v25").join(name)).unwrap();
    let (head, cmds) = text.trim().split_once('|').unwrap();
    let v: Vec<f32> = head.split_whitespace().skip(1).map(|x| x.parse().unwrap()).collect();
    let cmds = cmds
        .split(';')
        .filter(|c| !c.trim().is_empty())
        .map(|c| {
            let p: Vec<f32> = c.split_whitespace().map(|x| x.parse().unwrap()).collect();
            Cmd { forward: p[0], side: p[1], yaw: p[2], pitch: p[3], buttons: p[4] as u32 }
        })
        .collect();
    Job { map: map.to_string(), origin: [v[0], v[1], v[2]], velocity: [v[3], v[4], v[5]], cmds }
}

fn load(map: &str) -> Option<Game> {
    let path = bunnyhop_core::test_maps::bsp(map);
    if !path.exists() {
        assert!(std::env::var_os("BH_REQUIRE_MAPS").is_none(), "BH_REQUIRE_MAPS: {} not present", path.display());
        eprintln!("skipping: {} not present", path.display());
        return None;
    }
    Some(bunnyhop_core::content::load_game(&path).unwrap())
}

#[derive(Clone, Copy, Debug)]
struct Tick {
    position: [f32; 3],
    velocity: [f32; 3],
    airborne: bool,
}

/// Runs the job like `paritysim` (vanilla bhop blocks, autohop, the player placed airborne at the start state).
fn run(game: &mut Game, job: &Job, version: u32) -> Vec<Tick> {
    game.set_rules(Rules { bhop_blocks: BhopBlockMode::Vanilla, ..Rules::default() });
    game.set_settings(Settings { physics_version: version, autohop: true, ..Settings::css_bhop() });
    game.reset();
    game.state.position = job.origin;
    game.state.velocity = job.velocity;
    game.state.ground = None;
    job.cmds
        .iter()
        .map(|cmd| {
            game.step(*cmd).unwrap();
            Tick { position: game.state.position, velocity: game.state.velocity, airborne: game.state.ground.is_none() }
        })
        .collect()
}

fn speed(v: [f32; 3]) -> f32 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

fn horizontal(v: [f32; 3]) -> f32 {
    (v[0] * v[0] + v[1] * v[1]).sqrt()
}

/// FNV-1a over every tick's position and velocity bits and ground flag: the exact trajectory.
fn digest(ticks: &[Tick]) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325_u64;
    for t in ticks {
        for v in t.position.iter().chain(&t.velocity) {
            for b in v.to_bits().to_le_bytes() {
                h = (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3);
            }
        }
        h = (h ^ u64::from(t.airborne)).wrapping_mul(0x100_0000_01b3);
    }
    h
}

/// The exact state at one tick, as bit patterns: (position, velocity, airborne).
type StateBits = ([u32; 3], [u32; 3], bool);

fn state_bits(t: Tick) -> StateBits {
    (t.position.map(f32::to_bits), t.velocity.map(f32::to_bits), t.airborne)
}

/// v24's exact trajectory: the digest of every tick and the states at the checked ticks.
fn assert_v24(name: &str, ticks: &[Tick], expected_digest: u64, checked: &[(usize, StateBits)]) {
    if std::env::var_os("BH_PRINT_BASELINES").is_some() {
        eprintln!("{name}: digest {:#018x}", digest(ticks));
        for &(i, _) in checked {
            eprintln!("{name}: tick {i} {:?}", state_bits(ticks[i]));
        }
    }
    for &(i, state) in checked {
        assert_eq!(state_bits(ticks[i]), state, "{name}: v24 tick {i} changed");
    }
    assert_eq!(digest(ticks), expected_digest, "{name}: v24 trajectory changed");
}

/// Longest run of airborne ticks in which the player doesn't move.
fn longest_freeze(ticks: &[Tick]) -> usize {
    let (mut longest, mut streak) = (0, 0);
    for pair in ticks.windows(2) {
        let moved = speed([
            pair[1].position[0] - pair[0].position[0],
            pair[1].position[1] - pair[0].position[1],
            pair[1].position[2] - pair[0].position[2],
        ]);
        streak = if pair[1].airborne && moved < 0.05 { streak + 1 } else { 0 };
        longest = longest.max(streak);
    }
    longest
}

/// Airborne ticks where the speed falls from over 400 to under 40 in one tick (a slide stopped dead).
fn hard_stops(ticks: &[Tick]) -> Vec<usize> {
    (1..ticks.len()).filter(|&i| ticks[i].airborne && speed(ticks[i - 1].velocity) > 400.0 && speed(ticks[i].velocity) < 40.0).collect()
}

/// Airborne ticks where the horizontal speed falls from at least 80 to under 30% of itself in one tick.
fn horizontal_kills(ticks: &[Tick]) -> Vec<usize> {
    (1..ticks.len())
        .filter(|&i| {
            let before = horizontal(ticks[i - 1].velocity);
            ticks[i].airborne && before >= 80.0 && horizontal(ticks[i].velocity) < 0.3 * before
        })
        .collect()
}

#[test]
fn v25_turns_the_ramp_fix_on_and_older_versions_keep_the_engine_rules() {
    for version in 1..=PHYSICS_V24 {
        let settings = Settings { physics_version: version, ..Settings::css_bhop() };
        assert_eq!(settings.trace_rules(), TraceRules::default(), "v{version}");
    }
    for version in PHYSICS_V25..=PHYSICS_LATEST {
        let rules = Settings { physics_version: version, ..Settings::css_bhop() }.trace_rules();
        assert_eq!(rules, TraceRules { stationary_margin: true, swept_margin: true, face_over_bevel: true }, "v{version}");
    }
}

/// bhop_kotodama k189: CS:S slides down the shaft without stopping. v24's stationary test missed the ramp brush the
/// player had ended inside, so every later move started all-solid: frozen in mid-air for 100+ ticks. v25 slides on.
#[cfg_attr(ci, ignore = "map library")]
#[test]
fn kotodama_k189_no_mid_air_freeze() {
    let job = job("koto_k189.job");
    let Some(mut game) = load(&job.map) else { return };
    let v24 = run(&mut game, &job, PHYSICS_V24);
    let v25 = run(&mut game, &job, PHYSICS_V25);
    assert_v24(
        "koto_k189",
        &v24,
        0x52a88ef141b58de4,
        &[
        (14, ([3315074094, 1173489449, 3316527532], [0, 0, 3229614080], true)),
        (15, ([3315074094, 1173489449, 3316527532], [0, 0, 3229614080], true)),
        (100, ([3315074094, 1173489449, 3316527532], [0, 0, 3229614080], true)),
        ],
    );
    eprintln!("k189 longest freeze v24 {} v25 {}, hard stops v24 {:?} v25 {:?}", longest_freeze(&v24), longest_freeze(&v25), hard_stops(&v24), hard_stops(&v25));
    assert!(longest_freeze(&v24) >= 100, "v24 keeps the old freeze (identity)");
    assert!(longest_freeze(&v25) <= 1);
    assert!(hard_stops(&v25).is_empty());
    let slow = v25.iter().filter(|t| t.airborne && speed(t.velocity) < 5.0).count();
    assert!(slow <= 1, "{slow} airborne ticks under 5 u/s");
}

/// bhop_kotodama k27: CS:S itself stops here for one tick (speed 1366 to about 30) and moves on slowly; v24 stopped
/// and then froze for 96 ticks. v25 doesn't stop at all (Momentum's behaviour, the owner's choice for v25).
#[cfg_attr(ci, ignore = "map library")]
#[test]
fn kotodama_k27_slides_through_the_css_stop() {
    let job = job("koto_k27.job");
    let Some(mut game) = load(&job.map) else { return };
    let v24 = run(&mut game, &job, PHYSICS_V24);
    let v25 = run(&mut game, &job, PHYSICS_V25);
    assert_v24(
        "koto_k27",
        &v24,
        0x5216a89c2f6056f6,
        &[
        (27, ([3315077328, 1173130028, 3317246375], [0, 0, 3229614080], true)),
        (28, ([3315077328, 1173130028, 3317246375], [0, 0, 3229614080], true)),
        (120, ([3315077328, 1173130028, 3317246375], [0, 0, 3229614080], true)),
        ],
    );
    eprintln!("k27 longest freeze v24 {} v25 {}, hard stops v24 {:?} v25 {:?}", longest_freeze(&v24), longest_freeze(&v25), hard_stops(&v24), hard_stops(&v25));
    assert!(!hard_stops(&v24).is_empty() && longest_freeze(&v24) >= 90, "v24 keeps the old stop and freeze (identity)");
    assert!(hard_stops(&v25).is_empty());
    assert!(longest_freeze(&v25) <= 1);
}

/// bhop_aux_a9's kicker ramp on the WR path (start state 33452_26): CS:S never stops. v24 matched CS:S bit for bit
/// until its sweep missed the ramp brush (grazing contact), then stopped dead. v25 tracks CS:S through it.
#[cfg_attr(ci, ignore = "map library")]
#[test]
fn aux_a9_kicker_no_grazing_stop() {
    let job = job("aux_33452_26.job");
    let Some(mut game) = load(&job.map) else { return };
    let v24 = run(&mut game, &job, PHYSICS_V24);
    let v25 = run(&mut game, &job, PHYSICS_V25);
    assert_v24(
        "aux_33452_26",
        &v24,
        0x9d1c297ea6b8fcbc,
        &[
        (56, ([1180106476, 1181625891, 3326563829], [1151230164, 1117952131, 1126225109], true)),
        (57, ([1180106476, 1181625891, 3326563829], [0, 0, 3229614080], true)),
        (79, ([1180107169, 1181616578, 3326583543], [1076164287, 3264468220, 3273719683], true)),
        ],
    );
    eprintln!("aux hard stops v24 {:?} v25 {:?}, kills v24 {:?} v25 {:?}", hard_stops(&v24), hard_stops(&v25), horizontal_kills(&v24), horizontal_kills(&v25));
    assert!(!hard_stops(&v24).is_empty(), "v24 keeps the old stop (identity)");
    assert!(hard_stops(&v25).is_empty() && horizontal_kills(&v25).is_empty());
    assert!(v25.iter().all(|t| speed(t.velocity) > 400.0), "v25 keeps its speed over the kicker");
}

/// bhop_badges_mini's quarter-pipe (Throwtop's video): flying into the curve and up it, the hull reaches the seam of two
/// segments; CS:S (srcds, tick 59) and v24 report the upper segment's axial bevel plane and lose all horizontal speed.
/// v25 reports the segment's face and slides up the curve.
#[cfg_attr(ci, ignore = "map library")]
#[test]
fn badges_mini_curve_seam_keeps_the_slide() {
    let job = job("badges_315.job");
    let Some(mut game) = load(&job.map) else { return };
    let v24 = run(&mut game, &job, PHYSICS_V24);
    let v25 = run(&mut game, &job, PHYSICS_V25);
    assert_v24(
        "badges_315",
        &v24,
        0x657b5eab8ed1631e,
        &[
        (57, ([1164149980, 3329546229, 1174397776], [3275778059, 3231407896, 1138626549], true)),
        (58, ([1164143585, 3329546279, 1174405968], [1023410176, 3231407896, 1138405221], true)),
        (59, ([1164142356, 3329546329, 1174410406], [3253731328, 3231407897, 1138143077], true)),
        ],
    );
    eprintln!("badges kills v24 {:?} v25 {:?}; tick 58 horizontal v24 {:.2} v25 {:.2}", horizontal_kills(&v24), horizontal_kills(&v25), horizontal(v24[58].velocity), horizontal(v25[58].velocity));
    assert_eq!(horizontal_kills(&v24), vec![58], "v24: the seam kill, the same tick as CS:S");
    assert!(horizontal(v24[58].velocity) < 5.0);
    assert!(horizontal_kills(&v25).is_empty());
    assert!(horizontal(v25[58].velocity) > 100.0, "v25 keeps sliding up the curve");
}

/// The collision rule itself, at the seam where v24 lost the slide: tick 58's sweep (its second bump, after sliding
/// along brush 2047) stops on brush 2046. Engine rules report its axial bevel (1, 0, 0); `face_over_bevel` reports the curved face the hull rests on.
#[cfg_attr(ci, ignore = "map library")]
#[test]
fn badges_mini_seam_reports_the_face_not_the_bevel() {
    let job = job("badges_315.job");
    let Some(mut game) = load(&job.map) else { return };
    let v24 = run(&mut game, &job, PHYSICS_V24);
    let start = v24[57].position;
    let hull = Hull { mins: [-16.0, -16.0, 0.0], maxs: [16.0, 16.0, 62.0] };
    // Tick 58's second bump: clipped along brush 2047's face at the seam, moving up the curve.
    let velocity = [-189.50584, -4.855358, 441.37027];
    let end = [start[0] + velocity[0] * 0.01, start[1] + velocity[1] * 0.01, start[2] + velocity[2] * 0.01];
    let engine = game.collision_world().trace_hull_rules(start, end, hull, MASK_PLAYERSOLID, TraceRules::default()).unwrap();
    let fixed = game.collision_world().trace_hull_rules(start, end, hull, MASK_PLAYERSOLID, TraceRules { face_over_bevel: true, ..TraceRules::default() }).unwrap();
    eprintln!("engine {:?} {:?} fixed {:?} {:?}", engine.fraction, engine.plane.map(|p| p.normal), fixed.fraction, fixed.plane.map(|p| p.normal));
    assert_eq!(engine.brush, Some(2046));
    assert_eq!(engine.plane.unwrap().normal, [1.0, 0.0, 0.0], "the bevel");
    assert_eq!(fixed.fraction, engine.fraction, "the stop point doesn't move");
    let n = fixed.plane.unwrap().normal;
    assert!(n[0] > 0.96 && n[0] < 0.97 && n[2] > 0.25 && n[2] < 0.26, "the curved face, not {n:?}");
}

/// Falling along a wall of bhop_kotodama (a slice of the public CS:S WR, perturbed): the wall's plane comes back at
/// fraction 0 on every bump (float rounding, the player moves parallel to it), and the move ends with velocity zeroed.
/// v25 steps 1/32 off the wall and keeps falling with the same velocity.
#[cfg_attr(ci, ignore = "map library")]
#[test]
fn kotodama_wall_repeated_plane_keeps_falling() {
    let job = slice("koto_wall_2936_3.slice", "bhop_kotodama");
    let Some(mut game) = load(&job.map) else { return };
    let v24 = run(&mut game, &job, PHYSICS_V24);
    let v25 = run(&mut game, &job, PHYSICS_V25);
    assert_v24(
        "koto_wall_2936_3",
        &v24,
        0xaf6c5eee494646c1,
        &[
        (178, ([3309523183, 1160443105, 3292078082], [1103014544, 1100373031, 3288006873], true)),
        (179, ([3309523183, 1160443105, 3292078082], [0, 0, 3229614080], true)),
        (180, ([3309522218, 1160443865, 3292079393], [1102876590, 1100243376, 3242196992], true)),
        ],
    );
    eprintln!("wall hard stops v24 {:?} v25 {:?}; tick 179 speed v24 {:.1} v25 {:.1}", hard_stops(&v24), hard_stops(&v25), speed(v24[179].velocity), speed(v25[179].velocity));
    assert_eq!(hard_stops(&v24), vec![179], "v24 keeps the stop (identity)");
    assert!(hard_stops(&v25).is_empty());
    assert!(speed(v25[179].velocity) > 400.0);
    // Momentum pushes the velocity 20 u/s off the plane; v25 steps the position instead and adds no speed.
    let (before, after) = (horizontal(v25[178].velocity), horizontal(v25[179].velocity));
    assert!(after <= before + 0.5, "no added speed: {before} -> {after}");
}

// ---- Map-free: exposed wedge edges (Sol's review, finding 1) ----

/// A collision world holding one convex wedge in a single leaf: x in [0, 100], |y| <= 100, |z| <= 100, cut by the ramp
/// face (sqrt(1 - nz^2), 0, nz) through the origin. The ridge is at x = 0, z = 0, where the axial z plane (a redundant
/// bevel the compiler adds) touches it. nz > 0: an upright wedge, solid below, ridge on top (a floor bevel); nz < 0: an
/// overhead wedge, solid above, ridge underneath (a flat ceiling bevel).
fn wedge(nz: f32) -> World {
    let nx = (1.0 - nz * nz).sqrt();
    let mut w = World::empty();
    w.models = vec![playsrc_bsp::Model {
        mins: playsrc_bsp::Vector3 { x: playsrc_bsp::Float32(0), y: playsrc_bsp::Float32(0), z: playsrc_bsp::Float32(0) },
        maxs: playsrc_bsp::Vector3 { x: playsrc_bsp::Float32(0), y: playsrc_bsp::Float32(0), z: playsrc_bsp::Float32(0) },
        origin: playsrc_bsp::Vector3 { x: playsrc_bsp::Float32(0), y: playsrc_bsp::Float32(0), z: playsrc_bsp::Float32(0) },
        head_node: -1,
        first_face: 0,
        face_count: 0,
    }];
    w.leaves = vec![playsrc_bsp::Leaf {
        contents: 1,
        cluster: 0,
        area_and_flags: 0,
        mins: [-512; 3],
        maxs: [512; 3],
        first_leaf_face: 0,
        leaf_face_count: 0,
        first_leaf_brush: 0,
        leaf_brush_count: 1,
        leaf_water_data_id: -1,
        padding: 0,
        ambient_cube: None,
    }];
    w.leaf_brushes = vec![0];
    w.world_brushes = vec![0];
    let up = nz > 0.0;
    let planes = [
        ([-1.0, 0.0, 0.0], 0.0, 0),
        ([1.0, 0.0, 0.0], 100.0, 0),
        ([0.0, -1.0, 0.0], 100.0, 0),
        ([0.0, 1.0, 0.0], 100.0, 0),
        // The ridge-side axial plane is the bevel: z <= 0 on an upright wedge, z >= 0 on an overhead one.
        ([0.0, 0.0, -1.0], if up { 100.0 } else { 0.0 }, i16::from(!up)),
        ([0.0, 0.0, 1.0], if up { 0.0 } else { 100.0 }, i16::from(up)),
        ([nx, 0.0, nz], 0.0, 0),
    ];
    for (i, (normal, distance, bevel)) in planes.into_iter().enumerate() {
        w.planes.push(Plane { normal, distance, kind: 3 });
        w.sides.push(Side { plane: i, texture_info: 0, displacement: -1, bevel });
    }
    w.brushes = vec![Brush { first_side: 0, side_count: 7, contents: 1 }];
    w
}

const STANDING: Hull = Hull { mins: [-16.0, -16.0, 0.0], maxs: [16.0, 16.0, 62.0] };

/// A movement tracer over a bare collision world with the given rules.
struct Ruled<'a>(&'a World, TraceRules);
impl Tracer for Ruled<'_> {
    fn trace(&self, start: [f32; 3], end: [f32; 3], hull: Hull, mask: u32) -> Result<movement::Trace, movement::Error> {
        let t = self.0.trace_hull_rules(start, end, hull, mask, self.1).unwrap();
        Ok(movement::Trace {
            fraction: t.fraction,
            start_solid: t.start_solid,
            all_solid: t.all_solid,
            end: t.end,
            normal: t.plane.map(|p| p.normal),
            hit: t.brush.map(|b| b as u64),
            contents: t.contents,
        })
    }
    fn point_contents(&self, _point: [f32; 3]) -> Result<u32, movement::Error> {
        Ok(0)
    }
    fn movement_time(&self) -> Option<f32> {
        Some(0.0)
    }
}

/// One airborne movement step under the given version's collision rules and movement fixes (the same gates `Game` uses).
fn wedge_step(world: &World, version: u32, position: [f32; 3], velocity: [f32; 3]) -> movement::StepResult {
    let settings = Settings { physics_version: version, ..Settings::css_bhop() };
    let policy = settings.policy();
    let mut configuration = settings.configuration();
    configuration.fixes = Rules::default().movement_fixes(settings);
    let state = State::from_player(Player { position, velocity, grounded: false, crouched: false, jump_latched: false }, policy);
    movement::step(&Ruled(world, settings.trace_rules()), state, StepInput::default(), configuration, policy).unwrap()
}

/// The hull's corner meets each wedge's ridge exactly (the bevel and the ramp face both enter within DIST_EPSILON).
/// Upright wedges keep their floor bevel (you land on the ridge); overhead wedges keep their flat ceiling bevel (you
/// bump your head), on every version: v25 must not turn the ridge into a ramp contact. Before the review's fix the
/// overhead ridges reported the underside and turned upward speed into horizontal (nz -0.8: (-2, 0, 400) became
/// about (188.8, 0, 137.6); nz -0.99: about 53 u/s; nz -0.6 replaced the flat ceiling bevel).
#[test]
fn exposed_wedge_ridges_keep_the_engine_bevel() {
    for nz in [0.6_f32, 0.8, -0.6, -0.8, -0.99] {
        let w = wedge(nz);
        let up = nz > 0.0;
        // Straight at the ridge, the hull's corner 0.01 past it.
        let start = [16.01, 0.0, if up { 2.0 } else { -64.0 }];
        let end = [15.99, 0.0, if up { -2.0 } else { -60.0 }];
        let engine = w.trace_hull_rules(start, end, STANDING, MASK_PLAYERSOLID, TraceRules::default()).unwrap();
        let v25 = Settings { physics_version: PHYSICS_V25, ..Settings::css_bhop() }.trace_rules();
        let fixed = w.trace_hull_rules(start, end, STANDING, MASK_PLAYERSOLID, v25).unwrap();
        assert_eq!(engine.plane.unwrap().normal, [0.0, 0.0, if up { 1.0 } else { -1.0 }], "nz {nz}: the ridge bevel");
        assert_eq!(fixed, engine, "nz {nz}: v25 keeps the engine's pick at an exposed ridge");
        let velocity = [-2.0, 0.0, if up { -400.0 } else { 400.0 }];
        let (a, b) = (wedge_step(&w, PHYSICS_V24, start, velocity), wedge_step(&w, PHYSICS_V25, start, velocity));
        assert_eq!((a.state.position, a.state.velocity), (b.state.position, b.state.velocity), "nz {nz}: same move on v24 and v25");
        assert!(b.state.velocity[0].abs() <= 2.0, "nz {nz}: no horizontal boost, {:?}", b.state.velocity);
    }
}

// ---- Map-free: the repeated-plane gate ----

/// A wall at x = 0 (normal +x) that, like Source's f32 rounding on a far-off surface, reports a hit at fraction 0 to
/// every sweep that starts inside its DIST_EPSILON band (x < 1/32), whichever way the box moves. Outside the band
/// nothing is hit.
struct RoundingWall;
impl Tracer for RoundingWall {
    fn trace(&self, start: [f32; 3], end: [f32; 3], _hull: Hull, _mask: u32) -> Result<movement::Trace, movement::Error> {
        let blocked = start != end && start[0] < 0.03125;
        Ok(movement::Trace {
            fraction: if blocked { 0.0 } else { 1.0 },
            start_solid: start[0] < 0.0,
            all_solid: false,
            end: if blocked { start } else { end },
            normal: blocked.then_some([1.0, 0.0, 0.0]),
            hit: blocked.then_some(7),
            contents: u32::from(blocked),
        })
    }
    fn point_contents(&self, _point: [f32; 3]) -> Result<u32, movement::Error> {
        Ok(0)
    }
    fn movement_time(&self) -> Option<f32> {
        Some(0.0)
    }
}

/// `Rules::movement_fixes` (what `Game` runs with) turns `repeated_plane` on for v25 only, and it does what it says:
/// falling along the wall, v1-v24 spend every bump at fraction 0 and stop dead in mid-air; v25 steps 1/32 off the wall and
/// keeps falling with the same velocity.
#[test]
fn repeated_plane_is_gated_on_v25_and_keeps_the_fall() {
    let run = |version: u32| {
        let settings = Settings { physics_version: version, ..Settings::css_bhop() };
        let policy = settings.policy();
        let mut configuration = settings.configuration();
        configuration.fixes = Rules::default().movement_fixes(settings);
        let start = [0.01, 0.0, 500.0];
        let state = State::from_player(Player { position: start, velocity: [0.0, 200.0, -300.0], grounded: false, crouched: false, jump_latched: false }, policy);
        let input = StepInput { command: Command { forward: 0.0, side: 0.0, yaw_degrees: 0.0, jump: false, crouch: false }, ..StepInput::default() };
        (configuration.fixes.repeated_plane, movement::step(&RoundingWall, state, input, configuration, policy).unwrap())
    };
    for version in 1..=PHYSICS_V24 {
        let (on, r) = run(version);
        assert!(!on, "v{version}");
        assert_eq!(r.state.velocity[1], 0.0, "v{version}: the engine stops dead on the repeated plane");
        assert_eq!(r.state.position[1], 0.0, "v{version}");
    }
    for version in PHYSICS_V25..=PHYSICS_LATEST {
        let (on, r) = run(version);
        assert!(on, "v{version}");
        assert_eq!(r.state.velocity[1], 200.0, "v{version}: same speed along the wall");
        assert!((r.state.position[1] - 2.0).abs() < 1e-3 && r.state.position[0] > 0.03, "v{version}: moved on, off the wall: {:?}", r.state.position);
    }
}

// ---- bhop_bfur: strafing from rest onto a brush-built curve (Sol's review, finding 2) ----

/// Holds one command for `ticks` from rest at bhop_bfur's curve toe (12061.42, 1633.86, 512.02); returns the highest feet z.
fn bfur_peak(game: &mut Game, version: u32, side: f32, buttons: u32, ticks: u32) -> f32 {
    game.set_rules(Rules::default());
    game.set_settings(Settings { physics_version: version, autohop: true, ..Settings::css_bhop() });
    game.reset();
    game.state.position = [12061.424, 1633.8643, 512.02136];
    game.state.velocity = [0.0; 3];
    game.state.ground = None;
    let mut peak = game.state.position[2];
    for _ in 0..ticks {
        game.step(Cmd { forward: 0.0, side, yaw: 0.0, pitch: 0.0, buttons }).unwrap();
        peak = peak.max(game.state.position[2]);
    }
    peak
}

/// Intended v25 change. At the toe of bhop_bfur's brush-built curve (brushes 41 and 51, a 1-unit toe below a 59-degree
/// face), v24 stops against the toe's (0, 1, 0) bevel; v25 meets the toe's ramp face and, holding strafe from rest with
/// no jump, crawls up the curve (Source's air-strafe-into-a-steep-ramp climb) to about +63. The v24 control holds jump
/// and strafe with autohop on (ordinary bhop) and climbs the same curve higher and farther (about +110); a single jump
/// on the first tick reaches about +62 on either version. With no input both versions stay put. This is a bounded
/// local peak-height comparison, not proof of route equivalence for every input.
#[cfg_attr(ci, ignore = "map library")]
#[test]
fn bfur_curve_toe_climb_from_rest_is_intended_and_opens_nothing() {
    let Some(mut game) = load("bhop_bfur") else { return };
    let rest = 512.02136_f32;
    let v24_idle = bfur_peak(&mut game, PHYSICS_V24, 0.0, 0, 300);
    let v25_idle = bfur_peak(&mut game, PHYSICS_V25, 0.0, 0, 300);
    let v24_strafe = bfur_peak(&mut game, PHYSICS_V24, 450.0, IN_MOVERIGHT, 300);
    let v25_strafe = bfur_peak(&mut game, PHYSICS_V25, 450.0, IN_MOVERIGHT, 300);
    let v24_jump = bfur_peak(&mut game, PHYSICS_V24, 450.0, IN_MOVERIGHT | IN_JUMP, 300);
    eprintln!("bfur peaks: idle v24 {v24_idle} v25 {v25_idle}; strafe v24 {v24_strafe} v25 {v25_strafe}; v24 jump+strafe {v24_jump}");
    assert_eq!((v24_idle, v25_idle, v24_strafe), (rest, rest, rest), "idle and v24 strafe stay put");
    assert!(v25_strafe > rest + 60.0, "v25 climbs the curve from rest: {v25_strafe}");
    assert!(v24_jump > v25_strafe, "v24 reaches higher on the same curve with a jump: {v24_jump} vs {v25_strafe}");
}
