// Staff: the team (who holds which role, their week) and the moderation log. Log rows read as words ("Muted",
// "Cleared a flag") with a plain sentence of details, and a row the viewer may reverse has Undo: staff who outrank
// whoever did it, or the one who did it (POST /admin/log/undo runs the reverse through the same checked paths).

import { act, ago, api, ask, emptyLine, glyph, h, may, me, playerLink, reroute, rooms, staffShield, table, timeCell, when, type ModRow, type View, fill } from "./core";
import { actionWords, detailSentence } from "./words";
import { stamp } from "./ui";
import { MOD_BAN_MAX_MINUTES, outranks } from "../moderation/staff";
import type { StaffRole } from "../progression";

/** Log actions the server can reverse (apps/api src/admin-tools.ts UNDOABLE). */
const UNDOABLE = new Set([
  "mute", "ban", "shadow", "unshadow", "integrity-clear", "integrity-reopen", "verify", "unverify", "creator-set", "creator-clear", "badge-grant", "badge-revoke",
  "supporter-grant", "supporter-revoke", "network-ban", "run-invalidate", "block-term", "unblock-term", "ban-name", "map-tier", "map-retire", "map-unretire",
  "avatar-block", "avatar-unblock",
]);

const mayUndo = (e: ModRow) => UNDOABLE.has(e.action) && !e.undone_at && e.actor_role !== undefined && (e.actor_id === me?.id || outranks(me?.role, e.actor_role ?? null));

/** Consecutive rows by the same staff member, same action and same details within this long fold into one. */
const GROUP_MS = 15 * 60_000;
/** Fewer than this many alike rows stay as they are. */
const GROUP_MIN = 3;

/** Runs of alike rows (a bulk invalidate, a batch of clears): each run is one group, newest first like the rows. */
function groupRows(rows: ModRow[]): ModRow[][] {
  const out: ModRow[][] = [];
  // Clearing a player's flags names each run's map: those fold per player instead of per sentence.
  const key = (e: ModRow) =>
    `${e.actor_id}|${e.action}|${e.source}|${e.room_id ?? ""}|${e.undone_at ? 1 : 0}|${e.action.startsWith("integrity-") ? `@${e.target_user}` : detailSentence(e.action, e.details, e.room_id)}`;
  for (const e of rows) {
    const g = out[out.length - 1];
    if (g && key(g[0]) === key(e) && g[0].created_at - e.created_at <= GROUP_MS) g.push(e);
    else out.push([e]);
  }
  return out;
}

/**
 * The log as a table. withTarget false: rows about one player (their page). Runs of GROUP_MIN or more alike rows (a bulk
 * invalidate) show as one line with the count and the players; Show opens the rows, each with its own Undo.
 */
export function modTable(rows: ModRow[], withTarget = true): HTMLElement {
  return table(
    ["When", "Who", "What", ...(withTarget ? ["Player"] : []), "Details", ""],
    groupRows(rows).flatMap((g) => (g.length >= GROUP_MIN ? groupLines(g, withTarget) : g.map((e) => modLine(e, withTarget)))),
    "Nothing on record.",
  );
}

/** A folded run of alike rows: one summary line, then the rows (hidden until Show). */
function groupLines(g: ModRow[], withTarget: boolean): HTMLTableRowElement[] {
  const e = g[0];
  const [w, k] = actionWords(e.action);
  const members = g.map((x) => modLine(x, withTarget));
  for (const m of members) (m.hidden = true), m.classList.add("log-member");
  const names = [...new Map(g.filter((x) => x.target_user || x.target_name).map((x) => [x.target_user ?? x.target_name, x])).values()];
  const shown = names.slice(0, 2);
  const toggle = h("button", { type: "button", class: "small ghost", "aria-expanded": "false" }, `Show ${g.length}`);
  toggle.onclick = () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    for (const m of members) m.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "Hide" : `Show ${g.length}`;
  };
  const head = h(
    "tr",
    { class: `log-group${e.undone_at ? " undone" : ""}` },
    h("td", { class: "time", title: `${when(g[g.length - 1].created_at)} to ${when(e.created_at)}` }, ago(e.created_at)),
    h("td", { class: "nowrap" }, e.actor_id === "token" ? h("span", { class: "faint" }, "Admin token") : playerLink(e.actor_id, e.actor_name), e.source === "room" ? h("span", { class: "sub-line" }, "in a room") : null),
    h("td", { class: "nowrap" }, h("span", { class: `act-word ${k}` }, w), h("span", { class: "sub-line" }, `${g.length} times`)),
    withTarget
      ? h(
          "td",
          null,
          shown.flatMap((x, i) => [i ? ", " : "", x.target_user ? playerLink(x.target_user, x.target_name) : (x.target_name ?? "")]),
          names.length > shown.length ? h("span", { class: "faint" }, ` and ${names.length - shown.length} more`) : null,
        )
      : null,
    h("td", { class: "msg" }, new Set(g.map((x) => detailSentence(x.action, x.details, x.room_id))).size === 1 ? detailSentence(e.action, e.details, e.room_id) : ""),
    h("td", { class: "acts" }, toggle),
  );
  return [head, ...members];
}

/** One log row. */
function modLine(e: ModRow, withTarget: boolean): HTMLTableRowElement {
  const [w, k] = actionWords(e.action);
  const undo = mayUndo(e)
    ? h("button", {
        class: "small ghost",
        onclick: async (ev: Event) => {
          const row = (ev.currentTarget as HTMLElement).closest("tr") as HTMLElement;
          if (!(await ask({ title: `Undo: ${w.toLowerCase()}${e.target_name ? ` ${e.target_name}` : ""}?`, text: detailSentence(e.action, e.details, e.room_id) || undefined, confirm: "Undo" }))) return;
          if (await act("/admin/log/undo", { id: e.id }, "Undone")) {
            (ev.target as HTMLElement).closest("button")?.remove();
            void stamp(row, "Undone", "ink", false);
          }
        },
      }, glyph("undo"), "Undo")
    : null;
  return h(
    "tr",
    { class: e.undone_at ? "undone" : "" },
    timeCell(e.created_at),
    h("td", { class: "nowrap" }, e.actor_id === "token" ? h("span", { class: "faint" }, "Admin token") : playerLink(e.actor_id, e.actor_name), e.source === "room" ? h("span", { class: "sub-line" }, "in a room") : null),
    h("td", { class: "nowrap" }, h("span", { class: `act-word ${k}` }, w), e.undone_at ? h("span", { class: "sub-line", title: when(e.undone_at) }, `undone ${ago(e.undone_at)}`) : null),
    withTarget ? h("td", null, e.target_user ? playerLink(e.target_user, e.target_name) : (e.target_name ?? "")) : null,
    h("td", { class: "msg" }, detailSentence(e.action, e.details, e.room_id)),
    h("td", { class: "acts" }, undo ? h("span", { class: "hover-acts" }, undo) : null),
  );
}

const ACTIONS = ["kick", "ban", "unban", "mute", "unmute", "map", "extend", "mapvote", "rename", "ban-name", "unban-name", "block-term", "block-term-suggest", "block-term-dismiss", "unblock-term", "admin-add", "admin-remove", "mod-add", "mod-remove", "verify", "unverify", "creator-set", "creator-clear", "badge-grant", "badge-revoke", "links-clear", "avatar-block", "avatar-unblock", "shadow", "unshadow", "grant-wings", "revoke-wings", "network-ban", "network-unban", "run-reverify", "run-invalidate", "integrity-clear", "integrity-reopen", "integrity-approve", "integrity-auto-close", "feedback-status", "feedback-note", "feedback-reply", "player-message", "player-warn", "broadcast-send", "broadcast-stop", "supporter-grant", "supporter-revoke", "supporter-amount", "map-tier", "map-retire", "map-unretire", "lobby-close"];

export const logView: View = async (root, params) => {
  const rs = await rooms();
  const f = {
    action: h("select", null, h("option", { value: "" }, "Any action"), ACTIONS.map((a) => h("option", { value: a, selected: params.get("action") === a }, actionWords(a)[0]))),
    actor: h("input", { type: "search", placeholder: "staff name or id", value: params.get("actor") ?? "" }),
    target: h("input", { type: "search", placeholder: "player name or id", value: params.get("target") ?? "" }),
    room: h("select", null, h("option", { value: "" }, "Anywhere"), h("option", { value: "*", selected: params.get("room") === "*" }, "Every room (*)"), rs.map((r) => h("option", { value: r.id, selected: params.get("room") === r.id }, r.name))),
    source: h("select", null, [["", "Panel and rooms"], ["room", "Room commands"], ["api", "Panel"]].map(([v, l]) => h("option", { value: v, selected: params.get("source") === v }, l))),
  };
  const out = h("div");
  const moreBtn = h("button", { type: "button" }, "Load older");
  let next: string | null = null;
  let rows: ModRow[] = [];
  const query = (before: string | null) => {
    const q = new URLSearchParams();
    for (const k of ["action", "actor", "target", "room", "source"] as const) if (f[k].value.trim()) q.set(k, f[k].value.trim());
    if (before) q.set("before", before);
    return q;
  };
  const load = async (reset: boolean) => {
    const r = await api<{ entries: ModRow[]; next: string | null }>(`/admin/log?${query(reset ? null : next)}`);
    rows = reset ? r.entries : rows.concat(r.entries);
    next = r.next;
    moreBtn.hidden = !next;
    fill(out, modTable(rows));
  };
  moreBtn.onclick = () => void load(false);
  fill(root, 
    h(
      "form",
      {
        class: "filters",
        onsubmit: (e: Event) => {
          e.preventDefault();
          history.replaceState(null, "", `#/log?${query(null)}`);
          void load(true);
        },
      },
      h("label", null, "Action", f.action),
      h("label", null, "By", f.actor),
      h("label", null, "Player", f.target),
      h("label", null, "Room", f.room),
      h("label", null, "From", f.source),
      h("button", { type: "submit", class: "primary" }, "Filter"),
    ),
    out,
    h("div", { class: "more" }, moreBtn),
  );
  await load(true);
};

// --- The team

type StaffRow = { user_id: string; name: string | null; provider: string | null; role: StaffRole; source: "owner" | "config" | "d1"; note: string | null; created_at: number | null; actions7d: number; lastAction: number | null };

/**
 * Role buttons for a player: Make / Remove moderator (admins and the owner) and Make / Remove admin (the owner). Only
 * the ones the viewer may use, on players they outrank.
 */
export function staffButtons(_id: string, name: string, role: StaffRole | null, configAdmin: boolean, post: (body: Record<string, unknown>, done?: string) => Promise<void>): HTMLElement[] {
  if (role === "owner" || !outranks(me?.role, role)) return [];
  const grant = (action: string, title: string, text: string, confirm: string, done: string) =>
    h("button", {
      class: "small",
      onclick: async () => {
        const v = await ask({ title, text, fields: action.startsWith("make-") ? [{ name: "note", label: "Note", kind: "text" }] : [], confirm, danger: true });
        if (v) await post({ action, note: v.note || null }, done);
      },
    }, confirm);
  const out: HTMLElement[] = [];
  if (role === "admin") {
    if (may("staff.admins") && !configAdmin) out.push(grant("remove-admin", `Remove ${name} as admin?`, "They lose the panel and every room command.", "Remove admin", "Admin removed"));
    if (may("staff.admins") && !configAdmin) out.push(grant("make-mod", `Make ${name} a moderator instead?`, "They stop being an admin.", "Make moderator", "Now a moderator"));
  } else if (role === "moderator") {
    if (may("staff.moderators")) out.push(grant("remove-mod", `Remove ${name} as moderator?`, "They lose the panel and the room commands.", "Remove moderator", "Moderator removed"));
    if (may("staff.admins")) out.push(grant("make-admin", `Make ${name} an admin?`, "Admins can do everything here except manage admins.", "Make admin", "Admin added"));
  } else {
    if (may("staff.moderators")) out.push(grant("make-mod", `Make ${name} a moderator?`, `Moderators mute, kick, ban for up to ${MOD_BAN_MAX_MINUTES / 1440} days, rename players and answer feedback.`, "Make moderator", "Moderator added"));
    if (may("staff.admins")) out.push(grant("make-admin", `Make ${name} an admin?`, "Admins can do everything here except manage admins.", "Make admin", "Admin added"));
  }
  return out;
}

export const teamView: View = async (root) => {
  const r = await api<{ staff: StaffRow[]; changes: ModRow[]; recent: ModRow[] }>("/admin/staff");
  const who = h("input", { type: "text", placeholder: "Name or player id", required: true, autocomplete: "off", spellcheck: "false" });
  const role = h("select", null, h("option", { value: "moderator" }, "Moderator"), may("staff.admins") ? h("option", { value: "admin" }, "Admin") : null);
  const note = h("input", { type: "text", placeholder: "Optional" });
  const add = h("button", { type: "submit", class: "primary" }, "Add moderator");
  role.onchange = () => (add.textContent = role.value === "admin" ? "Add admin" : "Add moderator");
  const post = (id: string) => async (body: Record<string, unknown>, done?: string) => {
    if (await act(`/admin/players/${encodeURIComponent(id)}`, body, done)) reroute();
  };
  const row = (s: StaffRow) =>
    h(
      "tr",
      null,
      h("td", { class: "nowrap" }, h("span", { class: "staff-who" }, staffShield(s.role), playerLink(s.user_id, s.name))),
      h("td", null, s.source === "config" ? h("span", { class: "faint" }, "ROOM_ADMINS var") : (s.note ?? "")),
      s.created_at ? timeCell(s.created_at) : h("td", null, "—"),
      h("td", { class: "num" }, s.actions7d ? h("a", { href: `#/log?actor=${encodeURIComponent(s.user_id)}` }, String(s.actions7d)) : "0"),
      s.lastAction ? timeCell(s.lastAction) : h("td", null, "—"),
      h("td", { class: "acts" }, ...staffButtons(s.user_id, s.name ?? s.user_id, s.role, s.source === "config", post(s.user_id))),
    );
  const group = (title: string, list: StaffRow[], empty: string) =>
    h("section", { class: "card" }, h("h2", null, title, h("small", null, list.length ? String(list.length) : "")), list.length ? table(["Player", "Note", "Since", ["This week", "num"], "Last action", ""], list.map(row)) : emptyLine(empty));
  const of = (x: StaffRole) => r.staff.filter((s) => s.role === x);
  fill(root, 
    ...(!may("staff.moderators")
      ? []
      : [
          h(
            "form",
            {
              class: "filters staff-add",
              onsubmit: async (e: Event) => {
                e.preventDefault();
                const target = who.value.trim();
                const asAdmin = role.value === "admin";
                const ok = await ask({
                  title: `Make ${target} ${asAdmin ? "an admin" : "a moderator"}?`,
                  text: asAdmin ? "Admins can do everything here except manage admins." : `Moderators mute, kick, ban for up to ${MOD_BAN_MAX_MINUTES / 1440} days, rename players and answer feedback.`,
                  confirm: asAdmin ? "Make admin" : "Make moderator",
                  danger: asAdmin,
                });
                if (ok && (await act("/admin/staff", { action: "grant", role: role.value, user: target, note: note.value.trim() || null }, asAdmin ? "Admin added" : "Moderator added"))) reroute();
              },
            },
            h("label", null, "Player", who),
            h("label", null, "Role", role),
            h("label", null, "Note", note),
            add,
          ),
        ]),
    group("Owner", of("owner"), "No owner set (OWNER_ID)."),
    group("Admins", of("admin"), "No admins."),
    group("Moderators", of("moderator"), "No moderators yet."),
    ...(r.recent.length ? [h("section", { class: "card" }, h("h2", null, "Moderators lately"), modTable(r.recent))] : []),
    h("section", { class: "card" }, h("h2", null, "Role changes"), r.changes.length ? modTable(r.changes) : emptyLine("None yet.")),
  );
};
