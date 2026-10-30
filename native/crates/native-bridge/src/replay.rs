//! Bounded native decoder/playback of the existing BHR format; independent contexts and immutable
//! ghost frames share the same Rust Game and native style/timer pipeline as live play.
use super::*;
use serde_json::json;
use std::io::Read;
const MAX_BYTES: usize = 128 << 20;
const MAX_COMMANDS: usize = 2_000_000;
#[derive(Clone)]
pub struct Spawn {
    position: [f32; 3],
    yaw: f32,
    targetname: String,
    classname: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CosmeticEvent {
    pub tick: u32,
    pub kind: u8,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BhReplayEvents {
    pub cosmetic: u32,
    pub inspect_signal: u32,
    pub inspect_held: u32,
}

pub struct Decoded {
    pub settings: BhSettings,
    pub style: String,
    pub options: BhRunOptions,
    pub zones: Vec<BhZone>,
    pub spawn: Option<Spawn>,
    pub commands: Vec<BhCmd>,
    pub checkpoints: Vec<(u32, [f32; 3], [f32; 3])>,
    pub segments: Vec<segments::Load>,
    pub map_sha: String,
    pub info: CString,
    pub cosmetic: Vec<CosmeticEvent>,
    pub inspect: Vec<CosmeticEvent>,
}
pub struct Playback {
    pub data: Decoded,
    pub index: usize,
    pub error: Option<String>,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BhGhostFrame {
    pub position: [f32; 3],
    pub velocity: [f32; 3],
    pub yaw: f32,
    pub pitch: f32,
    pub view_offset_z: f32,
    pub tick: u32,
    pub flags: u32,
    pub weapon: u32,
}
pub struct Ghost {
    pub info: CString,
    pub frames: Vec<BhGhostFrame>,
    pub cosmetic: Vec<CosmeticEvent>,
    pub inspect: Vec<CosmeticEvent>,
    pub commands: Vec<BhCmd>,
}
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.at.checked_add(n).ok_or("replay size overflow")?;
        let b = self.bytes.get(self.at..end).ok_or("truncated replay")?;
        self.at = end;
        Ok(b)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_bits(self.u32()?))
    }
    fn f64(&mut self) -> Result<f64, String> {
        Ok(f64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn str8(&mut self) -> Result<String, String> {
        let n = self.u8()? as usize;
        Ok(String::from_utf8_lossy(self.take(n)?).into_owned())
    }
    fn varint(&mut self) -> Result<u32, String> {
        let mut v = 0u32;
        for shift in (0..=28).step_by(7) {
            let b = self.u8()?;
            if shift == 28 && b & 0xf0 != 0 {
                return Err("bad replay varint".into());
            }
            v |= u32::from(b & 127) << shift;
            if b & 128 == 0 {
                return Ok(v);
            }
        }
        Err("bad replay varint".into())
    }
    fn signed(&mut self) -> Result<i32, String> {
        let v = self.varint()?;
        Ok(((v >> 1) as i32) ^ -((v & 1) as i32))
    }
    fn vec3(&mut self) -> Result<[f32; 3], String> {
        Ok([self.f32()?, self.f32()?, self.f32()?])
    }
}
impl Reader<'_> {
    fn cosmetics(&mut self, magic: u32) -> Vec<CosmeticEvent> {
        let at = self.at;
        let result = (|| {
            if self.u32()? != magic {
                return Err("absent trailer".to_string());
            }
            let n = self.varint()? as usize;
            if n > 20_000 || n.saturating_mul(2) > self.bytes.len().saturating_sub(self.at) {
                return Err("bad cosmetic count".to_string());
            }
            let mut out = Vec::with_capacity(n);
            let mut tick = 0u32;
            for _ in 0..n {
                tick = tick
                    .checked_add(self.varint()?)
                    .ok_or("cosmetic tick overflow")?;
                out.push(CosmeticEvent {
                    tick,
                    kind: self.u8()?,
                });
            }
            Ok(out)
        })();
        match result {
            Ok(out) => out,
            Err(_) => {
                self.at = at;
                Vec::new()
            }
        }
    }
    fn loadout(&mut self) -> Option<String> {
        let at = self.at;
        let result = (|| {
            if self.u32()? != 0x4f4c4842 {
                return Err("absent loadout".to_string());
            }
            self.str8()
        })();
        match result {
            Ok(out) => Some(out),
            Err(_) => {
                self.at = at;
                None
            }
        }
    }
}
impl Decoded {
    pub fn load(path: &Path) -> Result<Self, String> {
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|e| format!("{}: {e}", path.display()))?
            .take((32 << 20) + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 32 << 20 {
            return Err("compressed replay exceeds 32 MiB".into());
        }
        let raw = if bytes.starts_with(&[0x1f, 0x8b]) {
            let mut raw = Vec::new();
            flate2::read::GzDecoder::new(bytes.as_slice())
                .take(MAX_BYTES as u64 + 1)
                .read_to_end(&mut raw)
                .map_err(|e| format!("replay gzip: {e}"))?;
            raw
        } else {
            bytes
        };
        if raw.len() > MAX_BYTES {
            return Err("decoded replay exceeds 128 MiB".into());
        }
        Self::parse(&raw)
    }
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let mut r = Reader { bytes, at: 0 };
        if r.take(4)? != b"BHRP" {
            return Err("bad replay magic".into());
        }
        let version = r.u16()?;
        if !(1..=10).contains(&version) {
            return Err("unsupported replay version".into());
        }
        let flags = r.u16()?;
        let fractional = version == 10;
        let counted = version == 8 || (version >= 9 && flags & 4 != 0);
        if fractional && !counted {
            return Err("fractional counts require counted yaw".into());
        }
        let map = r.str8()?;
        let map_sha = r
            .take(32)?
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let mut settings = BhSettings {
            tick_interval: r.f32()?,
            air_accelerate: r.f32()?,
            accelerate: r.f32()?,
            friction: r.f32()?,
            stop_speed: r.f32()?,
            gravity: r.f32()?,
            max_speed: r.f32()?,
            autohop: u32::from(flags & 1 != 0),
            stamina: u32::from(version >= 9 && flags & 2 != 0),
            physics: 1,
        };
        let cap = r.f32()?;
        finite(&[cap])?;
        let start = r.u32()?;
        let end = r.u32()?;
        let n = r.u32()? as usize;
        if n > MAX_COMMANDS {
            return Err("replay command limit exceeded".into());
        }
        let mut track = 0u32;
        let mut spawn = None;
        let mut style = if settings.autohop != 0 {
            "autohop"
        } else {
            "legit"
        }
        .to_string();
        let mut rules = 1;
        let mut zones = Vec::new();
        let zone_count = if version == 1 {
            r.u8()? as usize
        } else {
            track = u32::from(r.u8()?);
            if version >= 3 && r.u8()? == 1 {
                let position = r.vec3()?;
                let yaw = r.f32()?;
                finite(&position)?;
                finite(&[yaw])?;
                let targetname = if version >= 5 {
                    r.str8()?
                } else {
                    String::new()
                };
                let classname = if version >= 5 {
                    r.str8()?
                } else {
                    String::new()
                };
                spawn = Some(Spawn {
                    position,
                    yaw,
                    targetname,
                    classname,
                });
            }
            if version >= 4 {
                style = r.str8()?;
            }
            if version >= 6 {
                settings.physics = u32::from(r.u8()?);
            }
            if version >= 7 {
                rules = u32::from(r.u8()?);
            }
            r.varint()? as usize
        };
        if zone_count > 16384 {
            return Err("replay zone limit exceeded".into());
        }
        for _ in 0..zone_count {
            let kind = u32::from(r.u8()?);
            let kind = if version == 1 {
                u32::from(kind != 0)
            } else {
                kind
            };
            if kind > 3 {
                return Err("bad replay zone kind".into());
            }
            let track = if version == 1 { 0 } else { u32::from(r.u8()?) };
            let index = if version == 1 { 0 } else { u32::from(r.u8()?) };
            let mins = r.vec3()?;
            let maxs = r.vec3()?;
            finite(&mins)?;
            finite(&maxs)?;
            if (0..3).any(|i| mins[i] > maxs[i]) {
                return Err("inverted replay zone".into());
            }
            zones.push(BhZone {
                kind,
                track,
                index,
                mins,
                maxs,
            });
        }
        let client = r.str8()?;
        let player = r.str8()?;
        let recorded = r.f64()?;
        let interval = r.varint()?;
        let cp_count = r.varint()? as usize;
        if cp_count > n + 1 {
            return Err("replay checkpoint limit exceeded".into());
        }
        settings.checked()?;
        if !styles::IDS.contains(&style.as_str()) || ![1, 2].contains(&rules) {
            return Err("unsupported replay style/timer rules".into());
        }
        // Every command needs at least one byte per varint column (v10 has four and
        // an absolute f64 count). Reject impossible lengths before allocating commands.
        if n * if fractional { 12 } else { 5 } > bytes.len().saturating_sub(r.at) {
            return Err("truncated replay commands".into());
        }
        let mut commands = vec![BhCmd::default(); n];
        for side in [false, true] {
            let mut prev = 0i64;
            for c in &mut commands {
                prev += i64::from(r.signed()?);
                let v = prev as i16 as f32;
                if side {
                    c.side = v
                } else {
                    c.forward = v
                }
            }
        }
        let mut prev = 0u32;
        for c in &mut commands {
            prev ^= r.varint()?;
            c.buttons = prev
                & if settings.physics >= 7 {
                    u32::MAX
                } else {
                    0xffff
                };
        }
        for pitch in if counted {
            &[true][..]
        } else {
            &[false, true][..]
        } {
            let mut prev = 0i32;
            for c in &mut commands {
                prev = prev.wrapping_add(r.signed()?);
                let f = f32::from_bits(prev as u32);
                if *pitch {
                    c.pitch = f
                } else {
                    c.yaw = f
                }
            }
        }
        if counted {
            let mut raw = Vec::with_capacity(n);
            for _ in 0..n {
                // v8/v9 store integer deltas, reset at each rebase. v10 instead
                // stores exact absolute counts, including across manual turn rebases.
                let count = if fractional {
                    let count = r.f64()?;
                    if !count.is_finite() || count.abs() > 0x3fffffff as f64 {
                        return Err("bad fractional mouse count".into());
                    }
                    count
                } else {
                    f64::from(r.signed()?)
                };
                raw.push(count);
            }
            let n_rebase = r.varint()? as usize;
            if n_rebase > n.saturating_mul(2) + 1 {
                return Err("replay rebase limit exceeded".into());
            }
            let mut rebases = Vec::new();
            let mut tick = 0u32;
            for _ in 0..n_rebase {
                tick = tick
                    .checked_add(r.varint()?)
                    .ok_or("rebase tick overflow")?;
                let kind = r.u8()?;
                let base = r.f64()?;
                let k = r.f64()?;
                if tick as usize >= n || !base.is_finite() || !k.is_finite() {
                    return Err("bad replay rebase".into());
                }
                rebases.push((tick, kind, base, k));
            }
            if n > 0 && rebases.first().is_none_or(|b| b.0 != 0) {
                return Err("counted replay has no initial base".into());
            }
            let (mut rb, mut base, mut k, mut count) = (0, 0.0, 0.0, 0i32);
            for (i, c) in commands.iter_mut().enumerate() {
                let mut rebase = false;
                while rb < rebases.len() && rebases[rb].0 == i as u32 {
                    base = rebases[rb].2;
                    k = rebases[rb].3;
                    rb += 1;
                    rebase = true;
                }
                let yaw_count = if fractional {
                    raw[i]
                } else {
                    count = if rebase {
                        raw[i] as i32
                    } else {
                        count.wrapping_add(raw[i] as i32)
                    };
                    f64::from(count)
                };
                // Match JS norm360 and round only the final yaw to f32. Rebase kinds
                // describe provenance; their base already contains any manual turn.
                c.yaw = (((base - yaw_count * k) % 360.0 + 360.0) % 360.0) as f32;
            }
            for _ in 0..n * 3 {
                r.varint()?;
            }
        }
        for c in &commands {
            finite(&[c.forward, c.side, c.yaw, c.pitch])?;
        }
        let mut checkpoints = Vec::new();
        let mut tick = 0u32;
        for _ in 0..cp_count {
            tick = tick
                .checked_add(r.varint()?)
                .ok_or("checkpoint tick overflow")?;
            if tick as usize > n {
                return Err("checkpoint outside replay".into());
            }
            let p = r.vec3()?;
            let v = r.vec3()?;
            finite(&p)?;
            finite(&v)?;
            checkpoints.push((tick, p, v));
        }
        let cosmetic = r.cosmetics(0x58434842);
        let packed_loadout = r.loadout();
        let inspect = r.cosmetics(0x49434842);
        let mut turn_speed = None;
        if r.bytes.get(r.at..r.at + 4) == Some(&crate::v29::TURN_SPEED_MAGIC.to_le_bytes()) {
            r.u32()?;
            let options = BhRecordOptionsV29 {
                yaw_speed: r.f32()?,
                angle_speed_key: r.f32()?,
                ..BhRecordOptionsV29::default()
            }
            .checked()?;
            turn_speed = Some(json!({
                "yawSpeed": options.yaw_speed,
                "angleSpeedKey": options.angle_speed_key
            }));
        }
        let mut segments = Vec::new();
        if r.bytes.get(r.at..r.at + 4) == Some(&segments::MAGIC.to_le_bytes()) {
            let parse = (|| -> Result<(), String> {
                r.u32()?;
                let count = r.varint()? as usize;
                if count == 0 || count > segments::MAX_LOADS { return Err("bad count".into()); }
                let mut tick = 0u32;
                for _ in 0..count {
                    tick = tick.checked_add(r.varint()?).ok_or("tick overflow")?;
                    let position = r.vec3()?;
                    let velocity = r.vec3()?;
                    finite(&position)?;
                    finite(&velocity)?;
                    if tick as usize > n { return Err("load after replay".into()); }
                    segments.push(segments::Load { tick, position, velocity });
                }
                Ok(())
            })();
            parse.map_err(|e| format!("bad segment loads: {e}"))?;
        }
        if !segments.is_empty() && style != "segmented" {
            return Err("only Segmented runs load checkpoints".into());
        }
        if style == "segmented" && (version < 7 || settings.physics < 19 || rules < 2) {
            return Err("Segmented needs replay v7, physics v19 and timer rules 2".into());
        }
        let spawn_json=spawn.as_ref().map(|s|json!({"position":s.position,"yaw":s.yaw,"targetname":s.targetname,"classname":s.classname}));
        let info=CString::new(json!({"version":version,"map":map,"mapSha256":map_sha,"settings":recording::settings_json(settings),"prespeedCap":if cap>0.0{Some(cap)}else{None},"startTick":start,"endTick":end,"totalTicks":n,"track":track,"spawn":spawn_json,"style":style,"timerRules":rules,"zones":zones.iter().map(|z|z.json()).collect::<Vec<_>>(),"clientBuild":client,"player":player,"recordedAt":recorded,"checkpointInterval":interval,"checkpoints":cp_count,"counted":counted,"packedLoadout":packed_loadout,"cosmeticEvents":cosmetic.len(),"inspectEvents":inspect.len()}).to_string()).map_err(|e|e.to_string())?;
        let mut metadata: serde_json::Value =
            serde_json::from_slice(info.as_bytes()).map_err(|e| e.to_string())?;
        metadata["segmentLoads"] = segments.len().into();
        metadata["segmentTicks"] = json!(segments.iter().map(|load| load.tick).collect::<Vec<_>>());
        if let Some(rates) = turn_speed {
            metadata["turnSpeed"] = rates;
        }
        if flags & crate::v29::FLAG_TIMED_INPUT != 0 {
            metadata["timedInput"] = true.into();
        }
        if flags & crate::v29::FLAG_NULL_BINDS != 0 {
            metadata["nullBinds"] = true.into();
        }
        let info = CString::new(metadata.to_string()).map_err(|e| e.to_string())?;
        let options = BhRunOptions {
            prespeed_cap: cap.max(0.0),
            cap_enabled: u32::from(cap > 0.0),
            rules,
            block_prehops: u32::from(style == "scroll"),
            strafe_keys: styles::strafe_keys(&style),
        };
        Ok(Self {
            settings,
            style,
            options,
            zones,
            spawn,
            commands,
            checkpoints,
            map_sha,
            segments,
            info,
            cosmetic,
            inspect,
        })
    }
}
impl Map {
    fn prepare_replay(&mut self, d: &Decoded) -> Result<(), String> {
        if d.map_sha != self.map_sha256 {
            return Err("replay BSP digest mismatch".into());
        }
        self.invalidate_jump_observation();
        self.game.set_settings(d.settings.checked()?);
        self.game.reset();
        self.filter = styles::Filter::new(&d.style, d.settings.physics);
        self.timer = Some(run::Timer::new(
            d.zones.clone(),
            d.options,
            d.settings.tick_interval,
        ));
        self.transforms_dirty = true;
        if let Some(s) = &d.spawn {
            finite(&s.position)?;
            finite(&[s.yaw])?;
            self.game.set_position(s.position, s.yaw);
            if !s.targetname.is_empty() || !s.classname.is_empty() {
                self.game.set_restart_names(&s.targetname, &s.classname);
            }
        }
        self.last_command = BhCmd {
            yaw: self.game.teleport_angles[1],
            pitch: self.game.teleport_angles[0],
            ..BhCmd::default()
        };
        self.check_replay(d)
    }
    fn check_replay(&self, d: &Decoded) -> Result<(), String> {
        for load in d.segments.iter().filter(|load| load.tick == self.game.tick) {
            if load.position.iter().zip(self.game.state.position)
                .chain(load.velocity.iter().zip(self.game.state.velocity))
                .any(|(a, b)| a.to_bits() != b.to_bits()) {
                return Err(format!("segment load mismatch at tick {}", load.tick));
            }
        }
        for (t, p, v) in d.checkpoints.iter().filter(|c| c.0 == self.game.tick) {
            if p.iter()
                .zip(self.game.state.position)
                .chain(v.iter().zip(self.game.state.velocity))
                .any(|(a, b)| a.to_bits() != b.to_bits())
            {
                return Err(format!("replay checkpoint mismatch at tick {t}"));
            }
        }
        Ok(())
    }
    fn ghost_frame(&self, cmd: BhCmd) -> BhGhostFrame {
        BhGhostFrame {
            position: self.game.state.position,
            velocity: self.game.state.velocity,
            yaw: cmd.yaw,
            pitch: cmd.pitch,
            view_offset_z: self.game.state.view_offset[2],
            tick: self.game.tick,
            flags: u32::from(self.game.state.crouch.uses_crouched_hull())
                | u32::from(self.game.state.ground.is_some()) << 1
                | u32::from(self.game.state.mode as u8 == 6) << 2,
            weapon: self.game.weapon_report()[1] as u32,
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_replay_load(ctx: *mut BhContext, path: *const c_char) -> c_int {
    unsafe {
        call(ctx, |c| {
            let d = Decoded::load(Path::new(string(path)?))?;
            let settings = d.settings;
            let style = d.style.clone();
            let m = c.map()?;
            if d.map_sha != m.map_sha256 {
                return Err("replay BSP digest mismatch".into());
            }
            m.finish_record(false, "replay_loaded")?;
            m.prepare_replay(&d)?;
            m.playback = Some(Playback {
                data: d,
                index: 0,
                error: None,
            });
            c.settings = settings;
            c.style_id = style;
            Ok(())
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_replay_info(ctx: *mut BhContext, count: *mut usize) -> *const c_char {
    let mut p = ptr::null();
    let _ = unsafe { output(count, 0) };
    unsafe {
        call(ctx, |c| {
            let s = &c
                .map()?
                .playback
                .as_ref()
                .ok_or("no replay loaded")?
                .data
                .info;
            if !count.is_null() {
                output(count, s.as_bytes().len())?;
            }
            p = s.as_ptr();
            Ok(())
        })
    };
    p
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_replay_step(ctx: *mut BhContext, out: *mut BhSnapshot) -> c_int {
    unsafe {
        call(ctx, |c| {
            if out.is_null() {
                return Err("null output".into());
            }
            let m = c.map()?;
            let mut p = m.playback.take().ok_or("no replay loaded")?;
            let result = (|| {
                if let Some(error) = &p.error {
                    return Err(error.clone());
                }
                let cmd = *p.data.commands.get(p.index).ok_or("replay finished")?;
                m.advance_canonical(cmd, None, false)?;
                p.index += 1;
                if let Err(error) = m.check_replay(&p.data) {
                    p.error = Some(error.clone());
                    return Err(error);
                }
                output(out, BhSnapshot::from(&m.game))
            })();
            m.playback = Some(p);
            result
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_replay_seek(
    ctx: *mut BhContext,
    tick: u32,
    out: *mut BhSnapshot,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            if out.is_null() {
                return Err("null output".into());
            }
            let m = c.map()?;
            let mut p = m.playback.take().ok_or("no replay loaded")?;
            let result = (|| {
                if tick as usize > p.data.commands.len() {
                    return Err("seek outside replay".into());
                }
                m.prepare_replay(&p.data)?;
                p.index = 0;
                p.error = None;
                for i in 0..tick as usize {
                    m.advance_canonical(p.data.commands[i], None, false)?;
                    p.index = i + 1;
                    if let Err(error) = m.check_replay(&p.data) {
                        p.error = Some(error.clone());
                        return Err(error);
                    }
                }
                output(out, BhSnapshot::from(&m.game))
            })();
            m.playback = Some(p);
            result
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_ghost_load(ctx: *mut BhContext, path: *const c_char) -> u32 {
    unsafe { bh_ghost_load_cancellable(ctx, path, None, ptr::null_mut()) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_ghost_load_cancellable(
    ctx: *mut BhContext,
    path: *const c_char,
    cancel: BhCancel,
    data: *mut c_void,
) -> u32 {
    let mut handle = 0;
    unsafe {
        call(ctx, |c| {
            check_cancel(cancel, data)?;
            let d = Decoded::load(Path::new(string(path)?))?;
            if d.commands.len() > segments::MAX_LOG_TICKS {
                return Err("ghost exceeds frame limit".into());
            }
            let m = c.map()?;
            if m.recorder.is_some() {
                return Err("load ghosts before beginning live recording".into());
            }
            if m.ghosts.iter().filter(|g| g.is_some()).count() >= 4 {
                return Err("at most four ghosts per map".into());
            }
            check_cancel(cancel, data)?;
            let bytes = std::fs::read(&m.map_path).map_err(|e| e.to_string())?;
            if recording::sha(&bytes) != m.map_sha256 {
                return Err("BSP changed since map load".into());
            }
            check_cancel(cancel, data)?;
            let bsp = bunnyhop_core::parse_bsp(&bytes)?;
            drop(bytes);
            let source = if m.root.is_some() {
                Some(vfs::Source::loose("content", m.physics_files.clone()))
            } else {
                bunnyhop_core::content::cached_physics_content(&m.map_path)
            };
            check_cancel(cancel, data)?;
            let ghost_game = Game::load_with_content(&bsp, source)?;
            drop(bsp);
            check_cancel(cancel, data)?;
            let saved = std::mem::replace(&mut m.game, ghost_game);
            let timer = m.timer.clone();
            let filter = m.filter.clone();
            let cmd = m.last_command;
            let jump_observation = m.jump_observation;
            let result = (|| {
                check_cancel(cancel, data)?;
                m.prepare_replay(&d)?;
                let first = d.commands.first().copied().unwrap_or(BhCmd {
                    yaw: m.game.teleport_angles[1],
                    pitch: m.game.teleport_angles[0],
                    ..BhCmd::default()
                });
                let mut frames = Vec::with_capacity(d.commands.len() + 1);
                frames.push(m.ghost_frame(first));
                for &cmd in &d.commands {
                    check_cancel(cancel, data)?;
                    m.advance_canonical(cmd, None, false)?;
                    m.check_replay(&d)?;
                    frames.push(m.ghost_frame(cmd));
                }
                let mut info: serde_json::Value = serde_json::from_slice(d.info.as_bytes())
                    .map_err(|error| error.to_string())?;
                if let Some(timer) = &m.timer {
                    if timer.state.status == 2 {
                        info["timeMs"] = json!(timer.time_ms());
                        info["timingPolicy"] = json!(run_timing::POLICY);
                    }
                }
                Ok::<_, String>(Ghost {
                    info: CString::new(info.to_string()).map_err(|error| error.to_string())?,
                    frames,
                    cosmetic: d.cosmetic,
                    inspect: d.inspect,
                    commands: d.commands,
                })
            })();
            m.game = saved;
            m.timer = timer;
            m.filter = filter;
            m.last_command = cmd;
            m.jump_observation = jump_observation;
            m.transforms_dirty = true;
            let ghost = result?;
            let index = m
                .ghosts
                .iter()
                .position(Option::is_none)
                .unwrap_or(m.ghosts.len());
            if index == m.ghosts.len() {
                m.ghosts.push(Some(ghost));
            } else {
                m.ghosts[index] = Some(ghost);
            }
            handle = index as u32 + 1;
            Ok(())
        })
    };
    handle
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_ghost_info(
    ctx: *mut BhContext,
    handle: u32,
    count: *mut usize,
) -> *const c_char {
    let mut p = ptr::null();
    let _ = unsafe { output(count, 0) };
    unsafe {
        call(ctx, |c| {
            let s = &c
                .map()?
                .ghosts
                .get(handle.wrapping_sub(1) as usize)
                .and_then(Option::as_ref)
                .ok_or("invalid ghost handle")?
                .info;
            if !count.is_null() {
                output(count, s.as_bytes().len())?;
            }
            p = s.as_ptr();
            Ok(())
        })
    };
    p
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_ghost_frame(
    ctx: *mut BhContext,
    handle: u32,
    tick: u32,
    out: *mut BhGhostFrame,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            let f = *c
                .map()?
                .ghosts
                .get(handle.wrapping_sub(1) as usize)
                .and_then(Option::as_ref)
                .ok_or("invalid ghost handle")?
                .frames
                .get(tick as usize)
                .ok_or("ghost tick outside frames")?;
            output(out, f)
        })
    }
}
// Commands use the same tick indexing as ghost frames (frame zero has no held input).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_ghost_command(
    ctx: *mut BhContext,
    handle: u32,
    tick: u32,
    out: *mut BhCmd,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            let ghost = c.map()?.ghosts
                .get(handle.wrapping_sub(1) as usize)
                .and_then(Option::as_ref)
                .ok_or("invalid ghost handle")?;
            let cmd = if tick == 0 {
                BhCmd::default()
            } else {
                *ghost.commands.get(tick as usize - 1).ok_or("ghost tick outside commands")?
            };
            output(out, cmd)
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_ghost_free(ctx: *mut BhContext, handle: u32) -> c_int {
    unsafe {
        call(ctx, |c| {
            let g = c
                .map()?
                .ghosts
                .get_mut(handle.wrapping_sub(1) as usize)
                .ok_or("invalid ghost handle")?;
            *g = None;
            Ok(())
        })
    }
}

fn events(
    cosmetic: &[CosmeticEvent],
    inspect: &[CosmeticEvent],
    from: u32,
    to: u32,
) -> BhReplayEvents {
    let cosmetic = if to > from {
        cosmetic
            .iter()
            .take_while(|e| e.tick <= to)
            .filter(|e| e.tick > from)
            .last()
            .map_or(0, |e| u32::from(e.kind))
    } else {
        0
    };
    let (mut sig, mut held) = (0, None);
    for e in inspect.iter().rev().filter(|e| e.tick <= to) {
        if held.is_none() && [3, 4].contains(&e.kind) {
            held = Some(e.kind == 3);
        }
        if sig == 0 && e.tick > from && [1, 2].contains(&e.kind) {
            sig = u32::from(e.kind);
        }
        if held.is_some() && (sig != 0 || e.tick <= from) {
            break;
        }
    }
    BhReplayEvents {
        cosmetic,
        inspect_signal: if to > from { sig } else { 0 },
        inspect_held: u32::from(held.unwrap_or(false)),
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_replay_events(
    ctx: *mut BhContext,
    from: u32,
    to: u32,
    out: *mut BhReplayEvents,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            let d = &c.map()?.playback.as_ref().ok_or("no replay loaded")?.data;
            output(out, events(&d.cosmetic, &d.inspect, from, to))
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_ghost_events(
    ctx: *mut BhContext,
    handle: u32,
    from: u32,
    to: u32,
    out: *mut BhReplayEvents,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            let g = c
                .map()?
                .ghosts
                .get(handle.wrapping_sub(1) as usize)
                .and_then(Option::as_ref)
                .ok_or("invalid ghost handle")?;
            output(out, events(&g.cosmetic, &g.inspect, from, to))
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_replay_stop(ctx: *mut BhContext) -> c_int {
    unsafe {
        call(ctx, |c| {
            c.map()?.playback = None;
            Ok(())
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_replay_header(
    ctx: *mut BhContext,
    path: *const c_char,
    count: *mut usize,
) -> *const c_char {
    let mut result = ptr::null();
    let _ = unsafe { output(count, 0) };
    unsafe {
        call(ctx, |c| {
            let d = Decoded::load(Path::new(string(path)?))?;
            c.replay_header = d.info;
            if !count.is_null() {
                output(count, c.replay_header.as_bytes().len())?;
            }
            result = c.replay_header.as_ptr();
            Ok(())
        })
    };
    result
}
