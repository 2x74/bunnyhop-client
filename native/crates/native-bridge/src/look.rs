//! Lossless counted-yaw encoding from replay.ts withCounted. Input samples are supplied by the
//! native input collector; absence/nonrepresentable samples keep the original uncounted format.
use super::BhCmd;
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BhLookSample {
    pub base: f64,
    pub k: f64,
    pub count: i32,
    pub epoch: u32,
    pub kind: u32,
    pub frames: u32,
    pub events: u32,
    pub reports: u32,
}
#[derive(Clone)]
pub struct Rebase {
    pub tick: u32,
    pub kind: u32,
    pub base: f64,
    pub k: f64,
}
pub struct Counted {
    pub count: Vec<i32>,
    pub rebases: Vec<Rebase>,
    pub frames: Vec<u16>,
    pub events: Vec<u16>,
    pub reports: Vec<u16>,
}
pub fn yaw(base: f64, count: i32, k: f64) -> f32 {
    (((base - f64::from(count) * k) % 360.0 + 360.0) % 360.0) as f32
}
pub fn encode(looks: &[Option<BhLookSample>], commands: &[BhCmd]) -> Option<Counted> {
    if commands.is_empty() || looks.len() != commands.len() {
        return None;
    }
    let mut out = Counted {
        count: Vec::new(),
        rebases: Vec::new(),
        frames: Vec::new(),
        events: Vec::new(),
        reports: Vec::new(),
    };
    let mut epoch = None;
    let (mut base, mut k, mut offset) = (0.0, 0.0, 0i32);
    let fits = |base: f64, c: i32, k: f64, y: f32| yaw(base, c, k).to_bits() == y.to_bits();
    for (i, (look, cmd)) in looks.iter().zip(commands).enumerate() {
        let l = (*look)?;
        if l.count.unsigned_abs() > 0x3fffffff || !l.base.is_finite() || !l.k.is_finite() {
            return None;
        }
        out.frames.push(l.frames.min(65535) as u16);
        out.events.push(l.events.min(65535) as u16);
        out.reports.push(l.reports.min(65535) as u16);
        if epoch != Some(l.epoch) || i == 0 {
            epoch = Some(l.epoch);
            base = l.base;
            k = l.k;
            offset = 0;
            out.rebases.push(Rebase {
                tick: i as u32,
                kind: l.kind,
                base,
                k,
            });
        }
        let c = l.count.wrapping_sub(offset);
        if fits(base, c, k, cmd.yaw) {
            out.count.push(c);
            continue;
        }
        if (offset != 0 || base != l.base || k != l.k) && fits(l.base, l.count, l.k, cmd.yaw) {
            base = l.base;
            k = l.k;
            offset = 0;
            out.count.push(l.count);
            out.rebases.push(Rebase {
                tick: i as u32,
                kind: 5,
                base,
                k,
            });
            continue;
        }
        base = f64::from(cmd.yaw);
        k = l.k;
        offset = l.count;
        out.count.push(0);
        out.rebases.push(Rebase {
            tick: i as u32,
            kind: 5,
            base,
            k,
        });
        if !fits(base, 0, k, cmd.yaw) {
            return None;
        }
    }
    Some(out)
}
