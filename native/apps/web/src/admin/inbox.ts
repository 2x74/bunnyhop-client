// Inbox: Feedback (in-game reports; apps/api src/feedback.ts) and Announcements (the players' inbox; src/inbox.ts).
// Feedback is built for speed: j / k move through tickets (in the list and on a ticket), r replies and resolves, t
// triages, e goes to the reply box, "/" in the reply box brings up the saved replies, and after "Reply and resolve" the
// next waiting ticket opens. Player names a report mentions become links, and "Same IP" lists those reports.

import { feedbackClient } from "../client-identity";
import { me, act, adminBlobUrl, ago, api, ask, avatar, badge, emptyLine, fmtTime, glyph, h, help, idCell, may, n, phone, playerLink, plural, reroute, setKeys, short, stepRows, table, toast, when, dayName, type ModRow, type View, fill } from "./core";
import { columns } from "./charts";
import { mapLine } from "./art";
import { MSG_CATEGORIES } from "./dialogs";
import { actionWords, detailSentence } from "./words";
import { caseProps, loadThread, reportStage, timeline } from "./thread";
import { pinnedLine } from "./notes";
import type { StaffRole } from "../progression";
import { tierLabel } from "../tiers";

export const FB_CATEGORIES: [string, string][] = [
  ["bug", "Bug"],
  ["physics", "Physics / movement"],
  ["map", "Map problem"],
  ["tier", "Map tier"],
  ["report", "Player report"],
  ["multiplayer", "Multiplayer"],
  ["idea", "Idea"],
  ["other", "Other"],
  ["application", "Moderator application"],
  ["privacy", "Privacy request"],
];
const FB_STATUSES: [string, string][] = [
  ["new", "New"],
  ["triaged", "Triaged"],
  ["resolved", "Resolved"],
  ["wontfix", "Won't fix"],
];
export function fbCategory(c: string, message?: string): string {
  if (c !== "privacy") return FB_CATEGORIES.find(([id]) => id === c)?.[1] ?? c;
  const kind = /^Privacy request — (export|delete|correct|other)/.exec(message ?? "")?.[1];
  return `Privacy request${kind ? ` — ${kind}` : ""}`;
}

const FB_STATUS_KIND: Record<string, string> = { new: "warn", triaged: "", resolved: "ok", wontfix: "" };
const fbStatusBadge = (s: string) => badge(FB_STATUSES.find(([id]) => id === s)?.[1] ?? s, FB_STATUS_KIND[s] ?? "");

/** The rail's number on Inbox: tickets waiting on staff (new, or the player replied and nobody has dealt with it yet). */
export function setFeedbackBadge(count: number): void {
  const b = document.getElementById("fb-badge");
  if (!b) return;
  b.textContent = count > 99 ? "99+" : String(count);
  b.hidden = count <= 0;
  b.title = `${count} waiting: new, or the player replied`;
}

export async function refreshFeedbackBadge(): Promise<void> {
  try {
    const c = await api<{ new: number; waiting?: number }>("/admin/feedback/count");
    setFeedbackBadge(c.waiting ?? c.new);
  } catch {
    /* badge only */
  }
}

export interface FeedbackItem {
  id: string;
  user_id: string | null;
  user_name: string | null;
  category: string;
  message: string;
  message_length: number;
  contact: string | null;
  map: string | null;
  run_id: string | null;
  screenshot: number;
  has_context: number;
  status: string;
  admin_note: string | null;
  created_at: number;
  updated_at: number;
  replies?: number;
  replies_unread?: number;
  last_reply_at?: number | null;
  player_replies?: number;
  player_reply_at?: number | null;
}

const FB_REPLY: [string, string][] = [
  ["awaiting", "Awaiting reply"],
  ["player", "Player replied"],
  ["unread", "Reply unread"],
  ["replied", "Replied"],
  ["none", "No reply"],
];

function replyCell(x: FeedbackItem): HTMLElement {
  if (x.player_reply_at) return h("span", { class: "nowrap", title: `the player replied ${when(x.player_reply_at)}` }, badge("Player replied", "warn"));
  if (!x.replies) return x.user_id ? (x.status === "new" || x.status === "triaged" ? badge("Awaiting reply", "warn") : h("span", { class: "faint" }, "—")) : h("span", { class: "faint", title: "Sent without a session: can't be answered in game" }, "No inbox");
  return h("span", { class: "nowrap", title: x.last_reply_at ? `last reply ${when(x.last_reply_at)}` : undefined }, `${x.replies === 1 ? "Replied" : `${x.replies} replies`}, `, x.replies_unread ? h("b", null, "unread") : h("span", { class: "faint" }, "read"));
}

/** The list's order (this tab), so j / k on a ticket go to the next one in it. */
const ORDER_KEY = "bh_admin_fb_order";
const saveOrder = (ids: string[]) => sessionStorage.setItem(ORDER_KEY, JSON.stringify(ids.slice(0, 500)));
const loadOrder = (): string[] => {
  try {
    return JSON.parse(sessionStorage.getItem(ORDER_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
};

const feedbackList: View = async (root, params) => {
  const f = {
    status: h("select", null, h("option", { value: "" }, "Any status"), h("option", { value: "open", selected: params.get("status") === "open" }, "Open (new and triaged)"), FB_STATUSES.map(([v, l]) => h("option", { value: v, selected: params.get("status") === v }, l))),
    category: h("select", null, h("option", { value: "" }, "Any category"), FB_CATEGORIES.filter(([v]) => v !== "privacy" || me?.role === "owner").map(([v, l]) => h("option", { value: v, selected: params.get("category") === v }, l))),
    reply: h("select", null, h("option", { value: "" }, "Any"), FB_REPLY.map(([v, l]) => h("option", { value: v, selected: params.get("reply") === v }, l))),
    q: h("input", { type: "search", placeholder: "text, contact, name, id", value: params.get("q") ?? "" }),
    map: h("input", { type: "search", placeholder: "bhop_eazy", value: params.get("map") ?? "" }),
    user: params.get("user") ?? "",
    about: params.get("about") ?? "",
    sameIp: params.get("sameIp") ?? "",
  };
  const body = h("tbody");
  const moreBtn = h("button", { type: "button" }, "Load older");
  const count = h("span", { class: "sub" });
  const chips = h("div", { class: "seg", role: "group", "aria-label": "Filter by status" });
  let next: string | null = null;
  let ids: string[] = [];
  const query = (before: string | null) => {
    const q = new URLSearchParams();
    for (const k of ["status", "category", "reply", "q", "map"] as const) if (f[k].value.trim()) q.set(k, f[k].value.trim());
    if (f.user) q.set("user", f.user);
    if (f.about) q.set("about", f.about);
    if (f.sameIp) q.set("sameIp", f.sameIp);
    if (before) q.set("before", before);
    q.set("limit", "50");
    return q;
  };
  const row = (x: FeedbackItem) =>
    h(
      "tr",
      { class: `go${x.status === "new" || x.player_reply_at ? " fb-unread" : ""}`, "data-href": `#/feedback/${encodeURIComponent(x.id)}`, "data-id": x.id },
      h("td", { class: "time fb-c-when", title: when(x.created_at) }, ago(x.created_at)),
      h("td", { class: "fb-c-status" }, fbStatusBadge(x.status)),
      h("td", { class: "nowrap fb-c-cat" }, fbCategory(x.category, x.message)),
      h("td", { class: "nowrap fb-c-who" }, x.user_id ? playerLink(x.user_id, x.user_name) : h("span", { class: "faint" }, "anonymous")),
      h("td", { class: "nowrap fb-c-map" }, x.map ? mapLine(x.map) : h("span", { class: "faint" }, "—")),
      h(
        "td",
        { class: "msg fb-c-msg" },
        h("a", { href: `#/feedback/${encodeURIComponent(x.id)}`, class: "fb-open" }, x.message.length < x.message_length ? `${x.message}…` : x.message),
        x.admin_note ? h("div", { class: "raw" }, `Note: ${x.admin_note}`) : null,
      ),
      h("td", { class: "nowrap fb-c-attach fb-attach" }, [x.screenshot && "screenshot", x.has_context && x.category !== "application" && "game info", x.run_id && "run", x.contact && "contact"].filter(Boolean).join(", ") || "—"),
      h("td", { class: "nowrap fb-c-reply" }, replyCell(x)),
    );
  const load = async (reset: boolean) => {
    const r = await api<{ items: FeedbackItem[]; counts: Record<string, number>; replyCounts?: { awaiting: number; player?: number; unread: number }; waiting?: number; next: string | null }>(`/admin/feedback?${query(reset ? null : next)}`);
    if (reset) {
      body.replaceChildren();
      ids = [];
    }
    for (const x of r.items) body.appendChild(row(x));
    ids.push(...r.items.map((x) => x.id));
    saveOrder(ids);
    if (reset && !r.items.length) body.appendChild(h("tr", null, h("td", { colspan: "8", class: "empty" }, "No feedback matches.")));
    next = r.next;
    moreBtn.hidden = !next;
    count.textContent = `${ids.length} shown`;
    setFeedbackBadge(r.waiting ?? r.counts.new ?? 0);
    fill(chips, 
      ...FB_STATUSES.map(([id, label]) =>
        h("button", { type: "button", class: id === "new" && (r.counts[id] ?? 0) > 0 ? "hot" : "", "aria-pressed": String(f.status.value === id), onclick: () => ((f.status.value = f.status.value === id ? "" : id), search()) }, label, h("b", null, n(r.counts[id] ?? 0))),
      ),
      ...(r.replyCounts
        ? [
            h("span", { class: "seg-sep", "aria-hidden": "true" }),
            ...(["awaiting", "player", "unread"] as const).map((id) =>
              h("button", { type: "button", class: id !== "unread" && (r.replyCounts![id] ?? 0) > 0 ? "hot" : "", "aria-pressed": String(f.reply.value === id), onclick: () => ((f.reply.value = f.reply.value === id ? "" : id), search()) }, FB_REPLY.find(([v]) => v === id)![1], h("b", null, n(r.replyCounts![id] ?? 0))),
            ),
          ]
        : []),
    );
  };
  const search = (e?: Event) => {
    e?.preventDefault();
    history.replaceState(null, "", `#/feedback?${query(null)}`);
    void load(true).catch((err) => toast(String(err.message), true));
  };
  moreBtn.onclick = () => void load(false);
  const clear = (label: string) => h("button", { type: "button", class: "small", onclick: () => (location.hash = "#/feedback") }, label, glyph("close"));
  // Inflow: reports per day for 14 days (GET /admin/overview/series), beside the counts.
  const inflow = h("span", { class: "inflow" });
  void api<{ feedback: number[]; dayStart: number }>("/admin/overview/series")
    .then((sr) => {
      const D = sr.feedback.length;
      const sum = sr.feedback.reduce((a, b) => a + b, 0);
      fill(inflow, 
        columns({ label: `Feedback per day, last 14 days: ${n(sum)}.`, height: 26, intro: true, bare: true, hot: D - 1, series: [{ values: sr.feedback, cls: "c-ink", label: "reports" }], tip: (i) => `${i === D - 1 ? "Today" : dayName(sr.dayStart + i * 86_400_000)}  ${plural(sr.feedback[i], "report")}` }),
        h("span", null, `${n(sum)} in 14 days`),
      );
    })
    .catch(() => undefined);
  fill(root, 
    h("div", { class: "view-bar" }, count, inflow, h("div", { class: "tools" }, chips)),
    h(
      "details",
      { class: "fold", open: !phone() },
      h("summary", null, "Filters", glyph("chevron")),
      h(
        "form",
        { class: "filters", onsubmit: search },
        h("label", null, "Status", f.status),
        h("label", null, "Category", f.category),
        h("label", null, "Replies", f.reply),
        h("label", null, "Search", f.q),
        h("label", null, "Map", f.map),
        h("button", { type: "submit", class: "primary" }, "Filter"),
        f.user ? clear(`player ${short(f.user)}`) : null,
        f.about ? clear(`reports about ${short(f.about)}`) : null,
        f.sameIp ? clear("same IP as a ticket") : null,
      ),
    ),
    h("div", { class: "tablewrap" }, h("table", { class: "fb-table" }, h("thead", null, h("tr", null, ["When", "Status", "Category", "Player", "Map", "Message", "Attached", "Reply"].map((t) => h("th", null, t)))), body)),
    h("div", { class: "more" }, moreBtn),
  );
  await load(true);
  const rows = () => [...body.querySelectorAll<HTMLElement>("tr[data-id]")];
  setKeys({
    j: () => void stepRows(rows(), 1),
    k: () => void stepRows(rows(), -1),
    Enter: () => {
      const r = body.querySelector<HTMLElement>("tr.cur");
      if (r?.dataset.href) location.hash = r.dataset.href;
    },
  });
};

interface FeedbackDetail {
  feedback: Omit<FeedbackItem, "screenshot" | "has_context" | "message_length"> & { screenshot: boolean; screenshot_size: number | null; context: unknown; ip_hash: string | null };
  user: { id: string; name: string; provider: string; created_at: number; merged_into: string | null } | null;
  run: { id: string; user_id: string; map: string; style: string; track: number; status: string; reason: string | null; time: number | null; created_at: number } | null;
  history: ModRow[];
  sameIp: number;
  replies?: { id: number; body: string; from_actor: string; from_name: string | null; from_avatar?: string | null; created_at: number; read_at: number | null }[];
  recipient?: { id: string; name: string; provider: string } | null;
  vetting?: Vetting | null;
  report?: ReportFacts;
}

/** apps/api src/player-reports.ts ReportFacts. */
interface ReportFacts {
  reason: "cheating" | "chat" | null;
  note: string | null;
  player: { id: string; name: string; provider: string; createdAt: number; ageDays: number; verified: number; wrs: number; openFlags: number; shadowed: boolean; role: StaffRole | null } | null;
  otherOpen: number;
  reporters: number;
  run: { id: string; map: string; tier: number | null; style: string; track: number; time: number | null; status: string; rank: number | null; board: number } | null;
  reporter: { id: string; name: string; provider: string; ageDays: number; verified: number; shadowed: boolean } | null;
}

/** A player report: who it's about and where they stand, with the way to their profile, runs, flags and other reports. */
function reportCard(r: ReportFacts | undefined): HTMLElement {
  const p = r?.player;
  if (!r || !p) return h("section", { class: "card" }, h("h2", null, "Reported player"), h("p", { class: "faint" }, "That player no longer exists."));
  const id = encodeURIComponent(p.id);
  const none = (t: string) => h("span", { class: "faint" }, t);
  return h(
    "section",
    { class: "card vetting" },
    h("h2", null, "Reported player"),
    h(
      "dl",
      { class: "kv" },
      h("dt", null, "Player"),
      h("dd", null, playerLink(p.id, p.name), " ", badge(p.provider, p.provider === "guest" ? "warn" : "info"), p.shadowed ? [" ", badge("shadowed", "bad")] : null, p.role ? [" ", badge(p.role, "ok")] : null, h("span", { class: "faint", title: when(p.createdAt) }, ` joined ${ago(p.createdAt)}`)),
      h("dt", null, "Reason"),
      h("dd", null, r.reason === "chat" ? "Chat or name" : r.reason === "cheating" ? "Cheating" : none("not given")),
      ...(r.run
        ? [
            h("dt", null, "Run"),
            h(
              "dd",
              null,
              mapLine(r.run.map, { track: r.run.track }),
              " ",
              h("span", { class: "t-run" }, fmtTime(r.run.time)),
              r.run.rank ? h("span", { class: "faint" }, r.run.rank === 1 ? " WR" : ` #${r.run.rank} of ${r.run.board}`) : null,
              " ",
              badge(r.run.status, r.run.status === "verified" ? "ok" : "bad"),
            ),
          ]
        : []),
      h("dt", null, "Runs"),
      h("dd", null, h("a", { href: `#/runs?user=${id}` }, `${n(p.verified)} verified`), p.wrs ? h("span", { class: "faint" }, `, ${plural(p.wrs, "WR")}`) : null),
      h("dt", null, "Anticheat"),
      h("dd", null, p.openFlags ? [badge(`${plural(p.openFlags, "open flag")}`, "warn"), " ", h("a", { href: `#/suspicious?case=${id}` }, "Case")] : none("no open flags")),
      h("dt", null, "Other reports"),
      h("dd", null, r.otherOpen ? h("a", { href: `#/feedback?about=${id}` }, `${plural(r.otherOpen, "open report")}${r.reporters > 1 ? ` from ${r.reporters} players` : ""}`) : h("a", { class: "faint", href: `#/feedback?about=${id}` }, "none open")),
      ...(r.reporter ? [h("dt", null, "Reporter"), h("dd", null, `${r.reporter.provider === "guest" ? "guest" : r.reporter.provider}, joined ${r.reporter.ageDays ? `${plural(r.reporter.ageDays, "day")} ago` : "today"}, ${plural(r.reporter.verified, "verified run")}`, r.reporter.shadowed ? [" ", badge("shadowed", "bad")] : null)] : []),
    ),
  );
}

interface Vetting {
  user: { id: string; name: string; provider: string; created_at: number };
  role: StaffRole | null;
  lastSeen: number | null;
  discord: string | null;
  runs: { total: number; verified: number; first: number | null };
  level: number;
  xp: number;
  chat: { messages: number; flagged: number };
  activeBans: { room_id: string; until: number | null; reason: string | null; created_at: number }[];
  moderation: { action: string; n: number; last: number }[];
  flags: { blatant: number; suspicious: number; open: number };
  applications: number;
}

const APPLICATION_ANSWERS: [string, string][] = [
  ["discord", "Discord"],
  ["hours", "Timezone and play hours"],
  ["why", "Why they want to help"],
  ["experience", "Moderation experience"],
];

function applicationAnswers(fb: FeedbackDetail["feedback"]): HTMLElement {
  const a = (fb.context && typeof fb.context === "object" ? (fb.context as { application?: Record<string, unknown> }).application : null) ?? null;
  if (!a) return h("div", { class: "fb-msg" }, fb.message);
  return h("dl", { class: "kv fb-answers" }, APPLICATION_ANSWERS.flatMap(([k, label]) => [h("dt", null, label), h("dd", null, typeof a[k] === "string" && a[k] ? (a[k] as string) : h("span", { class: "faint" }, "—"))]));
}

function vettingCard(d: FeedbackDetail): HTMLElement {
  const v = d.vetting;
  if (!v) return h("section", { class: "card" }, h("h2", null, "Vetting"), h("p", { class: "faint" }, d.vetting === null ? "The applicant's account no longer exists." : "Admins see the vetting and decide."));
  const id = encodeURIComponent(v.user.id);
  const none = (t: string) => h("span", { class: "faint" }, t);
  const flagged = v.flags.blatant + v.flags.suspicious;
  const ban = v.activeBans[0];
  const grant = async () => {
    const ok = await ask({ title: `Make ${v.user.name} a moderator?`, text: "They can then mute, kick, give temporary bans and answer feedback.", confirm: "Make moderator" });
    if (ok && (await act("/admin/staff", { action: "grant", role: "moderator", user: v.user.id, note: `application ${d.feedback.id}` }, `${v.user.name} is now a moderator. Reply to tell them.`))) reroute();
  };
  return h(
    "section",
    { class: "card vetting" },
    h("h2", null, "Vetting"),
    h(
      "dl",
      { class: "kv" },
      h("dt", null, "Account"),
      h("dd", null, playerLink(v.user.id, v.user.name), " ", badge(v.user.provider, v.user.provider === "guest" ? "warn" : "info"), h("span", { title: when(v.user.created_at) }, `joined ${ago(v.user.created_at)}`)),
      h("dt", null, "Discord"),
      h("dd", null, v.discord ?? none("not linked")),
      h("dt", null, "Last seen"),
      h("dd", { title: when(v.lastSeen) }, v.lastSeen ? ago(v.lastSeen) : none("never")),
      h("dt", null, "Level"),
      h("dd", null, `${v.level}`, h("span", { class: "faint" }, ` (${n(v.xp)} XP)`)),
      h("dt", null, "Runs"),
      h("dd", null, h("a", { href: `#/runs?user=${id}` }, `${n(v.runs.verified)} verified`), h("span", { class: "faint" }, ` of ${n(v.runs.total)}`)),
      h("dt", null, "Chat"),
      h("dd", null, v.chat.messages ? h("a", { href: `#/chat?user=${id}` }, `${n(v.chat.messages)} lines`) : none("no chat"), v.chat.flagged ? h("span", { class: "faint" }, `, ${n(v.chat.flagged)} filtered or blocked`) : null),
      h("dt", null, "Bans"),
      h("dd", null, ban ? badge(`banned ${ban.until ? `until ${when(ban.until)}` : "for good"}${ban.reason ? `: ${ban.reason}` : ""}`, "bad") : none("none active")),
      h("dt", null, "Moderation"),
      h("dd", null, v.moderation.length ? h("a", { href: `#/log?target=${id}` }, v.moderation.map((m) => `${actionWords(m.action)[0].toLowerCase()} ${m.n}×`).join(", ")) : none("nothing on record")),
      h("dt", null, "Anticheat"),
      h("dd", null, flagged ? [badge(`${plural(flagged, "flagged run")}, ${v.flags.open ? `${v.flags.open} open` : "all reviewed"}`, v.flags.open ? (v.flags.blatant ? "bad" : "warn") : ""), " ", h("a", { href: `#/suspicious?case=${id}` }, "Case")] : none("no flags")),
      ...(v.applications > 1 ? [h("dt", null, "Applications"), h("dd", null, `${v.applications}, this one included`)] : []),
    ),
    v.role ? h("p", { class: "fb-vet-foot" }, badge(`Already ${{ moderator: "a moderator", admin: "an admin", owner: "the owner" }[v.role]}`, "ok")) : may("staff.moderators") ? h("div", { class: "actions fb-vet-foot" }, h("button", { type: "button", class: "primary", onclick: () => void grant() }, "Make moderator")) : null,
  );
}

interface Snippet {
  id: number;
  title: string;
  body: string;
}
let snippetCache: Snippet[] | null = null;
async function snippets(force = false): Promise<Snippet[]> {
  if (!snippetCache || force) snippetCache = (await api<{ snippets: Snippet[] }>("/admin/snippets").catch(() => ({ snippets: [] }))).snippets;
  return snippetCache;
}

/**
 * Saved replies under the composer: "/" in an empty box (or the Saved replies button) lists them as plain lines; up /
 * down, Enter inserts one, Esc closes. "Save as a reply" keeps the current text for everyone.
 */
function snippetPicker(text: HTMLTextAreaElement): { el: HTMLElement; open: () => void } {
  const list = h("div", { class: "snips", role: "listbox", hidden: true });
  let items: Snippet[] = [];
  let sel = 0;
  const close = () => (list.hidden = true);
  const paint = () =>
    fill(list, 
      ...(items.length
        ? items.map((s, i) =>
            h(
              "button",
              { type: "button", class: `snip${i === sel ? " on" : ""}`, role: "option", "aria-selected": String(i === sel), onclick: () => pick(s) },
              h("b", null, s.title),
              h("span", { class: "faint" }, s.body.split("\n")[0].slice(0, 90)),
              h("span", { class: "snip-x", role: "button", title: "Remove this saved reply", onclick: (e: Event) => (e.stopPropagation(), void remove(s)) }, glyph("close")),
            ),
          )
        : [h("p", { class: "faint snip-empty" }, "No saved replies yet. Write one and save it.")]),
    );
  const pick = (s: Snippet) => {
    const v = text.value.replace(/^\/$/, "");
    text.value = v ? `${v}\n${s.body}` : s.body;
    text.dispatchEvent(new Event("input"));
    close();
    text.focus();
  };
  const remove = async (s: Snippet) => {
    if (await act("/admin/snippets", { action: "remove", id: s.id }, "Saved reply removed")) {
      items = await snippets(true);
      sel = Math.min(sel, Math.max(0, items.length - 1));
      paint();
    }
  };
  const open = async () => {
    items = await snippets();
    sel = 0;
    paint();
    list.hidden = false;
  };
  text.addEventListener("input", () => {
    if (text.value === "/") void open();
    else if (!list.hidden && !text.value.startsWith("/")) close();
  });
  text.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), close());
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length) (sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length), paint();
    } else if (e.key === "Enter" && items[sel]) (e.preventDefault(), pick(items[sel]));
  });
  return { el: list, open: () => void open() };
}

/** The ticket's thread and composer. */
function replyCard(d: FeedbackDetail, onSent: (status?: string) => void): { el: HTMLElement; text: HTMLTextAreaElement | null; send: (status?: string) => Promise<void> } {
  const fb = d.feedback;
  const replies = d.replies ?? [];
  const playerName = d.recipient?.name ?? d.user?.name ?? fb.user_name ?? "Player";
  const waiting = fb.player_reply_at ?? null;
  const seen = async () => {
    if (await act(`/admin/feedback/${encodeURIComponent(fb.id)}`, { action: "seen" }, "Marked read")) {
      void refreshFeedbackBadge();
      reroute();
    }
  };
  const thread = replies.length
    ? h(
        "div",
        { class: "fb-thread" },
        replies.map((r) => {
          const mine = r.from_actor === "player";
          return h(
            "div",
            { class: mine ? "fb-reply is-player" : "fb-reply" },
            avatar({ name: mine ? playerName : r.from_actor === "token" ? "Admin" : (r.from_name ?? "?"), avatar: mine ? null : (r.from_avatar ?? null) }, { staff: !mine }),
            h(
              "div",
              { class: "fb-reply-head" },
              h("b", null, mine ? playerName : r.from_actor === "token" ? "Admin token" : (r.from_name ?? r.from_actor)),
              h("span", { class: "faint", title: when(r.created_at) }, ago(r.created_at)),
              mine ? (waiting !== null && r.created_at >= waiting ? badge("not answered", "warn") : null) : r.read_at ? badge(`read ${ago(r.read_at)}`, "ok") : badge("unread", "acc"),
            ),
            h("div", { class: "fb-reply-body" }, r.body),
          );
        }),
        waiting !== null ? h("div", { class: "fb-waiting" }, h("button", { type: "button", class: "small", onclick: () => void seen() }, glyph("check"), "Mark read")) : null,
      )
    : null;
  if (!d.recipient) {
    return {
      el: h("section", { class: "card" }, h("h2", null, "Replies"), thread, h("p", { class: "fb-noinbox" }, fb.user_id ? "That player no longer exists, so a reply can't reach them." : "Sent without a session, so there's no inbox to reply to.", fb.contact ? [" They left: ", h("b", null, fb.contact)] : null)),
      text: null,
      send: async () => undefined,
    };
  }
  const text = h("textarea", { placeholder: `Reply to ${d.recipient.name} (/ for saved replies)`, maxlength: "2000" });
  const counter = h("span", { class: "faint" }, "0 / 2000");
  text.addEventListener("input", () => (counter.textContent = `${[...text.value].length} / 2000`));
  const picker = snippetPicker(text);
  const send = async (status?: string) => {
    if (!text.value.trim()) return toast("Write a reply first.", true), text.focus();
    const r = await act<{ status: string }>(`/admin/feedback/${encodeURIComponent(fb.id)}`, { action: "reply", body: text.value, ...(status ? { status } : {}) }, status === "resolved" ? "Replied and resolved" : "Reply sent");
    if (r) {
      void refreshFeedbackBadge();
      onSent(status);
    }
  };
  const save = async () => {
    if (!text.value.trim()) return toast("Write the reply first, then save it.", true);
    const v = await ask({ title: "Save this reply", fields: [{ name: "title", label: "Name it", kind: "text", required: true, value: text.value.trim().split("\n")[0].slice(0, 40) }], confirm: "Save" });
    if (v && (await act("/admin/snippets", { action: "add", title: v.title, body: text.value.trim() }, "Saved for everyone"))) void snippets(true);
  };
  return {
    el: h(
      "section",
      { class: "card" },
      h("h2", null, "Replies", replies.length ? h("small", null, String(replies.length)) : null),
      thread,
      h(
        "form",
        { class: "fb-note", onsubmit: (e: Event) => (e.preventDefault(), void send()) },
        h("label", { class: "field" }, h("span", null, "To ", playerLink(d.recipient.id, d.recipient.name), fb.user_id !== d.recipient.id ? h("span", { class: "faint" }, " (merged account)") : null), text),
        picker.el,
        h(
          "div",
          { class: "actions" },
          counter,
          h("button", { type: "button", class: "ghost small", onclick: () => picker.open() }, "Saved replies"),
          h("button", { type: "button", class: "ghost small", onclick: () => void save() }, "Save as a reply"),
          h("span", { style: "flex:1" }),
          h("button", { type: "submit" }, glyph("reply"), fb.status === "new" ? "Send, mark triaged" : "Send"),
          fb.status !== "resolved" ? h("button", { type: "button", class: "primary", onclick: () => void send("resolved") }, "Reply and resolve") : null,
        ),
      ),
    ),
    text,
    send,
  };
}

const CTX_KEYS: [string, string][] = [
  ["map", "Map"],
  ["mapSha256", "Map sha256"],
  ["style", "Style"],
  ["track", "Track"],
  ["timer", "Timer"],
  ["position", "Position"],
  ["velocity", "Velocity"],
  ["speed", "Speed (u/s)"],
  ["tierSuggestion", "Tier"],
  ["runId", "Run"],
  ["room", "Room"],
  ["clientBuild", "Client build"],
  ["webBuild", "Web build"],
  ["page", "Page"],
  ["ua", "Browser"],
  ["screenSize", "Screen"],
  ["viewport", "Viewport"],
  ["gpu", "GPU"],
  ["fps", "FPS"],
  ["settings", "Settings"],
];

function ctxValue(k: string, v: unknown): Node | string {
  if (v === null || v === undefined) return "—";
  if (k === "map" && typeof v === "string") return h("a", { href: `/maps/${encodeURIComponent(v)}`, target: "_blank", rel: "noopener" }, v);
  if (k === "tierSuggestion" && typeof v === "object") return `${tierLabel((v as { current?: number }).current)} → ${tierLabel((v as { suggested?: number }).suggested)} suggested`;
  if (k === "runId" && typeof v === "string") return h("a", { href: `/replay/${encodeURIComponent(v)}`, target: "_blank", rel: "noopener", class: "mono" }, v);
  if (k === "page" && typeof v === "string") return h("span", { class: "mono" }, v);
  if (k === "timer" && typeof v === "object") {
    const t = v as { status?: string; ticks?: number; inStart?: boolean };
    return `${t.status ?? "?"}${t.ticks ? `, ${t.ticks} ticks (${(t.ticks / 100).toFixed(2)} s)` : ""}${t.inStart ? ", in the start zone" : ""}`;
  }
  if (k === "gpu" && typeof v === "object") {
    const g = v as { renderer?: string; vendor?: string; version?: string };
    return [g.renderer, g.vendor, g.version].filter(Boolean).join(", ");
  }
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return h("span", { class: "ctx-obj" }, Object.entries(v as Record<string, unknown>).map(([a, b]) => h("span", null, h("span", { class: "faint" }, `${a} `), typeof b === "object" ? JSON.stringify(b) : String(b))));
  return String(v);
}

/** Words in a report that look like player names, for an exact lookup (POST /admin/bulk resolve). */
function nameCandidates(text: string): string[] {
  const STOP = new Set(["the", "and", "you", "are", "for", "this", "that", "with", "have", "keeps", "someone", "named", "player", "players", "spamming", "chat", "map", "maps", "east", "west", "server", "please", "when", "what", "there", "their", "they", "just", "like", "from", "into", "every", "time", "tier", "suggested", "reported", "cheating", "name", "run", "normal"]);
  const words = [...new Set(text.match(/[\w.\-]{3,32}/g) ?? [])].filter((w) => !STOP.has(w.toLowerCase()) && !/^\d+$/.test(w));
  // Name-like first: digits, underscores, inner capitals.
  const score = (w: string) => (/\d/.test(w) ? 2 : 0) + (/_/.test(w) ? 2 : 0) + (/[a-z][A-Z]/.test(w) ? 1 : 0);
  return words.sort((a, b) => score(b) - score(a)).slice(0, 12);
}

/** The report's text with the player names it mentions linked. */
function linkedMessage(message: string, names: Map<string, { id: string; name: string }>): Node[] {
  if (!names.size) return [document.createTextNode(message)];
  const re = new RegExp(`(${[...names.keys()].map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  return message.split(re).map((part) => (names.has(part) ? playerLink(names.get(part)!.id, part) : document.createTextNode(part)));
}

/** The next ticket waiting on staff after `id` (new first, then player replies). */
async function nextWaiting(id: string): Promise<string | null> {
  for (const q of ["status=new", "reply=player"]) {
    const r = await api<{ items: { id: string }[] }>(`/admin/feedback?${q}&limit=5`).catch(() => ({ items: [] }));
    const hit = r.items.find((x) => x.id !== id);
    if (hit) return hit.id;
  }
  return null;
}

const feedbackDetail: View = async (root, _params, [id]) => {
  const d = await api<FeedbackDetail>(`/admin/feedback/${encodeURIComponent(id)}`);
  const fb = d.feedback;
  const ctx = fb.context && typeof fb.context === "object" ? (fb.context as Record<string, unknown>) : null;
  const client = feedbackClient(ctx);
  const errors = ctx && Array.isArray(ctx.errors) ? (ctx.errors as { at?: number; kind?: string; msg?: string; src?: string; stack?: string }[]) : [];
  let shotUrl: string | null = null;

  const status = h("select", null, FB_STATUSES.map(([v, l]) => h("option", { value: v, selected: fb.status === v }, l)));
  // The ticket as a case (apps/api src/admin-cases.ts): its board stage, who has it, labels, staff comments, and the
  // player's pinned note. The old single staff note shows first in the comments.
  const caseSlot = h("div", { class: "fb-case" }, h("div", { class: "sk-block sm" }));
  const pinSlot = h("div", { class: "fb-pin" });
  void loadThread("report", fb.id).then(
    (t) => {
      const staffReplies = (d.replies ?? []).filter((r) => r.from_actor !== "player");
      const stage = reportStage({ status: fb.status, player_reply_at: fb.player_reply_at, replies: staffReplies.length, last_reply_at: staffReplies.at(-1)?.created_at ?? null }, t.case);
      fill(pinSlot, pinnedLine(t.notes.find((n) => n.pinned), "pin-line big"));
      fill(
        caseSlot,
        h("dl", { class: "props" }, caseProps("report", fb.id, { stage, assignee: t.case?.assignee ?? null, labels: t.case?.labels ?? [] }, t.staff, { layout: "list", onChange: (_s, what) => what === "stage" && (void refreshFeedbackBadge(), reroute()) })),
        h("h3", null, "Staff comments"),
        timeline("report", fb.id, t, { legacyNote: fb.admin_note ? { body: fb.admin_note, at: fb.updated_at } : null, empty: "No comments yet. The player never sees these." }),
      );
    },
    (e: Error) => fill(caseSlot, h("p", { class: "err" }, `Couldn't load the case: ${e.message}`)),
  );
  const setStatus = async (s: string) => {
    if (s === fb.status) return;
    if (await act(`/admin/feedback/${encodeURIComponent(fb.id)}`, { action: "status", status: s }, `Marked ${FB_STATUSES.find(([v]) => v === s)?.[1].toLowerCase() ?? s}`)) {
      void refreshFeedbackBadge();
      reroute();
    }
  };
  status.onchange = () => void setStatus(status.value);
  const quick = FB_STATUSES.filter(([v]) => v !== fb.status && v !== "new").map(([v, l]) => h("button", { type: "button", class: v === "resolved" ? "primary" : "", onclick: () => void setStatus(v) }, v === "resolved" ? glyph("check") : null, `Mark ${l.toLowerCase()}`));

  const shot = h("div", { class: "fb-shot" });
  if (fb.screenshot) {
    shot.appendChild(h("p", { class: "muted" }, "Loading the screenshot…"));
    void adminBlobUrl(`/admin/feedback/${encodeURIComponent(fb.id)}/screenshot`)
      .then((url) => {
        shotUrl = url;
        fill(shot, h("a", { href: url, target: "_blank", rel: "noopener", title: "Open full size" }, h("img", { src: url, alt: "The player's screenshot" })), h("div", { class: "faint" }, fb.screenshot_size ? `${Math.round(fb.screenshot_size / 1024)} KB` : ""));
      })
      .catch((e) => fill(shot, h("p", { class: "err" }, `Couldn't load the screenshot: ${(e as Error).message}`)));
  }

  const facts = ctx
    ? h(
        "dl",
        { class: "kv" },
        h("dt", null, "Client"),
        h("dd", null, client.kind === "desktop" ? `Desktop app ${client.version}` : client.kind === "native" ? `Native client${client.version ? ` ${client.version}` : ""}` : client.kind === "browser" ? "Browser" : "Unknown"),
        // The native client's user agent is its menu web view's.
        CTX_KEYS.filter(([k]) => k in ctx).flatMap(([k, label]) => [h("dt", null, client.kind === "native" && k === "ua" ? "Menu web view" : label), h("dd", null, ctxValue(k, ctx[k]))]),
        ...(ctx._truncated ? [h("dt", null, "Truncated"), h("dd", null, badge(`cut: ${String(ctx._truncated)}`, "warn"))] : []),
      )
    : h("p", { class: "faint" }, "No game info attached.");

  const application = fb.category === "application";
  const from = d.user
    ? [playerLink(d.user.id, fb.user_name ?? d.user.name), " ", badge(d.user.provider, d.user.provider === "guest" ? "" : "info"), d.user.name !== fb.user_name ? h("div", { class: "faint" }, `now "${d.user.name}"`) : null]
    : fb.user_id
      ? idCell(fb.user_id)
      : h("span", { class: "faint" }, "anonymous");
  const link = (href: string, text: string, icon: string, ext = false) => h("a", { href, target: ext ? "_blank" : undefined, rel: ext ? "noopener" : undefined }, glyph(icon), text, ext ? glyph("ext") : null);

  const message = h("div", { class: "fb-msg" }, fb.message);
  const mentions = h("div", { class: "fb-mentions" });
  if (!application) {
    const cands = nameCandidates(fb.message);
    if (cands.length)
      void api<{ players: { q: string; id?: string; name?: string }[] }>("/admin/bulk", { action: "resolve", names: cands })
        .then((r) => {
          const hits = new Map(r.players.filter((p) => p.id && p.id !== d.user?.id).map((p) => [p.q, { id: p.id!, name: p.name! }]));
          if (!hits.size) return;
          fill(message, ...linkedMessage(fb.message, hits));
          fill(mentions, 
            h("span", { class: "faint" }, "Mentioned: "),
            ...[...hits.values()].flatMap((p, i) => [i ? ", " : "", playerLink(p.id, p.name), " ", h("a", { class: "faint", href: `#/chat?user=${encodeURIComponent(p.id)}` }, "chat")]),
          );
        })
        .catch(() => undefined);
  }

  const side = h(
    "aside",
    { class: "side" },
    h(
      "dl",
      { class: "props" },
      h("dt", null, "Status"),
      h("dd", null, status),
      h("dt", null, "From"),
      h("dd", null, from),
      h("dt", null, "Contact"),
      h("dd", null, fb.contact ?? h("span", { class: "faint" }, "none")),
      h("dt", null, "Same IP"),
      h("dd", null, d.sameIp ? h("a", { href: `#/feedback?sameIp=${encodeURIComponent(fb.id)}` }, plural(d.sameIp, "other report")) : h("span", { class: "faint" }, "no other reports")),
      ...(d.run
        ? [h("dt", null, "Run"), h("dd", null, mapLine(d.run.map, { track: d.run.track }), " ", h("span", { class: "t-run" }, fmtTime(d.run.time)), " ", badge(d.run.status, d.run.status === "verified" ? "ok" : "bad"))]
        : fb.run_id
          ? [h("dt", null, "Run"), h("dd", { class: "faint" }, "not found")]
          : []),
    ),
    h(
      "div",
      { class: "side-links" },
      d.report?.player ? link(`#/player/${encodeURIComponent(d.report.player.id)}`, `${d.report.player.name} (reported)`, "players") : null,
      d.user ? link(`#/player/${encodeURIComponent(d.user.id)}`, "Player", "players") : null,
      d.user ? link(`#/feedback?user=${encodeURIComponent(d.user.id)}`, "Their feedback", "feedback") : null,
      d.user ? link(`#/chat?user=${encodeURIComponent(d.user.id)}`, "Their chat", "chat") : null,
      fb.map ? link(`/?map=${encodeURIComponent(fb.map)}`, `Play ${fb.map}`, "play", true) : null,
      fb.run_id ? link(`/replay/${encodeURIComponent(fb.run_id)}`, "Replay", "play", true) : null,
      fb.run_id && may("runs.read") ? link(`#/runs?id=${encodeURIComponent(fb.run_id)}`, "The run in admin", "runs") : null,
    ),
    caseSlot,
    h("h3", null, "History"),
    d.history.length
      ? h(
          "ol",
          { class: "mod-list" },
          d.history.map((e) => {
            const [w, k] = actionWords(e.action);
            return h("li", null, h("div", null, h("span", { class: `act-word ${k}` }, w), " ", e.actor_id === "token" ? "admin token" : (e.actor_name ?? e.actor_id), h("span", { class: "faint", title: when(e.created_at) }, `, ${ago(e.created_at)}`)), detailSentence(e.action, e.details, e.room_id) ? h("div", { class: "faint" }, detailSentence(e.action, e.details, e.room_id)) : null);
          }),
        )
      : emptyLine("Nothing yet."),
  );
  // After "Reply and resolve", the next ticket waiting on staff opens.
  const reply = replyCard(d, async (st) => {
    if (st !== "resolved") return reroute();
    const nextId = await nextWaiting(fb.id);
    if (nextId) location.hash = `#/feedback/${encodeURIComponent(nextId)}`;
    else (toast("No more tickets waiting."), (location.hash = "#/feedback"));
  });
  const main = h(
    "div",
    { class: "main-col" },
    pinSlot,
    application ? h("section", { class: "card" }, h("h2", null, "Application"), applicationAnswers(fb)) : [message, mentions],
    application ? vettingCard(d) : null,
    fb.category === "report" ? reportCard(d.report) : null,
    reply.el,
    fb.screenshot ? h("section", { class: "card" }, h("h2", null, "Screenshot"), shot) : null,
    application ? null : h("section", { class: "card" }, h("h2", null, "Game info"), facts),
    errors.length
      ? h(
          "section",
          { class: "card" },
          h("h2", null, "Recent client errors", h("small", null, String(errors.length))),
          table(
            ["When", "Kind", "Message"],
            errors
              .slice()
              .reverse()
              .map((e) => h("tr", null, h("td", { class: "time" }, e.at ? when(e.at) : "—"), h("td", null, badge(e.kind ?? "?", e.kind === "console" ? "warn" : "bad")), h("td", { class: "msg" }, h("div", null, e.msg ?? ""), e.src ? h("div", { class: "raw" }, e.src) : null, e.stack ? h("details", null, h("summary", { class: "faint" }, "Stack"), h("pre", { class: "fb-pre" }, e.stack)) : null))),
          ),
        )
      : null,
    ctx && !application ? h("details", { class: "raw-json" }, h("summary", null, glyph("chevron"), "Raw context"), h("pre", { class: "fb-pre" }, JSON.stringify(ctx, null, 2))) : null,
  );
  // j / k: the next / previous ticket in the list this tab last showed.
  const order = loadOrder();
  const at = order.indexOf(fb.id);
  const go = (step: number) => {
    const t = order[at + step];
    if (at >= 0 && t) location.hash = `#/feedback/${encodeURIComponent(t)}`;
    else toast(step > 0 ? "That was the last ticket in the list." : "That was the first ticket in the list.");
  };
  fill(root, 
    h(
      "div",
      { class: "head" },
      h("a", { href: "#/feedback", class: "back-link" }, glyph("back"), "Feedback"),
      h("h1", null, fbCategory(fb.category, fb.message)),
      fbStatusBadge(fb.status),
      h("span", { class: "sub", title: when(fb.created_at) }, ago(fb.created_at)),
      idCell(fb.id),
      h("div", { class: "tools" }, ...quick, help("j / k: next and previous ticket. r: reply and resolve. t: mark triaged. e: write a reply. / in the reply box: saved replies.")),
    ),
    h("div", { class: "split" }, main, side),
  );
  setKeys({
    j: () => go(1),
    k: () => go(-1),
    e: () => reply.text?.focus(),
    t: () => void setStatus("triaged"),
    r: () => (reply.text?.value.trim() ? void reply.send("resolved") : reply.text?.focus()),
  });
  return () => {
    if (shotUrl) URL.revokeObjectURL(shotUrl);
  };
};

export const feedbackView: View = (root, params, rest) => (rest[0] ? feedbackDetail(root, params, rest) : feedbackList(root, params, rest));

// --- Announcements (the players' inbox; apps/api src/inbox.ts)

interface BroadcastRow {
  id: string;
  category: string;
  subject: string;
  body: string;
  audience: "all" | "active";
  active_days: number | null;
  audience_est: number;
  created_by: string;
  created_by_name: string | null;
  created_at: number;
  expires_at: number;
  delivered: number;
  read: number;
}

export const announceView: View = async (root) => {
  const d = await api<{ broadcasts: BroadcastRow[]; audiences: { all: number; active: number; activeDays: number }; now: number }>("/admin/broadcasts");
  const subject = h("input", { type: "text", maxlength: "120", placeholder: "New maps are live", required: true });
  const body = h("textarea", { maxlength: "2000", placeholder: "What players read. Plain text; line breaks are kept.", style: "min-height:7rem" });
  const category = h("select", null, MSG_CATEGORIES.map(([v, l]) => h("option", { value: v }, l)));
  const audience = h("select", null, h("option", { value: "all" }, `Everyone (${n(d.audiences.all)})`), h("option", { value: "active" }, "Players who ran recently"), h("option", { value: "one" }, "One player"));
  const activeDays = h("input", { type: "number", min: "1", max: "365", value: String(d.audiences.activeDays) });
  const userId = h("input", { type: "text", placeholder: "player id" });
  const days = h("input", { type: "number", min: "1", max: "365", value: "30" });
  const est = h("span", { class: "faint" });
  const activeWrap = h("label", null, "Ran in the last N days", activeDays);
  const userWrap = h("label", null, "Player id", userId);
  const daysWrap = h("label", { title: "Players who first open their inbox after this don't get it" }, "Deliver for (days)", days);
  const sync = async () => {
    const a = audience.value;
    activeWrap.hidden = a !== "active";
    userWrap.hidden = a !== "one";
    daysWrap.hidden = a === "one";
    est.textContent = "";
    if (a === "one") return;
    try {
      const r = await api<{ recipients: number }>("/admin/broadcasts", { action: "preview", audience: a, activeDays: Number(activeDays.value) });
      est.textContent = `About ${plural(r.recipients, "player")} would get it.`;
    } catch (e) {
      est.textContent = String((e as Error).message);
    }
  };
  audience.onchange = () => void sync();
  activeDays.onchange = () => void sync();
  const send = async (e: Event) => {
    e.preventDefault();
    if (!subject.value.trim() || !body.value.trim()) return toast("A subject and a message, please.", true);
    if (audience.value === "one") {
      if (!userId.value.trim()) return toast("Enter the player's id.", true);
      if (await act("/admin/messages", { user: userId.value.trim(), subject: subject.value, body: body.value, category: category.value }, "Message sent")) reroute();
      return;
    }
    const who = audience.value === "all" ? "every player" : `players who ran in the last ${activeDays.value} days`;
    const ok = await ask({ title: "Send this announcement?", text: `"${subject.value.trim()}" to ${who}. You can stop it later, not edit it.`, confirm: "Send" });
    if (ok && (await act("/admin/broadcasts", { action: "send", subject: subject.value, body: body.value, category: category.value, audience: audience.value, activeDays: Number(activeDays.value), days: Number(days.value) }, "Announcement sent"))) reroute();
  };
  const stop = async (b: BroadcastRow) => {
    const v = await ask({ title: `Stop "${b.subject}"?`, text: "Nobody else gets it. Players who have it keep it unless you remove it too.", fields: [{ name: "remove", label: `Also remove the ${b.delivered} delivered`, kind: "check" }], confirm: "Stop", danger: true });
    if (v && (await act("/admin/broadcasts", { action: "stop", id: b.id, remove: !!v.remove }, "Stopped"))) reroute();
  };
  const pct = (a: number, b: number) => (b ? ` (${Math.round((a / b) * 100)}%)` : "");
  fill(root, 
    h(
      "section",
      { class: "card compose" },
      h("h2", null, "Write"),
      h(
        "form",
        { class: "fb-note", onsubmit: send },
        h("div", { class: "filters" }, h("label", null, "Audience", audience), activeWrap, userWrap, h("label", null, "Category", category), daysWrap),
        h("label", { class: "field" }, "Subject", subject),
        h("label", { class: "field" }, "Message", body),
        h("div", { class: "actions" }, est, h("span", { style: "flex:1" }), h("button", { type: "submit", class: "primary" }, "Send")),
      ),
    ),
    h(
      "section",
      { class: "card" },
      h(
        "h2",
        null,
        "Sent",
        help("An announcement is stored once. Each player's copy is made the next time their game opens a menu, so Delivered counts players who came back since and Read those who opened it. Players who join later don't get it, and nobody gets it after its delivery window."),
      ),
      table(
        ["When", "Subject", "Category", "Audience", ["Eligible", "num"], ["Delivered", "num"], ["Read", "num"], "Delivering", "By", ""],
        d.broadcasts.map((b) => {
          const live = b.expires_at > d.now;
          return h(
            "tr",
            null,
            h("td", { class: "time", title: when(b.created_at) }, ago(b.created_at)),
            h("td", { class: "msg" }, h("b", null, b.subject), h("div", { class: "raw" }, b.body.length > 160 ? `${b.body.slice(0, 160)}…` : b.body)),
            h("td", null, MSG_CATEGORIES.find(([v]) => v === b.category)?.[1] ?? b.category),
            h("td", { class: "nowrap" }, b.audience === "all" ? "everyone" : `ran in ${b.active_days} days`),
            h("td", { class: "num" }, n(b.audience_est)),
            h("td", { class: "num" }, n(b.delivered), h("span", { class: "faint" }, pct(b.delivered, b.audience_est))),
            h("td", { class: "num" }, n(b.read), h("span", { class: "faint" }, pct(b.read, b.delivered))),
            h("td", { class: "nowrap", title: when(b.expires_at) }, live ? badge(`${Math.ceil((b.expires_at - d.now) / 86_400_000)} days left`, "ok") : badge("ended")),
            h("td", { class: "nowrap" }, b.created_by === "token" ? h("span", { class: "faint" }, "token") : playerLink(b.created_by, b.created_by_name)),
            h("td", { class: "acts" }, live || b.delivered ? h("button", { class: "small", onclick: () => void stop(b) }, "Stop…") : null),
          );
        }),
        "Nothing sent yet.",
      ),
    ),
  );
  void sync();
};
