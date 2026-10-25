// Which build this is. The site (bunnyhop.lol) serves the game from its own origin; the Wavedash build
// (`bun run build:wavedash`, research/WAVEDASH.md) is the same client hosted by Wavedash, in a cross-origin,
// cross-origin-isolated iframe on builds.wavedashcdn.com, talking to bunnyhop.lol for everything online.

/** This is the Wavedash build (VITE_WAVEDASH=1 at build time). Constant, so the other build drops its branches. */
export const WAVEDASH: boolean = import.meta.env?.VITE_WAVEDASH === "1";

/** The site's origin: where map files, thumbnails and shared links live. */
export const SITE_ORIGIN = "https://bunnyhop.lol";

/** The public Wavedash game page (invites and "play on Wavedash" links). */
export const WAVEDASH_GAME_URL = "https://wavedash.com/games/bunnyhop-lol";

/**
 * The site's own root-relative paths the game asks for: the API, map index / zones / tutorial data, map files and
 * images. Anything else root-relative (the build's /assets, Wavedash's own /auth/..., /sw-embed.js) stays on the frame.
 */
const SITE_PATH = /^\/(?:api\/|thumbs\/|icons\/|og\/|index\.json(?:$|\?)|[\w.-]+\.(?:bsp|zones\.json|tutorial\.json)(?:$|\?))/;

/**
 * A site path ("/thumbs/x.jpg", "/index.json", "/api/bsp/<sha>.bsp") as a URL that works in this build: unchanged on
 * the site, absolute on bunnyhop.lol in the Wavedash build. Other paths and anything already absolute (https:, data:,
 * blob:) stay as they are.
 */
export function siteUrl(path: string): string;
export function siteUrl(path: string | null | undefined): string | null | undefined;
export function siteUrl(path: string | null | undefined): string | null | undefined {
  if (!WAVEDASH || !path || !SITE_PATH.test(path)) return path;
  return SITE_ORIGIN + path;
}

/**
 * A public site file (map file, content, thumbnail, icon) under its own browser-cache key. Until 2026-10-22 these
 * answers named the requesting frame's origin in their CORS header (or had none): a browser could reuse the copy an
 * earlier Wavedash build (another origin) cached, for a year, and refuse it. bunnyhop.lol ignores the parameter.
 */
export function freshKey(url: string): string {
  return url + (url.includes("?") ? "&" : "?") + "cors=any";
}

/** The site's static images (thumbnails, icons, share cards): public, CORS *. */
const SITE_IMAGE = /^https:\/\/bunnyhop\.lol\/(?:thumbs|icons|og)\//;
export const isSiteImage = (url: string): boolean => SITE_IMAGE.test(url);

/** Origin for links people share (map, replay, profile pages): the site's, in either build. */
export function publicOrigin(): string {
  return WAVEDASH ? SITE_ORIGIN : location.origin;
}
