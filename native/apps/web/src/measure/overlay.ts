import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { SurfaceRay } from "../surface-ray";

export function measureDistance(a: ArrayLike<number>, b: ArrayLike<number>): { distance: number; horizontal: number; height: number } {
  // Three coordinates: y is up. No player-hull padding: this is the actual point-to-point gap.
  const dx = b[0] - a[0], height = b[1] - a[1], dz = b[2] - a[2];
  return { distance: Math.hypot(dx, height, dz), horizontal: Math.hypot(dx, dz), height };
}
/** A jump's upward speed (CS:S gamemovement: sqrt(2 * 800 * 57), whatever the gravity). */
export const JUMP_SPEED = Math.sqrt(2 * 800 * 57);
/** The player hull's width: a jump clears this much of a gap for free (half of it on each edge). */
const HULL = 32;

/**
 * About the horizontal speed (u/s) a plain jump from the first point needs to land on the second, `height` above it
 * (0.0.44): airtime until it falls back to that height, t = (v + sqrt(v² - 2g·h)) / g, over the gap less the hull.
 * Null when the second point is higher than a jump reaches. An estimate: a crouch jump lifts the feet a little more,
 * and ticks round the airtime.
 */
export function speedNeeded(horizontal: number, height: number, gravity = 800): number | null {
  const d = JUMP_SPEED * JUMP_SPEED - 2 * gravity * height;
  if (d < -1e-6) return null; // (exactly a jump's height rounds either way)
  const t = (JUMP_SPEED + Math.sqrt(Math.max(0, d))) / gravity;
  return Math.max(0, horizontal - HULL) / t;
}

export function measureText(r: ReturnType<typeof measureDistance>, gravity?: number): string {
  const base = `${r.distance.toFixed(2)} u, gap ${r.horizontal.toFixed(2)}, ${r.height >= 0 ? "+" : ""}${r.height.toFixed(2)}`;
  if (gravity === undefined) return base;
  const v = speedNeeded(r.horizontal, r.height, gravity);
  return `${base}, ${v === null ? "too high to jump" : v < 1 ? "needs no speed" : `needs ~${Math.round(v)} u/s`}`;
}
type Point = { mesh: THREE.Object3D; local: THREE.Vector3 };
export class MeasureOverlay {
  readonly root = new THREE.Group();
  readonly line = new LineSegments2(new LineSegmentsGeometry().setPositions(new Float32Array(6)), new LineMaterial({ color: 0xffffff, linewidth: 2, depthTest: true, depthWrite: false, toneMapped: false }));
  private ray: SurfaceRay;
  private points: Point[] = [];
  private markers = [0x9cecb7, 0xa5caff].map(color => new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshBasicMaterial({ color, wireframe: true, depthTest: true, depthWrite: false, toneMapped: false })));
  private last = "";
  /** The style's gravity (session settings), for the speed a jump across needs: measure/index.ts keeps it current. */
  gravity = 800;
  constructor(world: THREE.Object3D, scene: THREE.Object3D, sky: ReadonlySet<THREE.Object3D> = new Set()) {
    this.ray = new SurfaceRay(world, sky); this.root.name = "private-measurement";
    for (const o of [this.line, ...this.markers]) { o.raycast = () => {}; o.visible = false; this.root.add(o); }
    scene.add(this.root);
  }
  get count(): number { return this.points.length; }
  pick(camera: THREE.Camera): boolean {
    const hit = this.ray.pick(camera);
    if (!hit) return false;
    if (this.points.length === 2) this.clear();
    this.points.push({ mesh: hit.object, local: hit.object.worldToLocal(hit.point.clone()) });
    this.update(); return true;
  }
  update(): { text: string; midpoint: THREE.Vector3 } | null {
    const positions = this.points.map((p, i) => {
      p.mesh.updateWorldMatrix(true, false);
      const v = p.mesh.localToWorld(p.local.clone());
      let visible = true;
      for (let parent: THREE.Object3D | null = p.mesh; parent; parent = parent.parent) if (!parent.visible) visible = false;
      this.markers[i].position.copy(v); this.markers[i].visible = visible; return v;
    });
    if (positions.length !== 2 || this.markers.some(m => !m.visible)) { this.line.visible = false; return null; }
    const [a, b] = positions, values = [...a.toArray(), ...b.toArray()], key = values.join();
    if (key !== this.last) { this.line.geometry.setPositions(values); this.last = key; }
    this.line.visible = true;
    return { text: measureText(measureDistance(a.toArray(), b.toArray()), this.gravity), midpoint: a.clone().lerp(b, 0.5) };
  }
  labelVisible(camera: THREE.Camera, point: THREE.Vector3): boolean { return this.ray.visible(camera.getWorldPosition(new THREE.Vector3()), point); }
  clear(): void { this.points.length = 0; this.last = ""; for (const o of [this.line, ...this.markers]) o.visible = false; }
  dispose(): void {
    this.clear(); this.root.removeFromParent();
    for (const o of [this.line, ...this.markers]) { o.geometry.dispose(); o.material.dispose(); }
  }
}
