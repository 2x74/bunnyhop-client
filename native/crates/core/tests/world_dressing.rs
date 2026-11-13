//! Overlays, infodecals, glows and beams for the renderer (dressing.rs), read from real maps (see `test_maps`).

use bunnyhop_core::dressing::{GlowKind, VERTEX_FLOATS};
use bunnyhop_core::{mesh, parse_bsp, test_maps};

fn load(name: &str) -> Option<playsrc_bsp::Bsp> {
    let path = test_maps::map(name)?;
    Some(parse_bsp(&std::fs::read(path).unwrap()).unwrap())
}

/// (Triangles facing the way their face does, all triangles): dressing is wound like the world under it.
fn on_faces(m: &mesh::Mesh) -> (usize, usize) {
    let d = &m.dressing;
    let (mut ok, mut all) = (0, 0);
    for t in d.indices.chunks_exact(3) {
        all += 1;
        let v = |i: u32| &d.vertices[i as usize * VERTEX_FLOATS..(i as usize + 1) * VERTEX_FLOATS];
        let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
        // Corners share the face normal (flat faces) and the triangle isn't degenerate.
        let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        // (Slivers along a clip edge have no usable facing.)
        if (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt() < 0.01 || n[0] * a[3] + n[1] * a[4] + n[2] * a[5] > 0.0 {
            ok += 1;
        }
    }
    (ok, all)
}

#[test]
fn overlays_follow_their_faces() {
    let Some(bsp) = load("bhop_lost_world") else { return };
    let m = mesh::build(&bsp);
    let d = &m.dressing;
    let overlays: Vec<_> = d.groups.iter().filter(|g| g.kind == 0).collect();
    assert!(!overlays.is_empty());
    // Every triangle faces the way its face does (front faces, as the world mesh winds them).
    let (ok, all) = on_faces(&m);
    assert_eq!(ok, all, "{ok} of {all} overlay triangles face out");
    // Texture coordinates stay within the overlays' own ranges (Hammer's 0..1 here).
    for v in d.vertices.chunks_exact(VERTEX_FLOATS) {
        assert!((-0.01..=1.01).contains(&v[6]) && (-0.01..=1.01).contains(&v[7]), "uv {} {}", v[6], v[7]);
    }
    // Groups are in draw order: overlays by render order, then decals.
    let keys: Vec<_> = d.groups.iter().map(|g| (g.kind, g.sky3d, g.order, g.material)).collect();
    let mut sorted = keys.clone();
    sorted.sort();
    assert_eq!(keys, sorted);
}

#[test]
fn infodecals_take_their_size_from_the_material() {
    let Some(bsp) = load("bhop_lost_world") else { return };
    let mut m = mesh::build(&bsp);
    // Without sizes (content not loaded yet) no decal is built.
    assert!(m.dressing.groups.iter().all(|g| g.kind == 0));
    m.dressing.build(&|_| Some([64.0, 32.0]));
    let decals: Vec<_> = m.dressing.groups.iter().filter(|g| g.kind == 1).collect();
    assert!(decals.len() > 1, "{} decal groups", decals.len());
    let tris: u32 = decals.iter().map(|g| g.index_count / 3).sum();
    assert!(tris >= 268, "{tris} decal triangles for 268 infodecals");
    // A decal covers at most its own 64 x 32 rectangle on each face it lands on.
    let (ok, all) = on_faces(&m);
    assert_eq!(ok, all, "{ok} of {all} decal triangles face out");
}

#[test]
fn glows_and_beams() {
    if let Some(bsp) = load("bhop_rpg") {
        let m = mesh::build(&bsp);
        let sprites = m.dressing.glows.iter().filter(|g| g.kind == GlowKind::Sprite).count();
        assert!(sprites > 400 && sprites <= 819, "{sprites} sprites");
    }
    let Some(bsp) = load("bhop_playboy_csgo") else { return };
    let m = mesh::build(&bsp);
    let spots: Vec<_> = m.dressing.glows.iter().filter(|g| g.kind == GlowKind::Spotlight).collect();
    assert!(!spots.is_empty());
    // Every beam ends at what it hits, never past its length.
    for s in &spots {
        assert!(s.size2 >= 0.0 && s.size2 <= 500.0 + 1e-3);
        assert_eq!(m.dressing.materials[s.material as usize], "sprites/glow_test02");
    }
    assert!(spots.iter().any(|s| s.size2 > 0.0));
}

#[test]
fn glow_visibility_sees_past_invisible_brushes_only() {
    let Some(bsp) = load("bhop_lost_world") else { return };
    let m = mesh::build(&bsp);
    let light = m.lighting.as_ref().expect("bhop_lost_world has trace data");
    // From just in front of each glow's origin, it can be seen; nothing hides it from far outside the world.
    let mut checked = 0;
    for g in m.dressing.glows.iter().filter(|g| g.parent_model < 0) {
        let eye = [g.origin[0], g.origin[1], g.origin[2] - 1.0];
        if light.hit(eye, eye).is_some() {
            continue; // in a brush
        }
        assert!(light.hit_seen(eye, g.visibility_target(eye)).is_none());
        checked += 1;
    }
    assert!(checked > 0);
    // Drawn brushes are a subset of opaque ones: a ray the full trace passes, the view's passes too.
    let a = [132.0, -872.0, 116.0];
    for g in &m.dressing.glows {
        let t = g.visibility_target(a);
        if light.hit(a, t).is_none() {
            assert!(light.hit_seen(a, t).is_none());
        }
    }
}
