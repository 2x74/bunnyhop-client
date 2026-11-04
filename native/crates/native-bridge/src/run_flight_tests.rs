//! Infinite's flight ticks and landings in the timer, as the website's timer.ts flightTick and update (its tests in
//! apps/web/test/infinite-flight.test.ts, "timer flightTick").
use super::*;
use bunnyhop_core::game::EVENT_FLIGHT_LANDED;

const INFINITE_START_REENTRY_CAP: f32 = 3510.0;

fn zone(kind: u32, x: f32) -> BhZone {
    BhZone {
        kind,
        mins: [x, -10.0, 0.0],
        maxs: [x + 10.0, 10.0, 100.0],
        ..BhZone::default()
    }
}
fn infinite() -> Timer {
    let options = BhRunOptions {
        cap_enabled: 0,
        rules: 4,
        start_reentry_cap: INFINITE_START_REENTRY_CAP,
        ..BhRunOptions::default()
    };
    Timer::new(vec![zone(0, 0.0), zone(1, 100.0)], options, 0.01)
}
fn at(tick: u32, x: f32, velocity: [f32; 3]) -> BhState {
    BhState {
        tick,
        position: [x, 0.0, 0.0],
        velocity,
        touch_position: [f32::NAN; 3],
        ..BhState::default()
    }
}
fn still(tick: u32, x: f32) -> BhState {
    at(tick, x, [0.0; 3])
}
fn fly(t: &mut Timer, tick: u32, x: f32, velocity: [f32; 3]) -> Option<[f32; 3]> {
    t.flight_tick(tick, [x, 0.0, 0.0], velocity)
}
fn land(t: &mut Timer, s: BhState, landing_x: f32) -> Option<[f32; 3]> {
    let s = BhState {
        events: EVENT_FLIGHT_LANDED,
        ..s
    };
    t.update_landed(BhCmd::default(), s, ([landing_x, 0.0, 0.0], false))
}
fn started(t: &Timer) -> bool {
    t.state.update_flags & 1 != 0
}

#[test]
fn a_flight_never_starts_a_run_arms_in_the_start_and_caps_flying_out() {
    let mut t = infinite();
    assert_eq!(fly(&mut t, 1, 5.0, [4000.0, 0.0, 7.0]), None);
    assert_eq!((t.state.status, t.state.in_start), (0, 1));
    assert_eq!(
        fly(&mut t, 2, 50.0, [4000.0, 0.0, 7.0]),
        Some([3510.0, 0.0, 7.0])
    );
    assert_eq!(
        (t.state.status, t.state.in_start, t.state.update_flags),
        (0, 0, 8)
    );
    // Through the end zone: nothing.
    assert_eq!(fly(&mut t, 3, 105.0, [100.0, 0.0, 0.0]), None);
    assert_eq!(
        (t.state.status, t.state.update_flags, t.state.last_tick),
        (0, 0, 3)
    );
}

#[test]
fn a_flight_ends_a_running_run_and_the_next_real_crossing_starts_one() {
    let mut t = infinite();
    t.update(BhCmd::default(), still(1, 5.0));
    t.update(BhCmd::default(), at(2, 40.0, [300.0, 0.0, 0.0]));
    assert!(started(&t));
    // A jump and a synced turn while strafing: the run has stats for the flight to clear.
    let strafe = BhCmd {
        side: -450.0,
        yaw: 10.0,
        ..BhCmd::default()
    };
    let hop = BhState {
        events: bunnyhop_core::game::EVENT_JUMPED,
        ..at(3, 45.0, [300.0, 0.0, 0.0])
    };
    t.update(strafe, hop);
    let s = t.state;
    assert_eq!(
        (s.jumps, s.strafes, s.sync_good, s.sync_percent),
        (1, 1, 1, 100.0)
    );
    assert_eq!(fly(&mut t, 4, 50.0, [0.0; 3]), None);
    assert_eq!(t.state.update_flags, 4, "restarted");
    let s = t.state;
    assert_eq!(
        (s.status, s.start_tick, s.end_tick, s.seconds),
        (0, 0, 0, 0.0)
    );
    assert_eq!(
        (
            s.jumps,
            s.strafes,
            s.sync_good,
            s.sync_total,
            s.sync_percent
        ),
        (0, 0, 0, 0, 0.0)
    );
    // Flying through the end zone finishes nothing; landing in the start and leaving it starts a run.
    fly(&mut t, 5, 105.0, [0.0; 3]);
    assert_eq!(t.state.status, 0);
    fly(&mut t, 6, 5.0, [0.0; 3]);
    t.update(BhCmd::default(), still(7, 6.0));
    assert!(!started(&t));
    t.update(BhCmd::default(), at(8, 40.0, [300.0, 0.0, 0.0]));
    assert!(started(&t));
    assert_eq!(t.state.start_tick, 8);
}

#[test]
fn a_landing_relocated_out_of_the_start_disarms_it() {
    // Armed by the flight in the start, landed at x 40 (out of it), walking on: nothing starts.
    let mut t = infinite();
    fly(&mut t, 1, 5.0, [0.0; 3]);
    land(&mut t, at(2, 42.0, [300.0, 0.0, 0.0]), 40.0);
    assert!(!started(&t));
    assert_eq!((t.state.in_start, t.state.pending_start), (0, 0));
    t.update(BhCmd::default(), at(3, 45.0, [300.0, 0.0, 0.0]));
    assert_eq!((t.state.status, t.state.update_flags), (0, 0));
    // A later real entry into the start and exit starts a run.
    t.update(BhCmd::default(), still(4, 5.0));
    t.update(BhCmd::default(), at(5, 40.0, [300.0, 0.0, 0.0]));
    assert!(started(&t));
    assert_eq!(t.state.start_tick, 5);
}

#[test]
fn a_landing_still_in_the_start_starts_on_the_normal_exit() {
    // Landed in the start (x 6) and left it in the same tick: the run starts on that tick.
    let mut t = infinite();
    fly(&mut t, 1, 5.0, [0.0; 3]);
    land(&mut t, at(2, 40.0, [300.0, 0.0, 0.0]), 6.0);
    assert!(started(&t));
    assert_eq!(t.state.start_tick, 2);
    // Landed in the start and still in it: armed, it starts on the exit.
    let mut t = infinite();
    fly(&mut t, 1, 5.0, [0.0; 3]);
    land(&mut t, still(2, 6.0), 6.0);
    assert!(!started(&t));
    assert_eq!(t.state.in_start, 1);
    t.update(BhCmd::default(), at(3, 40.0, [300.0, 0.0, 0.0]));
    assert!(started(&t));
    assert_eq!(t.state.start_tick, 3);
}

#[test]
fn the_landing_tick_measures_the_start_crossing_from_the_landing_spot() {
    // The flight tick coasts (no previous position), and the landing tick's movement begins at the landing spot.
    let mut t = infinite();
    fly(&mut t, 1, 5.0, [0.0; 3]);
    assert_eq!(t.prev_position, None);
    land(&mut t, at(2, 40.0, [300.0, 0.0, 0.0]), 6.0);
    assert_eq!(t.prev_position, Some([40.0, 0.0, 0.0]));
    let mut walked = infinite();
    walked.update(BhCmd::default(), still(1, 6.0));
    walked.update(BhCmd::default(), at(2, 40.0, [300.0, 0.0, 0.0]));
    assert_eq!(t.start_crossing.json(), walked.start_crossing.json());
}

#[test]
fn a_finished_run_stays_finished_through_a_flight() {
    let mut t = infinite();
    t.update(BhCmd::default(), still(1, 5.0));
    t.update(BhCmd::default(), still(2, 40.0));
    t.update(BhCmd::default(), still(3, 105.0));
    assert_eq!(t.state.status, 2);
    let seconds = t.state.seconds;
    assert_eq!(fly(&mut t, 4, 50.0, [4000.0, 0.0, 0.0]), None);
    assert_eq!(
        (t.state.status, t.state.end_tick, t.state.update_flags),
        (2, 3, 0)
    );
    assert_eq!(t.state.seconds, seconds);
}

#[test]
fn a_flight_clears_a_pending_start_and_coasts_every_other_style() {
    // Normal (no re-entry cap): a takeoff jump in the start leaves a pending rules 2 start. A flight drops it without
    // reporting a restart, and only coasts: it never arms.
    let mut t = Timer::new(
        vec![zone(0, 0.0), zone(1, 100.0)],
        BhRunOptions::default(),
        0.01,
    );
    let ground = BhState {
        grounded: 1,
        ..still(1, 5.0)
    };
    t.update(BhCmd::default(), ground);
    let jump = BhState {
        events: bunnyhop_core::game::EVENT_JUMPED,
        ..still(2, 5.0)
    };
    t.update(BhCmd::default(), jump);
    assert_eq!((t.state.pending_start, t.state.jumps), (2, 1));
    assert_eq!(fly(&mut t, 3, 5.0, [0.0; 3]), None);
    assert_eq!(
        (t.state.status, t.state.pending_start, t.state.jumps),
        (0, 0, 0)
    );
    assert_eq!((t.state.update_flags, t.state.last_perfect_tick), (0, -1));
    assert_eq!(fly(&mut t, 4, 50.0, [4000.0, 0.0, 0.0]), None);
    assert_eq!(t.state.update_flags, 0);
}
