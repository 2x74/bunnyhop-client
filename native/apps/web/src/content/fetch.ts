import { cachedContent } from "./client-cache";

// Map loading fetches with timeouts and retries (the BSP, the content manifest, each hosted content file).
//
// A plain fetch() never gives up: one request that stalls (no response, or a body that stops arriving) used to leave
// the loading screen waiting forever. Each attempt here has a time limit for the response headers and a limit on the
// gap between body chunks (not on the whole download, so a big map on a slow connection still finishes). Network
// errors, timeouts, 408 / 425 / 429 and 5xx are retried with exponential backoff; other HTTP errors (404: missing or
// taken down) fail at once.
//
// Progress counts decoded bytes. Map and content downloads are compressed at the edge (research/COMPRESSION.md): the
// browser decompresses transparently, and Content-Length is then absent or the compressed size, so callers pass the
// uncompressed size they already know (`expectedSize`: the map index, manifest file sizes).

export interface FetchRetryOptions {
  /** Verified immutable file identity; desktop only. Never use for mutable manifests. */
  cacheSha256?: string;
  /** Attempts in total (1 = no retry). Default 3. */
  attempts?: number;
  /** Time to the response headers, per attempt. Default 20 s. */
  headerTimeoutMs?: number;
  /** Longest gap between body chunks before the attempt is dropped. Default 20 s. */
  idleTimeoutMs?: number;
  /** Delay before retry n (1-based): backoffMs * 3^(n-1), ±25 % jitter. Default 600 ms. */
  backoffMs?: number;
  /** Aborts the whole download (no retry). */
  signal?: AbortSignal;
  init?: RequestInit;
  /** Rejects a response before its body is read: return an error message (not retried), or null to accept. */
  accept?: (res: Response) => string | null;
  /**
   * Uncompressed body size known up front (map index / manifest), or a getter for one that arrives later (null: not
   * yet). Preferred over Content-Length, which a compressed response lacks or gives in compressed bytes.
   */
  expectedSize?: number | null | (() => number | null | undefined);
  /** Decoded bytes received in this attempt so far, and the expected total when known (never below `got`). */
  onProgress?: (got: number, total: number | null) => void;
  /** Called before each retry with the attempt about to start (2..attempts). */
  onRetry?: (attempt: number, error: FetchFailure, delayMs: number) => void;
  /**
   * Continue an interrupted download where it stopped (`Range: bytes=<got>-`) instead of from byte 0. Retries that got
   * more bytes don't count towards `attempts` (a slow or stalling connection still finishes), up to MAX_RESUMES. A
   * server that answers 200 instead of 206 starts the file over. Only for immutable files.
   */
  resume?: boolean;
  /** sha256 (hex) the finished body must have: a resumed download that doesn't match is fetched again in one piece. */
  sha256?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

/** Why a download failed. `status` is the HTTP status (null: network error, timeout or abort). */
export class FetchFailure extends Error {
  constructor(
    message: string,
    public status: number | null,
    public retryable: boolean,
    public aborted = false,
  ) {
    super(message);
    this.name = "FetchFailure";
  }
}

const RETRY_STATUS = new Set([408, 425, 429]);

/** Retry delay before attempt `attempt` (2 = first retry). */
export function backoffDelay(attempt: number, baseMs: number, random: () => number = Math.random): number {
  const d = baseMs * 3 ** Math.max(0, attempt - 2);
  return Math.round(d * (0.75 + random() * 0.5));
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new FetchFailure("aborted", null, false, true));
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(t);
      reject(new FetchFailure("aborted", null, false, true));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Races `p` against a timer and the abort signals; the loser's result is ignored. */
function race<T>(p: Promise<T>, ms: number, what: string, signals: AbortSignal[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(t);
      for (const s of signals) s.removeEventListener("abort", onAbort);
    };
    const t = setTimeout(() => {
      cleanup();
      reject(new FetchFailure(`timed out (${what}, ${Math.round(ms / 1000)} s)`, null, true));
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new FetchFailure("aborted", null, false, true));
    };
    for (const s of signals) {
      if (s.aborted) return onAbort();
      s.addEventListener("abort", onAbort, { once: true });
    }
    p.then(
      (v) => (cleanup(), resolve(v)),
      (e) => (cleanup(), reject(e)),
    );
  });
}

/** Content-Length when it is the decoded body size (no Content-Encoding), else null. */
export function identityLength(res: Response): number | null {
  const enc = (res.headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (enc && enc !== "identity") return null;
  return Number(res.headers.get("content-length")) || null;
}

/** Bytes kept from earlier attempts of a resumable download (the file's start, in order). */
interface Partial { chunks: Uint8Array[]; got: number }

/** Resumes allowed on top of `attempts` while each one gets more of the file. */
const MAX_RESUMES = 40;

async function attemptOnce(url: string, o: FetchRetryOptions, outer: AbortSignal | undefined, kept: Partial = { chunks: [], got: 0 }): Promise<Uint8Array> {
  const ctl = new AbortController();
  const signals = outer ? [outer, ctl.signal] : [ctl.signal];
  const onOuterAbort = () => ctl.abort();
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    let res: Response;
    try {
      const init: RequestInit = { ...o.init, signal: ctl.signal };
      if (o.resume && kept.got > 0) init.headers = { ...(o.init?.headers as Record<string, string> | undefined), range: `bytes=${kept.got}-` };
      res = await race((o.fetch ?? fetch)(url, init), o.headerTimeoutMs ?? 20_000, "no response", signals);
    } catch (e) {
      if (e instanceof FetchFailure) throw e;
      if (outer?.aborted) throw new FetchFailure("aborted", null, false, true);
      throw new FetchFailure((e as Error)?.message || "network error", null, true);
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      throw new FetchFailure(`HTTP ${res.status}`, res.status, res.status >= 500 || RETRY_STATUS.has(res.status));
    }
    const rejected = o.accept?.(res) ?? null;
    if (rejected) {
      void res.body?.cancel().catch(() => {});
      throw new FetchFailure(rejected, res.status, false);
    }
    // A resumed request: 206 from where we stopped continues the file; anything else (a 200) starts it over.
    if (kept.got > 0) {
      const from = /^bytes (\d+)-/.exec(res.headers.get("content-range") ?? "");
      if (res.status !== 206 || !from || Number(from[1]) !== kept.got) (kept.chunks = []), (kept.got = 0);
    }
    const base = kept.got;
    let headerTotal = res.status === 206 ? null : identityLength(res);
    const total = (got: number): number | null => {
      // More bytes than Content-Length: it was the compressed size (encoding hidden from a cross-origin read).
      if (headerTotal !== null && got > headerTotal) headerTotal = null;
      const known = (typeof o.expectedSize === "function" ? o.expectedSize() : o.expectedSize) || headerTotal;
      return known ? Math.max(known, got) : null;
    };
    const idleMs = o.idleTimeoutMs ?? 20_000;
    if (!res.body) {
      const b = new Uint8Array(await race(res.arrayBuffer(), idleMs, "download stalled", signals));
      kept.chunks.push(b);
      kept.got += b.length;
      o.onProgress?.(kept.got, total(kept.got));
      return join(kept);
    }
    const reader = res.body.getReader();
    const chunks = kept.chunks;
    let got = base;
    try {
      for (;;) {
        const { done, value } = await race(reader.read(), idleMs, "download stalled", signals);
        if (done) break;
        chunks.push(value);
        got += value.length;
        kept.got = got;
        o.onProgress?.(got, total(got));
      }
    } catch (e) {
      void reader.cancel().catch(() => {});
      if (e instanceof FetchFailure) throw e;
      if (outer?.aborted) throw new FetchFailure("aborted", null, false, true);
      throw new FetchFailure((e as Error)?.message || "download interrupted", null, true);
    }
    return join(kept);
  } finally {
    outer?.removeEventListener("abort", onOuterAbort);
    ctl.abort(); // drops a timed-out request's connection (no-op once the body is read)
  }
}

/** Downloads `url` with per-attempt timeouts and retries. Throws a FetchFailure after the last attempt. */
export async function fetchBytes(url: string, o: FetchRetryOptions = {}): Promise<Uint8Array> {
  return cachedContent(o.cacheSha256, () => downloadBytes(url, o), o.signal, o.onProgress);
}

function join(p: Partial): Uint8Array {
  if (p.chunks.length === 1) return p.chunks[0];
  const out = new Uint8Array(p.got);
  let at = 0;
  for (const c of p.chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function downloadBytes(url: string, o: FetchRetryOptions): Promise<Uint8Array> {
  const attempts = Math.max(1, o.attempts ?? 3);
  const sleep = o.sleep ?? defaultSleep;
  const kept: Partial = { chunks: [], got: 0 };
  let resumed = false;
  let resumes = 0;
  for (let attempt = 1; ; attempt++) {
    const before = kept.got;
    try {
      const out = await attemptOnce(url, o, o.signal, o.resume ? kept : undefined);
      // A file put together from several responses is checked whole; a mismatch is fetched again in one piece.
      if (resumed && o.sha256 && (await sha256Hex(out)) !== o.sha256) {
        kept.chunks = [];
        kept.got = 0;
        resumed = false;
        return await attemptOnce(url, { ...o, resume: false }, o.signal);
      }
      return out;
    } catch (e) {
      const err = e instanceof FetchFailure ? e : new FetchFailure(String((e as Error)?.message ?? e), null, true);
      if (o.signal?.aborted) throw new FetchFailure("aborted", null, false, true);
      // Progress made: the next attempt continues the file and doesn't use up a retry.
      const advanced = !!o.resume && err.retryable && kept.got > before && resumes < MAX_RESUMES;
      if (advanced) {
        resumes++;
        resumed = true;
        o.onRetry?.(attempt, new FetchFailure(`${err.message}, resuming at ${(kept.got / 1e6).toFixed(1)} MB`, err.status, true), 0);
        await sleep(300, o.signal);
        attempt--;
        continue;
      }
      if (!err.retryable || attempt >= attempts) throw err;
      const delay = backoffDelay(attempt + 1, o.backoffMs ?? 600, o.random);
      o.onRetry?.(attempt + 1, err, delay);
      await sleep(delay, o.signal);
    }
  }
}

/** Resolves with `fallback` if `p` hasn't settled after `ms` (p keeps running; its result is dropped). */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
