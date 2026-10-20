//! Game content exports (child of `wasm.rs`): user-mounted VPKs, fetched files, extra materials.
//!
//! Mounts and fetched files persist across `load_map`. `content_resolve` re-mounts them behind
//! the current map's pakfile and re-resolves materials; the host then supplies any pending
//! file bytes (`content_provide`) and resolves again until nothing is pending.
//! See `apps/web/src/content/resolve.ts` for the driving loop.

use super::{with, Source, Vfs};
use crate::materials;
use crate::vfs::{normalize, Listing, VpkMount, ARCHIVE_LISTING};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

#[derive(Default)]
struct Content {
    /// Remote sources in search order.
    vpks: Vec<Rc<VpkMount>>,
    listings: Vec<Rc<Listing>>,
    /// Bytes already fetched from (or restored for) remote sources.
    loose: HashMap<String, Rc<[u8]>>,
    /// Per-map material overrides (normalised material name -> replacement material name), applied by
    /// `content_resolve` before any lookup, so they win over the pakfile. Rendering only: the simulation reads
    /// surface properties from the BSP's own VFS (physics.rs), which never sees these.
    overrides: HashMap<String, String>,
}

thread_local! {
    static CONTENT: RefCell<Content> = RefCell::new(Content::default());
}

unsafe fn owned(ptr: *mut u8, len: usize) -> Vec<u8> {
    if len == 0 {
        // JS passes a zero-length allocation; nothing to take ownership of beyond the capacity-0 vec.
        return Vec::new();
    }
    unsafe { Vec::from_raw_parts(ptr, len, len) }
}

unsafe fn owned_string(ptr: *mut u8, len: usize) -> String {
    String::from_utf8_lossy(&unsafe { owned(ptr, len) }).into_owned()
}

/// Mounts a `_dir.vpk` tree (takes ownership of both buffers). `name` is e.g. `cstrike/cstrike_pak_dir.vpk`;
/// a mount with the same name is replaced. Mount order is search order. Returns the entry count, 0 on error.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub unsafe extern "C" fn content_mount_vpk(name_ptr: *mut u8, name_len: usize, dir_ptr: *mut u8, dir_len: usize) -> usize {
    let name = unsafe { owned_string(name_ptr, name_len) };
    let dir = unsafe { owned(dir_ptr, dir_len) };
    match VpkMount::parse(&name, &dir) {
        Ok(m) => {
            let n = m.len().max(1);
            let m = Rc::new(m);
            CONTENT.with(|k| {
                let mut k = k.borrow_mut();
                match k.vpks.iter().position(|v| v.name == name) {
                    Some(i) => k.vpks[i] = m,
                    None => k.vpks.push(m),
                }
            });
            n
        }
        Err(e) => with(|c| {
            c.error = e;
            0
        }),
    }
}

/// Mounts a listing of fetchable paths (newline-separated; takes ownership). Searched after all VPKs.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub unsafe extern "C" fn content_mount_listing(name_ptr: *mut u8, name_len: usize, text_ptr: *mut u8, text_len: usize) -> usize {
    let name = unsafe { owned_string(name_ptr, name_len) };
    let text = unsafe { owned_string(text_ptr, text_len) };
    let listing = Listing::new(&name, text.lines().filter(|l| !l.is_empty()).map(str::to_string));
    let n = listing.paths.len();
    CONTENT.with(|k| {
        let mut k = k.borrow_mut();
        k.listings.retain(|l| l.name != name);
        k.listings.push(Rc::new(listing));
    });
    n
}

/// Fetched / added files as a VFS source (for the simulation's prop collision models).
pub(super) fn loose_source() -> Option<Source> {
    CONTENT.with(|k| {
        let k = k.borrow();
        (!k.loose.is_empty()).then(|| Source::loose("content", k.loose.clone()))
    })
}

/// Drops all VPK mounts and listings (fetched files are kept).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn content_unmount_all() {
    CONTENT.with(|k| {
        let mut k = k.borrow_mut();
        k.vpks.clear();
        k.listings.clear();
    });
}

/// Adds a file whose bytes are already known (e.g. restored from the browser cache). Takes ownership.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub unsafe extern "C" fn content_add_file(path_ptr: *mut u8, path_len: usize, data_ptr: *mut u8, data_len: usize) {
    let path = normalize(&unsafe { owned_string(path_ptr, path_len) });
    let data = unsafe { owned(data_ptr, data_len) };
    CONTENT.with(|k| k.borrow_mut().loose.insert(path, data.into()));
}

/// Replaces the material overrides (takes ownership): `from\tto` lines, material names without `materials/` or `.vmt`
/// (`you/miku1\tconcrete/concretewall004a`). Material `from` then resolves as `to` (its VMT and textures, searched
/// pakfile -> fetched files -> mounts as usual) while keeping its slot, so the mesh is unchanged. An empty text clears
/// them. Returns the number of overrides.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub unsafe extern "C" fn content_material_overrides(text_ptr: *mut u8, text_len: usize) -> usize {
    let text = unsafe { owned_string(text_ptr, text_len) };
    let map: HashMap<String, String> = text
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(from, to)| (normalize(from), normalize(to)))
        .filter(|(from, to)| !from.is_empty() && !to.is_empty())
        .collect();
    let n = map.len();
    CONTENT.with(|k| k.borrow_mut().overrides = map);
    n
}

/// Supplies the bytes for a pending request of the last `content_resolve` (takes ownership): the
/// archive chunk `(archive, offset, length)` for VPK requests, the whole file for listings. VPK data
/// is joined with its directory preload bytes and CRC-checked. Returns 1 on success, 0 on error.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub unsafe extern "C" fn content_provide(path_ptr: *mut u8, path_len: usize, data_ptr: *mut u8, data_len: usize) -> u32 {
    let path = normalize(&unsafe { owned_string(path_ptr, path_len) });
    let data = unsafe { owned(data_ptr, data_len) };
    with(|c| {
        let Some(req) = c.vfs.pending().into_iter().find(|r| r.path == path) else {
            c.error = format!("{path}: not pending");
            return 0;
        };
        CONTENT.with(|k| {
            let mut k = k.borrow_mut();
            let bytes = if req.archive == ARCHIVE_LISTING {
                Ok(data)
            } else {
                match k.vpks.iter().find(|m| m.name == req.mount) {
                    Some(m) => m.assemble(&path, &data),
                    None => Err(format!("{path}: {} not mounted", req.mount)),
                }
            };
            match bytes {
                Ok(b) => {
                    k.loose.insert(path, b.into());
                    1
                }
                Err(e) => {
                    c.error = e;
                    0
                }
            }
        })
    })
}

/// Copies a fetched file's assembled bytes into `tex_bytes` (for host-side caching). Returns its
/// length; 0 if unknown or empty.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub unsafe extern "C" fn content_file(path_ptr: *mut u8, path_len: usize) -> usize {
    let path = normalize(&unsafe { owned_string(path_ptr, path_len) });
    let bytes = CONTENT.with(|k| k.borrow().loose.get(&path).map(|b| b.to_vec()));
    with(|c| {
        c.tex_bytes = bytes.unwrap_or_default();
        c.tex_bytes.len()
    })
}

/// Re-resolves the current map's materials against pakfile → fetched files → VPKs → listings (overridden materials,
/// see `content_material_overrides`, resolve as their replacement).
/// `extra` (newline-separated material names, e.g. skybox faces; takes ownership) are resolved after
/// the mesh materials and appended to `material_info`/`material_extras`. Pending requests are listed in
/// scratch_str as `path\tmount\tarchive\toffset\tlength` lines; returns that text's length (0 = done).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub unsafe extern "C" fn content_resolve(extra_ptr: *mut u8, extra_len: usize) -> usize {
    let extra = unsafe { owned_string(extra_ptr, extra_len) };
    with(|c| {
        c.scratch_str.clear();
        // Without a map (e.g. a content-only instance for player models) only `extra` is resolved.
        let mesh_names: Vec<String> = c.mesh.as_ref().map(|m| m.materials.iter().map(|m| m.name.clone()).collect()).unwrap_or_default();
        let mut vfs = Vfs::default();
        if let Some(pak) = c.vfs.unmount("pak") {
            vfs.mount(pak);
        }
        CONTENT.with(|k| {
            let k = k.borrow();
            vfs.mount(Source::loose("content", k.loose.clone()));
            for m in &k.vpks {
                vfs.mount(Source::vpk(m.clone()));
            }
            for l in &k.listings {
                vfs.mount(Source::listing(l.clone()));
            }
        });
        let mut names = mesh_names;
        names.extend(extra.lines().filter(|l| !l.is_empty()).map(str::to_string));
        CONTENT.with(|k| {
            let k = k.borrow();
            for n in names.iter_mut() {
                if let Some(to) = k.overrides.get(&normalize(n)) {
                    *n = to.clone();
                }
            }
        });
        c.materials = materials::resolve(&vfs, &names);
        let pending = vfs.pending();
        for r in &pending {
            c.scratch_str.push_str(&format!("{}\t{}\t{}\t{}\t{}\n", r.path, r.mount, r.archive, r.offset, r.length));
        }
        c.vfs = vfs;
        c.scratch_str.len()
    })
}

/// Resolved texture paths (index = texture id in `material_info`), newline-separated in scratch_str.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn texture_paths() -> usize {
    with(|c| {
        c.scratch_str = c.materials.textures.join("\n");
        c.scratch_str.len()
    })
}

/// Per resolved material, 4 floats in scratch_f32: `[texture2, detail, detail_scale, detail_blend]`.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn material_extras() -> usize {
    with(|c| {
        c.scratch_f32.clear();
        for d in &c.materials.descs {
            c.scratch_f32.extend_from_slice(&[d.texture2 as f32, d.detail as f32, d.detail_scale, d.detail_blend]);
        }
        c.scratch_f32.len()
    })
}

/// Per resolved material, 4 floats in scratch_f32: `[fog_start, fog_end, above_water (0/1), 0]` (water materials).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn material_water() -> usize {
    with(|c| {
        c.scratch_f32.clear();
        for d in &c.materials.descs {
            c.scratch_f32.extend_from_slice(&[d.fog_start, d.fog_end, d.above_water as u32 as f32, 0.0]);
        }
        c.scratch_f32.len()
    })
}

/// Water volumes of the loaded map, 6 floats each in scratch_f32: `[minx, miny, minz, maxx, maxy, maxz]` (Source space).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn water_volumes() -> usize {
    with(|c| {
        c.scratch_f32 = c.mesh.as_ref().map(|m| m.water.iter().flatten().copied().collect()).unwrap_or_default();
        c.scratch_f32.len()
    })
}

/// Matching water-box clipping planes, packed as count then count * [nx, ny, nz, distance].
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn water_planes() -> usize {
    with(|c| {
        c.scratch_f32.clear();
        if let Some(mesh) = &c.mesh {
            for planes in &mesh.water_planes {
                c.scratch_f32.push(planes.len() as f32);
                c.scratch_f32.extend(planes.iter().flatten().copied());
            }
        }
        c.scratch_f32.len()
    })
}

// ---- generic file access (models etc.) ----

/// Reads a file through the current VFS (pakfile → fetched → mounts; rebuilt by `content_resolve`).
/// Returns 1 with the bytes in `tex_bytes` (`tex_bytes_len`), or 0; a hit in a mount records a
/// pending request (see `content_pending`).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub unsafe extern "C" fn content_read(path_ptr: *mut u8, path_len: usize) -> u32 {
    let path = unsafe { owned_string(path_ptr, path_len) };
    with(|c| match c.vfs.read(&path).map(<[u8]>::to_vec) {
        Some(b) => {
            c.tex_bytes = b;
            1
        }
        None => 0,
    })
}

#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn tex_bytes_len() -> usize {
    with(|c| c.tex_bytes.len())
}

/// Pending requests of the current VFS (same format as `content_resolve`); returns the text length.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn content_pending() -> usize {
    with(|c| {
        c.scratch_str.clear();
        for r in c.vfs.pending() {
            c.scratch_str.push_str(&format!("{}\t{}\t{}\t{}\t{}\n", r.path, r.mount, r.archive, r.offset, r.length));
        }
        c.scratch_str.len()
    })
}

/// Paths in the mounted VPKs starting with `prefix` (newline-separated in scratch_str).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub unsafe extern "C" fn content_list(prefix_ptr: *mut u8, prefix_len: usize) -> usize {
    let prefix = normalize(&unsafe { owned_string(prefix_ptr, prefix_len) });
    let mut paths: Vec<String> = CONTENT.with(|k| k.borrow().vpks.iter().flat_map(|m| m.paths().filter(|p| p.starts_with(&prefix)).map(str::to_string).collect::<Vec<_>>()).collect());
    paths.sort();
    paths.dedup();
    with(|c| {
        c.scratch_str = paths.join("\n");
        c.scratch_str.len()
    })
}

/// Material names a studio model uses (one per MDL texture, `$cdmaterials` resolved against the VFS),
/// newline-separated in scratch_str. 0 if the MDL isn't available (requested if it's in a mount).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub unsafe extern "C" fn model_materials(path_ptr: *mut u8, path_len: usize) -> usize {
    let path = unsafe { owned_string(path_ptr, path_len) };
    with(|c| {
        c.scratch_str.clear();
        let Some(tex) = c.vfs.read(&path).and_then(crate::props::mdl_textures) else { return 0 };
        c.scratch_str = crate::props::model_material_names(&c.vfs, &tex).join("\n");
        c.scratch_str.len()
    })
}

// ---- static props ----

thread_local! {
    static PROPS: RefCell<(crate::props::StaticProps, crate::props::PropMesh)> = RefCell::new(Default::default());
}

/// Parses the static prop lump of a BSP (bytes copied in; ownership taken). Model paths (dictionary)
/// go to scratch_str, newline-separated; returns that text's length.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub unsafe extern "C" fn props_load(ptr: *mut u8, len: usize) -> usize {
    let bytes = unsafe { owned(ptr, len) };
    let bsp = crate::parse_bsp(&bytes).ok();
    let mut sp = bsp.as_ref().map(crate::props::static_props).unwrap_or_default();
    let n_static = sp.props.len();
    // Entity props (physics props at their settled pose, prop_dynamic, prop_door_rotating) render with them.
    if let Some(list) = with(|c| c.game.as_ref().map(|g| g.render_props())) {
        crate::props::add_props(&mut sp, list);
    }
    if let Some(bsp) = &bsp {
        crate::skybox::mark_props(bsp, &mut sp, n_static);
    }
    let models = sp.models.join("\n");
    PROPS.with(|p| *p.borrow_mut() = (sp, Default::default()));
    with(|c| {
        c.scratch_str = models;
        c.scratch_str.len()
    })
}

/// Builds the prop mesh from the loaded props and the current VFS. Material names go to scratch_str
/// (newline-separated); returns that text's length. Models whose files aren't loaded are skipped (and requested).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn props_build() -> usize {
    with(|c| {
        PROPS.with(|p| {
            let mut p = p.borrow_mut();
            let mesh = crate::props::build(&p.0, &c.vfs);
            c.scratch_str = mesh.materials.join("\n");
            p.1 = mesh;
            c.scratch_str.len()
        })
    })
}

/// Prop mesh stats into scratch_u32: `[instances, built models, missing models, vertex floats, indices, groups]`;
/// missing model paths in scratch_str.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn props_info() -> usize {
    with(|c| {
        PROPS.with(|p| {
            let p = p.borrow();
            c.scratch_u32 = vec![
                p.1.instances as u32,
                (p.0.models.len() - p.1.missing_models.len()) as u32,
                p.1.missing_models.len() as u32,
                p.1.vertices.len() as u32,
                p.1.indices.len() as u32,
                p.1.groups.len() as u32,
            ];
            c.scratch_str = p.1.missing_models.join("\n");
            c.scratch_u32.len()
        })
    })
}

/// Moving prop groups (prop_door_rotating) into scratch_u32 as `[entity, material, first_index, index_count]`
/// quads; their vertices are in model space, placed every frame by `prop_transforms`.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn props_dynamic_groups() -> usize {
    with(|c| {
        PROPS.with(|p| {
            c.scratch_u32 = p.borrow().1.dynamic_groups.iter().flatten().copied().collect();
            c.scratch_u32.len()
        })
    })
}

/// Prop groups into scratch_u32 as `[material, first_index, index_count]` triples.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn props_groups() -> usize {
    with(|c| {
        PROPS.with(|p| {
            c.scratch_u32 = p.borrow().1.groups.iter().flatten().copied().collect();
            c.scratch_u32.len()
        })
    })
}

/// Per prop group (parallel to `props_groups`), 1 if it's in the 3D skybox set (drawn by the skybox pass, see
/// `sky_camera`), into scratch_u32.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn props_group_sky3d() -> usize {
    with(|c| {
        PROPS.with(|p| {
            c.scratch_u32 = p.borrow().1.group_sky3d.iter().map(|&s| s as u32).collect();
            c.scratch_u32.len()
        })
    })
}

#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn props_vertices_ptr() -> *const f32 {
    PROPS.with(|p| p.borrow().1.vertices.as_ptr())
}

#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn props_indices_ptr() -> *const u32 {
    PROPS.with(|p| p.borrow().1.indices.as_ptr())
}

/// Per mesh vertex, the displacement blend alpha (0 = `$basetexture`, 1 = `$basetexture2`).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn mesh_blend_ptr() -> *const f32 {
    with(|c| c.mesh.as_ref().map_or(std::ptr::null(), |m| m.blend.as_ptr()))
}

#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn mesh_blend_len() -> usize {
    with(|c| c.mesh.as_ref().map_or(0, |m| m.blend.len()))
}

#[cfg(all(feature = "native-web", not(target_arch = "wasm32")))]
pub(super) fn native_prop_vertices() -> Vec<f32> {
    PROPS.with(|p| p.borrow().1.vertices.clone())
}

#[cfg(all(feature = "native-web", not(target_arch = "wasm32")))]
pub(super) fn native_prop_indices() -> Vec<u32> {
    PROPS.with(|p| p.borrow().1.indices.clone())
}

#[cfg(all(feature = "native-web", not(target_arch = "wasm32")))]
pub(super) fn native_clear_map() {
    PROPS.with(|p| *p.borrow_mut() = Default::default());
    CONTENT.with(|c| c.borrow_mut().overrides.clear());
}

#[cfg(all(feature = "native-web", not(target_arch = "wasm32")))]
pub(super) fn native_clear_all() {
    native_clear_map();
    CONTENT.with(|c| *c.borrow_mut() = Content::default());
}
