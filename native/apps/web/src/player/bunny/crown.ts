// The crown a bunny wears while its player holds overall #1 / #2 / #3 (progression.ts crownOf, carried in the cosmetic
// loadout: room roster, replays, ghosts). Built in code like mesh.ts, in the bunny's bind pose and skinned to the head
// bone, so it rides the CS:S animations: a five-point band sitting on the hood with the ears poking through it, gems
// on the front. Gold with rubies (#1), silver with sapphires (#2), bronze with emeralds (#3). A separate small mesh
// sharing the bunny's skeleton and material (one extra draw call, only for crowned players).

import * as THREE from "three";
import { Builder, ring, type Paint, type Wt } from "./builder";
import { rig, type V3 } from "./rig";

const TIERS: Record<1 | 2 | 3, { metal: number; dark: number; gem: number }> = {
  1: { metal: 0xffcf3d, dark: 0xc8891e, gem: 0xe0213b },
  2: { metal: 0xdfe6f0, dark: 0x8f9bb0, gem: 0x2a6df0 },
  3: { metal: 0xd9934e, dark: 0x8f5a2e, gem: 0x18b85a },
};

const fixed = (color: number): Paint => ({ code: 0, color });

function build(tier: 1 | 2 | 3): THREE.BufferGeometry {
  const r = rig();
  const W: Wt = [[r.bone("Head1"), 1]];
  const t = TIERS[tier];
  const b = new Builder();
  // On the hood (centre (0, 0.55, 69.35), radii ~5.5 / 6): its section at z 74 is ~3.3 x 3.6.
  const c = (z: number): V3 => [0, 0.45, z];
  const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0];
  const N = 40;
  const spikes = (k: number) => Math.pow(Math.max(0, Math.cos((k / N) * Math.PI * 2 * 5 + Math.PI / 2)), 3);
  const band = [ring(c(73.6), X, Y, 3.55, 3.85, N), ring(c(74.3), X, Y, 3.62, 3.92, N), ring(c(75.3), X, Y, 3.7, 4.0, N)];
  // Points: the top row rises at five spikes (the front one centred on -y, the face side).
  const top = ring(c(75.3), X, Y, 3.78, 4.08, N).map((p, k): V3 => [p[0], p[1], p[2] + 2.3 * spikes(k)]);
  b.surface([...band, top], { paint: (i) => fixed(i === 0 ? t.dark : t.metal), weight: () => W });
  // A rolled rim at the base.
  b.surface([ring(c(73.45), X, Y, 3.5, 3.8, N), ring(c(73.6), X, Y, 3.72, 4.02, N), ring(c(73.85), X, Y, 3.68, 3.98, N)], { paint: () => fixed(t.dark), weight: () => W });
  // Gems: one on the front, two on the sides; balls on the spike tips.
  const gem = (p: V3, rad: number, color: number) => b.surface(b.ellipsoidRows(p, [rad, rad, rad], [0, 0, 1], [1, 0, 0], 10, 6), { paint: () => fixed(color), weight: () => W, closed: true });
  gem([0, 0.45 - 4.05, 74.55], 0.62, t.gem);
  gem([-3.3, 0.45 - 2.3, 74.5], 0.42, t.gem);
  gem([3.3, 0.45 - 2.3, 74.5], 0.42, t.gem);
  top.forEach((p, k) => {
    if (spikes(k) > 0.999) gem([p[0], p[1], p[2] + 0.25], 0.32, t.metal);
  });
  const g = b.geometry();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 70), 60);
  return g;
}

const cache = new Map<number, THREE.BufferGeometry>();

/** The crown geometry for a place (built once each). */
export function crownGeometry(tier: 1 | 2 | 3): THREE.BufferGeometry {
  let g = cache.get(tier);
  if (!g) cache.set(tier, (g = build(tier)));
  return g;
}

/** Already built (or seeded) for this tier. */
export const hasCrownGeometry = (tier: 1 | 2 | 3): boolean => cache.has(tier);

/** A crown built elsewhere (prebuild.ts, in a worker), unless one is already there. */
export function seedCrownGeometry(tier: 1 | 2 | 3, g: THREE.BufferGeometry): void {
  if (!cache.has(tier)) cache.set(tier, g);
}
