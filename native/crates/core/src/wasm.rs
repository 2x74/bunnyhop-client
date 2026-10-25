//! Raw C-ABI exports consumed by `apps/web/src/core.ts`.
//! Buffers are exposed as (ptr, len) pairs into linear memory and are valid until the next call that rebuilds them.

use crate::game::{Cmd, Game, Settings};
use crate::materials::{self, Materials};
use crate::mesh::{self, Mesh};
use crate::vfs::{Source, Vfs};
use std::cell::RefCell;

#[derive(Default)]
struct Ctx {
    game: Option<Game>,
    mesh: Option<Mesh>,
    vfs: Vfs,
    materials: Materials,
    tex_bytes: Vec<u8>,
    error: String,
    scratch_f32: Vec<f32>,
    scratch_u32: Vec<u32>,
    scratch_str: String,
    /// Per texinfo: drawn or not (`mesh::texinfo_drawn`), kept from the map load for `overlay_volumes`.
    texinfo_drawn: Vec<bool>,
}

thread_local! {
    static CTX: RefCell<Ctx> = RefCell::new(Ctx::default());
}

fn with<R>(f: impl FnOnce(&mut Ctx) -> R) -> R {
    CTX.with(|c| f(&mut c.borrow_mut()))
}

#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len)) };
}

/// Loads a BSP from `len` bytes at `ptr` (takes ownership). Returns 1 on success, 0 on error (see `error_ptr`).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub unsafe extern "C" fn load_map(ptr: *mut u8, len: usize) -> u32 {
    let bytes = unsafe { Vec::from_raw_parts(ptr, len, len) };
    with(|c| {
        c.game = None;
        c.mesh = None;
        c.vfs = Vfs::default();
        c.materials = Materials::default();
        // parse_bsp copies the bytes into the Bsp: free the input before building (lower peak memory).
        let parsed = crate::parse_bsp(&bytes);
        drop(bytes);
        let result = parsed.and_then(|bsp| {
            let game = Game::load_with_content(&bsp, content::loose_source())?;
            let mesh = mesh::build(&bsp);
            let pak = bsp.lump(playsrc_bsp::PAKFILE).map(|l| l.bytes(&bsp).to_vec()).unwrap_or_default();
            Ok((game, mesh, pak, mesh::texinfo_drawn(&bsp)))
        });
        match result {
            Ok((game, mesh, pak, drawn)) => {
                c.texinfo_drawn = drawn;
                c.vfs.mount(Source::from_zip("pak", pak));
                let names: Vec<String> = mesh.materials.iter().map(|m| m.name.clone()).collect();
                c.materials = materials::resolve(&c.vfs, &names);
                c.game = Some(game);
                c.mesh = Some(mesh);
                1
            }
            Err(e) => {
                c.error = e;
                0
            }
        }
    })
}

/// Like `load_map`, but only builds the simulation (collision, triggers, entities): no render mesh, pakfile or
/// materials. Used by the server-side verifier to keep memory within Worker limits. Same return convention.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub unsafe extern "C" fn load_map_physics(ptr: *mut u8, len: usize) -> u32 {
    let bytes = unsafe { Vec::from_raw_parts(ptr, len, len) };
    with(|c| {
        c.game = None;
        c.mesh = None;
        c.vfs = Vfs::default();
        c.materials = Materials::default();
        // parse_bsp copies the bytes into the Bsp: free the input before building (lower peak memory).
        let parsed = crate::parse_bsp(&bytes);
        drop(bytes);
        // The entity lump is parsed up front (outputs straight into the runtime form, without their key/value pairs)
        // and its decoded copy released before the build.
        let loaded = parsed.and_then(|mut bsp| {
            let entities = crate::physics::entity_list_with_outputs(&bsp, false);
            bsp.release_lump_payload(playsrc_bsp::ENTITIES);
            Game::load_with_entities(&bsp, content::loose_source(), entities, false)
        });
        match loaded {
            Ok(game) => {
                c.game = Some(game);
                1
            }
            Err(e) => {
                c.error = e;
                0
            }
        }
    })
}

#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn error_ptr() -> *const u8 {
    with(|c| c.error.as_ptr())
}

#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn error_len() -> usize {
    with(|c| c.error.len())
}

macro_rules! mesh_buf {
    ($ptr:ident, $len:ident, $field:ident, $ty:ty) => {
        #[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
        pub extern "C" fn $ptr() -> *const $ty {
            with(|c| c.mesh.as_ref().map_or(std::ptr::null(), |m| m.$field.as_ptr()))
        }
        #[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
        pub extern "C" fn $len() -> usize {
            with(|c| c.mesh.as_ref().map_or(0, |m| m.$field.len()))
        }
    };
}
mesh_buf!(mesh_vertices_ptr, mesh_vertices_len, vertices, f32);
mesh_buf!(mesh_indices_ptr, mesh_indices_len, indices, u32);
// Sky faces (positions only, `[x, y, z]`), drawn depth-only by the client so they hide what's behind them.
mesh_buf!(mesh_sky_vertices_ptr, mesh_sky_vertices_len, sky_vertices, f32);
mesh_buf!(mesh_sky_indices_ptr, mesh_sky_indices_len, sky_indices, u32);

/// Sky face groups as u32 triples in the scratch buffer: model, first_index, index_count (into `mesh_sky_indices`).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn mesh_sky_groups() -> usize {
    with(|c| {
        c.scratch_u32.clear();
        if let Some(m) = &c.mesh {
            c.scratch_u32.extend(m.sky_groups.iter().flatten());
        }
        c.scratch_u32.len()
    })
}

/// Per group (parallel to `mesh_groups`), 1 if it's in the 3D skybox set (drawn by the skybox pass, not the main
/// view; see `sky_camera`), into scratch_u32.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn mesh_group_sky3d() -> usize {
    with(|c| {
        c.scratch_u32.clear();
        if let Some(m) = &c.mesh {
            c.scratch_u32.extend(m.groups.iter().map(|g| g.sky3d as u32));
        }
        c.scratch_u32.len()
    })
}

/// The 3D skybox's `sky_camera` into scratch_f32 (`skybox.rs`); empty if the map has no usable 3D skybox:
/// [origin x, y, z, scale, area, fog enable, fog blend, fogcolor r, g, b, fogcolor2 r, g, b (0..255),
///  fog dir x, y, z, fog start, fog end, fog max density].
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn sky_camera() -> usize {
    with(|c| {
        c.scratch_f32.clear();
        if let Some(s) = c.mesh.as_ref().and_then(|m| m.sky_camera.as_ref()) {
            let f = &s.fog;
            c.scratch_f32.extend_from_slice(&s.origin);
            c.scratch_f32.extend_from_slice(&[s.scale, s.area as f32, f.enable as u32 as f32, f.blend as u32 as f32]);
            c.scratch_f32.extend_from_slice(&f.color);
            c.scratch_f32.extend_from_slice(&f.color2);
            c.scratch_f32.extend_from_slice(&f.dir);
            c.scratch_f32.extend_from_slice(&[f.start, f.end, f.max_density]);
        }
        c.scratch_f32.len()
    })
}

/// Groups as u32 quads: model, material, first_index, index_count.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn mesh_groups() -> usize {
    with(|c| {
        c.scratch_u32.clear();
        if let Some(m) = &c.mesh {
            for g in &m.groups {
                c.scratch_u32.extend_from_slice(&[g.model, g.material, g.first_index, g.index_count]);
            }
        }
        c.scratch_u32.len()
    })
}

#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn scratch_u32_ptr() -> *const u32 {
    with(|c| c.scratch_u32.as_ptr())
}

#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn scratch_f32_ptr() -> *const f32 {
    with(|c| c.scratch_f32.as_ptr())
}

#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn scratch_str_ptr() -> *const u8 {
    with(|c| c.scratch_str.as_ptr())
}

/// Materials as newline-separated `name width height` lines.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn mesh_materials() -> usize {
    with(|c| {
        c.scratch_str.clear();
        if let Some(m) = &c.mesh {
            for mat in &m.materials {
                c.scratch_str.push_str(&format!("{} {} {}\n", mat.name, mat.width, mat.height));
            }
        }
        c.scratch_str.len()
    })
}

/// Raw entity lump as `classname\tkey=value\t...` lines.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn entities_text() -> usize {
    with(|c| {
        c.scratch_str.clear();
        if let Some(g) = &c.game {
            for e in &g.entities {
                let line: Vec<String> = e.pairs.iter().map(|(k, v)| format!("{k}={v}")).collect();
                c.scratch_str.push_str(&line.join("\t"));
                c.scratch_str.push('\n');
            }
        }
        c.scratch_str.len()
    })
}

#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn pak_ptr() -> *const u8 {
    with(|c| c.vfs.source("pak").map_or(std::ptr::null(), |s| s.bytes().as_ptr()))
}

#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn pak_len() -> usize {
    with(|c| c.vfs.source("pak").map_or(0, |s| s.bytes().len()))
}

/// Resolved materials (parallel to `mesh_materials`) as newline-separated lines:
/// `kind flags texture alpha alpha_ref r g b shader`.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn material_info() -> usize {
    with(|c| {
        c.scratch_str.clear();
        for d in &c.materials.descs {
            let [r, g, b] = d.color;
            c.scratch_str.push_str(&format!(
                "{} {} {} {} {} {} {} {} {}\n",
                d.kind as u32, d.flags, d.texture, d.alpha, d.alpha_ref, r, g, b, d.shader
            ));
        }
        c.scratch_str.len()
    })
}

#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn texture_count() -> usize {
    with(|c| c.materials.textures.len())
}

/// Extracts texture `index` into `tex_bytes`. Header goes to scratch_u32 as
/// `[format, level_count, (width, height, offset, len) * level_count]`. Returns the header length, 0 on error.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn texture_payload(index: usize, allow_s3tc: u32, need_alpha: u32) -> usize {
    with(|c| {
        c.scratch_u32.clear();
        c.tex_bytes = Vec::new();
        let Some(path) = c.materials.textures.get(index) else { return 0 };
        let Some(bytes) = c.vfs.read(path) else { return 0 };
        let payload = match c.materials.rgbs.get(path) {
            Some(&color) => materials::texture_payload_rgbs(bytes, color),
            None => materials::texture_payload(bytes, allow_s3tc != 0, need_alpha != 0),
        };
        match payload {
            Ok(p) => {
                c.scratch_u32.extend_from_slice(&[p.format, p.levels.len() as u32]);
                for l in &p.levels {
                    c.scratch_u32.extend_from_slice(&[l.width, l.height, l.offset, l.len]);
                }
                c.tex_bytes = p.bytes;
                c.scratch_u32.len()
            }
            Err(e) => {
                c.error = format!("{path}: {e}");
                0
            }
        }
    })
}

#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn tex_bytes_ptr() -> *const u8 {
    with(|c| c.tex_bytes.as_ptr())
}

/// Lightmap atlas into scratch_u32 as `[width, height]`; pixels (RGBA8, sRGB-encoded) at `lightmap_ptr`.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn lightmap_size() -> usize {
    with(|c| {
        c.scratch_u32.clear();
        if let Some(m) = &c.mesh {
            c.scratch_u32.extend_from_slice(&[m.lightmap.width, m.lightmap.height]);
        }
        c.scratch_u32.len()
    })
}

#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn lightmap_ptr() -> *const u8 {
    with(|c| c.mesh.as_ref().map_or(std::ptr::null(), |m| m.lightmap.rgba.as_ptr()))
}

#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn set_settings(tick_interval: f32, air_accelerate: f32, accelerate: f32, friction: f32, stop_speed: f32, gravity: f32, max_speed: f32, autohop: u32) {
    with(|c| {
        if let Some(g) = c.game.as_mut() {
            // The physics version is set separately (`set_physics_version`) and kept here.
            let physics_version = g.settings.physics_version;
            g.set_settings(Settings { tick_interval, air_accelerate, accelerate, friction, stop_speed, gravity, max_speed, autohop: autohop != 0, stamina: false, physics_version });
        }
    })
}

/// Enable CS:S stamina independently of the legacy settings ABI.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn set_stamina(enabled: u32) {
    with(|c| {
        if let Some(g) = c.game.as_mut() {
            g.set_settings(Settings { stamina: enabled != 0, ..g.settings });
        }
    });
}

/// Selects the physics version (`game::PHYSICS_V1`, `PHYSICS_V2`, ...; a loaded map starts at v1). Call after
/// `load_map*` like `set_settings`; kept across `set_settings` and `reset`. Returns 1 if this build knows the version,
/// else 0 (nothing changes). Clients feature-detect the export (builds without it are v1 only).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn set_physics_version(version: u32) -> u32 {
    if crate::game::physics_fixes(version).is_none() {
        return 0;
    }
    with(|c| {
        if let Some(g) = c.game.as_mut() {
            g.set_settings(Settings { physics_version: version, ..g.settings });
        }
    });
    1
}

#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn reset() {
    with(|c| {
        if let Some(g) = c.game.as_mut() {
            g.reset();
        }
    })
}

/// Advances one tick. Returns event bits, or u32::MAX on error.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn step(forward: f32, side: f32, yaw: f32, pitch: f32, buttons: u32) -> u32 {
    with(|c| {
        let Some(g) = c.game.as_mut() else { return u32::MAX };
        match g.step(Cmd { forward, side, yaw, pitch, buttons }) {
            Ok(()) => g.events,
            Err(e) => {
                c.error = e;
                u32::MAX
            }
        }
    })
}

/// Player state into scratch_f32:
/// [pos x,y,z, vel x,y,z, view_offset_z, grounded, crouched, tick, teleport pitch, yaw, roll, movement mode,
///  view angle change pitch, yaw, roll (rotating pushers this tick; see EVENT_ANGLES_CHANGED),
///  touch pass x, y, z, crouched (where this tick's trigger touch pass after the move happened, before any
///  teleport it caused; NaN after a reset / respawn: `Game::touch_origin`), weapons held, active weapon
///  (WEAPON_* bits, physics v4: `Game::weapons`), clean movement tick for local jump stats]
/// (movement mode: playsrc `Mode` as a number; 6 = ladder. Style key filters exempt ladders, like bhoptimer.)
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn player_state() -> usize {
    with(|c| {
        c.scratch_f32.clear();
        if let Some(g) = &c.game {
            let s = &g.state;
            c.scratch_f32.extend_from_slice(&s.position);
            c.scratch_f32.extend_from_slice(&s.velocity);
            c.scratch_f32.push(s.view_offset[2]);
            c.scratch_f32.push(s.ground.is_some() as u32 as f32);
            c.scratch_f32.push(s.crouch.uses_crouched_hull() as u32 as f32);
            c.scratch_f32.push(g.tick as f32);
            c.scratch_f32.extend_from_slice(&g.teleport_angles);
            c.scratch_f32.push(s.mode as u8 as f32);
            c.scratch_f32.extend_from_slice(&g.view_angle_change);
            c.scratch_f32.extend_from_slice(&g.touch_origin);
            c.scratch_f32.push(g.touch_crouched as u32 as f32);
            let (weapons, active) = g.weapons();
            c.scratch_f32.push(f32::from(weapons));
            c.scratch_f32.push(f32::from(active));
            c.scratch_f32.push(g.jumpstats_valid as u32 as f32);
        }
        c.scratch_f32.len()
    })
}

/// Brush entity transforms into scratch_f32 as [model, x, y, z, pitch, yaw, roll] (7 floats each).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn brush_origins() -> usize {
    with(|c| {
        c.scratch_f32.clear();
        if let Some(g) = &c.game {
            for (model, o, a) in g.brush_transforms() {
                c.scratch_f32.extend_from_slice(&[model as f32, o[0], o[1], o[2], a[0], a[1], a[2]]);
            }
        }
        c.scratch_f32.len()
    })
}

/// Moving entity prop transforms (prop_door_rotating) into scratch_f32 as [entity, x, y, z, pitch, yaw, roll].
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn prop_transforms() -> usize {
    with(|c| {
        c.scratch_f32.clear();
        if let Some(g) = &c.game {
            for (i, o, a) in g.moving_prop_transforms() {
                c.scratch_f32.extend_from_slice(&[i as f32, o[0], o[1], o[2], a[0], a[1], a[2]]);
            }
        }
        c.scratch_f32.len()
    })
}

/// Factor the lightmap atlas was scaled by before sRGB encoding (multiply by its inverse after sampling).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn lightmap_scale() -> f32 {
    crate::lightmap::LIGHTMAP_SCALE
}

/// Floats per vertex in `mesh_vertices`.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn mesh_vertex_floats() -> usize {
    mesh::VERTEX_FLOATS
}

/// Overwrites the player velocity (used by the run timer's start-zone prespeed cap; replays apply it identically).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn set_velocity(x: f32, y: f32, z: f32) {
    with(|c| {
        if let Some(g) = c.game.as_mut() {
            g.state.velocity = [x, y, z];
        }
    })
}

// ---- bunnyhop entity/rules exports (appended; see game.rs) ----

/// Brush entity render/collision state into scratch_f32 as [model, visible, solid] triples
/// (killed/disabled func_brush, broken func_breakable, toggled func_wall_toggle, ...).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn brush_states() -> usize {
    with(|c| {
        c.scratch_f32.clear();
        if let Some(g) = &c.game {
            for (model, visible, solid) in g.brush_states() {
                c.scratch_f32.extend_from_slice(&[model as f32, visible as u32 as f32, solid as u32 as f32]);
            }
        }
        c.scratch_f32.len()
    })
}

/// Server rules: bhop_block_fix (0 = stock sinking doors, 1 = block fix), grace seconds before a
/// standing player is sent through the block's teleport, teleport_keeps_velocity (Source = 1).
/// Resets the map.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn set_rules(bhop_block_fix: u32, bhop_block_grace: f32, teleport_keeps_velocity: u32) {
    use crate::game::{BhopBlockMode, Rules};
    with(|c| {
        if let Some(g) = c.game.as_mut() {
            g.set_rules(Rules {
                bhop_blocks: if bhop_block_fix != 0 { BhopBlockMode::Fix } else { BhopBlockMode::Vanilla },
                bhop_block_grace: if bhop_block_grace.is_finite() { bhop_block_grace.max(0.0) } else { 0.1 },
                teleport_keeps_velocity: teleport_keeps_velocity != 0,
                ..g.rules
            });
        }
    })
}

/// Player extras into scratch_f32: [health, gravity_scale, speed_scale]; name via scratch_str.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn player_extras() -> usize {
    with(|c| {
        c.scratch_f32.clear();
        c.scratch_str.clear();
        if let Some(g) = &c.game {
            c.scratch_f32.extend_from_slice(&[g.health, g.gravity_scale, g.speed_scale]);
            c.scratch_str.push_str(&g.player_name);
        }
        c.scratch_f32.len()
    })
}

// ---- game content exports (user-mounted VPKs, fetched files, skybox, static props) ----
// A child module so it can use `with`/`Ctx` while living in its own file.
#[path = "wasm_content.rs"]
mod content;

// ---- animated studio models (CS:S player models) ----
#[path = "wasm_studio.rs"]
mod studio_exports;

// ---- physics round two exports (appended) ----

/// Restart point (start-zone restart): respawns the player at (x, y, z) feet facing `yaw` with zero
/// velocity, settled onto the floor below; deaths respawn there until the next `reset`. Call right
/// after `reset` (tick 0); replays store it in their header and re-apply it after reset.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn set_position(x: f32, y: f32, z: f32, yaw: f32) {
    with(|c| {
        if let Some(g) = c.game.as_mut() {
            g.set_position([x, y, z], yaw);
        }
    })
}

/// Names the player gets at the restart point (call after `set_position`): `name_len` bytes of targetname then
/// `class_len` bytes of classname (UTF-8; empty classname = "player") at `ptr` (from `alloc`; takes ownership).
/// See `Game::set_restart_names`.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub unsafe extern "C" fn set_restart_names(ptr: *mut u8, name_len: usize, class_len: usize) {
    let bytes = unsafe { Vec::from_raw_parts(ptr, name_len + class_len, name_len + class_len) };
    let name = String::from_utf8_lossy(&bytes[..name_len]);
    let class = String::from_utf8_lossy(&bytes[name_len..]);
    with(|c| {
        if let Some(g) = c.game.as_mut() {
            g.set_restart_names(&name, &class);
        }
    })
}

/// Restart point since the last reset into scratch_f32: [] if none, else [x, y, z, yaw] (settled).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn restart_point() -> usize {
    with(|c| {
        c.scratch_f32.clear();
        if let Some((p, yaw)) = c.game.as_ref().and_then(|g| g.restart_point()) {
            c.scratch_f32.extend_from_slice(&[p[0], p[1], p[2], yaw]);
        }
        c.scratch_f32.len()
    })
}

/// Optional movement rules as bit flags (all 0 = vanilla CS:S; see research/MOVEMENT_AUDIT.md):
/// bit0 downhill landing fix, bit1 uphill landing fix, bit2 rampbug fix, bit3 telehop fix,
/// bit4 DISABLE per-material surface properties. Resets the map.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn set_movement_rules(flags: u32) {
    with(|c| {
        if let Some(g) = c.game.as_mut() {
            let rules = crate::game::Rules {
                downhill_fix: flags & 1 != 0,
                uphill_fix: flags & 2 != 0,
                rampbug_fix: flags & 4 != 0,
                telehop_fix: flags & 8 != 0,
                surface_properties: flags & 16 == 0,
                ..g.rules
            };
            g.set_rules(rules);
        }
    })
}

/// Static/dynamic prop collision hulls as a triangle soup (9 floats per triangle, world space) into
/// scratch_f32. Props collide but their models are not rendered by the client; draw these so players
/// can see what they hit.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn prop_collision_mesh() -> usize {
    with(|c| {
        c.scratch_f32.clear();
        if let Some(g) = &c.game {
            c.scratch_f32.extend_from_slice(g.prop_collision_mesh());
        }
        c.scratch_f32.len()
    })
}

// ---- physics content (prop collision models; see Game::physics_files) ----

/// Collision files (`.phy` / `.mdl`) the loaded map's props need, newline-separated in scratch_str.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn physics_files() -> usize {
    with(|c| {
        c.scratch_str = c.game.as_ref().map(|g| g.physics_files().join("\n")).unwrap_or_default();
        c.scratch_str.len()
    })
}

/// Prop models still without collision (their files weren't available), newline-separated in scratch_str.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn physics_missing() -> usize {
    with(|c| {
        c.scratch_str = c.game.as_ref().map(|g| g.missing_prop_models().join("\n")).unwrap_or_default();
        c.scratch_str.len()
    })
}

/// Rebuilds prop collision from the pakfile and the files added since the map loaded (content_add_file /
/// fetched content), then resets the map. Call after hosted content arrived, before playing.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn physics_reload() {
    with(|c| {
        let Some(g) = c.game.as_mut() else { return };
        let mut fs = Vfs::default();
        let pak = c.vfs.unmount("pak");
        if let Some(p) = pak {
            fs.mount(p);
        }
        if let Some(src) = content::loose_source() {
            fs.mount(src);
        }
        g.rebuild_props(&fs);
        if let Some(p) = fs.unmount("pak") {
            c.vfs.mount_front(p);
        }
    })
}

// ---- replay viewer exports (appended): keyframe snapshots + camera traces ----

thread_local! {
    /// Keyframe captures by handle (index + 1); freed slots are reused.
    static SNAPSHOTS: RefCell<Vec<Option<crate::game::GameState>>> = const { RefCell::new(Vec::new()) };
}

/// Captures the full simulation state (player, brush entities/doors, triggers, entity I/O queue). Returns a
/// handle (>= 1) for `state_restore` / `state_free`, or 0 when no map is loaded.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn state_snapshot() -> u32 {
    let Some(s) = with(|c| c.game.as_ref().map(|g| g.save_state())) else { return 0 };
    SNAPSHOTS.with(|v| {
        let mut v = v.borrow_mut();
        match v.iter().position(Option::is_none) {
            Some(i) => {
                v[i] = Some(s);
                i as u32 + 1
            }
            None => {
                v.push(Some(s));
                v.len() as u32
            }
        }
    })
}

/// Restores a capture made with `state_snapshot` on the currently loaded map. Returns 1 on success, 0 for an
/// unknown handle or no map. Stepping afterwards is bit-identical to the run the capture was taken from.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn state_restore(handle: u32) -> u32 {
    SNAPSHOTS.with(|v| {
        let v = v.borrow();
        let Some(Some(s)) = v.get((handle as usize).wrapping_sub(1)) else { return 0 };
        with(|c| match c.game.as_mut() {
            Some(g) => {
                g.restore_state(s);
                1
            }
            None => 0,
        })
    })
}

/// Frees a capture (0 / unknown handles are ignored).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn state_free(handle: u32) {
    SNAPSHOTS.with(|v| {
        if let Some(slot) = v.borrow_mut().get_mut((handle as usize).wrapping_sub(1)) {
            *slot = None;
        }
    })
}

/// Approximate memory held by a capture in bytes (0 for unknown handles).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn state_snapshot_bytes(handle: u32) -> usize {
    SNAPSHOTS.with(|v| v.borrow().get((handle as usize).wrapping_sub(1)).and_then(|s| s.as_ref()).map_or(0, |s| s.approx_bytes()))
}

/// Camera collision: sweeps a cube of half-size `radius` from start to end (Source units) against the world,
/// props and solid brush entities (MASK_SOLID, player clips ignored). Returns the clear fraction 0..1
/// (1 = unobstructed); 1 when no map is loaded.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn trace_ray(sx: f32, sy: f32, sz: f32, ex: f32, ey: f32, ez: f32, radius: f32) -> f32 {
    with(|c| c.game.as_ref().map_or(1.0, |g| g.trace_camera([sx, sy, sz], [ex, ey, ez], radius)))
}

/// The player's attack this tick (after a step that returned EVENT_ATTACK) into scratch_f32:
/// [weapon (WEAPON_* bit), mode (1 primary, 2 secondary), hit (0/1), start x,y,z, end x,y,z, normal x,y,z,
///  entity index or -1]; empty when the last step had no attack.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn attack_report() -> usize {
    with(|c| {
        c.scratch_f32.clear();
        if let Some(a) = c.game.as_ref().and_then(|g| g.attack) {
            c.scratch_f32.extend_from_slice(&[f32::from(a.weapon), f32::from(a.mode), a.hit as u32 as f32]);
            c.scratch_f32.extend_from_slice(&a.start);
            c.scratch_f32.extend_from_slice(&a.end);
            c.scratch_f32.extend_from_slice(&a.normal);
            c.scratch_f32.push(a.entity as f32);
        }
        c.scratch_f32.len()
    })
}

/// The player's weapons into scratch_f32 (physics v4, research/WEAPONS.md): [flags of this tick (EVENT_WEAPON), active
/// id, primary id, secondary id, has knife, clip, clip size, reload ticks left, burst mode, floor items changed since
/// the last floor_weapons call (0/1), the USP's silencer on (v7), silencer attach / detach ticks left (v7)]; valid every
/// tick.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn weapon_report() -> usize {
    with(|c| {
        c.scratch_f32.clear();
        if let Some(g) = c.game.as_ref() {
            c.scratch_f32.extend_from_slice(&g.weapon_report());
        }
        c.scratch_f32.len()
    })
}

/// Every weapon_* item of the map into scratch_f32 as [entity, weapon id, flags, x, y, z, pitch, yaw, roll] (9 floats
/// each, entity order, present or not; flags FLOOR_* = present 1, picked up 2, spawned 4, dropped 8, removed 16, moved 32
/// since the previous call); research/WEAPONS.md "Floor weapons". No allocation once scratch_f32 has grown.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn floor_weapons() -> usize {
    with(|c| {
        let Ctx { game, scratch_f32: out, .. } = c;
        out.clear();
        if let Some(g) = game.as_mut() {
            g.floor_report(|it| {
                let [x, y, z] = it.position;
                let [p, yaw, r] = it.angles;
                out.extend_from_slice(&[it.ent as f32, f32::from(it.weapon), f32::from(it.flags), x, y, z, p, yaw, r]);
            });
        }
        out.len()
    })
}

// ---- practice mode exports (appended): noclip. Never used by replay re-simulation or the verifier ----

/// Practice noclip tick: the player at (x, y, z) with velocity (vx, vy, vz), no collision or trigger touches, while the
/// world runs one tick (`Game::practice_noclip_tick`). Returns the event bits (0 with no map).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn practice_noclip_tick(x: f32, y: f32, z: f32, vx: f32, vy: f32, vz: f32) -> u32 {
    with(|c| match c.game.as_mut() {
        Some(g) => {
            g.practice_noclip_tick([x, y, z], [vx, vy, vz]);
            g.events
        }
        None => 0,
    })
}

/// Leaves practice noclip at (x, y, z) keeping the velocity, finding free space near it along the view (yaw, pitch)
/// if the hull is stuck (`Game::practice_noclip_exit`). Returns 1 standing, 2 crouched, 0 stuck or no map.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn practice_noclip_exit(x: f32, y: f32, z: f32, vx: f32, vy: f32, vz: f32, yaw: f32, pitch: f32) -> u32 {
    with(|c| c.game.as_mut().map_or(0, |g| g.practice_noclip_exit([x, y, z], [vx, vy, vz], yaw, pitch)))
}

// ---- trigger / clip overlays (game/overlay.rs; read-only, never part of a step) ----

/// The volumes the client's trigger and clip overlays draw, into scratch_f32: per volume
/// [kind (OVERLAY_*), entity (-1: world), model (-1: planes already in world space), flags (OVERLAY_WHEN_HIDDEN),
///  plane count, then per plane normal x, y, z, distance]. Needs a full `load_map` (it tells drawn faces apart).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn overlay_volumes() -> usize {
    with(|c| {
        c.scratch_f32.clear();
        let Some(g) = &c.game else { return 0 };
        for b in g.overlay_brushes(&c.texinfo_drawn) {
            let index = |v: Option<usize>| v.map_or(-1.0, |i| i as f32);
            c.scratch_f32.extend_from_slice(&[b.kind as f32, index(b.entity), index(b.model), b.flags as f32, b.planes.len() as f32]);
            for (n, d) in b.planes {
                c.scratch_f32.extend_from_slice(&[n[0], n[1], n[2], d]);
            }
        }
        c.scratch_f32.len()
    })
}

/// Every entity's overlay state now (OVERLAY_STATE_* bits, `Game::overlay_state`) into scratch_u32, in entity order.
/// Works on a physics-only load too (the replay viewer's).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn overlay_states() -> usize {
    with(|c| {
        c.scratch_u32.clear();
        if let Some(g) = &c.game {
            c.scratch_u32.extend(g.overlay_states());
        }
        c.scratch_u32.len()
    })
}

// The opt-in native adapter owns a thread per session; canonical WASM exports stay unchanged.
#[cfg(all(feature = "native-web", not(target_arch = "wasm32")))]
#[path = "../../native-web/core.rs"]
pub mod native_web;
