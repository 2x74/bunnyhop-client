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
