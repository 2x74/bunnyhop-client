pub mod content;
pub mod dressing;
pub mod entities;
pub mod fog;
pub mod game;
pub mod lighting;
pub mod lightmap;
pub mod materials;
pub mod mesh;
pub mod prop_light;
pub mod props;
pub mod skybox;
pub mod studio;
pub mod physics;
pub mod vfs;
#[cfg(not(target_arch = "wasm32"))]
#[doc(hidden)]
pub mod test_maps;
#[cfg(any(target_arch = "wasm32", feature = "native-web"))]
mod wasm;

pub use game::{Cmd, Game, Settings};

pub fn parse_bsp(bytes: &[u8]) -> Result<playsrc_bsp::Bsp, String> {
    playsrc_bsp::parse(bytes, playsrc_bsp::Profile::for_source(bytes), bsp_limits()).map_err(|e| format!("bsp: {e:?}"))
}

/// `parse_bsp` taking the file by value: the Bsp keeps it without a copy (the wasm loads hold one copy of the map).
pub fn parse_bsp_owned(bytes: Vec<u8>) -> Result<playsrc_bsp::Bsp, String> {
    let profile = playsrc_bsp::Profile::for_source(&bytes);
    playsrc_bsp::parse_owned(bytes, profile, bsp_limits()).map_err(|e| format!("bsp: {e:?}"))
}

fn bsp_limits() -> playsrc_bsp::Limits {
    // Highly repetitive map lumps (e.g. bhop_wrath ambient indices) exceed 1024:1.
    // Retain per-lump and aggregate decoded-byte limits while permitting up to 4096:1.
    // v19/v20 maps keep the Source 2013 profile; v21 (CS:GO) maps get the CS:GO one.
    playsrc_bsp::Limits { max_compression_ratio: 4_096,
        // Reviewed large originals (Treason 630 MiB, Speed Demon 22.8M RGBExp samples).
        // Geometry records retain the 16M cap; decoded aggregate stays bounded at 1 GiB.
        max_input_bytes: 768 * 1024 * 1024,
        max_encoded_bytes: 768 * 1024 * 1024,
        max_decoded_bytes_per_lump: 768 * 1024 * 1024,
        max_decoded_pak_bytes: 768 * 1024 * 1024,
        max_light_samples: 32 * 1024 * 1024,
        ..Default::default() }
}

#[cfg(all(feature = "native-web", not(target_arch = "wasm32")))]
pub use wasm::native_web;
