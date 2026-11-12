//! Animated props (`game/prop_anims.rs`): the prop_dynamics the client poses and what the map's I/O asks them to play.
//! Display only: the inputs, and the props' own render groups, must not change the run.
//!
//! Needs the maps in maps/ (gitignored); each test skips when its map is absent.

use bunnyhop_core::game::{PHYSICS_LATEST, PROP_ANIM_HIDDEN, PROP_ANIM_REMOVED};
use bunnyhop_core::{Cmd, Game, Settings};

fn load(name: &str) -> Option<Game> {
    let path = bunnyhop_core::test_maps::bsp(name);
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping: {} not found", path.display());
        return None;
    };
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let mut game = Game::load(&bsp).unwrap();
    game.set_settings(Settings { physics_version: PHYSICS_LATEST, ..Settings::css_bhop() });
    game.reset();
    Some(game)
}

const IDLE: Cmd = Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 0.0, buttons: 0 };

/// bhop_ceaseless: the 14 butterflies (`babochka*`, DefaultAnim run..run8) are animated props, drawn on their own.
#[test]
fn ceaseless_butterflies_are_animated_props() {
    let Some(g) = load("bhop_ceaseless") else { return };
    let anims: Vec<_> = g.prop_anim_states().filter(|(p, ..)| g.entities[p.ent as usize].get("model").is_some_and(|m| m.contains("butterfly"))).map(|(p, flags, ..)| (p.ent, p.anim.clone(), flags)).collect();
    assert_eq!(anims.len(), 14, "{anims:?}");
    assert!(anims.iter().all(|(_, a, f)| a.starts_with("run") && *f == 0));
    let owners: Vec<u32> = g.render_props_with(true).iter().filter(|p| p.0.contains("butterfly")).map(|p| p.4).collect();
    assert_eq!(owners.len(), 14);
    assert!(owners.iter().all(|&o| o != 0), "butterflies get their own groups");
    // A consumer that doesn't opt in (native before porting map props) bakes them as before: no owner.
    assert!(g.render_props().iter().filter(|p| p.0.contains("butterfly")).all(|p| p.4 == 0));
    let moving: Vec<usize> = g.moving_prop_transforms().iter().map(|t| t.0).collect();
    for (ent, ..) in &anims {
        assert!(g.is_animated_prop(*ent as usize));
        assert!(moving.contains(&(*ent as usize)), "every animated prop is placed by prop_transforms");
    }
}

/// Animation inputs change what the client reads and nothing else: the simulation digest is the same with and without.
#[test]
fn inputs_are_display_only() {
    let Some(mut a) = load("bhop_ceaseless") else { return };
    let Some(mut b) = load("bhop_ceaseless") else { return };
    let serial = a.prop_anim_serial();
    for _ in 0..100 {
        a.step(IDLE).unwrap();
        b.step(IDLE).unwrap();
    }
    a.fire_input("babochka1", "SetPlaybackRate", "2");
    a.fire_input("babochka2", "SetAnimation", "run4");
    a.fire_input("babochka3", "SetDefaultAnimation", "run");
    a.fire_input("babochka4", "TurnOff", "");
    a.fire_input("babochka5", "Kill", "");
    for _ in 0..200 {
        a.step(IDLE).unwrap();
        b.step(IDLE).unwrap();
    }
    // Kill is the one input that touches the simulation's entity state (`removed`, as for every entity).
    b.fire_input("babochka5", "Kill", "");
    b.step(IDLE).unwrap();
    a.step(IDLE).unwrap();
    assert_eq!(a.snapshot_bytes(), b.snapshot_bytes());
    assert_ne!(a.prop_anim_serial(), serial);
    let dt = a.settings.tick_interval;
    let by = |name: &str| {
        let i = a.entities.iter().position(|e| e.get("targetname") == Some(name)).unwrap() as u32;
        a.prop_anim_states().find(|s| s.0.ent == i).map(|(p, f, base, since, rate)| (p.anim.clone(), p.default_anim.clone(), f, base, since, rate)).unwrap()
    };
    let (_, _, _, base, since, rate) = by("babochka1");
    assert_eq!(rate, 2.0);
    assert!((since - 100.0 * dt).abs() < 1e-3 && (base - 100.0 * dt).abs() < 1e-3, "rate change keeps the sequence time ({base}, {since})");
    let (anim, _, _, base, since, rate) = by("babochka2");
    assert_eq!((anim.as_str(), base, rate), ("run4", 0.0, 1.0));
    assert!((since - 100.0 * dt).abs() < 1e-3);
    assert_eq!(by("babochka3").1, "run");
    assert_eq!(by("babochka4").2, PROP_ANIM_HIDDEN);
    assert_eq!(by("babochka5").2 & PROP_ANIM_REMOVED, PROP_ANIM_REMOVED);
}

/// Restart and snapshots bring the animation state back.
#[test]
fn reset_and_snapshots_restore_the_state() {
    let Some(mut g) = load("bhop_ceaseless") else { return };
    let snap = g.save_state();
    g.fire_input("babochka1", "SetAnimation", "run2");
    let changed = |g: &Game| g.prop_anim_states().any(|(p, ..)| p.anim == "run2" && p.default_anim == "run");
    assert!(changed(&g));
    let serial = g.prop_anim_serial();
    g.restore_state(&snap);
    assert!(!changed(&g));
    assert_ne!(g.prop_anim_serial(), serial, "the client has to notice a restore");
    g.fire_input("babochka1", "SetAnimation", "run2");
    g.reset();
    assert!(!changed(&g));
}

/// The props contract for consumers (native's map setup is `static_props → add_props(render_props()) → mark_props →
/// build`): without opting in, animated props are baked exactly as before; with `add_game_props(.., true)` they're
/// dynamic groups whose vertices, placed at the prop's transform, are that same frozen geometry (Sol's review: the
/// owner without `Prop::animated` moved bhop_crash_egypt's scarab / warp_sphere vertices by up to 104 units).
#[test]
fn frozen_fallback_is_unchanged_with_and_without_opting_in() {
    use bunnyhop_core::props::{self, PROP_VERTEX_FLOATS};
    use bunnyhop_core::vfs::{Source, Vfs};
    for map in ["bhop_ceaseless", "bhop_crash_egypt"] {
        let path = bunnyhop_core::test_maps::bsp(map);
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
        let Some(g) = load(map) else { continue };
        let mut vfs = Vfs::default();
        vfs.mount(Source::from_zip("pak", bunnyhop_core::content::pakfile(&bsp)));
        let build = |animate: bool| {
            let mut sp = props::static_props(&bsp);
            let n = sp.props.len();
            if animate {
                props::add_game_props(&mut sp, &g, true);
            } else {
                props::add_props(&mut sp, g.render_props());
            }
            bunnyhop_core::skybox::mark_props(&bsp, &mut sp, n);
            props::build(&sp, &vfs)
        };
        let (old, new) = (build(false), build(true));
        let mut checked = 0;
        for (ent, ..) in g.prop_anim_states().map(|(p, ..)| (p.ent as usize,)).collect::<Vec<_>>() {
            // Non-solid animated children are newly drawn; there is no previous frozen bake to compare.
            if g.entities[ent].get("parentname").is_some_and(|n| !n.is_empty()) { continue; }
            let groups: Vec<_> = new.dynamic_groups.iter().filter(|d| d[0] as usize == ent).collect();
            if groups.is_empty() {
                continue; // not drawn on its own (parented, model missing from the pakfile, 3D skybox)
            }
            assert!(!old.dynamic_groups.iter().any(|d| d[0] as usize == ent), "{map} {ent}: no owner without opting in");
            let (o, a) = g.moving_prop_transforms().into_iter().find(|t| t.0 == ent).map(|t| (t.1, t.2)).unwrap();
            // Source AngleMatrix (pitch about y, yaw about z, roll about x).
            let (sp_, cp) = a[0].to_radians().sin_cos();
            let (sy, cy) = a[1].to_radians().sin_cos();
            let (sr, cr) = a[2].to_radians().sin_cos();
            let r = [[cp * cy, sr * sp_ * cy - cr * sy, cr * sp_ * cy + sr * sy], [cp * sy, sr * sp_ * sy + cr * cy, cr * sp_ * sy - sr * cy], [-sp_, sr * cp, cr * cp]];
            let placed = |v: &[f32]| [0, 1, 2].map(|i| r[i][0] * v[0] + r[i][1] * v[1] + r[i][2] * v[2] + o[i]);
            // Every placed vertex of the new group is a vertex of the old static mesh (to float rounding).
            let old_verts: Vec<[f32; 3]> = old.vertices.chunks(PROP_VERTEX_FLOATS).map(|v| [v[0], v[1], v[2]]).collect();
            // Index the frozen bake spatially: keep the 0.05-unit comparison without an O(vertices²) scan.
            let mut cells = std::collections::HashMap::<[i32; 3], Vec<[f32; 3]>>::new();
            for q in old_verts { cells.entry(q.map(|v| (v / 0.05).floor() as i32)).or_default().push(q); }
            for d in groups {
                for k in d[2]..d[2] + d[3] {
                    let vi = new.indices[k as usize] as usize * PROP_VERTEX_FLOATS;
                    let p = placed(&new.vertices[vi..vi + 3]);
                    let cell = p.map(|v| (v / 0.05).floor() as i32);
                    let near = (-1..=1).any(|x| (-1..=1).any(|y| (-1..=1).any(|z| {
                        cells.get(&[cell[0]+x,cell[1]+y,cell[2]+z]).is_some_and(|qs| qs.iter().any(|q| (0..3).all(|i| (q[i]-p[i]).abs()<0.05)))
                    })));
                    assert!(near, "{map} entity {ent}: vertex {p:?} isn't in the frozen bake");
                }
            }
            checked += 1;
        }
        eprintln!("{map}: {checked} animated props match their frozen bake");
        assert!(checked > 0, "{map}: no animated props checked");
    }
}

#[test]
fn body_and_skin_inputs_are_display_only_and_restore() {
    let mut a = load("bhop_crash_egypt").expect("required Crash Egypt BSP");
    let mut b = load("bhop_crash_egypt").unwrap();
    let snap = a.save_state();
    a.fire_input("Crate_generic1", "SetBodyGroup", "7");
    a.fire_input("Crate_tnt1", "Skin", "9");
    assert_eq!(a.snapshot_bytes(), b.snapshot_bytes());
    for _ in 0..50 { a.step(IDLE).unwrap(); b.step(IDLE).unwrap(); }
    assert_eq!(a.snapshot_bytes(), b.snapshot_bytes());
    assert_eq!(a.prop_anim_states().find(|(p,..)| p.ent == 968).unwrap().0.body,7);
    assert_eq!(a.prop_anim_states().find(|(p,..)| p.ent == 625).unwrap().0.skin,9);
    a.restore_state(&snap);
    assert_eq!(a.prop_anim_states().find(|(p,..)| p.ent == 968).unwrap().0.body,0);
    assert_eq!(a.prop_anim_states().find(|(p,..)| p.ent == 625).unwrap().0.skin,7);
}

#[test]
fn tomb_rendering_uses_the_existing_solid_train_without_adding_prop_collision() {
    let mut g = load("bhop_crash_egypt").expect("required Crash Egypt BSP");
    for (prop, train) in [(1222,1225),(1226,1227),(1231,1230)] {
        assert!(g.render_props_with(true).iter().any(|p| p.4 == prop as u32+1));
        assert!(!g.render_props().iter().any(|p| p.4 == prop as u32+1));
        assert_eq!(g.entities[prop].int("solid"),0);
        assert_eq!(g.entities[train].int("spawnflags"),512);
    }
    let before = g.moving_prop_transforms();
    for _ in 0..150 { g.step(IDLE).unwrap(); }
    let after = g.moving_prop_transforms();
    for i in [1222,1226,1231] {
        let a = before.iter().find(|p| p.0==i).unwrap().1;
        let b = after.iter().find(|p| p.0==i).unwrap().1;
        assert_ne!(a,b,"tomb {i} follows the already moving train");
    }
    assert!(g.brush_states().iter().any(|(m,_,solid)| *m==415 && *solid));
}

#[test]
fn packed_crate_has_fourteen_distinct_debris_bodies_and_tnt_skins() {
    use bunnyhop_core::{studio::{self, Load}, vfs::{Vfs, Source}};
    let raw = std::fs::read(bunnyhop_core::test_maps::bsp("bhop_crash_egypt")).unwrap();
    let bsp = bunnyhop_core::parse_bsp(&raw).unwrap();
    let mut vfs = Vfs::default(); vfs.mount(Source::from_zip("pak", bunnyhop_core::content::pakfile(&bsp)));
    let Load::Ready(model) = studio::load(&vfs,"models/dofke/crash bandicoot/props/crates/crate_generic.mdl") else { panic!("packed model") };
    assert_eq!(model.mesh.bodies.len(),16);
    assert_eq!(model.skins.len(),17);
    for body in 1..=14 { assert!(!model.mesh.bodies[body].is_empty()); }
    assert!(model.mesh.bodies[15].is_empty());
    assert_ne!(model.skins[8],model.skins[9]); assert_ne!(model.skins[9],model.skins[10]);
    let json=model.info_json(); assert!(json.contains("\"bodies\":["));
}

#[test]
fn authored_crate_and_tnt_io_drive_all_frames_countdown_and_particle_start() {
    let mut g = load("bhop_crash_egypt").expect("required Crash Egypt BSP");
    g.set_position([96.0,1408.0,-255.0],0.0);
    let mut frames = std::collections::BTreeSet::new();
    for _ in 0..65 {
        g.step(IDLE).unwrap();
        frames.insert(g.prop_anim_states().find(|(p,..)|p.ent==968).unwrap().0.body);
    }
    assert_eq!(frames,(0..=14).collect());
    assert!(!g.entity_visible(968));
    assert!(g.entity_instances().any(|(_,source,..)|source==958));
    g.reset();g.set_position([2656.0,8480.0,-367.0],0.0);
    let mut skins=std::collections::BTreeSet::new();
    let mut particle_at=None;
    for _ in 0..480 {
        g.step(IDLE).unwrap();
        skins.insert(g.prop_anim_states().find(|(p,..)|p.ent==625).unwrap().0.skin);
        if particle_at.is_none() && g.prop_anim_states().any(|(p,flags,..)|p.anim=="Explosion_Tnt" && p.set && flags & PROP_ANIM_REMOVED==0) { particle_at=Some(g.tick); }
    }
    assert_eq!(skins,[7,8,9,10].into_iter().collect());
    assert!(particle_at.is_some_and(|t|(416..=420).contains(&t)),"{particle_at:?}");
    assert!(!g.entity_visible(625));
    let snap=g.save_state();
    for _ in 0..100 {g.step(IDLE).unwrap();}
    g.restore_state(&snap);
    assert!(g.prop_anim_states().any(|(p,..)|p.anim=="Explosion_Tnt" && p.set));
    g.reset();
    assert!(!g.prop_anim_states().any(|(p,..)|p.anim=="Explosion_Tnt" && p.set));
}
