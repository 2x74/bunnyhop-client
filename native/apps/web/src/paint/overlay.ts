import * as THREE from "three";
import { DecalGeometry } from "three/addons/geometries/DecalGeometry.js";
import { PAINT_COLORS, PAINT_SIZES, paintPrefs, type PaintPrefs, type PaintSize } from "./prefs";
import type { SavedMark } from "./store";

export const MAX_PAINT_MARKS = 256;
export const PAINT_INTERVAL_MS = 100;
const FORWARD = new THREE.Vector3(0, 0, 1);
const CENTER = new THREE.Vector2();
type PaintMark = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

function paintable(mesh: THREE.Mesh, materialIndex: number): boolean {
  const mat = Array.isArray(mesh.material) ? mesh.material[materialIndex] : mesh.material;
  return !!mat && mat.visible && mat.depthTest && mat.colorWrite && mat.opacity >= 0.5;
}

/** Clip only triangles near the projector; avoid allocating DecalGeometry's vertices for an entire BSP mesh. */
function patch(mesh: THREE.Mesh, point: THREE.Vector3, normal: THREE.Vector3, diameter: number): THREE.BufferGeometry {
  const source = mesh.geometry;
  const pos = source.getAttribute("position");
  const index = source.getIndex();
  const localPoint = mesh.worldToLocal(point.clone());
  const inverse = mesh.matrixWorld.clone().invert();
  const radius = diameter * 0.75 * new THREE.Vector3().setFromMatrixScale(inverse).length();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const cross = new THREE.Vector3(), edge = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const vertices: number[] = [];
  const groups = source.groups.length ? source.groups : [{ start: 0, count: index?.count ?? pos.count, materialIndex: 0 }];
  for (const group of groups) {
    const mat = Array.isArray(mesh.material) ? mesh.material[group.materialIndex ?? 0] : mesh.material;
    if (!mat?.visible || !mat.depthTest || !mat.colorWrite || mat.opacity < 0.5) continue;
    for (let i = group.start; i + 2 < group.start + group.count; i += 3) {
      a.fromBufferAttribute(pos, index ? index.getX(i) : i);
      b.fromBufferAttribute(pos, index ? index.getX(i + 1) : i + 1);
      c.fromBufferAttribute(pos, index ? index.getX(i + 2) : i + 2);
      if (Math.max(a.x, b.x, c.x) < localPoint.x - radius || Math.min(a.x, b.x, c.x) > localPoint.x + radius ||
          Math.max(a.y, b.y, c.y) < localPoint.y - radius || Math.min(a.y, b.y, c.y) > localPoint.y + radius ||
          Math.max(a.z, b.z, c.z) < localPoint.z - radius || Math.min(a.z, b.z, c.z) > localPoint.z + radius) continue;
      cross.subVectors(b, a).cross(edge.subVectors(c, a)).applyNormalMatrix(normalMatrix);
      // Don't paint the other side of a thin wall or wrap the mark around a perpendicular corner.
      if (cross.dot(normal) < 0.5) continue;
      vertices.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  return geometry;
}

function paintTexture(): THREE.DataTexture {
  const n = 32;
  const bytes = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = (y * n + x) * 4;
    bytes[i] = bytes[i + 1] = bytes[i + 2] = 255;
    bytes[i + 3] = Math.round(255 * THREE.MathUtils.clamp((1 - Math.hypot((x + 0.5) / n * 2 - 1, (y + 0.5) / n * 2 - 1)) * 10, 0, 1));
  }
  const texture = new THREE.DataTexture(bytes, n, n);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Local rendering only. Mark geometry belongs to the hit mesh, so moving doors and platforms carry their paint. */
export class PaintOverlay {
  private meshes: THREE.Mesh[] = [];
  private marks: PaintMark[] = [];
  /** Saved marks not put back yet, and how many put-back ones lead `marks`. */
  private queue: SavedMark[] = [];
  private restored = 0;
  private texture: THREE.DataTexture | null = null;
  private readonly ray = new THREE.Raycaster(undefined, undefined, 0, 2048);
  private visible = true;
  private lastAt = -Infinity;
  private lastPoint: THREE.Vector3 | null = null;
  private lastMesh: THREE.Object3D | null = null;

  constructor(world: THREE.Object3D, private excluded: ReadonlySet<THREE.Object3D> = new Set()) {
    world.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.layers.isEnabled(0)) this.meshes.push(o as THREE.Mesh); });
  }
  get count(): number { return this.marks.length; }
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    for (const mark of this.marks) mark.visible = visible;
  }

  /** false = no paintable surface, true = placed. Held strokes are rate/spacing limited; single marks are immediate. */
  stamp(camera: THREE.Camera, prefs: PaintPrefs, now: number, held = false): boolean {
    if (held && now - this.lastAt < PAINT_INTERVAL_MS) return false;
    this.lastAt = now;
    camera.updateMatrixWorld();
    this.ray.setFromCamera(CENTER, camera);
    // Raycaster ignores Object3D.visible; filter hidden ancestors (including the skybox and alternate graphics meshes).
    const targets = this.meshes.filter((mesh) => {
      if (this.excluded.has(mesh)) return false;
      for (let p: THREE.Object3D | null = mesh; p; p = p.parent) if (!p.visible) return false;
      mesh.updateWorldMatrix(true, false);
      return true;
    });
    const hit = this.ray.intersectObjects(targets, false).find((h) => !!h.face && paintable(h.object as THREE.Mesh, h.face.materialIndex));
    if (!hit?.face) return false;
    const mesh = hit.object as THREE.Mesh;
    const p = paintPrefs(prefs);
    const diameter = PAINT_SIZES[p.size];
    if (held && this.lastMesh === mesh && this.lastPoint && this.lastPoint.distanceToSquared(hit.point) < (diameter * 0.15) ** 2) return false;
    const normal = hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld));
    const mark = this.place(mesh, hit.point, normal, p);
    if (!mark) return false;
    this.marks.push(mark);
    this.lastMesh = mesh;
    this.lastPoint = hit.point.clone();
    if (this.marks.length > MAX_PAINT_MARKS) this.dropOldest();
    return true;
  }

  /** Queues saved marks (store.ts) to be put back by restoreSome. */
  restore(saved: readonly SavedMark[]): void {
    this.queue.push(...saved);
  }
  get restoring(): boolean { return this.queue.length > 0; }
  /** Puts back queued marks within `budgetMs`, so a full map doesn't stall its first frame. A mark whose surface
   * isn't there any more (other graphics settings built other meshes) is dropped. */
  restoreSome(budgetMs: number, clock: () => number = () => performance.now()): void {
    const until = clock() + budgetMs;
    while (this.queue.length) {
      const s = this.queue.shift()!;
      const mark = this.restoreOne(s);
      if (mark) {
        this.marks.splice(this.restored++, 0, mark);
        if (this.marks.length > MAX_PAINT_MARKS) this.dropOldest();
      }
      if (clock() >= until) break;
    }
  }
  /** Every mark, oldest first, including saved ones not put back yet. */
  serialize(): SavedMark[] {
    const saved = (m: PaintMark) => m.userData.saved as SavedMark;
    return [...this.marks.slice(0, this.restored).map(saved), ...this.queue, ...this.marks.slice(this.restored).map(saved)].slice(-MAX_PAINT_MARKS);
  }

  private restoreOne(s: SavedMark): PaintMark | null {
    const color = PAINT_COLORS[s.c]?.[0], size = (Object.keys(PAINT_SIZES) as PaintSize[])[s.s];
    if (!color || !size) return null;
    const prefs = { color, size };
    const p = new THREE.Vector3(...s.p), n = new THREE.Vector3(...s.n).normalize();
    if (s.m >= 0) {
      // Brush models: the mark is in the mesh's own space, so a door or platform carries it wherever it is now.
      for (const mesh of this.meshes) {
        if (mesh.userData.sourceBrushModel !== s.m || this.excluded.has(mesh)) continue;
        mesh.updateWorldMatrix(true, false);
        const point = mesh.localToWorld(p.clone());
        const normal = n.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)).normalize();
        const mark = this.place(mesh, point, normal, prefs);
        if (mark) return mark;
      }
      return null;
    }
    const others = this.meshes.filter((mesh) => mesh.userData.sourceBrushModel === undefined && !this.excluded.has(mesh));
    for (const mesh of others) mesh.updateWorldMatrix(true, false);
    this.ray.set(p.clone().addScaledVector(n, 2), n.clone().negate());
    this.ray.far = 4;
    const hit = this.ray.intersectObjects(others, false).find((h) => !!h.face && paintable(h.object as THREE.Mesh, h.face.materialIndex));
    this.ray.far = 2048;
    if (!hit?.face) return null;
    const mesh = hit.object as THREE.Mesh;
    return this.place(mesh, hit.point, hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)).normalize(), prefs);
  }

  /** The decal for one mark, parented to `mesh`; null if no surface is under it. */
  private place(mesh: THREE.Mesh, point: THREE.Vector3, normal: THREE.Vector3, p: PaintPrefs): PaintMark | null {
    const diameter = PAINT_SIZES[p.size];
    const subset = patch(mesh, point, normal, diameter);
    const proxy = new THREE.Mesh(subset);
    proxy.matrixWorld.copy(mesh.matrixWorld);
    const orientation = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(FORWARD, normal));
    const geometry = new DecalGeometry(proxy, point, orientation, new THREE.Vector3(diameter, diameter, 2));
    subset.dispose();
    if (!geometry.getAttribute("position").count) { geometry.dispose(); return null; }
    const inverse = mesh.matrixWorld.clone().invert();
    geometry.applyMatrix4(inverse);
    this.texture ??= paintTexture();
    const material = new THREE.MeshBasicMaterial({ map: this.texture, color: p.color, transparent: true,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false });
    const mark = new THREE.Mesh(geometry, material);
    mark.name = "private-paint";
    mark.visible = this.visible;
    mark.raycast = () => {}; // paint can't paint itself, or obstruct other camera / world raycasts
    const model = mesh.userData.sourceBrushModel;
    const brush = typeof model === "number";
    const savedPoint = brush ? point.clone().applyMatrix4(inverse) : point;
    const savedNormal = brush ? normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(inverse)).normalize() : normal;
    mark.userData.saved = {
      m: brush ? model : -1, p: savedPoint.toArray(), n: savedNormal.toArray(),
      c: PAINT_COLORS.findIndex(([c]) => c === p.color), s: Object.keys(PAINT_SIZES).indexOf(p.size),
    } satisfies SavedMark;
    mesh.add(mark);
    return mark;
  }
  clear(): void {
    for (const mark of this.marks) this.remove(mark);
    this.marks.length = 0;
    this.queue.length = 0;
    this.restored = 0;
    this.lastPoint = this.lastMesh = null;
    this.lastAt = -Infinity;
  }
  dispose(): void { this.clear(); this.texture?.dispose(); this.texture = null; }
  private dropOldest(): void {
    this.remove(this.marks.shift()!);
    if (this.restored) this.restored--;
  }
  private remove(mark: PaintMark): void {
    mark.removeFromParent(); mark.geometry.dispose(); mark.material.dispose();
  }
}
