// Runs whose upload failed for the connection or the server (a 5xx, 408 or 429), kept on disk by the host
// (pending_uploads.hpp) with what the upload needs besides the replay: the heartbeat tokens, which exist nowhere else,
// the account that played it and the settings sent with it. run-service.ts sends them again with a backoff while the
// game is open, and after a restart, only for that account. The replay stays in the local archive under `id`.
import type { RunDiagnostics, RunMouse } from "./run-service";

export interface PendingUpload {
  /** The replay's name in the local archive. */
  id: string;
  account: string;
  map: string;
  track: number;
  style: string;
  build: string;
  wasm: string;
  beats: string[];
  /** Heartbeats that never got a token, as counted when the run finished. */
  gaps: number;
  mouse: RunMouse | null;
  diagnostics: RunDiagnostics | null;
  /** Sends made since the first failure, counted before each send so a crash mid-send can't earn another. */
  attempts: number;
  /** When the first upload failed. */
  at: number;
}

export interface PendingUploadStore {
  list(): Promise<PendingUpload[]>;
  save(upload: PendingUpload): Promise<void>;
  remove(id: string): Promise<void>;
  /** The archived replay as base64, or null when it's been deleted. */
  replay(id: string): Promise<string | null>;
}

/** Sends after the first failure. With the backoff below they span about three hours of play. */
export const RETRY_ATTEMPTS = 10;
export const RETRY_FIRST_MS = 30_000;
export const RETRY_MAX_MS = 30 * 60_000;
/** A run still waiting after this is dropped (the replay stays in the archive), as on the web (uploads.ts KEEP_MS). */
export const KEEP_MS = 30 * 24 * 3600_000;
/** Replay archive names (run_vault.hpp valid_id). */
const REPLAY_ID = /^[A-Za-z0-9_.-]{1,176}\.bhr$/;

export const validReplayId = (id: unknown): id is string =>
  typeof id === "string" && REPLAY_ID.test(id) && !id.includes("..");

/** The wait before the `round`-th look, doubling from the first, spread so many clients don't line up. */
export function retryDelayMs(round: number, spread: number = Math.random()): number {
  const base = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(round, 10));
  return Math.round(base * (0.9 + 0.2 * spread));
}

export const expired = (upload: PendingUpload, now: number): boolean => now - upload.at > KEEP_MS;

const isText = (value: unknown, limit = 256): value is string => typeof value === "string" && value.length <= limit;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const plainObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** A stored record read back from disk, or null if it isn't one this client wrote. */
export function parsePendingUpload(id: string, value: unknown): PendingUpload | null {
  const record = plainObject(value);
  if (!record || !validReplayId(id) || record.id !== id) return null;
  const beats = record.beats;
  if (!Array.isArray(beats) || !beats.every((token) => isText(token, 600))) return null;
  const textFields = [record.account, record.map, record.style, record.build, record.wasm];
  if (!textFields.every((field) => isText(field) && field.length > 0)) return null;
  if (![record.track, record.gaps, record.attempts, record.at].every(count)) return null;
  return {
    id,
    account: record.account as string,
    map: record.map as string,
    track: record.track as number,
    style: record.style as string,
    build: record.build as string,
    wasm: record.wasm as string,
    beats: beats as string[],
    gaps: record.gaps as number,
    mouse: plainObject(record.mouse) as RunMouse | null,
    diagnostics: plainObject(record.diagnostics),
    attempts: record.attempts as number,
    at: record.at as number,
  };
}
