//! Reviewed v19 momentary_rot_button subset: SDK buttons.cpp CMomentaryRotButton.
//! Both pinned maps use toggle wheels, returnspeed 0, no Position/OnPressed/OnUnpressed connections,
//! no locked/jiggle flags. Use the existing MOVETYPE_PUSH collision, parent and local-time integrator.
use super::kin::{Kin, KinKind, v_add, v_scale};
use super::*;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Done {
    None,
    Use,
    Position,
}

#[derive(Clone, Debug)]
pub(super) struct Momentary {
    start: [f32; 3],
    axis: [f32; 3],
    distance: f32,
    speed: f32,
    direction: f32,
    ideal: f32,
    last_used: bool,
    disabled: bool,
    done: Done,
}

impl Game {
    pub(super) fn initialize_momentary_buttons(&mut self) {
        if !self.mechanics_on()
            || !self
                .map_mechanics
                .is_some_and(|m| matches!(m.map, "bhop_rpg" | "bhop_avantasia"))
        {
            return;
        }
        for i in 0..self.ents.len() {
            if self.ents[i].class != "momentary_rot_button" {
                continue;
            }
            let e = &self.entities[i];
            let sf = e.int("spawnflags");
            // This is the complete reviewed subset; never silently emulate a different state machine.
            assert!(sf & 32 != 0 && sf & 2048 == 0 && e.float("returnspeed").unwrap_or(0.0) == 0.0);
            let mut axis = if sf & 64 != 0 {
                [0.0, 0.0, 1.0]
            } else if sf & 128 != 0 {
                [1.0, 0.0, 0.0]
            } else {
                [0.0, 1.0, 0.0]
            };
            let mut distance = e.float("distance").unwrap_or(0.0);
            if distance < 0.0 {
                axis = v_scale(axis, -1.0);
                distance = -distance;
            }
            let pos = e.float("startposition").unwrap_or(0.0).clamp(0.0, 1.0);
            let direction = if pos == 0.0 {
                -1.0
            } else if pos == 1.0 {
                1.0
            } else if e.int("startdirection") == -1 {
                -1.0
            } else {
                1.0
            };
            let speed = match e.float("speed").unwrap_or(0.0) {
                0.0 => 100.0,
                s => s,
            };
            let state = Momentary {
                start: v_add(e.angles(), v_scale(axis, -distance * pos)),
                axis,
                distance,
                speed,
                direction,
                ideal: pos,
                last_used: false,
                disabled: false,
                done: Done::None,
            };
            self.ents[i].data = Data::Kin(Box::new(Kin::new(KinKind::Momentary(state))));
            self.ents[i].solid = sf & 1 == 0;
        }
        self.reindex_instances();
    }

    fn momentary(&self, i: usize) -> &Momentary {
        match &self.kin(i).kind {
            KinKind::Momentary(m) => m,
            _ => unreachable!(),
        }
    }
    fn momentary_mut(&mut self, i: usize) -> &mut Momentary {
        match &mut self.kin_mut(i).kind {
            KinKind::Momentary(m) => m,
            _ => unreachable!(),
        }
    }
    fn momentary_pos(&self, i: usize) -> f32 {
        let m = self.momentary(i);
        let a = self.ents[i].local_angles;
        let k = m.axis.iter().position(|v| *v != 0.0).unwrap();
        ((a[k] - m.start[k]) * m.axis[k] / m.distance).clamp(0.0, 1.0)
    }
    fn momentary_snap(&mut self, i: usize, pos: f32) {
        let m = self.momentary(i);
        self.ents[i].local_angles = v_add(m.start, v_scale(m.axis, m.distance * pos));
        self.relink(i);
    }
    fn momentary_schedule(&mut self, i: usize, delay: f32) {
        let p = &mut self.kin_mut(i).push;
        p.move_done = p.local_time + delay;
    }
    fn momentary_track_goal(&mut self, i: usize) {
        let m = self.momentary(i);
        let dt = self.settings.tick_interval;
        let delta = (m.ideal - self.momentary_pos(i)).abs() * m.distance;
        let travel = delta / m.speed;
        if travel < dt {
            self.kin_mut(i).push.avelocity = v_scale(m.axis, delta / dt * m.direction);
        }
        self.momentary_schedule(i, travel.clamp(dt, dt * 6.0));
    }

    pub(super) fn momentary_input(&mut self, i: usize, input: &str, param: &str) -> bool {
        match input {
            "setposition" => {
                let ideal = param.trim().parse::<f32>().unwrap_or(0.0).clamp(0.0, 1.0);
                let pos = self.momentary_pos(i);
                self.momentary_mut(i).ideal = ideal;
                if pos == ideal {
                    self.kin_mut(i).push.avelocity = [0.0; 3];
                    return true;
                }
                let m = self.momentary_mut(i);
                m.direction = if pos < ideal { 1.0 } else { -1.0 };
                m.done = Done::Position;
                let velocity = v_scale(m.axis, m.speed * m.direction);
                let tick = self.tick;
                let p = &mut self.kin_mut(i).push;
                p.avelocity = velocity;
                p.think = Some(tick);
                self.momentary_track_goal(i);
            }
            "setpositionimmediately" => {
                let ideal = param.trim().parse::<f32>().unwrap_or(0.0).clamp(0.0, 1.0);
                self.momentary_mut(i).ideal = ideal;
                self.momentary_snap(i, ideal);
            }
            "enable" => self.momentary_mut(i).disabled = false,
            "disable" => self.momentary_mut(i).disabled = true,
            "use" => self.momentary_use(i),
            _ => return false,
        }
        true
    }

    pub(super) fn momentary_use(&mut self, i: usize) {
        if self.momentary(i).disabled {
            return;
        }
        let pos = self.momentary_pos(i);
        let first_use = !self.momentary(i).last_used;
        let m = self.momentary_mut(i);
        if !m.last_used {
            m.direction = -m.direction;
        }
        m.last_used = true;
        let direction = m.direction;
        self.momentary_schedule(i, 0.1);
        if (direction > 0.0 && pos >= 1.0) || (direction < 0.0 && pos <= 0.0) {
            self.kin_mut(i).push.avelocity = [0.0; 3];
            self.momentary_snap(i, if direction > 0.0 { 1.0 } else { 0.0 });
            self.fire_output(
                i,
                if direction > 0.0 {
                    "onfullyclosed"
                } else {
                    "onfullyopen"
                },
                Actor::Entity(i),
            );
        } else {
            let m = self.momentary_mut(i);
            m.done = Done::Use;
            let velocity = v_scale(m.axis, m.speed * direction);
            self.kin_mut(i).push.avelocity = velocity;
        }
        // Source doesn't replace a pending think in continuous Use.
        if self.kin(i).push.think.is_none() {
            self.kin_mut(i).push.think = Some(self.tick);
        }
        if first_use {
            self.defer_if_in_use(i);
        }
    }

    pub(super) fn momentary_think(&mut self, i: usize) {
        // UpdateTarget has no connections on either reviewed map. Track transform each frame.
        self.kin_mut(i).push.think = Some(self.tick + 1);
    }

    pub(super) fn momentary_move_done(&mut self, i: usize) {
        let m = self.momentary(i);
        match m.done {
            Done::Position => {
                let pos = self.momentary_pos(i);
                if (m.direction > 0.0 && pos >= m.ideal) || (m.direction < 0.0 && pos <= m.ideal) {
                    let ideal = m.ideal;
                    self.kin_mut(i).push.avelocity = [0.0; 3];
                    self.kin_mut(i).push.think = None;
                    self.momentary_snap(i, ideal);
                    if ideal == 1.0 {
                        self.fire_output(i, "onfullyclosed", Actor::Entity(i));
                    } else if ideal == 0.0 {
                        self.fire_output(i, "onfullyopen", Actor::Entity(i));
                    }
                    self.fire_output(i, "onreachedposition", Actor::Entity(i));
                } else {
                    self.momentary_track_goal(i);
                }
            }
            Done::Use => {
                self.kin_mut(i).push.avelocity = [0.0; 3];
                self.kin_mut(i).push.think = None;
                self.momentary_mut(i).last_used = false;
                self.momentary_mut(i).done = Done::None;
            }
            Done::None => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load(map: &str, physics_version: u32) -> Option<Game> {
        let p =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../maps/{map}.bsp"));
        if !p.exists() {
            eprintln!("skip {map}: local BSP absent");
            return None;
        }
        let mut g = crate::content::load_game(&p).unwrap();
        g.set_settings(Settings {
            physics_version,
            ..Settings::css_bhop()
        });
        g.reset();
        Some(g)
    }

    #[test]
    fn reviewed_wheels_only_exist_on_v19_and_restore_through_reset() {
        for map in ["bhop_rpg", "bhop_avantasia"] {
            let Some(mut g) = load(map, PHYSICS_V19) else {
                continue;
            };
            let count = g
                .kins
                .iter()
                .filter(|&&i| matches!(g.kin(i).kind, KinKind::Momentary(_)))
                .count();
            assert_eq!(count, if map == "bhop_rpg" { 2 } else { 25 });
            for version in PHYSICS_V1..=PHYSICS_V18 {
                g.set_settings(Settings {
                    physics_version: version,
                    ..Settings::css_bhop()
                });
                g.reset();
                assert!(
                    !g.kins
                        .iter()
                        .any(|&i| matches!(g.kin(i).kind, KinKind::Momentary(_))),
                    "{map} v{version}"
                );
            }
            g.set_settings(Settings {
                physics_version: PHYSICS_V19,
                ..Settings::css_bhop()
            });
            assert_eq!(
                g.kins
                    .iter()
                    .filter(|&&i| matches!(g.kin(i).kind, KinKind::Momentary(_)))
                    .count(),
                count
            );
        }
    }

    #[test]
    fn rpg_set_position_fires_with_wheel_as_activator_and_relay_restarts_it() {
        let Some(mut g) = load("bhop_rpg", PHYSICS_V19) else {
            return;
        };
        let i = g.find_named("ss").unwrap();
        // Keep the real BSP's wheel and real relay, isolate initial scheduling.
        g.queue.clear();
        g.momentary_input(i, "setposition", "1");
        for _ in 0..850 {
            g.step(Cmd::default()).unwrap();
        }
        // OnFullyClosed -> rel -> !activator SetPositionImmediately 0, then SetPosition 1.
        // A wrong player activator would leave this at 360 degrees instead of restarting it.
        assert!(
            g.momentary_pos(i) > 0.0 && g.momentary_pos(i) < 0.2,
            "{}",
            g.momentary_pos(i)
        );
        assert!(g.kin(i).push.avelocity[1] > 0.0);
        let saved = g.save_state();
        for _ in 0..20 {
            g.step(Cmd::default()).unwrap();
        }
        let a = g.ents[i].local_angles.map(f32::to_bits);
        g.reset();
        g.restore_state(&saved);
        for _ in 0..20 {
            g.step(Cmd::default()).unwrap();
        }
        assert_eq!(g.ents[i].local_angles.map(f32::to_bits), a);
    }

    #[test]
    fn continuous_use_coasts_for_point_one_then_reverses_and_disable_preserves_inputs() {
        let Some(mut g) = load("bhop_rpg", PHYSICS_V19) else {
            return;
        };
        let i = g.find_named("ss2").unwrap();
        g.queue.clear();
        g.momentary_use(i);
        assert_eq!(g.kin(i).push.avelocity, [0.0, 45.0, 0.0]);
        for _ in 0..5 {
            g.step(Cmd::default()).unwrap();
        }
        let pos = g.momentary_pos(i);
        assert!(pos > 0.0);
        for _ in 0..7 {
            g.step(Cmd::default()).unwrap();
        }
        assert_eq!(g.kin(i).push.avelocity, [0.0; 3]);
        g.momentary_use(i);
        assert_eq!(g.kin(i).push.avelocity, [0.0, -45.0, 0.0]);
        g.momentary_input(i, "disable", "");
        g.momentary_use(i);
        g.momentary_input(i, "setpositionimmediately", "0.25");
        assert_eq!(g.ents[i].local_angles[1], 90.0);
        g.momentary_input(i, "setposition", "0.2501");
        assert!(g.kin(i).push.avelocity[1] > 0.0 && g.kin(i).push.avelocity[1] < 45.0);
        g.step(Cmd::default()).unwrap();
        assert_eq!(g.momentary_pos(i), 0.2501);
    }
}
