// Timestamped input (Settings → Mouse & view → Timestamped input; replay header timedInput). DOM-free, unit-tested in
// apps/api/test/timed-input.test.ts.
//
// WHY. The browser hands mouse motion over once per frame (pointermove is rAF-aligned), and before this every tick the
// frame ran took the view as of that frame: at 144 Hz a tick's yaw came from up to 7 ms after its boundary, at 60 Hz two
// ticks shared one view (one turned twice, the next not at all). CS:S builds each usercmd from the mouse reports that
// arrived before it, and players run it at 300-1000 fps, so its per-tick yaw is close to the hand's. Gain is very
// sensitive to that error at speed (600 u/s: 1 ms of a 286°/s strafe turn is 0.3°, about 10% of that tick's gain), so
// web gain and SSJ read lower than CS:S for the same strafes, and lower the lower the frame rate.
//
// HOW. Every accepted mouse report keeps its own time (the coalesced reports' timestamps, the spike filter's verdict
// per report). The camera shows all motion at once, as before. Each command takes only the motion stamped at or before
// its tick's boundary minus the holdback (main.ts frame(): boundary = frame time - what's left in the accumulator), and
// the movement keys' presses and releases the same way, so a strafe switch lands on the tick it was made in. The tick
// schedule, the commands' format and the counted yaw grid are unchanged; only which tick a report counts in changes.
//
// HOLDBACK. A report reaches the page a little after its timestamp (the OS and the browser's input pipeline). One
// stamped just before a boundary can arrive after that tick ran: it then counts in the next tick, a one-tick error for
// that report. The holdback makes each tick wait that long in command time (the camera doesn't wait), adapted from the
// share of reports that arrive late: up while more than LATE_HIGH of them do, down slowly while hardly any do.
//
// CLOCKS (prod diagnostics 10-26..10-28). Chromium stamps events on the page clock, about 1-2 ms before they reach
// the page. 8% of Firefox runs had event times that aren't on it at all (input age up to 10^6 ms), and Safari's run
// ~24 ms behind. A time more than MAX_AGE_MS old (or in the future) counts as received now, never as late. If reports
// still arrive late at the largest holdback (STUCK_WINDOWS windows over GIVE_UP_SHARE), the stamps are no use here:
// the session goes back to arrival times, i.e. each command takes what had arrived, as before timed input.

/** Movement direction bits (input.ts IN_FORWARD | IN_BACK | IN_MOVELEFT | IN_MOVERIGHT): timed like the mouse. */
export const TIMED_KEY_BITS = (1 << 3) | (1 << 4) | (1 << 9) | (1 << 10);
/** Holdback at the start of a session (ms). */
export const HOLDBACK_START = 2;
export const HOLDBACK_MAX = 8;
/** Reports per adaptation window. */
const WINDOW = 400;
/** Late share over a window that raises the holdback, and the share under which LOWER_AFTER calm windows lower it. */
const LATE_HIGH = 0.01;
const LATE_LOW = 0.001;
const LOWER_AFTER = 4;
const RAISE_MS = 0.5;
const LOWER_MS = 0.25;
/** A timestamp older than this (ms before it was received) is treated as received now: a clock that isn't the page's. */
const MAX_AGE_MS = 250;
/** Late share at HOLDBACK_MAX, over this many windows in a row, that gives timed input up for the session. */
const GIVE_UP_SHARE = 0.05;
const STUCK_WINDOWS = 3;

interface Motion {
  t: number;
  /** Yaw counts and pitch degrees. */
  x: number;
  p: number;
  /** Motion event serial (several reports share one). */
  ev: number;
}
interface Edge {
  t: number;
  code: string;
  down: boolean;
}

export interface Taken {
  /** Motion events (distinct) and reports this command took. */
  events: number;
  reports: number;
}

/** Sorted insert from the back (reports arrive in order nearly always). */
function insert<T extends { t: number }>(q: T[], head: number, v: T): void {
  let i = q.length;
  while (i > head && q[i - 1].t > v.t) i--;
  if (i === q.length) q.push(v);
  else q.splice(i, 0, v);
}

export class TimedInput {
  /** Current holdback (ms). */
  holdbackMs = HOLDBACK_START;
  /** Motion received but not yet in a command: what the camera shows beyond the last command (counts / degrees). */
  pendingX = 0;
  pendingP = 0;
  /** Movement-key codes held as of the last command, in press order (null binds keep the newest). */
  readonly keys = new Set<string>();
  /** Diagnostics: reports received and how many arrived after their tick had run, since the session began. */
  reports = 0;
  late = 0;
  private motion: Motion[] = [];
  private head = 0;
  private edges: Edge[] = [];
  private edgeHead = 0;
  /** The newest command cutoff (a report stamped at or before it is late). */
  private cut = -Infinity;
  private winSeen = 0;
  private winLate = 0;
  private calm = 0;

  /** The browser's event times are no use (see CLOCKS): every report counts as received now. */
  unreliable = false;
  private stuck = 0;

  /** `t` as a usable report time on the performance.now() clock it was received at (`now`). */
  stamp(t: number, now: number): number {
    if (this.unreliable) return now;
    return Number.isFinite(t) && t > 0 && t <= now + 1 && now - t <= MAX_AGE_MS ? Math.min(t, now) : now;
  }

  get pending(): number {
    return this.motion.length - this.head;
  }

  /** One accepted mouse report: `x` yaw counts, `p` pitch degrees, `ev` its motion event. */
  addMotion(t: number, x: number, p: number, ev: number): void {
    const late = t <= this.cut;
    this.reports++;
    if (late) this.late++;
    this.winSeen++;
    if (late) this.winLate++;
    if (this.winSeen >= WINDOW) this.adapt();
    insert(this.motion, this.head, { t, x, p, ev });
    this.pendingX += x;
    this.pendingP += p;
  }

  /**
   * A movement key went down / up at `t`. A key's edges keep the order they arrived in: after a stall over MAX_AGE_MS a
   * press can be stamped "now" while its release keeps its own, earlier time, which would sort the release first and
   * leave the key stuck down.
   */
  addEdge(t: number, code: string, down: boolean): void {
    t = Math.max(t, this.lastEdge.get(code) ?? -Infinity);
    this.lastEdge.set(code, t);
    insert(this.edges, this.edgeHead, { t, code, down });
  }
  /** The newest edge time per key code (addEdge). */
  private readonly lastEdge = new Map<string, number>();

  private adapt(): void {
    const share = this.winLate / this.winSeen;
    this.winSeen = this.winLate = 0;
    if (this.holdbackMs >= HOLDBACK_MAX && share > GIVE_UP_SHARE) {
      if (++this.stuck >= STUCK_WINDOWS) this.unreliable = true;
    } else this.stuck = 0;
    if (share > LATE_HIGH) {
      this.holdbackMs = Math.min(HOLDBACK_MAX, this.holdbackMs + RAISE_MS);
      this.calm = 0;
    } else if (share < LATE_LOW) {
      if (++this.calm >= LOWER_AFTER) {
        this.holdbackMs = Math.max(0, this.holdbackMs - LOWER_MS);
        this.calm = 0;
      }
    } else this.calm = 0;
  }

  /**
   * The command for the tick whose boundary is `at` (performance.now() clock): applies the motion and key edges stamped
   * at or before `at - holdbackMs` (`onMotion` per report). `at` undefined (a scripted / debug tick): everything.
   */
  take(at: number | undefined, onMotion: (x: number, p: number) => void): Taken {
    const cut = at === undefined ? Infinity : at - this.holdbackMs;
    if (at !== undefined && cut > this.cut) this.cut = cut;
    let reports = 0;
    let events = 0;
    let lastEv = -1;
    const q = this.motion;
    while (this.head < q.length && q[this.head].t <= cut) {
      const m = q[this.head++];
      this.pendingX -= m.x;
      this.pendingP -= m.p;
      onMotion(m.x, m.p);
      reports++;
      if (m.ev !== lastEv) {
        events++;
        lastEv = m.ev;
      }
    }
    if (this.head === q.length) {
      q.length = this.head = 0;
      this.pendingX = this.pendingP = 0; // no float drift once nothing is pending
    } else if (this.head > 1024) {
      q.splice(0, this.head);
      this.head = 0;
    }
    const e = this.edges;
    while (this.edgeHead < e.length && e[this.edgeHead].t <= cut) {
      const k = e[this.edgeHead++];
      this.keys.delete(k.code); // a press moves the key to the newest
      if (k.down) this.keys.add(k.code);
    }
    if (this.edgeHead === e.length) e.length = this.edgeHead = 0;
    return { events, reports };
  }

  /** Everything pending into the next command now (`onMotion` per report): a sensitivity change, a release. */
  flushMotion(onMotion: (x: number, p: number) => void): Taken {
    let events = 0;
    let lastEv = -1;
    for (let i = this.head; i < this.motion.length; i++) {
      onMotion(this.motion[i].x, this.motion[i].p);
      if (this.motion[i].ev !== lastEv) {
        events++;
        lastEv = this.motion[i].ev;
      }
    }
    const reports = this.motion.length - this.head;
    this.motion.length = this.head = 0;
    this.pendingX = this.pendingP = 0;
    return { events, reports };
  }

  /** The view's yaw was set (spawn, restart, raw set): pending yaw motion is forgotten (pitch stays). */
  dropYaw(): void {
    for (let i = this.head; i < this.motion.length; i++) this.motion[i].x = 0;
    this.pendingX = 0;
  }

  /** The view's pitch was set: pending pitch motion is forgotten. */
  dropPitch(): void {
    for (let i = this.head; i < this.motion.length; i++) this.motion[i].p = 0;
    this.pendingP = 0;
  }

  /** Keys released (blur, unlock, rebinding): no held movement keys and no pending edges. */
  releaseKeys(): void {
    this.keys.clear();
    this.edges.length = this.edgeHead = 0;
  }

  /** Back to the start (turned on / off): the holdback keeps what it learned. */
  reset(): void {
    this.motion.length = this.head = 0;
    this.pendingX = this.pendingP = 0;
    this.releaseKeys();
    this.cut = -Infinity;
  }
}
