//! Retained paths through append-only recording history (web practice-mode/segments.ts).
use super::{
    recording::{Checkpoint, Recorder, ReplayData},
    *,
};

pub const MAX_LOG_TICKS: usize = 1_440_000;
pub const MAX_LOADS: usize = 100_000;
pub const MAGIC: u32 = 0x47534842;

#[derive(Clone, Debug)]
pub struct Load {
    pub tick: u32,
    pub position: [f32; 3],
    pub velocity: [f32; 3],
}
struct Tick {
    command: BhCmd,
    look: Option<BhLookSampleV2>,
    checkpoint: Option<Checkpoint>,
}
#[derive(Default)]
pub struct History {
    ticks: Vec<Tick>,
    cosmetic: HashMap<isize, Vec<u8>>,
    inspect: HashMap<isize, Vec<u8>>,
    ranges: Vec<std::ops::Range<usize>>,
    generation: u64,
    full: bool,
}
pub struct Mark {
    generation: u64,
    ranges: Vec<std::ops::Range<usize>>,
    data: ReplayData,
    interval: u32,
}
impl History {
    pub fn begin(&mut self) {
        if self.full {
            self.ticks.clear();
            self.cosmetic.clear();
            self.inspect.clear();
            self.generation += 1;
            self.full = false;
        }
        self.ranges.clear();
    }
    pub fn push(
        &mut self,
        command: BhCmd,
        look: Option<BhLookSampleV2>,
        checkpoint: Option<Checkpoint>,
    ) {
        if self.full || self.ticks.len() >= MAX_LOG_TICKS {
            self.full = true;
            return;
        }
        let index = self.ticks.len();
        self.ticks.push(Tick {
            command,
            look,
            checkpoint,
        });
        if let Some(last) = self.ranges.last_mut().filter(|r| r.end == index) {
            last.end += 1;
        } else {
            self.ranges.push(index..index + 1);
        }
    }
    pub fn event(&mut self, kind: u8, inspect: bool) {
        if self.full {
            return;
        }
        let at = self
            .ranges
            .last()
            .map_or(-1, |range| range.end as isize - 1);
        let events = if inspect {
            &mut self.inspect
        } else {
            &mut self.cosmetic
        };
        events.entry(at).or_default().push(kind);
    }
    fn events(&self, at: isize, tick: u32, data: &mut ReplayData) {
        for (log, events) in [
            (&self.cosmetic, &mut data.cosmetic),
            (&self.inspect, &mut data.inspect),
        ] {
            for &kind in log.get(&at).into_iter().flatten() {
                events.push(replay::CosmeticEvent { tick, kind });
            }
        }
    }
    pub fn mark(&self, data: &ReplayData, interval: u32, tick: usize) -> Result<Mark, String> {
        if self.full {
            return Err(
                "Segmented history is full (4 hours of play). Restart to start a new one.".into(),
            );
        }
        if data.commands.len() != tick || self.ranges.iter().map(|r| r.len()).sum::<usize>() != tick
        {
            return Err("Segmented history is out of step with the simulation".into());
        }
        Ok(Mark {
            generation: self.generation,
            ranges: self.ranges.clone(),
            data: data.metadata(),
            interval,
        })
    }
    pub fn rebuild(&self, mark: &Mark) -> Result<Recorder, String> {
        if self.full || mark.generation != self.generation {
            return Err(
                "That checkpoint's run is no longer kept. Save a new one, or use practice.".into(),
            );
        }
        if mark.data.segments.len() >= MAX_LOADS {
            return Err("Segmented replay exceeds 100000 loads".into());
        }
        let mut data = mark.data.metadata();
        data.cosmetic.clear();
        data.inspect.clear();
        self.events(-1, 0, &mut data);
        for range in &mark.ranges {
            for index in range.clone() {
                let tick = &self.ticks[index];
                data.commands.push(tick.command);
                data.looks.push(tick.look);
                self.events(index as isize, data.commands.len() as u32, &mut data);
                if let Some(cp) = &tick.checkpoint {
                    let mut cp = cp.clone();
                    cp.tick = data.commands.len() as u32;
                    data.checkpoints.push(cp);
                }
            }
        }
        Ok(Recorder {
            writer: None,
            checkpoint_interval: mark.interval,
            data,
        })
    }
}
impl Map {
    pub fn segmenting(&self) -> bool {
        self.filter.id == "segmented"
            && self.record_valid
            && (self.recorder.is_some() || self.completed_record.is_some())
    }
    pub fn segment_mark(&self) -> Result<Option<Mark>, String> {
        if !self.segmenting() {
            return Ok(None);
        }
        let data = self
            .recorder
            .as_ref()
            .map(|r| &r.data)
            .or(self.completed_record.as_ref())
            .ok_or("No Segmented recording")?;
        let interval = data.header["checkpointInterval"].as_u64().unwrap() as u32;
        self.segments
            .mark(data, interval, self.game.tick as usize)
            .map(Some)
    }
    pub fn segment_recording(&mut self, handle: u32) -> Result<Recorder, String> {
        if !self.segmenting() {
            return Err("Not a clean Segmented attempt".into());
        }
        let checkpoint = self
            .checkpoints
            .get(handle.wrapping_sub(1) as usize)
            .and_then(Option::as_ref)
            .ok_or("invalid practice checkpoint")?;
        let mark = checkpoint
            .segment
            .as_ref()
            .ok_or("That checkpoint was saved in practice. Save a new one, or use practice.")?;
        let recorder = self.segments.rebuild(mark)?;
        self.segments.ranges = mark.ranges.clone();
        Ok(recorder)
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_segment_loads(ctx: *mut BhContext) -> i32 {
    let mut count = -1;
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            if m.segmenting() {
                count = m
                    .recorder
                    .as_ref()
                    .map(|r| &r.data)
                    .or(m.completed_record.as_ref())
                    .map_or(0, |r| r.segments.len() as i32);
            }
            Ok(())
        });
    }
    count
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_record_options_read_v29(
    ctx: *mut BhContext,
    out: *mut BhRecordOptionsV29,
) -> i32 {
    unsafe {
        call(ctx, |c| {
            output(
                out,
                c.map()?
                    .recorder
                    .as_ref()
                    .ok_or("no active recording")?
                    .data
                    .options,
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_history_stays_unusable_until_restart_and_old_marks_expire() {
        let mut history = History::default();
        history.push(BhCmd::default(), None, None);
        history.full = true;
        history.push(BhCmd::default(), None, None);
        assert_eq!(history.ticks.len(), 1);
        let generation = history.generation;
        history.begin();
        assert!(history.ticks.is_empty());
        assert!(history.ranges.is_empty());
        assert!(!history.full);
        assert_ne!(history.generation, generation);
        assert_eq!(MAX_LOG_TICKS, 1_440_000);
        assert_eq!(MAX_LOADS, 100_000);
    }
}
