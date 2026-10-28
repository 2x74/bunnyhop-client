//! The generated tutorial map (tools/tutorial: our own BSP v20 writer, not vbsp) loads and behaves: spawn on the floor,
//! every trigger_teleport resolves, exit portals lead to the next lesson, pits send you back to the lesson start, the
//! render mesh has lightmapped faces, and the hull collides with the floor, hurdles and walls.
//! Rebuild the map with `bun tools/tutorial/build.ts`. Real-engine checks: research/TUTORIAL.md (tools/parity).

use bunnyhop_core::{
    Cmd, Game,
    game::{EVENT_TELEPORTED, IN_JUMP},
    mesh,
};
use std::path::PathBuf;

const MAP: &str = "bhop_lol_tutorial";

fn bytes() -> Option<Vec<u8>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{MAP}.bsp"));
    std::fs::read(&path).map_err(|_| eprintln!("skipping: {} not found (bun tools/tutorial/build.ts)", path.display())).ok()
}

fn load() -> Option<Game> {
    let b = bytes()?;
    let bsp = bunnyhop_core::parse_bsp(&b).expect("bsp parses");
    assert_eq!(bsp.container_version, 20);
    Some(Game::load(&bsp).expect("game loads"))
}

fn idle(game: &mut Game, n: usize) {
    for _ in 0..n {
        game.step(Cmd::default()).expect("step");
    }
}

#[test]
fn spawns_on_the_floor_of_lesson_one() {
    let Some(mut game) = load() else { return };
    assert_eq!(game.spawn_origin, [-14144.0, -13952.0, 1.0]);
    idle(&mut game, 200);
    assert!(game.state.ground.is_some(), "grounded");
    let z = game.state.position[2];
    assert!((0.0..=1.0).contains(&z), "rests on the floor (top at z 0): {z}");
}

#[test]
fn every_teleport_resolves() {
    let Some(game) = load() else { return };
    let t = game.teleports();
    // 3 exit portals + the final course's 3 pits.
    assert_eq!(t.len(), 6);
    assert!(t.iter().all(|t| t.destination.is_some() && t.enabled), "all teleports have a destination");
}

/// Standing in an exit portal moves you to the next lesson's start; falling into a pit returns you to this one's.
#[test]
fn portals_and_pits() {
    let Some(mut game) = load() else { return };
    // Lesson 1's exit (x -12416 .. -12288 world) -> lesson 2's start (-11008, -13056).
    game.place_player([-12350.0, -13952.0, 1.0]);
    idle(&mut game, 1);
    assert!(game.events & EVENT_TELEPORTED != 0, "exit portal fired");
    assert_eq!([game.state.position[0], game.state.position[1]], [-11008.0, -13056.0]);
    // The final course's first gap (x -2560 .. -2368) -> fall -> its arrival point (-3680, -13952).
    game.place_player([-2464.0, -13952.0, 1.0]);
    let mut fired = false;
    for _ in 0..200 {
        idle(&mut game, 1);
        if game.events & EVENT_TELEPORTED != 0 {
            fired = true;
            break;
        }
    }
    assert!(fired, "pit teleport fired");
    assert_eq!([game.state.position[0], game.state.position[1]], [-3680.0, -13952.0]);
}

/// Hurdles (24 units) can't be walked over (step height 18) but can be hopped.
#[test]
fn hurdles_block_walking_and_allow_hopping() {
    let Some(mut game) = load() else { return };
    let walk = Cmd { forward: 450.0, ..Default::default() };
    for _ in 0..400 {
        game.step(walk).unwrap();
    }
    // First hurdle front face at x = -14336 + 640; hull half width 16.
    assert!(game.state.position[0] <= -14336.0 + 640.0 - 16.0 + 0.1, "stopped by the hurdle: {:?}", game.state.position);
    game.reset();
    let hop = Cmd { forward: 450.0, buttons: IN_JUMP, ..Default::default() };
    for i in 0..400 {
        game.step(if i < 40 { walk } else { hop }).unwrap();
    }
    assert!(game.state.position[0] > -14336.0 + 672.0, "hopped over: {:?}", game.state.position);
}

#[test]
fn render_mesh_is_lit_and_closed() {
    let Some(b) = bytes() else { return };
    let bsp = bunnyhop_core::parse_bsp(&b).unwrap();
    let m = mesh::build(&bsp);
    assert!(m.indices.len() / 3 > 600, "triangles: {}", m.indices.len() / 3);
    assert!(m.lightmap.width * m.lightmap.height >= 512 * 256, "baked lightmaps kept");
    let names: Vec<&str> = m.materials.iter().map(|x| x.name.as_str()).collect();
    assert!(names.contains(&"dev/graygrid") && names.contains(&"concrete/concretefloor011a"), "{names:?}");
    assert!(!m.sky_indices.is_empty(), "sky faces");
}
