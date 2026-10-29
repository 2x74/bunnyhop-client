// Golden vectors for native timed input (apps/native/src/timed_input_parity_tests.cpp).
//
// Runs scripted mouse/key streams and frame schedules through the web's TimedInput (bunnyhop
// apps/web/src/timed-input.ts, imported by path) and records what every tick takes. The C++ test feeds the same
// streams through InputTimeline and must match exactly.
//
// Usage: bun tools/timed-input/generate-vectors.ts --web /path/to/bunnyhop/apps/web/src/timed-input.ts
//
// The adapter here plays the native client's part around the web class:
// - stamps use the native rule (TimedInput::stamp): a stamp older than 250 ms moves to now - 250 ms instead of now,
//   and one older than the queue's newest counts as received now;
// - the frame loop accumulates integer nanoseconds with the 250 ms cap, and each tick's boundary is its end;
// - an edge is queued only when the key's held state changes, as the client's key handler does.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const MS = 1_000_000;
const TICK_NS = 10 * MS;
const MAX_FRAME_NS = 250 * MS;
const MAX_AGE_NS = 250 * MS;
const FUTURE_SLACK_NS = 1 * MS;
const START_NS = 1000 * MS;
const DEGREES_PER_COUNT = 0.022;
const SENSITIVITY = 2;
const KEY_BITS: Record<string, number> = {
  KeyW: 1 << 3,
  KeyS: 1 << 4,
  KeyA: 1 << 9,
  KeyD: 1 << 10,
  Space: 1 << 1,
  ControlLeft: 1 << 2,
};

type MotionEvent = { kind: "motion"; t: number; arrival: number; x: number; y: number };
type KeyEvent = { kind: "key"; t: number; arrival: number; code: string; down: boolean };
type ScriptedEvent = MotionEvent | KeyEvent;
type Tick = { boundary: number; counts: number; pitch: number; held: number; reports: number };
type Scenario = {
  name: string;
  holdbackMs: number;
  holdbackMaxMs: number;
  events: ScriptedEvent[];
  frames: number[];
};

interface WebTimedInput {
  holdbackMs: number;
  unreliable: boolean;
  late: number;
  readonly keys: Set<string>;
  addMotion(t: number, x: number, p: number, ev: number): void;
  addEdge(t: number, code: string, down: boolean): void;
  take(at: number | undefined, onMotion: (x: number, p: number) => void): { events: number; reports: number };
}

const options = { web: { type: "string" }, out: { type: "string" } } as const;
const { values } = parseArgs({ args: Bun.argv.slice(2), options });
if (!values.web) {
  throw new Error("Pass --web /path/to/bunnyhop/apps/web/src/timed-input.ts");
}
const webPath = resolve(values.web);
const webModule = (await import(webPath)) as { TimedInput: new () => WebTimedInput; HOLDBACK_MAX: number };
const outPath = resolve(values.out ?? resolve(import.meta.dir, "../../apps/native/src/timed_input_vectors.json"));

function nativeStamp(t: number, now: number, tail: number, unreliable: boolean): number {
  if (unreliable || t <= 0 || t > now + FUTURE_SLACK_NS) {
    return now;
  }
  const clamped = Math.max(Math.min(t, now), now - MAX_AGE_NS);
  return clamped < tail ? now : clamped;
}

function clampPitch(pitch: number): number {
  return Math.max(-89, Math.min(89, pitch));
}

function heldBits(keys: Set<string>): number {
  let bits = 0;
  for (const code of keys) {
    bits |= KEY_BITS[code] ?? 0;
  }
  return bits;
}

// Native times still queued, to give the native stamp rule its tail and to catch cutoff ties.
class QueuedTimes {
  private times: number[] = [];

  tail(): number {
    return this.times.length ? this.times[this.times.length - 1] : 0;
  }

  push(t: number): void {
    this.times.push(t);
  }

  takeUntil(cut: number): void {
    this.times = this.times.filter((t) => t > cut);
  }

  has(t: number): boolean {
    return this.times.includes(t);
  }
}

class Runner {
  private readonly timed = new webModule.TimedInput();
  private readonly heldCodes = new Set<string>();
  private readonly motion = new QueuedTimes();
  private readonly edges = new QueuedTimes();
  private readonly ticks: Tick[] = [];
  private accumulator = 0;
  private lastFrame = START_NS;
  private lastCut = Number.NEGATIVE_INFINITY;
  private pitch = 0;
  private serial = 0;

  constructor(private readonly scenario: Scenario) {
    this.timed.holdbackMs = scenario.holdbackMs;
  }

  run() {
    const events = deliveryOrder(this.scenario.events);
    let next = 0;
    for (const now of this.scenario.frames) {
      while (next < events.length && events[next].arrival <= now) {
        this.deliver(events[next++]);
      }
      this.frame(now);
    }
    return {
      ticks: this.ticks,
      late: this.timed.late,
      holdbackMs: this.timed.holdbackMs,
      unreliable: this.timed.unreliable,
    };
  }

  private deliver(event: ScriptedEvent): void {
    if (event.kind === "motion") {
      const t = nativeStamp(event.t, event.arrival, this.motion.tail(), this.timed.unreliable);
      this.checkTie(t, this.lastCut);
      this.timed.addMotion(t / MS, event.x, event.y * SENSITIVITY * DEGREES_PER_COUNT, this.serial++);
      this.motion.push(t);
      return;
    }
    if (event.down === this.heldCodes.has(event.code)) {
      return;
    }
    if (KEY_BITS[event.code]) {
      const t = nativeStamp(event.t, event.arrival, this.edges.tail(), this.timed.unreliable);
      this.timed.addEdge(t / MS, event.code, event.down);
      this.edges.push(t);
    }
    if (event.down) {
      this.heldCodes.add(event.code);
    } else {
      this.heldCodes.delete(event.code);
    }
  }

  private frame(now: number): void {
    this.accumulator += Math.min(now - this.lastFrame, MAX_FRAME_NS);
    this.lastFrame = now;
    let boundary = now - this.accumulator;
    while (this.accumulator >= TICK_NS) {
      boundary += TICK_NS;
      this.tick(boundary);
      this.accumulator -= TICK_NS;
    }
  }

  private tick(boundary: number): void {
    const cut = boundary - Math.round(this.timed.holdbackMs * MS);
    if (cut !== boundary && (this.motion.has(cut) || this.edges.has(cut))) {
      throw new Error(`${this.scenario.name}: a queued stamp falls exactly on a holdback cutoff`);
    }
    let counts = 0;
    const taken = this.timed.take(boundary / MS, (x, p) => {
      counts += x;
      this.pitch = clampPitch(this.pitch + p);
    });
    this.motion.takeUntil(cut);
    this.edges.takeUntil(cut);
    this.lastCut = Math.max(this.lastCut, cut);
    this.ticks.push({ boundary, counts, pitch: this.pitch, held: heldBits(this.timed.keys), reports: taken.reports });
  }

  // With a nonzero holdback the web compares milliseconds after a float subtraction and native compares integer
  // nanoseconds. They agree except on an exact tie, which the scenarios must avoid.
  private checkTie(t: number, cut: number): void {
    if (this.timed.holdbackMs && t === cut) {
      throw new Error(`${this.scenario.name}: a report is stamped exactly on the last holdback cutoff`);
    }
  }
}

// Arrival order; events that arrive together keep their script order (SDL's queue order).
function deliveryOrder(events: ScriptedEvent[]): ScriptedEvent[] {
  return [...events].sort((a, b) => a.arrival - b.arrival);
}

function frames(fps: number, durationNs: number, gaps: [number, number][] = []): number[] {
  const out: number[] = [];
  for (let k = 1; ; k++) {
    const t = START_NS + Math.round((k * 1e9) / fps);
    if (t > START_NS + durationNs) {
      break;
    }
    if (gaps.some(([from, to]) => t >= from && t < to)) {
      continue;
    }
    out.push(t);
  }
  return out;
}

// A strafe: the view sweeps back and forth while A and D alternate every 200 ms. Every |lateEvery|th report arrives
// |lateNs| after its stamp; the rest 0.2 ms after.
function strafe(hz: number, durationNs: number, offsetNs: number, lateEvery = 0, lateNs = 0): ScriptedEvent[] {
  const events: ScriptedEvent[] = [];
  const period = Math.round(1e9 / hz);
  let index = 0;
  for (let t = START_NS + period + offsetNs; t <= START_NS + durationNs; t += period, index++) {
    const sweep = Math.floor(index / (hz / 10)) % 2 === 0 ? 2 : -3;
    const arrival = lateEvery && index % lateEvery === 0 ? t + lateNs : t + 200_000;
    events.push({ kind: "motion", t, arrival, x: sweep, y: index % 9 === 0 ? 1 : 0 });
  }
  events.push(key(START_NS + 1 * MS + offsetNs, "KeyD", true));
  for (let t = START_NS + 200 * MS + offsetNs; t < START_NS + durationNs; t += 200 * MS) {
    const right = Math.round((t - START_NS) / (200 * MS)) % 2 === 0;
    events.push({ kind: "key", t, arrival: t + 300_000, code: right ? "KeyA" : "KeyD", down: false });
    events.push({ kind: "key", t, arrival: t + 300_000, code: right ? "KeyD" : "KeyA", down: true });
  }
  return events;
}

function key(t: number, code: string, down: boolean, arrival = t): KeyEvent {
  return { kind: "key", t, arrival, code, down };
}

function scenarios(): Scenario[] {
  const out: Scenario[] = [];
  const durations: Record<number, number> = { 1000: 600 * MS, 2000: 320 * MS, 8000: 120 * MS };
  for (const fps of [60, 100, 144, 240, 360, 500, 1000]) {
    for (const hz of [1000, 2000, 8000]) {
      const duration = durations[hz];
      out.push({
        name: `strafe ${fps} fps ${hz} Hz`,
        holdbackMs: 0,
        holdbackMaxMs: webModule.HOLDBACK_MAX,
        events: strafe(hz, duration, 137),
        frames: frames(fps, duration + 20 * MS),
      });
      out.push({
        name: `strafe ${fps} fps ${hz} Hz holdback 1 ms, late arrivals`,
        holdbackMs: 1,
        holdbackMaxMs: webModule.HOLDBACK_MAX,
        events: strafe(hz, duration, 137, 23, 2_500_000),
        frames: frames(fps, duration + 20 * MS),
      });
    }
  }
  // Alternating short/long frames exercise high-rate attribution across uneven pump boundaries.
  for (const hz of [2000, 4000, 8000]) {
    for (const fps of [60, 240, 1000]) {
      const duration = 600 * MS;
      const schedule: number[] = [];
      for (let index = 1, time = START_NS; time < START_NS + duration + 20 * MS; index++) {
        time += Math.round((1e9 / fps) * (index % 2 ? 0.35 : 1.65));
        schedule.push(time);
      }
      out.push({
        name: `uneven ${fps} fps ${hz} Hz`,
        holdbackMs: 1,
        holdbackMaxMs: webModule.HOLDBACK_MAX,
        events: strafe(hz, duration, 137),
        frames: schedule,
      });
    }
  }
  // A slow input pipeline: every report arrives |lateNs| after its stamp (in order, as SDL's queue keeps them). At
  // 6 ms the holdback rises until reports stop being late; at 30 ms it gives up on timestamps.
  const pipelines = [
    [6 * MS, 1, "raises the holdback"],
    [30 * MS, 7, "gives up"],
  ] as const;
  for (const [lateNs, holdbackMs, label] of pipelines) {
    out.push({
      name: `late reports ${label}`,
      holdbackMs,
      holdbackMaxMs: webModule.HOLDBACK_MAX,
      events: strafe(2000, 1600 * MS, 137, 1, lateNs),
      frames: frames(240, 1700 * MS),
    });
  }
  // Sub-tick taps (pressed and released between two boundaries) and taps on a boundary, at 100 fps where the
  // boundaries fall on whole 10 ms.
  const taps: ScriptedEvent[] = [];
  for (let i = 0; i < 20; i++) {
    const base = START_NS + (i + 1) * 20 * MS;
    taps.push(key(base + 2 * MS, "KeyW", true), key(base + 5 * MS, "KeyW", false));
    taps.push(key(base + 10 * MS, "KeyS", true), key(base + 12 * MS, "KeyS", false));
    taps.push(key(base + 9 * MS, "Space", true), key(base + 10 * MS, "Space", false));
    taps.push({ kind: "motion", t: base + 10 * MS, arrival: base + 10 * MS, x: 1, y: -1 });
  }
  for (const fps of [100, 144, 240]) {
    out.push({
      name: `taps ${fps} fps`,
      holdbackMs: 0,
      holdbackMaxMs: webModule.HOLDBACK_MAX,
      events: taps,
      frames: frames(fps, 450 * MS),
    });
  }
  // Stalls: 120 ms (under the cap) and 1 s (capped), reports and keys made during them arrive when they end.
  for (const [fps, stallMs] of [
    [144, 120],
    [60, 1000],
    [240, 1000],
  ]) {
    const stallFrom = START_NS + 300 * MS;
    const stallTo = stallFrom + stallMs * MS;
    const events: ScriptedEvent[] = [];
    for (let t = START_NS + 1 * MS; t <= stallTo + 300 * MS; t += 1 * MS) {
      const arrival = t > stallFrom && t < stallTo ? stallTo : t;
      events.push({ kind: "motion", t, arrival, x: 1, y: 0 });
    }
    events.push(key(START_NS + 50 * MS, "KeyD", true));
    events.push(key(stallFrom + 40 * MS, "KeyD", false, stallTo), key(stallFrom + 40 * MS, "KeyA", true, stallTo));
    events.push(key(stallFrom + 60 * MS, "KeyW", true, stallTo), key(stallFrom + 65 * MS, "KeyW", false, stallTo));
    const schedule = [...frames(fps, stallTo - START_NS + 300 * MS, [[stallFrom, stallTo]]), stallTo];
    schedule.sort((a, b) => a - b);
    out.push({
      name: `stall ${stallMs} ms at ${fps} fps`,
      holdbackMs: 0,
      holdbackMaxMs: webModule.HOLDBACK_MAX,
      events,
      frames: schedule,
    });
  }
  // Fractional (trackpad) reports and pitch reversals against the clamp.
  const fractional: ScriptedEvent[] = [];
  for (let i = 1; i <= 600; i++) {
    const t = START_NS + i * 500_000;
    fractional.push({ kind: "motion", t, arrival: t, x: i % 4 === 0 ? -0.125 : 0.375, y: i < 300 ? 40 : -55.5 });
  }
  out.push({
    name: "fractional and pitch clamp 144 fps",
    holdbackMs: 0,
    holdbackMaxMs: webModule.HOLDBACK_MAX,
    events: fractional,
    frames: frames(144, 320 * MS),
  });
  return out;
}

// Delivery order. Motion: ["m", stamp, arrival, x, y]. Key: ["k", stamp, arrival, code, down].
// Times are nanoseconds after startNs.
function encodeEvent(event: ScriptedEvent): (string | number | boolean)[] {
  const t = event.t - START_NS;
  const arrival = event.arrival - START_NS;
  if (event.kind === "motion") {
    return ["m", t, arrival, event.x, event.y];
  }
  return ["k", t, arrival, event.code, event.down];
}

const source = readFileSync(webPath);
const vectors = {
  generator: "native/tools/timed-input/generate-vectors.ts",
  startNs: START_NS,
  // Ticks: [boundary, counts, pitch after the tick, held buttons, reports taken].
  web: { file: "apps/web/src/timed-input.ts", sha256: createHash("sha256").update(source).digest("hex") },
  scenarios: scenarios().map((scenario) => {
    const result = new Runner(scenario).run();
    return {
      name: scenario.name,
      holdbackMs: scenario.holdbackMs,
      holdbackMaxMs: scenario.holdbackMaxMs,
      frames: scenario.frames.map((t) => t - START_NS),
      events: deliveryOrder(scenario.events).map(encodeEvent),
      ticks: result.ticks.map((t) => [t.boundary - START_NS, t.counts, t.pitch, t.held, t.reports]),
      late: result.late,
      finalHoldbackMs: result.holdbackMs,
      unreliable: result.unreliable,
    };
  }),
};
writeFileSync(outPath, JSON.stringify(vectors) + "\n");
const tickCount = vectors.scenarios.reduce((n, scenario) => n + scenario.ticks.length, 0);
console.log(`${vectors.scenarios.length} scenarios, ${tickCount} ticks -> ${outPath}`);
