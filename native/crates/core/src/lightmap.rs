//! Lightmap atlas: packs every lit face's style-0 lightmap into one RGBA8 texture.
//!
//! Samples are Source RGBExp32 (`c * 2^exp / 255` = linear light, 1.0 = full brightness), encoded the way
//! CS:S draws them:
//! - Maps with HDR lighting (CS:S runs them with `mat_hdr_level 2`) use the HDR lump as plain linear light,
//!   stored sRGB-encoded at `HDR_SCALE` so the overbright range up to `1 / HDR_SCALE` survives in 8 bits.
//! - LDR-only maps use Source's LDR lightmap texels exactly (`lineartolightmap`, mathlib/color_conversion.cpp):
//!   `0.5 * L^(1/2.2)`, which the GPU then decodes as sRGB and scales by 2^2.2. The sRGB/2.2 mismatch lifts dark
//!   luxels (about 2.3x at L = 0.01, none from L = 0.5 up); that lift is part of how LDR maps look in CS:S.
//!
//! Either way the client multiplies the decoded texel by `1 / scale`. Only style 0 is used (switchable light
//! styles are ignored), and only the first (non-bumped) lightmap of bumpmapped faces.

use playsrc_bsp::{Bsp, Face, LightSample, LumpData, TextureInfo};

/// Atlas scale for HDR (linear) lightmaps.
pub const HDR_SCALE: f32 = 0.25;
/// Atlas scale for LDR lightmaps: Source's overbright 2 in linear space, 2^-2.2.
pub const LDR_SCALE: f32 = 0.217_637_64;
/// `mat_monitorgamma` / BuildGammaTable's gamma for the LDR lightmap table.
const LDR_GAMMA: f32 = 2.2;
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
    /// Built from the HDR lump (CS:S would use HDR rendering: auto exposure and bloom).
    pub hdr: bool,
    /// Multiply the sRGB-decoded texel by `1 / scale` for linear light.
    pub scale: f32,
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

    fn new(hdr: bool) -> Self {
        let table = (Self::MIN_EXP..=Self::MAX_EXP)
            .map(|e| {
                let mut row = [0u8; 256];
                for (c, out) in row.iter_mut().enumerate() {
                    *out = encode(c as f32 * 2f32.powi(e) / 255.0, hdr);
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

/// One linear-light channel as an atlas byte.
fn encode(linear: f32, hdr: bool) -> u8 {
    if hdr {
        return linear_to_srgb(linear * HDR_SCALE);
    }
    // BuildGammaTable: index = linear * 1024 (clamped to the table), (i / 1024)^(1/gamma) * 255 * 0.5, rounded.
    let i = (linear * 1024.0).round().clamp(0.0, 4091.0);
    ((i / 1024.0).powf(1.0 / LDR_GAMMA) * 255.0 * 0.5).round().clamp(0.0, 255.0) as u8
}

pub fn build(bsp: &Bsp, faces: &[Face], texinfo: &[TextureInfo]) -> Built {
    // Faces index both lumps with the same offsets (VRAD lays them out identically); a differently sized HDR lump
    // would not match them, so it is only used when the sizes agree or it's the only one.
    let ldr: &[LightSample] = crate::lump!(bsp, playsrc_bsp::LIGHTING, Lighting);
    let hdr_lump: &[LightSample] = crate::lump!(bsp, playsrc_bsp::LIGHTING_HDR, Lighting);
    let mut hdr = !hdr_lump.is_empty() && (ldr.is_empty() || hdr_lump.len() == ldr.len());
    let mut lighting = if hdr { hdr_lump } else { ldr };
    // CS:GO (v21) lighting is kept raw by the BSP crate (face offsets are byte offsets there, not sample
    // indices): copy each face's style-0 samples into one contiguous array and index that instead.
    let csgo = bsp.profile == playsrc_bsp::Profile::CsgoV21;
    let mut csgo_samples: Vec<LightSample> = Vec::new();
    let csgo_raw: &[u8] = if csgo {
        let raw = |i| bsp.lump(i).map(|l| l.bytes(bsp)).unwrap_or(&[]);
        // CS:GO only renders HDR.
        hdr = !raw(playsrc_bsp::LIGHTING_HDR).is_empty();
        if hdr { raw(playsrc_bsp::LIGHTING_HDR) } else { raw(playsrc_bsp::LIGHTING) }
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

    let scale = if hdr { HDR_SCALE } else { LDR_SCALE };
    let mut atlas = Atlas { width, height, rgba: vec![0; (width * height * 4) as usize], hdr, scale };
    let enc = Encoder::new(hdr);
    let white = encode(1.0, hdr);
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
    fn ldr_texels_match_source_table() {
        // lineartolightmap with gamma 2.2 and overbright 2.
        assert_eq!(encode(0.0, false), 0);
        assert_eq!(encode(1.0, false), 128);
        assert_eq!(encode(0.01, false), 16);
        // The table stops at 4x overbright.
        assert_eq!(encode(4.0, false), 239);
        assert_eq!(encode(100.0, false), 239);
        // Decoding as sRGB and dividing by LDR_SCALE gives back full light at 1.0.
        let srgb = |b: u8| ((b as f32 / 255.0 + 0.055) / 1.055).powf(2.4);
        assert!((srgb(128) / LDR_SCALE - 1.0).abs() < 0.02);
    }

    #[test]
    fn hdr_texels_are_linear() {
        assert_eq!(encode(1.0, true), linear_to_srgb(0.25));
        assert_eq!(encode(4.0, true), 255);
        assert!(encode(0.5, true) < encode(1.0, true));
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

/// Optional client presentation layer for switchable/animated light pages. It leaves the movement mesh and the
/// canonical style-0 atlas builder unchanged. Rectangles come from that builder, so UVs and packing cannot drift.
pub struct StyleAtlas {
    faces: Vec<StyleFace>,
    width: u32,
    height: u32,
    previous: Option<[f32; 64]>,
}
struct StyleFace {
    x: u32, y: u32, w: u32, h: u32,
    styles: Vec<u8>,
    pages: Vec<Vec<LightSample>>,
}
impl StyleAtlas {
    pub fn new(bsp: &Bsp) -> Option<Self> {
        if bsp.profile == playsrc_bsp::Profile::CsgoV21 { return None; }
        let faces: &[Face] = crate::lump!(bsp, playsrc_bsp::FACES, Faces);
        let texinfo: &[TextureInfo] = crate::lump!(bsp, playsrc_bsp::TEXINFO, TextureInfo);
        if !faces.iter().any(|f| f.styles[0] != 255 && (f.styles[0] != 0 || f.styles[1] != 255)) { return None; }
        let built = build(bsp, faces, texinfo);
        let lighting: &[LightSample] = if built.atlas.hdr { crate::lump!(bsp, playsrc_bsp::LIGHTING_HDR, Lighting) } else { crate::lump!(bsp, playsrc_bsp::LIGHTING, Lighting) };
        let mut work = Vec::new();
        let mut total = 0usize;
        for (i, f) in faces.iter().enumerate() {
            let Some(rect) = built.rects[i] else { continue };
            let styles = f.styles.iter().copied().take_while(|&s| s != 255).collect::<Vec<_>>();
            if styles.is_empty() || styles == [0] { continue; }
            let Some(ti) = texinfo.get(f.texture_info_index.max(0) as usize) else { continue };
            let (w,h) = ((f.lightmap_size[0]+1) as u32,(f.lightmap_size[1]+1) as u32);
            let n = (w*h) as usize;
            let stride = n * if ti.flags & 0x800 != 0 { 4 } else { 1 };
            let first = f.light_offset as usize / 4;
            if first.checked_add((styles.len()-1)*stride+n).is_none_or(|end| end>lighting.len()) { continue; }
            total += n*styles.len();
            if total > 16_777_216 { return None; } // bound optional presentation memory, never compromise map loading
            let pages = (0..styles.len()).map(|s| lighting[first+s*stride..first+s*stride+n].to_vec()).collect();
            work.push(StyleFace{x:rect.x,y:rect.y,w,h,styles,pages});
        }
        if work.is_empty() { return None; }
        Some(Self{faces:work,width:built.atlas.width,height:built.atlas.height,previous:None})
    }
    /// Rewrites only styled face blocks and their duplicated borders when a style value changes.
    pub fn apply(&mut self, atlas: &mut Atlas, values: &[f32;64]) -> bool {
        if self.width!=atlas.width || self.height!=atlas.height || self.previous.as_ref()==Some(values) { return false; }
        for face in &self.faces {
            for y in 0..face.h+2 { let sy=(y as i32-1).clamp(0,face.h as i32-1) as u32;
                for x in 0..face.w+2 { let sx=(x as i32-1).clamp(0,face.w as i32-1) as u32;
                    let sample=(sy*face.w+sx) as usize;
                    let mut linear=[0f32;3];
                    for (page,&style) in face.pages.iter().zip(&face.styles) {
                        let s=&page[sample];let weight=values.get(style as usize).copied().unwrap_or(256./264.).max(0.);
                        let scale=2f32.powi((s.exponent as i32).clamp(-32,16))/255.*weight;
                        linear[0]+=s.red as f32*scale;linear[1]+=s.green as f32*scale;linear[2]+=s.blue as f32*scale;
                    }
                    let at=(((face.y-1+y)*atlas.width+face.x-1+x)*4) as usize;
                    for c in 0..3 { atlas.rgba[at+c]=encode(linear[c],atlas.hdr); }
                    atlas.rgba[at+3]=255;
                }
            }
        }
        self.previous=Some(*values);true
    }
}
/// Source's canonical light style patterns, averaged for presentation (the web renderer uses the same averages).
pub fn light_style_pattern(pattern: &str) -> f32 {
    let mut sum=0u32;let mut count=0u32;
    for c in pattern.bytes().map(|c|c.to_ascii_lowercase()).filter(|c|c.is_ascii_lowercase()){sum+=(c-b'a') as u32*22;count+=1;}
    if count==0 {256./264.} else {sum as f32/count as f32/264.}
}
pub const LIGHT_STYLE_PATTERNS: [&str;13] = ["m","mmnmmommommnonmmonqnmmo","abcdefghijklmnopqrstuvwxyzyxwvutsrqponmlkjihgfedcba","mmmmmaaaaammmmmaaaaaabcdefgabcdefg","mamamamamama","jklmnopqrstuvwxyzyxwvutsrqponmlkj","nmonqnmomnmomomno","mmmaaaabcdefgmmmmaaaammmaamm","mmmaaammmaaammmabcdefaaaammmmabcdefmmmaaaa","aaaaaaaazzzzzzzz","mmamammmmammamamaaamammma","abcdefghijklmnopqrrqponmlkjihgfedcba","mmnnmmnnnmmnn"];

#[cfg(test)]
mod style_tests {
    use super::*;
    #[test] fn pattern_values_match_source(){assert_eq!(light_style_pattern("a"),0.);assert_eq!(light_style_pattern("m"),1.);assert_eq!(light_style_pattern("z"),25./12.);assert_eq!(light_style_pattern("am"),0.5);}
    #[test] fn pages_add_in_linear_space_and_rewrite_borders(){
        let sample=LightSample{red:64,green:32,blue:16,exponent:0};
        let mut styles=StyleAtlas{faces:vec![StyleFace{x:1,y:1,w:1,h:1,styles:vec![0,32],pages:vec![vec![sample],vec![sample]]}],width:3,height:3,previous:None};
        let mut atlas=Atlas{width:3,height:3,rgba:vec![0;36],hdr:true,scale:HDR_SCALE};let mut values=[0.;64];values[0]=1.;values[32]=1.;assert!(styles.apply(&mut atlas,&values));assert!(!styles.apply(&mut atlas,&values));
        for pixel in atlas.rgba.chunks_exact(4){assert_eq!(pixel,&[encode(128./255.,true),encode(64./255.,true),encode(32./255.,true),255]);}
        values[32]=0.;assert!(styles.apply(&mut atlas,&values));assert_eq!(atlas.rgba[0],encode(64./255.,true));
    }
}
