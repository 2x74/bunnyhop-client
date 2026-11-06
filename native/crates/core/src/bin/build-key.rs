//! Print exact-build keys for local qualification (no game simulation).
fn main() {
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path).unwrap();
        let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
        let list = bunnyhop_core::physics::entity_list_with_outputs(&bsp, true);
        println!("{} {:08x} {}", path, bunnyhop_core::game::map_entity_fingerprint(&list.entities), bunnyhop_core::game::map_build_digest_v25(&bsp, &list));
    }
}
