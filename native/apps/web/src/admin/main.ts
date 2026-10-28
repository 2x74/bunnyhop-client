// /admin: the moderation panel (admin.html). Plain DOM, no game code. Every request goes to /api/admin/* (apps/api
// src/admin-panel.ts, admin-tools.ts, admin-integrity.ts, admin.ts, feedback.ts), which authorises it: the player's
// session cookie if they are staff (owner, admin or moderator; what each may do: src/moderation/staff.ts, which also
// hides what the API would refuse here), else an ADMIN_TOKEN pasted here (kept in sessionStorage for this tab only,
// sent as a Bearer token). The API answers 404 to everyone else, which is what shows the token form.
//
// This file is the shell: the rail of eight sections (Queue, Live, Anticheat, Players, Inbox, Boards, Pulse, Staff) and
// Back to game (the desktop client has no address bar),
// each section's tabs under its title, the router, loading and error states, and the boot (the rail paints at once from
// the last /admin/me in this tab). The views live in their own modules.

import { glyph } from "./glyphs";
import { installPress, hopArc } from "./ui";
import { $, api, avatar, cachedMe, clearKeys, h, may, me, NotAdmin, ROLE_WORD, setMe, setRouter, setToken, staffShield, token, append, type Me, type View } from "./core";
import { GOTO_KEYS, installPalette } from "./palette";
import type { Permission } from "../moderation/staff";
import { closeDrawer, installDrawer } from "./drawer";
import { loadMapIndex } from "./art";
import { hopIndicator } from "../ui/hop";
import { queueView, refreshQueueBadge } from "./queue";
import { chatView, lobbiesView, roomsView } from "./live";
import { casesView } from "./cases";
import { acBoardView, reportBoardView } from "./board";
import { closeMenu } from "./thread";
import { runsView, signalsView } from "./runs";
import { namesView, networkView, playerView, playersView } from "./players";
import { announceView, feedbackView, refreshFeedbackBadge } from "./inbox";
import { mapsView, recordsView2, supportersView } from "./boards";
import { gauntletsView } from "./gauntlets";
import { mappersView } from "./mappers";
import { pulseView } from "./pulse";
import { logView, teamView } from "./staff";

// ---------------------------------------------------------------------------------------------
// Sections and their tabs

interface Tab {
  /** Route id: #/<id>. */
  id: string;
  label: string;
  /** Needed to open it. */
  perm: Permission;
  /** Also needed for it to show (the route itself stays open on `perm`): the role that works it. */
  rail?: Permission;
}

interface Section {
  id: string;
  label: string;
  key: string;
  glyph: string;
  tabs: Tab[];
}

// Moderators see Queue, Live (rooms, chat), Anticheat (cases), Players (search, names), Inbox (feedback) and Staff
// (the log): what src/moderation/staff.ts lets them act on.
const SECTIONS: Section[] = [
  { id: "queue", label: "Queue", key: "q", glyph: "queue", tabs: [{ id: "queue", label: "Queue", perm: "overview" }] },
  {
    id: "live",
    label: "Live",
    key: "l",
    glyph: "rooms",
    tabs: [
      { id: "rooms", label: "Rooms", perm: "rooms.read" },
      { id: "lobbies", label: "Lobbies", perm: "lobbies.read" },
      { id: "chat", label: "Chat log", perm: "chat.read" },
    ],
  },
  {
    id: "anticheat",
    label: "Anticheat",
    key: "a",
    glyph: "suspicious",
    tabs: [
      { id: "acboard", label: "Board", perm: "integrity.read" },
      { id: "suspicious", label: "Cases", perm: "integrity.read" },
      { id: "runs", label: "Runs", perm: "runs.read", rail: "runs.manage" },
      { id: "signals", label: "Signals", perm: "integrity.read", rail: "integrity.ban" },
    ],
  },
  {
    id: "players",
    label: "Players",
    key: "p",
    glyph: "players",
    tabs: [
      { id: "players", label: "Search", perm: "players.read" },
      { id: "names", label: "Names", perm: "names.read" },
      { id: "network", label: "Networks", perm: "players.network" },
    ],
  },
  {
    id: "inbox",
    label: "Inbox",
    key: "i",
    glyph: "feedback",
    tabs: [
      { id: "fbboard", label: "Board", perm: "feedback.read" },
      { id: "feedback", label: "Feedback", perm: "feedback.read" },
      { id: "announce", label: "Announcements", perm: "announce" },
    ],
  },
  {
    id: "boards",
    label: "Boards",
    key: "b",
    glyph: "records",
    tabs: [
      { id: "records", label: "Records", perm: "discord" },
      { id: "maps", label: "Maps and tiers", perm: "maps.read" },
      // (The API's /admin/gauntlets is admins and the owner, like maps.read.)
      { id: "gauntlets", label: "Gauntlets", perm: "maps.read" },
      { id: "mappers", label: "Mappers", perm: "player.marks" },
      { id: "supporters", label: "Supporters and badges", perm: "player.supporter" },
    ],
  },
  { id: "pulse", label: "Pulse", key: "u", glyph: "activity", tabs: [{ id: "overview", label: "Pulse", perm: "overview", rail: "runs.manage" }] },
  {
    id: "staff",
    label: "Staff",
    key: "s",
    glyph: "staff",
    tabs: [
      { id: "admins", label: "Team", perm: "staff.read" },
      { id: "log", label: "Moderation log", perm: "log.read" },
    ],
  },
];

const VIEWS: Record<string, View> = {
  queue: queueView,
  rooms: roomsView,
  lobbies: lobbiesView,
  chat: chatView,
  acboard: acBoardView,
  suspicious: casesView,
  runs: runsView,
  signals: signalsView,
  players: playersView,
  player: playerView,
  names: namesView,
  network: networkView,
  fbboard: reportBoardView,
  feedback: feedbackView,
  announce: announceView,
  records: recordsView2,
  maps: mapsView,
  gauntlets: gauntletsView,
  mappers: mappersView,
  supporters: supportersView,
  overview: pulseView,
  admins: teamView,
  log: logView,
};

/** The tab a route belongs to (a player page is the Players section's; a ticket is the Feedback tab's). */
const tabOf = (view: string) => (view === "player" ? "players" : view);
const sectionOf = (view: string) => SECTIONS.find((s) => s.tabs.some((t) => t.id === tabOf(view))) ?? SECTIONS[0];
const canOpen = (view: string) => {
  const t = SECTIONS.flatMap((s) => s.tabs).find((x) => x.id === tabOf(view));
  return !t || may(t.perm);
};
const inRail = (t: Tab) => may(t.perm) && (!t.rail || may(t.rail));
const railTabs = (s: Section) => s.tabs.filter(inRail);
const homeOf = (s: Section) => {
  const t = railTabs(s)[0];
  return t ? `#/${t.id}` : null;
};

// ---------------------------------------------------------------------------------------------
// The rail

let cleanup: (() => void) | void;
let palette: ReturnType<typeof installPalette> | null = null;
let badgeTimer = 0;

/** Slides the rail's raised marker to the active section (on a phone: under it, in the strip). */
function moveIndicator(animate: boolean): void {
  const tabs = $("tabs");
  const ind = tabs.querySelector<HTMLElement>(".nav-ind");
  const on = tabs.querySelector<HTMLElement>("a.on");
  if (!ind) return;
  if (!on) return void (ind.style.opacity = "0");
  if (!animate || !ind.style.opacity || ind.style.opacity === "0") ind.classList.add("snap");
  const r = on.getBoundingClientRect();
  const p = tabs.getBoundingClientRect();
  ind.style.opacity = "1";
  ind.style.transform = `translate(${r.left - p.left + tabs.scrollLeft}px, ${r.top - p.top + tabs.scrollTop}px)`;
  ind.style.width = `${r.width}px`;
  ind.style.height = `${r.height}px`;
  if (ind.classList.contains("snap")) requestAnimationFrame(() => requestAnimationFrame(() => ind.classList.remove("snap")));
  if (matchMedia("(max-width: 56rem)").matches) on.scrollIntoView({ block: "nearest", inline: "nearest", behavior: animate ? "smooth" : "auto" });
}

function paintRail(m: Me): void {
  const who = $("who");
  const name = m.token ? "Admin token" : m.name;
  const word = m.role ? ROLE_WORD[m.role] : "Signed in";
  document.body.dataset.role = m.token ? "" : (m.role ?? "");
  document.querySelector(".rail .rail-role")?.remove();
  if (!m.token && m.role) document.querySelector(".rail .wordmark")?.after(h("div", { class: "rail-role" }, staffShield(m.role), word));
  who.replaceChildren();
  append(who, [
    avatar({ name, avatar: m.token ? null : m.avatar }),
    h("span", { class: "who-name" }, h("b", null, name), h("span", { class: "who-sub" }, m.token ? "this tab only" : word)),
    m.token ? h("button", { class: "small ghost", onclick: () => (setToken(null), setMe(null), location.reload()) }, "Forget") : null,
  ]);
  // Back to the game: the desktop client has no address bar, and the wordmark doesn't read as a way out.
  if (!document.querySelector(".rail .back-game")) who.before(h("a", { class: "back-game", href: "/" }, glyph("back"), "Back to game"));
  // The staff handbook (/docs, apps/api/src/docs.ts): opens in its own tab, beside the panel.
  document.querySelector(".rail .handbook-link")?.remove();
  if (!m.token && may("docs.read")) $("who").parentElement!.querySelector(".back-game")?.before(h("a", { class: "back-game handbook-link", href: "/docs/", target: "_blank", rel: "noopener" }, glyph("handbook"), "Handbook"));
  const tabs = $("tabs");
  tabs.hidden = false;
  const links = SECTIONS.filter((s) => railTabs(s).length).map((s) =>
    h(
      "a",
      { href: homeOf(s)!, "data-section": s.id, class: "nav-link" },
      glyph(s.glyph),
      h("span", { class: "nav-text" }, s.label),
      s.id === "queue" ? h("span", { class: "tab-badge", id: "queue-badge", hidden: true }) : null,
      s.id === "inbox" ? h("span", { class: "tab-badge", id: "fb-badge", hidden: true }) : null,
      h("kbd", { class: "nav-key", "aria-hidden": "true" }, s.key),
    ),
  );
  // One raised marker for the rail that slides to the active section, and the landing dot that hops to it.
  tabs.replaceChildren(h("span", { class: "nav-ind", "aria-hidden": "true" }), ...links);
  tabs.classList.add("hop-host");
  hopIndicator(tabs, "a.nav-link", { axis: "y", selected: ".on", inset: 7 });
  const sb = $("search-btn");
  sb.replaceChildren(glyph("search"), h("span", null, "Search"), h("kbd", null, "/"));
  sb.hidden = false;
  sb.onclick = () => palette?.open();
}

// ---------------------------------------------------------------------------------------------
// Loading: a page shaped like the one that is coming (title, tabs, rows), still (no shimmer), with the hop arc drawing
// in it until the view arrives.

function skeleton(view: string, detail: boolean): HTMLElement {
  const i = (cls: string) => h("i", { class: cls });
  const rows = (k: number) => Array.from({ length: k }, () => h("div", { class: "sk-row" }, i("w1"), i("w2"), i("w3"), i("w4")));
  const kind = detail ? "detail" : view === "overview" ? "overview" : view === "suspicious" ? "split" : view === "acboard" || view === "fbboard" ? "board" : "table";
  return h(
    "div",
    { class: `skel-page sk-${kind}`, "aria-label": "Loading", role: "status" },
    h("div", { class: "sk-load" }, hopArc({ loop: true, size: 96 })),
    kind === "overview"
      ? [h("div", { class: "sk-figs" }, i("sk-fig"), i("sk-fig"), i("sk-fig"), i("sk-fig")), i("sk-chart")]
      : kind === "detail"
        ? [h("div", { class: "sk-figs" }, i("sk-fig"), i("sk-fig"), i("sk-fig")), h("div", { class: "sk-split" }, h("div", null, i("sk-block"), ...rows(4)), h("div", null, i("sk-block sm"), ...rows(3)))]
        : kind === "board"
          ? [h("div", { class: "sk-board" }, ...Array.from({ length: 4 }, (_, c) => h("div", null, i("sk-col"), ...Array.from({ length: 3 - (c % 2) }, () => i("sk-card")))))]
        : kind === "split"
          ? [h("div", { class: "sk-split rev" }, h("div", null, ...rows(8)), h("div", null, i("sk-block"), i("sk-block sm")))]
          : [i("sk-filters"), ...rows(9)],
  );
}

// ---------------------------------------------------------------------------------------------
// Auth

function showAuthPage(error?: string): void {
  cleanup?.();
  cleanup = undefined;
  setMe(null);
  $("tabs").hidden = true;
  $("search-btn").hidden = true;
  $("who").replaceChildren();
  document.querySelector(".rail .rail-role")?.remove();
  const input = h("input", { type: "password", placeholder: "ADMIN_TOKEN", autocomplete: "off", required: true });
  const mark = document.querySelector(".rail .wordmark")?.cloneNode(true) ?? null;
  $("app").replaceChildren(
    h(
      "section",
      { class: "auth" },
      mark,
      h("h1", null, "Staff only"),
      h("p", null, "Sign in on ", h("a", { href: "/" }, "bunnyhop.lol"), " with a staff account and reload, or paste the admin token."),
      error ? h("p", { class: "err" }, error) : null,
      h(
        "form",
        {
          onsubmit: (e: Event) => {
            e.preventDefault();
            setToken(input.value.trim());
            void start();
          },
        },
        input,
        h("button", { type: "submit", class: "primary" }, "Use token"),
      ),
      h("p", { class: "faint small" }, "The token stays in this tab and goes to /api/admin as a Bearer token."),
    ),
  );
  input.focus();
}

// ---------------------------------------------------------------------------------------------
// Boot

function install(): void {
  if (palette) return;
  palette = installPalette({
    tabs: () =>
      SECTIONS.flatMap((s) => {
        const tabs = railTabs(s);
        if (!tabs.length) return [];
        return [
          { id: s.id, label: s.label, icon: s.glyph, href: homeOf(s)!, key: s.key },
          ...(tabs.length > 1 ? tabs.map((t) => ({ id: t.id, label: `${s.label}: ${t.label}`, icon: s.glyph, href: `#/${t.id}` })) : []),
        ];
      }),
    api,
    base: (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "") || "/api",
    canOpen,
    goto: (key) => {
      const s = SECTIONS.find((x) => x.key === key);
      return s && GOTO_KEYS.includes(key) ? homeOf(s) : null;
    },
  });
  installPress();
  installDrawer();
  void loadMapIndex();
  // Rows that open something (tr.go[data-href]): a click anywhere on the row that isn't on a control or a link.
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest("tr.go, .row-go") as HTMLElement | null;
    if (!row || t.closest("a, button, input, select, textarea, summary, label, .id") || getSelection()?.toString()) return;
    const href = row.dataset.href;
    if (href) location.hash = href;
  });
  // The rail's layout can shift under the marker (fonts, a badge, a resize): it follows without sliding.
  new ResizeObserver(() => moveIndicator(false)).observe($("tabs"));
  window.addEventListener("hashchange", () => void route());
}

async function start(): Promise<void> {
  install();
  // Paint the rail and the route's skeleton at once from the last answer in this tab; /admin/me confirms it.
  const cached = token() || cachedMe() ? cachedMe() : null;
  if (cached) {
    setMe(cached);
    paintRail(cached);
    if (!location.hash) history.replaceState(null, "", "#/queue");
    // The route's own skeleton (its title and tabs, its shape) while /admin/me and the view load.
    const { view, rest } = markRoute();
    const detail = view === "player" || (view === "feedback" && rest.length > 0);
    $("app").replaceChildren(...[pageHead(view, detail), skeleton(view, detail)].filter((x): x is HTMLElement => !!x));
  }
  let fresh: Me;
  try {
    fresh = await api<Me>("/admin/me");
  } catch (e) {
    const hadToken = !!token();
    if (hadToken) setToken(null);
    return showAuthPage(e instanceof NotAdmin ? (hadToken ? "That token wasn't accepted." : undefined) : `Couldn't reach the API: ${(e as Error).message}`);
  }
  const same = cached && cached.id === fresh.id && cached.role === fresh.role && (cached.perms ?? []).join() === (fresh.perms ?? []).join();
  setMe(fresh);
  if (!same) paintRail(fresh);
  void refreshFeedbackBadge();
  void refreshQueueBadge();
  // Badges: once a minute while the tab is visible.
  badgeTimer ||= window.setInterval(() => {
    if (document.hidden) return;
    void refreshFeedbackBadge();
    void refreshQueueBadge();
  }, 60_000);
  if (!location.hash) history.replaceState(null, "", "#/queue");
  await route();
}

/** The rail and the tab strip for the current hash (before the view loads). */
function markRoute(): { view: string; rest: string[]; qs: string } {
  const [path, qs] = location.hash.replace(/^#\/?/, "").split("?");
  const [name, ...rest] = path.split("/").map(decodeURIComponent);
  const view = VIEWS[name] ? name : "queue";
  const sec = sectionOf(view);
  for (const a of $("tabs").querySelectorAll<HTMLAnchorElement>("a.nav-link")) {
    const on = a.dataset.section === sec.id;
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  moveIndicator(true);
  return { view, rest, qs: qs ?? "" };
}

/** The section's title and its tabs, above the view (detail pages bring their own heading). */
function pageHead(view: string, detail: boolean): HTMLElement | null {
  if (detail) return null;
  const sec = sectionOf(view);
  const tabs = railTabs(sec);
  const strip =
    tabs.length > 1 || (tabs.length === 1 && tabs[0].id !== view && !tabs.some((t) => t.id === tabOf(view)))
      ? h(
          "nav",
          { class: "subtabs hop-host", "aria-label": `${sec.label} tabs` },
          tabs.map((t) => h("a", { href: `#/${t.id}`, class: `subtab${t.id === tabOf(view) ? " on" : ""}`, "aria-current": t.id === tabOf(view) ? "page" : undefined }, t.label)),
        )
      : null;
  const head = h("header", { class: "page-head" }, h("h1", null, sec.label), strip);
  if (strip) requestAnimationFrame(() => strip.isConnected && hopIndicator(strip, "a.subtab", { axis: "x", selected: ".on", side: "end", inset: -6 }));
  return head;
}

let routeSeq = 0;

async function route(): Promise<void> {
  if (!me) return;
  const my = ++routeSeq;
  cleanup?.();
  cleanup = undefined;
  clearKeys();
  closeDrawer();
  closeMenu();
  const { view, rest, qs } = markRoute();
  const detail = view === "player" || (view === "feedback" && rest.length > 0);
  const root = $("app");
  if (!canOpen(view)) {
    root.replaceChildren(pageHead(view, false) ?? h("span"), h("section", { class: "state" }, h("h2", null, "Not for your role"), h("p", null, "Your role can't open this section.")));
    return;
  }
  // Loading: the first time (or from another section), a skeleton; within a section the old view stays, dimmed, and the
  // hop arc draws in the head until the new one replaces it, which then settles in once.
  const sameSection = root.dataset.section === sectionOf(view).id && !detail && root.dataset.detail !== "1";
  const body = h("div", { class: "view", id: "view" });
  if (sameSection && root.querySelector(":scope > .view")) {
    root.classList.add("busy");
    root.querySelector(":scope > .page-head")?.replaceWith(pageHead(view, detail) ?? h("span"));
  } else {
    root.replaceChildren(...[pageHead(view, detail), skeleton(view, detail)].filter((x): x is HTMLElement => !!x));
  }
  root.dataset.section = sectionOf(view).id;
  root.dataset.detail = detail ? "1" : "";
  document.title = `${detail ? (view === "player" ? "Player" : "Ticket") : sectionOf(view).label} · bunnyhop.lol admin`;
  root.classList.remove("enter");
  try {
    const c = await VIEWS[view](body, new URLSearchParams(qs), rest);
    if (my !== routeSeq) return void (typeof c === "function" && c());
    cleanup = c;
    root.replaceChildren(...[pageHead(view, detail), body].filter((x): x is HTMLElement => !!x));
    root.classList.add("enter");
    setTimeout(() => root.classList.remove("enter"), 420);
  } catch (e) {
    if (my !== routeSeq) return;
    if (e instanceof NotAdmin) return showAuthPage();
    const label = detail ? "this page" : (SECTIONS.flatMap((s) => s.tabs).find((t) => t.id === tabOf(view))?.label ?? "this");
    root.replaceChildren(
      ...[
        pageHead(view, detail),
        h(
          "section",
          { class: "state error" },
          h("h2", null, `${label.replace(/^./, (c) => c.toUpperCase())} didn't load`),
          h("p", null, "The server said:"),
          h("pre", { class: "err-raw" }, (e as Error).message),
          h("button", { class: "primary", onclick: () => void route() }, glyph("refresh"), "Try again"),
        ),
      ].filter((x): x is HTMLElement => !!x),
    );
  } finally {
    if (my === routeSeq) root.classList.remove("busy");
  }
}

setRouter(() => void route(), () => showAuthPage());
void start();
