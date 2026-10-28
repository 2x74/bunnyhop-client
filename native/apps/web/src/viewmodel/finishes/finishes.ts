// Dev lab vocabulary (vmlab.html ?vmfinish=, knifelab.html &fin=): a finish as the URL spells it, mapped onto the
// production finish path (shader.ts in the player solid material, Viewmodel.setFinishOverride). Production uses item
// ids (loadout.ts FINISH_STYLE); the labs take either a design name ("nebula") or an item id ("fin-nebula", or a
// retired v0.0.5 id, which resolves like a saved loadout does). Each finish is one fixed design: nothing else to pick.
// Not imported by production code.

import { FINISH_STYLE, finishStyle, type FinishKind } from "../../loadout";
import { cosmetic } from "../../progression";
import { FINISH_CODE, type FinishSpec as ShaderSpec } from "./shader";

export type FinishId = FinishKind;

export interface FinishSpec {
  finish: FinishId;
}

/** Every design, in catalogue order ("none" first). */
export const FINISH_IDS = Object.values(FINISH_STYLE).map((f) => f.kind);

/** "nebula", "fin-nebula" or a retired id -> the design ("none" for anything unknown). */
export function parseFinish(s: string | null | undefined): FinishId {
  if (!s) return "none";
  if (s in FINISH_CODE) return s as FinishId;
  return finishStyle(s).kind;
}

/** The catalogue item id of a design ("nebula" -> "fin-nebula"). */
export const finishItemId = (k: FinishId): string => Object.entries(FINISH_STYLE).find(([, f]) => f.kind === k)?.[0] ?? "fin-garden";

/** The player-facing name of a design ("Nebula"). */
export const finishName = (k: FinishId): string => cosmetic(finishItemId(k))?.name ?? k;

export const toShaderSpec = (s: FinishSpec): ShaderSpec | null => (s.finish === "none" ? null : { kind: s.finish });
