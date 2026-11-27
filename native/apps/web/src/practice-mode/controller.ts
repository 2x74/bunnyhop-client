// Practice (research/ROADMAP.md, v0.0.10; bhoptimer-style since 0.0.27): noclip and checkpoints, solo and in rooms (0.0.36). They work
// in any attempt. Saving a checkpoint never touches the run; a checkpoint teleport or noclip turns the attempt into
// practice (attempt.ts): the timer keeps going in yellow, and it's never submitted, a PB or a ghost, no XP or stats. Its
// replay is kept on this device when it plays back (replays.ts): every save keeps the attempt's place (segments.ts),
// and a teleport to one rewinds the recording to it, as in Segmented. A restart (R / B / M / a style switch) is a real
// run again.
// Practice mode (the pause menu, !practice, its bind) makes every attempt practice until it's turned off; leaving
// puts you back at the start.
// As on CS:S, a stray key can't do that to a real run: during a timed run the teleport / noclip keys only act while the
// !cp menu (bhoptimer's checkpoint menu) is open, or once the attempt is practice anyway (rules.ts practiceKeyGate).
// Saving always works, and typed commands (!tele, !noclip) always act.
//
// main.ts wiring: onAction (bound actions), noclipping + noclipStep (instead of command -> core.step -> afterStep),
// onRestart (R / B / M / style switches end noclip).
//
// Segmented (styles.ts isSegmented, segments.ts): in a clean Segmented attempt the same checkpoints are bhoptimer's
// segmented ones. A save also keeps the run's place (its recording's path); a teleport (load) restores the snapshot with
// its speed and view whatever Keep speed says, rewinds the timer and the recording to the checkpoint, and the run stays
// a real run. The keys act during the run without the !cp menu. Noclip still makes it practice, until a load of a
// checkpoint saved before it (0.0.44, session.ts segmentResumable): the load throws the noclipped stretch away.
// A practice finish in Normal whose recording is actual segments can go to the Segmented board when the player asks
// (attempt.ts submitSegmentedProblem, session.ts submitSegmented, !submitseg).
//
// Kept checkpoints (0.0.44, cp-store.ts): every change to the list is kept on this device per map + style + track
// (position, view, speed, order, the current one). Coming back to the map (another map, a reload, a replay of another
// map) brings that list back as practice checkpoints without snapshots: a teleport to one places you there (the core's
// noclip exit, practice_noclip_exit) and makes the attempt practice like any teleport. Doors, buttons and the timer
// start over. Never in Segmented. They carry no run place (segment / path), so they never resume a Segmented run, and
// the recording after a teleport to one is tainted: never submitted to Segmented (session.ts practiceRestored).

import { whisper } from "../notify";
import { freeState, hasStateSnapshots, restoreState, snapshotBytes, snapshotState, type Core, type PlayerState } from "../core";
import { IN_DUCK, IN_JUMP, type Input, type UserCmd } from "../input";
import type { RunSession } from "../session";
import { setVelocity, SimRun } from "../sim";
import type { Replay } from "../replay";
import { formatTime } from "../timer";
import type { MenuSpec } from "../net/hud";
import { styleDef, styleForTrack, styleSettings, type StyleFilter, type StyleId } from "../styles";
import { keyLabel, prefs, type Action } from "../ui/settings";
import { Checkpoints, MAX_CHECKPOINTS, saveTimer, type Checkpoint, type TimerSnapshot } from "./checkpoints";
import { CheckpointStore, keepsCheckpoints, pageStorage, type KeyValueStore, type StoredCheckpoint } from "./cp-store";
import type { SegmentMark } from "./segments";
import { YAW_SET_TELEPORT } from "../replay";
import { replayStartProblem } from "./replay-start";
import { hasNoclip, noclipExit, noclipMove, noclipSpeed, noclipTick, type NoclipState } from "./noclip";
import { isPracticeTool, PRACTICE_KEY_HINT, practiceCommandPlan, practiceKeyGate, practiceUnavailable, type PracticeChatCommand, type PracticeContext, type PracticeTool } from "./rules";

interface CheckpointData {
  /** Style the attempt ran in (styles.ts styleForTrack) and the selected style when it was saved. */
  style: StyleId;
  selected: StyleId;
  /** The track it was saved on (session.ts currentTrack): kept per map + selected style + track (cp-store.ts). */
  track: number;
  timer: TimerSnapshot;
  yaw: number;
  pitch: number;
  /** Where the player was, and the speed (what cp-store.ts keeps). */
  position: [number, number, number];
  velocity: [number, number, number];
  /** Kept from an earlier visit (cp-store.ts): no snapshot and no timer, a teleport only places the player. */
  kept?: true;
  /** Saved in a clean Segmented attempt: the run's place, so a load rewinds the run to it (segments.ts). */
  segment?: { mark: SegmentMark; filter: StyleFilter };
  /**
   * Saved where the attempt's recording plays back (session.ts pathMark): its place, so a practice teleport here keeps
   * the practice replay playable (the same object as `segment` when there is one).
   */
  path?: { mark: SegmentMark; filter: StyleFilter };
}

export interface PracticeHost extends PracticeContext {
  map: string;
  core: Core;
  session: RunSession;
  input: Input;
  /** R: back to the start of the current track. */
  restart: () => void;
  /** The core state changed outside a step (noclip off, a teleport): re-read it, set the view if given (`kind`: the
   * view set's replay kind, YAW_SET_*; default a spawn set). */
  resync: (view: { yaw: number; pitch: number } | null, kind?: number) => void;
  /** A practice key where its tools don't work, or the dev zone editor's Z while practice mode is off, goes to the
   * key's other use (the tutorial's X, the zone editor). True if something used it. */
  fallthrough: (code: string) => boolean;
  /** Where the !cp menu shows (main.ts: the game's numbered menu, net/hud.ts NumberMenu); null: no menu. */
  menu?: PracticeMenuView | null;
  /** The pause menu's Timescale row (timescale.ts), or null where it can't be used now. */
  timescaleMenu?: () => { readonly value: number; set: (scale: number) => void } | null;
  /** Where kept checkpoints go (cp-store.ts). Absent: this page's localStorage; null: nowhere. */
  cpStorage?: KeyValueStore | null;
}

/** Said once when checkpoints from an earlier visit come back. */
export const KEPT_CHECKPOINTS_LINE = "Checkpoints from your last visit are back (doors and buttons reset)";

/** The !cp menu's screen side: a CS:S-style numbered menu (keys 1-9 pick, 0 closes and calls onExit). */
export interface PracticeMenuView {
  readonly open: boolean;
  show(spec: MenuSpec): void;
  hide(): void;
}

const HINT_EVERY_MS = 8000;

const restartHow = () => {
  const c = prefs.get().binds.restart[0];
  return `${c ? `Press ${keyLabel(c)}` : "Type !r"} to start over.`;
};

export class Practice {
  private noclip: NoclipState | null = null;
  private cps: Checkpoints<CheckpointData>;
  private hintAt = -Infinity;
  /** A gated key already said how to use it this run (start tick of that run; -1: not yet). */
  private keyHintRun = -1;
  /** Why practice mode can't be used here (rooms, the tutorial, an old wasm build), or null. */
  readonly unavailable: string | null;
  private kept: CheckpointStore;
  /** The selected style + track lists this visit has loaded or written (cp-store.ts), by `${style}|${track}`. */
  private keptKeys = new Map<string, { style: StyleId; track: number }>();
  /** Kept checkpoints came back: KEPT_CHECKPOINTS_LINE is owed (null: never, or said). */
  private keptNote: "owed" | "said" | null = null;

  constructor(private h: PracticeHost) {
    const core = h.core;
    this.unavailable = practiceUnavailable(h) ?? (hasNoclip(core) && hasStateSnapshots(core) ? null : "Practice mode needs a newer game build. Reload the page.");
    this.cps = new Checkpoints({
      save: () => snapshotState(core),
      restore: (x) => restoreState(core, x),
      free: (x) => freeState(core, x),
      bytes: (x) => snapshotBytes(core, x),
    }, undefined, {
      // Checkpoints hold their run's path (segments.ts): budgeted with the snapshots, let go with them.
      extraBytes: () => h.session.segmentBytes,
      onDrop: (d) => {
        const m = d.path?.mark ?? d.segment?.mark;
        if (m) h.session.segmentDrop(m);
      },
    });
    this.kept = new CheckpointStore(() => (h.cpStorage !== undefined ? h.cpStorage : pageStorage()));
    // Checkpoints from the last visit (said once the game shows: announceKept).
    this.restoreKept();
    // The pause menu item, only where practice mode works.
    if (!this.unavailable) {
      h.session.practiceMenu = () => ({ on: this.on, toggle: () => this.toggle(), timescale: h.timescaleMenu?.() ?? null });
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

  /** A practice chat command (!practice, !noclip, !cp, !tele, !prevcp, !nextcp, !delcp, !clearcps; chat-commands.ts; rules.ts
   * practiceCommandPlan). The tools answer with their usual toasts. */
  command(cmd: PracticeChatCommand, reply: (text: string) => void): void {
    const plan = practiceCommandPlan({ cmd, unavailable: !!this.unavailable });
    if (plan === "unavailable") return reply(this.unavailable!);
    if (plan === "toggle") return this.toggle();
    if (cmd === "off") return this.leave();
    if (cmd === "on") {
      if (!this.on) this.enter();
      return;
    }
    if (cmd === "menu") return this.toggleMenu();
    this.announceKept();
    if (cmd === "noclip") this.toggleNoclip();
    else if (cmd === "save") this.save();
    else if (cmd === "tele") this.teleport(this.cps.current());
    else if (cmd === "delete") this.remove();
    else if (cmd === "clear") this.clear();
    else this.step(cmd === "prev" ? -1 : 1);
    this.refreshMenu();
  }

  private leave(): void {
    this.endNoclip();
    this.h.session.setPracticeMode(false);
    const cleared = this.h.session.clearPracticeSpawns();
    this.h.restart();
    this.toast(`Practice mode off. ${cleared ? "Practice spawns cleared. " : ""}You're back at the start.`, 3000);
    void this.h.session.refreshMenu();
  }

  /** R / B / M / style switches (main.ts restart): noclip ends with the attempt; checkpoints stay. */
  onRestart(): void {
    this.endNoclip();
    this.keyHintRun = -1;
    // A style or track not seen yet this visit: its kept checkpoints come back now.
    if (this.restoreKept()) this.announceKept();
    this.refreshMenu();
  }

  private endNoclip(): void {
    this.noclip = null;
    this.h.session.practiceNoclip = false;
    this.h.session.flightOn = false;
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
    this.announceKept();
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
    if (practiceKeyGate({ tool: a, timedRun: this.timedRun, menuOpen: this.menuOpen, segmenting: this.h.session.segmenting, flying: this.flying }) === "act") return true;
    const run = this.h.session.timer.startTick;
    if (this.keyHintRun !== run) {
      this.keyHintRun = run;
      this.toast(PRACTICE_KEY_HINT, 3500);
    }
    return false;
  }

  private step(delta: number): void {
    const cp = this.cps.step(delta);
    this.persist();
    if (cp && this.teleport(cp)) whisper(`Checkpoint ${this.cps.number} of ${this.cps.count}`, { key: "practice-cp" });
    else if (!cp) this.noCheckpoint();
  }

  // --- the !cp menu (bhoptimer's checkpoint menu, shavit-checkpoints OpenCPMenu): stays on screen while you play,
  // re-drawn after every pick, until 0 or !cp again closes it. Not in the tutorial or a gauntlet (practiceUnavailable).

  get menuOpen(): boolean {
    return !!this.h.menu?.open;
  }

  /** !cp: opens the menu, or closes it when it's open. */
  toggleMenu(): void {
    const m = this.h.menu;
    if (!m) return;
    if (m.open) return m.hide();
    this.announceKept();
    m.show(this.menuSpec());
  }

  private refreshMenu(): void {
    if (this.menuOpen) this.h.menu!.show(this.menuSpec());
  }

  private menuSpec(): MenuSpec {
    const n = this.cps.count, at = this.cps.number;
    const keep = prefs.get().practice.keepVelocity;
    const seg = this.h.session.segmenting;
    return {
      title: seg ? "Segmented checkpoints" : "Checkpoints",
      items: [
        { label: `Save checkpoint (${Math.min(n + 1, MAX_CHECKPOINTS)}/${MAX_CHECKPOINTS})` },
        { label: `Teleport to checkpoint (${Math.max(at, 1)})`, disabled: !n },
        { label: "Previous", disabled: at <= 1 },
        { label: "Next", disabled: at >= n },
        { label: "Noclip", detail: this.noclip || this.h.session.flightOn ? "on" : "off" },
        // (bhoptimer hides its velocity toggle for segmented checkpoints: a load always restores the speed.)
        seg ? { label: "Keep speed", detail: "always", disabled: true } : { label: "Keep speed", detail: keep ? "on" : "off" },
        // (0.0.44: after the six, so 1-6 stay where muscle memory has them.)
        { label: "Delete checkpoint", disabled: !n },
        { label: "Clear all", disabled: !n },
      ],
      // bhoptimer's warning line ("Teleporting will stop your timer!").
      footer: seg ? "Segmented: a teleport takes the timer and the replay back to the checkpoint. Noclip makes the run practice until you load a checkpoint from before it." : "A teleport or noclip makes a timed run practice.",
      exit: "Close",
      onPick: (i) => {
        if (i === 0) this.save();
        else if (i === 1) this.teleport(this.cps.current());
        else if (i === 2 || i === 3) this.step(i === 2 ? -1 : 1);
        else if (i === 4) this.toggleNoclip();
        else if (i === 6) this.remove();
        else if (i === 7) this.clear();
        else if (seg) return;
        else prefs.update((p) => (p.practice.keepVelocity = !p.practice.keepVelocity));
        this.refreshMenu();
      },
    };
  }

  /** Infinite (styles.ts StyleDef.airJump): noclip is part of the style, flies at 3500 and isn't practice mode. */
  private get flying(): boolean {
    return !!styleDef(this.h.session.runStyle)?.airJump;
  }

  /** One noclip tick in place of command -> step -> afterStep (every style but Infinite, which flies in the core). */
  noclipStep(sample: UserCmd): { state: PlayerState; events: number } {
    const n = this.noclip!;
    noclipMove(n, { forwardmove: sample.forwardmove, sidemove: sample.sidemove, yaw: sample.yaw, pitch: sample.pitch, up: (sample.buttons & IN_JUMP) !== 0, slow: (sample.buttons & IN_DUCK) !== 0, speed: noclipSpeed(false) }, this.h.session.settings.tickInterval);
    const events = noclipTick(this.h.core, n);
    return { state: this.h.session.afterNoclip(sample, events), events };
  }

  private toggleNoclip(): void {
    const core = this.h.core;
    const session = this.h.session;
    if (this.flying) {
      // Infinite: the core flies the commands (IN_FLIGHT, crates/core game/flight.rs) and the replay records them, so
      // the attempt stays a real run. A run in progress ends on the first flight tick, and a flight never starts one
      // (timer.ts flightTick); the run starts once you cross the start zone without flying. Letting go lands you where
      // you are, keeping the speed the flight built (capped at 3510 sideways).
      session.flightOn = !session.flightOn;
      return;
    }
    if (!this.noclip) {
      {
        // From here the attempt is practice. A run in progress keeps its clock (timer.ts coast); otherwise the timer
        // goes idle, so flying out of a start zone doesn't start one.
        session.practiceUse("noclip");
        if (session.timer.status !== "running") session.timer.stop();
      }
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
    const mark = s.pathMark();
    if (s.segmenting && !mark) return this.toast("This Segmented run's history is full (4 hours of play). Restart to start a new one.", 4000, "bad");
    const path = mark ? { mark, filter: s.filterState() } : undefined;
    const segment = s.segmenting ? path : undefined;
    const track = s.currentTrack();
    // This style + track's kept list first, so the new one goes after it and nothing kept is written over.
    this.restoreKept(s.selectedStyle, track);
    const at = this.h.core.state();
    const cp = this.cps.save({
      style: s.runStyle, selected: s.selectedStyle, track, timer: saveTimer(s.timer), yaw: this.h.input.yaw, pitch: this.h.input.pitch,
      position: [at.position[0], at.position[1], at.position[2]], velocity: [at.velocity[0], at.velocity[1], at.velocity[2]],
      ...(path ? { path } : {}), ...(segment ? { segment } : {}),
    });
    this.persist();
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
    if (s.segmenting) return this.load(cp);
    // Kept from an earlier visit: no snapshot and no run place, only a practice placement (never a Segmented resume).
    if (cp.data.kept) return this.teleportKept(cp.data);
    // A Segmented run that a noclip or a practice teleport made practice: a checkpoint saved while it was still clean
    // takes it back there (session.ts segmentResumable), since the load throws away everything after the save.
    const seg = cp.data.segment;
    if (seg && s.segmentResumable && cp.data.style === s.runStyle && s.segmentUsable(seg.mark)) {
      if (!this.load(cp)) return false;
      if (s.segmenting) this.toast("Back on your Segmented run.", 2500);
      return true;
    }
    if (!this.cps.restore(cp)) {
      this.toast("Couldn't teleport to that checkpoint.", 2500, "bad");
      return false;
    }
    // The core is the checkpoint's now: this attempt is practice (said once while the timer is still the old one).
    s.practiceUse("teleport");
    this.endNoclip();
    // Keep speed off: a speed set outside the simulation, which no replay plays back (unless there was none to reset).
    const reset = !prefs.get().practice.keepVelocity && this.h.core.state().velocity.some((v) => v !== 0);
    if (!prefs.get().practice.keepVelocity) setVelocity(this.h.core, [0, 0, 0]);
    s.practiceRestored(cp.data.style, cp.data.timer, reset ? null : cp.data.path ?? null);
    if (reset) s.practiceSpeedReset();
    // A teleport view set, as a Segmented load's: a recording rebuilt from the checkpoint's path is then the same one a
    // Segmented run records (input-analysis.ts explains it by the load), so it can go to that board (attempt.ts).
    this.h.resync({ yaw: cp.data.yaw, pitch: cp.data.pitch }, YAW_SET_TELEPORT);
    return true;
  }

  /**
   * A teleport to a checkpoint kept from an earlier visit (no snapshot): a practice teleport that places the player at
   * its position, view and speed (Keep speed as usual) with the core's noclip exit, which finds free space nearby when
   * a door that was open then is shut now. Doors, buttons and the timer stay as they are now; the timer goes idle, so a
   * run only starts again from a start zone (and is practice until a restart).
   */
  private teleportKept(d: CheckpointData): boolean {
    const s = this.h.session;
    const core = this.h.core;
    s.practiceUse("teleport");
    this.endNoclip();
    // (Another track's style: the core takes that style's settings, as a snapshot would carry them.)
    if (d.style !== s.runStyle) core.setSettings(styleSettings(d.style));
    const keep = prefs.get().practice.keepVelocity;
    const r = noclipExit(core, { position: [...d.position], velocity: keep ? [...d.velocity] : [0, 0, 0] }, d.yaw, d.pitch);
    s.timer.stop();
    s.practiceRestored(d.style, saveTimer(s.timer));
    this.h.resync({ yaw: d.yaw, pitch: d.pitch });
    if (r === "stuck") this.toast("You're stuck in a wall. Noclip, or teleport to another checkpoint.", 4000, "bad");
    return true;
  }

  /**
   * A Segmented load (header): the run goes back to the checkpoint and stays a real run. A checkpoint without a
   * Segmented place (saved in practice, or one the history no longer holds) can't continue the run: it says so and
   * nothing changes, so a stray key never turns the run into practice.
   */
  private load(cp: Checkpoint<CheckpointData>): boolean {
    const s = this.h.session;
    const seg = cp.data.segment;
    if (!seg || cp.data.style !== s.runStyle || !s.segmentUsable(seg.mark)) {
      this.toast(`That checkpoint ${seg ? "is from a run that's no longer kept" : "was saved in practice"}, so it can't continue this Segmented run. Save a new one, or type !practice.`, 4000, "bad");
      return false;
    }
    if (!this.cps.restore(cp)) {
      this.toast("Couldn't teleport to that checkpoint.", 2500, "bad");
      return false;
    }
    this.endNoclip();
    if (!s.segmentRestored(cp.data.style, cp.data.timer, seg.filter, seg.mark)) {
      // (Never expected: the snapshot and its mark were taken together.) The core is the checkpoint's now, so the
      // attempt can only go on as practice.
      s.practiceUse("teleport");
      s.practiceRestored(cp.data.style, cp.data.timer);
    }
    // A view set the replay explains: segment loads are in its trailer (apps/api/src/input-analysis.ts).
    this.h.resync({ yaw: cp.data.yaw, pitch: cp.data.pitch }, YAW_SET_TELEPORT);
    return true;
  }

  /**
   * The replay viewer's "Practice from here": the replay is played into the live core up to `tick`, and the game
   * carries on from there as a practice attempt (a checkpoint teleport to a state that comes from a replay: your own
   * PB, the world record, anyone's run). Speed is kept. The viewer is open, so the live game isn't running. Returns why
   * it can't, or null when you're there (replay-start.ts replayStartProblem).
   */
  fromReplay(replay: Replay, tick: number): string | null {
    if (this.unavailable) return this.unavailable;
    const s = this.h.session;
    const zones = s.zones?.zones;
    if (!zones) return "This map's zones aren't loaded yet.";
    const why = replayStartProblem(replay.header, { map: this.h.map, selectedStyle: s.selectedStyle });
    if (why) return why;
    s.practiceUse("teleport"); // (before the core is touched; a failed playback restarts below)
    const run = new SimRun(this.h.core, replay, zones, { untilTick: Math.max(0, Math.min(replay.header.totalTicks, tick)), frames: true });
    run.step();
    if (run.desynced) {
      this.h.restart(); // (the core was left mid-replay)
      return "This replay doesn't play back exactly in this version, so it can only be watched.";
    }
    const state = this.h.core.state();
    const result = run.result();
    const timer = result.timer;
    const style = styleForTrack(s.selectedStyle, timer.track, this.h.map);
    this.endNoclip();
    // The recording takes the replay's commands up to here, so this attempt's practice replay plays back too.
    s.practiceFromReplay(style, saveTimer(timer), replay, result);
    const n = run.ticksDone;
    this.h.resync(n > 0 ? { yaw: replay.yaw[n - 1], pitch: replay.pitch[n - 1] } : { yaw: state.teleportAngles[1], pitch: state.teleportAngles[0] });
    this.toast(`Practising from ${s.timer.status === "running" ? formatTime(s.timer.time()) : "the start"} of that run. ${restartHow()}`, 5000);
    this.refreshMenu();
    return null;
  }

  /** Deletes the current checkpoint (the menu's Delete, !delcp). Never touches the run. */
  private remove(): void {
    const n = this.cps.number;
    if (!this.cps.remove()) return this.noCheckpoint();
    this.persist();
    whisper(this.cps.count ? `Checkpoint ${n} deleted, ${this.cps.count} left` : `Checkpoint ${n} deleted`, { key: "practice-cp" });
  }

  /** Deletes every checkpoint (the menu's Clear all, !clearcps). Never touches the run. */
  private clear(): void {
    const n = this.cps.count;
    // The kept copies go too: this style + track's, and every list this visit loaded or wrote (all of them were shown).
    const s = this.h.session;
    this.kept.clear(this.h.map, s.selectedStyle, s.currentTrack());
    for (const k of this.keptKeys.values()) this.kept.clear(this.h.map, k.style, k.track);
    if (!n) return this.noCheckpoint();
    this.cps.clear();
    whisper(n === 1 ? "Checkpoint deleted" : `All ${n} checkpoints deleted`, { key: "practice-cp" });
  }

  // --- kept checkpoints (cp-store.ts)

  /**
   * Brings back the kept list of a selected style + track (default: the current ones) once per visit, after the
   * checkpoints there are; its current one becomes current. Not where practice doesn't work, with Keep checkpoints off,
   * or in Segmented. Returns how many came back.
   */
  private restoreKept(style?: StyleId, track?: number): number {
    if (this.unavailable || !prefs.get().practice.keepCheckpoints) return 0;
    const s = this.h.session;
    style ??= s.selectedStyle;
    track ??= s.currentTrack();
    if (!keepsCheckpoints(style)) return 0;
    const k = `${style}|${track}`;
    if (this.keptKeys.has(k)) return 0;
    this.keptKeys.set(k, { style, track });
    const kept = this.kept.load(this.h.map, style, track);
    if (!kept) return 0;
    const n = this.cps.addKept(kept.list.map((c) => ({
      style: c.style, selected: style, track, timer: {}, yaw: c.yaw, pitch: c.pitch, position: c.position, velocity: c.velocity, kept: true as const,
    })), kept.at);
    if (n && !this.keptNote) this.keptNote = "owed";
    return n;
  }

  /** Writes the lists this visit has to the store: one per selected style + track (Segmented never). */
  private persist(): void {
    if (this.unavailable || !prefs.get().practice.keepCheckpoints) return;
    const groups = new Map<string, { style: StyleId; track: number; list: StoredCheckpoint[]; at: number }>();
    const cur = this.cps.number - 1;
    this.cps.entries().forEach((cp, i) => {
      const d = cp.data;
      if (!keepsCheckpoints(d.selected)) return;
      const k = `${d.selected}|${d.track}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { style: d.selected, track: d.track, list: [], at: -1 }));
      if (i === cur) g.at = g.list.length;
      g.list.push({ position: d.position, velocity: d.velocity, yaw: d.yaw, pitch: d.pitch, style: d.style });
    });
    for (const [k, g] of groups) this.keptKeys.set(k, { style: g.style, track: g.track });
    for (const [k, { style, track }] of this.keptKeys) {
      const g = groups.get(k);
      this.kept.save(this.h.map, style, track, g ? { list: g.list, at: g.at < 0 ? g.list.length - 1 : g.at } : { list: [], at: 0 });
    }
  }

  /** KEPT_CHECKPOINTS_LINE, once, when kept checkpoints came back (main.ts calls it when the game shows). */
  announceKept(): void {
    if (this.keptNote !== "owed") return;
    this.keptNote = "said";
    this.h.session.hud.toast(KEPT_CHECKPOINTS_LINE, 5000, "practice-kept");
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
