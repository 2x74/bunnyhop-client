// Where a charm is tied on each knife (v0.0.43): the cord is wrapped round a real part of the knife and the charm hangs
// from the knot. Nothing stands off the knife to hang it from (the owner, 11-17: "it should just try to fit it best it
// can to the hilt or wherever makes sense"; the Bunnyfly, tied at its handle's end, was the one that looked right).
//
// A tie is a slab through the knife (places.ts picks it per knife, by looking): the cord runs round whatever of the
// knife (and of a living hilt's pieces) lies in the slab, its outline measured from the real mesh, so the wrap sits on
// the surface of any knife and any hilt:
//
//   "neck"  across the knife's length at a height: round a collar, a round guard's rim, a handle's end, a butt
//   "arm"   across a part that sticks out, a little in from its tip: round a quillon, over a tsuba's edge, round a
//           finger ring's rim
//
// The knot (the pin the cord's tail hangs from) is the point of the wrap furthest toward `out`: screen-left and a
// little down at rest, the side of the fist that is in view for either hand (the left hand mirrors). A tie is only
// taken where no finger passes through the wrap or touches it; a hilt that brings its own lanyard ring gives the pommel
// tie (setHiltCharmAnchors).
//
// Hung this close to the hand, a charm at the guard rests against the outside of the fist as a real one would: the
// colliders (the fist, each finger joint to joint, the knuckles, the guard, the blade) are what it rests on, a little
// proud of the real surfaces so the charm's own mesh never enters them (test/charms-fit.test.ts checks every knife,
// hilt, charm and size against the real meshes).

import { Builder } from "../../player/bunny/builder";
import { concat, invert34, type V3 } from "../../player/bunny/rig";
import type { GloveStyleId } from "../../loadout";
import { clampFingers } from "../fingers";
import { ViewFeel } from "../feel";
import { KnifeCtx } from "../knives/ctx";
import { carrot } from "../knives/carrot";
import { KnifeHold } from "../knives/hold";
import type { KnifeDef } from "../knives/types";
import { viewmodelGeometry } from "../mesh";
import { VmProcedural } from "../procedural";
import { vmRig } from "../rig";
import { BAIL_BOTTOM, CORD_R, type MountSpec } from "./hardware";
import { charmPlaces, tieOf, type TieSpec } from "./places";

export { charmPlaces };

/**
 * Per-hilt anchors (v0.0.43): a hilt that adds geometry at the guard or the butt (the living hilts, viewmodel/hilts/live)
 * says where a charm goes on it, knife-local: `guard` a point on its guard pieces (their height), `pommel` its lanyard
 * ring's centre. null = an ordinary hilt (a repaint): the knife's own ties stand. `cloud`: its pieces' points
 * (knife-local), so the cord is wrapped round them and not through them. Registered once (setHiltCharmAnchors); the
 * hilts lane's liveCharmAnchors has this shape (knife.ts adds the points).
 */
export type HiltCharmAnchors = (hilt: string | null | undefined, knife: KnifeDef, side: V3) => { guard: V3; pommel: V3; cloud?: Float32Array | null } | null;
let hiltAnchors: HiltCharmAnchors | null = null;
export function setHiltCharmAnchors(fn: HiltCharmAnchors | null): void {
  hiltAnchors = fn;
  fits.clear();
}

export interface CharmCollider {
  a: V3;
  b: V3 | null;
  r: number;
  bone: string;
  boneB?: string;
  guard?: true;
  /** A stand-in for the hand (the fist, a finger): used only while the hand is away from its rest hold. */
  hand?: true;
}

/** Where and how a charm hangs: the pin (the knot) on its bone, the wrap, the colliders. */
export interface CharmHang {
  bone: string;
  /** The pin in `bone`'s frame. */
  at: V3;
  mount: MountSpec | null;
  /** What it is tied to ("neck" / "arm" / "ring": a hilt's own lanyard ring), for the tests and the report. */
  how: string;
  colliders: CharmCollider[];
}

export interface CharmFit {
  knife: KnifeDef;
  /** Knife-local, at rest: screen-left square to the knife's length, straight down, screen-left. */
  side: V3;
  down: V3;
  left: V3;
  guard: CharmHang;
  pommel: CharmHang | null;
  /** The hands and sleeves (and a knife's moving parts), knife-local at rest: what a charm rests against while the hand holds the knife as at rest. */
  hands: Float32Array;
  /** The knife's own surface on its main bone and a hilt's pieces, knife-local: what it rests against always. */
  solid: Float32Array;
  /** The finger joints' places at rest (knife-local), to tell when the hand is holding the knife as at rest. */
  joints: { bone: string; p: V3 }[];
  /** The rest pose (bones to model, 3x4 each). */
  rest: Float32Array;
}

const FIST_R = 1.18;
const FINGER_R = 0.38;

const fits = new Map<string, CharmFit>();
const r = () => vmRig();

/** A knife's fit with a hilt (its id) and a glove style, measured once per combination and cached. */
export function charmFit(def: KnifeDef | null, hilt: string | null = null, glove: GloveStyleId = "knit"): CharmFit {
  const k = def ?? carrot;
  const live = hilt && hiltAnchors ? hilt : null;
  const key = `${k.id}|${live ?? ""}|${glove}`;
  let f = fits.get(key);
  if (!f) fits.set(key, (f = measure(k, live, glove)));
  return f;
}

/** Where a charm hangs on a fitted knife: the guard's tie or the pommel's as chosen, the one place where a knife offers one. */
export function charmHang(fit: CharmFit, pommel: boolean): CharmHang {
  const places = charmPlaces(fit.knife.id);
  if (!places.guard && fit.pommel) return fit.pommel;
  return (pommel && places.pommel ? fit.pommel : null) ?? fit.guard;
}

/** The viewmodel's bones at rest for a knife and glove (the procedural idle, the knife's hold: viewmodel.ts pose()). */
export function restPose(k: KnifeDef, glove: GloveStyleId = "knit"): Float32Array {
  const rig = r();
  const W = new Float32Array(rig.names.length * 12);
  const hold = new KnifeHold(k, rig, glove);
  new VmProcedural(rig).pose("idle", 0, W);
  hold.state.time = 0;
  hold.apply(W, "idle", 0, "procedural");
  hold.solve(W);
  clampFingers(W, rig);
  return W;
}

/** The view at rest (model -> eye, 3x4): the feel matrix with nothing moving. */
export function restView(): Float32Array {
  return new ViewFeel().update(0, { velocity: [0, 0, 0], grounded: true, viewOffsetZ: 64, sidemove: 0, yaw: 0, pitch: 0, landed: 0 }, 0, 0, 0).slice();
}

let kbones: Set<number> | null = null;
/** The bones a knife's own geometry rides on (the handle, its parent, a balisong's and a spinner's parts). */
export function knifeBones(): Set<number> {
  if (!kbones) {
    const rig = r();
    kbones = new Set(rig.names.map((n, i) => (/Knife_Handle|knife_Parent|Bfly_|Whirl_/.test(n) ? i : -1)).filter((i) => i >= 0));
  }
  return kbones;
}

function measure(k: KnifeDef, hilt: string | null, glove: GloveStyleId): CharmFit {
  const rig = r();
  const kb = rig.bone("Knife_Handle");
  const main = rig.names[kb];
  // --- The knife alone, in its own frame: its tagged hilt parts and blade, as points over its surface.
  const b = new Builder();
  const ctx = new KnifeCtx(b, "fp", (p) => [p[0], p[1], p[2]], (bone) => [[bone ? rig.bone(bone) : kb, 1]]);
  k.build(ctx);
  const g = b.geometry();
  const Pk = g.getAttribute("position"), F = g.getAttribute("finishUV"), SI = g.getAttribute("skinIndex");
  type Pt = { p: V3; role: number; blade: boolean; bone: number };
  const pts: Pt[] = [];
  const buf: number[] = [];
  for (let t = 0; t + 2 < Pk.count; t += 3) {
    const fx = F ? F.getX(t) : 0;
    const role = Math.round(fx - (fx % 1 > 0.2 ? 0.25 : 0));
    const blade = F ? Math.abs(Math.floor(F.getZ(t) + 1e-4) - 1) < 0.5 : false;
    buf.length = 0;
    sampleTri([Pk.getX(t), Pk.getY(t), Pk.getZ(t), Pk.getX(t + 1), Pk.getY(t + 1), Pk.getZ(t + 1), Pk.getX(t + 2), Pk.getY(t + 2), Pk.getZ(t + 2)], 0, buf);
    for (let i = 0; i < buf.length; i += 3) pts.push({ p: [buf[i], buf[i + 1], buf[i + 2]], role, blade, bone: SI.getX(t) });
  }
  g.dispose();
  // --- The rest pose: straight down and screen-left in the knife's frame.
  const W = restPose(k, glove), V = restView();
  const E = new Float32Array(12), Ei = new Float32Array(12);
  concat(V, 0, W, kb * 12, E, 0);
  invert34(E, 0, Ei, 0);
  const dirK = (d: V3): V3 => norm3([Ei[0] * d[0] + Ei[1] * d[1] + Ei[2] * d[2], Ei[4] * d[0] + Ei[5] * d[1] + Ei[6] * d[2], Ei[8] * d[0] + Ei[9] * d[1] + Ei[10] * d[2]]);
  const down = dirK([0, 0, -1]), left = dirK([0, 1, 0]), toEye = dirK([-1, 0, 0]);
  const side = norm3([left[0], left[1], 0]);
  // --- The hands as posed at rest, in the knife's frame (what is within reach of a charm: not the far sleeve).
  const vg = viewmodelGeometry(k, glove);
  const all = skinned(vg, W, kb);
  const keep: number[] = [];
  for (let i = 0; i < all.length; i += 3) if (Math.hypot(all[i], all[i + 1]) < 7 && all[i + 2] > -9 && all[i + 2] < 7) keep.push(all[i], all[i + 1], all[i + 2]);
  const hands = new Float32Array(keep);
  const h = hilt && hiltAnchors ? hiltAnchors(hilt, k, side) : null;
  const box = (sel: Pt[]) => {
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const q of sel) for (let a = 0; a < 3; a++) (lo[a] = Math.min(lo[a], q.p[a])), (hi[a] = Math.max(hi[a], q.p[a]));
    return { lo, hi };
  };
  const spec = tieOf(k.id);
  let guardPts = pts.filter((q) => q.role === (spec.guard.role ?? 2));
  if (!guardPts.length) guardPts = pts.filter((q) => !q.blade && q.p[2] > 0.8 && q.p[2] < 2.6);
  const gb = box(guardPts);
  const butt = pts.filter((q) => q.role === 1 || q.role === 3);
  const bsel = butt.length ? butt : pts.filter((q) => !q.blade);
  const bb = box(bsel);
  const lowest = bsel.reduce((m, q) => (q.p[2] < m.p[2] ? q : m));

  // --- Colliders.
  const colliders: CharmCollider[] = [];
  const bladePts = pts.filter((q) => q.blade && q.bone === kb);
  if (bladePts.length) {
    const bl = box(bladePts);
    const cy = (bl.lo[1] + bl.hi[1]) / 2, cx = (bl.lo[0] + bl.hi[0]) / 2;
    const rad = Math.min(1.2, Math.max(0.25, (bl.hi[1] - bl.lo[1]) / 2));
    colliders.push({ a: [cx, cy, bl.lo[2] + rad * 0.5], b: [cx, cy, bl.hi[2] - rad], r: rad, bone: main });
  }
  // The grip and the fist round it; the guard as a bar across the knife on the charm's side.
  colliders.push({ a: [0, 0, Math.max(bb.lo[2] + 0.6, -2)], b: [0, 0, Math.min(gb.lo[2] - 0.25, 1.4)], r: FIST_R, bone: main, hand: true });
  if (!spec.guard.role) {
    const reach = Math.max(...guardPts.map((q) => dot(q.p, side))), rr = 0.3, end = Math.max(0, reach - rr);
    const gz = Math.max(gb.hi[2], h ? h.guard[2] : -Infinity);
    colliders.push({ a: [-side[0] * end * 0.8, -side[1] * end * 0.8, gz + 0.05], b: [side[0] * end, side[1] * end, gz + 0.05], r: rr, bone: main, guard: true });
  }
  // The right hand: each finger and the thumb joint to joint, the knuckles from the index's to the little finger's.
  const J = (f: string, n: number) => rig.names[rig.bone(f === "Thumb" && n === 2 ? "Right_Thumb02" : `Right_${f}0${n}`)];
  for (const f of ["Index", "Middle", "Ring", "Pinky", "Thumb"]) {
    colliders.push({ a: [0, 0, 0], b: [0, 0, 0], r: FINGER_R, bone: J(f, 1), boneB: J(f, 2), hand: true });
    colliders.push({ a: [0, 0, 0], b: [0, 0, 0], r: FINGER_R, bone: J(f, 2), boneB: J(f, 3), hand: true });
  }
  colliders.push({ a: [0, 0, 0], b: [0, 0, 0], r: FINGER_R + 0.06, bone: J("Index", 1), boneB: J("Pinky", 1), hand: true });
  colliders.push({ a: [0, 0, 0], b: [0, 0, 0], r: FINGER_R + 0.02, bone: J("Index", 2), boneB: J("Pinky", 2), hand: true });

  // --- The ties.
  const up = scale3(down, -1);
  const toBone = (bone: number, p: V3, dir = false): V3 => {
    if (bone === kb) return p;
    // (A balisong's handle, its latch: the knife's frame at rest into the bone's own.)
    const Bi = new Float32Array(12), M = new Float32Array(12);
    invert34(W, bone * 12, Bi, 0);
    concat(Bi, 0, W, kb * 12, M, 0);
    return dir ? [M[0] * p[0] + M[1] * p[1] + M[2] * p[2], M[4] * p[0] + M[5] * p[1] + M[6] * p[2], M[8] * p[0] + M[9] * p[1] + M[10] * p[2]] : xf(M, p);
  };
  type Tie = { pin: V3; loop: V3[]; normal: V3; bone: number };
  const tie = (t: TieSpec, sel: Pt[], extra: Float32Array | null, sb: { lo: V3; hi: V3 }): Tie | null => {
    // Which way the knot faces, the bone, and the candidates for where the slab cuts (the first with no finger in or
    // on the wrap wins).
    const ta = ((t.turn ?? 0) * Math.PI) / 180;
    // (Turned toward the eye about the knife's length: `side` toward the eye's direction squared to it.)
    const fwd = norm3(sub3(toEye, scale3(side, dot(toEye, side))));
    const out = norm3(add3(add3(scale3(side, Math.cos(ta)), scale3([fwd[0], fwd[1], 0], Math.sin(ta))), scale3(down, t.drop ?? 0.35)));
    const bone = t.bone ? rig.bone(t.bone) : mostBone(sel);
    const on = sel.filter((q) => q.bone === bone);
    if (!on.length) return null;
    const tries: { n: V3; at: number; u: V3; v: V3; lo: number; hi: number }[] = [];
    if (t.how === "neck") {
      // Heights: the given one, else the widest toward `side` first (a rim), then the rest of the part.
      const zs: number[] = [];
      if (t.z !== undefined) zs.push(t.z, t.z + 0.1, t.z - 0.1, t.z + 0.2, t.z - 0.2);
      else {
        const hs: [number, number][] = [];
        for (let z = sb.lo[2] + 0.06; z <= sb.hi[2] - 0.04; z += 0.07) hs.push([z, Math.max(-9, ...on.filter((q) => Math.abs(q.p[2] - z) < 0.06).map((q) => dot(q.p, side)))]);
        hs.sort((a, b2) => b2[1] - a[1]);
        for (const [z] of hs) zs.push(z);
      }
      for (const z of zs) tries.push({ n: [0, 0, 1], at: z, u: side, v: cross3([0, 0, 1], side), lo: -Infinity, hi: Infinity });
    } else {
      // Across the direction the part sticks out along, a little in from its tip.
      const d = norm3(t.along === "up" ? up : t.along === "out" ? out : side);
      const tip = Math.max(...on.map((q) => dot(q.p, d)));
      const v = norm3(cross3(d, Math.abs(d[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1])), u = cross3(v, d);
      for (const inset of t.inset !== undefined ? [t.inset, t.inset + 0.08, t.inset - 0.06, t.inset + 0.16] : [0.16, 0.24, 0.32, 0.1]) tries.push({ n: d, at: tip - inset, u, v, lo: sb.lo[2] - 0.2, hi: sb.hi[2] + 0.2 });
    }
    const H = CORD_R * 1.9;
    for (const s of tries) {
      // What of the part (and of a hilt's pieces) lies in the slab, flattened into it.
      const flat: [number, number][] = [];
      for (const q of on) if (Math.abs(dot(q.p, s.n) - s.at) <= H && q.p[2] >= s.lo && q.p[2] <= s.hi) flat.push([dot(q.p, s.u), dot(q.p, s.v)]);
      for (let i = 0; extra && bone === kb && i < extra.length; i += 3) {
        const p: V3 = [extra[i], extra[i + 1], extra[i + 2]];
        if (Math.abs(dot(p, s.n) - s.at) <= H && p[2] >= s.lo && p[2] <= s.hi) flat.push([dot(p, s.u), dot(p, s.v)]);
      }
      if (flat.length < 6) continue;
      const hull = inflate(convexHull(flat), CORD_R * 1.05);
      const per = hull.reduce((a, p, i) => a + Math.hypot(p[0] - hull[(i + 1) % hull.length][0], p[1] - hull[(i + 1) % hull.length][1]), 0);
      if (per > (t.max ?? 9) || per < 0.3) continue;
      const loop = resample(hull, Math.max(8, Math.min(18, Math.round(per / 0.2)))).map(([a, b2]) => add3(add3(scale3(s.u, a), scale3(s.v, b2)), scale3(s.n, s.at)));
      // No finger through the wrap, none against it.
      if (handIn(hands, s, hull, H + 0.02) || loop.some((p) => !free(hands, p, CORD_R + 0.05))) continue;
      let pin = loop[0];
      for (const p of loop) if (dot(p, out) > dot(pin, out)) pin = p;
      // (The knot sits just proud of the wrap.)
      const cen = scale3(loop.reduce((a, p) => add3(a, p), [0, 0, 0] as V3), 1 / loop.length);
      pin = add3(pin, scale3(norm3(sub3(pin, cen)), CORD_R * 0.9));
      return { pin, loop, normal: s.n, bone };
    }
    return null;
  };
  const hangOf = (t: Tie | null, how: string): CharmHang | null =>
    t ? { bone: rig.names[t.bone], at: toBone(t.bone, t.pin), mount: { kind: "wrap", loop: t.loop.map((p) => toBone(t.bone, sub3(p, t.pin), true)), normal: toBone(t.bone, t.normal, true) }, how, colliders } : null;
  // The guard: the knife's tie, round the hilt's pieces too where it has them (a living hilt's guard is its own shape:
  // its neck is tried when the knife's own tie has a piece of it in the way).
  const hc = h?.cloud ?? null;
  let guard = hangOf(tie(spec.guard, guardPts, hc, gb), spec.guard.how);
  if (!guard && hc) guard = hangOf(tie({ how: "neck", z: h!.guard[2] }, guardPts, hc, gb), "neck");
  if (!guard) guard = hangOf(tie({ how: "neck" }, guardPts, hc, gb), "neck");
  if (!guard) {
    // (Nothing bare to tie round: the part's outermost point, a knot alone.)
    const p = guardPts.reduce((m, q) => (dot(q.p, side) > dot(m.p, side) ? q : m));
    guard = { bone: rig.names[p.bone], at: toBone(p.bone, p.p), mount: { kind: "wrap", loop: [], normal: [0, 0, 1] }, how: "knot", colliders };
  }
  // The pommel: a hilt's own lanyard ring, else round the butt.
  let pommel: CharmHang | null = null;
  if (charmPlaces(k.id).pommel) {
    if (h) {
      const pin = add3(h.pommel, scale3(down, 0.19));
      pommel = { bone: rig.names[lowest.bone], at: toBone(lowest.bone, pin), mount: { kind: "ring", loop: ringLoop(h.pommel, down).map((p) => toBone(lowest.bone, sub3(p, pin), true)), normal: toBone(lowest.bone, [1, 0, 0], true) }, how: "ring", colliders };
    } else {
      const sel = bsel.filter((q) => q.bone === lowest.bone);
      pommel = hangOf(tie({ ...(spec.pommel ?? { how: "neck", z: bb.lo[2] + 0.22 }), drop: 1.2 }, sel, hc, box(sel)), spec.pommel?.how ?? "neck");
    }
  }
  // What the charm rests against: the knife's own surface on its main bone (a balisong's other handle and blade move:
  // their colliders stand for them) and the hilt's pieces; the hand at rest.
  const sol: number[] = [], rest: number[] = [];
  for (const q of pts) (q.bone === kb ? sol : rest).push(q.p[0], q.p[1], q.p[2]);
  if (hc) for (let i = 0; i < hc.length; i++) sol.push(hc[i]);
  // (A balisong's other handle and blade, a spinner: where they are at rest, with the hand.)
  const atRest = new Float32Array(hands.length + rest.length);
  atRest.set(hands);
  atRest.set(rest, hands.length);
  const Ki = new Float32Array(12), Mj = new Float32Array(12);
  invert34(W, kb * 12, Ki, 0);
  const joints = ["Index", "Middle", "Ring", "Pinky"].flatMap((f) => [1, 2, 3].map((n) => {
    const bone = J(f, n);
    concat(Ki, 0, W, rig.bone(bone) * 12, Mj, 0);
    return { bone, p: [Mj[3], Mj[7], Mj[11]] as V3 };
  }));
  return { knife: k, side, down, left, guard, pommel, hands: atRest, solid: new Float32Array(sol), joints, rest: W };
}

/** A small loop of cord through a hilt's lanyard ring (its centre `c`), hanging toward `down`: the knot at its bottom. */
function ringLoop(c: V3, down: V3): V3[] {
  const R = 0.105, n = 10;
  const u = norm3(cross3(down, [1, 0, 0]));
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return add3(add3(c, scale3(down, 0.19 - R)), add3(scale3(down, Math.cos(a) * R), scale3(u, Math.sin(a) * R)));
  });
}

/** The bone most of a part's points ride on. */
function mostBone(sel: { bone: number }[]): number {
  const n = new Map<number, number>();
  for (const q of sel) n.set(q.bone, (n.get(q.bone) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
}

/** Whether a hand point lies inside the wrap's outline within its slab. */
function handIn(hands: Float32Array, s: { n: V3; at: number; u: V3; v: V3 }, hull: [number, number][], H: number): boolean {
  for (let i = 0; i < hands.length; i += 3) {
    const p: V3 = [hands[i], hands[i + 1], hands[i + 2]];
    if (Math.abs(dot(p, s.n) - s.at) > H) continue;
    const a = dot(p, s.u), b = dot(p, s.v);
    let inside = true;
    for (let j = 0; j < hull.length && inside; j++) {
      const p0 = hull[j], p1 = hull[(j + 1) % hull.length];
      if ((p1[0] - p0[0]) * (b - p0[1]) - (p1[1] - p0[1]) * (a - p0[0]) < 0) inside = false;
    }
    if (inside) return true;
  }
  return false;
}

/** Convex hull (counter-clockwise) of 2D points. */
function convexHull(p: [number, number][]): [number, number][] {
  const s = [...p].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const q of s) {
    while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = s.length - 1; i >= 0; i--) {
    const q = s[i];
    while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** A convex outline moved out by d (each corner along its two edges' normals). */
function inflate(h: [number, number][], d: number): [number, number][] {
  const n = h.length;
  return h.map((p, i) => {
    const a = h[(i - 1 + n) % n], b = h[(i + 1) % n];
    const e1 = unit2([p[0] - a[0], p[1] - a[1]]), e2 = unit2([b[0] - p[0], b[1] - p[1]]);
    // (Counter-clockwise: the outside is to the right of travel.)
    const m = unit2([e1[1] + e2[1], -e1[0] - e2[0]]);
    const k = Math.min(2, 1 / Math.max(0.5, m[0] * e1[1] - m[1] * e1[0]));
    return [p[0] + m[0] * d * k, p[1] + m[1] * d * k] as [number, number];
  });
}

/** A closed outline as n points evenly along it. */
function resample(h: [number, number][], n: number): [number, number][] {
  const L: number[] = [0];
  for (let i = 0; i < h.length; i++) L.push(L[i] + Math.hypot(h[(i + 1) % h.length][0] - h[i][0], h[(i + 1) % h.length][1] - h[i][1]));
  const total = L[h.length], out: [number, number][] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = (i / n) * total;
    while (j < h.length - 1 && L[j + 1] < d) j++;
    const t = (d - L[j]) / Math.max(1e-9, L[j + 1] - L[j]), a = h[j], b = h[(j + 1) % h.length];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** A viewmodel geometry's hands and sleeves at rest in the knife's frame (bones W; `kb` the knife's bone), as points over the surface. */
function skinned(g: { getAttribute(n: string): { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number; getComponent(i: number, c: number): number } | undefined }, W: Float32Array, kb: number): Float32Array {
  const rig = r();
  const pos = g.getAttribute("position")!, SI = g.getAttribute("skinIndex")!, SW = g.getAttribute("skinWeight")!;
  const Ki = new Float32Array(12), S = new Float32Array(12);
  invert34(W, kb * 12, Ki, 0);
  const mats = new Map<number, Float32Array>();
  const mat = (bi: number) => {
    let m = mats.get(bi);
    if (!m) {
      concat(W, bi * 12, rig.inv, bi * 12, S, 0);
      m = new Float32Array(12);
      concat(Ki, 0, S, 0, m, 0);
      mats.set(bi, m);
    }
    return m;
  };
  const n = pos.count - (pos.count % 3);
  const out: number[] = [];
  const tri = new Float32Array(9);
  for (let t = 0; t < n; t += 3) {
    // (The knife's own triangles ride on the knife's bones; the rest is hand, glove and sleeve.)
    if (knifeBones().has(SI.getComponent(t, 0))) continue;
    for (let c3 = 0; c3 < 3; c3++) {
      const i = t + c3;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      let vx = 0, vy = 0, vz = 0;
      for (let c = 0; c < 4; c++) {
        const w = SW.getComponent(i, c);
        if (w <= 0) continue;
        const m = mat(SI.getComponent(i, c));
        vx += w * (m[0] * x + m[1] * y + m[2] * z + m[3]);
        vy += w * (m[4] * x + m[5] * y + m[6] * z + m[7]);
        vz += w * (m[8] * x + m[9] * y + m[10] * z + m[11]);
      }
      (tri[c3 * 3] = vx), (tri[c3 * 3 + 1] = vy), (tri[c3 * 3 + 2] = vz);
    }
    sampleTri(tri, 0, out);
  }
  return new Float32Array(out);
}

/** Furthest apart two samples of a triangle may be (units): under the cord's width. */
const SAMPLE = 0.07;
/** Points over triangle `o` of `p` (its corners included), no further apart than SAMPLE. */
export function sampleTri(p: ArrayLike<number>, o: number, out: number[]): void {
  const e = (a: number, b: number) => Math.hypot(p[o + a] - p[o + b], p[o + a + 1] - p[o + b + 1], p[o + a + 2] - p[o + b + 2]);
  const k = Math.max(1, Math.min(24, Math.ceil(Math.max(e(0, 3), e(3, 6), e(6, 0)) / SAMPLE)));
  for (let i = 0; i <= k; i++)
    for (let j = 0; j <= k - i; j++) {
      const a = i / k, b = j / k, c = 1 - a - b;
      out.push(p[o] * a + p[o + 3] * b + p[o + 6] * c, p[o + 1] * a + p[o + 4] * b + p[o + 7] * c, p[o + 2] * a + p[o + 5] * b + p[o + 8] * c);
    }
}

/** Whether `p` (knife-local) has no point of `pts` within `d`. */
function free(pts: Float32Array, p: V3, d: number): boolean {
  const d2 = d * d;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i] - p[0], y = pts[i + 1] - p[1], z = pts[i + 2] - p[2];
    if (x * x + y * y + z * z < d2) return false;
  }
  return true;
}

const xf = (m: Float32Array, p: V3): V3 => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const unit2 = (v: [number, number]): [number, number] => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};

export { BAIL_BOTTOM };
