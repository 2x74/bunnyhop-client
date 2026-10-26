import type { HexGlowColor } from "../player/glow-config";
export interface HsvColor { h: number; s: number; v: number }
const clamp = (n: number) => Math.max(0, Math.min(1, n));
/** UI shorthand expands before the API sees it. */
export function pickerHex(value: string): HexGlowColor | null {
  const raw = value.trim().replace(/^#/, "");
  if (/^[\da-f]{3}$/i.test(raw)) return `#${raw.split("").map(c => c + c).join("").toLowerCase()}`;
  return /^[\da-f]{6}$/i.test(raw) ? `#${raw.toLowerCase()}` : null;
}
export function hexToHsv(hex: HexGlowColor): HsvColor {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let h = 0;
  if (delta) h = 60 * (max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4);
  return { h: (h + 360) % 360, s: max ? delta / max : 0, v: max };
}
export function hsvToHex({ h, s, v }: HsvColor): HexGlowColor {
  h = ((h % 360) + 360) % 360; s = clamp(s); v = clamp(v);
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${rgb.map(n => Math.round((n + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}
