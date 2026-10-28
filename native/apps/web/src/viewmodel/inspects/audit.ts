// Hand / finger animation audit (dev tool + unit test apps/api/test/finger-audit.test.ts; nothing in the game imports
// it). Plays every viewmodel animation of every knife through the same layers as viewmodel.ts pose() (base action ->
// knife hold -> inspect -> extra knife bones -> finger clamp) and checks each frame:
//   joints     every finger / thumb joint of both hands inside fingers.ts LIMITS (negative flexion past the limit =
//              bending backwards)
//   knife      finger / thumb capsules vs the knife's own vertices (its first-person mesh, skinned like the GPU does):
//              no deeper than the same finger already is in that knife's idle hold (+ tolerance)
//   crossing   neighbouring fingers' capsules overlapping more than in the idle hold
// Scenarios per knife: idle, draw, slash1, slash2, stab; every trick of its inspect chain played straight; the chain by
// taps (tap / next / cap), F spam, hold-to-loop, attack cancels at many points (crossfade into the swing), a press during
// the settle (chain crossfade) and a draw cancel.
//
// The base is procedural.ts (CI has no hosted content); tools/viewmodel/finger-audit.ts runs the same scenarios on
// v_knife_t's sequences when content-cache/ has them. The left-handed viewmodel is a mirror of the whole pose (render
// time), which leaves every joint angle and distance unchanged; the rig's left-hand bones are audited as posed.

import { carrot } from "../knives/carrot";
import { KnifeHold } from "../knives/hold";
import type { KnifeDef } from "../knives/types";
import { clampFingers, readFingers, type JointReading } from "../fingers";
import { viewmodelGeometry } from "../mesh";
import { PROC_DURATION, VmProcedural, type VmAction } from "../procedural";
import { vmRig, type VmRig } from "../rig";
import { VmInspect } from "./runtime";
import { gloveCapsules } from "../gloves/caps";
import type { GloveStyleId } from "../../loadout";
import { GRIP_SKIN } from "../knives/hold";
import { PART } from "../knives/types";

export interface AuditOptions {
  /** Frames per second (default 120). */
  rate?: number;
  /** Apply the finger safety clamp (as the game does). */
  clamp?: boolean;
  /** Use every n-th knife vertex for the knife check (default 2). */
  vertexStride?: number;
  /** Degrees past a limit before a joint counts (default 0.5). */
  jointTol?: number;
  /** Units deeper than the idle hold before knife / crossing contact counts (default 0.12). */
  depthTol?: number;
  /** Base pose source: procedural (default) or a function posing v_knife_t's action at t (hosted path). */
  base?: (action: VmAction, t: number, W: Float32Array) => void;
  /** Durations of the actions for that base (default procedural.ts PROC_DURATION). */
  durations?: Record<VmAction, number>;
  /** Restrict to these scenario names. */
  only?: string[];
  /**
   * Glove style: its extra parts (gloves/caps.ts: straps, gauntlet cuffs, the moto knuckle plate, wrap tails) join the
   * finger segments in the knife check, so a knife may not newly sink into them either. Default knit (none).
   */
  glove?: GloveStyleId;
}

export interface Violation {
  kind: "joint" | "knife" | "crossing";
  scenario: string;
  t: number;
  what: string;
  /** Degrees past the limit (joint) or units past the allowance (knife / crossing). */
  amount: number;
}

export interface ScenarioResult {
  knife: string;
  scenario: string;
  frames: number;
  joint: number;
  knifeHits: number;
  crossing: number;
  worst: Violation | null;
}

const FINGER_R: Record<string, number> = { index: 0.4, middle: 0.42, ring: 0.4, pinky: 0.35, thumb: 0.46 };

function segDist(p: ArrayLike<number>, a: number[], b: number[]): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
  const l = abx * abx + aby * aby + abz * abz;
  const t = l > 1e-9 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / l)) : 0;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function segSeg(p1: number[], q1: number[], p2: number[], q2: number[]): number {
  // Sampled closest distance (5 points each way) is plenty for finger segments.
  let best = Infinity;
  for (let i = 0; i <= 4; i++) {
    const u = i / 4;
    const p = [p1[0] + (q1[0] - p1[0]) * u, p1[1] + (q1[1] - p1[1]) * u, p1[2] + (q1[2] - p1[2]) * u];
    best = Math.min(best, segDist(p, p2, q2));
  }
  for (let i = 0; i <= 4; i++) {
    const u = i / 4;
    const p = [p2[0] + (q2[0] - p2[0]) * u, p2[1] + (q2[1] - p2[1]) * u, p2[2] + (q2[2] - p2[2]) * u];
    best = Math.min(best, segDist(p, p1, q1));
  }
  return best;
}

interface Seg {
  name: string;
  digit: string;
  a: number[];
  b: number[];
  r: number;
  /** Glove parts (gloves/caps.ts): depth counted only through the shell the glove adds over this radius. */
  base?: number;
  /** Glove parts with an exact depth (gloves/caps.ts GloveCapsule.depth). */
  depth?(p: ArrayLike<number>): number;
}

/** Finger / thumb segments of the right hand (fingertips from the third bone's x axis, like mesh.ts). */
function fingerSegs(W: Float32Array, r: VmRig): Seg[] {
  const out: Seg[] = [];
  for (const [d, n, tip] of [
    ["index", "Right_Index", 0.92],
    ["middle", "Right_Middle", 0.98],
    ["ring", "Right_Ring", 0.92],
    ["pinky", "Right_Pinky", 0.8],
    ["thumb", "Right_Thumb", 1.02],
  ] as const) {
    const b = [1, 2, 3].map((k) => r.bone(`${n}0${k}`));
    const p = b.map((i) => [W[i * 12 + 3], W[i * 12 + 7], W[i * 12 + 11]]);
    const x = [W[b[2] * 12], W[b[2] * 12 + 4], W[b[2] * 12 + 8]];
    const l = Math.hypot(x[0], x[1], x[2]) || 1;
    const t = [p[2][0] + (x[0] / l) * tip, p[2][1] + (x[1] / l) * tip, p[2][2] + (x[2] / l) * tip];
    const R = FINGER_R[d];
    out.push({ name: `${d}1`, digit: d, a: p[0], b: p[1], r: R }, { name: `${d}2`, digit: d, a: p[1], b: p[2], r: R * 0.95 }, { name: `${d}3`, digit: d, a: p[2], b: t, r: R * 0.85 });
  }
  return out;
}

/** The knife's vertices (bone-local) from its first-person mesh: every vertex skinned to a knife bone. */
interface KnifeCloud {
  bone: Int16Array;
  local: Float32Array;
  /** 1 = the knife's grip (finishUV part PART.grip). */
  grip: Uint8Array;
  n: number;
}

const clouds = new Map<string, KnifeCloud>();

function knifeCloud(knife: KnifeDef | null, r: VmRig, stride: number): KnifeCloud {
  const key = `${knife?.id ?? "carrot"}/${stride}`;
  let c = clouds.get(key);
  if (c) return c;
  const g = knife ? viewmodelGeometry(knife) : viewmodelGeometry();
  const P = g.getAttribute("position"), SI = g.getAttribute("skinIndex"), SW = g.getAttribute("skinWeight"), F = g.getAttribute("finishUV");
  const knifeBones = new Set<number>([r.bone("knife_Parent"), r.bone("Knife_Handle")]);
  for (let i = r.extra; i < r.names.length; i++) knifeBones.add(i);
  const bones: number[] = [], local: number[] = [], grip: number[] = [];
  for (let v = 0; v < P.count; v += stride) {
    let bi = -1, bw = 0;
    for (let k = 0; k < 4; k++) if (SW.getComponent(v, k) > bw) (bw = SW.getComponent(v, k)), (bi = SI.getComponent(v, k));
    if (!knifeBones.has(bi)) continue;
    const o = bi * 12;
    const x = P.getX(v), y = P.getY(v), z = P.getZ(v);
    const iv = r.inv;
    bones.push(bi);
    grip.push(F && Math.round(F.getZ(v)) === PART.grip ? 1 : 0);
    local.push(iv[o] * x + iv[o + 1] * y + iv[o + 2] * z + iv[o + 3], iv[o + 4] * x + iv[o + 5] * y + iv[o + 6] * z + iv[o + 7], iv[o + 8] * x + iv[o + 9] * y + iv[o + 10] * z + iv[o + 11]);
  }
  c = { bone: Int16Array.from(bones), local: Float32Array.from(local), grip: Uint8Array.from(grip), n: bones.length };
  clouds.set(key, c);
  return c;
}

/** Deepest knife vertex inside each finger segment capsule (units; <= 0 = none). */
function knifeDepths(W: Float32Array, segs: Seg[], cloud: KnifeCloud, out: Map<string, number>): void {
  out.clear();
  for (const s of segs) out.set(s.name, 0);
  const p = [0, 0, 0];
  // Quick reject: the hand's bounding sphere (finger segments; glove parts widen it).
  let cx = 0, cy = 0, cz = 0, nf = 0;
  for (const s of segs) if (s.digit !== "glove") (cx += s.a[0]), (cy += s.a[1]), (cz += s.a[2]), nf++;
  cx /= nf, cy /= nf, cz /= nf;
  const R2 = segs.length > nf ? 144 : 64;
  for (let v = 0; v < cloud.n; v++) {
    const o = cloud.bone[v] * 12, l = v * 3;
    const x = cloud.local[l], y = cloud.local[l + 1], z = cloud.local[l + 2];
    p[0] = W[o] * x + W[o + 1] * y + W[o + 2] * z + W[o + 3];
    p[1] = W[o + 4] * x + W[o + 5] * y + W[o + 6] * z + W[o + 7];
    p[2] = W[o + 8] * x + W[o + 9] * y + W[o + 10] * z + W[o + 11];
    if ((p[0] - cx) ** 2 + (p[1] - cy) ** 2 + (p[2] - cz) ** 2 > R2) continue;
    for (const s of segs) {
      let d = s.r - segDist(p, s.a, s.b);
      if (s.depth) d = d > 0 ? s.depth(p) : d;
      else if (s.base !== undefined) d = Math.min(d, s.r - s.base);
      if (d > out.get(s.name)!) out.set(s.name, d);
    }
  }
}

const NEIGHBOURS: [string, string][] = [
  ["index", "middle"],
  ["middle", "ring"],
  ["ring", "pinky"],
];

function crossDepths(segs: Seg[], out: Map<string, number>): void {
  out.clear();
  for (const [a, b] of NEIGHBOURS)
    for (const s of segs)
      if (s.digit === a)
        for (const t of segs)
          if (t.digit === b) {
            // Neighbouring fingers touch along their length; an overlap past 60% of the radii means they cross.
            const d = (s.r + t.r) * 0.6 - segSeg(s.a, s.b, t.a, t.b);
            out.set(`${s.name}/${t.name}`, Math.max(out.get(`${s.name}/${t.name}`) ?? -Infinity, d));
          }
}

/** One knife's viewmodel pipeline (procedural or a supplied base), as viewmodel.ts pose() runs it. */
class Pipe {
  readonly r = vmRig();
  readonly W: Float32Array;
  readonly proc: VmProcedural;
  readonly hold: KnifeHold | null;
  readonly insp: VmInspect;
  constructor(
    readonly knife: KnifeDef | null,
    private o: AuditOptions,
  ) {
    this.W = new Float32Array(this.r.names.length * 12);
    this.proc = new VmProcedural(this.r);
    // Like the viewmodel: every knife has a hold, the carrot's is CARROT_HOLD (knives/hold.ts).
    this.hold = new KnifeHold(knife ?? carrot, this.r, o.glove ?? "knit");
    this.insp = new VmInspect(this.r);
    this.insp.setKnife(knife, knife ? this.hold.state : null);
  }
  pose(action: VmAction, t: number): Float32Array {
    const W = this.W;
    if (this.o.base) this.o.base(action, t, W);
    else this.proc.pose(action, t, W);
    this.hold?.apply(W, action, t, this.o.base ? "cs" : "procedural");
    this.insp.apply(W);
    this.hold?.solve(W);
    if (this.o.clamp) clampFingers(this.W, this.r, "both");
    return W;
  }
}

type Driver = (p: Pipe, frame: (action: VmAction, t: number, label: number) => void, dt: number) => void;

function scenarios(o: AuditOptions): [string, Driver][] {
  const dur = o.durations ?? PROC_DURATION;
  const out: [string, Driver][] = [];
  for (const a of ["idle", "draw", "slash1", "slash2", "stab"] as VmAction[])
    out.push([a, (p, f, dt) => {
      for (let t = 0; t <= dur[a] + 1e-9; t += dt) f(a, t, t);
    }]);
  // Each trick of the chain played straight (seeked; the combo's own clock).
  out.push(["tricks", (p, f, dt) => {
    p.insp.current.clips.forEach((c, i) => {
      for (let t = 0; t <= c.len + 1e-9; t += dt) {
        p.insp.seek(i, t);
        f("idle", 0, i * 100 + t);
      }
    });
    p.insp.seek(-1, 0);
  }]);
  const run = (p: Pipe, f: (a: VmAction, t: number, l: number) => void, dt: number, secs: number, held: boolean, clock: { t: number; action: VmAction; at: number }) => {
    for (let i = 0; i < Math.round(secs / dt); i++) {
      clock.t += dt;
      p.insp.update(dt, held);
      const at = clock.t - clock.at;
      if (clock.action !== "idle" && at > dur[clock.action]) (clock.action = "idle"), (clock.at = clock.t);
      f(clock.action, clock.t - clock.at, clock.t);
    }
  };
  const fresh = () => ({ t: 0, action: "idle" as VmAction, at: 0 });
  out.push(["chain", (p, f, dt) => {
    const c = p.insp.current.clips;
    const k = fresh();
    p.insp.press();
    run(p, f, dt, c[0].open + 0.05, false, k);
    p.insp.press();
    run(p, f, dt, c[0].exit - c[0].open + 0.05, false, k);
    if (c[1]) {
      run(p, f, dt, Math.max(0, c[1].open - c[1].enter) + 0.05, false, k);
      p.insp.press();
    }
    run(p, f, dt, 9, false, k);
  }]);
  out.push(["spam", (p, f, dt) => {
    const k = fresh();
    for (let i = 0; i < 100; i++) {
      p.insp.press();
      run(p, f, dt, 0.1, false, k);
    }
    run(p, f, dt, 4, false, k);
  }]);
  out.push(["hold", (p, f, dt) => {
    const k = fresh();
    p.insp.press();
    run(p, f, dt, 6, true, k);
    run(p, f, dt, 4, false, k);
  }]);
  out.push(["cancel", (p, f, dt) => {
    const len = p.insp.current.clips[0].len;
    for (let tc = 0.15; tc < len; tc += 0.2) {
      const k = fresh();
      p.insp.cancel("draw");
      p.insp.press();
      run(p, f, dt, tc, false, k);
      p.insp.cancel("attack");
      k.action = tc % 0.4 < 0.2 ? "slash1" : "stab";
      k.at = k.t;
      run(p, f, dt, 0.5, false, k);
    }
  }]);
  out.push(["settle", (p, f, dt) => {
    const c = p.insp.current.clips[0];
    const k = fresh();
    p.insp.press();
    run(p, f, dt, c.exit + 0.12, false, k);
    p.insp.press();
    run(p, f, dt, 6, false, k);
  }]);
  out.push(["draw-cancel", (p, f, dt) => {
    const k = fresh();
    p.insp.press();
    run(p, f, dt, 0.8, false, k);
    p.insp.cancel("draw");
    k.action = "draw";
    k.at = k.t;
    run(p, f, dt, 1.2, false, k);
  }]);
  return o.only ? out.filter(([n]) => o.only!.includes(n)) : out;
}

/** Audits one knife (null = the carrot). Violations are collected per scenario (all of them if `collect`). */
export function auditKnife(knife: KnifeDef | null, o: AuditOptions = {}, collect?: Violation[]): ScenarioResult[] {
  const rate = o.rate ?? 120, dt = 1 / rate;
  const jt = o.jointTol ?? 0.5, dtol = o.depthTol ?? 0.12;
  const id = knife?.id ?? "carrot";
  const res: ScenarioResult[] = [];
  const cloud = knifeCloud(knife, vmRig(), o.vertexStride ?? 2);
  // Allowances: the idle hold's own contacts.
  const ref = new Pipe(knife, o);
  const W0 = ref.pose("idle", 0);
  const withGlove = (W: Float32Array, segs: Seg[]): Seg[] => (o.glove ? [...segs, ...gloveCapsules(W, ref.r, o.glove).map((c) => ({ ...c, digit: "glove" }))] : segs);
  const segs0 = withGlove(W0, fingerSegs(W0, ref.r));
  const kRef = new Map<string, number>(), cRef = new Map<string, number>();
  knifeDepths(W0, segs0, cloud, kRef);
  crossDepths(segs0, cRef);
  const readings: JointReading[] = [];
  const kd = new Map<string, number>(), cd = new Map<string, number>();
  for (const [name, drive] of scenarios(o)) {
    const p = new Pipe(knife, o);
    const r: ScenarioResult = { knife: id, scenario: name, frames: 0, joint: 0, knifeHits: 0, crossing: 0, worst: null };
    const note = (v: Violation) => {
      if (!r.worst || v.amount > r.worst.amount) r.worst = v;
      collect?.push(v);
    };
    drive(p, (action, t, label) => {
      const W = p.pose(action, t);
      r.frames++;
      let jBad = false, kBad = false, cBad = false;
      for (const j of readFingers(W, p.r, readings)) {
        const e = j.deg < j.range.min ? j.range.min - j.deg : j.deg > j.range.max ? j.deg - j.range.max : 0;
        if (e > jt) {
          jBad = true;
          note({ kind: "joint", scenario: name, t: label, what: `${j.side} ${j.digit} ${j.joint} ${j.deg.toFixed(1)}° (${j.range.min}..${j.range.max})`, amount: e });
        }
      }
      const segs = withGlove(W, fingerSegs(W, p.r));
      knifeDepths(W, segs, cloud, kd);
      for (const [k, d] of kd) {
        const e = d - Math.max(0, kRef.get(k) ?? 0);
        if (e > dtol) {
          kBad = true;
          note({ kind: "knife", scenario: name, t: label, what: `knife in ${k} (${d.toFixed(2)} deep)`, amount: e });
        }
      }
      crossDepths(segs, cd);
      for (const [k, d] of cd) {
        const e = d - Math.max(0, cRef.get(k) ?? 0);
        if (e > dtol) {
          cBad = true;
          note({ kind: "crossing", scenario: name, t: label, what: `fingers cross ${k}`, amount: e });
        }
      }
      if (jBad) r.joint++;
      if (kBad) r.knifeHits++;
      if (cBad) r.crossing++;
    }, dt);
    res.push(r);
  }
  return res;
}

// ---------------------------------------------------------------------------------------------------------------------
// Grip contact + temporal stability (apps/api/test/grip-contact.test.ts; every knife x glove style)

export interface GripDigit {
  /** Gap from each segment (proximal, middle, distal) to the knife's grip, through the glove's skin (< 0 = sunk in). */
  grip: [number, number, number];
  /** Deepest the digit goes into any part of the knife (guard, blade, handle; < 0 = sunk in). */
  sink: number;
  /** Thumb: gap from its two distal segments to the index finger (a hammer grip's thumb rests on it, not the knife). */
  onIndex?: number;
}

export interface GripReport {
  knife: string;
  glove: GloveStyleId;
  /** Idle contacts per digit. */
  digits: Record<string, GripDigit>;
  /** The digits the hold wraps round the grip (its HoldSpec.wrap.fingers). */
  wraps: string[];
  /**
   * Largest per-frame change of the grip while idle (units: finger joints, fingertips and knife points in the hand's
   * frame, frame to frame): a hold that re-solved, popped or jittered would show here. ~0.
   */
  idleJitter: number;
  /**
   * Largest change of the grip's shape (finger joints and tips in the knife's frame) from the idle hold, per action:
   * the fist shouldn't shift on the handle while it swings (the Bunnyfly's draw lets go on purpose).
   */
  drift: Record<VmAction, number>;
}

const DIGIT_BONES: [string, string, number][] = [
  ["index", "Right_Index", 0.92],
  ["middle", "Right_Middle", 0.98],
  ["ring", "Right_Ring", 0.92],
  ["pinky", "Right_Pinky", 0.8],
  ["thumb", "Right_Thumb", 1.02],
];

/** Finger joints + tips, in the frame of bone `ref` (3 floats each). */
function gripPoints(W: Float32Array, r: VmRig, ref: number, out: number[]): number[] {
  out.length = 0;
  const o = ref * 12;
  // Inverse of a rigid 3x4: R^T (p - t).
  const tx = W[o + 3], ty = W[o + 7], tz = W[o + 11];
  const put = (x: number, y: number, z: number) => {
    const dx = x - tx, dy = y - ty, dz = z - tz;
    out.push(W[o] * dx + W[o + 4] * dy + W[o + 8] * dz, W[o + 1] * dx + W[o + 5] * dy + W[o + 9] * dz, W[o + 2] * dx + W[o + 6] * dy + W[o + 10] * dz);
  };
  for (const [, n, tip] of DIGIT_BONES) {
    const b = [1, 2, 3].map((k) => r.bone(`${n}0${k}`));
    for (const i of b) put(W[i * 12 + 3], W[i * 12 + 7], W[i * 12 + 11]);
    const i = b[2] * 12;
    put(W[i + 3] + W[i] * tip, W[i + 7] + W[i + 4] * tip, W[i + 11] + W[i + 8] * tip);
  }
  return out;
}

const maxDelta = (a: number[], b: number[]) => {
  let m = 0;
  for (let i = 0; i < a.length; i += 3) m = Math.max(m, Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]));
  return m;
};

/**
 * Idle grip contacts of a knife in a glove style, its idle stability, and how far the grip drifts on the handle per
 * action, through the viewmodel's layers (procedural base, or `base` = v_knife_t's sequences; the clamp on).
 */
export function gripReport(knife: KnifeDef | null, glove: GloveStyleId = "knit", o: Pick<AuditOptions, "base" | "durations" | "rate"> = {}): GripReport {
  const r = vmRig();
  const opts: AuditOptions = { ...o, glove, clamp: true };
  const p = new Pipe(knife, opts);
  const cloud = knifeCloud(knife, r, 1);
  const skin = GRIP_SKIN[glove];
  const W = p.pose("idle", 0);
  const digits: Record<string, GripDigit> = {};
  const q = [0, 0, 0];
  for (const s of fingerSegs(W, r)) {
    const d = (digits[s.digit] ??= { grip: [Infinity, Infinity, Infinity], sink: Infinity });
    const k = Number(s.name.slice(-1)) - 1;
    const rad = s.r + (s.digit === "thumb" ? skin.thumb : skin.finger);
    for (let v = 0; v < cloud.n; v++) {
      const b = cloud.bone[v] * 12, l = v * 3;
      const x = cloud.local[l], y = cloud.local[l + 1], z = cloud.local[l + 2];
      q[0] = W[b] * x + W[b + 1] * y + W[b + 2] * z + W[b + 3];
      q[1] = W[b + 4] * x + W[b + 5] * y + W[b + 6] * z + W[b + 7];
      q[2] = W[b + 8] * x + W[b + 9] * y + W[b + 10] * z + W[b + 11];
      const g = segDist(q, s.a, s.b) - rad;
      if (g < d.sink) d.sink = g;
      if (cloud.grip[v] && g < d.grip[k]) d.grip[k] = g;
    }
  }
  {
    const segs = fingerSegs(W, r);
    let g = Infinity;
    // (The thumb's distal segments: its metacarpal's base and the index's sit side by side in the palm. Palm sides
    // touch, so no thumb guard / wrap skin: that's on the thumb's back.)
    for (const t of segs) if (t.digit === "thumb" && t.name !== "thumb1") for (const i of segs) if (i.digit === "index") g = Math.min(g, segSeg(t.a, t.b, i.a, i.b) - t.r - i.r - 2 * skin.finger);
    digits.thumb.onIndex = g;
  }
  const hand = r.bone("Right_Hand"), kb = r.bone("Knife_Handle");
  const dt = 1 / (o.rate ?? 60);
  const dur = o.durations ?? PROC_DURATION;
  // Idle jitter: the grip in the hand's frame, frame to frame (two idle cycles' worth of breathing / sway in the base).
  const a: number[] = [], b: number[] = [];
  let idleJitter = 0;
  gripPoints(p.pose("idle", 0), r, hand, a);
  for (let t = dt; t <= Math.min(2 * dur.idle, 8); t += dt) {
    gripPoints(p.pose("idle", t), r, hand, b);
    idleJitter = Math.max(idleJitter, maxDelta(a, b));
    a.splice(0, a.length, ...b);
  }
  // Drift: the grip in the knife's frame against the idle hold's.
  const ref = gripPoints(p.pose("idle", 0), r, kb, []);
  const drift = {} as Record<VmAction, number>;
  for (const act of ["idle", "draw", "slash1", "slash2", "stab"] as VmAction[]) {
    let m = 0;
    for (let t = 0; t <= dur[act] + 1e-9; t += dt) m = Math.max(m, maxDelta(ref, gripPoints(p.pose(act, t), r, kb, b)));
    drift[act] = m;
  }
  const spec = (knife ?? carrot).hold;
  const wraps = (spec?.wrap?.fingers ?? ["Index", "Middle", "Ring", "Pinky", "Thumb"]).map((f) => f.toLowerCase());
  return { knife: knife?.id ?? "carrot", glove, digits, wraps, idleJitter, drift };
}
