// Weapon hit surfaces and sounds (physics v4 knife / map-given guns; presentation only, never touches the sim).
//
// `impactSurface(report)` says what a hit (core.ts AttackReport: end point, normal, brush entity) struck, from the
// render mesh's materials like surfaces.ts does for footsteps, but for triangles of any orientation (walls, ceilings,
// buttons): the triangle nearest the hit point whose plane passes through it. Triangles are bucketed per brush model
// in 3D grids of a few cell sizes (small triangles in small cells, big ones in big cells) by their centre, so a query
// checks the 27 neighbour cells per level. Brush entity hits are looked up in the entity's model space (moved by its
// current transform). Static props aren't indexed: a hit on one falls back to concrete.
//
//   scheduleImpactSurfaces(core)          after a map load (built when the browser is idle)
//   impactSurface(core, report)           -> "metal" | "wood" | "concrete" | "dirt" | "tile"
//   playImpact(surface, kind, position)   the surface's impact sound at the hit point

import { MaterialKind, type AttackReport, type BrushTransform, type Core } from "../core";
import { classify } from "./surfaces";
import { engine } from "./index";
import type { SfxId } from "./catalog";

export type ImpactSurface = "metal" | "wood" | "concrete" | "dirt" | "tile";
const SURF: ImpactSurface[] = ["metal", "wood", "concrete", "dirt", "tile"];
export type ImpactKind = "slash" | "stab" | "bullet";

const IMPACT_SFX: Record<ImpactSurface, SfxId> = {
  metal: "impact_metal",
  wood: "impact_wood",
  concrete: "impact_concrete",
  dirt: "impact_dirt",
  tile: "impact_tile",
};

/** Cell sizes; a triangle goes into the first level whose half cell covers its radius (else the last). */
const LEVELS = [64, 256, 1024, 4096];
/** Max distance (units) of the hit point from a triangle's plane. */
const PLANE_TOL = 3;
/** Point-in-triangle slack (units, around the edges). */
const EDGE_TOL = 2;

class ModelIndex {
  constructor(
    /** Per triangle: a, b, c (9 floats). */
    readonly tris: Float32Array,
    /** Per triangle: unit normal xyz, plane distance (4 floats). */
    readonly planes: Float32Array,
    readonly surf: Int8Array,
    readonly levels: Map<number, Int32Array>[],
  ) {}

  /** Surface index of the triangle under `p` (model space), or -1. `n`: hit normal (model space) or null. */
  query(p: ArrayLike<number>, n: ArrayLike<number> | null): number {
    let best = -1;
    let bestD = Infinity;
    for (let l = 0; l < LEVELS.length; l++) {
      const cells = this.levels[l];
      if (!cells.size) continue;
      const size = LEVELS[l];
      const cx = Math.floor(p[0] / size), cy = Math.floor(p[1] / size), cz = Math.floor(p[2] / size);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const list = cells.get(key(cx + dx, cy + dy, cz + dz));
            if (!list) continue;
            for (let i = 0; i < list.length; i++) {
              const t = list[i];
              const d = this.distance(t, p, n);
              if (d < bestD) {
                bestD = d;
                best = this.surf[t];
              }
            }
          }
    }
    return best;
  }

  /** Plane distance of `p` to triangle t if p projects inside it (with slack) and the normals agree; else Infinity. */
  private distance(t: number, p: ArrayLike<number>, n: ArrayLike<number> | null): number {
    const P = this.planes;
    const o4 = t * 4;
    const nx = P[o4], ny = P[o4 + 1], nz = P[o4 + 2];
    const dist = Math.abs(nx * p[0] + ny * p[1] + nz * p[2] - P[o4 + 3]);
    if (dist > PLANE_TOL) return Infinity;
    // Either winding: the render mesh may wind faces either way.
    if (n && Math.abs(nx * n[0] + ny * n[1] + nz * n[2]) < 0.7) return Infinity;
    const T = this.tris;
    const o = t * 9;
    const ax = T[o], ay = T[o + 1], az = T[o + 2];
    // Edge test in the plane: p must be on the inner side of every edge (within EDGE_TOL).
    const sign = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
      const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0;
      const len = Math.hypot(ex, ey, ez) || 1;
      const qx = p[0] - x0, qy = p[1] - y0, qz = p[2] - z0;
      // (e x q) . n / |e| = signed distance from the edge line, positive inside for CCW about n.
      return ((ey * qz - ez * qy) * nx + (ez * qx - ex * qz) * ny + (ex * qy - ey * qx) * nz) / len;
    };
    const bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
    if (sign(ax, ay, az, bx, by, bz) < -EDGE_TOL || sign(bx, by, bz, cx, cy, cz) < -EDGE_TOL || sign(cx, cy, cz, ax, ay, az) < -EDGE_TOL) return Infinity;
    return dist;
  }
}

const key = (x: number, y: number, z: number) => ((x + 1024) * 2048 + (y + 1024)) * 2048 + (z + 1024);

let index: Map<number, ModelIndex> | null = null;
/** Brush entity index -> its model ("*N"). */
let entityModel: Map<number, number> | null = null;
let pending: Core | null = null;

function build(core: Core): void {
  pending = null;
  const t0 = performance.now();
  let mesh: ReturnType<Core["mesh"]>;
  let descs: ReturnType<Core["materials"]>;
  try {
    mesh = core.mesh();
    descs = core.materials();
  } catch {
    index = new Map();
    return;
  }
  const { vertices: v, indices: idx, stride, groups, materials } = mesh;
  // Water isn't solid to the trace (MASK_SOLID); tool textures aren't drawn. Glass counts as tile.
  const matSurf = materials.map((m, i) => {
    const k = descs[i]?.kind;
    if (k === MaterialKind.Water) return -1;
    if (k === MaterialKind.Glass) return SURF.indexOf("tile");
    const c = classify(m.name);
    if (!c || c === "water") return -1;
    return SURF.indexOf(c === "grass" ? "dirt" : c);
  });
  const per = new Map<number, { tris: number[]; planes: number[]; surf: number[]; levels: Map<number, number[]>[] }>();
  for (const g of groups) {
    if (g.sky3d) continue;
    const s = matSurf[g.material];
    if (s < 0) continue;
    let m = per.get(g.model);
    if (!m) per.set(g.model, (m = { tris: [], planes: [], surf: [], levels: LEVELS.map(() => new Map()) }));
    for (let i = g.firstIndex; i < g.firstIndex + g.indexCount; i += 3) {
      const a = idx[i] * stride, b = idx[i + 1] * stride, c = idx[i + 2] * stride;
      const ax = v[a], ay = v[a + 1], az = v[a + 2];
      const bx = v[b], by = v[b + 1], bz = v[b + 2];
      const cx = v[c], cy = v[c + 1], cz = v[c + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az;
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-6) continue;
      nx /= len, ny /= len, nz /= len;
      const t = m.surf.length;
      m.tris.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      m.planes.push(nx, ny, nz, nx * ax + ny * ay + nz * az);
      m.surf.push(s);
      const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
      const r = Math.sqrt(Math.max((ax - mx) ** 2 + (ay - my) ** 2 + (az - mz) ** 2, (bx - mx) ** 2 + (by - my) ** 2 + (bz - mz) ** 2, (cx - mx) ** 2 + (cy - my) ** 2 + (cz - mz) ** 2));
      // r + the query tolerance must fit in one cell so the 27 neighbours cover every triangle that can match.
      let l = LEVELS.findIndex((size) => r + PLANE_TOL + EDGE_TOL <= size);
      if (l < 0) l = LEVELS.length - 1;
      const size = LEVELS[l];
      const k = key(Math.floor(mx / size), Math.floor(my / size), Math.floor(mz / size));
      const cell = m.levels[l].get(k);
      if (cell) cell.push(t);
      else m.levels[l].set(k, [t]);
    }
  }
  index = new Map();
  let tris = 0;
  for (const [model, m] of per) {
    tris += m.surf.length;
    index.set(model, new ModelIndex(Float32Array.from(m.tris), Float32Array.from(m.planes), Int8Array.from(m.surf), m.levels.map((lv) => new Map([...lv].map(([k, l]) => [k, Int32Array.from(l)])))));
  }
  entityModel = new Map();
  try {
    core.entities().forEach((e, i) => {
      const mm = /^\*(\d+)$/.exec(e.model ?? "");
      if (mm) entityModel!.set(i, Number(mm[1]));
    });
  } catch {
    /* no entities */
  }
  console.info(`audio: impact surfaces ${tris} triangles in ${per.size} models, ${(performance.now() - t0).toFixed(0)} ms`);
}

/** Builds the hit-surface index for the loaded map when the browser is idle (or on the first query). */
export function scheduleImpactSurfaces(core: Core): void {
  index = null;
  entityModel = null;
  pending = core;
  const run = () => pending === core && build(core);
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 500);
}

/** Brush model of a brush entity (the AttackReport's `entity`), or -1. */
export function modelOfEntity(entity: number): number {
  return entity >= 0 ? (entityModel?.get(entity) ?? -1) : -1;
}

/** Source-space point / direction into a brush model's space (inverse of its transform: Rz(yaw) Ry(pitch) Rx(roll), then origin). */
export function toModelSpace(t: BrushTransform, p: ArrayLike<number>, isDir: boolean): [number, number, number] {
  const D = Math.PI / 180;
  const x = p[0] - (isDir ? 0 : t[0]), y = p[1] - (isDir ? 0 : t[1]), z = p[2] - (isDir ? 0 : t[2]);
  const [sp, cp] = [Math.sin(t[3] * D), Math.cos(t[3] * D)];
  const [sy, cy] = [Math.sin(t[4] * D), Math.cos(t[4] * D)];
  const [sr, cr] = [Math.sin(t[5] * D), Math.cos(t[5] * D)];
  // Rows of R = Rz(yaw) Ry(pitch) Rx(roll); R^T * v.
  const r00 = cp * cy, r01 = sr * sp * cy - cr * sy, r02 = cr * sp * cy + sr * sy;
  const r10 = cp * sy, r11 = sr * sp * sy + cr * cy, r12 = cr * sp * sy - sr * cy;
  const r20 = -sp, r21 = sr * cp, r22 = cr * cp;
  return [r00 * x + r10 * y + r20 * z, r01 * x + r11 * y + r21 * z, r02 * x + r12 * y + r22 * z];
}

/** What a hit struck (by material). Concrete when unknown (props, maps without a render mesh). */
export function impactSurface(core: Core, r: Pick<AttackReport, "end" | "normal" | "entity">, transforms?: Map<number, BrushTransform>): ImpactSurface {
  if (pending) build(pending);
  if (!index) return "concrete";
  const n = Math.hypot(r.normal[0], r.normal[1], r.normal[2]) > 0.5 ? r.normal : null;
  const tryModel = (model: number): number => {
    const m = index!.get(model);
    if (!m) return -1;
    if (model === 0) return m.query(r.end, n);
    const t = (transforms ?? core.brushOrigins()).get(model);
    if (!t) return m.query(r.end, n);
    return m.query(toModelSpace(t, r.end, false), n ? toModelSpace(t, n, true) : null);
  };
  const em = modelOfEntity(r.entity);
  let s = em >= 0 ? tryModel(em) : -1;
  if (s < 0) s = tryModel(0);
  if (s < 0 && r.entity >= 0) {
    // Entity without its own model match (a parented brush, a prop): any brush model under the point.
    for (const model of index.keys()) if (model !== 0 && model !== em && (s = tryModel(model)) >= 0) break;
  }
  return s >= 0 ? SURF[s] : "concrete";
}

/** The impact sound of `surface` at the hit point (Source units). The stab hits harder; bullets are lighter. */
export function playImpact(surface: ImpactSurface, kind: ImpactKind, p: ArrayLike<number>): void {
  const gain = kind === "stab" ? 1.25 : kind === "bullet" ? 0.75 : 0.95;
  const rate = kind === "stab" ? 0.85 : kind === "bullet" ? 1.12 : 1;
  engine.playAt(IMPACT_SFX[surface], p[0], p[1], p[2], gain, rate);
}
