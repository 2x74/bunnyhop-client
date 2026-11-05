// Two-hand gun holds: where each hand sits on the gun and how its fingers close on it, solved once per gun + glove style
// with the knives' grip solver (knives/hold.ts wrapFingers / seatKnife: fingers close joint by joint until they rest on
// the grip through the glove's skin, never sinking in), for the right hand AND the left (the knives only ever needed
// the right one). The solved hold is hand-relative, so at runtime a hand follows the gun with one matrix product and
// its fingers come from curls (FingerPoser, no allocation), which lets animations blend finger poses by joint angle:
// every in-between stays inside the joints' ranges, and fingers.ts clampFingers runs on top as the safety net.
//
// Frames: bind space of the viewmodel rig (Source viewmodel axes: x forward, y left, z up). A hand's "held frame" is the
// knives' carrot frame (origin in the fist, z out of the index side, x toward the knuckles); HandPlace says where that
// frame goes on the gun. The palm faces +y of (fwd, up x fwd, up) for the right hand and -y for the left (a mirror).

import { add, Builder, cross, dot, len, norm, scale, sub } from "../../player/bunny/builder";
import { concat, invert34, type V3 } from "../../player/bunny/rig";
import type { GloveStyleId } from "../../loadout";
import { fromAxes, identity, rotAbout } from "../math";
import type { VmRig } from "../rig";
import { GRIP_ALONG, GRIP_SKIN, seatKnife, wrapFingers, type HandFrame } from "../knives/hold";
import { KnifeCtx } from "../knives/ctx";
import { PART, type Curl, type HoldSpec, type KnifeDef } from "../knives/types";
import { gunRig } from "./rig";
import type { GunDef, HandGrip, HandPlace } from "./types";

const D2R = Math.PI / 180;
export type Side = "R" | "L";
export const FINGERS = ["Index", "Middle", "Ring", "Pinky", "Thumb"] as const;
export type FingerName = (typeof FINGERS)[number];

const PREFIX: Record<Side, string> = { R: "Right_", L: "Left_" };
/** Rig bone name of a digit segment ("Thumb02" on the left is spelled Left_Thumb_02 in the CS:S skeleton). */
export function fingerBone(side: Side, nm: string): string {
  if (side === "L" && nm === "Thumb02") return "Left_Thumb_02";
  return PREFIX[side] + nm;
}

/** Curls per digit (deg per joint + spread), the shape the solver and the poser share. */
export type Curls = Record<Lowercase<FingerName>, Curl>;

/** Bind-space hand of one side, its axes, and (cached) the held frame. */
export interface SideBind {
  side: Side;
  hand: number;
  wrist: V3;
  ax: V3;
  across: V3;
  n: V3;
  palmL: number;
  /** Spread sign: + spreads toward the index side on both hands. */
  spreadSign: number;
  /** The held frame (bind): origin in the fist, z out of the index side, x toward the knuckles. */
  held: Float32Array;
  handBind: Float32Array;
  invHandBind: Float32Array;
}

const sides = new Map<Side, SideBind>();

export function sideBind(side: Side, r: VmRig = gunRig().hands): SideBind {
  const hit = sides.get(side);
  if (hit) return hit;
  const at = (nm: string) => r.at(nm);
  const p = PREFIX[side];
  const wrist = at(`${p}Hand`);
  const roots = ["Index", "Middle", "Ring", "Pinky"].map((f) => at(`${p}${f}01`));
  const kc = scale(roots.reduce((s, q) => add(s, q), [0, 0, 0] as V3), 0.25);
  const ax = norm(sub(kc, wrist));
  let across = sub(roots[0], roots[3]);
  across = norm(sub(across, scale(ax, dot(across, ax))));
  let n = cross(ax, across);
  if (dot(n, sub(at(fingerBone(side, "Thumb02")), wrist)) < 0) n = scale(n, -1);
  const palmL = len(sub(kc, wrist));
  // Spread is a rotation about n; + moves a finger along n x ax. Index side = +across.
  const spreadSign = dot(cross(n, ax), across) > 0 ? 1 : -1;
  // The carrot's held frame (knives/hold.ts handFrame): inside the curled fingers, z along the width axis.
  const grip = add(add(wrist, scale(ax, palmL * GRIP_ALONG)), scale(n, 1.35));
  const zB = norm(add(across, scale(ax, 0.12)));
  const xB = norm(sub(ax, scale(zB, dot(ax, zB))));
  const held = new Float32Array(12);
  fromAxes(xB, cross(zB, xB), zB, grip, held);
  const hand = r.bone(`${p}Hand`);
  const handBind = r.bind.slice(hand * 12, hand * 12 + 12);
  const invHandBind = new Float32Array(12);
  invert34(handBind, 0, invHandBind, 0);
  const s: SideBind = { side, hand, wrist, ax, across, n, palmL, spreadSign, held, handBind, invHandBind };
  sides.set(side, s);
  return s;
}

/**
 * Gun-local -> bind space for a hand placement: the place's frame (fwd, ±(up x fwd), up) at `o` onto the hand's held
 * frame, so the gun sits in that hand's fist as the place says.
 */
export function placeGun(side: Side, pl: HandPlace, r?: VmRig): Float32Array {
  const s = sideBind(side, r);
  const z = norm(pl.up);
  const x = norm(sub(pl.fwd, scale(z, dot(pl.fwd, z))));
  // The held frame's y = z x x; on the right hand that is the palm side, on the left the back of the hand. The place's
  // palm side is +(up x fwd) for the right hand: so the place frame is (x, z x x, z) on both (handedness is the hand's).
  const y = cross(z, x);
  const F = new Float32Array(12), Fi = new Float32Array(12), out = new Float32Array(12);
  fromAxes(x, y, z, pl.o, F);
  invert34(F, 0, Fi, 0);
  concat(s.held, 0, Fi, 0, out, 0);
  return out;
}

/** HandFrame (knives/hold.ts) for one side with curls applied: what wrapFingers / seatKnife work on. */
export function sideFrame(side: Side, curls: Curls, r: VmRig = gunRig().hands): HandFrame {
  const s = sideBind(side, r);
  const B = (nm: string) => r.bone(fingerBone(side, nm));
  const at = (nm: string) => {
    const o = B(nm) * 12;
    return [r.bind[o + 3], r.bind[o + 7], r.bind[o + 11]] as V3;
  };
  const posed = new Map<string, Float32Array>();
  const tmp = new Float32Array(12), acc = new Float32Array(12), acc2 = new Float32Array(12);
  const curlAxis = norm(cross(s.ax, s.n));
  const thumbAxis = norm(cross(norm(sub(at("Thumb02"), at("Thumb01"))), s.n));
  const curl = (f: string, c: Curl) => {
    const names = [1, 2, 3].map((k) => `${f}0${k}`);
    identity(acc);
    if (c.spread) {
      rotAbout(s.n, c.spread * s.spreadSign * D2R, at(names[0]), tmp);
      acc.set(tmp);
    }
    const axis = f === "Thumb" ? thumbAxis : curlAxis;
    names.forEach((nm, k) => {
      rotAbout(axis, c.c[k] * D2R, at(nm), tmp);
      concat(acc, 0, tmp, 0, acc2, 0);
      acc.set(acc2);
      const m = new Float32Array(12);
      concat(acc, 0, r.bind, B(nm) * 12, m, 0);
      posed.set(nm, m);
    });
  };
  for (const f of FINGERS) curl(f, curls[f.toLowerCase() as "index"]);
  const get = (nm: string) => {
    const m = posed.get(nm);
    if (!m) throw new Error(`gun hold: no finger bone ${nm}`);
    return m;
  };
  return {
    wrist: s.wrist,
    ax: s.ax,
    across: s.across,
    n: s.n,
    palmL: s.palmL,
    carrot: s.held,
    bone: get,
    joint: (nm) => {
      const m = get(nm);
      return [m[3], m[7], m[11]];
    },
    dir: (nm) => {
      const m = get(nm);
      return norm([m[0], m[4], m[8]]);
    },
    frame: (o, z, y) => {
      const zz = norm(z);
      const yy = norm(sub(y, scale(zz, dot(y, zz))));
      const m = new Float32Array(12);
      fromAxes(cross(yy, zz), yy, zz, o, m);
      return m;
    },
    curl,
  };
}

/** The gun as a "knife" for the grip solver (its first-person mesh, grip parts, plus the hold's proxy capsules). */
function solverDef(def: GunDef, side: Side): KnifeDef {
  const grip = side === "R" ? def.right : def.left;
  return {
    id: `gun:${def.id}:${side}`,
    cosmeticId: "",
    name: def.name,
    rarity: 1,
    blurb: "",
    build: (k: KnifeCtx) => {
      def.build(k);
      for (const [a, b, rad] of grip.proxy ?? []) k.tube([a, b], rad, 10, [0, 0, 1], () => ({ code: 0, color: 0 }), { part: PART.grip });
    },
  };
}

const curlsOf = (g: HandGrip): Curls => ({ index: g.index, middle: g.middle, ring: g.ring, pinky: g.pinky, thumb: g.thumb });

export interface SolvedHand {
  side: Side;
  /** Gun-local -> bind (the hand's bind fist holds the gun like this). */
  gunToBind: Float32Array;
  /** The hand bone relative to the gun part it rides on: W[hand] = W[part] * handInGun. */
  handInGun: Float32Array;
  /** Solved curls (the wrapped fingers closed onto the gun). */
  curls: Curls;
}

const solved = new Map<string, SolvedHand>();

/** Solves (once per gun, side, glove style) where a hand sits on a gun and how its fingers close on it. */
export function solveHand(def: GunDef, side: Side, glove: GloveStyleId = "knit"): SolvedHand {
  const key = `${def.id}|${side}|${glove}`;
  const hit = solved.get(key);
  if (hit) return hit;
  const grip = side === "R" ? def.right : def.left;
  const curls = curlsOf(grip);
  const h = sideFrame(side, curls);
  const sd = solverDef(def, side);
  let gunToBind = placeGun(side, grip);
  if (grip.seat !== undefined) gunToBind = seatKnife(h, gunToBind, sd, grip.seat);
  const spec: HoldSpec = { ...curls, wrap: { fingers: grip.wrap, seat: grip.seat } };
  const out: Curls = { ...curls };
  if (grip.wrap.length) {
    const res = wrapFingers(h, spec, gunToBind, spec.wrap!, sd, glove);
    for (const [f, c] of res) out[f.toLowerCase() as "index"] = { c: [c[0], c[1], c[2]], spread: curls[f.toLowerCase() as "index"].spread };
  }
  // The firing index on the trigger (its own target, not the wrap: the wrap closes fingers onto the grip).
  if (side === "R" && def.trigger && grip.triggerRest && !grip.wrap.includes("Index")) {
    const down = typeof grip.triggerRest === "number" ? grip.triggerRest : TRIGGER_DOWN;
    const { c } = solveTriggerIndex(def.trigger, gunToBind, out, GRIP_SKIN[glove].finger, undefined, down);
    out.index = { c, spread: curls.index.spread };
  }
  const s = sideBind(side);
  const inv = new Float32Array(12), handInGun = new Float32Array(12);
  invert34(gunToBind, 0, inv, 0);
  concat(inv, 0, s.handBind, 0, handInGun, 0);
  const res: SolvedHand = { side, gunToBind, handInGun, curls: out };
  solved.set(key, res);
  return res;
}

/** The index's pad (centre of the finger, partway along its last segment) sits this far in front of the trigger blade. */
const PAD_R = 0.3;
/** How far down the trigger blade from its pivot the pad rests (gun-local units). */
const TRIGGER_DOWN = 0.3;

/**
 * The firing index's curls (MCP, PIP, DIP) that bring its pad as close as it reaches to the trigger's front face, `skin`
 * (the glove's) clear of it, within the joints' natural range (no hyperextension): a coarse search, then a fine one,
 * preferring the least curl among near ties. Once per gun + glove (cached with the hold). With the bunny's short
 * fingers on the long guns' deep grips the pad reaches into the guard toward the trigger, not onto it (about a unit
 * short): owner decision in the v0.0.38 viewmodel report.
 */
export function solveTriggerIndex(trigger: V3, gunToBind: Float32Array, curls: Curls, skin: number, debug?: { pad?: V3; mcp?: V3 }, down = TRIGGER_DOWN): { c: [number, number, number]; residual: number } {
  const r = gunRig().hands;
  const W = new Float32Array(r.bind);
  const poser = new FingerPoser("R", r);
  const b = [1, 2, 3].map((k) => r.bone(fingerBone("R", `Index0${k}`)));
  const g = trigger, tl: V3 = [g[0] + 0.08 + PAD_R + skin, 0, g[2] - down];
  const T: V3 = [
    gunToBind[0] * tl[0] + gunToBind[1] * tl[1] + gunToBind[2] * tl[2] + gunToBind[3],
    gunToBind[4] * tl[0] + gunToBind[5] * tl[1] + gunToBind[6] * tl[2] + gunToBind[7],
    gunToBind[8] * tl[0] + gunToBind[9] * tl[1] + gunToBind[10] * tl[2] + gunToBind[11],
  ];
  const flat = flatCurls(curls);
  const at = (i: number): V3 => [W[i * 12 + 3], W[i * 12 + 7], W[i * 12 + 11]];
  const cost = (c: number[]): number => {
    poser.pose(W, (i, k) => (i === 0 ? c[k] : flat[i * 4 + k]), (i) => flat[i * 4 + 3]);
    const p2 = at(b[1]), p3 = at(b[2]);
    const d = sub(p3, p2);
    const pad = add(p3, scale(d, 0.55));
    return len(sub(pad, T)) + 0.0015 * (c[0] + c[1] + c[2]);
  };
  let best = [0, 0, 0], bestC = Infinity;
  for (let a = -5; a <= 80; a += 5)
    for (let p = 0; p <= 95; p += 5)
      for (let d = 0; d <= 70; d += 5) {
        const v = cost([a, p, d]);
        if (v < bestC) (bestC = v), (best = [a, p, d]);
      }
  for (let step = 2; step >= 0.5; step /= 2)
    for (let it = 0; it < 12; it++) {
      let moved = false;
      for (let k = 0; k < 3; k++)
        for (const sgn of [-1, 1]) {
          const c = [...best];
          c[k] = Math.max(k === 0 ? -5 : 0, Math.min(k === 0 ? 80 : k === 1 ? 95 : 70, c[k] + sgn * step));
          const v = cost(c);
          if (v < bestC) (bestC = v), (best = c), (moved = true);
        }
      if (!moved) break;
    }
  if (debug) {
    cost(best);
    const inv = new Float32Array(12);
    invert34(gunToBind, 0, inv, 0);
    const loc = (q: V3): V3 => [0, 1, 2].map((r) => inv[r * 4] * q[0] + inv[r * 4 + 1] * q[1] + inv[r * 4 + 2] * q[2] + inv[r * 4 + 3]) as V3;
    const p2 = at(b[1]), p3 = at(b[2]);
    debug.pad = loc(add(p3, scale(sub(p3, p2), 0.55)));
    debug.mcp = loc(at(b[0]));
  }
  return { c: [best[0], best[1], best[2]], residual: bestC - 0.0015 * (best[0] + best[1] + best[2]) };
}

/** The silencer alone as a "knife" for the grip solver (the can seated, its body and collar are grip). */
function silencerSolverDef(def: GunDef): KnifeDef {
  return { id: `gun:${def.id}:sil`, cosmeticId: "", name: def.name, rarity: 1, blurb: "", build: (k: KnifeCtx) => def.silencer?.build(k) };
}

/**
 * The support hand around a gun's silencer (GunDef.silencer.grip), solved like a hold (once per gun + glove style):
 * placed on the can as it sits seated, the fingers and thumb closed onto it through the glove's skin. handInGun is the
 * hand relative to the seated can (the animation moves the can, the hand rides it). Null for a gun without one.
 */
export function solveSilencerHand(def: GunDef, glove: GloveStyleId = "knit"): SolvedHand | null {
  const sil = def.silencer;
  if (!sil) return null;
  const key = `${def.id}|sil|${glove}`;
  const hit = solved.get(key);
  if (hit) return hit;
  const grip = sil.grip;
  const curls = curlsOf(grip);
  const h = sideFrame("L", curls);
  const sd = silencerSolverDef(def);
  let gunToBind = placeGun("L", grip);
  if (grip.seat !== undefined) gunToBind = seatKnife(h, gunToBind, sd, grip.seat);
  const spec: HoldSpec = { ...curls, wrap: { fingers: grip.wrap, seat: grip.seat } };
  const out: Curls = { ...curls };
  if (grip.wrap.length) {
    const res = wrapFingers(h, spec, gunToBind, spec.wrap!, sd, glove);
    for (const [f, c] of res) out[f.toLowerCase() as "index"] = { c: [c[0], c[1], c[2]], spread: curls[f.toLowerCase() as "index"].spread };
  }
  const s = sideBind("L");
  const inv = new Float32Array(12), handInGun = new Float32Array(12);
  invert34(gunToBind, 0, inv, 0);
  concat(inv, 0, s.handBind, 0, handInGun, 0);
  const res: SolvedHand = { side: "L", gunToBind, handInGun, curls: out };
  solved.set(key, res);
  return res;
}

/** A hand placement on the gun without solving (reload targets): the hand bone relative to the gun. */
export function handAt(side: Side, pl: HandPlace): Float32Array {
  const g = placeGun(side, pl);
  const inv = new Float32Array(12), out = new Float32Array(12);
  invert34(g, 0, inv, 0);
  concat(inv, 0, sideBind(side).handBind, 0, out, 0);
  return out;
}

export function clearGunHolds(): void {
  solved.clear();
}

/** Solves both hands of these guns in a glove style ahead of time, one per idle callback. */
export function prewarmGunHolds(defs: readonly GunDef[], glove: GloveStyleId): void {
  const queue = defs.flatMap((d) => [() => solveHand(d, "R", glove), () => solveHand(d, "L", glove), ...(d.silencer ? [() => solveSilencerHand(d, glove)] : [])]);
  const g = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  const idle: (cb: () => void) => void = typeof g.requestIdleCallback === "function" ? (cb) => g.requestIdleCallback!(cb, { timeout: 2000 }) : (cb) => setTimeout(cb, 50);
  const step = () => {
    const f = queue.shift();
    if (!f) return;
    f();
    idle(step);
  };
  idle(step);
}

// -------------------------------------------------------------------------------------------------
// Runtime finger poser: curls -> finger matrices, no allocation.

interface Chain {
  bones: number[];
  /** Bind joint positions. */
  at: V3[];
  thumb: boolean;
}

/** Poses one hand's fingers from curls on top of a posed hand bone (W[hand] already set). */
export class FingerPoser {
  readonly s: SideBind;
  private chains: Chain[];
  private curlAxis: V3;
  private thumbAxis: V3;
  private acc = new Float32Array(12);
  private acc2 = new Float32Array(12);
  private tmp = new Float32Array(12);
  private G = new Float32Array(12);
  private B: Float32Array;

  constructor(readonly side: Side, r: VmRig = gunRig().hands) {
    this.s = sideBind(side, r);
    this.B = r.bind;
    this.chains = FINGERS.map((f) => {
      const bones = [1, 2, 3].map((k) => r.bone(fingerBone(side, `${f}0${k}`)));
      return { bones, at: bones.map((i) => [r.bind[i * 12 + 3], r.bind[i * 12 + 7], r.bind[i * 12 + 11]] as V3), thumb: f === "Thumb" };
    });
    this.curlAxis = norm(cross(this.s.ax, this.s.n));
    const t = this.chains[4].at;
    this.thumbAxis = norm(cross(norm(sub(t[1], t[0])), this.s.n));
  }

  /**
   * W[finger bones] = (W[hand] * inverse(hand bind)) * curl(bind). `c(i, k)`: joint k of digit i (index .. thumb),
   * `sp(i)`: spread (deg).
   */
  pose(W: Float32Array, c: (i: number, k: number) => number, sp: (i: number) => number): void {
    const s = this.s;
    concat(W, s.hand * 12, s.invHandBind, 0, this.G, 0);
    const acc = this.acc, acc2 = this.acc2, tmp = this.tmp;
    for (let i = 0; i < 5; i++) {
      const ch = this.chains[i];
      identity(acc);
      const spread = sp(i);
      if (spread) {
        rotAbout(s.n, spread * s.spreadSign * D2R, ch.at[0], tmp);
        acc.set(tmp);
      }
      const axis = ch.thumb ? this.thumbAxis : this.curlAxis;
      for (let k = 0; k < 3; k++) {
        rotAbout(axis, c(i, k) * D2R, ch.at[k], tmp);
        concat(acc, 0, tmp, 0, acc2, 0);
        acc.set(acc2);
        concat(acc, 0, this.B, ch.bones[k] * 12, tmp, 0);
        concat(this.G, 0, tmp, 0, W, ch.bones[k] * 12);
      }
    }
  }
}

/** Curls as a flat array (digit * 4: three joints + spread), for blending. */
export function flatCurls(c: Curls, out = new Float32Array(20)): Float32Array {
  const ds = [c.index, c.middle, c.ring, c.pinky, c.thumb];
  ds.forEach((d, i) => {
    out[i * 4] = d.c[0];
    out[i * 4 + 1] = d.c[1];
    out[i * 4 + 2] = d.c[2];
    out[i * 4 + 3] = d.spread ?? 0;
  });
  return out;
}

void Builder;
