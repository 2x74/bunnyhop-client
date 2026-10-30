//! Read-only map audio observations. No audio preferences enter the game or recorder.
use super::*;
use std::io::{Read, Seek, SeekFrom};

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct BhMapSoundState {
    pub entity: u32,
    pub flags: u32,
    pub starts: u32,
    pub stops: u32,
    pub volume: f32,
    pub pitch: f32,
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_map_sound_serial(ctx: *const BhContext) -> u32 {
    unsafe {
        read(ctx, 0, |c| {
            c.map.as_ref().map_or(0, |m| m.game.map_sound_serial())
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_map_sound_states(
    ctx: *const BhContext,
    out: *mut BhMapSoundState,
    capacity: usize,
) -> usize {
    unsafe {
        read(ctx, 0, |c| {
            let Some(m) = &c.map else { return 0 };
            if out.is_null() {
                return 0;
            }
            let mut count = 0;
            for (ambient, removed) in m.game.map_sound_states().take(capacity) {
                out.add(count).write(BhMapSoundState {
                    entity: ambient.ent,
                    flags: ambient.flags() | if removed { game::MAP_SOUND_REMOVED } else { 0 },
                    starts: ambient.starts,
                    stops: ambient.stops,
                    volume: ambient.volume,
                    pitch: ambient.pitch,
                });
                count += 1;
            }
            count
        })
    }
}

// Newline-delimited commands, bounded by the caller's reusable buffer. Oversized commands are dropped whole.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_map_sound_commands(
    ctx: *mut BhContext,
    out: *mut u8,
    capacity: usize,
) -> usize {
    let mut count = 0;
    unsafe {
        call(ctx, |c| {
            if out.is_null() {
                return Err("null audio command buffer".into());
            }
            for command in c.map()?.game.take_map_sound_commands() {
                if command.len() + 1 > capacity - count {
                    continue;
                }
                ptr::copy_nonoverlapping(command.as_ptr(), out.add(count), command.len());
                count += command.len();
                out.add(count).write(b'\n');
                count += 1;
            }
            Ok(())
        });
    }
    count
}

pub struct BhSoundPak {
    source: vfs::Source,
}

// Worker-only: read just the pak lump, without loading a second simulation or render mesh.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_sound_pak_open(path: *const c_char) -> *mut BhSoundPak {
    catch_unwind(AssertUnwindSafe(|| -> Result<_, String> {
        let mut file = std::fs::File::open(unsafe { string(path)? }).map_err(|e| e.to_string())?;
        let mut header = [0u8; 1036];
        file.read_exact(&mut header).map_err(|e| e.to_string())?;
        if &header[..4] != b"VBSP" {
            return Err("invalid BSP".into());
        }
        let at = 8 + 40 * 16;
        let number =
            |offset| u32::from_le_bytes(header[offset..offset + 4].try_into().unwrap()) as u64;
        let offset = number(at);
        let length = number(at + 4);
        if length > 768 * 1024 * 1024
            || offset + length > file.metadata().map_err(|e| e.to_string())?.len()
        {
            return Err("invalid pak lump".into());
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut bytes = vec![0; length as usize];
        file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        Ok(Box::into_raw(Box::new(BhSoundPak {
            source: vfs::Source::from_zip("audio", bytes),
        })))
    }))
    .ok()
    .and_then(Result::ok)
    .unwrap_or(ptr::null_mut())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_sound_pak_read(
    pak: *const BhSoundPak,
    path: *const c_char,
    size: *mut usize,
) -> *const u8 {
    catch_unwind(AssertUnwindSafe(|| {
        if pak.is_null() || size.is_null() {
            return ptr::null();
        }
        unsafe {
            size.write(0);
        }
        let Ok(path) = (unsafe { string(path) }) else {
            return ptr::null();
        };
        let Some(bytes) = (unsafe { &*pak }).source.get(path) else {
            return ptr::null();
        };
        unsafe {
            size.write(bytes.len());
        }
        bytes.as_ptr()
    }))
    .unwrap_or(ptr::null())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_sound_pak_close(pak: *mut BhSoundPak) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if !pak.is_null() {
            drop(unsafe { Box::from_raw(pak) });
        }
    }));
}
