use super::{BhCmd, BhRunOptions, BhState, BhTimingSegmentV2, BhZone, run::Timer, run_timing::*};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../fixtures/run-timing.json")).unwrap()
}
fn vector(value: &Value) -> [f32; 3] {
    std::array::from_fn(|axis| value[axis].as_f64().unwrap() as f32)
}
fn zones(value: &Value) -> Vec<BhZone> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|zone| BhZone {
            kind: if zone["kind"] == "start" { 0 } else { 1 },
            track: zone["track"].as_u64().unwrap_or(0) as u32,
            mins: vector(&zone["mins"]),
            maxs: vector(&zone["maxs"]),
            ..Default::default()
        })
        .collect()
}
#[test]
fn web_fixture_source_is_current() {
    // Windows checkouts may convert the source to CRLF; the fixture hashes the LF file.
    let source = include_str!("../../../apps/web/src/run-timing.ts").replace("\r\n", "\n");
    let hash = Sha256::digest(source.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_eq!(fixtures()["sha256"], hash, "regenerate run-timing vectors");
}
#[test]
fn web_crossing_vectors() {
    for (index, row) in fixtures()["crossings"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let to = vector(&row["to"]);
        let from = row["from"].is_array().then(|| vector(&row["from"]));
        let ducked = row["crouched"].as_bool().unwrap();
        let segments = row["path"]["segments"].as_array().map(|segments| {
            segments
                .iter()
                .map(|s| BhTimingSegmentV2 {
                    t0: s["t0"].as_f64().unwrap(),
                    t1: s["t1"].as_f64().unwrap(),
                    from: vector(&s["from"]),
                    to: vector(&s["to"]),
                    mins: vector(&s["mins"]),
                    maxs: vector(&s["maxs"]),
                    discrete: u32::from(s["discrete"].as_bool().unwrap()),
                    reserved: 0,
                })
                .collect::<Vec<_>>()
        });
        let path = segments
            .as_deref()
            .filter(|_| row["path"]["unsupported"].is_null());
        assert_eq!(
            path.is_some_and(|p| complete_path(p, to, ducked)),
            row["complete"] == true,
            "path {index}"
        );
        for entry in [false, true] {
            let measured = crossing(
                path,
                from,
                to,
                ducked,
                zones(&row["zones"]).into_iter(),
                entry,
            );
            assert_eq!(
                measured.json(),
                row[if entry { "entry" } else { "exit" }],
                "crossing {index}"
            );
        }
    }
}
#[test]
fn web_rounding_vectors() {
    for row in fixtures()["rounding"].as_array().unwrap() {
        assert_eq!(
            units_to_ms(
                row["units"].as_u64().unwrap(),
                row["interval"].as_f64().unwrap()
            ),
            row["ms"].as_u64().unwrap(),
            "{row}"
        );
    }
    for row in fixtures()["phases"].as_array().unwrap() {
        assert_eq!(
            quantize_phase(row["phase"].as_f64().unwrap()),
            row["quantized"].as_u64().unwrap() as u32
        );
    }
    assert_eq!(time_units(4, 750000, 4, 250000), 0);
    assert_eq!(time_units(4, 750000, 6, 250000), 1500000);
}
#[test]
fn web_timer_scenarios() {
    for run in fixtures()["runs"].as_array().unwrap() {
        let mut timer = Timer::new(
            zones(&run["zones"]),
            BhRunOptions {
                rules: run["rules"].as_u64().unwrap() as u32,
                ..Default::default()
            },
            0.01,
        );
        for row in run["rows"].as_array().unwrap() {
            let state = &row["state"];
            timer.update(
                BhCmd::default(),
                BhState {
                    tick: state["tick"].as_u64().unwrap() as u32,
                    position: vector(&state["position"]),
                    velocity: vector(&state["velocity"]),
                    grounded: u32::from(state["grounded"] == true),
                    events: row["events"].as_u64().unwrap() as u32,
                    touch_position: if state["touchPosition"].is_array() {
                        vector(&state["touchPosition"])
                    } else {
                        [f32::NAN; 3]
                    },
                    ..Default::default()
                },
            );
            assert_eq!(
                json!(["idle", "running", "finished"][timer.state.status as usize]),
                row["status"],
                "{}",
                run["name"]
            );
            assert_eq!(
                timer.state.seconds,
                row["seconds"].as_f64().unwrap(),
                "{}",
                run["name"]
            );
            assert_eq!(timer.timing(), row["timing"], "{}", run["name"]);
        }
    }
}
