//! Native port of apps/web/src/timer.ts and zones.ts. All timer arithmetic uses f64 like JS;
//! only the prespeed velocity written back to Game is rounded to f32.
use super::{
    BhCmd, BhSnapshot, BhState,
    run_timing::{self, Crossing, FRACTION_UNITS},
};
use bunnyhop_core::game::{EVENT_JUMPED, EVENT_RESPAWNED, EVENT_TELEPORTED};
use serde_json::{Value, json};

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BhZone {
    pub kind: u32,
    pub track: u32,
    pub index: u32,
    pub mins: [f32; 3],
    pub maxs: [f32; 3],
}
impl BhZone {
    pub fn contains(&self, pos: [f32; 3], crouched: bool) -> bool {
        let p = pos.map(f64::from);
        p[0] - 16.0 <= f64::from(self.maxs[0])
            && p[0] + 16.0 >= f64::from(self.mins[0])
            && p[1] - 16.0 <= f64::from(self.maxs[1])
            && p[1] + 16.0 >= f64::from(self.mins[1])
            && p[2] <= f64::from(self.maxs[2])
            && p[2] + if crouched { 45.0 } else { 62.0 } >= f64::from(self.mins[2])
    }
    pub fn json(&self) -> Value {
        let mut v = json!({"kind": (["start","end","stage","checkpoint"][self.kind as usize]), "mins": self.mins, "maxs": self.maxs});
        if self.track != 0 {
            v["track"] = self.track.into();
        }
        if self.kind >= 2 {
            v["index"] = self.index.into();
        }
        v
    }
}
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct BhRunOptions {
    pub prespeed_cap: f32,
    pub cap_enabled: u32,
    pub rules: u32,
    pub block_prehops: u32,
    pub strafe_keys: u32,
}
impl Default for BhRunOptions {
    fn default() -> Self {
        Self {
            prespeed_cap: 290.0,
            cap_enabled: 1,
            rules: 2,
            block_prehops: 0,
            strafe_keys: 0,
        }
    }
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BhRunState {
    pub status: u32,
    pub track: u32,
    pub start_tick: u32,
    pub end_tick: u32,
    pub last_tick: u32,
    pub jumps: u32,
    pub strafes: u32,
    pub perfect_jumps: u32,
    pub measured_jumps: u32,
    pub sync_good: u32,
    pub sync_total: u32,
    pub in_start: u32,
    pub pending_start: u32,
    pub update_flags: u32,
    pub split_count: u32,
    pub last_perfect_tick: i32,
    pub recording: u32,
    pub recording_valid: u32,
    pub total_commands: u64,
    pub rolling_hash: u32,
    pub seconds: f64,
    pub sync_percent: f64,
    pub perf_percent: f64,
}
#[derive(Clone, Debug)]
pub struct Split {
    pub index: u32,
    pub kind: u32,
    pub ticks: u32,
}
#[derive(Clone, Debug)]
pub struct Timer {
    pub zones: Vec<BhZone>,
    pub options: BhRunOptions,
    pub interval: f64,
    pub state: BhRunState,
    pub splits: Vec<Split>,
    was_in_start: bool,
    armed: bool,
    ground_since: i64,
    was_on_ground: bool,
    pre_grounded: Option<bool>,
    perf_ground_ticks: u32,
    last_side: i32,
    prev_yaw: f64,
    prev_position: Option<[f32; 3]>,
    start_crossing: Crossing,
    end_crossing: Crossing,
}
impl Timer {
    pub fn new(zones: Vec<BhZone>, options: BhRunOptions, interval: f32) -> Self {
        Self {
            zones,
            options,
            interval: f64::from(interval),
            state: BhRunState {
                last_perfect_tick: -1,
                ..BhRunState::default()
            },
            splits: Vec::new(),
            was_in_start: false,
            armed: false,
            ground_since: 0,
            was_on_ground: false,
            pre_grounded: None,
            perf_ground_ticks: 0,
            last_side: 0,
            prev_yaw: f64::NAN,
            prev_position: None,
            start_crossing: Crossing::boundary(0),
            end_crossing: Crossing::boundary(FRACTION_UNITS),
        }
    }
    pub fn reset(&mut self, interval: f32) {
        *self = Self::new(self.zones.clone(), self.options, interval);
    }
    // v27 practice noclip: clock only, without zones, splits, stats or prespeed.
    pub fn coast(&mut self, tick: u32) {
        self.state.last_tick = tick;
        self.state.update_flags = 0;
        self.state.last_perfect_tick = -1;
        self.perf_ground_ticks = 0;
        self.pre_grounded = None;
        self.was_on_ground = false;
        self.ground_since = 0;
        self.prev_yaw = f64::NAN;
        self.prev_position = None;
        self.state.seconds = if self.state.status == 2 {
            self.time_ms() as f64 / 1000.0
        } else {
            f64::from(self.ticks()) * self.interval
        };
    }
    fn touching(
        &self,
        pos: [f32; 3],
        crouched: bool,
        kind: u32,
        track: Option<u32>,
    ) -> Option<BhZone> {
        self.zones
            .iter()
            .filter(|z| {
                z.kind == kind && track.is_none_or(|t| z.track == t) && z.contains(pos, crouched)
            })
            .min_by_key(|z| z.track)
            .copied()
    }
    fn clear_stats(&mut self) {
        let s = &mut self.state;
        s.jumps = 0;
        s.strafes = 0;
        s.sync_good = 0;
        s.sync_total = 0;
        s.perfect_jumps = 0;
        s.measured_jumps = 0;
        s.last_perfect_tick = -1;
        s.split_count = 0;
        self.last_side = 0;
        self.splits.clear();
        self.start_crossing = Crossing::boundary(0);
        self.end_crossing = Crossing::boundary(FRACTION_UNITS);
    }
    pub fn before_step(&mut self, cmd: BhCmd, s: BhState) -> Option<[f32; 3]> {
        let grounded = s.grounded != 0 && s.on_ladder == 0;
        let landed = self.pre_grounded == Some(false) && grounded;
        self.pre_grounded = Some(grounded);
        if self.options.block_prehops == 0 || !landed || cmd.buttons & (1 << 1) == 0 {
            return None;
        }
        self.touching(s.position, s.crouched != 0, 0, None)
            .map(|_| [0.0; 3])
    }
    fn valid_start(&mut self, s: BhState) -> bool {
        let ground = s.grounded != 0 && s.on_ladder == 0;
        let [vx, vy, vz] = s.velocity.map(f64::from);
        let speed_sq = vx * vx + vy * vy;
        if !ground {
            self.ground_since = 0;
        } else if !self.was_on_ground || self.ground_since == 0 {
            self.ground_since = i64::from(s.tick);
        } else if self.ground_since > 0 && speed_sq + vz * vz <= 1000.0 {
            self.ground_since = -1;
        }
        self.was_on_ground = ground;
        if !ground {
            return false;
        }
        let speed = speed_sq.sqrt();
        if self.options.cap_enabled != 0 && speed > f64::from(self.options.prespeed_cap) {
            return false;
        }
        speed <= 50.0
            || self.ground_since < 0
            || i64::from(s.tick) - self.ground_since >= (0.5 / self.interval + 0.5).floor() as i64
    }
    fn cap(&self, s: BhState) -> Option<[f32; 3]> {
        if self.options.cap_enabled == 0 {
            return None;
        }
        let [vx, vy, _] = s.velocity.map(f64::from);
        let speed = (vx * vx + vy * vy).sqrt();
        let cap = f64::from(self.options.prespeed_cap);
        if speed > cap {
            let f = cap / speed;
            Some([(vx * f) as f32, (vy * f) as f32, s.velocity[2]])
        } else {
            None
        }
    }
    #[cfg(test)]
    pub fn update(&mut self, cmd: BhCmd, s: BhState) -> Option<[f32; 3]> {
        self.update_observed(cmd, s, None)
    }
    pub fn update_observed(
        &mut self,
        cmd: BhCmd,
        s: BhState,
        game: Option<&bunnyhop_core::Game>,
    ) -> Option<[f32; 3]> {
        let from = self.prev_position;
        self.prev_position = Some(s.position);
        let events = s.events;
        self.state.last_tick = s.tick;
        self.state.update_flags = 0;
        if s.on_ladder != 0 || events & (EVENT_JUMPED | EVENT_TELEPORTED | EVENT_RESPAWNED) != 0 {
            self.state.last_perfect_tick = -1;
        }
        let pass_end = self.state.status == 1
            && s.touch_position.iter().all(|x| x.is_finite())
            && events & EVENT_RESPAWNED == 0
            && self
                .touching(
                    s.touch_position,
                    s.touch_crouched != 0,
                    1,
                    Some(self.state.track),
                )
                .is_some();
        let start = self
            .touching(s.position, s.crouched != 0, 0, Some(self.state.track))
            .or_else(|| self.touching(s.position, s.crouched != 0, 0, None));
        let in_start = start.is_some();
        let mut clamp = None;
        if self.options.rules == 1 {
            if let Some(start) = start.filter(|_| !pass_end) {
                if self.state.status != 0 {
                    self.state.update_flags |= 4;
                }
                self.state.status = 0;
                self.state.track = start.track;
                self.clear_stats();
            } else if self.state.status == 0 && self.was_in_start {
                self.state.status = 1;
                self.state.start_tick = s.tick;
                self.clear_stats();
                self.start_crossing =
                    run_timing::measure(game, s, from, &self.zones, self.state.track, false, false);
                self.state.update_flags |= 1;
                clamp = self.cap(s);
            }
        } else {
            let armed = self.valid_start(s) && start.is_some();
            if armed && !pass_end {
                if self.state.status != 0 {
                    self.state.update_flags |= 4;
                }
                self.state.status = 0;
                self.state.track = start.unwrap().track;
                self.clear_stats();
                self.state.pending_start = 0;
                self.armed = true;
            } else {
                if self.state.status == 0 && self.armed {
                    self.state.pending_start = s.tick;
                    self.start_crossing = if !in_start && events & EVENT_JUMPED == 0 {
                        run_timing::measure(
                            game,
                            s,
                            from,
                            &self.zones,
                            self.state.track,
                            false,
                            false,
                        )
                    } else {
                        Crossing::boundary(0)
                    };
                    clamp = self.cap(s);
                }
                self.armed = false;
                if self.state.status == 0 && self.state.pending_start != 0 && !in_start {
                    self.state.status = 1;
                    self.state.start_tick = self.state.pending_start;
                    self.state.pending_start = 0;
                    self.state.update_flags |= 1;
                }
            }
        }
        if clamp.is_some() {
            self.state.update_flags |= 8;
        }
        self.was_in_start = in_start;
        self.state.in_start = u32::from(in_start);
        if self.state.status == 1 || self.state.pending_start != 0 {
            if events & EVENT_JUMPED != 0 {
                self.state.jumps += 1;
                if s.on_ladder == 0
                    && events & EVENT_RESPAWNED == 0
                    && self.perf_ground_ticks > 0
                    && f64::from(self.perf_ground_ticks)
                        < ((0.1 / self.interval) as f32 as f64).ceil()
                {
                    self.state.measured_jumps += 1;
                    if self.perf_ground_ticks == 1 {
                        self.state.perfect_jumps += 1;
                        if events & (EVENT_TELEPORTED | EVENT_RESPAWNED) == 0 {
                            self.state.last_perfect_tick = s.tick as i32;
                        }
                    }
                }
            }
            let value = if self.options.strafe_keys == 0 {
                cmd.side
            } else {
                cmd.forward
            };
            let axis = if value > 0.0 {
                1
            } else if value < 0.0 {
                -1
            } else {
                0
            };
            if self.options.strafe_keys == 2 {
                if axis > 0 && self.last_side <= 0 {
                    self.state.strafes += 1;
                }
                self.last_side = axis;
            } else {
                if axis != 0 && axis != self.last_side {
                    self.state.strafes += 1;
                }
                if axis != 0 {
                    self.last_side = axis;
                }
            }
            if s.grounded == 0 && !self.prev_yaw.is_nan() {
                let yaw = f64::from(cmd.yaw);
                let mut d = yaw - self.prev_yaw;
                if d > 180.0 {
                    d -= 360.0;
                } else if d < -180.0 {
                    d += 360.0;
                }
                if d != 0.0 {
                    self.state.sync_total += 1;
                    let yr = yaw * std::f64::consts::PI / 180.0;
                    let fx = yr.cos();
                    let fy = yr.sin();
                    let wx = f64::from(cmd.forward) * fx + f64::from(cmd.side) * fy;
                    let wy = f64::from(cmd.forward) * fy - f64::from(cmd.side) * fx;
                    let cross = f64::from(s.velocity[0]) * wy - f64::from(s.velocity[1]) * wx;
                    if d > 0.0 && cross > 0.0 || d < 0.0 && cross < 0.0 {
                        self.state.sync_good += 1;
                    }
                }
            }
        }
        if self.state.status == 1 {
            let last = self.splits.last().map_or(-1, |s| i64::from(s.index));
            if let Some(z) = self.zones.iter().find(|z| {
                z.kind >= 2
                    && z.track == self.state.track
                    && i64::from(z.index) > last
                    && z.contains(s.position, s.crouched != 0)
            }) {
                self.splits.push(Split {
                    index: z.index,
                    kind: z.kind,
                    ticks: s.tick - self.state.start_tick,
                });
                self.state.split_count = self.splits.len() as u32;
                self.state.update_flags |= 16;
            }
            if pass_end
                || self
                    .touching(s.position, s.crouched != 0, 1, Some(self.state.track))
                    .is_some()
            {
                self.state.status = 2;
                self.state.end_tick = s.tick;
                self.end_crossing = run_timing::measure(
                    game,
                    s,
                    from,
                    &self.zones,
                    self.state.track,
                    true,
                    pass_end,
                );
                self.state.update_flags |= 2;
            }
        }
        self.perf_ground_ticks =
            if s.grounded != 0 && s.on_ladder == 0 && events & EVENT_RESPAWNED == 0 {
                self.perf_ground_ticks + 1
            } else {
                0
            };
        self.prev_yaw = f64::from(cmd.yaw);
        self.state.seconds = if self.state.status == 2 {
            self.time_ms() as f64 / 1000.0
        } else {
            f64::from(self.ticks()) * self.interval
        };
        self.state.sync_percent = if self.state.sync_total != 0 {
            100.0 * f64::from(self.state.sync_good) / f64::from(self.state.sync_total)
        } else {
            0.0
        };
        self.state.perf_percent = if self.state.measured_jumps != 0 {
            100.0 * f64::from(self.state.perfect_jumps) / f64::from(self.state.measured_jumps)
        } else {
            0.0
        };
        clamp
    }
    pub fn ticks(&self) -> u32 {
        match self.state.status {
            1 => self.state.last_tick - self.state.start_tick,
            2 => self.state.end_tick - self.state.start_tick,
            _ => 0,
        }
    }
    pub fn time_units(&self) -> u64 {
        if self.state.status != 2 {
            return 0;
        }
        run_timing::time_units(
            self.state.start_tick,
            self.start_crossing.fraction,
            self.state.end_tick,
            self.end_crossing.fraction,
        )
    }
    pub fn time_ms(&self) -> u64 {
        run_timing::units_to_ms(self.time_units(), self.interval)
    }
    pub fn timing(&self) -> Value {
        if self.state.status != 2 {
            return Value::Null;
        }
        json!({"policy":run_timing::POLICY,"startTick":self.state.start_tick,"endTick":self.state.end_tick,
               "start":self.start_crossing.json(),"end":self.end_crossing.json(),
               "units":self.time_units(),"ms":self.time_ms()})
    }
    pub fn json(&self) -> Value {
        json!({"status":(["idle","running","finished"][self.state.status as usize]),"track":self.state.track,
            "startTick":self.state.start_tick,"endTick":self.state.end_tick,"lastTick":self.state.last_tick,"ticks":self.ticks(),"seconds":self.state.seconds,"timeMs":self.time_ms(),"timingPolicy":run_timing::POLICY,"timing":self.timing(),
            "jumps":self.state.jumps,"strafes":self.state.strafes,"perfectJumps":self.state.perfect_jumps,"measuredJumps":self.state.measured_jumps,"lastPerfectTick":self.state.last_perfect_tick,
            "syncGood":self.state.sync_good,"syncTotal":self.state.sync_total,"syncPercent":self.state.sync_percent,"perfPercent":self.state.perf_percent,
            "inStart":self.state.in_start!=0,"pendingStart":self.state.pending_start,"updateFlags":self.state.update_flags,
            "splits":self.splits.iter().map(|s|json!({"index":s.index,"kind":if s.kind==2 {"stage"} else {"checkpoint"},"ticks":s.ticks})).collect::<Vec<_>>()})
    }
}
pub fn snapshot_json(s: BhSnapshot) -> Value {
    let p = s.player;
    let floats = p
        .position
        .into_iter()
        .chain(p.velocity)
        .chain([p.view_offset_z])
        .chain(p.teleport_angles)
        .chain(p.angle_change)
        .chain(p.touch_position)
        .chain([s.stamina_ms])
        .chain(s.base_velocity)
        .chain([s.health, s.gravity_scale, s.speed_scale])
        .map(f32::to_bits)
        .collect::<Vec<_>>();
    json!({"tick":p.tick,"position":p.position,"velocity":p.velocity,"viewOffsetZ":p.view_offset_z,
        "grounded":p.grounded!=0,"crouched":p.crouched!=0,"onLadder":p.on_ladder!=0,"events":p.events,
        "teleportAngles":p.teleport_angles,"angleChange":p.angle_change,
        "touchPosition":if p.touch_position.iter().all(|v|v.is_finite()) {Some(p.touch_position)} else {None},"touchCrouched":p.touch_crouched!=0,
        "staminaMs":s.stamina_ms,"baseVelocity":s.base_velocity,"health":s.health,"gravityScale":s.gravity_scale,"speedScale":s.speed_scale,
        "weapons":s.weapons,"activeWeapon":s.active_weapon,"movementMode":s.movement_mode,"waterLevel":s.water_level,"floatBits":floats})
}
pub const HASH_SEED: u32 = 0x811c9dc5;
pub fn fold_command(mut h: u32, c: BhCmd) -> u32 {
    for word in [
        u32::from(c.forward as i16 as u16) | (u32::from(c.side as i16 as u16) << 16),
        c.buttons,
        c.yaw.to_bits(),
        c.pitch.to_bits(),
    ] {
        for b in word.to_le_bytes() {
            h = (h ^ u32::from(b)).wrapping_mul(0x01000193);
        }
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;
    fn zone(kind: u32, track: u32, index: u32, x: f32) -> BhZone {
        BhZone {
            kind,
            track,
            index,
            mins: [x, -10.0, 0.0],
            maxs: [x + 10.0, 10.0, 100.0],
        }
    }
    fn state(tick: u32, x: f32, ground: bool) -> BhState {
        BhState {
            tick,
            position: [x, 0.0, 0.0],
            grounded: u32::from(ground),
            touch_position: [f32::NAN; 3],
            ..BhState::default()
        }
    }
    #[test]
    fn rules2_pending_takeoff_rearm_and_touch_pass_finish() {
        let mut t = Timer::new(
            vec![zone(0, 0, 0, 0.0), zone(1, 0, 0, 100.0)],
            BhRunOptions::default(),
            0.01,
        );
        assert!(t.update(BhCmd::default(), state(1, 0.0, true)).is_none());
        let jump = BhState {
            events: EVENT_JUMPED,
            ..state(2, 0.0, false)
        };
        t.update(BhCmd::default(), jump);
        assert_eq!(
            (t.state.status, t.state.pending_start, t.state.jumps),
            (0, 2, 1)
        );
        t.update(BhCmd::default(), state(3, 0.0, true));
        assert_eq!(
            (t.state.status, t.state.pending_start, t.state.jumps),
            (0, 0, 0)
        );
        t.update(
            BhCmd::default(),
            BhState {
                events: EVENT_JUMPED,
                ..state(4, 0.0, false)
            },
        );
        t.update(BhCmd::default(), state(5, 50.0, false));
        assert_eq!(
            (t.state.status, t.state.start_tick, t.state.update_flags),
            (1, 4, 1)
        );
        t.update(
            BhCmd::default(),
            BhState {
                events: EVENT_TELEPORTED,
                touch_position: [100.0, 0.0, 0.0],
                ..state(6, 0.0, false)
            },
        );
        assert_eq!(
            (t.state.status, t.state.start_tick, t.state.end_tick),
            (2, 4, 6)
        );
        assert_eq!(t.ticks(), 2);
        let mut death = t.clone();
        death.state.status = 1;
        death.update(
            BhCmd::default(),
            BhState {
                events: EVENT_RESPAWNED,
                touch_position: [100.0, 0.0, 0.0],
                ..state(7, 50.0, false)
            },
        );
        assert_eq!(death.state.status, 1);
    }
    #[test]
    fn track_priority_split_order_and_exact_clamp_and_prehop() {
        let zones = vec![
            zone(0, 1, 0, 0.0),
            zone(0, 0, 0, 0.0),
            zone(1, 1, 0, 100.0),
            zone(2, 1, 1, 50.0),
            zone(3, 1, 2, 75.0),
        ];
        let mut t = Timer::new(
            zones,
            BhRunOptions {
                rules: 1,
                block_prehops: 1,
                ..BhRunOptions::default()
            },
            0.01,
        );
        t.state.track = 1;
        t.update(BhCmd::default(), state(1, 0.0, true));
        assert_eq!(t.state.track, 1);
        t.before_step(BhCmd::default(), state(1, 0.0, false));
        assert_eq!(
            t.before_step(
                BhCmd {
                    buttons: 2,
                    ..BhCmd::default()
                },
                state(2, 0.0, true)
            ),
            Some([0.0; 3])
        );
        let capped = t
            .update(
                BhCmd::default(),
                BhState {
                    velocity: [300.0, 400.0, 33.0],
                    ..state(2, 50.0, false)
                },
            )
            .unwrap();
        assert_eq!(capped, [174.0, 232.0, 33.0]);
        assert_eq!(t.state.update_flags, 1 | 8 | 16);
        t.update(BhCmd::default(), state(3, 75.0, false));
        assert_eq!(
            t.splits.iter().map(|s| s.index).collect::<Vec<_>>(),
            vec![1, 2]
        );
        t.update(BhCmd::default(), state(4, 50.0, false));
        assert_eq!(t.splits.len(), 2);
        let z = zone(0, 0, 0, 0.0);
        assert!(z.contains([-16.0, 0.0, -62.0], false));
        assert!(!z.contains([-16.0, 0.0, -62.0], true));
    }
}
