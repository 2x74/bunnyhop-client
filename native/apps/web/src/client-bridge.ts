/** Optional Electron conveniences. Never controls input, physics, or ranked eligibility. */
export type ClientMode = "solo" | "multiplayer" | "practice" | "replay";
export interface ClientPresence {
  kind: "menu" | "playing" | "paused" | "results" | "replay";
  mapId?: string;
  mapName?: string;
  /** Public map thumbnail from the image registry; the shell validates it before sharing. */
  mapImage?: string | null;
  style?: string;
  mode: ClientMode;
  startedAt?: number;
  /** The room you're in, for Discord Join. The shell shares a private lobby only if the player allows it. */
  room?: ClientRoom | null;
}
export interface ClientRoom {
  id: string;
  lobby: boolean;
  players: number;
  max: number;
}
/** The shell's settings the game reads (electron/main.mjs publicClientSettings). */
export interface ClientSettings {
  /** Chromium's own frame limit is off for this launch (F10 → Uncap the whole browser). */
  browserUncapped?: boolean;
}
/** A frame-time capture the shell asked for (F10 → Benchmark), measured while playing. */
export interface ClientBenchmarkRequest {
  seconds: number;
}
export interface ClientBenchmarkResult {
  map: string;
  seconds: number;
  frames: number;
  /** Frame-to-frame intervals (ms). */
  interval: { avg: number; p50: number; p99: number; max: number };
  /** Time spent inside a frame on the main thread (ms). */
  work: { p50: number; p99: number; max: number };
  /** Intervals over 2× the median. */
  hitches: number;
  /** What the frames were drawn with. The shell adds the display and its own launch settings. */
  graphics: { potato: boolean; resolutionScale: number; antialias: boolean; uncapped: boolean; lowLatency: boolean; fpsLimit: number; browserUncapped: boolean; width: number; height: number };
}
/** The desktop app's custom CSS file (Settings -> Custom CSS file there): its name and text, sent again on each save. */
export interface ClientCustomCss {
  name: string;
  css: string;
}
/**
 * A file in the desktop app's skies folder (F10 -> Client -> Open skies folder): a .hdr panorama (16 MiB at most), a PNG /
 * JPEG / WebP panorama (32 MiB) or a .bhsky.json sky pack (45 MiB), up to 24 of them, or a file it couldn't read and why.
 */
export type ClientSky = { name: string; kind: "hdr" | "image" | "bhsky"; size: number; mtime: number; bytes: ArrayBuffer } | { name: string; error: string };
export const CLIENT_SKY_LIMITS = { hdr: 16 * 1024 * 1024, image: 32 * 1024 * 1024, bhsky: 45 * 1024 * 1024, count: 24 };
export interface ClientRunSummary {
  mapId: string; mapName: string; style: string;
  timeMs: number; ticks: number; tickRate: number;
  personalBest: boolean; verified: boolean; mode: ClientMode;
}
export interface BunnyhopClient {
  version: 1;
  getCachedContent?: (sha256: string) => Promise<Uint8Array | null>;
  cacheContent?: (sha256: string, bytes: Uint8Array) => Promise<boolean>;
  getSettings?: () => Promise<unknown>;
  onSettings?: (listener: (settings: unknown) => void) => unknown;
  setPresence?: (presence: ClientPresence) => unknown;
  resultSettled?: (archiveId: string) => unknown;
  saveRunSummary?: (summary: ClientRunSummary) => Promise<{ saved: boolean; id?: string }> | { saved: boolean; id?: string };
  openSettings?: () => unknown;
  setFullscreen?: (fullscreen: boolean) => unknown;
  /** Registers the game's benchmark; the shell offers it in F10 only once this is called. */
  onBenchmark?: (listener: (request: ClientBenchmarkRequest) => void) => unknown;
  benchmarkResult?: (result: ClientBenchmarkResult | { error: string }) => unknown;
  /** The custom CSS file: called with it now and on every save, null when there is none. Returns an unsubscribe. */
  onCustomCss?: (listener: (file: ClientCustomCss | null) => void) => unknown;
  /** The skies folder: the whole list now and after every change. Returns an unsubscribe. */
  onCustomSkies?: (listener: (skies: ClientSky[]) => void) => () => void;
  openSkiesFolder?: () => unknown;
}
declare global { interface Window { bunnyhopClient?: BunnyhopClient } }
export function nativeClient(): BunnyhopClient | null {
  const browser = (globalThis as unknown as { window?: { bunnyhopClient?: BunnyhopClient } }).window;
  return browser?.bunnyhopClient?.version === 1 ? browser.bunnyhopClient : null;
}
function safely(call: () => unknown): void {
  try { void Promise.resolve(call()).catch(() => {}); } catch { /* Native conveniences cannot interrupt a run. */ }
}
/** The desktop app's custom CSS file (custom-css/index.ts). The text goes through the same rewrite as pasted CSS. */
export function watchClientCustomCss(listener: (file: ClientCustomCss | null) => void): void {
  const native = nativeClient();
  if (!native?.onCustomCss) return;
  const read = (v: unknown) => {
    const f = v as Partial<ClientCustomCss> | null;
    listener(f && typeof f === "object" && typeof f.css === "string" ? { name: String(f.name ?? "custom.css").slice(0, 80), css: f.css.slice(0, 256 * 1024) } : null);
  };
  safely(() => native.onCustomCss?.(read));
}
/** An ArrayBuffer from the bridge (also one from another realm, or a Uint8Array / Buffer view); null for anything else. */
function arrayBuffer(v: unknown): ArrayBuffer | null {
  if (Object.prototype.toString.call(v) === "[object ArrayBuffer]") return v as ArrayBuffer;
  if (!ArrayBuffer.isView(v)) return null;
  return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
}
/**
 * The desktop app's skies folder (sky-packs/folder.ts): the files it holds, now and after every change. A malformed entry
 * is dropped; a file over the limits comes through as an error entry, without its bytes. Returns an unsubscribe; null
 * without the desktop app (or an older one).
 */
export function watchClientSkies(listener: (skies: ClientSky[]) => void, native = nativeClient()): (() => void) | null {
  if (!native?.onCustomSkies) return null;
  const read = (v: unknown) => {
    if (!Array.isArray(v)) return;
    const out: ClientSky[] = [];
    for (const raw of v.slice(0, CLIENT_SKY_LIMITS.count)) {
      const s = raw as Partial<Record<string, unknown>> | null;
      if (!s || typeof s !== "object" || typeof s.name !== "string" || !s.name) continue;
      const name = s.name.slice(0, 120);
      if (typeof s.error === "string") out.push({ name, error: s.error.slice(0, 200) || "Couldn't read it." });
      else if ((s.kind === "hdr" || s.kind === "image" || s.kind === "bhsky") && typeof s.size === "number" && typeof s.mtime === "number") {
        const bytes = arrayBuffer(s.bytes);
        if (!bytes) continue;
        if (bytes.byteLength > CLIENT_SKY_LIMITS[s.kind]) out.push({ name, error: `Over ${CLIENT_SKY_LIMITS[s.kind] / 1048576} MB.` });
        else out.push({ name, kind: s.kind, size: s.size, mtime: s.mtime, bytes });
      }
    }
    listener(out);
  };
  let stop: unknown = null;
  try { stop = native.onCustomSkies(read); } catch { return null; }
  return () => { try { if (typeof stop === "function") stop(); } catch { /* the bridge is gone */ } };
}
export function openClientSkiesFolder(): void {
  const native = nativeClient();
  if (native?.openSkiesFolder) safely(() => native.openSkiesFolder!());
}
export async function saveClientRun(summary: ClientRunSummary): Promise<string | null> {
  const native = nativeClient();
  try {
    const result = await native?.saveRunSummary?.(summary);
    return result?.saved === true && typeof result.id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(result.id) ? result.id : null;
  } catch { return null; }
}
export function clientResultSettled(archiveId: string | null, stillShown: () => boolean): void {
  if (!archiveId || !nativeClient()?.resultSettled) return;
  const paint = (globalThis as unknown as { requestAnimationFrame?: (callback: (time: number) => void) => number }).requestAnimationFrame;
  if (!paint) return;
  // The actual end card must have painted before the shell captures a PB screenshot.
  paint.call(globalThis, () => paint.call(globalThis, () => {
    const native = nativeClient();
    if (stillShown() && native?.resultSettled) safely(() => native.resultSettled!(archiveId));
  }));
}
export function openClientSettings(): void {
  const native = nativeClient();
  if (native?.openSettings) safely(() => native.openSettings!());
}
export function createClientPresence(native = nativeClient(), now = () => Math.floor(Date.now() / 1000)) {
  let previous = "";
  let activity = "";
  let startedAt = now();
  return (presence: ClientPresence): void => {
    if (!native?.setPresence) return;
    const key = JSON.stringify(presence);
    if (key === previous) return;
    previous = key;
    const nextActivity = JSON.stringify([presence.mapId, presence.style, presence.mode]);
    if (nextActivity !== activity) { activity = nextActivity; startedAt = now(); }
    safely(() => native.setPresence!({ ...presence, startedAt }));
  };
}
export const clientPresence = createClientPresence();
clientPresence({ kind: "menu", mode: "solo" });

/** The shell's settings now and on every change; nothing without the desktop client. */
export function watchClientSettings(listener: (settings: ClientSettings) => void): void {
  const native = nativeClient();
  if (!native) return;
  const read = (v: unknown) => {
    if (v && typeof v === "object") listener({ browserUncapped: (v as ClientSettings).browserUncapped === true });
  };
  safely(() => native.getSettings?.().then(read));
  safely(() => native.onSettings?.(read));
}
