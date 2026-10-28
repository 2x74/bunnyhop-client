// Live: the rooms with their chat beside the roster, private lobbies, and the chat log. Moderation happens where the
// chat is: each roster row has its actions on hover or focus (m mute 30 min, k kick, b ban on the focused row), each chat
// line too, and a line's Context shows the ten lines around it in that room. Rooms refresh every 5 s by patching values
// in place, so a picked map, a typed number and the focus survive the refresh.

import { act, ago, api, ask, badge, dur, emptyLine, glyph, h, may, me, n, playerLink, plural, poll, reroute, rooms, setKeys, short, toast, when, type ChatRow, type ServerRow, type View, fill } from "./core";
import { setOdometer, odometer } from "./ui";
import { progress, slots } from "./charts";
import { mapArt, tierTag } from "./art";
import { banDialog, kickDialog, quickMute } from "./dialogs";
import { figEl } from "./pulse";
import { outranks } from "../moderation/staff";
import type { StaffRole } from "../progression";

interface RoomPlayer {
  slot: number;
  id: string;
  name: string;
  provider: string;
  admin: boolean;
  role?: StaffRole | null;
  style: string;
  spec: number | null;
  joinedAt: number;
  lastActive: number;
  muted: number | null;
  shadow?: boolean;
}

interface RoomView {
  id: string;
  map: string | null;
  tier: number | null;
  endsAt: number;
  extends: number;
  now: number;
  changing: { map: string; at: number } | null;
  nextMap: string | null;
  vote: { kind: string; endsAt: number; options: string[]; votes: number } | null;
  rtv: number;
  players: RoomPlayer[];
  mutes: { user: string; until: number }[];
  pool: string[];
  races?: { id: string; state: string; a: string; b: string; map: string; style: string; track: number; goAt: number | null }[];
}

type RoomRow = ServerRow & { view: RoomView | null; chat?: ChatRow[] };

const STYLE_WORD: Record<string, string> = { autohop: "Normal", legit: "EZ Scroll", scroll: "Legit Scroll", wonly: "W-Only", sideways: "Sideways", hsw: "Half-Sideways", autostrafe: "Auto-strafe" };

/** A chat line's flags as words. */
export function chatFlags(m: ChatRow): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (m.filtered) out.push(badge("filtered", "warn"));
  if (m.blocked) out.push(badge("blocked", "bad"));
  if (m.muted) out.push(badge("muted", "bad"));
  if (m.command) out.push(badge("command", "info"));
  if (m.dropped && !m.muted && !m.blocked) out.push(badge(m.dropped === "silent" ? "silent" : m.dropped === "shadow" ? "shadowed" : `not shown (${m.dropped})`));
  return out;
}

/** Actions on a chat line's author: Mute 30m (in that room), Kick, Ban. */
function lineActions(m: ChatRow, room: string | null): HTMLElement {
  const t = { id: m.user_id, name: m.name };
  return h(
    "span",
    { class: "hover-acts" },
    may("player.mute") ? h("button", { type: "button", class: "small ghost", onclick: () => void quickMute(t, 30, room) }, "Mute 30m") : null,
    may("player.kick") ? h("button", { type: "button", class: "small ghost", onclick: () => void kickDialog(t) }, "Kick") : null,
    may("player.ban.temp") ? h("button", { type: "button", class: "small ghost danger-text", onclick: () => void banDialog(t) }, "Ban…") : null,
  );
}

// ---------------------------------------------------------------------------------------------
// Rooms

interface Card {
  el: HTMLElement;
  set: (r: RoomRow) => void;
}

function roomCard(r0: RoomRow): Card {
  const el = h("section", { class: "room", "data-room": r0.id });
  const hero = h("div", { class: "room-hero" });
  const nameEl = h("h2", { class: "name" }, r0.name, h("small", { class: "mono" }, r0.id));
  const countV = odometer(0);
  const slotsHost = h("span");
  const maxEl = h("span", { class: "faint" });
  const mapHost = h("span", { class: "rh-map" });
  const timeHost = h("span", { class: "rh-time" });
  const extraHost = h("span", { class: "rh-extra" });
  const head = h("div", { class: "room-head" }, nameEl, h("span", { class: "rh-players" }, slotsHost, h("b", null, countV), maxEl), mapHost, timeHost, extraHost);
  // Map, extend and vote (rooms.map): built once; the refresh only adds new pool maps, never resets the pick.
  const mapSel = h("select", { "aria-label": "Map" });
  const extMin = h("input", { type: "number", value: "15", min: "1", max: "240", "aria-label": "Minutes" });
  let cur = r0;
  const op = async (body: Record<string, unknown>, done?: string) => {
    if (await act(`/admin/rooms/${cur.id}`, body, done)) reroute();
  };
  const ctl = may("rooms.map")
    ? h(
        "div",
        { class: "room-ctl" },
        mapSel,
        h("button", { class: "danger", onclick: async () => (await ask({ title: `Change ${cur.name} to ${mapSel.value}?`, text: "Everyone reloads after a short notice.", confirm: "Change map", danger: true })) && (await op({ op: "map", map: mapSel.value })) }, "Change map"),
        h("span", { class: "gap" }),
        extMin,
        h("button", { onclick: async () => (await ask({ title: `Extend ${cur.name} by ${extMin.value} min?`, confirm: "Extend" })) && (await op({ op: "extend", minutes: Number(extMin.value) })) }, "Extend"),
        h("button", { onclick: async () => (await ask({ title: `Start the map vote in ${cur.name} now?`, confirm: "Start vote" })) && (await op({ op: "mapvote" })) }, "Start map vote"),
      )
    : null;
  const rosterBody = h("tbody");
  const rosterEmpty = h("tr", { class: "empty-row" }, h("td", { colspan: "5", class: "empty" }, "Nobody here."));
  const roster = h("div", { class: "tablewrap" }, h("table", { class: "roster" }, h("thead", null, h("tr", null, h("th", { class: "num" }, "#"), h("th", null, "Player"), h("th", null, "Style"), h("th", null, "Idle"), h("th", null, ""))), rosterBody));
  const rows = new Map<string, { tr: HTMLTableRowElement; set: (p: RoomPlayer, v: RoomView) => void }>();
  const chatList = h("div", { class: "chat-tail", role: "log", "aria-label": `${r0.name} chat` });
  const chatIds = new Set<number>();
  const offline = h("p", { class: "faint" });
  el.append(hero, head, ctl ?? h("span"), h("div", { class: "room-body" }, h("div", { class: "room-roster" }, roster, offline), h("div", { class: "room-chat" }, h("h3", null, "Chat", may("chat.read") ? h("a", { class: "go-link", href: `#/chat?room=${encodeURIComponent(r0.id)}` }, "Log", glyph("arrow")) : null), chatList)));

  const playerRow = (p0: RoomPlayer) => {
    const nameCell = h("td");
    const styleCell = h("td");
    const idleCell = h("td", { class: "time" });
    const actCell = h("td", { class: "acts" });
    const tr = h("tr", { tabindex: "0", "data-user": p0.id }, h("td", { class: "num faint" }, String(p0.slot)), nameCell, styleCell, idleCell, actCell);
    let muted: number | null | undefined;
    let role: StaffRole | null | undefined;
    const set = (p: RoomPlayer, v: RoomView) => {
      fill(nameCell, playerLink(p.id, p.name), p.role ? badge(p.role, "acc") : p.admin ? badge("admin", "acc") : null, p.shadow ? badge("shadowed", "warn") : null, p.muted !== null ? badge(p.muted ? `muted ${dur(p.muted - v.now)}` : "muted", "bad") : null);
      fill(styleCell, STYLE_WORD[p.style] ?? p.style, p.spec !== null ? h("span", { class: "faint" }, ` watching #${p.spec}`) : "");
      idleCell.textContent = dur(v.now - p.lastActive);
      const r = p.role ?? (p.admin ? "admin" : null);
      if (p.muted === muted && r === role) return;
      muted = p.muted;
      role = r;
      // Only on players the viewer outranks (the API refuses the rest).
      if (!outranks(me?.role, r)) return void actCell.replaceChildren();
      const t = { id: p.id, name: p.name };
      fill(actCell, 
        h(
          "span",
          { class: "hover-acts" },
          p.muted !== null
            ? h("button", { class: "small ghost", "data-k": "m", title: "m", onclick: async () => (await act(`/admin/rooms/${cur.id}`, { op: "unmute", user: p.id }, `Unmuted ${p.name}`)) && reroute() }, "Unmute")
            : h("button", { class: "small ghost", "data-k": "m", title: "m", onclick: async () => (await quickMute(t, 30, cur.id)) && reroute() }, glyph("mute"), "Mute 30m"),
          h("button", { class: "small ghost", "data-k": "k", title: "k", onclick: async () => (await kickDialog(t, cur.id)) && reroute() }, glyph("kick"), "Kick"),
          h("button", { class: "small ghost danger-text", "data-k": "b", title: "b", onclick: async () => (await banDialog(t, { roomId: cur.id })) && reroute() }, glyph("ban"), "Ban…"),
        ),
      );
    };
    set(p0, cur.view!);
    return { tr, set };
  };

  const set = (r: RoomRow) => {
    cur = r;
    const v = r.view;
    el.classList.toggle("down", !v);
    if (!v) {
      fill(head, nameEl, badge("unreachable", "bad"));
      return;
    }
    if (v.map) {
      const prev = hero.dataset.map;
      if (prev !== v.map) {
        fill(hero, mapArt(v.map, "hero"));
        hero.dataset.map = v.map;
      }
    }
    setOdometer(countV, v.players.length);
    fill(slotsHost, slots(v.players.length, r.maxPlayers));
    maxEl.textContent = ` / ${r.maxPlayers}`;
    fill(mapHost, ...(v.map ? [h("b", null, v.map), tierTag(v.tier)] : [h("span", { class: "faint" }, "no map")]));
    const left = v.endsAt - v.now;
    const limit = (r.timeLimitMinutes ?? 0) * 60_000;
    fill(timeHost, v.changing ? `changing to ${v.changing.map}` : `${dur(left)} left`, v.extends ? h("span", { class: "faint" }, `, extended ${v.extends}×`) : "", !v.changing && limit ? progress(1 - left / limit) : "");
    fill(extraHost, 
      v.nextMap ? h("span", { class: "faint" }, `next ${v.nextMap}`) : "",
      v.vote ? badge(`${v.vote.kind === "rtv" ? "Rock the vote" : "Map vote"}: ${plural(v.vote.votes, "vote")}`, "info") : "",
      v.rtv && !v.vote ? badge(`${v.rtv} want a new map`, "info") : "",
      ...(v.races ?? []).map((x) => badge(`race ${x.a} vs ${x.b}`, "info")),
    );
    // The map list: built once and extended, so a pick survives the refresh.
    const have = new Set([...mapSel.options].map((o) => o.value));
    for (const m of v.pool) if (!have.has(m)) mapSel.append(h("option", { value: m, selected: !mapSel.options.length && m === v.map }, m));
    if (!have.size && v.map) mapSel.value = v.map;
    // The roster, by player.
    const seen = new Set<string>();
    v.players.forEach((p, i) => {
      seen.add(p.id);
      let row = rows.get(p.id);
      if (!row) {
        row = playerRow(p);
        rows.set(p.id, row);
      } else row.set(p, v);
      if (rosterBody.children[i] !== row.tr) rosterBody.insertBefore(row.tr, rosterBody.children[i] ?? null);
    });
    for (const [id, row] of rows) if (!seen.has(id)) (row.tr.remove(), rows.delete(id));
    if (!v.players.length) fill(rosterBody, rosterEmpty);
    else rosterEmpty.remove();
    const away = v.mutes.filter((m) => !v.players.some((p) => p.id === m.user));
    offline.hidden = !away.length;
    fill(offline, "Also muted here, offline: ", ...away.map((m, i) => [i ? ", " : "", playerLink(m.user, short(m.user))]).flat());
    // Chat: new lines slide in at the bottom; the oldest go.
    if (r.chat) {
      const fresh = r.chat.filter((m) => !chatIds.has(m.id));
      const first = !chatIds.size;
      for (const m of fresh) {
        chatIds.add(m.id);
        chatList.append(
          h(
            "div",
            { class: `tail-line${first ? "" : " new"}${m.blocked || m.muted || m.shown === null ? " dropped" : ""}`, title: when(m.created_at) },
            h("span", { class: "tail-when faint" }, ago(m.created_at).replace(" ago", "")),
            playerLink(m.user_id, m.name),
            h("span", { class: "tail-msg" }, m.shown ?? m.raw),
            chatFlags(m),
            lineActions(m, r.id),
          ),
        );
      }
      while (chatList.children.length > 15) chatList.firstElementChild!.remove();
      if (!chatList.children.length) fill(chatList, emptyLine("Quiet."));
      else chatList.querySelector(".empty-line")?.remove();
      if (fresh.length) chatList.scrollTop = chatList.scrollHeight;
    }
  };
  set(r0);
  return { el, set };
}

export const roomsView: View = async (root) => {
  const sub = h("span", { class: "sub" });
  const list = h("div", { class: "rooms" });
  const cards = new Map<string, Card>();
  const draw = async () => {
    if (document.querySelector("dialog[open]")) return;
    const r = await api<{ rooms: RoomRow[] }>(`/admin/rooms${may("chat.read") ? "?chat=15" : ""}`);
    for (const row of r.rooms) {
      const c = cards.get(row.id);
      if (c) c.set(row);
      else {
        const made = roomCard(row);
        cards.set(row.id, made);
        list.append(made.el);
      }
    }
    sub.textContent = `${plural(r.rooms.reduce((a, x) => a + (x.view?.players.length ?? 0), 0), "player")} in ${plural(r.rooms.filter((x) => x.online).length, "room")}. Updated ${when(Date.now()).slice(11, 19)}.`;
  };
  fill(root, h("div", { class: "view-bar" }, sub), list);
  await draw();
  // m / k / b on the focused roster row.
  const onRow = (k: string) => () => {
    const tr = document.activeElement?.closest?.("tr[data-user]");
    (tr?.querySelector(`button[data-k="${k}"]`) as HTMLButtonElement | null)?.click();
  };
  setKeys({ m: onRow("m"), k: onRow("k"), b: onRow("b") });
  list.addEventListener("keydown", (e) => {
    const tr = (e.target as HTMLElement).closest?.("tr[data-user]") as HTMLElement | null;
    if (!tr || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    ((e.key === "ArrowDown" ? tr.nextElementSibling : tr.previousElementSibling) as HTMLElement | null)?.focus();
  });
  return poll(draw, 5000);
};

// ---------------------------------------------------------------------------------------------
// Private lobbies: who hosts, where, which map, who is in. Admins kick from a lobby (it sticks while the lobby lasts) or
// close it. Never their chat: lobby chat is private and never logged.

interface AdminLobbyRow {
  id: string;
  name: string;
  region: string;
  hostId: string;
  hostName: string;
  map: string | null;
  tier: number | null;
  changing: string | null;
  players: number;
  maxPlayers: number;
  createdAt: number;
  roster: { id: string; name: string; provider: string; style: string; joinedAt: number; lastActive: number; role: string | null }[];
}

interface LobbyStats {
  open: number;
  active: number;
  players: number;
  created24h: number;
  created7d: number;
  hosts7d: number;
  closed24h: number;
  avgLifeMs: number | null;
  runs24h: number;
  runs7d: number;
  runners7d: number;
}

export const lobbiesView: View = async (root) => {
  const figs = h("div", { class: "figs figs-small" });
  const list = h("div", { class: "rooms" });
  const sub = h("span", { class: "sub" });
  const made = new Map<string, ReturnType<typeof figEl>>();
  const manage = may("lobbies.manage");
  const draw = async () => {
    if (document.querySelector("dialog[open]")) return;
    const r = await api<{ now: number; stats: LobbyStats; lobbies: AdminLobbyRow[] }>("/admin/lobbies");
    const s = r.stats;
    const stats: [string, string, number, string][] = [
      ["open", "open", s.open, `${n(s.active)} with players`],
      ["players", "players in them", s.players, "right now"],
      ["created", "opened today", s.created24h, `${n(s.created7d)} this week by ${plural(s.hosts7d, "host")}`],
      ["closed", "closed today", s.closed24h, s.avgLifeMs === null ? "" : `they last ${dur(s.avgLifeMs)} on average`],
      ["runs", "runs today", s.runs24h, `${n(s.runs7d)} this week`],
    ];
    for (const [key, label, value, foot] of stats) {
      const f = made.get(key);
      if (f) f.set({ key, label, value, foot });
      else {
        const x = figEl({ key, label, value, foot }, "small");
        made.set(key, x);
        figs.append(x.el);
      }
    }
    sub.textContent = `Lobby chat is private and never logged. Updated ${when(Date.now()).slice(11, 19)}.`;
    fill(list, 
      ...r.lobbies.map((l) =>
        h(
          "section",
          { class: "room lobby" },
          h("div", { class: "room-hero" }, l.map ? mapArt(l.map, "hero") : null),
          h(
            "div",
            { class: "room-head" },
            h("h2", { class: "name" }, l.name, h("small", { class: "mono" }, l.id)),
            h("span", { class: "rh-players" }, slots(l.players, l.maxPlayers), h("b", null, l.players), h("span", { class: "faint" }, ` / ${l.maxPlayers}`)),
            h("span", { class: "rh-map" }, l.changing ? `changing to ${l.changing}` : l.map ? [h("b", null, l.map), tierTag(l.tier)] : "—"),
            h("span", { class: "faint" }, "host ", playerLink(l.hostId, l.hostName)),
            h("span", { class: "faint" }, l.region),
            h("span", { class: "faint", title: when(l.createdAt) }, `open ${dur(r.now - l.createdAt)}`),
            manage
              ? h(
                  "button",
                  {
                    class: "small danger rh-close",
                    onclick: async () => {
                      const v = await ask({ title: `Close ${l.name}?`, text: `${l.players ? `${plural(l.players, "player")} will be sent out. ` : ""}The invite stops working.`, fields: [{ name: "reason", label: "Reason (they see it)", kind: "text" }], confirm: "Close lobby", danger: true });
                      if (v && (await act(`/admin/rooms/${encodeURIComponent(l.id)}`, { op: "close", reason: v.reason || null }, "Lobby closed"))) void draw();
                    },
                  },
                  "Close lobby…",
                )
              : null,
          ),
          l.roster.length
            ? h(
                "div",
                { class: "tablewrap" },
                h(
                  "table",
                  { class: "roster" },
                  h("tbody", null, ...l.roster.map((p) =>
                    h(
                      "tr",
                      { tabindex: "0" },
                      h("td", null, playerLink(p.id, p.name), p.id === l.hostId ? badge("host", "acc") : null, p.role ? badge(p.role, "acc") : null),
                      h("td", null, STYLE_WORD[p.style] ?? p.style),
                      h("td", { class: "time" }, `idle ${dur(r.now - p.lastActive)}`),
                      h("td", { class: "acts" }, manage && !p.role ? h("span", { class: "hover-acts" }, h("button", { class: "small ghost", onclick: async () => (await kickDialog({ id: p.id, name: p.name }, l.id, true)) && void draw() }, glyph("kick"), "Kick")) : null),
                    ),
                  )),
                ),
              )
            : emptyLine("Empty. It closes 15 minutes after the last player left."),
        ),
      ),
      ...(r.lobbies.length ? [] : [emptyLine("No lobbies are open.")]),
    );
  };
  fill(root, h("div", { class: "view-bar" }, sub), figs, list);
  await draw();
  return poll(draw, 15_000);
};

// ---------------------------------------------------------------------------------------------
// Chat log

export function chatRow(m: ChatRow, withPlayer = true, withActions = true): HTMLTableRowElement {
  const differs = m.shown !== null && m.shown !== m.raw.replace(/\s+/g, " ").trim();
  const ctxBtn = h("button", { type: "button", class: "small ghost", onclick: (e: Event) => void context(e.currentTarget as HTMLElement, m) }, "Context");
  return h(
    "tr",
    { class: "chat-row" },
    h("td", { class: "time", title: when(m.created_at) }, ago(m.created_at)),
    h("td", { class: "nowrap" }, m.room_id, m.map ? h("div", { class: "faint" }, m.map) : null),
    withPlayer ? h("td", { class: "nowrap" }, playerLink(m.user_id, m.name)) : null,
    h("td", { class: "msg" }, h("div", null, m.shown ?? m.raw), m.shown === null || differs || m.filtered ? h("div", { class: "raw" }, m.shown === null ? "Not shown to the room." : `Typed: ${m.raw}`) : null),
    h("td", null, chatFlags(m)),
    withActions ? h("td", { class: "acts" }, h("span", { class: "hover-acts" }, ctxBtn, ...lineActions(m, null).childNodes)) : null,
  );
}

/** Context: the ten lines before and after this one in its room, under the row (again: closes it). */
async function context(btn: HTMLElement, m: ChatRow): Promise<void> {
  const tr = btn.closest("tr")!;
  const open = tr.nextElementSibling?.classList.contains("ctx-detail") ? tr.nextElementSibling : null;
  if (open) return void open.remove();
  const cols = tr.children.length;
  const cell = h("td", { colspan: String(cols) }, h("span", { class: "faint" }, "Loading…"));
  const detail = h("tr", { class: "ctx-detail" }, cell);
  tr.after(detail);
  try {
    const before = await api<{ messages: ChatRow[] }>(`/admin/chat?room=${encodeURIComponent(m.room_id)}&before=${m.created_at}:${m.id}&limit=10`);
    const after = await api<{ messages: ChatRow[] }>(`/admin/chat?room=${encodeURIComponent(m.room_id)}&from=${m.created_at}&to=${m.created_at + 30 * 60_000}&limit=200`);
    const later = after.messages.filter((x) => x.id !== m.id && (x.created_at > m.created_at || x.id > m.id)).slice(-10);
    const lines = [...before.messages.slice().reverse(), m, ...later.reverse()];
    fill(cell, 
      h(
        "div",
        { class: "ctx-lines" },
        lines.map((x) => h("div", { class: `ctx-line${x.id === m.id ? " this" : ""}` }, h("span", { class: "faint" }, when(x.created_at).slice(11)), playerLink(x.user_id, x.name), h("span", null, x.shown ?? x.raw), chatFlags(x))),
      ),
    );
  } catch (e) {
    fill(cell, h("span", { class: "err" }, `Couldn't load: ${(e as Error).message}`));
  }
}

export const chatView: View = async (root, params) => {
  const rs = await rooms();
  const f = {
    room: h("select", { name: "room" }, h("option", { value: "" }, "Every room"), rs.map((r) => h("option", { value: r.id, selected: params.get("room") === r.id }, r.name))),
    player: h("input", { type: "search", placeholder: "name or id", value: params.get("player") ?? "" }),
    user: params.get("user") ?? "",
    q: h("input", { type: "search", placeholder: "words", value: params.get("q") ?? "" }),
    flag: h("select", null, [["", "Every line"], ["flagged", "Filtered, blocked or muted"], ["filtered", "Filtered"], ["blocked", "Blocked"], ["muted", "Muted"], ["command", "Commands"], ["dropped", "Not shown"]].map(([v, l]) => h("option", { value: v, selected: params.get("flag") === v }, l))),
    from: h("input", { type: "datetime-local", value: params.get("from") ?? "" }),
    to: h("input", { type: "datetime-local", value: params.get("to") ?? "" }),
  };
  const rowsBody = h("tbody");
  const moreBtn = h("button", { type: "button" }, "Load older");
  const status = h("span", { class: "sub" });
  let next: string | null = null;
  const query = (before: string | null) => {
    const q = new URLSearchParams();
    if (f.room.value) q.set("room", f.room.value);
    if (f.user) q.set("user", f.user);
    if (f.player.value.trim()) q.set("player", f.player.value.trim());
    if (f.q.value.trim()) q.set("q", f.q.value.trim());
    if (f.flag.value) q.set("flag", f.flag.value);
    if (f.from.value) q.set("from", String(new Date(f.from.value).getTime()));
    if (f.to.value) q.set("to", String(new Date(f.to.value).getTime()));
    if (before) q.set("before", before);
    q.set("limit", "100");
    return q;
  };
  const load = async (reset: boolean) => {
    const r = await api<{ messages: ChatRow[]; next: string | null }>(`/admin/chat?${query(reset ? null : next)}`);
    if (reset) rowsBody.replaceChildren();
    for (const m of r.messages) rowsBody.appendChild(chatRow(m));
    if (reset && !r.messages.length) rowsBody.appendChild(h("tr", null, h("td", { colspan: "6", class: "empty" }, "No chat matches.")));
    next = r.next;
    moreBtn.hidden = !next;
    status.textContent = `${rowsBody.querySelectorAll("tr.chat-row").length} lines`;
  };
  const search = (e?: Event) => {
    e?.preventDefault();
    void load(true).catch((err) => toast(String(err.message), true));
  };
  moreBtn.onclick = () => void load(false);
  const clearUser = f.user ? h("button", { type: "button", class: "small", onclick: () => (location.hash = "#/chat") }, `player ${short(f.user)}`, glyph("close")) : null;
  fill(root, 
    h("div", { class: "view-bar" }, status),
    h(
      "form",
      { class: "filters", onsubmit: search },
      h("label", null, "Room", f.room),
      h("label", null, "Player", f.player),
      h("label", null, "Says", f.q),
      h("label", null, "Show", f.flag),
      h("label", null, "From", f.from),
      h("label", null, "To", f.to),
      h("button", { type: "submit", class: "primary" }, "Search"),
      clearUser,
    ),
    h("div", { class: "tablewrap" }, h("table", { class: "chat-table" }, h("thead", null, h("tr", null, h("th", null, "When"), h("th", null, "Room"), h("th", null, "Player"), h("th", null, "Message"), h("th", null, ""), h("th", null, ""))), rowsBody)),
    h("div", { class: "more" }, moreBtn),
  );
  await load(true);
};

