// Tek: the secret look (progression.ts WINGS / "outfit-tek"), a low-poly homage to Teknium (Hermes Agent, Nous
// Research), who said yes to being in the game. An original take on their avatar's motifs, not a copy of any picture:
//
//   - a calm, slim anime face (tapered jaw, small nose, a short mouth line) whose eyes are hidden behind the visor;
//   - the visor: one flat shard across both eyes, the same on both sides (pointy anime glasses): each half's lower
//     edge climbs past the eye into a broad blade that rides over the hair to a sharp ivory point above and behind the
//     ear; red with a slanted ivory stripe each side (from the side: red, ivory, red, ivory, like the avatar's shard);
//   - blue-grey teal hair as a hairline cap with layered, swept locks (windswept clumps over the dome, a fringe over
//     the visor's top edge, narrow locks by the ears, short tufts at the nape) that turns into foliage: sage locks and
//     a sage crown, a green blade down its left temple, and a swept-back fan of pointed leaves behind with gaps between
//     them (the fan rides the bunny's ear bones, so it flops on hops and landings like the ears do);
//   - a dark forest-green jacket with a tall standing collar (high behind the jaw, low at the throat) and a silver zip
//     (the colourway's hoodie / trim slots: palettes.ts outfit-tek);
//   - Hermes' wings, kept small: a little white pair tucked above and behind the ears (the winged helmet) and on the
//     outside of each sneaker (talaria, for a bhop game).
//
// Same rig, same animations and same hull as the bunny: only the mesh differs (mesh.ts builds the body and calls these
// for the head, the jacket details and the shoes). Fixed colours (Paint code 0) for everything Tek-specific, so the
// look reads the same whatever the slot accent; ghosts tint it like any model.

import { add, Builder, clamp, cross, dot, hat, mixW, norm, ring, scale, smoothstep, sub, type Paint, type Wt } from "./builder";
import { EAR, rig, type V3 } from "./rig";

const fixed = (color: number): Paint => ({ code: 0, color });
const SKIN = fixed(0xefd6c3);
const SKIN_SHADE = fixed(0xd4ae98);
/** The neck, in the jaw's shadow. */
const NECK = fixed(0xb98f79);
const EAR_IN = fixed(0xc0907a);
const MOUTH = fixed(0x8c5d52);
/** Hair: base, lit, shadow (blue-grey teal). */
const HAIR = [fixed(0x648f8c), fixed(0x80a69e), fixed(0x456d70)];
/** Leaves: pale sage (among the hair), sage, mid green, deep green, deepest (the back). */
const LEAF = { pale: fixed(0xa6c299), sage: fixed(0x7fae7c), mid: fixed(0x4f8f4c), deep: fixed(0x356f3b), deepest: fixed(0x285a31) };
const WING = fixed(0xeef0e8);
const WING_ROOT = fixed(0xcfd6d4);
/** The little temple wings, off-white so the visor owns the white. */
const TEMPLE_WING = fixed(0xd7dfc9);
const VISOR_WHITE = fixed(0xefece0);
const VISOR_RED = fixed(0xbb4549);
/** The visor's thin edges, a shade darker than its faces. */
const VISOR_WHITE_EDGE = fixed(0xb8b4a8);
const VISOR_RED_EDGE = fixed(0x84302f);
const ZIP = fixed(0xc2c9c5);

const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];
const Z: V3 = [0, 0, 1];

/**
 * A flat blade (hair lock, feather): rows along its length, a lens-shaped ring across it. `width(t)` is the half width
 * at t (0 base .. 1 tip), `curl` bends it towards its face normal (fraction of the length at the tip).
 */
function blade(
  b: Builder,
  base: V3,
  dir: V3,
  side: V3,
  o: { len: number; width: (t: number) => number; th: number; curl?: number; seg?: number; paint: (t: number) => Paint; weight: (p: V3, t: number) => Wt },
): void {
  const d = norm(dir);
  const s = norm(sub(side, scale(d, dot(d, side))));
  const n = norm(cross(d, s));
  const seg = o.seg ?? 5;
  const ts = Array.from({ length: seg + 1 }, (_, i) => i / seg);
  const rows = ts.map((t) => {
    const c = add(add(base, scale(d, o.len * t)), scale(n, (o.curl ?? 0) * o.len * t * t));
    return ring(c, s, n, Math.max(0.02, o.width(t)), o.th * (1 - 0.7 * t), 6);
  });
  b.surface(rows, { paint: (i) => o.paint(ts[i]), weight: (p, i) => o.weight(p, ts[i]), capStart: o.paint(0), flat: true });
}

/**
 * A leaf folded along its midrib: a four-point section (edge, rib on top, edge, rib underneath) so the two halves catch
 * the light differently. Lies across `dir`, its top facing `up`; `curl` bends it back towards -up.
 */
function leaf(b: Builder, base: V3, dir: V3, up: V3, o: { len: number; w: number; paint: Paint; shade: Paint; curl?: number; bend?: number; weight: (p: V3, t: number) => Wt }): void {
  const d = norm(dir);
  const s = norm(cross(d, up));
  const n = norm(cross(s, d));
  const seg = 5;
  const ts = Array.from({ length: seg + 1 }, (_, i) => i / seg);
  const rows = ts.map((t) => {
    // Widest a third of the way up, straight sides to a sharp tip.
    const w = Math.max(0.03, o.w * (t < 0.32 ? Math.sin((Math.PI / 2) * Math.min(1, 0.12 + t / 0.32)) : (1 - t) / 0.68));
    const c = add(add(base, scale(d, o.len * t)), scale(n, -(o.curl ?? 0.12) * o.len * t * t));
    const fold = 0.2 * w;
    const bend = scale(s, (o.bend ?? 0) * o.len * t * t); // a sideways sweep
    return [add(add(c, bend), add(scale(s, -w), scale(n, fold))), add(add(c, bend), scale(n, 0.07)), add(add(c, bend), add(scale(s, w), scale(n, fold))), add(add(c, bend), scale(n, -0.05))];
  });
  b.surface(rows, { paint: (_, k) => (k === 0 ? o.paint : k === 1 ? o.shade : o.shade), weight: (p, i) => o.weight(p, ts[i]), capStart: o.shade, flat: true });
}

/** Feather outline: wide from the root, a rounded tip. */
const featherWidth = (w: number) => (t: number) => w * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 0.9))) * (t > 0.82 ? Math.sqrt(Math.max(0, (1 - t) / 0.18)) : 1);

/**
 * A small wing: three feathers fanned from swept back to raised, in the plane facing `out`, each overlapping the next
 * (stepped a little outwards), the middle one longest. The root is a rounded knuckle.
 */
function wing(b: Builder, root: V3, out: V3, back: V3, size: number, weight: (p: V3) => Wt, feather = WING): void {
  const o = norm(out);
  const up = norm(cross(o, back));
  const bk = norm(cross(up, o));
  // [angle from the back towards up (rad), relative length]
  const fan: [number, number][] = [
    [0.1, 0.78],
    [0.5, 1.0],
    [0.92, 0.8],
  ];
  fan.forEach(([a, l], i) => {
    const dir = norm(add(scale(bk, Math.cos(a)), scale(up, Math.sin(a))));
    blade(b, add(root, scale(o, 0.14 * size * (fan.length - i))), dir, cross(o, dir), {
      len: 5.0 * size * l,
      width: featherWidth(0.85 * size),
      th: 0.24 * size,
      curl: 0.06,
      seg: 5,
      paint: (t) => (t < 0.16 ? WING_ROOT : feather),
      weight: (p) => weight(p),
    });
  });
  b.surface(b.ellipsoidRows(root, [0.6 * size, 0.6 * size, 0.6 * size], o, Z, 8, 4), { paint: () => WING_ROOT, weight: (p) => weight(p), closed: true });
}

// --- The head's shape ----------------------------------------------------------------------------------------------
// The face is a loft of horizontal rings, each a superellipse with its own half width and front / back extent (front is
// -y): a rounded skull, a flat-ish facial plane, cheekbones, then a jaw that tapers to a small chin a little forward.

/** [z, half width, front y, back y]. */
const FACE: [number, number, number, number][] = [
  [74.0, 0.7, -0.6, 1.6],
  [73.4, 2.4, -2.3, 2.8],
  [72.3, 3.35, -3.4, 4.1],
  [70.9, 3.75, -4.2, 4.4],
  [69.6, 3.8, -4.55, 4.3],
  [68.4, 3.6, -4.55, 3.9],
  [67.3, 3.1, -4.4, 2.6],
  [66.6, 2.6, -4.15, 1.0],
  [66.2, 2.2, -4.2, 0.0],
  [65.95, 2.0, -4.0, -0.9],
  [65.75, 1.85, -4.07, -1.5],
  [65.45, 1.55, -3.8, -2.3],
  [65.2, 1.15, -3.72, -2.9],
  [65.05, 0.5, -3.4, -3.05],
];
const FACE_E = 2.25;

function faceAt(z: number): [number, number, number] {
  if (z >= FACE[0][0]) return [FACE[0][1], FACE[0][2], FACE[0][3]];
  for (let i = 0; i + 1 < FACE.length; i++) {
    const [z0, a0, f0, b0] = FACE[i], [z1, a1, f1, b1] = FACE[i + 1];
    if (z >= z1) {
      const t = (z0 - z) / (z0 - z1);
      return [a0 + (a1 - a0) * t, f0 + (f1 - f0) * t, b0 + (b1 - b0) * t];
    }
  }
  const l = FACE[FACE.length - 1];
  return [l[1], l[2], l[3]];
}

/** Point of the face ring at height z and angle th (0 = its left, -pi/2 = front). */
function facePoint(z: number, th: number): V3 {
  const [a, f, bk] = faceAt(z);
  const c = Math.cos(th), s = Math.sin(th);
  const x = Math.sign(c) * Math.pow(Math.abs(c), 2 / FACE_E) * a;
  const y = (s < 0 ? -f : bk) * Math.sign(s) * Math.pow(Math.abs(s), 2 / FACE_E);
  return [x, y, z];
}

/** Is p inside the face loft? */
function insideFace(p: V3): boolean {
  if (p[2] > FACE[0][0] || p[2] < FACE[FACE.length - 1][0]) return false;
  const [a, f, bk] = faceAt(p[2]);
  const ny = p[1] < 0 ? p[1] / f : p[1] / bk;
  return Math.pow(Math.abs(p[0] / a), FACE_E) + Math.pow(Math.abs(ny), FACE_E) <= 1;
}

/** Centre the face's features are placed from (longitude 0 = front, + = its left; latitude + = up). */
const FC: V3 = [0, -0.2, 69.4];
const dirOf = (lon: number, lat: number): V3 => [Math.sin(lon) * Math.cos(lat), -Math.cos(lon) * Math.cos(lat), Math.sin(lat)];

/** Distance from FC to the face surface along a direction (bisection). */
function faceR(d: V3): number {
  let lo = 0, hi = 9;
  for (let i = 0; i < 22; i++) {
    const m = (lo + hi) / 2;
    if (insideFace(add(FC, scale(d, m)))) lo = m;
    else hi = m;
  }
  return lo;
}
/** Point on the face at (lon, lat), `off` units proud of it. */
const onFace = (lon: number, lat: number, off = 0): V3 => {
  const d = dirOf(lon, lat);
  return add(FC, scale(d, faceR(d) + off));
};

// The hair cap: an ellipsoid over the skull, cut at a hairline that sits high on the forehead, comes down to just
// above the ears at the sides and to the nape behind.
const HC: V3 = [0, 0.25, 69.4];
const HR: V3 = [4.55, 5.05, 4.9];
/** Polar angle (from the top) of the hairline at azimuth az (0 = front, + = its left). */
const hairline = (az: number) => 1.12 + 1.25 * Math.pow((1 - Math.cos(az)) / 2, 1.25);
const capDir = (az: number, pol: number): V3 => [Math.sin(pol) * Math.sin(az), -Math.sin(pol) * Math.cos(az), Math.cos(pol)];
/** Point on the hair cap at azimuth / polar angle (radians), `off` proud of it. */
const onCap = (az: number, pol: number, off = 0): V3 => {
  const d = capDir(az, pol);
  return [HC[0] + d[0] * (HR[0] + off), HC[1] + d[1] * (HR[1] + off), HC[2] + d[2] * (HR[2] + off)];
};
/** Outward normal of the cap at a point. */
const capNormal = (p: V3): V3 => norm([(p[0] - HC[0]) / (HR[0] * HR[0]), (p[1] - HC[1]) / (HR[1] * HR[1]), (p[2] - HC[2]) / (HR[2] * HR[2])]);
/** Distance from FC to the outside of the cap along a direction (where the cap is), for the visor's far end. */
function capR(d: V3): number {
  // |FC + t d - HC|_ellipse = 1
  const o = sub(FC, HC);
  const A = (d[0] / HR[0]) ** 2 + (d[1] / HR[1]) ** 2 + (d[2] / HR[2]) ** 2;
  const B = 2 * ((o[0] * d[0]) / HR[0] ** 2 + (o[1] * d[1]) / HR[1] ** 2 + (o[2] * d[2]) / HR[2] ** 2);
  const C = (o[0] / HR[0]) ** 2 + (o[1] / HR[1]) ** 2 + (o[2] / HR[2]) ** 2 - 1;
  return (-B + Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A);
}

const deg = Math.PI / 180;

/** Tek's head: neck, face, ears, the shard visor, hair with its leaves, the temple wings. Replaces the bunny's hood and face. */
export function tekHead(b: Builder): void {
  const r = rig();
  const head = r.bone("Head1"), neck = r.bone("Neck1"), spine4 = r.bone("Spine4");
  const headW = (p: V3): Wt => hat(p[2], [[62.8, spine4], [64.6, neck], [66.6, head]]);
  // The jaw and chin follow the head, not the neck: front points count as higher up.
  const faceW = (p: V3): Wt => hat(p[2] + Math.max(0, -p[1] - 0.5) * 0.9, [[64.0, neck], [65.6, head]]);
  const H: Wt = [[head, 1]];

  // Neck (a touch of shade: it sits under the jaw). It carries on up inside the head behind the jaw, so there's no step
  // or gap under the ear; the top rows are the jaw's shade so the join doesn't read as a seam.
  {
    const nz = [62.2, 64, 65.8, 67.2, 68.4];
    b.surface(
      nz.map((z) => ring([0, 1.9 - (z - 62.2) * 0.42, z], X, Y, 2.05, 2.05, 12)),
      { paint: (i) => (i >= 2 ? SKIN_SHADE : NECK), weight: (p) => headW(p) },
    );
  }

  // Face: the loft, shaded under the jaw.
  {
    const K = 24;
    const rows = FACE.map(([z]) => Array.from({ length: K }, (_, k) => facePoint(z, (k / K) * Math.PI * 2)));
    b.surface(rows, { paint: (i) => (i >= FACE.length - 2 ? SKIN_SHADE : SKIN), weight: (p) => faceW(p), capStart: SKIN, capEnd: SKIN_SHADE });
  }

  // Nose: a small wedge, bridge under the visor, tip just proud of the face.
  {
    const bridge = onFace(0, -0.16, -0.05);
    const tip = add(onFace(0, -0.36, 0), [0, -0.45, -0.05]);
    const l = onFace(0.14, -0.42, -0.02), rr = onFace(-0.14, -0.42, -0.02);
    const under = onFace(0, -0.45, 0.05);
    const tri = (a: V3, c: V3, d: V3, paint: Paint) => {
      let n = norm(cross(sub(c, a), sub(d, a)));
      if (n[1] > 0) n = scale(n, -1);
      b.tri(a, c, d, n, n, n, paint, H, H, H);
    };
    tri(bridge, l, tip, SKIN);
    tri(bridge, tip, rr, SKIN);
    tri(l, under, tip, SKIN);
    tri(tip, under, rr, SKIN);
  }

  // Mouth: a short, nearly level line.
  {
    const lat = -0.74;
    const lons = [-0.15, -0.075, 0, 0.075, 0.15];
    const top = lons.map((lon) => onFace(lon, lat + 0.011, 0.02));
    const bot = lons.map((lon) => onFace(lon, lat - 0.011, 0.02));
    b.surface([top, bot], { closed: false, paint: () => MOUTH, weight: () => H, out: () => [0, -1, 0] });
  }

  // Ears: angular ovals, tilted back, with a warm inset.
  for (const sx of [1, -1]) {
    const c: V3 = [sx * 3.72, 0.55, 68.5];
    const tilt = 14 * deg;
    const rot = (p: V3): V3 => {
      const q = sub(p, c);
      return add(c, [q[0], q[1] * Math.cos(tilt) + q[2] * Math.sin(tilt), -q[1] * Math.sin(tilt) + q[2] * Math.cos(tilt)]);
    };
    const outer = b.ellipsoidRows(c, [0.5, 0.78, 1.25], X, Z, 8, 4).map((row) => row.map(rot));
    b.surface(outer, { paint: () => SKIN, weight: () => H, flat: true });
    const inner = b.ellipsoidRows(add(c, [sx * 0.3, -0.05, -0.05]), [0.22, 0.48, 0.85], X, Z, 8, 3).map((row) => row.map(rot));
    b.surface(inner, { paint: () => EAR_IN, weight: () => H, flat: true });
  }

  // The visor: one flat slab across both eyes, the same on both sides (pointy anime glasses): from the nose each
  // half's lower edge climbs past the eye into a broad blade that sweeps back and up over the hair to a sharp ivory
  // point above and behind the ear. Rows run across it from the left point to the right one; each row is a slanted
  // line (higher = further back), so the colour fields have slanted edges. Over the hair it rides the cap.
  {
    const K = 0.55; // slant: |lon| = |u| + K * lat (eased in at the middle so both halves meet at the nose)
    const half = [0, 0.16, 0.32, 0.5, 0.72, 0.88, 1.0, 1.12, 1.26, 1.4];
    const us = [...half.slice(1).reverse().map((u) => -u), ...half];
    // Each half: the top edge rises steadily; the lower edge dips a little at the nose, runs level under the eye, then
    // climbs to meet the top edge at the point.
    const top = (a: number) => 0.31 + 0.36 * Math.pow(smoothstep(0.05, 1.4, a), 0.85);
    const bot = (a: number) => -0.2 - 0.04 * Math.exp(-((a / 0.3) ** 2)) + 0.87 * Math.pow(clamp((a - 0.45) / 0.95, 0, 1), 1.3);
    const place = (u: number, lat: number, off: number): V3 => {
      const a = Math.abs(u);
      const lon = Math.sign(u) * (a + K * lat * smoothstep(0, 0.2, a));
      const d = dirOf(lon, lat);
      const rr = faceR(d);
      // Where the hair cap covers this direction, ride just over it (blended across the hairline).
      const cr = capR(d);
      const q = sub(add(FC, scale(d, cr)), HC);
      const pol = Math.acos(clamp(q[2] / HR[2] / Math.hypot(q[0] / HR[0], q[1] / HR[1], q[2] / HR[2]), -1, 1));
      const az = Math.atan2(q[0] / HR[0], -q[1] / HR[1]);
      const over = smoothstep(-0.05, 0.12, hairline(az) - pol);
      return add(FC, scale(d, rr + (Math.max(rr, cr + 0.85) - rr) * over + off));
    };
    const rows = us.map((u) => {
      const a = Math.abs(u);
      const t = top(a), bt = bot(a);
      const tt = Math.max(t, bt + 0.012);
      return [place(u, tt, 0.16), place(u, tt, 0.38), place(u, bt, 0.38), place(u, bt, 0.16)];
    });
    // Sharp, straight points: each end row is a single point carried on straight from the two rows before it (not
    // curled round the head).
    const mid = (row: V3[]) => scale(row.reduce((acc, p) => add(acc, p), [0, 0, 0] as V3), 1 / row.length);
    for (const [end, n1, n2] of [[0, 1, 2], [rows.length - 1, rows.length - 2, rows.length - 3]]) {
      const m1 = mid(rows[n1]);
      const tip = add(m1, scale(sub(m1, mid(rows[n2])), 1.1));
      rows[end] = [tip, tip, tip, tip];
    }
    // Red across both eyes, a broad slanted ivory stripe at each temple, a second red field climbing each side, a thin
    // ivory point (seen from the side: red, ivory, red, ivory, like the avatar's shard). Faces k = 1 (front) and 3
    // (back) in the colour, the thin edges (0, 2) a shade darker.
    const red = (i: number) => {
      const m = Math.abs((us[i] + us[i + 1]) / 2);
      return m < 0.5 || (m > 0.72 && m < 1.0);
    };
    b.surface(rows, { paint: (i, k) => (k % 2 ? (red(i) ? VISOR_RED : VISOR_WHITE) : red(i) ? VISOR_RED_EDGE : VISOR_WHITE_EDGE), weight: () => H, flat: true });
  }

  // Hair cap.
  {
    const K = 26, R = 9;
    const rows: V3[][] = [];
    for (let i = 0; i <= R; i++)
      rows.push(Array.from({ length: K }, (_, k) => {
        const az = (k / K) * Math.PI * 2;
        return onCap(az, 0.08 + (hairline(az) - 0.08) * (i / R));
      }));
    // The back of the cap is foliage already: teal at the front and sides, mid then deep green round the back (the
    // nape stays dark teal), so the leaves on top read as part of one mass.
    const paint = (i: number, k: number): Paint => {
      const back = (1 - Math.cos(((k + 0.5) / K) * Math.PI * 2)) / 2;
      if (i >= R - 2) return HAIR[2];
      if (i < 4 && back > 0.5) return LEAF.sage; // the crown turning green
      const j = 0.07 * Math.sin(k * 2.7 + i * 1.9); // a ragged edge, not a clean seam
      return back > 0.84 + j ? LEAF.deep : back > 0.72 + j ? LEAF.mid : HAIR[0];
    };
    b.surface(rows, { paint, weight: (p) => headW(p), capStart: HAIR[0] });
  }

  // Locks: flattened tapered blades rooted inside the cap and laid along it (curling in), in three groups.
  // Lock colours: the three hair tones, then sage and mid green (locks turning into leaves).
  const LOCK_COL = [...HAIR, LEAF.sage, LEAF.mid];
  const lock = (azD: number, polD: number, dir: V3, len: number, w: number, curl: number, col: number) => {
    const root = onCap(azD * deg, polD * deg, -0.35);
    const out = capNormal(root);
    const d = norm(dir);
    blade(b, root, d, cross(d, out), {
      len,
      width: (t) => w * Math.pow(1 - t, 0.85) * (0.8 + 0.4 * Math.sin(Math.PI * Math.min(1, t * 1.6))),
      th: w * 0.36,
      curl,
      seg: 4,
      paint: () => LOCK_COL[col],
      weight: (p) => headW(p),
    });
  };
  // [az deg, polar deg, direction, length, root half width, curl, colour]
  const LOCKS: [number, number, V3, number, number, number, number][] = [
    // Fringe: forward and down over the forehead, the tips just over the visor's top edge, swept to its right (clear
    // of the shard's rising point on its left).
    [-56, 44, [-0.5, -0.55, -0.67], 3.7, 1.45, 0.06, 0],
    [-26, 30, [-0.28, -0.75, -0.6], 4.6, 1.6, 0.05, 1],
    [2, 26, [-0.1, -0.8, -0.6], 4.7, 1.55, 0.05, 0],
    [22, 26, [0.08, -0.8, -0.6], 3.4, 1.35, 0.06, 2],
    // Two broad, unequal clumps over the front of the dome, swept to its right.
    [-30, 16, [-0.62, -0.6, -0.5], 4.2, 1.9, 0.26, 1],
    [22, 20, [-0.42, -0.7, -0.57], 3.8, 1.8, 0.26, 0],
    // Windswept: locks from the crown laid diagonally forward over the forehead to its right, over the fringe roots.
    [30, 12, [-0.55, -0.7, -0.35], 4.0, 1.5, 0.18, 1],
    [-6, 16, [-0.5, -0.72, -0.4], 3.6, 1.4, 0.18, 0],
    // Crown: broad locks sweeping back over the top, unequal, into the leaves.
    [-20, 8, [-0.25, 0.8, 0.55], 3.6, 1.5, 0.22, 1],
    [20, 10, [0.3, 0.8, 0.5], 3.4, 1.5, 0.22, 3],
    [-62, 26, [-0.55, 0.75, 0.35], 3.6, 1.45, 0.2, 3],
    [128, 30, [0.45, 0.85, 0.25], 3.0, 1.35, 0.22, 2],
    [-108, 46, [-0.6, 0.75, 0.05], 3.4, 1.45, 0.2, 2],
    [0, 2, [0.05, 0.9, 0.45], 3.8, 1.5, 0.24, 0],
    // Sides: a long lock down each cheek in front of the ear, one behind it.
    [-74, 74, [-0.12, -0.36, -0.92], 3.5, 0.8, 0.1, 0],
    [-104, 82, [-0.35, 0.65, -0.68], 2.8, 0.7, 0.14, 2],
    [74, 74, [0.08, -0.5, -0.86], 3.4, 0.75, 0.08, 2],
    [104, 82, [0.35, 0.65, -0.68], 2.8, 0.75, 0.14, 2],
    [-120, 80, [-0.4, 0.45, -0.8], 3.2, 1.25, 0.16, 2],
    [120, 80, [0.4, 0.45, -0.8], 3.0, 1.25, 0.16, 0],
    // Into the foliage: teal locks reaching back across the green, so hair and leaves interleave.
    [150, 50, [0.25, 0.9, -0.2], 3.0, 1.3, 0.2, 0],
    [-160, 56, [-0.2, 0.9, -0.3], 3.0, 1.3, 0.2, 2],
    // Over the sides of the skull: broad overlapping masses swept back and down, so no smooth cap shows.
    [80, 42, [0.4, 0.8, -0.45], 3.6, 1.6, 0.2, 3],
    [104, 58, [0.35, 0.85, -0.35], 3.4, 1.5, 0.2, 4],
    [58, 56, [0.2, 0.1, -0.97], 2.2, 0.95, 0.1, 1],
    [-78, 44, [-0.35, 0.75, -0.55], 3.6, 1.7, 0.2, 2],
    [-104, 58, [-0.35, 0.85, -0.35], 3.4, 1.5, 0.2, 4],
    [-62, 58, [-0.3, 0.5, -0.8], 2.8, 1.15, 0.16, 1],
    // Nape: short tufts, back and down.
    [158, 112, [0.25, 0.55, -0.8], 2.6, 1.2, 0.14, 2],
    [180, 114, [0, 0.6, -0.8], 2.9, 1.25, 0.14, 0],
    [-158, 112, [-0.25, 0.55, -0.8], 2.6, 1.2, 0.14, 2],
  ];
  for (const [az, pol, dir, len, w, curl, col] of LOCKS) lock(az, pol, dir, len, w, curl, col);

  // Leaves. The big upper sprays hang off the ear bones (spring motion, see the header): base weights blend from the
  // head to the first ear bone, the outer part to the second.
  const segT = EAR.seg / EAR.length;
  const earW = (side: number, t: number, k: number): Wt => {
    const e1 = r.index(side > 0 ? "bunny.EarL" : "bunny.EarR"), e2 = r.index(side > 0 ? "bunny.EarL2" : "bunny.EarR2");
    const f = k * smoothstep(0, 0.2, t);
    return mixW([H, 1 - f], [t < segT ? [[e1, 1]] : [[e1, 0.4], [e2, 0.6]], f]);
  };
  // [az deg, polar deg, direction, length, half width, colour, shade, ear follow]
  const LEAVES: [number, number, V3, number, number, Paint, Paint, number][] = [
    // The upper back: an asymmetric fan of broad pointed leaves, staggered, with gaps (fanned out round the back of
    // the head from its right, over the top, to its left and down; longer on its left). Added below.
    // Green into the crown and the upper side of its left, behind the shard's point.
    [118, 36, [0.6, 0.7, 0.4], 3.4, 1.4, LEAF.mid, LEAF.deep, 0.6],
    [100, 22, [0.55, 0.75, 0.4], 3.0, 1.2, LEAF.sage, LEAF.mid, 0.6],
    [-112, 34, [-0.6, 0.72, 0.35], 2.8, 1.2, LEAF.mid, LEAF.deep, 0.6],
    // Behind the ears and at the nape: shorter.
    [126, 90, [0.55, 0.7, -0.4], 2.6, 1.3, LEAF.deep, LEAF.deepest, 0],
    [-128, 88, [-0.55, 0.7, -0.4], 2.4, 1.25, LEAF.deepest, LEAF.deep, 0],
    // Laid over the back of the head, overlapping like scales.
    // Down its left temple beside the visor and behind the ear, toward the jaw.
    [86, 62, [0.18, -0.5, -0.85], 4.2, 1.05, LEAF.mid, LEAF.deep, 0],
    [110, 84, [0.35, 0.35, -0.87], 2.2, 0.75, LEAF.sage, LEAF.mid, 0],
    // From the middle of the back of the head, pointing back and a little up: seen from behind (the usual camera)
    // they cover the dome.
    [172, 52, [0.3, 0.92, 0.1], 3.0, 1.2, LEAF.mid, LEAF.deep, 0],
    [-170, 70, [-0.3, 0.9, 0.1], 2.6, 1.1, LEAF.mid, LEAF.deep, 0],
    // Laid flat over the back of the head (breaking up the dome without adding to the silhouette).
    [130, 74, [0.72, 0.62, -0.2], 3.0, 1.2, LEAF.sage, LEAF.mid, 0],
    [-136, 76, [-0.72, 0.6, -0.25], 2.8, 1.15, LEAF.mid, LEAF.deep, 0],
    [184, 84, [0, 0.5, -0.86], 2.6, 1.15, LEAF.sage, LEAF.mid, 0],
    [176, 64, [0.05, 0.55, -0.83], 3.2, 1.4, LEAF.mid, LEAF.deep, 0],
    [152, 80, [0.3, 0.45, -0.84], 2.6, 1.2, LEAF.sage, LEAF.mid, 0],
    [-158, 82, [-0.3, 0.45, -0.84], 2.6, 1.2, LEAF.mid, LEAF.deep, 0],
    // Small pale ones caught in the hair across the crown, lying back: where the hair turns into leaves.
    [60, 16, [0.4, 0.85, 0.3], 2.3, 0.85, LEAF.pale, LEAF.sage, 0],
    [-82, 46, [-0.55, 0.78, 0.2], 2.1, 0.8, LEAF.pale, LEAF.sage, 0],
  ];
  {
    const BACK = norm([0.15, 1, 0.12]);
    const fan: [number, number, number, number, Paint, Paint][] = [
      // [angle round the back axis (deg, 0 = its left, 90 = up), length, half width, spread, colour, shade]: three
      // long blades make the silhouette, smaller ones between them, each at its own angle out from the back.
      [-32, 2.5, 1.0, 0.55, LEAF.deep, LEAF.deepest],
      [14, 6.4, 1.25, 0.42, LEAF.mid, LEAF.deep],
      [48, 4.2, 1.3, 0.4, LEAF.deep, LEAF.deepest],
      [76, 2.6, 1.0, 0.7, LEAF.sage, LEAF.mid],
      [106, 4.6, 1.35, 0.32, LEAF.mid, LEAF.deep],
      [140, 3.2, 1.15, 0.6, LEAF.deep, LEAF.deepest],
      [180, 2.3, 1.0, 0.6, LEAF.mid, LEAF.deep],
    ];
    fan.forEach(([phi, len, w, spread, paint, shade], k) => {
      const radial: V3 = [Math.cos(phi * deg), 0, Math.sin(phi * deg)];
      const dirC = norm(add(scale(BACK, 0.85), scale(radial, spread)));
      // Root on the cap where the direction (from its centre) meets it, a little in.
      const q = norm(add(scale(BACK, 0.75), scale(radial, 0.6)));
      const base: V3 = [HC[0] + q[0] * (HR[0] - 0.3), HC[1] + q[1] * (HR[1] - 0.3), HC[2] + q[2] * (HR[2] - 0.3)];
      const side = radial[0] >= 0 ? 1 : -1;
      const up = Math.sin(phi * deg);
      const follow = up > 0.4 ? 0.7 : 0.2;
      leaf(b, base, dirC, capNormal(base), { len, w, paint, shade, curl: [0.16, 0.06, 0.12][k % 3], bend: len < 3.5 ? [0.3, -0.28][k % 2] : [0.06, -0.08][k % 2], weight: (_, t) => earW(side, t, follow) });
    });
  }
  for (const [az, pol, dir, len, w, paint, shade, follow] of LEAVES) {
    const base = onCap(az * deg, pol * deg, -0.2);
    const side = Math.sin(az * deg) >= 0 ? 1 : -1;
    leaf(b, base, dir, capNormal(base), { len, w, paint, shade, curl: follow > 0 ? 0.1 : 0.16, weight: (_, t) => (follow > 0 ? earW(side, t, follow) : H) });
  }

  // The winged helmet, kept small: a little white wing tucked above and behind each ear, swept back.
  for (const sx of [1, -1]) wing(b, onCap(sx * 120 * deg, 88 * deg, -0.25), [sx, 0.3, 0.1], [sx * 0.2, 1, 0.1], 0.3, () => H, TEMPLE_WING);
}

/** Jacket details: a tall standing collar, the silver zip down the front, a small wing mark on the back. Replaces the hoodie's pocket, strings and logos. */
export function tekJacket(b: Builder, torsoW: (p: V3) => Wt, facePoint: (x: number, z: number, side: number, off: number) => [V3, V3], jacket: Paint, trim: Paint): void {
  const r = rig();
  const neck = r.bone("Neck1"), spine4 = r.bone("Spine4");
  // Follows the neck (not the head), so looking around turns the jaw inside it.
  const collarW = (p: V3): Wt => hat(p[2], [[62, spine4], [65.5, neck]]);
  // Standing collar: an open band round the neck (a small gap at the zip), its top edge low at the throat and high
  // behind the jaw; outside in the jacket colour, the inside and the rolled top in the trim.
  const K = 22;
  const gap = 0.16; // radians either side of the front
  const angles = Array.from({ length: K + 1 }, (_, k) => -Math.PI / 2 + gap + ((2 * Math.PI - 2 * gap) * k) / K);
  const topZ = (th: number) => 64.2 + 2.6 * Math.pow((1 + Math.sin(th)) / 2, 0.8); // th = -pi/2 front, pi/2 back
  const at = (th: number, f: number, grow: number): V3 => {
    const z = 61.4 + (topZ(th) - 61.4) * f;
    const g = (z - 61.4) / 5.4;
    const cy = 2.1 - g * 1.25;
    const rx = 4.55 - g * 0.85 + grow, ry = 4.1 - g * 0.75 + grow;
    return [Math.cos(th) * rx, cy + Math.sin(th) * ry, z];
  };
  const fs = [0, 0.3, 0.6, 0.85, 1];
  const outer = fs.map((f) => angles.map((th) => at(th, f, 0)));
  const inner = [...fs].reverse().map((f) => angles.map((th) => at(th, f, -0.55)));
  b.surface(outer, { closed: false, paint: () => jacket, weight: (p) => collarW(p), out: (i, k) => [Math.cos(angles[k]), Math.sin(angles[k]), 0] });
  b.surface(inner, { closed: false, paint: () => trim, weight: (p) => collarW(p), out: (i, k) => [-Math.cos(angles[k]), -Math.sin(angles[k]), 0] });
  // The rolled top edge and the two front edges of the band.
  const lip = [angles.map((th) => at(th, 1, 0)), angles.map((th) => add(at(th, 1, -0.27), [0, 0, 0.14])), angles.map((th) => at(th, 1, -0.55))];
  b.surface(lip, { closed: false, paint: () => trim, weight: (p) => collarW(p), out: () => Z });
  for (const th of [angles[0], angles[K]]) {
    const edge = [fs.map((f) => at(th, f, 0)), fs.map((f) => at(th, f, -0.55))];
    b.surface(edge, { closed: false, paint: () => trim, weight: (p) => collarW(p), out: () => [Math.sign(Math.cos(th)) * 0.3, -1, 0] });
  }
  // Zip: up the front of the jacket to the collar's top, then the pull hanging from it.
  const zipPath: V3[] = [];
  for (let z = 36.4; z <= 62; z += 2.2) zipPath.push(facePoint(0, z, -1, 0.16)[0]);
  for (const f of [0.15, 0.45, 0.75, 1]) zipPath.push(add(at(-Math.PI / 2, f, 0.06), [0, -0.05, 0]));
  zipPath.reverse();
  b.tube(zipPath, 0.17, 4, X, () => ZIP, (p) => (p[2] > 62.5 ? collarW(p) : torsoW(p)));
  const pull = at(-Math.PI / 2, 0.82, 0.3);
  b.surface(b.ellipsoidRows(add(pull, [0, -0.05, -0.75]), [0.38, 0.14, 0.75], Z, X, 4, 2), { paint: () => ZIP, weight: (p) => collarW(p), flat: true });
  // On the back, where the third-person camera looks: a small pair of white wings, flat on the jacket (ribbons laid on
  // its surface, like the bunny's hop-arc logo).
  const on = (x: number, z: number, off = 0.16) => facePoint(x, z, 1, off)[0];
  const ribbon = (pts: [number, number][], width: (t: number) => number, paint: Paint, off = 0.16) => {
    const top: V3[] = [], bot: V3[] = [];
    pts.forEach(([x, z], i) => {
      const [nx, nz] = pts[Math.min(pts.length - 1, i + 1)], [px, pz] = pts[Math.max(0, i - 1)];
      const tx = nx - px, tz = nz - pz, l = Math.hypot(tx, tz) || 1;
      const w = width(i / (pts.length - 1)) / 2;
      top.push(on(x - (tz / l) * w, z + (tx / l) * w, off));
      bot.push(on(x + (tz / l) * w, z - (tx / l) * w, off));
    });
    b.surface([top, bot], { closed: false, paint: () => paint, weight: (p) => torsoW(p), out: () => [0, 1, 0] });
  };
  const cz = 55.2;
  for (const sx of [1, -1]) {
    // Three feathers per wing, sweeping out and up from the middle, the top one longest.
    [[3.9, 2.2, 0.95], [3.4, 1.0, 0.85], [2.7, 0.0, 0.75]].forEach(([reach, rise, w]) => {
      const pts: [number, number][] = Array.from({ length: 7 }, (_, i) => {
        const t = i / 6;
        return [sx * (0.5 + reach * t), cz + rise * Math.pow(t, 1.4) + 0.35 * Math.sin(Math.PI * t)];
      });
      ribbon(pts, (t) => w * (1 - 0.85 * Math.pow(t, 1.6)), WING);
    });
  }
}

/** Winged sneakers: a small wing on the outside of each heel. */
export function tekShoeWing(b: Builder, side: "L" | "R", fx: number, shoeW: (p: V3) => Wt): void {
  const sx = side === "L" ? 1 : -1;
  wing(b, [fx + sx * 2.6, 3.5, 5.0], [sx, 0, 0.1], norm([sx * 0.1, 1, 0.15]), 0.85, shoeW);
}

