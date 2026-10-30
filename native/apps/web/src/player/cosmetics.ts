// Cosmetic ghost + trail colours and the bunny colourway (unlocked by playing; chosen in the profile card editor). DOM-free apart from
// localStorage, so ghost.ts and the editor can share it without importing each other.
//
// Hook: getGhostCosmetics() → { ghost, trail } CSS colours (+ ghost2 / trail2: the rim glow and trail tail of two-tone
// items) for YOUR PB ghost; onGhostCosmetics(fn) to restyle live.
// The card editor calls setGhostCosmetics() with ids from progression.ts COSMETICS (validated server-side when
// online); offline the choice is local only and limited to the free colours by the editor.

import { cosmetic, DEFAULT_COSMETICS } from "../progression";
import { cleanLoadout, DEFAULT_LOADOUT, nextPoolIndex, poolActive, sameLoadout, withPick, type CosmeticLoadout, type KnifePool } from "../loadout";
import { knifePoolOf } from "../progression";
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
  emitHeld();
}

export function onLoadout(fn: (l: CosmeticLoadout) => void): () => void {
  loadoutListeners.add(fn);
  return () => loadoutListeners.delete(fn);
}

// ---------------------------------------------------------------------------------------------
// Knife pool (progression.ts KnifePool, saved with the cosmetics): the knife the game holds is the pool's pick, and
// getHeldLoadout() is the equipped loadout holding it. The viewmodel, your bunny, its room roster entry (net/mp.ts)
// and the run's replay trailer (session.ts) follow the held loadout; the Loadout screen edits the equipped one.
// The pick moves on at a map load (main.ts) and, with swap "restart", on every restart; it never changes mid-run.

const POOL_KEY = "bunnyhop:knife-pool";
const PICK_KEY = "bunnyhop:knife-pool-pick";
const heldListeners = new Set<(l: CosmeticLoadout) => void>();
let lastHeld: CosmeticLoadout | null = null;

/** The saved pool (items checked against the catalogue only; the server checks unlocks), or null. */
export function getKnifePool(): KnifePool | null {
  try {
    return knifePoolOf(JSON.parse(localStorage.getItem(POOL_KEY) ?? "null"), () => true);
  } catch {
    return null;
  }
}

export function setKnifePool(p: KnifePool | null | undefined): void {
  const v = knifePoolOf(p ?? null, () => true);
  try {
    if (v) localStorage.setItem(POOL_KEY, JSON.stringify(v));
    else localStorage.removeItem(POOL_KEY);
  } catch {
    /* private mode */
  }
  emitHeld();
}

const pickIndex = (): number => {
  try {
    const n = Number(localStorage.getItem(PICK_KEY));
    return Number.isInteger(n) && n >= 0 ? n : -1;
  } catch {
    return -1;
  }
};

/** The equipped loadout holding the pool's current pick (the equipped one itself without an active pool). */
export function getHeldLoadout(): CosmeticLoadout {
  const l = getLoadout();
  const p = getKnifePool();
  return poolActive(p) ? withPick(l, p, Math.max(0, pickIndex())) : l;
}

/** The equipped loadout holding each of the pool's knives in turn ([] without an active pool): what to build ahead. */
export function poolPicks(): CosmeticLoadout[] {
  const l = getLoadout();
  const p = getKnifePool();
  return poolActive(p) ? p.items.map((_, i) => withPick(l, p, i)) : [];
}

/**
 * A map loaded ("map") or the run restarted ("restart"): the pool moves on to its next knife when its swap says so.
 * Returns whether the held knife changed.
 */
export function advanceKnifePool(event: "map" | "restart"): boolean {
  const p = getKnifePool();
  if (!poolActive(p) || (event === "restart" && p.swap !== "restart")) return false;
  const at = pickIndex();
  // The very first pick: the first item in order, any one at random.
  const next = at < 0 ? (p.order === "random" ? Math.floor(Math.random() * p.items.length) : 0) : nextPoolIndex(p, at);
  try {
    localStorage.setItem(PICK_KEY, String(next));
  } catch {
    /* private mode */
  }
  return emitHeld();
}

/** Tells the held-loadout listeners when the held look changed; returns whether it did. */
function emitHeld(): boolean {
  const v = getHeldLoadout();
  if (lastHeld && sameLoadout(lastHeld, v)) return false;
  lastHeld = v;
  for (const fn of heldListeners) fn(v);
  return true;
}

/** The held loadout changes (a pool swap, or the equipped loadout changing under it). */
export function onHeldLoadout(fn: (l: CosmeticLoadout) => void): () => void {
  if (!lastHeld) lastHeld = getHeldLoadout();
  heldListeners.add(fn);
  return () => heldListeners.delete(fn);
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
