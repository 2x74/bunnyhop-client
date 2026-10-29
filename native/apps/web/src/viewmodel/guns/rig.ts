// First-person gun rig and geometry: the viewmodel's hands rig (viewmodel/rig.ts: v_knife_t's skeleton, both arms) plus
// the gun's own bones appended after it, so the gloved hands (gloves/fp.ts, every glove style) skin exactly as they do
// with a knife, and the gun is one more part of the same geometry: hands + gun = one SkinnedMesh, one draw call.
//
// Gun bones (all with an identity bind at the gun origin, so a part's skinning matrix is simply its posed matrix):
//   Gun_Body   the gun (frame, barrel, grip, sights)
//   Gun_Slide  the slide / bolt / charging handle (recoils, racks)
//   Gun_Mag    the magazine (drops out, rides in the left hand, goes back in)
//   Gun_Pump   the shotgun's fore-end (pumps; the left hand rides on it)
//   Gun_Aux    whatever the left hand brings in (a shotgun shell)
//   Gun_Sil    a silencer (GunDef.silencer: the Cottontail's), built seated on the muzzle; collapsed while it's off
//   Gun_Trig   the trigger (swings back about GunDef.trigger with the squeeze)

import * as THREE from "three";
import { Builder } from "../../player/bunny/builder";
import type { GloveStyleId } from "../../loadout";
import { buildFpHands } from "../gloves/fp";
import { KnifeCtx } from "../knives/ctx";
import { vmRig, type VmRig } from "../rig";
import { bakeGunAO } from "./ao";
import type { GunDef, GunPart } from "./types";

export const GUN_BONES = ["Gun_Body", "Gun_Slide", "Gun_Mag", "Gun_Pump", "Gun_Aux", "Gun_Sil", "Gun_Trig"] as const;
const PART_BONE: Record<GunPart, number> = { Gun: 0, Slide: 1, Mag: 2, Pump: 3, Aux: 4, Sil: 5, Trig: 6 };

export interface GunRig {
  /** The hands' rig (bones 0 .. hands.names.length - 1). */
  hands: VmRig;
  /** Total bones (hands + gun). */
  count: number;
  /** Bone index of a gun part. */
  part(p: GunPart): number;
  /** Bone index of a builder bone name ("Gun_Slide"). */
  bone(name: string): number;
}

let cached: GunRig | null = null;

export function gunRig(): GunRig {
  if (cached) return cached;
  const hands = vmRig();
  const n = hands.names.length;
  const byName = new Map<string, number>(GUN_BONES.map((b, i) => [b, n + i]));
  cached = {
    hands,
    count: n + GUN_BONES.length,
    part: (p) => n + PART_BONE[p],
    bone: (name) => byName.get(name) ?? n,
  };
  return cached;
}

/** First-person context: gun-local = bind space (the gun bones' bind is the identity); parts weighted to their bone. */
export function gunFpCtx(b: Builder): KnifeCtx {
  const r = gunRig();
  return new KnifeCtx(b, "fp", (p) => p, (bone) => [[r.bone(bone ?? "Gun_Body"), 1]]);
}

function build(def: GunDef, glove: GloveStyleId): THREE.BufferGeometry {
  const b = new Builder();
  buildFpHands(b, glove);
  const k = gunFpCtx(b);
  def.build(k);
  def.silencer?.build(k);
  def.tris ??= k.tris;
  const g = b.geometry();
  // Soft AO in the gun's recesses (guns/ao.ts), the hands untouched.
  const SI = g.getAttribute("skinIndex"), firstGun = gunRig().hands.names.length;
  bakeGunAO(g, (v) => SI.getX(v) >= firstGun);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 60);
  return g;
}

const geos = new Map<string, THREE.BufferGeometry>();

/** Hands (in the glove style) + the gun, built once per pair (~10 ms). */
export function gunGeometry(def: GunDef, glove: GloveStyleId = "knit"): THREE.BufferGeometry {
  const id = `${def.id}|${glove}`;
  let g = geos.get(id);
  if (!g) geos.set(id, (g = build(def, glove)));
  return g;
}
