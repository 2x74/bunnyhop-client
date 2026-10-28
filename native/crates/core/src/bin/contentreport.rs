//! Missing-material counts per map, before (pakfile only) and after mounting game content.
//!
//! usage: contentreport [--content <CS:S install root>] [-v] <map.bsp>...
//!
//! The install root is the folder holding `cstrike/` and `hl2/`, e.g.
//! `~/Library/Application Support/Steam/steamapps/common/Counter-Strike Source`.
use bunnyhop_core::content::{self, DiskContent};
use bunnyhop_core::materials::{self, Kind};
use bunnyhop_core::{mesh, vfs};

fn main() {
    let mut root = None;
    let mut verbose = false;
    let mut maps = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--content" => root = args.next(),
            "-v" => verbose = true,
            "--model" => {
                // Debug: fetch one model's files from the install and report each parse step.
                let m = args.next().expect("--model <models/....mdl>");
                let dc = root.as_ref().map(|r| DiskContent::open(std::path::Path::new(r)).unwrap()).expect("--content first");
                let sp = bunnyhop_core::props::StaticProps { models: vec![m.clone()], props: vec![] };
                let mut dc = dc;
                dc.resolve_props(&[], &sp);
                let [a, b, c] = bunnyhop_core::props::model_files(&m);
                let get = |p: &str| dc.fetched.get(p).map(|x| x.to_vec());
                let (mdl, vvd, vtx) = (get(&a), get(&b), get(&c));
                println!("{a}: {:?} bytes, {b}: {:?}, {c}: {:?}", mdl.as_ref().map(Vec::len), vvd.as_ref().map(Vec::len), vtx.as_ref().map(Vec::len));
                if let Some(mdl) = &mdl {
                    println!("version {}", i32::from_le_bytes(mdl[4..8].try_into().unwrap()));
                    println!("textures {:?}", bunnyhop_core::props::mdl_textures(mdl));
                    if let (Some(vvd), Some(vtx)) = (&vvd, &vtx) {
                        let g = bunnyhop_core::props::model_geometry(mdl, vvd, vtx);
                        println!("geometry: {:?}", g.map(|g| (g.vertices.len(), g.meshes.iter().map(|(m, t)| (*m, t.len() / 3)).collect::<Vec<_>>())));
                    }
                }
                return;
            }
            _ => maps.push(a),
        }
    }
    let mut dc = root.as_ref().map(|r| DiskContent::open(std::path::Path::new(r)).unwrap_or_else(|e| panic!("{e}")));
    if let Some(dc) = &dc {
        for m in &dc.vpks {
            println!("mounted {} ({} files)", m.name, m.len());
        }
    }
    println!("{:<28} {:>9} {:>16} {:>16}  sky", "map", "materials", "missing (pak)", "missing (+game)");
    for path in &maps {
        let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"));
        let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
        let m = mesh::build(&bsp);
        let names: Vec<String> = m.materials.iter().map(|x| x.name.clone()).collect();
        let pak = content::pakfile(&bsp);
        let mut pak_vfs = vfs::Vfs::default();
        pak_vfs.mount(vfs::Source::from_zip("pak", pak.clone()));
        let before = materials::resolve(&pak_vfs, &names);
        let missing_before = before.descs.iter().filter(|d| d.kind == Kind::Missing).count();
        let sky = content::skyname(&bsp).unwrap_or_default();
        let name = std::path::Path::new(path).file_stem().unwrap().to_string_lossy().into_owned();
        let after = dc.as_mut().map(|dc| {
            let mut all = names.clone();
            all.extend(content::sky_materials(&sky));
            let read0 = dc.bytes_read;
            let (mats, vfs, rounds) = dc.resolve(&pak, &all, &mut |_| None);
            let missing: Vec<&String> = names.iter().zip(&mats.descs).filter(|(_, d)| d.kind == Kind::Missing).map(|(n, _)| n).collect();
            let sky_ok = mats.descs[names.len()..].iter().filter(|d| d.texture >= 0).count();
            let decoded = mats.textures.iter().filter(|t| vfs.read(t).is_some_and(|b| materials::texture_payload(b, true, false).is_ok())).count();
            (missing, sky_ok, rounds, dc.bytes_read - read0, decoded, mats.textures.len())
        });
        if let Some(dc) = dc.as_mut() {
            let sp = bunnyhop_core::props::static_props(&bsp);
            let pm = dc.resolve_props(&pak, &sp);
            let mut prop_names = names.clone();
            prop_names.extend(pm.materials.iter().cloned());
            let (mats, _, _) = dc.resolve(&pak, &prop_names, &mut |_| None);
            let prop_missing: Vec<&String> = pm.materials.iter().zip(&mats.descs[names.len()..]).filter(|(_, d)| d.kind == Kind::Missing).map(|(n, _)| n).collect();
            println!(
                "    static props: {} instances of {} models ({} unbuildable), {} tris, {} materials ({} missing)",
                pm.instances,
                sp.models.len(),
                pm.missing_models.len(),
                pm.indices.len() / 3,
                pm.materials.len(),
                prop_missing.len()
            );
            if verbose {
                for m in &pm.missing_models {
                    println!("    unbuildable model: {m}");
                }
                for n in prop_missing {
                    println!("    prop material missing: {n}");
                }
            }
        }
        match after {
            Some((missing, sky_ok, rounds, read, decoded, textures)) => {
                println!(
                    "{name:<28} {:>9} {:>16} {:>16}  {sky} {sky_ok}/6   ({rounds} rounds, {:.1} MB read, {decoded}/{textures} textures decode)",
                    names.len(),
                    missing_before,
                    missing.len(),
                    read as f64 / 1e6
                );
                if verbose {
                    for n in missing {
                        println!("    still missing: {n}");
                    }
                }
            }
            None => println!("{name:<28} {:>9} {:>16} {:>16}  {sky}", names.len(), missing_before, "-"),
        }
    }
}
