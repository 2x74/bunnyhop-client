// Boards → Daily (API: apps/api src/daily.ts /admin/daily, admins and the owner). The schedule: last week, today and
// the next 30 days. A day without a pick of its own shows the automatic one as the pool stands today, greyed (it is
// frozen two hours before the day starts). Staff set a map for any future date, or put it back to automatic, and can
// give a future day another style than Normal (with a map of their own or the automatic one): the style shows under the
// map, and the Board column is the size and record of the board the day is played on, in that style. A day that
// has ended can be held (not closed or posted), closed now, or recomputed. #/daily/pool lists the automatic pool with a
// switch per map. Every write is logged by the API.

import { act, api, ask, badge, emptyLine, fill, h, n, plural, reroute, table, type View } from "./core";
import { loadMapIndex, mapLine } from "./art";

interface Day {
  day: string;
  label: string;
  startsAt: number;
  endsAt: number;
  map: string | null;
  /** The day's style (styles.ts id); "autohop" is Normal, the default. */
  style: string;
  tier: number | null;
  /** The map's board in the day's style: players on it and the record. */
  runners: number | null;
  wr: number | null;
  source: "auto" | "staff" | "preview";
  inPool: boolean;
  note: string | null;
  setBy: string | null;
  hold: boolean;
  holdNote: string | null;
  closedAt: number | null;
  players: number | null;
  postState: string | null;
  podium: { place: number; userId: string; name: string; time: number }[];
}
interface PoolMap {
  name: string;
  tier: number | null;
  runners: number;
  wr: number | null;
  excluded: boolean;
  note: string | null;
  lastDay: string | null;
}
interface DailyAdmin {
  enabled: boolean;
  count: "all" | "entry";
  now: number;
  today: string;
  rules: { tiers: number[]; minRunners: number; maxRunners: number; minWr: number; maxWr: number; noRepeatDays: number; settleMinutes: number };
  /** The styles a day can be, Normal first. */
  styles: { id: string; name: string }[];
  days: Day[];
  pool: PoolMap[];
}

const load = () => api<DailyAdmin>("/admin/daily");
const post = (body: Record<string, unknown>, done: string) => act<DailyAdmin>("/admin/daily", body, done);
const weekday = (d: Day) => new Date(d.startsAt).toLocaleDateString(undefined, { weekday: "short" });
const localStart = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const secs = (s: number | null) => (s === null ? "—" : s >= 60 ? `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}` : `${s.toFixed(1)} s`);

/** The map index's names, for the map field's suggestions (the API says which can't be a daily). */
async function mapNames(): Promise<string[]> {
  await loadMapIndex();
  try {
    const j = (await (await fetch("/index.json")).json()) as { maps?: { name: string }[] };
    return (j.maps ?? []).map((m) => m.name).sort();
  } catch {
    return [];
  }
}

const NORMAL = "autohop";
const styleName = (a: DailyAdmin, id: string) => a.styles.find((s) => s.id === id)?.name ?? id;

/** A coming day's map, its style, or both. An empty map leaves the map to the automatic pick. */
async function setDay(d: Day, a: DailyAdmin): Promise<void> {
  const v = await ask({
    title: `${d.label}: map and style`,
    text: `${d.source === "staff" ? `The map is set to ${d.map}.` : `The automatic pick is ${d.map ?? "none"}.`} Leave the map empty for the automatic pick. Any ranked map can be a daily. Only runs in the day's style count.`,
    fields: [
      { name: "map", label: "Map", kind: "text", value: d.source === "staff" ? (d.map ?? "") : "", placeholder: "Automatic", list: await mapNames() },
      { name: "style", label: "Style", kind: "select", options: a.styles.map((s) => [s.id, s.name] as [string, string]), value: d.style },
      { name: "note", label: "Note (staff only)", kind: "text", value: d.note ?? "" },
    ],
    confirm: "Set",
  });
  if (!v) return;
  const map = v.map.trim() || null;
  const what = `${map ?? "automatic map"}${v.style === NORMAL ? "" : `, ${styleName(a, v.style)}`}`;
  if (await post({ action: "set", day: d.day, map, style: v.style, note: v.note }, `${d.label}: ${what}`)) reroute();
}

async function hold(d: Day): Promise<void> {
  const v = await ask({
    title: `Hold ${d.label}?`,
    text: "The day isn't closed and nothing is posted until you release it. Players still see the board.",
    fields: [{ name: "note", label: "Why (staff only)", kind: "text" }],
    confirm: "Hold",
  });
  if (v && (await post({ action: "hold", day: d.day, on: true, note: v.note }, `${d.label} held`))) reroute();
}

/** What a day is right now, as one word. */
function stateOf(d: Day, a: DailyAdmin): HTMLElement | string {
  if (d.hold) return badge("held", "warn");
  if (d.closedAt !== null) return badge("closed");
  if (d.day === a.today) return a.enabled ? badge("live", "ok") : badge("off", "warn");
  if (d.endsAt <= a.now) return badge("closing", "info");
  return "";
}

/** The day's style under the map when it isn't Normal (every day is Normal unless staff say otherwise). */
const styleOf = (d: Day, a: DailyAdmin): HTMLElement | null => (d.style === NORMAL ? null : h("div", { "data-style": d.style }, h("b", null, styleName(a, d.style)), h("span", { class: "faint" }, " day")));
/** The board the day is played on, in its style: how many players have a time and the record. */
const boardOf = (d: Day): HTMLElement | string =>
  d.map === null || d.runners === null ? "" : d.runners === 0 ? h("span", { class: "faint" }, "Nobody yet") : h("span", { class: "nowrap" }, `${plural(d.runners, "player")}, ${secs(d.wr)}`);

function pickOf(d: Day): HTMLElement {
  if (d.source === "preview") return h("span", { class: "faint", title: "As the pool stands today. Frozen two hours before the day starts." }, "Automatic");
  if (d.source === "auto") return h("span", { class: "faint" }, "Automatic, frozen");
  return h("span", { title: d.note ?? undefined }, d.setBy ? `Set by ${d.setBy}` : "Set by staff", d.note ? h("div", { class: "faint" }, d.note) : null);
}

function scheduleView(root: HTMLElement, a: DailyAdmin): void {
  const row = (d: Day) => {
    const future = d.startsAt > a.now;
    const ended = d.endsAt <= a.now;
    return h(
      "tr",
      { class: d.source === "preview" ? "retired" : "" },
      h("td", { class: "nowrap" }, h("b", null, d.day === a.today ? "Today" : d.label), h("span", { class: "faint" }, ` ${weekday(d)}`)),
      h("td", null, d.map ? mapLine(d.map, { tier: d.tier }) : h("span", { class: "faint" }, "No map in the pool"), styleOf(d, a)),
      h("td", null, boardOf(d)),
      h("td", { class: "nowrap" }, pickOf(d)),
      h("td", null, stateOf(d, a), d.holdNote ? h("div", { class: "faint" }, d.holdNote) : null),
      h("td", { class: "num" }, d.players !== null ? n(d.players) : h("span", { class: "faint" }, future ? "" : "—")),
      h("td", null, d.podium.length ? d.podium.map((p) => p.name).join(", ") : h("span", { class: "faint" }, d.closedAt !== null ? "No podium" : "")),
      h(
        "td",
        { class: "acts" },
        h(
          "span",
          { class: "hover-acts" },
          future ? h("button", { class: "small ghost", onclick: () => void setDay(d, a) }, "Set…") : null,
          future && (d.source === "staff" || d.style !== NORMAL) ? h("button", { class: "small ghost", onclick: async () => (await post({ action: "clear", day: d.day }, `${d.label}: automatic again`)) && reroute(), title: "The automatic pick, in Normal" }, "Back to automatic") : null,
          !future && d.closedAt === null && !d.hold ? h("button", { class: "small ghost", onclick: () => void hold(d) }, "Hold…") : null,
          d.hold ? h("button", { class: "small ghost", onclick: async () => (await post({ action: "hold", day: d.day, on: false }, `${d.label} released`)) && reroute() }, "Release") : null,
          ended && d.closedAt === null && !d.hold ? h("button", { class: "small ghost", onclick: async () => (await post({ action: "close", day: d.day }, `${d.label} closed`)) && reroute() }, "Close now") : null,
          d.closedAt !== null && !d.hold ? h("button", { class: "small ghost", onclick: async () => (await post({ action: "recompute", day: d.day }, `${d.label} recomputed`)) && reroute() }, "Recompute") : null,
        ),
      ),
    );
  };
  const HEAD: (string | [string, string])[] = ["Day", "Map", "Board", "Pick", "State", ["Players", "num"], "Podium", ""];
  // Newest first under the schedule: yesterday is the one staff look at.
  const past = a.days.filter((d) => d.day < a.today).reverse();
  const inPool = a.pool.filter((m) => !m.excluded).length;
  const today = a.days.find((d) => d.day === a.today);
  fill(
    root,
    h(
      "div",
      { class: "view-bar" },
      h(
        "span",
        { class: "sub" },
        a.enabled ? "The Daily Challenge is on." : "The Daily Challenge is off (DAILY isn't set). Maps set here are kept for when it is on.",
        today ? ` A day starts at ${localStart(today.startsAt)} your time and closes ${a.rules.settleMinutes} minutes after it ends.` : "",
        a.count === "entry" ? " Only runs started from the Daily entry count." : "",
      ),
      h("div", { class: "tools" }, h("a", { class: "btn", href: "#/daily/pool" }, `Pool, ${plural(inPool, "map")}`)),
    ),
    table(HEAD, a.days.filter((d) => d.day >= a.today).map(row), "No days yet."),
    ...(past.length ? [h("h3", null, "Last week"), table(HEAD, past.map(row))] : []),
  );
}

function poolView(root: HTMLElement, a: DailyAdmin): void {
  const r = a.rules;
  const row = (m: PoolMap) =>
    h(
      "tr",
      { class: m.excluded ? "retired" : "" },
      h("td", null, mapLine(m.name, { tier: m.tier })),
      h("td", { class: "num" }, n(m.runners)),
      h("td", { class: "num" }, secs(m.wr)),
      h("td", null, m.lastDay ?? h("span", { class: "faint" }, "Never")),
      h("td", null, m.excluded ? [badge("out", "warn"), m.note ? h("div", { class: "faint" }, m.note) : null] : ""),
      h(
        "td",
        { class: "acts" },
        h(
          "span",
          { class: "hover-acts" },
          m.excluded
            ? h("button", { class: "small ghost", onclick: async () => (await post({ action: "exclude", map: m.name, on: false }, `${m.name} back in the pool`)) && reroute() }, "Put back")
            : h(
                "button",
                {
                  class: "small ghost",
                  onclick: async () => {
                    const v = await ask({ title: `Take ${m.name} out of the pool?`, text: "It is never picked automatically. Staff can still set it for a day.", fields: [{ name: "note", label: "Why (staff only)", kind: "text" }], confirm: "Take out" });
                    if (v && (await post({ action: "exclude", map: m.name, note: v.note }, `${m.name} out of the pool`))) reroute();
                  },
                },
                "Take out…",
              ),
        ),
      ),
    );
  const sorted = [...a.pool].sort((x, y) => Number(y.excluded) - Number(x.excluded) || y.runners - x.runners);
  fill(
    root,
    h(
      "div",
      { class: "view-bar" },
      h(
        "span",
        { class: "sub" },
        `Ranked tier ${r.tiers.join(" and ")} maps with ${r.minRunners} to ${r.maxRunners} players and a record between ${r.minWr} s and ${Math.round(r.maxWr / 60)} min. A map isn't picked again for ${r.noRepeatDays} days, and never while it is in the week's gauntlet.`,
      ),
      h("div", { class: "tools" }, h("a", { class: "btn", href: "#/daily" }, "Schedule")),
    ),
    table(["Map", ["Players", "num"], ["Record", "num"], "Last daily", "", ""], sorted.map(row), "No map fits the pool."),
  );
}

export const dailyView: View = async (root, _params, rest) => {
  const [a] = await Promise.all([load(), loadMapIndex()]);
  if (!a) return void fill(root, emptyLine("Couldn't load the schedule."));
  if (rest[0] === "pool") return poolView(root, a);
  scheduleView(root, a);
};
