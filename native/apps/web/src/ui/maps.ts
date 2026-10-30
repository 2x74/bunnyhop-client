// The map list (Play): one toolbar row (search, tier, a die, then set, sort and style as text menus), a list of every
// map with your status on each, and a panel for the selected map with its board (ui/map-board.ts) and Play. The
// tutorial sits at the top of the list (tutorial/learn.ts) unless the player hid it. A star by a map's name (and in its
// panel) makes it a favorite (ui/favorites.ts); "Favorites" in the set menu shows just those. Each set says how many of
// its maps you've done, and the menu ends with the set on show done per tier. The player's own groups
// (ui/map-groups.ts) follow it in the set menu; Groups by the panel's star adds the map to one, makes one, renames or
// deletes the group the list is showing, and plays the group (or Favorites) on show in order (map-queue.ts). The die
// picks one of the maps on the list (map-list.ts randomMap) and selects it.
//
// The style picked here is the style of everything on the page: the PBs and records in the list, the board in the
// panel (and the full leaderboard opened from it) and the run you start. Click or ↑ / ↓ selects; double-click or
// Enter plays. Rows are built once per page and reused (the list holds ~600 maps; the home screen builds them in idle
// time, prewarmMapRows): opening the list, filtering and sorting only re-order them, thumbnails load as rows near the
// view, and only the selected map's board is fetched.

import { api, type MapSummary } from "../api";
import { getPB, onPBChange } from "../pb";
import { formatTime } from "../timer";
import { fmtBytes, h } from "./dom";
import { mapArt, mapGallery, observeThumbs, registerMapImages } from "./thumbs";
import { clampTier, tierLabel, tierName, tierNum, TIERS, type Tier } from "../tiers";
import { CSGO_NOTE, isCsgo } from "../csgo";
import { zoneWarningNote } from "../zone-warning";
import { isStyleId, nextStyle, STYLE_DEFS, styleLabel, type StyleId } from "../styles";
import { selectedStyle, setSelectedStyle } from "./style-picker";
import { keyLabel, prefs } from "./settings";
import { landRows } from "./land";
import { mapUrl, shareButton } from "./share";
import { navigate } from "./nav";
import { openLeaderboardDialog } from "./leaderboard";
import { requestRace, requestRaceAfterReload } from "../player/race";
import { me } from "./account-state";
import { playedMaps } from "./stats";
import { mapBoard, preloadMapBoard, refitBoard } from "./map-board";
import { openTutorial, tutorialEnabled, tutorialPrompt, tutorialSub, TUTORIAL_MAP } from "../tutorial/entry";
import { matchesTutorial, tutorialArt, tutorialPanel } from "../tutorial/learn";
import { tutorialProgress } from "../tutorial/flag";
import { toast, whisper } from "../notify";
import { isFavorite, onFavoritesChange, setFavorite, syncFavorites } from "./favorites";
import { createGroup, deleteGroup, groupNameProblem, mapGroup, mapGroups, onMapGroupsChange, renameGroup, restoreGroup, setInGroup, syncMapGroups, type MapGroupView } from "./map-groups";
import { GROUP_NAME_MAX } from "../map-groups";
import { withMenu, type MenuItem } from "../social/menu";
import { textDialog } from "./settings-transfer";
import { icon } from "./icons";
import { firstMapOfTheDay } from "./first-map";
import { menuIdleAllowed } from "./menu-work";
import { doneByTier, listed, randomMap } from "../map-list";
import { readQueue, startQueue, stopQueue } from "../map-queue";
import { attemptsText, mapTime, playedText } from "../map-time";
import "./maps.css";


export interface MapEntry {
  sha256?: string;
  name: string;
  title?: string;
  author?: string | null;
  url?: string | null;
  size?: number | null;
  /** Grid card image: 480×270 in-engine render (tools/thumbs/render.ts), else a GameBanana screenshot. */
  thumbnail?: string | null;
  /** 1280×720 in-engine hero render. */
  hero?: string | null;
  /** Blurred placeholder (tiny WebP data URI). */
  lqip?: string | null;
  /** In-engine shots, hero first (hero panel gallery). */
  shots?: string[];
  /** GameBanana screenshots (gallery extras). */
  screenshots?: string[];
  /** GameBanana upload date (YYYY-MM-DD), not when the map came to bunnyhop.lol (MapSummary.added). */
  added?: string | null;
  /** maps/<name>.zones.json exists locally (not shown in the UI). */
  zones?: boolean;
  /** Community difficulty tier (raw upstream value; T7 and up show as T7+, tiers.ts; null = unrated). */
  tier?: number | null;
  /** Track count: number of tracks, or { main, bonus } counts. */
  tracks?: number | { main?: number; bonus?: number } | null;
  /** Start/end zones are known for this map (not shown in the UI). */
  zoned?: boolean;
  /** Curated collections (maps/index.json): "prestige", "iconic", "short", "modern", "halloween", "csgo", … */
  collections?: string[];
  /** "csgo": a CS:GO build of the map (research/CSGO-MAPS.md); absent = CS:S. A label only: it still plays in CS:S movement. */
  game?: string;
  /** Short label when the zones are unconfirmed or incomplete (zone-warning.ts, tools/zones/zone-warning.ts); absent = fine. */
  zoneWarning?: string;
}

/** The small "CS:GO" label for a CS:GO map; null for a CS:S one. */
export function csgoTag(m: { game?: string } | null | undefined): HTMLElement | null {
  return isCsgo(m) ? h("span.mb-csgo", { title: CSGO_NOTE }, "CS:GO") : null;
}

function bonusCount(m: MapEntry): number {
  const t = m.tracks;
  if (t === null || t === undefined) return 0;
  if (typeof t === "number") return Math.max(0, t - 1);
  return t.bonus ?? 0;
}

let indexCache: Promise<MapEntry[]> | null = null;
export function fetchMapIndex(): Promise<MapEntry[]> {
  if (!indexCache) {
    indexCache = (async () => {
      try {
        const res = await fetch("/index.json");
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return [];
        const j = await res.json();
        const maps = Array.isArray(j.maps) ? (j.maps as MapEntry[]) : [];
        registerMapImages(maps);
        return maps;
      } catch {
        return [];
      }
    })();
  }
  return indexCache;
}

const onlineCache = new Map<string, Promise<Map<string, MapSummary> | null>>();
/** api.maps(style) keyed by name (WR is per style); null when offline. Cached per style for the page lifetime. */
export function onlineMaps(style = "autohop"): Promise<Map<string, MapSummary> | null> {
  let p = onlineCache.get(style);
  if (!p) {
    p = api.available()
      ? api.maps(style).then((ms) => new Map(ms.map((m) => [m.name, m])), () => null)
      : Promise.resolve(null);
    onlineCache.set(style, p);
  }
  return p;
}

export function tierOf(m: MapEntry, online?: MapSummary | null): number | null {
  return clampTier(online?.tier ?? m.tier ?? null);
}

/** Tier pill (T1–T6, T7+; "T?" = unrated, unranked for points). `long` adds the tier name ("T5 · Very hard"). */
export function tierBadge(tier: number | null, o: { long?: boolean } = {}): HTMLElement {
  const t = clampTier(tier);
  return h(
    `span.badge.tier${t ? `.t${t}` : ".tx"}`,
    { title: t ? `Tier ${tierNum(t)} · ${tierName(t)}` : "Unrated: no tier yet, so no rank points" },
    tierLabel(t),
    o.long ? h("span.tier-name", null, ` · ${tierName(t)}`) : null,
  );
}

/** Tier of a map from the index / API (null = unrated). Cached; used by the HUD and loading screen. */
export async function mapTier(name: string): Promise<number | null> {
  const [maps, online] = await Promise.all([fetchMapIndex(), onlineMaps()]);
  return clampTier(online?.get(name)?.tier ?? maps.find((m) => m.name === name)?.tier ?? null);
}

// ---------------------------------------------------------------------------------------------
// The list

type TierFilter = "all" | `${Tier}` | "x";
const TIER_FILTERS: TierFilter[] = ["all", ...TIERS.map((t) => String(t) as TierFilter), "x"];
type Sort = "popular" | "tier" | "newest" | "name" | "unplayed" | "unfinished";
const SORTS: [Sort, string][] = [
  ["popular", "Popular"],
  ["tier", "Easiest first"],
  ["newest", "Newest"],
  ["name", "Name"],
  ["unplayed", "Not played yet"],
  ["unfinished", "Unfinished"],
];
const LAST_FILTER = "bunnyhop:mapbrowser";
/** Collections in the set menu (others in index.json, e.g. research candidates, stay hidden). */
const COLLECTIONS: [id: string, label: string][] = [
  ["prestige", "Prestige classics"],
  ["iconic", "Iconic"],
  ["short", "Short"],
  ["modern", "Modern"],
  ["halloween", "Halloween"],
  ["csgo", "CS:GO maps"],
  ["new", "New maps"],
];
/** The set menu's own entry: the player's starred maps. */
const FAVORITES = "favorites";
/** The set menu's value for one of the player's groups: this + the group's id. */
const GROUP = "group:";
const groupOf = (collection: string): MapGroupView | null => (collection.startsWith(GROUP) ? mapGroup(collection.slice(GROUP.length)) : null);
/** Debounce for keyboard selection: the panel (hero image, board request) follows once you stop on a map. */
const SETTLE_MS = 140;

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.matches("input, textarea, select") || t.isContentEditable);

/**
 * The map's paged leaderboard in a dialog. Race loads the map (or resumes it) with that run as the ghost; from a game
 * on another map the request survives the page load (player/race.ts). Its style switch is the page's style.
 */
function boardDialog(m: MapEntry, style: string, playing: string | null, onPick: (n: string) => void, onStyle: (id: StyleId) => void): void {
  openLeaderboardDialog(m.name, style, {
    tracks: [0, ...Array.from({ length: bonusCount(m) }, (_, i) => i + 1)],
    onStyle,
    onRace: (e, track) => {
      const req = { kind: "run" as const, runId: e.runId, name: `#${e.rank} · ${e.player.name}`, track, time: e.time };
      document.querySelector<HTMLDialogElement>("dialog.rb-dialog[open]")?.close();
      if (playing && playing !== m.name) requestRaceAfterReload(req);
      else requestRace(req);
      onPick(m.name);
    },
  });
}

/**
 * On narrow screens the selected map's panel covers the list: the screen's Back (menu.ts) and Esc close it first,
 * back on the map's row. False when it wasn't open.
 */
export function closeMapPanel(browser: HTMLElement): boolean {
  if (!browser.classList.contains("show-detail")) return false;
  browser.classList.remove("show-detail");
  browser.querySelector<HTMLElement>('.mb-row[aria-selected="true"]')?.focus();
  return true;
}

// ---- rows (shared by every map list on the page: built once, re-painted per list and style)

const rowCache = new Map<string, HTMLElement>();
let browserSeq = 0;

function rowShell(name: string, art: HTMLElement, title: string, sub: string, star = false): HTMLElement {
  const r = h(
    "div.mb-row",
    { role: "option", "data-name": name, tabindex: "-1", "aria-selected": "false" },
    art,
    // (The row's star is for the mouse: rows are options, so the keyboard stars from the panel, one Tab past Play.)
    h("span.mb-name", null, h("span.mb-title", null, h("b", null, title), star ? h("button.mb-star", { type: "button", tabindex: "-1" }, icon("star")) : null), h("small", null, sub)),
    h("span.mb-c-tier"),
    h("span.mb-c-pb"),
    h("span.mb-c-wr"),
  );
  rowCache.set(name, r);
  return r;
}

function mapRow(m: MapEntry, fallbackThumb: string | null = null): HTMLElement {
  const hit = rowCache.get(m.name);
  if (hit) return hit;
  const bonus = bonusCount(m);
  const by = m.author?.trim() && !/^(unknown|none)$/i.test(m.author.trim()) ? `by ${m.author.trim()}` : "Unknown author";
  const r = rowShell(m.name, mapArt(m.name, m.thumbnail ?? fallbackThumb, { className: "mb-thumb" }), m.name, bonus ? `${by}, ${bonus} bonus${bonus > 1 ? "es" : ""}` : by, true);
  if (bonus) r.querySelector(".mb-name small")!.setAttribute("title", "Bonus tracks are timed and ranked separately, always in Normal style");
  const tag = csgoTag(m);
  if (tag) r.querySelector(".mb-title b")!.after(tag);
  return r;
}

/** Linked mapper names (api.mappers), lowercased author -> player; null until read. Failing leaves the names as plain text. */
let mapperLinks: Record<string, { author: string; id: string; name: string }> | null = null;
let mapperRead: Promise<void> | null = null;

/** The author in a map's meta line: a link to the player's profile when staff linked the name (src/mappers.ts). */
function authorSpan(author: string): HTMLElement {
  const name = author.trim();
  const el = h("span.mbd-by", { "data-key": name.toLowerCase() }, `by ${name}`);
  linkAuthor(el);
  return el;
}

function linkAuthor(el: HTMLElement): void {
  const l = mapperLinks?.[el.dataset.key ?? ""];
  if (!l || el.querySelector("a")) return;
  const name = el.textContent!.replace(/^by /, "");
  el.replaceChildren("by ", h("a.mbd-by-link", { href: `/u/${encodeURIComponent(l.id)}`, title: `${l.name}'s profile`, onclick: (ev: Event) => {
    const e = ev as MouseEvent;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button) return;
    e.preventDefault();
    navigate({ screen: "profile", id: l.id });
  } }, name));
}

/** Reads the links once, then turns every author already on screen into a link. */
function readMapperLinks(): void {
  if (!api.available() || mapperRead) return;
  mapperRead = api.mappers().then(
    (m) => {
      mapperLinks = m;
      for (const el of document.querySelectorAll<HTMLElement>(".mbd-by")) linkAuthor(el);
    },
    () => void (mapperRead = null),
  );
}

let prewarming = false;
/**
 * Builds the list's rows ahead, a few dozen per idle callback (the home screen, once the index is in), so opening the
 * list doesn't build ~600 rows inside the click.
 */
export function prewarmMapRows(maps: MapEntry[]): void {
  if (prewarming) return;
  prewarming = true;
  const queue = maps.filter((m) => !rowCache.has(m.name));
  const ric = (fn: (d?: IdleDeadline) => void) => ("requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 1000 }) : setTimeout(fn, 50));
  const step = (d?: IdleDeadline) => {
    if (!menuIdleAllowed()) {
      prewarming = false;
      return;
    }
    const t0 = performance.now();
    while (queue.length && (d && !d.didTimeout ? d.timeRemaining() > 2 : performance.now() - t0 < 6)) mapRow(queue.shift()!);
    if (queue.length) ric(step);
    else prewarming = false;
  };
  ric(step);
}

/** `focus`: map to select first (a /maps/<name> link, the home screen's Tutorial link); the filters open on "all". */
export function mapBrowser(o: { current: string | null; focus?: string | null; style: string; onPick: (name: string) => void; gauntlets?: (() => void) | null }): HTMLElement {
  const seq = ++browserSeq;
  readMapperLinks();
  let saved: { sort?: string; tier?: string; collection?: string } = {};
  try {
    saved = JSON.parse(localStorage.getItem(LAST_FILTER) ?? "{}") ?? {};
  } catch {
    /* corrupt: defaults */
  }
  if (o.focus) Object.assign(saved, { tier: "all", collection: "all" });
  let sort: Sort = SORTS.some(([s]) => s === saved.sort) ? (saved.sort as Sort) : "tier";
  let tierFilter: TierFilter = TIER_FILTERS.includes(saved.tier as TierFilter) ? (saved.tier as TierFilter) : "all";
  let collection =
    saved.collection === FAVORITES || COLLECTIONS.some(([id]) => id === saved.collection) || (saved.collection && groupOf(saved.collection)) ? saved.collection! : "all";
  let query = "";
  let style: StyleId = isStyleId(o.style) ? o.style : selectedStyle();

  let maps: MapEntry[] = [];
  const byName = new Map<string, MapEntry>();
  let online: Map<string, MapSummary> | null = null;
  let played = playedMaps();
  let myId: string | null = null;
  let selected: string | null = null;
  /** Rows built once per map (and the tutorial's), reused by every filter / sort, and by the next list opened. */
  const rows = rowCache;
  let visible: string[] = [];

  // ---- toolbar
  const search = h("input.mb-q", { type: "search", placeholder: "Search maps or authors", "aria-label": "Search maps", spellcheck: "false", autocomplete: "off" });
  const qCount = h("span.mb-q-count", { "aria-live": "polite" });
  const searchWrap = h("label.mb-search", null, h("span.mb-q-icon", { "aria-hidden": "true" }, "⌕"), search, qCount, h("kbd.mb-q-kbd", { "aria-hidden": "true" }, "/"));
  const tiers = h("div.seg.mb-tiers", { role: "radiogroup", "aria-label": "Tier" });
  const setSel = h("select.mb-set", { "aria-label": "Map set" });
  const die = h("button.mb-random", { type: "button", title: "Random map", "aria-label": "Random map", onclick: () => pickRandom() }, icon("die"));
  const sortSel = h("select.mb-sort", { "aria-label": "Sort" }, ...SORTS.map(([v, l]) => h("option", { value: v }, l)));
  sortSel.value = sort;
  const cycleKey = () => prefs.get().binds.cycleStyle?.[0] ?? null;
  // The style: a text menu like the set and the sort (it's picked once a session; its rule is the option's tooltip).
  const styleSel = h(
    "select.mb-stylesel",
    { "aria-label": "Style", title: cycleKey() ? `Style (${keyLabel(cycleKey()!)} switches)` : "Style" },
    ...STYLE_DEFS.map((d) => h("option", { value: d.id, title: d.rule }, d.name)),
  ) as HTMLSelectElement;
  styleSel.value = style;
  styleSel.addEventListener("change", () => applyStyle(styleSel.value as StyleId));
  const sw = { set: (id: StyleId) => (styleSel.value = id) };

  const list = h("div.mb-list", { role: "listbox", "aria-label": "Maps", tabindex: "-1" });
  const empty = h("p.mb-empty", { hidden: true });
  const detail = h("aside.mb-detail", { "aria-live": "polite", "aria-label": "Selected map" });
  const head = h(
    "div.mb-head",
    { "aria-hidden": "true" },
    h("span", null, "Map"),
    h("span.mb-c-tier", null, "Tier"),
    h("span.mb-c-pb", null, "Your PB"),
    h("span.mb-c-wr", null, "Record"),
  );
  const root = h(
    "div.map-browser",
    null,
    h(
      "div.mb-bar",
      null,
      searchWrap,
      tiers,
      h("div.mb-menus", null, die, setSel, sortSel, styleSel),
      // Gauntlets (ui/gauntlets.ts): fixed lists of maps run in one go.
      o.gauntlets ? h("button.link-btn.mb-gauntlets", { type: "button", onclick: o.gauntlets }, "Gauntlets", icon("chevronRight")) : null,
    ),
    h("div.mb-body", null, h("div.mb-col", null, head, list, empty), h("div.mb-detail-wrap", null, detail)),
  );

  const persist = () => {
    try {
      localStorage.setItem(LAST_FILTER, JSON.stringify({ sort, tier: tierFilter, collection }));
    } catch {
      /* private mode */
    }
  };
  const tierKey = (m: MapEntry): TierFilter => String(tierOf(m, online?.get(m.name)) ?? "x") as TierFilter;
  const ranked = (name: string): boolean | null => (online ? (online.get(name)?.ranked ?? false) : null);

  // ---- rows
  function tutorialRow(): HTMLElement {
    return rows.get(TUTORIAL_MAP) ?? rowShell(TUTORIAL_MAP, tutorialArt("mb-thumb"), "Tutorial", "Learn to bhop");
  }
  /** Status cells for the selected style. */
  function paint(name: string): void {
    if (seq !== browserSeq) return;
    const r = rows.get(name);
    if (!r) return;
    const [tierCell, pbCell, wrCell] = [r.querySelector<HTMLElement>(".mb-c-tier")!, r.querySelector<HTMLElement>(".mb-c-pb")!, r.querySelector<HTMLElement>(".mb-c-wr")!];
    if (name === TUTORIAL_MAP) {
      const p = tutorialProgress();
      r.querySelector(".mb-name small")!.textContent = p.finished ? "Learn to bhop" : tutorialSub();
      pbCell.replaceChildren(p.finished && p.best !== undefined ? h("b", { title: "Your best on the final course" }, `${p.best.toFixed(2)} s`) : "");
      return;
    }
    paintStar(r.querySelector(".mb-star"), name);
    const m = byName.get(name);
    const sum = online?.get(name);
    const t = m ? clampTier(tierOf(m, sum)) : null;
    tierCell.className = `mb-c-tier ${t ? `t${t}` : "tx"}`;
    tierCell.textContent = tierLabel(t);
    tierCell.title = t ? `Tier ${tierNum(t)}, ${tierName(t)}` : "Unrated: no rank points";
    const pb = getPB(name, style);
    const wrMine = !!(myId && sum?.wr?.id === myId);
    // (Your record set on another device has no PB in this browser: the record is your time.)
    const time = pb?.time ?? (wrMine ? sum!.wr!.time : null);
    pbCell.replaceChildren(
      time !== null
        ? h("b", { title: `Your ${styleLabel(style)} PB${wrMine ? ", the world record" : ""}` }, wrMine ? h("span.mb-wr-mark", null, "WR") : null, formatTime(time))
        : played.has(name)
          ? h("small", { title: `Played, no ${styleLabel(style)} finish yet` }, "Played")
          : "",
    );
    if (!online) wrCell.replaceChildren();
    else if (!sum?.ranked) wrCell.replaceChildren(h("small", { title: "Runs on this map aren't submitted" }, "Unranked"));
    else wrCell.replaceChildren(sum.wr ? h("span", { title: `World record by ${sum.wr.player}` }, formatTime(sum.wr.time)) : h("small", { title: "No record yet" }, "—"));
  }

  /** A star (a row's or the panel's) showing whether `name` is a favorite. */
  function paintStar(b: HTMLElement | null, name: string): void {
    if (!b) return;
    const on = isFavorite(name);
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    b.title = on ? "Remove from favorites" : "Add to favorites";
    b.setAttribute("aria-label", b.title);
  }
  function toggleFavorite(name: string): void {
    setFavorite(name, !isFavorite(name));
  }

  // ---- groups (the panel's Groups menu)
  function groupItems(name: string, btn: HTMLElement): MenuItem[] {
    const shown = groupOf(collection);
    const queue = readQueue();
    // In order: the group or Favorites on show, from this map; a queue started here stops here.
    const orderable = collection === FAVORITES ? "Favorites" : shown ? `“${shown.name}”` : null;
    return [
      ...mapGroups().map((g): MenuItem => {
        const on = g.maps.has(name);
        return { label: g.name, checked: on, run: () => void (setInGroup(g.id, name, !on) && whisper(on ? `Removed from ${g.name}` : `Added to ${g.name}`, { at: btn })) };
      }),
      { label: "New group…", run: () => newGroup(name, btn) },
      queue?.set === collection
        ? { label: `Stop playing ${orderable ?? `“${queue.name}”`} in order`, run: () => stopInOrder() }
        : orderable ? { label: `Play ${orderable} in order`, run: () => playInOrder(name) } : null,
      shown && { label: `Rename “${shown.name}”…`, run: () => renameShown(shown) },
      shown && { label: `Delete “${shown.name}”`, tone: "bad", run: () => deleteShown(shown) },
    ];
  }
  /** Plays the set on show in the list's order (not the search or tier: the whole set), from `from` to its last map. */
  function playInOrder(from: string): void {
    const name = collection === FAVORITES ? "Favorites" : (groupOf(collection)?.name ?? "");
    const q = startQueue(collection, name, sorted(maps.filter((m) => inSet(m.name))).map((m) => m.name), from);
    if (q) play(q.maps[q.at]);
  }
  function stopInOrder(): void {
    stopQueue();
    whisper("Stopped playing in order");
  }
  async function newGroup(name: string, btn: HTMLElement): Promise<void> {
    const raw = await textDialog({ title: "New group", label: "Group name", confirm: "Create", maxLength: GROUP_NAME_MAX, problem: (t) => groupNameProblem(t) });
    if (raw === null) return;
    const id = createGroup(raw, [name]);
    if (id) whisper(`Added to ${mapGroup(id)!.name}`, { at: btn.isConnected ? btn : null });
  }
  async function renameShown(g: MapGroupView): Promise<void> {
    const raw = await textDialog({ title: "Rename group", label: "Group name", confirm: "Rename", value: g.name, maxLength: GROUP_NAME_MAX, problem: (t) => groupNameProblem(t, g.id) });
    if (raw !== null) renameGroup(g.id, raw);
  }
  function deleteShown(g: MapGroupView): void {
    const was = deleteGroup(g.id);
    if (!was) return;
    toast(`Deleted ${was.name}.`, {
      action: {
        label: "Undo",
        run: () => {
          restoreGroup(was);
          collection = GROUP + was.id;
          render();
        },
      },
    });
  }

  // ---- filters
  function renderTiers(): void {
    const hadFocus = tiers.contains(document.activeElement);
    const counts = new Map<TierFilter, number>();
    for (const m of maps) counts.set(tierKey(m), (counts.get(tierKey(m)) ?? 0) + 1);
    tiers.replaceChildren(
      ...TIER_FILTERS.filter((t) => t === "all" || counts.get(t)).map((t) => {
        const on = t === tierFilter;
        return h(
          `button.mb-tier${t === "all" ? "" : `.t${t}`}${on ? ".on" : ""}`,
          {
            type: "button",
            role: "radio",
            "aria-checked": String(on),
            title: t === "all" ? "Every tier" : t === "x" ? `Unrated (${counts.get(t)} maps)` : `Tier ${tierNum(Number(t))}, ${tierName(Number(t))} (${counts.get(t)} maps)`,
            onclick: () => ((tierFilter = t), refilter()),
          },
          t === "all" ? "All" : t === "x" ? "?" : tierNum(Number(t)),
        );
      }),
    );
    if (hadFocus) tiers.querySelector<HTMLElement>(".on")?.focus();
  }
  function renderSets(): void {
    const present = COLLECTIONS.filter(([id]) => maps.some((m) => m.collections?.includes(id)));
    const isDone = (name: string) => !!getPB(name, style);
    const done = (label: string, inSet: MapEntry[]) => `${label}, ${inSet.filter((m) => isDone(m.name)).length} of ${inSet.length} done`;
    const favs = maps.filter((m) => isFavorite(m.name));
    // The set on show, tier by tier (disabled lines: read, not picked).
    const group = groupOf(collection);
    const setName = collection === "all" ? "All maps" : collection === FAVORITES ? "Favorites" : (group?.name ?? COLLECTIONS.find(([id]) => id === collection)?.[1] ?? "");
    const onShow = maps.filter((m) => inSet(m.name));
    const tierLines = doneByTier(
      onShow.map((m) => m.name),
      (n) => tierKey(byName.get(n)!),
      isDone,
    ).map((t) => h("option", { disabled: true, value: `tier:${t.tier}` }, `${t.tier === "x" ? "T?" : tierLabel(Number(t.tier))} · ${t.done} of ${t.total}`));
    setSel.replaceChildren(
      h("option", { value: "all" }, "All maps"),
      h("option", { value: FAVORITES }, favs.length ? done("Favorites", favs) : "Favorites"),
      ...mapGroups().map((g) => {
        const inSet = maps.filter((m) => g.maps.has(m.name));
        return h("option", { value: GROUP + g.id }, inSet.length ? done(g.name, inSet) : g.name);
      }),
      ...present.map(([id, label]) => h("option", { value: id, title: id === "csgo" ? CSGO_NOTE : null }, done(label, maps.filter((m) => m.collections?.includes(id))))),
      ...(tierLines.length ? [h("optgroup", { label: `${setName} by tier` }, ...tierLines)] : []),
    );
    setSel.value = collection;
  }

  const popularity = (m: MapEntry) => online?.get(m.name)?.runners ?? 0;
  const byTier = (a: MapEntry, b: MapEntry) => (tierOf(a, online?.get(a.name)) ?? 99) - (tierOf(b, online?.get(b.name)) ?? 99) || a.name.localeCompare(b.name);
  const unfinished = (m: MapEntry) => played.has(m.name) && !getPB(m.name, style);
  /** When the map came to the site (maps come in batches: within one, A to Z). */
  const addedAt = (m: MapEntry) => online?.get(m.name)?.added ?? 0;

  /** The map is in the set on show (all maps, Favorites, a group or a collection). */
  function inSet(name: string): boolean {
    const group = groupOf(collection);
    return collection === FAVORITES ? isFavorite(name) : group ? group.maps.has(name) : collection === "all" || !!byName.get(name)?.collections?.includes(collection);
  }
  /** Maps in the list's sort order (sorted in place). */
  function sorted(list: MapEntry[]): MapEntry[] {
    return list.sort((a, b) => {
      if (sort === "popular") return popularity(b) - popularity(a) || byTier(a, b);
      if (sort === "newest") return addedAt(b) - addedAt(a) || a.name.localeCompare(b.name);
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "unplayed") return Number(played.has(a.name)) - Number(played.has(b.name)) || byTier(a, b);
      if (sort === "unfinished") return Number(unfinished(b)) - Number(unfinished(a)) || byTier(a, b);
      return byTier(a, b);
    });
  }

  let landed = false;
  function render(): void {
    // A previous list's slower API/style request must not take the shared rows out of the current list.
    if (seq !== browserSeq) return;
    // The group on show was deleted (here, or on another device): back to every map.
    if (collection.startsWith(GROUP) && !groupOf(collection)) collection = "all";
    const group = groupOf(collection);
    persist();
    renderTiers();
    renderSets();
    const q = query.toLowerCase().trim();
    const shown = sorted(maps.filter((m) => listed(m, { q, tier: tierFilter, inSet, tierKey: (n) => tierKey(byName.get(n)!) })));
    // The tutorial: pinned first while it's on the list; hidden, a search still finds it (and so does its own link).
    const tut = tutorialEnabled() && (q ? matchesTutorial(q) : tutorialPrompt() || selected === TUTORIAL_MAP);
    visible = [...(tut ? [TUTORIAL_MAP] : []), ...shown.map((m) => m.name)];
    const els = visible.map((n) => rows.get(n) ?? (n === TUTORIAL_MAP ? tutorialRow() : mapRow(byName.get(n)!, online?.get(n)?.thumbnailUrl ?? null)));
    for (const n of visible) paint(n);
    list.replaceChildren(...els);
    // The first real paint lands row by row (only rows near the top are seen: the rest are capped at the last delay).
    if (!landed) (landed = true), landRows(els.slice(0, 14));
    rows.get(TUTORIAL_MAP)?.classList.toggle("pinned", tut && !q);
    observeThumbs(list);
    qCount.textContent = q || tierFilter !== "all" || collection !== "all" ? `${shown.length} of ${maps.length}` : "";
    search.placeholder = maps.length ? `Search ${maps.length} maps or authors` : "Search maps or authors";
    // (No favorites yet is said even under the pinned tutorial: the list would look like the filter did nothing.)
    const noFavorites = maps.length > 0 && collection === FAVORITES && !maps.some((m) => isFavorite(m.name));
    const emptyGroup = maps.length > 0 && !!group && !maps.some((m) => group.maps.has(m.name));
    empty.hidden = visible.length > 0 && !noFavorites && !emptyGroup;
    empty.textContent = !maps.length
      ? "No maps found. Run tools/scripts/gen-map-index.ts to build maps/index.json."
      : noFavorites
        ? "No favorites yet. Star a map to add it."
        : emptyGroup
          ? "No maps in this group yet. Add one with Groups, next to the star. "
          : "No maps match. Try another search, tier or set.";
    // (An empty group has no map panel to reach its Groups menu from, so its delete is here.)
    if (emptyGroup) empty.append(h("button.link-btn", { type: "button", onclick: () => deleteShown(group) }, "Delete group"));
    if (!selected || !visible.includes(selected)) select(visible.find((n) => n !== TUTORIAL_MAP) ?? visible[0] ?? null, { scroll: false });
    else markSelected();
  }

  /**
   * render() for a new set, tier or style: the selected map (the one you're playing, unless you picked another)
   * stays in the middle of the list while it's still on it, else the list starts at the top.
   */
  function refilter(): void {
    render();
    centerOn(selected ? (rows.get(selected) ?? null) : null);
  }
  /**
   * Puts a row in the middle of the list (no row: the top). Rows off screen have an estimated height until they're
   * drawn (content-visibility), so the rows that come into view move it: it's put back for a few frames, unless the
   * list was scrolled or another map selected meanwhile.
   */
  function centerOn(r: HTMLElement | null, frames = 4): void {
    if (r?.parentElement !== list) return void (list.scrollTop = 0);
    list.scrollTop = Math.max(0, r.offsetTop - list.offsetTop - list.clientHeight / 2 + r.offsetHeight / 2);
    const at = list.scrollTop;
    if (frames) requestAnimationFrame(() => list.scrollTop === at && selected === r.dataset.name && centerOn(r, frames - 1));
  }

  // ---- selection + the panel
  let settle = 0;
  let shownDetail: string | null = null;
  function markSelected(): void {
    for (const r of list.children) {
      const on = (r as HTMLElement).dataset.name === selected;
      r.setAttribute("aria-selected", String(on));
      (r as HTMLElement).tabIndex = on ? 0 : -1;
    }
  }
  function select(name: string | null, o2: { focus?: boolean; scroll?: boolean; now?: boolean } = {}): void {
    selected = name;
    markSelected();
    const r = name ? rows.get(name) : null;
    if (r && o2.focus) r.focus({ preventScroll: true });
    if (r && o2.scroll !== false) r.scrollIntoView({ block: "nearest" });
    clearTimeout(settle);
    if (o2.now) showDetail();
    else settle = window.setTimeout(showDetail, SETTLE_MS);
  }
  /** The die: a map from the list, selected like a click (in the middle of the list, its panel open). */
  function pickRandom(): void {
    const name = randomMap(visible.filter((n) => n !== TUTORIAL_MAP), selected);
    if (!name) return;
    select(name, { focus: true, now: true, scroll: false });
    centerOn(rows.get(name) ?? null);
    if (matchMedia("(max-width: 52rem)").matches) root.classList.add("show-detail");
  }
  function play(name: string | null): void {
    if (!name) return;
    if (name === TUTORIAL_MAP) openTutorial(o.onPick);
    else o.onPick(name);
  }
  function showDetail(force = false): void {
    if (!selected || (selected === shownDetail && !force)) return;
    shownDetail = selected;
    const focusIn = detail.contains(document.activeElement) ? (document.activeElement as HTMLElement).className : null;
    if (selected === TUTORIAL_MAP) {
      detail.replaceChildren(
        tutorialPanel({
          pick: o.onPick,
          onHidden: (hidden) => {
            if (!hidden) return (render(), showDetail(true), detail.querySelector<HTMLElement>(".tut-hide")?.focus({ preventScroll: true }));
            // Gone from the list: the first map takes its place, and the toast says where the tutorial went.
            toast("Tutorial hidden. It's under Tutorial on the home screen.");
            selected = null;
            render();
            showDetail();
            (selected ? rows.get(selected) : null)?.focus({ preventScroll: true });
          },
        }),
      );
    } else {
      const m = byName.get(selected);
      if (!m) return;
      const old = detail.querySelector<HTMLElement>(".mbd-inner:not(.skeleton) > .mbd-art");
      detail.replaceChildren(mapPanel(m));
      fadeOut(old);
    }
    if (focusIn) detail.querySelector<HTMLElement>(`.${focusIn.split(" ")[0]}`)?.focus({ preventScroll: true });
  }
  /** The previous map's picture stays on top for 140 ms and fades out over the new one (opacity only). */
  function fadeOut(old: HTMLElement | null): void {
    if (!old || matchMedia("(prefers-reduced-motion: reduce)").matches || document.body.classList.contains("potato")) return;
    const art = detail.querySelector<HTMLElement>(".mbd-inner > .mbd-art");
    if (!art) return;
    old.classList.add("mbd-art-old");
    art.after(old);
    old.addEventListener("animationend", () => old.remove(), { once: true });
  }
  function mapPanel(m: MapEntry): HTMLElement {
    const sum = online?.get(m.name);
    const t = tierOf(m, sum);
    const bonus = bonusCount(m);
    const isRanked = ranked(m.name);
    const current = m.name === o.current;
    // Yours on this device (map-time.ts).
    const onMap = mapTime.get(m.name);
    const meta = h(
      "p.mbd-meta",
      null,
      h(`span.mbd-tier.${t ? `t${t}` : "tx"}`, { title: t ? tierName(t) : "Unrated: no rank points" }, t ? `Tier ${tierNum(t)}, ${tierName(t)}` : "Unrated"),
      csgoTag(m),
      m.zoneWarning ? h("span.mbd-zone-warn", { title: zoneWarningNote(m.zoneWarning) }, m.zoneWarning) : null,
      m.author?.trim() ? authorSpan(m.author) : h("span", null, "Unknown author"),
      bonus ? h("span", { title: "Bonus tracks are timed and ranked separately, always in Normal style" }, `${bonus} bonus track${bonus > 1 ? "s" : ""}`) : null,
      m.size && m.size > 48 << 20 ? h("span", { title: "Download size" }, fmtBytes(m.size)) : null,
      sum?.added ? h("span", null, `Added ${new Date(sum.added).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`) : null,
      onMap.attempts ? h("span", null, attemptsText(onMap.attempts)) : null,
      onMap.seconds >= 60 ? h("span", null, `${playedText(onMap.seconds)} played`) : null,
    );
    const playBtn = h("button.btn.primary.mbd-play", { type: "button", onclick: () => play(m.name) }, current ? "Resume" : "Play");
    const star = h("button.btn.mbd-star", { type: "button", onclick: () => toggleFavorite(m.name) }, icon("star"));
    paintStar(star, m.name);
    const groups: HTMLButtonElement = h("button.btn.mbd-groups", { type: "button" }, "Groups");
    withMenu(groups, () => groupItems(m.name, groups), { label: "Groups" });
    const share = shareButton("btn mbd-share", () => ({ url: mapUrl(m.name), title: `${m.name} · bunnyhop.lol`, text: `${m.name} on bunnyhop.lol` }), `Link to ${m.name} copied`);
    return h(
      "div.mbd-inner",
      { "data-name": m.name },
      mapGallery(m.name, m.hero ?? m.thumbnail ?? sum?.thumbnailUrl ?? null, { className: "mbd-art" }),
      h(
        "div.mbd-main",
        null,
        h("header.mbd-title", null, h("h3", { title: m.name }, m.name), meta),
        mapBoard({
          map: m.name,
          style,
          ranked: isRanked,
          label: styleLabel(style),
          onFull: () => boardDialog(m, style, o.current, o.onPick, (id) => (applyStyle(id), sw.set(id))),
        }),
        h("div.mbd-actions", null, playBtn, star, groups, share),
      ),
    );
  }

  /** The page's style changed (the switch, the full leaderboard's switch, the tutorial's Auto-strafe line, F3). */
  function applyStyle(id: StyleId): void {
    if (id === style) return;
    style = id;
    setSelectedStyle(id); // in game, the session switches style and restarts (style-picker listeners)
    void onlineMaps(id).then((on) => {
      online = on;
      refilter();
      showDetail(true);
    });
  }

  // ---- input
  list.addEventListener("click", (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".mb-row");
    if (!r) return;
    if ((e.target as HTMLElement).closest(".mb-star")) return toggleFavorite(r.dataset.name!);
    select(r.dataset.name!, { focus: true, now: true });
    if (matchMedia("(max-width: 52rem)").matches) root.classList.add("show-detail");
  });
  list.addEventListener("dblclick", (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".mb-row");
    if (r && !(e.target as HTMLElement).closest(".mb-star") && !matchMedia("(max-width: 52rem)").matches) play(r.dataset.name!);
  });
  list.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const i = selected ? visible.indexOf(selected) : -1;
    const go = (j: number) => (e.preventDefault(), select(visible[Math.max(0, Math.min(visible.length - 1, j))] ?? null, { focus: true }));
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") {
      if (i <= 0) (e.preventDefault(), search.focus());
      else go(i - 1);
    } else if (e.key === "PageDown") go(i + 8);
    else if (e.key === "PageUp") go(i - 8);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(visible.length - 1);
    else if (e.key === "Enter") {
      e.preventDefault();
      if (matchMedia("(max-width: 52rem)").matches) root.classList.add("show-detail");
      else play(selected);
    } else if (e.key === "ArrowRight") {
      const t = detail.querySelector<HTMLElement>(".mbd-play");
      if (t) (e.preventDefault(), t.focus());
    } else if (e.key.length === 1 && e.key !== "/" && /\S/.test(e.key)) search.focus(); // type to search
  });
  detail.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" && !typing(e.target) && !(e.target as HTMLElement).closest(".card-art, .sw-opts")) {
      e.preventDefault();
      (selected ? rows.get(selected) : null)?.focus();
    }
  });
  search.addEventListener("input", () => {
    query = search.value;
    render();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      select(selected && visible.includes(selected) ? selected : (visible[0] ?? null), { focus: true });
    } else if (e.key === "Enter") {
      e.preventDefault();
      play(selected && visible.includes(selected) ? selected : (visible[0] ?? null));
    } else if (e.key === "Escape" && search.value) {
      e.stopPropagation();
      e.preventDefault();
      search.value = query = "";
      render();
    }
  });
  // A new sort starts at the top (Newest is asked for to see the newest); the filters keep your map in view.
  sortSel.addEventListener("change", () => {
    sort = sortSel.value as Sort;
    render();
    list.scrollTop = 0;
  });
  setSel.addEventListener("change", () => {
    collection = setSel.value;
    refilter();
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "/" && !typing(e.target)) {
      e.preventDefault();
      search.focus();
      search.select();
    } else if (e.key === "Escape" && closeMapPanel(root)) {
      e.preventDefault();
      e.stopPropagation();
    } else if (!typing(e.target) && !e.repeat && cycleKey() && e.code === cycleKey()) {
      e.preventDefault();
      const n = nextStyle(style, e.shiftKey ? -1 : 1);
      sw.set(n);
      applyStyle(n);
    }
  });
  // Stars: one this page made repaints in place (a map unstarred under "Favorites" stays until the list is filtered
  // again, so the list doesn't jump under the pointer); the account's list arriving re-filters.
  onFavoritesChange(root, (server) => {
    if (server) return void (maps.length && render());
    for (const n of visible) paintStar(rows.get(n)?.querySelector(".mb-star") ?? null, n);
    paintStar(detail.querySelector(".mbd-star"), shownDetail ?? "");
    renderSets();
  });
  syncFavorites();
  // Groups: a change this page made re-labels the set menu (a map taken out of the group on show stays until the list is
  // filtered again, like an unstar); the account's groups arriving, or the group on show going, re-filters.
  onMapGroupsChange(root, (server) => {
    const gone = collection.startsWith(GROUP) && !groupOf(collection);
    if (gone) collection = "all";
    if ((server || gone) && maps.length) return render();
    renderSets();
  });
  syncMapGroups();
  onPBChange(root, () => {
    for (const name of rows.keys()) paint(name);
    if (maps.length) render();
  });
  // The board's rows follow the panel's height.
  const ro = new ResizeObserver(() => (root.isConnected ? refitBoard(detail.querySelector(".mbd-board")) : ro.disconnect()));
  ro.observe(detail);

  // ---- first paint: skeleton rows, then the list
  list.append(...Array.from({ length: 8 }, () => h("div.mb-row.skeleton", { "aria-hidden": "true" }, h("span.mb-thumb"), h("span.mb-name"))));
  detail.append(h("div.mbd-inner.skeleton", { "aria-hidden": "true" }, h("div.card-art.mbd-art"), h("div.mbd-main")));
  void (async () => {
    const pending = onlineMaps(style);
    // The map it opens on is known from the (local) index alone: its board starts now, beside the much bigger /maps
    // (map-board.ts keeps it for the panel). Unless /maps then says the map is unranked, that's the panel's request.
    const index = await fetchMapIndex();
    const preselect = () => {
      const last = localStorage.getItem("bunnyhop:last-map");
      // First visit (nothing played): the tutorial when it's on the list, else today's first map (first-map.ts).
      const fresh = !played.size && !last;
      return (
        [o.focus, fresh && tutorialPrompt() ? TUTORIAL_MAP : null, o.current, last, firstMapOfTheDay()].find(
          (n) => n && (n === TUTORIAL_MAP ? tutorialEnabled() : index.some((m) => m.name === n)),
        ) ?? null
      );
    };
    const early = preselect();
    if (early && early !== TUTORIAL_MAP && seq === browserSeq) preloadMapBoard(early, style);
    [maps, online] = [index, await pending];
    if (seq !== browserSeq) return;
    for (const m of maps) byName.set(m.name, m);
    played = playedMaps();
    const pref = preselect();
    selected = pref;
    render();
    if (pref) select(pref, { now: true, scroll: false });
    // The screen may still be on its way in (menu.ts swaps it in a view transition): focus and scroll once it's there.
    const cur = selected ? rows.get(selected) : null;
    const reveal = (tries: number) => {
      if (seq !== browserSeq) return;
      if (!root.isConnected) return void (tries && requestAnimationFrame(() => reveal(tries - 1)));
      // Rows excluded by this list's filters may still be in a previous, closed view.
      for (const r of rows.values()) if (!r.isConnected) r.remove();
      (cur ?? search).focus({ preventScroll: true });
      if (cur) centerOn(cur);
    };
    reveal(60);
    // Your WRs: the account's id against each record holder (once it answers).
    void me().then((u) => {
      myId = u?.id ?? null;
      if (myId) for (const n of visible) paint(n);
    });
  })();
  return root;
}
