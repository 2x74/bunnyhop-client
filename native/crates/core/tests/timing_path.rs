//! Observational identity and supported-path boundary tests, independent of ranked timing.
use bunnyhop_core::Settings;
use playsrc_collision::Hull;
use playsrc_movement::{self as m, Command, Error, Player, State, StepInput, Trace, Tracer};

struct Room;
impl Tracer for Room {
    fn trace(&self, start: [f32;3], end: [f32;3], hull: Hull, _: u32) -> Result<Trace, Error> {
        // Floor and wall x=64; point queries must report empty in front of them.
        let mut t = Trace { fraction: 1., start_solid: false, all_solid: false, end, normal: None, hit: None, contents: 0 };
        for (axis, sign, bound) in [(2, 1., 0.03125 - hull.mins[2]), (0, -1., 64. - hull.maxs[0])] {
            let a = sign * (start[axis] - bound);
            let b = sign * (end[axis] - bound);
            if a < -0.032 { t.start_solid = true; t.all_solid = b < 0.; t.fraction = 0.; t.end = start; t.contents = 1; return Ok(t); }
            if b < 0. && b < a {
                let fraction = (a / (a - b)).clamp(0., 1.);
                if fraction < t.fraction {
                    t.fraction = fraction; t.end = std::array::from_fn(|i| start[i] + (end[i]-start[i])*fraction);
                    let mut normal = [0.;3]; normal[axis] = sign;
                    t.normal = Some(normal); t.hit = Some(0); t.contents = 1;
                }
            }
        }
        Ok(t)
    }
}
fn state(settings: Settings, p: [f32;3], v: [f32;3], ground: bool) -> State {
    State::from_player(Player { position:p, velocity:v, grounded:ground, crouched:false, jump_latched:false }, settings.policy())
}
fn pair(settings: Settings, state: State, input: StepInput) -> m::StepResult {
    let a = m::step(&Room, state, input, settings.configuration(), settings.policy()).unwrap();
    let mut b = m::step_observed(&Room, state, input, settings.configuration(), settings.policy()).unwrap();
    let path = b.accepted_path.take().expect("observed path");
    assert_eq!(a, b, "observation changed simulation or queries");
    b.accepted_path = Some(path); b
}
#[test]
fn every_supported_version_observation_is_identity() {
    // An isolated production-source run also compiles this test with PHYSICS_LATEST=18.
    for version in 1..=bunnyhop_core::game::PHYSICS_LATEST {
        let settings = Settings { physics_version:version, ..Settings::css_bhop() };
        let mut s = state(settings, [0.,0.,0.03125], [0.;3], true);
        for tick in 0..600 {
            let input = StepInput { command_number: tick, command: Command { forward: 450., side: if tick%40<20 {450.} else {-450.}, yaw_degrees: tick as f32 * 3., jump:tick%60==2, crouch:tick%90>75 }, ..Default::default() };
            s = pair(settings, s, input).state;
        }
    }
}
#[test]
fn bend_has_remaining_time_and_active_hull() {
    let settings = Settings::css_bhop();
    let r = pair(settings, state(settings, [47.,0.,100.], [200.,100.,0.], false), StepInput::default());
    let p = r.accepted_path.unwrap(); assert_eq!(p.unsupported, None);
    assert!(p.segments.len() >= 2, "wall must bend the path");
    assert_eq!(p.segments[0].from, [47.,0.,100.]);
    assert_eq!(p.segments[0].t0, 0.); assert_eq!(p.segments.last().unwrap().t1, 1.);
    for w in p.segments.windows(2) { assert_eq!(w[0].to, w[1].from); assert_eq!(w[0].t1, w[1].t0); }
    assert!((p.segments[0].t1 - 0.5).abs() < 0.001);
    assert_eq!(p.segments[0].hull.maxs[2],62.);
}
#[test]
fn stationary_and_hull_change_phase_supported() {
    let settings = Settings::css_bhop(); let s = state(settings,[0.,0.,0.03125],[0.;3],true);
    let p = pair(settings,s,StepInput::default()).accepted_path.unwrap();
    assert_eq!(p.unsupported,None); assert_eq!(p.segments.len(),1); assert_eq!(p.segments[0].from,p.segments[0].to);
    let input=StepInput { command:Command { crouch:true,..Default::default() },..Default::default() };
    assert_eq!(pair(settings,s,input).accepted_path.unwrap().unsupported,None);
}
#[test]
fn unsupported_modes_fail_closed() {
    let settings=Settings::css_bhop(); let mut s=state(settings,[0.,0.,100.],[100.;3],false); s.mode=m::Mode::Noclip;
    assert!(pair(settings,s,StepInput::default()).accepted_path.unwrap().unsupported.is_some());
}

mod common;
#[test]
fn selected_step_has_discrete_phases_and_rejected_alternative_never_leaks() {
    use bunnyhop_core::physics::ConvexBrush;
    for height in [8., 64.] {
        let scene = common::Scene::new(vec![common::floor(), ConvexBrush::aabb([50.,-100.,0.],[100.,100.,height])]);
        let settings = Settings::css_bhop();
        let s = state(settings,[33.,0.,0.03125],[260.,0.,0.],true);
        let input=StepInput {command:Command {forward:450.,..Default::default()},..Default::default()};
        let a=m::step(&scene,s,input,settings.configuration(),settings.policy()).unwrap();
        let mut b=m::step_observed(&scene,s,input,settings.configuration(),settings.policy()).unwrap();
        let p=b.accepted_path.take().unwrap();assert_eq!(a,b);
        if height==8. {
            assert!(b.climbed_step>0.);assert_eq!(p.unsupported,None);
            assert!(p.segments.first().unwrap().discrete);
            assert_eq!(p.segments.first().unwrap().t0,0.);
            assert!(p.segments.last().unwrap().discrete);
            assert_eq!(p.segments.last().unwrap().t0,1.);
        } else {
            assert_eq!(b.climbed_step,0.);assert_eq!(p.unsupported,None);
            assert!(p.segments.iter().all(|s|s.from[2]<1. && s.to[2]<1.),"speculative high path leaked");
        }
    }
}
#[test]
#[ignore = "external corpus: requires maps/bhop_eazy.bsp; run explicitly with --ignored"]
fn reset_and_snapshot_restore_invalidate_observation() {
    let bytes=std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"),"/../../maps/bhop_eazy.bsp")).unwrap();
    let bsp=bunnyhop_core::parse_bsp(&bytes).unwrap();let mut g=bunnyhop_core::Game::load(&bsp).unwrap();
    g.observe_timing=true;g.step(Default::default()).unwrap();assert!(g.timing_path.is_some());
    let snapshot=g.save_state();g.reset();assert!(g.timing_path.is_none());assert!(g.observe_timing);
    g.step(Default::default()).unwrap();g.restore_state(&snapshot);assert!(g.timing_path.is_none());
}

#[test]
#[ignore = "external corpus: requires maps/bhop_eazy.bsp; run explicitly with --ignored"]
fn real_game_world_death_does_not_record_respawn_chord() {
    let bytes=std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"),"/../../maps/bhop_eazy.bsp")).unwrap();
    let bsp=bunnyhop_core::parse_bsp(&bytes).unwrap();let mut g=bunnyhop_core::Game::load(&bsp).unwrap();
    g.observe_timing=true;
    g.state.position=[100000.,0.,0.];
    g.step(Default::default()).unwrap();
    assert_ne!(g.events & bunnyhop_core::game::EVENT_RESPAWNED,0);
    if let Some(p)=g.timing_path {
        assert!(p.segments.iter().all(|s|s.from[0].abs()<32768. && s.to[0].abs()<32768.),"respawn became movement");
    }
}

#[test]
fn snap_and_air_duck_changes_have_solver_phase_without_swept_chord() {
    let settings=Settings::css_bhop();
    let p=pair(settings,state(settings,[0.,0.,2.],[100.,0.,0.],true),StepInput::default()).accepted_path.unwrap();
    assert_eq!(p.unsupported,None);
    let snap=p.segments.last().unwrap();assert!(snap.discrete);assert_eq!((snap.t0,snap.t1),(1.,1.));
    assert_eq!(snap.from[2],2.);assert!(snap.to[2]<0.1);
    let initial=state(settings,[0.,0.,100.],[100.,0.,0.],false);
    let input=StepInput { command:Command { crouch:true,..Default::default() },..Default::default() };
    let r=pair(settings,initial,input);let p=r.accepted_path.unwrap();assert_eq!(p.unsupported,None);
    let duck=p.segments.first().unwrap();assert!(duck.discrete);assert_eq!((duck.t0,duck.t1),(0.,0.));
    assert_eq!(duck.from,initial.position);assert_ne!(duck.from,duck.to);
    assert_eq!(duck.hull,r.state.active_hull(settings.policy()));
    assert_eq!(p.segments[1].from,duck.to);
}
