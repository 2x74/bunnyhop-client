//! Animated map props and moving textures as the renderer reads them (map_props.rs, map_motion.rs).
use super::*;

/// `bsp(pak)` with its entity lump replaced (appended, the header pointing at it).
fn bsp_with_entities(pak: &[u8], entities: &str) -> Vec<u8> {
    let mut bytes = bsp(pak);
    let offset = bytes.len() as i32;
    let mut text = entities.as_bytes().to_vec();
    text.push(0);
    integer(&mut bytes, 8, offset);
    integer(&mut bytes, 12, text.len() as i32);
    bytes.extend_from_slice(&text);
    bytes
}

/// A 4x4 BGRA8888 VTF 7.2 with one frame per colour.
fn flipbook_vtf(frames: &[[u8; 4]]) -> Vec<u8> {
    let mut b = vec![0u8; 80];
    b[..4].copy_from_slice(b"VTF\0");
    b[4..8].copy_from_slice(&7u32.to_le_bytes());
    b[8..12].copy_from_slice(&2u32.to_le_bytes());
    b[12..16].copy_from_slice(&80u32.to_le_bytes());
    b[16..18].copy_from_slice(&4u16.to_le_bytes());
    b[18..20].copy_from_slice(&4u16.to_le_bytes());
    b[24..26].copy_from_slice(&(frames.len() as u16).to_le_bytes());
    b[48..52].copy_from_slice(&1f32.to_le_bytes());
    b[52..56].copy_from_slice(&12i32.to_le_bytes());
    b[56] = 1;
    b[57..61].copy_from_slice(&(-1i32).to_le_bytes());
    b[63..65].copy_from_slice(&1u16.to_le_bytes());
    for bgra in frames {
        for _ in 0..16 {
            b.extend_from_slice(bgra);
        }
    }
    b
}

const PROP_ENTITIES: &str = r#"{"classname" "worldspawn"}
{"classname" "info_player_start" "origin" "10 20 100" "angles" "0 45 0"}
{"classname" "prop_dynamic" "targetname" "fly" "model" "models/missing.mdl" "DefaultAnim" " idle " "origin" "1 2 3" "angles" "0 90 0"}
{"classname" "prop_dynamic" "targetname" "off" "model" "models/missing.mdl" "DefaultAnim" "spin" "StartDisabled" "1"}
{"classname" "prop_dynamic" "targetname" "still" "model" "models/missing.mdl"}"#;

#[test]
fn lists_animated_props_with_their_states_and_transforms() {
    let fixture = Fixture::new();
    let path = fixture.file("props.bsp", &bsp_with_entities(&[], PROP_ENTITIES));
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, path.as_ptr(), ptr::null()), 1);
        let mut states = [BhPropAnimState::default(); 4];
        assert_eq!(bh_prop_anim_states(c, states.as_mut_ptr(), states.len()), 2);
        assert_eq!(
            states[0],
            BhPropAnimState {
                entity: 2,
                flags: 0,
                base: 0.0,
                since: 0.0,
                rate: 1.0
            }
        );
        assert_eq!(states[1].entity, 3);
        assert_eq!(states[1].flags, game::PROP_ANIM_HIDDEN);
        // Only as many as the buffer holds.
        assert_eq!(bh_prop_anim_states(c, states.as_mut_ptr(), 1), 1);

        let mut names = [0 as c_char; 16];
        assert_eq!(bh_prop_anim_names(c, 0, names.as_mut_ptr(), names.len()), 10);
        let bytes: Vec<u8> = names[..10].iter().map(|&b| b as u8).collect();
        assert_eq!(&bytes, b"idle\0idle\0");
        assert_eq!(bh_prop_anim_names(c, 0, names.as_mut_ptr(), 9), 0);
        assert_eq!(bh_prop_anim_names(c, 5, names.as_mut_ptr(), names.len()), 0);

        let mut transforms = [BhPropTransform::default(); 4];
        assert_eq!(bh_prop_transforms(c, transforms.as_mut_ptr(), transforms.len()), 2);
        assert_eq!(
            transforms[0],
            BhPropTransform {
                entity: 2,
                origin: [1.0, 2.0, 3.0],
                angles: [0.0, 90.0, 0.0],
                visible: 1
            }
        );
        // StartDisabled hides an animated prop by its own flags.
        assert_eq!((transforms[1].entity, transforms[1].visible), (3, 0));
        let mut single = BhTransform::default();
        assert_eq!(bh_prop_transform(c, 3, &mut single), 1);
        assert_eq!(single.visible, 0);

        // Their models are missing: the props have no groups of their own, so nothing poses.
        let mut count = 9;
        bh_animated_props(c, &mut count);
        assert_eq!(count, 0);
        let serial = bh_prop_anim_serial(c);
        assert_eq!(bh_prop_anim_serial(c), serial);
        bh_destroy(c);
    }
}

#[test]
fn reads_texture_proxies_and_hands_over_flipbook_frames() {
    let vmt = br#""UnlitGeneric" { "$basetexture" "fixture/anim" "Proxies" {
        "AnimatedTexture" { "animatedtexturevar" "$basetexture" "animatedtextureframerate" "10" }
        "TextureScroll" { "texturescrollvar" "$basetexturetransform" "texturescrollrate" "0.5" "texturescrollangle" "90" } } }"#;
    let vtf = flipbook_vtf(&[[0, 0, 255, 255], [0, 255, 0, 255], [255, 0, 0, 255]]);
    let pak = zip_files(&[
        ("materials/fixture/test.vmt", vmt),
        ("materials/fixture/anim.vtf", &vtf),
    ]);
    let fixture = Fixture::new();
    let path = fixture.file("motion.bsp", &bsp(&pak));
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, path.as_ptr(), ptr::null()), 1);
        let mut count = 0;
        let motion = bh_material_motion(c, &mut count);
        assert!(count >= 1 && !motion.is_null());
        let first = *motion;
        assert_eq!(
            first,
            BhMaterialMotion {
                scroll_rate: 0.5,
                scroll_angle: 90.0,
                frame_rate: 10.0,
                frames: 3,
                no_wrap: 0
            }
        );
        let texture = (*(*c).map.as_ref().unwrap().material_abi.first().unwrap()).texture;
        let mut image = BhImage::default();
        assert_eq!(bh_texture_frame(c, texture, 1, &mut image), 1);
        assert_eq!((image.width, image.height, image.byte_count), (4, 4, 64));
        // BGRA (0, 255, 0) is green.
        assert_eq!(std::slice::from_raw_parts(image.rgba, 4), &[0, 255, 0, 255]);
        assert_eq!(bh_texture_frame(c, texture, 2, &mut image), 1);
        assert_eq!(std::slice::from_raw_parts(image.rgba, 4), &[0, 0, 255, 255]);
        // Each frame is handed over once; frame 0 is the texture itself.
        assert_eq!(bh_texture_frame(c, texture, 1, &mut image), 0);
        assert_eq!(bh_texture_frame(c, texture, 0, &mut image), 0);
        bh_destroy(c);
    }
}

fn entities_from(pairs_list: &serde_json::Value) -> Vec<bunnyhop_core::entities::Entity> {
    pairs_list
        .as_array()
        .unwrap()
        .iter()
        .map(|pairs| bunnyhop_core::entities::Entity {
            pairs: pairs
                .as_array()
                .unwrap()
                .iter()
                .map(|kv| {
                    (
                        kv[0].as_str().unwrap().to_string(),
                        kv[1].as_str().unwrap().to_string(),
                    )
                })
                .collect(),
        })
        .collect()
}

/// tools/map-props/generate-vectors.ts: the website's hashSeed and the map fingerprint its random animators use.
#[test]
fn seeds_random_animators_like_the_website() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/native/src/map_props_vectors.json");
    let vectors: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    for case in vectors["hashes"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let n = case["n"].as_u64().unwrap() as u32;
        assert_eq!(
            u64::from(crate::map_props::hash_seed(text, n)),
            case["hash"].as_u64().unwrap(),
            "{text}"
        );
    }
    let entities = entities_from(&vectors["entityPairs"]);
    assert_eq!(
        u64::from(crate::map_props::map_seed(&entities)),
        vectors["mapSeed"].as_u64().unwrap()
    );
}

/// The release's golden vectors (apps/web/test/map-props.test.ts): the thumper's map and entity seeds.
#[test]
fn seeds_the_golden_thumper_like_the_release() {
    const GOLDEN_MAP_SEED: u32 = 14_988_861;
    const GOLDEN_SEED: u32 = 2_031_191_778;
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/native/src/map_props_vectors.json");
    let vectors: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let golden = &vectors["golden"];
    let map_seed = crate::map_props::map_seed(&entities_from(&golden["entityPairs"]));
    assert_eq!(map_seed, GOLDEN_MAP_SEED);
    let model = golden["model"].as_str().unwrap();
    let entity = golden["entity"].as_u64().unwrap() as u32;
    assert_eq!(
        crate::map_props::random_animator_seed(model, map_seed, entity),
        GOLDEN_SEED
    );
    assert_eq!(golden["seed"].as_u64(), Some(u64::from(GOLDEN_SEED)));
}

/// A map the native client downloaded: `BH_NATIVE_MAPS` is its maps folder (one folder per BSP with the map and its
/// `content`), e.g. ~/Library/Application Support/bunnyhop.lol/Bunnyhop Native/maps on macOS.
fn downloaded_map(name: &str) -> (CString, CString) {
    let root = std::env::var_os("BH_NATIVE_MAPS")
        .expect("set BH_NATIVE_MAPS to the native client's maps folder");
    let bsp = std::fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().path().join(format!("{name}.bsp")))
        .find(|path| path.is_file())
        .unwrap_or_else(|| panic!("{name} isn't downloaded"));
    let content = bsp.with_file_name("content");
    let text = |path: &Path| CString::new(path.to_str().unwrap()).unwrap();
    (text(&bsp), text(&content))
}

/// Animated props have to come with groups of their own (props::add_game_props), or nothing poses them.
#[test]
#[ignore = "requires a downloaded bhop_ceaseless (BH_NATIVE_MAPS)"]
fn the_butterflies_have_their_own_groups_and_models() {
    const CEASELESS_ANIMATED_PROPS: usize = 14;
    let (bsp, content) = downloaded_map("bhop_ceaseless");
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, bsp.as_ptr(), content.as_ptr()), 1);
        let mut count = 0;
        let props = bh_animated_props(c, &mut count);
        assert_eq!(count, CEASELESS_ANIMATED_PROPS);
        let props = std::slice::from_raw_parts(props, count);
        let m = (*c).map.as_ref().unwrap();
        for prop in props {
            assert_ne!(prop.studio, 0, "entity {}: its model loads", prop.entity);
            assert!(m.game.is_animated_prop(prop.entity as usize));
            assert!(
                m.assets
                    .props
                    .dynamic_groups
                    .iter()
                    .any(|g| g[0] == prop.entity)
            );
        }
        bh_destroy(c);
    }
}

/// RandomAnimation props are animated props since the core tracks them: each one gets its own groups and a seeded
/// random animator instead of its DefaultAnim.
#[test]
#[ignore = "requires a downloaded bhop_shrubhop (BH_NATIVE_MAPS)"]
fn random_animation_props_get_their_animators() {
    const SHRUBHOP_RANDOM_PROPS: usize = 38;
    let (bsp, content) = downloaded_map("bhop_shrubhop");
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, bsp.as_ptr(), content.as_ptr()), 1);
        let mut count = 0;
        let props = std::slice::from_raw_parts(bh_animated_props(c, &mut count), count);
        let random: Vec<&BhAnimatedProp> = props.iter().filter(|p| p.random != 0).collect();
        assert_eq!(random.len(), SHRUBHOP_RANDOM_PROPS);
        let m = (*c).map.as_ref().unwrap();
        let fingerprint = crate::map_props::map_seed(&m.game.entities);
        for prop in random {
            let model = &m.assets.models[prop.studio as usize - 1].path;
            assert_eq!(
                prop.random_seed,
                crate::map_props::random_animator_seed(model, fingerprint, prop.entity)
            );
            assert!(
                prop.min_anim_time <= prop.max_anim_time,
                "entity {}",
                prop.entity
            );
        }
        bh_destroy(c);
    }
}

#[test]
fn render_only_parent_props_keep_their_owner_and_scale() {
    let entities = r#"{"classname" "worldspawn"}
        {"classname" "func_tracktrain" "targetname" "train"}
        {"classname" "prop_dynamic" "parentname" "train" "model" "models/with spaces/tomb.mdl"
         "DefaultAnim" "Hop" "modelscale" "1.5"}
        {"classname" "prop_dynamic" "parentname" "train" "model" "models/hidden.mdl" "rendermode" "10"}"#;
    let fixture = Fixture::new();
    let path = fixture.file("parents.bsp", &bsp_with_entities(&[], entities));
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, path.as_ptr(), ptr::null()), 1);
        let map = (*c).map.as_ref().unwrap();
        let mut props = bunnyhop_core::props::StaticProps::default();
        bunnyhop_core::props::add_game_props(&mut props, &map.game, true);
        assert!(props.props.is_empty());
        assert_eq!(
            crate::map_props::add_parented_props(&mut props, &map.game),
            vec![2]
        );
        assert_eq!(props.props.len(), 1);
        assert_eq!((props.props[0].owner, props.props[0].scale), (3, 1.5));
        assert_eq!(props.models[0], "models/with spaces/tomb.mdl");
        bh_destroy(c);
    }
}

#[test]
#[ignore = "requires BH_CRASH_EGYPT_BSP pointing at the exact production BSP"]
fn crash_egypt_render_observations_restore_copies_and_train_props() {
    let fixture = Fixture::new();
    let bytes =
        std::fs::read(std::env::var("BH_CRASH_EGYPT_BSP").expect("BH_CRASH_EGYPT_BSP")).unwrap();
    let path = fixture.file("bhop_crash_egypt.bsp", &bytes);
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, path.as_ptr(), ptr::null()), 1);
        let mut count = 0;
        let props = bh_animated_props(c, &mut count);
        let props = std::slice::from_raw_parts(props, count);
        for entity in [1222, 1226, 1231, 1234, 1239] {
            let tomb = props.iter().find(|p| p.entity == entity).unwrap();
            assert_ne!(tomb.studio, 0, "embedded tomb model failed to load");
            assert_eq!(tomb.model_scale, 1.5);
        }
        let material_groups: Vec<_> = (*c)
            .map
            .as_ref()
            .unwrap()
            .assets
            .prop_groups
            .iter()
            .filter(|g| [968, 971, 974].contains(&g.entity))
            .copied()
            .collect();
        assert!(!material_groups.is_empty());
        for group in material_groups {
            let material = (*c).map.as_ref().unwrap().material_abi[group.material as usize];
            assert_ne!(material.kind, 1, "crate material is missing");
            assert!(material.texture >= 0);
            let mut image = BhImage::default();
            assert_eq!(bh_texture(c, material.texture as u32, &mut image), 1);
            assert!(image.width > 8 && image.height > 8);
        }
        let saved = (*c).map.as_ref().unwrap().game.save_state();
        let mut rows = vec![BhEntityInstance::default(); 4096];
        assert_eq!(bh_entity_instances(c, rows.as_mut_ptr(), rows.len()), 0);
        let map = (*c).map.as_mut().unwrap();
        map.game.place_player([96.0, 1408.0, -255.0]);
        for _ in 0..75 {
            map.game.step(Cmd::default()).unwrap();
        }
        let state = map.game.snapshot_bytes();
        let count = bh_entity_instances(c, rows.as_mut_ptr(), rows.len());
        assert!(
            rows[..count]
                .iter()
                .any(|r| r.source == 965 && r.visible == 1)
        );
        assert!(rows[..count].iter().any(|r| r.source == 958));
        assert_eq!((*c).map.as_ref().unwrap().game.snapshot_bytes(), state);
        assert!(!(*c).map.as_ref().unwrap().game.entity_visible(968));
        let moved = (*c)
            .map
            .as_ref()
            .unwrap()
            .game
            .entity_transform(1222)
            .unwrap();
        assert_ne!(moved.0, [-1856.0, 6624.0, 96.0]);
        (*c).map.as_mut().unwrap().game.restore_state(&saved);
        assert_eq!(bh_entity_instances(c, rows.as_mut_ptr(), rows.len()), 0);
        assert!((*c).map.as_ref().unwrap().game.entity_visible(968));
        assert_eq!(
            (*c).map
                .as_ref()
                .unwrap()
                .game
                .entity_transform(1222)
                .unwrap()
                .0,
            [-1856.0, 6624.0, 96.0]
        );
        bh_destroy(c);
    }
}
