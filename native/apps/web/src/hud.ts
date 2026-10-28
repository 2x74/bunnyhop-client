// In-game HUD (timer-plugin style). Every element (speed, timer, split, track, stage, stats, sync bar,
// keys overlay, ghost keys, speed graph, jump stats, map line, PB, FPS) is a positioned box whose
// visibility / anchor / offset / scale come from prefs.hud.layout and can be edited live (hud/editor.ts).
// Also: crosshair, the end-of-run card (with online submission status). The chat element is empty on the tutorial.
// Toasts and celebrations are notifications (notify/): the HUD tells them when a run is going so they hold back.
//
// Data flow: session.ts calls tick(cmd, state, events) once per simulated tick (live, replay and
// debug-scripted alike: exactly what the sim received) and update(frame) once per rendered frame.
// Per-frame work only writes text/class/transform when a value changed; positions are written
// once per layout change. Styles: hud/hud.css (+ crosshair / toast / end card in style.css).

import type { MapTimes } from "./map-time";
import "./hud/hud.css";
import { StrafeTrainer, trainerCommand, trainerZone, type TrainerZone } from "./hud/strafe-trainer";
import { StrafeTrainerView } from "./hud/strafe-trainer-view";
import { registerChatCommand } from "./chat-commands";
import type { Settings } from "./core";
import type { Submission } from "./api";
import { EVENT_JUMPED, EVENT_TELEPORTED, type PlayerState } from "./core";
import { HudEditor } from "./hud/editor";
import { SpeedGraph } from "./hud/graph";
import { JumpTracker } from "./hud/jumps";
import { SSJ_DEMO, SsjView } from "./ssj/view";
import type { SsjReport } from "./ssj/stats";
import type { MovementReading } from "./movement-stats";
import type { LjReport } from "./movement-stats/stats";
import { LjView, fjtNodes, offsetNodes, startPreNodes } from "./movement-stats/view";
import { KeysOverlay, PREVIEW_BITS } from "./hud/keys";
import { HUD_ELEMENTS, hudPoints, keepOnScreen, placeStyle, remFraction, type HudElId, type HudLayout } from "./hud/layout";
import { spectatorLines } from "./net/spectators";
import { EVENT_RESPAWNED, formatTime, type RunStatus, type TickCmd } from "./timer";
import { h } from "./ui/dom";
import { keyLabel, prefs, type Prefs } from "./ui/settings";
import { trackName } from "./zones";
import { clampTier, tierLabel, tierName } from "./tiers";
import { sfx } from "./audio";
import { nudge, setRunActive, toast as notifyToast } from "./notify";
import { spring, SPRINGS } from "./notify/spring";
import { uiHidden } from "./ui/hide-ui";
import { formatDelta, TimeFace } from "./hud/time-face";
import { ResultCard } from "./hud/result";
import type { UploadFailure } from "./uploads";
import { hudLine, type GauntletProgress } from "./gauntlet/state";
import { LIVE_VARS, liveVars, type LiveVar } from "./custom-css/live";

export { formatDelta } from "./hud/time-face";

/** The strafe trainer's per-jump tick: high for on pace, low for far off. */
const TRAINER_PITCH: Record<TrainerZone, number> = { good: 1.5, ok: 1.1, bad: 0.75 };
registerChatCommand(trainerCommand(() => prefs.get().hud.layout.strafeTrainer.on, (on) => prefs.update(p => { p.hud.layout.strafeTrainer.on = on; })));

export interface HudFrame {
  perf?: number | null;
  perfectHop?: boolean;
  speed: number;
  status: RunStatus;
  time: number;
  jumps: number;
  strafes: number;
  sync: number;
  pb: number | null;
  split: number | null;
  /** Leaderboard place the time would take ("#4 · top 3%", board-place.ts), beside the split; null: not shown. */
  place?: string | null;
  /** Player is inside the start zone. */
  inStart?: boolean;
  /** Map has a start/end zone pair (otherwise the timer can't run). */
  hasZones?: boolean;
  /** Track of the current run: 0 = main, N = bonus N. */
  track?: number;
  /** Split progress on staged / checkpointed tracks, e.g. "Stage 2/5" (null when the track has none). */
  stage?: string | null;
  /** Current tick of this track's PB ghost (drives the ghost keys overlay); null/undefined = no ghost shown. */
  ghostTick?: number | null;
}

/** Per-tick commands of a PB ghost's replay (index i = command that produced tick i + 1). */
export interface GhostInputs {
  buttons: ArrayLike<number>;
  yaw: ArrayLike<number>;
}

export interface RunResult {
  time: number;
  /** PB before this run (null = first finish). */
  previousPB: number | null;
  newPB: boolean;
  jumps: number;
  strafes: number;
  sync: number;
  /** Style name of the run ("W-Only"). */
  style?: string;
  /** Track label for bonus runs ("Bonus 1"); null/absent on the main track. */
  track?: string | null;
  /** No replay to watch (a practice mode finish): the card's hint line leaves out V. */
  noReplay?: boolean;
  /** The map's attempts and time played on this device (map-time.ts), this run included. */
  onMap?: MapTimes;
}

/** What the end-of-run card shows about online submission. Session/online code drives this. */
export type SubmissionView =
  | Submission
  | { status: "local" } // saved locally only (offline / API not configured)
  | { status: "submitting" }
  | { status: "error"; reason?: string }
  // The upload failed in a way a retry can fix; the run is kept on this device and sent again (uploads.ts).
  | { status: "unsent"; failure: UploadFailure };

/** Draws a CS-style crosshair into `el` (also used by the settings preview). */
export function renderCrosshair(el: HTMLElement, c: Prefs["crosshair"]): void {
  el.replaceChildren();
  el.className = el.className.replace(/\bxh-\S+/g, "").trim() + ` xh-${c.style}${c.outline ? " xh-outline" : ""}`;
  el.style.setProperty("--xh-color", c.color);
  el.style.setProperty("--xh-size", `${c.size}px`);
  el.style.setProperty("--xh-thick", `${c.thickness}px`);
  el.style.setProperty("--xh-gap", `${c.gap}px`);
  el.style.opacity = String(c.alpha);
  const parts: string[] = [];
  if (c.style === "cross" || c.style === "cross-dot") parts.push("t", "r", "b", "l");
  if (c.style === "t") parts.push("r", "b", "l");
  if (c.style === "dot" || c.style === "cross-dot") parts.push("dot");
  if (c.style === "circle") parts.push("ring", "dot");
  for (const p of parts) el.append(h(`i.xh-${p}`));
}

/** Sample values shown while editing the layout, so every element has content to grab. */
const DEMO: HudFrame = {
  speed: 412,
  status: "running",
  time: 23.456,
  jumps: 18,
  strafes: 36,
  sync: 88.4,
  pb: 25.012,
  split: -0.231,
  place: "#4 · top 3%",
  inStart: false,
  hasZones: true,
  track: 1,
  stage: "Stage 2/4",
};

const GHOST_COLOR = "#66b3ff";
/** The layout editor's sample for the movement elements. */
const LJ_DEMO: LjReport = { kind: "LJ", distance: 254.32, displacement: 222.32, pre: 278.1, max: 342.2, strafes: 6, sync: 91.4, airtime: 0.72, crouched: true };
const MOVEMENT_DEMO: MovementReading = { offset: { ticks: -1, gap: false, overlap: false }, fjt: 1, lj: LJ_DEMO };
/** The spectator list in the layout editor. */
const SPEC_DEMO = ["hopper", "strafegod"];
const text = () => document.createTextNode("");

/** What the ammo readout shows (GunPresenter.ammo()). */
export interface AmmoState {
  clip: number;
  size: number;
  reloading: boolean;
}

/** A clip this low tints the readout: the last fifth (at least the last round). */
export const lowClip = (size: number) => Math.max(1, Math.ceil(size * 0.2));

/** The small round beside the clip count: our own shape (a rounded tip, a straight case, a rim), in the text colour. */
function ammoGlyph(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 10 26");
  svg.setAttribute("class", "ammo-glyph");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M2 11C2 6 3.6 2.4 5 1c1.4 1.4 3 5 3 10v10H2ZM1.2 22.4h7.6V25H1.2Z");
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

/** Speeds that pulse the speed readout once per attempt when first crossed (u/s). */
const MILESTONE_STEP = 100;
const MILESTONE_FROM = 300;
/** A jump's gain below this (u/s) shows no tick. */
const GAIN_MIN = 3;
/** How long a split's delta stays up bright before the live ghost delta takes the element back (ms). */
const SPLIT_HOLD_MS = 1500;
/** Edge glow (Settings → HUD, off by default; never on potato): from this speed, in this many steps. */
const GLOW_FROM = 600;
const GLOW_STEP = 150;
const GLOW_STEPS = 6;

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class Hud {
  private root: HTMLElement;
  /** One positioned box per layout element. */
  readonly els = {} as Record<HudElId, HTMLElement>;
  private speedEl: HTMLElement;
  private speedNum = text();
  /** "+14" floating off the speed on each jump (one reused element; restarted, never stacked). */
  private gainEl = h("i.gain-tick", { "aria-hidden": "true" });
  private timerEl: HTMLElement;
  private timeFace = new TimeFace();
  /** "Practice" under the crosshair while this attempt won't count (layout element "practice"; setPractice). */
  private practiceText = text();
  private practiceLabel: string | null = null;
  /** This attempt is practice: the timer (and a practice finish) is yellow. */
  private practiceOn = false;
  /** The start zone's green line under the timer; it wipes out as the run starts (ignite). */
  private zoneLine = h("i.zone-line", { "aria-hidden": "true" });
  private splitText = text();
  private splitEl!: HTMLElement;
  /** The leaderboard place beside the split (Settings → HUD → Leaderboard place). */
  private placeText = text();
  private trackText = text();
  private stageText = text();
  private stageEl!: HTMLElement;
  private statJumps = text();
  private statStrafes = text();
  private statSync = text();
  private trainer = new StrafeTrainer();
  private trainerView = new StrafeTrainerView();
  private syncFill: HTMLElement;
  private syncText = text();
  private perfText = text();
  private perfEl = h("span.sync-label.hud-perf", null, this.perfText);
  private statPerf = h("span.hud-perf");
  private mapLine: HTMLElement;
  private pbText = text();
  private pbVal = h("b.pb-val", null, this.pbText);
  private fpsText = text();
  /** The end of a run: the timer becomes the result (hud/result.ts). */
  private card = new ResultCard();
  private xhair: HTMLElement;
  /** Container of the movable chat element (layout id "chat"); net/ui/chat.ts renders into it. */
  chatEl!: HTMLElement;
  private keys = new KeysOverlay();
  private ghostKeys = new KeysOverlay("GHOST");
  private graph = new SpeedGraph();
  private jumps = new JumpTracker();
  /** Jump stats (!ssj): the last reported jump (ssj/view.ts), fed by session.ts. */
  private ssjView = new SsjView();
  private ssjLast: SsjReport | null = null;
  private startPre: number | null = null;
  private startPreEl = h("div.mv-pre");
  private movement: MovementReading = { offset: null, fjt: null, lj: null };
  private offsetEl = h("div.mv-line");
  private fjtEl = h("div.mv-line");
  private ljView = new LjView();
  /** What the movement elements last drew (skip unchanged writes). */
  private movementShown = { offset: "", fjt: "", pre: "" };
  private editor: HudEditor;
  private editing = false;
  /** Last run state given to notify's run gate. */
  private runActive = false;
  private lastSpeed = 0;
  private lastT = performance.now();
  private accel = 0;
  private speedClass = "";
  private frames = 0;
  private fpsT = performance.now();
  private p: Prefs;
  /** Last values written to the DOM (skip unchanged writes). */
  private shown = Hud.blank();
  /** Custom CSS's live numbers (custom-css/live.ts) as last written on #hud and #custom-art. */
  private live: Record<LiveVar, string> = { speed: "", sync: "", jumps: "", strafes: "" };
  private liveVersion = 0;
  private liveEls: HTMLElement[] = [];
  private static blank() {
    return { speed: "", state: "", time: "", split: "?", place: "?", splitEmpty: null as boolean | null, stats: "?", pb: "", track: "?", stage: "?", sync: -1, ghost: null as boolean | null, perf: "?" };
  }
  private ghostIn = new Map<number, GhostInputs>();
  private ghostAt = -1;
  private ghostTrack = -1;
  // --- run feedback (all event-driven: a write on a jump, a split, a milestone, a sign change; never per frame)
  /** A jump's gain waiting for the next rendered frame (ticks run inside the sim loop; the DOM is touched per frame). */
  private pendingGain: number | null = null;
  /** Highest speed milestone pulsed this attempt (u/s). */
  private milestone = 0;
  /** A split's delta holds the split element until then (performance.now()). */
  private splitHold = 0;
  /** Sign of the live ghost delta last shown (-1 ahead, 1 behind, 0 none). */
  private ghostSign = 0;
  /** World record of the current board (session.ts), for the provisional WR at the finish. */
  private wr: number | null = null;
  /** The PB readout is mid-swap (pbLedger): update() leaves it alone until then. */
  private pbLocked = 0;
  private ledgerTimers: number[] = [];
  /** Spectating someone (net/mp.ts): their speed and timer replace yours. */
  private spectated: { speed: number; status: RunStatus; time: number; inStart: boolean } | null = null;
  /** Gauntlet mode (gauntlet/mode.ts): the one line under the timer (total so far, live delta to your PB's split). */
  private gauntlet: GauntletProgress | null = null;
  private gauntletText = text();
  private gauntletDelta = h("span.hud-g-delta");
  private gauntletEl = h("div.hud-gauntlet", null, this.gauntletText, this.gauntletDelta);
  private gauntletShown = "";
  /** Edge glow (P12): its element and the bucket last written. */
  private glowEl: HTMLElement | null = null;
  private glowStep = -1;
  /** fit()'s keep-on-screen shift per element (CSS px). */
  private shift = new Map<HTMLElement, { dx: number; dy: number }>();

  constructor() {
    this.root = document.getElementById("hud")!;
    this.root.replaceChildren();
    this.xhair = h("div#crosshair");
    this.speedEl = h("div.hud-speed", null, h("span.speed-num", null, this.speedNum), h("span.unit", null, "u/s"), this.gainEl);
    this.timerEl = h("div.hud-timer", null, this.timeFace.el, this.zoneLine);
    this.syncFill = h("i.sync-fill");
    this.mapLine = h("div.hud-map");
    const content: Record<HudElId, HTMLElement> = {
      speed: this.speedEl,
      timer: this.timerEl,
      split: (this.splitEl = h("div.hud-split", null, h("span.split-delta", null, this.splitText), h("span.split-place", null, this.placeText))),
      track: h("div.hud-track", null, this.trackText),
      stage: (this.stageEl = h("div.hud-stage", null, h("span.stage-text", null, this.stageText))),
      stats: h(
        "div.hud-stats",
        null,
        h("span", null, h("b", null, this.statJumps), " jumps"),
        h("span", null, h("b", null, this.statStrafes), " strafes"),
        h("span", null, h("b", null, this.statSync), " sync"),
        this.statPerf,
      ),
      sync: h("div.hud-sync", null, h("div.sync-readouts", null, h("span.sync-label", null, "sync ", h("b", null, this.syncText)), this.perfEl), h("span.sync-bar", null, this.syncFill)),
      keys: this.keys.el,
      ghostKeys: this.ghostKeys.el,
      graph: this.graph.el,
      jumpStats: this.ssjView.el,
      startPre: this.startPreEl,
      strafeOffsets: this.offsetEl,
      firstJump: this.fjtEl,
      longJump: this.ljView.el,
      map: this.mapLine,
      pb: h("div.hud-pb", null, h("small", null, "PB"), this.pbVal),
      fps: h("div.hud-fps", null, this.fpsText, " fps"),
      // Chat (net/hud.ts ChatBox: net/mp.ts in a room, solo-chat.ts in solo play); demo lines only in the layout editor.
      chat: (this.chatEl = h(
        "div.hud-chat",
        null,
        h("div.chat-demo", { "aria-hidden": "true" }, h("div.chat-line", null, h("b", null, "hopper"), ": gg that last stage"), h("div.chat-line.server", null, "Next map: bhop_eazy")),
      )),
      ammo: this.ammoEl,
      strafeTrainer: this.trainerView.el,
      spectators: this.specEl,
      practice: h("div.hud-practice", null, this.practiceText),
    };
    const boxes: HTMLElement[] = [];
    for (const { id, label } of HUD_ELEMENTS) {
      const box = h("div.hud-el", { "data-el": id, "data-label": label }, content[id], h("i.hud-handle", { title: "Drag to resize" }));
      this.els[id] = box;
      boxes.push(box);
    }
    this.root.append(this.xhair, ...boxes, this.card.el);
    this.card.onRecord = (t) => (this.wr = t);
    this.els.chat.classList.add("empty"); // shown by the chat (net/mp.ts, solo-chat.ts)
    this.els.ammo.classList.add("empty"); // shown while a gun is out (setAmmo)
    this.els.spectators.classList.add("empty"); // shown while someone watches (setSpectators, net/mp.ts)
    this.els.practice.classList.add("empty"); // shown while the attempt is practice (setPractice, session.ts)
    this.jumps.onJump = (n, _speed, gain) => {
      this.graph.mark(gain, n === 1);
      if (n > 1) this.pendingGain = gain;
    };
    this.editor = new HudEditor({
      root: this.root,
      els: this.els,
      preview: (id, place) => this.placeAll({ ...this.p.hud.layout, [id]: place }),
      setEditing: (on) => this.setEditing(on),
    });
    this.p = prefs.get();
    prefs.watch((p) => this.applyPrefs(p));
    // Keep-on-screen (fit): an element's size changes with the viewport (rem), the HUD scale, its content, and from
    // nothing when the HUD first shows.
    const fitWatch = new ResizeObserver(() => this.fit());
    for (const box of boxes) fitWatch.observe(box);
    // The centre column's pivots depend on the window's shape (remFraction); positions are re-placed on resize.
    addEventListener("resize", () => this.placeAll(this.p.hud.layout));
  }

  // -------------------------------------------------------------------------------------------
  // Prefs / layout

  /**
   * Positions every element for `layout` at the HUD scale (hud/layout.ts hudPoints: the gaps grow with the scale too),
   * then keeps them on screen (fit). Layout changes only, never per frame.
   */
  private placeAll(layout: HudLayout): void {
    const at = hudPoints(layout, this.p.hud.scale, remFraction(innerWidth, innerHeight));
    for (const { id } of HUD_ELEMENTS) {
      const el = this.els[id];
      const p = layout[id];
      const st = placeStyle(p, at[id]);
      el.style.left = st.left;
      el.style.top = st.top;
      el.style.translate = st.translate;
      el.style.setProperty("--s", String(p.s));
    }
    this.fit();
  }

  /**
   * Moves any element that a big HUD scale or element size pushed past the screen's edge back onto it (margins, so the
   * stored layout is untouched). On layout changes, on resize, and when an element's size changes (fitWatch): reads
   * every box first, then writes.
   */
  private fit(): void {
    const vw = innerWidth;
    const vh = innerHeight;
    const moves: [HTMLElement, { dx: number; dy: number }][] = [];
    for (const { id } of HUD_ELEMENTS) {
      const el = this.els[id];
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue; // not shown (off, or no HUD on screen)
      const old = this.shift.get(el) ?? { dx: 0, dy: 0 };
      const n = keepOnScreen({ left: r.left - old.dx, top: r.top - old.dy, width: r.width, height: r.height }, vw, vh, 2);
      if (n.dx !== old.dx || n.dy !== old.dy) moves.push([el, n]);
    }
    for (const [el, n] of moves) {
      this.shift.set(el, n);
      el.style.marginLeft = n.dx ? `${n.dx}px` : "";
      el.style.marginTop = n.dy ? `${n.dy}px` : "";
    }
  }

  private applyPrefs(p: Prefs): void {
    this.p = p;
    const r = this.root;
    r.style.setProperty("--hud-scale", String(p.hud.scale));
    for (const { id } of HUD_ELEMENTS) this.els[id].classList.toggle("off", !p.hud.layout[id].on);
    this.placeAll(p.hud.layout);
    this.graph.visible = p.hud.layout.graph.on;
    this.trainerView.configure(p.hud.strafeTrainer);
    this.trainer.smoothing = p.hud.strafeTrainer.smoothing;
    this.trainer.zone = p.hud.strafeTrainer.zone;
    this.keys.configure(p.hud.keys);
    this.ghostKeys.configure({ ...p.hud.keys, pressed: GHOST_COLOR });
    renderCrosshair(this.xhair, p.crosshair);
    this.drawSsj(); // (fields may have changed)
    this.shown = Hud.blank();
    this.timeFace.set("");
    this.speedClass = "?";
    this.glowStep = -1;
    this.placeGauntlet();
    if (!this.glowOn() && this.glowEl) {
      this.glowEl.remove();
      this.glowEl = null;
    }
  }

  private setEditing(on: boolean): void {
    this.editing = on;
    if (on) {
      this.graph.demo();
      this.keys.preview(PREVIEW_BITS);
      this.ghostKeys.preview(PREVIEW_BITS);
    } else this.resetTicks();
    this.drawAmmo();
    this.drawSpecs();
    this.drawPractice();
    this.applyPrefs(this.p);
  }

  /** Jump stats: a reported jump (ssj/index.ts LiveSsj via session.ts). Shown until the next one. */
  setJumpStats(r: SsjReport | null): void {
    this.ssjLast = r;
    this.drawSsj();
  }

  setStartPre(speed: number | null): void {
    this.startPre = speed;
    this.drawSsj();
  }

  setMovementStats(reading: MovementReading): void {
    this.movement = { ...reading };
    this.drawMovement();
  }

  private drawMovement(): void {
    const r = this.editing ? MOVEMENT_DEMO : this.movement;
    const offset = r.offset ? JSON.stringify(r.offset) : "";
    if (offset !== this.movementShown.offset) {
      this.movementShown.offset = offset;
      this.offsetEl.replaceChildren(...(r.offset ? offsetNodes(r.offset) : []));
    }
    const fjt = r.fjt === null ? "" : String(r.fjt);
    if (fjt !== this.movementShown.fjt) {
      this.movementShown.fjt = fjt;
      this.fjtEl.replaceChildren(...(r.fjt === null ? [] : fjtNodes(r.fjt)));
    }
    this.els.strafeOffsets.classList.toggle("empty", !offset);
    this.els.firstJump.classList.toggle("empty", !fjt);
    const lj = this.ljView.show(r.lj && (this.editing || this.p.hud.movement.lj) ? r.lj : null, this.editing);
    this.els.longJump.classList.toggle("empty", !lj);
  }

  private drawSsj(): void {
    this.drawMovement();
    const speed = this.editing ? 276 : this.startPre;
    const pre = speed === null ? "" : String(speed);
    if (pre !== this.movementShown.pre) {
      this.movementShown.pre = pre;
      this.startPreEl.replaceChildren(...(speed === null ? [] : startPreNodes(speed)));
    }
    this.els.startPre.classList.toggle("empty", speed === null);
    const has = this.ssjView.show(this.editing ? SSJ_DEMO : this.ssjLast, this.p.hud.ssj.fields);
    this.els.jumpStats.classList.toggle("empty", !has);
  }

  /** Opens / closes the layout editor (also bound to the hudEditor key, default F2). */
  toggleEditor(): void {
    this.editor.toggle();
  }

  setInfo(map: string, style: string, tickrate: number): void {
    if (this.info?.map !== map || this.info?.style !== style) this.setStartPre(null);
    this.info = { map, style, tickrate };
    this.drawMapLine();
    this.graph.setTickRate(tickrate);
  }

  // --- ammo: the clip in big HUD digits with a small round beside it, CS:S's corner readout in our own type. No
  // reserve (it's infinite: research/WEAPONS.md), no weapon name. Low clip tints it, empty turns it red, a reload dims
  // it (a shotgun's count climbs shell by shell while dim). Hidden with the knife; the layout editor shows a sample.
  private ammoNum = text();
  private ammoEl = h("div.hud-ammo", null, h("span.ammo-num", null, this.ammoNum), ammoGlyph());
  private ammo: AmmoState | null = null;

  /** The gun's clip (null: the knife or no weapon, the readout hides). Call on change; cheap when unchanged. */
  setAmmo(a: AmmoState | null): void {
    const o = this.ammo;
    if (o === a || (o && a && o.clip === a.clip && o.size === a.size && o.reloading === a.reloading)) return;
    this.ammo = a ? { ...a } : null;
    this.drawAmmo();
  }

  private drawAmmo(): void {
    const a = this.ammo ?? (this.editing ? { clip: 30, size: 30, reloading: false } : null);
    this.els.ammo.classList.toggle("empty", !a);
    if (!a) return;
    const clip = Math.max(0, a.clip);
    this.ammoNum.data = String(clip);
    const el = this.ammoEl.classList;
    el.toggle("reloading", a.reloading);
    el.toggle("out", !a.reloading && clip === 0);
    el.toggle("low", !a.reloading && clip > 0 && clip <= lowClip(a.size));
  }

  // --- spectators: who is watching you in a room (or, while you spectate, who else watches them), plain white lines on
  // the left like a CS:S server's spectator list (net/spectators.ts). Hidden when nobody is; a sample while editing.
  private specEl = h("div.hud-specs");
  private specNames: readonly string[] = [];
  private specShown = "";

  /** Names watching (net/mp.ts, 5 Hz); empty hides the list. Cheap when unchanged. */
  setSpectators(names: readonly string[]): void {
    this.specNames = names;
    this.drawSpecs();
  }

  private drawSpecs(): void {
    const lines = spectatorLines(this.editing && !this.specNames.length ? SPEC_DEMO : this.specNames);
    const key = lines.join("\n");
    if (key === this.specShown) return;
    this.specShown = key;
    this.specEl.replaceChildren(...lines.map((t, i) => h(i ? "div.spec-name" : "div.spec-head", null, t)));
    this.els.spectators.classList.toggle("empty", !lines.length);
  }

  /**
   * This attempt is practice ("Practice", "Practice · noclip"; session.ts, every frame): the line under the crosshair
   * and the yellow timer. Null: a run that counts. Cheap when unchanged.
   */
  setPractice(label: string | null): void {
    if (label === this.practiceLabel) return;
    this.practiceLabel = label;
    this.practiceOn = !!label;
    this.timerEl.classList.toggle("practice", this.practiceOn);
    this.drawPractice();
  }

  private drawPractice(): void {
    const label = this.practiceLabel ?? (this.editing ? "Practice" : null);
    this.practiceText.data = label ?? "";
    this.els.practice.classList.toggle("empty", !label);
  }

  /** Debug hook opted in outside dev (session.ts): a small corner badge, runs are practice only. */
  showDebugBadge(): void {
    if (this.root.querySelector("#hud-debug")) return;
    this.root.append(h("div#hud-debug", { title: "Debug mode: runs are practice only (not submitted or saved as PBs)" }, "debug"));
  }

  // --- tiers: "bhop_badges · T5 · Normal · 100 tick" (map line)
  private info: { map: string; style: string; tickrate: number } | null = null;
  /** Map tier (clamped 1..6, null = unrated "T?"); undefined until known. */
  private tier: number | null | undefined = undefined;

  setTier(tier: number | null): void {
    this.tier = clampTier(tier);
    this.drawMapLine();
  }

  private drawMapLine(): void {
    const i = this.info;
    if (!i) return;
    const tier = this.tier !== undefined ? [h("span", null, " · "), h(`span.hud-tier${this.tier ? `.t${this.tier}` : ""}`, { title: tierName(this.tier) }, tierLabel(this.tier))] : [];
    this.mapLine.replaceChildren(h("b", null, i.map), ...tier, h("span", null, ` · ${i.style} · ${i.tickrate} tick`));
  }

  /** The world record of the board being run (seconds; null: none known). A finish under it shows as a provisional WR. */
  setWorldRecord(time: number | null): void {
    this.wr = time;
  }

  /** A finish in `time` would beat the world record we know of. */
  beatsRecord(time: number): boolean {
    return this.wr !== null && time < this.wr;
  }

  // -------------------------------------------------------------------------------------------
  // Per-tick feed (the API session.ts uses)

  /**
   * One simulated tick: `cmd` is exactly what core.step received, `state` the post-tick state.
   * Drives the keys overlay, speed graph (jump marks) and sync bar; the jump stats element is fed by session.ts (setJumpStats).
   */
  tick(cmd: TickCmd, state: PlayerState, events: number, trainer?: { settings: Settings; style: string; noclip?: boolean }): void {
    if (this.editing) return;
    const v = state.velocity;
    const speed = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    if (trainer && this.p.hud.layout.strafeTrainer.on) this.trainer.feed(cmd, {
      speed, grounded: state.grounded, onLadder: state.onLadder, tick: state.tick,
      dt: trainer.settings.tickInterval, maxSpeed: trainer.settings.maxSpeed, airAccelerate: trainer.settings.airAccelerate,
      style: trainer.style, interrupted: !!trainer.noclip || !!(events & (EVENT_TELEPORTED | EVENT_RESPAWNED)), jumped: (events & EVENT_JUMPED) !== 0,
    });
    else this.trainer.reset();
    const jump = this.trainer.takeLanding();
    if (jump !== null && this.p.hud.strafeTrainer.sound) sfx("count_tick", 1.6, TRAINER_PITCH[trainerZone(jump, this.p.hud.strafeTrainer.zone)]);
    this.keys.feed(cmd.buttons, cmd.yaw);
    this.graph.push(speed);
    this.jumps.feed(cmd.side, cmd.yaw, speed, state.grounded, (events & EVENT_JUMPED) !== 0);
  }

  /** Forget per-tick history (restart, replay seek, watch start/exit). */
  resetTicks(): void {
    this.keys.reset();
    this.ghostKeys.reset();
    this.graph.reset();
    this.jumps.reset();
    this.trainer.reset();
    this.ghostAt = -1;
    // The speed's gain/loss smoothing must not run across a teleport (a restart showed a red "0").
    this.accel = 0;
    this.lastSpeed = 0;
    this.lastT = performance.now();
    this.pendingGain = null;
    this.milestone = 0;
    this.splitHold = 0;
    this.ghostSign = 0;
  }

  /**
   * A restart (session.ts onReset after a run had time on the clock): the digits roll back to zero and the speed drops
   * to its idle look. One short transform, no blur.
   */
  restarted(): void {
    if (this.editing || this.spectated || reducedMotion()) return;
    const t = this.timeFace.el;
    t.getAnimations().forEach((a) => a.cancel());
    t.animate({ transform: ["translateY(-0.55em)", "translateY(0.12em)", "none"], opacity: [0.2, 1, 1], offset: [0, 0.7, 1] }, { duration: 160, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" });
    sfx("teleport", 0.18, 1.25);
  }

  /** Leaving the start zone: the timer kicks (a quick horizontal squash back to size) and the zone line wipes out. */
  private ignite(): void {
    if (reducedMotion()) return;
    this.timeFace.el.animate({ transform: ["scaleX(1.15)", "none"] }, { duration: 160, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" });
    this.zoneLine.animate({ transform: ["scaleX(1)", "scaleX(2.4)"], opacity: [1, 0] }, { duration: 320, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
  }

  /** Commands of the PB ghost for `track` (null removes it). */
  setGhostInputs(track: number, inputs: GhostInputs | null): void {
    if (inputs) this.ghostIn.set(track, inputs);
    else this.ghostIn.delete(track);
    this.ghostAt = -1;
  }

  private feedGhost(track: number, tick: number | null | undefined): boolean {
    const g = tick === null || tick === undefined ? undefined : this.ghostIn.get(track);
    if (!g || tick === null || tick === undefined) return false;
    const n = g.buttons.length;
    if (track !== this.ghostTrack || this.ghostAt < 0 || tick < this.ghostAt || tick - this.ghostAt > 64) {
      const i = Math.min(n - 1, tick - 1);
      this.ghostKeys.reset(i >= 0 ? g.buttons[i] : 0, i >= 0 ? g.yaw[i] : NaN);
      this.ghostTrack = track;
      this.ghostAt = tick;
    }
    for (let t = this.ghostAt + 1; t <= tick; t++) if (t - 1 < n) this.ghostKeys.feed(g.buttons[t - 1], g.yaw[t - 1]);
    this.ghostAt = tick;
    return true;
  }

  /**
   * Spectating (net/mp.ts, per rendered frame): the watched player's speed and timer show in your HUD in place of
   * yours; null gives them back. Your own run's other readouts hide meanwhile (net.css body.mp-spectating).
   */
  setSpectated(v: { speed: number; status: RunStatus; time: number; inStart: boolean } | null): void {
    this.spectated = v;
  }

  // -------------------------------------------------------------------------------------------
  // Per-frame update

  update(frame: HudFrame): void {
    const sp0 = this.spectated;
    const f = this.editing ? { ...DEMO, place: this.p.hud.place === "place" ? "#4" : this.p.hud.place === "top" ? DEMO.place : null } : sp0 ? { ...frame, speed: sp0.speed, status: sp0.status, time: sp0.time, inStart: sp0.inStart, split: null, place: null, stage: null } : frame;
    const s = this.shown;
    const now = performance.now();

    // Speed + gain/loss color (smoothed rate of change so it doesn't flicker).
    const dt = Math.max(1, now - this.lastT) / 1000;
    this.lastT = now;
    this.accel = this.accel * 0.75 + ((f.speed - this.lastSpeed) / dt) * 0.25;
    this.lastSpeed = f.speed;
    const sc = !this.p.hud.speedColors || this.editing ? "" : this.accel > 15 ? "gain" : this.accel < -15 ? "loss" : "";
    if (sc !== this.speedClass) {
      this.speedClass = sc;
      this.speedEl.className = `hud-speed ${sc}`;
    }
    const sp = String(Math.round(f.speed));
    if (sp !== s.speed) this.speedNum.data = s.speed = sp;
    // A jump's gain floats off the number; crossing 300 / 400 / 500 ... in a run pulses it once.
    if (this.pendingGain !== null) {
      this.gainTick(this.pendingGain);
      this.pendingGain = null;
    }
    if (f.status === "running" && !this.editing) {
      const m = Math.floor(f.speed / MILESTONE_STEP) * MILESTONE_STEP;
      if (m >= MILESTONE_FROM && m > this.milestone) {
        this.milestone = m;
        this.pulseSpeed();
      }
    }
    this.edgeGlow(f.speed);

    // Tick-driven widgets (each touches the DOM only if it changed).
    this.keys.render();
    const ghost = this.editing || (this.p.showGhost && this.feedGhost(frame.track ?? 0, frame.ghostTick));
    if (ghost !== s.ghost) this.els.ghostKeys.classList.toggle("empty", !(s.ghost = ghost));
    if (ghost) this.ghostKeys.render();
    this.graph.render();
    this.trainerView.render(this.editing ? { cue: "good", pace: 100, side: 0 } : this.trainer.reading);
    const sync = Math.round(this.editing ? 87 : this.jumps.sync);
    if (sync !== s.sync) {
      s.sync = sync;
      this.syncText.data = `${sync}%`;
      this.syncFill.style.transform = `scaleX(${sync / 100})`;
      this.syncFill.className = `sync-fill ${sync >= 85 ? "good" : sync >= 65 ? "ok" : "bad"}`;
    }

    // FPS (updated twice a second).
    this.frames++;
    if (now - this.fpsT > 500) {
      this.fpsText.data = String(Math.round((this.frames * 1000) / (now - this.fpsT)));
      this.frames = 0;
      this.fpsT = now;
    }

    if (frame.status !== "finished" && this.card.shown) this.hideCard();
    // Notifications hold celebrations while a run is going (on change only: nothing per frame).
    const running = frame.status === "running";
    if (running !== this.runActive) setRunActive((this.runActive = running));

    // Timer / start-zone state. In the start zone: a dim zero over a zone-green line (no pill).
    let state: string = f.status;
    if (f.status === "idle") state = f.hasZones === false ? "nozones" : f.inStart ? "start" : "idle";
    if (state !== s.state) {
      if (s.state === "start" && state === "running" && !this.editing && !this.spectated) this.ignite();
      this.timerEl.className = `hud-timer ${(s.state = state)}${this.practiceOn ? " practice" : ""}`;
    }
    const time = state === "nozones" ? "No zones on this map" : formatTime(f.status === "idle" ? 0 : f.time);
    if (time !== s.time) this.timeFace.set((s.time = time));

    // Split: the live ghost delta, except for a moment after a stage, when it holds that stage's delta (split()).
    if (now >= this.splitHold) {
      if (this.splitHold) {
        this.splitHold = 0;
        this.splitEl.classList.remove("hold");
      }
      const split = f.split === null ? "" : formatDelta(f.split);
      if (split !== s.split) {
        this.splitText.data = s.split = split;
        this.splitEl.className = `hud-split ${f.split === null ? "" : f.split <= 0 ? "ahead" : "behind"}`;
      }
      // Ahead turns to behind (or back): one nudge, on the change only.
      const sign = f.split === null || f.status !== "running" ? 0 : f.split <= 0 ? -1 : 1;
      if (sign && this.ghostSign && sign !== this.ghostSign && !reducedMotion()) nudge(this.splitEl);
      this.ghostSign = sign;
    }
    // The leaderboard place beside it (its own colour: it isn't ahead or behind anything).
    const place = f.place ?? "";
    if (place !== s.place) this.placeText.data = s.place = place;
    const splitEmpty = !s.split && !place;
    if (splitEmpty !== s.splitEmpty) this.els.split.classList.toggle("empty", (s.splitEmpty = splitEmpty));

    const track = f.track ? trackName(f.track) : "";
    if (track !== s.track) {
      this.trackText.data = s.track = track;
      this.els.track.classList.toggle("empty", !track);
    }
    const stage = f.stage && f.status !== "idle" ? f.stage : "";
    if (stage !== s.stage) {
      const old = s.stage;
      this.stageText.data = s.stage = stage;
      this.els.stage.classList.toggle("empty", !stage);
      // "Stage 2/5" -> "Stage 3/5" during a run ticks over like an odometer.
      if (old && old !== "?" && stage && f.status === "running" && !this.editing) this.odometer(old);
    }

    const audio = prefs.get().audio;
    const perfHidden = f.perf === undefined || (!audio.perfHud && !audio.perfectIndicator);
    const perfOn = audio.perfHud ? `perf ${f.perf == null ? "—" : `${f.perf.toFixed(1)}%`}` : "";
    const perfect = audio.perfectIndicator && f.perfectHop ? "Perfect" : "";
    const perf = `${perfHidden ? 1 : 0}${this.p.hud.layout.sync.on ? 1 : 0}|${perfOn && perfect ? `${perfOn}  ${perfect}` : perfOn || perfect}`;
    if (perf !== s.perf) {
      s.perf = perf;
      this.perfEl.hidden = perfHidden;
      this.perfText.data = perf.slice(3);
      this.statPerf.hidden = this.p.hud.layout.sync.on || perfHidden;
      this.statPerf.textContent = this.perfText.data;
    }
    const stats = f.status === "idle" ? "" : `${f.jumps}|${f.strafes}|${f.sync.toFixed(1)}`;
    if (stats !== s.stats) {
      s.stats = stats;
      this.els.stats.classList.toggle("empty", !stats);
      if (stats) {
        this.statJumps.data = String(f.jumps);
        this.statStrafes.data = String(f.strafes);
        this.statSync.data = `${f.sync.toFixed(1)}%`;
      }
    }
    const pb = f.pb === null ? "—" : formatTime(f.pb);
    if (pb !== s.pb && now >= this.pbLocked) this.pbText.data = s.pb = pb;
    if (liveVars.on || liveVars.version !== this.liveVersion) this.writeLive({ speed: sp, sync: String(Math.round(f.sync)), jumps: String(f.jumps), strafes: String(f.strafes) });

    if (this.gauntlet && !this.editing) {
      const line = hudLine(this.gauntlet, { running: f.status === "running" && (f.track ?? 0) === 0, time: f.time });
      const d = line.delta === null ? "" : formatDelta(line.delta);
      const key = `${line.text}|${d}`;
      if (key !== this.gauntletShown) {
        this.gauntletShown = key;
        this.gauntletText.data = line.text;
        this.gauntletDelta.textContent = d;
        this.gauntletDelta.className = `hud-g-delta${line.delta === null ? "" : line.delta <= 0 ? " ahead" : " behind"}`;
      }
    }
  }

  /** Custom CSS's live numbers: only those its CSS mentions, only when they change. */
  private writeLive(v: Record<LiveVar, string>): void {
    if (liveVars.version !== this.liveVersion) {
      this.liveVersion = liveVars.version;
      this.liveEls = [this.root, document.getElementById("custom-art")].filter((e): e is HTMLElement => !!e);
      for (const el of this.liveEls) for (const k of LIVE_VARS) if (!liveVars[k]) el.style.removeProperty(`--hud-${k}`);
      this.live = { speed: "", sync: "", jumps: "", strafes: "" };
    }
    for (const k of LIVE_VARS) {
      if (!liveVars[k] || v[k] === this.live[k]) continue;
      this.live[k] = v[k];
      for (const el of this.liveEls) el.style.setProperty(`--hud-${k}`, v[k]);
    }
  }

  /** Gauntlet mode's line under the timer (null removes it). Set again when the progress changes (the PB arrives). */
  setGauntlet(p: GauntletProgress | null): void {
    this.gauntlet = p;
    this.gauntletShown = "";
    this.placeGauntlet();
  }

  /** The line sits under the map line (top left by default), or under the timer when the map line is off. */
  private placeGauntlet(): void {
    if (!this.gauntlet) return void this.gauntletEl.remove();
    const host = this.p.hud.layout.map.on ? this.els.map : this.els.timer;
    if (this.gauntletEl.parentElement !== host) host.append(this.gauntletEl);
  }

  /** The result is on screen (a mode's line goes under it with setCardExtra; else it says it in a toast). */
  get cardShown(): boolean {
    return this.card.shown;
  }

  /** The result's last line ("R to go again"): replaced, or hidden with null. Back to normal with the next result. */
  setCardHint(text: string | null): void {
    this.card.setHint(text);
  }

  // -------------------------------------------------------------------------------------------
  // Run feedback: gain ticks, milestones, splits at the crosshair (design audit ingame.md P4, P5)

  private gainTick(gain: number): void {
    if (!this.p.hud.gainTicks || Math.abs(gain) < GAIN_MIN || this.editing || this.spectated) return;
    const el = this.gainEl;
    el.textContent = `${gain > 0 ? "+" : "-"}${Math.round(Math.abs(gain))}`;
    el.className = `gain-tick ${gain > 0 ? "up" : "down"}`;
    el.getAnimations().forEach((a) => a.cancel());
    if (reducedMotion()) {
      el.animate({ opacity: [1, 0] }, { duration: 450, easing: "ease-in", fill: "forwards" });
      return;
    }
    el.animate(
      [
        { transform: "translateY(0.15em)", opacity: 1 },
        { transform: "translateY(-0.2em)", opacity: 1, offset: 0.35 },
        { transform: "translateY(-0.7em)", opacity: 0 },
      ],
      { duration: 450, easing: "cubic-bezier(0.2, 0.7, 0.4, 1)", fill: "forwards" },
    );
  }

  private pulseSpeed(): void {
    if (reducedMotion()) return;
    const n = this.speedEl.firstElementChild as HTMLElement;
    n.animate({ transform: ["none", "scale(1.1)", "none"] }, { duration: 220, easing: "ease-out" });
  }

  /**
   * A stage / checkpoint split (session.ts): its delta to the PB's split pops in the split element, bright, for 1.5 s,
   * then the live ghost delta takes the element back. Returns false when the HUD can't show it (the split element is
   * off or the UI is hidden): the caller says it in a toast instead. `delta` null: no PB split to compare.
   */
  split(delta: number | null): boolean {
    if (!this.p.hud.layout.split.on || uiHidden()) return false;
    if (delta === null) return true;
    const el = this.splitEl;
    const text = formatDelta(delta);
    this.splitText.data = this.shown.split = text;
    this.els.split.classList.remove("empty");
    this.shown.splitEmpty = false;
    el.className = `hud-split hold ${delta <= 0 ? "ahead" : "behind"}`;
    this.splitHold = performance.now() + SPLIT_HOLD_MS;
    this.ghostSign = 0;
    if (!reducedMotion()) el.animate({ transform: ["scale(1.3)", "none"] }, { ...spring(SPRINGS.bouncy), duration: 260 });
    return true;
  }

  /** The stage line ticks over: the old text slides up and out, the new one comes up from below. */
  private odometer(old: string): void {
    if (reducedMotion()) return;
    const box = this.stageEl;
    const ghost = h("span.stage-old", { "aria-hidden": "true" }, old);
    box.append(ghost);
    const o = { duration: 180, easing: "cubic-bezier(0.3, 0.7, 0.4, 1)" };
    ghost.animate({ transform: ["none", "translateY(-0.9em)"], opacity: [1, 0] }, o).finished.then(() => ghost.remove(), () => ghost.remove());
    (box.firstElementChild as HTMLElement).animate({ transform: ["translateY(0.9em)", "none"], opacity: [0, 1] }, o);
  }

  // -------------------------------------------------------------------------------------------
  // Edge glow (P12): a soft vignette that steps up with speed from 600 u/s. Off by default, never on potato; one
  // opacity write per bucket change.

  private glowOn(): boolean {
    return !!this.p.hud.edgeGlow && !document.body.classList.contains("potato");
  }

  private edgeGlow(speed: number): void {
    if (!this.glowOn()) return;
    const step = Math.max(0, Math.min(GLOW_STEPS, Math.floor((speed - GLOW_FROM) / GLOW_STEP) + 1));
    if (step === this.glowStep) return;
    this.glowStep = step;
    if (!this.glowEl) {
      this.glowEl = h("div#hud-glow", { "aria-hidden": "true" });
      this.root.prepend(this.glowEl);
    }
    this.glowEl.style.opacity = String((step / GLOW_STEPS) * 0.9);
  }

  /**
   * A toast in game (notify/: top centre, one at a time). `key`: a newer one with the same key updates it in place.
   * `tone` "bad": an error (red !, its own sound).
   */
  toast(msg: string, ms = 3000, key?: string, tone?: "info" | "good" | "bad"): void {
    notifyToast(msg, { ms, key, tone });
  }

  // -------------------------------------------------------------------------------------------
  // End of run (hud/result.ts): the timer becomes the result

  /** The result. Stays up until the timer leaves "finished" (restart / start zone). */
  runFinished(r: RunResult, submission: SubmissionView = { status: "local" }): void {
    // The time flies from where the HUD timer's digits are (if they're on screen).
    const digits = this.timeFace.el;
    const from = this.p.hud.layout.timer.on && !uiHidden() && digits.isConnected ? digits.getBoundingClientRect() : null;
    this.root.classList.add("result");
    this.card.show(r, { from: from && from.height > 0 ? from : null, wr: this.wr, restartKey: keyHint("restart") });
    // A practice finish keeps the timer's yellow (its line under the time says it wasn't submitted).
    this.card.el.classList.toggle("practice", this.practiceOn);
    this.card.setSubmission(submission);
    if (r.newPB && r.previousPB !== null) this.pbLedger(r.previousPB, r.time);
  }

  /**
   * The corner PB readout is the ledger: the old time gets a line through it, then the new time drops in from above and
   * the old one falls away. (session.ts saves the new PB right after; update() leaves the readout alone meanwhile.)
   */
  private pbLedger(old: number, now: number): void {
    for (const t of this.ledgerTimers) clearTimeout(t);
    const val = this.pbVal;
    const box = val.parentElement!;
    const to = formatTime(now);
    this.pbText.data = this.shown.pb = formatTime(old);
    this.pbLocked = performance.now() + 900;
    if (!this.p.hud.layout.pb.on || reducedMotion()) {
      this.pbText.data = this.shown.pb = to;
      return;
    }
    this.ledgerTimers = [
      window.setTimeout(() => val.classList.add("struck"), 450),
      window.setTimeout(() => {
        const was = h("b.pb-val.pb-old.struck", { "aria-hidden": "true" }, val.textContent ?? "");
        box.append(was);
        was.animate({ transform: ["none", "translateY(0.9em) rotate(4deg)"], opacity: [1, 0] }, { duration: 320, easing: "cubic-bezier(0.55, 0, 0.75, 0.3)" }).finished.then(() => was.remove(), () => was.remove());
        val.classList.remove("struck");
        this.pbText.data = this.shown.pb = to;
        val.animate({ transform: ["translateY(-0.9em)", "none"], opacity: [0, 1] }, { ...spring(SPRINGS.pop), fill: "backwards" });
      }, 650),
    ];
  }

  /** Updates the submission line under the result (queued -> verifying -> verified #3). */
  setSubmission(s: SubmissionView): void {
    this.card.setSubmission(s);
  }

  /** Extra content under the result (null: none). Set it when the run finishes; it goes when the result does. */
  setCardExtra(el: Node | null): void {
    this.card.setExtra(el);
  }

  private hideCard(): void {
    this.card.hide();
    this.root.classList.remove("result");
  }
}

function keyHint(action: "restart"): string {
  const code = prefs.get().binds[action][0];
  return code ? keyLabel(code) : "Restart";
}
