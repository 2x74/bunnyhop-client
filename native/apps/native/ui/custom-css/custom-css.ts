import { API_URL } from "../../../web/src/api";
import { toast } from "../../../web/src/notify";
import { expandImports } from "./imports";
import { MAX_CSS_CHARS, MAX_REMOTE, findImports, onlySafeUrls, rewriteCss } from "./rewrite";

// Custom CSS in the native menu: the player's own stylesheet over the menus,
// kept and applied as on the website (apps/web/src/custom-css/index.ts), plus
// the parts the native HUD can draw (hud-theme.ts). Differences:
// - A .css file chosen in Settings is watched by the host (menu_files.hpp), as
//   in the desktop app, and is used instead of the pasted CSS.
// - Imported themes are fetched on each launch; there's no cached copy.

export const STORE_KEY = "bunnyhop:custom-css";

interface Stored {
  on: boolean;
  css: string;
}

/** The host's watched file: its name, text, and why it can't be used. */
export interface CssFile {
  name: string;
  text: string;
  error: string;
}

export interface CssStatus {
  active: boolean;
  file: CssFile | null;
  links: number;
  loaded: number;
  loading: number;
  failed: { url: string; why: string }[];
  blocked: string[];
  imported: number;
  importing: boolean;
}

const EMPTY_STATUS: CssStatus = {
  active: false,
  file: null,
  links: 0,
  loaded: 0,
  loading: 0,
  failed: [],
  blocked: [],
  imported: 0,
  importing: false,
};

let stored: Stored = { on: true, css: "" };
let file: CssFile | null = null;
let status: CssStatus = EMPTY_STATUS;
let sheet: CSSStyleSheet | null = null;
let generation = 0;
let typingTimer: ReturnType<typeof setTimeout> | null = null;
const statusListeners = new Set<(status: CssStatus) => void>();
const appliedListeners = new Set<(css: string) => void>();
/** Link -> blob: URL of its bytes, revoked once no applied CSS uses it. */
const ready = new Map<string, string>();
const failed = new Map<string, string>();

export const customCss = (): Readonly<Stored> => stored;
export const cssStatus = (): CssStatus => status;
/** The CSS in use: the watched file's when there is one, else the pasted CSS. */
export const activeCss = (): string => (file ? file.text : stored.css);

export function onCssStatus(listener: (status: CssStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** Called with the CSS as applied (imports expanded, links resolved), or "" when off. */
export function onCssApplied(listener: (css: string) => void): () => void {
  appliedListeners.add(listener);
  return () => appliedListeners.delete(listener);
}

function readStored(): Stored {
  try {
    const value = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as Partial<Stored> | null;
    if (value && typeof value === "object") {
      const css = typeof value.css === "string" ? value.css.slice(0, MAX_CSS_CHARS) : "";
      return { on: value.on !== false, css };
    }
  } catch {
    // Unreadable: start empty.
  }
  return { on: true, css: "" };
}

function saveStored(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));
  } catch {
    // Storage full or blocked: still applied for this session.
  }
}

/** Changes the pasted CSS or the switch: saved now, applied once typing pauses. */
export function setCustomCss(patch: Partial<Stored>, options: { now?: boolean } = {}): void {
  const css = (patch.css ?? stored.css).slice(0, MAX_CSS_CHARS);
  stored = { on: patch.on ?? stored.on, css };
  saveStored();
  if (typingTimer) clearTimeout(typingTimer);
  if (options.now) {
    void apply();
    return;
  }
  typingTimer = setTimeout(() => {
    typingTimer = null;
    void apply();
  }, 250);
}

/** The host's watched .css file changed (null: none is watched). */
export function setCssFile(next: CssFile | null): void {
  file = next;
  void apply();
}

function publish(next: Partial<CssStatus>): void {
  status = { ...status, ...next };
  for (const listener of statusListeners) listener(status);
}

function install(css: string): boolean {
  // The rewrite is the defence; this checks that it held.
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
  const removed = sheet;
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((item) => item !== removed);
  sheet = null;
}

/** A link's bytes through the game server's asset proxy. Throws a sentence. */
async function fetchAsset(url: string, kind: "asset" | "css"): Promise<Response> {
  if (API_URL === null) throw new Error("Links can't load here (no game server).");
  let response: Response;
  try {
    response = await fetch(`${API_URL}/css-asset?kind=${kind}&u=${encodeURIComponent(url)}`, { credentials: "omit" });
  } catch {
    throw new Error("Couldn't reach the game server.");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `The link answered ${response.status}.`);
  }
  return response;
}

/** A raw .css file from a link (the editor's Import link): its text, fetched once. */
export async function fetchCssText(url: string): Promise<string> {
  const response = await fetchAsset(url, "css");
  return (await response.text()).slice(0, MAX_CSS_CHARS);
}

async function load(url: string): Promise<void> {
  try {
    const response = await fetchAsset(url, "asset");
    ready.set(url, URL.createObjectURL(await response.blob()));
    failed.delete(url);
  } catch (error) {
    failed.set(url, error instanceof Error ? error.message : String(error));
  }
}

/** Revokes blob URLs no applied CSS uses any more. */
function prune(keep: string[]): void {
  for (const [url, blob] of ready) {
    if (keep.includes(url)) continue;
    URL.revokeObjectURL(blob);
    ready.delete(url);
  }
}

function notifyApplied(css: string): void {
  for (const listener of appliedListeners) listener(css);
}

async function apply(): Promise<void> {
  const current = ++generation;
  const css = activeCss();
  const on = stored.on && css.trim() !== "";
  if (!on) {
    uninstall();
    prune([]);
    publish({ ...EMPTY_STATUS, file });
    notifyApplied("");
    return;
  }
  if (!findImports(css).rules.length) {
    await paint(css, current, { imported: 0, importing: false, failed: [] });
    return;
  }
  // A hosted theme: the text without its imports goes on at once, then the
  // imported files when they arrive.
  void paint(css, current, { imported: 0, importing: true, failed: [] });
  const expanded = await expandImports(css, null, fetchCssText);
  if (current !== generation) return;
  await paint(expanded.css, current, { imported: expanded.imported.length, importing: false, failed: expanded.failed });
}

interface PaintExtra {
  imported: number;
  importing: boolean;
  failed: { url: string; why: string }[];
}

/** Applies `css` at once with links blank, and again once their bytes arrive. */
async function paint(css: string, current: number, extra: PaintExtra): Promise<void> {
  const resolve = (link: string): string | null => ready.get(link) ?? null;
  const first = rewriteCss(css, resolve);
  const links = first.remote.slice(0, MAX_REMOTE);
  const over = first.remote.slice(MAX_REMOTE).map((url) => ({ url, why: `Only the first ${MAX_REMOTE} links load.` }));
  const active = install(first.css);
  const report = (): void => {
    const loaded = links.filter((link) => ready.has(link)).length;
    const bad = links
      .filter((link) => !ready.has(link) && failed.has(link))
      .map((url) => ({ url, why: failed.get(url)! }));
    publish({
      active,
      file,
      links: first.remote.length,
      loaded,
      loading: links.length - loaded - bad.length,
      failed: [...extra.failed, ...bad, ...over],
      blocked: first.blocked,
      imported: extra.imported,
      importing: extra.importing,
    });
  };
  report();
  notifyApplied(active ? first.css : "");
  const todo = links.filter((link) => !ready.has(link) && !failed.has(link));
  if (!active || !todo.length) {
    if (!extra.importing) prune(links);
    return;
  }
  await Promise.all(todo.map((link) => load(link)));
  if (current !== generation) return;
  const final = rewriteCss(css, resolve).css;
  install(final);
  if (!extra.importing) prune(links);
  report();
  notifyApplied(final);
}

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
}

/** Ctrl+Shift+V: the way out of CSS that hides the menus, from anywhere outside a text field. */
function onSafeModeKey(event: KeyboardEvent): void {
  const combo = (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === "KeyV";
  if (!combo || isTextField(event.target) || !activeCss().trim()) return;
  event.preventDefault();
  event.stopPropagation();
  setCustomCss({ on: !stored.on }, { now: true });
  toast(stored.on ? "Custom CSS is on." : "Custom CSS is off. Ctrl+Shift+V turns it back on.");
}

function onHostFile(event: Event): void {
  const detail = (event as CustomEvent<{ name: string | null; text?: string; error?: string }>).detail;
  if (!detail || detail.name === null) {
    setCssFile(null);
    return;
  }
  setCssFile({ name: detail.name, text: detail.text ?? "", error: detail.error ?? "" });
}

let started = false;
/** Once, at boot (main.ts). */
export function initCustomCss(): void {
  if (started) return;
  started = true;
  stored = readStored();
  addEventListener("keydown", onSafeModeKey, true);
  addEventListener("bunnyhop:native-css-file", onHostFile);
  void apply();
}
