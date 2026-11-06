//! Landing spot (game/landing.rs): the prediction against closed-form ballistics and against the simulation itself
//! (the player dropped with no input on real maps lands where the prediction said), and that it changes no state.
//! Test maps are gitignored; each test skips (with a note) when its map is absent.

use bunnyhop_core::game::{EVENT_TELEPORTED, LANDING_GROUND, LANDING_NONE, LANDING_TELEPORT};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

fn load(name: &str) -> Option<Game> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping {name}: {} not found", path.display());
        return None;
    };
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    Some(Game::load(&bsp).unwrap())
}

/// A tiny deterministic PRNG (xorshift), so the sweeps are reproducible.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 40) as f32 / (1u64 << 24) as f32
    }
    fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.next()
    }
}

fn airborne(game: &mut Game, position: [f32; 3], velocity: [f32; 3]) {
    game.reset();
    game.state.position = position;
    game.state.velocity = velocity;
    game.state.ground = None;
}

/// bhop_eazy's start room: a flat floor at z 64 (the start zone's floor), open for a few hundred units.
const EAZY_START: [f32; 3] = [-352.0, -352.0, 64.0];

#[test]
fn flat_floor_matches_closed_form_ballistics() {
    let Some(mut game) = load("bhop_eazy") else { return };
    // The floor right under the start (a straight-down hull trace).
    let probe = game.trace_player_hull([EAZY_START[0], EAZY_START[1], 160.0], [EAZY_START[0], EAZY_START[1], 0.0]);
    let floor = probe.end[2];
    assert!(probe.fraction < 1.0 && probe.normal.unwrap()[2] > 0.99, "a flat floor: {probe:?}");
    for gravity in [800.0f32, 400.0] {
        let mut settings = Settings::css_bhop();
        settings.gravity = gravity;
        game.set_settings(settings);
        for (h, vx, vy, vz) in [(40.0f32, 120.0f32, 0.0f32, 0.0f32), (8.0, 0.0, -40.0, 290.0), (60.0, 60.0, 60.0, -150.0), (2.0, 0.0, 0.0, 301.993)] {
            let p = [EAZY_START[0] - 40.0, EAZY_START[1] + 20.0, floor + h];
            let r = game.predict_landing(p, [vx, vy, vz], false, 4.0);
            // z(t) = h + vz t - g t^2 / 2 = 0
            let t = (vz + (vz * vz + 2.0 * gravity * h).sqrt()) / gravity;
            let expect = [p[0] + vx * t, p[1] + vy * t, floor];
            assert_eq!(r.kind, LANDING_GROUND, "g {gravity} h {h} v ({vx}, {vy}, {vz}): {r:?}");
            for k in 0..3 {
                assert!((r.position[k] - expect[k]).abs() < 0.75, "g {gravity} axis {k}: {:?} vs {expect:?}", r.position);
            }
            // The chords cut the arc's corner by at most a unit: the time is within a chord's worth of the closed form.
            assert!((r.seconds - t).abs() < 0.01, "time {} vs {t}", r.seconds);
            assert!(r.normal[2] > 0.99);
            // The pieces join up into the path that ends at the landing.
            let last = r.pieces.last().unwrap();
            let s = last.seconds;
            let end: [f32; 3] = std::array::from_fn(|k| last.start[k] + last.velocity[k] * s + 0.5 * last.acceleration[k] * s * s);
            for k in 0..3 {
                assert!((end[k] - r.position[k]).abs() < 1.0, "path end {end:?} vs {:?}", r.position);
            }
        }
    }
}

#[test]
fn map_gravity_scale_and_cap() {
    let Some(mut game) = load("bhop_eazy") else { return };
    let p = [EAZY_START[0], EAZY_START[1], 64.0 + 100.0];
    let full = game.predict_landing(p, [200.0, 0.0, 0.0], false, 4.0);
    game.gravity_scale = 0.25;
    let quarter = game.predict_landing(p, [200.0, 0.0, 0.0], false, 4.0);
    game.gravity_scale = 1.0;
    // A quarter of the gravity: twice the fall time, twice the distance.
    assert_eq!(full.kind, LANDING_GROUND);
    assert_eq!(quarter.kind, LANDING_GROUND);
    assert!((quarter.seconds / full.seconds - 2.0).abs() < 0.02, "{} vs {}", quarter.seconds, full.seconds);
    // The time cap: nothing found within it.
    let short = game.predict_landing(p, [0.0, 0.0, 0.0], false, 0.1);
    assert_eq!(short.kind, LANDING_NONE);
    assert!((short.seconds - 0.1).abs() < 1e-4);
    assert!((short.position[2] - (p[2] - 0.5 * 800.0 * 0.01)).abs() < 0.01);
    // Embedded at the start: nothing.
    let embedded = game.predict_landing([EAZY_START[0], EAZY_START[1], 0.0], [0.0; 3], false, 1.0);
    assert_eq!(embedded.kind, LANDING_NONE);
    // Non-finite input: nothing, no panic.
    assert_eq!(game.predict_landing([f32::NAN, 0.0, 0.0], [0.0; 3], false, 1.0).kind, LANDING_NONE);
}

#[test]
fn query_changes_no_state() {
    let Some(mut game) = load("bhop_eazy") else { return };
    airborne(&mut game, [EAZY_START[0], EAZY_START[1], 140.0], [400.0, 300.0, 250.0]);
    game.step(Cmd::default()).unwrap();
    let before = game.snapshot_bytes();
    let events = game.events;
    for k in 0..50 {
        let _ = game.predict_landing([EAZY_START[0] + k as f32 * 40.0, EAZY_START[1], 140.0], [900.0, -200.0, 100.0], k % 2 == 0, 4.0);
    }
    assert_eq!(game.snapshot_bytes(), before);
    assert_eq!(game.events, events);
    // And the next tick is the one it would have been without the queries.
    let mut twin = load("bhop_eazy").unwrap();
    airborne(&mut twin, [EAZY_START[0], EAZY_START[1], 140.0], [400.0, 300.0, 250.0]);
    twin.step(Cmd::default()).unwrap();
    for _ in 0..30 {
        game.step(Cmd::default()).unwrap();
        twin.step(Cmd::default()).unwrap();
    }
    assert_eq!(game.snapshot_bytes(), twin.snapshot_bytes());
}

/// What the simulation did with a player dropped at `p` moving at `v` and no input.
#[derive(Debug, PartialEq)]
enum Outcome {
    Landed([f32; 3]),
    Teleported([f32; 3]),
    /// Something the prediction doesn't model (a booster, water, a ladder, a hurt that isn't a reset) or no landing.
    Other,
}

fn simulate(game: &mut Game, p: [f32; 3], v: [f32; 3], ticks: usize) -> Outcome {
    airborne(game, p, v);
    for tick in 0..ticks {
        let before = game.state.position;
        game.step(Cmd::default()).unwrap();
        if game.events & EVENT_TELEPORTED != 0 {
            // Dropped inside a teleport volume (the prediction ignores the ones you're in already): not a real case.
            if tick < 2 {
                return Outcome::Other;
            }
            return Outcome::Teleported(if game.touch_origin[0].is_finite() { game.touch_origin } else { before });
        }
        if game.state.base_velocity != [0.0; 3] || game.state.water_level > 0 || game.state.mode != playsrc_movement::Mode::Walk {
            return Outcome::Other;
        }
        if game.state.ground.is_some() {
            return Outcome::Landed(game.state.position);
        }
    }
    Outcome::Other
}

/// Drops the player all over `map` with random velocities (no input) and checks the prediction made beforehand: a
/// landing within a tick's movement (plus the 2-unit ground probe) of where the simulation landed, a teleport where it
/// teleported. Returns (agreeing, compared).
fn sweep(map: &str, seed: u64, samples: usize) -> Option<(usize, usize)> {
    let mut game = load(map)?;
    let tick = game.settings.tick_interval;
    let spawn = game.state.position;
    let mut rng = Rng(seed);
    let (mut agree, mut compared, mut tries) = (0, 0, 0);
    let mut kinds = [0usize; 3];
    while compared < samples && tries < samples * 40 {
        tries += 1;
        let p = [spawn[0] + rng.range(-3000.0, 3000.0), spawn[1] + rng.range(-3000.0, 3000.0), spawn[2] + rng.range(-200.0, 600.0)];
        // Inside the map: room for the hull, and something below within 1500 units.
        let down = game.trace_player_hull(p, [p[0], p[1], p[2] - 1500.0]);
        if down.start_solid || down.fraction >= 1.0 || down.fraction * 1500.0 < 24.0 {
            continue;
        }
        let a = rng.range(0.0, std::f32::consts::TAU);
        let speed = rng.range(0.0, 1400.0);
        let v = [speed * a.cos(), speed * a.sin(), rng.range(-300.0, 320.0)];
        game.reset();
        let prediction = game.predict_landing(p, v, false, 4.0);
        let outcome = simulate(&mut game, p, v, (4.0 / tick) as usize);
        let horizontal = (v[0] * v[0] + v[1] * v[1]).sqrt();
        let near = |a: [f32; 3], b: [f32; 3], slack: f32| {
            ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt() <= horizontal * tick + slack && (a[2] - b[2]).abs() <= 4.0 + slack
        };
        let ok = match outcome {
            Outcome::Other => continue,
            Outcome::Landed(at) => prediction.kind == LANDING_GROUND && near(prediction.position, at, 4.0),
            // The game touches triggers once a tick; the sweep finds the entry within that tick's movement.
            Outcome::Teleported(at) => prediction.kind == LANDING_TELEPORT && near(prediction.position, at, 40.0),
        };
        compared += 1;
        kinds[prediction.kind as usize] += 1;
        if ok {
            agree += 1;
        } else {
            eprintln!("{map}: p {p:?} v {v:?}: predicted {} at {:?} ({} s), simulated {outcome:?}", prediction.kind, prediction.position, prediction.seconds);
        }
    }
    eprintln!("{map}: {agree}/{compared} agree (predicted ground {}, teleport {}, none {})", kinds[1], kinds[2], kinds[0]);
    Some((agree, compared))
}

#[test]
fn prediction_matches_the_simulation_on_real_maps() {
    // Flat blocks (bhop_eazy), ledges and teleport floors (bhop_bfur, bhop_kotodama), displacements and ramps
    // (bhop_arcane_v1, bhop_badges).
    let mut total = (0, 0);
    for (i, map) in ["bhop_eazy", "bhop_bfur", "bhop_kotodama", "bhop_arcane_v1", "bhop_badges"].into_iter().enumerate() {
        let Some((a, n)) = sweep(map, 0x9e37_79b9_7f4a_7c15 ^ i as u64, 300) else { continue };
        assert!(n >= 100, "{map}: only {n} drops compared");
        assert!(a as f32 >= n as f32 * 0.95, "{map}: {a}/{n} agree");
        total.0 += a;
        total.1 += n;
    }
    eprintln!("all maps: {}/{} agree", total.0, total.1);
}
