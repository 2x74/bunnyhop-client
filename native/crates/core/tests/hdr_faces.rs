//! HDR-only compiles (empty LDR lighting lump) keep their real lightmap offsets and styles only in the HDR face lump;
//! the LDR face lump has every face at offset 0 with styles 0. The atlas must follow the HDR faces (maps are gitignored;
//! each skips when absent).

use bunnyhop_core::lightmap;
use playsrc_bsp::{Face, LumpData, TextureInfo};

fn faces(bsp: &playsrc_bsp::Bsp, index: usize) -> &[Face] {
    match bsp.lump(index).map(|l| &l.records) {
        Some(LumpData::Faces(v)) => v.as_slice(),
        _ => &[],
    }
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn hdr_only_maps_use_the_hdr_face_lump() {
    for name in ["bhop_2_S4RO", "bhop_alt_jestas", "bhop_dust_temple", "bhop_mourning"] {
        let path = bunnyhop_core::test_maps::bsp(name);
        let Ok(bytes) = std::fs::read(&path) else {
            eprintln!("skipping {name}: {} not found", path.display());
            continue;
        };
        let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
        let ldr = faces(&bsp, playsrc_bsp::FACES);
        let hdr = faces(&bsp, playsrc_bsp::FACES_HDR);
        assert_eq!(ldr.len(), hdr.len(), "{name}: face lumps");
        assert!(ldr.iter().all(|f| f.light_offset == 0), "{name}: expected an HDR-only compile");
        let texinfo: &[TextureInfo] = match bsp.lump(playsrc_bsp::TEXINFO).map(|l| &l.records) {
            Some(LumpData::TextureInfo(v)) => v.as_slice(),
            _ => &[],
        };
        let built = lightmap::build(&bsp, ldr, texinfo);
        assert!(built.atlas.hdr, "{name}: HDR atlas");
        let mut blocks = 0;
        for (fi, rect) in built.rects.iter().enumerate() {
            if rect.is_some() {
                blocks += 1;
                assert!(hdr[fi].light_offset >= 0 && hdr[fi].styles[0] != 255, "{name}: face {fi} is unlit in the HDR faces");
            }
        }
        // Distinct HDR offsets: the faces don't all read the first face's luxels.
        let offsets: std::collections::HashSet<i32> =
            built.rects.iter().enumerate().filter(|(_, r)| r.is_some()).map(|(fi, _)| hdr[fi].light_offset).collect();
        assert!(blocks > 100 && offsets.len() == blocks, "{name}: {blocks} blocks, {} distinct offsets", offsets.len());
    }
}
