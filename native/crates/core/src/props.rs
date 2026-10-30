//! Static props (BSP game lump `sprp`) as one render mesh: studio models (MDL + VVD + DX90 VTX, LOD 0,
//! rigid; static props never animate) placed at their origins/angles, grouped by material.
//!
//! Model files are read through the `Vfs` (pakfile first, then hosted/mounted stock content), so a
//! remote hit records a pending request and the model is simply absent from this build.
//! Vertex layout: `[x, y, z, nx, ny, nz, u, v]` in Source world space.

use crate::vfs::{normalize, Vfs};
use playsrc_bsp::Bsp;
use std::collections::HashMap;

pub const PROP_VERTEX_FLOATS: usize = 8;

#[derive(Clone, Debug)]
pub struct Prop {
    pub model: usize,
    pub origin: [f32; 3],
    /// pitch, yaw, roll (degrees).
    pub angles: [f32; 3],
    pub skin: i32,
    /// 0: static (baked at its pose). Else a moving entity prop (entity index + 1): baked in model space into its
    /// own groups (`PropMesh::dynamic_groups`) for the client to place every frame.
    pub owner: u32,
    /// In the 3D skybox set (`skybox.rs`; static props only): its own groups, flagged in `PropMesh::group_sky3d`.
    pub sky3d: bool,
    /// Uniform scale (CS:GO static prop lump v11; 1.0 everywhere else).
    pub scale: f32,
    /// An entity prop (`add_props`), which the engine draws in its model's idle pose (`studio::root_pose_correction`):
    /// `prop_dynamic` door01_left is shut in its idle pose, wide open in its bind pose (bhop_mirrorsedge_chpt1, feedback
    /// 2026-10-30). False for the static prop lump, which is drawn as baked.
    pub entity: bool,
}

#[derive(Default, Clone)]
pub struct StaticProps {
    /// Model paths (`models/....mdl`), lowercase.
    pub models: Vec<String>,
    pub props: Vec<Prop>,
}

/// Appends entity props (model path, origin, angles, skin) to a static prop set, sharing its model list.
pub fn add_props(sp: &mut StaticProps, props: impl IntoIterator<Item = (String, [f32; 3], [f32; 3], i32, u32)>) {
    for (name, origin, angles, skin, owner) in props {
        let name = normalize(&name);
        let model = match sp.models.iter().position(|m| *m == name) {
            Some(i) => i,
            None => {
                sp.models.push(name);
                sp.models.len() - 1
            }
        };
        sp.props.push(Prop { model, origin, angles, skin, owner, sky3d: false, scale: 1.0, entity: true });
    }
}

pub fn static_props(bsp: &Bsp) -> StaticProps {
    let Ok(Some(sp)) = playsrc_bsp::parse_static_props(bsp, Default::default()) else { return StaticProps::default() };
    let models = sp.dictionary.iter().map(|d| normalize(&String::from_utf8_lossy(&d.name))).collect();
    let v = |x: playsrc_bsp::Vector3| [x.x.value(), x.y.value(), x.z.value()];
    let props = sp
        .occurrences
        .iter()
        .map(|o| Prop { model: o.model as usize, origin: v(o.origin), angles: v(o.angles), skin: o.skin, owner: 0, sky3d: false, scale: o.uniform_scale.value(), entity: false })
        .collect();
    StaticProps { models, props }
}

/// Companion files of a model: `.mdl`, `.vvd`, `.dx90.vtx`.
pub fn model_files(mdl: &str) -> [String; 3] {
    let base = normalize(mdl);
    let base = base.strip_suffix(".mdl").unwrap_or(&base).to_string();
    [format!("{base}.mdl"), format!("{base}.vvd"), format!("{base}.dx90.vtx")]
}

// ---------------------------------------------------------------------------
// Studio model parsing (just what rigid LOD-0 rendering needs).

fn i32_at(b: &[u8], o: usize) -> Option<i32> {
    Some(i32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?))
}
fn u16_at(b: &[u8], o: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(o..o + 2)?.try_into().ok()?))
}
fn f32_at(b: &[u8], o: usize) -> Option<f32> {
    Some(f32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?))
}
fn idx(b: &[u8], o: usize) -> Option<usize> {
    usize::try_from(i32_at(b, o)?).ok()
}
fn cstr(b: &[u8], o: usize) -> Option<String> {
    let rest = b.get(o..)?;
    let end = rest.iter().position(|&c| c == 0)?;
    Some(String::from_utf8_lossy(&rest[..end]).into_owned())
}

/// Texture names, `$cdmaterials` search dirs and the skin table of an MDL.
#[derive(Debug, Default, Clone)]
pub struct MdlTextures {
    pub textures: Vec<String>,
    pub cdmaterials: Vec<String>,
    /// `[family][skinref] -> texture index`.
    pub skins: Vec<Vec<u16>>,
}

impl MdlTextures {
    /// Candidate material names for texture `t` (one per `$cdmaterials` dir), in search order.
    pub fn candidates(&self, t: usize) -> Vec<String> {
        let tex = self.textures.get(t).map(|s| normalize(s)).unwrap_or_default();
        let mut out: Vec<String> = self
            .cdmaterials
            .iter()
            .map(|cd| {
                let cd = normalize(cd);
                let cd = cd.trim_end_matches('/');
                if cd.is_empty() { tex.clone() } else { format!("{cd}/{tex}") }
            })
            .collect();
        if out.is_empty() {
            out.push(tex);
        }
        out
    }
}

pub fn mdl_textures(mdl: &[u8]) -> Option<MdlTextures> {
    if mdl.get(..4)? != b"IDST" {
        return None;
    }
    let mut out = MdlTextures::default();
    let (nt, ti) = (idx(mdl, 204)?, idx(mdl, 208)?);
    for i in 0..nt.min(1024) {
        let base = ti + i * 64;
        out.textures.push(cstr(mdl, base.checked_add_signed(i32_at(mdl, base)? as isize)?)?);
    }
    let (nc, ci) = (idx(mdl, 212)?, idx(mdl, 216)?);
    for j in 0..nc.min(64) {
        out.cdmaterials.push(cstr(mdl, idx(mdl, ci + j * 4)?)?);
    }
    let (nref, nfam, si) = (idx(mdl, 220)?, idx(mdl, 224)?, idx(mdl, 228)?);
    for f in 0..nfam.min(64) {
        out.skins.push((0..nref.min(1024)).map(|r| u16_at(mdl, si + (f * nref + r) * 2).unwrap_or(r as u16)).collect());
    }
    Some(out)
}

/// A model's LOD-0 geometry in model space: vertices + triangle lists per skinref (mesh material).
pub struct ModelGeometry {
    pub vertices: Vec<[f32; 8]>,
    pub meshes: Vec<(usize, Vec<u32>)>,
}

/// VVD vertices for LOD 0 (fixups applied).
fn vvd_vertices(vvd: &[u8]) -> Option<Vec<[f32; 8]>> {
    if vvd.get(..4)? != b"IDSV" {
        return None;
    }
    let n_lod0 = idx(vvd, 16)?;
    let (nfix, fixstart, vstart) = (idx(vvd, 48)?, idx(vvd, 52)?, idx(vvd, 56)?);
    let read = |i: usize| -> Option<[f32; 8]> {
        let o = vstart + i * 48;
        let f = |k: usize| f32_at(vvd, o + k);
        Some([f(16)?, f(20)?, f(24)?, f(28)?, f(32)?, f(36)?, f(40)?, f(44)?])
    };
    let mut out = Vec::with_capacity(n_lod0);
    if nfix == 0 {
        for i in 0..n_lod0 {
            out.push(read(i)?);
        }
    } else {
        for k in 0..nfix {
            let o = fixstart + k * 12;
            if i32_at(vvd, o)? >= 0 {
                let (src, count) = (idx(vvd, o + 4)?, idx(vvd, o + 8)?);
                for i in src..src + count {
                    out.push(read(i)?);
                }
            }
        }
    }
    Some(out)
}

pub fn model_geometry(mdl: &[u8], vvd: &[u8], vtx: &[u8]) -> Option<ModelGeometry> {
    let vertices = vvd_vertices(vvd)?;
    if i32_at(vtx, 0)? != 7 {
        return None;
    }
    let (mdl_nbp, mdl_bpi) = (idx(mdl, 232)?, idx(mdl, 236)?);
    let (vtx_nbp, vtx_bpo) = (idx(vtx, 28)?, idx(vtx, 32)?);
    let mut meshes = Vec::new();
    for bp in 0..mdl_nbp.min(vtx_nbp) {
        // MDL body part -> model 0 (default body).
        let mbp = mdl_bpi + bp * 16;
        if idx(mdl, mbp + 4)? == 0 {
            continue;
        }
        let mmodel = mbp + idx(mdl, mbp + 12)?;
        let model_vert_start = idx(mdl, mmodel + 84)? / 48;
        let (nmesh, meshi) = (idx(mdl, mmodel + 72)?, idx(mdl, mmodel + 76)?);
        // VTX body part -> model 0 -> LOD 0.
        let vbp = vtx_bpo + bp * 8;
        if idx(vtx, vbp)? == 0 {
            continue;
        }
        let vmodel = vbp + idx(vtx, vbp + 4)?;
        if idx(vtx, vmodel)? == 0 {
            continue;
        }
        let vlod = vmodel + idx(vtx, vmodel + 4)?;
        let (vnmesh, vmeshoff) = (idx(vtx, vlod)?, idx(vtx, vlod + 4)?);
        for m in 0..nmesh.min(vnmesh) {
            let mmesh = mmodel + meshi + m * 116;
            let material = idx(mdl, mmesh)?;
            let mesh_vert_start = model_vert_start + idx(mdl, mmesh + 12)?;
            let vmesh = vlod + vmeshoff + m * 9;
            let (nsg, sgoff) = (idx(vtx, vmesh)?, idx(vtx, vmesh + 4)?);
            let mut tris = Vec::new();
            for g in 0..nsg {
                let sg = vmesh + sgoff + g * 25;
                let (nv, voff, ni, ioff) = (idx(vtx, sg)?, idx(vtx, sg + 4)?, idx(vtx, sg + 8)?, idx(vtx, sg + 12)?);
                // Strip-group vertex -> original mesh vertex.
                let orig: Vec<u32> = (0..nv).map(|v| u16_at(vtx, sg + voff + v * 9 + 4).map(|o| (mesh_vert_start + o as usize) as u32)).collect::<Option<_>>()?;
                for t in 0..ni / 3 {
                    let i = |k: usize| u16_at(vtx, sg + ioff + (t * 3 + k) * 2).and_then(|x| orig.get(x as usize).copied());
                    let (a, b, c) = (i(0)?, i(1)?, i(2)?);
                    if (a as usize) < vertices.len() && (b as usize) < vertices.len() && (c as usize) < vertices.len() {
                        // Studio models wind clockwise; emit CCW for GL front faces.
                        tris.extend_from_slice(&[a, c, b]);
                    }
                }
            }
            if !tris.is_empty() {
                meshes.push((material, tris));
            }
        }
    }
    Some(ModelGeometry { vertices, meshes })
}

/// Geometry sanity numbers for one model (see `audit_geometry`).
#[derive(Debug, Default)]
pub struct GeometryAudit {
    pub tris: usize,
    /// Triangles with an edge longer than the model's bounds diagonal (plus slack).
    pub bad_tris: usize,
    /// Referenced vertices outside the MDL bounds (plus slack).
    pub outside: usize,
    pub max_edge: f32,
    /// Bounds diagonal used.
    pub size: f32,
}

/// Checks triangles against the MDL's bounds (the larger of `hull` and `view_bb`): a triangle edge can't
/// be longer than the bounds diagonal unless a vertex is outside the model, i.e. an index/fixup bug.
pub fn audit_geometry(mdl: &[u8], geo: &ModelGeometry) -> GeometryAudit {
    let v3 = |o: usize| [f32_at(mdl, o).unwrap_or(0.0), f32_at(mdl, o + 4).unwrap_or(0.0), f32_at(mdl, o + 8).unwrap_or(0.0)];
    let (hmin, hmax, vmin, vmax) = (v3(104), v3(116), v3(128), v3(140));
    let mut lo = [0f32; 3];
    let mut hi = [0f32; 3];
    for i in 0..3 {
        lo[i] = hmin[i].min(vmin[i]);
        hi[i] = hmax[i].max(vmax[i]);
    }
    let diag = ((0..3).map(|i| (hi[i] - lo[i]).powi(2)).sum::<f32>()).sqrt();
    // Bounds in old models are sometimes loose or zero; allow generous slack.
    let slack = (diag * 0.25).max(16.0);
    let mut out = GeometryAudit { size: diag, ..Default::default() };
    let mut seen = vec![false; geo.vertices.len()];
    for (_, tris) in &geo.meshes {
        for t in tris.chunks_exact(3) {
            out.tris += 1;
            let p = [&geo.vertices[t[0] as usize], &geo.vertices[t[1] as usize], &geo.vertices[t[2] as usize]];
            let mut long = false;
            for k in 0..3 {
                let (a, b) = (p[k], p[(k + 1) % 3]);
                let e = ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
                out.max_edge = out.max_edge.max(e);
                long |= e > diag + slack;
            }
            out.bad_tris += long as usize;
            for &i in t {
                if !std::mem::replace(&mut seen[i as usize], true) {
                    let v = &geo.vertices[i as usize];
                    out.outside += (0..3).any(|k| v[k] < lo[k] - slack || v[k] > hi[k] + slack) as usize;
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Prop mesh.

#[derive(Default)]
pub struct PropMesh {
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
    /// `[material, first_index, index_count]`.
    pub groups: Vec<[u32; 3]>,
    /// Parallel to `groups`: the group's props are in the 3D skybox set (drawn by the skybox pass).
    pub group_sky3d: Vec<bool>,
    /// Moving props: [owner entity index, material, first index, index count], vertices in model space.
    pub dynamic_groups: Vec<[u32; 4]>,
    /// Material names (resolve like world materials).
    pub materials: Vec<String>,
    /// Models that couldn't be built (files missing or unparsable).
    pub missing_models: Vec<String>,
    pub instances: usize,
}

/// Source `AngleMatrix` (pitch about Y, yaw about Z, roll about X), as rows applied to column vectors.
fn angle_matrix([pitch, yaw, roll]: [f32; 3]) -> [[f32; 3]; 3] {
    let (sp, cp) = playsrc_collision::math::sin_cos(pitch.to_radians());
    let (sy, cy) = playsrc_collision::math::sin_cos(yaw.to_radians());
    let (sr, cr) = playsrc_collision::math::sin_cos(roll.to_radians());
    [
        [cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy],
        [cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy],
        [-sp, sr * cp, cr * cp],
    ]
}

/// Picks the material for each texture: the first `$cdmaterials` candidate whose VMT exists in the VFS
/// (a remote hit is requested and counts as existing).
pub fn model_material_names(vfs: &Vfs, tex: &MdlTextures) -> Vec<String> {
    (0..tex.textures.len())
        .map(|t| {
            let cands = tex.candidates(t);
            cands
                .iter()
                .find(|c| {
                    let p = format!("materials/{c}.vmt");
                    vfs.read(&p).is_some() || vfs.is_pending(&p)
                })
                .unwrap_or(&cands[0])
                .clone()
        })
        .collect()
}

pub fn build(sp: &StaticProps, vfs: &Vfs) -> PropMesh {
    let mut out = PropMesh::default();
    let mut material_ids: HashMap<String, u32> = HashMap::new();
    // (owner, in the 3D skybox, material id) -> (vertices, indices)
    let mut buckets: HashMap<(u32, bool, u32), (Vec<f32>, Vec<u32>)> = HashMap::new();
    let mut loaded: Vec<Option<(ModelGeometry, MdlTextures, Vec<String>)>> = Vec::with_capacity(sp.models.len());
    // Moving props are drawn in their idle pose (see `studio::root_pose_correction`), and so are other entity props when
    // that pose is exactly the correction (`studio::idle_pose_is_rigid`). Other skeletons keep their bind pose; static
    // props are drawn as baked.
    let mut corrections: Vec<Option<[f32; 12]>> = Vec::with_capacity(sp.models.len());
    let mut rigid: Vec<bool> = Vec::with_capacity(sp.models.len());
    for m in &sp.models {
        let [mdl_p, vvd_p, vtx_p] = model_files(m);
        // Read all three so missing ones are requested together.
        let (mdl, vvd, vtx) = (vfs.read(&mdl_p), vfs.read(&vvd_p), vfs.read(&vtx_p));
        let model = (|| {
            let (mdl, vvd, vtx) = (mdl?, vvd?, vtx?);
            let tex = mdl_textures(mdl)?;
            let geo = model_geometry(mdl, vvd, vtx)?;
            let names = model_material_names(vfs, &tex);
            Some((geo, tex, names))
        })();
        if model.is_none() {
            out.missing_models.push(m.clone());
        }
        loaded.push(model);
        corrections.push(vfs.read(&mdl_p).and_then(crate::studio::root_pose_correction));
        rigid.push(vfs.read(&mdl_p).is_some_and(crate::studio::idle_pose_is_rigid));
    }
    for p in &sp.props {
        let Some(Some((geo, tex, names))) = loaded.get(p.model) else { continue };
        out.instances += 1;
        let (angles, origin) = if p.owner != 0 { ([0.0; 3], [0.0; 3]) } else { (p.angles, p.origin) };
        let r = angle_matrix(angles);
        let pose = if p.owner != 0 || (p.entity && rigid.get(p.model) == Some(&true)) { corrections.get(p.model).copied().flatten() } else { None };
        let posed = |v: [f32; 3], point: bool| match pose {
            Some(m) => [0, 1, 2].map(|i| m[i * 4] * v[0] + m[i * 4 + 1] * v[1] + m[i * 4 + 2] * v[2] + if point { m[i * 4 + 3] } else { 0.0 }),
            None => v,
        };
        let xf = |v: [f32; 3]| [0, 1, 2].map(|i| r[i][0] * v[0] + r[i][1] * v[1] + r[i][2] * v[2]);
        // CS:GO scaled static props: positions scale about the model origin (normals don't change under a uniform
        // scale). Unscaled props (every v19/v20 map) skip this, so their vertices are bit-identical.
        let scale = p.scale;
        let scaled = |v: [f32; 3]| if scale != 1.0 { v.map(|c| c * scale) } else { v };
        let family = tex.skins.get(p.skin.max(0) as usize).or(tex.skins.first());
        for (skinref, tris) in &geo.meshes {
            let t = family.and_then(|f| f.get(*skinref)).map(|&t| t as usize).unwrap_or(*skinref);
            let Some(name) = names.get(t) else { continue };
            let next = material_ids.len() as u32;
            let mid = *material_ids.entry(name.clone()).or_insert_with(|| {
                out.materials.push(name.clone());
                next
            });
            let (verts, idx) = buckets.entry((p.owner, p.sky3d && p.owner == 0, mid)).or_default();
            // Re-index the used vertices of this mesh.
            let mut remap: HashMap<u32, u32> = HashMap::new();
            for &vi in tris {
                let ni = *remap.entry(vi).or_insert_with(|| {
                    let v = geo.vertices[vi as usize];
                    let pos = scaled(xf(posed([v[0], v[1], v[2]], true)));
                    let n = xf(posed([v[3], v[4], v[5]], false));
                    let id = (verts.len() / PROP_VERTEX_FLOATS) as u32;
                    verts.extend_from_slice(&[pos[0] + origin[0], pos[1] + origin[1], pos[2] + origin[2], n[0], n[1], n[2], v[6], v[7]]);
                    id
                });
                idx.push(ni);
            }
        }
    }
    let mut keys: Vec<(u32, bool, u32)> = buckets.keys().copied().collect();
    keys.sort_unstable();
    for k in keys {
        let (verts, idx) = buckets.remove(&k).unwrap();
        let base = (out.vertices.len() / PROP_VERTEX_FLOATS) as u32;
        let (owner, sky3d, material) = k;
        if owner == 0 {
            out.groups.push([material, out.indices.len() as u32, idx.len() as u32]);
            out.group_sky3d.push(sky3d);
        } else {
            out.dynamic_groups.push([owner - 1, material, out.indices.len() as u32, idx.len() as u32]);
        }
        out.vertices.extend_from_slice(&verts);
        out.indices.extend(idx.iter().map(|i| i + base));
    }
    out
}
