// Footstep surfaces and water from the render mesh (no sim changes): a 2D grid over the world model's walkable
// triangles (normal z > 0.6) and water surfaces, built once per map. A query is a cell lookup plus a few
// point-in-triangle tests, no allocation.
//
// Surface classes come from material names (CS:S material paths are descriptive: metal/metalfloor001a,
// wood/woodfloor005a, nature/blendgrassdirt, tile/..., concrete/...); anything else is concrete. Water materials are
// MaterialKind.Water (core resolves the VMT shader).

import { MaterialKind, type Core } from "../core";
import { SURFACES, type Surface } from "./catalog";

const CELL = 192;
const MAX_CELLS_PER_TRI = 2048;

export interface SurfaceMap {
  /** Surface index (catalog SURFACES) under the feet at (x, y, z), or -1 (nothing walkable within 24 units). */
  at(x: number, y: number, z: number): number;
  /** Water surface height above (x, y) that is above z - 2 and within 2000 units, or NaN. */
  waterAbove(x: number, y: number, z: number): number;
  readonly hasWater: boolean;
}

export function classify(name: string): Surface | null {
  const n = name.toLowerCase();
  if (n.startsWith("tools/") || n.includes("nodraw") || n.includes("skybox") || n.includes("toolsclip") || n.includes("trigger")) return null;
  if (/metal|grate|grating|steel|iron|chainlink|duct|vent|pipe|tin|alum|diamond|plate|rust|catwalk/.test(n)) return "metal";
  if (/wood|plank|crate|board|parquet|bamboo|barrel/.test(n)) return "wood";
  if (/grass|dirt|mud|sand|gravel|snow|nature|ground|leaves|soil|moss|hay|carpet|rug|fabric|cloth/.test(n)) return "grass";
  if (/tile|ceramic|marble|glass|porcelain|bathroom|mosaic/.test(n)) return "tile";
  if (/water|liquid/.test(n)) return "water";
  return "concrete";
}

class Grid implements SurfaceMap {
  hasWater = false;
  constructor(
    private cells: Map<number, Int32Array>,
    private water: Map<number, Int32Array>,
    /** Per triangle: ax, ay, az, bx, by, bz, cx, cy, cz. */
    private tris: Float32Array,
    private triSurface: Int8Array,
  ) {
    this.hasWater = water.size > 0;
  }

  private static key(cx: number, cy: number): number {
    return (cx + 32768) * 65536 + (cy + 32768);
  }

  /** Height of triangle t's plane at (x, y) if (x, y) is inside it (2D), else NaN. */
  private height(t: number, x: number, y: number): number {
    const p = this.tris;
    const o = t * 9;
    const ax = p[o], ay = p[o + 1], az = p[o + 2];
    const bx = p[o + 3], by = p[o + 4], bz = p[o + 5];
    const cx = p[o + 6], cy = p[o + 7], cz = p[o + 8];
    const v0x = cx - ax, v0y = cy - ay, v1x = bx - ax, v1y = by - ay, v2x = x - ax, v2y = y - ay;
    const d00 = v0x * v0x + v0y * v0y;
    const d01 = v0x * v1x + v0y * v1y;
    const d02 = v0x * v2x + v0y * v2y;
    const d11 = v1x * v1x + v1y * v1y;
    const d12 = v1x * v2x + v1y * v2y;
    const den = d00 * d11 - d01 * d01;
    if (Math.abs(den) < 1e-9) return NaN;
    const u = (d11 * d02 - d01 * d12) / den;
    const v = (d00 * d12 - d01 * d02) / den;
    // A little slack so steps on triangle edges don't fall through.
    if (u < -0.01 || v < -0.01 || u + v > 1.02) return NaN;
    return az + u * (cz - az) + v * (bz - az);
  }

  at(x: number, y: number, z: number): number {
    const list = this.cells.get(Grid.key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!list) return -1;
    let best = -1;
    let bestZ = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const hz = this.height(t, x, y);
      // Feet sit on the floor (hull bottom); allow a step below and a little above.
      if (hz !== hz || hz > z + 4 || hz < z - 24 || hz <= bestZ) continue;
      bestZ = hz;
      best = this.triSurface[t];
    }
    return best;
  }

  waterAbove(x: number, y: number, z: number): number {
    const list = this.water.get(Grid.key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!list) return NaN;
    let best = NaN;
    for (let i = 0; i < list.length; i++) {
      const hz = this.height(list[i], x, y);
      if (hz !== hz || hz < z - 2 || hz > z + 2000) continue;
      if (!(hz >= best)) best = hz;
    }
    return best;
  }
}

let current: SurfaceMap | null = null;

/** The map's surface lookup (null until built, or when the map has no render mesh). */
export function surfaces(): SurfaceMap | null {
  return current;
}

/** Builds the lookup from the loaded map's render mesh (world model 0). Cheap: a few ms on big maps. */
export function buildSurfaces(core: Core): SurfaceMap | null {
  const t0 = performance.now();
  let mesh: ReturnType<Core["mesh"]>;
  let descs: ReturnType<Core["materials"]>;
  try {
    mesh = core.mesh();
    descs = core.materials();
  } catch {
    return (current = null);
  }
  const { vertices: vtx, indices: idx, stride, groups, materials } = mesh;
  const matSurface = materials.map((m, i) => (descs[i]?.kind === MaterialKind.Water ? "water" : classify(m.name)));
  const tris: number[] = [];
  const triSurface: number[] = [];
  const cells = new Map<number, number[]>();
  const water = new Map<number, number[]>();
  const add = (map: Map<number, number[]>, t: number, minx: number, miny: number, maxx: number, maxy: number) => {
    const x0 = Math.floor(minx / CELL), x1 = Math.floor(maxx / CELL), y0 = Math.floor(miny / CELL), y1 = Math.floor(maxy / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_TRI) return;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = (cx + 32768) * 65536 + (cy + 32768);
        let l = map.get(k);
        if (!l) map.set(k, (l = []));
        l.push(t);
      }
    }
  };
  for (const g of groups) {
    if (g.model !== 0) continue;
    const surf = matSurface[g.material];
    if (!surf) continue;
    const isWater = surf === "water";
    for (let i = g.firstIndex; i < g.firstIndex + g.indexCount; i += 3) {
      const a = idx[i] * stride, b = idx[i + 1] * stride, c = idx[i + 2] * stride;
      const ax = vtx[a], ay = vtx[a + 1], az = vtx[a + 2];
      const bx = vtx[b], by = vtx[b + 1], bz = vtx[b + 2];
      const cx = vtx[c], cy = vtx[c + 1], cz = vtx[c + 2];
      // Face normal z (unnormalised cross product of the edges).
      const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az;
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-6) continue;
      // Floors face up; water surfaces count whichever way they face (the underside is drawn too).
      if (!isWater && nz / len < 0.6) continue;
      if (isWater && Math.abs(nz / len) < 0.6) continue;
      const t = triSurface.length;
      tris.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      triSurface.push(SURFACES.indexOf(surf));
      add(isWater ? water : cells, t, Math.min(ax, bx, cx), Math.min(ay, by, cy), Math.max(ax, bx, cx), Math.max(ay, by, cy));
    }
  }
  const pack = (m: Map<number, number[]>) => new Map([...m].map(([k, v]) => [k, Int32Array.from(v)]));
  current = new Grid(pack(cells), pack(water), Float32Array.from(tris), Int8Array.from(triSurface));
  console.info(`audio: surface map ${triSurface.length} triangles, ${cells.size} cells${water.size ? `, water in ${water.size} cells` : ""}, ${(performance.now() - t0).toFixed(0)} ms`);
  return current;
}
