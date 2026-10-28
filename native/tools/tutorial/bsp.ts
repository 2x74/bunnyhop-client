// Minimal Source BSP v20 writer for maps made of axis-aligned box brushes (tools/tutorial).
//
// What a VMF -> vbsp -> vvis -> vrad compile would produce, for the geometry this needs (boxes only):
//   - planes in +/- pairs (even = +axis), brushes + 6 brush sides each (CM collision, exactly like vbsp's boxes)
//   - an axis-aligned BSP tree (kd-split on brush face planes) whose leaves are either inside one brush (solid,
//     listing the brushes they overlap) or empty; empty leaves that can't be reached from the seed points are the
//     outside and are filled solid, like vbsp's FillOutside
//   - faces only where an inside empty leaf meets a brush (hidden faces are never emitted), assigned to the node whose
//     plane they lie on (dface onNode = 1, nodes' firstface / numfaces), merged into rectangles, chopped on a 512 grid
//     so no lightmap exceeds 32 luxels, T-junctions fixed (vertices added along edges), shared edges / surfedges
//   - texinfo with Hammer's world-aligned axes, texdata + string table (stock materials, sizes given by the caller)
//   - lightmaps baked here (sun with shadows, sky light with occlusion, a constant bounce) as LDR ColorRGBExp32, one
//     style; per-leaf ambient cubes (LUMP_LEAF_AMBIENT_INDEX / _LIGHTING v1) and the light_environment world lights
//     so models are lit in the real engine
//   - one PVS cluster (everything visible; small map), areas [0, 1], an empty area portal, occlusion v2, an empty
//     static prop game lump, an empty pakfile, vertex normals, leaf min-dist-to-water, face macro texture info
//   - brush entities (triggers) as their own models in local coordinates with an "origin" key, like vbsp
//   - optional (tools/meadow): displacements (terrain and round shapes: dispinfo / disp verts / disp tris, lit over the
//     displaced surface with shadows from boxes and displacement triangles), box faces with their texture anchored to
//     the box, per-material lightmap density, brush entities lit in world space, and files packed into the pakfile
// Not written: physcollide (the server's world physics object is optional, see research/TUTORIAL.md), HDR lighting,
// cubemaps, overlays, static props, visibility beyond one cluster, displacement neighbours.

export type Vec3 = [number, number, number];

export const CONTENTS_SOLID = 0x1;
export const SURF_SKY2D = 0x2;
export const SURF_SKY = 0x4;
export const SURF_TRIGGER = 0x40;
export const SURF_NODRAW = 0x80;
export const SURF_NOLIGHT = 0x400;
const LEAF_FLAGS_SKY2D = 0x4;
const CHOP = 512;

export interface Material {
  /** Texture size in pixels (texdata width / height: UVs are texels / size). */
  width: number;
  height: number;
  /** Average colour (texdata reflectivity). */
  reflectivity: Vec3;
  /** Texinfo flags (sky, trigger, nodraw, nolight). */
  flags?: number;
  /** World units per texel (Hammer's texture scale; default 0.25). */
  scale?: number;
  /** World units per luxel on faces with this material (default: the map's `lighting.luxel`). */
  luxel?: number;
  /** Sky visibility rays per luxel on displacements with this material (default: the map's `lighting.skyRays`), and on
   * brush faces in maps with lights. */
  skyRays?: number;
  /** Fill light on faces with this material, instead of the map's `lighting.bounce` (maps with lights). */
  ambient?: Vec3;
  /** Brush entities and displacements made of this material cast no shadows (water surfaces, glass). */
  noShadow?: boolean;
  /** Box faces of this material merge across the 512 chop lines up to this size (a multiple of 512; lit materials
   * need luxel >= chop / 32): fewer faces and vertices on big walls. */
  chop?: number;
}

/** Material per face of a box: one name, or per direction (px = +X face, nz = bottom, ...). */
export type FaceTex =
  | string
  | { all?: string; top?: string; bottom?: string; sides?: string; px?: string; nx?: string; py?: string; ny?: string };

export interface Box {
  min: Vec3;
  max: Vec3;
  tex: FaceTex;
  contents?: number;
  /** Texture origin at each face's corner (its smallest s and t) instead of the world origin. */
  anchor?: boolean;
}

/**
 * A displacement: an axis-aligned base quad (on plane `axis` = `dist`, facing `sign`, spanning u0..u1 / w0..w1 on the
 * other two axes in (axis+1)%3, (axis+2)%3 order) whose (2^power + 1)^2 grid of points is moved to `shape(flat)`.
 * Texture coordinates come from the flat quad (as in Source); `alpha` (0-255) blends to the material's $basetexture2.
 */
export interface Displacement {
  axis: 0 | 1 | 2;
  sign: 1 | -1;
  dist: number;
  u0: number;
  u1: number;
  w0: number;
  w1: number;
  power: 2 | 3 | 4;
  material: string;
  /** Texture origin at the quad's corner (like Box.anchor). */
  anchor?: boolean;
  /** Collision contents (default solid; 0 = decoration the player passes through). */
  contents?: number;
  shape: (flat: Vec3) => { p: Vec3; n: Vec3; alpha?: number };
}

export interface BrushEntity {
  keys: Record<string, string>;
  boxes: Box[];
  /** The model's origin (what func_rotating turns about); default: the centre of its boxes. */
  origin?: Vec3;
}

/**
 * A convex world brush with any planes (ramps, slides, sculpture): inside is n·p <= d for every side (n unit, pointing
 * out). It collides like any brush (with vbsp-style bevels) and draws its visible sides, but it isn't part of the
 * tree: it doesn't seal space or split leaves, so keep it inside the open space.
 */
export interface Solid {
  sides: { n: Vec3; d: number; tex: string }[];
  contents?: number;
}

export interface Lighting {
  /** Direction the sunlight travels (unit vector, pointing down). */
  sunDir: Vec3;
  /** Sun colour/intensity (linear, 1 = full brightness on a surface facing the sun). */
  sun: Vec3;
  /** Sky light from the whole visible sky hemisphere. */
  sky: Vec3;
  /** Constant bounce light (no surface is darker than this). */
  bounce: Vec3;
  /** World units per luxel. */
  luxel: number;
  /** Sky visibility rays per luxel. */
  skyRays: number;
  /** Lamps (tools/backrooms): lit with shadows on brush faces and displacements. */
  lights?: Light[];
}

/** A lamp: `color` is the light it puts on a surface facing it from 100 units away, fading to nothing at `range`. */
export interface Light {
  pos: Vec3;
  color: Vec3;
  range: number;
  /** 0 = shines every way; 1 = a ceiling panel, shining down (cosine). */
  down?: number;
}

export interface MapSource {
  worldspawn: Record<string, string>;
  boxes: Box[];
  brushEntities: BrushEntity[];
  points: Record<string, string>[];
  materials: Record<string, Material>;
  lighting: Lighting;
  /** Points inside the playable space: empty space not connected to them is the outside (filled solid). */
  seeds: Vec3[];
  displacements?: Displacement[];
  /** Convex world brushes with any planes. */
  solids?: Solid[];
  /** Files for the pakfile (game paths like materials/x.vmt), stored uncompressed in this order. */
  pak?: { path: string; data: Uint8Array }[];
}

export interface BuildStats {
  planes: number;
  brushes: number;
  nodes: number;
  leafs: number;
  faces: number;
  luxels: number;
  bytes: number;
  outsideLeafs: number;
}

// ------------------------------------------------------------------------------------------------- geometry helpers

export interface AABB {
  min: Vec3;
  max: Vec3;
}

const overlaps = (a: AABB, b: AABB) =>
  a.min[0] < b.max[0] &&
  a.max[0] > b.min[0] &&
  a.min[1] < b.max[1] &&
  a.max[1] > b.min[1] &&
  a.min[2] < b.max[2] &&
  a.max[2] > b.min[2];
const covers = (b: AABB, r: AABB) =>
  b.min[0] <= r.min[0] &&
  b.max[0] >= r.max[0] &&
  b.min[1] <= r.min[1] &&
  b.max[1] >= r.max[1] &&
  b.min[2] <= r.min[2] &&
  b.max[2] >= r.max[2];

/** Material of a box's face on axis `a` facing `sign`. */
function faceMaterial(tex: FaceTex, a: number, sign: 1 | -1): string {
  if (typeof tex === "string") return tex;
  const dir = (["x", "y", "z"] as const)[a];
  const key = `${sign > 0 ? "p" : "n"}${dir}` as "px";
  const m = tex[key] ?? (a === 2 ? (sign > 0 ? tex.top : tex.bottom) : tex.sides) ?? tex.all;
  if (!m) throw new Error(`no material for face ${key}`);
  return m;
}

// ------------------------------------------------------------------------------------------------- BSP tree

type TreeNode = { leaf: false; axis: 0 | 1 | 2; dist: number; front: Tree; back: Tree; region: AABB; index?: number };
type TreeLeaf = {
  leaf: true;
  region: AABB;
  brushes: number[];
  solid: boolean;
  contents: number;
  inside: boolean;
  index?: number;
};
type Tree = TreeNode | TreeLeaf;

function buildTree(boxes: readonly AABB[], contents: readonly number[], region: AABB, cand: number[]): Tree {
  const inRegion = cand.filter((i) => overlaps(boxes[i], region));
  if (!inRegion.length) return { leaf: true, region, brushes: [], solid: false, contents: 0, inside: false };
  const covering = inRegion.filter((i) => covers(boxes[i], region));
  if (covering.length) {
    return {
      leaf: true,
      region,
      brushes: inRegion,
      solid: true,
      contents: covering.reduce((c, i) => c | contents[i], 0),
      inside: false,
    };
  }
  // Split on the brush face plane (strictly inside the region) that splits the fewest brushes, then balances.
  let best: { axis: 0 | 1 | 2; dist: number; score: number } | null = null;
  for (const axis of [0, 1, 2] as const) {
    const mins = inRegion.map((i) => boxes[i].min[axis]).sort((x, y) => x - y);
    const maxs = inRegion.map((i) => boxes[i].max[axis]).sort((x, y) => x - y);
    const values = new Set<number>();
    for (const i of inRegion) {
      for (const v of [boxes[i].min[axis], boxes[i].max[axis]])
        if (v > region.min[axis] && v < region.max[axis]) values.add(v);
    }
    for (const v of values) {
      const back = upperBound(maxs, v); // max <= v
      const front = mins.length - lowerBound(mins, v); // min >= v
      const split = inRegion.length - back - front;
      // Prefer big separating planes (walls, floors) and balanced halves; mild preference for the region's long axis.
      const extent = region.max[axis] - region.min[axis];
      const score = split * 4 + Math.abs(front - back) - extent / 65536;
      if (!best || score < best.score) best = { axis, dist: v, score };
    }
  }
  if (!best) throw new Error("tree: no split plane (overlapping region without a covering brush)");
  const { axis, dist } = best;
  const backR: AABB = { min: [...region.min] as Vec3, max: [...region.max] as Vec3 };
  const frontR: AABB = { min: [...region.min] as Vec3, max: [...region.max] as Vec3 };
  backR.max[axis] = dist;
  frontR.min[axis] = dist;
  return {
    leaf: false,
    axis,
    dist,
    region,
    front: buildTree(boxes, contents, frontR, inRegion),
    back: buildTree(boxes, contents, backR, inRegion),
  };
}

function lowerBound(a: number[], v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}
function upperBound(a: number[], v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] <= v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function leaves(t: Tree, out: TreeLeaf[] = []): TreeLeaf[] {
  if (t.leaf) out.push(t);
  else {
    leaves(t.front, out);
    leaves(t.back, out);
  }
  return out;
}
function nodes(t: Tree, out: TreeNode[] = []): TreeNode[] {
  if (!t.leaf) {
    out.push(t);
    nodes(t.front, out);
    nodes(t.back, out);
  }
  return out;
}

function leafAt(t: Tree, p: readonly number[]): TreeLeaf {
  while (!t.leaf) t = p[t.axis] > t.dist ? t.front : t.back;
  return t;
}

/** Leaves whose region overlaps `box` with positive volume. */
function leavesIn(t: Tree, box: AABB, out: TreeLeaf[] = []): TreeLeaf[] {
  if (t.leaf) {
    if (overlaps(t.region, box)) out.push(t);
    return out;
  }
  if (box.max[t.axis] > t.dist) leavesIn(t.front, box, out);
  if (box.min[t.axis] < t.dist) leavesIn(t.back, box, out);
  return out;
}

/** vbsp's FillOutside: empty leaves not connected (through shared faces) to a seed point become solid. */
function fillOutside(tree: Tree, seeds: readonly Vec3[]): number {
  const empty = leaves(tree).filter((l) => !l.solid);
  const id = new Map(empty.map((l, i) => [l, i]));
  const adj: number[][] = empty.map(() => []);
  for (let i = 0; i < empty.length; i++) {
    const a = empty[i].region;
    for (let j = i + 1; j < empty.length; j++) {
      const b = empty[j].region;
      let touch = -1;
      let ok = true;
      for (let k = 0; k < 3 && ok; k++) {
        if (a.max[k] === b.min[k] || b.max[k] === a.min[k]) {
          if (touch >= 0) ok = false;
          else touch = k;
        } else if (!(a.min[k] < b.max[k] && a.max[k] > b.min[k])) ok = false;
      }
      if (ok && touch >= 0) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }
  const seen = new Uint8Array(empty.length);
  const queue: number[] = [];
  for (const s of seeds) {
    const l = leafAt(tree, s);
    if (l.solid) throw new Error(`seed ${s.join(" ")} is inside a brush`);
    const i = id.get(l)!;
    if (!seen[i]) ((seen[i] = 1), queue.push(i));
  }
  while (queue.length) {
    const i = queue.pop()!;
    for (const j of adj[i]) if (!seen[j]) ((seen[j] = 1), queue.push(j));
  }
  const root = tree.region;
  empty.forEach((l, i) => {
    if (!seen[i]) return;
    for (let k = 0; k < 3; k++) {
      if (l.region.min[k] <= root.min[k] || l.region.max[k] >= root.max[k]) {
        throw new Error(
          `leak: the playable space reaches the map's outer bounds near ${l.region.min.join(" ")} .. ${l.region.max.join(" ")}`,
        );
      }
    }
  });
  let outside = 0;
  empty.forEach((l, i) => {
    if (seen[i]) l.inside = true;
    else {
      l.solid = true;
      l.contents = CONTENTS_SOLID;
      outside++;
    }
  });
  return outside;
}

// ------------------------------------------------------------------------------------------------- faces

interface RectFace {
  axis: 0 | 1 | 2;
  sign: 1 | -1;
  dist: number;
  /** Range on the two other axes ((axis+1)%3, (axis+2)%3). */
  u0: number;
  u1: number;
  w0: number;
  w1: number;
  material: string;
  node: TreeNode;
  /** The box whose face this is, when that box anchors its texture (Box.anchor). */
  anchorBox?: number;
}

/**
 * Faces on one node's plane, inside its region: wherever one side is an inside (reachable) empty leaf and the other a
 * brush whose face lies on this plane. Cells between every brush edge, then merged into rectangles.
 */
function nodeFaces(
  tree: Tree,
  node: TreeNode,
  boxes: readonly Box[],
  isOpen: (l: TreeLeaf) => boolean,
  chopOf?: (material: string) => number,
): RectFace[] {
  const a = node.axis;
  const ua = ((a + 1) % 3) as 0 | 1 | 2;
  const wa = ((a + 2) % 3) as 0 | 1 | 2;
  const r = node.region;
  const v = node.dist;
  const us = new Set([r.min[ua], r.max[ua]]);
  const ws = new Set([r.min[wa], r.max[wa]]);
  const touching: number[] = [];
  boxes.forEach((b, i) => {
    if (b.min[a] > v || b.max[a] < v) return;
    if (b.min[ua] >= r.max[ua] || b.max[ua] <= r.min[ua] || b.min[wa] >= r.max[wa] || b.max[wa] <= r.min[wa]) return;
    touching.push(i);
    for (const x of [b.min[ua], b.max[ua]]) if (x > r.min[ua] && x < r.max[ua]) us.add(x);
    for (const x of [b.min[wa], b.max[wa]]) if (x > r.min[wa] && x < r.max[wa]) ws.add(x);
  });
  // Lightmap chop lines.
  for (let x = Math.ceil(r.min[ua] / CHOP) * CHOP; x < r.max[ua]; x += CHOP) if (x > r.min[ua]) us.add(x);
  for (let x = Math.ceil(r.min[wa] / CHOP) * CHOP; x < r.max[wa]; x += CHOP) if (x > r.min[wa]) ws.add(x);
  const U = [...us].sort((x, y) => x - y);
  const W = [...ws].sort((x, y) => x - y);
  const nu = U.length - 1;
  const nw = W.length - 1;
  const label: (string | null)[] = new Array(nu * nw).fill(null);
  const p: number[] = [0, 0, 0];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nw; j++) {
      const cu = (U[i] + U[i + 1]) / 2;
      const cw = (W[j] + W[j + 1]) / 2;
      p[ua] = cu;
      p[wa] = cw;
      p[a] = v + 0.25;
      const front = leafAt(tree, p);
      p[a] = v - 0.25;
      const back = leafAt(tree, p);
      const fOpen = isOpen(front);
      const bOpen = isOpen(back);
      if (fOpen === bOpen) continue;
      // The solid side's brush with its face on this plane, covering the cell.
      const sign: 1 | -1 = fOpen ? 1 : -1;
      const bi = touching.find((k) => {
        const b = boxes[k];
        return (
          (sign > 0 ? b.max[a] === v : b.min[a] === v) &&
          b.min[ua] < cu &&
          b.max[ua] > cu &&
          b.min[wa] < cw &&
          b.max[wa] > cw
        );
      });
      if (bi === undefined) continue; // open space against the outside fill: never visible
      label[i * nw + j] = `${sign}|${faceMaterial(boxes[bi].tex, a, sign)}${boxes[bi].anchor ? `|${bi}` : ""}`;
    }
  }
  // Greedy rectangle merge (never across a chop line: every 512, or the material's own `chop`).
  const chopU = new Set(U.filter((x) => x % CHOP === 0));
  const chopW = new Set(W.filter((x) => x % CHOP === 0));
  const cuts = (set: Set<number>, x: number, k: string) =>
    set.has(x) && (chopOf === undefined || x % chopOf(k.split("|")[1]) === 0);
  const out: RectFace[] = [];
  const used = new Uint8Array(nu * nw);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nw; j++) {
      const k = label[i * nw + j];
      if (!k || used[i * nw + j]) continue;
      let j1 = j + 1;
      while (j1 < nw && !cuts(chopW, W[j1], k) && label[i * nw + j1] === k && !used[i * nw + j1]) j1++;
      let i1 = i + 1;
      grow: while (i1 < nu && !cuts(chopU, U[i1], k)) {
        for (let jj = j; jj < j1; jj++) if (label[i1 * nw + jj] !== k || used[i1 * nw + jj]) break grow;
        i1++;
      }
      for (let ii = i; ii < i1; ii++) for (let jj = j; jj < j1; jj++) used[ii * nw + jj] = 1;
      const [s, material, anchor] = k.split("|");
      const f: RectFace = {
        axis: a,
        sign: Number(s) as 1 | -1,
        dist: v,
        u0: U[i],
        u1: U[i1],
        w0: W[j],
        w1: W[j1],
        material,
        node,
      };
      if (anchor !== undefined) f.anchorBox = Number(anchor);
      out.push(f);
    }
  }
  return out;
}

/** Corners of a rect face, clockwise seen from the front (Source winding). */
function corners(f: RectFace): Vec3[] {
  const a = f.axis;
  const ua = (a + 1) % 3;
  const wa = (a + 2) % 3;
  const pt = (u: number, w: number): Vec3 => {
    const p: Vec3 = [0, 0, 0];
    p[a] = f.dist;
    p[ua] = u;
    p[wa] = w;
    return p;
  };
  // (u0,w0) (u1,w0) (u1,w1) (u0,w1) is counter-clockwise seen from +axis.
  return f.sign > 0
    ? [pt(f.u0, f.w0), pt(f.u0, f.w1), pt(f.u1, f.w1), pt(f.u1, f.w0)]
    : [pt(f.u0, f.w0), pt(f.u1, f.w0), pt(f.u1, f.w1), pt(f.u0, f.w1)];
}

/** Adds every known vertex lying strictly inside an edge (T-junction fix, like vbsp's FixTjuncs). */
function fixTJunctions(polys: Vec3[][]): Vec3[][] {
  const lines = new Map<string, number[]>();
  const key = (k: number, p: readonly number[]) => `${k}|${p[(k + 1) % 3]}|${p[(k + 2) % 3]}`;
  for (const poly of polys)
    for (const p of poly)
      for (let k = 0; k < 3; k++) {
        const kk = key(k, p);
        let l = lines.get(kk);
        if (!l) lines.set(kk, (l = []));
        l.push(p[k]);
      }
  for (const l of lines.values()) l.sort((x, y) => x - y);
  return polys.map((poly) => {
    const out: Vec3[] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      out.push(p);
      const k = [0, 1, 2].find((c) => p[c] !== q[c])!;
      const line = lines.get(key(k, p)) ?? [];
      const lo = Math.min(p[k], q[k]);
      const hi = Math.max(p[k], q[k]);
      const mid = [...new Set(line.filter((x) => x > lo && x < hi))];
      mid.sort((x, y) => (p[k] < q[k] ? x - y : y - x));
      for (const x of mid) {
        const n: Vec3 = [...p] as Vec3;
        n[k] = x;
        out.push(n);
      }
    }
    return out;
  });
}

// ------------------------------------------------------------------------------------------------- lighting

interface Bvh {
  min: Vec3;
  max: Vec3;
  left?: Bvh;
  right?: Bvh;
  items?: number[];
}

function buildBvh(boxes: readonly AABB[], items: number[]): Bvh {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const i of items)
    for (let k = 0; k < 3; k++)
      ((min[k] = Math.min(min[k], boxes[i].min[k])), (max[k] = Math.max(max[k], boxes[i].max[k])));
  if (items.length <= 4) return { min, max, items };
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const k = ext.indexOf(Math.max(...ext));
  const sorted = [...items].sort((x, y) => boxes[x].min[k] + boxes[x].max[k] - boxes[y].min[k] - boxes[y].max[k]);
  const h = sorted.length >> 1;
  return { min, max, left: buildBvh(boxes, sorted.slice(0, h)), right: buildBvh(boxes, sorted.slice(h)) };
}

/** Slab test: entry distance of a ray into a box (Infinity = miss). */
function rayBox(o: Vec3, inv: Vec3, b: AABB, tmax: number): number {
  let t0 = 0;
  let t1 = tmax;
  for (let k = 0; k < 3; k++) {
    let a = (b.min[k] - o[k]) * inv[k];
    let c = (b.max[k] - o[k]) * inv[k];
    if (a > c) [a, c] = [c, a];
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return Infinity;
  }
  return t0;
}

class RayCaster {
  private bvh: Bvh;
  constructor(
    private boxes: readonly AABB[],
    private sky: readonly boolean[],
  ) {
    this.bvh = buildBvh(
      boxes,
      boxes.map((_, i) => i),
    );
  }
  /** Index of the first box hit, or -1. */
  first(o: Vec3, d: Vec3, tmax = 65536): number {
    const inv: Vec3 = [1 / d[0], 1 / d[1], 1 / d[2]];
    let best = tmax;
    let hit = -1;
    const stack: Bvh[] = [this.bvh];
    while (stack.length) {
      const n = stack.pop()!;
      if (rayBox(o, inv, n, best) === Infinity) continue;
      if (n.items) {
        for (const i of n.items) {
          const t = rayBox(o, inv, this.boxes[i], best);
          if (t < best) ((best = t), (hit = i));
        }
      } else stack.push(n.left!, n.right!);
    }
    return hit;
  }
  /** True if a ray reaches the sky (its first hit is a sky brush, or nothing). */
  seesSky(o: Vec3, d: Vec3): boolean {
    const i = this.first(o, d);
    return i < 0 || this.sky[i];
  }
  /** Anything between o and dist along d. */
  blocked(o: Vec3, d: Vec3, dist: number): boolean {
    return this.first(o, d, dist) >= 0;
  }
}

/**
 * Ray caster over boxes and triangles (maps with displacements): one flat BVH, any hit. Same contract as RayCaster (a
 * ray sees the sky when its first hit is a sky box, or nothing), relying on the sky boxes enclosing the map: sky boxes
 * are left out and a ray sees the sky when it hits nothing else.
 */
export class SceneCaster {
  private nodeMin: Float64Array;
  private nodeMax: Float64Array;
  /** Per node: first item (leaf) or right child (inner, left child = node + 1). */
  private nodeA: Int32Array;
  /** Per node: item count (leaf) or 0 (inner). */
  private nodeN: Int32Array;
  private order: Int32Array;
  private stack = new Int32Array(256);
  private boxes: readonly AABB[];
  constructor(
    allBoxes: readonly AABB[],
    sky: readonly boolean[],
    /** Triangles: 9 floats each (v0, v1, v2). */
    private tris: Float64Array,
  ) {
    const boxes = allBoxes.filter((_, i) => !sky[i]);
    this.boxes = boxes;
    const nb = boxes.length;
    const n = nb + tris.length / 9;
    const lo = new Float64Array(n * 3);
    const hi = new Float64Array(n * 3);
    const c = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        let a: number;
        let b: number;
        if (i < nb) {
          a = boxes[i].min[k];
          b = boxes[i].max[k];
        } else {
          const t = (i - nb) * 9;
          a = Math.min(tris[t + k], tris[t + 3 + k], tris[t + 6 + k]);
          b = Math.max(tris[t + k], tris[t + 3 + k], tris[t + 6 + k]);
        }
        lo[i * 3 + k] = a;
        hi[i * 3 + k] = b;
        c[i * 3 + k] = (a + b) / 2;
      }
    }
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const nodeMin: number[] = [];
    const nodeMax: number[] = [];
    const nodeA: number[] = [];
    const nodeN: number[] = [];
    const build = (from: number, to: number): number => {
      const id = nodeA.length;
      const mn = [Infinity, Infinity, Infinity];
      const mx = [-Infinity, -Infinity, -Infinity];
      for (let i = from; i < to; i++) {
        const it = order[i];
        for (let k = 0; k < 3; k++) {
          if (lo[it * 3 + k] < mn[k]) mn[k] = lo[it * 3 + k];
          if (hi[it * 3 + k] > mx[k]) mx[k] = hi[it * 3 + k];
        }
      }
      nodeMin.push(...mn);
      nodeMax.push(...mx);
      nodeA.push(0);
      nodeN.push(0);
      if (to - from <= 4) {
        nodeA[id] = from;
        nodeN[id] = to - from;
        return id;
      }
      // Split at the centroid median on the longest centroid axis.
      const cmn = [Infinity, Infinity, Infinity];
      const cmx = [-Infinity, -Infinity, -Infinity];
      for (let i = from; i < to; i++)
        for (let k = 0; k < 3; k++)
          ((cmn[k] = Math.min(cmn[k], c[order[i] * 3 + k])), (cmx[k] = Math.max(cmx[k], c[order[i] * 3 + k])));
      const ext = [cmx[0] - cmn[0], cmx[1] - cmn[1], cmx[2] - cmn[2]];
      const axis = ext.indexOf(Math.max(...ext));
      const part = Array.from(order.subarray(from, to)).sort((x, y) => c[x * 3 + axis] - c[y * 3 + axis] || x - y);
      order.set(part, from);
      const mid = (from + to) >> 1;
      build(from, mid);
      nodeA[id] = build(mid, to);
      return id;
    };
    build(0, n);
    this.nodeMin = Float64Array.from(nodeMin);
    this.nodeMax = Float64Array.from(nodeMax);
    this.nodeA = Int32Array.from(nodeA);
    this.nodeN = Int32Array.from(nodeN);
    this.order = order;
  }
  /** True if the ray hits anything (within tmax). */
  occluded(o: Vec3, d: Vec3, tmax = 65536): boolean {
    const ix = 1 / d[0];
    const iy = 1 / d[1];
    const iz = 1 / d[2];
    const best = tmax;
    const inv: Vec3 = [ix, iy, iz];
    const nb = this.boxes.length;
    const tris = this.tris;
    let sp = 0;
    const stack = this.stack;
    stack[sp++] = 0;
    while (sp) {
      const node = stack[--sp];
      // Slab test against the node bounds.
      let t0 = 0;
      let t1 = best;
      let a = (this.nodeMin[node * 3] - o[0]) * ix;
      let b = (this.nodeMax[node * 3] - o[0]) * ix;
      if (a > b) [a, b] = [b, a];
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) continue;
      a = (this.nodeMin[node * 3 + 1] - o[1]) * iy;
      b = (this.nodeMax[node * 3 + 1] - o[1]) * iy;
      if (a > b) [a, b] = [b, a];
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) continue;
      a = (this.nodeMin[node * 3 + 2] - o[2]) * iz;
      b = (this.nodeMax[node * 3 + 2] - o[2]) * iz;
      if (a > b) [a, b] = [b, a];
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) continue;
      const count = this.nodeN[node];
      if (count === 0) {
        stack[sp++] = this.nodeA[node];
        stack[sp++] = node + 1;
        continue;
      }
      for (let k = this.nodeA[node], end = k + count; k < end; k++) {
        const it = this.order[k];
        if (it < nb) {
          if (rayBox(o, inv, this.boxes[it], best) < best) return true;
          continue;
        }
        // Moller-Trumbore, both sides.
        const q = (it - nb) * 9;
        const e1x = tris[q + 3] - tris[q];
        const e1y = tris[q + 4] - tris[q + 1];
        const e1z = tris[q + 5] - tris[q + 2];
        const e2x = tris[q + 6] - tris[q];
        const e2y = tris[q + 7] - tris[q + 1];
        const e2z = tris[q + 8] - tris[q + 2];
        const px = d[1] * e2z - d[2] * e2y;
        const py = d[2] * e2x - d[0] * e2z;
        const pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-9 && det < 1e-9) continue;
        const invDet = 1 / det;
        const sx = o[0] - tris[q];
        const sy = o[1] - tris[q + 1];
        const sz = o[2] - tris[q + 2];
        const u = (sx * px + sy * py + sz * pz) * invDet;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y;
        const qy = sz * e1x - sx * e1z;
        const qz = sx * e1y - sy * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) * invDet;
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
        if (t > 1e-3 && t < best) return true;
      }
    }
    return false;
  }
  /** Anything between o and dist along d. */
  blocked(o: Vec3, d: Vec3, dist: number): boolean {
    return this.occluded(o, d, dist);
  }
  /** Occluders further than 8192 units are ignored (they'd cost the most and change the light the least). */
  seesSky(o: Vec3, d: Vec3): boolean {
    return !this.occluded(o, d, 8192);
  }
}

/** Source displacement triangulation (alternating diagonals), as vertex index triples into the (side x side) grid. */
function dispTriangles(side: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let a = 0; a < side - 1; a++) {
    for (let b = 0; b < side - 1; b++) {
      const i = a * side + b;
      if (i % 2 === 1) out.push([i, i + side, i + 1], [i + 1, i + side, i + side + 1]);
      else out.push([i, i + side, i + side + 1], [i, i + side + 1, i + 1]);
    }
  }
  return out;
}

/** CRC-32 (zip). */
function crc32(data: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Cosine-weighted hemisphere directions around +Z (Fibonacci spiral), rotated per face normal. */
function hemisphere(n: number): Vec3[] {
  const out: Vec3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n);
    const phi = i * golden;
    out.push([r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(Math.max(0, 1 - r * r))]);
  }
  return out;
}

/** Source ColorRGBExp32: c * 2^exp / 255 = linear value. */
function rgbExp(c: Vec3): [number, number, number, number] {
  const m = Math.max(c[0], c[1], c[2]);
  if (!(m > 1e-6)) return [0, 0, 0, 0];
  let e = Math.ceil(Math.log2(m));
  e = Math.max(-128, Math.min(127, e));
  const s = 255 / 2 ** e;
  return [
    Math.min(255, Math.round(c[0] * s)),
    Math.min(255, Math.round(c[1] * s)),
    Math.min(255, Math.round(c[2] * s)),
    e,
  ];
}

// ------------------------------------------------------------------------------------------------- binary writer

class Buf {
  private b = new Uint8Array(1 << 16);
  private v = new DataView(this.b.buffer);
  len = 0;
  private need(n: number) {
    if (this.len + n <= this.b.length) return;
    let size = this.b.length * 2;
    while (size < this.len + n) size *= 2;
    const nb = new Uint8Array(size);
    nb.set(this.b.subarray(0, this.len));
    this.b = nb;
    this.v = new DataView(nb.buffer);
  }
  i32(x: number) {
    this.need(4);
    this.v.setInt32(this.len, x, true);
    this.len += 4;
  }
  u32(x: number) {
    this.need(4);
    this.v.setUint32(this.len, x >>> 0, true);
    this.len += 4;
  }
  i16(x: number) {
    this.need(2);
    this.v.setInt16(this.len, x, true);
    this.len += 2;
  }
  u16(x: number) {
    this.need(2);
    this.v.setUint16(this.len, x, true);
    this.len += 2;
  }
  u8(x: number) {
    this.need(1);
    this.v.setUint8(this.len, x & 255);
    this.len += 1;
  }
  i8(x: number) {
    this.need(1);
    this.v.setInt8(this.len, x);
    this.len += 1;
  }
  f32(x: number) {
    this.need(4);
    this.v.setFloat32(this.len, x, true);
    this.len += 4;
  }
  vec(p: readonly number[]) {
    for (const x of p) this.f32(x);
  }
  bytes(u: Uint8Array) {
    this.need(u.length);
    this.b.set(u, this.len);
    this.len += u.length;
  }
  out(): Uint8Array {
    return this.b.slice(0, this.len);
  }
}

const clampShort = (x: number) => Math.max(-32768, Math.min(32767, Math.round(x)));

// ------------------------------------------------------------------------------------------------- the compile

interface OutFace {
  plane: number;
  poly: Vec3[];
  texinfo: number;
  material: string;
  /** Brush faces: the merged rectangle. Displacements: their base quad (node unset). */
  rect: RectFace;
  lit: boolean;
  lightOfs: number;
  lmMins: [number, number];
  lmSize: [number, number];
  /** Displacement faces: index into the dispinfo lump. */
  disp?: number;
  /** Solid faces (any plane): the face normal and area (their `rect` is unused). */
  normal?: Vec3;
  area?: number;
}

const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm3 = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** Snaps coordinates within 1/1000 of an integer (clipped windings land on the grid like Hammer's). */
const snap3 = (p: Vec3): Vec3 => p.map((x) => (Math.abs(x - Math.round(x)) < 1e-3 ? Math.round(x) : x)) as Vec3;

/** Keeps the part of a convex polygon with n·p <= d. */
function clipPoly(poly: Vec3[], n: Vec3, d: number, eps = 1e-4): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = dot3(n, a) - d;
    const db = dot3(n, b) - d;
    if (da <= eps) out.push(a);
    if ((da < -eps && db > eps) || (da > eps && db < -eps)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

/** A solid's sides as windings (clockwise seen from outside, like corners()), its corners, bounds and vbsp-style bevels. */
interface PreparedSolid {
  src: Solid;
  windings: Vec3[][];
  verts: Vec3[];
  min: Vec3;
  max: Vec3;
  /** Extra collision planes (axial bounds, edge bevels), flagged as bevels. */
  bevels: { n: Vec3; d: number }[];
}

function prepareSolid(s: Solid): PreparedSolid {
  const BIG = 1 << 16;
  const windings = s.sides.map((side, i) => {
    const n = side.n;
    // A big square on the side's plane, wound clockwise seen from outside (as corners()), clipped by the rest.
    const u = norm3(cross3(Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], n));
    const v = cross3(n, u);
    const c: Vec3 = [n[0] * side.d, n[1] * side.d, n[2] * side.d];
    const at = (a: number, b: number): Vec3 => [
      c[0] + u[0] * a + v[0] * b,
      c[1] + u[1] * a + v[1] * b,
      c[2] + u[2] * a + v[2] * b,
    ];
    let w = [at(-BIG, -BIG), at(-BIG, BIG), at(BIG, BIG), at(BIG, -BIG)];
    s.sides.forEach((o, k) => {
      if (k !== i && w.length) w = clipPoly(w, o.n, o.d);
    });
    return w.map(snap3);
  });
  const verts: Vec3[] = [];
  for (const w of windings)
    for (const p of w) if (!verts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-3)) verts.push(p);
  if (verts.length < 4) throw new Error("solid has no volume");
  const min: Vec3 = [0, 1, 2].map((k) => Math.min(...verts.map((p) => p[k]))) as Vec3;
  const max: Vec3 = [0, 1, 2].map((k) => Math.max(...verts.map((p) => p[k]))) as Vec3;
  const has = (n: Vec3, d: number, list: { n: Vec3; d: number }[]) =>
    list.some((p) => Math.abs(dot3(p.n, n) - 1) < 1e-6 && Math.abs(p.d - d) < 1e-3);
  const planes: { n: Vec3; d: number }[] = s.sides.map((x) => ({ n: x.n, d: x.d }));
  const bevels: { n: Vec3; d: number }[] = [];
  // Axial bevels: the bounds (vbsp AddBrushBevels).
  for (let k = 0; k < 3; k++) {
    for (const sg of [-1, 1]) {
      const n: Vec3 = [0, 0, 0];
      n[k] = sg;
      const d = sg > 0 ? max[k] : -min[k];
      if (!has(n, d, planes) && !has(n, d, bevels)) bevels.push({ n, d });
    }
  }
  // Edge bevels: planes through each edge and an axis that keep the whole brush behind them.
  for (const w of windings) {
    for (let i = 0; i < w.length; i++) {
      const a = w[i];
      const b = w[(i + 1) % w.length];
      const e: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      if (Math.hypot(...e) < 0.5) continue;
      for (let k = 0; k < 3; k++) {
        for (const sg of [-1, 1]) {
          const ax: Vec3 = [0, 0, 0];
          ax[k] = sg;
          const c = cross3(e, ax);
          const l = Math.hypot(...c);
          if (l < 0.1) continue;
          const n: Vec3 = [c[0] / l, c[1] / l, c[2] / l];
          if (Math.max(Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])) > 0.9999) continue; // axial: covered above
          const d = dot3(n, a);
          if (verts.some((p) => dot3(n, p) - d > 0.1)) continue;
          if (!has(n, d, planes) && !has(n, d, bevels)) bevels.push({ n, d });
        }
      }
    }
  }
  return { src: s, windings, verts, min, max, bevels };
}

/** What displacement luxels are shaded against: shadow-casting boxes (sky flagged) and displacement triangles. */
export interface ShadeScene {
  boxes: AABB[];
  sky: boolean[];
  tris: Float64Array;
}
/** Floats per luxel sample: origin, normal, sky rays, fill light (r, g, b). */
export const SAMPLE = 10;
/** Shades luxel samples (SAMPLE floats each) to linear RGB (3 floats each). */
export type Shader = (scene: ShadeScene, samples: Float64Array, lighting: Lighting) => Float32Array;

/**
 * Fill, sun (with shadows), sky (with occlusion, over the normal's hemisphere) and lamps (with shadows) for luxel
 * samples [from, to).
 */
export function shadeSamples(
  caster: { seesSky(o: Vec3, d: Vec3): boolean; blocked(o: Vec3, d: Vec3, dist: number): boolean },
  samples: Float64Array,
  L: Lighting,
  from = 0,
  to = samples.length / SAMPLE,
  out = new Float32Array((samples.length / SAMPLE) * 3),
): Float32Array {
  const sunTo: Vec3 = [-L.sunDir[0], -L.sunDir[1], -L.sunDir[2]];
  const hemis = new Map<number, Vec3[]>();
  const lights = L.lights ?? [];
  for (let k = from; k < to; k++) {
    const q = k * SAMPLE;
    const o: Vec3 = [samples[q], samples[q + 1], samples[q + 2]];
    const nrm: Vec3 = [samples[q + 3], samples[q + 4], samples[q + 5]];
    const rays = samples[q + 6];
    let hemi = hemis.get(rays);
    if (!hemi) hemis.set(rays, (hemi = hemisphere(rays)));
    let r = samples[q + 7];
    let g = samples[q + 8];
    let bl = samples[q + 9];
    for (const l of lights) {
      const dx = l.pos[0] - o[0];
      const dy = l.pos[1] - o[1];
      const dz = l.pos[2] - o[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= l.range * l.range) continue;
      const dist = Math.sqrt(d2);
      const lx = dx / dist;
      const ly = dy / dist;
      const lz = dz / dist;
      const ndl = nrm[0] * lx + nrm[1] * ly + nrm[2] * lz;
      if (ndl <= 0) continue;
      const down = l.down ?? 0;
      const emit = 1 - down + down * Math.max(0, lz);
      if (emit <= 0) continue;
      const w = 1 - (dist / l.range) ** 4;
      const k2 = (ndl * emit * w * w * 10000) / Math.max(d2, 1024);
      if (caster.blocked(o, [lx, ly, lz], dist - 3)) continue;
      r += l.color[0] * k2;
      g += l.color[1] * k2;
      bl += l.color[2] * k2;
    }
    const sunDot = Math.max(0, nrm[0] * sunTo[0] + nrm[1] * sunTo[1] + nrm[2] * sunTo[2]);
    if (sunDot > 0 && caster.seesSky(o, sunTo)) {
      r += L.sun[0] * sunDot;
      g += L.sun[1] * sunDot;
      bl += L.sun[2] * sunDot;
    }
    // Hemisphere around the surface normal.
    const tA: Vec3 = Math.abs(nrm[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let bx = nrm[1] * tA[2] - nrm[2] * tA[1];
    let by = nrm[2] * tA[0] - nrm[0] * tA[2];
    let bz = nrm[0] * tA[1] - nrm[1] * tA[0];
    const bl2 = Math.hypot(bx, by, bz);
    ((bx /= bl2), (by /= bl2), (bz /= bl2));
    const tx = by * nrm[2] - bz * nrm[1];
    const ty = bz * nrm[0] - bx * nrm[2];
    const tz = bx * nrm[1] - by * nrm[0];
    let vis = 0;
    for (const hh of hemi) {
      const dir: Vec3 = [
        hh[0] * tx + hh[1] * bx + hh[2] * nrm[0],
        hh[0] * ty + hh[1] * by + hh[2] * nrm[1],
        hh[0] * tz + hh[1] * bz + hh[2] * nrm[2],
      ];
      if (caster.seesSky(o, dir)) vis++;
    }
    const sky = hemi.length ? vis / hemi.length : 0;
    out[k * 3] = r + L.sky[0] * sky;
    out[k * 3 + 1] = g + L.sky[1] * sky;
    out[k * 3 + 2] = bl + L.sky[2] * sky;
  }
  return out;
}

export function writeBsp(
  src: MapSource,
  mapRevision = 1,
  log?: (step: string) => void,
  opts?: { shade?: Shader },
): { bsp: Uint8Array; stats: BuildStats } {
  const L = src.lighting;
  // ---- planes (pairs: even = +axis)
  const planes: { n: Vec3; d: number; type: number }[] = [];
  const planeIdx = new Map<string, number>();
  const plane = (axis: number, dist: number, sign: 1 | -1): number => {
    const k = `${axis}|${dist}`;
    let i = planeIdx.get(k);
    if (i === undefined) {
      i = planes.length;
      planeIdx.set(k, i);
      const n: Vec3 = [0, 0, 0];
      n[axis] = 1;
      planes.push({ n, d: dist, type: axis });
      const m: Vec3 = [0, 0, 0];
      m[axis] = -1;
      planes.push({ n: m, d: -dist, type: axis });
    }
    return sign > 0 ? i : i + 1;
  };
  /** Any plane n·p = d (n unit): axial ones share plane(); others pair up with the even one facing its main axis' +. */
  const planeAny = (n: Vec3, d: number): number => {
    for (let k = 0; k < 3; k++)
      if (Math.abs(Math.abs(n[k]) - 1) < 1e-9) return plane(k, n[k] > 0 ? d : -d, n[k] > 0 ? 1 : -1);
    const main = [0, 1, 2].reduce((m, k) => (Math.abs(n[k]) > Math.abs(n[m]) ? k : m), 0);
    const flip = n[main] < 0;
    const pn: Vec3 = flip ? [-n[0], -n[1], -n[2]] : n;
    const pd = flip ? -d : d;
    const k = `${pn.map((x) => x.toFixed(6)).join(",")}|${pd.toFixed(4)}`;
    let i = planeIdx.get(k);
    if (i === undefined) {
      i = planes.length;
      planeIdx.set(k, i);
      planes.push({ n: pn, d: pd, type: 3 + main });
      planes.push({ n: [-pn[0], -pn[1], -pn[2]], d: -pd, type: 3 + main });
    }
    return flip ? i + 1 : i;
  };

  // ---- texdata / texinfo
  const texdataNames: string[] = [];
  const texdataIdx = new Map<string, number>();
  const texdata = (name: string) => {
    let i = texdataIdx.get(name);
    if (i === undefined) {
      if (!src.materials[name]) throw new Error(`unknown material ${name}`);
      i = texdataNames.length;
      texdataIdx.set(name, i);
      texdataNames.push(name);
    }
    return i;
  };
  const texinfos: { s: number[]; t: number[]; ls: number[]; lt: number[]; flags: number; texdata: number }[] = [];
  const texinfoIdx = new Map<string, number>();
  /** Hammer world-aligned axes per face axis: floors s = +X, t = -Y; walls t = -Z. */
  const axesFor = (axis: number): [Vec3, Vec3] =>
    axis === 2
      ? [
          [1, 0, 0],
          [0, -1, 0],
        ]
      : axis === 0
        ? [
            [0, 1, 0],
            [0, 0, -1],
          ]
        : [
            [1, 0, 0],
            [0, 0, -1],
          ];
  const texinfo = (name: string, axis: number, shift?: [number, number]): number => {
    const shifted = !!shift && (shift[0] !== 0 || shift[1] !== 0);
    const k = shifted ? `${name}|${axis}|${shift[0]}|${shift[1]}` : `${name}|${axis}`;
    let i = texinfoIdx.get(k);
    if (i === undefined) {
      const m = src.materials[name];
      if (!m) throw new Error(`unknown material ${name}`);
      const [s, t] = axesFor(axis);
      const sc = 1 / (m.scale ?? 0.25);
      const lm = 1 / (m.luxel ?? L.luxel);
      i = texinfos.length;
      texinfoIdx.set(k, i);
      texinfos.push({
        s: [s[0] * sc, s[1] * sc, s[2] * sc, shifted ? shift[0] : 0],
        t: [t[0] * sc, t[1] * sc, t[2] * sc, shifted ? shift[1] : 0],
        ls: [s[0] * lm, s[1] * lm, s[2] * lm, 0],
        lt: [t[0] * lm, t[1] * lm, t[2] * lm, 0],
        flags: m.flags ?? 0,
        texdata: texdata(name),
      });
    }
    return i;
  };
  /** Texture shift that puts the texture origin at the smallest s / t of the face spanning lo..hi (Box.anchor). */
  const anchorShift = (name: string, axis: number, lo: Vec3, hi: Vec3): [number, number] => {
    const sc = 1 / (src.materials[name].scale ?? 0.25);
    const low = (v: Vec3) => {
      let m = 0;
      for (let k = 0; k < 3; k++) if (v[k] !== 0) m += Math.min(v[k] * lo[k], v[k] * hi[k]);
      return m * sc;
    };
    const [s, t] = axesFor(axis);
    return [-low(s) + 0, -low(t) + 0];
  };
  /** Texture and lightmap axes for a face with normal n: the world-aligned axes of its main axis projected into the
   * plane (Hammer's face alignment), so textures and luxels aren't stretched on slopes. */
  const planeAxes = (n: Vec3): [Vec3, Vec3] => {
    const main = [0, 1, 2].reduce((m, k) => (Math.abs(n[k]) > Math.abs(n[m]) ? k : m), 0);
    const [s0, t0] = axesFor(main);
    const s = norm3([s0[0] - n[0] * dot3(s0, n), s0[1] - n[1] * dot3(s0, n), s0[2] - n[2] * dot3(s0, n)]);
    let t = norm3(cross3(n, s));
    if (dot3(t, t0) < 0) t = [-t[0], -t[1], -t[2]];
    return [s, t];
  };
  const texinfoAny = (name: string, n: Vec3): number => {
    for (let k = 0; k < 3; k++) if (Math.abs(Math.abs(n[k]) - 1) < 1e-9) return texinfo(name, k);
    const [s, t] = planeAxes(n);
    const k = `${name}|${s.map((x) => x.toFixed(6)).join(",")}|${t.map((x) => x.toFixed(6)).join(",")}`;
    let i = texinfoIdx.get(k);
    if (i === undefined) {
      const m = src.materials[name];
      if (!m) throw new Error(`unknown material ${name}`);
      const sc = 1 / (m.scale ?? 0.25);
      const lm = 1 / (m.luxel ?? L.luxel);
      i = texinfos.length;
      texinfoIdx.set(k, i);
      texinfos.push({
        s: [s[0] * sc, s[1] * sc, s[2] * sc, 0],
        t: [t[0] * sc, t[1] * sc, t[2] * sc, 0],
        ls: [s[0] * lm, s[1] * lm, s[2] * lm, 0],
        lt: [t[0] * lm, t[1] * lm, t[2] * lm, 0],
        flags: m.flags ?? 0,
        texdata: texdata(name),
      });
    }
    return i;
  };

  // ---- brushes (world first, then each brush entity's in its local frame)
  interface OutBrush {
    box: Box;
    contents: number;
    /** Solid brushes: sides from the solid (box unused). */
    solid?: PreparedSolid;
  }
  const brushes: OutBrush[] = [];
  const world = src.boxes.map((b) => ({ ...b, contents: b.contents ?? CONTENTS_SOLID }));
  for (const b of world) brushes.push({ box: b, contents: b.contents });
  // Solids come right after the world's boxes (still world brushes).
  const solids = (src.solids ?? []).map(prepareSolid);
  const firstSolid = brushes.length;
  for (const s of solids)
    brushes.push({
      box: { min: s.min, max: s.max, tex: s.src.sides[0].tex },
      contents: s.src.contents ?? CONTENTS_SOLID,
      solid: s,
    });
  const ents = src.brushEntities.map((e) => {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const b of e.boxes)
      for (let k = 0; k < 3; k++) ((min[k] = Math.min(min[k], b.min[k])), (max[k] = Math.max(max[k], b.max[k])));
    const c: Vec3 = e.origin ?? ([0, 1, 2].map((k) => Math.round((min[k] + max[k]) / 2)) as Vec3);
    const local = e.boxes.map((b) => ({
      ...b,
      min: [b.min[0] - c[0], b.min[1] - c[1], b.min[2] - c[2]] as Vec3,
      max: [b.max[0] - c[0], b.max[1] - c[1], b.max[2] - c[2]] as Vec3,
      contents: b.contents ?? CONTENTS_SOLID,
    }));
    const first = brushes.length;
    for (const b of local) brushes.push({ box: b, contents: b.contents });
    return { e, center: c, local, first };
  });

  log?.("trees");
  // ---- trees
  const bounds = (bs: readonly AABB[], pad: number): AABB => {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const b of bs)
      for (let k = 0; k < 3; k++) ((min[k] = Math.min(min[k], b.min[k])), (max[k] = Math.max(max[k], b.max[k])));
    return { min: min.map((x) => x - pad) as Vec3, max: max.map((x) => x + pad) as Vec3 };
  };
  const worldBounds = bounds(world, 0);
  const worldTree = buildTree(
    world,
    world.map((b) => b.contents),
    bounds(world, 64),
    world.map((_, i) => i),
  );
  const outsideLeafs = fillOutside(worldTree, src.seeds);
  const entTrees = ents.map((x) =>
    buildTree(
      x.local,
      x.local.map((b) => b.contents),
      bounds(x.local, 64),
      x.local.map((_, i) => i),
    ),
  );

  log?.("faces");
  // ---- faces per node (world: inside leaves only; brush models: any empty leaf)
  const faceRects: { rect: RectFace; model: number }[] = [];
  const nodeLists: TreeNode[][] = [];
  // Per-material chop sizes (Material.chop), checked against their lightmaps.
  const anyChop = Object.values(src.materials).some((m) => m.chop !== undefined);
  for (const [name, m] of Object.entries(src.materials)) {
    if (m.chop === undefined) continue;
    if (m.chop % CHOP !== 0) throw new Error(`${name}: chop ${m.chop} isn't a multiple of ${CHOP}`);
    const lit = ((m.flags ?? 0) & (SURF_NOLIGHT | SURF_SKY | SURF_SKY2D | SURF_NODRAW | SURF_TRIGGER)) === 0;
    if (lit && m.chop / (m.luxel ?? L.luxel) > 32)
      throw new Error(`${name}: chop ${m.chop} needs luxel >= ${m.chop / 32}`);
  }
  const chopOf = (material: string) => src.materials[material]?.chop ?? CHOP;
  const treeFaces = (tree: Tree, bs: readonly Box[], model: number, open: (l: TreeLeaf) => boolean) => {
    const ns = nodes(tree);
    nodeLists.push(ns);
    for (const n of ns)
      for (const r of nodeFaces(tree, n, bs, open, anyChop ? chopOf : undefined)) faceRects.push({ rect: r, model });
  };
  treeFaces(worldTree, world, 0, (l) => l.inside);
  ents.forEach((x, i) => treeFaces(entTrees[i], x.local, i + 1, (l) => !l.solid));

  log?.("tjunctions");
  // Polygons with T-junctions fixed (world and each model separately).
  const polys: Vec3[][] = new Array(faceRects.length);
  for (let m = 0; m <= ents.length; m++) {
    const idx = faceRects.map((f, i) => (f.model === m ? i : -1)).filter((i) => i >= 0);
    const fixed = fixTJunctions(idx.map((i) => corners(faceRects[i].rect)));
    idx.forEach((i, k) => (polys[i] = fixed[k]));
  }

  log?.("displacements");
  // ---- displacements: base quads (Source winding) and their displaced grids
  const dispSrc = src.displacements ?? [];
  const disps = dispSrc.map((d) => {
    const rect = {
      axis: d.axis,
      sign: d.sign,
      dist: d.dist,
      u0: d.u0,
      u1: d.u1,
      w0: d.w0,
      w1: d.w1,
      material: d.material,
    } as RectFace;
    const poly = corners(rect);
    const side = (1 << d.power) + 1;
    const n = side - 1;
    const lerp = (p: Vec3, q: Vec3, t: number): Vec3 => [
      p[0] + (q[0] - p[0]) * t,
      p[1] + (q[1] - p[1]) * t,
      p[2] + (q[2] - p[2]) * t,
    ];
    /** Flat point at grid parameters (a along corner 0 -> 1, b along corner 0 -> 3), 0..1. */
    const flatAt = (a: number, b: number) => lerp(lerp(poly[0], poly[1], a), lerp(poly[3], poly[2], a), b);
    const grid: Vec3[] = [];
    const alpha: number[] = [];
    for (let a = 0; a <= n; a++) {
      for (let b = 0; b <= n; b++) {
        const sh = d.shape(flatAt(a / n, b / n));
        grid.push(sh.p);
        alpha.push(Math.max(0, Math.min(255, sh.alpha ?? 0)));
      }
    }
    return { d, rect, poly, side, flatAt, grid, alpha };
  });

  // ---- solid faces: each side's winding where it isn't buried in the world, chopped so its lightmap fits
  const solidPolys: { poly: Vec3[]; n: Vec3; d: number; tex: string }[] = [];
  for (const s of solids) {
    s.src.sides.forEach((side, si) => {
      const w = s.windings[si];
      if (w.length < 3) return;
      const c = w.reduce((a, p) => [a[0] + p[0] / w.length, a[1] + p[1] / w.length, a[2] + p[2] / w.length] as Vec3, [
        0, 0, 0,
      ] as Vec3);
      if (!leafAt(worldTree, [c[0] + side.n[0], c[1] + side.n[1], c[2] + side.n[2]]).inside) return;
      const [sa, ta] = planeAxes(side.n);
      const lux = src.materials[side.tex]?.luxel ?? L.luxel;
      // Split only as much as the lightmap needs (30 luxels a piece), in equal strips from the face's own edge.
      const chop = Math.floor(30 * lux);
      const strips = (polys: Vec3[][], ax: Vec3) =>
        polys.flatMap((p) => {
          const vals = p.map((q) => dot3(ax, q));
          const lo = Math.min(...vals);
          const span = Math.max(...vals) - lo;
          const n = Math.max(1, Math.ceil((span - 1e-3) / chop));
          if (n === 1) return [p.map(snap3)];
          const step = span / n;
          const out: Vec3[][] = [];
          for (let k = 0; k < n; k++) {
            let q = clipPoly(p, ax, lo + (k + 1) * step);
            q = clipPoly(q, [-ax[0], -ax[1], -ax[2]], -(lo + k * step));
            if (q.length >= 3) out.push(q.map(snap3));
          }
          return out;
        });
      for (const poly of strips(strips([w], sa), ta)) solidPolys.push({ poly, n: side.n, d: side.d, tex: side.tex });
    });
  }

  log?.("caster");
  // ---- lightmaps
  const allBoxes: AABB[] = world;
  const skyBox = world.map((b) =>
    [0, 1, 2].some((a) =>
      [1, -1].some((s) => (src.materials[faceMaterial(b.tex, a, s as 1 | -1)]?.flags ?? 0) & SURF_SKY),
    ),
  );
  let caster: { seesSky(o: Vec3, d: Vec3): boolean; blocked(o: Vec3, d: Vec3, dist: number): boolean };
  let scene: ShadeScene | undefined;
  // Maps with lamps light brush faces like displacements: samples, then shading (here or on the caller's workers).
  const lamps = (L.lights?.length ?? 0) > 0;
  if (disps.length || lamps || solids.length) {
    // Shadows from the world, from visible brush entities (moved to world space) and from every displacement.
    const casters: AABB[] = [...world];
    const casterSky = [...skyBox];
    const hidden = SURF_NODRAW | SURF_TRIGGER | SURF_SKY;
    for (const x of ents) {
      for (const b of x.local) {
        const drawn = [0, 1, 2].some((a) =>
          [1, -1].some((sg) => {
            const m = src.materials[faceMaterial(b.tex, a, sg as 1 | -1)];
            return ((m?.flags ?? 0) & hidden) === 0 && !m?.noShadow;
          }),
        );
        if (!drawn) continue;
        casters.push({
          min: [b.min[0] + x.center[0], b.min[1] + x.center[1], b.min[2] + x.center[2]],
          max: [b.max[0] + x.center[0], b.max[1] + x.center[1], b.max[2] + x.center[2]],
        });
        casterSky.push(false);
      }
    }
    const tri: number[] = [];
    // Displacements shadow too, unless their material casts no shadows (glass, water).
    for (const x of disps) {
      if (src.materials[x.d.material]?.noShadow) continue;
      for (const t of dispTriangles(x.side)) for (const v of t) tri.push(...x.grid[v]);
    }
    // Solids shadow with their sides (fans), unless drawn with a hidden or shadowless material.
    for (const s of solids) {
      s.src.sides.forEach((side, si) => {
        const m = src.materials[side.tex];
        if (((m?.flags ?? 0) & hidden) !== 0 || m?.noShadow) return;
        const w = s.windings[si];
        for (let k = 1; k + 1 < w.length; k++) tri.push(...w[0], ...w[k], ...w[k + 1]);
      });
    }
    scene = { boxes: casters, sky: casterSky, tris: Float64Array.from(tri) };
    caster = new SceneCaster(scene.boxes, scene.sky, scene.tris);
  } else caster = new RayCaster(allBoxes, skyBox);
  const sunTo: Vec3 = [-L.sunDir[0], -L.sunDir[1], -L.sunDir[2]];
  const hemi = hemisphere(L.skyRays);
  const lighting = new Buf();
  let luxels = 0;
  log?.("brush lightmaps");
  const brushSamples: number[] = [];
  const brushRanges = new Map<number, [number, number]>();
  const outFaces: OutFace[] = faceRects.map(({ rect, model }, i) => {
    const flags = src.materials[rect.material].flags ?? 0;
    const anchored =
      rect.anchorBox === undefined ? undefined : (model === 0 ? world : ents[model - 1].local)[rect.anchorBox];
    const ti = texinfo(
      rect.material,
      rect.axis,
      anchored && anchorShift(rect.material, rect.axis, anchored.min, anchored.max),
    );
    // Brush entity faces are in model space: light them where the model sits.
    const off: Vec3 = model === 0 ? [0, 0, 0] : ents[model - 1].center;
    const lit = (flags & (SURF_NOLIGHT | SURF_SKY | SURF_SKY2D | SURF_NODRAW | SURF_TRIGGER)) === 0;
    const f: OutFace = {
      plane: plane(rect.axis, rect.dist, rect.sign),
      poly: polys[i],
      texinfo: ti,
      material: rect.material,
      rect,
      lit,
      lightOfs: -1,
      lmMins: [0, 0],
      lmSize: [0, 0],
    };
    if (!lit) return f;
    const tinfo = texinfos[ti];
    const sOf = (p: Vec3) => p[0] * tinfo.ls[0] + p[1] * tinfo.ls[1] + p[2] * tinfo.ls[2] + tinfo.ls[3];
    const tOf = (p: Vec3) => p[0] * tinfo.lt[0] + p[1] * tinfo.lt[1] + p[2] * tinfo.lt[2] + tinfo.lt[3];
    const ss = f.poly.map(sOf);
    const ts = f.poly.map(tOf);
    const sMin = Math.floor(Math.min(...ss) + 1e-4);
    const sMax = Math.ceil(Math.max(...ss) - 1e-4);
    const tMin = Math.floor(Math.min(...ts) + 1e-4);
    const tMax = Math.ceil(Math.max(...ts) - 1e-4);
    f.lmMins = [sMin, tMin];
    f.lmSize = [sMax - sMin, tMax - tMin];
    if (f.lmSize[0] > 32 || f.lmSize[1] > 32) throw new Error(`face lightmap too big: ${f.lmSize}`);
    f.lightOfs = lighting.len;
    if (lamps) brushRanges.set(i, [brushSamples.length / SAMPLE, (f.lmSize[0] + 1) * (f.lmSize[1] + 1)]);
    const n: Vec3 = [0, 0, 0];
    n[rect.axis] = rect.sign;
    // Tangent frame for the hemisphere.
    const tA: Vec3 = rect.axis === 2 ? [1, 0, 0] : [0, 0, 1];
    const bA: Vec3 = [n[1] * tA[2] - n[2] * tA[1], n[2] * tA[0] - n[0] * tA[2], n[0] * tA[1] - n[1] * tA[0]];
    const dirs = hemi.map(
      (h) =>
        [
          h[0] * tA[0] + h[1] * bA[0] + h[2] * n[0],
          h[0] * tA[1] + h[1] * bA[1] + h[2] * n[1],
          h[0] * tA[2] + h[1] * bA[2] + h[2] * n[2],
        ] as Vec3,
    );
    const sunDot = Math.max(0, n[0] * sunTo[0] + n[1] * sunTo[1] + n[2] * sunTo[2]);
    const ua = (rect.axis + 1) % 3;
    const wa = (rect.axis + 2) % 3;
    // Luxel (i, j) -> world: solve s = mins_s + i on the face plane (axis-aligned vectors).
    const sAxis = tinfo.ls.slice(0, 3).findIndex((x) => x !== 0);
    const tAxis = tinfo.lt.slice(0, 3).findIndex((x) => x !== 0);
    for (let j = 0; j <= f.lmSize[1]; j++) {
      for (let i = 0; i <= f.lmSize[0]; i++) {
        const p: Vec3 = [0, 0, 0];
        p[rect.axis] = rect.dist;
        p[sAxis] = (sMin + i) / tinfo.ls[sAxis];
        p[tAxis] = (tMin + j) / tinfo.lt[tAxis];
        // Keep the sample on the face (luxels overhang the edges), then lift it off the surface.
        p[ua] = Math.min(rect.u1 - 1, Math.max(rect.u0 + 1, p[ua]));
        p[wa] = Math.min(rect.w1 - 1, Math.max(rect.w0 + 1, p[wa]));
        const o: Vec3 = [p[0] + n[0] * 1 + off[0], p[1] + n[1] * 1 + off[1], p[2] + n[2] * 1 + off[2]];
        if (lamps) {
          const m = src.materials[rect.material];
          const fill = m.ambient ?? L.bounce;
          brushSamples.push(o[0], o[1], o[2], n[0], n[1], n[2], m.skyRays ?? L.skyRays, fill[0], fill[1], fill[2]);
          continue;
        }
        let r = L.bounce[0];
        let g = L.bounce[1];
        let b = L.bounce[2];
        if (sunDot > 0 && caster.seesSky(o, sunTo)) {
          r += L.sun[0] * sunDot;
          g += L.sun[1] * sunDot;
          b += L.sun[2] * sunDot;
        }
        let vis = 0;
        for (const d of dirs) if (caster.seesSky(o, d)) vis++;
        const sky = vis / dirs.length;
        r += L.sky[0] * sky;
        g += L.sky[1] * sky;
        b += L.sky[2] * sky;
        const [cr, cg, cb, e] = rgbExp([r, g, b]);
        lighting.u8(cr);
        lighting.u8(cg);
        lighting.u8(cb);
        lighting.i8(e);
        luxels++;
      }
    }
    return f;
  });

  if (lamps && brushSamples.length) {
    log?.(`shading ${brushSamples.length / SAMPLE} brush luxels`);
    const arr = Float64Array.from(brushSamples);
    const shaded = opts?.shade ? opts.shade(scene!, arr, L) : shadeSamples(caster, arr, L);
    outFaces.forEach((f, i) => {
      const range = brushRanges.get(i);
      if (!range) return;
      f.lightOfs = lighting.len;
      for (let k = range[0]; k < range[0] + range[1]; k++) {
        const [cr, cg, cb, e] = rgbExp([shaded[k * 3], shaded[k * 3 + 1], shaded[k * 3 + 2]]);
        lighting.u8(cr);
        lighting.u8(cg);
        lighting.u8(cb);
        lighting.i8(e);
        luxels++;
      }
    });
  }
  log?.("displacement lightmaps");
  // ---- displacement faces, lit over the displaced surface: luxel samples first, then shading (here, or by the
  // caller's worker pool: opts.shade), then the lighting lump in face order
  /** Per lit displacement luxel: origin (lifted off the surface), normal, sky ray count. */
  const samples: number[] = [];
  const dispSamples: [number, number][] = [];
  const dispFaces: OutFace[] = disps.map((x, di) => {
    const { d, rect } = x;
    const flags = src.materials[d.material].flags ?? 0;
    const lo: Vec3 = [0, 0, 0];
    const hi: Vec3 = [0, 0, 0];
    const ua = (d.axis + 1) % 3;
    const wa = (d.axis + 2) % 3;
    lo[d.axis] = hi[d.axis] = d.dist;
    ((lo[ua] = d.u0), (hi[ua] = d.u1), (lo[wa] = d.w0), (hi[wa] = d.w1));
    const ti = texinfo(d.material, d.axis, d.anchor ? anchorShift(d.material, d.axis, lo, hi) : undefined);
    const lit = (flags & (SURF_NOLIGHT | SURF_SKY | SURF_SKY2D | SURF_NODRAW | SURF_TRIGGER)) === 0;
    const f: OutFace = {
      plane: plane(d.axis, d.dist, d.sign),
      poly: x.poly,
      texinfo: ti,
      material: d.material,
      rect,
      lit,
      lightOfs: -1,
      lmMins: [0, 0],
      lmSize: [0, 0],
      disp: di,
    };
    if (!lit) return f;
    const tinfo = texinfos[ti];
    const sOf = (p: Vec3) => p[0] * tinfo.ls[0] + p[1] * tinfo.ls[1] + p[2] * tinfo.ls[2] + tinfo.ls[3];
    const tOf = (p: Vec3) => p[0] * tinfo.lt[0] + p[1] * tinfo.lt[1] + p[2] * tinfo.lt[2] + tinfo.lt[3];
    const ss = x.poly.map(sOf);
    const ts = x.poly.map(tOf);
    const sMin = Math.floor(Math.min(...ss) + 1e-4);
    const tMin = Math.floor(Math.min(...ts) + 1e-4);
    const w = Math.max(1, Math.ceil(Math.max(...ss) - 1e-4) - sMin);
    const h = Math.max(1, Math.ceil(Math.max(...ts) - 1e-4) - tMin);
    if (w > 128 || h > 128) throw new Error(`displacement lightmap too big: ${w} x ${h}`);
    f.lmMins = [sMin, tMin];
    f.lmSize = [w, h];
    const rays = src.materials[d.material].skyRays ?? L.skyRays;
    // The renderer (mesh.rs) stretches the quad over the whole luxel rectangle, each corner snapped to the nearest
    // rectangle corner: luxel (i, j) = c0 + (c1 - c0) a + (c3 - c0) b for grid parameters a, b.
    let cl = x.poly.map((p) => [sOf(p) - sMin > w * 0.5 ? w : 0, tOf(p) - tMin > h * 0.5 ? h : 0]);
    let A = [cl[1][0] - cl[0][0], cl[1][1] - cl[0][1]];
    let B = [cl[3][0] - cl[0][0], cl[3][1] - cl[0][1]];
    let det = A[0] * B[1] - A[1] * B[0];
    if (det === 0) {
      // A quad under a luxel across: its corners all snapped to one side. Snap by the middle of its own range instead.
      const sMid = (Math.min(...ss) + Math.max(...ss)) / 2;
      const tMid = (Math.min(...ts) + Math.max(...ts)) / 2;
      cl = x.poly.map((p) => [sOf(p) > sMid ? w : 0, tOf(p) > tMid ? h : 0]);
      A = [cl[1][0] - cl[0][0], cl[1][1] - cl[0][1]];
      B = [cl[3][0] - cl[0][0], cl[3][1] - cl[0][1]];
      det = A[0] * B[1] - A[1] * B[0];
    }
    const n = x.side - 1;
    const at = (a: number, b: number): Vec3 => {
      const fa = Math.min(n - 1e-9, Math.max(0, a * n));
      const fb = Math.min(n - 1e-9, Math.max(0, b * n));
      const ia = Math.floor(fa);
      const ib = Math.floor(fb);
      const ta = fa - ia;
      const tb = fb - ib;
      const g = (r: number, c: number) => x.grid[r * x.side + c];
      const p00 = g(ia, ib);
      const p01 = g(ia, ib + 1);
      const p10 = g(ia + 1, ib);
      const p11 = g(ia + 1, ib + 1);
      return [0, 1, 2].map(
        (k) => (p00[k] * (1 - tb) + p01[k] * tb) * (1 - ta) + (p10[k] * (1 - tb) + p11[k] * tb) * ta,
      ) as Vec3;
    };
    const first = samples.length / SAMPLE;
    for (let j = 0; j <= h; j++) {
      for (let i = 0; i <= w; i++) {
        const di0 = i - cl[0][0];
        const dj0 = j - cl[0][1];
        const a = (di0 * B[1] - dj0 * B[0]) / det;
        const b = (A[0] * dj0 - A[1] * di0) / det;
        const p = at(a, b);
        const nrm = d.shape(x.flatAt(Math.min(1, Math.max(0, a)), Math.min(1, Math.max(0, b)))).n;
        const fill = src.materials[d.material].ambient ?? L.bounce;
        samples.push(
          p[0] + nrm[0] * 2,
          p[1] + nrm[1] * 2,
          p[2] + nrm[2] * 2,
          nrm[0],
          nrm[1],
          nrm[2],
          rays,
          fill[0],
          fill[1],
          fill[2],
        );
      }
    }
    dispSamples[di] = [first, samples.length / SAMPLE - first];
    return f;
  });
  if (samples.length) {
    log?.(`shading ${samples.length / SAMPLE} displacement luxels`);
    const sampleArray = Float64Array.from(samples);
    const shaded = opts?.shade ? opts.shade(scene!, sampleArray, L) : shadeSamples(caster, sampleArray, L);
    dispFaces.forEach((f, di) => {
      if (!f.lit) return;
      f.lightOfs = lighting.len;
      const [first, count] = dispSamples[di];
      for (let k = first; k < first + count; k++) {
        const [cr, cg, cb, e] = rgbExp([shaded[k * 3], shaded[k * 3 + 1], shaded[k * 3 + 2]]);
        lighting.u8(cr);
        lighting.u8(cg);
        lighting.u8(cb);
        lighting.i8(e);
        luxels++;
      }
    });
  }
  // ---- solid faces: lit from samples like displacements (any plane: luxel (i, j) is solved in the face's plane)
  const solidSamples: number[] = [];
  const solidRanges: [number, number][] = [];
  const solidFaces: OutFace[] = solidPolys.map((sp, k) => {
    const flags = src.materials[sp.tex].flags ?? 0;
    const ti = texinfoAny(sp.tex, sp.n);
    const lit = (flags & (SURF_NOLIGHT | SURF_SKY | SURF_SKY2D | SURF_NODRAW | SURF_TRIGGER)) === 0;
    let area = 0;
    for (let i = 1; i + 1 < sp.poly.length; i++) {
      const a = sp.poly[0];
      const c = cross3(
        [sp.poly[i][0] - a[0], sp.poly[i][1] - a[1], sp.poly[i][2] - a[2]],
        [sp.poly[i + 1][0] - a[0], sp.poly[i + 1][1] - a[1], sp.poly[i + 1][2] - a[2]],
      );
      area += Math.hypot(...c) / 2;
    }
    const dummy = { axis: 2, sign: 1, dist: 0, u0: 0, u1: 0, w0: 0, w1: 0, material: sp.tex } as unknown as RectFace;
    const f: OutFace = {
      plane: planeAny(sp.n, sp.d),
      poly: sp.poly,
      texinfo: ti,
      material: sp.tex,
      rect: dummy,
      lit,
      lightOfs: -1,
      lmMins: [0, 0],
      lmSize: [0, 0],
      normal: sp.n,
      area,
    };
    if (!lit) return f;
    const tinfo = texinfos[ti];
    const ls: Vec3 = [tinfo.ls[0], tinfo.ls[1], tinfo.ls[2]];
    const lt: Vec3 = [tinfo.lt[0], tinfo.lt[1], tinfo.lt[2]];
    const ss = sp.poly.map((p) => dot3(p, ls));
    const ts = sp.poly.map((p) => dot3(p, lt));
    const sMin = Math.floor(Math.min(...ss) + 1e-4);
    const tMin = Math.floor(Math.min(...ts) + 1e-4);
    const w = Math.max(1, Math.ceil(Math.max(...ss) - 1e-4) - sMin);
    const h = Math.max(1, Math.ceil(Math.max(...ts) - 1e-4) - tMin);
    if (w > 32 || h > 32) throw new Error(`solid face lightmap too big: ${w} x ${h}`);
    f.lmMins = [sMin, tMin];
    f.lmSize = [w, h];
    // ls, lt and n are orthogonal: p = n d + ls (s / |ls|^2) + lt (t / |lt|^2).
    const ls2 = dot3(ls, ls);
    const lt2 = dot3(lt, lt);
    // Edge planes in the face (pointing in) to keep samples a unit inside it.
    const edges = sp.poly.map((a, i) => {
      const b = sp.poly[(i + 1) % sp.poly.length];
      const inward = norm3(cross3(sp.n, [b[0] - a[0], b[1] - a[1], b[2] - a[2]]));
      return { inward, d: dot3(inward, a) };
    });
    const centre = sp.poly.reduce(
      (a, p) => [a[0] + p[0] / sp.poly.length, a[1] + p[1] / sp.poly.length, a[2] + p[2] / sp.poly.length] as Vec3,
      [0, 0, 0] as Vec3,
    );
    const inset = Math.max(
      0,
      edges.reduce((m, e) => Math.min(m, dot3(e.inward, centre) - e.d), Infinity),
    );
    const keep = Math.min(1, inset * 0.5);
    const m = src.materials[sp.tex];
    const fill = m.ambient ?? L.bounce;
    const rays = m.skyRays ?? L.skyRays;
    const first = solidSamples.length / SAMPLE;
    for (let j = 0; j <= h; j++) {
      for (let i = 0; i <= w; i++) {
        let p: Vec3 = [0, 1, 2].map(
          (q) => sp.n[q] * sp.d + (ls[q] * (sMin + i)) / ls2 + (lt[q] * (tMin + j)) / lt2,
        ) as Vec3;
        for (let pass = 0; pass < 3; pass++) {
          for (const e of edges) {
            const dist = dot3(e.inward, p) - e.d;
            if (dist < keep)
              p = [
                p[0] + e.inward[0] * (keep - dist),
                p[1] + e.inward[1] * (keep - dist),
                p[2] + e.inward[2] * (keep - dist),
              ];
          }
        }
        solidSamples.push(
          p[0] + sp.n[0],
          p[1] + sp.n[1],
          p[2] + sp.n[2],
          sp.n[0],
          sp.n[1],
          sp.n[2],
          rays,
          fill[0],
          fill[1],
          fill[2],
        );
      }
    }
    solidRanges[k] = [first, solidSamples.length / SAMPLE - first];
    return f;
  });
  if (solidSamples.length) {
    log?.(`shading ${solidSamples.length / SAMPLE} solid luxels`);
    const arr = Float64Array.from(solidSamples);
    const shaded = opts?.shade ? opts.shade(scene!, arr, L) : shadeSamples(caster, arr, L);
    solidFaces.forEach((f, k) => {
      if (!f.lit) return;
      f.lightOfs = lighting.len;
      const [first, count] = solidRanges[k];
      for (let q = first; q < first + count; q++) {
        const [cr, cg, cb, e] = rgbExp([shaded[q * 3], shaded[q * 3 + 1], shaded[q * 3 + 2]]);
        lighting.u8(cr);
        lighting.u8(cg);
        lighting.u8(cb);
        lighting.i8(e);
        luxels++;
      }
    });
  }
  const allFaces = [...outFaces, ...dispFaces, ...solidFaces];
  const faceModel = (i: number) => (i < faceRects.length ? faceRects[i].model : 0);

  log?.("face order");
  // ---- face order: per node (contiguous), world first (then its displacements), then models
  const faceOrder: number[] = [];
  const nodeFaceRange = new Map<TreeNode, [number, number]>();
  nodeLists.forEach((ns, li) => {
    for (const n of ns) {
      const first = faceOrder.length;
      faceRects.forEach((f, i) => {
        if (f.rect.node === n) faceOrder.push(i);
      });
      nodeFaceRange.set(n, [first, faceOrder.length - first]);
    }
    if (li === 0) for (let k = 0; k < dispFaces.length + solidFaces.length; k++) faceOrder.push(outFaces.length + k);
  });
  const faceNewIndex = new Map(faceOrder.map((old, i) => [old, i]));
  const modelFaceRange: [number, number][] = [];
  for (let m = 0; m <= ents.length; m++) {
    const idx = faceOrder.map((old, i) => (faceModel(old) === m ? i : -1)).filter((i) => i >= 0);
    modelFaceRange.push(idx.length ? [idx[0], idx.length] : [faceOrder.length, 0]);
  }

  // ---- vertices / edges / surfedges
  const verts: Vec3[] = [];
  const vertIdx = new Map<string, number>();
  const vert = (p: Vec3) => {
    const k = p.join(",");
    let i = vertIdx.get(k);
    if (i === undefined) {
      i = verts.length;
      vertIdx.set(k, i);
      verts.push(p);
    }
    return i;
  };
  const edges: [number, number][] = [[0, 0]];
  const edgeIdx = new Map<string, number>();
  const surfedges: number[] = [];
  const faceEdges: [number, number][] = [];
  for (const old of faceOrder) {
    const f = allFaces[old];
    const first = surfedges.length;
    for (let i = 0; i < f.poly.length; i++) {
      const a = vert(f.poly[i]);
      const b = vert(f.poly[(i + 1) % f.poly.length]);
      const rev = edgeIdx.get(`${b},${a}`);
      if (rev !== undefined) surfedges.push(-rev);
      else {
        let e = edgeIdx.get(`${a},${b}`);
        if (e === undefined) {
          e = edges.length;
          edges.push([a, b]);
          edgeIdx.set(`${a},${b}`, e);
        }
        surfedges.push(e);
      }
    }
    faceEdges.push([first, f.poly.length]);
  }
  // dedge_t holds 16-bit vertex indices.
  if (verts.length > 65535) {
    // Where they come from: vertices first used by brush faces, displacements and solids.
    const seen = new Set<string>();
    const by = [0, 0, 0];
    for (const old of faceOrder) {
      const kind = old < outFaces.length ? 0 : old < outFaces.length + dispFaces.length ? 1 : 2;
      for (const p of allFaces[old].poly) {
        const k = p.join(",");
        if (!seen.has(k)) (seen.add(k), by[kind]++);
      }
    }
    throw new Error(
      `too many vertices for the BSP's 16-bit edges: ${verts.length} (brush faces ${by[0]}, displacements ${by[1]}, solids ${by[2]})`,
    );
  }

  // ---- leafs / nodes numbering
  const allLeafs: { l: TreeLeaf; model: number }[] = [];
  const allNodes: { n: TreeNode; model: number }[] = [];
  const number = (t: Tree, model: number): number => {
    if (t.leaf) {
      t.index = allLeafs.length + 1; // leaf 0 is vbsp's dummy solid leaf
      allLeafs.push({ l: t, model });
      return -1 - t.index;
    }
    t.index = allNodes.length;
    allNodes.push({ n: t, model });
    number(t.front, model);
    number(t.back, model);
    return t.index;
  };
  const heads = [number(worldTree, 0), ...entTrees.map((t, i) => number(t, i + 1))];

  // Leaf faces: each world face goes to the inside leaves its front touches.
  const leafFaceLists = new Map<TreeLeaf, number[]>();
  faceOrder.forEach((old, ni) => {
    if (old >= outFaces.length + dispFaces.length) {
      // Solid faces: the inside leaves their bounds touch.
      const poly = allFaces[old].poly;
      const box: AABB = {
        min: [0, 1, 2].map((k) => Math.min(...poly.map((p) => p[k])) - 0.5) as Vec3,
        max: [0, 1, 2].map((k) => Math.max(...poly.map((p) => p[k])) + 0.5) as Vec3,
      };
      for (const l of leavesIn(worldTree, box)) {
        if (!l.inside) continue;
        let list = leafFaceLists.get(l);
        if (!list) leafFaceLists.set(l, (list = []));
        list.push(ni);
      }
      return;
    }
    if (old >= faceRects.length) return; // displacements aren't in leaves
    const f = faceRects[old];
    if (f.model !== 0) return;
    const r = f.rect;
    const ua = (r.axis + 1) % 3;
    const wa = (r.axis + 2) % 3;
    const box: AABB = { min: [0, 0, 0], max: [0, 0, 0] };
    box.min[ua] = r.u0;
    box.max[ua] = r.u1;
    box.min[wa] = r.w0;
    box.max[wa] = r.w1;
    box.min[r.axis] = r.sign > 0 ? r.dist : r.dist - 0.5;
    box.max[r.axis] = r.sign > 0 ? r.dist + 0.5 : r.dist;
    for (const l of leavesIn(worldTree, box)) {
      if (!l.inside) continue;
      let list = leafFaceLists.get(l);
      if (!list) leafFaceLists.set(l, (list = []));
      list.push(ni);
    }
  });

  log?.("lumps");
  // ---- lumps
  const lumps: (Uint8Array | null)[] = new Array(64).fill(null);
  const versions: number[] = new Array(64).fill(0);

  // 0 entities
  const kv = (o: Record<string, string>) =>
    `{\n${Object.entries(o)
      .map(([k, v]) => `"${k}" "${v}"`)
      .join("\n")}\n}\n`;
  const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(2));
  let text = kv({
    ...src.worldspawn,
    world_mins: worldBounds.min.map(fmt).join(" "),
    world_maxs: worldBounds.max.map(fmt).join(" "),
    classname: "worldspawn",
  });
  ents.forEach((x, i) => (text += kv({ ...x.e.keys, model: `*${i + 1}`, origin: x.center.map(fmt).join(" ") })));
  for (const p of src.points) text += kv(p);
  lumps[0] = new TextEncoder().encode(text + "\0");

  // 43/44 texdata strings, 2 texdata
  {
    const data = new Buf();
    const table = new Buf();
    for (const n of texdataNames) {
      table.i32(data.len);
      data.bytes(new TextEncoder().encode(n + "\0"));
    }
    lumps[43] = data.out();
    lumps[44] = table.out();
    const b = new Buf();
    texdataNames.forEach((n, i) => {
      const m = src.materials[n];
      b.vec(m.reflectivity);
      b.i32(i);
      b.i32(m.width);
      b.i32(m.height);
      b.i32(m.width);
      b.i32(m.height);
    });
    lumps[2] = b.out();
  }
  // 3 vertexes
  {
    const b = new Buf();
    for (const v of verts) b.vec(v);
    lumps[3] = b.out();
  }
  // 4 visibility: one cluster that sees (and hears) itself.
  {
    const b = new Buf();
    b.i32(1);
    b.i32(12);
    b.i32(13);
    b.u8(1);
    b.u8(1);
    lumps[4] = b.out();
  }
  // 5 nodes
  {
    const b = new Buf();
    for (const { n } of allNodes) {
      b.i32(plane(n.axis, n.dist, 1));
      b.i32(n.front.leaf ? -1 - n.front.index! : n.front.index!);
      b.i32(n.back.leaf ? -1 - n.back.index! : n.back.index!);
      for (const x of n.region.min) b.i16(clampShort(x));
      for (const x of n.region.max) b.i16(clampShort(x));
      const [first, count] = nodeFaceRange.get(n) ?? [0, 0];
      b.u16(first);
      b.u16(count);
      b.i16(0); // area
      b.i16(0);
    }
    lumps[5] = b.out();
  }
  // 6 texinfo
  {
    const b = new Buf();
    for (const t of texinfos) {
      b.vec(t.s);
      b.vec(t.t);
      b.vec(t.ls);
      b.vec(t.lt);
      b.i32(t.flags);
      b.i32(t.texdata);
    }
    lumps[6] = b.out();
  }
  // 7 faces (v1), 27 original faces (the same list)
  {
    const b = new Buf();
    faceOrder.forEach((old, ni) => {
      const f = allFaces[old];
      const [first, count] = faceEdges[ni];
      b.u16(f.plane);
      b.u8(f.plane & 1); // side
      b.u8(f.disp === undefined && !f.normal ? 1 : 0); // onNode
      b.i32(first);
      b.i16(count);
      b.i16(f.texinfo);
      b.i16(f.disp ?? -1); // dispinfo
      b.i16(-1); // surfaceFogVolumeID
      for (const s of f.lit ? [0, 255, 255, 255] : [255, 255, 255, 255]) b.u8(s);
      b.i32(f.lightOfs);
      const r = f.rect;
      b.f32(f.area ?? (r.u1 - r.u0) * (r.w1 - r.w0));
      b.i32(f.lmMins[0]);
      b.i32(f.lmMins[1]);
      b.i32(f.lmSize[0]);
      b.i32(f.lmSize[1]);
      b.i32(ni); // origFace
      b.u16(0); // numPrims
      b.u16(0); // firstPrimID
      b.u32(0); // smoothingGroups
    });
    lumps[7] = b.out();
    lumps[27] = lumps[7];
    versions[7] = 1;
  }
  // 8 lighting (LDR, v1)
  lumps[8] = lighting.out();
  versions[8] = 1;
  // 9 occlusion (v2): no occluders
  {
    const b = new Buf();
    b.i32(0);
    b.i32(0);
    b.i32(0);
    lumps[9] = b.out();
    versions[9] = 2;
  }
  // 10 leafs (v1, 32 bytes) + 46 min dist to water + 52/56 ambient lighting
  {
    const b = new Buf();
    const minDist = new Buf();
    const ambIndex = new Buf();
    const amb = new Buf();
    const leafFaces = new Buf();
    const leafBrushes = new Buf();
    let lfCount = 0;
    let lbCount = 0;
    // Leaf 0: vbsp's dummy solid leaf.
    const writeLeaf = (
      contents: number,
      cluster: number,
      area: number,
      flags: number,
      min: Vec3,
      max: Vec3,
      faces: number[],
      brushList: number[],
    ) => {
      b.i32(contents);
      b.i16(cluster);
      b.i16((area & 0x1ff) | (flags << 9));
      for (const x of min) b.i16(clampShort(x));
      for (const x of max) b.i16(clampShort(x));
      b.u16(lfCount);
      b.u16(faces.length);
      for (const f of faces) leafFaces.u16(f);
      lfCount += faces.length;
      b.u16(lbCount);
      b.u16(brushList.length);
      for (const x of brushList) leafBrushes.u16(x);
      lbCount += brushList.length;
      b.i16(-1); // leafWaterDataID
      b.i16(0);
      minDist.u16(65535);
    };
    writeLeaf(CONTENTS_SOLID, 0, 0, 0, [0, 0, 0], [0, 0, 0], [], []);
    // Solids go in every world leaf their bounds touch (traces collect brushes from the leaves they cross).
    const leafSolids = new Map<TreeLeaf, number[]>();
    solids.forEach((s, k) => {
      for (const l of leavesIn(worldTree, {
        min: [s.min[0] - 1, s.min[1] - 1, s.min[2] - 1],
        max: [s.max[0] + 1, s.max[1] + 1, s.max[2] + 1],
      })) {
        let list = leafSolids.get(l);
        if (!list) leafSolids.set(l, (list = []));
        list.push(firstSolid + k);
      }
    });
    ambIndex.u16(0);
    ambIndex.u16(0);
    let ambCount = 0;
    for (const { l, model } of allLeafs) {
      const brushOffset = model === 0 ? 0 : ents[model - 1].first;
      const inside = model === 0 && l.inside;
      const faces = inside ? (leafFaceLists.get(l) ?? []) : [];
      const own = l.solid ? l.brushes.map((i) => i + brushOffset) : [];
      const extra = model === 0 ? leafSolids.get(l) : undefined;
      writeLeaf(
        l.solid ? l.contents : 0,
        inside ? 0 : -1,
        inside ? 1 : 0,
        inside ? LEAF_FLAGS_SKY2D : 0,
        l.region.min,
        l.region.max,
        faces,
        extra ? [...own, ...extra] : own,
      );
      if (inside) {
        // One ambient cube sample at the leaf centre: sky + bounce everywhere, sun on the faces that see it.
        const c: Vec3 = [0, 1, 2].map((k) => (l.region.min[k] + l.region.max[k]) / 2) as Vec3;
        const sunVisible = caster.seesSky(c, sunTo) ? 1 : 0;
        ambIndex.u16(1);
        ambIndex.u16(ambCount++);
        // Lamps the leaf centre can see (maps with lamps): direction (unit) and the light from it.
        const seen: [Vec3, Vec3][] = [];
        if (lamps) {
          for (const lp of L.lights!) {
            const dv: Vec3 = [lp.pos[0] - c[0], lp.pos[1] - c[1], lp.pos[2] - c[2]];
            const dist = Math.hypot(...dv);
            if (dist >= lp.range || dist < 1) continue;
            const u: Vec3 = [dv[0] / dist, dv[1] / dist, dv[2] / dist];
            if (caster.blocked(c, u, dist - 3)) continue;
            const w = 1 - (dist / lp.range) ** 4;
            const k = (w * w * 10000) / Math.max(dist * dist, 1024);
            seen.push([u, [lp.color[0] * k, lp.color[1] * k, lp.color[2] * k]]);
          }
        }
        for (const d of [
          [1, 0, 0],
          [-1, 0, 0],
          [0, 1, 0],
          [0, -1, 0],
          [0, 0, 1],
          [0, 0, -1],
        ] as Vec3[]) {
          const s = Math.max(0, d[0] * sunTo[0] + d[1] * sunTo[1] + d[2] * sunTo[2]) * sunVisible * 0.6;
          const up = d[2] > 0 ? 0.8 : d[2] < 0 ? 0.35 : 0.55;
          const lamp: Vec3 = [0, 0, 0];
          for (const [u, col] of seen) {
            const f = Math.max(0, u[0] * d[0] + u[1] * d[1] + u[2] * d[2]);
            for (let k = 0; k < 3; k++) lamp[k] += col[k] * f;
          }
          const col = rgbExp([
            L.bounce[0] + L.sky[0] * up + L.sun[0] * s + lamp[0],
            L.bounce[1] + L.sky[1] * up + L.sun[1] * s + lamp[1],
            L.bounce[2] + L.sky[2] * up + L.sun[2] * s + lamp[2],
          ]);
          amb.u8(col[0]);
          amb.u8(col[1]);
          amb.u8(col[2]);
          amb.i8(col[3]);
        }
        amb.u8(128);
        amb.u8(128);
        amb.u8(128);
        amb.u8(0);
      } else {
        ambIndex.u16(0);
        ambIndex.u16(ambCount);
      }
    }
    lumps[10] = b.out();
    versions[10] = 1;
    lumps[16] = leafFaces.out();
    lumps[17] = leafBrushes.out();
    lumps[46] = minDist.out();
    lumps[52] = ambIndex.out();
    lumps[56] = amb.out();
    versions[56] = 1;
  }
  // 12 edges, 13 surfedges
  {
    const b = new Buf();
    for (const [x, y] of edges) {
      b.u16(x);
      b.u16(y);
    }
    lumps[12] = b.out();
    const s = new Buf();
    for (const e of surfedges) s.i32(e);
    lumps[13] = s.out();
  }
  // 14 models
  {
    const b = new Buf();
    const modelBounds = [worldBounds, ...ents.map((x) => bounds(x.local, 0))];
    modelBounds.forEach((mb, m) => {
      b.vec(mb.min.map((x) => x - 1));
      b.vec(mb.max.map((x) => x + 1));
      b.vec([0, 0, 0]);
      b.i32(heads[m]);
      b.i32(modelFaceRange[m][0]);
      b.i32(modelFaceRange[m][1]);
    });
    lumps[14] = b.out();
  }
  // 15 world lights: light_environment's sky ambient + sun (emit_skyambient = 5, emit_skylight = 3)
  {
    const b = new Buf();
    const light = (type: number, intensity: Vec3, normal: Vec3) => {
      b.vec(src.seeds[0]);
      b.vec(intensity);
      b.vec(normal);
      b.i32(0); // cluster
      b.i32(type);
      b.i32(0); // style
      for (let i = 0; i < 7; i++) b.f32(0);
      b.i32(0); // flags
      b.i32(0); // texinfo
      b.i32(0); // owner
    };
    light(5, L.sky, [0, 0, 0]);
    light(3, L.sun, L.sunDir);
    lumps[15] = b.out();
  }
  // 18 brushes, 19 brushsides
  {
    const b = new Buf();
    const s = new Buf();
    let sideCount = 0;
    brushes.forEach((br) => {
      if (br.solid) {
        const sides = br.solid.src.sides;
        const bev = br.solid.bevels;
        b.i32(sideCount);
        b.i32(sides.length + bev.length);
        b.i32(br.contents);
        for (const side of sides) {
          s.u16(planeAny(side.n, side.d));
          s.i16(texinfoAny(side.tex, side.n));
          s.i16(0);
          s.u8(0);
          s.u8(0);
        }
        for (const p of bev) {
          s.u16(planeAny(p.n, p.d));
          s.i16(texinfoAny(sides[0].tex, p.n));
          s.i16(0);
          s.u8(1); // bevel
          s.u8(0);
        }
        sideCount += sides.length + bev.length;
        return;
      }
      b.i32(sideCount);
      b.i32(6);
      b.i32(br.contents);
      sideCount += 6;
      for (const [a, sign] of [
        [0, -1],
        [0, 1],
        [1, -1],
        [1, 1],
        [2, -1],
        [2, 1],
      ] as [number, 1 | -1][]) {
        s.u16(plane(a, sign > 0 ? br.box.max[a] : br.box.min[a], sign));
        s.i16(texinfo(faceMaterial(br.box.tex, a, sign), a));
        s.i16(0); // dispinfo
        s.u8(0); // bevel
        s.u8(0); // thin
      }
    });
    lumps[18] = b.out();
    lumps[19] = s.out();
    // texinfo may have grown (brush sides on hidden faces): rewrite lump 6.
    const t = new Buf();
    for (const x of texinfos) {
      t.vec(x.s);
      t.vec(x.t);
      t.vec(x.ls);
      t.vec(x.lt);
      t.i32(x.flags);
      t.i32(x.texdata);
    }
    lumps[6] = t.out();
    // ... and so may texdata (rewrite 2 / 43 / 44).
    const data = new Buf();
    const table = new Buf();
    const td = new Buf();
    texdataNames.forEach((n, i) => {
      table.i32(data.len);
      data.bytes(new TextEncoder().encode(n + "\0"));
      const m = src.materials[n];
      td.vec(m.reflectivity);
      td.i32(i);
      td.i32(m.width);
      td.i32(m.height);
      td.i32(m.width);
      td.i32(m.height);
    });
    lumps[2] = td.out();
    lumps[43] = data.out();
    lumps[44] = table.out();
  }
  // 20 areas (0 = none, 1 = the whole map), 21 area portals (vbsp's empty portal 0)
  {
    const b = new Buf();
    b.i32(0);
    b.i32(0);
    b.i32(0);
    b.i32(1);
    lumps[20] = b.out();
    const p = new Buf();
    for (let i = 0; i < 3; i++) p.i32(0);
    lumps[21] = p.out();
  }
  // 30/31 vertex normals: one per face (flat), indexed per face vertex in face order
  {
    const normals: Vec3[] = [];
    const ni = new Map<string, number>();
    const idx = new Buf();
    for (const old of faceOrder) {
      const r = allFaces[old].rect;
      let n: Vec3 = [0, 0, 0];
      n[r.axis] = r.sign;
      if (allFaces[old].normal) n = allFaces[old].normal!;
      const k = n.join(",");
      let i = ni.get(k);
      if (i === undefined) {
        i = normals.length;
        ni.set(k, i);
        normals.push(n);
      }
      for (let v = 0; v < allFaces[old].poly.length; v++) idx.u16(i);
    }
    const b = new Buf();
    for (const n of normals) b.vec(n);
    lumps[30] = b.out();
    lumps[31] = idx.out();
  }
  // 47 face macro texture info: none
  {
    const b = new Buf();
    for (let i = 0; i < faceOrder.length; i++) b.i16(-1);
    lumps[47] = b.out();
  }
  // 26 dispinfo, 33 disp verts, 48 disp tris (no neighbours: the core and our lightmaps don't need them)
  if (disps.length) {
    const info = new Buf();
    const verts = new Buf();
    const tris = new Buf();
    let vStart = 0;
    let tStart = 0;
    const mapFace = new Map(faceOrder.map((old, ni) => [old, ni]));
    disps.forEach((x, di) => {
      const start = x.poly[0];
      info.vec(start);
      info.i32(vStart);
      info.i32(tStart);
      info.i32(x.d.power);
      info.i32(0); // minimum tessellation
      info.f32(0); // smoothing angle
      info.i32(x.d.contents ?? CONTENTS_SOLID);
      info.u16(mapFace.get(outFaces.length + di)!);
      info.u16(0);
      info.i32(0); // lightmap alpha start
      info.i32(0); // lightmap sample position start
      for (let e = 0; e < 4; e++)
        for (let k = 0; k < 2; k++) (info.u16(0xffff), info.u8(0), info.u8(0), info.u8(0), info.u8(0));
      for (let c = 0; c < 4; c++) {
        for (let k = 0; k < 4; k++) info.u16(0xffff);
        info.u8(0);
        info.u8(0);
      }
      for (let k = 0; k < 10; k++) info.u32(0xffffffff); // allowed verts
      const n = x.side - 1;
      for (let a = 0; a <= n; a++) {
        for (let b = 0; b <= n; b++) {
          const flat = x.flatAt(a / n, b / n);
          const p = x.grid[a * x.side + b];
          const off: Vec3 = [p[0] - flat[0], p[1] - flat[1], p[2] - flat[2]];
          const len = Math.hypot(...off);
          verts.vec(len > 1e-6 ? off.map((v) => v / len) : [0, 0, 0]);
          verts.f32(len);
          verts.f32(x.alpha[a * x.side + b]);
        }
      }
      for (const t of dispTriangles(x.side)) {
        // Tags as vbsp: surface, walkable (normal z >= 0.7), buildable (>= 0.8). Normal as the collision code's.
        const [p0, p1, p2] = t.map((v) => x.grid[v]);
        const e2: Vec3 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
        const e1: Vec3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        const nz = e2[0] * e1[1] - e2[1] * e1[0];
        const len = Math.hypot(e2[1] * e1[2] - e2[2] * e1[1], e2[2] * e1[0] - e2[0] * e1[2], nz) || 1;
        const z = (nz / len) * x.d.sign;
        tris.u16(0x1 | (z >= 0.7 ? 0x2 : 0) | (z >= 0.8 ? 0x4 : 0));
      }
      vStart += x.side * x.side;
      tStart += 2 * n * n;
    });
    lumps[26] = info.out();
    lumps[33] = verts.out();
    lumps[48] = tris.out();
  }
  // 40 pakfile: a stored (uncompressed) zip; empty = end of central directory only
  {
    const b = new Buf();
    const central = new Buf();
    const files = src.pak ?? [];
    for (const f of files) {
      const name = new TextEncoder().encode(f.path);
      const crc = crc32(f.data);
      const at = b.len;
      b.u32(0x04034b50);
      b.u16(10); // version needed
      b.u16(0); // flags
      b.u16(0); // stored
      b.u16(0); // time
      b.u16(0); // date
      b.u32(crc);
      b.u32(f.data.length);
      b.u32(f.data.length);
      b.u16(name.length);
      b.u16(0);
      b.bytes(name);
      b.bytes(f.data);
      central.u32(0x02014b50);
      central.u16(20); // made by
      central.u16(10);
      central.u16(0);
      central.u16(0);
      central.u16(0);
      central.u16(0);
      central.u32(crc);
      central.u32(f.data.length);
      central.u32(f.data.length);
      central.u16(name.length);
      central.u16(0); // extra
      central.u16(0); // comment
      central.u16(0); // disk
      central.u16(0); // internal attributes
      central.u32(0); // external attributes
      central.u32(at);
      central.bytes(name);
    }
    const cdAt = b.len;
    const cd = central.out();
    b.bytes(cd);
    b.u32(0x06054b50);
    b.u16(0);
    b.u16(0);
    b.u16(files.length);
    b.u16(files.length);
    b.u32(files.length ? cd.length : 0);
    b.u32(files.length ? cdAt : 0);
    b.u16(0);
    lumps[40] = b.out();
  }
  // 59 map flags
  {
    const b = new Buf();
    b.u32(0);
    lumps[59] = b.out();
  }

  // 1 planes (last: node and brush side planes are created while writing those lumps)
  {
    const b = new Buf();
    for (const p of planes) {
      b.vec(p.n);
      b.f32(p.d);
      b.i32(p.type);
    }
    lumps[1] = b.out();
  }

  // ---- file: header, then lumps 4-byte aligned. 35 (game lump) holds absolute offsets, so it goes last.
  const HEADER = 8 + 64 * 16 + 4;
  const file = new Buf();
  file.bytes(new TextEncoder().encode("VBSP"));
  file.i32(20);
  for (let i = 0; i < 64; i++) for (let k = 0; k < 4; k++) file.i32(0);
  file.i32(mapRevision);
  const dir: [number, number][] = new Array(64).fill(null).map(() => [0, 0]);
  const order = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 26, 27, 30, 31, 33, 46, 47, 48, 52, 56, 59,
    43, 44, 0, 40,
  ];
  for (const i of order) {
    const d = lumps[i];
    if (!d) continue;
    while (file.len % 4) file.u8(0);
    dir[i] = [file.len, d.length];
    file.bytes(d);
  }
  while (file.len % 4) file.u8(0);
  {
    // Game lump: one static prop lump (sprp v5) with no models, leaves or props.
    const start = file.len;
    const gl = new Buf();
    gl.i32(1);
    gl.bytes(new TextEncoder().encode("prps")); // 'sprp' as a little-endian int
    gl.u16(0);
    gl.u16(5);
    gl.i32(start + 4 + 16);
    gl.i32(12);
    gl.i32(0);
    gl.i32(0);
    gl.i32(0);
    dir[35] = [start, gl.len];
    file.bytes(gl.out());
  }
  const out = file.out();
  const view = new DataView(out.buffer);
  for (let i = 0; i < 64; i++) {
    view.setInt32(8 + i * 16, dir[i][0], true);
    view.setInt32(8 + i * 16 + 4, dir[i][1], true);
    view.setInt32(8 + i * 16 + 8, versions[i], true);
    view.setInt32(8 + i * 16 + 12, 0, true);
  }
  return {
    bsp: out,
    stats: {
      planes: planes.length,
      brushes: brushes.length,
      nodes: allNodes.length,
      leafs: allLeafs.length + 1,
      faces: faceOrder.length,
      luxels,
      bytes: out.length,
      outsideLeafs,
    },
  };
}
