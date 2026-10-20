//! Game content helpers shared by the WASM exports and native tools.
//!
//! Stock CS:S/HL2 content is never shipped: players mount their own install (browser: see
//! `apps/web/src/content/`), and native tools read it from disk with [`DiskContent`].

use crate::materials::{self, Materials};
use crate::vfs::{Listing, Request, Source, Vfs, VpkMount, ARCHIVE_LISTING};
use playsrc_bsp::{Bsp, LumpData};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::rc::Rc;

/// Skybox face suffixes, in the order `sky_materials` returns them (+X, -X, +Y, -Y, +Z, -Z in Source axes).
pub const SKY_SUFFIXES: [&str; 6] = ["rt", "lf", "bk", "ft", "up", "dn"];

/// `skybox/<name>rt` … `skybox/<name>dn` material names.
pub fn sky_materials(skyname: &str) -> Vec<String> {
    SKY_SUFFIXES.iter().map(|s| format!("skybox/{}{s}", skyname.trim().to_ascii_lowercase())).collect()
}

/// The CS:S search path (after the map pakfile), relative to the install root
/// (`.../steamapps/common/Counter-Strike Source`). Missing ones are skipped.
pub const GAME_VPKS: [&str; 4] = [
    "cstrike/cstrike_pak_dir.vpk",
    "hl2/hl2_textures_dir.vpk",
    "hl2/hl2_misc_dir.vpk",
    "platform/platform_misc_dir.vpk",
];

/// Raw entity lump text.
pub fn entity_text(bsp: &Bsp) -> String {
    match bsp.lump(playsrc_bsp::ENTITIES).map(|l| &l.records) {
        Some(LumpData::EntityBytes(b)) => String::from_utf8_lossy(b).into_owned(),
        _ => String::new(),
    }
}

/// worldspawn `skyname`, if any.
pub fn skyname(bsp: &Bsp) -> Option<String> {
    let ents = crate::entities::parse(&entity_text(bsp));
    let world = ents.iter().find(|e| e.classname() == "worldspawn")?;
    world.get("skyname").map(str::to_string).filter(|s| !s.trim().is_empty())
}

pub fn pakfile(bsp: &Bsp) -> Vec<u8> {
    bsp.lump(playsrc_bsp::PAKFILE).map(|l| l.bytes(bsp).to_vec()).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Minimal VTF writers (synthetic fixtures and tests; single mip, no thumbnail).

const VTF_RGB888: i32 = 2;
const VTF_DXT1: i32 = 13;

fn vtf_header(width: u16, height: u16, format: i32, flags: u32) -> Vec<u8> {
    let mut b = vec![0u8; 80];
    b[..4].copy_from_slice(b"VTF\0");
    b[4..8].copy_from_slice(&7u32.to_le_bytes());
    b[8..12].copy_from_slice(&2u32.to_le_bytes());
    b[12..16].copy_from_slice(&80u32.to_le_bytes());
    b[16..18].copy_from_slice(&width.to_le_bytes());
    b[18..20].copy_from_slice(&height.to_le_bytes());
    b[20..24].copy_from_slice(&flags.to_le_bytes());
    b[24..26].copy_from_slice(&1u16.to_le_bytes()); // frames
    for (i, v) in [0.5f32, 0.5, 0.5].iter().enumerate() {
        b[32 + i * 4..36 + i * 4].copy_from_slice(&v.to_le_bytes());
    }
    b[48..52].copy_from_slice(&1f32.to_le_bytes()); // bumpmap scale
    b[52..56].copy_from_slice(&format.to_le_bytes());
    b[56] = 1; // mip count
    b[57..61].copy_from_slice(&(-1i32).to_le_bytes()); // no low-res image
    b[63..65].copy_from_slice(&1u16.to_le_bytes()); // depth
    b
}

/// VTF 7.2, RGB888, one mip. `rgb` is `width * height * 3` bytes, top row first.
pub fn write_vtf_rgb888(width: u16, height: u16, rgb: &[u8], clamp: bool) -> Vec<u8> {
    let mut b = vtf_header(width, height, VTF_RGB888, if clamp { 0x4 | 0x8 } else { 0 });
    b.extend_from_slice(rgb);
    b
}

/// VTF 7.2, DXT1, one mip, each 4x4 block a single colour (`blocks` in row order, RGB).
pub fn write_vtf_dxt1_flat(width: u16, height: u16, blocks: &[[u8; 3]]) -> Vec<u8> {
    let mut b = vtf_header(width, height, VTF_DXT1, 0);
    for c in blocks {
        let v = ((c[0] as u16 >> 3) << 11) | ((c[1] as u16 >> 2) << 5) | (c[2] as u16 >> 3);
        b.extend_from_slice(&v.to_le_bytes());
        b.extend_from_slice(&v.to_le_bytes());
        b.extend_from_slice(&[0; 4]);
    }
    b
}

/// Native driver: a CS:S install on disk (or a synthetic one), read lazily by archive range.
#[derive(Default)]
pub struct DiskContent {
    pub root: PathBuf,
    pub vpks: Vec<Rc<VpkMount>>,
    pub listings: Vec<Rc<Listing>>,
    /// Every file fetched so far (path -> bytes).
    pub fetched: HashMap<String, Rc<[u8]>>,
    /// Paths fetched per `resolve` call, in order (for extraction manifests).
    pub log: Vec<String>,
    /// Bytes read from archives (to show nothing is loaded wholesale).
    pub bytes_read: u64,
    /// Requests that failed (not retried).
    pub failed: std::collections::HashSet<String>,
}

impl DiskContent {
    /// Mounts the [`GAME_VPKS`] that exist under `root`.
    pub fn open(root: &Path) -> Result<Self, String> {
        let mut out = Self { root: root.to_path_buf(), ..Self::default() };
        for name in GAME_VPKS {
            let p = root.join(name);
            if !p.exists() {
                continue;
            }
            let dir = std::fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))?;
            out.vpks.push(Rc::new(VpkMount::parse(name, &dir)?));
        }
        if out.vpks.is_empty() {
            return Err(format!("no CS:S VPKs under {} (expected e.g. {})", root.display(), GAME_VPKS[0]));
        }
        Ok(out)
    }

    /// pak → fetched → VPKs → listings.
    pub fn vfs(&self, pak: Vec<u8>) -> Vfs {
        let mut vfs = Vfs::default();
        vfs.mount(Source::from_zip("pak", pak));
        vfs.mount(Source::loose("content", self.fetched.clone()));
        for m in &self.vpks {
            vfs.mount(Source::vpk(m.clone()));
        }
        for l in &self.listings {
            vfs.mount(Source::listing(l.clone()));
        }
        vfs
    }

    fn fetch(&mut self, req: &Request, synth: &mut dyn FnMut(&str) -> Option<Vec<u8>>) -> Result<(), String> {
        let bytes = if req.archive == ARCHIVE_LISTING {
            synth(&req.path).ok_or_else(|| format!("{}: listing has no bytes", req.path))?
        } else {
            let m = self.vpks.iter().find(|m| m.name == req.mount).ok_or("unknown mount")?;
            let mut chunk = vec![0u8; req.length as usize];
            if req.length > 0 {
                let p = self.root.join(m.archive_name(req.archive));
                let mut f = std::fs::File::open(&p).map_err(|e| format!("{}: {e}", p.display()))?;
                f.seek(SeekFrom::Start(req.offset as u64)).map_err(|e| e.to_string())?;
                f.read_exact(&mut chunk).map_err(|e| format!("{}: {e}", p.display()))?;
                self.bytes_read += req.length as u64;
            }
            m.assemble(&req.path, &chunk)?
        };
        self.log.push(req.path.clone());
        self.fetched.insert(req.path.clone(), bytes.into());
        Ok(())
    }

    /// Builds the static prop mesh, fetching model files (and their VMTs) until nothing is pending.
    pub fn resolve_props(&mut self, pak: &[u8], sp: &crate::props::StaticProps) -> crate::props::PropMesh {
        let mut rounds = 0;
        loop {
            let vfs = self.vfs(pak.to_vec());
            let mesh = crate::props::build(sp, &vfs);
            let pending: Vec<Request> = vfs.take_pending().into_iter().filter(|r| !self.failed.contains(&r.path)).collect();
            if pending.is_empty() || rounds > 8 {
                return mesh;
            }
            rounds += 1;
            for req in &pending {
                if let Err(e) = self.fetch(req, &mut |_| None) {
                    eprintln!("content: {e}");
                    self.failed.insert(req.path.clone());
                }
            }
        }
    }

    /// Resolves `names` against `pak` + this content, fetching until nothing is pending.
    /// `synth` supplies bytes for listing requests (synthetic fixtures). Returns the materials and the final VFS.
    pub fn resolve(&mut self, pak: &[u8], names: &[String], synth: &mut dyn FnMut(&str) -> Option<Vec<u8>>) -> (Materials, Vfs, u32) {
        let mut rounds = 0;
        loop {
            let vfs = self.vfs(pak.to_vec());
            let mats = materials::resolve(&vfs, names);
            let pending: Vec<Request> = vfs.take_pending().into_iter().filter(|r| !self.failed.contains(&r.path)).collect();
            if pending.is_empty() || rounds > 16 {
                return (mats, vfs, rounds);
            }
            rounds += 1;
            for req in &pending {
                if let Err(e) = self.fetch(req, synth) {
                    eprintln!("content: {e}");
                    self.failed.insert(req.path.clone());
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Cached physics content for native tools (simcli, fuzz, paritysim, tests).

/// The extracted stock collision models (`.phy` / `.mdl`) a map's props need, from the content cache that
/// `tools/content/extract.ts` writes: `<cache>/physics/<map>.txt` lists `path<TAB>sha256` lines and the bytes
/// are in `<cache>/content/<sha256>`. `cache` defaults to `$CONTENT_CACHE_DIR`, else `content-cache/` next
/// to the map's directory. `None` when there's no list for the map (props then collide only if the map
/// packs their models, like a client without hosted content).
pub fn cached_physics_content(map_path: &Path) -> Option<Source> {
    let name = map_path.file_stem()?.to_str()?;
    let cache = std::env::var_os("CONTENT_CACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| map_path.parent().unwrap_or(Path::new(".")).join("../content-cache"));
    let list = std::fs::read_to_string(cache.join("physics").join(format!("{name}.txt"))).ok()?;
    let mut files = HashMap::new();
    for line in list.lines() {
        let Some((path, sha)) = line.split_once('\t') else { continue };
        if let Ok(bytes) = std::fs::read(cache.join("content").join(sha.trim())) {
            files.insert(crate::vfs::normalize(path), Rc::<[u8]>::from(bytes));
        }
    }
    Some(Source::loose("content", files))
}

/// Loads a map for native tools: the BSP plus its cached physics content (see `cached_physics_content`).
pub fn load_game(map_path: &Path) -> Result<crate::Game, String> {
    let bytes = std::fs::read(map_path).map_err(|e| format!("{}: {e}", map_path.display()))?;
    let bsp = crate::parse_bsp(&bytes)?;
    crate::Game::load_with_content(&bsp, cached_physics_content(map_path))
}
