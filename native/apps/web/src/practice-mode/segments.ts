// Segmented runs (styles.ts isSegmented; research/SEGMENTED.md): bhoptimer's "segments" checkpoints. In a clean
// Segmented attempt a checkpoint load doesn't make the run practice: like any checkpoint teleport it restores the full
// simulation snapshot (player, doors, triggers, the I/O queue: checkpoints.ts) and the run timer, and here the recording
// goes back to the checkpoint too, so the run carries on from it as if what happened since the save never had. The
// replay is the stitched path: the commands from the reset to each checkpoint that was loaded, then on from the load.
// Because a load restores the whole simulation as it was at the save, those commands re-simulate continuously from
// the reset, exactly like any other replay, and the verifier proves the run tick for tick (verifier.ts, sim.ts).
//
// bhoptimer copies the replay frames into every segmented checkpoint (shavit-checkpoints aFrames; at most 10 of
// them, "Segmented checkpoints contain frame data!"). Here every recorded tick goes once into an append-only log, and a
// checkpoint keeps only its path through the log (a few ranges), so all 100 checkpoints stay loadable, also one saved
// on a branch that a later load abandoned, at the memory of the ticks played (about 80 bytes each, MAX_LOG_TICKS).
// A restart starts a new path in the same log: a checkpoint from an earlier attempt is loadable too (bhoptimer's are,
// they hold their frames and timer), and continues that attempt.
// DOM-free (apps/web/test/segmented.test.ts).

import type { Checkpoint, CosmeticEvent, LookSample, ReplayRecorder, SegmentLoad } from "../replay";
import type { TurnSpeed } from "../turn-binds";

/** Floats per live frame (sim.ts FRAME_STRIDE: x, y, z, flags, yaw, pitch). */
const STRIDE = 6;
/** Log length limit: 4 h at 100 tick, the longest run the server takes (apps/api/src/run-clock.ts MAX_BEATS). */
export const MAX_LOG_TICKS = 1_440_000;

/** One command as the session records it (ReplayRecorder.push) with the live frame drawn after it. */
export interface LoggedTick {
  forward: number;
  side: number;
  yaw: number;
  pitch: number;
  buttons: number;
  look: LookSample | null;
  /** The live frame after the tick (session.ts pushFrame: FRAME_STRIDE floats) and its jump / teleport events. */
  frame: ArrayLike<number>;
  frameEvents: number;
}

/** A checkpoint's place in the run: its stitched path through the log, the loads on it and the recording's flags. */
export interface SegmentMark {
  /** The log this path belongs to (a cleared log can't rebuild it). */
  gen: number;
  /** [from, to) log ranges, flattened, in path order. */
  ranges: number[];
  /** Stitched ticks (commands) on the path: the sum of the ranges, the core's tick at the save. */
  ticks: number;
  loads: SegmentLoad[];
  /** The recording's tick-0 frame (the attempt's reset) and the header flags and turn speed it had. */
  frame0: number[];
  frame0Events: number;
  nullBinds: boolean;
  timedInput: boolean;
  /** Release W on jump (header.wRelease); absent on marks from before it existed. */
  wRelease?: boolean;
  turnSpeed: TurnSpeed | null;
}

class Columns {
  n = 0;
  forward = new Int16Array(4096);
  side = new Int16Array(4096);
  buttons = new Uint32Array(4096);
  yaw = new Float32Array(4096);
  pitch = new Float32Array(4096);
  frames = new Float32Array(4096 * STRIDE);
  frameEvents = new Uint8Array(4096);
  looks: (LookSample | null)[] = [];
  /** Replay checkpoints taken after the entry (ReplayRecorder.maybeCheckpoint), by entry. */
  cps = new Map<number, { position: [number, number, number]; velocity: [number, number, number] }>();
  /** Cosmetic / inspect events recorded after the entry (-1: before the attempt's first command), by entry. */
  cosmetic = new Map<number, number[]>();
  inspect = new Map<number, number[]>();

  grow(): void {
    const g = <T extends Int16Array | Uint32Array | Float32Array | Uint8Array>(a: T, k = 1): T => {
      const b = new (a.constructor as new (n: number) => T)(a.length * 2);
      b.set(a);
      return b;
    };
    this.forward = g(this.forward);
    this.side = g(this.side);
    this.buttons = g(this.buttons);
    this.yaw = g(this.yaw);
    this.pitch = g(this.pitch);
    this.frames = g(this.frames);
    this.frameEvents = g(this.frameEvents);
  }
}

export class SegmentLog {
  private log = new Columns();
  private gen = 1;
  /** The current path (SegmentMark.ranges / loads) and its tick-0 frame and flags. */
  private ranges: number[] = [];
  private ticks = 0;
  private loads: SegmentLoad[] = [];
  private frame0: number[] = [];
  private frame0Events = 0;
  /** The log reached MAX_LOG_TICKS: nothing more is logged and no checkpoint can be saved until it's cleared. */
  full = false;

  /** Ticks in the log (every branch). */
  get size(): number {
    return this.log.n;
  }

  /** Stitched ticks on the current path. */
  get length(): number {
    return this.ticks;
  }

  /** Checkpoint loads on the current path. */
  get loadCount(): number {
    return this.loads.length;
  }

  /** Drops the whole log: earlier marks can't be rebuilt any more (stale). */
  clear(): void {
    this.log = new Columns();
    this.gen++;
    this.full = false;
    this.begin([], 0);
  }

  /** A new recording (a core reset): an empty path from `frame0` (the reset state's live frame). */
  begin(frame0: ArrayLike<number>, frame0Events: number): void {
    this.ranges = [];
    this.ticks = 0;
    this.loads = [];
    this.frame0 = Array.from(frame0);
    this.frame0Events = frame0Events;
  }

  /** Appends a recorded tick to the log and the current path. */
  push(t: LoggedTick): void {
    const L = this.log;
    if (this.full || L.n >= MAX_LOG_TICKS) {
      this.full = true;
      return;
    }
    if (L.n === L.forward.length) L.grow();
    const i = L.n++;
    L.forward[i] = t.forward;
    L.side[i] = t.side;
    L.buttons[i] = t.buttons;
    L.yaw[i] = t.yaw;
    L.pitch[i] = t.pitch;
    L.looks[i] = t.look;
    L.frames.set(Array.from({ length: STRIDE }, (_, k) => t.frame[k] ?? 0), i * STRIDE);
    L.frameEvents[i] = t.frameEvents;
    const r = this.ranges;
    if (r.length && r[r.length - 1] === i) r[r.length - 1] = i + 1;
    else r.push(i, i + 1);
    this.ticks++;
  }

  /** A replay checkpoint (position / velocity after the last logged tick). */
  checkpoint(position: readonly number[], velocity: readonly number[]): void {
    if (this.full || !this.log.n) return;
    this.log.cps.set(this.log.n - 1, { position: [position[0], position[1], position[2]], velocity: [velocity[0], velocity[1], velocity[2]] });
  }

  /** A cosmetic (trailer "BHCX") or inspect ("BHCI") event after the current path's last tick. */
  event(kind: number, inspect = false): void {
    if (this.full) return;
    const at = this.ticks ? this.ranges[this.ranges.length - 1] - 1 : -1;
    const m = inspect ? this.log.inspect : this.log.cosmetic;
    const list = m.get(at);
    if (list) list.push(kind & 0xff);
    else m.set(at, [kind & 0xff]);
  }

  /** The current path as a checkpoint mark, or null when the log is full. `flags`: the recorder's header flags now. */
  mark(flags: { nullBinds: boolean; timedInput: boolean; wRelease?: boolean; turnSpeed: TurnSpeed | null }): SegmentMark | null {
    if (this.full) return null;
    return {
      gen: this.gen, ranges: [...this.ranges], ticks: this.ticks, loads: this.loads.map(copyLoad),
      frame0: [...this.frame0], frame0Events: this.frame0Events,
      nullBinds: flags.nullBinds, timedInput: flags.timedInput, wRelease: !!flags.wRelease, turnSpeed: flags.turnSpeed ? { ...flags.turnSpeed } : null,
    };
  }

  /** The mark belongs to this log (it wasn't cleared since). */
  usable(m: SegmentMark): boolean {
    return m.gen === this.gen && !this.full;
  }

  /**
   * A checkpoint load: the current path becomes `m`'s plus the load (the state the core was restored to, after
   * m.ticks commands), and `rec` and the live frames are rebuilt as that path recorded them. False if `m` is stale.
   */
  load(m: SegmentMark, restored: { position: readonly number[]; velocity: readonly number[] }, rec: ReplayRecorder, putFrame: (tick: number, frame: ArrayLike<number>, events: number) => void): boolean {
    if (!this.usable(m)) return false;
    this.ranges = [...m.ranges];
    this.ticks = m.ticks;
    this.loads = [...m.loads.map(copyLoad), { tick: m.ticks, position: f3(restored.position), velocity: f3(restored.velocity) }];
    this.frame0 = [...m.frame0];
    this.frame0Events = m.frame0Events;
    const L = this.log;
    rec.clear();
    rec.turnSpeed = m.turnSpeed ? { ...m.turnSpeed } : null;
    rec.nullBinds = m.nullBinds;
    rec.timedInput = m.timedInput;
    rec.wRelease = !!m.wRelease;
    const checkpoints: Checkpoint[] = [];
    const cosmetic: CosmeticEvent[] = [];
    const inspect: CosmeticEvent[] = [];
    const events = (map: Map<number, number[]>, at: number, tick: number, out: CosmeticEvent[]) => {
      for (const kind of map.get(at) ?? []) out.push({ tick, kind });
    };
    events(L.cosmetic, -1, 0, cosmetic);
    events(L.inspect, -1, 0, inspect);
    putFrame(0, this.frame0, this.frame0Events);
    let tick = 0;
    for (let r = 0; r < this.ranges.length; r += 2) {
      for (let i = this.ranges[r]; i < this.ranges[r + 1]; i++) {
        rec.push(L.forward[i], L.side[i], L.yaw[i], L.pitch[i], L.buttons[i], L.looks[i] ?? null);
        tick++;
        const cp = L.cps.get(i);
        if (cp) checkpoints.push({ tick, position: [...cp.position], velocity: [...cp.velocity] });
        events(L.cosmetic, i, tick, cosmetic);
        events(L.inspect, i, tick, inspect);
        putFrame(tick, L.frames.subarray(i * STRIDE, (i + 1) * STRIDE), L.frameEvents[i]);
      }
    }
    rec.checkpoints = checkpoints;
    rec.cosmetic = cosmetic;
    rec.inspect = inspect;
    rec.segments = this.loads.map(copyLoad);
    return true;
  }
}

const f3 = (v: readonly number[]): [number, number, number] => [Math.fround(v[0]), Math.fround(v[1]), Math.fround(v[2])];
const copyLoad = (l: SegmentLoad): SegmentLoad => ({ tick: l.tick, position: [...l.position], velocity: [...l.velocity] });
