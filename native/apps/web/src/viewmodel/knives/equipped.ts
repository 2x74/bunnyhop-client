// The knife YOUR bunny holds (first person, your third-person bunny, your PB ghost), like player/cosmetics.ts's
// colourway: a tiny store the viewmodel and player models listen to. It holds the registry entry itself (not an id),
// so nothing here pulls in the knife builders; whoever equips by id imports knives/index.ts (knifeById).
//
// Nothing calls equipKnife() in production yet: the carrot stays until the cosmetic slot (loadout.ts / card editor)
// wires it. Dev: ?vmknife=<id> (knives/dev.ts). Other players / replays pass their own knife to PlayerModel
// ({ knife }) instead, like `outfit`.

import type { KnifeDef } from "./types";

let current: KnifeDef | null = null;
const listeners = new Set<(k: KnifeDef | null) => void>();

/** The equipped knife, or null for the default carrot. */
export function equippedKnife(): KnifeDef | null {
  return current;
}

/** Equips a knife (null = the carrot) and tells the viewmodel and player models. */
export function equipKnife(k: KnifeDef | null): void {
  if (k?.id === "carrot") k = null;
  if (k === current) return;
  current = k;
  for (const l of listeners) l(k);
}

export function onKnife(l: (k: KnifeDef | null) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
