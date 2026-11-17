// The Daily Challenge podium's data (ui/daily-podium.ts draws it, daily/podium-scene.ts is the 3D scene). DOM-free
// and three-free, so the rules are tested without a browser:
//   who stands where   podiumPlaces: the day's first three accounts from the board read, in its order. Nobody is ever
//                      added from anywhere else, so a player the server hides (shadowed: the board read never carries
//                      them for anyone else) can't appear.
//   what they wear     lookFrom: the colourway, the loadout (knife, finish, hilt, gloves, head item, back item and its
//                      settings) and the Supporter glow, as GET /runs/<id>?look=1 answers them: the player's bunny as
//                      others see it now, unlocks already re-checked by the server.
//   what changes       planPodium: which of the three places keeps its bunny, takes one that is already built from
//                      another place (two players swapped) or needs a new one. An unchanged place is never rebuilt.

import type { ApiPlayer, DailyEntry } from "../api";
import { cleanLoadout, DEFAULT_LOADOUT, packLoadout, type CosmeticLoadout } from "../loadout";
import { normalizeGlowColor, type PlayerGlow } from "../player/glow-config";
import { cosmetic, DEFAULT_COSMETICS } from "../progression";

export type Place = 1 | 2 | 3;
export const PLACES: readonly Place[] = [1, 2, 3];
export const METAL_OF: Record<Place, "gold" | "silver" | "bronze"> = { 1: "gold", 2: "silver", 3: "bronze" };

/** What a podium bunny is dressed in. */
export interface PodiumLook {
  /** "outfit-*" colourway id. */
  outfit: string;
  loadout: CosmeticLoadout;
  /** The Supporter glow, null: none. */
  glow: PlayerGlow | null;
}

export interface PodiumStanding {
  place: Place;
  player: ApiPlayer;
  runId: string;
  /** Seconds. */
  time: number;
  /** False: the run's replay is gone (the board read says so), so there is nothing to watch. */
  watch: boolean;
}

/** One place with its bunny's look (null: not known yet, or it couldn't be read: the plain default bunny). */
export interface PodiumSlot extends PodiumStanding {
  look: PodiumLook | null;
}

export const DEFAULT_LOOK: PodiumLook = Object.freeze({ outfit: DEFAULT_COSMETICS.outfit!, loadout: DEFAULT_LOADOUT, glow: null });

/**
 * The podium of a board read: its first three accounts, in the read's order (the server's ranking: time, then the
 * earlier run). Guests hold no podium place (apps/api src/daily.ts finalizeDay), so one in the list is passed over;
 * fewer than three accounts leaves the later places empty. A player appears once.
 */
export function podiumPlaces(entries: readonly DailyEntry[] | null | undefined): PodiumStanding[] {
  const out: PodiumStanding[] = [];
  const seen = new Set<string>();
  for (const e of entries ?? []) {
    if (out.length === 3) break;
    const p = e?.player;
    if (!p || typeof p.id !== "string" || !p.id || p.provider === "guest" || seen.has(p.id) || !e.runId) continue;
    seen.add(p.id);
    out.push({ place: (out.length + 1) as Place, player: p, runId: e.runId, time: e.time, watch: e.watch !== false });
  }
  return out;
}

/** A glow as the API sends it, or null (absent, switched off, or not a glow at all). */
export function glowFrom(raw: unknown): PlayerGlow | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  const color = normalizeGlowColor(g.color);
  if (g.enabled !== true || !color) return null;
  const intensity = typeof g.intensity === "number" && Number.isFinite(g.intensity) ? Math.min(1, Math.max(0, g.intensity)) : 0.7;
  return { enabled: true, aura: g.aura !== false, color, intensity };
}

/**
 * The look from GET /runs/<id>?look=1 (`player.look`, `player.playerGlow`). Unknown ids fall back to the defaults
 * (loadout.ts cleanLoadout); no look at all gives the plain default bunny, with the glow if there is one.
 */
export function lookFrom(raw: { look?: { outfit?: unknown; loadout?: unknown } | null; playerGlow?: unknown } | null | undefined): PodiumLook {
  const outfit = typeof raw?.look?.outfit === "string" ? cosmetic(raw.look.outfit) : null;
  return {
    outfit: outfit?.slot === "outfit" ? outfit.id : DEFAULT_LOOK.outfit,
    loadout: cleanLoadout(raw?.look?.loadout) ?? DEFAULT_LOADOUT,
    glow: glowFrom(raw?.playerGlow),
  };
}

/** Everything a bunny's model depends on, as one string: equal keys draw the same bunny. */
export function lookKey(l: PodiumLook): string {
  const g = l.glow;
  return `${l.outfit}|${packLoadout(l.loadout)}|${g ? `${g.color},${g.aura ? 1 : 0},${g.intensity.toFixed(2)}` : ""}`;
}

/** Staff items (moderator, admin, owner) are for their holders' eyes in the game; a picture that leaves it wears none. */
const staffItem = (id: string | null | undefined): boolean => {
  const u = cosmetic(id)?.unlock;
  return !!u && u.kind === "role" && u.role !== "contributor";
};

/**
 * The look for a picture posted outside the game (the Discord image): staff-only items are taken off (the knife, finish,
 * gloves and hilt go back to the defaults, a staff hat or back item comes off, a staff colourway becomes the default
 * one). Contributor items stay. Everything else is untouched.
 */
export function shareLook(l: PodiumLook): PodiumLook {
  const o = l.loadout;
  const loadout: CosmeticLoadout = { ...o };
  if (staffItem(o.knife)) loadout.knife = DEFAULT_LOADOUT.knife;
  if (staffItem(o.finish)) loadout.finish = DEFAULT_LOADOUT.finish;
  if (staffItem(o.glove)) loadout.glove = DEFAULT_LOADOUT.glove;
  if (staffItem(o.hilt)) delete loadout.hilt;
  if (staffItem(o.hat)) for (const k of ["hat", "hairColor", "hairLength", "hairHighlight", "maskOn"] as const) delete loadout[k];
  if (staffItem(o.back)) for (const k of ["back", "capeLength", "capeColor", "capeLining", "robePattern", "robeTied", "robeColor", "robePrint"] as const) delete loadout[k];
  return { outfit: staffItem(l.outfit) ? DEFAULT_LOOK.outfit : l.outfit, loadout, glow: l.glow };
}

/** What the scene has standing at a place: whose bunny and in which look. */
export interface Standing {
  id: string;
  key: string;
}

export type PlaceStep =
  /** Nothing to do: the same bunny in the same look (or the place stays empty). */
  | { kind: "keep" }
  /** The bunny built for place `from` (index) moves here: same player, same look. */
  | { kind: "move"; from: number }
  /** A bunny has to be built for this place. */
  | { kind: "build" }
  /** The place empties. */
  | { kind: "clear" };

/**
 * From what stands on the three places to what should: one step per place (index 0 = 1st). A bunny is only built when
 * no built bunny of that player in that look exists; a place that didn't change is left alone.
 */
export function planPodium(prev: readonly (Standing | null)[], next: readonly (Standing | null)[]): PlaceStep[] {
  const same = (a: Standing | null | undefined, b: Standing | null | undefined) => !!a && !!b && a.id === b.id && a.key === b.key;
  const taken = new Set<number>();
  // Places that keep theirs come first, so a bunny that stays isn't handed to another place.
  const steps: (PlaceStep | null)[] = [0, 1, 2].map((i) => {
    if (!next[i]) return prev[i] ? { kind: "clear" } : { kind: "keep" };
    if (same(prev[i], next[i])) {
      taken.add(i);
      return { kind: "keep" };
    }
    return null;
  });
  for (let i = 0; i < 3; i++) {
    if (steps[i]) continue;
    const from = [0, 1, 2].find((j) => j !== i && !taken.has(j) && same(prev[j], next[i]));
    if (from === undefined) steps[i] = { kind: "build" };
    else {
      taken.add(from);
      steps[i] = { kind: "move", from };
    }
  }
  return steps as PlaceStep[];
}

/** Captions and bunnies are in step when the standings match: the same players with the same runs and times in the same places. */
export const sameStandings = (a: readonly PodiumStanding[], b: readonly PodiumStanding[]): boolean =>
  a.length === b.length && a.every((x, i) => x.player.id === b[i].player.id && x.runId === b[i].runId && x.time === b[i].time && x.player.name === b[i].player.name && x.watch === b[i].watch);

/** What should stand at a place: whose bunny (`id`), in which look. */
export interface PodiumWant {
  id: string;
  look: PodiumLook;
}

/** A look read: the look, or "gone" when the server doesn't show that run to this viewer (hidden or invalidated). */
export type LookRead = PodiumLook | "gone";

/**
 * Reads of GET /runs/<id>?look=1 (`read`), one per run, kept `ttl` ms and shared by everyone who asks meanwhile. Never
 * rejects: a run that is gone for this viewer (`isGone`: the 404) reads "gone" and stays so for the ttl; any other
 * failure reads as the plain default bunny and is asked again next time.
 */
export function lookReader(read: (runId: string) => Promise<Parameters<typeof lookFrom>[0]>, isGone: (e: unknown) => boolean, ttl = 60_000): (runId: string, now?: number) => Promise<LookRead> {
  const cache = new Map<string, { at: number; look: Promise<LookRead> }>();
  return (runId, now = Date.now()) => {
    const hit = cache.get(runId);
    if (hit && now - hit.at < ttl) return hit.look;
    const entry = {
      at: now,
      look: read(runId).then(
        (p): LookRead => lookFrom(p),
        (e): LookRead => {
          if (isGone(e)) return "gone";
          if (cache.get(runId) === entry) cache.delete(runId);
          return DEFAULT_LOOK;
        },
      ),
    };
    cache.set(runId, entry);
    if (cache.size > 64) for (const [k, v] of cache) if (now - v.at >= ttl) cache.delete(k);
    return entry.look;
  };
}

/**
 * The standings with their look reads (same order), as what the scene should show (index 0 = 1st) and the captions
 * that go with it. A player whose run is gone for this viewer is in neither: no bunny, no name; their step stays empty
 * until the next board read moves the others up.
 */
export function dressPodium(standings: readonly PodiumStanding[], found: readonly LookRead[]): { want: (PodiumWant | null)[]; kept: PodiumStanding[] } {
  const want: (PodiumWant | null)[] = [null, null, null];
  const kept: PodiumStanding[] = [];
  standings.forEach((x, i) => {
    const look = found[i];
    if (!look || look === "gone" || x.place < 1 || x.place > 3) return;
    kept.push(x);
    want[x.place - 1] = { id: x.player.id, look };
  });
  return { want, kept };
}
