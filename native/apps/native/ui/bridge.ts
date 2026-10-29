import {
  DEFAULT_ANNOUNCER,
  announcerPatch,
  type AnnouncerPrefs,
  type AnnouncerEvent,
  type AnnouncerLine,
} from "./audio-settings";
import type { NativeChatMessage } from "./chat-service";
import { validHudLayout, type HudLayout } from "./hud-layout";
import type { RunServiceStatus } from "./run-service";
import { isStyleId, type StyleId } from "../../web/src/styles";
import { LESSON_IDS, type LessonId } from "../../web/src/tutorial/data";
import { DEFAULT_BINDS as WEB_DEFAULT_BINDS } from "../../web/src/binds";
import { ANGLE_SPEED_KEY_RANGE, YAW_SPEED_RANGE } from "./turn-speed";
import { DEFAULT_PREFS } from "../../web/src/ui/settings";
import { PAINT_COLORS, PAINT_SIZES, type PaintPrefs, type PaintSize } from "../../web/src/paint/prefs";
import { requestedPatch } from "./settings-keys";
export const LIVE_ORIGIN = "https://bunnyhop.lol";
export interface VideoExportOptions {
  width: number;
  height: number;
  fps: number;
  quality: "standard" | "high" | "max";
  camera: "eye" | "chase" | "flyby" | "auto";
  hud: boolean;
  audio?: boolean;
  music?: string;
  musicOffset?: number;
  musicLevel?: number;
  musicLoop?: boolean;
  musicDuck?: boolean;
  fullRecording?: boolean;
  from?: number;
  to?: number;
}
export interface VideoExportState {
  available: boolean;
  reason: string;
  state: "idle" | "capturing" | "encoding" | "completed" | "canceled" | "error";
  frames: number;
  encodedFrames: number;
  totalFrames: number;
  progress: number;
  path: string;
  error: string;
  videoOnly: boolean;
  musicTracks: { id: string; title: string }[];
}
export type MenuMessage =
  | { type: "mapLoad"; action: "cancel" | "retry" }
  | { type: "update"; action: "check" | "download" | "cancel" | "reveal" | "restart" | "status" }
  | { type: "update"; action: "automatic"; enabled: boolean }
  | {
      type: "dataFolder";
      action: "status" | "pick" | "useDefault" | "cancelChoice" | "cancelPending" | "forget" | "reveal";
    }
  | { type: "dataFolder"; action: "move"; when: "now" | "later" }
  | { type: "videoExport"; action: "start" | "cancel"; options?: VideoExportOptions }
  | { type: "ready"; origin: string; webglContexts: number; webglAttempts: number }
  | { type: "resume" | "restart" | "quit" }
  | { type: "prefetchMap"; map: string | null; sha?: string }
  | { type: "selectMap"; id: string; style?: StyleId; track?: number }
  | { type: "style"; id: StyleId }
  | {
      type: "cosmetics";
      outfit: string;
      packedLoadout: string;
      ghostId?: string;
      trailId?: string;
      playerGlow?: import("../../web/src/player/glow-config").PlayerGlow | null;
    }
  | { type: "settings"; patch: SettingsPatch }
  | { type: "window"; action: "center" | "minimize" | "maximize" | "toggleFullscreen" }
  /** The HUD colours and element styles resolved from Custom CSS (custom-css/hud-theme.ts). */
  | { type: "hudTheme"; theme: import("./custom-css/hud-theme").HudTheme }
  /** A system file dialog (native-files.ts); the answer is a bunnyhop:native-file event. */
  | {
      type: "file";
      action: "open" | "save" | "unwatch";
      purpose: "settings" | "css";
      id?: string;
      text?: string;
      name?: string;
    }
  | { type: "replays"; action: "list" }
  /** Clears the player's paint on the loaded map (renderer.hpp tool_message). */
  | { type: "paint"; action: "clear" }
  /** Opens the HUD layout editor over the game (hud_editor.cpp); the menu closes. */
  | { type: "hudEditor" }
  /** Moves the HUD to one of the host's layout presets (hud_editor_layout.hpp). */
  | { type: "hudPreset"; id: "classic" | "minimal" | "streamer" }
  | {
      type: "replay";
      action: "play" | "ghost" | "export" | "delete" | "screenshot";
      ghostSlot?: number;
      id: string;
      confirmed?: boolean;
    }
  | {
      type: "replayData";
      action: "play" | "ghost";
      ghostSlot?: number;
      name: string;
      map: string;
      replayBase64: string;
    }
  | {
      type: "replayControl";
      action: "pause" | "seek" | "speed" | "stop" | "camera";
      camera?: string;
      paused?: boolean;
      tick?: number;
      speed?: number;
    }
  | { type: "replayControl"; action: "fullRecording"; value: boolean }
  | { type: "practiceFromReplay"; tick?: number }
  /** A second replay as a ghost on the one being watched (replay-host.ts); needs the host's "compare" feature. */
  | { type: "replayCompare"; action: "set"; kind: "pb" | "wr" | "custom"; name: string; replayBase64: string }
  | { type: "replayCompare"; action: "clear" }
  | { type: "ghost"; enabled: boolean }
  | { type: "ghostControl"; action: "remove" | "clear" | "toggle"; slot?: number; enabled?: boolean }
  | { type: "tutorial"; action: "start" | "demo"; lesson: LessonId }
  | { type: "tutorial"; action: "stop" }
  | { type: "roomEvent"; generation: number; id: string; event: Record<string, unknown> }
  | { type: "roomSnapshot"; generation: number; id: string; snapshot: unknown }
  | { type: "announce"; event: AnnouncerEvent; id?: string; remote?: boolean; preview?: AnnouncerLine }
  | { type: "audioCue"; id: string; gain: number; rate: number }
  | { type: "sensitivity"; value: number }
  | { type: "openAuth"; url: string }
  | { type: "openExternal"; url: string }
  | { type: "menuBackdrop"; map: string | null; replay?: { runId: string; replayBase64: string } }
  /** Practice tools (web practice-mode/controller.ts). Sent from the menu, so the timed-run key gate doesn't apply. */
  | { type: "practice"; action: PracticeAction; value?: boolean }
  /** Pause menu → Main menu: release the map, back to the home screen (state map:null). */
  | { type: "leaveMap" }
  /** A gauntlet attempt (gauntlet-native.ts): locks Normal/main track and practice; null id ends it. */
  | { type: "gauntlet"; id: string | null; map?: string; progress?: GauntletHudProgress }
  /** One line on the in-game HUD's toast (gauntlet split lines). */
  | { type: "hudToast"; text: string; ms: number; tone?: "good" | "bad"; key?: "gauntlet" | "practice" }
  /** The soundtrack's previous / play-pause / next (now-playing). */
  | { type: "music"; action: "previous" | "toggle" | "next" }
  /** The name native replay headers carry: the web's local display name ("bunnyhop:name", else "player"). */
  | { type: "playerName"; name: string }
  | NativeChatMessage
  /** The Tab board for the host to draw (host-decoration.ts). */
  | import("./host-decoration").HostScoreboard
  | { type: "worldRecord"; map: string; style: string; track: number; generation: number; seconds: number | null }
  /** The player's own board place for the HUD's place line (hud-leaderboard.ts). */
  | import("./hud-leaderboard").HudLeaderboardMessage
  /** Avatar editor pictures (avatar-host.ts). */
  | import("./avatar-host").AvatarHostMessage
  | RunServiceStatus;

export const PRACTICE_ACTIONS = ["toggle", "menu", "noclip", "save", "tele", "prev", "next", "keepVelocity"] as const;
export type PracticeAction = (typeof PRACTICE_ACTIONS)[number];
/** gauntlet/state.ts GauntletProgress: this map's index, the map count, the earlier splits' sum, your PB's split here. */
export interface GauntletHudProgress {
  idx: number;
  maps: number;
  before: number;
  pbSplit: number | null;
}

export const NATIVE_BIND_ACTIONS = [
  "forward",
  "back",
  "left",
  "right",
  "jump",
  "duck",
  "use",
  "restart",
  "restartBonus",
  "restartMain",
  "cycleStyle",
  "attack",
  "attack2",
  "inspect",
  "viewmodel",
  "hideUi",
  "mute",
  "slot1",
  "slot2",
  "slot3",
  "lastWeapon",
  "drop",
  "reload",
  "giveUsp",
  "giveGlock",
  "turnLeft",
  "turnRight",
  "turnFast",
  "mainMenu",
  "practice",
  "noclip",
  "cpSave",
  "cpTeleport",
  "cpPrev",
  "cpNext",
  "setStart",
  "clearStart",
  "nextWeapon",
  "prevWeapon",
  "gunMenu",
  "nextTrack",
  "keysOverlay",
  "showTriggers",
  "showClips",
  "hudEditor",
  "thirdPerson",
  "flashlight",
  "chat",
  "commandChat",
  "scoreboard",
  "spectatorNext",
  "spectatorPrevious",
  "spectatorMode",
  "paint",
  "paintOnce",
  "clearPaint",
  "measurePoint",
  "clearMeasure",
] as const;
type NativeBindAction = (typeof NATIVE_BIND_ACTIONS)[number];
/** The web game's defaults, plus native-only actions and defaults (settings.hpp keeps the same list). */
export const DEFAULT_BINDS: Record<NativeBindAction, readonly string[]> = {
  ...WEB_DEFAULT_BINDS,
  showTriggers: ["Mouse3"],
  showClips: [],
  chat: ["KeyY"],
  commandChat: ["KeyU"],
  scoreboard: ["Tab"],
  spectatorNext: [],
  spectatorPrevious: [],
  spectatorMode: ["KeyN"],
};
/** A settings change: native keys, and website keys the host has added (settings-keys.ts). */
export type SettingsPatch = Partial<NativeSettings> & Record<string, unknown>;
/** "default" is the bunnyhop.lol pack; "custom" is the player's own sound/ and bgm/ folders. */
export type AudioPack = "default" | "custom";
export type JumpStatsMode = "sixth" | "every" | "interval";
export const JUMP_STATS_MODES: readonly JumpStatsMode[] = ["sixth", "every", "interval"];
export const AUDIO_PACKS: readonly AudioPack[] = ["default", "custom"];
export const WINDOW_MODES = ["windowed", "borderless", "fullscreen"] as const;
export type WindowMode = (typeof WINDOW_MODES)[number];
export const FULLSCREEN_SCALINGS = ["stretch", "bars"] as const;
export type FullscreenScaling = (typeof FULLSCREEN_SCALINGS)[number];
/** Exclusive fullscreen's mode (window_settings.hpp). Width 0 is the desktop mode; refresh 0 the highest. */
export interface FullscreenMode {
  display: string;
  displayIndex: number;
  width: number;
  height: number;
  refreshHz: number;
}
export interface DisplayModeInfo {
  width: number;
  height: number;
  refreshHz: number;
}
/** A monitor and the exclusive modes it offers (display_catalog.hpp). */
export interface DisplayInfo {
  name: string;
  index: number;
  window: boolean;
  primary: boolean;
  desktop: DisplayModeInfo | null;
  modes: DisplayModeInfo[];
}
export interface DisplayCatalog {
  displays: DisplayInfo[];
  /** The mode exclusive fullscreen shows now, or null. */
  exclusive: DisplayModeInfo | null;
}
export interface NativeAudioState {
  classicLoading: boolean;
  classicActive: boolean;
  classicStatus: string;
  sfxStatus: string;
  error: string;
}
export interface NativeSettings {
  /** The runner is retired, as on the website: the menu never offers or sends it (the host still reads old files). */
  playerModel: "bunny";
  ghostModel: "same" | "bunny";
  mouseDiagnostics: boolean;
  windowMode: WindowMode;
  alwaysOnTop: boolean;
  rememberWindowBounds: boolean;
  minimizeOnFocusLoss: boolean;
  fullscreenMode: FullscreenMode;
  fullscreenScaling: FullscreenScaling;
  capturePbScreenshots: boolean;
  showPlayerGlow: boolean;
  firstPersonGlow: boolean;
  waterQuality: "simple" | "refracted";
  /** Private surface paint: one of the website's colours and sizes (paint/prefs.ts). */
  paint: PaintPrefs;
  zonesVisible: boolean;
  effectsVisible: boolean;
  triggersVisible: boolean;
  clipsVisible: boolean;
  sensitivity: number;
  verticalSensitivity: number;
  separateVertical: boolean;
  invertY: boolean;
  holdRestart: boolean;
  crosshairStyle: "cross" | "cross-dot" | "dot" | "t" | "circle" | "none";
  crosshairColor: string;
  crosshairSize: number;
  crosshairGap: number;
  crosshairThickness: number;
  crosshairAlpha: number;
  crosshairOutline: boolean;
  viewmodelFov: number;
  viewmodelX: number;
  viewmodelY: number;
  viewmodelZ: number;
  viewmodelLeftHand: boolean;
  viewmodelBob: number;
  viewmodelSway: number;
  showGhost: boolean;
  ghostOpacity: number;
  ghostNearFade: boolean;
  ghostTag: boolean;
  othersAudio: boolean;
  ghostAudio: boolean;
  sfxVolume: number;
  musicVolume: number;
  uiVolume: number;
  ambienceVolume: number;
  footsteps: boolean;
  weaponSounds: boolean;
  wind: boolean;
  muteSfx: boolean;
  muteMusic: boolean;
  muteUi: boolean;
  muteAmbience: boolean;
  muteInBackground: boolean;
  classicSounds: boolean;
  perfectTick: boolean;
  announcer: AnnouncerPrefs;
  colorBlind: "off" | "redGreen" | "blueYellow";
  gainTicks: boolean;
  speedColors: boolean;
  perfectIndicator: boolean;
  speedGraph: boolean;
  keysOverlay: boolean;
  keysStyle: "classic" | "minimal" | "keycaps";
  /** Each tick takes the input made before it (timed-input.ts). Off is the legacy per-frame proration. */
  timedInput: boolean;
  /** Turnbinds: degrees per second (cl_yawspeed), and while Turn modifier is held. */
  yawSpeed: number;
  angleSpeedKey: number;
  fov: number;
  vsync: boolean;
  fpsLimit: number;
  limitQueuedFrames: boolean;
  volume: number;
  muted: boolean;
  hud: boolean;
  crosshair: boolean;
  viewmodel: boolean;
  binds: Record<string, string[]>;
  /** The jump HUD (!ssj jump stats). On by default. */
  jumpStats: boolean;
  jumpStatsColors: boolean;
  /** Which jumps the HUD reports: the 6th, every one, or every |jumpStatsInterval|th. */
  jumpStatsMode: JumpStatsMode;
  jumpStatsInterval: number;
  /** Turn rate against the ideal for your speed, while in the air. Off by default. */
  strafeTrainer: boolean;
  /** Air ticks each reading averages; 1 is every tick on its own. */
  strafeTrainerSmoothing: number;
  /** "Less deadtime!" / "Strafe more!" / "Strafe less!" under the trainer. */
  strafeTrainerHints: boolean;
  /** CS:S's auto exposure and bloom on maps with HDR lighting (the web's Source look). On by default. */
  sourceLook: boolean;
  /** Moved HUD elements, in percent of the screen. Absent means the built-in place. */
  hudLayout: HudLayout;
  /** The whole HUD's size, in percent (the web's hud.scale × 100): 50–175. */
  hudScale: number;
  /** A checkpoint teleport keeps the speed it was saved with (web prefs practice.keepVelocity). */
  practiceKeepVelocity: boolean;
  sfxPack: AudioPack;
  musicPack: AudioPack;
  /** Discord Rich Presence, on by default. Privacy mode hides everything. */
  discordRichPresence: boolean;
  discordShowMap: boolean;
  discordJoin: boolean;
  discordJoinLobbies: boolean;
  privacyMode: boolean;
}
export type DiscordState = "disabled" | "connecting" | "ready" | "reconnecting";
export const DISCORD_STATES: readonly DiscordState[] = ["disabled", "connecting", "ready", "reconnecting"];
export interface LocalRunSummary {
  schema: 1;
  map: string;
  style: string;
  track: number;
  time: number;
  jumps: number;
  strafes: number;
  sync: number;
  finishedAt: number;
  client: string;
  localPb: boolean;
  eligible?: boolean;
  verified?: false;
}
export interface NativeReplay {
  screenshot?: boolean;
  localSummary?: LocalRunSummary;
  id: string;
  name: string;
  map: string;
  style: StyleId;
  track: number;
  seconds: number;
  recordedAt: number;
  bytes: number;
  /** The run's score in whole milliseconds, as the server times it (absent from older hosts). */
  timeMs?: number;
}
/** A run's time to show: the host's whole milliseconds when it sends them, else its seconds. */
export function runSeconds(run: { seconds?: number; timeMs?: unknown }): number | null {
  if (Number.isSafeInteger(run.timeMs) && Number(run.timeMs) > 0) return Number(run.timeMs) / 1000;
  return typeof run.seconds === "number" && Number.isFinite(run.seconds) && run.seconds > 0 ? run.seconds : null;
}
export const REPLAY_CAMERAS = ["eye", "chase", "free", "flyby", "auto"] as const;
export type ReplayCamera = (typeof REPLAY_CAMERAS)[number];
export interface NativeGhost {
  slot: number;
  id: string;
  name: string;
  enabled: boolean;
  map?: string;
  style?: StyleId;
  track?: number;
}
/**
 * `tick` and `totalTicks` are absolute recording ticks. The range fields are the part the viewer shows: by default
 * from 1 s before the timer starts to 1.5 s after it stops, or the whole recording with `fullRecording`.
 */
const PLAYBACK_RANGE_KEYS = [
  "rangeStartTick",
  "rangeEndTick",
  "rangeTick",
  "rangeTotalTicks",
  "elapsedSeconds",
] as const;
export interface PlaybackState {
  rangeStartTick?: number;
  rangeEndTick?: number;
  rangeTick?: number;
  rangeTotalTicks?: number;
  elapsedSeconds?: number;
  fullRecording?: boolean;
  camera?: ReplayCamera;
  seconds?: number;
  tickInterval?: number;
  /** The replay's finished time in whole milliseconds (0 or absent: none). */
  timeMs?: number;
  active: boolean;
  id: string;
  tick: number;
  totalTicks: number;
  paused: boolean;
  speed: number;
  player?: { id?: string; name?: string; runId?: string };
}
/** Practice as the host has it (web practice-mode/: PracticeAttempt, Checkpoints, the !cp menu). */
export interface PracticeState {
  available: boolean;
  /** Why practice can't be used here (web rules.ts practiceUnavailable wording), or null. */
  unavailable: string | null;
  /** Practice mode: every attempt is practice until it's turned off. */
  mode: boolean;
  /** This attempt is practice (mode, or a teleport / noclip was used). */
  active: boolean;
  thirdPerson: boolean;
  tool: "teleport" | "noclip" | null;
  noclip: boolean;
  menuOpen: boolean;
  /** Checkpoints saved, and the current one (1-based; 0 none). */
  count: number;
  current: number;
  keepVelocity: boolean;
}
export type PlayerMode = "solo" | "multiplayer" | "practice" | "replay" | "gauntlet" | "tutorial";
export const PLAYER_MODES: readonly PlayerMode[] = [
  "solo",
  "multiplayer",
  "practice",
  "replay",
  "gauntlet",
  "tutorial",
];
/** What the player is actually doing (playback's style for a replay). Feedback and reports attach it. */
export interface PlayerState {
  map: string | null;
  style: StyleId;
  track: number;
  mode: PlayerMode;
  practice: boolean;
}
export interface MusicState {
  id: string;
  title: string;
  role: string;
  playing: boolean;
  available: boolean;
  loading: boolean;
  status: string;
}

export interface NativeClientInfo {
  version: string;
  build: string;
  gpu: string;
  viewport: [number, number];
  dpr: number;
}
export interface MapLoadProgress {
  stage: string;
  message: string;
  received: number;
  total: number;
  filesDone: number;
  filesTotal: number;
  cached: boolean;
  offline: boolean;
  map?: string;
}
export interface NativeMenuState {
  loadProgress?: MapLoadProgress | null;
  map: string | null;
  loading: boolean | string;
  error: string | null;
  sensitivity: number;
  paused: boolean;
  style: StyleId;
  track: number;
  settings: NativeSettings;
  replays: NativeReplay[];
  ghosts: NativeGhost[];
  discord: { state: DiscordState; message: string };
  playback: PlaybackState;
  ghost: { enabled: boolean; id: string; name: string };
  tutorial: { active: boolean; lesson: LessonId; completed: LessonId[] };
  practice: PracticeState;
  gauntlet: { id: string | null; map: string | null };
  player: PlayerState | null;
  /** The soundtrack (null: this host doesn't report music). */
  music: MusicState | null;
  audio: NativeAudioState | null;
  videoExport: VideoExportState;
  /** The native app itself, for the feedback form: release version, build id, GL renderer, game window. */
  client: NativeClientInfo | null;
  /** The keys of the host's last whole settings object: what it can store (null until it sends one). */
  settingsKeys: string[] | null;
  /** The bind actions in the host's last whole settings object. */
  bindActions: string[] | null;
  /** Features the host reports beyond its settings keys (prefs-bridge.ts); null when it doesn't say. */
  capabilities: string[] | null;
  /** Values of website settings the host has added (settings-keys.ts), and its web HUD layout. */
  extraSettings: Record<string, unknown>;
  /** Monitors and their fullscreen modes; null until the host sends them. */
  displays: DisplayCatalog | null;
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { bunnyhop?: { postMessage: (value: string) => void } } };
    bunnyhopNativeMenu: {
      onGamepad?: (value: unknown) => void;
      onState: (value: unknown) => void;
      onAuth: (value?: unknown) => void;
      onRunEvent: (value: unknown) => void;
      version: number;
      open?: (screen: string, focus?: string) => void;
      /** The host left the map (every leave_map, also its own Main menu bind): stop the room, the gauntlet and their timers now. */
      onActivity?: (value: unknown) => void;
      onChatLink?: (url: string) => void;
      onChatSubmit?: (value: unknown) => void;
      onChatSuggest?: (value: unknown) => void;
      onRoomControl?: (value: unknown) => void;
      onLeaveMap?: () => void;
      joinRoom?: (id: string) => void;
      onRoomPose?: (value: unknown) => void;
      onRoomCommand?: (value: unknown) => void;
      /** The watched replay's speed graph and markers (replay-host.ts), once per replay. */
      onReplayTimeline?: (value: unknown) => void;
      /** The host's answer to Practice from here (replay-practice.ts). */
      onPracticeFromReplayResult?: (value: unknown) => void;
      settle?: (timeoutMs?: number) => Promise<{ ended: number; pendingImages: number }>;
    };
    __nativeMenuGraphics?: { contexts: number; attempts: number };
  }
}

let beforeSend: ((message: MenuMessage) => void) | null = null;
export function onBeforeSend(listener: (message: MenuMessage) => void): void {
  beforeSend = listener;
}
export function send(message: MenuMessage): void {
  beforeSend?.(message);
  const host = window.webkit?.messageHandlers?.bunnyhop;
  if (host) host.postMessage(JSON.stringify(message));
  // Local development and browser smoke tests can observe the same exact messages.
  window.dispatchEvent(new CustomEvent("bunnyhop:native-message", { detail: message }));
}

export function openAuth(raw: string): void {
  const url = new URL(raw, LIVE_ORIGIN);
  if (url.origin !== LIVE_ORIGIN || !url.pathname.startsWith("/api/auth/")) return;
  send({ type: "openAuth", url: url.href });
}

/** Hosts the client will hand to the system browser: credits links, the site's own pages, the Discord invite. */
export const EXTERNAL_HOSTS = [
  "github.com",
  "1998.lol",
  "bunnyhop.lol",
  "discord.gg",
  "discord.com",
  "youtube.com",
  "twitch.tv",
  "tiktok.com",
  "x.com",
] as const;
/**
 * Opens a link outside the client. The menu webview refuses every navigation
 * away from the loaded document, so an <a href> here does nothing at all —
 * a link has to leave the process to go anywhere.
 *
 * Checked here and again natively: this side keeps a bad URL from being sent,
 * the native side is what actually decides, since nothing arriving over the
 * bridge gets to be trusted on its own.
 */
export function openExternal(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (
    raw.length > 2048 ||
    /[\u0000-\u0020\u007f\\]/.test(raw) ||
    url.protocol !== "https:" ||
    url.username ||
    url.password
  )
    return false;
  const checkout =
    url.hostname === "checkout.stripe.com" &&
    (!url.port || url.port === "443") &&
    /^\/(?:c\/)?pay\//.test(url.pathname);
  if (!checkout && !EXTERNAL_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith("." + host)))
    return false;
  send({ type: "openExternal", url: url.href });
  return true;
}

/** The web's HUD_SCALE (hud/layout.ts: 0.5–1.75, steps of 0.05) in percent. */
export const HUD_SCALE_PERCENT = { min: 50, max: 175, step: 5 } as const;
const ATTEMPT_ID = /^[\w-]{16}$/,
  MAP_NAME = /^[a-zA-Z0-9_.-]{1,128}$/;
export const isMapName = (value: unknown): value is string => typeof value === "string" && MAP_NAME.test(value);
export const isAttemptId = (value: unknown): value is string => typeof value === "string" && ATTEMPT_ID.test(value);
const nonNegativeInt = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const shortText = (value: unknown, max = 200): string | null =>
  typeof value === "string" ? value.slice(0, max) : null;

/**
 * The settings before the host's first state, and the defaults the C++ keeps in step with: the website's wherever the
 * same setting exists there (ui/settings.ts DEFAULT_PREFS).
 */
function defaultSettings(): NativeSettings {
  const web = DEFAULT_PREFS;
  const crosshair = web.crosshair;
  const trainer = web.hud.strafeTrainer;
  return {
    playerModel: "bunny",
    ghostModel: "same",
    mouseDiagnostics: web.inputStats,
    capturePbScreenshots: false,
    windowMode: "windowed",
    alwaysOnTop: false,
    rememberWindowBounds: true,
    minimizeOnFocusLoss: false,
    fullscreenMode: { display: "", displayIndex: -1, width: 0, height: 0, refreshHz: 0 },
    fullscreenScaling: "stretch",
    showPlayerGlow: web.showPlayerGlow,
    firstPersonGlow: web.firstPersonGlow,
    waterQuality: "simple",
    paint: { ...web.paint },
    showGhost: web.showGhost,
    ghostOpacity: web.ghost.opacity,
    ghostNearFade: web.ghost.nearFade,
    ghostTag: web.ghost.tag,
    othersAudio: web.audio.others,
    ghostAudio: web.audio.ghosts,
    zonesVisible: web.showZones,
    effectsVisible: true,
    triggersVisible: web.triggers.show,
    clipsVisible: web.triggers.clips,
    invertY: web.invertY,
    holdRestart: web.holdRestart,
    crosshairStyle: crosshair.style,
    crosshairColor: crosshair.color,
    crosshairSize: crosshair.size,
    crosshairGap: crosshair.gap,
    crosshairThickness: crosshair.thickness,
    crosshairAlpha: crosshair.alpha,
    crosshairOutline: crosshair.outline,
    viewmodelFov: web.viewmodel.fov,
    viewmodelX: web.viewmodel.x,
    viewmodelY: web.viewmodel.y,
    viewmodelZ: web.viewmodel.z,
    viewmodelLeftHand: web.viewmodel.hand === "left",
    viewmodelBob: web.viewmodel.bob,
    viewmodelSway: web.viewmodel.sway,
    sfxVolume: web.audio.sfx,
    musicVolume: web.audio.music,
    uiVolume: web.audio.ui,
    ambienceVolume: web.audio.ambience,
    muteSfx: false,
    muteMusic: false,
    muteUi: false,
    muteAmbience: false,
    muteInBackground: web.audio.muteInBackground,
    classicSounds: web.audio.classic,
    perfectTick: web.audio.perfectTick,
    announcer: { ...DEFAULT_ANNOUNCER },
    footsteps: web.audio.footsteps,
    weaponSounds: true,
    wind: web.audio.wind,
    colorBlind: web.colorBlind,
    gainTicks: web.hud.gainTicks,
    speedColors: web.hud.speedColors,
    perfectIndicator: web.audio.perfectIndicator,
    speedGraph: web.hud.layout.graph.on,
    keysOverlay: web.hud.layout.keys.on,
    keysStyle: web.hud.keys.style,
    sensitivity: web.sensitivity,
    verticalSensitivity: web.verticalSensitivity,
    separateVertical: web.verticalSensitivityEnabled,
    timedInput: web.timedInput,
    yawSpeed: web.yawSpeed,
    angleSpeedKey: web.angleSpeedKey,
    fov: web.fov,
    sourceLook: true,
    vsync: false,
    fpsLimit: web.graphics.fpsLimit,
    limitQueuedFrames: true,
    volume: web.volume,
    muted: false,
    hud: !web.hud.hidden,
    crosshair: crosshair.style !== "none",
    viewmodel: web.viewmodel.show,
    jumpStats: web.hud.layout.jumpStats.on,
    jumpStatsColors: true,
    jumpStatsMode: "sixth",
    jumpStatsInterval: 6,
    strafeTrainer: web.hud.layout.strafeTrainer.on,
    strafeTrainerSmoothing: trainer.smoothing,
    strafeTrainerHints: trainer.hints,
    hudLayout: {},
    hudScale: Math.round(web.hud.scale * 100),
    practiceKeepVelocity: web.practice.keepVelocity,
    sfxPack: "default",
    musicPack: "default",
    discordRichPresence: true,
    discordShowMap: true,
    discordJoin: true,
    discordJoinLobbies: false,
    privacyMode: false,
    binds: Object.fromEntries(NATIVE_BIND_ACTIONS.map((action) => [action, [...DEFAULT_BINDS[action]]])),
  };
}

export const state: NativeMenuState = {
  map: null,
  loading: false,
  error: null,
  sensitivity: 2,
  paused: true,
  style: "autohop",
  track: 0,
  settings: defaultSettings(),

  replays: [],
  ghosts: [],
  discord: { state: "disabled", message: "" },
  playback: { active: false, id: "", tick: 0, totalTicks: 0, paused: true, speed: 1 },
  ghost: { enabled: false, id: "", name: "" },
  tutorial: { active: false, lesson: "jump", completed: [] },
  practice: {
    available: false,
    unavailable: null,
    mode: false,
    active: false,
    thirdPerson: false,
    tool: null,
    noclip: false,
    menuOpen: false,
    count: 0,
    current: 0,
    keepVelocity: true,
  },
  gauntlet: { id: null, map: null },
  player: null,
  music: null,
  audio: null,
  videoExport: {
    available: false,
    reason: "Checking FFmpeg availability…",
    state: "idle",
    frames: 0,
    encodedFrames: 0,
    totalFrames: 0,
    progress: 0,
    path: "",
    error: "",
    videoOnly: true,
    musicTracks: [],
  },
  client: null,
  settingsKeys: null,
  bindActions: null,
  capabilities: null,
  extraSettings: {},
  displays: null,
};

export const nativeKeyCode = (code: unknown): code is string =>
  typeof code === "string" &&
  /^(?:Key[A-Z]|Digit[0-9]|F[1-9]|F11|F12|Mouse[1-5]|MouseWheel|MWheelUp|MWheelDown|(?:Control|Shift|Alt)(?:Left|Right)|Space|Tab|Enter|Backspace|Arrow(?:Up|Down|Left|Right)|Minus|Equal|BracketLeft|BracketRight|Semicolon|Quote|Backquote|Comma|Period|Slash)$/.test(
    code,
  );

/** A paint colour and size the host takes: the website's palette and sizes only (graphics_settings.hpp). */
function paintPatch(value: unknown): PaintPrefs | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { color, size } = value as Record<string, unknown>;
  if (!PAINT_COLORS.some(([known]) => known === color)) return null;
  if (typeof size !== "string" || !Object.hasOwn(PAINT_SIZES, size)) return null;
  return { color: color as string, size: size as PaintSize };
}

const MODE_SIDE_MAX = 16384;
const MODE_REFRESH_MAX = 1000;

const modeSide = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && (value === 0 || (value >= 240 && value <= MODE_SIDE_MAX));
const refreshRate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MODE_REFRESH_MAX;

/** A fullscreen mode the host takes (window_settings.hpp read_fullscreen_mode). */
export function fullscreenModePatch(value: unknown): FullscreenMode | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { display, displayIndex, width, height, refreshHz } = value as Record<string, unknown>;
  if (typeof display !== "string" || display.length > 128) return null;
  if (typeof displayIndex !== "number" || !Number.isInteger(displayIndex) || displayIndex < -1 || displayIndex > 64)
    return null;
  if (!modeSide(width) || !modeSide(height) || (width === 0) !== (height === 0) || !refreshRate(refreshHz)) return null;
  return { display, displayIndex, width, height, refreshHz };
}

function displayModeInfo(value: unknown): DisplayModeInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { width, height, refreshHz } = value as Record<string, unknown>;
  if (!modeSide(width) || !modeSide(height) || !width || !height || !refreshRate(refreshHz)) return null;
  return { width, height, refreshHz };
}

function displayInfo(value: unknown): DisplayInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.name !== "string" || !Number.isInteger(item.index) || !Array.isArray(item.modes)) return null;
  return {
    name: item.name.slice(0, 128),
    index: item.index as number,
    window: item.window === true,
    primary: item.primary === true,
    desktop: displayModeInfo(item.desktop),
    modes: item.modes
      .slice(0, 160)
      .map(displayModeInfo)
      .filter((mode): mode is DisplayModeInfo => mode !== null),
  };
}

/** The host's monitors and modes (display_catalog.hpp), or null when it sent something else. */
export function displayCatalog(value: unknown): DisplayCatalog | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { displays, exclusive } = value as Record<string, unknown>;
  if (!Array.isArray(displays)) return null;
  return {
    displays: displays
      .slice(0, 16)
      .map(displayInfo)
      .filter((display): display is DisplayInfo => display !== null),
    exclusive: displayModeInfo(exclusive),
  };
}

export function settingsPatch(value: unknown): Partial<NativeSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>,
    out: Record<string, unknown> = {};
  if (WINDOW_MODES.includes(input.windowMode as WindowMode)) out.windowMode = input.windowMode;
  const fullscreenMode = fullscreenModePatch(input.fullscreenMode);
  if (fullscreenMode) out.fullscreenMode = fullscreenMode;
  if (FULLSCREEN_SCALINGS.includes(input.fullscreenScaling as FullscreenScaling))
    out.fullscreenScaling = input.fullscreenScaling;
  for (const [key, min, max] of [
    ["ghostOpacity", 0, 1],
    ["crosshairSize", 0, 40],
    ["crosshairGap", 0, 40],
    ["crosshairThickness", 0.5, 10],
    ["crosshairAlpha", 0, 1],
    ["viewmodelFov", 30, 100],
    ["viewmodelX", -10, 10],
    ["viewmodelY", -10, 10],
    ["viewmodelZ", -10, 10],
    ["viewmodelBob", 0, 2],
    ["viewmodelSway", 0, 2],
    ["ambienceVolume", 0, 1],
    ["sfxVolume", 0, 1],
    ["musicVolume", 0, 1],
    ["uiVolume", 0, 1],
    ["sensitivity", 0.01, 100],
    ["verticalSensitivity", 0.01, 100],
    ["fov", 60, 130],
    ["volume", 0, 1],
    ["yawSpeed", YAW_SPEED_RANGE.min, YAW_SPEED_RANGE.max],
    ["angleSpeedKey", ANGLE_SPEED_KEY_RANGE.min, ANGLE_SPEED_KEY_RANGE.max],
  ] as const)
    if (
      typeof input[key] === "number" &&
      Number.isFinite(input[key]) &&
      Number(input[key]) >= min &&
      Number(input[key]) <= max
    )
      out[key] = input[key];
  if (
    typeof input.fpsLimit === "number" &&
    Number.isInteger(input.fpsLimit) &&
    (input.fpsLimit === 0 || (input.fpsLimit >= 30 && input.fpsLimit <= 1000))
  )
    out.fpsLimit = input.fpsLimit;
  for (const key of [
    "mouseDiagnostics",
    "capturePbScreenshots",
    "alwaysOnTop",
    "rememberWindowBounds",
    "minimizeOnFocusLoss",
    "showPlayerGlow",
    "firstPersonGlow",
    "gainTicks",
    "speedColors",
    "perfectIndicator",
    "showGhost",
    "ghostNearFade",
    "ghostTag",
    "othersAudio",
    "ghostAudio",
    "zonesVisible",
    "effectsVisible",
    "triggersVisible",
    "clipsVisible",
    "invertY",
    "holdRestart",
    "crosshairOutline",
    "viewmodelLeftHand",
    "muteSfx",
    "muteMusic",
    "muteUi",
    "muteAmbience",
    "muteInBackground",
    "classicSounds",
    "perfectTick",
    "footsteps",
    "weaponSounds",
    "wind",
    "speedGraph",
    "keysOverlay",
    "separateVertical",
    "sourceLook",
    "vsync",
    "limitQueuedFrames",
    "muted",
    "hud",
    "crosshair",
    "viewmodel",
    "jumpStats",
    "jumpStatsColors",
    "strafeTrainer",
    "strafeTrainerHints",
    "discordRichPresence",
    "discordShowMap",
    "discordJoin",
    "discordJoinLobbies",
    "privacyMode",
    "timedInput",
  ])
    if (typeof input[key] === "boolean") out[key] = input[key];
  if (input.waterQuality === "simple" || input.waterQuality === "refracted") out.waterQuality = input.waterQuality;
  const paint = paintPatch(input.paint);
  if (paint) out.paint = paint;
  if (
    typeof input.crosshairStyle === "string" &&
    ["cross", "cross-dot", "dot", "t", "circle", "none"].includes(input.crosshairStyle)
  )
    out.crosshairStyle = input.crosshairStyle;
  if (input.playerModel === "bunny") out.playerModel = input.playerModel;
  if (input.ghostModel === "same" || input.ghostModel === "bunny") out.ghostModel = input.ghostModel;
  if (typeof input.colorBlind === "string" && ["off", "redGreen", "blueYellow"].includes(input.colorBlind))
    out.colorBlind = input.colorBlind;
  if (typeof input.keysStyle === "string" && ["classic", "minimal", "keycaps"].includes(input.keysStyle))
    out.keysStyle = input.keysStyle;
  if (typeof input.crosshairColor === "string" && /^#[0-9a-f]{6}$/i.test(input.crosshairColor))
    out.crosshairColor = input.crosshairColor;
  // Only these two words ever cross the bridge, so a pack choice can never
  // become a path the native side would go looking for.
  if (JUMP_STATS_MODES.includes(input.jumpStatsMode as JumpStatsMode)) out.jumpStatsMode = input.jumpStatsMode;
  if (
    Number.isInteger(input.jumpStatsInterval) &&
    Number(input.jumpStatsInterval) >= 2 &&
    Number(input.jumpStatsInterval) <= 50
  )
    out.jumpStatsInterval = input.jumpStatsInterval;
  if (
    Number.isInteger(input.strafeTrainerSmoothing) &&
    Number(input.strafeTrainerSmoothing) >= 1 &&
    Number(input.strafeTrainerSmoothing) <= 50
  )
    out.strafeTrainerSmoothing = input.strafeTrainerSmoothing;
  if (validHudLayout(input.hudLayout)) out.hudLayout = input.hudLayout;
  if (
    Number.isInteger(input.hudScale) &&
    Number(input.hudScale) >= HUD_SCALE_PERCENT.min &&
    Number(input.hudScale) <= HUD_SCALE_PERCENT.max
  )
    out.hudScale = input.hudScale;
  if (typeof input.practiceKeepVelocity === "boolean") out.practiceKeepVelocity = input.practiceKeepVelocity;
  for (const key of ["sfxPack", "musicPack"] as const)
    if (AUDIO_PACKS.includes(input[key] as AudioPack)) out[key] = input[key];
  if (input.announcer) {
    const announcer = announcerPatch(input.announcer, state.settings.announcer);
    if (announcer) out.announcer = announcer;
  }
  if (input.binds && typeof input.binds === "object" && !Array.isArray(input.binds)) {
    const binds: Record<string, string[]> = {};
    for (const action of NATIVE_BIND_ACTIONS) {
      const codes = (input.binds as Record<string, unknown>)[action];
      if (Array.isArray(codes) && codes.length <= 4 && codes.every(nativeKeyCode)) binds[action] = [...new Set(codes)];
    }
    out.binds = binds;
  }
  return out as Partial<NativeSettings>;
}

/** What the host's settings say beyond NativeSettings: which keys it has, and the website settings it added. */
function readHostSettings(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  state.settingsKeys = Object.keys(input).slice(0, 1024);
  const binds = input.binds;
  if (binds && typeof binds === "object" && !Array.isArray(binds)) state.bindActions = Object.keys(binds).slice(0, 256);
  const extra = { ...state.extraSettings, ...requestedPatch(input) };
  const layout = input.hudLayoutWeb;
  if (layout && typeof layout === "object" && !Array.isArray(layout)) extra.hudLayoutWeb = layout;
  state.extraSettings = extra;
}

export function applyState(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const next = value as Record<string, unknown>;
  if (next.map === null || next.map === "") state.map = null;
  else if (typeof next.map === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(next.map)) state.map = next.map;
  if (next.loadProgress === null) state.loadProgress = null;
  else if (next.loadProgress && typeof next.loadProgress === "object") {
    const p = next.loadProgress as Record<string, unknown>;
    const number = (key: string) =>
      typeof p[key] === "number" && Number.isFinite(p[key]) ? Math.max(0, p[key] as number) : 0;
    state.loadProgress = {
      stage: typeof p.stage === "string" ? p.stage.slice(0, 80) : "",
      message: typeof p.message === "string" ? p.message.slice(0, 512) : "",
      received: number("received"),
      total: number("total"),
      filesDone: number("filesDone"),
      filesTotal: number("filesTotal"),
      cached: p.cached === true,
      offline: p.offline === true,
      ...(typeof p.map === "string" ? { map: p.map.slice(0, 160) } : {}),
    };
  }
  if (typeof next.loading === "boolean" || typeof next.loading === "string") state.loading = next.loading;
  if (next.error === null || typeof next.error === "string") state.error = next.error;
  if (typeof next.sensitivity === "number" && Number.isFinite(next.sensitivity) && next.sensitivity > 0)
    state.sensitivity = next.sensitivity;
  if (typeof next.paused === "boolean") state.paused = next.paused;
  if (isStyleId(next.style)) state.style = next.style;
  if (Number.isSafeInteger(next.track) && Number(next.track) >= 0) state.track = Number(next.track);
  if (next.settings) {
    const patch = settingsPatch(next.settings);
    state.settings = { ...state.settings, ...patch, binds: { ...state.settings.binds, ...patch.binds } };
    state.sensitivity = state.settings.sensitivity;
    readHostSettings(next.settings);
  } else state.settings.sensitivity = state.sensitivity;
  if (next.displays !== undefined) state.displays = displayCatalog(next.displays);
  if (Array.isArray(next.capabilities))
    state.capabilities = next.capabilities
      .filter((item): item is string => typeof item === "string" && item.length <= 64)
      .slice(0, 1024);
  if (Array.isArray(next.replays))
    state.replays = next.replays
      .slice(0, 5000)
      .filter(
        (item): item is NativeReplay =>
          !!item &&
          typeof item === "object" &&
          typeof item.id === "string" &&
          item.id.length <= 256 &&
          typeof item.name === "string" &&
          typeof item.map === "string" &&
          isStyleId(item.style) &&
          [item.track, item.seconds, item.recordedAt, item.bytes].every(
            (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
          ),
      );
  if (next.playback && typeof next.playback === "object") {
    const playback = next.playback as Record<string, unknown>;
    for (const key of ["active", "paused", "fullRecording"] as const) {
      if (typeof playback[key] === "boolean") state.playback[key] = playback[key];
    }
    const numbers = [
      "tick",
      "totalTicks",
      "speed",
      "seconds",
      "tickInterval",
      "timeMs",
      ...PLAYBACK_RANGE_KEYS,
    ] as const;
    for (const key of numbers) {
      const value = playback[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) state.playback[key] = value;
    }
    if (typeof playback.id === "string") state.playback.id = playback.id;
    if (REPLAY_CAMERAS.includes(playback.camera as ReplayCamera))
      state.playback.camera = playback.camera as ReplayCamera;
  }
  if (next.discord && typeof next.discord === "object") {
    const discord = next.discord as Record<string, unknown>;
    if (DISCORD_STATES.includes(discord.state as DiscordState)) state.discord.state = discord.state as DiscordState;
    if (typeof discord.message === "string") state.discord.message = discord.message.slice(0, 200);
  }
  if (next.client && typeof next.client === "object") {
    const client = next.client as Record<string, unknown>,
      viewport = client.viewport;
    const size = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 65535;
    state.client = {
      version: typeof client.version === "string" ? client.version.slice(0, 40) : "",
      build: typeof client.build === "string" ? client.build.slice(0, 80) : "",
      gpu: typeof client.gpu === "string" ? client.gpu.slice(0, 200) : "",
      viewport:
        Array.isArray(viewport) && viewport.length === 2 && viewport.every(size) ? [viewport[0], viewport[1]] : [0, 0],
      dpr:
        typeof client.dpr === "number" && Number.isFinite(client.dpr) && client.dpr > 0 && client.dpr <= 8
          ? client.dpr
          : 1,
    };
  }
  if (Array.isArray(next.ghosts))
    state.ghosts = next.ghosts
      .slice(0, 4)
      .filter(
        (value): value is NativeGhost =>
          !!value &&
          typeof value === "object" &&
          Number.isInteger(value.slot) &&
          value.slot >= 0 &&
          value.slot < 4 &&
          typeof value.id === "string" &&
          value.id.length <= 256 &&
          typeof value.name === "string" &&
          value.name.length <= 128 &&
          typeof value.enabled === "boolean",
      );
  if (next.ghost && typeof next.ghost === "object") {
    const ghost = next.ghost as Record<string, unknown>;
    if (typeof ghost.enabled === "boolean") state.ghost.enabled = ghost.enabled;
    for (const key of ["id", "name"] as const) if (typeof ghost[key] === "string") state.ghost[key] = ghost[key];
  }
  if (next.tutorial && typeof next.tutorial === "object") {
    const tutorial = next.tutorial as Record<string, unknown>;
    if (typeof tutorial.active === "boolean") state.tutorial.active = tutorial.active;
    if (LESSON_IDS.includes(tutorial.lesson as LessonId)) state.tutorial.lesson = tutorial.lesson as LessonId;
    if (Array.isArray(tutorial.completed))
      state.tutorial.completed = LESSON_IDS.filter((id) => (tutorial.completed as unknown[]).includes(id));
  }
  if (next.practice && typeof next.practice === "object") {
    const practice = next.practice as Record<string, unknown>,
      out = state.practice;
    for (const key of ["available", "mode", "active", "thirdPerson", "noclip", "menuOpen", "keepVelocity"] as const)
      if (typeof practice[key] === "boolean") out[key] = practice[key];
    if (practice.unavailable === null) out.unavailable = null;
    else if (typeof practice.unavailable === "string") out.unavailable = practice.unavailable.slice(0, 200);
    // The host's camera tool stays sticky for the attempt after returning to
    // first person. Keep the shared web tool union (teleport/noclip) intact.
    if (practice.tool === "camera") {
      out.thirdPerson = true;
      out.tool = null;
    } else if (practice.active === false && typeof practice.thirdPerson !== "boolean") out.thirdPerson = false;
    if (practice.tool === null || practice.tool === "teleport" || practice.tool === "noclip") out.tool = practice.tool;
    if (nonNegativeInt(practice.count)) out.count = Math.min(Number(practice.count), 1000);
    if (nonNegativeInt(practice.current)) out.current = Math.min(Number(practice.current), out.count);
  }
  if (next.gauntlet === null) state.gauntlet = { id: null, map: null };
  else if (next.gauntlet && typeof next.gauntlet === "object") {
    const gauntlet = next.gauntlet as Record<string, unknown>;
    if (gauntlet.id === null || isAttemptId(gauntlet.id)) state.gauntlet.id = gauntlet.id;
    if (gauntlet.map === null || isMapName(gauntlet.map)) state.gauntlet.map = gauntlet.map;
  }
  if (next.player === null) state.player = null;
  else if (next.player && typeof next.player === "object") {
    const player = next.player as Record<string, unknown>;
    if (
      (player.map === null || isMapName(player.map)) &&
      isStyleId(player.style) &&
      nonNegativeInt(player.track) &&
      PLAYER_MODES.includes(player.mode as PlayerMode)
    )
      state.player = {
        map: player.map,
        style: player.style,
        track: Number(player.track),
        mode: player.mode as PlayerMode,
        practice: player.practice === true,
      };
  }
  if (next.playback && typeof next.playback === "object") {
    const who = (next.playback as Record<string, unknown>).player;
    if (who === null) delete state.playback.player;
    else if (who && typeof who === "object") {
      const raw = who as Record<string, unknown>,
        player: NonNullable<PlaybackState["player"]> = {};
      if (typeof raw.id === "string" && /^[\w-]{1,64}$/.test(raw.id)) player.id = raw.id;
      if (typeof raw.runId === "string" && /^[\w-]{1,64}$/.test(raw.runId)) player.runId = raw.runId;
      const name = shortText(raw.name, 64);
      if (name) player.name = name;
      state.playback.player = player;
    }
  }
  if (next.videoExport && typeof next.videoExport === "object") {
    const value = next.videoExport as Record<string, unknown>,
      out = state.videoExport;
    if (typeof value.available === "boolean") out.available = value.available;
    if (Array.isArray(value.musicTracks))
      out.musicTracks = value.musicTracks.slice(0, 512).flatMap((track) => {
        if (!track || typeof track !== "object") return [];
        const t = track as Record<string, unknown>;
        return typeof t.id === "string" && t.id.length > 0 && t.id.length <= 256 && typeof t.title === "string"
          ? [{ id: t.id, title: t.title.slice(0, 256) }]
          : [];
      });
    if (
      typeof value.state === "string" &&
      ["idle", "capturing", "encoding", "completed", "canceled", "error"].includes(value.state)
    )
      out.state = value.state as VideoExportState["state"];
    for (const key of ["reason", "path", "error"] as const)
      if (typeof value[key] === "string") out[key] = value[key].slice(0, 4096);
    for (const key of ["frames", "encodedFrames", "totalFrames"] as const)
      if (Number.isSafeInteger(value[key]) && Number(value[key]) >= 0) out[key] = Number(value[key]);
    if (typeof value.progress === "number" && Number.isFinite(value.progress))
      out.progress = Math.max(0, Math.min(1, value.progress));
    if (typeof value.videoOnly === "boolean") out.videoOnly = value.videoOnly;
  }
  if (next.audio && typeof next.audio === "object") {
    const value = next.audio as Record<string, unknown>;
    state.audio = {
      classicLoading: value.classicLoading === true,
      classicActive: value.classicActive === true,
      classicStatus: typeof value.classicStatus === "string" ? value.classicStatus.slice(0, 1024) : "",
      sfxStatus: typeof value.sfxStatus === "string" ? value.sfxStatus.slice(0, 1024) : "",
      error: typeof value.error === "string" ? value.error.slice(0, 1024) : "",
    };
  }
  if (next.music === null) state.music = null;
  else if (next.music && typeof next.music === "object") {
    const music = next.music as Record<string, unknown>;
    const out: MusicState = {
      ...(state.music ?? { id: "", title: "", role: "", playing: false, available: false, loading: false, status: "" }),
    };
    for (const key of ["id", "title", "role", "status"] as const) {
      const text = shortText(music[key]);
      if (text !== null) out[key] = text;
    }
    for (const key of ["playing", "available", "loading"] as const)
      if (typeof music[key] === "boolean") out[key] = music[key];
    state.music = out;
  }
  return true;
}
