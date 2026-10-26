// Unlock notices: which unlocks a player has already been told about (a celebration card), per account, on any device.
// DOM-free rules shared by the client (ui/unlocks.ts keeps the set in localStorage and syncs it) and the API
// (apps/api src/notices.ts stores it: migrations/0031_unlock_notices.sql, GET /players/:id `notices` for your own
// profile, POST /me/notices).
//
// A notice id is an achievement id or a cosmetic id (progression.ts), or one of NOTICE_KEYS. "New" dots (viewed or not,
// ui/unlocks.ts unseen) are a separate, per-device matter: a dot stays until you look; a celebration happens once.

import { achievement, COSMETICS } from "./progression";

/**
 * The account's baseline was taken: everything it owned then counts as told. Until it's set (an account that has never
 * been through this, here or anywhere), nothing but what the caller is announcing right now is celebrated.
 */
export const NOTICE_BASELINE = "baseline";
/** Staff: "Everything unlocked", said once. */
export const NOTICE_STAFF_ALL = "staff:all";
export const NOTICE_KEYS: readonly string[] = [NOTICE_BASELINE, NOTICE_STAFF_ALL];

/** Most ids one POST /me/notices may carry (every achievement + cosmetic + the keys fits). */
export const MAX_NOTICE_IDS = 1000;

const COSMETIC_IDS = new Set(COSMETICS.map((c) => c.id));

/** An id the server stores: a known achievement or cosmetic (exact id, no aliases), or one of NOTICE_KEYS. */
export function noticeIdOk(id: unknown): id is string {
  if (typeof id !== "string" || id.length > 64) return false;
  return NOTICE_KEYS.includes(id) || !!achievement(id) || COSMETIC_IDS.has(id);
}

export interface NoticeClaim {
  /** Candidates not told before: celebrate these (in the caller's order, no duplicates). */
  announce: string[];
  /** Ids to add to the account's set (the announced ones, plus the baseline when it's taken now). */
  record: string[];
}

/**
 * Which of `candidates` to announce, given what the account has been told (`known`: this device's set merged with the
 * server's) and what it owns now (`owned`, from the account's own profile). The first claim for an account takes the
 * baseline: everything owned that isn't being announced right now is recorded as told, so a new device, cleared storage
 * or an older account never gets "everything you own" announced again. Announcing is idempotent: an id is returned
 * once, then it's in `record` and so in `known` from then on.
 */
export function claimNotices(known: ReadonlySet<string>, owned: Iterable<string>, candidates: Iterable<string>): NoticeClaim {
  const announce: string[] = [];
  for (const id of candidates) if (!known.has(id) && !announce.includes(id)) announce.push(id);
  const record = [...announce];
  if (!known.has(NOTICE_BASELINE)) {
    record.push(NOTICE_BASELINE);
    for (const id of owned) if (!known.has(id) && !record.includes(id)) record.push(id);
  }
  return { announce, record };
}
