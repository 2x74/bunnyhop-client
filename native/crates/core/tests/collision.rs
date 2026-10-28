//! Collision content beyond plain brushes: displacements, static props, surface properties.
//! Test maps are gitignored; each test skips (with a note) when its map is absent.

use bunnyhop_core::{Cmd, Game, game::EVENT_TELEPORTED, physics};
use std::path::PathBuf;

fn map_bytes(name: &str) -> Option<Vec<u8>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    match std::fs::read(&path) {
        Ok(b) => Some(b),
        Err(_) => {
            eprintln!("skipping {name}: {} not found", path.display());
            None
        }
    }
}

/// Displacement-heavy maps used below.
const DISPLACEMENT_MAPS: [&str; 5] = ["bhop_arcane_v1", "bhop_sahara", "bhop_depot", "kz_bhop_indiana", "bhop_ancient"];

/// Dropping the player onto the middle of every floor-like displacement lands on it instead of
/// falling through (displacement collision is attached to the world).
#[test]
fn players_land_on_displacements() {
    let mut total = (0, 0);
    for name in DISPLACEMENT_MAPS {
        let Some(bytes) = map_bytes(name) else { continue };
        let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
        let mut game = Game::load(&bsp).unwrap();
        let centers = physics::displacement_centers(&bsp);
        assert_eq!(centers.len(), game.displacement_count, "{name}: one centre per patch");
        assert!(!centers.is_empty(), "{name}: has displacements");
        let (mut tested, mut landed, mut wedged) = (0, 0, 0);
        for (p, n) in centers {
            if n[2] < 0.75 {
                continue;
            }
            let start = [p[0], p[1], p[2] + 24.0];
            // Only drop where the hull fits above the surface and the first thing below is this
            // surface (not a brush covering the displacement).
            let probe = game.trace_player_hull(start, [p[0], p[1], p[2] - 64.0]);
            if probe.start_solid || probe.fraction >= 1.0 || (probe.end[2] - p[2]).abs() > 12.0 {
                continue;
            }
            game.place_player(start);
            let mut teleported = false;
            for _ in 0..40 {
                game.step(Cmd::default()).unwrap();
                // Teleports and trigger_push boosters move the player elsewhere: not a test of
                // the surface (nor do low-gravity zones or water).
                teleported |= game.events & EVENT_TELEPORTED != 0 || game.state.base_velocity != [0.0; 3] || game.gravity_scale != 1.0 || game.state.water_level > 0;
            }
            if teleported {
                continue;
            }
            tested += 1;
            let rest = probe.end[2];
            if game.state.ground.is_some() && (game.state.position[2] - rest).abs() < 2.5 {
                landed += 1;
            } else if game.state.position[2] > p[2] - 2.0 && game.state.velocity[2] >= -4.0 {
                // Wedged in a V between steep displacement walls above the floor: not standable,
                // not falling either (Source behaves the same: no ground plane >= 0.7 is found).
                wedged += 1;
            } else {
                eprintln!("{name}: dropped at {p:?} n {n:?}, ended at {:?} ground {}", game.state.position, game.state.ground.is_some());
            }
        }
        eprintln!("{name}: {landed}/{tested} displacement drops landed, {wedged} wedged");
        assert!(tested > 0, "{name}: some displacements were testable");
        assert_eq!(landed + wedged, tested, "{name}: no drop falls through a displacement");
        total = (total.0 + tested, total.1 + wedged);
    }
    assert!(total.1 * 10 <= total.0, "wedging is rare: {total:?}");
}

/// The same drop with displacement collision missing would fall through: check the trace really
/// comes from the displacement (hit identity tagged as a world surface, not a brush).
#[test]
fn displacement_hits_are_world_surfaces() {
    let Some(bytes) = map_bytes("bhop_arcane_v1") else { return };
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let game = Game::load(&bsp).unwrap();
    let mut hits = 0;
    for (p, n) in physics::displacement_centers(&bsp) {
        if n[2] < 0.75 {
            continue;
        }
        let t = game.trace_player_hull([p[0], p[1], p[2] + 24.0], [p[0], p[1], p[2] - 64.0]);
        if !t.start_solid && t.fraction < 1.0 && (t.end[2] - p[2]).abs() < 2.0 {
            assert!(t.normal.is_some_and(|n| n[2] > 0.0));
            hits += 1;
        }
    }
    assert!(hits > 10, "arcane: {hits} displacement hits");
}

/// bhop_exodus, bhop_bitches_fix and bhop_boxes_snowy have displacements with sewn or collapsed
/// rows: grid vertices that coincide exactly, so some collision triangles have zero area. SDK 2013
/// loads these maps (such a triangle gets a zero plane); the vendored collision used to reject the
/// whole map (`displacements: InvalidRange`). They load, report the triangles, and box sweeps
/// through the collapsed vertices only ever return unit hit normals (a zero normal is a malformed
/// trace for the movement code).
#[test]
fn maps_with_zero_area_displacement_triangles_load() {
    const SUFFIX: &str = " zero-area triangles collide as segments (no face plane)";
    for (name, expected) in [("bhop_exodus", 62), ("bhop_bitches_fix", 92), ("bhop_boxes_snowy", 97)] {
        let Some(bytes) = map_bytes(name) else { continue };
        let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
        let mut game = Game::load(&bsp).unwrap_or_else(|e| panic!("{name}: {e}"));
        let reported: usize = game
            .physics_diagnostics
            .iter()
            .filter_map(|d| d.strip_suffix(SUFFIX)?.rsplit(' ').next()?.parse::<usize>().ok())
            .sum();
        assert_eq!(reported, expected, "{name}: zero-area triangles reported");

        let mut points = Vec::new();
        for grid in physics::displacement_positions(&bsp) {
            let side = (grid.len() as f32).sqrt() as usize;
            for (i, p) in grid.iter().enumerate() {
                let right = i % side + 1 < side && grid[i + 1] == *p;
                let below = i + side < grid.len() && grid[i + side] == *p;
                if right || below {
                    points.push(*p);
                }
            }
        }
        points.dedup();
        assert!(!points.is_empty(), "{name}: has collapsed displacement vertices");

        let mut directions = Vec::new();
        for x in [-1.0f32, 0.0, 1.0] {
            for y in [-1.0f32, 0.0, 1.0] {
                for z in [-1.0f32, 0.0, 1.0] {
                    if [x, y, z] != [0.0; 3] {
                        directions.push([x, y, z]);
                    }
                }
            }
        }
        let mut hits = 0;
        for p in &points {
            for d in &directions {
                let start = [p[0] + d[0] * 48.0, p[1] + d[1] * 48.0, p[2] + d[2] * 48.0];
                let end = [p[0] - d[0] * 48.0, p[1] - d[1] * 48.0, p[2] - d[2] * 48.0];
                let t = game.trace_player_hull(start, end);
                if t.start_solid || t.fraction >= 1.0 {
                    continue;
                }
                let n = t.normal.unwrap_or_else(|| panic!("{name}: hit without a plane at {p:?}"));
                let length = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
                assert!((length - 1.0).abs() < 1e-3, "{name}: hit normal {n:?} sweeping {d:?} through {p:?}");
                hits += 1;
            }
            // Dropping onto the collapsed vertex steps without movement errors.
            game.place_player([p[0], p[1], p[2] + 40.0]);
            for _ in 0..30 {
                game.step(Cmd::default()).unwrap();
            }
        }
        assert!(hits > 0, "{name}: sweeps hit the collapsed displacements");
        assert_eq!(game.movement_errors, 0, "{name}: {}", game.last_movement_error);
        eprintln!("{name}: {} collapsed vertices, {hits} sweep hits", points.len());
    }
}

/// bhop_arcane_v1 packs `nature/ice` with `$surfaceprop ice`: traces onto those faces report the
/// ice surface (hit identity bits 48..64 = surface-table index), and standing on one gives the
/// player surface friction min(0.1 * 1.25, 1) = 0.125. (On arcane the ice floors are fail floors
/// inside teleport triggers, so the slide itself is tested on a synthetic scene in slopes.rs.)
#[test]
fn ice_surface_property_resolves_from_the_packed_vmt() {
    let Some(bytes) = map_bytes("bhop_arcane_v1") else { return };
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let mesh = bunnyhop_core::mesh::build(&bsp);
    let ice = mesh.materials.iter().position(|m| m.name == "nature/ice").expect("arcane has nature/ice");
    let game = Game::load(&bsp).unwrap();
    let ice_index = physics::surface_index("ice") as u64;
    assert_eq!(physics::SURFACE_PROPS[ice_index as usize].friction, 0.1);
    let vf = bunnyhop_core::mesh::VERTEX_FLOATS;
    let mut hits = 0;
    for g in mesh.groups.iter().filter(|g| g.material as usize == ice && g.model == 0) {
        for tri in mesh.indices[g.first_index as usize..(g.first_index + g.index_count) as usize].chunks_exact(3) {
            let p = |k: u32| {
                let o = k as usize * vf;
                [mesh.vertices[o], mesh.vertices[o + 1], mesh.vertices[o + 2]]
            };
            let (a, b, c) = (p(tri[0]), p(tri[1]), p(tri[2]));
            if mesh.vertices[tri[0] as usize * vf + 5] < 0.99 {
                continue;
            }
            let centre = [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, a[2]];
            let probe = game.trace_player_hull([centre[0], centre[1], centre[2] + 4.0], [centre[0], centre[1], centre[2] - 8.0]);
            if probe.start_solid || probe.fraction >= 1.0 || (probe.end[2] - centre[2]).abs() > 0.1 {
                continue;
            }
            assert_eq!(probe.hit.unwrap() >> 48, ice_index, "ice face at {centre:?}");
            hits += 1;
        }
    }
    assert!(hits > 10, "{hits} ice faces traced");
}

/// With the surface-property rule off, every surface uses the default player friction.
#[test]
fn surface_properties_rule_off_uses_default_friction() {
    let Some(bytes) = map_bytes("bhop_strafingonlegos") else { return };
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let mut game = Game::load(&bsp).unwrap();
    for _ in 0..200 {
        game.step(Cmd::default()).unwrap();
    }
    assert!(game.state.ground.is_some());
    let with = game.state.surface_friction;
    let mut rules = game.rules;
    rules.surface_properties = false;
    game.set_rules(rules);
    for _ in 0..200 {
        game.step(Cmd::default()).unwrap();
    }
    assert_eq!(game.state.surface_friction, 1.0);
    eprintln!("legos spawn floor surface friction with surface properties: {with}");
}

/// bhop_depot packs the .phy collision models of its static props: players stand on them (the
/// hit is a world surface without a brush index, i.e. the prop's convex hull, not a brush).
#[test]
fn players_stand_on_packed_static_props() {
    let Some(bytes) = map_bytes("bhop_depot") else { return };
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let mut game = Game::load(&bsp).unwrap();
    assert!(game.solid_static_props() > 0, "depot has packed prop collision");
    let props = physics::build(&bsp).unwrap().props;
    let (mut tested, mut landed) = (0, 0);
    for b in &props.brushes {
        let top = [(b.mins[0] + b.maxs[0]) * 0.5, (b.mins[1] + b.maxs[1]) * 0.5, b.maxs[2]];
        let start = [top[0], top[1], top[2] + 24.0];
        let probe = game.trace_player_hull(start, [top[0], top[1], top[2] - 32.0]);
        // Only where the first thing below is this prop solid's top (flat-ish).
        if probe.start_solid || probe.fraction >= 1.0 || (probe.end[2] - top[2]).abs() > 1.0 {
            continue;
        }
        if !probe.normal.is_some_and(|n| n[2] > 0.9) {
            continue;
        }
        let Some(hit) = probe.hit else { continue };
        if hit & (1 << 41) == 0 {
            continue; // a brush is on top of the prop here
        }
        game.place_player(start);
        let mut moved = false;
        for _ in 0..30 {
            game.step(Cmd::default()).unwrap();
            moved |= game.events & EVENT_TELEPORTED != 0 || game.state.base_velocity != [0.0; 3] || game.state.water_level > 0;
        }
        if moved {
            continue;
        }
        tested += 1;
        // Within the 2-unit ground probe (a player landing through the probe hovers until moving,
        // as in Source).
        if game.state.ground.is_some() && (game.state.position[2] - probe.end[2]).abs() < 2.0 {
            landed += 1;
        } else {
            eprintln!("depot: prop top {top:?} -> {:?} ground {}", game.state.position, game.state.ground.is_some());
        }
    }
    eprintln!("bhop_depot: {landed}/{tested} prop drops landed");
    assert!(tested > 5, "testable prop tops: {tested}");
    assert_eq!(landed, tested);
}
