// Overlay menu shell (#overlay): main menu, map browser, settings, controls help, loading screen
// and the in-game pause menu (with leaderboard + replay actions). Screens form a stack; Esc pops
// one level, and on the pause root Esc resumes. Session code feeds run/replay actions through
// renderMenu() (its contract predates this shell and is kept as is).

import { appHref, appLocation } from "./platform/navigation";
import { getPB } from "./pb";
import { formatTime } from "./timer";
import { accountChip } from "./ui/account";
import { wordmark } from "./ui/brand";
import { afterPaint, arrowNav, h } from "./ui/dom";
import { statsScreen } from "./ui/stats-screen";
import { homeScreen } from "./ui/home";
import { itemSlug } from "./ui/item-slug";
import { leaderboardPanel } from "./ui/leaderboard";
import { closeMapPanel, fetchMapIndex, mapBrowser, onlineMaps, type MapEntry } from "./ui/maps";
import { queueLine, readQueue } from "./map-queue";
import { mapArt, mapImages } from "./ui/thumbs";
import { cancelBindCapture, settingsPanel } from "./ui/settings-panel";
import { ACTIONS, keyLabel, prefs, type Action } from "./ui/settings";
import { selectedStyle, setSelectedStyle } from "./ui/style-picker";
// --- profiles / ranks / tiers
import { api, type RunCard } from "./api";
import { requestRace, requestRaceAfterReload, type RaceRequest } from "./player/race";
import { openReplayViewer } from "./viewer/request";
import { me, myProfile } from "./ui/account";
import { profileNotices } from "./ui/unlocks";
import { mapTier, tierBadge } from "./ui/maps";
import { clampTier, tierLabel, tierName } from "./tiers";
import { claimNextPop, onNavigate, requestSaveProgress, routeFromUrl, type NavRequest } from "./ui/nav";
import { ProfileHistory } from "./ui/profile-history";
import { profileScreen, type ProfileActions, type ProfileOpen, type ProfileTab } from "./ui/profile";
import { leaveRanksUrl, ranksScreen } from "./ui/ranks";
import { gauntletResult, gauntletScreen, gauntletsScreen, leaveGauntletUrl, type GauntletScreens } from "./ui/gauntlets";
import { BONUS_STYLE, STYLE_DEFS, styleForTrack, styleLabel, type StyleId } from "./styles";
import { chatCommands } from "./chat-commands";
import { helpPanelGroups } from "./chat-help";
import { trackName } from "./zones";
import { roomPanel, serverBrowser } from "./ui/servers";
import { onRoomPresence, roomPresence } from "./net/presence";
import { audioCredits, sfx, uiOpen, uiSound } from "./audio";
import { attractLeave } from "./attract";
import { initGamepadNav } from "./ui/gamepad";
import { handleAuthReturn } from "./ui/account-email";
import { lastVerifiedRun, runUrl, shareWithToast } from "./ui/share";
import { accountChanged, onboardingMaybeNeeded, setReplayIntro } from "./ui/account-state";
import { openFeedback } from "./feedback/state";
import { openInbox, withInboxBadge } from "./inbox/state";
import { versionButton } from "./ui/changelog";
import { supportScreen } from "./ui/support";
import { legalLinks } from "./ui/legal";
import { supportLink } from "./ui/community";
import { group } from "./ui/controls";
import { hideUiSwitch, quickGrid } from "./ui/quick-toggles";
import { hudEditorAvailable, openHudEditor } from "./hud/editor";
import { icon, type IconName } from "./ui/icons";
import { lastRunReel } from "./hud/reel";
import { hopIndicator } from "./ui/hop";
import { setBackdropFrozen } from "./ui/backdrop";
import { openTutorial, TUTORIAL_BOARD, TUTORIAL_MAP, tutorialPrompt } from "./tutorial/entry";
import { dismissKey, mascot, toast as notifyToast } from "./notify";
import { allowLeave, modalOpen } from "./play-lock";
import { stopMenuWork, menuIdleAllowed } from "./ui/menu-work";

// The intro (ui/onboarding.ts) loads on demand: first visits, ?intro=1, or "Replay the intro" in the account panel.
const loadOnboarding = () => import("./ui/onboarding");
setReplayIntro(() => void loadOnboarding().then((m) => m.openOnboarding()));

export { fetchMapIndex, type MapEntry };

export interface MenuActions {
  map: string;
  /** Selected (main-track) style. */
  style: string;
  /** Track currently being run (0 = main, N = bonus N). */
  currentTrack?: () => number;
  /** Bonus tracks of the map (empty: no bonus UI). */
  bonuses?: number[];
  /** Pick a style (restarts on the main track in it). */
  onStyle?: (id: StyleId) => void;
  /** Restart onto a track (0 = main, N = bonus N). */
  onTrack?: (track: number) => void;
  onWatchPB: (() => void) | null;
  /** Open the run just finished in the replay viewer. */
  onWatchLast?: (() => void) | null;
  onExportLast: (() => void) | null;
  onLoadReplay: (file: File) => void;
  /** Practice mode (practice-mode/controller.ts): the rail's Practice item. Null where it isn't available (rooms, the
   * tutorial). */
  practice?: { on: boolean; toggle: () => void } | null;
}

type Screen = "home" | "maps" | "settings" | "controls" | "pause" | "loading" | "profile" | "ranks" | "servers" | "support" | "stats" | "gauntlets" | "gauntlet";

interface ShellHooks {
  /** Request pointer lock (resume play). */
  resume: () => void;
  restart: () => void;
  /** True while a replay is being watched (the watch bar owns input; the menu stays out). */
  watching: () => boolean;
  /** True while pointer-locked. */
  locked: () => boolean;
}

const LAST_MAP = "bunnyhop:last-map";

const S = {
  stack: [] as Screen[],
  hooks: null as ShellHooks | null,
  actions: null as MenuActions | null,
  inGame: false,
  started: false,
  pickResolve: null as ((name: string) => void) | null,
  /** Profile screen's player id / rank board scope. */
  profileId: "",
  /** Tab / Customise slot to open the profile on (end-of-run "new unlock", home "new" dot); then the last tab used. */
  profileOpen: {} as ProfileOpen,
  ranksScope: "all",
  /** Rank board page (kept for Back from a profile opened off the board). */
  ranksPage: 1,
  /** The gauntlet screen's gauntlet, and the attempt whose result it shows (ui/gauntlets.ts). */
  gauntlet: { slug: "", attempt: null } as { slug: string; attempt: string | null },
  /** Map the browser previews when it opens (a /maps/<name> link). */
  mapsFocus: null as string | null,
  /** Current map's tier (pause menu + loading screen). undefined = not looked up yet. */
  tier: undefined as number | null | undefined,
  lockLostAt: 0,
  /** Pause menu panel tab (kept across re-renders). */
  pauseTab: null as "board" | "style" | "replays" | "server" | "screen" | "help" | null,
  loading: null as { root: HTMLElement; title: HTMLElement; stage: HTMLElement; bar: HTMLElement; detail: HTMLElement; fill: HTMLElement; dot: HTMLElement; art: HTMLElement; sub: HTMLElement } | null,
  /** Leaving for a map (startLeave): the background keeps rendering for the camera's push until the art covers it. */
  leaveLive: false,
};

const overlay = () => document.getElementById("overlay")!;

function root(): HTMLElement {
  const o = overlay();
  let m = document.getElementById("menu");
  if (!m) {
    m = h("div#menu");
    o.replaceChildren(m);
  }
  return m;
}

function setVisible(v: boolean): void {
  overlay().classList.toggle("hidden", !v);
  document.body.classList.toggle("menu-open", v);
  syncBackdrop();
}

/** Screens that show the 3D scene behind them: home's live background, the pause menu, Settings' live previews. */
const LIVE_BEHIND = new Set<Screen>(["home", "pause", "settings"]);
/** Every other screen covers it: the scene is frozen into a blurred still while it shows (ui/backdrop.ts). */
function syncBackdrop(): void {
  const s = top();
  setBackdropFrozen(!overlay().classList.contains("hidden") && !!s && !LIVE_BEHIND.has(s) && !(s === "loading" && S.leaveLive), S.inGame ? "game" : "menu");
}

function top(): Screen | undefined {
  return S.stack[S.stack.length - 1];
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Screen changes animate with the View Transitions API where available (#menu is the only captured element, so the
 * live map background keeps rendering), else with the CSS enter animations on the new screen. The loading screen has
 * its own entrance (startLeave). The new screen is built synchronously (callers such as showLoading() fill it in right
 * away) and attached when the transition swaps.
 */
type VTDoc = Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
let renderSeq = 0;
const canMorph = () => !!(document as VTDoc).startViewTransition && !reducedMotion() && !overlay().classList.contains("hidden") && !!root().firstElementChild;

/** Focused control per stacked screen, restored when you come back to it (keyboard flow). */
const focusMemo: (number | null)[] = [];
const focusables = () => [...root().querySelectorAll<HTMLElement>("button:not([disabled]), [href], input, select")];

function push(s: Screen): void {
  const i = focusables().indexOf(document.activeElement as HTMLElement);
  focusMemo[S.stack.length - 1] = i >= 0 ? i : null;
  S.stack.push(s);
  render("in", true);
}

let profileBackPending = false;
function pop(): void {
  if (profileBackPending) return;
  if (S.stack.length > 1) {
    const profileBack = top() === "profile" && profileHistory.back();
    if (profileBack) {
      // Keep the live source screen (some map boards have no URL). After a reload the source is restored by main.ts.
      // (main.ts reloads on any other popstate; its listener runs first, so it asks before reloading.)
      if (profileBack === "local") {
        profileBackPending = true;
        claimNextPop(() => {
          profileBackPending = false;
          S.stack.pop();
          render("out", true);
        });
      }
      return;
    }
    S.stack.pop();
    render("out", true);
  }
}

function reset(s: Screen, animate = false): void {
  S.stack = [s];
  render("in", animate);
}

const BACK_ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12H5M11 5.5 4.5 12 11 18.5"/></svg>';

/** `inner`: a step back inside the screen, taken before leaving it (true when it took one). */
function header(title: string, sub?: string | HTMLElement | null, inner?: () => boolean): HTMLElement {
  // The back arrow sits in the title's own type (Esc works everywhere, so no key chip).
  const back = h("button.screen-back", { type: "button", "aria-label": "Back", title: "Back (Esc)", onclick: () => inner?.() || pop(), html: BACK_ARROW });
  return h("header.screen-head", null, back, h("div.screen-title", null, h("h2", null, title), sub ? (typeof sub === "string" ? h("small", null, sub) : sub) : null));
}

function build(s: Screen | undefined): HTMLElement | null {
  switch (s) {
    case "home":
      return homeScreen({
        play: () => ((S.mapsFocus = null), push("maps")),
        pick: pickMap,
        settings: () => push("settings"),
        loadout: () => openLoadout(),
        controls: () => push("controls"),
        profile: (id, tab) => openProfile(id, tab ? { tab: tab as ProfileOpen["tab"] } : {}),
        ranks: () => openRanks("all"),
        servers: () => push("servers"),
        gauntlets: api.available() ? () => push("gauntlets") : undefined,
        support: () => push("support"),
        stats: () => push("stats"),
        // The tutorial lives at the top of the map list (tutorial/learn.ts): the home link opens the list on it.
        learn: () => ((S.mapsFocus = TUTORIAL_MAP), push("maps")),
      });
    case "stats": {
      const tabs = h("div.pf-tabs-host");
      return h("section.panel.panel-wide.panel-stats", null, header("Stats", tabs), statsScreen({ tabsHost: tabs, play: () => ((S.mapsFocus = null), push("maps")) }));
    }
    case "servers":
      return h("section.panel.panel-wide", null, header("Play online"), serverBrowser({ onSolo: () => push("maps"), map: S.actions?.map ?? null }));
    case "support": {
      prewarmLoadoutSoon();
      // Its tabs sit in the header too (ui/support.ts fills the slot), like the profile's.
      const tabs = h("div.pf-tabs-host");
      return h(
        "section.panel.panel-wide.panel-support",
        null,
        header("Support", tabs),
        supportScreen({ loadout: () => openLoadout(), editCard: () => openMyProfile({ tab: "card" }), tabsHost: tabs }),
      );
    }
    case "profile": {
      prewarmLoadoutSoon();
      // The profile's tabs sit in the header (ui/profile.ts fills the slot), so they stay put whatever the tab shows.
      const tabs = h("div.pf-tabs-host");
      return h("section.panel.panel-wide.panel-profile", null, header("Profile", tabs), profileScreen(S.profileId, profileActions(), { ...S.profileOpen, tabsHost: tabs }));
    }
    case "ranks":
      return h(
        "section.panel.panel-wide.panel-ranks",
        null,
        header("Ranks"),
        ranksScreen(S.ranksScope, { page: S.ranksPage, onChange: (scope, page) => ((S.ranksScope = scope), (S.ranksPage = page)) }),
      );
    case "maps": {
      // On a phone a picked map's panel covers the list: Back closes it first, like Esc.
      const browser = mapBrowser({ current: S.actions?.map ?? null, focus: S.mapsFocus, style: S.actions?.style ?? selectedStyle(), onPick: pickMap, gauntlets: api.available() ? () => push("gauntlets") : null });
      return h("section.panel.panel-wide.panel-maps", null, header("Choose a map", S.actions ? playingLine(S.actions.map) : null, () => closeMapPanel(browser)), browser);
    }
    case "gauntlets":
      return h("section.panel.panel-wide.panel-gauntlets", null, header("Gauntlets"), gauntletsScreen(gauntletActions()));
    case "gauntlet": {
      const g = S.gauntlet;
      // (The title is the gauntlet's once it has loaded.)
      const head = header("Gauntlet");
      const title = (t: string) => void (head.querySelector("h2")!.textContent = t);
      const body = g.attempt ? gauntletResult(g.slug, g.attempt, gauntletActions(), { title }) : gauntletScreen(g.slug, gauntletActions(), { title });
      return h("section.panel.panel-wide.panel-gauntlet", null, head, body);
    }
    case "settings":
      return h("section.panel.panel-wide.panel-settings", null, header("Settings"), settingsPanel({ openControls: () => push("controls") }));
    case "controls":
      return h("section.panel.panel-controls", null, header("Controls"), controlsHelp());
    case "pause":
      return pauseScreen();
    case "loading":
      return loadingScreen();
    default:
      return null;
  }
}

/**
 * The Loadout is a click away (a profile, Support): its code loads and its models build in idle time now
 * (ui/loadout-stage.ts prewarmLoadout), so opening it doesn't build them in its first frames. Not in game, where idle
 * work could land between frames of a run.
 */
function prewarmLoadoutSoon(): void {
  if (S.inGame) return;
  const go = () => {
    if (!menuIdleAllowed()) return;
    void import("./ui/loadout-stage").then((m) => {
      if (menuIdleAllowed()) return m.prewarmLoadout();
    }).catch(() => {});
  };
  if ("requestIdleCallback" in window) requestIdleCallback(go, { timeout: 3000 });
  else setTimeout(go, 500);
}

function render(dir: "in" | "out" = "in", animate = false): void {
  cancelBindCapture();
  const s = top();
  const body = build(s);
  if (!body) return;
  // Shared documents remain reachable from maps, settings, profiles and other menu screens.
  if (s !== "home" && s !== "pause" && s !== "loading") body.append(legalLinks());
  syncProfileUrl(s);
  // The rank board keeps its page in the address while it's open, and so do the gauntlet screens (a profile opened from
  // them stacks on top of their address, so Back returns there).
  if (s !== "ranks" && s !== "profile") leaveRanksUrl();
  if (s !== "gauntlets" && s !== "gauntlet" && s !== "profile") leaveGauntletUrl();
  const seq = ++renderSeq;
  const r = root();
  // Into a map: no view transition (it holds the page while it captures); the screen you were on takes off under the
  // loading screen's own entrance (startLeave).
  const leaving = s === "loading" && animate ? startLeave(r) : null;
  const morphing = animate && s !== "loading" && canMorph();
  const commit = () => {
    if (seq !== renderSeq) return;
    if (s !== "loading") endLeave();
    const another = document.body.dataset.screen !== (s ?? "");
    r.className = `screen-${s} enter-${dir}${morphing ? " morph" : ""}${leaving ? ` ${leaving.screens} leaving` : ""}`;
    document.body.dataset.screen = s ?? "";
    syncBackdrop();
    if (leaving) r.append(body);
    else r.replaceChildren(body);
    // #menu is the scroller on small windows (a stacked screen, the home column): another screen starts at its top, not
    // at the scroll position the last one was left at (Support opened from the home footer used to open half way down).
    // A screen redrawn in place (the pause menu after a PB) keeps its place.
    if (another && !leaving) r.scrollTop = 0;
    const memo = dir === "out" ? focusMemo[S.stack.length - 1] : null;
    const back = memo !== null && memo !== undefined ? focusables()[memo] : null;
    if (s !== "maps") (back ?? r.querySelector<HTMLElement>("[data-autofocus]") ?? r.querySelector<HTMLElement>("button:not([disabled]), [href], input, select"))?.focus({ preventScroll: true });
  };
  // A screen dropping in comes with a little air (Back has its own landing sound).
  if (animate && dir === "in" && s !== "loading" && s !== "pause") uiOpen();
  if (!morphing) return commit();
  const de = document.documentElement;
  de.dataset.vt = [dir, s === "pause" && S.stack.length === 1 ? "ready" : ""].filter(Boolean).join(" ");
  const t = (document as VTDoc).startViewTransition!(commit);
  void t.finished.finally(() => {
    if (seq === renderSeq) delete de.dataset.vt;
  });
}

function pickMap(name: string): void {
  localStorage.setItem(LAST_MAP, name);
  dropRouteParams();
  if (S.pickResolve) {
    const r = S.pickResolve;
    S.pickResolve = null;
    const url = new URL(appHref());
    url.searchParams.set("map", name);
    history.pushState(null, "", url);
    r(name);
    return;
  }
  if (S.actions && name === S.actions.map) {
    reset("pause", true);
    return;
  }
  const url = new URL(appHref());
  url.searchParams.set("map", name);
  url.searchParams.delete("replay");
  url.searchParams.delete("server"); // picking a map yourself leaves the multiplayer room
  // In game the page reloads into the map: the menu takes off while the next page is fetched (no wait added).
  if (!reducedMotion()) root().classList.add("nav-leave");
  location.href = url.toString();
}

// ---------------------------------------------------------------------------------------------
// Screens

// ---------------------------------------------------------------------------------------------
// Pause menu: a short rail of actions on the left (Play / Resume and the run's actions, then places to go, Main menu
// last, above the account), a panel on the right with its own tabs (server, leaderboard, style & bonus, replays, on
// screen, help). Nothing scrolls: the whole rail fits down to 1280×720 at 125 % zoom.
// Keys: ↑/↓ move in the rail (↓ from its last row reaches Main menu), → / ← between rail and panel (→ lands on the
// panel's tabs, ←/→ there switch tabs, ↓ enters the tab), Q / E previous / next tab, Backspace main menu, Esc resumes.

type PauseTab = "board" | "style" | "replays" | "server" | "screen" | "help";

interface RailOpts {
  primary?: boolean;
  hint?: string;
  sub?: string;
  /** An icon name (ui/icons.ts). */
  icon?: IconName;
}

function railItem(label: string, fn: (() => void) | null, o: RailOpts = {}): HTMLElement {
  return h(
    `button.rail-item${o.primary ? ".primary" : ""}`,
    // data-item: a hook custom CSS may rely on (/custom-css). Renaming a label? Keep its old data-item.
    { type: "button", disabled: !fn, onclick: fn ?? undefined, "data-autofocus": o.primary ? "" : undefined, "data-item": itemSlug(label) },
    o.icon ? h("span.ri-icon", { "aria-hidden": "true" }, icon(o.icon, { size: "1.05rem" })) : null,
    h("span.ri-label", null, label, o.sub ? h("small", null, o.sub) : null),
    o.hint ? h("kbd", null, o.hint) : null,
  );
}

/** Card-style action (replays and server tabs). */
function actionCard(label: string, fn: (() => void) | null, o: { sub?: string; hint?: string; icon?: IconName; primary?: boolean } = {}): HTMLButtonElement {
  return h(
    `button.action-card${o.primary ? ".primary" : ""}`,
    { type: "button", disabled: !fn, onclick: fn ?? undefined },
    o.icon ? h("span.ac-icon", { "aria-hidden": "true" }, icon(o.icon, { size: "1.2rem" })) : null,
    h("span.ac-text", null, h("b", null, label), o.sub ? h("small", null, o.sub) : null),
    o.hint ? h("kbd", null, o.hint) : null,
  );
}

/** A small trailing chevron for a text link ("All HUD settings ›"), sat on the text's centre line. */
function chev(): SVGSVGElement {
  const c = icon("chevronRight", { size: "0.95em" });
  c.style.cssText = "display:inline-block;vertical-align:-0.14em;margin-left:0.15em";
  return c;
}

function loadReplayCard(a: MenuActions): HTMLElement {
  const input = h("input", { type: "file", accept: ".bhr,application/octet-stream", hidden: true, tabindex: "-1" });
  input.addEventListener("change", () => input.files?.[0] && a.onLoadReplay(input.files[0]));
  const b = actionCard("Load replay file", () => input.click(), { sub: "From a .bhr file", icon: "upload" });
  b.append(input);
  return b;
}

/**
 * The pause menu's key for Main menu: Backspace (the usual "back" key; nothing in the pause menu uses it, and in game
 * it's unbound except as the tutorial's previous lesson), plus whatever the Main menu bind (Settings → Keys, unbound by
 * default) is on, unless that's a key the pause menu already uses.
 */
const MAIN_MENU_KEY = "Backspace";
const PAUSE_KEYS = new Set(["Escape", "KeyQ", "KeyE", "Enter", "NumpadEnter", "Space", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);
const mainMenuKeys = (): string[] => [MAIN_MENU_KEY, ...(prefs.get().binds.mainMenu ?? []).filter((c) => !c.startsWith("Mouse") && !c.startsWith("MWheel") && !PAUSE_KEYS.has(c))];

/**
 * Leaves for the main menu: a page load without the map / room / replay params. The pause menu's Main menu button
 * and its key, and the in-game Main menu bind (main.ts, which asks once during a timed run: leave-confirm.ts).
 */
export function goToMainMenu(): void {
  allowLeave(); // a deliberate navigation (also from a key): no "Leave site?" prompt
  const url = new URL(appHref());
  url.search = "";
  location.href = url.toString();
}

const bindHint = (a: Action) => {
  const c = prefs.get().binds[a]?.[0];
  return c ? keyLabel(c) : undefined;
};

function resumeAnd(fn: () => void): () => void {
  return () => (fn(), S.hooks?.resume());
}

function styleTab(a: MenuActions, track: number): HTMLElement {
  const selected = a.style ?? "autohop";
  const bonuses = a.bonuses ?? [];
  const cycle = bindHint("cycleStyle");
  let styles: HTMLElement | null = null;
  if (a.onStyle && track) {
    styles = h(
      "div.pp-group",
      null,
      h("div.pp-group-head", null, h("span.kicker", null, "Style")),
      h("div.style-locked", null, `${trackName(track)} · ${styleLabel(BONUS_STYLE)}`, h("small.dim", null, " Bonus tracks are always Normal style. Pick Main to choose a style.")),
    );
  } else if (a.onStyle) {
    const list = h(
      "div.style-list",
      { role: "radiogroup", "aria-label": "Style" },
      ...STYLE_DEFS.map((d) => {
        const pb = getPB(a.map, d.id, 0);
        const on = d.id === selected;
        return h(
          `button.style-row${on ? ".on" : ""}`,
          { type: "button", role: "radio", "aria-checked": String(on), tabindex: on ? "0" : "-1", "data-style": d.id, onclick: () => a.onStyle!(d.id) },
          h("span.sr-short", null, d.short),
          h("span.sr-text", null, h("b", null, d.name), h("small", null, d.rule)),
          h("span.sr-pb", null, h("small", null, "PB"), pb ? h("b", null, formatTime(pb.time)) : h("b.dim", null, "—")),
        );
      }),
    );
    list.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const items = [...list.querySelectorAll<HTMLElement>("button")];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      e.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))].focus();
    });
    styles = h(
      "div.pp-group",
      null,
      h("div.pp-group-head", null, h("span.kicker", null, "Style", h("span.pp-note", null, " · changing it restarts the run")), cycle ? h("span.dim.small", null, h("kbd", null, cycle), " cycles in game") : null),
      list,
    );
  }
  const tracks = a.onTrack && bonuses.length
    ? h(
        "div.pp-group",
        null,
        h("div.pp-group-head", null, h("span.kicker", null, "Track"), bindHint("restartBonus") ? h("span.dim.small", null, h("kbd", null, bindHint("restartBonus")!), " next track") : null),
        h(
          "div.track-list",
          { role: "group", "aria-label": "Tracks" },
          ...[0, ...bonuses].map((t) =>
            h(
              `button.track-btn${t === track ? ".on" : ""}`,
              { type: "button", onclick: resumeAnd(() => a.onTrack!(t)), "aria-pressed": String(t === track) },
              h("b", null, t ? trackName(t) : "Main"),
              h("small", null, t === track ? "playing · restart" : t ? `${styleLabel(BONUS_STYLE)} only` : styleLabel(selected)),
            ),
          ),
        ),
      )
    : null;
  return h("div.pp-style", null, styles, tracks);
}

function replaysTab(a: MenuActions, pb: ReturnType<typeof getPB>): HTMLElement {
  // What the last verified run earned, if it was restarted before the end card's reel finished (hud/reel.ts).
  const reel = lastRunReel();
  return h(
    "div.pp-replays",
    null,
    reel ? h("section.pp-lastrun", null, h("h3", null, "Last run"), reel) : null,
    h(
      "div.card-grid",
      null,
      actionCard("Watch PB replay", a.onWatchPB, { sub: pb ? `${formatTime(pb.time)}, ${pb.jumps} jumps` : "No PB on this track yet", icon: "play", primary: !!a.onWatchPB }),
      actionCard("Watch last run", a.onWatchLast ?? null, { sub: a.onWatchLast ? undefined : "Finish a run first", icon: "restart", hint: a.onWatchLast ? "V" : undefined }),
      actionCard("Export last run", a.onExportLast, { sub: a.onExportLast ? "As a .bhr file" : "Finish a run first", icon: "download" }),
      loadReplayCard(a),
      shareRunCard(a),
    ),
    h("p.pp-foot.dim", null, "In the viewer, E exports an MP4."),
  );
}

/** Share the last verified run of this session (its /replay/<id> page unfurls with the run's card). */
function shareRunCard(a: MenuActions): HTMLElement | null {
  const id = lastVerifiedRun();
  if (!id) return null;
  const card = actionCard("Share your last run", () => void shareWithToast({ url: runUrl(id), title: `${a.map} · bunnyhop.lol` }, "Replay link copied"), { sub: "Copies a link to the verified replay", icon: "share" });
  card.classList.add("ac-wide");
  return card;
}

/**
 * Pause rail's way into the profile. No "new unlocks" line (the profile's dots mark them); loading your profile here
 * still brings up the cards for rewards no run announces (ui/unlocks.ts).
 */
function profileItem(): HTMLElement {
  void myProfile().then(profileNotices);
  return railItem("Profile & ranks", () => void me().then((u) => (u ? openProfile(u.id) : openRanks("all"))), { icon: "account" });
}

/**
 * On screen: the keys overlay and the other HUD pieces players switch most, one click each (ui/quick-toggles.ts: the
 * same switches as the top of Settings → HUD, writing the same prefs; the paused game behind shows the change).
 */
function screenTab(): HTMLElement {
  const editKey = bindHint("hudEditor");
  return h(
    "div.pp-screen.quick-set",
    null,
    group(null, quickGrid()),
    group(null, hideUiSwitch()),
    h(
      "div.pp-screen-foot",
      null,
      hudEditorAvailable() ? h("button.btn.btn-sm", { type: "button", onclick: () => openHudEditor() }, "Edit layout", editKey ? h("kbd", null, editKey) : null) : null,
      h("button.link-btn", { type: "button", onclick: () => (sessionStorage.setItem("bunnyhop:settings-tab", "hud"), push("settings")) }, "All HUD settings", chev()),
    ),
  );
}

/**
 * Help tab: the chat commands and your keys in the same groups as !help (chat-help.ts helpPanelGroups), two columns
 * that fit without scrolling. Every other key and the bhop basics are a link away (Controls).
 */
function helpTab(inRoom: boolean): HTMLElement {
  const groups = helpPanelGroups(chatCommands(), { where: inRoom ? "room" : "solo", game: { key: (a) => bindHint(a as Action) ?? null } });
  const table = (g: (typeof groups)[number]) =>
    h(
      "section.pp-help-group",
      null,
      h("h3", null, g.label),
      h(
        "table.keys-table",
        null,
        h("tbody", null, ...g.rows.map((r) => h("tr", null, h("th", null, r.what), h("td.pp-help-cmd", null, r.cmd ?? ""), h("td", null, r.key ? h("kbd", null, r.key) : "")))),
      ),
    );
  return h(
    "div.pp-help",
    null,
    h("div.pp-help-cols", null, ...groups.map(table)),
    h(
      "div.pp-screen-foot",
      null,
      h("span.dim", null, "Type these in chat (Y). !help <topic> explains one."),
      h("button.link-btn", { type: "button", onclick: () => push("controls") }, "Every key and how to bhop", chev()),
    ),
  );
}

function serverTab(): HTMLElement | null {
  const room = roomPanel(() => S.hooks?.resume());
  if (!room) return null;
  const grid = room.querySelector(".pp-room-actions");
  grid?.insertBefore(actionCard("Switch server", () => push("servers"), { icon: "swap" }), grid.lastElementChild);
  return room;
}

function pauseScreen(): HTMLElement {
  const a = S.actions;
  const map = a?.map ?? "…";
  const selected = a?.style ?? "autohop";
  const track = a?.currentTrack?.() ?? 0;
  const runStyle = styleForTrack(selected as StyleId, track);
  const pb = a ? getPB(a.map, runStyle, track) : null;
  const restartKey = prefs.get().binds.restart[0];
  const inRoom = !!roomPresence();
  const bonuses = a?.bonuses ?? [];
  const tabs: PauseTab[] = [...(inRoom ? ["server" as const] : []), "board", ...(a ? (["style", "replays"] as const) : []), "screen", "help"];
  if (!S.pauseTab || !tabs.includes(S.pauseTab)) S.pauseTab = inRoom ? "server" : "board";

  // --- the panel: its tabs along the top, the tab below
  const labels: Record<PauseTab, string> = {
    server: "Server",
    board: "Leaderboard",
    style: bonuses.length ? "Style & bonus" : "Style",
    replays: "Replays",
    screen: "On screen",
    help: "Help",
  };
  // (The icons these had as rail rows.)
  const tabIcons: Record<PauseTab, IconName> = { server: "server", board: "board", style: "diamond", replays: "play", screen: "hud", help: "help" };
  const tabBar = h(
    "div.pp-tabs",
    { role: "tablist", "aria-label": "Panel" },
    ...tabs.map((t) =>
      h(
        "button.pp-tab",
        { type: "button", role: "tab", id: `pp-tab-${t}`, "data-ptab": t, "aria-controls": "pause-panel", onclick: () => show(t) },
        h("span.ri-icon", { "aria-hidden": "true" }, icon(tabIcons[t], { size: "1rem" })),
        labels[t],
      ),
    ),
  );
  tabBar.classList.add("hop-host");
  hopIndicator(tabBar, ".pp-tab", { axis: "x", side: "end", inset: 4, selected: ".on" });
  const panelBody = h("div.pp-body", { id: "pause-panel", role: "tabpanel" });
  const show = (t: PauseTab, animate = true) => {
    const changed = t !== S.pauseTab || !panelBody.firstElementChild;
    S.pauseTab = t;
    for (const b of tabBar.querySelectorAll<HTMLElement>(".pp-tab")) {
      const on = b.dataset.ptab === t;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    panelBody.setAttribute("aria-labelledby", `pp-tab-${t}`);
    if (!changed) return;
    let content: HTMLElement | null = null;
    // (The tutorial: only its final course has a board; its main track, the lessons, is never submitted.)
    if (t === "board") content = a ? leaderboardPanel(a.map, selected, a.map === TUTORIAL_MAP ? TUTORIAL_BOARD : { tracks: [0, ...bonuses], track }) : null;
    else if (t === "style" && a) content = styleTab(a, track);
    else if (t === "replays" && a) content = replaysTab(a, pb);
    else if (t === "server") content = serverTab();
    else if (t === "screen") content = screenTab();
    else if (t === "help") content = helpTab(inRoom);
    panelBody.replaceChildren(...(content ? [content] : []));
    if (animate && !reducedMotion()) {
      panelBody.classList.remove("swap");
      void panelBody.offsetWidth;
      panelBody.classList.add("swap");
    }
  };
  const panel = h(
    "section.pause-panel",
    { "aria-label": "Pause menu panel" },
    h("header.pp-head", null, tabBar),
    panelBody,
  );

  // --- the rail: Play / Resume and the run's own actions, then places to go, then Main menu as the last row (pinned
  // above the account, well away from Play, in its own colour: it leaves the map and ends the run)
  const homeKey = mainMenuKeys();
  const home = railItem("Main menu", goToMainMenu, { hint: keyLabel(homeKey[1] ?? homeKey[0]), icon: "leave" });
  home.classList.add("pause-home");
  const sep = () => h("div.rail-sep", { role: "separator" });
  const feedback = api.available() ? railItem("Feedback", () => openFeedback(), { icon: "pen" }) : null;
  const inbox = api.available() ? withInboxBadge(railItem("Inbox", () => openInbox(), { icon: "mail" })) : null;
  const rail = h(
    "nav.rail-list",
    { "aria-label": "Pause menu" },
    railItem(S.started ? "Resume" : "Play", () => S.hooks?.resume(), { primary: true, hint: S.started ? "Esc" : undefined, icon: "play" }),
    S.started ? railItem("Restart", resumeAnd(() => S.hooks?.restart()), { hint: restartKey ? keyLabel(restartKey) : undefined, icon: "restart", sub: track ? trackName(track) : undefined }) : null,
    a && track && a.onTrack ? railItem("Main track", resumeAnd(() => a.onTrack!(0)), { hint: bindHint("restartMain"), icon: "home" }) : null,
    a?.practice && S.started
      ? railItem(a.practice.on ? "Leave practice" : "Practice", resumeAnd(a.practice.toggle), {
          hint: bindHint("practice"),
          icon: "flag",
          sub: a.practice.on ? "Back to the start" : "Every run is practice",
        })
      : null,
    sep(),
    inRoom ? null : railItem("Play online", () => push("servers"), { icon: "globe", sub: api.available() ? undefined : "offline" }),
    railItem("Change map", () => push("maps"), { icon: "grid", sub: inRoom ? "leaves the server" : undefined }),
    // (Unless the player hid the tutorial: tutorial/flag.ts. "Change map" still has it at the top, or a search away.)
    tutorialPrompt() && !inRoom && map !== TUTORIAL_MAP ? railItem("Learn to bhop", () => openTutorial(), { icon: "spark" }) : null,
    sep(),
    railItem("Loadout", () => openLoadout(), { icon: "viewmodel" }),
    railItem("Settings", () => push("settings"), { icon: "tune" }),
    profileItem(),
    feedback || inbox ? sep() : null,
    feedback || inbox ? h("div.rail-pair", null, feedback, inbox) : null,
    h("div.rail-fill", { "aria-hidden": "true" }),
    home,
  );
  arrowNav(rail, "button");
  rail.classList.add("hop-host");
  hopIndicator(rail, ".rail-item", { inset: 6, rest: () => rail.querySelector<HTMLElement>(".rail-item.primary") });

  const left = h(
    "div.pause-rail",
    null,
    h(
      "header.pause-head",
      null,
      h("div.pause-top", null, wordmark("sm")),
      h("h2.pause-map", { title: map }, map),
      h("p.pause-meta", null, S.tier !== undefined ? tierBadge(S.tier) : null, h("span", null, `${track ? trackName(track) + " · " : ""}${styleLabel(runStyle)}`), pb ? h("span.pause-pb", null, "PB ", h("b", null, formatTime(pb.time))) : null),
    ),
    rail,
    h("footer.pause-foot", null, accountChip({ quiet: true }), versionButton(), supportLink("pause-support"), legalLinks()),
  );
  const screen = h("section.pause", null, left, panel);

  // --- keys: ↑ / ↓ along the rail (Main menu is its last row); → from the rail lands on the panel's tabs, where ← / →
  // switch tabs (← from the first returns to the rail) and ↓ enters the tab; ← from a tab's leftmost control returns to
  // its tab; Q / E cycle tabs from anywhere; Backspace (or the Main menu bind) leaves for the main menu.
  const railButtons = () => [...rail.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
  let lastRail: HTMLElement | null = null;
  rail.addEventListener("focusin", (e) => (lastRail = e.target as HTMLElement));
  const focusTab = () => tabBar.querySelector<HTMLElement>(".pp-tab.on")?.focus({ preventScroll: true });
  const focusRail = () => (lastRail?.isConnected ? lastRail : railButtons()[0])?.focus({ preventScroll: true });
  // (→ in the capture phase: before arrowNav, which takes → as "next item" and would move the remembered item.)
  rail.addEventListener("keydown", (e) => e.key === "ArrowRight" && (e.preventDefault(), e.stopPropagation(), focusTab()), { capture: true });
  tabBar.addEventListener("keydown", (e) => {
    const i = tabs.indexOf(S.pauseTab!);
    if (e.key === "ArrowDown") {
      const first = panelBody.querySelector<HTMLElement>("button:not([disabled]), [href], input, select");
      if (first) (e.preventDefault(), first.focus());
      return;
    }
    const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
    if (j === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (j < 0) return focusRail();
    show(tabs[Math.min(j, tabs.length - 1)]);
    focusTab();
  });
  panelBody.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" || e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement || t.closest(".style-seg, .lb-tabrow, .track-list, .card-grid") && !isFirstInRow(t)) return;
    e.preventDefault();
    focusTab();
  });
  const onKey = (e: KeyboardEvent) => {
    if (!screen.isConnected) return removeEventListener("keydown", onKey);
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || (e.target as HTMLElement) instanceof HTMLInputElement) return;
    // Main menu: only while this menu is what's showing (not in game behind the hidden overlay, not under a dialog or
    // in a text box).
    if (homeKey.includes(e.code)) {
      const t = e.target as HTMLElement;
      if (e.defaultPrevented || t.closest?.("textarea, select, [contenteditable]") || document.querySelector("dialog[open]")) return;
      if (overlay().classList.contains("hidden") || S.hooks?.locked() || S.hooks?.watching() || top() !== "pause") return;
      e.preventDefault();
      goToMainMenu();
      return;
    }
    const k = e.key.toLowerCase();
    if (k !== "q" && k !== "e") return;
    const i = tabs.indexOf(S.pauseTab!);
    show(tabs[(i + (k === "e" ? 1 : -1) + tabs.length) % tabs.length]);
    if ((document.activeElement as HTMLElement)?.closest(".pp-tabs")) focusTab();
  };
  addEventListener("keydown", onKey);
  show(S.pauseTab, false);
  return screen;
}

/** Leftmost focusable of a horizontal group (← from there leaves the panel). */
function isFirstInRow(t: HTMLElement): boolean {
  const g = t.closest<HTMLElement>(".style-seg, .lb-tabrow, .track-list, .card-grid");
  if (!g) return true;
  const items = [...g.querySelectorAll<HTMLElement>("button:not([disabled])")];
  const left = Math.min(...items.map((x) => x.getBoundingClientRect().left));
  return t.getBoundingClientRect().left <= left + 1;
}

function controlsHelp(): HTMLElement {
  const b = prefs.get().binds;
  const keys = (codes: string[]) => (codes.length ? codes.map((c) => h("kbd", null, keyLabel(c))) : [h("span.dim", null, "unbound")]);
  const rows: [string, HTMLElement[]][] = ACTIONS.map((a) => [a.label, keys(b[a.id])]);
  rows.push(["Pause / menu", [h("kbd", null, "Esc")]]);
  return h(
    "div.controls",
    null,
    h(
      "div.tips",
      null,
      h("h3", null, "Keys"),
      h("table.keys-table", null, h("tbody", null, ...rows.map(([label, k]) => h("tr", null, h("th", null, label), h("td", null, ...k))))),
      h("button.btn.btn-sm", { type: "button", onclick: () => push("settings") }, "Rebind keys…"),
    ),
    h(
      "div.tips",
      null,
      h("h3", null, "How to bhop"),
      h(
        "ol",
        null,
        h("li", null, "Hold jump (autohop) or scroll to jump the moment you land."),
        h("li", null, "In the air, don't hold W. Hold ", h("kbd", null, "A"), " while moving the mouse left, ", h("kbd", null, "D"), " while moving it right."),
        h("li", null, "Smooth, synced strafes gain speed; the speedometer turns green while you gain."),
        h("li", null, "Stand in the green start zone, then run or jump out to start the timer (a jump counts from takeoff); touch the red end zone to finish. Prespeed is capped at 290 u/s."),
        h("li", null, "Cyan / magenta zones are bonus tracks, timed and ranked separately (always Normal style). Orange zones are stage splits."),
      ),
      h("h3", null, "Styles"),
      h(
        "p.dim",
        null,
        "Pick one in the map browser or the pause menu, or press ",
        ...keys(b.cycleStyle ?? ["F3"]),
        " to cycle. Normal: autohop. EZ Scroll: press jump for every hop. Legit Scroll: 250 run speed, 100 AA and stamina. W-Only: only W in the air. Sideways: only W/S. Half-Sideways: W plus A or D. Keys are only restricted in the air; each style has its own PBs and leaderboards.",
      ),
    ),
    h(
      "div.tips",
      null,
      h("h3", null, "Replays"),
      h("p.dim", null, "Every finished run keeps a tick-exact replay. The viewer (", h("kbd", null, "V"), " after a run, Watch PB, leaderboard Watch) has a timeline with speed graph, 0.1×–4× speed, tick stepping, five cameras, compare mode and MP4 export (", h("kbd", null, "E"), "). Press ", h("kbd", null, "?"), " in the viewer for every key."),
      h("h3", null, "HUD layout"),
      h("p.dim", null, "Press ", ...keys(b.hudEditor ?? ["F2"]), " in game to drag, resize and toggle HUD elements, apply presets or share your layout as a code."),
      h("h3", null, "Credits"),
      h(
        "p.dim",
        null,
        "Maps © their authors. Timer zones and tiers: ",
        h("a", { href: "https://github.com/srcwr/zones-cstrike", target: "_blank", rel: "noopener" }, "srcwr/zones-cstrike"),
        " (cutehops by may/lilac, sourcejump by Eric).",
      ),
      ...audioCredits().map((c) => h("p.dim.credit-audio", null, c)),
    ),
  );
}

/**
 * Loading a map: its art full-bleed on a leaning plate (an amber edge leading it) that slides in over the screen you
 * left, then pushes in slowly while you wait; the name huge at the bottom left, landing with a hop, the tier as coloured
 * text over it, one dim stage line under it; progress is a 2 px line along the very bottom edge with the white dot
 * riding its tip. One tip, no "Tip:".
 */
function loadingScreen(): HTMLElement {
  const title = h("h2.load-name", null, "");
  const art = h("div.load-art");
  const sub = h("div.load-sub");
  const stage = h("span.load-stage", null, "Starting…");
  const detail = h("span.load-detail", null, "");
  const fill = h("div.load-fill");
  const dot = h("i.load-dot", { "aria-hidden": "true" });
  const bar = h("div.load-bar", { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0", "aria-label": "Loading map" }, fill);
  const root = h(
    "section.loading",
    null,
    h("div.load-plate", { "aria-hidden": "true" }, h("div.load-plate-in", null, art, h("div.load-shade"))),
    h("div.load-text", null, sub, title, h("div.load-row", null, stage, detail)),
    h("p.load-tip", null, tip()),
    bar,
    dot,
  );
  S.loading = { root, title, stage, bar, detail, fill, dot, art, sub };
  return root;
}

/** Full motion: not under prefers-reduced-motion or body.potato (those get plain fades). */
const fullMotion = () => !reducedMotion() && !document.body.classList.contains("potato");

/**
 * Leaving a screen for a map (render, before the loading screen goes in): the screen stays where it is and takes off
 * under the loading screen's entrance, the background camera pulls back and pushes in (attract.ts leave; a frozen or
 * still background gets the push in CSS), the scrim lifts so you see it. Overlaps the download, never delays it.
 * Returns the old screen's #menu classes (kept until it's gone) or null when there's nothing to leave or no motion.
 */
let leaveTimer = 0;
function startLeave(r: HTMLElement): { screens: string } | null {
  const old = r.firstElementChild as HTMLElement | null;
  if (!old || old.classList.contains("loading") || reducedMotion()) return null;
  endLeave();
  const screens = [...r.classList].filter((c) => c.startsWith("screen-")).join(" ");
  old.classList.add("menu-leave");
  old.inert = true;
  const b = document.body.classList;
  b.add("leaving");
  if (fullMotion()) {
    S.leaveLive = attractLeave();
    if (!S.leaveLive) b.add("leave-push");
  }
  uiOpen();
  // The plate has covered everything by now: drop the old screen, freeze what's behind (ui/backdrop.ts).
  leaveTimer = window.setTimeout(() => {
    old.remove();
    r.classList.remove("leaving", ...screens.split(" ").filter(Boolean));
    endLeave();
  }, 700);
  return { screens };
}

function endLeave(): void {
  clearTimeout(leaveTimer);
  root().querySelectorAll(":scope > .menu-leave").forEach((el) => el.remove());
  document.body.classList.remove("leaving", "leave-push");
  if (S.leaveLive) {
    S.leaveLive = false;
    syncBackdrop();
  }
}

/**
 * Loading done (showReady): the loading screen moves out of the menu to a layer over the game, and lifts off when the
 * game has drawn its first frames (revealGame; heavy maps can take a few hundred ms for the first ones). Null when
 * there's no loading screen up.
 */
let liftFallback = 0;
function liftLoading(): HTMLElement | null {
  const l = S.loading?.root;
  if (!l?.isConnected) return null;
  endLeave();
  document.getElementById("load-lift")?.remove();
  // Moving it restarts its CSS animations: hold everything where it is (the art's push-in included) instead.
  const art = l.querySelector<HTMLElement>(".load-art");
  if (art) art.style.transform = getComputedStyle(art).transform;
  l.classList.add("lifted");
  const layer = h("div#load-lift", { "aria-hidden": "true" }, l);
  document.body.append(layer);
  document.body.classList.add("arrive-wait");
  liftFallback = window.setTimeout(revealGame, 2500);
  return layer;
}

/**
 * main.ts, once the game has drawn a few frames: the loading screen lifts off (the text takes off, the plate grows and
 * fades) while the arrival camera swoops down into first person under it; body.arrive lands the HUD and brings the
 * pause menu / "Click to start" in after it.
 */
export function revealGame(): void {
  clearTimeout(liftFallback);
  const layer = document.getElementById("load-lift");
  const l = layer?.firstElementChild;
  if (!layer || !l || l.classList.contains("lift-go")) return;
  const b = document.body.classList;
  b.remove("arrive-wait");
  b.add("arrive");
  l.classList.add("lift-go");
  const done = () => layer.remove();
  l.querySelector(".load-plate")?.addEventListener("animationend", done, { once: true });
  window.setTimeout(done, 900);
  window.setTimeout(() => b.remove("arrive"), 1600);
}

const TIPS = [
  "The scroll wheel jumps too. Rebind it in Settings → Keys.",
  "The speedometer turns green while you gain speed. Smooth, synced strafes beat a fast mouse.",
  "Your PB ghost races you on every attempt. Add the WR or any leaderboard run in Settings → Ghost.",
  "Type !cp for the checkpoint menu. A teleport or noclip makes the run practice until you restart.",
  "Sensitivity uses CS:S units, so your config value works as is.",
];
function tip(): string {
  return TIPS[Math.floor(Math.random() * TIPS.length)];
}

// ---------------------------------------------------------------------------------------------
// Profiles + ranks (ui/profile.ts, ui/ranks.ts)

function dropRouteParams(): void {
  const url = new URL(appHref());
  if (!url.searchParams.has("u") && !url.searchParams.has("ranks")) return;
  url.searchParams.delete("u");
  url.searchParams.delete("ranks");
  history.replaceState(null, "", url);
}

/**
 * A profile is a page of its own: opening one pushes /u/<id> (so the browser's Back returns to the board it came from
 * and the address is shareable); another profile replaces it; leaving puts the previous address back. Not over a
 * running game (its address carries the map).
 */
// The app's address (platform/navigation.ts: the Wavedash build's frame keeps it in ?bh=); the real one on the site.
const profileHistory = new ProfileHistory({ get location() { return appLocation(); }, history });
function syncProfileUrl(s: Screen | undefined): void {
  profileHistory.sync(s === "profile" ? S.profileId : null);
}

function openProfile(id: string, open: ProfileOpen = {}): void {
  if (id !== S.profileId || open.tab) S.profileOpen = open;
  S.profileId = id;
  if (top() === "profile") render();
  else push("profile");
}

function openRoute(r: NavRequest): void {
  if (r.screen === "profile") openProfile(r.id, { tab: r.tab as ProfileOpen["tab"], slot: r.slot });
  else if (r.screen === "stats") { if (top() !== "stats") push("stats"); }
  else if (r.screen === "ranks") openRanks(r.scope ?? "all", r.page);
  else if (r.screen === "maps") {
    S.mapsFocus = r.focus ?? null;
    if (top() !== "maps") push("maps");
    else render();
  } else if (r.screen === "loadout") openLoadout(r.slot);
  else if (r.screen === "support") {
    if (top() !== "support") push("support");
  } else if (r.screen === "gauntlets") {
    if (top() !== "gauntlets") push("gauntlets");
  } else if (r.screen === "gauntlet") openGauntlet(r.slug, r.attempt ?? null);
  else if (top() !== "servers") push("servers");
}

/**
 * The Loadout (knife, finish, gloves), optionally on a slot: your profile's Loadout tab. Offline, or before the account
 * answers, the profile screen shows the Loadout alone (kept on this device).
 */
function openLoadout(slot?: string | null): void {
  const go = (id: string) => openProfile(id, { tab: "loadout", slot: slot ?? null });
  if (!api.available()) return go("");
  void me().then((u) => go(u?.id ?? ""), () => go(""));
}

/** Your own profile, on a tab ("card": the card editor). Offline: the Loadout alone. */
function openMyProfile(open: ProfileOpen): void {
  if (!api.available()) return openProfile("", { tab: "loadout" });
  void me().then((u) => openProfile(u?.id ?? "", u ? open : { tab: "loadout" }), () => openProfile("", { tab: "loadout" }));
}

function openRanks(scope: string, page = 1): void {
  S.ranksScope = scope;
  S.ranksPage = page;
  if (top() === "ranks") render();
  else push("ranks");
}

/** A gauntlet's page, or an attempt's result (ui/gauntlets.ts); replaces the gauntlet screen if it's showing. */
function openGauntlet(slug: string, attempt: string | null): void {
  S.gauntlet = { slug, attempt };
  if (top() === "gauntlet") render("in", true);
  else push("gauntlet");
}

function gauntletActions(): GauntletScreens {
  return { open: (slug, attempt) => openGauntlet(slug, attempt ?? null) };
}

/** The map list's header in game: the map, and where a set played in order is (map-queue.ts). */
function playingLine(map: string): string {
  const q = readQueue();
  return q && q.maps[q.at] === map ? `playing ${map}, ${queueLine(q)}` : `playing ${map}`;
}

/** A toast from a menu screen (notify/: the one notification system; bottom centre over menus). */
export function menuToast(msg: string, ms?: number): void {
  notifyToast(msg, { ms });
}

function goToMap(map: string, style?: string, extra: Record<string, string> = {}): void {
  if (style) setSelectedStyle(style as Parameters<typeof setSelectedStyle>[0]);
  if (!Object.keys(extra).length) return pickMap(map);
  const url = new URL(location.origin + "/");
  url.searchParams.set("map", map);
  if (style) url.searchParams.set("style", style);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  location.href = url.toString();
}

/** Guests' "save progress": the account flow's entry point (ui/nav.ts onSaveProgress), else link Discord. */
function saveProgress(): void {
  requestSaveProgress(() => {
    try {
      location.href = api.discordLoginUrl(appHref());
    } catch {
      menuToast("Accounts are offline");
    }
  });
}

function profileActions(): ProfileActions {
  return {
    play: (map, style) => goToMap(map, style),
    // Replay viewer (viewer/request.ts): opens in place on this map, else loads the run's map with the viewer open.
    watch: (r: RunCard) => openReplayViewer({ runId: r.runId }),
    race: (r: RunCard, player: string) => {
      const req: Extract<RaceRequest, { kind: "run" }> = { kind: "run", runId: r.runId, name: `${player} · ${formatTime(r.time)}`, track: r.track, time: r.time };
      if (S.inGame && S.actions?.map === r.map) {
        requestRace(req);
        menuToast(`Racing ${player}'s ghost`);
        reset("pause");
      } else if (!S.inGame) {
        requestRace(req); // queued until the session starts listening
        goToMap(r.map, r.style);
      } else {
        requestRaceAfterReload(req);
        goToMap(r.map, r.style, { race: "1" });
      }
    },
    ranks: (scope) => openRanks(scope ?? "all"),
    toast: (m) => menuToast(m),
    // Guests: the account flow's entry point (ui/account.ts owns it; today that's linking Discord).
    saveProgress: api.available() ? () => saveProgress() : null,
    onTab: (tab: ProfileTab) => (S.profileOpen = { tab }),
  };
}

// ---------------------------------------------------------------------------------------------
// Public API (main.ts)

/** Installs Esc / pointer-lock / backdrop handling. Call once at startup. */
export function initMenu(hooks: ShellHooks): void {
  S.hooks = hooks;
  initGamepadNav(() => !overlay().classList.contains("hidden") && !hooks.locked() && !hooks.watching());
  // Joined / left a multiplayer room: the pause screen gains / loses its room block.
  onRoomPresence((r) => {
    S.pauseTab = r ? "server" : null;
    if (top() === "pause" && S.inGame) render();
  });
  // Profile links from anywhere (leaderboard rows, ranks, account chip).
  onNavigate((r) => {
    setVisible(true);
    openRoute(r);
  });
  overlay().addEventListener("click", (e) => {
    // Clicking the dimmed backdrop (outside any panel) resumes play, like the old "click to play".
    if (e.target === overlay() && S.inGame && top() === "pause") hooks.resume();
  });
  document.addEventListener("pointerlockchange", () => {
    if (hooks.watching()) return;
    if (hooks.locked()) {
      S.started = true;
      setVisible(false);
    } else if (S.inGame) {
      S.lockLostAt = performance.now();
      reset("pause");
      setVisible(true);
    }
  });
  document.addEventListener("keydown", (e) => {
    // Not a held Esc's repeats (one press, one toggle), not an Esc something else already handled (a dialog, the
    // play-lock veil, Esc-to-pause under keyboard lock).
    if (e.key !== "Escape" || e.repeat || e.defaultPrevented || hooks.watching() || hooks.locked() || overlay().classList.contains("hidden")) return;
    // Esc in a modal dialog over the menu closes the dialog only.
    if (modalOpen()) return;
    const t = top();
    if (t === "loading") return;
    if (S.stack.length > 1) {
      e.preventDefault();
      pop();
    } else if (t === "pause" && performance.now() - S.lockLostAt > 400) {
      // The Esc that released pointer lock also lands here; ignore it, resume on the next one. If the browser refuses
      // the lock (Esc isn't user activation), play-lock.ts swaps the menu for its "Click to resume" veil.
      e.preventDefault();
      hooks.resume();
    }
  });
}

/** Main menu; resolves with the chosen map (no page reload). */
export function showHome(): Promise<string> {
  setVisible(true);
  reset("home");
  // Deep links (ui/nav.ts routeFromUrl, server-rendered with per-page meta): /u/<id> a profile, /ranks the rank board,
  // /maps the map browser (/maps/<name> previewing that map), /servers the server browser; on top of the home screen.
  const route = routeFromUrl();
  if (route) {
    if (route.screen !== "profile" && appLocation().pathname !== "/") history.replaceState(null, "", `/${appLocation().search}`);
    // ?support (the About page's link) is a one-off: dropped once the page is open.
    if (route.screen === "support") history.replaceState(null, "", "/");
    openRoute(route);
  }
  // Sign-in returns (?signin=<email link token>, ?login=discord) first, then the first-visit intro (ui/onboarding.ts).
  // Not over a shared link (a map, profile, the servers: show what was shared; the intro waits for the next visit) and
  // not for search / social crawlers rendering the page.
  const intro = !route && !/bot\b|bot\/|crawler|spider|Google-InspectionTool/i.test(navigator.userAgent);
  void handleAuthReturn()
    .then((msg) => {
      if (msg) (accountChanged(), menuToast(msg, 3600));
    })
    .then(() => (intro && onboardingMaybeNeeded() ? loadOnboarding().then((m) => m.maybeStartOnboarding({ pick: pickMap })) : undefined));
  return new Promise((resolve) => (S.pickResolve = resolve));
}

/** A button on the loading or error screen. */
export interface LoadAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

export interface LoadingView {
  /** frac 0..1 or null for indeterminate. */
  stage(text: string, frac: number | null, detail?: string): Promise<void>;
  /** A line under the progress row with optional buttons (slow downloads: "Play without textures"); null hides it. */
  notice(text: string | null, actions?: LoadAction[]): void;
}

export function showLoading(map: string): LoadingView {
  stopMenuWork();
  setVisible(true);
  S.pickResolve = null;
  reset("loading", true);
  const l = S.loading!;
  l.title.textContent = map;
  // Map art: at once when the index is already in (a pick from the menu), so the plate slides in with it; else when it
  // comes (a link straight to a map). Then the author.
  const known = mapImages(map);
  if (known) {
    l.art.replaceWith((l.art = mapArt(map, null, { eager: true, className: "load-art" })));
    // The tile's picture is in the cache: it holds the plate (instead of the blurred preview) until the render loads.
    if (known.thumbnail && known.hero && known.thumbnail !== known.hero)
      l.art.insertBefore(h("img.load-card", { src: known.thumbnail, alt: "", decoding: "async" }), l.art.querySelector("img.full"));
  }
  void Promise.all([fetchMapIndex(), onlineMaps()]).then(([maps, online]) => {
    const m = maps.find((x) => x.name === map);
    if (!m || S.loading !== l) return;
    if (!known) l.art.replaceWith((l.art = mapArt(map, online?.get(map)?.thumbnailUrl ?? m.thumbnail ?? null, { eager: true, className: "load-art" })));
    if (m.author) l.sub.append(h("span.load-author", null, `by ${m.author}`));
  });
  // The name's landing (style.css .load-name), quietly.
  if (fullMotion()) window.setTimeout(() => S.loading === l && uiSound("ui_land", 0.55), 640);
  // Tier on the loading screen, as coloured text ("T5 Very hard").
  void mapTier(map).then((t) => {
    S.tier = t;
    const c = clampTier(t);
    if (S.loading === l) l.sub.prepend(h(`span.load-tier.hud-tier${c ? `.t${c}` : ""}`, null, c ? `${tierLabel(c)} ${tierName(c)}` : "Unrated"));
  });
  return {
    async stage(text, frac, detail = "") {
      const l = S.loading;
      if (!l) return;
      // Stage timings for the devtools timeline and tools/perf/hitch-probe.ts.
      if (l.stage.textContent !== text) performance.mark(`loading: ${text}`);
      l.stage.textContent = text;
      l.detail.textContent = detail;
      l.bar.classList.toggle("indeterminate", frac === null);
      l.dot.classList.toggle("off", frac === null);
      if (frac !== null) {
        const f = Math.max(0, Math.min(1, frac));
        l.fill.style.transform = `scaleX(${f})`;
        l.dot.style.transform = `translateX(calc(${f} * (100vw - 100%)))`;
        l.bar.setAttribute("aria-valuenow", String(Math.round(frac * 100)));
      }
    },
    notice(text, actions = []) {
      if (!S.loading) return;
      // A sticky Notice (notify/) until the load moves on: the bunny leads it and waits with you (sleepy while the
      // download is stuck, thinking otherwise), with the one thing you can do about it.
      if (text === null) return dismissKey("load-stall");
      const mood = /while|stall|retry/i.test(text) ? "sleepy" : "thinking";
      const a = actions[0];
      notifyToast(text, { key: "load-stall", ms: 10 * 60_000, lead: mascot(mood).el, action: a ? { label: a.label, run: () => a.onClick() } : undefined });
    },
  };
}

/**
 * Loading finished: show the pause menu in "ready" state (a click is needed for pointer lock). `menu: false` (a new
 * player's first look, main.ts): the pause screen is built but stays hidden for play-lock.ts's "Click to start" line;
 * Esc brings it up.
 */
export async function showReady(o: { menu?: boolean } = {}): Promise<void> {
  S.inGame = true;
  // Out of a map load: the loading screen lifts off over the game (liftLoading) and the pause menu comes in under it.
  const lifted = !!liftLoading();
  S.loading = null;
  document.body.classList.add("in-game");
  const menu = o.menu ?? true;
  reset("pause", menu && !lifted);
  setVisible(menu);
  await afterPaint();
}

/**
 * play-lock.ts: hides the pause menu behind its "Click to resume" veil (pointer lock refused), or brings it back
 * (Esc on the veil). The menu's screen stack is untouched.
 */
export function setPauseMenuVisible(v: boolean): void {
  if (!S.inGame) return;
  setVisible(v);
  if (v) root().querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
}

/**
 * Error screen: the sad bunny on a floor line, a plain title, the human sentence, then the raw cause (faint mono).
 * `actions` (map loads: Retry, Play without textures) come before the way back: "Back to maps" (`back: "maps"`, a map
 * that isn't there) or "Back to main menu".
 */
export function showError(title: string, detail: string, actions: LoadAction[] = [], o: { cause?: string; back?: "maps" | "home" } = {}): void {
  setVisible(true);
  sfx("ui_error");
  S.loading = null;
  endLeave();
  dismissKey("load-stall");
  const toMaps = o.back === "maps";
  const back = h(actions.length ? "button.btn" : "button.btn.primary", { type: "button", onclick: () => (toMaps ? (location.href = "/maps") : (location.search = ""), undefined) }, toMaps ? "Back to maps" : "Back to main menu");
  const bunny = mascot("sad", { size: "7rem" });
  root().replaceChildren(
    h(
      "section.error-screen",
      { role: "alert" },
      wordmark("sm"),
      h("div.error-floor", null, bunny.el),
      h("h2", null, title),
      detail ? h("p", null, detail) : null,
      o.cause ? h("code.error-cause", null, o.cause) : null,
      h("div.btn-row", null, ...actions.map((a) => h(a.primary ? "button.btn.primary" : "button.btn", { type: "button", onclick: () => a.onClick() }, a.label)), back),
    ),
  );
  window.setTimeout(() => bunny.react("jolt"), 260);
  root().querySelector<HTMLElement>(".error-screen button")?.focus({ preventScroll: true });
}

/** The in-game overlay menu (shown while paused). Called by the session after runs / PB changes. */
export async function renderMenu(a: MenuActions): Promise<void> {
  S.actions = a;
  // Refresh the pause screen in place if it's showing (new PB, export available, ...).
  if (top() === "pause" && S.inGame && !overlay().classList.contains("hidden")) {
    const focused = document.activeElement?.textContent;
    render();
    if (focused) [...root().querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === focused)?.focus();
  }
}
