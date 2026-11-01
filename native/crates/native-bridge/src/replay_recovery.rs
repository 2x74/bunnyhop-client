use crate::{BhContext, call, string};
use std::ffi::{c_char, c_int};
use std::path::Path;

/// Save the active command stream locally without ending or changing the simulation.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_record_recovery_bhr(ctx: *mut BhContext, path: *const c_char) -> c_int {
    unsafe {
        call(ctx, |context| {
            let map = context.map()?;
            if !map.record_valid {
                return Err("no valid recording to recover".into());
            }
            let mut replay = map
                .recorder
                .as_ref()
                .ok_or("no active recording to recover")?
                .data
                .clone();
            replay.start_tick = 0;
            replay.end_tick = 0;
            replay.write_bhr(Path::new(string(path)?))
        })
    }
}
