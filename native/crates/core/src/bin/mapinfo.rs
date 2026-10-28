//! Render-content diagnostics: material resolution, texture decoding and lightmap atlas stats.
use bunnyhop_core::{materials, mesh, vfs};

fn main() {
    let path = std::env::args().nth(1).expect("usage: mapinfo <map.bsp> [-v]");
    let verbose = std::env::args().any(|a| a == "-v");
    let bytes = std::fs::read(&path).unwrap();
    let t0 = std::time::Instant::now();
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let m = mesh::build(&bsp);
    let t_mesh = t0.elapsed();
    let mut fs = vfs::Vfs::default();
    let pak = bsp.lump(playsrc_bsp::PAKFILE).map(|l| l.bytes(&bsp).to_vec()).unwrap_or_default();
    fs.mount(vfs::Source::from_zip("pak", pak));
    let names: Vec<String> = m.materials.iter().map(|x| x.name.clone()).collect();
    let mats = materials::resolve(&fs, &names);
    let t_mats = t0.elapsed();
    let mut decoded = 0;
    for (i, t) in mats.textures.iter().enumerate() {
        match materials::texture_payload(fs.read(t).unwrap(), true, false) {
            Ok(p) => {
                decoded += 1;
                if verbose {
                    println!("  tex {i} {t}: fmt {} {}x{} mips {}", p.format, p.levels[0].width, p.levels[0].height, p.levels.len());
                }
            }
            Err(e) => println!("  tex {i} {t}: ERROR {e}"),
        }
        if let Err(e) = materials::texture_payload(fs.read(t).unwrap(), false, false) {
            println!("  tex {i} {t}: RGBA ERROR {e}");
        }
    }
    let t_tex = t0.elapsed();
    let mut kinds = [0; 3];
    for (name, d) in names.iter().zip(&mats.descs) {
        kinds[d.kind as usize] += 1;
        if verbose || d.kind != materials::Kind::Textured {
            println!("  {:?} {name} shader={} tex={} flags={:#x}", d.kind, d.shader, d.texture, d.flags);
        }
    }
    println!(
        "materials {} (textured {}, missing {}, water {}), textures {} ({} decoded); lightmap {}x{}",
        names.len(),
        kinds[0],
        kinds[1],
        kinds[2],
        mats.textures.len(),
        decoded,
        m.lightmap.width,
        m.lightmap.height
    );
    // `--probe x y z`: list surfaces hit by a ray straight down from a point.
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--probe") {
        let o: Vec<f32> = args[i + 1..i + 4].iter().map(|v| v.parse().unwrap()).collect();
        let vf = mesh::VERTEX_FLOATS;
        let p = |k: u32| {
            let b = k as usize * vf;
            [m.vertices[b], m.vertices[b + 1], m.vertices[b + 2]]
        };
        for g in &m.groups {
            for t in m.indices[g.first_index as usize..(g.first_index + g.index_count) as usize].chunks_exact(3) {
                let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
                let s = |p1: [f32; 3], p2: [f32; 3]| (p1[0] - o[0]) * (p2[1] - o[1]) - (p2[0] - o[0]) * (p1[1] - o[1]);
                let (d0, d1, d2) = (s(a, b), s(b, c), s(c, a));
                if (d0 >= 0.0 && d1 >= 0.0 && d2 >= 0.0) || (d0 <= 0.0 && d1 <= 0.0 && d2 <= 0.0) {
                    let z = (a[2] + b[2] + c[2]) / 3.0;
                    if z < o[2] {
                        let n = m.vertices[t[0] as usize * vf + 5];
                        let cz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
                        let winding = if cz > 0.0 { "ccw-from-above" } else { "cw-from-above" };
                        let kind = mats.descs[g.material as usize].kind;
                        println!("  hit z~{z:.0} nz {n:.2} model {} {} {kind:?} (winding {winding})", g.model, names[g.material as usize]);
                    }
                }
            }
        }
    }
    if args.iter().any(|a| a == "--winding") {
        let vf = mesh::VERTEX_FLOATS;
        let v = |k: u32, o: usize| m.vertices[k as usize * vf + o];
        for g in &m.groups {
            let (mut agree, mut disagree) = (0, 0);
            for t in m.indices[g.first_index as usize..(g.first_index + g.index_count) as usize].chunks_exact(3) {
                let e1 = [v(t[1], 0) - v(t[0], 0), v(t[1], 1) - v(t[0], 1), v(t[1], 2) - v(t[0], 2)];
                let e2 = [v(t[2], 0) - v(t[0], 0), v(t[2], 1) - v(t[0], 1), v(t[2], 2) - v(t[0], 2)];
                let c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
                let d = c[0] * v(t[0], 3) + c[1] * v(t[0], 4) + c[2] * v(t[0], 5);
                if d > 0.0 { agree += 1 } else if d < 0.0 { disagree += 1 }
            }
            if disagree > 0 {
                println!("  winding model {} {}: ccw-with-normal {agree}, against {disagree}", g.model, names[g.material as usize]);
            }
        }
    }
    println!("timing: mesh+lightmap {t_mesh:?}, materials {:?}, all textures (s3tc+rgba) {:?}", t_mats - t_mesh, t_tex - t_mats);
}
