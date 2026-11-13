//! The map's fog and light for the renderer (fog.rs, lighting.rs), read from real maps (see `test_maps`).

use bunnyhop_core::{mesh, parse_bsp, test_maps};

fn load(name: &str) -> Option<playsrc_bsp::Bsp> {
    let path = test_maps::map(name)?;
    Some(parse_bsp(&std::fs::read(path).unwrap()).unwrap())
}

#[test]
fn world_fog_is_the_master_controllers() {
    let Some(bsp) = load("bhop_wayz") else { return };
    let fog = mesh::build(&bsp).world_fog.expect("bhop_wayz has a fog controller");
    assert!(fog.enable && !fog.blend);
    assert_eq!(fog.color, [211.0; 3]);
    assert_eq!((fog.start, fog.end, fog.max_density, fog.far_z), (500.0, 50000.0, 1.0, -1.0));
}

#[test]
fn maps_that_switch_fog_per_area_report_none() {
    // bhop_rpg: five controllers, picked per area with the player input SetFogController.
    let Some(bsp) = load("bhop_rpg") else { return };
    assert!(mesh::build(&bsp).world_fog.is_none());
}

fn average(cube: &bunnyhop_core::lighting::Cube) -> [f32; 3] {
    [0, 1, 2].map(|k| cube.iter().map(|c| c[k]).sum::<f32>() / 6.0)
}

#[test]
fn light_cube_follows_the_map() {
    let Some(bsp) = load("bhop_lost_world") else { return };
    let mesh = mesh::build(&bsp);
    let light = mesh.lighting.as_ref().expect("bhop_lost_world carries ambient lighting");
    assert!(!light.hdr && !light.lights.is_empty() && !light.ambient_has_direct);

    // The start: a cyan lamp overhead and a little bounce light.
    let start = [132.0, -872.0, 116.0];
    let cube = light.cube(start).expect("light at the start");
    let avg = average(&cube);
    assert!((avg[0] - 0.167).abs() < 0.02 && (avg[1] - 0.277).abs() < 0.02 && (avg[2] - 0.27).abs() < 0.02, "{avg:?}");
    assert!(cube[4][1] > 1.0 && cube[5][1] < 0.1, "lit from above: {cube:?}");
    // The lamp is the direct part. The leaf's own ambient is the smaller share, in the engine's units (255 times
    // the lightmap reading of the same bytes): dim, but not the near-zero the lightmap reading would give.
    let ambient = average(&light.ambient(start).unwrap());
    assert!(ambient[1] < avg[1] * 0.5 && ambient[1] > 0.005, "{ambient:?} vs {avg:?}");
    assert!(!light.direct(start).is_empty());

    // The end room is much darker than the start.
    let end = average(&light.cube([12560.0, 304.0, 8197.0]).expect("light at the end"));
    assert!(end[1] < 0.1, "{end:?}");

    // Straight down from the start is floor, not sky.
    assert_eq!(light.trace(start, [start[0], start[1], start[2] - 4000.0]), Some(false));
    // A ray that goes nowhere hits nothing.
    assert_eq!(light.trace(start, start), None);
}

#[test]
fn this_projects_own_compiler_keeps_its_units() {
    // tools/tutorial/bsp.ts writes its cubes in lightmap units with the sun already in them (lighting.rs).
    let Some(bsp) = load("bhop_lol_tutorial") else { return };
    let mesh = mesh::build(&bsp);
    let light = mesh.lighting.as_ref().expect("bhop_lol_tutorial carries ambient lighting");
    assert!(light.ambient_has_direct);
    let models: &[playsrc_bsp::Model] = match bsp.lump(playsrc_bsp::MODELS).map(|l| &l.records) {
        Some(playsrc_bsp::LumpData::Models(m)) => m,
        _ => &[],
    };
    let (lo, hi) = (models[0].mins, models[0].maxs);
    let at = |a: playsrc_bsp::Float32, b: playsrc_bsp::Float32, t: f32| a.value() + (b.value() - a.value()) * t;
    let mut seen = 0;
    for i in 1..20 {
        for j in 1..20 {
            let p = [at(lo.x, hi.x, i as f32 / 20.0), at(lo.y, hi.y, j as f32 / 20.0), at(lo.z, hi.z, 0.5)];
            assert!(light.direct(p).is_empty());
            let Some(cube) = light.cube(p) else { continue };
            let avg = average(&cube);
            assert!(avg.iter().all(|v| *v > 0.02 && *v < 4.0), "{avg:?} at {p:?}");
            seen += 1;
        }
    }
    assert!(seen > 0);
}

#[test]
fn every_sampled_point_is_finite() {
    // CS:GO world lights (100-byte records) and an HDR compile.
    for name in ["bhop_playboy_csgo", "ahop_coast"] {
        let Some(bsp) = load(name) else { continue };
        let mesh = mesh::build(&bsp);
        let Some(light) = mesh.lighting.as_ref() else { panic!("{name}: no lighting") };
        assert!(!light.lights.is_empty(), "{name}: world lights");
        assert!(light.lights.iter().all(|l| (0..=5).contains(&l.kind)), "{name}: light records misread");
        let models: &[playsrc_bsp::Model] = match bsp.lump(playsrc_bsp::MODELS).map(|l| &l.records) {
            Some(playsrc_bsp::LumpData::Models(m)) => m,
            _ => &[],
        };
        let (lo, hi) = (models[0].mins, models[0].maxs);
        let (mut some, mut lit) = (0, 0);
        for i in 0..400 {
            let t = |a: playsrc_bsp::Float32, b: playsrc_bsp::Float32, k: u32| a.value() + (b.value() - a.value()) * (((i * k) % 97) as f32 / 96.0);
            if let Some(cube) = light.cube([t(lo.x, hi.x, 7), t(lo.y, hi.y, 13), t(lo.z, hi.z, 29)]) {
                some += 1;
                assert!(cube.iter().flatten().all(|v| v.is_finite() && *v >= 0.0), "{name}: {cube:?}");
                lit += cube.iter().flatten().any(|v| *v > 0.0) as usize;
            }
        }
        assert!(some > 0 && lit > 0, "{name}: {some} sampled, {lit} lit");
    }
}

// ---- static prop lighting (prop_light.rs) ----

fn put(b: &mut [u8], o: usize, v: u32) {
    b[o..o + 4].copy_from_slice(&v.to_le_bytes());
}
fn putf(b: &mut [u8], o: usize, v: f32) {
    b[o..o + 4].copy_from_slice(&v.to_le_bytes());
}

/// A one-quad studio model (MDL, VVD, VTX; four vertices facing +z, drawn in the order 2, 0, 1, 3), as much of the
/// formats as `props.rs` reads.
fn quad_model() -> [(&'static str, Vec<u8>); 3] {
    let mut mdl = vec![0u8; 1024];
    mdl[..4].copy_from_slice(b"IDST");
    put(&mut mdl, 8, 0x5eed);
    putf(&mut mdl, 100, 8.0); // illumposition z
    // One texture "quad" in the model's own directory, one skin family.
    (put(&mut mdl, 204, 1), put(&mut mdl, 208, 400));
    put(&mut mdl, 400, 64);
    mdl[464..468].copy_from_slice(b"quad");
    (put(&mut mdl, 212, 1), put(&mut mdl, 216, 480), put(&mut mdl, 480, 484));
    (put(&mut mdl, 220, 1), put(&mut mdl, 224, 1), put(&mut mdl, 228, 490));
    // One body part with one model with one mesh.
    (put(&mut mdl, 232, 1), put(&mut mdl, 236, 500));
    (put(&mut mdl, 504, 1), put(&mut mdl, 508, 1), put(&mut mdl, 512, 16));
    (put(&mut mdl, 516 + 72, 1), put(&mut mdl, 516 + 76, 148));

    let mut vvd = vec![0u8; 64 + 4 * 48];
    vvd[..4].copy_from_slice(b"IDSV");
    (put(&mut vvd, 16, 4), put(&mut vvd, 56, 64));
    for (i, [x, y]) in [[0.0, 0.0], [16.0, 0.0], [16.0, 16.0], [0.0, 16.0]].into_iter().enumerate() {
        let o = 64 + i * 48;
        (putf(&mut vvd, o + 16, x), putf(&mut vvd, o + 20, y), putf(&mut vvd, o + 36, 1.0));
    }

    // Header (36) | body part | model | LOD | mesh (9) | strip group (25) | 4 vertices (9 each) | 6 indices.
    let mut vtx = vec![0u8; 36 + 8 + 8 + 12 + 9 + 25 + 36 + 12];
    (put(&mut vtx, 0, 7), put(&mut vtx, 28, 1), put(&mut vtx, 32, 36));
    (put(&mut vtx, 36, 1), put(&mut vtx, 40, 8));
    (put(&mut vtx, 44, 1), put(&mut vtx, 48, 8));
    (put(&mut vtx, 52, 1), put(&mut vtx, 56, 12));
    (put(&mut vtx, 64, 1), put(&mut vtx, 68, 9));
    (put(&mut vtx, 73, 4), put(&mut vtx, 77, 25), put(&mut vtx, 81, 6), put(&mut vtx, 85, 25 + 36));
    for (i, orig) in [2u16, 0, 1, 3].into_iter().enumerate() {
        vtx[98 + i * 9 + 4..98 + i * 9 + 6].copy_from_slice(&orig.to_le_bytes());
    }
    for (i, v) in [1u16, 2, 0, 1, 0, 3].into_iter().enumerate() {
        vtx[134 + i * 2..136 + i * 2].copy_from_slice(&v.to_le_bytes());
    }
    [("models/test/quad.mdl", mdl), ("models/test/quad.vvd", vvd), ("models/test/quad.dx90.vtx", vtx)]
}

/// A `.vhv` for the quad model: one LOD 0 strip group of four vertices (b, g, r, a each), in strip group order.
fn quad_vhv(checksum: u32, colors: [[u8; 4]; 4]) -> Vec<u8> {
    let mut v = vec![0u8; 40 + 28];
    (put(&mut v, 0, 2), put(&mut v, 4, checksum), put(&mut v, 12, 4), put(&mut v, 16, 4), put(&mut v, 20, 1));
    (put(&mut v, 40 + 4, 4), put(&mut v, 40 + 8, 68));
    v.extend(colors.iter().flatten());
    v
}

#[test]
fn static_props_take_baked_light_else_the_light_where_they_stand() {
    use bunnyhop_core::{prop_light, props, vfs};
    let Some(bsp) = load("bhop_lost_world") else { return };
    let mesh = mesh::build(&bsp);
    let light = mesh.lighting.as_ref().unwrap();
    // Three quads under the start's lamp: prop 0 with a baked file, prop 1 without, prop 2 an entity prop (never
    // baked) standing on edge.
    let at = [132.0, -872.0, 80.0];
    let mut sp = props::StaticProps { models: vec!["models/test/quad.mdl".into()], props: vec![] };
    for (i, angles) in [[0.0; 3], [0.0; 3], [0.0, 0.0, 90.0]].into_iter().enumerate() {
        sp.props.push(props::Prop { origin: at, angles, entity: i == 2, ..Default::default() });
    }
    let files = |vhv: &[(&str, Vec<u8>)]| {
        let mut fs = vfs::Vfs::default();
        let all = quad_model().into_iter().map(|(n, b)| (n.to_string(), b)).chain(vhv.iter().map(|(n, b)| (n.to_string(), b.clone())));
        fs.mount(vfs::Source::loose("content", all.map(|(n, b)| (n, b.into())).collect()));
        fs
    };
    let baked = [[0u8, 0, 255, 255], [0, 128, 0, 255], [255, 0, 0, 255], [128, 128, 128, 255]];
    let fs = files(&[("sp_0.vhv", quad_vhv(0x5eed, baked)), ("sp_2.vhv", quad_vhv(0x5eed, baked))]);
    let pm = props::build(&sp, &fs);
    assert_eq!(pm.sources.len() * props::PROP_VERTEX_FLOATS, pm.vertices.len());
    assert_eq!(pm.sources.len(), 12);
    let colors = prop_light::bake(&sp, &pm, &fs, light);
    assert_eq!(colors.len(), 36);
    let of = |prop: u32, vertex: u32| {
        let i = pm.sources.iter().position(|s| *s == [prop, vertex]).unwrap();
        [colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]]
    };
    // Baked: the file's colours by strip group order (vertices 2, 0, 1, 3), at twice overbright.
    let full = 2f32.powf(2.2);
    assert!((of(0, 2)[0] - full).abs() < 1e-3 && of(0, 2)[1] == 0.0);
    assert!((of(0, 0)[1] - 1.0).abs() < 0.02 && of(0, 0)[0] == 0.0);
    assert!((of(0, 1)[2] - full).abs() < 1e-3);
    assert!((of(0, 3)[0] - 1.0).abs() < 0.02);
    // Not baked: the cyan lamp overhead on a face that looks up, the same on all four corners.
    let lit = of(1, 0);
    assert!(lit[1] > 0.5 && lit[0] < lit[1] && lit.iter().all(|v| v.is_finite()), "{lit:?}");
    for v in 1..4 {
        assert!((of(1, v)[1] - lit[1]).abs() < 0.05 * lit[1]);
    }
    // The entity prop ignores its file and, on edge, sees far less of the lamp.
    let side = of(2, 0);
    assert!(side[1] < lit[1] * 0.5 && side[1] > 0.0, "{side:?} vs {lit:?}");

    // A file for another build of the model is not used: the prop is lit where it stands.
    let fs = files(&[("sp_0.vhv", quad_vhv(0xbad, baked))]);
    let colors = prop_light::bake(&sp, &props::build(&sp, &fs), &fs, light);
    let pm = props::build(&sp, &fs);
    let colors = prop_light::bake(&sp, &pm, &fs, light);
    for (c, src) in colors.chunks(3).zip(&pm.sources) {
        assert!(src[0] == 2 || (c[1] - lit[1]).abs() < 0.05 * lit[1], "{c:?} vs {lit:?}");
    }
}
