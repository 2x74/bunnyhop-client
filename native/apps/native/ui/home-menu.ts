// The native title screen: a port of the web's home screen (apps/web/src/ui/home.ts), same markup and classes so the
// web's style.css draws it unchanged. The menu column over the map background, and on the right six maps to try (the
// one behind the menu first, then what to play next). Differences from the web are only where the native client has
// its own screen or no web page: Gauntlets are the native menu's own screens, Support opens its bunnyhop.lol page in the
// browser, the quiet links
// under the footer carry Replays, Credits and Quit, and "Desktop app" is gone (this is it).

import { api, type MapSummary } from "../../web/src/api";
import { getPB, onPBChange } from "../../web/src/pb";
import { clampTier, tierLabel, tierName, tierNum } from "../../web/src/tiers";
import { formatTime } from "../../web/src/timer";
import { accountChip, me, myProfile } from "../../web/src/ui/account";
import { suggestNextMaps } from "../../web/src/progression";
import { STYLE_DEFS, type StyleId } from "../../web/src/styles";
import { wordmark } from "../../web/src/ui/brand";
import { icon } from "../../web/src/ui/icons";
import { hopIndicator } from "../../web/src/ui/hop";
import { arrowNav, h } from "../../web/src/ui/dom";
import { backgroundPick, featuredArtReady, markFeaturedArtReady } from "../../web/src/ui/featured";
import { fetchMapIndex, onlineMaps, prewarmMapRows, tierOf, type MapEntry } from "../../web/src/ui/maps";
import { mapArt, observeThumbs, prefetchThumbs } from "../../web/src/ui/thumbs";
import { landRows } from "../../web/src/ui/land";
import { onlineSummary } from "../../web/src/ui/servers";
import { openFeedback } from "../../web/src/feedback/state";
import { openInbox, withInboxBadge } from "../../web/src/inbox/state";
import { versionLink } from "../../web/src/ui/changelog";
import { gauntletHub } from "../../web/src/shared-reads";
import { discordLink } from "../../web/src/ui/community";
import { tutorialOnHome, tutorialSub } from "./tutorial-entry";
import { ONBOARDED_KEY } from "../../web/src/ui/account-state";

export interface HomeActions {
  /** PBs and WRs on the home screen follow the selected style. */
  style: StyleId;
  play: () => void;
  pick: (map: string) => void;
  settings: () => void;
  loadout: () => void;
  profile: (id: string) => void;
  ranks: () => void;
  stats: () => void;
  /** Server browser, or the current room while in one. */
  servers: () => void;
  learn: () => void;
  replays: () => void;
  credits: () => void;
  quit: () => void;
  /** The gauntlets (ui/gauntlets.ts), on the native menu's own screen. */
  gauntlets?: () => void;
  /** A bunnyhop.lol page the native client has no screen for (opened in the browser). */
  web: (path: string) => void;
  /** The map the background shows (backgroundPick), once known, with your PB's replay there when it has one. */
  background?: (map: string | null, pb?: { runId: string; bytes: Uint8Array } | null) => void;
}

export const LAST_MAP = "bunnyhop:last-map";

/** The web's Support icon (ui/support.ts SUPPORT_ICON). */
const SUPPORT_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" width="1.1em" height="1.1em"><path d="M4.5 10.5h11v4.2a4.8 4.8 0 0 1-4.8 4.8H9.3a4.8 4.8 0 0 1-4.8-4.8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M15.5 11.8h1.3a2.3 2.3 0 0 1 0 4.6h-1.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M10 8.6c-1.7-1.1-2.8-2-2.8-3.2a1.5 1.5 0 0 1 2.8-.7 1.5 1.5 0 0 1 2.8.7c0 1.2-1.1 2.1-2.8 3.2z" fill="currentColor"/></svg>`;

function item(
  label: string,
  sub: string | HTMLElement | null,
  fn: () => void,
  o: { primary?: boolean; hint?: string } = {},
): HTMLElement {
  return h(
    `button.menu-btn.home-item${o.primary ? ".primary" : ""}`,
    { type: "button", onclick: fn, "data-autofocus": o.primary ? "" : undefined },
    h("span.mb-label", null, h("span.mb-title", null, label), sub ? h("small", null, sub) : null),
    o.hint ? h("span.mb-hint", { "aria-hidden": "true" }, o.hint) : null,
  );
}

/**
 * Maps to try (right side): six tiles, two columns by three rows, as on the web (home.ts mapsToTry): first the map the
 * background is showing, then what to play next from your clears, then popular ranked maps of a similar tier.
 */
const TILES = 6;
function mapsToTry(a: HomeActions, onFirst: (name: string) => void): HTMLElement {
  const STYLE = a.style;
  const grid = h("div.home-grid", { role: "group", "aria-label": "Maps to try" });
  void (async () => {
    let serverClears: string[] | null = null;
    const profile = myProfile()
      .then((p) => void (serverClears = p?.stats.clearedMaps ?? null))
      .catch(() => {});
    const [pick, maps] = await Promise.all([backgroundPick().catch(() => null), fetchMapIndex()]);
    const pbRun = pick?.pbReplay ? getPB(pick.map.name, "autohop") : null;
    a.background?.(
      pick?.map.name ?? null,
      pick?.pbReplay
        ? {
            runId: pbRun && "runId" in pbRun && typeof pbRun.runId === "string" ? pbRun.runId : "local-pb",
            bytes: pick.pbReplay,
          }
        : null,
    );
    if (!maps.length) return markFeaturedArtReady();
    const online = await Promise.race([onlineMaps(STYLE), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
    const byName = new Map(maps.map((m) => [m.name, m]));
    const pool = maps.filter((m) => !online || online.get(m.name)?.ranked);
    const choose = (first: string | null | undefined): string[] => {
      const names: string[] = [];
      const add = (n: string | null | undefined) =>
        n && byName.has(n) && !names.includes(n) && names.length < TILES && names.push(n);
      add(first);
      const cleared = new Set(maps.filter((m) => STYLE_DEFS.some((d) => getPB(m.name, d.id))).map((m) => m.name));
      for (const m of serverClears ?? []) cleared.add(m);
      const next = suggestNextMaps(
        pool.map((m) => ({ name: m.name, tier: tierOf(m, online?.get(m.name)) })),
        cleared,
        TILES,
      );
      for (const x of next) add(x.map);
      const around =
        clampTier(
          next[0]?.tier ?? tierOf(byName.get(names[0] ?? "") ?? { name: "" }, online?.get(names[0] ?? "")) ?? 1,
        ) ?? 1;
      const popular = [...pool]
        .filter((m) => Math.abs((tierOf(m, online?.get(m.name)) ?? 9) - around) <= 1)
        .sort(
          (x, y) =>
            Number(cleared.has(x.name)) - Number(cleared.has(y.name)) ||
            (online?.get(y.name)?.runners ?? 0) - (online?.get(x.name)?.runners ?? 0),
        );
      for (const m of popular) add(m.name);
      return names;
    };
    const names = choose(pick?.map.name);
    if (!names.length) return markFeaturedArtReady();
    onFirst(names[0]);
    let tiles = names.map((n, i) => mapTile(a, byName.get(n)!, online?.get(n) ?? null, i === 0));
    grid.replaceChildren(...landRows(tiles));
    grid.addEventListener("keydown", (e) => {
      const i = tiles.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      const left = i % 2 === 0;
      const j =
        e.key === "ArrowRight"
          ? left
            ? i + 1
            : null
          : e.key === "ArrowLeft"
            ? left
              ? "menu"
              : i - 1
            : e.key === "ArrowDown"
              ? i + 2
              : e.key === "ArrowUp"
                ? i - 2
                : null;
      if (j === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (j === "menu") document.querySelector<HTMLElement>(".home-menu .home-item.primary")?.focus();
      else tiles[j]?.focus();
    });
    const observe = () =>
      void featuredArtReady(2500).then(() => {
        const go = (n: number) =>
          grid.isConnected ? observeThumbs(grid) : n && requestAnimationFrame(() => go(n - 1));
        go(120);
      });
    observe();
    await profile;
    if (!grid.isConnected) return;
    const drawn = tiles;
    tiles = choose(names[0]).map((n, i) =>
      drawn[i]?.dataset.name === n ? drawn[i] : mapTile(a, byName.get(n)!, online?.get(n) ?? null, false),
    );
    if (tiles.every((t, i) => t === drawn[i]) && tiles.length === drawn.length) return;
    tiles.forEach((t, i) => t !== drawn[i] && (drawn[i] ? drawn[i].replaceWith(t) : grid.append(t)));
    for (const t of drawn.slice(tiles.length)) t.remove();
    observe();
  })().catch(() => markFeaturedArtReady());
  return grid;
}

function mapTile(a: HomeActions, m: MapEntry, o: MapSummary | null, first: boolean): HTMLElement {
  const art = mapArt(m.name, o?.thumbnailUrl ?? m.thumbnail ?? null, {
    className: "home-tile-art",
    eager: first,
    priority: first,
  });
  if (first) {
    art.addEventListener("load", markFeaturedArtReady, { capture: true, once: true });
    art.addEventListener("error", markFeaturedArtReady, { capture: true, once: true });
    if (!art.querySelector("img.full")) markFeaturedArtReady();
  }
  const t = clampTier(tierOf(m, o));
  const personal = h("span");
  const paintPB = () => {
    const pb = getPB(m.name, a.style);
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
      h(
        "span.home-tile-name",
        null,
        h("b", null, m.name),
        h(
          `span.home-tile-tier.${t ? `t${t}` : "tx"}`,
          { title: t ? `Tier ${tierNum(t)}, ${tierName(t)}` : "Unrated" },
          tierLabel(t),
        ),
      ),
      h(
        "span.home-tile-times",
        null,
        o?.wr
          ? h(
              "span",
              { title: `World record by ${o.wr.player}` },
              h("small", null, "WR"),
              h("b.wr", null, formatTime(o.wr.time)),
            )
          : null,
        personal,
      ),
    ),
  );
  onPBChange(tile, paintPB);
  return tile;
}

/** Time left until `end`, to the minute (gauntlet/state.ts formatCountdown). */
function formatCountdown(end: number, now = Date.now()): string | null {
  const left = end - now;
  if (left <= 0) return null;
  const min = Math.floor(left / 60_000);
  if (min < 1) return "under a minute";
  const d = Math.floor(min / 1440);
  const hr = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${m}m`;
  return `${m}m`;
}

/** The weekly gauntlet (its time left) under Gauntlets; nothing without one. */
function weeklySub(): HTMLElement {
  const el = h("span.cont-sub");
  if (!api.available()) return el;
  void gauntletHub(5 * 60_000).then(
    (hub) => {
      const w = hub.weekly;
      const left = w?.endsAt != null ? formatCountdown(w.endsAt) : null;
      if (w && left) el.replaceChildren(h("b", null, "Weekly"), h("span", { title: w.title }, `${left} left`));
    },
    () => {},
  );
  return el;
}

/** Profile (card, loadout, runs); a guest without an account yet gets the Loadout. */
function profileItem(a: HomeActions): HTMLElement {
  return item(
    "Profile",
    null,
    () =>
      void me().then(
        (u) => (u ? a.profile(u.id) : a.loadout()),
        () => a.loadout(),
      ),
  );
}

// The website's tagline says "in your browser"; this is the native game.
const TAGLINE = "Counter-Strike: Source bunnyhop.";

/** The footer's three things people come back for: Support, the Discord and the Inbox, as real buttons. */
function homeActs(a: HomeActions): HTMLElement {
  const inbox = api.available()
    ? withInboxBadge(
        h(
          "button.home-act.act-inbox",
          { type: "button", onclick: () => openInbox() },
          icon("mail", { size: "1.15rem" }),
          h("span.mb-title", null, "Inbox"),
        ),
        "Inbox",
      )
    : null;
  return h(
    "div.home-acts",
    null,
    h("button.home-act.act-support", {
      type: "button",
      onclick: () => a.web("/?support"),
      html: `${SUPPORT_ICON}<span>Support</span>`,
    }),
    discordLink("home-act.act-discord", "Discord"),
    inbox,
  );
}

/** Everything else, as quiet text under them (the web's row; Replays, Credits and Quit are the native client's own). */
function homeLinks(a: HomeActions, learnOnMenu: boolean): HTMLElement {
  const link = (label: string, fn: () => void, cls = "") =>
    h(`button.home-link${cls}`, { type: "button", onclick: fn }, label);
  return h(
    "div.home-links",
    null,
    !learnOnMenu ? link("Tutorial", a.learn, ".home-tutorial") : null,
    api.available() ? link("Feedback", () => openFeedback()) : null,
    link("Replays", a.replays),
    // The website's pages open in the browser.
    link("About", () => a.web("/about")),
    link("Privacy", () => a.web("/privacy")),
    link("Terms", () => a.web("/terms")),
    link("Credits", a.credits),
    versionLink(),
    link("Quit", a.quit, ".home-quit"),
  );
}

/** The hop trail: the logo's arcs continuing out of the wordmark, a dot bouncing along them once, then resting at the end. */
function hopTrail(): HTMLElement {
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
  const lastPB = last ? getPB(last, a.style) : null;
  const learn = tutorialOnHome(!!localStorage.getItem(ONBOARDED_KEY));
  // Play: with nothing to continue, straight into the first map to try (the one behind the menu); else the map list.
  let plateMap: string | null = null;
  const play = () => (!last && plateMap ? a.pick(plateMap) : a.play());
  const learnSub = tutorialSub();
  const menu = h(
    "nav.menu-list.home-menu",
    { "aria-label": "Main menu" },
    item("Play", null, play, { primary: true, hint: "Enter" }),
    learn ? item("Learn to bhop", /lessons done|Finished/.test(learnSub) ? learnSub : null, a.learn) : null,
    item("Play online", api.available() ? onlineSummary() : null, a.servers),
    api.available() ? item("Gauntlets", weeklySub(), a.gauntlets ?? (() => a.web("/gauntlets"))) : null,
    last
      ? item(
          "Continue",
          h("span.cont-sub", null, h("b", null, last), lastPB ? h("span", null, formatTime(lastPB.time)) : null),
          () => a.pick(last),
        )
      : null,
    api.available() ? profileItem(a) : item("Loadout", null, a.loadout),
    api.available() ? item("Ranks", null, a.ranks) : null,
    item("Stats", null, a.stats),
    item("Settings", null, a.settings),
  );
  arrowNav(menu, "button");
  menu.classList.add("hop-host");
  hopIndicator(menu, ".home-item", { inset: 4, rest: () => menu.querySelector<HTMLElement>(".home-item.primary") });
  const right = h(
    "aside.home-right",
    null,
    mapsToTry(a, (n) => (plateMap = n)),
  );
  menu.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "ArrowRight" || !(document.activeElement as HTMLElement)?.closest(".home-menu")) return;
      const t = right.querySelector<HTMLElement>("button:not([disabled]):not([hidden])");
      if (t) (e.preventDefault(), e.stopPropagation(), t.focus());
    },
    { capture: true },
  );
  void fetchMapIndex().then((maps) =>
    setTimeout(
      () =>
        void onlineMaps().then((online) => {
          prefetchThumbs(
            [...maps]
              .sort((x, y) => Number(y.name === last) - Number(x.name === last))
              .map((m) => online?.get(m.name)?.thumbnailUrl ?? m.thumbnail),
          );
          prewarmMapRows(maps);
        }),
      1500,
    ),
  );
  return h(
    "section.home",
    null,
    h(
      "div.home-left",
      null,
      h("header.home-brand", null, h("div.brand-row", null, wordmark("xl"), hopTrail()), h("p.tagline", null, TAGLINE)),
      menu,
      h(
        "footer.home-foot",
        null,
        h("div.home-foot-row", null, accountChip({ quiet: true }), homeActs(a)),
        homeLinks(a, learn),
      ),
    ),
    right,
  );
}

/** This small presentation message is separate from persisted gameplay settings. */
export function watchMenuMotion(): void {
  const preference = matchMedia("(prefers-reduced-motion: reduce)");
  const notify = () => {
    const message = { type: "menuAppearance", reducedMotion: preference.matches };
    window.webkit?.messageHandlers?.bunnyhop?.postMessage(JSON.stringify(message));
    window.dispatchEvent(new CustomEvent("bunnyhop:native-message", { detail: message }));
  };
  preference.addEventListener("change", notify);
  notify();
}
