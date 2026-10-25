import { appHref, appLocation } from "../platform/navigation";
import { publicOrigin } from "../platform/env";
// Tiny navigation bus so any UI (leaderboard rows, home cards, the account chip) can open a profile or the rank
// board without importing the menu shell (menu.ts registers the handler in initMenu).

/** Profile: optionally open on a tab ("overview" | "loadout" | "runs", or "card": the card editor) and a slot. */
export type NavRequest =
  | { screen: "profile"; id: string; tab?: string; slot?: string }
  | { screen: "ranks"; scope?: string; page?: number }
  /** Map browser, optionally previewing a map (/maps/<name> links). */
  | { screen: "maps"; focus?: string }
  | { screen: "servers" }
  | { screen: "stats" }
  /** Loadout (everything you look like in the game): your profile's Loadout tab (offline: kept on this device), optionally on a category. */
  | { screen: "loadout"; slot?: string }
  /** The Support page (ui/support.ts): how to support the game and everything supporters get. */
  | { screen: "support" }
  /** Gauntlets (ui/gauntlets.ts): the list, one gauntlet's page, or (`attempt`) an attempt's result. */
  | { screen: "gauntlets" }
  | { screen: "gauntlet"; slug: string; attempt?: string | null };

let handler: ((r: NavRequest) => void) | null = null;

export function navigate(r: NavRequest): void {
  if (handler) handler(r);
  else {
    // No menu shell (yet): fall back to a page load.
    const url = new URL(appHref());
    url.search = "";
    if (r.screen === "profile") url.pathname = `/u/${encodeURIComponent(r.id)}`;
    else if (r.screen === "ranks") {
      url.pathname = "/ranks";
      if (r.scope && r.scope !== "all") url.searchParams.set("style", r.scope);
      if (r.page && r.page > 1) url.searchParams.set("page", String(r.page));
    }
    else if (r.screen === "maps") url.pathname = r.focus ? `/maps/${encodeURIComponent(r.focus)}` : "/maps";
    else if (r.screen === "stats") url.pathname = "/stats";
    else if (r.screen === "loadout") url.pathname = "/";
    else if (r.screen === "support") (url.pathname = "/"), url.searchParams.set("support", "");
    else if (r.screen === "gauntlets") url.pathname = "/gauntlets";
    else if (r.screen === "gauntlet") {
      url.pathname = `/g/${encodeURIComponent(r.slug)}`;
      if (r.attempt) url.searchParams.set("attempt", r.attempt);
    }
    else url.pathname = "/servers";
    location.href = url.toString();
  }
}

export function onNavigate(h: (r: NavRequest) => void): void {
  handler = h;
}

let localPop: (() => void) | null = null;

/**
 * The menu takes the next popstate itself (a Back it started with history.back(): the screen under it is still live),
 * instead of the page reload every other Back gets (main.ts). One at a time; the latest claim wins.
 */
export function claimNextPop(fn: () => void): void {
  localPop = fn;
}

/** main.ts's popstate listener: runs the menu's claim and returns true, or false (nothing claimed: reload). */
export function takeLocalPop(): boolean {
  const fn = localPop;
  localPop = null;
  if (!fn) return false;
  fn();
  return true;
}

/** Shareable profile link: /u/<id> (the Worker serves it with the player card as its preview image). */
export function profileUrl(id: string): string {
  return `${publicOrigin()}/u/${encodeURIComponent(id)}`;
}

/**
 * Screen requested by the page URL: /u/<id> (or ?u=<id>), /ranks[?style=<style>&page=<n>] (or ?ranks=<scope>), /maps,
 * /maps/<name>, /servers, /gauntlets, /g/<slug>[?attempt=<id>], /?support (the About page's link).
 * The Worker serves these paths with per-page meta (apps/api/src/seo/); /replay/<id> is the viewer's (viewer/request.ts).
 */
export function routeFromUrl(): NavRequest | null {
  const here = appLocation();
  const p = here.searchParams;
  const path = here.pathname.replace(/\/+$/, "");
  const u = p.get("u") ?? /^\/u\/([\w-]+)$/.exec(path)?.[1] ?? null;
  if (u) return { screen: "profile", id: u };
  const r = p.get("ranks");
  const page = Math.max(1, Number.parseInt(p.get("page") ?? "1", 10) || 1);
  if (r !== null) return { screen: "ranks", scope: r || "all", page };
  if (path === "/ranks") return { screen: "ranks", scope: p.get("style") || "all", page };
  if (path === "/maps") return { screen: "maps" };
  const m = /^\/maps\/([\w.-]+)$/.exec(path);
  if (m) return { screen: "maps", focus: decodeURIComponent(m[1]) };
  if (path === "/stats") return { screen: "stats" };
  if (path === "/servers") return { screen: "servers" };
  if (path === "/gauntlets") return { screen: "gauntlets" };
  const g = /^\/g\/([a-z0-9-]+)$/.exec(path);
  if (g) return { screen: "gauntlet", slug: g[1], attempt: p.get("attempt") };
  if (p.has("support")) return { screen: "support" };
  return null;
}

// ---------------------------------------------------------------------------------------------
// "Save progress" (guests): the profile's nudge asks for the account flow without knowing how it works. The account /
// onboarding UI registers its entry point with onSaveProgress(); until then this falls back to linking Discord.

let saveHandler: (() => void) | null = null;

export function onSaveProgress(fn: () => void): void {
  saveHandler = fn;
}

export function requestSaveProgress(fallback: () => void): void {
  (saveHandler ?? fallback)();
}
