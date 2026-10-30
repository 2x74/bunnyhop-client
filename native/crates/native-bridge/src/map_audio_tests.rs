use super::*;

fn audio_map(fixture: &Fixture) -> CString {
    let mut bytes = bsp(&[]);
    lump(
        &mut bytes,
        0,
        0,
        br#"
{"classname" "worldspawn"}
{"classname" "info_player_start" "origin" "10 20 100"}
{"classname" "ambient_generic" "targetname" "ambient" "message" "wind.wav" "spawnflags" "16"}
{"classname" "point_clientcommand" "targetname" "command"}
"#,
    );
    fixture.file("audio.bsp", &bytes)
}

#[test]
fn audio_observations_preserve_every_snapshot_and_recorded_replay() {
    let fixture = Fixture::new();
    let path = audio_map(&fixture);
    let mut compared_ticks = 0;
    for physics in 1..=game::PHYSICS_LATEST {
        unsafe {
            let silent = bh_create();
            let audible = bh_create();
            for context in [silent, audible] {
                let settings = BhSettings {
                    physics,
                    ..BhSettings::default()
                };
                assert_eq!(bh_set_settings(context, &settings), 1);
                assert_eq!(bh_load_map(context, path.as_ptr(), ptr::null()), 1);
                let zones = timer_zones();
                assert_eq!(
                    bh_run_configure(
                        context,
                        &BhRunOptions::default(),
                        zones.as_ptr(),
                        zones.len()
                    ),
                    1
                );
                assert_eq!(
                    bh_record_begin(
                        context,
                        ptr::null(),
                        c"autohop".as_ptr(),
                        c"test".as_ptr(),
                        7
                    ),
                    1
                );
                (*context)
                    .map
                    .as_mut()
                    .unwrap()
                    .recorder
                    .as_mut()
                    .unwrap()
                    .data
                    .header["recordedAt"] = serde_json::json!(0);
            }
            let mut rows = [BhMapSoundState::default(); 8];
            let mut commands = [0; 1024];
            let mut previous_serial = bh_map_sound_serial(audible);
            for tick in 0..1000 {
                for context in [silent, audible] {
                    let game = &mut (*context).map.as_mut().unwrap().game;
                    match tick % 100 {
                        0 => game.fire_input("ambient", "playsound", ""),
                        20 => game.fire_input("ambient", "volume", "3.26"),
                        40 => game.fire_input("ambient", "pitch", "150"),
                        60 => game.fire_input("ambient", "stopsound", ""),
                        80 => game.fire_input("command", "command", "play wind.wav"),
                        _ => {}
                    }
                    let command = BhCmd {
                        forward: 450.0,
                        side: if tick % 2 == 0 { 450.0 } else { -450.0 },
                        yaw: (tick % 360) as f32,
                        buttons: game::IN_JUMP,
                        ..BhCmd::default()
                    };
                    let mut state = BhState::default();
                    assert_eq!(bh_step(context, &command, &mut state), 1);
                }
                let serial = bh_map_sound_serial(audible);
                if serial != previous_serial {
                    previous_serial = serial;
                    assert_eq!(
                        bh_map_sound_states(audible, rows.as_mut_ptr(), rows.len()),
                        1
                    );
                    assert_eq!(rows[0].entity, 2);
                    bh_map_sound_commands(audible, commands.as_mut_ptr(), commands.len());
                }
                let mut count = 0;
                let first = bh_snapshot_bytes(silent, &mut count);
                let first = std::slice::from_raw_parts(first, count).to_vec();
                let second = bh_snapshot_bytes(audible, &mut count);
                assert_eq!(
                    first,
                    std::slice::from_raw_parts(second, count),
                    "physics {physics}, tick {tick}"
                );
                assert_eq!(
                    (*silent).map.as_ref().unwrap().record_hash,
                    (*audible).map.as_ref().unwrap().record_hash
                );
                compared_ticks += 1;
            }
            let recorded = |context: *mut BhContext| {
                (*context)
                    .map
                    .as_ref()
                    .unwrap()
                    .recorder
                    .as_ref()
                    .unwrap()
                    .data
                    .encode_raw()
                    .unwrap()
            };
            assert_eq!(
                recorded(silent),
                recorded(audible),
                "physics {physics}: recorded bytes changed"
            );
            bh_destroy(silent);
            bh_destroy(audible);
        }
    }
    eprintln!(
        "map audio identity: {compared_ticks} tick snapshots and 20 recorded replays identical"
    );
}

#[test]
fn audio_exports_bound_buffers_and_drain_commands_without_changing_state() {
    let fixture = Fixture::new();
    let path = audio_map(&fixture);
    unsafe {
        let context = bh_create();
        assert_eq!(bh_load_map(context, path.as_ptr(), ptr::null()), 1);
        assert_eq!(bh_map_sound_states(context, ptr::null_mut(), 8), 0);
        let mut rows = [BhMapSoundState::default(); 2];
        rows[1].entity = 123;
        assert_eq!(bh_map_sound_states(context, rows.as_mut_ptr(), 1), 1);
        assert_eq!(rows[1].entity, 123);
        assert_eq!(bh_map_sound_states(context, rows.as_mut_ptr(), 0), 0);
        let game = &mut (*context).map.as_mut().unwrap().game;
        game.fire_input("command", "command", "play excluded.mp3");
        let mut commands = [0; 32];
        assert_eq!(bh_map_sound_commands(context, commands.as_mut_ptr(), 2), 0);
        assert_eq!(
            bh_map_sound_commands(context, commands.as_mut_ptr(), commands.len()),
            0
        );
        bh_destroy(context);
    }
}
