// Canvas HUD for MP4 exports: draws the game HUD into the video frame (no DOM capture). It mirrors hud/hud.css and
// style.css — same sizes (em of the element font, which is rem x element scale x HUD scale), weights, colours, pills,
// sync bar, keycaps and speed graph — at the positions of the player's HUD layout (prefs.hud.layout), with rem
// computed by the same clamp() the page uses for that frame size. Also the intro title card and the outro card.

import { formatDelta, splitLead } from "../hud/time-face";
import { anchorX, anchorY, hudPoints, hudRem, type HudElId, type HudPoint, type HudPlace, type KeysPrefs } from "../hud/layout";
import { IN_BACK, IN_DUCK, IN_FORWARD, IN_JUMP, IN_MOVELEFT, IN_MOVERIGHT } from "../input";
import { formatTime } from "../timer";
import { prefs } from "../ui/settings";
import { F_JUMPED, type RunData } from "./player";
import { hudValues, previousJump, TURN_L, TURN_R, type HudValues } from "./hud";

const FONT = `"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const MONO = `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace`;
const GAIN = "#4dff88";
const LOSS = "#ff5d5d";
const ACCENT = "#ffb43a";

export interface CanvasHudOptions {
  hud: boolean;
  keys: boolean;
  graph: boolean;
  /** Brief hook text, independent of the HUD toggles. */
  caption?: string;
}

/** html { font-size: clamp(14px, 0.35vw + 0.45vh + 7px, 28px) } for a w x h viewport. */
export function remFor(w: number, h: number): number {
  return hudRem(w, h);
}

type G = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function font(g: G, weight: number, px: number, family = FONT): void {
  g.font = `${weight} ${px.toFixed(2)}px ${family}`;
  (g as CanvasRenderingContext2D).fontStretch = "normal";
}

/** The HUD's numbers are a touch condensed (hud.css font-stretch: 90%; canvas has the keyword steps only). */
function numFont(g: G, weight: number, px: number): void {
  font(g, weight, px);
  (g as CanvasRenderingContext2D).fontStretch = "semi-condensed";
}

/** text-shadow: 0 1px 2px rgba(0,0,0,.85), 0 0 .6em rgba(0,0,0,.35) — two passes, then the fill. */
function shadowText(g: G, s: string, x: number, y: number, em: number): void {
  g.save();
  g.shadowColor = "rgba(0,0,0,0.35)";
  g.shadowBlur = em * 0.6;
  g.fillText(s, x, y);
  g.shadowColor = "rgba(0,0,0,0.85)";
  g.shadowBlur = 2;
  g.shadowOffsetY = 1;
  g.fillText(s, x, y);
  g.restore();
}

function roundRect(g: G, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

/** Width of text with CSS letter-spacing (canvas letterSpacing where supported). */
function spaced(g: G, ls: number): void {
  (g as CanvasRenderingContext2D).letterSpacing = `${ls.toFixed(2)}px`;
}

interface Box {
  w: number;
  h: number;
  draw: (x: number, y: number) => void;
}

export class CanvasHud {
  private rem = 16;
  private hs = 1;

  constructor(
    private w: number,
    private h: number,
  ) {
    this.rem = remFor(w, h);
  }

  /** Where each element's anchor point goes at the HUD scale (hud/layout.ts hudPoints), for this frame. */
  private at: Record<HudElId, HudPoint> | null = null;

  /**
   * Places a box like hud/layout.ts placeStyle: anchor point on screen (hudPoints) == anchor point on the box, kept on
   * the frame like the game's HUD (hud.ts fit).
   */
  private place(g: G, id: HudElId, p: HudPlace, box: Box): void {
    const ax = anchorX(p.a);
    const ay = anchorY(p.a);
    const pt = this.at?.[id] ?? { x: ax + p.x, y: ay + p.y };
    const x = Math.max(0, Math.min(this.w - box.w, pt.x * this.w - ax * box.w));
    const y = Math.max(0, Math.min(this.h - box.h, pt.y * this.h - ay * box.h));
    g.save();
    box.draw(Math.round(x), Math.round(y));
    g.restore();
  }

  draw(g: G, d: RunData, t: number, delta: number | null, o: CanvasHudOptions): void {
    const p = prefs.get();
    this.hs = p.hud.scale;
    const L = p.hud.layout;
    this.at = hudPoints(L, this.hs, this.rem / Math.max(1, this.h));
    const v = hudValues(d, t, delta);
    g.save();
    g.textBaseline = "alphabetic";
    g.textAlign = "left";
    const em = (pl: HudPlace) => this.rem * pl.s * this.hs;
    if (o.caption?.trim()) drawShortCaption(g, this.w, this.h, o.caption);
    if (this.w < this.h) {
      this.drawPortrait(g, d, t, v, o);
      g.restore();
      return;
    }
    if (o.hud) {
      if (L.speed.on) this.place(g, "speed", L.speed, this.speed(g, v, em(L.speed)));
      if (L.timer.on) this.place(g, "timer", L.timer, this.timer(g, v, em(L.timer)));
      if (L.split.on && v.split !== null) this.place(g, "split", L.split, this.split(g, v.split, em(L.split)));
      if (L.track.on && v.track) this.place(g, "track", L.track, this.text(g, v.track, em(L.track) * 0.85, 750, ACCENT));
      if (L.stage.on && v.stage) this.place(g, "stage", L.stage, this.text(g, v.stage, em(L.stage) * 0.8, 700, "rgba(255,255,255,0.9)"));
      if (L.stats.on && v.showStats) this.place(g, "stats", L.stats, this.stats(g, v, em(L.stats) * 0.8));
      if (L.sync.on) this.place(g, "sync", L.sync, this.sync(g, v.sync, em(L.sync) * 0.7, v.perfText));
    }
    if (o.keys && L.keys.on) this.place(g, "keys", L.keys, this.keys(g, v.keys, em(L.keys) * 0.62, p.hud.keys));
    if (o.graph) this.place(g, "graph", L.graph.on ? L.graph : { ...L.graph, on: true }, this.graph(g, d, t, em(L.graph)));
    g.restore();
  }

  /** Keep exports clear of the right-side actions and bottom caption/navigation UI. */
  private drawPortrait(g: G, d: RunData, t: number, v: HudValues, o: CanvasHudOptions): void {
    const p = prefs.get();
    const L = p.hud.layout;
    const width = this.w * 0.64;
    const e = this.w / 27;
    const gap = this.w * 0.016;
    // Export layout deliberately uses stable, readable sizing regardless of desktop HUD placement.
    const draw = (box: Box, y: number, maxWidth = width): number => {
      const scale = Math.min(1, maxWidth / Math.max(1, box.w));
      g.save();
      g.translate((this.w - box.w * scale) / 2, y);
      g.scale(scale, scale);
      box.draw(0, 0);
      g.restore();
      return box.h * scale + gap;
    };
    let top = this.h * 0.16;
    if (o.hud) {
      if (L.speed.on) top += draw(this.speed(g, v, e), top);
      if (L.timer.on) top += draw(this.timer(g, v, e), top);
      if (L.split.on && v.split !== null) top += draw(this.split(g, v.split, e), top);
      if (L.track.on && v.track) top += draw(this.text(g, v.track, e * 0.85, 750, ACCENT), top);
      if (L.stage.on && v.stage) draw(this.text(g, v.stage, e * 0.8, 700, "rgba(255,255,255,0.9)"), top);
    }
    let bottom = this.h * 0.77;
    const stack = (box: Box): void => {
      const scale = Math.min(1, width / Math.max(1, box.w));
      bottom -= box.h * scale;
      draw(box, bottom);
      bottom -= gap;
    };
    if (o.graph) stack(this.graph(g, d, t, width / 13));
    if (o.hud && L.stats.on && v.showStats) stack(this.stats(g, v, e * 0.7));
    if (o.hud && L.sync.on) stack(this.sync(g, v.sync, e * 0.7, v.perfText));
    if (o.keys && L.keys.on) stack(this.keys(g, v.keys, e * 0.7, p.hud.keys));
  }

  // ---- elements (sizes from hud.css) ----

  private speed(g: G, v: HudValues, e: number): Box {
    const big = e * 2.1;
    const unit = big * 0.36;
    const num = String(Math.round(v.speed));
    numFont(g, 800, big);
    spaced(g, -0.01 * big);
    const nw = g.measureText(num).width;
    font(g, 650, unit);
    spaced(g, 0);
    const uw = g.measureText("u/s").width;
    const gap = big * 0.25;
    const color = v.speedClass === "gain" ? GAIN : v.speedClass === "loss" ? LOSS : "#fff";
    return {
      w: nw + gap + uw,
      h: big,
      draw: (x, y) => {
        const base = y + big * 0.86;
        g.fillStyle = color;
        numFont(g, 800, big);
        spaced(g, -0.01 * big);
        shadowText(g, num, x, base, big);
        font(g, 650, unit);
        spaced(g, 0);
        g.globalAlpha = 0.6;
        shadowText(g, "u/s", x + nw + gap, base, unit);
      },
    };
  }

  private timer(g: G, v: HudValues, e: number): Box {
    const fs = e * 1.2;
    if (v.timerState === "nozones") return this.text(g, v.timeText, fs * 0.72, 600, "rgba(255,255,255,0.7)", fs * 1.25);
    // "00:31.420" with the leading zeros quiet; in the start zone a dim zero over the zone-green line.
    const [lead, rest] = splitLead(v.timeText);
    numFont(g, 750, fs);
    spaced(g, 0);
    const lw = g.measureText(lead).width;
    const w = lw + g.measureText(rest).width;
    const lineH = fs * 1.25;
    const alpha = v.timerState === "idle" ? 0.5 : v.timerState === "start" ? 0.6 : 1;
    return {
      w,
      h: lineH,
      draw: (x, y) => {
        const base = y + (lineH + fs * 0.72) / 2;
        numFont(g, 750, fs);
        spaced(g, 0);
        g.fillStyle = "#fff";
        g.globalAlpha = alpha * 0.4;
        shadowText(g, lead, x, base, fs);
        g.globalAlpha = alpha;
        shadowText(g, rest, x + lw, base, fs);
        g.globalAlpha = 1;
        if (v.timerState === "start") {
          g.fillStyle = "#33dd66";
          g.fillRect(x, base + fs * 0.2, w, Math.max(1, fs * 0.08));
        }
      },
    };
  }

  private split(g: G, s: number, e: number): Box {
    const b = this.text(g, formatDelta(s), e * 0.95, 700, s <= 0 ? GAIN : LOSS, e * 0.95 * 1.2);
    const draw = b.draw;
    b.draw = (x, y) => ((g.globalAlpha = 0.85), draw(x, y), (g.globalAlpha = 1));
    return b;
  }

  private text(g: G, s: string, fs: number, weight: number, color: string, lineH = fs * 1.2): Box {
    font(g, weight, fs);
    spaced(g, 0);
    const w = g.measureText(s).width;
    return {
      w,
      h: lineH,
      draw: (x, y) => {
        font(g, weight, fs);
        spaced(g, 0);
        g.fillStyle = color;
        shadowText(g, s, x, y + (lineH + fs * 0.72) / 2, fs);
      },
    };
  }

  private pill(g: G, s: string, fs: number, ink: string, bg: string, ls: number, outerH?: number): Box {
    font(g, 800, fs);
    spaced(g, ls * fs);
    const tw = g.measureText(s).width;
    const px = fs * 0.6;
    const py = fs * 0.2;
    const w = tw + px * 2;
    const h = fs * 1.2 + py * 2;
    const H = Math.max(h, outerH ?? h);
    return {
      w,
      h: H,
      draw: (x, y) => {
        const top = y + (H - h) / 2;
        g.fillStyle = bg;
        roundRect(g, x, top, w, h, fs * 0.3);
        g.fill();
        font(g, 800, fs);
        spaced(g, ls * fs);
        g.fillStyle = ink;
        g.fillText(s, x + px, top + py + fs * 0.95);
      },
    };
  }

  private stats(g: G, v: HudValues, fs: number): Box {
    const parts: [string, string][] = [
      [String(v.jumps), " jumps"],
      [String(v.strafes), " strafes"],
      [`${v.sync.toFixed(1)}%`, " sync"],
    ];
    if (v.perfText && !prefs.get().hud.layout.sync.on) parts.push([v.perfText, ""]);
    const gap = fs * 0.9;
    const widths = parts.map(([b, s]) => {
      font(g, 700, fs);
      const bw = g.measureText(b).width;
      font(g, 400, fs);
      return [bw, g.measureText(s).width];
    });
    const w = widths.reduce((a, [x, y]) => a + x + y, 0) + gap * (parts.length - 1);
    const lh = fs * 1.3;
    return {
      w,
      h: lh,
      draw: (x, y) => {
        spaced(g, 0);
        const base = y + (lh + fs * 0.72) / 2;
        let cx = x;
        parts.forEach(([b, s], i) => {
          font(g, 700, fs);
          g.fillStyle = "#fff";
          shadowText(g, b, cx, base, fs);
          cx += widths[i][0];
          font(g, 400, fs);
          g.fillStyle = "rgba(255,255,255,0.85)";
          shadowText(g, s, cx, base, fs);
          cx += widths[i][1] + gap;
        });
      },
    };
  }

  private sync(g: G, sync: number, fs: number, perf = ""): Box {
    const pct = Math.round(sync);
    const barW = fs * 11;
    const barH = fs * 0.42;
    const label = "sync ";
    font(g, 700, fs);
    spaced(g, 0);
    const lw = g.measureText(label).width;
    const value = `${pct}%${perf ? `  ${perf}` : ""}`;
    const bw = g.measureText(value).width;
    const lineH = fs * 1.2;
    const w = Math.max(barW, lw + bw);
    const h = lineH + fs * 0.2 + barH;
    return {
      w,
      h,
      draw: (x, y) => {
        font(g, 700, fs);
        spaced(g, 0);
        const lx = x + (w - lw - bw) / 2;
        const base = y + fs * 0.95;
        g.fillStyle = "rgba(255,255,255,0.7)";
        shadowText(g, label, lx, base, fs);
        g.fillStyle = "#fff";
        shadowText(g, value, lx + lw, base, fs);
        const bx = x + (w - barW) / 2;
        const by = y + lineH + fs * 0.2;
        g.fillStyle = "rgba(0,0,0,0.4)";
        roundRect(g, bx, by, barW, barH, barH / 2);
        g.fill();
        g.strokeStyle = "rgba(255,255,255,0.12)";
        g.lineWidth = 1;
        g.stroke();
        g.save();
        roundRect(g, bx, by, barW, barH, barH / 2);
        g.clip();
        g.fillStyle = pct >= 85 ? GAIN : pct >= 65 ? "#ffd24d" : LOSS;
        g.fillRect(bx, by, (barW * pct) / 100, barH);
        g.restore();
      },
    };
  }

  /** Keys overlay: the grid and the three styles of hud.css (.keys, .ks-keycaps / .ks-classic / .ks-minimal). */
  private keys(g: G, bits: number, fs0: number, k: KeysPrefs): Box {
    const classic = k.style === "classic";
    const minimal = k.style === "minimal";
    const fs = classic ? fs0 * 0.72 : fs0;
    const kw = (classic ? 2.6 : minimal ? 2.2 : 3.1) * fs;
    const kh = (classic ? 1.6 : minimal ? 1.7 : 2.5) * fs;
    const mw = (classic ? 1.6 : minimal ? 1.6 : 2.1) * fs;
    const m = 0.12 * fs;
    const mouse = k.rows.mouse;
    const cols = mouse ? [mw, kw, kw, kw, mw] : [kw, kw, kw];
    const colX: number[] = [];
    let acc = 0;
    for (const c of cols) colX.push(acc), (acc += c);
    const W = acc;
    const off = mouse ? 1 : 0;
    const rowH = kh + 2 * m;
    type K = { label: string; bit: number; col: number; span: number; row: number; scale: number };
    const keys: K[] = [];
    if (k.rows.wasd) {
      keys.push({ label: "W", bit: IN_FORWARD, col: off + 1, span: 1, row: 0, scale: 1 });
      keys.push({ label: "A", bit: IN_MOVELEFT, col: off, span: 1, row: 1, scale: 1 });
      keys.push({ label: "S", bit: IN_BACK, col: off + 1, span: 1, row: 1, scale: 1 });
      keys.push({ label: "D", bit: IN_MOVERIGHT, col: off + 2, span: 1, row: 1, scale: 1 });
    }
    if (mouse) {
      keys.push({ label: "◀", bit: TURN_L, col: 0, span: 1, row: 1, scale: 0.85 });
      keys.push({ label: "▶", bit: TURN_R, col: 4, span: 1, row: 1, scale: 0.85 });
    }
    if (k.rows.actions) {
      keys.push({ label: "DUCK", bit: IN_DUCK, col: off, span: 1, row: 2, scale: 0.8 });
      keys.push({ label: "JUMP", bit: IN_JUMP, col: off + 1, span: 2, row: 2, scale: 0.8 });
    }
    const rows = 3;
    return {
      w: W,
      h: rowH * rows,
      draw: (x, y) => {
        g.globalAlpha = k.opacity;
        spaced(g, 0);
        for (const key of keys) {
          const on = (bits & key.bit) !== 0;
          const kx = x + colX[key.col] + m;
          const kwid = cols.slice(key.col, key.col + key.span).reduce((a, b) => a + b, 0) - 2 * m;
          const ky = y + key.row * rowH + m + (on && !classic && !minimal ? 0.1 * fs : 0);
          const lfs = fs * key.scale * (key.scale === 0.8 ? 1 : 1);
          if (!classic && !minimal) {
            // keycaps: rounded key with a bottom lip; pressed keys fill with the pressed colour.
            const r = 0.45 * fs;
            const lip = 0.22 * fs;
            g.fillStyle = on ? k.pressed : "rgba(255,255,255,0.14)";
            roundRect(g, kx, ky, kwid, kh, r);
            g.fill();
            g.fillStyle = on ? k.pressed : "rgba(0,0,0,0.38)";
            roundRect(g, kx + 1, ky + 1, kwid - 2, kh - 1 - lip, Math.max(0, r - 1));
            g.fill();
          }
          const label = classic && !on ? "_" : key.label;
          font(g, classic ? 700 : 800, lfs, classic ? MONO : FONT);
          spaced(g, key.scale === 0.8 ? 0.08 * lfs : 0);
          const tw = g.measureText(label).width;
          const tx = kx + (kwid - tw) / 2;
          const ty = ky + kh / 2 + lfs * 0.36;
          if (!classic && !minimal) {
            g.fillStyle = on ? "#0b0d12" : k.idle;
            g.fillText(label, tx, ty);
          } else {
            g.save();
            if (minimal) g.globalAlpha *= on ? 1 : 0.45;
            g.fillStyle = on ? k.pressed : k.idle;
            shadowText(g, label, tx, ty, lfs);
            g.restore();
          }
        }
      },
    };
  }

  /** Speed graph (hud/graph.ts): last 2 s of horizontal speed with jump marks and gains. */
  private graph(g: G, d: RunData, t: number, e: number): Box {
    const W = 13 * e;
    const H = 3.6 * e;
    const i = Math.max(0, Math.min(d.n, Math.floor(t)));
    const n = Math.max(30, Math.round(d.tickrate * 2));
    const start = Math.max(0, i - n + 1);
    return {
      w: W,
      h: H,
      draw: (x, y) => {
        g.fillStyle = "rgba(0,0,0,0.28)";
        roundRect(g, x, y, W, H, 0.35 * e);
        g.fill();
        g.strokeStyle = "rgba(255,255,255,0.08)";
        g.lineWidth = 1;
        g.stroke();
        let max = 0;
        let min = Infinity;
        for (let k = start; k <= i; k++) (max = Math.max(max, d.speed[k])), (min = Math.min(min, d.speed[k]));
        let lo = Math.max(0, Math.floor((min - 30) / 50) * 50);
        const hi = Math.max(lo + 120, Math.ceil((max + 25) / 50) * 50);
        if (hi - lo < 120) lo = Math.max(0, hi - 120);
        const pad = Math.round(H * 0.3);
        const yOf = (v: number) => y + H - 2 - ((Math.max(lo, v) - lo) / Math.max(1, hi - lo)) * (H - pad - 2);
        const xOf = (k: number) => x + ((k - (i - n + 1)) / (n - 1)) * W;
        const floor = y + H - 1;
        g.save();
        roundRect(g, x, y, W, H, 0.35 * e);
        g.clip();
        if (i - start > 0) {
          g.beginPath();
          for (let k = start; k <= i; k++) (k === start ? g.moveTo(xOf(k), yOf(d.speed[k])) : g.lineTo(xOf(k), yOf(d.speed[k])));
          g.lineTo(xOf(i), floor);
          g.lineTo(xOf(start), floor);
          g.closePath();
          g.fillStyle = "rgba(255,255,255,0.08)";
          g.fill();
          g.beginPath();
          for (let k = start; k <= i; k++) (k === start ? g.moveTo(xOf(k), yOf(d.speed[k])) : g.lineTo(xOf(k), yOf(d.speed[k])));
          g.lineWidth = Math.max(1.5, e * 0.1);
          g.strokeStyle = "rgba(255,255,255,0.92)";
          g.lineJoin = "round";
          g.stroke();
        }
        const fs = Math.max(9, Math.round(H * 0.2));
        font(g, 700, fs);
        g.textAlign = "center";
        g.textBaseline = "top";
        for (let k = start; k <= i; k++) {
          if (!(d.flags[k] & F_JUMPED)) continue;
          const prev = previousJump(d, k);
          const first = prev < 0;
          const gain = first ? 0 : d.speed[k] - d.speed[prev];
          const col = first ? "rgba(255,255,255,0.75)" : gain >= 0 ? GAIN : LOSS;
          const mx = Math.round(xOf(k)) + 0.5;
          g.strokeStyle = col;
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(mx, yOf(d.speed[k]) - 3);
          g.lineTo(mx, floor);
          g.stroke();
          if (!first) {
            g.fillStyle = col;
            g.fillText((gain > 0 ? "+" : "") + Math.round(gain), Math.min(x + W - fs, Math.max(x + fs, mx)), y + 1);
          }
        }
        g.restore();
      },
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Title / outro cards

export interface CardInfo {
  map: string;
  tier: number | null;
  player: string;
  time: number | null;
  style: string;
  track: string;
  date: number;
  jumps: number;
  strafes: number;
  sync: number;
  maxSpeed: number;
  /** Compare line, e.g. "vs WR · Bob  -0.231". */
  compare?: string | null;
  /** Server-backed leaderboard context; absent when a matching record cannot be found. */
  leaderboard?: {
    rank: number;
    total: number;
    points: number | null;
    rows: { rank: number; player: string; time: number; current: boolean }[];
  } | null;
}

/** Brand logo mark (index.html wordmark path) in a 64-unit box. */
function logo(g: G, x: number, y: number, s: number): void {
  g.save();
  g.translate(x, y);
  g.scale(s / 64, s / 64);
  g.strokeStyle = ACCENT;
  g.lineWidth = 5.5;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.beginPath();
  g.moveTo(8, 47);
  g.quadraticCurveTo(14.5, 33, 21, 47);
  g.quadraticCurveTo(29, 25, 37, 47);
  g.quadraticCurveTo(46.5, 15, 56, 47);
  g.stroke();
  g.fillStyle = "#fff";
  g.beginPath();
  g.arc(56, 47, 4.5, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function wordmark(g: G, cx: number, y: number, px: number, alpha: number): void {
  font(g, 800, px);
  spaced(g, -0.035 * px);
  const a = g.measureText("bunnyhop").width;
  const b = g.measureText(".lol").width;
  const lw = px * 1.35;
  const total = lw + px * 0.3 + a + b;
  const x = cx - total / 2;
  g.save();
  g.globalAlpha *= alpha;
  logo(g, x, y - px * 1.05, lw);
  g.textAlign = "left";
  g.fillStyle = "#eef1f6";
  g.fillText("bunnyhop", x + lw + px * 0.3, y);
  g.fillStyle = ACCENT;
  g.fillText(".lol", x + lw + px * 0.3 + a, y);
  g.restore();
}

function center(g: G, s: string, cx: number, y: number, px: number, weight: number, color: string, ls = 0): void {
  font(g, weight, px);
  spaced(g, ls * px);
  g.textAlign = "center";
  g.fillStyle = color;
  g.fillText(s, cx, y);
}

/**
 * Intro title card over the first frame. `t` is seconds into the intro, `len` its length: the card holds, then fades
 * out over the last 0.5 s into the run.
 */
export function drawTitleCard(g: G, w: number, h: number, c: CardInfo, t: number, len: number, branding = true): void {
  if (w < h) {
    drawPortraitCard(g, w, h, c, Math.min(1, Math.max(0, (len - t) / 0.5)) * Math.min(1, t / 0.35), false, branding);
    return;
  }
  const u = h / 1080;
  const fade = Math.min(1, Math.max(0, (len - t) / 0.5));
  const rise = Math.min(1, t / 0.35);
  g.save();
  g.globalAlpha = fade;
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(6,7,11,0.72)");
  grad.addColorStop(0.5, "rgba(6,7,11,0.82)");
  grad.addColorStop(1, "rgba(6,7,11,0.9)");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.globalAlpha = fade * rise;
  const cx = w / 2;
  const dy = (1 - rise) * 18 * u;
  if (branding) wordmark(g, cx, h * 0.2 + dy, 34 * u, 0.95);
  center(g, c.map, cx, h * 0.42 + dy, 96 * u, 800, "#eef1f6", -0.02);
  const sub = [c.track && c.track !== "Main" ? c.track : "", c.style, c.tier ? `Tier ${c.tier}` : ""].filter(Boolean).join("  ·  ");
  center(g, sub.toUpperCase(), cx, h * 0.42 + 64 * u + dy, 26 * u, 800, ACCENT, 0.14);
  center(g, c.time === null ? "DNF" : formatTime(c.time), cx, h * 0.64 + dy, 120 * u, 800, "#fff", -0.02);
  center(g, `by ${c.player}  ·  ${new Date(c.date).toLocaleDateString()}`, cx, h * 0.64 + 66 * u + dy, 28 * u, 600, "rgba(238,241,246,0.75)");
  if (c.compare) center(g, c.compare, cx, h * 0.64 + 112 * u + dy, 24 * u, 700, "#66b3ff");
  g.restore();
}

/** Outro card fading in over the last frame (`t` seconds into the outro). */
export function drawOutroCard(g: G, w: number, h: number, c: CardInfo, t: number, branding = true): void {
  if (w < h) {
    drawPortraitCard(g, w, h, c, Math.min(1, t / 0.45), true, branding);
    return;
  }
  const u = h / 1080;
  const a = Math.min(1, t / 0.45);
  g.save();
  g.globalAlpha = a * 0.86;
  g.fillStyle = "#0b0d12";
  g.fillRect(0, 0, w, h);
  g.globalAlpha = a;
  const cx = w / 2;
  center(g, `${c.map}${c.track && c.track !== "Main" ? "  ·  " + c.track : ""}  ·  ${c.style}`.toUpperCase(), cx, h * 0.27, 26 * u, 800, ACCENT, 0.14);
  center(g, c.time === null ? "DNF" : formatTime(c.time), cx, h * 0.27 + 150 * u, 150 * u, 800, "#fff", -0.02);
  center(g, c.player, cx, h * 0.27 + 210 * u, 34 * u, 700, "rgba(238,241,246,0.85)");
  const stats: [string, string][] = [
    [String(c.jumps), "jumps"],
    [String(c.strafes), "strafes"],
    [`${c.sync.toFixed(1)}%`, "sync"],
    [`${Math.round(c.maxSpeed)}`, "max u/s"],
  ];
  const colW = 220 * u;
  if (!c.leaderboard) stats.forEach(([v, l], i) => {
    const x = cx + (i - (stats.length - 1) / 2) * colW;
    center(g, v, x, h * 0.62, 54 * u, 800, "#fff");
    center(g, l.toUpperCase(), x, h * 0.62 + 36 * u, 18 * u, 700, "rgba(163,171,186,0.95)", 0.12);
  });
  if (c.leaderboard) drawLeaderboard(g, c.leaderboard, cx, h * 0.58, Math.min(w * 0.65, 1000 * u), 30 * u);
  if (c.compare) center(g, c.compare, cx, h * (c.leaderboard ? 0.85 : 0.62) + (c.leaderboard ? 0 : 110 * u), 26 * u, 700, "#66b3ff");
  if (branding) wordmark(g, cx, h - 70 * u, 30 * u, 0.9);
  g.restore();
}

/** Fit and wrap card text, including names without spaces, without horizontal distortion. */
function wrappedCenter(g: G, text: string, cx: number, y: number, width: number, px: number, weight: number, color: string, maxLines = 2): number {
  font(g, weight, px);
  spaced(g, 0);
  const lines: string[] = [];
  let line = "";
  for (const char of text.trim().replace(/\s+/g, " ")) {
    if (line && g.measureText(line + char).width > width) {
      lines.push(line.trim());
      line = char.trimStart();
    } else line += char;
  }
  if (line) lines.push(line.trim());
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last && g.measureText(last + "…").width > width) last = last.slice(0, -1);
    lines[maxLines - 1] = last + "…";
  }
  lines.forEach((line, i) => center(g, line, cx, y + i * px * 1.2, px, weight, color));
  return Math.max(1, lines.length) * px * 1.2;
}

function drawPortraitCard(g: G, w: number, h: number, c: CardInfo, alpha: number, outro: boolean, branding: boolean): void {
  const width = w * 0.64;
  const cx = w / 2;
  const u = w / 1080;
  g.save();
  g.globalAlpha = alpha * 0.88;
  g.fillStyle = "#0b0d12";
  g.fillRect(0, 0, w, h);
  g.globalAlpha = alpha;
  if (branding && !outro) wordmark(g, cx, h * 0.16, 40 * u, 0.95);
  let y = h * (outro && c.leaderboard ? 0.23 : 0.28);
  y += wrappedCenter(g, c.map, cx, y, width, 76 * u, 800, "#eef1f6");
  y += 30 * u;
  const sub = [c.track && c.track !== "Main" ? c.track : "", c.style, c.tier ? `Tier ${c.tier}` : ""].filter(Boolean).join(" · ");
  y += wrappedCenter(g, sub.toUpperCase(), cx, y, width, 30 * u, 800, ACCENT);
  y += 85 * u;
  y += wrappedCenter(g, c.time === null ? "DNF" : formatTime(c.time), cx, y, width, 110 * u, 800, "#fff", 1);
  y += 20 * u;
  y += wrappedCenter(g, outro ? c.player : `by ${c.player}`, cx, y, width, 40 * u, 700, "rgba(238,241,246,0.85)");
  if (outro && c.leaderboard) {
    y += drawLeaderboard(g, c.leaderboard, cx, y + 35 * u, width, 30 * u) + 35 * u;
  } else if (outro) {
    const stats = [[String(c.jumps), "JUMPS"], [String(c.strafes), "STRAFES"], [`${c.sync.toFixed(1)}%`, "SYNC"], [String(Math.round(c.maxSpeed)), "MAX U/S"]];
    const sy = Math.max(y + 60 * u, h * 0.59);
    stats.forEach(([value, label], i) => {
      const x = cx + (i % 2 === 0 ? -1 : 1) * width * 0.25;
      const row = sy + Math.floor(i / 2) * 130 * u;
      wrappedCenter(g, value, x, row, width * 0.46, 52 * u, 800, "#fff", 1);
      center(g, label, x, row + 44 * u, 25 * u, 700, "#a3abba");
    });
    y = sy + 260 * u;
  } else {
    y += wrappedCenter(g, new Date(c.date).toLocaleDateString(), cx, y + 10 * u, width, 28 * u, 600, "#a3abba", 1);
  }
  if (c.compare) wrappedCenter(g, c.compare, cx, Math.min(h * 0.77, y + 35 * u), width, 30 * u, 700, "#66b3ff");
  if (branding && outro) wordmark(g, cx, h * 0.84, 28 * u, 0.75);
  g.restore();
}

/** Hook text above the gameplay HUD; whitespace and length are bounded for exports. */
function drawShortCaption(g: G, w: number, h: number, text: string): void {
  const portrait = w < h;
  const width = w * (portrait ? 0.64 : 0.8);
  const cx = w / 2;
  const px = portrait ? w / 27 : h / 30;
  g.save();
  g.shadowColor = "rgba(0,0,0,0.9)";
  g.shadowBlur = px * 0.25;
  wrappedCenter(g, text.trim().replace(/\s+/g, " ").slice(0, 80), cx, h * 0.085, width, px, 800, "#fff");
  g.restore();
}

/** Small gameplay watermark beneath the portrait HUD and above social navigation. */
export function drawBranding(g: G, w: number, h: number): void {
  g.save();
  g.shadowColor = "rgba(0,0,0,0.85)";
  g.shadowBlur = 4;
  wordmark(g, w / 2, h * (w < h ? 0.82 : 0.94), (w < h ? w / 1080 : h / 1080) * 24, 0.65);
  g.restore();
}

function drawLeaderboard(g: G, board: NonNullable<CardInfo["leaderboard"]>, cx: number, y: number, width: number, px: number): number {
  let height = wrappedCenter(g, `#${board.rank.toLocaleString()} of ${board.total.toLocaleString()} players`, cx, y, width, px * 1.2, 800, ACCENT, 1);
  if (board.points !== null) {
    height += px * 0.2;
    height += wrappedCenter(g, `${board.points.toLocaleString(undefined, { maximumFractionDigits: 2 })} points`, cx, y + height, width, px, 700, "#eef1f6", 1);
  }
  height += px * 0.7;
  board.rows.slice(0, 3).forEach(row => {
    const rowY = y + height;
    g.fillStyle = row.current ? "rgba(255,180,58,0.14)" : "rgba(255,255,255,0.04)";
    roundRect(g, cx - width / 2, rowY - px, width, px * 1.55, px * 0.2);
    g.fill();
    const color = row.current ? ACCENT : "rgba(238,241,246,0.8)";
    wrappedCenter(g, `#${row.rank}`, cx - width * 0.39, rowY, width * 0.18, px * 0.82, 700, color, 1);
    wrappedCenter(g, row.player, cx - width * 0.065, rowY, width * 0.43, px * 0.82, row.current ? 800 : 600, color, 1);
    wrappedCenter(g, formatTime(row.time), cx + width * 0.32, rowY, width * 0.31, px * 0.82, 700, color, 1);
    height += px * 1.85;
  });
  return height;
}
