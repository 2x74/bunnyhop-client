use super::*;
use std::mem::{align_of, offset_of, size_of};
use std::sync::atomic::{AtomicUsize, Ordering};

#[path = "replay_tests.rs"]
mod replay_v10;
#[path = "v29_tests.rs"]
mod v29;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static ID: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "bunnyhop-bridge-{}-{}",
            std::process::id(),
            ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn file(&self, name: &str, bytes: &[u8]) -> CString {
        let path = self.0.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        CString::new(path.to_str().unwrap()).unwrap()
    }
    fn root(&self) -> CString {
        CString::new(self.0.to_str().unwrap()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn integer(b: &mut [u8], at: usize, value: i32) {
    b[at..at + 4].copy_from_slice(&value.to_le_bytes());
}
fn float(b: &mut [u8], at: usize, value: f32) {
    integer(b, at, value.to_bits() as i32);
}
fn lump(b: &mut Vec<u8>, index: usize, version: i32, bytes: &[u8]) {
    let offset = b.len() as i32;
    integer(b, 8 + 16 * index, offset);
    integer(b, 12 + 16 * index, bytes.len() as i32);
    integer(b, 16 + 16 * index, version);
    b.extend_from_slice(bytes);
}
/// One textured triangle and a nonsolid BSP leaf; no external maps needed.
fn bsp(pak: &[u8]) -> Vec<u8> {
    let mut b = vec![0; playsrc_bsp::HEADER_BYTES];
    b[..4].copy_from_slice(b"VBSP");
    integer(&mut b, 4, 20);
    lump(
        &mut b,
        0,
        0,
        br#"{"classname" "worldspawn"}
{"classname" "info_player_start" "origin" "10 20 100" "angles" "0 45 0"}"#,
    );
    let mut p = vec![0; 20];
    float(&mut p, 8, 1.0);
    integer(&mut p, 16, 2);
    lump(&mut b, 1, 0, &p);
    let mut td = vec![0; 32];
    for at in [16, 20, 24, 28] {
        integer(&mut td, at, 2);
    }
    lump(&mut b, 2, 0, &td);
    let mut vertices = vec![0; 36];
    float(&mut vertices, 12, 64.0);
    float(&mut vertices, 28, 64.0);
    lump(&mut b, 3, 0, &vertices);
    let mut node = vec![0; 32];
    integer(&mut node, 4, -1);
    integer(&mut node, 8, -1);
    lump(&mut b, 5, 0, &node);
    let mut ti = vec![0; 72];
    float(&mut ti, 0, 1.0);
    float(&mut ti, 20, 1.0);
    float(&mut ti, 32, 1.0);
    float(&mut ti, 52, 1.0);
    lump(&mut b, 6, 0, &ti);
    let mut face = vec![0; 56];
    face[8..10].copy_from_slice(&3i16.to_le_bytes());
    face[12..14].copy_from_slice(&(-1i16).to_le_bytes());
    integer(&mut face, 20, -1);
    lump(&mut b, 7, 1, &face);
    let mut leaf = vec![0; 32];
    leaf[26..28].copy_from_slice(&1u16.to_le_bytes());
    lump(&mut b, 10, 1, &leaf);
    lump(&mut b, 12, 0, &[0, 0, 1, 0, 1, 0, 2, 0, 2, 0, 0, 0]);
    let mut edges = vec![0; 12];
    // Source faces wind clockwise from the front; the render builder emits CCW.
    integer(&mut edges, 4, 2);
    integer(&mut edges, 8, 1);
    lump(&mut b, 13, 0, &edges);
    let mut model = vec![0; 48];
    integer(&mut model, 44, 1);
    lump(&mut b, 14, 0, &model);
    lump(&mut b, 17, 0, &[0, 0]);
    let mut brush = vec![0; 12];
    integer(&mut brush, 4, 1);
    lump(&mut b, 18, 0, &brush);
    let mut side = vec![0; 8];
    side[2..4].copy_from_slice(&(-1i16).to_le_bytes());
    side[4..6].copy_from_slice(&(-1i16).to_le_bytes());
    lump(&mut b, 19, 0, &side);
    lump(&mut b, 43, 0, b"fixture/test\0");
    lump(&mut b, 44, 0, &[0; 4]);
    if !pak.is_empty() {
        lump(&mut b, 40, 0, pak);
    }
    b
}
fn state_equal(a: BhState, b: BhState) {
    let floats = |s: BhState| {
        s.position
            .into_iter()
            .chain(s.velocity)
            .chain([s.view_offset_z])
            .chain(s.teleport_angles)
            .chain(s.angle_change)
            .chain(s.touch_position)
            .map(f32::to_bits)
            .collect::<Vec<_>>()
    };
    assert_eq!(floats(a), floats(b));
    assert_eq!(
        [
            a.tick,
            a.grounded,
            a.crouched,
            a.on_ladder,
            a.events,
            a.touch_crouched
        ],
        [
            b.tick,
            b.grounded,
            b.crouched,
            b.on_ladder,
            b.events,
            b.touch_crouched
        ]
    );
}
#[test]
fn c_layouts_are_stable() {
    assert_eq!(size_of::<BhSurfaceProbe>(), 16);
    assert_eq!(size_of::<BhLookSample>(), 40);
    assert_eq!(offset_of!(BhLookSample, count), 16);
    assert_eq!(size_of::<BhLookSampleV2>(), 48);
    assert_eq!(offset_of!(BhLookSampleV2, count), 16);
    assert_eq!(offset_of!(BhLookSampleV2, epoch), 24);
    assert_eq!(size_of::<BhGhostFrame>(), 48);
    assert_eq!(size_of::<BhReplayEvents>(), 12);
    assert_eq!(size_of::<BhSkyInfo>(), 76);
    assert_eq!(size_of::<BhMaterialExtra>(), 28);
    assert_eq!(size_of::<BhPropGroup>(), 20);
    assert_eq!(size_of::<BhWeaponReport>(), 48);
    assert_eq!(size_of::<BhAttackReport>(), 52);
    assert_eq!(size_of::<BhFloorWeapon>(), 36);
    assert_eq!(size_of::<BhNoclipState>(), 48);
    assert_eq!(size_of::<BhSettings>(), 40);
    assert_eq!(size_of::<BhCmd>(), 20);
    assert_eq!(size_of::<BhState>(), 88);
    assert_eq!(size_of::<BhJumpObservation>(), 204);
    assert_eq!(offset_of!(BhJumpObservation, command), 176);
    assert_eq!(offset_of!(BhJumpObservation, epoch), 200);
    assert_eq!(offset_of!(BhState, tick), 64);
    assert_eq!(size_of::<BhGroup>(), 20);
    assert_eq!(size_of::<BhMaterial>(), 32);
    assert_eq!(offset_of!(BhMaterial, color), 20);
    assert_eq!(size_of::<BhTransform>(), 28);
    assert_eq!(align_of::<BhState>(), 4);
    assert_eq!(size_of::<BhImage>(), 2 * size_of::<usize>() + 8);
    assert_eq!(
        BhSettings::default().physics,
        bunnyhop_core::game::PHYSICS_LATEST
    );
    assert_eq!(size_of::<BhLightmapInfo>(), 8);
}
#[test]
fn contexts_step_exactly_like_core_and_remain_independent() {
    let fixture = Fixture::new();
    let bytes = bsp(&[]);
    let path = fixture.file("map.bsp", &bytes);
    let parsed = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let mut direct = Game::load_with_content(&parsed, None).unwrap();
    direct.set_settings(BhSettings::default().checked().unwrap());
    direct.reset();
    unsafe {
        let a = bh_create();
        let b = bh_create();
        assert_eq!(bh_load_map(a, path.as_ptr(), ptr::null()), 1);
        assert_eq!(bh_load_map(b, path.as_ptr(), ptr::null()), 1);
        let mut s = BhState::default();
        assert_eq!(bh_state(a, &mut s), 1);
        assert!(s.touch_position.iter().all(|x| x.is_nan()));
        state_equal(s, BhState::from(&direct));
        for i in 0..150 {
            let cmd = BhCmd {
                forward: 300.0,
                side: if i % 2 == 0 { 450.0 } else { -450.0 },
                yaw: 13.37 + i as f32 * 0.77,
                pitch: -18.0,
                buttons: if i % 5 == 0 {
                    game::IN_DUCK
                } else {
                    game::IN_JUMP
                },
            };
            direct
                .step(Cmd {
                    forward: cmd.forward,
                    side: cmd.side,
                    yaw: cmd.yaw,
                    pitch: cmd.pitch,
                    buttons: cmd.buttons,
                })
                .unwrap();
            assert_eq!(bh_step(a, &cmd, &mut s), 1);
            state_equal(s, BhState::from(&direct));
        }
        let mut other = BhState::default();
        assert_eq!(bh_state(b, &mut other), 1);
        assert_eq!(other.tick, 0);
        assert_eq!(bh_reset(a), 1);
        assert_eq!(bh_state(a, &mut s), 1);
        assert_eq!(s.tick, 0);
        assert_eq!(bh_set_position(a, 50.0, 60.0, 100.0, 123.0), 1);
        assert_eq!(bh_set_velocity(a, 11.0, 12.0, 13.0), 1);
        assert_eq!(bh_set_restart_names(a, c"runner".as_ptr(), c"".as_ptr()), 1);
        assert_eq!((*a).map.as_ref().unwrap().game.player_name, "runner");
        assert_eq!((*a).map.as_ref().unwrap().game.player_class, "player");
        assert_eq!(bh_state(a, &mut s), 1);
        assert_eq!(s.velocity, [11.0, 12.0, 13.0]);
        let mut transform = BhTransform::default();
        assert_eq!(bh_model_transform(a, 0, &mut transform), 1);
        assert_eq!(transform.visible, 1);
        let mut count = 0;
        assert!(!bh_vertices(a, &mut count).is_null());
        assert_eq!(count, 30);
        assert!(!bh_indices(a, &mut count).is_null());
        assert_eq!(count, 3);
        assert!(!bh_groups(a, &mut count).is_null());
        assert_eq!(count, 1);
        assert!(!bh_materials(a, &mut count).is_null());
        assert_eq!(count, 1);
        let mut image = BhImage::default();
        assert_eq!(bh_lightmap(a, &mut image), 1);
        assert_eq!(image.byte_count, (image.width * image.height * 4) as usize);
        let mut info = BhLightmapInfo::default();
        assert_eq!(bh_lightmap_info(a, &mut info), 1);
        assert!(info.scale == bunnyhop_core::lightmap::HDR_SCALE || info.scale == bunnyhop_core::lightmap::LDR_SCALE);
        let mut origin = [0.0; 3];
        let mut angles = [0.0; 3];
        assert_eq!(bh_spawn(a, origin.as_mut_ptr(), angles.as_mut_ptr()), 1);
        assert_eq!(origin, [10.0, 20.0, 100.0]);
        assert_eq!(angles, [0.0, 45.0, 0.0]);
        bh_destroy(a);
        assert_eq!(bh_state(b, &mut other), 1);
        bh_destroy(b);
    }
}
#[test]
fn invalid_inputs_and_failed_reload_cannot_keep_a_partial_map() {
    let fixture = Fixture::new();
    let path = fixture.file("map.bsp", &bsp(&[]));
    let bad = fixture.file("bad.bsp", b"bad");
    unsafe {
        let c = bh_create();
        let mut s = BhState::default();
        assert_eq!(bh_state(c, &mut s), 0);
        assert_eq!(bh_reset(ptr::null_mut()), 0);
        assert_eq!(bh_load_map(c, path.as_ptr(), ptr::null()), 1);
        let mut settings = BhSettings::default();
        settings.gravity = f32::NAN;
        assert_eq!(bh_set_settings(c, &settings), 0);
        settings = BhSettings::default();
        settings.physics = 0;
        assert_eq!(bh_set_settings(c, &settings), 0);
        assert_eq!(bh_set_settings(c, ptr::null()), 0);
        assert_eq!(bh_set_velocity(c, f32::INFINITY, 0.0, 0.0), 0);
        assert_eq!(
            bh_step(
                c,
                &BhCmd {
                    yaw: f32::NAN,
                    ..BhCmd::default()
                },
                &mut s
            ),
            0
        );
        assert_eq!(bh_step(c, &BhCmd::default(), ptr::null_mut()), 0);
        assert_eq!(bh_state(c, &mut s), 1);
        assert_eq!(s.tick, 0);
        assert_eq!(bh_load_map(c, bad.as_ptr(), ptr::null()), 0);
        assert!(!CStr::from_ptr(bh_last_error(c)).to_bytes().is_empty());
        assert_eq!(bh_state(c, &mut s), 0);
        let mut count = 999;
        assert!(bh_vertices(c, &mut count).is_null());
        assert_eq!(count, 0);
        assert_eq!(bh_load_map(c, path.as_ptr(), ptr::null()), 1);
        assert_eq!(bh_load_map(c, ptr::null(), ptr::null()), 0);
        assert_eq!(bh_state(c, &mut s), 0);
        bh_destroy(c);
        bh_destroy(ptr::null_mut());
        bh_default_settings(ptr::null_mut());
    }
}
fn zip_files(files: &[(&str, &[u8])]) -> Vec<u8> {
    use std::io::{Cursor, Write};
    let mut z = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        z.start_file(
            *name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
        z.write_all(bytes).unwrap();
    }
    z.finish().unwrap().into_inner()
}
fn ground_bsp(pak: &[u8]) -> Vec<u8> {
    let mut bytes = bsp(pak);
    let offset = |index: usize| {
        let at = 8 + 16 * index;
        i32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize
    };
    let brush = offset(18);
    let side = offset(19);
    integer(&mut bytes, brush + 8, 1);
    bytes[side + 2..side + 4].copy_from_slice(&0i16.to_le_bytes());
    bytes
}

fn check_surface_replay(ctx: *mut BhContext, fixture: &Fixture, command: BhCmd, expected: BhState) {
    unsafe {
        let map = (*ctx).map.as_ref().unwrap();
        let settings = styles::settings("autohop").unwrap();
        let header = serde_json::json!({
            "map": "map", "mapSha256": map.map_sha256,
            "settings": recording::settings_json(settings), "prespeedCap": null,
            "timerRules": 2, "spawn": null, "style": "autohop", "zones": [],
            "clientBuild": "native/surface-proof", "player": "proof", "recordedAt": 0.0,
            "checkpointInterval": 100
        });
        let data = recording::ReplayData {
            options: BhRecordOptionsV29::default(),
            header,
            commands: vec![command; 100],
            looks: vec![None; 100],
            checkpoints: vec![recording::Checkpoint {
                tick: 100,
                position: expected.position,
                velocity: expected.velocity,
            }],
            start_tick: 1,
            end_tick: 100,
            track: 0,
            cosmetic: vec![],
            inspect: vec![],
            packed_loadout: None,
        };
        let path = fixture.file("surface.bhr", &data.encode_raw().unwrap());
        let ghost = bh_ghost_load(ctx, path.as_ptr());
        assert!(
            ghost > 0,
            "{}",
            CStr::from_ptr(bh_last_error(ctx)).to_string_lossy()
        );
        let mut frame = BhGhostFrame::default();
        assert_eq!(bh_ghost_frame(ctx, ghost, 100, &mut frame), 1);
        assert_eq!(
            frame.position.map(f32::to_bits),
            expected.position.map(f32::to_bits)
        );
        assert_eq!(
            frame.velocity.map(f32::to_bits),
            expected.velocity.map(f32::to_bits)
        );
        assert_eq!(bh_replay_load(ctx, path.as_ptr()), 1);
        let mut replay = BhSnapshot::default();
        assert_eq!(bh_replay_seek(ctx, 100, &mut replay), 1);
        state_equal(replay.player, expected);
    }
}

#[test]
fn render_materials_do_not_change_replay_physics() {
    let fixture = Fixture::new();
    let material = br#"LightmappedGeneric { "$surfaceprop" "gravel" }"#;
    fixture.file("materials/fixture/test.vmt", material);
    let path = fixture.file("map.bsp", &ground_bsp(&[]));
    let pak = zip_files(&[("materials/fixture/test.vmt", material)]);
    let packed = fixture.file("packed.bsp", &ground_bsp(&pak));
    let root = fixture.root();
    unsafe {
        let canonical = bh_create();
        let rendered = bh_create();
        let embedded = bh_create();
        assert_eq!(bh_load_map(canonical, path.as_ptr(), ptr::null()), 1);
        assert_eq!(bh_load_map(rendered, path.as_ptr(), root.as_ptr()), 1);
        assert_eq!(bh_load_map(embedded, packed.as_ptr(), root.as_ptr()), 1);
        let mut settings = BhSettings::default();
        assert_eq!(bh_style_settings(c"autohop".as_ptr(), &mut settings), 1);
        for ctx in [canonical, rendered, embedded] {
            assert_eq!(bh_set_settings(ctx, &settings), 1);
            assert_eq!(bh_reset(ctx), 1);
        }
        let command = BhCmd {
            forward: 450.0,
            ..BhCmd::default()
        };
        let mut differs = false;
        let mut expected = BhState::default();
        for _ in 0..100 {
            let mut actual = BhState::default();
            let mut packed_state = BhState::default();
            assert_eq!(bh_step(canonical, &command, &mut expected), 1);
            assert_eq!(bh_step(rendered, &command, &mut actual), 1);
            assert_eq!(bh_step(embedded, &command, &mut packed_state), 1);
            state_equal(expected, actual);
            differs |=
                packed_state.velocity.map(f32::to_bits) != expected.velocity.map(f32::to_bits);
        }
        assert!(
            differs,
            "embedded BSP surface properties must still affect movement"
        );
        check_surface_replay(rendered, &fixture, command, expected);
        for ctx in [canonical, rendered, embedded] {
            bh_destroy(ctx);
        }
    }
}

#[test]
fn loose_dependencies_decode_rgba8_and_pak_has_precedence() {
    let fixture = Fixture::new();
    fixture.file(
        "materials/fixture/base.vmt",
        br#"LightmappedGeneric { "$basetexture" "fixture/color" "$surfaceprop" "ice" }"#,
    );
    fixture.file(
        "materials/fixture/test.vmt",
        br#"patch { "include" "materials/fixture/base.vmt" }"#,
    );
    let vtf = content::write_vtf_rgb888(
        2,
        2,
        &[255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255],
        false,
    );
    fixture.file("materials/fixture/color.vtf", &vtf);
    let root = fixture.root();
    let path = fixture.file("map.bsp", &bsp(&[]));
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, path.as_ptr(), root.as_ptr()), 1);
        let mut count = 0;
        let mats = bh_materials(c, &mut count);
        assert_eq!(count, 1);
        assert_eq!((*mats).kind, materials::Kind::Textured as u32);
        let mut image = BhImage::default();
        assert_eq!(bh_texture(c, (*mats).texture as u32, &mut image), 1);
        assert_eq!((image.width, image.height, image.byte_count), (2, 2, 16));
        assert_eq!(
            std::slice::from_raw_parts(image.rgba, 16),
            &[
                255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255
            ]
        );
        assert_eq!(bh_texture(c, 999, &mut image), 0);
        assert!(image.rgba.is_null());
        let pak = zip_files(&[(
            "materials/fixture/test.vmt",
            br#"UnlitGeneric { "$color" "[0.25 0.5 0.75]" }"#,
        )]);
        let packed = fixture.file("packed.bsp", &bsp(&pak));
        assert_eq!(bh_load_map(c, packed.as_ptr(), root.as_ptr()), 1);
        let mats = bh_materials(c, &mut count);
        assert_eq!((*mats).kind, materials::Kind::Flat as u32);
        assert_eq!((*mats).color, [0.25, 0.5, 0.75]);
        bh_destroy(c);
    }
    assert!(read_loose(&fixture.0, "../map.bsp").is_none());
    assert!(read_loose(&fixture.0, "/etc/passwd").is_none());
}
#[test]
fn caught_panic_discards_context_map_and_keeps_context_usable() {
    let fixture = Fixture::new();
    let path = fixture.file("map.bsp", &bsp(&[]));
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, path.as_ptr(), ptr::null()), 1);
        assert_eq!(call(c, |_| panic!("test panic")), 0);
        assert!((*c).map.is_none());
        assert!(
            CStr::from_ptr(bh_last_error(c))
                .to_str()
                .unwrap()
                .contains("panic")
        );
        assert_eq!(bh_set_settings(c, &BhSettings::default()), 1);
        assert!(CStr::from_ptr(bh_last_error(c)).to_bytes().is_empty());
        bh_destroy(c);
    }
}

#[test]
fn loose_prop_collision_uses_the_same_core_content_loader() {
    let fixture = Fixture::new();
    let mut bytes = bsp(&[]);
    lump(
        &mut bytes,
        0,
        0,
        br#"{"classname" "worldspawn"}
{"classname" "info_player_start" "origin" "10 20 100"}
{"classname" "prop_dynamic" "model" "models/fixture/box.mdl" "solid" "2" "origin" "10 20 0"}"#,
    );
    let mut mdl = vec![0; 128];
    mdl[..4].copy_from_slice(b"IDST");
    for at in [104, 108, 112] {
        float(&mut mdl, at, -32.0);
    }
    for at in [116, 120] {
        float(&mut mdl, at, 32.0);
    }
    float(&mut mdl, 124, 64.0);
    fixture.file("models/fixture/box.mdl", &mdl);
    let path = fixture.file("map.bsp", &bytes);
    let root = fixture.root();
    unsafe {
        let loaded = bh_create();
        let missing = bh_create();
        assert_eq!(bh_load_map(loaded, path.as_ptr(), root.as_ptr()), 1);
        assert_eq!(bh_load_map(missing, path.as_ptr(), ptr::null()), 1);
        assert!(
            (*loaded)
                .map
                .as_ref()
                .unwrap()
                .game
                .missing_prop_models()
                .is_empty()
        );
        assert_eq!(
            (*missing).map.as_ref().unwrap().game.missing_prop_models(),
            &["models/fixture/box.mdl"]
        );
        let mut with = BhState::default();
        let mut without = BhState::default();
        for _ in 0..40 {
            assert_eq!(bh_step(loaded, &BhCmd::default(), &mut with), 1);
            assert_eq!(bh_step(missing, &BhCmd::default(), &mut without), 1);
        }
        assert_eq!(with.grounded, 1);
        assert!(with.position[2] >= 64.0 && with.position[2] < 65.0);
        assert_eq!(without.grounded, 0);
        assert!(without.position[2] < with.position[2]);
        bh_destroy(loaded);
        bh_destroy(missing);
    }
}

#[test]
fn snapshot_entities_sha_and_run_abi_layouts() {
    assert_eq!(size_of::<BhSnapshot>(), 132);
    assert_eq!(offset_of!(BhSnapshot, stamina_ms), 88);
    assert_eq!(size_of::<BhZone>(), 36);
    assert_eq!(size_of::<BhRunOptions>(), 20);
    assert_eq!(size_of::<BhRunState>(), 112);
    let fixture = Fixture::new();
    let path = fixture.file("map.bsp", &bsp(&[]));
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, path.as_ptr(), ptr::null()), 1);
        let mut n = 0;
        let entities = bh_entities_json(c, &mut n);
        assert!(!entities.is_null());
        let parsed: serde_json::Value =
            serde_json::from_slice(std::slice::from_raw_parts(entities.cast::<u8>(), n)).unwrap();
        assert_eq!(parsed[0]["classname"], "worldspawn");
        let models = bh_models_json(c, &mut n);
        assert!(!models.is_null());
        let parsed: serde_json::Value =
            serde_json::from_slice(std::slice::from_raw_parts(models.cast::<u8>(), n)).unwrap();
        assert_eq!(parsed.as_array().unwrap().len(), 1);
        let mut snapshot = BhSnapshot::default();
        assert_eq!(bh_snapshot(c, &mut snapshot), 1);
        assert_eq!(snapshot.stamina_ms, 0.0);
        assert_eq!(snapshot.health, 100.0);
        let bytes = bh_snapshot_bytes(c, &mut n);
        assert_eq!(
            std::slice::from_raw_parts(bytes, n),
            (*c).map.as_ref().unwrap().game.snapshot_bytes()
        );
        let mut hash = [0 as c_char; 65];
        assert_eq!(bh_sha256(b"abc".as_ptr(), 3, hash.as_mut_ptr()), 1);
        assert_eq!(
            CStr::from_ptr(hash.as_ptr()).to_str().unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(bh_sha256(ptr::null(), 1, hash.as_mut_ptr()), 0);
        assert_eq!(bh_sha256(ptr::null(), 0, hash.as_mut_ptr()), 1);
        assert_eq!(
            CStr::from_ptr(hash.as_ptr()).to_str().unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        bh_destroy(c);
    }
}
fn timer_zones() -> [BhZone; 2] {
    [
        BhZone {
            kind: 0,
            mins: [-100.0, -100.0, -10000.0],
            maxs: [100.0, 100.0, 1000.0],
            ..BhZone::default()
        },
        BhZone {
            kind: 1,
            mins: [150.0, -100.0, -10000.0],
            maxs: [1000.0, 100.0, 1000.0],
            ..BhZone::default()
        },
    ]
}
fn prop_fixture(fixture: &Fixture) -> CString {
    let mut bytes = bsp(&[]);
    lump(
        &mut bytes,
        0,
        0,
        br#"{"classname" "worldspawn"}
{"classname" "info_player_start" "origin" "10 20 100"}
{"classname" "prop_dynamic" "model" "models/fixture/box.mdl" "solid" "2" "origin" "10 20 0"}"#,
    );
    let mut mdl = vec![0; 128];
    mdl[..4].copy_from_slice(b"IDST");
    for at in [104, 108, 112] {
        float(&mut mdl, at, -32.0);
    }
    for at in [116, 120] {
        float(&mut mdl, at, 32.0);
    }
    float(&mut mdl, 124, 64.0);
    fixture.file("models/fixture/box.mdl", &mdl);
    fixture.file("map.bsp", &bytes)
}
#[test]
fn no_evidence_recording_exports_frozen_bhr_and_all_versions_match_shared_encoder() {
    let fixture = Fixture::new();
    let path = prop_fixture(&fixture);
    let root = fixture.root();
    let zones = timer_zones();
    let mut outputs = Vec::new();
    for (case, physics, rules, style, restart, names, version) in [
        ("v4", 1, 1, "autohop", false, false, 4),
        ("v5", 1, 1, "autohop", true, true, 5),
        ("v6", 13, 1, "autohop", true, false, 6),
        ("v7", 13, 2, "autohop", true, false, 7),
        ("v9-scroll", 13, 2, "scroll", true, false, 9),
        ("v9-lowgrav", 13, 2, "lowgrav", true, false, 9),
    ] {
        unsafe {
            let c = bh_create();
            let mut settings = BhSettings {
                physics,
                ..BhSettings::default()
            };
            if style == "scroll" {
                settings.stamina = 1;
                settings.autohop = 0;
                settings.max_speed = 250.0;
                settings.air_accelerate = 100.0;
            }
            if style == "lowgrav" {
                settings.gravity = 400.0;
            }
            assert_eq!(bh_set_settings(c, &settings), 1);
            assert_eq!(bh_load_map(c, path.as_ptr(), root.as_ptr()), 1);
            let mut options = BhRunOptions {
                rules,
                ..BhRunOptions::default()
            };
            if style == "scroll" {
                options.cap_enabled = 0;
                options.block_prehops = 1;
            }
            assert_eq!(
                bh_run_configure(c, &options, zones.as_ptr(), zones.len()),
                1
            );
            assert_eq!(bh_reset(c), 1);
            if restart {
                assert_eq!(bh_set_position(c, 10.0, 20.0, 65.0, 0.0), 1);
            }
            if names {
                assert_eq!(
                    bh_set_restart_names(c, c"rúnner".as_ptr(), c"player".as_ptr()),
                    1
                );
            }
            assert_eq!(bh_record_identity(c, c"bunnyhop-native/test".as_ptr()), 1);
            let style_c = CString::new(style).unwrap();
            assert_eq!(
                bh_record_begin(c, ptr::null(), style_c.as_ptr(), c"tést".as_ptr(), 7),
                1
            );
            assert_eq!(
                bh_record_loadout(c, c"2;knife-carrot;fin-garden;glove-knit".as_ptr()),
                1
            );
            assert_eq!(bh_record_inspect(c, 3), 1);
            assert_eq!(bh_record_inspect(c, 1), 1);
            let mut state = BhState::default();
            let mut run = BhRunState::default();
            let mut observations = Vec::new();
            for _ in 0..40 {
                assert_eq!(bh_step(c, &BhCmd::default(), &mut state), 1);
                let mut observation = BhJumpObservation::default();
                assert_eq!(bh_jump_observation(c, &mut observation), 1);
                observations.push(observation);
            }
            assert_eq!(bh_record_cosmetic(c, 1), 1);
            assert_eq!(bh_record_inspect(c, 2), 1);
            assert_eq!(bh_record_inspect(c, 4), 1);
            for i in 0..1000 {
                let cmd = BhCmd {
                    forward: 450.0,
                    yaw: if i % 2 == 0 { 0.0 } else { -0.0 },
                    buttons: game::IN_JUMP,
                    ..BhCmd::default()
                };
                assert_eq!(bh_step(c, &cmd, &mut state), 1);
                let mut observation = BhJumpObservation::default();
                assert_eq!(bh_jump_observation(c, &mut observation), 1);
                observations.push(observation);
                assert_eq!(bh_run_state(c, &mut run), 1);
                if run.status == 2 {
                    break;
                }
            }
            assert_eq!(run.status, 2, "{case}: {state:?}");
            let finished_tick = state.tick;
            assert_eq!(bh_record_end(c), 1);
            let output = fixture.0.join(format!("{case}.bhr"));
            let output_c = CString::new(output.to_str().unwrap()).unwrap();
            // Continued play changes Game, but the completed replay remains frozen at its finish tick.
            assert_eq!(bh_step(c, &BhCmd::default(), &mut state), 1);
            assert!(state.tick > finished_tick);
            assert_eq!(
                bh_record_write_bhr(c, output_c.as_ptr()),
                1,
                "{}",
                CStr::from_ptr(bh_last_error(c)).to_string_lossy()
            );
            let library = bh_create();
            let mut header_size = 0;
            let header = bh_replay_header(library, output_c.as_ptr(), &mut header_size);
            assert!(!header.is_null());
            let header: serde_json::Value =
                serde_json::from_slice(std::slice::from_raw_parts(header.cast(), header_size))
                    .unwrap();
            assert_eq!(header["totalTicks"], finished_tick);
            assert!((*library).map.is_none());
            bh_destroy(library);
            let mut raw = Vec::new();
            std::io::Read::read_to_end(
                &mut flate2::read::GzDecoder::new(std::fs::File::open(&output).unwrap()),
                &mut raw,
            )
            .unwrap();
            assert_eq!(&raw[..4], b"BHRP");
            assert_eq!(u16::from_le_bytes(raw[4..6].try_into().unwrap()), version);
            assert_eq!(bh_record_write_bhr(c, output_c.as_ptr()), 0); // Never overwrite an existing replay.
            let mut hash = 0;
            assert_eq!(
                bh_record_fold(c, run::HASH_SEED, 0, finished_tick as usize, &mut hash),
                1
            );
            assert_eq!(hash, (*c).map.as_ref().unwrap().record_hash);
            assert_eq!(bh_record_fold(c, run::HASH_SEED, 10, 5, &mut hash), 0);
            let live = (*c).map.as_ref().unwrap().game.snapshot_bytes();
            let ghost = crate::replay::bh_ghost_load(c, output_c.as_ptr());
            assert!(
                ghost > 0,
                "{}",
                CStr::from_ptr(bh_last_error(c)).to_string_lossy()
            );
            assert_eq!(live, (*c).map.as_ref().unwrap().game.snapshot_bytes());
            let mut frame = BhGhostFrame::default();
            assert_eq!(
                crate::replay::bh_ghost_frame(c, ghost, finished_tick, &mut frame),
                1
            );
            assert_eq!(frame.tick, finished_tick);
            let mut size = 0;
            let ghost_info = crate::replay::bh_ghost_info(c, ghost, &mut size);
            let info: serde_json::Value = serde_json::from_slice(
                std::slice::from_raw_parts(ghost_info.cast(), size)).unwrap();
            assert_eq!(info["timeMs"], (*c).map.as_ref().unwrap().timer.as_ref().unwrap().time_ms());
            let mut events = BhReplayEvents::default();
            assert_eq!(bh_ghost_events(c, ghost, 0, 40, &mut events), 1);
            assert_eq!(
                events,
                BhReplayEvents {
                    cosmetic: 1,
                    inspect_signal: 2,
                    inspect_held: 0
                }
            );
            assert_eq!(bh_ghost_events(c, ghost, 40, 20, &mut events), 1);
            assert_eq!(
                events,
                BhReplayEvents {
                    cosmetic: 0,
                    inspect_signal: 0,
                    inspect_held: 1
                }
            );
            assert_eq!(crate::replay::bh_ghost_free(c, ghost), 1);
            assert_eq!(crate::replay::bh_replay_load(c, output_c.as_ptr()), 1);
            assert_eq!(bh_replay_events(c, 0, 40, &mut events), 1);
            assert_eq!(
                events,
                BhReplayEvents {
                    cosmetic: 1,
                    inspect_signal: 2,
                    inspect_held: 0
                }
            );
            let mut playback = BhSnapshot::default();
            assert_eq!(
                crate::replay::bh_replay_seek(c, finished_tick, &mut playback),
                1
            );
            assert_eq!(
                playback.player.position.map(f32::to_bits),
                frame.position.map(f32::to_bits)
            );
            assert_eq!(
                playback.player.velocity.map(f32::to_bits),
                frame.velocity.map(f32::to_bits)
            );
            assert_eq!(crate::replay::bh_replay_seek(c, 0, &mut playback), 1);
            let mut observation = BhJumpObservation::default();
            assert_eq!(bh_jump_observation(c, &mut observation), 1);
            assert_eq!(observation.valid, 0);
            for expected in &observations {
                assert_eq!(crate::replay::bh_replay_step(c, &mut playback), 1);
                assert_eq!(bh_jump_observation(c, &mut observation), 1);
                state_equal(observation.pre, expected.pre);
                state_equal(observation.post, expected.post);
                assert_eq!(observation.valid, expected.valid, "{case}: clean observation replay drift");
                assert_ne!(observation.epoch, expected.epoch, "seek must fence movement history");
                assert_eq!(observation.command.forward.to_bits(), expected.command.forward.to_bits());
                assert_eq!(observation.command.buttons, expected.command.buttons);
            }
            assert_eq!(crate::replay::bh_replay_seek(c, 0, &mut playback), 1);
            assert_eq!(crate::replay::bh_replay_step(c, &mut playback), 1);
            assert_eq!(playback.player.tick, 1);
            assert_eq!(bh_replay_stop(c), 1);
            assert_eq!(bh_replay_step(c, &mut playback), 0);
            // The decoder rejects truncated command columns and excessive allocation requests.
            let decoded = replay::Decoded::parse(&raw).unwrap();
            assert_eq!(
                decoded.cosmetic,
                vec![replay::CosmeticEvent { tick: 40, kind: 1 }]
            );
            assert_eq!(decoded.inspect.len(), 4);
            assert!(serde_json::from_slice::<serde_json::Value>(decoded.info.as_bytes()).unwrap()["packedLoadout"].as_str().is_some());
            for len in [0, 4, 8, raw.len() / 3] {
                assert!(replay::Decoded::parse(&raw[..len]).is_err());
            }
            // Broken optional presentation data is discarded, preserving playable movement.
            let mut malformed = raw[..raw.len() - 12].to_vec();
            malformed.pop();
            assert!(
                replay::Decoded::parse(&malformed)
                    .unwrap()
                    .inspect
                    .is_empty()
            );
            outputs.push(output);
            bh_destroy(c);
        }
    }
    if std::process::Command::new("bun")
        .arg("--version")
        .output()
        .is_ok()
    {
        let oracle = Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/check-bhr.ts");
        let output = std::process::Command::new("bun")
            .arg(oracle)
            .args(outputs)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    } else {
        eprintln!("skipping external shared encoder oracle: bun is not installed");
    }
}
#[test]
fn record_mutation_and_cap_cannot_export_invalid_runs() {
    let fixture = Fixture::new();
    let path = fixture.file("map.bsp", &bsp(&[]));
    let zones = timer_zones();
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, path.as_ptr(), ptr::null()), 1);
        let options = BhRunOptions {
            rules: 1,
            ..BhRunOptions::default()
        };
        assert_eq!(bh_run_configure(c, &options, zones.as_ptr(), 2), 1);
        assert_eq!(
            bh_record_begin(
                c,
                c"".as_ptr(),
                c"unknown-style".as_ptr(),
                c"test".as_ptr(),
                100
            ),
            0
        );
        assert_eq!(
            bh_record_begin(c, c"".as_ptr(), c"autohop".as_ptr(), c"test".as_ptr(), 100),
            1
        );
        let mut s = BhState::default();
        assert_eq!(
            bh_step(
                c,
                &BhCmd {
                    forward: 0.25,
                    ..BhCmd::default()
                },
                &mut s
            ),
            0
        );
        assert_eq!((*c).map.as_ref().unwrap().game.tick, 0);
        assert_eq!(bh_step(c, &BhCmd::default(), &mut s), 1);
        assert_eq!(bh_set_velocity(c, 1.0, 0.0, 0.0), 1);
        let mut run = BhRunState::default();
        assert_eq!(bh_run_state(c, &mut run), 1);
        assert_eq!((run.recording, run.recording_valid), (0, 0));
        let output = CString::new(fixture.0.join("invalid.bhr").to_str().unwrap()).unwrap();
        assert_eq!(bh_record_write_bhr(c, output.as_ptr()), 0);
        assert_eq!(bh_reset(c), 1);
        assert_eq!(
            bh_record_begin(c, ptr::null(), c"autohop".as_ptr(), c"test".as_ptr(), 100),
            1
        );
        for _ in 0..recording::MAX_COMMANDS {
            assert_eq!(bh_step(c, &BhCmd::default(), &mut s), 1);
        }
        assert_eq!(bh_run_state(c, &mut run), 1);
        assert_eq!(
            (run.recording, run.recording_valid, run.total_commands),
            (0, 0, recording::MAX_COMMANDS)
        );
        let mut n = 0;
        let summary = bh_record_summary_json(c, &mut n);
        let summary: serde_json::Value =
            serde_json::from_slice(std::slice::from_raw_parts(summary.cast::<u8>(), n)).unwrap();
        assert_eq!(summary["reason"], "command_limit");
        assert_eq!(bh_record_write_bhr(c, output.as_ptr()), 0);
        bh_destroy(c);
    }
}

#[test]
fn counted_telemetry_matches_shared_recorder_rebases_and_decoder() {
    use serde_json::json;
    let fixture = Fixture::new();
    let mut sources = Vec::new();
    for (case, stamina, missing, negative, version) in [
        ("counted8", false, false, false, 8),
        ("counted9", true, false, false, 9),
        ("missing", false, true, false, 7),
        ("rawnegative", false, false, true, 7),
        ("turns8", false, false, false, 8),
        ("turns10", false, false, false, 10),
        ("turns10-stamina", true, false, false, 10),
        ("fractional-no-turns", false, false, false, 7),
    ] {
        let settings = if stamina {
            styles::settings("scroll").unwrap()
        } else {
            BhSettings::default()
        };
        let zones = timer_zones();
        let header = json!({"map":"test","mapSha256":"00".repeat(32),"settings":recording::settings_json(settings),"prespeedCap":290.0,"timerRules":2,"spawn":null,"style":if stamina{"scroll"}else{"autohop"},"zones":zones.iter().map(|z|z.json()).collect::<Vec<_>>(),"clientBuild":"native/count-proof","player":"proof","recordedAt":0.0,"checkpointInterval":100,"startTick":1,"endTick":150,"track":0});
        let mut commands = Vec::new();
        let mut looks = Vec::new();
        for i in 0..150 {
            let mut l = BhLookSampleV2 {
                base: if i < 70 { 350.125 } else { 17.0 },
                k: 0.022,
                count: f64::from(if i < 70 { i * 3 } else { (i - 70) * 7 }),
                epoch: u32::from(i >= 70),
                kind: if i < 70 { 1 } else { 2 },
                frames: 1,
                events: 2,
                reports: if i == 15 { 99999 } else { 8 },
            };
            if case.contains("10") || case == "fractional-no-turns" {
                l.count += 0.5;
            }
            let turn = case.starts_with("turns") && i >= 20 && i < 40;
            if turn {
                l.base += f64::from(i - 19) * 210.0 * f64::from(settings.tick_interval);
                l.epoch = i as u32;
                l.kind = if i == 25 {
                    5 | 128
                } else if i == 30 {
                    2 | 128
                } else {
                    6
                };
            }
            let yaw = if i == 12 {
                123.45
            } else if negative && i == 13 {
                -17.0
            } else {
                look::yaw(l.base, l.count, l.k)
            };
            commands.push(BhCmd {
                forward: 450.0,
                side: if i % 2 == 0 { 450.0 } else { -450.0 },
                yaw,
                pitch: i as f32 / 9.0,
                buttons: ((i as u32) << 16) | 2 | if turn { 1 << 7 } else { 0 },
            });
            looks.push(if missing && i == 23 { None } else { Some(l) });
        }
        let data = recording::ReplayData {
            options: BhRecordOptionsV29::default(),
            header: header.clone(),
            commands: commands.clone(),
            looks: looks.clone(),
            checkpoints: vec![],
            start_tick: 1,
            end_tick: 150,
            track: 0,
            cosmetic: vec![],
            inspect: vec![],
            packed_loadout: None,
        };
        let path = fixture.0.join(format!("{case}.bhr"));
        data.write_bhr(&path).unwrap();
        let decoded = replay::Decoded::load(&path).unwrap();
        assert_eq!(decoded.commands.len(), commands.len());
        for (a, b) in decoded.commands.iter().zip(&commands) {
            assert_eq!(
                (
                    a.forward.to_bits(),
                    a.side.to_bits(),
                    a.yaw.to_bits(),
                    a.pitch.to_bits(),
                    a.buttons
                ),
                (
                    b.forward.to_bits(),
                    b.side.to_bits(),
                    b.yaw.to_bits(),
                    b.pitch.to_bits(),
                    b.buttons
                )
            );
        }
        let commands=commands.iter().map(|c|json!({"forward":c.forward,"side":c.side,"yaw":c.yaw,"pitch":c.pitch,"buttons":c.buttons})).collect::<Vec<_>>();
        let looks=looks.iter().map(|l|l.map(|l|json!({"base":l.base,"k":l.k,"count":l.count,"epoch":l.epoch,"kind":l.kind,"frames":l.frames,"events":l.events,"reports":l.reports}))).collect::<Vec<_>>();
        let source = fixture.0.join(format!("{case}.json"));
        std::fs::write(&source,json!({"path":path,"header":header,"commands":commands,"looks":looks,"checkpoints":[],"version":version}).to_string()).unwrap();
        sources.push(source);
    }
    if std::process::Command::new("bun")
        .arg("--version")
        .output()
        .is_ok()
    {
        let out = std::process::Command::new("bun")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/check-counted.ts"))
            .args(sources)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
#[test]
fn practice_checkpoints_restore_the_native_timer_style_and_world() {
    let fixture = Fixture::new();
    let path = prop_fixture(&fixture);
    let root = fixture.root();
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, path.as_ptr(), root.as_ptr()), 1);
        assert_eq!(bh_style_set(c, c"autostrafe".as_ptr()), 1);
        let zones = timer_zones();
        assert_eq!(
            bh_run_configure(c, &BhRunOptions::default(), zones.as_ptr(), zones.len()),
            1
        );
        let cmd = BhCmd {
            forward: 450.0,
            yaw: 17.25,
            buttons: 2,
            ..BhCmd::default()
        };
        let mut state = BhState::default();
        for _ in 0..20 {
            assert_eq!(bh_step(c, &cmd, &mut state), 1);
        }
        let handle = bh_practice_save(c, 17.25, -14.0);
        assert!(handle > 0);
        let mut expected = Vec::new();
        for i in 0..60 {
            let cmd = BhCmd {
                yaw: 17.25 + i as f32 * 1.25,
                ..cmd
            };
            assert_eq!(bh_step(c, &cmd, &mut state), 1);
            let m = (*c).map.as_ref().unwrap();
            expected.push((m.game.snapshot_bytes(), m.timer.as_ref().unwrap().json()));
        }
        let mut snapshot = BhSnapshot::default();
        let mut view = BhCmd::default();
        assert_eq!(bh_style_set(c, c"scroll".as_ptr()), 1);
        assert_eq!(bh_practice_restore(c, handle, &mut view, &mut snapshot), 1);
        assert_eq!((view.yaw, view.pitch), (17.25, -14.0));
        assert_eq!((*c).style_id, "autostrafe");
        assert_eq!((*c).settings.autohop, 1);
        for (i, (bytes, timer)) in expected.iter().enumerate() {
            let cmd = BhCmd {
                yaw: 17.25 + i as f32 * 1.25,
                ..cmd
            };
            assert_eq!(bh_step(c, &cmd, &mut state), 1);
            let m = (*c).map.as_ref().unwrap();
            assert_eq!(&m.game.snapshot_bytes(), bytes);
            assert_eq!(&m.timer.as_ref().unwrap().json(), timer);
        }
        assert_eq!(bh_practice_free(c, handle), 1);
        assert_eq!(bh_practice_restore(c, handle, &mut view, &mut snapshot), 0);
        assert_eq!(bh_reset(c), 1);
        assert_eq!(
            bh_record_begin(
                c,
                ptr::null(),
                c"autostrafe".as_ptr(),
                c"test".as_ptr(),
                100
            ),
            1
        );
        let noclip = BhNoclipState {
            position: [1.0, 2.0, 100.0],
            velocity: [3.0, 4.0, 5.0],
        };
        assert_eq!(bh_practice_noclip_tick(c, &noclip, &mut snapshot), 1);
        assert_eq!(snapshot.player.tick, 1);
        assert_eq!(snapshot.player.position, [1.0, 2.0, 100.0]);
        let mut run = BhRunState::default();
        assert_eq!(bh_run_state(c, &mut run), 1);
        assert_eq!((run.recording, run.recording_valid), (0, 0));
        assert_eq!(
            bh_practice_noclip_exit(c, &noclip, 0.0, 0.0, &mut snapshot),
            1
        );
        let mut fraction = 0.0;
        assert_eq!(
            bh_trace_camera(
                c,
                [100.0, 100.0, 100.0].as_ptr(),
                [101.0, 100.0, 100.0].as_ptr(),
                0.0,
                &mut fraction
            ),
            1
        );
        assert_eq!(fraction, 1.0);
        bh_destroy(c);
    }
}
#[test]
fn practice_flight_matches_shared_noclip_vectors() {
    if std::process::Command::new("bun")
        .arg("--version")
        .output()
        .is_err()
    {
        return;
    }
    let out = std::process::Command::new("bun")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/practice-vectors.ts"))
        .output()
        .unwrap();
    assert!(out.status.success());
    let cases: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    for c in cases.as_array().unwrap() {
        let vector =
            |s: &serde_json::Value, k: &str| std::array::from_fn(|i| s[k][i].as_f64().unwrap());
        let mut state = BhNoclipState {
            position: vector(&c["initial"], "position"),
            velocity: vector(&c["initial"], "velocity"),
        };
        for row in c["rows"].as_array().unwrap() {
            let r = &row["cmd"];
            let cmd = BhCmd {
                forward: r["forward"].as_f64().unwrap() as f32,
                side: r["side"].as_f64().unwrap() as f32,
                yaw: r["yaw"].as_f64().unwrap() as f32,
                pitch: r["pitch"].as_f64().unwrap() as f32,
                buttons: r["buttons"].as_u64().unwrap() as u32,
            };
            assert_eq!(
                unsafe { bh_noclip_move(&mut state, &cmd, c["dt"].as_f64().unwrap()) },
                1
            );
            for (a, b) in state.position.iter().chain(&state.velocity).zip(
                vector(&row["expected"], "position")
                    .into_iter()
                    .chain(vector(&row["expected"], "velocity")),
            ) {
                assert!((a - b).abs() < 1e-8, "{a} != {b}");
            }
        }
    }
}

#[test]
fn renderer_metadata_queries_preserve_authoritative_simulation() {
    let fixture = Fixture::new();
    let path = prop_fixture(&fixture);
    let root = fixture.root();
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, path.as_ptr(), root.as_ptr()), 1);
        let before = (*c).map.as_ref().unwrap().game.snapshot_bytes();
        let mut count = 0;
        let names = assets::bh_material_names_json(c, &mut count);
        assert!(!names.is_null());
        let names: Vec<String> =
            serde_json::from_slice(std::slice::from_raw_parts(names.cast(), count)).unwrap();
        let mut materials = 0;
        bh_materials(c, &mut materials);
        assert_eq!(names.len(), materials);
        assert!(names.contains(&"fixture/test".to_string()));
        let mut extras = 0;
        bh_material_extras(c, &mut extras);
        assert_eq!(materials, extras);
        let water = bh_water_json(c, &mut count);
        let water: serde_json::Value =
            serde_json::from_slice(std::slice::from_raw_parts(water.cast(), count)).unwrap();
        assert!(water["volumes"].is_array());
        assert!(water["planes"].is_array());
        let overlay = assets::bh_overlay_json(c, &mut count);
        assert!(!overlay.is_null());
        assert!(
            serde_json::from_slice::<serde_json::Value>(std::slice::from_raw_parts(
                overlay.cast(),
                count
            ))
            .unwrap()
            .is_array()
        );
        let entities = (*c).map.as_ref().unwrap().game.entities.len();
        assets::bh_overlay_states(c, &mut count);
        assert_eq!(entities, count);
        assets::bh_floor_weapons(c, &mut count);
        let mut probe = BhSurfaceProbe::default();
        assert_eq!(bh_surface_at(c, 10.0, 10.0, 1.0, &mut probe), 1);
        assert_eq!(probe.surface, 0);
        assert_eq!(probe.ground_z, 0.0);
        assert!(probe.material >= 0);
        assert!(probe.water_z.is_nan());
        assert_eq!(bh_surface_at(c, 100.0, 100.0, 100.0, &mut probe), 1);
        assert_eq!(probe.surface, -1);
        assert!(probe.ground_z.is_nan());
        let mut report = BhWeaponReport::default();
        assert_eq!(assets::bh_weapon_report(c, &mut report), 1);
        assert_eq!(report.active, 1);
        assert_eq!(assets::bh_studio_load(c, c"models/missing.mdl".as_ptr()), 0);
        assert_eq!(before, (*c).map.as_ref().unwrap().game.snapshot_bytes());
        bh_destroy(c);
    }
}

#[test]
fn surface_grid_uses_shared_classification_and_water_height_rules() {
    let bsp = bunnyhop_core::parse_bsp(&bsp(&[])).unwrap();
    let mut mesh = mesh::build(&bsp);
    let mut materials = materials::resolve(&physics::map_vfs(&bsp), &["fixture/test".into()]);
    for (name, expected) in [
        ("metal/rustwood", 1),
        ("wood/crate", 2),
        ("nature/snow", 3),
        ("tile/glass", 4),
        ("water/liquid", 5),
        ("tools/clip", -1),
    ] {
        mesh.materials[0].name = name.into();
        let grid = surfaces::Grid::build(&mesh, &materials);
        let probe = grid.at([10.0, 10.0, 1.0]);
        if expected == 5 {
            assert_eq!(probe.surface, -1);
            assert_eq!(probe.water_z, 0.0);
        } else {
            assert_eq!(probe.surface, expected);
        }
    }
    mesh.materials[0].name = "arbitrary/test".into();
    materials.descs[0].kind = materials::Kind::Water;
    let grid = surfaces::Grid::build(&mesh, &materials);
    assert_eq!(grid.at([10.0, 10.0, -1000.0]).water_z, 0.0);
    assert!(grid.at([10.0, 10.0, 100.0]).water_z.is_nan());
    assert!(grid.at([10.0, 10.0, -3000.0]).water_z.is_nan());
}

#[test]
fn clearing_replay_timer_leaves_local_simulation_usable() {
    let fixture = Fixture::new();
    let path = fixture.file("local.bsp", &bsp(&[]));
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, path.as_ptr(), ptr::null()), 1);
        let zones = timer_zones();
        assert_eq!(
            bh_run_configure(c, &BhRunOptions::default(), zones.as_ptr(), zones.len()),
            1
        );
        assert_eq!(
            bh_record_begin(c, ptr::null(), c"autohop".as_ptr(), c"test".as_ptr(), 100),
            1
        );
        assert_eq!(bh_run_clear(c), 1);
        let mut run = BhRunState::default();
        assert_eq!(bh_run_state(c, &mut run), 0);
        assert!(!(*c).map.as_ref().unwrap().record_valid);
        assert!((*c).map.as_ref().unwrap().recorder.is_none());
        let mut state = BhState::default();
        assert_eq!(bh_step(c, &BhCmd::default(), &mut state), 1);
        assert_eq!(state.tick, 1);
        bh_destroy(c);
    }
}

#[test]
fn practice_save_is_harmless_and_noclip_stops_the_timer_without_recording() {
    let fixture = Fixture::new();
    let path = prop_fixture(&fixture);
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, path.as_ptr(), fixture.root().as_ptr()), 1);
        let zones = timer_zones();
        assert_eq!(
            bh_run_configure(c, &BhRunOptions::default(), zones.as_ptr(), zones.len()),
            1
        );
        assert_eq!(
            bh_record_begin(
                c,
                ptr::null(),
                c"autohop".as_ptr(),
                c"practice-test".as_ptr(),
                100
            ),
            1
        );
        let cmd = BhCmd {
            forward: 450.0,
            yaw: 0.0,
            ..BhCmd::default()
        };
        let mut state = BhState::default();
        assert_eq!(bh_step(c, &cmd, &mut state), 1);
        let (bytes, timer, hash, commands) = {
            let m = (*c).map.as_ref().unwrap();
            (
                m.game.snapshot_bytes(),
                m.timer.as_ref().unwrap().json(),
                m.record_hash,
                m.recorded_commands,
            )
        };
        let handle = bh_practice_save(c, 10.0, 15.0);
        assert!(handle > 0);
        {
            let m = (*c).map.as_ref().unwrap();
            assert_eq!(m.game.snapshot_bytes(), bytes);
            assert_eq!(m.timer.as_ref().unwrap().json(), timer);
            assert_eq!((m.record_hash, m.recorded_commands), (hash, commands));
            assert!(m.recorder.is_some() && m.record_valid);
        }
        // Simulate an already-running attempt; noclip stops its timer, so the
        // clock neither runs nor finishes while flying through the end volume.
        {
            let m = (*c).map.as_mut().unwrap();
            let t = m.timer.as_mut().unwrap();
            t.state.status = 1;
            t.state.start_tick = 0;
            t.state.jumps = 7;
            t.state.strafes = 9;
        }
        assert_eq!(bh_practice_enter(c, 1), 1);
        let flight = BhNoclipState {
            position: [200.0, 0.0, 100.0],
            velocity: [1.0, 2.0, 3.0],
        };
        let mut snapshot = BhSnapshot::default();
        for _ in 0..25 {
            assert_eq!(bh_practice_noclip_tick(c, &flight, &mut snapshot), 1);
        }
        let mut run = BhRunState::default();
        assert_eq!(bh_run_state(c, &mut run), 1);
        assert_eq!(
            (run.status, run.jumps, run.strafes, run.split_count),
            (0, 0, 0, 0)
        );
        assert_eq!(
            (run.recording, run.recording_valid, run.total_commands),
            (0, 0, commands)
        );
        assert_eq!(run.seconds, 0.0);
        // Restoring the harmless save is a mutation: timer/world/view restore,
        // while recording remains invalid and can never become a completed BHR.
        let mut view = BhCmd::default();
        assert_eq!(bh_practice_restore(c, handle, &mut view, &mut snapshot), 1);
        assert_eq!((view.yaw, view.pitch), (10.0, 15.0));
        assert_eq!(bh_run_state(c, &mut run), 1);
        assert_eq!(run.recording_valid, 0);
        assert_eq!((*c).map.as_ref().unwrap().game.snapshot_bytes(), bytes);
        let bhr = fixture.file("practice.bhr", &[]);
        assert_eq!(bh_record_write_bhr(c, bhr.as_ptr()), 0);
        // Restart starts fresh; this is the only native host transition which
        // clears practice policy and begins another clean recording.
        assert_eq!(bh_reset(c), 1);
        assert_eq!(
            bh_record_begin(c, ptr::null(), c"autohop".as_ptr(), c"clean".as_ptr(), 100),
            1
        );
        assert_eq!(bh_run_state(c, &mut run), 1);
        assert_eq!(
            (run.recording, run.recording_valid, run.total_commands),
            (1, 1, 0)
        );
        assert_eq!(bh_practice_enter(c, 1), 1); // idle timer must not arm in flight
        for _ in 0..5 {
            assert_eq!(bh_practice_noclip_tick(c, &flight, &mut snapshot), 1);
        }
        assert_eq!(bh_run_state(c, &mut run), 1);
        assert_eq!((run.status, run.in_start, run.seconds), (0, 0, 0.0));
        // Handles belong to a single map; replacing the map destroys them.
        assert_eq!(bh_load_map(c, path.as_ptr(), fixture.root().as_ptr()), 1);
        assert_eq!(bh_practice_restore(c, handle, &mut view, &mut snapshot), 0);
        bh_destroy(c);
    }
}

/// Native ABI integration: actual shots/ammo/state, independent of renderer effects.
#[test]
fn native_guns_fire_consume_ammo_reload_and_obey_trigger_cadence() {
    use bunnyhop_core::game::GUNS;
    let fixture = Fixture::new();
    let path = fixture.file("weapons.bsp", &bsp(&[]));
    unsafe {
        let c = bh_create();
        let settings = BhSettings { gravity: 0.0, ..BhSettings::default() };
        assert_eq!(bh_set_settings(c, &settings), 1);
        assert_eq!(bh_load_map(c, path.as_ptr(), ptr::null()), 1);
        for gun in GUNS {
            assert_eq!(bh_reset(c), 1);
            let mut state = BhState::default();
            let step = |buttons, state: &mut BhState| {
                assert_eq!(bh_step(c, &BhCmd { buttons, ..BhCmd::default() }, state), 1);
            };
            step(u32::from(gun.id) << 16, &mut state);
            for _ in 0..150 { step(0, &mut state); }
            let mut report = BhWeaponReport::default();
            assert_eq!(assets::bh_weapon_report(c, &mut report), 1);
            assert_eq!((report.active, report.clip, report.clip_size), (u32::from(gun.id), u32::from(gun.clip), u32::from(gun.clip)), "{} given", gun.name);
            let mut shots: Vec<i32> = Vec::new();
            for tick in 0..250 {
                step(1, &mut state);
                let mut attack = BhAttackReport::default();
                let fired = assets::bh_attack_report(c, &mut attack) == 1;
                assert_eq!(fired, state.events & 32 != 0, "{} attack event", gun.name);
                if fired {
                    shots.push(tick);
                    assert_eq!(attack.weapon, u32::from(gun.id));
                    assert!(attack.start.iter().chain(attack.end.iter()).all(|v| v.is_finite()));
                    assert!(attack.start.iter().zip(attack.end).any(|(a,b)| (a-b).abs() > 1.0));
                }
                assert_eq!(assets::bh_weapon_report(c, &mut report), 1);
                assert_eq!(report.clip as usize + shots.len(), gun.clip as usize, "{} ammo", gun.name);
            }
            assert_eq!(shots[0], 0, "{} first shot", gun.name);
            if gun.semi { assert_eq!(shots.len(), 1, "{} held pistol", gun.name); }
            else {
                assert!(shots.len() > 1, "{} automatic fire", gun.name);
                let expected = (gun.cycle / settings.tick_interval).ceil() as i32;
                for pair in shots.windows(2) {
                    assert!((pair[1] - pair[0] - expected).abs() <= 1, "{} cadence {:?}", gun.name, shots);
                }
            }
            for _ in 0..150 { step(0, &mut state); }
            step(1 << 13, &mut state);
            assert_eq!(assets::bh_weapon_report(c, &mut report), 1);
            assert!(report.flags & 4 != 0 || report.reload_ticks > 0 || report.clip == u32::from(gun.clip), "{} reload starts or automatic reload already active", gun.name);
            for _ in 0..1200 { step(0, &mut state); }
            assert_eq!(assets::bh_weapon_report(c, &mut report), 1);
            assert_eq!(report.clip, u32::from(gun.clip), "{} refill", gun.name);
            step(1 << 12, &mut state);
            assert_eq!(assets::bh_weapon_report(c, &mut report), 1);
            assert_ne!(report.flags & 32, 0, "{} drop", gun.name);
            assert_eq!(report.active, 1);
        }
        bh_destroy(c);
    }
}

#[test]
fn native_glock_burst_and_usp_silencer_keep_authoritative_state() {
    let fixture = Fixture::new();
    let path = fixture.file("weapon-modes.bsp", &bsp(&[]));
    unsafe {
        let c = bh_create();
        assert_eq!(bh_set_settings(c, &BhSettings { gravity: 0.0, ..BhSettings::default() }), 1);
        assert_eq!(bh_load_map(c, path.as_ptr(), ptr::null()), 1);
        let mut state = BhState::default();
        let step = |buttons, state: &mut BhState| assert_eq!(bh_step(c, &BhCmd { buttons, ..BhCmd::default() }, state), 1);
        step(2 << 16, &mut state);
        for _ in 0..150 { step(0, &mut state); }
        step(1 << 11, &mut state);
        for _ in 0..60 { step(0, &mut state); }
        let mut shots = Vec::new();
        for tick in 0..150 {
            step(1, &mut state);
            let mut attack = BhAttackReport::default();
            if assets::bh_attack_report(c, &mut attack) == 1 { shots.push(tick); assert_eq!(attack.weapon, 2); }
        }
        assert_eq!(shots, vec![0,6,12], "held Glock is exactly one measured burst");
        let mut report = BhWeaponReport::default();
        assert_eq!(assets::bh_weapon_report(c, &mut report), 1);
        assert_eq!((report.clip, report.burst), (17,1));
        assert_eq!(bh_reset(c), 1);
        step(3 << 16, &mut state);
        for _ in 0..150 { step(0, &mut state); }
        step(1 << 11, &mut state);
        assert_eq!(assets::bh_weapon_report(c, &mut report), 1);
        assert_eq!(report.silencer, 1);
        assert!(report.silencer_ticks > 300);
        for _ in 0..300 {
            step(1, &mut state);
            let mut attack = BhAttackReport::default();
            assert_eq!(assets::bh_attack_report(c, &mut attack), 0, "attachment blocks fire");
        }
        for _ in 0..30 { step(0, &mut state); }
        step(1, &mut state);
        let mut attack = BhAttackReport::default();
        assert_eq!(assets::bh_attack_report(c, &mut attack), 1);
        assert_eq!((attack.weapon,attack.mode),(3,2));
        assert_eq!(bh_reset(c), 1);
        step((3 << 16) | (1 << 21) | (1 << 22), &mut state);
        for _ in 0..2 { step(0, &mut state); }
        assert_eq!(assets::bh_weapon_report(c, &mut report), 1);
        assert_eq!((report.active,report.silencer,report.silencer_ticks),(3,1,0));
        bh_destroy(c);
    }
}

#[test]
fn clean_jump_observation_real_flat_jump_wall_and_mutation_fences() {
    let map = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../maps/bhop_eazy.bsp");
    if !map.is_file() { eprintln!("bhop_eazy map is unavailable; skipping external map observation regression"); return; }
    unsafe {
        let c = bh_create();
        let path = CString::new(map.to_str().unwrap()).unwrap();
        assert_eq!(bh_load_map(c, path.as_ptr(), ptr::null()), 1);
        let mut state = BhState::default();
        let mut observation = BhJumpObservation::default();
        for wall in [false, true] {
            assert_eq!(bh_reset(c), 1);
            let mut jumped = false;
            let mut dirty_air = false;
            let mut clean_landing = false;
            let mut flight = false;
            for i in 0..130 {
                let cmd = BhCmd { forward: if i >= 15 {450.0} else {0.0}, yaw: if wall {180.0} else {0.0},
                    buttons: if i == if wall {25} else {50} {2} else {0}, ..BhCmd::default() };
                let mut pre = BhState::default();
                assert_eq!(bh_state(c, &mut pre), 1);
                assert_eq!(bh_step(c, &cmd, &mut state), 1);
                let bytes = (*c).map.as_ref().unwrap().game.snapshot_bytes();
                assert_eq!(bh_jump_observation(c, &mut observation), 1);
                assert_eq!(bytes, (*c).map.as_ref().unwrap().game.snapshot_bytes(), "telemetry must not change canonical bytes");
                state_equal(observation.pre, pre);
                state_equal(observation.post, state);
                assert_eq!(observation.valid, u32::from((*c).map.as_ref().unwrap().game.jumpstats_valid));
                if state.events & 2 != 0 { jumped = true; flight = true; assert_eq!(observation.valid, 1); }
                if flight && state.grounded == 0 && state.events & (1|8) == 0 && observation.valid == 0 {dirty_air = true;}
                if flight && state.events & 4 != 0 { clean_landing = !dirty_air && observation.valid == 1;flight = false; }
            }
            assert!(jumped);
            if wall {assert!(dirty_air);assert!(!clean_landing);} else {assert!(!dirty_air);assert!(clean_landing);}
        }
        let epoch = observation.epoch;
        assert_eq!(bh_set_velocity(c, 1.0, 0.0, 0.0), 1);
        assert_eq!(bh_jump_observation(c, &mut observation), 1);
        assert_eq!(observation.valid, 0);assert_ne!(observation.epoch, epoch);
        assert_eq!(bh_reset(c), 1);
        let zones = [
            BhZone { kind: 0, mins: [-100000.0;3], maxs: [100000.0;3], ..BhZone::default() },
            BhZone { kind: 1, mins: [200000.0;3], maxs: [200100.0;3], ..BhZone::default() },
        ];
        assert_eq!(bh_run_configure(c, &BhRunOptions { prespeed_cap:200.0, ..BhRunOptions::default() }, zones.as_ptr(), zones.len()), 1);
        for _ in 0..50 {assert_eq!(bh_step(c, &BhCmd::default(), &mut state), 1);}
        assert_eq!(state.grounded, 1);
        assert_eq!(bh_set_velocity(c, 500.0, 0.0, 0.0), 1);
        assert_eq!(bh_step(c, &BhCmd {buttons:2, ..BhCmd::default()}, &mut state), 1);
        let mut run = BhRunState::default();assert_eq!(bh_run_state(c, &mut run), 1);
        assert_ne!(run.update_flags & 8, 0, "exercise a real timer prespeed clamp");
        assert!((*c).map.as_ref().unwrap().game.jumpstats_valid, "movement itself was clean");
        assert_eq!(bh_jump_observation(c, &mut observation), 1);
        assert_eq!(observation.valid, 0, "timer clamp must invalidate the observational flight");
        assert_eq!(bh_reset(c), 1);
        let mut settings = BhSettings::default();settings.gravity=400.0;
        assert_eq!(bh_set_settings(c, &settings), 1);
        for _ in 0..10 {assert_eq!(bh_step(c, &BhCmd::default(), &mut state), 1);assert_eq!(bh_jump_observation(c, &mut observation), 1);assert_eq!(observation.valid, 0);}
        bh_destroy(c);
    }
}
