//! Backwards against the website's oracle, pinned from release-0.0.36 tools/verify/fixtures/backwards-vectors.json
//! (written by tools/verify/backwards-vectors.ts). Until the vendored website has Backwards, this file is the only
//! check; after that, shared_style_filter_oracle in styles.rs also runs it.
use super::styles::{Filter, bw_dir, faces_backwards};
use super::{BhCmd, BhState};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("../fixtures/backwards-vectors.json")).unwrap()
}

fn number(v: &Value) -> f32 {
    v.as_f64().unwrap() as f32
}

fn bits(v: &Value) -> u64 {
    u64::from_str_radix(v.as_str().unwrap(), 16).unwrap()
}

fn command(v: &Value) -> BhCmd {
    BhCmd {
        forward: number(&v["forward"]),
        side: number(&v["side"]),
        yaw: number(&v["yaw"]),
        pitch: number(&v["pitch"]),
        buttons: v["buttons"].as_u64().unwrap() as u32,
    }
}

fn command_bits(c: BhCmd) -> (u32, u32, u32, u32, u32) {
    (
        c.forward.to_bits(),
        c.side.to_bits(),
        c.yaw.to_bits(),
        c.pitch.to_bits(),
        c.buttons,
    )
}

fn check_dir_bits(rows: &[Value]) {
    for row in rows {
        let (cos, sin) = bw_dir(number(&row["yaw"]));
        assert_eq!(
            (cos.to_bits(), sin.to_bits()),
            (bits(&row["cosBits"]), bits(&row["sinBits"])),
            "yaw {}",
            row["yaw"]
        );
    }
}

/// Runs one Backwards filter over the rows in order, as the oracle did.
fn check_filter_rows(rows: &[Value]) {
    let mut filter = Filter::new("backwards", 23);
    for (i, row) in rows.iter().enumerate() {
        if row["reset"].as_bool() == Some(true) {
            filter.reset(23);
        }
        let velocity = &row["velocity"];
        let state = BhState {
            grounded: u32::from(row["grounded"].as_bool().unwrap()),
            on_ladder: u32::from(row["onLadder"].as_bool().unwrap()),
            velocity: [
                number(&velocity[0]),
                number(&velocity[1]),
                number(&velocity[2]),
            ],
            ..BhState::default()
        };
        let got = filter.apply(command(&row["cmd"]), state, false, false, f64::NAN);
        assert_eq!(
            command_bits(got),
            command_bits(command(&row["out"])),
            "row {i}"
        );
    }
}

#[test]
fn backwards_design_vectors() {
    let vectors = vectors();
    let rows = vectors["dir"].as_array().unwrap();
    assert_eq!(rows.len(), 20);
    check_dir_bits(rows);
    for row in rows {
        let expected = row["backwards"].as_bool();
        let got = faces_backwards(number(&row["yaw"]), number(&row["vx"]), number(&row["vy"]));
        assert_eq!(got, expected, "{}", row["name"]);
    }
}

#[test]
fn backwards_direction_grid() {
    let vectors = vectors();
    let rows = vectors["grid"].as_array().unwrap();
    assert_eq!(rows.len(), 785);
    check_dir_bits(rows);
}

#[test]
fn backwards_filter_sequence() {
    let vectors = vectors();
    let rows = vectors["sequence"].as_array().unwrap();
    assert_eq!(rows.len(), 17);
    check_filter_rows(rows);
}

#[test]
fn backwards_filter_random() {
    let vectors = vectors();
    let rows = vectors["random"].as_array().unwrap();
    assert_eq!(rows.len(), 1500);
    check_filter_rows(rows);
}
