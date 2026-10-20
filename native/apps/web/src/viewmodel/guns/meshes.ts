// Gun geometry outside the viewmodel (no materials, no DOM): the world / dropped model and the bunny's third-person gun.
// Same builders as first person (guns/models/*) at the third-person detail (k.view "tp": fewer segments), cached.

import * as THREE from "three";
import { Builder } from "../../player/bunny/builder";
import { rig as bunnyRig, xform, type V3 } from "../../player/bunny/rig";
import { KnifeCtx } from "../knives/ctx";
import type { GunDef } from "./types";

const geos = new Map<string, THREE.BufferGeometry>();

/** The gun alone in gun-local Source units (x forward, z up), third-person detail; non-skinned, cached. */
export function worldGunGeometry(def: GunDef): THREE.BufferGeometry {
  let g = geos.get(def.id);
  if (g) return g;
  const b = new Builder();
  def.build(new KnifeCtx(b, "tp", (p) => p, () => [[0, 1]]));
  g = b.geometry();
  g.computeBoundingSphere();
  geos.set(def.id, g);
  return g;
}

const tpGeos = new Map<string, THREE.BufferGeometry>();

/**
 * The gun on the bunny's right hand (bunny bind space through GunDef.tp, skinned 100% to `bone`): a SkinnedMesh on the
 * bunny's skeleton follows the hand with no per-frame work. Cached per gun + bone.
 */
export function bunnyGunGeometry(def: GunDef, bone: number): THREE.BufferGeometry {
  return bunnyGeometry(def, bone, def.build, "");
}

/**
 * The gun's silencer on the bunny's right hand, seated at the muzzle (same placement and skinning as bunnyGunGeometry):
 * a separate small mesh the bunny shows while it's on (PlayerModel.setGunSilencer). Null for a gun without one.
 */
export function bunnySilencerGeometry(def: GunDef, bone: number): THREE.BufferGeometry | null {
  return def.silencer ? bunnyGeometry(def, bone, def.silencer.build, "|sil") : null;
}

function bunnyGeometry(def: GunDef, bone: number, build: GunDef["build"], tag: string): THREE.BufferGeometry {
  const key = `${def.id}|${bone}${tag}`;
  let g = tpGeos.get(key);
  if (g) return g;
  const r = bunnyRig();
  const hand = r.bone("R_Hand");
  const H = r.bind.subarray(hand * 12, hand * 12 + 12);
  const tp = def.tp;
  const x = norm(tp.x);
  const z0 = norm(tp.z);
  // z ⟂ x
  const d = x[0] * z0[0] + x[1] * z0[1] + x[2] * z0[2];
  const z = norm([z0[0] - x[0] * d, z0[1] - x[1] * d, z0[2] - x[2] * d]);
  const y: V3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const s = tp.s;
  const b = new Builder();
  build(
    new KnifeCtx(
      b,
      "tp",
      (p) => xform(H, 0, [tp.o[0] + (x[0] * p[0] + y[0] * p[1] + z[0] * p[2]) * s, tp.o[1] + (x[1] * p[0] + y[1] * p[1] + z[1] * p[2]) * s, tp.o[2] + (x[2] * p[0] + y[2] * p[1] + z[2] * p[2]) * s]),
      () => [[bone, 1]],
    ),
  );
  g = b.geometry();
  tpGeos.set(key, g);
  return g;
}

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
