// Kitsune Mask (a Supporter hat, v0.0.42; registered in hats.ts): a festival fox mask, the plain one of the pair it
// makes with the Half Oni Mask (oni-mask.ts: the same ivory lacquer and soft coat, there with carved planes, teeth,
// tusks and gold; here with nothing carved at all). A smooth off-white face in a rounded triangle, a short blunt
// muzzle with one soft ridge down it, two small upright ears that are part of the mask, narrow slanted eye openings
// (dark), a thick edge, and a few flat painted marks in red (MARKS: a brush stroke over each eye, one under it on the
// cheek, the ears' tips, a small nose). No relief, no whiskers, no pattern. A single plain red cord holds it, tied in
// one small knot with a short end.
//
// Two ways to wear it (loadout.maskOn; hats.ts headwearKey):
//   - pushed up (the default build): tied to the left side of the head, tilted, its face pointing outward and up, clear
//     of the bunny's ear root; the cord round the hood under the ears. Its profile and ears stand off the head's
//     outline from behind and from three-quarter.
//   - on the face ("@face"): over the whole face, the eye openings dark; the cord round the back of the hood.
//
// Fit: the mask is built on the reference face (wigs.ts FACE_C / FACE_R) as longitude / latitude plus a smooth standoff;
// the pushed-up build is the same mask carried by one rigid placement (SIDE: a direction on the hood, a standoff, a
// tilt, a scale) and the cord sits on the hood ellipsoid. On the face, the mask's vertices are face parts (headwear 2 +
// material, hat-fit.ts HatFit.face) and the cord hood parts, so Plush and Bun-E fit each to its own surface. Rigid on
// the head bone; nothing moves.

import * as THREE from "three";
import { add, Builder, cross, norm, ring, scale, smoothstep, sub, type Paint, type Wt } from "./builder";
import { rig, type V3 } from "./rig";
import { curve, FACE_C, facePoint, HOOD_C, HOOD_R, hoodPoint, rimPoint } from "./wigs";
import { ensureHeadwear } from "../hat-detail";

const fixed = (color: number): Paint => ({ code: 0, color });
/** The Half Oni Mask's ivory and its shade (hat-detail.ts: lacquer), and black for the eye openings. */
const WHITE = 0xf3ecdc, SHADE = 0xece0c2, BLACK = 0x161117;
/**
 * The painted marks and the cord: the oni mask's red. (Tried in the colourway's accent first, Paint code 1: on the
 * ivory, the pale and yellow accents most colourways have left the strokes too faint to read at any distance.)
 */
const MARK: Paint = fixed(0xc81e2a);

/** The outline: v 0 (the top edge) .. 1 (the chin); the centre's latitude and the half width (longitude). */
const TOP = 0.62, CHIN = -0.84;
const latAt = (v: number, u: number) => TOP + (CHIN - TOP) * v - 0.1 * u * u * (1 - v) ** 2;
/** A rounded triangle: widest at the brow, drawing in to a blunt, rounded chin. */
const halfWidth = (v: number) => (v < 0.22 ? 0.98 + 0.08 * Math.sin((v / 0.22) * Math.PI * 0.5) : v > 0.94 ? 0.3 * Math.sqrt(Math.max(0, 1 - ((v - 0.94) / 0.06) ** 2)) * 0.9 + 0.03 : 0.3 + 0.76 * Math.pow(Math.max(0, 1 - ((v - 0.22) / 0.72) ** 1.5), 0.75));

/** The eye openings: centre, half length, half height, tilt (rad, outer corner up). */
const EYE = { lon: 0.46, lat: 0.17, half: 0.23, tall: 0.038, tilt: 0.42 };

/**
 * How far the mask stands off the face: one smooth shell clear of the visor, a short muzzle swelling low on it with a
 * soft ridge down its middle (the one shading break), easing in toward the edges.
 */
function standoff(lon: number, lat: number): number {
  const al = Math.abs(lon);
  const down = smoothstep(0.22, -0.3, lat) * (1 - 0.55 * smoothstep(-0.36, -0.8, lat));
  const muzzle = 0.95 * down * Math.pow(Math.max(0, 1 - al / (0.52 - 0.14 * down)), 1.15);
  // (0.84 at the eyes: the visor and the glints on it stand up to 0.6 off the face.)
  return 0.84 + muzzle - 0.22 * Math.min(1, al / 1.05) ** 2 - 0.2 * smoothstep(-0.4, -0.84, lat);
}

/**
 * Mark layouts considered (v0.0.42): each a list of strokes, [points as lon / lat on the bunny's left half, mirrored;
 * half width], plus whether the ears' tips are dipped. "brush" is the one built.
 *   brush   a stroke over each eye flicking up to the temple, a shorter one under it on the cheek, dipped ear tips
 *   brow    two round brow dots high on the forehead, a liner under each eye, the ears' insides
 *   cheek   one long curved stroke across each cheek, a short line down the bridge, dipped ear tips
 */
type Stroke = { at: [number, number][]; w: number; dot?: true; middle?: true };
export const MARKS: Record<"brush" | "brow" | "cheek", { strokes: Stroke[]; ears: "tip" | "inside" }> = {
  brush: {
    strokes: [
      { at: [[0.22, 0.28], [0.5, 0.35], [0.76, 0.45], [0.88, 0.58]], w: 0.052 },
      { at: [[0.46, 0.0], [0.66, -0.05], [0.84, -0.02]], w: 0.046 },
    ],
    ears: "tip",
  },
  brow: {
    strokes: [
      { at: [[0.26, 0.46]], w: 0.075, dot: true },
      { at: [[0.26, 0.06], [0.46, 0.075], [0.7, 0.17]], w: 0.036 },
    ],
    ears: "inside",
  },
  cheek: {
    strokes: [
      { at: [[0.36, -0.2], [0.58, -0.1], [0.78, 0.08], [0.88, 0.26]], w: 0.056 },
      { at: [[0, 0.52], [0, 0.34]], w: 0.036, middle: true },
    ],
    ears: "tip",
  },
};
export type MarkLayout = keyof typeof MARKS;
const LAYOUT: MarkLayout = "brush";

/**
 * The pushed-up placement: where on the hood (a direction from its centre), how far off it, the tilt and the size; and
 * where the cord is tied behind it (th round the hood). On Bun-E the side of the helmet is the ear cup's (supporter.ts:
 * to y 2.5 behind the middle, z 66.6 to 73), so the mask sits behind it, on the back quarter of the helmet.
 */
const SIDE = { dir: norm([0.92, 0.28, 0.36] as V3), off: 1.05, up: norm([0.05, 0.3, 1] as V3), tip: 0.42, size: 0.82, knot: 2.25 };
const SIDE_BUNE: typeof SIDE = { ...SIDE, dir: norm([0.5, 0.82, 0.34] as V3), knot: 2.95 };

type Place = (p: V3) => V3;
const ID: Place = (p) => p;
function sidePlace(SIDE: typeof SIDE_BUNE): Place {
  const { p, n } = hoodPoint(SIDE.dir, SIDE.off);
  const out = norm(add(n, scale(SIDE.up, SIDE.tip)));
  const up = norm(sub(SIDE.up, scale(out, SIDE.up[0] * out[0] + SIDE.up[1] * out[1] + SIDE.up[2] * out[2])));
  const right = cross(up, out);
  // The mask's own frame: its middle, right (+x), up (+z), out (-y).
  const S: V3 = [FACE_C[0], FACE_C[1] - 4.9, FACE_C[2] - 0.4];
  return (q) => {
    const d = scale(sub(q, S), SIDE.size);
    return add(p, add(add(scale(right, d[0]), scale(up, d[2])), scale(out, -d[1])));
  };
}

/** The mask itself, through a placement, with a mark layout. */
function mask(b: Builder, W: Wt, X: Place, layout: MarkLayout): void {
  const at = (lon: number, lat: number, extra = 0): V3 => X(facePoint(lon, lat, standoff(lon, lat) + extra));
  const centre = X(FACE_C);
  const K = 36, R = 26;
  const grid: [number, number][][] = Array.from({ length: R + 1 }, (_, i) => {
    const v = i / R;
    return Array.from({ length: K + 1 }, (_, k) => {
      const u = -1 + (2 * k) / K;
      return [u * halfWidth(v), latAt(v, u)] as [number, number];
    });
  });
  const rows = grid.map((row) => row.map(([lon, lat]) => at(lon, lat)));
  b.surface(rows, { closed: false, paint: () => fixed(WHITE), weight: () => W, out: (i, k) => sub(rows[i][k], centre) });
  // A thick edge: a band back toward the face all round, a rounded lip along it, both a shade of the ivory.
  const perim: [number, number][] = [...grid[0], ...grid.slice(1, R).map((row) => row[K]), ...[...grid[R]].reverse(), ...grid.slice(1, R).reverse().map((row) => row[0])];
  const outer = perim.map(([lon, lat]) => at(lon, lat, 0.01)), inner = perim.map(([lon, lat]) => at(lon, lat, -0.42));
  b.surface([inner, outer], { closed: true, paint: () => fixed(SHADE), weight: () => W, out: (_i, k) => sub(outer[k], centre) });
  b.tube([...outer, outer[0]], 0.085, 6, [0, 0, 1], () => fixed(SHADE), () => W, false);

  /** A flat painted stroke lying on the mask along [lon, lat] points: `w(t)` half wide, pointed at both ends. */
  const stroke = (pts: [number, number][], w: (t: number) => number, paint: Paint, lift = 0.03, n = 14) => {
    const P = pts.length > 2 ? curve(pts.map(([lon, lat]) => [lon, lat, 0] as V3), n) : Array.from({ length: n }, (_, i): V3 => [pts[0][0] + ((pts[1][0] - pts[0][0]) * i) / (n - 1), pts[0][1] + ((pts[1][1] - pts[0][1]) * i) / (n - 1), 0]);
    const rowsM = P.map((q, i) => {
      const a = P[Math.max(0, i - 1)], c = P[Math.min(n - 1, i + 1)];
      const dl = c[0] - a[0], da = c[1] - a[1], l = Math.hypot(dl, da) || 1;
      const hw = Math.max(0.003, w(i / (n - 1)));
      return [-1, 0, 1].map((s) => at(q[0] - (da / l) * hw * s, q[1] + (dl / l) * hw * s, lift + (s === 0 ? 0.01 : 0)));
    });
    b.surface(rowsM, { closed: false, paint: () => paint, weight: () => W, out: (i, k) => sub(rowsM[i][k], centre) });
  };
  /** A brush stroke: it lands full and trails off. A leaf: full in the middle. */
  const brush = (w: number) => (t: number) => w * Math.sin(Math.PI * Math.min(1, t * 1.7)) ** 0.6 * (1 - 0.8 * t ** 1.5);
  const leaf = (w: number) => (t: number) => w * Math.sin(Math.PI * t) ** 0.7;

  for (const s of [-1, 1]) {
    // The eye opening: a narrow slanted slit, dark.
    const c = Math.cos(EYE.tilt), sn = Math.sin(EYE.tilt);
    const eye = (f: number): [number, number] => [s * (EYE.lon + f * EYE.half * c), EYE.lat + f * EYE.half * sn];
    stroke([eye(-1), eye(-0.3), eye(0.4), eye(1)], leaf(EYE.tall), fixed(BLACK), 0.025, 12);
    for (const m of MARKS[layout].strokes) {
      if (m.middle && s < 0) continue;
      if (m.dot) {
        const [lon, lat] = m.at[0];
        stroke([[s * lon, lat - m.w * 0.9], [s * lon, lat + m.w * 0.9]], leaf(m.w), MARK, 0.03, 9);
      } else stroke(m.at.map(([lon, lat]) => [s * lon, lat] as [number, number]), brush(m.w), MARK);
    }
  }
  // The nose: a small painted mark on the muzzle's end.
  stroke([[-0.1, -0.4], [0, -0.44], [0.1, -0.4]], leaf(0.05), MARK, 0.03, 8);

  // Ears: small, upright, one piece with the mask (the shell runs up into them); a dipped tip or a painted inside.
  for (const s of [-1, 1]) {
    const lon = s * 0.62, lat = latAt(0, 0.64) - 0.02;
    const base = at(lon, lat, -0.16), out = norm(sub(at(lon, lat, 1), at(lon, lat, 0)));
    const along = norm(sub(at(lon + 0.2, latAt(0, 0.84), 0), at(lon - 0.2, latAt(0, 0.44), 0)));
    // (Up the mask's surface there, which leans back over the forehead: turned out again so the ear stands.)
    const up = norm(add(norm(cross(out, along)), add(scale(along, 0.22 * s), scale(out, 0.5))));
    const H = 1.75, WD = 0.95, tipFrom = 0.6;
    const sec = (f: number) => ring(add(base, scale(up, H * f)), along, out, WD * (1 - f) ** 0.8 + 0.03, 0.24 * (1 - 0.55 * f) + 0.03, 10, 1.7);
    const fs = [0, 0.3, tipFrom, 0.82, 1];
    b.surface(fs.map(sec), { paint: (i) => (MARKS[layout].ears === "tip" && i >= 2 ? MARK : fixed(WHITE)), weight: () => W, capEnd: MARKS[layout].ears === "tip" ? MARK : fixed(WHITE) });
    if (MARKS[layout].ears === "inside") {
      const tri = [0.14, 0.4, 0.68].map((f) => {
        const c = add(add(base, scale(up, H * f)), scale(out, 0.24 * (1 - 0.55 * f) + 0.045));
        const w = 0.5 * WD * (1 - f / 0.74);
        return [add(c, scale(along, -w)), c, add(c, scale(along, w))];
      });
      b.surface(tri, { closed: false, paint: () => MARK, weight: () => W, out: () => out });
    }
  }
}

/** A point on the hood `off` proud of it, th round it (0 = the front, + toward the bunny's left) at height z. */
function onHood(th: number, z: number, off: number): V3 {
  const k = Math.sqrt(Math.max(0.04, 1 - ((z - HOOD_C[2]) / HOOD_R[2]) ** 2));
  return [HOOD_C[0] + Math.sin(th) * (HOOD_R[0] * k + off), HOOD_C[1] - Math.cos(th) * (HOOD_R[1] * k + off), z];
}

/** One small knot at `p` and a short end hanging from it; `back`: the way that points away from the head there. */
function tie(b: Builder, W: Wt, p: V3, back: V3): void {
  b.surface(b.ellipsoidRows(p, [0.2, 0.2, 0.17], back, [0, 0, 1], 8, 4), { paint: () => MARK, weight: () => W, closed: true });
  b.tube([p, add(p, add(scale(back, 0.22), [0, 0, -0.7])), add(p, add(scale(back, 0.3), [0, 0, -1.5]))], (i) => 0.08 - 0.012 * i, 6, back, () => MARK, () => W);
}

function done(b: Builder, face: number): THREE.BufferGeometry {
  const g = b.geometry();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 70), 60);
  // Materials by colour (hat-detail.ts), then the face parts' flag on top: 2 + material / 8.
  ensureHeadwear(g);
  const H = g.getAttribute("headwear");
  for (let i = 0; i < face; i++) H.setX(i, H.getX(i) + 1);
  return g;
}

/** Pushed up on the side of the head (`bune`: Bun-E's place). `layout`: for the alternatives' renders; the game builds LAYOUT. */
export function kitsuneMask(layout: MarkLayout = LAYOUT, bune = false): THREE.BufferGeometry {
  const b = new Builder();
  const W: Wt = [[rig().bone("Head1"), 1]];
  const at = bune ? SIDE_BUNE : SIDE;
  mask(b, W, sidePlace(at), layout);
  // The cord: round the hood under the ears, high over the brow and low at the nape, through the mask's place.
  const z = (th: number) => 72.25 + 1.75 * (0.5 + 0.5 * Math.cos(th));
  const N = 72;
  b.tube(Array.from({ length: N + 1 }, (_, k) => onHood((k / N) * Math.PI * 2, z((k / N) * Math.PI * 2), 0.14)), 0.075, 6, [0, 0, 1], () => MARK, () => W, false);
  // Tied behind the mask.
  const th = at.knot;
  tie(b, W, onHood(th, z(th), 0.26), norm([Math.sin(th), -Math.cos(th), 0]));
  return done(b, 0);
}

/** Over the face. */
export function kitsuneMaskFace(layout: MarkLayout = LAYOUT): THREE.BufferGeometry {
  const b = new Builder();
  const W: Wt = [[rig().bone("Head1"), 1]];
  mask(b, W, ID, layout);
  const face = b.vertexCount;
  // The cord: from each side of the opening (inside the rim) round the back of the hood, tied at the nape.
  const zc = 70.6, TH0 = 1.02;
  for (const s of [-1, 1]) {
    const rim = rimPoint(s * 1.75);
    const path: V3[] = [facePoint(s * 1.04, 0.0, 0.4), [rim[0] * 0.98, rim[1] - 0.25, rim[2] + 0.1], ...Array.from({ length: 22 }, (_, k) => onHood(s * (TH0 + ((Math.PI - TH0) * k) / 21), zc + 0.5 * (1 - k / 21), 0.14))];
    b.tube(path, 0.075, 6, [0, 0, 1], () => MARK, () => W, false);
  }
  tie(b, W, onHood(Math.PI, zc, 0.28), [0, 1, 0]);
  return done(b, face);
}
