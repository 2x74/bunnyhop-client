// The gun viewmodel's pose (no DOM, no rendering: the viewmodel draws it, the audits check it headless). Source
// viewmodel space, 3x4 bone-to-model per bone of guns/rig.ts (hands + gun):
//   gun        framing (GunDef.frame) * animation (guns/anim.ts: clips + recoil spring) about the right grip
//   parts      slide / pump / magazine / shell bones from the pose
//   right hand rides the gun (the solved hold, guns/hold.ts), fingers from the solved curls + the trigger squeeze
//   left hand  its support grip (on the gun or the pump), or a target on the gun (reloads, racks, inspects) plus a
//              view-space trip (off screen for a new magazine), blended; fingers blend from the solved grip to a preset
//   silencer   the can on the bore (turned / wound out along the thread) or carried; the left hand's "sil" target is
//              its solved grip on the can (guns/hold.ts solveSilencerHand), riding the can
//   forearms   re-aimed from each wrist toward an elbow anchor (the sleeves follow the hands without twisting)
//   safety     fingers.ts clampFingers on both hands (nothing bends backwards, whatever a blend did)
// No allocation per frame.

import { concat, invert34, type V3 } from "../../player/bunny/rig";
import type { GloveStyleId } from "../../loadout";
import { angleMatrix, rotAbout } from "../math";
import { clampFingers } from "../fingers";
import { GunAnimator, type CurlPreset, type GunPose } from "./anim";
import { FingerPoser, flatCurls, handAt, sideBind, solveHand, solveSilencerHand, type SolvedHand } from "./hold";
import { gunRig } from "./rig";
import type { GunDef, GunPart } from "./types";
import { WRIST, type WristRange } from "./wrist";

/** Left-hand finger presets (deg per joint + spread; index, middle, ring, pinky, thumb). */
const PRESET_CURLS: Record<Exclude<CurlPreset, "support" | "sil">, [number, number, number, number][]> = {
  open: [[8, 14, 10, 4], [10, 16, 10, 0], [12, 16, 10, -2], [14, 16, 10, -4], [4, 10, 8, 4]],
  mag: [[48, 52, 36, 0], [56, 60, 42, 0], [62, 64, 46, 0], [66, 66, 48, 0], [8, 22, 18, 10]],
  pinch: [[46, 56, 40, 0], [72, 84, 60, 0], [80, 88, 64, 0], [84, 88, 64, 0], [14, 30, 28, 12]],
  shell: [[30, 40, 30, 0], [48, 58, 44, 0], [76, 84, 64, 0], [82, 84, 64, 0], [8, 16, 12, 10]],
  flat: [[4, 6, 4, 2], [4, 6, 4, 0], [4, 6, 4, -2], [6, 6, 4, -4], [2, 6, 4, 6]],
};
const PRESETS = Object.fromEntries(Object.entries(PRESET_CURLS).map(([k, v]) => [k, Float32Array.from(v.flat())])) as Record<Exclude<CurlPreset, "support" | "sil">, Float32Array>;
/** The right index off the trigger, along the frame (reloads, inspects). */
const INDEX_OFF: [number, number, number] = [6, 8, 4];

/** Largest bob / sway / lag offset (forward, left, up / down; units) a gun takes from the knife viewmodel's feel. */
export const FEEL_MAX = { fwd: 2, left: 2.5, up: 2.5, down: 4 } as const;

/**
 * The knife viewmodel's feel matrix (3x4: bob, sway, lag, crouch, landing dip) for a gun: its offset stays a nudge.
 * The knife's lag can stick at its extreme (a view snapped exactly 180 degrees by a teleport / restart, no mouse motion
 * since: a 10-unit pull back), which would push a gun's slide into the camera.
 */
export function clampFeel(feel: ArrayLike<number>, out: Float32Array): Float32Array {
  for (let i = 0; i < 12; i++) out[i] = feel[i];
  out[3] = Math.max(-FEEL_MAX.fwd, Math.min(FEEL_MAX.fwd, out[3]));
  out[7] = Math.max(-FEEL_MAX.left, Math.min(FEEL_MAX.left, out[7]));
  out[11] = Math.max(-FEEL_MAX.down, Math.min(FEEL_MAX.up, out[11]));
  return out;
}

/**
 * The forearm solve. `anchor`: how much a forearm aims at its elbow anchor (1) vs continues the hand (0); the wrist's
 * natural range (WRIST) bounds what's left, the forearm turning with the hand past it. `carry`: how much of the wrist's
 * way from its rest the anchor travels with (the arm moves with the hand: drawn up from below, pushed out in a reload,
 * down for a magazine), so the forearm keeps its line instead of pivoting about a fixed point. (The recoil kick turns
 * the gun about the firing grip by a few degrees: the wrists move under a degree.)
 */
export const ARM = { anchor: 0.9, carry: 1 };

export { WRIST, type WristRange } from "./wrist";

/**
 * A gun's wrist range on one side (WRIST.grip / WRIST.support with the gun's own, GunDef.wrist), opened by `work` (0..1)
 * toward WRIST.work: the range the forearm solve keeps that wrist in.
 */
export function wristRange(def: GunDef | null, side: "R" | "L", work = 0, out: WristRange = { ext: 0, flex: 0, uln: 0, rad: 0 }): WristRange {
  const base = side === "R" ? WRIST.grip : WRIST.support, own = def?.wrist?.[side];
  const w = Math.max(0, Math.min(1, work));
  for (const k of ["ext", "flex", "uln", "rad"] as const) {
    const v = own?.[k] ?? base[k];
    out[k] = v + (Math.max(v, WRIST.work[k]) - v) * w;
  }
  return out;
}

/** Scratch for wristAngles. */
const wa = { T: new Float32Array(12) };

/**
 * A posed hand's wrist angles (deg; WristRange's anatomy): `flex` + flexion / - extension, `dev` + radial / - ulnar,
 * from the forearm's axis (the arm bone's joint to the wrist) and the hand's knuckle line, palm normal and thumb side
 * (its bind axes, guns/hold.ts sideBind, carried by the hand bone). The same measure the forearm solve clamps.
 */
export function wristAngles(W: ArrayLike<number>, side: "R" | "L", out = { flex: 0, dev: 0 }): { flex: number; dev: number } {
  const r = gunRig().hands, b = armBonesOf(side);
  const h = b.hand * 12, a = r.bone(side === "R" ? "Right_Arm" : "Left_Arm") * 12;
  const F: V3 = [W[h + 3] - W[a + 3], W[h + 7] - W[a + 7], W[h + 11] - W[a + 11]];
  concat(W, h, b.invHand, 0, wa.T, 0);
  const sb = sideBind(side);
  const ang = handFrameAngles(wa.T, sb.ax, sb.n, sb.across, F);
  out.flex = ang[0];
  out.dev = ang[1];
  return out;
}

/** (flex, dev) in deg of forearm direction F (elbow -> wrist) against a hand moved by T (bind axes ax / n / across). */
function handFrameAngles(T: ArrayLike<number>, ax: V3, n: V3, ac: V3, F: V3): [number, number] {
  const A = mul3(T, ax), N = mul3(T, n), C = mul3(T, ac);
  const x = F[0] * A[0] + F[1] * A[1] + F[2] * A[2];
  return [Math.atan2(-(F[0] * N[0] + F[1] * N[1] + F[2] * N[2]), x) / D2R, Math.atan2(-(F[0] * C[0] + F[1] * C[1] + F[2] * C[2]), x) / D2R];
}

const nrm3 = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Spherical blend of unit vectors a -> b by t (a straight blend when they're nearly parallel or opposite). */
function slerp3(a: V3, b: V3, t: number): V3 {
  const c = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const th = Math.acos(c), sn = Math.sin(th);
  if (sn < 1e-4) return nrm3([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  const wa = Math.sin((1 - t) * th) / sn, wb = Math.sin(t * th) / sn;
  return nrm3([a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb]);
}

/**
 * How far out of view a hand is (0 in view .. 1 well out): its wrist and its knuckles against the default framing's
 * view (CS:S viewmodel_fov 64 at 16:9, the default offset), with a margin for the other framings and FOVs.
 */
function outOfView(wrist: V3, ax: V3): number {
  let m = -1;
  for (const s of [0, 3.2]) {
    const x = wrist[0] + ax[0] * s + VIEW.y, y = wrist[1] + ax[1] * s - VIEW.x, z = wrist[2] + ax[2] * s;
    if (x <= 0.75) continue;
    m = Math.max(m, Math.min(VIEW.tanH - Math.abs(y / x), VIEW.tanV - Math.abs(z / x)));
  }
  // In view (or within the margin of its edge): 0; fully free 0.12 (as a tangent) past it.
  return Math.max(0, Math.min(1, (-m - VIEW.margin) / 0.12));
}
const VIEW = (() => {
  const tanV = Math.tan(Math.atan(Math.tan((64 * Math.PI) / 360) * 0.75));
  return { x: 0.5, y: 1.5, tanV, tanH: (tanV * 16) / 9, margin: 0.08 };
})();

const mul3 = (T: ArrayLike<number>, d: V3): V3 => [T[0] * d[0] + T[1] * d[1] + T[2] * d[2], T[4] * d[0] + T[5] * d[1] + T[6] * d[2], T[8] * d[0] + T[9] * d[1] + T[10] * d[2]];

/**
 * Elbow anchors (view space): forearms aim from the wrists back toward these. The pistols' (and the default): out to
 * each side and down, so the two forearms open into a V below the gun and leave the screen at its bottom edge instead
 * of standing up as two sleeves. Long guns set their own (GunDef.elbows): the support elbow tucks in under the gun,
 * so that sleeve drops out of view behind it right below the hand rather than crossing the screen.
 */
export const ELBOW: Record<"R" | "L", V3> = { R: [10, -20, -24], L: [10, 10, -24] };
/**
 * The support arm's working elbow (view space) while its hand is away from the grip (GunPose.leftArm: carrying the
 * silencer, on the Seed Drill's pod): low and a little in, so the forearm keeps coming up from the bottom of the
 * screen whatever the hand is doing (Astra, v0.0.38 QA: hand contact and a reachable arm as separate constraints).
 * GunDef.workElbow overrides it.
 */
export const WORK_ELBOW: V3 = [9, 3, -32];

export class GunPoser {
  readonly anim = new GunAnimator(null as unknown as GunDef);
  def: GunDef | null = null;
  /** The finger safety clamp (fingers.ts); off only in audits (to see the raw pose). */
  clamp = true;
  private rig = gunRig();
  private W: Float32Array;
  private right: SolvedHand | null = null;
  private left: SolvedHand | null = null;
  /** The left hand solved onto the silencer (null: no silencer). */
  private onSil: SolvedHand | null = null;
  private curlsSil = new Float32Array(20);
  private targets = new Map<string, Float32Array>();
  /** The right hand on a bolt action's knob (GunDef.places.bolt; relative to the bolt), or null. */
  private rightBolt: Float32Array | null = null;
  private poserR = new FingerPoser("R");
  private poserL = new FingerPoser("L");
  private curlsR = new Float32Array(20);
  private curlsL = new Float32Array(20);
  private cR = new Float32Array(20);
  private cL = new Float32Array(20);
  // Scratch.
  private G = new Float32Array(12);
  private T = new Float32Array(12);
  private T2 = new Float32Array(12);
  private T3 = new Float32Array(12);
  private C = new Float32Array(12);
  private C2 = new Float32Array(12);
  private C3 = new Float32Array(12);
  private C4 = new Float32Array(12);
  private pivot = new Float32Array(3);
  private H = new Float32Array(12);
  private prevLeft = new Float32Array(12);
  /** The left hand's final matrix as shown last frame, and the animator's crossfade count it was captured at. */
  private shownLeft = new Float32Array(12);
  private leftGen = -1;
  private hadLeft = false;
  private bones: { R: ArmBones; L: ArmBones };

  constructor() {
    const r = this.rig;
    this.W = new Float32Array(r.count * 12);
    for (let i = 0; i < r.count; i++) this.W.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], i * 12);
    this.W.set(r.hands.bind);
    this.bones = { R: armBones("R"), L: armBones("L") };
  }

  /** The gun (solves its holds in this glove style on first use, cached). `keepAnim`: same gun, new gloves. */
  setGun(def: GunDef | null, glove: GloveStyleId, keepAnim = false): void {
    this.def = def;
    this.hadLeft = false;
    this.swapK = 0;
    this.swapT = "";
    if (!def) return;
    this.right = solveHand(def, "R", glove);
    this.left = solveHand(def, "L", glove);
    flatCurls(this.right.curls, this.curlsR);
    flatCurls(this.left.curls, this.curlsL);
    this.onSil = solveSilencerHand(def, glove);
    if (this.onSil) flatCurls(this.onSil.curls, this.curlsSil);
    this.targets.clear();
    for (const [k, pl] of Object.entries(def.places)) if (pl && k !== "bolt") this.targets.set(k, handAt("L", pl));
    this.rightBolt = def.places.bolt ? handAt("R", def.places.bolt) : null;
    this.restSet(def, "R", this.right.handInGun);
    this.restSet(def, "L", this.left.handInGun);
    if (!keepAnim || this.anim.def !== def) this.anim.setGun(def);
  }

  /**
   * A wrist's resting set (flex, dev; deg): the hold at rest (the gun at its framing), the forearm toward the elbow
   * anchor as the hold was designed to be seen (ARM.anchor), inside the wrist's range; and where the wrist is then.
   */
  private restSet(def: GunDef, side: "R" | "L", handInGun: Float32Array): void {
    const G = this.C, H = this.C2, T = this.C3, b = this.bones[side], sb = sideBind(side);
    angleMatrix(def.frame.a[0], def.frame.a[1], def.frame.a[2], def.frame.o[0], def.frame.o[1], def.frame.o[2], G);
    concat(G, 0, handInGun, 0, H, 0);
    concat(H, 0, b.invHand, 0, T, 0);
    const e = def.elbows?.[side] ?? ELBOW[side], d = b.dir;
    const cur = mul3(T, d);
    const D = nrm3([H[3] - e[0], H[7] - e[1], H[11] - e[2]]);
    const k = ARM.anchor;
    const want = nrm3([D[0] * k + cur[0] * (1 - k), D[1] * k + cur[1] * (1 - k), D[2] * k + cur[2] * (1 - k)]);
    this.rest[side][0] = H[3];
    this.rest[side][1] = H[7];
    this.rest[side][2] = H[11];
    const [fl, dv] = handFrameAngles(T, sb.ax, sb.n, sb.across, want);
    const rg = wristRange(def, side);
    const lf = fl >= 0 ? rg.flex : rg.ext, ld = dv >= 0 ? rg.rad : rg.uln;
    const over = Math.sqrt((fl / lf) ** 2 + (dv / ld) ** 2);
    const k1 = over > 1 ? 1 / over : 1;
    this.set[side][0] = fl * k1;
    this.set[side][1] = dv * k1;
  }
  /** The wrists' resting sets (flex, dev; deg) and positions (view space, the gun at its framing). */
  private set = { R: [0, 0], L: [0, 0] };
  private rest = { R: [0, 0, 0], L: [0, 0, 0] };

  draw(): void {
    this.anim.draw();
    this.hadLeft = false;
    this.swapK = 0;
    this.swapT = "";
  }

  /** Advances the animation by dt and poses every bone. */
  update(dt: number): void {
    if (!this.def) return;
    this.anim.update(dt);
    this.dt = dt;
    this.pose(this.def, this.anim.pose);
  }
  private dt = 0;
  /** The recoil's rigid move this frame (view space) and its inverse; scratch for its parts. */
  private Q = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  private Qi = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  private ra: V3 = [0, 0, 0];
  private ro: V3 = [0, 0, 0];
  /**
   * A support hand switching targets inside a clip (the Seed Drill's pod to its charging handle): the hand and its
   * fingers ease over from where they were shown (SWAP_TIME) instead of cutting. 0 = none; snapped by a seek (dt 0).
   */
  private swapK = 0;
  private swapT = "";
  private swapFrom = new Float32Array(12);
  private swapCurls = new Float32Array(20);
  private shownCurls = new Float32Array(20);

  private partMatrix(part: GunPart): number {
    return this.rig.part(part) * 12;
  }

  /** Bone index of a gun part (bonesW offsets are index * 12). */
  partIndex(part: GunPart): number {
    return this.rig.part(part);
  }

  private pose(def: GunDef, p: GunPose): void {
    const W = this.W, r = this.rig, R = this.right!, L = this.left!;
    const G = this.G, T = this.T, T2 = this.T2;
    // --- Gun: framing * (offset, rotation about the right grip).
    const fr = def.frame;
    const piv = def.right.o;
    angleMatrix(fr.a[0], fr.a[1], fr.a[2], fr.o[0], fr.o[1], fr.o[2], T);
    angleMatrix(p.a[0], p.a[1], p.a[2], 0, 0, 0, T2);
    // T2 about the pivot: p + R (x - p)
    T2[3] = piv[0] - (T2[0] * piv[0] + T2[1] * piv[1] + T2[2] * piv[2]);
    T2[7] = piv[1] - (T2[4] * piv[0] + T2[5] * piv[1] + T2[6] * piv[2]);
    T2[11] = piv[2] - (T2[8] * piv[0] + T2[9] * piv[1] + T2[10] * piv[2]);
    concat(T, 0, T2, 0, G, 0);
    // View-space offset (forward, left, up) on top.
    G[3] += p.o[0];
    G[7] += p.o[1];
    G[11] += p.o[2];
    // The recoil's share of that (a view-space rigid move, Q = G * inverse(G without it)): the forearms take it with the
    // hands (arm()), so a kick moves the arms rather than bending the wrists.
    this.anim.recoilPart(this.ra, this.ro);
    angleMatrix(p.a[0] - this.ra[0], p.a[1] - this.ra[1], p.a[2] - this.ra[2], 0, 0, 0, T2);
    T2[3] = piv[0] - (T2[0] * piv[0] + T2[1] * piv[1] + T2[2] * piv[2]);
    T2[7] = piv[1] - (T2[4] * piv[0] + T2[5] * piv[1] + T2[6] * piv[2]);
    T2[11] = piv[2] - (T2[8] * piv[0] + T2[9] * piv[1] + T2[10] * piv[2]);
    concat(T, 0, T2, 0, this.Q, 0);
    this.Q[3] += p.o[0] - this.ro[0];
    this.Q[7] += p.o[1] - this.ro[1];
    this.Q[11] += p.o[2] - this.ro[2];
    invert34(this.Q, 0, this.Qi, 0);
    concat(G, 0, this.Qi, 0, this.Q, 0);
    invert34(this.Q, 0, this.Qi, 0);
    const gi = this.partMatrix("Gun");
    W.set(G, gi);
    // --- Parts.
    translateLocal(G, -p.slide, 0, 0, W, this.partMatrix("Slide"));
    translateLocal(G, -p.pump, 0, 0, W, this.partMatrix("Pump"));
    if (def.bolt && p.bolt) {
      // A bolt action: turned up about its own axis (nose of the handle rising), then drawn back.
      const pi = this.partMatrix("Pump");
      rotX(def.bolt.side * p.bolt * D2R, def.bolt.axis[0], def.bolt.axis[1], this.C);
      concat(W, pi, this.C, 0, this.C2, 0);
      W.set(this.C2, pi);
    }
    // The trigger swings back about its pivot with the squeeze.
    const ti = this.partMatrix("Trig");
    if (def.trigger && p.trigger > 0) {
      rotY(TRIGGER_DEG * D2R * Math.min(1, p.trigger), def.trigger[0], def.trigger[2], this.C);
      concat(G, 0, this.C, 0, W, ti);
    } else W.set(G, ti);
    // --- Right hand on the grip (rides the gun), fingers from the solved curls.
    const hR = this.bones.R.hand * 12;
    concat(G, 0, R.handInGun, 0, W, hR);
    if (p.rightW > 0 && this.rightBolt) {
      // Off the grip onto the bolt knob, riding the bolt (turned and drawn back with it).
      concat(W, this.partMatrix("Pump"), this.rightBolt, 0, T, 0);
      for (let i = 0; i < 12; i++) this.C[i] = W[hR + i];
      lerpRigid(this.C, T, p.rightW, this.C2);
      W.set(this.C2, hR);
    }
    const cR = this.cR;
    cR.set(this.curlsR);
    // Trigger squeeze (index MCP / PIP), index off the trigger along the frame, the thumb flick.
    const sq = p.trigger;
    cR[0] += 10 * sq;
    cR[1] += 14 * sq;
    cR[2] += 6 * sq;
    if (p.indexOff > 0) for (let k = 0; k < 3; k++) cR[k] += (INDEX_OFF[k] - cR[k]) * p.indexOff;
    if (p.thumb > 0) {
      cR[17] += 18 * p.thumb;
      cR[18] += 10 * p.thumb;
    }
    if (p.rightW > 0) for (let i = 0; i < 20; i++) cR[i] += (PRESETS.pinch[i] - cR[i]) * p.rightW;
    this.poserR.pose(W, (i, k) => cR[i * 4 + k], (i) => cR[i * 4 + 3]);
    // --- Left hand: support (on the gun / the pump), or a target, plus a view-space trip.
    const hL = this.bones.L.hand * 12;
    const support = def.left.part === "Pump" ? this.partMatrix("Pump") : gi;
    concat(W, support, L.handInGun, 0, this.H, 0);
    const tgt = p.leftT ? this.targets.get(p.leftT) : undefined;
    if (p.leftT === "sil" && this.onSil && p.leftW > 0) {
      // Around the can: the can's frame with the hand's own roll (it rolls back between twists while the can stays),
      // lifted off radially in a re-grip; the hand rides it.
      this.canFrame(def, p, p.handRoll, p.handLift, this.C);
      concat(G, 0, this.C, 0, this.C2, 0);
      concat(this.C2, 0, this.onSil.handInGun, 0, T, 0);
      lerpRigid(this.H, T, p.leftW, this.H);
    } else if (tgt && p.leftW > 0) {
      // On a target; the magazine target rides with the magazine's travel.
      if (p.leftT === "mag" && p.magHand && def.mag) {
        translateLocal(G, def.mag.out[0] * p.mag, def.mag.out[1] * p.mag, def.mag.out[2] * p.mag, this.T3, 0);
        concat(this.T3, 0, tgt, 0, T, 0);
      } else if (p.leftT === "rack" && def.bolt) concat(W, this.partMatrix("Pump"), tgt, 0, T, 0);
      else concat(G, 0, tgt, 0, T, 0);
      lerpRigid(this.H, T, p.leftW, this.H);
    }
    this.H[3] += p.leftOff[0];
    this.H[7] += p.leftOff[1];
    this.H[11] += p.leftOff[2];
    // Crossfade from the left hand as it was shown when the new clip started (a target can't be blended by name; a
    // crossfade interrupted by another starts from where the hand had got to, not from the older clip's hand).
    if (this.anim.leftFadeGen !== this.leftGen) {
      this.leftGen = this.anim.leftFadeGen;
      this.prevLeft.set(this.hadLeft ? this.shownLeft : this.H);
    }
    if (this.anim.leftFade > 0 && this.hadLeft) lerpRigid(this.H, this.prevLeft, this.anim.leftFade * this.anim.leftFade * (3 - 2 * this.anim.leftFade), this.H);
    // A target switch inside a clip (no crossfade of its own): ease over from the hand as shown.
    const tNow = p.leftW > 0.01 ? p.leftT : "";
    if (tNow !== this.swapT) {
      if (this.swapT && tNow && this.hadLeft && this.dt > 0 && this.anim.leftFade <= 0) {
        this.swapK = 1;
        this.swapFrom.set(this.shownLeft);
        this.swapCurls.set(this.shownCurls);
      }
      this.swapT = tNow;
    }
    if (this.dt <= 0) this.swapK = 0;
    else if (this.swapK > 0) this.swapK = Math.max(0, this.swapK - this.dt / SWAP_TIME);
    const swapW = this.swapK * this.swapK * (3 - 2 * this.swapK);
    if (swapW > 0) lerpRigid(this.H, this.swapFrom, swapW, this.H);
    this.shownLeft.set(this.H);
    this.hadLeft = true;
    W.set(this.H, hL);
    const cL = this.cL;
    cL.set(this.curlsL);
    if (p.leftCurl !== "support" && p.leftCurlW > 0) {
      // The silencer grip only means something on the can: elsewhere (blending in / out) it follows the target weight.
      const pre = p.leftCurl === "sil" ? (this.onSil ? this.curlsSil : PRESETS.mag) : PRESETS[p.leftCurl];
      const w = Math.min(1, p.leftCurl === "sil" ? p.leftCurlW * p.leftW : p.leftCurlW);
      for (let i = 0; i < 20; i++) cL[i] += (pre[i] - cL[i]) * w;
    }
    if (p.leftOpen > 0) {
      const pre = PRESETS.open;
      const w = Math.min(1, p.leftOpen);
      for (let i = 0; i < 20; i++) cL[i] += (pre[i] - cL[i]) * w;
    }
    if (swapW > 0) for (let i = 0; i < 20; i++) cL[i] += (this.swapCurls[i] - cL[i]) * swapW;
    this.shownCurls.set(cL);
    this.poserL.pose(W, (i, k) => cL[i * 4 + k], (i) => cL[i * 4 + 3]);
    // --- Magazine: seated / sliding out along its axis / falling, or in the left hand.
    const mi = this.partMatrix("Mag");
    if (p.magHide) W.fill(0, mi, mi + 12);
    else if (def.mag) {
      const out = def.mag.out;
      if (p.magHand) {
        const mt = this.targets.get("mag");
        if (mt) {
          // W[mag] = W[left hand] * inverse(hand at "mag") * T(out * mag)
          invert34(mt, 0, T, 0);
          concat(W, hL, T, 0, T2, 0);
          translateLocal(T2, out[0] * p.mag, out[1] * p.mag, out[2] * p.mag, W, mi);
        } else W.set(G, mi);
      } else {
        translateLocal(G, out[0] * p.mag, out[1] * p.mag, out[2] * p.mag, W, mi);
        if (p.magSpin) {
          // Tumbling as it falls: about gun-local y through its pivot.
          const mp = def.mag.p;
          rotY(p.magSpin * D2R, mp[0], mp[2], this.C);
          concat(W, mi, this.C, 0, this.C2, 0);
          W.set(this.C2, mi);
        }
        W[mi + 3] += p.magDrop[0];
        W[mi + 7] += p.magDrop[1];
        W[mi + 11] += p.magDrop[2];
      }
    } else W.set(G, mi);
    // --- The left hand's shell (Aux): built seated in the port; rides in the fingers, then slides in.
    const ai = this.partMatrix("Aux");
    const port = this.targets.get("port");
    if (p.aux > 0 && port) {
      invert34(port, 0, T, 0);
      concat(W, hL, T, 0, T2, 0);
      // Before it's in: back out of the port toward the hand (gun-local -x, down).
      const k = 1 - p.auxIn;
      translateLocal(T2, -1.3 * k, 0, -0.6 * k, W, ai);
    } else if (def.id === "fiveseven") {
      // The Jackrabbit's ears ride the slide and flop back / forward about their base (p.tail: shots, the inspect).
      const si = this.partMatrix("Slide");
      if (p.tail) {
        rotY(-p.tail * 0.38, EAR_C[0], EAR_C[2], this.C);
        concat(W, si, this.C, 0, this.C2, 0);
        W.set(this.C2, ai);
      } else W.copyWithin(ai, si, si + 12);
    } else if (def.id === "usp" || def.id === "p90") {
      // The Cottontail's tail / the Seed Drill's pod lid ride the slide / the magazine with a wobble (scale).
      const base = def.id === "usp" ? this.partMatrix("Slide") : mi;
      W.copyWithin(ai, base, base + 12);
      if (p.tail) scaleAbout(W, ai, def.id === "usp" ? TAIL_C : POD_C, 1 + 0.18 * p.tail, 1 - 0.12 * p.tail);
    } else W.fill(0, ai, ai + 12);
    // --- The silencer: on the bore (turned, wound out along the thread) or carried; collapsed while it's off.
    const si = this.partMatrix("Sil");
    if (def.silencer && p.sil > 0) {
      this.canFrame(def, p, p.silSpin, 0, this.C);
      concat(G, 0, this.C, 0, W, si);
    } else W.fill(0, si, si + 12);
    // --- Forearms toward the elbows; wrist helpers with the hands.
    this.arm("R");
    this.arm("L");
    // Safety net: no finger joint past its range on either hand (audits turn it off to check the raw pose).
    if (this.clamp) clampFingers(W, r.hands, "both");
  }

  /**
   * The can's frame (gun-local; the can is built seated, so this is its bone's matrix relative to the gun): turned by
   * `spin` about the bore, `lift` units off it radially (the hand's re-grip), wound out silX along the bore, tilted
   * about its seat (silPitch / silYaw) and offset (silOff) while it's carried.
   */
  private canFrame(def: GunDef, p: GunPose, spin: number, lift: number, out: Float32Array): void {
    const sil = def.silencer!;
    const ay = sil.axis[0], az = sil.axis[1];
    const S = this.C3, R = this.C4, pv = this.pivot;
    // Spin about the bore (x through (ay, az)); a lift moves it out along the turned "up" (the side the knuckles are).
    pv[0] = 0, pv[1] = ay, pv[2] = az;
    rotAbout(X_AXIS, spin * D2R, pv, S);
    if (lift) {
      const r = spin * D2R;
      S[7] += -Math.sin(r) * lift;
      S[11] += Math.cos(r) * lift;
    }
    S[3] += p.silX;
    // Tilt about the seat: pitch (nose up) about -y, yaw (nose left) about z.
    pv[0] = sil.seat;
    if (p.silPitch || p.silYaw) {
      rotAbout(Y_NEG, p.silPitch * D2R, pv, R);
      concat(R, 0, S, 0, out, 0);
      rotAbout(Z_AXIS, p.silYaw * D2R, pv, R);
      concat(R, 0, out, 0, S, 0);
    }
    out.set(S);
    out[3] += p.silOff[0];
    out[7] += p.silOff[1];
    out[11] += p.silOff[2];
  }

  /** Re-aims a forearm from its posed wrist back toward the elbow anchor (minimal swing of the hand's rigid move). */
  private arm(side: "R" | "L"): void {
    const W = this.W, b = this.bones[side], r = this.rig.hands;
    const h = b.hand * 12;
    // Rigid move of the hand from bind: Gh = W[hand] * inverse(bind[hand]).
    concat(W, h, b.invHand, 0, this.T, 0);
    const wrist: V3 = [W[h + 3], W[h + 7], W[h + 11]];
    const T = this.T;
    // Bind forearm direction (elbow -> wrist), carried by the hand's move.
    const d = b.dir;
    const cur: V3 = [T[0] * d[0] + T[1] * d[1] + T[2] * d[2], T[4] * d[0] + T[5] * d[1] + T[6] * d[2], T[8] * d[0] + T[9] * d[1] + T[10] * d[2]];
    // The elbow anchor travels with the hand (ARM.carry of the wrist's way from its rest: the gun drawn up from below,
    // pushed out in a reload, the support hand down for a magazine): the arm moves with it rather than pivoting the
    // forearm about a fixed point, which would stand the sleeve up once the hand dropped below it.
    // Worked out without the recoil's move, then moved with it (Q): the kick carries the elbow along with the hand.
    const e0 = this.def?.elbows?.[side] ?? ELBOW[side], wr = this.rest[side], Qi = this.Qi, Q = this.Q;
    const wn: V3 = [
      Qi[0] * wrist[0] + Qi[1] * wrist[1] + Qi[2] * wrist[2] + Qi[3],
      Qi[4] * wrist[0] + Qi[5] * wrist[1] + Qi[6] * wrist[2] + Qi[7],
      Qi[8] * wrist[0] + Qi[9] * wrist[1] + Qi[10] * wrist[2] + Qi[11],
    ];
    const en: V3 = [e0[0] + (wn[0] - wr[0]) * ARM.carry, e0[1] + (wn[1] - wr[1]) * ARM.carry, e0[2] + (wn[2] - wr[2]) * ARM.carry];
    let e: V3 = [
      Q[0] * en[0] + Q[1] * en[1] + Q[2] * en[2] + Q[3],
      Q[4] * en[0] + Q[5] * en[1] + Q[6] * en[2] + Q[7],
      Q[8] * en[0] + Q[9] * en[1] + Q[10] * en[2] + Q[11],
    ];
    // Away from the grip (the support hand off to the can / pod: leftArm; the firing hand on a bolt: rightW) the
    // forearm heads for its working elbow, fully: the hand's resting set means nothing there.
    const work = Math.max(0, Math.min(1, side === "L" ? this.anim.pose.leftArm : this.anim.pose.rightW));
    if (side === "L" && work > 0) {
      const we = this.def?.workElbow ?? WORK_ELBOW;
      e = [e[0] + (we[0] - e[0]) * work, e[1] + (we[1] - e[1]) * work, e[2] + (we[2] - e[2]) * work];
    }
    const sb = sideBind(side);
    const A = mul3(T, sb.ax), N = mul3(T, sb.n), C = mul3(T, sb.across);
    // The wrist at its resting set: the forearm along the hand's line bent by the set.
    const st = this.set[side], tf0 = Math.tan(st[0] * D2R), td0 = Math.tan(st[1] * D2R);
    const nat = nrm3([A[0] - tf0 * N[0] - td0 * C[0], A[1] - tf0 * N[1] - td0 * C[1], A[2] - tf0 * N[2] - td0 * C[2]]);
    // Toward the elbow anchor.
    const D = nrm3([wrist[0] - e[0], wrist[1] - e[1], wrist[2] - e[2]]);
    // Mostly toward the elbow anchor; fully while working away from the grip (the hand's own line says nothing then).
    let k = ARM.anchor;
    if (side === "L") k += (1 - k) * work;
    const off = side === "R" ? work : Math.max(0, Math.min(1, Math.max(this.anim.pose.leftW, Math.hypot(this.anim.pose.leftOff[0], this.anim.pose.leftOff[1], this.anim.pose.leftOff[2]) / 3)));
    let want = slerp3(nat, D, k);
    // Keep the wrist in its natural range (WRIST): if that asks for more, the forearm stops where the range's edge (an
    // ellipse in flexion / deviation) crosses the arc from the resting set toward it (continuous: no side flips).
    const rg = this.range(side, Math.max(off, work));
    // A hand off its grip and out of view (fetching a magazine, carrying the can below the screen): its wrist is free,
    // as before (nobody sees it; the forearm keeps heading for its elbow, so the sleeve stays out of view).
    let hide = Math.max(off, work) * outOfView(wrist, A);
    if (side === "L" && this.def?.silencer?.freeWrist && this.anim.pose.leftT === "sil") hide = Math.max(hide, Math.min(1, this.anim.pose.leftW));
    if (hide > 0) for (const q of ["ext", "flex", "uln", "rad"] as const) rg[q] += (179 - rg[q]) * hide;
    const outside = (v: V3) => {
      const [fl, dv] = handFrameAngles(T, sb.ax, sb.n, sb.across, v);
      return (fl / (fl >= 0 ? rg.flex : rg.ext)) ** 2 + (dv / (dv >= 0 ? rg.rad : rg.uln)) ** 2 > 1;
    };
    if (outside(want)) {
      let lo = 0, hi = 1;
      for (let it = 0; it < 14; it++) {
        const mid = (lo + hi) / 2;
        if (outside(slerp3(nat, want, mid))) hi = mid;
        else lo = mid;
      }
      want = slerp3(nat, want, lo);
    }
    const ax: V3 = [cur[1] * want[2] - cur[2] * want[1], cur[2] * want[0] - cur[0] * want[2], cur[0] * want[1] - cur[1] * want[0]];
    const s = Math.hypot(ax[0], ax[1], ax[2]);
    const c = cur[0] * want[0] + cur[1] * want[1] + cur[2] * want[2];
    if (s > 1e-6) rotAbout([ax[0] / s, ax[1] / s, ax[2] / s], Math.atan2(s, c), wrist, this.T2);
    else this.T2.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    concat(this.T2, 0, T, 0, this.T3, 0);
    for (const i of b.forearm) concat(this.T3, 0, r.bind, i * 12, W, i * 12);
    // Wrist twist helper halfway (the cuff follows the hand's roll half way).
    for (const i of b.helper) concat(T, 0, r.bind, i * 12, W, i * 12);
  }


  /**
   * A wrist's range now (wristRange): opened toward the working range as the firing hand works a bolt (rightW) or
   * the support hand leaves its grip (`off`: a target, a trip, leftArm).
   */
  private range(side: "R" | "L", off: number): WristRange {
    return wristRange(this.def, side, off, this.rg);
  }
  private rg: WristRange = { ext: 0, flex: 0, uln: 0, rad: 0 };

  /** Posed bone matrices (Source viewmodel space, 3x4 per bone; audits / fx). */
  get bonesW(): Float32Array {
    return this.W;
  }

  /** A gun-local point on a part, posed (viewmodel space). */
  pointOn(part: GunPart, p: ArrayLike<number>): V3 {
    const o = this.partMatrix(part), W = this.W;
    return [W[o] * p[0] + W[o + 1] * p[1] + W[o + 2] * p[2] + W[o + 3], W[o + 4] * p[0] + W[o + 5] * p[1] + W[o + 6] * p[2] + W[o + 7], W[o + 8] * p[0] + W[o + 9] * p[1] + W[o + 10] * p[2] + W[o + 11]];
  }

  /** A gun-local direction on a part, posed (viewmodel space). */
  dirOn(part: GunPart, d: ArrayLike<number>): V3 {
    const o = this.partMatrix(part), W = this.W;
    return [W[o] * d[0] + W[o + 1] * d[1] + W[o + 2] * d[2], W[o + 4] * d[0] + W[o + 5] * d[1] + W[o + 6] * d[2], W[o + 8] * d[0] + W[o + 9] * d[1] + W[o + 10] * d[2]];
  }
}

const D2R = Math.PI / 180;
/** A support hand's switch between targets inside a clip eases over this long (s). */
const SWAP_TIME = 0.14;
/** How far the trigger swings back at a full squeeze (deg). */
const TRIGGER_DEG = 16;

/** out = rotation about gun-local y through (x, *, z) by `a` (rad; + swings a point below the pivot back, toward -x). */
function rotY(a: number, x: number, z: number, out: Float32Array): void {
  const c = Math.cos(a), s = Math.sin(a);
  out[0] = c, out[1] = 0, out[2] = s, out[3] = x - (c * x + s * z);
  out[4] = 0, out[5] = 1, out[6] = 0, out[7] = 0;
  out[8] = -s, out[9] = 0, out[10] = c, out[11] = z - (-s * x + c * z);
}

/** out = rotation about gun-local x through (*, y, z) by `a` (rad). */
function rotX(a: number, y: number, z: number, out: Float32Array): void {
  const c = Math.cos(a), s = Math.sin(a);
  out[0] = 1, out[1] = 0, out[2] = 0, out[3] = 0;
  out[4] = 0, out[5] = c, out[6] = -s, out[7] = y - (c * y - s * z);
  out[8] = 0, out[9] = s, out[10] = c, out[11] = z - (s * y + c * z);
}
const X_AXIS: V3 = [1, 0, 0], Y_NEG: V3 = [0, -1, 0], Z_AXIS: V3 = [0, 0, 1];

/** Cottontail's tail ball centre / the Seed Drill's pod centre (gun-local), for their wobble. */
const TAIL_C: V3 = [-1.0, 0, 1.0];
const POD_C: V3 = [-5.9, 0, 1.75];
/** The Jackrabbit's ears' base (gun-local), their flop pivot. */
const EAR_C: V3 = [-0.25, 0, 1.5];

interface ArmBones {
  hand: number;
  forearm: number[];
  helper: number[];
  invHand: Float32Array;
  /** Bind forearm direction (elbow -> wrist). */
  dir: V3;
}

const armBonesCache: Partial<Record<"R" | "L", ArmBones>> = {};
function armBonesOf(side: "R" | "L"): ArmBones {
  return (armBonesCache[side] ??= armBones(side));
}

function armBones(side: "R" | "L"): ArmBones {
  const r = gunRig().hands;
  const B = (n: string) => r.bone(n);
  const hand = B(side === "R" ? "Right_Hand" : "Left_Hand");
  const forearm = (side === "R" ? ["Root36", "Right_Arm", "eff18", "Root23"] : ["Root34", "Left_Arm", "eff16", "Root16"]).map(B);
  const helper = (side === "R" ? ["Root98", "R_wrist_helper"] : ["Root99", "L_wrist_helper"]).map(B);
  const invHand = new Float32Array(12);
  invert34(r.bind, hand * 12, invHand, 0);
  const w = r.at(side === "R" ? "Right_Hand" : "Left_Hand"), a = r.at(side === "R" ? "Right_Arm" : "Left_Arm");
  const d: V3 = [w[0] - a[0], w[1] - a[1], w[2] - a[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return { hand, forearm, helper, invHand, dir: [d[0] / l, d[1] / l, d[2] / l] };
}

/** out[oo..] = M * T(x, y, z) (a translation in M's local frame). */
function translateLocal(M: ArrayLike<number>, x: number, y: number, z: number, out: Float32Array, oo: number): void {
  for (let r = 0; r < 3; r++) {
    const a0 = M[r * 4], a1 = M[r * 4 + 1], a2 = M[r * 4 + 2];
    out[oo + r * 4] = a0;
    out[oo + r * 4 + 1] = a1;
    out[oo + r * 4 + 2] = a2;
    out[oo + r * 4 + 3] = M[r * 4 + 3] + a0 * x + a1 * y + a2 * z;
  }
}

/** W[o] = W[o] * S where S scales about local point c (sx along x, s across). */
function scaleAbout(W: Float32Array, o: number, c: V3, sx: number, s: number): void {
  const k = [sx, s, s];
  // W * T(c) * S * T(-c): columns scaled, translation adjusted.
  const t = [0, 0, 0];
  for (let r = 0; r < 3; r++) {
    let off = 0;
    for (let j = 0; j < 3; j++) off += W[o + r * 4 + j] * c[j] * (1 - k[j]);
    t[r] = off;
  }
  for (let r = 0; r < 3; r++) {
    for (let j = 0; j < 3; j++) W[o + r * 4 + j] *= k[j];
    W[o + r * 4 + 3] += t[r];
  }
}

const qa = new Float64Array(4), qb = new Float64Array(4);

function quatOf(m: ArrayLike<number>, q: Float64Array): void {
  const m00 = m[0], m01 = m[1], m02 = m[2], m10 = m[4], m11 = m[5], m12 = m[6], m20 = m[8], m21 = m[9], m22 = m[10];
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    (q[3] = 0.25 * s), (q[0] = (m21 - m12) / s), (q[1] = (m02 - m20) / s), (q[2] = (m10 - m01) / s);
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    (q[3] = (m21 - m12) / s), (q[0] = 0.25 * s), (q[1] = (m01 + m10) / s), (q[2] = (m02 + m20) / s);
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    (q[3] = (m02 - m20) / s), (q[0] = (m01 + m10) / s), (q[1] = 0.25 * s), (q[2] = (m12 + m21) / s);
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    (q[3] = (m10 - m01) / s), (q[0] = (m02 + m20) / s), (q[1] = (m12 + m21) / s), (q[2] = 0.25 * s);
  }
}

/** out = blend of rigid transforms a -> b by w (quaternion nlerp, linear translation); out may alias a. */
export function lerpRigid(a: ArrayLike<number>, b: ArrayLike<number>, w: number, out: Float32Array): void {
  if (w <= 0) {
    if (out !== a) for (let i = 0; i < 12; i++) out[i] = a[i];
    return;
  }
  if (w >= 1) {
    for (let i = 0; i < 12; i++) out[i] = b[i];
    return;
  }
  quatOf(a, qa);
  quatOf(b, qb);
  const s = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3] < 0 ? -1 : 1;
  let x = qa[0] + (qb[0] * s - qa[0]) * w, y = qa[1] + (qb[1] * s - qa[1]) * w, z = qa[2] + (qb[2] * s - qa[2]) * w, q = qa[3] + (qb[3] * s - qa[3]) * w;
  const l = Math.hypot(x, y, z, q) || 1;
  (x /= l), (y /= l), (z /= l), (q /= l);
  const tx = a[3] + (b[3] - a[3]) * w, ty = a[7] + (b[7] - a[7]) * w, tz = a[11] + (b[11] - a[11]) * w;
  out[0] = 1 - 2 * (y * y + z * z), out[1] = 2 * (x * y - z * q), out[2] = 2 * (x * z + y * q), out[3] = tx;
  out[4] = 2 * (x * y + z * q), out[5] = 1 - 2 * (x * x + z * z), out[6] = 2 * (y * z - x * q), out[7] = ty;
  out[8] = 2 * (x * z - y * q), out[9] = 2 * (y * z + x * q), out[10] = 1 - 2 * (x * x + y * y), out[11] = tz;
}

