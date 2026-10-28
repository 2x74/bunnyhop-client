// "A new version is ready": open tabs notice a newer deploy and offer a one-click reload (players keep tabs open for
// hours; the night after v0.0.6 shipped, 297 runs came from v0.0.4 tabs).
//
// Checks GET /version (apps/api src/build-info.ts: the deployed entry script, VERSION, the sim build), no-store, only
// while nobody is playing: when a menu opens, every 10 minutes while in menus, when the tab comes back, and once
// after a run ends. Never more than once a minute. The notice is a quiet toast (notify/) with Reload: in menus it
// carries the button; right after a run (pointer still locked) it only says where to find it. Nothing reloads by
// itself, and never mid-run. Reload keeps the place: the address already holds the map / route, the style is added.
//
// One exception to "nothing reloads by itself": a lazily imported chunk that fails to load (vite:preloadError, or a
// dynamic import rejecting) means this tab is older than the deploy and its hashed assets are gone, so the feature the
// player just opened can't work. Outside a timed attempt the page reloads into the new build at once (at most once a
// minute, so a broken deploy can't loop); during one, the notice above shows instead (initChunkRecovery).

import { appHref } from "./platform/navigation";
import { api } from "./api";
import { toast } from "./notify";
import { allowLeave } from "./play-lock";
import { selectedStyle } from "./ui/style-picker";
import { compareVersions, STAGE, VERSION } from "./version";

const POLL_MS = 10 * 60_000;
const MIN_GAP_MS = 60_000;
/** The notice comes back at most this often (menu opens, after runs). */
const RESHOW_MS = 5 * 60_000;
/** A reload waits this long at most for an upload in flight (holdReload). */
const HOLD_MAX_MS = 5000;

/** The entry script this page loaded (/assets/index-<hash>.js in a build), null on the dev server. */
export function ownBuild(): string | null {
  const s = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  return s ? new URL(s.src, location.href).pathname : null;
}

const S = {
  latest: null as { version: string; build: string | null } | null,
  lastCheck: -Infinity,
  lastShown: -Infinity,
  /** The in-game line after a run (no button). */
  lastHint: -Infinity,
  checking: null as Promise<void> | null,
  /** main.ts: a timed attempt is in progress (the timer is running). */
  busy: () => false,
  holds: new Set<Promise<unknown>>(),
  /** A lazy chunk of this build failed to load: the deploy moved on even if /version wasn't reachable. */
  chunkMissing: false,
};

/** Not playing: the home screen, or a menu open over the game (and no timed attempt paused underneath). */
function idle(): boolean {
  const c = document.body.classList;
  return (!c.contains("in-game") || c.contains("menu-open")) && !S.busy();
}

/** A different build is deployed (or, without a build id on either side, a newer version). */
export function isStale(latest: { version: string; build: string | null } | null, own = ownBuild(), version = VERSION): boolean {
  if (!latest) return false;
  if (latest.build && own) return latest.build !== own;
  return compareVersions(latest.version, version) > 0;
}

async function check(): Promise<void> {
  if (!api.available() || document.hidden) return;
  const now = performance.now();
  if (now - S.lastCheck < MIN_GAP_MS) return S.checking ?? undefined;
  S.lastCheck = now;
  S.checking = (async () => {
    try {
      const v = await api.version();
      if (typeof v?.version === "string") S.latest = { version: v.version, build: typeof v.build === "string" ? v.build : null };
    } catch {
      /* offline: try again next time */
    } finally {
      S.checking = null;
    }
  })();
  return S.checking;
}

const label = () => (S.latest ? `v${S.latest.version} ${STAGE}` : "reload to update");
const stale = () => S.chunkMissing || isStale(S.latest);
const readyText = () => `${S.latest ? label() : "A new version"} is ready. Press Esc to reload.`;

/** In menus: the notice with Reload, at most every RESHOW_MS. */
function offer(): void {
  if (!stale() || !idle() || performance.now() - S.lastShown < RESHOW_MS) return;
  S.lastShown = performance.now();
  toast(`${S.latest ? label() : "A new version"} is ready`, { key: "update", ms: 15_000, lead: "update", action: { label: "Reload", run: () => void reload() } });
}

async function checkAndOffer(): Promise<void> {
  if (!idle()) return;
  await check();
  offer();
}

/** The address to reload: the same page and route, plus the style a map is played in. */
export function reloadUrl(href = appHref(), style: string = selectedStyle()): string {
  const u = new URL(href);
  if (u.searchParams.has("map")) u.searchParams.set("style", style);
  return u.toString();
}

/** Reloads into the new build (after any upload in flight, HOLD_MAX_MS at most). */
export async function reload(): Promise<void> {
  if (S.holds.size) await Promise.race([Promise.allSettled([...S.holds]), new Promise((r) => setTimeout(r, HOLD_MAX_MS))]);
  allowLeave(); // a deliberate navigation: no "Leave site?" prompt
  const url = reloadUrl();
  if (url === appHref()) location.reload();
  else location.replace(url);
}

/** A reload waits for `p` (a run upload) so a click right after a finish never loses it. */
export function holdReload(p: Promise<unknown>): void {
  S.holds.add(p);
  void p.finally(() => S.holds.delete(p));
}

/** main.ts: what counts as a timed attempt in progress (no checks, no notice while it is). */
export function setUpdateBusy(fn: () => boolean): void {
  S.busy = fn;
}

/**
 * A run just ended (session.ts finish): check, and if a newer build is out say so. The pointer is usually still
 * locked here, so the line points at the pause menu, where the notice with Reload shows next.
 */
export function runEnded(): void {
  setTimeout(() => {
    void (async () => {
      await check();
      if (!stale() || S.busy()) return;
      if (idle()) return offer();
      if (performance.now() - S.lastHint < RESHOW_MS) return;
      S.lastHint = performance.now();
      S.lastShown = -Infinity; // the pause menu offers Reload as soon as it opens
      toast(readyText(), { key: "update", ms: 6000 });
    })();
  }, 2500);
}

let started = false;

/** main.ts, once at startup. */
export function initUpdateCheck(): void {
  if (started || !api.available()) return;
  started = true;
  // A menu opening (pause menu over the game) or leaving the game view.
  let wasIdle = idle();
  new MutationObserver(() => {
    const now = idle();
    if (now && !wasIdle) void checkAndOffer();
    wasIdle = now;
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  addEventListener("visibilitychange", () => !document.hidden && void checkAndOffer());
  setInterval(() => void checkAndOffer(), POLL_MS);
  // The first look a little after load (the page itself is current, but a deploy may be minutes old).
  setTimeout(() => void checkAndOffer(), 30_000);
}

/** Chunk load failures: Vite's preload helper, and dynamic imports rejected by the browser (Chromium, Firefox, Safari). */
export function isChunkLoadError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Failed to load module script/i.test(m);
}

const CHUNK_RELOAD_KEY = "bh_chunk_reload";
const CHUNK_RELOAD_GAP_MS = 60_000;
let reloading = false;

/** A lazy chunk is gone (see the header): reload now if nobody is mid-run and we haven't just tried, else the notice. */
export function chunkLoadFailed(): void {
  if (reloading) return;
  S.chunkMissing = true;
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY)) || 0;
  } catch {
    /* storage blocked: no loop guard, so only the notice */
    last = Date.now();
  }
  if (!S.busy() && Date.now() - last > CHUNK_RELOAD_GAP_MS) {
    try {
      sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    reloading = true;
    void reload();
    return;
  }
  S.lastShown = -Infinity;
  if (idle()) offer();
  else toast(readyText(), { key: "update", ms: 6000 });
}

let chunkWatch = false;

/** main.ts, as early as possible: watch for chunks of this build that no longer exist. */
export function initChunkRecovery(): void {
  if (chunkWatch) return;
  chunkWatch = true;
  addEventListener("vite:preloadError", () => chunkLoadFailed());
  addEventListener("unhandledrejection", (e) => {
    if (!isChunkLoadError(e.reason)) return;
    e.preventDefault();
    chunkLoadFailed();
  });
}
