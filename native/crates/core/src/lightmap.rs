//! Lightmap atlas: packs every lit face's style-0 lightmap into one RGBA8 texture.
//!
//! Samples are Source RGBExp32 (`c * 2^exp / 255` = linear light, 1.0 = full
//! brightness). They are stored sRGB-encoded at `LIGHTMAP_SCALE` so that the
//! overbright range up to `1 / LIGHTMAP_SCALE` survives in 8 bits; the client
//! multiplies back by `1 / LIGHTMAP_SCALE` after the GPU's sRGB decode.
//! Only style 0 is used (switchable light styles are ignored), and only the first
//! (non-bumped) lightmap of bumpmapped faces.

use playsrc_bsp::{Bsp, Face, LightSample, LumpData, TextureInfo};

pub const LIGHTMAP_SCALE: f32 = 0.25;
/// Mild lift of dark luxels. Pure linear math looks noticeably darker than Source's LDR
/// gamma-space lightmap pipeline on dim maps; this keeps 1.0 fixed and brightens shadows.
const LIGHTMAP_CURVE: f32 = 0.75;
const SURF_NOLIGHT: i32 = 0x400;
const BORDER: u32 = 1;
const WHITE_BLOCK: u32 = 4;

/// Top-left of a face's luxel block inside the atlas (border excluded).
#[derive(Clone, Copy, Debug)]
pub struct LightmapRect {
    pub x: u32,
    pub y: u32,
}

#[derive(Default)]
pub struct Atlas {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

pub struct Built {
    pub atlas: Atlas,
    /// Per face index; `None` = render fullbright.
    pub rects: Vec<Option<LightmapRect>>,
    /// Atlas UV of a block of full-brightness texels (for unlit faces).
    pub white_uv: [f32; 2],
}

fn linear_to_srgb(v: f32) -> u8 {
    let v = v.clamp(0.0, 1.0);
    let s = if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
    (s * 255.0 + 0.5) as u8
}

/// Lookup table over the 8-bit mantissa for each exponent in the commonly used range.
struct Encoder {
    table: Vec<[u8; 256]>,
}

impl Encoder {
    const MIN_EXP: i32 = -32;
    const MAX_EXP: i32 = 16;

    fn new() -> Self {
        let table = (Self::MIN_EXP..=Self::MAX_EXP)
            .map(|e| {
                let mut row = [0u8; 256];
                for (c, out) in row.iter_mut().enumerate() {
                    let linear = (c as f32 * 2f32.powi(e) / 255.0).powf(LIGHTMAP_CURVE);
                    *out = linear_to_srgb(linear * LIGHTMAP_SCALE);
                }
                row
            })
            .collect();
        Self { table }
    }

    fn encode(&self, s: &LightSample) -> [u8; 4] {
        let e = (s.exponent as i32).clamp(Self::MIN_EXP, Self::MAX_EXP);
        let row = &self.table[(e - Self::MIN_EXP) as usize];
        [row[s.red as usize], row[s.green as usize], row[s.blue as usize], 255]
    }
}

pub fn build(bsp: &Bsp, faces: &[Face], texinfo: &[TextureInfo]) -> Built {
    let mut lighting: &[LightSample] = crate::lump!(bsp, playsrc_bsp::LIGHTING, Lighting);
    if lighting.is_empty() {
        lighting = crate::lump!(bsp, playsrc_bsp::LIGHTING_HDR, Lighting);
    }
    // CS:GO (v21) lighting is kept raw by the BSP crate (face offsets are byte offsets there, not sample
    // indices): copy each face's style-0 samples into one contiguous array and index that instead.
    let csgo = bsp.profile == playsrc_bsp::Profile::CsgoV21;
    let mut csgo_samples: Vec<LightSample> = Vec::new();
    let csgo_raw: &[u8] = if csgo {
        let raw = |i| bsp.lump(i).map(|l| l.bytes(bsp)).unwrap_or(&[]);
        if raw(playsrc_bsp::LIGHTING).is_empty() { raw(playsrc_bsp::LIGHTING_HDR) } else { raw(playsrc_bsp::LIGHTING) }
    } else {
        &[]
    };

    // (face index, luxel width, luxel height, first sample)
    let mut items: Vec<(usize, u32, u32, usize)> = Vec::new();
    for (fi, f) in faces.iter().enumerate() {
        let Some(ti) = texinfo.get(f.texture_info_index.max(0) as usize) else { continue };
        if f.texture_info_index < 0 || ti.flags & SURF_NOLIGHT != 0 || f.light_offset < 0 || f.styles[0] == 255 {
            continue;
        }
        let (w, h) = (f.lightmap_size[0] + 1, f.lightmap_size[1] + 1);
        if w <= 0 || h <= 0 || w > 1024 || h > 1024 {
            continue;
        }
        if csgo {
            let Some(samples) = playsrc_bsp::csgo_light_samples(csgo_raw, f.light_offset as usize, (w * h) as usize) else { continue };
            items.push((fi, w as u32, h as u32, csgo_samples.len()));
            csgo_samples.extend(samples);
            continue;
        }
        let first = f.light_offset as usize / 4;
        if first + (w * h) as usize > lighting.len() {
            continue;
        }
        items.push((fi, w as u32, h as u32, first));
    }
    if csgo {
        lighting = &csgo_samples;
    }
    // Maps compiled without any light entity get black (or near-black ambient) lightmaps from VRAD; Source shows
    // them fullbright (bhop_stairs, bhop_mp_stairs, bhop_2_easy, bhop_redwood, ...). Treat "no visibly lit luxel"
    // like "no lighting data".
    if is_unlit(&items, lighting) {
        items.clear();
    }
    items.sort_by(|a, b| b.2.cmp(&a.2).then(b.1.cmp(&a.1)));

    let area: u64 = items.iter().map(|i| ((i.1 + 2 * BORDER) * (i.2 + 2 * BORDER)) as u64).sum::<u64>() + 64;
    let mut width = ((area as f64 * 1.15).sqrt() as u32).next_power_of_two().clamp(256, 4096);
    let (positions, height) = loop {
        let (pos, h) = pack(&items, width);
        if h <= width.max(4096) || width >= 16384 {
            break (pos, h);
        }
        width *= 2;
    };
    let height = height.max(WHITE_BLOCK).next_multiple_of(4);

    let mut atlas = Atlas { width, height, rgba: vec![0; (width * height * 4) as usize] };
    let enc = Encoder::new();
    let white = linear_to_srgb(LIGHTMAP_SCALE);
    for y in 0..WHITE_BLOCK {
        for x in 0..WHITE_BLOCK {
            let o = ((y * width + x) * 4) as usize;
            atlas.rgba[o..o + 4].copy_from_slice(&[white, white, white, 255]);
        }
    }

    let mut rects = vec![None; faces.len()];
    for (&(fi, w, h, first), &(px, py)) in items.iter().zip(&positions) {
        let samples = &lighting[first..first + (w * h) as usize];
        for y in 0..h + 2 * BORDER {
            let sy = (y as i32 - BORDER as i32).clamp(0, h as i32 - 1) as u32;
            for x in 0..w + 2 * BORDER {
                let sx = (x as i32 - BORDER as i32).clamp(0, w as i32 - 1) as u32;
                let o = (((py + y) * width + px + x) * 4) as usize;
                atlas.rgba[o..o + 4].copy_from_slice(&enc.encode(&samples[(sy * w + sx) as usize]));
            }
        }
        rects[fi] = Some(LightmapRect { x: px + BORDER, y: py + BORDER });
    }

    let half = WHITE_BLOCK as f32 / 2.0;
    Built { white_uv: [half / width as f32, half / height as f32], atlas, rects }
}

/// True if no face's lightmap has a visibly lit luxel. VRAD with no light entities writes all-zero (or
/// near-zero ambient, e.g. `204 * 2^-11`) lightmaps; Source shows such maps fullbright.
fn is_unlit(items: &[(usize, u32, u32, usize)], lighting: &[LightSample]) -> bool {
    const VISIBLE: f32 = 1.0 / 255.0;
    let lit = |s: &LightSample| (s.red.max(s.green).max(s.blue) as f32) * 2f32.powi(s.exponent as i32) / 255.0 >= VISIBLE;
    !items.is_empty() && items.iter().all(|&(_, w, h, first)| !lighting[first..first + (w * h) as usize].iter().any(lit))
}

/// Shelf packing (items pre-sorted by height). Returns top-left positions incl. border, and used height.
fn pack(items: &[(usize, u32, u32, usize)], width: u32) -> (Vec<(u32, u32)>, u32) {
    let mut out = Vec::with_capacity(items.len());
    // The first shelf starts after the reserved white block.
    let (mut x, mut y, mut shelf_h) = (WHITE_BLOCK, 0u32, WHITE_BLOCK);
    for &(_, w, h, _) in items {
        let (bw, bh) = (w + 2 * BORDER, h + 2 * BORDER);
        if x + bw > width {
            y += shelf_h;
            x = 0;
            shelf_h = 0;
        }
        out.push((x, y));
        x += bw;
        shelf_h = shelf_h.max(bh);
    }
    (out, y + shelf_h)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(v: u8) -> LightSample {
        LightSample { red: v, green: v, blue: v, exponent: 0 }
    }

    #[test]
    fn all_black_lighting_is_unlit() {
        let black = vec![sample(0); 8];
        assert!(is_unlit(&[(0, 2, 2, 0), (1, 2, 2, 4)], &black));
        let mut lit = black.clone();
        lit[5] = sample(3);
        assert!(!is_unlit(&[(0, 2, 2, 0), (1, 2, 2, 4)], &lit));
        // bhop_redwood: no lights, VRAD's near-zero ambient everywhere.
        let ambient = vec![LightSample { red: 204, green: 204, blue: 204, exponent: -11 }; 8];
        assert!(is_unlit(&[(0, 2, 2, 0), (1, 2, 2, 4)], &ambient));
        let dim = vec![LightSample { red: 40, green: 30, blue: 20, exponent: -2 }; 8];
        assert!(!is_unlit(&[(0, 2, 2, 0), (1, 2, 2, 4)], &dim));
        // No lightmapped faces at all: nothing to decide (already fullbright).
        assert!(!is_unlit(&[], &black));
    }
}
