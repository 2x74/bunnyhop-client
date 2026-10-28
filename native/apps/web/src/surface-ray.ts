import * as THREE from "three";

/** Visible map surfaces only: ignore sky, transparent backgrounds and invisible ancestors. */
export class SurfaceRay {
  private meshes: THREE.Mesh[] = [];
  private ray = new THREE.Raycaster(undefined, undefined, 0, 8192);
  constructor(world: THREE.Object3D, private excluded: ReadonlySet<THREE.Object3D> = new Set()) {
    world.traverse(o => { if ((o as THREE.Mesh).isMesh && o.layers.isEnabled(0)) this.meshes.push(o as THREE.Mesh); });
  }
  pick(camera: THREE.Camera): THREE.Intersection<THREE.Object3D> | undefined {
    camera.updateMatrixWorld(); this.ray.setFromCamera(new THREE.Vector2(), camera);
    return this.intersect();
  }
  visible(from: THREE.Vector3, point: THREE.Vector3): boolean {
    const distance = from.distanceTo(point);
    this.ray.set(from, point.clone().sub(from).normalize()); this.ray.far = Math.max(0, distance - 2);
    const hit = this.intersect(); this.ray.far = 8192;
    return !hit;
  }
  private intersect(): THREE.Intersection<THREE.Object3D> | undefined {
    const targets = this.meshes.filter(mesh => {
      if (this.excluded.has(mesh)) return false;
      for (let p: THREE.Object3D | null = mesh; p; p = p.parent) if (!p.visible) return false;
      mesh.updateWorldMatrix(true, false); return true;
    });
    return this.ray.intersectObjects(targets, false).find(h => {
      const material = (h.object as THREE.Mesh).material;
      const mat = Array.isArray(material) ? material[h.face?.materialIndex ?? 0] : material;
      return !!h.face && !!mat && mat.visible && mat.depthTest && mat.colorWrite && mat.opacity >= 0.5;
    });
  }
}
