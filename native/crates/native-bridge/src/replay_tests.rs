use super::*;
use sha2::Digest;

fn bytes(value: &serde_json::Value) -> Vec<u8> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u8)
        .collect()
}

#[test]
fn web_v10_oracle_decodes_fractional_turns_and_bounds_malformed_data() {
    let fixture = Fixture::new();
    let map_bytes = bsp(&[]);
    let sha = sha2::Sha256::digest(&map_bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let output = match std::process::Command::new("bun")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/replay-v10-vectors.ts"))
        .arg(sha)
        .output()
    {
        Ok(output) => output,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("skipping external v10 encoder/decoder oracle: bun is not installed");
            return;
        }
        Err(e) => panic!("v10 oracle: {e}"),
    };
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    for v in oracle["vectors"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        let raw = bytes(&v["raw"]);
        let decoded = replay::Decoded::parse(&raw).unwrap();
        let expected = v["commands"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| BhCmd {
                forward: row[0].as_i64().unwrap() as f32,
                side: row[1].as_i64().unwrap() as f32,
                buttons: row[2].as_u64().unwrap() as u32,
                yaw: f32::from_bits(row[3].as_u64().unwrap() as u32),
                pitch: f32::from_bits(row[4].as_u64().unwrap() as u32),
            })
            .collect::<Vec<_>>();
        assert_eq!(decoded.commands.len(), expected.len(), "{name}");
        for (i, (actual, expected)) in decoded.commands.iter().zip(&expected).enumerate() {
            assert_eq!(
                (
                    actual.forward.to_bits(),
                    actual.side.to_bits(),
                    actual.buttons,
                    actual.yaw.to_bits(),
                    actual.pitch.to_bits()
                ),
                (
                    expected.forward.to_bits(),
                    expected.side.to_bits(),
                    expected.buttons,
                    expected.yaw.to_bits(),
                    expected.pitch.to_bits()
                ),
                "{name} tick {i}"
            );
        }
        let info: serde_json::Value = serde_json::from_slice(decoded.info.as_bytes()).unwrap();
        assert_eq!(info["version"], 10);
        assert_eq!(info["counted"], true);
        assert_eq!(
            decoded.settings.stamina != 0,
            v["stamina"].as_bool().unwrap()
        );
        let checkpoints = v["checkpoints"].as_array().unwrap();
        assert_eq!(decoded.checkpoints.len(), checkpoints.len());
        for ((tick, position, velocity), expected) in decoded.checkpoints.iter().zip(checkpoints) {
            assert_eq!(u64::from(*tick), expected["tick"].as_u64().unwrap());
            for (actual, key) in [(position, "position"), (velocity, "velocity")] {
                let expected = expected[key]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| (v.as_f64().unwrap() as f32).to_bits())
                    .collect::<Vec<_>>();
                assert_eq!(
                    actual.map(f32::to_bits).as_slice(),
                    expected,
                    "telemetry/checkpoint alignment: {name}"
                );
            }
        }
        if !expected.is_empty() {
            assert_eq!(decoded.cosmetic.len(), 2);
            assert_eq!(decoded.inspect.len(), 3);
        }
        // Every prefix of the mandatory body must fail, including partial f64
        // counts, rebase records, telemetry varints and checkpoints.
        let core = bytes(&v["core"]);
        for len in 0..core.len() {
            assert!(
                replay::Decoded::parse(&core[..len]).is_err(),
                "{name}: accepted truncated prefix {len}"
            );
        }
        let path = fixture.file(&format!("{name}.bhr"), &bytes(&v["gzip"]));
        assert_eq!(
            replay::Decoded::load(Path::new(path.to_str().unwrap()))
                .unwrap()
                .commands
                .len(),
            expected.len()
        );
        // Arbitrary checkpoint coordinates test decoding only; the other fixtures
        // exercise public import, playback, seeking and ghost APIs against Game.
        if name != "checkpoints" {
            unsafe { playback_and_ghost(&fixture, &map_bytes, &path, &expected) };
        }
    }
    for v in oracle["malformed"].as_array().unwrap() {
        let error = replay::Decoded::parse(&bytes(&v["raw"]))
            .err()
            .expect("accepted malformed v10");
        assert!(
            error.contains(v["error"].as_str().unwrap()),
            "{}: {error}",
            v["name"]
        );
    }
}

unsafe fn playback_and_ghost(
    fixture: &Fixture,
    map_bytes: &[u8],
    path: &CString,
    commands: &[BhCmd],
) {
    unsafe {
        let c = bh_create();
        let map = fixture.file("fixture.bsp", map_bytes);
        assert_eq!(bh_load_map(c, map.as_ptr(), fixture.root().as_ptr()), 1);
        let initial = (*c).map.as_ref().unwrap().game.snapshot_bytes();
        // Library import is independent of a loaded map.
        let library = bh_create();
        let mut count = 0;
        assert!(!bh_replay_header(library, path.as_ptr(), &mut count).is_null());
        assert!(count > 0);
        assert!((*library).map.is_none());
        bh_destroy(library);

        let ghost = replay::bh_ghost_load(c, path.as_ptr());
        assert!(
            ghost > 0,
            "{}",
            CStr::from_ptr(bh_last_error(c)).to_string_lossy()
        );
        assert_eq!(initial, (*c).map.as_ref().unwrap().game.snapshot_bytes());
        assert_eq!(replay::bh_replay_load(c, path.as_ptr()), 1);
        let decoded = replay::Decoded::load(Path::new(path.to_str().unwrap())).unwrap();
        let parsed = bunnyhop_core::parse_bsp(map_bytes).unwrap();
        let mut expected = Game::load(&parsed).unwrap();
        expected.set_settings(decoded.settings.checked().unwrap());
        expected.reset();
        expected.set_position([10.0, 20.0, 100.0], 45.0);
        expected.set_restart_names("runner", "player");
        let mut snapshot = BhSnapshot::default();
        for (i, cmd) in commands.iter().enumerate() {
            expected
                .step(Cmd {
                    forward: cmd.forward,
                    side: cmd.side,
                    yaw: cmd.yaw,
                    pitch: cmd.pitch,
                    buttons: cmd.buttons,
                })
                .unwrap();
            assert_eq!(
                replay::bh_replay_step(c, &mut snapshot),
                1,
                "{}",
                CStr::from_ptr(bh_last_error(c)).to_string_lossy()
            );
            state_equal(snapshot.player, BhState::from(&expected));
            assert_eq!(
                (*c).map.as_ref().unwrap().last_command.yaw.to_bits(),
                cmd.yaw.to_bits()
            );
            let mut frame = BhGhostFrame::default();
            assert_eq!(
                replay::bh_ghost_frame(c, ghost, i as u32 + 1, &mut frame),
                1
            );
            assert_eq!(frame.yaw.to_bits(), cmd.yaw.to_bits());
            assert_eq!(frame.pitch.to_bits(), cmd.pitch.to_bits());
            assert_eq!(
                frame.position.map(f32::to_bits),
                snapshot.player.position.map(f32::to_bits)
            );
            assert_eq!(
                frame.velocity.map(f32::to_bits),
                snapshot.player.velocity.map(f32::to_bits)
            );
        }
        assert_eq!(
            replay::bh_replay_seek(c, commands.len() as u32, &mut snapshot),
            1
        );
        state_equal(snapshot.player, BhState::from(&expected));
        assert_eq!(replay::bh_replay_seek(c, 0, &mut snapshot), 1);
        assert_eq!(snapshot.player.tick, 0);
        assert_eq!(replay::bh_ghost_free(c, ghost), 1);
        bh_destroy(c);
    }
}

#[test]
fn replay_varints_reject_overflow_and_unterminated_values() {
    for (bytes, error) in [
        (&[0xff, 0xff, 0xff, 0xff, 0x10][..], "bad replay varint"),
        (&[0x80; 6][..], "bad replay varint"),
        (&[0x80][..], "truncated replay"),
    ] {
        // A legacy header's first command-independent varint is its zone count.
        // Reader itself lives in replay, so test overflow through a minimal v7 body.
        let mut raw = b"BHRP\x07\x00\x01\x00\x00".to_vec();
        raw.extend([0; 32]);
        for f in [1.0 / 128.0f32, 1000.0, 5.0, 4.0, 75.0, 800.0, 260.0, 0.0] {
            raw.extend(f.to_le_bytes());
        }
        raw.extend([0; 12]);
        raw.extend(b"\x00\x00\x07autohop\x0f\x02");
        raw.extend(bytes);
        assert_eq!(replay::Decoded::parse(&raw).err().unwrap(), error);
    }
}

#[test]
fn legacy_and_fractional_look_apis_record_the_filtered_command() {
    let fixture = Fixture::new();
    unsafe {
        let c = bh_create();
        let map = fixture.file("input.bsp", &bsp(&[]));
        assert_eq!(bh_load_map(c, map.as_ptr(), fixture.root().as_ptr()), 1);
        assert_eq!(bh_style_set(c, c"wonly".as_ptr()), 1);
        assert_eq!(bh_set_velocity(c, 300.0, 0.0, 0.0), 1);
        let mut state = BhState::default();
        assert_eq!(bh_state(c, &mut state), 1);
        assert_eq!(state.grounded, 0);
        // Previously live SSJ used this physical D input, whereas replay used
        // the filtered zero movement. The accessor is the sole canonical input.
        let physical = BhCmd {
            side: 450.0,
            yaw: 90.0,
            buttons: 1 << 10,
            ..BhCmd::default()
        };
        let legacy = BhLookSample {
            base: 90.0,
            k: 0.044,
            kind: 1,
            ..BhLookSample::default()
        };
        assert_eq!(bh_step_look(c, &physical, &legacy, &mut state), 1);
        let mut filtered = BhCmd::default();
        assert_eq!(bh_last_command(c, &mut filtered), 1);
        assert_eq!(
            (
                filtered.forward,
                filtered.side,
                filtered.buttons,
                filtered.yaw
            ),
            (0.0, 0.0, 0, 90.0)
        );

        assert_eq!(bh_style_set(c, c"autohop".as_ptr()), 1);
        let zones = timer_zones();
        assert_eq!(
            bh_run_configure(c, &BhRunOptions::default(), zones.as_ptr(), zones.len()),
            1
        );
        assert_eq!(
            bh_record_begin(
                c,
                ptr::null(),
                c"autohop".as_ptr(),
                c"input-test".as_ptr(),
                100
            ),
            1
        );
        let mut commands = Vec::new();
        for i in 0..4 {
            let look = BhLookSampleV2 {
                base: 45.0 + i as f64 * 210.0 * f64::from(BhSettings::default().tick_interval),
                k: 0.044,
                count: if i == 0 { 1.0 } else { i as f64 + 0.5 },
                epoch: i,
                kind: if i == 0 { 1 } else { 6 },
                frames: 1,
                events: 2,
                reports: 2,
            };
            let command = BhCmd {
                yaw: look::yaw(look.base, look.count, look.k),
                buttons: if i == 0 { 0 } else { 1 << 7 },
                ..BhCmd::default()
            };
            if i == 0 {
                // Actual legacy entry point still accepts exactly its original layout.
                let legacy = BhLookSample {
                    base: look.base,
                    k: look.k,
                    count: 1,
                    epoch: 0,
                    kind: 1,
                    frames: 1,
                    events: 2,
                    reports: 2,
                };
                assert_eq!(bh_step_look(c, &command, &legacy, &mut state), 1);
            } else {
                assert_eq!(bh_step_look_v2(c, &command, &look, &mut state), 1);
            }
            commands.push(command);
        }
        let path = CString::new(fixture.0.join("look-v2.bhr").to_str().unwrap()).unwrap();
        // Serialize captured input directly: this four-tick fixture is not a
        // completed timed run and must not pass the public completed-run gate.
        (*c).map
            .as_ref()
            .unwrap()
            .recorder
            .as_ref()
            .unwrap()
            .data
            .write_bhr(Path::new(path.to_str().unwrap()))
            .unwrap();
        assert_eq!(bh_record_end(c), 1);
        let replay = replay::Decoded::load(Path::new(path.to_str().unwrap())).unwrap();
        let info: serde_json::Value = serde_json::from_slice(replay.info.as_bytes()).unwrap();
        assert_eq!(info["version"], 10);
        assert_eq!(replay::bh_replay_load(c, path.as_ptr()), 1);
        let mut snapshot = BhSnapshot::default();
        for expected in commands {
            assert_eq!(replay::bh_replay_step(c, &mut snapshot), 1);
            assert_eq!(bh_last_command(c, &mut filtered), 1);
            assert_eq!(
                (filtered.yaw.to_bits(), filtered.buttons),
                (expected.yaw.to_bits(), expected.buttons)
            );
        }
        bh_destroy(c);
    }
}
