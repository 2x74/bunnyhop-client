//! Material work the core leaves to the renderer, read from the VMT with a port of the website's lenient reader
//! (apps/web/src/vmt.ts):
//! - the proxies it animates: TextureScroll on `$basetexturetransform` and AnimatedTexture on `$basetexture`
//!   (apps/web/src/texture-scroll.ts), with the flipbooks' frames decoded under the website's caps;
//! - Wireframe materials, which the core resolves as missing (apps/web/src/imposter.ts draws their triangle edges).
//! Render only.
use super::*;
use bunnyhop_core::materials::Kind;

/// Per material, parallel to `bh_materials`. A rate of 0 means no scroll / no flipbook.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BhMaterialMotion {
    /// Texture widths per second, along `scroll_angle` degrees (0 = +s, 90 = +t).
    pub scroll_rate: f64,
    pub scroll_angle: f64,
    /// Flipbook frames per second (`animatedTextureFrameRate`).
    pub frame_rate: f64,
    /// Frames the flipbook shows (frame 0 is the material's own texture); 0 without a flipbook.
    pub frames: u32,
    /// `animationNoWrap`: stays on the last frame.
    pub no_wrap: u32,
}

/// A Wireframe material (SDK 2013 wireframe_dx9): its triangle edges in `$color`, unlit, at `$alpha`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BhMaterialWireframe {
    pub material: u32,
    pub color: [f32; 3],
    pub alpha: f32,
}

/// The website's flipbook caps: most frames per texture, and decoded pixels per map.
const MAX_FRAMES: u16 = 256;
const MAX_FRAME_PIXELS: u64 = 48 * 1024 * 1024;
/// Patch includes followed, as vmt.ts `loadVmt`.
const MAX_INCLUDE_DEPTH: u32 = 4;

#[derive(Default)]
pub(super) struct Motion {
    ready: bool,
    materials: Vec<BhMaterialMotion>,
    /// Decoded flipbook frames 1.. by texture index (frame 0 is the texture itself).
    frames: HashMap<(i32, u32), map_load::PreparedTexture>,
    wireframes: Vec<BhMaterialWireframe>,
}

/// Flipbooks decoded so far: frames per texture, and the pixels they count against the map's budget.
#[derive(Default)]
struct Flipbooks {
    frames: HashMap<i32, u32>,
    pixels: u64,
}

#[derive(Clone, Debug, PartialEq)]
enum Kv {
    Str(String),
    Obj(Vec<(String, Kv)>),
}

#[derive(Clone, Debug, PartialEq)]
enum Token {
    Open,
    Close,
    Text(String),
}

/// JavaScript's `\s` over Latin-1, so tokens split exactly where vmt.ts splits them.
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}')
}

fn tokenize(src: &[char]) -> Vec<Token> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < src.len() {
        let c = src[i];
        if c == '/' && src.get(i + 1) == Some(&'/') {
            while i < src.len() && src[i] != '\n' {
                i += 1;
            }
        } else if c == '{' || c == '}' {
            out.push(if c == '{' { Token::Open } else { Token::Close });
            i += 1;
        } else if c == '"' {
            let stop = src[i + 1..]
                .iter()
                .position(|&x| x == '"')
                .map_or(src.len(), |p| i + 1 + p);
            out.push(Token::Text(src[i + 1..stop].iter().collect()));
            i = stop + 1;
        } else if js_space(c) {
            i += 1;
        } else {
            let mut j = i;
            while j < src.len() && !js_space(src[j]) && !matches!(src[j], '{' | '}' | '"') {
                j += 1;
            }
            out.push(Token::Text(src[i..j].iter().collect()));
            i = j;
        }
    }
    out
}

/// A brace block's pairs; a key at the end, a key with no value and unnamed blocks are dropped (vmt.ts parseBody).
fn parse_body(tokens: &[Token], at: &mut usize) -> Vec<(String, Kv)> {
    let mut out = Vec::new();
    while *at < tokens.len() {
        let token = &tokens[*at];
        *at += 1;
        let key = match token {
            Token::Close => break,
            Token::Open => {
                parse_body(tokens, at);
                continue;
            }
            Token::Text(key) => key.to_lowercase(),
        };
        match tokens.get(*at) {
            None => break,
            Some(Token::Open) => {
                *at += 1;
                out.push((key, Kv::Obj(parse_body(tokens, at))));
            }
            Some(Token::Close) => {}
            Some(Token::Text(value)) => {
                *at += 1;
                out.push((key, Kv::Str(value.clone())));
            }
        }
    }
    out
}

/// The shader name and its block, or None if the text isn't a VMT.
fn parse_key_values(bytes: &[u8]) -> Option<(String, Vec<(String, Kv)>)> {
    // vmt.ts decodes as Latin-1: one char per byte.
    let chars: Vec<char> = bytes.iter().map(|&b| char::from(b)).collect();
    let tokens = tokenize(&chars);
    let (Some(Token::Text(shader)), Some(Token::Open)) = (tokens.first(), tokens.get(1)) else {
        return None;
    };
    let mut at = 2;
    Some((shader.to_lowercase(), parse_body(&tokens, &mut at)))
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Proxy {
    pub name: String,
    pub params: HashMap<String, String>,
}

/// A VMT as vmt.ts reads it: its top-level parameters (lower case keys, the last value wins) and its proxies.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Vmt {
    pub params: HashMap<String, String>,
    pub proxies: Vec<Proxy>,
}

fn string_pairs(pairs: &[(String, Kv)]) -> HashMap<String, String> {
    pairs
        .iter()
        .filter_map(|(k, v)| match v {
            Kv::Str(s) => Some((k.clone(), s.clone())),
            Kv::Obj(_) => None,
        })
        .collect()
}

fn flatten(body: &[(String, Kv)], vmt: &mut Vmt) {
    for (key, value) in body {
        match value {
            Kv::Str(s) => {
                vmt.params.insert(key.clone(), s.clone());
            }
            Kv::Obj(proxies) if key == "proxies" => {
                for (name, proxy) in proxies {
                    let Kv::Obj(pairs) = proxy else { continue };
                    vmt.proxies.push(Proxy {
                        name: name.clone(),
                        params: string_pairs(pairs),
                    });
                }
            }
            Kv::Obj(_) => {}
        }
    }
}

/// `materials/<name>.vmt` for a material name or include value (vmt.ts vmtPath).
fn vmt_path(name: &str) -> String {
    let lower = name.to_lowercase().replace('\\', "/");
    let trimmed = lower.trim_start_matches('/');
    let bare = trimmed.strip_prefix("materials/").unwrap_or(trimmed);
    if bare.ends_with(".vmt") {
        format!("materials/{bare}")
    } else {
        format!("materials/{bare}.vmt")
    }
}

/// A VMT, following `patch` includes (vmt.ts loadVmt). None when it or an include is missing.
pub(super) fn load_vmt(read: &mut dyn FnMut(&str) -> Option<Vec<u8>>, path: &str, depth: u32) -> Option<Vmt> {
    if depth > MAX_INCLUDE_DEPTH {
        return None;
    }
    let (shader, body) = parse_key_values(&read(path)?)?;
    if shader != "patch" {
        let mut vmt = Vmt::default();
        flatten(&body, &mut vmt);
        return Some(vmt);
    }
    let include = body.iter().find_map(|(k, v)| match v {
        Kv::Str(s) if k == "include" => Some(s.clone()),
        _ => None,
    })?;
    let mut vmt = load_vmt(read, &vmt_path(&include), depth + 1)?;
    for (key, value) in &body {
        if let Kv::Obj(block) = value {
            if key == "replace" || key == "insert" {
                flatten(block, &mut vmt);
            }
        }
    }
    Some(vmt)
}

/// JavaScript's `parseFloat`: the longest decimal prefix after leading whitespace, None when there is none.
pub(super) fn js_parse_float(text: &str) -> Option<f64> {
    let s = text.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let bytes = s.as_bytes();
    let mut end = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        end = 1;
    }
    if s[end..].starts_with("Infinity") {
        return Some(if s.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        });
    }
    let digits = |from: usize| bytes[from..].iter().take_while(|b| b.is_ascii_digit()).count();
    let whole = digits(end);
    end += whole;
    let mut fraction = 0;
    if bytes.get(end) == Some(&b'.') {
        fraction = digits(end + 1);
        if whole + fraction > 0 {
            end += 1 + fraction;
        }
    }
    if whole + fraction == 0 {
        return None;
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(bytes.get(end + 1), Some(b'+' | b'-')));
        let exponent = digits(end + 1 + sign);
        if exponent > 0 {
            end += 1 + sign + exponent;
        }
    }
    s[..end].parse().ok()
}

/// texture-scroll.ts `num`: a finite number, else the fallback.
fn number(params: &HashMap<String, String>, key: &str, fallback: f64) -> f64 {
    params
        .get(key)
        .and_then(|v| js_parse_float(v.trim()))
        .filter(|n| n.is_finite())
        .unwrap_or(fallback)
}

/// JavaScript's `Number` on one whitespace-free token: the whole token, an empty one is 0, `0x` / `0o` / `0b` prefixes.
fn js_number(token: &str) -> Option<f64> {
    if token.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = token.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).ok().map(|n| n as f64);
        }
    }
    // Rust also reads "inf" and "nan", which JavaScript doesn't; neither is finite, so both are refused alike.
    token.parse::<f64>().ok()
}

/// A material variable reference in a proxy input: `$name` or `$name[i]` (texture-scroll.ts proxyFloat's pattern).
fn variable_reference(raw: &str) -> Option<(String, usize)> {
    let text = raw.trim();
    if !text.starts_with('$') {
        return None;
    }
    let name_end = text
        .find(|c: char| c.is_whitespace() || c == '[' || c == ']')
        .unwrap_or(text.len());
    let (name, rest) = text.split_at(name_end);
    if name.len() < 2 {
        return None;
    }
    let rest = rest.trim_start();
    if rest.is_empty() {
        return Some((name.to_lowercase(), 0));
    }
    let index = rest.strip_prefix('[')?.strip_suffix(']')?.trim();
    if index.is_empty() || !index.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((name.to_lowercase(), index.parse().ok()?))
}

/// Source's CFloatInput::Init, as texture-scroll.ts `proxyFloat`: absent is the default; a number is that number;
/// otherwise a material variable. A variable the VMT sets and no proxy writes is a constant; one another proxy writes
/// (`resultVar`) changes over time and one the VMT doesn't set fails the proxy: None, the texture stays still.
fn proxy_float(vmt: &Vmt, raw: Option<&String>, fallback: f64) -> Option<f64> {
    let Some(raw) = raw else { return Some(fallback) };
    if let Some(n) = js_parse_float(raw.trim()).filter(|n| n.is_finite()) {
        return Some(n);
    }
    let (name, index) = variable_reference(raw)?;
    let written = |p: &Proxy| {
        let result = p
            .params
            .get("resultvar")
            .map(|v| v.trim().to_lowercase())
            .unwrap_or_default();
        result.split('[').next().unwrap_or("").trim() == name
    };
    if vmt.proxies.iter().any(written) {
        return None;
    }
    let value = vmt.params.get(&name)?.replace(['[', ']', '{', '}'], " ");
    let trimmed = value.trim();
    let parts: Vec<&str> = if trimmed.is_empty() {
        vec![""]
    } else {
        trimmed
            .split(|c: char| c.is_whitespace())
            .filter(|t| !t.is_empty())
            .collect()
    };
    js_number(parts.get(index)?).filter(|v| v.is_finite())
}

fn targets(proxy: &Proxy, key: &str, variable: &str) -> bool {
    proxy
        .params
        .get(key)
        .is_some_and(|v| v.trim().to_lowercase() == variable)
}

/// The base-texture scroll (rate, angle), as texture-scroll.ts `textureScrollOf`. Source's defaults: rate 1, angle 0.
/// An input another proxy drives (or a variable the VMT doesn't set) leaves the texture still rather than guessing.
pub(super) fn texture_scroll(vmt: &Vmt) -> Option<(f64, f64)> {
    let proxy = vmt
        .proxies
        .iter()
        .find(|p| p.name == "texturescroll" && targets(p, "texturescrollvar", "$basetexturetransform"))?;
    let rate = proxy_float(vmt, proxy.params.get("texturescrollrate"), 1.0)?;
    let angle = proxy_float(vmt, proxy.params.get("texturescrollangle"), 0.0)?;
    (rate != 0.0).then_some((rate, angle))
}

/// The base-texture flipbook (frame rate, no wrap), as texture-scroll.ts `textureAnimationOf`. Default rate 15.
pub(super) fn texture_animation(vmt: &Vmt) -> Option<(f64, bool)> {
    let proxy = vmt
        .proxies
        .iter()
        .find(|p| p.name == "animatedtexture" && targets(p, "animatedtexturevar", "$basetexture"))?;
    let rate = number(&proxy.params, "animatedtextureframerate", 15.0);
    (rate > 0.0).then(|| (rate, number(&proxy.params, "animationnowrap", 0.0) != 0.0))
}

/// vmt.ts vmtColor: `[r g b]` (0..1) or `{r g b}` (0..255); a single number is grey.
fn vmt_color(vmt: &Vmt, key: &str) -> Option<[f32; 3]> {
    let value = vmt.params.get(key)?.trim();
    if value.is_empty() {
        return None;
    }
    let scale = if value.starts_with('{') { 1.0 / 255.0 } else { 1.0 };
    let numbers: Vec<f64> = value
        .replace(['[', ']', '{', '}'], " ")
        .split_whitespace()
        .filter_map(js_number)
        .filter(|n| n.is_finite())
        .collect();
    match numbers.as_slice() {
        [r, g, b, ..] => Some([(r * scale) as f32, (g * scale) as f32, (b * scale) as f32]),
        [grey] => Some([(grey * scale) as f32; 3]),
        _ => None,
    }
}

/// imposter.ts wireframeParams: `$color` (white by default) and `$alpha` clamped to 0..1.
fn wireframe(material: u32, vmt: &Vmt) -> BhMaterialWireframe {
    let alpha = vmt
        .params
        .get("$alpha")
        .and_then(|v| js_parse_float(v.trim()))
        .filter(|n| n.is_finite())
        .unwrap_or(1.0);
    BhMaterialWireframe {
        material,
        color: vmt_color(vmt, "$color").unwrap_or([1.0; 3]),
        alpha: alpha.clamp(0.0, 1.0) as f32,
    }
}

/// Decodes frames 1.. of a flipbook into `frames`, counting every frame's pixels against the map's budget as
/// texture-scroll.ts does (a book that doesn't fit keeps what it counted and shows its first frame). Frame count, or 0.
fn decode_flipbook(
    bytes: &[u8],
    texture: i32,
    pixels: &mut u64,
    frames: &mut HashMap<(i32, u32), map_load::PreparedTexture>,
) -> u32 {
    let count = materials::texture_frame_count(bytes).min(MAX_FRAMES);
    if count <= 1 {
        return 0;
    }
    let mut decoded = Vec::with_capacity(usize::from(count));
    for frame in 0..count {
        let image = materials::texture_payload_frame(bytes, frame, false, true)
            .ok()
            .and_then(|payload| {
                let level = payload.levels.first()?;
                let range = level.offset as usize..level.offset as usize + level.len as usize;
                let rgba = payload.bytes.get(range)?.to_vec();
                Some(map_load::PreparedTexture {
                    rgba,
                    width: level.width,
                    height: level.height,
                })
            });
        let Some(image) = image else { return 0 };
        let size = u64::from(image.width) * u64::from(image.height);
        if *pixels + size > MAX_FRAME_PIXELS {
            return 0;
        }
        *pixels += size;
        decoded.push(image);
    }
    for (frame, image) in decoded.into_iter().enumerate().skip(1) {
        frames.insert((texture, frame as u32), image);
    }
    u32::from(count)
}

impl Map {
    /// Reads every material's proxies and decodes the flipbooks once (on the load worker, or at the first request).
    pub(super) fn prepare_motion(&mut self, check: &dyn Fn() -> Result<(), String>) -> Result<(), String> {
        if self.motion.ready {
            return Ok(());
        }
        let names: Vec<String> =
            serde_json::from_slice(self.assets.material_names.to_bytes()).map_err(|e| e.to_string())?;
        let mut motion = Motion {
            ready: true,
            ..Motion::default()
        };
        motion
            .materials
            .resize(self.materials.descs.len(), BhMaterialMotion::default());
        let mut books = Flipbooks::default();
        for (index, name) in names.iter().enumerate() {
            check()?;
            let Some(desc) = self.materials.descs.get(index) else {
                break;
            };
            let (kind, texture, wire) = (desc.kind, desc.texture, desc.shader == "wireframe");
            if kind == Kind::Missing && wire {
                if let Some(vmt) = load_vmt(&mut |path| self.content(path).ok(), &vmt_path(name), 0) {
                    motion.wireframes.push(wireframe(index as u32, &vmt));
                }
                continue;
            }
            if kind != Kind::Textured || texture < 0 {
                continue;
            }
            let vmt = load_vmt(&mut |path| self.content(path).ok(), &vmt_path(name), 0).unwrap_or_default();
            let entry = &mut motion.materials[index];
            if let Some((rate, angle)) = texture_scroll(&vmt) {
                (entry.scroll_rate, entry.scroll_angle) = (rate, angle);
            }
            let Some((rate, no_wrap)) = texture_animation(&vmt) else {
                continue;
            };
            let frames = self.flipbook(texture, &mut books, &mut motion.frames);
            if frames > 1 {
                let entry = &mut motion.materials[index];
                (entry.frame_rate, entry.frames, entry.no_wrap) = (rate, frames, u32::from(no_wrap));
            }
        }
        self.motion = motion;
        Ok(())
    }

    /// Texture `texture`'s flipbook frame count, decoding it the first time a material asks.
    fn flipbook(
        &mut self,
        texture: i32,
        books: &mut Flipbooks,
        frames: &mut HashMap<(i32, u32), map_load::PreparedTexture>,
    ) -> u32 {
        if let Some(&count) = books.frames.get(&texture) {
            return count;
        }
        let path = self
            .materials
            .textures
            .get(texture as usize)
            .cloned()
            .unwrap_or_default();
        let count = match self.content(&path) {
            Ok(bytes) => decode_flipbook(&bytes, texture, &mut books.pixels, frames),
            Err(_) => 0,
        };
        books.frames.insert(texture, count);
        count
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_material_motion(ctx: *mut BhContext, count: *mut usize) -> *const BhMaterialMotion {
    let mut result = ptr::null();
    let _ = unsafe { output(count, 0) };
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            m.prepare_motion(&|| Ok(()))?;
            if !count.is_null() {
                output(count, m.motion.materials.len())?;
            }
            if !m.motion.materials.is_empty() {
                result = m.motion.materials.as_ptr();
            }
            Ok(())
        })
    };
    result
}

/// Frame `frame` (1..frames) of texture `texture`'s flipbook. Each frame is handed over once; the pixels stay valid
/// until the next texture request.
/// A sprite texture's VTF frames (env_sprite plays them at `framerate`): the frame count into `out` (1 for a still
/// texture), frames 1.. then handed over once each by bh_texture_frame.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_texture_flipbook(ctx: *mut BhContext, texture: i32, out: *mut u32) -> c_int {
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            m.prepare_motion(&|| Ok(()))?;
            let mut frames = std::mem::take(&mut m.motion.frames);
            let count = m.flipbook(texture, &mut Flipbooks::default(), &mut frames);
            m.motion.frames = frames;
            output(out, count.max(1))
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_texture_frame(ctx: *mut BhContext, texture: i32, frame: u32, out: *mut BhImage) -> c_int {
    unsafe {
        call(ctx, |c| {
            output(out, BhImage::default())?;
            let m = c.map()?;
            m.prepare_motion(&|| Ok(()))?;
            let image = m
                .motion
                .frames
                .remove(&(texture, frame))
                .ok_or("flipbook frame unavailable")?;
            m.texture = image.rgba;
            output(
                out,
                BhImage {
                    rgba: m.texture.as_ptr(),
                    byte_count: m.texture.len(),
                    width: image.width,
                    height: image.height,
                },
            )
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_material_wireframes(ctx: *mut BhContext, count: *mut usize) -> *const BhMaterialWireframe {
    let mut result = ptr::null();
    let _ = unsafe { output(count, 0) };
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            m.prepare_motion(&|| Ok(()))?;
            if !count.is_null() {
                output(count, m.motion.wireframes.len())?;
            }
            if !m.motion.wireframes.is_empty() {
                result = m.motion.wireframes.as_ptr();
            }
            Ok(())
        })
    };
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vmt_of(files: &[(&str, &str)], path: &str) -> Option<Vmt> {
        let files: HashMap<String, Vec<u8>> = files
            .iter()
            .map(|(p, b)| (p.to_string(), b.as_bytes().to_vec()))
            .collect();
        load_vmt(&mut |p| files.get(p).cloned(), path, 0)
    }

    #[test]
    fn reads_base_texture_scrolls_like_the_website() {
        // texture-scroll.test.ts: bhop_ceaseless's stars, a water bump scroll, no proxy, and Source's defaults.
        let stars = r#""unlitgeneric"
{
	"$basetexture" "plar/ceaseless/stars"
"Proxies"
	{
		"TextureScroll"
		{
			"texturescrollvar"	$basetexturetransform
			"texturescrollrate"	1.5
			"texturescrollangle" -90
		}
	}

}"#;
        let files = [
            ("materials/stars.vmt", stars),
            (
                "materials/water.vmt",
                r#""Water" { "$normalmap" "x" "Proxies" { "TextureScroll" { "texturescrollvar" "$bumptransform" "texturescrollrate" .02 } } }"#,
            ),
            (
                "materials/plain.vmt",
                r#""LightmappedGeneric" { "$basetexture" "plain" }"#,
            ),
            (
                "materials/defaults.vmt",
                r#""UnlitGeneric" { "$basetexture" "d" "Proxies" { "TextureScroll" { "texturescrollvar" "$baseTextureTransform" } } }"#,
            ),
        ];
        let scroll = |path: &str| texture_scroll(&vmt_of(&files, path).unwrap());
        assert_eq!(scroll("materials/stars.vmt"), Some((1.5, -90.0)));
        assert_eq!(scroll("materials/water.vmt"), None);
        assert_eq!(scroll("materials/plain.vmt"), None);
        assert_eq!(scroll("materials/defaults.vmt"), Some((1.0, 0.0)));
        assert_eq!(vmt_path("PLAR\\Ceaseless/STARS"), "materials/plar/ceaseless/stars.vmt");
    }

    #[test]
    fn reads_base_texture_flipbooks_like_the_website() {
        let anim = |text: &str| texture_animation(&vmt_of(&[("materials/a.vmt", text)], "materials/a.vmt").unwrap());
        assert_eq!(
            anim(
                r#""UnlitGeneric" { "$basetexture" "k" "Proxies" { "AnimatedTexture" { "animatedTextureVar" "$basetexture" "animatedTextureFrameNumVar" "$frame" "animatedTextureFrameRate" "30" } } }"#
            ),
            Some((30.0, false))
        );
        assert_eq!(
            anim(
                r#""UnlitGeneric" { "$basetexture" "x" "Proxies" { "AnimatedTexture" { "animatedTextureVar" "$basetexture" "animationNoWrap" 1 } } }"#
            ),
            Some((15.0, true))
        );
        assert_eq!(
            anim(
                r#""Water" { "$normalmap" "x" "Proxies" { "AnimatedTexture" { "animatedTextureVar" "$normalmap" "animatedTextureFrameRate" 30 } } }"#
            ),
            None
        );
        assert_eq!(
            anim(
                r#""UnlitGeneric" { "Proxies" { "AnimatedTexture" { "animatedTextureVar" "$basetexture" "animatedTextureFrameRate" "0" } } }"#
            ),
            None
        );
    }

    #[test]
    fn follows_patch_includes_and_their_inserted_proxies() {
        let files = [
            ("materials/base.vmt", r#""UnlitGeneric" { "$basetexture" "b" }"#),
            (
                "materials/patched.vmt",
                r#""patch" { "include" "materials/base.vmt" "insert" { "Proxies" { "TextureScroll" { "texturescrollvar" "$basetexturetransform" "texturescrollrate" "2" "texturescrollangle" "45" } } } }"#,
            ),
            (
                "materials/broken.vmt",
                r#""patch" { "include" "materials/missing.vmt" }"#,
            ),
        ];
        assert_eq!(
            texture_scroll(&vmt_of(&files, "materials/patched.vmt").unwrap()),
            Some((2.0, 45.0))
        );
        assert_eq!(vmt_of(&files, "materials/broken.vmt"), None);
    }

    #[test]
    fn resolves_variable_scroll_inputs_like_source() {
        // texture-scroll-inputs.test.ts: bhop_umbra's moon (a constant variable) and strafe/stars_move (a Sine output).
        let moon = r#""VertexLitGeneric"
{
	"$baseTexture" "models\\aoc_skybox/dr_moon3"
	"$ScrollRateResult" "0.01"
    "Proxies" { "TextureScroll" { "texturescrollvar" "$basetexturetransform" "texturescrollrate" "$ScrollRateResult"
        "texturescrollangle" "30" } }
}"#;
        let stars = r#""UnlitGeneric" { "$basetexture" "strafe/stars" "$angle" 0.0 "Proxies" {
            "Sine" { "sineperiod" 240 "sinemin" "30" "sinmax" "60" "resultVar" "$angle" }
            "TextureScroll" { "texturescrollvar" "$basetexturetransform" "texturescrollrate" "0.001"
                "texturescrollangle" "$angle" } } }"#;
        let files = [("materials/moon.vmt", moon), ("materials/stars.vmt", stars)];
        assert_eq!(
            texture_scroll(&vmt_of(&files, "materials/moon.vmt").unwrap()),
            Some((0.01, 30.0))
        );
        assert_eq!(texture_scroll(&vmt_of(&files, "materials/stars.vmt").unwrap()), None);
        let mut vmt = Vmt::default();
        for (k, v) in [("$v", "[0.5 2 3]"), ("$c", "0.25"), ("$bad", "abc"), ("$hex", "0x10")] {
            vmt.params.insert(k.into(), v.into());
        }
        let input = |raw: Option<&str>| proxy_float(&vmt, raw.map(String::from).as_ref(), 1.0);
        assert_eq!(input(None), Some(1.0));
        assert_eq!(input(Some(" .5 ")), Some(0.5));
        assert_eq!(input(Some("$C")), Some(0.25));
        assert_eq!(input(Some("$v[1]")), Some(2.0));
        assert_eq!(input(Some(" $v [ 2 ] ")), Some(3.0));
        assert_eq!(input(Some("$v[3]")), None);
        assert_eq!(input(Some("$missing")), None);
        assert_eq!(input(Some("$bad")), None);
        assert_eq!(input(Some("$hex")), Some(16.0));
        assert_eq!(input(Some("")), None);
        assert_eq!(input(Some("$")), None);
    }

    #[test]
    fn reads_wireframe_colour_and_alpha_like_the_website() {
        let read = |text: &str| wireframe(3, &vmt_of(&[("materials/w.vmt", text)], "materials/w.vmt").unwrap());
        // bhop_4triedsame's escapism/test: no $color, white.
        assert_eq!(
            read(r#""Wireframe" { "$basetexture" "x" }"#),
            BhMaterialWireframe {
                material: 3,
                color: [1.0; 3],
                alpha: 1.0
            }
        );
        let red = read(r#""Wireframe" { "$color" "{255 0 0}" "$alpha" "1.5" }"#);
        assert_eq!((red.color, red.alpha), ([1.0, 0.0, 0.0], 1.0));
        let grey = read(r#""Wireframe" { "$color" "[.25]" "$alpha" ".5" }"#);
        assert_eq!((grey.color, grey.alpha), ([0.25; 3], 0.5));
    }

    #[test]
    fn parses_numbers_like_javascript() {
        assert_eq!(js_parse_float("1.5"), Some(1.5));
        assert_eq!(js_parse_float(" .02"), Some(0.02));
        assert_eq!(js_parse_float("-90deg"), Some(-90.0));
        assert_eq!(js_parse_float("3e2x"), Some(300.0));
        assert_eq!(js_parse_float("3e"), Some(3.0));
        assert_eq!(js_parse_float("5."), Some(5.0));
        assert_eq!(js_parse_float("."), None);
        assert_eq!(js_parse_float("abc"), None);
        assert_eq!(js_parse_float("-Infinity"), Some(f64::NEG_INFINITY));
    }

    #[test]
    fn tokenizes_comments_bare_words_and_unterminated_quotes() {
        // As vmt.ts: `//` starts a comment only where a token would start.
        let tokens = tokenize(&"a//x\n// c\n{ \"b c\" d}\"e".chars().collect::<Vec<_>>());
        let text = |s: &str| Token::Text(s.into());
        assert_eq!(
            tokens,
            vec![
                text("a//x"),
                Token::Open,
                text("b c"),
                text("d"),
                Token::Close,
                text("e")
            ]
        );
    }
}
