// Server browser (home screen "Play online" and the pause menu's "Servers"): the persistent rooms from GET /servers
// with their current map + tier, players, time left and ping. Join loads the room's map with ?server=<id>
// (net/mp.ts takes over from there); "Play solo" opens the map browser as before.
// Also the room's own line at the top of the pause menu's Server tab (roomHeader).

import "../net/net.css";
import { api, ApiError, type ServerListing } from "../api";
import { goToLobby, lobbyIdFromParam } from "../net/lobby";
import { roomPresence, roomUrl, type RoomActions } from "../net/presence";
import { openAccount } from "./account-state";
import { arrowNav, h } from "./dom";
import { tierBadge } from "./maps";
import { landRows } from "./land";
import { loadFailed } from "./load-failed";
import "./servers.css";

const REFRESH_MS = 10_000;

/**
 * Why a far-away server is fine, under Home's Play online button and under the server list (whose Ping column would
 * otherwise read as a reason not to join): your movement is simulated on your machine exactly as in solo play, the
 * room only relays it to the others, and the run is verified from its replay (net/mp.ts). Ping changes how the other
 * players look to you, nothing about your run.
 */
export const PING_NOTE = "Your run is timed on your machine, so ping doesn't matter.";

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
    api.available() ? h("p.srv-ping-note", null, PING_NOTE) : null,
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
  /** The couldn't-load state, while the list has never arrived. */
  let failed: HTMLElement | null = null;
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
      failed?.remove();
      failed = null;
      table.hidden = false;
    } catch (e) {
      // A list already on screen stays, with a line saying it's stale. Without one: the shared couldn't-load state
      // (it keeps retrying on its own too).
      status.textContent = rows.length ? "Couldn't reach the servers. Retrying…" : "";
      status.hidden = !rows.length;
      if (!rows.length && !failed) {
        table.hidden = true;
        failed = loadFailed("the servers", () => void load(), e);
        table.after(failed);
      }
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

/**
 * The room you're in, as its line of the Play online table: map, players, time left (pause menu Server tab; menu.ts
 * lists what you can do there under it).
 */
export function roomHeader(s: ReturnType<RoomActions["summary"]>): HTMLElement {
  // Only news: an open room is the normal case (you're in it), so it says nothing; a lost connection does.
  const news = s.status === "open" ? null : s.status === "closed" ? "Disconnected" : s.status === "connecting" ? "Connecting…" : "Reconnecting…";
  const next = /^changing to (.+)$/.exec(s.timeLeft)?.[1];
  const full = s.max > 0 && s.players >= s.max;
  return h(
    "div.room-head",
    null,
    h("h3.room-name", null, s.name, news ? h("span.room-live", null, news) : null),
    h(
      "table.srv-table.room-facts",
      null,
      h("thead", null, h("tr", null, h("th", null, "Map"), h("th", null, "Players"), h("th", null, "Time left"))),
      h(
        "tbody",
        null,
        h(
          "tr",
          null,
          h("td", null, h("div.srv-map", null, h("span.srv-mapname", null, next ? `→ ${next}` : s.map), next ? null : tierBadge(s.tier))),
          h(
            "td.srv-players",
            null,
            h("span", null, h("b", null, String(s.players)), h("span.dim", null, ` / ${s.max}`)),
            h(`span.srv-bar${full ? ".full" : ""}`, null, h("i", { style: `transform:scaleX(${Math.min(1, s.players / Math.max(1, s.max)).toFixed(3)})` })),
          ),
          h("td", null, next ? "changing" : s.timeLeft.replace(/ left$/, "") || "—"),
        ),
      ),
    ),
  );
}
