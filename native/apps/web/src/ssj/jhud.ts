// JHUD, the per-jump readout near the crosshair that bhop servers show with !jhud: "6: 612 (98%)" over "84.21 90.00%",
// the whole of it coloured for how the jump went. Display only, like !ssj (stats.ts). DOM-free, tested under bun
// (apps/web/test/jhud.test.ts). Sources and how it differs from the plugins: research/SSJ.md, section JHUD.
//
// blankbhop/jhud computes gain exactly as "SSJ: Advanced" does (research/SSJ.md), and bhop-get-stats' JumpStats, its
// usual replacement, adds sync, JSS options and the fifth colour. So the numbers are !ssj's for "every jump" (its
// SsjTracker in that mode, run separately, so the !ssj mode doesn't matter), and this file adds:
//   JSS: how fast you turned, against the turn that gains the most at your speed. Per air tick, |yaw change| / atan(30 /
//     horizontal speed) (ticks without a turn count as 0), averaged over the jump's air ticks. 100% is the ideal turn;
//     over is too fast. JumpStats' formula (blankbhop/jhud uses asin and the 3D speed, see research/SSJ.md).
//   colours: the speed table for the first jumps (it asks "is this speed on pace for jump N?"), gain after that.
// One thing differs from "every jump" in !ssj: a map's teleport doesn't start the count over, as neither plugin's does.
// On a map that teleports between levels you'd lose a jump's gain each time, and jump 1 at 800 u/s means nothing.

import { SsjTracker, type SsjCmd, type SsjState, type SsjTick } from "./stats";

/** What one jump shows. Jump 1 is only the speed, like both plugins. */
export interface JhudReport {
  jump: number;
  /** Horizontal speed at take-off, rounded down. */
  speed: number;
  gain: number | null;
  sync: number | null;
  /** JSS as a ratio (1 = 100%). */
  jss: number | null;
}

/** The five colours, worst to best (JumpStats' names for them). */
export const JHUD_BANDS = ["reallyBad", "bad", "meh", "good", "reallyGood"] as const;
export type JhudBand = (typeof JHUD_BANDS)[number];

export interface JhudPrefs {
  /** Sync after the gain (JumpStats' default; blankbhop/jhud has no sync). */
  sync: boolean;
  /** JSS in brackets after the speed. */
  jss: boolean;
  /** An arrow by the gain: ▼ turning too fast, ▲ too slow (blankbhop/jhud's Strafe Analyzer). */
  analyzer: boolean;
  /** Jumps up to this one take their colour from the speed table (at most 16, the table's length); later ones from gain. */
  speedColors: number;
  /** Nothing shows after this jump; 0: no limit (JumpStats' cutoff). */
  cutoff: number;
  colors: Record<JhudBand, string>;
}

/** JumpStats' defaults. The colours are the plugins' own. */
export const DEFAULT_JHUD: JhudPrefs = {
  sync: true,
  jss: false,
  analyzer: false,
  speedColors: 6,
  cutoff: 0,
  colors: { reallyBad: "#ff0000", bad: "#ffa500", meh: "#00ff00", good: "#00ffff", reallyGood: "#ffffff" },
};

/** How long a jump stays up with no newer one (s): the plugins' hud text hold. */
export const JHUD_HOLD = 1;

const AIR_WISH_CAP = 30;
const DEG = 180 / Math.PI;

/** Runs SsjTracker in "every jump" mode and adds JSS over the same ticks. */
export class JhudTracker {
  private ssj = new SsjTracker("every");
  private yaw = NaN;
  private jssSum = 0;
  private ticks = 0;

  reset(): void {
    this.ssj.reset();
    this.yaw = NaN;
    this.jssSum = this.ticks = 0;
  }

  /** One tick, as SsjTracker.tick (a teleport doesn't count: above). Returns the jump this tick took off for, if any. */
  tick(pre: SsjState, cmd: SsjCmd, t: Omit<SsjTick, "teleported">): JhudReport | null {
    const r = this.ssj.tick(pre, cmd, t);
    let dy = cmd.yaw - this.yaw;
    this.yaw = cmd.yaw;
    if (dy > 180) dy -= 360;
    else if (dy < -180) dy += 360;
    if (this.ssj.sampled) {
      this.ticks++;
      if (dy) this.jssSum += Math.abs(dy) / (Math.atan(AIR_WISH_CAP / Math.hypot(pre.velocity[0], pre.velocity[1])) * DEG) || 0;
    }
    if (!r) {
      if (this.ssj.jump === 0) this.jssSum = this.ticks = 0;
      return null;
    }
    const out: JhudReport = { jump: r.jump, speed: r.speed, gain: r.gain, sync: r.sync, jss: r.jump > 1 && this.ticks ? this.jssSum / this.ticks : null };
    this.jssSum = this.ticks = 0;
    return out;
  }
}

/** Speeds for jumps 1-16: under the first is the worst colour, from the last up the best (JumpStats' g_iJhudSpeedValues). */
const SPEEDS: readonly (readonly [number, number, number, number])[] = [
  [280, 282, 287, 289],
  [366, 370, 375, 380],
  [438, 442, 450, 455],
  [500, 505, 515, 525],
  [555, 560, 570, 580],
  [605, 610, 620, 633],
  [655, 665, 675, 680],
  [700, 710, 725, 730],
  [740, 750, 765, 770],
  [780, 790, 805, 810],
  [810, 820, 840, 850],
  [850, 860, 875, 885],
  [880, 900, 900, 920],
  [910, 920, 935, 955],
  [945, 955, 965, 990],
  [970, 980, 1000, 1020],
];

/** Band for a jump's speed (jump 1-16). */
export function speedBand(jump: number, speed: number): JhudBand {
  const s = SPEEDS[jump - 1];
  let i = 0;
  while (i < 4 && speed >= s[i]) i++;
  return JHUD_BANDS[i];
}

/** Band for a gain: under 60, 60-70, 70-80, 80-90, 90 and up (over 100 can't happen: a tick's gain is at most 1). */
export function gainBand(gain: number): JhudBand {
  return gain >= 90 ? "reallyGood" : gain >= 80 ? "good" : gain >= 70 ? "meh" : gain >= 60 ? "bad" : "reallyBad";
}

/** Which colour a report shows in. */
export function jhudBand(r: JhudReport, speedColors: number): JhudBand {
  if (r.jump === 1 || (r.jump <= SPEEDS.length && r.jump <= speedColors) || r.gain === null) return speedBand(Math.min(r.jump, SPEEDS.length), r.speed);
  return gainBand(r.gain);
}

/** SourceMod's %.2f cuts digits off rather than rounding (research/SSJ.md), so 87.52 stored as 87.5199966 prints 87.51. */
const cut2 = (v: number) => (Math.trunc(v * 100) / 100).toFixed(2);

/** The readout's two lines (the second null on jump 1), as the plugins print them. */
export function jhudLines(r: JhudReport, p: Pick<JhudPrefs, "sync" | "jss" | "analyzer">): [string, string | null] {
  const top = `${r.jump}: ${r.speed}${p.jss && r.jss !== null ? ` (${Math.floor(r.jss * 100)}%)` : ""}`;
  if (r.gain === null) return [top, null];
  const fast = p.analyzer && r.jss !== null && r.jss > 1;
  const slow = p.analyzer && r.jss !== null && r.jss <= 1;
  // With sync the gain is bare, as JumpStats prints it; alone it has its %, as blankbhop/jhud prints it.
  const gain = p.sync && r.sync !== null ? `${cut2(r.gain)} ${cut2(r.sync)}%` : `${cut2(r.gain)}%`;
  return [top, `${fast ? "▼ " : ""}${gain}${slow ? " ▲" : ""}`];
}

/** The last report at or before tick `i` in a list sorted by tick (viewer), or null. */
export function reportAt<T extends { tick: number }>(list: readonly T[], i: number): T | null {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (list[m].tick <= i) lo = m + 1;
    else hi = m;
  }
  return lo ? list[lo - 1] : null;
}
