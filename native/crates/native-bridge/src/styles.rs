//! Exact command/style transform from apps/web/src/styles.ts and autostrafe.ts.
use super::{BhCmd, BhSettings, BhState};
pub const IDS: [&str; 11] = [
    "autohop",
    "legit",
    "scroll",
    "wonly",
    "sideways",
    "hsw",
    "lowgrav",
    "autostrafe",
    "segmented",
    "infinite",
    "backwards",
];
const JUMP: u32 = 1 << 1;
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
    if id == "infinite" {
        s.air_jump = 1;
    }
    Ok(s)
}
/// apps/web/src/styles.ts styleStartReentryCap: 3510 sits just above Infinite's 3500 noclip ceiling. 0 = off.
pub fn start_reentry_cap(id: &str) -> f32 {
    if id == "infinite" { 3510.0 } else { 0.0 }
}
/// apps/web/src/styles.ts stylePrespeedCap: Scroll and Infinite have no prespeed cap.
pub fn has_prespeed_cap(id: &str) -> bool {
    id != "scroll" && id != "infinite"
}
// Backwards (styles.ts BW_*). The decision must match the browser and the verifier bit for bit on every OS, so it
// uses only f64 + - * % and comparisons, evaluated in the website's order: no sin, cos, sqrt or mul_add.
/// Ground ticks after a landing that are still checked: the jump tick and 4 more.
const BW_GROUND_GRACE: u32 = 5;
/// Below 35 u/s (squared) the heading isn't judged.
const BW_MIN_SPEED_SQ: f64 = 1225.0;
/// cos²(36.87°): the view must be within 36.87° of straight back.
const BW_DOT_SQ: f64 = 0.64;
const BW_RADIANS_PER_DEGREE: f64 = 0.017453292519943295;
// Taylor coefficients for |x| <= pi/4; each is 1/n! as an f64.
const SIN_3: f64 = -0.16666666666666666;
const SIN_5: f64 = 0.008333333333333333;
const SIN_7: f64 = -0.0001984126984126984;
const SIN_9: f64 = 2.7557319223985893e-6;
const SIN_11: f64 = -2.505210838544172e-8;
const COS_2: f64 = -0.5;
const COS_4: f64 = 0.041666666666666664;
const COS_6: f64 = -0.001388888888888889;
const COS_8: f64 = 2.48015873015873e-5;
const COS_10: f64 = -2.755731922398589e-7;
const COS_12: f64 = 2.08767569878681e-9;

/// (cos, sin) of a yaw in degrees, bit-identical to styles.ts bwDir.
pub fn bw_dir(yaw: f32) -> (f64, f64) {
    let mut r = f64::from(yaw) % 360.0;
    if r > 180.0 {
        r -= 360.0;
    } else if r < -180.0 {
        r += 360.0;
    }
    let mut quadrant = 0;
    if r > 135.0 {
        quadrant = 2;
        r -= 180.0;
    } else if r > 45.0 {
        quadrant = 1;
        r -= 90.0;
    } else if r < -135.0 {
        quadrant = 2;
        r += 180.0;
    } else if r < -45.0 {
        quadrant = 3;
        r += 90.0;
    }
    let x = r * BW_RADIANS_PER_DEGREE;
    let x2 = x * x;
    let s = x * (1.0 + x2 * (SIN_3 + x2 * (SIN_5 + x2 * (SIN_7 + x2 * (SIN_9 + x2 * SIN_11)))));
    let c = 1.0
        + x2 * (COS_2 + x2 * (COS_4 + x2 * (COS_6 + x2 * (COS_8 + x2 * (COS_10 + x2 * COS_12)))));
    match quadrant {
        0 => (c, s),
        1 => (-s, c),
        2 => (-c, -s),
        _ => (s, -c),
    }
}

/// styles.ts facesBackwards: whether the view faces back against the horizontal velocity. None under 35 u/s.
pub fn faces_backwards(yaw: f32, vx: f32, vy: f32) -> Option<bool> {
    let vx = f64::from(vx);
    let vy = f64::from(vy);
    let speed_sq = vx * vx + vy * vy;
    if speed_sq < BW_MIN_SPEED_SQ {
        return None;
    }
    let (c, s) = bw_dir(yaw);
    let dot = c * vx + s * vy;
    Some(dot <= 0.0 && dot * dot >= BW_DOT_SQ * speed_sq)
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
    bw_ground: u32,
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
            // A spawn is not a landing.
            bw_ground: BW_GROUND_GRACE + 1,
        }
    }
    pub fn reset(&mut self, physics: u32) {
        *self = Self::new(&self.id, physics);
    }
    /// `edge_landing`: physics v22's landing that the next command can still take back (`State::edge_landing`).
    pub fn apply(&mut self, mut c: BhCmd, s: BhState, edge_landing: bool) -> BhCmd {
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
        if self.id == "backwards" {
            return self.backwards(c, &s);
        }
        // Shared filter removes keyboard turn bits even on the ground and ladders.
        if self.id == "scroll" {
            c.buttons &= !((1 << 6) | (1 << 7) | (1 << 8));
        }
        // Without a jump the core takes an edge landing back before it moves, so the key rules see an air tick.
        let grounded = s.grounded != 0 && !(edge_landing && c.buttons & JUMP == 0);
        if grounded || s.on_ladder != 0 || self.from_ladder {
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
    /// styles.ts StyleFilter.backwards: in the air and on the first ground ticks after a landing, a view that doesn't
    /// face backwards loses its movement keys. Ladders, the air after one and slow speeds are exempt.
    fn backwards(&mut self, mut c: BhCmd, s: &BhState) -> BhCmd {
        self.bw_ground = if s.grounded != 0 {
            (self.bw_ground + 1).min(BW_GROUND_GRACE + 1)
        } else {
            0
        };
        if s.on_ladder != 0 || self.from_ladder || self.bw_ground > BW_GROUND_GRACE {
            return c;
        }
        if faces_backwards(c.yaw, s.velocity[0], s.velocity[1]) != Some(false) {
            return c;
        }
        c.forward = 0.0;
        c.side = 0.0;
        c.buttons &= !MOVE;
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
                let velocity = &row["state"]["velocity"];
                let state = BhState {
                    grounded: u32::from(row["state"]["grounded"].as_bool().unwrap()),
                    on_ladder: u32::from(row["state"]["onLadder"].as_bool().unwrap()),
                    velocity: [0, 1, 2].map(|axis| velocity[axis].as_f64().unwrap() as f32),
                    ..BhState::default()
                };
                let edge_landing = row["state"]["edgeLanding"].as_bool().unwrap();
                let got = filter.apply(command(&row["cmd"]), state, edge_landing);
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
