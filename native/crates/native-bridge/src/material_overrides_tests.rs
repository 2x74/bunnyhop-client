//! A manifest's material overrides change what a map draws, never how it plays (material_overrides.rs).
use super::*;

const ART_COLOR: [f32; 3] = [0.25, 0.5, 0.75];
const WALL_COLOR: [f32; 3] = [1.0, 0.0, 0.0];
const ART: &[u8] = br#"UnlitGeneric { "$color" "[0.25 0.5 0.75]" "$surfaceprop" "gravel" }"#;
const WALL: &[u8] = br#"UnlitGeneric { "$color" "[1 0 0]" "$surfaceprop" "ice" }"#;

/// A downloaded map as the client stores it: the BSP, its content folder and, between them, the manifest.
struct DownloadedMap {
    fixture: Fixture,
    bsp: CString,
    content_root: CString,
    sha256: String,
}

impl DownloadedMap {
    /// The map's one face uses `fixture/test`, packed as the art. The wall is packed too and unused.
    fn new() -> Self {
        let fixture = Fixture::new();
        let pak = zip_files(&[
            ("materials/fixture/test.vmt", ART),
            ("materials/fixture/wall.vmt", WALL),
        ]);
        let bytes = ground_bsp(&pak);
        let bsp = fixture.file("map.bsp", &bytes);
        let content = fixture.0.join("content");
        std::fs::create_dir_all(&content).unwrap();
        let content_root = CString::new(content.to_str().unwrap()).unwrap();
        Self {
            fixture,
            bsp,
            content_root,
            sha256: recording::sha(&bytes),
        }
    }

    fn save_manifest(&self, map_sha256: &str, overrides: serde_json::Value) {
        let manifest =
            serde_json::json!({ "mapSha256": map_sha256, "materialOverrides": overrides });
        self.fixture
            .file("manifest.json", manifest.to_string().as_bytes());
    }

    fn load(&self) -> *mut BhContext {
        unsafe {
            let ctx = bh_create();
            assert_eq!(
                bh_load_map(ctx, self.bsp.as_ptr(), self.content_root.as_ptr()),
                1,
                "{}",
                CStr::from_ptr(bh_last_error(ctx)).to_string_lossy()
            );
            ctx
        }
    }
}

/// The colour and name the renderer is given for the map's face.
fn drawn(ctx: *mut BhContext) -> ([f32; 3], String) {
    unsafe {
        let mut count = 0;
        let materials = bh_materials(ctx, &mut count);
        assert_eq!(count, 1);
        let mut bytes = 0;
        let names = assets::bh_material_names_json(ctx, &mut bytes);
        let names: Vec<String> =
            serde_json::from_slice(std::slice::from_raw_parts(names.cast(), bytes)).unwrap();
        assert_eq!(names.len(), 1);
        ((*materials).color, names[0].clone())
    }
}

#[test]
fn an_overridden_material_draws_as_its_replacement() {
    let map = DownloadedMap::new();
    // Names arrive as an author typed them; they match the way file paths do.
    map.save_manifest(
        &map.sha256,
        serde_json::json!({ "Fixture\\TEST": "fixture/wall" }),
    );
    let ctx = map.load();
    assert_eq!(drawn(ctx), (WALL_COLOR, "fixture/wall".to_string()));
    unsafe { bh_destroy(ctx) };
}

#[test]
fn a_map_without_overrides_draws_its_own_material() {
    let map = DownloadedMap::new();
    let no_manifest = map.load();
    assert_eq!(drawn(no_manifest), (ART_COLOR, "fixture/test".to_string()));
    map.save_manifest(&map.sha256, serde_json::json!({}));
    let empty_table = map.load();
    assert_eq!(drawn(empty_table), (ART_COLOR, "fixture/test".to_string()));
    for ctx in [no_manifest, empty_table] {
        unsafe { bh_destroy(ctx) };
    }
}

#[test]
fn another_maps_manifest_overrides_nothing() {
    let map = DownloadedMap::new();
    map.save_manifest(
        &"0".repeat(64),
        serde_json::json!({ "fixture/test": "fixture/wall" }),
    );
    let ctx = map.load();
    assert_eq!(drawn(ctx), (ART_COLOR, "fixture/test".to_string()));
    unsafe { bh_destroy(ctx) };
}

#[test]
fn an_overridden_map_plays_tick_for_tick_like_the_original() {
    let map = DownloadedMap::new();
    let original = map.load();
    map.save_manifest(
        &map.sha256,
        serde_json::json!({ "fixture/test": "fixture/wall" }),
    );
    let covered = map.load();
    assert_eq!(drawn(covered).0, WALL_COLOR);
    unsafe {
        let mut settings = BhSettings::default();
        assert_eq!(bh_style_settings(c"autohop".as_ptr(), &mut settings), 1);
        for ctx in [original, covered] {
            assert_eq!(bh_set_settings(ctx, &settings), 1);
            assert_eq!(bh_reset(ctx), 1);
        }
        let command = BhCmd {
            forward: 450.0,
            ..BhCmd::default()
        };
        // Long enough to land and walk: gravel and ice part ways as soon as there is ground friction.
        for _ in 0..100 {
            let mut expected = BhState::default();
            let mut actual = BhState::default();
            assert_eq!(bh_step(original, &command, &mut expected), 1);
            assert_eq!(bh_step(covered, &command, &mut actual), 1);
            state_equal(expected, actual);
        }
        for ctx in [original, covered] {
            bh_destroy(ctx);
        }
    }
}
