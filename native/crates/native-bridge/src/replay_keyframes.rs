//! Saved replay states for seeking (web viewer/player.ts keyframes). A seek restores the nearest keyframe at or before
//! its tick and steps on from there instead of replaying the run from tick 0. Game::restore_state is bit-exact, and
//! every tick stepped is still checked against the replay's checkpoints.
use super::*;

/// One a second at 100 tick, as on the web.
const FIRST_INTERVAL_TICKS: u32 = 100;
/// Past this the interval doubles and the keyframes off it are dropped. The web allows 160 MiB.
const BUDGET_BYTES: usize = 128 << 20;

pub(crate) struct Keyframe {
    pub tick: u32,
    game: game::GameState,
    filter: styles::Filter,
    timer: Option<run::Timer>,
    command: BhCmd,
    bytes: usize,
}

impl Keyframe {
    pub fn restore(&self, m: &mut Map) {
        m.invalidate_jump_observation();
        m.game.restore_state(&self.game);
        m.filter = self.filter.clone();
        m.timer = self.timer.clone();
        m.last_command = self.command;
        m.transforms_dirty = true;
    }
}

pub(crate) struct Keyframes {
    /// In tick order.
    frames: Vec<Keyframe>,
    interval: u32,
    bytes: usize,
    pub(crate) budget_bytes: usize,
}

impl Default for Keyframes {
    fn default() -> Self {
        Self {
            frames: Vec::new(),
            interval: FIRST_INTERVAL_TICKS,
            bytes: 0,
            budget_bytes: BUDGET_BYTES,
        }
    }
}

impl Keyframes {
    /// Ticks between keyframes.
    #[cfg(test)]
    pub fn interval(&self) -> u32 {
        self.interval
    }

    /// The memory the keyframes hold (Game::approx_bytes).
    #[cfg(test)]
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.frames.len()
    }

    /// Saves the state after `tick` when it falls on the interval and isn't saved yet.
    pub fn capture(&mut self, tick: u32, m: &Map) {
        if tick == 0 || tick % self.interval != 0 {
            return;
        }
        let at = self.frames.partition_point(|k| k.tick < tick);
        if self.frames.get(at).is_some_and(|k| k.tick == tick) {
            return;
        }
        let game = m.game.save_state();
        let bytes = game.approx_bytes();
        self.frames.insert(
            at,
            Keyframe {
                tick,
                game,
                filter: m.filter.clone(),
                timer: m.timer.clone(),
                command: m.last_command,
                bytes,
            },
        );
        self.bytes += bytes;
        while self.bytes > self.budget_bytes && self.frames.len() > 1 {
            self.thin();
        }
    }

    fn thin(&mut self) {
        self.interval *= 2;
        let interval = self.interval;
        self.frames.retain(|k| k.tick % interval == 0);
        self.bytes = self.frames.iter().map(|k| k.bytes).sum();
    }

    /// The last keyframe at or before `tick`.
    pub fn latest(&self, tick: u32) -> Option<&Keyframe> {
        let after = self.frames.partition_point(|k| k.tick <= tick);
        after.checked_sub(1).map(|at| &self.frames[at])
    }
}
