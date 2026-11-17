// The profile overview's Daily Challenge line (ui/profile.ts): the player's gold, silver and bronze marks, each engraved
// with its count, from the marks they hold (creators.ts dailyMarkOf; apps/api src/daily.ts awards them). Nothing shows
// without a podium.

import "./gauntlets.css";
import "./daily.css";
import { dailyMarkOf, SPECIAL_BADGES, type DailyMetal } from "../creators";
import { h } from "./dom";

const ORDER: readonly DailyMetal[] = ["gold", "silver", "bronze"];

/** The daily mark ids among `special`, gold first. */
export function dailyMarkIds(special: readonly string[] | null | undefined): string[] {
  return ORDER.flatMap((metal) => (special ?? []).filter((id) => dailyMarkOf(id)?.metal === metal).slice(0, 1));
}

export function profileDaily(player: { special?: string[] | null }): HTMLElement {
  const ids = dailyMarkIds(player.special);
  const box = h("section.pf-sec.pfd-sec", { hidden: !ids.length });
  if (!ids.length) return box;
  box.append(
    h("h3", null, "Daily Challenge"),
    h(
      "p.pfd",
      null,
      "Podiums",
      ...ids.map((id) => {
        const b = SPECIAL_BADGES[id];
        return h("span.pfg-medal", { role: "img", "aria-label": b.name, title: b.name, html: `<svg viewBox="0 0 24 24" aria-hidden="true">${b.svg}</svg>` });
      }),
    ),
  );
  return box;
}
