//! Per-map material overrides from the map's hosted content manifest.
//!
//! A manifest can list materials that draw as another material. That covers art a map packs in its own BSP without
//! changing the BSP, whose hash pins the map's zones and replays. Drawing only: the simulation reads surface
//! properties from the BSP by texture name and never sees this table.
use bunnyhop_core::vfs::normalize;
use std::collections::HashMap;
use std::path::Path;

const MANIFEST_BYTE_LIMIT: u64 = 16 * 1024 * 1024;

#[derive(Default)]
pub struct MaterialOverrides(HashMap<String, String>);

impl MaterialOverrides {
    /// The table in the manifest saved beside a downloaded map's content folder. A map loaded from loose files has no
    /// manifest and overrides nothing.
    pub fn beside(content_root: Option<&Path>, map_sha256: &str) -> Self {
        content_root
            .and_then(Path::parent)
            .and_then(|directory| read_manifest(&directory.join("manifest.json")))
            .map(|manifest| Self::from_manifest(&manifest, map_sha256))
            .unwrap_or_default()
    }

    /// A manifest written for another BSP is ignored: its material names mean nothing here.
    pub fn from_manifest(manifest: &serde_json::Value, map_sha256: &str) -> Self {
        if manifest["mapSha256"].as_str() != Some(map_sha256) {
            return Self::default();
        }
        let Some(table) = manifest["materialOverrides"].as_object() else {
            return Self::default();
        };
        let pairs = table.iter().filter_map(|(from, to)| {
            let from = normalize(from);
            let to = normalize(to.as_str()?);
            (!from.is_empty() && !to.is_empty()).then_some((from, to))
        });
        Self(pairs.collect())
    }

    /// Each overridden name becomes its replacement and keeps its place, so material indices stay valid.
    pub fn apply(&self, names: Vec<String>) -> Vec<String> {
        if self.0.is_empty() {
            return names;
        }
        names
            .into_iter()
            .map(|name| self.0.get(&normalize(&name)).cloned().unwrap_or(name))
            .collect()
    }
}

fn read_manifest(path: &Path) -> Option<serde_json::Value> {
    if std::fs::metadata(path).ok()?.len() > MANIFEST_BYTE_LIMIT {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}
