// The Wavedash SDK (window.Wavedash, injected by the platform into the game frame) for the Wavedash build: loading
// progress, the player's identity (exchanged for a bunnyhop.lol session: apps/api/src/wavedash.ts), launch parameters
// (invite links), the host page's clipboard, and Wavedash's own stats, achievements and leaderboards. Every call is a
// no-op outside the Wavedash build or when the SDK is missing. research/WAVEDASH.md.
//
// Wavedash's stats / achievements / boards are written from the browser (their SDK has no server path), so they carry
// no anticheat guarantee of their own: every value comes from our server's verified totals (the player's profile),
// never from client events, and bunnyhop.lol's boards stay the real ones.

import { WAVEDASH, WAVEDASH_GAME_URL } from "./env";

type Res<T> = { success: boolean; data: T; message?: string };
interface WavedashSdk {
  init(config?: { debug?: boolean; deferEvents?: boolean }): boolean;
  updateLoadProgressZeroToOne(p: number): void;
  getUserId(): string | null | undefined;
  getUsername(id?: string): string | null | undefined;
  getUserJwt(): Promise<Res<string>>;
  copyLink(url: string): Promise<boolean>;
  requestStats(): Promise<Res<unknown>>;
  setStat(id: string, value: number, storeNow?: boolean): boolean;
  setAchievement(id: string, storeNow?: boolean): boolean;
  storeStats(): boolean;
  getOrCreateLeaderboard(name: string, sort: number, display: number): Promise<Res<{ id: string }>>;
  uploadLeaderboardScore(id: string, score: number, keepBest: boolean): Promise<Res<unknown>>;
}

const sdk = (): WavedashSdk | null => (WAVEDASH && typeof window !== "undefined" ? ((window as unknown as { Wavedash?: WavedashSdk }).Wavedash ?? null) : null);

/** The SDK, waiting up to `ms` for the platform to inject it. */
async function sdkReady(ms = 6000): Promise<WavedashSdk | null> {
  if (!WAVEDASH) return null;
  for (let t = 0; t < ms; t += 100) {
    const s = sdk();
    if (s) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  return sdk();
}

let started = false;
/** Loading progress 0..1 on Wavedash's loading screen (before ready()). */
export function wavedashProgress(p: number): void {
  if (started) return;
  try {
    sdk()?.updateLoadProgressZeroToOne(Math.max(0, Math.min(1, p)));
  } catch {
    /* platform hiccup: never block the game */
  }
}

/** The game is up: Wavedash hides its loading screen and shows the frame. Once; safe to call early or often. */
export function wavedashReady(): void {
  if (!WAVEDASH || started) return;
  const s = sdk();
  if (!s) {
    // Not injected yet: try again shortly (the SDK script may still be loading).
    void sdkReady().then((x) => x && !started && wavedashReady());
    return;
  }
  started = true;
  try {
    s.updateLoadProgressZeroToOne(1);
    s.init({ debug: false });
  } catch (e) {
    console.error("Wavedash init failed", e);
  }
}

/** The signed-in Wavedash player's gameplay JWT and name, or null (no SDK, or a player Wavedash didn't sign in). */
export async function wavedashCredentials(): Promise<{ token: string; username: string } | null> {
  // A fresh build can take a while to start, and the player's id a little longer: give both time.
  const s = await sdkReady(15_000);
  if (!s) return null;
  wavedashReady();
  for (let i = 0; i < 200 && !s.getUserId(); i++) await new Promise((r) => setTimeout(r, 100));
  if (!s.getUserId()) return null;
  const r = await s.getUserJwt();
  if (!r.success || typeof r.data !== "string") throw new Error(r.message ?? "Wavedash sign-in failed");
  return { token: r.data, username: s.getUsername() ?? "" };
}

/** The Wavedash player id (to check the session belongs to them), or null. */
export function wavedashUserId(): string | null {
  try {
    return sdk()?.getUserId() || null;
  } catch {
    return null;
  }
}

/** A Wavedash game-page link with launch parameters (wvdsh_ prefixed): what invites share from this build. */
export function wavedashLink(params: Record<string, string>): string {
  const u = new URL(WAVEDASH_GAME_URL);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(`wvdsh_${k}`, v);
  return u.toString();
}

/**
 * Copies `url` through the host page (the frame has no clipboard of its own); Wavedash shows a toast. Must run inside
 * a click. False when it couldn't.
 */
export async function wavedashCopy(url: string): Promise<boolean> {
  try {
    return !!(await sdk()?.copyLink(url));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Platform stats, achievements, boards (definitions: tools/wavedash/setup.ts)

/** What the server says about the signed-in player (their own profile). */
export interface CareerTotals {
  maps: number;
  wrs: number;
  top10s: number;
  pbs: number;
  bonuses: number;
  jumps: number;
  level: number;
  points: number;
  /** Finished runs. */
  runs: number;
  /** Clears per tier, by tier number (index 1 = T1; Profile.stats.clearsByTier). */
  clearsByTier: number[];
}

/** Wavedash stat identifiers ← totals. Achievements unlock from these on Wavedash's side (stat thresholds). */
export const WAVEDASH_STATS: Record<string, (c: CareerTotals) => number> = {
  maps_cleared: (c) => c.maps,
  world_records: (c) => c.wrs,
  top_tens: (c) => c.top10s,
  personal_bests: (c) => c.pbs,
  bonus_clears: (c) => c.bonuses,
  jumps: (c) => c.jumps,
  level: (c) => c.level,
  points: (c) => Math.round(c.points),
  runs: (c) => c.runs,
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((t) => [`t${t}_clears`, (c: CareerTotals) => c.clearsByTier[t] ?? 0])),
};

/** Wavedash boards (numeric, highest first) ← totals. */
export const WAVEDASH_BOARDS: [name: string, value: (c: CareerTotals) => number][] = [
  ["points", (c) => Math.round(c.points)],
  ["world-records", (c) => c.wrs],
  ["maps-cleared", (c) => c.maps],
];

let syncing = false;
let lastSynced = "";
const boardIds = new Map<string, string>();

/** Copies the player's verified totals to Wavedash. Best effort: platform failures retry on the next call. */
export async function syncWavedashCareer(totals: CareerTotals): Promise<void> {
  const s = sdk();
  if (!s || !s.getUserId() || syncing) return;
  const signature = JSON.stringify(totals);
  if (signature === lastSynced) return;
  syncing = true;
  try {
    const loaded = await s.requestStats();
    if (!loaded.success) return;
    let ok = true;
    for (const [id, f] of Object.entries(WAVEDASH_STATS)) {
      const v = f(totals);
      if (Number.isFinite(v) && v >= 0 && !s.setStat(id, v)) ok = false;
    }
    if (!s.storeStats()) ok = false;
    for (const [name, f] of WAVEDASH_BOARDS) {
      const v = f(totals);
      if (!(v > 0)) continue;
      let id = boardIds.get(name);
      if (!id) {
        const b = await s.getOrCreateLeaderboard(name, 1, 0); // DESC, NUMERIC
        if (!b.success) return;
        id = b.data.id;
        boardIds.set(name, id);
      }
      const posted = await s.uploadLeaderboardScore(id, v, true);
      if (!posted.success) ok = false;
    }
    if (ok) lastSynced = signature;
  } catch {
    /* keep the game usable during platform outages */
  } finally {
    syncing = false;
  }
}
