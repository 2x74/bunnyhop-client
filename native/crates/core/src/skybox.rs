//! Source's 3D skybox (render-only: nothing here is read by collision, triggers or the sim).
//!
//! A map with a `sky_camera` has a sealed miniature of its surroundings somewhere in the BSP. Each frame Source draws
//! the 2D sky, then that miniature from `sky_camera.origin + eye / scale` (same angles and FOV, the sky_camera's fog),
//! clears depth and draws the main view, whose `SURF_SKY` faces show what was drawn behind them (SDK 2013
//! `CSkyboxView`). Which geometry belongs to the miniature: the engine draws the leaves visible from the sky_camera in
//! its area (`sky3dparams_t::area = engine->GetArea(origin)`). vbsp floods a separate area for every region sealed off
//! from the others, so the skybox set here is everything in the leaves of the sky_camera's area:
//!
//! * world faces through the leaf face lists (`dleaf_t::area`); faces in no leaf list (displacements) by the leaf in
//!   front of their centre;
//! * brush entity models and entity props by the leaves their faces / origin are in;
//! * static props by their leaf lists in the static prop lump.
//!
//! Rule for several sky_cameras: Source's `GetCurrentSkyCamera()` is the head of the class list, which entities are
//! inserted at as they spawn, i.e. the last `sky_camera` in the entity lump. (All maps here have exactly one.)
//! Fallback (no 3D skybox, everything drawn as before): no sky_camera, its origin in solid / area 0, a player spawn in
//! its area (not sealed off), or "the skybox" holding most of the world's faces.

use crate::entities::Entity;
use playsrc_bsp::{Bsp, Face, Leaf, LumpData, Model, Node, Plane};

/// `sky_camera` fog (`fogenable`, `fogblend`, `fogcolor`, `fogcolor2`, `fogdir`, `fogstart`, `fogend`,
/// `fogmaxdensity`). Distances are in world units (Source divides them by the scale for the skybox pass).
#[derive(Clone, Debug, PartialEq)]
pub struct SkyFog {
    pub enable: bool,
    pub blend: bool,
    /// 0..255 (gamma space, like the keyvalue).
    pub color: [f32; 3],
    pub color2: [f32; 3],
    pub dir: [f32; 3],
    pub start: f32,
    pub end: f32,
    pub max_density: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SkyCamera {
    pub origin: [f32; 3],
    pub scale: f32,
    pub area: u16,
    pub fog: SkyFog,
}

/// Point → leaf → area through the world's BSP tree.
pub struct AreaMap {
    planes: Vec<([f32; 3], f32)>,
    nodes: Vec<(usize, [i32; 2])>,
    leaf_area: Vec<u16>,
    head: i32,
}

fn v3(v: playsrc_bsp::Vector3) -> [f32; 3] {
    [v.x.value(), v.y.value(), v.z.value()]
}

impl AreaMap {
    pub fn new(bsp: &Bsp) -> Self {
        let planes: &[Plane] = crate::lump!(bsp, playsrc_bsp::PLANES, Planes);
        let nodes: &[Node] = crate::lump!(bsp, playsrc_bsp::NODES, Nodes);
        let leaves: &[Leaf] = crate::lump!(bsp, playsrc_bsp::LEAFS, Leaves);
        let models: &[Model] = crate::lump!(bsp, playsrc_bsp::MODELS, Models);
        Self {
            planes: planes.iter().map(|p| (v3(p.normal), p.distance.value())).collect(),
            nodes: nodes.iter().map(|n| (n.plane_index.max(0) as usize, n.children)).collect(),
            // dleaf_t: `short area:9; short flags:7;`
            leaf_area: leaves.iter().map(|l| l.area_and_flags & 0x1ff).collect(),
            head: models.first().map_or(0, |m| m.head_node),
        }
    }

    /// Leaf containing `p` (Source's `CM_PointLeafnum`: front side when on the plane).
    pub fn leaf(&self, p: [f32; 3]) -> Option<usize> {
        let mut node = self.head;
        for _ in 0..self.nodes.len() + 1 {
            if node < 0 {
                return Some((-1 - node) as usize);
            }
            let &(plane, children) = self.nodes.get(node as usize)?;
            let (n, d) = self.planes.get(plane)?;
            let side = n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - d;
            node = children[if side >= 0.0 { 0 } else { 1 }];
        }
        None
    }

    pub fn leaf_area(&self, leaf: usize) -> u16 {
        self.leaf_area.get(leaf).copied().unwrap_or(0)
    }

    /// Area of the leaf containing `p` (0: none / outside).
    pub fn area(&self, p: [f32; 3]) -> u16 {
        self.leaf(p).map_or(0, |l| self.leaf_area(l))
    }

    /// Areas of the leaves touching a box (Source links displacements and entities to leaves by their bounds),
    /// as (any in `area`, any in another non-zero area).
    pub fn box_areas(&self, mins: [f32; 3], maxs: [f32; 3], area: u16) -> (bool, bool) {
        let mut out = (false, false);
        let mut stack = vec![self.head];
        let mut visits = 0;
        while let Some(node) = stack.pop() {
            visits += 1;
            if visits > 4 * self.nodes.len() + 16 {
                break;
            }
            if node < 0 {
                match self.leaf_area((-1 - node) as usize) {
                    0 => {}
                    a if a == area => out.0 = true,
                    _ => out.1 = true,
                }
                continue;
            }
            let Some(&(plane, children)) = self.nodes.get(node as usize) else { continue };
            let Some((n, d)) = self.planes.get(plane) else { continue };
            // Box extent along the normal around its centre.
            let c: f32 = (0..3).map(|k| n[k] * (mins[k] + maxs[k]) * 0.5).sum();
            let r: f32 = (0..3).map(|k| n[k].abs() * (maxs[k] - mins[k]) * 0.5).sum();
            if c + r >= *d {
                stack.push(children[0]);
            }
            if c - r < *d {
                stack.push(children[1]);
            }
        }
        out
    }
}

/// The 3D skybox of a map: its sky_camera and which world faces / brush models are in its area.
pub struct Skybox {
    pub camera: SkyCamera,
    pub areas: AreaMap,
    /// Per face index (FACES lump): in the skybox set.
    pub faces: Vec<bool>,
    /// Per brush model: in the skybox set (model 0, the world, is split per face instead: always false).
    pub models: Vec<bool>,
    /// Per brush model: Some(entity origin) for skybox models that never move, rotate or change visibility (static
    /// classes, no targetname or parent, no rotation, visible at spawn), which the render mesh merges into the world's
    /// skybox groups so the pass stays a few draws. The others keep their own meshes (moved / shown / hidden per frame).
    pub merge: Vec<Option<[f32; 3]>>,
}

/// Brush entity classes that never move or rotate; without a targetname nothing can toggle them either.
const STATIC_BRUSH_CLASSES: [&str; 5] = ["func_brush", "func_wall", "func_wall_toggle", "func_illusionary", "func_lod"];

fn color(e: &Entity, key: &str, default: [f32; 3]) -> [f32; 3] {
    e.vec3(key).unwrap_or(default)
}

fn sky_camera(e: &Entity) -> (SkyCamera, [f32; 3]) {
    let scale = e.float("scale").filter(|s| s.is_finite() && *s > 0.0).unwrap_or(16.0);
    let mut dir = e.vec3("fogdir").unwrap_or([1.0, 0.0, 0.0]);
    if e.int("use_angles") != 0 {
        // CSkyCamera::Activate: fog direction from the entity's angles, negated.
        let [pitch, yaw, _] = e.angles().map(f32::to_radians);
        dir = [-(pitch.cos() * yaw.cos()), -(pitch.cos() * yaw.sin()), pitch.sin()];
    }
    let fog = SkyFog {
        enable: e.int("fogenable") != 0,
        blend: e.int("fogblend") != 0,
        color: color(e, "fogcolor", [255.0; 3]),
        color2: color(e, "fogcolor2", [255.0; 3]),
        dir,
        start: e.float("fogstart").unwrap_or(500.0),
        end: e.float("fogend").unwrap_or(2000.0),
        max_density: e.float("fogmaxdensity").unwrap_or(1.0),
    };
    let origin = e.origin();
    (SkyCamera { origin, scale, area: 0, fog }, origin)
}

const PLAYER_SPAWNS: [&str; 4] = ["info_player_counterterrorist", "info_player_terrorist", "info_player_start", "info_player_deathmatch"];

/// The map's 3D skybox, or None (see the module docs for the fallback rules).
pub fn find(bsp: &Bsp, entities: &[Entity]) -> Option<Skybox> {
    let cam = entities.iter().rev().find(|e| e.classname().eq_ignore_ascii_case("sky_camera"))?;
    let (mut camera, origin) = sky_camera(cam);
    let areas = AreaMap::new(bsp);
    camera.area = areas.area(origin);
    if camera.area == 0 {
        return None;
    }
    let spawn_in_sky = entities
        .iter()
        .filter(|e| PLAYER_SPAWNS.iter().any(|c| e.classname().eq_ignore_ascii_case(c)))
        .any(|e| areas.area(e.origin()) == camera.area);
    if spawn_in_sky {
        return None;
    }
    let sky = camera.area;

    let faces: &[Face] = crate::lump!(bsp, playsrc_bsp::FACES, Faces);
    let leaves: &[Leaf] = crate::lump!(bsp, playsrc_bsp::LEAFS, Leaves);
    let leaf_faces: &[u16] = crate::lump!(bsp, playsrc_bsp::LEAFFACES, LeafFaces);
    let models: &[Model] = crate::lump!(bsp, playsrc_bsp::MODELS, Models);
    let planes: &[Plane] = crate::lump!(bsp, playsrc_bsp::PLANES, Planes);
    let dispinfo: &[playsrc_bsp::DispInfo] = crate::lump!(bsp, playsrc_bsp::DISPINFO, DispInfo);
    let dispverts: &[playsrc_bsp::DispVert] = crate::lump!(bsp, playsrc_bsp::DISP_VERTS, DispVertices);
    let vertices: &[playsrc_bsp::Vertex] = crate::lump!(bsp, playsrc_bsp::VERTEXES, Vertices);
    let edges: &[playsrc_bsp::Edge] = crate::lump!(bsp, playsrc_bsp::EDGES, Edges);
    let surfedges: &[i32] = crate::lump!(bsp, playsrc_bsp::SURFEDGES, SurfaceEdges);

    // Leaf face lists: a face is in the skybox if only skybox-area leaves list it.
    const IN_SKY: u8 = 1;
    const IN_OTHER: u8 = 2;
    let mut refs = vec![0u8; faces.len()];
    for (li, leaf) in leaves.iter().enumerate() {
        let area = areas.leaf_area(li);
        if area == 0 {
            continue;
        }
        let first = leaf.first_leaf_face as usize;
        for &f in leaf_faces.iter().skip(first).take(leaf.leaf_face_count as usize) {
            if let Some(r) = refs.get_mut(f as usize) {
                *r |= if area == sky { IN_SKY } else { IN_OTHER };
            }
        }
    }
    let polygon = |face: &Face| -> Vec<[f32; 3]> {
        let first = face.first_surface_edge.max(0) as usize;
        let count = face.surface_edge_count.max(0) as usize;
        surfedges
            .iter()
            .skip(first)
            .take(count)
            .filter_map(|&se| {
                let edge = edges.get(se.unsigned_abs() as usize)?;
                let vi = if se >= 0 { edge.vertex_indices[0] } else { edge.vertex_indices[1] };
                Some(v3(vertices.get(vi as usize)?.position))
            })
            .collect()
    };
    // Faces in no leaf list (displacements, which the engine links to leaves by their bounds): by a vote of points
    // just in front of the surface (the displaced vertices; else the polygon's centre).
    let unlisted_in_sky = |face: &Face| -> bool {
        let poly = polygon(face);
        let Some(normal) = planes.get(face.plane_index as usize).map(|p| v3(p.normal)) else { return false };
        let mut points = Vec::new();
        let info = (face.displacement_info_index >= 0).then(|| dispinfo.get(face.displacement_info_index as usize)).flatten();
        if let (Some(info), 4) = (info, poly.len()) {
            // Same corner order as mesh.rs: start at the corner nearest `start_position`.
            let st = v3(info.start_position);
            let d2 = |a: [f32; 3]| (0..3).map(|k| (a[k] - st[k]).powi(2)).sum::<f32>();
            let first = (0..4).min_by(|&a, &b| d2(poly[a]).total_cmp(&d2(poly[b]))).unwrap_or(0);
            let c: Vec<[f32; 3]> = (0..4).map(|i| poly[(first + i) % 4]).collect();
            let lerp = |a: [f32; 3], b: [f32; 3], t: f32| [0, 1, 2].map(|k| a[k] + (b[k] - a[k]) * t);
            let size = (1usize << info.power.clamp(1, 4)) + 1;
            for y in 0..size {
                let ty = y as f32 / (size - 1) as f32;
                let (l, r) = (lerp(c[0], c[1], ty), lerp(c[3], c[2], ty));
                for x in 0..size {
                    let flat = lerp(l, r, x as f32 / (size - 1) as f32);
                    let p = match dispverts.get(info.vertex_start.max(0) as usize + y * size + x) {
                        Some(d) => {
                            let v = v3(d.vector);
                            let s = d.distance.value();
                            [0, 1, 2].map(|k| flat[k] + v[k] * s)
                        }
                        None => flat,
                    };
                    points.push(p);
                }
            }
        } else if poly.len() >= 3 {
            points.push([0, 1, 2].map(|k| poly.iter().map(|p| p[k]).sum::<f32>() / poly.len() as f32));
        }
        let (mut in_sky, mut other) = (0, 0);
        for p in points {
            match areas.area([0, 1, 2].map(|k| p[k] + normal[k])) {
                0 => {}
                a if a == sky => in_sky += 1,
                _ => other += 1,
            }
        }
        in_sky > other
    };

    let mut face_sky = vec![false; faces.len()];
    if let Some(world) = models.first() {
        let first = world.first_face.max(0) as usize;
        for fi in first..(first + world.face_count.max(0) as usize).min(faces.len()) {
            face_sky[fi] = match refs[fi] {
                IN_SKY => true,
                0 => unlisted_in_sky(&faces[fi]),
                _ => false,
            };
        }
    }

    // Brush entity models, placed at their entity's origin.
    let mut model_origin = vec![[0f32; 3]; models.len()];
    for e in entities {
        if let Some(m) = e.brush_model().filter(|&m| m > 0 && m < models.len()) {
            model_origin[m] = e.origin();
        }
    }
    let model_sky: Vec<bool> = models
        .iter()
        .enumerate()
        .map(|(mi, m)| {
            if mi == 0 {
                return false;
            }
            // By the leaves its bounds touch at its entity's origin, like the engine links entities.
            let o = model_origin[mi];
            let (lo, hi) = (v3(m.mins), v3(m.maxs));
            m.face_count > 0 && areas.box_areas([0, 1, 2].map(|k| lo[k] + o[k]), [0, 1, 2].map(|k| hi[k] + o[k]), sky) == (true, false)
        })
        .collect();

    let mut users = vec![0u32; models.len()];
    for e in entities {
        if let Some(m) = e.brush_model().filter(|&m| m < models.len()) {
            users[m] += 1;
        }
    }
    let mut merge = vec![None; models.len()];
    for e in entities {
        let Some(m) = e.brush_model().filter(|&m| m > 0 && m < models.len() && model_sky[m] && users[m] == 1) else { continue };
        let class = e.classname();
        let named = |k: &str| e.get(k).is_some_and(|p| !p.trim().is_empty());
        // Hidden at spawn (game.rs: func_wall_toggle "Starts Invisible", func_brush StartDisabled).
        let hidden = (class.eq_ignore_ascii_case("func_wall_toggle") && e.int("spawnflags") & 1 != 0)
            || (class.eq_ignore_ascii_case("func_brush") && e.int("StartDisabled") != 0);
        if STATIC_BRUSH_CLASSES.iter().any(|c| class.eq_ignore_ascii_case(c)) && !named("targetname") && !named("parentname") && !hidden && e.angles() == [0.0; 3] {
            merge[m] = Some(e.origin());
        }
    }

    // Sanity: the skybox is a small sealed room, never most of the world.
    let world_faces = models.first().map_or(0, |m| m.face_count.max(0) as usize);
    let sky_faces = face_sky.iter().filter(|&&s| s).count();
    if sky_faces * 2 > world_faces {
        return None;
    }
    Some(Skybox { camera, areas, faces: face_sky, models: model_sky, merge })
}

impl Skybox {
    /// Whether a point is in the skybox area.
    pub fn contains(&self, p: [f32; 3]) -> bool {
        self.areas.area(p) == self.camera.area
    }

    /// Static props (static prop lump order): in the skybox set if every leaf they're listed in is in its area
    /// (no leaves: by origin).
    pub fn static_props(&self, bsp: &Bsp) -> Vec<bool> {
        let Ok(Some(sp)) = playsrc_bsp::parse_static_props(bsp, Default::default()) else { return Vec::new() };
        sp.occurrences
            .iter()
            .map(|o| {
                let areas: Vec<u16> = o.leaves.iter().map(|&l| self.areas.leaf_area(l as usize)).filter(|&a| a != 0).collect();
                if areas.is_empty() { self.contains(v3(o.origin)) } else { areas.iter().all(|&a| a == self.camera.area) }
            })
            .collect()
    }
}

/// Marks the props in the 3D skybox set: `sp.props[..n_static]` are the static prop lump in order (by their leaf
/// lists), the rest entity props (by origin; moving ones never). No-op without a 3D skybox.
pub fn mark_props(bsp: &Bsp, sp: &mut crate::props::StaticProps, n_static: usize) {
    let Some(sky) = find(bsp, &crate::entities::parse(&crate::content::entity_text(bsp))) else { return };
    let flags = sky.static_props(bsp);
    for (i, p) in sp.props.iter_mut().enumerate() {
        p.sky3d = if i < n_static { flags.get(i).copied().unwrap_or(false) } else { p.owner == 0 && sky.contains(p.origin) };
    }
}
