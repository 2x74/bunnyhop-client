// Achievement badge tokens (hatchdle's ringed tokens: bronze / silver / gold / prism by ladder step), drawn as inline
// SVG so they work in the card, the profile grid and the end-of-run toast without assets.

import { achievement, type AchievementDef } from "../progression";
import { h } from "./dom";

export { GLYPHS, textGlyph } from "../badge-glyphs";
import { GLYPHS, textGlyph } from "../badge-glyphs";

export const RING_NAMES = ["Bronze", "Silver", "Gold", "Prism"];

/** A badge token. `got` false = locked (greyed; hidden badges show "?"). */
export function badgeToken(a: AchievementDef, o: { got?: boolean; size?: "sm" | "md" | "lg"; progress?: [number, number] | null } = {}): HTMLElement {
  const got = o.got ?? true;
  const glyph = !got && a.hidden ? textGlyph("?", 12) : (GLYPHS[a.icon] ?? GLYPHS.flag);
  const tierCls = /^t[1-7]$/.test(a.icon) ? `.${a.icon}` : "";
  // A hidden badge says nothing about itself until it's earned.
  const secret = !got && !!a.hidden;
  const el = h(`span.tk.r${a.ring}${got ? ".got" : ""}${tierCls}.tk-${o.size ?? "md"}`, {
    role: "img",
    "aria-label": secret ? "??? (locked)" : `${a.name}${got ? "" : " (locked)"}`,
    title: secret ? "???" : `${a.name} — ${a.desc}${got ? "" : o.progress ? ` (${fmtN(o.progress[0])}/${fmtN(o.progress[1])})` : " (locked)"}`,
    html: `<svg viewBox="0 0 24 24" aria-hidden="true">${glyph}</svg>`,
  });
  if (!got && o.progress && o.progress[1] > 1) {
    const f = Math.max(0, Math.min(1, o.progress[0] / o.progress[1]));
    el.append(h("span.tk-prog", { style: `--f:${f}` }));
  }
  return el;
}

export function badgeById(id: string, o: Parameters<typeof badgeToken>[1] = {}): HTMLElement | null {
  const a = achievement(id);
  return a ? badgeToken(a, o) : null;
}

/** Token + name chip (card badge row, end-card unlock toast). */
export function badgeChip(id: string): HTMLElement | null {
  const a = achievement(id);
  if (!a) return null;
  return h("span.badge-chip", { title: a.desc }, badgeToken(a, { size: "sm" }), h("span", null, a.name));
}

function fmtN(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en-US");
}
