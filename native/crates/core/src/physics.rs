//! Collision assembly for a map: BSP brushes + displacement collision + static-prop collision,
//! and the surface-property table (friction / jump factor) behind every collidable surface.
//!
//! - Displacements: the vendored `playsrc-collision` traces displacements inside `trace_hull`
//!   once `World::with_displacement_inputs` is given the tessellated patches; we build those
//!   inputs from the BSP here (same tessellation as Source / playsrc's map crate).
//! - Static props: `prop_static` with `solid 6` (VPhysics) collides with its `.phy` convex
//!   hulls. `.phy` files are model content and are only available when the map packs them; the
//!   rest are skipped with a diagnostic. Each convex hull becomes a Quake/Source-style plane set
//!   (faces + axial and edge bevels, i.e. the exact Minkowski sum with the player box) swept
//!   with the same `CM_ClipBoxToBrush` arithmetic as BSP brushes. `solid 2` (bbox) props use the
//!   model's hull box when the `.mdl` is packed.
//! - Surface properties: texinfo → texdata → material → VMT `$surfaceprop` (pak only) → table.

use crate::materials;
use crate::vfs::{Source, Vfs};
use playsrc_bsp::{Bsp, DispVert, Edge, Face, LumpData, TextureData, TextureInfo, Vertex};
use playsrc_collision::{DisplacementInput, Hull, SurfaceIdentity, World as CollisionWorld};
use std::collections::HashMap;

const DIST_EPSILON: f32 = 0.03125;

/// `Trace::surface` registry used for displacement surfaces: `index` is a surface-table index.
pub const SURFACEPROP_REGISTRY: [u8; 32] = [0xd1; 32];

/// One `surfaceproperties.txt` entry that matters to player movement.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SurfaceProp {
    pub name: &'static str,
    /// Raw vphysics friction. The player uses `min(friction * 1.25, 1)`, so anything >= 0.8
    /// behaves like the default surface.
    pub friction: f32,
    pub jump_factor: f32,
}

/// Stock HL2/CS:S surface properties whose movement-relevant values differ from `default`
/// (friction 0.8, jumpfactor 1). Index 0 is `default`. Names not listed here inherit `default`
/// for movement purposes (their friction is >= 0.8, i.e. a player surface friction of 1).
/// Values from the stock `scripts/surfaceproperties*.txt` (numeric gameplay constants only);
/// see research/MOVEMENT_AUDIT.md for the confidence notes.
pub const SURFACE_PROPS: &[SurfaceProp] = &[
    SurfaceProp { name: "default", friction: 0.8, jump_factor: 1.0 },
    SurfaceProp { name: "ice", friction: 0.1, jump_factor: 1.0 },
    SurfaceProp { name: "slipperymetal", friction: 0.1, jump_factor: 1.0 },
    SurfaceProp { name: "slipperyslime", friction: 0.1, jump_factor: 1.0 },
    SurfaceProp { name: "snow", friction: 0.35, jump_factor: 1.0 },
    SurfaceProp { name: "gravel", friction: 0.4, jump_factor: 1.0 },
    SurfaceProp { name: "mud", friction: 0.6, jump_factor: 1.0 },
    SurfaceProp { name: "ladder", friction: 0.8, jump_factor: 1.0 },
];

/// Surface-table index of a `$surfaceprop` name (0 = default / unknown).
pub fn surface_index(name: &str) -> u16 {
    let name = name.trim().to_ascii_lowercase();
    SURFACE_PROPS.iter().position(|s| s.name == name).unwrap_or(0) as u16
}

pub struct MapPhysics {
    /// Prop collision inputs (static props + entity props); `Game` keeps them to rebuild prop collision
    /// when stock collision models arrive after the map (`Game::rebuild_props`).
    pub prop_sources: Vec<PropSource>,
    pub world: CollisionWorld,
    /// Surface-table index per texinfo.
    pub texinfo_surface: Vec<u16>,
    pub props: PropCollision,
    /// Human-readable notes about collision that could not be built (missing `.phy`, ...).
    pub diagnostics: Vec<String>,
    pub displacement_count: usize,
}

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

pub fn map_vfs(bsp: &Bsp) -> Vfs {
    let mut fs = Vfs::default();
    let pak = bsp.lump(playsrc_bsp::PAKFILE).map(|l| l.bytes(bsp).to_vec()).unwrap_or_default();
    fs.mount(Source::from_zip("pak", pak));
    fs
}

pub fn build(bsp: &Bsp) -> Result<MapPhysics, String> {
    build_with(bsp, None)
}

/// Like `build`, with stock game files (collision models: `.phy` / `.mdl`) searched after the pakfile.
pub fn build_with(bsp: &Bsp, content: Option<Source>) -> Result<MapPhysics, String> {
    build_with_entities(bsp, content, &entity_list(bsp), true)
}

/// The parsed entity lump. Borrows the lump bytes when they are valid UTF-8 (no copy of the text: entity-heavy
/// maps have lumps of 16 MB and more, and the server-side verifier runs in a 128 MB isolate).
pub fn entity_list(bsp: &Bsp) -> Vec<crate::entities::Entity> {
    match bsp.lump(playsrc_bsp::ENTITIES).map(|l| &l.records) {
        Some(LumpData::EntityBytes(b)) => crate::entities::parse(&String::from_utf8_lossy(b)),
        _ => Vec::new(),
    }
}

/// `entity_list` with each entity's outputs (`entities::parse_with_outputs`).
pub fn entity_list_with_outputs(bsp: &Bsp, keep_output_pairs: bool) -> crate::entities::EntityList {
    match bsp.lump(playsrc_bsp::ENTITIES).map(|l| &l.records) {
        Some(LumpData::EntityBytes(b)) => crate::entities::parse_with_outputs(&String::from_utf8_lossy(b), keep_output_pairs),
        _ => crate::entities::EntityList { entities: Vec::new(), outputs: Vec::new() },
    }
}

/// `build_with` for entities the caller already parsed (`entity_list`), so the lump is parsed once per load.
/// `prop_mesh` = false: no prop collision triangle soup (`PropCollision::mesh`, rendering only).
pub fn build_with_entities(bsp: &Bsp, content: Option<Source>, entities: &[crate::entities::Entity], prop_mesh: bool) -> Result<MapPhysics, String> {
    let mut fs = map_vfs(bsp);
    if let Some(c) = content {
        fs.mount(c);
    }
    let mut diagnostics = Vec::new();
    let world = playsrc_collision::compile(bsp).map_err(|e| format!("collision: {e:?}"))?;

    // Surface properties per texdata (primary and $surfaceprop2), then per texinfo.
    let texdata: &[TextureData] = lump!(bsp, playsrc_bsp::TEXDATA, TextureData);
    let texinfo: &[TextureInfo] = lump!(bsp, playsrc_bsp::TEXINFO, TextureInfo);
    let names = crate::mesh::texture_names(bsp);
    let mut texdata_surface = Vec::with_capacity(texdata.len());
    for td in texdata {
        let name = names.get(td.name_string_table_index.max(0) as usize).map(String::as_str).unwrap_or("");
        let prop = |key| materials::material_param(&fs, name, key).map(|s| surface_index(&s)).unwrap_or(0);
        let (primary, secondary) = (prop("$surfaceprop"), prop("$surfaceprop2"));
        if primary != 0 || secondary != 0 {
            diagnostics.push(format!(
                "surface {name}: {} / {}",
                SURFACE_PROPS[primary as usize].name, SURFACE_PROPS[secondary as usize].name
            ));
        }
        texdata_surface.push((primary, secondary));
    }
    let texinfo_surface: Vec<u16> = texinfo
        .iter()
        .map(|ti| texdata_surface.get(ti.texture_data_index.max(0) as usize).map(|s| s.0).unwrap_or(0))
        .collect();

    // Displacements.
    let displacement_count = world.displacements.len();
    let world = if world.displacements.is_empty() {
        world
    } else {
        let inputs = displacement_inputs(bsp, &world, texinfo, &texdata_surface)?;
        world.with_displacement_inputs(inputs).map_err(|e| format!("displacements: {e:?}"))?
    };
    for (source, count) in world.degenerate_displacement_triangles() {
        diagnostics.push(format!(
            "displacement {source}: {count} zero-area triangles collide as segments (no face plane)"
        ));
    }

    let prop_sources = prop_sources(bsp, entities, &mut diagnostics);
    let props = PropCollision::build_with_mesh(&prop_sources, &fs, &world, &mut diagnostics, prop_mesh);
    Ok(MapPhysics { prop_sources, world, texinfo_surface, props, diagnostics, displacement_count })
}

fn face_polygon(face: &Face, surfedges: &[i32], edges: &[Edge], vertices: &[Vertex]) -> Vec<[f32; 3]> {
    let first = face.first_surface_edge.max(0) as usize;
    let count = face.surface_edge_count.max(0) as usize;
    let mut out = Vec::with_capacity(count);
    for &se in surfedges.iter().skip(first).take(count) {
        let Some(edge) = edges.get(se.unsigned_abs() as usize) else { continue };
        let vi = if se >= 0 { edge.vertex_indices[0] } else { edge.vertex_indices[1] };
        if let Some(v) = vertices.get(vi as usize) {
            out.push(v3(v.position));
        }
    }
    out
}

/// Source displacement triangulation (alternating diagonals), all triangles including removed
/// ones (the collision tree skips tagged ones itself).
fn source_triangles(side: usize) -> Vec<[u32; 3]> {
    let mut triangles = Vec::with_capacity((side - 1) * (side - 1) * 2);
    for column in 0..side - 1 {
        for row in 0..side - 1 {
            let index = column * side + row;
            if index % 2 == 1 {
                triangles.push([index as u32, (index + side) as u32, (index + 1) as u32]);
                triangles.push([(index + 1) as u32, (index + side) as u32, (index + side + 1) as u32]);
            } else {
                triangles.push([index as u32, (index + side) as u32, (index + side + 1) as u32]);
                triangles.push([index as u32, (index + side + 1) as u32, (index + 1) as u32]);
            }
        }
    }
    triangles
}

fn displacement_inputs(
    bsp: &Bsp,
    world: &CollisionWorld,
    texinfo: &[TextureInfo],
    texdata_surface: &[(u16, u16)],
) -> Result<Vec<DisplacementInput>, String> {
    let faces: &[Face] = lump!(bsp, playsrc_bsp::FACES, Faces);
    let vertices: &[Vertex] = lump!(bsp, playsrc_bsp::VERTEXES, Vertices);
    let edges: &[Edge] = lump!(bsp, playsrc_bsp::EDGES, Edges);
    let surfedges: &[i32] = lump!(bsp, playsrc_bsp::SURFEDGES, SurfaceEdges);
    let dispverts: &[DispVert] = lump!(bsp, playsrc_bsp::DISP_VERTS, DispVertices);
    let lerp = |a: [f32; 3], b: [f32; 3], t: f32| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    let mut out = Vec::with_capacity(world.displacements.len());
    for patch in &world.displacements {
        let face = faces.get(patch.map_face as usize).ok_or("displacement face")?;
        let corners = face_polygon(face, surfedges, edges, vertices);
        if corners.len() != 4 {
            return Err(format!("displacement {} face has {} corners", patch.source, corners.len()));
        }
        let start = patch.start_position;
        let d2 = |a: &[f32; 3]| (a[0] - start[0]).powi(2) + (a[1] - start[1]).powi(2) + (a[2] - start[2]).powi(2);
        let first = (0..4).min_by(|&a, &b| d2(&corners[a]).total_cmp(&d2(&corners[b]))).unwrap();
        let c: [[f32; 3]; 4] = std::array::from_fn(|i| corners[(first + i) % 4]);
        let side = (1usize << patch.power) + 1;
        let interval = 1.0 / (side - 1) as f32;
        let mut positions = Vec::with_capacity(side * side);
        let mut alpha = Vec::with_capacity(side * side);
        for column in 0..side {
            let along = column as f32 * interval;
            let left = lerp(c[0], c[1], along);
            let right = lerp(c[3], c[2], along);
            for row in 0..side {
                let flat = lerp(left, right, row as f32 * interval);
                let (dir, dist, a) = patch.vertices[column * side + row];
                positions.push([flat[0] + dir[0] * dist, flat[1] + dir[1] * dist, flat[2] + dir[2] * dist]);
                alpha.push(a);
            }
        }
        let _ = dispverts;
        let triangles = source_triangles(side);
        let use_secondary: Vec<bool> =
            triangles.iter().map(|t| t.iter().map(|&i| alpha[i as usize]).sum::<f32>() > 382.5).collect();
        let surfaces = texinfo
            .get(face.texture_info_index.max(0) as usize)
            .and_then(|ti| texdata_surface.get(ti.texture_data_index.max(0) as usize))
            .copied()
            .unwrap_or((0, 0));
        let identity = |index: u16| SurfaceIdentity { registry: SURFACEPROP_REGISTRY, index: index as u32 };
        out.push(DisplacementInput {
            source: patch.source,
            parent_face: patch.map_face as usize,
            contents: patch.contents,
            positions,
            triangles,
            triangle_tags: patch.triangle_tags.clone(),
            primary_surface: identity(surfaces.0),
            secondary_surface: Some(identity(surfaces.1)),
            use_secondary_surface: use_secondary,
        });
    }
    Ok(out)
}

// ------------------------------------------------------------------ static props

/// A convex solid as a set of outward planes (faces + bevels), in world space.
#[derive(Clone, Debug)]
pub struct ConvexBrush {
    pub planes: Vec<([f32; 3], f32)>,
    pub mins: [f32; 3],
    pub maxs: [f32; 3],
    pub surface: u16,
    pub prop: u32,
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn normalize(v: [f32; 3]) -> Option<[f32; 3]> {
    let l = dot(v, v).sqrt();
    (l > 1e-6).then(|| [v[0] / l, v[1] / l, v[2] / l])
}

impl ConvexBrush {
    /// Build from hull points and triangles (any winding). Adds axial and edge bevels so a box
    /// sweep against the plane set is exact.
    pub fn from_hull(points: &[[f32; 3]], triangles: &[[u32; 3]], surface: u16, prop: u32) -> Option<Self> {
        if points.len() < 4 {
            return None;
        }
        let mut mins = [f32::INFINITY; 3];
        let mut maxs = [f32::NEG_INFINITY; 3];
        for p in points {
            for k in 0..3 {
                mins[k] = mins[k].min(p[k]);
                maxs[k] = maxs[k].max(p[k]);
            }
        }
        let support = |n: [f32; 3]| points.iter().map(|p| dot(*p, n)).fold(f32::NEG_INFINITY, f32::max);
        let mut planes: Vec<([f32; 3], f32)> = Vec::new();
        let add = |n: [f32; 3], planes: &mut Vec<([f32; 3], f32)>| {
            let d = support(n);
            if !planes.iter().any(|(m, e)| dot(*m, n) > 0.9999 && (e - d).abs() < 0.01) {
                planes.push((n, d));
            }
        };
        let mut edges: Vec<[f32; 3]> = Vec::new();
        for t in triangles {
            let [a, b, c] = t.map(|i| points.get(i as usize).copied());
            let (Some(a), Some(b), Some(c)) = (a, b, c) else { continue };
            if let Some(mut n) = normalize(cross(sub(b, a), sub(c, a))) {
                // Orient outward: the face plane must be a supporting plane.
                if (support(n) - dot(a, n)).abs() > (support([-n[0], -n[1], -n[2]]) + dot(a, n)).abs() {
                    n = [-n[0], -n[1], -n[2]];
                }
                add(n, &mut planes);
            }
            for (p, q) in [(a, b), (b, c), (c, a)] {
                if let Some(e) = normalize(sub(q, p)) {
                    if !edges.iter().any(|f| dot(*f, e).abs() > 0.9999) {
                        edges.push(e);
                    }
                }
            }
        }
        for k in 0..3 {
            let mut n = [0.0; 3];
            n[k] = 1.0;
            add(n, &mut planes);
            n[k] = -1.0;
            add(n, &mut planes);
        }
        // Edge bevels: e x axis directions whose support plane touches that edge.
        for t in triangles {
            let [a, b, c] = t.map(|i| points.get(i as usize).copied());
            let (Some(a), Some(b), Some(c)) = (a, b, c) else { continue };
            for (p, q) in [(a, b), (b, c), (c, a)] {
                let Some(e) = normalize(sub(q, p)) else { continue };
                for k in 0..3 {
                    let mut axis = [0.0; 3];
                    axis[k] = 1.0;
                    let Some(n) = normalize(cross(e, axis)) else { continue };
                    for n in [n, [-n[0], -n[1], -n[2]]] {
                        if (support(n) - dot(p, n)).abs() < 0.01 {
                            add(n, &mut planes);
                        }
                    }
                }
            }
        }
        Some(Self { planes, mins, maxs, surface, prop })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct PropTrace {
    pub fraction: f32,
    pub start_solid: bool,
    pub all_solid: bool,
    pub normal: Option<[f32; 3]>,
    pub surface: u16,
    pub brush: Option<usize>,
}

#[derive(Clone, Copy, Debug)]
struct BvhNode {
    lo: [f32; 3],
    hi: [f32; 3],
    /// Range into `order` (leaves only).
    start: usize,
    end: usize,
    children: Option<(usize, usize)>,
}

#[derive(Default)]
pub struct PropCollision {
    pub brushes: Vec<ConvexBrush>,
    /// Flat BVH over `brushes`.
    nodes: Vec<BvhNode>,
    order: Vec<usize>,
    pub solid_props: usize,
    /// Collision hull faces as a triangle soup (9 floats per triangle, world space), for clients
    /// that cannot render the prop models themselves (debug/fallback rendering).
    pub mesh: Vec<f32>,
    /// (tag, origin, angles) of every solid prop, after settling.
    pub poses: Vec<(u32, [f32; 3], [f32; 3])>,
    /// Models whose collision file wasn't available.
    pub missing_models: Vec<String>,
    /// SOLID-mode prop_physics_multiplayer (AvoidPushawayProps).
    pub pushaway: Vec<PushawayProp>,
    /// Props that move (prop_door_rotating): their collision hulls in model space, placed by the game at the
    /// entity's current transform (`DynamicHulls::place`). Not part of `brushes`.
    pub dynamic: Vec<(u32, std::rc::Rc<DynamicHulls>)>,
}

/// Model-space collision of a moving prop (`.phy` convexes) and its collision AABB (the OBB Source's
/// CollisionProp uses for SOLID_VPHYSICS props: the collide's bounds).
#[derive(Debug)]
pub struct DynamicHulls {
    hulls: Hulls,
    pub mins: [f32; 3],
    pub maxs: [f32; 3],
}

impl DynamicHulls {
    /// The convex solids at `origin` / `angles` (world space; same plane construction as static props), tagged
    /// `tag`, and their world AABB.
    pub fn place(&self, origin: [f32; 3], angles: [f32; 3], tag: u32) -> (Vec<ConvexBrush>, [f32; 3], [f32; 3]) {
        let mut out = Vec::new();
        let (mut lo, mut hi) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
        for (world_points, tris, surface) in place_hulls(&self.hulls, angles, origin) {
            if let Some(b) = ConvexBrush::from_hull(&world_points, tris, surface, tag) {
                for k in 0..3 {
                    lo[k] = lo[k].min(b.mins[k]);
                    hi[k] = hi[k].max(b.maxs[k]);
                }
                out.push(b);
            }
        }
        (out, lo, hi)
    }
}

/// Source AngleMatrix applied to a local point.
pub fn rotate(v: [f32; 3], angles: [f32; 3]) -> [f32; 3] {
    let (sp, cp) = playsrc_collision::math::sin_cos(angles[0].to_radians());
    let (sy, cy) = playsrc_collision::math::sin_cos(angles[1].to_radians());
    let (sr, cr) = playsrc_collision::math::sin_cos(angles[2].to_radians());
    let forward = [cp * cy, cp * sy, -sp];
    let left = [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, sr * cp];
    let up = [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp];
    [
        forward[0] * v[0] + left[0] * v[1] + up[0] * v[2],
        forward[1] * v[0] + left[1] * v[1] + up[1] * v[2],
        forward[2] * v[0] + left[2] * v[1] + up[2] * v[2],
    ]
}

fn phy_surfaces(asset: &playsrc_phy::Asset) -> HashMap<usize, u16> {
    let mut out = HashMap::new();
    for block in &asset.key_data.blocks {
        if !block.name.eq_ignore_ascii_case(b"solid") {
            continue;
        }
        let scalar = |name: &[u8]| {
            block.entries.iter().find_map(|e| match e {
                playsrc_phy::KeyValue::Scalar { key, value } if key.eq_ignore_ascii_case(name) => {
                    Some(String::from_utf8_lossy(value).into_owned())
                }
                _ => None,
            })
        };
        if let (Some(index), Some(prop)) = (scalar(b"index").and_then(|i| i.trim().parse::<usize>().ok()), scalar(b"surfaceprop")) {
            out.insert(index, surface_index(&prop));
        }
    }
    out
}

/// Total mass of a model's `.phy` solids (the `mass` key of each `solid` block).
fn phy_mass(fs: &Vfs, name: &str) -> Option<f32> {
    let phy = fs.read(&format!("{}.phy", name.strip_suffix(".mdl").unwrap_or(name)))?;
    let asset = playsrc_phy::parse_standalone(phy, playsrc_phy::Profile::SourcePcPolygon, playsrc_phy::Limits::default()).ok()?;
    let mut total = 0.0f32;
    for block in &asset.key_data.blocks {
        if !block.name.eq_ignore_ascii_case(b"solid") {
            continue;
        }
        for e in &block.entries {
            if let playsrc_phy::KeyValue::Scalar { key, value } = e {
                if key.eq_ignore_ascii_case(b"mass") {
                    total += String::from_utf8_lossy(value).trim().parse::<f32>().unwrap_or(0.0);
                }
            }
        }
    }
    Some(total)
}

/// Studio model hull box (`studiohdr_t::hull_min/hull_max`).
fn mdl_hull(bytes: &[u8]) -> Option<([f32; 3], [f32; 3])> {
    if bytes.get(0..4)? != b"IDST" {
        return None;
    }
    let f = |o: usize| Some(f32::from_le_bytes(bytes.get(o..o + 4)?.try_into().ok()?));
    let mins = [f(104)?, f(108)?, f(112)?];
    let maxs = [f(116)?, f(120)?, f(124)?];
    (mins.iter().chain(&maxs).all(|v| v.is_finite()) && (0..3).all(|k| mins[k] <= maxs[k])).then_some((mins, maxs))
}

const BOX_TRIANGLES: [[u32; 3]; 12] = [
    [0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1],
    [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3],
];

/// `ConvexBrush::prop` tag for solids that belong to a prop_dynamic entity (low bits: entity index).
pub const ENTITY_PROP: u32 = 0x8000_0000;

type Hulls = Vec<(Vec<[f32; 3]>, Vec<[u32; 3]>, u16)>;

/// Collision hulls of a model in model space: `.phy` convexes (solid 6) or the studio hull box
/// (solid 2), from the map's pakfile.
fn model_hulls(fs: &Vfs, name: &str, solidity: u8) -> Option<Hulls> {
    if solidity == 2 {
        let (mins, maxs) = mdl_hull(fs.read(name)?)?;
        let points = (0..8)
            .map(|i| [if i & 4 != 0 { maxs[0] } else { mins[0] }, if i & 2 != 0 { maxs[1] } else { mins[1] }, if i & 1 != 0 { maxs[2] } else { mins[2] }])
            .collect();
        return Some(vec![(points, BOX_TRIANGLES.to_vec(), 0)]);
    }
    let phy = fs.read(&format!("{}.phy", name.strip_suffix(".mdl").unwrap_or(name)))?;
    let asset = playsrc_phy::parse_standalone(phy, playsrc_phy::Profile::SourcePcPolygon, playsrc_phy::Limits::default()).ok()?;
    let surfaces = phy_surfaces(&asset);
    let mut hulls = Vec::new();
    for (si, solid) in asset.solids.iter().enumerate() {
        let surface = surfaces.get(&si).copied().unwrap_or(0);
        for convex in &solid.convexes {
            let Some(g) = solid.geometries.get(convex.geometry) else { continue };
            let points = g.points.iter().map(|p| p.source_inches.map(|c| f32::from_bits(c.0))).collect();
            let tris = g.triangles.iter().map(|t| t.point_indices).collect();
            hulls.push((points, tris, surface));
        }
    }
    (!hulls.is_empty()).then_some(hulls)
}

/// One prop whose collision the simulation builds: a static prop, or an entity prop (tagged
/// `ENTITY_PROP | entity index` so it can be disabled / killed at runtime).
#[derive(Clone, Debug)]
pub struct PropSource {
    /// Model path (`models/....mdl`, normalised).
    pub name: String,
    /// 6 = VPhysics (`.phy` convexes), 2 = bounding box (`.mdl` hull).
    pub solidity: u8,
    pub origin: [f32; 3],
    pub angles: [f32; 3],
    pub tag: u32,
    /// Motion-enabled, awake physics prop: dropped onto what's below it at load (see `settle_drop`).
    pub settle: bool,
    /// prop_physics_multiplayer: never solid to players (COLLISION_GROUP_PUSHAWAY), but a SOLID-mode one
    /// steers them away (`AvoidPushawayProps`): (physicsmode keyvalue, massScale, force server side).
    pub pushaway: Option<(i64, f32, bool)>,
    /// Moves at runtime (prop_door_rotating): collision kept in model space (`PropCollision::dynamic`).
    pub dynamic: bool,
    /// Uniform scale of the collision model (CS:GO static prop lump v11; 1.0 everywhere else).
    pub scale: f32,
}

/// A prop_physics_multiplayer in PHYSICS_MULTIPLAYER_SOLID mode at its (settled) pose: what
/// `AvoidPushawayProps` needs (collision OBB in model space, mass).
#[derive(Clone, Debug)]
pub struct PushawayProp {
    pub tag: u32,
    pub origin: [f32; 3],
    pub angles: [f32; 3],
    pub mins: [f32; 3],
    pub maxs: [f32; 3],
    pub mass: f32,
}

impl PropSource {
    /// The file the collision of this prop is read from.
    pub fn collision_file(&self) -> String {
        collision_file(&self.name, self.solidity)
    }
}

pub fn collision_file(model: &str, solidity: u8) -> String {
    let base = model.strip_suffix(".mdl").unwrap_or(model);
    if solidity == 2 { format!("{base}.mdl") } else { format!("{base}.phy") }
}

/// Static props with collision, and the entity props that collide with players in CS:S:
/// - `prop_dynamic(_override)`: `solid` key (default 6), unless parented (hierarchies aren't simulated
///   for props); spawnflag 256 / DisableCollision are handled at runtime.
/// - `prop_physics`, `prop_physics_override`, `prop_physics_respawnable`: COLLISION_GROUP_NONE, VPhysics
///   collision, unless debris (spawnflag 4, COLLISION_GROUP_DEBRIS). Motion disabled (8) or start asleep
///   (1): static at the spawn pose; otherwise awake and settled under gravity (`settle`).
/// - `prop_door_rotating`: the door model's VPhysics collision, kept in model space (`dynamic`): the door moves.
/// - `prop_physics_multiplayer` (COLLISION_GROUP_PUSHAWAY) and debris never collide with the player.
pub fn prop_sources(bsp: &Bsp, entities: &[crate::entities::Entity], diagnostics: &mut Vec<String>) -> Vec<PropSource> {
    let mut out = Vec::new();
    match playsrc_bsp::parse_static_props(bsp, playsrc_bsp::Limits::default()) {
        Ok(Some(props)) => {
            for (index, prop) in props.occurrences.iter().enumerate() {
                if prop.solidity == 0 {
                    continue;
                }
                let name = String::from_utf8_lossy(&props.dictionary[prop.model as usize].name).replace('\\', "/").to_ascii_lowercase();
                out.push(PropSource { name, solidity: prop.solidity, origin: v3(prop.origin), angles: v3(prop.angles), tag: index as u32, settle: false, pushaway: None, dynamic: false, scale: prop.uniform_scale.value() });
            }
        }
        Ok(None) => {}
        Err(e) => diagnostics.push(format!("static props: unsupported lump ({e:?}); props are not solid")),
    }
    for (index, e) in entities.iter().enumerate() {
        let class = e.classname().to_ascii_lowercase();
        let Some(model) = e.get("model") else { continue };
        if !model.to_ascii_lowercase().ends_with(".mdl") {
            continue;
        }
        let spawnflags = e.int("spawnflags");
        let (solidity, settle) = match class.as_str() {
            "prop_dynamic" | "prop_dynamic_override" => (e.get("solid").and_then(|v| v.trim().parse::<u8>().ok()).unwrap_or(6), false),
            "prop_physics" | "prop_physics_override" | "prop_physics_respawnable" => {
                if spawnflags & 4 != 0 {
                    continue; // debris
                }
                (6, spawnflags & (1 | 8) == 0)
            }
            "prop_door_rotating" => (6, false),
            "prop_physics_multiplayer" => {
                if spawnflags & 4 != 0 {
                    continue; // debris
                }
                let pushaway = (e.int("physicsmode"), e.float("massscale").unwrap_or(0.0), spawnflags & 0x2000 != 0);
                if e.get("parentname").is_some_and(|p| !p.is_empty()) {
                    continue;
                }
                let name = model.replace('\\', "/").to_ascii_lowercase();
                out.push(PropSource { name, solidity: 6, origin: e.origin(), angles: e.angles(), tag: ENTITY_PROP | index as u32, settle: spawnflags & (1 | 8) == 0, pushaway: Some(pushaway), dynamic: false, scale: 1.0 });
                continue;
            }
            _ => continue,
        };
        if solidity == 0 {
            continue;
        }
        if e.get("parentname").is_some_and(|p| !p.is_empty()) {
            // Follows a (possibly moving) parent; prop hierarchies are not simulated.
            diagnostics.push(format!("{class} {model} parented to {}: not solid", e.get("parentname").unwrap_or("")));
            continue;
        }
        let name = model.replace('\\', "/").to_ascii_lowercase();
        let dynamic = class == "prop_door_rotating";
        out.push(PropSource { name, solidity, origin: e.origin(), angles: e.angles(), tag: ENTITY_PROP | index as u32, settle, pushaway: None, dynamic, scale: 1.0 });
    }
    out
}

/// Model-space hulls of `src` placed at `origin` (its angles), as (world points, triangles, surface).
fn place_hulls<'a>(hulls: &'a Hulls, angles: [f32; 3], origin: [f32; 3]) -> Vec<(Vec<[f32; 3]>, &'a Vec<[u32; 3]>, u16)> {
    hulls
        .iter()
        .map(|(points, tris, surface)| {
            let world_points = points
                .iter()
                .map(|p| {
                    let r = rotate(*p, angles);
                    [r[0] + origin[0], r[1] + origin[1], r[2] + origin[2]]
                })
                .collect();
            (world_points, tris, *surface)
        })
        .collect()
}

impl PropCollision {
    /// Builds the convex solids of every prop source whose collision model `fs` has. Awake physics
    /// props are dropped straight down onto the world and the props already placed (VPhysics lets them
    /// fall until they rest; props a mapper placed on a surface don't move). The poses are kept in
    /// `poses` (tag -> origin, angles) for rendering.
    pub fn build(sources: &[PropSource], fs: &Vfs, world: &CollisionWorld, diagnostics: &mut Vec<String>) -> Self {
        Self::build_with_mesh(sources, fs, world, diagnostics, true)
    }

    /// `build`; `mesh` = false leaves out the triangle soup (`mesh`, rendering only), for the headless verifier.
    pub fn build_with_mesh(sources: &[PropSource], fs: &Vfs, world: &CollisionWorld, diagnostics: &mut Vec<String>, mesh: bool) -> Self {
        let mut out = Self::default();
        let mut cache: HashMap<(String, u8), Option<Hulls>> = HashMap::new();
        let mut missing: HashMap<String, usize> = HashMap::new();
        // Settling props go last, in entity order, so they can rest on everything else.
        let order: Vec<&PropSource> = sources.iter().filter(|p| !p.settle).chain(sources.iter().filter(|p| p.settle)).collect();
        for src in order {
            let hulls = cache.entry((src.name.clone(), src.solidity)).or_insert_with(|| model_hulls(fs, &src.name, src.solidity)).clone();
            let Some(hulls) = hulls else {
                *missing.entry(src.name.clone()).or_default() += 1;
                continue;
            };
            // CS:GO scaled static props: scale the model-space hulls about the model origin. Unscaled props (every
            // v19/v20 map) keep the cached hulls untouched.
            let hulls = if src.scale != 1.0 {
                hulls.into_iter().map(|(pts, tris, surface)| (pts.into_iter().map(|p| p.map(|c| c * src.scale)).collect(), tris, surface)).collect()
            } else {
                hulls
            };
            if src.dynamic {
                let (mut mins, mut maxs) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
                for (pts, _, _) in &hulls {
                    for p in pts {
                        for k in 0..3 {
                            mins[k] = mins[k].min(p[k]);
                            maxs[k] = maxs[k].max(p[k]);
                        }
                    }
                }
                out.dynamic.push((src.tag, std::rc::Rc::new(DynamicHulls { hulls, mins, maxs })));
                continue;
            }
            let mut origin = src.origin;
            if src.settle {
                let mut lo = [f32::INFINITY; 3];
                let mut hi = [f32::NEG_INFINITY; 3];
                for (pts, _, _) in place_hulls(&hulls, src.angles, origin) {
                    for p in pts {
                        for k in 0..3 {
                            lo[k] = lo[k].min(p[k]);
                            hi[k] = hi[k].max(p[k]);
                        }
                    }
                }
                if lo[0].is_finite() {
                    origin[2] -= out.settle_drop(world, origin, lo, hi);
                }
            }
            if let Some((mode, mass_scale, force_server)) = src.pushaway {
                // CPhysicsPropMultiplayer::Spawn: physicsmode 0 = GetAutoMultiplayerPhysicsMode(OBB size, mass);
                // SF_PHYSPROP_FORCE_SERVER_SIDE -> NON_SOLID. Only SOLID (1) props push players away.
                let (mut lo, mut hi) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
                for (pts, _, _) in &hulls {
                    for p in pts {
                        for k in 0..3 {
                            lo[k] = lo[k].min(p[k]);
                            hi[k] = hi[k].max(p[k]);
                        }
                    }
                }
                let mut mass = phy_mass(fs, &src.name).unwrap_or(0.0);
                if mass_scale > 0.0 {
                    mass *= mass_scale;
                }
                let size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
                let mode = if mode == 0 {
                    if size[0] * size[1] * size[2] < 15.0 * 15.0 * 15.0 {
                        3
                    } else if mass < 8.0 {
                        2
                    } else {
                        1
                    }
                } else {
                    mode
                };
                let mode = if force_server { 2 } else { mode };
                if mode == 1 {
                    out.poses.push((src.tag, origin, src.angles));
                    out.pushaway.push(PushawayProp { tag: src.tag, origin, angles: src.angles, mins: lo, maxs: hi, mass });
                } else if mode == 2 {
                    out.poses.push((src.tag, origin, src.angles));
                }
                continue;
            }
            out.solid_props += 1;
            out.poses.push((src.tag, origin, src.angles));
            for (world_points, tris, surface) in place_hulls(&hulls, src.angles, origin) {
                if let Some(b) = ConvexBrush::from_hull(&world_points, tris, surface, src.tag) {
                    out.brushes.push(b);
                    for t in tris.iter().filter(|_| mesh) {
                        for &k in t {
                            out.mesh.extend_from_slice(world_points.get(k as usize).unwrap_or(&[0.0; 3]));
                        }
                    }
                }
            }
        }
        let mut missing: Vec<_> = missing.into_iter().collect();
        missing.sort();
        for (name, count) in missing {
            diagnostics.push(format!("prop {name} ({count}x): collision model not available, not solid"));
            out.missing_models.push(name);
        }
        out.order = (0..out.brushes.len()).collect();
        if !out.brushes.is_empty() {
            let n = out.brushes.len();
            out.build_node(0, n);
        }
        out
    }

    /// How far an awake physics prop with world bounds `lo..hi` falls before it rests on the world or
    /// on a prop placed before it (an axis-aligned box sweep straight down, at most 8192 units). 0 if it
    /// starts embedded or nothing is below.
    fn settle_drop(&self, world: &CollisionWorld, origin: [f32; 3], lo: [f32; 3], hi: [f32; 3]) -> f32 {
        const MAX_DROP: f32 = 8192.0;
        let hull = Hull {
            mins: [lo[0] - origin[0], lo[1] - origin[1], lo[2] - origin[2]],
            maxs: [hi[0] - origin[0], hi[1] - origin[1], hi[2] - origin[2]],
        };
        let end = [origin[0], origin[1], origin[2] - MAX_DROP];
        let mut fraction = match world.trace_hull(origin, end, hull, playsrc_collision::MASK_SOLID) {
            Ok(t) if t.start_solid => return 0.0,
            Ok(t) => t.fraction,
            Err(_) => return 0.0,
        };
        for b in &self.brushes {
            if b.maxs[0] < lo[0] || b.mins[0] > hi[0] || b.maxs[1] < lo[1] || b.mins[1] > hi[1] || b.mins[2] > hi[2] {
                continue;
            }
            if let Some(t) = clip_box_to_brush(b, origin, end, hull) {
                if t.start_solid {
                    return 0.0;
                }
                fraction = fraction.min(t.fraction);
            }
        }
        if fraction >= 1.0 { 0.0 } else { fraction * MAX_DROP }
    }

    fn build_node(&mut self, start: usize, end: usize) -> usize {
        let mut lo = [f32::INFINITY; 3];
        let mut hi = [f32::NEG_INFINITY; 3];
        for &i in &self.order[start..end] {
            for k in 0..3 {
                lo[k] = lo[k].min(self.brushes[i].mins[k]);
                hi[k] = hi[k].max(self.brushes[i].maxs[k]);
            }
        }
        let id = self.nodes.len();
        self.nodes.push(BvhNode { lo, hi, start, end, children: None });
        if end - start > 4 {
            let axis = (0..3).max_by(|&a, &b| (hi[a] - lo[a]).total_cmp(&(hi[b] - lo[b]))).unwrap();
            let brushes = &self.brushes;
            self.order[start..end].sort_by(|&a, &b| {
                (brushes[a].mins[axis] + brushes[a].maxs[axis]).total_cmp(&(brushes[b].mins[axis] + brushes[b].maxs[axis])).then(a.cmp(&b))
            });
            let mid = start + (end - start) / 2;
            let left = self.build_node(start, mid);
            let right = self.build_node(mid, end);
            self.nodes[id].children = Some((left, right));
        }
        id
    }

    pub fn is_empty(&self) -> bool {
        self.brushes.is_empty()
    }

    /// Sweep `hull` from `start` to `end` against every prop solid. `None` = nothing touched.
    pub fn trace(&self, start: [f32; 3], end: [f32; 3], hull: Hull) -> Option<PropTrace> {
        self.trace_filtered(start, end, hull, &|_| true)
    }

    /// `enabled(prop tag)` decides whether a solid takes part (entity props can be disabled).
    pub fn trace_filtered(&self, start: [f32; 3], end: [f32; 3], hull: Hull, enabled: &dyn Fn(u32) -> bool) -> Option<PropTrace> {
        if self.brushes.is_empty() {
            return None;
        }
        let mut lo = [0.0; 3];
        let mut hi = [0.0; 3];
        for k in 0..3 {
            lo[k] = start[k].min(end[k]) + hull.mins[k] - 1.0;
            hi[k] = start[k].max(end[k]) + hull.maxs[k] + 1.0;
        }
        let mut best: Option<PropTrace> = None;
        let mut stack = [0usize; 64];
        let mut top = 1;
        while top > 0 {
            top -= 1;
            let node = self.nodes[stack[top]];
            if (0..3).any(|k| node.lo[k] > hi[k] || node.hi[k] < lo[k]) {
                continue;
            }
            if let Some((left, right)) = node.children {
                if top + 2 <= stack.len() {
                    stack[top] = right;
                    stack[top + 1] = left;
                    top += 2;
                }
                continue;
            }
            for &i in &self.order[node.start..node.end] {
                let b = &self.brushes[i];
                if (0..3).any(|k| b.mins[k] > hi[k] || b.maxs[k] < lo[k]) {
                    continue;
                }
                if b.prop & ENTITY_PROP != 0 && !enabled(b.prop) {
                    continue;
                }
                let Some(t) = clip_box_to_brush(b, start, end, hull) else { continue };
                let t = PropTrace { brush: Some(i), ..t };
                if t.all_solid {
                    return Some(t);
                }
                best = Some(match best {
                    None => t,
                    Some(cur) if t.fraction < cur.fraction => PropTrace { start_solid: cur.start_solid || t.start_solid, ..t },
                    Some(cur) => PropTrace { start_solid: cur.start_solid || t.start_solid, ..cur },
                });
            }
        }
        best
    }
}

/// Quake/Source `CM_ClipBoxToBrush` for an axis-aligned box sweep against a convex plane set.
pub(crate) fn clip_box_to_brush(b: &ConvexBrush, start: [f32; 3], end: [f32; 3], hull: Hull) -> Option<PropTrace> {
    let center = [(hull.mins[0] + hull.maxs[0]) * 0.5, (hull.mins[1] + hull.maxs[1]) * 0.5, (hull.mins[2] + hull.maxs[2]) * 0.5];
    let ext = [(hull.maxs[0] - hull.mins[0]) * 0.5, (hull.maxs[1] - hull.mins[1]) * 0.5, (hull.maxs[2] - hull.mins[2]) * 0.5];
    let s = [start[0] + center[0], start[1] + center[1], start[2] + center[2]];
    let e = [end[0] + center[0], end[1] + center[1], end[2] + center[2]];
    let mut enter = -1.0f32;
    let mut leave = 1.0f32;
    let mut starts_out = false;
    let mut gets_out = false;
    let mut clip = None;
    for &(n, dist) in &b.planes {
        let offset = ext[0] * n[0].abs() + ext[1] * n[1].abs() + ext[2] * n[2].abs();
        let d1 = dot(s, n) - dist - offset;
        let d2 = dot(e, n) - dist - offset;
        if d1 > 0.0 {
            starts_out = true;
            if d2 > 0.0 {
                return None;
            }
        } else {
            if d2 <= 0.0 {
                continue;
            }
            gets_out = true;
        }
        if d1 > d2 {
            let f = (d1 - DIST_EPSILON).max(0.0) / (d1 - d2);
            if f > enter {
                enter = f;
                clip = Some(n);
            }
        } else {
            leave = leave.min((d1 + DIST_EPSILON) / (d1 - d2));
        }
    }
    if !starts_out {
        return Some(PropTrace {
            fraction: if gets_out { 1.0 } else { 0.0 },
            start_solid: true,
            all_solid: !gets_out,
            normal: None,
            surface: b.surface,
            brush: None,
        });
    }
    if enter < leave && enter > -1.0 && enter < 1.0 {
        return Some(PropTrace {
            fraction: enter.max(0.0),
            start_solid: false,
            all_solid: false,
            normal: clip,
            surface: b.surface,
            brush: None,
        });
    }
    None
}

/// Collision vertex grid (row-major, `2^power + 1` square) of every displacement patch, in patch
/// order, for tests and tools.
pub fn displacement_positions(bsp: &Bsp) -> Vec<Vec<[f32; 3]>> {
    let Ok(world) = playsrc_collision::compile(bsp) else { return Vec::new() };
    let texinfo: &[TextureInfo] = lump!(bsp, playsrc_bsp::TEXINFO, TextureInfo);
    let Ok(inputs) = displacement_inputs(bsp, &world, texinfo, &[]) else { return Vec::new() };
    inputs.into_iter().map(|d| d.positions).collect()
}

/// Centre vertex and (upward-facing) normal of every displacement patch, for tests and tools.
pub fn displacement_centers(bsp: &Bsp) -> Vec<([f32; 3], [f32; 3])> {
    let Ok(world) = playsrc_collision::compile(bsp) else { return Vec::new() };
    let texinfo: &[TextureInfo] = lump!(bsp, playsrc_bsp::TEXINFO, TextureInfo);
    let Ok(inputs) = displacement_inputs(bsp, &world, texinfo, &[]) else { return Vec::new() };
    inputs
        .iter()
        .filter_map(|d| {
            let side = (d.positions.len() as f32).sqrt() as usize;
            let c = (side / 2) * side + side / 2;
            let (p, a, b) = (d.positions[c], d.positions[c + side], d.positions[c + 1]);
            let mut n = normalize(cross(sub(a, p), sub(b, p)))?;
            if n[2] < 0.0 {
                n = n.map(|v| -v);
            }
            Some((p, n))
        })
        .collect()
}

impl ConvexBrush {
    /// Convex hull of a small point set (brute force; for synthetic test scenes), with the same
    /// bevels as `from_hull`.
    pub fn from_points(points: &[[f32; 3]], surface: u16) -> Option<Self> {
        let n = points.len();
        let mut triangles = Vec::new();
        for i in 0..n {
            for j in i + 1..n {
                for k in j + 1..n {
                    let Some(normal) = normalize(cross(sub(points[j], points[i]), sub(points[k], points[i]))) else {
                        continue;
                    };
                    let d = dot(points[i], normal);
                    let side = |p: &[f32; 3]| dot(*p, normal) - d;
                    if points.iter().all(|p| side(p) <= 1e-3) || points.iter().all(|p| side(p) >= -1e-3) {
                        triangles.push([i as u32, j as u32, k as u32]);
                    }
                }
            }
        }
        Self::from_hull(points, &triangles, surface, 0)
    }

    /// Axis-aligned box.
    pub fn aabb(mins: [f32; 3], maxs: [f32; 3]) -> Self {
        let points: Vec<[f32; 3]> = (0..8)
            .map(|i| [if i & 4 != 0 { maxs[0] } else { mins[0] }, if i & 2 != 0 { maxs[1] } else { mins[1] }, if i & 1 != 0 { maxs[2] } else { mins[2] }])
            .collect();
        Self::from_hull(&points, &BOX_TRIANGLES, 0, 0).expect("box")
    }
}

impl PropCollision {
    /// A collision set from explicit convex solids (synthetic test scenes).
    pub fn from_brushes(brushes: Vec<ConvexBrush>) -> Self {
        let mut out = Self { brushes, ..Self::default() };
        out.order = (0..out.brushes.len()).collect();
        if !out.brushes.is_empty() {
            let n = out.brushes.len();
            out.build_node(0, n);
        }
        out
    }
}
