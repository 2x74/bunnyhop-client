import { ShowPos } from "../hud/showpos";
import { appHref } from "../platform/navigation";
import { ReplayWatchCount, replayWatchThreshold } from "./watch-count";
import { PlayerShadowProxy } from "../graphics/player-shadow";
import type { GraphicsPipeline } from "../graphics/pipeline";
// Replay viewer: a full-screen mode over the loaded map with its own sim instance (viewer/player.ts), CS:S spectator
// cameras (viewer/cameras.ts), the game HUD driven by the replay (viewer/hud.ts), a timeline with speed graph and
// markers (viewer/timeline.ts), compare mode (a second replay as a ghost with a live delta) and MP4 export
// (viewer/export.ts).
//
// main.ts owns the renderer / scene / world and hands the frame loop to the viewer while it is open; the live game
// is paused underneath and untouched (its core is never stepped or restored by the viewer).
//
// Keys: Space play/pause · , . ±1 tick · ←/→ ±5 s (Shift ±1 s) · Home/End run start/finish · [ ] speed ·
//       1-5 / F camera · H HUD · V weapon in hand · F1 hide UI (the Hide UI bind) · C compare · E export · ? help ·
//       Esc close.
//
// The runner's look (applyLook): the replay's loadout trailer (knife, finish, gloves, crown / hat, build and, since
// v0.0.29, the colourway). A leaderboard replay without the colourway asks the account (GET /runs/<id>?look=1: their
// bunny as it is now, so a colourway changed since the run shows the new one); your own PB replays use yours; any
// other replay file the default. The weapon in hand (V): the bunny's knife / gun in third person, the first-person
// viewmodel in-eye (viewer/arms.ts), remembered per view (WEAPON_KEY).
//
// Hide UI (ui/hide-ui.ts) leaves the picture, plus the speed and keys if Settings → HUD → Hide UI keeps them (H still
// turns the HUD off altogether). For this visit only; every playback key keeps working; Esc brings the UI back.

import { DEFAULT_LOADOUT } from "../loadout";
import { DEFAULT_COSMETICS } from "../progression";
import { getOutfit } from "../player/cosmetics";
import { warmPrograms } from "../graphics/warm-programs";
import { ReplayArms, type ArmsLook } from "./arms";
import "./viewer.css";
import * as THREE from "three";
import { api, API_URL, lastKnownMe } from "../api";
import { openFeedback } from "../feedback/state";
import { worldRecord } from "../shared-reads";
import { fetchExportLeaderboard } from "./export-leaderboard";
import { Core, floorWeapons, traceRay, WEAPON_IDS, weaponReport, type BrushTransform } from "../core";
import { Ghost } from "../ghost";
import { GHOST_CSS, type GhostKind } from "../player/colors";
import { PlayerModel } from "../player/model";
import { download, loadPBReplay } from "../pb";
import { cosmeticBetween, decodeReplay, inspectBetween, replayFileName, replayStyle, type Replay } from "../replay";
import { emitWeaponEvent } from "../viewmodel/events";
import { setFinishClock } from "../viewmodel/finishes/shader";
import { setFinishEnvironmentClock } from "../viewmodel/finishes/environment";
import { FloorGuns } from "../viewmodel/guns/world";
import type { WorldView } from "../render";
import { simulate } from "../sim";
import { INFINITE_NOTE, styleDef, styleForTrack, styleLabel, type StyleId } from "../styles";
import { formatTime } from "../timer";
import { afterPaint, h } from "../ui/dom";
import { hideUiKey, isHideUiKey, setUiHidden } from "../ui/hide-ui";
import { prefs } from "../ui/settings";
import { trackName } from "../zones";
import { CameraRig, CAM_MODES, CHASE_NEAR_FADE, directShots, freeSpeedStep, type CamMode, type TraceFn } from "./cameras";
import { freeIntentFromCodes } from "../freecam";
import type { CardInfo } from "./canvas-hud";
import { openExportDialog, type ExportCam, type ExportSource } from "./export";
import { runUrl, shareButton } from "../ui/share";
import { ViewerHud } from "./hud";
import { F_LANDED, F_TELEPORTED, finalRunTime, replayTicks, ReplayPlayer, sampleAt, type RunData, type ViewSample } from "./player";
import { TickStepper, type TickSource } from "../player/tick-stepper";
import { probeFromTrace } from "../player/bunny/legs";
import { viewerRequestRunId, viewerUrl, type ReplayTarget, type ViewerRequest } from "./request";
import { publicOrigin } from "../platform/env";
import { Timeline } from "./timeline";
import { ReplayAudio } from "../audio/replay";
import { InputStats } from "../mouse-filter";
import { frameNumbers } from "../input-debug";
import { evidenceTicks, jumpTick, replayDeepLink } from "../staff-lens";
import { GauntletLayer } from "./gauntlet-layer";
import { H2H_COLORS, HeadToHead, makeSide, sideCore, slowGraphics, type H2HLayout } from "./h2h";
import { defaultLayout, layoutParam } from "../h2h/layout";
import { h2hUrl, openHeadToHead, runIdFromText } from "./request";
import { ApiError, type RunInfo } from "../api";
import "./h2h.css";

export interface ViewerHost {
  renderer: THREE.WebGLRenderer;
  graphicsPipeline: GraphicsPipeline;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  world: WorldView;
  map: string;
  bsp: Uint8Array;
  wasmBytes: Uint8Array;
  mapSha256: string;
  /** Selected main-track style (default for PB lookups). */
  style: () => string;
  /** Re-applies the window size / pixel ratio / FOV to the renderer and camera. */
  resize: () => void;
  /**
   * "Practice from here": the live game takes the replay to this tick and carries on from there as a practice attempt
   * (practice-mode/controller.ts fromReplay). Returns why it can't, or null (the viewer closes). Absent: no button.
   */
  practiceFrom?: (replay: Replay, tick: number) => string | null;
  /** After the world's brushes moved to this tick (`world.update`): the replay's sim and its transforms. */
  onWorldUpdate?: (core: Core, transforms: Map<number, BrushTransform>) => void;
  /** After the replay's player was sampled for this frame (and the camera placed): its sim and the interpolated sample. */
  onPlayerFrame?: (core: Core, sample: ViewSample) => void;
  /** Viewer opened / closed: pause the live game, hide its HUD/ghosts/menu; then restore them. */
  onOpen: () => void;
  onClose: () => void;
}

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];

/** Head to head's "early" number (viewer/h2h-panel.ts), off unless turned on. */
const EARLY_KEY = "bunnyhop:h2h-early";
export const earlyShown = (): boolean => {
  try {
    return localStorage.getItem(EARLY_KEY) === "1";
  } catch {
    return false;
  }
};

/** Filled transport glyphs on a 20-unit grid (ui/icons.ts is stroke-only). */
const GLYPHS: Record<string, string> = {
  play: "M6 3.5 16.5 10 6 16.5Z",
  pause: "M5 4h3.6v12H5ZM11.4 4H15v12h-3.6Z",
  stepBack: "M4 4h2.2v12H4ZM16 4v12L7.5 10Z",
  stepFwd: "M13.8 4H16v12h-2.2ZM4 4v12l8.5-6Z",
  prevJump: "M10 4v12L2.5 10ZM17.5 4v12L10 10Z",
  nextJump: "M10 4v12l7.5-6ZM2.5 4v12L10 10Z",
  more: "M4 8.4h3.2v3.2H4ZM8.4 8.4h3.2v3.2H8.4ZM12.8 8.4H16v3.2h-3.2Z",
};
function glyph(name: string): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 20 20");
  s.setAttribute("width", "1em");
  s.setAttribute("height", "1em");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("fill", "currentColor");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", GLYPHS[name] ?? GLYPHS.play);
  s.append(p);
  return s;
}
/** The compare ghost's speed difference changes every this many ticks: readable, about the live HUD's rate. */
const SPEED_DIFF_STEP = 10;

/**
 * The weapon-in-hand toggle (V), remembered per view. In-eye starts off: the run as a clean view of the line, like the
 * HUD-off shorts; turned on it's the runner's first-person viewmodel. Third person starts on: the knife or gun is part of
 * the bunny there, and swings / shots read from outside.
 */
const WEAPON_KEY = "bunnyhop:replay-weapon";
interface WeaponShown {
  eye: boolean;
  third: boolean;
}
function loadWeaponShown(): WeaponShown {
  try {
    const v = JSON.parse(localStorage.getItem(WEAPON_KEY) ?? "{}") as Partial<WeaponShown> | null;
    return { eye: v?.eye === true, third: v?.third !== false };
  } catch {
    return { eye: false, third: true };
  }
}

interface Compare {
  ghost: Ghost;
  kind: GhostKind;
  label: string;
  replay: Replay;
  startTick: number;
  endTick: number;
  /** Primary-tick-indexed delta (s; negative = primary ahead), NaN outside the run. */
  delta: Float32Array;
  /** Primary-tick-indexed speed difference (u/s; positive = primary faster), NaN where there is none. */
  speedDiff: Float32Array;
}

export class ReplayViewer implements ExportSource {
  active = false;
  player: ReplayPlayer | null = null;
  replay: Replay | null = null;
  bytes: Uint8Array | null = null;
  /**
   * Opens in-eye (first person, CS:S observer "in-eye"): the run as the player saw it. A camera picked here sticks for
   * the rest of the visit; MP4 export keeps its own camera setting (default chase, export.ts).
   */
  readonly rig = Object.assign(new CameraRig(), { mode: "eye" as CamMode });
  readonly model = new PlayerModel({ style: "solid", playerGlow: null });
  compare: Compare | null = null;
  /** What render() animates: the viewer's model / compare ghost, or fresh copies during an export. */
  private playerShadow: PlayerShadowProxy;
  private drawModel: PlayerModel = this.model;
  private drawGhost: Ghost | null = null;
  /** The map's weapon items as they lie at the shown tick (physics v5 replays: pickups, drops, template respawns). */
  private floor = new FloorGuns();
  private floorStale = true;
  private trailHistory = new Map<number, { transforms: Map<number, BrushTransform>; states?: Map<number, boolean> }>();
  /** Display time in (fractional) ticks. */
  t = 0;
  playing = false;
  private watchCount: ReplayWatchCount | null = null;
  /**
   * Frame times while a replay shows, kept the way the game keeps its own (mouse-filter.ts InputStats): the input stats
   * overlay shows them while the viewer is open, feedback reports carry them (main.ts), and each visit logs a line.
   */
  readonly frameStats = new InputStats();
  /** Frames counted this visit. */
  private statFrames = 0;
  /** The next frame isn't counted: it follows a load, an export or a hidden tab, not a stutter. */
  private statSkip = true;
  /** Long tasks count from here (performance clock): after the last load or export. */
  private statFrom = 0;
  /** Replay sounds (movement, wind, run chimes) while playing. */
  private sound = new ReplayAudio();
  speed = 1;
  hudOn = true;
  /** cl_showpos over the replay (hud/showpos.ts), and the sample it reads (reused). */
  private showPos = new ShowPos();
  private showPosSample: ViewSample | null = null;
  /** Hide UI: the controls, timeline and title are hidden (setClean). */
  clean = false;
  private label = "";
  private corePromise: Promise<Core> | null = null;
  private core: Core | null = null;
  /** The viewer's own sim (map sounds read the map's state from it while a replay shows). */
  get simCore(): Core | null {
    return this.player ? this.core : null;
  }
  private lastNow = performance.now();
  private lastShown = -1;
  private lastRenderedTick = NaN;
  /** The bunny on the simulation's clock (viewer/player.ts TickStepper), for the model and run it was made for. */
  private stepper = new TickStepper();
  private stepperFor: { model: PlayerModel; data: RunData; src: TickSource } | null = null;
  private sample: ViewSample | undefined;
  private camPos = new THREE.Vector3();
  private exporting = false;
  /** The weapon in hand for the export running (prepareExport), in place of `weapon`. */
  private exportWeapon: WeaponShown | null = null;
  private lockReleasedAt = 0;
  private dragging = false;
  private notice = "";
  private seq = 0;
  /** Watching a whole gauntlet attempt: its layer (viewer/gauntlet-layer.ts), else null. */
  private gauntlet: GauntletLayer | null = null;
  /** Head to head (/h2h/<a>/<b>): the second run and the layout (viewer/h2h.ts), else null. */
  h2h: HeadToHead | null = null;
  /** Head to head's short note (different builds, styles or tracks), over the views. */
  private h2hNote = h("div.h2h-note", { hidden: true });
  private h2hBtns: { side: HTMLButtonElement; stacked: HTMLButtonElement; ghost: HTMLButtonElement; swap: HTMLButtonElement; stats: HTMLButtonElement; early: HTMLButtonElement } | null = null;
  private h2hGroup: HTMLElement;
  private h2hOnly: HTMLElement[] = [];
  private speedTrigger!: HTMLButtonElement;
  private camTrigger!: HTMLButtonElement;
  private layoutTrigger!: HTMLButtonElement;
  private soloOnly: HTMLElement[] = [];
  /** The runner's look on the bunny and the first-person arms (applyLook). */
  private look: ArmsLook = { loadout: { ...DEFAULT_LOADOUT }, outfit: DEFAULT_COSMETICS.outfit!, glow: null };
  /** Weapon in hand shown, per view (V). */
  private weapon = loadWeaponShown();
  /** The last frame was in-eye (no player model): which of `weapon` the button shows and V flips. */
  private firstPerson = true;
  /** In-eye weapon (viewer/arms.ts): made the first time it's wanted. */
  private arms: ReplayArms | null = null;
  /** Tick the arms were last fed (-1: reset them at the next frame). */
  private armsTick = -1;
  /** Their programs compiling (ensureArms): an export waits for it. */
  private armsWarm: Promise<void> | null = null;
  /** The hardest landing since the arms' last frame (the viewmodel's landing dip) and the inspect key at the last tick. */
  private armsLanded = 0;
  private armsInspectHeld = false;

  // DOM
  private root: HTMLElement;
  private stage: HTMLElement;
  private hud = new ViewerHud();
  private timeline: Timeline;
  private loading: HTMLElement;
  private titleEl: HTMLElement;
  private subEl: HTMLElement;
  private noticeEl: HTMLElement;
  /** The clock and tick under the transport: text nodes, written when they change. */
  private timeText = document.createTextNode("");
  private tickText = document.createTextNode("");
  private playBtn: HTMLButtonElement;
  private shareBtn: HTMLButtonElement;
  /** Report the run's player (feedback form, "Report a player" with this run). Server runs that aren't yours. */
  private reportBtn: HTMLButtonElement;
  /** Server run being watched (its share link), else null. */
  private runId: string | null = null;
  /** The run's account name from the server, once loaded: the replay file's own name is whatever its client wrote (the
   * native client's replays say "native-player"). */
  private owner: string | null = null;
  private speedBtns: HTMLButtonElement[] = [];
  private camBtns = new Map<CamMode, HTMLButtonElement>();
  private hudBtn: HTMLButtonElement;
  private weaponBtn: HTMLButtonElement;
  private cleanBtn: HTMLButtonElement;
  /** The Hide UI key in the shortcuts list (its bind can change). */
  private cleanKey = h("kbd");
  private compareBtn: HTMLButtonElement;
  /** Continue this moment in practice (host.practiceFrom). */
  private practiceBtn: HTMLButtonElement;
  private compareMenu: HTMLElement;
  private helpEl: HTMLElement;
  private freeHint: HTMLElement;
  private panel: HTMLElement;

  constructor(private host: ViewerHost) {
    this.playerShadow = new PlayerShadowProxy(host.scene, this.drawModel.root);
    this.model.root.visible = false;
    this.model.root.userData.h2hPrimary = true; // hidden in head to head's other view (viewer/h2h.ts)
    this.model.setNearFade(...CHASE_NEAR_FADE);
    // The legs plant on slopes with the world under the feet (player/bunny/legs.ts).
    this.model.setGroundProbe(probeFromTrace((a, b) => this.trace(a, b, 0)));
    this.timeline = new Timeline({ seek: (t, final) => this.seekTo(t, final) });
    this.stage = h("div.rv-stage", { "aria-hidden": "true" });
    this.loading = h("div.rv-loading", { role: "status", "aria-live": "polite" });
    this.titleEl = h("div.rv-title");
    this.subEl = h("div.rv-sub");
    this.noticeEl = h("div.rv-notice", { hidden: true });
    const btn = (label: string, title: string, fn: () => void, cls = "") => h(`button.rv-btn${cls}`, { type: "button", title, "aria-label": title, onclick: fn }, label) as HTMLButtonElement;
    this.playBtn = btn("▶", "Play / pause (Space)", () => this.togglePlay(), ".rv-play");
    // Leaderboard runs have a page (/replay/<id>) that unfurls with the run's card.
    this.shareBtn = shareButton("rv-btn rv-chip", () => {
      const hh = this.h2h;
      if (hh) return { url: `${publicOrigin()}${h2hUrl(hh.sides[0].runId, hh.sides[1].runId)}`, title: `${hh.sides[0].name} vs ${hh.sides[1].name} · ${this.host.map} · bunnyhop.lol` };
      return { url: runUrl(this.runId ?? ""), title: `${this.playerName() || "Replay"} · ${this.host.map} · bunnyhop.lol` };
    }, "Link copied");
    this.shareBtn.hidden = true;
    this.reportBtn = btn("Report", "Report this player", () => this.report(), ".rv-chip.rv-report");
    this.reportBtn.hidden = true;
    this.hudBtn = btn("HUD", "Toggle HUD (H)", () => this.toggleHud(), ".rv-chip.on");
    this.weaponBtn = btn("Weapon", "Weapon in hand (V)", () => this.toggleWeapon(), ".rv-chip");
    this.cleanBtn = btn("Hide UI", "Hide UI", () => this.setClean(true), ".rv-chip");
    this.compareMenu = h("div.rv-menu", { hidden: true, role: "menu" });
    this.compareBtn = btn("Compare", "Watch this run head to head with another (C)", () => this.toggleCompareMenu(), ".rv-chip");
    this.practiceBtn = btn("Practice from here", "Take over from this moment, in practice (P)", () => this.practiceFromHere(), ".rv-chip");
    this.practiceBtn.hidden = !host.practiceFrom;
    this.freeHint = h("div.rv-freehint", { hidden: true }, "Click to fly with your movement keys. Shift is faster, Alt slower, the wheel sets the speed. Esc lets go.");
    // Speed and camera: one control each, their choices in a small menu (the same buttons the keys update).
    for (const sp of SPEEDS) this.speedBtns.push(btn(`${sp}×`, `Playback speed ${sp}× ([ / ])`, () => this.setSpeed(sp), ".rv-pop-item"));
    for (const m of CAM_MODES) this.camBtns.set(m.id, btn(m.label, `${m.title} (${m.key})`, () => this.setCam(m.id), ".rv-pop-item"));
    this.helpEl = h(
      "div.rv-help",
      { hidden: true },
      h("h3", null, "Replay viewer"),
      h(
        "dl",
        null,
        ...(
          [
            ["Space", "play / pause"],
            [", / .", "step one tick back / forward"],
            ["← / →", "±5 s (Shift ±1 s)"],
            ["Home / End", "run start / finish"],
            ["[ / ]", "slower / faster"],
            ["1–5 or F", "in-eye · chase · free · flyby · auto"],
            ["Drag / wheel", "orbit / zoom the chase cam (double-click resets)"],
            ["H", "HUD on / off"],
            ["V", "weapon in hand on / off (in-eye and third person each remember theirs)"],
            [this.cleanKey, "hide the UI (Esc shows it)"],
            ["C", "compare: head to head with another run"],
            ["E", "export MP4"],
            ["P", "practice from this moment"],
            ["N / P", "next / previous map (watching a gauntlet)"],
            ["G", "side by side, stacked or ghost (head to head)"],
            ["X", "swap the runs (head to head)"],
            ["S", "panels on / off (head to head)"],
            ["J", "next jump (Shift: previous)"],
            ["Esc", "close"],
          ] as const
        ).flatMap(([k, v]) => [h("dt", null, typeof k === "string" ? h("kbd", null, k) : k), h("dd", null, v)]),
      ),
    );
    const top = h(
      "header.rv-top",
      null,
      h("div.rv-titles", null, this.titleEl, this.subEl, this.noticeEl),
      h(
        "div.rv-top-actions",
        null,
        btn("?", "Keyboard shortcuts (?)", () => (this.helpEl.hidden = !this.helpEl.hidden), ".rv-icon"),
        btn("✕", "Close replay viewer (Esc)", () => this.close(), ".rv-icon"),
      ),
    );
    const tb = (glyphName: string, title: string, fn: () => void, cls = "") => {
      const b = btn("", title, fn, `.rv-tbtn${cls}`);
      b.append(glyph(glyphName));
      return b;
    };
    this.playBtn.textContent = "";
    this.playBtn.append(glyph("play"));
    const transport = h(
      "div.rv-transport",
      { role: "group", "aria-label": "Playback" },
      tb("prevJump", "Previous jump (Shift+J)", () => this.stepJump(-1)),
      tb("stepBack", "Previous tick (,)", () => this.step(-1)),
      this.playBtn,
      tb("stepFwd", "Next tick (.)", () => this.step(1)),
      tb("nextJump", "Next jump (J)", () => this.stepJump(1)),
    );
    const clock = h("div.rv-clock", null, h("span.rv-time", null, this.timeText), h("span.rv-tick", null, this.tickText));
    const h2hBtns = {
      side: btn("Side by side", "The two views left and right (G)", () => this.setH2HLayout("side"), ".rv-pop-item"),
      stacked: btn("Stacked", "The two views top and bottom (G)", () => this.setH2HLayout("stacked"), ".rv-pop-item"),
      ghost: btn("Ghost", "One view, the other run as a ghost (G)", () => this.setH2HLayout("ghost"), ".rv-pop-item"),
      swap: btn("Swap", "Swap the runs (X)", () => this.swapH2H(), ".rv-chip.rv-quiet"),
      stats: btn("Stats", "The panels under the views (S)", () => this.toggleStats(), ".rv-pop-item.rv-toggle"),
      early: btn("Early switches", "In each panel, the share of key switches made before the mouse turns", () => this.toggleEarly(), ".rv-pop-item.rv-toggle"),
    };
    this.h2hBtns = h2hBtns;
    // Small menus: a trigger and its list, one open at a time; a click outside or on a choice closes it.
    const pop = (trigger: HTMLButtonElement, items: HTMLElement[], cls = "") => {
      const list = h(`div.rv-pop${cls}`, { hidden: true, role: "menu" }, ...items);
      trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = list.hidden;
        for (const o of this.root.querySelectorAll<HTMLElement>(".rv-pop")) o.hidden = true;
        this.compareMenu.hidden = true;
        list.hidden = !open;
      });
      list.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".rv-pop-item:not(.rv-toggle)")) list.hidden = true;
      });
      return h("div.rv-menu-wrap", null, trigger, list);
    };
    addEventListener("pointerdown", (e) => {
      if (!(e.target as HTMLElement).closest?.(".rv-menu-wrap")) for (const o of this.root.querySelectorAll<HTMLElement>(".rv-pop")) o.hidden = true;
    });
    this.speedTrigger = btn("1×", "Playback speed ([ / ])", () => {}, ".rv-chip.rv-quiet.rv-speed");
    this.camTrigger = btn("In-eye", "Camera (1–5, F)", () => {}, ".rv-chip.rv-quiet");
    this.layoutTrigger = btn("Side by side", "Layout (G)", () => {}, ".rv-chip.rv-quiet");
    const moreTrigger = btn("", "More", () => {}, ".rv-chip.rv-quiet.rv-more");
    moreTrigger.append(glyph("more"));
    const helpItem = btn("Keyboard shortcuts", "Keyboard shortcuts (?)", () => (this.helpEl.hidden = !this.helpEl.hidden), ".rv-pop-item");
    const exportBtn = btn("Export MP4", "Render this replay to an MP4 video (E)", () => this.openExport(), ".rv-chip.rv-accent");
    const bhrBtn = btn("Download .bhr", "Download the replay file", () => this.downloadBhr(), ".rv-pop-item");
    for (const b of [this.hudBtn, this.weaponBtn, this.cleanBtn, this.practiceBtn, this.reportBtn]) b.classList.replace("rv-chip", "rv-pop-item");
    this.hudBtn.classList.add("rv-toggle");
    this.weaponBtn.classList.add("rv-toggle");
    this.weaponBtn.textContent = "Weapon in hand";
    this.reportBtn.textContent = "Report player";
    this.h2hGroup = h("div.rv-group.h2h-ctl", { hidden: true }, pop(this.layoutTrigger, [h2hBtns.side, h2hBtns.stacked, h2hBtns.ghost]), h2hBtns.swap);
    const compareWrap = h("div.rv-menu-wrap", null, this.compareBtn, this.compareMenu);
    this.compareBtn.classList.add("rv-quiet");
    // Not in head to head (one run's tools): compare, practice, the file, report.
    this.soloOnly = [compareWrap, bhrBtn];
    this.h2hOnly = [h2hBtns.stats, h2hBtns.early];
    const more = pop(moreTrigger, [this.hudBtn, this.weaponBtn, h2hBtns.stats, h2hBtns.early, this.cleanBtn, this.practiceBtn, bhrBtn, this.reportBtn, helpItem], ".rv-pop-right");
    for (const e of this.h2hOnly) e.hidden = true;
    const views = h("div.rv-group.rv-views", null, pop(this.speedTrigger, this.speedBtns), pop(this.camTrigger, [...this.camBtns.values()]), this.h2hGroup);
    const actions = h("div.rv-group.rv-right", null, compareWrap, more, exportBtn, this.shareBtn);
    // Transport and clock on the left, everything else on the right.
    const controls = h("div.rv-controls.rv-controls-a", null, h("div.rv-group.rv-left", null, transport, clock), h("div.rv-group.rv-right", null, views, actions));
    const panel = h("footer.rv-panel", null, this.timeline.el, controls);
    this.panel = panel;
    this.root = h("div#rv", { hidden: true, role: "dialog", "aria-label": "Replay viewer" }, this.stage, this.hud.el, this.showPos.el, top, this.freeHint, this.loading, this.helpEl, panel);
    // The HUD and whispers sit above the controls (viewer.css --rv-panel-h), not under them; 0 while Hide UI hides the panel.
    new ResizeObserver(() => document.body.style.setProperty("--rv-panel-h", `${panel.offsetHeight}px`)).observe(panel);
    document.body.append(this.root);
    this.bindInput();
    prefs.watch(() => this.hud.applyPrefs());
    // A hidden tab draws nothing: the gap before its next frame isn't a stutter.
    document.addEventListener("visibilitychange", () => (this.statSkip = true));
    // Long main-thread tasks while a replay shows (Chromium), as the game counts them while playing (input-debug.ts).
    try {
      new PerformanceObserver((list) => {
        if (!this.active || this.exporting || !this.player) return;
        // Not the load or the export itself (the next frame isn't counted either).
        for (const e of list.getEntries()) if (e.startTime >= this.statFrom) this.frameStats.longTask(e.duration);
      }).observe({ type: "longtask" });
    } catch {
      /* unsupported */
    }
  }

  // -------------------------------------------------------------------------------------------
  // Open / close

  private viewerCore(): Promise<Core> {
    this.corePromise ??= (async () => {
      const c = await Core.create(this.host.wasmBytes as Uint8Array<ArrayBuffer>);
      c.loadMapPhysics(this.host.bsp);
      this.core = c;
      return c;
    })();
    return this.corePromise;
  }

  readonly trace: TraceFn = (a, b, r) => (this.core ? traceRay(this.core, a, b, r) : 1);

  private async resolve(target: ReplayTarget): Promise<{ bytes: Uint8Array; label: string }> {
    if ("bytes" in target) return { bytes: target.bytes, label: target.name ?? "" };
    if ("runId" in target) {
      if (!api.available()) throw new Error("Leaderboards are offline, so this run's replay can't be downloaded.");
      return { bytes: await api.replay(target.runId), label: target.name ?? "" };
    }
    const pb = target.pb === true ? {} : target.pb;
    const map = (pb as { map?: string }).map ?? this.host.map;
    const track = (pb as { track?: number }).track ?? 0;
    const style = styleForTrack(((pb as { style?: string }).style ?? this.host.style()) as StyleId, track, map);
    const bytes = await loadPBReplay(map, style, track);
    if (!bytes) throw new Error(`No ${track ? trackName(track) + " " : ""}${styleLabel(style)} PB replay saved on ${map} yet.`);
    return { bytes, label: "Personal best" };
  }

  /** Opens the viewer on a request (main.ts / request.ts). Replays for another map reload the page onto that map. */
  async open(req: ViewerRequest): Promise<void> {
    const my = ++this.seq;
    // ?t=<tick> / ?jump=<n> (staff-lens.ts): read before the URL is rewritten below.
    const deep = replayDeepLink();
    // Head to head's ?view=side|stacked|ghost (else by the window and the GPU): read before the URL is rewritten.
    const view = new URLSearchParams(location.search).get("view");
    this.model.setPlayerGlow(null);
    this.drawModel?.setPlayerGlow(null);
    this.watchCount = null;
    this.gauntlet?.dispose();
    this.gauntlet = req.gauntlet ? new GauntletLayer(req.gauntlet.plan, req.gauntlet.idx) : null;
    if (this.gauntlet) (this.panel.prepend(this.gauntlet.el), this.root.append(this.gauntlet.overlay));
    this.practiceBtn.hidden = !this.host.practiceFrom || !!this.gauntlet;
    this.showShell();
    this.setLoading("Loading replay…");
    try {
      const { bytes, label } = await this.resolve(req.target);
      const replay = await decodeReplay(bytes);
      if (replay.header.map !== this.host.map) {
        this.setLoading(`Loading ${replay.header.map}…`);
        const sourceRunId = viewerRequestRunId(req);
        const next = new URL(sourceRunId ? (req.h2h ? h2hUrl(sourceRunId, req.h2h.runId) : viewerUrl({ runId: sourceRunId })) : viewerUrl({ bytes }, replay.header.map), appHref());
        if (deep.tick !== null) next.searchParams.set("t", String(deep.tick));
        if (deep.jump !== null) next.searchParams.set("jump", String(deep.jump));
        location.href = next.pathname + next.search;
        return;
      }
      await this.viewerCore();
      if (my !== this.seq) return;
      this.clearH2H();
      this.setLoading("Preparing replay…");
      await afterPaint();
      // Your own PB replays: your colourway when the trailer has none.
      const own = "pb" in req.target || replay.header.player === lastKnownMe()?.name;
      this.look = { loadout: replay.loadout ?? { ...DEFAULT_LOADOUT }, outfit: replay.loadout?.outfit ?? (own ? getOutfit() : DEFAULT_COSMETICS.outfit!), glow: null };
      this.load(replay, bytes, label);
      // Shareable link for leaderboard runs.
      this.runId = viewerRequestRunId(req);
      this.owner = null;
      // A replay without the colourway (all before v0.0.29): the account's bunny as it is now, with the trailer's knife /
      // finish / gloves when it has them.
      const askLook = !replay.loadout?.outfit;
      if (this.runId) void api.runPlayer(this.runId, askLook).then(p => {
        if (my !== this.seq) return;
        const acct = askLook ? p.look : null;
        this.applyLook({ loadout: replay.loadout ?? acct?.loadout ?? this.look.loadout, outfit: acct?.outfit ?? this.look.outfit, glow: p.playerGlow });
        this.owner = p.name;
        this.updateTitle();
        this.reportBtn.hidden = !this.runId || !api.available() || p.id === lastKnownMe()?.id;
      }).catch(() => {});
      if (this.runId && api.available()) {
        const id=this.runId;
        const data=this.player!.data;
        const tracker=new ReplayWatchCount(replayWatchThreshold(data.n*data.interval), token => api.recordReplayView(id,token));
        this.watchCount=tracker;
        void api.startReplayView(id).then(token => {if (my===this.seq) tracker.ready(token);}).catch(()=>{});
      }
      this.shareBtn.hidden = !this.runId;
      // Not on your own runs (the name the replay was recorded under; the server refuses them anyway).
      this.reportBtn.hidden = !this.runId || !api.available() || replay.header.player === lastKnownMe()?.name;
      // (A gauntlet's map keeps its watch address.)
      if (this.runId && !this.gauntlet) history.replaceState(null, "", req.h2h ? h2hUrl(this.runId, req.h2h.runId) : viewerUrl({ runId: this.runId }));
      if (req.h2h) {
        await this.openH2H(req.h2h.runId, my, layoutParam(view));
        return;
      }
      // A deep link starts paused at that tick (?t=) or half a second before that jump (?jump=, from the admin).
      const data = this.player!.data;
      const at = deep.tick ?? (deep.jump ? jumpTick(data, deep.jump) : null);
      if (at !== null) {
        this.seekTo(Math.max(0, Math.min(data.n, deep.jump && deep.tick === null ? at - Math.round(data.tickrate / 2) : at)), true);
        this.playing = false;
        this.updateControls();
      }
      // Staff only: the analysis' flagged jumps on the timeline (nothing is fetched for players).
      if (this.runId) void evidenceTicks(this.runId, data).then((ticks) => my === this.seq && ticks.length && this.timeline.setEvidence(ticks));
      if (req.compare) await this.setCompare(req.compare, "wr");
    } catch (e) {
      if (my !== this.seq) return;
      console.error(e);
      this.setLoading(String((e as Error)?.message ?? e), true, req.h2h ? "Can't open head to head" : undefined);
    }
  }

  private showShell(): void {
    if (this.active) return;
    this.active = true;
    this.root.hidden = false;
    this.updateCleanKey();
    document.body.classList.add("viewer-open");
    document.exitPointerLock?.();
    this.host.scene.add(this.model.root);
    this.host.scene.add(this.floor.root);
    this.host.onOpen();
    this.lastNow = performance.now();
    this.frameStats.reset();
    this.statFrames = 0;
    this.statSkip = true;
  }

  private setLoading(text: string | null, error = false, title = "Can't open this replay"): void {
    this.loading.hidden = text === null;
    this.loading.classList.toggle("error", error);
    if (text === null) return;
    this.loading.replaceChildren(
      ...[
      error ? h("strong", null, title) : h("div.rv-spinner"),
      h("span", null, text),
      error ? h("button.rv-btn.rv-chip", { type: "button", onclick: () => this.close() }, "Close") : null,
      ].filter((x): x is HTMLElement => !!x),
    );
  }

  private load(replay: Replay, bytes: Uint8Array, label: string): void {
    this.player?.dispose();
    this.clearCompare();
    const p = new ReplayPlayer(this.core!, replay);
    this.trailHistory.clear();
    this.player = p;
    this.replay = replay;
    this.bytes = bytes;
    this.label = label;
    const d = p.data;
    const s = p.stats;
    console.info(`replay viewer: ${d.n} ticks pre-simulated in ${s.prepassMs.toFixed(0)} ms, ${s.keyframes} keyframes every ${s.keyframeTicks} ticks (${(s.keyframeBytes / 1048576).toFixed(1)} MB)`);
    this.hud.reset();
    this.hud.setTickRate(d.tickrate);
    this.timeline.setData(d);
    // A Segmented replay is the stitched run: it plays straight through; the timeline marks where each load continued it.
    this.timeline.setSegments((replay.segments ?? []).map((l) => l.tick));
    this.rig.setShots([]);
    if (this.rig.mode === "auto") this.autoShots();
    this.t = d.startTick ? Math.max(0, d.startTick - d.tickrate) : 0;
    this.playing = true;
    this.lastShown = -1;
    this.rig.snap();
    this.model.snap();
    this.floorStale = true;
    // The knife / finish / gloves / colourway the run was played with (replay trailer, open() picks the rest).
    this.applyLook(this.look);
    this.armsTick = -1;
    if (this.weapon.eye) this.ensureArms();
    const h0 = replay.header;
    const notes: string[] = [];
    if (h0.mapSha256 !== this.host.mapSha256) notes.push("Recorded on a different build of this map, so playback may desync.");
    if (d.desyncTick !== null) notes.push(`Desync at tick ${d.desyncTick}: this build doesn't reproduce the recording exactly.`);
    if (d.styleViolations) notes.push(`${d.styleViolations} commands break the ${styleLabel(replayStyle(h0))} rules (filtered as the verifier does).`);
    if (styleDef(replayStyle(h0))?.airJump) notes.push(INFINITE_NOTE);
    this.notice = notes.join(" ");
    this.updateTitle();
    this.updateControls();
    this.setLoading(null);
    this.statSkip = true;
    this.statFrom = performance.now();
  }

  /** The shown tick, in practice: the replay is played into the live game and the viewer closes. Else a notice says why not. */
  private practiceFromHere(): void {
    const d = this.data;
    if (!this.replay || !d || this.gauntlet || !this.host.practiceFrom) return;
    const why = this.host.practiceFrom(this.replay, Math.max(0, Math.min(d.n, Math.floor(this.t))));
    if (why) this.flash(why);
    else this.close();
  }

  /** The feedback form on "Report a player", about this run (its player comes from the run on the server). */
  private report(): void {
    const r = this.replay;
    if (!r || !this.runId) return;
    this.playing = false;
    this.updateControls();
    const d = this.player?.data;
    openFeedback({ category: "report", report: { name: this.playerName() || "this player", run: { id: this.runId, map: r.header.map, time: d ? finalRunTime(d) : null }, style: replayStyle(r.header) } });
  }

  /** Who ran it: the server's account name for a leaderboard run, else the name in the replay file. */
  private playerName(): string {
    return this.owner ?? this.replay?.header.player ?? "";
  }

  private updateTitle(): void {
    const r = this.replay;
    if (!r) return;
    const h0 = r.header;
    const d = this.player!.data;
    const time = d.endTick ? formatTime(finalRunTime(d)!) : "DNF";
    this.titleEl.replaceChildren(h("b", null, this.playerName() || "unknown"), h("span.rv-time-big", null, time));
    const track = d.runTrack || h0.track || 0;
    const loads = r.segments?.length ?? 0;
    const style = styleLabel(replayStyle(h0)) + (loads ? ` (${loads} load${loads === 1 ? "" : "s"})` : "");
    this.subEl.textContent = [h0.map, track ? trackName(track) : "", style, `${d.tickrate} tick`, this.label, new Date(h0.recordedAt).toLocaleDateString()].filter(Boolean).join(" · ");
    this.noticeEl.textContent = this.notice;
    this.noticeEl.hidden = !this.notice;
  }

  close(): void {
    if (!this.active || this.exporting) return;
    // Watching a gauntlet: back to its page.
    if (this.gauntlet) return this.gauntlet.leave();
    this.seq++;
    this.model.setPlayerGlow(null);
    this.drawModel?.setPlayerGlow(null);
    this.watchCount=null;
    this.setClean(false);
    this.logFrames();
    this.active = false;
    this.playerShadow.setEnabled(false);
    this.playing = false;
    this.sound.stop();
    this.root.hidden = true;
    this.helpEl.hidden = true;
    this.compareMenu.hidden = true;
    document.body.classList.remove("viewer-open");
    if (document.pointerLockElement === this.stage) document.exitPointerLock();
    this.model.root.removeFromParent();
    this.floor.root.removeFromParent();
    this.floor.clear();
    this.arms?.dispose();
    this.arms = null;
    this.clearH2H();
    this.clearCompare();
    this.player?.dispose();
    this.trailHistory.clear();
    this.player = null;
    this.replay = null;
    const cam = this.host.camera;
    cam.up.set(0, 1, 0);
    cam.rotation.order = "YXZ";
    cam.rotation.set(0, 0, 0);
    const url = new URL(appHref());
    if (url.pathname.startsWith("/replay/") || url.pathname.startsWith("/h2h/") || url.searchParams.has("replay")) {
      url.pathname = "/";
      url.searchParams.delete("replay");
      url.searchParams.delete("style");
      url.searchParams.delete("track");
      url.searchParams.set("map", this.host.map);
      history.replaceState(null, "", url.pathname + url.search);
    }
    this.host.onClose();
  }

  // -------------------------------------------------------------------------------------------
  // Playback controls

  get data(): RunData | null {
    return this.player?.data ?? null;
  }

  togglePlay(): void {
    const d = this.data;
    if (!d) return;
    // Played to the end: again from just before the run, as on load (not the wait in the spawn).
    if (!this.playing && this.t >= this.tEnd) this.seekTo(d.startTick ? Math.max(0, d.startTick - d.tickrate) : 0, true);
    this.playing = !this.playing;
    this.updateControls();
  }

  setSpeed(s: number): void {
    this.speed = s;
    this.updateControls();
  }

  private nudgeSpeed(dir: number): void {
    const i = SPEEDS.indexOf(this.speed);
    this.setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - (this.h2h ? 2 : 1), (i < 0 ? 3 : i) + dir))]);
  }

  step(ticks: number): void {
    const d = this.data;
    if (!d) return;
    this.playing = false;
    this.seekTo(Math.round(this.t) + ticks, true);
    this.updateControls();
  }

  seekTo(t: number, _final = true): void {
    this.watchCount?.seek();
    const d = this.data;
    if (!d) return;
    const nt = Math.max(0, Math.min(this.tEnd, t));
    if (Math.abs(nt - this.t) > 30) {
      if (this.rig.mode !== "free") this.rig.snap();
      this.model.snap();
    }
    this.t = nt;
  }

  private jumpStart(): void {
    const d = this.data;
    if (d) this.seekTo(d.startTick ? Math.max(0, d.startTick - Math.round(d.tickrate * 0.5)) : 0, true);
  }

  private jumpEnd(): void {
    const d = this.data;
    if (d) this.seekTo(this.h2h ? this.h2h.lastFinish : d.endTick || d.n, true);
  }

  setCam(mode: CamMode): void {
    const d = this.data;
    if (mode === "free" && this.rig.mode !== "free") this.rig.startFree(this.host.camera);
    if (mode === "auto" && d && !this.rig.shotList.length) this.autoShots();
    if (mode !== "free" && document.pointerLockElement === this.stage) document.exitPointerLock();
    this.rig.mode = mode;
    this.rig.snap();
    this.updateControls();
  }

  private cycleCam(): void {
    const i = CAM_MODES.findIndex((m) => m.id === this.rig.mode);
    this.setCam(CAM_MODES[(i + 1) % CAM_MODES.length].id);
  }

  private toggleHud(): void {
    this.hudOn = !this.hudOn;
    this.hud.el.hidden = !this.hudOn;
    this.updateControls();
  }

  /** V: the weapon in hand on / off for the current view (in-eye or third person), remembered. */
  private toggleWeapon(): void {
    const k = this.firstPerson ? "eye" : "third";
    this.weapon = { ...this.weapon, [k]: !this.weapon[k] };
    try {
      localStorage.setItem(WEAPON_KEY, JSON.stringify(this.weapon));
    } catch {
      /* private mode */
    }
    if (this.weapon.eye) this.ensureArms();
    this.updateControls();
  }

  /** The runner's bunny (colourway, loadout, glow) on the model, the export's copy and the first-person arms. */
  private applyLook(l: ArmsLook): void {
    this.look = l;
    for (const m of new Set([this.model, this.drawModel])) {
      m.setOutfit(l.outfit);
      m.setLoadout(l.loadout);
      m.setPlayerGlow(l.glow);
    }
    this.arms?.setLook(l);
    // A colourway / hat / gloves new to this page: their programs compile now, not in the first frame that shows them.
    void warmPrograms(this.host.renderer, this.model.root, this.host.camera, this.host.scene).catch(() => {});
  }

  /** The in-eye arms, made (and their programs compiled in the background) the first time they're wanted. */
  private ensureArms(): void {
    if (this.arms || !this.core) return;
    const a = (this.arms = new ReplayArms(this.core, this.host.scene));
    a.setLook(this.look);
    this.armsTick = -1;
    this.armsWarm = a.warm(this.host.renderer, this.host.camera).catch(() => {
      a.ready = true;
    });
  }

  /** The weapon-in-hand toggles in effect: the export's while one renders, else the viewer's (V). */
  private get weaponNow(): WeaponShown {
    return (this.exporting && this.exportWeapon) || this.weapon;
  }

  /** The export dialog's default for a camera: the viewer's toggle for that view (Auto-director: the view shown now). */
  weaponFor(camera: ExportCam): boolean {
    const eye = camera === "eye" || (camera === "auto" && this.firstPerson);
    return eye ? this.weapon.eye : this.weapon.third;
  }

  /** Hide UI: the picture, and the speed / keys if the player keeps them. Not kept between visits (ui/hide-ui.ts). */
  private setClean(on: boolean): void {
    if (on === this.clean) return;
    this.clean = on;
    this.root.classList.toggle("rv-clean", on);
    if (on) {
      this.helpEl.hidden = true;
      this.compareMenu.hidden = true;
      // The clicked button is hidden now; don't leave keyboard focus on it.
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
    setUiHidden("viewer", on);
  }

  /** The Hide UI bind (Settings -> Keys) in the button's tooltip and the shortcuts list. */
  private updateCleanKey(): void {
    const key = hideUiKey();
    this.cleanBtn.title = key ? `Hide UI (${key})` : "Hide UI";
    this.cleanKey.textContent = key ?? "";
    const dt = this.cleanKey.parentElement!;
    dt.hidden = (dt.nextElementSibling as HTMLElement).hidden = !key;
  }

  private downloadBhr(): void {
    if (this.bytes && this.replay) download(this.bytes, replayFileName(this.replay.header));
  }

  private updateControls(): void {
    const d = this.data;
    this.playBtn.replaceChildren(glyph(this.playing ? "pause" : "play"));
    this.speedTrigger.textContent = `${this.speed}×`;
    this.camTrigger.textContent = CAM_MODES.find((m) => m.id === this.rig.mode)?.label ?? "Camera";
    this.playBtn.classList.toggle("playing", this.playing);
    SPEEDS.forEach((s, i) => this.speedBtns[i].classList.toggle("on", s === this.speed));
    for (const [m, b] of this.camBtns) b.classList.toggle("on", m === this.rig.mode);
    this.hudBtn.classList.toggle("on", this.hudOn);
    this.weaponBtn.classList.toggle("on", this.firstPerson ? this.weapon.eye : this.weapon.third);
    this.weaponBtn.title = `Weapon in hand, ${this.firstPerson ? "in-eye" : "third person"} (V)`;
    this.freeHint.hidden = this.rig.mode !== "free" || document.pointerLockElement === this.stage;
    const hb = this.h2hBtns;
    if (hb && this.h2h) {
      for (const l of ["side", "stacked", "ghost"] as const) hb[l].classList.toggle("on", this.h2h.layout === l);
      hb.stats.classList.toggle("on", this.h2h.panelsOn);
      hb.early.classList.toggle("on", this.h2h.showEarly);
      this.layoutTrigger.textContent = { side: "Side by side", stacked: "Stacked", ghost: "Ghost" }[this.h2h.layout];
    }
    const c = this.compare;
    this.compareBtn.textContent = c ? `vs ${c.label}` : "Compare";
    this.compareBtn.classList.toggle("on", !!c);
    if (c) this.compareBtn.style.setProperty("--chip", GHOST_CSS[c.kind]);
    else this.compareBtn.style.removeProperty("--chip");
    if (!d) return;
  }

  // -------------------------------------------------------------------------------------------
  // Head to head (viewer/h2h.ts)

  /** The last display tick: the replay's, or in head to head the later of the two replays' ends. */
  private get tEnd(): number {
    const d = this.data;
    return !d ? 0 : this.h2h ? this.h2h.end : d.n;
  }

  /** After the primary run (`this.runId`) loaded: loads run B, checks the pair and sets head to head up. */
  private async openH2H(bId: string, my: number, layout: H2HLayout | null): Promise<void> {
    const aId = this.runId;
    const a = this.replay;
    if (!aId || !a || !this.player || !this.core || !this.bytes) throw new Error("Head to head needs two leaderboard runs.");
    if (bId === aId) throw new Error("Pick two different runs.");
    if (!api.available()) throw new Error("Leaderboards are offline, so these runs can't be loaded.");
    this.setLoading("Loading the second run…");
    const info = async (id: string): Promise<RunInfo> => {
      try {
        return await api.runInfo(id);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) throw new Error("One of these runs doesn't exist or isn't public.");
        throw e;
      }
    };
    const [ia, ib] = await Promise.all([info(aId), info(bId)]);
    if (ia.status !== "verified" || ib.status !== "verified") throw new Error("Only verified runs can go head to head.");
    if (ia.map !== ib.map) throw new Error(`These runs are on different maps (${ia.map} and ${ib.map}).`);
    const bBytes = await api.replay(bId);
    const b = await decodeReplay(bBytes);
    if (b.header.map !== this.host.map) throw new Error(`These runs are on different maps (${this.host.map} and ${b.header.map}).`);
    const core = await sideCore(this.host.wasmBytes, this.host.bsp);
    if (my !== this.seq) return;
    this.setLoading("Preparing both runs…");
    await afterPaint();
    if (my !== this.seq) return;
    const bp = new ReplayPlayer(core, b);
    const lookB: ArmsLook = { loadout: b.loadout ?? { ...DEFAULT_LOADOUT }, outfit: b.loadout?.outfit ?? DEFAULT_COSMETICS.outfit!, glow: ib.player.playerGlow ?? null };
    // The faster run goes left (top) in the faster run's colour; as the URL gives them when level.
    const bFaster = (ib.time ?? Infinity) < (ia.time ?? Infinity);
    const sides = [
      makeSide({ runId: aId, info: ia, replay: a, bytes: this.bytes, core: this.core, player: this.player, look: this.look, color: H2H_COLORS[bFaster ? 1 : 0] }),
      makeSide({ runId: bId, info: ib, replay: b, bytes: bBytes, core, player: bp, look: lookB, color: H2H_COLORS[bFaster ? 0 : 1] }),
    ] as const;
    const host = this.host;
    this.h2h = new HeadToHead([sides[0], sides[1]], {
      renderer: host.renderer,
      scene: host.scene,
      camera: host.camera,
      root: this.root,
      mainHud: this.hud.el,
      render: (scene, cam, sec) => host.graphicsPipeline.render(scene, cam, sec),
      worldUpdate: (origins, sec, fx, anims) => host.world.update(origins, sec, fx, anims),
    }, layout ?? defaultLayout(innerWidth, innerHeight, slowGraphics()));
    // Small notes: builds, zones, styles and tracks may differ.
    const ha = a.header;
    const hb = b.header;
    const notes: string[] = [];
    if (ha.mapSha256 !== hb.mapSha256) notes.push("Different map builds");
    else if (JSON.stringify(ha.zones) !== JSON.stringify(hb.zones)) notes.push("Different zones");
    if (replayStyle(ha) !== replayStyle(hb)) notes.push(`${styleLabel(replayStyle(ha))} vs ${styleLabel(replayStyle(hb))}`);
    const ta = this.player.data.runTrack;
    const tb = bp.data.runTrack;
    if (ta !== tb) notes.push(`${trackName(ta)} vs ${trackName(tb)}`);
    this.h2hNote.textContent = notes.join(", ");
    this.h2hNote.hidden = !notes.length;
    this.root.append(this.h2hNote);
    this.owner = ia.player.name;
    this.h2h.showEarly = earlyShown();
    this.applyH2H();
    this.setH2HLayout(this.h2h.layout);
    if (bFaster) this.swapH2H();
    this.setLoading(null);
    this.statSkip = true;
    this.statFrom = performance.now();
  }

  /** Back to one run: the second run's sim and the stats go. */
  private clearH2H(): void {
    const hh = this.h2h;
    if (!hh) return;
    hh.dispose();
    this.h2h = null;
    this.h2hNote.remove();
    this.clearCompare();
    this.timeline.setEnd(null);
    this.root.classList.remove("rv-h2h", "rv-h2h-side", "rv-h2h-stacked", "rv-h2h-ghost");
    this.root.style.removeProperty("--h2h-hud");
    this.h2hGroup.hidden = true;
    for (const e of this.soloOnly) e.hidden = false;
    for (const e of this.h2hOnly) e.hidden = true;
    this.speedBtns[SPEEDS.length - 1].hidden = false;
    this.host.resize();
  }

  /** The compare ghost, the timeline's gap and end, and the controls for the current primary. */
  private applyH2H(): void {
    const hh = this.h2h;
    const d = this.data;
    if (!hh || !d) return;
    const o = hh.other;
    const od = o.player.data;
    const ghost = hh.makeGhost();
    ghost.trace = (x, y) => this.trace(x, y, 0);
    this.compare?.ghost.dispose();
    this.host.scene.add(ghost.root);
    const g = hh.mainGap;
    const kind = hh.primary === 0 ? "wr" : "custom";
    this.compare = { ghost, kind, label: o.name, replay: o.replay, startTick: od.startTick, endTick: od.endTick, delta: g.delta, speedDiff: g.speedDiff };
    const end = od.endTick ? d.startTick + ((od.endTick - od.startTick) * od.interval) / d.interval : null;
    this.timeline.setCompare(end, o.color, g.delta);
    this.timeline.setEnd(hh.end);
    this.root.classList.add("rv-h2h");
    this.root.style.setProperty("--run-main", hh.main.color);
    this.h2hGroup.hidden = false;
    for (const e of this.soloOnly) e.hidden = true;
    for (const e of this.h2hOnly) e.hidden = false;
    this.practiceBtn.hidden = true;
    this.reportBtn.hidden = true;
    this.shareBtn.hidden = false;
    // 0.1x to 2x.
    this.speedBtns[SPEEDS.length - 1].hidden = true;
    if (this.speed > 2) this.setSpeed(2);
    this.updateControls();
  }

  setH2HLayout(l: H2HLayout): void {
    const hh = this.h2h;
    if (!hh) return;
    hh.setLayout(l);
    for (const k of ["side", "stacked", "ghost"] as const) this.root.classList.toggle(`rv-h2h-${k}`, l === k);
    this.compare?.ghost.setVisible(l === "ghost");
    this.rig.snap();
    this.statSkip = true;
    this.updateControls();
  }

  /** The other run becomes the primary: left view, the camera in ghost view, the timeline and the HUD's split. */
  swapH2H(): void {
    const hh = this.h2h;
    const d0 = this.data;
    if (!hh || !d0) return;
    const tau = (this.t - d0.startTick) * d0.interval;
    hh.main.look = this.look;
    hh.swap();
    const m = hh.main;
    this.player = m.player;
    this.core = m.core;
    this.corePromise = Promise.resolve(m.core);
    this.replay = m.replay;
    this.bytes = m.bytes;
    this.runId = m.runId;
    this.owner = m.name;
    const d = m.player.data;
    this.trailHistory.clear();
    this.hud.reset();
    this.hud.setTickRate(d.tickrate);
    this.timeline.setData(d);
    this.timeline.setSegments((m.replay.segments ?? []).map((l) => l.tick));
    this.arms?.dispose();
    this.arms = null;
    this.armsTick = -1;
    if (this.weapon.eye) this.ensureArms();
    this.floorStale = true;
    this.lastShown = -1;
    this.applyLook(m.look);
    this.t = Math.max(0, Math.min(hh.end, d.startTick + tau / d.interval));
    this.rig.snap();
    this.model.snap();
    this.applyH2H();
    this.updateTitle();
  }

  /** Closes an open speed / camera / layout / More menu; whether one was open (Esc closes it before the viewer). */
  private closePops(): boolean {
    let open = false;
    for (const o of this.root.querySelectorAll<HTMLElement>(".rv-pop")) (open ||= !o.hidden), (o.hidden = true);
    return open;
  }

  /** Head to head's "early" number in each panel: off unless the player turns it on (remembered). */
  private toggleEarly(): void {
    if (!this.h2h) return;
    this.h2h.showEarly = !this.h2h.showEarly;
    try {
      localStorage.setItem(EARLY_KEY, this.h2h.showEarly ? "1" : "0");
    } catch {
      /* private mode */
    }
    this.updateControls();
  }

  private toggleStats(): void {
    if (!this.h2h) return;
    this.h2h.panelsOn = !this.h2h.panelsOn;
    this.updateControls();
  }

  /** J / Shift+J: the primary's next / previous jump in the timed run. */
  private stepJump(dir: 1 | -1): void {
    const d = this.data;
    if (!d) return;
    const now = Math.floor(this.t);
    const jumps = d.jumpTicks.filter((k) => k >= d.startTick && (!d.endTick || k <= d.endTick));
    const next = dir > 0 ? jumps.find((k) => k > now + 2) : [...jumps].reverse().find((k) => k < now - 2);
    if (next !== undefined) this.seekTo(next - 2, true);
  }

  // -------------------------------------------------------------------------------------------
  // Compare

  private clearCompare(): void {
    this.compare?.ghost.dispose();
    this.compare = null;
    this.timeline.setCompare(null, "", null);
    this.updateControls();
  }

  private toggleCompareMenu(): void {
    const m = this.compareMenu;
    if (!m.hidden) {
      m.hidden = true;
      return;
    }
    const r = this.replay;
    if (!r) return;
    const hd = r.header;
    const track = this.data?.runTrack ?? hd.track ?? 0;
    const style = replayStyle(hd);
    const item = (label: string, sub: string, fn: () => void, disabled = false) =>
      h("button.rv-menu-item", { type: "button", role: "menuitem", disabled, onclick: () => ((m.hidden = true), fn()) }, h("span", null, label), sub ? h("small", null, sub) : null);
    const file = h("input", { type: "file", accept: ".bhr,application/octet-stream", hidden: true });
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      if (f) void f.arrayBuffer().then((b) => this.setCompare({ bytes: new Uint8Array(b), name: f.name.replace(/\.bhr$/, "") }, "custom"));
    });
    // A leaderboard run: head to head with another run of its board (a page of its own, /h2h/<a>/<b>). A local replay
    // (your PB file, a .bhr) can't go head to head: it gets a ghost to race, as before.
    const runId = this.runId;
    if (api.available() && runId) {
      m.replaceChildren(
        item("World record", "", () => void this.h2hWith("wr", style, track)),
        item("Your PB", "", () => void this.h2hWith("pb", style, track)),
        item("Run above", "", () => void this.h2hWith("above", style, track)),
        item("Run below", "", () => void this.h2hWith("below", style, track)),
        h("button.rv-menu-item", { type: "button", role: "menuitem", onclick: () => this.h2hPaste() }, h("span", null, "Run link…")),
      );
      m.hidden = false;
      return;
    }
    m.replaceChildren(
      item("Your PB", `${trackName(track)} · ${styleLabel(style)}`, () => void this.setCompare({ pb: { map: hd.map, style, track } }, "pb")),
      item("World record", api.available() ? "Top of the leaderboard" : "Leaderboards offline", () => void this.compareWR(style, track), !api.available()),
      item("Replay file…", ".bhr from disk", () => file.click()),
      ...(this.compare ? [item("Remove ghost", this.compare.label, () => this.clearCompare())] : []),
      file,
    );
    m.hidden = false;
  }

  /** Head to head with a run picked from this run's board: the WR, your PB, the run above or below. */
  private async h2hWith(which: "wr" | "pb" | "above" | "below", style: string, track: number): Promise<void> {
    const runId = this.runId;
    if (!runId) return;
    try {
      const map = this.host.map;
      let other: string | null = null;
      if (which === "wr" || which === "pb") {
        const lb = await api.leaderboard(map, style, { track, limit: 1 });
        other = which === "wr" ? (lb.wr ?? lb.entries[0])?.runId ?? null : lb.me?.runId ?? null;
        if (!other) throw new Error(which === "wr" ? "No world record on this board yet." : "You have no run on this board yet.");
      } else {
        const rank = (await api.runInfo(runId)).rank;
        if (!rank) throw new Error("This run isn't on the current board.");
        const want = which === "above" ? rank - 1 : rank + 1;
        if (want < 1) throw new Error("This run is the world record.");
        const lb = await api.leaderboard(map, style, { track, offset: want - 1, limit: 1 });
        other = lb.entries.find((e) => e.rank === want)?.runId ?? null;
        if (!other) throw new Error("There's no run below this one.");
      }
      if (other === runId) throw new Error(which === "wr" ? "This run is the world record." : "That's this run.");
      openHeadToHead(runId, other);
    } catch (e) {
      this.flash(String((e as Error)?.message ?? e));
    }
  }

  /** Head to head with a pasted replay link (or run id): the menu becomes one field. */
  private h2hPaste(): void {
    const runId = this.runId;
    const m = this.compareMenu;
    if (!runId) return;
    const input = h("input.rv-menu-input", { type: "text", placeholder: "bunnyhop.lol/replay/…", spellcheck: "false", "aria-label": "Replay link or run id" }) as HTMLInputElement;
    const msg = h("small.rv-menu-msg");
    const go = () => {
      const other = runIdFromText(input.value);
      if (!other) return void (msg.textContent = "That isn't a replay link.");
      if (other === runId) return void (msg.textContent = "That's this run.");
      m.hidden = true;
      openHeadToHead(runId, other);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
      else if (e.key === "Escape") m.hidden = true;
      e.stopPropagation();
    });
    m.replaceChildren(input, msg, h("button.rv-btn.rv-chip.rv-menu-go", { type: "button", onclick: go }, "Open"));
    m.hidden = false;
    input.focus();
  }

  private async compareWR(style: string, track: number): Promise<void> {
    try {
      const top = await worldRecord(this.host.map, style, track);
      if (!top) throw new Error("No world record on this board yet.");
      await this.setCompare({ runId: top.runId, name: `WR · ${top.player.name}` }, "wr");
    } catch (e) {
      this.flash(String((e as Error)?.message ?? e));
    }
  }

  private flash(msg: string): void {
    this.noticeEl.textContent = msg;
    this.noticeEl.hidden = false;
    setTimeout(() => this.updateTitle(), 5000);
  }

  /** Overlays another replay of this map as a ghost (re-simulated on the viewer core) with a per-tick delta. */
  async setCompare(target: ReplayTarget, kind: GhostKind): Promise<void> {
    const d = this.data;
    if (!d || !this.core) return;
    try {
      const { bytes, label } = await this.resolve(target);
      const replay = await decodeReplay(bytes);
      if (replay.header.map !== this.host.map) throw new Error(`That replay is for ${replay.header.map}.`);
      const sim = simulate(this.core, replay, replay.header.zones, { frames: true });
      this.player!.invalidate();
      if (!sim.startTick) throw new Error("The compared replay never starts a run.");
      const name = label || replay.header.player || "ghost";
      const ghost = new Ghost({
        kind,
        track: sim.track,
        style: "*",
        name,
        frames: sim.frames!,
        frameEvents: sim.frameEvents,
        startTick: sim.startTick,
        endTick: sim.endTick || sim.ticks,
        tickInterval: Math.fround(replay.header.settings.tickInterval),
        side: replay.side,
        forward: replay.forward,
        cosmetic: replay.cosmetic,
        loadout: replay.loadout,
      });
      ghost.setRenderOrder(30);
      ghost.trace = (a, b) => this.trace(a, b, 0); // its tag hides behind walls (Settings -> Ghost -> Names through walls)
      // Delta along the run: the ghost's progress nearest to each primary tick (ghost.ts split()).
      const delta = new Float32Array(d.n + 1).fill(NaN);
      const speedDiff = new Float32Array(d.n + 1).fill(NaN);
      if (d.startTick) {
        const end = d.endTick || d.n;
        const pos = [0, 0, 0];
        let last = NaN;
        ghost.prepareSplit();
        for (let i = d.startTick; i <= end; i++) {
          pos[0] = d.pos[i * 3];
          pos[1] = d.pos[i * 3 + 1];
          pos[2] = d.pos[i * 3 + 2];
          const v = ghost.split(pos, i - d.startTick);
          if (v !== null) last = v;
          delta[i] = last;
          // The live HUD's measure: both speeds from the last tick's move (session.ts frame).
          if (i > d.startTick && !(d.flags[i] & F_TELEPORTED)) {
            const mx = pos[0] - d.pos[(i - 1) * 3], my = pos[1] - d.pos[(i - 1) * 3 + 1];
            speedDiff[i] = Math.sqrt(mx * mx + my * my) / d.interval - ghost.matchSpeed;
          }
        }
        if (d.endTick && sim.endTick) {
          const fin = (d.endTick - d.startTick - (sim.endTick - sim.startTick)) * d.interval;
          for (let i = d.endTick; i <= d.n; i++) delta[i] = fin;
        }
        ghost.resetSplit();
      }
      this.compare?.ghost.dispose();
      this.host.scene.add(ghost.root);
      this.compare = { ghost, kind, label: name, replay, startTick: sim.startTick, endTick: sim.endTick, delta, speedDiff };
      this.timeline.setCompare(sim.endTick ? d.startTick + (sim.endTick - sim.startTick) : null, GHOST_CSS[kind], delta);
      this.updateControls();
    } catch (e) {
      this.flash(`Compare: ${String((e as Error)?.message ?? e)}`);
    }
  }

  deltaAt(t: number): number | null {
    const c = this.compare;
    if (!c) return null;
    const v = c.delta[Math.max(0, Math.min(c.delta.length - 1, Math.floor(t)))];
    return Number.isFinite(v) ? v : null;
  }

  /** The compare ghost's speed difference at tick t, in steps of SPEED_DIFF_STEP ticks (about the live HUD's rate). */
  speedDiffAt(t: number): number | null {
    const c = this.compare;
    if (!c) return null;
    const i = Math.max(0, Math.min(c.speedDiff.length - 1, Math.floor(t)));
    const v = c.speedDiff[i - (i % SPEED_DIFF_STEP)];
    return Number.isFinite(v) ? v : null;
  }

  get compareLabel(): string | null {
    return this.compare?.label ?? null;
  }

  // -------------------------------------------------------------------------------------------
  // Rendering (shared with the export)

  /** Positions the sim, world, camera, player model and compare ghost for display tick t, then renders. */
  render(t: number, dt: number, rig: CameraRig): void {
    const p = this.player!;
    const d = p.data;
    const i = Math.max(0, Math.min(d.n, Math.floor(t)));
    // Direct replay/export sampling also performs seeks; reset animation/camera history at those cuts. Both pre-roll the
    // run before the cut (cameras.ts, PlayerModel.preroll), so a seek lands where continuous playback would be.
    let cut = false;
    if (this.lastShown < 0 || (Number.isFinite(this.lastRenderedTick) && (t < this.lastRenderedTick || (dt <= 0 && t !== this.lastRenderedTick)))) {
      rig.snap();
      cut = true;
    }
    this.lastRenderedTick = t;
    // Moving sprite trails are rebuilt from the brush history every frame (render.ts reconstructTrails). Playing (and
    // exporting), every tick the core steps through on the way is recorded, so playback never seeks back for it; the
    // first frame after a cut fills what's missing once. Scrubbing or paused, every frame is a cut: only the ticks the
    // trails sample are read, as before.
    const trail = (this.trailKeys = this.host.world.trailHistory());
    const advancing = this.exporting || (this.playing && !this.timeline.scrubbing);
    const record = trail && advancing ? this.recordTrail : undefined;
    // In-eye weapon: every tick played through feeds the guns (switches, reloads, shots) as in the game; a jump resets
    // them to the core's state. Before the trails below, which move the core around after a cut.
    const contiguous = this.lastShown >= 0 && i > this.lastShown && i - this.lastShown < 30;
    const arms = this.arms;
    if (arms && this.core) {
      const core = this.core;
      if (contiguous && this.armsTick === this.lastShown) {
        let next = this.lastShown + 1;
        let gap = false;
        p.seek(i, (k, events) => {
          record?.(k);
          if (k < next) return;
          if (k > next) gap = true;
          arms.step(core, events);
          next = k + 1;
        });
        if (gap) arms.reset(core);
      } else if (this.armsTick !== i) {
        p.seek(i, record);
        arms.reset(core);
      }
      this.armsTick = i;
    }
    if (trail) {
      const time = t * d.interval;
      if (advancing) this.fillTrailHistory(Math.floor(Math.max(0, time - trail.span) / d.interval) - 1, i);
      this.host.world.reconstructTrails(time, seconds => {
        const tick = Math.max(0, Math.min(d.n, Math.floor(seconds / d.interval)));
        let at = this.trailHistory.get(tick);
        if (!at) {
          p.seek(tick, record);
          this.recordTrail(tick);
          at = this.trailHistory.get(tick)!;
        }
        return at;
      });
      // Keeps the window (and some) when the trails live long; oldest recorded first out.
      const keep = Math.max(512, Math.ceil(trail.span / d.interval) + 64);
      for (const k of this.trailHistory.keys()) {
        if (this.trailHistory.size <= keep) break;
        this.trailHistory.delete(k);
      }
    }
    p.seek(i, record);
    const origins = p.brushOrigins();
    this.host.world.update(origins, t * d.interval, this.core?.effectStates(), this.core?.propAnims());
    if (this.core) this.host.onWorldUpdate?.(this.core, origins);
    // Map-given guns (physics v5): the items on the floor and the gun in the bunny's hand at this tick.
    const weapons = this.core ? weaponReport(this.core) : null;
    if (weapons && (weapons.floorChanged || this.floorStale)) {
      this.floor.update(floorWeapons(this.core!));
      this.floorStale = false;
    }
    const cam = this.host.camera;
    const showModel = rig.update(cam, d, t, dt, this.trace);
    if (rig === this.rig && this.firstPerson === showModel) {
      this.firstPerson = !showModel;
      this.updateControls();
    }
    const shown = this.weaponNow;
    const held = showModel ? shown.third : shown.eye;
    if (!showModel && held && !arms) this.ensureArms();
    const s = (this.sample = sampleAt(d, t, this.sample));
    const model = this.drawModel;
    model.root.visible = showModel;
    model.setHeldHidden(!shown.third);
    this.playerShadow.update(s.pos, s.crouched, !showModel);
    // The landing spot (main.ts: landing/) from the replay's sim at this tick; a read-only query.
    if (this.core) this.host.onPlayerFrame?.(this.core, s);
    {
      // Carrot swings recorded in the replay (cosmetic trailer), during normal playback.
      const playing = contiguous;
      const attack = playing ? cosmeticBetween(d.replay.cosmetic, this.lastShown, i) : 0;
      if (showModel && attack && !this.exporting) emitWeaponEvent({ type: attack === 2 ? "stab" : "slash", source: "replay", position: [s.pos[0], s.pos[1], s.pos[2]] });
      // Inspect tricks (inspect trailer): the third-person gesture; seeks drop them (the model snaps).
      const ins = playing ? inspectBetween(d.replay.inspect, this.lastShown, i) : { sig: 0, held: false };
      if (showModel && ins.sig && !this.exporting) emitWeaponEvent({ type: "inspect", source: "replay", position: [s.pos[0], s.pos[1], s.pos[2]] });
      // An empty hand (weapon off) doesn't swing or inspect.
      const tpHeld = shown.third;
      model.setGun(weapons && weapons.active >= 2 ? WEAPON_IDS[weapons.active] : null);
      model.setGunSilencer(!!weapons && weapons.active >= 2 && weapons.silencer);
      // On the simulation's clock (viewer/player.ts TickStepper): the model updates on each tick's own pose and blends
      // between ticks, so the pose at a replay time is the same at any playback speed and frame rate. A cut pre-rolls.
      if (this.stepperFor?.model !== model || this.stepperFor.data !== d) {
        this.stepperFor = { model, data: d, src: replayTicks(d) };
        this.stepper.reset();
      }
      this.stepper.show(model, this.stepperFor.src, t, cut, { attack: tpHeld ? attack : 0, inspect: tpHeld ? ins.sig : 0, inspectHeld: tpHeld && ins.held });
      if (arms) {
        if (attack) arms.swing(attack);
        if (ins.sig) arms.inspect(ins.sig);
        if (playing) for (let k = this.lastShown + 1; k <= i; k++) if (d.flags[k] & F_LANDED) this.armsLanded = Math.min(this.armsLanded, d.vel[(k - 1) * 3 + 2]);
        // Frames on the same tick keep it; a jump lets go.
        if (i !== this.lastShown) this.armsInspectHeld = ins.held;
        // An export animates and draws them once per output frame (drawViewmodel), not once per motion-blur sample.
        if (!this.exporting) this.armsFrame(arms, dt, s, !showModel && held, origins);
      }
    }
    this.lastShown = i;
    const c = this.compare;
    if (c && this.h2h && this.h2h.viewLayout !== "ghost") (c.ghost.setVisible(false), this.drawGhost?.setVisible(false));
    else if (c) {
      cam.getWorldPosition(this.camPos);
      const g = prefs.get().ghost;
      const running = d.startTick > 0 && t >= d.startTick;
      const gt = running ? Math.min(c.startTick + (t - d.startTick), c.endTick || c.startTick + (t - d.startTick)) : c.startTick;
      const ghost = this.drawGhost ?? c.ghost;
      ghost.delta = this.deltaAt(t);
      ghost.setVisible(true);
      // Name tags go with the rest of the UI when it's hidden.
      const tag = g.tag && !this.clean;
      ghost.showAt(gt, running && (!c.endTick || gt < c.endTick), dt, this.camPos, { opacity: g.opacity, trail: g.trail, nearFade: true, tag }, running);
    }
    this.host.graphicsPipeline.render(this.host.scene, cam,t*d.interval);
    // The export draws it after its frame is complete (drawViewmodel): motion-blur samples composite first.
    if (!this.exporting) this.arms?.render(this.host.renderer, cam);
  }

  /** What the trails read (render(): the world's trailHistory), null without trails. */
  private trailKeys: { models: ReadonlySet<number>; entities: ReadonlySet<number> } | null = null;

  /**
   * The trails' brush transforms and effect states at the core's current tick (render()): only the keys they read, the
   * values those of a full brushOrigins / effectStates.
   */
  private readonly recordTrail = (k: number): void => {
    const keys = this.trailKeys;
    if (!keys || this.trailHistory.has(k) || !this.player || this.player.tick !== k) return;
    this.trailHistory.set(k, { transforms: this.player.brushOrigins(keys.models), states: this.core?.effectStates(keys.entities) });
  };

  /**
   * The trail window's ticks (lo..hi) not recorded yet, in order: the core goes to each (back to a keyframe for the
   * first after a cut, then forward), recording every tick it steps through, and stops after the last one. Playing,
   * that's the tick just reached; scrubbing, the ticks the window moved onto. The transforms are the ones a seek to each
   * tick gives (restore + step is bit-exact, player.ts).
   */
  private fillTrailHistory(lo: number, hi: number): void {
    const p = this.player!;
    for (let k = Math.max(0, lo); k <= hi; k++) {
      if (this.trailHistory.has(k)) continue;
      p.seek(k, this.recordTrail);
      this.recordTrail(k);
    }
  }

  /** The arms' animation, bob / sway from the replay's movement and effects, `show`: drawn this frame. */
  private armsFrame(arms: ReplayArms, dt: number, s: ViewSample, show: boolean, origins: Map<number, BrushTransform>): void {
    const input = { velocity: s.vel, grounded: s.grounded, viewOffsetZ: s.viewZ, sidemove: s.side, yaw: s.yaw, pitch: s.pitch, landed: this.armsLanded };
    this.armsLanded = 0;
    arms.frame(dt, input, this.armsInspectHeld, show, origins);
  }

  /** main.ts frame loop while the viewer is open. */
  frame(now: number): void {
    const dt = Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    if (this.exporting) return;
    const d = this.data;
    if (d && !this.statSkip) {
      this.frameStats.frame(now, performance.now());
      this.statFrames++;
    } else this.frameStats.skipFrame(now);
    this.statSkip = false;
    if (!d) {
      this.host.graphicsPipeline.render(this.host.scene, this.host.camera,0);
      return;
    }
    if (this.playing && !this.timeline.scrubbing) {
      const before=this.t;
      this.t += dt * this.speed * d.tickrate;
      if (this.t >= this.tEnd) {
        this.t = this.tEnd;
        this.playing = false;
        this.updateControls();
        this.gauntlet?.ended();
      }
      this.watchCount?.advance(dt, Math.max(0,Math.min(this.t,d.n)-before)*d.interval, document.visibilityState === "visible");
    }
    const vdt = this.playing ? dt * this.speed : dt;
    if (this.h2h) {
      // Head to head: the views over the area the panel leaves (viewer/h2h.ts), then the stats.
      const below = this.clean ? 0 : this.panel.offsetHeight;
      this.h2h.draw(this.t, vdt, below, this.rig.mode, (t, s) => this.render(t, s, this.rig), this.hudOn);
    } else this.render(this.t, vdt, this.rig);
    this.sound.frame(d, Math.min(this.t, d.n), this.playing && !this.timeline.scrubbing, this.speed);
    if (this.hudOn) this.hud.update(d, Math.min(this.t, d.n), this.deltaAt(Math.min(this.t, d.n)), this.speedDiffAt(Math.min(this.t, d.n)));
    // cl_showpos (hud/showpos.ts): the replay's state at the shown tick (the run's eye and view, not the camera's).
    const posMode = this.hudOn ? prefs.get().hud.showPos : 0;
    if (posMode) {
      const sp = sampleAt(d, Math.min(this.t, d.n), this.showPosSample ?? undefined);
      this.showPosSample = sp;
      this.showPos.update(posMode, { pos: sp.pos, viewZ: sp.viewZ, vel: sp.vel, pitch: sp.pitch, yaw: sp.yaw });
    } else this.showPos.update(0, null);
    this.timeline.setHead(this.t);
    this.timeline.render();
    this.gauntlet?.frame(d, this.t);
    const i = Math.floor(this.t);
    const total = d.n * d.interval;
    const clock = `${formatTime(this.t * d.interval)} / ${formatTime(total)}`;
    if (this.timeText.data !== clock) this.timeText.data = clock;
    const tick = `tick ${i}`;
    if (this.tickText.data !== tick) this.tickText.data = tick;
  }

  /**
   * This visit's frame times, with the game's names (input-debug.ts summary): percentiles over the last
   * InputStats.FRAMES frames, counts and the worst over the visit. Null before a replay has shown a frame.
   */
  frameSummary(): Record<string, number | string> | null {
    if (!this.statFrames) return null;
    return {
      frames: this.statFrames,
      fps: this.frameStats.rates(performance.now()).frameHz,
      ...frameNumbers(this.frameStats),
      look: prefs.get().graphics.preset,
      cam: this.rig.mode,
    };
  }

  /** One console line per visit, like the pre-simulation's on load. */
  private logFrames(): void {
    const s = this.frameSummary();
    if (s) console.info(`replay viewer: ${s.frames} frames, p50 ${s.frameP50} p99 ${s.frameP99} ms, >25 ms ${s.over25}, >50 ms ${s.over50} (worst ${s.worstFrame} ms), long tasks ${s.longTasks}`);
  }

  // -------------------------------------------------------------------------------------------
  // Export (viewer/export.ts drives render() frame by frame)

  get texturePacks() { return this.host.world.texturePacks; }

  get graphicsIdentity() { return { map: this.host.map, mapSha256: this.host.mapSha256 }; }

  get graphicsPipeline(): GraphicsPipeline { return this.host.graphicsPipeline; }

  get renderer(): THREE.WebGLRenderer {
    return this.host.renderer;
  }
  get camera(): THREE.PerspectiveCamera {
    return this.host.camera;
  }

  syncSim(t: number): void {
    this.player?.seek(t);
  }

  /** Auto-director shots for the whole replay (traced with the sim at tick 0, so they're the same every time). */
  private autoShots(): void {
    const d = this.data;
    if (!d) return;
    this.player!.seek(0);
    this.rig.setShots(directShots(d, 0, d.n, this.trace));
  }

  beginExport(): void {
    this.watchCount?.seek();
    this.exporting = true;
    // The in-eye arms start from a clean presentation too (clocks, feel, both gun viewmodels): arms.reset at the next
    // frame (ReplayArms.reset: Viewmodel.idle, GunPresenter.reset); animated finishes run on the replay's time.
    this.armsTick = -1;
    const replayTime = () => (Number.isFinite(this.lastRenderedTick) ? this.lastRenderedTick : 0) * (this.data?.interval ?? 0.01);
    setFinishClock(replayTime);
    setFinishEnvironmentClock(() => replayTime() * 1000);
    this.sound.stop();
    this.playing = false;
    this.updateControls();
    // Fresh player model / ghost for the render, so no animation state carries over from viewing (the exporter
    // seeds Math.random first, so their construction is deterministic too).
    this.model.root.visible = false;
    this.drawModel = new PlayerModel({ style: "solid", playerGlow: this.look.glow, outfit: this.look.outfit, loadout: this.look.loadout });
    this.drawModel.root.userData.h2hPrimary = true;
    this.playerShadow.bind(this.drawModel.root);
    this.drawModel.setNearFade(...CHASE_NEAR_FADE);
    this.drawModel.setGroundProbe(probeFromTrace((a, b) => this.trace(a, b, 0)));
    this.host.scene.add(this.drawModel.root);
    if (this.compare) {
      this.compare.ghost.setVisible(false);
      this.drawGhost = new Ghost(this.compare.ghost.d);
      this.drawGhost.setRenderOrder(30);
      this.drawGhost.trace = this.compare.ghost.trace;
      this.host.scene.add(this.drawGhost.root);
    }
    this.lastShown = -1;
    // Not a realtime frame: arms still compiling are drawn anyway (their programs link in the first export frame).
    this.armsTick = -1;
    this.armsLanded = 0;
    if (this.arms) {
      this.arms.ready = true;
      // Already in hand when the clip starts or cuts to an in-eye shot.
      this.arms.deployOnShow = false;
    }
  }

  /**
   * Before beginExport: the weapon in hand for the export (`weapon` for both views, undefined: the viewer's toggles).
   * In-eye it's the viewer's replay arms (viewer/arms.ts: the runner's knife, finish, gloves, glow and colourway, guns,
   * shots, inspects), their programs compiled and the CS:S knife animations loaded first so the look can't change
   * mid-render. Silent: the export mixes its own sound.
   */
  async prepareExport(o: { weapon?: boolean }): Promise<void> {
    this.exportWeapon = o.weapon === undefined ? { ...this.weapon } : { eye: o.weapon, third: o.weapon };
    if (!this.exportWeapon.eye) return;
    const loader = await import("../player/studio/loader");
    if (loader.hasViewmodelAnims()) await loader.loadViewmodelAnims().catch(() => null);
    this.ensureArms();
    await this.armsWarm;
  }

  /**
   * Export, once per output frame after the scene (all of a motion-blur frame's samples): animates the in-eye weapon to
   * display tick t and draws it over the frame in first-person shots, sharp.
   */
  drawViewmodel(t: number, dt: number, rig: CameraRig): void {
    const arms = this.arms;
    const d = this.data;
    if (!arms || !d || !this.player) return;
    this.armsFrame(arms, dt, sampleAt(d, t, this.sample), rig.firstPerson && this.weaponNow.eye, this.player.brushOrigins());
    arms.render(this.host.renderer, this.host.camera);
  }

  endExport(): void {
    this.exporting = false;
    setFinishClock(null);
    setFinishEnvironmentClock(null);
    this.exportWeapon = null;
    if (this.arms) this.arms.deployOnShow = true;
    if (this.drawModel !== this.model) {
      this.drawModel.root.removeFromParent();
      this.drawModel.dispose();
      this.drawModel = this.model;
      this.playerShadow.bind(this.model.root);
    }
    this.drawGhost?.dispose();
    this.drawGhost = null;
    this.armsTick = -1;
    this.host.resize();
    this.rig.snap();
    this.model.snap();
    this.lastNow = performance.now();
    this.statSkip = true;
    this.statFrom = this.lastNow;
  }

  async cardInfo(includeLeaderboard = false): Promise<CardInfo> {
    const r = this.replay!;
    const d = this.data!;
    const hd = r.header;
    const leaderboardPromise = includeLeaderboard && this.runId && API_URL && d.endTick
      ? fetchExportLeaderboard(API_URL, { runId: this.runId, map: hd.map, style: replayStyle(hd), track: d.runTrack || hd.track || 0, ticks: d.endTick - d.startTick })
      : Promise.resolve(null);
    let tier: number | null = null;
    try {
      const { fetchMapIndex } = await import("../menu");
      tier = (await fetchMapIndex()).find((m) => m.name === hd.map)?.tier ?? null;
      if (tier === null && api.available()) tier = (await api.mapDetail(hd.map)).tier ?? null;
    } catch {
      /* no tier */
    }
    const last = d.endTick || d.n;
    const c = this.compare;
    const fin = c && d.endTick ? this.deltaAt(d.endTick) : null;
    return {
      map: hd.map,
      tier,
      player: hd.player || "unknown",
      time: finalRunTime(d),
      style: styleLabel(replayStyle(hd)),
      track: trackName(d.runTrack || hd.track || 0),
      date: hd.recordedAt,
      jumps: d.jumps[last],
      strafes: d.strafes[last],
      sync: d.sync[last],
      maxSpeed: d.maxSpeed,
      leaderboard: await leaderboardPromise,
      compare: c ? `vs ${c.label}${fin !== null ? `  ${fin > 0 ? "+" : ""}${fin.toFixed(3)}` : ""}` : null,
    };
  }

  /** <map>_<style>_<time>_<player>.mp4 */
  fileName(): string {
    const r = this.replay!;
    const d = this.data!;
    const hd = r.header;
    const clean = (s: string) => s.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
    const track = d.runTrack || hd.track || 0;
    const time = d.endTick ? formatTime(finalRunTime(d)!).replace(":", "m").replace(".", "s") : "dnf";
    return `${clean(hd.map)}${track ? "_b" + track : ""}_${clean(replayStyle(hd))}_${time}_${clean(hd.player || "player")}.mp4`;
  }

  private openExport(): void {
    if (!this.data || this.exporting) return;
    this.setClean(false);
    this.playing = false;
    this.updateControls();
    // Head to head: both runs in the frame, side by side in 16:9 and stacked in 9:16 (the dialog's format).
    if (this.h2h) openExportDialog(this.h2hExportSource(), this.root, { format: this.h2h.layout === "stacked" ? "portrait" : "landscape" });
    else openExportDialog(this, this.root);
  }

  /** The exporter's source for head to head (viewer/h2h.ts draws both views, their HUDs and panels). */
  private h2hExportSource(): ExportSource {
    const v = this;
    const hh = this.h2h!;
    return {
      get data() { return v.data; },
      get renderer() { return v.renderer; },
      get graphicsPipeline() { return v.graphicsPipeline; },
      get texturePacks() { return v.texturePacks; },
      get graphicsIdentity() { return v.graphicsIdentity; },
      get camera() { return v.camera; },
      trace: this.trace,
      get compareLabel() { return v.compareLabel; },
      deltaAt: (t) => v.deltaAt(t),
      speedDiffAt: (t) => v.speedDiffAt(t),
      render: (t, dt, rig) => hh.exportRender(t, dt, rig, (tt, dd) => v.render(tt, dd, rig)),
      // No first-person weapon: it would be drawn over the whole frame, not one view.
      weaponFor: () => false,
      beginExport: () => (v.beginExport(), hh.beginExport()),
      syncSim: (t) => v.syncSim(t),
      endExport: () => (hh.endExport(), v.endExport()),
      cardInfo: (lb) => v.cardInfo(lb),
      fileName: () => {
        const clean = (x: string) => x.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
        return `${clean(v.host.map)}_${clean(hh.sides[0].name)}_vs_${clean(hh.sides[1].name)}.mp4`;
      },
      overlay: (g, w, hgt, t, o, branding) => hh.exportOverlay(g, w, hgt, t, o, branding),
      exportSpan: () => {
        const d = v.data!;
        return { n: hh.end, tickrate: d.tickrate, startTick: d.startTick, endTick: hh.lastFinish };
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Input

  private bindInput(): void {
    const stage = this.stage;
    // Free roam flies on your own movement binds, as freecam does.
    this.rig.free.intentOf = (keys) => freeIntentFromCodes(keys, prefs.get().binds);
    stage.addEventListener("mousedown", (e) => {
      if (this.rig.mode === "free") {
        if (document.pointerLockElement !== stage) void stage.requestPointerLock();
        return;
      }
      if (e.button === 0) this.dragging = true;
    });
    stage.addEventListener("dblclick", () => this.rig.chase.resetOrbit());
    addEventListener("mouseup", () => (this.dragging = false));
    addEventListener("mousemove", (e) => {
      if (!this.active) return;
      if (document.pointerLockElement === stage) {
        // Free roam turns like the game: your sensitivity, vertical sensitivity and invert (freecam.ts).
        const p = prefs.get();
        const pitchSens = p.verticalSensitivityEnabled ? p.verticalSensitivity : p.sensitivity;
        this.rig.free.lookDeg(e.movementX * p.sensitivity * p.mYaw, e.movementY * pitchSens * (p.invertY ? -p.mPitch : p.mPitch));
      }
      else if (this.dragging && this.rig.mode !== "eye") {
        if (this.rig.mode !== "chase") this.setCam("chase");
        this.rig.chase.orbit(e.movementX, e.movementY);
      }
    });
    stage.addEventListener(
      "wheel",
      (e) => {
        if (this.rig.mode === "chase") this.rig.chase.zoomBy(Math.exp(e.deltaY * 0.001));
        else if (this.rig.mode === "free" && document.pointerLockElement === stage && e.deltaY) this.rig.free.speed = freeSpeedStep(this.rig.free.speed, e.deltaY < 0 ? 1 : -1);
        e.preventDefault();
      },
      { passive: false },
    );
    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement !== stage) {
        this.rig.free.keys.clear();
        this.lockReleasedAt = performance.now();
      }
      this.updateControls();
    });
    // Capture phase: the viewer owns the keyboard while open (the live game's handlers never see these keys).
    addEventListener(
      "keydown",
      (e) => {
        if (!this.active || this.exporting) return;
        const tgt = e.target as HTMLElement | null;
        if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "SELECT" || tgt.tagName === "TEXTAREA")) return;
        if (document.querySelector(".rv-modal:not([hidden])")) return;
        // A dialog over the viewer (the report form) has the keyboard: Space and Esc are its own.
        if (document.querySelector("dialog[open]")) return;
        e.stopPropagation();
        const flying = document.pointerLockElement === stage;
        if (flying && e.code !== "Escape") {
          this.rig.free.keys.add(e.code);
          e.preventDefault();
          return;
        }
        if (this.handleKey(e)) e.preventDefault();
      },
      true,
    );
    addEventListener("keyup", (e) => this.rig.free.keys.delete(e.code), true);
  }

  private handleKey(e: KeyboardEvent): boolean {
    const d = this.data;
    const rate = d?.tickrate ?? 100;
    // Hide UI (F1 unless rebound) before the viewer's own keys: a bind the player picked wins.
    if (e.code !== "Escape" && isHideUiKey(e.code)) {
      if (!e.repeat) this.setClean(!this.clean);
      return true;
    }
    if (this.gauntlet?.key(e)) return true;
    switch (e.code) {
      case "Escape":
        // Flying with keyboard lock (fullscreen, Chromium) the page gets the Esc and the lock stays: release it first.
        if (document.pointerLockElement === this.stage) return document.exitPointerLock(), true;
        if (performance.now() - this.lockReleasedAt < 300) return true;
        if (this.clean) this.setClean(false);
        else if (this.closePops()) return true;
        else if (!this.helpEl.hidden) this.helpEl.hidden = true;
        else if (!this.compareMenu.hidden) this.compareMenu.hidden = true;
        else this.close();
        return true;
      case "Space":
      case "KeyK":
        this.togglePlay();
        return true;
      case "Comma":
        this.step(-1);
        return true;
      case "Period":
        this.step(1);
        return true;
      case "ArrowLeft":
        this.seekTo(this.t - (e.shiftKey ? 1 : 5) * rate, true);
        return true;
      case "ArrowRight":
        this.seekTo(this.t + (e.shiftKey ? 1 : 5) * rate, true);
        return true;
      case "Home":
        this.jumpStart();
        return true;
      case "End":
        this.jumpEnd();
        return true;
      case "BracketLeft":
        this.nudgeSpeed(-1);
        return true;
      case "BracketRight":
        this.nudgeSpeed(1);
        return true;
      case "KeyF":
        this.cycleCam();
        return true;
      case "KeyH":
        this.toggleHud();
        return true;
      case "KeyV":
        this.toggleWeapon();
        return true;
      case "KeyC":
        if (this.h2h) return false;
        this.setClean(false);
        this.toggleCompareMenu();
        return true;
      case "KeyE":
        this.openExport();
        return true;
      case "KeyP":
        if (this.h2h) return false;
        this.practiceFromHere();
        return true;
      case "KeyG":
        if (!this.h2h) return false;
        this.setH2HLayout(this.h2h.layout === "side" ? "stacked" : this.h2h.layout === "stacked" ? "ghost" : "side");
        return true;
      case "KeyX":
        if (!this.h2h) return false;
        this.swapH2H();
        return true;
      case "KeyS":
        if (!this.h2h) return false;
        this.toggleStats();
        return true;
      case "KeyJ":
        this.stepJump(e.shiftKey ? -1 : 1);
        return true;
      case "Slash":
        this.setClean(false);
        this.helpEl.hidden = !this.helpEl.hidden;
        return true;
    }
    const m = /^Digit([1-5])$/.exec(e.code);
    if (m) {
      this.setCam(CAM_MODES[Number(m[1]) - 1].id);
      return true;
    }
    return false;
  }
}

