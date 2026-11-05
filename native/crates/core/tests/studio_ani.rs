//! External animation blocks (`.ani`) on a real HL2 model: bhop_cartoons' barney (`prop_dynamic`, DefaultAnim
//! Sit_Chair), whose sequences live in `$includemodel`s (barney_animations, humans/male_shared) with their frames in
//! `.ani` files. Needs a content cache extracted with `tools/content/extract.ts --prop-anims bhop_cartoons` in
//! CONTENT_CACHE_DIR (the hosted files); skips otherwise.

use bunnyhop_core::studio::{self, Load};
use bunnyhop_core::vfs::{Source, Vfs};
use std::collections::HashMap;
use std::rc::Rc;

fn cartoons_vfs() -> Option<Vfs> {
    let cc = std::env::var("CONTENT_CACHE_DIR").ok()?;
    let mut files: HashMap<String, Rc<[u8]>> = HashMap::new();
    for e in std::fs::read_dir(format!("{cc}/content-manifests")).ok()? {
        let text = std::fs::read_to_string(e.ok()?.path()).ok()?;
        if !text.contains("\"map\":\"bhop_cartoons\"") || !text.contains("models/humans/male_shared.ani") {
            continue;
        }
        // "files":{"<path>":{"sha256":"<hex>",...},...}
        let body = &text[text.find("\"files\":{")? + 9..];
        for part in body.split("},\"").take_while(|p| p.contains("\"sha256\":\"")) {
            let p = part.trim_start_matches('"');
            let path = &p[..p.find('"')?];
            let i = p.find("\"sha256\":\"")? + 10;
            files.insert(path.to_string(), std::fs::read(format!("{cc}/content/{}", &p[i..i + 64])).ok()?.into());
        }
        let mut vfs = Vfs::default();
        vfs.mount(Source::loose("content", files));
        return Some(vfs);
    }
    None
}

#[test]
fn barney_sits_from_ani_blocks() {
    let Some(vfs) = cartoons_vfs() else {
        eprintln!("skipping: no CONTENT_CACHE_DIR with bhop_cartoons extracted --prop-anims");
        return;
    };
    let Load::Ready(m) = studio::load(&vfs, "models/barney.mdl") else { panic!("barney loads") };
    assert!(!m.missing_anim_blocks(), "the .ani files load with the model");
    let seq = m.seqs.iter().find(|s| s.name == "Sit_Chair").expect("Sit_Chair");
    let frames = m.decode_anim(seq.anims[0]).expect("Sit_Chair decodes from male_shared.ani");
    let pelvis = m.bones.iter().position(|b| b.name == "ValveBiped.Bip01_Pelvis").unwrap();
    // The pelvis is a child of the root: its local z is its height. Bind pose: standing (~39); sitting: ~21.
    let z = frames[pelvis * 7 + 6];
    let bind = m.bones[pelvis].pos[2];
    assert!(bind > 35.0 && z < 25.0, "pelvis z bind {bind}, Sit_Chair {z}");
}
