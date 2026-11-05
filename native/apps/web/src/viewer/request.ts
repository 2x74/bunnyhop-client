// Replay viewer entry point for any UI (pause menu, end-of-run card, leaderboard rows, profile pages): DOM-free
// request bus, like player/race.ts. While a map is loaded, main.ts listens and opens the viewer in place (switching
// maps when the replay is for another one). With no listener (home screen, profile pages) the request becomes a
// navigation to a viewer URL, which main.ts resolves on load:
//
//   /replay/<runId>              a leaderboard run (api.replay)
//   ?replay=run:<runId>          same, query form (hosts without SPA path fallback)
//   ?map=<m>&replay=pb[&style=<s>][&track=<n>]   your local PB
//   ?map=<m>&replay=pending      bytes stashed in sessionStorage (local files)
//   ?replay=<url>                a .bhr URL
//   /h2h/<runA>/<runB>           two leaderboard runs of one map, head to head (viewer/h2h.ts)

import { appHref, appLocation } from "../platform/navigation";

export type ReplayTarget =
  /** A verified leaderboard run. */
  | { runId: string; name?: string }
  /** Raw .bhr bytes (a local file, the run you just finished, a cached replay). */
  | { bytes: Uint8Array; name?: string }
  /** Your local PB replay: `true` = the current map's selected style on the main track. */
  | { pb: true | { map: string; style?: string; track?: number } };

export interface ViewerRequest {
  target: ReplayTarget;
  /** Server run identity retained when main.ts already fetched its replay bytes. Never set for local files/PBs. */
  sourceRunId?: string;
  /** Optional second replay to overlay as a ghost (compare mode), e.g. WR vs PB. */
  compare?: ReplayTarget;
  /** Head to head (/h2h/<a>/<b>): `target` is run A (left), this is run B (right). Both are leaderboard runs. */
  h2h?: { runId: string };
  /** Watching a whole gauntlet attempt (gauntlet/watch.ts): this replay is split `idx` of `plan`. */
  gauntlet?: { plan: import("../api").GauntletWatchPlan; idx: number };
}

/** Keep preloaded bytes and their server provenance together, without downloading a second time. */
export function preloadedViewerRequest(bytes: Uint8Array, name: string, sourceRunId?: string): ViewerRequest {
  return { target: { bytes, name }, ...(sourceRunId ? { sourceRunId } : {}) };
}
export function viewerRequestRunId(req: ViewerRequest): string | null {
  return "runId" in req.target ? req.target.runId : "bytes" in req.target ? req.sourceRunId ?? null : null;
}

type Listener = (r: ViewerRequest) => void;
let listener: Listener | null = null;

export const PENDING_REPLAY_KEY = "bunnyhop:pending-replay";

function b64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Stashes bytes for the next page load (?replay=pending). */
export function stashPending(bytes: Uint8Array): void {
  sessionStorage.setItem(PENDING_REPLAY_KEY, b64(bytes));
}

export function takePending(): Uint8Array | null {
  const s = sessionStorage.getItem(PENDING_REPLAY_KEY);
  sessionStorage.removeItem(PENDING_REPLAY_KEY);
  return s ? Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) : null;
}

/** URL that opens the viewer on a fresh page load. Bytes targets are stashed (the map comes from the header). */
export function viewerUrl(target: ReplayTarget, map?: string): string {
  // The Worker serves /replay/<runId> (the game plus the run's preview card for link unfurls); ?replay=run:<id> also works.
  if ("runId" in target) return `/replay/${encodeURIComponent(target.runId)}`;
  const u = new URL("/", appHref());
  if ("bytes" in target) {
    stashPending(target.bytes);
    if (map) u.searchParams.set("map", map);
    u.searchParams.set("replay", "pending");
    return u.pathname + u.search;
  }
  const pb = target.pb === true ? null : target.pb;
  const m = pb?.map ?? map ?? appLocation().searchParams.get("map");
  if (m) u.searchParams.set("map", m);
  u.searchParams.set("replay", "pb");
  if (pb?.style) u.searchParams.set("style", pb.style);
  if (pb?.track) u.searchParams.set("track", String(pb.track));
  return u.pathname + u.search;
}

/**
 * Opens the replay viewer: `openReplayViewer({ runId })`, `openReplayViewer({ bytes })`, `openReplayViewer({ pb: true })`.
 * In game it opens over the current map; elsewhere it navigates to a viewer URL.
 */
export function openReplayViewer(target: ReplayTarget, opts: { compare?: ReplayTarget } = {}): void {
  const req: ViewerRequest = { target, compare: opts.compare };
  if (listener) {
    listener(req);
    return;
  }
  if ("bytes" in target) {
    // The map comes from the replay header; peek at it so the page loads the right map.
    void import("../replay").then(async ({ decodeReplay }) => {
      let map: string | undefined;
      try {
        map = (await decodeReplay(target.bytes)).header.map;
      } catch {
        /* main.ts reports the bad file */
      }
      location.href = viewerUrl(target, map);
    });
    return;
  }
  location.href = viewerUrl(target);
}

/** The head-to-head link of two leaderboard runs (the Worker serves it with both players' preview card). */
export function h2hUrl(a: string, b: string): string {
  return `/h2h/${encodeURIComponent(a)}/${encodeURIComponent(b)}`;
}

/** Two runs from a head-to-head path, or null. */
export function h2hFromPath(pathname: string): { a: string; b: string } | null {
  const m = /^\/h2h\/([^/?#]+)\/([^/?#]+)\/?$/.exec(pathname);
  return m ? { a: decodeURIComponent(m[1]), b: decodeURIComponent(m[2]) } : null;
}

/** A run id from a pasted link or id: /replay/<id>, /h2h/<a>/<b> (its first run), ?replay=run:<id>, or the bare id. */
export function runIdFromText(text: string): string | null {
  const s = text.trim();
  if (/^[\w-]{6,64}$/.test(s)) return s;
  try {
    const u = new URL(s, "https://bunnyhop.lol");
    const r = /^\/replay\/([\w-]{6,64})\/?$/.exec(u.pathname);
    if (r) return r[1];
    const hh = h2hFromPath(u.pathname);
    if (hh) return hh.a;
    const q = u.searchParams.get("replay");
    if (q?.startsWith("run:")) return q.slice(4) || null;
  } catch {
    /* not a link */
  }
  return null;
}

/** Head to head: in game over the current map (main.ts switches maps when needed), else a page load of /h2h/<a>/<b>. */
export function openHeadToHead(a: string, b: string): void {
  if (listener) {
    listener({ target: { runId: a }, h2h: { runId: b } });
    return;
  }
  location.href = h2hUrl(a, b);
}

/** main.ts: handle viewer requests while a map is loaded (returns an unsubscribe). */
export function onViewerRequest(l: Listener): () => void {
  listener = l;
  return () => {
    if (listener === l) listener = null;
  };
}

/** Viewer target encoded in the page URL, if any (see the header comment). */
export function viewerTargetFromUrl(loc: Location = location): { target: ReplayTarget | "pending" | { url: string }; style?: string; track?: number; h2h?: { runId: string } } | null {
  const m = /^\/replay\/([^/?#]+)\/?$/.exec(loc.pathname);
  if (m) return { target: { runId: decodeURIComponent(m[1]) } };
  const hh = h2hFromPath(loc.pathname);
  if (hh) return { target: { runId: hh.a }, h2h: { runId: hh.b } };
  const q = new URLSearchParams(loc.search);
  const r = q.get("replay");
  if (!r) return null;
  const track = q.has("track") ? Number(q.get("track")) || 0 : undefined;
  if (r === "pb") return { target: { pb: true }, style: q.get("style") ?? undefined, track };
  if (r === "pending") return { target: "pending" };
  if (r.startsWith("run:")) return { target: { runId: decodeURIComponent(r.slice(4)) } };
  return { target: { url: r } };
}
