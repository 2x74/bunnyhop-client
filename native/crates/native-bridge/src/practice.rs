//! Exact existing practice mechanics; never part of ranked replay simulation.
use super::*;

fn invalidate_recording(m: &mut Map, reason: &str) -> Result<(), String> {
    m.finish_record(false, reason)?;
    // A completed archive from before the tool use must not remain exportable
    // as though it described this externally mutated world.
    m.record_valid = false;
    m.completed_record = None;
    Ok(())
}

/// Continue a successfully sought replay as practice. Mirrors replayStartProblem:
/// current settings/rules, selected style (bonuses use Normal), same loaded map.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_practice_from_replay(
    ctx: *mut BhContext,
    selected_style: *const c_char,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            let selected = string(selected_style)?;
            styles::settings(selected)?;
            let m = c.map()?;
            let playback = m.playback.as_ref().ok_or("load and seek a replay first")?;
            if playback.error.is_some() {
                return Err("desynced replay is watch-only".into());
            }
            let info: serde_json::Value = serde_json::from_slice(playback.data.info.as_bytes())
                .map_err(|e| e.to_string())?;
            let expected_style = if info["track"].as_u64().unwrap_or(0) > 0 {
                "autohop"
            } else {
                selected
            };
            let expected_settings = styles::settings(expected_style)?;
            if info["map"].as_str() != Some(m.map_name.as_str())
                || playback.data.style != expected_style
                || playback.data.options.rules != 2
                || recording::settings_json(playback.data.settings)
                    != recording::settings_json(expected_settings)
            {
                return Err("replay map/style/settings/rules cannot continue as current practice".into());
            }
            invalidate_recording(m, "practice_from_replay")?;
            m.playback = None;
            m.invalidate_jump_observation();
            Ok(())
        })
    }
}

pub struct Checkpoint {
    game: game::GameState,
    pub(crate) segment: Option<segments::Mark>,
    settings: BhSettings,
    filter: styles::Filter,
    timer: Option<run::Timer>,
    command: BhCmd,
    yaw: f32,
    pitch: f32,
}
impl Checkpoint {
    fn bytes(&self) -> usize {
        self.game.approx_bytes() + self.segment.as_ref().map_or(0, segments::Mark::bytes)
    }
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BhNoclipState {
    pub position: [f64; 3],
    pub velocity: [f64; 3],
}
impl BhNoclipState {
    fn checked(&self) -> Result<(), String> {
        if self
            .position
            .iter()
            .chain(&self.velocity)
            .all(|v| v.is_finite())
        {
            Ok(())
        } else {
            Err("nonfinite noclip state".into())
        }
    }
    fn advance(&mut self, c: BhCmd, dt: f64) {
        let yr = f64::from(c.yaw) * std::f64::consts::PI / 180.0;
        let pr = f64::from(c.pitch) * std::f64::consts::PI / 180.0;
        let (sy, cy) = (yr.sin(), yr.cos());
        let (sp, cp) = (pr.sin(), pr.cos());
        let slow = c.buttons & 4 != 0;
        let factor = if slow { 1.25 } else { 5.0 };
        let (f, s) = (f64::from(c.forward) * factor, f64::from(c.side) * factor);
        let wish = [
            cp * cy * f + sy * s,
            cp * sy * f - cy * s,
            -sp * f
                + if c.buttons & 2 != 0 {
                    450.0 * factor
                } else {
                    0.0
                },
        ];
        let len = wish[0].hypot(wish[1]).hypot(wish[2]);
        let dir = wish.map(|x| if len > 0.0 { x / len } else { 0.0 });
        let wish_speed = len.min(if slow { 400.0 } else { 1600.0 });
        let current =
            self.velocity[0] * dir[0] + self.velocity[1] * dir[1] + self.velocity[2] * dir[2];
        let add = wish_speed - current;
        if add > 0.0 {
            let accel = (5.0 * dt * wish_speed).min(add);
            for (i, d) in dir.iter().enumerate() {
                self.velocity[i] += accel * d;
            }
        }
        let speed = self.velocity[0]
            .hypot(self.velocity[1])
            .hypot(self.velocity[2]);
        if speed < 1.0 {
            self.velocity = [0.0; 3];
            return;
        }
        let scale = (speed - speed.max(400.0) * 4.0 * dt).max(0.0) / speed;
        for i in 0..3 {
            self.velocity[i] *= scale;
            self.position[i] = (self.position[i] + self.velocity[i] * dt).clamp(-16303.0, 16303.0);
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_noclip_move(
    state: *mut BhNoclipState,
    cmd: *const BhCmd,
    dt: f64,
) -> c_int {
    catch_unwind(AssertUnwindSafe(|| unsafe {
        let mut s = input(state)?;
        let cmd = input(cmd)?;
        s.checked()?;
        finite(&[cmd.forward, cmd.side, cmd.yaw, cmd.pitch])?;
        if !dt.is_finite() || dt <= 0.0 || dt > 1.0 {
            return Err("noclip dt outside (0,1]".to_string());
        }
        s.advance(cmd, dt);
        s.checked()?;
        output(state, s)
    }))
    .ok()
    .is_some_and(|r| r.is_ok()) as c_int
}
/// Host practice mode invalidates recording immediately. Noclip always stops the
/// timer: a running one ends (noclip is not part of a timed attempt), and an idle
/// one is disarmed, so crossing a start zone while flying cannot arm a run.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_practice_enter(ctx: *mut BhContext, noclip: u32) -> c_int {
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            invalidate_recording(m, "practice")?;
            m.playback = None;
            if noclip != 0 {
                if let Some(t) = &mut m.timer {
                    t.reset(t.interval as f32);
                }
            }
            Ok(())
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_practice_noclip_tick(
    ctx: *mut BhContext,
    state: *const BhNoclipState,
    out: *mut BhSnapshot,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            let s = input(state)?;
            s.checked()?;
            let position = s.position.map(|v| v as f32);
            let velocity = s.velocity.map(|v| v as f32);
            finite(&position)?;
            finite(&velocity)?;
            if out.is_null() {
                return Err("null output".into());
            }
            let m = c.map()?;
            invalidate_recording(m, "practice_noclip")?;
            m.playback = None;
            m.game.practice_noclip_tick(position, velocity);
            if let Some(t) = &mut m.timer {
                if t.state.status == 1 {
                    t.coast(m.game.tick);
                }
            }
            m.transforms_dirty = true;
            output(out, BhSnapshot::from(&m.game))
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_practice_noclip_exit(
    ctx: *mut BhContext,
    state: *const BhNoclipState,
    yaw: f32,
    pitch: f32,
    out: *mut BhSnapshot,
) -> u32 {
    let mut result = 0;
    unsafe {
        call(ctx, |c| {
            let s = input(state)?;
            s.checked()?;
            finite(&[yaw, pitch])?;
            let position = s.position.map(|v| v as f32);
            let velocity = s.velocity.map(|v| v as f32);
            finite(&position)?;
            finite(&velocity)?;
            if out.is_null() {
                return Err("null output".into());
            }
            let m = c.map()?;
            invalidate_recording(m, "practice_noclip")?;
            m.playback = None;
            result = m.game.practice_noclip_exit(position, velocity, yaw, pitch);
            m.transforms_dirty = true;
            output(out, BhSnapshot::from(&m.game))
        })
    };
    result
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_practice_save(ctx: *mut BhContext, yaw: f32, pitch: f32) -> u32 {
    let mut handle = 0;
    unsafe {
        call(ctx, |c| {
            finite(&[yaw, pitch])?;
            let settings = c.settings;
            let m = c.map()?;
            if m.checkpoints.iter().filter(|s| s.is_some()).count() >= 100 {
                return Err("100 practice checkpoints already retained".into());
            }
            let checkpoint = Checkpoint {
                game: m.game.save_state(),
                segment: m.segment_mark()?,
                settings,
                filter: m.filter.clone(),
                timer: m.timer.clone(),
                command: m.last_command,
                yaw,
                pitch,
            };
            if m.checkpoints
                .iter()
                .flatten()
                .map(Checkpoint::bytes)
                .sum::<usize>()
                .saturating_add(checkpoint.bytes())
                > 128 << 20
            {
                return Err("practice checkpoints exceed 128 MiB".into());
            }
            let at = m
                .checkpoints
                .iter()
                .position(Option::is_none)
                .unwrap_or(m.checkpoints.len());
            if at == m.checkpoints.len() {
                m.checkpoints.push(Some(checkpoint));
            } else {
                m.checkpoints[at] = Some(checkpoint);
            }
            handle = at as u32 + 1;
            Ok(())
        })
    };
    handle
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_practice_restore(
    ctx: *mut BhContext,
    handle: u32,
    view: *mut BhCmd,
    out: *mut BhSnapshot,
) -> c_int {
    unsafe { restore(ctx, handle, view, out, false) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_segment_restore(
    ctx: *mut BhContext, handle: u32, view: *mut BhCmd, out: *mut BhSnapshot,
) -> c_int {
    unsafe { restore(ctx, handle, view, out, true) }
}
unsafe fn restore(
    ctx: *mut BhContext, handle: u32, view: *mut BhCmd, out: *mut BhSnapshot, segmented: bool,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            if view.is_null() || out.is_null() {
                return Err("null output".into());
            }
            let m = c.map()?;
            if m.checkpoints
                .get(handle.wrapping_sub(1) as usize)
                .and_then(Option::as_ref)
                .is_none()
            {
                return Err("invalid practice checkpoint".into());
            }
            let recording = if segmented {
                Some(m.segment_recording(handle)?)
            } else {
                invalidate_recording(m, "practice_restore")?;
                None
            };
            m.playback = None;
            let s = m.checkpoints[handle as usize - 1].as_ref().unwrap();
            m.game.restore_state(&s.game);
            m.filter = s.filter.clone();
            m.timer = s.timer.clone();
            m.last_command = s.command;
            m.transforms_dirty = true;
            let settings = s.settings;
            let style = s.filter.id.clone();
            output(
                view,
                BhCmd {
                    yaw: s.yaw,
                    pitch: s.pitch,
                    ..BhCmd::default()
                },
            )?;
            output(out, BhSnapshot::from(&m.game))?;
            if let Some(mut recorder) = recording {
                recorder.data.segments.push(segments::Load {
                    tick: m.game.tick, position: BhState::from(&m.game).position, velocity: BhState::from(&m.game).velocity,
                });
                m.recorded_commands = recorder.data.commands.len() as u64;
                m.record_hash = recorder.data.commands.iter().fold(run::HASH_SEED, |h, &c| run::fold_command(h, c));
                m.recorder = Some(recorder);
                m.record_valid = true;
                m.completed_record = None;
                m.invalidate_jump_observation();
            }
            c.settings = settings;
            c.style_id = style;
            Ok(())
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_practice_free(ctx: *mut BhContext, handle: u32) -> c_int {
    unsafe {
        call(ctx, |c| {
            let slot = c
                .map()?
                .checkpoints
                .get_mut(handle.wrapping_sub(1) as usize)
                .ok_or("invalid practice checkpoint")?;
            *slot = None;
            Ok(())
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_trace_camera(
    ctx: *mut BhContext,
    start: *const f32,
    end: *const f32,
    radius: f32,
    out: *mut f32,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            let start = input(start.cast::<[f32; 3]>())?;
            let end = input(end.cast::<[f32; 3]>())?;
            finite(&start)?;
            finite(&end)?;
            finite(&[radius])?;
            output(out, c.map()?.game.trace_camera(start, end, radius))
        })
    }
}
