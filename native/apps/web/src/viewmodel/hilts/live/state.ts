// What a living hilt reacts to (v0.0.43), from what the viewmodel already gets every frame (viewmodel.ts
// ViewmodelInput, the inspect runtime) and its own clock. Nothing here reaches the simulation, and nothing reads the
// wall clock: the replay viewer and the exporter feed the same input, so a replay or an export plays the same hilt
// every time. Rates are exponential (exact for any dt), timing windows are in seconds, so 30 and 240 fps agree.

export interface PlayInput {
  velocity: ArrayLike<number>;
  grounded: boolean;
  /** Vertical speed of a landing since the last frame (negative, units/s), or 0. */
  landed: number;
  /** View yaw, degrees (Source: + turns left). */
  yaw: number;
}

/** A landing reads as a hop kept going when the take-off follows it within this long (s). */
export const CLEAN_HOP_WINDOW = 0.12;
/** Standing on the ground this long (s) ends a hop chain. */
export const CHAIN_BREAK = 0.35;
/** Speed (units/s) that counts as full speed for glow levels. */
export const FULL_SPEED = 1000;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const ease = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);

export class PlaySignals {
  /** The viewmodel clock (s). */
  t = 0;
  /** Horizontal speed, smoothed (units/s), and as 0..1 of FULL_SPEED. */
  speed = 0;
  get speed01(): number {
    return clamp(this.speed / FULL_SPEED, 0, 1);
  }
  /** Turn rate, smoothed (deg/s, + = turning left), and as -1..1 (360 deg/s = 1). */
  turn = 0;
  get turn01(): number {
    return clamp(this.turn / 360, -1, 1);
  }
  /** Landings so far, the last one's time and how hard it was (0..1). */
  lands = 0;
  landT = -1e9;
  landHard = 0;
  /** Clean hops in a row (a landing and the take-off right after it), and when that number last changed. */
  chain = 0;
  chainT = -1e9;
  /** Hops so far (take-offs); the chain's best this run of hops. */
  hops = 0;
  grounded = true;
  groundT = 0;
  /** Inspect, eased 0..1. */
  inspect = 0;
  /** Reduced motion or cosmetics held still: the design shows its still pose. */
  still = false;

  private yaw: number | null = null;
  private pendingLand = false;

  reset(): void {
    this.t = this.speed = this.turn = 0;
    this.lands = this.hops = this.chain = 0;
    this.landT = this.chainT = -1e9;
    this.landHard = this.inspect = 0;
    this.grounded = true;
    this.groundT = 0;
    this.yaw = null;
    this.pendingLand = false;
  }

  /** Seconds since the last landing. */
  get sinceLand(): number {
    return this.t - this.landT;
  }

  update(dt: number, t: number, s: PlayInput, inspecting: boolean): void {
    this.t = t;
    const sp = Math.hypot(s.velocity[0], s.velocity[1]);
    this.speed += (sp - this.speed) * ease(dt, 8);
    if (this.yaw !== null && dt > 0) {
      let d = s.yaw - this.yaw;
      d -= Math.round(d / 360) * 360;
      this.turn += (clamp(d / dt, -1500, 1500) - this.turn) * ease(dt, 7);
    }
    this.yaw = s.yaw;
    this.inspect += ((inspecting ? 1 : 0) - this.inspect) * ease(dt, 6);
    const vz = s.velocity[2] ?? 0;
    if (s.landed < -40) {
      this.lands++;
      this.landT = t;
      this.landHard = clamp((-s.landed - 150) / 650, 0.2, 1);
      // Landed and already off again within the frame (a hop between two frames): a clean hop.
      if (!s.grounded && vz > 40) this.clean(t);
      else this.pendingLand = true;
    }
    if (this.grounded && !s.grounded && vz > 40) {
      this.hops++;
      if (this.pendingLand && t - this.landT <= CLEAN_HOP_WINDOW + Math.max(dt, 0)) this.clean(t);
      else if (this.groundT > CHAIN_BREAK) this.setChain(0, t);
      this.pendingLand = false;
    }
    if (s.grounded) {
      this.groundT += dt;
      if (this.groundT > CHAIN_BREAK && this.chain) this.setChain(0, t);
    } else this.groundT = 0;
    if (this.pendingLand && t - this.landT > CLEAN_HOP_WINDOW + 0.05 && !s.grounded) this.pendingLand = false;
    this.grounded = s.grounded;
  }

  private clean(t: number): void {
    this.pendingLand = false;
    this.setChain(this.chain + 1, t);
  }
  private setChain(n: number, t: number): void {
    if (n === this.chain) return;
    this.chain = n;
    this.chainT = t;
  }
}

/** Deterministic hash of an integer to 0..1 (idle schedules: saccades, blinks). */
export function hash1(n: number): number {
  let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/**
 * A schedule of events at irregular intervals between lo and hi seconds, as a pure function of time: the index of the
 * event at or before t and its start time. Same t, same answer, whatever the frame rate.
 */
export function schedule(t: number, lo: number, hi: number, seed: number): { i: number; at: number; next: number } {
  // Events every `hi` at most: walk from a coarse anchor so the cost stays constant.
  const span = hi;
  const k = Math.floor(t / span);
  // Each span holds one event at a hashed offset (spacing lo..hi on average).
  const at = (j: number) => j * span + (span - lo) * hash1(j * 7919 + seed);
  let j = k;
  if (at(j) > t) j--;
  return { i: j, at: at(j), next: at(j + 1) };
}
