// Home (title) screen: the menu column over the live map background (attract.ts), and on the right six maps to try
// (the one behind the menu first, then what to play next) as quick links with their pictures. The tutorial is on the menu for a new player's first two
// days (tutorialOnHome); after that it's at the top of the map list (tutorial/learn.ts), and the quiet links under the
// menu keep a way to it for players who hid it there.

import { itemSlug } from "./item-slug";
import { api, type MapSummary } from "../api";
import { getPB, onPBChange } from "../pb";
import { clampTier, tierLabel, tierName, tierNum } from "../tiers";
import { formatTime } from "../timer";
import { accountChip, me, myProfile } from "./account";
import { suggestNextMaps } from "../progression";
import { profileNotices } from "./unlocks";
import { STYLE_DEFS } from "../styles";
import { wordmark } from "./brand";
import { icon } from "./icons";
import { SUPPORT_ICON } from "./support";
import { hopIndicator } from "./hop";
import { arrowNav, h } from "./dom";
import { backgroundPick, featuredArtReady, markFeaturedArtReady } from "./featured";
import { fetchMapIndex, onlineMaps, prewarmMapRows, tierOf, type MapEntry } from "./maps";
import { mapArt, observeThumbs, prefetchThumbs } from "./thumbs";
import { landRows } from "./land";
import { selectedStyle } from "./style-picker";
import { onlineSummary } from "./servers";
import { openFeedback } from "../feedback/state";
import { openInbox, withInboxBadge } from "../inbox/state";
import { versionLink } from "./changelog";
import { legalHref } from "./legal";
import { formatCountdown } from "../gauntlet/state";
import { gauntletHub } from "../shared-reads";
import { discordLink } from "./community";
import { desktopLinkShown, openDesktopApp } from "./desktop-link";
import { openTutorial, tutorialEnabled, tutorialOnHome, tutorialSub } from "../tutorial/entry";
import { ONBOARDED_KEY } from "./account-state";

export interface HomeActions {
  play: () => void;
  pick: (map: string) => void;
  settings: () => void;
  /** The Loadout (knife, finish, gloves): the profile's Loadout tab (offline: kept on this device). */
  loadout?: () => void;
  controls: () => void;
  /** Open a player's profile / the rank board (menu.ts). */
  profile: (id: string, tab?: string) => void;
  ranks: () => void;
  stats?: () => void;
  /** Server browser (multiplayer rooms). */
  servers?: () => void;
  /** The gauntlets (ui/gauntlets.ts). */
  gauntlets?: () => void;
  /** The tutorial's place in the map list (also when the player hid it there). */
  learn?: () => void;
  /** The Support page (ui/support.ts). */
  support?: () => void;
}

const LAST_MAP = "bunnyhop:last-map";
/** PBs and WRs on the home screen follow the selected style (ui/style-picker.ts). */
const STYLE = selectedStyle();

function item(label: string, sub: string | HTMLElement | null, fn: () => void, o: { primary?: boolean; hint?: string } = {}): HTMLElement {
  return h(
    `button.menu-btn.home-item${o.primary ? ".primary" : ""}`,
    // data-item: a hook custom CSS may rely on (/custom-css). Renaming a label? Keep its old data-item.
    { type: "button", onclick: fn, "data-autofocus": o.primary ? "" : undefined, "data-item": itemSlug(label) },
    h("span.mb-label", null, h("span.mb-title", null, label), sub ? h("small", null, sub) : null),
    o.hint ? h("span.mb-hint", { "aria-hidden": "true" }, o.hint) : null,
  );
}

/**
 * Maps to try (right side): six tiles, two columns by three rows, as quick links with their pictures. First the map the
 * background is showing (featured.ts backgroundPick: your latest PB's map, or the featured pick; its picture is the
 * page's LCP), then what to play next from your clears (progression.ts suggestNextMaps), then popular ranked maps of a
 * similar tier. Each tile: picture, name, tier in its colour, the world record and your PB. A click plays the map.
 * No card around them; they land one after another. `onFirst` hears the first map (Play goes there when you have
 * nothing to continue).
 * The clears are this browser's PBs at first, so the tiles don't wait for your profile (GET /me, then /players/<you>);
 * when its list of cleared maps (your other devices too) comes later and changes the suggestions, the tiles after the
 * first are swapped in place.
 */
const TILES = 6;
function mapsToTry(a: HomeActions, onFirst: (name: string) => void): HTMLElement {
  const grid = h("div.home-grid", { role: "group", "aria-label": "Maps to try" });
  void (async () => {
    // The profile's list of cleared maps, once it's in.
    let serverClears: string[] | null = null;
    const profile = myProfile().then((p) => void (serverClears = p?.stats.clearedMaps ?? null));
    const [pick, maps] = await Promise.all([backgroundPick(), fetchMapIndex()]);
    if (!maps.length) return markFeaturedArtReady();
    const online = await Promise.race([onlineMaps(STYLE), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
    const byName = new Map(maps.map((m) => [m.name, m]));
    // Online, only ranked maps are suggested (they give points); offline, any tiered map.
    const pool = maps.filter((m) => !online || online.get(m.name)?.ranked);
    const choose = (first: string | null | undefined): string[] => {
      const names: string[] = [];
      const add = (n: string | null | undefined) => n && byName.has(n) && !names.includes(n) && names.length < TILES && names.push(n);
      add(first);
      // Local clears (any style, main track) work offline; online, the server's list also knows your other devices.
      const cleared = new Set(maps.filter((m) => STYLE_DEFS.some((d) => getPB(m.name, d.id))).map((m) => m.name));
      for (const m of serverClears ?? []) cleared.add(m);
      const next = suggestNextMaps(pool.map((m) => ({ name: m.name, tier: tierOf(m, online?.get(m.name)) })), cleared, TILES);
      for (const x of next) add(x.map);
      // Fill with popular maps of a similar tier (around the first suggestion's), the ones you haven't cleared first.
      const around = clampTier(next[0]?.tier ?? tierOf(byName.get(names[0] ?? "") ?? { name: "" }, online?.get(names[0] ?? "")) ?? 1) ?? 1;
      const popular = [...pool]
        .filter((m) => Math.abs((tierOf(m, online?.get(m.name)) ?? 9) - around) <= 1)
        .sort((x, y) => Number(cleared.has(x.name)) - Number(cleared.has(y.name)) || (online?.get(y.name)?.runners ?? 0) - (online?.get(x.name)?.runners ?? 0));
      for (const m of popular) add(m.name);
      return names;
    };
    const names = choose(pick?.map.name);
    if (!names.length) return markFeaturedArtReady();
    onFirst(names[0]);
    let tiles = names.map((n, i) => mapTile(a, byName.get(n)!, online?.get(n) ?? null, i === 0));
    grid.replaceChildren(...landRows(tiles));
    // Grid navigation: arrows move between tiles; left from the first column goes back to the menu.
    grid.addEventListener("keydown", (e) => {
      const i = tiles.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      const left = i % 2 === 0;
      const j = e.key === "ArrowRight" ? (left ? i + 1 : null) : e.key === "ArrowLeft" ? (left ? "menu" : i - 1) : e.key === "ArrowDown" ? i + 2 : e.key === "ArrowUp" ? i - 2 : null;
      if (j === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (j === "menu") document.querySelector<HTMLElement>(".home-menu .home-item.primary")?.focus();
      else tiles[j]?.focus();
    });
    // The other pictures load after the first (the LCP), as they come into view.
    const observe = () =>
      void featuredArtReady(2500).then(() => {
        const go = (n: number) => (grid.isConnected ? observeThumbs(grid) : n && requestAnimationFrame(() => go(n - 1)));
        go(120);
      });
    observe();
    // Once the profile is in (it may already have been): the first tile stays (it's the LCP), a tile whose map changed is
    // swapped in its place, the others aren't touched.
    await profile;
    if (!grid.isConnected) return;
    const drawn = tiles;
    tiles = choose(names[0]).map((n, i) => (drawn[i]?.dataset.name === n ? drawn[i] : mapTile(a, byName.get(n)!, online?.get(n) ?? null, false)));
    if (tiles.every((t, i) => t === drawn[i]) && tiles.length === drawn.length) return;
    tiles.forEach((t, i) => t !== drawn[i] && (drawn[i] ? drawn[i].replaceWith(t) : grid.append(t)));
    for (const t of drawn.slice(tiles.length)) t.remove();
    observe();
  })();
  return grid;
}

function mapTile(a: HomeActions, m: MapEntry, o: MapSummary | null, first: boolean): HTMLElement {
  const art = mapArt(m.name, o?.thumbnailUrl ?? m.thumbnail ?? null, { className: "home-tile-art", eager: first, priority: first });
  if (first) {
    art.addEventListener("load", markFeaturedArtReady, { capture: true, once: true });
    art.addEventListener("error", markFeaturedArtReady, { capture: true, once: true });
    if (!art.querySelector("img.full")) markFeaturedArtReady();
  }
  const t = clampTier(tierOf(m, o));
  const personal = h("span");
  const paintPB = () => {
    const pb = getPB(m.name, STYLE);
    personal.replaceChildren(...(pb ? [h("small", null, "PB"), h("b", null, formatTime(pb.time))] : []));
    personal.hidden = !pb;
    personal.title = "Your personal best";
  };
  paintPB();
  const tile = h(
    "button.home-tile",
    { type: "button", "data-name": m.name, title: `Play ${m.name}`, onclick: () => a.pick(m.name) },
    art,
    h(
      "span.home-tile-text",
      null,
      h("span.home-tile-name", null, h("b", null, m.name), h(`span.home-tile-tier.${t ? `t${t}` : "tx"}`, { title: t ? `Tier ${tierNum(t)}, ${tierName(t)}` : "Unrated" }, tierLabel(t))),
      h(
        "span.home-tile-times",
        null,
        o?.wr ? h("span", { title: `World record by ${o.wr.player}` }, h("small", null, "WR"), h("b.wr", null, formatTime(o.wr.time))) : null,
        personal,
      ),
    ),
  );
  onPBChange(tile, paintPB);
  return tile;
}

// --- progression: profile entry + "Next up" (T1 → T2 → ... suggestions from your clears)

/** Profile (card, loadout, runs). The card shows level and rank; the menu row is just the word. */
function profileItem(a: HomeActions): HTMLElement {
  void myProfile().then((p) => p && profileNotices(p));
  return item("Profile", null, () => void me().then((u) => (u ? a.profile(u.id) : a.loadout?.())));
}

/**
 * The weekly gauntlet (its time left) under Gauntlets; nothing without one. The list is asked once per 5 minutes, and
 * the Gauntlets screen takes it from the same place (shared-reads.ts).
 */
function weeklySub(): HTMLElement {
  const el = h("span.cont-sub");
  if (!api.available()) return el;
  void gauntletHub(5 * 60_000).then(
    (hub) => {
      const w = hub.weekly;
      const left = w?.endsAt != null ? formatCountdown(w.endsAt) : null;
      // (The title is too long for the menu line: "Weekly" and the time left say it.)
      if (w && left) el.replaceChildren(h("b", null, "Weekly"), h("span", { title: w.title }, `${left} left`));
    },
    () => {},
  );
  return el;
}

/** Offline: no profile, but the Loadout still works (kept on this device). */
function loadoutItem(open: () => void): HTMLElement {
  return item("Loadout", null, open);
}

/**
 * The footer's one quiet row of words: Feedback, Inbox, Discord, About, Support (warm), the version. "Tutorial" only
 * while the tutorial isn't on the menu: it's the way back for a player who hid it in the map list.
 */
/** The footer's three things people come back for: Support, the Discord and the Inbox, as real buttons. */
function homeActs(a: HomeActions): HTMLElement {
  const inbox = api.available()
    ? withInboxBadge(h("button.home-act.act-inbox", { type: "button", onclick: () => openInbox() }, icon("mail", { size: "1.15rem" }), h("span.mb-title", null, "Inbox")), "Inbox")
    : null;
  return h(
    "div.home-acts",
    null,
    a.support ? h("button.home-act.act-support", { type: "button", onclick: a.support, html: `${SUPPORT_ICON}<span>Support</span>` }) : null,
    // Hidden unless the API has a Discord invite (DISCORD_INVITE).
    discordLink("home-act.act-discord", "Discord"),
    inbox,
  );
}

/** Everything else, as quiet text under them. */
function homeLinks(a: HomeActions, learnOnMenu: boolean): HTMLElement {
  const link = (label: string, fn: () => void, cls = "") => h(`button.home-link${cls}`, { type: "button", onclick: fn }, label);
  return h(
    "div.home-links",
    null,
    tutorialEnabled() && a.learn && !learnOnMenu ? link("Tutorial", a.learn, ".home-tutorial") : null,
    api.available() ? link("Feedback", () => openFeedback()) : null,
    h("a.home-link", { href: "/about" }, "About"),
    h("a.home-link", { href: legalHref("/privacy"), target: "_blank", rel: "noopener" }, "Privacy"),
    h("a.home-link", { href: legalHref("/terms"), target: "_blank", rel: "noopener" }, "Terms"),
    h("a.home-link", { href: legalHref("/credits"), target: "_blank", rel: "noopener" }, "Credits"),
    desktopLinkShown() ? link("Desktop app", openDesktopApp) : null,
    versionLink(),
  );
}

/** The hop trail: the logo's arcs continuing out of the wordmark, a dot bouncing along them once, then resting at the end. */
function hopTrail(): HTMLElement {
  // Each hop longer and higher than the last (gaining speed), like the logo mark.
  const d = "M4 68 Q30 46 56 68 Q92 34 128 68 Q178 22 228 68 Q294 8 360 68";
  const el = h("div.hop-trail", { "aria-hidden": "true" });
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches || document.body.classList.contains("potato");
  const motion = still
    ? ""
    : `<animateMotion dur="2.6s" begin="1.2s" fill="freeze" calcMode="linear" path="${d}"/>` +
      `<animate attributeName="opacity" dur="2.6s" begin="1.2s" fill="freeze" values="0;1;1" keyTimes="0;0.07;1"/>`;
  el.innerHTML = `<svg viewBox="0 0 364 72" preserveAspectRatio="xMinYMid meet"><path class="trail" d="${d}"/><path class="trail-hot" d="${d}"/><circle class="hop-dot" r="4.5" cx="0" cy="0" ${still ? 'transform="translate(360 68)"' : 'opacity="0"'}>${motion}</circle></svg>`;
  return el;
}

export function homeScreen(a: HomeActions): HTMLElement {
  const last = localStorage.getItem(LAST_MAP);
  const lastPB = last ? getPB(last, STYLE) : null;
  const learn = tutorialOnHome(!!localStorage.getItem(ONBOARDED_KEY));
  // Play: with nothing to continue, straight into the first map to try (the one behind the menu); else the map list.
  let plateMap: string | null = null;
  const play = () => (!last && plateMap ? a.pick(plateMap) : a.play());
  const learnSub = tutorialSub();
  const menu = h(
    "nav.menu-list.home-menu",
    { "aria-label": "Main menu" },
    item("Play", null, play, { primary: true, hint: "Enter" }),
    // Progress only ("2 of 4 lessons done"); a fresh tutorial needs no caption.
    learn ? item("Learn to bhop", /lessons done|Finished/.test(learnSub) ? learnSub : null, () => openTutorial(a.pick)) : null,
    // The live player count from the server list (refreshed while shown) is its second line.
    api.available() && a.servers ? item("Play online", onlineSummary(), a.servers) : null,
    a.gauntlets ? item("Gauntlets", weeklySub(), a.gauntlets) : null,
    last ? item("Continue", h("span.cont-sub", null, h("b", null, last), lastPB ? h("span", null, formatTime(lastPB.time)) : null), () => a.pick(last)) : null,
    api.available() ? profileItem(a) : a.loadout ? loadoutItem(a.loadout) : null,
    api.available() ? item("Ranks", null, a.ranks) : null,
    a.stats ? item("Stats", null, a.stats) : null,
    // (Controls and "how to bhop": Settings → Keys links them; the tutorial teaches the rest.)
    item("Settings", null, a.settings),
  );
  arrowNav(menu, "button");
  menu.classList.add("hop-host");
  hopIndicator(menu, ".home-item", { inset: 4, rest: () => menu.querySelector<HTMLElement>(".home-item.primary") });
  const right = h("aside.home-right", null, mapsToTry(a, (n) => (plateMap = n)));
  // Right arrow from the menu goes to the maps to try (the grid takes its own arrows, and Left back).
  menu.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" || !(document.activeElement as HTMLElement)?.closest(".home-menu")) return;
    const t = right.querySelector<HTMLElement>("button:not([disabled]):not([hidden])");
    if (t) (e.preventDefault(), e.stopPropagation(), t.focus());
  }, { capture: true });
  // Prefetch the map list (and, once idle, the slow-to-load thumbnails and the list's rows) so Play opens instantly.
  void fetchMapIndex().then((maps) =>
    setTimeout(() => void onlineMaps().then((online) => {
      prefetchThumbs([...maps].sort((x, y) => Number(y.name === last) - Number(x.name === last)).map((m) => online?.get(m.name)?.thumbnailUrl ?? m.thumbnail));
      prewarmMapRows(maps);
    }), 1500),
  );
  return h(
    "section.home",
    null,
    h(
      "div.home-left",
      null,
      h("header.home-brand", null, h("div.brand-row", null, wordmark("xl"), hopTrail()), h("p.tagline", null, "Counter-Strike: Source bunnyhop in your browser.")),
      menu,
      h("footer.home-foot", null, h("div.home-foot-row", null, accountChip({ quiet: true }), homeActs(a)), homeLinks(a, learn)),
    ),
    right,
  );
}
