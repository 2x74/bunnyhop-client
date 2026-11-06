//! Identify the static-prop support under bhop_gofuckyourself's side routes.
use bunnyhop_core::physics;
use playsrc_collision::Hull;
fn main(){
 let path=std::path::Path::new("maps/bhop_gofuckyourself.bsp");let raw=std::fs::read(path).unwrap();let bsp=bunnyhop_core::parse_bsp(&raw).unwrap();let p=physics::build_with(&bsp,bunnyhop_core::content::cached_physics_content(path)).unwrap();
 println!("sources {} props {} diagnostics {:?}",p.prop_sources.len(),p.props.brushes.len(),p.diagnostics);
 let g=bunnyhop_core::content::load_game(path).unwrap();
 for y in [-9000.0,-5000.0,0.0,5000.0,9000.0] {for x in [160.0,176.0,192.0,210.0,960.0,975.0,992.0,576.0]{let a=[x,y,-150.0];let b=[x,y,-500.0];let h=Hull{mins:[0.0;3],maxs:[0.0;3]};let full=g.trace_player_hull(a,b);println!("FULL x {x} y {y} {:?}",full);if let Some(t)=p.props.trace(a,b,h){let tag=t.brush.map(|i|p.props.brushes[i].prop);let src=tag.and_then(|tag|p.prop_sources.iter().find(|s|s.tag==tag));println!("x {x} y {y} z {} normal {:?} prop {tag:?} model {:?} origin {:?}",-500.0*t.fraction,t.normal,src.map(|s|&s.name),src.map(|s|s.origin));}}}
}
