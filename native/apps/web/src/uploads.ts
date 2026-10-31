// Runs whose upload failed (v0.0.10): kept on this device with the kind of failure, and sent once more. The rules
// (DOM-free, tested in apps/api/test/uploads.test.ts); upload-store.ts keeps them in IndexedDB, online.ts sends them.
//
// Every finished ranked run is written here before its upload ("uploading") and removed once the server has taken it
// (or refused it for a reason a retry can't change: a rejection the end card shows). It stays when the upload failed in
// a way a retry can fix, with the failure recorded at that moment:
//   too_large    the server refused the size (413; before v0.0.10 the cap was 1 MiB, so a 1 h run never fit),
//   network      no answer (offline, a 5xx),
//   interrupted  the tab closed mid-upload (still "uploading" on the next load),
//   guest_limit  no account yet, and the network had made too many new players lately (a shared network; v0.0.10).
// Each stored run is retried at most once, automatically (online.ts retryStoredUploads: on the next load, or 30 s later
// after a network failure), and only for the account that recorded it.
//
// Before v0.0.10 nothing was recorded. One legacy path covers those runs: a stored local PB replay (pb.ts) over the old
// 1 MiB cap was certainly refused, so it is queued here once (as too_large) and retried like the others, if its header
// names the signed-in player. Nothing else from before v0.0.10 is retried.

import type { ReplayHeader } from "./replay";

export type UploadFailure = "too_large" | "network" | "interrupted" | "guest_limit";

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
  /** The one automatic retry has been used. */
  retried: boolean;
  /** Queued by the legacy path (a pre-v0.0.10 PB replay over the old cap). */
  legacy?: boolean;
  at: number;
}

/** The upload cap before v0.0.10 (apps/api/src/replay-io.ts LEGACY_MAX_REPLAY_BYTES). */
export const LEGACY_UPLOAD_LIMIT = 1 << 20;
/** An "uploading" record older than this (from an earlier page) is an interrupted upload. */
export const INTERRUPTED_AFTER_MS = 2 * 60_000;
/** Records whose retry is used up are dropped after this. */
export const KEEP_MS = 30 * 24 * 3600_000;
/** localStorage: when this browser started recording upload failures (the first v0.0.10 load). */
export const TRACKING_SINCE_KEY = "bunnyhop:uploads:since";
/** localStorage, per account: the legacy PB scan ran. */
export const legacyScanKey = (account: string) => `bunnyhop:uploads:legacy-scan:${account}`;

/** What an upload's answer means for the stored copy: a failure to keep it for, or null (done with it). */
export function failureOf(result: "network" | { id: string; code?: string }): UploadFailure | null {
  if (result === "network") return "network";
  if (!result.id && result.code === "too_large") return "too_large";
  if (!result.id && result.code === "guest_limit") return "guest_limit";
  return null;
}

/** The failure of a record as of now: an "uploading" record from an earlier page was interrupted. */
export function effectiveFailure(u: StoredUpload, now: number): UploadFailure | null {
  if (u.state === "failed") return u.failure ?? "network";
  return now - u.at > INTERRUPTED_AFTER_MS ? "interrupted" : null;
}

/** The record gets its one automatic retry now: it failed, the retry isn't used, and it's this account's run. */
export function shouldRetry(u: StoredUpload, account: string | null, now: number): boolean {
  if (u.retried || !effectiveFailure(u, now)) return false;
  return u.account === null || u.account === account;
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
  return f === "too_large" ? "the replay is too large for the server" : f === "network" ? "no connection to the leaderboard" : "the upload was interrupted";
}
