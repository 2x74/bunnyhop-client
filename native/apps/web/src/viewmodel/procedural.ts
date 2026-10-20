// Procedural fallback for the viewmodel when the hosted CS:S content (v_knife_t's animations) isn't available: an
// original pose and original keyframed motions on the same rig, timed like the CS:S knife (draw ~1 s, slash 0.4 s
// cadence, stab 1 s). The right fist grips the carrot (fingers curled about the palm's width axis, the carrot through
// the fist), the forearm follows the wrist; the left arm is parked out of view. Motions are rigid transforms of the
// whole right arm + carrot about the wrist.
//
// All in Source viewmodel space (x forward, y left, z up), 3x4 row-major bone-to-model matrices.

import { add, cross, dot, len, norm, scale, sub } from "../player/bunny/builder";
import { concat, xform, type V3 } from "../player/bunny/rig";

const xform3 = (m: Float32Array, p: V3): V3 => xform(m, 0, p);
import { angleMatrix, fromAxes, ramp, rotAbout, rotate } from "./math";
import type { VmRig } from "./rig";
import { CARROT_HOLD, GRIP_ALONG, solvedHold } from "./knives/hold";

export type VmAction = "idle" | "draw" | "slash1" | "slash2" | "stab";

/** Durations (s) of the procedural actions (the CS:S sequence lengths they stand in for). */
export const PROC_DURATION: Record<VmAction, number> = { idle: 4, draw: 1.0, slash1: 1.0, slash2: 1.0, stab: 1.3 };

interface Key {
  t: number;
  /** Offset (forward, left, up) and angles (pitch, yaw, roll) about the wrist. */
  o: [number, number, number];
  a: [number, number, number];
}

const K = (t: number, o: [number, number, number], a: [number, number, number]): Key => ({ t, o, a });

/** Keyframes per action (times in s); smoothstep between keys. */
const KEYS: Record<Exclude<VmAction, "idle">, Key[]> = {
  // Up from below with a little flourish.
  draw: [K(0, [-2, -1.5, -8], [-25, 0, 50]), K(0.3, [0.4, 0.3, 0.5], [6, 0, -10]), K(0.55, [0, 0, 0], [-2, 0, 3]), K(0.8, [0, 0, 0], [0, 0, 0])],
  // Wind up to the right, sweep right-to-left and down with the blade leading, recover.
  slash1: [K(0, [0, 0, 0], [0, 0, 0]), K(0.07, [-0.4, -1.4, 1.0], [-8, 0, 38]), K(0.19, [2.2, 5.5, -0.6], [36, 18, -70]), K(0.3, [1.4, 4.8, -1.4], [26, 14, -60]), K(0.62, [0, 0, 0], [0, 0, 0])],
  // Backhand: wind up to the left, sweep left-to-right.
  slash2: [K(0, [0, 0, 0], [0, 0, 0]), K(0.08, [0.3, 3.2, 1.2], [-6, 8, -45]), K(0.2, [2.2, -1.5, -0.6], [34, -12, 62]), K(0.31, [1.2, -1.8, -1.3], [24, -8, 50]), K(0.62, [0, 0, 0], [0, 0, 0])],
  // Pull back, thrust the carrot forward toward the crosshair (blade leading), hold, recover.
  stab: [K(0, [0, 0, 0], [0, 0, 0]), K(0.22, [-1.4, 0.2, 0.9], [-16, 0, 6]), K(0.36, [4.5, 4.2, 2.6], [78, 12, -6]), K(0.6, [4.2, 4, 2.4], [76, 11, -6]), K(1.05, [0, 0, 0], [0, 0, 0])],
};

function sample(keys: Key[], t: number, o: number[], a: number[]): void {
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1].t) i++;
  const k0 = keys[i], k1 = keys[Math.min(keys.length - 1, i + 1)];
  const f = k1.t > k0.t ? ramp(t, k0.t, k1.t) : 1;
  for (let c = 0; c < 3; c++) {
    o[c] = k0.o[c] + (k1.o[c] - k0.o[c]) * f;
    a[c] = k0.a[c] + (k1.a[c] - k0.a[c]) * f;
  }
}

export class VmProcedural {
  /** Rest pose, bone-to-model per bone. */
  private rest: Float32Array;
  /** Bones moved by the actions: the right arm subtree + the carrot. */
  readonly right: number[];
  /** Pivot of the action motions (the wrist in the rest pose). */
  readonly pivot: V3;
  private m = new Float32Array(12);
  private m2 = new Float32Array(12);
  private o = [0, 0, 0];
  private a = [0, 0, 0];

  constructor(private r: VmRig) {
    const n = r.names.length;
    const rest = (this.rest = new Float32Array(n * 12));
    // Park everything far below the view (the left arm stays there).
    for (let i = 0; i < n; i++) {
      rest.set(r.bind.subarray(i * 12, i * 12 + 12), i * 12);
      rest[i * 12 + 11] -= 600;
    }
    const at = (nm: string) => r.at(nm);
    const B = (nm: string) => r.bone(nm);
    // Bind hand frame (as in mesh.ts).
    const wristB = at("Right_Hand");
    const roots = ["Index", "Middle", "Ring", "Pinky"].map((f) => at(`Right_${f}01`));
    const kc = scale(roots.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 0.25);
    const axB = norm(sub(kc, wristB));
    let wB = sub(roots[0], roots[3]);
    wB = norm(sub(wB, scale(axB, dot(wB, axB))));
    let nB = cross(axB, wB);
    if (dot(nB, sub(at("Right_Thumb02"), wristB)) < 0) nB = scale(nB, -1);
    const hand = dot(nB, cross(axB, wB)); // +1 / -1 handedness of (ax, w, n)
    const palmL = len(sub(kc, wristB));

    void hand;
    // Carrot through the fist (bind space): grip point inside the curled fingers, blade out along the width axis
    // (thumb side), tipped a little toward the fingers.
    const grip = add(add(wristB, scale(axB, palmL * GRIP_ALONG)), scale(nB, 1.35));
    const zB = norm(add(wB, scale(axB, 0.12)));
    const xB = norm(sub(axB, scale(zB, dot(axB, zB))));
    const yB = cross(zB, xB);
    const knifeB = new Float32Array(12);
    fromAxes(xB, yB, zB, grip, knifeB);
    // Target carrot frame: where v_knife_t's idle puts the carrot's grip (measured with the hold layer: low on the
    // right, standing up, leaning a little forward and out, the fist's fingers pointing forward-left), so the idle
    // framing is the same with or without the hosted content (v0.0.5's own pose sat ~1 unit further right and leaned
    // in). G (bind hand -> posed hand) = target * inverse(knifeB).
    const zT = norm([0.267, -0.131, 0.955]);
    const xT = norm(sub([0.89, 0.413, -0.192], scale(zT, dot([0.89, 0.413, -0.192], zT))));
    const yT = cross(zT, xT);
    const Kt = new Float32Array(12), KbInv = new Float32Array(12), G = new Float32Array(12);
    fromAxes(xT, yT, zT, [14.4, -4.08, -5.19], Kt);
    KbInv.set([xB[0], xB[1], xB[2], -dot(xB, grip), yB[0], yB[1], yB[2], -dot(yB, grip), zB[0], zB[1], zB[2], -dot(zB, grip)]);
    concat(Kt, 0, KbInv, 0, G, 0);
    const wristT = xform3(G, wristB);
    const apply = (Gm: Float32Array, i: number) => concat(Gm, 0, r.bind, i * 12, rest, i * 12);

    // Hand, its finger roots and the wrist helper.
    const handI = B("Right_Hand");
    for (const i of r.subtree(handI)) apply(G, i);
    apply(G, B("R_wrist_helper"));
    apply(G, B("Root98"));
    // Fingers: curl each joint about the palm's width axis (bind space), toward the palm.
    const curlAxis = norm(cross(axB, nB));
    const tmp = new Float32Array(12), acc = new Float32Array(12), acc2 = new Float32Array(12);
    const curl = (names: string[], angles: number[], axis: V3, spread = 0) => {
      acc.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
      // Spread about the palm normal at the root first (like knives/hold.ts handFrame).
      if (spread) rotAbout(nB, (spread * Math.PI) / 180, at(names[0]), acc);
      names.forEach((nm, k) => {
        const i = B(nm);
        const p = at(nm);
        // Joint pivot moved by the rotations of the joints before it.
        rotAbout(axis, (angles[k] * Math.PI) / 180, p, tmp);
        concat(acc, 0, tmp, 0, acc2, 0);
        acc.set(acc2);
        concat(G, 0, acc, 0, tmp, 0);
        concat(tmp, 0, r.bind, i * 12, rest, i * 12);
      });
    };
    // The carrot fist's curls (after its grip solver) live in knives/hold.ts CARROT_HOLD: one source for this rest pose
    // and the hold layer.
    const H = solvedHold(CARROT_HOLD, r);
    curl(["Right_Index01", "Right_Index02", "Right_Index03"], H.index.c, curlAxis, H.index.spread);
    curl(["Right_Middle01", "Right_Middle02", "Right_Middle03"], H.middle.c, curlAxis, H.middle.spread);
    curl(["Right_Ring01", "Right_Ring02", "Right_Ring03"], H.ring.c, curlAxis, H.ring.spread);
    curl(["Right_Pinky01", "Right_Pinky02", "Right_Pinky03"], H.pinky.c, curlAxis, H.pinky.spread);
    {
      const t0 = at("Right_Thumb01"), t1 = at("Right_Thumb02");
      const td = norm(sub(t1, t0));
      const thumbAxis = norm(cross(td, nB));
      curl(["Right_Thumb01", "Right_Thumb02", "Right_Thumb03"], H.thumb.c, thumbAxis, H.thumb.spread);
    }

    // Forearm: follows the hand's rotation, swung so it runs back toward the elbow (pivot at the wrist).
    const armI = B("Right_Arm");
    const dAB = norm(sub(wristB, at("Right_Arm")));
    const dAT = norm([0.9, 0.3, 0.26]);
    const cur = rotate(G, 0, dAB);
    const sw = cross(cur, dAT);
    const s = len(sw);
    const swing = new Float32Array(12);
    if (s > 1e-6) rotAbout(scale(sw, 1 / s), Math.atan2(s, dot(cur, dAT)), wristT, swing);
    else swing.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    const GA = new Float32Array(12);
    concat(swing, 0, G, 0, GA, 0);
    for (const nm of ["Root36", "Right_Arm", "eff18", "Root23"]) apply(GA, B(nm));
    this.pivot = wristT;
    this.armDir = dAT;
    this.armLen = len(sub(wristB, at("Right_Arm")));
    for (const nm of ["knife_Parent", "Knife_Handle"]) concat(G, 0, knifeB, 0, rest, B(nm) * 12);

    this.right = [...r.subtree(B("Root36")), B("knife_Parent"), B("Knife_Handle")];
    this.arm = ["Root36", "Right_Arm", "eff18", "Root23"].map(B);
    this.hand = this.right.filter((i) => !this.arm.includes(i));
    void armI;
  }

  private armDir: V3;
  private armLen: number;
  private arm: number[];
  private hand: number[];
  private swing = new Float32Array(12);

  /** Writes bone-to-model matrices for `action` at time t (s since it started) into W. */
  pose(action: VmAction, t: number, W: Float32Array): void {
    W.set(this.rest);
    if (action === "idle") return;
    sample(KEYS[action], t, this.o, this.a);
    const e = this.pivot;
    // Rotate about the wrist, then offset.
    angleMatrix(this.a[0], this.a[1], this.a[2], 0, 0, 0, this.m);
    this.m[3] = e[0] - (this.m[0] * e[0] + this.m[1] * e[1] + this.m[2] * e[2]) + this.o[0];
    this.m[7] = e[1] - (this.m[4] * e[0] + this.m[5] * e[1] + this.m[6] * e[2]) + this.o[1];
    this.m[11] = e[2] - (this.m[8] * e[0] + this.m[9] * e[1] + this.m[10] * e[2]) + this.o[2];
    for (const i of this.hand) {
      concat(this.m, 0, this.rest, i * 12, this.m2, 0);
      W.set(this.m2, i * 12);
    }
    // The forearm doesn't spin with the fist: it re-aims from an elbow that follows the wrist halfway.
    const o = this.o;
    const d = this.armDir;
    const L = this.armLen;
    const nd = norm([d[0] * L + o[0] * 0.6, d[1] * L + o[1] * 0.6, d[2] * L + o[2] * 0.6]);
    const ax = cross(d, nd);
    const s = len(ax);
    if (s > 1e-6) rotAbout(scale(ax, 1 / s), Math.atan2(s, dot(d, nd)), e, this.swing);
    else this.swing.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    this.swing[3] += o[0];
    this.swing[7] += o[1];
    this.swing[11] += o[2];
    for (const i of this.arm) {
      concat(this.swing, 0, this.rest, i * 12, this.m2, 0);
      W.set(this.m2, i * 12);
    }
  }
}
