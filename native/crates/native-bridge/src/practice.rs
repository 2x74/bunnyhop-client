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
                || playback.data.options.rules < 2
                || recording::settings_json(playback.data.settings)
                    != recording::settings_json(expected_settings)
            {
                return Err("replay map/style/settings/rules cannot continue as current practice".into());
            }
            invalidate_recording(m, "practice_from_replay")?;
            m.playback = None;
            m.end_flight();
            m.invalidate_jump_observation();
            Ok(())
        })
    }
}

/// Checkpoints kept per map, as on the web (bhoptimer's 1000). The host drops its oldest to save past this.
pub const MAX_CHECKPOINTS: usize = 1000;
/// What a map's checkpoints may hold together: snapshots plus Segmented paths. Past it the host drops its oldest,
/// and the newest checkpoint always stays. The web allows 128 MiB of wasm32 snapshots; the same snapshots measure
/// 1.41x larger here (64-bit entities), from 135 KB on bhop_eazy to 2.5 MB on bhop_treason. 180 MiB keeps as many
/// checkpoints as the web on every map (treason keeps 76). Measured process growth stays within 3% of the estimate.
pub const CHECKPOINT_BUDGET_BYTES: usize = 180 << 20;

/// Whether a checkpoint of `bytes` may join ones holding `retained`. The first always may, however large.
pub(crate) fn fits_budget(retained: usize, bytes: usize, budget: usize) -> bool {
    retained == 0 || retained.saturating_add(bytes) <= budget
}

pub struct Checkpoint {
    game: game::GameState,
    /// The snapshot and Segmented path's size, counted once at save.
    pub(crate) bytes: usize,
    pub(crate) segment: Option<segments::Mark>,
    settings: BhSettings,
    filter: styles::Filter,
    timer: Option<run::Timer>,
    command: BhCmd,
    yaw: f32,
    pitch: f32,
}
/// sv_maxspeed the noclip flight multiplies (CS:S `FullNoClipMove`).
const NOCLIP_MAX_SPEED: f64 = 320.0;
/// Duck slows the flight to a quarter, and sets the floor the friction bleeds toward.
const NOCLIP_DUCK_FACTOR: f64 = 0.25;
/// sv_noclipspeed everywhere but Infinite: 320 * 5 = 1600 u/s.
pub const NOCLIP_SPEED: f64 = 5.0;
/// Infinite flies at 3500 u/s. Not the plugin's 11.400651, which assumed a server at sv_maxspeed 307.
pub const INFINITE_NOCLIP_SPEED: f64 = 3500.0 / NOCLIP_MAX_SPEED;

/// sv_noclipspeed for a style id.
pub fn noclip_speed(style: &str) -> f64 {
    if style == "infinite" {
        INFINITE_NOCLIP_SPEED
    } else {
        NOCLIP_SPEED
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
    /// `noclip_speed` is sv_noclipspeed (`NOCLIP_SPEED` 5 everywhere but Infinite, which flies at 3500 u/s).
    fn advance(&mut self, c: BhCmd, dt: f64, noclip_speed: f64) {
        let yr = f64::from(c.yaw) * std::f64::consts::PI / 180.0;
        let pr = f64::from(c.pitch) * std::f64::consts::PI / 180.0;
        let (sy, cy) = (yr.sin(), yr.cos());
        let (sp, cp) = (pr.sin(), pr.cos());
        let slow = c.buttons & 4 != 0;
        let top_speed = NOCLIP_MAX_SPEED * noclip_speed;
        let factor = if slow {
            noclip_speed * NOCLIP_DUCK_FACTOR
        } else {
            noclip_speed
        };
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
        let wish_speed = len.min(if slow {
            top_speed * NOCLIP_DUCK_FACTOR
        } else {
            top_speed
        });
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
        let scale = (speed - speed.max(top_speed * NOCLIP_DUCK_FACTOR) * 4.0 * dt).max(0.0) / speed;
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
    style: *const c_char,
) -> c_int {
    catch_unwind(AssertUnwindSafe(|| unsafe {
        let mut s = input(state)?;
        let cmd = input(cmd)?;
        let speed = noclip_speed(string(style)?);
        s.checked()?;
        finite(&[cmd.forward, cmd.side, cmd.yaw, cmd.pitch])?;
        if !dt.is_finite() || dt <= 0.0 || dt > 1.0 {
            return Err("noclip dt outside (0,1]".to_string());
        }
        s.advance(cmd, dt, speed);
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
                    // Infinite keeps an idle or armed timer through noclip: flying out of the start zone starts it.
                    if t.state.status == 1 || t.options.start_reentry_cap <= 0.0 {
                        t.reset(t.interval as f32);
                    }
                }
            }
            Ok(())
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_practice_noclip_tick(
    ctx: *mut BhContext,
    state: *mut BhNoclipState,
    out: *mut BhSnapshot,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            let mut s = input(state)?;
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
                // A noclip start above the cap is clamped in the flight state, so the next tick carries the capped speed.
                if let Some(v) = t.noclip_tick(m.game.tick, position, velocity) {
                    s.velocity = v.map(f64::from);
                    output(state, s)?;
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
            if m.checkpoints.iter().flatten().count() >= MAX_CHECKPOINTS {
                return Err(format!(
                    "{MAX_CHECKPOINTS} practice checkpoints already retained"
                ));
            }
            let game = m.game.save_state();
            let segment = m.segment_mark()?;
            let bytes = game.approx_bytes() + segment.as_ref().map_or(0, segments::Mark::bytes);
            let retained: usize = m.checkpoints.iter().flatten().map(|cp| cp.bytes).sum();
            if !fits_budget(retained, bytes, CHECKPOINT_BUDGET_BYTES) {
                return Err(format!(
                    "practice checkpoints exceed {} MiB",
                    CHECKPOINT_BUDGET_BYTES >> 20
                ));
            }
            let checkpoint = Checkpoint {
                game,
                bytes,
                segment,
                settings,
                filter: m.filter.clone(),
                timer: m.timer.clone(),
                command: m.last_command,
                yaw,
                pitch,
            };
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
            m.end_flight();
            let s = m.checkpoints[handle as usize - 1].as_ref().unwrap();
            m.game.restore_state(&s.game);
            m.filter = s.filter.clone();
            // As after a restart (session.ts practiceRestored): the next command moves with the live view.
            m.filter.clear_lead_view();
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
