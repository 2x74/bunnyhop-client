// The friends dock (research/FRIENDS.md): bottom right of the home screen, the pause menu and the server list, never
// while playing. Two buttons: the bell (social notes: invites, follows, beaten PBs) and Friends (who's online, where,
// messages). Each opens a panel above the dock. Live data: social/state.ts.

import "./dock.css";
import { api, ApiError, type ApiPlayer, type Dm, type Friend, type FriendsView, type FriendWhere, type Note, type NoteFilter } from "../api";
import { closeMenus, withMenu } from "./menu";
import { liveSearch, type LiveSearch } from "./search";
import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { avatar } from "./avatar";
import { staffButton } from "../staff-lens";
import { dismissOutside } from "../ui/dismiss";
import { nameAttrs, nameMarks } from "../ui/marks";
import { navigate } from "../ui/nav";
import { roomUrl } from "../net/presence";
import { requestRace } from "../player/race";
import { openReplayViewer } from "../viewer/request";
import { formatTime } from "../timer";
import { landIn, nudge, toast, whisper } from "../notify";
import { landFailed, landFollow } from "./land";
import {
  cardText,
  followBusy,
  followState,
  followsYou,
  friendById,
  friendsLoad,
  friendsView,
  joinInvite,
  markNotesRead,
  markRead,
  myPlayerId,
  myWhere,
  onDm,
  onFriends,
  onNote,
  onlineFriends,
  playingMap,
  refreshFriends,
  setAppearOffline,
  setDockOpener,
  setFollow,
  setOpenConversation,
  unreadMessages,
  unreadNotes,
} from "./state";

/** Screens the dock shows on (menu.ts sets body[data-screen]). */
const SCREENS = new Set(["home", "pause", "servers"]);

type View = { k: "friends" } | { k: "chat"; id: string } | { k: "bell" };

let root: HTMLElement | null = null;
let panel: HTMLElement;
let bellBtn: HTMLButtonElement;
let friendsBtn: HTMLButtonElement;
let view: View | null = null;
let filter: NoteFilter = "all";
let offDm: (() => void) | null = null;

const MIN = 60_000;
export function ago(t: number, now = Date.now()): string {
  const d = now - t;
  if (d < MIN) return "just now";
  if (d < 60 * MIN) return `${Math.floor(d / MIN)} min ago`;
  if (d < 24 * 60 * MIN) return `${Math.floor(d / (60 * MIN))} h ago`;
  const days = Math.floor(d / (24 * 60 * MIN));
  return days === 1 ? "yesterday" : days < 30 ? `${days} days ago` : new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** "Playing bhop_arcane", "Playing bhop_eazy on Easy", "Last on 2 h ago". */
export function whereText(w: FriendWhere | null, lastSeen: number | null): string {
  if (!w) return lastSeen ? `Last on ${ago(lastSeen)}` : "Offline";
  switch (w.k) {
    case "menu":
      return "Online";
    case "solo":
      return `Playing ${w.map}`;
    case "server":
      return w.map ? `Playing ${w.map} on ${w.name ?? "a server"}` : `On ${w.name ?? "a server"}`;
    case "lobby":
      return w.map ? `Playing ${w.map} in a private lobby` : "In a private lobby";
    case "replay":
      return w.map ? `Watching a replay of ${w.map}` : "Watching a replay";
  }
}

/** Three dots: "more" (a friend row's menu, the profile's overflow). */
export const DOTS = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.5" cy="10" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="15.5" cy="10" r="1.6"/></svg>';

const name = (p: ApiPlayer) => h("span.fd-name", null, h("b", nameAttrs(p), p.name), nameMarks(p));

/**
 * A person as a link to their profile (avatar and name, and whatever line goes with them): a click or Enter opens it
 * here and closes the panel; a middle / Ctrl click opens it in a new tab like any link. The row's own buttons sit
 * outside it.
 */
export function profileLink(p: Pick<ApiPlayer, "id" | "name">, kids: (Node | string | null)[], o: { onOpen?: () => void; cls?: string } = {}): HTMLAnchorElement {
  return h(
    `a.fd-main${o.cls ?? ""}`,
    {
      href: `/u/${encodeURIComponent(p.id)}`,
      title: `${p.name}'s profile`,
      onclick: (ev: Event) => {
        const e = ev as MouseEvent;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        o.onOpen?.();
        close();
        navigate({ screen: "profile", id: p.id });
      },
    },
    ...kids,
  ) as HTMLAnchorElement;
}

function fail(e: unknown): void {
  toast(e instanceof ApiError ? e.message : "Couldn't reach the server.", { tone: "bad" });
}

// ---------------------------------------------------------------------------------------------
// Friends: who's online and where, one action each; people who follow you (Follow back); a search.

interface Act {
  label: string;
  run: () => void | Promise<void>;
  title?: string;
  count?: number;
}

/** What you'd most likely do with a friend right now (one button on their row), then the rest (the row's menu). */
export function friendActs(f: Friend): { main: Act | null; more: Act[] } {
  const v = friendsView();
  const w = f.where;
  const mine = myWhere();
  const map = playingMap();
  const inRoom = mine.k === "server" || mine.k === "lobby";
  const together = !!w && w.k === mine.k && w.k === "server" && mine.k === "server" && w.id === mine.id;
  const message: Act | null = v?.canMessage || f.unread ? { label: "Message", run: () => show({ k: "chat", id: f.id }), count: f.unread || undefined } : null;
  const invite: Act | null = w && inRoom && !together ? { label: "Invite", title: `Invite ${f.name} to your ${mine.k === "lobby" ? "lobby" : "server"}`, run: async () => (await api.invite(f.id), whisper(`Invited ${f.name}`)) } : null;
  const join: Act | null = w?.k === "server" && w.map && !together ? { label: "Join", title: `Join ${f.name} on ${w.name ?? "their server"}`, run: () => void (location.href = roomUrl(w.id, w.map!)) } : null;
  const ask: Act | null = w?.k === "lobby" && !inRoom ? { label: "Ask to join", title: `Ask ${f.name} to invite you`, run: async () => (await api.askToJoin(f.id), whisper(`Asked ${f.name}`)) } : null;
  const race: Act | null = map ? { label: "Race", title: `Race ${f.name}'s PB on ${map.map}`, run: () => raceFriend(f, map) } : null;
  const order = f.unread ? [message, invite, join, ask, race] : [invite, join, ask, race, w ? message : null];
  const main = order.find((x): x is Act => !!x) ?? null;
  const more = [message, invite, join, ask, race].filter((x): x is Act => !!x && x !== main);
  more.push({ label: "Profile", run: () => (close(), navigate({ screen: "profile", id: f.id })) });
  return { main, more };
}

const actBtn = (a: Act, cls = "") =>
  h(
    `button.btn.btn-sm.fd-act${cls}`,
    { type: "button", title: a.title, onclick: (e: Event) => (e.stopPropagation(), void Promise.resolve(a.run()).catch(fail)) },
    a.label,
    a.count ? h("span.fd-count", { "aria-label": `${a.count} unread` }, String(a.count)) : null,
  );

function friendRow(f: Friend): HTMLElement {
  const { main, more } = friendActs(f);
  const menuBtn = withMenu(
    h("button.fd-more-btn", { type: "button", "aria-label": `More for ${f.name}`, title: "More" }, h("span.fd-dots", { html: DOTS })),
    () => [
      ...friendActs(f).more.map((a) => ({ label: a.label, run: a.run })),
      { label: "Unfollow", run: () => void setFollow(f.id, false, { who: f }) },
    ],
    { align: "right", label: f.name },
  );
  return h(
    `li.fd-row.fr${f.where ? ".on" : ""}`,
    { "data-id": f.id },
    profileLink(f, [h("span.fd-avw", null, avatar(f), h("i.fd-dot", { "aria-hidden": "true" })), h("span.fd-txt", null, name(f), h("small", null, whereText(f.where, f.lastSeen)))]),
    main ? actBtn(main, main.label === "Join" ? ".go" : "") : null,
    more.length ? menuBtn : null,
  );
}

/** Their PB on the map you're on, as your ghost. */
async function raceFriend(f: Friend, map: { map: string; style: string }): Promise<void> {
  const lb = await api.leaderboard(map.map, map.style, { around: f.id, limit: 1 });
  const e = lb.entries.find((x) => x.player.id === f.id) ?? (lb.me?.player.id === f.id ? lb.me : null);
  if (!e) return void toast(`${f.name} has no time on ${map.map} yet`);
  requestRace({ kind: "run", runId: e.runId, name: `${f.name} · ${formatTime(e.time)}`, track: 0, time: e.time });
  whisper(`Racing ${f.name}'s ghost`);
  close();
}

/**
 * "Find a player": name search, Follow from the result. One finder per opening of the panel: the panel's live redraws
 * (a follow, a friend coming online) move this same element into the new panel, so the field, its listener and its
 * results stay together. (Rebuilding it on every redraw left the new field writing into a detached list: after a
 * follow, a second search never showed.)
 */
let finderEl: { el: HTMLElement; search: LiveSearch } | null = null;
function finder(): HTMLElement {
  if (finderEl) return finderEl.el;
  const results = h("ul.fd-list.fd-found", { "aria-live": "polite" });
  const input = h("input.fd-search", { type: "search", placeholder: "Find a player", "aria-label": "Find a player by name", maxlength: "20", autocomplete: "off" }) as HTMLInputElement;
  const search = liveSearch<ApiPlayer>(
    async (q, signal) => {
      const me = myPlayerId();
      return (await api.searchPlayers(q, { signal })).filter((p) => p.id !== me);
    },
    (st) => {
      if (st.k === "idle") return results.replaceChildren();
      if (st.k === "loading") return results.querySelector(".fd-row") ? results.classList.add("busy") : results.replaceChildren(h("li.fd-empty", null, "Searching"));
      results.classList.remove("busy");
      if (st.k === "error")
        return results.replaceChildren(h("li.fd-empty.fd-signin", null, h("span", null, "Couldn't search."), h("button.btn.btn-sm", { type: "button", onclick: () => search.again() }, "Retry")));
      results.replaceChildren(...(st.items.length ? st.items.map((p) => personRow(p)) : [h("li.fd-empty", null, "Nobody by that name")]));
    },
  );
  input.addEventListener("input", () => search.input(input.value));
  const el = h("div.fd-finder", null, h("span.fd-search-i", { "aria-hidden": "true" }, icon("search")), input, results);
  finderEl = { el, search };
  return el;
}

/**
 * A player in a list (search results, Follow back, a profile's followers / following / friends): avatar (with the
 * presence dot when they're your friend), name, a line (where they are, or `sub`), and the follow button. The name
 * opens their profile.
 */
export function personRow(p: ApiPlayer, o: { sub?: string | null; onOpen?: () => void } = {}): HTMLElement {
  const f = friendById(p.id);
  const me = p.id === myPlayerId();
  const sub = f ? whereText(f.where, f.lastSeen) : (o.sub ?? (!me && followsYou(p.id) ? "Follows you" : null));
  return h(
    `li.fd-row${f ? ".fr" : ""}${f?.where ? ".on" : ""}`,
    { "data-id": p.id },
    profileLink(p, [h("span.fd-avw", null, avatar(p), f ? h("i.fd-dot", { "aria-hidden": "true" }) : null), h("span.fd-txt", null, name(p), sub ? h("small", null, sub) : null)], { onOpen: o.onOpen }),
    me ? h("span.fd-you", null, "You") : followButton(p, "sm"),
  );
}

/**
 * Follow (or Follow back, when they follow you) / Following / Friends. Following and Friends read "Unfollow" while
 * hovered or focused, and a press unfollows. For the dock's lists, the bell and the profile's people lists.
 * A press lands at once (social/land.ts: the press, a seal, the sound; the list changes before the server answers) and
 * the button keeps its word until the pointer leaves it, so a fresh "Friends" doesn't turn straight into "Unfollow".
 */
export function followButton(p: Pick<ApiPlayer, "id" | "name" | "avatarUrl"> & Partial<ApiPlayer>, size: "sm" | "" = ""): HTMLElement {
  const id = p.id;
  const b = h(`button.btn.fd-follow${size ? ".btn-sm" : ""}`, { type: "button", "data-sound": "none" }) as HTMLButtonElement;
  let hot = false;
  let cool = false;
  const paint = () => {
    const s = followState(id);
    b.textContent = s && hot && !cool ? "Unfollow" : s === "friends" ? "Friends" : s === "following" ? "Following" : followsYou(id) ? "Follow back" : "Follow";
    b.classList.toggle("want", !s);
    b.classList.toggle("is-on", !!s);
    b.classList.toggle("cool", cool);
    b.setAttribute("aria-pressed", String(!!s));
    b.title = s === "friends" ? "You follow each other" : !s && followsYou(id) ? "They follow you. Follow back to be friends." : "";
  };
  const heat = (on: boolean) => () => {
    hot = on;
    if (!on) cool = false;
    paint();
  };
  b.addEventListener("pointerenter", heat(true));
  b.addEventListener("pointerleave", heat(false));
  b.addEventListener("focus", () => b.matches(":focus-visible") && heat(true)());
  b.addEventListener("blur", heat(false));
  b.onclick = (e) => {
    e.stopPropagation();
    if (followBusy(id)) return;
    const on = !followState(id);
    const kind = !on ? "off" : followsYou(id) ? "friends" : "following";
    cool = true;
    if (on && view?.k === "friends") holdList(id);
    void setFollow(id, on, { who: p, at: b }).then((r) => {
      if (!r.ok) landFailed(b);
    });
    paint();
    landFollow(b, kind);
  };
  paint();
  let seen = false;
  const off = onFriends(() => {
    if (b.isConnected) (seen = true), paint();
    else if (seen) off();
  });
  return b;
}

/** People who follow you and you don't follow back: the first few, the rest behind one line. */
let showAllBack = false;
function followBack(v: FriendsView): HTMLElement | null {
  if (!v.followers.length) return null;
  const shown = showAllBack ? v.followers : v.followers.slice(0, 3);
  const rest = v.followers.length - shown.length;
  return h(
    "section.fd-sec.fd-back-sec",
    null,
    h("h4", null, "Follow back to be friends"),
    h("ul.fd-list", null, ...shown.map((p) => personRow(p, { sub: `Followed you ${ago(p.since)}` }))),
    rest > 0 ? h("button.link-btn.fd-all", { type: "button", onclick: () => ((showAllBack = true), render()) }, `${rest} more`) : null,
  );
}

function friendsBody(): HTMLElement[] {
  const v = friendsView();
  if (!v) {
    const st = friendsLoad();
    if (st === "signin")
      return [h("p.fd-empty.fd-signin", null, h("span", null, "Sign in to see your friends."), h("a.btn.btn-sm", { href: api.discordLoginUrl(location.href) }, "Sign in"))];
    if (st === "error") return [h("p.fd-empty.fd-signin", null, h("span", null, "Couldn't load your friends."), h("button.btn.btn-sm", { type: "button", onclick: () => void refreshFriends() }, "Retry"))];
    return [h("p.fd-empty", null, "Loading")];
  }
  const sorted = [...v.friends].sort((a, b) => Number(!!b.where) - Number(!!a.where) || b.unread - a.unread || (b.lastSeen ?? 0) - (a.lastSeen ?? 0) || a.name.localeCompare(b.name));
  const list = sorted.length
    ? h("ul.fd-list.fd-friend-list", null, ...sorted.map(friendRow))
    : h("p.fd-empty.fd-teach", null, "Follow players you know. When they follow you back, you're friends.");
  const oneWay = v.following.length
    ? h(
        "details.fd-more",
        null,
        h("summary", null, "You follow ", h("span.fd-n", null, String(v.following.length)), v.following.length === 1 ? " player who hasn't followed back" : " players who haven't followed back"),
        h("ul.fd-list", null, ...v.following.map((p) => personRow(p))),
      )
    : null;
  const hide = h("input.switch", { type: "checkbox", checked: v.appearOffline, "aria-label": "Appear offline" }) as HTMLInputElement;
  hide.onchange = () => void setAppearOffline(hide.checked).catch((e) => ((hide.checked = !hide.checked), fail(e)));
  return [
    finder(),
    h("div.fd-scroll", null, followBack(v), list, oneWay),
    h("label.fd-hide", null, hide, h("span", null, "Appear offline")),
  ];
}

// ---------------------------------------------------------------------------------------------
// A conversation

function card(m: Dm): HTMLElement | null {
  const ref = m.ref ?? "";
  const go = (label: string, run: () => void) => h("button.link-btn", { type: "button", onclick: run }, label);
  if (m.kind === "map") return h("span.fd-card", null, h("b", null, ref), go("Play", () => void (location.href = `/?map=${encodeURIComponent(ref)}`)));
  if (m.kind === "replay") return h("span.fd-card", null, "A replay", go("Watch", () => (close(), openReplayViewer({ runId: ref }))));
  if (m.kind === "profile") return h("span.fd-card", null, "A profile", go("Open", () => navigate({ screen: "profile", id: ref })));
  if (m.kind === "lobby") return h("span.fd-card", null, "A lobby", go("Join", () => joinInvite({ data: { lobby: ref } } as unknown as Note)));
  return null;
}

function bubble(m: Dm, me: string | null): HTMLElement {
  return h(`li.fd-msg${m.from === me ? ".mine" : ""}`, { title: new Date(m.at).toLocaleString() }, m.kind === "text" ? m.body : (card(m) ?? cardText(m)));
}

function chatBody(id: string): HTMLElement[] {
  const v = friendsView();
  const f = v?.friends.find((x) => x.id === id) ?? null;
  const me = myPlayerId();
  const list = h("ol.fd-msgs", { "aria-live": "polite" }, h("li.fd-empty", null, "Loading"));
  const scroll = () => (list.scrollTop = list.scrollHeight);
  void api.conversation(id).then(
    (c) => {
      list.replaceChildren(...(c.messages.length ? c.messages.map((m) => bubble(m, me)) : [h("li.fd-empty", null, "No messages yet")]));
      scroll();
      markRead(id);
    },
    () => list.replaceChildren(h("li.fd-empty", null, "Couldn't load messages")),
  );
  offDm?.();
  offDm = onDm((m) => {
    if (m.from !== id && m.to !== id) return;
    list.querySelector(".fd-empty")?.remove();
    list.append(bubble(m, me));
    scroll();
    if (m.from === id) markRead(id);
  });
  const input = h("input.fd-say", { type: "text", maxlength: "300", placeholder: v?.canMessage ? "Message" : "Sign in to send messages", disabled: !v?.canMessage, "aria-label": "Message" }) as HTMLInputElement;
  const form = h("form.fd-compose", null, input) as HTMLFormElement;
  form.onsubmit = (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    input.disabled = true;
    void api
      .sendDm(id, { body })
      .then(() => (input.value = ""), fail)
      .finally(() => {
        input.disabled = false;
        input.focus();
      });
  };
  requestAnimationFrame(() => input.focus({ preventScroll: true }));
  return [
    h(
      "div.fd-chathead",
      null,
      h("button.fd-back", { type: "button", "aria-label": "Back to friends", onclick: () => show({ k: "friends" }) }, "‹"),
      f
        ? profileLink(f, [h("span.fd-avw", null, avatar(f, 24)), h("span.fd-txt", null, name(f), h("small", null, whereText(f.where, f.lastSeen)))], { cls: ".fd-who" })
        : h("span.fd-txt", null, h("b", null, "Conversation")),
    ),
    list,
    form,
  ];
}

// ---------------------------------------------------------------------------------------------
// The bell

const FILTERS: [NoteFilter, string][] = [
  ["all", "All"],
  ["invites", "Invites"],
  ["friends", "Follows"],
  ["records", "Records"],
];

function noteLine(n: Note): (string | Node)[] {
  const d = n.data ?? {};
  const who = h("b", nameAttrs(n.actor), n.actor.name);
  switch (n.kind) {
    case "follow":
      return [who, d.mutual ? " followed you back. You're friends now." : " followed you"];
    case "invite":
      return d.lobby ? [who, " invited you to their lobby", d.map ? ` on ${String(d.map)}` : ""] : [who, ` invited you to ${String(d.name ?? "their server")}`];
    case "ask":
      return [who, " wants to join your lobby"];
    case "beat": {
      const by = typeof d.yours === "number" && typeof d.ticks === "number" ? ` by ${formatTime((d.yours - d.ticks) / 100)}` : "";
      return [who, ` beat your PB on ${String(d.map)}${by}`];
    }
  }
}

function noteAction(n: Note): HTMLElement | null {
  const d = n.data ?? {};
  const btn = (label: string, run: () => void | Promise<void>) => h("button.btn.btn-sm", { type: "button", onclick: () => void Promise.resolve(run()).catch(fail) }, label);
  // Follow back here: the button lands in place and stays ("Friends") until the bell redraws.
  if (n.kind === "follow" && !followState(n.actor.id)) return followButton(n.actor, "sm");
  if (n.kind === "invite") return n.expired ? h("span.dim", null, "Expired") : btn("Join", () => joinInvite(n));
  if (n.kind === "ask") return n.expired ? h("span.dim", null, "Expired") : btn("Invite", async () => (await api.invite(n.actor.id), whisper(`Invited ${n.actor.name}`)));
  if (n.kind === "beat" && typeof d.run === "string") return btn("Watch", () => (close(), openReplayViewer({ runId: d.run as string })));
  return null;
}

function bellBody(): HTMLElement[] {
  const list = h("ul.fd-list.fd-notes", null, h("li.fd-empty", null, "Loading"));
  void api.notes(filter).then(
    (r) => {
      list.replaceChildren(
        ...(r.notes.length
          ? r.notes.map((n) =>
              h(
                `li.fd-note${n.read ? "" : ".new"}`,
                { "data-id": n.actor.id },
                profileLink(n.actor, [h("span.fd-avw", null, avatar(n.actor, 24)), h("span.fd-txt", null, h("span", null, ...noteLine(n)), h("small", null, ago(n.at)))]),
                noteAction(n),
              ),
            )
          : [h("li.fd-empty", null, filter === "all" ? "Nothing yet" : "Nothing here")]),
      );
      // Read: what this list showed (a filtered list leaves the others' unread).
      const seen = r.notes.filter((n) => !n.read).map((n) => n.id);
      markNotesRead(seen, r.unread - seen.length);
    },
    (e: unknown) => {
      // Signed out: no tabs, one line and the way in.
      if (e instanceof ApiError && e.status === 401) {
        tabs.remove();
        list.replaceChildren(h("li.fd-empty.fd-signin", null, h("span", null, "Sign in to get invites and follows."), h("a.btn.btn-sm", { href: api.discordLoginUrl(location.href) }, "Sign in")));
      } else list.replaceChildren(h("li.fd-empty", null, "Couldn't load notifications. Try again in a moment."));
    },
  );
  const tabs = h(
    "div.fd-tabs",
    { role: "tablist" },
    ...FILTERS.map(([k, label]) => h(`button${k === filter ? ".on" : ""}`, { type: "button", role: "tab", "aria-selected": String(k === filter), onclick: () => ((filter = k), render()) }, label)),
  );
  return [tabs, list];
}

// ---------------------------------------------------------------------------------------------

// A follow back pressed in the Friends panel: the row stays where it is while the press lands (the button turns to
// "Friends" with its seal), then the list redraws and the new friend lands in the friends list.
let holdTill = 0;
let holdTimer = 0;
let landed: string | null = null;
const HOLD_MS = 900;
function holdList(id: string): void {
  holdTill = performance.now() + HOLD_MS;
  landed = id;
}
function renderList(): void {
  const wait = holdTill - performance.now();
  if (wait > 0) {
    paintBar();
    clearTimeout(holdTimer);
    holdTimer = window.setTimeout(renderList, wait);
    return;
  }
  render();
  const id = landed;
  landed = null;
  const row = id ? panel.querySelector<HTMLElement>(`.fd-friend-list [data-id="${CSS.escape(id)}"]`) : null;
  if (row) {
    row.classList.add("fresh");
    if (!document.body.classList.contains("potato")) landIn(row, "translateY(-10px) scale(0.98)");
  }
}

function show(v: View): void {
  view = v;
  setOpenConversation(v.k === "chat" ? v.id : null);
  if (v.k !== "chat") {
    offDm?.();
    offDm = null;
  }
  render();
}

function close(): void {
  view = null;
  finderEl?.search.cancel();
  finderEl = null;
  closeMenus();
  setOpenConversation(null);
  offDm?.();
  offDm = null;
  render();
}

/** Unread notes at the last paint: the badge pops once when it goes up. Friends likewise: the icon pops on a new one. */
let shownNotes = 0;
let shownFriends = -1;

function paintBar(): void {
  const n = unreadNotes();
  const badge = n ? h("span.fd-badge", null, n > 99 ? "99+" : String(n)) : null;
  bellBtn.replaceChildren(icon("bell", { size: "1.05rem" }), badge ?? "");
  if (badge && n > shownNotes) nudge(badge);
  shownNotes = n;
  bellBtn.setAttribute("aria-label", n ? `Notifications, ${n} new` : "Notifications");
  const online = onlineFriends().length;
  const unread = unreadMessages();
  friendsBtn.replaceChildren(
    icon("friends", { size: "1.05rem" }),
    h("span", null, "Friends"),
    online ? h("small", null, `${online} online`) : "",
    unread ? h("span.fd-badge", null, String(unread)) : "",
  );
  const nf = friendsView()?.friends.length ?? 0;
  if (shownFriends >= 0 && nf > shownFriends) nudge(friendsBtn.firstElementChild!);
  shownFriends = nf;
  friendsBtn.setAttribute("aria-label", `Friends${online ? `, ${online} online` : ""}${unread ? `, ${unread} unread` : ""}`);
  bellBtn.classList.toggle("on", view?.k === "bell");
  friendsBtn.classList.toggle("on", !!view && view.k !== "bell");
}

function render(): void {
  if (!root) return;
  paintBar();
  if (!view) {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }
  const head =
    view.k === "chat"
      ? null
      : h(
          "header.fd-head",
          null,
          h("h3", null, view.k === "bell" ? "Notifications" : "Friends"),
          view.k === "friends" && friendsView()?.appearOffline
            ? h("small.fd-hidden", null, "You appear offline")
            : view.k === "friends" && onlineFriends().length
              ? h("small", null, `${onlineFriends().length} online`)
              : null,
          h("button.fd-x", { type: "button", "aria-label": "Close", onclick: close }, icon("close", { size: "0.9rem" })),
        );
  // The finder moves into the new panel as it is (see finder()); keep its focus.
  const focused = document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains("fd-search") ? document.activeElement : null;
  panel.hidden = false;
  panel.className = `fd-panel fd-${view.k}`;
  panel.replaceChildren(...(head ? [head] : []), ...(view.k === "friends" ? friendsBody() : view.k === "chat" ? chatBody(view.id) : bellBody()));
  if (focused?.isConnected) focused.focus({ preventScroll: true });
}

/** main.ts, once (after initSocial). */
export function initDock(): void {
  if (root || !api.available()) return;
  panel = h("div.fd-panel", { hidden: true, role: "dialog", "aria-label": "Friends" });
  bellBtn = h("button.fd-btn.fd-bell", { type: "button", onclick: () => (view?.k === "bell" ? close() : show({ k: "bell" })) }) as HTMLButtonElement;
  friendsBtn = h("button.fd-btn.fd-friends", { type: "button", onclick: () => (view && view.k !== "bell" ? close() : show({ k: "friends" })) }) as HTMLButtonElement;
  // Staff only: their shield, left of the bell, to the admin panel (staff-lens.ts; hidden for players).
  const staff = staffButton();
  const bar = h("div.fd-bar", null, staff.el, bellBtn, friendsBtn);
  root = h("div.fdock", { "aria-label": "Friends and notifications" }, panel, bar);
  // A press anywhere else closes the open panel (ui/dismiss.ts); the bar's own buttons toggle it themselves.
  dismissOutside(panel, () => close(), { also: [bar], active: () => !!view && !root!.hidden });
  document.body.append(root);
  const sync = () => {
    // Not over the replay viewer, which opens from a menu that stays "open" underneath it.
    const on = document.body.classList.contains("menu-open") && !document.body.classList.contains("viewer-open") && SCREENS.has(document.body.dataset.screen ?? "");
    root!.hidden = !on;
    if (on) staff.refresh();
    if (!on && view) close();
  };
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ["class", "data-screen"] });
  sync();
  // Esc closes the panel before the menu sees it.
  addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !view || root!.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      if (view.k === "chat") show({ k: "friends" });
      else close();
    },
    { capture: true },
  );
  // Live redraws: the list (not a conversation or the bell, which keep their place).
  onFriends(() => (view?.k === "friends" ? renderList() : paintBar()));
  onNote(() => (view?.k === "bell" ? render() : paintBar()));
  setDockOpener({ friends: (id) => show(id ? { k: "chat", id } : { k: "friends" }), bell: () => show({ k: "bell" }) });
  // A menu opened: catch up (the socket keeps it current; this covers a missed reconnect).
  let last = 0;
  new MutationObserver(() => {
    if (!root!.hidden && Date.now() - last > 60_000) {
      last = Date.now();
      void refreshFriends();
    }
  }).observe(root, { attributes: true, attributeFilter: ["hidden"] });
  render();
}
