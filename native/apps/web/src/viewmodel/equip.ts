// Your held loadout (player/cosmetics.ts getHeldLoadout / onHeldLoadout: the equipped one, set by the card editor, with
// the knife pool's pick when a pool is active) -> the knife registry's equipped knife (knives/equipped.ts), which the viewmodel and your own player models follow. A knife the registry
// can't draw yet (not built) falls back to the carrot. Idempotent: the viewmodel and player models both call it.

import { getHeldLoadout, onHeldLoadout } from "../player/cosmetics";
import type { CosmeticLoadout } from "../loadout";
import { equipKnife } from "./knives/equipped";
import { knifeById, type KnifeDef } from "./knives/index";

let following = false;

/** Registry knife for a loadout (null = the carrot, also for knives that aren't built). */
export const knifeOf = (l: Pick<CosmeticLoadout, "knife"> | null | undefined): KnifeDef | null => {
  const k = knifeById(l?.knife);
  return k && k.id !== "carrot" ? k : null;
};

/** Starts mirroring the equipped loadout's knife into knives/equipped.ts (once). */
export function followLoadout(): void {
  if (following) return;
  following = true;
  // The held loadout: the knife pool's pick when one is active (player/cosmetics.ts getHeldLoadout).
  equipKnife(knifeOf(getHeldLoadout()));
  onHeldLoadout((l) => equipKnife(knifeOf(l)));
}
