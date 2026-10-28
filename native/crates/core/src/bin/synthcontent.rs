//! Writes a *synthetic* "Counter-Strike Source" install (no Valve content) for testing the
//! game-content mount path without owning the game: generated VMT/VTF for every stock material the
//! given maps reference, packed into split VPKs laid out like the real install.
//!
//! usage: synthcontent <out dir> <map.bsp>...
//!
//! Layout written:
//!   <out>/cstrike/cstrike_pak_dir.vpk + _000.vpk    VMTs (search path 1)
//!   <out>/hl2/hl2_textures_dir.vpk + _000.vpk       VTFs (search path 2; 16 bytes of each preloaded)
use bunnyhop_core::content::{self, write_vtf_dxt1_flat, write_vtf_rgb888, DiskContent};
use bunnyhop_core::vfs::{write_vpk, Listing};
use std::collections::BTreeMap;
use std::rc::Rc;

fn hash(s: &str) -> u32 {
    s.bytes().fold(2166136261u32, |h, b| (h ^ b as u32).wrapping_mul(16777619))
}

fn hsl(h: f32, s: f32, l: f32) -> [u8; 3] {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h * 6.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    [r, g, b].map(|v| ((v + m).clamp(0.0, 1.0) * 255.0) as u8)
}

fn sky_face(suffix: &str) -> Vec<u8> {
    let (w, h) = (128usize, 128usize);
    let band = match suffix {
        "rt" => [220, 60, 60],
        "lf" => [60, 200, 80],
        "bk" => [230, 210, 60],
        "ft" => [210, 70, 210],
        _ => [0, 0, 0],
    };
    let mut rgb = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        for x in 0..w {
            let t = y as f32 / (h - 1) as f32; // 0 = top of image
            let mut c = match suffix {
                "up" => [40, 80, 170],
                "dn" => [70, 62, 55],
                _ => {
                    let top = [40.0, 80.0, 170.0];
                    let bottom = [200.0, 220.0, 240.0];
                    [0, 1, 2].map(|i| (top[i] + (bottom[i] - top[i]) * t * t) as u8)
                }
            };
            // A horizon band at the bottom of each side face, and a marker on "up" towards image top.
            if !matches!(suffix, "up" | "dn") && (0.86..0.94).contains(&t) {
                c = band;
            }
            if suffix == "up" && (8..24).contains(&y) && (56..72).contains(&x) {
                c = [255, 255, 255];
            }
            // A vertical tick at image-left so horizontal flips are visible.
            if !matches!(suffix, "up" | "dn") && x < 6 && t > 0.6 {
                c = [20, 20, 20];
            }
            rgb.extend_from_slice(&c);
        }
    }
    write_vtf_rgb888(w as u16, h as u16, &rgb, true)
}

fn world_texture(path: &str) -> Vec<u8> {
    let h = hash(path);
    let hue = (h % 360) as f32 / 360.0;
    let a = hsl(hue, 0.45, 0.55);
    let b = hsl(hue, 0.45, 0.38);
    if h % 2 == 0 {
        // DXT1, 64x64: 16-texel checker built from flat 4x4 blocks.
        let blocks: Vec<[u8; 3]> = (0..16 * 16).map(|i| if ((i % 16) / 4 + (i / 16) / 4) % 2 == 0 { a } else { b }).collect();
        write_vtf_dxt1_flat(64, 64, &blocks)
    } else {
        // RGB888, 64x64: diagonal stripes with a dark border.
        let mut rgb = Vec::with_capacity(64 * 64 * 3);
        for y in 0..64 {
            for x in 0..64 {
                let c = if x == 0 || y == 0 { [30, 30, 30] } else if ((x + y) / 8) % 2 == 0 { a } else { b };
                rgb.extend_from_slice(&c);
            }
        }
        write_vtf_rgb888(64, 64, &rgb, false)
    }
}

fn synth(path: &str) -> Option<Vec<u8>> {
    let rel = path.strip_prefix("materials/")?;
    if let Some(name) = rel.strip_suffix(".vmt") {
        if name.starts_with("skybox/") {
            return Some(format!("\"UnlitGeneric\"\n{{\n\t\"$basetexture\" \"{name}\"\n\t\"$nofog\" \"1\"\n}}\n").into_bytes());
        }
        if name.contains("water") && !name.contains("waterfall") {
            return Some(b"\"Water\"\n{\n\t\"$fogcolor\" \"{40 70 90}\"\n\t\"$normalmap\" \"dev/water_normal\"\n}\n".to_vec());
        }
        let detail = if hash(name) % 3 == 0 { "\t\"$detail\" \"synthetic/detail\"\n\t\"$detailscale\" \"6\"\n\t\"$detailblendfactor\" \"0.6\"\n" } else { "" };
        let glass = if name.contains("glass") { "\t\"$translucent\" \"1\"\n\t\"$alpha\" \"0.6\"\n" } else { "" };
        return Some(format!("\"LightmappedGeneric\"\n{{\n\t\"$basetexture\" \"{name}\"\n{detail}{glass}}}\n").into_bytes());
    }
    let name = rel.strip_suffix(".vtf")?;
    if name == "synthetic/detail" {
        let mut rgb = Vec::with_capacity(32 * 32 * 3);
        for i in 0..32 * 32u32 {
            let v = 128 + ((hash(&i.to_string()) % 64) as i32 - 32);
            rgb.extend_from_slice(&[v as u8; 3]);
        }
        return Some(write_vtf_rgb888(32, 32, &rgb, false));
    }
    if let Some(face) = name.strip_prefix("skybox/") {
        let suffix = &face[face.len().saturating_sub(2)..];
        return Some(sky_face(suffix));
    }
    Some(world_texture(path))
}

fn main() {
    let mut args = std::env::args().skip(1);
    let out = std::path::PathBuf::from(args.next().expect("usage: synthcontent <out dir> <map.bsp>..."));
    let maps: Vec<String> = args.collect();
    let mut dc = DiskContent::default();
    dc.listings.push(Rc::new(Listing::everything_under("synthetic", "materials/")));
    for path in &maps {
        let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"));
        let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
        let mesh = bunnyhop_core::mesh::build(&bsp);
        let mut names: Vec<String> = mesh.materials.iter().map(|m| m.name.clone()).collect();
        if let Some(sky) = content::skyname(&bsp) {
            names.extend(content::sky_materials(&sky));
        }
        let before = dc.fetched.len();
        dc.resolve(&content::pakfile(&bsp), &names, &mut synth);
        println!("{path}: {} synthetic files", dc.fetched.len() - before);
    }
    let mut vmts: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut vtfs: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for (p, b) in &dc.fetched {
        let target = if p.ends_with(".vtf") { &mut vtfs } else { &mut vmts };
        target.insert(p.clone(), b.to_vec());
    }
    let write = |sub: &str, base: &str, files: &BTreeMap<String, Vec<u8>>, preload: usize| {
        let list: Vec<(&str, &[u8])> = files.iter().map(|(p, b)| (p.as_str(), b.as_slice())).collect();
        let (dir, archive) = write_vpk(&list, preload);
        let d = out.join(sub);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(format!("{base}_dir.vpk")), dir).unwrap();
        std::fs::write(d.join(format!("{base}_000.vpk")), archive).unwrap();
        println!("wrote {}/{base}_dir.vpk ({} files)", d.display(), files.len());
    };
    write("cstrike", "cstrike_pak", &vmts, 0);
    write("hl2", "hl2_textures", &vtfs, 16);
}
