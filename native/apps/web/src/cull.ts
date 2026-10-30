import * as THREE from "three";

// View-frustum culling for the world (research/PERF-0.0.22.md). three.js culls per object, but the map is a few big
// meshes over shared vertex buffers (every brush model's mesh, and one mesh for all static props), so their bounding
// spheres would be the whole map: they were drawn in full every frame. Two fixes:
//
// * `boundObject`: a mesh's real bounds (the triangles its groups draw), so three culls small brush models (bhop
//   blocks, doors) by itself.
// * `CellCuller`: a big mesh's triangles are sorted into CELL-unit cells of space, cell by cell within each draw group;
//   before each render (scene.onBeforeRender), each geometry's groups are rewritten to the ranges of the cells in view,
//   adjacent ones merged. Same materials, same order between materials; only the triangles off screen are skipped.
//   Off-screen triangles cost vertex work everywhere and a lot on PCs drawing without a GPU.
//
// Both keep the geometry's vertex buffers; a culled geometry gets its own (cell-sorted) index buffer.

/** Cell size, Source units. */
const CELL = 1024;
/** Meshes with fewer triangles are bounded (`boundObject`) instead of split into cells. */
export const CELL_MIN_TRIANGLES = 4096;

const v = new THREE.Vector3();

/** Bounding box and sphere of the triangles `geo`'s groups draw (local space), set on the geometry. */
export function boundGeometry(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute("position");
  const index = geo.getIndex();
  if (!pos || !index) return;
  const box = new THREE.Box3();
  const idx = index.array;
  const ranges = geo.groups.length ? geo.groups : [{ start: 0, count: idx.length }];
  for (const g of ranges) for (let k = g.start; k < g.start + g.count; k++) box.expandByPoint(v.fromBufferAttribute(pos, idx[k]));
  if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3());
  geo.boundingBox = box;
  geo.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
}

/** A small mesh culled by three itself: real bounds, frustum culling on. */
export function boundObject(mesh: THREE.Mesh): void {
  boundGeometry(mesh.geometry);
  mesh.frustumCulled = true;
}

interface Cell {
  /** Local-space bounds. */
  sphere: THREE.Sphere;
  visible: boolean;
}

interface Run {
  cell: number;
  start: number;
  count: number;
}

interface Culled {
  cells: Cell[];
  /** Per original group: its material and its cells' index ranges, in cell order. */
  groups: { materialIndex: number; runs: Run[] }[];
  /** The draw-group objects cull() hands the geometry, reused render after render. */
  pool?: { start: number; count: number; materialIndex: number }[];
}

/** Writes draw group `n` of `pool` (made the first time); returns n + 1. */
function putGroup(pool: NonNullable<Culled["pool"]>, n: number, start: number, count: number, materialIndex: number): number {
  const gr = (pool[n] ??= { start: 0, count: 0, materialIndex: 0 });
  gr.start = start;
  gr.count = count;
  gr.materialIndex = materialIndex;
  return n + 1;
}

const frustum = new THREE.Frustum();
const m4 = new THREE.Matrix4();
const sphere = new THREE.Sphere();

/** Morton-ish order of a cell key so that neighbouring cells sit next to each other in the index buffer. */
function cellOrder(x: number, y: number, z: number): number {
  let o = 0;
  for (let b = 0; b < 10; b++) o += (((x >> b) & 1) << (3 * b)) + (((y >> b) & 1) << (3 * b + 1)) + (((z >> b) & 1) << (3 * b + 2));
  return o;
}

/**
 * Splits `geo` into cells (in place: new index buffer, groups rewritten every cull). Groups whose material blends
 * (`keep`) keep their triangle order (it's their blend order) and are always drawn.
 */
function split(geo: THREE.BufferGeometry, keep: (materialIndex: number) => boolean): Culled {
  const pos = geo.getAttribute("position");
  const src = geo.getIndex()!.array;
  const box = new THREE.Box3();
  for (const g of geo.groups) for (let k = g.start; k < g.start + g.count; k++) box.expandByPoint(v.fromBufferAttribute(pos, src[k]));
  const min = box.min;
  const cellOf = new Map<number, number>();
  const cellBoxes: THREE.Box3[] = [];
  const keys: number[] = [];
  const total = geo.groups.reduce((n, g) => n + g.count, 0);
  const out = new Uint32Array(total);
  let at = 0;
  const groups: Culled["groups"] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const g of geo.groups) {
    if (keep(g.materialIndex ?? 0)) {
      out.set(src.subarray(g.start, g.start + g.count), at);
      groups.push({ materialIndex: g.materialIndex ?? 0, runs: [{ cell: -1, start: at, count: g.count }] });
      at += g.count;
      continue;
    }
    const tris: { cell: number; t: number }[] = [];
    for (let t = g.start; t + 2 < g.start + g.count; t += 3) {
      a.fromBufferAttribute(pos, src[t]);
      b.fromBufferAttribute(pos, src[t + 1]);
      c.fromBufferAttribute(pos, src[t + 2]);
      const cx = Math.floor(((a.x + b.x + c.x) / 3 - min.x) / CELL);
      const cy = Math.floor(((a.y + b.y + c.y) / 3 - min.y) / CELL);
      const cz = Math.floor(((a.z + b.z + c.z) / 3 - min.z) / CELL);
      const key = cellOrder(cx, cy, cz);
      let cell = cellOf.get(key);
      if (cell === undefined) {
        cellOf.set(key, (cell = cellBoxes.length));
        cellBoxes.push(new THREE.Box3());
        keys.push(key);
      }
      cellBoxes[cell].expandByPoint(a).expandByPoint(b).expandByPoint(c);
      tris.push({ cell, t });
    }
    tris.sort((p, q) => keys[p.cell] - keys[q.cell] || p.t - q.t);
    const runs: Run[] = [];
    for (const { cell, t } of tris) {
      const last = runs[runs.length - 1];
      if (last && last.cell === cell) last.count += 3;
      else runs.push({ cell, start: at, count: 3 });
      out[at++] = src[t];
      out[at++] = src[t + 1];
      out[at++] = src[t + 2];
    }
    groups.push({ materialIndex: g.materialIndex ?? 0, runs });
  }
  geo.setIndex(new THREE.BufferAttribute(out, 1));
  boundGeometry(geo);
  const cells = cellBoxes.map((bx) => ({ sphere: bx.getBoundingSphere(new THREE.Sphere()), visible: true }));
  return { cells, groups };
}

/** The big meshes of a world, culled per cell before each render of a scene that holds them. */
export class CellCuller {
  private data = new WeakMap<THREE.BufferGeometry, Culled>();
  private meshes: THREE.Mesh[] = [];

  /** Culls `mesh` per cell (whatever geometry it has at render time: Potato mode swaps them). */
  add(mesh: THREE.Mesh): void {
    mesh.frustumCulled = false; // the cells do it
    this.meshes.push(mesh);
  }

  /** Rewrites each mesh's groups to the cells `camera` sees. Call before projecting (scene.onBeforeRender). */
  cull(camera: THREE.Camera): void {
    frustum.setFromProjectionMatrix(m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (const mesh of this.meshes) {
      const geo = mesh.geometry;
      let d = this.data.get(geo);
      if (!d) {
        if (!geo.getIndex() || !geo.groups.length) continue;
        const mats = mesh.material;
        this.data.set(geo, (d = split(geo, (i) => !!(Array.isArray(mats) ? mats[i] : mats)?.transparent)));
      }
      if (!mesh.visible) continue;
      mesh.updateWorldMatrix(true, false);
      for (const cell of d.cells) cell.visible = frustum.intersectsSphere(sphere.copy(cell.sphere).applyMatrix4(mesh.matrixWorld));
      // The groups are rewritten for every render (water captures too), so their objects are reused, not reallocated.
      const pool = (d.pool ??= []);
      let n = 0;
      for (const g of d.groups) {
        let start = -1;
        let end = -1;
        for (const r of g.runs) {
          if (r.cell >= 0 && !d.cells[r.cell].visible) continue;
          if (r.start === end) end += r.count;
          else {
            if (start >= 0) n = putGroup(pool, n, start, end - start, g.materialIndex);
            start = r.start;
            end = r.start + r.count;
          }
        }
        if (start >= 0) n = putGroup(pool, n, start, end - start, g.materialIndex);
      }
      const groups = geo.groups;
      groups.length = n;
      for (let i = 0; i < n; i++) groups[i] = pool[i];
    }
  }

  /** Draw everything again (no camera to cull for: e.g. a cube-map or an orthographic overview). */
  uncull(): void {
    for (const mesh of this.meshes) {
      const d = this.data.get(mesh.geometry);
      if (!d) continue;
      mesh.geometry.clearGroups();
      for (const g of d.groups) for (const r of g.runs) mesh.geometry.addGroup(r.start, r.count, g.materialIndex);
    }
  }
}
