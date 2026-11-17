//! Rendering-only map entities still receive Source I/O and replay snapshot restoration.
use bunnyhop_core::{Game, entities::Entity};

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn smoke_inputs_kill_and_snapshot_restore() {
    let path = bunnyhop_core::test_maps::bsp("bhop_arcane_v2");
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

#[cfg_attr(ci, ignore = "map library")]
#[test]
fn local_lights_toggle_kill_and_restore_with_no_movement_effect() {
    let path=bunnyhop_core::test_maps::bsp("bhop_arcane_v2");
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

/// CLight::Use: an output with no input name sends `Use` (CEventAction), which toggles a switchable light (style 32+).
#[cfg_attr(ci, ignore = "map library")]
#[test]
fn switchable_lights_take_use_and_unnamed_inputs() {
    let path = bunnyhop_core::test_maps::bsp("bhop_arcane_v2");
    if !path.exists() { return; }
    let bsp = bunnyhop_core::parse_bsp(&std::fs::read(path).unwrap()).unwrap();
    let mut list = bunnyhop_core::physics::entity_list_with_outputs(&bsp, true);
    let start = list.entities.len();
    for (name, style) in [("switched", "32"), ("plain", "0")] {
        list.entities.push(Entity { pairs: vec![("classname".into(), "light".into()), ("targetname".into(), name.into()), ("spawnflags".into(), "1".into()), ("style".into(), style.into())] });
        list.outputs.push(Vec::new());
    }
    let mut game = Game::load_with_entities(&bsp, None, list, false).unwrap();
    let on = |g: &Game, i: usize| g.effect_states().into_iter().find(|s| s.0 == i).unwrap().1;
    assert!(!on(&game, start));
    game.fire_input("switched", "", ""); assert!(on(&game, start));
    game.fire_input("switched", "Use", ""); assert!(!on(&game, start));
    // Style 0: CLight::Use does nothing.
    game.fire_input("plain", "", ""); game.fire_input("plain", "Use", ""); assert!(!on(&game, start + 1));
}

/// bhop_mine's mine section: its 24 `light1` lights start dark and the trigger on the first block ("light1,,,0,-1")
/// turns them on; a restart turns them off again.
#[cfg_attr(ci, ignore = "map library")]
#[test]
fn bhop_mine_lights_come_on_at_the_first_block() {
    use bunnyhop_core::Cmd;
    let Some(path) = bunnyhop_core::test_maps::map("bhop_mine") else { return };
    let bsp = bunnyhop_core::parse_bsp(&std::fs::read(path).unwrap()).unwrap();
    let list = bunnyhop_core::physics::entity_list_with_outputs(&bsp, true);
    let lights: Vec<usize> = list.entities.iter().enumerate().filter(|(_, e)| e.get("targetname") == Some("light1")).map(|(i, _)| i).collect();
    assert_eq!(lights.len(), 24);
    let mut game = Game::load_with_entities(&bsp, None, list, false).unwrap();
    let lit = |g: &Game| g.effect_states().into_iter().filter(|s| lights.contains(&s.0) && s.1).count();
    assert_eq!(lit(&game), 0);
    // Dropped onto the first block, where the trigger lies.
    game.set_position([5054.0, 6870.0, -150.0], 0.0);
    let mut ticks = 0;
    while lit(&game) == 0 && ticks < 100 {
        game.step(Cmd::default()).unwrap();
        ticks += 1;
    }
    assert_eq!(lit(&game), 24, "lights after {ticks} ticks");
    let snapshot = game.save_state();
    game.reset();
    assert_eq!(lit(&game), 0);
    game.restore_state(&snapshot);
    assert_eq!(lit(&game), 24);
}
