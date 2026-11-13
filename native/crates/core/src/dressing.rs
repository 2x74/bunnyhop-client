//! Map dressing for the renderer (render-only: nothing here is read by collision, triggers or the sim).
//!
//! * **Overlays** (`info_overlay`, compiled into `LUMP_OVERLAYS` 45 with fade distances in `LUMP_OVERLAY_FADES` 60):
//!   a textured quad in its own basis, clipped to the faces it lists, as the engine's `COverlayMgr` builds them. The
//!   basis U is stored in the z of the first three UV points, V = N x U, flipped when the fourth's z is 1.
//! * **Infodecals** (`infodecal`, placed by the server at spawn through `engine->StaticDecal`): `R_DecalShoot` stamps
//!   the decal on every world face whose plane is within 4 units of its origin, in a basis from the face normal
//!   (`R_DecalComputeBasis` without an s axis), sized by the base texture times `$decalscale`. The size is only known
//!   once the material's files are loaded, so decals are built by `Dressing::build` with a size lookup.
//! * **Glows and beams** (`env_sprite` / `env_glow`, `env_lightglow`, `point_spotlight`): placement and keys only,
//!   drawn by the client. Entities that map logic switches at runtime (anything an output targets) are left out, since
//!   the sim doesn't track their state, and so are sprites that start off or play once. A spotlight's beam ends where
//!   the engine's trace from its origin would (`Lighting::hit_leaving`: through the lamp brush it starts in).
//!
//! Geometry uses the world mesh's vertex layout (`mesh::VERTEX_FLOATS`: position, normal, texture uv, lightmap uv,
//! taken from the face it lies on) plus the overlay's fade (origin, min and max distance squared; 0 = no fade).

use crate::entities::{name_matches, Entity, Output};
use crate::mesh::VERTEX_FLOATS as WORLD_FLOATS;
use std::collections::{HashMap, HashSet};

/// Floats per dressing vertex: the world mesh's ten, then fade origin xyz, fade min², fade max².
pub const VERTEX_FLOATS: usize = WORLD_FLOATS + 5;

const OVERLAYS: usize = 45;
const OVERLAY_FADES: usize = 60;
const OVERLAY_SIZE: usize = 352;
const OVERLAY_FACES: usize = 64;
/// `R_DecalNode`: faces on planes this close to the decal's origin take it.
const DECAL_DISTANCE: f32 = 4.0;
/// Overlay fragments sit this far off their face (`OVERLAY_AVOID_FLICKER_NORMAL_OFFSET`); the client adds a depth bias.
const OVERLAY_OFFSET: f32 = 0.1;
/// Decal candidates are kept for faces within this distance (in the face plane) of the origin; the real size is
/// checked by the clip.
const DECAL_REACH: f32 = 1024.0;
const SURF_WARP: i32 = 0x8;
const SURF_NODECALS: i32 = 0x2000;

/// A world face's triangles as the mesh draws them (captured by `mesh::build` for the faces `Plan::faces` names).
#[derive(Clone, Debug, Default)]
pub struct FaceTris {
    /// `mesh::VERTEX_FLOATS` per vertex.
    pub verts: Vec<f32>,
    /// Positions before displacement (the same as `verts` for a flat face): overlays project in the base face.
    pub flat: Vec<[f32; 3]>,
    pub tris: Vec<u32>,
    pub normal: [f32; 3],
    pub disp: bool,
    pub sky3d: bool,
}

#[derive(Clone, Debug)]
struct Overlay {
    material: u32,
    order: u32,
    origin: [f32; 3],
    u: [f32; 3],
    v: [f32; 3],
    corners: [[f32; 2]; 4],
    tex: [[f32; 2]; 4],
    faces: Vec<usize>,
    /// (min², max²) view distance from the origin; max 0 = no fade.
    fade: [f32; 2],
}

#[derive(Clone, Debug)]
struct Decal {
    material: u32,
    origin: [f32; 3],
    faces: Vec<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum GlowKind {
    /// `env_sprite` / `env_glow`.
    Sprite = 0,
    /// `env_lightglow`.
    LightGlow = 1,
    /// `point_spotlight`: beam and halo.
    Spotlight = 2,
}

/// One glow or beam. Colours are the keyvalues (0..255).
#[derive(Clone, Debug, PartialEq)]
pub struct Glow {
    pub kind: GlowKind,
    /// Index into `Dressing::materials`: the sprite, the light glow's `sprites/light_glow03`, the beam's
    /// `sprites/glow_test02`.
    pub material: u32,
    pub origin: [f32; 3],
    pub color: [f32; 3],
    /// `renderamt`.
    pub alpha: f32,
    pub render_mode: u32,
    pub render_fx: u32,
    /// Sprite: `scale`. Light glow: `HorizontalGlowSize`. Spotlight: `spotlightwidth`.
    pub size: f32,
    /// Sprite: `framerate`. Light glow: `VerticalGlowSize`. Spotlight: the beam's length to what it hits.
    pub size2: f32,
    pub hdr_scale: f32,
    /// Sprite: `angles`. Light glow and spotlight: the forward direction of `angles`.
    pub dir: [f32; 3],
    /// Sprite: `GlowProxySize`. Light glow: `MinDist`, `MaxDist`, `OuterMaxDist`, `GlowProxySize`. Spotlight:
    /// `spotlightlength`.
    pub dist: [f32; 4],
    pub spawnflags: u32,
    /// The brush model it rides on (`parentname`), with that entity's spawn origin and angles; -1 for none.
    pub parent_model: i32,
    pub parent_origin: [f32; 3],
    pub parent_angles: [f32; 3],
}

/// Floats per glow in the `dressing_glows` export.
pub const GLOW_FLOATS: usize = 30;

impl Glow {
    pub fn floats(&self) -> [f32; GLOW_FLOATS] {
        let mut f = [0f32; GLOW_FLOATS];
        f[0] = self.kind as u32 as f32;
        f[1] = self.material as f32;
        f[2..5].copy_from_slice(&self.origin);
        f[5..8].copy_from_slice(&self.color);
        f[8] = self.alpha;
        f[9] = self.render_mode as f32;
        f[10] = self.render_fx as f32;
        f[11] = self.size;
        f[12] = self.size2;
        f[13] = self.hdr_scale;
        f[14..17].copy_from_slice(&self.dir);
        f[17..21].copy_from_slice(&self.dist);
        f[21] = self.spawnflags as f32;
        f[22] = self.parent_model as f32;
        f[23..26].copy_from_slice(&self.parent_origin);
        f[26..29].copy_from_slice(&self.parent_angles);
        f
    }
}

impl Glow {
    /// Drawn on top of everything (no depth test) and faded by whether its origin can be seen: the Glow and World Space
    /// Glow render modes, light glows, a spotlight's halo (CS:S's pixel visibility queries).
    pub fn ignores_depth(&self) -> bool {
        self.kind != GlowKind::Sprite || matches!(self.render_mode, 3 | 9)
    }

    /// Where the visibility test aims: the origin, short of it by the glow's proxy size (and 2 units more), so a glow
    /// set against a wall isn't hidden by that wall.
    pub fn visibility_target(&self, eye: [f32; 3]) -> [f32; 3] {
        let proxy = match self.kind {
            GlowKind::Sprite => self.dist[0],
            GlowKind::LightGlow => self.dist[3],
            GlowKind::Spotlight => 2.0,
        };
        let d = sub(eye, self.origin);
        let len = dot(d, d).sqrt();
        let back = (proxy.max(2.0) + 2.0).min(len * 0.5);
        if len > 0.0 { [0, 1, 2].map(|k| self.origin[k] + d[k] / len * back) } else { self.origin }
    }
}

/// A run of dressing triangles with one material.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DressGroup {
    pub material: u32,
    pub first_index: u32,
    pub index_count: u32,
    /// 0 = overlay, 1 = decal. Overlays draw first, then decals, as the engine does.
    pub kind: u32,
    /// The overlay's render order (0..3), drawn in that order; 0 for decals.
    pub order: u32,
    /// On a 3D skybox face (drawn by the skybox pass).
    pub sky3d: bool,
}

#[derive(Default)]
pub struct Dressing {
    /// Material names (lower case, `/`, no `materials/` or extension) the geometry and glows use.
    pub materials: Vec<String>,
    /// Captured triangles of every face an overlay or decal may land on (by face index).
    pub faces: HashMap<usize, FaceTris>,
    overlays: Vec<Overlay>,
    decals: Vec<Decal>,
    pub glows: Vec<Glow>,
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
    pub groups: Vec<DressGroup>,
}

fn raw(bsp: &playsrc_bsp::Bsp, index: usize) -> &[u8] {
    bsp.lump(index).map(|l| l.bytes(bsp)).unwrap_or(&[])
}

fn f32_at(b: &[u8], o: usize) -> f32 {
    f32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

fn vec_at(b: &[u8], o: usize) -> [f32; 3] {
    [f32_at(b, o), f32_at(b, o + 4), f32_at(b, o + 8)]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn normalize(a: [f32; 3]) -> [f32; 3] {
    let l = dot(a, a).sqrt();
    if l > 0.0 { a.map(|v| v / l) } else { a }
}

/// Source `AngleVectors` forward of (pitch, yaw, roll) in degrees.
pub fn forward(angles: [f32; 3]) -> [f32; 3] {
    let (p, y) = (angles[0].to_radians(), angles[1].to_radians());
    [p.cos() * y.cos(), p.cos() * y.sin(), -p.sin()]
}

/// A material name as the engine looks it up: `materials/` and the extension dropped (a sprite model `.spr` names the
/// VMT of the same name), lower case with forward slashes.
pub fn material_name(s: &str) -> String {
    let n = s.trim().replace('\\', "/").to_ascii_lowercase();
    let n = n.trim_start_matches('/');
    let n = n.strip_prefix("materials/").unwrap_or(n);
    let n = n.strip_suffix(".vmt").or_else(|| n.strip_suffix(".spr")).unwrap_or(n);
    n.to_string()
}

struct Names(Vec<String>, HashMap<String, u32>);

impl Names {
    fn id(&mut self, name: String) -> u32 {
        if let Some(&i) = self.1.get(&name) {
            return i;
        }
        let i = self.0.len() as u32;
        self.1.insert(name.clone(), i);
        self.0.push(name);
        i
    }
}

/// What `mesh::build` needs before it walks the faces: the dressing's placements and the faces to capture.
pub struct Plan {
    pub dressing: Dressing,
    pub faces: HashSet<usize>,
}

/// Runtime-switched entities: names any output (or an `AddOutput` it carries) aims at, and class names aimed at.
fn targeted(entities: &[Entity]) -> Vec<String> {
    let mut out = Vec::new();
    for e in entities {
        for o in e.outputs() {
            out.push(o.target.to_string());
            if o.input.eq_ignore_ascii_case("addoutput") {
                if let Some(inner) = Output::parse_add_output(&o.param) {
                    out.push(inner.target.to_string());
                }
            }
        }
    }
    out.retain(|t| !t.is_empty() && !t.starts_with('!'));
    out
}

fn switched(e: &Entity, targets: &[String]) -> bool {
    let name = e.get("targetname").unwrap_or("").trim();
    let class = e.classname();
    targets.iter().any(|t| (!name.is_empty() && name_matches(t, name)) || t.eq_ignore_ascii_case(class))
}

fn color(e: &Entity, key: &str) -> [f32; 3] {
    let Some(v) = e.get(key) else { return [255.0; 3] };
    let mut it = v.split_whitespace().map(|s| s.parse::<f32>().unwrap_or(0.0));
    [it.next().unwrap_or(0.0), it.next().unwrap_or(0.0), it.next().unwrap_or(0.0)]
}

fn number(e: &Entity, key: &str, default: f32) -> f32 {
    e.float(key).unwrap_or(default)
}

/// Glows and beams (module docs). `hit(a, b)`: the fraction of `a -> b` before the first solid world brush, 1 if none.
pub fn glows(entities: &[Entity], names: &mut impl FnMut(String) -> u32, hit: &dyn Fn([f32; 3], [f32; 3]) -> f32) -> Vec<Glow> {
    let targets = targeted(entities);
    let by_name: HashMap<String, &Entity> =
        entities.iter().filter_map(|e| Some((e.get("targetname")?.trim().to_ascii_lowercase(), e))).filter(|(n, _)| !n.is_empty()).collect();
    let mut out = Vec::new();
    for e in entities {
        let class = e.classname().to_ascii_lowercase();
        let kind = match class.as_str() {
            "env_sprite" | "env_glow" => GlowKind::Sprite,
            "env_lightglow" => GlowKind::LightGlow,
            "point_spotlight" => GlowKind::Spotlight,
            _ => continue,
        };
        if switched(e, &targets) {
            continue;
        }
        let flags = e.int("spawnflags") as u32;
        let named = e.get("targetname").is_some_and(|n| !n.trim().is_empty());
        let mode = e.int("rendermode") as u32;
        // (parent brush model, its origin, its angles); a parent that isn't a brush entity: not drawn.
        let mut parent = (-1i32, [0f32; 3], [0f32; 3]);
        if let Some(p) = e.get("parentname").map(str::trim).filter(|p| !p.is_empty()) {
            let Some(model) = by_name.get(&p.to_ascii_lowercase()).and_then(|pe| Some((pe.brush_model()?, pe))) else { continue };
            parent = (model.0 as i32, model.1.origin(), model.1.angles());
        }
        let base = Glow {
            kind,
            material: 0,
            origin: e.origin(),
            color: color(e, "rendercolor"),
            alpha: number(e, "renderamt", 255.0),
            render_mode: mode,
            render_fx: e.int("renderfx") as u32,
            size: 0.0,
            size2: 0.0,
            hdr_scale: number(e, "HDRColorScale", 1.0),
            dir: [0.0; 3],
            dist: [0.0; 4],
            spawnflags: flags,
            parent_model: parent.0,
            parent_origin: parent.1,
            parent_angles: parent.2,
        };
        let glow = match kind {
            GlowKind::Sprite => {
                // CSprite::Spawn: a named sprite starts off unless flagged on; "play once" turns itself off.
                let model = e.get("model").map(material_name).unwrap_or_default();
                if (named && flags & 1 == 0) || flags & 2 != 0 || mode == 10 || model.is_empty() {
                    continue;
                }
                Glow {
                    material: names(model),
                    size: number(e, "scale", 1.0),
                    size2: number(e, "framerate", 10.0),
                    dir: e.angles(),
                    dist: [number(e, "GlowProxySize", 2.0), 0.0, 0.0, 0.0],
                    ..base
                }
            }
            GlowKind::LightGlow => Glow {
                material: names("sprites/light_glow03".into()),
                size: number(e, "HorizontalGlowSize", 0.0),
                size2: number(e, "VerticalGlowSize", 0.0),
                dir: forward(e.angles()),
                dist: [number(e, "MinDist", 500.0), number(e, "MaxDist", 2000.0), number(e, "OuterMaxDist", 0.0), number(e, "GlowProxySize", 2.0)],
                ..base
            },
            GlowKind::Spotlight => {
                // Starts on with spawnflag 1; one that follows a moving parent re-traces as it moves: not drawn.
                if flags & 1 == 0 || parent.0 >= 0 {
                    continue;
                }
                let dir = forward(e.angles());
                let length = number(e, "spotlightlength", 500.0);
                let o = e.origin();
                let end = [0, 1, 2].map(|k| o[k] + dir[k] * length);
                let len = length * hit(o, end).clamp(0.0, 1.0);
                names("sprites/light_glow03".into());
                Glow { material: names("sprites/glow_test02".into()), size: number(e, "spotlightwidth", 50.0), size2: len, dir, dist: [length, 0.0, 0.0, 0.0], ..base }
            }
        };
        out.push(glow);
    }
    out
}

/// Placements read from the BSP and entities (`mesh::build` captures `Plan::faces` and calls `Dressing::build`).
pub fn plan(bsp: &playsrc_bsp::Bsp, entities: &[Entity], hit: &dyn Fn([f32; 3], [f32; 3]) -> f32) -> Plan {
    use playsrc_bsp::{Edge, Face, LumpData, Model, Plane, TextureData, TextureInfo, Vertex};
    let faces: &[Face] = crate::lump!(bsp, playsrc_bsp::FACES, Faces);
    let texinfo: &[TextureInfo] = crate::lump!(bsp, playsrc_bsp::TEXINFO, TextureInfo);
    let texdata: &[TextureData] = crate::lump!(bsp, playsrc_bsp::TEXDATA, TextureData);
    let planes: &[Plane] = crate::lump!(bsp, playsrc_bsp::PLANES, Planes);
    let models: &[Model] = crate::lump!(bsp, playsrc_bsp::MODELS, Models);
    let vertices: &[Vertex] = crate::lump!(bsp, playsrc_bsp::VERTEXES, Vertices);
    let edges: &[Edge] = crate::lump!(bsp, playsrc_bsp::EDGES, Edges);
    let surfedges: &[i32] = crate::lump!(bsp, playsrc_bsp::SURFEDGES, SurfaceEdges);
    let tex_names = crate::mesh::texture_names(bsp);
    let mut names = Names(Vec::new(), HashMap::new());
    let mut want = HashSet::new();
    let world = models.first().map_or(0..0, |m| m.first_face.max(0) as usize..(m.first_face.max(0) + m.face_count.max(0)) as usize);

    let mut overlays = Vec::new();
    let b = raw(bsp, OVERLAYS);
    let fades = raw(bsp, OVERLAY_FADES);
    for i in 0..b.len() / OVERLAY_SIZE {
        let o = i * OVERLAY_SIZE;
        let ti = i16::from_le_bytes([b[o + 4], b[o + 5]]);
        let packed = u16::from_le_bytes([b[o + 6], b[o + 7]]);
        let count = ((packed & 0x3fff) as usize).min(OVERLAY_FACES);
        let Some(name) = texinfo
            .get(ti.max(0) as usize)
            .filter(|_| ti >= 0)
            .and_then(|t| texdata.get(t.texture_data_index.max(0) as usize))
            .and_then(|t| tex_names.get(t.name_string_table_index.max(0) as usize))
        else {
            continue;
        };
        let list: Vec<usize> = (0..count)
            .map(|k| i32::from_le_bytes([b[o + 8 + k * 4], b[o + 9 + k * 4], b[o + 10 + k * 4], b[o + 11 + k * 4]]))
            .filter(|&f| f >= 0 && world.contains(&(f as usize)))
            .map(|f| f as usize)
            .collect();
        if list.is_empty() {
            continue;
        }
        let uvp: [[f32; 3]; 4] = std::array::from_fn(|k| vec_at(b, o + 280 + k * 12));
        let n = normalize(vec_at(b, o + 340));
        let u = normalize([uvp[0][2], uvp[1][2], uvp[2][2]]);
        if dot(u, u) == 0.0 || dot(n, n) == 0.0 {
            continue;
        }
        let mut v = normalize(cross(n, u));
        if uvp[3][2] == 1.0 {
            v = v.map(|x| -x);
        }
        let (u0, u1, v0, v1) = (f32_at(b, o + 264), f32_at(b, o + 268), f32_at(b, o + 272), f32_at(b, o + 276));
        let fade = if fades.len() >= (i + 1) * 8 { [f32_at(fades, i * 8), f32_at(fades, i * 8 + 4)] } else { [0.0; 2] };
        want.extend(list.iter().copied());
        overlays.push(Overlay {
            material: names.id(name.clone()),
            order: (packed >> 14) as u32,
            origin: vec_at(b, o + 328),
            u,
            v,
            corners: uvp.map(|p| [p[0], p[1]]),
            tex: [[u0, v0], [u0, v1], [u1, v1], [u1, v0]],
            faces: list,
            fade: if fade[1] > 0.0 { fade } else { [0.0; 2] },
        });
    }

    // Infodecals: candidate world faces near each origin (a named one waits for an input that never comes here).
    let decal_ents: Vec<(String, [f32; 3])> = entities
        .iter()
        .filter(|e| e.classname().eq_ignore_ascii_case("infodecal") && e.get("targetname").is_none_or(|n| n.trim().is_empty()))
        .filter_map(|e| Some((material_name(e.get("texture")?), e.origin())))
        .filter(|(n, _)| !n.is_empty())
        .collect();
    let mut decals = Vec::new();
    if !decal_ents.is_empty() {
        // (face, plane normal, plane distance, bounds) of the world faces that can take a decal.
        let mut cands = Vec::new();
        for fi in world.clone() {
            let Some(f) = faces.get(fi) else { continue };
            let Some(ti) = texinfo.get(f.texture_info_index.max(0) as usize).filter(|_| f.texture_info_index >= 0) else { continue };
            if ti.flags & (SURF_NODECALS | SURF_WARP) != 0 {
                continue;
            }
            let Some(p) = planes.get(f.plane_index as usize) else { continue };
            let normal = [p.normal.x.value(), p.normal.y.value(), p.normal.z.value()];
            let mut lo = [f32::INFINITY; 3];
            let mut hi = [f32::NEG_INFINITY; 3];
            let first = f.first_surface_edge.max(0) as usize;
            for &se in surfedges.iter().skip(first).take(f.surface_edge_count.max(0) as usize) {
                let Some(edge) = edges.get(se.unsigned_abs() as usize) else { continue };
                let vi = if se >= 0 { edge.vertex_indices[0] } else { edge.vertex_indices[1] };
                let Some(v) = vertices.get(vi as usize) else { continue };
                let q = [v.position.x.value(), v.position.y.value(), v.position.z.value()];
                for k in 0..3 {
                    lo[k] = lo[k].min(q[k]);
                    hi[k] = hi[k].max(q[k]);
                }
            }
            cands.push((fi, normal, p.distance.value(), lo, hi));
        }
        for (name, origin) in decal_ents {
            let list: Vec<usize> = cands
                .iter()
                .filter(|(_, n, d, lo, hi)| {
                    (dot(*n, origin) - d).abs() < DECAL_DISTANCE && (0..3).all(|k| origin[k] > lo[k] - DECAL_REACH && origin[k] < hi[k] + DECAL_REACH)
                })
                .map(|c| c.0)
                .collect();
            if list.is_empty() {
                continue;
            }
            want.extend(list.iter().copied());
            decals.push(Decal { material: names.id(name), origin, faces: list });
        }
    }

    let mut id = |n: String| names.id(n);
    let glows = glows(entities, &mut id, hit);
    Plan { dressing: Dressing { materials: names.0, overlays, decals, glows, ..Dressing::default() }, faces: want }
}

/// A 2D polygon vertex: position in the clip plane and texture coordinate.
#[derive(Clone, Copy, Debug)]
struct V2 {
    p: [f32; 2],
    t: [f32; 2],
}

/// Keeps the part of `poly` where `a·p + c >= 0`.
fn clip(poly: &[V2], a: [f32; 2], c: f32) -> Vec<V2> {
    let side = |v: &V2| a[0] * v.p[0] + a[1] * v.p[1] + c;
    let mut out = Vec::with_capacity(poly.len() + 2);
    for i in 0..poly.len() {
        let (p, q) = (poly[i], poly[(i + 1) % poly.len()]);
        let (dp, dq) = (side(&p), side(&q));
        if dp >= 0.0 {
            out.push(p);
        }
        if (dp >= 0.0) != (dq >= 0.0) {
            let t = dp / (dp - dq);
            let lerp = |x: [f32; 2], y: [f32; 2]| [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t];
            out.push(V2 { p: lerp(p.p, q.p), t: lerp(p.t, q.t) });
        }
    }
    out
}

/// Clips `subject` to triangle `tri` (2D), then lifts each vertex onto the face by its barycentric coordinates in
/// it: `src` are the face's world vertices (WORLD_FLOATS each) at the triangle's corners. Appends to `verts` / `idx`,
/// facing the way the triangle does.
fn stamp(subject: &[V2], tri: [[f32; 2]; 3], src: [&[f32]; 3], offset: f32, fade: [f32; 5], verts: &mut Vec<f32>, idx: &mut Vec<u32>) {
    let [a, b, c] = tri;
    let area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if area.abs() < 1e-4 {
        return;
    }
    let s = area.signum();
    let mut poly = subject.to_vec();
    for (p, q) in [(a, b), (b, c), (c, a)] {
        // Inside: on the triangle's side of the edge p -> q.
        let e = [q[0] - p[0], q[1] - p[1]];
        let n = [-e[1] * s, e[0] * s];
        poly = clip(&poly, n, -(n[0] * p[0] + n[1] * p[1]));
        if poly.len() < 3 {
            return;
        }
    }
    // Corners the clip doubled up (a subject corner on an edge).
    poly.dedup_by(|q, p| (q.p[0] - p.p[0]).abs() < 1e-4 && (q.p[1] - p.p[1]).abs() < 1e-4);
    if poly.len() > 1 && (poly[0].p[0] - poly[poly.len() - 1].p[0]).abs() < 1e-4 && (poly[0].p[1] - poly[poly.len() - 1].p[1]).abs() < 1e-4 {
        poly.pop();
    }
    if poly.len() < 3 {
        return;
    }
    let base = (verts.len() / VERTEX_FLOATS) as u32;
    for v in &poly {
        let w1 = ((v.p[0] - a[0]) * (c[1] - a[1]) - (v.p[1] - a[1]) * (c[0] - a[0])) / area;
        let w2 = ((b[0] - a[0]) * (v.p[1] - a[1]) - (b[1] - a[1]) * (v.p[0] - a[0])) / area;
        let w0 = 1.0 - w1 - w2;
        let at = |k: usize| src[0][k] * w0 + src[1][k] * w1 + src[2][k] * w2;
        let n = normalize([at(3), at(4), at(5)]);
        verts.extend_from_slice(&[at(0) + n[0] * offset, at(1) + n[1] * offset, at(2) + n[2] * offset, n[0], n[1], n[2], v.t[0], v.t[1], at(8), at(9)]);
        verts.extend_from_slice(&fade);
    }
    // The clipped polygon keeps the subject's turning direction; wind it like the triangle (front faces as in mesh.rs).
    let turn: f32 = (0..poly.len()).map(|i| {
        let (p, q) = (poly[i].p, poly[(i + 1) % poly.len()].p);
        p[0] * q[1] - q[0] * p[1]
    }).sum();
    for i in 1..poly.len() as u32 - 1 {
        if turn * s > 0.0 { idx.extend_from_slice(&[base, base + i, base + i + 1]) } else { idx.extend_from_slice(&[base, base + i + 1, base + i]) }
    }
}

impl Dressing {
    /// Builds the overlay and decal geometry. `decal_size`: a decal material's size in world units (its base
    /// texture's, times `$decalscale`), None while its files aren't loaded (that decal is left out).
    pub fn build(&mut self, decal_size: &dyn Fn(&str) -> Option<[f32; 2]>) {
        // (kind, sky3d, order, material) -> triangles
        let mut buckets: HashMap<(u32, bool, u32, u32), (Vec<f32>, Vec<u32>)> = HashMap::new();
        for ov in &self.overlays {
            let subject: Vec<V2> = (0..4).map(|k| V2 { p: ov.corners[k], t: ov.tex[k] }).collect();
            let fade = [ov.origin[0], ov.origin[1], ov.origin[2], ov.fade[0], ov.fade[1]];
            for fi in &ov.faces {
                let Some(face) = self.faces.get(fi) else { continue };
                let (verts, idx) = buckets.entry((0, face.sky3d, ov.order, ov.material)).or_default();
                let proj = |p: [f32; 3]| {
                    let d = sub(p, ov.origin);
                    [dot(d, ov.u), dot(d, ov.v)]
                };
                for t in face.tris.chunks_exact(3) {
                    let tri = [0, 1, 2].map(|k| proj(face.flat[t[k] as usize]));
                    let src = [0, 1, 2].map(|k| &face.verts[t[k] as usize * WORLD_FLOATS..(t[k] as usize + 1) * WORLD_FLOATS]);
                    stamp(&subject, tri, src, OVERLAY_OFFSET, fade, verts, idx);
                }
            }
        }
        for d in &self.decals {
            let Some([w, h]) = decal_size(&self.materials[d.material as usize]).filter(|s| s[0] > 0.0 && s[1] > 0.0) else { continue };
            let reach = w.max(h) * 0.5;
            let subject = [
                V2 { p: [-w * 0.5, -h * 0.5], t: [0.0, 0.0] },
                V2 { p: [w * 0.5, -h * 0.5], t: [1.0, 0.0] },
                V2 { p: [w * 0.5, h * 0.5], t: [1.0, 1.0] },
                V2 { p: [-w * 0.5, h * 0.5], t: [0.0, 1.0] },
            ];
            for fi in &d.faces {
                let Some(face) = self.faces.get(fi) else { continue };
                let n = face.normal;
                // R_DecalComputeBasis without an s axis: floors and ceilings along +x, walls upright.
                let (s, t) = if n[2].abs() > std::f32::consts::FRAC_1_SQRT_2 {
                    let t = cross([1.0, 0.0, 0.0], n);
                    (normalize(cross(n, t)), normalize(t))
                } else {
                    let s = cross(n, [0.0, 0.0, -1.0]);
                    (normalize(s), normalize(cross(s, n)))
                };
                let (verts, idx) = buckets.entry((1, face.sky3d, 0, d.material)).or_default();
                for tr in face.tris.chunks_exact(3) {
                    let pos = |k: usize| {
                        let o = tr[k] as usize * WORLD_FLOATS;
                        [face.verts[o], face.verts[o + 1], face.verts[o + 2]]
                    };
                    let p = [pos(0), pos(1), pos(2)];
                    if face.disp {
                        // A displacement's other hills project onto the same spot: only the part near the origin.
                        let tn = cross(sub(p[1], p[0]), sub(p[2], p[0]));
                        let centre = [0, 1, 2].map(|k| (p[0][k] + p[1][k] + p[2][k]) / 3.0);
                        if dot(tn, n) <= 0.0 || dot(sub(centre, d.origin), n).abs() > reach {
                            continue;
                        }
                    }
                    let tri = p.map(|q| {
                        let r = sub(q, d.origin);
                        [dot(r, s), dot(r, t)]
                    });
                    let src = [0, 1, 2].map(|k| &face.verts[tr[k] as usize * WORLD_FLOATS..(tr[k] as usize + 1) * WORLD_FLOATS]);
                    stamp(&subject, tri, src, OVERLAY_OFFSET, [0.0; 5], verts, idx);
                }
            }
        }
        self.vertices.clear();
        self.indices.clear();
        self.groups.clear();
        let mut keys: Vec<_> = buckets.keys().copied().filter(|k| !buckets[k].1.is_empty()).collect();
        keys.sort_unstable();
        for key in keys {
            let (verts, idx) = buckets.remove(&key).unwrap();
            let base = (self.vertices.len() / VERTEX_FLOATS) as u32;
            let first_index = self.indices.len() as u32;
            self.vertices.extend_from_slice(&verts);
            self.indices.extend(idx.iter().map(|i| i + base));
            self.groups.push(DressGroup { kind: key.0, sky3d: key.1, order: key.2, material: key.3, first_index, index_count: idx.len() as u32 });
        }
    }
}

/// A decal material's size from the VFS: its base texture's width and height (VTF header) times `$decalscale`.
pub fn decal_size(vfs: &crate::vfs::Vfs, name: &str) -> Option<[f32; 2]> {
    let (_, params) = crate::materials::vmt_params(vfs, name)?;
    let base = params.get("$basetexture")?;
    let vtf = vfs.read(&crate::materials::vtf_path(base))?;
    if vtf.len() < 20 || &vtf[..4] != b"VTF\0" {
        return None;
    }
    let (w, h) = (u16::from_le_bytes([vtf[16], vtf[17]]) as f32, u16::from_le_bytes([vtf[18], vtf[19]]) as f32);
    let scale = params.get("$decalscale").and_then(|s| s.trim().parse::<f32>().ok()).unwrap_or(1.0);
    Some([w * scale, h * scale])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::parse;

    fn no_hit(_: [f32; 3], _: [f32; 3]) -> f32 {
        1.0
    }

    fn plan_glows(text: &str) -> (Vec<Glow>, Vec<String>) {
        let ents = parse(text);
        let mut names = Names(Vec::new(), HashMap::new());
        let mut id = |n: String| names.id(n);
        let g = glows(&ents, &mut id, &no_hit);
        (g, names.0)
    }

    #[test]
    fn material_names_as_the_engine_looks_them_up() {
        assert_eq!(material_name("sprites/glow01.spr"), "sprites/glow01");
        assert_eq!(material_name("materials/Sprites/Light_Glow03.vmt"), "sprites/light_glow03");
        assert_eq!(material_name("DECALS\\Blood1"), "decals/blood1");
    }

    #[test]
    fn sprites_that_start_off_or_are_switched_are_left_out() {
        let (g, names) = plan_glows(
            r#"{ "classname" "env_sprite" "origin" "1 2 3" "model" "sprites/glow01.spr" "rendermode" "9" "rendercolor" "255 128 0" "renderamt" "200" "scale" "0.5" }
            { "classname" "env_sprite" "targetname" "off" "model" "sprites/glow01.spr" }
            { "classname" "env_sprite" "targetname" "lamp" "spawnflags" "1" "model" "sprites/glow01.spr" }
            { "classname" "env_sprite" "targetname" "lamp2" "spawnflags" "1" "model" "sprites/blueglow2.vmt" }
            { "classname" "env_sprite" "spawnflags" "2" "model" "sprites/fire.vmt" }
            { "classname" "env_sprite" "model" "sprites/glow01.spr" "rendermode" "10" }
            { "classname" "func_button" "OnPressed" "lamp*,HideSprite,,0,-1" }"#,
        );
        assert_eq!(g.len(), 1);
        assert_eq!((g[0].origin, g[0].color, g[0].alpha, g[0].render_mode, g[0].size), ([1.0, 2.0, 3.0], [255.0, 128.0, 0.0], 200.0, 9, 0.5));
        assert_eq!(names[g[0].material as usize], "sprites/glow01");
    }

    #[test]
    fn light_glows_and_spotlights() {
        let ents = parse(
            r#"{ "classname" "env_lightglow" "origin" "0 0 100" "angles" "0 90 0" "HorizontalGlowSize" "30" "VerticalGlowSize" "20" "MinDist" "100" "MaxDist" "800" "spawnflags" "1" }
            { "classname" "point_spotlight" "origin" "0 0 0" "angles" "90 0 0" "spotlightlength" "400" "spotlightwidth" "40" "spawnflags" "1" "rendercolor" "255 0 0" }
            { "classname" "point_spotlight" "origin" "0 0 0" "spawnflags" "0" }
            { "classname" "func_rotating" "targetname" "spin" "model" "*3" "origin" "8 8 8" }
            { "classname" "env_sprite" "parentname" "spin" "model" "sprites/glow01.spr" }
            { "classname" "env_sprite" "parentname" "nobody" "model" "sprites/glow01.spr" }
            { "classname" "point_spotlight" "parentname" "spin" "spawnflags" "1" }"#,
        );
        let mut names = Names(Vec::new(), HashMap::new());
        let mut id = |n: String| names.id(n);
        // The floor is 100 units down: the beam stops at a quarter of its length.
        let g = glows(&ents, &mut id, &|_, _| 0.25);
        assert_eq!(g.len(), 3);
        let lg = &g[0];
        assert_eq!(lg.kind, GlowKind::LightGlow);
        assert_eq!((lg.size, lg.size2, lg.dist, lg.spawnflags), (30.0, 20.0, [100.0, 800.0, 0.0, 2.0], 1));
        assert!(lg.dir[1] > 0.999);
        let spot = &g[1];
        assert_eq!(spot.kind, GlowKind::Spotlight);
        assert_eq!((spot.size, spot.size2, spot.dist[0]), (40.0, 100.0, 400.0));
        assert!(spot.dir[2] < -0.999);
        assert_eq!(names.0[spot.material as usize], "sprites/glow_test02");
        assert!(names.0.contains(&"sprites/light_glow03".to_string()));
        let rides = &g[2];
        assert_eq!((rides.parent_model, rides.parent_origin), (3, [8.0; 3]));
    }

    #[test]
    fn decal_size_is_the_base_texture_times_decalscale() {
        use crate::vfs::{Source, Vfs};
        use std::rc::Rc;
        let mut vtf = vec![0u8; 80];
        vtf[..4].copy_from_slice(b"VTF\0");
        vtf[16..18].copy_from_slice(&128u16.to_le_bytes());
        vtf[18..20].copy_from_slice(&64u16.to_le_bytes());
        let files: Vec<(String, Rc<[u8]>)> = vec![
            ("materials/decals/a.vmt".into(), Rc::from(&br#""LightmappedGeneric" { "$basetexture" "decals/a_tex" "$decalscale" "0.25" }"#[..])),
            ("materials/decals/a_tex.vtf".into(), Rc::from(vtf.as_slice())),
            ("materials/decals/b.vmt".into(), Rc::from(&br#""LightmappedGeneric" { "$basetexture" "decals/a_tex" }"#[..])),
        ];
        let mut vfs = Vfs::default();
        vfs.mount(Source::loose("t", files.into_iter().collect()));
        assert_eq!(decal_size(&vfs, "decals/a"), Some([32.0, 16.0]));
        assert_eq!(decal_size(&vfs, "decals/b"), Some([128.0, 64.0]));
        assert_eq!(decal_size(&vfs, "decals/missing"), None);
    }

    /// A 256 x 256 face at the origin with normal `n`, spanned by `a` and `b`, as `mesh::build` captures it.
    fn face(n: [f32; 3], a: [f32; 3], b: [f32; 3]) -> FaceTris {
        let corner = |s: f32, t: f32| [0, 1, 2].map(|k| (a[k] * s + b[k] * t) * 128.0);
        let p = [corner(-1.0, -1.0), corner(1.0, -1.0), corner(1.0, 1.0), corner(-1.0, 1.0)];
        let mut verts = Vec::new();
        for q in &p {
            verts.extend_from_slice(&[q[0], q[1], q[2], n[0], n[1], n[2], 0.0, 0.0, 0.0, 0.0]);
        }
        // Front-facing (counter-clockwise seen from the normal's side), like the world mesh.
        let front = dot(cross(sub(p[1], p[0]), sub(p[2], p[0])), n) > 0.0;
        let tris = if front { vec![0, 1, 2, 0, 2, 3] } else { vec![0, 2, 1, 0, 3, 2] };
        FaceTris { verts, flat: p.to_vec(), tris, normal: n, disp: false, sky3d: false }
    }

    /// The decal's texture coordinate at the world point nearest `p` among its vertices.
    fn uv_near(d: &Dressing, p: [f32; 3]) -> [f32; 2] {
        let v = d.vertices.chunks_exact(VERTEX_FLOATS).min_by(|x, y| {
            let dx = sub([x[0], x[1], x[2]], p);
            let dy = sub([y[0], y[1], y[2]], p);
            dot(dx, dx).total_cmp(&dot(dy, dy))
        });
        let v = v.unwrap();
        [v[6], v[7]]
    }

    #[test]
    fn decals_stand_upright_on_walls_and_run_along_x_on_floors() {
        // A wall facing +x: seen from the front, +y is to the right and +z up.
        let mut d = Dressing { materials: vec!["decals/x".into()], ..Dressing::default() };
        d.faces.insert(0, face([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]));
        d.decals.push(Decal { material: 0, origin: [2.0, 0.0, 0.0], faces: vec![0] });
        d.build(&|_| Some([64.0, 32.0]));
        assert_eq!(d.groups.len(), 1);
        // (One piece per face triangle.)
        assert_eq!(d.groups[0].index_count, 12);
        let top_left = uv_near(&d, [0.0, -32.0, 16.0]);
        let bottom_right = uv_near(&d, [0.0, 32.0, -16.0]);
        assert!(top_left[0].abs() < 1e-4 && top_left[1].abs() < 1e-4, "{top_left:?}");
        assert!((bottom_right[0] - 1.0).abs() < 1e-4 && (bottom_right[1] - 1.0).abs() < 1e-4, "{bottom_right:?}");
        // A floor: s along +x, t along -y.
        let mut d = Dressing { materials: vec!["decals/x".into()], ..Dressing::default() };
        d.faces.insert(0, face([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]));
        d.decals.push(Decal { material: 0, origin: [0.0, 0.0, 1.0], faces: vec![0] });
        d.build(&|_| Some([64.0, 64.0]));
        let a = uv_near(&d, [-32.0, 32.0, 0.0]);
        assert!(a[0].abs() < 1e-4 && a[1].abs() < 1e-4, "{a:?}");
        // Every decal triangle faces up, like its floor.
        for t in d.indices.chunks_exact(3) {
            let p = |i: u32| {
                let o = i as usize * VERTEX_FLOATS;
                [d.vertices[o], d.vertices[o + 1], d.vertices[o + 2]]
            };
            assert!(cross(sub(p(t[1]), p(t[0])), sub(p(t[2]), p(t[0])))[2] > 0.0);
        }
    }

    #[test]
    fn a_square_clipped_to_a_triangle() {
        let subject: Vec<V2> = [[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]].iter().map(|&p| V2 { p, t: [(p[0] + 1.0) / 2.0, (p[1] + 1.0) / 2.0] }).collect();
        // A triangle covering the square's lower right half, at z = 5 with lightmap uv = position.
        let v = |x: f32, y: f32| vec![x, y, 5.0, 0.0, 0.0, 1.0, 0.0, 0.0, x, y];
        let (a, b, c) = (v(-1.0, -1.0), v(3.0, -1.0), v(-1.0, 3.0));
        let (mut verts, mut idx) = (Vec::new(), Vec::new());
        stamp(&subject, [[-1.0, -1.0], [3.0, -1.0], [-1.0, 3.0]], [&a, &b, &c], 0.0, [0.0; 5], &mut verts, &mut idx);
        // The triangle covers the whole square: the square comes back (two triangles).
        assert_eq!(verts.len() / VERTEX_FLOATS, 4);
        assert_eq!(idx.len(), 6);
        for q in verts.chunks_exact(VERTEX_FLOATS) {
            assert!((q[2] - 5.0).abs() < 1e-5);
            assert!((q[6] - (q[0] + 1.0) / 2.0).abs() < 1e-5 && (q[8] - q[0]).abs() < 1e-5);
        }
        // A triangle over half the square cuts it on the diagonal.
        let (a, b, c) = (v(-1.0, -1.0), v(1.0, -1.0), v(1.0, 1.0));
        let (mut verts, mut idx) = (Vec::new(), Vec::new());
        stamp(&subject, [[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0]], [&a, &b, &c], 0.0, [0.0; 5], &mut verts, &mut idx);
        let area: f32 = idx.chunks_exact(3).map(|t| {
            let p = |i: u32| [verts[i as usize * VERTEX_FLOATS], verts[i as usize * VERTEX_FLOATS + 1]];
            let (p0, p1, p2) = (p(t[0]), p(t[1]), p(t[2]));
            ((p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0])) / 2.0
        }).sum();
        assert!((area - 2.0).abs() < 1e-4, "{area}");
    }
}
