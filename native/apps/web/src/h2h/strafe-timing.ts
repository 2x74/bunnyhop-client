// Strafe timing for head to head (/h2h): when each A/D switch lands against the mouse changing direction. A coaching
// stat: switching the key a tick or two before the mouse turns the other way keeps the gain going through the turn.
// DOM-free, tested under bun (apps/web/test/h2h.test.ts) and against the server's own measure
// (apps/api/test/h2h-strafe-timing.test.ts), so the numbers players see agree with what the server stores.
//
// The pairing is the server's (apps/api src/input-analysis.ts, sync offsets), over the timed run's air ticks:
//   - a mouse reversal: the tick the view starts turning the other way (yaw change changes sign; still ticks skipped);
//   - a key switch: the tick the new strafe key went down (with both keys held for a few ticks, the first of them);
//   - each switch is paired with the nearest reversal toward the same side within PAIR_WINDOW ticks. The offset is
//     key tick minus mouse tick: negative, the key went first.
// Turn binds aren't taken out of the mouse turn here (the server does): runs that use them read a little differently.

/** Source IN_* bits (input.ts). */
const IN_FORWARD = 1 << 3;
const IN_BACK = 1 << 4;
const IN_MOVELEFT = 1 << 9;
const IN_MOVERIGHT = 1 << 10;

/** Ticks either side of a key switch searched for its mouse reversal (input-analysis.ts PAIR_WINDOW). */
export const PAIR_WINDOW = 20;

/** Styles whose strafes are A/D switches (input-analysis.ts strafeFamily "ad" / "hsw" / "bw"). Sideways and W-Only aren't. */
export type StrafeKeys = "ad" | "hsw" | "bw";

export function strafeKeysOf(style: string): StrafeKeys | null {
  return style === "sideways" || style === "wonly" ? null : style === "hsw" ? "hsw" : style === "backwards" ? "bw" : "ad";
}

export interface StrafeInput {
  /** Command-indexed (command i produces tick i + 1): yaw (degrees), side / forward move, buttons. */
  yaw: ArrayLike<number>;
  side: ArrayLike<number>;
  forward: ArrayLike<number>;
  buttons: ArrayLike<number>;
  /** Tick-indexed: non-zero when on the ground or a ladder after tick t. */
  ground: ArrayLike<number>;
  /** Tick-indexed: non-zero when tick t teleported or respawned the player. */
  teleport: ArrayLike<number>;
  /** Commands measured: first (>= 1) to last (exclusive), the timed run. */
  first: number;
  last: number;
  keys: StrafeKeys;
}

export interface KeySwitch {
  /** Command index the new key went down. */
  tick: number;
  /** +1: the new key turns right (D; A on Backwards), -1: left. */
  dir: 1 | -1;
  /** Ticks from the paired mouse reversal (negative: key first), null: no reversal within the window. */
  offset: number | null;
  /** The old key was still held when the new one went down. */
  overlap: boolean;
}

export interface MouseReversal {
  /** Command index the view starts turning the new way. */
  tick: number;
  /** +1: now turning right, -1: left. */
  dir: 1 | -1;
}

export interface TimingSummary {
  /** Key switches in the air, and how many found a reversal. */
  switches: number;
  paired: number;
  /** Shares of the paired switches: key before the mouse, on the same tick, after. */
  before: number;
  same: number;
  after: number;
  /** Mean offset and its spread (ticks). */
  mean: number;
  sd: number;
  /** Share of switches with both keys held at the press. */
  overlap: number;
}

export interface StrafeTiming {
  switches: KeySwitch[];
  reversals: MouseReversal[];
  summary: TimingSummary;
}

function wrap180(d: number): number {
  d %= 360;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return d;
}

/** The strafe key held by a command's side move: +1 right (D), -1 left (A), 0 none or both. */
function switchKey(keys: StrafeKeys, s: number): number {
  const k = s > 0 ? 1 : s < 0 ? -1 : 0;
  return keys === "bw" ? -k : k; // facing back, D turns left
}

/** The button bit of a switch key. */
function keyBit(keys: StrafeKeys, key: number): number {
  if (keys === "bw") return key > 0 ? IN_MOVELEFT : IN_MOVERIGHT;
  return key > 0 ? IN_MOVERIGHT : IN_MOVELEFT;
}

/** The mouse turn per command (degrees, + = left), as the strip draws it. 0 before the first command. */
export function mouseTurns(yaw: ArrayLike<number>, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 1; i < n; i++) out[i] = wrap180(yaw[i] - yaw[i - 1]);
  return out;
}

/** Key switches, mouse reversals and their pairing over the run's air ticks (see the header). */
export function strafeTiming(o: StrafeInput): StrafeTiming {
  const { yaw, side, buttons, ground, teleport, keys } = o;
  const switches: KeySwitch[] = [];
  const reversals: MouseReversal[] = [];
  let lastKey = 0;
  let lastTurn = 0;
  for (let i = o.first; i < o.last; i++) {
    const air = !ground[i] && !ground[i + 1] && !teleport[i + 1];
    const key = switchKey(keys, side[i]);
    if (!air) {
      if (key) lastKey = key;
      continue;
    }
    const d = i > 0 ? wrap180(yaw[i] - yaw[i - 1]) : 0;
    if (d !== 0) {
      const t = d > 0 ? -1 : 1;
      if (t !== lastTurn) {
        if (lastTurn !== 0) reversals.push({ tick: i, dir: t });
        lastTurn = t;
      }
    }
    if (key && key !== lastKey) {
      if (lastKey !== 0) {
        const bit = keyBit(keys, key);
        let p = i;
        const floor = Math.max(1, i - PAIR_WINDOW);
        while (p - 1 >= floor && buttons[p - 1] & bit) p--;
        switches.push({ tick: p, dir: key > 0 ? 1 : -1, offset: null, overlap: (buttons[p] & keyBit(keys, lastKey)) !== 0 });
      }
      lastKey = key;
    }
  }
  // Pair each switch with the nearest reversal to the same side (ties: the earlier reversal, as the server's scan).
  let m0 = 0;
  for (const s of switches) {
    while (m0 < reversals.length && reversals[m0].tick < s.tick - PAIR_WINDOW) m0++;
    let best: number | null = null;
    for (let j = m0; j < reversals.length && reversals[j].tick <= s.tick + PAIR_WINDOW; j++) {
      if (reversals[j].dir !== s.dir) continue;
      const off = s.tick - reversals[j].tick;
      if (best === null || Math.abs(off) < Math.abs(best)) best = off;
    }
    s.offset = best;
  }
  return { switches, reversals, summary: summarize(switches) };
}

export function summarize(switches: readonly KeySwitch[]): TimingSummary {
  const offs = switches.map((s) => s.offset).filter((o): o is number => o !== null);
  const n = offs.length;
  const mean = n ? offs.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n ? Math.sqrt(offs.reduce((a, b) => a + (b - mean) ** 2, 0) / n) : 0;
  return {
    switches: switches.length,
    paired: n,
    before: n ? offs.filter((o) => o < 0).length / n : 0,
    same: n ? offs.filter((o) => o === 0).length / n : 0,
    after: n ? offs.filter((o) => o > 0).length / n : 0,
    mean,
    sd,
    overlap: switches.length ? switches.filter((s) => s.overlap).length / switches.length : 0,
  };
}

/** RunData bits (viewer/player.ts). */
const F_GROUNDED = 2;
const F_TELEPORTED = 4;
const F_RESTARTED = 32;
const F_LADDER = 64;

/** What strafe timing reads of a run (RunData fits): tick-indexed cached ticks, commands at the tick they produced. */
export interface RunTicks {
  n: number;
  startTick: number;
  endTick: number;
  view: Float32Array;
  side: Int16Array;
  forward: Int16Array;
  buttons: Uint16Array;
  flags: Uint8Array;
}

/** The input of strafeTiming from a viewer run (RunData: row t holds the command that produced tick t). */
export function runStrafeInput(d: RunTicks, keys: StrafeKeys): StrafeInput {
  const n = d.n;
  const yaw = new Float32Array(n);
  const side = new Int16Array(n);
  const forward = new Int16Array(n);
  const buttons = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    yaw[i] = d.view[(i + 1) * 2];
    side[i] = d.side[i + 1];
    forward[i] = d.forward[i + 1];
    buttons[i] = d.buttons[i + 1];
  }
  const ground = new Uint8Array(n + 1);
  const teleport = new Uint8Array(n + 1);
  for (let t = 0; t <= n; t++) {
    ground[t] = d.flags[t] & (F_GROUNDED | F_LADDER) ? 1 : 0;
    teleport[t] = d.flags[t] & (F_TELEPORTED | F_RESTARTED) ? 1 : 0;
  }
  return { yaw, side, forward, buttons, ground, teleport, first: Math.max(1, d.startTick), last: Math.min(n, d.endTick > 0 ? d.endTick : n), keys };
}
