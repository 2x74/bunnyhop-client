//! Render-data regression tests on real maps (gitignored; each test skips when its map is absent).

use bunnyhop_core::materials::{self, Kind};
use bunnyhop_core::{content, mesh, vfs};
use std::path::PathBuf;

fn map_bytes(name: &str) -> Option<Vec<u8>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    std::fs::read(&path).map_err(|_| eprintln!("skipping {name}: {} not found", path.display())).ok()
}

/// Maps compiled without light entities (all-black lighting lump) are fullbright: no face gets a lightmap block,
/// so the atlas is just the reserved white block.
#[test]
fn unlit_maps_are_fullbright() {
    for name in ["bhop_stairs", "bhop_mp_stairs", "bhop_redwood", "bhop_2_easy", "bhop_noob", "bhop_red"] {
        let Some(bytes) = map_bytes(name) else { continue };
        let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
        let m = mesh::build(&bsp);
        assert!(m.lightmap.width * m.lightmap.height <= 256 * 4, "{name}: atlas {}x{}", m.lightmap.width, m.lightmap.height);
        assert!(m.lightmap.rgba.chunks_exact(4).take(4).all(|p| p[0] > 100), "{name}: white block");
    }
    // A lit map keeps its lightmaps.
    if let Some(bytes) = map_bytes("bhop_eazy") {
        let m = mesh::build(&bunnyhop_core::parse_bsp(&bytes).unwrap());
        assert!(m.lightmap.width * m.lightmap.height > 256 * 256, "bhop_eazy: lightmaps kept");
    }
}

/// Every upward-facing water surface sits on top of a water volume (used for underwater fog).
#[test]
fn water_surfaces_lie_on_water_volumes() {
    for name in ["bhop_mp_stairs", "bhop_arcane_v1"] {
        let Some(bytes) = map_bytes(name) else { continue };
        let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
        let m = mesh::build(&bsp);
        assert!(!m.water.is_empty(), "{name}: has water volumes");
        let mut v = vfs::Vfs::default();
        v.mount(vfs::Source::from_zip("pak", content::pakfile(&bsp)));
        let names: Vec<String> = m.materials.iter().map(|x| x.name.clone()).collect();
        let mats = materials::resolve(&v, &names);
        let mut checked = 0;
        for g in m.groups.iter().filter(|g| g.model == 0 && mats.descs[g.material as usize].kind == Kind::Water) {
            for t in m.indices[g.first_index as usize..(g.first_index + g.index_count) as usize].chunks_exact(3) {
                let p: Vec<&[f32]> = t.iter().map(|&i| &m.vertices[i as usize * mesh::VERTEX_FLOATS..i as usize * mesh::VERTEX_FLOATS + 6]).collect();
                if p[0][5] < 0.9 {
                    continue; // only upward-facing surfaces
                }
                let c = [0, 1, 2].map(|k| (p[0][k] + p[1][k] + p[2][k]) / 3.0);
                let inside = m.water.iter().any(|b| c[0] >= b[0] - 1.0 && c[0] <= b[3] + 1.0 && c[1] >= b[1] - 1.0 && c[1] <= b[4] + 1.0 && (c[2] - b[5]).abs() < 2.0);
                assert!(inside, "{name}: water surface triangle at {c:?} has no volume");
                checked += 1;
            }
        }
        assert!(checked > 0, "{name}: checked some water surfaces");
    }
}

/// Sky faces (SURF_SKY / SURF_SKY2D) are kept out of the textured mesh but exported as their own position-only mesh,
/// which the client draws depth-only so they hide what's behind them. bhop_monster_jam: from the spawn eye looking
/// up over the start room's walls (yaw 75, pitch -24), the first surface is a sky face; the black starry stage
/// (cs_italy/black) behind it must not show.
#[test]
fn sky_faces_are_exported_and_occlude() {
    let Some(bytes) = map_bytes("bhop_monster_jam") else { return };
    let m = mesh::build(&bunnyhop_core::parse_bsp(&bytes).unwrap());
    assert!(!m.materials.iter().any(|x| x.name.starts_with("tools/toolsskybox")), "no sky materials in the textured mesh");
    assert!(!m.sky_groups.is_empty() && m.sky_indices.len() % 3 == 0);
    let nverts = (m.sky_vertices.len() / 3) as u32;
    assert!(m.sky_indices.iter().all(|&i| i < nverts));
    let covered: u32 = m.sky_groups.iter().map(|g| g[2]).sum();
    assert_eq!(covered as usize, m.sky_indices.len());

    type V = [f32; 3];
    let sub = |a: V, b: V| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let dot = |a: V, b: V| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let cross = |a: V, b: V| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    // Closest front-facing hit (triangles are emitted CCW for GL: front normal (b - a) x (c - a)).
    let first_hit = |verts: &[f32], stride: usize, idx: &[u32], o: V, d: V| -> f32 {
        let p = |i: u32| [verts[i as usize * stride], verts[i as usize * stride + 1], verts[i as usize * stride + 2]];
        let mut best = f32::INFINITY;
        for t in idx.chunks_exact(3) {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            let (e1, e2) = (sub(b, a), sub(c, a));
            if dot(cross(e1, e2), d) >= 0.0 {
                continue;
            }
            let q = cross(d, e2);
            let det = dot(e1, q);
            let s = sub(o, a);
            let u = dot(s, q) / det;
            let r = cross(s, e1);
            let v = dot(d, r) / det;
            let t = dot(e2, r) / det;
            if (0.0..=1.0).contains(&u) && v >= 0.0 && u + v <= 1.0 && t > 0.0 {
                best = best.min(t);
            }
        }
        best
    };
    let eye = [632.0, -2632.0, 3841.0];
    let (yaw, pitch) = (75f32.to_radians(), (-24f32).to_radians()); // Source angles: negative pitch looks up
    let dir = [pitch.cos() * yaw.cos(), pitch.cos() * yaw.sin(), -pitch.sin()];
    let sky = first_hit(&m.sky_vertices, 3, &m.sky_indices, eye, dir);
    let world = first_hit(&m.vertices, mesh::VERTEX_FLOATS, &m.indices, eye, dir);
    assert!(sky < 1000.0, "sky face ahead ({sky})");
    assert!(world.is_finite() && world > sky, "world geometry behind the sky face (sky {sky}, world {world})");
}

/// Source's 3D skybox (skybox.rs): the sky_camera's area is the skybox set. Every world triangle classified "main" lies
/// outside that area and every skybox triangle inside it (checked by the leaf in front of each triangle), the
/// sky_camera keyvalues come through, static skybox props are found by their leaf lists, static brush entities are
/// merged into the world's skybox groups while toggled ones keep their own, and maps without a sky_camera have none.
#[test]
fn sky3d_membership() {
    use bunnyhop_core::{entities, props, skybox};
    for name in ["bhop_japan", "bhop_aztec", "bhop_miku_v2", "bhop_twisted", "bhop_lost_world", "bhop_ocean", "bhop_eazy", "bh_aztec"] {
        let Some(bytes) = map_bytes(name) else { continue };
        let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
        let ents = entities::parse(&content::entity_text(&bsp));
        let m = mesh::build(&bsp);
        let Some(s) = skybox::find(&bsp, &ents) else {
            assert!(matches!(name, "bhop_eazy" | "bh_aztec"), "{name}: 3D skybox found");
            assert!(m.sky_camera.is_none() && !m.groups.iter().any(|g| g.sky3d), "{name}: no skybox groups");
            continue;
        };
        assert_eq!(m.sky_camera.as_ref(), Some(&s.camera), "{name}: mesh carries the sky_camera");
        let vert = |i: u32| -> [f32; 6] { std::array::from_fn(|k| m.vertices[i as usize * mesh::VERTEX_FLOATS + k]) };
        let (mut inside, mut outside) = (0, 0);
        for g in m.groups.iter().filter(|g| g.model == 0) {
            for t in m.indices[g.first_index as usize..(g.first_index + g.index_count) as usize].chunks_exact(3) {
                let p = [vert(t[0]), vert(t[1]), vert(t[2])];
                let c: [f32; 3] = std::array::from_fn(|k| (p[0][k] + p[1][k] + p[2][k]) / 3.0 + p[0][3 + k] * 0.5);
                match s.areas.area(c) {
                    0 => {}
                    a if (a == s.camera.area) != g.sky3d => panic!("{name}: triangle at {c:?} (area {a}) classified sky3d={}", g.sky3d),
                    _ if g.sky3d => inside += 1,
                    _ => outside += 1,
                }
            }
        }
        assert!(outside > 0, "{name}: main view keeps the course");
        let sky_tris: u32 = m.groups.iter().filter(|g| g.sky3d).map(|g| g.index_count / 3).sum();
        match name {
            "bhop_japan" => {
                // Two propper mountain props and fog: scale 16, fogstart 128, fogend 10000, fogmaxdensity 0.5.
                let f = &s.camera.fog;
                assert_eq!((s.camera.scale, f.enable, f.start, f.end, f.max_density), (16.0, true, 128.0, 10000.0, 0.5));
                assert_eq!(f.color, [119.0, 129.0, 168.0]);
                let mut sp = props::static_props(&bsp);
                let n = sp.props.len();
                skybox::mark_props(&bsp, &mut sp, n);
                let sky: Vec<&str> = sp.props.iter().filter(|p| p.sky3d).map(|p| sp.models[p.model].as_str()).collect();
                assert_eq!(sky, ["models/propper/3dsky_jap1.mdl", "models/propper/3dsky_jap2.mdl"]);
            }
            "bhop_miku_v2" => {
                // Scale 4; the func_brush (*7) is merged into the world's skybox groups, the 192 named func_wall_toggle
                // equalizer bars (toggled by the map's logic) keep a mesh each.
                assert_eq!(s.camera.scale, 4.0);
                assert!(s.merge[7].is_some() && s.models[7]);
                assert!(!m.groups.iter().any(|g| g.model == 7), "*7 merged");
                let toggles = (91..=282).filter(|&i| s.models[i] && s.merge[i].is_none()).count();
                assert_eq!(toggles, 192);
                assert!(m.groups.iter().filter(|g| g.model >= 91 && g.model <= 282).all(|g| g.sky3d));
            }
            _ => assert!(sky_tris > 0 && inside > 0, "{name}: skybox geometry ({sky_tris} tris)"),
        }
    }
}

/// Survey (run with --ignored --nocapture): 3D skybox membership on every map with a sky_camera.
#[test]
#[ignore]
fn sky3d_survey() {
    use bunnyhop_core::{entities, skybox};
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps");
    let mut names: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()?.file_name().into_string().ok()?.strip_suffix(".bsp").map(str::to_string)).collect();
    names.sort();
    for name in names {
        let bytes = map_bytes(&name).unwrap();
        let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
        let ents = entities::parse(&content::entity_text(&bsp));
        if !ents.iter().any(|e| e.classname() == "sky_camera") {
            continue;
        }
        let Some(s) = skybox::find(&bsp, &ents) else {
            println!("{name}: no usable 3D skybox");
            continue;
        };
        let m = mesh::build(&bsp);
        let tris = |sky: bool| m.groups.iter().filter(|g| g.sky3d == sky).map(|g| g.index_count / 3).sum::<u32>();
        let sp = s.static_props(&bsp);
        println!(
            "{name}: area {} scale {} faces {}/{} brush models {} ({} merged) groups {} tris sky {} main {} static props {}/{} fog {:?}",
            s.camera.area,
            s.camera.scale,
            s.faces.iter().filter(|&&f| f).count(),
            s.faces.len(),
            s.models.iter().filter(|&&f| f).count(),
            s.merge.iter().filter(|f| f.is_some()).count(),
            m.groups.iter().filter(|g| g.sky3d).count(),
            tris(true),
            tris(false),
            sp.iter().filter(|&&f| f).count(),
            sp.len(),
            (s.camera.fog.enable, s.camera.fog.start, s.camera.fog.end, s.camera.fog.max_density),
        );
    }
}

/// The descending water in Sonni's fourth section is a wedge, not its enclosing box.
#[test]
fn sloped_water_keeps_brush_planes() {
    let Some(bytes) = map_bytes("bhop_sonni_v2") else { return };
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let (boxes, clips) = mesh::water_geometry(&bsp);
    assert_eq!(boxes.len(), clips.len());
    let index = boxes.iter().position(|b| b[0] == 320.0 && b[2] == -728.0).expect("sloped section");
    let inside = |p: [f32; 3]| clips[index].iter().all(|n| n[0]*p[0]+n[1]*p[1]+n[2]*p[2] <= n[3]);
    assert!(!clips[index].is_empty());
    assert!(!inside([2000.0, -3700.0, -200.0]), "air above descending surface must not receive water fog");
    assert!(inside([2000.0, -3700.0, -600.0]), "point below surface remains underwater");
}

#[test]
fn highly_compressible_wrath_lumps_load_with_bounded_game_limits() {
    let Some(bytes) = map_bytes("bhop_wrath") else { return };
    assert!(bunnyhop_core::parse_bsp(&bytes).is_ok());
    let strict = playsrc_bsp::parse(&bytes, playsrc_bsp::Profile::for_source(&bytes), playsrc_bsp::Limits::default());
    assert_eq!(strict.unwrap_err().code, playsrc_bsp::ErrorCode::CompressionRatio);
}

/// GothQueen's unreal_space report: toolsblack is a visible opaque wall, not a nodraw tool.
#[test]
fn black_tool_walls_are_rendered() {
    assert!(!mesh::hidden_tool_material("tools/toolsblack"));
    assert!(!mesh::hidden_tool_material("tools/toolswhite"));
    assert!(mesh::hidden_tool_material("tools/toolsnodraw"));
    assert!(mesh::hidden_tool_material("tools/toolsplayerclip"));
    let Some(bytes) = map_bytes("bhop_unreal_space") else { return };
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let m = mesh::build(&bsp);
    let material = m.materials.iter().position(|m| m.name == "tools/toolsblack").expect("map uses black walls");
    let count: u32 = m.groups.iter().filter(|g| g.material as usize == material).map(|g| g.index_count).sum();
    assert!(count > 0, "black wall faces must reach the renderer");
    let mut fs = vfs::Vfs::default();
    fs.mount(vfs::Source::from_zip("pak", content::pakfile(&bsp)));
    let mats = materials::resolve(&fs, &["tools/toolsblack".into()]);
    assert_eq!(mats.descs[0].kind, Kind::Textured);
    assert_eq!(mats.descs[0].flags & (materials::FLAG_TRANSLUCENT | materials::FLAG_ADDITIVE), 0);
}
