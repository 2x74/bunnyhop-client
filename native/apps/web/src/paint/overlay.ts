import * as THREE from "three";
import { DecalGeometry } from "three/addons/geometries/DecalGeometry.js";
import { PAINT_SIZES, paintPrefs, type PaintPrefs } from "./prefs";

export const MAX_PAINT_MARKS = 256;
export const PAINT_INTERVAL_MS = 100;
const FORWARD = new THREE.Vector3(0, 0, 1);
const CENTER = new THREE.Vector2();

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
  private marks: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];
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
    const hit = this.ray.intersectObjects(targets, false).find((h) => {
      const material = (h.object as THREE.Mesh).material;
      const mat = Array.isArray(material) ? material[h.face?.materialIndex ?? 0] : material;
      return !!h.face && !!mat && mat.visible && mat.depthTest && mat.colorWrite && mat.opacity >= 0.5;
    });
    if (!hit?.face) return false;
    const mesh = hit.object as THREE.Mesh;
    const p = paintPrefs(prefs);
    const diameter = PAINT_SIZES[p.size];
    if (held && this.lastMesh === mesh && this.lastPoint && this.lastPoint.distanceToSquared(hit.point) < (diameter * 0.15) ** 2) return false;
    const normal = hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld));
    const subset = patch(mesh, hit.point, normal, diameter);
    const proxy = new THREE.Mesh(subset);
    proxy.matrixWorld.copy(mesh.matrixWorld);
    const orientation = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(FORWARD, normal));
    const geometry = new DecalGeometry(proxy, hit.point, orientation, new THREE.Vector3(diameter, diameter, 2));
    subset.dispose();
    if (!geometry.getAttribute("position").count) { geometry.dispose(); return false; }
    geometry.applyMatrix4(mesh.matrixWorld.clone().invert());
    this.texture ??= paintTexture();
    const material = new THREE.MeshBasicMaterial({ map: this.texture, color: p.color, transparent: true,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false });
    const mark = new THREE.Mesh(geometry, material);
    mark.name = "private-paint";
    mark.visible = this.visible;
    mark.raycast = () => {}; // paint can't paint itself, or obstruct other camera / world raycasts
    mesh.add(mark);
    this.marks.push(mark);
    this.lastMesh = mesh;
    this.lastPoint = hit.point.clone();
    if (this.marks.length > MAX_PAINT_MARKS) this.remove(this.marks.shift()!);
    return true;
  }
  clear(): void {
    for (const mark of this.marks) this.remove(mark);
    this.marks.length = 0;
    this.lastPoint = this.lastMesh = null;
    this.lastAt = -Infinity;
  }
  dispose(): void { this.clear(); this.texture?.dispose(); this.texture = null; }
  private remove(mark: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>): void {
    mark.removeFromParent(); mark.geometry.dispose(); mark.material.dispose();
  }
}
