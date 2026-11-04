// The profile overview's Gauntlets block (ui/profile.ts): the player's gauntlet PBs (Gauntlet, Rank, Time, Date) and
// one line with their weekly podiums: the gold, silver and bronze marks, each engraved with its count. Fetched on its own (GET /players/:id/gauntlets, started with the profile's read:
// `early`); nothing shows without a finish.

import "./gauntlets.css";
import { api, type PlayerGauntlets } from "../api";
import { gauntletPath, gauntletTime } from "../gauntlet/state";
import { watchPath } from "../gauntlet/watch";
import { fullDate, relDate } from "./board-pager";
import { h } from "./dom";
import { navigate } from "./nav";
import { SPECIAL_BADGES, weeklyMarkId, type WeeklyMedal } from "../creators";

const MEDAL_OF: Record<number, WeeklyMedal> = { 1: "winner", 2: "second", 3: "third" };

/** The weekly podium mark ids for these results (creators.ts weeklyMarkId), gold first; none without a podium. */
export function podiumIds(results: readonly { rank: number }[]): string[] {
  return ([1, 2, 3] as const).flatMap((rank) => {
    const n = results.filter((r) => r.rank === rank).length;
    return n ? [weeklyMarkId(MEDAL_OF[rank], n)] : [];
  });
}

const podiumMarks = (results: readonly { rank: number }[]): HTMLElement[] =>
  podiumIds(results).map((id) => {
    const b = SPECIAL_BADGES[id];
    return h("span.pfg-medal", { role: "img", "aria-label": b.name, title: b.name, html: `<svg viewBox="0 0 24 24" aria-hidden="true">${b.svg}</svg>` });
  });

export function profileGauntlets(id: string, early?: Promise<PlayerGauntlets>): HTMLElement {
  const box = h("section.pf-sec.pfg", { hidden: true });
  if (!api.available()) return box;
  void (early ?? api.playerGauntlets(id)).then(
    (g) => {
      if (!g.pbs.length) return;
      const iso = (ms: number) => new Date(ms).toISOString();
      const open = (e: Event, slug: string) => {
        const m = e as MouseEvent;
        if (m.ctrlKey || m.metaKey || m.shiftKey || m.altKey || m.button) return;
        e.preventDefault();
        navigate({ screen: "gauntlet", slug });
      };
      const medals = podiumMarks(g.weeklyWins);
      box.replaceChildren(
        h("h3", null, "Gauntlets"),
        h(
          "table.pfg-table",
          null,
          h("thead", null, h("tr", null, h("th", { scope: "col" }, "Gauntlet"), h("th.num", { scope: "col" }, "Rank"), h("th.num", { scope: "col" }, "Time"), h("th.num", { scope: "col" }, "Date"), h("th", { scope: "col" }, h("span.sr-only", null, "Watch")))),
          h(
            "tbody",
            null,
            ...g.pbs.slice(0, 8).map((p) =>
              h(
                "tr",
                null,
                h("td", null, h("a.gx-title-link", { href: gauntletPath(p.slug), onclick: (e: Event) => open(e, p.slug) }, p.title)),
                h("td.num", { title: `of ${p.of.toLocaleString("en-US")}` }, `#${p.rank}`),
                h("td.num.pfg-time", null, gauntletTime(p.time)),
                h("td.num.dim", { title: fullDate(iso(p.at)) }, relDate(iso(p.at))),
                h("td.pfg-watch", null, p.attemptId ? h("a.gx-watch", { href: watchPath(p.slug, p.attemptId) }, "Watch") : ""),
              ),
            ),
          ),
        ),
        medals.length ? h("p.pfg-wins", null, "Weekly podiums", ...medals) : "",
      );
      box.hidden = false;
    },
    () => {},
  );
  return box;
}
