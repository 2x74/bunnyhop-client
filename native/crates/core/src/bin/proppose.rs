//! Entity prop pose audit: which entity props the engine draws in another pose than the model's bind pose, because their
//! idle sequence (sequence 0, frame 0) moves the root bone (`studio::root_pose_correction`). One line per class + model +
//! map: map, class, model, count, DefaultAnim, the correction matrix, and how far the model's `.phy` collision bounds are
//! from its bounds in the bind pose and in the idle pose (the engine uses the `.phy` as it is, so it tells the poses apart).
//!
//! usage: proppose --content <CS:S install root> <map.bsp>...
use bunnyhop_core::content::{self, DiskContent};
use bunnyhop_core::props;

fn main() {
    let mut root = None;
    let mut maps = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--content" => root = args.next(),
            _ => maps.push(a),
        }
    }
    let mut dc = DiskContent::open(std::path::Path::new(&root.expect("--content <install>"))).unwrap();
    for path in &maps {
        let Ok(bytes) = std::fs::read(path) else {
            println!("{path}: unreadable");
            continue;
        };
        let Ok(bsp) = bunnyhop_core::parse_bsp(&bytes) else {
            println!("{path}: unparsable");
            continue;
        };
        let name = std::path::Path::new(path).file_stem().unwrap().to_string_lossy().to_string();
        let entities = bunnyhop_core::physics::entity_list(&bsp);
        let mut sp = props::StaticProps::default();
        let mut rows: Vec<(String, String, String)> = Vec::new();
        for e in &entities {
            let class = e.classname().to_ascii_lowercase();
            if !(class.starts_with("prop_dynamic") || class.starts_with("prop_physics") || class == "prop_door_rotating" || class == "prop_ragdoll") {
                continue;
            }
            let Some(model) = e.get("model").filter(|m| m.to_ascii_lowercase().ends_with(".mdl")) else { continue };
            let model = model.replace('\\', "/").to_ascii_lowercase();
            rows.push((class, model.clone(), e.get("defaultanim").or(e.get("DefaultAnim")).unwrap_or("").to_string()));
            props::add_props(&mut sp, [(model, [0.0; 3], [0.0; 3], 0, 0)]);
        }
        if rows.is_empty() {
            continue;
        }
        let pak = content::pakfile(&bsp);
        dc.resolve_props(&pak, &sp);
        dc.fetch_paths(&pak, &sp.models.iter().map(|m| format!("{}.phy", m.strip_suffix(".mdl").unwrap_or(m))).collect::<Vec<_>>());
        let vfs = dc.vfs(pak);
        rows.sort();
        rows.dedup();
        for (class, model, anim) in rows {
            let [mdl, ..] = props::model_files(&model);
            let Some(bytes) = vfs.read(&mdl) else {
                println!("{name} {class} {model} MISSING");
                continue;
            };
            if let Some(m) = bunnyhop_core::studio::root_pose_correction(bytes) {
                let bounds = |verts: &mut dyn Iterator<Item = [f32; 3]>| {
                    let (mut lo, mut hi) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
                    for v in verts {
                        for k in 0..3 {
                            lo[k] = lo[k].min(v[k]);
                            hi[k] = hi[k].max(v[k]);
                        }
                    }
                    (lo, hi)
                };
                let [_, vvd, vtx] = props::model_files(&model);
                let geo = vfs.read(&vvd).zip(vfs.read(&vtx)).and_then(|(vvd, vtx)| props::model_geometry(bytes, vvd, vtx));
                let phy = bunnyhop_core::physics::model_collision_bounds(&vfs, &model);
                let fit = geo.as_ref().zip(phy).map(|(geo, phy)| {
                    let bind = bounds(&mut geo.vertices.iter().map(|v| [v[0], v[1], v[2]]));
                    let posed = bounds(&mut geo.vertices.iter().map(|v| [0, 1, 2].map(|i| m[i * 4] * v[0] + m[i * 4 + 1] * v[1] + m[i * 4 + 2] * v[2] + m[i * 4 + 3])));
                    let err = |b: ([f32; 3], [f32; 3])| (0..3).map(|k| (b.0[k] - phy.0[k]).abs() + (b.1[k] - phy.1[k]).abs()).sum::<f32>();
                    (err(bind), err(posed))
                });
                let n = entities.iter().filter(|e| e.classname().eq_ignore_ascii_case(&class) && e.get("model").is_some_and(|x| x.replace('\\', "/").eq_ignore_ascii_case(&model))).count();
                let fit = fit.map_or("phy=none".to_string(), |(b, p)| format!("phy_err_bind={b:.1} phy_err_idle={p:.1}"));
                let bones = if bunnyhop_core::studio::idle_pose_is_rigid(bytes) { "rigid" } else { "skeleton" };
                println!("{name} {class} {model} x{n} anim={anim:?} {bones} {fit} {:?}", m.map(|v| (v * 1000.0).round() / 1000.0));
            }
        }
    }
}
