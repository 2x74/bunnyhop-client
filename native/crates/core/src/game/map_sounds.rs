//! What the map's I/O asked its sound entities to do, for the client to play (apps/web/src/audio/map-sounds.ts).
//!
//! Display only. `entity_input` writes here and returns to what it was doing; nothing in the simulation reads any of
//! it, so runs simulate exactly as they did without it (tools/verify/wasm-identity.ts). The state is part of the
//! snapshot so a replay seek or a practice checkpoint brings the sounds back to what they were at that tick.
//!
//! `AmbientSound` is CAmbientGeneric's on / off logic (game/server/sound.cpp): ToggleSound, InputPlaySound,
//! InputStopSound, InputVolume, InputPitch and the spawnflags read in Spawn / Precache.

use super::Game;
use crate::entities::Entity;

const SF_AMBIENT_SOUND_START_SILENT: i64 = 16;
const SF_AMBIENT_SOUND_NOT_LOOPING: i64 = 32;

/// Commands kept between two reads: a client that never reads (the verifier) doesn't grow.
const MAX_COMMANDS: usize = 16;

/// `AmbientSound::flags`, `map_sound_states`.
pub const MAP_SOUND_ACTIVE: u32 = 1;
pub const MAP_SOUND_REMOVED: u32 = 2;
/// The newest thing that happened was a start, not a stop.
pub const MAP_SOUND_LAST_START: u32 = 4;

#[derive(Clone, Debug)]
pub struct AmbientSound {
    /// Entity index (`Game::entities` order).
    pub ent: u32,
    looping: bool,
    /// m_fActive: true only while a looping sound is on.
    active: bool,
    /// How many times the sound was sent to play / told to stop.
    pub starts: u32,
    pub stops: u32,
    last_start: bool,
    /// Last Volume input as m_dpv.vol (0..100), -1 before one.
    pub volume: f32,
    /// Last Pitch input as m_dpv.pitch (0..255), -1 before one.
    pub pitch: f32,
}

impl AmbientSound {
    fn new(ent: u32, e: &Entity) -> Self {
        let flags = e.int("spawnflags");
        let looping = flags & SF_AMBIENT_SOUND_NOT_LOOPING == 0;
        Self { ent, looping, active: looping && flags & SF_AMBIENT_SOUND_START_SILENT == 0, starts: 0, stops: 0, last_start: false, volume: -1.0, pitch: -1.0 }
    }

    fn stop(&mut self) {
        self.stops = self.stops.wrapping_add(1);
        self.last_start = false;
    }

    fn start(&mut self) {
        self.starts = self.starts.wrapping_add(1);
        self.last_start = true;
    }

    /// CAmbientGeneric::ToggleSound.
    fn toggle(&mut self) {
        if self.active {
            self.active = false;
            self.stop();
        } else {
            if self.looping {
                self.active = true;
            }
            self.start();
        }
    }

    pub fn flags(&self) -> u32 {
        (self.active as u32 * MAP_SOUND_ACTIVE) | (self.last_start as u32 * MAP_SOUND_LAST_START)
    }

    /// One of CAmbientGeneric's inputs. `input` is lower-case.
    fn input(&mut self, input: &str, param: &str) {
        let value = || param.trim().parse::<f32>().unwrap_or(0.0);
        match input {
            // InputPlaySound: if not already on, stop what may still be playing and toggle.
            "playsound" => {
                if !self.active {
                    self.toggle();
                }
            }
            "stopsound" => {
                if self.active {
                    self.toggle();
                }
            }
            "togglesound" => self.toggle(),
            "volume" => self.volume = (value() * 10.0).round().clamp(0.0, 100.0),
            "pitch" => self.pitch = value().trunc().clamp(0.0, 255.0),
            // Kill (UpdateOnRemove) is read through the entity's `removed`.
            _ => {}
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct MapSounds {
    /// In entity order.
    pub ambients: Vec<AmbientSound>,
}

impl MapSounds {
    pub fn new(entities: &[Entity]) -> Self {
        let ambients = entities
            .iter()
            .enumerate()
            .filter(|(_, e)| e.classname().eq_ignore_ascii_case("ambient_generic"))
            .map(|(i, e)| AmbientSound::new(i as u32, e))
            .collect();
        Self { ambients }
    }
}

impl Game {
    /// Called for every input an entity receives, before it is handled. Changes nothing but `map_sounds`.
    pub(super) fn map_sound_input(&mut self, i: usize, input: &str, param: &str) {
        match input {
            "playsound" | "stopsound" | "togglesound" | "volume" | "pitch" | "kill" | "killhierarchy" => {
                let Ok(at) = self.map_sounds.ambients.binary_search_by_key(&(i as u32), |a| a.ent) else { return };
                self.map_sounds.ambients[at].input(input, param);
                self.map_sound_serial = self.map_sound_serial.wrapping_add(1);
            }
            // `play <sound>` through point_clientcommand: the client that ran it plays the file, flat.
            "command" => {
                let t = param.trim();
                let cmd = t.split_whitespace().next().unwrap_or("");
                if !(cmd.eq_ignore_ascii_case("play") || cmd.eq_ignore_ascii_case("playgamesound")) || !self.ents[i].class.eq_ignore_ascii_case("point_clientcommand") {
                    return;
                }
                if self.map_sound_commands.len() < MAX_COMMANDS {
                    self.map_sound_commands.push(t.to_string());
                    self.map_sound_serial = self.map_sound_serial.wrapping_add(1);
                }
            }
            _ => {}
        }
    }

    /// The ambient_generics now, in entity order.
    pub fn map_sound_states(&self) -> impl Iterator<Item = (&AmbientSound, bool)> + '_ {
        self.map_sounds.ambients.iter().map(|a| (a, self.ents.get(a.ent as usize).is_none_or(|e| e.removed)))
    }

    /// Bumped whenever `map_sound_states` or the command list may read differently: the client's per-frame check.
    pub fn map_sound_serial(&self) -> u32 {
        self.map_sound_serial
    }

    /// `play` commands run since the last call.
    pub fn take_map_sound_commands(&mut self) -> Vec<String> {
        std::mem::take(&mut self.map_sound_commands)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ambient(flags: i64) -> AmbientSound {
        let e = Entity { pairs: vec![("classname".into(), "ambient_generic".into()), ("spawnflags".into(), flags.to_string())] };
        AmbientSound::new(7, &e)
    }

    #[test]
    fn a_looping_sound_on_from_the_start_ignores_play_and_stops_once() {
        let mut a = ambient(0);
        assert_eq!(a.flags() & MAP_SOUND_ACTIVE, MAP_SOUND_ACTIVE);
        a.input("playsound", "");
        assert_eq!((a.starts, a.stops), (0, 0));
        a.input("stopsound", "");
        a.input("stopsound", "");
        assert_eq!((a.starts, a.stops), (0, 1));
        assert_eq!(a.flags(), 0);
        a.input("togglesound", "");
        assert_eq!((a.starts, a.flags()), (1, MAP_SOUND_ACTIVE | MAP_SOUND_LAST_START));
    }

    #[test]
    fn a_sound_that_does_not_loop_replays_on_every_play_and_is_never_active() {
        let mut a = ambient(SF_AMBIENT_SOUND_NOT_LOOPING | SF_AMBIENT_SOUND_START_SILENT);
        a.input("playsound", "");
        a.input("playsound", "");
        a.input("togglesound", "");
        assert_eq!(a.starts, 3);
        assert_eq!(a.flags(), MAP_SOUND_LAST_START);
        // StopSound only acts on an active one (the SDK's InputStopSound).
        a.input("stopsound", "");
        assert_eq!(a.stops, 0);
    }

    #[test]
    fn start_silent_stays_off_until_asked() {
        let mut a = ambient(SF_AMBIENT_SOUND_START_SILENT);
        assert_eq!(a.flags(), 0);
        a.input("playsound", "");
        assert_eq!((a.starts, a.flags()), (1, MAP_SOUND_ACTIVE | MAP_SOUND_LAST_START));
    }

    #[test]
    fn volume_and_pitch_clamp_like_the_inputs() {
        let mut a = ambient(0);
        a.input("volume", "3.26");
        assert_eq!(a.volume, 33.0);
        a.input("volume", "50");
        assert_eq!(a.volume, 100.0);
        a.input("pitch", "300");
        assert_eq!(a.pitch, 255.0);
    }
}
