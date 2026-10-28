//! Thread-affine C ABI for the existing Rust simulation and Source render-data pipeline.
//!
//! Callers own valid, aligned pointers and NUL-terminated UTF-8 strings. Null inputs are rejected.
//! Borrowed buffers must not be freed by callers. See `apps/native/include/bunnyhop_native.h`.
#![allow(clippy::missing_safety_doc)]

use bunnyhop_core::{Cmd, Game, Settings, content, game, materials, mesh, physics, vfs};
use std::collections::{HashMap, HashSet};
use std::ffi::{CStr, CString, c_char, c_int};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Component, Path, PathBuf};
use std::ptr;
use std::rc::Rc;
use std::thread::{self, ThreadId};

mod release_crypto;
mod assets;
mod look;
mod v29;
pub use v29::{
    BhRecordOptionsV29, BhTimingSegmentV2, bh_record_options_v29, bh_timing_observe,
    bh_timing_path_v2, bh_v29_check_abi,
};
mod replay;
pub use replay::{
    BhGhostFrame, BhReplayEvents, bh_ghost_events, bh_ghost_frame, bh_ghost_free, bh_ghost_info,
    bh_ghost_load, bh_replay_events, bh_replay_header, bh_replay_info, bh_replay_load,
    bh_replay_seek, bh_replay_step, bh_replay_stop,
};
mod recording;
pub use recording::{bh_record_cosmetic, bh_record_inspect, bh_record_loadout};
mod practice;
mod surfaces;
pub use surfaces::{BhSurfaceProbe, bh_surface_at};
mod run;
mod styles;
pub use assets::{BhAttackReport, BhFloorWeapon, BhWeaponReport};
pub use assets::{BhMaterialExtra, BhPropGroup, BhSkyInfo};
pub use look::{BhLookSample, BhLookSampleV2};
pub use practice::{
    bh_practice_from_replay,
    BhNoclipState, bh_noclip_move, bh_practice_enter, bh_practice_free, bh_practice_noclip_exit,
    bh_practice_noclip_tick, bh_practice_restore, bh_practice_save, bh_trace_camera,
};
pub use run::{BhRunOptions, BhRunState, BhZone};

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct BhSettings {
    pub tick_interval: f32,
    pub air_accelerate: f32,
    pub accelerate: f32,
    pub friction: f32,
    pub stop_speed: f32,
    pub gravity: f32,
    pub max_speed: f32,
    pub autohop: u32,
    pub physics: u32,
    pub stamina: u32,
}
impl Default for BhSettings {
    fn default() -> Self {
        let s = Settings::css_bhop();
        Self {
            tick_interval: s.tick_interval,
            air_accelerate: s.air_accelerate,
            accelerate: s.accelerate,
            friction: s.friction,
            stop_speed: s.stop_speed,
            gravity: s.gravity,
            max_speed: s.max_speed,
            autohop: u32::from(s.autohop),
            physics: game::PHYSICS_LATEST,
            stamina: 0,
        }
    }
}
impl BhSettings {
    fn checked(self) -> Result<Settings, String> {
        finite(&[
            self.tick_interval,
            self.air_accelerate,
            self.accelerate,
            self.friction,
            self.stop_speed,
            self.gravity,
            self.max_speed,
        ])?;
        if self.tick_interval <= 0.0
            || self.tick_interval > 1.0
            || self.air_accelerate < 0.0
            || self.accelerate < 0.0
            || self.friction < 0.0
            || self.stop_speed < 0.0
            || self.gravity < 0.0
            || self.max_speed <= 0.0
        {
            return Err("invalid movement settings".into());
        }
        if game::physics_fixes(self.physics).is_none() {
            return Err(format!("unsupported physics version {}", self.physics));
        }
        Ok(Settings {
            tick_interval: self.tick_interval,
            air_accelerate: self.air_accelerate,
            accelerate: self.accelerate,
            friction: self.friction,
            stop_speed: self.stop_speed,
            gravity: self.gravity,
            max_speed: self.max_speed,
            autohop: self.autohop != 0,
            stamina: self.stamina != 0,
            physics_version: self.physics,
        })
    }
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BhCmd {
    pub forward: f32,
    pub side: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub buttons: u32,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BhState {
    pub position: [f32; 3],
    pub velocity: [f32; 3],
    pub view_offset_z: f32,
    pub teleport_angles: [f32; 3],
    pub angle_change: [f32; 3],
    pub touch_position: [f32; 3],
    pub tick: u32,
    pub grounded: u32,
    pub crouched: u32,
    pub on_ladder: u32,
    pub events: u32,
    pub touch_crouched: u32,
}
impl From<&Game> for BhState {
    fn from(g: &Game) -> Self {
        Self {
            position: g.state.position,
            velocity: g.state.velocity,
            view_offset_z: g.state.view_offset[2],
            teleport_angles: g.teleport_angles,
            angle_change: g.view_angle_change,
            touch_position: g.touch_origin,
            tick: g.tick,
            grounded: u32::from(g.state.ground.is_some()),
            crouched: u32::from(g.state.crouch.uses_crouched_hull()),
            on_ladder: u32::from(g.state.mode as u8 == 6),
            events: g.events,
            touch_crouched: u32::from(g.touch_crouched),
        }
    }
}
/// Display-only last canonical movement observation. Not serialized into ranked state/replays.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BhJumpObservation {
    pub pre: BhState,
    pub post: BhState,
    pub command: BhCmd,
    pub valid: u32,
    pub epoch: u32,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BhSnapshot {
    pub player: BhState,
    pub stamina_ms: f32,
    pub base_velocity: [f32; 3],
    pub health: f32,
    pub gravity_scale: f32,
    pub speed_scale: f32,
    pub weapons: u32,
    pub active_weapon: u32,
    pub movement_mode: u32,
    pub water_level: u32,
}
impl From<&Game> for BhSnapshot {
    fn from(g: &Game) -> Self {
        let (weapons, active) = g.weapons();
        Self {
            player: BhState::from(g),
            stamina_ms: g.state.stamina_ms,
            base_velocity: g.state.base_velocity,
            health: g.health,
            gravity_scale: g.gravity_scale,
            speed_scale: g.speed_scale,
            weapons: u32::from(weapons),
            active_weapon: u32::from(active),
            movement_mode: g.state.mode as u32,
            water_level: u32::from(g.state.water_level),
        }
    }
}
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct BhGroup {
    pub model: u32,
    pub material: u32,
    pub first_index: u32,
    pub index_count: u32,
    pub sky3d: u32,
}
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct BhMaterial {
    pub texture: i32,
    pub kind: u32,
    pub flags: u32,
    pub alpha: f32,
    pub alpha_ref: f32,
    pub color: [f32; 3],
}
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct BhImage {
    pub rgba: *const u8,
    pub byte_count: usize,
    pub width: u32,
    pub height: u32,
}
/// How to read the loaded map's lightmap atlas (bunnyhop_core::lightmap).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BhLightmapInfo {
    /// Divide the sRGB-decoded texel by this for linear light.
    pub scale: f32,
    /// Built from the map's HDR lighting: CS:S draws the map with auto exposure and bloom.
    pub hdr: u32,
}
impl Default for BhImage {
    fn default() -> Self {
        Self {
            rgba: ptr::null(),
            byte_count: 0,
            width: 0,
            height: 0,
        }
    }
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BhTransform {
    pub origin: [f32; 3],
    pub angles: [f32; 3],
    pub visible: u32,
}

struct Map {
    game: Game,
    mesh: mesh::Mesh,
    groups: Vec<BhGroup>,
    materials: materials::Materials,
    material_abi: Vec<BhMaterial>,
    vfs: vfs::Vfs,
    root: Option<PathBuf>,
    loose: HashMap<String, Rc<[u8]>>,
    attempted: HashSet<String>,
    texture: Vec<u8>,
    model_count: usize,
    transforms: Vec<BhTransform>,
    transforms_dirty: bool,
    map_name: String,
    map_path: PathBuf,
    map_sha256: String,
    entities_json: CString,
    models_json: CString,
    snapshot_buffer: Vec<u8>,
    timer: Option<run::Timer>,
    recorder: Option<recording::Recorder>,
    record_summary: CString,
    recorded_commands: u64,
    record_hash: u32,
    record_valid: bool,
    completed_record: Option<recording::ReplayData>,
    assets: assets::Assets,
    filter: styles::Filter,
    last_command: BhCmd,
    jump_observation: BhJumpObservation,
    playback: Option<replay::Playback>,
    ghosts: Vec<Option<replay::Ghost>>,
    checkpoints: Vec<Option<practice::Checkpoint>>,
}
impl Map {
    fn load(path: &Path, root: Option<&Path>, settings: BhSettings) -> Result<Self, String> {
        let root = root
            .map(|p| {
                p.canonicalize()
                    .map_err(|e| format!("{}: {e}", p.display()))
            })
            .transpose()?;
        if root.as_ref().is_some_and(|p| !p.is_dir()) {
            return Err("content root is not a directory".into());
        }
        let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let map_sha256 = recording::sha(&bytes);
        let map_name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or("map filename is not UTF-8")?
            .to_string();
        let bsp = bunnyhop_core::parse_bsp(&bytes)?;
        drop(bytes);
        let mut fs = physics::map_vfs(&bsp);
        let mut loose = HashMap::new();
        let mut attempted = HashSet::new();
        if let Some(root) = &root {
            // Only files needed by this BSP's collision models are read, with pakfile precedence.
            for p in physics::prop_sources(&bsp, &physics::entity_list(&bsp), &mut Vec::new()) {
                let mut paths = vec![p.collision_file()];
                if p.pushaway.is_some() {
                    paths.push(physics::collision_file(&p.name, 6));
                }
                for name in paths {
                    if fs.read(&name).is_none() && attempted.insert(name.clone()) {
                        if let Some(bytes) = read_loose(root, &name) {
                            loose.insert(name, bytes.into());
                        }
                    }
                }
            }
            fs.mount(vfs::Source::loose("loose", loose.clone()));
            fs.mount(vfs::Source::listing(Rc::new(
                vfs::Listing::everything_under("disk", ""),
            )));
        }
        let mesh = mesh::build(&bsp);
        let mut names = mesh
            .materials
            .iter()
            .map(|m| m.name.clone())
            .collect::<Vec<_>>();
        let all_names = mesh::texture_names(&bsp);
        // VMT includes/patches and texture dependencies are discovered through the existing resolver.
        loop {
            let _ = materials::resolve(&fs, &all_names);
            let pending = fs.take_pending();
            let Some(root) = &root else { break };
            let mut changed = false;
            for req in pending {
                if attempted.insert(req.path.clone()) {
                    if let Some(bytes) = read_loose(root, &req.path) {
                        loose.insert(req.path, bytes.into());
                        changed = true;
                    }
                }
            }
            if !changed {
                break;
            }
            remount(&mut fs, &loose);
        }
        // Include loose VMTs too: the simulation reads $surfaceprop from these same materials.
        let physics_content = if root.is_some() {
            Some(vfs::Source::loose("content", loose.clone()))
        } else {
            content::cached_physics_content(path)
        };
        let mut game = Game::load_with_content(&bsp, physics_content)?;
        game.set_settings(settings.checked()?);
        game.reset();
        let mut sp = bunnyhop_core::props::static_props(&bsp);
        let n_static = sp.props.len();
        bunnyhop_core::props::add_props(&mut sp, game.render_props());
        bunnyhop_core::skybox::mark_props(&bsp, &mut sp, n_static);
        let props = loop {
            let p = bunnyhop_core::props::build(&sp, &fs);
            if !assets::fetch_pending(&mut fs, root.as_deref(), &mut loose, &mut attempted) {
                break p;
            }
        };
        let mut material_index = |name: &String| -> u32 {
            if let Some(i) = names.iter().position(|n| n == name) {
                i as u32
            } else {
                let i = names.len();
                names.push(name.clone());
                i as u32
            }
        };
        let prop_mats = props
            .materials
            .iter()
            .map(&mut material_index)
            .collect::<Vec<_>>();
        let sky_name = content::skyname(&bsp).unwrap_or_default();
        let sky_materials = if sky_name.is_empty() {
            vec![-1; 6]
        } else {
            content::sky_materials(&sky_name)
                .iter()
                .map(|n| material_index(n) as i32)
                .collect()
        };
        let materials = loop {
            let m = materials::resolve(&fs, &names);
            if !assets::fetch_pending(&mut fs, root.as_deref(), &mut loose, &mut attempted) {
                break m;
            }
        };
        let mut prop_groups = props
            .groups
            .iter()
            .enumerate()
            .map(|(i, g)| BhPropGroup {
                material: prop_mats[g[0] as usize],
                first_index: g[1],
                index_count: g[2],
                sky3d: u32::from(props.group_sky3d.get(i).copied().unwrap_or(false)),
                entity: -1,
            })
            .collect::<Vec<_>>();
        prop_groups.extend(props.dynamic_groups.iter().map(|g| BhPropGroup {
            material: prop_mats[g[1] as usize],
            first_index: g[2],
            index_count: g[3],
            sky3d: 0,
            entity: g[0] as i32,
        }));
        let sky = bunnyhop_core::skybox::find(&bsp, &game.entities);
        let sky_groups = mesh
            .sky_groups
            .iter()
            .map(|g| BhGroup {
                model: g[0],
                material: 0,
                first_index: g[1],
                index_count: g[2],
                sky3d: u32::from(
                    sky.as_ref()
                        .and_then(|s| s.models.get(g[0] as usize))
                        .copied()
                        .unwrap_or(false),
                ),
            })
            .collect();
        let extras = materials
            .descs
            .iter()
            .map(|d| BhMaterialExtra {
                texture2: d.texture2,
                detail: d.detail,
                detail_scale: d.detail_scale,
                detail_blend: d.detail_blend,
                fog_start: d.fog_start,
                fog_end: d.fog_end,
                above_water: u32::from(d.above_water),
            })
            .collect();
        let assets = assets::Assets {
            surfaces: surfaces::Grid::build(&mesh, &materials),
            sky_groups,
            sky_materials,
            sky_name: CString::new(sky_name).map_err(|e| e.to_string())?,
            extras,
            texinfo_drawn: mesh::texinfo_drawn(&bsp),
            overlay: CString::default(),
            overlay_states: Vec::new(),
            effect_states: Vec::new(),
            light_styles: bunnyhop_core::lightmap::StyleAtlas::new(&bsp),
            material_names: CString::new(serde_json::to_string(&names).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?,
            floor: Vec::new(),
            props,
            prop_groups,
            water: CString::new(
                serde_json::json!({"volumes":mesh.water,"planes":mesh.water_planes}).to_string(),
            )
            .map_err(|e| e.to_string())?,
            bytes: Vec::new(),
            models: Vec::new(),
            model_info: Vec::new(),
            anim: Vec::new(),
        };
        let groups = mesh
            .groups
            .iter()
            .map(|g| BhGroup {
                model: g.model,
                material: g.material,
                first_index: g.first_index,
                index_count: g.index_count,
                sky3d: u32::from(g.sky3d),
            })
            .collect();
        let material_abi = materials
            .descs
            .iter()
            .map(|m| BhMaterial {
                texture: m.texture,
                kind: m.kind as u32,
                flags: m.flags,
                alpha: m.alpha,
                alpha_ref: m.alpha_ref,
                color: m.color,
            })
            .collect();
        let model_count = match bsp.lump(playsrc_bsp::MODELS).map(|l| &l.records) {
            Some(playsrc_bsp::LumpData::Models(models)) => models.len(),
            _ => 0,
        };
        let entities = game
            .entities
            .iter()
            .map(|e| {
                let pairs: serde_json::Map<String, serde_json::Value> = e
                    .pairs
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone().into()))
                    .collect();
                serde_json::Value::Object(pairs)
            })
            .collect::<Vec<_>>();
        let models = match bsp.lump(playsrc_bsp::MODELS).map(|l| &l.records) {
            Some(playsrc_bsp::LumpData::Models(models)) => models
                .iter()
                .map(|m| {
                    let f = |p: playsrc_bsp::Vector3| [p.x.value(), p.y.value(), p.z.value()];
                    serde_json::json!({"mins":f(m.mins),"maxs":f(m.maxs)})
                })
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        };
        let entities_json =
            CString::new(serde_json::to_string(&entities).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let models_json = CString::new(serde_json::to_string(&models).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            game,
            mesh,
            groups,
            materials,
            material_abi,
            vfs: fs,
            root,
            loose,
            attempted,
            texture: Vec::new(),
            model_count,
            transforms: Vec::new(),
            transforms_dirty: true,
            map_name,
            map_path: path.canonicalize().map_err(|e| e.to_string())?,
            map_sha256,
            entities_json,
            models_json,
            snapshot_buffer: Vec::new(),
            timer: None,
            recorder: None,
            record_summary: CString::default(),
            recorded_commands: 0,
            record_hash: run::HASH_SEED,
            record_valid: false,
            completed_record: None,
            assets,
            filter: styles::Filter::new("autohop", settings.physics),
            last_command: BhCmd::default(),
            jump_observation: BhJumpObservation::default(),
            playback: None,
            ghosts: Vec::new(),
            checkpoints: Vec::new(),
        })
    }
    fn transform(&mut self, model: u32) -> Result<BhTransform, String> {
        if model as usize >= self.model_count {
            return Err("model index out of range".into());
        }
        if self.transforms_dirty {
            self.transforms.clear();
            self.transforms.resize(
                self.model_count,
                BhTransform {
                    visible: 1,
                    ..BhTransform::default()
                },
            );
            for (model, origin, angles) in self.game.brush_transforms() {
                if model != 0 {
                    if let Some(t) = self.transforms.get_mut(model as usize) {
                        t.origin = origin;
                        t.angles = angles;
                    }
                }
            }
            for (model, visible, _) in self.game.brush_states() {
                if model != 0 {
                    if let Some(t) = self.transforms.get_mut(model as usize) {
                        t.visible = u32::from(visible);
                    }
                }
            }
            self.transforms_dirty = false;
        }
        Ok(self.transforms[model as usize])
    }
    fn texture(&mut self, index: u32) -> Result<BhImage, String> {
        self.texture.clear();
        let path = self
            .materials
            .textures
            .get(index as usize)
            .ok_or("texture index out of range")?
            .clone();
        if self.vfs.read(&path).is_none() {
            if let Some(root) = &self.root {
                if self.attempted.insert(path.clone()) {
                    if let Some(bytes) = read_loose(root, &path) {
                        self.loose.insert(path.clone(), bytes.into());
                        remount(&mut self.vfs, &self.loose);
                    }
                }
            }
        }
        let bytes = self
            .vfs
            .read(&path)
            .ok_or_else(|| format!("texture unavailable: {path}"))?;
        let payload = match self.materials.rgbs.get(&path) {
            Some(&color) => materials::texture_payload_rgbs(bytes, color),
            None => materials::texture_payload(bytes, false, true),
        }
        .map_err(|e| format!("{path}: {e}"))?;
        let level = payload.levels.first().ok_or("texture has no mip 0")?;
        let width = level.width;
        let height = level.height;
        let end = (level.offset as usize)
            .checked_add(level.len as usize)
            .ok_or("texture size overflow")?;
        self.texture = payload
            .bytes
            .get(level.offset as usize..end)
            .ok_or("invalid texture payload")?
            .to_vec();
        Ok(BhImage {
            rgba: self.texture.as_ptr(),
            byte_count: self.texture.len(),
            width,
            height,
        })
    }
}
fn remount(fs: &mut vfs::Vfs, loose: &HashMap<String, Rc<[u8]>>) {
    fs.unmount("loose");
    fs.unmount("disk");
    fs.mount(vfs::Source::loose("loose", loose.clone()));
    fs.mount(vfs::Source::listing(Rc::new(
        vfs::Listing::everything_under("disk", ""),
    )));
}
fn read_loose(root: &Path, name: &str) -> Option<Vec<u8>> {
    let path = Path::new(name);
    if !path.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    let path = root.join(path).canonicalize().ok()?;
    if !path.starts_with(root) {
        return None;
    }
    std::fs::read(path).ok()
}

pub struct BhContext {
    owner: ThreadId,
    map: Option<Map>,
    settings: BhSettings,
    error: CString,
    record_identity: String,
    style_id: String,
    replay_header: CString,
}
impl BhContext {
    fn new() -> Self {
        Self {
            owner: thread::current().id(),
            map: None,
            settings: BhSettings::default(),
            error: CString::default(),
            record_identity: "bunnyhop-native/local".into(),
            style_id: "autohop".into(),
            replay_header: CString::default(),
        }
    }
    fn map(&mut self) -> Result<&mut Map, String> {
        self.map.as_mut().ok_or_else(|| "no map loaded".into())
    }
    fn error(&mut self, message: &str) {
        self.error = CString::new(message.replace('\0', " ")).unwrap_or_default();
    }
}
fn finite(values: &[f32]) -> Result<(), String> {
    if values.iter().all(|v| v.is_finite()) {
        Ok(())
    } else {
        Err("non-finite input".into())
    }
}
unsafe fn string<'a>(p: *const c_char) -> Result<&'a str, String> {
    if p.is_null() {
        return Err("null string".into());
    }
    unsafe { CStr::from_ptr(p) }
        .to_str()
        .map_err(|_| "string is not UTF-8".into())
}
unsafe fn input<T: Copy>(p: *const T) -> Result<T, String> {
    if p.is_null() {
        Err("null input".into())
    } else {
        Ok(unsafe { p.read() })
    }
}
unsafe fn output<T>(p: *mut T, value: T) -> Result<(), String> {
    if p.is_null() {
        Err("null output".into())
    } else {
        unsafe { p.write(value) };
        Ok(())
    }
}
unsafe fn call(ctx: *mut BhContext, f: impl FnOnce(&mut BhContext) -> Result<(), String>) -> c_int {
    if ctx.is_null() {
        return 0;
    }
    let c = unsafe { &mut *ctx };
    if c.owner != thread::current().id() {
        return 0;
    }
    match catch_unwind(AssertUnwindSafe(|| {
        if !c.error.as_bytes().is_empty() {
            c.error = CString::default();
        }
        f(c)
    })) {
        Ok(Ok(())) => 1,
        Ok(Err(e)) => {
            c.error(&e);
            0
        }
        Err(_) => {
            c.map = None;
            c.error("Rust panic: map discarded");
            0
        }
    }
}
unsafe fn read<R: Copy>(ctx: *const BhContext, fallback: R, f: impl FnOnce(&BhContext) -> R) -> R {
    catch_unwind(AssertUnwindSafe(|| {
        if ctx.is_null() {
            return fallback;
        }
        let c = unsafe { &*ctx };
        if c.owner != thread::current().id() {
            return fallback;
        }
        f(c)
    }))
    .unwrap_or(fallback)
}

#[unsafe(no_mangle)]
pub extern "C" fn bh_abi_version() -> u32 {
    1
}
#[unsafe(no_mangle)]
pub extern "C" fn bh_create() -> *mut BhContext {
    catch_unwind(|| Box::into_raw(Box::new(BhContext::new()))).unwrap_or(ptr::null_mut())
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_destroy(ctx: *mut BhContext) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if !ctx.is_null() && unsafe { (*ctx).owner } == thread::current().id() {
            unsafe {
                if let Some(m) = &mut (*ctx).map {
                    let _ = m.finish_record(false, "destroyed");
                }
                drop(Box::from_raw(ctx));
            }
        }
    }));
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_last_error(ctx: *const BhContext) -> *const c_char {
    unsafe {
        read(ctx, c"null or wrong-thread context".as_ptr(), |c| {
            c.error.as_ptr()
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_default_settings(out: *mut BhSettings) {
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        output(out, BhSettings::default())
    }));
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_load_map(
    ctx: *mut BhContext,
    path: *const c_char,
    content_root: *const c_char,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            if let Some(mut old) = c.map.take() {
                let _ = old.finish_record(false, "map_reload");
            }
            let path = Path::new(string(path)?);
            let root = if content_root.is_null() {
                None
            } else {
                Some(Path::new(string(content_root)?))
            };
            let mut map = Map::load(path, root, c.settings)?;
            map.filter = styles::Filter::new(&c.style_id, c.settings.physics);
            c.map = Some(map);
            Ok(())
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_set_settings(
    ctx: *mut BhContext,
    settings: *const BhSettings,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            let settings = input(settings)?;
            let core = settings.checked()?;
            if let Some(m) = &mut c.map {
                m.finish_record(false, "settings_changed")?;
                m.playback = None;
                if let Some(t) = &mut m.timer {
                    t.reset(settings.tick_interval);
                }
                m.game.set_settings(core);
                m.filter.reset(settings.physics);
            }
            c.settings = settings;
            Ok(())
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_reset(ctx: *mut BhContext) -> c_int {
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            m.finish_record(false, "reset")?;
            m.playback = None;
            m.transforms_dirty = true;
            m.game.reset();
            m.filter.reset(m.game.settings.physics_version);
            if let Some(t) = &mut m.timer {
                t.reset(m.game.settings.tick_interval);
            }
            Ok(())
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_set_position(
    ctx: *mut BhContext,
    x: f32,
    y: f32,
    z: f32,
    yaw: f32,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            finite(&[x, y, z, yaw])?;
            let m = c.map()?;
            m.transforms_dirty = true;
            m.finish_record(false, "position_changed")?;
            m.game.set_position([x, y, z], yaw);
            Ok(())
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_set_velocity(ctx: *mut BhContext, x: f32, y: f32, z: f32) -> c_int {
    unsafe {
        call(ctx, |c| {
            finite(&[x, y, z])?;
            let m = c.map()?;
            m.finish_record(false, "external_velocity_changed")?;
            m.game.state.velocity = [x, y, z];
            Ok(())
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_set_restart_names(
    ctx: *mut BhContext,
    targetname: *const c_char,
    classname: *const c_char,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            m.transforms_dirty = true;
            let targetname = string(targetname)?;
            let classname = string(classname)?;
            m.finish_record(false, "restart_names_changed")?;
            m.game.set_restart_names(targetname, classname);
            Ok(())
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_step_look(
    ctx: *mut BhContext,
    cmd: *const BhCmd,
    look: *const BhLookSample,
    out: *mut BhState,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            if out.is_null() {
                return Err("null output".into());
            }
            let cmd = input(cmd)?;
            let look = if look.is_null() {
                None
            } else {
                Some(BhLookSampleV2::from(input(look)?))
            };
            let m = c.map()?;
            if m.playback.is_some() {
                return Err("use bh_replay_step or stop playback before live input".into());
            }
            let state = m.advance(cmd, look)?;
            output(out, state)
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_step_look_v2(
    ctx: *mut BhContext,
    cmd: *const BhCmd,
    look: *const BhLookSampleV2,
    out: *mut BhState,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            if out.is_null() {
                return Err("null output".into());
            }
            let cmd = input(cmd)?;
            let look = if look.is_null() {
                None
            } else {
                Some(input(look)?)
            };
            let m = c.map()?;
            if m.playback.is_some() {
                return Err("use bh_replay_step or stop playback before live input".into());
            }
            let state = m.advance(cmd, look)?;
            output(out, state)
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_state(ctx: *mut BhContext, out: *mut BhState) -> c_int {
    unsafe { call(ctx, |c| output(out, BhState::from(&c.map()?.game))) }
}
macro_rules! buffer {
    ($name:ident, $ty:ty, $field:ident $(.$sub:ident)*) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(ctx: *const BhContext, count: *mut usize) -> *const $ty {
            let _ = unsafe { output(count, 0) };
            unsafe { read(ctx, ptr::null(), |c| {
                let Some(m) = &c.map else { return ptr::null(); };
                let values = &m.$field $(.$sub)*;
                let _ = output(count, values.len());
                if values.is_empty() { ptr::null() } else { values.as_ptr() }
            }) }
        }
    };
}
buffer!(bh_vertices, f32, mesh.vertices);
buffer!(bh_indices, u32, mesh.indices);
buffer!(bh_groups, BhGroup, groups);
buffer!(bh_materials, BhMaterial, material_abi);
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_lightmap(ctx: *mut BhContext, out: *mut BhImage) -> c_int {
    unsafe {
        call(ctx, |c| {
            output(out, BhImage::default())?;
            let m=c.map()?;m.refresh_light_styles();let a = &m.mesh.lightmap;
            output(
                out,
                BhImage {
                    rgba: a.rgba.as_ptr(),
                    byte_count: a.rgba.len(),
                    width: a.width,
                    height: a.height,
                },
            )
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_lightmap_info(ctx: *mut BhContext, out: *mut BhLightmapInfo) -> c_int {
    unsafe {
        call(ctx, |c| {
            output(out, BhLightmapInfo::default())?;
            let a = &c.map()?.mesh.lightmap;
            output(out, BhLightmapInfo { scale: a.scale, hdr: a.hdr as u32 })
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_texture(ctx: *mut BhContext, index: u32, out: *mut BhImage) -> c_int {
    unsafe {
        call(ctx, |c| {
            output(out, BhImage::default())?;
            output(out, c.map()?.texture(index)?)
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_model_transform(
    ctx: *mut BhContext,
    model: u32,
    out: *mut BhTransform,
) -> c_int {
    unsafe { call(ctx, |c| output(out, c.map()?.transform(model)?)) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_spawn(
    ctx: *mut BhContext,
    origin: *mut f32,
    angles: *mut f32,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            if origin.is_null() || angles.is_null() {
                return Err("null output".into());
            }
            let g = &c.map()?.game;
            ptr::copy_nonoverlapping(g.spawn_origin.as_ptr(), origin, 3);
            ptr::copy_nonoverlapping(g.spawn_angles.as_ptr(), angles, 3);
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests;

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_default_run_options(out: *mut BhRunOptions) {
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        output(out, BhRunOptions::default())
    }));
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_run_configure(
    ctx: *mut BhContext,
    options: *const BhRunOptions,
    zones: *const BhZone,
    zone_count: usize,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            let options = input(options)?;
            if ![1, 2].contains(&options.rules)
                || options.strafe_keys > 2
                || !options.prespeed_cap.is_finite()
                || options.prespeed_cap < 0.0
            {
                return Err("invalid native timer options".into());
            }
            if zone_count == 0 || zone_count > 16_384 || zones.is_null() {
                return Err("native timer requires 1..16384 zones".into());
            }
            let zones = std::slice::from_raw_parts(zones, zone_count).to_vec();
            for z in &zones {
                finite(&z.mins)?;
                finite(&z.maxs)?;
                if z.kind > 3
                    || z.track > 255
                    || z.index > 255
                    || (0..3).any(|i| z.mins[i] > z.maxs[i])
                {
                    return Err("invalid native timer zone".into());
                }
            }
            if !zones
                .iter()
                .any(|s| s.kind == 0 && zones.iter().any(|e| e.kind == 1 && e.track == s.track))
            {
                return Err("native timer needs a start and end zone on one track".into());
            }
            let m = c.map()?;
            m.finish_record(false, "zones_changed")?;
            m.timer = Some(run::Timer::new(
                zones,
                options,
                m.game.settings.tick_interval,
            ));
            Ok(())
        })
    }
}
/// Leave replay timing behind when restoring a local map without canonical zones.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_run_clear(ctx: *mut BhContext) -> c_int {
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            m.finish_record(false, "zones_cleared")?;
            m.timer = None;
            Ok(())
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_run_state(ctx: *mut BhContext, out: *mut BhRunState) -> c_int {
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            let mut s = m
                .timer
                .as_ref()
                .ok_or("native timer is not configured")?
                .state;
            s.recording = u32::from(m.recorder.is_some());
            s.recording_valid = u32::from(m.record_valid);
            s.total_commands = m.recorded_commands;
            s.rolling_hash = m.record_hash;
            output(out, s)
        })
    }
}
/// Same clean-tick bit as web PlayerState.jumpStatsValid, plus the canonical command and endpoints.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_jump_observation(ctx: *mut BhContext, out: *mut BhJumpObservation) -> c_int {
    unsafe { call(ctx, |c| output(out, c.map()?.jump_observation)) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_snapshot(ctx: *mut BhContext, out: *mut BhSnapshot) -> c_int {
    unsafe { call(ctx, |c| output(out, BhSnapshot::from(&c.map()?.game))) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_snapshot_bytes(
    ctx: *mut BhContext,
    byte_count: *mut usize,
) -> *const u8 {
    let mut result = ptr::null();
    let _ = unsafe { output(byte_count, 0) };
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            m.snapshot_buffer = m.game.snapshot_bytes();
            output(byte_count, m.snapshot_buffer.len())?;
            result = m.snapshot_buffer.as_ptr();
            Ok(())
        })
    };
    result
}
macro_rules! json_buffer {
    ($name:ident,$field:ident) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(
            ctx: *mut BhContext,
            byte_count: *mut usize,
        ) -> *const c_char {
            let mut result = ptr::null();
            let _ = unsafe { output(byte_count, 0) };
            unsafe {
                call(ctx, |c| {
                    let text = &c.map()?.$field;
                    if !byte_count.is_null() {
                        output(byte_count, text.as_bytes().len())?;
                    }
                    result = text.as_ptr();
                    Ok(())
                })
            };
            result
        }
    };
}
json_buffer!(bh_entities_json, entities_json);
json_buffer!(bh_models_json, models_json);
json_buffer!(bh_record_summary_json, record_summary);
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_record_begin(
    ctx: *mut BhContext,
    path: *const c_char,
    style: *const c_char,
    player: *const c_char,
    checkpoint_interval: u32,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            let settings = c.settings;
            let identity = c.record_identity.clone();
            let path = if path.is_null() {
                None
            } else {
                let s = string(path)?;
                if s.is_empty() {
                    None
                } else {
                    Some(Path::new(s))
                }
            };
            let style = string(style)?;
            c.map()?.begin_record(
                path,
                style,
                string(player)?,
                checkpoint_interval,
                settings,
                &identity,
            )?;
            c.style_id = style.to_string();
            Ok(())
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_record_end(ctx: *mut BhContext) -> c_int {
    unsafe { call(ctx, |c| c.map()?.finish_record(true, "ended")) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_sha256(
    bytes: *const u8,
    byte_count: usize,
    out_hex: *mut c_char,
) -> c_int {
    catch_unwind(AssertUnwindSafe(|| {
        if out_hex.is_null()
            || byte_count > isize::MAX as usize
            || bytes.is_null() && byte_count != 0
        {
            return 0;
        }
        let input = if byte_count == 0 {
            &[]
        } else {
            unsafe { std::slice::from_raw_parts(bytes, byte_count) }
        };
        let hash = recording::sha(input);
        unsafe {
            ptr::copy_nonoverlapping(hash.as_ptr(), out_hex.cast::<u8>(), 64);
            out_hex.add(64).write(0);
        }
        1
    }))
    .unwrap_or(0)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_record_identity(
    ctx: *mut BhContext,
    client_build: *const c_char,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            let value = string(client_build)?;
            if value.is_empty() || value.len() > 255 {
                return Err("clientBuild must be 1..255 UTF-8 bytes".into());
            }
            if let Some(m) = &mut c.map {
                m.finish_record(false, "identity_changed")?;
            }
            c.record_identity = value.into();
            Ok(())
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_record_write_bhr(ctx: *mut BhContext, path: *const c_char) -> c_int {
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            if m.recorder.is_some() || !m.record_valid {
                return Err("end a valid native recording before writing BHR".into());
            }
            m.completed_record
                .as_ref()
                .ok_or("native recording did not finish a run")?
                .write_bhr(Path::new(string(path)?))
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_record_fold(
    ctx: *mut BhContext,
    hash: u32,
    from_index: usize,
    to_index: usize,
    out_hash: *mut u32,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            if !m.record_valid {
                return Err("native recording is not valid".into());
            }
            let data = m
                .recorder
                .as_ref()
                .map(|r| &r.data)
                .or(m.completed_record.as_ref())
                .ok_or("no retained native recording")?;
            let cmds = data
                .commands
                .get(from_index..to_index)
                .ok_or("command fold range is out of bounds")?;
            output(
                out_hash,
                cmds.iter().fold(hash, |h, c| run::fold_command(h, *c)),
            )
        })
    }
}

buffer!(bh_blend, f32, mesh.blend);
buffer!(bh_sky_vertices, f32, mesh.sky_vertices);
buffer!(bh_sky_indices, u32, mesh.sky_indices);
buffer!(bh_sky_groups, BhGroup, assets.sky_groups);
buffer!(bh_sky_materials, i32, assets.sky_materials);
buffer!(bh_material_extras, BhMaterialExtra, assets.extras);
buffer!(bh_prop_vertices, f32, assets.props.vertices);
buffer!(bh_prop_indices, u32, assets.props.indices);
buffer!(bh_prop_groups, BhPropGroup, assets.prop_groups);
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_sky_info(ctx: *mut BhContext, out: *mut BhSkyInfo) -> c_int {
    unsafe {
        call(ctx, |c| {
            let s = c
                .map()?
                .mesh
                .sky_camera
                .as_ref()
                .ok_or("map has no 3D sky camera")?;
            output(
                out,
                BhSkyInfo {
                    origin: s.origin,
                    scale: s.scale,
                    area: u32::from(s.area),
                    fog_enable: u32::from(s.fog.enable),
                    fog_blend: u32::from(s.fog.blend),
                    fog_color: s.fog.color,
                    fog_color2: s.fog.color2,
                    fog_dir: s.fog.dir,
                    fog_start: s.fog.start,
                    fog_end: s.fog.end,
                    fog_max_density: s.fog.max_density,
                },
            )
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_sky_name(ctx: *mut BhContext, count: *mut usize) -> *const c_char {
    let mut result = ptr::null();
    unsafe {
        call(ctx, |c| {
            let s = &c.map()?.assets.sky_name;
            if !count.is_null() {
                output(count, s.as_bytes().len())?;
            }
            result = s.as_ptr();
            Ok(())
        })
    };
    result
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_water_json(ctx: *mut BhContext, count: *mut usize) -> *const c_char {
    let mut result = ptr::null();
    unsafe {
        call(ctx, |c| {
            let s = &c.map()?.assets.water;
            if !count.is_null() {
                output(count, s.as_bytes().len())?;
            }
            result = s.as_ptr();
            Ok(())
        })
    };
    result
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_prop_transform(
    ctx: *mut BhContext,
    entity: u32,
    out: *mut BhTransform,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            let g = &c.map()?.game;
            let (origin, angles) = g
                .moving_prop_transforms()
                .into_iter()
                .find(|t| t.0 == entity as usize)
                .map(|t| (t.1, t.2))
                .or_else(|| g.entity_transform(entity as usize))
                .ok_or("unknown prop entity")?;
            output(
                out,
                BhTransform {
                    origin,
                    angles,
                    visible: u32::from(
                        g.overlay_states()
                            .nth(entity as usize)
                            .is_some_and(|flags| flags & 2 != 0),
                    ),
                },
            )
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_content_read(
    ctx: *mut BhContext,
    path: *const c_char,
    count: *mut usize,
) -> *const u8 {
    let mut result = ptr::null();
    let _ = unsafe { output(count, 0) };
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            m.assets.bytes = m.content(string(path)?)?;
            if !count.is_null() {
                output(count, m.assets.bytes.len())?;
            }
            result = m.assets.bytes.as_ptr();
            Ok(())
        })
    };
    result
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_texture_path(
    ctx: *mut BhContext,
    path: *const c_char,
    out: *mut BhImage,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            output(out, BhImage::default())?;
            output(out, c.map()?.texture_path(string(path)?)?)
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_style_settings(style: *const c_char, out: *mut BhSettings) -> c_int {
    catch_unwind(AssertUnwindSafe(|| unsafe {
        styles::settings(string(style)?).and_then(|s| output(out, s))
    }))
    .ok()
    .is_some_and(|r| r.is_ok()) as c_int
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_style_set(ctx: *mut BhContext, style: *const c_char) -> c_int {
    unsafe {
        call(ctx, |c| {
            let id = string(style)?;
            let settings = styles::settings(id)?;
            if let Some(m) = &mut c.map {
                m.finish_record(false, "style_changed")?;
                m.playback = None;
                m.filter = styles::Filter::new(id, settings.physics);
                m.game.set_settings(settings.checked()?);
                m.game.reset();
                m.transforms_dirty = true;
                if let Some(t) = &mut m.timer {
                    t.options.block_prehops = u32::from(id == "scroll");
                    t.options.cap_enabled = u32::from(id != "scroll");
                    t.options.prespeed_cap = 290.0;
                    t.options.strafe_keys = styles::strafe_keys(id);
                    t.reset(settings.tick_interval);
                }
            }
            c.settings = settings;
            c.style_id = id.into();
            Ok(())
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_last_command(ctx: *mut BhContext, out: *mut BhCmd) -> c_int {
    unsafe { call(ctx, |c| output(out, c.map()?.last_command)) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_step(
    ctx: *mut BhContext,
    cmd: *const BhCmd,
    out: *mut BhState,
) -> c_int {
    unsafe { bh_step_look(ctx, cmd, ptr::null(), out) }
}

impl Map {
    fn invalidate_jump_observation(&mut self) {
        self.jump_observation.valid = 0;
        self.jump_observation.epoch = self.jump_observation.epoch.wrapping_add(1);
    }
    fn advance(&mut self, cmd: BhCmd, look: Option<BhLookSampleV2>) -> Result<BhState, String> {
        self.advance_canonical(cmd, look, true)
    }
    fn advance_canonical(
        &mut self,
        cmd: BhCmd,
        look: Option<BhLookSampleV2>,
        filter: bool,
    ) -> Result<BhState, String> {
        finite(&[cmd.forward, cmd.side, cmd.yaw, cmd.pitch])?;
        if self.recorder.is_some()
            && [cmd.forward, cmd.side]
                .iter()
                .any(|v| *v < -32768.0 || *v > 32767.0 || v.trunc() != *v)
        {
            return Err("recorded movement must be representable as i16".into());
        }
        let cmd = if filter {
            self.filter.apply(cmd, BhState::from(&self.game))
        } else {
            cmd
        };
        self.last_command = cmd;
        self.jump_observation.pre = BhState::from(&self.game);
        self.jump_observation.command = cmd;
        self.jump_observation.valid = 0;
        let pre_walk = self.game.state.mode as u8 == 0;
        let mut clamped = false;
        self.transforms_dirty = true;
        if let Some(t) = &mut self.timer {
            if let Some(v) = t.before_step(cmd, BhState::from(&self.game)) {
                clamped = true;
                self.game.state.velocity = v;
            }
        }
        if let Err(e) = self.game.step(Cmd {
            forward: cmd.forward,
            side: cmd.side,
            yaw: cmd.yaw,
            pitch: cmd.pitch,
            buttons: cmd.buttons,
        }) {
            let _ = self.finish_record(false, "simulation_error");
            return Err(e);
        }
        if let Some(t) = &mut self.timer {
            if let Some(v) = t.update(cmd, BhState::from(&self.game)) {
                clamped = true;
                self.game.state.velocity = v;
            }
        }
        self.jump_observation.post = BhState::from(&self.game);
        self.jump_observation.valid = u32::from(!clamped && pre_walk
            && self.game.state.mode as u8 == 0 && self.game.jumpstats_valid);
        self.record_tick(cmd, look)?;
        Ok(BhState::from(&self.game))
    }
}
