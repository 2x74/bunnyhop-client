// Head to head's jump table and run summary: the game's own jump stats (!ssj "every jump", ssj/stats.ts, the numbers a
// CS:S server's plugin prints) over each run's timed part, numbered from the first jump after the start. DOM-free.

import type { SsjReport } from "../ssj/stats";

export interface JumpRow {
  /** 1 = the first jump after the timer started. */
  n: number;
  /** Tick of the jump (the run's own clock). */
  tick: number;
  /** Seconds since the run started. */
  at: number;
  /** Take-off speed (u/s, rounded down like !ssj). */
  speed: number;
  /** Gain and sync % over the air time before this jump (null on the first jump of a chain). */
  gain: number | null;
  sync: number | null;
  /** Strafe key presses in that air time. */
  strafes: number | null;
}

/** The run's jumps from !ssj "every" reports (replaySsj(d, "every")), between the timer's start and finish. */
export function jumpRows(reports: readonly { tick: number; report: SsjReport }[], startTick: number, endTick: number, interval: number): JumpRow[] {
  if (!startTick) return [];
  const end = endTick || Infinity;
  const rows: JumpRow[] = [];
  for (const { tick, report } of reports) {
    if (tick < startTick || tick > end) continue;
    rows.push({ n: rows.length + 1, tick, at: (tick - startTick) * interval, speed: report.speed, gain: report.gain, sync: report.sync, strafes: report.strafes });
  }
  return rows;
}

/** Mean gain over the jumps that have one (%), null when none do. */
export function meanGain(rows: readonly JumpRow[]): number | null {
  const g = rows.map((r) => r.gain).filter((v): v is number => v !== null);
  return g.length ? g.reduce((a, b) => a + b, 0) / g.length : null;
}

/** The row of the jump at or before `tick` (the one being flown), or -1 before the first. */
export function jumpIndexAt(rows: readonly JumpRow[], tick: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  let best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (rows[m].tick <= tick) (best = m), (lo = m + 1);
    else hi = m - 1;
  }
  return best;
}
