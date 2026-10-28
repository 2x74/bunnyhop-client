// Profile Overview → "Top points": the records giving the player the most points on the overall board or one style's
// (GET /players/:id/points, read when the section is drawn and per scope switch; the profile starts the overall one with
// its own read, ui/profile.ts). Points is what the record scores on
// that board; Counted is what it adds to the total after the per-place weighting (ranking.ts weightedTotal).
// Rows reuse the run-row look (ui/profile.css .pf-run): tier edge, map, place, numbers.

import { api, type PointsRecord, type Profile } from "../api";
import { fmtPoints } from "../ranking";
import { styleLabel } from "../styles";
import { trackName } from "../zones";
import { h } from "./dom";
import { navigate } from "./nav";
import { placeLabel } from "./profile";

/** `early`: the overall ("all") read, already started; taken only if the section opens on Overall. */
export function topPoints(p: Profile, early?: Promise<{ scope: string; records: PointsRecord[] }>): HTMLElement | null {
  const styleScopes = p.styles.filter((s) => s.rank && s.points > 0).sort((x, y) => y.points - x.points).map((s) => s.scope);
  // Overall only when it has points: a player with only Auto-strafe-style records still gets their style breakdown.
  const scopes = [...(p.rank.points ? ["all"] : []), ...styleScopes];
  if (!scopes.length) return null;
  let scope = scopes[0];
  const seg = h("div.pf-seg", { role: "group", "aria-label": "Rank board" });
  const list = h("div.pf-rows");
  const drawSeg = () =>
    seg.replaceChildren(
      ...scopes.map((s) => h(`button${s === scope ? ".on" : ""}`, { type: "button", "aria-pressed": String(s === scope), onclick: () => load(s) }, s === "all" ? "Overall" : styleLabel(s))),
    );
  const row = (r: PointsRecord) => {
    const tags = [r.track ? trackName(r.track) : null, scope === "all" ? styleLabel(r.style) : null].filter(Boolean).join(", ");
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
      h("span.pf-run-pts.pf-pts-counted", null, fmtPoints(r.counted)),
    );
  };
  let seq = 0;
  function load(s: string): void {
    scope = s;
    drawSeg();
    const mine = ++seq;
    list.setAttribute("aria-busy", "true");
    const read = early && s === "all" ? early : api.playerPoints(p.player.id, s);
    early = undefined;
    read.then(
      (res) => {
        if (mine !== seq) return;
        list.replaceChildren(
          ...(res.records.length
            ? [h("div.pf-run.pf-pts-row.pf-run-head", { "aria-hidden": "true" }, h("span", null, "Map"), h("span.pf-run-place", null, "Place"), h("span.pf-run-pts", null, "Points"), h("span.pf-run-pts", { title: "Each record counts 2.5% less than the one before it" }, "Counted")), ...res.records.map(row)]
            : [h("p.pf-empty", null, "No points yet.")]),
        );
      },
      () => mine === seq && list.replaceChildren(h("p.pf-empty", null, "Couldn't load points.")),
    ).finally(() => mine === seq && list.removeAttribute("aria-busy"));
  }
  load(scope);
  return h(
    "section.pf-sec.pf-pts",
    null,
    h("h3", null, "Top points"),
    scopes.length > 1 ? seg : null,
    list,
  );
}
