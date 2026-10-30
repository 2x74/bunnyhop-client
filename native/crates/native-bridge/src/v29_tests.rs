use super::*;
use serde_json::json;

#[test]
fn legit_scroll_strips_all_turn_bits() {
    let mut filter = styles::Filter::new("scroll", 18);
    for (grounded, on_ladder) in [(1, 0), (0, 0), (0, 1)] {
        let command = BhCmd {
            buttons: (1 << 6) | (1 << 7) | (1 << 8) | (1 << 3),
            ..BhCmd::default()
        };
        let state = BhState {
            grounded,
            on_ladder,
            ..BhState::default()
        };
        assert_eq!(filter.apply(command, state).buttons, 1 << 3);
    }
}

fn sample_recording(options: BhRecordOptionsV29) -> recording::ReplayData {
    recording::ReplayData {
        options,
        header: json!({
            "settings": recording::settings_json(BhSettings::default()),
            "timerRules": 2,
            "map": "fixture",
            "mapSha256": "00".repeat(32),
            "style": "autohop",
            "zones": [],
            "clientBuild": "native/test",
            "player": "test",
            "recordedAt": 0,
            "checkpointInterval": 100
        }),
        commands: vec![BhCmd::default()],
        looks: vec![None],
        checkpoints: vec![],
        start_tick: 0,
        end_tick: 1,
        track: 0,
        cosmetic: vec![],
        inspect: vec![],
        packed_loadout: None,
            segments: Vec::new(),
    }
}

#[test]
fn bhts_roundtrip_timed_flag_and_strict_recognized_trailer() {
    let data = sample_recording(BhRecordOptionsV29 {
        yaw_speed: 300.0,
        angle_speed_key: 2.5,
        timed_input: 1,
        ..BhRecordOptionsV29::default()
    });
    let raw = data.encode_raw().unwrap();
    let trailer = raw.len() - 12;
    assert_eq!(
        &raw[trailer..],
        &[0x42, 0x48, 0x54, 0x53, 0, 0, 0x96, 0x43, 0, 0, 0x20, 0x40]
    );
    assert_eq!(u16::from_le_bytes(raw[6..8].try_into().unwrap()) & 16, 16);
    let decoded = replay::Decoded::parse(&raw).unwrap();
    let info: serde_json::Value = serde_json::from_slice(decoded.info.as_bytes()).unwrap();
    assert_eq!(
        info["turnSpeed"],
        json!({"yawSpeed": 300.0, "angleSpeedKey": 2.5})
    );
    assert_eq!(info["timedInput"], true);
    let legacy = replay::Decoded::parse(&raw[..trailer]).unwrap();
    let info: serde_json::Value = serde_json::from_slice(legacy.info.as_bytes()).unwrap();
    assert!(info.get("turnSpeed").is_none());
    for length in 4..12 {
        assert!(replay::Decoded::parse(&raw[..trailer + length]).is_err());
    }
    for value in [f32::NAN, f32::INFINITY, 59.0, 721.0] {
        let mut corrupt = raw.clone();
        corrupt[trailer + 4..trailer + 8].copy_from_slice(&value.to_le_bytes());
        assert!(replay::Decoded::parse(&corrupt).is_err());
    }
}

#[test]
fn null_binds_flag_matches_the_website_header() {
    let plain = sample_recording(BhRecordOptionsV29::default())
        .encode_raw()
        .unwrap();
    assert_eq!(u16::from_le_bytes(plain[6..8].try_into().unwrap()) & 8, 0);
    let info: serde_json::Value =
        serde_json::from_slice(replay::Decoded::parse(&plain).unwrap().info.as_bytes()).unwrap();
    assert!(info.get("nullBinds").is_none());
    let raw = sample_recording(BhRecordOptionsV29 {
        null_binds: 1,
        ..BhRecordOptionsV29::default()
    })
    .encode_raw()
    .unwrap();
    // replay.ts FLAG_NULL_BINDS = 1 << 3
    assert_eq!(u16::from_le_bytes(raw[6..8].try_into().unwrap()) & 8, 8);
    let info: serde_json::Value =
        serde_json::from_slice(replay::Decoded::parse(&raw).unwrap().info.as_bytes()).unwrap();
    assert_eq!(info["nullBinds"], true);
    let invalid = BhRecordOptionsV29 {
        null_binds: 2,
        ..BhRecordOptionsV29::default()
    };
    assert!(invalid.checked().is_err());
}

#[test]
fn v29_layout_freezing_and_observation_preserve_simulation() {
    assert_eq!(size_of::<BhRecordOptionsV29>(), 24);
    assert_eq!(size_of::<BhTimingSegmentV2>(), 72);
    assert_eq!(bh_v29_check_abi(1, 24, 72), 1);
    assert_eq!(bh_v29_check_abi(2, 24, 72), 0);
    assert_eq!(bh_v29_check_abi(1, 20, 72), 0);
    let fixture = Fixture::new();
    let map = fixture.file("fixture.bsp", &bsp(&[]));
    unsafe {
        let c = bh_create();
        let control = bh_create();
        assert_eq!(bh_load_map(c, map.as_ptr(), ptr::null()), 1);
        assert_eq!(bh_load_map(control, map.as_ptr(), ptr::null()), 1);
        let zones = timer_zones();
        assert_eq!(
            bh_run_configure(c, &BhRunOptions::default(), zones.as_ptr(), zones.len()),
            1
        );
        assert_eq!(
            bh_record_begin(c, ptr::null(), c"autohop".as_ptr(), c"test".as_ptr(), 100),
            1
        );
        let mut options = BhRecordOptionsV29::default();
        options.yaw_speed = 300.0;
        assert_eq!(bh_record_options_v29(c, &options), 1);
        assert_eq!(bh_timing_observe(c, 1), 1);
        for _ in 0..10 {
            let mut observed = BhState::default();
            let mut expected = BhState::default();
            assert_eq!(bh_step(c, &BhCmd::default(), &mut observed), 1);
            assert_eq!(bh_step(control, &BhCmd::default(), &mut expected), 1);
            state_equal(observed, expected);
            assert_eq!(
                (*c).map.as_ref().unwrap().game.snapshot_bytes(),
                (*control).map.as_ref().unwrap().game.snapshot_bytes()
            );
        }
        options.timed_input = 1;
        assert_eq!(bh_record_options_v29(c, &options), 1);
        options.timed_input = 0;
        options.null_binds = 1;
        assert_eq!(bh_record_options_v29(c, &options), 1);
        options.null_binds = 0;
        assert_eq!(bh_record_options_v29(c, &options), 1);
        assert_eq!(
            (*c).map
                .as_ref()
                .unwrap()
                .recorder
                .as_ref()
                .unwrap()
                .data
                .options
                .null_binds,
            1
        );
        assert_eq!(
            (*c).map
                .as_ref()
                .unwrap()
                .recorder
                .as_ref()
                .unwrap()
                .data
                .options
                .timed_input,
            1
        );
        options.yaw_speed = 301.0;
        assert_eq!(bh_record_options_v29(c, &options), 0);
        options.version = 99;
        assert_eq!(bh_record_options_v29(c, &options), 0);
        let mut count = 0;
        let mut status = 0;
        assert_eq!(
            bh_timing_path_v2(c, 2, 72, ptr::null_mut(), 0, &mut count, &mut status),
            1
        );
        assert!(status != 0);
        let mut segments = vec![BhTimingSegmentV2::default(); count];
        assert_eq!(
            bh_timing_path_v2(
                c,
                2,
                72,
                segments.as_mut_ptr(),
                count,
                &mut count,
                &mut status
            ),
            1
        );
        assert_eq!(
            bh_timing_path_v2(c, 3, 72, ptr::null_mut(), 0, &mut count, &mut status),
            0
        );
        bh_destroy(c);
        bh_destroy(control);
    }
}

#[test]
fn replay_takeover_preserves_world_and_rejects_old_or_wrong_styles() {
    let fixture = Fixture::new();
    let map_bytes = bsp(&[]);
    let map_path = fixture.file("fixture.bsp", &map_bytes);
    let mut data = sample_recording(BhRecordOptionsV29::default());
    data.header["mapSha256"] = recording::sha(&map_bytes).into();
    let replay_path = fixture.file("current.bhr", &data.encode_raw().unwrap());
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, map_path.as_ptr(), ptr::null()), 1);
        assert_eq!(bh_replay_load(c, replay_path.as_ptr()), 1);
        assert_eq!(bh_practice_from_replay(c, c"legit".as_ptr()), 0);
        let mut snapshot = BhSnapshot::default();
        assert_eq!(bh_replay_seek(c, 1, &mut snapshot), 1);
        let before = (*c).map.as_ref().unwrap().game.snapshot_bytes();
        assert_eq!(bh_practice_from_replay(c, c"autohop".as_ptr()), 1);
        let m = (*c).map.as_ref().unwrap();
        assert_eq!(m.game.snapshot_bytes(), before);
        assert!(m.playback.is_none());
        assert!(!m.record_valid);
        assert!(m.completed_record.is_none());
        assert_eq!(
            bh_record_begin(c, ptr::null(), c"autohop".as_ptr(), c"test".as_ptr(), 100),
            0
        );
        data.header["settings"]["physics"] = 17.into();
        let old_path = fixture.file("old.bhr", &data.encode_raw().unwrap());
        assert_eq!(bh_replay_load(c, old_path.as_ptr()), 1);
        assert_eq!(bh_practice_from_replay(c, c"autohop".as_ptr()), 0);
        bh_destroy(c);
    }
}
