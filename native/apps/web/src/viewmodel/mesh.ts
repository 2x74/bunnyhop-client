// First-person viewmodel mesh: the bunny's gloved hands in hoodie sleeves (colourway palette slots, so they match the
// third-person bunny: hoodie sleeves, trim cuffs, gloves) holding the carrot blade. Built in code (no external assets)
// in the bind pose of the CS:S knife viewmodel skeleton (rig.ts), with skin weights on its bones: the sleeves on the
// forearm + wrist twist bones, the palm on the hand, each finger segment on its finger bone, the carrot on
// Knife_Handle. ~9k vertices, one draw call, the player materials (player/materials.ts). The hands come in the equipped
// glove style (gloves/fp.ts, one geometry per knife + glove style); the knife from the registry (knives/<id>.ts, built
// through knives/ctx.ts); the carrot and the knit glove are the defaults.

import * as THREE from "three";
import { Builder } from "../player/bunny/builder";
import type { GloveStyleId } from "../loadout";
import { buildFpHands } from "./gloves/fp";
import { carrot } from "./knives/carrot";
import { fpCtx } from "./knives/ctx";
import type { KnifeDef } from "./knives/types";

export function buildViewmodelGeometry(knife: KnifeDef = carrot, glove: GloveStyleId = "knit"): THREE.BufferGeometry {
  const b = new Builder();
  // --- Sleeves + gloved hands in the glove style (gloves/fp.ts; knit = the original glove).
  buildFpHands(b, glove);

  // --- The knife on Knife_Handle (+ its extra bones): knives/<id>.ts, the carrot by default.
  const k = fpCtx(b);
  knife.build(k);
  knife.tris ??= k.tris;

  const g = b.geometry();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -10, 0), 40);
  return g;
}

const cached = new Map<string, THREE.BufferGeometry>();

/**
 * The shared viewmodel geometry for a knife in a glove style (hands + knife, built once per pair, ~10 ms; the carrot
 * and the knit glove by default).
 */
export function viewmodelGeometry(knife: KnifeDef = carrot, glove: GloveStyleId = "knit"): THREE.BufferGeometry {
  const id = `${knife.id}|${glove}`;
  let g = cached.get(id);
  if (!g) cached.set(id, (g = buildViewmodelGeometry(knife, glove)));
  return g;
}
