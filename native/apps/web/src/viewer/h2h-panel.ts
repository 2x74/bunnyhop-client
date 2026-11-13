// Head to head's per-run panel (viewer/h2h.ts): the same panel under each run's view, drawn with the 2D canvas so the
// screen and the MP4 export show exactly the same thing.
//
//   name  time                         sync  gain  strafes  (early)    one line, numbers like the HUD's stats line
//   ~~~~~~~~~~~~~~~~~|~~~~~~~~~~~~~~~~                                  the run's speed, the playhead
//   ▮▮▮▯▯▯▮▮▮|▮▮▮ A/D lanes, offsets                                    strafe timing around the playhead
//
// "early" (only when the player turns it on: the viewer's More menu): the share of A/D switches made before the mouse
// turns the other way (h2h/strafe-timing.ts). Both panels
// share the speed scale, the run-time span and the strip's bar scale, so they read as mirrors.

import type { Rect } from "../h2h/layout";
import { countWord } from "../hud/time-face";
import { formatTime } from "../timer";
import type { H2HSide } from "./h2h";
import { finalRunTime } from "./player";

/** The panel's design height: sizes below are in these units (a panel drawn 130 px tall uses them as pixels). */
export const PANEL_UNITS = 130;
/** Ticks either side of the playhead in the strip. */
const STRIP_HALF = 50;
const IN_MOVELEFT = 1 << 9;
const IN_MOVERIGHT = 1 << 10;
const BG = "#0c0c0f";
const DIM = "rgba(239, 233, 221, 0.55)";
const FONT = "ui-sans-serif, system-ui, sans-serif";

/** What both panels share. */
export interface PanelScale {
  /** Run seconds the speed line spans (the slower run). */
  span: number;
  /** Speed at the top of the speed line. */
  maxSpeed: number;
  /** Turn per tick at full bar height in the strip. */
  turn: number;
}

export function panelScale(sides: readonly H2HSide[]): PanelScale {
  let span = 1;
  let maxSpeed = 100;
  const turns: number[] = [];
  for (const s of sides) {
    const d = s.player.data;
    span = Math.max(span, ((d.endTick || d.n) - d.startTick) * d.interval);
    maxSpeed = Math.max(maxSpeed, d.maxSpeed);
    for (let i = d.startTick; i < (d.endTick || d.n) && i < s.turns.length; i++) if (s.turns[i]) turns.push(Math.abs(s.turns[i]));
  }
  turns.sort((a, b) => a - b);
  return { span, maxSpeed: Math.ceil(maxSpeed / 100) * 100, turn: turns.length ? Math.max(0.05, turns[Math.floor(turns.length * 0.95)]) : 1 };
}

/** The headline numbers at the run's tick `at` (they follow playback; at the finish, the run's), HUD style: [value, word]. */
export function panelNumbers(s: H2HSide, at: number, showEarly = false): [string, string][] {
  const d = s.player.data;
  const i = Math.max(0, Math.min(d.endTick || d.n, Math.floor(at)));
  let gain = 0;
  let gains = 0;
  for (const j of s.jumps) if (j.tick <= i && j.gain !== null) (gain += j.gain), gains++;
  let paired = 0;
  let earlyN = 0;
  for (const sw of s.timing?.switches ?? []) if (sw.tick + 1 <= i && sw.offset !== null) (paired++, sw.offset < 0 && earlyN++);
  const out: [string, string][] = [
    [`${d.sync[i].toFixed(1)}%`, "sync"],
    [gains ? `${(gain / gains).toFixed(1)}%` : "—", "gain"],
    [String(d.strafes[i]), countWord(d.strafes[i], "strafe")],
  ];
  if (showEarly && s.timing) out.push([paired ? `${Math.round((earlyN / paired) * 100)}%` : "—", "early"]);
  return out;
}

/** Draws run `s`'s panel into `r` at run time `tau` (seconds since its timer started). */
export function drawPanel(g: CanvasRenderingContext2D, r: Rect, s: H2HSide, tau: number, sc: PanelScale, early = false): void {
  // Wide (under a view): one line of name, time and numbers. Tall (beside a view): name and time, then the numbers.
  const tall = r.h > r.w * 0.5;
  const u = tall ? Math.min(r.w / 380, r.h / 200) : r.h / PANEL_UNITS;
  const d = s.player.data;
  g.save();
  g.beginPath();
  g.rect(r.x, r.y, r.w, r.h);
  g.clip();
  g.fillStyle = BG;
  g.fillRect(r.x, r.y, r.w, r.h);
  const padX = 14 * u;
  const x0 = r.x + padX;
  const x1 = r.x + r.w - padX;
  // --- name, time, numbers
  const base = r.y + 25 * u;
  g.textBaseline = "alphabetic";
  const big = `800 ${18 * u}px ${FONT}`;
  g.font = big;
  const ft = finalRunTime(d);
  const timeText = ft === null ? "DNF" : formatTime(ft);
  const timeW = g.measureText(timeText).width;
  let name = s.name;
  while (name.length > 3 && g.measureText(name).width > (tall ? r.w - timeW - 3 * padX : r.w * 0.36)) name = name.slice(0, -2);
  if (name !== s.name) name = `${name.slice(0, -1)}…`;
  g.fillStyle = s.color;
  g.fillText(name, x0, base);
  const nameW = g.measureText(name).width;
  g.fillStyle = "#fff";
  g.fillText(timeText, x0 + nameW + 12 * u, base);
  // Numbers: from the right on the name's line (wide), on their own line (tall). Ones that don't fit are left out.
  let nums = panelNumbers(s, d.startTick + tau / d.interval, early);
  const width = (list: [string, string][]) => {
    let w = 0;
    for (const [v, k] of list) {
      g.font = `700 ${15 * u}px ${FONT}`;
      w += g.measureText(v).width + 4 * u;
      g.font = `500 ${13 * u}px ${FONT}`;
      w += g.measureText(k).width + 16 * u;
    }
    return w - 16 * u;
  };
  const room = tall ? x1 - x0 : x1 - (x0 + nameW + 12 * u + timeW + 20 * u);
  while (nums.length && width(nums) > room) nums = nums.slice(0, -1);
  let x = tall ? x0 : x1 - width(nums);
  const numBase = tall ? r.y + 52 * u : base;
  for (const [v, k] of nums) {
    g.font = `700 ${15 * u}px ${FONT}`;
    g.fillStyle = "#fff";
    g.fillText(v, x, numBase);
    x += g.measureText(v).width + 4 * u;
    g.font = `500 ${13 * u}px ${FONT}`;
    g.fillStyle = DIM;
    g.fillText(k, x, numBase);
    x += g.measureText(k).width + 16 * u;
  }
  // --- speed over the run, then the strip: the rest of the panel, about a third and two thirds
  const head = tall ? 64 * u : 34 * u;
  const rest = r.h - head - 6 * u;
  const sy0 = r.y + head;
  const sy1 = sy0 + Math.round(rest * 0.3);
  const xOf = (sec: number) => x0 + (Math.max(0, Math.min(sc.span, sec)) / sc.span) * (x1 - x0);
  const end = d.endTick || d.n;
  g.beginPath();
  let started = false;
  const steps = Math.max(2, Math.round(x1 - x0));
  for (let k = 0; k <= steps; k++) {
    const sec = (k / steps) * sc.span;
    const t = Math.round(d.startTick + sec / d.interval);
    if (t > end) break;
    const y = sy1 - (d.speed[Math.max(0, t)] / sc.maxSpeed) * (sy1 - sy0);
    const px = x0 + (k / steps) * (x1 - x0);
    if (started) g.lineTo(px, y);
    else (g.moveTo(px, y), (started = true));
  }
  if (started) {
    g.lineWidth = 2.2 * u;
    g.strokeStyle = s.color;
    g.lineJoin = "round";
    g.stroke();
    const lastX = Math.min(x1, xOf((end - d.startTick) * d.interval));
    g.lineTo(lastX, sy1);
    g.lineTo(x0, sy1);
    g.closePath();
    g.globalAlpha = 0.16;
    g.fillStyle = s.color;
    g.fill();
    g.globalAlpha = 1;
  }
  g.fillStyle = "rgba(255,255,255,0.08)";
  g.fillRect(x0, sy1, x1 - x0, Math.max(1, u));
  g.fillStyle = "#fff";
  g.fillRect(Math.round(xOf(tau)) - u, sy0 - 2 * u, 2 * u, sy1 - sy0 + 3 * u);
  // --- strafe timing strip around the playhead
  const stripY = sy1 + 6 * u;
  drawStrip(g, s, { x: x0, y: stripY, w: x1 - x0, h: r.y + r.h - 4 * u - stripY }, d.startTick + tau / d.interval, sc.turn, u);
  g.restore();
}

/** The mouse turn per tick as bars (up = turning left), A over D as two lanes, reversals dashed, switch offsets. */
function drawStrip(g: CanvasRenderingContext2D, s: H2HSide, r: Rect, at: number, turnScale: number, u: number): void {
  const d = s.player.data;
  if (!s.timing) return;
  g.save();
  g.beginPath();
  g.rect(r.x, r.y, r.w, r.h);
  g.clip();
  const lo = at - STRIP_HALF;
  const per = r.w / (2 * STRIP_HALF);
  const xOf = (tick: number) => r.x + (tick - lo) * per;
  const laneH = 5 * u;
  const labelH = 11 * u;
  const barsH = r.h - 2 * laneH - labelH - 3 * u;
  const mid = r.y + barsH / 2;
  const amp = barsH / 2 - u;
  const lanes = r.y + barsH + 2 * u;
  const first = Math.max(0, Math.floor(lo));
  const last = Math.min(d.n - 1, Math.ceil(lo + 2 * STRIP_HALF));
  const runStart = d.startTick - 1;
  const runEnd = (d.endTick || d.n) - 1;
  const w = Math.max(1, per - u);
  g.fillStyle = s.color;
  // Command i produces tick i + 1: drawn in the column of tick i + 1.
  for (let i = first; i <= last; i++) {
    const x = xOf(i + 1);
    const dim = i < runStart || i >= runEnd ? 0.3 : 1;
    const v = s.turns[i] ?? 0;
    if (v) {
      const y = Math.max(-1, Math.min(1, v / turnScale)) * amp;
      g.globalAlpha = dim * (v > 0 ? 0.95 : 0.6);
      g.fillRect(x - w / 2, y > 0 ? mid - y : mid, w, Math.max(u, Math.abs(y)));
    }
    const b = d.buttons[i + 1];
    if (b & IN_MOVELEFT) {
      g.globalAlpha = dim * 0.9;
      g.fillRect(x - per / 2, lanes, per, laneH - 0.5 * u);
    }
    if (b & IN_MOVERIGHT) {
      g.globalAlpha = dim * 0.5;
      g.fillRect(x - per / 2, lanes + laneH, per, laneH - 0.5 * u);
    }
  }
  g.globalAlpha = 1;
  g.strokeStyle = "rgba(255,255,255,0.4)";
  g.lineWidth = Math.max(1, u);
  g.setLineDash([3 * u, 3 * u]);
  for (const rv of s.timing.reversals) {
    if (rv.tick + 1 < lo - 1 || rv.tick + 1 > lo + 2 * STRIP_HALF + 1) continue;
    const x = Math.round(xOf(rv.tick + 0.5)) + 0.5;
    g.beginPath();
    g.moveTo(x, r.y);
    g.lineTo(x, r.y + barsH);
    g.stroke();
  }
  g.setLineDash([]);
  g.textAlign = "center";
  g.textBaseline = "bottom";
  g.font = `600 ${11 * u}px ${FONT}`;
  for (const sw of s.timing.switches) {
    if (sw.offset === null || sw.tick + 1 < lo - 2 || sw.tick + 1 > lo + 2 * STRIP_HALF + 2) continue;
    g.fillStyle = sw.offset < 0 ? "#fff" : DIM;
    g.fillText(sw.offset > 0 ? `+${sw.offset}` : String(sw.offset), xOf(sw.tick + 0.5), r.y + r.h);
  }
  g.textAlign = "left";
  g.fillStyle = "#fff";
  g.fillRect(Math.round(r.x + r.w / 2) - u / 2, r.y, Math.max(1, u), barsH + 2 * laneH + 2 * u);
  g.restore();
}
