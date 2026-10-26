// Test-only verbatim LJ tracker from apps/web/src/movement-stats/stats.ts.
// Source SHA-256: 1590b885b51b51b795bbc2d94c5a41395604ae131992dccd2005e1561734efca
// Only module dependencies/constants and unrelated formatting/offset code are omitted.
interface PlayerState { tick:number;position:number[];velocity:number[];grounded:boolean;crouched:boolean;onLadder:boolean;jumpStatsValid?:boolean }
interface TickCmd { forward:number;side:number;yaw:number;pitch:number;buttons:number }
const EVENT_JUMPED=2,EVENT_LANDED=4,BROKEN=1|8;
const MANUAL=new Set(["autohop","legit","scroll","hsw"]);
/** One strafe of a jump: from an A / D switch to the next. Gain and loss are horizontal speed (u/s). */
export interface StrafeStat {
  side: -1 | 1;
  ticks: number;
  gain: number;
  loss: number;
  /** Ticks of this strafe that added speed, in %. */
  sync: number;
}
/** One tick of the flight: horizontal distance from the takeoff point, height above it (body, not feet: an air duck's
 * step is taken out), horizontal speed. */
export interface FlightPoint { d: number; z: number; v: number }

export interface LjReport {
  kind: "LJ" | "BH";
  distance: number;
  displacement: number;
  pre: number;
  max: number;
  strafes: number;
  sync: number;
  airtime: number;
  crouched: boolean;
  /** Clean takeoff, but the player dropped below the takeoff height: distance is where they crossed it. */
  failed?: boolean;
  /** Per strafe (absent on reports made before strafe tracking). */
  strafeStats?: StrafeStat[];
  /** The flight, tick by tick (absent on older reports). */
  path?: FlightPoint[];
}

type Strafe = { side: -1 | 1; ticks: number; gain: number; loss: number; synced: number };
type Flight = { start: number[]; tick: number; kind: LjReport["kind"]; pre: number; max: number; side: number; samples: number; synced: number; valid: boolean;
  list: Strafe[]; path: FlightPoint[]; cross: { d: number; tick: number } | null; duck: number };
const round1 = (v: number) => Math.round(v * 10) / 10;
/** Flat, same-height jumps only. Source convention: horizontal origin displacement + 32-unit hull width.
 * Requires the core's clean-movement observation: rejects water, walls/ceilings, steps, movers, boosters and altered gravity.
 * 10 grounded ticks separates standing LJs from bhops; walking off a ledge never starts a flight.
 * A clean flight that drops more than 2 units below its takeoff is a fail, measured where it crossed the takeoff height. */
export class LjTracker {
  private ground = 0;
  private flight: Flight | null = null;
  reset(): void { this.ground = 0; this.flight = null; }
  private report(f: Flight, displacement: number, ticks: number, dt: number, crouched: boolean, failed: boolean): LjReport | null {
    const airtime = ticks * dt;
    if (f.samples === 0 || airtime < 0.2 || airtime > 1.2 || displacement < 32) return null;
    return { kind: f.kind, distance: displacement + 32, displacement, pre: f.pre, max: f.max, strafes: f.list.length,
      sync: 100 * f.synced / f.samples, airtime, crouched, ...(failed ? { failed: true } : {}),
      strafeStats: f.list.map(s => ({ side: s.side, ticks: s.ticks, gain: s.gain, loss: s.loss, sync: s.ticks ? 100 * s.synced / s.ticks : 0 })),
      path: f.path };
  }
  feed(pre: PlayerState, post: PlayerState, cmd: TickCmd, events: number, dt: number, style: string): LjReport | null {
    if (events & BROKEN || pre.onLadder || post.onLadder || !MANUAL.has(style) || !Number.isFinite(dt) || dt <= 0 || post.tick !== pre.tick + 1 || ![...pre.position, ...post.position, ...pre.velocity, ...post.velocity].every(Number.isFinite)) { this.reset(); return null; }
    if (pre.grounded) this.ground++;
    let report: LjReport | null = null;
    if (this.flight) {
      const f = this.flight;
      f.valid &&= post.jumpStatsValid === true;
      const speed = Math.hypot(post.velocity[0], post.velocity[1]), before = Math.hypot(pre.velocity[0], pre.velocity[1]);
      const d = Math.hypot(post.position[0] - f.start[0], post.position[1] - f.start[1]), z = post.position[2] - f.start[2];
      // Actual positive horizontal acceleration, sampled only with a movement input.
      if (!pre.grounded) {
        f.samples++;
        const synced = !!(cmd.forward || cmd.side) && speed > before + 0.0001;
        if (synced) f.synced++;
        const side = Math.sign(cmd.side) as -1 | 0 | 1;
        if (side && side !== f.side) { f.list.push({ side, ticks: 0, gain: 0, loss: 0, synced: 0 }); f.side = side; }
        const s = f.list[f.list.length - 1];
        if (s) { s.ticks++; if (speed > before) s.gain += speed - before; else s.loss += before - speed; if (synced) s.synced++; }
      }
      f.max = Math.max(f.max, speed);
      // Ducking in the air pulls the feet (the origin) up: the path keeps the body's arc, without that step.
      if (!post.grounded && post.crouched !== pre.crouched) f.duck += post.position[2] - pre.position[2] - ((pre.velocity[2] + post.velocity[2]) / 2) * dt;
      f.path.push({ d: round1(d), z: round1(post.grounded ? z : z - f.duck), v: round1(speed) });
      // Where the flight first drops through the takeoff height (interpolated between the two ticks).
      if (!f.cross && z < 0) {
        const zp = pre.position[2] - f.start[2], dp = Math.hypot(pre.position[0] - f.start[0], pre.position[1] - f.start[1]);
        const t = zp > z ? zp / (zp - z) : 1;
        f.cross = { d: dp + (d - dp) * Math.min(1, Math.max(0, t)), tick: post.tick };
      }
      if (z < -2 && f.cross) {
        if (f.valid) report = this.report(f, f.cross.d, f.cross.tick - f.tick, dt, post.crouched, true);
        this.flight = null;
      } else if (events & EVENT_LANDED || post.grounded) {
        // Source categorizes ground up to 2 units above its surface, before the next tick snaps down.
        if (f.valid && Math.abs(z) <= 2) report = this.report(f, d, post.tick - f.tick, dt, post.crouched, false);
        this.flight = null;
      } else if ((post.tick - f.tick) * dt > 1.2) this.flight = null;
    }
    if (events & EVENT_JUMPED && pre.grounded && !pre.crouched) {
      const speed = Math.hypot(pre.velocity[0], pre.velocity[1]);
      this.flight = { start: [...pre.position], tick: pre.tick, kind: this.ground >= 10 && speed <= 300 ? "LJ" : "BH",
        pre: speed, max: Math.hypot(post.velocity[0], post.velocity[1]), side: 0, samples: 0, synced: 0,
        valid: post.jumpStatsValid === true, list: [], path: [{ d: 0, z: 0, v: round1(speed) }], cross: null, duck: 0 };
    }
    if (!pre.grounded) this.ground = 0;
    return report;
  }
}
