// The charm's swing (v0.0.43): a short chain from a ring on the knife to the charm, moved by how the view and the
// player really move. DOM- and three-free (tests run it directly; the native port copies it).
//
// Points, in the eye's frame (Source view space: x forward, y left, z up, the eye at the origin; the viewmodel's root
// before the left-hand mirror): 0 the ring (pinned to the anchor every step), 1 the cord's middle, 2 the charm's loop,
// 3 the charm's centre. The cord (0-1-2) is light and can go slack; the charm's own link (2-3) is rigid and heavy.
//
// Forces in that frame:
//   gravity          the scale's own (GRAVITY, the knife is a real knife's inches), turned by the view's pitch
//   the player       their velocity's change, spread evenly over the steps it happened in, times kLin
//   the view turning the frame's fictitious forces (Euler, Coriolis, centrifugal about the eye), times kRot
// The ring's own motion (the hand's sway, bob, landing dip, an inspect's spin) moves it through the pinned point.
//
// Integration: position Verlet at a fixed STEP with an accumulator, the anchor and the forces interpolated across a
// frame's substeps, so the motion is the same at 30 or 1000 frames a second (test/charms-physics.test.ts). At most
// MAX_STEPS a frame (a hitch slows the charm instead of blowing it up); speeds clamped; a jump of the ring or the view
// (teleport, map load, knife switch) resets it to hanging still. Nothing here reaches the simulation or a replay.

export type V3 = [number, number, number];

/** Gravity (u/s^2): the viewmodel is drawn at real scale (a knife is about 13 units, inches), so a real 1 g. */
export const GRAVITY = 386;
/** The game's own gravity (sv_gravity, CS:S): the player's velocity changes are scaled to the charm's gravity. */
export const GAME_GRAVITY = 800;
/** The fixed step (s) and the most steps a frame may take. */
export const STEP = 1 / 240;
export const MAX_STEPS = 12;
/** Point speed limit (u/s, relative to the eye). */
export const MAX_SPEED = 600;
/** A ring that moves this far in one frame, or a view that turns this far (deg), is a cut: the chain resets. */
export const SNAP_DIST = 6;
export const SNAP_TURN = 60;
/** View rate clamp (rad/s) and its low-pass (s). */
export const OMEGA_MAX = 25;
export const OMEGA_TAU = 0.03;
/** Most acceleration the forces may give a point (u/s^2, ~16 g): a backstop, never reached in play. */
export const MAX_ACCEL = 6000;
/** Constraint iterations per step. */
export const ITER = 3;
/** The charm's twist about its cord: spring (Hz), damping, how much a turn of the view kicks it, its limit (rad). */
export const TWIST = { hz: 1.6, zeta: 0.35, kick: 0.6, limit: 1.3 } as const;

/** How lively it swings, from the Swing slider (0 .. 100): the view's and the player's share, and the damping. */
export interface ChainTune {
  kRot: number;
  kLin: number;
  zeta: number;
  /** The most the charm swings from straight down (rad, from the ring): it never flips over the knife. */
  cone: number;
  /**
   * How much of the hand's own movement on screen (the viewmodel's sway, bob, landing dip, inspects) the charm feels:
   * 1 = all of it (it hangs from a moving ring), less = the rest carries it along rigidly.
   */
  kHand: number;
}
export function tuneOf(swing: number): ChainTune {
  const s = Math.min(1, Math.max(0, swing / 100));
  // (The view's share rises with the square: the calm end barely feels a turn, the lively end swings out of strafes.)
  return { kRot: 0.015 + 0.3 * s * s, kLin: 0.1 + 0.65 * s * s, zeta: 0.7 - 0.45 * s, cone: ((35 + 45 * s) * Math.PI) / 180, kHand: 0.3 + 0.7 * s };
}

/** The chain's lengths (units): the cord (ring to the charm's loop) and the charm's loop to its centre; its radius. */
export interface ChainShape {
  cord: number;
  link: number;
  radius: number;
  /**
   * The charm as a few balls along its own axis, for what it rests against (v0.0.43 fit pass: one ball `radius` let a
   * tall or wide charm's ends into the hand): `t` along the link from the loop (1 = its middle, 2 = twice as far, below
   * 0 = above the loop: ears), `r` the ball's radius (units). Absent: the one ball at its middle.
   */
  balls?: readonly { t: number; r: number }[];
}

/** What the chain may not pass through (eye space, this frame): capsules a-b and spheres (b ignored). */
export interface Collider {
  a: V3;
  b: V3 | null;
  r: number;
}

/**
 * Points a charm rests against (v0.0.43 fit pass): the real surface of the knife, a hilt's pieces and the hand at rest,
 * sampled (anchors.ts) in some frame of its own, in cells so a ball only looks at what is near it. Each point is a
 * small ball of radius `pr`.
 */
export class PointCloud {
  private cells = new Map<number, number[]>();
  constructor(readonly pts: Float32Array, readonly pr = 0.045, private cell = 0.3) {
    for (let i = 0; i < pts.length; i += 3) {
      const k = this.key(Math.floor(pts[i] / cell), Math.floor(pts[i + 1] / cell), Math.floor(pts[i + 2] / cell));
      let c = this.cells.get(k);
      if (!c) this.cells.set(k, (c = []));
      c.push(i);
    }
  }
  private key(i: number, j: number, k: number): number {
    return ((i + 512) << 20) | ((j + 512) << 10) | (k + 512);
  }
  /**
   * The push that takes a ball (centre x, y, z, radius r, in the cloud's frame) out of the point it is deepest in:
   * written to `out` (a vector); returns whether there is one.
   */
  push(x: number, y: number, z: number, r: number, out: Float64Array): boolean {
    const c = this.cell, R = r + this.pr, P = this.pts;
    const i0 = Math.floor((x - R) / c), i1 = Math.floor((x + R) / c), j0 = Math.floor((y - R) / c), j1 = Math.floor((y + R) / c), k0 = Math.floor((z - R) / c), k1 = Math.floor((z + R) / c);
    let best = R * R, bi = -1;
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++)
        for (let k = k0; k <= k1; k++) {
          const cell = this.cells.get(this.key(i, j, k));
          if (!cell) continue;
          for (const o of cell) {
            const dx = x - P[o], dy = y - P[o + 1], dz = z - P[o + 2], d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < best) (best = d2), (bi = o);
          }
        }
    if (bi < 0) return false;
    const d = Math.sqrt(best);
    if (d < 1e-6) return false;
    const k = (R - d) / d;
    (out[0] = (x - P[bi]) * k), (out[1] = (y - P[bi + 1]) * k), (out[2] = (z - P[bi + 2]) * k);
    return true;
  }
}

/** A cloud in the chain's frame this frame: eye -> the cloud's own frame (3x4 row-major; a rigid motion, so its rotation's transpose turns a push back). */
export interface CloudInput {
  cloud: PointCloud;
  toLocal: ArrayLike<number>;
}

export interface ChainInput {
  /** Frame time (s, already clamped by the viewmodel). */
  dt: number;
  /** The ring, eye space. */
  anchor: V3;
  /** View angles (degrees, Source: yaw left +, pitch down +). */
  yaw: number;
  pitch: number;
  /** Player velocity (u/s, world). */
  velocity: ArrayLike<number>;
  colliders?: readonly Collider[];
  clouds?: readonly CloudInput[];
}

const D2R = Math.PI / 180;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class CharmChain {
  /** Positions now and one step ago (4 points × xyz), and the state one step before the last (for drawing between). */
  readonly p = new Float64Array(12);
  readonly q = new Float64Array(12);
  private last = new Float64Array(12);
  /** What to draw (eye space): the chain between its last two steps, carried to the ring's place now. */
  readonly out = new Float64Array(12);
  /** Twist about the cord (rad) and its rate; drawn the same way. */
  twist = 0;
  private twistV = 0;
  private lastTwist = 0;
  twistOut = 0;
  /** Seconds simulated not yet stepped (0 .. STEP). */
  private acc = 0;
  private started = false;
  /** The previous frame's inputs. */
  private prevAnchor: V3 = [0, 0, 0];
  private prevYaw = 0;
  private prevPitch = 0;
  private prevVel: V3 = [0, 0, 0];
  /** Smoothed view rate (rad/s: yaw, pitch); the player's velocity change not yet given to the steps (world). */
  private om: [number, number] = [0, 0];
  private dv: V3 = [0, 0, 0];
  /** Shape and tune (set by the owner; a change takes effect at the next step). */
  shape: ChainShape = { cord: 1.6, link: 0.8, radius: 0.8 };
  tune: ChainTune = tuneOf(30);
  /** Resets so far (tests, dev). */
  resets = 0;

  /** Hanging still under `anchor`, the view at `pitch` (deg). */
  reset(anchor: V3, pitch = 0, yaw = 0, velocity: ArrayLike<number> = [0, 0, 0]): void {
    const th = pitch * D2R;
    // Straight down along gravity in the eye's frame.
    const g: V3 = [Math.sin(th), 0, -Math.cos(th)];
    const L = [0, this.shape.cord / 2, this.shape.cord, this.shape.cord + this.shape.link];
    for (let i = 0; i < 4; i++) for (let k = 0; k < 3; k++) this.p[i * 3 + k] = this.q[i * 3 + k] = this.last[i * 3 + k] = anchor[k] + g[k] * L[i];
    this.out.set(this.p);
    this.twist = this.twistV = this.lastTwist = this.twistOut = 0;
    this.acc = 0;
    this.prevAnchor = [anchor[0], anchor[1], anchor[2]];
    this.prevYaw = yaw;
    this.prevPitch = pitch;
    this.prevVel = [velocity[0] ?? 0, velocity[1] ?? 0, velocity[2] ?? 0];
    this.om = [0, 0];
    this.dv = [0, 0, 0];
    this.started = true;
    this.resets++;
  }

  /** Forget everything: the next update starts hanging still. */
  clear(): void {
    this.started = false;
  }

  update(s: ChainInput): void {
    const dt = s.dt;
    const A = s.anchor;
    if (!this.started) return this.reset(A, s.pitch, s.yaw, s.velocity);
    if (!(dt > 0)) {
      // A paused frame (or a seek): carry the drawing to the ring, nothing moves.
      this.draw(A);
      return;
    }
    const dyaw = wrap((s.yaw - this.prevYaw) * D2R), dpitch = (s.pitch - this.prevPitch) * D2R;
    const jump = Math.hypot(A[0] - this.prevAnchor[0], A[1] - this.prevAnchor[1], A[2] - this.prevAnchor[2]);
    if (jump > SNAP_DIST || Math.abs(dyaw) > SNAP_TURN * D2R || Math.abs(dpitch) > SNAP_TURN * D2R || !A.every(Number.isFinite)) {
      if (A.every(Number.isFinite)) this.reset(A, s.pitch, s.yaw, s.velocity);
      return;
    }
    // The view's rate (clamped, low-passed) and its change; the player's velocity change, to be spread over the steps.
    const kO = 1 - Math.exp(-dt / OMEGA_TAU);
    const cl = (v: number) => Math.max(-OMEGA_MAX, Math.min(OMEGA_MAX, v));
    const om0: [number, number] = [this.om[0], this.om[1]];
    this.om[0] += (cl(dyaw / dt) - this.om[0]) * kO;
    this.om[1] += (cl(dpitch / dt) - this.om[1]) * kO;
    const omDot: [number, number] = [(this.om[0] - om0[0]) / dt, (this.om[1] - om0[1]) / dt];
    const v = s.velocity;
    for (let k = 0; k < 3; k++) {
      const vk = Number.isFinite(v[k]) ? v[k] : this.prevVel[k];
      this.dv[k] += vk - this.prevVel[k];
      this.prevVel[k] = vk;
    }

    // Fixed steps through the frame: the anchor, the view and its rate interpolated to each step's time.
    this.acc += dt;
    let n = Math.floor(this.acc / STEP + 1e-9);
    if (n > MAX_STEPS) (n = MAX_STEPS), (this.acc = n * STEP);
    const t0 = this.acc - dt; // the first step ends at (STEP - t0) into the frame
    for (let i = 1; i <= n; i++) {
      const u = Math.min(1, Math.max(0, (i * STEP - t0) / dt));
      const a: V3 = [this.prevAnchor[0] + (A[0] - this.prevAnchor[0]) * u, this.prevAnchor[1] + (A[1] - this.prevAnchor[1]) * u, this.prevAnchor[2] + (A[2] - this.prevAnchor[2]) * u];
      const yaw = (this.prevYaw * D2R) + dyaw * u, pitch = (this.prevPitch + (s.pitch - this.prevPitch) * u) * D2R;
      const wy = om0[0] + (this.om[0] - om0[0]) * u, wp = om0[1] + (this.om[1] - om0[1]) * u;
      this.last.set(this.p);
      this.lastTwist = this.twist;
      // This step's share of the velocity change waiting (the time not yet stepped, of which this step is STEP).
      const share = Math.min(1, STEP / Math.max(STEP, this.acc - (i - 1) * STEP));
      const kick: V3 = [this.dv[0] * share, this.dv[1] * share, this.dv[2] * share];
      for (let k = 0; k < 3; k++) this.dv[k] -= kick[k];
      this.stepOnce(a, yaw, pitch, [wy, wp], omDot, kick, s.colliders, s.clouds);
    }
    this.acc -= n * STEP;
    this.prevAnchor = [A[0], A[1], A[2]];
    this.prevYaw = s.yaw;
    this.prevPitch = s.pitch;
    this.draw(A);
  }

  /** The drawn chain: between the last two steps by the time left over, moved so its ring is at `A` exactly. */
  private draw(A: V3): void {
    const f = Math.min(1, this.acc / STEP);
    const o = this.out, p = this.p, l = this.last;
    for (let i = 0; i < 12; i++) o[i] = l[i] + (p[i] - l[i]) * f;
    const dx = A[0] - o[0], dy = A[1] - o[1], dz = A[2] - o[2];
    for (let i = 0; i < 4; i++) (o[i * 3] += dx), (o[i * 3 + 1] += dy), (o[i * 3 + 2] += dz);
    this.twistOut = this.lastTwist + (this.twist - this.lastTwist) * f;
  }

  private stepOnce(a: V3, yaw: number, pitch: number, om: [number, number], omDot: [number, number], kickW: V3, colliders: readonly Collider[] | undefined, clouds?: readonly CloudInput[]): void {
    const h = STEP, p = this.p, q = this.q, T = this.tune, S = this.shape;
    // The eye's axes in the world: forward f, left l, up u (Source: yaw left +, pitch down +).
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const f: V3 = [cp * cy, cp * sy, -sp], l: V3 = [-sy, cy, 0], up: V3 = [sp * cy, sp * sy, cp];
    // Gravity, and the player's velocity change in this step, in the eye's frame.
    const g: V3 = [GRAVITY * sp, 0, -GRAVITY * cp];
    // (At the charm's gravity over the game's: the game's world falls at 800 u/s^2, the charm at 386, so a curve or a hop
    // tilts it as far as it would tilt a charm in that world; free fall in a hop is weightless at kLin 1, not upward.)
    const gs = GRAVITY / GAME_GRAVITY;
    const kx = kickW[0] * gs, ky = kickW[1] * gs, kz = kickW[2] * gs;
    const kE: V3 = [f[0] * kx + f[1] * ky + f[2] * kz, l[0] * kx + l[1] * ky, up[0] * kx + up[1] * ky + up[2] * kz];
    // The view's angular velocity and its change in the eye's frame: yaw about the world's up, pitch about the left axis.
    const w: V3 = [-om[0] * sp, om[1], om[0] * cp], wd: V3 = [-omDot[0] * sp, omDot[1], omDot[0] * cp];
    // Damping: ζ of the pendulum's own frequency.
    const w0 = Math.sqrt(GRAVITY / Math.max(0.3, S.cord + S.link)), keep = Math.exp(-2 * T.zeta * w0 * h);
    const kR = T.kRot, kL = T.kLin;
    for (let i = 1; i < 4; i++) {
      const o = i * 3;
      const r: V3 = [p[o], p[o + 1], p[o + 2]];
      const vel: V3 = [(p[o] - q[o]) / h, (p[o + 1] - q[o + 1]) / h, (p[o + 2] - q[o + 2]) / h];
      // Fictitious: -(ω̇×r) - 2ω×v - ω×(ω×r).
      const e = cross(wd, r), c = cross(w, vel), wr = cross(w, r), cf = cross(w, wr);
      const acc: V3 = [0, 0, 0];
      for (let k = 0; k < 3; k++) acc[k] = g[k] - kR * (e[k] + 2 * c[k] + cf[k]);
      const am = Math.hypot(acc[0], acc[1], acc[2]);
      if (am > MAX_ACCEL) for (let k = 0; k < 3; k++) acc[k] *= MAX_ACCEL / am;
      for (let k = 0; k < 3; k++) {
        // The eye's frame took the player's change of velocity; the point, being free, keeps its own: relative to the
        // eye it changes by minus that (times kLin).
        let dv = (p[o + k] - q[o + k]) * keep - kL * kE[k] * h;
        const lim = MAX_SPEED * h;
        if (dv > lim) dv = lim;
        else if (dv < -lim) dv = -lim;
        q[o + k] = p[o + k];
        p[o + k] += dv + acc[k] * h * h;
      }
    }
    // The ring is where the knife has it; the rest is carried along by (1 - kHand) of the ring's move.
    const carry = 1 - T.kHand;
    for (let k = 0; k < 3; k++) {
      const mv = (a[k] - p[k]) * carry;
      for (let i = 1; i < 4; i++) (p[i * 3 + k] += mv), (q[i * 3 + k] += mv);
      (q[k] = p[k]), (p[k] = a[k]);
    }
    // Constraints: the cord's two halves at most cord / 2 (slack allowed), the charm's link exactly its length; the
    // cord's points are light, the charm heavy (inverse masses 1 and 0.25; the ring is fixed).
    const half = S.cord / 2;
    for (let it = 0; it < ITER; it++) {
      link(p, 0, 1, half, 0, 1, true);
      link(p, 1, 2, half, 1, 1, true);
      link(p, 2, 3, S.link, 1, 0.25, false);
      if (colliders) {
        const balls = S.balls;
        for (let i = 1; i < (balls ? 3 : 4); i++) for (const cdef of colliders) push(p, i, cdef, i === 3 ? S.radius : 0.12);
        if (balls) for (const b of balls) for (const cdef of colliders) pushBall(p, b.t, b.r, cdef);
      }
      if (clouds) {
        const balls = S.balls ?? [{ t: 1, r: S.radius }];
        for (const cl of clouds) {
          for (let i = 1; i < 3; i++) cloudPoint(p, i, 0.05, cl);
          // The cord between its points: so it lies over a knuckle instead of cutting through it.
          for (const f of SPAN) cloudSpan(p, 0, 1, f, 0.055, cl);
          for (const f of SPAN) cloudSpan(p, 1, 2, f, 0.055, cl);
          for (const b of balls) cloudBall(p, b.t, b.r, cl);
        }
      }
    }
    // The swing's limit: each point within `cone` of straight down from the ring (the charm hangs, it never flips up over
    // the guard), losing half its speed when it reaches it.
    const gl = Math.hypot(g[0], g[1], g[2]), gd: V3 = [g[0] / gl, g[1] / gl, g[2] / gl], cc = Math.cos(T.cone), sc = Math.sin(T.cone);
    for (let i = 1; i < 4; i++) {
      const o = i * 3;
      const d: V3 = [p[o] - p[0], p[o + 1] - p[1], p[o + 2] - p[2]];
      const L = Math.hypot(d[0], d[1], d[2]);
      if (L < 1e-9) continue;
      const along = (d[0] * gd[0] + d[1] * gd[1] + d[2] * gd[2]) / L;
      if (along >= cc) continue;
      // The part of d across gravity, kept in its direction, at the cone's edge.
      const ax: V3 = [d[0] / L - gd[0] * along, d[1] / L - gd[1] * along, d[2] / L - gd[2] * along];
      const al = Math.hypot(ax[0], ax[1], ax[2]) || 1;
      for (let k = 0; k < 3; k++) {
        const np = p[k] + L * (gd[k] * cc + (ax[k] / al) * sc);
        q[o + k] = np - (p[o + k] - q[o + k]) * 0.5;
        p[o + k] = np;
      }
    }
    // Last, from the ring down, the lengths exactly (whatever the collisions left): the cord at most its length, the
    // charm's link its length.
    follow(p, 0, 1, half, true);
    follow(p, 1, 2, half, true);
    follow(p, 2, 3, S.link, false);
    // Twist: a spring back to facing the eye, kicked by the view's turn about the cord (≈ the eye's up).
    const wt = 2 * Math.PI * TWIST.hz;
    this.twistV += (-wt * wt * this.twist - 2 * TWIST.zeta * wt * this.twistV - TWIST.kick * kR * 4 * wd[2]) * h;
    this.twist += this.twistV * h;
    if (Math.abs(this.twist) > TWIST.limit) (this.twist = Math.sign(this.twist) * TWIST.limit), (this.twistV *= -0.3);
  }
}

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Distance constraint between points i and j (inverse masses wi, wj; `slack`: only when longer). */
function link(p: Float64Array, i: number, j: number, L: number, wi: number, wj: number, slack: boolean): void {
  const a = i * 3, b = j * 3;
  const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-9 || (slack && d <= L)) return;
  const w = wi + wj;
  if (w <= 0) return;
  const k = (d - L) / (d * w);
  p[a] += dx * k * wi, p[a + 1] += dy * k * wi, p[a + 2] += dz * k * wi;
  p[b] -= dx * k * wj, p[b + 1] -= dy * k * wj, p[b + 2] -= dz * k * wj;
}

/** Point j brought to within L of point i (exactly L unless `slack`), along the line between them. */
function follow(p: Float64Array, i: number, j: number, L: number, slack: boolean): void {
  const a = i * 3, b = j * 3;
  const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-9 || (slack && d <= L)) return;
  const k = L / d;
  (p[b] = p[a] + dx * k), (p[b + 1] = p[a + 1] + dy * k), (p[b + 2] = p[a + 2] + dz * k);
}

/**
 * Pushes a ball on the charm's axis (at `t` along the link from the loop, point 2, toward its middle, point 3) out of a
 * capsule / sphere, by moving the link's two ends so the ball moves just that far.
 */
function pushBall(p: Float64Array, t: number, r: number, c: Collider): void {
  const w2 = 1 - t, w3 = t;
  const sx = p[6] * w2 + p[9] * w3, sy = p[7] * w2 + p[10] * w3, sz = p[8] * w2 + p[11] * w3;
  let cx = c.a[0], cy = c.a[1], cz = c.a[2];
  if (c.b) {
    const ux = c.b[0] - c.a[0], uy = c.b[1] - c.a[1], uz = c.b[2] - c.a[2];
    const uu = ux * ux + uy * uy + uz * uz;
    const k = uu > 1e-9 ? Math.min(1, Math.max(0, ((sx - c.a[0]) * ux + (sy - c.a[1]) * uy + (sz - c.a[2]) * uz) / uu)) : 0;
    (cx += ux * k), (cy += uy * k), (cz += uz * k);
  }
  const dx = sx - cx, dy = sy - cy, dz = sz - cz;
  const d = Math.hypot(dx, dy, dz), R = c.r + r;
  if (d >= R || d < 1e-9) return;
  const k = (R - d) / d / (w2 * w2 + w3 * w3);
  // (The loop is light and the charm heavy, but it is the ball that must move: each end by its share of the lever.)
  (p[6] += dx * k * w2), (p[7] += dy * k * w2), (p[8] += dz * k * w2);
  (p[9] += dx * k * w3), (p[10] += dy * k * w3), (p[11] += dz * k * w3);
}

const PUSH = new Float64Array(3);
/** Where along each half of the cord it is tested against the clouds. */
const SPAN = [0.14, 0.28, 0.42, 0.57, 0.71, 0.86];
/** A push found in a cloud's frame for the eye-space point (x, y, z), turned back into the eye's frame (in PUSH). */
function cloudPush(x: number, y: number, z: number, r: number, cl: CloudInput): boolean {
  const m = cl.toLocal;
  if (!cl.cloud.push(m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11], r, PUSH)) return false;
  const a = PUSH[0], b = PUSH[1], c = PUSH[2];
  (PUSH[0] = m[0] * a + m[4] * b + m[8] * c), (PUSH[1] = m[1] * a + m[5] * b + m[9] * c), (PUSH[2] = m[2] * a + m[6] * b + m[10] * c);
  return true;
}
/** Point i (radius r) out of a cloud. */
function cloudPoint(p: Float64Array, i: number, r: number, cl: CloudInput): void {
  const o = i * 3;
  if (cloudPush(p[o], p[o + 1], p[o + 2], r, cl)) (p[o] += PUSH[0]), (p[o + 1] += PUSH[1]), (p[o + 2] += PUSH[2]);
}
/** A point `f` of the way along the cord from point i to point j (radius r) out of a cloud, by moving its ends (the ring, point 0, is fixed). */
function cloudSpan(p: Float64Array, i: number, j: number, f: number, r: number, cl: CloudInput): void {
  const a = i * 3, b = j * 3, wi = i === 0 ? 0 : 1 - f, wj = f;
  if (!cloudPush(p[a] + (p[b] - p[a]) * f, p[a + 1] + (p[b + 1] - p[a + 1]) * f, p[a + 2] + (p[b + 2] - p[a + 2]) * f, r, cl)) return;
  const k = 1 / ((1 - f) * wi + f * wj);
  (p[a] += PUSH[0] * k * wi), (p[a + 1] += PUSH[1] * k * wi), (p[a + 2] += PUSH[2] * k * wi);
  (p[b] += PUSH[0] * k * wj), (p[b + 1] += PUSH[1] * k * wj), (p[b + 2] += PUSH[2] * k * wj);
}

/** A ball on the charm's axis (pushBall) out of a cloud. */
function cloudBall(p: Float64Array, t: number, r: number, cl: CloudInput): void {
  const w2 = 1 - t, w3 = t;
  if (!cloudPush(p[6] * w2 + p[9] * w3, p[7] * w2 + p[10] * w3, p[8] * w2 + p[11] * w3, r, cl)) return;
  const k = 1 / (w2 * w2 + w3 * w3);
  (p[6] += PUSH[0] * k * w2), (p[7] += PUSH[1] * k * w2), (p[8] += PUSH[2] * k * w2);
  (p[9] += PUSH[0] * k * w3), (p[10] += PUSH[1] * k * w3), (p[11] += PUSH[2] * k * w3);
}

/** Pushes point i (radius r) out of a capsule / sphere. */
function push(p: Float64Array, i: number, c: Collider, r: number): void {
  const o = i * 3;
  let cx = c.a[0], cy = c.a[1], cz = c.a[2];
  if (c.b) {
    const ux = c.b[0] - c.a[0], uy = c.b[1] - c.a[1], uz = c.b[2] - c.a[2];
    const uu = ux * ux + uy * uy + uz * uz;
    const t = uu > 1e-9 ? Math.min(1, Math.max(0, ((p[o] - c.a[0]) * ux + (p[o + 1] - c.a[1]) * uy + (p[o + 2] - c.a[2]) * uz) / uu)) : 0;
    (cx += ux * t), (cy += uy * t), (cz += uz * t);
  }
  const dx = p[o] - cx, dy = p[o + 1] - cy, dz = p[o + 2] - cz;
  const d = Math.hypot(dx, dy, dz), R = c.r + r;
  if (d >= R || d < 1e-9) return;
  const k = (R - d) / d;
  (p[o] += dx * k), (p[o + 1] += dy * k), (p[o + 2] += dz * k);
}
