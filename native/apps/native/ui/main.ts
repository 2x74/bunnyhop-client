import { applySemanticPalette } from "./semantic-palette";
import { NativeWorldRecord } from "./world-record";
import { NativeHudLeaderboard, type BoardContext } from "./hud-leaderboard";
import { forgetBoards, placeBoard, worldRecord } from "../../web/src/shared-reads";
import "../../web/src/style.css";
import "./native.css";
import { paintLoading } from "./loading-panel";
import { api } from "../../web/src/api";
import { accountChanged, setReplayIntro } from "../../web/src/ui/account-state";
import { localName } from "../../web/src/ui/account";
import { h } from "../../web/src/ui/dom";
import { mapBrowser, closeMapPanel } from "../../web/src/ui/maps";
import { onNavigate } from "../../web/src/ui/nav";
import { onViewerRequest } from "../../web/src/viewer/request";
import { onRaceRequest } from "../../web/src/player/race";
import { applyState, openAuth, openExternal, runSeconds, send, state, onBeforeSend, LIVE_ORIGIN } from "./bridge";
import { NativeActivityService } from "./activity-service";
import { accountGeneration } from "../../web/src/ui/account-state";
import { countJump, recordMapPlayed } from "../../web/src/ui/stats";
import { mapTime } from "../../web/src/map-time";
import { NativeRunService } from "./run-service";
import { profileDpi } from "./profile-mouse";
import { formatTime } from "../../web/src/timer";
import { isStyleId } from "../../web/src/styles";
import { onStyleChange, setSelectedStyle } from "../../web/src/ui/style-picker";
import { settingsPanel, focusSettingsSection } from "./settings-panel";
import {
  replayPanel,
  replayViewer,
  watchRequest,
  raceRequest,
  gauntletWatchDeps,
  sendReplay,
  playLocalReplay,
} from "./replays";
import { applyReplayHostState, applyReplayTimeline } from "./replay-host";
import { practiceFromReplay } from "./replay-practice";
import { applyChatFeatures } from "./chat-features";
import { hostScoreboard, ScoreboardFeed } from "./host-decoration";
import { legalLinks } from "../../web/src/ui/legal";
import { installMuteButton } from "./mute-button";
import { installTutorialProgress } from "./tutorial-entry";
import { watchGauntletSplit } from "./gauntlet-watch";
import { NativeRoomService } from "./room-service";
import { RoomConnection } from "../../web/src/net/room";
import { setRoomPresence, setRaceTag, currentRoom, currentRace } from "../../web/src/net/presence";
import { serverBrowser } from "../../web/src/ui/servers";
import { keyLabel } from "../../web/src/ui/settings";
import { roomPanel } from "./rooms-panel";
import { safeNativeChatUrl } from "./chat-links";
import { NativeChatService } from "./chat-service";
import { RoomAccountBoundary } from "./room-account";
import { installNativeUiAudio } from "./audio";
import { initDock } from "../../web/src/social/dock";
import { initSocial, refreshFriends, setPlaying, setWatching } from "../../web/src/social/state";
import { ranksScreen, leaveRanksUrl } from "../../web/src/ui/ranks";
import { statsScreen } from "../../web/src/ui/stats-screen";
import { profilePanel } from "./profile-panel";
import type { ProfileOpen } from "../../web/src/ui/profile";
import { nativeSupportScreen } from "./support-panel";
import { openAccountPanel } from "./account-panel";
import { tutorialPanel } from "./tutorial-panel";
import { nativeNavigate } from "./navigation";
import { cosmeticsPanel, initCosmetics } from "./cosmetics";
import { creditsPanel } from "./credits";
import { homeScreen, watchMenuMotion, LAST_MAP } from "./home-menu";
import { pauseScreen } from "./pause-menu";
import { setGameInfo } from "../../web/src/feedback/state";
import { latestMouseDiagnostics } from "./mouse-diagnostics";
import { installMenuBackdrop, requestBackdrop, syncBackdrop } from "./menu-backdrop";
import {
  gauntletResult,
  gauntletScreen,
  gauntletsScreen,
  leaveGauntletUrl,
  type GauntletScreens,
} from "../../web/src/ui/gauntlets";
import { isAttemptId } from "../../web/src/gauntlet/state";
import { watchFromUrl } from "../../web/src/gauntlet/watch";
import { practiceReason } from "../../web/src/practice";
import { NativeGauntlet } from "./gauntlet-native";
import { installNowPlaying } from "./music-now";
import { leaveMapTeardown } from "./map-lifecycle";
import { initCustomCss } from "./custom-css/custom-css";
import { installHudTheme } from "./custom-css/hud-theme";

import { installGamepadNavigation } from "./gamepad";
import { maybeStartOnboarding, openOnboarding } from "./onboarding";

type Screen =
  | "support"
  | "home"
  | "maps"
  | "settings"
  | "profile"
  | "replays"
  | "servers"
  | "room"
  | "ranks"
  | "stats"
  | "tutorial"
  | "loadout"
  | "credits"
  | "gauntlets"
  | "gauntlet";
const SCREENS: readonly Screen[] = [
  "support",
  "home",
  "maps",
  "settings",
  "profile",
  "replays",
  "servers",
  "room",
  "ranks",
  "stats",
  "tutorial",
  "loadout",
  "credits",
  "gauntlets",
  "gauntlet",
];
/** The gauntlet screen's gauntlet, and the attempt whose result it shows (web menu.ts S.gauntlet). */
let gauntletView: { slug: string; attempt: string | null } = { slug: "", attempt: null };
/** The gauntlet split line under the finish (gauntlet-native.ts), and whether it's a split. */
let gauntletLine: { text: string; ok: boolean } | null = null;
let screen: Screen = "home";
let profileId = "";
let profileOpen: ProfileOpen = {};
/** The Loadout screen's category (web nav "loadout" slot: the unlock celebration's Equip). */
let loadoutSlot: string | null = null;
function openProfile(id: string, tab?: string | null, slot?: string | null): void {
  profileId = id;
  profileOpen = {
    slot,
    ...(["overview", "loadout", "runs", "card", "customise"].includes(tab ?? "")
      ? { tab: tab as ProfileOpen["tab"] }
      : {}),
  };
  show("profile");
}
async function ownProfile(tab?: string, slot?: string): Promise<void> {
  const generation = renderGeneration;
  const user = await api.me();
  if (generation !== renderGeneration || api.meStale()) return;
  if (user) openProfile(user.id, tab, slot);
  else openAccountPanel("save");
}
let rankScope = "all",
  rankPage = 1,
  focusMap: string | undefined;
let syncingStyle = false;
let browser: HTMLElement | null = null;
let renderGeneration = 0;
interface FinishSummary {
  seconds: number;
  jumps?: number;
  strafes?: number;
  sync?: number;
}
let finishSummary: FinishSummary | null = null;
const app = document.getElementById("menu")!;
const status = document.getElementById("native-status")!;
const flash = document.getElementById("native-notice")!;

function notice(text: string): void {
  flash.textContent = text;
}
function readFinish(value: unknown): FinishSummary | null {
  if (!value || typeof value !== "object") return null;
  const timer = value as Record<string, unknown>;
  if (timer.status !== 2 || typeof timer.seconds !== "number" || !Number.isFinite(timer.seconds) || timer.seconds < 0)
    return null;
  // The score in whole milliseconds, as the server and the web show it (timer.seconds on older hosts).
  const summary: FinishSummary = {
    seconds: runSeconds({ seconds: timer.seconds, timeMs: timer.timeMs }) ?? timer.seconds,
  };
  if (Number.isSafeInteger(timer.jumps) && Number(timer.jumps) >= 0) summary.jumps = Number(timer.jumps);
  if (Number.isSafeInteger(timer.strafes) && Number(timer.strafes) >= 0) summary.strafes = Number(timer.strafes);
  if (typeof timer.sync === "number" && Number.isFinite(timer.sync) && timer.sync >= 0 && timer.sync <= 100)
    summary.sync = timer.sync;
  return summary;
}
function paintFinish(): void {
  const host = document.getElementById("native-finish-result");
  if (!host) return;
  if (!finishSummary) {
    host.replaceChildren();
    return;
  }
  const stats: string[] = [];
  if (finishSummary.jumps !== undefined) stats.push(`${finishSummary.jumps} jumps`);
  if (finishSummary.strafes !== undefined) stats.push(`${finishSummary.strafes} strafes`);
  if (finishSummary.sync !== undefined) stats.push(`${finishSummary.sync.toFixed(1)}% sync`);
  // A practice finish (web hud/result.ts): yellow, and its line says it wasn't submitted.
  const practice = state.practice.active
    ? practiceReason({
        debug: false,
        thirdPerson: state.practice.thirdPerson,
        scripted: false,
        lesson: false,
        mode: state.practice.mode && !state.practice.tool,
        tool: state.practice.tool,
      })
    : null;
  host.replaceChildren(
    h(
      `section.native-finish${practice ? ".practice" : ""}`,
      { "aria-label": "Finished run" },
      h("p.native-finish-label", null, "Finished"),
      h("strong.native-finish-time", null, formatTime(finishSummary.seconds)),
      stats.length ? h("p.dim.native-finish-stats", null, stats.join(" · ")) : null,
      practice ? h("p.dim.native-finish-sub", null, `Not submitted: ${practice}.`) : null,
      gauntletLine ? h(`p.native-finish-sub.${gauntletLine.ok ? "ok" : "dim"}`, null, gauntletLine.text) : null,
    ),
  );
}
function selectMap(id: string): void {
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(id)) return;
  roomService.leave();
  // Another map than the attempt's: the attempt stays open on the server (Resume on its page), this client lets it go.
  if (gauntlet.id && id !== gauntlet.map) gauntlet.leave();
  try {
    localStorage.setItem(LAST_MAP, id);
  } catch {
    /* private storage: no Continue */
  }
  if (id === state.map) {
    if (LEAVE_FOR_GAME.has(screen)) {
      backStack = [];
      screen = "home";
    }
    send({ type: "resume" });
  }
  // The host owns loading/error status and clears it when the download settles.
  else send({ type: "selectMap", id, style: state.style, track: 0 });
}
/**
 * Screens form a stack under home, as on the web (menu.ts push/pop): Back and Esc return to the screen a profile,
 * board or page was opened from. Home is the root and clears it. An entry keeps what its screen was showing.
 */
interface BackEntry {
  screen: Screen;
  profileId: string;
  profileOpen: ProfileOpen;
  gauntletView: typeof gauntletView;
  loadoutSlot: string | null;
}
let backStack: BackEntry[] = [];
const BACK_LIMIT = 16;
function show(next: Screen, o: { back?: boolean; slot?: string | null } = {}): void {
  if (screen === "ranks" && next !== "ranks") leaveRanksUrl();
  if (next !== "gauntlets" && next !== "gauntlet" && next !== "profile") leaveGauntletUrl();
  if (next === "home") backStack = [];
  else if (!o.back && screen !== next && screen !== "home")
    backStack = [...backStack, { screen, profileId, profileOpen, gauntletView, loadoutSlot }].slice(-BACK_LIMIT);
  if (next === "loadout" && !o.back) loadoutSlot = o.slot ?? null;
  screen = next;
  notice("");
  render();
}
/** Back (the header arrow, Esc): the screen this one was opened from, else the screen's own parent. */
function back(): void {
  const entry = backStack.pop();
  if (!entry) {
    show(backOf(screen), { back: true });
    return;
  }
  ({ profileId, profileOpen, gauntletView, loadoutSlot } = entry);
  show(entry.screen, { back: true });
}
/** Browse screens a map is picked from: once that map is up, Esc in game opens the pause menu (web: the game replaces the stack). */
const LEAVE_FOR_GAME: ReadonlySet<Screen> = new Set([
  "maps",
  "profile",
  "ranks",
  "stats",
  "servers",
  "loadout",
  "gauntlets",
  "gauntlet",
  "support",
  "credits",
]);
/** Settings, scrolled to one of its sections (the pause tabs' "All HUD settings" / "Every key"). */
function openSettings(section: string): void {
  show("settings");
  document.getElementById(`nset-${section}`)?.scrollIntoView({ block: "start" });
}
/** A gauntlet's page, or an attempt's result (ui/gauntlets.ts); replaces the gauntlet screen if it's showing. */
function openGauntlet(slug: string, attempt: string | null): void {
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) return;
  gauntletView = { slug, attempt: isAttemptId(attempt) ? attempt : null };
  if (screen === "gauntlet") render();
  else show("gauntlet");
}
const gauntletActions: GauntletScreens = { open: (slug, attempt) => openGauntlet(slug, attempt ?? null) };
/** Where Back (and Esc) goes from a screen: a gauntlet's page back to the list, everything else home. */
const backOf = (from: Screen): Screen => (from === "gauntlet" && !state.map ? "gauntlets" : "home");
/** Route shared footer destinations into native screens; other trusted pages use the browser. */
function openWeb(path: string): void {
  const url = new URL(path, LIVE_ORIGIN);
  if (url.origin === LIVE_ORIGIN && url.searchParams.has("support")) {
    show("support");
    return;
  }
  if (!openExternal(url.href)) notice("This page is not available in the native menu.");
}
const BACK_ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12H5M11 5.5 4.5 12 11 18.5"/></svg>';
/** A screen's header. `sub` is a line under the title, or the screen's tabs (web menu.ts header). */
function heading(title: string, sub?: string | HTMLElement | null, inner?: () => boolean): HTMLElement {
  const goBack = (): void => {
    if (!inner?.()) back();
  };
  const backOptions = { type: "button", "aria-label": "Back", title: "Back (Esc)", onclick: goBack, html: BACK_ARROW };
  const backButton = h("button.screen-back", backOptions);
  const below = typeof sub === "string" ? h("small", null, sub) : (sub ?? null);
  return h("header.screen-head", null, backButton, h("div.screen-title", null, h("h2", null, title), below));
}

/** A screen whose tabs sit in its header, as on the web: Profile, Stats, Support. */
function tabbedHeading(title: string): { head: HTMLElement; tabs: HTMLElement } {
  const tabs = h("div.pf-tabs-host");
  return { head: heading(title, tabs), tabs };
}

function playMap(map: string, style?: string): void {
  if (isStyleId(style)) setSelectedStyle(style);
  selectMap(map);
}
let shown = "";
/** The replay viewer while it's up: it sits over the page, not in #menu (web viewer.css #rv, body.viewer-open). */
let viewer: { el: HTMLElement; dispose: () => void } | null = null;
function closeViewer(): void {
  if (!viewer) return;
  viewer.dispose();
  viewer.el.remove();
  viewer = null;
  document.body.classList.remove("viewer-open");
}
/** Replays while a replay plays is the viewer; otherwise the vault. */
function showViewer(): void {
  if (!viewer) {
    viewer = replayViewer(notice);
    document.body.append(viewer.el);
  }
  document.body.classList.add("viewer-open");
  app.replaceChildren();
}
function render(): void {
  ++renderGeneration;
  if (screen !== "replays" || !state.playback.active) closeViewer();
  const root = screen === "home" ? (state.map ? "pause" : "home") : screen;
  document.body.dataset.screen = screen === "room" ? "pause" : root;
  document.body.dataset.map = state.map ?? "";
  document.body.classList.toggle("in-game", !!state.map);
  // The same screen drawn again for a host update (loading, an error) doesn't replay its entrance.
  app.className = `screen-${root}${shown === root ? " native-steady" : ""}`;
  shown = root;
  browser = null;
  status.textContent =
    state.error || (typeof state.loading === "string" ? state.loading : state.loading ? "Loading map…" : "");
  status.dataset.kind = state.error ? "error" : "";
  syncBackdrop();
  paintLoading();
  if (screen === "home" && state.map) {
    // The newest local replay of this map and track: the Replays tab's "last run".
    const last = state.replays
      .filter((item) => item.map === state.map && item.track === state.track)
      .sort((x, y) => y.recordedAt - x.recordedAt)[0];
    if (!app.classList.contains("native-steady")) send({ type: "replays", action: "list" });
    // Practice works solo (web rules.ts practiceUnavailable): the host says where; never in a room, a gauntlet or a replay.
    const practice =
      state.practice.available &&
      !state.practice.unavailable &&
      !roomService.view.id &&
      !gauntlet.id &&
      !state.playback.active
        ? {
            on: state.practice.mode,
            count: state.practice.count,
            toggle: () => {
              send({ type: "practice", action: "toggle" });
              send({ type: "resume" });
            },
            checkpoints: () => {
              send({ type: "practice", action: "menu" });
              send({ type: "resume" });
            },
          }
        : null;
    const pause = pauseScreen({
      map: state.map,
      style: state.style,
      track: state.track,
      room: !!roomService.view.id,
      restartKey: state.settings.binds.restart?.[0],
      resume: () => send({ type: "resume" }),
      restart: () => send({ type: "restart" }),
      leave: leaveMap,
      practice,
      binds: state.settings.binds,
      // (No in-place track switch on the host: the map is selected again on its main track.)
      mainTrack:
        state.track && !gauntlet.id
          ? () => send({ type: "selectMap", id: state.map!, style: state.style, track: 0 })
          : null,
      replayTab: {
        watchPB: () => void watchRequest({ target: { pb: true } }).catch((error) => notice((error as Error).message)),
        watchLast: last ? () => playLocalReplay(last.id) : null,
        exportLast: last ? () => send({ type: "replay", action: "export", id: last.id }) : null,
        load: (file) => {
          void file
            .arrayBuffer()
            .then((bytes) => sendReplay(new Uint8Array(bytes), "play", file.name))
            .catch((error) => notice((error as Error).message));
        },
      },
      screen: {
        values: {
          hud: state.settings.hud,
          crosshair: state.settings.crosshair,
          viewmodel: state.settings.viewmodel,
          jumpStats: state.settings.jumpStats,
          strafeTrainer: state.settings.strafeTrainer,
        },
        set: (key, on) => send({ type: "settings", patch: { [key]: on } }),
        allHud: () => openSettings("hud"),
      },
      keys: () => openSettings("keys"),
      servers: () => show(roomService.view.id ? "room" : "servers"),
      maps: () => show("maps"),
      learn: () => show("tutorial"),
      loadout: () => show("loadout"),
      settings: () => show("settings"),
      profile: (id) => openProfile(id),
      ranks: () => show("ranks"),
      replays: () => show("replays"),
      setStyle: (id) => {
        if (state.loading) return;
        if (gauntlet.modeLock && id !== state.style) {
          notice(gauntlet.modeLock);
          return;
        }
        setSelectedStyle(id);
        render();
      },
      web: openWeb,
    });
    pause.querySelector(".pause-head")?.append(h("div#native-finish-result"));
    for (const control of pause.querySelectorAll<HTMLButtonElement>(".rail-list button"))
      control.disabled = !!state.loading;
    app.replaceChildren(pause);
    if (!app.classList.contains("native-steady"))
      pause.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
    paintFinish();
  } else if (screen === "home") {
    // (Tiles land after the map index: a click during a load is refused here, not by a disabled state they missed.)
    const home = homeScreen({
      style: state.style,
      play: () => show("maps"),
      pick: (id) => {
        if (!state.loading) selectMap(id);
      },
      settings: () => show("settings"),
      loadout: () => show("loadout"),
      profile: (id) => openProfile(id),
      ranks: () => show("ranks"),
      stats: () => show("stats"),
      servers: () => show(roomService.view.id ? "room" : "servers"),
      learn: () => show("tutorial"),
      replays: () => show("replays"),
      credits: () => show("credits"),
      quit: () => send({ type: "quit" }),
      web: openWeb,
      gauntlets: () => show("gauntlets"),
      background: (map, pb) => {
        if (screen === "home" && !state.map) requestBackdrop(map, pb);
      },
    });
    for (const control of home.querySelectorAll<HTMLButtonElement>(".home-menu button, .home-tile"))
      control.disabled = !!state.loading;
    app.replaceChildren(home);
    if (!app.classList.contains("native-steady"))
      home.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
  } else if (screen === "maps") {
    const maps = mapBrowser({
      current: state.map,
      style: state.style,
      onPick: selectMap,
      focus: focusMap,
      gauntlets: api.available() ? () => show("gauntlets") : null,
    });
    browser = maps;
    focusMap = undefined;
    app.replaceChildren(
      h(
        "section.panel.panel-wide.panel-maps.native-maps",
        null,
        heading("Choose a map", state.map ? `playing ${state.map}` : null, () => closeMapPanel(maps)),
        maps,
      ),
    );
  } else if (screen === "gauntlets") {
    app.replaceChildren(
      h("section.panel.panel-wide.panel-gauntlets", null, heading("Gauntlets"), gauntletsScreen(gauntletActions)),
    );
  } else if (screen === "gauntlet") {
    // (The title is the gauntlet's once it has loaded.)
    const head = heading("Gauntlet"),
      title = (text: string) => void (head.querySelector("h2")!.textContent = text);
    const g = gauntletView;
    app.replaceChildren(
      h(
        "section.panel.panel-wide.panel-gauntlet",
        null,
        head,
        g.attempt
          ? gauntletResult(g.slug, g.attempt, gauntletActions, { title })
          : gauntletScreen(g.slug, gauntletActions, { title }),
      ),
    );
  } else if (screen === "support") {
    const { head, tabs } = tabbedHeading("Support");
    const support = nativeSupportScreen({
      tabsHost: tabs,
      loadout: () => void ownProfile("loadout"),
      editCard: () => void ownProfile("card"),
    });
    app.replaceChildren(h("section.panel.panel-wide.panel-support.native-support", null, head, support));
  } else if (screen === "settings") {
    app.replaceChildren(h("section.panel.native-settings", null, heading("Settings"), settingsPanel()));
  } else if (screen === "credits") {
    app.replaceChildren(h("section.panel.panel-wide.native-credits", null, heading("Credits"), creditsPanel()));
  } else if (screen === "replays" && state.playback.active) {
    showViewer();
  } else if (screen === "replays") {
    app.replaceChildren(
      h("section.panel.panel-wide.native-replay-screen", null, heading("Replays"), replayPanel(notice)),
    );
  } else if (screen === "servers") {
    app.replaceChildren(
      h(
        "section.panel.panel-wide.native-servers",
        null,
        heading("Play online"),
        serverBrowser({ map: state.map, onSolo: () => show("maps") }),
      ),
    );
  } else if (screen === "room") {
    app.replaceChildren(
      h(
        "section.panel.panel-wide.native-room-screen",
        null,
        heading("Current room"),
        roomPanel(
          roomService,
          (id) => openProfile(id),
          notice,
          (text) => chatService.submit(text),
        ),
      ),
    );
  } else if (screen === "ranks") {
    app.replaceChildren(
      h(
        "section.panel.panel-wide.panel-ranks.native-ranks",
        null,
        heading("Ranks"),
        ranksScreen(rankScope, {
          page: rankPage,
          onChange: (scope, page) => {
            rankScope = scope;
            rankPage = page;
          },
        }),
      ),
    );
  } else if (screen === "stats") {
    const { head, tabs } = tabbedHeading("Stats");
    const stats = statsScreen({ tabsHost: tabs, play: () => show("maps") });
    app.replaceChildren(h("section.panel.panel-wide.panel-stats.native-stats", null, head, stats));
  } else if (screen === "loadout") {
    // The web's Loadout is your profile's Loadout tab (signed out: that tab alone), under "Profile".
    const { head, tabs } = tabbedHeading("Profile");
    app.replaceChildren(
      h(
        "section.panel.panel-wide.panel-profile.native-loadout",
        null,
        head,
        cosmeticsPanel(playMap, loadoutSlot, tabs),
      ),
    );
  } else if (screen === "tutorial") {
    app.replaceChildren(
      h("section.panel.panel-wide.native-tutorial-screen", null, heading("Tutorial"), tutorialPanel()),
    );
  } else {
    const { head, tabs } = tabbedHeading("Profile");
    const profile = profilePanel(profileId, playMap, () => show("loadout"), { ...profileOpen, tabsHost: tabs });
    app.replaceChildren(h("section.panel.panel-wide.panel-profile.native-profile", null, head, profile));
  }
  // Privacy · Terms · Credits under every panel screen (web menu.ts render).
  if (screen !== "home") app.querySelector(":scope > .panel")?.append(legalLinks());
  if (screen !== "home" && screen !== "maps" && !app.classList.contains("native-steady")) focusFirstControl();
}
/** A screen opens with its first control focused, as on the web (menu.ts render): the keyboard and pad start there. */
function focusFirstControl(): void {
  const first =
    app.querySelector<HTMLElement>("[data-autofocus]") ??
    app.querySelector<HTMLElement>("button:not([disabled]), [href], input, select");
  first?.focus({ preventScroll: true });
}

const activityService = new NativeActivityService({
  store: {
    read: () => JSON.parse(localStorage.getItem("bunnyhop:native-playtime-pending") ?? "null"),
    write: (value) => {
      if (value) localStorage.setItem("bunnyhop:native-playtime-pending", JSON.stringify(value));
      else localStorage.removeItem("bunnyhop:native-playtime-pending");
    },
  },
  now: () => Date.now(),
  generation: accountGeneration,
  account: async () => {
    const user = await api.me();
    return api.meStale() ? undefined : (user?.id ?? null);
  },
  report: (seconds, dispatch) => api.reportPlaytime(seconds, dispatch),
  local: (delta) => {
    if (delta.loaded) recordMapPlayed(delta.map);
    for (let i = 0; i < delta.jumps; i++) countJump();
    if (delta.map !== "bhop_lol_tutorial") {
      mapTime.played(delta.map, delta.seconds);
      for (let i = 0; i < delta.attempts; i++) mapTime.attempt(delta.map);
    }
  },
});
void activityService.refreshAccount();
window.addEventListener("bunnyhop:account", () => {
  void activityService.refreshAccount();
});
function refreshAccount(): void {
  accountChanged();
}
const nativeWorldRecord = new NativeWorldRecord(worldRecord, (context, seconds) =>
  send({ type: "worldRecord", ...context, seconds }),
);
const hudLeaderboard = new NativeHudLeaderboard(placeBoard, (message) => send(message));
/** After your own verified run or an account change the cached board's `me` row is out of date. */
function refreshHudLeaderboard(): void {
  forgetBoards();
  hudLeaderboard.refresh();
}
// Also after your own verified run: the run service's refreshAccount fires this event.
window.addEventListener("bunnyhop:account", refreshHudLeaderboard);
/** The board and attempt a host report names: null with no map or no service, undefined if it doesn't say. */
function reportedBoard(report: Record<string, unknown>): BoardContext | null | undefined {
  const { map, style, track, runGeneration } = report;
  if (typeof map !== "string" || typeof style !== "string") return undefined;
  if (!Number.isSafeInteger(track) || !Number.isSafeInteger(runGeneration)) return undefined;
  if (!map || report.loading || !api.available()) return null;
  return { map, style, track: Number(track), generation: Number(runGeneration) };
}
function receive(value: unknown): void {
  const report = value as Record<string, unknown> | null;
  const board = report ? reportedBoard(report) : undefined;
  if (board !== undefined) {
    nativeWorldRecord.update(board);
    // The tutorial has no board (the website's HUD skips it too).
    hudLeaderboard.update(board && board.map !== "bhop_lol_tutorial" ? board : null);
  }

  if (value && typeof value === "object" && (value as { type?: string }).type === "auth") {
    refreshAccount();
    return;
  }
  const structural = () =>
    JSON.stringify({
      map: state.map,
      loading: state.loading,
      error: state.error,
      paused: state.paused,
      style: state.style,
      track: state.track,
      playback: state.playback.active,
    });
  const before = structural(),
    mapBefore = state.map;
  let finishChanged = false;
  if (value && typeof value === "object" && "timer" in value) {
    const next = readFinish((value as { timer: unknown }).timer);
    finishChanged = JSON.stringify(next) !== JSON.stringify(finishSummary);
    finishSummary = next;
  }
  // The pause screen also follows practice, the local replays (its Replays tab's last run) and the HUD switches.
  const paused = () =>
    JSON.stringify([
      state.practice,
      state.replays.length,
      state.replays[0]?.id,
      state.settings.hud,
      state.settings.crosshair,
      state.settings.viewmodel,
      state.settings.jumpStats,
      state.settings.strafeTrainer,
    ]);
  const pauseBefore = paused();
  const applied = applyState(value);
  applyReplayHostState(value);
  applyChatFeatures(value);
  if (applied) applySemanticPalette(state.settings.colorBlind);
  // A newly picked map is up: the next Esc in game is the pause menu, not the browser it was picked from.
  if (applied && state.map && state.map !== mapBefore && !state.playback.active && LEAVE_FOR_GAME.has(screen)) {
    backStack = [];
    screen = "home";
  }
  if (applied && structural() !== before) render();
  else if (screen === "home" && state.map && paused() !== pauseBefore) render();
  else if (finishChanged && screen === "home") paintFinish();
  paintLoading();
  if (finishChanged && !finishSummary) gauntletLine = null;
  gauntlet.onHostState();
  roomService.hostMap(state.map, !!state.loading);
  syncingStyle = true;
  setSelectedStyle(state.style);
  syncingStyle = false;
  if (state.map) setPlaying(state.map, state.style);
  setWatching(state.playback.active ? state.map : false);
  window.dispatchEvent(new CustomEvent("bunnyhop:host-state", { detail: state }));
}
/** The chat bind's first key, as players read it ("Y"), or null while chat has no key. */
function chatKeyLabel(): string | null {
  const code = state.settings.binds.chat?.[0];
  return code ? keyLabel(code) : null;
}
const roomService = new NativeRoomService({
  chatKey: chatKeyLabel,
  connect: (id, handlers) => new RoomConnection(id, () => state.style, handlers),
  ensureAccount: async () => {
    try {
      const user = await api.me();
      if (api.meStale()) return false;
      roomAccount.capture(user?.id ?? null);
      return !!user;
    } catch {
      return false;
    }
  },
  send,
});
const chatService = new NativeChatService(roomService, () => {
  send({ type: "chatAction", action: "openRoom" } as unknown as Parameters<typeof send>[0]);
  show("room");
});
const roomAccount = new RoomAccountBoundary(() => chatService.resetAccount());
roomService.subscribe(() => {
  const view = roomService.view;
  setRoomPresence(view.id && view.room ? { id: view.id, name: view.room.name } : null);
});
// The Tab board the host draws in game: the room screen's rows (host-decoration.ts).
const scoreboardFeed = new ScoreboardFeed((board) => send(board));
roomService.subscribe(() => {
  const clock = {
    now: roomService.clockNow(),
    server: roomService.serverNow(),
    ping: roomService.ping(),
    at: Date.now(),
  };
  scoreboardFeed.update(hostScoreboard(roomService.view, clock, chatKeyLabel()));
});
onBeforeSend((message) => {
  if (
    roomService.view.id &&
    ((message.type === "replay" && ["play", "ghost"].includes(message.action)) ||
      message.type === "replayData" ||
      (message.type === "tutorial" && message.action !== "stop"))
  )
    roomService.leave();
});
setRaceTag((board) => {
  const race = roomService.view.race;
  return race &&
    race.state === "live" &&
    race.map === board.map &&
    race.style === board.style &&
    race.track === board.track
    ? race.id
    : null;
});
/** Everything running for the map stops (map-lifecycle.ts). The host calls it as onLeaveMap for every leave_map. */
const teardownMap = leaveMapTeardown({
  room: roomService,
  gauntlet: { leave: () => gauntlet.leave() },
  clear: () => {
    finishSummary = null;
    gauntletLine = null;
    paintFinish();
    if (screen === "room") show("home");
  },
});
function leaveMap(): void {
  if (!state.map) return;
  teardownMap();
  send({ type: "leaveMap" });
}
const gauntlet = new NativeGauntlet({
  api,
  send,
  map: () => state.map,
  loading: () => !!state.loading,
  notice,
  account: async () => {
    const user = await api.me();
    return api.meStale() ? undefined : (user?.id ?? null);
  },
  result: (slug, attempt) => openGauntlet(slug, attempt),
  line: (text, ok) => {
    gauntletLine = text ? { text, ok } : null;
    paintFinish();
  },
  // Enter or a click goes to the next map at once (web gauntlet/mode.ts goTo).
  listenGo: (go) => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code === "Enter" || event.code === "NumpadEnter") {
        event.preventDefault();
        go();
      }
    };
    const onClick = (event: MouseEvent) => {
      if (event.button === 0) go();
    };
    addEventListener("keydown", onKey, true);
    addEventListener("mousedown", onClick, true);
    return () => {
      removeEventListener("keydown", onKey, true);
      removeEventListener("mousedown", onClick, true);
    };
  },
});
const runService = new NativeRunService({
  api,
  dpi: profileDpi,
  account: async () => {
    const user = await api.me();
    return api.meStale() ? null : (user?.id ?? null);
  },
  context: (identity, generation) => ({
    room: currentRoom(),
    race: currentRace(identity),
    gauntlet: gauntlet.tag(identity, generation, finishSummary?.seconds ?? null),
  }),
  holdGauntlet: (attempt, generation) => gauntlet.holds(attempt, generation),
  version: () => api.version(),
  origin: () => location.origin,
  send: (message) => {
    send(message);
    gauntlet.onRunStatus(message, finishSummary?.seconds ?? null);
    if (message.message) notice(message.message);
    if (message.status === "verified") refreshAccount();
  },
});
// Replay headers carry the display name the web stamps on its own (account.ts's local name, "player" when signed out
// or a guest without one). Sent at start, on account changes and whenever a rename lands, never repeated otherwise.
let sentPlayerName: string | null = null;
const syncPlayerName = () => {
  const name = localName();
  if (name !== sentPlayerName) {
    sentPlayerName = name;
    send({ type: "playerName", name });
  }
};
syncPlayerName();
setInterval(syncPlayerName, 2000);
window.addEventListener("bunnyhop:account", () => {
  void roomAccount.refresh(async () => {
    const user = await api.me();
    return api.meStale() ? undefined : (user?.id ?? null);
  });
  syncPlayerName();
  runService.refreshAccount();
  void api.me().then(
    (user) => {
      if (!api.meStale()) gauntlet.onAccount(user?.id ?? null);
    },
    () => {},
  );
});
const onGamepad = installGamepadNavigation(() => !state.map || state.paused);
const introHooks = {
  play: selectMap,
  learn: () => show("tutorial"),
  signIn: () => openAccountPanel("save"),
  active: () => screen === "home" && !state.map && !state.loading,
};
setReplayIntro(() => openOnboarding(introHooks));
window.addEventListener("bunnyhop:intro", () => openOnboarding(introHooks));
window.bunnyhopNativeMenu = {
  onGamepad,
  onActivity: (value) => activityService.receive(value),
  onState: receive,
  onAuth: refreshAccount,
  onRunEvent: (value) => {
    void runService.receive(value);
  },
  open: (next, focus) => {
    if (next === "intro") {
      openOnboarding(introHooks);
      return;
    }
    if (next === "rooms") next = "servers";
    if (next === "leave") {
      leaveMap();
      return;
    }
    if (next === "gauntlet" && !gauntletView.slug) next = "gauntlets";
    if (next === "loadout") show("loadout", { slot: typeof focus === "string" ? focus : null });
    else if (SCREENS.includes(next as Screen)) show(next as Screen);
    if (next === "settings" && focus) focusSettingsSection(app, focus);
    if (next === "room" && focus === "chat")
      document.querySelector<HTMLInputElement>(".native-room-chat-form input")?.focus();
  },
  onChatSubmit: (value: unknown) => chatService.submit(value),
  onChatSuggest: (value: unknown) => chatService.suggest(value),
  onRoomControl: (value: unknown) => chatService.control(value),
  onRoomPose: (value) => {
    roomService.pose(value);
  },
  onRoomCommand: (value) => {
    roomService.command(value);
  },
  // A friend pressed Join on your Discord activity. The host has already checked the secret.
  settle,
  onLeaveMap: teardownMap,
  onReplayTimeline: applyReplayTimeline,
  onPracticeFromReplayResult: (value) => practiceFromReplay.receive(value),
  joinRoom: (id) => {
    if (typeof id !== "string" || !/^(?:[a-z0-9][a-z0-9-]{0,31}|p-[a-z2-7]{10})$/.test(id)) return;
    void roomService.join(id).catch(() => notice("Couldn't join that room."));
    show("room");
  },
  onChatLink: (raw: string) => {
    const url = safeNativeChatUrl(raw);
    if (url) nativeNavigate(url);
  },
  version: 2,
};
window.addEventListener("bunnyhop:native-state", (event) => receive((event as CustomEvent).detail));
window.addEventListener("bunnyhop:native-auth", refreshAccount);
window.addEventListener("bunnyhop-native-auth", (event) => {
  if ((event as CustomEvent<{ status?: string }>).detail?.status === "complete") refreshAccount();
});
onNavigate((request) => {
  if (request.screen === "profile") openProfile(request.id, request.tab, request.slot);
  else if (request.screen === "maps") {
    focusMap = request.focus;
    show("maps");
  } else if (request.screen === "servers") show("servers");
  else if (request.screen === "ranks") {
    rankScope = request.scope ?? "all";
    rankPage = request.page ?? 1;
    show("ranks");
  } else if (request.screen === "stats") show("stats");
  else if (request.screen === "loadout") show("loadout", { slot: request.slot ?? null });
  else if (request.screen === "gauntlets") show("gauntlets");
  else if (request.screen === "gauntlet") openGauntlet(request.slug, request.attempt ?? null);
  else if (request.screen === "support") show("support");
  else notice("This screen is not available in the native menu yet.");
});
// These existing UI request buses must never fall back to a web-game navigation.
onViewerRequest((request) => {
  void watchRequest(request).catch((error) => notice(error.message));
});
onRaceRequest((request) => {
  void raceRequest(request).catch((error) => notice(error.message));
});
onStyleChange((id) => {
  if (syncingStyle) return;
  state.style = id;
  send({ type: "style", id });
});
document.addEventListener(
  "click",
  (event) => {
    const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
    if (!anchor) return;
    event.preventDefault();
    // A link within the page (the credits' contents): scroll to it.
    const hash = anchor.getAttribute("href") ?? "";
    if (hash.startsWith("#")) {
      document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: "start" });
      return;
    }
    nativeNavigate(anchor.href);
  },
  true,
);
document.addEventListener("keydown", (event) => {
  if (event.key === "F10") {
    event.preventDefault();
    show("settings");
    focusSettingsSection(app, "display");
    return;
  }
  if (event.key === "Enter" && event.altKey) {
    event.preventDefault();
    if (!event.repeat) send({ type: "window", action: "toggleFullscreen" });
    return;
  }
  if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
  event.preventDefault();
  if (browser && closeMapPanel(browser)) return;
  if (screen !== "home") back();
  else if (state.map && !state.loading) send({ type: "resume" });
});
window.addEventListener("bunnyhop:tutorial", () => show("tutorial"));
window.addEventListener("bunnyhop:navigate", (event) => {
  let url: URL;
  try {
    url = new URL((event as CustomEvent<{ url: string }>).detail.url, "https://bunnyhop.lol");
  } catch {
    return;
  }
  // Another site (the Discord invite): the browser, if it's one the client opens at all.
  if (url.origin !== "https://bunnyhop.lol") {
    if (!openExternal(url.href)) notice("This external link is not available in the native menu.");
    return;
  }
  if (url.pathname.startsWith("/api/auth/")) {
    openAuth(url.href);
    return;
  }
  const room = url.searchParams.get("server") ?? url.searchParams.get("lobby");
  if (room) {
    show("room");
    void roomService.join(room).catch((error) => notice(error.message));
    return;
  }
  // A gauntlet attempt (ui/gauntlets.ts Start / Resume: /?map=<map>&gauntlet=<id>): played here, not in the browser.
  const attempt = url.searchParams.get("gauntlet");
  if (isAttemptId(attempt)) {
    show("home");
    void gauntlet.start(attempt, url.searchParams.get("map"));
    return;
  }
  // Watching an attempt (/g/<slug>/watch/<id>[?i=n]): split n's replay in native playback.
  const watch = watchFromUrl(url);
  if (watch) {
    void watchGauntletSplit(gauntletWatchDeps, watch.attemptId, watch.idx).catch((error) =>
      notice((error as Error).message),
    );
    return;
  }
  const page = /^\/g\/([a-z0-9-]+)\/?$/.exec(url.pathname);
  if (page) {
    openGauntlet(page[1], url.searchParams.get("attempt"));
    return;
  }
  if (url.pathname === "/gauntlets") {
    show("gauntlets");
    return;
  }
  const replay = /^\/replay\/([\w-]+)$/.exec(url.pathname);
  if (replay) {
    void watchRequest({ target: { runId: replay[1] } }).catch((error) => notice(error.message));
    return;
  }
  const player = /^\/u\/([\w-]+)$/.exec(url.pathname);
  if (player) {
    openProfile(player[1], url.searchParams.get("tab"), url.searchParams.get("slot"));
    return;
  }
  if (url.searchParams.has("support")) {
    show("support");
    return;
  }
  const user = url.searchParams.get("u");
  if (user) {
    openProfile(user, url.searchParams.get("tab"), url.searchParams.get("slot"));
    return;
  }
  const map = url.searchParams.get("map");
  if (map) {
    if (isStyleId(url.searchParams.get("style"))) setSelectedStyle(url.searchParams.get("style") as typeof state.style);
    selectMap(map);
    return;
  }
  if (url.pathname === "/credits") {
    show("credits");
    return;
  }
  if (url.pathname === "/servers") show("servers");
  else if (url.pathname === "/ranks") show("ranks");
  else if (url.pathname === "/stats") show("stats");
  else if (url.pathname.startsWith("/maps")) {
    focusMap = url.pathname.split("/")[2];
    show("maps");
  } else if (url.pathname === "/" && !url.search) show("home");
  // A page only the website has (About, Support): opened there.
  else openWeb(url.pathname + url.search);
});
// WebKit stops a hidden page's animation clock (the host's menu view before it's shown, a hidden smoke window, an
// occluded window): every entrance, the tiles' landing and the backdrop's fade would wait at their first frame, opacity
// 0, and a snapshot shows an empty menu. While the clock stands still, html.native-clock-stopped ends them at once
// (native.css); once it runs again they play as on the web.
let clockCheck = 0;
function endAnimations(): number {
  for (const svg of document.querySelectorAll<SVGSVGElement>(".hop-trail svg")) svg.setCurrentTime(10);
  // Ones already started (the backdrop's fade, a picture's fade-in, rows landing) jump to their end.
  let ended = 0;
  for (const animation of document.getAnimations())
    if (animation.playState !== "finished" && Number.isFinite(animation.effect?.getComputedTiming().endTime)) {
      animation.finish();
      ended++;
    }
  // An async decode waits for a paint that may never come: pictures decode with the next snapshot instead.
  for (const image of document.querySelectorAll<HTMLImageElement>('img[decoding="async"]')) image.decoding = "sync";
  return ended;
}
/**
 * For a screenshot: the menu as it will rest. Every entrance, fade and landing row ends now, pictures on screen finish
 * loading (up to `timeoutMs`), and anything those started ends too. The live app never calls it; the web's animations
 * play as usual.
 */
async function settle(timeoutMs = 3000): Promise<{ ended: number; pendingImages: number }> {
  let ended = endAnimations();
  const deadline = performance.now() + Math.max(0, Math.min(timeoutMs, 10000));
  const pending = () =>
    [...document.images].filter((image) => image.isConnected && !!image.currentSrc && !image.complete);
  while (pending().length && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise((resolve) => setTimeout(resolve, 0));
  ended += endAnimations();
  return { ended, pendingImages: pending().length };
}
function watchAnimationClock(delay = 300): void {
  window.clearTimeout(clockCheck);
  const start = document.timeline.currentTime;
  clockCheck = window.setTimeout(() => {
    const stopped = document.timeline.currentTime === start;
    document.documentElement.classList.toggle("native-clock-stopped", stopped);
    // SMIL (the hop trail's dot) has its own clock: to its end, where the web's comes to rest.
    if (stopped) endAnimations();
    watchAnimationClock(stopped ? 1000 : 5000);
  }, delay);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") document.documentElement.classList.remove("native-clock-stopped");
  watchAnimationClock();
});
watchAnimationClock();
// Feedback form ("Attach game info", feedback/modal.ts gameContext): what the native host says, its own settings.
setGameInfo(() => ({
  inGame: !!state.map,
  client: "native",
  ...(state.map ? { map: state.map, style: state.style, track: state.track, paused: state.paused } : {}),
  ...(state.playback.active ? { watchingReplay: true } : {}),
  // The game's own window, version and GPU (the modal would otherwise report the menu web view's).
  ...(state.client
    ? {
        nativeVersion: state.client.version,
        nativeBuild: state.client.build,
        gpu: { renderer: state.client.gpu },
        ...(state.client.viewport[0] ? { viewport: `${state.client.viewport[0]}x${state.client.viewport[1]}` } : {}),
        dpr: state.client.dpr,
      }
    : {}),
  nativeSettings: {
    sensitivity: state.settings.sensitivity,
    fov: state.settings.fov,
    vsync: state.settings.vsync,
    fpsLimit: state.settings.fpsLimit,
    limitQueuedFrames: state.settings.limitQueuedFrames,
  },
  // Mouse, frame-time and input-queue diagnostics, when the overlay has produced a sample.
  ...(latestMouseDiagnostics() ? { inputDiagnostics: latestMouseDiagnostics() } : {}),
}));
initSocial();
initDock();
initCosmetics();
installNowPlaying();
installNativeUiAudio();
installMuteButton();
installTutorialProgress();
installHudTheme();
initCustomCss();
installMenuBackdrop();
watchMenuMotion();
render();
void maybeStartOnboarding(introHooks);
const graphics = window.__nativeMenuGraphics;
send({
  type: "ready",
  origin: location.origin,
  webglContexts: graphics?.contexts ?? 0,
  webglAttempts: graphics?.attempts ?? 0,
});
