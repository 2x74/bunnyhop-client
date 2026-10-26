//! Render mesh extraction from BSP faces (world + brush entity models).
//!
//! Output is in Source coordinates (Z up, inches). Vertex layout is
//! `[x, y, z, nx, ny, nz, u, v, lu, lv]` with texture UVs already normalised by
//! texture size and lightmap UVs normalised to the lightmap atlas.

use crate::lightmap::{self, Atlas, LightmapRect};
use playsrc_bsp::{Bsp, DispInfo, DispVert, Edge, Face, LumpData, Model, Plane, TextureData, TextureInfo, Vertex};
use std::collections::HashMap;

pub const VERTEX_FLOATS: usize = 10;

const SURF_SKY2D: i32 = 0x2;
const SURF_SKY: i32 = 0x4;
const SURF_TRIGGER: i32 = 0x40;
const SURF_NODRAW: i32 = 0x80;
const SURF_HINT: i32 = 0x100;
const SURF_SKIP: i32 = 0x200;
const HIDDEN: i32 = SURF_SKY2D | SURF_SKY | SURF_TRIGGER | SURF_NODRAW | SURF_HINT | SURF_SKIP;

#[derive(Clone, Debug)]
pub struct Material {
    pub name: String,
    pub width: u32,
    pub height: u32,
}

/// A contiguous index range drawn with one material, belonging to one brush model.
#[derive(Clone, Copy, Debug)]
pub struct Group {
    pub model: u32,
    pub material: u32,
    pub first_index: u32,
    pub index_count: u32,
    /// In the 3D skybox set (see `skybox.rs`): drawn by the skybox pass, not the main view. A brush model's groups
    /// are all in or all out; the world (model 0) has separate groups for its skybox faces.
    pub sky3d: bool,
}

#[derive(Default)]
pub struct Mesh {
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
    pub groups: Vec<Group>,
    pub materials: Vec<Material>,
    pub lightmap: Atlas,
    /// One per vertex: displacement blend alpha for WorldVertexTransition (0 = `$basetexture`,
    /// 1 = `$basetexture2`); 0 for plain faces.
    pub blend: Vec<f32>,
    /// Water volumes (`CONTENTS_WATER`/`CONTENTS_SLIME` brushes) as `[minx, miny, minz, maxx, maxy, maxz]`
    /// (from their axial bevels; sloped brushes additionally require `water_planes`).
    pub water: Vec<[f32; 6]>,
    /// Non-axial clipping planes for each water box; keep fog out of air above sloped water.
    pub water_planes: Vec<Vec<[f32; 4]>>,
    /// Sky faces (`SURF_SKY` / `SURF_SKY2D`, e.g. `tools/toolsskybox`): not in `vertices`/`indices`, but kept
    /// as positions only (`[x, y, z]` per vertex) so the client can draw them depth-only: Source shows the
    /// skybox through them and hides everything behind them. Render-only; collision never reads this.
    pub sky_vertices: Vec<f32>,
    pub sky_indices: Vec<u32>,
    /// Per brush model with sky faces: `(model, first_index, index_count)` into `sky_indices`.
    pub sky_groups: Vec<[u32; 3]>,
    /// The map's `sky_camera` when it has a usable 3D skybox (`Group::sky3d` marks its geometry). Render-only.
    pub sky_camera: Option<crate::skybox::SkyCamera>,
}

const CONTENTS_SLIME: i32 = 0x10;
const CONTENTS_WATER: i32 = 0x20;

/// Bounding boxes of the BSP's water brushes (see `Mesh::water`).
pub fn water_volumes(bsp: &Bsp) -> Vec<[f32; 6]> {
    water_geometry(bsp).0
}

/// Axial bounds and non-axial planes in matching brush order (render-only).
pub fn water_geometry(bsp: &Bsp) -> (Vec<[f32; 6]>, Vec<Vec<[f32; 4]>>) {
    let brushes: &[playsrc_bsp::Brush] = crate::lump!(bsp, playsrc_bsp::BRUSHES, Brushes);
    let sides: &[playsrc_bsp::BrushSide] = crate::lump!(bsp, playsrc_bsp::BRUSHSIDES, BrushSides);
    let planes: &[Plane] = crate::lump!(bsp, playsrc_bsp::PLANES, Planes);
    let mut out = Vec::new();
    let mut clips = Vec::new();
    for b in brushes.iter().filter(|b| b.contents & (CONTENTS_WATER | CONTENTS_SLIME) != 0) {
        let mut bb = [f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY, f32::INFINITY, f32::INFINITY, f32::INFINITY];
        let mut clip = Vec::new();
        let first = b.first_side.max(0) as usize;
        for side in sides.iter().skip(first).take(b.side_count.max(0) as usize) {
            let Some(p) = planes.get(side.plane_index as usize) else { continue };
            let n = v3(p.normal);
            let d = p.distance.value();
            if n.iter().filter(|v| v.abs() > 0.001).count() > 1 {
                clip.push([n[0], n[1], n[2], d]);
            }
            for axis in 0..3 {
                if n[axis] > 0.999 {
                    bb[3 + axis] = bb[3 + axis].min(d);
                } else if n[axis] < -0.999 {
                    bb[axis] = bb[axis].max(-d);
                }
            }
        }
        if bb.iter().all(|v| v.is_finite()) && (0..3).all(|i| bb[i] < bb[3 + i]) {
            out.push(bb);
            clips.push(clip);
        }
    }
    (out, clips)
}

#[macro_export]
#[doc(hidden)]
macro_rules! lump {
    ($bsp:expr, $index:expr, $variant:ident) => {
        match $bsp.lump($index).map(|l| &l.records) {
            Some(LumpData::$variant(v)) => v.as_slice(),
            _ => &[],
        }
    };
}

fn v3(v: playsrc_bsp::Vector3) -> [f32; 3] {
    [v.x.value(), v.y.value(), v.z.value()]
}

pub fn texture_names(bsp: &Bsp) -> Vec<String> {
    let data = bsp.lump(playsrc_bsp::TEXDATA_STRING_DATA).map(|l| l.bytes(bsp)).unwrap_or(&[]);
    let table = bsp.lump(playsrc_bsp::TEXDATA_STRING_TABLE).map(|l| l.bytes(bsp)).unwrap_or(&[]);
    table
        .chunks_exact(4)
        .map(|c| {
            let offset = i32::from_le_bytes([c[0], c[1], c[2], c[3]]).max(0) as usize;
            let rest = data.get(offset..).unwrap_or(&[]);
            let end = rest.iter().position(|&b| b == 0).unwrap_or(rest.len());
            String::from_utf8_lossy(&rest[..end]).to_ascii_lowercase().replace('\\', "/")
        })
        .collect()
}

/// toolsblack and toolswhite are visible materials despite sharing the tool namespace.
pub fn hidden_tool_material(name: &str) -> bool {
    name.starts_with("tools/") && !matches!(name, "tools/toolsblack" | "tools/toolswhite")
}

/// Per-texinfo visibility, matching the mesh builder; used by invisible-wall overlays.
pub fn texinfo_drawn(bsp: &Bsp) -> Vec<bool> {
    let texinfo: &[TextureInfo] = crate::lump!(bsp, playsrc_bsp::TEXINFO, TextureInfo);
    let texdata: &[TextureData] = crate::lump!(bsp, playsrc_bsp::TEXDATA, TextureData);
    let names = texture_names(bsp);
    texinfo
        .iter()
        .map(|ti| {
            if ti.flags & (SURF_SKY | SURF_SKY2D) != 0 && ti.flags & (SURF_NODRAW | SURF_TRIGGER) == 0 {
                return true;
            }
            if ti.flags & HIDDEN != 0 {
                return false;
            }
            let name = texdata
                .get(ti.texture_data_index.max(0) as usize)
                .and_then(|t| names.get(t.name_string_table_index.max(0) as usize))
                .map(String::as_str)
                .unwrap_or("");
            !hidden_tool_material(name)
        })
        .collect()
}

struct Builder<'a> {
    planes: &'a [Plane],
    texdata: &'a [TextureData],
    texinfo: &'a [TextureInfo],
    vertices: &'a [Vertex],
    edges: &'a [Edge],
    surfedges: &'a [i32],
    dispinfo: &'a [DispInfo],
    dispverts: &'a [DispVert],
    names: Vec<String>,
    lm_rects: Vec<Option<LightmapRect>>,
    lm_white: [f32; 2],
    material_lookup: HashMap<i32, u32>,
    // (model, in the 3D skybox, material) -> triangle list (vertex data + local indices)
    buckets: HashMap<(u32, bool, u32), (Vec<f32>, Vec<u32>)>,
    // (model, in the 3D skybox, material) -> per-vertex blend alpha, parallel to the bucket's vertices
    blend_buckets: HashMap<(u32, bool, u32), Vec<f32>>,
    // 3D skybox membership per face index / per brush model (empty: no 3D skybox).
    face_sky: Vec<bool>,
    model_sky: Vec<bool>,
    // per model: sky face triangles (positions + local indices)
    sky_buckets: Vec<(Vec<f32>, Vec<u32>)>,
    mesh: Mesh,
}

impl<'a> Builder<'a> {
    fn material(&mut self, texdata_index: i32) -> u32 {
        if let Some(&m) = self.material_lookup.get(&texdata_index) {
            return m;
        }
        let td = self.texdata.get(texdata_index.max(0) as usize);
        let name = td
            .and_then(|t| self.names.get(t.name_string_table_index.max(0) as usize))
            .cloned()
            .unwrap_or_default();
        let id = self.mesh.materials.len() as u32;
        self.mesh.materials.push(Material {
            name,
            width: td.map(|t| t.width.max(1) as u32).unwrap_or(1),
            height: td.map(|t| t.height.max(1) as u32).unwrap_or(1),
        });
        self.material_lookup.insert(texdata_index, id);
        id
    }

    /// Bucket key of a face: (model, in the 3D skybox, material).
    fn key(&self, model: u32, face_index: usize, material: u32) -> (u32, bool, u32) {
        let sky = if model == 0 { self.face_sky.get(face_index) } else { self.model_sky.get(model as usize) };
        (model, sky.copied().unwrap_or(false), material)
    }

    fn face_polygon(&self, face: &Face) -> Vec<[f32; 3]> {
        let first = face.first_surface_edge.max(0) as usize;
        let count = face.surface_edge_count.max(0) as usize;
        let mut out = Vec::with_capacity(count);
        for &se in self.surfedges.iter().skip(first).take(count) {
            let edge = &self.edges[se.unsigned_abs() as usize];
            let vi = if se >= 0 { edge.vertex_indices[0] } else { edge.vertex_indices[1] };
            out.push(v3(self.vertices[vi as usize].position));
        }
        out
    }

    fn add_face(&mut self, model: u32, face_index: usize, face: &Face) {
        let Some(ti) = self.texinfo.get(face.texture_info_index.max(0) as usize).copied() else { return };
        if face.texture_info_index < 0 {
            return;
        }
        if ti.flags & (SURF_SKY | SURF_SKY2D) != 0 && ti.flags & (SURF_NODRAW | SURF_TRIGGER) == 0 {
            self.add_sky_face(model, face);
            return;
        }
        if ti.flags & HIDDEN != 0 {
            return;
        }
        let material = self.material(ti.texture_data_index);
        let mat = &self.mesh.materials[material as usize];
        if hidden_tool_material(&mat.name) {
            return;
        }
        let (w, h) = (mat.width as f32, mat.height as f32);
        let tv = ti.texture_vectors.map(|row| row.map(|f| f.value()));
        let uv = |p: [f32; 3]| -> [f32; 2] {
            [
                (p[0] * tv[0][0] + p[1] * tv[0][1] + p[2] * tv[0][2] + tv[0][3]) / w,
                (p[0] * tv[1][0] + p[1] * tv[1][1] + p[2] * tv[1][2] + tv[1][3]) / h,
            ]
        };
        // Face planes are already oriented (vbsp picks the plane of the pair facing out),
        // so `face.side` must not flip the normal.
        let normal = v3(self.planes[face.plane_index as usize].normal);
        let polygon = self.face_polygon(face);
        if polygon.len() < 3 {
            return;
        }

        let rect = self.lm_rects.get(face_index).copied().flatten();
        let lv = ti.lightmap_vectors.map(|row| row.map(|f| f.value()));
        let mins = face.lightmap_mins.map(|m| m as f32);
        // Luxel-space coordinates (0..=lightmap_size) of a point on the face plane.
        let luxel = |p: [f32; 3]| -> [f32; 2] {
            [
                p[0] * lv[0][0] + p[1] * lv[0][1] + p[2] * lv[0][2] + lv[0][3] - mins[0],
                p[0] * lv[1][0] + p[1] * lv[1][1] + p[2] * lv[1][2] + lv[1][3] - mins[1],
            ]
        };
        let white = self.lm_white;
        let atlas = (self.mesh.lightmap.width as f32, self.mesh.lightmap.height as f32);
        let lm_uv = move |l: [f32; 2]| -> [f32; 2] {
            match rect {
                Some(r) => [(r.x as f32 + l[0] + 0.5) / atlas.0, (r.y as f32 + l[1] + 0.5) / atlas.1],
                None => white,
            }
        };

        if face.displacement_info_index >= 0 {
            // Displacement lightmaps span the whole luxel rectangle regardless of the base
            // quad's shape: snap each corner's luxel coordinate to the rectangle corner.
            let size = face.lightmap_size.map(|s| s.max(0) as f32);
            let corner_luxels: Vec<[f32; 2]> = polygon
                .iter()
                .map(|&p| {
                    let l = luxel(p);
                    [if l[0] > size[0] * 0.5 { size[0] } else { 0.0 }, if l[1] > size[1] * 0.5 { size[1] } else { 0.0 }]
                })
                .collect();
            let key = self.key(model, face_index, material);
            self.add_displacement(key, face, &polygon, &corner_luxels, normal, &uv, &lm_uv);
            return;
        }

        let key = self.key(model, face_index, material);
        let (verts, idx) = self.buckets.entry(key).or_default();
        self.blend_buckets.entry(key).or_default().extend(std::iter::repeat_n(0.0, polygon.len()));
        let base = (verts.len() / VERTEX_FLOATS) as u32;
        for p in &polygon {
            let t = uv(*p);
            let l = lm_uv(luxel(*p));
            verts.extend_from_slice(&[p[0], p[1], p[2], normal[0], normal[1], normal[2], t[0], t[1], l[0], l[1]]);
        }
        for i in 1..polygon.len() as u32 - 1 {
            // Source winds faces clockwise seen from the front; emit CCW for GL front faces.
            idx.extend_from_slice(&[base, base + i + 1, base + i]);
        }
    }

    /// A sky face as its flat base polygon (positions only; see `Mesh::sky_vertices`).
    fn add_sky_face(&mut self, model: u32, face: &Face) {
        let polygon = self.face_polygon(face);
        if polygon.len() < 3 {
            return;
        }
        let m = model as usize;
        if self.sky_buckets.len() <= m {
            self.sky_buckets.resize_with(m + 1, Default::default);
        }
        let (verts, idx) = &mut self.sky_buckets[m];
        let base = (verts.len() / 3) as u32;
        for p in &polygon {
            verts.extend_from_slice(p);
        }
        for i in 1..polygon.len() as u32 - 1 {
            idx.extend_from_slice(&[base, base + i + 1, base + i]);
        }
    }

    fn add_displacement(
        &mut self,
        key: (u32, bool, u32),
        face: &Face,
        polygon: &[[f32; 3]],
        corner_luxels: &[[f32; 2]],
        normal: [f32; 3],
        uv: &dyn Fn([f32; 3]) -> [f32; 2],
        lm_uv: &dyn Fn([f32; 2]) -> [f32; 2],
    ) {
        let Some(info) = self.dispinfo.get(face.displacement_info_index as usize) else { return };
        if polygon.len() != 4 {
            return;
        }
        let start = v3(info.start_position);
        let dist2 = |a: [f32; 3]| (a[0] - start[0]).powi(2) + (a[1] - start[1]).powi(2) + (a[2] - start[2]).powi(2);
        let first = (0..4).min_by(|&a, &b| dist2(polygon[a]).total_cmp(&dist2(polygon[b]))).unwrap();
        let c: Vec<[f32; 3]> = (0..4).map(|i| polygon[(first + i) % 4]).collect();
        let cl: Vec<[f32; 2]> = (0..4).map(|i| corner_luxels[(first + i) % 4]).collect();
        let lerp2 = |a: [f32; 2], b: [f32; 2], t: f32| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        let size = (1usize << info.power.clamp(1, 4)) + 1;
        let lerp = |a: [f32; 3], b: [f32; 3], t: f32| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

        let (verts, idx) = self.buckets.entry(key).or_default();
        let blend = self.blend_buckets.entry(key).or_default();
        let base = (verts.len() / VERTEX_FLOATS) as u32;
        for y in 0..size {
            let ty = y as f32 / (size - 1) as f32;
            let left = lerp(c[0], c[1], ty);
            let right = lerp(c[3], c[2], ty);
            let lleft = lerp2(cl[0], cl[1], ty);
            let lright = lerp2(cl[3], cl[2], ty);
            for x in 0..size {
                let tx = x as f32 / (size - 1) as f32;
                let flat = lerp(left, right, tx);
                let dv = self.dispverts.get(info.vertex_start as usize + y * size + x);
                let p = match dv {
                    Some(d) => {
                        let v = v3(d.vector);
                        let s = d.distance.value();
                        [flat[0] + v[0] * s, flat[1] + v[1] * s, flat[2] + v[2] * s]
                    }
                    None => flat,
                };
                let t = uv(flat);
                let l = lm_uv(lerp2(lleft, lright, tx));
                blend.push(dv.map_or(0.0, |d| (d.alpha.value() / 255.0).clamp(0.0, 1.0)));
                verts.extend_from_slice(&[p[0], p[1], p[2], normal[0], normal[1], normal[2], t[0], t[1], l[0], l[1]]);
            }
        }
        let s = size as u32;
        for y in 0..s - 1 {
            for x in 0..s - 1 {
                let i = base + y * s + x;
                // Alternate diagonals like Source's displacement tessellation.
                if (y * s + x) % 2 == 1 {
                    idx.extend_from_slice(&[i, i + 1, i + s, i + 1, i + s + 1, i + s]);
                } else {
                    idx.extend_from_slice(&[i, i + s + 1, i + s, i, i + 1, i + s + 1]);
                }
            }
        }
        // Recompute smooth normals for the displaced grid.
        let n = (s * s) as usize;
        let vbase = base as usize;
        let mut acc = vec![[0f32; 3]; n];
        let tri_start = idx.len() - ((s - 1) * (s - 1) * 6) as usize;
        for tri in idx[tri_start..].chunks_exact(3) {
            let p = |k: u32| {
                let o = k as usize * VERTEX_FLOATS;
                [verts[o], verts[o + 1], verts[o + 2]]
            };
            let (a, b, cc) = (p(tri[0]), p(tri[1]), p(tri[2]));
            let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let e2 = [cc[0] - a[0], cc[1] - a[1], cc[2] - a[2]];
            let fnorm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            for &k in tri {
                let a = &mut acc[k as usize - vbase];
                a[0] += fnorm[0];
                a[1] += fnorm[1];
                a[2] += fnorm[2];
            }
        }
        for (k, a) in acc.iter().enumerate() {
            let len = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
            let mut nn = if len > 0.0 { [a[0] / len, a[1] / len, a[2] / len] } else { normal };
            // Keep winding-consistent with the base face.
            if nn[0] * normal[0] + nn[1] * normal[1] + nn[2] * normal[2] < 0.0 {
                nn = nn.map(|v| -v);
            }
            let o = (vbase + k) * VERTEX_FLOATS + 3;
            verts[o..o + 3].copy_from_slice(&nn);
        }
    }
}

pub fn build(bsp: &Bsp) -> Mesh {
    let faces: &[Face] = lump!(bsp, playsrc_bsp::FACES, Faces);
    let texinfo: &[TextureInfo] = lump!(bsp, playsrc_bsp::TEXINFO, TextureInfo);
    let lm = lightmap::build(bsp, faces, texinfo);
    let skybox = crate::skybox::find(bsp, &crate::entities::parse(&crate::content::entity_text(bsp)));
    let skybox = skybox.as_ref();
    let (water, water_planes) = water_geometry(bsp);
    let mut b = Builder {
        planes: lump!(bsp, playsrc_bsp::PLANES, Planes),
        texdata: lump!(bsp, playsrc_bsp::TEXDATA, TextureData),
        texinfo: lump!(bsp, playsrc_bsp::TEXINFO, TextureInfo),
        vertices: lump!(bsp, playsrc_bsp::VERTEXES, Vertices),
        edges: lump!(bsp, playsrc_bsp::EDGES, Edges),
        surfedges: lump!(bsp, playsrc_bsp::SURFEDGES, SurfaceEdges),
        dispinfo: lump!(bsp, playsrc_bsp::DISPINFO, DispInfo),
        dispverts: lump!(bsp, playsrc_bsp::DISP_VERTS, DispVertices),
        names: texture_names(bsp),
        lm_rects: lm.rects,
        lm_white: lm.white_uv,
        material_lookup: HashMap::new(),
        buckets: HashMap::new(),
        blend_buckets: HashMap::new(),
        face_sky: skybox.map(|s| s.faces.clone()).unwrap_or_default(),
        model_sky: skybox.map(|s| s.models.clone()).unwrap_or_default(),
        sky_buckets: Vec::new(),
        mesh: Mesh { lightmap: lm.atlas, water, water_planes, sky_camera: skybox.map(|s| s.camera.clone()), ..Mesh::default() },
    };
    let models: &[Model] = lump!(bsp, playsrc_bsp::MODELS, Models);
    for (mi, model) in models.iter().enumerate() {
        let first = model.first_face.max(0) as usize;
        let count = model.face_count.max(0) as usize;
        for (fi, face) in faces.iter().enumerate().skip(first).take(count) {
            b.add_face(mi as u32, fi, face);
        }
    }

    // Static skybox brush models: moved to their entity origin and merged into the world's skybox groups.
    let merge: Vec<(u32, [f32; 3])> = skybox.iter().flat_map(|s| s.merge.iter().enumerate().filter_map(|(m, o)| o.map(|o| (m as u32, o)))).collect();
    for (model, off) in merge {
        let mut keys: Vec<_> = b.buckets.keys().filter(|k| k.0 == model).copied().collect();
        keys.sort_unstable();
        for key in keys {
            let (mut verts, idx) = b.buckets.remove(&key).unwrap();
            for v in verts.chunks_exact_mut(VERTEX_FLOATS) {
                (0..3).for_each(|k| v[k] += off[k]);
            }
            let dst_key = (0, true, key.2);
            let blend = b.blend_buckets.remove(&key).unwrap_or_default();
            let dst = b.buckets.entry(dst_key).or_default();
            let base = (dst.0.len() / VERTEX_FLOATS) as u32;
            dst.0.extend_from_slice(&verts);
            dst.1.extend(idx.iter().map(|i| i + base));
            b.blend_buckets.entry(dst_key).or_default().extend(blend);
        }
        if let Some((verts, idx)) = b.sky_buckets.get_mut(model as usize).map(std::mem::take) {
            let dst = &mut b.sky_buckets[0];
            let base = (dst.0.len() / 3) as u32;
            dst.0.extend(verts.chunks_exact(3).flat_map(|p| [p[0] + off[0], p[1] + off[1], p[2] + off[2]]));
            dst.1.extend(idx.iter().map(|i| i + base));
        }
    }

    // Flatten buckets into one vertex/index buffer, ordered for stable output.
    let mut keys: Vec<_> = b.buckets.keys().copied().collect();
    keys.sort_unstable();
    for key in keys {
        let (verts, idx) = b.buckets.remove(&key).unwrap();
        let base = (b.mesh.vertices.len() / VERTEX_FLOATS) as u32;
        let first_index = b.mesh.indices.len() as u32;
        b.mesh.vertices.extend_from_slice(&verts);
        b.mesh.blend.extend(b.blend_buckets.remove(&key).unwrap_or_default());
        b.mesh.indices.extend(idx.iter().map(|i| i + base));
        b.mesh.groups.push(Group {
            model: key.0,
            material: key.2,
            first_index,
            index_count: idx.len() as u32,
            sky3d: key.1,
        });
    }
    for (model, (verts, idx)) in b.sky_buckets.into_iter().enumerate().filter(|(_, (_, idx))| !idx.is_empty()) {
        let base = (b.mesh.sky_vertices.len() / 3) as u32;
        let first_index = b.mesh.sky_indices.len() as u32;
        b.mesh.sky_vertices.extend_from_slice(&verts);
        b.mesh.sky_indices.extend(idx.iter().map(|i| i + base));
        b.mesh.sky_groups.push([model as u32, first_index, idx.len() as u32]);
    }
    b.mesh
}
