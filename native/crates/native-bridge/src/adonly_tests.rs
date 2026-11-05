//! A/D-Only against the website's oracle, pinned from release-0.0.37 tools/verify/fixtures/adonly-vectors.json (written by
//! tools/verify/adonly-vectors.ts): one filter fed every row in order, comparing the filtered command and the lock.
//! shared_style_filter_oracle in styles.rs also runs the vendored filter with the run state toggling.
use super::styles::{strafe_keys, strafe_keys_name, Filter, IDS, STRAFE_KEYS_PRESS};
use super::{BhCmd, BhState};
use serde_json::Value;

const ADONLY_PHYSICS: u32 = 25;

fn vectors() -> Value {
    serde_json::from_str(include_str!("../fixtures/adonly-vectors.json")).unwrap()
}

fn command(v: &Value) -> BhCmd {
    BhCmd {
        forward: v["forward"].as_f64().unwrap() as f32,
        side: v["side"].as_f64().unwrap() as f32,
        yaw: v["yaw"].as_f64().unwrap() as f32,
        pitch: v["pitch"].as_f64().unwrap() as f32,
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

fn run_rows(name: &str, rows: &[Value]) {
    let mut filter = Filter::new("adonly", ADONLY_PHYSICS);
    for (i, row) in rows.iter().enumerate() {
        if row["reset"].as_bool().unwrap_or(false) {
            filter.reset(ADONLY_PHYSICS);
        }
        let state = BhState {
            grounded: u32::from(row["grounded"].as_bool().unwrap()),
            on_ladder: u32::from(row["onLadder"].as_bool().unwrap()),
            ..BhState::default()
        };
        let got = filter.apply(
            command(&row["cmd"]),
            state,
            row["edgeLanding"].as_bool().unwrap(),
            row["running"].as_bool().unwrap(),
        );
        let note = row["note"].as_str().unwrap_or("");
        assert_eq!(
            command_bits(got),
            command_bits(command(&row["out"])),
            "{name} row {i}: {note}"
        );
        assert_eq!(
            i64::from(filter.side_lock()),
            row["lock"].as_i64().unwrap(),
            "{name} row {i} lock: {note}"
        );
    }
}

#[test]
fn annotated_sequence_matches_the_website() {
    let v = vectors();
    assert_eq!(v["id"], "adonly");
    run_rows("sequence", v["sequence"].as_array().unwrap());
}

#[test]
fn random_rows_match_the_website() {
    run_rows("random", vectors()["random"].as_array().unwrap());
}

#[test]
fn identity_matches_the_website() {
    let v = vectors();
    // Wire order is frozen: A/D-Only is index 11 on the website, after Backwards.
    assert_eq!(v["wireIndex"].as_u64(), Some(11));
    assert!(IDS.contains(&"adonly"));
    assert_eq!(strafe_keys("adonly"), STRAFE_KEYS_PRESS);
    assert_eq!(strafe_keys_name(STRAFE_KEYS_PRESS), "press");
}
