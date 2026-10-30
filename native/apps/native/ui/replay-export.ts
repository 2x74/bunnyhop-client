// Export video, from the replay viewer or the Replays list: the web viewer's export card (viewer/export.ts,
// viewer.css .rv-modal) over the native exporter. The host renders each export in its own process with FFmpeg and
// saves it to Downloads (src/video_worker.hpp), one after another, while the game keeps running. This picks the
// options, queues exports and shows the queue (video-queue.ts).

import { h } from "../../web/src/ui/dom";
import { send, state, type VideoExportOptions } from "./bridge";
import { shownRange } from "./replay-range";
import { jobRunning, megabytes, VideoQueuePanel, videoCodecs, videoJobs, type VideoCodec } from "./video-queue";

type Format = "landscape" | "portrait";
type Quality = VideoExportOptions["quality"];
type Camera = VideoExportOptions["camera"];
type Encoder = NonNullable<VideoExportOptions["encoder"]>;
type Look = NonNullable<VideoExportOptions["look"]>;
type Samples = NonNullable<VideoExportOptions["samples"]>;
type Toggle = "hud" | "speed" | "keys" | "graph" | "crosshair" | "weapon" | "audio" | "audioFile";
interface Choice<T> {
  id: T;
  label: string;
}

const RESOLUTIONS = [
  { id: "720p", width: 1280, height: 720, label: "720p" },
  { id: "1080p", width: 1920, height: 1080, label: "1080p" },
  { id: "1440p", width: 2560, height: 1440, label: "1440p" },
  { id: "2160p", width: 3840, height: 2160, label: "4K" },
  { id: "4320p", width: 7680, height: 4320, label: "8K" },
] as const;
const CUSTOM = "custom";
const FRAME_RATES = [24, 30, 60, 120, 144, 240] as const;
const QUALITIES: readonly Choice<Quality>[] = [
  { id: "standard", label: "Standard" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
  { id: "edit", label: "Edit-ready" },
];
const CODEC_LABELS: Record<VideoCodec, string> = {
  h264: "H.264",
  hevc: "HEVC",
  av1: "AV1",
  prores: "ProRes",
  dnxhr: "DNxHR",
  ffv1: "Lossless",
  png: "PNG frames",
};
const ENCODERS: readonly Choice<Encoder>[] = [
  { id: "auto", label: "Auto" },
  { id: "hardware", label: "Hardware" },
  { id: "software", label: "Software" },
];
const LOOKS: readonly Choice<Look>[] = [
  { id: "settings", label: "As in Settings" },
  { id: "source", label: "Source" },
  { id: "plain", label: "Plain" },
  { id: "enhanced", label: "Enhanced" },
  { id: "cinematic", label: "Cinematic" },
];
// The web export's camera names (viewer/export.ts EXPORT_CAMS), and native's orbit.
const CAMERAS: readonly Choice<Camera>[] = [
  { id: "eye", label: "In-eye" },
  { id: "chase", label: "Chase" },
  { id: "flyby", label: "Free path (flyby)" },
  { id: "orbit", label: "Orbit" },
  { id: "auto", label: "Auto-director" },
];
/** The website's motion blur levels (viewer/export-options.ts MOTION_BLUR). */
const MOTION_BLUR = [
  { id: "off", label: "Off", samples: 1, shutter: 0 },
  { id: "light", label: "Light", samples: 4, shutter: 90 },
  { id: "strong", label: "Strong", samples: 8, shutter: 180 },
] as const;
const SAMPLES: readonly Samples[] = [1, 2, 4, 8, 16];
const SHUTTERS = [0, 90, 180, 360] as const;
const MAX_MUSIC_OFFSET_SECONDS = 1800;
const MIN_SIDE = 16;
const MAX_SIDE = 7680;
const MAX_PIXELS = 7680 * 4320;
/** Above this, an export takes noticeably long: the dialog says so (web exportCost). */
const SLOW_COST = 6;
const SHORTS_SECONDS = 180;
const SETTINGS_KEY = "bunnyhop:native-export";
const MINE_KEY = "bunnyhop:native-export:mine";

interface ExportSettings {
  format: Format;
  resolution: string;
  customWidth: number;
  customHeight: number;
  fps: number;
  quality: Quality;
  codec: VideoCodec;
  encoder: Encoder;
  look: Look;
  camera: Camera;
  supersample: 1 | 2;
  samples: Samples;
  shutter: number;
  hud: boolean;
  speed: boolean;
  keys: boolean;
  graph: boolean;
  crosshair: boolean;
  weapon: boolean;
  audio: boolean;
  audioFile: boolean;
  music: string;
}

/** The website's Standard export (viewer/export.ts DEFAULT_EXPORT), with the music off as native has always had it. */
const STANDARD: ExportSettings = {
  format: "landscape",
  resolution: "1080p",
  customWidth: 1920,
  customHeight: 1080,
  fps: 60,
  quality: "high",
  codec: "h264",
  encoder: "auto",
  look: "settings",
  camera: "chase",
  supersample: 1,
  samples: 1,
  shutter: 0,
  hud: true,
  speed: true,
  keys: true,
  graph: false,
  crosshair: false,
  weapon: true,
  audio: true,
  audioFile: false,
  music: "none",
};
const SHORTS: Partial<ExportSettings> = {
  format: "portrait",
  resolution: "1080p",
  fps: 60,
  camera: "eye",
  hud: true,
  speed: true,
  keys: false,
  graph: false,
};
/** A clean intermediate for an editor: no overlays or music, ProRes where FFmpeg has it, the sound also as a WAV. */
const EDITING: Partial<ExportSettings> = {
  quality: "edit",
  fps: 60,
  hud: false,
  speed: false,
  keys: false,
  graph: false,
  crosshair: false,
  music: "none",
  audioFile: true,
};

const oneOf = <T>(value: unknown, choices: readonly T[], fallback: T): T =>
  choices.includes(value as T) ? (value as T) : fallback;

function side(value: unknown, fallback: number): number {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number >= MIN_SIDE && number <= MAX_SIDE ? number - (number % 2) : fallback;
}

/** Saved settings, checked field by field; anything unknown keeps the default. */
function normalize(value: unknown, base: ExportSettings = STANDARD): ExportSettings {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const flag = (key: Toggle) => (typeof v[key] === "boolean" ? (v[key] as boolean) : base[key]);
  return {
    format: oneOf(v.format, ["landscape", "portrait"] as const, base.format),
    resolution: oneOf(v.resolution, [...RESOLUTIONS.map((r) => r.id as string), CUSTOM], base.resolution),
    customWidth: side(v.customWidth, base.customWidth),
    customHeight: side(v.customHeight, base.customHeight),
    fps: oneOf(v.fps, FRAME_RATES as readonly number[], base.fps),
    quality: oneOf(
      v.quality,
      QUALITIES.map((q) => q.id),
      base.quality,
    ),
    codec: oneOf(v.codec, Object.keys(CODEC_LABELS) as VideoCodec[], base.codec),
    encoder: oneOf(
      v.encoder,
      ENCODERS.map((e) => e.id),
      base.encoder,
    ),
    look: oneOf(
      v.look,
      LOOKS.map((l) => l.id),
      base.look,
    ),
    camera: oneOf(
      v.camera,
      CAMERAS.map((c) => c.id),
      base.camera,
    ),
    supersample: oneOf(v.supersample, [1, 2] as const, base.supersample),
    samples: oneOf(v.samples, SAMPLES, base.samples),
    shutter: oneOf(v.shutter, SHUTTERS as readonly number[], base.shutter),
    hud: flag("hud"),
    speed: flag("speed"),
    keys: flag("keys"),
    graph: flag("graph"),
    crosshair: flag("crosshair"),
    weapon: flag("weapon"),
    audio: flag("audio"),
    audioFile: flag("audioFile"),
    music: typeof v.music === "string" && v.music.length <= 256 ? v.music : base.music,
  };
}

function load(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

/** Width and height of the picked size, portrait swapping them. */
export function exportSize(settings: ExportSettings): { width: number; height: number } {
  const preset = RESOLUTIONS.find((r) => r.id === settings.resolution);
  const width = preset?.width ?? settings.customWidth;
  const height = preset?.height ?? settings.customHeight;
  return settings.format === "portrait" ? { width: height, height: width } : { width, height };
}

/** Render cost against a plain 1080p60 export of the same clip (web exportCost). */
function exportCost(settings: ExportSettings): number {
  const { width, height } = exportSize(settings);
  const scale = settings.supersample * settings.supersample;
  return (width * height * settings.fps * settings.samples * scale) / (1920 * 1080 * 60);
}

/** The website's bitrates per bits per pixel per frame, for the size estimate of the lossy codecs. */
function estimatedBytes(settings: ExportSettings, seconds: number): number | null {
  if (!["h264", "hevc", "av1"].includes(settings.codec)) return null;
  const { width, height } = exportSize(settings);
  const bitsPerPixel = { standard: 0.12, high: 0.2, max: 0.35, edit: 1.2 }[settings.quality];
  const cap = settings.quality === "edit" ? 240e6 : 80e6;
  return (Math.min(cap, width * height * settings.fps * bitsPerPixel) * seconds) / 8;
}

function motionBlurOf(settings: ExportSettings): string {
  const level = MOTION_BLUR.find((m) => m.samples === settings.samples && m.shutter === settings.shutter);
  return level?.id ?? (settings.samples === 1 ? "off" : "custom");
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

const section = (title: string, ...rows: (Node | null)[]) =>
  h("section.rv-ex-sec", null, h("h4", null, title), ...rows);

/** Replays from the vault for an export without opening them. */
export interface ExportFile {
  id: string;
  map: string;
  name: string;
}

export interface ExportHooks {
  notice: (text: string) => void;
  /** The open replay's title for the queue ("man · bhop_rose"). */
  title?: () => string;
  /** The viewer's loop (A–B) in absolute ticks, offered as the clip. */
  loop?: () => { from: number; to: number } | null;
  closed?: () => void;
}

export class ReplayExportDialog {
  readonly el: HTMLElement;
  private settings: ExportSettings = normalize(load(SETTINGS_KEY));
  private files: readonly ExportFile[] = [];
  private readonly controls: (() => void)[] = [];
  private readonly queue = new VideoQueuePanel();
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
  private readonly info = h("p.rv-ex-info");
  private readonly warning = h("p.rv-ex-warn", { hidden: true });
  private readonly note = h("p.rv-ex-note", { hidden: true });
  private readonly clipSection: HTMLElement;
  private readonly body = h("div.rv-ex-body");
  private readonly heading = h("h3", null, "Export video");
  private readonly start = h("button.rv-btn.rv-chip.rv-accent", { type: "button" }, "Export") as HTMLButtonElement;
  private readonly close = h("button.rv-btn.rv-chip", { type: "button" }, "Close") as HTMLButtonElement;
  private clipEdited = false;
  private clipKey = "";
  private replayId = "";
  private musicKey = "";
  private paintTracks: () => void = () => {};
  private paintClip: () => void = () => {};
  private hostKey = "";

  constructor(private readonly hooks: ExportHooks) {
    for (const field of [this.from, this.to])
      field.addEventListener("input", () => {
        this.clipEdited = true;
        this.summary();
      });
    this.full.addEventListener("change", () => this.summary());
    this.start.addEventListener("click", () => this.submit());
    this.close.addEventListener("click", () => this.dismiss());
    this.clipSection = this.clip();
    this.build();
    const card = h(
      "div.rv-card.rv-ex-card",
      null,
      this.heading,
      h("p.dim", null, "Rendered on this computer in the background and saved to Downloads. Keep playing meanwhile."),
      this.body,
      this.queue.el,
      h(
        "div.rv-ex-actions",
        null,
        h("div.rv-ex-foot", null, this.info, this.warning, this.note),
        this.close,
        this.start,
      ),
    );
    this.el = h("div.rv-modal", { role: "dialog", "aria-label": "Export video", hidden: true }, card);
    this.el.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.dismiss();
    });
  }

  /** The open replay, or `files` from the vault (one or many) without opening them. */
  open(files: readonly ExportFile[] = []): void {
    this.files = files;
    this.heading.textContent = files.length > 1 ? `Export ${files.length} videos` : "Export video";
    this.clipSection.hidden = files.length > 0;
    this.el.hidden = false;
    this.hostKey = "";
    this.refresh();
    this.start.focus({ preventScroll: true });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  private dismiss(): void {
    this.el.hidden = true;
    this.hooks.closed?.();
  }

  // Controls

  /** A row of segment buttons and the function that paints it from the settings. */
  private segmentRow<T extends string | number>(
    name: string,
    choices: readonly Choice<T>[],
    get: () => T,
    set: (value: T) => void,
    disabled: (value: T) => string | null = () => null,
  ): { row: HTMLElement; paint: () => void } {
    const select = (value: T) => () => {
      set(value);
      this.repaint();
    };
    const buttons = choices.map(
      (choice) =>
        h(
          "button.rv-seg-btn",
          { type: "button", role: "radio", onclick: select(choice.id) },
          choice.label,
        ) as HTMLButtonElement,
    );
    const paint = () => {
      for (const [index, button] of buttons.entries()) {
        const on = choices[index].id === get();
        const why = disabled(choices[index].id);
        button.classList.toggle("on", on);
        button.setAttribute("aria-checked", String(on));
        button.disabled = !!why;
        button.title = why ?? "";
      }
    };
    return { row: h("div.rv-seg", { role: "radiogroup", "aria-label": name }, ...buttons), paint };
  }

  private segment<T extends string | number>(
    name: string,
    choices: readonly Choice<T>[],
    get: () => T,
    set: (value: T) => void,
    disabled?: (value: T) => string | null,
  ): HTMLElement {
    const { row, paint } = this.segmentRow(name, choices, get, set, disabled);
    this.controls.push(paint);
    return h("div.rv-field", null, h("label", null, name), row);
  }

  private check(label: string, key: Toggle, sub?: string, disabled: () => string | null = () => null): HTMLElement {
    const input = checkbox(label, this.settings[key]);
    input.addEventListener("change", () => {
      this.settings[key] = input.checked;
      this.repaint();
    });
    const row = checkRow(input, label, sub);
    this.controls.push(() => {
      const why = disabled();
      input.checked = this.settings[key];
      input.disabled = !!why;
      row.classList.toggle("off", !!why);
      row.title = why ?? "";
    });
    return row;
  }

  private customSize(): HTMLElement {
    const width = numberInput("Custom video width", { min: MIN_SIDE, max: MAX_SIDE, step: 2 });
    const height = numberInput("Custom video height", { min: MIN_SIDE, max: MAX_SIDE, step: 2 });
    const apply = () => {
      this.settings.customWidth = side(width.valueAsNumber, this.settings.customWidth);
      this.settings.customHeight = side(height.valueAsNumber, this.settings.customHeight);
      this.summary();
    };
    width.addEventListener("change", apply);
    height.addEventListener("change", apply);
    const row = h(
      "div.rv-ex-inline",
      null,
      h("label.rv-range", null, "Width", width),
      h("label.rv-range", null, "Height", height),
    );
    this.controls.push(() => {
      width.value = String(this.settings.customWidth);
      height.value = String(this.settings.customHeight);
      row.hidden = this.settings.resolution !== CUSTOM;
    });
    return h("div.rv-field", null, h("label", null, ""), row);
  }

  private codecUnavailable = (codec: VideoCodec): string | null => {
    const info = videoCodecs().find((c) => c.id === codec);
    if (!info || info.software || info.hardware) return null;
    return `This FFmpeg has no ${CODEC_LABELS[codec]} encoder`;
  };

  private videoSection(): HTMLElement {
    const s = this.settings;
    const resolutions = [
      ...RESOLUTIONS.map((r) => ({ id: r.id as string, label: r.label })),
      { id: CUSTOM, label: "Custom" },
    ];
    return section(
      "Video",
      this.segment(
        "Format",
        [
          { id: "landscape", label: "Landscape 16:9" },
          { id: "portrait", label: "Portrait 9:16" },
        ] as const,
        () => s.format,
        (value) => (s.format = value),
      ),
      this.segment(
        "Resolution",
        resolutions,
        () => s.resolution,
        (value) => (s.resolution = value),
      ),
      this.customSize(),
      this.segment(
        "Frame rate",
        FRAME_RATES.map((fps) => ({ id: fps as number, label: `${fps}` })),
        () => s.fps,
        (value) => (s.fps = value),
      ),
      this.segment(
        "Quality",
        QUALITIES,
        () => s.quality,
        (value) => (s.quality = value),
      ),
      this.segment(
        "Codec",
        (Object.keys(CODEC_LABELS) as VideoCodec[]).map((id) => ({ id, label: CODEC_LABELS[id] })),
        () => s.codec,
        (value) => (s.codec = value),
        this.codecUnavailable,
      ),
      this.segment(
        "Encoder",
        ENCODERS,
        () => s.encoder,
        (value) => (s.encoder = value),
      ),
    );
  }

  private lookSection(): HTMLElement {
    const s = this.settings;
    const levels = () =>
      motionBlurOf(s) === "custom" ? [...MOTION_BLUR, { id: "custom", label: "Custom" }] : [...MOTION_BLUR];
    const setBlur = (id: string) => {
      const level = MOTION_BLUR.find((m) => m.id === id);
      if (!level) return;
      s.samples = level.samples;
      s.shutter = level.shutter;
    };
    return section(
      "Look and camera",
      this.segment(
        "Graphics",
        LOOKS,
        () => s.look,
        (value) => (s.look = value),
      ),
      this.segment("Motion blur", levels(), () => motionBlurOf(s), setBlur),
      this.segment(
        "Camera",
        CAMERAS,
        () => s.camera,
        (value) => (s.camera = value),
      ),
    );
  }

  private overlaySection(): HTMLElement {
    const firstPerson = () =>
      this.settings.camera === "eye" || this.settings.camera === "auto" ? null : "Only in first-person shots";
    return section(
      "Overlays",
      h(
        "div.rv-checks",
        null,
        this.check("Speed", "speed"),
        this.check("Timer and sync", "hud", "splits, stats, jump stats"),
        this.check("Keys", "keys"),
        this.check("Speed graph", "graph"),
        this.check("Crosshair", "crosshair", undefined, firstPerson),
        this.check("Weapon in hand", "weapon"),
      ),
    );
  }

  private soundSection(): HTMLElement {
    const gameplay = this.check("Include gameplay audio", "audio", "follows your volume and mutes");
    const wav = this.check("Sound as a WAV too", "audioFile", "next to the video, for editors", () =>
      this.settings.codec === "png" ? "PNG frames always come with audio.wav" : null,
    );
    return section("Sound", h("div.rv-checks", null, gameplay, wav), this.musicRow);
  }

  private clip(): HTMLElement {
    const here = (input: HTMLInputElement) => () => {
      const range = shownRange(state.playback);
      input.value = String(Math.round(Math.max(0, state.playback.tick - range.start) * range.interval * 100) / 100);
      this.clipEdited = true;
      this.summary();
    };
    const loop = h(
      "button.rv-btn.rv-chip",
      { type: "button", onclick: () => this.useLoop() },
      "Use loop A–B",
    ) as HTMLButtonElement;
    this.paintClip = () => {
      loop.hidden = !this.hooks.loop?.();
    };
    return section(
      "Clip",
      checkRow(this.full, "Full recording", "the whole file, not 1 s before to 1.5 s after the run"),
      h(
        "div.rv-ex-inline",
        null,
        h("label.rv-range", null, "Start (s)", this.from),
        h("button.rv-btn.rv-chip", { type: "button", onclick: here(this.from) }, "From here"),
        h("label.rv-range", null, "End (s)", this.to),
        h("button.rv-btn.rv-chip", { type: "button", onclick: here(this.to) }, "To here"),
        loop,
      ),
      h("small.rv-ex-note", null, "Times on the timeline. Cut exactly between ticks: the video ends on the end time."),
    );
  }

  private advanced(): HTMLElement {
    const s = this.settings;
    return h(
      "details.rv-ex-adv",
      null,
      h("summary", null, "Advanced"),
      this.segment(
        "Supersampling",
        [
          { id: 1, label: "Off" },
          { id: 2, label: "2×" },
        ] as const,
        () => s.supersample,
        (value) => (s.supersample = value),
      ),
      this.segment(
        "Samples per frame",
        SAMPLES.map((n) => ({ id: n, label: `${n}` })),
        () => s.samples,
        (value) => (s.samples = value),
      ),
      this.segment(
        "Shutter",
        SHUTTERS.map((angle) => ({ id: angle as number, label: angle ? `${angle}°` : "Closed" })),
        () => s.shutter,
        (value) => (s.shutter = value),
      ),
      h(
        "small.rv-ex-note",
        null,
        "Samples above 1 smooth edges; with the shutter open they also blur motion. Supersampling renders twice the " +
          "size and scales down.",
      ),
    );
  }

  private presets(): HTMLElement {
    const mine = load(MINE_KEY);
    const save = h(
      "button.rv-btn.rv-chip.rv-ex-save",
      { type: "button" },
      mine ? "Update my settings" : "Save as my settings",
    );
    save.addEventListener("click", () => {
      localStorage.setItem(MINE_KEY, JSON.stringify(this.settings));
      save.textContent = "Saved";
    });
    const preset = (label: string, values: () => Partial<ExportSettings>) =>
      h("button.rv-btn.rv-chip", { type: "button", onclick: () => this.apply(values()) }, label);
    return h(
      "div.rv-ex-presets",
      null,
      h("span", null, "Presets"),
      preset("Standard", () => ({ ...STANDARD, music: this.settings.music })),
      preset("Shorts", () => SHORTS),
      preset("Editing", () => ({ ...EDITING, codec: this.codecUnavailable("prores") ? "h264" : "prores" })),
      mine ? preset("Mine", () => normalize(mine)) : null,
      save,
    );
  }

  private build(): void {
    this.controls.length = 0;
    this.musicKey = "";
    this.body.replaceChildren(
      this.presets(),
      this.videoSection(),
      this.lookSection(),
      this.overlaySection(),
      this.soundSection(),
      this.clipSection,
      this.advanced(),
    );
    this.controls.push(this.paintClip);
  }

  private apply(values: Partial<ExportSettings>): void {
    this.settings = normalize({ ...this.settings, ...values }, this.settings);
    this.build();
    this.repaint();
  }

  private repaint(): void {
    for (const paint of this.controls) paint();
    this.paintMusic();
    this.summary();
  }

  // Clip

  private useLoop(): void {
    const loop = this.hooks.loop?.();
    if (!loop) return;
    const range = shownRange(state.playback);
    const seconds = (tick: number) => String(Math.round((tick - range.start) * range.interval * 100) / 100);
    this.full.checked = false;
    this.from.value = seconds(loop.from);
    this.to.value = seconds(loop.to);
    this.clipEdited = true;
    this.summary();
  }

  /** The clip as absolute ticks, {} for the default range, or null when the fields don't make a clip. */
  private clipTicks(): { from?: number; to?: number } | null {
    if (!this.clipEdited || this.files.length) return {};
    const range = shownRange(state.playback);
    const from = range.start + Math.round(this.from.valueAsNumber / range.interval);
    const to = range.start + Math.round(this.to.valueAsNumber / range.interval);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
    if (from < range.start || to <= from || to > range.end) return null;
    return { from, to };
  }

  private clipSeconds(): number | null {
    if (this.files.length) return null;
    const clip = this.clipTicks();
    const range = shownRange(state.playback);
    if (!clip) return null;
    if (clip.from !== undefined && clip.to !== undefined) return (clip.to - clip.from) * range.interval;
    return range.ticks * range.interval;
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

  // Music

  private musicValid(): boolean {
    const offset = this.musicOffset.valueAsNumber;
    const level = this.musicLevel.valueAsNumber;
    const offsetValid = Number.isFinite(offset) && offset >= 0 && offset <= MAX_MUSIC_OFFSET_SECONDS;
    return offsetValid && Number.isFinite(level) && level >= 0 && level <= 1;
  }

  private paintMusic(): void {
    const tracks = state.videoExport.musicTracks;
    const key = JSON.stringify(tracks);
    if (key !== this.musicKey) {
      this.musicKey = key;
      if (!tracks.some((track) => track.id === this.settings.music)) this.settings.music = "none";
      const choices = [{ id: "none", label: "None" }, ...tracks.map((track) => ({ id: track.id, label: track.title }))];
      const music = this.segmentRow(
        "Music",
        choices,
        () => this.settings.music,
        (value) => (this.settings.music = value),
      );
      this.paintTracks = music.paint;
      const offset = h("label.rv-check", null, "Song offset (s)", this.musicOffset);
      const level = h("label.rv-check", null, "Music level (0–1)", this.musicLevel);
      const loop = checkRow(this.musicLoop, "Loop song");
      this.musicExtras.replaceChildren(offset, level, loop, checkRow(this.musicDuck, "Duck under gameplay"));
      const inputs = h("div.rv-ex-inputs", null, music.row, this.musicExtras, this.musicNote);
      const next = h("div.rv-field", null, h("label", null, "Music"), inputs);
      this.musicRow.replaceWith(next);
      this.musicRow = next;
    }
    this.paintTracks();
    const silent = this.settings.music === "none";
    for (const control of [this.musicOffset, this.musicLevel, this.musicLoop]) control.disabled = silent;
    this.musicDuck.disabled = silent || !this.settings.audio;
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

  // Summary and export

  private encoderUsed(): string {
    const info = videoCodecs().find((c) => c.id === this.settings.codec);
    if (!info) return "";
    const hardwareFirst = this.settings.encoder !== "software";
    const name = (hardwareFirst ? info.hardware || info.software : info.software || info.hardware) || "";
    return name ? `${name}${name === info.hardware ? " (hardware)" : ""}` : "";
  }

  private problems(): string[] {
    const s = this.settings;
    const { width, height } = exportSize(s);
    const found: string[] = [];
    if (!state.videoExport.available) found.push(state.videoExport.reason);
    if (width * height > MAX_PIXELS) found.push("Up to 8K (7680×4320).");
    if (s.codec === "dnxhr" && (width < 256 || height < 120)) found.push("DNxHR needs at least 256×120.");
    if (!this.files.length && !state.playback.active) found.push("Open a replay to export it.");
    if (!this.clipTicks()) found.push("Choose a clip end after its start, within this replay.");
    if (!this.musicValid()) found.push("Choose a music offset from 0 to 1800 seconds and level from 0 to 1.");
    return found;
  }

  private notes(seconds: number | null): string[] {
    const s = this.settings;
    const cost = exportCost(s);
    const found: string[] = [];
    const missing = this.codecUnavailable(s.codec);
    if (missing) found.push(`${missing}: H.264 instead.`);
    if (cost >= SLOW_COST)
      found.push(`Slow settings: about ${Math.round(cost)}× the render time of a plain 1080p60 export.`);
    if (s.codec === "png") found.push("Saves a folder of PNG frames, with the sound as audio.wav.");
    if (s.codec === "h264" && exportSize(s).width > 4096)
      found.push("H.264 hardware stops at 4096 wide: HEVC is faster here.");
    if (s.format === "portrait" && seconds !== null && seconds > SHORTS_SECONDS)
      found.push("Over 3 minutes: shorten it for YouTube Shorts.");
    return found;
  }

  private summary(): void {
    const s = this.settings;
    const { width, height } = exportSize(s);
    const seconds = this.clipSeconds();
    const parts = [`${width}×${height}`, `${s.fps} fps`, CODEC_LABELS[s.codec], this.encoderUsed()];
    if (seconds !== null) {
      parts.push(`${seconds.toFixed(1)} s`, `${Math.ceil(seconds * s.fps)} frames`);
      const bytes = estimatedBytes(s, seconds);
      if (bytes !== null) parts.push(`about ${megabytes(bytes)}`);
    }
    if (this.files.length > 1) parts.push(`${this.files.length} replays`);
    this.info.textContent = parts.filter(Boolean).join(" · ");
    const problems = this.problems();
    this.warning.textContent = problems.join(" ");
    this.warning.hidden = problems.length === 0;
    const notes = this.notes(seconds);
    this.note.textContent = notes.join(" ");
    this.note.hidden = notes.length === 0;
    this.start.disabled = problems.length > 0;
    const busy = videoJobs().some(jobRunning);
    const target = this.files.length > 1 ? `Export ${this.files.length} videos` : "Export";
    this.start.textContent = busy
      ? this.files.length > 1
        ? `Queue ${this.files.length} videos`
        : "Add to queue"
      : target;
  }

  private options(): VideoExportOptions {
    const s = this.settings;
    const { width, height } = exportSize(s);
    return {
      width,
      height,
      fps: s.fps,
      quality: s.quality,
      camera: s.camera,
      hud: s.hud,
      codec: s.codec,
      encoder: s.encoder,
      look: s.look,
      supersample: s.supersample,
      samples: s.samples,
      shutter: s.shutter,
      speed: s.speed,
      keys: s.keys,
      graph: s.graph,
      crosshair: s.crosshair,
      weapon: s.weapon,
      audio: s.audio,
      audioFile: s.audioFile,
      music: s.music,
      musicOffset: this.musicOffset.valueAsNumber,
      musicLevel: this.musicLevel.valueAsNumber,
      musicLoop: this.musicLoop.checked,
      musicDuck: this.musicDuck.checked,
      fullRecording: this.full.checked,
    };
  }

  private submit(): void {
    const problems = this.problems();
    if (problems.length) {
      this.hooks.notice(problems[0]);
      return;
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    const options = this.options();
    if (this.files.length) {
      for (const file of this.files) send({ type: "videoExport", action: "file", id: file.id, map: file.map, options });
    } else {
      const title = this.hooks.title?.() ?? "";
      send({ type: "videoExport", action: "start", options: { ...options, ...this.clipTicks() }, title });
    }
  }

  /** Call on every host state while open. Controls repaint only when what they depend on changes. */
  refresh(): void {
    if (!this.files.length) this.fillClip();
    const key = JSON.stringify([videoCodecs(), state.videoExport.musicTracks, this.hooks.loop?.() ?? null]);
    if (key !== this.hostKey) {
      this.hostKey = key;
      for (const paint of this.controls) paint();
    }
    this.paintMusic();
    this.queue.refresh();
    this.summary();
  }
}
