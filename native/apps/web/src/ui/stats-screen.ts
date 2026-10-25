// Stats (menu screen "stats", /stats): two header tabs. Your stats is your profile's numbers and the last 30 days in one
// page; Game stats is the live player count, its last 24 hours, the game's totals and the player leaderboards
// (ui/stat-boards.ts). The
// profile's overview reuses the activity part (playerStatsSection).

import { statBoardsSection } from "./stat-boards";
import "./stats-screen.css";
import { api, type GameStats, type Profile } from "../api";
import { clear, h } from "./dom";
import { nameAttrs } from "./marks";
import { navigate } from "./nav";
import { styleLabel } from "../styles";
import { formatTime } from "../timer";
import { landRows } from "./land";
import { profileFor } from "./account-state";

export type PlayerStats = Awaited<ReturnType<typeof api.playerStats>>;

const DAY = 86_400_000;
const number = (n: number) => n.toLocaleString();
const plural = (n: number, one: string, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;
const hours = (seconds: number) => `${(seconds / 3600).toLocaleString(undefined, { maximumFractionDigits: seconds < 360_000 ? 1 : 0 })}h`;
const day = (at: number, utc = false) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(utc ? { timeZone: "UTC" } : {}) });
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** A row of numbers, label under value. A plain count (no unit) may count up (countUp). */
function figures(items: ([string, string] | null)[], cls = ""): HTMLElement {
  return h(
    `dl.st-figs${cls}`,
    null,
    ...items
      .filter((x): x is [string, string] => !!x)
      .map(([label, value]) => {
        const n = /^[\d,.\s]+$/.test(value) ? Number(value.replace(/[^\d]/g, "")) : NaN;
        return h("div", null, h("dd", { "data-count": Number.isFinite(n) && n > 0 ? String(n) : undefined }, value), h("dt", null, label));
      }),
  );
}

function block(title: string, ...body: (Node | null)[]): HTMLElement {
  return h("section.st-block", null, h("h3.st-h", null, title), ...body);
}

function empty(text: string): HTMLElement {
  return h("p.st-empty", null, text);
}

/** Loading: grey bars the size of what's coming (a row of big numbers, a chart), not the word "Loading". */
function skeleton(o: { who?: boolean; figs?: number; chart?: boolean } = {}): HTMLElement {
  const fig = () => h("div.st-sk-fig", null, h("span.sk.st-sk-num"), h("span.sk.st-sk-label"));
  return h(
    "div.st-page.st-skeleton",
    { "aria-hidden": "true" },
    o.who ? h("div.st-sk-who", null, h("span.sk.st-sk-name"), h("span.sk.st-sk-label")) : null,
    h("div.st-figs", null, ...Array.from({ length: o.figs ?? 4 }, fig)),
    o.chart === false ? null : h("span.sk.st-sk-chart"),
  );
}

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.body.classList.contains("potato");

/**
 * Big numbers count up to their value once (600 ms, eased out), on the first paint only. Text only (tabular numbers keep
 * the width); nothing with reduced motion or the Potato preset.
 */
function countUp(root: HTMLElement): void {
  if (still()) return;
  const els = [...root.querySelectorAll<HTMLElement>("[data-count]")];
  if (!els.length) return;
  const targets = els.map((el) => ({ el, to: Number(el.dataset.count), text: el.textContent ?? "" }));
  const t0 = performance.now();
  const D = 600;
  const step = (now: number) => {
    const u = Math.min(1, (now - t0) / D);
    const e = 1 - (1 - u) ** 3;
    for (const t of targets) t.el.textContent = u >= 1 ? t.text : number(Math.round(t.to * e));
    if (u < 1 && root.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Finishes per UTC day for the last 30 days: one bar each, hover for the day. */
function activityChart(activity: PlayerStats["activity"]): HTMLElement {
  const today = Math.floor(Date.now() / DAY) * DAY;
  const byDay = new Map(activity.map((d) => [d.at, d.runs]));
  const days = Array.from({ length: 30 }, (_, i) => {
    const at = today - (29 - i) * DAY;
    return { at, runs: byDay.get(at) ?? 0 };
  });
  const total = days.reduce((n, d) => n + d.runs, 0);
  const top = Math.max(1, ...days.map((d) => d.runs));
  return h(
    "figure.st-days",
    null,
    h(
      "div.st-days-bars",
      { role: "img", "aria-label": `${plural(total, "finish", "finishes")} from ${day(days[0].at, true)} to ${day(today, true)}` },
      ...days.map((d) =>
        h("span", { class: d.runs ? "" : "zero", style: `--v:${d.runs / top}`, title: `${day(d.at, true)}: ${plural(d.runs, "finish", "finishes")}` }),
      ),
    ),
    h("figcaption.st-axis", null, h("span", null, day(days[0].at, true)), h("span", null, plural(total, "finish", "finishes")), h("span", null, "Today")),
  );
}

/** Players online over the last 24 hours (minute peaks): an area, hover for the minute. */
function onlineChart(s: GameStats): HTMLElement {
  const end = s.now;
  const start = end - DAY;
  const points = (s.concurrency?.history ?? []).filter((p) => p.at >= start).sort((a, b) => a.at - b.at);
  const top = Math.max(1, ...points.map((p) => p.count));
  const W = 1000;
  const H = 100;
  const x = (at: number) => ((at - start) / DAY) * W;
  const y = (n: number) => H - (n / top) * (H - 6);
  // A gap of more than five minutes between samples breaks the line rather than drawing across it.
  const runs: (typeof points)[] = [];
  for (const p of points) {
    const run = runs[runs.length - 1];
    if (run && p.at - run[run.length - 1].at <= 5 * 60_000) run.push(p);
    else runs.push([p]);
  }
  const line = runs.map((r) => r.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(p.count).toFixed(1)}`).join("")).join("");
  const area = runs.map((r) => `M${x(r[0].at).toFixed(1)},${H}${r.map((p) => `L${x(p.at).toFixed(1)},${y(p.count).toFixed(1)}`).join("")}L${x(r[r.length - 1].at).toFixed(1)},${H}Z`).join("");
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = `<defs><linearGradient id="st-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".28"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs><path class="st-area" d="${area}" fill="url(#st-fill)"/><path class="st-line" d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
  const cursor = h("div.st-cursor", { hidden: true }, h("span.st-cursor-dot"), h("span.st-cursor-tip"));
  const plot = h("div.st-plot", { role: "img", "aria-label": `Players online over the last 24 hours, highest ${number(top)}` }, svg, cursor, h("span.st-plot-max", null, number(top)));
  plot.addEventListener("pointermove", (e) => {
    if (!points.length) return;
    const r = plot.getBoundingClientRect();
    const at = start + ((e.clientX - r.left) / r.width) * DAY;
    let best = points[0];
    for (const p of points) if (Math.abs(p.at - at) < Math.abs(best.at - at)) best = p;
    cursor.hidden = false;
    cursor.style.setProperty("--x", `${(x(best.at) / W) * 100}%`);
    cursor.style.setProperty("--y", `${(y(best.count) / H) * 100}%`);
    cursor.classList.toggle("left", x(best.at) > W * 0.8);
    cursor.querySelector(".st-cursor-tip")!.textContent = `${clock(best.at)} · ${plural(best.count, "player")}`;
  });
  plot.addEventListener("pointerleave", () => (cursor.hidden = true));
  return h("figure.st-online-chart", null, plot, h("figcaption.st-axis", null, h("span", null, "24 hours ago"), h("span", null, "Now")));
}

/** Finishes per style (and, for your own page, points and rank) as plain rows. */
function styleRows(stats: PlayerStats["styles"], ranks: Profile["styles"] = []): HTMLElement {
  const ids = [...new Set([...ranks.map((r) => r.scope), ...stats.map((s) => s.style)])];
  if (!ids.length) return empty("No finishes yet.");
  return h(
    "div.st-rows",
    null,
    ...ids.map((id) => {
      const r = ranks.find((x) => x.scope === id);
      const s = stats.find((x) => x.style === id);
      return h(
        "div.st-row",
        null,
        h("span.st-row-main", null, styleLabel(id)),
        h("span.st-row-dim", null, s ? plural(s.runs, "finish", "finishes") : ""),
        r ? h("span.st-row-dim", null, `${number(Math.round(r.points))} pts`) : null,
        r ? h("b", null, r.rank ? `#${number(r.rank)}` : "–") : null,
      );
    }),
  );
}

function mapRows(maps: PlayerStats["maps"]): HTMLElement {
  if (!maps.length) return empty("No finishes yet.");
  return h(
    "div.st-rows",
    null,
    ...maps.slice(0, 6).map((m) =>
      h(
        "button.st-row.st-link",
        { type: "button", onclick: () => navigate({ screen: "maps", focus: m.map }) },
        h("span.st-row-main", null, m.map),
        h("span.st-row-dim", null, plural(m.runs, "finish", "finishes")),
      ),
    ),
  );
}

/**
 * A profile's activity: the totals, the last 30 days, styles and most played maps. `compact` (the profile's overview,
 * whose ranks already list the styles): no Styles block, and no chart for a month without finishes. `early`: the read,
 * already started (ui/profile.ts starts it with the profile's); Try again reads anew.
 */
export function playerStatsSection(id: string, o: { compact?: boolean; early?: Promise<PlayerStats> } = {}): HTMLElement {
  const box = h("section.st-player", { "aria-busy": "true" }, skeleton({ figs: 4 }));
  let early = o.early;
  const load = () => {
    box.setAttribute("aria-busy", "true");
    const read = early ?? api.playerStats(id);
    early = undefined;
    void read
      .then((s) => {
        const active = s.activity.some((d) => d.runs > 0);
        clear(
          box,
          figures([
            ["Maps completed", number(s.totals.mapsCompleted)],
            ["Jumps", number(s.totals.jumps)],
            ["Time played", hours(s.totals.playtimeSeconds)],
            ["Time on the clock", hours(s.totals.runTimeMs / 1000)],
          ], ".sm"),
          !o.compact || active ? block("Last 30 days", activityChart(s.activity)) : null,
          o.compact
            ? s.maps.length ? block("Most played", mapRows(s.maps)) : null
            : h("div.st-cols", null, block("Styles", styleRows(s.styles)), block("Most played", mapRows(s.maps))),
        );
      })
      .catch(() => box.replaceChildren(empty("Couldn't load activity."), h("button.btn", { type: "button", onclick: load }, "Try again")))
      .finally(() => box.setAttribute("aria-busy", "false"));
  };
  load();
  return box;
}

function personalView(p: Profile, s: PlayerStats | null, play: (() => void) | null): HTMLElement {
  const look = nameAttrs(p.player);
  // Nothing finished yet: one sentence and Play, not a wall of zeros, an empty chart and three "No finishes yet".
  if (!p.stats.pbs && !(s?.totals.mapsCompleted ?? 0)) {
    return h(
      "div.st-page.st-fresh",
      null,
      h("div.st-who-name", { style: look.style, class: look.class }, p.player.name),
      h("p.st-fresh-line", null, "Finish a map and your numbers start here."),
      play ? h("button.btn.primary", { type: "button", onclick: play }, "Play") : null,
    );
  }
  return h(
    "div.st-page",
    null,
    h(
      "header.st-who",
      null,
      h(
        "div",
        null,
        h("div.st-who-name", { style: look.style, class: look.class }, p.player.name),
        h(
          "p.st-who-meta",
          null,
          h("span", { style: `color:${p.rank.group.color}` }, p.rank.group.name),
          p.rank.rank ? h("span", null, `#${number(p.rank.rank)} overall`) : null,
          h("span", null, `Level ${p.level.level}`),
        ),
      ),
      h("button.link-btn", { type: "button", onclick: () => navigate({ screen: "profile", id: p.player.id }) }, "Open profile ›"),
    ),
    figures([
      ["Personal bests", number(p.stats.pbs)],
      ["World records", number(p.stats.wrs)],
      ["Jumps", number(s?.totals.jumps ?? p.stats.jumps)],
      ["Time played", hours(s?.totals.playtimeSeconds ?? p.stats.playtime)],
      ["Time on the clock", hours(s ? s.totals.runTimeMs / 1000 : p.stats.seconds)],
      ["Replay views", number(p.stats.replayViews ?? 0)],
    ]),
    s ? block("Last 30 days", activityChart(s.activity)) : null,
    h(
      "div.st-cols.three",
      null,
      block("Styles", styleRows(s?.styles ?? [], p.styles)),
      block(
        "Recent personal bests",
        p.recentPBs.length
          ? h(
              "div.st-rows",
              null,
              ...p.recentPBs.slice(0, 6).map((r) =>
                h(
                  "button.st-row.st-link",
                  { type: "button", title: `${r.map} in your runs`, onclick: () => navigate({ screen: "profile", id: p.player.id, tab: "runs" }) },
                  h("span.st-row-main", null, r.map, r.style !== "autohop" ? h("small", null, styleLabel(r.style)) : null),
                  h("b.st-time", null, formatTime(r.time)),
                ),
              ),
            )
          : empty("Finish a map to set your first personal best."),
      ),
      s ? block("Most played", mapRows(s.maps)) : null,
    ),
  );
}

function gameView(s: GameStats, boards: HTMLElement): HTMLElement {
  const c = s.concurrency;
  const t = s.totals;
  return h(
    "div.st-page",
    null,
    h(
      "section.st-online",
      null,
      h(
        "div.st-now",
        null,
        h("div.st-now-n", { "data-count": c?.current ? String(c.current) : undefined }, c?.current == null ? "–" : number(c.current)),
        h("p.st-now-label", null, c ? "online now" : "Live count unavailable"),
        c
          ? h(
              "p.st-now-peaks",
              null,
              c.peak24h ? h("span", null, "24h peak ", h("b", null, number(c.peak24h.count))) : null,
              c.peakAllTime ? h("span", { title: new Date(c.peakAllTime.at).toLocaleString() }, "Record ", h("b", null, number(c.peakAllTime.count)), ` on ${day(c.peakAllTime.at)}`) : null,
            )
          : null,
      ),
      c?.history?.length ? onlineChart(s) : null,
    ),
    figures([
      ["Players", number(t.players)],
      ["Verified finishes", number(t.verifiedRuns)],
      ["Jumps", number(t.jumps)],
      ["Time played", hours(t.playtimeSeconds)],
    ]),
    figures([
      ["Players with a finish", number(t.playersWhoJumped)],
      ["Maps", number(t.maps)],
      ["Maps finished", number(t.mapsCompleted)],
      ["Time on the clock", hours(t.runTimeMs / 1000)],
      t.replayViews !== undefined ? ["Replay views", number(t.replayViews)] : null,
    ], ".sm"),
    boards,
  );
}

type StatsTab = "personal" | "game";
let selectedTab: StatsTab = "personal";

export function statsScreen(o: { tabsHost: HTMLElement; play?: () => void }): HTMLElement {
  const body = h("div.st-body");
  const panels: Record<StatsTab, HTMLElement> = {
    personal: h("div", { id: "stats-personal-panel", role: "tabpanel", "aria-labelledby": "stats-personal-tab" }),
    game: h("div", { id: "stats-game-panel", role: "tabpanel", "aria-labelledby": "stats-game-tab" }),
  };
  const order: StatsTab[] = ["personal", "game"];
  const tabs = h("div.pf-tabs", { role: "tablist", "aria-label": "Stats" });
  const buttons = order.map((tab) =>
    h(
      "button.pf-tab",
      { id: `stats-${tab}-tab`, type: "button", role: "tab", "aria-controls": `stats-${tab}-panel`, onclick: () => select(tab) },
      tab === "personal" ? "Your stats" : "Game stats",
    ),
  );
  tabs.append(...buttons);
  tabs.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    select(e.key === "Home" ? "personal" : e.key === "End" ? "game" : selectedTab === "personal" ? "game" : "personal");
    buttons[order.indexOf(selectedTab)].focus();
  });
  o.tabsHost.append(tabs);
  body.append(panels.personal, panels.game);

  let disposed = false;
  let connected = false;
  // Built once: the 30 s refresh redraws the numbers around it, not the board you're looking at.
  let boards: HTMLElement | undefined;
  const loaded: Record<StatsTab, boolean> = { personal: false, game: false };
  const busy: Record<StatsTab, boolean> = { personal: false, game: false };

  const failure = (tab: StatsTab, retry: () => void) =>
    panels[tab].replaceChildren(h("div.st-error", null, empty("Couldn't load stats. Try again in a moment."), h("button.btn", { type: "button", onclick: retry }, "Try again")));

  async function loadPersonal() {
    if (busy.personal || disposed) return;
    busy.personal = true;
    panels.personal.replaceChildren(skeleton({ who: true, figs: 6 }));
    try {
      const user = await api.me();
      if (!user) throw new Error("No account");
      // (Your profile as home / the account chip just read it, if it's fresh: account-state.ts profileFor.)
      const [profile, stats] = await Promise.all([profileFor(user.id), api.playerStats(user.id).catch(() => null)]);
      if (disposed) return;
      const view = personalView(profile, stats, o.play ?? null);
      panels.personal.replaceChildren(view);
      landRows(view.querySelectorAll(".st-row"));
      countUp(view);
      loaded.personal = true;
    } catch {
      if (!disposed) failure("personal", () => void loadPersonal());
    } finally {
      busy.personal = false;
    }
  }

  // Refreshed every 30 s while the tab shows; a failed refresh keeps the last numbers.
  async function loadGame() {
    if (busy.game || disposed) return;
    busy.game = true;
    if (!loaded.game) panels.game.replaceChildren(skeleton({ figs: 4 }));
    try {
      const stats = await api.stats();
      if (disposed) return;
      // Keep keyboard focus on the same button across a refresh.
      const buttonsOf = () => [...panels.game.querySelectorAll<HTMLButtonElement>("button")];
      const focused = buttonsOf().indexOf(document.activeElement as HTMLButtonElement);
      boards ??= statBoardsSection();
      const view = gameView(stats, boards);
      // The first paint counts up and draws the chart; the 30 s refreshes just swap the numbers.
      view.classList.toggle("st-first", !loaded.game);
      panels.game.replaceChildren(view);
      if (!loaded.game) countUp(view);
      if (focused >= 0) buttonsOf()[focused]?.focus({ preventScroll: true });
      loaded.game = true;
    } catch {
      if (!disposed && !loaded.game) failure("game", () => void loadGame());
    } finally {
      busy.game = false;
    }
  }

  function select(tab: StatsTab) {
    selectedTab = tab;
    for (const t of order) panels[t].hidden = t !== tab;
    buttons.forEach((button, i) => {
      const active = order[i] === tab;
      button.classList.toggle("on", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    body.scrollTop = 0;
    // The panel that's now showing lands (the screens' drop, smaller).
    panels[tab].classList.remove("st-in");
    void panels[tab].offsetWidth;
    panels[tab].classList.add("st-in");
    if (!loaded[tab]) void (tab === "personal" ? loadPersonal() : loadGame());
  }
  select(selectedTab);

  const timer = window.setInterval(() => {
    if (!disposed && selectedTab === "game") void loadGame();
  }, 30_000);
  const observer = new MutationObserver(() => {
    if (body.isConnected) connected = true;
    else if (connected) {
      disposed = true;
      clearInterval(timer);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return body;
}
