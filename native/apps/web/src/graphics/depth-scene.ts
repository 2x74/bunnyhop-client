import * as THREE from "three";

/** Depth overrides cannot reproduce billboard vertex shaders or transparent/sky silhouettes. */
export class OpaqueDepthScene {
  private proxies = new Map<THREE.Mesh, { source: THREE.BufferGeometry; geometry: THREE.BufferGeometry }>();
  run<T>(scene: THREE.Scene, draw: () => T, include: (material: THREE.Material) => boolean = () => true): T {
    const hidden: [THREE.Object3D, boolean][] = [];
    const swapped: [THREE.Mesh, THREE.BufferGeometry][] = [];
    const previousOverride = scene.overrideMaterial;
    scene.traverse(object => {
      if (!(object instanceof THREE.Mesh) || !object.visible) return;
      const source = object.geometry as THREE.BufferGeometry;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const allowed = (index: number) => { const m = materials[index]; return !!m && m.visible && !m.transparent && m.colorWrite && m.depthWrite && include(m); };
      if (object.renderOrder < -900 || source.getAttribute("center") || !materials.some((_, i) => allowed(i))) {
        hidden.push([object, object.visible]); object.visible = false; return;
      }
      if (!source.groups.length || source.groups.every(group => allowed(group.materialIndex ?? 0))) return;
      let cached = this.proxies.get(object);
      if (!cached || cached.source !== source) {
        cached?.geometry.dispose();
        const geometry = new THREE.BufferGeometry();
        for (const [name, attribute] of Object.entries(source.attributes)) geometry.setAttribute(name, attribute);
        geometry.setIndex(source.index); geometry.boundingBox = source.boundingBox; geometry.boundingSphere = source.boundingSphere;
        cached = { source, geometry }; this.proxies.set(object, cached);
      }
      cached.geometry.clearGroups();
      for (const group of source.groups) if (allowed(group.materialIndex ?? 0)) cached.geometry.addGroup(group.start, group.count, group.materialIndex);
      cached.geometry.drawRange = { ...source.drawRange };
      swapped.push([object, source]); object.geometry = cached.geometry;
    });
    try { return draw(); } finally {
      scene.overrideMaterial = previousOverride;
      for (const [mesh, geometry] of swapped) mesh.geometry = geometry;
      for (const [object, visible] of hidden) object.visible = visible;
    }
  }
  dispose(): void { for (const { geometry } of this.proxies.values()) geometry.dispose(); this.proxies.clear(); }
}
