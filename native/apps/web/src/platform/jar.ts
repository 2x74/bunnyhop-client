// The Wavedash build's cookies. In Wavedash's iframe bunnyhop.lol is a third-party site: its SameSite=Lax session
// cookie is never sent, and many browsers drop third-party cookies altogether. So this build keeps the bh_* cookies
// the API sets itself, here, and hands them over on every API request (x-bh-jar) and WebSocket (a "bhjar.<base64url>"
// subprotocol next to "bh"); the Worker turns them back into ordinary cookies and returns new ones in x-bh-jar-set
// (apps/api/src/wavedash.ts "COOKIE TUNNEL"). Kept in the frame's localStorage, which Wavedash scopes to this player
// and build. Nothing here runs on the site.

import { freshKey, SITE_ORIGIN, siteUrl, WAVEDASH } from "./env";

const STORE_KEY = "bunnyhop:jar";
export const JAR_HEADER = "x-bh-jar";
export const JAR_SET_HEADER = "x-bh-jar-set";
export const WS_PROTOCOL = "bh";
export const WS_JAR_PREFIX = "bhjar.";

const API_PREFIX = `${SITE_ORIGIN}/api/`;

let jar: Record<string, string> = load();

function load(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => /^bh_[a-z_]{1,24}$/.test(e[0]) && typeof e[1] === "string"));
  } catch {
    return {};
  }
}

function save(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(jar));
  } catch {
    /* storage blocked: the jar lasts this page */
  }
}

/** Sets (value) or deletes (null) one cookie; values as in a Cookie header (already URL-encoded). */
export function setJarCookie(name: string, value: string | null): void {
  if (!/^bh_[a-z_]{1,24}$/.test(name)) return;
  if (value === null) delete jar[name];
  else jar[name] = value;
  save();
}

/** The jar as a Cookie header value ("" when empty). */
export function jarHeader(): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/** Signs this build out of everything the jar holds (a fresh start, e.g. after a failed link). */
export function clearJar(): void {
  jar = {};
  save();
}

/** Applies a response's x-bh-jar-set ([[name, value | null], ...]). */
export function absorbJar(res: Response): void {
  const raw = res.headers.get(JAR_SET_HEADER);
  if (!raw) return;
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return;
    for (const c of list) if (Array.isArray(c) && typeof c[0] === "string" && (typeof c[1] === "string" || c[1] === null)) setJarCookie(c[0], c[1]);
  } catch {
    /* malformed: ignore */
  }
}

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** WebSocket subprotocols for an API socket: ours, plus the jar. */
export function jarProtocols(): string[] {
  const h = jarHeader();
  return h ? [WS_PROTOCOL, WS_JAR_PREFIX + b64url(h)] : [WS_PROTOCOL];
}

const isApi = (url: string) => url.startsWith(API_PREFIX);

/** Map files and content (bunnyhop.lol answers them with CORS *, no cookies needed: apps/api src/index.ts PUBLIC_FILE). */
const PUBLIC_FILE = /^https:\/\/bunnyhop\.lol\/(?:api\/(?:bsp|content|content-manifests)\/[^?]+|[\w.-]+\.bsp)(?:$|\?)/;

/**
 * Wavedash build only: global fetch and WebSocket learn the tunnel. Root-relative site paths (map index, zones,
 * tutorial data, map files) go to bunnyhop.lol; API requests carry the jar and bring cookies back; API sockets offer
 * the jar as a subprotocol. Everything else (the build's own /assets) is untouched.
 */
export function installJar(): void {
  if (!WAVEDASH || typeof window === "undefined") return;
  const plainFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === "string" || input instanceof URL) {
      const url = siteUrl(String(input));
      if (PUBLIC_FILE.test(url)) return plainFetch(freshKey(url), init);
      if (!isApi(url)) return plainFetch(url, init);
      const headers = new Headers(init?.headers);
      const h = jarHeader();
      if (h) headers.set(JAR_HEADER, h);
      const res = await plainFetch(url, { ...init, headers });
      absorbJar(res);
      return res;
    }
    if (!isApi(input.url)) return plainFetch(input, init);
    const req = new Request(input, init);
    const h = jarHeader();
    if (h) req.headers.set(JAR_HEADER, h);
    const res = await plainFetch(req);
    absorbJar(res);
    return res;
  };
  const PlainSocket = window.WebSocket;
  const api = API_PREFIX.replace(/^https:/, "wss:");
  class JarSocket extends PlainSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const u = String(url);
      super(u, protocols === undefined && u.startsWith(api) ? jarProtocols() : protocols);
    }
  }
  window.WebSocket = JarSocket;
}
