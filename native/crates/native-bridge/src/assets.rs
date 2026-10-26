//! Existing Source render/content builders exposed without a browser-owned renderer.
use super::*;
use bunnyhop_core::{props, studio};
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BhSkyInfo {
    pub origin: [f32; 3],
    pub scale: f32,
    pub area: u32,
    pub fog_enable: u32,
    pub fog_blend: u32,
    pub fog_color: [f32; 3],
    pub fog_color2: [f32; 3],
    pub fog_dir: [f32; 3],
    pub fog_start: f32,
    pub fog_end: f32,
    pub fog_max_density: f32,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BhMaterialExtra {
    pub texture2: i32,
    pub detail: i32,
    pub detail_scale: f32,
    pub detail_blend: f32,
    pub fog_start: f32,
    pub fog_end: f32,
    pub above_water: u32,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BhPropGroup {
    pub material: u32,
    pub first_index: u32,
    pub index_count: u32,
    pub sky3d: u32,
    pub entity: i32,
}
pub struct Assets {
    pub surfaces: surfaces::Grid,
    pub sky_groups: Vec<BhGroup>,
    pub sky_materials: Vec<i32>,
    pub sky_name: CString,
    pub extras: Vec<BhMaterialExtra>,
    pub material_names: CString,
    pub texinfo_drawn: Vec<bool>,
    pub overlay: CString,
    pub overlay_states: Vec<u32>,
    pub effect_states: Vec<u32>,
    pub light_styles: Option<bunnyhop_core::lightmap::StyleAtlas>,
    pub floor: Vec<BhFloorWeapon>,
    pub props: props::PropMesh,
    pub prop_groups: Vec<BhPropGroup>,
    pub water: CString,
    pub bytes: Vec<u8>,
    pub models: Vec<studio::StudioModel>,
    pub model_info: Vec<CString>,
    pub anim: Vec<f32>,
}
pub fn fetch_pending(
    fs: &mut vfs::Vfs,
    root: Option<&Path>,
    loose: &mut HashMap<String, Rc<[u8]>>,
    attempted: &mut HashSet<String>,
) -> bool {
    let pending = fs.take_pending();
    let Some(root) = root else {
        return false;
    };
    let mut changed = false;
    for req in pending {
        if attempted.insert(req.path.clone()) {
            if let Some(bytes) = read_loose(root, &req.path) {
                loose.insert(req.path, bytes.into());
                changed = true;
            }
        }
    }
    if changed {
        remount(fs, loose);
    }
    changed
}
impl Map {
    pub fn content(&mut self, path: &str) -> Result<Vec<u8>, String> {
        let path = vfs::normalize(path);
        if self.vfs.read(&path).is_none() {
            if let Some(root) = &self.root {
                if let Some(bytes) = read_loose(root, &path) {
                    self.loose.insert(path.clone(), bytes.into());
                    remount(&mut self.vfs, &self.loose);
                }
            }
        }
        self.vfs
            .read(&path)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| format!("content unavailable: {path}"))
    }
    pub fn texture_path(&mut self, path: &str) -> Result<BhImage, String> {
        self.texture.clear();
        let bytes = self.content(path)?;
        let payload = materials::texture_payload(&bytes, false, true)?;
        let l = payload.levels.first().ok_or("texture missing mip0")?;
        let width = l.width;
        let height = l.height;
        self.texture = payload
            .bytes
            .get(l.offset as usize..l.offset as usize + l.len as usize)
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

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BhWeaponReport {
    pub flags: u32,
    pub active: u32,
    pub primary: u32,
    pub secondary: u32,
    pub knife: u32,
    pub clip: u32,
    pub clip_size: u32,
    pub reload_ticks: u32,
    pub burst: u32,
    pub floor_changed: u32,
    pub silencer: u32,
    pub silencer_ticks: u32,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BhAttackReport {
    pub weapon: u32,
    pub mode: u32,
    pub hit: u32,
    pub start: [f32; 3],
    pub end: [f32; 3],
    pub normal: [f32; 3],
    pub entity: i32,
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_weapon_report(ctx: *mut BhContext, out: *mut BhWeaponReport) -> c_int {
    unsafe {
        call(ctx, |c| {
            let r = c.map()?.game.weapon_report();
            output(
                out,
                BhWeaponReport {
                    flags: r[0] as u32,
                    active: r[1] as u32,
                    primary: r[2] as u32,
                    secondary: r[3] as u32,
                    knife: r[4] as u32,
                    clip: r[5] as u32,
                    clip_size: r[6] as u32,
                    reload_ticks: r[7] as u32,
                    burst: r[8] as u32,
                    floor_changed: r[9] as u32,
                    silencer: r[10] as u32,
                    silencer_ticks: r[11] as u32,
                },
            )
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_attack_report(ctx: *mut BhContext, out: *mut BhAttackReport) -> c_int {
    unsafe {
        call(ctx, |c| {
            output(out, BhAttackReport::default())?;
            let a = c.map()?.game.attack.ok_or("no attack this tick")?;
            output(
                out,
                BhAttackReport {
                    weapon: u32::from(a.weapon),
                    mode: u32::from(a.mode),
                    hit: u32::from(a.hit),
                    start: a.start,
                    end: a.end,
                    normal: a.normal,
                    entity: a.entity,
                },
            )
        })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_studio_load(ctx: *mut BhContext, path: *const c_char) -> u32 {
    let mut handle = 0;
    unsafe {
        call(ctx, |c| {
            let path = vfs::normalize(string(path)?);
            let m = c.map()?;
            if let Some(i) = m.assets.models.iter().position(|model| model.path == path) {
                handle = i as u32 + 1;
                return Ok(());
            }
            for _ in 0..64 {
                match studio::load(&m.vfs, &path) {
                    studio::Load::Ready(model) => {
                        m.assets
                            .model_info
                            .push(CString::new(model.info_json()).map_err(|e| e.to_string())?);
                        m.assets.models.push(*model);
                        handle = m.assets.models.len() as u32;
                        return Ok(());
                    }
                    studio::Load::Error(e) => return Err(e),
                    studio::Load::Missing => {}
                }
                if !fetch_pending(
                    &mut m.vfs,
                    m.root.as_deref(),
                    &mut m.loose,
                    &mut m.attempted,
                ) {
                    break;
                }
            }
            Err(format!("studio content missing: {path}"))
        })
    };
    handle
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_studio_info(
    ctx: *mut BhContext,
    handle: u32,
    count: *mut usize,
) -> *const c_char {
    let mut p = ptr::null();
    let _ = unsafe { output(count, 0) };
    unsafe {
        call(ctx, |c| {
            let s = c
                .map()?
                .assets
                .model_info
                .get(handle.wrapping_sub(1) as usize)
                .ok_or("invalid studio handle")?;
            if !count.is_null() {
                output(count, s.as_bytes().len())?;
            }
            p = s.as_ptr();
            Ok(())
        })
    };
    p
}
macro_rules! studio_buffer {
    ($name:ident,$ty:ty,$field:ident) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(
            ctx: *mut BhContext,
            handle: u32,
            count: *mut usize,
        ) -> *const $ty {
            let mut p = ptr::null();
            let _ = unsafe { output(count, 0) };
            unsafe {
                call(ctx, |c| {
                    let s = &c
                        .map()?
                        .assets
                        .models
                        .get(handle.wrapping_sub(1) as usize)
                        .ok_or("invalid studio handle")?
                        .mesh
                        .$field;
                    if !count.is_null() {
                        output(count, s.len())?;
                    }
                    if !s.is_empty() {
                        p = s.as_ptr();
                    }
                    Ok(())
                })
            };
            p
        }
    };
}
studio_buffer!(bh_studio_vertices, f32, vertices);
studio_buffer!(bh_studio_indices, u32, indices);
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_studio_animation(
    ctx: *mut BhContext,
    handle: u32,
    animation: u32,
    count: *mut usize,
) -> *const f32 {
    let mut p = ptr::null();
    let _ = unsafe { output(count, 0) };
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            m.assets.anim = m
                .assets
                .models
                .get(handle.wrapping_sub(1) as usize)
                .ok_or("invalid studio handle")?
                .decode_anim(animation as usize)
                .ok_or("invalid studio animation")?;
            if !count.is_null() {
                output(count, m.assets.anim.len())?;
            }
            p = m.assets.anim.as_ptr();
            Ok(())
        })
    };
    p
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BhFloorWeapon {
    pub entity: u32,
    pub weapon: u32,
    pub flags: u32,
    pub position: [f32; 3],
    pub angles: [f32; 3],
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_material_names_json(
    ctx: *mut BhContext,
    count: *mut usize,
) -> *const c_char {
    let mut p = ptr::null();
    let _ = unsafe { output(count, 0) };
    unsafe {
        call(ctx, |c| {
            let s = &c.map()?.assets.material_names;
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
pub unsafe extern "C" fn bh_floor_weapons(
    ctx: *mut BhContext,
    count: *mut usize,
) -> *const BhFloorWeapon {
    let mut p = ptr::null();
    let _ = unsafe { output(count, 0) };
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            let out = &mut m.assets.floor;
            out.clear();
            m.game.floor_report(|it| {
                out.push(BhFloorWeapon {
                    entity: it.ent as u32,
                    weapon: u32::from(it.weapon),
                    flags: u32::from(it.flags),
                    position: it.position,
                    angles: it.angles,
                })
            });
            if !count.is_null() {
                output(count, out.len())?;
            }
            if !out.is_empty() {
                p = out.as_ptr();
            }
            Ok(())
        })
    };
    p
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_overlay_json(ctx: *mut BhContext, count: *mut usize) -> *const c_char {
    let mut result = ptr::null();
    let _ = unsafe { output(count, 0) };
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            let data=m.game.overlay_brushes(&m.assets.texinfo_drawn).into_iter().map(|b|serde_json::json!({"kind":b.kind,"entity":b.entity,"model":b.model,"flags":b.flags,"planes":b.planes.into_iter().map(|(n,d)|[n[0],n[1],n[2],d]).collect::<Vec<_>>()})).collect::<Vec<_>>();
            m.assets.overlay =
                CString::new(serde_json::to_string(&data).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if !count.is_null() {
                output(count, m.assets.overlay.as_bytes().len())?;
            }
            result = m.assets.overlay.as_ptr();
            Ok(())
        })
    };
    result
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_overlay_states(ctx: *mut BhContext, count: *mut usize) -> *const u32 {
    let mut result = ptr::null();
    let _ = unsafe { output(count, 0) };
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            m.assets.overlay_states.clear();
            m.assets.overlay_states.extend(m.game.overlay_states());
            if !count.is_null() {
                output(count, m.assets.overlay_states.len())?;
            }
            result = m.assets.overlay_states.as_ptr();
            Ok(())
        })
    };
    result
}

/// Pairs of entity index and enabled flag. Valid until the next call on this context.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_effect_states(ctx: *mut BhContext, count: *mut usize) -> *const u32 {
    let mut result = ptr::null();
    let _ = unsafe { output(count, 0) };
    unsafe { call(ctx, |c| {
        let m = c.map()?;
        m.assets.effect_states.clear();
        for (entity, enabled) in m.game.effect_states() {
            m.assets.effect_states.extend([entity as u32, u32::from(enabled)]);
        }
        if !count.is_null() { output(count, m.assets.effect_states.len())?; }
        result = m.assets.effect_states.as_ptr();
        Ok(())
    }) };
    result
}

impl Map {
    pub(super) fn refresh_light_styles(&mut self) -> bool {
        let Some(styles)=self.assets.light_styles.as_mut() else {return false};
        let mut values=[256.0/264.0;64];
        for (i,p) in bunnyhop_core::lightmap::LIGHT_STYLE_PATTERNS.iter().enumerate(){values[i]=bunnyhop_core::lightmap::light_style_pattern(p);}
        values[63]=0.;
        let enabled=self.game.effect_states().into_iter().collect::<HashMap<_,_>>();
        for (index,e) in self.game.entities.iter().enumerate(){
            if !matches!(e.classname().to_ascii_lowercase().as_str(),"light"|"light_spot") {continue;}
            let style=e.int("style");if !(32..64).contains(&style)||e.get("targetname").is_none(){continue;}
            let preset=e.int("defaultstyle");let pattern=e.get("pattern").filter(|p|!p.is_empty()).unwrap_or_else(||bunnyhop_core::lightmap::LIGHT_STYLE_PATTERNS.get(preset.max(0) as usize).copied().unwrap_or("m"));
            let on=enabled.get(&index).copied().unwrap_or(e.int("spawnflags")&1==0);
            values[style as usize]=if on {bunnyhop_core::lightmap::light_style_pattern(pattern)} else {0.};
        }
        styles.apply(&mut self.mesh.lightmap,&values)
    }
}
/// Returns an updated atlas only when a switchable light changed. Zero means the caller keeps its texture.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_lightmap_update(ctx:*mut BhContext,out:*mut BhImage)->c_int {
    let mut changed=0;let status=unsafe { call(ctx,|c|{let m=c.map()?;if !m.refresh_light_styles(){return Ok(())}let a=&m.mesh.lightmap;output(out,BhImage{rgba:a.rgba.as_ptr(),byte_count:a.rgba.len(),width:a.width,height:a.height})?;changed=1;Ok(())}) };if status==0 {-1} else {changed}
}
