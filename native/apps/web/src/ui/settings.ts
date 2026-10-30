import { videoGrade, VIDEO_LIMITS, type VideoGrade } from "../video-settings";
import { ANGLE_SPEED_KEY_RANGE, YAW_SPEED_RANGE } from "../turn-binds";
import type { LightingProfileId } from "../graphics/profiles";
import { graphicsPreset as lookPreset, type GraphicsPreset as LookPreset } from "../graphics/presets";
import { DEFAULT_MOUSE_DPI } from "../mouse-settings";
// Client preferences (localStorage, applied live). Nothing here feeds the simulation's physics:
// tick rate / airaccelerate / autohop are fixed per style (styles.ts, picked in the menus or with the cycleStyle
// key) and recorded in replays.

import { DEFAULT_BINDS } from "../binds";
import { CLASSIC, DEFAULT_KEYS, HUD_ELEMENTS, HUD_SCALE, moveRetiredPlaces, type HudLayout, type KeysPrefs } from "../hud/layout";
import { VIEWMODEL_POS, VIEWMODEL_POS_V1, VIEWMODEL_POS_V2, VIEWMODEL_REV } from "../viewmodel/defaults";
import { DEFAULT_SSJ, type SsjPrefs } from "../ssj/stats";
import { DEFAULT_TRIGGER_PREFS, normalizeTriggerPrefs, type TriggerPrefs } from "../triggers/volumes";
import { DEFAULT_PAINT, type PaintPrefs } from "../paint/prefs";
import type { GhostRouteMode, GhostRouteSource } from "../ghost-route-data";
import type { AutoRestartAction, AutoRestartWhen } from "../auto-restart";
import { COLOR_BLIND_MODES, type ColorBlindMode } from "../palette";

export type Action =
  | "forward"
  | "back"
  | "left"
  | "right"
  | "jump"
  | "duck"
  | "use"
  | "restart"
  | "restartBonus"
  | "restartMain"
  // Start point (start-point.ts): where R / B / M put you in that track's start zone.
  | "setStart"
  | "clearStart"
  | "cycleStyle"
  // Leave for the main menu from the game (leave-confirm.ts: asks once during a timed run). Unbound by default.
  | "mainMenu"
  | "hudEditor"
  // Opens the chat (rooms: net/mp.ts; solo: solo-chat.ts). Y and U by default, like CS:S say / say_team.
  | "chat"
  | "thirdPerson"
  | "attack"
  | "attack2"
  | "inspect"
  | "viewmodel"
  | "flashlight"
  | "keysOverlay"
  | "hideUi"
  | "mute"
  | "nextTrack"
  | "paint"
  | "paintOnce"
  | "clearPaint"
  | "measurePoint"
  | "clearMeasure"
  | "lastLj"
  // Practice (practice-mode/): practice mode's toggle, then the tools (any solo attempt; a teleport or noclip makes it practice).
  | "practice"
  | "noclip"
  | "cpSave"
  | "cpTeleport"
  | "cpPrev"
  | "cpNext"
  | "turnLeft"
  | "turnRight"
  | "turnFast"
  // Weapons (binds.ts WEAPON_ACTIONS): slot requests, drop and reload for the guns some maps hand out (physics v5).
  | "slot1"
  | "slot2"
  | "slot3"
  | "lastWeapon"
  | "nextWeapon"
  | "prevWeapon"
  | "drop"
  | "reload"
  // Weapon commands (weapon-commands.ts, physics v7): !usp, !glock and the !guns menu.
  | "giveUsp"
  | "giveGlock"
  | "gunMenu";
export type MenuBackground = "live" | "still" | "off";
/** Shape of the 3D view while playing: the screen's own, or a fixed aspect ratio (Settings → Graphics → Aspect ratio). */
export type AspectRatio = "native" | "4:3" | "5:4" | "16:10" | "16:9";
/** A fixed aspect ratio fills the screen stretched (CS's "4:3 stretched") or sits between black bars. */
export type AspectFit = "stretch" | "bars";
export type HiddenKeeps = "speedKeys" | "nothing";
/** Leaderboard place beside the split (board-place.ts): off, the place ("#4"), or the place and top % ("#4 · top 3%"). */
export type PlaceReadout = "off" | "place" | "top";
/** Player model: the bunnyhop.lol bunny (default), the classic runner, or the original CS:S models (team + skin below). */
export type PlayerModelChoice = "bunny" | "runner" | "css";
export type CssTeam = "ct" | "t";
export type CtSkin = "ct_urban" | "ct_gsg9" | "ct_sas" | "ct_gign";
export type TSkin = "t_phoenix" | "t_leet" | "t_arctic" | "t_guerilla";
export type CrosshairStyle = "cross" | "cross-dot" | "dot" | "t" | "circle" | "none";
export type ViewmodelHand = "right" | "left";

/** Music: always (menu track in menus, the playlist in game), only in menus (home + pause), or off. */
export type MusicMode = "always" | "menus" | "off";

/** See AudioPrefs.rev. 1 (0.0.25): Wind defaults to off. */
export const AUDIO_REV = 1;

/** Sound options (apps/web/src/audio). Bus levels multiply the master `volume`. */
export type AnnouncerLine = "off" | "perfect" | "godlike" | "holyshit";
export interface AnnouncerPrefs {
  enabled: boolean; finish: boolean; movement: boolean; local: boolean; server: boolean;
  volume: number; pb: AnnouncerLine; wr: AnnouncerLine; speed: AnnouncerLine; highSpeed: AnnouncerLine; streak: AnnouncerLine; lj: AnnouncerLine;
  speedThreshold: number; highSpeedThreshold: number; streakThreshold: number; ljThreshold: number;
}
export interface AudioPrefs {
  announcer: AnnouncerPrefs;
  perfHud: boolean;
  perfectIndicator: boolean;
  perfectTick: boolean;
  music: number;
  sfx: number;
  ui: number;
  ambience: number;
  /** Global mute (the mute key / speaker buttons). */
  muted: boolean;
  /** Per-bus mutes. */
  mute: { music: boolean; sfx: boolean; ui: boolean; ambience: boolean };
  musicMode: MusicMode;
  shuffle: boolean;
  /** Use the original CS:S footstep / landing / water / knife sounds when the hosted CS:S content has them. */
  classic: boolean;
  footsteps: boolean;
  /** Wind that rises with speed (off by default since 0.0.25). */
  wind: boolean;
  /**
   * Revision of the audio defaults these values were saved under (AUDIO_REV): migrateAudio moves players from before it
   * to the new defaults once (0.0.25: Wind off), and keeps every choice made after.
   */
  rev: number;
  /** Other players in rooms (positional). */
  others: boolean;
  /** Race ghosts (positional, quiet). */
  ghosts: boolean;
  /** Silence everything while the tab is in the background. */
  muteInBackground: boolean;
}

export interface Prefs {
  paint: PaintPrefs;
  /** CS:S `sensitivity` (degrees per count = sensitivity * m_yaw). */
  sensitivity: number;
  verticalSensitivityEnabled: boolean;
  verticalSensitivity: number;
  /** Mouse DPI, only used to show cm/360. */
  dpi: number;
  /** The player explicitly supplied DPI; never publish the calculator default as measured DPI. */
  dpiConfirmed: boolean;
  /** Keep your DPI off your profile (Settings → Mouse & view → Show DPI on profile). */
  dpiHidden: boolean;
  invertY: boolean;
  /** Pointer lock with unadjustedMovement (raw input) where the browser supports it. */
  rawInput: boolean;
  /** Null binds (null-binds.ts): with A + D or W + S held, the key pressed last wins. Off by default. */
  nullBinds: boolean;
  /** Release W on jump (w-release.ts): a jump taken holding W lets go of forward until you land or press W again. Off
   * by default. */
  wRelease: boolean;
  /** CS:S `cl_yawspeed`: +left / +right, degrees per second (turn-binds.ts YAW_SPEED_RANGE). Fixed per recording. */
  yawSpeed: number;
  /** CS:S `cl_anglespeedkey`: the turn speed's multiplier while Fast turn is held (ANGLE_SPEED_KEY_RANGE). */
  angleSpeedKey: number;
  /** Drop lone impossible mouse reports (browser pointer-lock jumps) and the first event after locking (mouse-filter.ts). */
  spikeFilter: boolean;
  /** Timestamped input (timed-input.ts): each tick takes the mouse motion and movement keys made before it, not the
   * frame's. On by default. */
  timedInput: boolean;
  /** Input diagnostics overlay: event rate, deltas, dropped spikes, frame times (input-debug.ts; also ?inputdebug=1). */
  inputStats: boolean;
  /** CS:S `fov_desired`: horizontal FOV at 4:3; wider screens get more (Hor+). */
  fov: number;
  crosshair: {
    style: CrosshairStyle;
    color: string;
    /** Arm length, CSS px. */
    size: number;
    thickness: number;
    gap: number;
    outline: boolean;
    alpha: number;
  };
  hud: {
    speedColors: boolean;
    /** Each jump's speed gain floats off the speed readout ("+14"). */
    gainTicks: boolean;
    /** A soft edge glow that grows with speed from 600 u/s (off by default; never on potato). */
    edgeGlow: boolean;
    /** The leaderboard place your time would take, beside the split (off by default). */
    place: PlaceReadout;
    strafeTrainer: TrainerPrefs;
    /** Overall HUD size multiplier (on top of each element's own scale). */
    scale: number;
    /** Per-element visibility, position (9-grid anchor + viewport-fraction offset) and scale. */
    layout: HudLayout;
    /** Keys overlay look (its size is layout.keys.s). */
    keys: KeysPrefs;
    /** Hide UI in game (ui/hide-ui.ts; the Hide UI key flips it): playing and spectating show just the game. */
    hidden: boolean;
    /** What a hidden UI keeps, in game and in replays: the speed and keys overlay, or nothing. */
    hiddenKeeps: HiddenKeeps;
    /** Jump stats (!ssj, ssj/): the chat line, which jumps it reports and its fields. The HUD element is layout.jumpStats. */
    ssj: SsjPrefs;
    movement: { fjtChat: boolean; lj: boolean; ljChat: boolean };
  };
  /** Master volume (0..1). The per-bus levels and the rest of the sound options are in `audio`. */
  volume: number;
  audio: AudioPrefs;
  /** Master switch for race ghosts (see `ghost` for sources and look). */
  showGhost: boolean;
  ghost: {
    /** Sources raced at once (each per track): your PB, the server WR, a loaded replay / leaderboard run. */
    pb: boolean;
    wr: boolean;
    custom: boolean;
    opacity: number;
    /** Fading path of the last few seconds. */
    trail: boolean;
    /** Persistent jump-to-jump/recorded path and white takeoff markers for one selected race ghost. */
    route: boolean;
    routeSource: GhostRouteSource;
    routeMode: GhostRouteMode;
    /** Fade a ghost out when the camera is inside / right next to it. */
    nearFade: boolean;
    /** Name / time / live delta tag above each ghost. */
    tag: boolean;
  };
  /** Floating name tags over other players (rooms) and ghosts (player/tag.ts). */
  tags: {
    /** Off (default): a tag only shows while its player / ghost is in line of sight (CS:S style: no names through walls). */
    throughWalls: boolean;
    /** Name tags over other players in rooms (ghosts have their own: ghost.tag). */
    players: boolean;
  };
  showZones: boolean;
  /**
   * Colour-blind palette (palette.ts): the colours that mean something (gain / loss, ahead / behind, the strafe trainer's
   * zones, zones and default trigger colours) swapped for ones that stay apart. Off is the original look.
   */
  colorBlind: ColorBlindMode;
  showPlayerGlow: boolean;
  /** A supporter's own glow on their first-person hands and knife (0.0.21; the glow panel's "In first person"). */
  firstPersonGlow: boolean;
  /** Trigger and clip overlays (!showtriggers, !showclips, the !triggers menu; triggers/). Drawn only, never part of a run. */
  triggers: TriggerPrefs;
  /**
   * Player models (replays, third person, other players, ghosts, menu background). The bunny animates with the CS:S
   * animations when the hosted CS:S content is available (procedurally until then); the CS:S models need that content
   * and fall back to the bunny without it. The bunny's colourway is a cosmetic (player/cosmetics.ts).
   */
  models: {
    player: PlayerModelChoice;
    /** Ghosts: "same" as players, or their own choice. */
    ghost: PlayerModelChoice | "same";
    /** CS:S team and skin per team, for the "css" choice. */
    team: CssTeam;
    ct: CtSkin;
    t: TSkin;
  };
  graphics: {
    /** Rendering look (graphics/presets.ts), separate from the Quality presets below. */
    preset: LookPreset;
    /** Reflective water in the Source look (re-renders the scene for water in view, like CS:S). */
    waterReflections: boolean;
    bloom: boolean;
    mapProfiles: boolean;
    ambienceShowcase: boolean;
    lightingProfile: LightingProfileId; skyMode: "map" | "procedural" | "pack"; skyPackId: string | null; skyRotation: number; skyExposure: number; lightingSource: "map" | "pack"; directContribution: number; ambientContribution: number; clouds: boolean; cloudQuality: "low" | "medium" | "high"; cloudCoverage: number; cloudDensity: number;
    contactShading: boolean;
    atmosphere: boolean;
    sunShafts: boolean;
    materialResponse: boolean;
    volumetric: boolean;
    spatialAA: boolean;
    localLights: boolean;
    localQuality: "low" | "medium" | "high";
    localBudget: number;
    localStrength: number;
    dynamicGI: boolean;
    tracedGI: boolean;
    giQuality: "low" | "medium";
    giStrength: number;
    giRange: number;
    dynamicShadows: boolean;
    shadowQuality: "low" | "medium" | "high";
    shadowDistance: number;
    shadowStrength: number;
    /**
     * Render resolution as a fraction of the screen's (its pixel ratio capped at 2x, 1x in Potato mode): 0.25 to 2,
     * above 1 supersamples.
     */
    resolutionScale: number;
    /** MSAA on the game's canvas. From the next page load (a WebGL context can't change it). */
    antialias: boolean;
    /** The 3D view's aspect ratio while playing (`gameView`). */
    aspect: AspectRatio;
    aspectFit: AspectFit;
    /** Upscale a lowered resolution with sharp pixels instead of smoothing (CSS image-rendering: pixelated). */
    pixelated: boolean;
    anisotropy: number;
    /** Local display adjustment: 1 is neutral; no simulation or replay changes. */
    brightness: number;
    gamma: number;
    vibrance: number;
    /** Remove baked map lighting while keeping textures and fog. */
    fullbright: boolean;
    /** Main-menu background: a live 3D map flythrough, a still frame of it, or a plain gradient. */
    menuBackground: MenuBackground;
    /**
     * Go fullscreen when clicking into the game (play-lock.ts). In Chromium it also takes the keyboard (Keyboard Lock),
     * so Ctrl+W can't close the tab mid-run and Esc pauses without leaving fullscreen.
     */
    fullscreen: boolean;
    /**
     * Potato graphics (potato.ts): flat colours instead of textures, plain water and sky, no 3D skybox or sprite
     * trails, no HiDPI. Live.
     */
    potato: boolean;
    /** Session-only camera light; always starts off on a fresh page/map. */
    flashlight: boolean;
    /**
     * FPS limit while playing (frame-loop.ts; 0 = none). Applies with or without `uncapped`: below the display's refresh
     * rate it skips frames. 1000 by default, as Aimperion: past ~1000 the loop redraws an unchanged view and the churn
     * costs latency.
     */
    fpsLimit: number;
    /** Exceed monitor FPS: an uncapped frame loop while playing instead of requestAnimationFrame (frame-loop.ts). */
    uncapped: boolean;
    /**
     * Low-latency canvas: a desynchronized WebGL context, so frames past the refresh rate reach the screen (Chromium on
     * Windows and ChromeOS). From the next page load (a context can't change it).
     */
    lowLatency: boolean;
    /** FPS limit in menus and while paused (0 = the same as playing). */
    menuFps: number;
  };
  /**
   * First-person viewmodel (apps/web/src/viewmodel/): the bunny's gloved hands with the carrot blade, CS:S knife style.
   * Cosmetic only (mouse swings never reach the simulation).
   */
  viewmodel: {
    show: boolean;
    /** CS:S `viewmodel_fov` (horizontal at 4:3, Hor+ like fov_desired; CS:S 54). */
    fov: number;
    /** Bob amount (cl_bob style walk bob, landing dip, breathing): 0 = off, 1 = CS:S. */
    bob: number;
    /** Sway amount (viewmodel lag on mouse movement, strafe tilt): 0 = off, 1 = CS:S. */
    sway: number;
    /** cl_righthand. */
    hand: ViewmodelHand;
    /**
     * CS:GO viewmodel_offset_x / _y / _z, Source units in view space: x right, y forward, z up (0 = the CS:S pose).
     * x mirrors with the hand (positive is always outward, away from the screen centre).
     */
    x: number;
    y: number;
    z: number;
    /**
     * Revision of the default framing these values were saved under (VIEWMODEL_REV): migrateViewmodel moves players
     * who never changed it to the current default once (v0.0.6: lower and smaller; v0.0.29: wider, hands and sleeves in
     * view), and leaves custom ones alone.
     */
    rev: number;
  };
  binds: Record<Action, string[]>;
  /** Practice mode (practice-mode/): a checkpoint teleport keeps the speed you saved it with (bhoptimer does), or stops you. */
  practice: { keepVelocity: boolean };
  /** Restart keys (R / B / M) need a short hold (restart-hold.ts HOLD_MS) so a stray press can't end a run (restart-guard.ts). */
  holdRestart: boolean;
  /** Auto restart (auto-restart.ts): once a run passes your PB / the WR / the custom ghost, restart it or play a sound. Off by default. */
  autoRestart: { when: AutoRestartWhen; action: AutoRestartAction };
  /**
   * How `binds` name mouse buttons: MOUSE_NAMES = Source's (Mouse2 right, Mouse3 middle; binds.ts mouseCode). Absent in
   * prefs saved before 0.0.12, whose Mouse2 / Mouse3 were the DOM's middle / right (migrateMouseNames).
   */
  mouseNames: number;
  /** One-time addition of the F4 bonus alias to untouched legacy defaults. */
  bonusBindRevision: number;
}

export const ACTIONS: { id: Action; label: string }[] = [
  { id: "forward", label: "Forward" },
  { id: "back", label: "Back" },
  { id: "left", label: "Strafe left" },
  { id: "right", label: "Strafe right" },
  { id: "jump", label: "Jump" },
  { id: "duck", label: "Duck" },
  { id: "use", label: "Use (doors, buttons)" },
  { id: "restart", label: "Restart run" },
  { id: "restartBonus", label: "Bonus (next track)" },
  { id: "restartMain", label: "Main track" },
  { id: "setStart", label: "Set start point" },
  { id: "clearStart", label: "Clear start point" },
  { id: "cycleStyle", label: "Switch style" },
  { id: "mainMenu", label: "Main menu" },
  { id: "hudEditor", label: "Edit HUD layout" },
  { id: "chat", label: "Chat" },
  { id: "thirdPerson", label: "Third person (practice)" },
  { id: "attack", label: "Slash (carrot)" },
  { id: "attack2", label: "Stab (carrot)" },
  { id: "inspect", label: "Inspect carrot" },
  { id: "viewmodel", label: "Show / hide viewmodel" },
  { id: "flashlight", label: "Flashlight" },
  { id: "keysOverlay", label: "Show / hide keys overlay" },
  { id: "hideUi", label: "Hide UI" },
  { id: "mute", label: "Mute sound" },
  { id: "nextTrack", label: "Next music track" },
  { id: "paint", label: "Paint (hold)" },
  { id: "paintOnce", label: "Place paint mark" },
  { id: "clearPaint", label: "Clear paint" },
  { id: "measurePoint", label: "Set measurement point" },
  { id: "clearMeasure", label: "Clear measurement" },
  { id: "lastLj", label: "Last jump / share" },
  { id: "practice", label: "Practice mode" },
  { id: "noclip", label: "Noclip" },
  { id: "cpSave", label: "Save checkpoint" },
  { id: "cpTeleport", label: "Teleport to checkpoint" },
  { id: "cpPrev", label: "Previous checkpoint" },
  { id: "cpNext", label: "Next checkpoint" },
  { id: "turnLeft", label: "Turn left (+left)" },
  { id: "turnRight", label: "Turn right (+right)" },
  { id: "turnFast", label: "Fast turn (+speed)" },
  { id: "slot1", label: "Primary weapon" },
  { id: "slot2", label: "Pistol" },
  { id: "slot3", label: "Knife" },
  { id: "lastWeapon", label: "Last weapon" },
  { id: "nextWeapon", label: "Next weapon" },
  { id: "prevWeapon", label: "Previous weapon" },
  { id: "drop", label: "Drop weapon" },
  { id: "reload", label: "Reload" },
  { id: "giveUsp", label: "Get the USP (!usp)" },
  { id: "giveGlock", label: "Get the Glock (!glock)" },
  { id: "gunMenu", label: "Guns menu (!guns)" },
];

/** Default viewmodel framing (viewmodel/defaults.ts, a leaf module: no import cycle through the settings sections). */
export { VIEWMODEL_POS, VIEWMODEL_REV };

/** Prefs.mouseNames: mouse binds use Source's button names (binds.ts mouseCode; 0.0.12). */
export const MOUSE_NAMES = 2;

/** Strafe trainer looks: the original thin gauge, a thick bar with coloured zones, a thin zoned line with a marker. */
export type TrainerStyle = "classic" | "detailed" | "minimal";
export interface TrainerPrefs {
  color: string;
  hints: boolean;
  style: TrainerStyle;
  /** 100% in the middle and the marker moves the way you turn; off: 0% at the left end, 200% at the right. */
  follow: boolean;
  /** Ticks averaged into the reading (1 = none). */
  smoothing: number;
  /** ± % around 100 that counts as on pace (green); amber reaches three times as far. */
  zone: number;
  /** Gauge thickness, a multiple of the style's own. */
  height: number;
  /** The trainer fades while the pace is under this % (0 = never). */
  dimBelow: number;
  showPace: boolean;
  /** A tick on each jump, pitched by that jump's zone. */
  sound: boolean;
}
export const DEFAULT_TRAINER: TrainerPrefs = { color: "#ffffff", hints: false, style: "classic", follow: false, smoothing: 8, zone: 10, height: 1, dimBelow: 0, showPace: true, sound: false };
export type TrainerPreset = "beginner" | "standard" | "strict";
/** What a preset sets; colour, height, dimming and sound stay the player's. */
const TRAINER_PRESETS: Record<TrainerPreset, Pick<TrainerPrefs, "style" | "follow" | "smoothing" | "zone" | "hints" | "showPace">> = {
  beginner: { style: "detailed", follow: true, smoothing: 12, zone: 20, hints: true, showPace: true },
  standard: { style: "classic", follow: false, smoothing: 8, zone: 10, hints: false, showPace: true },
  strict: { style: "minimal", follow: true, smoothing: 3, zone: 5, hints: false, showPace: true },
};
export function applyTrainerPreset(t: TrainerPrefs, preset: TrainerPreset): void {
  Object.assign(t, TRAINER_PRESETS[preset]);
}
/** The preset `t` matches, if any. */
export function trainerPreset(t: TrainerPrefs): TrainerPreset | null {
  return (Object.keys(TRAINER_PRESETS) as TrainerPreset[]).find((k) => Object.entries(TRAINER_PRESETS[k]).every(([f, v]) => t[f as keyof TrainerPrefs] === v)) ?? null;
}

export const DEFAULT_PREFS: Prefs = {
  paint: { ...DEFAULT_PAINT },
  sensitivity: 2,
  verticalSensitivityEnabled: false,
  verticalSensitivity: 2,
  dpi: DEFAULT_MOUSE_DPI,
  dpiConfirmed: false,
  dpiHidden: false,
  invertY: false,
  rawInput: true,
  nullBinds: false,
  wRelease: false,
  yawSpeed: 210,
  angleSpeedKey: 2,
  spikeFilter: true,
  timedInput: true,
  inputStats: false,
  fov: 90,
  crosshair: { style: "cross", color: "#4dff6a", size: 6, thickness: 2, gap: 4, outline: true, alpha: 1 },
  hud: { speedColors: true, gainTicks: true, edgeGlow: false, place: "off", strafeTrainer: DEFAULT_TRAINER, scale: 1, layout: CLASSIC, keys: DEFAULT_KEYS, hidden: false, hiddenKeeps: "speedKeys", ssj: DEFAULT_SSJ, movement: { fjtChat: false, lj: false, ljChat: true } },
  volume: 0.8,
  audio: {
    announcer: { enabled: false, finish: true, movement: true, local: true, server: true, volume: 0.8, pb: "perfect", wr: "godlike", speed: "godlike", highSpeed: "holyshit", streak: "perfect", lj: "perfect", speedThreshold: 1500, highSpeedThreshold: 2500, streakThreshold: 3, ljThreshold: 250 },
    perfHud: true, perfectIndicator: true, perfectTick: false,
    music: 0.5,
    sfx: 0.8,
    ui: 0.6,
    ambience: 0.7,
    muted: false,
    mute: { music: false, sfx: false, ui: false, ambience: false },
    musicMode: "always",
    shuffle: true,
    classic: false,
    footsteps: true,
    wind: false,
    rev: AUDIO_REV,
    others: true,
    ghosts: false,
    muteInBackground: true,
  },
  showGhost: true,
  ghost: { pb: true, wr: true, custom: true, opacity: 0.55, trail: true, route: false, routeSource: "auto", routeMode: "jumps", nearFade: true, tag: true },
  tags: { throughWalls: false, players: true },
  showZones: true,
  colorBlind: "off",
  triggers: DEFAULT_TRIGGER_PREFS,
  showPlayerGlow: true,
  firstPersonGlow: true,
  models: { player: "bunny", ghost: "same", team: "ct", ct: "ct_urban", t: "t_leet" },
  graphics: { preset: "source", waterReflections: true, bloom: true, mapProfiles: false, ambienceShowcase: false, lightingProfile: "map", skyMode: "map", skyPackId: null, skyRotation: 0, skyExposure: 0, lightingSource: "map", directContribution: 1, ambientContribution: 1, clouds: false, cloudQuality: "low", cloudCoverage: .45, cloudDensity: 1, contactShading: false, atmosphere: false, sunShafts: false, materialResponse: true, volumetric: false, spatialAA: true, localLights: false, localQuality: "medium", localBudget: 1, localStrength: .2, dynamicGI: false, tracedGI: false, giQuality: "low", giStrength: .25, giRange: 256, dynamicShadows: false, shadowQuality: "medium", shadowDistance: 1024, shadowStrength: .18, resolutionScale: 1, antialias: true, aspect: "native", aspectFit: "stretch", pixelated: false, anisotropy: 8, brightness: 1, gamma: 1, vibrance: 1, fullbright: false, menuBackground: "live", fullscreen: true, potato: false, flashlight: false, fpsLimit: 1000, uncapped: false, lowLatency: false, menuFps: 0 },
  viewmodel: { show: true, ...VIEWMODEL_POS, bob: 1, sway: 1, hand: "right", rev: VIEWMODEL_REV },
  binds: DEFAULT_BINDS,
  practice: { keepVelocity: true },
  holdRestart: false,
  autoRestart: { when: "off", action: "restart" },
  mouseNames: MOUSE_NAMES,
  bonusBindRevision: 1,
};

/** The key prefs are stored under (one JSON object, the shape of Prefs). */
export const PREFS_KEY = "bunnyhop:settings";
const KEY = PREFS_KEY;

function merge<T>(base: T, over: unknown): T {
  // A null default (graphics.skyPackId) is an optional id: a saved string or null survives a reload.
  if (base === null) return (over === null || typeof over === "string" ? over : base) as T;
  if (typeof base !== "object" || Array.isArray(base)) {
    if (Array.isArray(base)) return (Array.isArray(over) && over.every((x) => typeof x === "string") ? over : base) as T;
    return (typeof over === typeof base ? over : base) as T;
  }
  const out: Record<string, unknown> = {};
  const o = (typeof over === "object" && over !== null ? over : {}) as Record<string, unknown>;
  for (const k of Object.keys(base)) out[k] = merge((base as Record<string, unknown>)[k], o[k]);
  return out as T;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  if (typeof raw.verticalSensitivity !== "number" || !Number.isFinite(raw.verticalSensitivity)) delete raw.verticalSensitivity;
  else raw.verticalSensitivity = Math.max(0.01, Math.min(100, raw.verticalSensitivity));
  // Turn speeds: within what a replay may record (turn-binds.ts); a broken one falls back to the default.
  for (const [key, [lo, hi]] of [["yawSpeed", YAW_SPEED_RANGE], ["angleSpeedKey", ANGLE_SPEED_KEY_RANGE]] as const) {
    const v = raw[key];
    if (typeof v !== "number" || !Number.isFinite(v)) delete raw[key];
    else raw[key] = Math.max(lo, Math.min(hi, v));
  }
  const graphics = raw.graphics;
  if (graphics && typeof graphics === "object" && !Array.isArray(graphics)) {
    const g = graphics as Record<string, unknown>;
    const normalized = videoGrade(g);
    // Partial imports keep settings they do not mention; saved values cannot escape the display controls' bounds.
    for (const key of Object.keys(VIDEO_LIMITS) as (keyof VideoGrade)[]) {
      if (typeof g[key] !== "number") continue;
      if (Number.isFinite(g[key])) g[key] = normalized[key];
      else delete g[key];
    }
    // One Sky picker since 0.0.29 (Sky background + the sky packs' own picker before): "Selected sky pack" with no pack
    // picked drew the map's sky, and now says so.
    if (g.skyMode === "pack" && typeof g.skyPackId !== "string") g.skyMode = "map";
  }
  migrateAntialias(raw);
  migrateModels(raw);
  migrateMouseNames(raw);
  migrateBonusBind(raw);
  migrateBinds(raw);
  migrateViewmodel(raw);
  migrateAudio(raw);
  normalizeTriggerPrefs(raw.triggers);
  return migrateHud(raw);
}

/**
 * Viewmodel framing saved under an older default (no `rev`: before v0.0.6, framing 1; rev 2: v0.0.6-v0.0.28): the whole
 * prefs object is saved on any change, defaults included, so a stored framing equal to the default it was saved under
 * (FOV and all three offsets, absent counting as equal) is one the player never changed: it moves to the current default
 * (VIEWMODEL_POS). Any change of theirs keeps all four as they are. Either way it's marked current, so choosing an old
 * framing again later (the CS:S preset is rev 2's) sticks.
 */
function migrateViewmodel(raw: Record<string, unknown>): void {
  const v = raw?.viewmodel as Record<string, unknown> | undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) return;
  const rev = typeof v.rev === "number" ? v.rev : 1;
  if (rev >= VIEWMODEL_REV) return;
  const old = (rev <= 1 ? VIEWMODEL_POS_V1 : VIEWMODEL_POS_V2) as Record<string, number>;
  if (Object.keys(old).every((k) => v[k] === undefined || v[k] === old[k])) Object.assign(v, VIEWMODEL_POS);
  v.rev = VIEWMODEL_REV;
}

/**
 * Audio prefs saved before AUDIO_REV 1 (0.0.25) had Wind on by default, and the whole store is saved on any change, so
 * a stored `wind: true` can't tell a choice from the old default: it turns off once, like for new players. Off stays off.
 * Marked current either way, so turning Wind back on afterwards sticks.
 */
function migrateAudio(raw: Record<string, unknown>): void {
  const a = raw?.audio as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object" || Array.isArray(a) || (typeof a.rev === "number" && a.rev >= AUDIO_REV)) return;
  if (a.wind === true) a.wind = false;
  a.rev = AUDIO_REV;
}

/**
 * Before 0.0.22 Potato mode also turned antialiasing off (there was no setting for it): a player who had Potato on keeps
 * it off.
 */
function migrateAntialias(raw: Record<string, unknown>): void {
  const g = raw?.graphics as Record<string, unknown> | undefined;
  if (g && typeof g === "object" && g.potato === true && g.antialias === undefined) g.antialias = false;
}

/** Brings stored / imported prefs of any earlier shape up to the current one (in place; settings-io.ts imports). */
export const migratePrefs = migrate;

/**
 * Binds saved before 0.0.12 named mouse buttons `Mouse${MouseEvent.button + 1}`: Mouse2 was the middle button, Mouse3
 * right-click. A Mouse3 the player bound (right-click) becomes Mouse2 and a bound middle button Mouse3, so their binds
 * stay on the same buttons. The one exception is the default stab / silencer bind (attack2 = Mouse2, which was meant to
 * be right-click like in CS:S): it stays Mouse2, now right-click, unless the player gave right-click to something else.
 */
function migrateMouseNames(raw: Record<string, unknown>): void {
  if (!raw || typeof raw !== "object" || raw.mouseNames === MOUSE_NAMES) return;
  // No saved binds: the defaults (already Source's names) fill them in.
  const b = raw.binds as Record<string, unknown> | undefined;
  if (!b || typeof b !== "object") return;
  const lists = Object.entries(b).filter((e): e is [string, string[]] => Array.isArray(e[1]));
  const rightBound = lists.some(([, v]) => v.includes("Mouse3"));
  for (const [a, v] of lists)
    b[a] = v.map((c) => (c === "Mouse3" ? "Mouse2" : c === "Mouse2" ? (a === "attack2" && !rightBound ? "Mouse2" : "Mouse3") : c));
  raw.mouseNames = MOUSE_NAMES;
}

/** Add F4 once only to the old default; customized binds and keys in use remain untouched. */
function migrateBonusBind(raw: Record<string, unknown>): void {
  if (raw.bonusBindRevision === 1) return;
  const b = raw.binds as Record<string, unknown> | undefined;
  // Without saved bindings, merge supplies both the new default and its revision.
  if (!b || typeof b !== "object" || Array.isArray(b)) return;
  const bonus = b.restartBonus;
  const used = Object.values(b).some((v) => Array.isArray(v) && v.includes("F4"));
  if (Array.isArray(bonus) && bonus.length === 1 && bonus[0] === "KeyB" && !used) b.restartBonus = ["KeyB", "F4"];
  raw.bonusBindRevision = 1;
}

/** Bind actions that no longer exist (dropped from saved binds before new defaults are handed out). */
const REMOVED_ACTIONS = ["zoneEditor"];

/**
 * Actions added after a player saved their binds (e.g. the viewmodel's slash / stab / inspect / toggle) get their
 * default keys, minus any key the player already uses for something else (their binds keep priority).
 */
function migrateBinds(raw: Record<string, unknown>): void {
  const b = raw?.binds as Record<string, unknown> | undefined;
  if (!b || typeof b !== "object") return;
  // Removed actions free their keys first (0.0.10: the zone editor's Z, now a dev tool, goes to practice noclip).
  for (const a of REMOVED_ACTIONS) delete b[a];
  const used = new Set<string>();
  for (const v of Object.values(b)) if (Array.isArray(v)) for (const c of v) if (typeof c === "string") used.add(c);
  for (const [a, codes] of Object.entries(DEFAULT_BINDS)) if (!(a in b)) b[a] = codes.filter((c) => !used.has(c));
}

/** Whether `action` has its default keys (in either order: the two slots do the same). */
export function bindIsDefault(binds: Record<Action, string[]>, action: Action): boolean {
  const cur = binds[action] ?? [];
  const def = DEFAULT_BINDS[action] ?? [];
  return cur.length === def.length && def.every((c) => cur.includes(c));
}

/**
 * Settings → Keys, a row's reset: `action` gets its default keys back. Like binding a key by hand, a default key leaves
 * any other action that had it. Returns those actions.
 */
export function resetBind(binds: Record<Action, string[]>, action: Action): Action[] {
  const def = DEFAULT_BINDS[action] ?? [];
  const took: Action[] = [];
  for (const a of Object.keys(binds) as Action[]) {
    if (a === action || !binds[a].some((c) => def.includes(c))) continue;
    binds[a] = binds[a].filter((c) => !def.includes(c));
    took.push(a);
  }
  binds[action] = [...def];
  return took;
}

/**
 * Retired player / ghost overrides migrate to the bunny. Appearance now comes from each player's loadout.
 * Keep the old team fields only for importing older preference files and the developer model viewer.
 */
function migrateModels(raw: Record<string, unknown>): void {
  const m = raw?.models as Record<string, unknown> | undefined;
  if (!m || typeof m !== "object") return;
  if (m.player === "ct" || m.player === "t") m.team = m.player;
  if (["ct", "t", "runner", "css"].includes(String(m.player))) m.player = "bunny";
  if (["ct", "t", "runner", "css", "bunny"].includes(String(m.ghost))) m.ghost = "same";
}

/** Pre-layout prefs stored HUD visibility as hud.speed / hud.timer / ... booleans. */
function migrateHud(raw: Record<string, unknown>): Record<string, unknown> {
  const hud = raw?.hud as Record<string, unknown> | undefined;
  // HUD scale: within its slider (50-175%; it was 70-160%, so an older stored value always fits). A broken one
  // falls back to the default.
  if (hud && typeof hud === "object" && "scale" in hud) {
    if (typeof hud.scale === "number" && Number.isFinite(hud.scale)) hud.scale = Math.max(HUD_SCALE.min, Math.min(HUD_SCALE.max, hud.scale));
    else delete hud.scale;
  }
  if (hud && typeof hud === "object" && hud.layout && typeof hud.layout === "object") moveRetiredPlaces(hud.layout as Record<string, never>);
  if (!hud || typeof hud !== "object" || hud.layout) return raw;
  const old: Record<string, string> = { speed: "speed", timer: "timer", split: "split", stats: "stats", keys: "keys", mapLine: "map", fps: "fps" };
  const layout = clone(CLASSIC) as Record<string, { on: boolean }>;
  for (const [k, id] of Object.entries(old)) if (typeof hud[k] === "boolean" && HUD_ELEMENTS.some((e) => e.id === id)) layout[id].on = hud[k] as boolean;
  hud.layout = layout;
  return raw;
}

/** Saved prefs (the PREFS_KEY JSON, or null: none saved) over the defaults, migrated. Throws on malformed JSON. */
export function parsePrefs(raw: string | null): Prefs {
  if (!raw) return clone(DEFAULT_PREFS);
  const p = merge(DEFAULT_PREFS, migrate(JSON.parse(raw)));
  if (!COLOR_BLIND_MODES.some(([m]) => m === p.colorBlind)) p.colorBlind = DEFAULT_PREFS.colorBlind;
  p.graphics.preset = lookPreset(p.graphics.preset);
  return p;
}

function load(): Prefs {
  try {
    const p = parsePrefs(localStorage.getItem(KEY));
    p.graphics.flashlight = false;
    return p;
  } catch {
    return clone(DEFAULT_PREFS);
  }
}

type Listener = (p: Prefs) => void;

class PrefStore {
  private p = load();
  private listeners = new Set<Listener>();

  get(): Prefs {
    return this.defaults ?? this.p;
  }

  private defaults: Prefs | null = null;
  /** What `read` returns with every pref at its default (a slider's default notch, without a table of defaults). */
  atDefaults<T>(read: () => T): T {
    const prev = this.defaults;
    this.defaults = DEFAULT_PREFS;
    try {
      return read();
    } catch {
      return NaN as T;
    } finally {
      this.defaults = prev;
    }
  }

  update(fn: (p: Prefs) => void): void {
    fn(this.p);
    try {
      localStorage.setItem(KEY, JSON.stringify(this.p));
    } catch {
      /* private mode / quota: still applied for this session */
    }
    for (const l of this.listeners) l(this.p);
  }

  reset(section?: keyof Prefs): void {
    this.update((p) => {
      if (section) (p as unknown as Record<string, unknown>)[section] = clone(DEFAULT_PREFS[section]);
      else Object.assign(p, clone(DEFAULT_PREFS));
    });
  }

  /** Calls fn now and on every change. Returns an unsubscribe function. */
  watch(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.p);
    return () => this.listeners.delete(fn);
  }
}

export const prefs = new PrefStore();

/** Human label for a bind code ("KeyW" -> "W", "MouseWheel" -> "Wheel"). */
export function keyLabel(code: string): string {
  const special: Record<string, string> = {
    Space: "Space",
    ControlLeft: "L-Ctrl",
    ControlRight: "R-Ctrl",
    ShiftLeft: "L-Shift",
    ShiftRight: "R-Shift",
    AltLeft: "L-Alt",
    AltRight: "R-Alt",
    MetaLeft: "L-Meta",
    MetaRight: "R-Meta",
    MouseWheel: "Wheel ↕",
    MWheelUp: "Wheel ↑",
    MWheelDown: "Wheel ↓",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Backquote: "`",
    CapsLock: "Caps",
    Tab: "Tab",
  };
  if (special[code]) return special[code];
  if (/^Mouse[1-9]\d*$/.test(code)) return `Mouse ${code.slice(5)}`;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Num " + code.slice(6);
  return code;
}

/** The first key bound to `action`, for people ("Y"), or null while it has none. */
export function bindLabel(action: Action): string | null {
  const c = prefs.get().binds[action]?.[0];
  return c ? keyLabel(c) : null;
}

/** The game's render pixel ratio: the screen's (capped at 2x, 1x in potato mode) times the resolution scale. */
export function gamePixelRatio(g: Prefs["graphics"]): number {
  return Math.min(devicePixelRatio, g.potato ? 1 : 2) * g.resolutionScale;
}

/** Graphics presets (Settings → Graphics → Quality): the settings that cost the most GPU time on slow machines. */
export type GraphicsPreset = "lowest" | "low" | "medium" | "high";
type PresetKeys = "potato" | "antialias" | "anisotropy" | "resolutionScale" | "waterReflections";
export const GRAPHICS_PRESETS: Record<GraphicsPreset, Pick<Prefs["graphics"], PresetKeys>> = {
  lowest: { potato: true, antialias: false, anisotropy: 1, resolutionScale: 0.5, waterReflections: false },
  low: { potato: true, antialias: false, anisotropy: 1, resolutionScale: 1, waterReflections: false },
  medium: { potato: false, antialias: false, anisotropy: 4, resolutionScale: 1, waterReflections: false },
  high: { potato: false, antialias: true, anisotropy: 8, resolutionScale: 1, waterReflections: true },
};
export const PRESET_ORDER: GraphicsPreset[] = ["lowest", "low", "medium", "high"];

/** The preset these graphics settings match, or null (custom). */
export function graphicsPreset(g: Prefs["graphics"]): GraphicsPreset | null {
  return PRESET_ORDER.find((k) => (Object.keys(GRAPHICS_PRESETS[k]) as PresetKeys[]).every((f) => g[f] === GRAPHICS_PRESETS[k][f])) ?? null;
}

export function applyGraphicsPreset(g: Prefs["graphics"], preset: GraphicsPreset): void {
  Object.assign(g, GRAPHICS_PRESETS[preset]);
}

const ASPECTS: Record<Exclude<AspectRatio, "native">, number> = { "4:3": 4 / 3, "5:4": 5 / 4, "16:10": 16 / 10, "16:9": 16 / 9 };

/**
 * The game view on a `vw`×`vh` (CSS px) window: the canvas's CSS box (centred), its drawing buffer in device pixels and
 * the camera's aspect ratio. Native: the whole window. A fixed aspect ratio stretched: the whole window, drawn at that
 * ratio (the buffer is as tall as the window and as wide as the ratio makes it, so 4:3 on a 16:9 screen also draws a
 * quarter fewer pixels) and stretched to fill it, like CS's 4:3 stretched. With black bars: the largest box of that
 * ratio, centred.
 */
export function gameView(g: Prefs["graphics"], vw: number, vh: number): { cssW: number; cssH: number; bufW: number; bufH: number; aspect: number } {
  const pr = gamePixelRatio(g);
  const a = g.aspect === "native" ? 0 : ASPECTS[g.aspect] ?? 0;
  if (!a || vw <= 0 || vh <= 0) return { cssW: vw, cssH: vh, bufW: Math.max(1, Math.round(vw * pr)), bufH: Math.max(1, Math.round(vh * pr)), aspect: vw / Math.max(1, vh) };
  if (g.aspectFit === "stretch") return { cssW: vw, cssH: vh, bufW: Math.max(1, Math.round(vh * a * pr)), bufH: Math.max(1, Math.round(vh * pr)), aspect: a };
  const cssW = Math.min(vw, vh * a);
  const cssH = cssW / a;
  return { cssW, cssH, bufW: Math.max(1, Math.round(cssW * pr)), bufH: Math.max(1, Math.round(cssH * pr)), aspect: a };
}

/** Vertical FOV (degrees) for a CS:S fov_desired (horizontal at 4:3). Source is Hor+. */
export function verticalFov(fovDesired: number): number {
  const half = (fovDesired * Math.PI) / 360;
  return (2 * Math.atan(Math.tan(half) * 0.75) * 180) / Math.PI;
}

/** Horizontal FOV actually seen at a given aspect ratio. */
export function horizontalFovAt(fovDesired: number, aspect: number): number {
  const v = (verticalFov(fovDesired) * Math.PI) / 360;
  return (2 * Math.atan(Math.tan(v) * aspect) * 180) / Math.PI;
}
