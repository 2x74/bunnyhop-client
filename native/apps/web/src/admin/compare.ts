// The anticheat case's comparison (cases.ts): the questions staff asked Bun-E about every suspect, answered on the page.
// Who the player is (account age, sign-in, runs, standing, other accounts, tries on this board); this run's stored
// analyzer values against the fastest runs on the board and against the player's own runs of the style; and every
// analysed run of theirs with its values in one table. From GET /admin/integrity/compare/<run> (apps/api
// src/admin-compare.ts) and the player detail the case already loads. Nothing here re-reads a replay.

import { ago, age, fmtTime, h, kv, n, playerLink, plural, table, when, type Child } from "./core";
import { altRows, standing as standingLine, type PlayerDetail } from "./context";
import { styleWord } from "./runs";

export type Metric = "aim" | "aim_n" | "angle_gain" | "near" | "jump_gain" | "best6" | "gain_sd" | "jumps" | "spj" | "sync" | "key_sd" | "key_n" | "key_mode" | "early" | "instant" | "pair" | "t0" | "grid" | "sps" | "bind_share";
type Values = Partial<Record<Metric, number | null>>;

export interface CompareRun extends Values {
  id: string;
  user_id: string;
  name?: string;
  map?: string;
  style?: string;
  track?: number;
  time: number | null;
  status: string;
  tick_interval: number;
  created_at: number;
  tier: string | null;
  score: number | null;
  review: string | null;
  analyzer: number | null;
  pb?: number | null;
}

type Medians = Record<string, { median: number | null; n: number }>;

export interface CompareData {
  run: CompareRun & { map: string; style: string; track: number };
  board: { finishers: number; top: (CompareRun & { name: string })[]; median: Medians; compared: number };
  own: { runs: CompareRun[]; median: Medians; standing: Record<string, number | null>; compared: number; capped: boolean };
  attempts: { board: number; verified: number };
  computedAt: number;
}

const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(d)}%`);
const fixed = (v: number | null | undefined, d: number, unit = "") => (v === null || v === undefined ? "–" : `${v.toFixed(d)}${unit}`);

/** How each value reads, with what it means for the "?" (input-analysis.ts InputFeatures). */
export const METRIC_INFO: Record<Metric, { label: string; show: (v: number | null | undefined, tick: number) => string; title: string }> = {
  aim: { label: "Aim spread", show: (v) => fixed(v, 2, "°"), title: "How tightly the view follows the velocity heading while strafing (IQR). Lower is tighter; the aim-lock rule fires on very low values." },
  aim_n: { label: "Aim ticks", show: (v) => (v === null || v === undefined ? "–" : n(v)), title: "Strafe ticks the aim spread was measured over." },
  angle_gain: { label: "Gain", show: (v) => pct(v), title: "BASH2 gain over the run's air ticks. Ticks turned by a held turn bind are left out (see Turned by binds)." },
  near: { label: "Near-perfect angle", show: (v) => pct(v), title: "Share of air ticks with the wish direction within 2 u/s of perpendicular to the velocity." },
  jump_gain: { label: "Jump gain", show: (v) => pct(v), title: "Mean gain of the counted jumps." },
  best6: { label: "Best 6 jumps", show: (v) => pct(v), title: "Gain of the best 6-jump window." },
  gain_sd: { label: "Gain spread", show: (v) => fixed(v, 3), title: "Standard deviation of the per-jump gain. Very even gain is unusual." },
  jumps: { label: "Jumps counted", show: (v) => (v === null || v === undefined ? "–" : n(v)), title: "Jumps used for the jump numbers." },
  spj: { label: "Strafes per jump", show: (v) => fixed(v, 2), title: "Mean strafes per jump." },
  sync: { label: "Sync", show: (v) => pct(v, 0), title: "Share of air ticks with the mouse turning toward the side the keys strafe to." },
  key_sd: { label: "Key timing SD", show: (v, tick) => (v === null || v === undefined ? "–" : `${v.toFixed(2)} ticks (${(v * tick * 1000).toFixed(1)} ms)`), title: "Spread of the key switch offsets from the mouse reversals. Scripts sit near 0." },
  key_n: { label: "Key switches", show: (v) => (v === null || v === undefined ? "–" : n(v)), title: "A/D switches paired with a mouse reversal." },
  key_mode: { label: "Key offset (mode)", show: (v) => (v === null || v === undefined ? "–" : `${v > 0 ? "+" : ""}${v} ticks`), title: "Most common key switch offset from the mouse reversal; negative: keys first." },
  early: { label: "Keys before mouse", show: (v) => pct(v, 0), title: "Share of switches made before the mouse reversed." },
  instant: { label: "Instant switches", show: (v) => pct(v, 0), title: "Switches straight from one key to the other, no overlap or gap tick (snap tap, nulls)." },
  pair: { label: "Best adjacent pair", show: (v) => pct(v, 0), title: "Share of switches on the best two adjacent offsets. Scripts concentrate here." },
  t0: { label: "Reaction", show: (v) => (v === null || v === undefined ? "–" : `${v} ticks`), title: "Lag at which the turn best answers the aim error." },
  grid: { label: "Mouse-count grid", show: (v) => fixed(v, 2), title: "How well the view changes fit whole mouse counts (1: all of them). Low on some runs and high on others can mean a toggled assist." },
  bind_share: { label: "Turned by binds", show: (v) => pct(v, 0), title: "Share of the air strafing turned by a held +left / +right. A held bind turns at a fixed rate and can read 90-100% gain on its own, so those ticks are left out of the gain and angle numbers (unless the bind pulsed in short fast holds, as a script tuning its turn rate would)." },
  sps: { label: "Strafes per second", show: (v) => fixed(v, 2), title: "A/D switches in the air per second of run." },
};

/** The rows of the comparison table, in the order staff asked about them. */
const COMPARE_ROWS: Metric[] = ["aim", "angle_gain", "jump_gain", "best6", "bind_share", "gain_sd", "key_sd", "early", "instant", "pair", "sync", "spj", "t0", "grid"];

/** Where the run sits among the player's other runs, in words; null without enough runs. Unusual at the ends. */
export function standingWords(share: number | null | undefined, compared: number): { text: string; unusual: boolean } | null {
  if (share === null || share === undefined || compared < 3) return null;
  const hi = share >= 0.5;
  const p = Math.round((hi ? share : 1 - share) * 100);
  return { text: `${hi ? "higher" : "lower"} than ${p}% of them`, unusual: compared >= 10 && (share <= 0.05 || share >= 0.95) };
}

/** The player's account, sign-in and history in a few lines (the case's player detail). */
function playerBlock(d: PlayerDetail | null, x: CompareData, linked: Parameters<typeof altRows>[1]): HTMLElement {
  const u = d?.user;
  const count = (s: string) => d?.runStats.find((r) => r.status === s)?.n ?? 0;
  const total = d?.runStats.reduce((a, r) => a + r.n, 0) ?? 0;
  const ids = d?.identities ?? [];
  const signIn = !u ? null : u.provider === "guest" && !ids.length ? "Guest, nothing linked" : ids.length ? ids.map((i) => `${i.provider === "discord" ? "Discord" : i.provider}${i.username ? ` ${i.username}` : ""}`).join(", ") : u.provider;
  const alts = d ? altRows(d, linked) : [];
  return kv([
    ["Account", u ? h("span", { title: when(u.created_at) }, `${age(u.created_at)} old (made ${when(u.created_at).slice(0, 10)})`) : null],
    ["Sign-in", signIn],
    ["Discord server", d?.booster ? (d.booster.member ? "Member" : "Not a member") : null],
    ["Runs", d ? `${n(total)} submitted: ${n(count("verified"))} verified, ${n(count("rejected"))} rejected` : null],
    ["Standing", d ? `${standingLine(d)}${d.rank ? `, #${n(d.rank)} on points` : ""}` : null],
    ["This board", `${plural(x.attempts.board, "run")} submitted here, ${n(x.attempts.verified)} verified`],
    ["Last seen", d?.sessions.last_seen ? ago(d.sessions.last_seen) : null],
    ["Other accounts", d ? (alts.length ? h("div", { class: "ctx-rows" }, alts) : "None seen") : null],
  ]);
}

/** This run against the board's fastest and the player's own runs of the style. */
function compareTable(x: CompareData): HTMLElement {
  const tick = x.run.tick_interval || 0.01;
  // Turned by binds only on a run that used them.
  const rows = COMPARE_ROWS.filter((m) => x.run[m] !== null && x.run[m] !== undefined && !(m === "bind_share" && !x.run[m])).map((m) => {
    const info = METRIC_INFO[m];
    const own = x.own.median[m];
    const top = x.board.median[m];
    const st = standingWords(x.own.standing[m], own?.n ?? 0);
    return h(
      "tr",
      null,
      h("td", { title: info.title }, info.label),
      h("td", { class: "num" }, h("b", null, info.show(x.run[m], tick))),
      h("td", { class: "num" }, own?.median !== null && own?.median !== undefined ? info.show(own.median, tick) : "–"),
      h("td", { class: "num" }, top?.median !== null && top?.median !== undefined ? info.show(top.median, tick) : "–"),
      h("td", { class: st?.unusual ? "warn-text" : "faint" }, st?.text ?? ""),
    );
  });
  return table(
    ["Value", ["This run", "num"], ["Their other runs (median)", "num"], [`Top ${x.board.compared} here (median)`, "num"], "Among their runs"],
    rows,
    "This run has no stored analyzer values.",
  );
}

/** The fastest visible runs on the board, with the values staff compare first. */
function boardTable(x: CompareData): HTMLElement {
  const tick = x.run.tick_interval || 0.01;
  const cols: Metric[] = ["aim", "angle_gain", "jump_gain", "key_sd", "early", "pair"];
  return table(
    ["#", "Player", ["Time", "num"], ...cols.map((m): [string, string] => [METRIC_INFO[m].label, "num"]), ["Analyzer", "num"]],
    x.board.top.map((r, i) =>
      h(
        "tr",
        { class: r.user_id === x.run.user_id ? "hl" : "" },
        h("td", { class: "num" }, i + 1),
        h("td", null, playerLink(r.user_id, r.name)),
        h("td", { class: "num" }, h("a", { href: `/replay/${encodeURIComponent(r.id)}`, target: "_blank", rel: "noopener" }, fmtTime(r.time))),
        cols.map((m) => h("td", { class: "num" }, METRIC_INFO[m].show(r[m], r.tick_interval || tick))),
        h("td", { class: "num faint" }, r.analyzer ?? "–"),
      ),
    ),
    "Nobody visible on this board.",
  );
}

/** Every analysed run of the player (newest first) with its stored values: the "advanced metrics" staff asked for. */
export function runsTable(x: CompareData): HTMLElement {
  const cols: Metric[] = ["aim", "aim_n", "angle_gain", "near", "jump_gain", "best6", "bind_share", "gain_sd", "jumps", "spj", "sync", "key_sd", "key_n", "key_mode", "early", "instant", "pair", "t0", "grid", "sps"];
  return table(
    ["When", "Map", "Style", ["Time", "num"], "Status", ["Score", "num"], ["Analyzer", "num"], ...cols.map((m): [string, string] => [METRIC_INFO[m].label, "num"])],
    x.own.runs.map((r) =>
      h(
        "tr",
        { class: r.id === x.run.id ? "hl" : "" },
        h("td", { class: "time", title: when(r.created_at) }, ago(r.created_at)),
        h("td", null, h("a", { href: `#/suspicious?run=${encodeURIComponent(r.id)}` }, `${r.map ?? ""}${r.track ? ` b${r.track}` : ""}`)),
        h("td", null, styleWord(r.style ?? "")),
        h("td", { class: "num" }, fmtTime(r.time), r.pb ? " PB" : ""),
        h("td", null, r.status === "verified" ? (r.tier && r.tier !== "clean" ? `${r.tier}${r.review ? `, ${r.review}` : ", open"}` : "verified") : r.status),
        h("td", { class: "num" }, r.score ?? "–"),
        h("td", { class: "num faint" }, r.analyzer ?? "–"),
        cols.map((m) => h("td", { class: "num" }, METRIC_INFO[m].show(r[m], r.tick_interval || 0.01))),
      ),
    ),
    "No analysed runs.",
  );
}

/** The comparison section of a case: the player, this run against others, the board's fastest, and their runs. */
export function compareSection(x: CompareData, d: PlayerDetail | null, linked: Parameters<typeof altRows>[1]): Child {
  const style = styleWord(x.run.style);
  return [
    h("section", { class: "case-sec" }, h("h3", null, "Player"), playerBlock(d, x, linked)),
    h(
      "section",
      { class: "case-sec" },
      h("h3", null, "This run compared", h("small", null, `their other ${style} runs: ${x.own.compared}${x.own.capped ? "+" : ""}; top ${x.board.compared} of ${n(x.board.finishers)} on this board`)),
      compareTable(x),
    ),
    h("details", { class: "numbers" }, h("summary", null, `Fastest on this board (${style})`), boardTable(x)),
    h("details", { class: "numbers" }, h("summary", null, `Their runs with stored values (${x.own.runs.length}${x.own.capped ? ", newest" : ""})`), runsTable(x)),
  ];
}
