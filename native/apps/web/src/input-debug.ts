// Input diagnostics overlay: Settings → Mouse & view → Show input stats, or ?inputdebug=1 for this page load. A small
// canvas over the game (top right, under menus) that players can screenshot when they report mouse flicks or freezes:
//   - how the pointer lock was obtained (raw input or OS-accelerated) and which event carries motion;
//   - mouse events and reports per second and the polling rate the reports' timestamps give;
//   - the size of each motion event over the last 3 s (log scale), dropped spikes red, post-lock discards orange;
//   - frame times (stutters red), long main-thread tasks, and how old the newest mouse event was when a frame ran.
// The same numbers ride along with feedback reports ("Attach game info", main.ts) whether or not the overlay is on.
// Redraws ten times a second; nothing here runs per mouse event.

import type { Input } from "./input";
import { EV_DISCARD, EV_OK, EV_SPIKE, InputStats } from "./mouse-filter";

const W = 400;
const H = 200;
/** Movement graph: the last SPAN ms in COLS columns. */
const SPAN = 3000;
const COLS = 150;

export class InputDebug {
  private canvas: HTMLCanvasElement | null = null;
  private g: CanvasRenderingContext2D | null = null;
  private on = false;
  private lastDraw = 0;
  private colMax = new Float32Array(COLS);
  private colFlag = new Uint8Array(COLS);
  /** Frame times shown in place of the game's, when set and non-null (the replay viewer's while it's open). */
  private frameSource: (() => InputStats | null) | null = null;

  constructor(private input: Input) {
    // Long tasks are counted whether or not the overlay is shown (feedback reports carry them). Chromium only.
    try {
      const stats = input.filter.stats;
      new PerformanceObserver((list) => {
        if (input.locked) for (const e of list.getEntries()) stats.longTask(e.duration); // while playing only
      }).observe({ type: "longtask" });
    } catch {
      /* unsupported */
    }
  }

  get enabled(): boolean {
    return this.on;
  }

  setEnabled(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.input.collectReports = on;
    if (!on) {
      this.canvas?.remove();
      return;
    }
    if (!this.canvas) {
      const c = document.createElement("canvas");
      c.id = "input-debug";
      c.setAttribute("aria-hidden", "true");
      c.style.cssText = `position:fixed;top:8px;right:8px;width:${W}px;height:${H}px;z-index:calc(var(--z-hud, 1) + 1);pointer-events:none;border-radius:6px;`;
      this.canvas = c;
      this.g = c.getContext("2d");
    }
    document.body.append(this.canvas);
    this.lastDraw = 0;
  }

  setFrameSource(f: (() => InputStats | null) | null): void {
    this.frameSource = f;
  }

  /** Every rendered frame; redraws at most ten times a second. */
  frame(now: number): void {
    if (!this.on || now - this.lastDraw < 100) return;
    this.lastDraw = now;
    this.draw();
  }

  private draw(): void {
    const c = this.canvas!;
    const g = this.g;
    if (!g) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (c.width !== Math.round(W * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = "rgba(8, 10, 14, 0.8)";
    g.fillRect(0, 0, W, H);
    const now = performance.now();
    const s = summary(this.input);
    g.font = "10.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    g.textBaseline = "top";
    const line = (y: number, text: string, color = "#d8dee9") => {
      g.fillStyle = color;
      g.fillText(text, 6, y);
    };
    const lock = s.lock === "raw" ? "raw input" : s.lock === "os" ? `OS accel (no raw input${s.rawError ? `: ${s.rawError}` : ""})` : "not locked";
    const timed = !s.timed ? "frame-timed" : s.timedOff ? "timed off (browser event times unusable)" : `timed ${s.holdbackMs} ms (late ${(s.lateShare * 100).toFixed(1)}%)`;
    line(4, `INPUT ${lock} · ${s.source} · filter ${s.filter ? "on" : "off"} · ${timed}`, s.lock === "os" ? "#ffb547" : s.lock === "raw" ? "#9fe0a8" : "#9aa3b2");
    line(17, `mouse ${s.pollHz ? `${s.pollHz} Hz` : "– Hz"} · ${s.reportHz} reports/s · ${s.eventHz} events/s · ${s.fps} fps`);
    line(30, `biggest move ${s.maxDelta} · spikes ${s.spikes}${s.spikes ? ` (max ${s.maxSpike})` : ""} · post-lock ${s.discards}${s.mismatches ? ` · sum≠ ${s.mismatches}` : ""}`, s.spikes ? "#ff8a80" : undefined);
    const fs = this.frameSource?.() ?? null;
    const f = fs ? frameNumbers(fs) : s;
    line(43, `${fs ? "replay " : ""}frame p50 ${f.frameP50} p99 ${f.frameP99} ms · >25ms ${f.over25} · >50ms ${f.over50} (worst ${f.worstFrame})`, f.over50 ? "#ff8a80" : undefined);
    line(56, `long tasks ${f.longTasks}${f.longTasks ? ` (max ${f.longTaskMax} ms)` : ""} · input age p50 ${s.ageP50} max ${s.ageMax} ms`);

    // Movement per event over the last SPAN ms, a column per bucket (its largest event, log scale 1 .. 4096 counts):
    // dropped spikes red, post-lock discards orange.
    const st = this.input.filter.stats;
    const gx = 6;
    const gw = W - 12;
    let top = 72;
    let gh = 60;
    g.fillStyle = "rgba(255,255,255,0.06)";
    g.fillRect(gx, top, gw, gh);
    const colMax = this.colMax.fill(0);
    const colFlag = this.colFlag.fill(0);
    const t0 = now - SPAN;
    for (let i = 0; i < InputStats.EVENTS; i++) {
      const t = st.evT[i];
      if (t <= t0 || t > now) continue;
      const k = Math.min(COLS - 1, Math.floor(((t - t0) / SPAN) * COLS));
      const f = st.evFlag[i];
      const v = f === EV_OK ? st.evMag[i] : st.evRaw[i];
      if (v > colMax[k]) colMax[k] = v;
      if (f === EV_SPIKE || (f === EV_DISCARD && colFlag[k] !== EV_SPIKE)) colFlag[k] = f;
    }
    const cw = gw / COLS;
    const logMax = Math.log2(4097);
    for (let k = 0; k < COLS; k++) {
      if (!colMax[k]) continue;
      const h = Math.max(1, Math.min(1, Math.log2(1 + colMax[k]) / logMax) * (gh - 2));
      g.fillStyle = colFlag[k] === EV_SPIKE ? "#ff5252" : colFlag[k] === EV_DISCARD ? "#ffa726" : "#cfd8e3";
      g.fillRect(gx + k * cw, top + gh - h, Math.max(1, cw - 0.5), h);
    }
    g.fillStyle = "#7d8696";
    g.fillText(`move per event, last ${SPAN / 1000} s (log)`, gx + 3, top + 2);

    // Frame times (0 .. 50 ms), guides at 60 and 30 fps; over 25 ms orange, over 50 ms red.
    top += gh + 6;
    gh = H - top - 6;
    g.fillStyle = "rgba(255,255,255,0.06)";
    g.fillRect(gx, top, gw, gh);
    const yOf = (ms: number) => top + gh - Math.min(1, ms / 50) * gh;
    const fw = gw / InputStats.FRAMES;
    const fr = fs ?? st;
    for (let k = 0; k < InputStats.FRAMES; k++) {
      const i = (fr.frHead + k) % InputStats.FRAMES;
      const d = fr.frDur[i];
      if (!d) continue;
      g.fillStyle = d > 50 ? "#ff5252" : d > 25 ? "#ffa726" : "#8fd19e";
      const y = yOf(d);
      g.fillRect(gx + k * fw, y, Math.max(1, fw), top + gh - y);
    }
    g.strokeStyle = "rgba(255,255,255,0.25)";
    g.beginPath();
    for (const ms of [16.7, 33.3]) {
      g.moveTo(gx, Math.round(yOf(ms)) + 0.5);
      g.lineTo(gx + gw, Math.round(yOf(ms)) + 0.5);
    }
    g.stroke();
    g.fillStyle = "#7d8696";
    g.fillText(`frame time, last ${InputStats.FRAMES} frames (lines: 16.7 / 33.3 ms)`, gx + 3, top + 2);
  }
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Frame-time numbers of a stats ring (the summary's names). */
export function frameNumbers(st: InputStats) {
  return {
    frameP50: r1(InputStats.pct(st.frDur, 0.5)),
    frameP99: r1(InputStats.pct(st.frDur, 0.99)),
    frameMax: r1(Math.max(...st.frDur)),
    over25: st.framesOver25,
    over50: st.framesOver50,
    worstFrame: r1(st.maxFrame),
    longTasks: st.longTasks,
    longTaskMax: Math.round(st.maxLongTask),
  };
}

/** The input stats as plain numbers: the overlay's text, feedback reports and `__inputStats()`. */
export function summary(input: Input) {
  const st = input.filter.stats;
  const now = performance.now();
  const rate = st.rates(now);
  const ages = st.frAge.filter((a) => a >= 0);
  return {
    lock: input.lockMode,
    rawError: input.rawError,
    rawRefusals: input.rawRefusals,
    source: input.motionEvent,
    filter: input.filter.enabled,
    // Timed input (timed-input.ts): on, its adapted holdback, and the share of reports that missed their tick.
    timed: input.timed,
    holdbackMs: input.timedStats.holdbackMs,
    timedOff: input.timedStats.unreliable,
    lateShare: input.timedStats.reports ? Math.round((input.timedStats.late / input.timedStats.reports) * 1e4) / 1e4 : 0,
    pollHz: rate.pollHz,
    reportHz: rate.reportHz,
    eventHz: rate.eventHz,
    fps: rate.frameHz,
    events: st.events,
    reports: st.samples,
    maxDelta: Math.round(st.maxDelta),
    spikes: st.spikes,
    maxSpike: Math.round(st.maxSpike),
    discards: st.discards,
    mismatches: st.mismatches,
    ...frameNumbers(st),
    ageP50: r1(InputStats.pct(Float32Array.from(ages, (a) => a + 1e-3), 0.5)),
    ageMax: r1(ages.length ? Math.max(...ages) : 0),
  };
}
