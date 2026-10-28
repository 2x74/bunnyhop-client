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
//       1-5 / F camera · H HUD · F1 hide UI (the Hide UI bind) · C compare · E export · ? help · Esc close.
//
// Hide UI (ui/hide-ui.ts) leaves the picture, plus the speed and keys if Settings → HUD → Hide UI keeps them (H still
// turns the HUD off altogether). For this visit only; every playback key keeps working; Esc brings the UI back.

import { DEFAULT_LOADOUT } from "../loadout";
import "./viewer.css";
import * as THREE from "three";
import { api, API_URL, lastKnownMe } from "../api";
import { openFeedback } from "../feedback/state";
import { worldRecord } from "../shared-reads";
import { fetchExportLeaderboard } from "./export-leaderboard";
import { Core, floorWeapons, traceRay, WEAPON_IDS, weaponReport, type BrushTransform } from "../core";
import { Ghost } from "../ghost";
import { GHOST_CSS, type GhostKind } from "../player/colors";
import { PlayerModel, type PlayerPose } from "../player/model";
import { download, loadPBReplay } from "../pb";
import { cosmeticBetween, decodeReplay, inspectBetween, replayFileName, replayStyle, type Replay } from "../replay";
import { emitWeaponEvent } from "../viewmodel/events";
import { FloorGuns } from "../viewmodel/guns/world";
import type { WorldView } from "../render";
import { simulate } from "../sim";
import { styleForTrack, styleLabel, type StyleId } from "../styles";
import { formatTime } from "../timer";
import { afterPaint, h } from "../ui/dom";
import { hideUiKey, isHideUiKey, setUiHidden } from "../ui/hide-ui";
import { prefs } from "../ui/settings";
import { trackName } from "../zones";
import { CameraRig, CAM_MODES, directShots, type CamMode, type TraceFn } from "./cameras";
import type { CardInfo } from "./canvas-hud";
import { openExportDialog, type ExportSource } from "./export";
import { runUrl, shareButton } from "../ui/share";
import { ViewerHud } from "./hud";
import { F_GROUNDED, finalRunTime, ReplayPlayer, sampleAt, type RunData, type ViewSample } from "./player";
import { viewerRequestRunId, viewerUrl, type ReplayTarget, type ViewerRequest } from "./request";
import { Timeline } from "./timeline";
import { ReplayAudio } from "../audio/replay";
import { evidenceTicks, jumpTick, replayDeepLink } from "../staff-lens";
import { GauntletLayer } from "./gauntlet-layer";

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
  /** Viewer opened / closed: pause the live game, hide its HUD/ghosts/menu; then restore them. */
  onOpen: () => void;
  onClose: () => void;
}

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];

interface Compare {
  ghost: Ghost;
  kind: GhostKind;
  label: string;
  replay: Replay;
  startTick: number;
  endTick: number;
  /** Primary-tick-indexed delta (s; negative = primary ahead), NaN outside the run. */
  delta: Float32Array;
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
  /** Replay sounds (movement, wind, run chimes) while playing. */
  private sound = new ReplayAudio();
  speed = 1;
  hudOn = true;
  /** Hide UI: the controls, timeline and title are hidden (setClean). */
  clean = false;
  private label = "";
  private corePromise: Promise<Core> | null = null;
  private core: Core | null = null;
  private lastNow = performance.now();
  private lastShown = -1;
  private lastRenderedTick = NaN;
  private sample: ViewSample | undefined;
  private camPos = new THREE.Vector3();
  private exporting = false;
  private lockReleasedAt = 0;
  private dragging = false;
  private notice = "";
  private seq = 0;
  /** Watching a whole gauntlet attempt: its layer (viewer/gauntlet-layer.ts), else null. */
  private gauntlet: GauntletLayer | null = null;

  // DOM
  private root: HTMLElement;
  private stage: HTMLElement;
  private hud = new ViewerHud();
  private timeline: Timeline;
  private loading: HTMLElement;
  private titleEl: HTMLElement;
  private subEl: HTMLElement;
  private noticeEl: HTMLElement;
  private timeEl: HTMLElement;
  private tickEl: HTMLElement;
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
    this.model.setNearFade(10, 34);
    this.timeline = new Timeline({ seek: (t, final) => this.seekTo(t, final) });
    this.stage = h("div.rv-stage", { "aria-hidden": "true" });
    this.loading = h("div.rv-loading", { role: "status", "aria-live": "polite" });
    this.titleEl = h("div.rv-title");
    this.subEl = h("div.rv-sub");
    this.noticeEl = h("div.rv-notice", { hidden: true });
    this.timeEl = h("span.rv-time");
    this.tickEl = h("span.rv-tick");
    const btn = (label: string, title: string, fn: () => void, cls = "") => h(`button.rv-btn${cls}`, { type: "button", title, "aria-label": title, onclick: fn }, label) as HTMLButtonElement;
    this.playBtn = btn("▶", "Play / pause (Space)", () => this.togglePlay(), ".rv-play");
    // Leaderboard runs have a page (/replay/<id>) that unfurls with the run's card.
    this.shareBtn = shareButton("rv-btn rv-chip", () => ({ url: runUrl(this.runId ?? ""), title: `${this.playerName() || "Replay"} · ${this.host.map} · bunnyhop.lol` }), "Replay link copied");
    this.shareBtn.hidden = true;
    this.reportBtn = btn("Report", "Report this player", () => this.report(), ".rv-chip.rv-report");
    this.reportBtn.hidden = true;
    this.hudBtn = btn("HUD", "Toggle HUD (H)", () => this.toggleHud(), ".rv-chip.on");
    this.cleanBtn = btn("Hide UI", "Hide UI", () => this.setClean(true), ".rv-chip");
    this.compareMenu = h("div.rv-menu", { hidden: true, role: "menu" });
    this.compareBtn = btn("Compare", "Overlay a second replay as a ghost (C)", () => this.toggleCompareMenu(), ".rv-chip");
    this.practiceBtn = btn("Practice from here", "Take over from this moment, in practice (P)", () => this.practiceFromHere(), ".rv-chip");
    this.practiceBtn.hidden = !host.practiceFrom;
    this.freeHint = h("div.rv-freehint", { hidden: true }, "Click to fly · WASD move · mouse look · Shift fast · Space/Ctrl up/down · Esc release");
    const speeds = h(
      "div.rv-seg",
      { role: "group", "aria-label": "Playback speed" },
      ...SPEEDS.map((s) => {
        const b = btn(`${s}×`, `Playback speed ${s}× ([ / ])`, () => this.setSpeed(s), ".rv-seg-btn");
        this.speedBtns.push(b);
        return b;
      }),
    );
    const cams = h(
      "div.rv-seg",
      { role: "group", "aria-label": "Camera" },
      ...CAM_MODES.map((m) => {
        const b = btn(m.label, `${m.title} (${m.key})`, () => this.setCam(m.id), ".rv-seg-btn");
        this.camBtns.set(m.id, b);
        return b;
      }),
    );
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
            [this.cleanKey, "hide the UI (Esc shows it)"],
            ["C", "compare with another replay"],
            ["E", "export MP4"],
            ["P", "practice from this moment"],
            ["N / P", "next / previous map (watching a gauntlet)"],
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
    const transport = h(
      "div.rv-group",
      null,
      btn("⏮", "Run start (Home)", () => this.jumpStart()),
      btn("‹", "Previous tick (,)", () => this.step(-1)),
      this.playBtn,
      btn("›", "Next tick (.)", () => this.step(1)),
      btn("⏭", "Finish (End)", () => this.jumpEnd()),
      h("div.rv-clock", null, this.timeEl, this.tickEl),
    );
    const right = h(
      "div.rv-group.rv-right",
      null,
      this.hudBtn,
      this.cleanBtn,
      h("div.rv-menu-wrap", null, this.compareBtn, this.compareMenu),
      this.practiceBtn,
      btn("Export MP4", "Render this replay to an MP4 video (E)", () => this.openExport(), ".rv-chip.rv-accent"),
      btn("⤓ .bhr", "Download the replay file", () => this.downloadBhr(), ".rv-chip"),
      this.shareBtn,
      this.reportBtn,
    );
    const panel = h("footer.rv-panel", null, this.timeline.el, h("div.rv-controls", null, transport, h("div.rv-group", null, speeds, cams), right));
    this.panel = panel;
    this.root = h("div#rv", { hidden: true, role: "dialog", "aria-label": "Replay viewer" }, this.stage, this.hud.el, top, this.freeHint, this.loading, this.helpEl, panel);
    // The HUD and whispers sit above the controls (viewer.css --rv-panel-h), not under them; 0 while Hide UI hides the panel.
    new ResizeObserver(() => document.body.style.setProperty("--rv-panel-h", `${panel.offsetHeight}px`)).observe(panel);
    document.body.append(this.root);
    this.bindInput();
    prefs.watch(() => this.hud.applyPrefs());
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
    const style = styleForTrack(((pb as { style?: string }).style ?? this.host.style()) as StyleId, track);
    const bytes = await loadPBReplay(map, style, track);
    if (!bytes) throw new Error(`No ${track ? trackName(track) + " " : ""}${styleLabel(style)} PB replay saved on ${map} yet.`);
    return { bytes, label: "Personal best" };
  }

  /** Opens the viewer on a request (main.ts / request.ts). Replays for another map reload the page onto that map. */
  async open(req: ViewerRequest): Promise<void> {
    const my = ++this.seq;
    // ?t=<tick> / ?jump=<n> (staff-lens.ts): read before the URL is rewritten below.
    const deep = replayDeepLink();
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
        const next = new URL(sourceRunId ? viewerUrl({ runId: sourceRunId }) : viewerUrl({ bytes }, replay.header.map), appHref());
        if (deep.tick !== null) next.searchParams.set("t", String(deep.tick));
        if (deep.jump !== null) next.searchParams.set("jump", String(deep.jump));
        location.href = next.pathname + next.search;
        return;
      }
      await this.viewerCore();
      if (my !== this.seq) return;
      this.setLoading("Preparing replay…");
      await afterPaint();
      this.load(replay, bytes, label);
      // Shareable link for leaderboard runs.
      this.runId = viewerRequestRunId(req);
      this.owner = null;
      this.model.setPlayerGlow(null);
      if (this.runId) void api.runPlayer(this.runId).then(p => {
        if (my !== this.seq) return;
        this.model.setPlayerGlow(p.playerGlow);
        this.drawModel?.setPlayerGlow(p.playerGlow);
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
      if (this.runId && !this.gauntlet) history.replaceState(null, "", viewerUrl({ runId: this.runId }));
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
      this.setLoading(String((e as Error)?.message ?? e), true);
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
  }

  private setLoading(text: string | null, error = false): void {
    this.loading.hidden = text === null;
    this.loading.classList.toggle("error", error);
    if (text === null) return;
    this.loading.replaceChildren(
      ...[
      error ? h("strong", null, "Can't open this replay") : h("div.rv-spinner"),
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
    this.rig.setShots([]);
    if (this.rig.mode === "auto") this.autoShots();
    this.t = d.startTick ? Math.max(0, d.startTick - d.tickrate) : 0;
    this.playing = true;
    this.lastShown = -1;
    this.rig.snap();
    this.model.snap();
    this.floorStale = true;
    // The knife / finish / gloves the run was played with (replay trailer); older replays show the carrot.
    this.model.setLoadout(replay.loadout ?? { ...DEFAULT_LOADOUT });
    const h0 = replay.header;
    const notes: string[] = [];
    if (h0.mapSha256 !== this.host.mapSha256) notes.push("Recorded on a different build of this map, so playback may desync.");
    if (d.desyncTick !== null) notes.push(`Desync at tick ${d.desyncTick}: this build doesn't reproduce the recording exactly.`);
    if (d.styleViolations) notes.push(`${d.styleViolations} commands break the ${styleLabel(replayStyle(h0))} rules (filtered as the verifier does).`);
    this.notice = notes.join(" ");
    this.updateTitle();
    this.updateControls();
    this.setLoading(null);
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
    openFeedback({ category: "report", report: { name: this.playerName() || "this player", run: { id: this.runId, map: r.header.map, time: d ? finalRunTime(d) : null } } });
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
    this.subEl.textContent = [h0.map, track ? trackName(track) : "", styleLabel(replayStyle(h0)), `${d.tickrate} tick`, this.label, new Date(h0.recordedAt).toLocaleDateString()].filter(Boolean).join(" · ");
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
    if (url.pathname.startsWith("/replay/") || url.searchParams.has("replay")) {
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
    if (!this.playing && this.t >= d.n) this.seekTo(d.startTick ? Math.max(0, d.startTick - d.tickrate) : 0, true);
    this.playing = !this.playing;
    this.updateControls();
  }

  setSpeed(s: number): void {
    this.speed = s;
    this.updateControls();
  }

  private nudgeSpeed(dir: number): void {
    const i = SPEEDS.indexOf(this.speed);
    this.setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 3 : i) + dir))]);
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
    const nt = Math.max(0, Math.min(d.n, t));
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
    if (d) this.seekTo(d.endTick || d.n, true);
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
    this.playBtn.textContent = this.playing ? "❚❚" : "▶";
    this.playBtn.classList.toggle("playing", this.playing);
    SPEEDS.forEach((s, i) => this.speedBtns[i].classList.toggle("on", s === this.speed));
    for (const [m, b] of this.camBtns) b.classList.toggle("on", m === this.rig.mode);
    this.hudBtn.classList.toggle("on", this.hudOn);
    this.freeHint.hidden = this.rig.mode !== "free" || document.pointerLockElement === this.stage;
    const c = this.compare;
    this.compareBtn.textContent = c ? `vs ${c.label}` : "Compare";
    this.compareBtn.classList.toggle("on", !!c);
    if (c) this.compareBtn.style.setProperty("--chip", GHOST_CSS[c.kind]);
    else this.compareBtn.style.removeProperty("--chip");
    if (!d) return;
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
      h("button.rv-menu-item", { type: "button", role: "menuitem", disabled, onclick: () => ((m.hidden = true), fn()) }, h("span", null, label), h("small", null, sub));
    const file = h("input", { type: "file", accept: ".bhr,application/octet-stream", hidden: true });
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      if (f) void f.arrayBuffer().then((b) => this.setCompare({ bytes: new Uint8Array(b), name: f.name.replace(/\.bhr$/, "") }, "custom"));
    });
    m.replaceChildren(
      item("Your PB", `${trackName(track)} · ${styleLabel(style)}`, () => void this.setCompare({ pb: { map: hd.map, style, track } }, "pb")),
      item("World record", api.available() ? "Top of the leaderboard" : "Leaderboards offline", () => void this.compareWR(style, track), !api.available()),
      item("Replay file…", ".bhr from disk", () => file.click()),
      ...(this.compare ? [item("Remove ghost", this.compare.label, () => this.clearCompare())] : []),
      file,
    );
    m.hidden = false;
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
      if (d.startTick) {
        const end = d.endTick || d.n;
        const pos = [0, 0, 0];
        let last = NaN;
        for (let i = d.startTick; i <= end; i++) {
          pos[0] = d.pos[i * 3];
          pos[1] = d.pos[i * 3 + 1];
          pos[2] = d.pos[i * 3 + 2];
          const v = ghost.split(pos, i - d.startTick);
          if (v !== null) last = v;
          delta[i] = last;
        }
        if (d.endTick && sim.endTick) {
          const fin = (d.endTick - d.startTick - (sim.endTick - sim.startTick)) * d.interval;
          for (let i = d.endTick; i <= d.n; i++) delta[i] = fin;
        }
        ghost.resetSplit();
      }
      this.compare?.ghost.dispose();
      this.host.scene.add(ghost.root);
      this.compare = { ghost, kind, label: name, replay, startTick: sim.startTick, endTick: sim.endTick, delta };
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
    // Direct replay/export sampling also performs seeks; reset animation/camera history at those cuts.
    if (this.lastShown < 0 || (Number.isFinite(this.lastRenderedTick) && (t < this.lastRenderedTick || (dt <= 0 && t !== this.lastRenderedTick)))) {
      rig.snap(); this.drawModel.snap();
    }
    this.lastRenderedTick = t;
    this.host.world.reconstructTrails(t * d.interval, seconds => {
      const tick = Math.max(0, Math.min(d.n, Math.floor(seconds / d.interval)));
      let at = this.trailHistory.get(tick);
      if (!at) {
        p.seek(tick);
        at = { transforms: p.brushOrigins(), states: this.core?.effectStates() };
        this.trailHistory.set(tick, at);
        if (this.trailHistory.size > 512) this.trailHistory.delete(this.trailHistory.keys().next().value!);
      }
      return at;
    });
    p.seek(i);
    const origins = p.brushOrigins();
    this.host.world.update(origins, t * d.interval, this.core?.effectStates());
    if (this.core) this.host.onWorldUpdate?.(this.core, origins);
    // Map-given guns (physics v5): the items on the floor and the gun in the bunny's hand at this tick.
    const weapons = this.core ? weaponReport(this.core) : null;
    if (weapons && (weapons.floorChanged || this.floorStale)) {
      this.floor.update(floorWeapons(this.core!));
      this.floorStale = false;
    }
    const cam = this.host.camera;
    const showModel = rig.update(cam, d, t, dt, this.trace);
    const s = (this.sample = sampleAt(d, t, this.sample));
    const model = this.drawModel;
    model.root.visible = showModel;
    this.playerShadow.update(s.pos, s.crouched, !showModel);
    {
      // Grounded if any tick since the last frame touched the ground (bhop lands for a single tick).
      let grounded = s.grounded;
      if (!grounded && this.lastShown >= 0 && i > this.lastShown && i - this.lastShown < 30) for (let k = this.lastShown + 1; k <= i && !grounded; k++) grounded = (d.flags[k] & F_GROUNDED) !== 0;
      // Carrot swings recorded in the replay (cosmetic trailer), during normal playback.
      const playing = this.lastShown >= 0 && i > this.lastShown && i - this.lastShown < 30;
      const attack = playing ? cosmeticBetween(d.replay.cosmetic, this.lastShown, i) : 0;
      if (showModel && attack && !this.exporting) emitWeaponEvent({ type: attack === 2 ? "stab" : "slash", source: "replay", position: [s.pos[0], s.pos[1], s.pos[2]] });
      // Inspect tricks (inspect trailer): the third-person gesture; seeks drop them (the model snaps).
      const ins = playing ? inspectBetween(d.replay.inspect, this.lastShown, i) : { sig: 0, held: false };
      if (showModel && ins.sig && !this.exporting) emitWeaponEvent({ type: "inspect", source: "replay", position: [s.pos[0], s.pos[1], s.pos[2]] });
      const pose: PlayerPose = { visualTime: t * d.interval, position: s.pos, velocity: s.vel, yaw: s.yaw, pitch: s.pitch, crouched: s.crouched, grounded, forwardmove: s.forward, sidemove: s.side, attack, inspect: ins.sig, inspectHeld: ins.held };
      model.setGun(weapons && weapons.active >= 2 ? WEAPON_IDS[weapons.active] : null);
      model.setGunSilencer(!!weapons && weapons.active >= 2 && weapons.silencer);
      model.setState(pose);
      model.update(dt);
    }
    this.lastShown = i;
    const c = this.compare;
    if (c) {
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
  }

  /** main.ts frame loop while the viewer is open. */
  frame(now: number): void {
    const dt = Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    if (this.exporting) return;
    const d = this.data;
    if (!d) {
      this.host.graphicsPipeline.render(this.host.scene, this.host.camera,0);
      return;
    }
    if (this.playing && !this.timeline.scrubbing) {
      const before=this.t;
      this.t += dt * this.speed * d.tickrate;
      if (this.t >= d.n) {
        this.t = d.n;
        this.playing = false;
        this.updateControls();
        this.gauntlet?.ended();
      }
      this.watchCount?.advance(dt, Math.max(0,Math.min(this.t,d.n)-before)*d.interval, document.visibilityState === "visible");
    }
    this.render(this.t, this.playing ? dt * this.speed : dt, this.rig);
    this.sound.frame(d, this.t, this.playing && !this.timeline.scrubbing, this.speed);
    if (this.hudOn) this.hud.update(d, this.t, this.deltaAt(this.t));
    this.timeline.setHead(this.t);
    this.timeline.render();
    this.gauntlet?.frame(d, this.t);
    const i = Math.floor(this.t);
    const total = d.n * d.interval;
    this.timeEl.textContent = `${formatTime(this.t * d.interval)} / ${formatTime(total)}`;
    this.tickEl.textContent = `tick ${i}`;
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
    this.sound.stop();
    this.playing = false;
    this.updateControls();
    // Fresh player model / ghost for the render, so no animation state carries over from viewing (the exporter
    // seeds Math.random first, so their construction is deterministic too).
    this.model.root.visible = false;
    this.drawModel = new PlayerModel({ style: "solid", playerGlow: this.model.playerGlow, loadout: this.replay?.loadout ?? { ...DEFAULT_LOADOUT } });
    this.playerShadow.bind(this.drawModel.root);
    this.drawModel.setNearFade(10, 34);
    this.host.scene.add(this.drawModel.root);
    if (this.compare) {
      this.compare.ghost.setVisible(false);
      this.drawGhost = new Ghost(this.compare.ghost.d);
      this.drawGhost.setRenderOrder(30);
      this.drawGhost.trace = this.compare.ghost.trace;
      this.host.scene.add(this.drawGhost.root);
    }
    this.lastShown = -1;
  }

  endExport(): void {
    this.exporting = false;
    if (this.drawModel !== this.model) {
      this.drawModel.root.removeFromParent();
      this.drawModel.dispose();
      this.drawModel = this.model;
      this.playerShadow.bind(this.model.root);
    }
    this.drawGhost?.dispose();
    this.drawGhost = null;
    this.host.resize();
    this.rig.snap();
    this.model.snap();
    this.lastNow = performance.now();
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
    openExportDialog(this, this.root);
  }

  // -------------------------------------------------------------------------------------------
  // Input

  private bindInput(): void {
    const stage = this.stage;
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
      if (document.pointerLockElement === stage) this.rig.free.look(e.movementX, e.movementY);
      else if (this.dragging && this.rig.mode !== "eye") {
        if (this.rig.mode !== "chase") this.setCam("chase");
        this.rig.chase.orbit(e.movementX, e.movementY);
      }
    });
    stage.addEventListener(
      "wheel",
      (e) => {
        if (this.rig.mode === "chase") this.rig.chase.zoomBy(Math.exp(e.deltaY * 0.001));
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
      case "KeyC":
        this.setClean(false);
        this.toggleCompareMenu();
        return true;
      case "KeyE":
        this.openExport();
        return true;
      case "KeyP":
        this.practiceFromHere();
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

