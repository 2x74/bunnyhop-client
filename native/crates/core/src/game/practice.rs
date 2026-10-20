//! Practice mode noclip (apps/web/src/practice/): the client flies the player itself (CS:S FullNoClipMove, ported in
//! apps/web/src/practice/noclip.ts) and hands the core the position each tick; the map keeps running around it.
//!
//! Nothing here is reachable from a ranked simulation: `step` never calls these, and the replay re-simulation and the
//! verifier (apps/web/src/sim.ts, verifier.ts) only reset, apply the start-zone restart point, step recorded commands
//! and clamp prespeed. A recording that went through noclip can't re-simulate (no command produces it), and the client
//! never submits a practice attempt.

use super::*;

/// Source FindPassableSpace: up to this many 1-unit steps per direction.
const PASSABLE_STEPS: u32 = 100;

impl Game {
    /// One tick of practice noclip: the player is put at `position` with `velocity` (standing, in the air, no
    /// collision and no trigger touches), and the rest of the world runs a normal tick around it (event queue,
    /// doors, movers, triggers the player left end their touch). The tick counter advances as in `step`.
    pub fn practice_noclip_tick(&mut self, position: [f32; 3], velocity: [f32; 3]) {
        self.events = 0;
        self.attack = None;
        self.weapon_events = 0;
        self.view_angle_change = [0.0; 3];
        self.service_events();
        self.rebuild_solid();
        self.place_noclip(position, velocity, false);
        self.state_after_command = self.state;
        self.advance_all_movers();
        self.untouch_triggers();
        self.tick += 1;
    }

    /// Leaves practice noclip at `position` keeping `velocity`, like CS:S `noclip` off: if the standing hull is stuck
    /// there, looks for free space along the view's forward, right, left, up, down and back (FindPassableSpace, up to
    /// 100 units each), then the same with the crouched hull. Returns 1 (standing), 2 (crouched) or 0 (no free space
    /// found: left at `position`, standing).
    pub fn practice_noclip_exit(&mut self, position: [f32; 3], velocity: [f32; 3], yaw: f32, pitch: f32) -> u32 {
        let (sy, cy) = playsrc_collision::math::sin_cos(yaw.to_radians());
        let (sp, cp) = playsrc_collision::math::sin_cos(pitch.to_radians());
        // AngleVectors (roll 0): forward, right, up.
        let forward = [cp * cy, cp * sy, -sp];
        let right = [sy, -cy, 0.0];
        let up = [sp * cy, sp * sy, cp];
        let neg = |v: [f32; 3]| [-v[0], -v[1], -v[2]];
        let dirs = [forward, right, neg(right), up, neg(up), neg(forward)];
        for (crouched, hull) in [(false, self.policy.standing_hull), (true, self.policy.crouched_hull)] {
            let found = if self.practice_free(position, hull) {
                Some(position)
            } else {
                dirs.iter().find_map(|d| {
                    (1..=PASSABLE_STEPS)
                        .map(|i| {
                            let s = i as f32;
                            [position[0] + d[0] * s, position[1] + d[1] * s, position[2] + d[2] * s]
                        })
                        .find(|&p| self.practice_free(p, hull))
                })
            };
            if let Some(p) = found {
                self.place_noclip(p, velocity, crouched);
                return 1 + crouched as u32;
            }
        }
        self.place_noclip(position, velocity, false);
        0
    }

    /// The hull fits at `p` (feet) without starting in solid.
    fn practice_free(&self, p: [f32; 3], hull: Hull) -> bool {
        if p.iter().any(|v| !v.is_finite() || v.abs() > OUT_OF_WORLD) {
            return false;
        }
        let scene = self.scene(0.0);
        scene.trace_filtered(p, p, hull, self.config.solid_mask, &[]).is_ok_and(|t| !t.start_solid && !t.all_solid)
    }

    /// Puts the player at `position` in the air with `velocity`. The next `step` categorizes the position first
    /// (the origin differs from where the last move left it, as after any teleport).
    fn place_noclip(&mut self, position: [f32; 3], velocity: [f32; 3], crouched: bool) {
        self.state = State::from_player(Player { position, velocity, grounded: false, crouched, jump_latched: false }, self.policy);
        self.last_move_origin = [f32::NAN; 3];
        self.touch_origin = [f32::NAN; 3];
        self.touch_crouched = false;
        self.near.clear();
        self.near_region = None;
    }
}
