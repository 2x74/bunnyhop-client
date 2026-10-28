// Queue: the home page. One list of everything waiting on staff, by kind: anticheat cases, tickets waiting on staff (new,
// or the player wrote back), flagged names, moderators' term suggestions and runs that failed to verify. Each row opens
// its case; names, suggestions and errors are settled right here. j / k move, Enter opens. Only the kinds the viewer
// may act on (GET /admin/queue decides). When the last item clears, the hop arc lands on "Nothing is waiting".

import { act, age, api, badge, glyph, h, may, n, playerLink, poll, setKeys, stepRows, undoCall, type View, fill } from "./core";
import { hopArc, stamp } from "./ui";
import { mapArt } from "./art";
import { ring } from "./charts";

interface QueueData {
  now: number;
  cases?: { total: number; items: { user_id: string; name: string; score: number; runs: number; blatant: number; since: number; map: string; run: string; headline: string | null }[] };
  tickets?: { total: number; items: { id: string; user_id: string | null; user_name: string | null; category: string; message: string; map: string | null; status: string; created_at: number; player_reply_at: number | null }[] };
  names?: { total: number; items: { id: string; name: string; problem: string }[] };
  suggestions?: { total: number; items: { term: string; whole: boolean; by: string | null; byName: string | null; at: number; reason: string | null }[] };
  errors?: { total: number; items: { id: string; user_id: string; user_name: string; map: string; style: string; track: number; reason: string | null; attempts: number; created_at: number }[] };
}

const total = (q: QueueData) => (q.cases?.total ?? 0) + (q.tickets?.total ?? 0) + (q.names?.total ?? 0) + (q.suggestions?.total ?? 0) + (q.errors?.total ?? 0);

/** The rail's number on Queue: everything waiting. */
export function setQueueBadge(count: number): void {
  const b = document.getElementById("queue-badge");
  if (!b) return;
  b.textContent = count > 99 ? "99+" : String(count);
  b.hidden = count <= 0;
  b.title = `${count} waiting`;
}

let lastBadge = 0;
export async function refreshQueueBadge(force = false): Promise<void> {
  // The list is a few hundred rows read; away from the Queue it refreshes every five minutes at most.
  if (!force && Date.now() - lastBadge < 300_000) return;
  lastBadge = Date.now();
  try {
    setQueueBadge(total(await api<QueueData>("/admin/queue")));
  } catch {
    /* badge only */
  }
}

const FB_WORD: Record<string, string> = { bug: "Bug", physics: "Physics", map: "Map", tier: "Map tier", multiplayer: "Multiplayer", idea: "Idea", other: "Other", application: "Application", report: "Player report" };

export const queueView: View = async (root) => {
  let data = await api<QueueData>("/admin/queue");
  let hadItems = total(data) > 0;
  const body = h("div", { class: "queue" });
  const sub = h("span", { class: "sub" });

  /** A settled row: its verdict word lands, the row folds, the counts follow. */
  const settle = async (row: HTMLElement, word: string, kind: "ink" | "bad" | "warn" | "ok", group: keyof QueueData) => {
    await stamp(row, word, kind);
    const g = data[group] as { total: number } | undefined;
    if (g) g.total = Math.max(0, g.total - 1);
    const left = total(data);
    setQueueBadge(left);
    paintSub();
    const sec = body.querySelector<HTMLElement>(`[data-group="${group}"]`);
    if (sec) {
      const c = sec.querySelector(".q-count");
      if (c) c.textContent = n(g?.total ?? 0);
      if (!sec.querySelector(".q-row")) sec.remove();
    }
    if (!left) calm(true);
  };

  const paintSub = () => (sub.textContent = total(data) ? `${n(total(data))} waiting` : "");

  const calm = (land: boolean) => {
    fill(body, h("div", { class: `calm-state${land ? " land" : ""}` }, hopArc({ size: 120, cls: land ? "" : "still" }), h("p", null, "Nothing is waiting.")));
  };

  const group = (key: keyof QueueData, title: string, count: number, all: string | null, rows: HTMLElement[]) =>
    rows.length
      ? h(
          "section",
          { class: "q-group", "data-group": key },
          h("h2", { class: "section-title" }, title, h("small", { class: "q-count" }, n(count)), all ? h("a", { class: "go-link q-all", href: all }, "All", glyph("arrow")) : null),
          h("div", { class: "q-rows" }, rows),
        )
      : null;

  const paint = () => {
    paintSub();
    if (!total(data)) return calm(false);
    const cur = body.querySelector<HTMLElement>(".q-row.cur")?.dataset.key;
    const d = data;
    fill(body, 
      ...[
        group(
          "cases",
          "Anticheat cases",
          d.cases?.total ?? 0,
          "#/suspicious",
          (d.cases?.items ?? []).map((c) =>
            h(
              "div",
              { class: "q-row row-go", "data-key": `c:${c.user_id}`, "data-href": `#/suspicious?case=${encodeURIComponent(c.user_id)}`, tabindex: "-1" },
              h("span", { class: `q-score ${c.score >= 90 ? "hi" : c.score >= 70 ? "mid" : ""}` }, ring(c.score), String(c.score)),
              h("span", { class: "q-who" }, playerLink(c.user_id, c.name)),
              mapArt(c.map),
              h("span", { class: "q-what" }, c.headline ?? `${c.runs} flagged runs`),
              h("span", { class: "q-meta" }, c.runs > 1 ? `${c.runs} runs` : "", c.blatant ? badge("blatant", "bad") : null),
              h("span", { class: "q-age", title: "Open for" }, age(c.since)),
            ),
          ),
        ),
        group(
          "tickets",
          "Tickets",
          d.tickets?.total ?? 0,
          "#/feedback?reply=awaiting",
          (d.tickets?.items ?? []).map((t) =>
            h(
              "div",
              { class: "q-row row-go", "data-key": `t:${t.id}`, "data-href": `#/feedback/${encodeURIComponent(t.id)}`, tabindex: "-1" },
              h("span", { class: "q-kind" }, FB_WORD[t.category] ?? t.category),
              h("span", { class: "q-who" }, t.user_id ? playerLink(t.user_id, t.user_name) : h("span", { class: "faint" }, "anonymous")),
              t.map ? mapArt(t.map) : h("span"),
              h("span", { class: "q-what" }, t.message),
              h("span", { class: "q-meta" }, t.player_reply_at ? badge("replied", "warn") : t.status === "new" ? badge("new", "warn") : null),
              h("span", { class: "q-age" }, age(t.player_reply_at ?? t.created_at)),
            ),
          ),
        ),
        group(
          "names",
          "Flagged names",
          d.names?.total ?? 0,
          "#/names",
          (d.names?.items ?? []).map((x) => {
            const row = h(
              "div",
              { class: "q-row", "data-key": `n:${x.id}`, tabindex: "-1" },
              h("span", { class: "q-kind" }, "Name"),
              h("span", { class: "q-who" }, playerLink(x.id, x.name)),
              h("span"),
              h("span", { class: "q-what faint" }, x.problem === "blocked" ? "Uses a blocked word" : x.problem === "reserved" ? "A reserved name" : x.problem),
              h(
                "span",
                { class: "q-acts" },
                may("names.rename")
                  ? h("button", { class: "small", onclick: async () => (await act("/admin/names", { action: "rename", user: x.id, reason: "flagged name" }, `Renamed ${x.name}`)) && settle(row, "Renamed", "ink", "names") }, "Rename to default")
                  : null,
              ),
              h("span"),
            );
            return row;
          }),
        ),
        group(
          "suggestions",
          "Term suggestions",
          d.suggestions?.total ?? 0,
          null,
          (d.suggestions?.items ?? []).map((x) => {
            const row = h(
              "div",
              { class: "q-row", "data-key": `s:${x.term}`, tabindex: "-1" },
              h("span", { class: "q-kind" }, "Term"),
              h("span", { class: "q-who mono" }, x.term),
              h("span"),
              h("span", { class: "q-what faint" }, `${x.whole ? "Whole word. " : ""}From ${x.byName ?? "a moderator"}.${x.reason ? ` ${x.reason}` : ""}`),
              h(
                "span",
                { class: "q-acts" },
                may("names.terms")
                  ? [
                      h("button", { class: "small primary", onclick: async () => (await act("/admin/names", { action: "block-term", term: x.term, whole: x.whole }, `Blocked "${x.term}"`, { run: () => undoCall("/admin/names", { action: "unblock-term", term: x.term }, `Unblocked "${x.term}"`) })) && settle(row, "Blocked", "warn", "suggestions") }, "Block"),
                      h("button", { class: "small ghost", onclick: async () => (await act("/admin/names", { action: "dismiss-term", term: x.term }, "Turned down")) && settle(row, "Dismissed", "ink", "suggestions") }, "Dismiss"),
                    ]
                  : h("span", { class: "faint" }, "An admin decides"),
              ),
              h("span", { class: "q-age" }, age(x.at)),
            );
            return row;
          }),
        ),
        group(
          "errors",
          "Runs that failed to verify",
          d.errors?.total ?? 0,
          "#/runs?status=error",
          (d.errors?.items ?? []).map((r) => {
            const row = h(
              "div",
              { class: "q-row", "data-key": `e:${r.id}`, tabindex: "-1" },
              h("span", { class: "q-kind" }, "Run"),
              h("span", { class: "q-who" }, playerLink(r.user_id, r.user_name)),
              mapArt(r.map),
              h("span", { class: "q-what" }, r.map, h("span", { class: "faint" }, ` ${r.reason ?? "verifier error"}, ${r.attempts} tries`)),
              h("span", { class: "q-acts" }, h("button", { class: "small", onclick: async () => (await act("/admin/runs", { action: "reverify", ids: [r.id] }, "Back in the verify queue")) && settle(row, "Queued", "ink", "errors") }, glyph("refresh"), "Re-verify")),
              h("span", { class: "q-age" }, age(r.created_at)),
            );
            return row;
          }),
        ),
      ].filter((x): x is HTMLElement => !!x),
    );
    if (cur) body.querySelector(`.q-row[data-key="${CSS.escape(cur)}"]`)?.classList.add("cur");
  };

  fill(root, h("div", { class: "view-bar" }, sub), body);
  paint();
  setQueueBadge(total(data));
  const rows = () => [...body.querySelectorAll<HTMLElement>(".q-row")];
  setKeys({
    j: () => void stepRows(rows(), 1),
    k: () => void stepRows(rows(), -1),
    Enter: () => {
      const r = body.querySelector<HTMLElement>(".q-row.cur");
      if (r?.dataset.href) location.hash = r.dataset.href;
    },
  });
  return poll(async () => {
    if (body.querySelector(".stamped") || document.activeElement?.closest(".q-row")) return;
    const next = await api<QueueData>("/admin/queue");
    const was = total(data);
    data = next;
    setQueueBadge(total(data));
    if (was && !total(data) && hadItems) return (paintSub(), calm(true));
    hadItems ||= total(data) > 0;
    paint();
  }, 60_000);
};

