//! Exact command/style transform from apps/web/src/styles.ts and autostrafe.ts.
use super::{BhCmd, BhSettings, BhState};
pub const IDS: [&str; 9] = [
    "autohop",
    "legit",
    "scroll",
    "wonly",
    "sideways",
    "hsw",
    "lowgrav",
    "autostrafe",
    "segmented",
];
const FORWARD: u32 = 1 << 3;
const BACK: u32 = 1 << 4;
const LEFT: u32 = 1 << 9;
const RIGHT: u32 = 1 << 10;
const MOVE: u32 = FORWARD | BACK | LEFT | RIGHT;
pub fn settings(id: &str) -> Result<BhSettings, String> {
    if !IDS.contains(&id) {
        return Err(format!("unknown style {id}"));
    }
    let mut s = BhSettings::default();
    s.autohop = u32::from(id != "legit" && id != "scroll");
    if id == "scroll" {
        s.stamina = 1;
        s.max_speed = 250.0;
        s.air_accelerate = 100.0;
    }
    if id == "lowgrav" {
        s.gravity = 400.0;
    }
    Ok(s)
}
pub fn strafe_keys(id: &str) -> u32 {
    match id {
        "wonly" => 2,
        "sideways" => 1,
        _ => 0,
    }
}
#[derive(Clone)]
pub struct Filter {
    pub id: String,
    physics: u32,
    from_ladder: bool,
    prev_yaw: f64,
    auto_dir: i32,
    still: u32,
    ground_ticks: u32,
}
impl Filter {
    pub fn new(id: &str, physics: u32) -> Self {
        Self {
            id: id.into(),
            physics,
            from_ladder: false,
            prev_yaw: f64::NAN,
            auto_dir: 0,
            still: 0,
            ground_ticks: 2,
        }
    }
    pub fn reset(&mut self, physics: u32) {
        *self = Self::new(&self.id, physics);
    }
    pub fn apply(&mut self, mut c: BhCmd, s: BhState) -> BhCmd {
        if s.on_ladder != 0 {
            self.from_ladder = true;
        } else if s.grounded != 0 {
            self.from_ladder = false;
        }
        if self.id == "autostrafe" {
            let yaw = f64::from(c.yaw);
            let mut d = if self.prev_yaw.is_finite() && yaw.is_finite() {
                (yaw - self.prev_yaw) % 360.0
            } else {
                0.0
            };
            if d > 180.0 {
                d -= 360.0;
            } else if d < -180.0 {
                d += 360.0;
            }
            self.prev_yaw = yaw;
            let dir = if d > 0.0 {
                -1
            } else if d < 0.0 {
                1
            } else {
                0
            };
            if dir != 0 {
                self.auto_dir = dir;
                self.still = 0;
            } else {
                self.still = self.still.saturating_add(1);
            }
            self.ground_ticks = if s.grounded != 0 {
                (self.ground_ticks + 1).min(2)
            } else {
                0
            };
            if s.on_ladder != 0 || self.from_ladder || self.ground_ticks > 1 {
                return c;
            }
            if self.physics >= 5 && c.forward < 0.0 {
                return c;
            }
            if self.physics >= 8 && c.side != 0.0 {
                return c;
            }
            let f = if self.physics >= 8 && c.forward > 0.0 {
                c.forward
            } else {
                0.0
            };
            let side = if dir != 0 {
                dir as f32 * 450.0
            } else if c.side != 0.0 {
                c.side
            } else if self.still <= 5 {
                self.auto_dir as f32 * 450.0
            } else {
                0.0
            };
            c.forward = f;
            c.side = side + 0.0;
            c.buttons &= !MOVE;
            if f > 0.0 {
                c.buttons |= FORWARD;
            }
            if c.side > 0.0 {
                c.buttons |= RIGHT;
            } else if c.side < 0.0 {
                c.buttons |= LEFT;
            }
            return c;
        }
        // Shared filter removes keyboard turn bits even on the ground and ladders.
        if self.id == "scroll" {
            c.buttons &= !((1 << 6) | (1 << 7) | (1 << 8));
        }
        if s.grounded != 0 || s.on_ladder != 0 || self.from_ladder {
            return c;
        }
        if ["wonly", "sideways"].contains(&self.id.as_str()) {
            if c.buttons & LEFT != 0 || c.side < 0.0 {
                c.side = 0.0;
                c.buttons &= !LEFT;
            }
            if self.id == "wonly" && (c.buttons & BACK != 0 || c.forward < 0.0) {
                c.forward = 0.0;
                c.buttons &= !BACK;
            }
            if c.buttons & RIGHT != 0 || c.side > 0.0 {
                c.side = 0.0;
                c.buttons &= !RIGHT;
            }
        }
        if self.id == "hsw" {
            if c.buttons & BACK != 0 || c.forward < 0.0 {
                c.forward = 0.0;
                c.buttons &= !BACK;
            }
            let fw = c.forward > 0.0;
            let lr = c.side != 0.0;
            if fw && !lr {
                c.forward = 0.0;
                c.buttons &= !(FORWARD | BACK);
            }
            if lr && !fw {
                c.side = 0.0;
                c.buttons &= !(LEFT | RIGHT);
            }
            if c.forward != 0.0 && c.side != 0.0 && c.forward != c.side.abs() {
                let m = c.forward.min(c.side.abs());
                c.forward = m;
                c.side = if c.side < 0.0 { -m } else { m };
            }
        }
        c
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_style_filter_oracle() {
        if std::process::Command::new("bun")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("bun unavailable; shared style oracle skipped");
            return;
        }
        let output = std::process::Command::new("bun")
            .arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/style-vectors.ts"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let cases: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let command = |v: &serde_json::Value| BhCmd {
            forward: v["forward"].as_f64().unwrap() as f32,
            side: v["side"].as_f64().unwrap() as f32,
            yaw: v["yaw"].as_f64().unwrap() as f32,
            pitch: v["pitch"].as_f64().unwrap() as f32,
            buttons: v["buttons"].as_u64().unwrap() as u32,
        };
        for case in cases.as_array().unwrap() {
            let style = case["style"].as_str().unwrap();
            let physics = case["physics"].as_u64().unwrap() as u32;
            let mut filter = Filter::new(style, physics);
            for (i, row) in case["rows"].as_array().unwrap().iter().enumerate() {
                let state = BhState {
                    grounded: u32::from(row["state"]["grounded"].as_bool().unwrap()),
                    on_ladder: u32::from(row["state"]["onLadder"].as_bool().unwrap()),
                    ..BhState::default()
                };
                let got = filter.apply(command(&row["cmd"]), state);
                let mut expected = command(&row["expected"]);
                // The pinned web filter predates v29 IN_TURN_FAST. All other fields remain its exact oracle.
                if style == "scroll" {
                    expected.buttons &= !(1 << 6);
                }
                assert_eq!(
                    (
                        got.forward.to_bits(),
                        got.side.to_bits(),
                        got.yaw.to_bits(),
                        got.pitch.to_bits(),
                        got.buttons
                    ),
                    (
                        expected.forward.to_bits(),
                        expected.side.to_bits(),
                        expected.yaw.to_bits(),
                        expected.pitch.to_bits(),
                        expected.buttons
                    ),
                    "{style}, physics{physics}, row{i}"
                );
            }
        }
    }
}
