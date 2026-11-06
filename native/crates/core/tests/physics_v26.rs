//! Exact-build qualification, including edited collision rejection and legacy caps.
use bunnyhop_core::{Game,Settings,Cmd};
use bunnyhop_core::game::{map_build_v26_for,map_build_digest_v25,map_entity_fingerprint};
const MAPS: [&str;5] = ["ahop_coast","bhop_frankerz_999xl_extreme","bhop_frankerz_2500xl_easyxtreme","bhop_frankerz_999xl_extreme_sr","bhop_crash_egypt"];
fn bytes(n: &str)->Vec<u8> {std::fs::read(format!("{}/../../maps/{n}.bsp",env!("CARGO_MANIFEST_DIR"))).unwrap()}
fn game(raw:&[u8],version:u32)->Game {let b=bunnyhop_core::parse_bsp(raw).unwrap();let mut g=Game::load(&b).unwrap();g.set_settings(Settings{physics_version:version,..Settings::css_bhop()});g.reset();g}
#[test]
fn full_and_verifier_entity_parses_share_the_reviewed_digest() {
 for n in MAPS { let raw=bytes(n);let b=bunnyhop_core::parse_bsp(&raw).unwrap();let a=bunnyhop_core::physics::entity_list_with_outputs(&b,true);let v=bunnyhop_core::physics::entity_list_with_outputs(&b,false);assert_eq!(map_build_v26_for(&b,&a),Some(n));assert_eq!(map_build_v26_for(&b,&v),Some(n));assert_eq!(map_build_digest_v25(&b,&a),map_build_digest_v25(&b,&v));eprintln!("{n} {:08x} {}",map_entity_fingerprint(&a.entities),map_build_digest_v25(&b,&a)); }
}
#[test]
fn changed_collision_and_output_inputs_receive_no_build_specific_behavior() {
 for n in MAPS { let raw=bytes(n);let bsp=bunnyhop_core::parse_bsp(&raw).unwrap();let mut planes=bsp.lump(1).unwrap().bytes(&bsp).to_vec();let n=planes.len();planes[n-4]^=1;let mut changed=raw.clone();let offset=changed.len() as i32;changed[24..28].copy_from_slice(&offset.to_le_bytes());changed[28..32].copy_from_slice(&(planes.len() as i32).to_le_bytes());changed[36..40].fill(0);changed.extend(planes);let b=bunnyhop_core::parse_bsp(&changed).unwrap();let list=bunnyhop_core::physics::entity_list_with_outputs(&b,true);assert_eq!(map_build_v26_for(&b,&list),None);assert_eq!(game(&changed,26).max_velocity(),3500.0);
 let b=bunnyhop_core::parse_bsp(&raw).unwrap();let mut list=bunnyhop_core::physics::entity_list_with_outputs(&b,true);let output=list.outputs.iter_mut().find_map(|es|es.first_mut()).unwrap();output.delay+=0.125;assert_eq!(map_build_v26_for(&b,&list),None);
 }
}
#[test]
fn frankerz_cap_is_per_axis_and_v25_is_retained() {
 for n in &MAPS[1..4] {let raw=bytes(n);let mut g=game(&raw,26);assert_eq!(g.max_velocity(),100_000.0);g.place_player([-14000.0,0.0,15000.0]);g.state.velocity=[150_000.0,-150_000.0,150_000.0];g.step(Cmd::default()).unwrap();assert!(g.state.velocity.iter().all(|x|x.is_finite() && x.abs()<=100_000.0));for v in 1..=25 { g.set_settings(Settings{physics_version:v,..Settings::css_bhop()});assert_eq!(g.max_velocity(),3500.0,"{n} v{v}"); } }
}
#[test]
fn high_speed_actual_terminal_teleports_catch_the_player() {
 for n in &MAPS[1..4] {let raw=bytes(n);let mut g=game(&raw,26);let ts=g.teleports();let mut caught=0;let mut attempted=0;
 for t in ts.iter().filter(|t|t.destination.is_some()) {g.reset();let p=[(t.mins[0]+t.maxs[0])*0.5,t.mins[1]-750.0,(t.mins[2]+t.maxs[2])*0.5];g.place_player(p);g.state.velocity=[0.0,100_000.0,0.0];g.step(Cmd::default()).unwrap();attempted+=1;if g.events & bunnyhop_core::game::EVENT_TELEPORTED!=0 {caught+=1;}}
 eprintln!("{n} 100k terminal catches {caught}/{attempted}");assert_eq!(caught,attempted);
 }
}
