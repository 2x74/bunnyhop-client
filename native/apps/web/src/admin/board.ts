// The Board tabs (Anticheat → Board, Inbox → Board): cases in four stages, like an issue tracker. A card moves by
// dragging it to another column, or from the keyboard (j / k and h / l pick a card, 1-4 move it, a takes it, Enter
// opens it). Opening a card goes to its case (the anticheat case view, or the ticket), which has the same stage,
// assignee and labels plus the timeline.
//
// Anticheat: one card per player with an open flag (GET /admin/integrity, as the Cases tab reads it) in Triage, Looking
// or Second opinion; Done holds the cases closed in the last week. Dragging to Done clears the open flags (with a note),
// which closes the case; shadowbans and bans close it from the case view.
// Reports: one card per open ticket (GET /admin/feedback). Triage is a new ticket; Waiting on player is a staff reply
// with no answer yet, and a player's answer brings it back to Looking on its own; Done is resolved or won't fix this
// week. Moving a card sets the ticket's status the same way the ticket page does.
// What staff decided (stage, assignee, labels, comment count, pinned notes) comes from GET /admin/cases.

import { act, age, api, ask, avatar, glyph, h, help, may, me, plural, reduced, setKeys, toast, when, type Person, type View, fill } from "./core";
import { mapArt } from "./art";
import { ring } from "./charts";
import { pinnedLine } from "./notes";
import { caseAct, labelWords, reportStage, resolutionWord, STAGES, type CaseKind } from "./thread";
import type { FlagPlayer, FlagRun } from "./cases";
import { fbCategory, refreshFeedbackBadge, type FeedbackItem } from "./inbox";
import { refreshQueueBadge } from "./queue";

interface CaseRow {
  id: number;
  subject: string;
  stage: string;
  assignee: string | null;
  labels: string[];
  resolution: string | null;
  opened_at: number;
  updated_at: number;
  closed_at: number | null;
  comments: number;
  name?: string;
  avatar?: string | null;
}

interface Pin {
  id: number;
  body: string;
  author: Person | null;
  created_at: number;
}

interface CasesData {
  cases: CaseRow[];
  staff: Person[];
  pins: Record<string, Pin>;
  doneDays: number;
}

/** One card on a board. */
interface Card {
  id: string;
  stage: string;
  href: string;
  /** For the drawer / assignee: the player. */
  user: string | null;
  assignee: string | null;
  labels: string[];
  comments: number;
  /** When it came in (age on the card). */
  since: number;
  /** Sort inside a column: higher first. */
  rank: number;
  body: () => (HTMLElement | null)[];
}

type Who = "all" | "mine" | "none";

// ---------------------------------------------------------------------------------------------
// The board itself (columns, cards, drag, keys); the two views below feed it cards.

interface BoardOpts {
  kind: CaseKind;
  cards: Card[];
  staff: Person[];
  /** Move a card; resolves true when it moved (false: put it back). */
  move: (card: Card, to: string) => Promise<boolean>;
  doneNote: string;
}

function boardEl(o: BoardOpts, who: Who): { el: HTMLElement; keys: Record<string, (e: KeyboardEvent) => void> } {
  const work = may("cases.work");
  const cols = new Map<string, HTMLElement>();
  const counts = new Map<string, HTMLElement>();
  const byId = new Map(o.cards.map((c) => [c.id, c]));
  const visible = (c: Card) => who === "all" || (who === "mine" ? c.assignee === me?.id : !c.assignee);
  const staffOf = (id: string | null) => (id ? (o.staff.find((s) => s.id === id) ?? { id, name: "Someone", avatar: null }) : null);
  let selected: string | null = null;

  const cardEl = (c: Card) => {
    const a = staffOf(c.assignee);
    const el = h(
      "a",
      { class: "kcard", href: c.href, "data-id": c.id, draggable: "false", tabindex: "-1" },
      ...c.body(),
      c.labels.length || c.comments || a
        ? h(
            "div",
            { class: "kc-foot" },
            c.labels.length ? h("span", { class: "kc-labels" }, labelWords(c.labels)) : null,
            c.comments ? h("span", { class: "kc-meta", title: plural(c.comments, "comment") }, glyph("chat"), String(c.comments)) : null,
            h("span", { class: "spacer" }),
            a ? h("span", { class: "kc-who", title: `${a.name} has it` }, avatar(a, { size: 20, staff: true })) : null,
          )
        : null,
    );
    return el;
  };

  const paintCounts = () => {
    for (const [stage, el] of counts) el.textContent = String(cols.get(stage)!.querySelectorAll(".kcard").length);
  };
  const empty = (stage: string) => h("div", { class: "kcol-empty" }, stage === "done" ? "Nothing closed this week." : work ? "Drop a card here." : "Nothing here.");
  const settleEmpty = () => {
    for (const [stage, list] of cols) {
      const has = !!list.querySelector(".kcard");
      const e = list.querySelector(".kcol-empty");
      if (!has && !e) list.append(empty(stage));
      if (has && e) e.remove();
    }
    paintCounts();
  };

  const board = h("div", { class: `kboard k-${o.kind}` });
  for (const [stage, label] of STAGES[o.kind]) {
    const list = h("div", { class: "kcol-list", "data-stage": stage });
    const n = h("small", null, "0");
    cols.set(stage, list);
    counts.set(stage, n);
    const cards = o.cards.filter((c) => c.stage === stage && visible(c)).sort((a, b) => b.rank - a.rank);
    list.append(...(cards.length ? cards.map(cardEl) : [empty(stage)]));
    board.append(h("section", { class: `kcol s-${stage}`, "data-stage": stage }, h("h3", null, h("span", { class: `stage-dot s-${stage}` }), label, n, stage === "done" ? h("span", { class: "faint kcol-sub" }, o.doneNote) : null), list));
  }
  paintCounts();

  // --- moving a card: optimistic, back where it was if the server says no
  const moveTo = async (id: string, to: string, before: Element | null = null) => {
    const c = byId.get(id);
    const el = board.querySelector<HTMLElement>(`.kcard[data-id="${CSS.escape(id)}"]`);
    if (!c || !el || c.stage === to) return;
    if (!work) return void toast("Your role can't move cards.", true);
    const from = el.parentElement!;
    const next = el.nextSibling;
    const fromStage = c.stage;
    const dest = cols.get(to)!;
    const flip = el.getBoundingClientRect();
    dest.insertBefore(el, before && before.parentElement === dest ? before : dest.firstChild);
    settleEmpty();
    land(el, flip);
    c.stage = to;
    if (!(await o.move(c, to))) {
      c.stage = fromStage;
      from.insertBefore(el, next && next.parentNode === from ? next : null);
      settleEmpty();
    }
  };
  /** The card glides from where it was to where it landed (FLIP), then lands with the game's ease. */
  const land = (el: HTMLElement, was: DOMRect) => {
    if (reduced()) return;
    const now = el.getBoundingClientRect();
    el.animate([{ transform: `translate(${was.left - now.left}px, ${was.top - now.top}px)` }, { transform: "none" }], { duration: 260, easing: "cubic-bezier(0.34, 1.45, 0.64, 1)" });
  };

  // --- drag (pointer events, so it works with a pen and on touch, and the card can lean while it flies)
  let drag: { id: string; el: HTMLElement; ghost: HTMLElement; ph: HTMLElement; dx: number; dy: number; x0: number; y0: number; on: boolean; over: HTMLElement | null } | null = null;
  const dropTarget = (x: number, y: number) => {
    for (const [stage, list] of cols) {
      const r = list.parentElement!.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top - 20 && y <= Math.max(r.bottom, r.top + 400)) return { stage, list };
    }
    return null;
  };
  board.addEventListener("pointerdown", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".kcard");
    if (!el || e.button !== 0 || !work) return;
    const r = el.getBoundingClientRect();
    drag = { id: el.dataset.id!, el, ghost: el, ph: el, dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, on: false, over: null };
  });
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    if (!drag.on) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
      drag.on = true;
      const r = drag.el.getBoundingClientRect();
      drag.ghost = drag.el.cloneNode(true) as HTMLElement;
      drag.ghost.classList.add("kghost");
      drag.ghost.style.width = `${r.width}px`;
      document.body.append(drag.ghost);
      drag.ph = h("div", { class: "kph", style: `height:${r.height}px` });
      drag.el.after(drag.ph);
      drag.el.classList.add("kdragging");
      document.body.classList.add("kdrag");
    }
    drag.ghost.style.transform = `translate(${e.clientX - drag.dx}px, ${e.clientY - drag.dy}px) rotate(-1.5deg)`;
    const t = dropTarget(e.clientX, e.clientY);
    const col = t?.list.parentElement ?? null;
    if (col !== drag.over) {
      drag.over?.classList.remove("kover");
      col?.classList.add("kover");
      drag.over = col;
    }
    if (t) {
      // The placeholder follows the pointer inside the column.
      const after = [...t.list.querySelectorAll<HTMLElement>(".kcard:not(.kdragging)")].find((c) => {
        const r = c.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
      });
      if (after) t.list.insertBefore(drag.ph, after);
      else t.list.append(drag.ph);
      t.list.querySelector(".kcol-empty")?.remove();
    }
  };
  const onUp = (e: PointerEvent) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.on) return;
    e.preventDefault();
    // A drag isn't a click: swallow the click that follows.
    addEventListener("click", (ev) => (ev.preventDefault(), ev.stopPropagation()), { capture: true, once: true });
    document.body.classList.remove("kdrag");
    d.over?.classList.remove("kover");
    const t = dropTarget(e.clientX, e.clientY);
    const before = d.ph.nextElementSibling?.classList.contains("kcard") ? d.ph.nextElementSibling : null;
    d.ph.remove();
    d.ghost.remove();
    d.el.classList.remove("kdragging");
    settleEmpty();
    if (t) void moveTo(d.id, t.stage, before);
  };
  addEventListener("pointermove", onMove);
  addEventListener("pointerup", onUp);
  addEventListener("pointercancel", onUp);

  // --- keys
  const allCards = () => [...board.querySelectorAll<HTMLElement>(".kcard")];
  const pick = (el: HTMLElement | null | undefined) => {
    if (!el) return;
    for (const c of allCards()) c.classList.toggle("cur", c === el);
    selected = el.dataset.id ?? null;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const cur = () => (selected ? board.querySelector<HTMLElement>(`.kcard[data-id="${CSS.escape(selected)}"]`) : null);
  const stepIn = (d: number) => {
    const c = cur();
    if (!c) return pick(allCards()[0]);
    const list = [...c.parentElement!.querySelectorAll<HTMLElement>(".kcard")];
    pick(list[Math.max(0, Math.min(list.length - 1, list.indexOf(c) + d))]);
  };
  const stepCol = (d: number) => {
    const stages = STAGES[o.kind].map(([s]) => s);
    const c = cur();
    let i = c ? stages.indexOf(c.closest<HTMLElement>(".kcol")!.dataset.stage!) : -1;
    for (let k = 0; k < stages.length; k++) {
      i = (i + d + stages.length) % stages.length;
      const first = cols.get(stages[i])!.querySelector<HTMLElement>(".kcard");
      if (first) return pick(first);
    }
  };
  const keys: Record<string, (e: KeyboardEvent) => void> = {
    j: () => stepIn(1),
    k: () => stepIn(-1),
    l: () => stepCol(1),
    h: () => stepCol(-1),
    Enter: () => cur() && (location.hash = cur()!.getAttribute("href")!),
    a: () => {
      const c = selected ? byId.get(selected) : null;
      if (!c || !me || me.token) return;
      void caseAct(o.kind, c.id, { action: "assign", assignee: me.id }, "Assigned to you").then((r) => {
        if (!r) return;
        c.assignee = me!.id;
        const el = cur();
        el?.replaceWith(cardEl(c));
        pick(board.querySelector<HTMLElement>(`.kcard[data-id="${CSS.escape(c.id)}"]`));
      });
    },
  };
  STAGES[o.kind].forEach(([s], i) => (keys[String(i + 1)] = () => selected && void moveTo(selected, s)));
  board.addEventListener("focusin", (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>(".kcard");
    if (c) (selected = c.dataset.id ?? null), allCards().forEach((x) => x.classList.toggle("cur", x === c));
  });
  const el = board;
  (el as HTMLElement & { cleanup?: () => void }).cleanup = () => {
    removeEventListener("pointermove", onMove);
    removeEventListener("pointerup", onUp);
    removeEventListener("pointercancel", onUp);
    document.body.classList.remove("kdrag");
  };
  return { el, keys };
}

/** The page around a board: a count line, the Everyone / Mine / Unassigned switch, the keys, and the board. */
function boardPage(root: HTMLElement, o: BoardOpts & { sub: string; helpText: string; storeKey: string }): () => void {
  let who = (sessionStorage.getItem(o.storeKey) as Who | null) ?? "all";
  const slot = h("div", { class: "kboard-wrap" });
  let current: (HTMLElement & { cleanup?: () => void }) | null = null;
  const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Whose cards" });
  const mineCount = o.cards.filter((c) => c.assignee && c.assignee === me?.id && c.stage !== "done").length;
  const paint = () => {
    current?.cleanup?.();
    const b = boardEl(o, who);
    current = b.el;
    fill(slot, b.el);
    setKeys(b.keys);
    seg.replaceChildren(
      ...([
        ["all", "Everyone"],
        ["mine", "Mine"],
        ["none", "Unassigned"],
      ] as [Who, string][]).map(([v, l]) =>
        h("button", { type: "button", role: "radio", "aria-checked": String(who === v), onclick: () => ((who = v), sessionStorage.setItem(o.storeKey, v), paint()) }, l, v === "mine" && mineCount ? h("b", null, String(mineCount)) : null),
      ),
    );
  };
  fill(root, h("div", { class: "view-bar" }, h("span", { class: "sub" }, o.sub), h("div", { class: "tools" }, seg, help(o.helpText))), slot);
  paint();
  return () => current?.cleanup?.();
}

/** The score's tone, as on the Cases list. */
const scoreClass = (s: number) => (s >= 90 ? "hi" : s >= 70 ? "mid" : "");

// ---------------------------------------------------------------------------------------------
// Anticheat → Board

export const acBoardView: View = async (root) => {
  const [flags, data] = await Promise.all([api<{ runs: FlagRun[]; players: FlagPlayer[] }>("/admin/integrity?review=open"), api<CasesData>("/admin/cases?kind=ac")]);
  const open = new Map(data.cases.filter((c) => c.closed_at === null).map((c) => [c.subject, c]));
  const runsOf = (uid: string) => flags.runs.filter((r) => r.user_id === uid).sort((a, b) => b.score - a.score);
  const headline = (p: FlagPlayer) => {
    const ev = [...runsOf(p.user_id).flatMap((r) => r.evidence), ...p.signals];
    return (ev.find((e) => e.blatant) ?? ev.find((e) => !e.review) ?? ev[0])?.text ?? `best run score ${p.max_score}`;
  };
  const cards: Card[] = flags.players.map((p) => {
    const c = open.get(p.user_id);
    const rs = runsOf(p.user_id);
    const since = Math.min(...rs.map((r) => r.created_at), p.last);
    const pin = data.pins[p.user_id];
    return {
      id: p.user_id,
      stage: c && c.stage !== "done" ? c.stage : "triage",
      href: `#/suspicious?case=${encodeURIComponent(p.user_id)}`,
      user: p.user_id,
      assignee: c?.assignee ?? null,
      labels: c?.labels ?? [],
      comments: c?.comments ?? 0,
      since,
      rank: p.score * 1e13 + p.last,
      body: () => [
        h(
          "div",
          { class: "kc-top" },
          h("span", { class: `q-score ${scoreClass(p.score)}` }, ring(p.score), String(p.score)),
          h("span", { class: "kc-name" }, p.name),
          p.shadow_at ? h("span", { class: "kc-state warn" }, "shadowed") : p.banned ? h("span", { class: "kc-state bad" }, "banned") : null,
          h("span", { class: "kc-age", title: `Open since ${when(since)}` }, age(since)),
        ),
        h("div", { class: "kc-what" }, headline(p)),
        pinnedLine(pin),
        h("div", { class: "kc-runs" }, rs[0] ? mapArt(rs[0].map) : null, h("span", null, plural(rs.filter((r) => !r.review).length || p.open, "open flag")), p.wrs ? h("span", { class: "faint" }, plural(p.wrs, "WR")) : null),
      ],
    };
  });
  // Done: cases closed this week whose player has nothing open again.
  for (const c of data.cases.filter((x) => x.closed_at !== null && !flags.players.some((p) => p.user_id === x.subject))) {
    if (cards.some((x) => x.id === c.subject)) continue;
    const pin = data.pins[c.subject];
    cards.push({
      id: c.subject,
      stage: "done",
      href: `#/suspicious?case=${encodeURIComponent(c.subject)}&review=all`,
      user: c.subject,
      assignee: c.assignee,
      labels: c.labels,
      comments: c.comments,
      since: c.closed_at!,
      rank: c.closed_at!,
      body: () => [
        h("div", { class: "kc-top" }, h("span", { class: `res-mark r-${c.resolution ?? "cleared"}` }), h("span", { class: "kc-name" }, c.name ?? c.subject), h("span", { class: "kc-age", title: when(c.closed_at) }, age(c.closed_at))),
        h("div", { class: "kc-what" }, `${resolutionWord(c.resolution).replace(/^./, (x) => x.toUpperCase())}`),
        pinnedLine(pin),
      ],
    });
  }
  const openCount = cards.filter((c) => c.stage !== "done").length;
  const doneCount = cards.length - openCount;
  const move = async (card: Card, to: string): Promise<boolean> => {
    if (to === "done") {
      const p = flags.players.find((x) => x.user_id === card.id);
      const ids = runsOf(card.id).filter((r) => !r.review).map((r) => r.run_id);
      if (!p || !ids.length) return toast("Nothing open on this player.", true), false;
      const v = await ask({ title: `Clear ${p.name}'s ${plural(ids.length, "open flag")}?`, text: "Their runs stay as they are and the case closes as cleared. To shadowban or ban, open the case.", fields: [{ name: "note", label: "Note (optional, kept on the flags)", kind: "text" }], confirm: "Clear" });
      if (!v) return false;
      for (let i = 0; i < ids.length; i += 100) {
        const r = await act("/admin/integrity", { action: "clear", ids: ids.slice(i, i + 100), note: v.note || null, resolution: "cleared" }, i + 100 >= ids.length ? `${plural(ids.length, "flag")} cleared` : "");
        if (!r) return false;
      }
      void refreshQueueBadge(true);
      return true;
    }
    if (card.stage === "done") return toast("A closed case reopens when the player is flagged again.", true), false;
    return !!(await caseAct("ac", card.id, { action: "move", stage: to }, ""));
  };
  return boardPage(root, {
    kind: "ac",
    cards,
    staff: data.staff,
    move,
    doneNote: `last ${data.doneDays} days`,
    sub: openCount ? `${plural(openCount, "open case")}, ${doneCount} closed this week` : "Nothing open.",
    storeKey: "bh_admin_acboard_who",
    helpText:
      "One card per player with an open flag. Drag a card, or pick one with j / k and h / l and press 1 to 4 to move it; a takes it; Enter opens the case. Dropping on Done clears the open flags. Shadowban and ban are in the case, and close it too. Mentioning someone (@name) in a comment moves the card to Second opinion.",
  });
};

// ---------------------------------------------------------------------------------------------
// Inbox → Board

export const reportBoardView: View = async (root) => {
  const week = Date.now() - 7 * 86_400_000;
  const [open, resolved, wontfix, data] = await Promise.all([
    api<{ items: FeedbackItem[] }>("/admin/feedback?status=open&limit=200"),
    api<{ items: FeedbackItem[] }>("/admin/feedback?status=resolved&limit=60"),
    api<{ items: FeedbackItem[] }>("/admin/feedback?status=wontfix&limit=30"),
    api<CasesData>("/admin/cases?kind=report"),
  ]);
  const byTicket = new Map(data.cases.map((c) => [c.subject, c]));
  const items = [...open.items, ...[...resolved.items, ...wontfix.items].filter((t) => t.updated_at > week)];
  const cards: Card[] = items.map((t) => {
    const c = byTicket.get(t.id);
    const stage = reportStage(t, c);
    const pin = t.user_id ? data.pins[t.user_id] : undefined;
    const reply = t.player_reply_at
      ? h("span", { class: "kc-state warn" }, "Player replied")
      : t.replies
        ? h("span", { class: "faint" }, t.replies_unread ? "Reply unread" : "Reply read")
        : t.user_id && stage !== "done"
          ? h("span", { class: "faint" }, "No reply yet")
          : null;
    return {
      id: t.id,
      stage,
      href: `#/feedback/${encodeURIComponent(t.id)}`,
      user: t.user_id,
      assignee: c?.assignee ?? null,
      labels: c?.labels ?? [],
      comments: c?.comments ?? 0,
      since: t.created_at,
      rank: stage === "done" ? t.updated_at : (t.player_reply_at ?? 0) * 10 + t.created_at,
      body: () => [
        h("div", { class: "kc-top" }, stage === "done" ? h("span", { class: `res-mark r-${t.status}` }) : null, h("span", { class: "kc-cat" }, fbCategory(t.category, t.message)), h("span", { class: "kc-name" }, t.user_name ?? "anonymous"), h("span", { class: "kc-age", title: when(t.created_at) }, age(t.created_at))),
        h("div", { class: "kc-what msg" }, t.message),
        pinnedLine(pin),
        reply || t.map ? h("div", { class: "kc-runs" }, t.map ? mapArt(t.map) : null, reply) : null,
      ],
    };
  });
  const move = async (card: Card, to: string): Promise<boolean> => {
    let resolution: string | undefined;
    if (to === "done") {
      const v = await ask({ title: "Close this ticket?", text: "The player sees its status in their inbox.", fields: [{ name: "as", label: "As", kind: "seg", options: [["resolved", "Fixed"], ["wontfix", "Won't fix"]], value: "resolved" }], confirm: "Close" });
      if (!v) return false;
      resolution = v.as;
    }
    const r = await caseAct("report", card.id, { action: "move", stage: to, ...(resolution ? { resolution } : {}) }, "");
    if (r) void refreshFeedbackBadge();
    return !!r;
  };
  const openCount = cards.filter((c) => c.stage !== "done").length;
  return boardPage(root, {
    kind: "report",
    cards,
    staff: data.staff,
    move,
    doneNote: "last 7 days",
    sub: openCount ? `${plural(openCount, "open ticket")}, ${cards.length - openCount} closed this week` : "Nothing open.",
    storeKey: "bh_admin_fbboard_who",
    helpText:
      "One card per open ticket. Triage is new. Waiting on player means staff replied and the player hasn't answered; their answer moves the card back to Looking. Drag a card, or pick one with j / k and h / l and press 1 to 4; a takes it; Enter opens the ticket.",
  });
};

