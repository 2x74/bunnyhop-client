//! Infinite's noclip on physics v24+: the shared core flies every command that carries `IN_FLIGHT`, so the flight is
//! recorded and re-simulated like any other movement and the run after it counts (website session.ts flightOn). The
//! host turns the flag on and off with the noclip key; the bridge ORs the bit into every live command while it is on
//! and clears it whenever the attempt starts over.
use super::*;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BhFlightState {
    /// The noclip key flies in the core here: Infinite on physics v24 or later (`Game::flight_allowed`).
    pub allowed: u32,
    /// The flag is on: every live command carries `IN_FLIGHT`.
    pub on: u32,
    /// The core is flying: the flag is on, or the flag is off but the landing found no free space yet.
    pub flying: u32,
}

impl Map {
    /// The live command as the core should see it: the flag's bit goes in before the style filter, which keeps it.
    pub(crate) fn with_flight(&self, mut cmd: BhCmd) -> BhCmd {
        if self.flight_on {
            cmd.buttons |= game::IN_FLIGHT;
        }
        cmd
    }
    /// Every reset, restart, style or track switch, settings or zones change, checkpoint restore and replay load starts
    /// a new attempt on the ground: the flag goes off with it. (A map load starts with a new `Map`.)
    pub(crate) fn end_flight(&mut self) {
        self.flight_on = false;
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_flight_set(ctx: *mut BhContext, on: u32) -> c_int {
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            if on != 0 && !m.game.flight_allowed() {
                return Err("only Infinite on physics v24 or later flies".into());
            }
            if m.playback.is_some() {
                return Err("stop playback before flying".into());
            }
            m.flight_on = on != 0;
            Ok(())
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_flight_state(ctx: *mut BhContext, out: *mut BhFlightState) -> c_int {
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            output(
                out,
                BhFlightState {
                    allowed: u32::from(m.game.flight_allowed()),
                    on: u32::from(m.flight_on),
                    flying: u32::from(m.game.flying()),
                },
            )
        })
    }
}
