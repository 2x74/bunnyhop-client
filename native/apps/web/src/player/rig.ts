// Procedural player mesh + skeleton: a low-poly runner in a cream hoodie with bunny-ear hood tips, a glowing visor,
// joggers with an accent stripe and chunky sneakers. Fully original, generated in code (no external assets).
//
// Model space is three.js-style: Y up, facing +Z, the character's left = +X, 1 unit = 1 Source unit. Feet stand on
// y = 0. Proportions follow the bunnyhop hull (32 x 32 x 62 standing): shoulders ~25 wide, hood top ~68, visor ~61.
//
// One skinned geometry (rigid + blended weights at elbows/knees/waist) drives ~20 bones, so a whole player is a
// single draw call (two for the depth-correct ghost). Per-vertex attributes:
//   partColor  vec3   base colour (linear)
//   accent     float  0 = part colour, 1 = style accent colour, 2 = accent + glow (visor)

import * as THREE from "three";

export const BONES = [
  "root", "hips", "spine", "chest", "neck", "head", "earL", "earR",
  "upperArmL", "foreArmL", "handL", "upperArmR", "foreArmR", "handR",
  "thighL", "shinL", "footL", "thighR", "shinR", "footR",
] as const;
export type BoneName = (typeof BONES)[number];
const BI = Object.fromEntries(BONES.map((n, i) => [n, i])) as Record<BoneName, number>;

/** Parent and rest position (model space) of every bone. */
const REST: Record<BoneName, [BoneName | null, number, number, number]> = {
  root: [null, 0, 0, 0],
  hips: ["root", 0, 32, 0],
  spine: ["hips", 0, 38, 0],
  chest: ["spine", 0, 45, 0],
  neck: ["chest", 0, 54.5, 0],
  head: ["neck", 0, 57, 0.3],
  earL: ["head", 2.6, 66.3, -1.6],
  earR: ["head", -2.6, 66.3, -1.6],
  upperArmL: ["chest", 10.7, 52.5, 0],
  foreArmL: ["upperArmL", 10.7, 44, 0],
  handL: ["foreArmL", 10.7, 36.4, 0],
  upperArmR: ["chest", -10.7, 52.5, 0],
  foreArmR: ["upperArmR", -10.7, 44, 0],
  handR: ["foreArmR", -10.7, 36.4, 0],
  thighL: ["hips", 4.3, 32, 0],
  shinL: ["thighL", 4.3, 17, 0],
  footL: ["shinL", 4.3, 3, 0],
  thighR: ["hips", -4.3, 32, 0],
  shinR: ["thighR", -4.3, 17, 0],
  footR: ["shinR", -4.3, 3, 0],
};

/** Leg segment lengths (hip->knee, knee->ankle) and ankle height, for IK in the animator. */
export const LEG = { thigh: 15, shin: 14, ankle: 3, hip: 32 };

/** Creates a fresh bone hierarchy in rest pose. Returns the bones in BONES order (index 0 = root). */
export function createBones(): THREE.Bone[] {
  const bones = BONES.map((name) => {
    const b = new THREE.Bone();
    b.name = name;
    return b;
  });
  for (const name of BONES) {
    const [parent, x, y, z] = REST[name];
    const b = bones[BI[name]];
    if (parent) {
      const [, px, py, pz] = REST[parent];
      b.position.set(x - px, y - py, z - pz);
      bones[BI[parent]].add(b);
    } else b.position.set(x, y, z);
  }
  return bones;
}

// ---------------------------------------------------------------------------------------------
// Palette (sRGB hex; converted to linear for the shader).

export const PALETTE = {
  hoodie: 0xe9e3d7,
  hoodieShade: 0xc9c0b0,
  face: 0x1a1d25,
  pants: 0x2b303b,
  pantsShade: 0x20242d,
  shoe: 0xf3f5f8,
  glove: 0x2a2e38,
  /** Default accent: bunnyhop.lol amber. */
  accent: 0xffb43a,
};

// ---------------------------------------------------------------------------------------------
// Geometry builder

type V3 = [number, number, number];
/** Skin weight: single bone, or [boneA, boneB, weightA]. */
type W = number | [number, number, number];
type Paint = [THREE.Color, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

class Builder {
  P: number[] = [];
  N: number[] = [];
  C: number[] = [];
  A: number[] = [];
  SI: number[] = [];
  SW: number[] = [];

  private vert(p: V3, n: V3, paint: Paint, w: W): void {
    this.P.push(...p);
    this.N.push(...n);
    this.C.push(paint[0].r, paint[0].g, paint[0].b);
    this.A.push(paint[1]);
    if (typeof w === "number") this.SI.push(w, 0, 0, 0), this.SW.push(1, 0, 0, 0);
    else this.SI.push(w[0], w[1], 0, 0), this.SW.push(w[2], 1 - w[2], 0, 0);
  }

  /** Flat-shaded triangle, wound so its normal points away from `inside`. */
  tri(a: V3, b: V3, c: V3, inside: V3, paint: Paint, wa: W, wb: W, wc: W): void {
    const raw = cross(sub(b, a), sub(c, a));
    if (Math.hypot(raw[0], raw[1], raw[2]) < 1e-6) return; // degenerate (pole) triangle
    let n = norm(raw);
    const center = scale(add(add(a, b), c), 1 / 3);
    if (dot(n, sub(center, inside)) < 0) {
      [b, c, wb, wc] = [c, b, wc, wb];
      n = scale(n, -1);
    }
    this.vert(a, n, paint, wa);
    this.vert(b, n, paint, wb);
    this.vert(c, n, paint, wc);
  }

  quad(a: V3, b: V3, c: V3, d: V3, inside: V3, paint: Paint, wa: W, wb: W, wc: W, wd: W): void {
    this.tri(a, b, c, inside, paint, wa, wb, wc);
    this.tri(a, c, d, inside, paint, wa, wc, wd);
  }

  /**
   * Surface through a sequence of rings (equal point counts). Faces are oriented away from the local ring axis.
   * paint(ring, segment) colours the quad between ring i and i+1, segment k and k+1.
   */
  loft(rings: V3[][], weights: W[], paint: (i: number, k: number) => Paint, capStart = true, capEnd = true): void {
    const centers = rings.map((r) => scale(r.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / r.length));
    const n = rings[0].length;
    for (let i = 0; i + 1 < rings.length; i++) {
      const inside = scale(add(centers[i], centers[i + 1]), 0.5);
      for (let k = 0; k < n; k++) {
        const k1 = (k + 1) % n;
        this.quad(rings[i][k], rings[i][k1], rings[i + 1][k1], rings[i + 1][k], inside, paint(i, k), weights[i], weights[i], weights[i + 1], weights[i + 1]);
      }
    }
    const cap = (i: number, j: number) => {
      // Fan to the ring centre, oriented away from the neighbouring ring.
      const c = centers[i];
      const inside = add(c, scale(sub(centers[j], c), 0.5));
      for (let k = 0; k < n; k++) this.tri(c, rings[i][k], rings[i][(k + 1) % n], inside, paint(Math.min(i, rings.length - 2), k), weights[i], weights[i], weights[i]);
    };
    if (capStart) cap(0, 1);
    if (capEnd) cap(rings.length - 1, rings.length - 2);
  }

  /** Low-poly ellipsoid around `axis` (pole), optionally open: polar angles from aMin (rad, 0 = +axis). */
  ellipsoid(c: V3, r: V3, axis: V3, u: V3, seg: number, rings: number, w: W, paint: Paint | ((d: V3) => Paint), aMin = 0): V3[] {
    const v = norm(cross(axis, u));
    const pts: V3[][] = [];
    for (let i = 0; i <= rings; i++) {
      const a = aMin + ((Math.PI - aMin) * i) / rings;
      const ring: V3[] = [];
      for (let k = 0; k < seg; k++) {
        const t = (k / seg) * Math.PI * 2;
        const d = add(add(scale(axis, Math.cos(a)), scale(u, Math.sin(a) * Math.cos(t))), scale(v, Math.sin(a) * Math.sin(t)));
        ring.push([c[0] + d[0] * r[0], c[1] + d[1] * r[1], c[2] + d[2] * r[2]]);
      }
      pts.push(ring);
    }
    for (let i = 0; i < rings; i++) {
      for (let k = 0; k < seg; k++) {
        const k1 = (k + 1) % seg;
        const a = pts[i][k], b = pts[i][k1], cc = pts[i + 1][k1], d = pts[i + 1][k];
        const mid = scale(add(add(a, b), add(cc, d)), 0.25);
        const p = typeof paint === "function" ? paint(norm(sub(mid, c))) : paint;
        // Pole quads collapse to triangles; tri() drops the zero-area half.
        this.tri(a, b, cc, c, p, w, w, w);
        this.tri(a, cc, d, c, p, w, w, w);
      }
    }
    return pts[0];
  }

  box(min: V3, max: V3, w: W, paint: Paint): void {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    const c: V3 = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    const v = (x: number, y: number, z: number): V3 => [x, y, z];
    const faces: V3[][] = [
      [v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)],
      [v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0)],
      [v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0)],
      [v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)],
      [v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)],
      [v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0)],
    ];
    for (const f of faces) this.quad(f[0], f[1], f[2], f[3], c, paint, w, w, w, w);
  }

  /** Closed tube along a closed polyline (hood rim). */
  tube(path: V3[], radius: number, sides: number, w: W, paint: Paint): void {
    const n = path.length;
    const rings: V3[][] = [];
    for (let i = 0; i < n; i++) {
      const t = norm(sub(path[(i + 1) % n], path[(i + n - 1) % n]));
      const a = norm(cross(t, Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
      const b = cross(t, a);
      const ring: V3[] = [];
      for (let k = 0; k < sides; k++) {
        const ang = (k / sides) * Math.PI * 2;
        ring.push(add(path[i], add(scale(a, Math.cos(ang) * radius), scale(b, Math.sin(ang) * radius))));
      }
      rings.push(ring);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      for (let k = 0; k < sides; k++) {
        const k1 = (k + 1) % sides;
        this.quad(rings[i][k], rings[i][k1], rings[j][k1], rings[j][k], scale(add(path[i], path[j]), 0.5), paint, w, w, w, w);
      }
    }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute("partColor", new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute("accent", new THREE.Float32BufferAttribute(this.A, 1));
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(this.SI, 4));
    g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(this.SW, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 36, 0), 46);
    return g;
  }
}

/** Ellipse ring in the plane spanned by u, v around centre c. phase rotates the start point. */
function ring(c: V3, u: V3, v: V3, ru: number, rv: number, n: number, phase = 0): V3[] {
  const out: V3[] = [];
  for (let k = 0; k < n; k++) {
    const t = phase + (k / n) * Math.PI * 2;
    out.push(add(c, add(scale(u, Math.cos(t) * ru), scale(v, Math.sin(t) * rv))));
  }
  return out;
}
const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];
const Z: V3 = [0, 0, 1];

/** Linear blend weight `w` toward bone a vs b as y moves from y1 (all b) to y0 (all a). */
function blendY(y: number, a: number, b: number, yA: number, yB: number): W {
  const t = Math.max(0, Math.min(1, (y - yB) / (yA - yB)));
  if (t >= 0.999) return a;
  if (t <= 0.001) return b;
  return [a, b, t];
}

let cached: THREE.BufferGeometry | null = null;

/** The shared player geometry (built once). */
export function playerGeometry(): THREE.BufferGeometry {
  if (cached) return cached;
  const b = new Builder();
  const col = (hex: number) => new THREE.Color(hex);
  const P = {
    hoodie: [col(PALETTE.hoodie), 0] as Paint,
    hoodieShade: [col(PALETTE.hoodieShade), 0] as Paint,
    face: [col(PALETTE.face), 0] as Paint,
    pants: [col(PALETTE.pants), 0] as Paint,
    pantsShade: [col(PALETTE.pantsShade), 0] as Paint,
    shoe: [col(PALETTE.shoe), 0] as Paint,
    glove: [col(PALETTE.glove), 0] as Paint,
    accent: [col(PALETTE.accent), 1] as Paint,
    glow: [col(PALETTE.accent), 2] as Paint,
  };

  // --- Torso (hoodie): hem -> shoulders, blended hips -> spine -> chest -------------------------
  {
    const spec: [number, number, number, number][] = [
      // y, rx, rz, z offset
      [31.6, 8.4, 5.5, 0],
      [34, 8.1, 5.3, 0],
      [38, 7.7, 5.1, 0.1],
      [42, 8.1, 5.4, 0.3],
      [46, 8.8, 5.8, 0.45],
      [50, 9.2, 5.9, 0.4],
      [53, 8.3, 5.4, 0.2],
      [55.2, 4.6, 3.9, 0],
    ];
    const rings = spec.map(([y, rx, rz, z]) => ring([0, y, z], X, Z, rx, rz, 12, Math.PI / 12));
    const weights = spec.map(([y]) => (y < 38 ? blendY(y, BI.hips, BI.spine, 33, 40) : y < 46 ? blendY(y, BI.spine, BI.chest, 39, 46) : BI.chest));
    b.loft(rings, weights, () => P.hoodie, false, true);
    // Ribbed hem band.
    const hem = ([[29.6, 8.8, 5.9], [31.4, 8.75, 5.85], [32.8, 8.1, 5.3]] as const).map(([y, rx, rz]) => ring([0, y, 0], X, Z, rx, rz, 12, Math.PI / 12));
    b.loft(hem, [BI.hips, BI.hips, BI.hips], () => P.hoodieShade, true, false);
    // Kangaroo pocket.
    b.box([-5.2, 33.2, 4.3], [5.2, 39.2, 5.95], [BI.hips, BI.spine, 0.5], P.hoodieShade);
    // Drawstrings with aglets.
    for (const s of [1, -1]) {
      b.box([s * 1.7 - 0.3, 47.2, 5.7], [s * 1.7 + 0.3, 54, 6.55], BI.chest, P.accent);
      b.box([s * 1.7 - 0.45, 45.9, 5.75], [s * 1.7 + 0.45, 47.4, 6.75], BI.chest, P.hoodieShade);
    }
    // Neck (in hood shadow).
    b.loft([ring([0, 53, 0], X, Z, 2.6, 2.4, 8), ring([0, 58, 0.3], X, Z, 2.3, 2.2, 8)], [BI.chest, BI.neck], () => P.face, false, false);
  }

  // --- Head: dark face, glowing visor band, hood with open front + rim, bunny ears ----------------
  {
    const headC: V3 = [0, 60.4, 0.9];
    const headR: V3 = [4.8, 5.4, 5.0];
    b.ellipsoid(headC, headR, Y, X, 12, 7, BI.head, P.face);
    // Visor: a curved band across the face at eye level, slightly proud of the head.
    {
      const rows = [-0.06, 0.2];
      const segs = 10;
      const rr: V3 = [headR[0] + 0.45, headR[1] + 0.45, headR[2] + 0.45];
      const pts = rows.map((lat) =>
        Array.from({ length: segs + 1 }, (_, k) => {
          const lon = -1.15 + (2.3 * k) / segs;
          const d: V3 = [Math.sin(lon) * Math.cos(lat), Math.sin(lat), Math.cos(lon) * Math.cos(lat)];
          return [headC[0] + d[0] * rr[0], headC[1] + 0.3 + d[1] * rr[1], headC[2] + d[2] * rr[2]] as V3;
        }),
      );
      for (let k = 0; k < segs; k++) b.quad(pts[0][k], pts[0][k + 1], pts[1][k + 1], pts[1][k], headC, P.glow, BI.head, BI.head, BI.head, BI.head);
    }
    // Hood: ellipsoid shell opened around a slightly down-tilted forward axis.
    const hoodC: V3 = [0, 61.4, -0.8];
    const hoodR: V3 = [6.3, 6.9, 6.7];
    const fwd = norm([0, -0.12, 1]);
    const open = Math.acos(0.5);
    const rim = b.ellipsoid(hoodC, hoodR, fwd, X, 14, 6, BI.head, P.hoodie, open);
    b.tube(rim, 0.75, 5, BI.head, P.hoodieShade);
    // Bunny-ear hood tips: flattened, swept back, slightly splayed, with an accent inner panel.
    for (const s of [1, -1]) {
      const bone = s > 0 ? BI.earL : BI.earR;
      const [, bx, by, bz] = REST[s > 0 ? "earL" : "earR"];
      const L = 9;
      const prof: [number, number, number][] = [
        // t (0..1), half width, half thickness
        [0, 1.5, 0.95],
        [0.22, 2.2, 0.9],
        [0.5, 2.3, 0.8],
        [0.75, 1.9, 0.65],
        [0.92, 1.1, 0.45],
        [1, 0.25, 0.25],
      ];
      const frames = prof.map(([t]) => {
        const back = 0.42 + 0.55 * t * t; // radians, sweeps further back toward the tip
        const out = s * (0.2 + 0.1 * t);
        const dir = norm([Math.sin(out), Math.cos(back), -Math.sin(back)]);
        return dir;
      });
      const centers: V3[] = [[bx, by, bz]];
      for (let i = 1; i < prof.length; i++) {
        const dt = (prof[i][0] - prof[i - 1][0]) * L;
        centers.push(add(centers[i - 1], scale(frames[i], dt)));
      }
      const side: V3 = [Math.cos(s * 0.2), -Math.sin(s * 0.2) * 0.3, 0];
      const rings = prof.map(([, hw, ht], i) => {
        const nrm = norm(cross(side, frames[i])); // ear front normal
        return ring(centers[i], norm(side), nrm, hw, ht, 8, Math.PI / 8);
      });
      b.loft(rings, prof.map((_, i) => (i === 0 ? ([BI.head, bone, 0.5] as W) : bone)), () => P.hoodie, true, false);
      const inner = prof.slice(1, 5).map(([, hw], j) => {
        const i = j + 1;
        const nrm = norm(cross(side, frames[i]));
        // Front of the ear faces roughly forward/up; sit the panel just proud of that face.
        const facing = nrm[2] > 0 ? nrm : scale(nrm, -1);
        return ring(add(centers[i], scale(facing, prof[i][2] * 0.85)), norm(side), facing, hw * 0.55, 0.2, 6, Math.PI / 6);
      });
      b.loft(inner, inner.map(() => bone), () => P.accent, true, true);
    }
  }

  // --- Arms: continuous sleeves (shoulder -> cuff) blended at the elbow, cuffs, gloves -------------
  for (const s of [1, -1]) {
    const up = s > 0 ? BI.upperArmL : BI.upperArmR;
    const fo = s > 0 ? BI.foreArmL : BI.foreArmR;
    const ha = s > 0 ? BI.handL : BI.handR;
    const x = 10.7 * s;
    const spec: [number, number, number][] = [
      // y, radius, x offset (shoulder cap tucks inward)
      [55.0, 1.6, -1.7],
      [53.6, 2.85, -0.6],
      [51, 3.0, 0],
      [47.5, 2.75, 0],
      [45.2, 2.6, 0],
      [43.6, 2.5, 0],
      [41.5, 2.4, 0],
      [39, 2.35, 0],
      [38.2, 2.45, 0],
    ];
    const rings = spec.map(([y, r, dx]) => ring([x + dx * s, y, 0], X, Z, r, r * 1.04, 10));
    const weights = spec.map(([y]) => blendY(y, up, fo, 46.2, 42.6));
    b.loft(rings, weights, () => P.hoodie, true, false);
    b.loft([ring([x, 39, 0], X, Z, 2.3, 2.35, 10), ring([x, 38.2, 0], X, Z, 2.6, 2.65, 10), ring([x, 36.2, 0], X, Z, 2.45, 2.5, 10)], [fo, fo, fo], () => P.hoodieShade, false, true);
    b.ellipsoid([x, 33.8, 0.35], [1.9, 2.6, 2.1], Y, X, 8, 5, ha, P.glove);
  }

  // --- Legs: jogger tubes (hip -> ankle) with an accent side stripe and ribbed cuffs ---------------
  for (const s of [1, -1]) {
    const th = s > 0 ? BI.thighL : BI.thighR;
    const sh = s > 0 ? BI.shinL : BI.shinR;
    const ft = s > 0 ? BI.footL : BI.footR;
    const x = 4.3 * s;
    const spec: [number, number, number][] = [
      [35, 3.7, 4.3],
      [31, 4.1, 4.3],
      [25, 3.8, 3.9],
      [20, 3.3, 3.45],
      [17, 3.15, 3.3],
      [14, 3.0, 3.1],
      [10, 2.8, 2.9],
      [6.6, 2.65, 2.75],
    ];
    const n = 10;
    const rings = spec.map(([y, rx, rz]) => ring([x - (y > 30 ? 0.3 * s : 0), y, y > 25 ? 0 : 0.2], X, Z, rx, rz, n, Math.PI / n));
    const weights = spec.map(([y]) => (y > 30 ? ([BI.hips, th, 0.0] as W) : blendY(y, th, sh, 19.5, 14.5)));
    weights[0] = th;
    const stripe = s > 0 ? n - 1 : n / 2 - 1;
    b.loft(rings, weights, (i, k) => (k === stripe && i < rings.length - 1 ? P.accent : P.pants), false, false);
    b.loft([ring([x, 7.6, 0.2], X, Z, 2.55, 2.65, n), ring([x, 6.6, 0.2], X, Z, 2.9, 3.0, n), ring([x, 4.4, 0.2], X, Z, 2.75, 2.85, n)], [sh, sh, ft], () => P.pantsShade, false, true);

    // Sneaker: upper + accent sole, lofted heel -> toe.
    const shoe: [number, number, number][] = [
      // z, half width, top y
      [-3.4, 2.3, 5.2],
      [-1.8, 2.7, 5.6],
      [1.5, 2.8, 4.6],
      [4.6, 2.6, 3.5],
      [6.8, 1.9, 2.5],
    ];
    const upper = shoe.map(([z, hw, top]) => ring([x, (top + 1.1) / 2, z], X, Y, hw, (top - 1.1) / 2, 8, Math.PI / 8));
    b.loft(upper, upper.map(() => ft), () => P.shoe);
    const sole = shoe.map(([z, hw]) => ring([x, 0.65, z + (z > 0 ? 0.25 : -0.25)], X, Y, hw + 0.3, 0.65, 8, Math.PI / 8));
    b.loft(sole, sole.map(() => ft), () => P.accent);
  }

  cached = b.geometry();
  return cached;
}
