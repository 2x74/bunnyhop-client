use playsrc_vtf::{Decoder, Dialect, Face, Limits, SubresourceIdentity};
use std::{fs, path::Path};

#[test]
#[ignore = "requires the original kz_bhop_solitude archive extracted under maps/_archives"]
fn original_solitude_textures_decode_with_source2013_natural_chain() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../maps/_archives/490394_1124394_kz_bhop_solitude_ba310.rar.d/materials/kz_bhop_genkai");
    for filename in ["bhop_single.vtf", "wall.vtf"] {
        let bytes = fs::read(root.join(filename)).unwrap();
        assert_eq!(bytes.len(), 41_184);
        assert_eq!(bytes[56], 10);
        let decoder = Decoder::new(&bytes, Dialect::Source2013Pc, Limits::default()).unwrap();
        let meta = decoder.metadata();
        assert_eq!((meta.width, meta.height, meta.mip_count), (64, 64, 7));
        let id = SubresourceIdentity::HighResolution { mip: 0, frame: 0, face: Face::Right, slice: 0 };
        let base = meta.subresources.iter().find(|s| s.identity == id).unwrap();
        // No three fictitious extra 1x1 DXT5 blocks before the natural chain.
        assert_eq!(base.encoded_range, 1616..5712);
        let plane = decoder.decode(id).unwrap();
        assert_eq!((plane.width, plane.height, plane.samples.len()), (64, 64, 16_384));
        assert_eq!(decoder.decode_high_resolution().unwrap().len(), 7);
    }
}
