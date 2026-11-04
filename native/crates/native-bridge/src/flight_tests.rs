//! Infinite's noclip key (flight.rs): while the flag is on every live command carries `IN_FLIGHT` and the core flies
//! it, the recording stays open, and anything that starts the attempt over turns the flag off.
use super::*;
use bunnyhop_core::game::{EVENT_FLIGHT, EVENT_FLIGHT_LANDED, IN_FLIGHT};

const ZONES: [BhZone; 2] = [
    BhZone {
        kind: 0,
        track: 0,
        index: 0,
        mins: [-100000.0; 3],
        maxs: [100000.0; 3],
    },
    BhZone {
        kind: 1,
        track: 0,
        index: 0,
        mins: [200000.0; 3],
        maxs: [200100.0; 3],
    },
];

fn infinite_options() -> BhRunOptions {
    BhRunOptions {
        cap_enabled: 0,
        start_reentry_cap: styles::start_reentry_cap("infinite"),
        ..BhRunOptions::default()
    }
}

unsafe fn infinite_map(map: &CString) -> *mut BhContext {
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, map.as_ptr(), ptr::null()), 1);
        assert_eq!(bh_style_set(c, c"infinite".as_ptr()), 1);
        assert_eq!(
            bh_run_configure(c, &infinite_options(), ZONES.as_ptr(), ZONES.len()),
            1
        );
        assert_eq!(bh_reset(c), 1);
        c
    }
}

unsafe fn flight(c: *mut BhContext) -> BhFlightState {
    let mut state = BhFlightState::default();
    assert_eq!(unsafe { bh_flight_state(c, &mut state) }, 1);
    state
}

/// One live tick with no keys: its events, and whether the command the core stepped carried the bit.
unsafe fn tick(c: *mut BhContext) -> (u32, bool) {
    unsafe {
        let mut state = BhState::default();
        assert_eq!(bh_step(c, &BhCmd::default(), &mut state), 1);
        let mut stepped = BhCmd::default();
        assert_eq!(bh_last_command(c, &mut stepped), 1);
        (state.events, stepped.buttons & IN_FLIGHT != 0)
    }
}

#[test]
fn the_flag_flies_every_live_command_and_the_recording_stays_open() {
    let fixture = Fixture::new();
    let map = fixture.file("flight.bsp", &ground_bsp(&[]));
    unsafe {
        let c = infinite_map(&map);
        assert_eq!(
            bh_record_begin(
                c,
                ptr::null(),
                c"infinite".as_ptr(),
                c"flight".as_ptr(),
                100
            ),
            1
        );
        assert_eq!((flight(c).allowed, flight(c).on), (1, 0));
        assert_eq!(bh_flight_set(c, 1), 1);
        for _ in 0..5 {
            let (events, carried) = tick(c);
            assert!(carried);
            assert_ne!(events & EVENT_FLIGHT, 0);
        }
        assert_eq!((flight(c).on, flight(c).flying), (1, 1));
        assert_eq!(bh_flight_set(c, 0), 1);
        let (events, carried) = tick(c);
        assert!(!carried);
        assert_eq!(
            events & (EVENT_FLIGHT | EVENT_FLIGHT_LANDED),
            EVENT_FLIGHT_LANDED
        );
        assert_eq!(flight(c).flying, 0);
        let mut run = BhRunState::default();
        assert_eq!(bh_run_state(c, &mut run), 1);
        assert_eq!(
            (run.recording, run.recording_valid, run.total_commands),
            (1, 1, 6)
        );
        bh_destroy(c);
    }
}

#[test]
fn only_infinite_on_physics_v24_flies() {
    let fixture = Fixture::new();
    let map = fixture.file("flight.bsp", &ground_bsp(&[]));
    unsafe {
        let c = infinite_map(&map);
        assert_eq!(bh_style_set(c, c"autohop".as_ptr()), 1);
        assert_eq!(flight(c).allowed, 0);
        assert_eq!(bh_flight_set(c, 1), 0);
        // The bit itself does nothing in any other style: the core masks it out.
        let mut state = BhState::default();
        let forged = BhCmd {
            buttons: IN_FLIGHT,
            ..BhCmd::default()
        };
        assert_eq!(bh_step(c, &forged, &mut state), 1);
        assert_eq!(state.events & EVENT_FLIGHT, 0);
        let mut v23 = styles::settings("infinite").unwrap();
        v23.physics = 23;
        assert_eq!(bh_style_set(c, c"infinite".as_ptr()), 1);
        assert_eq!(bh_set_settings(c, &v23), 1);
        assert_eq!(bh_flight_set(c, 1), 0);
        bh_destroy(c);
    }
}

#[test]
fn starting_the_attempt_over_turns_the_flag_off() {
    let fixture = Fixture::new();
    let map = fixture.file("flight.bsp", &ground_bsp(&[]));
    let infinite = styles::settings("infinite").unwrap();
    unsafe {
        let c = infinite_map(&map);
        let checkpoint = bh_practice_save(c, 0.0, 0.0);
        assert_ne!(checkpoint, 0);
        let starts_over: [(&str, &dyn Fn() -> c_int); 7] = [
            ("reset", &|| bh_reset(c)),
            ("restart point", &|| bh_set_position(c, 0.0, 0.0, 0.0, 0.0)),
            ("style", &|| bh_style_set(c, c"infinite".as_ptr())),
            ("track and zones", &|| {
                bh_run_configure(c, &infinite_options(), ZONES.as_ptr(), ZONES.len())
            }),
            ("zones cleared", &|| bh_run_clear(c)),
            ("settings", &|| bh_set_settings(c, &infinite)),
            ("checkpoint", &|| {
                bh_practice_restore(
                    c,
                    checkpoint,
                    &mut BhCmd::default(),
                    &mut BhSnapshot::default(),
                )
            }),
        ];
        for (name, start_over) in starts_over {
            assert_eq!(bh_flight_set(c, 1), 1, "{name}");
            assert!(tick(c).1, "{name}");
            assert_eq!(start_over(), 1, "{name}");
            assert_eq!(flight(c).on, 0, "{name}");
            assert!(!tick(c).1, "{name}");
        }
        assert_eq!(bh_flight_set(c, 1), 1);
        assert_eq!(bh_load_map(c, map.as_ptr(), ptr::null()), 1);
        assert_eq!(flight(c).on, 0, "map load");
        bh_destroy(c);
    }
}

/// The website's SELFTEST_ZONES on bhop_eazy (tools/verify/record.ts): the main start at x 540..580 is synthetic.
fn selftest_zones() -> [BhZone; 7] {
    let zone = |kind, track, index, mins, maxs| BhZone {
        kind,
        track,
        index,
        mins,
        maxs,
    };
    [
        zone(0, 0, 0, [-480.0, -480.0, 65.031], [-224.0, -224.0, 192.031]),
        zone(1, 0, 0, [-1120.0, -480.0, 65.031], [-736.0, -96.0, 192.031]),
        zone(0, 1, 0, [100.0, -480.0, 0.0], [140.0, -224.0, 300.0]),
        zone(3, 1, 1, [200.0, -480.0, 0.0], [210.0, -224.0, 300.0]),
        zone(1, 1, 0, [280.0, -480.0, 0.0], [320.0, -224.0, 300.0]),
        zone(0, 0, 0, [540.0, -480.0, 0.0], [580.0, -224.0, 300.0]),
        zone(1, 0, 0, [690.0, -480.0, 0.0], [720.0, -224.0, 300.0]),
    ]
}

fn map_fixture(name: &str) -> CString {
    let root = std::env::var_os("BH_V19_MAPS")
        .expect("set BH_V19_MAPS to a directory with the original BSPs");
    let path = PathBuf::from(root).join(format!("{name}.bsp"));
    assert!(path.is_file(), "missing {}", path.display());
    CString::new(path.to_str().unwrap()).unwrap()
}

/// What the website's route test measured, from its own run of the route (see `fly_route`).
struct RouteResult {
    /// SHA-256 of one line per tick: tick, events, position and velocity bits, and the timer's status, start, end,
    /// in-start, pending start, track and update flags.
    digest: String,
    flights: u32,
    started_at: u32,
    /// The fastest flight tick's speed (3D, f64 of the f32 velocity).
    top_flight_speed: f64,
    landing: Option<[f32; 3]>,
}

/// Flies a route on bhop_eazy from the website's STYLE_SPAWN with the noclip key as `route(i)` says, through the live
/// path: the flag, the style filter, the core and the timer.
unsafe fn fly_route(route: &dyn Fn(u32) -> (BhCmd, bool), ticks: u32) -> RouteResult {
    use sha2::{Digest, Sha256};
    let map = map_fixture("bhop_eazy");
    let zones = selftest_zones();
    let mut result = RouteResult {
        digest: String::new(),
        flights: 0,
        started_at: 0,
        top_flight_speed: 0.0,
        landing: None,
    };
    let mut rows = String::new();
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, map.as_ptr(), ptr::null()), 1);
        assert_eq!(bh_style_set(c, c"infinite".as_ptr()), 1);
        assert_eq!(
            bh_run_configure(c, &infinite_options(), zones.as_ptr(), zones.len()),
            1
        );
        assert_eq!(bh_reset(c), 1);
        assert_eq!(bh_set_position(c, 560.0, -352.0, 70.0, 0.0), 1);
        let mut run = BhRunState::default();
        for i in 0..ticks {
            let (cmd, noclip) = route(i);
            assert_eq!(bh_flight_set(c, u32::from(noclip)), 1);
            let mut s = BhState::default();
            assert_eq!(bh_step(c, &cmd, &mut s), 1);
            assert_eq!(bh_run_state(c, &mut run), 1);
            if run.update_flags & 1 != 0 && result.started_at == 0 {
                result.started_at = s.tick;
            }
            if s.events & EVENT_FLIGHT != 0 {
                result.flights += 1;
                let [x, y, z] = s.velocity.map(f64::from);
                result.top_flight_speed =
                    result.top_flight_speed.max((x * x + y * y + z * z).sqrt());
            }
            if let Some((spot, _)) = (*c).map.as_ref().unwrap().game.flight_landing() {
                result.landing = Some(spot);
            }
            let bits = s
                .position
                .iter()
                .chain(&s.velocity)
                .map(|v| v.to_bits().to_string())
                .collect::<Vec<_>>();
            let status = ["idle", "running", "finished"][run.status as usize];
            rows += &format!(
                "{} {} {} {status} {} {} {} {} {} {}\n",
                s.tick,
                s.events,
                bits.join(","),
                run.start_tick,
                run.end_tick,
                run.in_start,
                run.pending_start,
                run.track,
                run.update_flags
            );
            if run.status == 2 {
                break;
            }
        }
        bh_destroy(c);
    }
    result.digest = Sha256::digest(rows.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    result
}

const IN_FORWARD: u32 = 1 << 3;

fn forward(yaw: f32, pitch: f32) -> BhCmd {
    BhCmd {
        forward: 450.0,
        side: 0.0,
        yaw,
        pitch,
        buttons: IN_FORWARD,
    }
}

/// Review P1 (web infinite-flight.test.ts "review fixes 11-04"): one flight tick pitched into the floor inside the
/// start, then walking. The landing puts the player at x 639, past the start (its last touching x is 596), and the old
/// timer started a run there. Nothing starts now.
#[test]
#[ignore = "requires bhop_eazy.bsp (BH_V19_MAPS)"]
fn a_landing_relocated_past_the_start_starts_nothing_on_bhop_eazy() {
    let route = |i: u32| {
        if i == 0 {
            (forward(0.0, 89.0), true)
        } else {
            (forward(0.0, -1.0), false)
        }
    };
    let r = unsafe { fly_route(&route, 45) };
    assert_eq!(
        r.landing.map(|p| p.map(f32::to_bits)),
        Some([1142931659, 3283091456, 1115686201])
    );
    assert!(r.landing.unwrap()[0] > 596.0);
    assert_eq!((r.flights, r.started_at), (1, 0));
    assert_eq!(
        r.digest,
        "90931de5f51539f1d25674d6e4aba1773f553d0c8b6e176ed6982404e980c170"
    );
}

/// Review P2: turning while flying never goes past 3500 u/s, and reaches it (3640.86 before the core's cap).
#[test]
#[ignore = "requires bhop_eazy.bsp (BH_V19_MAPS)"]
fn turning_flights_stay_within_3500_on_bhop_eazy() {
    let turning = |pitch: f32, degrees: u32| {
        move |i: u32| {
            if i < 30 {
                (BhCmd::default(), false)
            } else {
                (forward(((i - 30) * degrees % 360) as f32, pitch), true)
            }
        }
    };
    let level = unsafe { fly_route(&turning(0.0, 1), 1030) };
    assert_eq!(level.flights, 1000);
    assert_eq!(level.top_flight_speed.to_bits(), 0x40ab57ffffec0b6a);
    assert!(level.top_flight_speed <= 3500.0 && level.top_flight_speed > 3499.0);
    assert_eq!(
        level.digest,
        "570acecd2812fd57923d0225af9ccf85647f23a040be01cfad7bcfb439d7afbf"
    );
    let climbing = unsafe { fly_route(&turning(-60.0, 5), 1030) };
    assert_eq!(climbing.top_flight_speed.to_bits(), 0x40ab57fffff1ea7f);
    assert!(climbing.top_flight_speed <= 3500.0);
    assert_eq!(
        climbing.digest,
        "88cd09d69772033e3f6a9e640e53ba8a226cbe73ab6b04ea94dff635e069922c"
    );
}
