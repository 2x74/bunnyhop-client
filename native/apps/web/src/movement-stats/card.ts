// The Last jump share card: a 1200x630 PNG drawn on a canvas, in the house style of the server's share cards
// (apps/api src/og/cards.ts: the map's in-engine hero render under a dark wash from the left and the bottom, the
// wordmark, heavy numbers). The distance is the hero, in its tier colour; on the right the jump itself: its arc, side
// on, drawn like the logo's hop arcs, and under it what each strafe gained. All local: nothing is uploaded.
import { styleLabel } from "../styles";
import { ljTier, TIER_COLORS, TIER_NAMES, type LjReport } from "./stats";

export interface JumpResult {
  report: LjReport;
  map: string;
  style: string;
  track: number;
  practice: boolean;
  /** When it landed (ms since epoch). */
  at: number;
}

export const CARD_W = 1200;
export const CARD_H = 630;

const C = { text: "#eef1f6", dim: "#a3abba", faint: "#6f7889", accent: "#ffb43a", bg: "#0b0d12", ink: "#07090d" };
const FONT = `Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
const font = (weight: number, size: number) => `${weight} ${size}px ${FONT}`;

/** Draws the photo to cover the card, blurred and darkened (the og cards' blur / dim). */
function backdrop(x: CanvasRenderingContext2D, img: CanvasImageSource | null): void {
  x.fillStyle = C.bg;
  x.fillRect(0, 0, CARD_W, CARD_H);
  if (img) {
    const w = (img as HTMLImageElement).naturalWidth || (img as HTMLCanvasElement).width;
    const h = (img as HTMLImageElement).naturalHeight || (img as HTMLCanvasElement).height;
    if (w && h) {
      const s = Math.max(CARD_W / w, CARD_H / h) * 1.04;
      x.save();
      x.filter = "blur(3px) saturate(1.1)";
      x.drawImage(img, (CARD_W - w * s) / 2, (CARD_H - h * s) / 2, w * s, h * s);
      x.restore();
      x.fillStyle = "rgba(7, 9, 13, 0.3)";
      x.fillRect(0, 0, CARD_W, CARD_H);
    }
  } else {
    // No photo: the logo's hop arcs, faint, across the card (as the og cards do).
    x.save();
    x.strokeStyle = "rgba(255, 255, 255, 0.045)";
    x.lineWidth = 16;
    x.lineCap = "round";
    x.stroke(new Path2D("M-30 560 Q60 450 150 560 Q290 360 430 560 Q640 240 850 560 Q975 400 1100 560 Q1160 470 1230 560"));
    x.restore();
  }
  // The wash: from the left (text side) and from the bottom.
  const l = x.createLinearGradient(0, 0, CARD_W, 0);
  l.addColorStop(0, "rgba(7, 9, 13, 0.94)");
  l.addColorStop(0.45, "rgba(7, 9, 13, 0.8)");
  l.addColorStop(0.8, "rgba(7, 9, 13, 0.45)");
  l.addColorStop(1, "rgba(7, 9, 13, 0.3)");
  x.fillStyle = l;
  x.fillRect(0, 0, CARD_W, CARD_H);
  const b = x.createLinearGradient(0, 0, 0, CARD_H);
  b.addColorStop(0.5, "rgba(7, 9, 13, 0)");
  b.addColorStop(1, "rgba(7, 9, 13, 0.85)");
  x.fillStyle = b;
  x.fillRect(0, 0, CARD_W, CARD_H);
}

/** The logo (three hop arcs and the landing dot) and "bunnyhop.lol", baseline at y. */
function wordmark(x: CanvasRenderingContext2D, left: number, y: number, size: number): void {
  const mark = size * 1.35, s = mark / 64;
  x.save();
  x.translate(left, y - size * 0.36 - mark / 2 - size * 0.02);
  x.scale(s, s);
  x.strokeStyle = C.accent;
  x.lineWidth = 5.5;
  x.lineCap = "round";
  x.lineJoin = "round";
  x.stroke(new Path2D("M8 47 Q14.5 33 21 47 Q29 25 37 47 Q46.5 15 56 47"));
  x.fillStyle = "#fff";
  x.beginPath();
  x.arc(56, 47, 4.5, 0, Math.PI * 2);
  x.fill();
  x.restore();
  x.font = font(800, size);
  x.letterSpacing = `${-0.035 * size}px`;
  const tx = left + mark + size * 0.3;
  x.fillStyle = C.text;
  x.fillText("bunnyhop", tx, y);
  x.fillStyle = C.accent;
  x.fillText(".lol", tx + x.measureText("bunnyhop").width, y);
  x.letterSpacing = "0px";
}

/** Largest size in [min, max] at which `s` fits `maxW` (canvas font set to it). */
function fit(x: CanvasRenderingContext2D, s: string, weight: number, max: number, min: number, maxW: number): number {
  for (let size = max; size > min; size -= 2) {
    x.font = font(weight, size);
    if (x.measureText(s).width <= maxW) return size;
  }
  x.font = font(weight, min);
  return min;
}

/**
 * The jump, side on: its arc (height exaggerated to fit) from takeoff to landing in the accent, the landing dot, and
 * under the ground line one bar per strafe, as wide as the stretch of the jump it covered and as tall as the speed it
 * gained, with the gain over it and the strafe's sync under it.
 */
function diagram(x: CanvasRenderingContext2D, r: LjReport, box: { x: number; y: number; w: number; h: number }): void {
  const path = r.path;
  if (!path || path.length < 3) return;
  const end = path[path.length - 1].d || 1;
  const top = Math.max(1, ...path.map((p) => p.z));
  // A landed jump meets the ground (a late duck can put the body's arc a little under it); a fail drops through it.
  const zs = path.map((p) => (r.failed ? p.z : Math.max(0, p.z)));
  const ground = box.y + box.h * 0.5;
  const px = (d: number) => box.x + (d / end) * box.w;
  const py = (z: number) => ground - (Math.max(z, -8) / top) * box.h * 0.42;
  // Ground line, takeoff edge and landing edge.
  x.strokeStyle = "rgba(255, 255, 255, 0.22)";
  x.lineWidth = 2;
  x.beginPath();
  x.moveTo(box.x - 18, ground + 0.5);
  x.lineTo(box.x + box.w + 18, ground + 0.5);
  x.stroke();
  // The arc.
  x.save();
  x.strokeStyle = C.accent;
  x.lineWidth = 7;
  x.lineCap = "round";
  x.lineJoin = "round";
  x.shadowColor = "rgba(0, 0, 0, 0.5)";
  x.shadowBlur = 12;
  x.beginPath();
  path.forEach((p, i) => (i ? x.lineTo(px(p.d), py(zs[i])) : x.moveTo(px(p.d), py(zs[i]))));
  x.stroke();
  x.restore();
  x.fillStyle = "#fff";
  x.beginPath();
  x.arc(px(end), py(zs[zs.length - 1]), 8, 0, Math.PI * 2);
  x.fill();
  // Time in the air, over the top of the arc.
  const apex = zs.indexOf(Math.max(...zs));
  x.font = font(650, 21);
  x.fillStyle = C.dim;
  x.textAlign = "center";
  x.fillText(`${r.airtime.toFixed(2)} s`, px(path[apex].d), py(zs[apex]) - 22);
  x.textAlign = "left";

  // Strafes: contiguous to the landing (ticks before the first A / D are the lead-in).
  const strafes = r.strafeStats ?? [];
  if (!strafes.length) return;
  const total = strafes.reduce((n, s) => n + s.ticks, 0);
  let i = Math.max(0, path.length - 1 - total);
  const maxGain = Math.max(8, ...strafes.map((s) => s.gain));
  const base = box.y + box.h, room = box.h * 0.5 - 84;
  const bars = strafes.map((s) => {
    const a = path[Math.min(i, path.length - 1)].d, b = path[Math.min(i + s.ticks, path.length - 1)].d;
    i += s.ticks;
    const left = px(a) + 3, w = Math.max(3, px(b) - px(a) - 6);
    return { s, left, w, hgt: Math.max(3, (s.gain / maxGain) * room), gain: `+${Math.round(s.gain)}`, sync: `${Math.round(s.sync)}%` };
  });
  for (const { s, left, w, hgt } of bars) {
    x.fillStyle = s.side < 0 ? "rgba(255, 255, 255, 0.75)" : C.accent;
    x.globalAlpha = 0.3 + 0.55 * Math.min(1, s.sync / 100);
    x.beginPath();
    x.roundRect(left, base - 26 - hgt, w, hgt, 3);
    x.fill();
  }
  x.globalAlpha = 1;
  // The numbers, a row at a time: gain over the bars, sync under them, each on every bar or on none (many short
  // strafes keep just the bars). A label may slide a few px off a short bar's centre to clear its neighbour.
  const row = (text: (b: (typeof bars)[number]) => string, f: string, gap: number): number[] | null => {
    x.font = f;
    const tw = bars.map((b) => x.measureText(text(b)).width);
    const at: number[] = [];
    bars.forEach((b, k) => at.push(k ? Math.max(b.left + b.w / 2, at[k - 1] + (tw[k] + tw[k - 1]) / 2 + gap) : b.left + b.w / 2));
    return bars.some((b, k) => at[k] - (b.left + b.w / 2) > b.w / 2 + 4) ? null : at;
  };
  x.textAlign = "center";
  const gainAt = row((b) => b.gain, font(800, 17), 8);
  if (gainAt) {
    x.fillStyle = C.text;
    bars.forEach((b, k) => x.fillText(b.gain, gainAt[k], base - 34 - b.hgt));
  }
  const syncAt = gainAt && row((b) => b.sync, font(600, 14), 10);
  if (syncAt) {
    x.fillStyle = C.dim;
    bars.forEach((b, k) => x.fillText(b.sync, syncAt[k], base));
  }
  x.textAlign = "left";
}

const dateText = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** The card. `photo`: the map's hero render (or any frame of it); `player`: the signed-in name, if any. */
export function drawJumpCard(r: JumpResult, o: { photo?: CanvasImageSource | null; player?: string | null } = {}): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = CARD_W;
  c.height = CARD_H;
  const x = c.getContext("2d")!;
  const j = r.report;
  backdrop(x, o.photo ?? null);
  x.textBaseline = "alphabetic";
  wordmark(x, 64, 92, 30);

  // What it was, and its tier word in the tier colour.
  const tier = ljTier(j), color = TIER_COLORS[tier];
  x.font = font(700, 34);
  x.fillStyle = C.text;
  const kind = j.kind === "LJ" ? "Longjump" : "Bhop jump";
  x.fillText(kind, 66, 206);
  if (tier) {
    const kw = x.measureText(kind).width;
    x.font = font(800, 34);
    x.fillStyle = color;
    x.fillText(TIER_NAMES[tier], 66 + kw + 16, 206);
  }

  // The distance.
  const dist = j.distance.toFixed(2);
  const size = fit(x, dist, 800, 184, 120, 600);
  x.letterSpacing = `${-0.03 * size}px`;
  x.fillStyle = color;
  x.save();
  x.shadowColor = "rgba(0, 0, 0, 0.45)";
  x.shadowBlur = 24;
  x.fillText(dist, 58, 206 + size * 0.86);
  x.restore();
  const dw = x.measureText(dist).width;
  x.letterSpacing = "0px";
  x.font = font(650, 30);
  x.fillStyle = C.dim;
  x.fillText("units", 58 + dw + 14, 206 + size * 0.86);

  // The numbers: value heavy, label dim, side by side.
  const cols: [string, string][] = [[`${Math.round(j.pre)}`, "pre"], [`${Math.round(j.max)}`, "max"], [`${j.strafes}`, j.strafes === 1 ? "strafe" : "strafes"], [`${Math.round(j.sync)}%`, "sync"]];
  let cx = 66;
  const sy = 206 + size * 0.86 + 92;
  for (const [n, l] of cols) {
    x.font = font(800, 40);
    x.fillStyle = C.text;
    x.fillText(n, cx, sy);
    const nw = x.measureText(n).width;
    x.font = font(600, 24);
    x.fillStyle = C.dim;
    x.fillText(l, cx + nw + 8, sy);
    cx += nw + 8 + x.measureText(l).width + 34;
  }

  // Who, where, when.
  let mx = 66;
  const my = 566;
  if (o.player) {
    const ps = fit(x, o.player, 800, 30, 22, 300);
    x.fillStyle = C.text;
    x.fillText(o.player, mx, my);
    mx += x.measureText(o.player).width + 22;
    x.font = font(500, 26);
    x.fillStyle = C.dim;
    if (ps) {
      x.fillText("on", mx, my);
      mx += x.measureText("on").width + 12;
    }
  }
  const where = [r.map, r.track ? `Bonus ${r.track}` : "", styleLabel(r.style), r.practice ? "Practice" : "", dateText(r.at)].filter(Boolean);
  where.forEach((t, i) => {
    x.font = i === 0 ? font(700, 26) : font(500, 26);
    x.fillStyle = i === 0 ? C.text : C.dim;
    x.fillText(t, mx, my, 1136 - mx);
    mx += x.measureText(t).width + 24;
  });

  diagram(x, j, { x: 784, y: 150, w: 352, h: 350 });
  return c;
}
