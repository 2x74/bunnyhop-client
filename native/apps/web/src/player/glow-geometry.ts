import * as THREE from "three";

const smoothed = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
const halos = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
/** The shell's geometry for a body: the body's, plus `glowNormal` (smoothed across seams). Cached per body. */
export function shellGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const hit = smoothed.get(source);
  if (hit) return hit;
  const positions = source.getAttribute("position"),
    normals = source.getAttribute("normal"),
    bones = source.getAttribute("skinIndex");
  // Smoothed normals: vertices at the same place on the same bones (seams) share the sum of their normals. Each
  // vertex's key is made once and its group kept by index (this runs in the frame a new body first glows).
  const n = positions.count;
  const group = new Int32Array(n);
  const ids = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = `${positions.getX(i).toFixed(4)},${positions.getY(i).toFixed(4)},${positions.getZ(i).toFixed(4)}:${bones.getX(i)},${bones.getY(i)},${bones.getZ(i)},${bones.getW(i)}`;
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = ids.size));
    group[i] = id;
  }
  const sums = new Float64Array(ids.size * 3);
  for (let i = 0; i < n; i++) {
    const g = group[i] * 3;
    sums[g] += normals.getX(i);
    sums[g + 1] += normals.getY(i);
    sums[g + 2] += normals.getZ(i);
  }
  // (As Vector3.normalize: times 1 / length, a zero sum stays zero.)
  for (let g = 0; g < sums.length; g += 3) {
    const inv = 1 / (Math.sqrt(sums[g] * sums[g] + sums[g + 1] * sums[g + 1] + sums[g + 2] * sums[g + 2]) || 1);
    sums[g] *= inv;
    sums[g + 1] *= inv;
    sums[g + 2] *= inv;
  }
  const result = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const g = group[i] * 3;
    result[i * 3] = sums[g];
    result[i * 3 + 1] = sums[g + 1];
    result[i * 3 + 2] = sums[g + 2];
  }
  return seedShellGeometry(source, result);
}

/** The worker computes identical normals; shell and halo still share the source buffers as before. */
export function seedShellGeometry(source: THREE.BufferGeometry, normals: Float32Array): THREE.BufferGeometry {
  const hit = smoothed.get(source);
  if (hit) return hit;
  const geometry = source.clone();
  geometry.setAttribute("glowNormal", new THREE.BufferAttribute(normals, 3));
  source.addEventListener("dispose", () => {
    geometry.dispose();
    halos.get(source)?.dispose();
    smoothed.delete(source);
    halos.delete(source);
  });
  smoothed.set(source, geometry);
  return geometry;
}
/** The halo's layers: how far each is pushed out (units) and how faint it is, innermost first. */
export const HALO_LAYERS = 8;
export const haloWidth = (layer: number): number => 0.85 + layer * 0.52;
export const haloAlpha = (layer: number): number => 0.08 * (1 - layer / HALO_LAYERS) ** 1.15;

/**
 * The halo: the shell drawn HALO_LAYERS times, each layer pushed further out and fainter, in one instanced draw. The
 * layers share the shell's vertex buffers (glowWidth / glowAlpha are per layer), so a body's halo costs no geometry of
 * its own; it used to be eight copies of it (~20 MB of arrays and as much GPU memory per body). Drawn in the same
 * order (layer by layer), additively.
 */
export function haloGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const hit = halos.get(source);
  if (hit) return hit;
  const base = shellGeometry(source);
  const geometry = new THREE.InstancedBufferGeometry();
  for (const [name, attr] of Object.entries(base.attributes)) geometry.setAttribute(name, attr);
  if (base.index) geometry.setIndex(base.index);
  const widths = new Float32Array(HALO_LAYERS),
    alphas = new Float32Array(HALO_LAYERS);
  for (let layer = 0; layer < HALO_LAYERS; layer++) {
    widths[layer] = haloWidth(layer);
    alphas[layer] = haloAlpha(layer);
  }
  geometry.setAttribute("glowWidth", new THREE.InstancedBufferAttribute(widths, 1));
  geometry.setAttribute("glowAlpha", new THREE.InstancedBufferAttribute(alphas, 1));
  geometry.instanceCount = HALO_LAYERS;
  // (Disposed with the shell, whose buffers it shares: see shellGeometry.)
  halos.set(source, geometry);
  return geometry;
}

export const hasShellGeometry = (source: THREE.BufferGeometry): boolean => smoothed.has(source);
