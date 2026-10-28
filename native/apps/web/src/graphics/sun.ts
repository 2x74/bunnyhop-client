import * as THREE from "three";
/** Authored light direction only; reject sources behind the camera or outside the screen margin. */
export function projectSun(camera: THREE.PerspectiveCamera, direction: THREE.Vector3): THREE.Vector2 | null {
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const normalized = direction.clone().normalize();
  if (forward.dot(normalized) <= .05) return null;
  const projected = camera.getWorldPosition(new THREE.Vector3()).addScaledVector(normalized, Math.min(camera.far * .9, 40000)).project(camera);
  const x = projected.x * .5 + .5, y = projected.y * .5 + .5;
  return x > -.1 && x < 1.1 && y > -.1 && y < 1.1 ? new THREE.Vector2(x, y) : null;
}
/** A positive toe preserves detail in baked dark rooms while applying a mild contrast pivot. */
export function gradeChannel(value: number, contrast: number): number { return Math.max(0,value) ** contrast * .18 ** (1-contrast); }
