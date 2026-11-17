// A charm on its own (v0.0.43), for the unlock card and the Loadout's tiles (notify/item3d-scenes.ts charmScene): its
// mesh with its bail and the ring through it (no chain, no mount), still, facing the camera, in the first-person material (the knife hardware shading,
// your colourway for the Bun and the Lantern's light).

import * as THREE from "three";
import { colourway, paletteOf } from "../../player/bunny/palettes";
import { playerUniforms, solidMaterial } from "../../player/materials";
import { DEFAULT_LOADOUT } from "../../loadout";
import { applyLoadoutUniforms } from "../finishes/shader";
import { CB, charmDef, charmGeometry } from "./meshes";

const still = new Map<string, THREE.BufferGeometry>();

/** The charm's own triangles (bones 3 and 4: the charm, its moving part, its bail) as a plain mesh, centred on its middle (charm-local). */
function bodyGeometry(id: string): THREE.BufferGeometry | null {
  const def = charmDef(id);
  if (!def) return null;
  let g = still.get(id);
  if (g) return g;
  const src = charmGeometry(def);
  const SI = src.getAttribute("skinIndex");
  const keep: number[] = [];
  const n = src.getAttribute("position").count;
  const own = (v: number) => SI.getX(v) === CB.body || SI.getX(v) === CB.part;
  for (let v = 0; v + 2 < n; v += 3) if (own(v) && own(v + 1) && own(v + 2)) keep.push(v);
  g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) {
    if (name === "skinIndex" || name === "skinWeight") continue;
    const a = attr as THREE.BufferAttribute;
    const out = new (a.array.constructor as new (n: number) => THREE.TypedArray)(keep.length * 3 * a.itemSize);
    keep.forEach((v, j) => out.set((a.array as THREE.TypedArray).subarray(v * a.itemSize, (v + 3) * a.itemSize), j * 3 * a.itemSize));
    g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize, a.normalized));
  }
  g.computeBoundingBox();
  g.translate(...(g.boundingBox!.getCenter(new THREE.Vector3()).multiplyScalar(-1).toArray() as [number, number, number]));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  still.set(id, g);
  return g;
}

/** The charm as a three object (three's axes: y up, facing +z), its radius, and how to free it. */
export function charmShowcase(id: string, outfit?: string): { root: THREE.Object3D; radius: number; dispose(): void } | null {
  const g = bodyGeometry(id);
  if (!g) return null;
  const u = playerUniforms();
  const c = colourway(outfit);
  const pal = paletteOf(c);
  u.uPalette.value.forEach((col, i) => col.set(pal[i]));
  u.uAccent.value.set(c.accent);
  const look = applyLoadoutUniforms(u, DEFAULT_LOADOUT, undefined, true);
  const mat = solidMaterial(u, look);
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  // Charm-local (x right, y away from the viewer, z up) -> three (x right, y up, z toward the viewer).
  mesh.rotation.set(-Math.PI / 2, 0, 0);
  const root = new THREE.Group();
  root.add(mesh);
  return { root, radius: g.boundingSphere!.radius, dispose: () => mat.dispose() };
}
