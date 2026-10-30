// The replay viewer's timeline, drawn like the web viewer's (viewer/timeline.ts): the run's speed graph, jump ticks,
// stage and checkpoint splits, START / FINISH / GHOST / DESYNC markers, the part outside the timed run dimmed, a
// playhead and a hover readout. The web bar always starts 2 s before the run; this one spans the host's shown range
// (replay-range.ts), so "Full recording" can still show the whole file.
//
// The host simulates the replay, so the graph and markers come from it once per replay (ReplayTimelineData). Until a
// host sends them the bar is a plain scrubber over the range.

import { formatTime } from "../../web/src/timer";
import { h } from "../../web/src/ui/dom";
import { palette } from "../../web/src/palette";
import type { ShownRange } from "./replay-range";

const ACCENT = "#ffb43a";
const DESYNC = "#ff2d55";
/** Longest arrays accepted from the host: a 2 h recording at 100 tick per sample of one tick. */
const MAX_SAMPLES = 720_000;
const MAX_MARKS = 100_000;

export interface ReplaySplit {
  tick: number;
  kind: "stage" | "checkpoint";
  index: number;
}

/**
 * What the host sends once per replay (`bunnyhopNativeMenu.onReplayTimeline`). Ticks are absolute recording ticks.
 * `speed[i]` is the highest horizontal speed (u/s) from `firstTick + i * step` for `step` ticks.
 */
export interface ReplayTimelineData {
  id: string;
  firstTick: number;
  step: number;
  speed: number[];
  jumps: number[];
  /** Ticks where the runner switched strafe side (absent from older hosts). */
  strafes: number[];
  /** Kept-path Segmented checkpoint loads. */
  segments: number[];
  splits: ReplaySplit[];
  /** The final run's start and finish; 0 when the replay never starts or never finishes one. */
  startTick: number;
  endTick: number;
  /** Where the replay stopped matching the map (DESYNC), or null. */
  desyncTick: number | null;
}

const isTick = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const isSpeed = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function readSplit(value: unknown): ReplaySplit | null {
  if (!value || typeof value !== "object") return null;
  const split = value as Record<string, unknown>;
  if (!isTick(split.tick) || !isTick(split.index)) return null;
  if (split.kind !== "stage" && split.kind !== "checkpoint") return null;
  return { tick: split.tick, kind: split.kind, index: split.index };
}

/** The host's timeline message, checked value by value; null when it isn't one. */
export function readTimelineData(value: unknown): ReplayTimelineData | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (typeof data.id !== "string" || !data.id || !isTick(data.firstTick) || !isTick(data.step) || !data.step)
    return null;
  if (!Array.isArray(data.speed) || data.speed.length > MAX_SAMPLES || !data.speed.every(isSpeed)) return null;
  const jumps = Array.isArray(data.jumps) ? data.jumps.slice(0, MAX_MARKS).filter(isTick) : [];
  const strafes = Array.isArray(data.strafes) ? data.strafes.slice(0, MAX_MARKS).filter(isTick) : [];
  const segments = Array.isArray(data.segments) ? data.segments.slice(0, MAX_MARKS).filter(isTick) : [];
  const rawSplits = Array.isArray(data.splits) ? data.splits.slice(0, MAX_MARKS) : [];
  const splits = rawSplits.map(readSplit).filter((split): split is ReplaySplit => split !== null);
  return {
    id: data.id,
    firstTick: data.firstTick,
    step: data.step,
    speed: data.speed,
    jumps,
    strafes,
    segments,
    splits,
    startTick: isTick(data.startTick) ? data.startTick : 0,
    endTick: isTick(data.endTick) ? data.endTick : 0,
    desyncTick: isTick(data.desyncTick) ? data.desyncTick : null,
  };
}

export interface ReplayTimelineHooks {
  /** Scrub to an absolute tick; `final` on release. */
  seek: (tick: number, final: boolean) => void;
}

export class ReplayTimeline {
  readonly el: HTMLElement;
  private readonly canvas = h("canvas.rv-tl-canvas") as HTMLCanvasElement;
  private readonly tip = h("div.rv-tl-tip", { hidden: true });
  private range: ShownRange = { start: 0, end: 0, ticks: 0, interval: 0.01 };
  private data: ReplayTimelineData | null = null;
  private compare: { endTick: number; color: string } | null = null;
  private loop: { from: number; to: number } | null = null;
  private head = 0;
  private hover: number | null = null;
  private dragging = false;
  private width = 0;
  private height = 0;
  private pixelRatio = 1;
  private background: HTMLCanvasElement | null = null;

  constructor(private readonly hooks: ReplayTimelineHooks) {
    this.el = h(
      "div.rv-timeline",
      { role: "slider", "aria-label": "Replay timeline", tabindex: "0" },
      this.canvas,
      this.tip,
    );
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    this.canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.release(event));
    this.canvas.addEventListener("pointercancel", (event) => this.release(event));
    this.canvas.addEventListener("pointerleave", () => {
      this.hover = null;
      this.tip.hidden = true;
      this.draw();
    });
  }

  get scrubbing(): boolean {
    return this.dragging;
  }

  setRange(range: ShownRange): void {
    if (range.start === this.range.start && range.end === this.range.end && range.interval === this.range.interval)
      return;
    this.range = range;
    this.el.setAttribute("aria-valuemin", String(range.start));
    this.el.setAttribute("aria-valuemax", String(range.end));
    this.invalidate();
  }

  setData(data: ReplayTimelineData | null): void {
    if (data === this.data) return;
    this.data = data;
    this.invalidate();
  }

  setCompare(endTick: number | null, color: string): void {
    const same = this.compare?.endTick === endTick && this.compare?.color === color;
    if (same || (!this.compare && endTick === null)) return;
    this.compare = endTick === null ? null : { endTick, color };
    this.invalidate();
  }

  /** The A–B loop, shaded on the bar. */
  setLoop(loop: { from: number; to: number } | null): void {
    if (loop?.from === this.loop?.from && loop?.to === this.loop?.to) return;
    this.loop = loop;
    this.draw();
  }

  /** The playhead, and the readout screen readers get (`text`: "00:01.500 of 00:25.600"). */
  setHead(tick: number, text: string): void {
    this.el.setAttribute("aria-valuenow", String(tick));
    this.el.setAttribute("aria-valuetext", text);
    if (tick === this.head) return;
    this.head = tick;
    this.draw();
  }

  private invalidate(): void {
    this.background = null;
    this.draw();
  }

  private tickAt(event: PointerEvent): number {
    const box = this.canvas.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - box.left) / Math.max(1, box.width)));
    return Math.round(this.range.start + fraction * this.range.ticks);
  }

  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !this.range.ticks) return;
    this.dragging = true;
    this.canvas.setPointerCapture(event.pointerId);
    this.hooks.seek(this.tickAt(event), false);
  }

  private pointerMove(event: PointerEvent): void {
    if (!this.range.ticks) return;
    const tick = this.tickAt(event);
    if (this.dragging) this.hooks.seek(tick, false);
    this.hover = tick;
    this.showTip(event, tick);
    this.draw();
  }

  private release(event: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.hooks.seek(this.tickAt(event), true);
  }

  private showTip(event: PointerEvent, tick: number): void {
    const parts = [formatTime((tick - this.range.start) * this.range.interval)];
    const data = this.data;
    if (data?.startTick && tick >= data.startTick) {
      const runTick = Math.min(tick, data.endTick || tick);
      parts.push(`run ${formatTime((runTick - data.startTick) * this.range.interval)}`);
    }
    const speed = this.speedAt(tick);
    if (speed !== null) parts.push(`${Math.round(speed)} u/s`);
    this.tip.textContent = parts.join(" · ");
    this.tip.hidden = false;
    const box = this.el.getBoundingClientRect();
    this.tip.style.left = `${Math.max(60, Math.min(box.width - 60, event.clientX - box.left))}px`;
  }

  private speedAt(tick: number): number | null {
    const data = this.data;
    if (!data) return null;
    const sample = Math.floor((tick - data.firstTick) / data.step);
    return sample >= 0 && sample < data.speed.length ? data.speed[sample] : null;
  }

  private resize(): void {
    const box = this.canvas.getBoundingClientRect();
    this.pixelRatio = Math.min(2, devicePixelRatio || 1);
    this.width = Math.max(1, Math.round(box.width * this.pixelRatio));
    this.height = Math.max(1, Math.round(box.height * this.pixelRatio));
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.invalidate();
  }

  private x(tick: number): number {
    return this.range.ticks ? ((tick - this.range.start) / this.range.ticks) * this.width : 0;
  }

  private draw(): void {
    const context = this.canvas.getContext("2d");
    if (!context || !this.width) return;
    this.background ??= this.drawBackground();
    context.clearRect(0, 0, this.width, this.height);
    context.drawImage(this.background, 0, 0);
    const ratio = this.pixelRatio;
    const head = this.x(this.head);
    context.fillStyle = "rgba(255,255,255,0.05)";
    context.fillRect(0, 0, head, this.height);
    if (this.loop) {
      const from = this.x(this.loop.from);
      context.fillStyle = "rgba(120,190,255,0.16)";
      context.fillRect(from, 0, this.x(this.loop.to) - from, this.height);
      context.fillStyle = "rgba(120,190,255,0.9)";
      context.fillRect(Math.round(from), 0, ratio, this.height);
      context.fillRect(Math.round(this.x(this.loop.to)), 0, ratio, this.height);
    }
    if (this.hover !== null) {
      context.fillStyle = "rgba(255,255,255,0.35)";
      context.fillRect(Math.round(this.x(this.hover)), 0, ratio, this.height);
    }
    context.fillStyle = "#fff";
    context.fillRect(Math.round(head - ratio), 0, 2 * ratio, this.height);
    context.beginPath();
    context.moveTo(head - 5 * ratio, 0);
    context.lineTo(head + 5 * ratio, 0);
    context.lineTo(head, 6 * ratio);
    context.closePath();
    context.fill();
  }

  private drawBackground(): HTMLCanvasElement {
    const layer = document.createElement("canvas");
    layer.width = this.width;
    layer.height = this.height;
    const context = layer.getContext("2d");
    if (!context) return layer;
    context.fillStyle = "rgba(255,255,255,0.03)";
    context.fillRect(0, 0, this.width, this.height);
    const data = this.data;
    if (!data || !this.range.ticks) return layer;
    if (data.startTick) {
      context.fillStyle = "rgba(255,255,255,0.045)";
      const from = this.x(data.startTick);
      context.fillRect(from, 0, this.x(data.endTick || this.range.end) - from, this.height);
    }
    this.drawSpeed(context, data);
    this.drawMarks(context, data);
    return layer;
  }

  /** Highest speed under each pixel column, as a filled area and a line, with the scale top left. */
  private drawSpeed(context: CanvasRenderingContext2D, data: ReplayTimelineData): void {
    const ratio = this.pixelRatio;
    const top = Math.round(14 * ratio);
    const bottom = this.height - Math.round(10 * ratio);
    const columns = new Float32Array(this.width);
    let fastest = 0;
    for (let x = 0; x < this.width; x++) {
      const from = this.range.start + (x / this.width) * this.range.ticks;
      const to = this.range.start + ((x + 1) / this.width) * this.range.ticks;
      const first = Math.max(0, Math.floor((from - data.firstTick) / data.step));
      const last = Math.min(data.speed.length - 1, Math.max(first, Math.floor((to - data.firstTick) / data.step)));
      for (let sample = first; sample <= last; sample++) columns[x] = Math.max(columns[x], data.speed[sample]);
      fastest = Math.max(fastest, columns[x]);
    }
    const scale = Math.max(100, Math.ceil(fastest / 50) * 50);
    const y = (speed: number) => bottom - (speed / scale) * (bottom - top);
    const fill = context.createLinearGradient(0, top, 0, bottom);
    fill.addColorStop(0, "rgba(255,180,58,0.55)");
    fill.addColorStop(1, "rgba(255,180,58,0.04)");
    context.beginPath();
    context.moveTo(0, bottom);
    for (let x = 0; x < this.width; x++) context.lineTo(x, y(columns[x]));
    context.lineTo(this.width, bottom);
    context.closePath();
    context.fillStyle = fill;
    context.fill();
    context.beginPath();
    for (let x = 0; x < this.width; x++) {
      if (x) context.lineTo(x, y(columns[x]));
      else context.moveTo(x, y(columns[x]));
    }
    context.strokeStyle = "rgba(255,200,110,0.95)";
    context.lineWidth = 1.2 * ratio;
    context.stroke();
    context.font = `600 ${9 * ratio}px ui-sans-serif, system-ui, sans-serif`;
    context.fillStyle = "rgba(255,255,255,0.35)";
    context.textBaseline = "top";
    context.fillText(`${scale} u/s`, 4 * ratio, 2 * ratio);
  }

  private drawMarks(context: CanvasRenderingContext2D, data: ReplayTimelineData): void {
    const ratio = this.pixelRatio;
    context.fillStyle = "rgba(255,255,255,0.4)";
    for (const tick of data.jumps) {
      if (this.inRange(tick))
        context.fillRect(Math.round(this.x(tick)), this.height - 6 * ratio, Math.max(1, ratio), 5 * ratio);
    }
    // Strafe switches: shorter ticks just above the jumps.
    context.fillStyle = "rgba(120,190,255,0.45)";
    for (const tick of data.strafes) {
      if (this.inRange(tick))
        context.fillRect(Math.round(this.x(tick)), this.height - 10 * ratio, Math.max(1, ratio), 3 * ratio);
    }
    context.fillStyle = "rgba(255,255,255,0.5)";
    for (const tick of data.segments) {
      if (this.inRange(tick))
        context.fillRect(Math.round(this.x(tick)), this.height - 4 * ratio, Math.max(1, ratio), 4 * ratio);
    }
    for (const split of data.splits) {
      this.marker(context, split.tick, ACCENT, split.kind === "stage" ? `S${split.index}` : `CP${split.index}`, 1);
    }
    if (data.startTick) this.marker(context, data.startTick, palette().gain, "START");
    if (data.endTick) this.marker(context, data.endTick, palette().loss, "FINISH");
    if (this.compare) this.marker(context, this.compare.endTick, this.compare.color, "GHOST", 1);
    if (data.desyncTick !== null) this.marker(context, data.desyncTick, DESYNC, "DESYNC");
  }

  private inRange(tick: number): boolean {
    return tick >= this.range.start && tick <= this.range.end;
  }

  private marker(context: CanvasRenderingContext2D, tick: number, color: string, label: string, width = 2): void {
    if (!this.inRange(tick)) return;
    const ratio = this.pixelRatio;
    const x = Math.round(this.x(tick));
    context.fillStyle = color;
    context.fillRect(x - (width * ratio) / 2, 0, width * ratio, this.height);
    context.font = `800 ${9 * ratio}px ui-sans-serif, system-ui, sans-serif`;
    const labelWidth = context.measureText(label).width + 6 * ratio;
    const left = Math.min(this.width - labelWidth, Math.max(0, x + 3 * ratio));
    context.fillStyle = "rgba(10,12,16,0.75)";
    context.fillRect(left, ratio, labelWidth, 11 * ratio);
    context.fillStyle = color;
    context.fillText(label, left + 3 * ratio, 2 * ratio);
  }
}
