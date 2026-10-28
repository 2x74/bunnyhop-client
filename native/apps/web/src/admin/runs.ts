// Anticheat → Runs: every run with filters, and bulk work by paste. "Paste run ids" takes any list (any separator),
// shows each run with its board rank and, for a WR, who would hold it next; then one reason and one confirm invalidates
// them all (100 per request), with Undo. A rejected run's Restore puts it back through verification. And Signals: the
// pooled review, gain jumps and Legit jumps (the server keeps each list 10 minutes).

import { act, ago, api, ask, badge, fmtTime, glyph, h, help, may, n, playerLink, plural, setKeys, short, stepRows, table, toast, when, type View, fill } from "./core";
import { mapLine } from "./art";
import { attemptText, type SessionAttempt } from "./cases";
import { recentReasons, rememberReason } from "./dialogs";
import { stamp } from "./ui";

interface RunRow {
  id: string;
  user_id: string;
  user_name: string;
  map: string;
  style: string;
  track: number;
  status: string;
  reason: string | null;
  ticks: number | null;
  time: number | null;
  attempts: number;
  room_id: string | null;
  client_build: string;
  verifier_build: string | null;
  physics?: number;
  created_at: number;
  verified_at: number | null;
  pb: number | null;
  diagnostics?: RunDiagnostics | null;
  session?: SessionAttempt | null;
}

interface RunDiagnostics {
  selfCheck: "ok" | "mismatch" | "error";
  firstMismatchTick?: number;
  problems?: string[];
  checkMs?: number;
  ua?: string;
  wasm?: string;
  web?: string;
  version?: string;
  fps?: number;
  input?: Record<string, number | string | boolean>;
  visibility?: { hidden: number; hiddenMs: number; blurs: number };
}

const STYLE_WORD: Record<string, string> = { autohop: "Normal", legit: "EZ Scroll", scroll: "Legit Scroll", wonly: "W-Only", sideways: "Sideways", hsw: "Half-Sideways", autostrafe: "Auto-strafe" };
export const styleWord = (s: string) => STYLE_WORD[s] ?? s;
export const statusBadge = (s: string) => badge(s, s === "verified" ? "ok" : s === "rejected" || s === "error" ? "bad" : "");

/** "Chrome 141", "Firefox 132", "Safari 18.4" from a user agent. */
function browserName(ua = ""): string {
  const m = /(Edg|OPR|Firefox|Chrome|CriOS|FxiOS)\/(\d+)/.exec(ua) ?? (/Version\/([\d.]+).*Safari/.exec(ua) ? ["", "Safari", /Version\/([\d.]+)/.exec(ua)![1]] : null);
  if (!m) return ua ? "other" : "?";
  const name = ({ Edg: "Edge", OPR: "Opera", CriOS: "Chrome iOS", FxiOS: "Firefox iOS" } as Record<string, string>)[m[1]] ?? m[1];
  return `${name} ${m[2]}${/Mobile|Android|iPhone|iPad/.test(ua) ? " (mobile)" : ""}`;
}

/** The client's self-check verdict and its numbers as label / value lines. */
function clientCell(d: RunDiagnostics | null | undefined): HTMLElement {
  if (!d) return h("td", { class: "faint" }, "—");
  const verdict = d.selfCheck === "mismatch" ? badge(d.firstMismatchTick !== undefined ? `desync at ${d.firstMismatchTick}` : "desync", "bad") : d.selfCheck === "error" ? badge("check failed", "warn") : badge("ok", "ok");
  const i = d.input ?? {};
  const v = d.visibility;
  const rows: [string, string | null][] = [
    ["Problems", d.problems?.length ? d.problems.join(", ") : null],
    ["Check", d.checkMs !== undefined ? `${d.checkMs} ms` : null],
    ["Browser", d.ua ? browserName(d.ua) : null],
    ["Version", d.version ? `v${d.version}` : null],
    ["Web build", d.web?.replace(/^\/assets\//, "") ?? null],
    ["Engine", d.wasm?.replace("bunnyhop-web/", "") ?? null],
    ["FPS", d.fps !== undefined ? `${d.fps} average, frame p99 ${i.frameP99 ?? "?"} ms, worst ${i.worstFrame ?? "?"} ms` : null],
    ["Long tasks", i.longTasks !== undefined ? String(i.longTasks) : null],
    ["Mouse", i.lock !== undefined ? `${i.lock}, ${i.pollHz ?? "?"} Hz, ${i.spikes ?? 0} spikes, ${i.discards ?? 0} discards${i.filter === false ? ", filter off" : ""}` : null],
    ["Tab", v ? `hidden ${v.hidden}× (${(v.hiddenMs / 1000).toFixed(1)} s), ${v.blurs} blurs` : null],
  ];
  return h(
    "td",
    null,
    verdict,
    h("details", { class: "client-more" }, h("summary", { class: "faint" }, browserName(d.ua)), h("dl", { class: "kv tight" }, rows.filter(([, x]) => x).flatMap(([k, x]) => [h("dt", null, k), h("dd", null, x!)]))),
  );
}

interface Preview {
  id: string;
  user_id: string;
  user_name: string;
  map: string;
  style: string;
  track: number;
  status: string;
  reason: string | null;
  time: number | null;
  created_at: number;
  pb: number | null;
  rank: number | null;
  wr: boolean;
  next: { name: string; userId: string; time: number | null } | null;
}

/** Run ids from pasted text: any separator, deduplicated, in order. */
export const parseIds = (text: string) => [...new Set(text.match(/[A-Za-z0-9_-]{6,64}/g) ?? [])];

const chunks = <T>(a: T[], k: number) => Array.from({ length: Math.ceil(a.length / k) }, (_, i) => a.slice(i * k, i * k + k));

/** Invalidate (or restore) runs 100 at a time; resolves with the ids done. */
async function inChunks(action: "invalidate" | "reverify", ids: string[], reason?: string): Promise<string[]> {
  const done: string[] = [];
  for (const c of chunks(ids, 100)) {
    const r = await api<{ invalidated?: string[]; queued?: string[] }>("/admin/runs", { action, ids: c, ...(reason ? { reason } : {}) });
    done.push(...(r.invalidated ?? r.queued ?? []));
  }
  return done;
}

/** Invalidate these runs with an Undo that restores them (re-verification). */
export async function invalidateRuns(ids: string[], reason: string): Promise<string[] | null> {
  try {
    const done = await inChunks("invalidate", ids, reason);
    toast(`${plural(done.length, "run")} invalidated`, false, {
      label: "Undo",
      hold: 10_000,
      run: async () => {
        const back = await inChunks("reverify", done).catch((e) => (toast(`Couldn't undo: ${(e as Error).message}`, true), null));
        if (back) toast(`${plural(back.length, "run")} back in verification`);
      },
    });
    return done;
  } catch (e) {
    toast(String((e as Error).message), true);
    return null;
  }
}

/** The paste panel: ids in, an impact preview, then invalidate or restore them all. */
function pastePanel(onDone: () => void): HTMLElement {
  const text = h("textarea", { placeholder: "Run ids, any separator", rows: "4", class: "mono" });
  const out = h("div");
  const look = async () => {
    const ids = parseIds(text.value).slice(0, 500);
    if (!ids.length) return toast("No run ids in there.", true);
    fill(out, h("p", { class: "faint" }, `Looking up ${plural(ids.length, "run")}…`));
    let rows: Preview[] = [];
    const missing: string[] = [];
    try {
      for (const c of chunks(ids, 100)) {
        const r = await api<{ runs: Preview[]; missing: string[] }>("/admin/runs", { action: "preview", ids: c });
        rows = rows.concat(r.runs);
        missing.push(...r.missing);
      }
    } catch (e) {
      return fill(out, h("p", { class: "err" }, (e as Error).message));
    }
    rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    const live = rows.filter((r) => r.status !== "rejected");
    const dead = rows.filter((r) => r.status === "rejected");
    const wrs = rows.filter((r) => r.wr);
    const reason = h("input", { type: "text", placeholder: "Reason, stored on each run", list: "paste-reasons", required: true });
    const doInvalidate = async () => {
      if (!reason.value.trim()) return toast("Give a reason.", true), reason.focus();
      const v = await ask({
        title: `Invalidate ${plural(live.length, "run")}?`,
        text: `${wrs.length ? `${plural(wrs.length, "world record")} change hands. ` : ""}PBs fall back to each player's next best run, and points and XP are recomputed. Replays are kept.`,
        confirm: `Invalidate ${live.length}`,
        danger: true,
      });
      if (!v) return;
      rememberReason(reason.value);
      if (await invalidateRuns(live.map((r) => r.id), reason.value.trim())) onDone();
    };
    const doRestore = async () => {
      if (!(await ask({ title: `Restore ${plural(dead.length, "run")}?`, text: "Each goes back through verification and counts again if it passes.", confirm: `Restore ${dead.length}` }))) return;
      try {
        const done = await inChunks("reverify", dead.map((r) => r.id));
        toast(`${plural(done.length, "run")} back in verification`);
        onDone();
      } catch (e) {
        toast(String((e as Error).message), true);
      }
    };
    fill(out, 
      table(
        ["Player", "Map", "Style", ["Time", "num"], "Now", "On the board", ""],
        rows.map((r) =>
          h(
            "tr",
            null,
            h("td", null, playerLink(r.user_id, r.user_name)),
            h("td", null, mapLine(r.map, { track: r.track })),
            h("td", null, styleWord(r.style)),
            h("td", { class: "num" }, h("span", { class: "t-run" }, fmtTime(r.time))),
            h("td", null, statusBadge(r.status), r.pb ? badge("PB", "acc") : null),
            h("td", null, r.wr ? [h("b", { class: "wr" }, "WR"), r.next ? h("span", { class: "faint" }, ` next: ${r.next.name} ${fmtTime(r.next.time)}`) : h("span", { class: "faint" }, " nobody next")] : r.rank ? `#${r.rank}` : h("span", { class: "faint" }, "not a PB")),
            h("td", { class: "faint mono" }, short(r.id)),
          ),
        ),
        "None of those ids are runs.",
      ),
      missing.length ? h("p", { class: "faint" }, `Not found: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ` and ${missing.length - 8} more` : ""}.`) : null,
      h("datalist", { id: "paste-reasons" }, recentReasons().map((x) => h("option", { value: x }))),
      rows.length
        ? h(
            "div",
            { class: "filters paste-go" },
            live.length ? [h("label", null, "Reason", reason), h("button", { class: "danger", onclick: () => void doInvalidate() }, glyph("ban"), `Invalidate ${live.length}`)] : null,
            dead.length ? h("button", { onclick: () => void doRestore() }, glyph("undo"), `Restore ${dead.length} rejected`) : null,
          )
        : null,
    );
  };
  return h(
    "section",
    { class: "card paste" },
    h("h2", null, "Paste run ids", help("Paste a list of run ids from anywhere: a message, a spreadsheet, a curl output. You see each run's place on its board before anything happens.")),
    text,
    h("div", { class: "actions" }, h("button", { class: "primary", onclick: () => void look() }, "Look up"), h("span", { class: "faint" }, "Up to 500 at once.")),
    out,
  );
}

export const runsView: View = async (root, params) => {
  const f = {
    status: h("select", null, [["", "Any status"], ["queued", "Queued"], ["verifying", "Verifying"], ["verified", "Verified"], ["rejected", "Rejected"], ["error", "Error"]].map(([v, l]) => h("option", { value: v, selected: (params.get("status") ?? "") === v }, l))),
    map: h("input", { type: "search", placeholder: "bhop_kz_ravine", value: params.get("map") ?? "" }),
    user: h("input", { type: "search", placeholder: "player id", value: params.get("user") ?? "" }),
    reason: h("input", { type: "search", placeholder: "words", value: params.get("reason") ?? "" }),
    id: h("input", { type: "search", placeholder: "run id", value: params.get("id") ?? "" }),
    selfCheck: h("select", null, [["", "Any"], ["mismatch", "Desync"], ["ok", "Self-check ok"], ["error", "Self-check failed"], ["none", "No diagnostics"]].map(([v, l]) => h("option", { value: v, selected: (params.get("selfCheck") ?? "") === v }, l))),
  };
  const manage = may("runs.manage");
  const selected = new Set<string>();
  const body = h("tbody");
  const moreBtn = h("button", { type: "button" }, "Load older");
  const count = h("span", { class: "sub" });
  const selInfo = h("span", { class: "faint" }, "0 picked");
  const all = h("input", { type: "checkbox", title: "Pick every run shown", "aria-label": "Pick every run shown" });
  let next: string | null = null;
  let shown: RunRow[] = [];
  const refreshSel = () => (selInfo.textContent = `${selected.size} picked`);
  const query = (before: string | null) => {
    const q = new URLSearchParams();
    for (const k of ["status", "map", "user", "reason", "id", "selfCheck"] as const) if (f[k].value.trim()) q.set(k, f[k].value.trim());
    if (before) q.set("before", before);
    q.set("limit", "100");
    return q;
  };
  const row = (r: RunRow) => {
    const cb = h("input", { type: "checkbox", checked: selected.has(r.id), "aria-label": "Pick", onchange: (e: Event) => ((e.target as HTMLInputElement).checked ? selected.add(r.id) : selected.delete(r.id), refreshSel()) });
    const restore =
      manage && (r.status === "rejected" || r.status === "error")
        ? h("button", {
            class: "small ghost",
            onclick: async (e: Event) => {
              const tr = (e.currentTarget as HTMLElement).closest("tr") as HTMLElement;
              if (r.status === "rejected" && !(await ask({ title: `Restore this run of ${r.user_name}?`, text: "It goes back through verification and counts again if it passes.", confirm: "Restore" }))) return;
              if (await act("/admin/runs", { action: "reverify", ids: [r.id] }, r.status === "rejected" ? "Restored: back in verification" : "Back in verification")) void stamp(tr, "Queued", "ink", false);
            },
          }, glyph("undo"), r.status === "rejected" ? "Restore" : "Re-verify")
        : null;
    return h(
      "tr",
      { "data-id": r.id },
      manage ? h("td", null, cb) : null,
      h("td", { class: "nowrap" }, playerLink(r.user_id, r.user_name)),
      h("td", null, mapLine(r.map, { track: r.track })),
      h("td", null, styleWord(r.style)),
      h("td", { class: "num" }, h("a", { class: "t-run", href: r.status === "verified" ? `/replay/${encodeURIComponent(r.id)}` : `/?replay=run:${encodeURIComponent(r.id)}`, target: "_blank", rel: "noopener", title: "Watch" }, fmtTime(r.time))),
      h("td", { class: "nowrap" }, statusBadge(r.status), r.pb ? badge("PB", "acc") : null, r.physics === 1 ? badge("physics 1") : null),
      h("td", { class: "msg" }, r.reason ?? "", r.room_id ? h("div", { class: "faint" }, `in ${r.room_id}`) : null),
      h("td", { class: "num", title: attemptText(r.session) ?? "No attempt counter (an older client)" }, r.session ? `#${r.session.attempt}` : "—", h("div", null, h("a", { href: `#/suspicious?run=${encodeURIComponent(r.id)}`, class: "faint" }, "analysis"))),
      h("td", { class: "time", title: when(r.created_at) }, ago(r.created_at), r.attempts > 1 ? h("div", { class: "faint" }, `${r.attempts} tries`) : null),
      clientCell(r.diagnostics),
      h("td", { class: "acts" }, restore, h("span", { class: "mono faint id", title: `${r.id}\nverifier ${r.verifier_build ?? "—"}, physics ${r.physics ?? 1}` }, short(r.id))),
    );
  };
  const load = async (reset: boolean) => {
    const r = await api<{ runs: RunRow[]; next: string | null }>(`/admin/runs?${query(reset ? null : next)}`);
    if (reset) {
      body.replaceChildren();
      shown = [];
      selected.clear();
      all.checked = false;
      refreshSel();
    }
    shown.push(...r.runs);
    for (const x of r.runs) body.appendChild(row(x));
    if (reset && !r.runs.length) body.appendChild(h("tr", null, h("td", { colspan: "11", class: "empty" }, "No runs match.")));
    next = r.next;
    moreBtn.hidden = !next;
    count.textContent = `${shown.length} runs`;
  };
  all.onchange = () => {
    for (const r of shown) all.checked ? selected.add(r.id) : selected.delete(r.id);
    body.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((c) => (c.checked = all.checked));
    refreshSel();
  };
  const reverify = async () => {
    if (!selected.size) return toast("Pick runs first.", true);
    if (!(await ask({ title: `Put ${plural(selected.size, "run")} back through verification?`, text: "Verified runs are skipped: invalidate them first.", confirm: "Re-verify" }))) return;
    const r = await act<{ queued: string[]; skipped: { id: string; why: string }[] }>("/admin/runs", { action: "reverify", ids: [...selected].slice(0, 100) }, "");
    if (r) {
      toast(`${r.queued.length} queued${r.skipped.length ? `, ${r.skipped.length} skipped (${r.skipped[0].why})` : ""}`);
      await load(true);
    }
  };
  const invalidate = async () => {
    if (!selected.size) return toast("Pick runs first.", true);
    const v = await ask({
      title: `Invalidate ${plural(selected.size, "run")}?`,
      text: "PBs fall back to each player's next best run, and points and XP are recomputed. Replays are kept.",
      fields: [{ name: "reason", label: "Reason (stored on the run)", kind: "text", required: true, list: recentReasons() }],
      confirm: "Invalidate",
      danger: true,
    });
    if (!v) return;
    rememberReason(v.reason);
    if (await invalidateRuns([...selected], v.reason)) await load(true);
  };
  moreBtn.onclick = () => void load(false);
  const QUICK: [string, string, string][] = [["All", "", ""], ["Queued", "queued", ""], ["Rejected", "rejected", ""], ["Errors", "error", ""], ["Desync", "", "mismatch"]];
  const quick = h("div", { class: "seg", role: "group", "aria-label": "Quick views" });
  const paintQuick = () =>
    fill(quick, 
      ...QUICK.map(([label, st, sc]) =>
        h("button", { type: "button", "aria-pressed": String(f.status.value === st && f.selfCheck.value === sc), onclick: () => ((f.status.value = st), (f.selfCheck.value = sc), paintQuick(), history.replaceState(null, "", `#/runs?${query(null)}`), void load(true)) }, label),
      ),
    );
  paintQuick();
  const paste = manage ? pastePanel(() => void load(true)) : null;
  if (paste) paste.hidden = params.get("paste") !== "1";
  fill(root, 
    h("div", { class: "view-bar" }, count, h("div", { class: "tools" }, quick, paste ? h("button", { onclick: () => ((paste.hidden = !paste.hidden), !paste.hidden && paste.querySelector("textarea")?.focus()) }, glyph("paste"), "Paste run ids") : null)),
    paste,
    h(
      "form",
      { class: "filters", onsubmit: (e: Event) => (e.preventDefault(), history.replaceState(null, "", `#/runs?${query(null)}`), paintQuick(), void load(true)) },
      h("label", null, "Status", f.status),
      h("label", null, "Map", f.map),
      h("label", null, "Player", f.user),
      h("label", null, "Reason", f.reason),
      h("label", null, "Run", f.id),
      h("label", null, "Client", f.selfCheck),
      h("button", { type: "submit", class: "primary" }, "Filter"),
    ),
    manage ? h("div", { class: "filters picked" }, selInfo, h("button", { type: "button", onclick: reverify }, glyph("refresh"), "Re-verify"), h("button", { type: "button", class: "danger", onclick: invalidate }, glyph("ban"), "Invalidate…")) : null,
    h(
      "div",
      { class: "tablewrap" },
      h(
        "table",
        { class: "runs-table" },
        h("thead", null, h("tr", null, manage ? h("th", null, all) : null, ["Player", "Map", "Style", "Time", "Status", "Reason", "Attempt", "Sent", "Client", ""].map((t) => h("th", { class: t === "Time" || t === "Attempt" ? "num" : undefined }, t)))),
        body,
      ),
    ),
    h("div", { class: "more" }, moreBtn),
  );
  await load(true);
  const rows = () => [...body.querySelectorAll<HTMLElement>("tr[data-id]")];
  setKeys({
    j: () => void stepRows(rows(), 1),
    k: () => void stepRows(rows(), -1),
    x: () => {
      const cb = body.querySelector<HTMLInputElement>("tr.cur input[type=checkbox]");
      if (cb) (cb.checked = !cb.checked), cb.dispatchEvent(new Event("change"));
    },
  });
};

// ---------------------------------------------------------------------------------------------
// Signals

interface PooledRow {
  user_id: string;
  pooled: { score: number; runs: number; parts: { code: string; n: number; z: number; board?: number }[] };
  user: { id: string; name: string; shadow_at: number | null; banned: number } | null;
  consistency: { map: string; style: string; text: string } | null;
}
interface GainJumpRow {
  user_id: string;
  gainJump: { score: number; listed: boolean; runs: string[]; history: number; gainBefore: number; gainAfter: number; zBefore: number; zAfter: number };
  user: { id: string; name: string; shadow_at: number | null; banned: number } | null;
}
interface LegitJumpRow {
  user_id: string;
  legitJumps: { z: number | null; runs: number; landings: number; off: number[]; cv: number | null; rhythmHops: number; fixed?: number | null; floor?: number | null; trains?: number; listed: boolean };
  user: { id: string; name: string; shadow_at: number | null; banned: number } | null;
}

const who = (id: string, u: { name: string; shadow_at: number | null; banned: number } | null) => h("td", null, playerLink(id, u?.name ?? id), u?.banned ? badge("banned", "bad") : null, u?.shadow_at ? badge("shadowed", "warn") : null);
const signed = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}`;
const caseLink = (id: string) => h("a", { class: "btn small ghost", href: `#/suspicious?case=${encodeURIComponent(id)}` }, "Case");

export const signalsView: View = async (root) => {
  const section = (title: string, about: string, load: (out: HTMLElement, stamp: HTMLElement) => Promise<void>) => {
    const out = h("div");
    const fresh = h("span", { class: "faint" });
    const btn = h("button", { type: "button", class: "small", onclick: async () => {
      btn.disabled = true;
      fill(out, h("p", { class: "faint" }, "Working it out. The first look takes a few seconds."));
      try {
        await load(out, fresh);
        btn.textContent = "Refresh";
      } catch (e) {
        fill(out, h("p", { class: "err" }, (e as Error).message));
      }
      btn.disabled = false;
    } }, "Show");
    return h("section", { class: "card" }, h("h2", null, title, help(about), btn, fresh), out);
  };
  const computed = (el: HTMLElement, at?: number) => (el.textContent = at ? `as of ${ago(at)}` : "");
  fill(root, 
    h("p", { class: "lede" }, "Context for a case, never a verdict on its own."),
    section(
      "Pooled review",
      "Weak per-run signals (reaction, aim spread, key timing, per-jump gain spread) against humans of the same skill on the same board where it has enough runs, pooled over each player's Normal and EZ Scroll runs. About 5 is the human 99.5th percentile. A high score can be a player's own style.",
      async (out, fresh) => {
        const x = await api<{ days: number; players: number; bar: number; listed: number; rows: PooledRow[]; computedAt?: number }>("/admin/integrity/pooled?days=90&limit=50");
        computed(fresh, x.computedAt);
        fill(out, 
          h("p", { class: "faint" }, `${n(x.players)} players in 90 days, ${n(x.listed)} at ${x.bar} or more.`),
          table(
            [["Score", "num"], "Player", ["Runs", "num"], "Parts", "Tightest board", ""],
            x.rows.map((r) => h("tr", null, h("td", { class: `num ${r.pooled.score >= x.bar ? "warn-text" : ""}` }, r.pooled.score.toFixed(1)), who(r.user_id, r.user), h("td", { class: "num" }, r.pooled.runs), h("td", { class: "msg" }, r.pooled.parts.map((p) => h("span", { class: "part" }, `${p.code} ${signed(p.z)}`)) as unknown as HTMLElement), h("td", { class: "msg faint" }, r.consistency ? `${r.consistency.map}: ${r.consistency.text}` : "—"), h("td", null, caseLink(r.user_id)))),
            "Nobody has enough runs.",
          ),
        );
      },
    ),
    section(
      "Gain jumps",
      "Players whose two newest Normal runs sit far above their own earlier level, with gain read against each board's other players. A strafe optimizer switched on looks like this; so does real progress, or an uncapped frame rate.",
      async (out, fresh) => {
        const x = await api<{ players: number; bar: number; listed: number; rows: GainJumpRow[]; computedAt?: number }>("/admin/integrity/gain-jumps?limit=50");
        computed(fresh, x.computedAt);
        fill(out, 
          h("p", { class: "faint" }, `${n(x.players)} players, ${n(x.listed)} at ${x.bar} or more.`),
          table(
            [["Jump", "num"], "Player", ["Gain", "num"], ["Against the board", "num"], ["Runs", "num"], ""],
            x.rows.map((r) => h("tr", null, h("td", { class: `num ${r.gainJump.listed ? "warn-text" : ""}` }, r.gainJump.score.toFixed(1)), who(r.user_id, r.user), h("td", { class: "num" }, `${r.gainJump.gainBefore.toFixed(3)} to ${r.gainJump.gainAfter.toFixed(3)}`), h("td", { class: "num" }, `${signed(r.gainJump.zBefore, 2)} to ${signed(r.gainJump.zAfter, 2)}`), h("td", { class: "num" }, `${r.gainJump.history} + ${r.gainJump.runs.length}`), h("td", { class: "acts" }, ...r.gainJump.runs.map((id) => h("a", { class: "btn small ghost", href: `#/suspicious?run=${encodeURIComponent(id)}` }, "Run")), caseLink(r.user_id)))),
            "Nobody has enough runs.",
          ),
        );
      },
    ),
    section(
      "Legit jumps",
      "EZ Scroll players by their jump presses: a spike of presses exactly on the landing tick (a jump script) or a fixed-period press train (a timer loop). Humans on 2026-10-10: spike z 1.9 at most. Rhythm (v9 runs only): the gap CV off the 2-tick floor, where a fast wheel lands (humans 0.19 at least); Fixed: trains at one exact gap of 3+ ticks (humans 1% at most but one).",
      async (out, fresh) => {
        const x = await api<{ players: number; bar: number; listed: number; rows: LegitJumpRow[]; computedAt?: number }>("/admin/integrity/legit-jumps?limit=50");
        computed(fresh, x.computedAt);
        fill(out, 
          h("p", { class: "faint" }, `${n(x.players)} players, ${n(x.listed)} listed.`),
          table(
            [["Spike", "num"], "Player", ["Runs", "num"], "Presses around landing", ["Rhythm", "num"], ["Fixed", "num"], ""],
            x.rows.map((r) => h("tr", null, h("td", { class: `num ${r.legitJumps.listed ? "warn-text" : ""}` }, r.legitJumps.z === null ? "—" : r.legitJumps.z.toFixed(1)), who(r.user_id, r.user), h("td", { class: "num" }, `${r.legitJumps.runs}`), h("td", null, pressBars(r.legitJumps.off.slice(4, 9))), h("td", { class: "num" }, r.legitJumps.cv === null ? "—" : `${r.legitJumps.cv}`), h("td", { class: "num" }, r.legitJumps.trains ? `${Math.round((r.legitJumps.fixed ?? 0) * 100)}%` : "—"), h("td", null, caseLink(r.user_id)))),
            "Nobody has Legit runs analysed.",
          ),
        );
      },
    ),
  );
};

/** Presses two ticks before the landing to two after, as five small bars (the landing tick in the middle). */
function pressBars(v: number[]): HTMLElement {
  const max = Math.max(1, ...v);
  return h(
    "span",
    { class: "press-bars", title: v.join(", ") },
    v.map((x, i) => h("i", { class: i === 2 ? "on" : "", style: `--v:${(x / max).toFixed(3)}` })),
  );
}
