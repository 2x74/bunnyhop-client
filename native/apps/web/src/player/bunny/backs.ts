// Back items (progression.ts slot "back", v0.0.42): built in code like the hats (hats.ts), in the bunny's bind pose and
// skinned to its spine, sharing the bunny's skeleton and material (one extra draw call, only for bunnies wearing one).
// They sit on the hoodie's back, fitted per build (the torso profile: Model A, Model B / Bun-E, Plush; mesh.ts
// torsoProfile) and per hood: with the hood down (a wig on the standard bunny) the hood lies bunched on the upper back
// with the ears hanging from it, so the items that would meet them sit lower there.
//
//   - Wings (the secret's): a small pair of feathered wings, separate thick feathers, the primaries dipped in gold.
//   - Wind-up Key: a thick brass toy key on a leather patch, its shaft angled up so the bow shows; it turns in clicks.
//   - Cape: the colourway's accent (or its owner's colours), lined and bound in ivory, the hop mark sewn on, at its
//     owner's length from the hips to the ankles; cloth with a late hem.
//   - Carrot Pack: a stuffed canvas rucksack, a leather lid, a carrot toggle, a big carrot whose leaves sway.
//   - Balloon: a bunny balloon in the accent on a string tied to the right shoulder blade; it rocks on its neck.
//   - Jet Pack: two squat accent pods with bell nozzles and fins, a saddle with a gauge, a flame under each.
//   - Sheathed Blade: a short sword across the back in the Half Oni Mask's lacquer and gold, slung over the right
//     shoulder, an ivory tusk swinging from its cord.
//   - Pinwheel: a two-tone paper windmill on a candy-striped stick at the left of the back, its wheel beside the head.
//
// One family: thick stock with hard chamfers (hardLoft / plate / turned), something that visibly holds each to the
// hoodie (leather, straps, a sling, a collar), one contrast of materials each, and motion with a late free end.
//
// Each geometry carries `backfx` (back-fx.ts: what each vertex does, its chain and bounce weights, shade) and `headwear`
// (hat-detail.ts materials, by colour); its motion's pivots and axis ride on geometry.userData.backRig (BackRig), set
// as uniforms by BunnyModel.

import * as THREE from "three";
import { add, Builder, cross, dot, frame, hat, len, lerp3, mixW, norm, ring, scale, smoothstep, sub, type Paint, type Wt } from "./builder";
import { rig, type V3 } from "./rig";
import { torsoFacePointFor, torsoPointFor, torsoProfile, type BunnyBody, type BunnyHood } from "./mesh";
import type { BunnyLook } from "./look";
import { ensureHeadwear } from "../hat-detail";
import type { BackKind, BackRig } from "../back-fx";
import { CAPE_ITEM, CAPE_LENGTH, capeLengthOf, MEDAL_DEFAULT, MEDAL_ITEM, medalCodeOf, medalOf, ROBE_ITEM } from "../../progression";
import { buildRobe } from "./robe";

const fixed = (color: number): Paint => ({ code: 0, color });
/** The colourway's accent, tagged with a colour that picks its material (hat-detail.ts) and is never drawn. */
const accent = (tag: number): Paint => ({ code: 1, color: tag });
/** Material tags for the accent parts (hat-detail.ts BY_COLOUR): fabric (cape, pinwheel sail), lacquer (balloon, jet pods). */
export const TAG_FABRIC = 0xfffffe, TAG_LACQUER = 0xfffffd;

/** The Cape's tone roles (backfx.w; back-fx.ts uCapeTones, capeTones): which of its colours a face takes. */
export const CAPE_ROLE = { outer: 1, trim: 2, lining: 3, clasp: 4 } as const;

/** What each item does (back-fx.ts advanceBack). */
export const BACK_KIND: Readonly<Record<string, BackKind>> = {
  "back-wings": "wings",
  "back-windup-key": "key",
  "back-cape": "cape",
  "back-carrot-pack": "pack",
  "back-balloon": "balloon",
  "back-jetpack": "jet",
  "back-blade": "blade",
  "back-pinwheel": "pinwheel",
  [ROBE_ITEM]: "robe",
  [MEDAL_ITEM]: "medal",
};

/** A back item this build can draw. */
export const isBack = (id: string | null | undefined): boolean => !!id && !!BUILD[id];

/**
 * A long ponytail and a pack: the hair rests over it. How far (units) the falling part of the tail stands further off
 * the back while this item is worn (hat-fx.ts uPonytail.w: it eases out above the pack's top), on the standard bunny
 * (the tail from the head, the hood down: it already hangs well off the back) and on Plush / Bun-E (the tail from the
 * raised hood, closer in). The other items leave the tail's place free (the key sits low under it, backFit).
 */
const PONY_REST: Readonly<Record<string, [number, number]>> = { "back-carrot-pack": [2.4, 4.3], "back-jetpack": [2.0, 3.9] };
export const ponytailRest = (back: string | null | undefined, bunny: boolean): number => (back && PONY_REST[back] ? PONY_REST[back][bunny ? 0 : 1] : 0);

/**
 * The fit a look, build, hood and hat give (Tek wears the standard hoodie's shape). `tail`: a ponytail hangs from a
 * raised hood (Plush, Bun-E), down the middle of the upper back: like the lowered hood, it takes that place, and the
 * items that would be in its way sit low.
 */
export type BackFit = { profile: "a" | "b" | "plush"; hood: BunnyHood; tail?: true; len?: number; tied?: true; medal?: number };
/** `capeLength`: the Cape's length (loadout.capeLength, a percent); it is part of the fit only when not the default. */
/** `tied`: the Robe worn tied (loadout.robeTied); part of the fit only then. */
/** `medal`: the Daily Medal's look (loadout.medal, progression.ts medalCode); part of the fit only when it has one. */
export function backFit(look: BunnyLook, body: BunnyBody, hood: BunnyHood, hat?: string | null, capeLength?: number | null, tied?: boolean | null, medal?: number | null): BackFit {
  const profile = look === "plush" ? "plush" : look === "bune" || (look === "bunny" && body === "feminine") ? "b" : "a";
  const h = look === "bunny" ? hood : "up";
  const len = capeLengthOf(capeLength);
  return { profile, hood: h, ...(h === "up" && hat === "hat-ponytail" ? { tail: true as const } : {}), ...(len !== null && len !== CAPE_LENGTH.default ? { len } : {}), ...(tied ? { tied: true as const } : {}), ...(medalCodeOf(medal) !== null ? { medal: medal! } : {}) };
}
/** (Only the Cape reads the length: the other items share a geometry whatever it is.) */
export const backKey = (id: string, f: BackFit): string => `${id}|${f.profile}|${f.hood}${f.tail ? "|tail" : ""}${f.len && id === CAPE_ITEM ? `|l${f.len}` : ""}${f.tied && id === ROBE_ITEM ? "|tied" : ""}${f.medal !== undefined && id === MEDAL_ITEM ? `|m${f.medal}` : ""}`;

/**
 * Where each item sits and how big it is: the numbers to change when the body does. (The items read the hoodie's
 * surface through the torso profile, mesh.ts, so a reshaped back carries them with it; these place them on it.)
 * A place is the item's anchor on the back, [x, z] in bind space (z up, x toward the bunny's left), and its size over
 * its design size (`s`):
 *   up    the hood up (every build)
 *   down  the hood down, on the standard bunny with a wig on: the lowered hood (mesh.ts HOOD_POUCH: the middle of the
 *         back from z 56.1 up, to 2.85 off it) and the ears hanging from it (x 1.6 to 7.8 either side, down to z 53.35,
 *         to 3.6 off the back; they swing) own the upper back. Each item takes one side of them on purpose:
 *           below    the key, the pack and the jet pack sit under the ears' tips at their full size (their straps run
 *                    up the back under the ears and beside the hood)
 *           under    the cape lies flat on the hoodie under the hood and the ears and hangs free from below them (cape())
 *           over     the wings and the blade stand off the back (`off`, units) and pass over the ears
 *           beside   the balloon is tied outside the right ear; the pinwheel's stick stands outside the left one
 *   tail  a ponytail hangs from a raised hood (Plush, Bun-E), down the middle of the upper back: the items that would be
 *         in its way sit low
 *   to    a second anchor, for the two items that lie along a line
 *   lift  added to every z of the item for a torso profile (a: Model A / Tek, b: Model B / Bun-E, plush)
 * The anchors: wings the left wing's root (mirrored); key the shaft's foot; cape the collar's height (x unused); pack
 * the bag's bottom, middle; balloon the knot on the hoodie; jet pack the pods' feet, middle; blade the scabbard's tip
 * (`at`) and throat (`to`); pinwheel the stick's foot (`at`) and the wheel's hub (`to`).
 * `off`: wings, how far their roots stand off the hoodie; blade, how far its throat end is lifted off the back.
 * `tilt`: wings, how far their plane leans back as it rises (its slope; they lean out over the hanging ears).
 * High on the back by default: the bunny leans forward when it runs and hops, and things worn low end up on its seat.
 */
export interface BackPlace { at: [number, number]; s: number; off?: number; tilt?: number }
export const BACK_FITS: Readonly<Record<string, { up: BackPlace; down?: BackPlace; tail?: BackPlace; to?: [number, number]; lift?: Partial<Record<BackFit["profile"], number>> }>> = {
  "back-wings": { up: { at: [2.9, 56.0], s: 1.04, off: 0.6, tilt: 0.22 }, down: { at: [2.9, 54.0], s: 1.04, off: 1.2, tilt: 0.42 } },
  "back-windup-key": { up: { at: [0, 57.2], s: 1.1 }, down: { at: [0, 44.2], s: 1.1 }, tail: { at: [0, 42.4], s: 1.1 } },
  "back-cape": { up: { at: [0, 62.5], s: 1 } },
  "back-carrot-pack": { up: { at: [0, 46.6], s: 1.18 }, down: { at: [0, 40.8], s: 1.18 }, tail: { at: [0, 40.2], s: 1.18 } },
  "back-balloon": { up: { at: [-6.2, 57.8], s: 1.3 }, down: { at: [-8.2, 57.0], s: 1.3 } },
  "back-jetpack": { up: { at: [0, 47.6], s: 1.22 }, down: { at: [0, 40.8], s: 1.22 }, tail: { at: [0, 40.6], s: 1.22 } },
  "back-blade": { up: { at: [8.6, 37.4], s: 1.25 }, down: { at: [8.6, 37.4], s: 1.25, off: 3.0 }, to: [-8.4, 61.8] },
  "back-pinwheel": { up: { at: [7.4, 46.5], s: 1.14 }, to: [10.9, 73.4] },
  // The Robe (robe.ts): the neck edge's height. The rest of its cut is taken from the build's own torso and arms.
  [ROBE_ITEM]: { up: { at: [0, 63.6], s: 1 } },
  // The Daily Medal hangs on the CHEST: the disc's middle, over the drawstrings' ends (it hides their tips). The hood
  // and a ponytail are on the other side of the body, so it has one place; `to` is where its ribbon comes out from
  // under the hood on each side ([x, z]).
  [MEDAL_ITEM]: { up: { at: [0, 53.0], s: 1 }, to: [3.3, 62.6] },
};

// ---------------------------------------------------------------------------------------------
// Shared pieces

/** What a part's vertices do (back-fx.ts backfx): the code, the chain weight, the bounce weight, shade in its creases. */
interface Fx {
  code?: number;
  w?: (p: V3) => number;
  k?: (p: V3) => number;
  shade?: (p: V3) => number;
}

interface Ctx {
  b: Builder;
  /** The hood is lowered onto the upper back (BACK_FITS `down`); `tail`: a ponytail hangs there from a raised hood. */
  down: boolean;
  tail: boolean;
  profile: BackFit["profile"];
  /** The back's surface at (x, z), `off` units out: the point and its outward normal. */
  on(x: number, z: number, off: number): [V3, V3];
  /** The torso surface at height z, angle th (0 = left side, pi/2 = back, -pi/2 = front), `off` out. */
  ring(z: number, th: number, off: number): V3;
  /** The hoodie's skin weights at a point (spine by height, shoulders toward the arms). */
  W(p: V3): Wt;
  /** backfx per vertex range (part), and the bounce weight of everything outside one. */
  fx: [number, number, Fx][];
  k: (p: V3) => number;
}

function ctxFor(f: BackFit): Ctx {
  const look: BunnyLook = f.profile === "plush" ? "plush" : "bunny";
  const prof = torsoProfile(look, f.profile === "b" ? "feminine" : "classic");
  const r = rig();
  const B = (n: string) => r.bone(n);
  const pelvis = B("Pelvis"), spine = B("Spine"), spine1 = B("Spine1"), spine2 = B("Spine2"), spine4 = B("Spine4"), neck = B("Neck1");
  return {
    b: new Builder(),
    down: f.hood === "down",
    tail: !!f.tail,
    profile: f.profile,
    on: (x, z, off) => torsoFacePointFor(x, z, 1, off, prof),
    ring: (z, th, off) => torsoPointFor(z, th, off, prof),
    // As mesh.ts torsoW, without the hem's pull toward the thighs.
    W: (p) => {
      const sp = hat(p[2], [[39, pelvis], [44.5, spine], [48.8, spine1], [54, spine2], [60.5, spine4], [64.5, spine4], [66.5, neck]]);
      const ax = Math.abs(p[0]);
      const cl = smoothstep(4.5, 9.5, ax) * smoothstep(55, 60.5, p[2]) * 0.6;
      const ua = smoothstep(8.2, 10.4, ax) * smoothstep(57.5, 61, p[2]) * 0.25;
      const side = p[0] >= 0 ? "L" : "R";
      return mixW([sp, 1 - cl - ua], [[[B(`${side}_Clavicle`), 1]], cl], [[[B(`${side}_UpperArm`), 1]], ua]);
    },
    fx: [],
    k: () => 0,
  };
}

/** An item's place and size for this fit (BACK_FITS): its hood-down or ponytail place where it has one. */
function fitOf(c: Ctx, id: string): { x: number; z: number; x2: number; z2: number; s: number; off: number; tilt: number } {
  const F = BACK_FITS[id], P = (c.down ? F.down : c.tail ? F.tail : undefined) ?? F.up, dz = F.lift?.[c.profile] ?? 0;
  return { x: P.at[0], z: P.at[1] + dz, x2: F.to?.[0] ?? 0, z2: (F.to?.[1] ?? 0) + dz, s: P.s, off: P.off ?? 0, tilt: P.tilt ?? 0 };
}
/** p as it lands when a section is scaled by s about o (Builder.scaleSection). */
const scaled = (p: V3, o: V3, s: number): V3 => add(o, scale(sub(p, o), s));

/** Runs `fn`, giving what it builds the motion `fx` (parts don't nest). */
function part(c: Ctx, fx: Fx, fn: () => void): void {
  const start = c.b.vertexCount;
  fn();
  c.fx.push([start, c.b.vertexCount, fx]);
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * `roles`: tone roles for faces by their paint ([fixed colour, or null for the colourway's accent; role]), written to
 * backfx.w (the Cape's colours: CAPE_ROLE).
 */
function finish(c: Ctx, rigOf: BackRig, roles?: [number | null, number][]): THREE.BufferGeometry {
  const g = c.b.geometry();
  const P = g.getAttribute("position");
  const n = P.count;
  const fx = new Float32Array(n * 4);
  const at = (i: number): V3 => [P.getX(i), P.getY(i), P.getZ(i)];
  for (let i = 0; i < n; i++) (fx[i * 4] = 1), (fx[i * 4 + 2] = clamp01(c.k(at(i))));
  for (const [a, b, f] of c.fx)
    for (let i = a; i < b; i++) {
      const p = at(i);
      fx[i * 4] = (f.code ?? 1) + (f.shade ? 0.45 * clamp01(f.shade(p)) : 0);
      fx[i * 4 + 1] = f.w ? clamp01(f.w(p)) : 0;
      fx[i * 4 + 2] = clamp01((f.k ?? c.k)(p));
    }
  if (roles) {
    const C = g.getAttribute("partColor"), A = g.getAttribute("accent");
    const table = roles.map(([hex, role]) => [hex === null ? null : new THREE.Color(hex), role] as const);
    for (let i = 0; i < n; i++)
      for (const [col, role] of table)
        if (col === null ? Math.abs(A.getX(i) - 1) < 0.01 : A.getX(i) === 0 && Math.abs(col.r - C.getX(i)) + Math.abs(col.g - C.getY(i)) + Math.abs(col.b - C.getZ(i)) < 0.004) {
          fx[i * 4 + 3] = role;
          break;
        }
  }
  g.setAttribute("backfx", new THREE.Float32BufferAttribute(fx, 4));
  ensureHeadwear(g);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 50), 60);
  g.userData.backRig = rigOf;
  return g;
}

const centroid = (ps: V3[]): V3 => scale(ps.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / ps.length);

/**
 * A swept solid with crisp edges: secs[i] is the section's corner points at step i along the path (the same count at
 * each). Every side of the section is its own strip, smooth along the path and flat across, so the corners stay hard:
 * the look of cut metal and folded card. `ring`: the path closes on itself; `open`: the section doesn't (a profile, a
 * plate's edge). paint(j, i): side j at step i.
 */
function hardLoft(b: Builder, secs: V3[][], paint: (j: number, i: number) => Paint, W: (p: V3) => Wt, o: { ring?: boolean; open?: boolean; capStart?: Paint; capEnd?: Paint } = {}): void {
  const rows = o.ring ? [...secs, secs[0]] : secs;
  const R = rows.length, J = secs[0].length;
  const cen = rows.map(centroid);
  const T = (i: number): V3 => (o.ring ? sub(cen[(i + 1) % (R - 1)], cen[(i - 1 + (R - 1)) % (R - 1)]) : sub(cen[Math.min(R - 1, i + 1)], cen[Math.max(0, i - 1)]));
  const sides = o.open ? J - 1 : J;
  // One winding for the whole solid: whichever faces most sides away from the section's middle.
  let vote = 0;
  for (const i of [0, Math.floor(R / 2)]) for (let j = 0; j < sides; j++) {
    const a = rows[i][j], c = rows[i][(j + 1) % J];
    vote += Math.sign(dot(cross(T(i), sub(c, a)), sub(lerp3(a, c, 0.5), cen[i])));
  }
  const sgn = vote < 0 ? -1 : 1;
  for (let j = 0; j < sides; j++) {
    const j1 = (j + 1) % J;
    const strip = rows.map((r) => [r[j], r[j1]]);
    b.surface(strip, { closed: false, paint: (i) => paint(j, i), weight: (p) => W(p), out: (i) => scale(cross(T(i), sub(strip[i][1], strip[i][0])), sgn) });
  }
  const cap = (i: number, dir: V3, p: Paint) => {
    const c = cen[i], n = norm(dir);
    for (let j = 0; j < J; j++) b.tri(c, rows[i][j], rows[i][(j + 1) % J], n, n, n, p, W(c), W(rows[i][j]), W(rows[i][(j + 1) % J]));
  };
  if (o.capStart) cap(0, scale(T(0), -1), o.capStart);
  if (o.capEnd) cap(R - 1, T(R - 1), o.capEnd);
}

/**
 * A turned part (a boss, a collar, a nozzle): `prof` [along the axis, radius] points, each step of the profile its own
 * crisp band. paint(j): band j.
 */
function turned(b: Builder, c: V3, axis: V3, prof: [number, number][], paint: (j: number) => Paint, W: (p: V3) => Wt, sides = 20, uRef: V3 = [1, 0, 0]): void {
  const [t, u, v] = frame(axis, uRef);
  const secs = Array.from({ length: sides }, (_, i) => {
    const a = (i / sides) * Math.PI * 2;
    const d = add(scale(u, Math.cos(a)), scale(v, Math.sin(a)));
    return prof.map(([h, r]): V3 => add(add(c, scale(t, h)), scale(d, Math.max(r, 1e-4))));
  });
  hardLoft(b, secs, (j) => paint(j), W, { ring: true, open: true });
}

/**
 * A flat plate cut from an outline (a closed loop of points in a plane, seen from +N; star-shaped about its middle),
 * `t` thick, its edges chamfered by `bv`: the face toward +N, the one toward -N, the chamfers and the rim each their own
 * paint.
 */
function plate(b: Builder, outline: V3[], N: V3, t: number, bv: number, paint: { face: Paint; back?: Paint; bevel?: Paint; rim?: Paint }, W: (p: V3) => Wt): void {
  const n = outline.length;
  const mid = centroid(outline);
  const secs = outline.map((q, i) => {
    let m = norm(cross(sub(outline[(i + 1) % n], outline[(i - 1 + n) % n]), N));
    if (dot(m, sub(q, mid)) < 0) m = scale(m, -1);
    const inset = sub(q, scale(m, bv));
    return [add(inset, scale(N, t / 2)), add(q, scale(N, t / 2 - bv)), add(q, scale(N, -(t / 2 - bv))), add(inset, scale(N, -t / 2))];
  });
  const bevel = paint.bevel ?? paint.face, rim = paint.rim ?? bevel;
  hardLoft(b, secs, (j) => (j === 1 ? rim : bevel), W, { ring: true, open: true });
  for (const [side, p] of [[1, paint.face], [-1, paint.back ?? paint.face]] as const) {
    const c = add(mid, scale(N, (side * t) / 2)), nn = scale(N, side);
    for (let i = 0; i < n; i++) {
      const a = secs[i][side > 0 ? 0 : 3], d = secs[(i + 1) % n][side > 0 ? 0 : 3];
      b.tri(c, a, d, nn, nn, nn, p, W(c), W(a), W(d));
    }
  }
}

/** A closed tube round a loop (a ring of path points): a torus when the loop is a circle. */
function loop(b: Builder, path: V3[], r: number, sides: number, ref: V3, paint: Paint, W: Wt): void {
  const n = path.length;
  const rows = [...path, path[0]].map((p, i) => {
    const d = norm(sub(path[(i + 1) % n], path[(i - 1 + n) % n]));
    const [, u, v] = frame(d, ref);
    return ring(p, u, v, r, r, sides);
  });
  b.surface(rows, { paint: () => paint, weight: () => W });
}

/**
 * A flat strap laid over the hoodie along `path` (points on the surface, `out` their outward normals): `w` wide, `t`
 * thick, skinned like the hoodie under it.
 */
function strap(c: Ctx, path: V3[], out: V3[], w: number, t: number, paint: Paint): void {
  const rows = path.map((p, i) => {
    const d = norm(sub(path[Math.min(path.length - 1, i + 1)], path[Math.max(0, i - 1)]));
    const n = out[i];
    const a = norm(cross(n, d));
    const o = add(p, scale(n, t / 2));
    return [add(add(o, scale(a, w / 2)), scale(n, t / 2)), add(add(o, scale(a, -w / 2)), scale(n, t / 2)), add(add(o, scale(a, -w / 2)), scale(n, -t / 2)), add(add(o, scale(a, w / 2)), scale(n, -t / 2))];
  });
  c.b.surface(rows, { paint: () => paint, weight: (p) => c.W(p), flat: true, capStart: paint, capEnd: paint });
}

/**
 * The two shoulder straps of a pack, from (+-x0, z0) on the back up over the shoulders and down the chest to z1, laid on
 * the hoodie. `slide`: a square slide on each, halfway up the back.
 */
function shoulderStraps(c: Ctx, x0: number, z0: number, z1: number, paint: Paint, w = 1.3, slide?: Paint): void {
  for (const sx of [1, -1]) {
    const path: V3[] = [], out: V3[] = [];
    const push = (p: V3, n: V3) => (path.push(p), out.push(norm(n)));
    // Up the back to the top of the shoulder, over it (clear of the hood's rim and the lowered hood's collar) and down
    // the chest.
    const Z_TOP = 62.2, X_TOP = 6.1;
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const [p, n] = c.on(sx * (x0 + (X_TOP - x0) * t), z0 + (Z_TOP - z0) * t, 0.25);
      push(p, n);
    }
    const [pb] = c.on(sx * X_TOP, Z_TOP, 0.25);
    const [pf] = torsoFront(c, sx * X_TOP, Z_TOP);
    const yMid = c.ring(Z_TOP, 0, 0)[1];
    for (let i = 1; i < 6; i++) {
      const s = i / 6;
      const y = pb[1] + (pf[1] - pb[1]) * s;
      push([sx * X_TOP, y, Z_TOP + 1.7 * Math.sin(Math.PI * s)], [sx * 0.3, (y - yMid) * 0.15, 1]);
    }
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const [p, n] = torsoFront(c, sx * (X_TOP - 1.4 * t), Z_TOP - (Z_TOP - z1) * t);
      push(p, n);
    }
    strap(c, path, out, w, 0.32, paint);
    if (slide) {
      const along = norm(sub(path[5], path[3]));
      const [, u, v] = frame(out[4], along);
      plate(c.b, ring(add(path[4], scale(out[4], 0.3)), v, u, w / 2 + 0.3, 0.62, 12, 5), out[4], 0.36, 0.1, { face: slide }, (p) => c.W(p));
    }
  }
}

/** The front of the torso at (x, z), 0.25 out (the straps' way down the chest). */
function torsoFront(c: Ctx, x: number, z: number): [V3, V3] {
  // c.on is the back (+1); the front is the same profile mirrored in y about its centre.
  const [pb, nb] = c.on(x, z, 0);
  const mid = c.ring(z, 0, 0)[1];
  const y = 2 * mid - pb[1];
  const n: V3 = norm([nb[0], -nb[1], nb[2]]);
  return [add([pb[0], y, pb[2]], scale(n, 0.25)), n];
}

// ---------------------------------------------------------------------------------------------
// The items

/**
 * Wind-up Key: a toy's key, cut from thick brass. A leather patch riveted to the hoodie carries a brass escutcheon; the
 * shaft comes out of it angled up, so the bow (two ear-shaped loops in the shaft's own plane, as on a real key) shows
 * its face from behind and above as it turns. Bright chamfers, dark walls inside the loops, a ruby in the middle.
 * The shaft and bow turn in clicks about the shaft (code 2) and nod on a hop.
 */
function windupKey(f: BackFit): THREE.BufferGeometry {
  const c = ctxFor(f);
  const { b } = c;
  const BRASS = fixed(0xe2ae48), BRIGHT = fixed(0xf6d57a), DEEP = fixed(0x94661f), LEATHER = fixed(0x5b4330), RUBY = fixed(0xe0213b);
  // Between the shoulder blades, above the hoodie's mark. With the hood down it sits below the mark and the ears' tips
  // instead, at the same size and angle; under a ponytail from a raised hood in the small of the back, nearly level.
  const F = fitOf(c, "back-windup-key"), TILT = c.tail ? 0.1 : 0.48, SHAFT = 6.0;
  const [p0, n] = c.on(F.x, F.z, 0);
  const W0 = c.W(p0), W = () => W0;
  const [, u, v] = frame(n, [1, 0, 0]);
  const axis = norm(add(n, [0, 0, Math.tan(TILT)]));
  // Still: the patch, its rivets, the escutcheon.
  plate(b, ring(add(p0, scale(n, 0.2)), u, v, 3.5, 3.5, 28, 4.5), n, 0.4, 0.14, { face: LEATHER, rim: LEATHER }, W);
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) b.surface(b.ellipsoidRows(add(p0, add(scale(u, sx * 2.75), add(scale(v, sz * 2.75), scale(n, 0.38)))), [0.36, 0.36, 0.36], n, u, 8, 3, 0, Math.PI / 2), { paint: () => BRIGHT, weight: W });
  turned(b, p0, n, [[0.3, 2.45], [0.7, 2.45], [0.92, 2.2], [0.92, 1.7], [0.6, 1.5], [0.6, 0]], (j) => [DEEP, BRIGHT, BRASS, DEEP, DEEP][j], W, 24, u);
  // The turning part: about the shaft's foot.
  const [, A, Nn] = frame(axis, u);
  const at = (a: number, h: number, off = 0): V3 => add(p0, add(scale(A, a), add(scale(axis, h), scale(Nn, off))));
  part(c, { code: 2, w: () => 1 }, () => {
    turned(b, p0, axis, [[0.5, 0], [0.5, 1.25], [1.2, 1.25], [1.45, 0.98], [1.45, 0.72], [SHAFT - 1.3, 0.72], [SHAFT - 1.3, 1.05], [SHAFT - 1.05, 1.2], [SHAFT, 1.2]], (j) => [DEEP, BRASS, BRIGHT, DEEP, BRASS, DEEP, BRIGHT, BRASS][j], W, 16, A);
    // The bow: stock of T thick and 2 * HW wide round each loop, the outer end of a loop fuller than the inner (an ear).
    const T = 1.4, BV = 0.28, HW = 0.85, CA = 3.3, RA = 2.1, RH = 2.3, CH = SHAFT + 2.05;
    for (const sx of [1, -1]) {
      const K = 36;
      const line = (th: number): [number, number] => [sx * (CA + RA * Math.cos(th)), CH + RH * Math.sin(th) * (1 + 0.2 * Math.cos(th))];
      const secs = Array.from({ length: K }, (_, k) => {
        const th = (k / K) * Math.PI * 2;
        const [a, h] = line(th), [a0, h0] = line(th - 0.02), [a1, h1] = line(th + 0.02);
        // Outward in the bow's plane, from the loop's middle.
        let ma = h1 - h0, mh = -(a1 - a0);
        const l = Math.hypot(ma, mh) || 1;
        (ma /= l), (mh /= l);
        if (ma * (a - sx * CA) + mh * (h - CH) < 0) (ma = -ma), (mh = -mh);
        const q = (o: number, t: number) => at(a + ma * o, h + mh * o, t);
        const e = T / 2;
        return [q(HW, -(e - BV)), q(HW, e - BV), q(HW - BV, e), q(-HW + BV, e), q(-HW, e - BV), q(-HW, -(e - BV)), q(-HW + BV, -e), q(HW - BV, -e)];
      });
      hardLoft(b, secs, (j) => (j === 4 ? DEEP : j % 2 ? BRIGHT : BRASS), W, { ring: true });
    }
    // The waist between the loops, a little proud of them, and the ruby set in each side of it.
    const waist = ring(at(0, CH - 0.1), A, axis, 1.6, 2.15, 20, 3.2);
    plate(b, waist, Nn, T + 0.5, 0.32, { face: BRASS, bevel: BRIGHT, rim: DEEP }, W);
    for (const s of [1, -1]) b.surface(b.ellipsoidRows(at(0, CH - 0.1, s * (T / 2 + 0.25)), [0.78, 0.78, 0.48], scale(Nn, s), A, 12, 4, 0, Math.PI / 2), { paint: () => RUBY, weight: W });
  });
  b.scaleSection(0, p0, F.s);
  return finish(c, { pivot: p0, pivot2: p0, axis });
}

/**
 * Cape: a hero's cape in the colourway's accent, lined and bound in ivory. It hangs from a fold-over collar across the
 * shoulders (a cord from its ends ties at the front of the collar with a gold clasp), in three unequal folds to a hem
 * cut on a slant, its corners rounded. It covers the hoodie's hop mark, so it wears the mark itself, sewn on in ivory.
 * Its owner sets its length (BackFit.len, a percent: 100 the short cape at the hips, CAPE_LENGTH.max a hem at the
 * ankles: a longer cape is the same cape let down and flared from below the elbows into an A-line, with a mantle over
 * the shoulders, deeper folds fanning out to a scalloped swallowtail hem, and its side edges turned back to show the
 * lining) and may pick its colours (its
 * faces carry a tone role, CAPE_ROLE, that the shader fills from uCapeTones). Cloth (code 3): it streams, swings and
 * ripples, the hem late; below the hips it hangs by its own weight, round the legs and onto the ground (BackRig.hang,
 * back-fx.ts); its creases are shaded.
 */
function cape(f: BackFit): THREE.BufferGeometry {
  const c = ctxFor(f);
  const { b } = c;
  const CLOTH = accent(TAG_FABRIC), IVORY = fixed(0xf3ecdc), IVORY_SHADE = fixed(0xcdbfa6), CLASP = fixed(0xe6b54a);
  // The cord in the colourway's detail colour (palette slot 7: laces and aglets), so it reads on any hoodie.
  const CORD: Paint = { code: 3 + 7 };
  // L: its length over the short cape's (BASE units from the collar to the hem); G: 0 the short cape .. 1 the longest.
  const L = Math.min(CAPE_LENGTH.max, Math.max(CAPE_LENGTH.min, f.len ?? CAPE_LENGTH.default)) / 100, BASE = 20.9;
  const G = (L - 1) / (CAPE_LENGTH.max / 100 - 1);
  const ROWS = Math.round(24 * L), K = 32 + Math.round(12 * G);
  // The top: round the back of the shoulders on the torso (TH: half the arc). With the hood down the lowered hood and
  // the ears hanging from it lie over the cape: down to Z_FREE (under the ears' tips) it is flat on the hoodie under
  // them (UNDER off it: no folds, no hang, a flat collar and mantle), and it hangs and swings from there.
  const UNDER = 0.14, Z_FREE = 53;
  const Z_RING = fitOf(c, "back-cape").z, OFF = c.down ? UNDER : 0.5, TH = 0.8;
  const topAt = (u: number): V3 => c.ring(Z_RING - 0.4 * Math.cos((u * Math.PI) / 2) ** 2, Math.PI / 2 - u * TH, OFF);
  const pivot = topAt(0), yHang = pivot[1];
  // (How far down that is, in short capes; free: 0 where the cape is held flat, 1 where it hangs.)
  const D_FREE = (pivot[2] - Z_FREE) / BASE;
  const free = (d: number) => (c.down ? smoothstep(D_FREE, D_FREE + 0.3, d) : 1);
  // Its half-width: gathered at the shoulders, out to HIP at the hips (the short cape's hem); a long cape flares from
  // below the elbows, its sides curving out to HEM (an A-line: at full length the hem is half as wide again as the
  // bunny's shoulders).
  const HIP = 8.9, HEM = HIP + 7.4 * G, FLARE = 0.5;
  const halfAt = (s: number, top = topAt(1)[0]) => {
    const d = s * L;
    return top + (HIP - top) * Math.pow(Math.min(1, d), 0.8) + (HEM - HIP) * Math.pow(Math.max(0, (d - FLARE) / Math.max(1e-6, L - FLARE)), 1.7);
  };
  // Three folds, none alike: [where across, how wide, how deep]. They run the length and fan out with the flare, far
  // deeper at a long cape's hem.
  const FOLDS: [number, number, number][] = [[-0.6, 0.27, 2.0], [0.03, 0.2, 1.35], [0.58, 0.3, 2.3]];
  const DEEP = 1 + 1.5 * G;
  const ridge = (u: number) => FOLDS.reduce((m, [u0, w, a]) => m + a * Math.exp(-(((u - u0) / w) ** 2)), 0);
  /** How far the folds stand out at (u, s), and the most they do at that s. */
  const fold = (u: number, s: number) => ridge(u) * DEEP * Math.pow(s, 0.8) * free(s * L);
  const foldMax = (s: number) => 1.5 * DEEP * Math.pow(s, 0.8) + 1e-6;
  // The hem: lower toward the bunny's left, the corners rounded up. A long cape's is a shallow swallowtail (its middle
  // higher than its two tails) and scalloped: it dips where a fold stands out.
  const hemZ = (u: number) => Z_RING - BASE * L - 1.5 * u + (3.4 - 1.4 * G) * Math.pow(Math.abs(u), 5) + 2.6 * G * (1 - u * u) - 1.1 * G * (ridge(u) / 1.5);
  const LEN = pivot[2] - hemZ(0.7);
  // A long cape's side edges are turned back over it toward the hem, showing the lining: how far (0..1) at (u, s).
  const turned = (u: number, s: number) => G * smoothstep(0.84, 1, Math.abs(u)) * smoothstep(0.3, 0.9, s);
  // Below the hoodie's hem there is no back to lie on: the cape hangs clear behind the legs.
  const Z_BODY = 36;
  /** The sheet at (u, s), its edges not turned. */
  const sheet = (u: number, s: number): V3 => {
    const top = topAt(u);
    const x = top[0] + (u * HIP - top[0]) * Math.pow(Math.min(1, s * L), 0.8) + (L > 1 ? u * (halfAt(s, HIP) - HIP) : 0);
    const z = top[2] + (hemZ(u) - top[2]) * s;
    // d: how far down, in short capes (1 = where the short cape ends).
    const d = s * L, d1 = Math.min(1, d);
    const back = z >= Z_BODY ? c.on(Math.max(-HIP, Math.min(HIP, x)), z, OFF)[0][1] : -1e9;
    // Below the shoulder blades it hangs straight, a little further out toward the hem, its sides curling in.
    const hang = yHang + 0.5 + 1.1 * d1 + 0.4 * (d - d1) - 2.0 * Math.pow(Math.abs(u), 3) * (0.3 + 0.7 * d1) * (1 - 0.6 * G);
    const hung = Math.max(back, top[1] + (Math.max(back, hang) - top[1]) * smoothstep(0, 0.3, d));
    const f = free(d), y = f >= 1 ? hung : back + (hung - back) * f;
    // The folds stand out from it, deeper toward the hem; small gathers where it leaves the collar.
    return [x, y + fold(u, s) + (c.down ? 0 : 0.2 * (1 - d1) ** 2 * (0.5 + 0.5 * Math.cos(u * Math.PI * 9))), z];
  };
  const cloth = (u: number, s: number): V3 => {
    const e = turned(u, s);
    if (e <= 0) return sheet(u, s);
    // A turned-back edge comes in again from where it folds, lying on the cloth there.
    const q = sheet(u - Math.sign(u) * e * 0.3, s);
    return [q[0], q[1] + 1.6 * smoothstep(0, 0.4, e), q[2]];
  };
  const us = Array.from({ length: K + 1 }, (_, k) => -1 + (2 * k) / K);
  const ss = Array.from({ length: ROWS + 1 }, (_, i) => i / ROWS);
  const outer = ss.map((s) => us.map((u) => cloth(u, s)));
  // The cloth's normal (toward the viewer behind) at a point of it.
  const FACING = cross(sub(cloth(0.02, 0.5), cloth(-0.02, 0.5)), sub(cloth(0, 0.52), cloth(0, 0.48)))[1] < 0 ? -1 : 1;
  const normalAt = (u: number, s: number): V3 => {
    const e = 0.02, es = 0.02 / L;
    // (One way round for the whole sheet: on a turned-back edge it faces the cape, and the lining faces out.)
    return scale(norm(cross(sub(cloth(Math.min(1, u + e), s), cloth(Math.max(-1, u - e), s)), sub(cloth(u, Math.min(1, s + es)), cloth(u, Math.max(0, s - es))))), FACING);
  };
  const NRM = ss.map((s) => us.map((u) => normalAt(u, s)));
  const inner = outer.map((r, i) => r.map((q, k) => add(q, scale(NRM[i][k], -0.3))));
  // Shade in the valleys between the folds (from a bind position: its place across and down the cape).
  const crease = (p: V3) => {
    const s = clamp01((pivot[2] - p[2]) / LEN);
    const u = Math.max(-1, Math.min(1, p[0] / halfAt(s, 5.6)));
    return clamp01(0.9 - fold(u, s) / foldMax(s)) * Math.pow(s, 0.6) * 0.95;
  };
  const W = (p: V3) => c.W(p);
  const BIND_ROWS = 2, BIND_COLS = 2;
  part(c, { code: 3, shade: crease }, () => {
    // The outside: the accent, its hem and sides bound in ivory.
    b.surface(outer, { closed: false, paint: (i, k) => (i >= ROWS - BIND_ROWS || k < BIND_COLS || k >= K - BIND_COLS ? IVORY : CLOTH), weight: W, out: (i, k) => NRM[i][k] });
  });
  part(c, { code: 3 }, () => {
    // The lining, and the cloth's edge round the sides and the hem.
    b.surface(inner, { closed: false, paint: () => IVORY_SHADE, weight: W, out: (i, k) => scale(NRM[i][k], -1) });
    for (const k of [0, K]) b.surface(ss.map((_, i) => [outer[i][k], inner[i][k]]), { closed: false, paint: () => IVORY, weight: W, out: () => [us[k], 0, 0] });
    b.surface(us.map((_, k) => [outer[ROWS][k], inner[ROWS][k]]), { closed: false, paint: () => IVORY, weight: W, out: () => [0, 0, -1] });
    // The hop mark (mesh.ts arc: three growing hops and a dot, in its 64 x 64 box), sewn on a little right of the
    // middle, between the shoulder blades and the hips at any length.
    const SU = 0.024, SS = 0.0084, U0 = 0.04, S0 = 0.52;
    const on = (px: number, py: number, off: number): V3 => {
      const u = U0 - (px - 32) * SU, sdown = (S0 + (py - 31) * SS) / L;
      return add(cloth(u, sdown), scale(normalAt(u, sdown), off));
    };
    const quads: [number, number][][] = [[[8, 47], [14.5, 33], [21, 47]], [[21, 47], [29, 25], [37, 47]], [[37, 47], [46.5, 15], [56, 47]]];
    const pts: [number, number][] = [];
    for (const [q0, q1, q2] of quads)
      for (let i = pts.length ? 1 : 0; i <= 10; i++) {
        const t = i / 10;
        pts.push([(1 - t) * (1 - t) * q0[0] + 2 * (1 - t) * t * q1[0] + t * t * q2[0], (1 - t) * (1 - t) * q0[1] + 2 * (1 - t) * t * q1[1] + t * t * q2[1]]);
      }
    const HALF = 2.5;
    const edge = (sgn: number) => pts.map(([x, y], i) => {
      const [nx, ny] = pts[Math.min(pts.length - 1, i + 1)], [qx, qy] = pts[Math.max(0, i - 1)];
      const l = Math.hypot(nx - qx, ny - qy) || 1;
      return on(x - ((ny - qy) / l) * HALF * sgn, y + ((nx - qx) / l) * HALF * sgn, 0.09);
    });
    b.surface([edge(1), edge(-1)], { closed: false, paint: () => IVORY, weight: W, out: () => [0, 1, 0] });
    const dot: V3[][] = [0, 0.5, 1].map((r) => Array.from({ length: 12 }, (_, k) => on(57.5 + 4.6 * r * Math.cos((k / 12) * Math.PI * 2), 47 + 4.6 * r * Math.sin((k / 12) * Math.PI * 2), 0.11)));
    b.surface(dot, { closed: true, paint: () => IVORY, weight: W, out: () => [0, 1, 0] });
  });
  // (The collar, cord and clasp sit on the shoulders: they take no cloth motion's hang, only its top's.)
  part(c, { code: 3 }, () => {
    // A long cape is worn over the shoulders: a short mantle from under the collar, round the sides of the neck and
    // over the shoulder line, deepest in the middle of the back, its edge bound.
    const M = smoothstep(0, 0.4, G);
    if (M > 0.01) {
      const A = TH + 0.42 * M, MR = 5, MK = 28;
      const rows = Array.from({ length: MR + 1 }, (_, i) => {
        const t = i / MR;
        return Array.from({ length: MK + 1 }, (_, k) => {
          const v = -1 + (2 * k) / MK;
          const depth = M * (3.4 + 2.8 * Math.cos((v * Math.PI) / 2));
          const zTop = Z_RING + 0.6;
          // (Proud of the cloth it lies over, most at its edge; flat on it under the lowered hood.)
          return c.ring(zTop - t * depth, Math.PI / 2 - v * A, c.down ? UNDER + 0.2 + 0.1 * t : 0.9 + 1.5 * t);
        });
      });
      const mid = c.ring(Z_RING - 2, Math.PI / 2, -3);
      b.surface(rows, { closed: false, paint: (i) => (i >= MR - 1 ? IVORY : CLOTH), weight: W, out: (i, k) => sub(rows[i][k], mid) });
      b.surface(rows.map((r) => r.map((q) => add(q, scale(norm(sub(q, mid)), -0.25)))), { closed: false, paint: () => IVORY_SHADE, weight: W, out: (i, k) => sub(mid, rows[i][k]) });
    }
    // The collar: the cape's top folded over, fuller in the middle, lying on the slope of the shoulders (it leans in
    // toward the neck as they do, under the hood's edge); a flat band under the lowered hood.
    const slope = (u: number, off: number): [V3, V3] => {
      const z = Z_RING + 0.35 - 0.4 * Math.cos((u * Math.PI) / 2) ** 2, th = Math.PI / 2 - u * TH;
      return [c.ring(z, th, off), norm(sub(c.ring(z + 0.7, th, off), c.ring(z - 0.7, th, off)))];
    };
    const THICK = c.down ? 0.18 : 0.62;
    const rows = us.map((u, k) => {
      const fat = 0.75 + 0.3 * Math.cos((u * Math.PI) / 2);
      const [q, up] = slope(u, OFF * 0.4 + fat * THICK), [q0] = slope(us[Math.max(0, k - 1)], 0), [q1] = slope(us[Math.min(K, k + 1)], 0);
      const [, cu, cv] = frame(norm(sub(q1, q0)), up);
      return ring(q, cu, cv, fat * 1.25, fat * THICK, 10, 2.6);
    });
    b.surface(rows, { paint: () => IVORY, weight: W, capStart: IVORY, capEnd: IVORY });
    // The cord from the collar's ends over the shoulders and round the front, and the clasp where it ties.
    const cord: V3[] = [];
    for (let k = 0; k <= 40; k++) cord.push(c.ring(Z_RING + 0.35, Math.PI / 2 - TH - ((2 * Math.PI - 2 * TH) * k) / 40, 0.4));
    b.tube(cord, 0.3, 6, [0, 0, 1], () => CORD, W, true);
    const front = c.ring(Z_RING + 0.15, -Math.PI / 2, 0.75);
    for (const sx of [1, -1]) b.surface(b.ellipsoidRows(add(front, [sx * 0.6, 0, 0]), [0.7, 0.7, 0.7], [0, -1, 0], [1, 0, 0], 12, 5, 0, Math.PI / 2), { paint: () => CLASP, weight: W, capEnd: CLASP });
  });
  // Where it leaves the body and hangs by its own weight (the hoodie's hem: every point below is on the pelvis), and
  // the ground under the feet; only a cape that reaches below it needs either.
  const Z_HIP = 38;
  // (Under the lowered hood it swings from where it comes free, not from the collar.)
  const swing: V3 = c.down ? [0, c.on(0, Z_FREE + 1, OFF)[0][1], Z_FREE + 1] : pivot;
  return finish(c, { pivot: swing, axis: [LEN - (pivot[2] - swing[2]), G, HEM], ...(hemZ(1) < Z_HIP ? { hang: [Z_HIP, 0.45] as [number, number] } : {}) }, [[null, CAPE_ROLE.outer], [0xf3ecdc, CAPE_ROLE.trim], [0xcdbfa6, CAPE_ROLE.lining], [0xe6b54a, CAPE_ROLE.clasp]]);
}

/**
 * Carrot Pack: a stuffed canvas rucksack, fuller at the bottom, with a dark gusset under it, ivory piping round its
 * face and a leather lid strapped down by one broad strap that fastens with a little carrot for a toggle. A big carrot
 * sticks out of the open corner at the left, its three thick leaves arching over the shoulder; a pocket on the right.
 * Leather straps with brass slides go over the shoulders. The leaves sway (a chain) and the bag squashes on a takeoff
 * (bounce).
 */
function carrotPack(f: BackFit): THREE.BufferGeometry {
  const c = ctxFor(f);
  const { b } = c;
  const CANVAS = fixed(0xd4b47c), GUSSET = fixed(0xa98552), LID = fixed(0x8e6b3e), LEATHER = fixed(0x7a5536), PIPING = fixed(0xf3ecdc), BRASS = fixed(0xe2ae48);
  const ORANGE = fixed(0xff8a2a), ORANGE_DARK = fixed(0xe0701c), LEAF = fixed(0x5cbd4f), LEAF_DARK = fixed(0x2f8a3a);
  const F = fitOf(c, "back-carrot-pack"), S = F.s;
  const zb = F.z, H = 10.4, HW = 5.2, HD = 2.7;
  const [mid] = c.on(0, zb + (H / 2) * S, 0);
  // Built at its design size against the back, then scaled about the bottom of its back face (O).
  const O: V3 = [0, mid[1], zb];
  const yc = mid[1] + HD + 0.1;
  const W0 = c.W([0, yc, zb + H / 2]), W = () => W0;
  // The bag gives under a takeoff: more toward its top; what sits on it rides along; the straps let it.
  const SQUASH = 0.62;
  c.k = (p) => (p[1] < mid[1] - 3 ? 0 : p[2] > zb + H * S ? SQUASH * smoothstep(61.8, zb + H * S, p[2]) : SQUASH * clamp01((p[2] - zb) / (H * S)));
  // The body: rounded rings stacked up, fullest a third of the way up, drawn in a little under the lid.
  const N = 16;
  const full = (t: number) => Math.pow(1 - Math.pow(Math.abs(2 * t - 1), 4.2), 1 / 4.2) * (1 + 0.1 * Math.sin(Math.PI * Math.min(1, t / 0.66)) - 0.05 * t);
  const body = Array.from({ length: N + 1 }, (_, i) => {
    const t = i / N;
    return ring([0, yc, zb + t * H], [1, 0, 0], [0, 1, 0], HW * full(t) + 0.02, HD * full(t) + 0.02, 28, 3);
  });
  b.surface(body, { paint: (i) => (i < 3 ? GUSSET : CANVAS), weight: W, capStart: GUSSET, capEnd: LID });
  const yo = yc + HD * 1.08;
  // Piping round the bag's outer face.
  loop(b, ring([0, yo - 0.5, zb + H * 0.47], [1, 0, 0], [0, 0, 1], HW * 0.83, H * 0.4, 28, 3.6), 0.2, 6, [0, 1, 0], PIPING, W0);
  // The lid: leather, over the top and down the outer face, cut short at the left where the carrot comes out.
  {
    const R = 8, K = 12;
    const rows = Array.from({ length: R + 1 }, (_, i) => {
      const t = i / R;
      // From the back edge of the top, over, and down the face to a rounded lip.
      const a = Math.min(1, t / 0.45) * (Math.PI / 2);
      const y = yc - HD * 0.8 + HD * 1.95 * Math.sin(a), z = zb + H + 0.25 - (1 - Math.cos(a)) * 0.9 - Math.max(0, t - 0.45) * 7.2;
      return Array.from({ length: K + 1 }, (_, k) => {
        const u = k / K;
        const lip = t > 0.45 ? 0.9 * Math.pow(Math.abs(2 * u - 1), 3) * ((t - 0.45) / 0.55) : 0;
        return [-HW * 0.9 + u * HW * 1.42, y + (t > 0.45 ? 0.1 : 0), z + lip] as V3;
      });
    });
    b.surface(rows, { closed: false, paint: () => LID, weight: W, out: (i) => (i < 4 ? [0, 0.3, 1] : [0, 1, 0]) });
    b.surface(rows.map((r) => r.map((q): V3 => [q[0], q[1] - 0.22, q[2] - 0.22])), { closed: false, paint: () => GUSSET, weight: W, out: (i) => (i < 4 ? [0, -0.3, -1] : [0, -1, 0]) });
  }
  // The strap that holds the lid down, and its toggle: a little carrot through a brass ring.
  {
    const x = -0.9;
    plate(b, ring([x, yo + 0.25, zb + H * 0.46], [1, 0, 0], [0, 0, 1], 0.85, H * 0.36, 14, 5), [0, 1, 0], 0.3, 0.1, { face: LEATHER }, W);
    const t0: V3 = [x, yo + 0.72, zb + H * 0.3];
    loop(b, ring(t0, [0, 0, 1], [0, 1, 0], 0.62, 0.5, 12), 0.13, 5, [1, 0, 0], BRASS, W0);
    b.tube([add(t0, [1.5, 0, 0.1]), add(t0, [0.4, 0.05, 0]), add(t0, [-0.9, 0, -0.05]), add(t0, [-1.7, 0, -0.1])], (i) => [0.5, 0.46, 0.3, 0.06][i], 8, [0, 0, 1], () => ORANGE, W, true);
    b.tube([add(t0, [1.5, 0, 0.1]), add(t0, [2.0, 0.1, 0.5])], (i) => [0.2, 0.08][i], 6, [0, 0, 1], () => LEAF, W, true);
  }
  // A pocket on the right, buttoned.
  b.surface(b.ellipsoidRows([-HW - 0.1, yc + 0.2, zb + 3.3], [1.0, 1.9, 2.7], [-1, 0, 0], [0, 0, 1], 14, 6, 0, Math.PI / 2), { paint: () => GUSSET, weight: W, capEnd: GUSSET });
  b.surface(b.ellipsoidRows([-HW - 1.05, yc + 0.2, zb + 4.4], [0.3, 0.36, 0.36], [-1, 0, 0], [0, 0, 1], 8, 4, 0, Math.PI / 2), { paint: () => BRASS, weight: W });
  // The carrot: its shoulder out of the open corner at the left, leaning out, ringed.
  // (With the hood down, or under a ponytail, it lies over further: out from under the hanging ear's tip.)
  const over = c.down || c.tail;
  const dir = norm(over ? [0.9, 0.12, 0.42] : [0.52, 0.2, 0.83]);
  const base: V3 = [over ? 3.1 : 2.7, yc + 0.3, zb + H - 1.6];
  const [, cu, cv] = frame(dir, [0, 1, 0]);
  const cring = (t: number, r: number) => ring(add(base, scale(dir, t)), cu, cv, r, r, 16);
  const carrot: [number, number, Paint][] = [[0, 1.1, ORANGE], [1.1, 1.3, ORANGE], [1.2, 1.36, ORANGE_DARK], [1.4, 1.36, ORANGE], [2.5, 1.5, ORANGE], [2.6, 1.55, ORANGE_DARK], [2.8, 1.55, ORANGE], [3.8, 1.5, ORANGE], [4.3, 1.2, ORANGE], [4.6, 0.7, LEAF_DARK]];
  part(c, { k: () => SQUASH }, () => b.surface(carrot.map(([t, r]) => cring(t, r)), { paint: (i) => carrot[i + 1][2], weight: W, capStart: ORANGE, capEnd: LEAF_DARK }));
  // Three thick leaves from its crown: up, out over the left shoulder, and back, each folded along its middle.
  const crown = add(base, scale(dir, 4.5));
  const LEAVES: [V3, number, number][] = [[norm(add(dir, [-0.15, -0.1, 0.5])), 7.2, 1.35], [norm(add(dir, [0.75, 0.0, -0.1])), 6.2, 1.2], [norm(add(dir, [-0.1, 0.8, 0.0])), 5.4, 1.1]];
  LEAVES.forEach(([out, LL, wide], li) => {
    const sideV = norm(cross(out, li === 2 ? [1, 0, 0] : [0, 1, 0]));
    const up = norm(cross(sideV, out));
    part(c, { w: (p) => Math.pow(clamp01(dot(sub(p, scaled(crown, O, S)), out) / (LL * S)), 1.2), k: () => SQUASH }, () => {
      const M = 9;
      const rows = Array.from({ length: M + 1 }, (_, i) => {
        const t = i / M;
        // It arches out and droops toward its tip; widest a third of the way along, coming to a soft point.
        const p = add(add(crown, scale(out, LL * t)), [0, 0, -1.5 * t * t]);
        const w = wide * Math.pow(Math.sin(Math.PI * Math.min(1, 0.1 + 0.9 * t)), 0.7) * (1 - 0.25 * t) + 0.08;
        const fold = 0.34 * w;
        return [add(p, scale(sideV, w)), add(p, add(scale(sideV, w * 0.5), scale(up, fold))), add(p, scale(up, 0.12)), add(p, add(scale(sideV, -w * 0.5), scale(up, fold))), add(p, scale(sideV, -w)), add(p, scale(up, -0.3))];
      });
      hardLoft(b, rows, (j) => (j < 4 ? (j === 1 || j === 2 ? LEAF_DARK : LEAF) : LEAF_DARK), W, { capStart: LEAF_DARK, capEnd: LEAF });
    });
  });
  b.scaleSection(0, O, S);
  shoulderStraps(c, 3.3 * S, zb + (H - 1.0) * S, 52.5, LEATHER, 1.5, BRASS);
  return finish(c, { pivot: scaled(crown, O, S), axis: [0, 0, 1] });
}

/**
 * Balloon: a bunny balloon in the colourway's accent, on a string tied in a bow to a leather tab on the right shoulder
 * blade. A round head with two inflated ears, the right one gone soft and flopped over; the bunny's dark visor and eyes
 * printed on its front; a rolled neck and a knot. The string bends from its knot (a chain) and the balloon, carried on
 * its end, rocks on its neck (code 8).
 */
function balloon(f: BackFit): THREE.BufferGeometry {
  const c = ctxFor(f);
  const { b } = c;
  const SKIN = accent(TAG_LACQUER), STRING = fixed(0xf2efe6), LEATHER = fixed(0x7a5536), VISOR = fixed(0x161117), EYE = fixed(0xffd84a);
  const F = fitOf(c, "back-balloon"), S = F.s;
  const [p0, n0] = c.on(F.x, F.z, 0.3);
  const W0 = c.W(p0), W = () => W0;
  const d = norm([-0.42, 0.3, 0.86]);
  const L = 17.5;
  // Still: the tab, and the bow the string is tied in.
  {
    const [, u, v] = frame(n0, [0, 0, 1]);
    plate(b, ring(add(p0, scale(n0, -0.12)), v, u, 1.15, 1.5, 14, 4), n0, 0.34, 0.1, { face: LEATHER }, W);
    for (const s of [1, -1]) {
      const cen = add(p0, add(scale(v, s * 0.85), scale(n0, 0.3)));
      loop(b, Array.from({ length: 12 }, (_, k) => {
        const a = (k / 12) * Math.PI * 2;
        return add(cen, add(scale(v, Math.cos(a) * 0.75), scale(u, Math.sin(a) * 0.45 + 0.1 * s)));
      }), 0.17, 6, n0, STRING, W0);
      b.tube([add(p0, scale(n0, 0.3)), add(p0, add(scale(v, s * 0.5), add(scale(u, -1.0), scale(n0, 0.3)))), add(p0, add(scale(v, s * 0.75), add(scale(u, -1.9), scale(n0, 0.25))))], 0.16, 6, n0, () => STRING, W, true);
    }
    b.surface(b.ellipsoidRows(add(p0, scale(n0, 0.35)), [0.4, 0.4, 0.4], n0, u, 10, 5), { paint: () => STRING, weight: W, closed: true });
  }
  const end = add(p0, scale(d, L));
  const along = (p: V3) => clamp01(dot(sub(p, p0), d) / L);
  // The string, with a little slack in it.
  part(c, { w: along }, () => {
    const side = norm(cross(d, [0, 1, 0]));
    const path = Array.from({ length: 17 }, (_, i): V3 => add(add(p0, scale(d, (L * i) / 16)), scale(side, 0.4 * Math.sin((Math.PI * 2 * i) / 16))));
    b.tube(path, 0.26, 6, [0, 1, 0], () => STRING, W, true);
  });
  // The balloon, on the string's end (built at its design size, then scaled about the string's end).
  const HZ = 4.5, RX = 4.25;
  const cen = add(end, scale(d, HZ + 0.9));
  const [, u, v] = frame(d, [1, 0, 0]);
  // Darker underneath, so it keeps its roundness on a dark map.
  const under = (p: V3) => 0.5 * smoothstep(0.1, -0.95, dot(sub(p, scaled(cen, end, S)), d) / (HZ * S));
  part(c, { code: 8, w: () => 1, shade: under }, () => {
    const first = b.vertexCount;
    // The knot and the rolled neck.
    b.surface(b.ellipsoidRows(add(end, scale(d, 0.1)), [0.5, 0.5, 0.45], d, u, 10, 5), { paint: () => SKIN, weight: W, closed: true });
    turned(b, end, d, [[0.35, 0], [0.35, 0.72], [0.62, 0.78], [0.8, 0.6], [1.1, 0.45]], () => SKIN, W, 12, u);
    // The head: full on top, drawn in toward the neck.
    const rows: V3[][] = [];
    const R = 16;
    for (let i = 0; i <= R; i++) {
      const a = (i / R) * Math.PI;
      const h = Math.cos(a) * HZ * (a > Math.PI / 2 ? 1.08 : 0.94);
      const r = Math.sin(a) * RX * (1 - 0.3 * Math.pow(Math.max(0, -Math.cos(a)), 1.5));
      rows.push(ring(add(cen, scale(d, h)), u, v, Math.max(r, 0.001), Math.max(r, 0.001) * 0.95, 24));
    }
    b.surface(rows, { paint: () => SKIN, weight: W, out: (i, k) => norm(sub(rows[i][k], cen)) });
    // The ears: twisted off at their roots, the left one tight and upright, the right one soft and flopped outward.
    const up = d, outL = u;
    const ear = (sx: number, pts: [number, number, number][], fat: number) => {
      const root = add(cen, add(scale(up, HZ * 0.86), scale(outL, sx * 1.75)));
      const path = pts.map(([o, bk, h]): V3 => add(root, add(scale(outL, sx * o), add(scale(v, bk), scale(up, h)))));
      const N = 14;
      const smooth = Array.from({ length: N + 1 }, (_, i): V3 => {
        const fi = (i / N) * (path.length - 1), j = Math.min(path.length - 2, Math.floor(fi));
        return lerp3(path[j], path[j + 1], fi - j);
      });
      b.tube(smooth, (i) => {
        const t = i / N;
        return Math.max(0.05, fat * (0.42 + 0.58 * Math.sin(Math.PI * Math.min(1, 0.12 + 0.9 * t))) * (t > 0.9 ? Math.sqrt(1 - ((t - 0.9) / 0.1) ** 2 * 0.75) : 1));
      }, 12, [0, 1, 0], () => SKIN, W, true);
    };
    ear(1, [[0, 0, -0.3], [0.25, 0, 1.3], [0.65, 0.1, 2.9], [0.95, 0.15, 4.5], [1.05, 0.2, 5.9]], 1.62);
    ear(-1, [[0, 0, -0.3], [0.3, 0, 1.2], [0.95, 0.2, 2.6], [2.1, 0.5, 3.3], [3.4, 0.8, 2.8], [4.2, 1.0, 1.7]], 1.42);
    // The print on its front (the bunny faces -y): the visor's dark band and two eyes.
    const sgn = v[1] < 0 ? 1 : -1;
    const face = (lon: number, lat: number, off: number): V3 => {
      const dir = add(scale(v, sgn * Math.cos(lon) * Math.cos(lat)), add(scale(u, Math.sin(lon) * Math.cos(lat)), scale(d, Math.sin(lat))));
      return add(cen, scale(dir, RX * (0.95 + 0.04 * Math.abs(Math.sin(lon))) + off));
    };
    const visor: V3[][] = Array.from({ length: 5 }, (_, i) => Array.from({ length: 13 }, (_, k) => {
      const lon = -0.92 + (1.84 * k) / 12, t = i / 4;
      const edge = 0.1 * (lon / 0.92) ** 2;
      return face(lon, 0.0 + edge + (0.44 - 2 * edge) * t, 0.07);
    }));
    b.surface(visor, { closed: false, paint: () => VISOR, weight: W, out: (i, k) => sub(visor[i][k], cen) });
    for (const s of [1, -1]) {
      const eye: V3[][] = Array.from({ length: 3 }, (_, i) => Array.from({ length: 4 }, (_, k) => face(s * 0.36 + (-0.16 + (0.32 * k) / 3), 0.19 + 0.07 * (i - 1), 0.13)));
      b.surface(eye, { closed: false, paint: () => EYE, weight: W, out: (i, k) => sub(eye[i][k], cen) });
    }
    b.scaleSection(first, end, S);
  });
  return finish(c, { pivot: p0, pivot2: end, axis: d });
}

/**
 * Jet Pack: a toy rocket pack. Two squat pods in the colourway's accent, their nozzles splayed a little, each with a
 * cream stripe, a steel nose stud, a dark bell nozzle with a bright lip and a fin; a gunmetal saddle between them with a
 * brass pressure gauge, a bent grab handle across the top and a fuel line to the left pod only. Webbing straps with
 * brass slides go over the shoulders. A rounded flame burns under each nozzle (code 5), hot at the root; the pack
 * sinks on a takeoff and springs back (bounce).
 */
function jetpack(f: BackFit): THREE.BufferGeometry {
  const c = ctxFor(f);
  const { b } = c;
  const SHELL = accent(TAG_LACQUER), STRIPE = fixed(0xf3ecdc), STEEL = fixed(0xc9ced6), GUN = fixed(0x3a3f48), GUN_DARK = fixed(0x23262d), STRAP = fixed(0x2a2d33), BRASS = fixed(0xe2ae48), NEEDLE = fixed(0xe0213b);
  const HOT = fixed(0xfff3c4), FLAME = fixed(0xffa53c), TIP = fixed(0xf2622a);
  // With the hood down its top stops under the hanging ears' tips.
  const F = fitOf(c, "back-jetpack"), S = F.s;
  const z0 = F.z;
  const X = 3.3, R = 2.3, CANT = 0.07;
  const [mid] = c.on(0, z0 + 5.5 * S, 0);
  // Built at its design size against the back, then scaled about the bottom of its back plate (O).
  const O: V3 = [0, mid[1], z0];
  const yc = mid[1] + R + 0.25;
  const W0 = c.W([0, yc, z0 + 5.5]), W = () => W0;
  c.k = (p) => (p[1] < mid[1] - 3 ? 0 : smoothstep(61.8, z0 + 8.5 * S, p[2]));
  const dirOf = (sx: number): V3 => norm([-sx * Math.sin(CANT), 0, Math.cos(CANT)]);
  const footOf = (sx: number): V3 => [sx * X, yc, z0];
  // The back plate against the hoodie and the saddle between the pods.
  plate(b, ring([0, mid[1] + 0.5, z0 + 5.0], [1, 0, 0], [0, 0, 1], 4.4, 4.3, 24, 4), [0, 1, 0], 0.7, 0.2, { face: GUN_DARK, rim: GUN }, W);
  const saddle = [1.2, 2.2, 4.6, 7.0, 8.0].map((h, i) => ring([0, yc - 0.55 + (i === 0 || i === 4 ? -0.35 : 0), z0 + h], [1, 0, 0], [0, 1, 0], i === 0 || i === 4 ? 1.5 : 1.95, i === 0 || i === 4 ? 1.75 : 2.15, 20, 3.4));
  b.surface(saddle, { paint: () => GUN, weight: W, capStart: GUN_DARK, capEnd: GUN_DARK });
  // The gauge on the saddle: a brass bezel, a cream dial, a red needle pointing up and to the left.
  const gc: V3 = [0, yc + 1.6, z0 + 5.6];
  turned(b, gc, [0, 1, 0], [[-0.3, 1.38], [0.28, 1.38], [0.42, 1.22], [0.42, 1.02], [0.2, 0.98], [0.2, 0]], (j) => [BRASS, BRASS, BRASS, GUN_DARK, STRIPE][j], W, 20);
  {
    const a = 0.75, dx = Math.sin(a), dz = Math.cos(a);
    const tip: V3 = add(gc, [dx * 0.82, 0.3, dz * 0.82]), tail: V3 = add(gc, [-dx * 0.25, 0.3, -dz * 0.25]);
    hardLoft(b, [tail, tip].map((q, i) => [add(q, [dz * (i ? 0.05 : 0.16), -0.06, -dx * (i ? 0.05 : 0.16)]), add(q, [0, 0.08, 0]), add(q, [-dz * (i ? 0.05 : 0.16), -0.06, dx * (i ? 0.05 : 0.16)])]), () => NEEDLE, W, { capStart: NEEDLE, capEnd: NEEDLE });
  }
  for (const sx of [1, -1]) {
    const foot = footOf(sx), d = dirOf(sx);
    const [, u, v] = frame(d, [1, 0, 0]);
    const at = (h: number, r: number, n = 24) => ring(add(foot, scale(d, h)), u, v, r, r, n);
    // The shell: a capsule, its stripe painted round it, a rounded nose.
    const shell: [number, number, Paint][] = [
      [0.55, 1.9, SHELL], [0.9, 2.2, SHELL], [1.5, R, SHELL], [5.5, R, SHELL], [5.5, R + 0.01, STRIPE], [6.7, R + 0.01, STRIPE], [6.7, R, SHELL],
      [7.6, R * 0.985, SHELL], [8.5, R * 0.9, SHELL], [9.25, R * 0.74, SHELL], [9.85, R * 0.52, SHELL], [10.2, R * 0.3, SHELL],
    ];
    b.surface(shell.map(([h, r]) => at(h, r)), { paint: (i) => shell[i + 1][2], weight: W });
    // Hardware: the nose stud, the collar under the shell, the bell nozzle (bright lip, dark mouth).
    turned(b, add(foot, scale(d, 10.2)), d, [[0, R * 0.3], [0.12, 0.55], [0.5, 0.5], [0.62, 0.3], [0.62, 0]], () => STEEL, W, 12);
    turned(b, foot, d, [[0.6, 1.95], [0.3, 2.05], [0, 2.05], [-0.15, 1.2], [-0.5, 1.05], [-1.9, 1.72], [-2.2, 1.78], [-2.2, 1.5], [-1.2, 0.8], [-1.2, 0]], (j) => [STEEL, STEEL, GUN, GUN, GUN, STEEL, STEEL, GUN_DARK, HOT][j], W, 20);
    // A fin on the outside of each pod, low.
    const out: V3 = [sx, 0, 0];
    const fp = (r: number, h: number): V3 => add(add(foot, scale(d, h)), scale(out, r));
    plate(b, [fp(2.1, 4.3), fp(3.5, 1.7), fp(4.15, -0.7), fp(3.6, -1.0), fp(1.9, 0.45)], [0, 1, 0], 0.6, 0.16, { face: STEEL, rim: GUN }, W);
  }
  // The grab handle between the pods' shoulders, bent off to the left; the fuel line from the saddle to the left pod.
  {
    const a: V3 = add(add(footOf(1), scale(dirOf(1), 8.9)), [-0.3, -0.2, 0]), e: V3 = add(add(footOf(-1), scale(dirOf(-1), 8.9)), [0.3, -0.2, 0]);
    const path = Array.from({ length: 13 }, (_, i): V3 => {
      const t = i / 12, arch = Math.sin(Math.PI * t);
      return add(lerp3(a, e, t), [0.55 * arch * (1 - t), -0.2 * arch, 2.2 * Math.pow(arch, 0.7) - 0.5 * arch * t]);
    });
    b.tube(path, 0.42, 8, [0, 1, 0], () => STEEL, W, true);
    const h0: V3 = [1.2, yc + 1.2, z0 + 3.1], h1: V3 = add(add(footOf(1), scale(dirOf(1), 2.0)), [-0.2, R - 0.1, 0]);
    b.tube(Array.from({ length: 9 }, (_, i): V3 => add(lerp3(h0, h1, i / 8), [0, 0.75 * Math.sin((Math.PI * i) / 8), -0.5 * Math.sin((Math.PI * i) / 8)])), 0.2, 6, [0, 0, 1], () => BRASS, W, true);
  }
  // The flames: a rounded puff under each nozzle, hot at its root.
  const nzOf = (sx: number): V3 => add(footOf(sx), scale(dirOf(sx), -1.9));
  part(c, { code: 5, k: () => 1 }, () => {
    for (const sx of [1, -1]) {
      const d = scale(dirOf(sx), -1), nz = nzOf(sx);
      const [, u, v] = frame(d, [1, 0, 0]);
      const N = 9, L = 3.4;
      const rows = Array.from({ length: N + 1 }, (_, i) => {
        const t = i / N;
        // Swells out of the mouth, then draws in to a rounded tip.
        const r = Math.max(0.001, 1.28 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.22 + 0.78 * t)), 0.75) * (1 - 0.3 * t));
        return ring(add(nz, scale(d, L * t)), u, v, r, r, 14);
      });
      b.surface(rows, { paint: (i) => (i < 2 ? HOT : i < 6 ? FLAME : TIP), weight: W, capStart: HOT });
    }
  });
  b.scaleSection(0, O, S);
  shoulderStraps(c, 2.7 * S, z0 + 8.2 * S, 52.0, STRAP, 1.5, BRASS);
  return finish(c, { pivot: O, pivot2: scaled(nzOf(1), O, S), axis: scale(dirOf(1), -1) });
}

/**
 * Sheathed Blade: a short sword across the back, the hilt over the right shoulder, in the Half Oni Mask's lacquer and
 * gold. A broad curved scabbard cut in planes (red on its face, dark red on the planes turned down, black bands), a
 * blunt gold fang for its tip, a chunky gold guard, a grip wrapped in black over ivory, a gold pommel. It hangs from a
 * cord slung over the right shoulder and across the chest, between two black knobs on the scabbard; a second cord tied
 * round the middle ends in an ivory tusk like the mask's, and swings (a chain).
 */
function blade(f: BackFit): THREE.BufferGeometry {
  const c = ctxFor(f);
  const { b } = c;
  const RED = fixed(0xc81e2a), RED_DARK = fixed(0x84121d), BLACK = fixed(0x161117), GOLD = fixed(0xe6b54a), GOLD_DEEP = fixed(0x94661f), WRAP = fixed(0x1d1a24), SAME = fixed(0xece0c2), CORD = fixed(0x3b1d4a), TUSK_TIP = fixed(0xc9b78c);
  // From the left hip up to the right shoulder blade, resting on the back's middle, bowed a little (its back upward).
  const F = fitOf(c, "back-blade"), S = F.s;
  const A0: [number, number] = [F.x, F.z], A1: [number, number] = [F.x2, F.z2];
  const yRest = c.on(0, (A0[1] + A1[1]) / 2, 0)[0][1] + 1.3;
  // (With the hood down its upper end is lifted off the back, F.off: it rests over the right ear.)
  const p0: V3 = [A0[0], yRest + 0.3, A0[1]], p1: V3 = [A1[0], yRest - 0.2 + F.off, A1[1]];
  const d = norm(sub(p1, p0));
  const L = len(sub(p1, p0));
  const W0 = c.W([0, yRest, 50]), W = () => W0;
  const across = norm(cross([0, 1, 0], d));
  const thick = norm(cross(d, across));
  const BOW = 0.85, FANG = 0.11;
  // The scabbard's line: t 0 (tip) .. 1 (throat); the fang hooks up at the very tip.
  const line = (t: number): V3 => add(add(p0, scale(d, L * t)), scale(across, BOW * Math.sin(Math.PI * t) + 0.55 * Math.max(0, 1 - t / FANG) ** 2));
  const dirAt = (t: number): V3 => norm(sub(line(Math.min(1, t + 0.01)), line(Math.max(0, t - 0.01))));
  const sec = (t: number, w: number, h: number): V3[] => {
    const dt = dirAt(t), ac = norm(cross([0, 1, 0], dt)), th = norm(cross(dt, ac)), o = line(t);
    return ([[w, 0], [0.42 * w, h], [-0.42 * w, h], [-w, 0], [-0.42 * w, -h], [0.42 * w, -h]] as const).map(([x, y]) => add(o, add(scale(ac, x), scale(th, y))));
  };
  // [t, paint of the stretch that starts here]: the fang, a black band, the lacquer, a gold band under the cord, the
  // lacquer, a black band, the gold throat.
  const BANDS: [number, Paint | null][] = [[0, GOLD], [0.035, GOLD], [0.075, GOLD], [FANG, BLACK], [0.135, null], [0.22, null], [0.3, null], [0.385, GOLD], [0.42, null], [0.52, null], [0.62, null], [0.72, null], [0.8, BLACK], [0.845, null], [0.9, null], [0.95, GOLD], [1, GOLD]];
  const widthAt = (t: number) => 1.32 * S * (t < FANG ? 0.3 + 0.7 * Math.pow(t / FANG, 0.55) : 1) * (1 + 0.06 * t);
  hardLoft(b, BANDS.map(([t]) => sec(t, widthAt(t), 0.64 * S * (t < FANG ? 0.45 + 0.55 * (t / FANG) : 1))), (j, i) => BANDS[i][1] ?? (j === 1 || j === 0 ? RED : j === 2 ? RED_DARK : RED_DARK), W, { capStart: GOLD, capEnd: GOLD });
  const dEnd = dirAt(1), acEnd = norm(cross([0, 1, 0], dEnd)), thEnd = norm(cross(dEnd, acEnd)), throat = line(1);
  const hilt = (h: number): V3 => add(throat, scale(dEnd, h));
  // The guard: a thick rounded square of gold, its rim darker; the collar; the wrapped grip; the pommel.
  plate(b, ring(hilt(0.35), acEnd, thEnd, 2.05 * S, 1.6 * S, 20, 3.4), dEnd, 0.7, 0.18, { face: GOLD, rim: GOLD_DEEP }, W);
  const oval = (h: number, w: number, hh: number, n = 12) => ring(hilt(h), acEnd, thEnd, w * S, hh * S, n);
  b.surface([oval(0.7, 0.92, 0.7), oval(1.25, 0.86, 0.66)], { paint: () => GOLD, weight: W });
  const G0 = 1.25, GL = 5.3, GR = 10;
  b.surface(Array.from({ length: GR + 1 }, (_, i) => oval(G0 + (GL * i) / GR, 0.8 - 0.05 * Math.sin((Math.PI * i) / GR), 0.62)), { paint: (i, k) => ((i + (k >> 1)) % 2 ? WRAP : (k >> 1) % 3 === 1 ? SAME : WRAP), weight: W });
  turned(b, hilt(G0 + GL), dEnd, [[0, 0.86 * S], [0.2, 0.95 * S], [0.8, 0.9 * S], [1.1, 0.6 * S], [1.15, 0]], () => GOLD, W, 14, acEnd);
  // The knobs the sling ties to (black lacquer, a gold eye), low and high on the scabbard's face.
  const T_LOW = 0.2, T_HIGH = 0.8;
  for (const t of [T_LOW, T_HIGH]) {
    const o = add(line(t), scale(thick, 0.6 * S));
    b.surface(b.ellipsoidRows(o, [1.1, 0.7, 0.72], thick, dirAt(t), 12, 5, 0, Math.PI / 2), { paint: () => BLACK, weight: W, capEnd: BLACK });
    b.surface(b.ellipsoidRows(add(o, scale(thick, 0.6)), [0.34, 0.34, 0.34], thick, d, 8, 4, 0, Math.PI / 2), { paint: () => GOLD, weight: W });
  }
  // The sling: from the high knob over the right shoulder, down across the chest, round the left side to the low knob.
  {
    const path: V3[] = [], out: V3[] = [];
    const push = (p: V3, n: V3) => (path.push(p), out.push(norm(n)));
    const hi = line(T_HIGH), lo = line(T_LOW);
    const Z_TOP = 62.2, X_TOP = -6.1;
    // (Lifted off the back, the scabbard is reached from the hoodie by the sling's first span.)
    if (F.off > 0) push(add(hi, scale(thick, -0.5 * S)), [-0.5, 0, 0.85]);
    for (let i = 0; i <= 5; i++) {
      const [p, n] = c.on(hi[0] + (X_TOP - hi[0]) * (i / 5), hi[2] + (Z_TOP - hi[2]) * (i / 5), 0.25);
      push(p, F.off > 0 && i === 0 ? [-0.5, 0.5, 0.7] : n);
    }
    const [pb] = c.on(X_TOP, Z_TOP, 0.25), [pf] = torsoFront(c, X_TOP, Z_TOP);
    const yMid = c.ring(Z_TOP, 0, 0)[1];
    for (let i = 1; i < 6; i++) {
      const y = pb[1] + (pf[1] - pb[1]) * (i / 6);
      push([X_TOP, y, Z_TOP + 1.7 * Math.sin((Math.PI * i) / 6)], [-0.3, (y - yMid) * 0.15, 1]);
    }
    const XF = 6.4, ZF = 46.6;
    for (let i = 0; i <= 10; i++) {
      const [p, n] = torsoFront(c, X_TOP + (XF - X_TOP) * (i / 10), Z_TOP + (ZF - Z_TOP) * (i / 10));
      push(p, n);
    }
    // Round the side on the torso's ring: from the front-left to the back-left, where the low knob is.
    const thOf = (q: V3, front: boolean) => {
      let best = 0, bd = 1e9;
      for (let k = 0; k <= 80; k++) {
        const th = (front ? -1 : 1) * (k / 80) * (Math.PI / 2);
        const e = len(sub(c.ring(q[2], th, 0), [q[0], c.ring(q[2], th, 0)[1], q[2]]));
        if (e < bd) (bd = e), (best = th);
      }
      return best;
    };
    const th0 = thOf(path[path.length - 1], true), th1 = thOf([lo[0], 0, lo[2]], false);
    for (let i = 1; i <= 9; i++) {
      const t = i / 9, z = ZF + (lo[2] - ZF) * t, th = th0 + (th1 - th0) * t;
      const p = c.ring(z, th, 0.25), q = c.ring(z, th, 1.25);
      push(p, sub(q, p));
    }
    strap(c, path, out, 1.3, 0.36, CORD);
    // A gold slide on the chest.
    const k = F.off > 0 ? 17 : 16;
    const [, su, sv] = frame(out[k], sub(path[k + 1], path[k - 1]));
    plate(b, ring(add(path[k], scale(out[k], 0.3)), sv, su, 0.85, 0.6, 12, 5), out[k], 0.36, 0.1, { face: GOLD }, (p) => c.W(p));
  }
  // The cord tied round the scabbard at its gold band, and its end: a knot, a hanging cord, an ivory tusk.
  const T_KNOT = 0.4;
  for (const dt of [-0.012, 0.012]) loop(b, sec(T_KNOT + dt, 1.5 * S, 0.82 * S).flatMap((q, j, a) => [q, lerp3(q, a[(j + 1) % a.length], 0.5)]), 0.2, 6, d, CORD, W0);
  const knot = add(line(T_KNOT), add(scale(thick, 0.95 * S), scale(across, -0.9 * S)));
  b.surface(b.ellipsoidRows(knot, [0.65, 0.6, 0.6], thick, d, 10, 5), { paint: () => CORD, weight: W, closed: true });
  const DROP = 5.6;
  part(c, { w: (p) => clamp01((knot[2] - p[2]) / DROP) }, () => {
    b.tube(Array.from({ length: 9 }, (_, i): V3 => add(knot, [0.15 * Math.sin((Math.PI * i) / 8), 0.25 * Math.sin((Math.PI * i) / 8), (-DROP * i) / 8])), 0.3, 6, [0, 1, 0], () => CORD, W, true);
  });
  // (The charm is stiff: all of it swings as the cord's end does.)
  part(c, { w: () => 1 }, () => {
    const top = add(knot, [0, 0, -DROP]);
    turned(b, top, [0, 0, -1], [[-0.3, 0.3], [-0.3, 0.74], [0.4, 0.74], [0.4, 0.3]], () => GOLD, W, 10);
    // The tusk: curved, its tip darker, as on the mask.
    const N = 8;
    b.tube(Array.from({ length: N + 1 }, (_, i): V3 => add(top, [-0.8 * (i / N) ** 2, 0.12 * (i / N), -0.35 - 3.7 * (i / N)])), (i) => 0.68 * Math.pow(1 - i / N, 0.7) + 0.04, 8, [0, 1, 0], (i) => (i > 5 ? TUSK_TIP : SAME), W, true);
  });
  return finish(c, { pivot: knot, axis: d });
}

/**
 * Pinwheel: a paper windmill on a candy-striped stick, held by two leather loops sewn to the left of the back, its
 * wheel beside the head. Four sails cut from one square: the colourway's accent on the face, each sail's corner curled
 * over to the brass pin and showing the cream reverse. The wheel spins (code 2) and the stick bends above its loops.
 */
function pinwheel(f: BackFit): THREE.BufferGeometry {
  const c = ctxFor(f);
  const { b } = c;
  const CREAM = fixed(0xf4f1ea), SAIL = accent(TAG_FABRIC), BRASS = fixed(0xe2ae48), BRIGHT = fixed(0xf6d57a), LEATHER = fixed(0x7a5536);
  const F = fitOf(c, "back-pinwheel"), S = F.s;
  const [p0, n0] = c.on(F.x, F.z, 0.55);
  const top: V3 = [F.x2, c.on(8, 60, 0)[0][1] + 4.6, F.z2];
  const d = norm(sub(top, p0)), L = len(sub(top, p0));
  const W0 = c.W(c.on(F.x, F.z + 4.5, 0)[0]), W = () => W0;
  const at = (t: number): V3 => add(p0, scale(d, L * t));
  // The loops that hold it (still), and where the stick comes free of the upper one.
  const HOLD = [0.1, 0.36], FREE = 0.4;
  for (const t of HOLD) {
    const [q, nq] = c.on(at(t)[0], at(t)[2], 0.12);
    const [, u, v] = frame(nq, d);
    plate(b, ring(q, v, u, 1.9, 0.75, 14, 4), nq, 0.3, 0.1, { face: LEATHER }, W);
    turned(b, add(at(t), scale(d, -0.6)), d, [[0, 0.5], [0, 0.72], [1.2, 0.72], [1.2, 0.5]], () => LEATHER, W, 12, n0);
  }
  const free = at(FREE);
  const bend = (p: V3) => Math.pow(clamp01(dot(sub(p, free), d) / (L * (1 - FREE))), 1.6);
  // The stick: stripes in the accent and cream, a rounded foot.
  part(c, { w: bend }, () => {
    const N = 22;
    b.tube(Array.from({ length: N + 1 }, (_, i) => at(i / N)), 0.52, 10, n0, (i) => (i % 2 ? CREAM : SAIL), W, true);
  });
  const axis = norm([0.22, 1, 0.12]);
  const hub = add(top, scale(axis, 0.9));
  const [, u, v] = frame(axis, [0, 0, 1]);
  part(c, { code: 2, w: () => 1 }, () => {
    const first = b.vertexCount;
    // The pin through the stick's head and its domed button in front of the sails.
    b.tube([add(top, scale(axis, -0.3)), add(hub, scale(axis, 0.7))], 0.2, 6, u, () => BRASS, W, true);
    turned(b, add(hub, scale(axis, 0.55)), axis, [[0, 0], [0, 0.95], [0.22, 0.95], [0.5, 0.7], [0.66, 0.35], [0.7, 0]], (j) => [BRASS, BRASS, BRIGHT, BRIGHT, BRIGHT][j], W, 14, u);
    const RC = 6.5, TH = 0.05;
    const P = (r: number, a: number, h = 0): V3 => add(hub, add(scale(u, r * Math.cos(a)), add(scale(v, r * Math.sin(a)), scale(axis, h))));
    // Both faces of a sheet (rows of points, `up` its face toward the viewer): `face` in front, `under` behind.
    const sheet = (rows: V3[][], face: Paint, under: Paint) => {
      const nrm = (i: number, k: number): V3 => {
        const r = rows[i], kp = Math.min(r.length - 1, k + 1), km = Math.max(0, k - 1), ip = Math.min(rows.length - 1, i + 1), im = Math.max(0, i - 1);
        let nn = cross(sub(r[kp], r[km]), sub(rows[ip][k], rows[im][k]));
        if (len(nn) < 1e-6) nn = axis;
        nn = norm(nn);
        return dot(nn, axis) < 0 ? scale(nn, -1) : nn;
      };
      const N2 = rows.map((r, i) => r.map((_, k) => nrm(i, k)));
      b.surface(rows.map((r, i) => r.map((q, k) => add(q, scale(N2[i][k], TH)))), { closed: false, paint: () => face, weight: W, out: (i, k) => N2[i][k] });
      b.surface(rows.map((r, i) => r.map((q, k) => add(q, scale(N2[i][k], -TH)))), { closed: false, paint: () => under, weight: W, out: (i, k) => scale(N2[i][k], -1) });
    };
    for (let k = 0; k < 4; k++) {
      const a0 = Math.PI / 4 + (k * Math.PI) / 2;
      // The sail between corner a0 (folded in) and the next corner (left flat): the flat part, with a slight dish.
      const O = P(0, 0, 0.1), H = P(RC / 2, a0, 0.2), M = P(RC * Math.SQRT1_2, a0 + Math.PI / 4, 0.42), C1 = P(RC, a0 + Math.PI / 2, 0.3);
      const flat: V3[][] = Array.from({ length: 5 }, (_, i) => Array.from({ length: 5 }, (_, j) => lerp3(lerp3(O, H, i / 4), lerp3(C1, M, i / 4), j / 4)));
      sheet(flat, SAIL, CREAM);
      // The corner curled over from the line H-M to the pin: it rolls out past the line a little and arches up.
      const outward = norm(sub(lerp3(H, M, 0.5), O));
      const R = 9, S = 6;
      const curl: V3[][] = Array.from({ length: R + 1 }, (_, i) => {
        const t = i / R;
        return Array.from({ length: S + 1 }, (_, j) => {
          const s = j / S;
          const base = lerp3(H, M, s), tip = P(0.55, a0 + 0.5, 0.62);
          const q = lerp3(base, tip, Math.pow(t, 1.15));
          const arch = Math.sin(Math.PI * Math.pow(t, 0.7));
          return add(add(q, scale(axis, 1.75 * arch * (0.45 + 0.55 * s))), scale(outward, 0.62 * Math.sin(Math.PI * Math.min(1, t * 2.2)) * (0.5 + 0.5 * s)));
        });
      });
      sheet(curl, CREAM, SAIL);
    }
    // (Built at its design size, then scaled about the hub.)
    b.scaleSection(first, hub, S);
  });
  return finish(c, { pivot: free, pivot2: hub, axis });
}

/**
 * Wings (the secret's): a small pair of feathered wings grown from the shoulder blades. Each has a downy arm (up to the
 * wrist, out to the tip) and separate, thick feathers under it: five long primaries fanned from the wrist, their tips
 * dipped in gold, four secondaries, and a row of short coverts laid over their roots; a tuft of down where it meets the
 * hoodie. Warm white on top, a cooler white underneath. The left wing has one feather out of place at the wrist.
 * Code 6: they fold back with speed, beat down on a takeoff and float up in the air, the tips late.
 */
function wings(f: BackFit): THREE.BufferGeometry {
  const c = ctxFor(f);
  const { b } = c;
  const WHITE = fixed(0xf4f4ee), SOFT = fixed(0xeef0e8), COOL = fixed(0xe2e6e0), UNDER = fixed(0xcfd6d4), GOLD = fixed(0xffcf4a), GOLD_DEEP = fixed(0xc9921f);
  const F = fitOf(c, "back-wings"), S = F.s;
  const zr = F.z, xr = F.x, SPAN = 14 * S;
  const [p0] = c.on(xr, zr, F.off);
  const W0 = c.W([0, p0[1], zr]), W = () => W0;
  part(c, { code: 6, w: (p) => clamp01((Math.abs(p[0]) - xr) / SPAN) }, () => {
    for (const sx of [1, -1]) {
      const first = b.vertexCount;
      const root: V3 = [sx * xr, p0[1], zr];
      const out = norm([sx, 0.28, 0]);
      const up = norm([0, F.tilt, 1]);
      // The wing's face, toward whoever is behind.
      let face = norm(cross(up, out));
      if (face[1] < 0) face = scale(face, -1);
      const at = (o: number, u: number, fz = 0): V3 => add(root, add(scale(out, o), add(scale(up, u), scale(face, fz))));
      // The arm: [out, up] from the root, up to the wrist and out to the tip.
      const ARM: [number, number][] = [[-0.6, -0.8], [1.2, 3.1], [3.3, 6.4], [6.3, 8.2], [9.3, 8.0], [11.5, 6.3]];
      const armAt = (t: number): [number, number] => {
        const fi = t * (ARM.length - 1), i = Math.min(ARM.length - 2, Math.floor(fi)), k = fi - i;
        return [ARM[i][0] + (ARM[i + 1][0] - ARM[i][0]) * k, ARM[i][1] + (ARM[i + 1][1] - ARM[i][1]) * k];
      };
      /**
       * A feather: from (o, u) on the wing, `deg` from straight out (negative = down), `L` long and `wide` at its
       * widest, lying `lift` proud of the wing's plane; the last `dip` of it is gold.
       */
      const feather = (o: number, u: number, deg: number, L: number, wide: number, lift: number, top: Paint, dip = 0) => {
        const a = (deg * Math.PI) / 180;
        const dir = norm(add(scale(out, Math.cos(a)), scale(up, Math.sin(a))));
        const acr = norm(cross(dir, face));
        const N = 8;
        const rows = Array.from({ length: N + 1 }, (_, i) => {
          const t = i / N;
          // A gentle curl toward the body's line, the tip coming back to the plane.
          const p = add(at(o, u, lift * (1 - 0.5 * t) + 0.35 * Math.sin(Math.PI * t)), add(scale(dir, L * t), scale(up, -0.5 * t * t)));
          // Narrow at the quill, full by a third of the way, a round end.
          const w = wide * (0.5 + 0.5 * smoothstep(0, 0.36, t)) * Math.sqrt(Math.max(0.03, 1 - Math.max(0, (t - 0.7) / 0.3) ** 2));
          return ring(p, acr, face, Math.max(0.05, w), Math.max(0.04, 0.34 * wide * (1 - 0.55 * t)), 8, 2.4);
        });
        b.surface(rows, { paint: (i, k) => (dip > 0 && i >= Math.round(N * (1 - dip)) ? (k >= 1 && k <= 3 ? GOLD : GOLD_DEEP) : k >= 1 && k <= 3 ? top : UNDER), weight: W, capStart: UNDER, capEnd: dip > 0 ? GOLD : top });
      };
      // Primaries from the wrist to the tip, the outer ones turned further out; the three longest dipped.
      const PRIM: [number, number, number, number, number][] = [[0.52, -86, 9.6, 1.75, 0.24], [0.64, -70, 10.2, 1.8, 0.24], [0.76, -54, 9.6, 1.75, 0.24], [0.88, -38, 8.3, 1.65, 0.24], [1.0, -21, 6.6, 1.5, 0.24]];
      PRIM.forEach(([t, deg, L, wide, dip], i) => {
        const [o, u] = armAt(t);
        feather(o, u - 0.3, deg, L, wide, 0.1 * (i % 2), i % 2 ? SOFT : COOL, dip);
      });
      // Secondaries along the inner arm, hanging.
      const SEC: [number, number, number, number][] = [[0.13, -99, 5.6, 2.0], [0.27, -96, 7.0, 2.1], [0.41, -93, 8.2, 2.05]];
      SEC.forEach(([t, deg, L, wide], i) => {
        const [o, u] = armAt(t);
        feather(o, u - 0.3, deg, L, wide, 0.3 + 0.1 * (i % 2), i % 2 ? COOL : SOFT);
      });
      // Coverts: short, round, laid over the roots.
      for (let i = 0; i < 5; i++) {
        const t = 0.14 + (0.8 * i) / 4;
        const [o, u] = armAt(t);
        feather(o, u - 0.1, -96 + 64 * Math.pow(t, 2.2), 3.9 - 0.7 * t, 1.75, 0.75 + 0.1 * (i % 2), WHITE);
      }
      // The arm itself, in down: thick at the shoulder, fine at the tip.
      const N = 14;
      b.tube(Array.from({ length: N + 1 }, (_, i) => at(...armAt(i / N), 0.55)), (i) => 1.3 - 0.75 * (i / N), 10, face, () => WHITE, W, true);
      // Down where it grows from the hoodie.
      for (const [o, u, r] of [[-0.4, -0.6, 1.7], [0.9, -1.3, 1.25], [-1.2, 0.9, 1.2], [1.3, 1.1, 1.3]] as const) {
        const q = at(o, u, 0.1);
        b.surface(b.ellipsoidRows(q, [r, r * 0.6, r], face, up, 10, 5), { paint: () => SOFT, weight: W, closed: true });
      }
      // The left wing's stray feather, standing up from the wrist.
      if (sx > 0) {
        const [o, u] = armAt(0.6);
        feather(o, u + 0.4, 58, 3.4, 1.3, 0.5, WHITE);
      }
      // (Built at its design size, then scaled about its root.)
      b.scaleSection(first, root, S);
    }
  });
  return finish(c, { pivot: [xr, p0[1], zr], axis: [0, 0, 1] });
}

const BUILD: Record<string, (f: BackFit) => THREE.BufferGeometry> = {
  "back-wings": wings,
  "back-windup-key": windupKey,
  "back-cape": cape,
  "back-carrot-pack": carrotPack,
  "back-balloon": balloon,
  "back-jetpack": jetpack,
  "back-blade": blade,
  "back-pinwheel": pinwheel,
  [MEDAL_ITEM]: medal,
  [ROBE_ITEM]: (f) => buildRobe({ profile: f.profile, hood: f.hood, tied: !!f.tied, neck: BACK_FITS[ROBE_ITEM].up.at[1] + (BACK_FITS[ROBE_ITEM].lift?.[f.profile] ?? 0) }).geometry,
};

/** The Daily Medal's metals (rank-crown colours, hat-detail.ts: metal): [face, dark, bright] and the stone of its last step. */
const MEDAL_TONES = {
  gold: [0xffcf3d, 0xc8891e, 0xffe08a, 0xe0213b],
  silver: [0xdfe6f0, 0x8f9bb0, 0xf7fafd, 0x2a6df0],
  bronze: [0xd9934e, 0x8f5a2e, 0xf2b885, 0x18b85a],
} as const;
/** The ribbon: the menu's ink with the game's amber down its middle (hat-detail.ts: fabric). */
const MEDAL_RIBBON = 0x26304f, MEDAL_STRIPE = 0xffb43c;

/**
 * Daily Medal: a struck medal on a ribbon round the neck, lying on the chest over the hoodie's drawstrings. A thick disc
 * with a raised, chamfered rim and a suspension bar; the ribbon comes out from under the hood either side of the neck
 * and meets at the bar in a V. The face is the count's (the name badge's six steps, progression.ts MEDAL_STEPS), each
 * step adding to the last so more of a medal is more to look at from across a room: a boss; a raised ring; eight rays;
 * a scalloped edge that widens the whole medal; a star on the boss; a stone set in the star and a second stripe on the
 * ribbon. The disc and the lower ribbon swing off the chest as one hanging chain (code 1 with chain weights; BackKind
 * "medal").
 */
function medal(f: BackFit): THREE.BufferGeometry {
  const c = ctxFor(f);
  const { b } = c;
  const { metal, step } = medalOf(f.medal ?? MEDAL_DEFAULT);
  const [FACE, DARK, BRIGHT, STONE] = MEDAL_TONES[metal].map(fixed);
  const RIBBON = fixed(MEDAL_RIBBON), STRIPE = fixed(MEDAL_STRIPE), PIPING = fixed(0xf3ecdc);
  const F = fitOf(c, MEDAL_ITEM);
  const R = 3.1, T = 0.95, OFF = 0.85;
  // The disc lies on the chest: its face looks along the chest's own normal there.
  const [pc, N] = torsoFront(c, F.x, F.z);
  const C = add(pc, scale(N, OFF));
  const [, right, up] = frame(N, [1, 0, 0]);
  const W0 = c.W(C), W = () => W0;
  const bar = add(C, scale(up, R + 0.55));
  // The ribbon leaves the body below the collar bones; from there down it hangs free.
  const zTop = F.z2, zFree = F.z2 - 2.2;
  const top: V3 = torsoFront(c, 0, zFree)[0];
  const wOf = (p: V3) => Math.pow(clamp01((zFree - p[2]) / Math.max(zFree - bar[2], 0.1)), 1.15);
  part(c, { code: 1, w: wOf }, () => {
    for (const sx of [1, -1]) {
      // From under the hood down the chest to the bar: on the hoodie at first, standing off it as it nears the medal.
      const K = 12;
      const path: V3[] = [], out: V3[] = [];
      // Above where it comes out from under a raised hood it goes on up to the side of the neck, so with the hood down
      // (the neck bare above the collar) it is still a ribbon round the neck and not two ends on the chest.
      for (const [x, z] of [[F.x2 - 1.0, zTop + 2.6], [F.x2 - 0.45, zTop + 1.3]]) {
        const [p, n] = torsoFront(c, sx * x, z);
        path.unshift(add(p, scale(n, 0.1)));
        out.unshift(n);
      }
      path.reverse(), out.reverse();
      for (let i = 0; i <= K; i++) {
        const t = i / K;
        const [p, n] = torsoFront(c, sx * F.x2 * (1 - t) + sx * 0.55 * t, zTop + (bar[2] - zTop) * t);
        const lift = 0.1 + (OFF - 0.25) * t * t;
        path.push(i === K ? add(bar, scale(right, sx * 0.55)) : add(p, scale(n, lift)));
        out.push(i === K ? N : n);
      }
      const L = path.length - 1;
      const band = (w: number, t: number, raise: number, paint: Paint, shift = 0) => {
        const rows = path.map((p, i) => {
          const d = norm(sub(path[Math.min(L, i + 1)], path[Math.max(0, i - 1)]));
          const n = out[i], a = norm(cross(n, d));
          const o = add(add(p, scale(n, raise + t / 2)), scale(a, shift));
          return [add(add(o, scale(a, w / 2)), scale(n, t / 2)), add(add(o, scale(a, -w / 2)), scale(n, t / 2)), add(add(o, scale(a, -w / 2)), scale(n, -t / 2)), add(add(o, scale(a, w / 2)), scale(n, -t / 2))];
        });
        // Skinned like the hoodie where it lies on it, going over to the medal's own bone weights where it hangs.
        b.surface(rows, { paint: () => paint, weight: (p) => mixW([c.W(p), 1 - wOf(p)], [W0, wOf(p)]), flat: true, capStart: paint, capEnd: paint });
      };
      band(1.9, 0.22, 0, RIBBON);
      // Ivory piping down both edges: it keeps the ribbon's shape on a dark hoodie, where the ink would be lost.
      for (const s of [0.86, -0.86]) band(0.2, 0.08, 0.22, PIPING, s);
      if (step < 5) band(0.62, 0.08, 0.22, STRIPE);
      else for (const s of [0.36, -0.36]) band(0.36, 0.08, 0.22, STRIPE, s);
    }
  });
  part(c, { code: 1, w: () => 1 }, () => {
    // The suspension bar the ribbon is sewn round, and its lug down to the rim.
    plate(b, ring(bar, right, up, 1.55, 0.5, 14, 5), N, 0.6, 0.14, { face: FACE, bevel: BRIGHT, rim: DARK }, W);
    plate(b, ring(add(C, scale(up, R + 0.05)), right, up, 0.5, 0.42, 10, 4), N, 0.5, 0.1, { face: FACE, bevel: BRIGHT, rim: DARK }, W);
    // From the fourth step the medal has a scalloped edge: twelve lobes behind the rim, which make it wider.
    if (step >= 3)
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2 + Math.PI / 12;
        const q = add(C, add(scale(right, Math.cos(a) * (R + 0.12)), scale(up, Math.sin(a) * (R + 0.12))));
        plate(b, ring(add(q, scale(N, -0.12)), right, up, 0.78, 0.78, 8), N, 0.55, 0.14, { face: FACE, bevel: BRIGHT, rim: DARK }, W);
      }
    // The disc: a dark back, a chamfered edge, a raised rim and the face sunk inside it.
    const h = T / 2, IN = R - 0.62;
    turned(b, C, N, [[-h, 0], [-h, R - 0.16], [-h + 0.16, R], [h - 0.16, R], [h, R - 0.16], [h, IN], [h - 0.26, IN - 0.14], [h - 0.26, 0]], (j) => [DARK, DARK, FACE, BRIGHT, BRIGHT, DARK, FACE][j], W, 32, right);
    const face = add(C, scale(N, h - 0.26));
    const onFace = (r: number, a: number, lift = 0): V3 => add(face, add(scale(right, Math.cos(a) * r), add(scale(up, Math.sin(a) * r), scale(N, lift))));
    // A raised ring from the second step.
    if (step >= 1) turned(b, face, N, [[0, 1.86], [0.2, 1.8], [0.2, 1.5], [0, 1.44]], (j) => [DARK, BRIGHT, DARK][j], W, 28, right);
    // Eight rays from the third, between the ring and the rim.
    if (step >= 2)
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + Math.PI / 8, tan = add(scale(right, -Math.sin(a)), scale(up, Math.cos(a))), rad = add(scale(right, Math.cos(a)), scale(up, Math.sin(a)));
        const m = onFace(2.14, a, 0.1);
        plate(b, [add(m, add(scale(rad, 0.3), scale(tan, 0.16))), add(m, add(scale(rad, 0.3), scale(tan, -0.16))), add(m, add(scale(rad, -0.26), scale(tan, -0.07))), add(m, add(scale(rad, -0.26), scale(tan, 0.07)))], N, 0.2, 0.05, { face: BRIGHT, rim: DARK }, W);
      }
    // The middle: a flat boss with a sunk centre, like a coin's; from the fifth step a five-pointed star, and at the last a
    // stone set in it.
    if (step >= 4) {
      const pts = Array.from({ length: 10 }, (_, i) => onFace(i % 2 ? 0.52 : 1.3, Math.PI / 2 + (i / 10) * Math.PI * 2, 0.16));
      plate(b, pts, N, 0.32, 0.08, { face: BRIGHT, bevel: FACE, rim: DARK }, W);
      if (step >= 5) b.surface(b.ellipsoidRows(add(face, scale(N, 0.3)), [0.5, 0.5, 0.34], N, right, 12, 4, 0, Math.PI / 2), { paint: () => STONE, weight: W });
    } else turned(b, face, N, [[0, 1.18], [0.3, 1.0], [0.3, 0.62], [0.16, 0.5], [0.16, 0]], (j) => [DARK, BRIGHT, DARK, FACE][j], W, 24, right);
  });
  b.scaleSection(0, top, F.s);
  return finish(c, { pivot: top, pivot2: top, axis: [1, 0, 0] });
}

const cache = new Map<string, THREE.BufferGeometry>();
/**
 * Capes at other lengths than the default are each their own geometry (dragging the length slider builds one a step):
 * only the last CAPE_KEEP used are kept; an older one is rebuilt if it is wanted again. (A dropped one that a bunny
 * still wears stays alive on that bunny.)
 */
const CAPE_KEEP = 24;
const capes: string[] = [];
function keepCape(key: string): void {
  const at = capes.indexOf(key);
  if (at >= 0) capes.splice(at, 1);
  capes.push(key);
  while (capes.length > CAPE_KEEP) cache.delete(capes.shift()!);
}

/** A back item's geometry for a fit (built once each); null for an unknown id. */
export function backGeometry(id: string, f: BackFit): THREE.BufferGeometry | null {
  const make = BUILD[id];
  if (!make) return null;
  const key = backKey(id, f);
  let g = cache.get(key);
  if (!g) cache.set(key, (g = make(f)));
  if (f.len && id === CAPE_ITEM) keepCape(key);
  return g;
}

/** Already built (or seeded) for this key (backKey). */
export const hasBackGeometry = (key: string): boolean => cache.has(key);

/** A back item built elsewhere (prebuild.ts, in a worker), unless one is already there. */
export function seedBackGeometry(key: string, g: THREE.BufferGeometry): void {
  if (!cache.has(key)) cache.set(key, g);
  if (/\|l\d+$/.test(key)) keepCape(key);
}

/** The motion's rig a geometry was built with (back-fx.ts). */
export const backRigOf = (g: THREE.BufferGeometry): BackRig | null => (g.userData.backRig as BackRig | undefined) ?? null;
