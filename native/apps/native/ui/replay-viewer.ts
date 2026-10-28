// The replay viewer over native playback, laid out like the web viewer (viewer/viewer.ts, viewer.css): the run's
// title along the top, and along the bottom the timeline, the transport, speed and camera, then Compare, Practice
// from here, Export MP4, the replay file, Share and Report. The host draws the replay behind the menu; this sends it
// controls and shows what it reports. The native vault (replays.ts) is the Replays screen when nothing is playing.

import "../../web/src/viewer/viewer.css";
import { api, lastKnownMe } from "../../web/src/api";
import { loadPBReplay } from "../../web/src/pb";
import { GHOST_CSS, type GhostKind } from "../../web/src/player/colors";
import { worldRecord } from "../../web/src/shared-reads";
import { styleLabel } from "../../web/src/styles";
import { formatTime } from "../../web/src/timer";
import { h } from "../../web/src/ui/dom";
import { runUrl, shareButton } from "../../web/src/ui/share";
import { ReplayWatchCount, replayWatchThreshold } from "../../web/src/viewer/watch-count";
import { trackName } from "../../web/src/zones";
import { base64Bytes } from "./base64";
import { REPLAY_CAMERAS, runSeconds, send, state, type ReplayCamera } from "./bridge";
import { watchingSplit } from "./gauntlet-watch";
import { ReplayExportDialog } from "./replay-export";
import { hostSupports, replayCompare, replayTimeline } from "./replay-host";
import { practiceFromReplay } from "./replay-practice";
import { clampToRange, shownRange, shownSeconds } from "./replay-range";
import { ReplayScrubber } from "./replay-scrubber";
import { ReplayTimeline } from "./replay-timeline";
import { canReport, openReport, watchedRun } from "./report";

/** The web viewer's speeds (viewer.ts SPEEDS); the host takes 0.1 to 4. */
const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];
/** The web viewer's camera names and keys (viewer/cameras.ts CAM_MODES). */
const CAMERA_LABELS: Record<ReplayCamera, { label: string; title: string }> = {
  eye: { label: "In-eye", title: "First person: the player's exact view (1)" },
  chase: { label: "Chase", title: "Third person behind the player (2)" },
  free: { label: "Free", title: "Free roam (3)" },
  flyby: { label: "Flyby", title: "Free path: a drone following the run (4)" },
  auto: { label: "Auto", title: "Auto-director: cuts between shots (5)" },
};
const SEEK_SECONDS = 5;
const FINE_SEEK_SECONDS = 1;
/** How long a seek waits for the host to show it before the host's tick counts again. */
const PENDING_SEEK_MS = 1500;
const MAX_REPLAY_BYTES = 8 << 20;
const HELP: readonly [string, string][] = [
  ["Space", "play / pause"],
  [", / .", "step one tick back / forward"],
  ["← / →", "±5 s (Shift ±1 s)"],
  ["Home / End", "start / end"],
  ["[ / ]", "slower / faster"],
  ["1–5 or F", "in-eye · chase · free · flyby · auto"],
  ["C", "compare with another replay"],
  ["E", "export MP4"],
  ["P", "practice from this moment"],
  ["Esc", "back"],
];

export interface ReplayViewerHooks {
  notice: (text: string) => void;
  /** Watching a gauntlet attempt: its split line and Previous / Next split (gauntlet-watch.ts). */
  splitBar: HTMLElement;
}

type Button = HTMLButtonElement;

function button(label: string, title: string, onclick: () => void, classes = ""): Button {
  return h(`button.rv-btn${classes}`, { type: "button", title, "aria-label": title, onclick }, label) as Button;
}

/** The server run being watched (a leaderboard or profile Watch), for Share, Report and the watch count. */
function serverRun(): { runId: string; name: string; id?: string } | null {
  const player = state.playback.player;
  if (player?.runId)
    return { runId: player.runId, name: player.name ?? "this player", ...(player.id ? { id: player.id } : {}) };
  const watched = watchedRun();
  return watched ? { runId: watched.runId, name: watched.name } : null;
}

export class ReplayViewer {
  readonly el: HTMLElement;
  private readonly titleEl = h("div.rv-title");
  private readonly subEl = h("div.rv-sub");
  private readonly noticeEl = h("div.rv-notice", { hidden: true });
  private readonly timeEl = h("span.rv-time");
  private readonly tickEl = h("span.rv-tick");
  private readonly helpEl: HTMLElement;
  private readonly playButton: Button;
  private readonly speedButtons = new Map<number, Button>();
  private readonly cameraButtons = new Map<ReplayCamera, Button>();
  private readonly fullButton: Button;
  private readonly compareButton: Button;
  private readonly compareMenu = h("div.rv-menu", { hidden: true, role: "menu" });
  private readonly practiceButton: Button;
  private readonly shareButton: Button;
  private readonly reportButton: Button;
  private readonly timeline: ReplayTimeline;
  private readonly scrubber: ReplayScrubber;
  private readonly exporter: ReplayExportDialog;
  private pendingTick: number | null = null;
  private pendingUntil = 0;
  private replayId = "";
  private watchCount: ReplayWatchCount | null = null;
  private lastTick = 0;
  private lastUpdate = 0;
  private readonly onKey = (event: KeyboardEvent) => this.key(event);
  private readonly offPracticeAnswer: () => void;

  constructor(private readonly hooks: ReplayViewerHooks) {
    this.timeline = new ReplayTimeline({ seek: (tick, final) => this.scrub(tick, final) });
    this.scrubber = new ReplayScrubber({
      seek: (tick) => send({ type: "replayControl", action: "seek", tick }),
      pause: (paused) => send({ type: "replayControl", action: "pause", paused }),
    });
    this.exporter = new ReplayExportDialog(hooks.notice);
    this.playButton = button("▶", "Play / pause (Space)", () => this.togglePlay(), ".rv-play");
    this.fullButton = button(
      "Full recording",
      "Show the whole recording, including time before the start and after the finish",
      () => this.toggleFull(),
      ".rv-chip",
    );
    this.compareButton = button(
      "Compare",
      "Overlay a second replay as a ghost (C)",
      () => this.toggleCompareMenu(),
      ".rv-chip",
    );
    this.practiceButton = button(
      "Practice from here",
      "Take over from this moment, in practice (P)",
      () => this.practice(),
      ".rv-chip",
    );
    this.shareButton = shareButton("rv-btn rv-chip", () => this.shareData(), "Replay link copied");
    this.reportButton = button("Report", "Report this player", () => this.report(), ".rv-chip.rv-report");
    this.helpEl = h(
      "div.rv-help",
      { hidden: true },
      h("h3", null, "Replay viewer"),
      h("dl", null, ...HELP.flatMap(([key, what]) => [h("dt", null, h("kbd", null, key)), h("dd", null, what)])),
    );
    const top = h(
      "header.rv-top",
      null,
      h("div.rv-titles", null, this.titleEl, this.subEl, this.noticeEl),
      h(
        "div.rv-top-actions",
        null,
        button(
          "?",
          "Keyboard shortcuts (?)",
          () => {
            this.helpEl.hidden = !this.helpEl.hidden;
          },
          ".rv-icon",
        ),
        button("✕", "Close replay viewer", () => send({ type: "replayControl", action: "stop" }), ".rv-icon"),
      ),
    );
    const panel = h(
      "footer.rv-panel",
      null,
      this.timeline.el,
      h(
        "div.rv-controls",
        null,
        this.transport(),
        h("div.rv-group", null, this.speeds(), this.cameras()),
        this.actions(),
      ),
      hooks.splitBar,
    );
    this.el = h(
      "div#rv.native-rv",
      { role: "dialog", "aria-label": "Replay viewer" },
      top,
      this.helpEl,
      panel,
      this.exporter.el,
    );
    addEventListener("keydown", this.onKey, true);
    this.offPracticeAnswer = practiceFromReplay.onAnswer(() => this.flash(practiceFromReplay.message()));
  }

  private transport(): HTMLElement {
    const step = (delta: number) => () => this.step(delta);
    return h(
      "div.rv-group",
      null,
      button("⏮", "Start (Home)", () => this.seek(shownRange(state.playback).start)),
      button("‹", "Previous tick (,)", step(-1)),
      this.playButton,
      button("›", "Next tick (.)", step(1)),
      button("⏭", "End (End)", () => this.seek(shownRange(state.playback).end)),
      h("div.rv-clock.native-playback-position", null, this.timeEl, this.tickEl),
    );
  }

  private speeds(): HTMLElement {
    const group = h("div.rv-seg", { role: "group", "aria-label": "Playback speed" });
    for (const speed of SPEEDS) {
      const pick = () => send({ type: "replayControl", action: "speed", speed });
      const control = button(`${speed}×`, `Playback speed ${speed}× ([ / ])`, pick, ".rv-seg-btn");
      this.speedButtons.set(speed, control);
      group.append(control);
    }
    return group;
  }

  private cameras(): HTMLElement {
    const group = h("div.rv-seg", { role: "group", "aria-label": "Camera" });
    for (const camera of REPLAY_CAMERAS) {
      const { label, title } = CAMERA_LABELS[camera];
      const control = button(label, title, () => this.setCamera(camera), ".rv-seg-btn");
      this.cameraButtons.set(camera, control);
      group.append(control);
    }
    return group;
  }

  private actions(): HTMLElement {
    const exportButton = button(
      "Export MP4",
      "Render this replay to an MP4 video (E)",
      () => this.exporter.open(),
      ".rv-chip.rv-accent",
    );
    const fileButton = button("⤓ .bhr", "Save the replay file to Downloads", () => this.saveFile(), ".rv-chip");
    this.shareButton.hidden = true;
    this.reportButton.hidden = true;
    return h(
      "div.rv-group.rv-right",
      null,
      this.fullButton,
      h("div.rv-menu-wrap", null, this.compareButton, this.compareMenu),
      this.practiceButton,
      exportButton,
      fileButton,
      this.shareButton,
      this.reportButton,
    );
  }

  /** Removes the key listener and cancels a drag. The screen calls it when the viewer leaves the page. */
  dispose(): void {
    removeEventListener("keydown", this.onKey, true);
    this.offPracticeAnswer();
    this.scrubber.cancel(false);
  }

  private flash(text: string): void {
    this.noticeEl.textContent = text;
    this.noticeEl.hidden = !text;
  }

  private shownTick(): number {
    return this.scrubber.active ? this.scrubber.value : (this.pendingTick ?? state.playback.tick);
  }

  private seek(tick: number): void {
    const target = clampToRange(shownRange(state.playback), tick);
    this.pendingTick = target;
    this.pendingUntil = performance.now() + PENDING_SEEK_MS;
    this.watchCount?.seek();
    send({ type: "replayControl", action: "seek", tick: target });
    this.paintClock();
  }

  private scrub(tick: number, final: boolean): void {
    const target = clampToRange(shownRange(state.playback), tick);
    if (!this.scrubber.active) this.scrubber.begin(state.playback.paused, target);
    if (!final) {
      this.scrubber.update(target);
      this.paintClock();
      return;
    }
    this.pendingTick = target;
    this.pendingUntil = performance.now() + PENDING_SEEK_MS;
    this.watchCount?.seek();
    this.scrubber.finish(target);
    this.paintClock();
  }

  private step(delta: number): void {
    send({ type: "replayControl", action: "pause", paused: true });
    this.seek(this.shownTick() + delta);
  }

  private togglePlay(): void {
    send({ type: "replayControl", action: "pause", paused: !state.playback.paused });
  }

  private nudgeSpeed(direction: -1 | 1): void {
    const index = SPEEDS.findIndex((speed) => speed >= state.playback.speed - 1e-6);
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (index < 0 ? SPEEDS.length - 1 : index) + direction))];
    send({ type: "replayControl", action: "speed", speed: next });
  }

  private setCamera(camera: ReplayCamera): void {
    send({ type: "replayControl", action: "camera", camera });
  }

  private cycleCamera(): void {
    const index = REPLAY_CAMERAS.indexOf(state.playback.camera ?? "eye");
    this.setCamera(REPLAY_CAMERAS[(index + 1) % REPLAY_CAMERAS.length]);
  }

  private toggleFull(): void {
    send({ type: "replayControl", action: "fullRecording", value: !state.playback.fullRecording });
  }

  private practice(): void {
    const dragged = this.scrubber.active || this.pendingTick !== null;
    practiceFromReplay.request(dragged ? this.shownTick() : undefined);
    this.flash(practiceFromReplay.message());
  }

  private saveFile(): void {
    if (state.playback.id) send({ type: "replay", action: "export", id: state.playback.id });
  }

  private shareData(): { url: string; title: string } {
    const run = serverRun();
    return { url: runUrl(run?.runId ?? ""), title: `${run?.name ?? "Replay"} · ${state.map ?? ""} · bunnyhop.lol` };
  }

  private report(): void {
    const run = serverRun();
    if (run)
      openReport({
        ...(run.id ? { id: run.id } : {}),
        name: run.name,
        run: { id: run.runId, map: state.map ?? "", time: null },
      });
  }

  // Compare (web viewer toggleCompareMenu / setCompare): the host plays the second replay as a ghost.

  private toggleCompareMenu(): void {
    if (!this.compareMenu.hidden) {
      this.compareMenu.hidden = true;
      return;
    }
    const map = state.map ?? "";
    const { style, track } = state.player ?? state;
    const item = (label: string, sub: string, action: () => void, disabled = false) => {
      const choose = () => {
        this.compareMenu.hidden = true;
        action();
      };
      return h(
        "button.rv-menu-item",
        { type: "button", role: "menuitem", disabled, onclick: choose },
        h("span", null, label),
        h("small", null, sub),
      );
    };
    const file = h("input", {
      type: "file",
      accept: ".bhr,application/octet-stream",
      hidden: true,
    }) as HTMLInputElement;
    file.addEventListener("change", () => void this.compareFile(file.files?.[0]));
    const current = replayCompare();
    const online = api.available();
    this.compareMenu.replaceChildren(
      item(
        "Your PB",
        `${trackName(track)} · ${styleLabel(style)}`,
        () => void this.compareWith("pb", () => this.pbBytes(map, style, track)),
      ),
      item(
        "World record",
        online ? "Top of the leaderboard" : "Leaderboards offline",
        () => void this.compareWorldRecord(map, style, track),
        !online,
      ),
      item("Replay file…", ".bhr from disk", () => file.click()),
      ...(current ? [item("Remove ghost", current.name, () => send({ type: "replayCompare", action: "clear" }))] : []),
      file,
    );
    this.compareMenu.hidden = false;
  }

  private async pbBytes(map: string, style: string, track: number): Promise<{ bytes: Uint8Array; name: string }> {
    const bytes = await loadPBReplay(map, style, track);
    if (!bytes) throw new Error("No replay is saved for this PB.");
    return { bytes, name: "Your PB" };
  }

  private async compareWorldRecord(map: string, style: string, track: number): Promise<void> {
    await this.compareWith("wr", async () => {
      const top = await worldRecord(map, style, track);
      if (!top) throw new Error("No world record on this board yet.");
      return { bytes: await api.replay(top.runId), name: `WR · ${top.player.name}` };
    });
  }

  private async compareFile(file: File | undefined): Promise<void> {
    if (!file) return;
    await this.compareWith("custom", async () => {
      if (file.size > MAX_REPLAY_BYTES) throw new Error("Replay exceeds 8 MiB.");
      return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name.replace(/\.bhr$/, "") };
    });
  }

  private async compareWith(kind: GhostKind, load: () => Promise<{ bytes: Uint8Array; name: string }>): Promise<void> {
    try {
      const { bytes, name } = await load();
      send({ type: "replayCompare", action: "set", kind, name: name.slice(0, 128), replayBase64: base64Bytes(bytes) });
    } catch (error) {
      this.flash(`Compare: ${(error as Error).message}`);
    }
  }

  private key(event: KeyboardEvent): void {
    if (!this.el.isConnected || this.exporter.isOpen || event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, select, textarea") || document.querySelector("dialog[open]")) return;
    if (this.handleKey(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  private handleKey(event: KeyboardEvent): boolean {
    const range = shownRange(state.playback);
    const jump = (event.shiftKey ? FINE_SEEK_SECONDS : SEEK_SECONDS) / range.interval;
    const camera = /^Digit([1-5])$/.exec(event.code);
    if (camera) {
      this.setCamera(REPLAY_CAMERAS[Number(camera[1]) - 1]);
      return true;
    }
    const actions: Record<string, () => void> = {
      Space: () => this.togglePlay(),
      Comma: () => this.step(-1),
      Period: () => this.step(1),
      ArrowLeft: () => this.seek(this.shownTick() - jump),
      ArrowRight: () => this.seek(this.shownTick() + jump),
      Home: () => this.seek(range.start),
      End: () => this.seek(range.end),
      BracketLeft: () => this.nudgeSpeed(-1),
      BracketRight: () => this.nudgeSpeed(1),
      KeyF: () => this.cycleCamera(),
      KeyC: () => {
        if (!this.compareButton.hidden) this.toggleCompareMenu();
      },
      KeyE: () => this.exporter.open(),
      KeyP: () => {
        if (!this.practiceButton.hidden) this.practice();
      },
      Slash: () => {
        this.helpEl.hidden = !this.helpEl.hidden;
      },
    };
    const action = actions[event.code];
    if (event.code === "Escape" && !this.compareMenu.hidden) {
      this.compareMenu.hidden = true;
      return true;
    }
    if (!action || (event.repeat && event.code !== "ArrowLeft" && event.code !== "ArrowRight")) return false;
    action();
    return true;
  }

  private paintTitle(): void {
    const playback = state.playback;
    const replay = state.replays.find((item) => item.id === playback.id);
    const name = playback.player?.name ?? serverRun()?.name ?? replay?.name ?? "Replay";
    const seconds = (replay ? runSeconds(replay) : null) ?? runSeconds({ timeMs: playback.timeMs });
    const time = seconds !== null ? formatTime(seconds) : "";
    this.titleEl.replaceChildren(h("b", null, name), time ? h("span.rv-time-big", null, time) : "");
    const style = state.player?.style ?? replay?.style ?? state.style;
    const track = state.player?.track ?? replay?.track ?? 0;
    const recorded = replay ? new Date(replay.recordedAt).toLocaleDateString() : "";
    this.subEl.textContent = [
      state.map ?? replay?.map ?? "",
      track ? trackName(track) : "",
      styleLabel(style),
      recorded,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  private paintClock(): void {
    const playback = state.playback;
    const range = shownRange(playback);
    const tick = this.shownTick();
    const now = formatTime(shownSeconds(range, playback, tick));
    const total = formatTime(range.ticks * range.interval);
    this.timeEl.textContent = `${now} / ${total}`;
    this.tickEl.textContent = `tick ${tick}`;
    this.timeline.setHead(tick, `${now} of ${total}`);
  }

  private paintControls(): void {
    const playback = state.playback;
    this.playButton.textContent = playback.paused ? "▶" : "❚❚";
    for (const [speed, control] of this.speedButtons)
      control.classList.toggle("on", Math.abs(speed - playback.speed) < 1e-6);
    for (const [camera, control] of this.cameraButtons)
      control.classList.toggle("on", camera === (playback.camera ?? "eye"));
    this.fullButton.classList.toggle("on", !!playback.fullRecording);
    this.fullButton.setAttribute("aria-pressed", String(!!playback.fullRecording));
    const compare = replayCompare();
    this.compareButton.hidden = !hostSupports("compare");
    this.compareButton.textContent = compare ? `vs ${compare.name}` : "Compare";
    this.compareButton.classList.toggle("on", !!compare);
    if (compare) this.compareButton.style.setProperty("--chip", GHOST_CSS[compare.kind]);
    else this.compareButton.style.removeProperty("--chip");
    const run = serverRun();
    this.shareButton.hidden = !run;
    const mine = !!run && (run.id ? run.id === lastKnownMe()?.id : run.name === lastKnownMe()?.name);
    this.reportButton.hidden = !run || mine || !canReport({ ...(run.id ? { id: run.id } : {}), name: run.name });
  }

  /** Counts a view of a server run once enough of it has played (web viewer watch-count.ts). */
  private countWatching(): void {
    const playback = state.playback;
    const now = performance.now();
    const run = serverRun();
    if (playback.id !== this.replayId) {
      this.replayId = playback.id;
      this.watchCount = null;
      if (run && api.available()) {
        const range = shownRange(playback);
        const tracker = new ReplayWatchCount(replayWatchThreshold(range.ticks * range.interval), (token) =>
          api.recordReplayView(run.runId, token),
        );
        this.watchCount = tracker;
        void api
          .startReplayView(run.runId)
          .then((token) => tracker.ready(token))
          .catch(() => {});
      }
    } else if (!playback.paused && playback.tick > this.lastTick) {
      const replaySeconds = (playback.tick - this.lastTick) * shownRange(playback).interval;
      this.watchCount?.advance((now - this.lastUpdate) / 1000, replaySeconds, document.visibilityState === "visible");
    }
    this.lastTick = playback.tick;
    this.lastUpdate = now;
  }

  /** Call on every host state. */
  update(): void {
    const playback = state.playback;
    if (playback.id !== this.replayId) this.scrubber.cancel(false);
    this.countWatching();
    if (this.pendingTick !== null) {
      const caughtUp = Math.abs(playback.tick - this.pendingTick) <= 2 || performance.now() > this.pendingUntil;
      if (caughtUp) this.pendingTick = null;
    }
    const range = shownRange(playback);
    this.timeline.setRange(range);
    this.timeline.setData(replayTimeline(playback.id));
    const compare = replayCompare();
    this.timeline.setCompare(compare?.endTick ?? null, compare ? GHOST_CSS[compare.kind] : "");
    practiceFromReplay.update();
    // A gauntlet split continues the gauntlet, not practice (the web viewer hides it there too).
    this.practiceButton.hidden = !!watchingSplit();
    const reason = practiceFromReplay.message();
    if (reason) this.flash(reason);
    this.paintTitle();
    this.paintClock();
    this.paintControls();
    this.exporter.refresh();
  }
}
