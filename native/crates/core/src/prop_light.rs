//! Static prop lighting from the map (render-only), one linear RGB colour per prop mesh vertex.
//!
//! Source lights a static prop one of two ways (`CStaticProp`, `CModelRender`):
//! * VRAD run with `-StaticPropLighting` packs a `sp_<n>.vhv` (`sp_hdr_<n>.vhv`) per prop: a colour per vertex, direct
//!   and bounced light together. The prop is drawn with those colours and nothing else.
//! * Otherwise the prop takes the light at its lighting origin (the lump's, else the model's illumination point): the
//!   leaf's ambient cube by each vertex normal, plus the world lights that can see that point.
//!
//! Entity props (prop_dynamic, doors, physics props) always take the second path, at their spawn pose.

use crate::lighting::{cube_color, Cube, Direct, Lighting};
use crate::props::{angle_matrix, lighting_groups, model_files, PropMesh, StaticProps, PROP_VERTEX_FLOATS};
use crate::vfs::Vfs;

/// Marks a vertex this bake has no light for (its prop sits in solid with no ambient samples anywhere near it).
pub const NO_LIGHT: f32 = -1.0;
/// Linear light is capped here: far past what any display path keeps, and it stops a broken record from blowing up.
const MAX_LIGHT: f32 = 16.0;

fn u32_at(b: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?))
}

/// A `.vhv` byte as linear light: VRAD stores `0.5 * L^(1/2.2)` (`LinearToVertexLight`), the shader undoes it.
fn vertex_light(byte: u8) -> f32 {
    (byte as f32 / 255.0 * 2.0).powf(2.2)
}

/// The colours of a `.vhv` file per vertex of the model's LOD 0 (`ModelGeometry::vertices` order), or None when the
/// file doesn't fit the model (another model build, an unknown layout).
pub fn baked_colors(vhv: &[u8], mdl: &[u8], groups: &[(usize, usize, Vec<u32>)], vertices: usize) -> Option<Vec<[f32; 3]>> {
    // FileHeader_t: version, checksum, vertex flags, vertex size, vertex count, mesh count, 4 unused.
    if u32_at(vhv, 0)? != 2 || u32_at(vhv, 4)? != u32_at(mdl, 8)? || u32_at(vhv, 12)? != 4 {
        return None;
    }
    if u32_at(vhv, 20)? as usize != groups.len() {
        return None;
    }
    let mut out = vec![[0f32; 3]; vertices];
    for (k, (lod, count, verts)) in groups.iter().enumerate() {
        // MeshHeader_t: lod, vertex count, byte offset, 4 unused.
        let h = 40 + k * 28;
        if u32_at(vhv, h)? as usize != *lod || u32_at(vhv, h + 4)? as usize != *count {
            return None;
        }
        let offset = u32_at(vhv, h + 8)? as usize;
        for (j, &v) in verts.iter().enumerate() {
            // Stored b, g, r, a.
            let c = vhv.get(offset + j * 4..offset + j * 4 + 4)?;
            *out.get_mut(v as usize)? = [vertex_light(c[2]), vertex_light(c[1]), vertex_light(c[0])];
        }
    }
    Some(out)
}

enum PropLight {
    Baked(Vec<[f32; 3]>),
    /// Ambient cube and the lights reaching the prop's lighting origin.
    Point(Cube, Vec<Direct>),
    None,
}

struct ModelInfo {
    illum: [f32; 3],
    groups: Option<Vec<(usize, usize, Vec<u32>)>>,
    vertices: usize,
}

/// One RGB triple per vertex of `mesh` (`NO_LIGHT` in all three where there is none).
pub fn bake(sp: &StaticProps, mesh: &PropMesh, vfs: &Vfs, lighting: &Lighting) -> Vec<f32> {
    let models: Vec<Option<ModelInfo>> = sp
        .models
        .iter()
        .map(|m| {
            let [mdl_p, vvd_p, vtx_p] = model_files(m);
            let mdl = vfs.read(&mdl_p)?;
            let f = |o: usize| mdl.get(o..o + 4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]));
            let illum = [f(92)?, f(96)?, f(100)?];
            let groups = vfs.read(&vtx_p).and_then(|vtx| lighting_groups(mdl, vtx));
            // LOD 0 vertex count (VVD header: numLODVertexes[0]).
            let vertices = vfs.read(&vvd_p).and_then(|vvd| u32_at(vvd, 16)).unwrap_or(0) as usize;
            Some(ModelInfo { illum, groups, vertices })
        })
        .collect();

    let light_of = |pi: usize| -> PropLight {
        let Some(p) = sp.props.get(pi) else { return PropLight::None };
        let Some(Some(model)) = models.get(p.model) else { return PropLight::None };
        if !p.entity && let Some(groups) = &model.groups {
            let [mdl_p, ..] = model_files(&sp.models[p.model]);
            let names = if lighting.hdr { [format!("sp_hdr_{pi}.vhv"), format!("sp_{pi}.vhv")] } else { [format!("sp_{pi}.vhv"), format!("sp_hdr_{pi}.vhv")] };
            let baked = names.iter().find_map(|n| vfs.read(n)).zip(vfs.read(&mdl_p)).and_then(|(vhv, mdl)| baked_colors(vhv, mdl, groups, model.vertices));
            if let Some(colors) = baked {
                return PropLight::Baked(colors);
            }
        }
        let r = angle_matrix(p.angles);
        let illum = [0, 1, 2].map(|i| p.origin[i] + (r[i][0] * model.illum[0] + r[i][1] * model.illum[1] + r[i][2] * model.illum[2]) * p.scale);
        // The lighting origin, then a few steps back to somewhere with samples (an origin sunk into the floor).
        let lift = |z: f32| [p.origin[0], p.origin[1], p.origin[2] + z];
        let tries = [p.light_origin.unwrap_or(illum), illum, lift(0.0), lift(16.0), lift(48.0)];
        match tries.iter().find_map(|&at| lighting.ambient(at).map(|cube| (at, cube))) {
            Some((at, cube)) => PropLight::Point(cube, lighting.direct(at)),
            None => PropLight::None,
        }
    };

    let mut lights: Vec<Option<PropLight>> = (0..sp.props.len()).map(|_| None).collect();
    let mut out = Vec::with_capacity(mesh.sources.len() * 3);
    for (v, &[pi, vi]) in mesh.vertices.chunks_exact(PROP_VERTEX_FLOATS).zip(&mesh.sources) {
        let pi = pi as usize;
        let Some(slot) = lights.get_mut(pi) else {
            out.extend_from_slice(&[NO_LIGHT; 3]);
            continue;
        };
        let color = match slot.get_or_insert_with(|| light_of(pi)) {
            PropLight::None => [NO_LIGHT; 3],
            PropLight::Baked(colors) => colors.get(vi as usize).copied().unwrap_or([NO_LIGHT; 3]),
            PropLight::Point(cube, direct) => {
                let p = &sp.props[pi];
                let (mut pos, mut n) = ([v[0], v[1], v[2]], [v[3], v[4], v[5]]);
                if p.owner != 0 {
                    // Moving props are stored in model space: light them where they spawn.
                    let r = angle_matrix(p.angles);
                    let xf = |a: [f32; 3]| [0, 1, 2].map(|i| r[i][0] * a[0] + r[i][1] * a[1] + r[i][2] * a[2]);
                    pos = xf(pos);
                    (0..3).for_each(|k| pos[k] += p.origin[k]);
                    n = xf(n);
                }
                let mut c = cube_color(cube, n);
                for d in direct.iter() {
                    let l = &lighting.lights[d.light];
                    let (dir, color) = if l.kind == crate::lighting::EMIT_SKYLIGHT {
                        (d.dir, d.color)
                    } else {
                        // Distance and cone per vertex, like the engine's local lights; visibility from the origin.
                        let delta = [0, 1, 2].map(|k| l.origin[k] - pos[k]);
                        let dist = (delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2]).sqrt().max(1e-6);
                        let scale = lighting.falloff(l, delta, dist);
                        (delta.map(|x| x / dist), l.intensity.map(|x| x * scale))
                    };
                    let w = (n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2]).max(0.0);
                    (0..3).for_each(|k| c[k] += color[k] * w);
                }
                c.map(|x| if x.is_finite() { x.clamp(0.0, MAX_LIGHT) } else { 0.0 })
            }
        };
        out.extend_from_slice(&color);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vertex_light_undoes_vrad() {
        assert_eq!(vertex_light(0), 0.0);
        // 0.5 * 1^(1/2.2) = 127.5: full light sits at byte 128.
        assert!((vertex_light(128) - 1.0).abs() < 0.02);
        assert!((vertex_light(255) - 2f32.powf(2.2)).abs() < 1e-3);
    }

    #[test]
    fn baked_colors_follow_the_strip_groups() {
        // A model with two LOD 0 groups (3 and 2 vertices, sharing vertex 1) and one LOD 1 group between them.
        let groups = vec![(0, 3, vec![2, 1, 0]), (1, 2, vec![]), (0, 2, vec![1, 3])];
        let mut mdl = vec![0u8; 12];
        mdl[8..12].copy_from_slice(&0xabcdu32.to_le_bytes());
        let mut vhv = Vec::new();
        for v in [2u32, 0xabcd, 0, 4, 7, 3, 0, 0, 0, 0] {
            vhv.extend_from_slice(&v.to_le_bytes());
        }
        let data = 40 + 3 * 28;
        for (lod, count, offset) in [(0u32, 3u32, data), (1, 2, data + 12), (0, 2, data + 20)] {
            for v in [lod, count, offset as u32, 0, 0, 0, 0] {
                vhv.extend_from_slice(&v.to_le_bytes());
            }
        }
        // b, g, r, a per vertex: group 0, the LOD 1 group, group 2.
        for px in [[0u8, 0, 255, 255], [0, 128, 0, 255], [255, 0, 0, 255], [9, 9, 9, 255], [9, 9, 9, 255], [0, 128, 0, 255], [128, 128, 128, 255]] {
            vhv.extend_from_slice(&px);
        }
        let colors = baked_colors(&vhv, &mdl, &groups, 4).unwrap();
        let full = 2f32.powf(2.2);
        assert!((colors[2][0] - full).abs() < 1e-3 && colors[2][1] == 0.0);
        assert!((colors[1][1] - 1.0).abs() < 0.02 && colors[1][0] == 0.0);
        assert!((colors[0][2] - full).abs() < 1e-3);
        assert!((colors[3][0] - 1.0).abs() < 0.02);

        // Another build of the model (checksum), or a different group layout: not used.
        let mut other = mdl.clone();
        other[8] ^= 1;
        assert!(baked_colors(&vhv, &other, &groups, 4).is_none());
        assert!(baked_colors(&vhv, &mdl, &groups[..2], 4).is_none());
        let mut counts = groups.clone();
        counts[0].1 = 4;
        assert!(baked_colors(&vhv, &mdl, &counts, 4).is_none());
        assert!(baked_colors(&vhv[..vhv.len() - 2], &mdl, &groups, 4).is_none());
    }
}
