// Profile Overview → "Rank history": the player's overall place over time (osu!-style rank graph) and the best place
// they have held. The server saves everyone's place once a UTC day (GET /players/:id/rank-history, api/src/rank-history.ts;
// days older than 90 keep Mondays only); the live place from the profile is drawn as today's point. Rank 1 is at the
// top, on a log scale. Best and worst places label a left gutter. The plot reuses the Stats screen's chart look (ui/stats-screen.css .st-plot / .st-cursor / .st-axis).

import { api, type Profile, type RankHistory } from "../api";
import { h } from "./dom";

const W = 600;
const H = 100;
/** Room above the best and below the worst place, so the line and its cursor dot aren't clipped. */
const PAD = 6;
const DAY_MS = 86_400_000;

const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const today = () => new Date().toISOString().slice(0, 10);

function fmtDay(d: string): string {
  const t = new Date(dayMs(d));
  const year = t.getUTCFullYear() !== new Date().getUTCFullYear();
  return t.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
}

/** Null when the player has no overall rank (nothing to draw). */
export function profileRankHistory(p: Profile): HTMLElement | null {
  const live = p.rank.rank;
  if (!live) return null;
  const peak = h("small");
  const body = h("div.pf-rh-body", { "aria-busy": "true" });
  const sec = h("section.pf-sec.pf-rh", null, h("h3", null, "Rank history", peak), body);
  // A graph that can't load is no loss worth a line of error text: the section goes.
  api.playerRankHistory(p.player.id).then(
    (res) => draw(res, live),
    () => sec.remove(),
  ).finally(() => body.removeAttribute("aria-busy"));

  function draw(res: RankHistory, liveRank: number): void {
    const now = today();
    const pts = res.days.map((d) => ({ day: d.day, rank: d.rank }));
    // Today's point is the live place (the snapshot was taken at the start of the UTC day).
    if (pts.length && pts[pts.length - 1].day === now) pts[pts.length - 1].rank = liveRank;
    else pts.push({ day: now, rank: liveRank });

    const best = res.peak && res.peak.rank <= liveRank ? res.peak : { rank: liveRank, day: now };
    peak.textContent = `Peak #${best.rank.toLocaleString("en-US")} · ${best.day === now ? "today" : fmtDay(best.day)}`;

    if (pts.length < 2) {
      // Nothing to draw yet: say why on your own profile, and leave it off everyone else's.
      if (!p.mine) return void sec.remove();
      body.replaceChildren(h("p.pf-empty", null, "Ranks are saved once a day. The graph starts after the second day."));
      return;
    }

    const t0 = dayMs(pts[0].day);
    const span = Math.max(DAY_MS, dayMs(pts[pts.length - 1].day) - t0);
    let lo = Infinity;
    let hi = -Infinity;
    for (const q of pts) {
      lo = Math.min(lo, q.rank);
      hi = Math.max(hi, q.rank);
    }
    const x = (d: string) => ((dayMs(d) - t0) / span) * W;
    // Log scale: #400 → #200 takes as much height as #4 → #2, so a climb near the top still shows. A flat line sits in the middle.
    const y = (r: number) => (hi === lo ? H / 2 : PAD + (Math.log(r / lo) / Math.log(hi / lo)) * (H - 2 * PAD));
    const line = pts.map((q, i) => `${i ? "L" : "M"}${x(q.day).toFixed(1)},${y(q.rank).toFixed(1)}`).join("");

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = `<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;

    const tip = h("span.st-cursor-tip");
    const cursor = h("div.st-cursor", { hidden: true }, h("span.st-cursor-dot"), tip);
    const label = `Overall rank over ${pts.length} days: #${pts[0].rank} to #${liveRank}, best #${best.rank}`;
    const plot = h(
      "div.st-plot",
      { role: "img", "aria-label": label },
      svg,
      cursor,
      h("span.st-plot-max", null, `#${lo.toLocaleString("en-US")}`),
      hi !== lo ? h("span.pf-rh-low", null, `#${hi.toLocaleString("en-US")}`) : null,
    );
    plot.addEventListener("pointermove", (e) => {
      const r = plot.getBoundingClientRect();
      const at = t0 + ((e.clientX - r.left) / r.width) * span;
      let q = pts[0];
      for (const c of pts) if (Math.abs(dayMs(c.day) - at) < Math.abs(dayMs(q.day) - at)) q = c;
      cursor.hidden = false;
      cursor.style.setProperty("--x", `${(x(q.day) / W) * 100}%`);
      cursor.style.setProperty("--y", `${(y(q.rank) / H) * 100}%`);
      cursor.classList.toggle("left", x(q.day) > W * 0.8);
      tip.textContent = `${q.day === now ? "Today" : fmtDay(q.day)} · #${q.rank.toLocaleString("en-US")}`;
    });
    plot.addEventListener("pointerleave", () => (cursor.hidden = true));
    body.replaceChildren(h("figure.st-online-chart", null, plot, h("figcaption.st-axis", null, h("span", null, fmtDay(pts[0].day)), h("span", null, "Today"))));
  }

  return sec;
}
