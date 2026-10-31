//! Physics v22: Momentum's edge rule next to RNGFix (research/EDGEBUG-V22.md). A landing with no walkable ground under the
//! next tick can be taken back on that tick: a jump carries on as on v21, anything else stays airborne with no friction tick.
//! Autohop with jump held on the landing tick plays as v21. `sweep_report` prints the tables the research file quotes.
mod common;

use bunnyhop_core::{Cmd, Game, Settings};
use bunnyhop_core::game::{EVENT_EDGEBUG, EVENT_JUMPED, EVENT_LANDED, EVENT_TELEPORTED, IN_JUMP, PHYSICS_LATEST, PHYSICS_V16, PHYSICS_V21, PHYSICS_V22, physics_fixes};
use bunnyhop_core::physics::ConvexBrush;
use common::{Scene, Sim};
use playsrc_movement::{EdgeLandingKind, Player, Policy, State};

fn settings(version: u32, autohop: bool) -> Settings {
    Settings { physics_version: version, autohop, ..Settings::css_bhop() }
}

/// A platform whose +x edge is at x = 0 and whose top is at z = 0. The hull's back edge reaches the edge at x = 16.
fn platform() -> Scene {
    Scene::new(vec![ConvexBrush::aabb([-1024.0, -512.0, -64.0], [0.0, 512.0, 0.0])])
}

/// One tick as `Game::step` runs it: the previous edge landing resolved by this command, then the move.
fn tick(sim: &mut Sim, settings: Settings, jump: bool) -> (bool, playsrc_movement::StepResult) {
    let v22 = settings.physics_version == PHYSICS_V22;
    let wants = jump && (settings.autohop || !sim.state.jump_latched);
    let undone = sim.state.resolve_edge_landing(wants, false);
    sim.configuration.fixes.edgebug = v22 && !(settings.autohop && jump);
    sim.configuration.fixes.skip_prevent_collision = undone;
    if settings.autohop && jump {
        sim.state.jump_latched = false;
    }
    let keep = sim.autohop;
    sim.autohop = false; // the latch is handled above, as Game does
    let r = sim.step(0.0, 0.0, 0.0, jump, false);
    sim.autohop = keep;
    (undone, r)
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct Outcome {
    jumped: bool,
    /// Touched the ground state on a tick that stood (friction next tick, not taken back).
    landed: bool,
    edge_bugs: u32,
    /// Lowest horizontal speed over the run.
    low: f32,
    /// Horizontal speed and vz 12 ticks after the first contact.
    speed: f32,
    vz: f32,
    /// How the taken back landing went.
    kind: Option<EdgeLandingKind>,
    /// Horizontal speed and vz 3 ticks after the first contact.
    after: f32,
    after_vz: f32,
    contact: bool,
}

fn run(version: u32, autohop: bool, scene: &Scene, pos: [f32; 3], vel: [f32; 3], jump_at: impl Fn(u32) -> bool) -> Outcome {
    let s = settings(version, autohop);
    let mut sim = Sim::new(scene, s, pos, vel);
    let mut out = Outcome { low: f32::MAX, ..Outcome::default() };
    let mut contact = None;
    let mut pending = None;
    for t in 0..40 {
        let before = sim.state.ground.is_some();
        let (undone, r) = tick(&mut sim, s, jump_at(t));
        out.edge_bugs += u32::from(undone);
        if undone {
            out.kind = out.kind.or(pending);
        }
        pending = r.edge_landing_kind;
        out.jumped |= r.jump_velocity != [0.0; 3];
        out.low = out.low.min(sim.hspeed());
        out.landed |= before && !undone;
        if contact.is_none() && (sim.state.ground.is_some() || r.move_collided) {
            contact = Some(t);
        }
        out.contact |= contact.is_some();
        if contact.is_some_and(|c| t == c + 3) {
            out.after = sim.hspeed();
            out.after_vz = sim.state.velocity[2];
        }
        if contact.is_some_and(|c| t == c + 12) {
            out.speed = sim.hspeed();
            out.vz = sim.state.velocity[2];
        }
    }
    out
}

const PHASES: usize = 80;
/// The sweep of `edge_bug_still_jumps_from_v17`: feet reach the top at 3/4 of the first tick, the start x sweeps where that
/// is relative to the edge.
fn start(i: usize) -> [f32; 3] {
    [4.0 + i as f32 * 0.1, 0.0, 3.0]
}
const VEL: [f32; 3] = [800.0, 0.0, -400.0];

#[test]
fn versions() {
    assert_eq!(PHYSICS_LATEST, PHYSICS_V22);
    assert_eq!(physics_fixes(PHYSICS_V22), physics_fixes(PHYSICS_V21), "an explicit version gate, no new fix bits");
    assert_eq!(physics_fixes(23), None);
}

/// Jump held on autohop is v21, tick by tick, on every phase, including the phases that are edge landings.
#[test]
fn jump_held_on_autohop_is_v21() {
    let scene = platform();
    for i in 0..PHASES {
        let (a, b) = (settings(PHYSICS_V21, true), settings(PHYSICS_V22, true));
        let (mut x, mut y) = (Sim::new(&scene, a, start(i), VEL), Sim::new(&scene, b, start(i), VEL));
        for t in 0..40 {
            tick(&mut x, a, true);
            let (undone, _) = tick(&mut y, b, true);
            assert!(!undone, "phase {i} tick {t}");
            assert_eq!(x.state, y.state, "phase {i} tick {t}");
        }
    }
}

/// Jump released: v21 lands and takes the friction tick, v22 keeps the speed and loses the fall speed on every phase.
#[test]
fn jump_released_is_a_frictionless_edge_bug() {
    let scene = platform();
    let (mut bugs, mut past) = (0, 0);
    for i in 0..PHASES {
        let old = run(PHYSICS_V21, true, &scene, start(i), VEL, |_| false);
        let new = run(PHYSICS_V22, true, &scene, start(i), VEL, |_| false);
        assert!(!new.jumped, "phase {i}");
        if old.landed {
            assert!(old.low < 790.0, "v21 phase {i} takes friction: {old:?}");
            assert_eq!(new.edge_bugs, 1, "phase {i}: {new:?}");
            assert!(!new.landed, "phase {i}: {new:?}");
            assert!(new.low >= 800.0 - 0.01, "phase {i} keeps the speed: {new:?}");
            assert!(new.vz > -120.0, "phase {i} lost the fall speed: {new:?}");
            assert_eq!(new.kind, Some(EdgeLandingKind::Slide), "phase {i}");
            bugs += 1;
        } else {
            assert_eq!(old, new, "phase {i} is past the edge either way");
            past += 1;
        }
    }
    eprintln!("released: {bugs} edge bugs, {past} past the edge");
    assert_eq!((bugs, past), (61, 19));
}

/// The lottery RNGFix removed stays gone: a jump on the tick after the landing is exactly v21's, on every phase, on autohop
/// (pressed late) and on the scroll styles (a new press), whatever the jump was doing before.
#[test]
fn a_jump_on_the_next_tick_is_exactly_v21() {
    let scene = platform();
    for autohop in [true, false] {
        for i in 0..PHASES {
            let (a, b) = (settings(PHYSICS_V21, autohop), settings(PHYSICS_V22, autohop));
            let (mut x, mut y) = (Sim::new(&scene, a, start(i), VEL), Sim::new(&scene, b, start(i), VEL));
            let mut pressed = false;
            for t in 0..40 {
                let press = !pressed && t > 0 && x.state.ground.is_some();
                pressed |= press;
                let (_, ra) = tick(&mut x, a, press);
                let (undone, rb) = tick(&mut y, b, press);
                assert!(!(press && undone), "the press keeps the landing");
                if press {
                    assert!(ra.jump_velocity != [0.0; 3] && rb.jump_velocity != [0.0; 3], "autohop {autohop} phase {i}");
                    assert_eq!(x.state.position, y.state.position, "autohop {autohop} phase {i}");
                    assert_eq!(x.state.velocity, y.state.velocity, "autohop {autohop} phase {i}");
                }
            }
        }
    }
}

/// bhop_at_night's spawn drop ends exactly on the floor: the next tick's trace clears and ends stuck. It is a landing in the middle of a
/// floor, and has to stay one: taking it back lets the move stop dead.
#[test]
fn a_fall_ending_exactly_on_the_floor_stays_a_landing() {
    let Some(mut game) = map_game("bhop_at_night") else { return };
    for version in [PHYSICS_V21, PHYSICS_V22] {
        game.set_settings(settings(version, true));
        game.reset();
        game.place_player([-655.99, -415.4, 100.44]);
        game.state.velocity = [0.4, 30.0, -136.0];
        for t in 0..6 {
            game.step(Cmd { forward: 450.0, side: 0.0, yaw: 90.0, pitch: 0.0, buttons: 0 }).unwrap();
            assert_eq!(game.events & EVENT_EDGEBUG, 0, "v{version} tick {t}");
            if t >= 2 {
                assert!(game.horizontal_speed() > 20.0, "v{version} tick {t}: {}", game.horizontal_speed());
            }
        }
    }
}

/// Stairs and curbs aren't edges. Next to a drop of up to a step, a v21 landing walks down it and keeps the ground, so a later jump still
/// works there (bh_aztec's stairs): v22 is v21 on all phases, jump released. Over 20 units it is an edge.
#[test]
fn stairs_and_curbs_stay_landings() {
    let step = |drop: f32| Scene::new(vec![
        ConvexBrush::aabb([-1024.0, -512.0, -64.0], [0.0, 512.0, 0.0]),
        ConvexBrush::aabb([0.0, -512.0, -2048.0], [1024.0, 512.0, -drop]),
    ]);
    for (drop, edge) in [(4.0, false), (12.0, false), (17.0, false), (32.0, true)] {
        let scene = step(drop);
        let mut bugs = 0;
        for i in 0..PHASES {
            let (a, b) = (settings(PHYSICS_V21, true), settings(PHYSICS_V22, true));
            let (mut x, mut y) = (Sim::new(&scene, a, start(i), VEL), Sim::new(&scene, b, start(i), VEL));
            for _ in 0..30 {
                tick(&mut x, a, false);
                let (undone, _) = tick(&mut y, b, false);
                bugs += u32::from(undone);
                if !edge {
                    assert_eq!(x.state.position, y.state.position, "drop {drop} phase {i}");
                    assert_eq!(x.state.velocity, y.state.velocity, "drop {drop} phase {i}");
                }
            }
        }
        eprintln!("drop {drop}: {bugs} edge landings taken back over {PHASES} phases");
        assert_eq!(bugs > 0, edge, "drop {drop}");
    }
}

/// A floor that is moving (a Tracer whose support reports a velocity): the landing stands, as on v21. The prediction only sees this
/// tick's geometry, and `Game` takes a pusher's move as game code moving the player.
#[test]
fn a_moving_floor_stays_a_landing() {
    struct Moving<'a>(&'a Scene, [f32; 3]);
    impl playsrc_movement::Tracer for Moving<'_> {
        fn trace(&self, start: [f32; 3], end: [f32; 3], hull: playsrc_collision::Hull, mask: u32) -> Result<playsrc_movement::Trace, playsrc_movement::Error> {
            self.0.trace(start, end, hull, mask)
        }
        fn support_velocity(&self, _support: u64) -> Result<[f32; 3], playsrc_movement::Error> {
            Ok(self.1)
        }
    }
    let scene = platform();
    let outcome = |support: [f32; 3], i: usize| {
        let s = settings(PHYSICS_V22, true);
        let mut state = State::from_player(Player { position: start(i), velocity: VEL, grounded: false, crouched: false, jump_latched: false }, s.policy());
        let mut config = s.configuration();
        config.fixes.edgebug = true;
        for t in 0..6 {
            let input = playsrc_movement::StepInput { command_number: t, ..Default::default() };
            let r = playsrc_movement::step(&Moving(&scene, support), state, input, config, s.policy()).unwrap();
            state = r.state;
            if state.ground.is_some() {
                return state.edge_landing.is_some();
            }
        }
        false
    };
    let fixed = (0..PHASES).filter(|&i| outcome([0.0; 3], i)).count();
    let moving = (0..PHASES).filter(|&i| outcome([200.0, 0.0, 0.0], i)).count();
    let rising = (0..PHASES).filter(|&i| outcome([0.0, 0.0, 100.0], i)).count();
    assert!(fixed > 40, "{fixed}");
    assert_eq!((moving, rising), (0, 0));
}

/// A scroll press too early (on the landing tick itself, in the air) latches: no jump on v21 either. v22 edge-bugs instead of
/// taking the friction tick. Holding it through (a scroll player's latch) is the same.
#[test]
fn a_latched_scroll_jump_edge_bugs() {
    let scene = platform();
    for i in 0..PHASES {
        let old = run(PHYSICS_V21, false, &scene, start(i), VEL, |t| t == 0);
        let new = run(PHYSICS_V22, false, &scene, start(i), VEL, |t| t == 0);
        assert!(!old.jumped && !new.jumped, "phase {i}");
        if old.landed {
            assert_eq!(new.edge_bugs, 1, "phase {i}");
        }
    }
}

/// Far from any edge nothing changes, however the player lands, even slowly: Momentum delays a slow landing until the feet
/// touch; here only real edges are affected.
#[test]
fn landings_away_from_edges_are_v21() {
    let scene = platform();
    // (The rising ones: jumping up onto a ledge, the top reached with vz under NON_JUMP_VELOCITY.)
    for (vx, vz, z) in [(800.0, -400.0, 3.0), (800.0, -40.0, 1.5), (250.0, -5.0, 1.9), (0.0, -300.0, 2.0), (3000.0, -1200.0, 9.0), (250.0, 120.0, 0.5), (50.0, 139.0, 1.5), (800.0, 20.0, 1.0)] {
        for version_pair in [(true, false), (false, false)] {
            let (autohop, jump) = version_pair;
            let (a, b) = (settings(PHYSICS_V21, autohop), settings(PHYSICS_V22, autohop));
            let (mut x, mut y) = (Sim::new(&scene, a, [-512.0, 0.0, z], [vx, 0.0, vz]), Sim::new(&scene, b, [-512.0, 0.0, z], [vx, 0.0, vz]));
            for t in 0..30 {
                tick(&mut x, a, jump);
                let (undone, _) = tick(&mut y, b, jump);
                assert!(!undone, "vx {vx} vz {vz} tick {t}");
                assert_eq!(x.state.position, y.state.position);
                assert_eq!(x.state.velocity, y.state.velocity);
            }
        }
    }
}

/// How one path ends, whatever the sub-tick phase.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum End { Jump, Land, Bug, Clear }

fn end_of(o: &Outcome, vz: f32) -> End {
    if o.jumped { End::Jump } else if o.landed { End::Land } else if o.kind == Some(EdgeLandingKind::Slide) || (o.contact && o.kind.is_none() && o.after_vz > vz * 0.5) { End::Bug } else { End::Clear }
}

/// Bands of paths with more than one outcome over the sub-tick phases: 480 straight paths 0.05 units apart across the edge, each
/// at 40 phases (the start shifted along the path by up to a tick). Returns (paths with mixed outcomes, width in units).
fn lottery(version: u32, autohop: bool, vx: f32, vz: f32, z: f32) -> (u32, f32) {
    let scene = platform();
    let mut mixed = 0;
    for p in 0..480 {
        // Which x the path has at the height of the top if nothing is in the way, -8 .. 16 back from the corner (x = 16).
        let cross = 16.0 - 16.0 + p as f32 * 0.05;
        let ticks = z / -vz / 0.01;
        let mut seen: Vec<End> = Vec::new();
        for k in 0..40 {
            let shift = (ticks + k as f32 / 40.0) * 0.01;
            let pos = [cross - vx * shift, 0.0, -vz * shift];
            let e = end_of(&run(version, autohop, &scene, pos, [vx, 0.0, vz], |_| false), vz);
            if !seen.contains(&e) {
                seen.push(e);
            }
        }
        mixed += u32::from(seen.len() > 1);
        if std::env::var_os("EDGE_PATHS").is_some() && version == PHYSICS_V22 {
            eprintln!("path cross {cross:.2}: {seen:?}");
        }
    }
    (mixed, mixed as f32 * 0.05)
}

/// The same path at different sub-tick phases gets one outcome, apart from a sliver at the corner (gravity between ticks bends the
/// path by that much) and at the land / edge bug boundary. This is the consistency Momentum's full-tick slide is for: v16's lottery
/// between landing and edge-bugging is a whole tick of travel wide.
#[test]
fn one_path_has_one_outcome_at_every_phase() {
    for (vx, vz) in [(800.0f32, -400.0f32), (800.0, -150.0), (500.0, -700.0)] {
        let dx = vx * 0.01;
        // Two ticks up the path, so gravity doesn't bend the 40 starts apart.
        let z = -vz * 0.02;
        let (m16, w16) = lottery(PHYSICS_V16, true, vx, vz, z);
        let (m22, w22) = lottery(PHYSICS_V22, true, vx, vz, z);
        eprintln!("{vx} u/s, vz {vz}: paths with mixed outcomes v16 {m16} ({w16:.2} units), v22 {m22} ({w22:.2} units), tick of travel {dx}");
        assert!(w22 <= 2.0, "{vx} {vz}: v22 {w22} v16 {w16}");
    }
}

/// The landing's digest bytes: nothing while no edge landing is pending, so every older version keeps its digests.
#[test]
fn snapshot_bytes_only_change_while_one_is_pending() {
    let policy = Policy::default();
    let mut s = State::from_player(Player { position: [1.0, 2.0, 3.0], velocity: [4.0, 5.0, 6.0], grounded: true, crouched: false, jump_latched: false }, policy);
    let plain = s.snapshot_bytes();
    s.edge_landing = Some(playsrc_movement::EdgeLanding { kind: EdgeLandingKind::Slide, landed_velocity: [0.0; 3], air_velocity: [0.0; 3], air_base_velocity: [0.0; 3], air_surface_friction: 1.0 });
    assert!(s.snapshot_bytes().len() > plain.len());
    s.edge_landing = None;
    assert_eq!(s.snapshot_bytes(), plain);
}

/// A touch that changed the speed on the landing tick (a booster, a teleport), or game code moving the player: the landing
/// stands, exactly as v21.
#[test]
fn a_changed_landing_stands() {
    let scene = platform();
    let s = settings(PHYSICS_V22, true);
    let mut sim = Sim::new(&scene, s, start(30), VEL);
    while sim.state.edge_landing.is_none() {
        tick(&mut sim, s, false);
    }
    let landed = sim.state;
    assert!(sim.state.resolve_edge_landing(false, true) == false && sim.state.ground.is_some(), "moved");
    sim.state = landed;
    sim.state.velocity[0] += 1.0;
    assert!(sim.state.resolve_edge_landing(false, false) == false && sim.state.ground.is_some(), "speed changed");
    sim.state = landed;
    assert!(sim.state.resolve_edge_landing(true, false) == false && sim.state.ground.is_some(), "jump");
    assert_eq!(sim.state.edge_landing, None);
    sim.state = landed;
    assert!(sim.state.resolve_edge_landing(false, false) && sim.state.ground.is_none(), "taken back");
}

fn map_game(name: &str) -> Option<Game> {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    if !path.exists() {
        eprintln!("skipping: {name} not present");
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    Game::load(&bunnyhop_core::parse_bsp(&bytes).ok()?).ok()
}

/// A real ledge through the whole `Game::step`: bhop_eazy's block edge, a drop over it, 24 phases.
#[test]
fn real_ledge_through_game_step() {
    let Some(mut game) = map_game("bhop_eazy") else { return };
    let (edge, dir) = ([2008.0f32, -977.0, 224.0], [0.77f32, 0.64]);
    let l = dir[0].hypot(dir[1]);
    let d = [dir[0] / l, dir[1] / l];
    let yaw = d[1].atan2(d[0]).to_degrees();
    let (speed, vz) = (800.0f32, -400.0f32);
    let place = |game: &mut Game, version: u32, autohop: bool, phase: f32| {
        game.set_settings(settings(version, autohop));
        game.reset();
        let dx = speed * 0.01;
        let hit = [edge[0] - d[0] * dx * phase, edge[1] - d[1] * dx * phase, edge[2]];
        game.place_player([hit[0] - d[0] * dx * 3.0, hit[1] - d[1] * dx * 3.0, hit[2] - vz * 0.03 + 0.1]);
        game.state.velocity = [d[0] * speed, d[1] * speed, vz];
    };
    let cmd = |jump: bool| Cmd { forward: 0.0, side: 0.0, yaw, pitch: 0.0, buttons: if jump { IN_JUMP } else { 0 } };
    let mut bugs = 0;
    for p in 0..24 {
        let phase = p as f32 / 24.0;
        // Jump held on autohop: v21, bit for bit, snapshot included.
        let mut digests = Vec::new();
        for version in [PHYSICS_V21, PHYSICS_V22] {
            place(&mut game, version, true, phase);
            let mut d = Vec::new();
            for _ in 0..40 {
                game.step(cmd(true)).unwrap();
                d.push(game.snapshot_bytes());
                assert_eq!(game.events & EVENT_EDGEBUG, 0);
            }
            digests.push(d);
        }
        assert_eq!(digests[0], digests[1], "phase {phase}: jump held");
        // Released: exactly one landing event, then the edge bug on the next tick, no friction, no jump.
        place(&mut game, PHYSICS_V22, true, phase);
        let (mut landed, mut bug_tick, mut land_tick, mut jumped) = (0, None, None, false);
        let mut low = f32::MAX;
        for t in 0..40 {
            game.step(cmd(false)).unwrap();
            jumped |= game.events & EVENT_JUMPED != 0;
            if game.events & EVENT_LANDED != 0 {
                landed += 1;
                land_tick.get_or_insert(t);
            }
            if game.events & EVENT_EDGEBUG != 0 {
                bug_tick.get_or_insert(t);
            }
            if bug_tick.is_some_and(|b| t <= b + 4) {
                low = low.min(game.horizontal_speed());
            }
        }
        assert!(!jumped, "phase {phase}");
        if let Some(b) = bug_tick {
            bugs += 1;
            assert_eq!(land_tick, Some(b - 1), "phase {phase}: the landing tick comes first");
            assert!(landed <= 2, "phase {phase}: {landed} landings (one on the ledge, maybe one on the floor below)");
            assert!(low >= speed - 0.01, "phase {phase}: no friction, lowest {low}");
        }
        // A scroll press on the next tick: v21's state, whatever came before.
        for autohop in [true, false] {
            let run = |game: &mut Game, version: u32| {
                place(game, version, autohop, phase);
                for _ in 0..40 {
                    game.step(cmd(false)).unwrap();
                    if game.state.ground.is_some() {
                        game.step(cmd(true)).unwrap();
                        return Some((game.events & EVENT_JUMPED != 0, game.state.position, game.state.velocity));
                    }
                }
                None
            };
            let (a, b) = (run(&mut game, PHYSICS_V21), run(&mut game, PHYSICS_V22));
            assert_eq!(a, b, "phase {phase} autohop {autohop}: a press on the next tick");
            if let Some((j, ..)) = a {
                assert!(j, "phase {phase}: the press jumps");
            }
        }
    }
    eprintln!("bhop_eazy ledge: {bugs}/24 phases edge-bug");
    assert!(bugs > 8, "{bugs}");
}

/// A saved state keeps the pending landing: restoring it on the landing tick goes on the same way (Segmented, practice).
#[test]
fn a_saved_landing_tick_restores() {
    let Some(mut game) = map_game("bhop_eazy") else { return };
    game.set_settings(settings(PHYSICS_V22, true));
    game.reset();
    let (speed, vz) = (800.0f32, -400.0f32);
    let d = [0.77f32 / 1.0015, 0.64 / 1.0015];
    let yaw = d[1].atan2(d[0]).to_degrees();
    game.place_player([2008.0 - d[0] * 28.0, -977.0 - d[1] * 28.0, 224.0 + 12.1]);
    game.state.velocity = [d[0] * speed, d[1] * speed, vz];
    let cmd = Cmd { forward: 0.0, side: 0.0, yaw, pitch: 0.0, buttons: 0 };
    for _ in 0..12 {
        if game.state.edge_landing.is_some() {
            break;
        }
        game.step(cmd).unwrap();
    }
    assert!(game.state.edge_landing.is_some(), "the drop is an edge landing");
    let saved = game.save_state();
    let digest = game.snapshot_bytes();
    game.step(cmd).unwrap();
    assert_ne!(game.events & EVENT_EDGEBUG, 0);
    let after = game.snapshot_bytes();
    game.reset();
    game.restore_state(&saved);
    assert_eq!(game.snapshot_bytes(), digest);
    game.step(cmd).unwrap();
    assert_eq!(game.snapshot_bytes(), after);
}

/// Thin triggers (RNGFix's trigger jump): the landing tick is a v21 landing, so a thin teleport under the feet still fires on it. Every
/// 2-unit-or-thinner teleport on these maps, a drop over each side: a teleport on v21 is the same teleport on the same tick on v22.
#[test]
fn thin_teleports_still_fire_on_an_edge_landing() {
    let (mut sites, mut fired, mut edge_landings) = (0, 0, 0);
    for map in ["bhop_null_fix", "bhop_eazy", "bhop_eazy_v2", "bhop_2easy"] {
        let Some(mut game) = map_game(map) else { continue };
        game.set_settings(settings(PHYSICS_V22, true));
        game.reset();
        let pads: Vec<_> = game.teleports().into_iter().filter(|t| t.enabled && t.filter.is_none() && t.maxs[2] - t.mins[2] <= 2.0).take(60).collect();
        for pad in &pads {
            let (cx, cy) = ((pad.mins[0] + pad.maxs[0]) * 0.5, (pad.mins[1] + pad.maxs[1]) * 0.5);
            for (dx, dy) in [(1.0f32, 0.0f32), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)] {
                let half = if dx != 0.0 { (pad.maxs[0] - pad.mins[0]) * 0.5 } else { (pad.maxs[1] - pad.mins[1]) * 0.5 };
                for k in 0..8 {
                    // Lands within a tick of travel of the pad's far side (the block's edge if it covers it), with its hull's back on the pad.
                    let over = 16.0 + half - k as f32;
                    let (x, y, z) = (cx + dx * (over - 32.0), cy + dy * (over - 32.0), pad.mins[2] + 16.0);
                    let run = |game: &mut Game, version: u32| {
                        game.set_settings(settings(version, true));
                        game.reset();
                        game.place_player([x, y, z]);
                        game.state.velocity = [dx * 800.0, dy * 800.0, -400.0];
                        let mut edge = false;
                        for t in 0..8 {
                            game.step(Cmd::default()).unwrap();
                            edge |= game.edge_landing_observed.is_some();
                            if game.events & EVENT_TELEPORTED != 0 {
                                return (Some(t), game.state.position, edge);
                            }
                        }
                        (None, game.state.position, edge)
                    };
                    let (a, pa, _) = run(&mut game, PHYSICS_V21);
                    let (b, pb, edge) = run(&mut game, PHYSICS_V22);
                    sites += 1;
                    if a.is_some() {
                        fired += 1;
                        edge_landings += u32::from(edge);
                        assert_eq!((a, pa), (b, pb), "{map} pad {:?} x {x} y {y}", pad.mins);
                    }
                }
            }
        }
    }
    eprintln!("thin teleports: {sites} drops, {fired} teleport on v21 and on the same tick on v22, {edge_landings} of those are edge landings");
    if sites > 0 {
        assert!(edge_landings > 0, "the drops have to include edge landings");
    }
}

/// Prints the sweep tables of research/EDGEBUG-V22.md: `cargo test -p bunnyhop-core --test edgebug_v22 sweep_report -- --nocapture`.
/// Each row: 80 starts whose paths reach the top around the edge, over three ticks of travel. Counts: jump / lands (a friction tick
/// follows) / edge bug (a contact, fall speed gone, no friction) / clears (no contact, keeps the fall speed; past the edge from the start).
#[test]
fn sweep_report() {
    // Falls away along +x from z = 0 at x = -512... down to a crest at x = 0 over a drop: tan(deg) per unit.
    let downhill = |deg: f32| {
        let h = 512.0 * deg.to_radians().tan();
        Scene::new(vec![ConvexBrush::from_points(&[
            [-512.0, -512.0, -2048.0], [0.0, -512.0, -2048.0], [-512.0, 512.0, -2048.0], [0.0, 512.0, -2048.0],
            [-512.0, -512.0, h], [0.0, -512.0, 0.0], [-512.0, 512.0, h], [0.0, 512.0, 0.0],
        ], 0).expect("wedge")])
    };
    // Rises along +x from x = -512 up to a crest at x = 0 over a drop.
    let uphill = |deg: f32| {
        let h = 512.0 * deg.to_radians().tan();
        Scene::new(vec![ConvexBrush::from_points(&[
            [-512.0, -512.0, -2048.0], [0.0, -512.0, -2048.0], [-512.0, 512.0, -2048.0], [0.0, 512.0, -2048.0],
            [-512.0, -512.0, -h], [0.0, -512.0, 0.0], [-512.0, 512.0, -h], [0.0, 512.0, 0.0],
        ], 0).expect("wedge")])
    };
    let flat = platform();
    let row = |name: &str, scene: &Scene, spec: Settings, v: [f32; 3], surface: &dyn Fn(f32) -> f32, feet: f32| {
        let dx = v[0] * spec.tick_interval;
        let dz = v[2] * spec.tick_interval;
        #[derive(Default, Clone, Copy)]
        struct Tally { jump: u32, land: u32, bug: u32, clear: u32 }
        let (mut c16, mut c21h, mut c21, mut c22h, mut c22) = (Tally::default(), Tally::default(), Tally::default(), Tally::default(), Tally::default());
        let (mut s21, mut s22, mut vz22) = (Vec::new(), Vec::new(), Vec::new());
        for i in 0..PHASES {
            // The back of the hull (x - 16) meets the surface `reach` units before the crest; start 4 ticks earlier.
            let reach = -dx * 0.5 + i as f32 * (dx * 3.0) / PHASES as f32;
            let x = 16.0 - reach;
            let z = surface(-reach) + feet * spec.tick_interval * 25.0;
            let pos = [x - dx * 4.0, 0.0, z - dz * 4.0];
            let tally = |c: &mut Tally, o: &Outcome| {
                match end_of(o, v[2]) { End::Jump => c.jump += 1, End::Land => c.land += 1, End::Bug => c.bug += 1, End::Clear => c.clear += 1 }
            };
            let go = |version, jump: bool| run(version, spec.autohop, scene, pos, v, move |_| jump);
            tally(&mut c16, &go(PHYSICS_V16, false));
            tally(&mut c21h, &go(PHYSICS_V21, true));
            let o21 = go(PHYSICS_V21, false);
            tally(&mut c21, &o21);
            if o21.landed { s21.push(o21.after); }
            tally(&mut c22h, &go(PHYSICS_V22, true));
            let o22 = go(PHYSICS_V22, false);
            tally(&mut c22, &o22);
            if end_of(&o22, v[2]) == End::Bug { s22.push(o22.after); vz22.push(o22.after_vz); }
        }
        let range = |a: &[f32]| if a.is_empty() { "-".to_string() } else { format!("{:.0}..{:.0}", a.iter().copied().fold(f32::MAX, f32::min), a.iter().copied().fold(f32::MIN, f32::max)) };
        let t = |c: Tally| format!("{}/{}/{}/{}", c.jump, c.land, c.bug, c.clear);
        eprintln!("| {name} | {} | {} | {} | {} | {} | {} | {} | {} |", t(c21h), t(c22h), t(c16), t(c21), t(c22), range(&s21), range(&s22), range(&vz22));
    };
    eprintln!("| case | v21 held | v22 held | v16 released | v21 released | v22 released | speed 3 ticks later: v21 landed | v22 edge bug | v22 edge bug vz |");
    eprintln!("|---|---|---|---|---|---|---|---|---|");
    let auto = settings(PHYSICS_V22, true);
    let none = |_: f32| 0.0;
    for (speed, vz) in [(300.0, -300.0), (300.0, -80.0), (500.0, -400.0), (800.0, -150.0), (800.0, -400.0), (800.0, -1000.0), (1500.0, -600.0), (3000.0, -1500.0)] {
        row(&format!("flat {speed} u/s, vz {vz}"), &flat, auto, [speed, 0.0, vz], &none, 0.0);
    }
    let low = Settings { gravity: 400.0, ..auto };
    row("low gravity 800, vz -400", &flat, low, [800.0, 0.0, -400.0], &none, 0.0);
    row("EZ Scroll 800, vz -400", &flat, Settings { autohop: false, ..auto }, [800.0, 0.0, -400.0], &none, 0.0);
    row("Legit Scroll 800, vz -400", &flat, Settings { autohop: false, air_accelerate: 100.0, max_speed: 250.0, stamina: true, ..auto }, [800.0, 0.0, -400.0], &none, 0.0);
    for deg in [10.0f32, 30.0, 44.0] {
        let tan = deg.to_radians().tan();
        row(&format!("{deg} deg downhill crest, 800, vz -1200"), &downhill(deg), auto, [800.0, 0.0, -1200.0], &|x: f32| -x * tan, 0.0);
        row(&format!("{deg} deg uphill crest, 800, vz -400"), &uphill(deg), auto, [800.0, 0.0, -400.0], &|x: f32| x * tan, 0.0);
    }
}
