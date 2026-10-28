// Speed graph: sparkline of horizontal speed over the last ~2 s (one sample per tick) with a mark
// and the gain for every jump. Canvas, redrawn at most once per frame and only when new ticks came in.

import { h } from "../ui/dom";
import { palette } from "../palette";

const SECONDS = 2;

export class SpeedGraph {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private buf = new Float32Array(SECONDS * 100);
  /** Total samples pushed; sample k lives at buf[k % len]. */
  private count = 0;
  private marks: { k: number; gain: number; first: boolean }[] = [];
  private dirty = true;
  /** Set by the HUD when the element is shown (avoids layout reads per frame). */
  visible = false;
  private top = 400;
  private bottom = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;

  constructor() {
    this.canvas = h("canvas.sg-canvas");
    this.ctx = this.canvas.getContext("2d")!;
    this.el = h("div.speedgraph", { "aria-hidden": "true" }, this.canvas);
    new ResizeObserver(([e]) => {
      const box = e.contentBoxSize?.[0];
      const cw = box ? box.inlineSize : e.contentRect.width;
      const ch = box ? box.blockSize : e.contentRect.height;
      this.dpr = Math.min(devicePixelRatio || 1, 2);
      this.w = Math.max(1, Math.round(cw * this.dpr));
      this.h = Math.max(1, Math.round(ch * this.dpr));
      this.canvas.width = this.w;
      this.canvas.height = this.h;
      this.dirty = true;
      this.render();
    }).observe(this.canvas);
  }

  setTickRate(hz: number): void {
    const n = Math.max(30, Math.round(hz * SECONDS));
    if (n !== this.buf.length) {
      this.buf = new Float32Array(n);
      this.reset();
    }
  }

  reset(): void {
    this.count = 0;
    this.marks.length = 0;
    this.dirty = true;
  }

  push(speed: number): void {
    this.buf[this.count % this.buf.length] = speed;
    this.count++;
    this.dirty = true;
    const oldest = this.count - this.buf.length;
    while (this.marks.length && this.marks[0].k < oldest) this.marks.shift();
  }

  /** Marks the latest sample as a jump with its gain (vs the previous jump). */
  mark(gain: number, first: boolean): void {
    if (this.count) this.marks.push({ k: this.count - 1, gain, first });
  }

  /** Fills the buffer with a synthetic bhop curve (layout editor preview). */
  demo(): void {
    this.reset();
    const n = this.buf.length;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const hop = (i % Math.round(n / 4)) / (n / 4);
      this.push(300 + t * 140 + Math.sin(hop * Math.PI) * 14);
      if (i % Math.round(n / 4) === 0 && i) this.mark(14 + (i % 7), false);
    }
  }

  render(): void {
    if (!this.dirty || !this.w || !this.visible) return;
    this.dirty = false;
    const g = this.ctx;
    const { w, h: hh, buf } = this;
    const n = buf.length;
    g.clearRect(0, 0, w, hh);
    const have = Math.min(this.count, n);
    let max = 0;
    let min = Infinity;
    for (let k = this.count - have; k < this.count; k++) {
      const v = buf[k % n];
      if (v > max) max = v;
      if (v < min) min = v;
    }
    if (!have) min = 0;
    // Auto-range around the visible speeds (min span 120 u/s), eased so the line doesn't jump around.
    let lo = Math.max(0, Math.floor((min - 30) / 50) * 50);
    let hi = Math.max(lo + 120, Math.ceil((max + 25) / 50) * 50);
    if (hi - lo < 120) lo = Math.max(0, hi - 120);
    const ease = (cur: number, want: number) => (Math.abs(want - cur) < 1 ? want : cur + (want - cur) * 0.2);
    this.top = ease(this.top, hi);
    this.bottom = ease(this.bottom, lo);
    if (this.top !== hi || this.bottom !== lo) this.dirty = true;
    const pad = Math.round(hh * 0.3);
    const span = Math.max(1, this.top - this.bottom);
    const yOf = (v: number) => hh - 2 * this.dpr - ((Math.max(this.bottom, v) - this.bottom) / span) * (hh - pad - 2 * this.dpr);
    const floor = hh - this.dpr;
    const xOf = (k: number) => ((k - (this.count - n)) / (n - 1)) * w;

    // Baseline guide at 0 and a faint line at the top value.
    g.lineWidth = this.dpr;
    g.strokeStyle = "rgba(255,255,255,0.12)";
    g.beginPath();
    g.moveTo(0, floor + 0.5);
    g.lineTo(w, floor + 0.5);
    g.stroke();

    if (have > 1) {
      const start = this.count - have;
      g.beginPath();
      for (let k = start; k < this.count; k++) {
        const x = xOf(k);
        const y = yOf(buf[k % n]);
        if (k === start) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      // Area fill under the line.
      g.lineTo(xOf(this.count - 1), floor);
      g.lineTo(xOf(start), floor);
      g.closePath();
      g.fillStyle = "rgba(255,255,255,0.08)";
      g.fill();
      g.beginPath();
      for (let k = start; k < this.count; k++) {
        const x = xOf(k);
        const y = yOf(buf[k % n]);
        if (k === start) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.lineWidth = 1.6 * this.dpr;
      g.strokeStyle = "rgba(255,255,255,0.92)";
      g.lineJoin = "round";
      g.stroke();
    }

    // Jump marks + gain labels.
    const fs = Math.max(9 * this.dpr, Math.round(hh * 0.2));
    g.font = `700 ${fs}px ui-sans-serif, system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "top";
    for (const m of this.marks) {
      const x = Math.round(xOf(m.k)) + 0.5;
      const y = yOf(buf[m.k % n]);
      const col = m.first ? "rgba(255,255,255,0.75)" : m.gain >= 0 ? palette().gain : palette().loss;
      g.strokeStyle = col;
      g.lineWidth = this.dpr;
      g.beginPath();
      g.moveTo(x, y - 3 * this.dpr);
      g.lineTo(x, floor);
      g.stroke();
      if (!m.first) {
        g.fillStyle = col;
        const label = (m.gain > 0 ? "+" : "") + Math.round(m.gain);
        g.fillText(label, Math.min(w - fs, Math.max(fs, x)), 1);
      }
    }
  }
}
