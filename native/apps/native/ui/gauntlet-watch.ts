// Watching a whole gauntlet attempt (web gauntlet/watch.ts: /g/<slug>/watch/<attemptId>[?i=n]) in native playback.
// The web plays split n's replay on the BSP build it was run on, then the next split's on a fresh page, with a
// timeline across the whole gauntlet (viewer/gauntlet-layer.ts). Natively the host plays one replay at a time on the
// map build it has (the index's, content-addressed): this file
//   - refuses a split whose build (plan.splits[n].mapSha256) isn't the index's, with the reason; the host refuses a
//     mismatched BSP digest too (native-bridge replay.rs), so a wrong build is never played either way;
//   - keeps which attempt and split are playing, for the Replays screen's bar: split n of N, the total before it and
//     Previous / Next split (the player moves on; nothing advances by itself).
// The web's continuous timeline and the next map's prefetch aren't here (see the limits in the parity notes).

import type { GauntletWatchPlan } from "../../web/src/api";

export interface GauntletWatchDeps {
  plan: (attemptId: string) => Promise<GauntletWatchPlan>;
  /** The map index's current BSP digest for a map, or null when the index doesn't have one. */
  sha: (map: string) => Promise<string | null>;
  /** Plays a server run in native playback (replays.ts watchRequest). */
  play: (runId: string, name: string) => Promise<void>;
}

export interface WatchingSplit {
  plan: GauntletWatchPlan;
  idx: number;
  /** The earlier splits' times added up (s). */
  before: number;
}

let watching: WatchingSplit | null = null;
const listeners = new Set<() => void>();
export function watchingSplit(): WatchingSplit | null { return watching; }
export function onWatchingSplit(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
function set(next: WatchingSplit | null): void { watching = next; for (const fn of listeners) fn(); }
/** Another replay (or none) took over playback. */
export function stopWatchingSplit(): void { if (watching) set(null); }

const HEX = /^[0-9a-f]{64}$/;

/** Why split `idx` of `plan` can't be played here, or null. */
export async function splitRefusal(plan: GauntletWatchPlan, idx: number, sha: GauntletWatchDeps["sha"]): Promise<string | null> {
  const split = plan.splits.find((s) => s.idx === idx);
  if (!split) return plan.splits.length ? `This attempt has no split ${idx + 1}.` : "This attempt has no runs to watch yet.";
  if (!/^[\w-]{1,64}$/.test(split.runId)) return "This split's run can't be found.";
  const current = (await sha(split.map))?.toLowerCase() ?? null;
  const ran = split.mapSha256?.toLowerCase() ?? "";
  if (!current || !HEX.test(ran) || current !== ran)
    return `Split ${idx + 1} (${split.map}) was run on an earlier build of the map. The native client plays only the current build, so watch this one on bunnyhop.lol.`;
  return null;
}

/** Plays split `idx` of attempt `attemptId`; throws with the reason when it can't. */
export async function watchGauntletSplit(deps: GauntletWatchDeps, attemptId: string, idx: number): Promise<void> {
  const plan = await deps.plan(attemptId);
  const split = plan.splits.find((s) => s.idx === idx) ?? (idx === 0 ? plan.splits[0] : undefined);
  const at = split?.idx ?? idx;
  const refusal = await splitRefusal(plan, at, deps.sha);
  if (refusal) throw new Error(refusal);
  const before = plan.splits.filter((s) => s.idx < at).reduce((t, s) => t + s.time, 0);
  await deps.play(split!.runId, `${plan.gauntlet.title} · ${split!.map} (${at + 1}/${plan.gauntlet.maps})`);
  set({ plan, idx: at, before });
}

/** Previous / next split of the attempt being watched (moves only between splits that exist). */
export async function stepSplit(deps: GauntletWatchDeps, delta: -1 | 1): Promise<void> {
  const w = watching;
  if (!w) return;
  const order = w.plan.splits.map((s) => s.idx).sort((a, b) => a - b);
  const next = order[order.indexOf(w.idx) + delta];
  if (next === undefined) return;
  await watchGauntletSplit({ ...deps, plan: async () => w.plan }, w.plan.attemptId, next);
}
