// The profile overview's "Maps by <name>" block (ui/profile.ts): the maps carrying the author names staff linked to this
// player (apps/api src/mappers.ts, Profile.mapper). Nothing shows for anyone who isn't a mapper.

import type { Profile } from "../api";
import { tierName } from "../tiers";
import { h } from "./dom";
import { navigate } from "./nav";

export function profileMapper(p: Profile): HTMLElement | null {
  const m = p.mapper;
  if (!m?.maps.length) return null;
  const maps = m.maps.slice().sort((a, b) => Number(b.ranked) - Number(a.ranked) || (a.tier ?? 99) - (b.tier ?? 99) || a.name.localeCompare(b.name));
  return h(
    "section.pf-sec.pf-mapper",
    null,
    h("h3", null, `Maps by ${m.authors.join(", ")}`, h("small", null, `${maps.length}`)),
    h(
      "div.pf-rows",
      null,
      ...maps.map((x) =>
        h(
          `a.pf-run.pf-mapper-row.t${x.tier ?? "x"}`,
          {
            href: `/maps/${encodeURIComponent(x.name)}`,
            title: `Open ${x.name}`,
            onclick: (ev: Event) => {
              const e = ev as MouseEvent;
              if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button) return;
              e.preventDefault();
              navigate({ screen: "maps", focus: x.name });
            },
          },
          h("span.pf-run-map", null, h("b", null, x.name), x.title && x.title !== x.name ? h("small", null, x.title) : null),
          h("span.pf-run-pts", null, x.tier ? `Tier ${x.tier}, ${tierName(x.tier)}` : "Unrated"),
        ),
      ),
    ),
  );
}
