// The thread pane (research/ADMIN-UPLIFT.md): a card on a board opens its thread beside the board instead of leaving it,
// like a thread beside T3 Code's thread list. A ticket's pane is its whole conversation in one timeline (the report,
// the player's replies, staff replies, staff comments, the changes) with the composer's two modes; an anticheat case's
// pane is the case timeline (flags, moderation, comments, Bun-E) with the comment box. Stage, assignee and labels sit
// at the top. It refreshes itself when the live stamp moves (watch.ts), so a player's reply lands in it as you read.
// Esc closes it; o (or "Open") goes to the full page, which has the evidence and the actions. Opening it marks the
// thread seen (seen.ts).

import { act, adminBlobUrl, ago, api, glyph, h, NotAdmin, playerLink, showAuth, when, fill, type Child } from "./core";
import { caseProps, loadThread, reportStage, ticketItems, timeline, type CaseKind, type ThreadData, type TimelineEl } from "./thread";
import { fbCategory, refreshFeedbackBadge, ticketReplyMode, type FeedbackDetail } from "./inbox";
import { markSeen } from "./seen";
import { onLive } from "./watch";
import { mapLine } from "./art";
import { pinnedLine } from "./notes";

export interface PeekTarget {
  kind: CaseKind;
  subject: string;
  /** The full page (the ticket, the anticheat case). */
  href: string;
  /** Anticheat: the card's facts for the head (score, name, state, the strongest signal). */
  head?: () => Child[];
  /** After the pane changed something (stage, assignee, a reply): the board refreshes. */
  onChange?: () => void;
}

let host: HTMLElement | null = null;
let cur: PeekTarget | null = null;
let seq = 0;
let unlive: (() => void) | null = null;
let shotUrl: string | null = null;

function shell(): HTMLElement {
  if (host) return host;
  host = h("aside", { class: "peek", id: "peek", role: "complementary", "aria-label": "Thread", hidden: true });
  document.body.append(host);
  host.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || document.querySelector("dialog[open], .menu")) return;
    const t = e.target as HTMLElement;
    // Esc in a box with text in it only leaves the box.
    if (t.matches("textarea, input") && (t as HTMLTextAreaElement).value.trim()) return void t.blur();
    e.stopPropagation();
    closePeek();
  });
  return host;
}

export const peekOpen = () => !!host && !host.hidden;
export const peekSubject = () => (peekOpen() ? (cur?.subject ?? null) : null);

export function closePeek(): void {
  seq++;
  unlive?.();
  unlive = null;
  if (shotUrl) URL.revokeObjectURL(shotUrl), (shotUrl = null);
  const was = cur;
  cur = null;
  document.body.classList.remove("peeking");
  if (!host || host.hidden) return;
  host.hidden = true;
  host.replaceChildren();
  if (was) document.querySelector<HTMLElement>(`.kcard[data-id="${CSS.escape(was.subject)}"]`)?.focus({ preventScroll: true });
}

/** Focuses the pane's composer (Enter on a card that is already open). */
export function focusPeek(): void {
  host?.querySelector<HTMLTextAreaElement>("textarea.tl-input")?.focus();
}

const loading = () => h("div", { class: "peek-load", role: "status", "aria-label": "Loading" }, h("i", { class: "sk-title" }), h("i", { class: "sk-block sm" }), h("i", { class: "sk-block" }));

export async function openPeek(t: PeekTarget): Promise<void> {
  const el = shell();
  const my = ++seq;
  unlive?.();
  unlive = null;
  if (shotUrl) URL.revokeObjectURL(shotUrl), (shotUrl = null);
  cur = t;
  document.body.classList.add("peeking");
  if (el.hidden) el.hidden = false;
  fill(el, top(t), loading());
  markSeen(t.kind, t.subject);
  try {
    if (t.kind === "report") await paintTicket(el, t, my);
    else await paintCase(el, t, my);
  } catch (e) {
    if (e instanceof NotAdmin) return showAuth();
    if (my !== seq) return;
    fill(el, top(t), h("p", { class: "err" }, `Couldn't load this thread: ${(e as Error).message}`));
  }
}

function top(t: PeekTarget, ...extra: Child[]): HTMLElement {
  return h(
    "div",
    { class: "peek-top" },
    h("button", { type: "button", class: "ghost icon", "aria-label": "Close (Esc)", title: "Close (Esc)", onclick: () => closePeek() }, glyph("close")),
    ...extra,
    h("span", { class: "spacer" }),
    h("a", { class: "go-link", href: t.href, onclick: () => closePeek() }, t.kind === "report" ? "Open ticket" : "Open case", h("kbd", null, "o"), glyph("arrow")),
  );
}

/** Live: refetch when the stamp parts this thread depends on move, then repaint without touching the composer. */
function follow(my: number, parts: ("feedback" | "cases" | "flags")[], refresh: () => Promise<void>): void {
  unlive = onLive((_s, changed) => {
    if (my !== seq || !parts.some((p) => changed.has(p))) return;
    void refresh().catch(() => undefined);
  });
}

// ---------------------------------------------------------------------------------------------
// A ticket

async function paintTicket(el: HTMLElement, t: PeekTarget, my: number): Promise<void> {
  const id = encodeURIComponent(t.subject);
  const get = () => Promise.all([api<FeedbackDetail>(`/admin/feedback/${id}`), loadThread("report", t.subject)]);
  let [d, th] = await get();
  if (my !== seq) return;
  const items = (x: FeedbackDetail) => ticketItems(x.feedback, x.replies ?? [], { player: x.recipient?.name ?? x.user?.name ?? x.feedback.user_name ?? "Player", waitingSince: x.feedback.player_reply_at ?? null, report: true });
  const stageOf = (x: FeedbackDetail, y: ThreadData) => {
    const staff = (x.replies ?? []).filter((r) => r.from_actor !== "player");
    return reportStage({ status: x.feedback.status, player_reply_at: x.feedback.player_reply_at, replies: staff.length, last_reply_at: staff.at(-1)?.created_at ?? null }, y.case);
  };
  const head = h("div", { class: "peek-head" });
  const paintHead = () => {
    const fb = d.feedback;
    fill(
      head,
      h("h2", null, h("span", { class: "peek-cat" }, fbCategory(fb.category, fb.message)), fb.user_id ? playerLink(fb.user_id, fb.user_name) : h("span", { class: "faint" }, "anonymous")),
      h(
        "div",
        { class: "peek-meta" },
        h("span", { title: when(fb.created_at) }, ago(fb.created_at)),
        fb.map ? mapLine(fb.map) : null,
        fb.player_reply_at ? h("span", { class: "kc-state warn" }, "Player replied") : null,
        fb.player_reply_at
          ? h("button", { type: "button", class: "small ghost", title: "Seen, needs no answer", onclick: async () => (await act(`/admin/feedback/${id}`, { action: "seen" }, "Marked read")) && (void refreshFeedbackBadge(), void refresh(), t.onChange?.()) }, glyph("check"), "Mark read")
          : null,
      ),
      caseProps("report", t.subject, { stage: stageOf(d, th), assignee: th.case?.assignee ?? null, labels: th.case?.labels ?? [] }, th.staff, { onChange: () => (void refresh(), t.onChange?.()) }),
      pinnedLine(th.notes.find((n) => n.pinned)),
    );
  };
  const shot = d.feedback.screenshot ? h("a", { class: "peek-shot", href: t.href, title: "The player's screenshot (open the ticket for full size)" }) : null;
  if (shot)
    void adminBlobUrl(`/admin/feedback/${id}/screenshot`)
      .then((u) => {
        if (my !== seq) return URL.revokeObjectURL(u);
        shotUrl = u;
        shot.append(h("img", { src: u, alt: "The player's screenshot" }));
      })
      .catch(() => shot.remove());
  const refresh = async () => {
    const [nd, nth] = await get();
    if (my !== seq) return;
    d = nd;
    th = nth;
    paintHead();
    tl.update(th, items(d));
  };
  const tl: TimelineEl = timeline("report", t.subject, th, {
    items: items(d),
    legacyNote: d.feedback.admin_note ? { body: d.feedback.admin_note, at: d.feedback.updated_at } : null,
    empty: "Nothing yet.",
    reply: ticketReplyMode(d, () => (void refresh(), t.onChange?.())),
    onComment: () => t.onChange?.(),
  });
  paintHead();
  fill(el, top(t), h("div", { class: "peek-body" }, head, shot, tl));
  // The newest message and the box are at the bottom: start there (a short thread just fits).
  if ((d.replies ?? []).length || th.events.length) requestAnimationFrame(() => el.querySelector(".peek-body")?.scrollTo({ top: 1e6 }));
  follow(my, ["feedback", "cases"], refresh);
}

// ---------------------------------------------------------------------------------------------
// An anticheat case

async function paintCase(el: HTMLElement, t: PeekTarget, my: number): Promise<void> {
  let th = await loadThread("ac", t.subject);
  if (my !== seq) return;
  const head = h("div", { class: "peek-head" });
  const stage = () => (th.case && th.case.closed_at === null ? th.case.stage : "triage");
  const paintHead = () =>
    fill(
      head,
      ...(t.head?.() ?? [h("h2", null, playerLink(t.subject, null))]),
      caseProps("ac", t.subject, { stage: stage(), assignee: th.case?.closed_at === null ? th.case.assignee : null, labels: th.case?.closed_at === null ? th.case.labels : [] }, th.staff, { onChange: () => (void refresh(), t.onChange?.()) }),
      pinnedLine(th.notes.find((n) => n.pinned)),
    );
  const refresh = async () => {
    const n = await loadThread("ac", t.subject);
    if (my !== seq) return;
    th = n;
    paintHead();
    tl.update(th);
  };
  const tl: TimelineEl = timeline("ac", t.subject, th, { stage, empty: "No comments yet.", onComment: () => (void refresh(), t.onChange?.()) });
  paintHead();
  fill(el, top(t), h("div", { class: "peek-body" }, head, tl));
  // The newest activity is at the bottom: start there.
  requestAnimationFrame(() => el.querySelector(".peek-body")?.scrollTo({ top: 1e6 }));
  follow(my, ["flags", "cases"], refresh);
}
