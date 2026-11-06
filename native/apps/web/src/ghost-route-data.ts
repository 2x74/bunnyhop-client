// Route geometry comes from the ghost's simulated feet positions, not the camera or its fading trail.
import { EVENT_JUMPED, EVENT_TELEPORTED } from "./core";
import type { GhostKind } from "./player/colors";
import { FRAME_GROUNDED, FRAME_STRIDE } from "./sim";
import type { Prefs } from "./ui/settings";

export type GhostRouteSource = "auto" | GhostKind;
export type GhostRouteMode = "jumps" | "path";
const ROUTE_PRIORITY: readonly GhostKind[] = ["custom", "pb", "wr"];
export interface RouteFrames {
  frames: Float32Array;
  startTick: number;
  endTick: number;
  /** Exact events when available (all native ghosts). Older positional imports only have ground flags. */
  frameEvents?: Uint8Array;
}
export interface RouteData {
  /** Independent segment endpoint pairs in Three.js space. Teleports never join. */
  segments: Float32Array;
  /** Takeoff box centres (Three.js space), in the same order as jumpTicks. */
  jumps: Float32Array;
  /** The tick the jump happened; its marker is at the preceding frame's feet position. */
  jumpTicks: Uint32Array;
}

/** Auto prefers the leaderboard/file ghost the player chose to race, then PB, then WR. Explicit choices never fall back. */
export function routeGhostKind(source: GhostRouteSource, available: readonly GhostKind[]): GhostKind | null {
  if (source === "pb" || source === "wr" || source === "custom") return available.includes(source) ? source : null;
  return ROUTE_PRIORITY.find((kind) => available.includes(kind)) ?? null;
}

export interface GhostPlan {
  /** Fetch the server WR ghost for this track (it races, or only its route shows). */
  fetchWR: boolean;
  /** The ghost whose route is drawn this frame. */
  routeKind: GhostKind | null;
  /** Route only: the ghost drawn as its route alone (no model, trail, tag or sounds). It still counts for the split. */
  routeOnlyKind: GhostKind | null;
}

/**
 * Per-frame ghost decisions from the settings. loaded: ghost kinds loaded for this track and style. hidden: watching a
 * replay (no ghosts at all); hideUi: the UI is hidden (routes go with it; a route-only ghost stays hidden).
 */
export function ghostPlan(p: Pick<Prefs, "showGhost" | "ghost">, loaded: readonly GhostKind[], hidden: boolean, hideUi: boolean): GhostPlan {
  const g = p.ghost;
  const on = p.showGhost && !hidden;
  const routed = on && g.route ? routeGhostKind(g.routeSource, (["pb", "wr", "custom"] as const).filter((k) => g[k] && loaded.includes(k))) : null;
  return { fetchWR: on && g.wr, routeKind: hideUi ? null : routed, routeOnlyKind: g.routeOnly ? routed : null };
}

/** Static geometry, built once on demand. Keep start/finish legs and cut at teleports, even short ones. */
export function buildGhostRoute(d: RouteFrames, mode: GhostRouteMode): RouteData {
  const f = d.frames;
  const n = Math.floor(f.length / FRAME_STRIDE);
  const empty = (): RouteData => ({ segments: new Float32Array(), jumps: new Float32Array(), jumpTicks: new Uint32Array() });
  if (!n || !Number.isFinite(d.startTick) || !Number.isFinite(d.endTick) || d.endTick < d.startTick) return empty();
  let start = Math.max(0, Math.min(n - 1, Math.floor(d.startTick)));
  const end = Math.max(start, Math.min(n - 1, Math.floor(d.endTick)));
  const events = d.frameEvents && d.frameEvents.length >= n ? d.frameEvents : undefined;
  // A timer that begins on the jump tick still needs that jump's ground position.
  if (start > 0 && events && (events[start] & EVENT_JUMPED) && !(events[start] & EVENT_TELEPORTED)) start--;
  const valid = (t: number) => Number.isFinite(f[t * FRAME_STRIDE]) && Number.isFinite(f[t * FRAME_STRIDE + 1]) && Number.isFinite(f[t * FRAME_STRIDE + 2]);
  const jumped = (t: number): boolean => events ? !!(events[t] & EVENT_JUMPED) :
    !!(f[(t - 1) * FRAME_STRIDE + 3] & FRAME_GROUNDED) && !(f[t * FRAME_STRIDE + 3] & FRAME_GROUNDED) && f[t * FRAME_STRIDE + 2] > f[(t - 1) * FRAME_STRIDE + 2];
  const teleported = (t: number): boolean => events ? !!(events[t] & EVENT_TELEPORTED) :
    Math.abs(f[t * FRAME_STRIDE] - f[(t - 1) * FRAME_STRIDE]) + Math.abs(f[t * FRAME_STRIDE + 1] - f[(t - 1) * FRAME_STRIDE + 1]) + Math.abs(f[t * FRAME_STRIDE + 2] - f[(t - 1) * FRAME_STRIDE + 2]) > 200;
  const links: number[] = [];
  // Full paths allocate their final maximum buffer directly rather than a large intermediate JS number array.
  const path = mode === "path" ? new Float32Array((end - start) * 6) : null;
  let pathLength = 0;
  const jumps: number[] = [];
  const ticks: number[] = [];
  const point = (out: number[] | Float32Array, at: number, t: number) => {
    const i = t * FRAME_STRIDE;
    out[at] = f[i]; out[at + 1] = f[i + 2] + 2; out[at + 2] = -f[i + 1];
  };
  const link = (a: number, b: number) => {
    if (a < 0 || a === b || !valid(a) || !valid(b)) return;
    if (f[a * FRAME_STRIDE] === f[b * FRAME_STRIDE] && f[a * FRAME_STRIDE + 1] === f[b * FRAME_STRIDE + 1] && f[a * FRAME_STRIDE + 2] === f[b * FRAME_STRIDE + 2]) return;
    if (path) { point(path, pathLength, a); point(path, pathLength + 3, b); pathLength += 6; }
    else { const i = links.length; point(links, i, a); point(links, i + 3, b); }
  };
  let anchor = valid(start) ? start : -1;
  for (let t = start + 1; t <= end; t++) {
    if (!valid(t) || !valid(t - 1)) {
      if (!path) link(anchor, t - 1);
      anchor = valid(t) ? t : -1;
      continue;
    }
    if (teleported(t)) {
      if (!path) link(anchor, t - 1);
      anchor = t;
      continue;
    }
    if (jumped(t)) {
      if (!path) link(anchor, t - 1);
      anchor = t - 1;
      point(jumps, jumps.length, t - 1);
      ticks.push(t);
    }
    if (path) link(t - 1, t);
  }
  if (!path) link(anchor, end);
  return { segments: path ? path.subarray(0, pathLength) : new Float32Array(links), jumps: new Float32Array(jumps), jumpTicks: new Uint32Array(ticks) };
}
