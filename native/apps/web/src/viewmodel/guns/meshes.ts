// Gun geometry outside the viewmodel (no materials, no DOM): the world / dropped model and the bunny's third-person gun.
// Same builders as first person (guns/models/*) at the third-person detail (k.view "tp": fewer segments), cached.

import * as THREE from "three";
import { Builder } from "../../player/bunny/builder";
import { xform, type V3 } from "../../player/bunny/rig";
import { gunHoldData, type GunHoldData } from "../../player/bunny/gun-hold";
import { KnifeCtx } from "../knives/ctx";
import type { GunDef } from "./types";
import { camoTpGeometry } from "./camo";
import { camoStyle } from "../../camo";
import { bakeGunAO } from "./ao";

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

const modelGeos = new Map<string, THREE.BufferGeometry>();

/**
 * The gun alone at first-person detail in gun-local units (x forward, z up), every part where it sits at rest, with its
 * AO: the Loadout's gun camo stage and thumbnails (ui/camo-stage.ts), the gun lab's side views. Non-skinned, cached.
 */
export function gunModelGeometry(def: GunDef): THREE.BufferGeometry {
  let g = modelGeos.get(def.id);
  if (g) return g;
  const b = new Builder();
  def.build(new KnifeCtx(b, "fp", (p) => p, () => [[0, 1]]));
  g = b.geometry();
  bakeGunAO(g);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  modelGeos.set(def.id, g);
  return g;
}

/** The gun's extent in gun-local units (the world model's box), for the bunny's hold (the butt of the stock). */
export function gunExtent(def: GunDef): { min: V3; max: V3 } {
  const g = worldGunGeometry(def);
  if (!g.boundingBox) g.computeBoundingBox();
  const b = g.boundingBox!;
  return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
}

/** The bunny's hold data of a gun (player/bunny/gun-hold.ts), its butt from the world model's extent. */
export function bunnyHold(def: GunDef): GunHoldData {
  return gunHoldData(def, () => gunExtent(def));
}

const tpGeos = new Map<string, THREE.BufferGeometry>();

/**
 * The gun in the bunny's hands: built into the bunny's bind space with the right fist on its grip (gun-hold.ts
 * gunHoldData bake), skinned to the gun mesh's own two bones: 0 the gun (= R_Hand's skinning matrix while the hand
 * grips it), 1 the magazine (it rides in the left hand during a reload). A SkinnedMesh on a two-bone skeleton the
 * bunny writes each frame (player/bunny/model.ts). Cached per gun.
 */
export function bunnyGunGeometry(def: GunDef, _bone?: number): THREE.BufferGeometry {
  // (`_bone`: the hand bone the gun used to be skinned to; ignored, kept so older callers still type-check.)
  return bunnyGeometry(def, def.build, "");
}

/**
 * The gun's silencer on the bunny, seated at the muzzle (same placement as bunnyGunGeometry, bone 0): a separate small
 * mesh the bunny shows while it's on (PlayerModel.setGunSilencer). Null for a gun without one.
 */
export function bunnySilencerGeometry(def: GunDef): THREE.BufferGeometry | null {
  return def.silencer ? bunnyGeometry(def, def.silencer.build, "|sil") : null;
}

function bunnyGeometry(def: GunDef, build: GunDef["build"], tag: string): THREE.BufferGeometry {
  const key = `${def.id}${tag}`;
  let g = tpGeos.get(key);
  if (g) return g;
  const bake = bunnyHold(def).bake;
  const b = new Builder();
  // (Builders name parts' bones through guns/shapes.ts boneOf: the magazine's is "Gun_Mag".)
  build(new KnifeCtx(b, "tp", (p) => xform(bake, 0, p), (bone) => [[bone === "Gun_Mag" || bone === "Mag" ? 1 : 0, 1]]));
  g = b.geometry();
  tpGeos.set(key, g);
  return g;
}

const dressed = new Map<string, { gun: THREE.BufferGeometry; silencer: THREE.BufferGeometry | null }>();
export const dressedGunKey = (id: string, camo?: string | null): string => `${id}|${camo ?? ""}`;
export const hasDressedGun = (key: string): boolean => dressed.has(key);
export function seedDressedGun(key: string, gun: THREE.BufferGeometry, silencer: THREE.BufferGeometry | null): void {
  if (!dressed.has(key)) dressed.set(key, { gun, silencer });
}
/** Third-person gun and camo, prebuilt in the worker for room joiners. */
export function dressedGunGeometry(def: GunDef, camo?: string | null) {
  const key = dressedGunKey(def.id, camo);
  let hit = dressed.get(key);
  if (!hit) {
    const sil = bunnySilencerGeometry(def);
    hit = { gun: camoTpGeometry(bunnyGunGeometry(def), camo, camoStyle(camo)), silencer: sil && camoTpGeometry(sil, camo, camoStyle(camo)) };
    dressed.set(key, hit);
  }
  return hit;
}
