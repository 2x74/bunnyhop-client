//! Rendering-only map entities still receive Source I/O and replay snapshot restoration.
use bunnyhop_core::{Game, entities::Entity};

#[test]
fn smoke_inputs_kill_and_snapshot_restore() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps/bhop_arcane_v2.bsp");
    if !path.exists() { eprintln!("Arcane map unavailable; skipping asset integration test"); return; }
    let bytes = std::fs::read(&path).unwrap();
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let mut list = bunnyhop_core::physics::entity_list_with_outputs(&bsp, true);
    let index = list.entities.len();
    list.entities.push(Entity { pairs: vec![("classname".into(), "env_smokestack".into()), ("targetname".into(), "test_smoke".into()), ("InitialState".into(), "0".into())] });
    list.outputs.push(Vec::new());
    let mut game = Game::load_with_entities(&bsp, None, list, false).unwrap();
    let enabled = |g: &Game| g.effect_states().into_iter().find(|s| s.0 == index).unwrap().1;
    assert!(!enabled(&game));
    game.fire_input("test_smoke", "TurnOn", ""); assert!(enabled(&game));
    let snapshot = game.save_state();
    game.fire_input("test_smoke", "Toggle", ""); assert!(!enabled(&game));
    game.fire_input("test_smoke", "Enable", ""); assert!(enabled(&game));
    game.fire_input("test_smoke", "Kill", ""); assert!(!enabled(&game));
    game.restore_state(&snapshot); assert!(enabled(&game));
    game.fire_input("test_smoke", "Disable", ""); assert!(!enabled(&game));
}

#[test]
fn local_lights_toggle_kill_and_restore_with_no_movement_effect() {
    let path=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps/bhop_arcane_v2.bsp");
    if !path.exists() { return; }
    let bsp=bunnyhop_core::parse_bsp(&std::fs::read(path).unwrap()).unwrap();
    let mut list=bunnyhop_core::physics::entity_list_with_outputs(&bsp,true);
    let start=list.entities.len();
    for (class,name,flags) in [("light","static_test","1"),("light_spot","spot_test","1"),("light_dynamic","dynamic_test","0")] {
        list.entities.push(Entity{pairs:vec![("classname".into(),class.into()),("targetname".into(),name.into()),("spawnflags".into(),flags.into())]});list.outputs.push(Vec::new());
    }
    let mut game=Game::load_with_entities(&bsp,None,list,false).unwrap();
    let states=game.effect_states();assert!(!states.iter().find(|s|s.0==start).unwrap().1);assert!(states.iter().find(|s|s.0==start+2).unwrap().1);
    let snapshot=game.save_state();
    for name in ["static_test","spot_test","dynamic_test"] {game.fire_input(name,"TurnOn","");}
    assert!(game.effect_states().into_iter().filter(|s|s.0>=start).all(|s|s.1));
    game.fire_input("dynamic_test","Toggle","");game.fire_input("static_test","Kill","");
    assert!(!game.effect_states().iter().find(|s|s.0==start+2).unwrap().1);
    game.restore_state(&snapshot);assert!(!game.effect_states().iter().find(|s|s.0==start).unwrap().1);assert!(game.effect_states().iter().find(|s|s.0==start+2).unwrap().1);
}
