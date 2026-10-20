// Inspect combo state machine (CS2-style "spam F for tricks"). DOM-free and dependency-free: the viewmodel, the
// third-person gesture layer (other players, replays, ghosts) and the unit tests (apps/api/test/inspect-combo.test.ts)
// all run this same code.
//
// Grammar (per knife: a chain of tricks, ComboSpec):
//   tap F (idle)                 -> trick 0 (the base inspect) from the start
//   tap F during a trick         -> queues the next trick in the chain. The press counts once the trick's window is
//                                   open (t >= open); an earlier press is buffered until then. One trick can be queued.
//                                   The queued trick takes over at the current trick's `exit` (the moment it would
//                                   start settling back to idle), entering at its own `enter` (skipping its intro), with
//                                   a short crossfade. A press during the settle (t >= exit) switches right away.
//   tap F on the last trick      -> ignored (the cap: the chain ends with the last trick's settle, a graceful finish)
//   hold F                       -> a trick with a `loop` segment keeps looping it (Skeleton style) while the key is
//                                   down, up to `maxLoops` wraps; then (or on release) it plays on to its settle
//   attack (Mouse1 / Mouse2)     -> cancel: the inspect blends out over CANCEL_BLEND (snappy, like CS) into the attack
//   draw (spawn / restart)       -> cancel at once
//   moving / jumping             -> nothing (inspects play on)
//
// Times are seconds on the caller's clock (update(dt) advances it). Events come back from update() / press() in order.

export type CueType = "flip" | "catch" | "spin";

export interface Cue {
  /** Time into the trick (s). */
  t: number;
  type: CueType;
}

export interface TrickSpec {
  /** Stable id (sounds, logs, dev flags). */
  id: string;
  /** Length (s). The pose at t = len is the idle pose again. */
  len: number;
  /** The trick reaches the shared "presented" pose here (a chained trick starts at this time). */
  enter: number;
  /** The trick leaves the presented pose for the settle here (a queued trick takes over at this time). */
  exit: number;
  /** Re-presses from this time on queue the next trick (earlier ones are buffered until it opens). */
  open: number;
  /** Hold-to-loop segment [from, to]: while the key is held, t wraps from `to` back to `from`. */
  loop?: [number, number];
  /** Sound / event cues (flip, catch, spin) at times into the trick; cues inside the loop fire on every pass. */
  cues?: Cue[];
}

export interface ComboSpec {
  tricks: TrickSpec[];
  /** Hold-loop cap (wraps per trick). Default MAX_LOOPS. */
  maxLoops?: number;
}

/** Blend times (s). */
export const CANCEL_BLEND = 0.065;
export const CHAIN_BLEND = 0.14;
/** Default hold-loop cap. */
export const MAX_LOOPS = 6;

export type ComboEvent =
  | { type: "start"; trick: number }
  | { type: "trick"; trick: number }
  | { type: "loop"; trick: number; loops: number }
  | { type: "cue"; trick: number; cue: CueType }
  | { type: "cancel"; reason: "attack" | "draw" }
  | { type: "end" };

export interface ComboSlot {
  trick: number;
  t: number;
}

/** What to pose this frame. */
export interface ComboPose {
  /** The trick playing (null: no inspect). */
  cur: ComboSlot | null;
  /** The trick being crossfaded out (chain switch), or null. */
  prev: ComboSlot | null;
  /** Weight of `cur` against `prev` (1 when there is no prev). */
  mix: number;
  /** Weight of the inspect against the base (idle / attack) pose: 1 while playing, falls to 0 on a cancel. */
  weight: number;
}

/**
 * Network / replay signal (2 bits on room samples, see net/protocol.ts SF_INSPECT_*): what the sender's combo did.
 * START / NEXT are events (the sample's period saw the base trick start / the next trick take over); HELD is a level
 * (the inspect key is held during an inspect). Receivers drive a puppet combo with them (InspectCombo.remote).
 */
export const SIG_NONE = 0;
export const SIG_START = 1;
export const SIG_NEXT = 2;
export const SIG_HELD = 3;

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export class InspectCombo {
  private cur: ComboSlot | null = null;
  private prev: ComboSlot | null = null;
  private prevT = 0;
  private fade = 0;
  private fadeLen = 0;
  /** A press waiting for the window to open. */
  private buffered = false;
  /** The next trick is queued. */
  private queued = false;
  private loops = 0;
  private held = false;
  private out: ComboEvent[] = [];

  constructor(public spec: ComboSpec) {}

  /** Swaps the chain (knife change). Cancels anything playing. */
  setSpec(spec: ComboSpec): void {
    if (spec === this.spec) return;
    this.spec = spec;
    this.reset();
  }

  get active(): boolean {
    return this.cur !== null && this.fadeLen === 0;
  }

  /** Index of the trick playing (-1 none), for HUD / tests. */
  get trick(): number {
    return this.active ? this.cur!.trick : -1;
  }

  /** Time into the playing trick (-1 none). */
  get time(): number {
    return this.active ? this.cur!.t : -1;
  }

  get isQueued(): boolean {
    return this.queued;
  }

  get loopCount(): number {
    return this.loops;
  }

  /** Inspect key pressed. Returns the events it caused (a start); a queued trick reports when it takes over. */
  press(): ComboEvent[] {
    const out: ComboEvent[] = [];
    const tricks = this.spec.tricks;
    if (!tricks.length) return out;
    if (!this.active) {
      this.begin(0, 0);
      out.push({ type: "start", trick: 0 });
      return out;
    }
    const c = this.cur!;
    if (c.trick + 1 >= tricks.length || this.queued) return out; // the cap / already queued
    const spec = tricks[c.trick];
    if (c.t >= spec.exit) {
      this.advance(out);
    } else if (c.t >= spec.open) this.queued = true;
    else this.buffered = true;
    return out;
  }

  /** Attack or draw: blends out (attack: CANCEL_BLEND) or stops at once (draw). */
  cancel(reason: "attack" | "draw"): ComboEvent[] {
    const out: ComboEvent[] = [];
    if (!this.cur) return out;
    const wasActive = this.active;
    this.buffered = this.queued = false;
    if (reason === "draw") {
      this.cur = this.prev = null;
      this.fadeLen = 0;
    } else if (wasActive) {
      // Freeze the pose and fade it out (prev crossfade is dropped: the frozen mix stays as it was).
      this.fadeLen = CANCEL_BLEND;
      this.fade = 0;
    }
    if (wasActive) out.push({ type: "cancel", reason });
    return out;
  }

  /** Dev / screenshots / tests: shows trick `trick` at time t (no events; update(0) keeps it there). */
  seek(trick: number, t: number): void {
    this.reset();
    if (trick < 0 || trick >= this.spec.tricks.length) return;
    this.cur = { trick, t: Math.max(0, Math.min(t, this.spec.tricks[trick].len - 1e-6)) };
  }

  /** Forgets everything (seek, knife change). No events. */
  reset(): void {
    this.cur = this.prev = null;
    this.fadeLen = 0;
    this.buffered = this.queued = false;
    this.loops = 0;
  }

  /**
   * Puppet input for other players / replays (signals from the sender's combo): START restarts the base trick,
   * NEXT switches to the next trick now (the sender switched at this moment).
   */
  remote(sig: number): ComboEvent[] {
    const out: ComboEvent[] = [];
    if (sig === SIG_START) {
      this.begin(0, 0);
      out.push({ type: "start", trick: 0 });
    } else if (sig === SIG_NEXT) {
      if (this.active) {
        if (this.cur!.trick + 1 < this.spec.tricks.length) this.advance(out);
      } else if (this.spec.tricks.length > 1) {
        // Joined mid-chain (or missed the start): pick the chain up at the second trick.
        this.begin(1, this.spec.tricks[1].enter);
        out.push({ type: "trick", trick: 1 });
      }
    }
    return out;
  }

  /** Advances by dt with the inspect key's held state. Returns the events (cues, loops, chained tricks, the end). */
  update(dt: number, held: boolean): ComboEvent[] {
    const out = this.out;
    out.length = 0;
    this.held = held;
    if (!this.cur) return out;
    if (this.fadeLen > 0) {
      this.fade += dt;
      if (this.fade >= this.fadeLen) {
        this.cur = this.prev = null;
        this.fadeLen = 0;
      }
      return out;
    }
    if (this.prev) {
      this.prevT += dt;
      this.prev.t = Math.min(this.prev.t + dt, this.spec.tricks[this.prev.trick].len);
      if (this.prevT >= CHAIN_BLEND) this.prev = null;
    }
    const tricks = this.spec.tricks;
    let c = this.cur;
    let spec = tricks[c.trick];
    const t0 = c.t;
    let t1 = t0 + dt;
    if (this.buffered && t1 >= spec.open) {
      this.buffered = false;
      if (c.trick + 1 < tricks.length) this.queued = true;
    }
    // Hold-to-loop.
    const loop = spec.loop;
    const max = this.spec.maxLoops ?? MAX_LOOPS;
    if (loop && held && !this.queued && this.loops < max && t0 <= loop[1] && t1 > loop[1]) {
      this.cues(c.trick, t0, loop[1], out);
      t1 = loop[0] + (t1 - loop[1]);
      this.loops++;
      out.push({ type: "loop", trick: c.trick, loops: this.loops });
      this.cues(c.trick, loop[0], t1, out, true);
      c.t = t1;
      return out;
    }
    // Queued trick takes over at exit.
    if (this.queued && t1 >= spec.exit) {
      this.cues(c.trick, t0, spec.exit, out);
      c.t = spec.exit;
      // Carry the remainder of dt into the new trick.
      const rest = t1 - spec.exit;
      this.advance(out);
      c = this.cur!;
      spec = tricks[c.trick];
      if (rest > 0) {
        const a = c.t;
        c.t = Math.min(spec.len, c.t + rest);
        this.cues(c.trick, a, c.t, out);
      }
      return out;
    }
    this.cues(c.trick, t0, t1, out);
    if (t1 >= spec.len) {
      this.cur = this.prev = null;
      this.buffered = this.queued = false;
      out.push({ type: "end" });
      return out;
    }
    c.t = t1;
    return out;
  }

  /** The pose to show (see ComboPose). */
  pose(out: ComboPose = { cur: null, prev: null, mix: 1, weight: 0 }): ComboPose {
    out.cur = this.cur;
    out.prev = this.fadeLen > 0 ? null : this.prev;
    out.mix = out.prev ? smooth(this.prevT / CHAIN_BLEND) : 1;
    out.weight = !this.cur ? 0 : this.fadeLen > 0 ? 1 - smooth(this.fade / this.fadeLen) : 1;
    return out;
  }

  /** Whether the key is being held during an inspect (the network HELD level). */
  get holding(): boolean {
    return this.held && this.active;
  }

  private begin(trick: number, t: number): void {
    // Restarting over a fading / playing inspect crossfades from it.
    if (this.cur) {
      this.prev = { trick: this.cur.trick, t: this.cur.t };
      this.prevT = 0;
    } else this.prev = null;
    this.cur = { trick, t };
    this.fadeLen = 0;
    this.buffered = this.queued = false;
    this.loops = 0;
  }

  private advance(out: ComboEvent[]): void {
    const c = this.cur!;
    const next = c.trick + 1;
    this.begin(next, this.spec.tricks[next].enter);
    out.push({ type: "trick", trick: next });
  }

  private cues(trick: number, a: number, b: number, out: ComboEvent[], inclusiveStart = false): void {
    const cues = this.spec.tricks[trick].cues;
    if (!cues) return;
    for (const q of cues) if ((inclusiveStart ? q.t >= a : q.t > a) && q.t <= b) out.push({ type: "cue", trick, cue: q.type });
  }
}
