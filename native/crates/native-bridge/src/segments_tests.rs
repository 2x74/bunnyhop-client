use super::*;

unsafe fn step(ctx: *mut BhContext, from: u32, count: u32) {
    unsafe {
        for tick in from..from + count {
            let command = BhCmd {
                forward: 450.0,
                yaw: tick as f32,
                buttons: 8,
                ..BhCmd::default()
            };
            let look = BhLookSampleV2 {
                base: tick as f64,
                k: 0.022,
                epoch: tick,
                frames: 1,
                ..BhLookSampleV2::default()
            };
            assert_eq!(
                bh_step_look_v2(ctx, &command, &look, &mut BhState::default()),
                1
            );
        }
    }
}
unsafe fn restore(ctx: *mut BhContext, handle: u32) {
    unsafe {
        assert_eq!(
            bh_segment_restore(
                ctx,
                handle,
                &mut BhCmd::default(),
                &mut BhSnapshot::default()
            ),
            1,
            "{}",
            CStr::from_ptr(bh_last_error(ctx)).to_string_lossy()
        );
    }
}
#[test]
fn segmented_retains_abandoned_branches_timer_filter_views_events_and_restart_paths() {
    let fixture = Fixture::new();
    let path = prop_fixture(&fixture);
    unsafe {
        let ctx = bh_create();
        assert_eq!(bh_load_map(ctx, path.as_ptr(), fixture.root().as_ptr()), 1);
        assert_eq!(
            bh_run_configure(
                ctx,
                &BhRunOptions {
                    rules: 2,
                    ..BhRunOptions::default()
                },
                timer_zones().as_ptr(),
                2
            ),
            1
        );
        assert_eq!(
            bh_record_begin(
                ctx,
                ptr::null(),
                c"segmented".as_ptr(),
                c"test".as_ptr(),
                10
            ),
            1
        );
        step(ctx, 0, 20);
        let a = bh_practice_save(ctx, 19.0, 0.0);
        let bytes_a = (*ctx).map.as_ref().unwrap().game.snapshot_bytes();
        let timer_a = (*ctx).map.as_ref().unwrap().timer.as_ref().unwrap().json();
        step(ctx, 1000, 10);
        assert_eq!(bh_record_cosmetic(ctx, 7), 1);
        assert_eq!(bh_record_inspect(ctx, 1), 1);
        let b = bh_practice_save(ctx, 1009.0, 0.0);
        let bytes_b = (*ctx).map.as_ref().unwrap().game.snapshot_bytes();
        restore(ctx, a);
        assert_eq!((*ctx).map.as_ref().unwrap().game.snapshot_bytes(), bytes_a);
        assert_eq!(
            (*ctx).map.as_ref().unwrap().timer.as_ref().unwrap().json(),
            timer_a
        );
        step(ctx, 2000, 5);
        restore(ctx, b);
        assert_eq!((*ctx).map.as_ref().unwrap().game.snapshot_bytes(), bytes_b);
        let m = (*ctx).map.as_ref().unwrap();
        let data = &m.recorder.as_ref().unwrap().data;
        assert_eq!(
            data.commands
                .iter()
                .map(|c| c.yaw.to_bits())
                .collect::<Vec<_>>(),
            (0..20)
                .chain(1000..1010)
                .map(|n| (n as f32).to_bits())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            data.looks
                .iter()
                .map(|l| l.unwrap().epoch)
                .collect::<Vec<_>>(),
            (0..20).chain(1000..1010).collect::<Vec<_>>()
        );
        assert_eq!(
            data.checkpoints
                .iter()
                .map(|cp| cp.tick)
                .collect::<Vec<_>>(),
            [10, 20, 30]
        );
        assert_eq!(
            data.segments.iter().map(|l| l.tick).collect::<Vec<_>>(),
            [30]
        );
        assert_eq!(data.cosmetic, [replay::CosmeticEvent { tick: 30, kind: 7 }]);
        assert_eq!(data.inspect, [replay::CosmeticEvent { tick: 30, kind: 1 }]);
        let raw = data.encode_raw().unwrap();
        let decoded = replay::Decoded::parse(&raw).unwrap();
        assert_eq!(
            decoded.segments[0].position.map(f32::to_bits),
            BhState::from(&m.game).position.map(f32::to_bits)
        );
        assert!(
            replay::Decoded::parse(&raw[..raw.len() - 1])
                .err()
                .unwrap()
                .contains("bad segment loads")
        );
        assert_eq!(bh_reset(ctx), 1);
        assert_eq!(
            bh_record_begin(
                ctx,
                ptr::null(),
                c"segmented".as_ptr(),
                c"test".as_ptr(),
                10
            ),
            1
        );
        restore(ctx, b);
        assert_eq!((*ctx).map.as_ref().unwrap().game.snapshot_bytes(), bytes_b);
        assert_eq!(bh_segment_loads(ctx), 1);
        assert_eq!(bh_practice_enter(ctx, 0), 1);
        assert_eq!(bh_segment_loads(ctx), -1);
        assert_eq!(
            bh_segment_restore(ctx, a, &mut BhCmd::default(), &mut BhSnapshot::default()),
            0
        );
        bh_destroy(ctx);
    }
}

#[test]
fn segmented_rejects_practice_marks_without_mutating_world() {
    let fixture = Fixture::new();
    let path = prop_fixture(&fixture);
    unsafe {
        let ctx = bh_create();
        assert_eq!(bh_load_map(ctx, path.as_ptr(), fixture.root().as_ptr()), 1);
        assert_eq!(
            bh_run_configure(
                ctx,
                &BhRunOptions {
                    rules: 2,
                    ..BhRunOptions::default()
                },
                timer_zones().as_ptr(),
                2
            ),
            1
        );
        let practice = bh_practice_save(ctx, 0.0, 0.0);
        assert_ne!(practice, 0);
        assert_eq!(
            bh_record_begin(
                ctx,
                ptr::null(),
                c"segmented".as_ptr(),
                c"test".as_ptr(),
                10
            ),
            1
        );
        step(ctx, 0, 5);
        let before = (*ctx).map.as_ref().unwrap().game.snapshot_bytes();
        assert_eq!(
            bh_segment_restore(
                ctx,
                practice,
                &mut BhCmd::default(),
                &mut BhSnapshot::default()
            ),
            0
        );
        assert_eq!((*ctx).map.as_ref().unwrap().game.snapshot_bytes(), before);
        bh_destroy(ctx);
    }
}

#[test]
fn segmented_finished_archive_is_frozen_while_new_checkpoints_keep_recording() {
    let fixture = Fixture::new();
    let path = prop_fixture(&fixture);
    unsafe {
        let ctx = bh_create();
        assert_eq!(bh_load_map(ctx, path.as_ptr(), fixture.root().as_ptr()), 1);
        let options = BhRunOptions {
            rules: 2,
            ..BhRunOptions::default()
        };
        assert_eq!(
            bh_run_configure(ctx, &options, timer_zones().as_ptr(), 2),
            1
        );
        assert_eq!(
            bh_record_begin(
                ctx,
                ptr::null(),
                c"segmented".as_ptr(),
                c"test".as_ptr(),
                10
            ),
            1
        );
        let command = BhCmd {
            forward: 450.0,
            buttons: 8,
            ..BhCmd::default()
        };
        let mut state = BhState::default();
        let mut run = BhRunState::default();
        for _ in 0..40 {
            assert_eq!(bh_step(ctx, &BhCmd::default(), &mut state), 1);
        }
        let checkpoint = bh_practice_save(ctx, 17.0, -10.0);
        let changed = BhRecordOptionsV29 {
            timed_input: 1,
            null_binds: 1,
            ..BhRecordOptionsV29::default()
        };
        assert_eq!(bh_record_options_v29(ctx, &changed), 1);
        restore(ctx, checkpoint);
        let mut restored = BhRecordOptionsV29::default();
        assert_eq!(bh_record_options_read_v29(ctx, &mut restored), 1);
        assert_eq!((restored.timed_input, restored.null_binds), (0, 0));
        for _ in 0..1000 {
            assert_eq!(bh_step(ctx, &command, &mut state), 1);
            assert_eq!(bh_run_state(ctx, &mut run), 1);
            if run.status == 2 {
                break;
            }
        }
        assert_eq!(run.status, 2);
        assert_eq!(bh_record_end(ctx), 1);
        let frozen = (*ctx)
            .map
            .as_ref()
            .unwrap()
            .completed_record
            .as_ref()
            .unwrap()
            .encode_raw()
            .unwrap();
        for _ in 0..5 {
            assert_eq!(bh_step(ctx, &command, &mut state), 1);
        }
        assert_eq!(
            (*ctx)
                .map
                .as_ref()
                .unwrap()
                .completed_record
                .as_ref()
                .unwrap()
                .encode_raw()
                .unwrap(),
            frozen
        );
        let after_finish = bh_practice_save(ctx, 0.0, 0.0);
        assert_ne!(after_finish, 0);
        restore(ctx, after_finish);
        assert_eq!(
            (*ctx).map.as_ref().unwrap().recorded_commands as u32,
            run.last_tick + 5
        );
        restore(ctx, checkpoint);
        assert_eq!((*ctx).map.as_ref().unwrap().game.tick, 40);
        bh_destroy(ctx);
    }
}

#[test]
#[ignore = "requires original release BSPs (BH_V19_MAPS)"]
fn segmented_v19_snapshots_retain_script_instances_and_gravity_on_every_tick() {
    let directory = std::env::var("BH_V19_MAPS").unwrap();
    for (map, position, warmup) in [
        ("bhop_akb_tutorial", [7496.0, -3304.0, 1992.0], 20),
        ("bhop_treason", [8416.0, 4096.0, 7820.0], 25),
    ] {
        unsafe {
            let ctx = bh_create();
            let path = CString::new(format!("{directory}/{map}.bsp")).unwrap();
            assert_eq!(bh_load_map(ctx, path.as_ptr(), ptr::null()), 1);
            let entities = (*ctx).map.as_ref().unwrap().game.entities.len();
            let options = BhRunOptions {
                rules: 2,
                ..BhRunOptions::default()
            };
            assert_eq!(
                bh_run_configure(ctx, &options, timer_zones().as_ptr(), 2),
                1
            );
            assert_eq!(
                bh_set_position(ctx, position[0], position[1], position[2], 0.0),
                1
            );
            assert_eq!(
                bh_record_begin(
                    ctx,
                    ptr::null(),
                    c"segmented".as_ptr(),
                    c"test".as_ptr(),
                    10
                ),
                1
            );
            for _ in 0..warmup {
                assert_eq!(bh_step(ctx, &BhCmd::default(), &mut BhState::default()), 1);
            }
            let m = (*ctx).map.as_ref().unwrap();
            if map == "bhop_akb_tutorial" {
                assert!(m.game.entities.len() > entities);
            } else {
                assert_eq!(m.game.gravity_scale, 50.0);
            }
            let checkpoint = bh_practice_save(ctx, 0.0, 0.0);
            assert_ne!(checkpoint, 0);
            let mut expected = Vec::new();
            for _ in 0..100 {
                assert_eq!(bh_step(ctx, &BhCmd::default(), &mut BhState::default()), 1);
                let m = (*ctx).map.as_ref().unwrap();
                expected.push((m.game.snapshot_bytes(), m.timer.as_ref().unwrap().json()));
            }
            assert_eq!(bh_reset(ctx), 1);
            assert_eq!(
                bh_record_begin(
                    ctx,
                    ptr::null(),
                    c"segmented".as_ptr(),
                    c"test".as_ptr(),
                    10
                ),
                1
            );
            restore(ctx, checkpoint);
            for (bytes, timer) in expected {
                assert_eq!(bh_step(ctx, &BhCmd::default(), &mut BhState::default()), 1);
                let m = (*ctx).map.as_ref().unwrap();
                assert_eq!(m.game.snapshot_bytes(), bytes, "{map}: full snapshot");
                assert_eq!(m.timer.as_ref().unwrap().json(), timer, "{map}: timer");
            }
            bh_destroy(ctx);
        }
    }
}
