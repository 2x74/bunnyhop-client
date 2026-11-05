//! bhop_hellopro2 and bhop_4triedsame through native's own map load (the website's checks are crates/core
//! tests/hard_maps_v25.rs). Their 1-hop blocks spawn a teleporter at a player standing on them, which sends the player
//! back to the level start. The core runs those makers from physics 25 on the reviewed builds only, so this checks that
//! native loads the reviewed builds, plays physics 25 by default, and leaves an older physics without them.
use super::*;

struct HardMap {
    name: &'static str,
    /// Where the level's reset trigger names the player `tped`, which the first block's filter expects.
    named_at: [f32; 3],
    /// Top of one block, and where its teleport sends a player who stays on it.
    block: [f32; 3],
    back_to: [f32; 3],
}

const HELLOPRO2: HardMap = HardMap {
    name: "bhop_hellopro2",
    named_at: [-2048.0, -5248.0, 81.0],
    block: [-2048.0, -4864.0, 81.0],
    back_to: [-2048.0, -5248.0, 81.0],
};

const TRIEDSAME: HardMap = HardMap {
    name: "bhop_4triedsame",
    named_at: [7872.0, 7872.0, -9776.0],
    block: [7734.0, 8416.0, -9070.0],
    back_to: [7872.0, 7848.0, -9788.0],
};

/// Enough for the touch, the spawn, the rename and the teleport (about 0.45 s at 100 tick).
const SEND_BACK_TICKS: usize = 32;
const NAMING_TICKS: usize = 60;

fn map_fixture(name: &str) -> CString {
    let root = std::env::var_os("BH_V19_MAPS")
        .expect("set BH_V19_MAPS to a directory with the original BSPs");
    let path = PathBuf::from(root).join(format!("{name}.bsp"));
    assert!(path.is_file(), "missing {}", path.display());
    CString::new(path.to_str().unwrap()).unwrap()
}

unsafe fn idle(c: *mut BhContext, ticks: usize) -> BhState {
    let cmd = BhCmd {
        yaw: 90.0,
        ..BhCmd::default()
    };
    let mut state = BhState::default();
    for _ in 0..ticks {
        assert_eq!(unsafe { bh_step(c, &cmd, &mut state) }, 1);
    }
    state
}

fn near(a: [f32; 3], b: [f32; 3], radius: f32) -> bool {
    const HEIGHT_SLACK: f32 = 40.0;
    (a[0] - b[0]).hypot(a[1] - b[1]) < radius && (a[2] - b[2]).abs() < HEIGHT_SLACK
}

/// A session on `map` at `physics`, standing on one of its blocks after the level start has named the player.
unsafe fn on_a_block(map: &HardMap, physics: Option<u32>) -> *mut BhContext {
    let path = map_fixture(map.name);
    unsafe {
        let c = bh_create();
        if let Some(physics) = physics {
            let settings = BhSettings {
                physics,
                ..BhSettings::default()
            };
            assert_eq!(bh_set_settings(c, &settings), 1);
        }
        assert_eq!(bh_load_map(c, path.as_ptr(), ptr::null()), 1);
        assert_eq!(
            bh_set_position(c, map.named_at[0], map.named_at[1], map.named_at[2], 90.0),
            1
        );
        idle(c, NAMING_TICKS);
        let m = (*c).map.as_mut().unwrap();
        assert_eq!(
            m.game.player_name, "tped",
            "{}: the reset trigger names the player",
            map.name
        );
        // The bridge only respawns players, which clears their name; the core test places them the same way.
        m.game.place_player(map.block);
        let state = idle(c, 2);
        assert!(
            near(state.position, map.block, 8.0),
            "{}: on the block",
            map.name
        );
        c
    }
}

#[test]
#[ignore = "requires bhop_hellopro2.bsp and bhop_4triedsame.bsp (BH_V19_MAPS)"]
fn native_plays_the_reviewed_builds_on_physics_25() {
    for map in [HELLOPRO2, TRIEDSAME] {
        unsafe {
            let c = on_a_block(&map, None);
            let game = &(*c).map.as_ref().unwrap().game;
            assert_eq!(
                game.settings.physics_version,
                game::PHYSICS_V25,
                "native's default physics"
            );
            assert_eq!(game.reviewed_build_v25(), Some(map.name));
            let state = idle(c, SEND_BACK_TICKS);
            assert!(
                near(state.position, map.back_to, 64.0),
                "{}: a player standing on a block goes back, at {:?}",
                map.name,
                state.position
            );
            bh_destroy(c);
        }
    }
}

#[test]
#[ignore = "requires bhop_hellopro2.bsp and bhop_4triedsame.bsp (BH_V19_MAPS)"]
fn physics_24_never_runs_the_block_teleporters() {
    for map in [HELLOPRO2, TRIEDSAME] {
        unsafe {
            let c = on_a_block(&map, Some(game::PHYSICS_V24));
            let state = idle(c, NAMING_TICKS);
            assert!(
                near(state.position, map.block, 8.0),
                "{}: v24 leaves the player on the block",
                map.name
            );
            bh_destroy(c);
        }
    }
}
