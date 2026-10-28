// The reward reel (design audit feedback.md P2): what a verified run earned, stamped onto the end-of-run result in about
// two seconds, before most players press R. One slot under the submission line; rewards land in it one after another:
//   1. "+450 XP" counts up;
//   2. the level number hops from the old level to the new one (several levels: several quick hops);
// Achievements and unlocked items are not on the result: they arrive as the cards at the bottom (ui/unlocks.ts
// celebrateRun), outside the run.
// A restart before the reel ends loses nothing: the last reel is kept for the pause menu (lastRunReel()).
// Transforms and opacity only, one-shot, never during a run. Reduced motion: everything lands at once, sounds still play.

import { h } from "../ui/dom";
import { sfx } from "../audio";
import { countUp } from "../notify";

export interface ReelData {
  xp: number;
  /** [before, after] when the run levelled up. */
  levelUp: [number, number] | null;
}

/** Gap between rewards landing (ms). */
const STEP = 280;
/** At most this many hops for a multi-level jump; the last one lands on the new level. */
const MAX_HOPS = 4;

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const semitone = (i: number) => Math.pow(2, i / 12);

let last: ReelData | null = null;

export const hasRewards = (d: ReelData) => d.xp > 0 || !!d.levelUp;

/** The reel's pieces in their final state (the pause menu's copy; the live reel animates the same pieces in). */
function pieces(d: ReelData): { xp: HTMLElement | null; lv: HTMLElement | null; lvNum: HTMLElement | null } {
  const xp = d.xp > 0 ? h("b.reel-xp", null, `+${d.xp} XP`) : null;
  // (The level shows only when it changed: "Level 13" after every run is noise.)
  const lvNum = d.levelUp ? h("b.reel-lvn", null, String(d.levelUp[1])) : null;
  const lv = lvNum ? h("span.reel-lv", null, "Level ", h("span.reel-lvbox", null, lvNum)) : null;
  return { xp, lv, lvNum };
}

/**
 * Plays the reel into `slot` (emptied first). Returns a cancel function (the result card went away: stop the timers).
 * Remembered for lastRunReel() whether or not it gets to finish.
 */
export function playReel(slot: HTMLElement, d: ReelData, delay = 0): () => void {
  last = d;
  const p = pieces(d);
  const timers: number[] = [];
  const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
  const row = h("div.reel-row");
  slot.replaceChildren(row);
  slot.hidden = false;
  const calm = reduced();
  let t = delay;
  if (p.xp) {
    const xp = p.xp;
    xp.textContent = "+0 XP";
    row.append(xp);
    at(t, () => {
      if (!calm) xp.animate({ opacity: [0, 1], transform: ["translateY(4px)", "none"] }, { duration: 160, easing: "ease-out", fill: "backwards" });
      countUp(xp, 0, d.xp, 600, undefined, (v) => `+${v} XP`);
    });
    t += STEP + 320;
  }
  if (p.lv && p.lvNum) {
    const num = p.lvNum;
    num.textContent = String(d.levelUp![0]);
    row.append(p.lv);
    if (!calm) at(t - STEP, () => p.lv!.animate({ opacity: [0, 1] }, { duration: 160, fill: "backwards" }));
    if (d.levelUp) {
      const [a, b] = d.levelUp;
      const steps = Math.min(MAX_HOPS, b - a);
      for (let i = 1; i <= steps; i++) {
        const to = i === steps ? b : a + i;
        at(t, () => hopLevel(num, to, i - 1, calm));
        t += 200;
      }
      t += STEP - 200;
    }
  }
  return () => {
    for (const id of timers) clearTimeout(id);
    for (const el of slot.querySelectorAll<HTMLElement>("[style*='opacity']")) el.style.opacity = "";
  };
}

/** The old level leaves on a small arc, the new one drops in with a squash and a stamp. */
function hopLevel(num: HTMLElement, to: number, i: number, calm: boolean): void {
  sfx("stamp", 0.9, semitone(i * 2));
  if (calm) {
    num.textContent = String(to);
    return;
  }
  const ghost = h("b.reel-lvn.reel-lvold", { "aria-hidden": "true" }, num.textContent ?? "");
  num.parentElement?.append(ghost);
  ghost
    .animate({ transform: ["none", "translate(0.35em, -0.7em) rotate(14deg)", "translate(0.8em, 0.2em) rotate(30deg)"], opacity: [1, 1, 0] }, { duration: 260, easing: "linear" })
    .finished.then(() => ghost.remove(), () => ghost.remove());
  num.textContent = String(to);
  num.animate(
    { transform: ["translateY(-0.7em) scaleY(1.1)", "translateY(0) scale(1.08, 0.86)", "scale(0.98, 1.04)", "none"], opacity: [0, 1, 1, 1], offset: [0, 0.45, 0.75, 1] },
    { duration: 300, easing: "cubic-bezier(0.3, 0.7, 0.4, 1)", fill: "backwards" },
  );
}

/** The last run's reel, still, for the pause menu ("Last run"); null when the last verified run earned nothing. */
export function lastRunReel(): HTMLElement | null {
  const d = last;
  if (!d || !hasRewards(d)) return null;
  const p = pieces(d);
  return h("div.endcard-reel.reel-still", null, h("div.reel-row", null, p.xp, p.lv));
}
