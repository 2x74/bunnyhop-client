// "Export MP4" in the replay viewer: the web viewer's export card (viewer/export.ts, viewer.css .rv-modal) over the
// native exporter. The host renders and encodes with FFmpeg into Downloads; this only picks the options and shows its
// progress (state.videoExport).

import { h } from "../../web/src/ui/dom";
import { send, state, type VideoExportOptions } from "./bridge";
import { shownRange } from "./replay-range";

type Format = "landscape" | "portrait";
interface Choice<T> {
  id: T;
  label: string;
}

const FORMATS: readonly Choice<Format>[] = [
  { id: "landscape", label: "Landscape 16:9" },
  { id: "portrait", label: "Portrait 9:16" },
];
const RESOLUTIONS: readonly Choice<string>[] = [
  { id: "1280x720", label: "720p" },
  { id: "1920x1080", label: "1080p" },
  { id: "2560x1440", label: "1440p" },
];
const FRAME_RATES: readonly Choice<number>[] = [30, 60, 120].map((fps) => ({ id: fps, label: `${fps} fps` }));
const QUALITIES: readonly Choice<VideoExportOptions["quality"]>[] = [
  { id: "standard", label: "Standard" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
];
// The web export's camera names (viewer/export.ts EXPORT_CAMS).
const CAMERAS: readonly Choice<VideoExportOptions["camera"]>[] = [
  { id: "eye", label: "In-eye" },
  { id: "chase", label: "Chase" },
  { id: "flyby", label: "Free path (flyby)" },
  { id: "auto", label: "Auto-director" },
];
const MAX_MUSIC_OFFSET_SECONDS = 1800;

interface Picked {
  format: Format;
  resolution: string;
  fps: number;
  quality: VideoExportOptions["quality"];
  camera: VideoExportOptions["camera"];
  music: string;
}

function numberInput(label: string, attributes: Record<string, number>): HTMLInputElement {
  return h("input", { type: "number", "aria-label": label, ...attributes }) as HTMLInputElement;
}

function checkbox(label: string, checked: boolean): HTMLInputElement {
  return h("input", { type: "checkbox", checked, "aria-label": label }) as HTMLInputElement;
}

function checkRow(input: HTMLInputElement, label: string, sub?: string): HTMLElement {
  return h("label.rv-check", null, input, h("span", null, label, sub ? h("small", null, sub) : null));
}

export class ReplayExportDialog {
  readonly el: HTMLElement;
  private readonly picked: Picked = {
    format: "landscape",
    resolution: "1280x720",
    fps: 60,
    quality: "high",
    camera: "eye",
    music: "none",
  };
  private readonly hud = checkbox("Video HUD", true);
  private readonly audio = checkbox("Include gameplay audio", true);
  private readonly full = checkbox("Export full recording", false);
  private readonly from = numberInput("Video clip start seconds", { min: 0, step: 0.01, value: 0 });
  private readonly to = numberInput("Video clip end seconds", { min: 0, step: 0.01, value: 0 });
  private readonly musicOffset = numberInput("Music start offset seconds", {
    min: 0,
    max: MAX_MUSIC_OFFSET_SECONDS,
    step: 0.01,
    value: 0,
  });
  private readonly musicLevel = numberInput("Export music level", { min: 0, max: 1, step: 0.05, value: 1 });
  private readonly musicLoop = checkbox("Loop export music", true);
  private readonly musicDuck = checkbox("Duck music under gameplay audio", true);
  private musicRow: HTMLElement = h("div.rv-field");
  private readonly musicExtras = h("div.rv-checks");
  private readonly musicNote = h("small.rv-ex-note");
  private readonly warning = h("p.rv-ex-warn", { hidden: true });
  private readonly bar = h("div.rv-ex-fill");
  private readonly status = h("div.rv-ex-status", { role: "status" });
  private readonly progress = h(
    "div.rv-ex-progress",
    { hidden: true },
    h("div.rv-ex-bar", null, this.bar),
    this.status,
  );
  private readonly start = h(
    "button.rv-btn.rv-chip.rv-accent",
    { type: "button" },
    "Save MP4 to Downloads",
  ) as HTMLButtonElement;
  private readonly cancel = h("button.rv-btn.rv-chip", { type: "button" }, "Close") as HTMLButtonElement;
  private clipEdited = false;
  private clipKey = "";
  private replayId = "";
  private musicKey = "";

  constructor(private readonly notice: (text: string) => void) {
    for (const field of [this.from, this.to])
      field.addEventListener("input", () => {
        this.clipEdited = true;
      });
    this.audio.addEventListener("change", () => this.refresh());
    this.start.addEventListener("click", () => this.submit());
    this.cancel.addEventListener("click", () => this.dismiss());
    const body = h(
      "div.rv-ex-body",
      null,
      this.segment(
        "Format",
        FORMATS,
        () => this.picked.format,
        (value) => {
          this.picked.format = value;
        },
      ),
      this.segment(
        "Resolution",
        RESOLUTIONS,
        () => this.picked.resolution,
        (value) => {
          this.picked.resolution = value;
        },
      ),
      this.segment(
        "Frame rate",
        FRAME_RATES,
        () => this.picked.fps,
        (value) => {
          this.picked.fps = value;
        },
      ),
      this.segment(
        "Quality",
        QUALITIES,
        () => this.picked.quality,
        (value) => {
          this.picked.quality = value;
        },
      ),
      this.segment(
        "Camera",
        CAMERAS,
        () => this.picked.camera,
        (value) => {
          this.picked.camera = value;
        },
      ),
      h(
        "div.rv-field",
        null,
        h("label", null, "Overlay"),
        h("div.rv-checks", null, checkRow(this.hud, "HUD", "speed, timer, sync")),
      ),
      h(
        "div.rv-field",
        null,
        h("label", null, "Sound"),
        h("div.rv-checks", null, checkRow(this.audio, "Gameplay audio", "follows your volume and mutes")),
      ),
      this.musicRow,
      h(
        "div.rv-field",
        null,
        h("label", null, "Clip range"),
        h(
          "div.rv-ex-inputs",
          null,
          checkRow(this.full, "Full recording", "the whole file, not 1 s before to 1.5 s after the run"),
          h("label.rv-check", null, "Start (s)", this.from),
          h("label.rv-check", null, "End (s)", this.to),
          h("small", null, "Times on the timeline. Leave them as filled in for the whole range."),
        ),
      ),
      this.warning,
    );
    const card = h(
      "div.rv-card",
      null,
      h("h3", null, "Export MP4"),
      h("p.dim", null, "Rendered on this computer with FFmpeg and saved to Downloads."),
      body,
      this.progress,
      h("div.rv-ex-actions", null, this.cancel, this.start),
    );
    this.el = h("div.rv-modal", { role: "dialog", "aria-label": "Export MP4", hidden: true }, card);
    this.el.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.dismiss();
    });
  }

  open(): void {
    this.el.hidden = false;
    this.refresh();
    this.start.focus({ preventScroll: true });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  private dismiss(): void {
    const video = state.videoExport;
    if (video.state === "capturing" || video.state === "encoding") send({ type: "videoExport", action: "cancel" });
    else this.el.hidden = true;
  }

  private segment<T extends string | number>(
    name: string,
    choices: readonly Choice<T>[],
    get: () => T,
    set: (value: T) => void,
  ): HTMLElement {
    return h("div.rv-field", null, h("label", null, name), this.segmentRow(name, choices, get, set));
  }

  private segmentRow<T extends string | number>(
    name: string,
    choices: readonly Choice<T>[],
    get: () => T,
    set: (value: T) => void,
  ): HTMLElement {
    const row = h("div.rv-seg", { role: "radiogroup", "aria-label": name });
    const paint = () => {
      for (const [index, button] of [...row.children].entries()) {
        const on = choices[index].id === get();
        button.classList.toggle("on", on);
        button.setAttribute("aria-checked", String(on));
      }
    };
    for (const choice of choices) {
      const select = () => {
        set(choice.id);
        paint();
        this.refresh();
      };
      row.append(h("button.rv-seg-btn", { type: "button", role: "radio", onclick: select }, choice.label));
    }
    paint();
    return row;
  }

  /** The clip as absolute ticks, {} for the default range, or null when the fields don't make a clip. */
  private clipTicks(): { from?: number; to?: number } | null {
    if (!this.clipEdited) return {};
    const range = shownRange(state.playback);
    const from = range.start + Math.round(this.from.valueAsNumber / range.interval);
    const to = range.start + Math.round(this.to.valueAsNumber / range.interval);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
    if (from < range.start || to <= from || to > range.end) return null;
    return { from, to };
  }

  private musicValid(): boolean {
    const offset = this.musicOffset.valueAsNumber;
    const level = this.musicLevel.valueAsNumber;
    const offsetValid = Number.isFinite(offset) && offset >= 0 && offset <= MAX_MUSIC_OFFSET_SECONDS;
    return offsetValid && Number.isFinite(level) && level >= 0 && level <= 1;
  }

  private submit(): void {
    const clip = this.clipTicks();
    if (!clip) {
      this.notice("Choose a clip end after its start, within this replay.");
      return;
    }
    if (!this.musicValid()) {
      this.notice("Choose a music offset from 0 to 1800 seconds and level from 0 to 1.");
      return;
    }
    const size = this.picked.resolution.split("x").map(Number);
    if (this.picked.format === "portrait") size.reverse();
    const options: VideoExportOptions = {
      width: size[0],
      height: size[1],
      fps: this.picked.fps,
      quality: this.picked.quality,
      camera: this.picked.camera,
      hud: this.hud.checked,
      audio: this.audio.checked,
      music: this.picked.music,
      musicOffset: this.musicOffset.valueAsNumber,
      musicLevel: this.musicLevel.valueAsNumber,
      musicLoop: this.musicLoop.checked,
      musicDuck: this.musicDuck.checked,
      fullRecording: this.full.checked,
      ...clip,
    };
    send({ type: "videoExport", action: "start", options });
  }

  /** Fills the clip with the shown range, once per replay and range. */
  private fillClip(): void {
    const range = shownRange(state.playback);
    const key = `${state.playback.id}:${range.start}:${range.end}`;
    if (this.replayId !== state.playback.id) {
      this.replayId = state.playback.id;
      this.full.checked = false;
    }
    if (key === this.clipKey) return;
    this.clipKey = key;
    this.from.value = "0";
    this.to.value = String(Math.floor(range.ticks * range.interval * 100) / 100);
    this.clipEdited = false;
  }

  private paintMusic(busy: boolean): void {
    const tracks = state.videoExport.musicTracks;
    const key = JSON.stringify(tracks);
    if (key !== this.musicKey) {
      this.musicKey = key;
      if (!tracks.some((track) => track.id === this.picked.music)) this.picked.music = "none";
      const choices = [{ id: "none", label: "None" }, ...tracks.map((track) => ({ id: track.id, label: track.title }))];
      const tracksRow = this.segmentRow(
        "Music",
        choices,
        () => this.picked.music,
        (value) => {
          this.picked.music = value;
        },
      );
      const offset = h("label.rv-check", null, "Song offset (s)", this.musicOffset);
      const level = h("label.rv-check", null, "Music level (0–1)", this.musicLevel);
      const loop = checkRow(this.musicLoop, "Loop song");
      this.musicExtras.replaceChildren(offset, level, loop, checkRow(this.musicDuck, "Duck under gameplay"));
      const inputs = h("div.rv-ex-inputs", null, tracksRow, this.musicExtras, this.musicNote);
      const row = h("div.rv-field", null, h("label", null, "Music"), inputs);
      this.musicRow.replaceWith(row);
      this.musicRow = row;
    }
    const silent = this.picked.music === "none";
    for (const control of [this.musicOffset, this.musicLevel, this.musicLoop]) control.disabled = busy || silent;
    this.musicDuck.disabled = busy || silent || !this.audio.checked;
    this.musicExtras.hidden = silent;
    this.musicNote.textContent = this.musicMessage(tracks.length > 0);
    this.musicNote.hidden = silent && tracks.length > 0 && !state.settings.muted;
  }

  private musicMessage(hasTracks: boolean): string {
    const settings = state.settings;
    if (settings.muted) return "Master audio is muted; this export will be silent.";
    if (settings.muteMusic || settings.musicVolume === 0) return "Music is muted in Sound settings.";
    if (hasTracks) return "The level multiplies your music volume. Custom songs come from your bgm folder.";
    return "No gameplay tracks in this music pack. Add custom songs in Sound settings or choose the bunnyhop.lol pack.";
  }

  /** Call on every host state. */
  refresh(): void {
    const video = state.videoExport;
    const busy = video.state === "capturing" || video.state === "encoding";
    this.fillClip();
    for (const control of this.el.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      ".rv-ex-body :is(input, button)",
    )) {
      control.disabled = busy;
    }
    this.paintMusic(busy);
    this.start.disabled = busy || !video.available || !state.playback.active;
    this.cancel.textContent = busy ? "Cancel export" : "Close";
    this.warning.hidden = video.available || busy;
    this.warning.textContent = video.reason;
    this.progress.hidden = !busy && video.state === "idle";
    this.bar.style.transform = `scaleX(${busy ? video.progress : video.state === "completed" ? 1 : 0})`;
    this.status.textContent = this.statusText();
  }

  private statusText(): string {
    const video = state.videoExport;
    if (video.state === "completed") return `Saved: ${video.path}`;
    if (video.state === "error") return video.error;
    if (video.state === "canceled") return "Export canceled.";
    if (video.state === "capturing" || video.state === "encoding") {
      const step = video.state === "capturing" ? "Capturing" : "Encoding";
      return `${step} ${video.frames}/${video.totalFrames} frames (${Math.round(video.progress * 100)}%)`;
    }
    return "";
  }
}
