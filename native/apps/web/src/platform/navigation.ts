// Page URLs in the Wavedash build. Wavedash serves the game's index.html as /embed?entrypoint=index.html&engine=CUSTOM
// &sdkconfig=<JSON>&gameSlug=... with its SDK script injected ahead of ours, and the SDK reads that query on every load:
// a page load without them has no SDK, and the frame serves only the build's files, not the site's paths (/replay/<id>,
// /u/<id>, /maps/<name>...). The game, though, is written for bunnyhop.lol's URLs: it reads its path and query, uses
// history.pushState / replaceState for its screens, and switches modes with full page loads (location.href =
// "/?map=...", reloads after an update).
//
// So, in this build only, every address the frame shows (and so every history entry Back / Forward or a reload can
// load again) is the entry page with Wavedash's parameters plus bh=<app path + query>, and the game reads the app URL
// through appLocation() / appHref() (the real location on the site):
//   - at boot (platform/boot.ts, before any other module) the frame's URL is noted (entry page + Wavedash's
//     parameters) and gets the app URL: the `bh` of a load this file made, or an invite's launch parameters on
//     Wavedash's own launch (wvdsh_path=/replay/<id>, wvdsh_lobby=<code>, ...: see appUrlFromLaunch), else "/";
//   - history.pushState / replaceState take app URLs and store frame URLs;
//   - page loads the game starts (location.href = ..., location.search = "", a link) are caught with the Navigation
//     API and become loads of the matching frame URL; loads to another site are cancelled and handed to
//     platform/hooks.ts (LEAVE_EVENT).
// The site build never runs any of it.

import { WAVEDASH } from "./env";

/** Fired (detail: the URL) instead of a page load that would take the frame to another site. */
export const LEAVE_EVENT = "bunnyhop:leave";

/** The parameter that carries the app's own path + query through a page load of the entry page. */
export const APP_PARAM = "bh";
const STORE_KEY = "bunnyhop:frame";

interface Frame {
  /** The entry page's path on the frame's origin (e.g. "/index.html"). */
  entry: string;
  /** Wavedash's own query parameters, in order. */
  params: [string, string][];
}

let frame: Frame | null = null;

/**
 * The app URL (path + query) an invite link asks for. Wavedash hands the game page's wvdsh_<name>=<value> parameters
 * to the game as launch parameters (<name>: <value>, in the SDK's config): `path` is the app path (/replay/<id>), every
 * other one becomes ?<name>=<value> (lobby, map, server...). null without any.
 */
export function appUrlFromLaunch(params: Record<string, string>): string | null {
  const path = params.path;
  const u = new URL(path && /^\/[\w./%-]*$/.test(path) ? path : "/", "https://app.invalid");
  let any = !!path;
  for (const [k, v] of Object.entries(params)) {
    if (k === "path" || !/^[a-z][a-z0-9_]{0,31}$/i.test(k)) continue;
    u.searchParams.set(k, v);
    any = true;
  }
  return any ? u.pathname + u.search : null;
}

/** The launch parameters of this launch: the SDK's (it starts before the game), else its config in the frame's query. */
function launchParams(query: URLSearchParams): Record<string, string> {
  let raw: unknown = null;
  try {
    raw = (window as unknown as { Wavedash?: { getLaunchParams(): unknown } }).Wavedash?.getLaunchParams() ?? null;
    if (typeof raw === "string") raw = JSON.parse(raw);
    if (!raw) raw = (JSON.parse(query.get("sdkconfig") ?? "null") as { launchParams?: unknown } | null)?.launchParams ?? null;
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length <= 200));
}

/** The frame URL that shows `app` (an app path + query + hash), with Wavedash's parameters kept. */
export function frameUrl(app: string): string {
  const f = frame;
  const target = new URL(app, "https://app.invalid");
  if (!f) return target.pathname + target.search + target.hash;
  const out = new URL(f.entry, location.origin);
  for (const [k, v] of f.params) out.searchParams.append(k, v);
  // Always present (bh=/ too): a frame URL without it is Wavedash's own launch, whose invite would apply again.
  out.searchParams.set(APP_PARAM, target.pathname + target.search);
  out.hash = target.hash;
  return out.href;
}

/**
 * The app URL (path + query + hash) a URL of the frame's origin stands for: a frame URL's `bh` (or "/" plus whatever
 * else its query has besides Wavedash's parameters), any other URL as it is.
 */
function appUrlOf(url: URL): string {
  const f = frame;
  if (!f || url.pathname !== f.entry) return url.pathname + url.search + url.hash;
  const bh = url.searchParams.get(APP_PARAM);
  if (bh !== null && /^\//.test(bh)) return bh + url.hash;
  const q = new URLSearchParams([...url.searchParams].filter(([k, v]) => k !== APP_PARAM && !f.params.some(([fk, fv]) => fk === k && fv === v)));
  const qs = q.toString();
  return `/${qs ? `?${qs}` : ""}${url.hash}`;
}

/** The page's URL as the game knows it: bunnyhop.lol's path and query (the real address everywhere but Wavedash). */
export function appHref(): string {
  if (!frame) return location.href;
  return new URL(appUrlOf(new URL(location.href)), location.origin).href;
}

/** appHref() as a URL (pathname, search, searchParams, hash). */
export function appLocation(): URL {
  return new URL(appHref());
}

/** `url` is the entry page with all of Wavedash's parameters. */
function sameFrame(f: Frame, url: URL): boolean {
  return url.pathname === f.entry && f.params.every(([k, v]) => url.searchParams.getAll(k).includes(v));
}

interface NavigateEvent extends Event {
  navigationType: "push" | "replace" | "reload" | "traverse";
  destination: { url: string; sameDocument: boolean };
  canIntercept: boolean;
  cancelable: boolean;
  hashChange: boolean;
  downloadRequest: string | null;
  formData: FormData | null;
}

export function installNavigation(): void {
  if (!WAVEDASH || typeof location === "undefined") return;
  const here = new URL(location.href);
  const app = here.searchParams.get(APP_PARAM);
  let stored: Frame | null = null;
  try {
    stored = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "null") as Frame | null;
  } catch {
    stored = null;
  }
  if (app !== null || (stored && stored.params.length > 0 && sameFrame(stored, here))) {
    // A load this file made (or a reload of one): Wavedash's parameters are everything but ours.
    const params = [...here.searchParams].filter(([k]) => k !== APP_PARAM);
    frame = { entry: here.pathname, params: params.length ? params : (stored?.params ?? []) };
  } else {
    // Wavedash's own launch of the entry page.
    frame = { entry: here.pathname, params: [...here.searchParams] };
  }
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(frame));
  } catch {
    /* storage blocked: this page still knows */
  }
  // A load this file made carries its app URL; Wavedash's own launch may carry an invite's.
  const target = app ?? appUrlFromLaunch(launchParams(here.searchParams)) ?? "/";
  const replace = history.replaceState.bind(history);
  const push = history.pushState.bind(history);
  replace(history.state, "", frameUrl(target + here.hash));
  // The game's history calls name app URLs (relative ones resolve against the app URL); the address keeps the frame's.
  const toFrame = (url: string | URL) => frameUrl(appUrlOf(new URL(String(url), appHref())));
  history.replaceState = (state: unknown, unused: string, url?: string | URL | null) => replace(state, unused, url == null ? url : toFrame(url));
  history.pushState = (state: unknown, unused: string, url?: string | URL | null) => push(state, unused, url == null ? url : toFrame(url));

  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener("navigate", (ev) => {
    const e = ev as NavigateEvent;
    // History calls (the menu's screens) and Back / Forward to entries of this frame, which are all frame URLs, stay as
    // they are; only page loads the game starts are rewritten.
    if (e.destination.sameDocument || e.hashChange || e.downloadRequest !== null || e.formData || e.navigationType === "traverse" || !e.cancelable) return;
    const url = new URL(e.destination.url);
    if (url.origin !== location.origin) {
      // Leaving the frame for another site (Discord's sign-in, Stripe, a link): the game would be gone and those pages
      // refuse to be framed anyway. platform/hooks.ts decides what to do instead (LEAVE_EVENT).
      e.preventDefault();
      window.dispatchEvent(new CustomEvent(LEAVE_EVENT, { detail: url.href }));
      return;
    }
    // Already a frame URL as this file writes them (a reload, a load it started): let it load.
    const to = frameUrl(appUrlOf(url));
    if (to === url.href) return;
    e.preventDefault();
    if (e.navigationType === "push") location.assign(to);
    else location.replace(to);
  });
}
