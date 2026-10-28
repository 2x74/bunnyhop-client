// Custom CSS (Settings -> Custom CSS; the editor is custom-css/editor.ts): the player's own stylesheet over the menus
// and the HUD. Pasted, kept in this browser (localStorage), shared by pasting it anywhere. In the
// desktop app a .css file can stand in for it (client-bridge.ts watchClientCustomCss: the app sends the file's text
// each time it's saved).
//
// APPLIED as a constructed stylesheet in document.adoptedStyleSheets, which the cascade puts after every <style> and
// <link> of the page (lazy-loaded chunks' CSS included), so a rule wins over ours at equal specificity.
//
// URLS. The text never reaches the browser as written: rewrite.ts turns every link into a blob: URL of bytes fetched
// once, up front, through /api/css-asset (apps/api/src/css-assets.ts), and anything else into a blank pixel. The sheet
// goes on at once with links blank (colours, fonts that are installed, layout), and again when the images arrive.
//
// SAFE MODE, for CSS that hides the way back to this setting: Ctrl+Shift+V switches it off (and on again) anywhere,
// the desktop app and the Wavedash build included, which have no address bar; on the site ?nocss in the address also
// loads the game without it for that visit.
//
// PROMISED to CSS authors (the guide: /custom-css, custom-css.html and public-site/custom-css.md): the :root variables in style.css, #hud [data-el="..."] (the HUD
// element ids are fixed: layout share codes depend on them), #custom-art, the live numbers (live.ts). Everything else
// (class names, structure) may change in any release.

import { API_URL } from "../api";
import { watchClientCustomCss, type ClientCustomCss } from "../client-bridge";
import { appLocation } from "../platform/navigation";
import { findImports, MAX_CSS_CHARS, MAX_REMOTE, onlySafeUrls, rewriteCss } from "./rewrite";
import { expandImports } from "./imports";
import { setLiveVars } from "./live";
import { isTextField } from "../input";
import { toast } from "../notify";

export const STORE_KEY = "bunnyhop:custom-css";

interface Stored {
  on: boolean;
  css: string;
}

export interface CssStatus {
  /** A sheet is on the page. */
  active: boolean;
  /** ?nocss: off for this visit. */
  safeMode: boolean;
  /** The desktop app's file (its name) is in use instead of the pasted CSS. */
  desktop: string | null;
  /** Links in the CSS / loaded / still loading. */
  links: number;
  loaded: number;
  loading: number;
  /** Links that didn't load, and why. */
  failed: { url: string; why: string }[];
  /** URLs that may not load (relative paths, other schemes). */
  blocked: string[];
  /** Files pulled in by @import (a hosted theme), and whether they're still being fetched. */
  imported: number;
  importing: boolean;
}

function read(): Stored {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as Partial<Stored> | null;
    if (v && typeof v === "object") return { on: v.on !== false, css: typeof v.css === "string" ? v.css.slice(0, MAX_CSS_CHARS) : "" };
  } catch {
    /* unreadable: start empty */
  }
  return { on: true, css: "" };
}

let stored: Stored = { on: true, css: "" };
let desktop: ClientCustomCss | null = null;
let safeMode = false;
let sheet: CSSStyleSheet | null = null;
let generation = 0;
let status: CssStatus = { active: false, safeMode: false, desktop: null, links: 0, loaded: 0, loading: 0, failed: [], blocked: [], imported: 0, importing: false };
const listeners = new Set<(s: CssStatus) => void>();

/** Link -> blob: URL of its bytes, for this page's life (revoked once no applied CSS uses it). */
const ready = new Map<string, string>();
const failed = new Map<string, { why: string; at: number }>();
const inflight = new Map<string, Promise<void>>();
/** A failed link is tried again after this long (when the CSS is applied again). */
const RETRY_MS = 10_000;

export const customCss = (): Readonly<Stored> => stored;
export const cssStatus = (): CssStatus => status;
export function onCssStatus(fn: (s: CssStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The CSS in use: the desktop app's file if one is set, else the pasted one. */
const text = () => (desktop ? desktop.css : stored.css);
export const activeCss = text;

function save(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));
  } catch {
    /* storage full or blocked: still applied for this visit */
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
/** Changes the pasted CSS or the switch; saved now, applied after typing pauses. */
export function setCustomCss(patch: Partial<Stored>, o: { now?: boolean } = {}): void {
  stored = { on: patch.on ?? stored.on, css: (patch.css ?? stored.css).slice(0, MAX_CSS_CHARS) };
  save();
  if (timer) clearTimeout(timer);
  if (o.now) void apply();
  else timer = setTimeout(() => ((timer = null), void apply()), 250);
}

function publish(next: Partial<CssStatus>): void {
  status = { ...status, ...next };
  for (const l of listeners) l(status);
}

function install(css: string): boolean {
  // The rewrite is the defence; this is the check that it held. Never apply what fails it.
  if (!onlySafeUrls(css)) {
    console.error("custom CSS: a URL survived the rewrite; not applied");
    uninstall();
    return false;
  }
  if (!sheet) {
    sheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }
  sheet.replaceSync(css);
  return true;
}

function uninstall(): void {
  if (!sheet) return;
  const s = sheet;
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== s);
  sheet = null;
}

/** Fetches a link's bytes through /api/css-asset. */
async function fetchAsset(url: string, kind: "asset" | "css"): Promise<Response> {
  if (API_URL === null) throw new Error("Links can't load here (no game server).");
  let res: Response;
  try {
    res = await fetch(`${API_URL}/css-asset?kind=${kind}&u=${encodeURIComponent(url)}`, { credentials: "omit" });
  } catch {
    throw new Error("Couldn't reach the game server.");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `The link answered ${res.status}.`);
  }
  return res;
}

function load(url: string): Promise<void> {
  let p = inflight.get(url);
  if (p) return p;
  p = fetchAsset(url, "asset")
    .then((r) => r.blob())
    .then((b) => {
      ready.set(url, URL.createObjectURL(b));
      failed.delete(url);
    })
    .catch((e: unknown) => void failed.set(url, { why: e instanceof Error ? e.message : String(e), at: Date.now() }))
    .finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

/** Revokes blob URLs no applied CSS uses any more. */
function prune(keep: string[]): void {
  for (const [url, blob] of ready) {
    if (keep.includes(url)) continue;
    URL.revokeObjectURL(blob);
    ready.delete(url);
  }
}

// The last expansion of a sheet with @import (the text it came from, the result), kept in Cache Storage (it can be
// a few hundred KB: too big for localStorage, which the game shares) so a hosted theme is on at once on the next visit
// while it's fetched fresh.
const EXPANDED_CACHE = "bunnyhop-custom-css";
const EXPANDED_KEY = "/__custom-css/expanded";
interface Expanded {
  source: string;
  css: string;
  imported: number;
}
async function readExpanded(): Promise<Expanded | null> {
  try {
    const hit = await (await caches.open(EXPANDED_CACHE)).match(EXPANDED_KEY);
    return hit ? ((await hit.json()) as Expanded) : null;
  } catch {
    return null;
  }
}
function saveExpanded(e: Expanded): void {
  void globalThis.caches
    ?.open(EXPANDED_CACHE)
    .then((c) => c.put(EXPANDED_KEY, new Response(JSON.stringify(e), { headers: { "content-type": "application/json" } })))
    .catch(() => {});
}

async function apply(): Promise<void> {
  const g = ++generation;
  const css = text();
  const off = safeMode || !css.trim() || !stored.on;
  if (off) {
    painting++;
    uninstall();
    setLiveVars("");
    prune([]);
    return publish({ active: false, safeMode, desktop: desktop?.name ?? null, links: 0, loaded: 0, loading: 0, failed: [], blocked: [], imported: 0, importing: false });
  }
  if (!findImports(css).rules.length) return paint(css, { imported: 0, importing: false, failed: [] });
  // A hosted theme: last visit's expansion of this same text goes on at once (else the text without its imports),
  // then the imports are fetched fresh, so the author's updates arrive on the next load.
  const cached = await readExpanded();
  if (g !== generation) return;
  const hit = cached?.source === css ? cached : null;
  void paint(hit ? hit.css : css, { imported: hit?.imported ?? 0, importing: true, failed: [] });
  const ex = await expandImports(css, null, fetchCssText);
  if (g !== generation) return;
  if (!ex.failed.length || !hit) saveExpanded({ source: css, css: ex.css, imported: ex.imported.length });
  // An import that failed this time keeps last visit's copy rather than dropping the theme.
  const use = ex.failed.length && hit ? hit.css : ex.css;
  await paint(use, { imported: ex.imported.length, importing: false, failed: ex.failed });
}

let painting = 0;
/** Applies `css` (imports already expanded): at once with links blank, again as their bytes arrive. */
async function paint(css: string, extra: { imported: number; importing: boolean; failed: { url: string; why: string }[] }): Promise<void> {
  const p = ++painting;
  const resolve = (u: string) => ready.get(u) ?? null;
  const first = rewriteCss(css, resolve);
  const links = first.remote.slice(0, MAX_REMOTE);
  const over = first.remote.slice(MAX_REMOTE).map((url) => ({ url, why: `Only the first ${MAX_REMOTE} links load.` }));
  const active = install(first.css);
  setLiveVars(active ? css : "");
  const now = Date.now();
  const todo = links.filter((u) => !ready.has(u) && (!failed.has(u) || now - failed.get(u)!.at > RETRY_MS));
  const report = () => {
    const done = links.filter((u) => ready.has(u)).length;
    const bad = links.filter((u) => !ready.has(u) && failed.has(u)).map((url) => ({ url, why: failed.get(url)!.why }));
    publish({
      active,
      safeMode,
      desktop: desktop?.name ?? null,
      links: first.remote.length,
      loaded: done,
      loading: links.length - done - bad.length,
      failed: [...extra.failed, ...bad, ...over],
      blocked: first.blocked,
      imported: extra.imported,
      importing: extra.importing,
    });
  };
  report();
  if (!active || !todo.length) return void (p === painting && !extra.importing && prune(links));
  await Promise.all(todo.map((u) => load(u).then(() => p === painting && report())));
  if (p !== painting) return;
  install(rewriteCss(css, resolve).css);
  if (!extra.importing) prune(links);
  report();
}

/** A raw CSS file from a link (pastebin raw, a gist), for the editor's Import: its text, fetched once. */
export async function fetchCssText(url: string): Promise<string> {
  const res = await fetchAsset(url, "css");
  return (await res.text()).slice(0, MAX_CSS_CHARS);
}

let started = false;
/** Once, at boot (main.ts). */
export function initCustomCss(): void {
  if (started) return;
  started = true;
  stored = read();
  safeMode = appLocation().searchParams.has("nocss");
  watchClientCustomCss((file) => {
    desktop = file;
    void apply();
  });
  // The way out of CSS that hides the menus (works wherever the page has focus, outside text fields).
  addEventListener(
    "keydown",
    (e) => {
      if (!((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyV") || isTextField(e.target) || !text().trim()) return;
      e.preventDefault();
      e.stopPropagation();
      setCustomCss({ on: !stored.on }, { now: true });
      toast(stored.on ? "Custom CSS is on." : "Custom CSS is off. Ctrl+Shift+V turns it back on.");
    },
    true,
  );
  // Another tab changed it.
  addEventListener("storage", (e) => {
    if (e.key !== STORE_KEY) return;
    stored = read();
    void apply();
  });
  void apply();
}
