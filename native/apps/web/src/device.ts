// Device id + fingerprint (anticheat v2, research/ANTICHEAT.md "v2"; the server side is apps/api src/network.ts).
//
// Device id: a long-lived random id for this browser, "<created, base36 ms>-<16 random bytes>", kept in three places:
// localStorage, IndexedDB and a first-party cookie (bh_did, 2 years). Clearing one or two of them doesn't reset it: on
// every page load the copies are read, the oldest id (smallest created time) wins, and every store is written back.
// The cookie rides along with every API request on the same site; POSTs also send it as x-bh-device.
//
// Fingerprint: what the browser exposes about the machine (WebGL renderer / vendor and capabilities, screen, pixel
// ratio, timezone, languages, cores, memory, platform, a small canvas render), hashed (x-bh-fp on POSTs). The raw
// components go with run diagnostics (selfcheck.ts) for staff. Browser version strings are kept out of the hash so an
// update doesn't change it (uaMajor is sent as a component only).
//
// Bans of a network / device / fingerprint and ban-evasion detection are server-side (src/network.ts). Nothing here is
// secret or trusted: a cheater can strip all of it; it only has to catch the ones who don't.

import { gpuInfo, glCaps } from "./gpu-info";

const KEY = "bh_did";
const COOKIE_DAYS = 730;
const ID_RE = /^[0-9a-z]{6,12}-[\w-]{16,32}$/;

export interface FingerprintComponents {
  renderer?: string;
  vendor?: string;
  maxTex?: number;
  screen?: string;
  dpr?: number;
  tz?: string;
  langs?: string;
  cores?: number;
  mem?: number;
  platform?: string;
  brands?: string;
  uaMajor?: number;
  glHash?: string;
  canvasHash?: string;
}

const created = (id: string) => parseInt(id.split("-")[0], 36);

function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const r = btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${Date.now().toString(36)}-${r}`;
}

function readCookie(): string | null {
  const m = /(?:^|;\s*)bh_did=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : null;
}

function writeCookie(id: string): void {
  try {
    document.cookie = `${KEY}=${encodeURIComponent(id)}; Path=/; Max-Age=${COOKIE_DAYS * 86400}; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  } catch {
    /* cookies off */
  }
}

function idb<T>(fn: (s: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open("bunnyhop-device", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("kv");
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        try {
          const req = fn(open.result.transaction("kv", mode).objectStore("kv"));
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      };
    } catch {
      resolve(null);
    }
  });
}

let current: string | null = null;
let reconciled: Promise<string> | null = null;

/** The oldest valid id among the stores (and `extra`), or a new one; written back everywhere. */
function settle(found: (string | null | undefined)[]): string {
  const ok = found.filter((x): x is string => typeof x === "string" && ID_RE.test(x));
  const id = ok.sort((a, b) => created(a) - created(b))[0] ?? current ?? newId();
  current = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* storage off */
  }
  writeCookie(id);
  return id;
}

/** This browser's device id now (sync: localStorage / cookie); deviceIdSettled() also folds in IndexedDB. */
export function deviceId(): string {
  if (current) return current;
  let ls: string | null = null;
  try {
    ls = localStorage.getItem(KEY);
  } catch {
    /* storage off */
  }
  return settle([ls, readCookie()]);
}

/** The device id once IndexedDB has been read (and every store agrees). */
export function deviceIdSettled(): Promise<string> {
  reconciled ??= (async () => {
    const first = deviceId();
    const stored = await idb<string>((s) => s.get(KEY), "readonly");
    const id = settle([first, stored]);
    if (stored !== id) await idb((s) => s.put(id, KEY), "readwrite");
    return id;
  })();
  return reconciled;
}

async function sha(s: string, n = 32): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("").slice(0, n);
}

/** A small 2D canvas render (text, emoji, gradient, arcs): fonts, anti-aliasing and the GPU / driver show in it. */
function canvasRender(): string {
  try {
    const c = document.createElement("canvas");
    c.width = 220;
    c.height = 40;
    const g = c.getContext("2d");
    if (!g) return "";
    const grad = g.createLinearGradient(0, 0, 220, 0);
    grad.addColorStop(0, "#f60");
    grad.addColorStop(1, "#06c");
    g.fillStyle = grad;
    g.fillRect(0, 0, 220, 40);
    g.font = "16px Arial, sans-serif";
    g.fillStyle = "rgba(20,20,20,0.8)";
    g.fillText("bunnyhop.lol \u{1F407} 0.123", 4, 24);
    g.beginPath();
    g.arc(190, 20, 14, 0, Math.PI * 1.7);
    g.strokeStyle = "#fff";
    g.stroke();
    return c.toDataURL();
  } catch {
    return "";
  }
}

let fp: Promise<{ hash: string; components: FingerprintComponents }> | null = null;

/** The fingerprint (hash + components), computed once per page. */
export function fingerprint(): Promise<{ hash: string; components: FingerprintComponents }> {
  fp ??= (async () => {
    const gpu = gpuInfo(true);
    const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { platform?: string; brands?: { brand: string; version: string }[] } };
    const chrome = /Chrom(?:e|ium)\/(\d+)/.exec(nav.userAgent);
    const firefox = /Firefox\/(\d+)/.exec(nav.userAgent);
    const [glHash, canvasHash] = await Promise.all([sha(glCaps(), 16), sha(canvasRender(), 16)]);
    const c: FingerprintComponents = {
      renderer: gpu?.renderer.slice(0, 128),
      vendor: gpu?.vendor.slice(0, 64),
      maxTex: gpu?.maxTexture,
      screen: `${screen.width}x${screen.height}`,
      dpr: Math.round(devicePixelRatio * 100) / 100,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      langs: (nav.languages ?? [nav.language]).join(",").slice(0, 96),
      cores: nav.hardwareConcurrency,
      mem: nav.deviceMemory,
      platform: (nav.userAgentData?.platform ?? nav.platform ?? "").slice(0, 32),
      brands: nav.userAgentData?.brands?.map((b) => b.brand).filter((b) => !/not.?a.?brand/i.test(b)).join(",").slice(0, 96),
      uaMajor: chrome ? Number(chrome[1]) : firefox ? Number(firefox[1]) : undefined,
      glHash,
      canvasHash,
    };
    // Stable parts only: no browser version (an update must not change the fingerprint).
    const { uaMajor: _v, ...stable } = c;
    return { hash: await sha(JSON.stringify(stable)), components: c };
  })();
  return fp;
}

/** Headers for API writes: the device id and the fingerprint hash (best effort: never throws). */
export async function deviceHeaders(): Promise<Record<string, string>> {
  try {
    const [id, f] = await Promise.all([deviceIdSettled(), fingerprint()]);
    return { "x-bh-device": id, "x-bh-fp": f.hash };
  } catch {
    return {};
  }
}
