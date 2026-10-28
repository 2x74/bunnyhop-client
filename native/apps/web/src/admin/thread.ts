// A case's properties and timeline (apps/api src/admin-cases.ts), shared by the anticheat case and the feedback ticket:
// the stage, who has it, its labels, and one timeline of staff comments and what changed, like an issue tracker.
// Anticheat timelines also carry the player's flags and moderation (bans, shadow, warnings) as quiet lines. A comment
// can be saved as a player note in the same press. Mentioning a staff member (@name) on an anticheat case moves it to
// Second opinion.

import { act, ago, api, avatar, emptyLine, glyph, h, may, me, toast, when, fmtTime, type Person } from "./core";
import { actionWords, detailSentence } from "./words";
import type { Note } from "./notes";

export type CaseKind = "ac" | "report";

export const STAGES: Record<CaseKind, [string, string][]> = {
  ac: [
    ["triage", "Triage"],
    ["looking", "Looking"],
    ["second", "Second opinion"],
    ["done", "Done"],
  ],
  report: [
    ["triage", "Triage"],
    ["looking", "Looking"],
    ["waiting", "Waiting on player"],
    ["done", "Done"],
  ],
};
export const stageWord = (kind: CaseKind, s: string) => STAGES[kind].find(([v]) => v === s)?.[1] ?? s;

const RESOLUTION_WORD: Record<string, string> = { cleared: "cleared", shadowed: "shadowbanned", invalidated: "invalidated", banned: "banned", approved: "approved", resolved: "resolved", wontfix: "won't fix" };
/**
 * The column a ticket is in: new is Triage, resolved / won't fix Done; a player's answer waiting is Looking; otherwise
 * the stage staff picked, where Looking turns to Waiting once staff reply after picking it; untouched: Waiting after a
 * staff reply, else Looking.
 */
export function reportStage(t: { status: string; player_reply_at?: number | null; last_reply_at?: number | null; replies?: number }, c: { stage: string; updated_at: number } | null | undefined): string {
  if (t.status === "new") return "triage";
  if (t.status === "resolved" || t.status === "wontfix") return "done";
  if (t.player_reply_at) return "looking";
  if (c?.stage === "waiting") return "waiting";
  if (c?.stage === "looking") return (t.last_reply_at ?? 0) > c.updated_at ? "waiting" : "looking";
  return t.replies ? "waiting" : "looking";
}

export const resolutionWord = (r: string | null | undefined) => (r ? (RESOLUTION_WORD[r] ?? r) : "closed");

export interface CaseInfo {
  id: number;
  kind: CaseKind;
  subject: string;
  stage: string;
  assignee: string | null;
  labels: string[];
  resolution: string | null;
  opened_at: number;
  updated_at: number;
  closed_at: number | null;
}

export interface TimelineEvent {
  id: string;
  at: number;
  kind: string;
  actor: Person | null;
  body: string | null;
  data: Record<string, unknown> | null;
}

export interface ThreadData {
  case: CaseInfo | null;
  cases: number;
  user: string | null;
  events: TimelineEvent[];
  notes: Note[];
  staff: Person[];
}

export const loadThread = (kind: CaseKind, subject: string) => api<ThreadData>(`/admin/cases/thread?kind=${kind}&subject=${encodeURIComponent(subject)}`);

/** POST /admin/cases; resolves with the response or null (the toast says why). */
export const caseAct = <T = Record<string, unknown>>(kind: CaseKind, subject: string, body: Record<string, unknown>, done = "") => act<T>("/admin/cases", { kind, subject, ...body }, done);

// ---------------------------------------------------------------------------------------------
// A small menu under a button (stage, assignee, labels). Esc, a pick or a click elsewhere closes it.

export interface MenuItem {
  label: string;
  icon?: Node | null;
  on: () => void;
  checked?: boolean;
  hint?: string;
}

let openMenuEl: HTMLElement | null = null;
export function closeMenu(): void {
  openMenuEl?.remove();
  openMenuEl = null;
}

export function openMenu(anchor: HTMLElement, items: MenuItem[], o: { input?: { placeholder: string; onEnter: (v: string) => void } } = {}): void {
  closeMenu();
  const r = anchor.getBoundingClientRect();
  const list = h(
    "div",
    { class: "menu", role: "menu" },
    o.input
      ? h("input", {
          type: "text",
          class: "menu-input",
          placeholder: o.input.placeholder,
          maxlength: "24",
          onkeydown: (e: KeyboardEvent) => {
            const t = e.currentTarget as HTMLInputElement;
            if (e.key === "Enter" && t.value.trim()) (e.preventDefault(), o.input!.onEnter(t.value.trim()), closeMenu());
          },
        })
      : null,
    items.map((it) =>
      h(
        "button",
        { type: "button", role: "menuitemradio", "aria-checked": String(!!it.checked), class: `menu-item${it.checked ? " on" : ""}`, onclick: () => (closeMenu(), it.on()) },
        it.icon ?? null,
        h("span", { class: "menu-label" }, it.label),
        it.hint ? h("span", { class: "menu-hint" }, it.hint) : null,
        it.checked ? glyph("check") : null,
      ),
    ),
  );
  document.body.append(list);
  const w = list.offsetWidth;
  list.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left))}px`;
  const below = r.bottom + 6;
  list.style.top = below + list.offsetHeight > innerHeight - 8 ? `${Math.max(8, r.top - list.offsetHeight - 6)}px` : `${below}px`;
  openMenuEl = list;
  (list.querySelector("input, .menu-item.on, .menu-item") as HTMLElement | null)?.focus({ preventScroll: true });
  const away = (e: Event) => {
    if (!list.contains(e.target as Node) && e.target !== anchor) (closeMenu(), document.removeEventListener("pointerdown", away, true));
  };
  document.addEventListener("pointerdown", away, true);
  list.addEventListener("keydown", (e) => {
    if (e.key === "Escape") (e.stopPropagation(), closeMenu(), anchor.focus());
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const all = [...list.querySelectorAll<HTMLElement>(".menu-item")];
      const i = all.indexOf(document.activeElement as HTMLElement);
      all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
    }
  });
  // The page scrolling away closes it (not the menu's own list scrolling); armed after this frame's layout settles.
  const onScroll = (e: Event) => {
    if (list.contains(e.target as Node)) return;
    removeEventListener("scroll", onScroll, true);
    if (openMenuEl === list) closeMenu();
  };
  requestAnimationFrame(() => openMenuEl === list && addEventListener("scroll", onScroll, true));
}

// ---------------------------------------------------------------------------------------------
// Properties: stage, assignee, labels

/** Labels as quiet words with a mark (not pills). */
export const labelWords = (labels: string[]) => labels.map((l) => h("span", { class: "lbl" }, l));

const LABEL_SUGGEST: Record<CaseKind, string[]> = {
  ac: ["snap tap", "scroll", "timescale", "autostrafe", "new account", "alt", "short map"],
  report: ["bug", "map", "input", "browser", "desktop", "physics", "duplicate"],
};

export interface PropsState {
  stage: string;
  assignee: string | null;
  labels: string[];
}

/**
 * The case's stage, assignee and labels as three quiet controls. Each change saves at once. `stageLocked`: Done on an
 * anticheat case comes from Clear / Shadowban / Ban, so it isn't offered here.
 */
export function caseProps(kind: CaseKind, subject: string, state: PropsState, staff: Person[], o: { onChange?: (s: PropsState, what: "stage" | "assignee" | "labels") => void; layout?: "row" | "list" } = {}): HTMLElement {
  const work = may("cases.work");
  const root = h("div", { class: `case-props ${o.layout ?? "row"}` });
  const who = (id: string | null) => (id ? (staff.find((p) => p.id === id) ?? { id, name: "Someone", avatar: null }) : null);
  const set = async (what: "stage" | "assignee" | "labels", body: Record<string, unknown>, done: string) => {
    const r = await caseAct(kind, subject, body, done);
    if (!r) return;
    if (what === "stage") state.stage = body.stage as string;
    if (what === "assignee") state.assignee = (body.assignee as string | null) ?? null;
    if (what === "labels") state.labels = (r as { labels?: string[] }).labels ?? (body.labels as string[]);
    paint();
    o.onChange?.(state, what);
  };
  const stageBtn = () =>
    h(
      "button",
      {
        type: "button",
        class: `prop prop-stage s-${state.stage}`,
        disabled: !work,
        onclick: (e: Event) =>
          openMenu(
            e.currentTarget as HTMLElement,
            STAGES[kind]
              .filter(([v]) => kind === "report" || v !== "done" || state.stage === "done")
              .map(([v, l]) => ({ label: l, icon: h("span", { class: `stage-dot s-${v}` }), checked: v === state.stage, on: () => v !== state.stage && void set("stage", { action: "move", stage: v }, `Moved to ${l.toLowerCase()}`) })),
          ),
      },
      h("span", { class: `stage-dot s-${state.stage}` }),
      stageWord(kind, state.stage),
    );
  const assigneeBtn = () => {
    const p = who(state.assignee);
    return h(
      "button",
      {
        type: "button",
        class: "prop prop-who",
        disabled: !work,
        onclick: (e: Event) =>
          openMenu(e.currentTarget as HTMLElement, [
            ...(me && !me.token && state.assignee !== me.id ? [{ label: "Assign to me", icon: avatar(staff.find((x) => x.id === me!.id) ?? { name: me.name, avatar: me.avatar ?? null }, { size: 20, staff: true }), on: () => void set("assignee", { action: "assign", assignee: me!.id }, "Assigned to you") }] : []),
            ...staff.map((s) => ({ label: s.name, hint: s.role ?? undefined, icon: avatar(s, { size: 20, staff: true }), checked: s.id === state.assignee, on: () => void set("assignee", { action: "assign", assignee: s.id }, `Assigned to ${s.name}`) })),
            ...(state.assignee ? [{ label: "Unassign", icon: glyph("close"), on: () => void set("assignee", { action: "assign", assignee: null }, "Unassigned") }] : []),
          ]),
      },
      p ? avatar(p, { size: 20, staff: true }) : glyph("assign"),
      p ? p.name : "Unassigned",
    );
  };
  const labelsBtn = () =>
    h(
      "button",
      {
        type: "button",
        class: "prop prop-labels",
        disabled: !work,
        onclick: (e: Event) => {
          const toggle = (l: string) => void set("labels", { action: "labels", labels: state.labels.includes(l) ? state.labels.filter((x) => x !== l) : [...state.labels, l] }, "");
          const all = [...new Set([...state.labels, ...LABEL_SUGGEST[kind]])];
          openMenu(
            e.currentTarget as HTMLElement,
            all.map((l) => ({ label: l, checked: state.labels.includes(l), on: () => toggle(l) })),
            { input: { placeholder: "New label", onEnter: (v) => toggle(v.toLowerCase()) } },
          );
        },
      },
      state.labels.length ? labelWords(state.labels) : [glyph("plus"), "Label"],
    );
  const paint = () => {
    const rows: [string, HTMLElement][] = [
      ["Stage", stageBtn()],
      ["Assignee", assigneeBtn()],
      ["Labels", labelsBtn()],
    ];
    root.replaceChildren(...(o.layout === "list" ? rows.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]) : rows.map(([, v]) => v)));
  };
  paint();
  return root;
}

// ---------------------------------------------------------------------------------------------
// Timeline

const MENTION = /(^|\s)@([\w.-]{2,32})/g;

/** A comment's text with @mentions marked (text nodes only). */
function commentBody(text: string, staff: Person[]): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    const name = m[2].toLowerCase();
    const p = staff.find((s) => s.name.toLowerCase().replace(/\s+/g, "") === name || s.name.toLowerCase().split(/\s+/)[0] === name);
    if (!p) continue;
    const at = (m.index ?? 0) + m[1].length;
    out.push(document.createTextNode(text.slice(last, at)), h("span", { class: "mention" }, `@${p.name}`));
    last = at + m[2].length + 1;
  }
  out.push(document.createTextNode(text.slice(last)));
  return out;
}

/** Staff mentioned in a comment. */
export function mentioned(text: string, staff: Person[]): Person[] {
  const out: Person[] = [];
  for (const m of text.matchAll(MENTION)) {
    const name = m[2].toLowerCase();
    const p = staff.find((s) => s.name.toLowerCase().replace(/\s+/g, "") === name || s.name.toLowerCase().split(/\s+/)[0] === name);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

function eventLine(kind: CaseKind, e: TimelineEvent, staff: Person[]): HTMLElement | null {
  const who = e.actor?.name ?? "Someone";
  const d = e.data ?? {};
  const time = h("span", { class: "tl-time", title: when(e.at) }, ago(e.at));
  // Bun-E's changes say who asked her.
  const forWho = typeof d.asked === "string" ? h("span", { class: "faint" }, ` for ${d.asked}`) : null;
  const quiet = (...parts: (Node | string | null)[]) => h("div", { class: `tl-ev tl-${e.kind}` }, h("span", { class: "tl-mark" }), h("div", { class: "tl-text" }, ...parts.filter((x) => x !== null), forWho, " ", time));
  const nameOf = (id: unknown) => (typeof id === "string" ? (staff.find((s) => s.id === id)?.name ?? "someone") : null);
  switch (e.kind) {
    case "comment":
      return h(
        "div",
        { class: "tl-comment" },
        avatar(e.actor, { size: 26, staff: true }),
        h(
          "div",
          { class: "tl-c-main" },
          h("div", { class: "tl-c-head" }, h("b", null, who), forWho, time, d.note ? h("span", { class: "faint" }, glyph("pin"), "saved as a player note") : null),
          h("div", { class: "tl-c-body" }, ...commentBody(e.body ?? "", staff)),
        ),
      );
    case "stage":
      return quiet(h("b", null, who), ` moved it to ${stageWord(kind, String(d.to))}`);
    case "assign":
      return quiet(h("b", null, who), ...(d.to ? (d.to === e.actor?.id ? [" took it"] : [" assigned it to ", h("b", null, nameOf(d.to))]) : [" unassigned it"]));
    case "labels": {
      const add = (d.added as string[] | undefined) ?? [];
      const rem = (d.removed as string[] | undefined) ?? [];
      return quiet(h("b", null, who), add.length ? ` labelled it ${add.join(", ")}` : "", add.length && rem.length ? "," : "", rem.length ? ` took off ${rem.join(", ")}` : "");
    }
    case "resolve":
      return quiet(h("b", null, who), ` closed it: ${resolutionWord(String(d.to))}`);
    case "flag": {
      const run = String(d.run ?? "");
      return quiet(h("a", { href: `#/suspicious?run=${encodeURIComponent(run)}` }, `Flagged on ${String(d.map ?? "a map")}`), typeof d.time === "number" ? ` ${fmtTime(d.time)}` : "", `, score ${String(d.score ?? "?")}${d.tier === "blatant" ? ", blatant" : ""}${d.review ? `, ${String(d.review)}` : ""}`);
    }
    case "log": {
      const action = String(d.action ?? "");
      const [word, tone] = actionWords(action);
      const raw = d.details ? JSON.stringify(d.details) : null;
      const s = detailSentence(action, raw);
      return quiet(h("span", { class: `act-word ${tone}` }, word), " by ", h("b", null, who), s ? `. ${s}` : "");
    }
    default:
      return null;
  }
}

/** Flags in a row fold into one line ("4 more flags"), so a busy player's timeline still reads. */
function foldFlags(nodes: { e: TimelineEvent; el: HTMLElement }[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let i = 0; i < nodes.length; ) {
    if (nodes[i].e.kind !== "flag") (out.push(nodes[i].el), i++);
    else {
      let j = i;
      while (j < nodes.length && nodes[j].e.kind === "flag") j++;
      const run = nodes.slice(i, j).map((x) => x.el);
      if (run.length <= 3) out.push(...run);
      else {
        const more = h("details", { class: "tl-fold" }, h("summary", null, h("span", { class: "tl-mark" }), `${run.length - 2} more flags`), ...run.slice(1, -1));
        out.push(run[0], more, run[run.length - 1]);
      }
      i = j;
    }
  }
  return out;
}

/**
 * The timeline and the comment box. `legacyNote`: a ticket's old single staff note, shown first. onComment: after a
 * comment lands (the host can refresh its pin or move a card).
 */
export function timeline(kind: CaseKind, subject: string, data: ThreadData, o: { legacyNote?: { body: string; at: number } | null; onComment?: (note: boolean) => void; empty?: string; stage?: () => string } = {}): HTMLElement {
  const root = h("div", { class: "tl" });
  const list = h("div", { class: "tl-list" });
  const paint = () => {
    const nodes = data.events.map((e) => ({ e, el: eventLine(kind, e, data.staff) })).filter((x): x is { e: TimelineEvent; el: HTMLElement } => !!x.el);
    const legacy = o.legacyNote?.body
      ? h("div", { class: "tl-comment legacy" }, h("span", { class: "av", "aria-hidden": "true" }, glyph("note")), h("div", { class: "tl-c-main" }, h("div", { class: "tl-c-head" }, h("b", null, "Staff note"), h("span", { class: "tl-time" }, "from before comments")), h("div", { class: "tl-c-body" }, o.legacyNote.body)))
      : null;
    list.replaceChildren(...(legacy ? [legacy] : []), ...(nodes.length ? foldFlags(nodes) : legacy ? [] : [emptyLine(o.empty ?? "No comments yet.")]));
  };
  paint();
  if (!may("cases.work")) return root.append(list), root;

  const text = h("textarea", { class: "tl-input", rows: 2, maxlength: "2000", placeholder: kind === "ac" ? "Comment, or @name for a second opinion" : "Comment for staff (the player never sees it)" });
  const asNote = h("button", { type: "button", class: "small ghost tl-note-toggle", "aria-pressed": "false", title: "Also save it as a note on the player", disabled: !data.user || !may("player.notes") }, glyph("pin"), "Also a player note");
  asNote.onclick = () => asNote.setAttribute("aria-pressed", String(asNote.getAttribute("aria-pressed") !== "true"));
  const send = async () => {
    const body = text.value.trim();
    if (!body) return toast("Write a comment first.", true), text.focus();
    const note = asNote.getAttribute("aria-pressed") === "true";
    const r = await caseAct<{ case: number }>(kind, subject, { action: "comment", body, note }, note ? "Comment added and saved as a note" : "Comment added");
    if (!r) return;
    text.value = "";
    asNote.setAttribute("aria-pressed", "false");
    data.events.push({ id: `new${Date.now()}`, at: Date.now(), kind: "comment", actor: data.staff.find((s) => s.id === me?.id) ?? { id: me?.id ?? "token", name: me?.name ?? "You", avatar: me?.avatar ?? null }, body, data: note ? { note: 1 } : null });
    // An @mention asks for a second opinion: the anticheat card moves there.
    if (kind === "ac" && mentioned(body, data.staff).some((p) => p.id !== me?.id) && ["triage", "looking"].includes(o.stage?.() ?? "triage")) {
      const m = await caseAct(kind, subject, { action: "move", stage: "second" }, "Moved to second opinion");
      if (m) data.events.push({ id: `mv${Date.now()}`, at: Date.now(), kind: "stage", actor: data.staff.find((s) => s.id === me?.id) ?? null, body: null, data: { to: "second" } });
    }
    paint();
    o.onComment?.(note);
  };
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), void send());
  });
  const form = h(
    "form",
    { class: "tl-new", onsubmit: (e: Event) => (e.preventDefault(), void send()) },
    avatar(data.staff.find((s) => s.id === me?.id) ?? { name: me?.name ?? "?", avatar: me?.avatar ?? null }, { size: 26, staff: true }),
    h("div", { class: "tl-new-main" }, text, h("div", { class: "tl-new-acts" }, asNote, h("span", { class: "spacer" }), h("span", { class: "faint tl-hint" }, "Ctrl Enter"), h("button", { type: "submit", class: "small" }, "Comment"))),
  );
  root.append(list, form);
  return root;
}
