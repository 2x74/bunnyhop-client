// Karrotbit inspects: Ring Spin -> Double Ring Spin -> Triple Spin + reverse catch (tap F, re-press to chain; hold F
// during a spin and it keeps spinning, Skeleton-style, up to the loop cap). Original motion; CS2's karambit inspect
// (spins about the index finger through the ring) was only a reference for the idea (research/COSMETICS-PLAN.md §1.1).
//
// The index finger stays through the ring and is the pivot: the knife turns about the ring's hole axis through the
// ring centre (knives/karrotbit.ts pivots.ring, knife-local). The middle, ring and little fingers let go of the handle
// before it swings out of the fist (the thumb lifts with them), stay open while it turns, and close on the handle as it
// comes back round (the catch), with a squeeze. The wrist flicks the spin off and dips on the catch. Every trick ends
// turned to face you (InspectClip.show -> the hold's KB_SHOW pose), then settles back to the idle.

import type { KnifeDef } from "../knives/types";
import { openFinger, presented } from "./common";
import { bump, D2R, E, spline, track, type V3 } from "./kit";
import { concat, invert34 } from "../../player/bunny/rig";
import { rotAbout } from "../math";
import { inspectSet, type InspectClip, type InspectCtx } from "./types";
import type { Cue } from "./combo";

/** Ring pivot (knife-local) when the knife doesn't say: the Karrotbit's ring centre and hole axis. */
const RING_FALLBACK = { p: [0, 0, -1.42] as V3, axis: [1, 0, 0] as V3 };

const T = new Float32Array(12), M = new Float32Array(12), Ii = new Float32Array(12), REL = new Float32Array(12), K = new Float32Array(12);
/** A tight fist (anatomical MCP / PIP / DIP, fingers.ts): the fingers tucked out of the ring's sweep. */
const FIST: V3 = [118, 108, 72];
const KB_PRESENT = { roll: 20, pitch: 3, yaw: 12, shift: [-1.8, 1.3, 0.6] as V3 };

const squeeze = (x: number) => {
  x = Math.min(1, Math.max(0, x));
  return 1 + 2.3 * (x - 1) ** 3 + 1.3 * (x - 1) ** 2;
};

function ringPivot(knife: KnifeDef | null) {
  return knife?.pivots?.ring ?? RING_FALLBACK;
}

/** Turns the knife bones by `deg` about the ring axis through the ring centre (both knife-local, from Knife_Handle). */
function spinAboutRing(W: Float32Array, ctx: InspectCtx, deg: number): void {
  if (!deg) return;
  const k = ctx.arm.kb * 12;
  const { p, axis } = ringPivot(ctx.knife);
  const c: V3 = [W[k] * p[0] + W[k + 1] * p[1] + W[k + 2] * p[2] + W[k + 3], W[k + 4] * p[0] + W[k + 5] * p[1] + W[k + 6] * p[2] + W[k + 7], W[k + 8] * p[0] + W[k + 9] * p[1] + W[k + 10] * p[2] + W[k + 11]];
  const a: V3 = [W[k] * axis[0] + W[k + 1] * axis[1] + W[k + 2] * axis[2], W[k + 4] * axis[0] + W[k + 5] * axis[1] + W[k + 6] * axis[2], W[k + 8] * axis[0] + W[k + 9] * axis[1] + W[k + 10] * axis[2]];
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  rotAbout([a[0] / l, a[1] / l, a[2] / l], deg * D2R, c, T);
  for (const i of ctx.arm.knife) {
    concat(T, 0, W, i * 12, M, 0);
    W.set(M, i * 12);
  }
}

interface RingSpec {
  id: string;
  name: string;
  /** Whole turns (the knife ends back in the fist). */
  turns: number;
  /** A half turn back the other way after the spins (the reverse catch), then forward into the grip again. */
  reverse?: boolean;
  /** Release: the fingers let go here, the flick 60 ms later; then `per` s per turn. */
  release: number;
  per: number;
  /** Hold F loops the first turn. */
  loop?: boolean;
}

function ringSpin(s: RingSpec): InspectClip {
  const enter = 0.32;
  const r0 = s.release, f = r0 + 0.12; // fingers let go, the index points, then the flick
  const rate = 360 / s.per;
  const land = f + s.per * s.turns;
  const total = 360 * s.turns;
  // Spin: a short wind-up, then the flick snaps it straight to full speed (CS-snappy), a constant rate turn after
  // turn (so the first turn is the hold loop: same pose at both ends), and the fingers kill it on the catch.
  const keys: [number, number, number][] = [
    [r0, 0, 0],
    [f - 0.035, -12, 0],
    [f, 0, rate],
    [land, total, rate],
    [land + 0.07, total + 5, 0],
    [land + 0.2, total, 0],
  ];
  let catchT = land;
  if (s.reverse) {
    // Reverse catch: past the last turn the knife swings back half a turn (fingers still open), then snaps forward
    // into the fist.
    keys.splice(4);
    keys.push([land + 0.2, total + 150, rate * 0.2], [land + 0.34, total + 120, -400], [land + 0.5, total, -120], [land + 0.58, total - 3, 0], [land + 0.7, total, 0]);
    catchT = land + 0.5;
  }
  const spin = spline(keys);
  const exit = catchT + 1.05;
  const len = exit + 0.55;
  // After the catch the fist turns to face you (the hold's show pose, knives/karrotbit.ts KB_SHOW: the back of the
  // fist, the ring and the hook toward the camera), holds it, and settles back to the idle with the presented pose.
  const show = track([
    [catchT + 0.22, 0],
    [catchT + 0.62, 1, E.io],
    [exit, 1],
    [len, 0, E.io],
  ]);
  const loop: [number, number] | undefined = s.loop ? [f, f + s.per] : undefined;
  const cues: Cue[] = [{ t: f, type: "flip" }, { t: catchT, type: "catch" }];
  for (let k = 0; k < s.turns; k++) cues.push({ t: f + s.per * (k + 0.5), type: "spin" });
  return {
    id: s.id,
    name: s.name,
    len,
    enter,
    exit,
    open: f + 0.05,
    loop,
    free: [[f, catchT]],
    cues: cues.filter((c) => c.t < len),
    show,
    apply(W, t, ctx) {
      const a = ctx.arm;
      const p = presented(t, enter, exit, len);
      const flick = bump(t, f - 0.02, f + 0.3) * (t < f + s.per ? 1 : 0);
      const dip = bump(t, catchT - 0.02, catchT + 0.45);
      // Presented: the reverse-grip fist is already up (knives/karrotbit.ts idle); bring it a little down, back and in
      // so the ring and the whole spin stay in frame.
      const sh = KB_PRESENT.shift;
      // (Presented less while the hold turns the fist to face you: that pose is its own.)
      const pp = p * (1 - show(t));
      a.arm(W, KB_PRESENT.roll * pp, KB_PRESENT.pitch * pp + 4 * flick - 7 * dip, KB_PRESENT.yaw * pp, [sh[0] * pp, sh[1] * pp, sh[2] * pp - 0.5 * dip]);
      a.wrist(W, -12 * flick + 12 * dip, 6 * flick);
      // Fingers, like a real karambit spin: the index points forward (it is the axle; the knife rides on it through
      // the ring), the other three let go before the wind-up and tuck into a tight fist out of the ring's sweep, then
      // open to take the handle back and close on it after the catch; the thumb lifts off.
      const hf = a.frame(W);
      const i1 = a.fingers.index[0];
      invert34(W, i1 * 12, Ii, 0);
      concat(Ii, 0, W, a.kb * 12, REL, 0);
      const fingers = ["middle", "ring", "pinky"] as const;
      fingers.forEach((fg, i) => {
        const o0 = r0 - 0.1 + i * 0.012;
        // Let go (open) before anything moves, tuck into a tight fist once the handle has swung away, and on the catch
        // unfold from the fist straight onto the returning handle (the hold), pinky first.
        const open = track([[o0, 0], [o0 + 0.08, 0.85, E.out], [f + 0.06, 0.85], [f + 0.14, 0, E.io]])(t);
        const tuck = track([[f + 0.06, 0], [f + 0.14, 1, E.out], [catchT - 0.02 + (2 - i) * 0.015, 1], [catchT + 0.16 + (2 - i) * 0.015, 0, E.io]])(t);
        if (tuck > 0.001) openFinger(ctx, W, hf, fg, tuck, FIST);
        else if (open > 0.001) openFinger(ctx, W, hf, fg, open);
      });
      const point = track([[f - 0.03, 0], [f + 0.08, 1, E.out], [catchT, 1], [catchT + 0.16, 0, E.io]])(t);
      openFinger(ctx, W, hf, "index", point, [12, 22, 18]);
      // The knife follows the index's first segment (the ring sits on it).
      concat(W, i1 * 12, REL, 0, K, 0);
      for (const kb of a.knife) W.set(K, kb * 12);
      // The thumb stays on the back of the fist (opening it would put it in the ring's sweep).
      spinAboutRing(W, ctx, spin(t));
    },
  };
}

export const ringSpin1 = ringSpin({ id: "ring-spin", name: "Ring Spin", turns: 1, release: 0.38, per: 0.34, loop: true });
export const ringSpin2 = ringSpin({ id: "ring-spin-2", name: "Double Ring Spin", turns: 2, release: 0.38, per: 0.3, loop: true });
export const ringSpin3 = ringSpin({ id: "ring-spin-3", name: "Triple Spin + Reverse Catch", turns: 3, release: 0.38, per: 0.27, reverse: true, loop: true });

export const KARROTBIT_INSPECTS = inspectSet("karrotbit", [ringSpin1, ringSpin2, ringSpin3], 8);
