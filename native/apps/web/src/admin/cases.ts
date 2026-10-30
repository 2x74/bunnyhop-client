// Anticheat → Cases: triage in one place. On the left the queue, one case per flagged player (score, name, map, the
// strongest signal, how long it has been open); j / k move through it. On the right the case: the verdict and score,
// the run's time and its place on the board, the evidence once each (blatant first, review notes folded), the jump
// strip, and the player in context (account, other accounts, earlier flags and how they ended, bans, chat, their other
// times on this board). The action bar: c clear (with a note, right there), i invalidate this run, s shadowban,
// b ban + invalidate, w watch the replay at the flagged jump. Under the head: the case's stage, who has it, its labels and
// the player's pinned note; at the end, the case's timeline (staff comments, flags, moderation) with the comment box
// (src/admin/thread.ts, apps/api src/admin-cases.ts). Dealing with the last open flag closes the case. After an action the verdict stamps the row, the next
// case slides in, and the toast offers Undo for 10 s. The list is not reloaded after an action.
//
// API: GET /admin/integrity (the list), /admin/integrity/run/<id> (one run's analysis), /admin/players/<id>?lite=1 (the
// player in context), the public GET /maps/<map> (the WR time), POST /admin/integrity and /admin/runs.

import { act, ago, age, api, API, ask, badge, clientTag, emptyLine, fmtTime, glyph, h, help, kv, may, mayShadow, n, phone, playerLink, plural, reduced, setKeys, toast, undoCall, when, type RunClient, type View, fill } from "./core";
import { jumpStrip, ring, type JumpRow } from "./charts";
import { mapArt, mapLine } from "./art";
import { stamp, hopArc } from "./ui";
import { altRows, AUTO_REVIEWER, chatLines, flagRows, listSection, type PlayerDetail } from "./context";
import { recentReasons, rememberReason, shadowDialog } from "./dialogs";
import { invalidateRuns, styleWord } from "./runs";
import { hopIndicator } from "../ui/hop";
import { caseProps, loadThread, timeline, type ThreadData } from "./thread";
import { pinnedLine } from "./notes";
import { markSeen } from "./seen";

export interface Evidence {
  code: string;
  text: string;
  weight: number;
  blatant?: boolean;
  review?: boolean;
}

/** The run session's attempt counter (apps/api src/input-analysis.ts SessionAttempt). */
export interface SessionAttempt {
  attempt: number;
  resets: number;
  practice: number;
  secs: number;
}

/** "Attempt 3 of the session, 2 restarts, 4 min on the board" (context only, never a flag). */
export function attemptText(s: SessionAttempt | null | undefined): string | null {
  if (!s) return null;
  return `Attempt ${s.attempt} of the session, ${plural(s.resets, "restart")}${s.practice ? `, ${plural(s.practice, "practice exit")}` : ""}, ${Math.round(s.secs / 60)} min on the board`;
}

interface RunFeatures {
  analyzer: number;
  switches: number;
  angle: { n: number; gain: number; near: number };
  sync: { n: number; mode: number; modeShare: number; sd: number; instant: number; pair?: number; pairAt?: number; early?: number };
  aim?: { n: number; spread: number };
  reaction?: { rn: number; t0: number } | null;
  keys?: string;
  jumps?: { n: number; used: number; gain: number; gainSd: number; gainMax6: number | null; spj: number; spjSd: number; sync: number; rows: JumpRow[] };
  session?: SessionAttempt;
}

interface RunDetail {
  run: { id: string; user_id: string; name: string; status: string; time: number | null; style: string; track: number; map: string; created_at: number; tier: string | null; score: number | null; review: string | null; analyzer: number | null; client?: RunClient };
  evidence: Evidence[];
  features: RunFeatures | null;
  consistency: { text: string; notable: boolean } | null;
  pooled: { score: number; runs: number; text: string; listed: boolean } | null;
  baseline?: string | null;
  gainJump?: { score: number; listed: boolean; text: string } | null;
  legitJumps?: { z: number | null; listed: boolean; text: string } | null;
}

export interface FlagRun {
  run_id: string;
  user_id: string;
  name: string;
  tier: "blatant" | "suspicious";
  score: number;
  evidence: Evidence[];
  review: string | null;
  reviewed_by: string | null;
  reviewed_at: number | null;
  note: string | null;
  status: string;
  reason: string | null;
  time: number | null;
  style: string;
  track: number;
  map: string;
  pb: number | null;
  rank: number | null;
  created_at: number;
  session?: SessionAttempt | null;
  client?: RunClient;
}

export interface FlagPlayer {
  user_id: string;
  name: string;
  created_at: number;
  score: number;
  max_score: number;
  flags: number;
  blatant: number;
  open: number;
  last: number;
  signals: Evidence[];
  verified: number;
  desyncs: number;
  wrs: number;
  top10s: number;
  banned: { until: number | null; reason: string | null } | null;
  shadow_at: number | null;
  shadow_source: string | null;
  alts: { id: string; name: string; created_at: number; banned: boolean; shadowed?: boolean }[];
  linked?: { id: string; name: string; via: "device" | "fp" | "net"; banned: boolean; shadowed: boolean }[];
  linkedCount?: number;
  altCount?: number;
  pooled?: { score: number; runs: number } | null;
}

/** How a reviewed flag ended, in a word: flags closed on arrival say why (their note, "already shadowed"). */
const reviewWord = (r: Pick<FlagRun, "review" | "reviewed_by" | "note">) => (r.review === "actioned" && r.reviewed_by === AUTO_REVIEWER ? (r.note ?? "already shadowed") : r.review);

/** The automatic rejection's reason (apps/api src/integrity-rules.ts INHUMAN_REASON): only those runs can be approved. */
const INHUMAN_REASON = "inputs not humanly possible";

const REVIEW: [string, string][] = [
  ["open", "Not reviewed"],
  ["cleared", "Cleared"],
  ["approved", "Approved"],
  ["actioned", "Banned or invalidated"],
  ["auto", "Already shadowed"],
  ["all", "Everything"],
];

/** The best 6-jump window (jumps the summary uses: not the first or last, 40+ air ticks, with a gain). */
export function bestWindow(rows: JumpRow[]): Set<number> {
  const used: number[] = [];
  for (let i = 1; i < rows.length - 1; i++) if (rows[i][0] >= 40 && rows[i][3] !== null) used.push(i);
  let best = -Infinity;
  let at = -1;
  for (let k = 0; k + 6 <= used.length; k++) {
    const sl = used.slice(k, k + 6);
    const g = sl.reduce((a, i) => a + rows[i][3]! * rows[i][0], 0) / sl.reduce((a, i) => a + rows[i][0], 0);
    if (g > best) (best = g), (at = k);
  }
  return new Set(at < 0 ? [] : used.slice(at, at + 6));
}

const pc = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(digits)}%`);

/** A replay link at a jump (the viewer's ?jump=, viewer/viewer.ts). Rejected runs open in the game with a staff session. */
const watchHref = (run: { run_id?: string; id?: string; status: string }, jump?: number) => {
  const id = encodeURIComponent(run.run_id ?? run.id ?? "");
  const j = jump ? `jump=${jump}` : "";
  return run.status === "verified" ? `/replay/${id}${j ? `?${j}` : ""}` : `/?replay=run:${id}${j ? `&${j}` : ""}`;
};

// Small caches for this page: a case's player, a run's analysis, a board's WR time.
const players = new Map<string, Promise<PlayerDetail>>();
const details = new Map<string, Promise<RunDetail>>();
const wrTimes = new Map<string, Promise<number | null>>();
const threads = new Map<string, Promise<ThreadData>>();
const thread = (uid: string, fresh = false) => (!fresh && threads.has(uid) ? threads.get(uid)! : (threads.set(uid, loadThread("ac", uid)), threads.get(uid)!));
const lite = (id: string) => (players.has(id) ? players.get(id)! : (players.set(id, api<PlayerDetail>(`/admin/players/${encodeURIComponent(id)}?lite=1`)), players.get(id)!));
const detail = (id: string) => (details.has(id) ? details.get(id)! : (details.set(id, api<RunDetail>(`/admin/integrity/run/${encodeURIComponent(id)}`)), details.get(id)!));
const wrTime = (map: string, style: string) => {
  const k = `${map}|${style}`;
  if (!wrTimes.has(k))
    wrTimes.set(
      k,
      fetch(`${API}/maps/${encodeURIComponent(map)}?style=${encodeURIComponent(style)}`)
        .then((r) => (r.ok ? (r.json() as Promise<{ wr?: { time: number } | null }>) : null))
        .then((j) => j?.wr?.time ?? null)
        .catch(() => null),
    );
  return wrTimes.get(k)!;
};

/** The evidence once each: blatant first, then what counts toward the score, then the review notes (folded). */
function evidenceBlock(lists: Evidence[][]): HTMLElement {
  const seen = new Set<string>();
  const all: Evidence[] = [];
  for (const l of lists) for (const e of l) if (!seen.has(e.text)) (seen.add(e.text), all.push(e));
  const blatant = all.filter((e) => e.blatant);
  const scored = all.filter((e) => !e.blatant && !e.review).sort((a, b) => b.weight - a.weight);
  const review = all.filter((e) => e.review && !e.blatant);
  return h(
    "div",
    { class: "evidence" },
    blatant.map((e) => h("p", { class: "ev blatant" }, e.text)),
    scored.map((e) => h("p", { class: "ev" }, e.text)),
    review.length ? h("details", { class: "ev-review" }, h("summary", null, plural(review.length, "review note")), review.map((e) => h("p", { class: "ev faint" }, e.text))) : null,
    !all.length ? emptyLine("No evidence lines.") : null,
  );
}

/** The run's numbers as label / value lines and the per-jump table, behind a fold. */
function numbers(x: RunDetail): HTMLElement {
  const f = x.features;
  const j = f?.jumps;
  const s = f?.sync;
  const keys = f?.keys === "ws" ? "W / S" : f?.keys === "hsw" ? "A / D with W" : f?.keys === "w" ? null : "A / D";
  const win = j ? bestWindow(j.rows) : new Set<number>();
  return h(
    "details",
    { class: "numbers" },
    h("summary", null, glyph("chevron"), "Numbers"),
    kv([
      ["Client", x.run.client ? h("span", { title: x.run.client.title }, x.run.client.label) : null],
      ["Session", attemptText(f?.session) ?? "No attempt counter (an older client)"],
      ["Verdict", x.run.tier ? `${x.run.tier}, score ${x.run.score}${x.run.review ? `, ${x.run.review}` : ""}, analyzer ${x.run.analyzer}` : "Not analysed"],
      ["Jumps", j ? `${j.n} (${j.used} counted), gain ${pc(j.gain)}, best 6 ${pc(j.gainMax6)}, spread ${j.gainSd.toFixed(3)}` : "No per-jump stats"],
      ["Strafes", j ? `${j.spj} per jump, ± ${j.spjSd}` : null],
      ["Sync", j ? pc(j.sync, 0) : null],
      ["Keys", s && keys && s.n ? `${s.n} ${keys} switches; best adjacent pair ${pc(s.pair, 0)}${s.pairAt !== undefined ? ` at ${s.pairAt}/${s.pairAt + 1}` : ""}; ${pc(s.early, 0)} before the mouse; ${pc(s.instant, 0)} instant` : null],
      ["Aim", f ? `spread ${f.aim?.n ? `${f.aim.spread.toFixed(2)}°` : "–"}, reaction ${f.reaction?.t0 ?? "–"}, run gain ${pc(f.angle.gain)}` : null],
      ["Consistency", x.consistency ? h("span", { class: x.consistency.notable ? "warn-text" : "" }, x.consistency.text) : "Fewer than 6 verified runs on this board"],
      ["Pooled", x.pooled ? h("span", { class: x.pooled.listed ? "warn-text" : "" }, x.pooled.text) : "Not enough runs"],
      ["This run", x.baseline ?? null],
      ["Gain jump", x.gainJump ? h("span", { class: x.gainJump.listed ? "warn-text" : "" }, x.gainJump.text) : null],
      ["Legit jumps", x.legitJumps ? h("span", { class: x.legitJumps.listed ? "warn-text" : "" }, x.legitJumps.text) : null],
    ]),
    j?.rows.length
      ? h(
          "div",
          { class: "tablewrap jumps-wrap" },
          h(
            "table",
            { class: "jumps" },
            h("thead", null, h("tr", null, ["#", "Air", "In", "Out", "Gained", "Gain", "Sync", "Strafes"].map((t) => h("th", { class: "num" }, t)))),
            h(
              "tbody",
              null,
              j.rows.map((r, i) =>
                h("tr", { class: win.has(i) ? "hl" : "" }, h("td", { class: "num" }, i + 1), h("td", { class: "num" }, r[0]), h("td", { class: "num" }, r[1]), h("td", { class: "num" }, r[2]), h("td", { class: "num" }, `${r[2] - r[1] >= 0 ? "+" : ""}${r[2] - r[1]}`), h("td", { class: "num" }, r[3] === null ? "–" : `${(r[3] / 10).toFixed(1)}%`), h("td", { class: "num" }, r[4] === null ? "–" : `${Math.round(r[4] / 10)}%`), h("td", { class: "num" }, r[5])),
              ),
            ),
          ),
        )
      : null,
  );
}

export const casesView: View = async (root, params) => {
  const review = params.get("review") ?? "open";
  const tier = params.get("tier") ?? "";
  const runParam = params.get("run");
  let caseParam = params.get("case");
  const userParam = params.get("user");
  // A deep link to one run: open its player's case (history included, so a cleared run still shows).
  if (runParam) caseParam = (await detail(runParam)).run.user_id;
  const q = new URLSearchParams();
  q.set("review", runParam || (caseParam && review === "open") ? "all" : review);
  if (tier) q.set("tier", tier);
  if (userParam ?? (runParam || caseParam ? caseParam : null)) q.set("user", (userParam ?? caseParam)!);
  // The queue always lists every open case; a deep-linked player's case comes first, with their history.
  const [data, focusData] = await Promise.all([
    api<{ runs: FlagRun[]; players: FlagPlayer[]; autoClosedWeek?: number; shadowedOpen?: number }>(`/admin/integrity?review=${encodeURIComponent(review)}${tier ? `&tier=${tier}` : ""}${userParam ? `&user=${encodeURIComponent(userParam)}` : ""}`),
    caseParam && !userParam ? api<{ runs: FlagRun[]; players: FlagPlayer[] }>(`/admin/integrity?${q}`) : Promise.resolve(null),
  ]);
  let cases = data.players.slice();
  let runs = data.runs.slice();
  if (focusData) {
    for (const p of focusData.players) if (!cases.some((c) => c.user_id === p.user_id)) cases.unshift(p);
    for (const r of focusData.runs) if (!runs.some((x) => x.run_id === r.run_id)) runs.push(r);
  }
  const runsOf = (uid: string) => runs.filter((r) => r.user_id === uid).sort((a, b) => b.score - a.score);
  const openRuns = (uid: string) => runsOf(uid).filter((r) => r.review === null);
  const headline = (p: FlagPlayer) => {
    const ev = [...runsOf(p.user_id).flatMap((r) => r.evidence), ...p.signals];
    return (ev.find((e) => e.blatant) ?? ev.find((e) => !e.review) ?? ev[0])?.text ?? `best run score ${p.max_score}`;
  };

  // --- the queue (left)
  const list = h("div", { class: "case-list hop-host", role: "listbox", "aria-label": "Cases" });
  const pane = h("div", { class: "case-pane" });
  const listRow = (p: FlagPlayer) => {
    const top = runsOf(p.user_id)[0];
    const since = Math.min(...runsOf(p.user_id).map((r) => r.created_at), p.last);
    return h(
      "div",
      { class: "case-row", role: "option", tabindex: "-1", "data-user": p.user_id, onclick: () => select(p.user_id) },
      h("span", { class: `q-score ${p.score >= 90 ? "hi" : p.score >= 70 ? "mid" : ""}` }, ring(p.score), String(p.score)),
      h("span", { class: "cr-main" }, h("span", { class: "cr-name" }, p.name, p.shadow_at ? h("span", { class: "cr-state warn" }, "shadowed") : null, p.banned ? h("span", { class: "cr-state bad" }, "banned") : null), h("span", { class: "cr-what" }, headline(p))),
      top ? mapArt(top.map) : h("span"),
      h("span", { class: "q-age", title: `Open since ${when(since)}` }, age(since)),
    );
  };
  const paintList = () => {
    fill(list, ...(cases.length ? cases.map(listRow) : [h("div", { class: "calm-state small" }, hopArc({ size: 72, cls: "still" }), h("p", null, review === "open" ? "No open cases." : "Nothing matches."))]));
    if (cases.length) hopIndicator(list, ".case-row", { axis: "y", selected: ".on", inset: 8 });
  };

  // --- the case (right)
  let current: string | null = null;
  let currentRun: string | null = null;
  let seq = 0;
  const note = h("input", { type: "text", placeholder: "Note", title: "Optional note, saved with the review", class: "case-note", list: "case-reasons" });

  const select = (uid: string, runId?: string | null, slide = true) => {
    current = uid;
    for (const r of list.querySelectorAll<HTMLElement>(".case-row")) {
      const on = r.dataset.user === uid;
      r.classList.toggle("on", on);
      r.setAttribute("aria-selected", String(on));
      if (on) r.scrollIntoView({ block: "nearest" });
    }
    const p = cases.find((c) => c.user_id === uid);
    if (!p) return;
    const rs = runsOf(uid);
    currentRun = runId && rs.some((r) => r.run_id === runId) ? runId : (openRuns(uid)[0] ?? rs[0])?.run_id ?? null;
    void paintCase(p, slide);
    if (phone()) pane.scrollIntoView({ block: "start", behavior: reduced() ? "auto" : "smooth" });
  };

  const paintCase = async (p: FlagPlayer, slide: boolean) => {
    const my = ++seq;
    const rs = runsOf(p.user_id);
    const run = rs.find((r) => r.run_id === currentRun) ?? null;
    const runSlot = h("div", { class: "case-run" }, h("div", { class: "sk-block sm" }));
    const metaSlot = h("div", { class: "case-meta" });
    const activity = h("section", { class: "case-sec case-activity" }, h("h3", null, "Activity"), h("div", { class: "sk-block sm" }));
    const ctxSlot = h("div", { class: "case-ctx" }, h("div", { class: "sk-block sm" }));
    const rank = h("span", { class: "case-rank" });
    const verdict = p.blatant ? h("span", { class: "verdict bad" }, "Blatant") : h("span", { class: "verdict warn" }, "Suspicious");
    const body = h(
      "div",
      { class: "case-body" },
      h(
        "header",
        { class: "case-head" },
        h("div", { class: "case-verdict" }, verdict, h("span", { class: `case-score ${p.score >= 90 ? "hi" : p.score >= 70 ? "mid" : ""}` }, String(p.score))),
        h(
          "div",
          { class: "case-who" },
          h("h2", null, playerLink(p.user_id, p.name)),
          h(
            "div",
            { class: "ph-state" },
            p.shadow_at ? badge(`shadowed ${ago(p.shadow_at)}${p.shadow_source && p.shadow_source !== "admin" ? ` by ${p.shadow_source.replace(/^auto:/, "")}` : ""}`, "warn") : null,
            p.banned ? badge(p.banned.until ? `banned until ${when(p.banned.until)}` : "banned for good", "bad") : null,
            h("span", { class: "faint" }, `account ${age(p.created_at)} old`),
            h("span", { class: "faint" }, `${n(p.verified)} verified runs, ${plural(p.wrs, "WR")}, ${plural(p.top10s, "top 10")}`),
          ),
        ),
        run ? h("div", { class: "case-time" }, h("span", { class: "t-run big" }, fmtTime(run.time)), rank) : null,
      ),
      metaSlot,
      rs.length > 1
        ? h(
            "div",
            { class: "case-runs", role: "tablist", "aria-label": "Flagged runs" },
            rs.map((r) =>
              h(
                "button",
                { type: "button", role: "tab", class: `case-runtab${r.run_id === currentRun ? " on" : ""}${r.review ? " done" : ""}`, "aria-selected": String(r.run_id === currentRun), onclick: () => select(p.user_id, r.run_id, false) },
                mapArt(r.map),
                h("span", { class: "t-run" }, fmtTime(r.time)),
                h("span", { class: `rt-score ${r.score >= 90 ? "hi" : r.score >= 70 ? "mid" : ""}` }, String(r.score)),
                r.review ? h("span", { class: "faint" }, reviewWord(r)) : null,
              ),
            ),
          )
        : null,
      run ? h("div", { class: "case-map" }, mapLine(run.map, { track: run.track }), h("span", { class: "faint" }, styleWord(run.style)), run.session ? h("span", { class: "faint", title: attemptText(run.session) ?? "" }, `attempt ${run.session.attempt}`) : null, h("span", { class: "faint", title: when(run.created_at) }, ago(run.created_at)), clientTag(run.client), h("span", null, run.status === "verified" ? (run.tier === "blatant" ? badge("verified, shadowed by the rule", "warn") : badge("verified", "")) : badge(run.status, "bad")), run.review ? badge(run.reviewed_by === AUTO_REVIEWER ? `closed: ${reviewWord(run)}` : `${run.review}${run.note ? `: ${run.note}` : ""}`, "") : null) : null,
      h("section", { class: "case-sec" }, h("h3", null, "Evidence"), evidenceBlock([run?.evidence ?? [], p.signals])),
      runSlot,
      ctxSlot,
      activity,
    );
    fill(pane, body, actionBar(p, run));
    if (slide && !reduced()) body.animate([{ opacity: 0, transform: "translateX(6px)" }, { opacity: 1, transform: "none" }], { duration: 160, easing: "cubic-bezier(0.15, 0.8, 0.25, 1)" });
    // The run's place on its board and the WR it is measured against (main track only: the public WR is per style).
    if (run) {
      const wr = run.track ? Promise.resolve(null) : wrTime(run.map, run.style);
      void wr.then((t) => {
        if (my !== seq) return;
        const delta = t !== null && run.time !== null ? run.time - t : null;
        fill(rank, run.rank === 1 ? h("b", { class: "wr" }, "WR") : run.rank ? `#${run.rank}` : h("span", { class: "faint" }, run.pb ? "" : "not their PB"), delta !== null && run.rank !== 1 ? h("span", { class: "faint" }, ` ${fmtTime(delta, true)} to the WR`) : null);
      });
      // The jump strip and the numbers.
      void detail(run.run_id).then(
        (x) => {
          if (my !== seq) return;
          const rows = x.features?.jumps?.rows ?? [];
          const win = bestWindow(rows);
          const first = [...win][0];
          fill(runSlot, 
            h(
              "section",
              { class: "case-sec" },
              h("h3", null, "Jumps", help("Each bar is a jump; its height is the jump's gain. The best 6-jump window is amber. The thin line is sync: the mouse turning toward the side the keys strafe to. Click a bar to watch that jump."), first !== undefined ? h("a", { class: "go-link", href: watchHref(run, first + 1), target: "_blank", rel: "noopener" }, `Watch from jump ${first + 1}`, glyph("ext")) : null),
              rows.length ? jumpStrip(rows, { best: win, onPick: (i) => window.open(watchHref(run, i + 1), "_blank", "noopener") }) : emptyLine("No per-jump stats for this run (analysed before v4)."),
              numbers(x),
            ),
          );
        },
        (e: Error) => my === seq && fill(runSlot, h("p", { class: "err" }, `Couldn't load the run: ${e.message}`)),
      );
    } else runSlot.replaceChildren();
    // The case: stage, assignee, labels, the pinned note, and its timeline. Looking at it marks it seen (seen.ts).
    markSeen("ac", p.user_id);
    void thread(p.user_id).then(
      (t) => {
        if (my !== seq) return;
        const pin = t.notes.find((x) => x.pinned);
        fill(metaSlot, caseProps("ac", p.user_id, { stage: t.case && !t.case.closed_at ? t.case.stage : "triage", assignee: t.case && !t.case.closed_at ? t.case.assignee : null, labels: t.case && !t.case.closed_at ? t.case.labels : [] }, t.staff, { onChange: () => threads.delete(p.user_id) }), pinnedLine(pin, "pin-line big"));
        fill(activity, h("h3", null, "Activity", t.cases > 1 ? h("small", null, `${t.cases} cases on this player`) : null), timeline("ac", p.user_id, t, { onComment: () => threads.delete(p.user_id), stage: () => metaSlot.querySelector<HTMLElement>(".prop-stage")?.className.match(/s-(\w+)/)?.[1] ?? "triage" }));
      },
      (e: Error) => my === seq && fill(activity, h("h3", null, "Activity"), h("p", { class: "err" }, `Couldn't load the case: ${e.message}`)),
    );
    // The player in context.
    void lite(p.user_id).then(
      (d) => {
        if (my !== seq) return;
        const board = run ? d.runs.filter((r) => r.map === run.map && r.style === run.style && r.track === run.track && r.status === "verified" && r.id !== run.run_id) : [];
        const earlier = (d.flags ?? []).filter((f) => f.run_id !== run?.run_id);
        fill(ctxSlot, 
          h(
            "div",
            { class: "ctx-grid" },
            listSection("Earlier flags", flagRows(earlier, 6), "None before this."),
            listSection("Other accounts", [...altRows(d), ...(p.linkedCount && !d.alts.length ? [h("div", { class: "ctx-row faint" }, `${p.linkedCount} on the same device or network.`)] : [])], "None seen."),
            listSection("Bans", d.bans.map((b) => h("div", { class: "ctx-row" }, b.until && b.until < Date.now() ? badge("over") : badge("active", "bad"), h("span", { class: "ctx-msg" }, b.reason ?? "no reason"), h("span", { class: "faint ctx-when" }, ago(b.created_at)))), "Never banned."),
            listSection("Their other times here", board.slice(0, 6).map((r) => h("div", { class: "ctx-row" }, h("span", { class: "t-run" }, fmtTime(r.time)), r.pb ? badge("PB", "acc") : null, h("span", { class: "faint ctx-when" }, ago(r.created_at)))), run ? "No other verified run on this board." : ""),
            listSection("Chat", chatLines(d.chat, 10), "No chat."),
          ),
        );
      },
      (e: Error) => my === seq && fill(ctxSlot, h("p", { class: "err" }, `Couldn't load the player: ${e.message}`)),
    );
  };

  /** The case leaves the queue: its verdict stamps the row, then the next case slides in. */
  const resolve = async (uid: string, word: string, kind: "ink" | "bad" | "warn") => {
    threads.delete(uid);
    const row = list.querySelector<HTMLElement>(`.case-row[data-user="${CSS.escape(uid)}"]`);
    const i = cases.findIndex((c) => c.user_id === uid);
    const nextId = cases[i + 1]?.user_id ?? cases[i - 1]?.user_id ?? null;
    if (review === "open") {
      cases = cases.filter((c) => c.user_id !== uid);
      if (nextId) select(nextId);
      else fill(pane, h("div", { class: "calm-state land" }, hopArc({ size: 120 }), h("p", null, "That was the last open case.")));
      if (row) await stamp(row, word, kind);
      if (!cases.length) paintList();
    } else if (row) void stamp(row, word, kind, false);
  };
  /** Put a resolved case back (Undo). */
  const restore = (p: FlagPlayer, ids: string[]) => {
    for (const r of runs) if (ids.includes(r.run_id)) r.review = null;
    if (!cases.some((c) => c.user_id === p.user_id)) cases.unshift(p);
    paintList();
    select(p.user_id);
  };
  const markReviewed = async (ids: string[], noteText: string | null, resolution = "cleared") => (ids.length ? !!(await api("/admin/integrity", { action: "clear", ids, note: noteText, resolution }).then(() => true, (e) => (toast(String((e as Error).message), true), false))) : true);

  const actions = {
    clear: async (p: FlagPlayer) => {
      const ids = openRuns(p.user_id).map((r) => r.run_id);
      if (!ids.length) return toast("Nothing open in this case.");
      const text = note.value.trim() || null;
      // A player the rule already shadowed (or banned for good) closes as that, not as Cleared: Shadow on them is Un-shadow.
      const [resolution, word, tone] = p.banned && !p.banned.until ? (["banned", "Banned", "bad"] as const) : p.shadow_at ? (["shadowed", "Shadowed", "warn"] as const) : (["cleared", "Cleared", "ink"] as const);
      const r = await act("/admin/integrity", { action: "clear", ids: ids.slice(0, 100), note: text, resolution }, ids.length > 1 ? `${ids.length} flags cleared` : "Cleared", {
        run: async () => (await undoCall("/admin/integrity", { action: "reopen", ids }, "Reopened")) && restore(p, ids),
      });
      if (!r) return;
      rememberReason(text);
      for (const x of runs) if (ids.includes(x.run_id)) (x.review = "cleared"), (x.note = text);
      note.value = "";
      await resolve(p.user_id, word, tone);
    },
    invalidate: async (p: FlagPlayer, run: FlagRun | null) => {
      if (!run) return;
      const v = await ask({ title: `Invalidate ${p.name}'s run on ${run.map}?`, text: `${run.rank === 1 ? "It's the world record: the next run takes it. " : ""}Their PB falls back to their next best run; points and XP are recomputed. The replay is kept.`, fields: [{ name: "reason", label: "Reason (stored on the run)", kind: "text", required: true, value: "Cheating (input script)", list: recentReasons() }], confirm: "Invalidate", danger: true });
      if (!v) return;
      rememberReason(v.reason);
      const done = await invalidateRuns([run.run_id], v.reason);
      if (!done) return;
      await markReviewed([run.run_id], `invalidated: ${v.reason}`, "invalidated");
      run.review = "cleared";
      run.status = "rejected";
      if (!openRuns(p.user_id).length) await resolve(p.user_id, "Invalidated", "bad");
      else select(p.user_id, null, false);
    },
    shadow: async (p: FlagPlayer) => {
      if (!(await shadowDialog({ id: p.user_id, name: p.name, shadow_at: p.shadow_at }))) return;
      if (p.shadow_at) return void ((p.shadow_at = null), select(p.user_id, currentRun, false));
      p.shadow_at = Date.now();
      p.shadow_source = "admin";
      const ids = openRuns(p.user_id).map((r) => r.run_id);
      await markReviewed(ids, "shadowbanned", "shadowed");
      for (const x of runs) if (ids.includes(x.run_id)) x.review = "cleared";
      await resolve(p.user_id, "Shadowed", "warn");
    },
    ban: async (p: FlagPlayer) => {
      const v = await ask({
        title: `Ban ${p.name} and invalidate all their runs?`,
        lead: h("p", { class: "dlg-impact" }, `${plural(p.verified, "verified run")}${p.wrs ? `, ${plural(p.wrs, "world record")}` : ""}${p.top10s ? `, ${plural(p.top10s, "top 10")}` : ""}.`),
        text: "A permanent ban everywhere. Every run that counts is invalidated: PBs fall back, points and XP are recomputed. Replays are kept. Their flags are marked actioned.",
        fields: [{ name: "reason", label: "Reason (they see it on the ban)", kind: "text", value: "Cheating (input script)", required: true, list: recentReasons() }],
        confirm: "Ban and invalidate",
        danger: true,
      });
      if (!v) return;
      rememberReason(v.reason);
      let total = 0;
      for (let i = 0; i < 20; i++) {
        const r = await act<{ invalidated: number; remaining: number }>("/admin/integrity", { action: "ban-invalidate", user: p.user_id, reason: v.reason }, "");
        if (!r) return;
        total += r.invalidated;
        if (!r.remaining) break;
      }
      // Not undoable in one step (every run is re-scored): the moderation log can reverse the ban and each run.
      toast(`Banned ${p.name}; ${plural(total, "run")} invalidated`);
      p.banned = { until: null, reason: v.reason };
      for (const x of runs) if (x.user_id === p.user_id && !x.review) x.review = "actioned";
      await resolve(p.user_id, "Banned", "bad");
    },
    approve: async (p: FlagPlayer, run: FlagRun) => {
      const v = await ask({ title: `Approve ${p.name}'s run on ${run.map}?`, text: "Overrides the automatic rejection for this run only. It's verified again and counts if it passes.", fields: [{ name: "note", label: "Why (staff only)", kind: "text", required: true }], confirm: "Approve", danger: true });
      if (v && (await act("/admin/integrity", { action: "approve", ids: [run.run_id], note: v.note }, "Approved; verifying again"))) {
        run.review = "approved";
        if (!openRuns(p.user_id).length) await resolve(p.user_id, "Approved", "ink");
      }
    },
    watch: (run: FlagRun | null) => {
      if (!run) return;
      void detail(run.run_id)
        .then((x) => [...bestWindow(x.features?.jumps?.rows ?? [])][0])
        .catch(() => undefined)
        .then((i) => window.open(watchHref(run, i === undefined ? undefined : i + 1), "_blank", "noopener"));
    },
  };

  const actionBar = (p: FlagPlayer, run: FlagRun | null) => {
    const open = openRuns(p.user_id).length;
    const key = (k: string) => h("kbd", { class: "act-key", "aria-hidden": "true" }, k);
    return h(
      "div",
      { class: "case-actions" },
      may("integrity.review") && open
        ? h("form", { class: "clear-form", onsubmit: (e: Event) => (e.preventDefault(), void actions.clear(p)) }, note, h("button", { type: "submit", class: "primary" }, "Clear", key("c")))
        : null,
      may("runs.manage") && run && run.status !== "rejected" ? h("button", { type: "button", class: "danger", onclick: () => void actions.invalidate(p, run) }, "Invalidate run", key("i")) : null,
      mayShadow(!!p.shadow_at, p.shadow_source) ? h("button", { type: "button", class: p.shadow_at ? "" : "danger", onclick: () => void actions.shadow(p) }, p.shadow_at ? "Lift shadowban" : "Shadowban", key("s")) : null,
      may("integrity.ban") && !(p.banned && !p.verified) ? h("button", { type: "button", class: "danger", onclick: () => void actions.ban(p) }, "Ban and invalidate", key("b")) : null,
      run && run.tier === "blatant" && run.status === "rejected" && run.reason === INHUMAN_REASON && run.review !== "approved" && may("integrity.approve") ? h("button", { type: "button", onclick: () => void actions.approve(p, run) }, "Approve…") : null,
      h("span", { class: "spacer" }),
      run ? h("button", { type: "button", class: "ghost", onclick: () => actions.watch(run) }, glyph("play"), "Watch", key("w")) : null,
    );
  };

  // --- the page
  const reviewSel = h("select", { "aria-label": "Show" }, REVIEW.map(([v, l]) => h("option", { value: v, selected: review === v }, l)));
  const tierSel = h("select", { "aria-label": "Tier" }, [["", "Any tier"], ["blatant", "Blatant"], ["suspicious", "Suspicious"], ["review", "Review notes only"]].map(([v, l]) => h("option", { value: v, selected: tier === v }, l)));
  const refilter = () => {
    const p = new URLSearchParams();
    p.set("review", reviewSel.value);
    if (tierSel.value) p.set("tier", tierSel.value);
    location.hash = `#/suspicious?${p}`;
  };
  reviewSel.onchange = refilter;
  tierSel.onchange = refilter;
  // Flags of players already shadowed or banned are closed on arrival (apps/api src/shadow.ts): say so, with the way in.
  const autoWeek = data.autoClosedWeek ?? 0;
  const sub = h(
    "span",
    { class: "sub" },
    cases.length ? `${plural(cases.length, "case")}, ${plural(runs.filter((r) => !r.review).length, "open flag")}` : "",
    autoWeek ? h("a", { class: "sub-link", href: "#/suspicious?review=auto", title: "Flags of players who were already shadowed or banned: kept as evidence, closed on arrival" }, `${cases.length ? " · " : ""}${plural(autoWeek, "flag")} of shadowed players closed this week`) : null,
  );
  // The backlog from before flags were closed on arrival (admins): one idempotent call.
  const backlog = data.shadowedOpen ?? 0;
  const closeBacklog = backlog && may("integrity.ban")
    ? h("button", {
        type: "button",
        class: "ghost",
        title: "Open flags that shadowed players got after their shadowban. They're kept as evidence, marked already shadowed.",
        onclick: async () => {
          const r = await act<{ closed: number; players: number }>("/admin/integrity", { action: "close-shadowed" }, "");
          if (!r) return;
          toast(`Closed ${plural(r.closed, "flag")} of ${plural(r.players, "shadowed player")}`);
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        },
      }, `Close ${plural(backlog, "flag")} of shadowed players`)
    : null;
  fill(root, 
    h(
      "div",
      { class: "view-bar" },
      sub,
      h(
        "div",
        { class: "tools" },
        closeBacklog,
        h("label", { class: "inline-sel" }, "Show", reviewSel),
        h("label", { class: "inline-sel" }, tierSel),
        help("A blatant run shadowbans its player automatically: their run stays verified for them, and nobody else sees their runs, ranks, profile or chat. Later flags of a shadowed or banned player are closed on arrival (Show: Already shadowed). Suspicious runs stay verified. Scores run 0 to 100. Review notes never count toward a score. Keys: j / k move, c clear (Enter in the note), i invalidate, s shadowban, b ban and invalidate, w watch."),
      ),
    ),
    h("datalist", { id: "case-reasons" }, recentReasons().map((x) => h("option", { value: x }))),
    h("div", { class: "cases" }, list, pane),
  );
  paintList();
  const first = caseParam && cases.some((c) => c.user_id === caseParam) ? caseParam : cases[0]?.user_id;
  if (first) select(first, runParam, false);
  else fill(pane, review === "open" ? h("div", { class: "calm-state" }, hopArc({ size: 120, cls: "still" }), h("p", null, "Nothing is waiting.")) : emptyLine("Nothing matches."));

  const cur = () => cases.find((c) => c.user_id === current) ?? null;
  const curRun = () => runs.find((r) => r.run_id === currentRun) ?? null;
  const step = (d: number) => {
    const i = cases.findIndex((c) => c.user_id === current);
    const next = cases[Math.max(0, Math.min(cases.length - 1, i + d))];
    if (next && next.user_id !== current) select(next.user_id);
  };
  setKeys({
    j: () => step(1),
    k: () => step(-1),
    c: () => may("integrity.review") && note.isConnected && note.focus(),
    i: () => cur() && may("runs.manage") && void actions.invalidate(cur()!, curRun()),
    s: () => cur() && mayShadow(!!cur()!.shadow_at, cur()!.shadow_source) && void actions.shadow(cur()!),
    b: () => cur() && may("integrity.ban") && void actions.ban(cur()!),
    w: () => actions.watch(curRun()),
  });
};
