//! Static prop geometry audit: flags triangles whose edges are long relative to the model's bounds
//! (vertex index / fixup bugs show up as thin triangles stretching across the map).
//!
//! usage: propaudit --content <CS:S install root> [-v] <map.bsp>...
//! Exits non-zero if any model is flagged.
use bunnyhop_core::content::{self, DiskContent};
use bunnyhop_core::props;

fn main() {
    let mut root = None;
    let mut verbose = false;
    let mut near: Option<Vec<f32>> = None;
    let mut maps = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--content" => root = args.next(),
            "-v" => verbose = true,
            "--near" => near = args.next().map(|s| s.split(',').map(|x| x.parse::<f32>().unwrap()).collect::<Vec<_>>()),
            _ => maps.push(a),
        }
    }
    let mut dc = DiskContent::open(std::path::Path::new(&root.expect("--content <install>"))).unwrap();
    let (mut bad_maps, mut total_models, mut built_models) = (0, 0, 0);
    for path in &maps {
        let bytes = std::fs::read(path).unwrap();
        let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
        let sp = props::static_props(&bsp);
        if sp.models.is_empty() {
            continue;
        }
        if let Some(n) = &near {
            // Debug: prop instances within n[3] units of (n[0], n[1], n[2]).
            for (i, p) in sp.props.iter().enumerate() {
                let d = ((p.origin[0] - n[0]).powi(2) + (p.origin[1] - n[1]).powi(2) + (p.origin[2] - n[2]).powi(2)).sqrt();
                if d < n[3] {
                    println!("  #{i} {} at {:?} angles {:?} skin {} (dist {d:.0})", sp.models[p.model], p.origin, p.angles, p.skin);
                }
            }
        }
        let pak = content::pakfile(&bsp);
        dc.resolve_props(&pak, &sp);
        let vfs = dc.vfs(pak);
        let mut lines = Vec::new();
        let mut nbad = 0;
        for m in &sp.models {
            total_models += 1;
            let [a, b, c] = props::model_files(m);
            let (Some(mdl), Some(vvd), Some(vtx)) = (vfs.read(&a), vfs.read(&b), vfs.read(&c)) else { continue };
            let Some(geo) = props::model_geometry(mdl, vvd, vtx) else {
                lines.push(format!("  {m}: unparsable"));
                continue;
            };
            built_models += 1;
            let r = props::audit_geometry(mdl, &geo);
            if r.bad_tris > 0 {
                nbad += 1;
            }
            if r.bad_tris > 0 || verbose {
                lines.push(format!(
                    "  {m}: {} verts, {} tris, {} long-edge tris, {} verts outside bounds (max edge {:.0}, bounds {:.0})",
                    geo.vertices.len(),
                    r.tris,
                    r.bad_tris,
                    r.outside,
                    r.max_edge,
                    r.size
                ));
            }
        }
        let name = std::path::Path::new(path).file_stem().unwrap().to_string_lossy().into_owned();
        if nbad > 0 {
            bad_maps += 1;
        }
        println!("{name}: {} models, {nbad} flagged", sp.models.len());
        for l in lines {
            println!("{l}");
        }
    }
    println!("{built_models}/{total_models} models built; {bad_maps} maps with flagged props");
    if bad_maps > 0 {
        std::process::exit(1);
    }
}
