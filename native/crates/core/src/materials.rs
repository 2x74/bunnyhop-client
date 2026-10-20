//! Material resolution (VMT) and texture payload extraction (VTF) from the map's VFS.
//!
//! `resolve` maps each render-mesh material name to a `MaterialDesc`. Materials whose
//! VMT or base texture is not available (typically stock CS:S content) come back as
//! `Kind::Missing`; the client renders those with a neutral fallback. Mounting more
//! sources into the `Vfs` (e.g. user-provided game VPKs) fills them in transparently.
//!
//! With remote sources mounted, a pass may stop at a file that is not loaded yet; the `Vfs`
//! then holds pending requests and the caller resolves again once they are supplied.

use crate::vfs::{normalize, Vfs};
use playsrc_vtf::{Dialect, ImageFormat, Limits, SubresourceIdentity};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Kind {
    Textured = 0,
    Missing = 1,
    Water = 2,
    /// `Refract` / `LightmappedReflective` (glass) with no `$basetexture`: drawn as tinted translucent glass (`color` =
    /// `$refracttint`).
    Glass = 3,
    /// A VMT with no `$basetexture` (Source then uses a white texture) or a render-target one (`_rt_Camera`):
    /// drawn as flat `color`.
    Flat = 4,
}

pub const FLAG_TRANSLUCENT: u32 = 1;
pub const FLAG_ALPHATEST: u32 = 2;
pub const FLAG_NOCULL: u32 = 4;
pub const FLAG_ADDITIVE: u32 = 8;
pub const FLAG_UNLIT: u32 = 16;
/// The VMT was found (even if its texture was not).
pub const FLAG_HAS_VMT: u32 = 32;
/// `texture2` is a `$basetexture2` blended by displacement vertex alpha (WorldVertexTransition).
pub const FLAG_BLEND: u32 = 64;

#[derive(Clone, Debug)]
pub struct MaterialDesc {
    pub kind: Kind,
    /// Index into `Materials::textures`, or -1.
    pub texture: i32,
    pub flags: u32,
    pub alpha: f32,
    pub alpha_ref: f32,
    /// `$color` tint, or `$fogcolor` for water. Linear-ish 0..1.
    pub color: [f32; 3],
    pub shader: String,
    /// `$basetexture2` (set together with `FLAG_BLEND`), or -1.
    pub texture2: i32,
    /// `$detail` texture (only for the default mod2x `$detailblendmode 0`), or -1.
    pub detail: i32,
    pub detail_scale: f32,
    pub detail_blend: f32,
    /// Water: `$fogstart` / `$fogend` (units), and whether this is the surface seen from above (`$abovewater`,
    /// default 1; the downward-facing "beneath" faces use a material with `$abovewater 0`).
    pub fog_start: f32,
    pub fog_end: f32,
    pub above_water: bool,
}

#[derive(Default)]
pub struct Materials {
    pub descs: Vec<MaterialDesc>,
    /// Normalised VTF paths (`materials/...vtf`).
    pub textures: Vec<String>,
    /// Textures that are CS:GO compressed-HDR skies (`$hdrcompressedtexture`, BGRA8888 "RGBS": colour x alpha x 16),
    /// by path, with the material's `$color` to apply when decoding them to LDR (`texture_payload_rgbs`).
    pub rgbs: HashMap<String, [f32; 3]>,
}

// ---------------------------------------------------------------------------
// Lenient KeyValues parsing (VMTs in the wild are frequently sloppy).

#[derive(Clone, Debug)]
enum Kv {
    Str(String),
    Obj(Vec<(String, Kv)>),
}

enum Tok {
    Str(String),
    Open,
    Close,
}

fn tokenize(src: &[u8]) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < src.len() {
        let c = src[i];
        match c {
            b'{' => {
                out.push(Tok::Open);
                i += 1;
            }
            b'}' => {
                out.push(Tok::Close);
                i += 1;
            }
            b'/' if src.get(i + 1) == Some(&b'/') => {
                while i < src.len() && src[i] != b'\n' {
                    i += 1;
                }
            }
            b'"' => {
                let start = i + 1;
                i = start;
                while i < src.len() && src[i] != b'"' && src[i] != b'\n' {
                    i += 1;
                }
                out.push(Tok::Str(String::from_utf8_lossy(&src[start..i]).into_owned()));
                i += 1;
            }
            c if c.is_ascii_whitespace() || c == 0 => i += 1,
            _ => {
                let start = i;
                while i < src.len() && !src[i].is_ascii_whitespace() && !matches!(src[i], b'"' | b'{' | b'}') {
                    i += 1;
                }
                let word = String::from_utf8_lossy(&src[start..i]).into_owned();
                // Platform conditionals like [$WIN32] are ignored (treated as always true).
                if !(word.starts_with('[') && word.ends_with(']')) {
                    out.push(Tok::Str(word));
                }
            }
        }
    }
    out
}

fn parse_obj(toks: &[Tok], i: &mut usize) -> Vec<(String, Kv)> {
    let mut out = Vec::new();
    while *i < toks.len() {
        match &toks[*i] {
            Tok::Close => {
                *i += 1;
                break;
            }
            Tok::Open => {
                // Anonymous block; parse and discard.
                *i += 1;
                parse_obj(toks, i);
            }
            Tok::Str(key) => {
                let key = key.clone();
                *i += 1;
                match toks.get(*i) {
                    Some(Tok::Open) => {
                        *i += 1;
                        out.push((key, Kv::Obj(parse_obj(toks, i))));
                    }
                    Some(Tok::Str(v)) => {
                        out.push((key, Kv::Str(v.clone())));
                        *i += 1;
                    }
                    _ => {}
                }
            }
        }
    }
    out
}

/// Returns (shader name, body) of the first root block.
fn parse_vmt(src: &[u8]) -> Option<(String, Vec<(String, Kv)>)> {
    let src = src.strip_prefix(b"\xef\xbb\xbf").unwrap_or(src);
    let toks = tokenize(src);
    let mut i = 0;
    let Some(Tok::Str(shader)) = toks.first() else { return None };
    i += 1;
    if !matches!(toks.get(i), Some(Tok::Open)) {
        return None;
    }
    i += 1;
    Some((shader.to_ascii_lowercase(), parse_obj(&toks, &mut i)))
}

struct Vmt {
    shader: String,
    params: HashMap<String, String>,
}

fn flatten(body: &[(String, Kv)], params: &mut HashMap<String, String>) {
    for (k, v) in body {
        if let Kv::Str(s) = v {
            params.insert(k.to_ascii_lowercase(), s.clone());
        }
    }
    // Shader fallback blocks (e.g. "LightmappedGeneric_DX9") only fill in missing keys.
    for (k, v) in body {
        let k = k.to_ascii_lowercase();
        if let Kv::Obj(children) = v {
            if k == "proxies" || k.starts_with('$') || k.starts_with('%') {
                continue;
            }
            for (ck, cv) in children {
                if let Kv::Str(s) = cv {
                    params.entry(ck.to_ascii_lowercase()).or_insert_with(|| s.clone());
                }
            }
        }
    }
}

fn load_vmt(vfs: &Vfs, path: &str, depth: u32) -> Option<Vmt> {
    if depth > 8 {
        return None;
    }
    let (shader, body) = parse_vmt(vfs.read(path)?)?;
    if shader != "patch" {
        let mut params = HashMap::new();
        flatten(&body, &mut params);
        return Some(Vmt { shader, params });
    }
    let include = body.iter().find_map(|(k, v)| match v {
        Kv::Str(s) if k.eq_ignore_ascii_case("include") => Some(s.clone()),
        _ => None,
    });
    // The included base is often stock content; a patch may still supply $basetexture itself.
    let mut base = include
        .and_then(|inc| load_vmt(vfs, &inc, depth + 1))
        .unwrap_or(Vmt { shader: String::new(), params: HashMap::new() });
    for (k, v) in &body {
        if let Kv::Obj(children) = v {
            if k.eq_ignore_ascii_case("replace") || k.eq_ignore_ascii_case("insert") {
                for (ck, cv) in children {
                    if let Kv::Str(s) = cv {
                        base.params.insert(ck.to_ascii_lowercase(), s.clone());
                    }
                }
            }
        }
    }
    Some(base)
}

fn truthy(params: &HashMap<String, String>, key: &str) -> bool {
    params.get(key).is_some_and(|v| v.trim().parse::<f32>().map(|f| f != 0.0).unwrap_or(false))
}

fn float(params: &HashMap<String, String>, key: &str) -> Option<f32> {
    params.get(key).and_then(|v| v.trim().parse::<f32>().ok())
}

/// Parses `[r g b]` (0..1) or `{r g b}` (0..255) colours.
fn color(params: &HashMap<String, String>, key: &str) -> Option<[f32; 3]> {
    let v = params.get(key)?.trim();
    let scale = if v.starts_with('{') { 1.0 / 255.0 } else { 1.0 };
    let nums: Vec<f32> = v
        .trim_matches(|c| c == '[' || c == ']' || c == '{' || c == '}')
        .split_whitespace()
        .filter_map(|n| n.parse().ok())
        .collect();
    match nums.as_slice() {
        [r, g, b, ..] => Some([r * scale, g * scale, b * scale]),
        [x] => Some([x * scale; 3]),
        _ => None,
    }
}

fn texture_path(name: &str) -> String {
    let n = normalize(name);
    let n = n.strip_suffix(".vtf").unwrap_or(&n);
    let n = n.strip_prefix("materials/").unwrap_or(n);
    format!("materials/{n}.vtf")
}

/// Shaders that fall back to a white base texture when `$basetexture` is absent (see `Kind::Flat`). `MonitorScreen`
/// (screens fed by a point_camera, `$basetexture _rt_Camera`) gets the same dark-screen fallback as `UnlitTwoTexture`.
const FLAT_SHADERS: [&str; 6] = ["unlitgeneric", "lightmappedgeneric", "vertexlitgeneric", "worldvertextransition", "unlittwotexture", "monitorscreen"];

/// Glass shaders: `Refract`, and `LightmappedReflective` (reflective / refractive windows and glass floors, same
/// `$refracttint`, usually no `$basetexture`). Drawn as tinted translucent glass (see `Kind::Glass`).
const GLASS_SHADERS: [&str; 2] = ["refract", "lightmappedreflective"];

pub fn resolve(vfs: &Vfs, names: &[String]) -> Materials {
    let mut out = Materials::default();
    let mut texture_ids: HashMap<String, i32> = HashMap::new();
    // Registers a texture if its VTF is available (a remote hit queues a fetch and yields -1 for now).
    let mut texture_id = |t: Option<String>, out: &mut Materials| -> i32 {
        let Some(t) = t.filter(|t| vfs.read(t).is_some()) else { return -1 };
        let next = out.textures.len() as i32;
        *texture_ids.entry(t.clone()).or_insert_with(|| {
            out.textures.push(t);
            next
        })
    };
    for name in names {
        let base = normalize(name);
        let vmt_path = format!("materials/{base}.vmt");
        let vmt = load_vmt(vfs, &vmt_path, 0);
        let vmt_pending = vmt.is_none() && vfs.is_pending(&vmt_path);
        let mut desc = MaterialDesc {
            kind: Kind::Missing,
            texture: -1,
            flags: 0,
            alpha: 1.0,
            alpha_ref: 0.5,
            color: [1.0; 3],
            shader: String::new(),
            texture2: -1,
            detail: -1,
            detail_scale: 4.0,
            detail_blend: 1.0,
            fog_start: 0.0,
            fog_end: 0.0,
            above_water: true,
        };
        let tex;
        let mut flat = false;
        if let Some(vmt) = &vmt {
            let p = &vmt.params;
            desc.shader = vmt.shader.clone();
            desc.flags |= FLAG_HAS_VMT;
            if truthy(p, "$translucent") {
                desc.flags |= FLAG_TRANSLUCENT;
            }
            if truthy(p, "$alphatest") {
                desc.flags |= FLAG_ALPHATEST;
            }
            if truthy(p, "$nocull") {
                desc.flags |= FLAG_NOCULL;
            }
            if truthy(p, "$additive") {
                desc.flags |= FLAG_ADDITIVE;
            }
            if vmt.shader == "unlitgeneric" {
                desc.flags |= FLAG_UNLIT;
            }
            if let Some(a) = float(p, "$alpha") {
                desc.alpha = a.clamp(0.0, 1.0);
                if a < 1.0 {
                    desc.flags |= FLAG_TRANSLUCENT;
                }
            }
            if let Some(r) = float(p, "$alphatestreference") {
                desc.alpha_ref = r.clamp(0.0, 1.0);
            }
            if let Some(c) = color(p, "$color") {
                desc.color = c;
            }
            if vmt.shader == "water" {
                desc.kind = Kind::Water;
                desc.color = color(p, "$fogcolor").unwrap_or([0.2, 0.3, 0.35]);
                desc.fog_start = float(p, "$fogstart").unwrap_or(0.0).max(0.0);
                desc.fog_end = float(p, "$fogend").unwrap_or(0.0).max(0.0);
                desc.above_water = float(p, "$abovewater").is_none_or(|v| v != 0.0);
            }
            if GLASS_SHADERS.contains(&vmt.shader.as_str()) {
                // Refraction tint (glass colour); with a $basetexture the texture is blended over the refraction.
                desc.color = color(p, "$refracttint").unwrap_or([1.0; 3]);
                desc.flags |= FLAG_TRANSLUCENT;
            }
            tex = p.get("$basetexture").map(|t| texture_path(t)).or_else(|| {
                // CS:GO skies often ship only HDR textures (no LDR `$basetexture`): decode the compressed one.
                let t = (vmt.shader == "sky").then(|| p.get("$hdrcompressedtexture")).flatten().map(|t| texture_path(t))?;
                out.rgbs.insert(t.clone(), desc.color);
                Some(t)
            });
            let base = p.get("$basetexture").map(|t| t.trim().to_ascii_lowercase());
            if FLAT_SHADERS.contains(&vmt.shader.as_str()) {
                match base.as_deref() {
                    None | Some("") => flat = true,
                    Some(b) if b.starts_with("_rt_") => {
                        flat = true;
                        desc.color = [0.08; 3]; // a dark screen (monitors, camera feeds)
                    }
                    _ => {}
                }
            }
            if vmt.shader == "worldvertextransition" {
                desc.texture2 = texture_id(p.get("$basetexture2").map(|t| texture_path(t)), &mut out);
                if desc.texture2 >= 0 {
                    desc.flags |= FLAG_BLEND;
                }
            }
            if float(p, "$detailblendmode").unwrap_or(0.0) == 0.0 && vmt.shader != "water" {
                desc.detail = texture_id(p.get("$detail").map(|t| texture_path(t)), &mut out);
                desc.detail_scale = float(p, "$detailscale").filter(|s| *s > 0.0).unwrap_or(4.0);
                desc.detail_blend = float(p, "$detailblendfactor").unwrap_or(1.0).clamp(0.0, 1.0);
            }
        } else if vmt_pending {
            // The VMT is still being fetched: don't guess at a same-named VTF yet.
            tex = None;
        } else {
            // No VMT: accept a bare VTF with the material's name.
            tex = Some(format!("materials/{base}.vtf"));
        }
        // Water whose base VMT is stock content (common with cubemap-patched materials).
        if desc.kind == Kind::Missing && desc.shader.is_empty() && base.contains("water") && !base.contains("waterfall") {
            desc.kind = Kind::Water;
            desc.color = [0.2, 0.3, 0.35];
        }
        let mut id = texture_id(tex.clone(), &mut out);
        // `$basetexture` names a VTF no source has (and none is on its way): use a VTF with the material's own name.
        // Today's CS:S VPKs ship VMTs pointing at textures they don't contain (cs_havana/plasterwall1_3 ->
        // cs_italy/plasterwall1_3, cs_havana/dirtfloor02 -> cs_militia/dirtfloor02) next to a same-named VTF, and maps
        // pack VTFs beside VMTs that name another folder (bhop_thc_gold's bhop_thc_new/rsw -> newtextures/rsw). In both
        // cases the same-named VTF is what the map was compiled with: its texdata size and reflectivity match the VTF.
        if id < 0 && vmt.is_some() && tex.as_deref().is_some_and(|t| !vfs.is_pending(t)) {
            id = texture_id(Some(format!("materials/{base}.vtf")), &mut out);
        }
        if id >= 0 {
            desc.texture = id;
            if desc.kind == Kind::Missing {
                desc.kind = Kind::Textured;
            }
        } else if desc.kind == Kind::Missing && GLASS_SHADERS.contains(&desc.shader.as_str()) && !vmt_pending {
            // Glass has no base texture by design ($normalmap/$dudvmap only): not missing content.
            desc.kind = Kind::Glass;
        } else if desc.kind == Kind::Missing && flat {
            desc.kind = Kind::Flat;
        }
        out.descs.push(desc);
    }
    out
}

// ---------------------------------------------------------------------------
// Texture payloads.

pub const TEX_RGBA8: u32 = 0;
pub const TEX_DXT1: u32 = 1;
pub const TEX_DXT1A: u32 = 2;
pub const TEX_DXT3: u32 = 3;
pub const TEX_DXT5: u32 = 4;

pub struct Level {
    pub width: u32,
    pub height: u32,
    pub offset: u32,
    pub len: u32,
}

pub struct Payload {
    pub format: u32,
    pub levels: Vec<Level>,
    pub bytes: Vec<u8>,
}

fn high(mip: u8, s: &playsrc_vtf::Subresource) -> bool {
    matches!(s.identity, SubresourceIdentity::HighResolution { mip: m, frame: 0, slice: 0, .. } if m == mip)
}

/// Extracts mip 0 (and the full mip chain for S3TC uploads) of a VTF.
/// With `allow_s3tc`, DXT data is passed through untouched; otherwise everything is decoded to RGBA8.
pub fn texture_payload(bytes: &[u8], allow_s3tc: bool, need_alpha: bool) -> Result<Payload, String> {
    let decoder = playsrc_vtf::Decoder::new(bytes, Dialect::Source2013Pc, Limits::default()).map_err(|e| e.to_string())?;
    let meta = decoder.metadata();
    let base = meta.subresources.iter().find(|s| high(0, s)).ok_or("vtf: no mip 0")?;
    let (w, h) = (base.width, base.height);
    let s3tc = match meta.high_format {
        ImageFormat::Dxt1 if need_alpha => Some(TEX_DXT1A),
        ImageFormat::Dxt1 => Some(TEX_DXT1),
        ImageFormat::Dxt1OneBitAlpha => Some(TEX_DXT1A),
        ImageFormat::Dxt3 => Some(TEX_DXT3),
        ImageFormat::Dxt5 => Some(TEX_DXT5),
        _ => None,
    };
    if let Some(format) = s3tc.filter(|_| allow_s3tc && w % 4 == 0 && h % 4 == 0) {
        let full_chain = 32 - w.max(h).leading_zeros();
        let mips = if meta.mip_count as u32 == full_chain { full_chain } else { 1 };
        let mut payload = Payload { format, levels: Vec::new(), bytes: Vec::new() };
        for mip in 0..mips {
            let Some(s) = meta.subresources.iter().find(|s| high(mip as u8, s)) else { break };
            let data = bytes.get(s.encoded_range.clone()).ok_or("vtf: truncated")?;
            payload.levels.push(Level {
                width: s.width,
                height: s.height,
                offset: payload.bytes.len() as u32,
                len: data.len() as u32,
            });
            payload.bytes.extend_from_slice(data);
        }
        if payload.levels.len() as u32 != mips {
            payload.levels.truncate(1);
        }
        return Ok(payload);
    }
    let rgba = match decoder.decode(base.identity) {
        Ok(plane) => match plane.scalar_encoding {
            playsrc_vtf::ScalarEncoding::U8 => match plane.channel_layout {
                playsrc_vtf::ChannelLayout::Rgba => plane.samples,
                playsrc_vtf::ChannelLayout::Rgb => plane.samples.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
            },
            playsrc_vtf::ScalarEncoding::F16 => plane
                .samples
                .chunks_exact(2)
                .map(|b| {
                    let v = half_to_f32(u16::from_le_bytes([b[0], b[1]]));
                    (v.clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0 + 0.5) as u8
                })
                .collect(),
        },
        Err(_) => {
            let data = bytes.get(base.encoded_range.clone()).ok_or("vtf: truncated")?;
            convert_rgba(meta.high_format, data, w, h).ok_or_else(|| format!("vtf: unsupported format {:?}", meta.high_format))?
        }
    };
    Ok(Payload {
        format: TEX_RGBA8,
        levels: vec![Level { width: w, height: h, offset: 0, len: rgba.len() as u32 }],
        bytes: rgba,
    })
}

/// A CS:GO compressed-HDR sky texture ("RGBS": BGRA8888 whose alpha scales the colour, linear value = rgb x a x 16,
/// see the SDK's sky_hdr_compressed shader) decoded to an LDR RGBA8 image: the HDR value times the material's `$color`
/// (CS:GO's sky VMTs use [.25 .25 .25]), clamped to 1. Mip 0 only; the client builds mips.
pub fn texture_payload_rgbs(bytes: &[u8], color: [f32; 3]) -> Result<Payload, String> {
    let mut p = texture_payload(bytes, false, true)?;
    for px in p.bytes.chunks_exact_mut(4) {
        let scale = px[3] as f32 / 255.0 * 16.0;
        for k in 0..3 {
            px[k] = (px[k] as f32 * scale * color[k]).round().clamp(0.0, 255.0) as u8;
        }
        px[3] = 255;
    }
    Ok(p)
}

fn half_to_f32(h: u16) -> f32 {
    let s = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let e = ((h >> 10) & 0x1f) as i32;
    let m = (h & 0x3ff) as f32;
    s * match e {
        0 => m * 2f32.powi(-24),
        31 => f32::INFINITY,
        _ => (1.0 + m / 1024.0) * 2f32.powi(e - 15),
    }
}

fn expand(v: u16, bits: u32) -> u8 {
    let max = (1u32 << bits) - 1;
    ((v as u32 * 255 + max / 2) / max) as u8
}

/// Formats the vendored decoder doesn't handle.
fn convert_rgba(format: ImageFormat, data: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    let n = (w * h) as usize;
    let px = |bpp: usize| data.get(..n * bpp).map(|d| d.chunks_exact(bpp));
    let out: Vec<u8> = match format {
        ImageFormat::Rgb888 | ImageFormat::Rgb888BlueScreen => px(3)?.flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        ImageFormat::Bgr888BlueScreen => px(3)?.flat_map(|p| [p[2], p[1], p[0], 255]).collect(),
        ImageFormat::Bgrx8888 => px(4)?.flat_map(|p| [p[2], p[1], p[0], 255]).collect(),
        ImageFormat::Abgr8888 => px(4)?.flat_map(|p| [p[3], p[2], p[1], p[0]]).collect(),
        ImageFormat::Argb8888 => px(4)?.flat_map(|p| [p[1], p[2], p[3], p[0]]).collect(),
        ImageFormat::I8 => px(1)?.flat_map(|p| [p[0], p[0], p[0], 255]).collect(),
        ImageFormat::Ia88 => px(2)?.flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        ImageFormat::A8 => px(1)?.flat_map(|p| [255, 255, 255, p[0]]).collect(),
        ImageFormat::Rgb565 | ImageFormat::Bgr565 => px(2)?
            .flat_map(|p| {
                let v = u16::from_le_bytes([p[0], p[1]]);
                let (hi, mid, lo) = (expand(v >> 11, 5), expand((v >> 5) & 63, 6), expand(v & 31, 5));
                if format == ImageFormat::Rgb565 { [lo, mid, hi, 255] } else { [hi, mid, lo, 255] }
            })
            .collect(),
        ImageFormat::Bgra4444 => px(2)?
            .flat_map(|p| {
                let v = u16::from_le_bytes([p[0], p[1]]);
                [expand((v >> 8) & 15, 4), expand((v >> 4) & 15, 4), expand(v & 15, 4), expand(v >> 12, 4)]
            })
            .collect(),
        ImageFormat::Bgrx5551 | ImageFormat::Bgra5551 => px(2)?
            .flat_map(|p| {
                let v = u16::from_le_bytes([p[0], p[1]]);
                let a = if format == ImageFormat::Bgrx5551 || v & 0x8000 != 0 { 255 } else { 0 };
                [expand((v >> 10) & 31, 5), expand((v >> 5) & 31, 5), expand(v & 31, 5), a]
            })
            .collect(),
        ImageFormat::Dxt3 => decode_dxt3(data, w, h)?,
        _ => return None,
    };
    Some(out)
}

fn rgb565(v: u16) -> [i32; 3] {
    [expand(v >> 11, 5) as i32, expand((v >> 5) & 63, 6) as i32, expand(v & 31, 5) as i32]
}

fn decode_dxt3(data: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    let (bw, bh) = (w.div_ceil(4) as usize, h.div_ceil(4) as usize);
    let mut out = vec![0u8; (w * h * 4) as usize];
    for by in 0..bh {
        for bx in 0..bw {
            let b = data.get((by * bw + bx) * 16..(by * bw + bx) * 16 + 16)?;
            let c0 = rgb565(u16::from_le_bytes([b[8], b[9]]));
            let c1 = rgb565(u16::from_le_bytes([b[10], b[11]]));
            let palette = [c0, c1, [0, 1, 2].map(|i| (2 * c0[i] + c1[i]) / 3), [0, 1, 2].map(|i| (c0[i] + 2 * c1[i]) / 3)];
            let bits = u32::from_le_bytes([b[12], b[13], b[14], b[15]]);
            for p in 0..16usize {
                let (x, y) = (bx * 4 + p % 4, by * 4 + p / 4);
                if x >= w as usize || y >= h as usize {
                    continue;
                }
                let c = palette[((bits >> (p * 2)) & 3) as usize];
                let a = (b[p / 2] >> ((p % 2) * 4)) & 15;
                let o = (y * w as usize + x) * 4;
                out[o..o + 4].copy_from_slice(&[c[0] as u8, c[1] as u8, c[2] as u8, a * 17]);
            }
        }
    }
    Some(out)
}

/// A VMT parameter (lowercase key, e.g. `$surfaceprop`) of material `name` (texdata name),
/// following `patch` includes. `None` when the VMT is not in the VFS (usually stock content).
pub fn material_param(vfs: &Vfs, name: &str, key: &str) -> Option<String> {
    let vmt = load_vmt(vfs, &format!("materials/{}.vmt", normalize(name)), 0)?;
    vmt.params.get(key).cloned()
}

/// Shader name and all parameters (lowercase keys) of material `name`, following `patch` includes.
/// `None` when the VMT is not in the VFS (a mount hit is requested).
pub fn vmt_params(vfs: &Vfs, name: &str) -> Option<(String, HashMap<String, String>)> {
    let vmt = load_vmt(vfs, &format!("materials/{}.vmt", normalize(name)), 0)?;
    Some((vmt.shader, vmt.params))
}

/// `materials/<name>.vtf` for a VMT texture parameter value.
pub fn vtf_path(name: &str) -> String {
    texture_path(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::{Listing, Source};
    use std::rc::Rc;

    fn loose(files: &[(&str, &str)]) -> Source {
        Source::loose("loose", files.iter().map(|(p, b)| (p.to_string(), Rc::from(b.as_bytes()))).collect())
    }

    /// A 4x4 single-mip VTF 7.2 with every pixel `bgra` (BGRA8888).
    fn bgra_vtf(bgra: [u8; 4]) -> Vec<u8> {
        let mut b = vec![0u8; 80];
        b[..4].copy_from_slice(b"VTF\0");
        b[4..8].copy_from_slice(&7u32.to_le_bytes());
        b[8..12].copy_from_slice(&2u32.to_le_bytes());
        b[12..16].copy_from_slice(&80u32.to_le_bytes());
        b[16..18].copy_from_slice(&4u16.to_le_bytes());
        b[18..20].copy_from_slice(&4u16.to_le_bytes());
        b[24..26].copy_from_slice(&1u16.to_le_bytes());
        b[48..52].copy_from_slice(&1f32.to_le_bytes());
        b[52..56].copy_from_slice(&12i32.to_le_bytes());
        b[56] = 1;
        b[57..61].copy_from_slice(&(-1i32).to_le_bytes());
        b[63..65].copy_from_slice(&1u16.to_le_bytes());
        for _ in 0..16 {
            b.extend_from_slice(&bgra);
        }
        b
    }

    #[test]
    fn csgo_hdr_only_skies_decode_their_compressed_texture() {
        let mut vfs = Vfs::default();
        vfs.mount(loose(&[
            ("materials/skybox/hdrbk.vmt", r#""sky" { "$hdrcompressedTexture" "skybox/hdrbk" "$color" "[.25 .25 .25]" }"#),
            ("materials/skybox/hdrbk.vtf", "vtf"),
            ("materials/skybox/ldrbk.vmt", r#""sky" { "$basetexture" "skybox/ldrbk" "$hdrcompressedtexture" "skybox/ldrbk_hdr" }"#),
            ("materials/skybox/ldrbk.vtf", "vtf"),
            ("materials/skybox/ldrbk_hdr.vtf", "vtf"),
        ]));
        let m = resolve(&vfs, &["skybox/hdrbk".into(), "skybox/ldrbk".into()]);
        assert_eq!(m.descs[0].kind, Kind::Textured);
        assert_eq!(m.textures[m.descs[0].texture as usize], "materials/skybox/hdrbk.vtf");
        assert_eq!(m.rgbs.get("materials/skybox/hdrbk.vtf"), Some(&[0.25; 3]));
        // An LDR $basetexture still wins (every CS:S sky), and isn't treated as compressed HDR.
        assert_eq!(m.textures[m.descs[1].texture as usize], "materials/skybox/ldrbk.vtf");
        assert_eq!(m.rgbs.len(), 1);
        // RGBS: colour x alpha / 255 x 16 x $color. Alpha 32 = x2.008, then x0.25.
        let p = texture_payload_rgbs(&bgra_vtf([64, 128, 255, 32]), [0.25; 3]).unwrap();
        assert_eq!(p.format, TEX_RGBA8);
        assert_eq!(&p.bytes[..4], &[128, 64, 32, 255]);
    }

    #[test]
    fn basetexture_falls_back_to_same_named_vtf() {
        let mut vfs = Vfs::default();
        vfs.mount(loose(&[
            ("materials/cs_havana/plasterwall1_3.vmt", r#""LightmappedGeneric" { "$baseTexture" "cs_italy/plasterwall1_3" }"#),
            ("materials/cs_havana/plasterwall1_3.vtf", "vtf"),
            ("materials/ok/wall.vmt", r#""LightmappedGeneric" { "$basetexture" "ok/real" }"#),
            ("materials/ok/real.vtf", "vtf"),
            ("materials/ok/wall.vtf", "decoy"),
            ("materials/gone/wall.vmt", r#""LightmappedGeneric" { "$basetexture" "gone/nothing" }"#),
        ]));
        let m = resolve(&vfs, &["cs_havana/plasterwall1_3".into(), "ok/wall".into(), "gone/wall".into()]);
        assert_eq!(m.descs[0].kind, Kind::Textured);
        assert_eq!(m.textures[m.descs[0].texture as usize], "materials/cs_havana/plasterwall1_3.vtf");
        // A $basetexture that exists always wins.
        assert_eq!(m.textures[m.descs[1].texture as usize], "materials/ok/real.vtf");
        assert_eq!(m.descs[2].kind, Kind::Missing);
    }

    #[test]
    fn no_fallback_while_basetexture_is_pending() {
        let mut vfs = Vfs::default();
        vfs.mount(loose(&[
            ("materials/a/wall.vmt", r#""LightmappedGeneric" { "$basetexture" "b/wall" }"#),
            ("materials/a/wall.vtf", "decoy"),
        ]));
        vfs.mount(Source::listing(Rc::new(Listing::new("remote", ["materials/b/wall.vtf".to_string()]))));
        let m = resolve(&vfs, &["a/wall".into()]);
        assert_eq!(m.descs[0].kind, Kind::Missing);
        assert!(vfs.is_pending("materials/b/wall.vtf"));
    }

    fn vfs(files: &[(&str, &str)]) -> Vfs {
        let mut v = Vfs::default();
        v.mount(Source::loose("t", files.iter().map(|(p, b)| (p.to_string(), Rc::from(b.as_bytes()))).collect()));
        v
    }

    #[test]
    fn refract_glass_flat_and_water_kinds() {
        let v = vfs(&[
            ("materials/glass/clear.vmt", r#""Refract" { "$normalmap" "glass/n" "$refracttint" "[0.5 0.8 1]" }"#),
            ("materials/pulse/green.vmt", r#"UnlitGeneric { $color "[0 1 0]" }"#),
            ("materials/dev/monitor.vmt", r#""UnlitTwoTexture" { "$basetexture" "_rt_Camera" }"#),
            ("materials/wall/missing.vmt", r#""LightmappedGeneric" { "$basetexture" "wall/nothere" }"#),
            ("materials/water/top.vmt", r#""Water" { "$fogcolor" "{41 36 17}" "$fogstart" 1 "$fogend" "800" "$abovewater" 1 }"#),
            ("materials/water/below.vmt", r#""Water" { "$fogcolor" "{41 36 17}" "$fogend" 400 "$abovewater" "0" }"#),
            ("materials/glass/reflective.vmt", r#""LightmappedReflective" { "$normalmap" "glass/n" "$refracttint" "[0.2 0.4 0.6]" "$reflecttint" "[1 1 1]" }"#),
            ("materials/dev/camscreen.vmt", r#""MonitorScreen" { "$basetexture" "_rt_Camera" "$contrast" 1 }"#),
        ]);
        let names: Vec<String> =
            ["glass/clear", "pulse/green", "dev/monitor", "wall/missing", "water/top", "water/below", "glass/reflective", "dev/camscreen"]
                .map(String::from)
                .to_vec();
        let d = resolve(&v, &names).descs;
        assert_eq!(d[0].kind, Kind::Glass);
        assert_eq!(d[0].color, [0.5, 0.8, 1.0]);
        assert_eq!(d[1].kind, Kind::Flat);
        assert_eq!(d[1].color, [0.0, 1.0, 0.0]);
        assert_eq!(d[2].kind, Kind::Flat);
        // A named base texture that doesn't exist stays missing (Source shows its error texture).
        assert_eq!(d[3].kind, Kind::Missing);
        assert_eq!(d[4].kind, Kind::Water);
        assert!(d[4].above_water && d[4].fog_start == 1.0 && d[4].fog_end == 800.0);
        assert!(!d[5].above_water && d[5].fog_end == 400.0);
        // LightmappedReflective is glass like Refract: tinted, translucent, not missing content.
        assert_eq!(d[6].kind, Kind::Glass);
        assert_eq!(d[6].color, [0.2, 0.4, 0.6]);
        assert!(d[6].flags & FLAG_TRANSLUCENT != 0);
        // MonitorScreen on a camera render target: a dark flat screen, not the error texture.
        assert_eq!(d[7].kind, Kind::Flat);
        assert_eq!(d[7].color, [0.08; 3]);
    }
}
