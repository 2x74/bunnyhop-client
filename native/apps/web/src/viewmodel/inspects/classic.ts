// The classic inspect (v0.0.4's F, unchanged motion): the right forearm rolls the knife over to show its side, the
// fist comes up toward the centre, then the knife flips to its other side and settles back. Rigid motion of the right
// arm + knife. Now the fallback: knives without their own inspect set start their chain with it (?vminspect=classic
// forces it for any knife).

import { concat } from "../../player/bunny/rig";
import { angleMatrix, ramp, rotAbout } from "../math";
import { D2R } from "./kit";
import type { InspectClip } from "./types";

const T = new Float32Array(12), T2 = new Float32Array(12), M = new Float32Array(12);

export const classic: InspectClip = {
  id: "classic",
  name: "Classic",
  len: 2.6,
  enter: 0.45,
  exit: 2.0,
  open: 0.6,
  cues: [{ t: 1.3, type: "spin" }],
  apply(W, t, ctx) {
    const a = ctx.arm;
    const h = a.handBone * 12, e = a.armBone * 12;
    const wrist = [W[h + 3], W[h + 7], W[h + 11]];
    const elbow = [W[e + 3], W[e + 7], W[e + 11]];
    let ax = [wrist[0] - elbow[0], wrist[1] - elbow[1], wrist[2] - elbow[2]];
    const l = Math.hypot(ax[0], ax[1], ax[2]) || 1;
    ax = [ax[0] / l, ax[1] / l, ax[2] / l];
    // Roll: show one side (0.15-0.5 s), flip to the other (1.25-1.65 s), back (2.0-2.5 s).
    const roll = -95 * ramp(t, 0.1, 0.5) + 150 * ramp(t, 1.25, 1.65) - 55 * ramp(t, 2.0, 2.5);
    const raise = ramp(t, 0.05, 0.45) - ramp(t, 2.0, 2.55);
    rotAbout(ax, roll * D2R, wrist, T);
    // Bring the fist up toward the centre about the elbow.
    angleMatrix(-14 * raise, 16 * raise, 0, 0, 0, 0, T2);
    T2[3] = elbow[0] - (T2[0] * elbow[0] + T2[1] * elbow[1] + T2[2] * elbow[2]) + 1.2 * raise;
    T2[7] = elbow[1] - (T2[4] * elbow[0] + T2[5] * elbow[1] + T2[6] * elbow[2]) + 0.8 * raise;
    T2[11] = elbow[2] - (T2[8] * elbow[0] + T2[9] * elbow[1] + T2[10] * elbow[2]) + 0.6 * raise;
    concat(T2, 0, T, 0, M, 0);
    a.rigid(W, M, a.all);
  },
};
