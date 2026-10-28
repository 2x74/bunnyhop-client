// Viewer timeline: the whole run's speed graph with jump ticks, stage/checkpoint splits, start and finish markers
// (plus the compare ghost's finish), the region outside the timed run dimmed, a playhead, and a hover readout.
// Drag anywhere to scrub. One canvas, redrawn only when the playhead or the size changes.
// A long wait in the spawn before the timer starts (hena, 10-27: 20 s of standing still in a 43 s replay) isn't drawn:
// the bar starts LEAD_S before the start when the lead-in is longer than LEAD_MIN_S, so the run fills it.

import { formatTime } from "../timer";
import { h } from "../ui/dom";
import { palette } from "../palette";
import type { RunData } from "./player";

const ACCENT = "#ffb43a";
/** Seconds of lead-in kept on the bar before the timer starts, once there are more than LEAD_MIN_S of them. */
const LEAD_S = 2;
const LEAD_MIN_S = 3;

export interface TimelineHooks {
  /** Scrub to a tick (fractional allowed). `final` on pointer release. */
  seek: (tick: number, final: boolean) => void;
}

export class Timeline {
  readonly el: HTMLElement;
  private canvas = h("canvas.rv-tl-canvas");
  private g = this.canvas.getContext("2d")!;
  private tip = h("div.rv-tl-tip", { hidden: true });
  private data: RunData | null = null;
  private compareEnd: number | null = null;
  private compareColor = "#4fa8ff";
  private delta: Float32Array | null = null;
  private head = 0;
  private hover: number | null = null;
  private dirty = true;
  private w = 0;
  private hgt = 0;
  private dpr = 1;
  private bg: ImageBitmap | HTMLCanvasElement | null = null;
  private dragging = false;
  /** Staff only (staff-lens.ts): the jumps the run's analysis flagged, marked once in amber. */
  private evidence: number[] = [];
  /** First tick the bar shows (see LEAD_S) and the ticks it spans. */
  private lo = 0;
  private span = 1;

  constructor(private hooks: TimelineHooks) {
    this.el = h("div.rv-timeline", { role: "slider", "aria-label": "Replay timeline", tabindex: "-1" }, this.canvas, this.tip);
    new ResizeObserver(() => {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = Math.min(2, devicePixelRatio || 1);
      this.w = Math.max(1, Math.round(r.width * this.dpr));
      this.hgt = Math.max(1, Math.round(r.height * this.dpr));
      this.canvas.width = this.w;
      this.canvas.height = this.hgt;
      this.bg = null;
      this.dirty = true;
      this.render();
    }).observe(this.canvas);
    const tickAt = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
      return this.lo + f * this.span;
    };
    this.canvas.addEventListener("pointerdown", (e) => {
      if (!this.data || e.button !== 0) return;
      this.dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      this.hooks.seek(tickAt(e), false);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.data) return;
      const t = tickAt(e);
      if (this.dragging) this.hooks.seek(t, false);
      this.hover = t;
      this.showTip(e, t);
      this.dirty = true;
    });
    const up = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.hooks.seek(tickAt(e), true);
    };
    this.canvas.addEventListener("pointerup", up);
    this.canvas.addEventListener("pointercancel", up);
    this.canvas.addEventListener("pointerleave", () => {
      this.hover = null;
      this.tip.hidden = true;
      this.dirty = true;
    });
  }

  get scrubbing(): boolean {
    return this.dragging;
  }

  setData(d: RunData): void {
    this.data = d;
    const lead = Math.round(LEAD_S / d.interval);
    this.lo = d.startTick && d.startTick * d.interval > LEAD_MIN_S ? d.startTick - lead : 0;
    this.span = Math.max(1, d.n - this.lo);
    this.bg = null;
    this.dirty = true;
  }

  setCompare(endTick: number | null, color: string, delta: Float32Array | null): void {
    this.compareEnd = endTick;
    this.compareColor = color;
    this.delta = delta;
    this.bg = null;
    this.dirty = true;
  }

  setEvidence(ticks: number[]): void {
    this.evidence = ticks;
    this.bg = null;
    this.dirty = true;
  }

  setHead(t: number): void {
    if (Math.abs(t - this.head) * this.w < this.span * 0.25) return;
    this.head = t;
    this.dirty = true;
  }

  private showTip(e: PointerEvent, t: number): void {
    const d = this.data!;
    const i = Math.max(0, Math.min(d.n, Math.round(t)));
    const rel = d.startTick && i >= d.startTick ? ` · run ${formatTime((Math.min(i, d.endTick || i) - d.startTick) * d.interval)}` : "";
    const delta = this.delta && Number.isFinite(this.delta[i]) ? ` · Δ ${this.delta[i] > 0 ? "+" : ""}${this.delta[i].toFixed(3)}` : "";
    this.tip.textContent = `${formatTime(i * d.interval)}${rel} · ${Math.round(d.speed[i])} u/s${delta}`;
    this.tip.hidden = false;
    const r = this.el.getBoundingClientRect();
    const x = Math.max(60, Math.min(r.width - 60, e.clientX - r.left));
    this.tip.style.left = `${x}px`;
  }

  /** Static layer: speed graph + markers. */
  private background(): HTMLCanvasElement {
    const d = this.data!;
    const c = document.createElement("canvas");
    c.width = this.w;
    c.height = this.hgt;
    const g = c.getContext("2d")!;
    const W = this.w;
    const H = this.hgt;
    const dpr = this.dpr;
    const top = Math.round(14 * dpr);
    const bottom = H - Math.round(10 * dpr);
    const lo = this.lo;
    const span = this.span;
    const xOf = (t: number) => ((t - lo) / span) * W;
    // Outside the timed run (before start / after finish): dimmed.
    g.fillStyle = "rgba(255,255,255,0.03)";
    g.fillRect(0, 0, W, H);
    if (d.startTick) {
      g.fillStyle = "rgba(255,255,255,0.045)";
      g.fillRect(xOf(d.startTick), 0, xOf(d.endTick || d.n) - xOf(d.startTick), H);
    }
    // Speed: max per pixel column, filled area + line.
    const max = Math.max(100, Math.ceil(d.maxSpeed / 50) * 50);
    const yOf = (v: number) => bottom - (v / max) * (bottom - top);
    const cols = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const a = Math.floor(lo + (x / W) * span);
      const b = Math.max(a + 1, Math.floor(lo + ((x + 1) / W) * span));
      let m = 0;
      for (let t = a; t < b && t <= d.n; t++) if (d.speed[t] > m) m = d.speed[t];
      cols[x] = m;
    }
    const grad = g.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, "rgba(255,180,58,0.55)");
    grad.addColorStop(1, "rgba(255,180,58,0.04)");
    g.beginPath();
    g.moveTo(0, bottom);
    for (let x = 0; x < W; x++) g.lineTo(x, yOf(cols[x]));
    g.lineTo(W, bottom);
    g.closePath();
    g.fillStyle = grad;
    g.fill();
    g.beginPath();
    for (let x = 0; x < W; x++) (x ? g.lineTo(x, yOf(cols[x])) : g.moveTo(x, yOf(cols[x])));
    g.strokeStyle = "rgba(255,200,110,0.95)";
    g.lineWidth = 1.2 * dpr;
    g.stroke();
    // Speed scale.
    g.font = `600 ${9 * dpr}px ui-sans-serif, system-ui, sans-serif`;
    g.fillStyle = "rgba(255,255,255,0.35)";
    g.textBaseline = "top";
    g.fillText(`${max} u/s`, 4 * dpr, 2 * dpr);
    // Compare delta curve (ahead green above the midline, behind red below), scaled to ±max|delta|.
    if (this.delta) {
      let m = 0.05;
      for (let t = 0; t <= d.n; t++) if (Number.isFinite(this.delta[t])) m = Math.max(m, Math.abs(this.delta[t]));
      const mid = (top + bottom) / 2;
      const amp = (bottom - top) * 0.45;
      for (let x = 0; x < W; x++) {
        const t = Math.min(d.n, Math.round(lo + (x / W) * span));
        const v = this.delta[t];
        if (!Number.isFinite(v)) continue;
        g.fillStyle = v <= 0 ? "rgba(77,255,136,0.35)" : "rgba(255,93,93,0.35)";
        const y = mid + (v / m) * amp;
        g.fillRect(x, Math.min(mid, y), 1, Math.max(1, Math.abs(y - mid)));
      }
    }
    // Jumps: short ticks along the bottom edge.
    g.fillStyle = "rgba(255,255,255,0.4)";
    for (const t of d.jumpTicks) g.fillRect(Math.round(xOf(t)), H - 6 * dpr, Math.max(1, dpr), 5 * dpr);
    const line = (t: number, color: string, label: string, w = 2) => {
      const x = Math.round(xOf(t));
      g.fillStyle = color;
      g.fillRect(x - (w * dpr) / 2, 0, w * dpr, H);
      if (label) {
        g.font = `800 ${9 * dpr}px ui-sans-serif, system-ui, sans-serif`;
        const tw = g.measureText(label).width + 6 * dpr;
        const lx = Math.min(W - tw, Math.max(0, x + 3 * dpr));
        g.fillStyle = "rgba(10,12,16,0.75)";
        g.fillRect(lx, 1 * dpr, tw, 11 * dpr);
        g.fillStyle = color;
        g.fillText(label, lx + 3 * dpr, 2 * dpr);
      }
    };
    for (const s of d.splits) line(s.tick, ACCENT, s.kind === "stage" ? `S${s.index}` : `CP${s.index}`, 1);
    if (d.startTick) line(d.startTick, palette().gain, "START");
    if (d.endTick) line(d.endTick, palette().loss, "FINISH");
    if (this.compareEnd !== null && this.compareEnd <= d.n) line(this.compareEnd, this.compareColor, "GHOST", 1);
    if (d.desyncTick !== null) line(d.desyncTick, "#ff2d55", "DESYNC");
    // Staff evidence lane: the flagged jumps as amber ticks along the top edge, with a faint column under each.
    for (const t of this.evidence) {
      const x = Math.round(xOf(t));
      g.fillStyle = "rgba(255,180,58,0.14)";
      g.fillRect(x - 2 * dpr, 0, 4 * dpr, H);
      g.fillStyle = ACCENT;
      g.fillRect(x - dpr, 0, 2 * dpr, 7 * dpr);
    }
    return c;
  }

  render(): void {
    if (!this.dirty || !this.data || !this.w) return;
    this.dirty = false;
    this.bg ??= this.background();
    const g = this.g;
    const d = this.data;
    g.clearRect(0, 0, this.w, this.hgt);
    g.drawImage(this.bg, 0, 0);
    const x = (Math.max(0, this.head - this.lo) / this.span) * this.w;
    // Played part tint.
    g.fillStyle = "rgba(255,255,255,0.05)";
    g.fillRect(0, 0, x, this.hgt);
    if (this.hover !== null) {
      g.fillStyle = "rgba(255,255,255,0.35)";
      g.fillRect(Math.round((Math.max(0, this.hover - this.lo) / this.span) * this.w), 0, this.dpr, this.hgt);
    }
    g.fillStyle = "#fff";
    g.fillRect(Math.round(x - this.dpr), 0, 2 * this.dpr, this.hgt);
    g.beginPath();
    g.moveTo(x - 5 * this.dpr, 0);
    g.lineTo(x + 5 * this.dpr, 0);
    g.lineTo(x, 6 * this.dpr);
    g.closePath();
    g.fill();
  }
}
