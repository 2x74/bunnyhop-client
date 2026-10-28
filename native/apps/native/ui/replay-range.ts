import type { PlaybackState } from "./bridge";

// The part of a replay the viewer shows (host replay_range.hpp). Seeks, frame steps and practice use absolute
// recording ticks inside [start, end]; the timeline and clock count from start.

export interface ShownRange {
  /** First and last absolute tick the viewer can show. */
  start: number;
  end: number;
  /** Ticks from start to end. */
  ticks: number;
  /** Seconds per tick. */
  interval: number;
}

const DEFAULT_TICK_INTERVAL = 0.01;

export function shownRange(playback: PlaybackState): ShownRange {
  const interval = playback.tickInterval ?? DEFAULT_TICK_INTERVAL;
  const hasRange = playback.rangeEndTick !== undefined && playback.rangeEndTick > 0;
  const start = hasRange ? (playback.rangeStartTick ?? 0) : 0;
  const end = hasRange ? (playback.rangeEndTick ?? playback.totalTicks) : playback.totalTicks;
  return { start, end, ticks: Math.max(0, end - start), interval };
}

export const clampToRange = (range: ShownRange, tick: number): number =>
  Math.min(range.end, Math.max(range.start, Math.round(tick)));

/** Seconds into the shown range at an absolute tick. */
export const rangeSeconds = (range: ShownRange, tick: number): number =>
  (clampToRange(range, tick) - range.start) * range.interval;

/** The host's own clock while playing, so it matches the in-game controls; else the tick being dragged to. */
export function shownSeconds(range: ShownRange, playback: PlaybackState, tick: number): number {
  if (tick === playback.tick && playback.elapsedSeconds !== undefined) return playback.elapsedSeconds;
  return rangeSeconds(range, tick);
}

/** Where a tick sits along the timeline, 0 to 1. */
export const rangeProgress = (range: ShownRange, tick: number): number =>
  range.ticks ? (clampToRange(range, tick) - range.start) / range.ticks : 0;
