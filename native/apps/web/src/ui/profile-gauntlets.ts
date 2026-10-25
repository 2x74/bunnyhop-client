// The profile overview's Gauntlets block (ui/profile.ts): the player's gauntlet PBs (Gauntlet, Rank, Time, Date) and
// one line with their weekly wins. Fetched on its own (GET /players/:id/gauntlets, started with the profile's read:
// `early`); nothing shows without a finish.

import "./gauntlets.css";
import { api, type PlayerGauntlets } from "../api";
import { gauntletPath, gauntletTime } from "../gauntlet/state";
import { watchPath } from "../gauntlet/watch";
import { fullDate, relDate } from "./board-pager";
import { h } from "./dom";
import { navigate } from "./nav";

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
      const wins = g.weeklyWins.filter((w) => w.rank === 1).length;
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
        wins ? h("p.pfg-wins", null, `Weekly wins: ${wins}`) : "",
      );
      box.hidden = false;
    },
    () => {},
  );
  return box;
}
