//! Physics 28 Auto-strafe against the website's oracle, pinned from release-0.0.40 tools/verify/fixtures/
//! autostrafe-v28-vectors.json (written by tools/verify/autostrafe-v28-vectors.ts; research/NATIVE-AUTOSTRAFE-V28.md).
//! live: one physics 28 filter, lag_view then apply with the next yaw, row by row. replay: the recorded commands
//! re-filtered with the next recorded yaw on a fresh filter per segment give themselves back; v27 is the old rule.
use super::look::BhLookSampleV2;
use super::styles::Filter;
use super::{BhCmd, BhState};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("../fixtures/autostrafe-v28-vectors.json")).unwrap()
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

fn bits(c: BhCmd) -> (u32, u32, u32, u32, u32) {
    (
        c.forward.to_bits(),
        c.side.to_bits(),
        c.yaw.to_bits(),
        c.pitch.to_bits(),
        c.buttons,
    )
}

fn pre(row: &Value) -> (BhState, bool, bool) {
    let state = BhState {
        grounded: u32::from(row["grounded"].as_bool().unwrap()),
        on_ladder: u32::from(row["onLadder"].as_bool().unwrap()),
        ..BhState::default()
    };
    (
        state,
        row["edgeLanding"].as_bool().unwrap(),
        row["running"].as_bool().unwrap(),
    )
}

/// A look sample that names its row, so the test can see which row's sample rides on each command.
fn look(row: usize) -> BhLookSampleV2 {
    BhLookSampleV2 {
        epoch: row as u32,
        ..BhLookSampleV2::default()
    }
}

fn live(name: &str, rows: &[Value]) {
    let mut filter = Filter::new("autostrafe", 28);
    assert!(filter.lead());
    for (i, row) in rows.iter().enumerate() {
        if i == 0 || row["reset"].as_bool().unwrap_or(false) {
            filter.reset(28);
        }
        let note = row["note"].as_str().unwrap_or("");
        let (cmd, sample, next_yaw) = filter.lag_view(command(&row["in"]), Some(look(i)));
        assert_eq!(
            sample.map(|l| l.epoch as u64),
            row["lookFrom"].as_u64(),
            "{name} row {i} lookFrom: {note}"
        );
        match row["nextYaw"].as_f64() {
            // An f32 yaw widened exactly; serde_json's default float parser can be an ulp off in f64, not in f32.
            Some(expected) => {
                assert_eq!(
                    next_yaw,
                    f64::from(next_yaw as f32),
                    "{name} row {i} nextYaw: {note}"
                );
                assert_eq!(
                    (next_yaw as f32).to_bits(),
                    (expected as f32).to_bits(),
                    "{name} row {i} nextYaw: {note}"
                )
            }
            None => assert!(next_yaw.is_nan(), "{name} row {i} nextYaw: {note}"),
        }
        let (state, edge_landing, running) = pre(row);
        let out = filter.apply(cmd, state, edge_landing, running, next_yaw);
        assert_eq!(
            bits(out),
            bits(command(&row["out"])),
            "{name} row {i} out: {note}"
        );
        assert_eq!(
            filter.auto_state(),
            (
                row["dir"].as_i64().unwrap() as i32,
                row["still"].as_u64().unwrap() as u32
            ),
            "{name} row {i} dir/still: {note}"
        );
    }
}

fn replay(name: &str, rows: &[Value]) {
    const MOVE_LR: u32 = (1 << 9) | (1 << 10);
    let mut filter = Filter::new("autostrafe", 28);
    let mut old = Filter::new("autostrafe", 27);
    assert!(!old.lead());
    for (i, row) in rows.iter().enumerate() {
        if i == 0 || row["reset"].as_bool().unwrap_or(false) {
            filter = Filter::new("autostrafe", 28);
            old = Filter::new("autostrafe", 27);
        }
        let note = row["note"].as_str().unwrap_or("");
        let recorded = command(&row["out"]);
        let next = rows
            .get(i + 1)
            .filter(|r| !r["reset"].as_bool().unwrap_or(false))
            .map_or(f64::NAN, |r| f64::from(command(&r["out"]).yaw));
        let (state, edge_landing, running) = pre(row);
        let again = filter.apply(recorded, state, edge_landing, running, next);
        assert_eq!(
            bits(again),
            bits(command(&row["replay"]["out"])),
            "{name} row {i} replay: {note}"
        );
        assert_eq!(
            bits(again),
            bits(recorded),
            "{name} row {i} is not a fixed point: {note}"
        );
        // The old rule on the same command without its computed key (the key one tick later).
        let bare = if recorded.side != 0.0 && command(&row["in"]).side == 0.0 {
            BhCmd {
                side: 0.0,
                buttons: recorded.buttons & !MOVE_LR,
                ..recorded
            }
        } else {
            recorded
        };
        let v27 = old.apply(bare, state, edge_landing, running, next);
        assert_eq!(
            bits(v27),
            bits(command(&row["replay"]["v27"])),
            "{name} row {i} v27: {note}"
        );
    }
}

#[test]
fn autostrafe_v28_live_rows_match_the_web_oracle() {
    let v = vectors();
    assert_eq!(v["physics"].as_u64(), Some(28));
    let sequence = v["sequence"].as_array().unwrap();
    let random = v["random"].as_array().unwrap();
    assert_eq!((sequence.len(), random.len()), (35, 1500));
    live("sequence", sequence);
    live("random", random);
}

#[test]
fn autostrafe_v28_recordings_replay_as_fixed_points_and_v27_keeps_the_old_rule() {
    let v = vectors();
    replay("sequence", v["sequence"].as_array().unwrap());
    replay("random", v["random"].as_array().unwrap());
}

#[test]
fn only_autostrafe_at_28_and_later_leads() {
    for id in super::styles::IDS {
        for physics in [1, 8, 22, 26, 27, 28, 29] {
            assert_eq!(
                Filter::new(id, physics).lead(),
                id == "autostrafe" && physics >= 28,
                "{id} physics {physics}"
            );
        }
    }
}
