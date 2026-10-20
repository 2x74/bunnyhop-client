//! Offline ABI driver for tools/record-proof.ts; no browser or JavaScript runs inside the native game.
use bunnyhop_native_bridge::*;
use serde_json::{Value, json};
use std::ffi::{CStr, CString};
use std::ptr;
fn f(v: &Value, key: &str) -> f32 {
    v[key].as_f64().unwrap() as f32
}
fn u(v: &Value, key: &str) -> u32 {
    v[key].as_u64().unwrap_or(0) as u32
}
unsafe fn ok(ctx: *mut BhContext, result: i32) {
    assert_eq!(
        result,
        1,
        "{}",
        unsafe { CStr::from_ptr(bh_last_error(ctx)) }.to_string_lossy()
    );
}
fn main() {
    let a = std::env::args().collect::<Vec<_>>();
    assert_eq!(
        a.len(),
        4,
        "usage: record-proof MAP.bsp SPEC.json OUTPUT.jsonl"
    );
    let spec: Value = serde_json::from_slice(&std::fs::read(&a[2]).unwrap()).unwrap();
    let settings = &spec["settings"];
    let settings = BhSettings {
        tick_interval: f(settings, "tickInterval"),
        air_accelerate: f(settings, "airAccelerate"),
        accelerate: f(settings, "accelerate"),
        friction: f(settings, "friction"),
        stop_speed: f(settings, "stopSpeed"),
        gravity: f(settings, "gravity"),
        max_speed: f(settings, "maxSpeed"),
        autohop: u32::from(settings["autohop"].as_bool().unwrap()),
        physics: u(settings, "physics"),
        stamina: u32::from(settings["stamina"].as_bool().unwrap_or(false)),
    };
    let zones = spec["zones"]
        .as_array()
        .unwrap()
        .iter()
        .map(|z| {
            let vec = |key: &str| std::array::from_fn(|i| z[key][i].as_f64().unwrap() as f32);
            BhZone {
                kind: match z["kind"].as_str().unwrap() {
                    "start" => 0,
                    "end" => 1,
                    "stage" => 2,
                    "checkpoint" => 3,
                    _ => panic!("zone kind"),
                },
                track: u(z, "track"),
                index: u(z, "index"),
                mins: vec("mins"),
                maxs: vec("maxs"),
            }
        })
        .collect::<Vec<_>>();
    let options = BhRunOptions {
        prespeed_cap: spec["prespeedCap"].as_f64().unwrap_or(0.0) as f32,
        cap_enabled: u32::from(!spec["prespeedCap"].is_null()),
        rules: u(&spec, "timerRules"),
        block_prehops: u32::from(spec["style"] == "scroll"),
        strafe_keys: match spec["style"].as_str().unwrap() {
            "wonly" => 2,
            "sideways" => 1,
            _ => 0,
        },
    };
    unsafe {
        let c = bh_create();
        assert!(!c.is_null());
        ok(c, bh_set_settings(c, &settings));
        let map = CString::new(a[1].as_str()).unwrap();
        ok(c, bh_load_map(c, map.as_ptr(), ptr::null()));
        ok(
            c,
            bh_run_configure(c, &options, zones.as_ptr(), zones.len()),
        );
        ok(c, bh_reset(c));
        if spec["spawn"].is_object() {
            let p = &spec["spawn"];
            ok(
                c,
                bh_set_position(
                    c,
                    p["position"][0].as_f64().unwrap() as f32,
                    p["position"][1].as_f64().unwrap() as f32,
                    p["position"][2].as_f64().unwrap() as f32,
                    f(p, "yaw"),
                ),
            );
            if p["targetname"].is_string() || p["classname"].is_string() {
                let name = CString::new(p["targetname"].as_str().unwrap_or("")).unwrap();
                let class = CString::new(p["classname"].as_str().unwrap_or("")).unwrap();
                ok(c, bh_set_restart_names(c, name.as_ptr(), class.as_ptr()));
            }
        }
        if let Some(identity) = spec["nativeClientBuild"].as_str() {
            let identity = CString::new(identity).unwrap();
            ok(c, bh_record_identity(c, identity.as_ptr()));
        }
        let output = CString::new(a[3].as_str()).unwrap();
        let style = CString::new(spec["style"].as_str().unwrap()).unwrap();
        ok(
            c,
            bh_record_begin(
                c,
                output.as_ptr(),
                style.as_ptr(),
                c"native-record-proof".as_ptr(),
                100,
            ),
        );
        for cmd in spec["commands"].as_array().unwrap() {
            let cmd = BhCmd {
                forward: f(cmd, "forward"),
                side: f(cmd, "side"),
                yaw: f(cmd, "yaw"),
                pitch: f(cmd, "pitch"),
                buttons: u(cmd, "buttons"),
            };
            let mut state = BhState::default();
            ok(c, bh_step(c, &cmd, &mut state));
        }
        ok(c, bh_record_end(c));
        let mut folded = 0;
        let from = spec["runStartIndex"].as_u64().unwrap() as usize;
        let to = spec["commands"].as_array().unwrap().len();
        let middle = from + (to - from) / 2;
        ok(c, bh_record_fold(c, 0x811c9dc5, from, middle, &mut folded));
        ok(c, bh_record_fold(c, folded, middle, to, &mut folded));
        assert_eq!(format!("{:08x}", folded), spec["runHash"].as_str().unwrap());
        let mut beat_hash = 0x811c9dc5;
        let mut beat_from = from;
        let mut beats = vec![json!({"tick":0,"hash":format!("{beat_hash:08x}")})];
        while beat_from < to {
            let beat_to = (beat_from + 400).min(to);
            ok(
                c,
                bh_record_fold(c, beat_hash, beat_from, beat_to, &mut folded),
            );
            beat_hash = folded;
            beats.push(json!({"tick":beat_to-from,"hash":format!("{beat_hash:08x}")}));
            beat_from = beat_to;
        }
        println!("{}", json!({"nativeHeartbeats":beats}));
        let bhr = std::path::Path::new(&a[3]).with_extension("bhr");
        let bhr = CString::new(bhr.to_str().unwrap()).unwrap();
        ok(c, bh_record_write_bhr(c, bhr.as_ptr()));
        let mut final_native = BhSnapshot::default();
        ok(c, bh_snapshot(c, &mut final_native));
        let mut size = 0;
        let before = bh_snapshot_bytes(c, &mut size);
        let before = std::slice::from_raw_parts(before, size).to_vec();
        let ghost = bh_ghost_load(c, bhr.as_ptr());
        assert!(
            ghost > 0,
            "{}",
            CStr::from_ptr(bh_last_error(c)).to_string_lossy()
        );
        let after = bh_snapshot_bytes(c, &mut size);
        assert_eq!(before, std::slice::from_raw_parts(after, size));
        let mut frame = BhGhostFrame::default();
        ok(
            c,
            bh_ghost_frame(c, ghost, final_native.player.tick, &mut frame),
        );
        assert_eq!(
            frame.position.map(f32::to_bits),
            final_native.player.position.map(f32::to_bits)
        );
        ok(c, bh_ghost_free(c, ghost));
        ok(c, bh_replay_load(c, bhr.as_ptr()));
        let mut replay_state = BhSnapshot::default();
        ok(
            c,
            bh_replay_seek(c, final_native.player.tick, &mut replay_state),
        );
        assert_eq!(
            replay_state.player.position.map(f32::to_bits),
            final_native.player.position.map(f32::to_bits)
        );
        assert_eq!(
            replay_state.player.velocity.map(f32::to_bits),
            final_native.player.velocity.map(f32::to_bits)
        );
        ok(c, bh_replay_seek(c, 0, &mut replay_state));
        for _ in 0..final_native.player.tick {
            ok(c, bh_replay_step(c, &mut replay_state));
        }
        assert_eq!(
            replay_state.player.position.map(f32::to_bits),
            final_native.player.position.map(f32::to_bits)
        );
        let mut count = 0;
        let summary = bh_record_summary_json(c, &mut count);
        assert!(!summary.is_null());
        println!("{}", CStr::from_ptr(summary).to_string_lossy());
        let mut n = 0;
        let entities = bh_entities_json(c, &mut n);
        assert!(!entities.is_null());
        let parsed: Value =
            serde_json::from_slice(std::slice::from_raw_parts(entities.cast::<u8>(), n)).unwrap();
        assert!(parsed.is_array());
        let mut snapshot = BhSnapshot::default();
        ok(c, bh_snapshot(c, &mut snapshot));
        let bytes = bh_snapshot_bytes(c, &mut n);
        assert!(!bytes.is_null());
        assert!(n > 0);
        bh_destroy(c);
    }
    let rows = std::fs::read_to_string(&a[3])
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .collect::<Vec<_>>();
    let expected = spec["expected"].as_array().unwrap();
    let ticks = rows
        .iter()
        .filter(|v| v["type"] == "tick")
        .collect::<Vec<_>>();
    assert_eq!(ticks.len(), expected.len());
    for (i, (row, exp)) in ticks.iter().zip(expected).enumerate() {
        assert_eq!(
            &row["state"]["floatBits"].as_array().unwrap()[..16],
            exp["floatBits"].as_array().unwrap(),
            "state at {}",
            i + 1
        );
        for key in [
            "grounded",
            "crouched",
            "onLadder",
            "events",
            "tick",
            "touchCrouched",
            "weapons",
            "activeWeapon",
        ] {
            assert_eq!(
                row["state"][key],
                exp["state"][key],
                "state {key} at {}",
                i + 1
            );
        }
        assert_eq!(
            row["commandHash"],
            exp["commandHash"],
            "command hash at {}",
            i + 1
        );
        for (key, value) in exp["timer"].as_object().unwrap() {
            let actual = &row["timer"][key];
            if let (Some(a), Some(b)) = (actual.as_f64(), value.as_f64()) {
                assert_eq!(
                    a.to_bits(),
                    b.to_bits(),
                    "timer {key} at {}: {a} != {b}",
                    i + 1
                );
            } else {
                assert_eq!(actual, value, "timer {key} at {}", i + 1);
            }
        }
    }
    println!(
        "{}",
        json!({"statesCompared":ticks.len(),"timerRowsCompared":ticks.len(),"pass":true})
    );
}
