// The bunny's leg layer (v0.0.38): presentation-only corrections on the skinning matrices after the body animation
// (CS:S animstate or the procedural fallback), before the ears, the gun, the knife and the inspect read them. Nothing
// here reaches the simulation; it reads the pose the model is given and writes bone matrices.
//
//   foot planting   standing, stopping and turning on the ground (slow: under PLANT_SPEED), a foot that touches down
//                   is locked to its spot in the world; two-bone IK (thigh, calf) keeps it there while the animation
//                   and the body move on, the ankle keeps the animation's orientation turned by the lock's yaw. A lock
//                   that drifts past STEP_DIST or STEP_YAW becomes a step: the foot lifts and moves to where the
//                   animation has it over STEP_TIME (one foot at a time), so turning on the spot is a few planted steps
//                   instead of the feet spinning under the body. Corrections are bounded (MAX_REACH) and fade in / out.
//                   Slopes: with a ground probe (setGroundProbe) each planted foot sits on the ground under it and the
//                   pelvis drops (bounded) for the lower foot; without one the ground is the feet's plane.
//   jump phases     in the air the feet follow the vertical phase: a short extension right after take-off, a tuck at
//                   the apex, a reach for the ground on the way down (none while crouched: a steady tuck instead).
//   landings        a landing where the player stays down: the pelvis sinks with the feet planted (knees and ankles
//                   bend), by how hard it was (landStrength), from zero after the ground grace. A hard contact the
//                   player jumps straight out of (a bhop off a drop): a quick rebound, the legs compress for ~0.1 s.
//   idle            after a moment standing still, a slow weight shift from foot to foot (seeded per model).
//   climb / swim    on a ladder (PlayerPose.ladder) the feet step with the climb instead of the hop phases; swimming
//                   (PlayerPose.water 2+) a slow, small kick. Without those flags the layer only notices motion that
//                   isn't ballistic (airborne, vertical speed nearly constant: a ladder, water, a push lift) and then
//                   leaves out the jump phases ("float"); it never guesses climbing or swimming from motion (push lifts
//                   are common in bhop maps and look the same).
//
// Everything is smoothed exactly in dt (exponentials, envelopes on the visual clock), so 60 and 240 fps agree; the
// layer resets on snap(). Reduced motion scales the idle shift, the jump phases and the rebound (feel.ts motionScale).

import { concat, type Rig } from "./rig";
import { motionScale } from "../../viewmodel/feel";

/** Planting fades in below this horizontal speed (u/s) and is full below PLANT_FULL. */
export const PLANT_SPEED = 200;
const PLANT_FULL = 110;
/** A foot locks only while the animation moves it under this (u/s) + 0.7 x the body's speed: its stance, not its swing. */
const STILL = 40;
/** A locked foot steps when the animation's foot is this far from it (units) or turned this far (deg). */
export const STEP_DIST = 7;
export const STEP_YAW = 26;
/** A step's duration (s) and lift (units). */
const STEP_TIME = 0.2;
const STEP_LIFT = 2.6;
/** A lock further than this from the animated foot is let go (never pull a leg further). */
export const MAX_REACH = 12;
/** Pelvis drop (units) at full landing strength, and the hard rebound's leg compression at full hardness. */
export const LAND_DROP = 4.2;
const REBOUND = 5;
/** Most the pelvis may move for planting / slopes (units). */
const MAX_PELVIS = 6;
/** The floating detector measures acceleration over at least this long (s): longer than a tick. */
const ACC_SPAN = 0.04;
/** Ground contact needed to count as standing (s; one bhop tick never is) and the landing gate (airborne at least). */
const GRACE = 0.025;
const MIN_AIR = 0.2;
/** The ankle's height above the ground in the standing pose (bind pose: 40.11 - 18.56 - 17.19). */
export const ANKLE = 4.35;

const D2R = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth01 = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};
const toward = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
/** Envelope that starts flat from zero, peaks (1) at T and eases out by ~4 T. */
const env = (t: number, T: number) => {
  const x = t / T;
  return x <= 0 || x > 8 ? 0 : x * x * Math.exp(2 * (1 - x));
};
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Landing strength 0..1 (as studio/animstate.ts landStrength): a plain jump landed and stopped ~0.35, a drop more. */
export function landStrength(vz: number): number {
  const over = -vz - 150;
  return over > 0 ? 1 - Math.exp(-over / 350) : 0;
}
/** Hardness of a contact for the rebound: nothing for ordinary hops, from 400 u/s, full by ~1100. */
export function hardness(vz: number): number {
  return smooth01((-vz - 400) / 700);
}

/** Ground height (Source z) under a world point, or null (no ground within reach). */
export type GroundProbe = (x: number, y: number, z: number) => number | null;

const PROBE_FROM = new Float64Array(3), PROBE_TO = new Float64Array(3);
/** A ground probe from a line trace (fraction of from -> to that is clear, e.g. core traceRay): 48 units down. */
export function probeFromTrace(trace: (from: ArrayLike<number>, to: ArrayLike<number>) => number): GroundProbe {
  return (x, y, z) => {
    (PROBE_FROM[0] = PROBE_TO[0] = x), (PROBE_FROM[1] = PROBE_TO[1] = y), (PROBE_FROM[2] = z), (PROBE_TO[2] = z - 48);
    const f = trace(PROBE_FROM, PROBE_TO);
    return f < 1 ? z - 48 * f : null;
  };
}

export interface LegInput {
  dt: number;
  snap: boolean;
  grounded: boolean;
  crouched: boolean;
  /** Velocity, Source u/s. */
  vel: ArrayLike<number>;
  /** Feet origin, Source world. */
  pos: ArrayLike<number>;
  /** The model's yaw (feet yaw, deg) and bank about the hips (deg). */
  yaw: number;
  bank: number;
  /** Bank pivot height above the feet (units). */
  bankHip: number;
  /** Visual clock (s): the idle shift's phase. */
  time: number;
  /** On a ladder / water level (2+ = swimming), when the source knows; else detected from the motion. */
  ladder?: boolean;
  water?: number;
}

interface Foot {
  thigh: number;
  calf: number;
  foot: number;
  toe: number;
  locked: boolean;
  /** Lock: world position (Source) and the model yaw when it locked. */
  lx: number;
  ly: number;
  lz: number;
  lyaw: number;
  /** Step in progress: time (s, < 0 = none), from (world) and yaw from. */
  stepT: number;
  sx: number;
  sy: number;
  sz: number;
  syaw: number;
  /** The planting correction's weight (eased). */
  w: number;
  /** The animated ankle's world position at the last frame (its stance test), and whether that's known. */
  px: number;
  py: number;
  hasP: boolean;
}

/** Scratch (no allocation per frame). */
const P = new Float64Array(3), Q = new Float64Array(3), R = new Float64Array(3), U = new Float64Array(3), V = new Float64Array(3);
const M = new Float32Array(12), TMP = new Float32Array(12);
const FOOT0 = new Float32Array(12), TOE0 = new Float32Array(12);
const HJ = new Float64Array(3), KJ = new Float64Array(3), FJ = new Float64Array(3);

export class LegLayer {
  /** Debug / tests: this frame's pelvis offset (model z, units), planting weight and how the body is moving. */
  pelvisDrop = 0;
  plant = 0;
  mode: "ground" | "air" | "float" | "climb" | "swim" = "ground";
  /** Debug / tests: steps taken since the last reset. */
  steps = 0;
  /** Debug / tests: the feet's world positions after the layer (Source), left then right. */
  readonly feetWorld = new Float64Array(6);

  private feet: Foot[];
  private pelvis: number;
  private legBones: number[][];
  private all: number;
  private probe: GroundProbe | null = null;
  // Contact bookkeeping (frame-rate independent: times, not frame counts, apart from the 2-frame bhop guard).
  private groundTime = 0;
  private groundFrames = 0;
  private contactT = 0;
  private airTime = 0;
  private airVz = 0;
  /** The floating detector's reference vertical speed and its age (s). */
  private accVz = 0;
  private accAge = 0;
  private landed = true;
  private landT = 1e9;
  private landK = 0;
  private rebT = 1e9;
  private rebK = 0;
  private airW = 0;
  private floatW = 0;
  private plantW = 0;
  private idleT = 0;
  private climb = 0;
  private seed: number;

  constructor(private r: Rig, seed = 0) {
    const leg = (s: "L" | "R"): Foot => ({
      thigh: r.index(`ValveBiped.Bip01_${s}_Thigh`),
      calf: r.index(`ValveBiped.Bip01_${s}_Calf`),
      foot: r.index(`ValveBiped.Bip01_${s}_Foot`),
      toe: r.index(`ValveBiped.Bip01_${s}_Toe0`),
      locked: false,
      lx: 0, ly: 0, lz: 0, lyaw: 0,
      stepT: -1, sx: 0, sy: 0, sz: 0, syaw: 0,
      w: 0, px: 0, py: 0, hasP: false,
    });
    this.feet = [leg("L"), leg("R")];
    this.pelvis = r.index("ValveBiped.Bip01_Pelvis");
    this.legBones = this.feet.map((f) => [f.thigh, f.calf, f.foot, f.toe].filter((i) => i >= 0));
    this.all = r.names.length;
    this.seed = seed;
  }

  /** Ground under the feet for slopes (null: the feet's plane). */
  setGroundProbe(p: GroundProbe | null): void {
    this.probe = p;
  }

  reset(): void {
    for (const f of this.feet) (f.locked = false), (f.stepT = -1), (f.w = 0), (f.hasP = false);
    this.steps = 0;
    this.groundTime = this.contactT = this.airTime = this.idleT = this.climb = 0;
    this.groundFrames = 0;
    this.landed = true;
    this.landT = this.rebT = 1e9;
    this.landK = this.rebK = this.airW = this.floatW = this.plantW = this.accAge = 0;
    this.pelvisDrop = this.plant = 0;
  }

  /** Applies the layer to the skinning matrices S (model space, Source axes; the rig's bones). */
  apply(S: Float32Array, s: LegInput): void {
    const dt = s.snap ? 0 : s.dt;
    if (s.snap) {
      this.reset();
      // A snap onto the ground counts as standing already (not as just touching down).
      if (s.grounded) (this.groundFrames = 1), (this.contactT = GRACE), (this.landed = true);
    }
    const vz = s.vel[2];
    const speed = Math.hypot(s.vel[0], s.vel[1]);
    const motion = motionScale();

    // --- Contact bookkeeping (as studio/animstate.ts): a landing needs the grace over two grounded frames.
    this.contactT = s.grounded && this.groundFrames > 0 ? this.contactT + dt : s.grounded && s.snap ? this.contactT : 0;
    this.groundFrames = s.grounded ? this.groundFrames + 1 : 0;
    this.groundTime = s.grounded ? this.groundTime + dt : 0;
    this.landT += dt;
    this.rebT += dt;
    const stable = s.grounded && this.groundFrames >= 2 && this.contactT >= GRACE - 1e-6;
    if (!s.grounded) {
      // Airborne without gravity (a ladder, water): vz barely changes and isn't falling fast. Measured over at least
      // ACC_SPAN (velocity is often constant within a tick, so per-frame changes at 240 fps would read as no gravity).
      this.accAge += dt;
      if (this.accAge >= ACC_SPAN) {
        const acc = Math.abs(vz - this.accVz) / this.accAge;
        const floating = acc < 60 && Math.abs(vz) < 260;
        this.floatW = toward(this.floatW, floating ? 1 : 0, floating ? 5 : 12, this.accAge);
        this.accVz = vz;
        this.accAge = 0;
      }
      this.airTime += dt;
      this.airVz = vz;
      this.landed = false;
    } else {
      if (this.groundFrames === 1 && this.airTime >= MIN_AIR) {
        // Touchdown: a hard one rebounds at once (also when the player jumps straight out of it).
        this.rebK = hardness(this.airVz) * motion;
        this.rebT = 0;
      }
      if (!this.landed && stable) {
        this.landed = true;
        if (this.airTime >= MIN_AIR) (this.landT = this.contactT - GRACE), (this.landK = landStrength(this.airVz));
        this.airTime = 0;
      }
      this.floatW = toward(this.floatW, 0, 12, dt);
      this.accVz = vz;
      this.accAge = 0;
    }
    const climbing = s.ladder === true;
    const swimming = !climbing && (s.water ?? 0) >= 2;
    const floating = !climbing && !swimming && !s.grounded && this.floatW > 0.5;
    this.mode = climbing ? "climb" : swimming ? "swim" : floating ? "float" : s.grounded ? "ground" : "air";
    // Air weight: rises as soon as the feet leave, falls only once the player is really on the ground.
    // (Contact time, not frames: a bhop's one ground tick spans several frames at 240 fps and must not count.)
    this.airW = dt > 0 ? toward(this.airW, stable ? 0 : 1, stable ? 22 : 18, dt) : s.grounded ? 0 : 1;
    if (s.snap && !s.grounded) this.airTime = 1;

    // --- Pelvis: landing sink, rebound, idle weight shift.
    let dz = 0, dy = 0;
    // A jump out of a landing lets the sink go quickly (no snap).
    if (!s.grounded) this.landK *= Math.exp(-30 * dt);
    const sink = LAND_DROP * this.landK * env(this.landT, 0.09) * (s.crouched ? 0.4 : 1);
    const reb = REBOUND * this.rebK * env(this.rebT, 0.045);
    dz -= sink + (s.grounded ? reb * 0.5 : reb * 0.35);
    const idle = s.grounded && speed < 5 && !climbing;
    this.idleT = idle ? this.idleT + dt : 0;
    const shiftW = smooth01((this.idleT - 1.2) / 1.5) * motion;
    if (shiftW > 0) {
      // Two incommensurate periods with a per-model phase: never a visible loop, never in step with another bunny.
      const ph = this.seed * 6.283;
      dy = shiftW * (0.75 * Math.sin(s.time * 1.13 + ph) + 0.25 * Math.sin(s.time * 0.47 + ph * 1.7));
      dz -= shiftW * 0.35 * Math.abs(Math.sin(s.time * 1.13 + ph));
    }
    dz = clamp(dz, -MAX_PELVIS, MAX_PELVIS);
    this.pelvisDrop = dz;
    if (dz !== 0 || dy !== 0) for (let i = 0; i < this.all; i++) (S[i * 12 + 7] += dy), (S[i * 12 + 11] += dz);

    // --- Feet targets (model space) per foot.
    const plantT = stable && !climbing && !swimming ? smooth01((PLANT_SPEED - speed) / (PLANT_SPEED - PLANT_FULL)) : 0;
    this.plantW = dt > 0 ? toward(this.plantW, plantT, plantT > this.plantW ? 10 : 16, dt) : plantT;
    this.plant = this.plantW;
    if (!this.plantW && this.feet.some((f) => f.locked || f.stepT >= 0)) for (const f of this.feet) (f.locked = false), (f.stepT = -1);
    this.climb += dt * Math.abs(vz);
    const cy = Math.cos(s.yaw * D2R), sy = Math.sin(s.yaw * D2R);
    const cb = Math.cos(s.bank * D2R), sb = Math.sin(s.bank * D2R);
    const h = s.bankHip;
    for (let k = 0; k < 2; k++) {
      const f = this.feet[k];
      if (f.foot < 0 || f.calf < 0 || f.thigh < 0) continue;
      this.joint(S, f.foot, P); // animated ankle (model)
      let tx = P[0], ty = P[1], tz = P[2], yawFix = 0;
      // On the ground the pelvis sink and shift move the body, not the feet: they stay where the animation put them.
      const onGround = 1 - this.airW;
      tz -= dz * onGround;
      ty -= dy * onGround;

      // In the air: jump phases (or the climb / swim motion).
      const a = this.airW * (1 - this.plantW);
      if (a > 0.001) {
        let ox = 0, oz = 0;
        if (climbing) {
          // Feet step alternately with the climb: one lift per 24 units climbed.
          const c = (this.climb / 24 + k * 0.5) % 1;
          oz = 5 * Math.max(0, Math.sin(c * Math.PI * 2));
          ox = 1.5;
        } else if (swimming) {
          oz = 1.6 * Math.sin(s.time * 3.1 + k * Math.PI);
          ox = -2;
        } else if (s.crouched) {
          oz = 1.5; // a steady tuck (the crouch already pulls the legs up)
        } else if (this.mode === "float") {
          oz = 0; // not ballistic: no jump phases
        } else {
          const rise = smooth01(vz / 280), apex = 1 - smooth01(Math.abs(vz) / 260), fall = smooth01(-vz / 420);
          // Take-off: extend down and back; apex: tuck up and forward; descent: reach down and forward for the ground.
          oz = (-2.2 * rise * (1 - apex) + 4.5 * apex - 3 * fall * (1 - apex)) * motion;
          ox = (-1.5 * rise * (1 - apex) + 1.8 * apex + 2.2 * fall) * motion;
          // The hard rebound compresses the legs right after the contact (the player is already airborne again).
          oz += reb * 0.65;
        }
        tx += ox * a;
        tz += oz * a;
      }

      // On the ground, slow: planting.
      if (this.plantW > 0.001) {
        // Model -> world for the animated ankle (yaw, then the bank about the hips).
        const wx = this.toWorldX(P, s, cy, sy, cb, sb, h), wy = this.toWorldY(P, s, cy, sy, cb, sb, h);
        const groundHere = this.ground(wx, wy, s);
        // In stance: down, and the animation has the foot nearly still in the world (a walk's planted foot), or the
        // body is barely moving at all.
        // (A planted foot in a gait that matches the speed is still; a skating one moves a little; a swinging one moves
        // at about twice the body's speed.)
        const still = !f.hasP || dt <= 0 || Math.hypot(wx - f.px, wy - f.py) / dt < STILL + 0.7 * speed || speed < 20;
        const contact = P[2] - ANKLE < 1.4 + Math.max(0, -dz) && still;
        if (f.stepT >= 0) {
          f.stepT += dt;
          if (f.stepT >= STEP_TIME) {
            f.stepT = -1;
            f.locked = true;
            (f.lx = wx), (f.ly = wy), (f.lz = groundHere), (f.lyaw = s.yaw);
          }
        } else if (!f.locked && contact) {
          f.locked = true;
          (f.lx = wx), (f.ly = wy), (f.lz = groundHere), (f.lyaw = s.yaw);
        } else if (f.locked && P[2] - ANKLE > 3 + Math.max(0, -dz)) f.locked = false; // the animation lifts it: let go
        let gx = wx, gy = wy, gz = groundHere, gyaw = s.yaw, lift = 0;
        if (f.locked) {
          const dist = Math.hypot(wx - f.lx, wy - f.ly), turn = Math.abs(wrap180(s.yaw - f.lyaw));
          const other = this.feet[1 - k];
          if ((dist > STEP_DIST || turn > STEP_YAW) && other.stepT < 0) {
            // Step: from the lock to where the animation has the foot, lifting on the way.
            f.locked = false;
            f.stepT = 0;
            this.steps++;
            (f.sx = f.lx), (f.sy = f.ly), (f.sz = f.lz), (f.syaw = f.lyaw);
          } else if (dist > MAX_REACH) f.locked = false;
          else (gx = f.lx), (gy = f.ly), (gz = f.lz), (gyaw = f.lyaw);
        }
        if (f.stepT >= 0) {
          const e = smooth01(f.stepT / STEP_TIME);
          gx = f.sx + (wx - f.sx) * e;
          gy = f.sy + (wy - f.sy) * e;
          gz = f.sz + (groundHere - f.sz) * e;
          gyaw = f.syaw + wrap180(s.yaw - f.syaw) * e;
          lift = STEP_LIFT * Math.sin(Math.PI * e);
        }
        // World target -> model (undo the bank about the hips, then the yaw).
        this.toModel(gx, gy, gz + ANKLE + lift, s, cy, sy, cb, sb, h, Q);
        // Ground height of the animated foot above its plane is kept (a heel lifting in the animation stays lifted).
        const animLift = Math.max(0, P[2] - ANKLE);
        const w = this.plantW;
        tx += (Q[0] - tx) * w;
        ty += (Q[1] - ty) * w;
        tz += (Q[2] + (f.locked ? Math.min(animLift, 0.6) : animLift) - tz) * w;
        yawFix = wrap180(gyaw - s.yaw) * w;
        f.w = w;
        (f.px = wx), (f.py = wy), (f.hasP = true);
      } else (f.w = 0), (f.hasP = false);
      this.solveLeg(S, k, tx, ty, tz, yawFix);
      this.joint(S, f.foot, R);
      this.feetWorld[k * 3] = this.toWorldX(R, s, cy, sy, cb, sb, h);
      this.feetWorld[k * 3 + 1] = this.toWorldY(R, s, cy, sy, cb, sb, h);
      this.feetWorld[k * 3 + 2] = s.pos[2] + R[2];
    }
  }

  // --- Helpers --------------------------------------------------------------------------------

  /** Ground z (Source world) at (x, y): the probe's, else the feet's plane. Relative to the feet origin's z. */
  private ground(x: number, y: number, s: LegInput): number {
    if (this.probe) {
      const g = this.probe(x, y, s.pos[2] + 24);
      // Within reach of the feet only (a ledge edge or a gap leaves the foot at the plane).
      if (g !== null && Math.abs(g - s.pos[2]) < 14) return g - s.pos[2];
    }
    return 0;
  }

  private toWorldX(p: ArrayLike<number>, s: LegInput, cy: number, sy: number, cb: number, sb: number, h: number): number {
    // Bank (about x, pivot at hip height) then yaw (about z).
    const by = p[1] * cb - (p[2] - h) * sb;
    return s.pos[0] + p[0] * cy - by * sy;
  }

  private toWorldY(p: ArrayLike<number>, s: LegInput, cy: number, sy: number, cb: number, sb: number, h: number): number {
    const by = p[1] * cb - (p[2] - h) * sb;
    return s.pos[1] + p[0] * sy + by * cy;
  }

  /** World (x, y) + a z relative to the feet origin -> model space, into out. */
  private toModel(x: number, y: number, zRel: number, s: LegInput, cy: number, sy: number, cb: number, sb: number, h: number, out: Float64Array): void {
    const lx = x - s.pos[0], ly = y - s.pos[1];
    const mx = lx * cy + ly * sy, myb = -lx * sy + ly * cy;
    // Undo the bank: (y, z) were rotated about x by b around (z = h).
    const zb = zRel - h;
    out[0] = mx;
    out[1] = myb * cb + zb * sb;
    out[2] = -myb * sb + zb * cb + h;
  }

  /** A bone's joint position (its bind origin through its skinning matrix), model space. */
  private joint(S: Float32Array, i: number, out: Float64Array): void {
    const b = this.r.bind, bo = i * 12, o = i * 12;
    const x = b[bo + 3], y = b[bo + 7], z = b[bo + 11];
    out[0] = S[o] * x + S[o + 1] * y + S[o + 2] * z + S[o + 3];
    out[1] = S[o + 4] * x + S[o + 5] * y + S[o + 6] * z + S[o + 7];
    out[2] = S[o + 8] * x + S[o + 9] * y + S[o + 10] * z + S[o + 11];
  }

  /**
   * Two-bone IK for leg k: moves the ankle to (tx, ty, tz) (clamped to the leg's reach) by turning the thigh about the
   * hip and the calf about the knee in the leg's own plane (the knee keeps its side); the foot and toe keep the
   * animation's orientation, turned by `yaw` degrees about the vertical (a planted foot's lock).
   */
  private solveLeg(S: Float32Array, k: number, tx: number, ty: number, tz: number, yaw: number): void {
    const f = this.feet[k];
    const H = HJ, K = KJ, F = FJ;
    this.joint(S, f.thigh, H);
    this.joint(S, f.calf, K);
    this.joint(S, f.foot, F);
    if (Math.abs(tx - F[0]) + Math.abs(ty - F[1]) + Math.abs(tz - F[2]) < 1e-4 && Math.abs(yaw) < 1e-4) return;
    FOOT0.set(S.subarray(f.foot * 12, f.foot * 12 + 12));
    const toe = f.toe >= 0;
    if (toe) TOE0.set(S.subarray(f.toe * 12, f.toe * 12 + 12));
    const L1 = Math.hypot(K[0] - H[0], K[1] - H[1], K[2] - H[2]);
    const L2 = Math.hypot(F[0] - K[0], F[1] - K[1], F[2] - K[2]);
    let dx = tx - H[0], dy = ty - H[1], dz = tz - H[2];
    let d = Math.hypot(dx, dy, dz);
    const dc = clamp(d, Math.abs(L1 - L2) + 0.5, L1 + L2 - 0.05);
    if (d < 1e-6) return;
    (dx /= d), (dy /= d), (dz /= d);
    d = dc;
    // Pole: the current knee's offset from the hip -> target line.
    let px = K[0] - H[0], py = K[1] - H[1], pz = K[2] - H[2];
    const along = px * dx + py * dy + pz * dz;
    (px -= along * dx), (py -= along * dy), (pz -= along * dz);
    let pl = Math.hypot(px, py, pz);
    if (pl < 1e-4) (px = 1), (py = 0), (pz = 0), (pl = 1); // straight leg: knees forward (+x)
    (px /= pl), (py /= pl), (pz /= pl);
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const hk = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    const kx = H[0] + dx * a + px * hk, ky = H[1] + dy * a + py * hk, kz = H[2] + dz * a + pz * hk;
    // Thigh: rotate (K - H) onto (K' - H) about the hip; the calf, foot and toe come along.
    rotation(K[0] - H[0], K[1] - H[1], K[2] - H[2], kx - H[0], ky - H[1], kz - H[2], H, M);
    for (const b of this.legBones[k]) premul(M, S, b);
    // Calf: rotate the (moved) ankle onto the target about the new knee.
    this.joint(S, f.foot, F);
    const ex = H[0] + dx * d, ey = H[1] + dy * d, ez = H[2] + dz * d;
    K[0] = kx, K[1] = ky, K[2] = kz;
    rotation(F[0] - kx, F[1] - ky, F[2] - kz, ex - kx, ey - ky, ez - kz, K, M);
    for (const b of this.legBones[k]) if (b !== f.thigh) premul(M, S, b);
    // Foot and toe: the animation's orientation, turned about the vertical through the ankle, at the new ankle.
    this.joint(S, f.foot, F);
    this.jointOf(FOOT0, f.foot, U);
    yawAbout(yaw * D2R, U, F, M);
    concat(M, 0, FOOT0, 0, S, f.foot * 12);
    if (toe) concat(M, 0, TOE0, 0, S, f.toe * 12);
  }

  private jointOf(Sb: Float32Array, i: number, out: Float64Array): void {
    const b = this.r.bind, bo = i * 12;
    const x = b[bo + 3], y = b[bo + 7], z = b[bo + 11];
    out[0] = Sb[0] * x + Sb[1] * y + Sb[2] * z + Sb[3];
    out[1] = Sb[4] * x + Sb[5] * y + Sb[6] * z + Sb[7];
    out[2] = Sb[8] * x + Sb[9] * y + Sb[10] * z + Sb[11];
  }
}

/** S_i = M * S_i (M a 3x4 rigid transform). */
function premul(m: Float32Array, S: Float32Array, i: number): void {
  concat(m, 0, S, i * 12, TMP, 0);
  S.set(TMP, i * 12);
}

/** The shortest-arc rotation taking direction a onto direction b, about `pivot`, as a 3x4 into out. */
function rotation(ax: number, ay: number, az: number, bx: number, by: number, bz: number, pivot: ArrayLike<number>, out: Float32Array): void {
  const la = Math.hypot(ax, ay, az) || 1, lb = Math.hypot(bx, by, bz) || 1;
  (ax /= la), (ay /= la), (az /= la), (bx /= lb), (by /= lb), (bz /= lb);
  let x = ay * bz - az * by, y = az * bx - ax * bz, z = ax * by - ay * bx;
  const s = Math.hypot(x, y, z), c = clamp(ax * bx + ay * by + az * bz, -1, 1);
  if (s < 1e-9) {
    out.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    return;
  }
  (x /= s), (y /= s), (z /= s);
  const t = 1 - c;
  const r00 = t * x * x + c, r01 = t * x * y - s * z, r02 = t * x * z + s * y;
  const r10 = t * x * y + s * z, r11 = t * y * y + c, r12 = t * y * z - s * x;
  const r20 = t * x * z - s * y, r21 = t * y * z + s * x, r22 = t * z * z + c;
  const px = pivot[0], py = pivot[1], pz = pivot[2];
  out[0] = r00, out[1] = r01, out[2] = r02, out[3] = px - (r00 * px + r01 * py + r02 * pz);
  out[4] = r10, out[5] = r11, out[6] = r12, out[7] = py - (r10 * px + r11 * py + r12 * pz);
  out[8] = r20, out[9] = r21, out[10] = r22, out[11] = pz - (r20 * px + r21 * py + r22 * pz);
}

/** A turn of `a` radians about the vertical through `from`, then a move from `from` to `to`, as a 3x4 into out. */
function yawAbout(a: number, from: ArrayLike<number>, to: ArrayLike<number>, out: Float32Array): void {
  const c = Math.cos(a), s = Math.sin(a);
  out[0] = c, out[1] = -s, out[2] = 0, out[3] = to[0] - (c * from[0] - s * from[1]);
  out[4] = s, out[5] = c, out[6] = 0, out[7] = to[1] - (s * from[0] + c * from[1]);
  out[8] = 0, out[9] = 0, out[10] = 1, out[11] = to[2] - from[2];
}
