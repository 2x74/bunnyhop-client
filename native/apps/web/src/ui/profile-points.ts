// Profile Overview → "Top points": the records giving the player the most points on the overall board or one style's
// (GET /players/:id/points, read when the section is drawn and per scope switch; the profile starts the overall one with
// its own read, ui/profile.ts). Points is what the record scores on that board; Max is what the board's WR scores
// there (the most the map gives); Counted is what it adds to the total after the per-place weighting (ranking.ts
// weightedTotal). The first ten show; Show more scrolls on down the list (osu-style top plays) to the top 100.
// Rows reuse the run-row look (ui/profile.css .pf-run): tier edge, map, place, numbers.

import { api, type PointsPage, type PointsRecord, type Profile } from "../api";
import { fmtPoints, RECORD_WEIGHTING } from "../ranking";
import { styleLabel } from "../styles";
import { trackName } from "../zones";
import { h } from "./dom";
import { navigate } from "./nav";
import { placeLabel } from "./profile";

/** Rows per Show more. */
const MORE = 20;

/** `early`: the overall ("all") read, already started; taken only if the section opens on Overall. */
export function topPoints(p: Profile, early?: Promise<PointsPage>): HTMLElement | null {
  const styleScopes = p.styles.filter((s) => s.rank && s.points > 0).sort((x, y) => y.points - x.points).map((s) => s.scope);
  // Overall only when it has points: a player with only Auto-strafe-style records still gets their style breakdown.
  const scopes = [...(p.rank.points ? ["all"] : []), ...styleScopes];
  if (!scopes.length) return null;
  let scope = scopes[0];
  const seg = h("div.pf-seg", { role: "group", "aria-label": "Rank board" });
  const list = h("div.pf-rows");
  const more = h("button.link-btn.pf-pts-more", { type: "button", hidden: true, onclick: () => load(scope, true) }, "Show more");
  let shown = 0;
  const drawSeg = () =>
    seg.replaceChildren(
      ...scopes.map((s) => h(`button${s === scope ? ".on" : ""}`, { type: "button", "aria-pressed": String(s === scope), onclick: () => load(s) }, s === "all" ? "Overall" : styleLabel(s))),
    );
  const row = (r: PointsRecord) => {
    const tags = [r.track ? trackName(r.track) : null, scope === "all" ? styleLabel(r.style) : null].filter(Boolean).join(", ");
    const max = r.wr ?? null;
    return h(
      `div.pf-run.pf-pts-row.t${r.tier}`,
      null,
      h(
        "span.pf-run-map",
        null,
        h("button.link-btn", { type: "button", onclick: () => navigate({ screen: "maps", focus: r.map }), title: `Open ${r.map}` }, r.map),
        tags ? h("small", null, tags) : null,
      ),
      h("span.pf-run-place", null, r.rank === 1 ? h("span.place.wr-word", null, "WR") : placeLabel(r)),
      h("span.pf-run-pts", null, fmtPoints(r.points)),
      h("span.pf-run-pts.pf-pts-max", null, max === null ? "" : fmtPoints(max)),
      h("span.pf-run-pts.pf-pts-counted", null, fmtPoints(r.counted)),
    );
  };
  const head = () =>
    h(
      "div.pf-run.pf-pts-row.pf-run-head",
      { "aria-hidden": "true" },
      h("span", null, "Map"),
      h("span.pf-run-place", null, "Place"),
      h("span.pf-run-pts", null, "Points"),
      h("span.pf-run-pts", { title: "What the world record on that board scores" }, "Max"),
      h("span.pf-run-pts", { title: `Your records count best first, each ${+((1 - RECORD_WEIGHTING) * 100).toFixed(1)}% less than the one before it in your own list (not your place on the map)` }, "Counted"),
    );
  let seq = 0;
  function load(s: string, append = false): void {
    if (!append) {
      scope = s;
      shown = 0;
      drawSeg();
    }
    const mine = ++seq;
    list.setAttribute("aria-busy", "true");
    more.disabled = true;
    const read = !append && early && s === "all" ? early : api.playerPoints(p.player.id, s, append ? { offset: shown, limit: MORE } : {});
    early = undefined;
    read.then(
      (res) => {
        if (mine !== seq) return;
        if (append) list.append(...res.records.map(row));
        else list.replaceChildren(...(res.records.length ? [head(), ...res.records.map(row)] : [h("p.pf-empty", null, "No points yet.")]));
        shown += res.records.length;
        more.hidden = !res.more;
      },
      () => {
        if (mine !== seq) return;
        if (!append) list.replaceChildren(h("p.pf-empty", null, "Couldn't load points."));
      },
    ).finally(() => {
      if (mine !== seq) return;
      list.removeAttribute("aria-busy");
      more.disabled = false;
    });
  }
  load(scope);
  return h("section.pf-sec.pf-pts", null, h("h3", null, "Top points"), scopes.length > 1 ? seg : null, list, more);
}
