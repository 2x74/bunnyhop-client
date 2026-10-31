import { openGiftDialog } from "./gifting";
// Server browser (home screen "Play online" and the pause menu's "Servers"): the persistent rooms from GET /servers
// with their current map + tier, players, time left and ping. Join loads the room's map with ?server=<id>
// (net/mp.ts takes over from there); "Play solo" opens the map browser as before.
// Also the pause menu's room block while connected (net/presence.ts roomActions()).

import "../net/net.css";
import { api, ApiError, type ServerListing } from "../api";
import { goToLobby, lobbyIdFromParam } from "../net/lobby";
import { roomActions, roomPresence, roomUrl } from "../net/presence";
import { openAccount } from "./account-state";
import { arrowNav, h } from "./dom";
import { tierBadge } from "./maps";
import { landRows } from "./land";
import "./servers.css";

const REFRESH_MS = 10_000;

function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function measurePing(id: string): Promise<number | null> {
  try {
    // The first request may pay for connection setup; keep the best of two.
    const a = await api.serverPing(id);
    const b = await api.serverPing(id);
    return Math.round(Math.min(a, b));
  } catch {
    return null;
  }
}

/**
 * Private lobby: create yours (not as a guest) or open a friend's invite (a link or its code). The lobby
 * starts on `map` when given (the map you're on), else a random one; the host changes it with !map. One row: the link,
 * the invite field; a line under it only when there's something to say.
 */
function lobbyBlock(map: string | null): HTMLElement {
  const msg = h("small.dim.srv-lobby-msg", { hidden: true });
  const say = (text: string) => ((msg.textContent = text), (msg.hidden = !text));
  const create = h("button.srv-lobby-create", { type: "button" }, "Create a private lobby") as HTMLButtonElement;
  create.onclick = async () => {
    create.disabled = true;
    say("Opening your lobby…");
    try {
      const l = await api.createLobby(map);
      location.href = roomUrl(l.id, l.changing ?? l.map ?? map ?? "");
    } catch (e) {
      create.disabled = false;
      if (e instanceof ApiError && e.code === "signin_required") {
        say("Save your account to create a lobby. Joining a friend's works as a guest.");
        openAccount("save");
      } else say(e instanceof ApiError ? e.message : "Couldn't reach the servers. Try again in a moment.");
    }
  };
  const code = h("input.srv-lobby-code", { type: "text", placeholder: "or paste an invite link", spellcheck: false, autocomplete: "off", "aria-label": "Invite link" }) as HTMLInputElement;
  const join = async () => {
    const raw = code.value.trim();
    let v: string | null = raw;
    try {
      v = new URL(raw).searchParams.get("lobby");
    } catch {
      /* not a link: a bare code */
    }
    const id = lobbyIdFromParam(v);
    if (!id) return void say("That doesn't look like a lobby invite.");
    say("Joining…");
    try {
      await goToLobby(id);
    } catch (e) {
      say(e instanceof ApiError && e.status === 404 ? "That lobby has closed. Ask for a new invite." : "Couldn't reach the lobby. Try again in a moment.");
    }
  };
  code.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") void join();
  };
  const joinBtn = h("button.btn.btn-ghost.srv-lobby-join", { type: "button", hidden: true, onclick: () => void join() }, "Join");
  code.oninput = () => (joinBtn.hidden = !code.value.trim());
  return h("div.srv-lobby", null, h("div.srv-lobby-row", null, create, code, joinBtn), msg);
}

export interface ServerBrowserOpts {
  onSolo: () => void;
  /** The map you're on (pause menu): a new private lobby starts there. */
  map?: string | null;
}

export function serverBrowser(o: ServerBrowserOpts): HTMLElement {
  const here = roomPresence()?.id ?? null;
  const tbody = h("tbody");
  const status = h("p.dim.small.srv-status", { hidden: true });
  const skeleton = () =>
    [0, 1].map(() => h("tr.srv-row.skeleton", { "aria-hidden": "true" }, h("td.srv-name", null, h("b", null, "\u00a0"), h("small", null, "\u00a0")), h("td"), h("td"), h("td"), h("td"), h("td")));
  tbody.append(...skeleton());
  const table = h(
    "table.srv-table",
    null,
    h("thead", null, h("tr", null, h("th", null, "Server"), h("th", null, "Map"), h("th", null, "Players"), h("th", null, "Time left"), h("th", null, "Ping"), h("th"))),
    tbody,
  );
  const root = h(
    "div.servers",
    null,
    table,
    status,
    api.available() ? lobbyBlock(o.map ?? null) : null,
    h("div.srv-foot", null, h("button.btn.btn-ghost.srv-solo", { type: "button", onclick: () => o.onSolo() }, "Play solo ›")),
  );
  if (!api.available()) {
    table.hidden = true;
    status.hidden = false;
    status.textContent = "Multiplayer is offline right now. Solo play still works.";
    return root;
  }
  const pings = new Map<string, number | null>();
  const deadlines = new Map<string, number>();
  let rows: ServerListing[] = [];
  // Supporters may take one slot over a full room (apps/api src/rooms/room.ts): the room decides, this only offers it.
  let supporter = false;
  void api.me().then((u) => {
    supporter = !!u?.supporter;
    if (supporter && rows.length) render();
  });

  const join = (s: ServerListing) => {
    if (!s.map || !s.online) return;
    location.href = roomUrl(s.id, s.changing ?? s.map);
  };

  let painted = false;
  const render = () => {
    // The first real paint lands row by row and fills the player bars; the 10 s refreshes just update.
    tbody.classList.toggle("fresh", !painted);
    painted = true;
    tbody.replaceChildren(
      ...rows.map((s) => {
        const full = s.players >= s.maxPlayers;
        const ping = pings.get(s.id);
        const left = deadlines.get(s.id);
        const reserved = full && supporter && s.players < s.maxPlayers + 1;
        const canJoin = s.online && !!s.map && (!full || reserved || here === s.id);
        // The row is the button; its label stays quiet until the row is hovered or focused.
        const btn = h("button.srv-join", { type: "button", disabled: !canJoin, onclick: (e: Event) => (e.stopPropagation(), join(s)) }, here === s.id ? "Rejoin" : full && !reserved ? "Full" : "Join");
        return h(
          `tr.srv-row${s.online ? "" : ".offline"}`,
          { onclick: () => canJoin && join(s) },
          h("td.srv-name", null, h("b", null, s.name, here === s.id ? h("span.badge.current.srv-here", null, "You") : null), h("small", null, `${s.region}, tiers ${s.tiers[0]}–${s.tiers[1]}, ${s.timeLimitMinutes}-minute maps`)),
          h("td", null, s.map ? h("div.srv-map", null, h("span.srv-mapname", null, s.changing ? `→ ${s.changing}` : s.map), tierBadge(s.tier)) : h("span.dim", null, s.online ? "no maps" : "offline")),
          h(
            "td.srv-players",
            null,
            h("span", null, h("b", null, String(s.players)), h("span.dim", null, ` / ${s.maxPlayers}`)),
            h(`span.srv-bar${full ? ".full" : ""}`, null, h("i", { style: `transform:scaleX(${Math.min(1, s.players / Math.max(1, s.maxPlayers)).toFixed(3)})` })),
          ),
          h("td.srv-left", { "data-id": s.id }, s.changing ? "changing" : left !== undefined ? clock(left - performance.now()) : "—"),
          h(`td.srv-ping${ping === undefined || ping === null ? "" : ping < 80 ? ".good" : ping < 150 ? ".ok" : ".bad"}`, null, ping === undefined ? "…" : ping === null ? "—" : `${ping} ms`),
          h("td.srv-actions", null, btn),
        );
      }),
    );
    arrowNav(tbody, "button:not([disabled])");
    if (tbody.classList.contains("fresh")) landRows(tbody.children);
  };

  const load = async () => {
    try {
      rows = await api.servers();
      status.textContent = rows.length ? "" : "No servers right now.";
      status.hidden = !!rows.length;
      const now = performance.now();
      for (const s of rows) if (s.timeLeftMs !== null) deadlines.set(s.id, now + s.timeLeftMs);
      render();
      for (const s of rows) if (!pings.has(s.id) && s.online) void measurePing(s.id).then((p) => (pings.set(s.id, p), root.isConnected && render()));
    } catch {
      status.textContent = "Couldn't reach the servers. Retrying…";
      status.hidden = false;
      if (!rows.length) tbody.replaceChildren();
    }
  };
  void load();
  const poll = window.setInterval(() => (root.isConnected ? void load() : clearInterval(poll)), REFRESH_MS);
  const tick = window.setInterval(() => {
    if (!root.isConnected) return clearInterval(tick);
    for (const td of tbody.querySelectorAll<HTMLElement>("td.srv-left[data-id]")) {
      const d = deadlines.get(td.dataset.id!);
      if (d !== undefined && td.textContent !== "changing") td.textContent = clock(d - performance.now());
    }
  }, 1000);
  return root;
}

/** "13 playing" (home screen "Play online"); refreshes every 20 s while on screen. */
export function onlineSummary(): HTMLElement {
  const el = h("small.online-sum", null, "");
  if (!api.available()) return el;
  const load = () =>
    void api
      .servers()
      .then((list) => {
        const n = list.reduce((a, s) => a + s.players, 0);
        el.textContent = n ? `${n} playing` : "";
      })
      .catch(() => {});
  load();
  const t = window.setInterval(() => (el.isConnected ? load() : clearInterval(t)), 20_000);
  return el;
}

/** Pause menu "Server" tab while in a room: room status + Scoreboard / Spectate / Nominate / RTV / Leave. */
export function roomPanel(resume: () => void): HTMLElement | null {
  const a = roomActions();
  if (!a) return null;
  const s = a.summary();
  const then = (fn: () => void) => () => {
    resume();
    // After the pointer is locked again, so the numbered menu takes the digit keys.
    setTimeout(fn, 120);
  };
  const card = (label: string, fn: () => void, o: { sub?: string; hint?: string; icon?: string; danger?: boolean } = {}) =>
    h(
      `button.action-card${o.danger ? ".danger" : ""}`,
      { type: "button", onclick: fn },
      o.icon ? h("span.ac-icon", { "aria-hidden": "true" }, o.icon) : null,
      h("span.ac-text", null, h("b", null, label), o.sub ? h("small", null, o.sub) : null),
      o.hint ? h("kbd", null, o.hint) : null,
    );
  const fill = Math.round((100 * s.players) / Math.max(1, s.max));
  return h(
    "div.pp-room",
    null,
    h(
      "div.room-card",
      null,
      // Only news: an open room is the normal case (you're in it), so it says nothing; a vote or a map change does.
      s.status !== "open" ? h("div.room-live", null, s.status) : null,
      h("b.room-name", null, s.name),
      h("div.room-map", null, h("span", null, s.map), s.tier ? tierBadge(s.tier) : null),
      h(
        "div.room-stats",
        null,
        h("div", null, h("small", null, "Players"), h("b", null, `${s.players}`, h("span.dim", null, ` / ${s.max}`)), h("span.srv-bar", null, h("i", { style: `width:${fill}%` }))),
        h("div", null, h("small", null, "Time left"), h("b", null, s.timeLeft)),
        h("div", null, h("small", null, "Rock the vote"), h("b", null, `${s.rtv.count}`, h("span.dim", null, ` / ${s.rtv.needed}`))),
      ),
    ),
    h(
      "div.card-grid.pp-room-actions",
      null,
      s.lobby ? card("Copy invite link", () => a.invite(), { icon: "⧉", sub: "Send it to friends · !invite" }) : null,
      s.host ? card("Change lobby map", then(() => a.changeMap()), { icon: "⇢", sub: "Host · !map" }) : null,
      card("Gift Supporter", () => openGiftDialog({ roomId: s.id }), { icon: "✦", sub: "Give Supporter to players in this room" }),
      card("Scoreboard", then(() => a.scoreboard()), { hint: "Tab", icon: "≡" }),
      card(s.spectating ? "Spectate / respawn" : "Spectate", then(() => a.spectate()), { hint: "N", icon: "◉" }),
      card("Race a player", then(() => a.race()), { icon: "⚑", sub: "!race" }),
      card("Nominate a map", then(() => a.nominate()), { icon: "✚", sub: "!nominate" }),
      card("Rock the vote", () => (a.rtv(), resume()), { icon: "↻", sub: `${s.rtv.count}/${s.rtv.needed} · !rtv` }),
      card("Leave server", () => a.leave(), { icon: "⏏", sub: "Keep playing this map solo", danger: true }),
    ),
  );
}
