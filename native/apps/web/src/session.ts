import { appLocation } from "./platform/navigation";
import { me, accountGeneration } from "./ui/account-state";
// Run session: glues timer, zones, replay recording, PB + ghost, HUD and zone editor onto the
// fixed-tick loop in main.ts (replays open in the replay viewer: viewer/viewer.ts). main.ts calls:
//   command(sample) -> step -> afterStep(cmd, events)   every tick
//   resetCore(track, at)                                restart (R / B / M / style switch / zone edits): settings for the
//                                                       track's style, core.reset(), start-zone restart point, onReset()
//   frame(alpha, prev, curr) / camera(camera)           every rendered frame
//   frameHeld()                                         instead, while the replay viewer runs over the live game

import * as THREE from "three";
import { clientResultSettled, saveClientRun, type ClientRunSummary } from "./client-bridge";
import { EVENT_JUMPED, EVENT_TELEPORTED, applyRestartPoint, restartPoint, withRestoredState, type Core, type PlayerState, type RestartPoint, type Settings } from "./core";
import { GhostManager } from "./ghost";
import { formatDelta, Hud, type SubmissionView } from "./hud";
import type { UserCmd, Input } from "./input";
import { renderMenu, type MenuActions } from "./menu";
import { mountOnlinePanel, submitAndTrack } from "./online";
import { download, getPB, loadPBReplay, pbMs, savePBReplay, setPB, rejectPB, setPBContext, syncPBs, pbAccount, rememberPBSplits, type PersonalBest } from "./pb";
import { keyLabel, prefs } from "./ui/settings";
import { RunMouseSettings, mouseFromPrefs } from "./mouse-settings";
import { DEFAULT_TURN_SPEED, turnSpeedOf } from "./turn-binds";
import { decodeReplay, encodeReplay, ReplayRecorder, replayFileName, replayStyle, sha256Hex, type Replay } from "./replay";
import { isSegmented, nextStyle, StyleFilter, strafeKeys, styleDef, styleForTrack, styleLabel, stylePrespeedCap, styleSettings, type StyleDef, type StyleId } from "./styles";
import { onStyleChange, setSelectedStyle } from "./ui/style-picker";
import { afterStep, beforeStep, checkpointMatches, FRAME_STRIDE, frameFlags, makeTimer, quantize, simulate } from "./sim";
import { EVENT_RESPAWNED, formatTime, RunTimer, type Split, type TickCmd } from "./timer";
import { ZoneEditor, ZoneView } from "./zone-editor";
import { zoneWarningToast } from "./zone-warning";
import { loadZones, nextTrack, parseZoneSet, touching, trackName, tracksOf, zonesEqual, type ZoneSet, zoneSetToJson } from "./zones";
import { api } from "./api";
import { placeBoard, worldRecord } from "./shared-reads";
import { formatPlace, placeBoardFrom, placeFor, type PlaceBoard } from "./board-place";
import type { AutoRestartRun, AutoRestartWhen } from "./auto-restart";
import { currentRace } from "./net/presence";
import { openReplayViewer } from "./viewer/request";
import { mapTier } from "./ui/maps";
import { announce, announcerPolicy, runSounds, sfx } from "./audio";
import { restartTarget, withRestartNames } from "./restart";
import { checkStartPoint, clearPracticeSpawns, clearStartPoint, loadStartPoint, resolveStartPoint, savedMessage, saveStartPoint } from "./start-point";
import { getHeldLoadout, getOutfit, knownOutfitUnlocks } from "./player/cosmetics";
import { cosmetic } from "./progression";
import { withTimeout } from "./content/fetch";
import { reportRun, RunWatch, SelfCheck, type RunPlay } from "./selfcheck";
import { RunClock } from "./run-clock";
import { AttemptCounter, type AttemptClaim } from "./attempts";
import { mapTime, type MapTimes } from "./map-time";
import { holdReload, runEnded } from "./update";
import { TUTORIAL_MAP } from "./tutorial/data";
import { practiceReason } from "./practice";
import { finishRoute, PracticeAttempt, practiceFlipLine, practiceStartLine, type PracticeUse } from "./practice-mode/attempt";
import { loadTimer, type TimerSnapshot } from "./practice-mode/checkpoints";
import { SegmentLog, type SegmentMark } from "./practice-mode/segments";
import { LiveSsj, ssjChat } from "./ssj";
import { LiveMovementStats } from "./movement-stats";

export interface SessionInit {
  core: Core;
  scene: THREE.Scene;
  canvas: HTMLCanvasElement;
  input: Input;
  map: string;
  bsp: Uint8Array;
  wasmBytes: Uint8Array;
  /** Selected (main-track) style; its canonical settings drive the sim (styles.ts). */
  style: StyleId;
  /** main.ts: re-read core state into its prev/curr interpolation (after seeks / mode switches). */
  onResync: () => void;
  /**
   * main.ts: session.resetCore(track, at) + resync (R / B / M keys, style switches). track defaults to the current
   * track; `at` overrides the start-zone restart point.
   */
  restart: (track?: number, at?: RestartPoint | null) => void;
  /** main.ts: runs one fixed tick (command -> step -> afterStep), used by the debug hook. */
  tick: () => void;
  /** No "This map has a bonus track" (a gauntlet: main tracks only). */
  mainTrackOnly?: boolean;
  /** The map's "zones unconfirmed" label (maps/index.json `zoneWarning`), said once on load. */
  zoneWarning?: string | null;
  /** Practice spawns work (start-point.ts): solo, not the tutorial or a gauntlet (practice-mode/rules.ts practiceUnavailable). */
  practiceSpawns?: boolean;
  /** Compiles ghosts' programs ahead of their first frame (ghost.ts GhostHost.renderer). */
  renderer?: THREE.WebGLRenderer;
}

/**
 * The colourway for the replay's loadout trailer. A role-held one (the owner's Founder) only when the account is known
 * to own it: the API refuses a trailer with a role-held item the account lacks (runs.ts assertLoadoutRoles), and a
 * colourway left in this browser by another account mustn't cost a run. Without it the viewer asks the account.
 */
function recordedOutfit(): { outfit?: string } {
  const id = getOutfit();
  return cosmetic(id)?.unlock.kind === "role" && !knownOutfitUnlocks().has(id) ? {} : { outfit: id };
}

export class RunSession {
  /** Selected (main-track) style: picked in the menus / F3. Bonus runs are always Normal (styles.ts styleForTrack). */
  selectedStyle: StyleId;
  /** Style of the current attempt: physics settings, key filter and replay header (styleForTrack(selected, track)). */
  runStyle: StyleId;
  private runDef: StyleDef | null;
  /** Live run key filter (tracks the ladder exemption until landing); reset with every core.reset(). */
  private styleFilter = new StyleFilter(null);
  /** Canonical settings of runStyle (what the core runs with). */
  settings: Settings;
  /** The map's own spawn (core.reset() without a restart point): position + yaw. */
  private spawn: RestartPoint | null = null;
  private infoKey = "";
  readonly hud = new Hud();
  /** Jump stats (!ssj): fed every tick; a reported jump goes to the HUD element and, if on, the chat. */
  private ssj = new LiveSsj((r) => {
    this.hud.setJumpStats(r);
    ssjChat(r);
  }, (speed) => this.hud.setStartPre(speed), (r) => this.hud.setJhud(r));
  private movementStats = new LiveMovementStats(r => this.hud.setMovementStats(r));
  readonly view = new ZoneView();
  zones: ZoneSet | null = null;
  timer: RunTimer;
  recorder = new ReplayRecorder();
  /** Segmented runs' recording history (practice-mode/segments.ts): every tick of a clean Segmented attempt, every branch. */
  private segLog = new SegmentLog();
  editor: ZoneEditor | null = null;
  /** Race ghosts (PB / WR / custom, per track; ghost.ts). Only the current track's ghosts are shown. */
  ghosts!: GhostManager;
  lastRun: { replay: Replay; bytes: Uint8Array } | null = null;
  mapSha256 = "";
  clientBuild = "";
  /** Practice attempt (live third person was used): not submitted online, not saved as a PB. */
  practice = false;
  /**
   * The map has ranked boards (GET /maps/:name says so; assumed while the API can't be asked). Weapon commands give any
   * gun where it doesn't (weapon-commands.ts).
   */
  rankedMap = true;
  /**
   * A weapon command gave a gun ranked runs don't allow (weapon-rules.ts) in this attempt: it stays practice until the
   * next reset, also if what made it practice (third person) is turned off again.
   */
  freeGun = false;
  /**
   * Tutorial lesson attempt (tutorial/mode.ts sets it while you're in lessons 1-3): not submitted, not saved as a PB.
   * Its own flag, not `practice`, so the end card doesn't blame third person. Cleared on every reset, so the final
   * course (restarted onto its start pad when you arrive) is a normal run.
   */
  lessonPractice = false;
  /**
   * Practice (practice-mode/attempt.ts): practice mode, and whether this attempt is practice (practice mode, a checkpoint
   * teleport, noclip). Only onReset makes an attempt clean again, together with a core reset and a fresh recording.
   */
  private prac = new PracticeAttempt();
  /** Noclip is on (practice-mode/controller.ts): the HUD's Practice line says so. */
  practiceNoclip = false;
  /** A practice attempt (a tool, not practice mode) back in a start zone says it's still practice, once (afterStep). */
  private practiceStartHint: "off" | "armed" | "said" = "off";
  /** The pause menu's Practice item (main.ts sets it where practice mode is available). */
  practiceMenu: (() => MenuActions["practice"]) | null = null;
  /** This attempt ran scripted commands (the debug hook's script / run): never submitted or saved as a PB. Per attempt. */
  private scripted = false;
  /** Sticky for this RunSession, including restarts and disabling the local sampler. */
  private experimentalInputUsed = false;
  get experimentalInput(): boolean { return this.experimentalInputUsed; }
  markExperimentalInput(): void {
    this.experimentalInputUsed = true;
    this.clock.stop();
    this.newRecording();
    this.lastRun = null;
  }
  /** Submission status of the last finished run, as the end card gets it (the tutorial's final-course board listens). */
  onSubmission: ((s: SubmissionView) => void) | null = null;
  /**
   * Why the style and track can't change (gauntlet/mode.ts: gauntlets are Normal on the main track), or null. Style
   * switches and B say this instead; the pause menu shows no bonus tracks.
   */
  modeLock: string | null = null;
  /** Set from the actual multiplayer controller, independent of URL parameters. */
  multiplayer = false;
  private clientResult = 0;
  /**
   * The debug hook (window.__bunnyhop: scripted commands, zone overrides) was opted into outside the dev server: every
   * run of this session is practice (not submitted, not saved as a PB), whatever the hook was used for.
   */
  debug = false;
  private script: TickCmd[] = [];
  private liveFrames = new Float32Array(FRAME_STRIDE * 4096);
  private liveFrameEvents = new Uint8Array(4096);
  private player = localStorage.getItem("bunnyhop:name") || "player";
  /** Frames + tab switches of the timed attempt, and the worker re-simulating submitted runs (selfcheck.ts). */
  private watch = new RunWatch();
  /** Run-session heartbeats while the timer runs (run-clock.ts); the tokens go with the submission. */
  private clock = new RunClock();
  /** Attempts / restarts per board in this tab (attempts.ts): sent with the heartbeats, context for staff. */
  private attempts = new AttemptCounter();
  /** The timed attempt's claim (attempts.ts), for its stats card (runPlay). */
  private runAttempt: AttemptClaim | null = null;
  /** The FPS limit setting and whether frames wait for the display (main.ts sets it): for the run's stats card. */
  frameCap: () => { limit: number; vsync: boolean } | null = () => null;
  private selfCheck: SelfCheck | null = null;

  private constructor(private o: SessionInit) {
    this.selectedStyle = this.runStyle = o.style;
    this.runDef = styleDef(o.style);
    this.settings = styleSettings(o.style);
    this.styleFilter = new StyleFilter(this.runDef, this.settings.physics);
    this.timer = makeTimer([], this.settings, stylePrespeedCap(o.style), this.runDef);
    o.scene.add(this.view.root);
  }

  static async create(o: SessionInit): Promise<RunSession> {
    const s = new RunSession(o);
    s.mapSha256 = await sha256Hex(o.bsp as Uint8Array<ArrayBuffer>);
    s.clientBuild = `bunnyhop-web/${(await sha256Hex(o.wasmBytes as Uint8Array<ArrayBuffer>)).slice(0, 12)}`;
    s.setZones(await loadZones(o.map, o.core.entities(), o.bsp, await s.pinnedZones()));
    setPBContext(o.map, s.mapSha256, s.zones ? await sha256Hex(new TextEncoder().encode(zoneSetToJson(s.zones))) : "no-zones");
    // (The zone editor is a dev tool: the dev server or ?debug=1, main.ts.)
    if (!s.zones) s.hud.toast(`No zones yet for ${o.map}${import.meta.env.DEV || debugHookOptIn() ? " · press Z to make some" : ""}`, 8000);
    else if (o.zoneWarning) s.hud.toast(zoneWarningToast(o.zoneWarning), 8000);
    else {
      const bonuses = tracksOf(s.zones.zones).filter((t) => t > 0).length;
      // (Not on the tutorial: its lessons do the talking.)
      if (bonuses && o.map !== TUTORIAL_MAP && !o.mainTrackOnly) s.hud.toast(bonuses > 1 ? `This map has ${bonuses} bonus tracks.` : "This map has a bonus track.", 5000);
    }
    o.core.setSettings(s.settings);
    o.core.reset();
    const sp = o.core.state();
    s.spawn = { position: [...sp.position], yaw: sp.teleportAngles[1] };
    await withTimeout(me().then(() => syncPBs()), 2000, undefined);
    // Race ghosts use an auxiliary physics core; PB replay downloads are limited to the active track.
    s.ghosts = new GhostManager({
      scene: o.scene, core: o.core, map: o.map, style: s.selectedStyle, mapSha256: s.mapSha256, settings: s.settings, bsp: o.bsp, wasmBytes: o.wasmBytes,
      toast: (m, ms) => s.hud.toast(m, ms),
      onPBInputs: (track, inputs) => s.hud.setGhostInputs(track, inputs),
      renderer: o.renderer,
    });
    // Summary hydration and ghost recovery are independent: map startup never waits for remote replay bodies.
    window.addEventListener("bunnyhop:pbs", () => s.ensurePBGhost());
    window.addEventListener("bunnyhop:account", () => {
      s.pbGhostRequest = null;
      s.pbGhostLoaded = null;
      s.ghosts.remove("pb");
    });
    prefs.watch(() => s.ensurePBGhost());
    s.ensurePBGhost();
    // --- /ghost
    // Style picked elsewhere (map browser / pause menu pickers write the shared selection).
    onStyleChange((id) => id !== s.selectedStyle && void s.setStyle(id));
    s.updateInfo();
    await s.refreshMenu();
    void mountOnlinePanel(o.map, s.selectedStyle, (m, ms) => s.hud.toast(m, ms));
    s.installDebugHook();
    // tiers: HUD map line + end-of-run card (the tutorial has no tier: show none rather than "T?")
    if (o.map !== TUTORIAL_MAP) void mapTier(o.map).then((t) => s.hud.setTier(t));
    return s;
  }

  private pbGhostRequest: PersonalBest | null = null;
  private pbGhostLoaded: PersonalBest | null = null;
  /** Called on hydration, track/style reset and preference changes; never from the frame loop. */
  private ensurePBGhost(): void {
    if (!this.ghosts || !prefs.get().ghost.pb) return;
    const track = this.timer.track;
    const style = this.styleFor(track);
    const pb = getPB(this.o.map, style, track);
    if (!pb) {
      this.pbGhostRequest = null;
      this.pbGhostLoaded = null;
      this.ghosts.remove("pb", track);
      return;
    }
    if (pb === this.pbGhostLoaded || pb === this.pbGhostRequest) return;
    this.pbGhostRequest = pb;
    this.pbGhostLoaded = null;
    this.ghosts.remove("pb", track);
    const epoch = accountGeneration();
    const current = () => this.pbGhostRequest === pb && accountGeneration() === epoch && this.timer.track === track && this.styleFor(track) === style && getPB(this.o.map, style, track) === pb;
    void loadPBReplay(this.o.map, style, track).then(async (bytes) => {
      if (!bytes || !current()) return;
      const splits = await this.ghosts.loadSyncedPB(bytes, track, current);
      if (splits && current()) { this.pbGhostLoaded = pb; rememberPBSplits(pb, splits); }
    }).catch((e) => console.warn("PB ghost:", e)).finally(() => {
      if (this.pbGhostRequest === pb) this.pbGhostRequest = null;
    });
  }

  /**
   * Zones the server pinned for this exact map build (GET /maps/:name), so ranked runs are timed with the zones the
   * verifier uses. Null when the API is off/unreachable, the map is unranked, or the server has a different build.
   */
  private async pinnedZones(): Promise<unknown | null> {
    if (!api.available()) return null;
    try {
      // A stalled API mustn't hold the loading screen: after 10 s, load as if it were offline.
      const d = await withTimeout(api.mapDetail(this.o.map), 10_000, null);
      if (d && !d.ranked) this.rankedMap = false;
      return d && d.sha256 === this.mapSha256 ? d.zones : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Zones

  setZones(set: ZoneSet | null): void {
    this.zones = set;
    this.timer.zones = set?.zones ?? [];
    this.view.set(set?.zones ?? []);
    const base = set ?? { map: this.o.map, zones: [], source: "none" };
    this.editor = new ZoneEditor(
      base,
      this.view,
      () => this.o.core.state().position,
      (s) => {
        setPBContext(this.o.map, this.mapSha256, "editing");
        void sha256Hex(new TextEncoder().encode(zoneSetToJson(s))).then((hash) => {
          if (this.zones === s) setPBContext(this.o.map, this.mapSha256, hash);
        });
        this.zones = s;
        this.timer.zones = s.zones;
        this.view.set(s.zones);
        this.o.restart();
      },
      (m) => this.hud.toast(m, 5000),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Tick path

  /**
   * Command for the next tick: scripted (debug hook), else quantised live input. The
   * style's key filter (styles.ts) is applied from the pre-tick state, exactly as simulate() does on re-simulation.
   */
  command(sample: UserCmd): UserCmd {
    let c: TickCmd;
    {
      // Standing in a start zone whose track runs in another style (a bonus while W-Only is selected, or back on the
      // main track after a bonus): restart right here in that track's style.
      if (this.timer.inStart && styleForTrack(this.selectedStyle, this.timer.track) !== this.runStyle) {
        const active = this.o.input.samplerState !== null;
        const restarted = this.switchTrackStyle(active ? sample.yaw : this.o.input.yaw);
        if (active && restarted) return sample; // applyTick discards it; do not run beforeStep on the new world.
      }
      if (this.script.length) {
        c = this.script.shift()!;
        this.scripted = true;
      } else c = quantize(sample.forwardmove, sample.sidemove, sample.yaw, sample.pitch, sample.buttons);
      c = this.styleFilter.apply(c, this.o.core.state());
      beforeStep(this.o.core, this.timer, c);
    }
    // v8: the live view state rides along to the recorder (a scripted command has none: that replay is written as v7).
    return { forwardmove: c.forward, sidemove: c.side, yaw: c.yaw, pitch: c.pitch, buttons: c.buttons, ...(this.experimentalInput || this.scripted || !sample.look ? {} : { look: sample.look }), ...(sample.nullBinds && !this.scripted ? { nullBinds: true } : {}), ...(sample.timed && !this.scripted ? { timed: true } : {}), ...(sample.wRelease && !this.scripted ? { wRelease: true } : {}) };
  }

  // -------------------------------------------------------------------------------------------
  // Styles, tracks and restarts

  /** Style a run on `track` uses: the selected style on the main track, Normal on bonus tracks. */
  styleFor(track: number): StyleId {
    return styleForTrack(this.selectedStyle, track);
  }

  /** Bonus tracks of the current zone set (1..N), empty on maps without a bonus. */
  bonusTracks(): number[] {
    return this.zones ? tracksOf(this.zones.zones).filter((t) => t > 0) : [];
  }

  private setRunStyle(style: StyleId): void {
    if (style === this.runStyle) return;
    this.runStyle = style;
    this.runDef = styleDef(style);
    this.settings = styleSettings(style);
    this.styleFilter = new StyleFilter(this.runDef, this.settings.physics);
    this.timer.options = { ...this.timer.options, prespeedCap: stylePrespeedCap(style), blockPrehops: style === "scroll", strafeKeys: strafeKeys(this.runDef) };
  }

  /** HUD map line: "map · W-Only · 100 tick", or "map · Bonus 1 · Normal" on a bonus track. */
  private updateInfo(track = this.timer.track): void {
    const label = track > 0 ? `${trackName(track)} · ${styleLabel(this.runStyle)}` : styleLabel(this.runStyle);
    const key = `${label}`;
    if (key === this.infoKey) return;
    this.infoKey = key;
    this.hud.setInfo(this.o.map, label, Math.round(1 / this.settings.tickInterval));
  }

  /**
   * Restarts the core onto `track` (default: the current track) in that track's style: canonical settings,
   * core.reset(), then the start-zone restart point (`at`, else the player's start point for the track, else
   * restartTarget(track)), then onReset(). main.ts's restart() calls this and resyncs its interpolation state.
   * Returns the start point's view pitch when one was used (the core only takes the yaw).
   */
  resetCore(track = this.timer.track, at: RestartPoint | null = null): { pitch: number } | null {
    this.setRunStyle(this.styleFor(track));
    const core = this.o.core;
    // The player's start point for this track (start-point.ts), if it's still valid here; else the usual target.
    const sp = at ? null : this.startPointFor(track);
    core.setSettings(this.settings);
    core.reset();
    const p = at ?? sp?.point ?? this.restartTarget(track);
    if (p) applyRestartPoint(core, p);
    this.onReset();
    // A practice spawn (outside the start zone, or reached with a practice tool): this attempt is practice from the first tick.
    if (sp?.practice) this.prac.use("spawn");
    this.ensurePBGhost();
    this.updateInfo(track);
    return sp ? { pitch: sp.pitch } : null;
  }

  /**
   * The saved start point for `track` as a restart point (start-point.ts resolveStartPoint: checked like the verifier
   * will check the replay), with its pitch. One that no longer passes (the zones or the map changed) is dropped.
   * Leaves the core probed: reset it next.
   */
  private startPointFor(track: number): { point: RestartPoint; pitch: number; practice: boolean } | null {
    const map = this.o.map;
    const saved = loadStartPoint(map, track);
    if (!saved) return null;
    // A practice spawn stays saved where practice doesn't work (servers, the tutorial, a gauntlet), unused.
    if (saved.practice && !this.o.practiceSpawns) return null;
    const point = resolveStartPoint(this.o.core, this.settings, map, track, saved, this.zones?.zones ?? []);
    if (point) return { point, pitch: saved.pitch, practice: !!saved.practice };
    clearStartPoint(map, track);
    this.hud.toast(`Your ${saved.practice ? "spawn" : "start point"} isn't valid here any more, so it was cleared`, 4000, "start-point");
    return null;
  }

  /**
   * Set start point / spawn (bind, !setstart, !setspawn): saves where you stand for that start zone's track, or says
   * why not: a toast, or `reply` (chat commands answer in the chat). Where practice works, any other spot you stand
   * still on is saved as a practice spawn for the current track (start-point.ts); a practice attempt that used noclip
   * or a checkpoint saves one even in the zone.
   */
  setStartPoint(reply?: (text: string) => void): void {
    const say = (text: string, ms: number) => (reply ? reply(text) : this.hud.toast(text, ms, "start-point"));
    const { core, input, map } = this.o;
    const zones = this.zones?.zones ?? [];
    const r = checkStartPoint(core.state(), { yaw: input.yaw, pitch: input.pitch }, zones, {
      track: this.timer.track,
      offZone: !!this.o.practiceSpawns && !this.debug,
      tool: this.prac.unwalked,
    });
    if (!r.ok) return say(r.reason, 2500);
    // Try the restart there now (on a snapshot: play carries on untouched), so a spot the restart can't use is refused
    // here rather than dropped at the next restart. Rare: where the core's floor and the movement's disagree.
    const point = r.point;
    const usable = withRestoredState(core, () => resolveStartPoint(core, styleSettings(this.styleFor(r.track)), map, r.track, point, zones) !== null);
    if (usable === false) return say("Can't restart on this exact spot. Try a step away.", 3000);
    saveStartPoint(map, r.track, point);
    say(savedMessage(r.track, r.practice), r.practice ? 5000 : 2000);
  }

  /** !practice off must stay off on later restarts and visits, including other tracks. */
  clearPracticeSpawns(): boolean {
    return clearPracticeSpawns(this.o.map);
  }

  /** Clear start point (bind or !clearstart): the current track goes back to the default start. `reply`: as above. */
  clearStartPoint(reply?: (text: string) => void): void {
    const track = this.timer.track;
    const had = clearStartPoint(this.o.map, track);
    const text = had ? "Start point cleared" : "No start point to clear";
    if (reply) reply(text);
    else this.hud.toast(text, 2000, "start-point");
  }

  /** Where R / B put the player for `track` (restart.ts restartTarget: null = the map's own spawn). */
  restartTarget(track: number): RestartPoint | null {
    return restartTarget(this.o.map, this.zones?.zones ?? [], this.spawn, track);
  }

  /** In a start zone of a track with another style: restart where the player stands (clamped into the zone). */
  private switchTrackStyle(yaw = this.o.input.yaw): boolean {
    const track = this.timer.track;
    const s = this.o.core.state();
    const z = touching(s.position, s.crouched, this.zones?.zones ?? [], "start", track);
    if (!z) return false;
    const clamp = (v: number, i: number) => (z.maxs[i] - z.mins[i] > 2 ? Math.min(z.maxs[i] - 1, Math.max(z.mins[i] + 1, v)) : (z.mins[i] + z.maxs[i]) / 2);
    const at = withRestartNames({ position: [clamp(s.position[0], 0), clamp(s.position[1], 1), Math.max(z.mins[2] + 1, s.position[2])], yaw }, this.o.map, track);
    this.o.restart(track, at);
    this.hud.toast(`${track > 0 ? trackName(track) : "Main track"}, ${styleLabel(this.runStyle)}`, 2000);
    return true;
  }

  /** B / F4: the next track (main -> bonus 1 -> ... -> last bonus -> main). `reply`: as setStartPoint. */
  restartBonus(reply?: (text: string) => void): void {
    if (this.modeLock) return reply ? reply(this.modeLock) : this.hud.toast(this.modeLock, 2500, "mode-lock");
    const b = this.bonusTracks();
    if (!b.length) {
      if (reply) reply("No bonus on this map");
      else this.hud.toast("No bonus on this map", 2000);
      return;
    }
    this.o.restart(nextTrack(this.timer.track, b));
  }

  /** Changes the selected style (pause menu, map browser, F3) and restarts on the main track in it. */
  async setStyle(id: StyleId): Promise<void> {
    if (this.modeLock && id !== this.selectedStyle) {
      this.hud.toast(this.modeLock, 2500, "mode-lock");
      return;
    }
    this.selectedStyle = id;
    setSelectedStyle(id);
    this.ghosts.setStyle(id);
    this.o.restart(0);
    const d = styleDef(id)!;
    this.hud.toast(d.name, 2000); // (the rule lives in the style picker)
    await this.refreshMenu();
  }

  /** F3: next style. */
  cycleStyle(): void {
    void this.setStyle(nextStyle(this.selectedStyle));
  }

  private runMouse = new RunMouseSettings();

  afterStep(u: UserCmd, events: number): PlayerState {
    this.runMouse.feed(mouseFromPrefs(prefs.get()), this.timer.status === "running");
    const cmd: TickCmd = { forward: u.forwardmove, side: u.sidemove, yaw: u.yaw, pitch: u.pitch, buttons: u.buttons };
    // Jump stats read the timer as it was before the tick (in a start zone; run time at the jump).
    const t = this.timer;
    const ssjAt = { inStart: t.inStart, time: t.status === "running" ? t.ticks() * t.tickInterval : null };
    const measured = t.measuredJumps, perfect = t.perfectJumps;
    const { state, update } = afterStep(this.o.core, this.timer, cmd, events);
    if (update.started || update.restarted) announcerPolicy.resetAttempt();
    const measuredHop = t.measuredJumps > measured ? t.perfectJumps > perfect : null;
    const scroll = this.runStyle === "scroll" || this.runStyle === "legit";
    const broken = this.unranked || state.onLadder || !!(events & (EVENT_TELEPORTED | EVENT_RESPAWNED)) || t.status !== "running";
    const cue = announcerPolicy.tick(prefs.get().audio.announcer, Math.sqrt(state.velocity[0] ** 2 + state.velocity[1] ** 2), scroll ? measuredHop : null, state.grounded, t.tickInterval, broken);
    if (cue && !broken) announce(cue);
    if (scroll && measuredHop && !broken && prefs.get().audio.perfectTick) sfx("split", 0.12, 1.5);
    if (update.started) this.runMouse.feed(mouseFromPrefs(prefs.get()), false);
    this.ssj.feed(cmd, state, events, ssjAt);
    this.movementStats.feed(cmd, state, events, t, { map: this.o.map, style: this.runStyle, track: t.track, practice: this.unranked });
    this.hud.tick(cmd, state, events, { settings: this.settings, style: this.runStyle }); // HUD: keys overlay / speed graph / jump stats see exactly the simulated command
    if (!this.experimentalInput) {
      this.recorder.push(cmd.forward, cmd.side, cmd.yaw, cmd.pitch, cmd.buttons, u.look ?? null);
      if (u.nullBinds) this.recorder.nullBinds = true; // header.nullBinds: the anticheat expects instant key switches
      if (u.timed) this.recorder.timedInput = true; // header.timedInput: per-tick input isn't frame-sampled
      if (u.wRelease) this.recorder.wRelease = true; // header.wRelease: forward let go on jumps by the setting
      this.recorder.maybeCheckpoint(state.tick, state.position, state.velocity);
    }
    this.pushFrame(state, cmd, events);
    if (this.segmenting) {
      // Segmented: the tick goes into the history too, so a checkpoint load can rebuild the recording (segments.ts).
      const o = state.tick * FRAME_STRIDE;
      this.segLog.push({ forward: cmd.forward, side: cmd.side, yaw: cmd.yaw, pitch: cmd.pitch, buttons: cmd.buttons, look: u.look ?? null, frame: this.liveFrames.subarray(o, o + FRAME_STRIDE), frameEvents: this.liveFrameEvents[state.tick] });
      if (state.tick % this.recorder.checkpointInterval === 0) this.segLog.checkpoint(state.position, state.velocity);
    }
    // A practice attempt (practice mode, third person, a lesson, scripted commands, the debug hook) is never submitted,
    // so it never beats either: a run that turns into practice drops its session.
    if (update.restarted || this.unranked) this.clock.stop();
    // Back in a start zone after a checkpoint teleport or noclip: the timer resets there as if for a new run, but the
    // attempt stays practice until a restart (attempt.ts). Said once per attempt, when the timer goes back to the start
    // after being out of it (not right after a teleport into the zone).
    if (this.prac.tool && this.prac.tool !== "spawn" && !this.prac.mode && this.practiceStartHint !== "said") {
      const atStart = t.inStart && t.status === "idle";
      if (!atStart) this.practiceStartHint = "armed";
      else if (this.practiceStartHint === "armed") {
        this.practiceStartHint = "said";
        this.hud.toast(practiceStartLine(restartKey()), 4000, "practice");
      }
    }
    if (update.started) {
      // The map's attempts on this device (map-time.ts): every timer start but practice's.
      if (!this.prac.practice && this.o.map !== TUTORIAL_MAP) mapTime.attempt(this.o.map);
      this.ensurePBGhost();
      this.watch.start((now, windowMs) => this.o.input.filter.stats.pollHz(now, windowMs));
      // Run session (run-clock.ts): heartbeats over the commands recorded from the timer's start tick (the replay's
      // header.startTick: the recorder and the sim count ticks from the same reset). Not for practice (above).
      // Segmented runs rewind on purpose, which is what the heartbeats exist to catch (run-clock.ts): none for them.
      if (!this.unranked) this.runAttempt = this.attempts.start(this.o.map, this.timer.track, this.runStyle);
      if (!this.unranked && !isSegmented(this.runStyle)) {
        this.clock.start({
          map: this.o.map, track: this.timer.track, style: this.runStyle, startTick: this.timer.startTick,
          length: () => this.recorder.length, fold: (h, from, to) => this.recorder.fold(h, from, to),
          attempt: this.runAttempt ?? undefined,
        });
      }
      this.ghosts.onRunStart();
      runSounds.start();
      this.loadWorldRecord();
      this.view.startRun(this.timer.track); // the start zone's curtain drops
    }
    if (update.split) this.onSplit(update.split);
    if (update.finished) {
      // Finish sting right away (the replay encode below is async): bigger for a PB.
      const pb = getPB(this.o.map, this.runStyle, this.timer.track);
      runSounds.finish(!this.unranked && (!pb || this.timer.timeMs() < pbMs(pb)) ? "pb" : "normal");
      this.view.finish(this.timer.track, !this.unranked && this.hud.beatsRecord(this.timer.time())); // the end zone flares
      void this.finish(state);
    }
    return state;
  }

  /**
   * Stage/checkpoint reached: its delta to the PB's split pops at the crosshair (hud.split); a toast only when the HUD
   * can't show it (split element off, UI hidden).
   */
  private onSplit(sp: Split): void {
    const t = this.timer;
    const pb = getPB(this.o.map, this.runStyle, t.track);
    const pbTicks = pb?.splits?.find((s) => s[0] === sp.index)?.[1];
    const delta = pbTicks !== undefined ? (sp.ticks - pbTicks) * t.tickInterval : null;
    runSounds.split(delta); // pitch up when ahead of the PB
    if (this.hud.split(delta)) return;
    const label = sp.kind === "stage" ? `Stage ${sp.index}` : `Checkpoint ${sp.index}`;
    this.hud.toast(`${label}: ${formatTime(sp.ticks * t.tickInterval)}${delta !== null ? ` (${formatDelta(delta)})` : ""}`, 2500, "split"); // each split replaces the last
  }

  // --- the world record of the board being run, for the provisional WR at the finish (hud/result.ts). Read once per
  // map / style / track per session (a one-row board read), when a run on it first starts.
  private wrKey = "";
  /** That world record (seconds; null: none known yet), for auto restart. */
  private wrTime: number | null = null;

  private loadWorldRecord(): void {
    const t = this.timer;
    const key = `${this.o.map}|${this.runStyle}|${t.track}`;
    if (key === this.wrKey) return;
    this.wrKey = key;
    this.wrTime = null;
    this.hud.setWorldRecord(null);
    if (this.o.map === TUTORIAL_MAP || !api.available()) return;
    // (Shared with the WR ghost's read of the same board, shared-reads.ts.)
    void worldRecord(this.o.map, this.runStyle, t.track)
      .then((top) => {
        if (this.wrKey !== key) return;
        this.wrTime = top?.time ?? null;
        this.hud.setWorldRecord(this.wrTime);
      })
      .catch(() => {});
  }

  // --- auto restart (Settings -> Keys -> Auto restart; auto-restart.ts decides, main.ts restarts like the R key)

  /** Counts resets: auto restart acts once per attempt. */
  private attempt = 0;

  /** This attempt as auto restart sees it. `blocked`: main.ts's own reasons (the tutorial owns the restart keys). */
  autoRestartRun(when: AutoRestartWhen, blocked: boolean): AutoRestartRun {
    const t = this.timer;
    const board = { map: this.o.map, style: this.runStyle, track: t.track };
    return {
      attempt: this.attempt,
      status: t.status,
      time: t.ticks() * t.tickInterval,
      target: this.autoRestartTarget(when),
      unranked: this.unranked,
      // A !race duel on this board: restarting there would throw the race away (net/race.ts).
      blocked: blocked || currentRace(board) !== null,
    };
  }

  private autoRestartTarget(when: AutoRestartWhen): number | null {
    const t = this.timer;
    if (when === "pb") return getPB(this.o.map, this.runStyle, t.track)?.time ?? null;
    // (Read for this run's board when it started: loadWorldRecord.)
    if (when === "wr") return this.wrTime;
    if (when === "ghost") {
      // The custom ghost you're racing on this track, while it's shown.
      const p = prefs.get();
      return p.showGhost && p.ghost.custom ? (this.ghosts.get("custom", t.track)?.time ?? null) : null;
    }
    return null;
  }

  /**
   * Cosmetic event (a carrot swing, viewmodel/events.ts kinds) at the current tick: stored in the replay's cosmetic
   * trailer so replays and ghosts show it in third person. Never touches the recorded commands.
   */
  recordCosmetic(kind: number): void {
    if (!this.experimentalInput) this.recorder.event(kind);
    if (this.segmenting) this.segLog.event(kind);
  }

  /**
   * Starts a new recording. Its turn binds turn at the Settings speeds from its first command to its last: the replay
   * records one cl_yawspeed / cl_anglespeedkey (header.turnSpeed) and the anticheat checks every turn against it.
   */
  private newRecording(): void {
    this.recorder.clear();
    this.applyTurnSpeed();
  }

  /** Settings changed the turn speeds: they apply now to an attempt that is never submitted, else from the next restart. */
  turnSpeedChanged(): void {
    if (this.unranked) this.applyTurnSpeed();
  }
  private applyTurnSpeed(): void {
    const t = turnSpeedOf(prefs.get().yawSpeed, prefs.get().angleSpeedKey);
    this.o.input.turnSpeed = t;
    this.recorder.turnSpeed = { ...t };
  }

  /** Inspect event (replay.ts INSPECT_* kinds) at the current tick: the replay's inspect trailer, for third person. */
  recordInspect(kind: number): void {
    if (!this.experimentalInput) this.recorder.inspectEvent(kind);
    if (this.segmenting) this.segLog.event(kind, true);
  }

  onReset(): void {
    if (this.timer.status !== "idle") this.hud.restarted(); // the digits roll back (a restart with time on the clock)
    this.clientResult++;
    this.attempt++;
    this.lessonPractice = this.scripted = this.freeGun = false;
    // A fresh recording from a core reset: the only way back from a practice attempt (attempt.ts).
    if (this.prac.reset()) this.attempts.practiceExit(this.o.map);
    this.practiceStartHint = "off";
    this.hud.resetTicks(); // HUD
    this.attempts.reset(this.o.map, this.timer.track, this.runStyle);
    this.timer.reset();
    announcerPolicy.resetAttempt();
    this.clock.stop();
    this.styleFilter.reset();
    this.newRecording();
    this.ghosts.onReset();
    const s = this.o.core.state();
    this.ssj.reset(s);
    this.movementStats.reset(s);
    this.pushFrame(s, { forward: 0, side: 0, yaw: s.teleportAngles[1], pitch: s.teleportAngles[0], buttons: 0 });
    // A new path in the Segmented history (its checkpoints from earlier attempts stay loadable); a full one starts over.
    if (this.segLog.full) this.segLog.clear();
    this.segLog.begin(this.liveFrames.subarray(s.tick * FRAME_STRIDE, (s.tick + 1) * FRAME_STRIDE), this.liveFrameEvents[s.tick]);
  }

  private pushFrame(s: PlayerState, c: TickCmd, events = 0): void {
    this.putFrame(s.tick, [s.position[0], s.position[1], s.position[2], frameFlags(s), c.yaw, c.pitch], events & (EVENT_JUMPED | EVENT_TELEPORTED));
  }

  /** Writes the live frame of `tick` (FRAME_STRIDE values) and its jump / teleport events. */
  private putFrame(tick: number, frame: ArrayLike<number>, events: number): void {
    const o = tick * FRAME_STRIDE;
    if (o + FRAME_STRIDE > this.liveFrames.length) {
      const b = new Float32Array(Math.max(this.liveFrames.length * 2, o + FRAME_STRIDE));
      b.set(this.liveFrames);
      this.liveFrames = b;
      const eventBuffer = new Uint8Array(b.length / FRAME_STRIDE);
      eventBuffer.set(this.liveFrameEvents);
      this.liveFrameEvents = eventBuffer;
    }
    this.liveFrames.set(frame, o);
    this.liveFrameEvents[tick] = events;
  }

  private buildReplay(endTick: number): Replay {
    if (this.experimentalInput) throw new Error("Experimental input uses local diagnostic export only; replay protocol is unverified");
    const s = this.o.core.state();
    this.recorder.addCheckpoint(s.tick, s.position, s.velocity);
    const replay = this.recorder.build({
      map: this.o.map,
      mapSha256: this.mapSha256,
      settings: this.settings,
      style: this.runStyle,
      prespeedCap: this.timer.options.prespeedCap,
      timerRules: this.timer.rules,
      startTick: this.timer.status === "idle" ? 0 : this.timer.startTick,
      endTick,
      track: this.timer.track,
      spawn: restartPoint(this.o.core),
      zones: this.zones?.zones ?? [],
      clientBuild: this.clientBuild,
      player: this.player,
      recordedAt: Date.now(),
    });
    // Cosmetic trailer: the knife / finish / gloves and the colourway this run was played with (replays and ghosts show
    // them); the knife and finish are the ones held, the knife pool's pick when a pool is active (it only moves on at a
    // map load or a restart, so it's the one held through the run).
    replay.loadout = { ...getHeldLoadout(), ...recordedOutfit() };
    return replay;
  }

  private async finish(state: PlayerState): Promise<void> {
    if (this.experimentalInput) return this.finishPractice();
    // A practice attempt never gets near the upload: its recording went through a teleport or noclip.
    const route = finishRoute({ practice: this.prac.practice, unranked: this.unranked });
    if (route === "practice") return this.finishPractice();
    const pbOwner = pbAccount();
    const pbEpoch = accountGeneration();
    const watched = this.watch.stop();
    const beats = this.clock.finish();
    const t = this.timer;
    const mouse = this.runMouse.snapshot();
    const replay = this.buildReplay(t.endTick);
    const frames = this.liveFrames.slice(0, (state.tick + 1) * FRAME_STRIDE);
    const frameEvents = this.liveFrameEvents.slice(0, state.tick + 1);
    const time = t.time();
    const track = t.track;
    const style = this.runStyle;
    const pb = getPB(this.o.map, style, track);
    const ticks = t.endTick - t.startTick;
    // (A practice run is never a PB: third person, the debug hook, a lesson, scripted commands.)
    const newPB = !this.unranked && (!pb || t.timeMs() < pbMs(pb));
    const pbDate = Date.now();
    // The finished run's stats, read now: a Segmented checkpoint load during the encode below puts the same timer back
    // to an earlier point of the run (segmentRestored).
    const done = { jumps: t.jumps, strafes: t.strafes, sync: t.syncPercent(), splits: t.splits.map((s): [number, number] => [s.index, s.ticks]) };
    const summary = this.clientSummary(newPB);
    const bytes = await encodeReplay(replay);
    if (this.experimentalInput) return; // opt-in while encoding invalidates this completion
    this.lastRun = { replay, bytes };
    // --- UI: end-of-run card (submission status: this.hud.setSubmission(...)) ---
    this.hud.runFinished({
      time, previousPB: pb?.time ?? null, newPB, jumps: done.jumps, strafes: done.strafes, sync: done.sync,
      style: styleLabel(style), track: track ? trackName(track) : null, onMap: this.onMap(),
    });
    const clientResult = ++this.clientResult;
    const archive = (verified = false) => this.experimentalInput ? Promise.resolve() : saveClientRun({ ...summary, verified }).then((id) =>
      clientResultSettled(id, () => this.clientResult === clientResult && this.timer === t && t.status === "finished" && this.lastRun?.replay === replay));
    // --- /UI ---
    // (Bonus runs are timed and stored separately: PB, replay and ghost keyed by track. The result says "Bonus 1".)
    if (route === "unranked") {
      // Live third person, the debug hook, a tutorial lesson or scripted commands: a practice run. Watchable /
      // exportable, but not ranked and not a PB.
      void archive();
      const reason = this.practiceReason ?? "practice run";
      this.hud.setSubmission({ id: "", status: "rejected", reason });
      this.onSubmission?.({ id: "", status: "rejected", reason });
      await this.refreshMenu();
      return;
    }
    if (newPB && pbEpoch === accountGeneration()) {
      setPB({
        map: this.o.map,
        owner: pbOwner,
        style,
        track,
        ticks,
        time,
        date: pbDate,
        jumps: done.jumps,
        strafes: done.strafes,
        sync: done.sync,
        splits: done.splits,
      });
      void savePBReplay(this.o.map, style, bytes, track, pbOwner, pbDate).catch((e) => console.warn("PB replay storage:", e));
      if (pbOwner === pbAccount()) this.ghosts.setPB(track, frames, replay, t.startTick, t.endTick, frameEvents);
    }
    // Online: upload for server-side verification (guest identity issued automatically); status shows on the end card.
    // The upload goes out at once; the self-check (selfcheck.ts) re-simulates the same bytes in a worker meanwhile and
    // its diagnostics are attached to the run afterwards. A reload offered for a newer build (update.ts) waits for the
    // upload.
    let uploaded!: (id: string) => void;
    const upload = new Promise<string>((r) => (uploaded = r));
    holdReload(upload);
    void submitAndTrack(bytes, (m, ms) => this.hud.toast(m, ms), (st) => {
      this.hud.setSubmission(st);
      if (st.status === "rejected" && newPB) rejectPB(this.o.map, style, track, pbDate, pbOwner);
      this.onSubmission?.(st);
      if (st.status !== "submitting") uploaded("id" in st ? st.id : "");
      // Kept on this device until the server has it, with its run-session tokens; a failed upload is retried once
      // (uploads.ts).
    }, { map: this.o.map, style, track, time, beats, mouse }).then(
      (verdict) => archive(verdict?.status === "verified"),
      () => archive(),
    ).finally(() => uploaded(""));
    if (api.available()) {
      this.selfCheck ??= new SelfCheck({ wasmBytes: this.o.wasmBytes, bsp: this.o.bsp });
      void reportRun({ check: this.selfCheck.check(bytes), upload, watched, input: this.o.input, wasm: this.clientBuild, play: this.runPlay(watched.pollHz) });
    }
    runEnded();
    await this.refreshMenu();
  }

  /**
   * The player's side of the finished run for its stats card (selfcheck.ts RunPlay): its attempt on the map on this
   * device (the start was counted already) and the time played there, its attempt on the board this session, the frame
   * cap, the turn speed when it isn't the default, and the mouse's polling rate over the run.
   */
  private runPlay(pollHz?: number): RunPlay {
    const on = this.onMap();
    const a = this.runAttempt;
    const cap = this.frameCap();
    const t = this.recorder.turnSpeed;
    const turned = t && (t.yawSpeed !== DEFAULT_TURN_SPEED.yawSpeed || t.angleSpeedKey !== DEFAULT_TURN_SPEED.angleSpeedKey);
    return {
      ...(on && on.attempts > 0 ? { attempt: on.attempts, seconds: Math.round(on.seconds) } : {}),
      ...(a ? { session: a[0], sessionSeconds: a[3] } : {}),
      ...(cap ? { frameCap: cap } : {}),
      ...(turned ? { turn: { yawSpeed: t.yawSpeed, angleSpeedKey: t.angleSpeedKey } } : {}),
      ...(pollHz ? { pollHz } : {}),
    };
  }

  /** The map's attempts and time on this device, for the result (not on the tutorial). */
  private onMap(): MapTimes | undefined {
    return this.o.map === TUTORIAL_MAP ? undefined : mapTime.get(this.o.map);
  }

  private clientSummary(personalBest: boolean): ClientRunSummary {
    return {
      mapId: this.o.map, mapName: this.o.map, style: this.runStyle,
      timeMs: this.timer.time() * 1000, ticks: this.timer.ticks(), tickRate: 1 / this.timer.tickInterval,
      personalBest, verified: false,
      mode: this.unranked ? "practice" : this.multiplayer ? "multiplayer" : "solo",
    };
  }

  /**
   * A practice finish (practice mode, a checkpoint teleport, noclip): the end card for your own reference, nothing else.
   * No replay (noclip and teleports make the recording meaningless, and nothing could verify it), no PB, no ghost, no
   * upload.
   */
  private async finishPractice(): Promise<void> {
    this.watch.stop();
    this.clock.stop();
    const t = this.timer;
    const pb = getPB(this.o.map, this.runStyle, t.track);
    this.hud.runFinished({
      time: t.time(), previousPB: pb?.time ?? null, newPB: false, jumps: t.jumps, strafes: t.strafes, sync: t.syncPercent(),
      style: styleLabel(this.runStyle), track: t.track ? trackName(t.track) : null, noReplay: true, onMap: this.onMap(),
    });
    const clientResult = ++this.clientResult;
    if (!this.experimentalInput) void saveClientRun(this.clientSummary(false)).then((id) => clientResultSettled(id, () => this.clientResult === clientResult && this.timer === t && t.status === "finished"));
    const reason = this.practiceReason ?? "practice mode";
    this.hud.setSubmission({ id: "", status: "rejected", reason });
    this.onSubmission?.({ id: "", status: "rejected", reason });
  }

  // -------------------------------------------------------------------------------------------
  // Practice mode (practice-mode/controller.ts)

  /** Practice mode is on: every attempt is practice until it's turned off. */
  get practiceMode(): boolean {
    return this.prac.mode;
  }

  /** This attempt is practice through practice mode or a practice tool (never submitted; turn binds work). */
  get practicing(): boolean {
    return this.prac.practice;
  }

  /** Turns practice mode on (this attempt becomes practice) or off (the caller restarts right after). */
  setPracticeMode(on: boolean): void {
    this.prac.setMode(on);
    // No run session while practising (run-clock.ts); leaving practice restarts, and the next timer start opens a new one.
    this.clock.stop();
  }

  /**
   * A checkpoint teleport or noclip is about to move the player outside the simulation: from here this attempt is
   * practice until the next reset. A clean attempt says so once (toast). Call it before touching the core.
   */
  practiceUse(tool: PracticeUse): void {
    const flipped = this.prac.use(tool);
    this.clock.stop();
    if (flipped && this.o.map !== TUTORIAL_MAP) this.hud.toast(practiceFlipLine(this.timer.status === "running", restartKey()), 5000, "practice");
  }

  /**
   * A noclip tick (the core ran practice_noclip_tick instead of step): the HUD and the live frames follow, nothing is
   * recorded, and a run in progress keeps its clock going without zones (timer.ts coast). The attempt is practice.
   */
  afterNoclip(u: UserCmd, events: number): PlayerState {
    const cmd: TickCmd = { forward: u.forwardmove, side: u.sidemove, yaw: u.yaw, pitch: u.pitch, buttons: u.buttons };
    const state = this.o.core.state();
    if (this.timer.status === "running") this.timer.coast(state.tick);
    this.hud.tick(cmd, state, events, { settings: this.settings, style: this.runStyle, noclip: true });
    this.ssj.feed(cmd, state, events, { inStart: false, time: null, noclip: true });
    this.movementStats.reset(state);
    this.pushFrame(state, cmd);
    return state;
  }

  /**
   * A checkpoint teleport: the core state was just restored from the checkpoint's snapshot (its settings are that
   * style's). The run style, timer, key filter and per-tick HUD follow it; the recording starts over (it's never used
   * for a practice attempt: practiceUse came first).
   */
  practiceRestored(style: StyleId, timer: TimerSnapshot): void {
    if (!this.prac.practice) this.prac.use("teleport"); // (the controller already said so; never a clean attempt here)
    this.setRunStyle(style);
    loadTimer(this.timer, timer);
    this.styleFilter.reset();
    this.newRecording();
    this.hud.resetTicks();
    const s = this.o.core.state();
    this.ssj.reset(s);
    this.movementStats.reset(s);
    this.pushFrame(s, { forward: 0, side: 0, yaw: s.teleportAngles[1], pitch: s.teleportAngles[0], buttons: 0 });
    this.updateInfo(this.timer.track);
  }

  // -------------------------------------------------------------------------------------------
  // Segmented (styles.ts isSegmented, practice-mode/segments.ts, research/SEGMENTED.md)

  /** A clean Segmented attempt: a checkpoint load rewinds the run (timer, recording) instead of making it practice. */
  get segmenting(): boolean {
    return isSegmented(this.runStyle) && !this.unranked;
  }

  /** Checkpoint loads on the current Segmented run's path (0 outside one). */
  get segmentLoads(): number {
    return this.segmenting ? this.segLog.loadCount : 0;
  }

  /**
   * Where the Segmented run is, for a checkpoint saved now: its path through the history. Null outside a clean
   * Segmented attempt, or when the history can't rebuild it (full; out of step with the recording).
   */
  segmentMark(): SegmentMark | null {
    if (!this.segmenting) return null;
    const n = this.recorder.length;
    if (this.segLog.length !== n || this.o.core.state().tick !== n) return null;
    return this.segLog.mark({ nullBinds: this.recorder.nullBinds, timedInput: this.recorder.timedInput, wRelease: this.recorder.wRelease, turnSpeed: this.recorder.turnSpeed });
  }

  /** The checkpoint's Segmented path can still be rebuilt here (its history wasn't dropped). */
  segmentUsable(m: SegmentMark): boolean {
    return this.segLog.usable(m);
  }

  /** The live key filter's state (plain fields: shallow copies), for a Segmented checkpoint. */
  filterState(): StyleFilter {
    return Object.assign(Object.create(Object.getPrototypeOf(this.styleFilter)), this.styleFilter) as StyleFilter;
  }

  /**
   * A Segmented checkpoint load: the core was just restored from the checkpoint's snapshot, which it took after
   * `m.ticks` commands. The timer, the key filter, the recording (back to the checkpoint's path plus this load) and the
   * live frames follow it, and the attempt stays clean: no practiceUse. False (nothing changed) if `m` can't be rebuilt
   * or the core isn't at its tick; the caller then treats it as a practice teleport.
   */
  segmentRestored(style: StyleId, timer: TimerSnapshot, filter: StyleFilter, m: SegmentMark): boolean {
    const s = this.o.core.state();
    if (!this.segmenting || style !== this.runStyle || s.tick !== m.ticks || !this.segLog.usable(m)) return false;
    const was = this.timer.status;
    loadTimer(this.timer, timer);
    this.styleFilter = Object.assign(Object.create(Object.getPrototypeOf(filter)), filter) as StyleFilter;
    this.segLog.load(m, s, this.recorder, (tick, frame, events) => this.putFrame(tick, frame, events));
    this.clientResult++; // a finished run's pending archive no longer describes the run on screen (as onReset)
    this.hud.resetTicks();
    this.ssj.reset(s);
    this.movementStats.reset(s);
    this.ghosts.onReset();
    // A load into a running run from a stopped timer (back from the start zone, or a checkpoint of an attempt before a
    // restart): the run's frame watch (selfcheck.ts) and the start zone's curtain follow, as on a timer start.
    if (this.timer.status === "running" && was !== "running") {
      this.watch.start((now, windowMs) => this.o.input.filter.stats.pollHz(now, windowMs));
      this.view.startRun(this.timer.track);
    } else if (this.timer.status === "idle") this.view.reset();
    this.updateInfo(this.timer.track);
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Frame / camera

  /** A rendered frame in which the live game doesn't run (main.ts: the replay viewer is open): the run is paused. */
  frameHeld(): void {
    this.clock.hold();
  }

  /** `now`: the frame's requestAnimationFrame timestamp (the clock tripwire, selfcheck.ts RunWatch). */
  frame(alpha: number, prev: PlayerState, curr: PlayerState, now?: number): void {
    const t = this.timer;
    const placeOn = prefs.get().hud.place === "place" || prefs.get().hud.place === "top";
    // (Before the ghosts: the WR ghost's read takes this board instead of a read of its own.)
    if (placeOn) this.loadPlaceBoard();
    // --- ghost: race ghosts
    // Your speed as the ghost's is measured: the last tick's move (none across a teleport: main.ts sets prev = curr).
    const mx = curr.position[0] - prev.position[0], my = curr.position[1] - prev.position[1];
    const ghostSplit = this.ghosts.frame(t, alpha, curr.position, this.cam, prev.tick !== curr.tick ? Math.sqrt(mx * mx + my * my) / t.tickInterval : null);
    this.watch.frame(now);
    this.clock.frame(this.o.input.locked);
    // --- /ghost
    this.editor?.frame();
    if (t.status === "idle") this.view.reset(); // back on the start: dropped curtains come up (cheap when none is down)
    this.view.frame(now ?? performance.now());
    const vx = prev.velocity[0] + (curr.velocity[0] - prev.velocity[0]) * alpha;
    const vy = prev.velocity[1] + (curr.velocity[1] - prev.velocity[1]) * alpha;
    this.updateInfo();
    // The Practice line under the crosshair and the yellow timer, whenever this attempt won't count (not on the
    // tutorial: its lessons are practice and its coach does the talking). Cheap when unchanged.
    const loads = this.segmentLoads;
    if (this.segmenting) this.hud.setPractice(`Segmented${loads ? ` · ${loads} load${loads === 1 ? "" : "s"}` : ""}`, true);
    else this.hud.setPractice(this.unranked && this.o.map !== TUTORIAL_MAP ? (this.practiceNoclip ? "Practice · noclip" : "Practice") : null);
    const pb = getPB(this.o.map, this.styleFor(t.track), t.track);
    const splitTotal = t.splitTotal();
    const lastSplit = t.splits[t.splits.length - 1];
    const stage =
      splitTotal && t.status !== "idle"
        ? lastSplit?.kind === "checkpoint" || (!lastSplit && t.zones.some((z) => z.kind === "checkpoint" && (z.track ?? 0) === t.track))
          ? `CP ${t.splits.length}/${splitTotal}`
          : `Stage ${t.splits.length + 1}/${splitTotal + 1}`
        : null;
    let split: number | null = null;
    if (t.status === "running") split = ghostSplit;
    else if (t.status === "finished" && pb) split = t.time() - pb.time;
    if (split === null && t.status === "running") split = this.lastSplit;
    this.lastSplit = t.status === "running" ? split : null;
    const time = t.status === "running" ? (t.ticks() + alpha) * t.tickInterval : t.time();
    this.hud.update({
      speed: Math.sqrt(vx * vx + vy * vy),
      status: t.status,
      time,
      // Prespeeding inside the start zone: the run's clock is already going, so show it.
      pending: t.started && t.status === "idle" ? (t.pendingTicks() + alpha) * t.tickInterval : 0,
      jumps: t.jumps,
      strafes: t.strafes,
      sync: t.syncPercent(),
      perf: this.runStyle === "scroll" || this.runStyle === "legit" ? (t.measuredJumps ? t.perfPercent() : null) : undefined,
      perfectHop: !this.unranked && (this.runStyle === "scroll" || this.runStyle === "legit") && t.lastPerfectTick >= 0 && t.lastTick - t.lastPerfectTick < Math.ceil(0.35 / t.tickInterval),
      pb: pb?.time ?? null,
      split,
      place: placeOn ? this.placeText(time) : null,
      // --- UI: ghost keys overlay (the main keys overlay is fed per tick from afterStep) + start-zone state ---
      ghostTick: this.ghosts.pbTick(t.track),
      ghostSpeed: this.ghosts.speedDelta,
      inStart: t.inStart,
      hasZones: t.zones.length > 0,
      // --- /UI ---
      track: t.track,
      stage,
    });
  }
  private lastSplit: number | null = null;

  // --- the leaderboard place beside the split (Settings -> HUD -> Leaderboard place; board-place.ts). One board read
  // per map / style / track per session, the first time it's on there; nothing per tick.
  private placeTrack = -1;
  private placeStyle = "";
  private place: PlaceBoard | null = null;
  private placeShown = { place: 0, of: 0, atLeast: false, top: false, text: "" };

  private loadPlaceBoard(): void {
    const track = this.timer.track;
    const style = this.timer.status === "idle" ? this.styleFor(track) : this.runStyle;
    if (track === this.placeTrack && style === this.placeStyle) return;
    this.placeTrack = track;
    this.placeStyle = style;
    this.place = null;
    if (this.o.map === TUTORIAL_MAP || !api.available()) return;
    void placeBoard(this.o.map, style, track)
      .then((lb) => {
        if (this.placeTrack === track && this.placeStyle === style) this.place = placeBoardFrom(lb);
      })
      .catch(() => {});
  }

  /** The place `time` would take on the board being run, or null (not timing, practice, the board not read yet). */
  private placeText(time: number): string | null {
    const t = this.timer;
    const b = this.place;
    if (!b || this.unranked || (t.status !== "running" && t.status !== "finished") || this.placeTrack !== t.track || this.placeStyle !== this.runStyle) return null;
    const top = prefs.get().hud.place === "top";
    const p = placeFor(b, time);
    // (Formatted only when it changes: no string per frame.)
    const s = this.placeShown;
    if (p.place !== s.place || p.of !== s.of || p.atLeast !== s.atLeast || top !== s.top) Object.assign(s, p, { top, text: formatPlace(p, top) });
    return s.text;
  }
  // --- ghost
  private cam: THREE.PerspectiveCamera | null = null;

  /** Remembers the render camera (ghost tags / trails face it). main.ts places the camera itself. */
  camera(camera: THREE.PerspectiveCamera): boolean {
    this.cam = camera;
    return false;
  }

  /** Game keys while pointer-locked. Returns true if consumed. */
  onKey(code: string): boolean {
    return this.editor?.onKey(code) ?? false;
  }

  // -------------------------------------------------------------------------------------------
  // Menu + debug hook

  async refreshMenu(): Promise<void> {
    const hasPB = !!getPB(this.o.map, this.selectedStyle);
    await renderMenu({
      map: this.o.map,
      style: this.selectedStyle,
      currentTrack: () => this.timer.track,
      bonuses: this.modeLock ? [] : this.bonusTracks(),
      onStyle: (id) => void this.setStyle(id),
      onTrack: (track) => (this.modeLock && track ? this.hud.toast(this.modeLock, 2500, "mode-lock") : this.o.restart(track)),
      onWatchPB: hasPB ? () => openReplayViewer({ pb: { map: this.o.map, style: this.selectedStyle, track: 0 } }) : null,
      onWatchLast: this.lastRun ? () => openReplayViewer({ bytes: this.lastRun!.bytes, name: "Last run" }) : null,
      onExportLast: this.lastRun ? () => this.exportLast() : null,
      onLoadReplay: (f) => void f.arrayBuffer().then((b) => openReplayViewer({ bytes: new Uint8Array(b), name: f.name.replace(/\.bhr$/, "") })),
      practice: this.practiceMenu?.() ?? null,
    });
  }

  exportLast(): void {
    if (!this.experimentalInput && this.lastRun) download(this.lastRun.bytes, replayFileName(this.lastRun.replay.header));
  }

  /** Current recording (from the last reset up to now) as an encoded replay. */
  async exportCurrent(): Promise<Uint8Array> {
    return encodeReplay(this.buildReplay(this.timer.status === "finished" ? this.timer.endTick : 0));
  }

  /**
   * This attempt is practice: practice mode, third person, the debug hook in a non-dev build, a tutorial lesson or
   * scripted commands.
   */
  get unranked(): boolean {
    return this.practiceReason !== null;
  }

  /** Why this attempt is practice (the end card's line), or null for a normal run. */
  get practiceReason(): string | null {
    if (this.experimentalInput) return "experimental input · permanently unranked session · local diagnostics only";
    return practiceReason({ debug: this.debug, thirdPerson: this.practice, scripted: this.scripted, lesson: this.lessonPractice, mode: this.prac.practice && !this.prac.tool, tool: this.prac.tool, freeGun: this.freeGun });
  }

  /**
   * window.__bunnyhop (core, scripted commands, zones, uploads) for automated checks and tools/verify/receive.ts.
   * Always on the dev server; elsewhere only when opted in with `?debug=1` or localStorage "bunnyhop:debug" = "1",
   * and then the whole session is practice (debugHookOptIn).
   */
  private installDebugHook(): void {
    if (!import.meta.env.DEV) {
      if (!debugHookOptIn()) return;
      this.debug = true;
      this.hud.showDebugBadge();
    }
    const b64 = (u: Uint8Array) => {
      let s = "";
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(s);
    };
    const f32hex = (v: number) => {
      const d = new DataView(new ArrayBuffer(4));
      d.setFloat32(0, v, true);
      return d.getUint32(0, true).toString(16).padStart(8, "0");
    };
    const hook = {
      core: this.o.core,
      session: this,
      /** Queue exact commands [forward, side, yaw, pitch, buttons][] for the next ticks (they bypass input). */
      script: (cmds: number[][]) => {
        for (const c of cmds) this.script.push(quantize(c[0], c[1], c[2], c[3], c[4]));
      },
      /** Restart (default: current track; N = bonus N, 0 = main). */
      restart: (track?: number) => this.o.restart(track),
      /** Restart onto `track` at an explicit start-zone restart point (feet position + yaw). */
      restartAt: (track: number, x: number, y: number, z: number, yaw: number) => this.o.restart(track, { position: [x, y, z], yaw }),
      setStyle: (id: StyleId) => this.setStyle(id),
      restartTarget: (track: number) => this.restartTarget(track),
      /** Runs the given commands immediately (synchronously), one tick each; returns status(). */
      run: (cmds: number[][]) => {
        for (const c of cmds) {
          this.script.push(quantize(c[0], c[1], c[2], c[3], c[4]));
          this.o.tick();
        }
        return hook.status();
      },
      setZones: (json: unknown) => {
        const set = parseZoneSet(json, this.o.map, "debug");
        this.setZones(set);
        this.o.restart();
        return !!set;
      },
      status: () => {
        const s = this.o.core.state();
        return {
          tick: s.tick,
          status: this.timer.status,
          track: this.timer.track,
          style: this.runStyle,
          selectedStyle: this.selectedStyle,
          spawn: restartPoint(this.o.core),
          splits: this.timer.splits,
          inStart: this.timer.inStart,
          startTick: this.timer.startTick,
          endTick: this.timer.endTick,
          time: this.timer.time(),
          jumps: this.timer.jumps,
          strafes: this.timer.strafes,
          sync: this.timer.syncPercent(),
          recorded: this.recorder.length,
          segmenting: this.segmenting,
          segmentLoads: this.recorder.segments.length,
          position: s.position,
          velocity: s.velocity,
          bits: [...s.position, ...s.velocity].map(f32hex).join(" "),
        };
      },
      lastRunBase64: () => (this.lastRun ? b64(this.lastRun.bytes) : null),
      currentBase64: async () => b64(await this.exportCurrent()),
      exportLast: () => this.exportLast(),
      /** POSTs the last finished run (or the current recording) to tools/verify/receive.ts. */
      upload: async (opts: { current?: boolean; url?: string } = {}) => {
        const bytes = opts.current ? await this.exportCurrent() : this.lastRun?.bytes;
        if (!bytes) throw new Error("no finished run to upload");
        const res = await fetch(opts.url ?? "http://localhost:5199/replay", { method: "POST", body: bytes as Uint8Array<ArrayBuffer> });
        return res.json();
      },
      watchBase64: (s: string) => openReplayViewer({ bytes: Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) }),
      /** A positional ghost (no simulation): frames are [x, y, z, flags, yaw, pitch] per tick (ghost.ts fromFrames). */
      ghostFrames: (name: string, frames: number[], startTick: number, endTick: number, tickInterval: number, track = 0) =>
        void this.ghosts.fromFrames(name, Float32Array.from(frames), startTick, endTick, tickInterval, track),
    };
    (window as unknown as { __bunnyhop: unknown }).__bunnyhop = hook;
  }
}

/** The restart bind's label ("R"), or null when it's unbound. */
function restartKey(): string | null {
  const c = prefs.get().binds.restart[0];
  return c ? keyLabel(c) : null;
}

/** Debug hook opt-in outside dev: `?debug=1` in the page URL, or localStorage "bunnyhop:debug" = "1". */
export function debugHookOptIn(): boolean {
  try {
    if (appLocation().searchParams.get("debug") === "1") return true;
  } catch {
    /* no location (workers) */
  }
  try {
    return localStorage.getItem("bunnyhop:debug") === "1";
  } catch {
    return false; // storage blocked
  }
}
