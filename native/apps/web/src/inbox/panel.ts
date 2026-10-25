// The inbox panel (opened from the home screen and the pause menu through inbox/state.ts openInbox()). GET /me/inbox
// (apps/api src/inbox.ts) fills it: the player's own feedback tickets with their status and the staff replies under
// them, announcements, and the welcome letter. A mailbox, like Aimperion's: a list of rows, and a row opens on its
// own inside the same dialog (Back / Esc returns to the list). Opening is reading: opening a row marks what's in it
// read, and "Mark all read" does the rest. Replies come from "bunnyhop.lol staff", never from a named person.
//
// Players answer staff in the ticket's own thread: once staff have replied, the ticket shows a reply box under the
// thread (POST /feedback/:id/reply), and the player's replies sit in the thread as "You". Announcements and letters
// can't be answered; an announcement ends with a quiet "Questions? Send feedback". A new report goes through the
// feedback form (the "Send feedback" button here), and every report shows up below with its status.
//
// All text from the server is set with textContent (h() children), never as HTML.

import { api, ApiError, type InboxThread } from "../api";
import { modal } from "../ui/account-panel";
import { h } from "../ui/dom";
import { openFeedback } from "../feedback/state";
import { setInboxUnread } from "./state";
import { mascot, type Mood } from "../notify";
import { discordLink, recruitNote } from "../ui/community";
import "../feedback/feedback.css";

/** apps/api src/inbox.ts BODY_MAX. */
const REPLY_MAX = 2000;

/** What the player sees for the ticket status staff set in the admin panel. */
export const TICKET_STATUS: Record<string, [label: string, hint: string]> = {
  // (Not "New": next to the unread dot it read as a second unread mark.)
  new: ["Received", "Nobody has picked it up yet."],
  triaged: ["Looking into it", "Someone on the team is on it."],
  resolved: ["Fixed", "This one is done."],
  wontfix: ["Won't fix", "We've decided not to change this, for now."],
};

const TICKET_NAME: Record<string, string> = {
  bug: "bug report",
  physics: "physics report",
  map: "map report",
  tier: "map tier report",
  multiplayer: "multiplayer report",
  idea: "idea",
  other: "feedback",
  application: "moderator application",
};

// Plain symbols, drawn in the text colour (no emoji; U+FE0E asks for the text form where a symbol has both).
const GLYPH: Record<string, string> = { bug: "!", physics: "⤴", map: "⊞", tier: "⊞", multiplayer: "◎", idea: "✦", other: "✎\uFE0E", announcement: "✦", update: "✦", event: "⚑\uFE0E", maintenance: "⚙\uFE0E", support: "✉\uFE0E", system: "✉\uFE0E", warning: "!" };

const SENDER = { staff: "bunnyhop.lol staff", system: "bunnyhop.lol", you: "You" } as const;

function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: s > 86400 * 300 ? "numeric" : undefined });
}

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

/** One row of the list. */
interface Row {
  key: string;
  thread: InboxThread;
  glyph: string;
  sender: string;
  subject: string;
  preview: string;
  at: number;
  unread: number[];
}

function rowOf(t: InboxThread): Row {
  if (t.type === "ticket") {
    const last = t.replies[t.replies.length - 1];
    const name = TICKET_NAME[t.category] ?? "feedback";
    return {
      key: `t:${t.id}`,
      thread: t,
      glyph: GLYPH[t.category] ?? "✎",
      sender: last && last.from !== "you" ? SENDER.staff : SENDER.you,
      subject: last ? `Re: your ${name}` : `Your ${name}`,
      preview: firstLine(last ? last.body : t.message),
      at: last ? last.created_at : t.created_at,
      unread: t.replies.filter((r) => !r.read_at).map((r) => r.id),
    };
  }
  return {
    key: `m:${t.id}`,
    thread: t,
    glyph: t.category === "warning" ? GLYPH.warning : t.type === "system" ? GLYPH.system : (GLYPH[t.category ?? "announcement"] ?? GLYPH.announcement),
    sender: t.from === "system" ? SENDER.system : SENDER.staff,
    subject: t.subject || (t.type === "system" ? "From bunnyhop.lol" : "Announcement"),
    preview: firstLine(t.body),
    at: t.created_at,
    unread: t.read_at ? [] : [t.id],
  };
}

const statusChip = (status: string) => {
  const [label, hint] = TICKET_STATUS[status] ?? [status, ""];
  return h(`span.ib-status.is-${status}`, { title: hint }, label);
};

let current: HTMLDialogElement | null = null;

export function showInbox(): void {
  if (current) return;
  let rows: Row[] = [];
  let open: Row | null = null;
  let seq = 0;
  /** Unsent replies by ticket id, kept while the inbox is open. */
  const drafts = new Map<string, string>();

  const d = modal("acct-dialog ib-dialog", "Inbox", () => (current = null));
  current = d;

  const title = h("h2", { id: "ib-title" }, "Inbox");
  const back = h("button.ib-back", { type: "button", "aria-label": "Back to the inbox", hidden: true, onclick: () => showList() }, "‹");
  const count = h("span.ib-count");
  const allBtn = h("button.btn.btn-sm", { type: "button", hidden: true, onclick: () => void readAll() }, "Mark all read");
  const list = h("div.ib-list", { role: "list", "aria-labelledby": "ib-title" });
  const listPane = h(
    "div.ib-pane",
    null,
    h("div.ib-bar", null, count, allBtn),
    list,
    h(
      "div.ib-foot",
      null,
      h("small.dim", null, "Replies to your feedback show up here."),
      h("button.btn.btn-sm", { type: "button", onclick: () => (d.close(), openFeedback()) }, "Send feedback"),
    ),
  );
  const letter = h("article.ib-pane.ib-letter", { hidden: true, "aria-live": "polite" });

  d.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      if (open) showList();
      else d.close();
    }
    // ↑ / ↓ walk the rows.
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
      const items = [...list.querySelectorAll<HTMLElement>(".ib-row")];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = items[Math.min(items.length - 1, Math.max(0, i < 0 ? 0 : i + (e.key === "ArrowDown" ? 1 : -1)))];
      e.preventDefault();
      next.focus();
    }
  });

  // Empty / loading / error states: the bunny, in the mood of the news.
  const status = (text: string, sub?: string, mood: Mood = "idle") => {
    list.replaceChildren(h("div.ib-empty", null, mascot(mood, { size: "5.2rem", className: "ib-mascot" }).el, h("p", null, text), sub ? h("p.dim", null, sub) : null));
    count.textContent = "";
    allBtn.hidden = true;
  };

  const drawCount = () => {
    const n = rows.reduce((a, r) => a + r.unread.length, 0);
    count.textContent = n === 0 ? "All read" : n === 1 ? "1 unread" : `${n} unread`;
    allBtn.hidden = n === 0;
  };

  const drawList = () => {
    if (!rows.length) return status("Nothing here yet.", undefined, "sleepy");
    const now = Date.now();
    list.replaceChildren(
      ...rows.map((r) =>
        h(
          `button.ib-row${r.unread.length ? ".is-unread" : ""}`,
          { type: "button", role: "listitem", "data-key": r.key, onclick: () => openRow(r) },
          h("span.ib-glyph", { "aria-hidden": "true" }, r.glyph),
          h(
            "span.ib-text",
            null,
            h("span.ib-line", null, h("span.ib-sender", null, r.sender), h("span.ib-subject", null, r.subject)),
            h("span.ib-preview", null, r.preview),
          ),
          h(
            "span.ib-side",
            null,
            h("span.ib-when", null, ago(r.at, now)),
            r.thread.type === "ticket" ? statusChip(r.thread.status) : null,
            r.unread.length ? h("span.ib-dot", { role: "img", "aria-label": "Unread" }) : null,
          ),
        ),
      ),
    );
    drawCount();
  };

  const showList = () => {
    const was = open;
    open = null;
    letter.hidden = true;
    listPane.hidden = false;
    back.hidden = true;
    title.textContent = "Inbox";
    drawList();
    (was ? list.querySelector<HTMLElement>(`[data-key="${CSS.escape(was.key)}"]`) : null)?.focus({ preventScroll: true });
  };

  const markRead = async (ids: number[] | null) => {
    const now = Date.now();
    for (const r of rows) {
      if (ids && !r.unread.some((id) => ids.includes(id))) continue;
      const t = r.thread;
      if (t.type === "ticket") {
        for (const x of t.replies) if (!ids || ids.includes(x.id)) x.read_at ??= now;
      } else t.read_at ??= now;
      r.unread = ids ? r.unread.filter((id) => !ids.includes(id)) : [];
    }
    const local = rows.reduce((a, r) => a + r.unread.length, 0);
    setInboxUnread(local);
    try {
      setInboxUnread(await api.markInboxRead(ids ?? undefined));
    } catch {
      /* the next poll corrects the badge */
    }
  };

  const readAll = async () => {
    await markRead(null);
    drawList();
    list.querySelector<HTMLElement>(".ib-row")?.focus({ preventScroll: true });
  };

  const openRow = (r: Row) => {
    open = r;
    const t = r.thread;
    const now = Date.now();
    listPane.hidden = true;
    letter.hidden = false;
    back.hidden = false;
    title.textContent = r.subject;
    if (t.type === "ticket") {
      const [label] = TICKET_STATUS[t.status] ?? [t.status];
      letter.replaceChildren(
        h(
          "section.ib-quote",
          null,
          h("div.ib-quote-head", null, h("b", null, "You wrote"), h("span.dim", null, ago(t.created_at, now)), statusChip(t.status)),
          h("p.ib-body", null, t.message),
          h("small.dim.ib-status-hint", null, `Status: ${label}. ${(TICKET_STATUS[t.status] ?? ["", ""])[1]}`),
        ),
        ...(t.replies.length
          ? t.replies.map((x) =>
              h(
                `section.ib-reply${x.from === "you" ? ".is-you" : ""}`,
                null,
                h("div.ib-meta", null, h("b", null, x.from === "you" ? SENDER.you : x.from === "system" ? SENDER.system : SENDER.staff), h("span.dim", null, ago(x.created_at, now))),
                h("p.ib-body", null, x.body),
              ),
            )
          : [h("p.dim.ib-none", null, "No reply yet.")]),
        // Answerable once staff have written.
        t.replies.some((x) => x.from !== "you") ? replyForm(r, t) : "",
      );
    } else {
      letter.replaceChildren(
        h("div.ib-meta", null, h("span.ib-glyph", { "aria-hidden": "true" }, r.glyph), h("b", null, r.sender), t.category && (t.type !== "system" || t.category === "warning") ? h("span.ib-cat", null, t.category) : null, h("span.dim", null, ago(t.created_at, now))),
        h("p.ib-body", null, ...linked(t.body)),
        // The welcome letter (the only system letter): the community Discord, when there is one.
        // A staff warning (apps/api src/admin-cases.ts) is a system letter too, without the welcome's extras.
        t.type === "system" && t.category !== "warning" ? h("p.ib-discord", null, discordLink("btn.btn-sm.discord")) : "",
        t.type === "system" && t.category !== "warning" ? recruitNote("ib-recruit", { beforeApply: () => d.close() }) : "",
      );
    }
    letter.append(
      h(
        "div.ib-letter-foot",
        null,
        h("button.btn.btn-sm", { type: "button", onclick: () => showList() }, "‹ Back to inbox"),
        t.type === "announcement" ? h("button.fb-inline.ib-ask", { type: "button", onclick: () => (d.close(), openFeedback()) }, "Questions? Send feedback") : "",
      ),
    );
    back.focus({ preventScroll: true });
    if (r.unread.length) void markRead([...r.unread]);
  };

  /** The reply box under a ticket's thread. The sent reply joins the thread; the draft survives Back. */
  const replyForm = (r: Row, t: Extract<InboxThread, { type: "ticket" }>): HTMLElement => {
    const text = h("textarea.fb-text.ib-answer-text", { rows: 3, maxlength: REPLY_MAX, placeholder: "Write a reply", "aria-label": "Your reply" });
    text.value = drafts.get(t.id) ?? "";
    const count = h("small.fb-count");
    const err = h("p.fb-err", { role: "alert" });
    const send = h("button.btn.primary.btn-sm", { type: "submit" }, "Send");
    const updateCount = () => (count.textContent = `${[...text.value].length} / ${REPLY_MAX}`);
    updateCount();
    text.addEventListener("input", () => {
      drafts.set(t.id, text.value);
      updateCount();
      if (err.textContent && text.value.trim()) err.textContent = "";
    });
    let busy = false;
    const submit = async () => {
      if (busy) return;
      if (!text.value.trim()) {
        err.textContent = "Write a reply first.";
        return text.focus();
      }
      busy = true;
      send.disabled = true;
      send.textContent = "Sending…";
      err.textContent = "";
      try {
        const res = await api.replyToTicket(t.id, text.value);
        drafts.delete(t.id);
        t.replies.push(res.reply);
        t.status = res.status;
        const next = rowOf(t);
        rows = [next, ...rows.filter((x) => x !== r)];
        if (d.isConnected && open === r) {
          openRow(next);
          letter.querySelector<HTMLElement>(".ib-answer-text")?.focus();
        }
      } catch (x) {
        err.textContent = x instanceof ApiError ? x.message : "Couldn't reach the server. Try again in a moment.";
        busy = false;
        send.disabled = false;
        send.textContent = "Send";
      }
    };
    // Ctrl / Cmd + Enter sends too.
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) (e.preventDefault(), void submit());
    });
    return h(
      "form.ib-answer",
      { novalidate: true, onsubmit: (e: Event) => (e.preventDefault(), void submit()) },
      text,
      err,
      h("div.ib-answer-bar", null, count, send),
    );
  };

  const load = async () => {
    const s = ++seq;
    status("Checking…", undefined, "thinking");
    try {
      const v = await api.inbox();
      if (s !== seq || !d.isConnected) return;
      setInboxUnread(v.unread);
      if (!v.signedIn) return status("Play a run and your inbox opens.", undefined, "waving");
      rows = v.threads.map(rowOf);
      if (open) {
        const again = rows.find((r) => r.key === open!.key);
        if (again) return openRow(again);
      }
      drawList();
      list.querySelector<HTMLElement>(".ib-row")?.focus({ preventScroll: true });
    } catch (e) {
      if (s !== seq) return;
      status(e instanceof ApiError && e.status === 429 ? "The inbox was checked a lot just now." : "Couldn't reach the server.", "Try again in a moment.", "sad");
    }
  };

  d.append(
    h("header.acct-head", null, h("div.ib-head", null, back, title), h("button.acct-close", { type: "button", "aria-label": "Close", onclick: () => d.close() }, "×")),
    h("div.acct-body.ib-body-wrap", null, listPane, letter),
  );
  d.showModal();
  void load();
}

/**
 * Staff letters (announcements): the game's own and the community Discord's links become links; anything else stays
 * text, so a letter can never send a player somewhere unexpected.
 */
const LINKABLE = /\bhttps:\/\/(?:(?:www\.)?bunnyhop\.lol(?:\/[^\s]*)?|discord\.gg\/[\w-]+|discord\.com\/invite\/[\w-]+)/g;
function linked(text: string): (string | HTMLElement)[] {
  const out: (string | HTMLElement)[] = [];
  let at = 0;
  for (const m of text.matchAll(LINKABLE)) {
    const url = m[0].replace(/[.,!?)]+$/, "");
    out.push(text.slice(at, m.index), h("a", { href: url, target: "_blank", rel: "noopener" }, url));
    at = m.index! + url.length;
  }
  out.push(text.slice(at));
  return out;
}
