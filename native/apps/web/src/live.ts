// Who is streaming right now (GET /live, apps/api src/live.ts): Streamers on the Discord server who went live with
// /live, or on Twitch in Counter-Strike / Counter-Strike: Source. The home screen's Live now (ui/home-live.ts) and the
// LIVE marks in rooms (chat, the scoreboard, name tags, the hover card: ui/marks.ts liveMark) read this one list.
//
// The list is asked for at most once a minute, only while something wants it (a subscriber, or liveOf() called in
// the last two minutes: a room's name tags ask every frame they redraw), only while the tab is visible, and never
// without an API. The answer is edge-cached for 30 s on the server, so a request reads no D1 rows most of the time.
// A failed request keeps the last list for one more minute, then empties it: a mark never outlives the stream long.

import { api, type LivePlatform, type LiveStream } from "./api";

export type { LivePlatform, LiveStream };

export const LIVE_POLL_MS = 60_000;
/** liveOf() keeps the list fresh for this long after its last call. */
const WANT_MS = 2 * LIVE_POLL_MS;

export const LIVE_PLATFORM_NAME: Record<LivePlatform, string> = { twitch: "Twitch", youtube: "YouTube", tiktok: "TikTok" };

/** Only the platforms' own sites: the url becomes a link, so anything else is dropped. */
const HOSTS: Record<LivePlatform, RegExp> = {
  twitch: /^https:\/\/(?:www\.)?twitch\.tv\/[^\s"'<>]+$/i,
  youtube: /^https:\/\/(?:www\.)?youtube\.com\/[^\s"'<>]+$/i,
  tiktok: /^https:\/\/(?:www\.)?tiktok\.com\/[^\s"'<>]+$/i,
};

/** The answer's streams that are safe to show (known platform, its own domain, a player). */
export function cleanStreams(raw: unknown): LiveStream[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveStream[] = [];
  const seen = new Set<string>();
  for (const s of raw as Partial<LiveStream>[]) {
    const p = s?.platform;
    if (p !== "twitch" && p !== "youtube" && p !== "tiktok") continue;
    if (typeof s.url !== "string" || !HOSTS[p].test(s.url)) continue;
    const id = s.player?.id;
    if (typeof id !== "string" || !id || typeof s.player?.name !== "string" || seen.has(id)) continue;
    seen.add(id);
    out.push({
      player: s.player,
      platform: p,
      url: s.url,
      title: typeof s.title === "string" && s.title.trim() ? s.title.trim().slice(0, 140) : null,
      game: typeof s.game === "string" && s.game.trim() ? s.game.trim().slice(0, 80) : null,
      startedAt: typeof s.startedAt === "number" && Number.isFinite(s.startedAt) ? s.startedAt : Date.now(),
    });
  }
  return out;
}

let streams: LiveStream[] = [];
let byId = new Map<string, LiveStream>();
let askedAt = 0;
let okAt = 0;
let inflight: Promise<void> | null = null;
let wantedAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let fetcher: () => Promise<{ streams: unknown }> = () => api.live();
type Listener = (s: readonly LiveStream[]) => void;
/** Subscribers, each with what keeps it subscribed (its element still on the page). */
const listeners = new Map<Listener, () => boolean>();

const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
const key = (list: readonly LiveStream[]) => list.map((s) => `${s.player.id}|${s.platform}|${s.url}|${s.title ?? ""}`).join("\n");

function set(next: LiveStream[]): void {
  if (key(next) === key(streams)) {
    streams = next; // same streams, fresher player objects
    byId = new Map(next.map((s) => [s.player.id, s]));
    return;
  }
  streams = next;
  byId = new Map(next.map((s) => [s.player.id, s]));
  for (const fn of [...listeners.keys()]) {
    try {
      fn(streams);
    } catch (e) {
      console.error(e);
    }
  }
}

function wanted(now: number): boolean {
  for (const [fn, alive] of listeners) if (!alive()) listeners.delete(fn);
  return listeners.size > 0 || now - wantedAt < WANT_MS;
}

/** Ask now if the last ask is a minute old (and someone wants it, the tab is visible and there is an API). */
function refresh(force = false): Promise<void> {
  const now = Date.now();
  if (!api.available()) return Promise.resolve();
  if (!wanted(now)) return stopTimer(), Promise.resolve();
  if (inflight) return inflight;
  if (!force && (!visible() || now - askedAt < LIVE_POLL_MS)) return Promise.resolve();
  askedAt = now;
  inflight = fetcher()
    .then(
      (r) => {
        okAt = Date.now();
        set(cleanStreams(r?.streams));
      },
      () => {
        // Quiet: keep the last list for one more minute, then nothing (an offline API shows no stale marks).
        if (Date.now() - okAt > LIVE_POLL_MS * 1.5) set([]);
      },
    )
    .finally(() => (inflight = null));
  return inflight;
}

function stopTimer(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

let visibilityHooked = false;
function ensureRunning(): void {
  if (!api.available()) return;
  if (timer === null) timer = setInterval(() => void refresh(), LIVE_POLL_MS / 4);
  if (!visibilityHooked && typeof document !== "undefined") {
    visibilityHooked = true;
    document.addEventListener("visibilitychange", () => visible() && void refresh());
  }
  void refresh();
}

/** The stream a player is on right now, or null. Cheap (a map lookup); calling it keeps the list fresh. */
export function liveOf(id: string | null | undefined): LiveStream | null {
  const now = Date.now();
  if (now - wantedAt > 1000) {
    wantedAt = now;
    ensureRunning();
  }
  return id ? (byId.get(id) ?? null) : null;
}

/** Everyone live right now (the last answer). */
export function liveStreams(): readonly LiveStream[] {
  return streams;
}

/**
 * Called with the list now (if there is one) and whenever it changes. Returns the unsubscribe. `alive`: checked before
 * each ask; once it says false the subscription ends by itself (a screen that was left without unsubscribing).
 */
export function onLive(fn: Listener, alive: () => boolean = () => true): () => void {
  listeners.set(fn, alive);
  ensureRunning();
  if (okAt) fn(streams);
  return () => void listeners.delete(fn);
}

/** "", "12m", "1h 05m" (under a minute: ""). */
export function liveFor(startedAt: number, now = Date.now()): string {
  const m = Math.max(0, Math.floor((now - startedAt) / 60_000));
  if (m < 1) return "";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "on Twitch for 1h 05m" ("on Twitch" in its first minute). */
export function liveWhere(s: Pick<LiveStream, "platform" | "startedAt">, now = Date.now()): string {
  const d = liveFor(s.startedAt, now);
  return `on ${LIVE_PLATFORM_NAME[s.platform]}${d ? ` for ${d}` : ""}`;
}

/** Tests: a fake fetcher and a clean slate. */
export function resetLiveForTests(f?: () => Promise<{ streams: unknown }>): void {
  stopTimer();
  listeners.clear();
  streams = [];
  byId = new Map();
  askedAt = okAt = wantedAt = 0;
  inflight = null;
  fetcher = f ?? (() => api.live());
}
/** Tests: ask now, ignoring the minute. */
export const refreshLiveNow = () => refresh(true);
