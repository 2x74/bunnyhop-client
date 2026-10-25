// Watching a whole gauntlet attempt (research/GAUNTLETS.md "Watch"): /g/<slug>/watch/<attemptId>[?i=<n>] plays split
// n's replay in the replay viewer on the BSP build it was run on (main.ts), then the next split's on a fresh page load,
// like gauntlet mode. The viewer's gauntlet layer (viewer/gauntlet-layer.ts) draws the timeline across the whole
// gauntlet and the running total. This file is the DOM-free part. Tests: apps/web/test/gauntlet.test.ts.

/** The watch page for split `idx` (0: the first, no ?i). */
export function watchPath(slug: string, attemptId: string, idx = 0): string {
  return `/g/${encodeURIComponent(slug)}/watch/${encodeURIComponent(attemptId)}${idx > 0 ? `?i=${idx}` : ""}`;
}

/** The watch request in the page URL, else null. */
export function watchFromUrl(loc: Pick<Location, "pathname" | "search"> = location): { slug: string; attemptId: string; idx: number } | null {
  const m = /^\/g\/([a-z0-9-]+)\/watch\/([\w-]{16})\/?$/.exec(loc.pathname);
  if (!m) return null;
  const i = Number.parseInt(new URLSearchParams(loc.search).get("i") ?? "0", 10);
  return { slug: m[1], attemptId: m[2], idx: Number.isFinite(i) && i > 0 ? i : 0 };
}

export interface Segment {
  idx: number;
  /** Where it starts and how wide it is, as fractions of the whole gauntlet. */
  start: number;
  width: number;
}

/** One segment per split, as long as its time (a split with no time still gets a sliver, so it can be clicked). */
export function segments(times: readonly number[]): Segment[] {
  const MIN = 0.02;
  const total = times.reduce((t, x) => t + Math.max(0, x), 0);
  const raw = times.map((x) => (total > 0 ? Math.max(0, x) / total : 1 / Math.max(1, times.length)));
  const widths = raw.map((w) => Math.max(MIN, w));
  const sum = widths.reduce((a, b) => a + b, 0) || 1;
  let at = 0;
  return widths.map((w, idx) => {
    const seg = { idx, start: at, width: w / sum };
    at += w / sum;
    return seg;
  });
}

/** The gauntlet clock (s): the earlier splits' times plus the current run's time, clamped to its split. */
export function gauntletClock(times: readonly number[], idx: number, runTime: number): number {
  const before = times.slice(0, Math.max(0, idx)).reduce((t, x) => t + x, 0);
  const cur = times[idx] ?? 0;
  return before + Math.min(Math.max(0, runTime), cur);
}

/** Which split a point on the bar (0..1) falls in. */
export function segmentAt(segs: readonly Segment[], x: number): number {
  for (const s of segs) if (x < s.start + s.width) return s.idx;
  return segs.length ? segs[segs.length - 1].idx : 0;
}
