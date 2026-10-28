// Pulse: how the game is doing. Runs per hour, verify latency, players in rooms, feedback and flags per day, the live
// rooms, two rows of facts (people, activity) and, for admins, what the Worker's database did today (Cloudflare's
// analytics; GET /admin/costs answers {available: false} until its token is set). Polls once a minute while visible;
// the charts every five minutes.

import { api, clock, compact, dayName, dur, fmtMs, glyph, h, may, n, plural, poll, when, type ServerRow, type View, fill } from "./core";
import { odometer, setOdometer } from "./ui";
import { columns, line, progress, slots } from "./charts";
import { mapArt, tierTag } from "./art";

interface Overview {
  sitePresence?: { total: number; desktop: number; browser: number; unknown: number; windowMs: number; pingMs: number } | null;
  players: { players: number; registered: number };
  active: { m5: number; m15: number; m60: number };
  today: { runs: number; verified: number; rejected: number };
  queue: { queued: number | null; verifying: number | null; rejected: number | null; error?: number | null; stuck?: number | null; deadLettered?: number | null };
  chat: { chat24h: number };
  moderation: { actions24h: number };
  bans: { bans: number };
  feedback?: { new: number | null; waiting?: number | null; day: number | null };
  integrity?: { open: number | null; blatant: number | null; players: number | null };
  online: number;
  rooms: ServerRow[];
}

interface SeriesData {
  now: number;
  hourStart: number;
  dayStart: number;
  runs: { total: number[]; verified: number[]; rejected: number[] };
  latency: { p50: (number | null)[]; p90: (number | null)[]; n: number; dayP50: number | null; dayP90: number | null };
  chat: number[];
  feedback: number[];
  flags: { suspicious: number[]; blatant: number[] };
  online: [number, number][];
}

interface Costs {
  available: boolean;
  failed?: boolean;
  day?: string;
  rowsRead?: number;
  rowsWritten?: number;
  readQueries?: number;
  writeQueries?: number;
  at?: number;
}

interface Stat {
  key: string;
  label: string;
  value: number | null | undefined;
  foot?: string;
  to?: string;
  tone?: "hot" | "bad" | "";
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

/** A figure: a rolling number with its label beside it and a quiet line under it. Links open the section it counts. */
export function figEl(s: Stat, cls = ""): { el: HTMLElement; set: (s: Stat) => void } {
  const val = odometer(typeof s.value === "number" ? s.value : 0);
  val.classList.add("fig-v");
  const label = h("span", { class: "fig-l" }, s.label);
  const foot = h("span", { class: "fig-f" });
  const body = [h("span", { class: "fig-top" }, val, label), foot];
  const el = s.to ? h("a", { class: `fig ${cls}`, href: s.to }, body, h("span", { class: "fig-go" }, glyph("arrow"))) : h("div", { class: `fig ${cls}` }, body);
  const set = (x: Stat) => {
    const v = typeof x.value === "number" ? x.value : 0;
    setOdometer(val, v);
    label.textContent = x.label;
    foot.textContent = x.foot ?? "";
    el.classList.toggle("hot", x.tone === "hot");
    el.classList.toggle("bad", x.tone === "bad");
    el.classList.toggle("zero", !x.tone && v === 0);
  };
  set(s);
  return { el, set };
}

function metric(title: string, icon: string, value: HTMLElement, sub: string, chart: HTMLElement, to?: string): HTMLElement {
  return h("section", { class: "metric" }, h("h3", { class: "metric-t" }, glyph(icon), to ? h("a", { href: to }, title) : title), h("div", { class: "metric-v" }, value, h("span", { class: "metric-s" }, sub)), chart);
}

export function roomsList(list: ServerRow[]): HTMLElement {
  if (!list.length) return h("p", { class: "empty-line" }, "No rooms configured.");
  return h(
    "div",
    { class: "rooms-list" },
    list.map((r) => {
      const limit = (r.timeLimitMinutes ?? 0) * 60_000;
      return h(
        "a",
        { class: `room-row${r.online ? "" : " offline"}`, href: "#/rooms" },
        h("div", { class: "rr-name" }, h("b", null, r.name), h("small", null, `${r.id}, ${r.region}`)),
        h("div", { class: "rr-players" }, slots(r.players, r.maxPlayers), h("span", null, h("b", null, r.players), h("span", { class: "faint" }, ` / ${r.maxPlayers}`))),
        h("div", { class: "rr-map" }, r.map ? [mapArt(r.map), h("span", null, r.map), tierTag(r.tier)] : r.changing ? `changing to ${r.changing}` : "—"),
        h("div", { class: "rr-time" }, h("span", null, r.timeLeftMs !== null ? `${dur(r.timeLeftMs)} left` : r.online ? "—" : "offline"), r.timeLeftMs !== null && limit ? progress(1 - r.timeLeftMs / limit) : null),
        h("span", { class: "rr-go" }, glyph("chevron")),
      );
    }),
  );
}

function seriesCharts(sr: SeriesData, o: Overview, intro: boolean): { runs: HTMLElement; grid: HTMLElement } {
  const H = sr.runs.total.length;
  const hourAt = (i: number) => sr.hourStart + i * HOUR_MS;
  const other = sr.runs.total.map((t, i) => Math.max(0, t - sr.runs.verified[i] - sr.runs.rejected[i]));
  const hourTicks: [number, string][] = [0, 6, 12, 18].map((i) => [i, clock(hourAt(i))] as [number, string]).concat([[H - 1, "now"]]);
  const total = sum(sr.runs.total);
  const verified = sum(sr.runs.verified);
  const runs = h(
    "section",
    { class: "hero" },
    h(
      "div",
      { class: "hero-head" },
      h("h2", null, "Runs, last 24 hours"),
      h("span", { class: "legend" }, h("i", { class: "k c-ink" }), "verified", h("i", { class: "k c-dim" }), "waiting or error", h("i", { class: "k c-red" }), "rejected"),
      h("span", { class: "hero-sum" }, h("b", null, n(total)), total ? ` runs, ${Math.round((verified / total) * 100)}% verified` : " runs"),
    ),
    columns({
      label: `Runs per hour, last 24 hours: ${n(total)}, ${n(sum(sr.runs.rejected))} rejected.`,
      height: 168,
      intro,
      hot: H - 1,
      ticks: hourTicks,
      series: [
        { values: sr.runs.verified, cls: "c-ink", label: "verified" },
        { values: other, cls: "c-dim", label: "waiting or error" },
        { values: sr.runs.rejected, cls: "c-red", label: "rejected" },
      ],
      tip: (i) => `${clock(hourAt(i))}–${clock(hourAt(i + 1))}  ${plural(sr.runs.total[i], "run")}: ${n(sr.runs.verified[i])} verified, ${n(sr.runs.rejected[i])} rejected${other[i] ? `, ${n(other[i])} other` : ""}`,
    }),
  );
  const t0 = sr.now - 24 * HOUR_MS;
  const on = sr.online;
  const peak = on.length ? Math.max(...on.map((x) => x[1])) : 0;
  const onlineChart = on.length
    ? line({ label: `Players in rooms, last 24 hours, peak ${peak}.`, height: 76, intro, area: true, values: on.map((x) => x[1]), xs: on.map((x) => Math.max(0, Math.min(1, (x[0] - t0) / (24 * HOUR_MS)))), tip: (i) => `${clock(on[i][0])}  ${plural(on[i][1], "player")}` })
    : h("p", { class: "metric-empty" }, "No samples yet.");
  const lat = sr.latency;
  const latChart = lat.n
    ? line({ label: `Verify latency per hour, median ${fmtMs(lat.dayP50)}, 90th percentile ${fmtMs(lat.dayP90)}.`, height: 76, intro, values: lat.p50, band: lat.p90, fmt: fmtMs, tip: (i) => `${clock(hourAt(i))}  median ${fmtMs(lat.p50[i])}, p90 ${fmtMs(lat.p90[i])}` })
    : h("p", { class: "metric-empty" }, "No verdicts in 24 hours.");
  const D = sr.feedback.length;
  const dayAt = (i: number) => sr.dayStart + i * DAY_MS;
  const fbChart = columns({ label: `Feedback per day, last 14 days: ${n(sum(sr.feedback))}.`, height: 76, intro, hot: D - 1, series: [{ values: sr.feedback, cls: "c-ink", label: "reports" }], tip: (i) => `${i === D - 1 ? "Today" : dayName(dayAt(i))}  ${plural(sr.feedback[i], "report")}` });
  const flagChart = columns({
    label: `Runs flagged per day, last 14 days.`,
    height: 76,
    intro,
    hot: D - 1,
    series: [
      { values: sr.flags.suspicious, cls: "c-ink", label: "suspicious" },
      { values: sr.flags.blatant, cls: "c-red", label: "blatant" },
    ],
    tip: (i) => `${i === D - 1 ? "Today" : dayName(dayAt(i))}  ${n(sr.flags.suspicious[i])} suspicious, ${n(sr.flags.blatant[i])} blatant`,
  });
  const big = (v: string) => h("span", { class: "metric-n" }, v);
  const grid = h(
    "div",
    { class: "metrics" },
    metric("Players in rooms", "rooms", big(n(o.online)), peak ? `now, peak ${peak} today` : "now", onlineChart, may("rooms.read") ? "#/rooms" : undefined),
    metric("Verify latency", "clock", big(fmtMs(lat.dayP50)), lat.n ? `median, p90 ${fmtMs(lat.dayP90)}` : "median", latChart, may("runs.read") ? "#/runs" : undefined),
    metric("Feedback", "feedback", big(n(sum(sr.feedback))), `in 14 days, ${n(sr.feedback[D - 1] ?? 0)} today`, fbChart, may("feedback.read") ? "#/feedback" : undefined),
    metric("Flagged runs", "flag", big(n(sum(sr.flags.suspicious) + sum(sr.flags.blatant))), `in 14 days, ${n(sum(sr.flags.blatant))} blatant`, flagChart, may("integrity.read") ? "#/suspicious" : undefined),
  );
  return { runs, grid };
}

export const pulseView: View = async (root) => {
  const [first, firstSeries, firstCosts] = await Promise.all([
    api<Overview>("/admin/overview"),
    api<SeriesData>("/admin/overview/series").catch(() => null),
    may("costs.read") ? api<Costs>("/admin/costs").catch(() => null) : Promise.resolve(null),
  ]);
  const figs = new Map<string, { el: HTMLElement; set: (s: Stat) => void }>();
  const updated = h("span", { class: "sub" });
  const peopleRow = h("div", { class: "figs figs-small" });
  const activityRow = h("div", { class: "figs figs-small" });
  const costsRow = h("div", { class: "figs figs-small" });
  const runsSlot = h("div");
  const gridSlot = h("div");
  const roomsSlot = h("div");
  const roomsSub = h("small");
  let latest = first;

  const people = (o: Overview): Stat[] => [
    { key: "m5", label: "seen in 5 min", value: o.active.m5, foot: `${n(o.active.m15)} in 15 min, ${n(o.active.m60)} in the hour` },
    { key: "online", label: "in rooms", value: o.online, foot: `${o.rooms.filter((r) => r.online).length} of ${o.rooms.length} rooms up`, to: may("rooms.read") ? "#/rooms" : undefined },
    { key: "players", label: "players", value: o.players.players, foot: `${n(o.players.registered)} signed in`, to: "#/players" },
    { key: "desktop", label: "desktop app windows", value: o.sitePresence?.desktop, foot: o.sitePresence ? `of ${n(o.sitePresence.total)} open windows` : "not reported" },
  ];
  const activity = (o: Overview): Stat[] => [
    { key: "runs", label: "runs today", value: o.today.runs, foot: `${n(o.today.verified)} verified, ${n(o.today.rejected)} rejected`, to: may("runs.read") ? "#/runs" : undefined },
    { key: "queue", label: "verifying", value: (o.queue.queued ?? 0) + (o.queue.verifying ?? 0), foot: o.queue.error ? `${n(o.queue.error)} failed` : "none failed", tone: (o.queue.stuck ?? 0) > 0 || (o.queue.error ?? 0) > 0 ? "bad" : "", to: may("runs.manage") ? "#/runs?status=queued" : undefined },
    { key: "chat", label: "chat lines today", value: o.chat.chat24h, foot: "in 24 hours", to: may("chat.read") ? "#/chat" : undefined },
    { key: "mod", label: "staff actions", value: o.moderation.actions24h, foot: `${n(o.bans.bans)} bans active`, to: "#/log" },
  ];

  const paintCosts = (c: Costs | null) => {
    costsRow.hidden = !may("costs.read");
    if (!may("costs.read")) return;
    // Without the analytics token (or when Cloudflare doesn't answer) the slot says so quietly, with no numbers.
    if (!c?.available) {
      fill(costsRow, h("div", { class: "fig small off" }, h("span", { class: "fig-top" }, h("span", { class: "fig-v fig-text" }, "—"), h("span", { class: "fig-l" }, "database rows today")), h("span", { class: "fig-f" }, c?.failed ? "Cloudflare didn't answer" : "Not connected")));
      return;
    }
    if (costsRow.querySelector(".off")) costsRow.replaceChildren();
    const set = (s: Stat) => {
      const f = figs.get(s.key);
      if (f) f.set(s);
      else {
        const made = figEl(s, "small");
        figs.set(s.key, made);
        costsRow.append(made.el);
      }
    };
    set({ key: "d1r", label: "database rows read today", value: c.rowsRead, foot: `${compact(c.readQueries ?? 0)} queries, UTC day` });
    set({ key: "d1w", label: "rows written today", value: c.rowsWritten, foot: `${compact(c.writeQueries ?? 0)} queries` });
  };

  const paint = (o: Overview) => {
    for (const [row, list] of [
      [peopleRow, people(o)],
      [activityRow, activity(o)],
    ] as const) {
      for (const x of list) {
        const f = figs.get(x.key);
        if (f) f.set(x);
        else {
          const made = figEl(x, "small");
          figs.set(x.key, made);
          row.append(made.el);
        }
      }
    }
    updated.textContent = `Updated ${when(Date.now()).slice(11, 16)}`;
    roomsSub.textContent = `${o.rooms.filter((r) => r.online).length} of ${o.rooms.length} up, ${plural(o.online, "player")}`;
    fill(roomsSlot, roomsList(o.rooms));
  };
  const drawSeries = (sr: SeriesData | null, intro: boolean) => {
    if (!sr) return void (runsSlot.replaceChildren(), gridSlot.replaceChildren());
    const c = seriesCharts(sr, latest, intro);
    fill(runsSlot, c.runs);
    fill(gridSlot, c.grid);
  };

  fill(root, 
    h("div", { class: "view-bar" }, updated),
    runsSlot,
    gridSlot,
    h("section", { class: "facts" }, h("h2", { class: "section-title" }, "People"), peopleRow, h("h2", { class: "section-title" }, "Activity"), activityRow, may("costs.read") ? [h("h2", { class: "section-title" }, "Costs"), costsRow] : null),
    h("section", { class: "rooms-sec" }, h("h2", { class: "section-title" }, may("rooms.read") ? h("a", { href: "#/rooms" }, "Rooms") : "Rooms", roomsSub), roomsSlot),
  );
  paint(first);
  paintCosts(firstCosts);
  drawSeries(firstSeries, true);
  let tick = 0;
  // Once a minute while the tab is visible (the totals are the cron's counters; the rest is indexed).
  return poll(async () => {
    tick++;
    latest = await api<Overview>("/admin/overview");
    paint(latest);
    if (tick % 5 === 0) {
      drawSeries(await api<SeriesData>("/admin/overview/series").catch(() => null), false);
      if (may("costs.read")) paintCosts(await api<Costs>("/admin/costs").catch(() => null));
    }
  }, 60_000);
};
