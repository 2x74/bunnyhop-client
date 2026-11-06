//! Print exact-build qualification keys for the full or stripped Crash Egypt BSP.
use bunnyhop_core::game::{map_build_digest_v25, map_build_v26_for, map_entity_fingerprint};
fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "maps/bhop_crash_egypt.bsp".into());
    let raw = std::fs::read(&path).unwrap();
    let bsp = bunnyhop_core::parse_bsp(&raw).unwrap();
    let entities = bunnyhop_core::physics::entity_list_with_outputs(&bsp, true);
    println!(
        "{path}: crc {:08x}, digest {}, qualified {:?}",
        map_entity_fingerprint(&entities.entities),
        map_build_digest_v25(&bsp, &entities),
        map_build_v26_for(&bsp, &entities)
    );
}
