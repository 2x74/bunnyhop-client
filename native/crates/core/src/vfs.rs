//! Minimal virtual filesystem for map content.
//!
//! Sources are searched in mount order, like Source's search paths:
//!
//! 1. the BSP pakfile (lump 40, a store-only zip): maps may override stock content,
//! 2. loose files: bytes already fetched from game content (or restored from a cache),
//! 3. remote sources: indexes of files whose bytes live elsewhere, e.g. the user's own
//!    Counter-Strike: Source VPKs (`VpkMount`), or a dev server listing (`Listing`).
//!
//! A remote source never does I/O. When a lookup hits a remote entry whose bytes aren't
//! loaded yet, `read` returns `None` and records a [`Request`]. The host (JS) reads the
//! requested byte range (`File.slice` on the VPK archive), hands the bytes back, and the
//! caller resolves again. Each round resolves one more level of VMT → include → VTF.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::Range;
use std::rc::Rc;

/// Normalises a game path: lowercase, forward slashes, no leading slash.
pub fn normalize(path: &str) -> String {
    let p = path.trim().replace('\\', "/").to_ascii_lowercase();
    let p = p.trim_start_matches('/');
    let mut out = String::with_capacity(p.len());
    let mut prev_slash = false;
    for ch in p.chars() {
        if ch == '/' {
            if prev_slash {
                continue;
            }
            prev_slash = true;
        } else {
            prev_slash = false;
        }
        out.push(ch);
    }
    out
}

/// Archive index used by a [`Request`] whose bytes come from a [`Listing`] (fetch the path itself).
pub const ARCHIVE_LISTING: u32 = 0xffff_ffff;
/// Archive index of data embedded in the `_dir.vpk` itself (playsrc_vpk::EMBEDDED_ARCHIVE).
pub const ARCHIVE_EMBEDDED: u32 = playsrc_vpk::EMBEDDED_ARCHIVE as u32;

/// A file the host must supply before resolution can continue.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub path: String,
    /// Remote mount name (e.g. `cstrike/cstrike_pak_dir.vpk`, or the listing name).
    pub mount: String,
    /// VPK archive index (`<base>_NNN.vpk`), [`ARCHIVE_EMBEDDED`] or [`ARCHIVE_LISTING`].
    pub archive: u32,
    pub offset: u32,
    /// Bytes to read from the archive. May be 0 (entry fully preloaded in the directory).
    pub length: u32,
}

/// A parsed `_dir.vpk`: the file tree only. Archive chunks are never loaded here; the host
/// reads `(archive, offset, length)` ranges on demand and passes them to [`VpkMount::assemble`].
pub struct VpkMount {
    pub name: String,
    archive: playsrc_vpk::Archive,
}

struct Chunk<'a> {
    archive: u32,
    offset: u64,
    bytes: &'a [u8],
}

impl playsrc_vpk::SegmentReader for Chunk<'_> {
    fn len(&self, archive_index: u32) -> Result<u64, playsrc_vpk::SourceError> {
        if archive_index != self.archive {
            return Err(playsrc_vpk::SourceError { code: playsrc_vpk::SourceErrorCode::Missing, range: 0..0 });
        }
        Ok(self.offset + self.bytes.len() as u64)
    }

    fn read(&self, archive_index: u32, range: Range<u64>) -> Result<Vec<u8>, playsrc_vpk::SourceError> {
        let missing = playsrc_vpk::SourceError { code: playsrc_vpk::SourceErrorCode::ShortRead, range: range.clone() };
        if archive_index != self.archive || range.start < self.offset {
            return Err(missing);
        }
        let (s, e) = ((range.start - self.offset) as usize, (range.end - self.offset) as usize);
        self.bytes.get(s..e).map(<[u8]>::to_vec).ok_or(missing)
    }
}

impl VpkMount {
    /// `name` identifies the directory file, e.g. `cstrike/cstrike_pak_dir.vpk`; it must end in `_dir.vpk`.
    pub fn parse(name: &str, dir: &[u8]) -> Result<Self, String> {
        let archive = playsrc_vpk::parse(dir, name, playsrc_vpk::Layout::Split, playsrc_vpk::Limits::default()).map_err(|e| format!("vpk {name}: {e}"))?;
        Ok(Self { name: name.to_string(), archive })
    }

    pub fn len(&self) -> usize {
        self.archive.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.archive.entries.is_empty()
    }

    pub fn contains(&self, path: &str) -> bool {
        self.archive.entry(path).is_ok()
    }

    /// Where the non-preloaded bytes of `path` live. Data embedded in the directory file is already
    /// resident, so those requests (like fully preloaded ones) have `length == 0`: the host supplies
    /// an empty chunk without reading anything.
    pub fn locate(&self, path: &str) -> Option<Request> {
        let e = self.archive.entry(path).ok()?;
        let embedded = e.data.archive_index == playsrc_vpk::EMBEDDED_ARCHIVE;
        Some(Request {
            path: path.to_string(),
            mount: self.name.clone(),
            archive: e.data.archive_index as u32,
            offset: e.data.offset,
            length: if embedded { 0 } else { e.data.length },
        })
    }

    /// Archive file name for `archive` (`cstrike/cstrike_pak_dir.vpk`, 3 -> `cstrike/cstrike_pak_003.vpk`).
    pub fn archive_name(&self, archive: u32) -> String {
        let base = self.name.strip_suffix("_dir.vpk").unwrap_or(&self.name);
        format!("{base}_{archive:03}.vpk")
    }

    /// Joins directory preload bytes with the archive `chunk` read for `path` and checks the CRC.
    pub fn assemble(&self, path: &str, chunk: &[u8]) -> Result<Vec<u8>, String> {
        let req = self.locate(path).ok_or_else(|| format!("{path}: not in {}", self.name))?;
        let reader = Chunk { archive: req.archive, offset: req.offset as u64, bytes: chunk };
        self.archive.read_entry(path, &reader).map(|r| r.bytes).map_err(|e| format!("{path}: {e}"))
    }

    /// All paths in the tree (lowercase).
    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.archive.entries.iter().map(|e| e.logical_path.as_str())
    }
}

/// A set of paths whose bytes the host can fetch by path (e.g. the dev server's `content-cache/`).
pub struct Listing {
    pub name: String,
    pub paths: HashSet<String>,
    /// Claim every path under this prefix (used to discover what a map would read; tools only).
    pub any_under: Option<String>,
}

impl Listing {
    pub fn new(name: &str, paths: impl IntoIterator<Item = String>) -> Self {
        Self { name: name.to_string(), paths: paths.into_iter().map(|p| normalize(&p)).collect(), any_under: None }
    }

    /// A listing that claims to have every file under `prefix`.
    pub fn everything_under(name: &str, prefix: &str) -> Self {
        Self { name: name.to_string(), paths: HashSet::new(), any_under: Some(normalize(prefix)) }
    }

    pub fn contains(&self, path: &str) -> bool {
        self.paths.contains(path) || self.any_under.as_deref().is_some_and(|p| path.starts_with(p))
    }
}

enum Backing {
    Zip { data: Vec<u8>, files: HashMap<String, Range<usize>>, decoded: HashMap<String, Vec<u8>> },
    Loose(HashMap<String, Rc<[u8]>>),
    Vpk(Rc<VpkMount>),
    Listing(Rc<Listing>),
}

/// A read-only collection of files addressed by normalised path.
pub struct Source {
    pub name: String,
    backing: Backing,
}

impl Source {
    /// Parses a BSP pakfile zip. Stored entries are served in place; LZMA entries (`bspzip -repack`)
    /// are decoded once up front (CRC-checked). Other methods are skipped.
    pub fn from_zip(name: &str, data: Vec<u8>) -> Self {
        let (files, compressed) = zip_index(&data).unwrap_or_default();
        let decoded = if compressed.is_empty() { HashMap::new() } else { decode_compressed(&data, &compressed) };
        Self { name: name.to_string(), backing: Backing::Zip { data, files, decoded } }
    }

    /// Files already in memory (fetched game content, cache hits).
    pub fn loose(name: &str, files: HashMap<String, Rc<[u8]>>) -> Self {
        Self { name: name.to_string(), backing: Backing::Loose(files) }
    }

    pub fn vpk(mount: Rc<VpkMount>) -> Self {
        Self { name: mount.name.clone(), backing: Backing::Vpk(mount) }
    }

    pub fn listing(listing: Rc<Listing>) -> Self {
        Self { name: listing.name.clone(), backing: Backing::Listing(listing) }
    }

    /// Bytes of a resident file. Remote sources never have resident bytes.
    pub fn get(&self, path: &str) -> Option<&[u8]> {
        match &self.backing {
            Backing::Zip { data, files, decoded } => files.get(path).and_then(|r| data.get(r.clone())).or_else(|| decoded.get(path).map(Vec::as_slice)),
            Backing::Loose(files) => files.get(path).map(|b| &b[..]),
            Backing::Vpk(_) | Backing::Listing(_) => None,
        }
    }

    /// For remote sources: where to fetch `path` from, if this source has it.
    fn locate(&self, path: &str) -> Option<Request> {
        match &self.backing {
            Backing::Vpk(m) => m.locate(path),
            Backing::Listing(l) => l.contains(path).then(|| Request {
                path: path.to_string(),
                mount: l.name.clone(),
                archive: ARCHIVE_LISTING,
                offset: 0,
                length: 0,
            }),
            _ => None,
        }
    }

    pub fn len(&self) -> usize {
        match &self.backing {
            Backing::Zip { files, decoded, .. } => files.len() + decoded.len(),
            Backing::Loose(files) => files.len(),
            Backing::Vpk(m) => m.len(),
            Backing::Listing(l) => l.paths.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The raw zip bytes (empty for other kinds).
    pub fn bytes(&self) -> &[u8] {
        match &self.backing {
            Backing::Zip { data, .. } => data,
            _ => &[],
        }
    }

    /// Paths of resident files (zip and loose sources).
    pub fn paths(&self) -> Vec<&str> {
        match &self.backing {
            Backing::Zip { files, decoded, .. } => files.keys().chain(decoded.keys()).map(String::as_str).collect(),
            Backing::Loose(files) => files.keys().map(String::as_str).collect(),
            _ => Vec::new(),
        }
    }
}

#[derive(Default)]
pub struct Vfs {
    sources: Vec<Source>,
    /// Remote hits whose bytes are not loaded yet, keyed by path (deduplicated).
    pending: RefCell<BTreeMap<String, Request>>,
}

impl Vfs {
    pub fn mount(&mut self, source: Source) {
        self.sources.push(source);
    }

    /// Mounts `source` first in search order.
    pub fn mount_front(&mut self, source: Source) {
        self.sources.insert(0, source);
    }

    /// Looks up a file by game path (normalised internally). A hit in a remote source
    /// records a [`Request`] (see [`Vfs::take_pending`]) and returns `None`.
    pub fn read(&self, path: &str) -> Option<&[u8]> {
        let p = normalize(path);
        for s in &self.sources {
            if let Some(b) = s.get(&p) {
                return Some(b);
            }
            if let Some(req) = s.locate(&p) {
                self.pending.borrow_mut().entry(p).or_insert(req);
                return None;
            }
        }
        None
    }

    /// True if `path` was requested from a remote source and is not loaded yet.
    pub fn is_pending(&self, path: &str) -> bool {
        self.pending.borrow().contains_key(&normalize(path))
    }

    pub fn pending(&self) -> Vec<Request> {
        self.pending.borrow().values().cloned().collect()
    }

    pub fn take_pending(&self) -> Vec<Request> {
        std::mem::take(&mut *self.pending.borrow_mut()).into_values().collect()
    }

    pub fn source(&self, name: &str) -> Option<&Source> {
        self.sources.iter().find(|s| s.name == name)
    }

    /// Removes and returns the source called `name`.
    pub fn unmount(&mut self, name: &str) -> Option<Source> {
        let i = self.sources.iter().position(|s| s.name == name)?;
        Some(self.sources.remove(i))
    }
}

fn u16_at(b: &[u8], o: usize) -> Option<usize> {
    Some(u16::from_le_bytes(b.get(o..o + 2)?.try_into().ok()?) as usize)
}

fn u32_at(b: &[u8], o: usize) -> Option<usize> {
    Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?) as usize)
}

/// Decodes the named non-stored entries (LZMA in practice) with the `zip` crate, CRC-checked by it.
fn decode_compressed(data: &[u8], names: &[(String, String)]) -> HashMap<String, Vec<u8>> {
    use std::io::Read;
    let mut out = HashMap::new();
    let Ok(mut archive) = zip::ZipArchive::new(std::io::Cursor::new(data)) else { return out };
    for (raw, norm) in names {
        let Ok(mut f) = archive.by_name(raw) else { continue };
        let mut buf = Vec::with_capacity(f.size().min(256 << 20) as usize);
        if f.by_ref().take(256 << 20).read_to_end(&mut buf).is_ok() {
            out.insert(norm.clone(), buf);
        }
    }
    out
}

/// Stored entries (path -> byte range) and compressed entries (raw name, normalised path).
type ZipIndex = (HashMap<String, Range<usize>>, Vec<(String, String)>);

fn zip_index(data: &[u8]) -> Option<ZipIndex> {
    if data.len() < 22 {
        return None;
    }
    let mut compressed = Vec::new();
    // End of central directory record: scan backwards over a possible trailing comment.
    let min = data.len().saturating_sub(22 + 0xffff);
    let eocd = (min..=data.len() - 22).rev().find(|&i| data[i..i + 4] == [0x50, 0x4b, 0x05, 0x06])?;
    let count = u16_at(data, eocd + 10)?;
    let mut at = u32_at(data, eocd + 16)?;
    let mut files = HashMap::with_capacity(count);
    for _ in 0..count {
        if data.get(at..at + 4)? != [0x50, 0x4b, 0x01, 0x02] {
            break;
        }
        let method = u16_at(data, at + 10)?;
        let size = u32_at(data, at + 20)?;
        let name_len = u16_at(data, at + 28)?;
        let extra_len = u16_at(data, at + 30)?;
        let comment_len = u16_at(data, at + 32)?;
        let local = u32_at(data, at + 42)?;
        let name = String::from_utf8_lossy(data.get(at + 46..at + 46 + name_len)?).into_owned();
        at += 46 + name_len + extra_len + comment_len;
        if data.get(local..local + 4) != Some(&[0x50, 0x4b, 0x03, 0x04][..]) {
            continue;
        }
        if method != 0 {
            compressed.push((name.clone(), normalize(&name)));
            continue;
        }
        let start = local + 30 + u16_at(data, local + 26)? + u16_at(data, local + 28)?;
        if start + size <= data.len() {
            files.insert(normalize(&name), start..start + size);
        }
    }
    Some((files, compressed))
}

// ---------------------------------------------------------------------------
// Writing VPKs (tests and synthetic fixtures only; never used on Valve content).

/// Builds a split VPK v2 set: returns (`_dir.vpk` bytes, archive `_000.vpk` bytes).
/// `preload` bytes of each file go into the directory, the rest into archive 0.
pub fn write_vpk(files: &[(&str, &[u8])], preload: usize) -> (Vec<u8>, Vec<u8>) {
    // extension -> directory -> [(basename, data)]
    let mut tree: BTreeMap<String, BTreeMap<String, Vec<(String, &[u8])>>> = BTreeMap::new();
    for (path, data) in files {
        let p = normalize(path);
        let (dir, file) = p.rsplit_once('/').unwrap_or((" ", &p));
        let (base, ext) = file.rsplit_once('.').unwrap_or((file, " "));
        tree.entry(ext.to_string()).or_default().entry(dir.to_string()).or_default().push((base.to_string(), data));
    }
    let mut t = Vec::new();
    let mut archive = Vec::new();
    for (ext, dirs) in &tree {
        t.extend_from_slice(ext.as_bytes());
        t.push(0);
        for (dir, entries) in dirs {
            t.extend_from_slice(dir.as_bytes());
            t.push(0);
            for (base, data) in entries {
                t.extend_from_slice(base.as_bytes());
                t.push(0);
                let pre = preload.min(data.len());
                t.extend_from_slice(&crc32fast::hash(data).to_le_bytes());
                t.extend_from_slice(&(pre as u16).to_le_bytes());
                t.extend_from_slice(&0u16.to_le_bytes());
                t.extend_from_slice(&(archive.len() as u32).to_le_bytes());
                t.extend_from_slice(&((data.len() - pre) as u32).to_le_bytes());
                t.extend_from_slice(&0xffffu16.to_le_bytes());
                t.extend_from_slice(&data[..pre]);
                archive.extend_from_slice(&data[pre..]);
            }
            t.push(0);
        }
        t.push(0);
    }
    t.push(0);
    let mut dir = Vec::with_capacity(28 + t.len());
    for v in [playsrc_vpk::SIGNATURE, 2, t.len() as u32, 0, 0, 0, 0] {
        dir.extend_from_slice(&v.to_le_bytes());
    }
    dir.extend_from_slice(&t);
    (dir, archive)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Rc<VpkMount>, Vec<u8>) {
        let files: Vec<(&str, &[u8])> = vec![
            ("materials/stock/wall.vmt", b"\"LightmappedGeneric\" { \"$basetexture\" \"stock/wall\" }"),
            ("materials/stock/wall.vtf", b"not really a vtf but bytes are bytes"),
            ("materials/skybox/testrt.vmt", b"\"UnlitGeneric\" { \"$basetexture\" \"skybox/testrt\" }"),
        ];
        let (dir, archive) = write_vpk(&files, 4);
        (Rc::new(VpkMount::parse("cstrike/test_pak_dir.vpk", &dir).unwrap()), archive)
    }

    #[test]
    fn vpk_requests_then_serves_assembled_bytes() {
        let (mount, archive) = fixture();
        assert_eq!(mount.len(), 3);
        let mut vfs = Vfs::default();
        vfs.mount(Source::from_zip("pak", Vec::new()));
        vfs.mount(Source::vpk(mount.clone()));
        assert!(vfs.read("Materials\\Stock\\WALL.vmt").is_none());
        assert!(vfs.read("materials/nope.vmt").is_none());
        let reqs = vfs.take_pending();
        assert_eq!(reqs.len(), 1);
        let r = &reqs[0];
        assert_eq!((r.path.as_str(), r.archive), ("materials/stock/wall.vmt", 0));
        // The host reads exactly the requested slice of the archive.
        let chunk = &archive[r.offset as usize..(r.offset + r.length) as usize];
        let bytes = mount.assemble(&r.path, chunk).unwrap();
        assert!(bytes.starts_with(b"\"LightmappedGeneric\""));
        // Corrupt chunks fail the CRC.
        let mut bad = chunk.to_vec();
        bad[0] ^= 1;
        assert!(mount.assemble(&r.path, &bad).is_err());
        // Mounting the fetched bytes as loose files satisfies the read.
        let mut vfs = Vfs::default();
        vfs.mount(Source::loose("fetched", HashMap::from([(r.path.clone(), Rc::from(bytes))])));
        vfs.mount(Source::vpk(mount));
        assert!(vfs.read("materials/stock/wall.vmt").is_some());
        assert!(vfs.pending().is_empty());
    }

    #[test]
    fn pak_overrides_remote() {
        let (mount, _) = fixture();
        let mut zip_vfs = Vfs::default();
        zip_vfs.mount(Source::loose("pak", HashMap::from([("materials/stock/wall.vmt".to_string(), Rc::from(&b"x"[..]))])));
        zip_vfs.mount(Source::vpk(mount));
        assert_eq!(zip_vfs.read("materials/stock/wall.vmt"), Some(&b"x"[..]));
        assert!(zip_vfs.pending().is_empty());
    }

    #[test]
    fn listing_requests_by_path() {
        let mut vfs = Vfs::default();
        vfs.mount(Source::listing(Rc::new(Listing::new("dev", ["materials/A.vtf".to_string()]))));
        assert!(vfs.read("materials/a.vtf").is_none());
        let reqs = vfs.take_pending();
        assert_eq!(reqs[0].archive, ARCHIVE_LISTING);
        assert_eq!(reqs[0].mount, "dev");
    }
}
