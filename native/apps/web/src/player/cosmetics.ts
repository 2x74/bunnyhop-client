// Cosmetic ghost + trail colours and the bunny colourway (unlocked by playing; chosen in the profile card editor). DOM-free apart from
// localStorage, so ghost.ts and the editor can share it without importing each other.
//
// Hook: getGhostCosmetics() → { ghost, trail } CSS colours (+ ghost2 / trail2: the rim glow and trail tail of two-tone
// items) for YOUR PB ghost; onGhostCosmetics(fn) to restyle live.
// The card editor calls setGhostCosmetics() with ids from progression.ts COSMETICS (validated server-side when
// online); offline the choice is local only and limited to the free colours by the editor.

import { cosmetic, DEFAULT_COSMETICS } from "../progression";
import { cleanLoadout, DEFAULT_LOADOUT, sameLoadout, type CosmeticLoadout } from "../loadout";
import { GHOST_CSS } from "./colors";

const KEY = "bunnyhop:ghost-cosmetics";

export interface GhostCosmetics {
  /** progression.ts cosmetic ids. */
  ghostId: string;
  trailId: string;
  /** Resolved colours. */
  ghost: string;
  trail: string;
  /**
   * Second colours (progression.ts CosmeticDef.color2; the main colour when the item has none): the ghost's rim glow
   * (PlayerModelOptions.rim) and the trail's tail (Trail color2).
   */
  ghost2: string;
  trail2: string;
}

type Listener = (c: GhostCosmetics) => void;
const listeners = new Set<Listener>();

function resolve(ghostId: string | null | undefined, trailId: string | null | undefined): GhostCosmetics {
  const g = cosmetic(ghostId);
  const t = cosmetic(trailId);
  const gid = g?.slot === "ghost" ? g.id : DEFAULT_COSMETICS.ghost!;
  const tid = t?.slot === "trail" ? t.id : DEFAULT_COSMETICS.trail!;
  const gc = cosmetic(gid), tc = cosmetic(tid);
  const ghost = gc?.color ?? GHOST_CSS.pb, trail = tc?.color ?? GHOST_CSS.pb;
  return { ghostId: gid, trailId: tid, ghost, trail, ghost2: gc?.color2 ?? ghost, trail2: tc?.color2 ?? trail };
}

export function getGhostCosmetics(): GhostCosmetics {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as { ghost?: string; trail?: string };
    return resolve(v.ghost, v.trail);
  } catch {
    return resolve(null, null);
  }
}

export function setGhostCosmetics(ghostId: string | null, trailId: string | null): void {
  const c = resolve(ghostId, trailId);
  try {
    localStorage.setItem(KEY, JSON.stringify({ ghost: c.ghostId, trail: c.trailId }));
  } catch {
    /* private mode */
  }
  for (const l of listeners) l(c);
}

export function onGhostCosmetics(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// ---------------------------------------------------------------------------------------------
// Bunny colourway (progression slot "outfit"): what YOUR bunny wears in third person, replays and the menu. Chosen in
// the card editor (validated server-side, unlocked by playing) or Settings -> Graphics (free colourways plus any the
// account has unlocked, remembered here whenever the card editor loads them).

const OUTFIT_KEY = "bunnyhop:outfit";
const UNLOCKED_KEY = "bunnyhop:outfit-unlocked";
const outfitListeners = new Set<(id: string) => void>();

function validOutfit(id: string | null | undefined): string {
  const c = cosmetic(id);
  return c?.slot === "outfit" ? c.id : DEFAULT_COSMETICS.outfit!;
}

export function getOutfit(): string {
  try {
    return validOutfit(localStorage.getItem(OUTFIT_KEY));
  } catch {
    return DEFAULT_COSMETICS.outfit!;
  }
}

export function setOutfit(id: string | null): void {
  const v = validOutfit(id);
  try {
    localStorage.setItem(OUTFIT_KEY, v);
  } catch {
    /* private mode */
  }
  for (const l of outfitListeners) l(v);
}

export function onOutfit(l: (id: string) => void): () => void {
  outfitListeners.add(l);
  return () => outfitListeners.delete(l);
}

/** Colourway ids the account has unlocked (as last seen from the server), for the Settings picker. */
export function knownOutfitUnlocks(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(UNLOCKED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function rememberUnlocks(ids: readonly string[]): void {
  try {
    localStorage.setItem(UNLOCKED_KEY, JSON.stringify(ids.filter((id) => cosmetic(id)?.slot === "outfit")));
  } catch {
    /* private mode */
  }
}

// ---------------------------------------------------------------------------------------------
// First-person loadout (progression slots "knife" / "finish" / "glove"; loadout.ts): what YOUR viewmodel, your bunny in
// third person and your replays show. Chosen in the card editor (validated server-side, unlocked by playing) and
// remembered here, so the game shows it before any profile loads.

const LOADOUT_KEY = "bunnyhop:loadout";
const loadoutListeners = new Set<(l: CosmeticLoadout) => void>();

export function getLoadout(): CosmeticLoadout {
  try {
    return cleanLoadout(JSON.parse(localStorage.getItem(LOADOUT_KEY) ?? "null")) ?? { ...DEFAULT_LOADOUT };
  } catch {
    return { ...DEFAULT_LOADOUT };
  }
}

export function setLoadout(l: CosmeticLoadout): void {
  const v = cleanLoadout(l) ?? { ...DEFAULT_LOADOUT };
  const prev = getLoadout();
  try {
    localStorage.setItem(LOADOUT_KEY, JSON.stringify(v));
  } catch {
    /* private mode */
  }
  if (sameLoadout(prev, v)) return;
  for (const fn of loadoutListeners) fn(v);
}

export function onLoadout(fn: (l: CosmeticLoadout) => void): () => void {
  loadoutListeners.add(fn);
  return () => loadoutListeners.delete(fn);
}

// Entitlement is provided by the account API; no stored local config grants supporter glow.
let playerGlow: import("./glow-config").PlayerGlow | null = null;
let glowRevision = 0;
const glowListeners = new Set<(value: import("./glow-config").PlayerGlow | null) => void>();
export function getPlayerGlow(): import("./glow-config").PlayerGlow | null { return playerGlow; }
/** Async account reads must not overwrite a newer saved glow or room update. */
export function playerGlowRevision(): number { return glowRevision; }
export function setPlayerGlow(value: import("./glow-config").PlayerGlow | null): void { glowRevision++; playerGlow = value; glowListeners.forEach(fn => fn(value)); }
export function onPlayerGlow(fn: (value: import("./glow-config").PlayerGlow | null) => void): () => void { glowListeners.add(fn); return () => glowListeners.delete(fn); }
