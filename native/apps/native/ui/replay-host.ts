// What the replay viewer needs from the host beyond the playback state bridge.ts reads: the timeline's graph and
// markers (replay-timeline.ts), and the Compare ghost. A host that sends neither still gets a working viewer: a plain
// scrubber, and no Compare button.
//
// Host contract (state, under "playback"):
//   features: string[]          "compare" once the host draws a second replay as a ghost during playback; "loop",
//                               "weapon", "hud", "orbit" and "strafes" for the controls below
//   compare: {kind:"pb"|"wr"|"custom", name:string, endTick:number|null, delta:number|null} | null
//   loop: {from:number, to:number} | null      absolute ticks playback repeats
//   weapon: boolean             the weapon in hand shows for the current camera (V)
//   hud: boolean                the viewer's HUD switch (H)
// Host contract (call): bunnyhopNativeMenu.onReplayTimeline(ReplayTimelineData), once per replay.
// Menu messages: {type:"replayCompare", action:"set", kind, name, replayBase64} and
// {type:"replayCompare", action:"clear"}; {type:"replayControl", action:"loop", value:{from,to}|null},
// {type:"replayControl", action:"weapon"} and {type:"replayControl", action:"hud", value}.

import type { GhostKind } from "../../web/src/player/colors";
import { readTimelineData, type ReplayTimelineData } from "./replay-timeline";

export interface ReplayCompare {
  kind: GhostKind;
  name: string;
  /** Absolute tick where the compared run finishes on this replay's clock, or null. */
  endTick: number | null;
  /** Seconds this replay is behind (positive) or ahead of the compared run at the shown tick, or null. */
  delta: number | null;
}

export interface ReplayLoop {
  from: number;
  to: number;
}

interface ReplayHostState {
  features: ReadonlySet<string>;
  compare: ReplayCompare | null;
  timeline: ReplayTimelineData | null;
  loop: ReplayLoop | null;
  weapon: boolean;
  hud: boolean;
}

const host: ReplayHostState = {
  features: new Set(),
  compare: null,
  timeline: null,
  loop: null,
  weapon: true,
  hud: true,
};
const GHOST_KINDS: readonly GhostKind[] = ["pb", "wr", "custom"];
const MAX_FEATURES = 32;

function readCompare(value: unknown): ReplayCompare | null {
  if (!value || typeof value !== "object") return null;
  const compare = value as Record<string, unknown>;
  if (!GHOST_KINDS.includes(compare.kind as GhostKind) || typeof compare.name !== "string") return null;
  const endTick =
    Number.isSafeInteger(compare.endTick) && Number(compare.endTick) >= 0 ? Number(compare.endTick) : null;
  const delta = typeof compare.delta === "number" && Number.isFinite(compare.delta) ? compare.delta : null;
  return { kind: compare.kind as GhostKind, name: compare.name.slice(0, 128), endTick, delta };
}

function readLoop(value: unknown): ReplayLoop | null {
  if (!value || typeof value !== "object") return null;
  const loop = value as Record<string, unknown>;
  const tick = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
  if (!tick(loop.from) || !tick(loop.to) || Number(loop.to) <= Number(loop.from)) return null;
  return { from: Number(loop.from), to: Number(loop.to) };
}

/** Reads the viewer's extras from a host state message (the same one bridge.ts applies). */
export function applyReplayHostState(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const playback = (value as Record<string, unknown>).playback;
  if (!playback || typeof playback !== "object") return;
  const fields = playback as Record<string, unknown>;
  if (Array.isArray(fields.features)) {
    const names = fields.features.slice(0, MAX_FEATURES).filter((name): name is string => typeof name === "string");
    host.features = new Set(names);
  }
  if ("compare" in fields) host.compare = readCompare(fields.compare);
  if ("loop" in fields) host.loop = readLoop(fields.loop);
  if (typeof fields.weapon === "boolean") host.weapon = fields.weapon;
  if (typeof fields.hud === "boolean") host.hud = fields.hud;
  if (fields.active === false) {
    host.compare = null;
    host.loop = null;
  }
}

/** The host's timeline for a replay; anything malformed is dropped. */
export function applyReplayTimeline(value: unknown): void {
  const data = readTimelineData(value);
  if (data) host.timeline = data;
}

export const hostSupports = (feature: string): boolean => host.features.has(feature);
export const replayCompare = (): ReplayCompare | null => host.compare;
export const replayLoop = (): ReplayLoop | null => host.loop;
export const replayWeapon = (): boolean => host.weapon;
export const replayHud = (): boolean => host.hud;

/** The timeline sent for this replay, if the host has sent one. */
export function replayTimeline(replayId: string): ReplayTimelineData | null {
  return host.timeline?.id === replayId ? host.timeline : null;
}
