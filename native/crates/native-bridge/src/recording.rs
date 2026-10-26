//! Local evidence capture. This format is never itself a score authorization or a trusted replay.
use super::{BhCmd, BhSnapshot, Map, run};
use flate2::{Compression, write::GzEncoder};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::fs::OpenOptions;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_COMMANDS: u64 = 180_000;
pub struct Recorder {
    writer: Option<BufWriter<std::fs::File>>,
    pub checkpoint_interval: u32,
    pub data: ReplayData,
}
pub struct Checkpoint {
    pub tick: u32,
    pub position: [f32; 3],
    pub velocity: [f32; 3],
}
pub struct ReplayData {
    pub header: Value,
    pub commands: Vec<BhCmd>,
    pub looks: Vec<Option<crate::BhLookSampleV2>>,
    pub checkpoints: Vec<Checkpoint>,
    pub start_tick: u32,
    pub end_tick: u32,
    pub track: u32,
    pub cosmetic: Vec<super::replay::CosmeticEvent>,
    pub inspect: Vec<super::replay::CosmeticEvent>,
    pub packed_loadout: Option<String>,
}
impl ReplayData {
    fn checkpoint(&mut self, s: super::BhState) {
        if self.checkpoints.last().is_none_or(|cp| cp.tick != s.tick) {
            self.checkpoints.push(Checkpoint {
                tick: s.tick,
                position: s.position,
                velocity: s.velocity,
            });
        }
    }
    pub fn write_bhr(&self, path: &Path) -> Result<(), String> {
        let bytes = self.encode_raw()?;
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let mut gzip = GzEncoder::new(file, Compression::default());
        gzip.write_all(&bytes).map_err(|e| e.to_string())?;
        gzip.finish().map_err(|e| e.to_string())?;
        Ok(())
    }
    fn encode_raw(&self) -> Result<Vec<u8>, String> {
        let h = &self.header;
        let settings = &h["settings"];
        let flag = |key: &str| settings[key].as_bool().unwrap_or(false);
        let physics = settings["physics"]
            .as_u64()
            .ok_or("missing recording physics")? as u32;
        let rules = h["timerRules"]
            .as_u64()
            .ok_or("missing recording timer rules")? as u32;
        if physics == 0 || physics > 255 || rules == 0 || rules > 255 {
            return Err("replay physics/rules not representable".into());
        }
        let spawn = &h["spawn"];
        let names = spawn["targetname"].as_str().is_some_and(|s| !s.is_empty())
            || spawn["classname"].as_str().is_some_and(|s| !s.is_empty());
        let counted = if rules != 1 {
            crate::look::encode(&self.looks, &self.commands)
        } else {
            None
        };
        let version = if counted.as_ref().is_some_and(|c| c.fractional) {
            10u16
        } else if flag("stamina") || h["style"] == "lowgrav" {
            9u16
        } else if counted.is_some() {
            8
        } else if rules != 1 {
            7
        } else if physics != 1 {
            6
        } else if names {
            5
        } else {
            4
        };
        let mut w = Writer(Vec::new());
        w.0.extend_from_slice(b"BHRP");
        w.u16(version);
        w.u16(
            u16::from(flag("autohop"))
                | (u16::from(flag("stamina")) << 1)
                | (u16::from(version >= 9 && counted.is_some()) << 2),
        );
        w.str8(h["map"].as_str().ok_or("missing map")?)?;
        let sha = h["mapSha256"].as_str().ok_or("missing map digest")?;
        if sha.len() != 64 {
            return Err("invalid map digest".into());
        }
        for i in (0..64).step_by(2) {
            w.0.push(u8::from_str_radix(&sha[i..i + 2], 16).map_err(|e| e.to_string())?);
        }
        for key in [
            "tickInterval",
            "airAccelerate",
            "accelerate",
            "friction",
            "stopSpeed",
            "gravity",
            "maxSpeed",
        ] {
            w.f32(settings[key].as_f64().ok_or("missing setting")? as f32);
        }
        w.f32(h["prespeedCap"].as_f64().unwrap_or(0.0) as f32);
        w.u32(self.start_tick);
        w.u32(self.end_tick);
        w.u32(self.commands.len() as u32);
        w.0.push(self.track as u8);
        if spawn.is_object() {
            w.0.push(1);
            for i in 0..3 {
                w.f32(spawn["position"][i].as_f64().ok_or("missing spawn")? as f32);
            }
            w.f32(spawn["yaw"].as_f64().ok_or("missing spawn yaw")? as f32);
            if version >= 5 {
                w.str8(spawn["targetname"].as_str().unwrap_or(""))?;
                w.str8(spawn["classname"].as_str().unwrap_or(""))?;
            }
        } else {
            w.0.push(0);
        }
        w.str8(h["style"].as_str().ok_or("missing style")?)?;
        if version >= 6 {
            w.0.push(physics as u8);
        }
        if version >= 7 {
            w.0.push(rules as u8);
        }
        let zones = h["zones"].as_array().ok_or("missing zones")?;
        w.varint(zones.len() as u32);
        for z in zones {
            w.0.push(match z["kind"].as_str().ok_or("missing zone kind")? {
                "start" => 0,
                "end" => 1,
                "stage" => 2,
                "checkpoint" => 3,
                _ => return Err("invalid zone kind".into()),
            });
            w.0.push(z["track"].as_u64().unwrap_or(0) as u8);
            w.0.push(z["index"].as_u64().unwrap_or(0) as u8);
            for key in ["mins", "maxs"] {
                for i in 0..3 {
                    w.f32(z[key][i].as_f64().ok_or("invalid zone coordinate")? as f32);
                }
            }
        }
        w.str8(h["clientBuild"].as_str().ok_or("missing client identity")?)?;
        w.str8(h["player"].as_str().ok_or("missing player")?)?;
        w.0.extend_from_slice(
            &h["recordedAt"]
                .as_f64()
                .ok_or("missing recordedAt")?
                .to_le_bytes(),
        );
        w.varint(
            h["checkpointInterval"]
                .as_u64()
                .ok_or("missing checkpoint interval")? as u32,
        );
        w.varint(self.checkpoints.len() as u32);
        for side in [false, true] {
            let mut prev = 0i32;
            for c in &self.commands {
                let value = if side {
                    c.side as i32
                } else {
                    c.forward as i32
                };
                w.svarint(value - prev);
                prev = value;
            }
        }
        let mut prev = 0;
        for c in &self.commands {
            w.varint(c.buttons ^ prev);
            prev = c.buttons;
        }
        for pitch in if counted.is_some() {
            &[true][..]
        } else {
            &[false, true][..]
        } {
            let mut prev = 0i32;
            for c in &self.commands {
                let value = if *pitch {
                    c.pitch.to_bits()
                } else {
                    c.yaw.to_bits()
                } as i32;
                w.svarint(value.wrapping_sub(prev));
                prev = value;
            }
        }
        if let Some(counted) = counted {
            let mut rb = 0;
            let mut prev = 0i32;
            for (i, &value) in counted.count.iter().enumerate() {
                let rebase = rb < counted.rebases.len() && counted.rebases[rb].tick == i as u32;
                while rb < counted.rebases.len() && counted.rebases[rb].tick == i as u32 {
                    rb += 1;
                }
                if counted.fractional {
                    w.0.extend_from_slice(&value.to_le_bytes());
                } else {
                    let value = value as i32;
                    w.svarint(if rebase {
                        value
                    } else {
                        value.wrapping_sub(prev)
                    });
                    prev = value;
                }
            }
            w.varint(counted.rebases.len() as u32);
            let mut prev = 0;
            for b in counted.rebases {
                w.varint(b.tick - prev);
                prev = b.tick;
                w.0.push(b.kind as u8);
                w.0.extend_from_slice(&b.base.to_le_bytes());
                w.0.extend_from_slice(&b.k.to_le_bytes());
            }
            for column in [counted.frames, counted.events, counted.reports] {
                for value in column {
                    w.varint(u32::from(value));
                }
            }
        }
        let mut prev = 0;
        for cp in &self.checkpoints {
            w.varint(cp.tick - prev);
            prev = cp.tick;
            for value in cp.position.into_iter().chain(cp.velocity) {
                w.f32(value);
            }
        }
        for (magic, events) in [(0x58434842, &self.cosmetic)] {
            if !events.is_empty() {
                w.u32(magic);
                w.varint(events.len() as u32);
                let mut prev = 0;
                for e in events {
                    w.varint(e.tick - prev);
                    w.0.push(e.kind);
                    prev = e.tick;
                }
            }
        }
        if let Some(loadout) = &self.packed_loadout {
            w.u32(0x4f4c4842);
            w.str8(loadout)?;
        }
        if !self.inspect.is_empty() {
            w.u32(0x49434842);
            w.varint(self.inspect.len() as u32);
            let mut prev = 0;
            for e in &self.inspect {
                w.varint(e.tick - prev);
                w.0.push(e.kind);
                prev = e.tick;
            }
        }
        Ok(w.0)
    }
}
struct Writer(Vec<u8>);
impl Writer {
    fn u16(&mut self, v: u16) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn f32(&mut self, v: f32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn str8(&mut self, s: &str) -> Result<(), String> {
        if s.len() > 255 {
            return Err("replay string exceeds 255 UTF-8 bytes".into());
        }
        self.0.push(s.len() as u8);
        self.0.extend_from_slice(s.as_bytes());
        Ok(())
    }
    fn varint(&mut self, mut v: u32) {
        while v >= 128 {
            self.0.push((v as u8 & 127) | 128);
            v >>= 7;
        }
        self.0.push(v as u8);
    }
    fn svarint(&mut self, v: i32) {
        self.varint(((v << 1) ^ (v >> 31)) as u32);
    }
}
impl Recorder {
    fn write(&mut self, value: &Value) -> Result<(), String> {
        let Some(writer) = &mut self.writer else {
            return Ok(());
        };
        serde_json::to_writer(&mut *writer, value).map_err(|e| format!("recording: {e}"))?;
        writer
            .write_all(b"\n")
            .map_err(|e| format!("recording: {e}"))
    }
}
pub fn sha(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(64);
    for b in Sha256::digest(bytes) {
        out.push(HEX[usize::from(b >> 4)] as char);
        out.push(HEX[usize::from(b & 15)] as char);
    }
    out
}
pub fn settings_json(s: super::BhSettings) -> Value {
    json!({"tickInterval":s.tick_interval,"airAccelerate":s.air_accelerate,"accelerate":s.accelerate,"friction":s.friction,
        "stopSpeed":s.stop_speed,"gravity":s.gravity,"maxSpeed":s.max_speed,"autohop":s.autohop!=0,"physics":s.physics,"stamina":s.stamina!=0})
}
impl Map {
    pub fn begin_record(
        &mut self,
        path: Option<&Path>,
        style: &str,
        player: &str,
        checkpoint_interval: u32,
        settings: super::BhSettings,
        client_build: &str,
    ) -> Result<(), String> {
        if self.recorder.is_some() {
            return Err("a recording is already active".into());
        }
        if self.playback.is_some() {
            return Err("stop replay playback before recording".into());
        }
        if self.game.tick != 0 {
            return Err("recording must begin at tick 0 after reset/restart configuration".into());
        }
        let timer = self
            .timer
            .as_ref()
            .ok_or("configure native timer zones before recording")?;
        if timer.state.last_tick != 0 {
            return Err("reset the native timer before recording".into());
        }
        if !crate::styles::IDS.contains(&style) {
            return Err("unsupported native recording style".into());
        }
        if (style != "legit" && style != "scroll") != (settings.autohop != 0) {
            return Err("recording style and autohop settings disagree".into());
        }
        if (style == "scroll") != (settings.stamina != 0) {
            return Err("recording style and stamina settings disagree".into());
        }
        if timer.options.strafe_keys != crate::styles::strafe_keys(style)
            || (timer.options.block_prehops != 0) != (style == "scroll")
        {
            return Err("recording style and native timer options disagree".into());
        }
        if style == "scroll" && timer.options.cap_enabled != 0 {
            return Err("scroll uses prehop blocking without a prespeed cap".into());
        }
        if checkpoint_interval == 0 || checkpoint_interval > 10_000 {
            return Err("checkpoint interval must be 1..10000".into());
        }
        if self.map_name.len() > 255 {
            return Err("map name exceeds replay str8 limit".into());
        }
        if timer.options.cap_enabled != 0 && timer.options.prespeed_cap == 0.0 {
            return Err("zero enabled prespeed cap cannot be represented in BHR".into());
        }
        if player.as_bytes().len() > 255 {
            return Err("player name exceeds replay str8 limit".into());
        }
        // Replay metadata uses an empty classname for the default player. Literal "player"
        // would be interpreted as a map-specific restart override by the ranked verifier.
        let classname = if self.game.player_class == "player" {
            ""
        } else {
            self.game.player_class.as_str()
        };
        let spawn=self.game.restart_point().map(|(position,yaw)|json!({"position":position,"yaw":yaw,"targetname":self.game.player_name,"classname":classname}));
        let recorded_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs_f64()
            * 1000.0;
        let header = json!({"type":"header","format":"bunnyhop-native-recording","version":1,"verified":false,
            "map":self.map_name,"mapSha256":self.map_sha256,"settings":settings_json(settings),"style":style,"player":player,
            "recordedAt":recorded_at,"checkpointInterval":checkpoint_interval,"timerRules":timer.options.rules,
            "prespeedCap":if timer.options.cap_enabled!=0 {Some(timer.options.prespeed_cap)} else {None},
            "blockPrehops":timer.options.block_prehops!=0,"strafeKeys":match crate::styles::strafe_keys(style){1=>"ws",2=>"w",_=>"ad"},"spawn":spawn,
            "zones":timer.zones.iter().map(|z|z.json()).collect::<Vec<_>>(),
            "clientBuild":client_build,"maxCommands":MAX_COMMANDS,
            "initialState":run::snapshot_json(BhSnapshot::from(&self.game)),"initialSnapshotSha256":sha(&self.game.snapshot_bytes())});
        let writer = path
            .map(|path| {
                OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)
                    .map(BufWriter::new)
                    .map_err(|e| format!("{}: {e}", path.display()))
            })
            .transpose()?;
        let mut recorder = Recorder {
            writer,
            checkpoint_interval,
            data: ReplayData {
                header: header.clone(),
                commands: Vec::new(),
                looks: Vec::new(),
                checkpoints: Vec::new(),
                start_tick: 0,
                end_tick: 0,
                track: 0,
                cosmetic: Vec::new(),
                inspect: Vec::new(),
                packed_loadout: None,
            },
        };
        recorder.write(&header)?;
        if let Some(writer) = &mut recorder.writer {
            writer.flush().map_err(|e| e.to_string())?;
        }
        self.filter = crate::styles::Filter::new(style, settings.physics);
        self.completed_record = None;
        self.recorded_commands = 0;
        self.record_hash = run::HASH_SEED;
        self.record_valid = true;
        self.record_summary = CString::default();
        self.recorder = Some(recorder);
        Ok(())
    }
    pub fn record_tick(
        &mut self,
        cmd: BhCmd,
        look: Option<crate::BhLookSampleV2>,
    ) -> Result<(), String> {
        if self.recorder.is_none() {
            return Ok(());
        }
        self.recorded_commands += 1;
        self.record_hash = run::fold_command(self.record_hash, cmd);
        let recorder = self.recorder.as_mut().unwrap();
        recorder.data.commands.push(cmd);
        recorder.data.looks.push(look);
        let checkpoint = self.game.tick % recorder.checkpoint_interval == 0;
        if checkpoint {
            recorder.data.checkpoint(super::BhState::from(&self.game));
        }
        if recorder.writer.is_some() {
            let mut row = json!({"type":"tick","command":{"forward":cmd.forward as i16,"side":cmd.side as i16,"yaw":cmd.yaw,"pitch":cmd.pitch,
            "buttons":cmd.buttons,"yawBits":cmd.yaw.to_bits(),"pitchBits":cmd.pitch.to_bits()},
            "state":run::snapshot_json(BhSnapshot::from(&self.game)),"timer":self.timer.as_ref().unwrap().json(),"checkpoint":checkpoint,
            "commandHash":format!("{:08x}",self.record_hash)});
            if let Some(l) = look {
                row["look"] = json!({"base":l.base,"k":l.k,"count":l.count,"epoch":l.epoch,"kind":l.kind,"frames":l.frames,"events":l.events,"reports":l.reports});
            }
            if checkpoint {
                row["snapshotSha256"] = sha(&self.game.snapshot_bytes()).into();
            }
            if let Err(e) = recorder.write(&row) {
                self.record_valid = false;
                let _ = self.finish_record(false, "write_error");
                return Err(e);
            }
        }
        if self.recorded_commands >= MAX_COMMANDS {
            self.finish_record(false, "command_limit")?;
        }
        Ok(())
    }
    pub fn finish_record(&mut self, valid: bool, reason: &str) -> Result<(), String> {
        // External state/configuration changes also fence display-only movement history,
        // even when no recording is open. Ending a valid recording is not a discontinuity.
        if !valid { self.invalidate_jump_observation(); }
        let Some(mut recorder) = self.recorder.take() else {
            return Ok(());
        };
        self.record_valid &= valid;
        let summary = json!({"type":"summary","format":"bunnyhop-native-recording","version":1,"verified":false,"valid":self.record_valid,
            "reason":reason,"totalTicks":self.recorded_commands,"commandHash":format!("{:08x}",self.record_hash),
            "timer":self.timer.as_ref().map(|t|t.json()),"finalState":run::snapshot_json(BhSnapshot::from(&self.game)),
            "finalSnapshotSha256":sha(&self.game.snapshot_bytes())});
        self.record_summary = CString::new(summary.to_string()).map_err(|e| e.to_string())?;
        let result = recorder
            .write(&summary)
            .and_then(|_| match &mut recorder.writer {
                Some(writer) => writer.flush().map_err(|e| format!("recording flush: {e}")),
                None => Ok(()),
            });
        if result.is_err() {
            self.record_valid = false;
        }
        if self.record_valid && self.timer.as_ref().is_some_and(|t| t.state.status == 2) {
            let timer = self.timer.as_ref().unwrap();
            recorder.data.start_tick = timer.state.start_tick;
            recorder.data.end_tick = timer.state.end_tick;
            recorder.data.track = timer.state.track;
            recorder.data.checkpoint(super::BhState::from(&self.game));
            self.completed_record = Some(recorder.data);
        }
        result
    }
}

/// Optional presentation events never alter authoritative commands or checkpoints.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_record_cosmetic(
    ctx: *mut super::BhContext,
    kind: u32,
) -> std::ffi::c_int {
    unsafe { record_event(ctx, kind, false) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_record_inspect(
    ctx: *mut super::BhContext,
    kind: u32,
) -> std::ffi::c_int {
    unsafe { record_event(ctx, kind, true) }
}
unsafe fn record_event(ctx: *mut super::BhContext, kind: u32, inspect: bool) -> std::ffi::c_int {
    unsafe {
        super::call(ctx, |c| {
            let m = c.map()?;
            let recorder = m.recorder.as_mut().ok_or("no active recording")?;
            let events = if inspect {
                &mut recorder.data.inspect
            } else {
                &mut recorder.data.cosmetic
            };
            if events.len() < 20_000 {
                events.push(super::replay::CosmeticEvent {
                    tick: recorder.data.commands.len() as u32,
                    kind: kind as u8,
                });
            }
            Ok(())
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_record_loadout(
    ctx: *mut super::BhContext,
    packed: *const std::ffi::c_char,
) -> std::ffi::c_int {
    unsafe {
        super::call(ctx, |c| {
            let packed = super::string(packed)?;
            if packed.len() > 255 {
                return Err("packed loadout exceeds 255 bytes".into());
            }
            c.map()?
                .recorder
                .as_mut()
                .ok_or("no active recording")?
                .data
                .packed_loadout = if packed.is_empty() {
                None
            } else {
                Some(packed.to_string())
            };
            Ok(())
        })
    }
}
