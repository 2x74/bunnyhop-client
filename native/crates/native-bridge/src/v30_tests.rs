use super::*;
use std::time::{Duration, Instant};

unsafe fn await_map(ctx: *mut BhContext) -> c_int {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let status = unsafe { bh_load_map_poll(ctx) };
        if status != 0 {
            return status;
        }
        assert!(Instant::now() < deadline, "map load timed out");
        std::thread::yield_now();
    }
}

#[test]
fn asynchronous_map_load_keeps_context_thread_affinity_and_can_cancel_or_retry() {
    let fixture = Fixture::new();
    let path = fixture.file("async.bsp", &ground_bsp(&[]));
    unsafe {
        let ctx = bh_create();
        assert_eq!(bh_load_map_begin(ctx, path.as_ptr(), ptr::null()), 1);
        assert_eq!(await_map(ctx), 1);
        let expected = (*ctx).map.as_ref().unwrap().game.snapshot_bytes();
        assert_eq!(
            bh_load_map_begin(ctx, c"/absent/map.bsp".as_ptr(), ptr::null()),
            1
        );
        assert_eq!(await_map(ctx), -1);
        assert_eq!((*ctx).map.as_ref().unwrap().game.snapshot_bytes(), expected);
        let oversized = fixture.file("oversized.bsp", &[]);
        std::fs::OpenOptions::new()
            .write(true)
            .open(oversized.to_str().unwrap())
            .unwrap()
            .set_len(768 * 1024 * 1024 + 1)
            .unwrap();
        assert_eq!(bh_load_map_begin(ctx, oversized.as_ptr(), ptr::null()), 1);
        assert_eq!(await_map(ctx), -1);
        assert!(
            CStr::from_ptr(bh_last_error(ctx))
                .to_str()
                .unwrap()
                .contains("768 MiB")
        );
        assert_eq!(bh_load_map_begin(ctx, path.as_ptr(), ptr::null()), 1);
        assert_eq!(bh_load_map_cancel(ctx), 1);
        assert_eq!(bh_load_map_poll(ctx), -1);
        assert_eq!((*ctx).map.as_ref().unwrap().game.snapshot_bytes(), expected);
        assert_eq!(bh_load_map_begin(ctx, path.as_ptr(), ptr::null()), 1);
        assert_eq!(await_map(ctx), 1);
        assert_eq!((*ctx).map.as_ref().unwrap().game.snapshot_bytes(), expected);
        let command = BhCmd {
            forward: 450.0,
            buttons: 2,
            ..BhCmd::default()
        };
        let mut state = BhState::default();
        assert_eq!(bh_step(ctx, &command, &mut state), 1);
        bh_destroy(ctx);
        // Dropping an in-flight job does not transfer its context or wait for its result.
        let ctx = bh_create();
        assert_eq!(bh_load_map_begin(ctx, path.as_ptr(), ptr::null()), 1);
        bh_destroy(ctx);
    }
}

fn map_fixture(name: &str) -> CString {
    let root = std::env::var_os("BH_V19_MAPS")
        .expect("set BH_V19_MAPS to the SHA-verified original BSP directory");
    let path = PathBuf::from(root).join(format!("{name}.bsp"));
    assert!(path.is_file(), "missing {}", path.display());
    CString::new(path.to_str().unwrap()).unwrap()
}

unsafe fn core_bytes(ctx: *mut BhContext) -> Vec<u8> {
    unsafe { (*ctx).map.as_ref().unwrap().game.snapshot_bytes() }
}

#[test]
#[ignore = "requires the original v0.0.30 BSP fixtures (BH_V19_MAPS)"]
fn v19_practice_restores_spawned_instances_and_script_scope_after_restart() {
    let cases = [
        ("bhop_cutekittenz2", [5110.5, 3202.0, -2200.0], "1", 40),
        ("bhop_akb_tutorial", [7496.0, -3304.0, 1992.0], "", 20),
        ("kz_bhop_liminal", [512.0, -7296.0, 8000.0], "", 10),
        ("bhop_treason", [8416.0, 4096.0, 7820.0], "", 25),
    ];
    unsafe {
        let ctx = bh_create();
        for (map, position, name, warmup) in cases {
            let path = map_fixture(map);
            assert_eq!(bh_load_map(ctx, path.as_ptr(), ptr::null()), 1);
            let initial = core_bytes(ctx);
            let base_entities = (*ctx).map.as_ref().unwrap().game.entities.len();
            assert_eq!(
                bh_set_position(ctx, position[0], position[1], position[2], 0.0),
                1
            );
            let name = CString::new(name).unwrap();
            assert_eq!(bh_set_restart_names(ctx, name.as_ptr(), c"".as_ptr()), 1);
            let command = BhCmd::default();
            let mut state = BhState::default();
            for _ in 0..warmup {
                assert_eq!(bh_step(ctx, &command, &mut state), 1);
            }
            if map == "bhop_cutekittenz2" || map == "bhop_akb_tutorial" {
                assert!((*ctx).map.as_ref().unwrap().game.entities.len() > base_entities);
            }
            if map == "bhop_treason" {
                assert_eq!((*ctx).map.as_ref().unwrap().game.gravity_scale, 50.0);
            }
            let map_state = (*ctx).map.as_mut().unwrap();
            let mut first_visibility = HashMap::new();
            for (model, visible, _) in map_state.game.brush_states() {
                first_visibility.entry(model).or_insert(visible);
            }
            let transforms: HashMap<_, _> = map_state
                .game
                .brush_transforms()
                .into_iter()
                .map(|(model, origin, angles)| (model, (origin, angles)))
                .collect();
            for (model, (origin, angles)) in transforms {
                if model == 0 {
                    continue;
                }
                let transform = map_state.transform(model).unwrap();
                // Duplicate model slots deliberately match the website's single-slot renderer.
                assert_eq!(transform.origin, origin);
                assert_eq!(transform.angles, angles);
                assert_eq!(transform.visible != 0, first_visibility[&model]);
            }
            let saved_bytes = core_bytes(ctx);
            let checkpoint = bh_practice_save(ctx, 17.0, -10.0);
            assert_ne!(checkpoint, 0);
            let mut expected = Vec::new();
            for _ in 0..100 {
                assert_eq!(bh_step(ctx, &command, &mut state), 1);
                expected.push(core_bytes(ctx));
            }
            assert_eq!(bh_reset(ctx), 1);
            assert_eq!(
                core_bytes(ctx),
                initial,
                "{map}: restart clears runtime state"
            );
            let mut snapshot = BhSnapshot::default();
            let mut view = BhCmd::default();
            assert_eq!(
                bh_practice_restore(ctx, checkpoint, &mut view, &mut snapshot),
                1
            );
            assert_eq!((view.yaw, view.pitch), (17.0, -10.0));
            assert_eq!(
                core_bytes(ctx),
                saved_bytes,
                "{map}: complete snapshot restore"
            );
            for bytes in expected {
                assert_eq!(bh_step(ctx, &command, &mut state), 1);
                assert_eq!(
                    core_bytes(ctx),
                    bytes,
                    "{map}: restored future world trajectory"
                );
            }
            assert_eq!(bh_practice_free(ctx, checkpoint), 1);
            eprintln!("{map}: practice snapshot/reset/restore and 100 future ticks identical");
        }
        bh_destroy(ctx);
    }
}

fn original_zones(path: &CString) -> Vec<BhZone> {
    let path = Path::new(path.to_str().unwrap()).with_extension("zones.json");
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    value["zones"]
        .as_array()
        .unwrap()
        .iter()
        .map(|z| {
            let vector = |name: &str| std::array::from_fn(|i| z[name][i].as_f64().unwrap() as f32);
            BhZone {
                kind: match z["kind"].as_str().unwrap() {
                    "start" => 0,
                    "end" => 1,
                    "stage" => 2,
                    _ => 3,
                },
                track: z["track"].as_u64().unwrap_or(0) as u32,
                index: z["index"].as_u64().unwrap_or(0) as u32,
                mins: vector("mins"),
                maxs: vector("maxs"),
            }
        })
        .collect()
}

unsafe fn roundtrip(
    ctx: *mut BhContext,
    fixture: &Fixture,
    name: &str,
    zones: &[BhZone],
    track: u32,
) {
    unsafe {
        assert_eq!(bh_reset(ctx), 1);
        if track != 0 {
            let start = zones
                .iter()
                .find(|z| z.kind == 0 && z.track == track)
                .unwrap();
            assert_eq!(
                bh_set_position(
                    ctx,
                    (start.mins[0] + start.maxs[0]) * 0.5,
                    (start.mins[1] + start.maxs[1]) * 0.5,
                    start.mins[2] + 1.0,
                    0.0
                ),
                1
            );
        }
        assert_eq!(
            bh_record_begin(
                ctx,
                ptr::null(),
                c"autohop".as_ptr(),
                c"offline-v19-probe".as_ptr(),
                25
            ),
            1
        );
        let ticks = if name == "bhop_rpg" { 1800 } else { 600 };
        let mut expected = Vec::new();
        for tick in 0..ticks {
            let command = BhCmd {
                forward: if tick % 120 < 60 { 450.0 } else { 0.0 },
                side: if tick % 80 < 40 { 450.0 } else { -450.0 },
                yaw: tick as f32 * 1.25,
                buttons: if tick % 60 < 10 { 6 } else { 2 },
                ..BhCmd::default()
            };
            let mut state = BhState::default();
            assert_eq!(bh_step(ctx, &command, &mut state), 1);
            expected.push(state);
        }
        let map = (*ctx).map.as_mut().unwrap();
        let mut data = map.recorder.take().unwrap().data;
        // This local playback fixture is deliberately unfinished. No server submission is made.
        data.start_tick = 0;
        data.end_tick = ticks;
        data.track = track;
        let path = fixture.0.join(format!("{name}-{track}.bhr"));
        data.write_bhr(&path).unwrap();
        let decoded = replay::Decoded::load(&path).unwrap();
        assert_eq!(decoded.settings.physics, game::PHYSICS_LATEST);
        assert_eq!(decoded.options.rules, 2);
        let path = CString::new(path.to_str().unwrap()).unwrap();
        assert_eq!(bh_replay_load(ctx, path.as_ptr()), 1);
        let mut snapshot = BhSnapshot::default();
        for state in &expected {
            assert_eq!(bh_replay_step(ctx, &mut snapshot), 1);
            state_equal(snapshot.player, *state);
        }
        assert_eq!(bh_replay_seek(ctx, ticks / 2, &mut snapshot), 1);
        state_equal(snapshot.player, expected[(ticks / 2 - 1) as usize]);
        assert_eq!(bh_replay_seek(ctx, ticks, &mut snapshot), 1);
        state_equal(snapshot.player, expected[ticks as usize - 1]);
        assert_eq!(bh_replay_stop(ctx), 1);
        eprintln!(
            "{name} track {track}: BHR encode/decode/playback/seek, {ticks} f32 player states identical"
        );
    }
}

#[test]
#[ignore = "requires original BSPs and release zones (BH_V19_MAPS)"]
fn v19_native_replay_roundtrips_on_release_maps() {
    let names = [
        "bhop_ceaseless",
        "bhop_cutekittenz2",
        "bhop_vandora",
        "bhop_ponpon_fix",
        "bhop_retrowave",
        "bhop_akb_tutorial",
        "bhop_k2",
        "bhop_k3",
        "bhop_prig_skok_2",
        "bhop_rpg",
        "bhop_collective",
        "bhop_crutle3_css",
        "bhop_crutle4_css",
        "kz_bhop_liminal",
        "bhop_api_kowka",
        "bhop_sina_fix",
        "bhop_treason",
        "bhop_profane",
        "bhop_playboy_csgo",
        "bhop_gigaheish_fix",
        "bhop_accelerate",
        "bhop_quack",
        "bhop_rainbowroad_fix",
        "kz_bhop_global",
    ];
    let fixture = Fixture::new();
    unsafe {
        let ctx = bh_create();
        for name in names {
            let path = map_fixture(name);
            let zones = original_zones(&path);
            assert_eq!(bh_load_map(ctx, path.as_ptr(), ptr::null()), 1);
            assert_eq!((*ctx).settings.physics, game::PHYSICS_LATEST);
            let options = BhRunOptions {
                rules: 2,
                ..BhRunOptions::default()
            };
            assert_eq!(
                bh_run_configure(ctx, &options, zones.as_ptr(), zones.len()),
                1
            );
            roundtrip(ctx, &fixture, name, &zones, 0);
            if name == "bhop_ceaseless" {
                roundtrip(ctx, &fixture, name, &zones, 1);
            }
        }
        bh_destroy(ctx);
    }
}
