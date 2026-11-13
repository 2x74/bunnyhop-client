// Server browser (home screen "Play online" and the pause menu's "Servers"): the persistent rooms from GET /servers.
// A server is a row: a picture of the map it's on, its name, the map and tier, players, time left and its region
// (with the ping to it, small: ping is no reason to pick a room, and the line above the list says why), then
// everyone who is in it (their picture, name and badges, as the boards draw a player; a name shows the player's card
// on hover and opens their profile). Rooms with people in them come first, your nearer region ahead of the other
// (ui/servers-who.ts roomOrder); an empty room is a shorter row, never hidden. Join loads the room's map with ?server=<id> (net/mp.ts takes over from there);
// "Play solo" opens the map browser as before.
// Also the room's own line at the top of the pause menu's Server tab (roomHeader).
//
// Custom CSS (the /custom-css guide promises these): each row is [data-part="server"], with [data-part="map"] (the
// picture), [data-part="players"] (who is there) and [data-part="player"] (one of them).

import "../net/net.css";
import { api, ApiError, type ListingPerson, type ServerListing } from "../api";
import { goToLobby, lobbyIdFromParam } from "../net/lobby";
import { roomActions, roomPresence, roomUrl, type RoomActions } from "../net/presence";
import { openAccount } from "./account-state";
import { avatarImg, pictureOf } from "./avatar";
import { decorated } from "./avatar-deco";
import { hueOf } from "./board-pager";
import { arrowNav, h } from "./dom";
import { hoverCardFor } from "./hover-card";
import { fetchMapIndex, tierBadge } from "./maps";
import { nameAttrs, nameMarks } from "./marks";
import { landRows } from "./land";
import { loadFailed } from "./load-failed";
import { ALL_EMPTY, fastestRegion, moreLabel, nearRegion, roomOrder, WHO_NARROW, WHO_WIDE, whoKey, whoView } from "./servers-who";
import { mapArt } from "./thumbs";
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
  /** Opens a player's profile in place (menu.ts openProfile). Without it a name is a plain link to the profile. */
  profile?: (id: string) => void;
}

/** The phone layout's width (servers.css): rows list fewer players there. */
const NARROW = "(max-width: 40rem)";
/** The region whose rooms answered fastest last time (ui/servers-who.ts nearRegion): this device's, not the account's. */
const NEAR_KEY = "bunnyhop:servers-near";
const nearRemembered = (): string | null => {
  try {
    return localStorage.getItem(NEAR_KEY);
  } catch {
    return null;
  }
};

/**
 * A player in a row's list: their picture, name (in their colour) and badges, the way the boards draw a player. A
 * link to their profile; resting on it shows their card (ui/hover-card.ts), which has their rank.
 */
function personEl(p: ListingPerson, open?: (id: string) => void): HTMLElement {
  const who = { ...p, avatarUrl: p.avatarUrl ?? null };
  const letter = () => h("span.srv-av.rb-av", { "aria-hidden": "true", style: `--hue:${hueOf(p.id)}` }, (p.name.trim()[0] ?? "?").toUpperCase());
  const pic = pictureOf(who);
  const el = h(
    "a.srv-p",
    {
      href: `/u/${encodeURIComponent(p.id)}`,
      "data-part": "player",
      onclick: (ev: Event) => {
        const e = ev as MouseEvent;
        // A real link: middle-click / Ctrl-click open the profile in a new tab; a plain click opens it in place.
        if (!open || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        open(p.id);
      },
    },
    // One box for every player's picture (servers.css .srv-avbox): a supporter's decoration is drawn inside it.
    // Eager: a row is on screen when it is drawn, and the list is a few rooms' worth.
    h("span.srv-avbox", null, decorated(pic ? avatarImg(pic, { cls: "srv-av", px: 24, letter, eager: true }) : letter(), p)),
    // The name in the player's colour, in the list's own font: a name font is fitted by scaling (ui/name-fit.ts),
    // which would put names of different sizes on one line here. Their card, one hover away, has the font.
    h("b.srv-pname", nameAttrs({ ...p, nameFont: null, nameStyle: null }), p.name),
    nameMarks(p),
  );
  return hoverCardFor(el, who);
}

export function serverBrowser(o: ServerBrowserOpts): HTMLElement {
  const here = roomPresence()?.id ?? null;
  const tbody = h("tbody");
  const status = h("p.dim.small.srv-status", { hidden: true });
  const skeleton = () =>
    [0, 1].map(() => h("tr.srv-row.skeleton", { "aria-hidden": "true" }, h("td.srv-art", null, h("span.card-art.srv-thumb")), h("td.srv-name", null, h("b", null, "\u00a0"), h("small", null, "\u00a0"))));
  tbody.append(...skeleton());
  const table = h(
    "table.srv-table",
    null,
    h("thead", null, h("tr", null, h("th"), h("th", null, "Server"), h("th", null, "Map"), h("th", null, "Players"), h("th", null, "Time left"), h("th", null, "Region"), h("th"))),
    tbody,
  );
  const quiet = h("p.srv-quiet", { hidden: true }, ALL_EMPTY);
  const root = h(
    "div.servers",
    null,
    api.available() ? h("p.srv-ping-note", null, PING_NOTE) : null,
    table,
    quiet,
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
  // Map pictures come from the map index by name (ui/thumbs.ts); main.ts has asked for it already.
  let pictures = false;
  void fetchMapIndex().then(() => {
    pictures = true;
    if (root.isConnected && rows.length) render();
  });
  const narrow = matchMedia(NARROW);
  narrow.addEventListener("change", () => root.isConnected && rows.length && render());
  /** Rooms whose "+N more" has been opened. */
  const opened = new Set<string>();

  const join = (s: ServerListing) => {
    if (!s.map || !s.online) return;
    location.href = roomUrl(s.id, s.changing ?? s.map);
  };

  /**
   * One row per room, kept for as long as the room is listed and updated in place: a 10 s refresh then doesn't reload
   * pictures, drop keyboard focus from Join, or pull a name out from under the pointer.
   */
  const views = new Map<string, { el: HTMLElement; set: (s: ServerListing) => void }>();
  const rowView = (id: string) => {
    const art = h("td.srv-art", { "data-part": "map" });
    const title = h("b");
    const sub = h("small");
    const mapCell = h("td.srv-mapcell");
    const count = h("b");
    const max = h("span.dim");
    const fill = h("i");
    const bar = h("span.srv-bar", null, fill);
    const left = h("td.srv-left", { "data-id": id });
    const regionName = h("span");
    const ping = h("small.srv-ping");
    const region = h("td.srv-region", null, regionName, ping);
    const btn = h("button.srv-join", { type: "button" }) as HTMLButtonElement;
    const list = h("div.srv-people");
    // The list is not part of the row's button: a click beside a name must not join.
    const who = h("td.srv-who", { "data-part": "players", onclick: (e: Event) => e.stopPropagation() }, list);
    const el = h("tr.srv-row", { "data-part": "server", "data-server": id }, art, h("td.srv-name", null, title, sub), mapCell, h("td.srv-players", null, h("span", null, count, max), bar), left, region, h("td.srv-actions", null, btn), who);
    let cur: ServerListing | null = null;
    let canJoin = false;
    let artKey = "";
    const people = new Map<string, HTMLElement>();
    const moreBtn = h("button.srv-more", { type: "button", onclick: () => (opened.add(id), cur && set(cur)) });
    const moreText = h("span.srv-more");
    el.onclick = () => canJoin && cur && join(cur);
    btn.onclick = (e) => (e.stopPropagation(), cur && join(cur));
    const set = (s: ServerListing) => {
      cur = s;
      const full = s.players >= s.maxPlayers;
      const reserved = full && supporter && s.players < s.maxPlayers + 1;
      canJoin = s.online && !!s.map && (!full || reserved || here === s.id);
      el.classList.toggle("offline", !s.online);

      const shownMap = s.changing ?? s.map;
      const key = `${shownMap ?? ""}|${pictures}`;
      if (key !== artKey) {
        artKey = key;
        art.replaceChildren(shownMap ? mapArt(shownMap, null, { eager: true, size: "card", className: "srv-thumb" }) : h("span.card-art.srv-thumb"));
      }
      title.replaceChildren(s.name, ...(here === s.id ? [h("span.badge.current.srv-here", null, "You")] : []));
      sub.textContent = `Tiers ${s.tiers[0]}–${s.tiers[1]}, ${s.timeLimitMinutes}-minute maps`;
      mapCell.replaceChildren(s.map ? h("div.srv-map", null, h("span.srv-mapname", { title: s.changing ?? s.map }, s.changing ? `→ ${s.changing}` : s.map), tierBadge(s.tier)) : h("span.dim", null, s.online ? "no maps" : "offline"));
      count.textContent = String(s.players);
      max.textContent = ` / ${s.maxPlayers}`;
      bar.classList.toggle("full", full);
      fill.style.transform = `scaleX(${Math.min(1, s.players / Math.max(1, s.maxPlayers)).toFixed(3)})`;
      const d = deadlines.get(s.id);
      left.textContent = s.changing ? "changing" : d !== undefined ? clock(d - performance.now()) : "—";
      // The region, plainly, and the ping to it as a small plain number: it tells you how far the room is, not how
      // good it is (no green or red; your run is timed on your machine).
      regionName.textContent = s.region;
      const p = pings.get(s.id);
      ping.textContent = typeof p === "number" ? `${p} ms` : "";
      // The row is the button; its label stays quiet until the row is hovered or focused.
      btn.disabled = !canJoin;
      btn.textContent = here === s.id ? "Rejoin" : full && !reserved ? "Full" : "Join";

      // Who is here. In your own room, your entry is the one your client has of you (ui/servers-who.ts).
      const view = whoView(s, { cap: narrow.matches ? WHO_NARROW : WHO_WIDE, open: opened.has(s.id), self: here === s.id ? roomActions()?.self?.() : null });
      // An empty room is a shorter row: its count says 0, and the line under the list speaks for all of them.
      who.hidden = !view;
      el.classList.toggle("bare", !view);
      const next: HTMLElement[] = [];
      const keep = new Set<string>();
      for (const person of view?.shown ?? []) {
        const k = whoKey(person);
        keep.add(k);
        let pe = people.get(k);
        if (!pe) people.set(k, (pe = personEl(person, o.profile)));
        next.push(pe);
      }
      for (const k of people.keys()) if (!keep.has(k)) people.delete(k);
      if (view?.more) {
        const more = view.canOpen ? moreBtn : moreText;
        more.textContent = moreLabel(view.more);
        next.push(more);
      }
      // Only what changed moves: an entry that stays keeps its element, its picture, its hover and its focus.
      next.forEach((n, i) => list.children[i] !== n && list.insertBefore(n, list.children[i] ?? null));
      while (list.children.length > next.length) list.lastElementChild!.remove();
    };
    return { el, set };
  };

  /**
   * The rooms' order, decided when the list first arrives and kept while the screen is up (a room that appears later
   * goes last), so a row never moves under the pointer when someone joins or leaves.
   */
  let order: string[] = [];
  const ordered = () => {
    if (!order.length && rows.length) order = roomOrder(rows, nearRegion(rows.map((s) => s.region), { utcHours: -new Date().getTimezoneOffset() / 60, measured: nearRemembered() }));
    for (const s of rows) if (!order.includes(s.id)) order.push(s.id);
    return [...rows].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  };
  /** Once every room has answered a ping: remember the nearest region for the next time the list opens. */
  const rememberNear = () => {
    if (rows.some((s) => s.online && !pings.has(s.id))) return;
    const region = fastestRegion(rows, pings);
    try {
      if (region) localStorage.setItem(NEAR_KEY, region);
    } catch {
      /* private window: the clock's guess next time */
    }
  };

  let painted = false;
  const render = () => {
    // The first real paint lands row by row and fills the player bars; the 10 s refreshes just update.
    tbody.classList.toggle("fresh", !painted);
    const first = !painted;
    painted = true;
    for (const id of views.keys()) if (!rows.some((s) => s.id === id)) views.delete(id);
    quiet.hidden = !rows.some((s) => s.online) || rows.some((s) => s.players > 0);
    const els = ordered().map((s) => {
      let v = views.get(s.id);
      if (!v) views.set(s.id, (v = rowView(s.id)));
      v.set(s);
      return v.el;
    });
    if (els.length !== tbody.children.length || els.some((e, i) => tbody.children[i] !== e)) tbody.replaceChildren(...els);
    if (first) landRows(tbody.children);
  };
  arrowNav(tbody, "button.srv-join:not([disabled])");

  const load = async () => {
    try {
      rows = await api.servers();
      status.textContent = rows.length ? "" : "No servers right now.";
      status.hidden = !!rows.length;
      const now = performance.now();
      for (const s of rows) if (s.timeLeftMs !== null) deadlines.set(s.id, now + s.timeLeftMs);
      render();
      for (const s of rows) if (!pings.has(s.id) && s.online) void measurePing(s.id).then((p) => (pings.set(s.id, p), rememberNear(), root.isConnected && render()));
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
