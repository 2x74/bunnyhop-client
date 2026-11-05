// Viewer scrubber: the run as a clean bar you drag. The played part is filled; a solid handle grows on hover and while
// dragging; jumps are small dots under the bar; start and finish are quiet marks (in head to head, the other run's
// finish too, in its colour); the region outside the timed run is dimmer. Hover shows the time and the jump there.
// Mouse, pen and touch alike (pointer events; touch-action: none keeps a horizontal drag from scrolling the page).
// A long wait in the spawn before the timer starts isn't drawn: the bar starts LEAD_S before the start when the
// lead-in is longer than LEAD_MIN_S. One canvas, redrawn only when something it shows changes.

import { formatTime } from "../timer";
import { h } from "../ui/dom";
import type { RunData } from "./player";

const ACCENT = "#ffb43a";
/** Seconds of lead-in kept on the bar before the timer starts, once there are more than LEAD_MIN_S of them. */
const LEAD_S = 2;
const LEAD_MIN_S = 3;
/** Side margin (CSS px) so the handle fits at both ends. */
const MARGIN = 10;

export interface TimelineHooks {
  /** Scrub to a tick (fractional allowed). `final` on pointer release. */
  seek: (tick: number, final: boolean) => void;
}

export class Timeline {
  readonly el: HTMLElement;
  private canvas = h("canvas.rv-tl-canvas");
  private g = this.canvas.getContext("2d")!;
  private tip = h("div.rv-tl-tip", { hidden: true });
  private tipTime = h("b");
  private tipMore = h("span");
  private data: RunData | null = null;
  private compareEnd: number | null = null;
  private compareColor = "#4fa8ff";
  private head = 0;
  private hover: number | null = null;
  private dirty = true;
  private w = 0;
  private hgt = 0;
  private dpr = 1;
  private bg: HTMLCanvasElement | null = null;
  private dragging = false;
  /** 0..1, eased toward 1 while hovered or dragged (the handle grows, the track thickens). */
  private lift = 0;
  private liftAt = 0;
  /** Staff only (staff-lens.ts): the jumps the run's analysis flagged, marked once in amber. */
  private evidence: number[] = [];
  /** A Segmented run's checkpoint loads (replay.segments): where the stitched run continues from a saved checkpoint. */
  private segments: number[] = [];
  /** First tick the bar shows (see LEAD_S) and the ticks it spans. */
  private lo = 0;
  private span = 1;
  /** Last tick the bar shows when it isn't the replay's (head to head: the later of two replays), else null. */
  private end: number | null = null;

  constructor(private hooks: TimelineHooks) {
    this.tip.append(this.tipTime, this.tipMore);
    // Focusable (the viewer's ← / → / , / . / J keys move it); a slider to screen readers.
    this.el = h("div.rv-timeline", { role: "slider", "aria-label": "Replay timeline", "aria-valuemin": "0", tabindex: "0" }, this.canvas, this.tip);
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
      const f = Math.max(0, Math.min(1, (e.clientX - r.left - MARGIN) / Math.max(1, r.width - 2 * MARGIN)));
      return this.lo + f * this.span;
    };
    this.canvas.addEventListener("pointerdown", (e) => {
      if (!this.data || e.button !== 0) return;
      this.dragging = true;
      this.el.classList.add("dragging");
      this.canvas.setPointerCapture(e.pointerId);
      this.hooks.seek(tickAt(e), false);
      this.dirty = true;
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
      this.el.classList.remove("dragging");
      this.hooks.seek(tickAt(e), true);
      this.dirty = true;
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
    this.span = Math.max(1, (this.end ?? d.n) - this.lo);
    this.bg = null;
    this.dirty = true;
  }

  /** The bar runs to tick `end` (past the replay's last tick: head to head's slower run), or the replay's end (null). */
  setEnd(end: number | null): void {
    this.end = end;
    if (this.data) this.setData(this.data);
  }

  /** The compared run's finish on this bar (a quiet mark in its colour); `delta` isn't drawn any more. */
  setCompare(endTick: number | null, color: string, _delta: Float32Array | null): void {
    this.compareEnd = endTick;
    this.compareColor = color;
    this.bg = null;
    this.dirty = true;
  }

  setEvidence(ticks: number[]): void {
    this.evidence = ticks;
    this.bg = null;
    this.dirty = true;
  }

  setSegments(ticks: number[]): void {
    this.segments = ticks;
    this.bg = null;
    this.dirty = true;
  }

  setHead(t: number): void {
    if (Math.abs(t - this.head) * this.w < this.span * 0.25) return;
    this.head = t;
    this.dirty = true;
    const d = this.data;
    if (d) {
      const text = formatTime(Math.max(0, t) * d.interval);
      if (this.el.getAttribute("aria-valuetext") !== text) {
        this.el.setAttribute("aria-valuetext", text);
        this.el.setAttribute("aria-valuenow", String(Math.round(t)));
        this.el.setAttribute("aria-valuemax", String(Math.round(this.lo + this.span)));
      }
    }
  }

  private showTip(e: PointerEvent, t: number): void {
    const d = this.data!;
    const i = Math.max(0, Math.min(d.n, Math.round(t)));
    this.tipTime.textContent = formatTime(i * d.interval);
    const jump = d.startTick && i >= d.startTick ? d.jumps[Math.min(i, d.endTick || i)] : 0;
    const more = jump ? `jump ${jump}` : "";
    this.tipMore.textContent = more;
    this.tipMore.hidden = !more;
    this.tip.hidden = false;
    const r = this.el.getBoundingClientRect();
    const x = Math.max(44, Math.min(r.width - 44, e.clientX - r.left));
    this.tip.style.left = `${x}px`;
  }

  private xOf(t: number): number {
    const m = MARGIN * this.dpr;
    return m + ((t - this.lo) / this.span) * (this.w - 2 * m);
  }

  /** Static layer (everything but the played part, hover and handle). */
  private background(): HTMLCanvasElement {
    const d = this.data!;
    const c = document.createElement("canvas");
    c.width = this.w;
    c.height = this.hgt;
    const g = c.getContext("2d")!;
    this.track(g, d, false, 0);
    return c;
  }

  /** The bar; `played`: only the played part (clipped by the caller). `lift` thickens it (hover / drag). */
  private track(g: CanvasRenderingContext2D, d: RunData, played: boolean, lift: number): void {
    const dpr = this.dpr;
    const cy = Math.round(this.hgt * 0.42);
    const th = (5 + 3 * lift) * dpr;
    const x0 = this.xOf(this.lo);
    const x1 = this.xOf(this.lo + this.span);
    const runA = d.startTick ? this.xOf(d.startTick) : x0;
    const runB = d.startTick ? this.xOf(d.endTick || this.lo + this.span) : x1;
    const bar = (a: number, b: number, color: string) => {
      g.fillStyle = color;
      g.beginPath();
      g.roundRect(a, cy - th / 2, Math.max(0, b - a), th, th / 2);
      g.fill();
    };
    if (played) {
      bar(x0, x1, ACCENT);
      return;
    }
    bar(x0, x1, "rgba(255,255,255,0.08)");
    bar(runA, runB, "rgba(255,255,255,0.16)");
    // Jumps: small dots under the bar.
    g.fillStyle = "rgba(255,255,255,0.32)";
    for (const t of d.jumpTicks) if (t >= this.lo) {
      g.beginPath();
      g.arc(this.xOf(t), cy + 9 * dpr, 1.3 * dpr, 0, Math.PI * 2);
      g.fill();
    }
    const mark = (t: number, color: string, w = 2) => {
      g.fillStyle = color;
      g.fillRect(Math.round(this.xOf(t) - (w * dpr) / 2), cy - 7 * dpr, w * dpr, 14 * dpr);
    };
    if (d.startTick) mark(d.startTick, "rgba(239,233,221,0.75)");
    if (d.endTick) mark(d.endTick, "rgba(239,233,221,0.75)");
    if (this.compareEnd !== null) mark(this.compareEnd, this.compareColor);
    this.extras(g, cy - th / 2 - 4 * dpr, cy + 12 * dpr);
  }

  /** Staff evidence (amber marks on top) and a Segmented run's loads (small marks below). */
  private extras(g: CanvasRenderingContext2D, top: number, bottom: number): void {
    const dpr = this.dpr;
    g.fillStyle = ACCENT;
    for (const t of this.evidence) g.fillRect(Math.round(this.xOf(t)) - dpr, top - 4 * dpr, 2 * dpr, 4 * dpr);
    g.fillStyle = "rgba(77,255,136,0.8)";
    for (const t of this.segments) g.fillRect(Math.round(this.xOf(t)) - dpr / 2, bottom, Math.max(1, dpr), 3 * dpr);
  }

  render(): void {
    // The handle grows on hover and while dragging, eased over ~120 ms.
    const want = this.dragging ? 1 : this.hover !== null ? 0.6 : 0;
    const now = performance.now();
    const dt = Math.min(0.1, (now - (this.liftAt || now)) / 1000);
    this.liftAt = now;
    if (Math.abs(want - this.lift) > 0.01) {
      this.lift += (want - this.lift) * Math.min(1, dt * 14);
      this.dirty = true;
    } else this.lift = want;
    if (!this.dirty || !this.data || !this.w) return;
    this.dirty = false;
    const d = this.data;
    if (Math.abs(this.lift) > 0.01) this.bg = null; // the bar thickens: redraw it
    this.bg ??= this.background();
    const g = this.g;
    const dpr = this.dpr;
    g.clearRect(0, 0, this.w, this.hgt);
    g.drawImage(this.bg, 0, 0);
    const x = this.xOf(Math.max(this.lo, Math.min(this.lo + this.span, this.head)));
    // Played part.
    g.save();
    g.beginPath();
    g.rect(0, 0, x, this.hgt);
    g.clip();
    this.track(g, d, true, this.lift);
    g.restore();
    if (this.hover !== null && !this.dragging) {
      g.fillStyle = "rgba(255,255,255,0.4)";
      const hx = Math.round(this.xOf(this.hover));
      g.fillRect(hx - dpr / 2, this.hgt * 0.42 - 6 * dpr, dpr, 12 * dpr);
    }
    this.knob(g, x, Math.round(this.hgt * 0.42), (7 + 3 * this.lift) * dpr);
  }

  private knob(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
    g.save();
    g.shadowColor = "rgba(0,0,0,0.55)";
    g.shadowBlur = 6 * this.dpr;
    g.shadowOffsetY = this.dpr;
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.restore();
    g.fillStyle = ACCENT;
    g.beginPath();
    g.arc(x, y, r * 0.38, 0, Math.PI * 2);
    g.fill();
  }
}
