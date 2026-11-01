// Runs whose upload failed (v0.0.10): kept on this device with the kind of failure, and sent again. The rules
// (DOM-free, tested in apps/api/test/uploads.test.ts); upload-store.ts keeps them in IndexedDB, online.ts sends them.
//
// Every finished ranked run is written here before its upload ("uploading") and removed once the server has taken it
// (or refused it for a reason a retry can't change: a rejection the end card shows). It stays when the upload failed in
// a way a retry can fix, with the failure recorded at that moment:
//   too_large    the server refused the size (413; before v0.0.10 the cap was 1 MiB, so a 1 h run never fit),
//   network      no answer (offline, a 5xx),
//   interrupted  the tab closed mid-upload (still "uploading" on the next load),
//   guest_limit  no account yet, and the network had made too many new players lately (a shared network; v0.0.10),
//   rate_limited the player's submissions claim more run time than the last hour had (runs.ts enforceRunTimeGuard).
// The last two only mean "not yet": the run waits, with nothing used up, until the server can take it (holds), or until
// KEEP_MS has passed. A session is what guest_limit waits for, and online.ts retryStoredUploads sends nothing until it
// has one. network and interrupted get MAX_SEND_ATTEMPTS sends (a resend is safe: the server dedups a player's uploads
// by hash), too_large one. All of it runs on the next load and on a timer in this one, and only for the account that
// recorded the run. A run refused for having no session belonged to nobody: it goes to whoever this browser is later.
//
// Before v0.0.10 nothing was recorded. One legacy path covers those runs: a stored local PB replay (pb.ts) over the old
// 1 MiB cap was certainly refused, so it is queued here once (as too_large) and retried like the others, if its header
// names the signed-in player. Nothing else from before v0.0.10 is retried.

import type { ReplayHeader } from "./replay";

export type UploadFailure = "too_large" | "network" | "interrupted" | "guest_limit" | "rate_limited";

export interface StoredUpload {
  /** sha256 of the bytes (the key; the server dedups a player's uploads by it too). */
  sha: string;
  bytes: Uint8Array;
  map: string;
  style: string;
  track: number;
  /** Run time in seconds (for messages). */
  time: number;
  /**
   * The run's signed heartbeat tokens (run-clock.ts), sent again with the retry. Absent for legacy records and runs
   * from before v0.0.10: the server then notes "no-session" (a note, never a rejection).
   */
  beats?: string[];
  /** Preserve the attempt when a disconnected upload is retried. */
  gauntlet?: string | null;
  mouse?: import("./mouse-settings").MouseSettings | null;
  /** Account (user id) that played it; retried only for that account. */
  account: string | null;
  state: "uploading" | "failed";
  failure?: UploadFailure;
  /** The automatic retries have been used. */
  retried: boolean;
  /** Sends counted against MAX_SEND_ATTEMPTS. Absent: none. */
  attempts?: number;
  /** Queued by the legacy path (a pre-v0.0.10 PB replay over the old cap). */
  legacy?: boolean;
  at: number;
}

/** The upload cap before v0.0.10 (apps/api/src/replay-io.ts LEGACY_MAX_REPLAY_BYTES). */
export const LEGACY_UPLOAD_LIMIT = 1 << 20;
/** An "uploading" record older than this (from an earlier page) is an interrupted upload. */
export const INTERRUPTED_AFTER_MS = 2 * 60_000;
/** Records whose retries are used up, and runs still waiting (see `holds`), are dropped after this. */
export const KEEP_MS = 30 * 24 * 3600_000;
/** Sends of a run that failed for the connection or a closed tab. Each may be a blip, so one failure can't end it. */
export const MAX_SEND_ATTEMPTS = 6;
/** How often a page with waiting runs looks again: doubling from the first, up to the last. */
export const HOLD_FIRST_MS = 2 * 60_000;
export const HOLD_MAX_MS = 60 * 60_000;
/** localStorage: when this browser started recording upload failures (the first v0.0.10 load). */
export const TRACKING_SINCE_KEY = "bunnyhop:uploads:since";
/** localStorage, per account: the legacy PB scan ran. */
export const legacyScanKey = (account: string) => `bunnyhop:uploads:legacy-scan:${account}`;

/** What an upload's answer means for the stored copy: a failure to keep it for, or null (done with it). */
export function failureOf(result: "network" | { id: string; code?: string }): UploadFailure | null {
  if (result === "network") return "network";
  if (!result.id && result.code === "too_large") return "too_large";
  if (!result.id && result.code === "guest_limit") return "guest_limit";
  if (!result.id && result.code === "rate_limited") return "rate_limited";
  return null;
}

/** The server can't take this run yet, and will: waiting for it uses up nothing. */
export function holds(f: UploadFailure | null | undefined): boolean {
  return f === "guest_limit" || f === "rate_limited";
}

/** The failure of a record as of now: an "uploading" record from an earlier page was interrupted. */
export function effectiveFailure(u: StoredUpload, now: number): UploadFailure | null {
  if (u.state === "failed") return u.failure ?? "network";
  return now - u.at > INTERRUPTED_AFTER_MS ? "interrupted" : null;
}

/** The record is due another send now: it failed, its retries aren't used up, and it's this account's run. */
export function shouldRetry(u: StoredUpload, account: string | null, now: number): boolean {
  const failure = effectiveFailure(u, now);
  if (!failure || !(u.account === null || u.account === account)) return false;
  if (holds(failure)) return true;
  if (failure === "too_large") return !u.retried;
  return (u.attempts ?? 0) < MAX_SEND_ATTEMPTS;
}

/** The record as it should be stored before a send, so that a crash or a closed tab mid-send can't earn another one. */
export function spendAttempt(u: StoredUpload, now: number): StoredUpload {
  const failure = effectiveFailure(u, now);
  if (holds(failure)) return u;
  const attempts = (u.attempts ?? 0) + 1;
  return { ...u, attempts, retried: failure === "too_large" || attempts >= MAX_SEND_ATTEMPTS };
}

/** The record is finished with: its retries ran out, or it has waited as long as a run is kept. */
export function expired(u: StoredUpload, now: number): boolean {
  return (u.retried || holds(u.failure)) && now - u.at > KEEP_MS;
}

/** The wait before a page looks at its waiting runs for the `round`-th time, spread so a shared network's tabs don't line up. */
export function holdDelayMs(round: number, spread: number = Math.random()): number {
  const base = Math.min(HOLD_MAX_MS, HOLD_FIRST_MS * 2 ** Math.min(round, 10));
  return Math.round(base * (0.9 + 0.2 * spread));
}

/**
 * The legacy path: a stored local PB replay from before failures were recorded (`since`), over the old cap, a finished
 * run, played under the signed-in player's name.
 */
export function legacyCandidate(size: number, h: Pick<ReplayHeader, "player" | "recordedAt" | "endTick">, playerName: string, since: number): boolean {
  return size > LEGACY_UPLOAD_LIMIT && h.endTick > 0 && h.recordedAt < since && h.player === playerName;
}

/** Why the upload failed, in the end card's and the toasts' words. */
export function failureText(f: UploadFailure): string {
  if (f === "guest_limit") return "too many new players have started on your network lately (shared connections like schools reach this; signing in to your account avoids it)";
  if (f === "rate_limited") return "more runs than real time allows in the last hour";
  return f === "too_large" ? "the replay is too large for the server" : f === "network" ? "no connection to the leaderboard" : "the upload was interrupted";
}
