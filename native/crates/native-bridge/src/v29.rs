//! Additive, size-checked v29 transport. The original ABI/layouts remain v1.
use super::*;
use std::mem::size_of;

pub const TURN_SPEED_MAGIC: u32 = 0x53544842;
pub const FLAG_TIMED_INPUT: u16 = 1 << 4;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct BhRecordOptionsV29 {
    pub version: u32,
    pub size: u32,
    pub yaw_speed: f32,
    pub angle_speed_key: f32,
    pub timed_input: u32,
}
impl Default for BhRecordOptionsV29 {
    fn default() -> Self {
        Self {
            version: 1,
            size: size_of::<Self>() as u32,
            yaw_speed: 210.0,
            angle_speed_key: 2.0,
            timed_input: 0,
        }
    }
}
impl BhRecordOptionsV29 {
    pub fn checked(self) -> Result<Self, String> {
        if self.version != 1 || self.size as usize != size_of::<Self>() {
            return Err("unsupported v29 recording ABI layout".into());
        }
        if !self.yaw_speed.is_finite()
            || !(60.0..=720.0).contains(&self.yaw_speed)
            || !self.angle_speed_key.is_finite()
            || !(1.0..=4.0).contains(&self.angle_speed_key)
            || self.timed_input > 1
        {
            return Err("invalid turn rates or timed-input flag".into());
        }
        Ok(self)
    }
}

// Check sizes BEFORE passing any new struct pointers across the ABI.
#[unsafe(no_mangle)]
pub extern "C" fn bh_v29_check_abi(version: u32, record_size: usize, segment_size: usize) -> c_int {
    (version == 1
        && record_size == size_of::<BhRecordOptionsV29>()
        && segment_size == size_of::<BhTimingSegmentV2>()) as c_int
}

/// Rates freeze at the first command. timed_input is sticky and may be marked later.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_record_options_v29(
    ctx: *mut BhContext,
    options: *const BhRecordOptionsV29,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            // Read only the fixed prefix until the caller's layout is known.
            if options.is_null() {
                return Err("null recording options".into());
            }
            let prefix = options.cast::<u32>();
            if *prefix != 1 || *prefix.add(1) as usize != size_of::<BhRecordOptionsV29>() {
                return Err("unsupported v29 recording ABI layout".into());
            }
            let options = input(options)?.checked()?;
            let recorder = c
                .map()?
                .recorder
                .as_mut()
                .ok_or("begin recording before setting v29 options")?;
            if !recorder.data.commands.is_empty()
                && (recorder.data.options.yaw_speed != options.yaw_speed
                    || recorder.data.options.angle_speed_key != options.angle_speed_key)
            {
                return Err("turn rates are frozen until restart".into());
            }
            recorder.data.options.yaw_speed = options.yaw_speed;
            recorder.data.options.angle_speed_key = options.angle_speed_key;
            recorder.data.options.timed_input |= options.timed_input;
            Ok(())
        })
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BhTimingSegmentV2 {
    pub t0: f64,
    pub t1: f64,
    pub from: [f32; 3],
    pub to: [f32; 3],
    pub mins: [f32; 3],
    pub maxs: [f32; 3],
    pub discrete: u32,
    pub reserved: u32,
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_timing_observe(ctx: *mut BhContext, enabled: u32) -> c_int {
    unsafe {
        call(ctx, |c| {
            if enabled > 1 {
                return Err("invalid timing observation toggle".into());
            }
            let m = c.map()?;
            m.game.observe_timing = enabled != 0;
            m.game.timing_path = None;
            Ok(())
        })
    }
}
/// path_version must be 2; segment_size must match. Status: absent0/supported1/unsupported2.
/// Query count with capacity=0. A short buffer fails without writing segments.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_timing_path_v2(
    ctx: *mut BhContext,
    path_version: u32,
    segment_size: usize,
    segments: *mut BhTimingSegmentV2,
    capacity: usize,
    count: *mut usize,
    status: *mut u32,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            if path_version != 2 || segment_size != size_of::<BhTimingSegmentV2>() {
                return Err("unsupported timing-path ABI layout".into());
            }
            if count.is_null() || status.is_null() {
                return Err("null timing-path outputs".into());
            }
            let path = c.map()?.game.timing_path.as_ref();
            let n = path.map_or(0, |p| p.segments.len());
            *count = n;
            *status = path.map_or(0, |p| if p.unsupported.is_some() { 2 } else { 1 });
            if capacity == 0 {
                return Ok(());
            }
            if capacity < n || (n != 0 && segments.is_null()) {
                return Err("short/null timing-path buffer".into());
            }
            if let Some(path) = path {
                for (i, s) in path.segments.iter().enumerate() {
                    *segments.add(i) = BhTimingSegmentV2 {
                        t0: s.t0,
                        t1: s.t1,
                        from: s.from,
                        to: s.to,
                        mins: s.hull.mins,
                        maxs: s.hull.maxs,
                        discrete: u32::from(s.discrete),
                        reserved: 0,
                    };
                }
            }
            Ok(())
        })
    }
}
