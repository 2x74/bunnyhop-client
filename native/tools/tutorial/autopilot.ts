// Demo bot for the tutorial lessons: follows a lesson's route with human-like air strafing (one key at a time, the
// mouse turning with the velocity, ~4 strafes a second), autohop or Legit Scroll jumps, and jump timing at gaps
// (it waits on the ground for a tick or two rather than jump into a pit). Deterministic: plain arithmetic on the
// player state the core reports, no randomness.
//
// The strafe: look slightly behind the velocity direction, on the side you're turning to, and hold that side's key:
// the wish direction then sits just under 90 degrees from the velocity (dot(velocity, wishdir) = P_TARGET), which
// gains (900 - P^2) / (2 |v|) u/s every tick while the velocity turns towards the key. The turn rate that gives is
// what a player's mouse has to match ("sync").

import type { PlayerState } from "../../apps/web/src/core";

export const IN_JUMP = 1 << 1;
export const IN_DUCK = 1 << 2;
export const IN_FORWARD = 1 << 3;
export const IN_MOVELEFT = 1 << 9;
export const IN_MOVERIGHT = 1 << 10;

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PilotOptions {
  route: [number, number][];
  /** Pits to never land in (world rects) and the stepping stones inside them. */
  pits?: Rect[];
  islands?: Rect[];
  /** Legit Scroll: press jump only on the landing tick. */
  legit?: boolean;
  /** No strafing (lesson 1): hold W and jump. */
  noStrafe?: boolean;
  /** Heading swing either side of the target direction before switching keys (degrees). */
  swing?: number;
  /** Waypoint reached within this distance (units). */
  reach?: number;
  /** Stop gaining above this speed (keep strafing to steer, at the air cap). */
  maxSpeed?: number;
  /** Mouse speed limit (degrees per tick). */
  maxTurn?: number;
  /** Initial view yaw (the start's angles). */
  yaw?: number;
  /**
   * One strafe per hop (the strafe lessons' slalom): switch sides at every take-off, left first, unless the heading
   * has drifted more than `swing` off the route, then turn back towards it.
   */
  perHop?: boolean;
}

const DEG = 180 / Math.PI;
const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
/** dot(velocity, wishdir) the strafe aims for: 30 is the air cap (no gain), 0 is perpendicular (max gain). */
const P_TARGET = 14;
const AIRTIME = (2 * 301.993) / 800;

export class Autopilot {
  private wp = 0;
  private side: 1 | -1 = 1; // +1 = turning left (A), -1 = right (D)
  private tick = 0;
  private prevJump = false;
  private groundTicks = 0;
  private yaw: number | null = null;
  private waited = 0;
  /** The planner wants a shorter hop: zig-zag wide and stop gaining. */
  private braking = false;
  private wasGrounded = true;
  private hops = 0;
  constructor(private o: PilotOptions) {
    this.yaw = o.yaw ?? null;
  }

  /** Done with the route. */
  get finished(): boolean {
    return this.wp >= this.o.route.length;
  }

  private inPit(x: number, y: number): boolean {
    const inR = (r: Rect, m: number) => x > r.x0 - m && x < r.x1 + m && y > r.y0 - m && y < r.y1 + m;
    // A landing counts as safe on a stone if the hull overlaps it by a margin; in a pit if the centre is clear of floor.
    return (this.o.pits ?? []).some((p) => inR(p, -14)) && !(this.o.islands ?? []).some((s) => inR(s, 4));
  }

  /** [forward, side, yaw, pitch, buttons] for the next tick from the pre-tick state. */
  command(s: PlayerState): [number, number, number, number, number] {
    this.tick++;
    const [px, py] = s.position;
    const [vx, vy] = s.velocity;
    const speed = Math.hypot(vx, vy);
    const reach = this.o.reach ?? 160;
    while (this.wp < this.o.route.length - 1 && Math.hypot(this.o.route[this.wp][0] - px, this.o.route[this.wp][1] - py) < reach) this.wp++;
    const [tx, ty] = this.o.route[Math.min(this.wp, this.o.route.length - 1)];
    if (this.wp === this.o.route.length - 1 && Math.hypot(tx - px, ty - py) < 48) this.wp++;
    const target = Math.atan2(ty - py, tx - px) * DEG;
    const heading = speed > 1 ? Math.atan2(vy, vx) * DEG : target;

    // Jump: autohop holds it; Legit Scroll taps it on the landing tick. Don't take off into a pit if the edge is a few
    // ticks away (an edge jump); further away there's nothing better to do than jump (the air planner below aims every
    // landing at solid floor).
    const dx = tx - px;
    const dy = ty - py;
    const dl = Math.hypot(dx, dy) || 1;
    const dir: [number, number] = [dx / dl, dy / dl];
    let jump = true;
    if (s.grounded && (this.o.pits?.length ?? 0) > 0 && speed > 50) {
      const t = AIRTIME + 0.02;
      const intoPit = this.inPit(px + vx * t, py + vy * t);
      const edgeSoon = this.inPit(px + vx * 0.04, py + vy * 0.04);
      if (intoPit && !this.inPit(px + vx * 0.012, py + vy * 0.012) && this.waited < 4 && edgeSoon) jump = false;
    }
    this.waited = s.grounded && !jump ? this.waited + 1 : 0;
    // From a standstill, run up to speed before the first hop (but never stand still against an obstacle).
    this.groundTicks = s.grounded ? this.groundTicks + 1 : 0;
    if (s.grounded && speed < 200 && this.groundTicks < 40) jump = false;
    if (this.o.legit) jump = jump && s.grounded && !this.prevJump;
    this.prevJump = jump;
    let buttons = jump ? IN_JUMP : 0;

    // Ground: run at the target (W, no strafe) until fast enough, then keep hopping.
    if (s.grounded || this.o.noStrafe) {
      this.wasGrounded = true;
      buttons |= IN_FORWARD;
      return [450, 0, this.look(target), 0, buttons];
    }
    // Air: alternate sides around the target heading; a big error (a corner) keeps turning one way.
    const err = wrap(heading - target);
    const swing = this.plan(s, dir, speed) ?? this.o.swing ?? 18;
    // One strafe per hop: switch sides at take-off (left first). Either way, never swing more than `swing` off.
    if (this.o.perHop && this.wasGrounded) this.side = this.hops++ === 0 ? 1 : this.side > 0 ? -1 : 1;
    if (this.side > 0 && err > swing) this.side = -1;
    else if (this.side < 0 && err < -swing) this.side = 1;
    this.wasGrounded = false;
    // Look behind the velocity on the turning side so dot(v, wish) = P_TARGET (A: wish = yaw + 90).
    const p = this.braking || speed > (this.o.maxSpeed ?? Infinity) ? 29 : P_TARGET;
    const off = Math.asin(Math.min(1, p / Math.max(speed, p))) * DEG;
    const yaw = this.look(wrap(heading - this.side * off));
    buttons |= this.side > 0 ? IN_MOVELEFT : IN_MOVERIGHT;
    return [0, this.side > 0 ? -450 : 450, yaw, 0, buttons];
  }

  /**
   * Hop-length control over pits: predict where this hop lands and where the next two land (one hop length apart);
   * if any of them is in a pit, find the smallest shift of this landing that puts them all on floor. Shorter: zig-zag
   * wider (less progress along the route); longer: fly straight. Returns the swing to use, or null for the default.
   */
  private plan(s: PlayerState, dir: [number, number], speed: number): number | null {
    this.braking = false;
    if (!(this.o.pits?.length ?? 0)) return null;
    const z = s.position[2];
    const vz = s.velocity[2];
    if (z < -1) return null;
    const tRem = (vz + Math.sqrt(Math.max(0, vz * vz + 1600 * z))) / 800;
    const along = s.velocity[0] * dir[0] + s.velocity[1] * dir[1];
    const a = along * tRem;
    // Hop length: the speed keeps climbing in the air (up to maxSpeed).
    const H = Math.min(speed + 30, Math.max(speed, this.o.maxSpeed ?? Infinity)) * AIRTIME;
    const at = (d: number) => this.inPit(s.position[0] + dir[0] * d, s.position[1] + dir[1] * d);
    const ok = (shift: number) => [0, 1, 2].every((k) => !at(a - shift + k * H));
    if (ok(0)) return null;
    for (let d = 4; d < 0.6 * H; d += 4) {
      if (d < 0.08 * H && ok(-d)) return 6;
      if (ok(d)) {
        this.braking = true;
        return 60;
      }
    }
    return null;
  }

  /** The view turns towards `want` at most maxTurn degrees per tick (a hand on a mouse). */
  private look(want: number): number {
    const max = this.o.maxTurn ?? 4;
    if (this.yaw === null) return (this.yaw = want);
    const d = wrap(want - this.yaw);
    this.yaw = wrap(this.yaw + Math.max(-max, Math.min(max, d)));
    return this.yaw;
  }
}
