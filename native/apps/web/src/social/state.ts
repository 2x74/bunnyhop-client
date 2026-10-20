// Friends, live (apps/api src/social.ts; research/FRIENDS.md): the friend list, where friends are, unread messages and
// the bell's count, kept current by one WebSocket per tab (GET /social/ws). The tab tells it where this player is
// (menu, solo map, server, lobby, replay) when that changes. DOM-free apart from the toasts; the dock (social/dock.ts)
// and the chat commands (social/commands.ts) read and drive it.
//
// Nothing pops mid-run: toasts from here wait while a timed run is going (notify defer) and messages also land in the
// chat log as one line, like room chat.

import { api, ApiError, type ApiPlayer, type Dm, type Friend, type FriendWhere, type FriendsView, type Note } from "../api";
import { dismissKey, toast, whisper } from "../notify";
import { avatar } from "./avatar";
import { onRoomPresence, roomPresence } from "../net/presence";
import { postLocalLine } from "../net/hud";
import { goToLobby, isLobbyRoom } from "../net/lobby";

export type MyWhere =
  | { k: "menu" }
  | { k: "solo"; map: string; style?: string }
  | { k: "server"; id: string; map?: string }
  | { k: "lobby"; id: string; map?: string }
  | { k: "replay"; map?: string };

const PING_MS = 30_000;
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

let view: FriendsView | null = null;
let ws: WebSocket | null = null;
let retry = 0;
let started = false;
let loading: Promise<void> | null = null;
let base: MyWhere = { k: "menu" };
let watching: string | null | false = false;
const listeners = new Set<() => void>();
const dmListeners = new Set<(m: Dm) => void>();
const noteListeners = new Set<(n: Note) => void>();
/** The friend you last got a message from (!r). */
let lastFrom: string | null = null;
let myId: string | null = null;

/** Why there's no list: still loading, no session (signed out), or the server didn't answer. */
let loadState: "loading" | "ok" | "signin" | "error" = "loading";
export const friendsLoad = () => loadState;
export const friendsView = (): FriendsView | null => view;
export const lastMessageFrom = (): string | null => lastFrom;
export const myPlayerId = (): string | null => myId;

export function onFriends(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function onDm(l: (m: Dm) => void): () => void {
  dmListeners.add(l);
  return () => dmListeners.delete(l);
}
export function onNote(l: (n: Note) => void): () => void {
  noteListeners.add(l);
  return () => noteListeners.delete(l);
}
const changed = () => {
  for (const l of [...listeners]) l();
};

export const onlineFriends = (): Friend[] => (view?.friends ?? []).filter((f) => f.where);
export const unreadMessages = (): number => (view?.friends ?? []).reduce((n, f) => n + f.unread, 0);
export const unreadNotes = (): number => view?.unreadNotes ?? 0;

export function friendById(id: string): Friend | null {
  return view?.friends.find((f) => f.id === id) ?? null;
}

/** What a profile said about you and a player (GET /players/:id `social.you`), for before the list has loaded. */
const known = new Map<string, { following: boolean; followsYou: boolean }>();
export function knowRelation(id: string, you: { following: boolean; followsYou: boolean }): void {
  known.set(id, { following: you.following, followsYou: you.followsYou });
}

/** Who you follow: "friends" (both ways), "following" (one way), or null. */
export function followState(id: string): "friends" | "following" | null {
  if (!view) {
    const k = known.get(id);
    return k?.following ? (k.followsYou ? "friends" : "following") : null;
  }
  if (view.friends.some((f) => f.id === id)) return "friends";
  if (view.following.some((f) => f.id === id)) return "following";
  return null;
}
export const followsYou = (id: string): boolean =>
  view ? view.followers.some((f) => f.id === id) || followState(id) === "friends" : !!known.get(id)?.followsYou;

/** Friends whose name matches (exact first, then prefix, then contains), for !w / !invite. */
export function findFriend(name: string): Friend[] {
  const q = name.trim().toLowerCase();
  if (!q || !view) return [];
  const all = view.friends;
  const exact = all.filter((f) => f.name.toLowerCase() === q);
  if (exact.length) return exact;
  const pre = all.filter((f) => f.name.toLowerCase().startsWith(q));
  return pre.length ? pre : all.filter((f) => f.name.toLowerCase().includes(q));
}

/** Refetches the list (after a follow change, on the socket's "friends"). Never throws. A call while one is in flight
 * runs once more after it (so a follow's refetch never reads the list from before it). */
let again = false;
export function refreshFriends(): Promise<void> {
  if (!api.available()) return Promise.resolve();
  if (loading) {
    again = true;
    return loading;
  }
  loading = (async () => {
    try {
      const u = await api.me();
      myId = u?.id ?? null;
      if (!u) {
        loadState = "signin";
        return void changed();
      }
      const next = await api.friends();
      // Follows still on their way stay as pressed (the server may not have them yet).
      for (const [id, f] of pending) applyFollow(next, id, f.on, f.who);
      view = next;
      loadState = "ok";
      changed();
      maybeConnect();
    } catch (e) {
      // Keep the last list; with none, say why.
      if (!view) {
        loadState = e instanceof ApiError && e.status === 401 ? "signin" : "error";
        changed();
      }
    } finally {
      loading = null;
      if (again) {
        again = false;
        void refreshFriends();
      }
    }
  })();
  return loading;
}

type Who = Pick<ApiPlayer, "id" | "name" | "avatarUrl"> & Partial<ApiPlayer>;

/** A follow or unfollow, applied to the list as if the server had already said yes. */
function applyFollow(v: FriendsView, id: string, on: boolean, who?: Who): void {
  const now = Date.now();
  const at = <T extends { id: string }>(l: T[]) => l.findIndex((x) => x.id === id);
  if (on) {
    if (at(v.friends) >= 0 || at(v.following) >= 0) return;
    const i = at(v.followers);
    const p = i >= 0 ? v.followers.splice(i, 1)[0]! : who ? { ...who, since: now } : null;
    if (!p) return;
    if (i >= 0 || known.get(id)?.followsYou) v.friends.push({ ...p, since: now, where: null, lastSeen: null, unread: 0 });
    else v.following.push({ ...p, since: now });
  } else {
    const i = at(v.friends);
    if (i >= 0) {
      const { where: _w, lastSeen: _l, unread: _u, ...p } = v.friends.splice(i, 1)[0]!;
      v.followers.push({ ...p, since: now });
    }
    const j = at(v.following);
    if (j >= 0) v.following.splice(j, 1);
  }
}

/** Follows on their way to the server, by player. */
const pending = new Map<string, { on: boolean; who?: Who; done: Promise<FollowResult> }>();
export const followBusy = (id: string): boolean => pending.has(id);

export type FollowResult = { ok: true; friends: boolean } | { ok: false; error: string };
export interface FollowOpts {
  /** Who it is (name for the words, picture for the lists before the server answers). */
  who?: Who;
  /** The pressed control (or a getter, when the control redraws): "You and X are friends now" rises out of it. */
  at?: Element | (() => Element | null) | null;
  /** Chat commands: no notices (they answer in chat); a failure comes back as {error}. */
  quiet?: boolean;
}

const followError = (e: unknown) =>
  e instanceof ApiError ? (e.status === 401 ? "Sign in to follow players." : e.message) : "Couldn't reach the server.";

/**
 * Follow / unfollow, at once: the list (and every button, count and badge reading it) changes before the server
 * answers, and goes back with a notice if it says no. A press while one is on its way for the same player is ignored.
 * A follow that makes you friends says so; an unfollow offers Undo. Never throws.
 */
export function setFollow(id: string, on: boolean, o: FollowOpts = {}): Promise<FollowResult> {
  const busy = pending.get(id);
  if (busy) return busy.done;
  if (loadState === "signin") {
    const error = "Sign in to follow players.";
    if (!o.quiet) toast(error, { key: "follow-signin", action: { label: "Sign in", run: () => void (location.href = api.discordLoginUrl(location.href)) } });
    return Promise.resolve({ ok: false, error });
  }
  const who: Who | undefined = o.who ?? friendById(id) ?? view?.followers.find((x) => x.id === id) ?? view?.following.find((x) => x.id === id);
  const name = who?.name ?? "";
  const k = known.get(id);
  const kWas = k ? { ...k } : null;
  const was = followState(id);
  const snap = view ? { v: view, friends: [...view.friends], following: [...view.following], followers: [...view.followers] } : null;
  // Already so (a second "Follow back" from an older notice): nothing to send.
  if (on === !!was) return Promise.resolve({ ok: true, friends: was === "friends" });
  const guess = on && followsYou(id);
  const at = () => (typeof o.at === "function" ? o.at() : (o.at ?? null));
  const friendsNow = () => !o.quiet && whisper(name ? `You and ${name} are friends now` : "You're friends now", { at: at() });

  // At once.
  if (view) applyFollow(view, id, on, who);
  if (k) k.following = on;
  else if (!view) known.set(id, { following: on, followsYou: false });
  changed();
  if (guess) friendsNow();
  if (!on && !o.quiet && was)
    toast(name ? `Unfollowed ${name}` : "Unfollowed", { key: `unfollow:${id}`, action: { label: "Undo", run: () => void setFollow(id, true, { ...o, who }) } });

  const done = (async (): Promise<FollowResult> => {
    try {
      const r = await api.follow(id, on);
      pending.delete(id);
      if (on && r.mutual && !guess) friendsNow();
      void refreshFriends();
      return { ok: true, friends: on && !!r.mutual };
    } catch (e) {
      pending.delete(id);
      // Back as it was.
      if (snap && view === snap.v) Object.assign(view, { friends: snap.friends, following: snap.following, followers: snap.followers });
      if (kWas) known.set(id, kWas);
      else known.delete(id);
      changed();
      if (snap && view !== snap.v) void refreshFriends();
      const error = followError(e);
      if (!o.quiet) {
        dismissKey(`unfollow:${id}`);
        toast(error, { tone: "bad" });
      }
      return { ok: false, error };
    }
  })();
  pending.set(id, { on, who, done });
  return done;
}

export async function setBlock(id: string, on: boolean): Promise<void> {
  await api.block(id, on);
  await refreshFriends();
}

export async function setAppearOffline(on: boolean): Promise<void> {
  const r = await api.setAppearOffline(on);
  if (view) view.appearOffline = r.appearOffline;
  changed();
}

/** The panel read a conversation: its badge clears. */
export function markRead(id: string): void {
  const f = friendById(id);
  if (f && f.unread) {
    f.unread = 0;
    changed();
  }
  void api.readDms(id).catch(() => {});
}

/** The bell showed these unread notes (only those: a filtered view doesn't read the rest); `left` unread remain. */
export function markNotesRead(ids: number[], left: number): void {
  if (!ids.length) return;
  if (view && view.unreadNotes !== left) {
    view.unreadNotes = Math.max(0, left);
    changed();
  }
  void api.readNotes(ids).catch(() => {});
}

// --- where am I

function current(): MyWhere {
  if (watching !== false) return { k: "replay", ...(watching ? { map: watching } : {}) };
  const room = roomPresence();
  const map = base.k === "solo" ? base.map : undefined;
  if (room) return isLobbyRoom(room.id) ? { k: "lobby", id: room.id, ...(map ? { map } : {}) } : { k: "server", id: room.id, ...(map ? { map } : {}) };
  return base;
}

let sentWhere = "";
function sendWhere(): void {
  const w = JSON.stringify(current());
  if (!ws || ws.readyState !== WebSocket.OPEN || w === sentWhere) return;
  sentWhere = w;
  ws.send(`{"t":"where","w":${w}}`);
}

/** main.ts: this page plays `map` (solo, or the room's map). */
export function setPlaying(map: string, style?: string): void {
  base = { k: "solo", map, ...(style ? { style } : {}) };
  sendWhere();
}

/** The replay viewer opened (map name if known) or closed (false). */
export function setWatching(map: string | null | false): void {
  watching = map;
  sendWhere();
}

/** The map this page plays and its style (Race their PB), or null in the menu. */
export const playingMap = (): { map: string; style: string } | null => (base.k === "solo" ? { map: base.map, style: base.style ?? "autohop" } : null);

/** Your own place, for invites ("Invite" shows only in a server or lobby). */
export const myWhere = (): MyWhere => current();

// --- the socket

function setWhereOf(id: string, w: FriendWhere | null): void {
  const f = friendById(id);
  if (!f) return;
  if (!w && f.where) f.lastSeen = Date.now();
  f.where = w;
  changed();
}

function handle(m: { t: string; [k: string]: unknown }): void {
  switch (m.t) {
    case "hello": {
      const online = m.online as Record<string, FriendWhere>;
      for (const f of view?.friends ?? []) f.where = online[f.id] ?? null;
      changed();
      break;
    }
    case "presence":
      setWhereOf(m.id as string, (m.w as FriendWhere | null) ?? null);
      break;
    case "friends":
      void refreshFriends();
      break;
    case "dm": {
      const dm = m.m as Dm;
      for (const l of [...dmListeners]) l(dm);
      if (dm.from === myId) break;
      lastFrom = dm.from;
      const f = friendById(dm.from);
      const reading = [...dmListeners].length > 0 && openConversation === dm.from;
      if (f && !reading) {
        f.unread++;
        changed();
      }
      const name = f?.name ?? "A friend";
      const text = dm.kind === "text" ? dm.body : cardText(dm);
      if (!reading) {
        // In game: one chat line (fades like room chat). In menus: a toast you can open.
        postLocalLine(`${name}: ${text}`, [chatFrom(name), text]);
        toast(`${name}: ${text}`, { key: `dm:${dm.from}`, defer: true, lead: avatar({ id: dm.from, name, avatarUrl: f?.avatarUrl ?? null }, 26), action: { label: "Reply", run: () => openFriends(dm.from) } });
      }
      break;
    }
    case "note": {
      const n = m.n as Note;
      if (view) view.unreadNotes++;
      changed();
      for (const l of [...noteListeners]) l(n);
      noteToast(n);
      break;
    }
  }
}

function chatFrom(name: string): HTMLElement {
  const b = document.createElement("b");
  b.className = "chat-friend";
  b.textContent = `${name} (friend): `;
  return b;
}

/** A card message as one line of text ("sent a map: bhop_arcane"). */
export function cardText(dm: Pick<Dm, "kind" | "ref" | "body">): string {
  const ref = dm.ref ?? "";
  if (dm.kind === "map") return `sent a map: ${ref}`;
  if (dm.kind === "replay") return "sent a replay";
  if (dm.kind === "profile") return "sent a profile";
  if (dm.kind === "lobby") return "sent a lobby invite";
  return dm.body;
}

/** A note as a Notice led by the friend's avatar; several from the same person merge into one. */
function noteToast(n: Note): void {
  const who = n.actor.name;
  const id = n.actor.id;
  const d = n.data ?? {};
  const base = { defer: true, lead: avatar(n.actor, 26) };
  if (n.kind === "follow")
    toast(d.mutual ? `${who} followed you back. You're friends now.` : `${who} followed you`, {
      ...base,
      key: `note:${id}`,
      action: d.mutual ? (view?.canMessage ? { label: "Message", run: () => openFriends(id) } : undefined) : followState(id) ? undefined : { label: "Follow back", run: () => void setFollow(id, true, { who: n.actor }) },
    });
  else if (n.kind === "invite") toast(d.lobby ? `${who} invited you to their lobby` : `${who} invited you to ${String(d.name ?? "their server")}`, { ...base, key: `note:${id}`, ms: 12_000, action: { label: "Join", run: () => joinInvite(n) } });
  else if (n.kind === "ask") toast(`${who} wants to join your lobby`, { ...base, key: `note:${id}`, ms: 12_000, action: { label: "Invite", run: () => void api.invite(id).then(() => whisper(`Invited ${who}`), (e: Error) => toast(e.message, { tone: "bad" })) } });
  else if (n.kind === "beat") toast(`${who} beat your PB on ${String(d.map)}`, { ...base, key: `note:${id}`, action: { label: "Open", run: () => openBell() } });
}

/** Goes to an invite's lobby or server. */
export function joinInvite(n: Note): void {
  const d = n.data ?? {};
  if (typeof d.lobby === "string") void goToLobby(d.lobby).catch((e: Error) => toast(e.message, { tone: "bad" }));
  else if (typeof d.server === "string") {
    const url = new URL(location.origin + "/");
    if (typeof d.map === "string") url.searchParams.set("map", d.map);
    url.searchParams.set("server", d.server);
    location.href = url.toString();
  }
}

// The dock opens itself; these let toasts and commands ask it to (set by social/dock.ts).
let openConversation: string | null = null;
let opener: { friends: (id?: string) => void; bell: () => void } | null = null;
export function setDockOpener(o: typeof opener): void {
  opener = o;
}
export function setOpenConversation(id: string | null): void {
  openConversation = id;
}
export const openFriends = (id?: string) => opener?.friends(id);
export const openBell = () => opener?.bell();

function connect(): void {
  const url = api.socialSocketUrl();
  if (!url || ws) return;
  let s: WebSocket;
  try {
    s = new WebSocket(url);
  } catch {
    return reconnect();
  }
  ws = s;
  let ping = 0;
  s.onopen = () => {
    retry = 0;
    sentWhere = "";
    sendWhere();
    ping = window.setInterval(() => s.readyState === WebSocket.OPEN && s.send("ping"), PING_MS);
  };
  s.onmessage = (e) => {
    if (typeof e.data !== "string" || e.data === "pong") return;
    try {
      handle(JSON.parse(e.data) as { t: string });
    } catch {
      /* ignore a bad frame */
    }
  };
  s.onclose = () => {
    clearInterval(ping);
    if (ws === s) ws = null;
    for (const f of view?.friends ?? []) f.where = null;
    changed();
    reconnect();
  };
}

function reconnect(): void {
  const ms = RETRY_MS[Math.min(retry++, RETRY_MS.length - 1)]!;
  setTimeout(() => {
    if (document.visibilityState === "hidden") {
      addEventListener("visibilitychange", () => connect(), { once: true });
    } else connect();
  }, ms);
}

/**
 * The socket only for players in someone's list (following or followed: most guests are neither); the first follow
 * opens it. The list itself is fetched either way (the bell's count, the dock).
 */
function maybeConnect(): void {
  const v = view;
  if (myId && v && (v.friends.length || v.following.length || v.followers.length || v.unreadNotes)) connect();
}

/** main.ts, once: the list, then the socket. Nothing without the API. */
export function initSocial(): void {
  if (started || !api.available()) return;
  started = true;
  onRoomPresence(() => sendWhere());
  void refreshFriends();
}
