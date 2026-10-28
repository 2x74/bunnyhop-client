// Practice (research/ROADMAP.md, v0.0.10; bhoptimer-style since 0.0.27): noclip and checkpoints, solo only. They work
// in any attempt. Saving a checkpoint never touches the run; a checkpoint teleport or noclip turns the attempt into
// practice (attempt.ts): the timer keeps going in yellow, and it's never submitted, a PB or a ghost, no replay, no XP
// or stats. A restart (R / B / M / a style switch) is a real run again.
// Practice mode (the pause menu, !practice, its bind) makes every attempt practice until it's turned off; leaving
// puts you back at the start.
// As on CS:S, a stray key can't do that to a real run: during a timed run the teleport / noclip keys only act while the
// !cp menu (bhoptimer's checkpoint menu) is open, or once the attempt is practice anyway (rules.ts practiceKeyGate).
// Saving always works, and typed commands (!tele, !noclip) always act.
//
// main.ts wiring: onAction (bound actions), noclipping + noclipStep (instead of command -> core.step -> afterStep),
// onRestart (R / B / M / style switches end noclip).

import { whisper } from "../notify";
import { freeState, hasStateSnapshots, restoreState, snapshotBytes, snapshotState, type Core, type PlayerState } from "../core";
import { IN_DUCK, IN_JUMP, type Input, type UserCmd } from "../input";
import type { RunSession } from "../session";
import { setVelocity } from "../sim";
import type { MenuSpec } from "../net/hud";
import type { StyleId } from "../styles";
import { keyLabel, prefs, type Action } from "../ui/settings";
import { Checkpoints, MAX_CHECKPOINTS, saveTimer, type Checkpoint, type TimerSnapshot } from "./checkpoints";
import { hasNoclip, noclipExit, noclipMove, noclipTick, type NoclipState } from "./noclip";
import { isPracticeTool, PRACTICE_KEY_HINT, practiceCommandPlan, practiceKeyGate, practiceUnavailable, type PracticeChatCommand, type PracticeContext, type PracticeTool } from "./rules";

interface CheckpointData {
  /** Style the attempt ran in (bonus tracks are Normal) and the selected style when it was saved. */
  style: StyleId;
  selected: StyleId;
  timer: TimerSnapshot;
  yaw: number;
  pitch: number;
}

export interface PracticeHost extends PracticeContext {
  core: Core;
  session: RunSession;
  input: Input;
  /** R: back to the start of the current track. */
  restart: () => void;
  /** The core state changed outside a step (noclip off, a teleport): re-read it, set the view if given. */
  resync: (view: { yaw: number; pitch: number } | null) => void;
  /** A practice key where its tools don't work, or the dev zone editor's Z while practice mode is off, goes to the
   * key's other use (the tutorial's X, the zone editor). True if something used it. */
  fallthrough: (code: string) => boolean;
  /** Where the !cp menu shows (main.ts: the game's numbered menu, net/hud.ts NumberMenu); null: no menu. */
  menu?: PracticeMenuView | null;
}

/** The !cp menu's screen side: a CS:S-style numbered menu (keys 1-9 pick, 0 closes and calls onExit). */
export interface PracticeMenuView {
  readonly open: boolean;
  show(spec: MenuSpec): void;
  hide(): void;
}

const HINT_EVERY_MS = 8000;

export class Practice {
  private noclip: NoclipState | null = null;
  private cps: Checkpoints<CheckpointData>;
  private hintAt = -Infinity;
  /** A gated key already said how to use it this run (start tick of that run; -1: not yet). */
  private keyHintRun = -1;
  /** Why practice mode can't be used here (rooms, the tutorial, an old wasm build), or null. */
  readonly unavailable: string | null;

  constructor(private h: PracticeHost) {
    const core = h.core;
    this.unavailable = practiceUnavailable(h) ?? (hasNoclip(core) && hasStateSnapshots(core) ? null : "Practice mode needs a newer game build. Reload the page.");
    this.cps = new Checkpoints({
      save: () => snapshotState(core),
      restore: (x) => restoreState(core, x),
      free: (x) => freeState(core, x),
      bytes: (x) => snapshotBytes(core, x),
    });
    // The pause menu item, only where practice mode works.
    if (!this.unavailable) {
      h.session.practiceMenu = () => ({ on: this.on, toggle: () => this.toggle() });
      void h.session.refreshMenu();
    }
  }

  get on(): boolean {
    return this.h.session.practiceMode;
  }

  /** Noclip is on: main.ts calls noclipStep instead of stepping the core. Never in a clean attempt. */
  get noclipping(): boolean {
    if (this.noclip && !this.h.session.practicing) this.endNoclip(); // (a reset that skipped onRestart)
    return this.noclip !== null;
  }

  toggle(): void {
    if (this.on) this.leave();
    else this.enter();
  }

  /** Turns practice mode on. */
  private enter(): void {
    if (this.unavailable) return this.toast(this.unavailable);
    const s = this.h.session;
    // A timed run in progress stops counting from here (the attempt is practice): say so.
    const ended = s.timer.status === "running" && !s.unranked;
    s.setPracticeMode(true);
    const k = (a: Action) => {
      const c = prefs.get().binds[a][0];
      return c ? keyLabel(c) : null;
    };
    const parts = [k("noclip") && `${k("noclip")} is noclip`, k("cpSave") && `${k("cpSave")} saves a checkpoint`, k("cpTeleport") && `${k("cpTeleport")} takes you back to it`].filter(Boolean) as string[];
    const keys = parts.length ? ` ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]}.` : "";
    this.toast(`Practice mode on. ${ended ? "This run no longer counts, and nothing" : "Nothing"} is submitted until you leave it.${keys}`, 6000);
    void s.refreshMenu();
  }

  /** A practice chat command (!practice, !noclip, !cp, !tele, !prevcp, !nextcp; chat-commands.ts; rules.ts
   * practiceCommandPlan). The tools answer with their usual toasts. */
  command(cmd: PracticeChatCommand, reply: (text: string) => void): void {
    const plan = practiceCommandPlan({ cmd, unavailable: !!this.unavailable });
    if (plan === "unavailable") return reply(this.unavailable!);
    if (plan === "toggle") return this.toggle();
    if (cmd === "menu") return this.toggleMenu();
    if (cmd === "noclip") this.toggleNoclip();
    else if (cmd === "save") this.save();
    else if (cmd === "tele") this.teleport(this.cps.current());
    else this.step(cmd === "prev" ? -1 : 1);
    this.refreshMenu();
  }

  private leave(): void {
    this.endNoclip();
    this.h.session.setPracticeMode(false);
    this.h.restart();
    this.toast("Practice mode off. You're back at the start.", 3000);
    void this.h.session.refreshMenu();
  }

  /** R / B / M / style switches (main.ts restart): noclip ends with the attempt; checkpoints stay. */
  onRestart(): void {
    this.endNoclip();
    this.keyHintRun = -1;
    this.refreshMenu();
  }

  private endNoclip(): void {
    this.noclip = null;
    this.h.session.practiceNoclip = false;
  }

  /** A bound action. True if it was a practice action (they're always consumed). */
  onAction(a: string, code: string): boolean {
    if (a === "practice") {
      this.toggle();
      return true;
    }
    if (!isPracticeTool(a)) return false;
    if (this.unavailable) {
      if (this.h.fallthrough(code) || this.h.tutorial) return true;
      const now = performance.now();
      if (now - this.hintAt < HINT_EVERY_MS) return true;
      this.hintAt = now;
      this.toast(this.unavailable, 4000);
      return true;
    }
    // (Dev: the zone editor's Z, while practice mode is off; !noclip still flies.)
    if (!this.on && this.h.fallthrough(code)) return true;
    if (!this.keyActs(a)) return true;
    if (a === "noclip") this.toggleNoclip();
    else if (a === "cpSave") this.save();
    else if (a === "cpTeleport") this.teleport(this.cps.current());
    else if (a === "cpPrev" || a === "cpNext") this.step(a === "cpPrev" ? -1 : 1);
    this.refreshMenu();
    return true;
  }

  /** A real timed run: the timer has started and the attempt isn't practice. */
  private get timedRun(): boolean {
    const s = this.h.session;
    return s.timer.started && !s.practicing;
  }

  /** Whether a bound tool key acts now (rules.ts practiceKeyGate); else one hint per run. */
  private keyActs(a: PracticeTool): boolean {
    if (practiceKeyGate({ tool: a, timedRun: this.timedRun, menuOpen: this.menuOpen }) === "act") return true;
    const run = this.h.session.timer.startTick;
    if (this.keyHintRun !== run) {
      this.keyHintRun = run;
      this.toast(PRACTICE_KEY_HINT, 3500);
    }
    return false;
  }

  private step(delta: number): void {
    const cp = this.cps.step(delta);
    if (cp && this.teleport(cp)) whisper(`Checkpoint ${this.cps.number} of ${this.cps.count}`, { key: "practice-cp" });
    else if (!cp) this.noCheckpoint();
  }

  // --- the !cp menu (bhoptimer's checkpoint menu, shavit-checkpoints OpenCPMenu): stays on screen while you play,
  // re-drawn after every pick, until 0 or !cp again closes it. Solo only (practiceUnavailable).

  get menuOpen(): boolean {
    return !!this.h.menu?.open;
  }

  /** !cp: opens the menu, or closes it when it's open. */
  toggleMenu(): void {
    const m = this.h.menu;
    if (!m) return;
    if (m.open) return m.hide();
    m.show(this.menuSpec());
  }

  private refreshMenu(): void {
    if (this.menuOpen) this.h.menu!.show(this.menuSpec());
  }

  private menuSpec(): MenuSpec {
    const n = this.cps.count, at = this.cps.number;
    const keep = prefs.get().practice.keepVelocity;
    return {
      title: "Checkpoints",
      items: [
        { label: `Save checkpoint (${Math.min(n + 1, MAX_CHECKPOINTS)}/${MAX_CHECKPOINTS})` },
        { label: `Teleport to checkpoint (${Math.max(at, 1)})`, disabled: !n },
        { label: "Previous", disabled: at <= 1 },
        { label: "Next", disabled: at >= n },
        { label: "Noclip", detail: this.noclip ? "on" : "off" },
        { label: "Keep speed", detail: keep ? "on" : "off" },
      ],
      // bhoptimer's warning line ("Teleporting will stop your timer!").
      footer: "A teleport or noclip makes a timed run practice.",
      exit: "Close",
      onPick: (i) => {
        if (i === 0) this.save();
        else if (i === 1) this.teleport(this.cps.current());
        else if (i === 2 || i === 3) this.step(i === 2 ? -1 : 1);
        else if (i === 4) this.toggleNoclip();
        else prefs.update((p) => (p.practice.keepVelocity = !p.practice.keepVelocity));
        this.refreshMenu();
      },
    };
  }

  /** One noclip tick in place of command -> step -> afterStep. */
  noclipStep(sample: UserCmd): { state: PlayerState; events: number } {
    const n = this.noclip!;
    noclipMove(n, { forwardmove: sample.forwardmove, sidemove: sample.sidemove, yaw: sample.yaw, pitch: sample.pitch, up: (sample.buttons & IN_JUMP) !== 0, slow: (sample.buttons & IN_DUCK) !== 0 }, this.h.session.settings.tickInterval);
    const events = noclipTick(this.h.core, n);
    return { state: this.h.session.afterNoclip(sample, events), events };
  }

  private toggleNoclip(): void {
    const core = this.h.core;
    const session = this.h.session;
    if (!this.noclip) {
      // From here the attempt is practice. A run in progress keeps its clock (timer.ts coast); otherwise the timer
      // goes idle, so flying out of a start zone doesn't start one.
      session.practiceUse("noclip");
      if (session.timer.status !== "running") session.timer.stop();
      const s = core.state();
      this.noclip = { position: [...s.position], velocity: [...s.velocity] };
      session.practiceNoclip = true;
    } else {
      const r = noclipExit(core, this.noclip, this.h.input.yaw, this.h.input.pitch);
      this.endNoclip();
      this.h.resync(null);
      if (r === "stuck") this.toast("You're stuck in a wall. Noclip again, or teleport to a checkpoint.", 4000, "bad");
    }
  }

  private save(): void {
    const s = this.h.session;
    const cp = this.cps.save({ style: s.runStyle, selected: s.selectedStyle, timer: saveTimer(s.timer), yaw: this.h.input.yaw, pitch: this.h.input.pitch });
    if (cp) whisper(`Checkpoint ${this.cps.number} saved`, { key: "practice-cp" });
    else this.toast("Couldn't save a checkpoint.", 2500, "bad");
  }

  private teleport(cp: Checkpoint<CheckpointData> | null): boolean {
    if (!cp) {
      this.noCheckpoint();
      return false;
    }
    const s = this.h.session;
    if (cp.data.selected !== s.selectedStyle) {
      this.toast("That checkpoint was saved in another style.", 2500, "bad");
      return false;
    }
    if (!this.cps.restore(cp)) {
      this.toast("Couldn't teleport to that checkpoint.", 2500, "bad");
      return false;
    }
    // The core is the checkpoint's now: this attempt is practice (said once while the timer is still the old one).
    s.practiceUse("teleport");
    this.endNoclip();
    if (!prefs.get().practice.keepVelocity) setVelocity(this.h.core, [0, 0, 0]);
    s.practiceRestored(cp.data.style, cp.data.timer);
    this.h.resync({ yaw: cp.data.yaw, pitch: cp.data.pitch });
    return true;
  }

  private noCheckpoint(): void {
    const c = prefs.get().binds.cpSave[0];
    this.toast(c ? `No checkpoint yet. Press ${keyLabel(c)} to save one.` : "No checkpoint yet.", 2500);
  }

  private toast(msg: string, ms = 2500, tone?: "bad"): void {
    // One practice message at a time: a newer one replaces it in place.
    this.h.session.hud.toast(msg, ms, "practice", tone);
  }
}
