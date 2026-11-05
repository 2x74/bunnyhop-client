//! Material proxies the renderer animates: TextureScroll on `$basetexturetransform` and AnimatedTexture on
//! `$basetexture` (apps/web/src/texture-scroll.ts, with its lenient VMT reader apps/web/src/vmt.ts). The core resolves
//! materials without their proxies, so this reads them from the VMT, and decodes the flipbooks' frames under the same
//! caps as the website. Render only.
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

fn flatten_proxies(body: &[(String, Kv)], out: &mut Vec<Proxy>) {
    for (key, value) in body {
        let Kv::Obj(proxies) = value else { continue };
        if key != "proxies" {
            continue;
        }
        for (name, proxy) in proxies {
            let Kv::Obj(pairs) = proxy else { continue };
            let params = pairs
                .iter()
                .filter_map(|(k, v)| match v {
                    Kv::Str(s) => Some((k.clone(), s.clone())),
                    Kv::Obj(_) => None,
                })
                .collect();
            out.push(Proxy {
                name: name.clone(),
                params,
            });
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

/// The proxies of a VMT, following `patch` includes (vmt.ts loadVmt). None when it or an include is missing.
pub(super) fn vmt_proxies(read: &mut dyn FnMut(&str) -> Option<Vec<u8>>, path: &str, depth: u32) -> Option<Vec<Proxy>> {
    if depth > MAX_INCLUDE_DEPTH {
        return None;
    }
    let (shader, body) = parse_key_values(&read(path)?)?;
    if shader != "patch" {
        let mut proxies = Vec::new();
        flatten_proxies(&body, &mut proxies);
        return Some(proxies);
    }
    let include = body.iter().find_map(|(k, v)| match v {
        Kv::Str(s) if k == "include" => Some(s.clone()),
        _ => None,
    })?;
    let mut proxies = vmt_proxies(read, &vmt_path(&include), depth + 1)?;
    for (key, value) in &body {
        if let Kv::Obj(block) = value {
            if key == "replace" || key == "insert" {
                flatten_proxies(block, &mut proxies);
            }
        }
    }
    Some(proxies)
}

/// JavaScript's `parseFloat`: the longest decimal prefix after leading whitespace, None when there is none.
fn js_parse_float(text: &str) -> Option<f64> {
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

fn targets(proxy: &Proxy, key: &str, variable: &str) -> bool {
    proxy
        .params
        .get(key)
        .is_some_and(|v| v.trim().to_lowercase() == variable)
}

/// The base-texture scroll (rate, angle), as texture-scroll.ts `textureScrollOf`. Source's defaults: rate 1, angle 0.
pub(super) fn texture_scroll(proxies: &[Proxy]) -> Option<(f64, f64)> {
    let proxy = proxies
        .iter()
        .find(|p| p.name == "texturescroll" && targets(p, "texturescrollvar", "$basetexturetransform"))?;
    let rate = number(&proxy.params, "texturescrollrate", 1.0);
    (rate != 0.0).then(|| (rate, number(&proxy.params, "texturescrollangle", 0.0)))
}

/// The base-texture flipbook (frame rate, no wrap), as texture-scroll.ts `textureAnimationOf`. Default rate 15.
pub(super) fn texture_animation(proxies: &[Proxy]) -> Option<(f64, bool)> {
    let proxy = proxies
        .iter()
        .find(|p| p.name == "animatedtexture" && targets(p, "animatedtexturevar", "$basetexture"))?;
    let rate = number(&proxy.params, "animatedtextureframerate", 15.0);
    (rate > 0.0).then(|| (rate, number(&proxy.params, "animationnowrap", 0.0) != 0.0))
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
        let mut books: HashMap<i32, u32> = HashMap::new();
        let mut pixels = 0;
        for (index, name) in names.iter().enumerate() {
            check()?;
            let Some(desc) = self.materials.descs.get(index) else {
                break;
            };
            if desc.kind != Kind::Textured || desc.texture < 0 {
                continue;
            }
            let texture = desc.texture;
            let proxies = vmt_proxies(&mut |path| self.content(path).ok(), &vmt_path(name), 0).unwrap_or_default();
            let entry = &mut motion.materials[index];
            if let Some((rate, angle)) = texture_scroll(&proxies) {
                (entry.scroll_rate, entry.scroll_angle) = (rate, angle);
            }
            let Some((rate, no_wrap)) = texture_animation(&proxies) else {
                continue;
            };
            let frames = match books.get(&texture) {
                Some(&frames) => frames,
                None => {
                    let path = self
                        .materials
                        .textures
                        .get(texture as usize)
                        .cloned()
                        .unwrap_or_default();
                    let frames = match self.content(&path) {
                        Ok(bytes) => decode_flipbook(&bytes, texture, &mut pixels, &mut motion.frames),
                        Err(_) => 0,
                    };
                    books.insert(texture, frames);
                    frames
                }
            };
            let entry = &mut motion.materials[index];
            if frames > 1 {
                (entry.frame_rate, entry.frames, entry.no_wrap) = (rate, frames, u32::from(no_wrap));
            }
        }
        self.motion = motion;
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn proxies_of(files: &[(&str, &str)], path: &str) -> Option<Vec<Proxy>> {
        let files: HashMap<String, Vec<u8>> = files
            .iter()
            .map(|(p, b)| (p.to_string(), b.as_bytes().to_vec()))
            .collect();
        vmt_proxies(&mut |p| files.get(p).cloned(), path, 0)
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
        let scroll = |path: &str| texture_scroll(&proxies_of(&files, path).unwrap());
        assert_eq!(scroll("materials/stars.vmt"), Some((1.5, -90.0)));
        assert_eq!(scroll("materials/water.vmt"), None);
        assert_eq!(scroll("materials/plain.vmt"), None);
        assert_eq!(scroll("materials/defaults.vmt"), Some((1.0, 0.0)));
        assert_eq!(vmt_path("PLAR\\Ceaseless/STARS"), "materials/plar/ceaseless/stars.vmt");
    }

    #[test]
    fn reads_base_texture_flipbooks_like_the_website() {
        let anim =
            |text: &str| texture_animation(&proxies_of(&[("materials/a.vmt", text)], "materials/a.vmt").unwrap());
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
            texture_scroll(&proxies_of(&files, "materials/patched.vmt").unwrap()),
            Some((2.0, 45.0))
        );
        assert_eq!(proxies_of(&files, "materials/broken.vmt"), None);
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
