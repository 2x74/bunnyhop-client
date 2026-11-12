//! Physics v25: the 1-hop block teleporter prefab on bhop_hellopro2 and bhop_4triedsame (v0.0.37 hard maps;
//! map_fixes.rs MECHANICS_V25 / MAKERS_V25, research/maps-v37/hard-maps.md). The prefab, on the real map entities:
//! a block's trigger fires `filter_*` TestActivator on touch; the filter named after the player's targetname spawns
//! `teleporter_N` at the player (env_entity_maker ForceSpawnAtEntityOrigin, 4 s life) and renames them N+1 at 0.09 s;
//! a live teleporter whose multifilter passes the new name renames them `tele`, and the teleport above the block
//! (filtered on `tele`) sends them back to the level start. So a player can't stand on a block, or land on the same
//! spot again within 4 s. Before v25 these builds never ran the makers (v24 and older are unchanged). Only the exact
//! reviewed builds (`BUILDS_V25` digest: entities, outputs, brush collision) get any of it.

use bunnyhop_core::game::{map_build_digest_v25, map_build_v25_for, map_entity_fingerprint, PHYSICS_V19, PHYSICS_V24, PHYSICS_V25};
use bunnyhop_core::{Cmd, Game, Settings};
use std::path::PathBuf;

fn load(name: &str, version: u32) -> Option<Game> {
    let path = bunnyhop_core::test_maps::bsp(name);
    if !path.exists() {
        eprintln!("skipping: {} not present", path.display());
        return None;
    }
    let mut game = bunnyhop_core::content::load_game(&path).unwrap();
    game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
    game.reset();
    Some(game)
}

fn idle(game: &mut Game, ticks: usize) {
    for _ in 0..ticks {
        game.step(Cmd { forward: 0.0, side: 0.0, yaw: 90.0, pitch: 0.0, buttons: 0 }).unwrap();
    }
}

fn near(a: [f32; 3], b: [f32; 3], r: f32) -> bool {
    (a[0] - b[0]).hypot(a[1] - b[1]) < r && (a[2] - b[2]).abs() < 40.0
}

struct Prefab {
    map: &'static str,
    fingerprint: u32,
    /// Where the player gets the prefab's starting name `tped` (a reset trigger, 0.4 s).
    named_at: [f32; 3],
    /// Top of one prefab block (feet), and where its teleport sends a failing player.
    block: [f32; 3],
    back_to: [f32; 3],
    /// Open air off the blocks and outside every trigger, where the player is held while they wait.
    away: [f32; 3],
}

const HELLOPRO2: Prefab = Prefab {
    map: "bhop_hellopro2",
    fingerprint: 0x86b9ed90,
    named_at: [-2048.0, -5248.0, 81.0], // spawn room, reset_trigger *13
    block: [-2048.0, -4864.0, 81.0],    // block *16 (bhop_trigger) under bhop_teleport *14 -> tp_001
    back_to: [-2048.0, -5248.0, 81.0],  // tp_001
    away: [-2048.0, -4720.0, 300.0],
};

const TRIEDSAME: Prefab = Prefab {
    map: "bhop_4triedsame",
    fingerprint: 0x0c832785,
    named_at: [7872.0, 7872.0, -9776.0], // escapism stage start, esc_reset_trigger *719
    block: [7734.0, 8416.0, -9070.0],    // block *626 under the teleport_filter teleport *728 -> escapism_stage
    back_to: [7872.0, 7848.0, -9788.0],  // escapism_stage
    away: [7872.0, 8100.0, -9400.0],
};

fn named(map: &Prefab, version: u32) -> Option<Game> {
    let mut g = load(map.map, version)?;
    g.set_position(map.named_at, 90.0);
    idle(&mut g, 60);
    assert_eq!(g.player_name, "tped", "{} v{version}: the reset trigger names the player", map.map);
    Some(g)
}

fn bytes(map: &str) -> Option<Vec<u8>> {
    let path = bunnyhop_core::test_maps::bsp(map);
    std::fs::read(path).ok()
}

/// The reviewed-build key of raw BSP bytes, as the full loader and the verifier's parse see it.
fn build_of(raw: &[u8]) -> (Option<&'static str>, Option<&'static str>, String) {
    let bsp = bunnyhop_core::parse_bsp(raw).unwrap();
    let full = bunnyhop_core::physics::entity_list_with_outputs(&bsp, true);
    let verifier = bunnyhop_core::physics::entity_list_with_outputs(&bsp, false);
    (map_build_v25_for(&bsp, &full), map_build_v25_for(&bsp, &verifier), map_build_digest_v25(&bsp, &full))
}

/// Byte range of lump `index` in an uncompressed BSP v20 file.
fn lump_range(raw: &[u8], index: usize) -> std::ops::Range<usize> {
    let at = 8 + index * 16;
    let ofs = i32::from_le_bytes(raw[at..at + 4].try_into().unwrap()) as usize;
    let len = i32::from_le_bytes(raw[at + 4..at + 8].try_into().unwrap()) as usize;
    ofs..ofs + len
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn builds_are_the_reviewed_ones() {
    for m in [HELLOPRO2, TRIEDSAME] {
        let Some(raw) = bytes(m.map) else { continue };
        let (full, verifier, digest) = build_of(&raw);
        eprintln!("{} digest {digest}", m.map);
        assert_eq!(full, Some(m.map), "{}: the full parse matches its BUILDS_V25 digest", m.map);
        assert_eq!(verifier, Some(m.map), "{}: so does the verifier's parse (no output pairs)", m.map);
        let g = load(m.map, PHYSICS_V25).unwrap();
        assert_eq!(map_entity_fingerprint(&g.entities), m.fingerprint, "{}", m.map);
        assert_eq!(g.reviewed_build_v25(), Some(m.map));
    }
    // 4triedsame keeps its v19 record; hellopro2 has none outside BUILDS_V25.
    if let Some(g) = load(TRIEDSAME.map, PHYSICS_V25) { assert_eq!(bunnyhop_core::game::map_mechanics_v19_for(&g.entities), Some(TRIEDSAME.map)); }
    if let Some(g) = load(HELLOPRO2.map, PHYSICS_V25) { assert_eq!(bunnyhop_core::game::map_mechanics_v19_for(&g.entities), None); }
}

/// A rebuild that keeps every non-output key (same entity CRC) but changes an output, the collision or a packed physics
/// material is not the reviewed build: no v25 mechanics, standing on a block does nothing.
#[cfg_attr(ci, ignore = "map library")]
#[test]
fn modified_builds_get_no_v25_mechanics() {
    let Some(raw) = bytes(HELLOPRO2.map) else { return };
    let ents = lump_range(&raw, 0);
    assert_ne!(&raw[ents.start..ents.start + 4], b"LZMA", "hellopro2's entity lump is plain text");
    let text = String::from_utf8_lossy(&raw[ents.clone()]).into_owned();
    let mut cases: Vec<(&str, Vec<u8>)> = Vec::new();
    // The teleporters' life: OnUser1 !self,Kill after 5 s instead of 4 (same length, same entity CRC).
    let at = ents.start + text.find("!self,Kill,,4,-1").expect("teleporter kill output");
    let mut out = raw.clone();
    out[at + 12] = b'5';
    cases.push(("output delay", out));
    // A non-output key: one teleporter's wait 0 -> 1.
    let at = ents.start + text.find("\"wait\" \"0\"").expect("a wait key");
    let mut key = raw.clone();
    key[at + 9] = b'1';
    cases.push(("entity key", key));
    // Collision: the last plane's distance, lowest mantissa bit.
    let planes = lump_range(&raw, 1);
    let mut geo = raw.clone();
    geo[planes.end - 4] ^= 1;
    cases.push(("brush collision", geo));
    // A packed physics material: oaho_grass_07.vmt (6 world faces) `$surfaceprop grass` -> `ice` (padded to the same
    // length in the stored zip entry; its CRC fixed in the local and central headers): friction 0.1 instead of default.
    cases.push(("packed material surfaceprop", repack_vmt(&raw, b"$surfaceprop grass", b"$surfaceprop ice  ")));
    for (what, bsp) in cases {
        let (full, verifier, _) = build_of(&bsp);
        assert_eq!((full, verifier), (None, None), "{what}: not the reviewed build");
        if what == "entity key" { continue; } // a different CRC: the plain v19 lookup misses too
        let parsed = bunnyhop_core::parse_bsp(&bsp).unwrap();
        let mut g = Game::load(&parsed).unwrap();
        g.set_settings(Settings { physics_version: PHYSICS_V25, ..Settings::css_bhop() });
        g.reset();
        assert_eq!(map_entity_fingerprint(&g.entities), HELLOPRO2.fingerprint, "{what}: same entity CRC");
        assert_eq!(g.reviewed_build_v25(), None, "{what}");
        g.set_position(HELLOPRO2.named_at, 90.0);
        idle(&mut g, 60);
        g.place_player(HELLOPRO2.block);
        idle(&mut g, 60);
        assert!(near(g.state.position, HELLOPRO2.block, 8.0), "{what}: no maker, the player stays on the block");
    }
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 { crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 }; }
    }
    !crc
}

/// Replace `from` with `to` (same length) inside the one stored pakfile entry that contains it, fixing the entry's
/// CRC-32 in its local header and its central directory record.
fn repack_vmt(raw: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    assert_eq!(from.len(), to.len());
    let pak = lump_range(raw, 40);
    let mut out = raw.to_vec();
    let find = |hay: &[u8], needle: &[u8]| hay.windows(needle.len()).position(|w| w == needle);
    let at = pak.start + find(&raw[pak.clone()], from).expect("material text in the pak");
    // The local header that owns it: the last `PK\x03\x04` before it.
    let local = pak.start + raw[pak.start..at].windows(4).rposition(|w| w == b"PK\x03\x04").unwrap();
    let u16_at = |o: usize| u16::from_le_bytes(raw[o..o + 2].try_into().unwrap()) as usize;
    let u32_at = |o: usize| u32::from_le_bytes(raw[o..o + 4].try_into().unwrap()) as usize;
    assert_eq!(u16_at(local + 8), 0, "stored entry");
    let (size, name_len, extra_len) = (u32_at(local + 18), u16_at(local + 26), u16_at(local + 28));
    let name = raw[local + 30..local + 30 + name_len].to_vec();
    let data = local + 30 + name_len + extra_len;
    assert!(at >= data && at + from.len() <= data + size);
    out[at..at + to.len()].copy_from_slice(to);
    let crc = crc32(&out[data..data + size]).to_le_bytes();
    out[local + 14..local + 18].copy_from_slice(&crc);
    // Its central directory record (`PK\x01\x02`, name at +46).
    let mut o = pak.start;
    while let Some(k) = find(&raw[o..pak.end], b"PK\x01\x02") {
        let c = o + k;
        let n = u16_at(c + 28);
        if raw[c + 46..c + 46 + n] == name[..] { out[c + 16..c + 20].copy_from_slice(&crc); return out; }
        o = c + 4;
    }
    panic!("no central directory record");
}

/// The digest covers what the core reads from materials: the movement surface each `$surfaceprop` resolves to
/// (`physics::SURFACE_PROPS`). grass -> metal is `default` either way, so it is still the reviewed build.
#[cfg_attr(ci, ignore = "map library")]
#[test]
fn material_edits_without_a_physics_change_keep_the_build() {
    let Some(raw) = bytes(HELLOPRO2.map) else { return };
    let (full, verifier, _) = build_of(&repack_vmt(&raw, b"$surfaceprop grass", b"$surfaceprop metal"));
    assert_eq!((full, verifier), (Some(HELLOPRO2.map), Some(HELLOPRO2.map)));
}

/// The verifier loads the stripped physics BSP (apps/api/src/bsp-strip.ts): set HARD_MAPS_PHYS_DIR to a directory of
/// `<map>.phys.bsp` files (made with stripBspForPhysics) to check it gets the same build key.
#[test]
fn stripped_physics_bsps_match_too() {
    let Some(dir) = std::env::var_os("HARD_MAPS_PHYS_DIR") else { return };
    for m in [HELLOPRO2, TRIEDSAME] {
        let raw = std::fs::read(PathBuf::from(&dir).join(format!("{}.phys.bsp", m.map))).unwrap();
        let (full, verifier, _) = build_of(&raw);
        assert_eq!((full, verifier), (Some(m.map), Some(m.map)), "{} stripped", m.map);
    }
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn standing_on_a_block_sends_the_player_back_from_v25() {
    for m in [HELLOPRO2, TRIEDSAME] {
        let Some(mut g) = named(&m, PHYSICS_V25) else { continue };
        g.place_player(m.block);
        idle(&mut g, 2);
        assert!(near(g.state.position, m.block, 8.0), "{}: on the block", m.map);
        idle(&mut g, 30); // TestActivator 0.01 s, spawn 0.02 s, rename 0.09 s, the teleporter fires: back by 0.45 s
        assert!(near(g.state.position, m.back_to, 64.0), "{}: v25 sends a standing player back, at {:?}", m.map, g.state.position);
        // The teleporter renamed the player `tele`, then `1` 0.2 s later: the next block starts the chain again.
        idle(&mut g, 20);
        assert!(g.player_name == "1" || g.player_name == "tped", "{}: {}", m.map, g.player_name);
    }
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn v24_and_v19_never_run_the_makers() {
    for version in [PHYSICS_V19, PHYSICS_V24] {
        for m in [HELLOPRO2, TRIEDSAME] {
            let Some(mut g) = named(&m, version) else { continue };
            g.place_player(m.block);
            idle(&mut g, 60);
            assert!(near(g.state.position, m.block, 8.0), "{} v{version}: no maker, the player stays", m.map);
        }
    }
}

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn landing_on_the_same_spot_again_fails_within_4_s_only() {
    for m in [HELLOPRO2, TRIEDSAME] {
        for (wait, fails) in [(60usize, true), (450usize, false)] { // 100 tick: 0.6 s and 4.5 s
            let Some(mut g) = named(&m, PHYSICS_V25) else { continue };
            g.place_player(m.block);
            // The spawn lands ~7 ticks (100 tick) after the touch and the rename ~16 (srcds stamps outputs fired in a usercmd with the
            // player's clock, 60 ms ahead: game.rs player_clock_lead). Leave between the two.
            idle(&mut g, 10);
            for _ in 0..wait {
                g.place_player(m.away); // held in the air: renamed 2 at 0.09 s; the teleporter lives 4 s
                idle(&mut g, 1);
            }
            assert_eq!(g.player_name, "2", "{}: renamed by the filter", m.map);
            g.place_player(m.block);
            idle(&mut g, 10); // a live teleporter sends them back by ~6 ticks; standing alone takes ~22
            let sent_back = near(g.state.position, m.back_to, 64.0);
            assert_eq!(sent_back, fails, "{}: back on the spot after {wait} ticks", m.map);
        }
    }
}
