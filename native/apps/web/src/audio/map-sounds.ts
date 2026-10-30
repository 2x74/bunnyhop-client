// Map sounds: what a BSP places and plays, positioned where the map puts it. ambient_generic and soundscapes from the
// entity lump, `play` commands from map I/O. research/MAP-SOUNDS.md has what's covered and what isn't.
//
//   startMapSounds(core, bsp)   (audio/index.ts) once the map is up: reads the entities, loads files in the background
//   sounds.frame(core)          per rendered frame, with the sim to read state from (the live one or the viewer's)
//
// Nothing here can hold up a map or a run: loading is fire and forget and a sound whose file hasn't arrived is simply
// silent until it does. Nothing here touches the simulation: the core reports what the map asked for, and only that.
//
// Only files named by the map's allow list (`optional.mapSounds` in its content manifest, tools/map-sounds/) ever play:
// no list, no sound. Files inside the BSP's pakfile are read from memory (the player already downloaded them with the
// map); the rest are stock game files, fetched one at a time when idle.
//
// Following the engine (SDK 2013 game/server/sound.cpp, game/server/soundscape.cpp, game/client/c_soundscape.cpp):
//   radius -> sound level -> distance falloff: ComputeSoundlevel, then gain = 1 / (distance * mult) from the reference
//   distance out. A WebAudio panner with the inverse distance model and that reference distance is this curve.
//   looping: the file decides (a cue or smpl chunk). The entity's flag only says whether it counts as on.
//   stereo files: attenuated by distance but not panned; mono files are panned.
//
// Per frame this does one number compare unless the map's state changed. Voices are assigned 5 times a second and
// nodes are pooled: each voice owns a gain and a panner, a sound start allocates one AudioBufferSourceNode.

import type { Core } from "../core";
import { MAP_SOUND_ACTIVE, MAP_SOUND_LAST_START, MAP_SOUND_REMOVED, MAP_SOUND_STRIDE, traceRay } from "../core";
import { contentKey, type MapSoundGroup } from "../content/manifest";
import { fetchBytes } from "../content/fetch";
import { sha256Hex } from "../replay";
import { bspModelBounds } from "../zones";
import type { AudioEngine } from "./engine";
import { decodeWavSamples, parseSound, soundPath, isSoundFileName, zipEntries, zipStored, type Interval, type PakEntry, type Soundscape } from "./map-sound-format";

/** Voices at once. Far more than a map plays audibly in one place; loudest first when it isn't. */
export const MAX_VOICES = 32;
/** CAmbientGeneric's MIN_AUDIBLE_VOLUME. Below this a sound gets no voice. */
const MIN_AUDIBLE = 1.01e-3;
const ASSIGN_SECONDS = 0.2;
const SCAPE_SECONDS = 0.5;
/** soundscape_fadetime. */
const SCAPE_FADE = 3;
const SWAP_FADE = 0.05;
/** Decoded audio held for one map. */
const MAX_DECODED_BYTES = 128e6;
const REF_DB = 60;
const REF_DISTANCE = 36;

// -------------------------------------------------------------------------------------------------
// Source's numbers

/** ComputeSoundlevel: 0 plays everywhere. */
export function soundLevelFromRadius(radius: number, everywhere: boolean): number {
  if (!(radius > 0) || everywhere) return 0;
  return Math.trunc(40 + 20 * Math.log10(radius / REF_DISTANCE));
}

/** The distance from which a sound level starts falling off (1 / SNDLVL_TO_DIST_MULT). */
export function referenceDistance(level: number): number {
  return REF_DISTANCE * Math.pow(10, (level - REF_DB) / 20);
}

/** Gain at `distance` for a sound level. */
export function distanceGain(level: number, distance: number): number {
  if (!level) return 1;
  const ref = referenceDistance(level);
  return distance <= ref ? 1 : ref / distance;
}

// sound.cpp rgdpvpreset: pitch, pitchstart, spinup, spindown, volrun, volstart, fadein, fadeout.
const PRESETS: readonly (readonly number[])[] = [
  [255, 75, 95, 95, 10, 1, 50, 95], [255, 85, 70, 88, 10, 1, 20, 88], [255, 100, 50, 75, 10, 1, 10, 75], [100, 100, 0, 0, 10, 1, 90, 90], [100, 100, 0, 0, 10, 1, 80, 80], [100, 100, 0, 0, 10, 1, 50, 70],
  [100, 100, 0, 0, 5, 1, 40, 50], [100, 100, 0, 0, 5, 1, 40, 50], [100, 100, 0, 0, 5, 1, 40, 50], [128, 100, 50, 75, 10, 1, 30, 40], [128, 100, 50, 75, 10, 1, 30, 40], [128, 100, 50, 75, 10, 1, 30, 40],
  [50, 50, 0, 0, 10, 1, 20, 50], [70, 70, 0, 0, 10, 1, 20, 50], [90, 90, 0, 0, 10, 1, 20, 50], [120, 120, 0, 0, 10, 1, 20, 50], [180, 180, 0, 0, 10, 1, 20, 50], [255, 255, 0, 0, 10, 1, 20, 50],
  [200, 75, 90, 90, 10, 1, 50, 90], [255, 75, 97, 90, 10, 1, 50, 90], [100, 100, 0, 0, 10, 1, 30, 50], [160, 160, 0, 0, 10, 1, 50, 50], [255, 75, 88, 0, 10, 1, 40, 0], [200, 20, 95, 70, 10, 1, 70, 70],
  [180, 100, 50, 60, 10, 1, 40, 60], [60, 60, 0, 0, 10, 1, 40, 70], [128, 90, 10, 10, 10, 1, 20, 40],
];

export interface AmbientLevels {
  /** Running volume 0..1 and the one a fade starts from. */
  vol: number;
  volStart: number;
  /** Seconds to reach `vol` from `volStart` and back. */
  fadeIn: number;
  fadeOut: number;
  /** Pitch %, 100 = as recorded. */
  pitch: number;
  pitchStart: number;
  spinUp: number;
  spinDown: number;
}

/** The entity's ramps per second at the 5 Hz RampThink, as seconds. `perStep` is the fixed-point step per think. */
const rampSeconds = (distance: number, perStep: number) => (perStep > 0 ? Math.max(0, distance) / ((perStep * 5) / 256) : 0);

/** CAmbientGeneric::KeyValue + InitModulationParms, without the LFO. */
export function ambientLevels(e: Record<string, string>): AmbientLevels {
  const int = (k: string) => Math.trunc(Number.parseFloat(e[k] ?? "0")) || 0;
  const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
  let pitchRun = clamp(int("pitch"), 255);
  let pitchStart = clamp(int("pitchstart"), 255);
  let spinUp = clamp(int("spinup"), 100);
  let spinDown = clamp(int("spindown"), 100);
  let volRun = clamp(int("health") * 10, 100);
  let volStart = clamp(int("volstart"), 10) * 10;
  // fadeinsecs / fadeoutsecs win over the legacy keys only by coming later in the lump; both are rare.
  let fadeIn = e.fadeinsecs !== undefined ? (clamp(int("fadeinsecs"), 100) ? (100 << 8) / (clamp(int("fadeinsecs"), 100) * 5) : 0) : clamp(int("fadein"), 100) ? (101 - clamp(int("fadein"), 100)) * 64 : 0;
  let fadeOut = e.fadeoutsecs !== undefined ? (clamp(int("fadeoutsecs"), 100) ? (100 << 8) / (clamp(int("fadeoutsecs"), 100) * 5) : 0) : clamp(int("fadeout"), 100) ? (101 - clamp(int("fadeout"), 100)) * 64 : 0;
  if (spinUp > 0) spinUp = (101 - spinUp) * 64;
  if (spinDown > 0) spinDown = (101 - spinDown) * 64;
  const preset = int("preset");
  if (preset > 0 && preset <= PRESETS.length) {
    const p = PRESETS[preset - 1];
    pitchRun = p[0];
    pitchStart = p[1];
    spinUp = p[2] > 0 ? (101 - p[2]) * 64 : 0;
    spinDown = p[3] > 0 ? (101 - p[3]) * 64 : 0;
    volRun = p[4] * 10;
    volStart = p[5] * 10;
    fadeIn = p[6] > 0 ? (101 - p[6]) * 64 : 0;
    fadeOut = p[7] > 0 ? (101 - p[7]) * 64 : 0;
  }
  const norm = (v: number) => (v === 0 ? 100 : v);
  return {
    vol: volRun / 100,
    volStart: volStart / 100,
    fadeIn: rampSeconds(volRun - volStart, fadeIn),
    fadeOut: rampSeconds(volRun - volStart, fadeOut),
    pitch: norm(pitchRun),
    pitchStart: norm(pitchStart),
    spinUp: rampSeconds(pitchRun - pitchStart, spinUp),
    spinDown: rampSeconds(pitchRun - pitchStart, spinDown),
  };
}

const roll = (v: Interval, random: () => number) => v[0] + v[1] * random();

/** InitModulationParms: where a sound starts when it has ramps. */
function rampUp(s: MapSound, l: AmbientLevels): void {
  s.stopping = false;
  s.vol = l.fadeIn > 0 ? l.volStart : s.volTarget;
  s.volRate = l.fadeIn > 0 ? Math.abs(s.volTarget - l.volStart) / l.fadeIn : 0;
  s.rate = l.spinUp > 0 ? l.pitchStart / 100 : s.rateTarget;
  s.rateStep = l.spinUp > 0 ? Math.abs(s.rateTarget - l.pitchStart / 100) / l.spinUp : 0;
}

// -------------------------------------------------------------------------------------------------

interface LoadedFile {
  buffer: AudioBuffer;
  channels: number;
  /** Seconds; loopStart < 0 when the file doesn't loop. */
  loopStart: number;
  loopEnd: number;
  duration: number;
}

/** One thing that can make sound: an entity, a soundscape wave, a command. */
interface MapSound {
  path: string;
  /** Set when loaded. */
  file: LoadedFile | null;
  /** Source units; meaningless when flat. */
  x: number;
  y: number;
  z: number;
  /** Sound level, 0 = plays everywhere with no position. */
  level: number;
  ref: number;
  /** Brush model the position follows, -1 for none. */
  model: number;
  mx: number;
  my: number;
  mz: number;
  vol: number;
  /** Soundscape crossfade and ramps: what `vol` moves toward and how fast per second (0 = there). */
  volTarget: number;
  volRate: number;
  /** Playback rate, pitch / 100, and the ramp it's on. */
  rate: number;
  rateTarget: number;
  rateStep: number;
  /** Fading or spinning down, then off (ToggleSound with fadeout / spindown). */
  stopping: boolean;
  /** A channel is running: from `t0` (context time) until stopped or the file runs out. */
  on: boolean;
  t0: number;
  /** This assign pass's audibility. */
  pri: number;
  voice: Voice | null;
  /** Dropped when it stops (a soundscape's random sound, a command). */
  transient: boolean;
  /** Entity state last seen. */
  ent: number;
  starts: number;
  stops: number;
  removed: boolean;
  levels: AmbientLevels | null;
  looping: boolean;
}

interface Voice {
  gain: GainNode;
  panner: PannerNode;
  src: AudioBufferSourceNode | null;
  sound: MapSound | null;
  /** Where the panner is. */
  px: number;
  py: number;
  pz: number;
  /** Gain and playback rate last sent, -1 unknown. */
  sent: number;
  rate: number;
  onEnded: (e: Event) => void;
}

interface ScapeEntity {
  name: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  positions: ([number, number, number] | null)[];
}

interface ScapeTrigger {
  mins: number[];
  maxs: number[];
  scape: ScapeEntity;
  inside: boolean;
}

interface RandomEntry {
  waves: string[];
  time: Interval;
  volume: Interval;
  pitch: Interval;
  level: Interval;
  master: number;
  /** Fixed position, "random" around the listener, or null for flat. */
  at: [number, number, number] | "random" | null;
  next: number;
}

function newSound(path: string): MapSound {
  return { path, file: null, x: 0, y: 0, z: 0, level: 0, ref: 1, model: -1, mx: 0, my: 0, mz: 0, vol: 0, volTarget: 0, volRate: 0, rate: 1, rateTarget: 1, rateStep: 0, stopping: false, on: false, t0: 0, pri: 0, voice: null, transient: false, ent: -1, starts: 0, stops: 0, removed: false, levels: null, looping: false };
}

function vec3(v: string | undefined): [number, number, number] | null {
  if (!v) return null;
  const p = v.trim().split(/\s+/).map(Number);
  return p.length >= 3 && p.every(Number.isFinite) ? [p[0], p[1], p[2]] : null;
}

export class MapSounds {
  private readonly sounds: MapSound[] = [];
  /** Ambient sounds by entity index. */
  private readonly byEnt = new Map<number, MapSound>();
  private readonly loaded = new Map<string, LoadedFile>();
  private readonly voices: Voice[] = [];
  private readonly ranked: MapSound[] = [];
  private readonly states: Float32Array;
  private readonly movers = new Set<number>();
  private hasMovers = false;
  private ready = false;
  private disposed = false;
  private lastAssign = -1;
  private lastScape = -1;
  private serial = -1;
  private core: Core | null = null;
  /** Sound starts while scrubbing a replay would be noise: `frame(core, false)` applies state without starting one-shots. */
  private live = true;
  private decodedBytes = 0;
  // Soundscapes.
  private readonly scapes: ScapeEntity[] = [];
  private readonly triggers: ScapeTrigger[] = [];
  private touching: ScapeTrigger[] = [];
  private current: ScapeEntity | null = null;
  private currentDistance = 0;
  private inRange = false;
  private scapeName = "";
  private readonly from: [number, number, number] = [0, 0, 0];
  private readonly to: [number, number, number] = [0, 0, 0];
  private loops: MapSound[] = [];
  private randoms: RandomEntry[] = [];
  /** Counters for the headless check and leak hunting. */
  readonly counters = { sourcesCreated: 0, sourcesEnded: 0, peakVoices: 0, assigns: 0 };

  constructor(
    private readonly engine: AudioEngine,
    private readonly group: MapSoundGroup,
    private readonly base: string,
    core: Core,
    bsp: Uint8Array | null,
    private readonly decodeMp3: (bytes: ArrayBuffer) => Promise<AudioBuffer> = () => Promise.reject(new Error("no MP3 decoder")),
    private readonly random: () => number = Math.random,
  ) {
    this.core = core;
    const ents = core.entities();
    const named = new Map<string, Record<string, string>>();
    for (const e of ents) {
      const n = e.targetname?.toLowerCase();
      if (n && !named.has(n)) named.set(n, e);
    }
    const bounds = bsp ? bspModelBounds(bsp) : null;
    let ambients = 0;
    ents.forEach((e, i) => {
      const c = e.classname?.toLowerCase();
      if (c === "ambient_generic") {
        ambients++;
        this.addAmbient(e, i, named, bounds);
      } else if (c === "env_soundscape") {
        const s = this.addScape(e, named);
        if (s) this.scapes.push(s);
      }
    });
    // trigger_soundscape names its env_soundscape_triggerable; both may come in any order in the lump.
    for (const e of ents) {
      if (e.classname?.toLowerCase() !== "trigger_soundscape") continue;
      const target = named.get((e.soundscape ?? "").toLowerCase());
      const model = /^\*(\d+)$/.exec(e.model ?? "");
      if (!target || !model || !bounds) continue;
      const b = bounds[Number(model[1])];
      const origin = vec3(e.origin) ?? [0, 0, 0];
      const s = this.addScape(target, named);
      if (b && s) this.triggers.push({ mins: b.mins.map((v, k) => v + origin[k]), maxs: b.maxs.map((v, k) => v + origin[k]), scape: s, inside: false });
    }
    this.states = new Float32Array(ambients * MAP_SOUND_STRIDE);
    void this.load();
  }

  private addScape(e: Record<string, string>, named: Map<string, Record<string, string>>): ScapeEntity | null {
    const name = (e.soundscape ?? "").trim().toLowerCase();
    if (!name || !this.group.scapes?.[name]) return null;
    const o = vec3(e.origin) ?? [0, 0, 0];
    const positions: ScapeEntity["positions"] = [];
    for (let i = 0; i < 8; i++) {
      const target = e[`position${i}`];
      const at = target ? named.get(target.toLowerCase()) : undefined;
      positions.push(at ? vec3(at.origin) : null);
    }
    const r = Number.parseFloat(e.radius ?? "128");
    return { name, x: o[0], y: o[1], z: o[2], radius: Number.isFinite(r) ? r : 128, positions };
  }

  private addAmbient(e: Record<string, string>, ent: number, named: Map<string, Record<string, string>>, bounds: { mins: number[]; maxs: number[] }[] | null): void {
    const message = (e.message ?? "").trim();
    if (!message) return;
    let path: string | null = null;
    let scriptLevel: number | undefined;
    if (isSoundFileName(message)) path = soundPath(message);
    else {
      const script = this.group.scripts?.[message.toLowerCase()];
      if (script?.waves.length) {
        path = script.waves[Math.floor(this.random() * script.waves.length)];
        scriptLevel = script.level?.[0];
      }
    }
    if (!path || !this.group.files[path]) return;
    const flags = Number.parseInt(e.spawnflags ?? "0") | 0;
    const everywhere = !!(flags & 1);
    const levels = ambientLevels(e);
    const s = newSound(path);
    const radius = Number.parseFloat(e.radius ?? "0") || 0;
    // SoundEmitterSystem: a soundscript name plays at the script's own level.
    s.level = scriptLevel !== undefined ? scriptLevel : soundLevelFromRadius(radius, everywhere);
    s.ref = referenceDistance(s.level);
    const o = vec3(e.origin) ?? [0, 0, 0];
    s.x = o[0];
    s.y = o[1];
    s.z = o[2];
    // SourceEntityName: the sound comes from that entity instead, a brush's center when it has one.
    const source = e.sourceentityname ? named.get(e.sourceentityname.toLowerCase()) : undefined;
    if (source) {
      const so = vec3(source.origin) ?? o;
      s.x = so[0];
      s.y = so[1];
      s.z = so[2];
      const model = /^\*(\d+)$/.exec(source.model ?? "");
      if (model) {
        s.model = Number(model[1]);
        const b = bounds?.[s.model];
        if (b) {
          s.mx = (b.mins[0] + b.maxs[0]) / 2;
          s.my = (b.mins[1] + b.maxs[1]) / 2;
          s.mz = (b.mins[2] + b.maxs[2]) / 2;
        }
        this.movers.add(s.model);
        this.hasMovers = true;
      }
    }
    s.ent = ent;
    s.levels = levels;
    s.volTarget = levels.vol;
    s.rateTarget = levels.pitch / 100;
    s.looping = !(flags & 32);
    rampUp(s, levels);
    // Precache: on from the start only if looping and not start-silent.
    s.on = s.looping && !(flags & 16) && levels.vol > 0;
    this.sounds.push(s);
    this.byEnt.set(ent, s);
  }

  // -----------------------------------------------------------------------------------------------
  // Files

  /** Reads what this map may play, nearest need first. Fire and forget. */
  private async load(): Promise<void> {
    const files = this.group.files;
    // Sounds that are on from the start first, then the rest.
    const order = new Set<string>();
    for (const s of this.sounds) if (s.on) order.add(s.path);
    for (const s of this.sounds) order.add(s.path);
    for (const p of Object.keys(files)) order.add(p);
    let pak: Map<string, PakEntry> | null = null;
    for (const path of order) {
      if (this.disposed) return;
      const f = files[path];
      if (!f || this.loaded.has(path) || this.decodedBytes > MAX_DECODED_BYTES) continue;
      await idle();
      if (this.disposed) return;
      try {
        let bytes: Uint8Array | null = null;
        if (f.stock) {
          bytes = await fetchBytes(`${this.base}/${contentKey(f.sha256)}`, { cacheSha256: f.sha256, attempts: 2, headerTimeoutMs: 15_000, idleTimeoutMs: 15_000, expectedSize: f.size });
          if ((await sha256Hex(bytes as Uint8Array<ArrayBuffer>)) !== f.sha256) throw new Error("hash mismatch");
        } else if (this.core) {
          const view = this.core.pakView();
          pak ??= new Map(zipEntries(view).map((x) => [x.name, x]));
          const e = pak.get(path);
          const stored = e ? zipStored(view, e) : null;
          bytes = stored ? stored.slice() : null;
        }
        if (!bytes) continue;
        const file = await decodeFile(path, bytes, this.decodeMp3);
        if (file && !this.disposed) {
          this.loaded.set(path, file);
          this.decodedBytes += file.buffer.length * file.buffer.numberOfChannels * 4;
          const now = this.engine.now;
          for (const s of this.sounds) {
            if (s.path !== path) continue;
            s.file = file;
            // On from the start but the file doesn't loop: it plays once, from now, rather than having run out unheard.
            // A sound the map fired while its file was on the way just runs from when it was fired.
            if (s.on && file.loopStart < 0 && !s.starts) s.t0 = now;
          }
        }
      } catch (e) {
        console.warn(`map sounds: ${path}: ${(e as Error).message}`);
      }
    }
    this.ready = true;
  }

  // -----------------------------------------------------------------------------------------------
  // Per frame

  /** Per rendered frame, with the sim whose state applies now. `live` false: scrubbing (no one-shots). */
  frame(core: Core, live = true): void {
    const ctx = this.engine.ctx;
    if (this.disposed || !ctx || ctx.state !== "running") return;
    const now = ctx.currentTime;
    if (core !== this.core) {
      this.core = core;
      this.serial = -1;
    }
    this.live = live;
    const serial = core.mapSoundSerial();
    if (serial !== this.serial) {
      this.serial = serial;
      this.applyState(core, now);
    }
    if (now - this.lastAssign < ASSIGN_SECONDS && this.lastAssign >= 0) return;
    const dt = this.lastAssign < 0 ? 0 : now - this.lastAssign;
    this.lastAssign = now;
    this.tickScapes(core, now);
    this.assign(core, now, dt);
  }

  /** The map's state moved: starts, stops, volume and pitch since the last look. */
  private applyState(core: Core, now: number): void {
    const n = core.mapSoundStates(this.states);
    for (let i = 0; i + MAP_SOUND_STRIDE <= n; i += MAP_SOUND_STRIDE) {
      const s = this.byEnt.get(this.states[i]);
      if (!s) continue;
      const flags = this.states[i + 1];
      const starts = this.states[i + 2];
      const stops = this.states[i + 3];
      const volume = this.states[i + 4];
      const pitch = this.states[i + 5];
      if (flags & MAP_SOUND_REMOVED) {
        if (s.on) this.stopSound(s);
        s.removed = true;
        continue;
      }
      const levels = s.levels!;
      const vol = volume >= 0 ? volume / 100 : levels.vol;
      if (vol !== s.volTarget) {
        s.volTarget = vol;
        s.vol = vol;
      }
      const rate = (pitch > 0 ? pitch : levels.pitch) / 100;
      if (rate !== s.rateTarget) {
        s.rateTarget = rate;
        s.rate = rate;
        s.rateStep = 0;
      }
      // Back to an earlier state: counters went down, or a restart brought a killed entity back.
      const backward = starts < s.starts || stops < s.stops || s.removed;
      s.removed = false;
      const moved = starts !== s.starts || stops !== s.stops;
      s.starts = starts;
      s.stops = stops;
      if (backward) {
        // A restart or a seek: the state as it is at that moment. Non-loops have nothing to come back to.
        const active = (flags & MAP_SOUND_ACTIVE) !== 0;
        if (active && !s.on) this.startSound(s, now, levels.vol > 0);
        else if (!active && s.on) this.stopSound(s);
      } else if (moved) {
        // Scrubbing a replay doesn't fire one-shots; a loop that turned on along the way is on.
        if (flags & MAP_SOUND_LAST_START) {
          if (this.live || flags & MAP_SOUND_ACTIVE) this.startSound(s, now, vol > 0);
        } else this.stopSound(s);
      }
    }
    for (const line of core.mapSoundCommands()) this.playCommand(line, now);
  }

  private startSound(s: MapSound, now: number, audible: boolean): void {
    s.on = audible;
    s.t0 = now;
    if (s.voice) this.release(s.voice, now);
    if (s.levels) rampUp(s, s.levels);
    this.lastAssign = -1;
  }

  private stopSound(s: MapSound): void {
    const l = s.levels;
    // ToggleSound: a sound with a fade or spin down runs it out before it stops.
    if (s.on && l && (l.fadeOut > 0 || l.spinDown > 0)) {
      s.stopping = true;
      if (l.fadeOut > 0) {
        s.volTarget = l.volStart;
        s.volRate = Math.abs(s.vol - l.volStart) / l.fadeOut;
      }
      if (l.spinDown > 0) {
        s.rateTarget = l.pitchStart / 100;
        s.rateStep = Math.abs(s.rate - s.rateTarget) / l.spinDown;
      }
      return;
    }
    s.on = false;
    if (s.voice) this.release(s.voice, this.engine.now);
  }

  private playCommand(line: string, now: number): void {
    const parts = line.trim().split(/\s+/);
    const name = parts[1];
    if (!name) return;
    const path = isSoundFileName(name) ? soundPath(name) : soundPath(`${name}.wav`);
    const f = this.loaded.get(path);
    if (!f || !this.group.files[path] || !this.live) return;
    const s = newSound(path);
    s.file = f;
    s.vol = s.volTarget = 1;
    s.transient = true;
    s.on = true;
    s.t0 = now;
    this.sounds.push(s);
    this.lastAssign = -1;
  }

  // -----------------------------------------------------------------------------------------------
  // Soundscapes (soundscape.cpp UpdateForPlayer, c_soundscape.cpp)

  private tickScapes(core: Core, now: number): void {
    if (!this.scapes.length && !this.triggers.length) return;
    const lx = this.engine.listenerX;
    const ly = this.engine.listenerY;
    const lz = this.engine.listenerZ;
    if (now - this.lastScape >= SCAPE_SECONDS || this.lastScape < 0) {
      this.lastScape = now;
      for (let i = 0; i < this.triggers.length; i++) {
        const t = this.triggers[i];
        const inside = lx >= t.mins[0] && lx <= t.maxs[0] && ly >= t.mins[1] && ly <= t.maxs[1] && lz >= t.mins[2] && lz <= t.maxs[2];
        if (inside !== t.inside) {
          t.inside = inside;
          // DelegateStartTouch puts the newest at the head of the list; DelegateEndTouch falls back to the next.
          this.touching = this.touching.filter((x) => x !== t);
          if (inside) this.touching.unshift(t);
        }
      }
      let next: ScapeEntity | null = this.touching.length ? this.touching[0].scape : null;
      if (!next) {
        for (let i = 0; i < this.scapes.length; i++) this.updateScape(core, this.scapes[i], lx, ly, lz);
        next = this.current;
      } else this.current = next;
      const name = next?.name ?? "";
      if (name !== this.scapeName) this.startScape(next, now);
    }
    // Loops move toward their level; the random ones come due.
    for (let i = 0; i < this.randoms.length; i++) {
      const r = this.randoms[i];
      if (now < r.next) continue;
      r.next = now + roll(r.time, this.random);
      this.playRandom(r, now, lx, ly, lz);
    }
  }

  private updateScape(core: Core, s: ScapeEntity, lx: number, ly: number, lz: number): void {
    const dx = lx - s.x;
    const dy = ly - s.y;
    const dz = lz - s.z;
    const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const within = s.radius > range || s.radius === -1;
    if (this.current === s) {
      this.currentDistance = range;
      this.inRange = false;
      if (within && this.sees(core, s, lx, ly, lz)) this.inRange = true;
    } else if ((!this.inRange || range < this.currentDistance) && within && this.sees(core, s, lx, ly, lz)) {
      this.current = s;
      this.inRange = true;
      this.currentDistance = range;
    }
  }

  private sees(core: Core, s: ScapeEntity, lx: number, ly: number, lz: number): boolean {
    this.from[0] = s.x;
    this.from[1] = s.y;
    this.from[2] = s.z;
    this.to[0] = lx;
    this.to[1] = ly;
    this.to[2] = lz;
    return traceRay(core, this.from, this.to, 0) >= 1;
  }

  /** StartNewSoundscape: fade the old loops out, reuse the ones that carry over, start the new. */
  private startScape(entity: ScapeEntity | null, now: number): void {
    this.scapeName = entity?.name ?? "";
    const old = this.loops;
    for (const l of old) {
      l.volTarget = 0;
      l.volRate = 1 / SCAPE_FADE;
    }
    this.randoms = [];
    const fresh: MapSound[] = [];
    if (entity) {
      const body = this.group.scapes?.[entity.name];
      if (body) this.startSubScape(body, entity, { master: 1, start: 0, posOverride: -1, ambOverride: -1, depth: 0 }, old, fresh, now);
    }
    this.loops = [...fresh, ...old.filter((l) => !fresh.includes(l))];
  }

  private startSubScape(body: Soundscape, entity: ScapeEntity, p: { master: number; start: number; posOverride: number; ambOverride: number; depth: number }, old: MapSound[], fresh: MapSound[], now: number): void {
    for (const l of body.loops) {
      if (!this.group.files[l.wave]) continue;
      const volume = p.master * roll(l.volume, this.random);
      if (volume === 0) continue;
      const pitch = roll(l.pitch, this.random);
      let index = l.position === undefined ? -1 : p.start + l.position;
      if (index < 0) index = p.ambOverride;
      else if (p.posOverride >= 0) index = p.posOverride;
      const at = index >= 0 ? (entity.positions[index] ?? null) : null;
      // No such position: the sound isn't played at all.
      if (index >= 0 && !at) continue;
      const level = at ? (l.level ? roll(l.level, this.random) : 70) : 0;
      // A loop that carries over keeps its place and fades to the new level.
      let s = old.find((x) => x.path === l.wave && !fresh.includes(x) && x.rate === pitch / 100 && x.level === level && (!at || (Math.abs(x.x - at[0]) < 0.1 && Math.abs(x.y - at[1]) < 0.1 && Math.abs(x.z - at[2]) < 0.1)));
      if (!s) {
        s = newSound(l.wave);
        s.file = this.loaded.get(l.wave) ?? null;
        s.rate = s.rateTarget = pitch / 100;
        s.level = Math.trunc(level);
        s.ref = referenceDistance(s.level);
        if (at) {
          s.x = at[0];
          s.y = at[1];
          s.z = at[2];
        }
        s.on = true;
        s.t0 = now;
        s.vol = 0;
        this.sounds.push(s);
      }
      s.volTarget = volume;
      s.volRate = 1 / SCAPE_FADE;
      fresh.push(s);
    }
    for (const r of body.randoms) {
      const waves = r.waves.filter((w) => this.group.files[w]);
      if (!waves.length) continue;
      let index = typeof r.position === "number" ? p.start + r.position : -1;
      let random = r.position === "random";
      if (index < 0) index = p.ambOverride;
      else if (p.posOverride >= 0) {
        index = p.posOverride;
        random = false;
      }
      const fixed = index >= 0 ? (entity.positions[index] ?? null) : null;
      if (index >= 0 && !fixed && !random) continue;
      this.randoms.push({ waves, time: r.time, volume: r.volume, pitch: r.pitch, level: r.level ?? [70, 0], master: p.master, at: random ? "random" : fixed, next: now + 0.5 * roll(r.time, this.random) });
    }
    if (p.depth >= 8) return;
    for (const sub of body.subs) {
      const b = this.group.scapes?.[sub.name];
      if (!b) continue;
      const next = { master: p.master * roll(sub.volume, this.random), start: p.start + (sub.position ?? 0), posOverride: p.posOverride, ambOverride: p.ambOverride, depth: p.depth + 1 };
      if (sub.positionOverride !== undefined && p.posOverride < 0) {
        next.posOverride = p.start + sub.positionOverride;
        next.ambOverride = next.posOverride;
      }
      if (sub.ambientOverride !== undefined && p.ambOverride < 0) next.ambOverride = p.start + sub.ambientOverride;
      this.startSubScape(b, entity, next, old, fresh, now);
    }
  }

  private playRandom(r: RandomEntry, now: number, lx: number, ly: number, lz: number): void {
    const wave = r.waves[Math.floor(this.random() * r.waves.length)];
    const f = this.loaded.get(wave);
    if (!f) return;
    const s = newSound(wave);
    s.file = f;
    s.vol = s.volTarget = r.master * roll(r.volume, this.random);
    s.rate = s.rateTarget = Math.trunc(roll(r.pitch, this.random)) / 100;
    s.transient = true;
    s.on = true;
    s.t0 = now;
    if (r.at) {
      s.level = Math.trunc(roll(r.level, this.random));
      s.ref = referenceDistance(s.level);
      if (r.at === "random") {
        // GenerateRandomSoundPosition: 36 units from the listener in some direction.
        const a = this.random() * Math.PI * 2;
        s.x = lx + 36 * Math.cos(a);
        s.y = ly + 36 * Math.sin(a);
        s.z = lz;
      } else {
        s.x = r.at[0];
        s.y = r.at[1];
        s.z = r.at[2];
      }
    }
    this.sounds.push(s);
  }

  // -----------------------------------------------------------------------------------------------
  // Voices

  /** Who gets a voice, loudest first; moves running voices to their sounds' positions and levels. */
  private assign(core: Core, now: number, dt: number): void {
    this.counters.assigns++;
    const lx = this.engine.listenerX;
    const ly = this.engine.listenerY;
    const lz = this.engine.listenerZ;
    if (this.hasMovers) {
      const origins = core.brushOrigins(this.movers);
      for (let i = 0; i < this.sounds.length; i++) {
        const s = this.sounds[i];
        if (s.model < 0) continue;
        const t = origins.get(s.model);
        if (t) {
          s.x = t[0] + s.mx;
          s.y = t[1] + s.my;
          s.z = t[2] + s.mz;
        }
      }
    }
    // Silence costs nothing: muted, the master at zero or this channel at zero hold no voices.
    const silent = this.engine.mapSilent;
    const ranked = this.ranked;
    ranked.length = 0;
    for (let i = this.sounds.length - 1; i >= 0; i--) {
      const s = this.sounds[i];
      if (s.volRate > 0) {
        const step = s.volRate * dt;
        s.vol = s.vol < s.volTarget ? Math.min(s.volTarget, s.vol + step) : Math.max(s.volTarget, s.vol - step);
        if (s.vol === s.volTarget) {
          s.volRate = 0;
          // A soundscape loop that faded out is done.
          if (s.vol === 0 && s.ent < 0) s.on = false;
        }
      }
      if (s.rateStep > 0) {
        const step = s.rateStep * dt;
        s.rate = s.rate < s.rateTarget ? Math.min(s.rateTarget, s.rate + step) : Math.max(s.rateTarget, s.rate - step);
        if (s.rate === s.rateTarget) s.rateStep = 0;
      }
      if (s.stopping && s.volRate === 0 && s.rateStep === 0) {
        s.on = false;
        s.stopping = false;
        if (s.levels) {
          s.volTarget = s.levels.vol;
          s.rateTarget = s.levels.pitch / 100;
        }
      }
      // A file that doesn't loop runs out.
      const f = s.file;
      if (s.on && f && f.loopStart < 0 && (now - s.t0) * s.rate >= f.duration) s.on = false;
      if (!s.on) {
        if (s.voice) this.release(s.voice, now);
        // Dropped when spent: random sounds, commands, faded soundscape loops.
        if (s.transient || (s.ent < 0 && s.volTarget === 0)) {
          this.sounds.splice(i, 1);
          const li = this.loops.indexOf(s);
          if (li >= 0) this.loops.splice(li, 1);
        }
        continue;
      }
      if (!f || silent) {
        if (s.voice) this.release(s.voice, now);
        continue;
      }
      const dx = s.x - lx;
      const dy = s.y - ly;
      const dz = s.z - lz;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      s.pri = s.level === 0 ? s.vol : s.vol * (distance <= s.ref ? 1 : s.ref / distance);
      if (s.pri < MIN_AUDIBLE) {
        if (s.voice) this.release(s.voice, now);
        continue;
      }
      // Insertion sort into the reused list: small, and nearly sorted from the last pass.
      let at = ranked.length;
      ranked.push(s);
      while (at > 0 && ranked[at - 1].pri < s.pri) {
        ranked[at] = ranked[at - 1];
        at--;
      }
      ranked[at] = s;
    }
    const keep = Math.min(MAX_VOICES, ranked.length);
    for (let i = keep; i < ranked.length; i++) if (ranked[i].voice) this.release(ranked[i].voice!, now);
    for (let i = 0; i < keep; i++) {
      const s = ranked[i];
      const v = s.voice ?? this.acquire(s, now);
      if (v) this.drive(v, s, now);
    }
    let busy = 0;
    for (let i = 0; i < this.voices.length; i++) if (this.voices[i].sound) busy++;
    if (busy > this.counters.peakVoices) this.counters.peakVoices = busy;
  }

  private acquire(s: MapSound, now: number): Voice | null {
    const ctx = this.engine.ctx!;
    let v: Voice | null = null;
    for (let i = 0; i < this.voices.length; i++) {
      if (!this.voices[i].sound && !this.voices[i].src) {
        v = this.voices[i];
        break;
      }
    }
    if (!v) {
      if (this.voices.length >= MAX_VOICES + 8) return null;
      const gain = ctx.createGain();
      const panner = ctx.createPanner();
      // HRTF is a convolution per voice; the engine's few close-by sounds use it, ambience doesn't need it.
      panner.panningModel = "equalpower";
      panner.distanceModel = "inverse";
      panner.rolloffFactor = 1;
      panner.maxDistance = 1e6;
      panner.connect(gain);
      gain.connect(this.engine.buses.map);
      const voice: Voice = {
        gain,
        panner,
        src: null,
        sound: null,
        px: NaN,
        py: NaN,
        pz: NaN,
        sent: -1,
        rate: -1,
        onEnded: (e) => {
          const src = e.target as AudioBufferSourceNode;
          src.disconnect();
          this.counters.sourcesEnded++;
          if (voice.src === src) {
            voice.src = null;
            if (voice.sound) {
              voice.sound.voice = null;
              voice.sound = null;
            }
          }
        },
      };
      this.voices.push(voice);
      v = voice;
    }
    const f = s.file!;
    const spatial = s.level !== 0 && f.channels === 1;
    const src = ctx.createBufferSource();
    this.counters.sourcesCreated++;
    src.buffer = f.buffer;
    src.playbackRate.value = s.rate;
    if (f.loopStart >= 0) {
      src.loop = true;
      src.loopStart = f.loopStart;
      src.loopEnd = f.loopEnd;
    }
    src.connect(spatial ? v.panner : v.gain);
    if (spatial) v.panner.refDistance = s.ref;
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(0, now);
    v.sent = -1;
    v.rate = s.rate;
    v.px = NaN;
    src.addEventListener("ended", v.onEnded);
    // Where the channel is by now: Source's channels keep running whether or not anyone hears them.
    let offset = (now - s.t0) * s.rate;
    if (f.loopStart >= 0 && offset >= f.loopEnd) offset = f.loopStart + ((offset - f.loopStart) % Math.max(1e-3, f.loopEnd - f.loopStart));
    if (offset < 0) offset = 0;
    src.start(now, Math.min(offset, f.duration));
    v.src = src;
    v.sound = s;
    s.voice = v;
    return v;
  }

  /** Position and level for a running voice. Only writes when something changed. */
  private drive(v: Voice, s: MapSound, now: number): void {
    const f = s.file!;
    const spatial = s.level !== 0 && f.channels === 1;
    if (spatial && (s.x !== v.px || s.y !== v.py || s.z !== v.pz)) {
      v.px = s.x;
      v.py = s.y;
      v.pz = s.z;
      const p = v.panner;
      if (p.positionX) {
        p.positionX.value = s.x;
        p.positionY.value = s.y;
        p.positionZ.value = s.z;
      } else (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(s.x, s.y, s.z);
    }
    // Panned voices fall off in the panner, sample accurate; a stereo file by distance here.
    const g = spatial || s.level === 0 ? s.vol : s.pri;
    if (Math.abs(g - v.sent) > 0.002) {
      v.gain.gain.setTargetAtTime(g, now, v.sent < 0 ? SWAP_FADE : 0.08);
      v.sent = g;
    }
    if (v.src && v.rate !== s.rate) {
      v.src.playbackRate.setTargetAtTime(s.rate, now, 0.05);
      v.rate = s.rate;
    }
  }

  /** The voice's sound is done or lost its place: fade quickly and stop. The source goes in onEnded. */
  private release(v: Voice, now: number): void {
    const s = v.sound;
    if (s) {
      s.voice = null;
      v.sound = null;
    }
    const src = v.src;
    if (!src) return;
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setTargetAtTime(0, now, SWAP_FADE / 2);
    try {
      src.stop(now + SWAP_FADE * 2);
    } catch {
      /* already stopped */
    }
    v.sent = -1;
  }

  // -----------------------------------------------------------------------------------------------

  /** For the headless check and the dev console. Allocates: not for the frame loop. */
  stats() {
    const voices = this.voices.filter((v) => v.sound).map((v) => {
      const s = v.sound!;
      const spatial = s.level !== 0 && s.file!.channels === 1;
      return { path: s.path, ent: s.ent, x: s.x, y: s.y, z: s.z, level: s.level, ref: s.ref, spatial, rate: v.src?.playbackRate.value, loop: v.src?.loop, loopStart: v.src?.loopStart, loopEnd: v.src?.loopEnd, panner: spatial ? [v.panner.positionX.value, v.panner.positionY.value, v.panner.positionZ.value, v.panner.refDistance, v.panner.rolloffFactor, v.panner.distanceModel] : null, gain: v.gain.gain.value, vol: s.vol };
    });
    return { ...this.counters, ready: this.ready, emitters: this.byEnt.size, sounds: this.sounds.length, on: this.sounds.filter((s) => s.on).length, loaded: this.loaded.size, decodedMB: this.decodedBytes / 1e6, voicesBuilt: this.voices.length, voices, scape: this.scapeName, scapes: this.scapes.length, triggers: this.triggers.length, randoms: this.randoms.length };
  }

  dispose(): void {
    this.disposed = true;
    const now = this.engine.now;
    for (const v of this.voices) {
      this.release(v, now);
      v.gain.disconnect();
      v.panner.disconnect();
    }
    this.sounds.length = 0;
  }
}

const idle = () => new Promise<void>((resolve) => (typeof requestIdleCallback === "function" ? requestIdleCallback(() => resolve(), { timeout: 250 }) : setTimeout(resolve, 16)));

async function decodeFile(path: string, bytes: Uint8Array, decodeMp3: (bytes: ArrayBuffer) => Promise<AudioBuffer>): Promise<LoadedFile | null> {
  const info = parseSound(path, bytes);
  let buffer: AudioBuffer | null = null;
  if (info.format === "mp3") buffer = await decodeMp3(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  else if (info.format === "wav") {
    const samples = decodeWavSamples(bytes, info);
    if (samples?.[0]?.length) {
      buffer = new AudioBuffer({ numberOfChannels: samples.length, length: samples[0].length, sampleRate: info.rate });
      samples.forEach((c, i) => buffer!.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    }
  }
  if (!buffer) return null;
  const rate = buffer.sampleRate;
  const loops = info.format === "wav" && info.loopStart >= 0 && info.loopStart < buffer.length;
  return {
    buffer,
    channels: buffer.numberOfChannels,
    duration: buffer.duration,
    loopStart: loops ? info.loopStart / rate : -1,
    loopEnd: loops ? (info.loopEnd > info.loopStart ? Math.min(info.loopEnd, buffer.length) : buffer.length) / rate : -1,
  };
}
