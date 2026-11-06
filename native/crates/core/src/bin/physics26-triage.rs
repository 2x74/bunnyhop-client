//! Reproducible local mechanic probes, using production physics 25 unless specified.
use bunnyhop_core::{Game,Settings,Cmd};
fn load(n:&str)->Game {let mut g=bunnyhop_core::content::load_game(std::path::Path::new(&format!("maps/{n}.bsp"))).unwrap();g.set_settings(Settings{physics_version:25,..Settings::css_bhop()});g.reset();g}
fn tick(g:&mut Game,n:usize){for _ in 0..n {g.step(Cmd::default()).unwrap();}}
fn main(){
 for n in ["bhop_alvo","bhop_trampislow","bhop_handsuplol","bhop_2_S4RO","bhop_3d"] {
 let mut g=load(n);println!("MAP {n} physics25");
 let ids:Vec<_>=g.entities.iter().enumerate().filter(|(_,e)|{
 let c=e.classname();c=="trigger_push" || (c=="trigger_multiple" && e.pairs.iter().any(|(_,v)|v.to_ascii_lowercase().contains("basevelocity"))) || (n=="bhop_alvo" && e.get("model")==Some("*56"))
 }).map(|(i,_)|i).collect();
 for i in ids {let e=g.entities[i].clone();let Some((lo,hi))=g.entity_bounds(i) else {continue};g.reset();let p=[(lo[0]+hi[0])*0.5,(lo[1]+hi[1])*0.5,lo[2]+1.0];g.place_player(p);
 if n=="bhop_alvo"{g.gravity_scale=-1.0;g.state.velocity=[0.0,0.0,200.0];}
 tick(&mut g,8);let b=g.state.base_velocity;let v=g.state.velocity;let events=g.events;
 // Clear the hull away from an OnEndTouch booster, without clearing its links.
 g.place_player([hi[0]+64.0,hi[1]+64.0,hi[2]+100.0]);tick(&mut g,8);
 println!("entity {i} {} {:?} bounds {lo:?}..{hi:?} enter base {b:?} vel {v:?} events {events} exit base {:?} exit vel {:?} gravity {} name {:?}",e.classname(),e.get("model"),g.state.base_velocity,g.state.velocity,g.gravity_scale,g.player_name);
 if e.get("filtername")==Some("upboost_filter"){g.reset();g.player_name="upboost".into();g.place_player(p);tick(&mut g,1);println!("  named upboost base {:?}",g.state.base_velocity);}
 }
 if n=="bhop_3d" {let (all,tele)=g.bhop_block_stats();println!("bhop blocks {all}, linked fail teleports {tele}");for t in g.teleports().iter().take(3){println!("tele {} {:?}..{:?}",t.target,t.mins,t.maxs);}}
 }
}
