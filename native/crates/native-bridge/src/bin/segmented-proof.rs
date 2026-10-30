//! Offline checkpoint/recording ABI driver. Never contacts the score service.
use bunnyhop_native_bridge::*;
use serde_json::{Value, json};
use std::{
    ffi::{CStr, CString},
    ptr,
};

unsafe fn ok(ctx: *mut BhContext, result: i32) {
    assert_eq!(
        result,
        1,
        "{}",
        unsafe { CStr::from_ptr(bh_last_error(ctx)) }.to_string_lossy()
    );
}
fn vector(value: &Value) -> [f32; 3] {
    std::array::from_fn(|i| value[i].as_f64().unwrap() as f32)
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert_eq!(args.len(), 4, "segmented-proof MAP SPEC OUTPUT.bhr");
    let spec: Value = serde_json::from_slice(&std::fs::read(&args[2]).unwrap()).unwrap();
    unsafe {
        let ctx = bh_create();
        let path = CString::new(args[1].as_str()).unwrap();
        ok(ctx, bh_load_map(ctx, path.as_ptr(), ptr::null()));
        let zones: Vec<_> = spec["zones"]
            .as_array()
            .unwrap()
            .iter()
            .map(|z| BhZone {
                kind: if z["kind"] == "start" { 0 } else { 1 },
                track: 0,
                index: 0,
                mins: vector(&z["mins"]),
                maxs: vector(&z["maxs"]),
            })
            .collect();
        let options = BhRunOptions {
            rules: 2,
            ..BhRunOptions::default()
        };
        ok(
            ctx,
            bh_run_configure(ctx, &options, zones.as_ptr(), zones.len()),
        );
        ok(ctx, bh_reset(ctx));
        let p = vector(&spec["spawn"]["position"]);
        ok(
            ctx,
            bh_set_position(
                ctx,
                p[0],
                p[1],
                p[2],
                spec["spawn"]["yaw"].as_f64().unwrap() as f32,
            ),
        );
        let name = CString::new(spec["spawn"]["targetname"].as_str().unwrap_or("")).unwrap();
        ok(ctx, bh_set_restart_names(ctx, name.as_ptr(), c"".as_ptr()));
        ok(
            ctx,
            bh_record_begin(
                ctx,
                ptr::null(),
                c"segmented".as_ptr(),
                c"segmented-proof".as_ptr(),
                10,
            ),
        );
        let mut handles = Vec::new();
        let mut traces = Vec::new();
        for action in spec["actions"].as_array().unwrap() {
            if let Some(index) = action["load"].as_u64() {
                ok(
                    ctx,
                    bh_segment_restore(
                        ctx,
                        handles[index as usize],
                        &mut BhCmd::default(),
                        &mut BhSnapshot::default(),
                    ),
                );
            } else if action["save"] == true {
                let handle = bh_practice_save(ctx, 0.0, 0.0);
                assert_ne!(handle, 0);
                handles.push(handle);
            } else if let Some(c) = action["command"].as_array() {
                let command = BhCmd {
                    forward: c[0].as_f64().unwrap() as f32,
                    side: c[1].as_f64().unwrap() as f32,
                    yaw: c[2].as_f64().unwrap() as f32,
                    pitch: c[3].as_f64().unwrap() as f32,
                    buttons: c[4].as_u64().unwrap() as u32,
                };
                let l = &action["look"];
                let look = BhLookSampleV2 {
                    base: l["base"].as_f64().unwrap(),
                    k: l["k"].as_f64().unwrap(),
                    count: l["count"].as_f64().unwrap(),
                    epoch: l["epoch"].as_u64().unwrap() as u32,
                    kind: l["kind"].as_u64().unwrap() as u32,
                    frames: 1,
                    events: 0,
                    reports: 0,
                };
                ok(
                    ctx,
                    bh_step_look_v2(ctx, &command, &look, &mut BhState::default()),
                );
            } else if let Some(kind) = action["cosmetic"].as_u64() {
                ok(ctx, bh_record_cosmetic(ctx, kind as u32));
            } else if let Some(kind) = action["inspect"].as_u64() {
                ok(ctx, bh_record_inspect(ctx, kind as u32));
            } else {
                panic!("unknown action");
            }
            let mut snapshot = BhSnapshot::default();
            let mut run = BhRunState::default();
            ok(ctx, bh_snapshot(ctx, &mut snapshot));
            ok(ctx, bh_run_state(ctx, &mut run));
            let s = snapshot.player;
            traces.push(json!({
                "tick": s.tick, "bits": s.position.into_iter().chain(s.velocity).map(f32::to_bits).collect::<Vec<_>>(),
                "start": run.start_tick, "end": run.end_tick, "status": run.status,
            }));
        }
        let mut run = BhRunState::default();
        ok(ctx, bh_run_state(ctx, &mut run));
        assert_eq!(run.status, 2, "fixture must finish");
        ok(ctx, bh_record_end(ctx));
        let output = CString::new(args[3].as_str()).unwrap();
        ok(ctx, bh_record_write_bhr(ctx, output.as_ptr()));
        let mut size = 0;
        let before = bh_snapshot_bytes(ctx, &mut size);
        let before = std::slice::from_raw_parts(before, size).to_vec();
        ok(ctx, bh_replay_load(ctx, output.as_ptr()));
        ok(
            ctx,
            bh_replay_seek(ctx, run.last_tick, &mut BhSnapshot::default()),
        );
        let after = bh_snapshot_bytes(ctx, &mut size);
        assert_eq!(
            before,
            std::slice::from_raw_parts(after, size),
            "stitched replay must reach the complete live snapshot"
        );
        println!(
            "{}",
            json!({"traces":traces,"seconds":run.seconds,"loads":spec["actions"].as_array().unwrap().iter().filter(|a|a["load"].is_number()).count()})
        );
        bh_destroy(ctx);
    }
}
