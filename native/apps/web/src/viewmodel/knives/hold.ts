// First-person knife hold layer (plan §3.2). Each knife says how the right fist holds it (finger curls + the knife
// frame relative to the hand, authored in the rig's bind space like procedural.ts's carrot grip); the viewmodel applies
// it on top of whatever drives the arm (v_knife_t's sequences with hosted content, or procedural.ts), before the
// inspect:
//
//   base pose (cs / procedural)  ->  KnifeHold.apply (fingers + knife follow the hand, per-action tweaks)
//                                ->  inspect (may rotate the hand / knife / fingers, may set state.angles)
//                                ->  KnifeHold.solve (extra knife bones follow Knife_Handle + state.angles)
//
// Runtime cost: ~20 3x4 concats per frame. The carrot's hold is CARROT_HOLD (also procedural.ts's rest pose).

import { add, Builder, cross, dot, len, norm, scale, sub } from "../../player/bunny/builder";
import { concat, invert34, xform, type V3 } from "../../player/bunny/rig";
import { angleMatrix, fromAxes, identity, rotAbout } from "../math";
import type { VmAction } from "../procedural";
import { vmRig, type VmRig } from "../rig";
import type { GloveStyleId } from "../../loadout";
import { carrot } from "./carrot";
import { KnifeCtx } from "./ctx";
import { PART, type Curl, type HoldSpec, type KnifeDef, type KnifeState } from "./types";

const D2R = Math.PI / 180;
const FINGERS = ["Index", "Middle", "Ring", "Pinky"] as const;

/**
 * The carrot fist: the default hold (and procedural.ts's rest pose). The grip solver (wrapFingers) closes the four
 * fingers onto the grip and the thumb's MCP / IP onto the index finger (or the grip); the curls here are their limits.
 * The thumb's root crosses the front of the fist just below the guard, spread toward the index like a CS hammer grip
 * (v0.0.4's [-18, 28, 32] lay along the grip and put its tip ~1.25 units inside the guard).
 */
export const CARROT_HOLD: HoldSpec = {
  index: { c: [78, 92, 75] },
  middle: { c: [82, 95, 75] },
  ring: { c: [86, 95, 75] },
  pinky: { c: [90, 92, 75] },
  thumb: { c: [15, 40, 60], spread: 20 },
  wrap: { fingers: ["Index", "Middle", "Ring", "Pinky", "Thumb"], seat: -0.02 },
};

/** The straight holds' thumb (the carrot's: over the front of the fist, below the guard). */
const STRAIGHT_THUMB = { c: [15, 40, 60] as V3, spread: 20 };
/** The straight hold's thumb for slim grips (Daikon-tana, Candy Cane Shiv): further round, over the index. */
export const SLIM_THUMB = { c: [18, 40, 60] as V3, spread: 30 };

/**
 * Where a hammer grip's handle crosses the palm, as a fraction of the wrist -> knuckles length: across the base of the
 * fingers (the palm's distal crease), so the proximal phalanges rest on it too (v0.0.5 had it at 0.82, mid-palm: the
 * fingers could only reach it with their tips, and without a solver the carrot's sank through them).
 */
export const GRIP_ALONG = 0.94;

/** The right hand in bind space with a hold's fingers curled: what HoldSpec.place() builds the knife frame from. */
export interface HandFrame {
  wrist: V3;
  /** Wrist -> knuckles (unit). */
  ax: V3;
  /** Across the palm toward the index finger (unit, ⟂ ax). */
  across: V3;
  /** Palm normal (thumb / palm side, unit). */
  n: V3;
  palmL: number;
  /** The carrot's knife frame (procedural.ts): grip in the fist, z out of the thumb side. */
  carrot: Float32Array;
  /** Curled bind-space matrix of a right finger bone ("Index01", "Thumb02"). */
  bone(name: string): Float32Array;
  /** Curled joint position / segment direction (bone x axis) of a right finger bone. */
  joint(name: string): V3;
  dir(name: string): V3;
  /** A frame from an origin, a z direction and a y hint (orthonormalised; x = y × z). */
  frame(o: V3, z: V3, y: V3): Float32Array;
  /** Re-curls one finger ("Index" .. "Pinky", "Thumb"). */
  curl(finger: string, c: Curl): void;
}

/** Fingertip length past the last joint and tube radius per finger (viewmodel/mesh.ts FINGERS). */
const TIP: Record<string, [number, number]> = { Index: [0.92, 0.4], Middle: [0.98, 0.42], Ring: [0.92, 0.4], Pinky: [0.8, 0.35], Thumb: [1.02, 0.46] };
/** Radius of each finger segment's capsule relative to the finger's tube (the tube tapers toward the tip, gloves/fp.ts). */
const SEG_R = [1, 0.95, 0.85];

/**
 * Glove skin on the side of the fingers that grips (units over the knit glove's finger tubes, per digit: fingers,
 * thumb), measured from gloves/fp.ts: every style keeps the palm side of the fingers where the knit glove has it
 * (padding and plates go on the back), so the fingers only differ by the driver's thinner leather; the thumb's
 * outer side carries the moto guard / the paw fuzz / the wrap turns, which its tip and side can bring against a guard.
 * apps/api/test/grip-contact.test.ts checks this table against the built geometry.
 */
export const GRIP_SKIN: Record<GloveStyleId, { finger: number; thumb: number }> = {
  knit: { finger: 0, thumb: 0 },
  plush: { finger: 0, thumb: .05 },
  bune: { finger: 0, thumb: 0 },
  sport: { finger: 0, thumb: 0 },
  driver: { finger: -0.012, thumb: -0.015 },
  wraps: { finger: 0, thumb: 0.05 },
  moto: { finger: 0, thumb: 0.1 },
  specialist: { finger: 0, thumb: 0 },
  paws: { finger: 0, thumb: 0.05 },
  garden: { finger: 0, thumb: 0 },
};

/** Distance from point p to segment a-b. */
function pointSeg(p: ArrayLike<number>, o: number, a: V3, b: V3): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const apx = p[o] - a[0], apy = p[o + 1] - a[1], apz = p[o + 2] - a[2];
  const l = abx * abx + aby * aby + abz * abz;
  const t = l > 1e-9 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / l)) : 0;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * A knife's first-person mesh as a point cloud in its own knife-local frame (open: the bind of its extra bones), with
 * which points are its grip (PART.grip): what the grip solver wraps the fingers round and keeps them out of.
 */
export interface KnifeCloud {
  /** xyz per point, knife-local. */
  p: Float32Array;
  /** 1 = grip. */
  grip: Uint8Array;
  n: number;
}

const clouds = new Map<string, KnifeCloud>();

/** Whether a knife's cloud is built (or seeded) already. */
export function hasKnifeCloud(id: string): boolean {
  return clouds.has(id);
}
/** A knife's cloud built elsewhere (the prebuild worker, player/bunny/prebuild.ts): what knifeCloud returns from now on. */
export function seedKnifeCloud(id: string, c: KnifeCloud): void {
  if (!clouds.has(id)) clouds.set(id, c);
}

export function knifeCloud(def: KnifeDef): KnifeCloud {
  let c = clouds.get(def.id);
  if (c) return c;
  const b = new Builder();
  def.build(new KnifeCtx(b, "fp", (p) => p, () => [[0, 1]]));
  const g = b.geometry();
  const P = g.getAttribute("position"), F = g.getAttribute("finishUV");
  // Welded duplicates (seams, caps) add nothing: keep one point per 0.01 cell. (A number key for the cell: a string
  // per vertex made this most of the first grip solve. Any cell beyond +-500 units, which no knife has, keys by string.)
  const seen = new Set<number>();
  const seenFar = new Set<string>();
  const p: number[] = [], grip: number[] = [];
  for (let v = 0; v < P.count; v++) {
    const x = P.getX(v), y = P.getY(v), z = P.getZ(v);
    const X = Math.round(x * 100), Y = Math.round(y * 100), Z = Math.round(z * 100);
    if (Math.abs(X) < 50000 && Math.abs(Y) < 50000 && Math.abs(Z) < 50000) {
      const k = (X + 50000) * 1e10 + (Y + 50000) * 1e5 + (Z + 50000);
      if (seen.has(k)) continue;
      seen.add(k);
    } else {
      const k = `${X},${Y},${Z}`;
      if (seenFar.has(k)) continue;
      seenFar.add(k);
    }
    p.push(x, y, z);
    grip.push(F && Math.round(F.getZ(v)) === PART.grip ? 1 : 0);
  }
  c = { p: Float32Array.from(p), grip: Uint8Array.from(grip), n: grip.length };
  clouds.set(def.id, c);
  return c;
}

/**
 * The cloud in bind space through a knife frame, keeping only points near the hand (centre `c`, radius `rad`); grip
 * points only count as grip inside `gripZ` (knife-local z range) when given.
 */
function cloudAt(cl: KnifeCloud, knife: Float32Array, c: V3, rad: number, gripZ?: [number, number]): { p: Float32Array; grip: Uint8Array; n: number } {
  const p: number[] = [], grip: number[] = [];
  const m = knife;
  for (let i = 0; i < cl.n; i++) {
    const x = cl.p[i * 3], y = cl.p[i * 3 + 1], z = cl.p[i * 3 + 2];
    // xform(knife, 0, [x, y, z]), without an array per point (the seat solve calls this many times).
    const q0 = m[0] * x + m[1] * y + m[2] * z + m[3];
    const q1 = m[4] * x + m[5] * y + m[6] * z + m[7];
    const q2 = m[8] * x + m[9] * y + m[10] * z + m[11];
    if ((q0 - c[0]) ** 2 + (q1 - c[1]) ** 2 + (q2 - c[2]) ** 2 > rad * rad) continue;
    p.push(q0, q1, q2);
    grip.push(cl.grip[i] && (!gripZ || (z >= gripZ[0] && z <= gripZ[1])) ? 1 : 0);
  }
  return { p: Float32Array.from(p), grip: Uint8Array.from(grip), n: grip.length };
}

/** Palm-side half thickness of the glove's palm block at s along the palm axis (gloves/fp.ts PALM, its 0.08 offset). */
function palmSurface(s: number, palmL: number): number {
  const rows: [number, number][] = [[-1.1, 0.92], [-0.2, 0.95], [0.5, 0.92], [palmL * 0.55, 0.86], [palmL - 0.25, 0.74], [palmL + 0.3, 0.6]];
  if (s <= rows[0][0]) return rows[0][1] + 0.08;
  for (let i = 0; i + 1 < rows.length; i++)
    if (s <= rows[i + 1][0]) return rows[i][1] + ((rows[i + 1][1] - rows[i][1]) * (s - rows[i][0])) / (rows[i + 1][0] - rows[i][0]) + 0.08;
  return rows[rows.length - 1][1] + 0.08;
}

/**
 * Height of the knife's grip over the palm (units; < 0 = into it): the lowest grip point over the palm block (between
 * the heel and the knuckles, inside its width). Infinity when no grip point is over the palm.
 */
export function palmGap(h: HandFrame, pts: { p: Float32Array; grip: Uint8Array; n: number }): number {
  let best = Infinity;
  const W = h.wrist, X = h.ax, A = h.across, N = h.n;
  for (let i = 0; i < pts.n; i++) {
    if (!pts.grip[i]) continue;
    // dot(d, ...) with d = point - wrist, without an array per point.
    const d0 = pts.p[i * 3] - W[0], d1 = pts.p[i * 3 + 1] - W[1], d2 = pts.p[i * 3 + 2] - W[2];
    const s = d0 * X[0] + d1 * X[1] + d2 * X[2], a = d0 * A[0] + d1 * A[1] + d2 * A[2];
    if (s < 0.3 || s > h.palmL + 0.2 || Math.abs(a) > 1.45) continue;
    best = Math.min(best, d0 * N[0] + d1 * N[1] + d2 * N[2] - palmSurface(s, h.palmL));
  }
  return best;
}

/**
 * The knife's points binned in a grid (cells of GRID_CELL units), for segGaps: the solver measures every finger
 * segment against the knife a few thousand times per grip, and only points near a segment can matter.
 */
interface PointGrid {
  pts: { p: Float32Array; grip: Uint8Array; n: number };
  cells: Map<number, number[]>;
}
const GRID_CELL = 1;
const cellKey = (ix: number, iy: number, iz: number) => ((ix + 512) * 1024 + (iy + 512)) * 1024 + (iz + 512);
function pointGrid(pts: { p: Float32Array; grip: Uint8Array; n: number }): PointGrid {
  const cells = new Map<number, number[]>();
  for (let i = 0; i < pts.n; i++) {
    const k = cellKey(Math.floor(pts.p[i * 3] / GRID_CELL), Math.floor(pts.p[i * 3 + 1] / GRID_CELL), Math.floor(pts.p[i * 3 + 2] / GRID_CELL));
    let c = cells.get(k);
    if (!c) cells.set(k, (c = []));
    c.push(i);
  }
  return { pts, cells };
}
/**
 * How far past a segment's surface segGaps still measures points (units). The solver only compares gaps with
 * GRIP_CONTACT and -GRIP_SINK (both < 0), so a point farther than this can't change any of its decisions: segGaps
 * reports Infinity when no point is this close, where it used to report the (positive) distance to the nearest.
 */
const GAP_REACH = 0.1;

/**
 * Gap from finger / thumb segments to the knife (units; < 0 = sunk in): [grip points, any point] per segment, over the
 * points within GAP_REACH of it (Infinity when none are).
 */
function segGaps(h: HandFrame, f: string, grid: PointGrid, skin: number, out: number[][]): void {
  const j = [1, 2, 3].map((k) => h.joint(`${f}0${k}`));
  const m3 = h.bone(`${f}03`);
  const [tipLen, fr] = TIP[f];
  const tip = xform(m3, 0, [tipLen, 0, 0]);
  const segs: [V3, V3][] = [[j[0], j[1]], [j[1], j[2]], [j[2], tip]];
  const pts = grid.pts;
  for (let s = 0; s < 3; s++) {
    let g = Infinity, a = Infinity;
    const r = fr * SEG_R[s] + skin;
    const [A, B] = segs[s];
    const reach = r + GAP_REACH;
    const x0 = Math.floor((Math.min(A[0], B[0]) - reach) / GRID_CELL), x1 = Math.floor((Math.max(A[0], B[0]) + reach) / GRID_CELL);
    const y0 = Math.floor((Math.min(A[1], B[1]) - reach) / GRID_CELL), y1 = Math.floor((Math.max(A[1], B[1]) + reach) / GRID_CELL);
    const z0 = Math.floor((Math.min(A[2], B[2]) - reach) / GRID_CELL), z1 = Math.floor((Math.max(A[2], B[2]) + reach) / GRID_CELL);
    for (let ix = x0; ix <= x1; ix++)
      for (let iy = y0; iy <= y1; iy++)
        for (let iz = z0; iz <= z1; iz++) {
          const c = grid.cells.get(cellKey(ix, iy, iz));
          if (!c) continue;
          for (let q = 0; q < c.length; q++) {
            const i = c[q];
            const d = pointSeg(pts.p, i * 3, A, B) - r;
            if (d > GAP_REACH) continue;
            if (d < a) a = d;
            if (pts.grip[i] && d < g) g = d;
          }
        }
    out[s][0] = g;
    out[s][1] = a;
  }
}

/** Closest distance between segments a0-a1 and b0-b1 (sampled: plenty for finger segments). */
function segSeg(a0: V3, a1: V3, b0: V3, b1: V3): number {
  const pa = new Float32Array(3);
  let best = Infinity;
  for (let i = 0; i <= 6; i++) {
    const u = i / 6;
    pa[0] = a0[0] + (a1[0] - a0[0]) * u, pa[1] = a0[1] + (a1[1] - a0[1]) * u, pa[2] = a0[2] + (a1[2] - a0[2]) * u;
    best = Math.min(best, pointSeg(pa, 0, b0, b1));
    pa[0] = b0[0] + (b1[0] - b0[0]) * u, pa[1] = b0[1] + (b1[1] - b0[1]) * u, pa[2] = b0[2] + (b1[2] - b0[2]) * u;
    best = Math.min(best, pointSeg(pa, 0, a0, a1));
  }
  return best;
}

/** A digit's three segments (bind space, as posed in `h`) and their capsule radii (+ skin). */
function digitSegs(h: HandFrame, f: string, skin: number): { a: V3; b: V3; r: number }[] {
  const j = [1, 2, 3].map((k) => h.joint(`${f}0${k}`));
  const [tipLen, fr] = TIP[f];
  const tip = xform(h.bone(`${f}03`), 0, [tipLen, 0, 0]);
  return [[j[0], j[1]], [j[1], j[2]], [j[2], tip]].map(([a, b], s) => ({ a, b, r: fr * SEG_R[s] + skin }));
}

/** Contact the grip solver aims for (units: a slight press, so no light shows between glove and grip). */
export const GRIP_CONTACT = -0.03;
/** The thumb's MCP / IP bend before it closes onto the grip (a relaxed thumb is never ramrod straight). */
const THUMB_FROM = [10, 22];
/** Curls of a finger that has let go of the handle (KnifeState.loosen): open, a little bent. */
const LOOSE: V3 = [4, 14, 10];
/** Closing rate per joint (proximal leads, like a hand closing on a handle: the palm side of the finger lands first). */
const RATE = [2, 1, 0.8];
/** How far a finger may sink into the knife while it closes (anything deeper stops that joint). */
const GRIP_SINK = 0.06;

/**
 * Grip solver: each wrapping finger closes from `wrap.from` toward the hold's curl, all three joints together (like a
 * hand closing on a handle): a joint stops when its own segment rests on the grip (GRIP_CONTACT, through the glove's
 * skin), or one step before moving it would sink any segment past it into the knife (guard, blade, handle) by more
 * than GRIP_SINK; the joints past it keep closing round the handle. So the fingers wrap whatever handle the knife
 * has, snug and without closing through it, for every glove; the thumb keeps its authored root and closes onto the
 * grip or the index finger. `knife` is the knife frame (bind space) from HoldSpec.place / seat.
 */
export function wrapFingers(h: HandFrame, spec: HoldSpec, knife: Float32Array, wrap: NonNullable<HoldSpec["wrap"]>, def: KnifeDef, glove: GloveStyleId = "knit"): Map<string, V3> {
  const out = new Map<string, V3>();
  const centre = add(h.wrist, scale(h.ax, h.palmL));
  const pts = pointGrid(cloudAt(knifeCloud(def), knife, centre, 7, wrap.gripZ));
  const gaps = [[0, 0], [0, 0], [0, 0]];
  for (const f of wrap.fingers) {
    const key = f.toLowerCase() as "index";
    const target = spec[key];
    const skin = f === "Thumb" ? GRIP_SKIN[glove].thumb : GRIP_SKIN[glove].finger;
    // The thumb rests on the knife or on the index finger wrapped round it (a hammer grip's thumb lies over it), with
    // its palm side: a glove's thumb skin (guards, wrap turns) is on its back, so it only counts against the knife.
    const index = f === "Thumb" ? digitSegs(h, "Index", GRIP_SKIN[glove].finger) : null;
    const pose = (ang: V3) => {
      h.curl(f, { c: ang, spread: target.spread });
      segGaps(h, f, pts, skin, gaps);
      if (!index) return;
      digitSegs(h, f, GRIP_SKIN[glove].finger).forEach((t, s) => {
        // (Not the thumb's metacarpal: its base and the index's sit side by side in the palm.)
        if (s === 0) return;
        let d = Infinity;
        for (const q of index) d = Math.min(d, segSeg(t.a, t.b, q.a, q.b) - t.r - q.r);
        gaps[s][0] = Math.min(gaps[s][0], d);
        gaps[s][1] = Math.min(gaps[s][1], d);
      });
    };
    const sunk = (from: number) => {
      for (let s = from; s < 3; s++) if (gaps[s][1] < -GRIP_SINK) return true;
      return false;
    };
    // Close every joint together (each at its own rate, so all would reach the hold's curl at once); a joint locks
    // when its own segment rests on the grip, when it reaches the hold's curl, or (one step back) when moving it
    // would sink any segment past it into the knife. The others keep closing, so the finger wraps round the handle.
    const close = (ang: V3, rootLocked: boolean): boolean => {
      const from: V3 = [ang[0], ang[1], ang[2]];
      const locked = [rootLocked, false, false];
      pose(ang);
      for (let it = 0; it < 120 && !(locked[0] && locked[1] && locked[2]); it++) {
        for (let k = 0; k < 3; k++) {
          if (locked[k]) continue;
          const prev = ang[k];
          ang[k] = Math.min(target.c[k], ang[k] + Math.max(0.5, ((target.c[k] - from[k]) / 60) * RATE[k]));
          pose(ang);
          if (sunk(k)) {
            ang[k] = prev;
            locked[k] = true;
            pose(ang);
          } else if (gaps[k][0] <= GRIP_CONTACT || ang[k] >= target.c[k]) locked[k] = true;
        }
      }
      return Math.min(gaps[0][0], gaps[1][0], gaps[2][0]) <= GRIP_CONTACT + 0.04;
    };
    let ang: V3;
    if (f !== "Thumb" && wrap.rooted?.includes(f)) {
      // Its root stays where the hold puts it (a karambit's index through the ring); the two distal joints close.
      ang = [target.c[0], (wrap.from ?? [0, 6, 4])[1], (wrap.from ?? [0, 6, 4])[2]];
      close(ang, true);
    } else if (f !== "Thumb") {
      ang = [...(wrap.from ?? [0, 6, 4])] as V3;
      close(ang, false);
    } else {
      // The thumb keeps its authored root (across the front of the fist, under the guard) and closes its MCP / IP
      // onto the knife or the index finger, from a relaxed bend (less of it if that already presses into either).
      ang = [target.c[0], Math.min(THUMB_FROM[0], target.c[1]), Math.min(THUMB_FROM[1], target.c[2])];
      for (let k = 1; k >= 0; k -= 0.25) {
        ang = [target.c[0], Math.min(THUMB_FROM[0], target.c[1]) * k, Math.min(THUMB_FROM[1], target.c[2]) * k];
        pose(ang);
        if (!sunk(0)) break;
      }
      close(ang, true);
    }
    h.curl(f, { c: ang, spread: target.spread });
    out.set(f, ang);
  }
  return out;
}

/**
 * Seats the knife frame on the palm so its grip rests on it at `gap`: moves it along the palm normal, or (`pivot`, a
 * knife-local point such as a karambit's ring on the index finger) tilts it toward / away from the palm about that point.
 */
export function seatKnife(h: HandFrame, knife: Float32Array, def: KnifeDef, gap: number, pivot?: V3, gripZ?: [number, number]): Float32Array {
  const c = add(h.wrist, scale(h.ax, h.palmL));
  const gapAt = (k: Float32Array) => palmGap(h, cloudAt(knifeCloud(def), k, c, 7, gripZ));
  if (!pivot) {
    const g = gapAt(knife);
    if (!Number.isFinite(g)) return knife;
    const out = new Float32Array(knife);
    const d = gap - g;
    out[3] += h.n[0] * d, out[7] += h.n[1] * d, out[11] += h.n[2] * d;
    return out;
  }
  // Tilt the handle toward / away from the palm about the pivot (axis ⟂ the handle and the palm normal, in knife-local
  // terms), bisecting the angle (the grip rises off the palm one way, sinks the other).
  const zw: V3 = [knife[2], knife[6], knife[10]];
  const aw = norm(cross(zw, h.n));
  const axis: V3 = [knife[0] * aw[0] + knife[4] * aw[1] + knife[8] * aw[2], knife[1] * aw[0] + knife[5] * aw[1] + knife[9] * aw[2], knife[2] * aw[0] + knife[6] * aw[1] + knife[10] * aw[2]];
  const at = (deg: number) => {
    const R = new Float32Array(12), out = new Float32Array(12);
    rotAbout(axis, deg * D2R, pivot, R);
    concat(knife, 0, R, 0, out, 0);
    return out;
  };
  const f = (deg: number) => gapAt(at(deg)) - gap;
  const f0 = f(0);
  if (!Number.isFinite(f0) || Math.abs(f0) < 0.005) return knife;
  // Which way lifts the grip: try a small turn both ways.
  const dir = f(4) > f(-4) ? (f0 < 0 ? 1 : -1) : f0 < 0 ? -1 : 1;
  let lo = 0, hi = 0;
  for (let a = 2; a <= 40; a += 2) {
    const v = f(dir * a);
    if (!Number.isFinite(v)) break;
    if (Math.sign(v) !== Math.sign(f0)) {
      hi = dir * a;
      break;
    }
    lo = dir * a;
  }
  if (!hi) return at(lo);
  for (let i = 0; i < 12; i++) {
    const m = (lo + hi) / 2;
    if (Math.sign(f(m)) === Math.sign(f0)) lo = m;
    else hi = m;
  }
  return at((lo + hi) / 2);
}

/** A hold's knife frame (place, then seated on the palm if the hold says so), bind space. */
export function holdKnife(h: HandFrame, spec: HoldSpec, def: KnifeDef): Float32Array {
  const k = spec.place ? spec.place(h) : h.carrot;
  return spec.wrap?.seat !== undefined ? seatKnife(h, k, def, spec.wrap.seat, spec.wrap.pivot, spec.wrap.gripZ) : k;
}

/** A hold's finger curls after its grip solver (bind space, the knife where `place` puts it): what procedural.ts poses. */
export function solvedHold(spec: HoldSpec, r: VmRig = vmRig(), def: KnifeDef = carrot, glove: GloveStyleId = "knit"): HoldSpec {
  if (!spec.wrap) return spec;
  const h = handFrame(spec, r);
  const solved = wrapFingers(h, spec, holdKnife(h, spec, def), spec.wrap, def, glove);
  const out: HoldSpec = { ...spec };
  for (const [f, c] of solved) out[f.toLowerCase() as "index"] = { c, spread: spec[f.toLowerCase() as "index"].spread };
  return out;
}

/** 3x4 * T(offset) * Rx(a) * Ry(b) * Rz(c) (degrees): fine-tunes a knife frame in its own axes. */
export function tweak(m: Float32Array, o: V3, a: V3 = [0, 0, 0]): Float32Array {
  const R = new Float32Array(12), T = new Float32Array(12), out = new Float32Array(12), tmp = new Float32Array(12);
  rotAbout([1, 0, 0], a[0] * D2R, [0, 0, 0], R);
  rotAbout([0, 1, 0], a[1] * D2R, [0, 0, 0], T);
  concat(R, 0, T, 0, tmp, 0);
  rotAbout([0, 0, 1], a[2] * D2R, [0, 0, 0], T);
  concat(tmp, 0, T, 0, R, 0);
  R[3] = o[0], R[7] = o[1], R[11] = o[2];
  concat(m, 0, R, 0, out, 0);
  return out;
}

/** Builds the hand frame and the curled finger matrices (bind space) for a hold. */
export function handFrame(spec: HoldSpec, r: VmRig = vmRig()): HandFrame {
  const at = (nm: string) => r.at(nm);
  const B = (nm: string) => r.bone(nm);
  const wrist = at("Right_Hand");
  const roots = FINGERS.map((f) => at(`Right_${f}01`));
  const kc = scale(roots.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 0.25);
  const ax = norm(sub(kc, wrist));
  let wB = sub(roots[0], roots[3]);
  wB = norm(sub(wB, scale(ax, dot(wB, ax))));
  let n = cross(ax, wB);
  if (dot(n, sub(at("Right_Thumb02"), wrist)) < 0) n = scale(n, -1);
  const palmL = len(sub(kc, wrist));

  const posed = new Map<string, Float32Array>();
  const tmp = new Float32Array(12), acc = new Float32Array(12), acc2 = new Float32Array(12);
  const curl = (names: string[], c: Curl, axis: V3) => {
    identity(acc);
    if (c.spread) {
      rotAbout(n, c.spread * D2R, at(names[0]), tmp);
      acc.set(tmp);
    }
    names.forEach((nm, k) => {
      // Joint pivot moved by the rotations of the joints before it (like procedural.ts).
      rotAbout(axis, (c.c[k] * Math.PI) / 180, at(nm), tmp);
      concat(acc, 0, tmp, 0, acc2, 0);
      acc.set(acc2);
      const m = new Float32Array(12);
      concat(acc, 0, r.bind, B(nm) * 12, m, 0);
      posed.set(nm.replace("Right_", ""), m);
    });
  };
  const curlAxis = norm(cross(ax, n));
  const thumbAxis = norm(cross(norm(sub(at("Right_Thumb02"), at("Right_Thumb01"))), n));
  const curlFinger = (f: string, c: Curl) => curl([1, 2, 3].map((k) => `Right_${f}0${k}`), c, f === "Thumb" ? thumbAxis : curlAxis);
  for (const f of FINGERS) curlFinger(f, spec[f.toLowerCase() as "index"]);
  curlFinger("Thumb", spec.thumb);

  const frame = (o: V3, z: V3, y: V3) => {
    const zz = norm(z);
    const yy = norm(sub(y, scale(zz, dot(y, zz))));
    const xx = cross(yy, zz);
    const m = new Float32Array(12);
    fromAxes(xx, yy, zz, o, m);
    return m;
  };
  // procedural.ts's carrot grip: inside the curled fingers, z along the width axis (thumb side), x toward the knuckles.
  const grip = add(add(wrist, scale(ax, palmL * GRIP_ALONG)), scale(n, 1.35));
  const zB = norm(add(wB, scale(ax, 0.12)));
  const xB = norm(sub(ax, scale(zB, dot(ax, zB))));
  const carrot = new Float32Array(12);
  fromAxes(xB, cross(zB, xB), zB, grip, carrot);
  const get = (nm: string) => {
    const m = posed.get(nm);
    if (!m) throw new Error(`hold: no finger bone ${nm}`);
    return m;
  };
  return {
    wrist,
    ax,
    across: wB,
    n,
    palmL,
    carrot,
    bone: get,
    joint: (nm) => {
      const m = get(nm);
      return [m[3], m[7], m[11]];
    },
    dir: (nm) => {
      const m = get(nm);
      return norm([m[0], m[4], m[8]]);
    },
    frame,
    curl: curlFinger,
  };
}

/** A knife's solved grip in a glove style: the hand-relative matrices KnifeHold poses, and what state.loosen needs. */
interface SolvedGrip {
  bones: number[];
  L: Float32Array;
  invHand: Float32Array;
  loose: { h: HandFrame; spec: HoldSpec; curls: V3[] };
}

/**
 * Solved grips per rig, knife (and its hold spec) and glove style: the solve (~2-15 ms) runs once per pair, so swapping
 * knives or gloves back and forth (the Loadout's hover previews, a second Viewmodel) is free after the first time. The
 * hold is hand-relative, so it doesn't depend on the base (v_knife_t or procedural) or the hand side (a mirror).
 * Dev tuning that edits a spec in place must call clearGripCache().
 */
const grips = new WeakMap<VmRig, Map<string, { spec: HoldSpec; grip: SolvedGrip }>>();

export function clearGripCache(r: VmRig = vmRig()): void {
  grips.get(r)?.clear();
}

function solvedGrip(def: KnifeDef, r: VmRig, glove: GloveStyleId): SolvedGrip {
  const spec = def.hold ?? CARROT_HOLD;
  let m = grips.get(r);
  if (!m) grips.set(r, (m = new Map()));
  const key = `${def.id}|${glove}`;
  const hit = m.get(key);
  if (hit && hit.spec === spec) return hit.grip;
  const h = handFrame(spec, r);
  const knife = holdKnife(h, spec, def);
  const solved = spec.wrap ? wrapFingers(h, spec, knife, spec.wrap, def, glove) : new Map<string, V3>();
  const hand = r.bone("Right_Hand");
  const invHand = new Float32Array(12);
  invert34(r.bind, hand * 12, invHand, 0);
  const bones: number[] = [];
  const mats: Float32Array[] = [];
  for (const f of [...FINGERS, "Thumb"]) {
    for (let k = 1; k <= 3; k++) {
      const nm = `${f}0${k}`;
      bones.push(r.bone(`Right_${nm}`));
      mats.push(h.bone(nm));
    }
  }
  bones.push(r.bone("Knife_Handle"));
  mats.push(knife);
  const L = new Float32Array(bones.length * 12);
  mats.forEach((mm, j) => concat(invHand, 0, mm, 0, L, j * 12));
  const grip: SolvedGrip = { bones, L, invHand, loose: { h, spec, curls: FINGERS.map((f) => solved.get(f) ?? spec[f.toLowerCase() as "index"].c) } };
  m.set(key, { spec, grip });
  return grip;
}

/** Solves (and caches) the grips of these knives in a glove style ahead of time, a little per idle callback. */
export function prewarmGrips(knives: readonly KnifeDef[], glove: GloveStyleId, r: VmRig = vmRig()): void {
  const queue = [...knives];
  // (Through globalThis: the API's tests typecheck this file without the DOM lib.)
  const g = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  const idle: (cb: () => void) => void = typeof g.requestIdleCallback === "function" ? (cb) => g.requestIdleCallback!(cb, { timeout: 2000 }) : (cb) => setTimeout(cb, 50);
  const step = () => {
    const k = queue.shift();
    if (!k) return;
    solvedGrip(k, r, glove);
    idle(step);
  };
  idle(step);
}

/** Per-knife first-person hold runtime (one per Viewmodel + knife). */
export class KnifeHold {
  readonly state: KnifeState;
  /** Overridden bones (fingers, knife_Parent, Knife_Handle) and their hand-relative matrices. */
  private bones: number[];
  private L: Float32Array;
  private hand: number;
  private kb: number;
  private kp: number;
  private joints: { i: number; parent: number; local: Float32Array }[];
  private H = new Float32Array(12);
  private R = new Float32Array(12);
  private T = new Float32Array(12);
  private T2 = new Float32Array(12);
  private rest: number[];
  /** Dev (knives/lab.ts): live overrides of the state after the knife's own pose. */
  devPose: ((s: KnifeState) => void) | null = null;
  private right: number[];
  private arm: number;
  private helper: number[];
  private M = new Float32Array(12);
  /** The bind-space hand the hold was solved in, and the held curls per finger (index .. pinky): for state.loosen. */
  private loose: { h: HandFrame; spec: HoldSpec; curls: V3[] };
  private invHand: Float32Array;
  private Lf = new Float32Array(12);

  constructor(
    readonly def: KnifeDef,
    private r: VmRig = vmRig(),
    /** Glove style on the hand: its skin (GRIP_SKIN) is what the fingers close on. */
    readonly glove: GloveStyleId = "knit",
  ) {
    const solved = solvedGrip(def, r, glove);
    this.loose = solved.loose;
    this.invHand = solved.invHand;
    this.hand = r.bone("Right_Hand");
    this.kb = r.bone("Knife_Handle");
    this.kp = r.bone("knife_Parent");
    this.bones = solved.bones;
    this.L = solved.L;
    // Extra bones: parent-local bind (rig.ts EXTRA_BONES), rotated by -angle about local x at runtime.
    this.joints = (def.joints ?? []).map((nm) => {
      const i = r.bone(nm);
      const parent = r.parent[i];
      const inv = new Float32Array(12), local = new Float32Array(12);
      invert34(r.bind, parent * 12, inv, 0);
      concat(inv, 0, r.bind, i * 12, local, 0);
      return { i, parent, local };
    });
    this.rest = this.joints.map(() => 0);
    this.state = { arm: { o: [0, 0, 0], a: [0, 0, 0] }, wrist: [0, 0, 0], offset: [0, 0, 0], local: null, angles: [...this.rest], show: 0, loosen: 0 };
    this.right = [...r.subtree(r.bone("Root36")), this.kp, this.kb];
    this.arm = r.bone("Right_Arm");
    this.helper = ["Root98", "R_wrist_helper"].map((n) => r.bone(n));
  }

  /** Bones this layer writes (for debugging / inspects that need to know). */
  get overridden(): readonly number[] {
    return this.bones;
  }

  /** Fingers and knife follow the (already posed) hand; per-action tweaks from the knife. */
  apply(W: Float32Array, action: VmAction, t: number, src: "cs" | "procedural" = "procedural"): void {
    const s = this.state;
    s.wrist[0] = s.wrist[1] = s.wrist[2] = 0;
    s.arm.o[0] = s.arm.o[1] = s.arm.o[2] = 0;
    s.arm.a[0] = s.arm.a[1] = s.arm.a[2] = 0;
    s.offset[0] = s.offset[1] = s.offset[2] = 0;
    s.local = null;
    s.loosen = 0;
    for (let j = 0; j < this.rest.length; j++) s.angles[j] = this.rest[j];
    this.def.pose?.(action, t, s, src);
    this.devPose?.(s);
    const ho = this.hand * 12;
    const H = this.H;
    const ao = s.arm.o, aa = s.arm.a;
    if (ao[0] || ao[1] || ao[2] || aa[0] || aa[1] || aa[2]) {
      // Rigid move of the right arm: roll about the forearm (elbow -> wrist) through the wrist, then pitch / yaw about
      // the elbow, then the offset (like the inspect's present move).
      const ao3 = this.arm * 12;
      const w = [W[ho + 3], W[ho + 7], W[ho + 11]];
      const e = [W[ao3 + 3], W[ao3 + 7], W[ao3 + 11]];
      const fa = norm([w[0] - e[0], w[1] - e[1], w[2] - e[2]]);
      rotAbout(fa, aa[2] * D2R, w, this.T);
      angleMatrix(aa[0], aa[1], 0, 0, 0, 0, this.R);
      this.R[3] = e[0] - (this.R[0] * e[0] + this.R[1] * e[1] + this.R[2] * e[2]) + ao[0];
      this.R[7] = e[1] - (this.R[4] * e[0] + this.R[5] * e[1] + this.R[6] * e[2]) + ao[1];
      this.R[11] = e[2] - (this.R[8] * e[0] + this.R[9] * e[1] + this.R[10] * e[2]) + ao[2];
      const m = this.M;
      concat(this.R, 0, this.T, 0, m, 0);
      for (const i of this.right) {
        concat(m, 0, W, i * 12, this.T, 0);
        W.set(this.T, i * 12);
      }
    }
    if (s.wrist[0] || s.wrist[1] || s.wrist[2]) {
      // View-space rotation about the wrist (the hand bends, the forearm stays).
      const e = [W[ho + 3], W[ho + 7], W[ho + 11]];
      const R = this.R;
      angleMatrix(s.wrist[0], s.wrist[1], s.wrist[2], 0, 0, 0, R);
      R[3] = e[0] - (R[0] * e[0] + R[1] * e[1] + R[2] * e[2]);
      R[7] = e[1] - (R[4] * e[0] + R[5] * e[1] + R[6] * e[2]);
      R[11] = e[2] - (R[8] * e[0] + R[9] * e[1] + R[10] * e[2]);
      concat(R, 0, W, ho, H, 0);
      W.set(H, ho);
      // The wrist twist helper (the sleeve's cuff and the glove's wrist rows are partly skinned to it) takes half the
      // bend, like inspects/kit.ts Arm.wrist: without it the cuff stayed put while the hand turned, and the glove's
      // wrist rows sheared against the sleeve trim.
      angleMatrix(s.wrist[0] * 0.5, s.wrist[1] * 0.5, s.wrist[2] * 0.5, 0, 0, 0, R);
      R[3] = e[0] - (R[0] * e[0] + R[1] * e[1] + R[2] * e[2]);
      R[7] = e[1] - (R[4] * e[0] + R[5] * e[1] + R[6] * e[2]);
      R[11] = e[2] - (R[8] * e[0] + R[9] * e[1] + R[10] * e[2]);
      for (const i of this.helper) {
        concat(R, 0, W, i * 12, this.T2, 0);
        W.set(this.T2, i * 12);
      }
    } else H.set(W.subarray(ho, ho + 12));
    const n = this.bones.length;
    for (let j = 0; j < n; j++) concat(H, 0, this.L, j * 12, W, this.bones[j] * 12);
    if (s.loosen > 0) this.loosenFingers(W, H, Math.min(1, s.loosen));
    const kb = this.kb * 12;
    if (s.offset[0] || s.offset[1] || s.offset[2]) {
      identity(this.T);
      this.T[3] = s.offset[0], this.T[7] = s.offset[1], this.T[11] = s.offset[2];
      concat(W, kb, this.T, 0, this.T2, 0);
      W.set(this.T2, kb);
    }
    W.copyWithin(this.kp * 12, kb, kb + 12);
  }

  /**
   * The fingers let go of the handle by k (0 = the hold, 1 = LOOSE: open enough for a balisong's handle to swing round
   * in front of them); the index a little less (with the thumb it keeps the safe handle). Each finger is re-curled
   * between its held and loose curls in bind space (like the solver), so it opens along its own joints.
   */
  private loosenFingers(W: Float32Array, H: Float32Array, k: number): void {
    const { h, spec, curls } = this.loose;
    FINGERS.forEach((f, i) => {
      const kk = f === "Index" ? k * 0.85 : k;
      const c = curls[i];
      h.curl(f, { c: [c[0] + (LOOSE[0] - c[0]) * kk, c[1] + (LOOSE[1] - c[1]) * kk, c[2] + (LOOSE[2] - c[2]) * kk], spread: spec[f.toLowerCase() as "index"].spread });
      for (let j = 1; j <= 3; j++) {
        concat(this.invHand, 0, h.bone(`${f}0${j}`), 0, this.Lf, 0);
        concat(H, 0, this.Lf, 0, W, this.r.bone(`Right_${f}0${j}`) * 12);
      }
      h.curl(f, { c, spread: spec[f.toLowerCase() as "index"].spread });
    });
  }

  /** Applies state.local to Knife_Handle (after the inspect may have set it), then solves the extra bones. */
  private applyLocal(W: Float32Array): void {
    const l = this.state.local;
    if (!l) return;
    const kb = this.kb * 12;
    concat(W, kb, l, 0, this.T2, 0);
    W.set(this.T2, kb);
    W.copyWithin(this.kp * 12, kb, kb + 12);
  }

  /** Extra knife bones follow their parents with state.angles (run after the inspect). */
  solve(W: Float32Array): void {
    this.applyLocal(W);
    const a = this.state.angles;
    this.joints.forEach((j, k) => {
      rotAbout([1, 0, 0], -a[k] * D2R, [0, 0, 0], this.R);
      concat(j.local, 0, this.R, 0, this.T, 0);
      concat(W, j.parent * 12, this.T, 0, W, j.i * 12);
    });
  }
}

/** Knife-local point -> bind space (Knife_Handle), e.g. to place a ring on a finger. */
export function knifeToBind(knife: Float32Array, p: V3): V3 {
  return xform(knife, 0, p);
}

/**
 * The usual hammer grip for a straight knife (carrot fist, the handle through it, edge (-y) toward the knuckles):
 * the carrot's knife frame turned about z (a quarter, plus 40° so the flat of the blade faces the camera in idle) and
 * shifted by `o` (carrot frame), seated on the palm, the fingers wrapped round its grip. `a` adds rotation (deg);
 * `thumb`: its root over the fist (a slim grip lets the index wrap closer in, so the thumb sits further round).
 */
export function straightHold(o: V3 = [0, 0, 0], a: V3 = [0, 0, 40], thumb: Curl = STRAIGHT_THUMB): HoldSpec {
  return {
    ...CARROT_HOLD,
    thumb,
    index: { c: [80, 94, 75] },
    middle: { c: [84, 98, 75] },
    ring: { c: [88, 98, 75] },
    pinky: { c: [92, 96, 75] },
    wrap: { fingers: ["Index", "Middle", "Ring", "Pinky", "Thumb"], seat: -0.02 },
    place: (h) => tweak(h.carrot, o, [a[0], a[1], 90 + a[2]]),
  };
}
