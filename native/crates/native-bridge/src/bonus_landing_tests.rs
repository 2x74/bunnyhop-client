//! An Infinite flight that lands in a bonus start (website flight-landing.ts landingBonusRestart and its tests in
//! apps/web/test/infinite-flight.test.ts). The bridge's part: what the timer holds after the landing tick, which is what
//! the host decides from (track_style_switch.hpp landing_bonus), and the bonus's own restart point the host then
//! restarts at in Normal.
use super::*;

/// A live session on `map` in `style` from `spawn`, the timer on `zones`.
unsafe fn session(map: &str, style: &CStr, zones: &[BhZone], spawn: [f32; 3]) -> *mut BhContext {
    let map = map_fixture(map);
    let options = if style == c"infinite" {
        infinite_options()
    } else {
        BhRunOptions::default()
    };
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, map.as_ptr(), ptr::null()), 1);
        assert_eq!(bh_style_set(c, style.as_ptr()), 1);
        assert_eq!(
            bh_run_configure(c, &options, zones.as_ptr(), zones.len()),
            1
        );
        assert_eq!(bh_reset(c), 1);
        assert_eq!(bh_set_position(c, spawn[0], spawn[1], spawn[2], 0.0), 1);
        c
    }
}

unsafe fn run_state(c: *mut BhContext) -> BhRunState {
    let mut run = BhRunState::default();
    assert_eq!(unsafe { bh_run_state(c, &mut run) }, 1);
    run
}

/// The landing tick: the landing spot, the player after that tick's step, and the timer after it.
struct Landing {
    tick: u32,
    spot: [f32; 3],
    after: BhState,
    timer: BhRunState,
}

/// Plays `route` (command, noclip key on) until its first landing, then `then` to the end or a finish.
unsafe fn land(
    c: *mut BhContext,
    route: &dyn Fn(u32, &BhState) -> (BhCmd, bool),
    ticks: u32,
) -> Landing {
    let mut s = BhState::default();
    unsafe {
        assert_eq!(bh_state(c, &mut s), 1);
        for i in 0..ticks {
            let (cmd, noclip) = route(i, &s);
            assert_eq!(bh_flight_set(c, u32::from(noclip)), 1);
            assert_eq!(bh_step(c, &cmd, &mut s), 1);
            if s.events & EVENT_FLIGHT_LANDED != 0 {
                let (spot, _) = (*c).map.as_ref().unwrap().game.flight_landing().unwrap();
                return Landing {
                    tick: s.tick,
                    spot,
                    after: s,
                    timer: run_state(c),
                };
            }
        }
    }
    panic!("the route never landed");
}

/// Keeps stepping `command` until the timer finishes (or `ticks` pass): the timer at the end.
unsafe fn finish(
    c: *mut BhContext,
    command: &dyn Fn(u32, &BhState) -> BhCmd,
    ticks: u32,
) -> BhRunState {
    let mut s = BhState::default();
    unsafe {
        assert_eq!(bh_state(c, &mut s), 1);
        for i in 0..ticks {
            assert_eq!(bh_step(c, &command(i, &s), &mut s), 1);
            let run = run_state(c);
            if run.status == 2 {
                return run;
            }
        }
        run_state(c)
    }
}

const STYLE_SPAWN: [f32; 3] = [560.0, -352.0, 70.0];
/// SELFTEST_ZONES' bonus 1 start is x 100..140: the hull touches it for x 84..156.
const BONUS_EDGE: f32 = 156.0;

/// web `intoBonusStart`: settle in the main start, fly back through the bonus start (it arms there), turn, and let go
/// just before the next step would leave it, still moving out.
fn into_bonus_start() -> impl Fn(u32, &BhState) -> (BhCmd, bool) {
    let phase = std::cell::Cell::new(0);
    move |i, s| {
        if i < 30 {
            return (BhCmd::default(), false);
        }
        let x = s.position[0];
        if phase.get() == 0 && x < 50.0 {
            phase.set(1);
        }
        if phase.get() == 1 && x <= BONUS_EDGE && x + s.velocity[0] * 0.01 > BONUS_EDGE {
            phase.set(2);
        }
        match phase.get() {
            0 => (forward(180.0, 0.0), true),
            1 => (forward(0.0, 0.0), true),
            _ => (forward(0.0, 0.0), false),
        }
    }
}

fn walk_on(_: u32, _: &BhState) -> BhCmd {
    forward(0.0, 0.0)
}

/// The website's test bot (tools/verify/bot.ts botCommand), which runs SELFTEST_ZONES' bonus 1.
fn bonus_bot(i: u32, _: &BhState) -> BhCmd {
    if i < 30 {
        return BhCmd::default();
    }
    let phase = i % 80;
    let yaw = f64::from(if phase < 40 { phase } else { 80 - phase }) * 0.55 - 11.0;
    let pitch = (f64::from(i % 200) - 100.0) * 0.05;
    let jump = if i > 60 { game::IN_JUMP } else { 0 };
    let duck = if i % 300 > 280 { game::IN_DUCK } else { 0 };
    BhCmd {
        forward: 450.0,
        side: if phase < 40 { -450.0 } else { 450.0 },
        yaw: yaw as f32,
        pitch: pitch as f32,
        buttons: jump | duck | IN_FORWARD,
    }
}

/// What the host's restart does next (track_style_switch.hpp landing_bonus, then the bonus key's restart,
/// restart_placement.hpp place): bonus 1 in Normal from its start zone's middle, a fresh recording.
unsafe fn normal_bonus_restart(c: *mut BhContext, zones: &[BhZone], start: BhZone) -> BhState {
    unsafe {
        assert_eq!(bh_style_set(c, c"autohop".as_ptr()), 1);
        assert_eq!(
            bh_run_configure(c, &BhRunOptions::default(), zones.as_ptr(), zones.len()),
            1
        );
        assert_eq!(bh_reset(c), 1);
        let middle = |axis: usize| {
            ((f64::from(start.mins[axis]) + f64::from(start.maxs[axis])) / 2.0) as f32
        };
        assert_eq!(
            bh_set_position(c, middle(0), middle(1), start.mins[2] + 1.0, 0.0),
            1
        );
        assert_eq!(
            bh_record_begin(c, ptr::null(), c"autohop".as_ptr(), c"bonus".as_ptr(), 100),
            1
        );
        assert_eq!(flight(c).allowed, 0, "Normal never flies");
        let mut s = BhState::default();
        assert_eq!(bh_state(c, &mut s), 1);
        s
    }
}

#[test]
#[ignore = "requires bhop_eazy.bsp (BH_V19_MAPS)"]
fn a_landing_at_the_bonus_start_edge_starts_an_infinite_bonus_run_on_its_tick() {
    let zones = selftest_zones();
    let bonus_start = zones[2];
    unsafe {
        let c = session("bhop_eazy", c"infinite", &zones, STYLE_SPAWN);
        let l = land(c, &into_bonus_start(), 300);
        assert!(
            bonus_start.contains(l.spot, false),
            "landed in the bonus start, near its edge"
        );
        assert!(
            !bonus_start.contains(l.after.position, false),
            "and the same tick's step left it"
        );
        assert_eq!(
            (
                l.timer.track,
                l.timer.in_start,
                l.timer.status,
                l.timer.start_tick
            ),
            (1, 0, 1, l.tick)
        );
        // Left alone, it's an Infinite bonus run (the verifier rejects it: bonus runs are Normal only).
        let end = finish(c, &walk_on, 300);
        assert_eq!((end.status, end.track), (2, 1));
        assert_eq!((*c).map.as_ref().unwrap().filter.id, "infinite");
        // The restart: Normal from bonus 1's start, recording, and it runs bonus 1 to the finish.
        let spawn = normal_bonus_restart(c, &zones, bonus_start);
        assert!(bonus_start.contains(spawn.position, false));
        let end = finish(c, &bonus_bot, 1500);
        assert_eq!(
            (end.status, end.track, end.recording, end.recording_valid),
            (2, 1, 1, 1)
        );
        bh_destroy(c);
    }
}

#[test]
#[ignore = "requires bhop_eazy.bsp (BH_V19_MAPS)"]
fn the_timer_keeps_the_bonus_where_a_main_start_overlaps_the_landing() {
    // Sol's overlap: a main start x 130..140 inside the bonus start's x 100..140, the landing spot in both.
    let selftest = selftest_zones();
    let overlap = BhZone {
        kind: 0,
        track: 0,
        index: 0,
        mins: [130.0, -480.0, 0.0],
        maxs: [140.0, -224.0, 300.0],
    };
    let zones: Vec<BhZone> = selftest.iter().copied().chain([overlap]).collect();
    unsafe {
        let c = session("bhop_eazy", c"infinite", &zones, STYLE_SPAWN);
        let l = land(c, &into_bonus_start(), 300);
        assert!(overlap.contains(l.spot, false) && selftest[2].contains(l.spot, false));
        // The timer prefers its current track's start: bonus 1 started, so the host restarts bonus 1.
        assert_eq!(
            (l.timer.track, l.timer.status, l.timer.start_tick),
            (1, 1, l.tick)
        );
        let end = finish(c, &walk_on, 300);
        assert_eq!(
            (end.status, end.track),
            (2, 1),
            "left alone, an Infinite bonus run"
        );
        bh_destroy(c);
    }
}

#[test]
#[ignore = "requires bhop_advi_wood_rg1.bsp (BH_V19_MAPS)"]
fn an_airborne_landing_in_a_tall_bonus_start_restarts_on_the_ground() {
    let path = PathBuf::from(std::env::var_os("BH_V19_MAPS").unwrap())
        .join("bhop_advi_wood_rg1.zones.json");
    let zones_json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let zones: Vec<BhZone> = zones_json["zones"]
        .as_array()
        .unwrap()
        .iter()
        .map(|z| BhZone {
            kind: if z["kind"] == "start" { 0 } else { 1 },
            track: z["track"].as_u64().unwrap_or(0) as u32,
            index: 0,
            mins: std::array::from_fn(|i| z["mins"][i].as_f64().unwrap() as f32),
            maxs: std::array::from_fn(|i| z["maxs"][i].as_f64().unwrap() as f32),
        })
        .collect();
    let bonus_start = *zones.iter().find(|z| z.kind == 0 && z.track == 1).unwrap();
    // Reset at the foot of the tall start, rise 20 ticks, let go: the landing is over 256 units up, inside it.
    let rise = |i: u32, _: &BhState| {
        let up = BhCmd {
            buttons: game::IN_JUMP,
            ..BhCmd::default()
        };
        if i < 20 {
            (up, true)
        } else {
            (BhCmd::default(), false)
        }
    };
    unsafe {
        let c = session(
            "bhop_advi_wood_rg1",
            c"infinite",
            &zones,
            [-192.0, -13965.0, 10317.0],
        );
        let l = land(c, &rise, 21);
        assert!(l.spot[2] > bonus_start.mins[2] + 256.0);
        assert!(bonus_start.contains(l.spot, false));
        assert_eq!(
            l.after.grounded, 0,
            "the landing is in midair: no spawn there"
        );
        assert_eq!((l.timer.track, l.timer.in_start, l.timer.status), (1, 1, 0));
        // Bonus 1's own restart point is on the ground.
        let spawn = normal_bonus_restart(c, &zones, bonus_start);
        assert!(bonus_start.contains(spawn.position, false));
        assert!(
            spawn.position[2] < bonus_start.mins[2] + 2.0,
            "settled onto the floor: {:?}",
            spawn.position
        );
        let mut s = BhState::default();
        assert_eq!(bh_step(c, &BhCmd::default(), &mut s), 1);
        assert_eq!(s.grounded, 1);
        bh_destroy(c);
    }
}

#[test]
#[ignore = "requires bhop_eazy.bsp (BH_V19_MAPS)"]
fn a_landing_in_the_main_start_changes_nothing() {
    // The review route: fly out of the main start ducked, fly back in, let go inside it and walk out to the end.
    let phase = std::cell::Cell::new(0);
    let route = |i: u32, s: &BhState| {
        if i < 30 {
            return (BhCmd::default(), false);
        }
        if phase.get() == 0 && s.position[0] < 500.0 {
            phase.set(1);
        }
        if phase.get() == 1 && s.position[0] >= 556.0 {
            phase.set(2);
        }
        let ducked = |yaw| BhCmd {
            buttons: IN_FORWARD | game::IN_DUCK,
            ..forward(yaw, 0.0)
        };
        match phase.get() {
            0 => (ducked(180.0), true),
            1 => (ducked(0.0), true),
            _ => (forward(0.0, 0.0), false),
        }
    };
    unsafe {
        let c = session("bhop_eazy", c"infinite", &selftest_zones(), STYLE_SPAWN);
        let l = land(c, &route, 600);
        assert_eq!(
            l.timer.track, 0,
            "the host's landing check leaves the main track alone"
        );
        let end = finish(c, &walk_on, 600);
        assert_eq!((end.status, end.track), (2, 0));
        assert_eq!((*c).map.as_ref().unwrap().filter.id, "infinite");
        bh_destroy(c);
    }
}
