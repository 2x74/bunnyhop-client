//! The map's light for models (render-only: nothing here is read by collision, triggers or the sim).
//!
//! Source lights a model from two things VRAD leaves in the BSP:
//! * per-leaf ambient cubes (`LUMP_LEAF_AMBIENT_LIGHTING[_HDR]` 56 / 55 with the index lumps 52 / 51; older compiles
//!   have one cube per leaf and no index): the bounced and sky light around a point, as six colours along ±x ±y ±z;
//! * the world lights (`LUMP_WORLDLIGHTS[_HDR]` 15 / 54): the map's point lights, spotlights and sun, which the engine
//!   adds on top when the light can see the point (`LightcacheGetStatic` / `LightcacheGetDynamic`).
//!
//! `Lighting::cube` is that sum at a point, the direct lights folded into the cube the way the engine folds the ones
//! past its four local lights (`AddWorldLightToAmbientCube`). `Lighting::direct` keeps them apart for the static
//! prop bake (`prop_light.rs`), which shades each vertex by its own normal.
//!
//! Ambient cubes are `ColorRGBExp32` like lightmap samples, but VRAD writes them 255 times smaller and the engine
//! reads them back with that factor (`ColorRGBExp32ToVector`: "why is there a factor of 255 built into this?"), so a
//! cube colour is `c * 2^exp`, where a lightmap sample is `c * 2^exp / 255`. This project's own map compiler
//! (tools/tutorial/bsp.ts: Meadow, Aero, Plaza, ...) wrote its cubes in lightmap units instead, with the sun and
//! lamps already in them; those maps are told apart by their impossible brightness under the engine's reading
//! (`OWN_COMPILER_MEAN`) and keep their own units, with no world lights added on top.
//!
//! All colours are linear light (1.0 = a surface shown at its texture's brightness), like decoded lightmap samples.
//! The HDR lumps are used when the lightmap atlas is (`lightmap.rs`), so models and walls agree. Light styles other
//! than 0 (switchable, flickering) are left out, like in the atlas. Visibility is traced against the world's opaque
//! brushes only: displacements, brush entities and props don't block (the engine also ignores the last two here).

use playsrc_bsp::{Bsp, Brush, BrushSide, Leaf, LumpData, Plane, TextureInfo};
use std::cell::RefCell;

const LEAF_AMBIENT_INDEX_HDR: usize = 51;
const LEAF_AMBIENT_INDEX: usize = 52;
const LEAF_AMBIENT_LIGHTING_HDR: usize = 55;
const LEAF_AMBIENT_LIGHTING: usize = 56;
const WORLDLIGHTS: usize = 15;
const WORLDLIGHTS_HDR: usize = 54;

const EMIT_POINT: i32 = 1;
const EMIT_SPOTLIGHT: i32 = 2;
pub(crate) const EMIT_SKYLIGHT: i32 = 3;

const SURF_SKY2D: i32 = 0x2;
const SURF_SKY: i32 = 0x4;
/// MASK_OPAQUE: CONTENTS_SOLID | CONTENTS_MOVEABLE | CONTENTS_OPAQUE.
const MASK_OPAQUE: i32 = 0x1 | 0x4000 | 0x80;
/// Source's MAX_TRACE_LENGTH: how far the sun's ray is followed to the sky.
const SKY_TRACE: f32 = 56_755.84;
/// A light adding less than this (linear, brightest channel, before the surface angle) is skipped.
const MIN_LIGHT: f32 = 1.0 / 512.0;

/// Mean ambient (the engine's reading, all samples and sides) no VRAD compile reaches: the brightest of 960 maps here
/// is under 8, this project's own compiler's are 50 to 230.
const OWN_COMPILER_MEAN: f32 = 24.0;

/// The six ambient cube directions, in the order the BSP stores them.
pub const CUBE_DIRS: [[f32; 3]; 6] = [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, -1.0]];

pub type Cube = [[f32; 3]; 6];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WorldLight {
    pub origin: [f32; 3],
    pub intensity: [f32; 3],
    /// Direction the light travels (spotlights, the sun).
    pub normal: [f32; 3],
    pub cluster: i32,
    pub kind: i32,
    pub stopdot: f32,
    pub stopdot2: f32,
    pub exponent: f32,
    pub radius: f32,
    /// constant, linear, quadratic.
    pub attn: [f32; 3],
}

/// One light that reaches a point: where it comes from and its colour there, before the surface angle.
#[derive(Clone, Copy, Debug)]
pub struct Direct {
    pub light: usize,
    /// Unit vector from the point towards the light.
    pub dir: [f32; 3],
    pub color: [f32; 3],
}

/// One ambient sample as stored: six `ColorRGBExp32`, then its position inside the leaf's bounds (0..255 per axis).
type Sample = [u8; 27];

fn sample(cube: &[u8], at: [u8; 3]) -> Sample {
    let mut s = [0u8; 27];
    s[..24].copy_from_slice(&cube[..24]);
    s[24..].copy_from_slice(&at);
    s
}

struct LeafInfo {
    cluster: i16,
    mins: [f32; 3],
    maxs: [f32; 3],
    first_brush: usize,
    brush_count: usize,
    /// Ambient samples: `[first, count]` into `samples`.
    ambient: [usize; 2],
}

struct TraceBrush {
    first_side: usize,
    side_count: usize,
    opaque: bool,
    /// Opaque and with a side that is drawn (not an invisible tool brush): what hides things from the view.
    seen: bool,
}

/// A brush side: its plane index, with `SIDE_SKY` set when the side shows the sky.
type TraceSide = u32;
const SIDE_SKY: u32 = 1 << 31;

pub struct Lighting {
    /// Built from the HDR lumps.
    pub hdr: bool,
    pub lights: Vec<WorldLight>,
    /// Cubes hold the direct light too (this project's own compiler; module docs): `direct` reports none.
    pub ambient_has_direct: bool,
    /// Decoded `ColorRGBExp32` to linear light for the cubes: 255 (VRAD), or 1 (own compiler).
    ambient_scale: f32,
    nodes: Vec<(usize, [i32; 2])>,
    planes: Vec<([f32; 3], f32)>,
    head: i32,
    leaves: Vec<LeafInfo>,
    samples: Vec<Sample>,
    leaf_brushes: Vec<u16>,
    brushes: Vec<TraceBrush>,
    sides: Vec<TraceSide>,
    /// Raw visibility lump (cluster count, per-cluster PVS offsets, run-length rows).
    vis: Vec<u8>,
    /// The PVS row last decoded: (cluster, one bit per cluster).
    pvs: RefCell<(i32, Vec<u8>)>,
    /// Per brush: the trace that last tested it (a brush sits in several leaves).
    checked: RefCell<(u32, Vec<u32>)>,
}

fn v3(v: playsrc_bsp::Vector3) -> [f32; 3] {
    [v.x.value(), v.y.value(), v.z.value()]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn raw(bsp: &Bsp, index: usize) -> &[u8] {
    bsp.lump(index).map(|l| l.bytes(bsp)).unwrap_or(&[])
}

fn f32_at(b: &[u8], o: usize) -> f32 {
    f32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

fn i32_at(b: &[u8], o: usize) -> i32 {
    i32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

fn vec_at(b: &[u8], o: usize) -> [f32; 3] {
    [f32_at(b, o), f32_at(b, o + 4), f32_at(b, o + 8)]
}

/// `ColorRGBExp32` as a lightmap sample's linear light (`TexLightToLinear`).
pub fn rgbexp(b: &[u8]) -> [f32; 3] {
    let scale = 2f32.powi((b[3] as i8) as i32) / 255.0;
    [b[0] as f32 * scale, b[1] as f32 * scale, b[2] as f32 * scale]
}

fn cube_at(b: &[u8]) -> Cube {
    std::array::from_fn(|i| rgbexp(&b[i * 4..i * 4 + 4]))
}

/// `dworldlight_t` records: 88 bytes, or 100 in CS:GO (a shadow offset after the normal).
fn world_lights(bytes: &[u8], csgo: bool) -> Vec<WorldLight> {
    let (size, shift) = if csgo { (100, 12) } else { (88, 0) };
    bytes
        .chunks_exact(size)
        .filter(|r| i32_at(r, 44 + shift) == 0) // style 0 only
        .map(|r| WorldLight {
            origin: vec_at(r, 0),
            intensity: vec_at(r, 12),
            normal: vec_at(r, 24),
            cluster: i32_at(r, 36 + shift),
            kind: i32_at(r, 40 + shift),
            stopdot: f32_at(r, 48 + shift),
            stopdot2: f32_at(r, 52 + shift),
            exponent: f32_at(r, 56 + shift),
            radius: f32_at(r, 60 + shift),
            attn: [f32_at(r, 64 + shift), f32_at(r, 68 + shift), f32_at(r, 72 + shift)],
        })
        .filter(|l| l.origin.iter().chain(&l.intensity).chain(&l.normal).all(|v| v.is_finite()))
        .collect()
}

impl Lighting {
    /// `hdr`: whether the lightmap atlas uses the HDR lumps (the other set is the fallback when that one is empty).
    /// None when the map carries no ambient lighting at all.
    pub fn new(bsp: &Bsp, hdr: bool) -> Option<Self> {
        let leaf_records: &[Leaf] = crate::lump!(bsp, playsrc_bsp::LEAFS, Leaves);
        let csgo = bsp.profile == playsrc_bsp::Profile::CsgoV21;
        let pick = |hdr_lump: usize, ldr_lump: usize| {
            let (first, second) = if hdr { (hdr_lump, ldr_lump) } else { (ldr_lump, hdr_lump) };
            if raw(bsp, first).is_empty() { (raw(bsp, second), second == hdr_lump) } else { (raw(bsp, first), first == hdr_lump) }
        };
        let (ambient, ambient_hdr) = pick(LEAF_AMBIENT_LIGHTING_HDR, LEAF_AMBIENT_LIGHTING);
        let index = raw(bsp, if ambient_hdr { LEAF_AMBIENT_INDEX_HDR } else { LEAF_AMBIENT_INDEX });

        // Samples per leaf: the indexed form (28-byte samples with a position), one bare cube per leaf (older VRAD),
        // or the cube inside version 0 leaves.
        let mut samples = Vec::new();
        let mut spans = vec![[0usize; 2]; leaf_records.len()];
        if !ambient.is_empty() && index.len() == leaf_records.len() * 4 && ambient.len() % 28 == 0 {
            samples = ambient.chunks_exact(28).map(|s| sample(s, [s[24], s[25], s[26]])).collect();
            for (li, span) in spans.iter_mut().enumerate() {
                let count = u16::from_le_bytes([index[li * 4], index[li * 4 + 1]]) as usize;
                let first = u16::from_le_bytes([index[li * 4 + 2], index[li * 4 + 3]]) as usize;
                *span = [first, count];
            }
            // A leaf without samples names the leaf it borrows from (solid leaves next to open ones).
            let borrowed: Vec<[usize; 2]> = spans.iter().map(|&[first, count]| if count == 0 && first != 0 { spans.get(first).copied().unwrap_or([0, 0]) } else { [first, count] }).collect();
            spans = borrowed;
            for span in &mut spans {
                if span[0] + span[1] > samples.len() {
                    *span = [0, 0];
                }
            }
        } else if !ambient.is_empty() && ambient.len() == leaf_records.len() * 24 {
            samples = ambient.chunks_exact(24).map(|s| sample(s, [128; 3])).collect();
            spans = (0..leaf_records.len()).map(|li| [li, 1]).collect();
        } else if leaf_records.iter().any(|l| l.ambient_cube.is_some()) {
            for (li, l) in leaf_records.iter().enumerate() {
                if let Some(c) = &l.ambient_cube {
                    spans[li] = [samples.len(), 1];
                    samples.push(sample(c, [128; 3]));
                }
            }
        }
        if samples.is_empty() {
            return None;
        }
        let mean = samples.iter().map(|s| cube_at(s).iter().flatten().sum::<f32>() as f64 * 255.0 / 18.0).sum::<f64>() / samples.len() as f64;
        let own_compiler = mean > OWN_COMPILER_MEAN as f64;

        let (lights, _) = pick(WORLDLIGHTS_HDR, WORLDLIGHTS);
        let lights = world_lights(lights, csgo);
        let leaves = leaf_records
            .iter()
            .zip(&spans)
            .map(|(l, &ambient)| LeafInfo {
                cluster: l.cluster,
                mins: l.mins.map(f32::from),
                maxs: l.maxs.map(f32::from),
                first_brush: l.first_leaf_brush as usize,
                brush_count: l.leaf_brush_count as usize,
                ambient,
            })
            .collect();

        let plane_records: &[Plane] = crate::lump!(bsp, playsrc_bsp::PLANES, Planes);
        let planes: Vec<([f32; 3], f32)> = plane_records.iter().map(|p| (v3(p.normal), p.distance.value())).collect();
        let node_records: &[playsrc_bsp::Node] = crate::lump!(bsp, playsrc_bsp::NODES, Nodes);
        let models: &[playsrc_bsp::Model] = crate::lump!(bsp, playsrc_bsp::MODELS, Models);
        let texinfo: &[TextureInfo] = crate::lump!(bsp, playsrc_bsp::TEXINFO, TextureInfo);
        let brush_records: &[Brush] = crate::lump!(bsp, playsrc_bsp::BRUSHES, Brushes);
        let side_records: &[BrushSide] = crate::lump!(bsp, playsrc_bsp::BRUSHSIDES, BrushSides);
        let leaf_brushes: &[u16] = crate::lump!(bsp, playsrc_bsp::LEAFBRUSHES, LeafBrushes);
        let sides = side_records
            .iter()
            .map(|s| {
                let sky = texinfo.get(s.texture_info_index.max(0) as usize).is_some_and(|t| s.texture_info_index >= 0 && t.flags & (SURF_SKY | SURF_SKY2D) != 0);
                s.plane_index as u32 | if sky { SIDE_SKY } else { 0 }
            })
            .collect();
        let drawn = crate::mesh::texinfo_drawn(bsp);
        let brushes: Vec<TraceBrush> = brush_records
            .iter()
            .map(|b| {
                let (first_side, side_count) = (b.first_side.max(0) as usize, b.side_count.max(0) as usize);
                let opaque = b.contents & MASK_OPAQUE != 0;
                let seen = opaque
                    && side_records.iter().skip(first_side).take(side_count).any(|s| s.bevel == 0 && s.texture_info_index >= 0 && drawn.get(s.texture_info_index as usize) == Some(&true));
                TraceBrush { first_side, side_count, opaque, seen }
            })
            .collect();
        Some(Self {
            hdr: ambient_hdr,
            lights,
            ambient_has_direct: own_compiler,
            ambient_scale: if own_compiler { 1.0 } else { 255.0 },
            nodes: node_records.iter().map(|n| (n.plane_index.max(0) as usize, n.children)).collect(),
            planes,
            head: models.first().map_or(0, |m| m.head_node),
            leaves,
            samples,
            leaf_brushes: leaf_brushes.to_vec(),
            checked: RefCell::new((0, vec![0; brushes.len()])),
            brushes,
            sides,
            vis: raw(bsp, playsrc_bsp::VISIBILITY).to_vec(),
            pvs: RefCell::new((-1, Vec::new())),
        })
    }

    /// Leaf containing `p` (front side when on a plane, like `CM_PointLeafnum`).
    fn leaf(&self, p: [f32; 3]) -> Option<usize> {
        let mut node = self.head;
        for _ in 0..self.nodes.len() + 1 {
            if node < 0 {
                return Some((-1 - node) as usize);
            }
            let &(plane, children) = self.nodes.get(node as usize)?;
            let &(n, d) = self.planes.get(plane)?;
            node = children[if dot(n, p) - d >= 0.0 { 0 } else { 1 }];
        }
        None
    }

    /// The leaf's ambient cube at `p`: its samples weighted by inverse squared distance (`Mod_LeafAmbientColorAtPos`).
    /// None in a leaf without samples (solid, or outside the map).
    pub fn ambient(&self, p: [f32; 3]) -> Option<Cube> {
        let leaf = self.leaves.get(self.leaf(p)?)?;
        let [first, count] = leaf.ambient;
        if count == 0 {
            return None;
        }
        let mut out = [[0f32; 3]; 6];
        let mut total = 0.0;
        for s in &self.samples[first..first + count] {
            let d2: f32 = (0..3).map(|k| (p[k] - (leaf.mins[k] + (leaf.maxs[k] - leaf.mins[k]) * s[24 + k] as f32 / 255.0)).powi(2)).sum();
            let w = 1.0 / (d2 + 1.0);
            total += w;
            for (o, c) in out.iter_mut().zip(&cube_at(s)) {
                (0..3).for_each(|k| o[k] += c[k] * w);
            }
        }
        for o in &mut out {
            (0..3).for_each(|k| o[k] *= self.ambient_scale / total);
        }
        Some(out)
    }

    /// Whether `cluster` is in the PVS of `from` (true when either is unknown).
    fn sees(&self, from: i32, cluster: i32) -> bool {
        if from < 0 || cluster < 0 || self.vis.len() < 4 {
            return true;
        }
        let count = i32_at(&self.vis, 0).max(0) as usize;
        if from as usize >= count || cluster as usize >= count {
            return true;
        }
        let mut cached = self.pvs.borrow_mut();
        if cached.0 != from {
            let mut row = vec![0u8; count.div_ceil(8)];
            let mut at = i32_at(&self.vis, 4 + from as usize * 8).max(0) as usize;
            let mut out = 0;
            // Run-length rows: a zero byte is followed by how many zero bytes it stands for.
            while out < row.len() && at < self.vis.len() {
                if self.vis[at] != 0 {
                    row[out] = self.vis[at];
                    out += 1;
                    at += 1;
                } else {
                    out += self.vis.get(at + 1).copied().unwrap_or(1).max(1) as usize;
                    at += 2;
                }
            }
            *cached = (from, row);
        }
        cached.1[cluster as usize >> 3] & (1 << (cluster & 7)) != 0
    }

    /// Follows `a -> b` through the world's opaque brushes: None if nothing is hit, else whether the first thing hit
    /// is sky (a ray that starts inside a brush counts as hitting it, not sky).
    pub fn trace(&self, a: [f32; 3], b: [f32; 3]) -> Option<bool> {
        self.first_hit(a, b, false, false).map(|(_, sky)| sky)
    }

    /// The fraction of `a -> b` before the first opaque world brush (0 when `a` is inside one), None if nothing is hit.
    pub fn hit(&self, a: [f32; 3], b: [f32; 3]) -> Option<f32> {
        self.first_hit(a, b, false, false).map(|(t, _)| t)
    }

    /// Like `hit`, but a brush `a` starts inside doesn't stop it (the engine's trace marks that start solid and goes
    /// on to the next brush it enters): a spotlight set inside its lamp's brush still shines to the floor.
    pub fn hit_leaving(&self, a: [f32; 3], b: [f32; 3]) -> Option<f32> {
        self.first_hit(a, b, false, true).map(|(t, _)| t)
    }

    /// Like `hit`, against only the opaque brushes the view sees (a side drawn): invisible tool brushes let it through.
    pub fn hit_seen(&self, a: [f32; 3], b: [f32; 3]) -> Option<f32> {
        self.first_hit(a, b, true, false).map(|(t, _)| t)
    }

    fn first_hit(&self, a: [f32; 3], b: [f32; 3], seen_only: bool, leave_start: bool) -> Option<(f32, bool)> {
        let mut checked = self.checked.borrow_mut();
        checked.0 = checked.0.wrapping_add(1);
        if checked.0 == 0 {
            checked.1.fill(0);
            checked.0 = 1;
        }
        let stamp = checked.0;
        let mut best: Option<(f32, bool)> = None;
        // (node, t0, t1): the part of the segment inside this subtree.
        let mut stack = vec![(self.head, 0f32, 1f32)];
        while let Some((node, t0, t1)) = stack.pop() {
            if best.is_some_and(|(t, _)| t < t0) {
                continue;
            }
            if node < 0 {
                let Some(leaf) = self.leaves.get((-1 - node) as usize) else { continue };
                for &bi in self.leaf_brushes.iter().skip(leaf.first_brush).take(leaf.brush_count) {
                    let Some(brush) = self.brushes.get(bi as usize) else { continue };
                    if !(if seen_only { brush.seen } else { brush.opaque }) || std::mem::replace(&mut checked.1[bi as usize], stamp) == stamp {
                        continue;
                    }
                    let (mut enter, mut leave, mut side_sky, mut outside) = (-1f32, 1f32, false, false);
                    let mut miss = brush.side_count == 0;
                    for &side in self.sides.iter().skip(brush.first_side).take(brush.side_count) {
                        let Some(&(normal, dist)) = self.planes.get((side & !SIDE_SKY) as usize) else { continue };
                        let d1 = dot(normal, a) - dist;
                        let d2 = dot(normal, b) - dist;
                        if d1 > 0.0 {
                            outside = true;
                        }
                        if d1 > 0.0 && d2 >= d1 {
                            miss = true;
                            break;
                        }
                        if d1 <= 0.0 && d2 <= 0.0 {
                            continue;
                        }
                        let f = d1 / (d1 - d2);
                        if d1 > d2 {
                            if f > enter {
                                (enter, side_sky) = (f, side & SIDE_SKY != 0);
                            }
                        } else {
                            leave = leave.min(f);
                        }
                    }
                    if miss {
                        continue;
                    }
                    if !outside {
                        if leave_start {
                            continue;
                        }
                        return Some((0.0, false));
                    }
                    if enter < leave && enter >= 0.0 && best.is_none_or(|(t, _)| enter < t) {
                        best = Some((enter, side_sky));
                    }
                }
                continue;
            }
            let Some(&(plane, children)) = self.nodes.get(node as usize) else { continue };
            let Some(&(n, d)) = self.planes.get(plane) else { continue };
            let at = |t: f32| [0, 1, 2].map(|k| a[k] + (b[k] - a[k]) * t);
            let (d0, d1) = (dot(n, at(t0)) - d, dot(n, at(t1)) - d);
            if d0 >= 0.0 && d1 >= 0.0 {
                stack.push((children[0], t0, t1));
            } else if d0 < 0.0 && d1 < 0.0 {
                stack.push((children[1], t0, t1));
            } else {
                let mid = t0 + (t1 - t0) * (d0 / (d0 - d1));
                let (near, far) = if d0 >= 0.0 { (children[0], children[1]) } else { (children[1], children[0]) };
                // The far side is popped after the near one; brushes straddling the plane sit in both leaves.
                stack.push((far, mid, t1));
                stack.push((near, t0, mid));
            }
        }
        best
    }

    /// The world lights that reach `p`, each as its colour there (falloff and cone applied, the surface angle not).
    pub fn direct(&self, p: [f32; 3]) -> Vec<Direct> {
        if self.ambient_has_direct {
            return Vec::new();
        }
        let cluster = self.leaf(p).and_then(|l| self.leaves.get(l)).map_or(-1, |l| l.cluster as i32);
        let mut out = Vec::new();
        for (i, l) in self.lights.iter().enumerate() {
            let brightest = l.intensity[0].max(l.intensity[1]).max(l.intensity[2]);
            match l.kind {
                EMIT_SKYLIGHT => {
                    let dir = l.normal.map(|v| -v);
                    if brightest < MIN_LIGHT || self.trace(p, [0, 1, 2].map(|k| p[k] + dir[k] * SKY_TRACE)) != Some(true) {
                        continue;
                    }
                    out.push(Direct { light: i, dir, color: l.intensity });
                }
                EMIT_POINT | EMIT_SPOTLIGHT => {
                    let delta = [0, 1, 2].map(|k| l.origin[k] - p[k]);
                    let dist = dot(delta, delta).sqrt();
                    let scale = self.falloff(l, delta, dist);
                    if brightest * scale < MIN_LIGHT || !self.sees(cluster, l.cluster) || self.trace(p, l.origin).is_some() {
                        continue;
                    }
                    out.push(Direct { light: i, dir: delta.map(|v| v / dist.max(1e-6)), color: l.intensity.map(|v| v * scale) });
                }
                // Surface lights and the sky's ambient are already in the leaf cubes.
                _ => {}
            }
        }
        out
    }

    /// Distance falloff times the spotlight cone for a point `delta` away from the light (towards it), `dist` long
    /// (`Engine_WorldLightDistanceFalloff`, the cone of `Engine_WorldLightAngle`).
    pub fn falloff(&self, l: &WorldLight, delta: [f32; 3], dist: f32) -> f32 {
        if l.radius != 0.0 && dist > l.radius {
            return 0.0;
        }
        let denom = l.attn[0] + l.attn[1] * dist + l.attn[2] * dist * dist;
        if denom <= 0.0 {
            return 0.0;
        }
        let mut scale = 1.0 / denom;
        if l.kind == EMIT_SPOTLIGHT {
            let cone = -dot(delta, l.normal) / dist.max(1e-6);
            if cone <= l.stopdot2 {
                return 0.0;
            }
            if cone < l.stopdot {
                let t = (cone - l.stopdot2) / (l.stopdot - l.stopdot2).max(1e-6);
                scale *= if l.exponent == 0.0 || l.exponent == 1.0 { t } else { t.powf(l.exponent) };
            }
        }
        scale
    }

    /// Ambient plus direct light at `p` as one cube; None where the map has no ambient (see `ambient`).
    pub fn cube(&self, p: [f32; 3]) -> Option<Cube> {
        let mut cube = self.ambient(p)?;
        for d in self.direct(p) {
            for (face, axis) in cube.iter_mut().zip(&CUBE_DIRS) {
                let w = dot(d.dir, *axis).max(0.0);
                (0..3).for_each(|k| face[k] += d.color[k] * w);
            }
        }
        Some(cube)
    }
}

/// A cube's colour for a surface facing `n` (Source's `AmbientLight`: the three facing sides, weighted by n²).
pub fn cube_color(cube: &Cube, n: [f32; 3]) -> [f32; 3] {
    let mut out = [0f32; 3];
    for axis in 0..3 {
        let side = &cube[axis * 2 + (n[axis] < 0.0) as usize];
        let w = n[axis] * n[axis];
        (0..3).for_each(|k| out[k] += side[k] * w);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgbexp_is_linear_light() {
        assert_eq!(rgbexp(&[255, 0, 128, 0]), [1.0, 0.0, 128.0 / 255.0]);
        assert_eq!(rgbexp(&[255, 255, 255, 1])[0], 2.0);
        assert!((rgbexp(&[204, 204, 204, (-3i8) as u8])[0] - 0.1).abs() < 1e-6);
    }

    #[test]
    fn cube_color_weights_the_facing_sides() {
        let cube: Cube = [[1.0; 3], [2.0; 3], [3.0; 3], [4.0; 3], [5.0; 3], [6.0; 3]];
        assert_eq!(cube_color(&cube, [0.0, 0.0, 1.0]), [5.0; 3]);
        assert_eq!(cube_color(&cube, [0.0, -1.0, 0.0]), [4.0; 3]);
        let d = 0.5f32.sqrt();
        let c = cube_color(&cube, [d, 0.0, -d]);
        assert!((c[0] - 3.5).abs() < 1e-5);
    }

    #[test]
    fn world_light_records() {
        let mut r = vec![0u8; 88];
        let put = |r: &mut Vec<u8>, o: usize, v: f32| r[o..o + 4].copy_from_slice(&v.to_le_bytes());
        put(&mut r, 0, 10.0);
        put(&mut r, 12, 3.0);
        put(&mut r, 32, -1.0);
        r[36..40].copy_from_slice(&7i32.to_le_bytes());
        r[40..44].copy_from_slice(&EMIT_SPOTLIGHT.to_le_bytes());
        put(&mut r, 48, 0.9);
        put(&mut r, 72, 0.5);
        let mut styled = r.clone();
        styled[44..48].copy_from_slice(&32i32.to_le_bytes());
        let lights = world_lights(&[r.clone(), styled].concat(), false);
        assert_eq!(lights.len(), 1);
        let l = lights[0];
        assert_eq!((l.origin[0], l.intensity[0], l.normal[2], l.cluster, l.kind, l.stopdot, l.attn[2]), (10.0, 3.0, -1.0, 7, EMIT_SPOTLIGHT, 0.9, 0.5));
        // CS:GO: 12 more bytes after the normal.
        let mut go = r[..36].to_vec();
        go.extend_from_slice(&[0; 12]);
        go.extend_from_slice(&r[36..]);
        assert_eq!(world_lights(&go, true), lights);
    }
}
