// The Supporter bayonets' inspects (knives/thornback.ts, knives/thistle.ts). Original motion, authored per bone with
// the kit like the other sets; the reference was only the general feel of knife flourishes (a toss and catch, a
// finger spin).
//
//   Thornback   Thorn Toss  -> Double Toss
//     Thorn Toss   present, a turn of the forearm to look down the thorn teeth, a dip, then the knife is tossed up off
//                  the palm and tumbles once end over end in its own plane (about its balance point), the hand rises a
//                  little to meet it, a heavy catch, a roll to show the other face, settle.
//     Double Toss  straight into a higher toss, two tumbles, the catch rolls through into a flourish.
//   Thistle     Pinwheel    -> Backspin
//     Pinwheel     present, the fingers let go, the index points and the knife hops onto it (the crook under the
//                  guard against the finger), the other fingers tuck away and it spins round the finger three times
//                  like a pinwheel (hold F: it keeps spinning), hops back into the fist, a roll to admire, settle.
//     Backspin     two fast turns round the finger, a hitch, one turn back the other way, into the fist, a flick.
//
// Knife motions are in hand coordinates (kit.ts Xf: AX knuckles, W_ index side, N palm normal) or about the posed
// index finger; the knife's own axes and pivots are read from the posed Knife_Handle each frame, so they follow
// whatever the hold layer did.

import { concat } from "../../player/bunny/rig";
import { rotAbout } from "../math";
import { hands, openFinger, openThumb, presented, PRESENT, squeeze } from "./common";
import { blendPose, bump, col, D2R, dot, E, hop, norm, pos, spline, sub, track, Xf, type V3 } from "./kit";
import { inspectSet, type InspectClip, type InspectCtx } from "./types";

const X = new Xf();

function arm(W: Float32Array, ctx: InspectCtx, p: number, roll: number, pitch: number, yaw: number, shift: V3, flex: number, dev: number): void {
  const s = PRESENT.shift;
  ctx.arm.arm(W, PRESENT.roll * p + roll, PRESENT.pitch * p + pitch, PRESENT.yaw * p + yaw, [s[0] * p + shift[0], s[1] * p + shift[1], s[2] * p + shift[2]]);
  ctx.arm.wrist(W, flex, dev);
}

/** The held knife's axes (x through the blade, z along it) and a point on its length, in hand coordinates. */
function knifeAxes(W: Float32Array, ctx: InspectCtx, zPivot: number): { x: V3; z: V3; pivot: V3 } {
  const a = ctx.arm, f = a.frame(W);
  const toH = (v: V3): V3 => [dot(v, f.ax), dot(v, f.w), dot(v, f.n)];
  const z = col(W, a.kb, 2), x = col(W, a.kb, 0);
  const o = pos(W, a.kb);
  const pv: V3 = [o[0] + z[0] * zPivot, o[1] + z[1] * zPivot, o[2] + z[2] * zPivot];
  return { x: norm(toH(x)), z: norm(toH(z)), pivot: a.toHand(f, pv) };
}

const BALANCE = (ctx: InspectCtx) => ctx.knife?.pivots?.balance?.p[2] ?? 3;

// -------------------------------------------------------------------------------------------------
// Thornback

interface TossSpec {
  len: number;
  enter: number;
  exit: number;
  open: number;
  toss: number;
  catch: number;
  /** Flight: up the blade's line (apex, units) and out of the palm (peak, units). */
  height: number;
  out: number;
  turns: number;
}

/** A toss: dip, up off the palm (and a little up the blade's line), `turns` tumbles in the blade plane, catch. */
function tossClip(id: string, name: string, T: TossSpec, extra: (t: number) => { roll: number; pitch: number; yaw: number; shift: V3; flex: number; dev: number }): InspectClip {
  const fl = T.catch - T.toss;
  // One continuous tumble, launched with the toss (no hover before it starts) and done just before the catch.
  const tumble = track([
    [T.toss + 0.02, 0],
    [T.catch - 0.12, 360 * T.turns, E.lin],
  ]);
  return {
    id,
    name,
    len: T.len,
    enter: T.enter,
    exit: T.exit,
    open: T.open,
    free: [[T.toss, T.catch]],
    cues: [
      { t: T.toss, type: "flip" },
      { t: (T.toss + T.catch) / 2, type: "spin" },
      { t: T.catch, type: "catch" },
    ],
    apply(W, t, ctx) {
      const p = presented(t, T.enter, T.exit, T.len);
      const load = track([[T.toss - 0.24, 0], [T.toss - 0.06, 1, E.io], [T.toss + 0.04, -0.8, E.out], [T.toss + 0.3, 0, E.io]])(t);
      const dip = bump(t, T.catch - 0.01, T.catch + 0.45) * 1.5;
      const rise = Math.sin(Math.PI * Math.min(1, Math.max(0, (t - T.toss) / fl))) * 0.8;
      const ext = track([[T.toss, 0], [T.toss + 0.14, 1, E.out], [T.catch - 0.12, 1], [T.catch, 0, E.io]])(t);
      const e = extra(t);
      // (The hand sinks a little while the knife is up, so the toss stays in frame.)
      arm(W, ctx, p, e.roll, e.pitch + 6 * load - 14 * dip - 9 * rise, e.yaw, [e.shift[0], e.shift[1], e.shift[2] - 0.9 * load - 1.4 * dip - 1.4 * rise], e.flex + 14 * load + 20 * dip - 14 * ext, e.dev);
      hands(W, ctx, t, T.toss - 0.07, T.catch - 0.03);
      const up = hop(t, T.toss, T.catch, T.height);
      // A plain ballistic arc (rise, apex, fall into the catch).
      const out = hop(t, T.toss, T.catch, 1);
      const a = tumble(t);
      if (up || a) {
        const k = knifeAxes(W, ctx, BALANCE(ctx));
        // Tumble about the blade's own face normal through its balance point, then fly up off the palm.
        X.reset().rot(k.x, a, k.pivot).move([k.z[0] * up, k.z[1] * up, k.z[2] * up + out * T.out]);
        ctx.arm.knifeXf(W, X);
      }
    },
  };
}

const TT: TossSpec = { len: 3.15, enter: 0.34, exit: 2.55, open: 0.55, toss: 1.02, catch: 1.8, height: 2.4, out: 5, turns: 1 };
export const thornToss = tossClip("thorn-toss", "Thorn Toss", TT, (t) => {
  // Look down the teeth (the forearm turns the spine toward you), back; after the catch, roll to the other face.
  const look = track([[0.36, 0], [0.62, 1, E.io], [0.8, 1], [0.98, 0, E.io]])(t);
  const roll = track([[2.0, 0], [2.3, -115, E.whip], [2.45, -115], [2.7, 0, E.io]])(t);
  return { roll: -48 * look + roll, pitch: -2 * look, yaw: -8 * look, shift: [0, 0, -0.6 * look], flex: -6 * look, dev: 14 * look };
});

const DT: TossSpec = { len: 3.3, enter: 0.34, exit: 2.7, open: 9, toss: 0.62, catch: 1.62, height: 2.6, out: 6, turns: 2 };
export const doubleToss = tossClip("double-toss", "Double Toss", DT, (t) => {
  // The catch rolls on into a show of the other face with a flick of the wrist, back to the presented pose.
  const roll = track([[1.86, 0], [2.2, -130, E.whip], [2.42, -130], [2.75, 0, E.io]])(t);
  const flick = track([[1.86, 0], [2.08, 1, E.out], [2.3, 0, E.io]])(t);
  return { roll, pitch: 0, yaw: 0, shift: [0, 0, 0], flex: -10 * flick, dev: 12 * flick };
});

export const THORNBACK_INSPECTS = inspectSet("thornback", [thornToss, doubleToss]);

// -------------------------------------------------------------------------------------------------
// Thistle: a finger spin. The knife leaves the fist and settles with the crook under its guard against the index
// finger's middle segment (pointing forward: the axle); the other three fingers tuck into a fist behind the spin plane
// and the knife turns about the finger, its plane square to it, so the pinwheel faces you (you look along the forearm).

/** A tight fist (anatomical MCP / PIP / DIP, fingers.ts): the fingers tucked behind the spin plane. */
const FIST: V3 = [118, 108, 72];
/** The pointing index (the axle): straight out, a hint of bend. */
const POINT: V3 = [0, 4, 3];
/** Knife-local point that rides on the finger (KnifeDef.pivots.crook): under the guard, on the edge side. */
const CROOK = (ctx: InspectCtx): V3 => {
  const g = ctx.knife?.pivots?.crook?.p;
  return g ? [g[0], g[1], g[2]] : [0, -0.86, 1.0];
};

const T1 = new Float32Array(12), T2 = new Float32Array(12);
/** How high the knife lifts off the palm before it goes over onto the finger (units). */
const LIFT = 2.6;
/**
 * How much of the angle between the pointing finger and your line of sight the arm takes out while it spins (more
 * would bring the forearm in front of the camera).
 */
const AIM = 0.3;
let scratch = new Float32Array(0);

interface SpinSpec {
  len: number;
  enter: number;
  exit: number;
  open: number;
  /** Fingers let go here; the knife moves onto the finger over [release, on], spins, leaves it over [off, catch]. */
  release: number;
  on: number;
  off: number;
  catch: number;
  spin: (t: number) => number;
  loop?: [number, number];
  cues: InspectClip["cues"];
}

function fingerSpin(id: string, name: string, S: SpinSpec, extra: (t: number) => { roll: number; pitch: number; flex: number; dev: number }): InspectClip {
  /** 0 held .. 1 on the finger. */
  // Off the palm first (straight up out of the open fist), then over onto the finger; back the same way.
  const r8 = S.release + 0.06;
  const lift = track([
    [S.release, 0],
    [r8, LIFT, E.out],
    [S.on, 0, E.io],
    [S.off, 0],
    [S.off + 0.1, LIFT, E.io],
    [S.catch - 0.1, LIFT],
    [S.catch, 0, E.io],
  ]);
  const onto = track([
    [r8, 0],
    [S.on, 1, E.io],
    [S.off, 1],
    [S.off + 0.12, 0, E.io],
  ]);
  const point = track([[S.release - 0.08, 0], [S.release + 0.02, 1, E.out], [S.catch - 0.02, 1], [S.catch + 0.16, 0, E.io]]);
  const thumb = track([[S.release - 0.12, 0], [S.release - 0.02, 0.6, E.io], [S.catch + 0.04, 0.6], [S.catch + 0.24, 0, E.io]]);
  const tuck = track([[r8, 0], [r8 + 0.08, 1, E.out], [S.catch - 0.16, 1], [S.catch - 0.08, 0, E.io]]);
  const aimW = track([[S.release, 0], [S.on, 1, E.io], [S.off, 1], [S.catch, 0, E.io]]);
  return {
    id,
    name,
    len: S.len,
    enter: S.enter,
    exit: S.exit,
    open: S.open,
    loop: S.loop,
    free: [[S.release, S.catch]],
    cues: S.cues,
    apply(W, t, ctx) {
      const a = ctx.arm;
      const p = presented(t, S.enter, S.exit, S.len);
      const flick = bump(t, S.on - 0.04, S.on + 0.3);
      const dip = bump(t, S.catch - 0.02, S.catch + 0.42);
      const e = extra(t);
      arm(W, ctx, p, e.roll, e.pitch + 4 * flick - 9 * dip, 0, [0, 0, -0.7 * dip], e.flex - 10 * flick + 12 * dip, e.dev);
      // Fingers: all let go, the index points (the axle), the other three tuck into a fist once the knife is out of
      // the hand, open again to take it back and close on it (pinky first) with a squeeze; the thumb lifts off.
      const hf = a.frame(W);
      (["middle", "ring", "pinky"] as const).forEach((fg, i) => {
        const o0 = S.release - 0.1 + i * 0.012;
        const c0 = S.catch - 0.01 + (2 - i) * 0.012;
        const tk = tuck(t);
        if (tk > 0.001) return openFinger(ctx, W, hf, fg, tk, FIST);
        let k = 0;
        if (t >= o0 && t < r8) k = 0.85 * E.out((t - o0) / 0.07);
        else if (t >= S.catch - 0.08 && t < c0) k = 0.85;
        else if (t >= c0 && t < c0 + 0.16) k = 0.85 * (1 - squeeze((t - c0) / 0.16));
        if (k) openFinger(ctx, W, hf, fg, k, undefined, [0, 0, 0], 0, t >= c0);
      });
      const pt = point(t);
      if (pt > 0.001) openFinger(ctx, W, hf, "index", pt, POINT, [0, 0, 0], 0, t > S.catch);
      const th = thumb(t);
      if (th > 0.001) openThumb(ctx, W, hf, th, t > S.catch);
      // While it's on the finger, the arm turns to point the finger most of the way along your line of sight, so the
      // spin plane faces the camera instead of being seen edge-on.
      const aim = AIM * aimW(t);
      if (aim > 0.001) {
        const i1 = pos(W, a.fingers.index[1]), i2 = pos(W, a.fingers.index[2]);
        const A0 = norm(sub(i2, i1)), d = norm(i2);
        const ax: V3 = [A0[1] * d[2] - A0[2] * d[1], A0[2] * d[0] - A0[0] * d[2], A0[0] * d[1] - A0[1] * d[0]];
        const sn = Math.hypot(ax[0], ax[1], ax[2]);
        if (sn > 1e-4) {
          // Swung about the elbow, then moved back so the finger stays where it was on screen (turning it about the
          // finger instead brings the forearm round into the camera).
          rotAbout([ax[0] / sn, ax[1] / sn, ax[2] / sn], Math.atan2(sn, dot(A0, d)) * aim, pos(W, a.armBone), T1);
          const f1: V3 = [T1[0] * i2[0] + T1[1] * i2[1] + T1[2] * i2[2] + T1[3], T1[4] * i2[0] + T1[5] * i2[1] + T1[6] * i2[2] + T1[7], T1[8] * i2[0] + T1[9] * i2[1] + T1[10] * i2[2] + T1[11]];
          // (and a little further out and down, so the forearm doesn't loom over the spin and the tip stays in frame)
          T1[3] += i2[0] - f1[0] + 2.2 * aimW(t), T1[7] += i2[1] - f1[1], T1[11] += i2[2] - f1[2] - 0.6 * aimW(t);
          a.rigid(W, T1, a.all);
        }
      }
      // The knife: from the hold onto the finger (arcing off the palm on the way), then the spin about the finger.
      const u = onto(t), up = lift(t);
      const ang = S.spin(t);
      if (u <= 0 && !ang && !up) return;
      const idx = a.fingers.index;
      const j1 = pos(W, idx[1]), j2 = pos(W, idx[2]);
      const A = norm(sub(j2, j1));
      const F: V3 = [(j1[0] + j2[0]) / 2, (j1[1] + j2[1]) / 2, (j1[2] + j2[2]) / 2];
      const kb = a.kb * 12;
      const kz = col(W, a.kb, 2);
      // On the finger: the flat square to it (x along the finger), the blade keeping its heading, the crook on it.
      // (Which way the flat faces is picked so the grip ends on the palm side of the finger: it comes down onto the
      // finger from above the palm instead of through it.)
      const d = dot(kz, A);
      const zt = norm([kz[0] - A[0] * d, kz[1] - A[1] * d, kz[2] - A[2] * d]);
      const y0: V3 = [zt[1] * A[2] - zt[2] * A[1], zt[2] * A[0] - zt[0] * A[2], zt[0] * A[1] - zt[1] * A[0]];
      const xs = dot(y0, hf.n) * -(CROOK(ctx)[1] || -1) < 0 ? -1 : 1;
      const xt: V3 = [A[0] * xs, A[1] * xs, A[2] * xs];
      const yt: V3 = [y0[0] * xs, y0[1] * xs, y0[2] * xs];
      const C = CROOK(ctx);
      const o: V3 = [0, 1, 2].map((i) => F[i] - (xt[i] * C[0] + yt[i] * C[1] + zt[i] * C[2])) as V3;
      if (scratch.length < W.length) scratch = new Float32Array(W.length);
      scratch.set([xt[0], yt[0], zt[0], o[0], xt[1], yt[1], zt[1], o[1], xt[2], yt[2], zt[2], o[2]], kb);
      if (u > 0) blendPose(W, scratch, u, [a.kb]);
      W[kb + 3] += hf.n[0] * up, W[kb + 7] += hf.n[1] * up, W[kb + 11] += hf.n[2] * up;
      if (ang) {
        rotAbout(A, ang * D2R, F, T1);
        concat(T1, 0, W, kb, T2, 0);
        W.set(T2, kb);
      }
      for (const i of a.knife) if (i !== a.kb) W.copyWithin(i * 12, kb, kb + 12);
    },
  };
}

const PW_RATE = 1400;
export const pinwheel = fingerSpin(
  "pinwheel",
  "Pinwheel",
  {
    len: 3.05,
    enter: 0.32,
    exit: 2.5,
    open: 0.5,
    release: 0.42,
    on: 0.62,
    off: 1.42,
    catch: 1.7,
    spin: spline([
      [0.62, 0, 0],
      [0.7, -56, -PW_RATE],
      [1.22, -56 - PW_RATE * 0.52, -PW_RATE],
      [1.38, -1080, 0],
    ]),
    // One full turn at the cruise rate.
    loop: [0.77, 0.77 + 360 / PW_RATE],
    cues: [
      { t: 0.44, type: "flip" },
      { t: 0.82, type: "spin" },
      { t: 1.12, type: "spin" },
      { t: 1.7, type: "catch" },
    ],
  },
  (t) => {
    const admire = track([[1.92, 0], [2.17, 1, E.whip], [2.32, 1], [2.62, 0, E.io]])(t);
    return { roll: -90 * admire, pitch: 0, flex: 0, dev: 8 * admire };
  },
);

export const backspin = fingerSpin(
  "backspin",
  "Backspin",
  {
    len: 3.1,
    enter: 0.32,
    exit: 2.55,
    open: 9,
    release: 0.4,
    on: 0.6,
    off: 1.7,
    catch: 1.98,
    // Two fast turns, a clear stop (the flat held to you for ~0.14 s), then one slower turn back.
    spin: spline([
      [0.6, 0, 0],
      [0.68, -70, -1650],
      [1.0, -598, -1650],
      [1.1, -720, 0],
      [1.24, -720, 0],
      [1.34, -660, 1000],
      [1.58, -380, 500],
      [1.68, -360, 0],
    ]),
    cues: [
      { t: 0.42, type: "flip" },
      { t: 0.82, type: "spin" },
      { t: 1.42, type: "spin" },
      { t: 1.98, type: "catch" },
    ],
  },
  (t) => {
    // A real flick after the catch: snap (2.1 - 2.2), a rebound by 2.34, settled by 2.52.
    const flick = track([[2.1, 0], [2.2, 1, E.out], [2.34, -0.35, E.io], [2.52, 0, E.io]])(t);
    return { roll: 22 * flick, pitch: 6 * flick, flex: -30 * flick, dev: 16 * flick };
  },
);

export const THISTLE_INSPECTS = inspectSet("thistle", [pinwheel, backspin]);
