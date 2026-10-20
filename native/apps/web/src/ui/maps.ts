// The map list (Play): one toolbar row (search, tier, set, sort, style as text menus), a list of every map with your
// status on each, and a panel for the selected map with its board (ui/map-board.ts) and Play. The tutorial sits at
// the top of the list (tutorial/learn.ts) unless the player hid it. A star by a map's name (and in its panel) makes it
// a favorite (ui/favorites.ts); "Favorites" in the set menu shows just those.
//
// The style picked here is the style of everything on the page: the PBs and records in the list, the board in the
// panel (and the full leaderboard opened from it) and the run you start. Click or ↑ / ↓ selects; double-click or
// Enter plays. Rows are built once and reused (the list holds ~210 maps): filtering and sorting only re-order them,
// thumbnails load as rows near the view, and only the selected map's board is fetched.

import { api, type MapSummary } from "../api";
import { getPB, onPBChange } from "../pb";
import { formatTime } from "../timer";
import { fmtBytes, h } from "./dom";
import { mapArt, mapGallery, observeThumbs, registerMapImages } from "./thumbs";
import { clampTier, tierLabel, tierName, TIERS } from "../tiers";
import { isStyleId, nextStyle, STYLE_DEFS, styleLabel, type StyleId } from "../styles";
import { selectedStyle, setSelectedStyle } from "./style-picker";
import { keyLabel, prefs } from "./settings";
import { landRows } from "./land";
import { mapUrl, shareButton } from "./share";
import { openLeaderboardDialog } from "./leaderboard";
import { requestRace, requestRaceAfterReload } from "../player/race";
import { me } from "./account-state";
import { playedMaps } from "./stats";
import { mapBoard, refitBoard } from "./map-board";
import { openTutorial, tutorialEnabled, tutorialPrompt, tutorialSub, TUTORIAL_MAP } from "../tutorial/entry";
import { matchesTutorial, tutorialArt, tutorialPanel } from "../tutorial/learn";
import { tutorialProgress } from "../tutorial/flag";
import { toast } from "../notify";
import { isFavorite, onFavoritesChange, setFavorite, syncFavorites } from "./favorites";
import { icon } from "./icons";
import "./maps.css";

/**
 * Where new players start: onboarding's "Play", the featured card on a first visit and the map list's default
 * selection. bhop_ambience: tier 1, ~29 s for newcomers (WR 19 s). bhop_eazy took newcomers 137 s on average (WR 32 s).
 */
export const START_MAP = "bhop_ambience";

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
  added?: string | null;
  /** maps/<name>.zones.json exists locally (not shown in the UI). */
  zones?: boolean;
  /** Community difficulty tier (clamped to T1–T6 for display and points; null = unrated). */
  tier?: number | null;
  /** Track count: number of tracks, or { main, bonus } counts. */
  tracks?: number | { main?: number; bonus?: number } | null;
  /** Start/end zones are known for this map (not shown in the UI). */
  zoned?: boolean;
  /** Curated collections (maps/index.json): "prestige", "iconic", "short", "modern", "halloween", … */
  collections?: string[];
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

/** Tier pill (T1–T6, clamped; "T?" = unrated, unranked for points). `long` adds the tier name ("T5 · Very hard"). */
export function tierBadge(tier: number | null, o: { long?: boolean } = {}): HTMLElement {
  const t = clampTier(tier);
  return h(
    `span.badge.tier${t ? `.t${t}` : ".tx"}`,
    { title: t ? `Tier ${t} of 6 · ${tierName(t)}` : "Unrated: no tier yet, so no rank points" },
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

type TierFilter = "all" | "1" | "2" | "3" | "4" | "5" | "6" | "x";
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
];
/** The set menu's own entry: the player's starred maps. */
const FAVORITES = "favorites";
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

/** `focus`: map to select first (a /maps/<name> link, the home screen's Tutorial link); the filters open on "all". */
export function mapBrowser(o: { current: string | null; focus?: string | null; style: string; onPick: (name: string) => void; gauntlets?: (() => void) | null }): HTMLElement {
  let saved: { sort?: string; tier?: string; collection?: string } = {};
  try {
    saved = JSON.parse(localStorage.getItem(LAST_FILTER) ?? "{}") ?? {};
  } catch {
    /* corrupt: defaults */
  }
  if (o.focus) Object.assign(saved, { tier: "all", collection: "all" });
  let sort: Sort = SORTS.some(([s]) => s === saved.sort) ? (saved.sort as Sort) : "tier";
  let tierFilter: TierFilter = TIER_FILTERS.includes(saved.tier as TierFilter) ? (saved.tier as TierFilter) : "all";
  let collection = saved.collection === FAVORITES || COLLECTIONS.some(([id]) => id === saved.collection) ? saved.collection! : "all";
  let query = "";
  let style: StyleId = isStyleId(o.style) ? o.style : selectedStyle();

  let maps: MapEntry[] = [];
  const byName = new Map<string, MapEntry>();
  let online: Map<string, MapSummary> | null = null;
  let played = playedMaps();
  let myId: string | null = null;
  let selected: string | null = null;
  /** Rows built once per map (and the tutorial's), reused by every filter / sort. */
  const rows = new Map<string, HTMLElement>();
  let visible: string[] = [];

  // ---- toolbar
  const search = h("input.mb-q", { type: "search", placeholder: "Search maps or authors", "aria-label": "Search maps", spellcheck: "false", autocomplete: "off" });
  const qCount = h("span.mb-q-count", { "aria-live": "polite" });
  const searchWrap = h("label.mb-search", null, h("span.mb-q-icon", { "aria-hidden": "true" }, "⌕"), search, qCount, h("kbd.mb-q-kbd", { "aria-hidden": "true" }, "/"));
  const tiers = h("div.seg.mb-tiers", { role: "radiogroup", "aria-label": "Tier" });
  const setSel = h("select.mb-set", { "aria-label": "Map set" });
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
      h("div.mb-menus", null, setSel, sortSel, styleSel),
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
    rows.set(name, r);
    return r;
  }
  function mapRow(m: MapEntry): HTMLElement {
    const bonus = bonusCount(m);
    const by = m.author?.trim() && !/^(unknown|none)$/i.test(m.author.trim()) ? `by ${m.author.trim()}` : "Unknown author";
    const r = rowShell(m.name, mapArt(m.name, m.thumbnail ?? online?.get(m.name)?.thumbnailUrl ?? null, { className: "mb-thumb" }), m.name, bonus ? `${by}, ${bonus} bonus${bonus > 1 ? "es" : ""}` : by, true);
    if (bonus) r.querySelector(".mb-name small")!.setAttribute("title", "Bonus tracks are timed and ranked separately, always in Normal style");
    return r;
  }
  function tutorialRow(): HTMLElement {
    return rows.get(TUTORIAL_MAP) ?? rowShell(TUTORIAL_MAP, tutorialArt("mb-thumb"), "Tutorial", "Learn to bhop");
  }
  /** Status cells for the selected style. */
  function paint(name: string): void {
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
    tierCell.textContent = t ? `T${t}` : "T?";
    tierCell.title = t ? `Tier ${t}, ${tierName(t)}` : "Unrated: no rank points";
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
            title: t === "all" ? "Every tier" : t === "x" ? `Unrated (${counts.get(t)} maps)` : `Tier ${t}, ${tierName(Number(t))} (${counts.get(t)} maps)`,
            onclick: () => ((tierFilter = t), render()),
          },
          t === "all" ? "All" : t === "x" ? "?" : t,
        );
      }),
    );
    if (hadFocus) tiers.querySelector<HTMLElement>(".on")?.focus();
  }
  function renderSets(): void {
    const present = COLLECTIONS.filter(([id]) => maps.some((m) => m.collections?.includes(id)));
    const done = (label: string, inSet: MapEntry[]) => `${label}, ${inSet.filter((m) => getPB(m.name, style)).length} of ${inSet.length} done`;
    const favs = maps.filter((m) => isFavorite(m.name));
    setSel.replaceChildren(
      h("option", { value: "all" }, "All maps"),
      h("option", { value: FAVORITES }, favs.length ? done("Favorites", favs) : "Favorites"),
      ...present.map(([id, label]) => h("option", { value: id }, done(label, maps.filter((m) => m.collections?.includes(id))))),
    );
    setSel.value = collection;
  }

  const popularity = (m: MapEntry) => online?.get(m.name)?.runners ?? 0;
  const byTier = (a: MapEntry, b: MapEntry) => (tierOf(a, online?.get(a.name)) ?? 99) - (tierOf(b, online?.get(b.name)) ?? 99) || a.name.localeCompare(b.name);
  const unfinished = (m: MapEntry) => played.has(m.name) && !getPB(m.name, style);

  let landed = false;
  function render(): void {
    persist();
    renderTiers();
    renderSets();
    const q = query.toLowerCase().trim();
    const shown = maps.filter((m) => {
      if (q && !`${m.name} ${m.title ?? ""} ${m.author ?? ""}`.toLowerCase().includes(q)) return false;
      if (tierFilter !== "all" && tierKey(m) !== tierFilter) return false;
      if (collection === FAVORITES ? !isFavorite(m.name) : collection !== "all" && !m.collections?.includes(collection)) return false;
      return true;
    });
    shown.sort((a, b) => {
      if (sort === "popular") return popularity(b) - popularity(a) || byTier(a, b);
      if (sort === "newest") return (b.added ?? "").localeCompare(a.added ?? "") || a.name.localeCompare(b.name);
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "unplayed") return Number(played.has(a.name)) - Number(played.has(b.name)) || byTier(a, b);
      if (sort === "unfinished") return Number(unfinished(b)) - Number(unfinished(a)) || byTier(a, b);
      return byTier(a, b);
    });
    // The tutorial: pinned first while it's on the list; hidden, a search still finds it (and so does its own link).
    const tut = tutorialEnabled() && (q ? matchesTutorial(q) : tutorialPrompt() || selected === TUTORIAL_MAP);
    visible = [...(tut ? [TUTORIAL_MAP] : []), ...shown.map((m) => m.name)];
    const els = visible.map((n) => rows.get(n) ?? (n === TUTORIAL_MAP ? tutorialRow() : mapRow(byName.get(n)!)));
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
    empty.hidden = visible.length > 0 && !noFavorites;
    empty.textContent = !maps.length
      ? "No maps found. Run tools/scripts/gen-map-index.ts to build maps/index.json."
      : noFavorites
        ? "No favorites yet. Star a map to add it."
        : "No maps match. Try another search, tier or set.";
    if (!selected || !visible.includes(selected)) select(visible.find((n) => n !== TUTORIAL_MAP) ?? visible[0] ?? null, { scroll: false });
    else markSelected();
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
    const meta = h(
      "p.mbd-meta",
      null,
      h(`span.mbd-tier.${t ? `t${t}` : "tx"}`, { title: t ? `Tier ${t} of 6` : "Unrated: no rank points" }, t ? `Tier ${t}, ${tierName(t)}` : "Unrated"),
      h("span", null, m.author?.trim() ? `by ${m.author.trim()}` : "Unknown author"),
      bonus ? h("span", { title: "Bonus tracks are timed and ranked separately, always in Normal style" }, `${bonus} bonus track${bonus > 1 ? "s" : ""}`) : null,
      m.size && m.size > 48 << 20 ? h("span", { title: "Download size" }, fmtBytes(m.size)) : null,
    );
    const playBtn = h("button.btn.primary.mbd-play", { type: "button", onclick: () => play(m.name) }, current ? "Resume" : "Play");
    const star = h("button.btn.mbd-star", { type: "button", onclick: () => toggleFavorite(m.name) }, icon("star"));
    paintStar(star, m.name);
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
        h("div.mbd-actions", null, playBtn, star, share),
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
      render();
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
  sortSel.addEventListener("change", () => {
    sort = sortSel.value as Sort;
    render();
    list.scrollTop = 0;
  });
  setSel.addEventListener("change", () => {
    collection = setSel.value;
    render();
    list.scrollTop = 0;
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
    [maps, online] = await Promise.all([fetchMapIndex(), onlineMaps(style)]);
    for (const m of maps) byName.set(m.name, m);
    played = playedMaps();
    const last = localStorage.getItem("bunnyhop:last-map");
    // First visit (nothing played): the tutorial when it's on the list, else the start map.
    const fresh = !played.size && !last;
    const pref =
      [o.focus, fresh && tutorialPrompt() ? TUTORIAL_MAP : null, o.current, last, START_MAP].find(
        (n) => n && (n === TUTORIAL_MAP ? tutorialEnabled() : maps.some((m) => m.name === n)),
      ) ?? null;
    selected = pref;
    render();
    if (pref) select(pref, { now: true, scroll: false });
    // The screen may still be on its way in (menu.ts swaps it in a view transition): focus and scroll once it's there.
    const cur = selected ? rows.get(selected) : null;
    const reveal = (tries: number) => {
      if (!root.isConnected) return void (tries && requestAnimationFrame(() => reveal(tries - 1)));
      (cur ?? search).focus({ preventScroll: true });
      if (cur) list.scrollTop = Math.max(0, cur.offsetTop - list.offsetTop - list.clientHeight / 2 + cur.offsetHeight / 2);
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
