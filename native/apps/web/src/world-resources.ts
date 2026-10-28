import * as THREE from "three";

// Release unique geometries, materials and material-owned textures across a world tree.
export function disposeWorldTree(root: THREE.Object3D): void {
  const seen = new Set<unknown>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !seen.has(m.geometry)) {
      seen.add(m.geometry);
      m.geometry.dispose();
    }
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats) {
      if (seen.has(mat)) continue;
      seen.add(mat);
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture && !seen.has(v)) (seen.add(v), v.dispose());
      // Textures a ShaderMaterial holds in its uniforms (imposter.ts cube maps) are listed here.
      for (const v of (mat.userData.ownedTextures ?? []) as THREE.Texture[]) if (!seen.has(v)) (seen.add(v), v.dispose());
      mat.dispose();
    }
  });
}
