//! Animated studio model exports (child of `wasm.rs`; see `crates/core/src/studio.rs` and
//! `apps/web/src/player/studio/`). Models are read through the current VFS (`content_resolve` rebuilds it), so the
//! host drives the same fetch loop as materials: `studio_load` returns 0 with pending requests until every file is there.

use super::with;
use crate::materials;
use crate::studio::{self, Load, StudioModel};
use std::cell::RefCell;

thread_local! {
    static MODELS: RefCell<Vec<StudioModel>> = const { RefCell::new(Vec::new()) };
}

unsafe fn owned_string(ptr: *mut u8, len: usize) -> String {
    if len == 0 {
        return String::new();
    }
    String::from_utf8_lossy(&unsafe { Vec::from_raw_parts(ptr, len, len) }).into_owned()
}

/// Loads a studio model (`models/....mdl`, takes ownership of the path) with its includes, VVD, VTX and
/// materials. Returns a handle (>= 1), or 0: files pending (`content_pending` non-empty; provide them, call
/// `content_resolve`, retry) or an error (`error_ptr`). Loading the same path again returns the same handle.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub unsafe extern "C" fn studio_load(path_ptr: *mut u8, path_len: usize) -> u32 {
    let path = crate::vfs::normalize(&unsafe { owned_string(path_ptr, path_len) });
    if let Some(h) = MODELS.with(|m| m.borrow().iter().position(|x| x.path == path)) {
        return h as u32 + 1;
    }
    with(|c| match studio::load(&c.vfs, &path) {
        Load::Ready(m) => MODELS.with(|ms| {
            let mut ms = ms.borrow_mut();
            ms.push(*m);
            ms.len() as u32
        }),
        Load::Missing => {
            c.error = format!("{path}: files pending");
            0
        }
        Load::Error(e) => {
            c.error = e;
            0
        }
    })
}

fn model<R>(h: u32, f: impl FnOnce(&StudioModel) -> R) -> Option<R> {
    MODELS.with(|m| m.borrow().get((h as usize).wrapping_sub(1)).map(f))
}

/// Model metadata JSON into scratch_str; returns its length (0 = bad handle).
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn studio_info(h: u32) -> usize {
    let json = model(h, |m| m.info_json()).unwrap_or_default();
    with(|c| {
        c.scratch_str = json;
        c.scratch_str.len()
    })
}

/// Skinned mesh vertices into scratch_f32 (`STUDIO_VERTEX_FLOATS` per vertex); returns the float count.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn studio_vertices(h: u32) -> usize {
    let v = model(h, |m| m.mesh.vertices.clone()).unwrap_or_default();
    with(|c| {
        c.scratch_f32 = v;
        c.scratch_f32.len()
    })
}

/// Triangle indices into scratch_u32 (groups are in the info JSON); returns the count.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn studio_indices(h: u32) -> usize {
    let v = model(h, |m| m.mesh.indices.clone()).unwrap_or_default();
    with(|c| {
        c.scratch_u32 = v;
        c.scratch_u32.len()
    })
}

/// Decoded animation `anim` (all frames, `frames * bones * 7` floats: quat xyzw + pos) into scratch_f32.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub extern "C" fn studio_anim(h: u32, anim: u32) -> usize {
    let v = model(h, |m| m.decode_anim(anim as usize)).flatten().unwrap_or_default();
    with(|c| {
        c.scratch_f32 = v;
        c.scratch_f32.len()
    })
}

/// Texture payload of a VTF by game path (takes ownership of the path): same output as `texture_payload`.
#[cfg_attr(all(feature = "native-web", not(target_arch = "wasm32")), bunnyhop_native_web_macros::unwind)] #[unsafe(no_mangle)]
pub unsafe extern "C" fn texture_payload_path(path_ptr: *mut u8, path_len: usize, allow_s3tc: u32, need_alpha: u32) -> usize {
    let path = unsafe { owned_string(path_ptr, path_len) };
    with(|c| {
        c.scratch_u32.clear();
        c.tex_bytes = Vec::new();
        let Some(bytes) = c.vfs.read(&path) else {
            c.error = format!("{path}: not loaded");
            return 0;
        };
        match materials::texture_payload(bytes, allow_s3tc != 0, need_alpha != 0) {
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

#[cfg(all(feature = "native-web", not(target_arch = "wasm32")))]
pub(super) fn native_clear_models() {
    MODELS.with(|m| *m.borrow_mut() = Vec::new());
}
