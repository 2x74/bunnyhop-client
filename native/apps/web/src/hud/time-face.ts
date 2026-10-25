// The HUD's timer digits: "00:31.420" with the leading "00:" quiet (hud.css .t-lead), shared by the live HUD (hud.ts),
// the replay viewer's HUD (viewer/hud.ts) and the MP4 export (viewer/canvas-hud.ts draws the same split).

import { h } from "../ui/dom";

/** Index where the significant part of a formatted time begins: "00:31.420" -> 3, "01:02.500" -> 1, "-00:..." -> 0. */
export function leadLength(s: string): number {
  if (!/^\d+:\d\d\.\d{3}$/.test(s)) return 0;
  let i = 0;
  while (s[i] === "0") i++;
  // "00:" goes quiet as a whole; with a minute digit only the zeros before it do.
  return s[i] === ":" ? i + 1 : i;
}

/** [quiet lead, the rest] of a formatted time. */
export function splitLead(s: string): [string, string] {
  const i = leadLength(s);
  return [s.slice(0, i), s.slice(i)];
}

/** Two text nodes; writes only what changed (the lead changes once a minute at most). */
export class TimeFace {
  readonly lead = document.createTextNode("");
  readonly rest = document.createTextNode("");
  readonly el = h("span.time-text", null, h("span.t-lead", null, this.lead), h("span.t-rest", null, this.rest));
  private shown = "";

  set(s: string): void {
    if (s === this.shown) return;
    this.shown = s;
    const [a, b] = splitLead(s);
    if (a !== this.lead.data) this.lead.data = a;
    if (b !== this.rest.data) this.rest.data = b;
  }

  get text(): string {
    return this.shown;
  }
}

/** Compact signed delta: +0.231, -1.020, +1:02.500 (the one delta format: HUD split, end of run, split fallback toast). */
export function formatDelta(seconds: number): string {
  const sign = seconds < 0 ? "-" : "+";
  const ms = Math.round(Math.abs(seconds) * 1000);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const frac = String(ms % 1000).padStart(3, "0");
  return m > 0 ? `${sign}${m}:${String(s).padStart(2, "0")}.${frac}` : `${sign}${s}.${frac}`;
}
