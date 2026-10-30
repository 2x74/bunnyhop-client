//! Animated studio models (the CS:S player models and their weapons): skeleton, skinned LOD-0 mesh, attachments,
//! pose parameters, sequences and decoded animations, including `$includemodel` animation models
//! (`models/player/cs_player_shared.mdl`), merged into one "virtual model" the way the engine does it.
//!
//! Extends the rigid static prop reader in `props.rs` (MDL v44-v49 + VVD + DX90 VTX). Files are read through
//! the `Vfs`, so a file that lives in a mount records a pending request and `load` returns `Missing` until the
//! host has supplied it (the same resolve loop as materials, `apps/web/src/content/resolve.ts`).
//!
//! Layouts follow the public Source SDK 2013 `studio.h` (`studiohdr_t`, `mstudiobone_t`, `mstudioseqdesc_t`,
//! `mstudioanimdesc_t`, `mstudioanim_t`, `mstudioautolayer_t`) and `vertexdata`/`optimize.h` for VVD/VTX;
//! animation decoding follows `bone_setup.cpp` `CalcBoneQuaternion`/`CalcBonePosition`/`ExtractAnimValue`.
//! Sampling and blending (frames, pose parameters, layers) happens on the client (`apps/web/src/player/studio/`).

use crate::materials::{vmt_params, vtf_path};
use crate::props::{mdl_textures, model_geometry, model_material_names, MdlTextures};
use crate::vfs::{normalize, Vfs};
use std::collections::HashMap;
use std::fmt::Write as _;

// ---------------------------------------------------------------------------
// Little-endian readers.

fn i32_at(b: &[u8], o: usize) -> Option<i32> {
    Some(i32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?))
}
fn i16_at(b: &[u8], o: usize) -> Option<i16> {
    Some(i16::from_le_bytes(b.get(o..o + 2)?.try_into().ok()?))
}
fn u16_at(b: &[u8], o: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(o..o + 2)?.try_into().ok()?))
}
fn u32_at(b: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?))
}
fn f32_at(b: &[u8], o: usize) -> Option<f32> {
    Some(f32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?))
}
fn count(b: &[u8], o: usize) -> Option<usize> {
    usize::try_from(i32_at(b, o)?).ok()
}
fn vec3(b: &[u8], o: usize) -> Option<[f32; 3]> {
    Some([f32_at(b, o)?, f32_at(b, o + 4)?, f32_at(b, o + 8)?])
}
fn vec4(b: &[u8], o: usize) -> Option<[f32; 4]> {
    Some([f32_at(b, o)?, f32_at(b, o + 4)?, f32_at(b, o + 8)?, f32_at(b, o + 12)?])
}
fn mat34(b: &[u8], o: usize) -> Option<[f32; 12]> {
    let mut m = [0.0; 12];
    for (i, v) in m.iter_mut().enumerate() {
        *v = f32_at(b, o + i * 4)?;
    }
    Some(m)
}
/// NUL-terminated string at `base + rel` (studio string offsets are relative to their struct).
fn rstr(b: &[u8], base: usize, rel: i32) -> Option<String> {
    let o = base.checked_add_signed(rel as isize)?;
    let rest = b.get(o..)?;
    let end = rest.iter().position(|&c| c == 0)?;
    Some(String::from_utf8_lossy(&rest[..end]).into_owned())
}

// ---------------------------------------------------------------------------
// Studio flags (studio.h).

/// `mstudioseqdesc_t::flags` / `mstudioanimdesc_t::flags`.
pub const STUDIO_LOOPING: i32 = 0x0001;
pub const STUDIO_SNAP: i32 = 0x0002;
pub const STUDIO_DELTA: i32 = 0x0004;
pub const STUDIO_AUTOPLAY: i32 = 0x0008;
pub const STUDIO_POST: i32 = 0x0010;
pub const STUDIO_ALLZEROS: i32 = 0x0020;
pub const STUDIO_OVERRIDE: i32 = 0x0800;
/// `mstudioanim_t::flags`.
const ANIM_RAWPOS: u8 = 0x01;
const ANIM_RAWROT: u8 = 0x02;
const ANIM_ANIMPOS: u8 = 0x04;
const ANIM_ANIMROT: u8 = 0x08;
const ANIM_DELTA: u8 = 0x10;
const ANIM_RAWROT2: u8 = 0x20;
/// `mstudiobone_t::flags`.
const BONE_FIXED_ALIGNMENT: i32 = 0x0010_0000;
/// `mstudiobone_t::proctype`.
const PROC_QUATINTERP: i32 = 2;

const BONE_BYTES: usize = 216;
const ANIMDESC_BYTES: usize = 100;
const SEQDESC_BYTES: usize = 212;
const ATTACHMENT_BYTES: usize = 92;
const POSEPARAM_BYTES: usize = 20;
const AUTOLAYER_BYTES: usize = 24;

// ---------------------------------------------------------------------------
// Model data.

#[derive(Clone, Debug)]
pub struct Bone {
    pub name: String,
    pub parent: i32,
    pub pos: [f32; 3],
    pub quat: [f32; 4],
    pub rot: [f32; 3],
    pub pos_scale: [f32; 3],
    pub rot_scale: [f32; 3],
    /// Bind pose inverse (model space -> bone space), 3x4 row-major.
    pub pose_to_bone: [f32; 12],
    pub alignment: [f32; 4],
    pub flags: i32,
    /// `$proceduralbones` quaternion interpolation helper (Ulna / Wrist twist bones), if any.
    pub quat_interp: Option<QuatInterp>,
}

/// `mstudioquatinterpbone_t`: the helper bone's local rotation/position is a weighted blend of trigger poses,
/// chosen by how close the control bone's local rotation is to each trigger.
#[derive(Clone, Debug)]
pub struct QuatInterp {
    pub control: i32,
    pub triggers: Vec<QuatTrigger>,
}

#[derive(Clone, Debug)]
pub struct QuatTrigger {
    pub inv_tolerance: f32,
    pub trigger: [f32; 4],
    pub pos: [f32; 3],
    pub quat: [f32; 4],
}

#[derive(Clone, Debug)]
pub struct Attachment {
    pub name: String,
    pub bone: usize,
    pub local: [f32; 12],
}

#[derive(Clone, Debug)]
pub struct PoseParam {
    pub name: String,
    pub flags: i32,
    pub start: f32,
    pub end: f32,
    pub looping: f32,
}

#[derive(Clone, Debug)]
pub struct AutoLayer {
    /// Global sequence index (virtual model), or -1.
    pub seq: i32,
    /// Global pose parameter index (STUDIO_AL_POSE), or -1.
    pub pose: i32,
    pub flags: i32,
    pub start: f32,
    pub peak: f32,
    pub tail: f32,
    pub end: f32,
}

#[derive(Clone, Debug)]
pub struct Sequence {
    pub name: String,
    pub activity: String,
    pub act_weight: i32,
    pub flags: i32,
    pub fade_in: f32,
    pub fade_out: f32,
    /// Blend grid size (columns = param 0, rows = param 1).
    pub group_size: [usize; 2],
    /// Global pose parameter index per blend axis (or -1).
    pub params: [i32; 2],
    pub param_start: [f32; 2],
    pub param_end: [f32; 2],
    /// Global animation indices, `group_size[0] * group_size[1]`, row-major (index = row * cols + col).
    pub anims: Vec<usize>,
    pub autolayers: Vec<AutoLayer>,
    /// Per main-model bone weight (`$weightlist`), 0 for bones the sequence's model doesn't have.
    pub weights: Vec<f32>,
    /// Pose keys (`posekeyindex`): `group_size[0] + group_size[1]` values, or empty.
    pub pose_keys: Vec<f32>,
}

#[derive(Clone, Debug)]
pub struct AnimDesc {
    pub name: String,
    pub fps: f32,
    pub flags: i32,
    pub frames: usize,
    /// Model (0 = main, 1.. = include models) the data lives in.
    group: usize,
    desc_offset: usize,
    data_offset: i32,
    section_frames: usize,
    sections: Vec<(i32, i32)>,
}

/// One material (MDL texture), with what the client needs to render it.
#[derive(Clone, Debug, Default)]
pub struct StudioMaterial {
    pub name: String,
    pub shader: String,
    pub base: Option<String>,
    pub bump: Option<String>,
    pub translucent: bool,
    pub alphatest: bool,
    pub alpha_ref: f32,
    pub nocull: bool,
    pub additive: bool,
    pub selfillum: bool,
    /// `$basealphaenvmapmask` / `$normalmapalphaenvmapmask` etc. are ignored; `$phong` is reported for shading.
    pub phong: bool,
    pub phong_exponent: f32,
    pub phong_boost: f32,
}

/// Skinned LOD-0 mesh in model space (Source axes: x forward, y left, z up).
#[derive(Default, Clone)]
pub struct SkinnedMesh {
    /// Per vertex: pos3 normal3 uv2 tangent4 weights3 bones3 (bone indices as floats) = 18 floats.
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
    /// `[material (texture index after skin family 0), first index, index count]`.
    pub groups: Vec<[u32; 3]>,
}

pub const STUDIO_VERTEX_FLOATS: usize = 18;

struct Group {
    bytes: Vec<u8>,
    /// Group bone -> main bone (-1 = not in the main model).
    bone_map: Vec<i32>,
    bones: Vec<Bone>,
}

pub struct StudioModel {
    pub path: String,
    pub name: String,
    pub version: i32,
    pub eye_position: [f32; 3],
    pub hull: [[f32; 3]; 2],
    pub bones: Vec<Bone>,
    pub attachments: Vec<Attachment>,
    pub pose_params: Vec<PoseParam>,
    pub seqs: Vec<Sequence>,
    pub anims: Vec<AnimDesc>,
    pub includes: Vec<String>,
    pub mesh: SkinnedMesh,
    pub materials: Vec<StudioMaterial>,
    groups: Vec<Group>,
}

pub enum Load {
    Ready(Box<StudioModel>),
    /// Some files are still being fetched (pending requests were recorded in the VFS).
    Missing,
    Error(String),
}

// ---------------------------------------------------------------------------
// Parsing.

fn parse_bones(b: &[u8]) -> Option<Vec<Bone>> {
    let (n, at) = (count(b, 156)?, count(b, 160)?);
    if n > 256 {
        return None;
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let o = at + i * BONE_BYTES;
        let proctype = i32_at(b, o + 164)?;
        let procindex = i32_at(b, o + 168)?;
        let quat_interp = if proctype == PROC_QUATINTERP && procindex != 0 {
            // mstudioquatinterpbone_t { int control; int numtriggers; int triggerindex; }
            let p = o.checked_add_signed(procindex as isize)?;
            let control = i32_at(b, p)?;
            let (nt, ti) = (count(b, p + 4)?, i32_at(b, p + 8)?);
            let mut triggers = Vec::new();
            for t in 0..nt.min(64) {
                // mstudioquatinterpinfo_t { float inv_tolerance; Quaternion trigger; Vector pos; Quaternion quat; } = 48
                let q = p.checked_add_signed(ti as isize)? + t * 48;
                triggers.push(QuatTrigger { inv_tolerance: f32_at(b, q)?, trigger: vec4(b, q + 4)?, pos: vec3(b, q + 20)?, quat: vec4(b, q + 32)? });
            }
            Some(QuatInterp { control, triggers })
        } else {
            None
        };
        out.push(Bone {
            name: rstr(b, o, i32_at(b, o)?)?,
            parent: i32_at(b, o + 4)?,
            pos: vec3(b, o + 32)?,
            quat: vec4(b, o + 44)?,
            rot: vec3(b, o + 60)?,
            pos_scale: vec3(b, o + 72)?,
            rot_scale: vec3(b, o + 84)?,
            pose_to_bone: mat34(b, o + 96)?,
            alignment: vec4(b, o + 144)?,
            flags: i32_at(b, o + 160)?,
            quat_interp,
        });
    }
    Some(out)
}

/// `$includemodel` paths of an MDL (normalised, `models/...mdl`).
pub fn mdl_includes(b: &[u8]) -> Vec<String> {
    (|| {
        let (n, at) = (count(b, 336)?, count(b, 340)?);
        let mut out = Vec::new();
        for i in 0..n.min(64) {
            let o = at + i * 8;
            let name = normalize(&rstr(b, o, i32_at(b, o + 4)?)?);
            out.push(if name.starts_with("models/") { name } else { format!("models/{name}") });
        }
        Some(out)
    })()
    .unwrap_or_default()
}

fn parse_pose_params(b: &[u8]) -> Option<Vec<PoseParam>> {
    let (n, at) = (count(b, 300)?, count(b, 304)?);
    (0..n.min(64))
        .map(|i| {
            let o = at + i * POSEPARAM_BYTES;
            Some(PoseParam { name: rstr(b, o, i32_at(b, o)?)?, flags: i32_at(b, o + 4)?, start: f32_at(b, o + 8)?, end: f32_at(b, o + 12)?, looping: f32_at(b, o + 16)? })
        })
        .collect()
}

fn parse_anim_descs(b: &[u8], group: usize) -> Option<Vec<AnimDesc>> {
    let (n, at) = (count(b, 180)?, count(b, 184)?);
    let mut out = Vec::with_capacity(n);
    for i in 0..n.min(8192) {
        let o = at + i * ANIMDESC_BYTES;
        let frames = count(b, o + 16)?.max(1);
        let section_frames = i32_at(b, o + 84)?.max(0) as usize;
        let mut sections = Vec::new();
        if section_frames > 0 {
            let so = o.checked_add_signed(i32_at(b, o + 80)? as isize)?;
            for s in 0..frames / section_frames + 2 {
                sections.push((i32_at(b, so + s * 8)?, i32_at(b, so + s * 8 + 4)?));
            }
        }
        out.push(AnimDesc {
            name: rstr(b, o, i32_at(b, o + 4)?)?,
            fps: f32_at(b, o + 8)?,
            flags: i32_at(b, o + 12)?,
            frames,
            group,
            desc_offset: o,
            data_offset: i32_at(b, o + 56)?,
            section_frames,
            sections,
        });
    }
    Some(out)
}

struct RawSeq {
    seq: Sequence,
    /// Local autolayer sequence / pose indices (mapped to global after merging).
    layers_local: Vec<(i32, i32)>,
    local_params: [i32; 2],
    local_anims: Vec<usize>,
    local_weights: Vec<f32>,
}

fn parse_seqs(b: &[u8], nbones: usize) -> Option<Vec<RawSeq>> {
    let (n, at) = (count(b, 188)?, count(b, 192)?);
    let mut out = Vec::with_capacity(n);
    for i in 0..n.min(8192) {
        let o = at + i * SEQDESC_BYTES;
        let gs = [count(b, o + 68)?.max(1), count(b, o + 72)?.max(1)];
        let aii = o.checked_add_signed(i32_at(b, o + 60)? as isize)?;
        let local_anims: Vec<usize> = (0..gs[0] * gs[1]).map(|k| i16_at(b, aii + k * 2).map(|v| v.max(0) as usize)).collect::<Option<_>>()?;
        let mut layers_local = Vec::new();
        let mut autolayers = Vec::new();
        let (nl, li) = (count(b, o + 148)?, i32_at(b, o + 152)?);
        for k in 0..nl.min(32) {
            let lo = o.checked_add_signed(li as isize)? + k * AUTOLAYER_BYTES;
            layers_local.push((i16_at(b, lo)? as i32, i16_at(b, lo + 2)? as i32));
            autolayers.push(AutoLayer {
                seq: -1,
                pose: -1,
                flags: i32_at(b, lo + 4)?,
                start: f32_at(b, lo + 8)?,
                peak: f32_at(b, lo + 12)?,
                tail: f32_at(b, lo + 16)?,
                end: f32_at(b, lo + 20)?,
            });
        }
        let wl = i32_at(b, o + 156)?;
        let local_weights: Vec<f32> = if wl != 0 {
            let wo = o.checked_add_signed(wl as isize)?;
            (0..nbones).map(|k| f32_at(b, wo + k * 4)).collect::<Option<_>>()?
        } else {
            vec![1.0; nbones]
        };
        let pk = i32_at(b, o + 160)?;
        let pose_keys = if pk != 0 {
            let po = o.checked_add_signed(pk as isize)?;
            (0..gs[0] + gs[1]).map(|k| f32_at(b, po + k * 4)).collect::<Option<_>>()?
        } else {
            Vec::new()
        };
        out.push(RawSeq {
            seq: Sequence {
                name: rstr(b, o, i32_at(b, o + 4)?)?,
                activity: rstr(b, o, i32_at(b, o + 8)?).unwrap_or_default(),
                act_weight: i32_at(b, o + 20)?,
                flags: i32_at(b, o + 12)?,
                fade_in: f32_at(b, o + 104)?,
                fade_out: f32_at(b, o + 108)?,
                group_size: gs,
                params: [-1, -1],
                param_start: [f32_at(b, o + 84)?, f32_at(b, o + 88)?],
                param_end: [f32_at(b, o + 92)?, f32_at(b, o + 96)?],
                anims: Vec::new(),
                autolayers,
                weights: Vec::new(),
                pose_keys,
            },
            layers_local,
            local_params: [i32_at(b, o + 76)?, i32_at(b, o + 80)?],
            local_anims,
            local_weights,
        });
    }
    Some(out)
}

fn parse_attachments(b: &[u8]) -> Option<Vec<Attachment>> {
    let (n, at) = (count(b, 240)?, count(b, 244)?);
    (0..n.min(256))
        .map(|i| {
            let o = at + i * ATTACHMENT_BYTES;
            Some(Attachment { name: rstr(b, o, i32_at(b, o)?)?, bone: count(b, o + 8)?, local: mat34(b, o + 12)? })
        })
        .collect()
}

/// LOD-0 VVD vertices (fixups applied): `(pos, normal, uv, weights[3], bones[3])` + tangents.
fn vvd_full(vvd: &[u8]) -> Option<(Vec<[f32; 8]>, Vec<([f32; 3], [u8; 3])>, Vec<[f32; 4]>)> {
    if vvd.get(..4)? != b"IDSV" {
        return None;
    }
    let n_lod0 = count(vvd, 16)?;
    let (nfix, fixstart, vstart, tstart) = (count(vvd, 48)?, count(vvd, 52)?, count(vvd, 56)?, count(vvd, 60)?);
    let mut order: Vec<usize> = Vec::with_capacity(n_lod0);
    if nfix == 0 {
        order.extend(0..n_lod0);
    } else {
        for k in 0..nfix {
            let o = fixstart + k * 12;
            if i32_at(vvd, o)? >= 0 {
                let (src, cnt) = (count(vvd, o + 4)?, count(vvd, o + 8)?);
                order.extend(src..src + cnt);
            }
        }
    }
    let mut verts = Vec::with_capacity(order.len());
    let mut skin = Vec::with_capacity(order.len());
    let mut tangents = Vec::with_capacity(order.len());
    for &i in &order {
        let o = vstart + i * 48;
        let f = |k: usize| f32_at(vvd, o + k);
        verts.push([f(16)?, f(20)?, f(24)?, f(28)?, f(32)?, f(36)?, f(40)?, f(44)?]);
        let nb = (*vvd.get(o + 15)?).min(3) as usize;
        let mut w = [0.0f32; 3];
        let mut bi = [0u8; 3];
        for k in 0..nb {
            w[k] = f(k * 4)?;
            bi[k] = *vvd.get(o + 12 + k)?;
        }
        skin.push((w, bi));
        tangents.push(if tstart > 0 { vec4(vvd, tstart + i * 16).unwrap_or([1.0, 0.0, 0.0, 1.0]) } else { [1.0, 0.0, 0.0, 1.0] });
    }
    Some((verts, skin, tangents))
}

fn skinned_mesh(mdl: &[u8], vvd: &[u8], vtx: &[u8], tex: &MdlTextures) -> Option<SkinnedMesh> {
    let geo = model_geometry(mdl, vvd, vtx)?;
    let (verts, skin, tangents) = vvd_full(vvd)?;
    if verts.len() != geo.vertices.len() {
        return None;
    }
    let mut out = SkinnedMesh::default();
    out.vertices.reserve(verts.len() * STUDIO_VERTEX_FLOATS);
    for i in 0..verts.len() {
        let v = verts[i];
        let (w, b) = skin[i];
        let t = tangents[i];
        out.vertices.extend_from_slice(&v);
        out.vertices.extend_from_slice(&t);
        out.vertices.extend_from_slice(&w);
        out.vertices.extend_from_slice(&[b[0] as f32, b[1] as f32, b[2] as f32]);
    }
    // Group triangles by texture (skin family 0), in first-seen order.
    let family = tex.skins.first();
    let mut by_tex: Vec<(u32, Vec<u32>)> = Vec::new();
    for (skinref, tris) in &geo.meshes {
        let t = family.and_then(|f| f.get(*skinref)).map(|&t| t as u32).unwrap_or(*skinref as u32);
        match by_tex.iter_mut().find(|(k, _)| *k == t) {
            Some((_, v)) => v.extend_from_slice(tris),
            None => by_tex.push((t, tris.clone())),
        }
    }
    for (t, tris) in by_tex {
        out.groups.push([t, out.indices.len() as u32, tris.len() as u32]);
        out.indices.extend(tris);
    }
    Some(out)
}

fn material(vfs: &Vfs, name: &str) -> StudioMaterial {
    let mut m = StudioMaterial { name: name.to_string(), alpha_ref: 0.5, phong_exponent: 5.0, phong_boost: 1.0, ..Default::default() };
    let Some((shader, p)) = vmt_params(vfs, name) else { return m };
    let truthy = |k: &str| p.get(k).is_some_and(|v| v.trim().parse::<f32>().map(|f| f != 0.0).unwrap_or(false));
    let num = |k: &str| p.get(k).and_then(|v| v.trim().parse::<f32>().ok());
    m.shader = shader;
    // Register the textures with the VFS (a mount hit becomes a pending request).
    let tex = |k: &str| {
        p.get(k).map(|t| vtf_path(t)).filter(|t| vfs.read(t).is_some() || vfs.is_pending(t))
    };
    m.base = tex("$basetexture");
    m.bump = tex("$bumpmap");
    m.translucent = truthy("$translucent");
    m.alphatest = truthy("$alphatest");
    m.alpha_ref = num("$alphatestreference").unwrap_or(0.5);
    m.nocull = truthy("$nocull");
    m.additive = truthy("$additive");
    m.selfillum = truthy("$selfillum");
    m.phong = truthy("$phong");
    m.phong_exponent = num("$phongexponent").unwrap_or(5.0);
    m.phong_boost = num("$phongboost").unwrap_or(1.0);
    m
}

/// Loads `path` (an `.mdl`) and everything it needs (`$includemodel`s, `.vvd`, `.dx90.vtx`, VMTs, VTFs).
/// Returns `Missing` while any of them are pending (supply them and call again).
pub fn load(vfs: &Vfs, path: &str) -> Load {
    let path = normalize(path);
    let before = vfs.pending().len();
    let base = path.strip_suffix(".mdl").unwrap_or(&path).to_string();
    let mdl = vfs.read(&path).map(<[u8]>::to_vec);
    let vvd = vfs.read(&format!("{base}.vvd")).map(<[u8]>::to_vec);
    let vtx = vfs.read(&format!("{base}.dx90.vtx")).map(<[u8]>::to_vec);
    let Some(mdl) = mdl else {
        return if vfs.pending().len() > before { Load::Missing } else { Load::Error(format!("{path}: not found")) };
    };
    if mdl.get(..4) != Some(b"IDST") {
        return Load::Error(format!("{path}: not a studio model"));
    }
    let includes = mdl_includes(&mdl);
    let inc_bytes: Vec<Option<Vec<u8>>> = includes.iter().map(|p| vfs.read(p).map(<[u8]>::to_vec)).collect();
    let tex = mdl_textures(&mdl);
    let mat_names = tex.as_ref().map(|t| model_material_names(vfs, t)).unwrap_or_default();
    let materials: Vec<StudioMaterial> = mat_names.iter().map(|n| material(vfs, n)).collect();
    if vfs.pending().len() > before {
        return Load::Missing;
    }
    // Animation-only models (`$includemodel` targets such as models/player/cs_player_shared.mdl) have no VVD / VTX:
    // they load with an empty mesh (skeleton, pose parameters, sequences and animations only).
    let mesh_files = match (vvd, vtx) {
        (Some(vvd), Some(vtx)) => Some((vvd, vtx)),
        (None, None) if tex.as_ref().map_or(true, |t| t.textures.is_empty()) => None,
        _ => return Load::Error(format!("{path}: .vvd / .dx90.vtx not found")),
    };
    let mut groups = vec![mdl];
    for (p, b) in includes.iter().zip(inc_bytes) {
        match b {
            Some(b) if b.get(..4) == Some(b"IDST") => groups.push(b),
            _ => return Load::Error(format!("{path}: include {p} not found")),
        }
    }
    match build(&path, groups, includes, materials, mesh_files.as_ref().map(|(a, b)| (a.as_slice(), b.as_slice())), tex.as_ref()) {
        Some(m) => Load::Ready(Box::new(m)),
        None => Load::Error(format!("{path}: malformed studio model")),
    }
}

/// The model-space transform that takes a vertex from the bind pose (`.vvd`) to the pose of the root bone in the
/// first frame of sequence 0 (what the engine draws an idle entity prop with): `[3x4 row-major]`, or None when it's
/// the identity / can't be decoded. Only the root bone (no parent) is applied: props whose idle sequence moves the
/// whole model (door01_left: the root is turned 90 degrees from its bind pose, and its `.phy` matches the idle pose).
pub fn root_pose_correction(mdl: &[u8]) -> Option<[f32; 12]> {
    if mdl.get(..4)? != b"IDST" || !mdl_includes(mdl).is_empty() {
        return None;
    }
    let m = build("", vec![mdl.to_vec()], Vec::new(), Vec::new(), None, None)?;
    let root = m.bones.iter().position(|b| b.parent < 0)?;
    let seq = m.seqs.first()?;
    let anim = m.decode_anim(*seq.anims.first()?)?;
    let o = root * ANIM_BONE_FLOATS;
    let (q, t) = ([anim[o], anim[o + 1], anim[o + 2], anim[o + 3]], [anim[o + 4], anim[o + 5], anim[o + 6]]);
    // bone-to-model of the animated root: rotation from q, translation t.
    let (x, y, z, w) = (q[0], q[1], q[2], q[3]);
    let r = [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - w * z), 2.0 * (x * z + w * y)],
        [2.0 * (x * y + w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - w * x)],
        [2.0 * (x * z - w * y), 2.0 * (y * z + w * x), 1.0 - 2.0 * (x * x + y * y)],
    ];
    let p = m.bones[root].pose_to_bone;
    let pb = |i: usize, j: usize| p[i * 4 + j];
    let mut out = [0.0f32; 12];
    for i in 0..3 {
        for j in 0..4 {
            let mut v = (0..3).map(|k| r[i][k] * pb(k, j)).sum::<f32>();
            if j == 3 {
                v += t[i];
            }
            out[i * 4 + j] = v;
        }
    }
    let identity = (0..3).all(|i| (0..4).all(|j| (out[i * 4 + j] - if i == j { 1.0 } else { 0.0 }).abs() < 1e-4));
    (!identity).then_some(out)
}

/// Whether the whole model moves with its root in the idle pose, so that pose is `root_pose_correction` exactly: every
/// bone's skinning transform (idle bone-to-model times pose-to-bone) is the root's. door01_left (hinge and handle bones) is;
/// a character whose limbs have another pose than their bind pose isn't, and neither is a model we can't decode.
pub fn idle_pose_is_rigid(mdl: &[u8]) -> bool {
    (|| {
        if mdl.get(..4)? != b"IDST" || !mdl_includes(mdl).is_empty() {
            return None;
        }
        let m = build("", vec![mdl.to_vec()], Vec::new(), Vec::new(), None, None)?;
        let anim = m.decode_anim(*m.seqs.first()?.anims.first()?)?;
        let mut to_model: Vec<[f32; 12]> = Vec::with_capacity(m.bones.len());
        let mut skin_of_root: Option<[f32; 12]> = None;
        for (i, bone) in m.bones.iter().enumerate() {
            let o = i * ANIM_BONE_FLOATS;
            let local = bone_matrix([anim[o], anim[o + 1], anim[o + 2], anim[o + 3]], [anim[o + 4], anim[o + 5], anim[o + 6]]);
            let model = if bone.parent >= 0 { mat34_mul(to_model.get(bone.parent as usize)?, &local) } else { local };
            let skin = mat34_mul(&model, &bone.pose_to_bone);
            match &skin_of_root {
                None => skin_of_root = Some(skin),
                Some(root) => {
                    if (0..12).any(|k| (skin[k] - root[k]).abs() > if k % 4 == 3 { 0.05 } else { 0.001 }) {
                        return Some(false);
                    }
                }
            }
            to_model.push(model);
        }
        Some(skin_of_root.is_some())
    })()
    .unwrap_or(false)
}

fn bone_matrix(q: [f32; 4], t: [f32; 3]) -> [f32; 12] {
    let (x, y, z, w) = (q[0], q[1], q[2], q[3]);
    [
        1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - w * z), 2.0 * (x * z + w * y), t[0],
        2.0 * (x * y + w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - w * x), t[1],
        2.0 * (x * z - w * y), 2.0 * (y * z + w * x), 1.0 - 2.0 * (x * x + y * y), t[2],
    ]
}

fn mat34_mul(a: &[f32; 12], b: &[f32; 12]) -> [f32; 12] {
    let mut out = [0.0; 12];
    for i in 0..3 {
        for j in 0..4 {
            out[i * 4 + j] = (0..3).map(|k| a[i * 4 + k] * b[k * 4 + j]).sum::<f32>() + if j == 3 { a[i * 4 + 3] } else { 0.0 };
        }
    }
    out
}

fn build(path: &str, group_bytes: Vec<Vec<u8>>, includes: Vec<String>, materials: Vec<StudioMaterial>, mesh_files: Option<(&[u8], &[u8])>, tex: Option<&MdlTextures>) -> Option<StudioModel> {
    let main = &group_bytes[0];
    let version = i32_at(main, 4)?;
    let bones = parse_bones(main)?;
    let index_of: HashMap<String, usize> = bones.iter().enumerate().map(|(i, b)| (b.name.to_ascii_lowercase(), i)).collect();
    let mut pose_params: Vec<PoseParam> = Vec::new();
    let mut seqs: Vec<Sequence> = Vec::new();
    let mut seq_index: HashMap<String, usize> = HashMap::new();
    let mut anims: Vec<AnimDesc> = Vec::new();
    let mut groups: Vec<Group> = Vec::new();
    for (g, bytes) in group_bytes.into_iter().enumerate() {
        let gbones = if g == 0 { bones.clone() } else { parse_bones(&bytes)? };
        let bone_map: Vec<i32> = gbones.iter().map(|b| index_of.get(&b.name.to_ascii_lowercase()).map_or(-1, |&i| i as i32)).collect();
        // Pose parameters merge by name.
        let local_pose: Vec<i32> = parse_pose_params(&bytes)?
            .into_iter()
            .map(|p| match pose_params.iter().position(|q| q.name.eq_ignore_ascii_case(&p.name)) {
                Some(i) => i as i32,
                None => {
                    pose_params.push(p);
                    (pose_params.len() - 1) as i32
                }
            })
            .collect();
        let anim_base = anims.len();
        anims.extend(parse_anim_descs(&bytes, g)?);
        // Sequences merge by name: the first model that defines a name wins unless a later one is STUDIO_OVERRIDE.
        let raws = parse_seqs(&bytes, gbones.len())?;
        let mut local_to_global = Vec::with_capacity(raws.len());
        let mut pending_layers = Vec::new();
        for raw in raws {
            let mut s = raw.seq;
            s.anims = raw.local_anims.iter().map(|&a| anim_base + a).collect();
            s.params = raw.local_params.map(|p| if p >= 0 { local_pose.get(p as usize).copied().unwrap_or(-1) } else { -1 });
            let mut w = vec![0.0f32; bones.len()];
            for (gb, &mb) in bone_map.iter().enumerate() {
                if mb >= 0 {
                    w[mb as usize] = raw.local_weights.get(gb).copied().unwrap_or(0.0);
                }
            }
            s.weights = w;
            let key = s.name.to_ascii_lowercase();
            let gi = match seq_index.get(&key) {
                Some(&i) if s.flags & STUDIO_OVERRIDE == 0 => {
                    local_to_global.push(i);
                    continue;
                }
                Some(&i) => {
                    seqs[i] = s;
                    i
                }
                None => {
                    seqs.push(s);
                    seq_index.insert(key, seqs.len() - 1);
                    seqs.len() - 1
                }
            };
            local_to_global.push(gi);
            pending_layers.push((gi, raw.layers_local));
        }
        for (gi, layers) in pending_layers {
            for (k, (ls, lp)) in layers.into_iter().enumerate() {
                let l = &mut seqs[gi].autolayers[k];
                l.seq = local_to_global.get(ls.max(0) as usize).map_or(-1, |&x| x as i32);
                l.pose = if lp >= 0 { local_pose.get(lp as usize).copied().unwrap_or(-1) } else { -1 };
            }
        }
        groups.push(Group { bytes, bone_map, bones: gbones });
    }
    let main = &groups[0].bytes;
    let tex_default = MdlTextures::default();
    let mesh = match mesh_files {
        Some((vvd, vtx)) => skinned_mesh(main, vvd, vtx, tex.unwrap_or(&tex_default))?,
        None => SkinnedMesh::default(),
    };
    Some(StudioModel {
        path: path.to_string(),
        name: rstr(main, 12, 0).unwrap_or_default(),
        version,
        eye_position: vec3(main, 80)?,
        hull: [vec3(main, 104)?, vec3(main, 116)?],
        attachments: parse_attachments(main)?,
        bones,
        pose_params,
        seqs,
        anims,
        includes,
        mesh,
        materials,
        groups,
    })
}

// ---------------------------------------------------------------------------
// Animation decoding.

pub const ANIM_BONE_FLOATS: usize = 7;

fn quat_from_euler([x, y, z]: [f32; 3]) -> [f32; 4] {
    // AngleQuaternion( RadianEuler ): x = roll, y = pitch, z = yaw.
    let (sr, cr) = (x * 0.5).sin_cos();
    let (sp, cp) = (y * 0.5).sin_cos();
    let (sy, cy) = (z * 0.5).sin_cos();
    [sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy]
}

fn half(bits: u16) -> f32 {
    let sign = if bits & 0x8000 != 0 { -1.0 } else { 1.0 };
    let e = ((bits >> 10) & 0x1f) as i32;
    let m = (bits & 0x3ff) as f32;
    sign * match e {
        0 => m * 2f32.powi(-24),
        31 => {
            if m == 0.0 {
                f32::INFINITY
            } else {
                f32::NAN
            }
        }
        _ => (1.0 + m / 1024.0) * 2f32.powi(e - 15),
    }
}

/// `ExtractAnimValue`: value of an RLE stream at `frame` (unscaled), 0 if the stream is absent.
fn anim_value(b: &[u8], stream: usize, frame: usize) -> Option<f32> {
    let mut o = stream;
    let mut k = frame;
    for _ in 0..4096 {
        let valid = *b.get(o)? as usize;
        let total = *b.get(o + 1)? as usize;
        if total == 0 {
            return None;
        }
        if k < total {
            let idx = if k < valid { k } else { valid.max(1) - 1 };
            return Some(i16_at(b, o + 2 + idx * 2)? as f32);
        }
        k -= total;
        o += 2 + valid * 2;
    }
    None
}

fn rle3(b: &[u8], table: usize, frame: usize, scale: [f32; 3]) -> Option<[f32; 3]> {
    let mut out = [0.0; 3];
    for (axis, v) in out.iter_mut().enumerate() {
        let rel = i16_at(b, table + axis * 2)?;
        if rel > 0 {
            *v = anim_value(b, table + rel as usize, frame)? * scale[axis];
        }
    }
    Some(out)
}

fn quat48(b: &[u8], o: usize) -> Option<[f32; 4]> {
    let x = (u16_at(b, o)? as f32 - 32768.0) / 32768.0;
    let y = (u16_at(b, o + 2)? as f32 - 32768.0) / 32768.0;
    let zr = u16_at(b, o + 4)?;
    let z = ((zr & 0x7fff) as f32 - 16384.0) / 16384.0;
    let w = (1.0 - x * x - y * y - z * z).max(0.0).sqrt();
    Some([x, y, z, if zr & 0x8000 != 0 { -w } else { w }])
}

fn quat64(b: &[u8], o: usize) -> Option<[f32; 4]> {
    let lo = u32_at(b, o)? as u64;
    let hi = u32_at(b, o + 4)? as u64;
    let v = lo | (hi << 32);
    let s = 1_048_576.5f64;
    let x = ((v & 0x1f_ffff) as f64 - 1_048_576.0) / s;
    let y = (((v >> 21) & 0x1f_ffff) as f64 - 1_048_576.0) / s;
    let z = (((v >> 42) & 0x1f_ffff) as f64 - 1_048_576.0) / s;
    let w = (1.0 - x * x - y * y - z * z).max(0.0).sqrt();
    Some([x as f32, y as f32, z as f32, if v >> 63 != 0 { -w as f32 } else { w as f32 }])
}

impl StudioModel {
    pub fn group_count(&self) -> usize {
        self.groups.len()
    }

    /// Decodes every frame of animation `a` for the main model's bones:
    /// `frames * bones * [qx, qy, qz, qw, px, py, pz]` (bone-local, Source axes). Delta animations hold
    /// deltas (identity / zero where untouched).
    pub fn decode_anim(&self, a: usize) -> Option<Vec<f32>> {
        let desc = self.anims.get(a)?;
        let g = self.groups.get(desc.group)?;
        let nb = self.bones.len();
        let delta = desc.flags & STUDIO_DELTA != 0;
        let mut out = vec![0.0f32; desc.frames * nb * ANIM_BONE_FLOATS];
        // Base pose per main bone: the group's bone default if the group has it, else the main model's.
        let mut group_of_main: Vec<i32> = vec![-1; nb];
        for (gb, &mb) in g.bone_map.iter().enumerate() {
            if mb >= 0 {
                group_of_main[mb as usize] = gb as i32;
            }
        }
        let base = |mb: usize| -> ([f32; 4], [f32; 3]) {
            if delta {
                return ([0.0, 0.0, 0.0, 1.0], [0.0; 3]);
            }
            let gb = group_of_main[mb];
            let b = if gb >= 0 { &g.bones[gb as usize] } else { &self.bones[mb] };
            (b.quat, b.pos)
        };
        for f in 0..desc.frames {
            let row = &mut out[f * nb * ANIM_BONE_FLOATS..(f + 1) * nb * ANIM_BONE_FLOATS];
            for mb in 0..nb {
                let (q, p) = base(mb);
                row[mb * 7..mb * 7 + 4].copy_from_slice(&q);
                row[mb * 7 + 4..mb * 7 + 7].copy_from_slice(&p);
            }
            if desc.flags & STUDIO_ALLZEROS != 0 {
                continue;
            }
            let (start, local) = self.anim_data(desc, f)?;
            let b = &g.bytes;
            let mut cursor = start;
            for _ in 0..=g.bones.len() {
                let gb = *b.get(cursor)? as usize;
                if gb == 255 {
                    break;
                }
                let flags = *b.get(cursor + 1)?;
                let next = i16_at(b, cursor + 2)?;
                let bone = g.bones.get(gb)?;
                let mut payload = cursor + 4;
                let track_delta = flags & ANIM_DELTA != 0;
                let mut q = if flags & ANIM_RAWROT != 0 {
                    payload += 6;
                    quat48(b, payload - 6)?
                } else if flags & ANIM_RAWROT2 != 0 {
                    payload += 8;
                    quat64(b, payload - 8)?
                } else if flags & ANIM_ANIMROT != 0 {
                    let mut e = rle3(b, payload, local, bone.rot_scale)?;
                    if !track_delta {
                        for k in 0..3 {
                            e[k] += bone.rot[k];
                        }
                    }
                    payload += 6;
                    quat_from_euler(e)
                } else if track_delta {
                    [0.0, 0.0, 0.0, 1.0]
                } else {
                    bone.quat
                };
                if !track_delta && bone.flags & BONE_FIXED_ALIGNMENT != 0 {
                    let a = bone.alignment;
                    let d1: f32 = (0..4).map(|k| (q[k] - a[k]).powi(2)).sum();
                    let d2: f32 = (0..4).map(|k| (q[k] + a[k]).powi(2)).sum();
                    if d1 > d2 {
                        q = q.map(|v| -v);
                    }
                }
                let p = if flags & ANIM_RAWPOS != 0 {
                    [half(u16_at(b, payload)?), half(u16_at(b, payload + 2)?), half(u16_at(b, payload + 4)?)]
                } else if flags & ANIM_ANIMPOS != 0 {
                    let mut v = rle3(b, payload, local, bone.pos_scale)?;
                    if !track_delta {
                        for k in 0..3 {
                            v[k] += bone.pos[k];
                        }
                    }
                    v
                } else if track_delta {
                    [0.0; 3]
                } else {
                    bone.pos
                };
                let mb = g.bone_map[gb];
                if mb >= 0 {
                    let mb = mb as usize;
                    row[mb * 7..mb * 7 + 4].copy_from_slice(&q);
                    row[mb * 7 + 4..mb * 7 + 7].copy_from_slice(&p);
                }
                if next <= 0 {
                    break;
                }
                cursor += next as usize;
            }
        }
        Some(out)
    }

    /// Start of the `mstudioanim_t` chain for `frame` and the frame index within its section.
    fn anim_data(&self, d: &AnimDesc, frame: usize) -> Option<(usize, usize)> {
        if d.section_frames == 0 {
            if d.data_offset == 0 {
                return None;
            }
            return Some((d.desc_offset.checked_add_signed(d.data_offset as isize)?, frame));
        }
        let sf = d.section_frames;
        let section = if d.frames > sf && frame == d.frames - 1 { frame / sf + 1 } else { frame / sf };
        let (block, rel) = *d.sections.get(section)?;
        if block != 0 {
            return None; // .ani animation blocks: not used by CS:S models
        }
        let local = if d.frames > sf && frame == d.frames - 1 { 0 } else { frame % sf };
        Some((d.desc_offset.checked_add_signed(rel as isize)?, local))
    }

    /// Metadata as JSON (bones, attachments, pose parameters, sequences, animations, materials, mesh groups).
    pub fn info_json(&self) -> String {
        let mut s = String::with_capacity(64 * 1024);
        let esc = |t: &str| t.replace('\\', "\\\\").replace('"', "\\\"");
        let nums = |v: &[f32]| v.iter().map(|x| if x.is_finite() { format!("{x}") } else { "0".into() }).collect::<Vec<_>>().join(",");
        let _ = write!(s, "{{\"path\":\"{}\",\"name\":\"{}\",\"version\":{},\"eye\":[{}],\"hull\":[{},{}],", esc(&self.path), esc(&self.name), self.version, nums(&self.eye_position), format_args!("[{}]", nums(&self.hull[0])), format_args!("[{}]", nums(&self.hull[1])));
        let _ = write!(s, "\"includes\":[{}],", self.includes.iter().map(|i| format!("\"{}\"", esc(i))).collect::<Vec<_>>().join(","));
        s.push_str("\"bones\":[");
        for (i, b) in self.bones.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            let _ = write!(s, "{{\"name\":\"{}\",\"parent\":{},\"pos\":[{}],\"quat\":[{}],\"poseToBone\":[{}],\"flags\":{}", esc(&b.name), b.parent, nums(&b.pos), nums(&b.quat), nums(&b.pose_to_bone), b.flags);
            if let Some(qi) = &b.quat_interp {
                let _ = write!(s, ",\"quatInterp\":{{\"control\":{},\"triggers\":[", qi.control);
                for (k, t) in qi.triggers.iter().enumerate() {
                    if k > 0 {
                        s.push(',');
                    }
                    let _ = write!(s, "{{\"invTolerance\":{},\"trigger\":[{}],\"pos\":[{}],\"quat\":[{}]}}", t.inv_tolerance, nums(&t.trigger), nums(&t.pos), nums(&t.quat));
                }
                s.push_str("]}");
            }
            s.push('}');
        }
        s.push_str("],\"attachments\":[");
        for (i, a) in self.attachments.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            let _ = write!(s, "{{\"name\":\"{}\",\"bone\":{},\"local\":[{}]}}", esc(&a.name), a.bone, nums(&a.local));
        }
        s.push_str("],\"poseParams\":[");
        for (i, p) in self.pose_params.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            let _ = write!(s, "{{\"name\":\"{}\",\"flags\":{},\"start\":{},\"end\":{},\"loop\":{}}}", esc(&p.name), p.flags, p.start, p.end, p.looping);
        }
        s.push_str("],\"anims\":[");
        for (i, a) in self.anims.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            let _ = write!(s, "{{\"name\":\"{}\",\"fps\":{},\"flags\":{},\"frames\":{}}}", esc(&a.name), a.fps, a.flags, a.frames);
        }
        s.push_str("],\"seqs\":[");
        for (i, q) in self.seqs.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            let w: Vec<f32> = q.weights.clone();
            let _ = write!(
                s,
                "{{\"name\":\"{}\",\"activity\":\"{}\",\"actWeight\":{},\"flags\":{},\"fadeIn\":{},\"fadeOut\":{},\"groupSize\":[{},{}],\"params\":[{},{}],\"paramStart\":[{}],\"paramEnd\":[{}],\"anims\":[{}],\"weights\":[{}],\"poseKeys\":[{}],\"layers\":[",
                esc(&q.name),
                esc(&q.activity),
                q.act_weight,
                q.flags,
                q.fade_in,
                q.fade_out,
                q.group_size[0],
                q.group_size[1],
                q.params[0],
                q.params[1],
                nums(&q.param_start),
                nums(&q.param_end),
                q.anims.iter().map(|a| a.to_string()).collect::<Vec<_>>().join(","),
                nums(&w),
                nums(&q.pose_keys)
            );
            for (k, l) in q.autolayers.iter().enumerate() {
                if k > 0 {
                    s.push(',');
                }
                let _ = write!(s, "{{\"seq\":{},\"pose\":{},\"flags\":{},\"start\":{},\"peak\":{},\"tail\":{},\"end\":{}}}", l.seq, l.pose, l.flags, nums(&[l.start]), nums(&[l.peak]), nums(&[l.tail]), nums(&[l.end]));
            }
            s.push_str("]}");
        }
        s.push_str("],\"materials\":[");
        for (i, m) in self.materials.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            let opt = |o: &Option<String>| o.as_ref().map_or("null".to_string(), |v| format!("\"{}\"", esc(v)));
            let _ = write!(
                s,
                "{{\"name\":\"{}\",\"shader\":\"{}\",\"base\":{},\"bump\":{},\"translucent\":{},\"alphatest\":{},\"alphaRef\":{},\"nocull\":{},\"additive\":{},\"selfillum\":{},\"phong\":{},\"phongExponent\":{},\"phongBoost\":{}}}",
                esc(&m.name),
                esc(&m.shader),
                opt(&m.base),
                opt(&m.bump),
                m.translucent,
                m.alphatest,
                m.alpha_ref,
                m.nocull,
                m.additive,
                m.selfillum,
                m.phong,
                m.phong_exponent,
                m.phong_boost
            );
        }
        s.push_str("],\"groups\":[");
        for (i, g) in self.mesh.groups.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            let _ = write!(s, "[{},{},{}]", g[0], g[1], g[2]);
        }
        let _ = write!(s, "],\"vertexCount\":{},\"indexCount\":{}}}", self.mesh.vertices.len() / STUDIO_VERTEX_FLOATS, self.mesh.indices.len());
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::Source;
    use std::rc::Rc;

    #[test]
    fn rle_values() {
        // valid 2, total 4: values 10, 20 then 20 repeated; then valid 1 total 2: 5.
        let mut b = vec![2u8, 4];
        b.extend_from_slice(&10i16.to_le_bytes());
        b.extend_from_slice(&20i16.to_le_bytes());
        b.extend_from_slice(&[1, 2]);
        b.extend_from_slice(&5i16.to_le_bytes());
        let v: Vec<f32> = (0..6).map(|f| anim_value(&b, 0, f).unwrap()).collect();
        assert_eq!(v, vec![10.0, 20.0, 20.0, 20.0, 5.0, 5.0]);
    }

    #[test]
    fn half_floats() {
        assert_eq!(half(0x3c00), 1.0);
        assert_eq!(half(0xc000), -2.0);
        assert_eq!(half(0x0000), 0.0);
        assert!((half(0x3555) - 0.333).abs() < 1e-3);
    }

    #[test]
    fn euler_identity() {
        let q = quat_from_euler([0.0, 0.0, 0.0]);
        assert_eq!(q, [0.0, 0.0, 0.0, 1.0]);
        let q = quat_from_euler([0.0, 0.0, std::f32::consts::FRAC_PI_2]);
        assert!((q[2] - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
    }

    /// Real CS:S player model, if the files are available locally (never committed):
    /// `STUDIO_TEST_DIR=<dir containing models/...> cargo test -p bunnyhop-core studio`.
    #[test]
    fn css_player_model() {
        let Ok(dir) = std::env::var("STUDIO_TEST_DIR") else { return };
        let mut files: HashMap<String, Rc<[u8]>> = HashMap::new();
        fn walk(root: &std::path::Path, d: &std::path::Path, out: &mut HashMap<String, Rc<[u8]>>) {
            for e in std::fs::read_dir(d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(root, &p, out);
                } else {
                    let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                    out.insert(normalize(&rel), std::fs::read(&p).unwrap().into());
                }
            }
        }
        let root = std::path::PathBuf::from(&dir);
        walk(&root, &root, &mut files);
        let mut vfs = Vfs::default();
        vfs.mount(Source::loose("test", files));
        let m = match load(&vfs, "models/player/ct_urban.mdl") {
            Load::Ready(m) => m,
            Load::Missing => panic!("missing"),
            Load::Error(e) => panic!("{e}"),
        };
        assert_eq!(m.groups.len(), 3);
        assert!(m.bones.len() >= 49);
        let names: Vec<&str> = m.pose_params.iter().map(|p| p.name.as_str()).collect();
        for p in ["move_x", "move_y", "body_yaw", "body_pitch"] {
            assert!(names.contains(&p), "{names:?}");
        }
        for s in ["Idle_lower", "Run_lower", "Jump", "Crouch_walk_lower", "Run_Upper_KNIFE", "Idle_Aim_KNIFE"] {
            let i = m.seqs.iter().position(|q| q.name.eq_ignore_ascii_case(s)).unwrap_or_else(|| panic!("{s}"));
            for &a in &m.seqs[i].anims {
                let d = m.decode_anim(a).unwrap();
                assert_eq!(d.len(), m.anims[a].frames * m.bones.len() * 7);
                for q in d.chunks(7) {
                    let n = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
                    assert!((n - 1.0).abs() < 0.02, "{s}: |q| = {n}");
                    assert!(q[4].abs() < 200.0 && q[5].abs() < 200.0 && q[6].abs() < 200.0, "{s}: pos {:?}", &q[4..7]);
                }
            }
        }
        // The animation model alone (what the bunny animates with): no VVD / VTX, so an empty mesh.
        let shared = match load(&vfs, "models/player/cs_player_shared.mdl") {
            Load::Ready(m) => m,
            Load::Missing => panic!("missing"),
            Load::Error(e) => panic!("{e}"),
        };
        assert!(shared.mesh.vertices.is_empty() && shared.bones.len() >= 45);
        assert!(shared.seqs.iter().any(|q| q.name == "Jump" && q.activity == "ACT_HOP"));
        let jump = &m.seqs[m.seqs.iter().position(|q| q.name == "Jump").unwrap()];
        assert_eq!(jump.activity, "ACT_HOP");
        assert!(m.mesh.vertices.len() / STUDIO_VERTEX_FLOATS > 1000);
        assert!(!m.mesh.groups.is_empty());
        let json = m.info_json();
        assert!(json.starts_with('{') && json.ends_with('}'));
        eprintln!("{} bones, {} seqs, {} anims, {} verts, {} tris, materials {:?}", m.bones.len(), m.seqs.len(), m.anims.len(), m.mesh.vertices.len() / STUDIO_VERTEX_FLOATS, m.mesh.indices.len() / 3, m.materials.iter().map(|x| (&x.name, &x.base, &x.bump)).collect::<Vec<_>>());
        for b in &m.bones {
            if b.quat_interp.is_some() {
                eprintln!("quatinterp bone {}", b.name);
            }
        }
    }
}
