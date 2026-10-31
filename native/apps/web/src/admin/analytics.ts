// Analytics: how players come back, what they play on, and a structured way to ask more. For the owner, admins and
// Contributors (apps/api src/analytics.ts). Everything here is an aggregate the server has already reduced: groups under 5
// players are folded or gone before they reach this file, and shows as "under 5" where a cell had to be blanked.
//
//   Retention             new-player funnel, D1 / D7 / D30 by signup cohort, split by had-a-run and guest or linked, the
//                         retention curve, daily activity
//   Clients and hardware  finished answers from the cron, per window
//   Query                 a builder over GET /admin/analytics/schema, four one-click questions, a chart and a table
//
// Shares are donuts, ranked lists and buckets circular bars, the funnel bars, in a tight grid so the page stays short. Every
// chart has a table, and a readout on hover, focus and touch. Colours follow the entity across charts: chart-colors.ts.

import { api, compact, fill, h, plural, table, NotAdmin, showAuth, dayName, n, type Child, type View } from "./core";
import { columns, donut, hbars, lines, radial, type BarRow } from "./charts";
import { arrangeParts, arrangeRings } from "./chart-colors";
import { glyph } from "./glyphs";

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// The API's shapes (apps/api src/analytics.ts, analytics-query.ts)

interface Cell {
  pct: number | null;
  n: number | null;
  of: number | null;
  open: boolean;
}

interface Retention {
  now: number;
  range: { from: string; to: string; days: number };
  funnel: { accounts: number | null; bounced: number | null; stayed: number | null; intro: number | null; ran: number | null; linked: number | null; wavedash: number | null };
  pools: Record<string, { players: number | null; cells: Record<string, Cell> }>;
  curves: Record<string, Cell[]>;
  tables: Record<string, { day: string; players: number | null; cells: Record<string, Cell> }[]>;
  offsets: number[];
  firstClose: Record<string, string>;
  recordedFrom: string | null;
  daily: { day: string; active: number | null; newPlayers: number | null; returning: number | null; runs: number | null; runners: number | null }[];
  signups: { since: string | null; client: SignupRow[]; browser: SignupRow[]; os: SignupRow[] };
}

interface SignupRow {
  value: string;
  players: number;
  share: number;
}

interface ResultRow {
  key: (string | number)[] | null;
  label: string;
  players: number;
  runs: number;
  share: number | null;
  /** Percent of the whole it is a part of (QueryResult.partOf): what a donut draws. */
  part: number;
  values: Record<string, number | null>;
}

interface QueryResult {
  dataset: string;
  measures: string[];
  groupBy: string[];
  filters: { dim: string; in: (string | number)[] }[];
  window: string;
  minFinishers: number;
  partOf: "players" | "runs";
  rows: ResultRow[];
  folded: boolean;
  dimensionPct: number | null;
  coveragePct: Record<string, number>;
  total: { players: number; runs: number; values: Record<string, number | null> } | null;
  tooNarrow: boolean;
  truncated: boolean;
  notes: string[];
  meta: { rowsRead: number | null; ms: number | null; builtAt: number | null; cached: boolean };
}

interface Charts {
  window: string;
  charts: Record<string, QueryResult>;
  online: { dow: number; hour: number; tabs: number; samples: number }[] | null;
  builtAt: number | null;
  expected: number;
  since: { diagnostics: string; sensitivity: string; polling: string; nativeDiagnostics: string };
  firstPassDone: boolean;
}

interface Schema {
  limits: { minGroupPlayers: number; filterFloor: number; filterMinPlayers: number; maxDims: number; maxSensitive: number; maxGroupBy: number; maxFilters: number; maxLimit: number; defaultLimit: number };
  windows: string[];
  minFinishers: number[];
  datasets: Record<string, { label: string; note: string; runsLabel: string; ranked: boolean; measures: string[]; dimensions: string[] }>;
  measures: Record<string, { label: string; metric: string | null; how: string | null; digits: number }>;
  metrics: Record<string, { label: string; since: string | null; note: string | null }>;
  dimensions: Record<string, { label: string; sensitive: boolean; groupOnly: boolean; values: { value: string | number; label: string }[] }>;
  presets: { id: string; question: string; query: Query }[];
}

interface Query {
  dataset: string;
  measures: string[];
  groupBy: string[];
  filters: { dim: string; in: (string | number)[] }[];
  window?: string;
  limit: number;
  minFinishers?: number;
}

// ---------------------------------------------------------------------------------------------
// Pieces

/** A count, or "under 5" where the server blanked one. */
const count = (v: number | null | undefined) => (v === null || v === undefined ? "under 5" : n(v));
const pct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? "–" : `${v.toFixed(digits)}%`);
/** A share in a legend's narrow column: "100.0%" wouldn't fit, and the decimal says nothing there. */
const legendPct = (v: number) => (v >= 99.95 ? "100%" : pct(v));
const date =(iso: string) => dayName(Date.parse(`${iso}T00:00:00Z`));

/** One number with its label and a quiet line under it (admin.css .fig, as on Pulse). */
function figure(value: string, label: string, foot?: Child): HTMLElement {
  return h("div", { class: "fig small" }, h("span", { class: "fig-top" }, h("span", { class: "fig-v" }, value), h("span", { class: "fig-l" }, label)), foot ? h("span", { class: "fig-f" }, foot) : null);
}

/**
 * A chart with its title, a short line on what it covers, and a Table button (every chart has a table). The longer notes
 * live with the table, so the page stays short.
 */
function panel(o: { title: string; cover?: Child; chart: HTMLElement | null; tableEl?: HTMLElement | null; note?: string; empty?: string; wide?: boolean }): HTMLElement {
  const body = h("div", { class: "an-body" });
  const toggle = o.chart && o.tableEl ? h("button", { type: "button", class: "small ghost an-toggle", "aria-pressed": "false" }, "Table") : null;
  const section = h("section", { class: `an-panel${o.wide ? " wide" : ""}` }, h("div", { class: "an-head" }, h("h3", null, o.title), toggle), o.cover ? h("p", { class: "an-cover" }, o.cover) : null, body);
  const show = (asTable: boolean) => {
    fill(body, o.chart ? (asTable ? [o.tableEl, o.note ? h("p", { class: "an-note" }, o.note) : null] : o.chart) : o.tableEl ?? h("p", { class: "an-empty" }, o.empty ?? "Not enough players yet."));
    section.classList.toggle("as-table", asTable);
    toggle?.setAttribute("aria-pressed", String(asTable));
    if (toggle) toggle.textContent = asTable ? "Chart" : "Table";
  };
  if (toggle) toggle.addEventListener("click", () => show(toggle.getAttribute("aria-pressed") !== "true"));
  show(false);
  return section;
}

/** How a dimension's answer is drawn. Absent: a table. */
const FORM: Readonly<Record<string, "donut" | "radial">> = {
  client: "donut",
  browser: "donut",
  os: "donut",
  gpu_vendor: "donut",
  gpu_family: "donut",
  version: "donut",
  poll_hz: "donut",
  raw_input: "donut",
  screen: "donut",
  style: "donut",
  track: "donut",
  tier: "donut",
  gpu_model: "radial",
  map: "radial",
  fps_bucket: "radial",
  sens_bucket: "radial",
  dpi_bucket: "radial",
  cores: "radial",
  board_size: "radial",
};

const partsWord = (r: QueryResult, runsWord = "runs") => (r.partOf === "players" ? "players" : runsWord);
const partsSample = (r: QueryResult) => (r.partOf === "players" ? (r.total?.players ?? 0) : (r.total?.runs ?? 0));

/** A row's readout: its name, its share and of how many, and its counts. */
function rowTip(x: ResultRow, r: QueryResult, runsWord: string): string {
  return [x.label, `${pct(x.part)} of ${n(partsSample(r))} ${partsWord(r, runsWord)}`, `${n(x.players)} players, ${n(x.runs)} ${runsWord}`].join("\n");
}

/** Shares of a whole, as a donut. */
function donutOf(dim: string, r: QueryResult, label: string, runsWord = "runs"): HTMLElement | null {
  if (!r.rows.length) return null;
  const parts = arrangeParts(dim, r.rows.map((x) => ({ ...x, key: x.key?.[0] ?? null })));
  return donut({
    label,
    whole: 100,
    center: { value: compact(partsSample(r)), label: partsWord(r, runsWord) },
    slices: parts.map((p) => {
      const row: ResultRow = { ...p, key: p.key === null ? null : [p.key] };
      return { label: p.label, value: p.part, color: p.color, shown: legendPct(p.part), tip: rowTip(row, r, runsWord) };
    }),
  });
}

/** A ranked list or buckets, as circular bars: of the players (or runs), or of a number when `value` says which. */
function radialOf(dim: string, r: QueryResult, label: string, o: { value?: (x: ResultRow) => number | null; shown?: (x: ResultRow) => string; tip?: (x: ResultRow) => string; runsWord?: string } = {}): HTMLElement | null {
  const runsWord = o.runsWord ?? "runs";
  const value = o.value ?? ((x: ResultRow) => x.part);
  const rows = r.rows.filter((x) => value(x) !== null).map((x) => ({ ...x, key: x.key?.[0] ?? null, row: x, value: value(x) ?? 0 }));
  if (!rows.length) return null;
  return radial({
    label,
    rows: arrangeRings(dim, rows).map((x) => ({
      label: x.label,
      value: x.value,
      color: x.color,
      shown: o.shown ? o.shown(x.row) : pct(x.row.part),
      tip: o.tip ? o.tip(x.row) : rowTip(x.row, r, runsWord),
    })),
  });
}

function segControl<T extends string>(options: [T, string][], current: T, pick: (v: T) => void, label: string): HTMLElement {
  const buttons = options.map(([v, l]) => h("button", { type: "button", "aria-pressed": String(v === current), onclick: () => pick(v) }, l));
  return h("div", { class: "seg", role: "group", "aria-label": label }, buttons);
}

function sectionTitle(text: string, sub?: string): HTMLElement {
  return h("h2", { class: "section-title" }, text, sub ? h("small", null, sub) : null);
}

/** A reload that keeps the old view dimmed (no skeleton, no jump), and says so plainly if it fails. */
function reloader(slot: HTMLElement, paint: () => Promise<Child>): () => Promise<void> {
  let seq = 0;
  return async () => {
    const my = ++seq;
    slot.classList.add("an-loading");
    try {
      const content = await paint();
      if (my !== seq) return;
      fill(slot, content);
    } catch (e) {
      if (my !== seq) return;
      if (e instanceof NotAdmin) return showAuth();
      fill(slot, h("section", { class: "state error" }, h("h2", null, "That didn't load"), h("pre", { class: "err-raw" }, (e as Error).message), h("button", { class: "primary", onclick: () => void reload() }, glyph("refresh"), "Try again")));
    } finally {
      if (my === seq) slot.classList.remove("an-loading");
    }
  };
  async function reload() {
    return reloader(slot, paint)();
  }
}

// ---------------------------------------------------------------------------------------------
// Retention

const SPLITS: [string, string, [string, string, string][]][] = [
  ["run", "Had a run", [["all", "Everyone", "c-ink"], ["ran", "Finished a run in 24 hours", "s-1"], ["no_run", "No run in 24 hours", "s-2"]]],
  ["link", "Guest or linked", [["all", "Everyone", "c-ink"], ["linked", "Linked in 24 hours", "s-1"], ["guest", "Guest at 24 hours", "s-2"]]],
];

const SEGMENT_ROWS: [string, string][] = [
  ["all", "Everyone"],
  ["guest", "Guest"],
  ["linked", "Linked"],
  ["ran", "Had a run"],
  ["no_run", "No run"],
  ["guest_ran", "Guest, had a run"],
  ["guest_no_run", "Guest, no run"],
  ["linked_ran", "Linked, had a run"],
  ["linked_no_run", "Linked, no run"],
];

const HEAT_TOP = 60; // the darkest step: more retained than this is the same colour

/** A retention cell: a sequential wash of ink, the value always written in it. */
function heatCell(c: Cell | undefined): HTMLTableCellElement {
  if (!c || c.open) return h("td", { class: "num heat open", title: "This window hasn't closed yet" }, "–");
  if (c.pct === null) return h("td", { class: "num heat", title: "Under 5 players" }, "under 5");
  const f = Math.min(1, c.pct / HEAT_TOP);
  const td = h("td", { class: `num heat${f > 0.55 ? " on-light" : ""}`, title: `${n(c.n)} of ${n(c.of)} players` }, `${c.pct.toFixed(1)}%`);
  td.style.setProperty("--h", f.toFixed(3));
  return td;
}

function retentionTable(first: string, rows: { label: string; players: number | null; cells: Record<string, Cell> }[], offsets: number[]): HTMLElement {
  return h(
    "div",
    { class: "tablewrap an-heat" },
    h(
      "table",
      null,
      h("thead", null, h("tr", null, h("th", null, first), h("th", { class: "num" }, "Players"), offsets.map((o) => h("th", { class: "num" }, `D${o}`)))),
      h("tbody", null, rows.map((r) => h("tr", null, h("td", null, r.label), h("td", { class: "num" }, count(r.players)), offsets.map((o) => heatCell(r.cells[o]))))),
    ),
  );
}

/** Stays as bars: it is one narrowing number after another, which a bar's length says best and a ring doesn't. */
function funnelPanel(r: Retention): HTMLElement {
  const f = r.funnel;
  const stages: [string, number | null][] = [["Stayed past 60 seconds", f.stayed], ["Finished the intro", f.intro], ["Finished a run", f.ran], ["Linked email or Discord", f.linked]];
  const top = f.stayed ?? 0;
  const rows: BarRow[] = stages.map(([label, v], i) => ({
    label,
    value: v ?? 0,
    shown: v === null ? "under 5" : `${n(v)}  ${top ? `${((v / top) * 100).toFixed(1)}%` : ""}`,
    tip: v === null ? undefined : `${n(v)} players, ${top ? `${((v / top) * 100).toFixed(1)}% of those who stayed` : ""}`,
    cls: `r-${i + 1}`,
  }));
  const tableEl = table(["Stage", ["Players", "num"], ["Of those who stayed", "num"]], stages.map(([label, v]) => h("tr", null, h("td", null, label), h("td", { class: "num" }, count(v)), h("td", { class: "num" }, v === null || !top ? "–" : pct((v / top) * 100)))));
  return panel({
    title: "New players",
    cover: [`${count(f.accounts)} accounts ${date(r.range.from)} to ${date(r.range.to)}. ${count(f.bounced)} left within 60 seconds, where bot guests land. Wavedash is counted apart (${count(f.wavedash)}).`],
    chart: top ? hbars({ rows, label: "New player funnel", max: top }) : null,
    tableEl,
  });
}

function curvePanel(r: Retention): HTMLElement {
  let split = SPLITS[0];
  const legend = h("span", { class: "legend" });
  const slot = h("div");
  const toggleSlot = h("span");
  const draw = () => {
    const series = split[2].map(([key, label, cls]) => ({ key, label, cls, cells: r.curves[key] ?? [] }));
    const days = Array.from({ length: 30 }, (_, i) => i + 1);
    const known = days.filter((d) => series.some((s) => s.cells[d]?.pct !== null && s.cells[d]?.pct !== undefined));
    fill(legend, series.flatMap((s) => [h("i", { class: `k line ${s.cls}` }), s.label]));
    fill(toggleSlot, segControl(SPLITS.map((x) => [x[0], x[1]] as [string, string]), split[0], (v) => ((split = SPLITS.find((x) => x[0] === v)!), draw()), "Split"));
    if (!known.length) return fill(slot, h("p", { class: "an-empty" }, `No window has closed yet. Day 1 first closes on ${date(r.firstClose[1])}.`));
    fill(
      slot,
      lines({
        label: `Share of players seen on each day after signup. ${series.map((s) => `${s.label}: day 7 ${pct(s.cells[7]?.pct)}`).join(", ")}.`,
        height: 170,
        top: Math.ceil(Math.max(...series.flatMap((s) => days.map((d) => s.cells[d]?.pct ?? 0))) / 5) * 5,
        fmt: (v) => `${v}%`,
        ticks: [1, 7, 14, 21, 30].map((d) => [d - 1, `D${d}`] as [number, string]),
        series: series.map((s) => ({ label: s.label, cls: s.cls, values: days.map((d) => s.cells[d]?.pct ?? null) })),
        tip: (i) => [`Day ${days[i]}`, ...series.map((s) => `${pct(s.cells[days[i]]?.pct).padStart(6)}  ${s.label}${s.cells[days[i]]?.of ? `, ${n(s.cells[days[i]].of)} players` : ""}`)].join("\n"),
      }),
    );
  };
  draw();
  const days = [1, 3, 7, 14, 21, 30];
  const tableEl = table(["Days after signup", ...SPLITS[0][2].concat(SPLITS[1][2].slice(1)).map(([, label]) => [label, "num"] as [string, string])], days.map((d) => h("tr", null, h("td", null, `D${d}`), SPLITS[0][2].concat(SPLITS[1][2].slice(1)).map(([key]) => h("td", { class: "num" }, pct(r.curves[key]?.[d]?.pct))))));
  return panel({
    title: "Retention by days since signup",
    cover: [toggleSlot, legend],
    chart: slot,
    tableEl,
    note: "Each day counts only the cohorts whose window has closed, so the right side rests on fewer players.",
  });
}

function dailyPanels(r: Retention): HTMLElement[] {
  const days = r.daily;
  if (!days.length) return [panel({ title: "Daily active players", chart: null, empty: "Nothing recorded in this range yet." })];
  const ticks = (len: number): [number, string][] => [0, Math.floor(len / 2), len - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => [i, date(days[i].day)]);
  const active = columns({
    label: `Daily active players, ${date(days[0].day)} to ${date(days[days.length - 1].day)}.`,
    height: 140,
    hot: days.length - 1,
    ticks: ticks(days.length),
    series: [
      { values: days.map((d) => d.returning ?? 0), cls: "c-ink", label: "returning" },
      { values: days.map((d) => d.newPlayers ?? 0), cls: "s-2", label: "new" },
    ],
    tip: (i) => `${date(days[i].day)}  ${count(days[i].active)} active: ${count(days[i].returning)} returning, ${count(days[i].newPlayers)} new`,
  });
  const runs = columns({
    label: "Verified runs per day.",
    height: 140,
    hot: days.length - 1,
    ticks: ticks(days.length),
    series: [{ values: days.map((d) => d.runs ?? 0), cls: "c-ink", label: "runs" }],
    tip: (i) => `${date(days[i].day)}  ${count(days[i].runs)} runs by ${count(days[i].runners)} players`,
  });
  const dayTable = (cols: [string, (d: Retention["daily"][number]) => string][]) => table(["Day", ...cols.map(([c]) => [c, "num"] as [string, string])], days.map((d) => h("tr", null, h("td", null, date(d.day)), cols.map(([, f]) => h("td", { class: "num" }, f(d))))));
  return [
    panel({ title: "Daily active players", cover: [h("span", { class: "legend" }, h("i", { class: "k c-ink" }), "returning", h("i", { class: "k s-2" }), "new"), " Seen that UTC day, session past 60 seconds. Last column: today so far"], chart: active, tableEl: dayTable([["Active", (d) => count(d.active)], ["Returning", (d) => count(d.returning)], ["New", (d) => count(d.newPlayers)]]) }),
    panel({ title: "Verified runs per day", cover: "Every verified run, all clients", chart: runs, tableEl: dayTable([["Runs", (d) => count(d.runs)], ["Players", (d) => count(d.runners)]]) }),
  ];
}

const CLIENT_NAMES: Record<string, string> = { browser: "Browser", desktop: "Desktop app", native: "Native client", wavedash: "Wavedash", unknown: "Not reported" };

function signupPanels(r: Retention): HTMLElement {
  const s = r.signups;
  if (!s.since) return h("p", { class: "an-empty" }, "Client at signup covers players who never finish a run. Recording starts with this update, and nothing has been recorded in this range yet.");
  const chart = (dim: string, rows: SignupRow[], title: string, names: Record<string, string> = {}) => {
    if (!rows.length) return null;
    const sample = rows.reduce((a, x) => a + x.players, 0);
    const parts = arrangeParts(dim, rows.map((x) => ({ key: x.value, label: names[x.value] ?? x.value, part: x.share, players: x.players, runs: 0 })));
    return donut({
      label: title,
      whole: 100,
      center: { value: compact(sample), label: "players" },
      slices: parts.map((p) => ({ label: p.label, value: p.part, color: p.color, shown: legendPct(p.part), tip: [p.label, `${pct(p.part)} of ${n(sample)} players`, `${n(p.players)} players`].join("\n") })),
    });
  };
  const tbl = (rows: SignupRow[], names: Record<string, string> = {}) => table(["Value", ["Players", "num"], ["Share", "num"]], rows.map((x) => h("tr", null, h("td", null, names[x.value] ?? x.value), h("td", { class: "num" }, n(x.players)), h("td", { class: "num" }, pct(x.share)))));
  const cover = `Everyone who stayed, with or without a run, since ${date(s.since)}`;
  return h(
    "div",
    { class: "an-tiles" },
    panel({ title: "Client at signup", cover, chart: chart("client", s.client, "Client at signup", CLIENT_NAMES), tableEl: tbl(s.client, CLIENT_NAMES) }),
    panel({ title: "Browser at signup", cover, chart: chart("browser", s.browser, "Browser at signup"), tableEl: tbl(s.browser) }),
    panel({ title: "OS at signup", cover, chart: chart("os", s.os, "OS at signup"), tableEl: tbl(s.os) }),
  );
}

function paintRetention(r: Retention): Child {
  const all = r.pools.all;
  const d = (off: number, label: string) => {
    const c = all?.cells[off];
    if (!c || c.open || c.pct === null) return figure("–", label, c?.open ? `First cohort closes ${date(r.firstClose[off])}` : "Too few players");
    return figure(pct(c.pct), label, `${n(c.n)} of ${n(c.of)} players`);
  };
  let segment = "all";
  const cohortSlot = h("div");
  const drawCohorts = () => {
    const rows = (r.tables[segment] ?? []).map((x) => ({ label: date(x.day), players: x.players, cells: x.cells }));
    fill(cohortSlot, rows.length ? retentionTable("Signup day", rows, r.offsets) : h("p", { class: "an-empty" }, "No cohorts in this range yet."));
  };
  const picker = h("label", { class: "inline-sel" }, "Show", h("select", { onchange: (e: Event) => ((segment = (e.target as HTMLSelectElement).value), drawCohorts()) }, SEGMENT_ROWS.map(([v, l]) => h("option", { value: v }, l))));
  drawCohorts();
  const daily = dailyPanels(r);
  return [
    h("div", { class: "figs figs-small an-figs" }, d(1, "D1"), d(7, "D7"), d(30, "D30"), figure(count(r.funnel.stayed), "players in these cohorts", `${r.range.days} signup days`)),
    h("div", { class: "an-two" }, funnelPanel(r), curvePanel(r)),
    // Two stacks, so the short table and the long one don't leave a hole beside each other.
    h(
      "div",
      { class: "an-two" },
      h("div", { class: "an-stack" }, h("section", null, sectionTitle("By split", "Read 24 hours after signup"), retentionTable("Group", SEGMENT_ROWS.map(([key, label]) => ({ label, players: r.pools[key]?.players ?? null, cells: r.pools[key]?.cells ?? {} })), r.offsets)), daily[0]),
      h("div", { class: "an-stack" }, h("section", null, h("div", { class: "an-head" }, sectionTitle("By signup day"), picker), cohortSlot), daily[1]),
    ),
    h("section", { class: "an-section" }, sectionTitle("Every new player"), signupPanels(r)),
    h(
      "section",
      { class: "an-notes" },
      h("h2", { class: "section-title" }, "How to read this"),
      h("p", null, "A cohort is every account made on one UTC day whose session lasted past 60 seconds. That filter is what keeps the bot waves out. It also means someone who left quickly and came back later still counts as a player who stayed."),
      h("p", null, `Retained on day N means seen in the 24 hours starting N days after signup. Seen means the site heard from their session, not that they played. Activity has been recorded by the hour since ${r.recordedFrom ? date(r.recordedFrom) : "the start of the record"}, so older windows are left out rather than guessed. Splits are read 24 hours after signup, so coming back later can't move a player into the better-looking group.`),
      h("p", null, "A guest who comes back on a new device looks like a new player, so these numbers run low. Wavedash players are left out: they are linked automatically."),
    ),
  ];
}

export const retentionView: View = async (root, params) => {
  const slot = h("div", { class: "an-view" });
  let from = params.get("from") ?? "";
  let to = params.get("to") ?? "";
  const fromIn = h("input", { type: "date", value: from, "aria-label": "From" });
  const toIn = h("input", { type: "date", value: to, "aria-label": "To" });
  const load = async () => {
    const r = await api<Retention>(`/admin/analytics/retention${from && to ? `?from=${from}&to=${to}` : ""}`);
    fromIn.value = r.range.from;
    toIn.value = r.range.to;
    return paintRetention(r);
  };
  const reload = reloader(slot, load);
  const RANGES: [number, string][] = [[14, "14 days"], [30, "30 days"], [90, "90 days"]];
  let picked = from || to ? 0 : 14;
  const seg = h("div");
  const paintSeg = () =>
    fill(
      seg,
      segControl(
        RANGES.map(([d, l]) => [String(d), l] as [string, string]),
        String(picked),
        (v) => {
          picked = Number(v);
          const end = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
          from = new Date(Date.parse(`${end}T00:00:00Z`) - (picked - 1) * DAY_MS).toISOString().slice(0, 10);
          to = end;
          paintSeg();
          void reload();
        },
        "Signup range",
      ),
    );
  const onDate = () => {
    if (fromIn.value && toIn.value && fromIn.value <= toIn.value) {
      from = fromIn.value;
      to = toIn.value;
      picked = 0;
      paintSeg();
      void reload();
    }
  };
  fromIn.addEventListener("change", onDate);
  toIn.addEventListener("change", onDate);
  paintSeg();
  fill(slot, await load());
  fill(root, h("div", { class: "filters" }, seg, h("label", null, "From", fromIn), h("label", null, "To", toIn)), slot);
};

// ---------------------------------------------------------------------------------------------
// Clients and hardware

function resultTable(r: QueryResult, o: { first: string; cols?: [string, string][] }): HTMLElement | null {
  if (!r.rows.length) return null;
  const cols = o.cols ?? [];
  return table(
    [o.first, ["Players", "num"], ["Runs", "num"], [r.partOf === "players" ? "Of players" : "Of runs", "num"], ...cols.map(([, l]) => [l, "num"] as [string, string])],
    r.rows.map((x) => h("tr", null, h("td", null, x.label), h("td", { class: "num" }, n(x.players)), h("td", { class: "num" }, n(x.runs)), h("td", { class: "num" }, pct(x.part)), cols.map(([k]) => h("td", { class: "num" }, x.values[k] ?? "–")))),
  );
}

const reports = (r: QueryResult) => (r.dimensionPct === null ? "" : `${r.dimensionPct}% of runs report this`);
const NOT_BUILT = "Not built yet. The cron builds a chart or two every 10 minutes.";

/** A share of the whole. */
function partsTile(view: Charts, id: string, dim: string, title: string, first: string, note?: string): HTMLElement {
  const r = view.charts[id];
  if (!r) return panel({ title, chart: null, empty: NOT_BUILT });
  return panel({ title, cover: reports(r), chart: donutOf(dim, r, title), tableEl: resultTable(r, { first }), note });
}

/** A ranked list or buckets. */
function ringsTile(view: Charts, id: string, dim: string, title: string, first: string, o: { note?: string; cover?: string } = {}): HTMLElement {
  const r = view.charts[id];
  if (!r) return panel({ title, chart: null, empty: NOT_BUILT });
  return panel({ title, cover: o.cover ?? reports(r), chart: radialOf(dim, r, title), tableEl: resultTable(r, { first }), note: o.note });
}

/** A number per entity: the median, as circular bars in the entity's colour. */
function fpsTile(view: Charts, id: string, dim: string, title: string, first: string): HTMLElement {
  const r = view.charts[id];
  if (!r) return panel({ title, chart: null, empty: NOT_BUILT });
  const chart = radialOf(dim, r, title, {
    value: (x) => x.values.median_fps,
    shown: (x) => `${x.values.median_fps ?? "–"}`,
    tip: (x) => [x.label, `Median ${x.values.median_fps ?? "–"} FPS, average ${x.values.avg_fps ?? "–"}`, `${n(x.players)} of ${n(r.total?.players ?? 0)} players`].join("\n"),
  });
  return panel({ title, cover: `Median per player. ${r.coveragePct.fps ?? 0}% report FPS`, chart, tableEl: resultTable(r, { first, cols: [["avg_fps", "Average"], ["median_fps", "Median"]] }), note: "Most players sit at their display's refresh rate or their FPS limit, so this says more about monitors than about graphics cards. Native reports FPS from v0.6.2." });
}

/** When the site is busy: a grid of the week's hours, a sequential wash of ink, the number in the readout and the table. */
function onlineGrid(view: Charts): HTMLElement {
  const data = view.online;
  if (!data?.length) return panel({ title: "When players are online", chart: null, empty: "Nothing sampled yet.", wide: true });
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const byKey = new Map(data.map((d) => [`${(d.dow + 6) % 7}:${d.hour}`, d.tabs]));
  const peak = Math.max(...data.map((d) => d.tabs), 1);
  const cell = (day: number, hour: number) => {
    const v = byKey.get(`${day}:${hour}`) ?? 0;
    const c = h("td", { class: "cell", tabindex: "0", title: `${DAYS[day]} ${String(hour).padStart(2, "0")}:00 UTC, ${v} tabs on average` });
    c.style.setProperty("--h", (v / peak).toFixed(3));
    return c;
  };
  const grid = h(
    "div",
    { class: "an-week" },
    h(
      "table",
      { role: "img", "aria-label": `Average open tabs per hour of the week, UTC. Busiest hours reach ${peak.toFixed(0)}.` },
      h("thead", null, h("tr", null, h("th"), Array.from({ length: 24 }, (_, i) => h("th", { class: "hr" }, i % 6 === 0 ? String(i).padStart(2, "0") : "")))),
      h("tbody", null, DAYS.map((d, day) => h("tr", null, h("th", { class: "dy" }, d), Array.from({ length: 24 }, (_, hour) => cell(day, hour))))),
    ),
  );
  const tbl = table(["Day", ...Array.from({ length: 4 }, (_, i) => [`${String(i * 6).padStart(2, "0")}:00`, "num"] as [string, string])], DAYS.map((d, day) => h("tr", null, h("td", null, d), Array.from({ length: 4 }, (_, i) => h("td", { class: "num" }, byKey.get(`${day}:${i * 6}`) ?? 0)))));
  return panel({ title: "When players are online", cover: `Average tabs open per hour of the week, UTC, last 28 days. Not unique players. Busiest hours reach ${peak.toFixed(0)}`, chart: grid, tableEl: tbl, wide: true });
}

function paintClients(view: Charts): Child {
  const built = Object.keys(view.charts).length;
  if (!built) return h("section", { class: "state" }, h("h2", null, "Nothing built yet"), h("p", null, "The cron builds a chart or two every 10 minutes, after a first pass over old runs that takes about a day."));
  const s = view.since;
  const overall = view.charts.fps_overall?.total;
  const sens = view.charts.sens?.total;
  return [
    h(
      "p",
      { class: "an-scope" },
      view.firstPassDone ? null : "The first pass over old runs is still going, so these charts cover part of the history. ",
      "Players with a verified run, minus shadowed players. Each counts once, under what most of their runs used; styles and tiers are shares of runs. Groups under 5 fold into Other. Hover or tap for counts.",
    ),
    h(
      "div",
      { class: "an-tiles" },
      partsTile(view, "client", "client", "Client", "Client", "Native is known from its build, Wavedash from the account, browser and desktop from diagnostics, recorded since " + date(s.diagnostics) + "."),
      partsTile(view, "browser", "browser", "Browser", "Browser", "Browser client only. Recorded since " + date(s.diagnostics) + "."),
      partsTile(view, "version", "version", "App version", "Version", "Desktop app and native client. Native reports its version from 0.6.2; older builds come from the release table."),
      partsTile(view, "os", "os", "Operating system", "OS", "Families only: browsers don't say Windows 10 from 11. Recorded since " + date(s.diagnostics) + "."),
      partsTile(view, "gpu_vendor", "gpu_vendor", "Graphics vendor", "Vendor", "Native sends no GPU yet. Recorded since " + date(s.diagnostics) + "."),
      partsTile(view, "gpu_family", "gpu_family", "Graphics family", "Family", "Firefox, Safari and Brave hide the model. Each family wears a shade of its vendor's colour."),
      ringsTile(view, "gpu_model", "gpu_model", "Graphics cards", "Card", { note: "The chart shows the 8 most common, each in its vendor's colour." }),
      ringsTile(view, "fps_bucket", "fps_bucket", "Average FPS", "Average FPS", {
        cover: `Median ${overall?.values.median_fps ?? "–"}, average ${overall?.values.avg_fps ?? "–"}. ${view.charts.fps_overall?.coveragePct.fps ?? 0}% of runs report it`,
        note: `Recorded since ${date(s.diagnostics)}, native from ${date(s.nativeDiagnostics)}. Most players sit at their display's refresh rate or their FPS limit.`,
      }),
      fpsTile(view, "fps_client", "client", "FPS by client", "Client"),
      fpsTile(view, "fps_os", "os", "FPS by OS", "OS"),
      fpsTile(view, "fps_vendor", "gpu_vendor", "FPS by graphics vendor", "Vendor"),
      partsTile(view, "poll", "poll_hz", "Polling rate", "Rate", `Slow movement can only read low, so each player counts at the highest rate they reported. Recorded since ${date(s.polling)}.`),
      ringsTile(view, "sens", "sens_bucket", "Sensitivity", "Sensitivity", {
        cover: `Median ${sens?.values.median_sens ?? "–"}, average ${sens?.values.avg_sens ?? "–"}. ${view.charts.sens?.dimensionPct ?? 0}% of runs report it`,
        note: `Recorded since ${date(s.sensitivity)}.`,
      }),
      ringsTile(view, "dpi", "dpi_bucket", "Mouse DPI", "DPI", { note: `Only players who told us. Recorded since ${date(s.sensitivity)}.` }),
      partsTile(view, "raw", "raw_input", "Raw input", "Input"),
      partsTile(view, "screen", "screen", "Screen height", "Height", `Physical pixels, the short side. Recorded since ${date(s.diagnostics)}.`),
      ringsTile(view, "cores", "cores", "CPU threads", "Threads", { note: `Recorded since ${date(s.diagnostics)}.` }),
      partsTile(view, "style", "style", "Styles", "Style", "Share of runs: a player can play several."),
      partsTile(view, "tier", "tier", "Map tiers", "Tier", "Share of runs: a player can play several."),
      ringsTile(view, "map", "map", "Most played maps", "Map", { note: "The chart shows the 8 with the most players. A player can play several, so these don't add up." }),
      onlineGrid(view),
    ),
  ];
}

export const clientsView: View = async (root) => {
  let windowId = "30d";
  const slot = h("div", { class: "an-view" });
  const stamp = h("span", { class: "sub" });
  const load = async () => {
    const view = await api<Charts>(`/admin/analytics/charts?window=${windowId}`);
    stamp.textContent = view.builtAt ? `Rebuilt about every 12 hours. Oldest chart: ${dayName(view.builtAt)}.` : "";
    return paintClients(view);
  };
  const reload = reloader(slot, load);
  const seg = h("div");
  const paintSeg = () =>
    fill(
      seg,
      segControl(
        [["7d", "7 days"], ["30d", "30 days"]],
        windowId,
        (v) => {
          windowId = v;
          paintSeg();
          void reload();
        },
        "Window",
      ),
    );
  paintSeg();
  fill(slot, await load());
  fill(root, h("div", { class: "filters" }, seg, stamp), slot);
};

// ---------------------------------------------------------------------------------------------
// Query

/** One plain sentence for a preset's answer, sample size in it. */
function answer(id: string, r: QueryResult): string | null {
  const t = r.total;
  if (!t) return null;
  if (id === "wr_fps") return `${t.values.run_avg_fps ?? t.values.avg_fps} FPS on average across ${n(t.runs)} world records (median holder ${t.values.median_fps}, ${n(t.players)} holders).`;
  if (id === "avg_sens") return `Average sensitivity ${t.values.avg_sens}, median ${t.values.median_sens}, across ${n(t.players)} players.`;
  if (id === "poll") {
    const known = r.rows.filter((x) => x.key);
    const top = [...known].sort((a, b) => b.players - a.players || b.runs - a.runs)[0];
    if (!top) return null;
    const runs = known.reduce((a, x) => a + x.runs, 0);
    return `${top.label}: ${pct(top.share)} of the players who report a rate, and ${pct(runs ? (top.runs / runs) * 100 : null)} of their runs.`;
  }
  if (id === "native_scores") {
    const native = r.rows.find((x) => x.key?.[0] === "native");
    const browser = r.rows.find((x) => x.key?.[0] === "browser");
    if (!native || !browser) return null;
    return `The typical native player's personal bests beat ${native.values.median_pct}% of their boards, the typical browser player's ${browser.values.median_pct}% (${n(native.players)} and ${n(browser.players)} players).`;
  }
  return null;
}

function resultView(r: QueryResult, schema: Schema, presetId: string | null): HTMLElement {
  const ds = schema.datasets[r.dataset];
  if (r.tooNarrow) {
    return h(
      "section",
      { class: "state" },
      h("h2", null, "Too few players match"),
      h("p", null, `A query needs at least ${schema.limits.minGroupPlayers} players, and ${schema.limits.filterFloor} for each filter, so it can't describe one person. Remove a filter or widen the window.`),
    );
  }
  const runsWord = ds.runsLabel.toLowerCase();
  const numbers = r.measures.filter((m) => schema.measures[m].metric);
  const fmtValue = (x: ResultRow, m: string) => {
    if (m === "players") return n(x.players);
    if (m === "runs") return n(x.runs);
    if (m === "share") return pct(x.share);
    const v = x.values[m];
    return v === null || v === undefined ? "–" : String(v);
  };
  const labelOf = (m: string) => (m === "runs" ? ds.runsLabel : schema.measures[m].label);
  const headline = presetId ? answer(presetId, r) : null;
  // One dimension: a number per group as circular bars (a median if one was asked for), else shares as the dimension's
  // usual form. Two dimensions, or one with no form (a week): the table alone.
  const dim = r.groupBy.length === 1 ? r.groupBy[0] : null;
  const form = dim ? FORM[dim] : undefined;
  const dimWord = dim ? schema.dimensions[dim].label.toLowerCase() : "";
  let chartTitle = "";
  let chart: HTMLElement | null = null;
  if (dim && form && r.rows.length) {
    const metric = numbers.find((m) => schema.measures[m].how === "median") ?? numbers[0];
    if (metric) {
      chartTitle = `${labelOf(metric)} by ${dimWord}`;
      chart = radialOf(dim, r, chartTitle, {
        value: (x) => x.values[metric] ?? null,
        shown: (x) => fmtValue(x, metric),
        tip: (x) => [x.label, `${labelOf(metric)}: ${fmtValue(x, metric)}`, `${n(x.players)} of ${n(r.total?.players ?? 0)} players, ${n(x.runs)} ${runsWord}`].join("\n"),
      });
    } else {
      chartTitle = `Share of ${partsWord(r, runsWord)} by ${dimWord}`;
      chart = form === "donut" ? donutOf(dim, r, chartTitle, runsWord) : radialOf(dim, r, chartTitle, { runsWord });
    }
  }
  const all: ResultRow | null = r.total ? { key: null, label: "All", players: r.total.players, runs: r.total.runs, share: null, part: 100, values: r.total.values } : null;
  const head = [r.groupBy.map((d) => schema.dimensions[d].label).join(", ") || "All", ...r.measures.map((m) => [labelOf(m), "num"] as [string, string])];
  const rows = r.rows.map((x) => h("tr", null, h("td", null, x.label), r.measures.map((m) => h("td", { class: "num" }, fmtValue(x, m)))));
  if (all) rows.push(h("tr", { class: r.groupBy.length ? "an-total" : undefined }, h("td", null, "All"), r.measures.map((m) => h("td", { class: "num" }, m === "share" ? "" : fmtValue(all, m)))));
  const tbl = table(head, rows);
  const coverage = Object.entries(r.coveragePct).map(([k, v]) => `${v}% report ${schema.metrics[k]?.label ?? k}`);
  if (r.dimensionPct !== null && r.dimensionPct < 100) coverage.unshift(`${r.dimensionPct}% report ${r.groupBy.map((d) => schema.dimensions[d].label.toLowerCase()).join(" and ")}`);
  const sample = r.total ? `${n(r.total.players)} players, ${n(r.total.runs)} ${ds.runsLabel.toLowerCase()}` : "";
  return h(
    "section",
    { class: "an-result" },
    headline ? h("p", { class: "an-answer" }, headline) : null,
    // The comparison's limits sit next to its numbers, not in the small print.
    r.dataset === "scores" ? h("p", { class: "an-caution" }, "This is correlation. Players choose their own client, and keener players may cluster on one, so it does not show that a client makes anyone faster.") : null,
    h("p", { class: "an-sample" }, h("b", null, sample), coverage.length ? `. ${coverage.join(", ")}` : "", r.folded ? ". Small groups folded" : "", r.truncated ? ". Cut at the newest rows" : ""),
    chart ? h("div", { class: "an-result-chart" }, h("h3", { class: "an-chart-t" }, chartTitle), chart) : null,
    tbl,
    h("div", { class: "an-notes" }, r.notes.map((t) => h("p", null, t))),
    h("p", { class: "an-meta" }, r.meta.cached ? `From a snapshot built ${r.meta.builtAt ? dayName(r.meta.builtAt) : ""}.` : "Live.", r.meta.rowsRead !== null ? ` ${n(r.meta.rowsRead)} rows read${r.meta.ms !== null ? ` in ${r.meta.ms} ms` : ""}.` : ""),
  );
}

export const queryView: View = async (root, params) => {
  const schema = await api<Schema>("/admin/analytics/schema");
  const blank = (dataset: string): Query => ({ dataset, measures: ["players", "runs"], groupBy: [], filters: [], limit: schema.limits.defaultLimit });
  let q: Query = blank("runs");
  let presetId: string | null = null;
  try {
    const shared = params.get("q");
    if (shared) q = { ...blank("runs"), ...(JSON.parse(shared) as Partial<Query>) };
  } catch {
    /* a mangled link: start blank */
  }
  const out = h("div", { class: "an-out" });
  const builder = h("div", { class: "an-builder" });
  const json = h("pre", { class: "an-json" });
  const reqBody = (): Query => {
    const b: Query = { ...q };
    if (!schema.datasets[q.dataset].ranked) delete b.minFinishers;
    return b;
  };
  const run = async () => {
    json.textContent = JSON.stringify(reqBody(), null, 2);
    history.replaceState(null, "", `#/anquery?q=${encodeURIComponent(JSON.stringify(reqBody()))}`);
    out.classList.add("an-loading");
    try {
      const r = await api<QueryResult>("/admin/analytics/query", reqBody());
      fill(out, resultView(r, schema, presetId));
    } catch (e) {
      if (e instanceof NotAdmin) return showAuth();
      fill(out, h("section", { class: "state error" }, h("h2", null, "That query can't run"), h("p", null, (e as Error).message)));
    } finally {
      out.classList.remove("an-loading");
    }
  };
  const paintBuilder = () => {
    const ds = schema.datasets[q.dataset];
    const dims = ds.dimensions.filter((d) => !schema.dimensions[d].groupOnly);
    const dimOption = (d: string, cur: string | undefined) => h("option", { value: d, selected: d === cur }, schema.dimensions[d].label);
    const select = (label: string, control: HTMLElement) => h("label", { class: "field" }, label, control);
    const onChange = (fn: (v: string) => void) => (e: Event) => {
      fn((e.target as HTMLSelectElement).value);
      presetId = null;
      paintBuilder();
    };
    // Measures: the plain counts first, then a line per number with its average and median.
    const measureBox = (m: string) =>
      h(
        "label",
        { class: "an-check" },
        h("input", {
          type: "checkbox",
          checked: q.measures.includes(m),
          onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            q = { ...q, measures: on ? [...q.measures, m] : q.measures.filter((x) => x !== m) };
            presetId = null;
          },
        }),
        schema.measures[m].how === "avg" ? "average" : schema.measures[m].how === "median" ? "median" : schema.measures[m].how === "run_avg" ? "per run" : m === "runs" ? ds.runsLabel : schema.measures[m].label,
      );
    const plain = ds.measures.filter((m) => !schema.measures[m].metric);
    const byMetric = new Map<string, string[]>();
    for (const m of ds.measures) {
      const metric = schema.measures[m].metric;
      if (metric) byMetric.set(metric, [...(byMetric.get(metric) ?? []), m]);
    }
    const filterRow = (f: Query["filters"][number], i: number) => {
      const values = schema.dimensions[f.dim].values;
      return h(
        "div",
        { class: "an-filter" },
        h("select", { "aria-label": "Filter on", onchange: onChange((v) => (q.filters[i] = { dim: v, in: schema.dimensions[v].values[0] ? [schema.dimensions[v].values[0].value] : [] })) }, dims.map((d) => dimOption(d, f.dim))),
        h("select", { "aria-label": "Value", onchange: (e: Event) => ((q.filters[i] = { dim: f.dim, in: [coerce(f.dim, (e.target as HTMLSelectElement).value)] }), (presetId = null)) }, values.map((v) => h("option", { value: String(v.value), selected: f.in[0] === v.value }, v.label))),
        h("button", { type: "button", class: "small ghost", onclick: () => ((q.filters = q.filters.filter((_, x) => x !== i)), (presetId = null), paintBuilder()) }, "Remove"),
      );
    };
    fill(
      builder,
      h(
        "div",
        { class: "an-row" },
        select("Dataset", h("select", { onchange: onChange((v) => (q = blank(v))) }, Object.entries(schema.datasets).map(([k, d]) => h("option", { value: k, selected: k === q.dataset }, d.label)))),
        select("Window", h("select", { onchange: onChange((v) => (q.window = v)) }, schema.windows.map((w) => h("option", { value: w, selected: w === (q.window ?? (ds.ranked ? "all" : "30d")) }, w === "all" ? "All time" : `Last ${w.replace("d", " days")}`)))),
        select("Group by", h("select", { onchange: onChange((v) => (q.groupBy = [v, ...q.groupBy.slice(1)].filter(Boolean))) }, h("option", { value: "" }, "Nothing"), ds.dimensions.map((d) => dimOption(d, q.groupBy[0])))),
        select("Then by", h("select", { onchange: onChange((v) => (q.groupBy = [q.groupBy[0], v].filter(Boolean))), disabled: !q.groupBy[0] }, h("option", { value: "" }, "Nothing"), ds.dimensions.filter((d) => d !== q.groupBy[0]).map((d) => dimOption(d, q.groupBy[1])))),
        ds.ranked ? select("Boards with at least", h("select", { onchange: onChange((v) => (q.minFinishers = Number(v))) }, schema.minFinishers.map((m) => h("option", { value: String(m), selected: m === (q.minFinishers ?? 1) }, plural(m, "finisher"))))) : null,
        select("Rows", h("input", { type: "number", min: "1", max: String(schema.limits.maxLimit), value: String(q.limit), onchange: (e: Event) => ((q.limit = Math.max(1, Math.min(schema.limits.maxLimit, Number((e.target as HTMLInputElement).value) || schema.limits.defaultLimit))), (presetId = null)) })),
      ),
      h(
        "fieldset",
        { class: "an-measures" },
        h("legend", null, "Measures"),
        h("div", { class: "an-mline" }, h("span", { class: "an-mname" }, "Counts"), plain.map(measureBox)),
        [...byMetric.entries()].map(([metric, ms]) => h("div", { class: "an-mline" }, h("span", { class: "an-mname" }, schema.metrics[metric].label), ms.map(measureBox))),
      ),
      h(
        "div",
        { class: "an-filters" },
        q.filters.map(filterRow),
        q.filters.length < schema.limits.maxFilters ? h("button", { type: "button", class: "small ghost", onclick: () => ((q.filters = [...q.filters, { dim: dims[0], in: [schema.dimensions[dims[0]].values[0]?.value ?? ""] }]), (presetId = null), paintBuilder()) }, glyph("plus"), "Add a filter") : null,
      ),
      h("div", { class: "an-run" }, h("button", { type: "button", class: "primary", onclick: () => void run() }, "Run query"), h("span", { class: "an-hint" }, `Answers leave out groups under ${schema.limits.minGroupPlayers} players. Combine at most ${schema.limits.maxDims} dimensions, ${schema.limits.maxSensitive} of them about a player's machine or map.`)),
    );
  };
  const coerce = (dim: string, v: string): string | number => {
    const hit = schema.dimensions[dim].values.find((x) => String(x.value) === v);
    return hit ? hit.value : v;
  };
  paintBuilder();
  const presets = h(
    "ul",
    { class: "an-questions" },
    schema.presets.map((p) =>
      h(
        "li",
        null,
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              q = { ...blank(p.query.dataset), ...p.query };
              presetId = p.id;
              paintBuilder();
              void run();
            },
          },
          p.question,
          glyph("chevron"),
        ),
      ),
    ),
  );
  fill(
    root,
    h("div", { class: "an-query" }, h("div", { class: "an-left" }, presets, builder, h("details", { class: "an-details" }, h("summary", null, "The query as JSON"), json)), out),
  );
  json.textContent = JSON.stringify(reqBody(), null, 2);
  if (params.get("q")) void run();
  else fill(out, h("p", { class: "an-empty" }, "Pick a question, or build one and run it. Every answer shows how many players it rests on."));
};
