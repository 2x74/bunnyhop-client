// Replay HUD: what the game HUD would show at a replay tick, as values (hudValues, shared with the canvas HUD that is
// composited into MP4 exports) and as a DOM overlay for the viewer. The DOM overlay reuses the game HUD's own pieces
// and classes (hud/keys.ts keys overlay, hud/graph.ts speed graph, .hud-speed / .hud-timer / .hud-sync ...) and the
// player's HUD layout (prefs.hud.layout), so a replay looks like the game.

import { StrafeTrainer } from "../hud/strafe-trainer";
import { StrafeTrainerView } from "../hud/strafe-trainer-view";
import { replayStyle } from "../replay";
import { formatDelta, TimeFace } from "../hud/time-face";
import { SpeedGraph } from "../hud/graph";
import { KeysOverlay } from "../hud/keys";
import { HUD_ELEMENTS, hudPoints, hudRem, placeStyle, type HudElId } from "../hud/layout";
import { formatTime } from "../timer";
import { h } from "../ui/dom";
import { prefs } from "../ui/settings";
import { splitCount, trackName } from "../zones";
import { F_GROUNDED, F_JUMPED, F_LADDER, F_TELEPORTED, F_RESTARTED, runTimeAt, STATUS_FINISHED, STATUS_IDLE, STATUS_RUNNING, type RunData } from "./player";
import { SsjTracker, type SsjCmd, type SsjMode, type SsjReport, type SsjState, type SsjTick } from "../ssj/stats";
import { JhudView, SsjView } from "../ssj/view";
import { JHUD_HOLD, JhudTracker, reportAt, type JhudReport } from "../ssj/jhud";
import { formatSpeedDiff } from "../closest-pos";

/** Virtual mouse-turn bits (same as hud/keys.ts) and how long a turn stays lit. */
export const TURN_L = 1 << 16;
export const TURN_R = 1 << 17;
const TURN_HOLD = 3;

export interface HudValues {
  speed: number;
  speedClass: "" | "gain" | "loss";
  /** "idle" | "start" | "running" | "finished". */
  timerState: string;
  timeText: string;
  /** Compare delta (s; negative = ahead) or null. */
  split: number | null;
  /** Compare speed difference (u/s; positive = faster) or null. */
  ghostSpeed: number | null;
  track: string;
  stage: string;
  jumps: number;
  strafes: number;
  sync: number;
  perfText: string;
  showStats: boolean;
  /** Buttons of the tick plus TURN_L / TURN_R. */
  keys: number;
}

/** Buttons + turn arrows at tick i (turn = yaw moved that way within the last TURN_HOLD ticks). */
export function keyBitsAt(d: RunData, i: number): number {
  let b = d.buttons[i] & 0xffff;
  for (let k = Math.max(1, i - TURN_HOLD + 1); k <= i; k++) {
    let dy = d.view[k * 2] - d.view[(k - 1) * 2];
    if (dy > 180) dy -= 360;
    else if (dy < -180) dy += 360;
    if (dy > 0) b |= TURN_L;
    else if (dy < 0) b |= TURN_R;
  }
  return b;
}

/** HUD values at fractional tick t. `delta` / `speedDiff`: compare ghost's at that tick (or null). */
export function hudValues(d: RunData, t: number, delta: number | null, speedDiff: number | null = null): HudValues {
  const i = Math.max(0, Math.min(d.n, Math.floor(t)));
  const a = Math.min(1, Math.max(0, t - i));
  const j = Math.min(d.n, i + 1);
  const speed = d.speed[i] + (d.speed[j] - d.speed[i]) * a;
  // Gain/loss colour like the game HUD (smoothed rate of change), from the speed 50 ms ago.
  const back = Math.max(0, i - 5);
  const accel = (d.speed[i] - d.speed[back]) / Math.max(1, i - back) / d.interval;
  const sc = !prefs.get().hud.speedColors ? "" : accel > 15 ? "gain" : accel < -15 ? "loss" : "";
  const status = d.status[i];
  const hasZones = d.replay.header.zones.length > 0;
  const timerState = status === STATUS_IDLE ? (!hasZones ? "nozones" : d.inStart[i] ? "start" : "idle") : status === STATUS_RUNNING ? "running" : "finished";
  const timeText = timerState === "nozones" ? "No zones" : formatTime(status === STATUS_IDLE ? 0 : runTimeAt(d, t));
  const track = d.track[i];
  const total = splitCount(d.replay.header.zones, track);
  const n = d.splitCount[i];
  let stage = "";
  if (total && status !== STATUS_IDLE) {
    const cp = d.replay.header.zones.some((z) => z.kind === "checkpoint" && (z.track ?? 0) === track);
    stage = cp ? `CP ${n}/${total}` : `Stage ${n + 1}/${total + 1}`;
  }
  return {
    speed,
    speedClass: sc,
    timerState,
    timeText,
    split: status === STATUS_IDLE ? null : delta,
    ghostSpeed: status === STATUS_IDLE ? null : speedDiff,
    track: track ? trackName(track) : "",
    stage,
    jumps: d.jumps[i],
    strafes: d.strafes[i],
    sync: d.sync[i],
    perfText: ["scroll", "legit"].includes(replayStyle(d.replay.header)) ? [prefs.get().audio.perfHud ? `perf ${Number.isNaN(d.perf[i]) ? "—" : `${d.perf[i].toFixed(1)}%`}` : "", prefs.get().audio.perfectIndicator && d.perfectTick[i] >= 0 && (i - d.perfectTick[i]) * d.interval < 0.35 ? "Perfect" : ""].filter(Boolean).join("  ") : "",
    showStats: status !== STATUS_IDLE,
    keys: keyBitsAt(d, i),
  };
}

/** The previous jump of the same chain (within 10 ground ticks, like hud/jumps.ts), or -1. */
export function previousJump(d: RunData, k: number): number {
  let ground = 0;
  for (let i = k - 1; i > 0 && k - i < 400; i--) {
    if (d.flags[i] & F_JUMPED) return i;
    if (d.flags[i] & 2 /* F_GROUNDED */ && ++ground >= 10) return -1;
  }
  return -1;
}

/**
 * Jump stats (!ssj) over a whole replay, from its cached ticks exactly as the live game computes them (ssj/index.ts
 * LiveSsj): the state before each tick, the command stepped, the timer before the tick. Sorted by tick.
 */
export function replaySsj(d: RunData, mode: SsjMode): { tick: number; report: SsjReport }[] {
  const t = new SsjTracker(mode);
  const out: { tick: number; report: SsjReport }[] = [];
  eachReplayTick(d, (k, pre, cmd, at) => {
    const r = t.tick(pre, cmd, at);
    if (r) out.push({ tick: k, report: r });
  });
  return out;
}

/** The JHUD over a whole replay, the same way (ssj/index.ts LiveSsj). */
export function replayJhud(d: RunData): { tick: number; report: JhudReport }[] {
  const t = new JhudTracker();
  const out: { tick: number; report: JhudReport }[] = [];
  eachReplayTick(d, (k, pre, cmd, at) => {
    const r = t.tick(pre, cmd, { jumped: at.jumped, inStart: at.inStart, time: at.time });
    if (r) out.push({ tick: k, report: r });
  });
  return out;
}

function eachReplayTick(d: RunData, fn: (k: number, pre: SsjState, cmd: SsjCmd, t: SsjTick) => void): void {
  const pre = { position: [0, 0, 0], velocity: [0, 0, 0], grounded: false, onLadder: false };
  const cmd = { forward: 0, side: 0, yaw: 0, buttons: 0 };
  for (let k = 1; k <= d.n; k++) {
    const p = k - 1;
    for (let a = 0; a < 3; a++) (pre.position[a] = d.pos[p * 3 + a]), (pre.velocity[a] = d.vel[p * 3 + a]);
    pre.grounded = (d.flags[p] & F_GROUNDED) !== 0;
    pre.onLadder = (d.flags[p] & F_LADDER) !== 0;
    cmd.forward = d.forward[k];
    cmd.side = d.side[k];
    cmd.yaw = d.view[k * 2];
    cmd.buttons = d.buttons[k];
    fn(k, pre, cmd, {
      jumped: (d.flags[k] & F_JUMPED) !== 0,
      teleported: (d.flags[k] & F_TELEPORTED) !== 0,
      inStart: d.inStart[p] === 1,
      time: d.status[p] === STATUS_RUNNING ? d.runTicks[p] * d.interval : null,
    });
  }
}

const setText = (n: Text, v: string) => void (n.data !== v && (n.data = v));
const setClass = (e: HTMLElement, v: string) => void (e.className !== v && (e.className = v));

const VIEWER_ELS: HudElId[] = ["speed", "timer", "split", "ghostSpeed", "track", "stage", "stats", "sync", "keys", "graph", "jumpStats", "jhud", "strafeTrainer"];

/** DOM HUD for the viewer (inside the viewer root; positioned by the player's HUD layout). */
export class ViewerHud {
  readonly el: HTMLElement;
  private els = {} as Record<HudElId, HTMLElement>;
  private keys = new KeysOverlay();
  private graph = new SpeedGraph();
  private speedEl = h("div.hud-speed");
  private speedNum = document.createTextNode("");
  private timerEl = h("div.hud-timer");
  private timeFace = new TimeFace();
  private splitText = document.createTextNode("");
  private splitEl = h("div.hud-split", null, this.splitText);
  private gspeedText = document.createTextNode("");
  private gspeedEl = h("div.hud-gspeed", null, this.gspeedText, h("span.unit", null, " u/s"));
  private trackText = document.createTextNode("");
  private stageText = document.createTextNode("");
  private stats = { j: document.createTextNode(""), s: document.createTextNode(""), y: document.createTextNode("") };
  private syncFill = h("i.sync-fill");
  private syncText = document.createTextNode("");
  private perfText = document.createTextNode("");
  private statPerfText = document.createTextNode("");
  private statPerf = h("span.hud-perf", null, this.statPerfText);
  private ssj = new SsjView();
  private jhud = new JhudView();
  /** The JHUD of the open replay (computed on first use). */
  private jhudOf: { d: RunData; list: { tick: number; report: JhudReport }[] } | null = null;
  private trainer = new StrafeTrainer();
  private trainerView = new StrafeTrainerView();
  /** Jump stats of the open replay for one mode (computed on first use). */
  private ssjOf: { d: RunData; mode: SsjMode; list: { tick: number; report: SsjReport }[] } | null = null;
  private fed = -1;
  private last = "";

  constructor() {
    this.speedEl.append(h("span.speed-num", null, this.speedNum), h("span.unit", null, "u/s"));
    this.timerEl.append(this.timeFace.el, h("i.zone-line", { "aria-hidden": "true" }));
    const content: Partial<Record<HudElId, HTMLElement>> = {
      speed: this.speedEl,
      timer: this.timerEl,
      split: this.splitEl,
      ghostSpeed: this.gspeedEl,
      track: h("div.hud-track", null, this.trackText),
      stage: h("div.hud-stage", null, this.stageText),
      stats: h("div.hud-stats", null, h("span", null, h("b", null, this.stats.j), " jumps"), h("span", null, h("b", null, this.stats.s), " strafes"), h("span", null, h("b", null, this.stats.y), " sync"), this.statPerf),
      sync: h("div.hud-sync", null, h("div.sync-readouts", null, h("span.sync-label", null, "sync ", h("b", null, this.syncText)), h("span.sync-label.hud-perf", null, this.perfText)), h("span.sync-bar", null, this.syncFill)),
      keys: this.keys.el,
      graph: this.graph.el,
      jumpStats: this.ssj.el,
      jhud: this.jhud.el,
      strafeTrainer: this.trainerView.el,
    };
    this.el = h("div.rv-hud");
    for (const id of VIEWER_ELS) {
      const box = h("div.hud-el", { "data-el": id }, content[id]!);
      this.els[id] = box;
      this.el.append(box);
    }
    this.applyPrefs();
  }

  applyPrefs(): void {
    const p = prefs.get();
    this.el.style.setProperty("--hud-scale", String(p.hud.scale));
    // The page's rem over this HUD's own height (it stops above the replay controls).
    const at = hudPoints(p.hud.layout, p.hud.scale, hudRem(innerWidth, innerHeight) / Math.max(1, this.el.clientHeight || innerHeight));
    for (const { id } of HUD_ELEMENTS) {
      const box = this.els[id];
      if (!box) continue;
      const pl = p.hud.layout[id];
      const st = placeStyle(pl, at[id]);
      box.style.left = st.left;
      box.style.top = st.top;
      box.style.translate = st.translate;
      box.style.setProperty("--s", String(pl.s));
      box.classList.toggle("off", !pl.on);
    }
    this.graph.visible = p.hud.layout.graph.on;
    this.keys.configure(p.hud.keys);
    this.trainerView.configure(p.hud.strafeTrainer);
    this.fed = -1;
    this.last = "";
  }

  setTickRate(hz: number): void {
    this.graph.setTickRate(hz);
  }

  /** Per-tick widgets (keys, graph) follow the replay; jumps backwards or far ahead refill the last ~2.5 s. */
  private feed(d: RunData, i: number): void {
    if (i === this.fed) return;
    if (i < this.fed || i - this.fed > 250 || this.fed < 0) {
      this.keys.reset();
      this.graph.reset();
      this.trainer.reset();
      this.fed = Math.max(0, i - 250);
      this.keys.reset(d.buttons[this.fed], d.view[this.fed * 2]);
    }
    for (let k = this.fed + 1; k <= i; k++) {
      if (prefs.get().hud.layout.strafeTrainer.on) this.trainer.feed({ forward: d.forward[k], side: d.side[k], yaw: d.view[k * 2], pitch: d.view[k * 2 + 1], buttons: d.buttons[k] }, {
        speed: d.speed[k], grounded: !!(d.flags[k] & F_GROUNDED), onLadder: !!(d.flags[k] & F_LADDER), tick: k,
        dt: d.interval, maxSpeed: d.replay.header.settings.maxSpeed, airAccelerate: d.replay.header.settings.airAccelerate,
        style: replayStyle(d.replay.header), interrupted: !!(d.flags[k] & (F_TELEPORTED | F_RESTARTED)),
      });
      this.keys.feed(d.buttons[k], d.view[k * 2]);
      this.graph.push(d.speed[k]);
      if (d.flags[k] & F_JUMPED) {
        const prev = previousJump(d, k);
        this.graph.mark(prev < 0 ? 0 : d.speed[k] - d.speed[prev], prev < 0);
      }
    }
    this.fed = i;
  }

  update(d: RunData, t: number, delta: number | null, speedDiff: number | null = null): void {
    const i = Math.max(0, Math.min(d.n, Math.floor(t)));
    this.feed(d, i);
    const v = hudValues(d, t, delta, speedDiff);
    this.drawSsj(d, i);
    this.drawJhud(d, i);
    this.trainerView.render(this.trainer.reading);
    this.keys.render();
    this.graph.render();
    const sp = String(Math.round(v.speed));
    if (this.speedNum.data !== sp) this.speedNum.data = sp;
    const sc = `hud-speed ${v.speedClass}`;
    if (this.speedEl.className !== sc) this.speedEl.className = sc;
    const gspeed = v.ghostSpeed === null ? "" : formatSpeedDiff(v.ghostSpeed);
    const key = `${v.timerState}|${v.timeText}|${v.split === null ? "" : formatDelta(v.split)}|${gspeed}|${v.track}|${v.stage}|${v.jumps}|${v.strafes}|${v.sync.toFixed(1)}|${v.perfText}`;
    if (key === this.last) return;
    this.last = key;
    // While the timer runs this is every frame: only what changed is written (style and layout stay put).
    setClass(this.timerEl, `hud-timer ${v.timerState}`);
    this.timeFace.set(v.timeText);
    const split = v.split === null ? "" : formatDelta(v.split);
    setText(this.splitText, split);
    setClass(this.splitEl, `hud-split ${v.split === null ? "" : v.split <= 0 ? "ahead" : "behind"}`);
    this.els.split.classList.toggle("empty", !split);
    setText(this.gspeedText, gspeed);
    setClass(this.gspeedEl, `hud-gspeed${v.ghostSpeed === null || gspeed === "+0" ? "" : v.ghostSpeed > 0 ? " ahead" : " behind"}`);
    this.els.ghostSpeed.classList.toggle("empty", !gspeed);
    setText(this.trackText, v.track);
    this.els.track.classList.toggle("empty", !v.track);
    setText(this.stageText, v.stage);
    this.els.stage.classList.toggle("empty", !v.stage);
    this.els.stats.classList.toggle("empty", !v.showStats);
    setText(this.stats.j, String(v.jumps));
    setText(this.stats.s, String(v.strafes));
    setText(this.stats.y, `${v.sync.toFixed(1)}%`);
    const sync = Math.round(v.sync);
    setText(this.syncText, `${sync}%`);
    setText(this.perfText, v.perfText);
    setText(this.statPerfText, prefs.get().hud.layout.sync.on ? "" : v.perfText);
    const fill = `scaleX(${sync / 100})`;
    if (this.syncFill.style.transform !== fill) this.syncFill.style.transform = fill;
    setClass(this.syncFill, `sync-fill ${sync >= 85 ? "good" : sync >= 65 ? "ok" : "bad"}`);
  }

  /** The last reported jump at or before tick i (the element hides before the first). */
  private drawSsj(d: RunData, i: number): void {
    const p = prefs.get().hud;
    if (!p.layout.jumpStats.on) return;
    if (this.ssjOf?.d !== d || this.ssjOf.mode !== p.ssj.mode) this.ssjOf = { d, mode: p.ssj.mode, list: replaySsj(d, p.ssj.mode) };
    const list = this.ssjOf.list;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (list[m].tick <= i) lo = m + 1;
      else hi = m;
    }
    this.els.jumpStats.classList.toggle("empty", !this.ssj.show(lo ? list[lo - 1].report : null, p.ssj.fields));
  }

  /** The last jump at or before tick i, for JHUD_HOLD seconds after it. */
  private drawJhud(d: RunData, i: number): void {
    const p = prefs.get().hud;
    if (!p.layout.jhud.on) return;
    if (this.jhudOf?.d !== d) this.jhudOf = { d, list: replayJhud(d) };
    const at = reportAt(this.jhudOf.list, i);
    this.els.jhud.classList.toggle("empty", !this.jhud.show(at && (i - at.tick) * d.interval <= JHUD_HOLD ? at.report : null, p.jhud));
  }

  /** Forget tick history (new replay / big seek). */
  reset(): void {
    this.fed = -1;
    this.last = "";
  }
}

export { STATUS_FINISHED };
