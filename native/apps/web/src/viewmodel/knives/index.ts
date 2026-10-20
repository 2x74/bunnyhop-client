// Knife registry (research/COSMETICS-PLAN.md §2.1): every blade the viewmodel and the bunny can draw, built in code
// in our art style (vegetables, the carrot palette, accent guards). Ids match progression.ts ("knife-<id>").
//
//   knifeById("karrotbit") / knifeByCosmetic("knife-karrotbit") -> KnifeDef (types.ts)
//   first person:  Viewmodel.setKnife(def) or equipKnife(def) (equipped.ts)
//   third person:  new PlayerModel({ knife: def }) / model.setKnife(def); the bunny's geometry per knife is cached
//
// Each file: knives/<id>.ts (mesh builder in the knife-local frame, first-person hold, per-action pose, pivots).

import { bunnyfly } from "./bunnyfly";
import { candycane } from "./candycane";
import { carrot } from "./carrot";
import { cleaver } from "./cleaver";
import { daikon } from "./daikon";
import { golden } from "./golden";
import { karrotbit } from "./karrotbit";
import { thistle } from "./thistle";
import { thornback } from "./thornback";
import type { KnifeDef } from "./types";

export const KNIVES: readonly KnifeDef[] = [carrot, karrotbit, bunnyfly, daikon, cleaver, candycane, golden, thornback, thistle];

const byId = new Map(KNIVES.flatMap((k) => [[k.id, k] as const, [k.cosmeticId, k] as const]));

/** A knife by registry id ("karrotbit") or cosmetic id ("knife-karrotbit"); undefined if not built. */
export function knifeById(id: string | null | undefined): KnifeDef | undefined {
  return id ? byId.get(id) : undefined;
}

export const knifeByCosmetic = knifeById;

export type { KnifeDef } from "./types";
