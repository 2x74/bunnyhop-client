// The bunny's posture over the CS:S animations (v0.0.42; player/bunny/model.ts). The knife set of
// cs_player_shared.mdl is a fighter's stoop: standing, the chest leans 28 degrees forward and the face looks 17 degrees
// at the floor; running it is 40 degrees with the head 9 units lower than standing. On a mascot seen mostly from behind
// that reads as bent over. This layer stands it up: after the animation, before the legs, the upper body turns back
// about two spine joints by a share of whatever lean the animation has now, the head stops at level (or where the eyes
// look), and the hips come up a little on the ground (legs.ts keeps the feet where they are). A share, not a fixed
// angle: the lean into a run, the tuck of a hop and the crouch all stay, smaller.
//
// Presentation only, from what the renderer already knows (grounded, crouched, speed); eased exactly in dt, so 60 and
// 240 fps agree and the tick stepper's replays are the same at any playback speed. Not over the procedural fallback
// (it stands upright already): `on` eases it in when the animations arrive. No allocation per frame.

import { concat, type Rig } from "./rig";

/**
 * The share of the animation's lean taken out, by state (0 = the CS:S pose, 1 = bolt upright), the hips' rise on the
 * ground (units) and how far the head may look down at level eyes after it (degrees).
 */
export const POSTURE = {
  stand: 0.62,
  run: 0.5,
  air: 0.42,
  /** In the air at speed the lean stays more (from AIR_SLOW to AIR_FAST u/s). */
  airFast: 0.3,
  crouch: 0.3,
  lift: 1.6,
  liftRun: 0.8,
  /** How much of the eyes' pitch the head may carry (it never ends up looking higher than this, or than it did). */
  headFollow: 0.7,
  /**
   * The arms come up with the chest; this share of the turn is taken back out at the shoulders, so the free hand's
   * guard stays in front of the chest instead of rising in front of the face.
   */
  arms: 0.6,
};
const AIR_SLOW = 300, AIR_FAST = 800, RUN = 250;

const D2R = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth01 = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};
const M = new Float32Array(12), TMP = new Float32Array(12);

export class Posture {
  /** Debug / tests: the share applied this frame, the turn it came to (deg), and the hips' rise wanted (units). */
  share = 0;
  turn = 0;
  lift = 0;

  private onW = 0;
  private airW = 0;
  private crouchW = 0;
  private runW = 0;
  private fastW = 0;
  private spine1: number;
  private spine2: number;
  private head: number;
  private sub1: number[];
  private sub2: number[];
  private subHead: number[];
  private arms: { bone: number; sub: number[] }[];

  constructor(private r: Rig) {
    // A bone and every CS:S bone under it (parents come first). The ears and the knife follow their bones afterwards.
    const sub = (root: number) => {
      const out = [root];
      for (let i = root + 1; i < r.csBones; i++) if (out.includes(r.parent[i])) out.push(i);
      return out;
    };
    this.spine1 = r.bone("Spine1");
    this.spine2 = r.bone("Spine2");
    this.head = r.bone("Head1");
    this.sub1 = sub(this.spine1);
    this.sub2 = sub(this.spine2);
    this.subHead = sub(this.head);
    this.arms = ["L_UpperArm", "R_UpperArm"].map((n) => ({ bone: r.bone(n), sub: sub(r.bone(n)) }));
  }

  /** Eases the state's share and lift. `on`: the CS:S animations pose the body. */
  update(dt: number, snap: boolean, on: boolean, grounded: boolean, crouched: boolean, speed: number): void {
    const to = (cur: number, target: number, rate: number) => (snap || dt <= 0 ? (snap ? target : cur) : cur + (target - cur) * (1 - Math.exp(-rate * dt)));
    this.onW = to(this.onW, on ? 1 : 0, 4);
    // Off the ground at once, back on it slowly: a bhop's one ground tick is not standing.
    this.airW = to(this.airW, grounded ? 0 : 1, grounded ? 5 : 14);
    this.crouchW = to(this.crouchW, crouched ? 1 : 0, 10);
    // (Eased too: a booster or a stop changes the speed in a tick.)
    this.runW = to(this.runW, smooth01(speed / RUN), 10);
    this.fastW = to(this.fastW, smooth01((speed - AIR_SLOW) / (AIR_FAST - AIR_SLOW)), 10);
    const run = this.runW;
    const ground = POSTURE.stand + (POSTURE.run - POSTURE.stand) * run;
    const air = POSTURE.air + (POSTURE.airFast - POSTURE.air) * this.fastW;
    const up = ground + (air - ground) * this.airW;
    this.share = this.onW * (up + (POSTURE.crouch - up) * this.crouchW);
    this.lift = this.onW * (1 - this.crouchW) * (POSTURE.lift + (POSTURE.liftRun - POSTURE.lift) * run);
  }

  /**
   * Turns the upper body back on the skinning matrices S (model space: the feet face +x, z up). `eyePitch`: the view's
   * pitch (deg, + = down), for where the head may end up.
   */
  apply(S: Float32Array, eyePitch: number): void {
    this.turn = 0;
    if (this.share < 1e-4) return;
    // The chest's forward (bind -y) now, and its pitch (< 0: leaning forward).
    const o = this.spine2 * 12;
    const fx = -S[o + 1], fy = -S[o + 5], fz = -S[o + 9];
    const fh = Math.hypot(fx, fy);
    if (fh < 1e-4) return;
    const lean = Math.atan2(fz, fh) / D2R;
    if (lean >= 0) return;
    const turn = -lean * this.share;
    this.turn = turn;
    // About the level axis across the chest (forward x up): a positive turn raises the forward direction.
    const ax = fy / fh, ay = -fx / fh;
    const head0 = this.pitchOf(S, this.head);
    turnLevel(S, this.r, this.sub1, this.spine1, ax, ay, turn / 2);
    turnLevel(S, this.r, this.sub2, this.spine2, ax, ay, turn / 2);
    for (const a of this.arms) turnLevel(S, this.r, a.sub, a.bone, ax, ay, -turn * POSTURE.arms);
    // The head came up with the chest: it stops at level eyes (or where it looked, if that was higher).
    const cap = Math.max(head0, -eyePitch * POSTURE.headFollow);
    const over = head0 + turn - cap;
    if (over > 1e-3) turnLevel(S, this.r, this.subHead, this.head, ax, ay, -over);
  }

  /** The pitch (deg) of a bone's forward (bind -y) as posed. */
  private pitchOf(S: Float32Array, bone: number): number {
    const o = bone * 12;
    return Math.atan2(-S[o + 9], Math.hypot(S[o + 1], S[o + 5])) / D2R;
  }
}

/** Rotates the bones `sub` by `deg` about the level axis (ax, ay, 0) through `bone`'s posed joint (also follow.ts). */
export function turnLevel(S: Float32Array, r: Rig, sub: number[], bone: number, ax: number, ay: number, deg: number): void {
  if (!deg) return;
  const B = r.bind, o = bone * 12;
  const bx = B[o + 3], by = B[o + 7], bz = B[o + 11];
  const px = S[o] * bx + S[o + 1] * by + S[o + 2] * bz + S[o + 3];
  const py = S[o + 4] * bx + S[o + 5] * by + S[o + 6] * bz + S[o + 7];
  const pz = S[o + 8] * bx + S[o + 9] * by + S[o + 10] * bz + S[o + 11];
  const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R), t = 1 - c;
  M[0] = t * ax * ax + c, M[1] = t * ax * ay, M[2] = s * ay;
  M[4] = t * ax * ay, M[5] = t * ay * ay + c, M[6] = -s * ax;
  M[8] = -s * ay, M[9] = s * ax, M[10] = c;
  M[3] = px - (M[0] * px + M[1] * py + M[2] * pz);
  M[7] = py - (M[4] * px + M[5] * py + M[6] * pz);
  M[11] = pz - (M[8] * px + M[9] * py + M[10] * pz);
  for (const i of sub) {
    concat(M, 0, S, i * 12, TMP, 0);
    S.set(TMP, i * 12);
  }
}
