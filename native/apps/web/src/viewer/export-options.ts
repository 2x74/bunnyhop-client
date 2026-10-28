/** Pure export settings and timeline helpers, shared by the dialog and renderer. */
import { graphicsPreset, type GraphicsPreset } from "../graphics/presets";
export const RESOLUTIONS = [
  { id: "720p", w: 1280, h: 720 },
  { id: "1080p", w: 1920, h: 1080 },
  { id: "1440p", w: 2560, h: 1440 },
  { id: "2160p", w: 3840, h: 2160 },
] as const;
/** 240 fps: smooth slow motion in an editor, and a clean source for motion blur added there. */
export const FPS_CHOICES = [30, 60, 120, 240] as const;
/**
 * Video bitrate as bits per pixel per frame. Standard is the old fixed rate; fast camera turns smear at it. Edit-ready
 * is an intermediate for editing elsewhere: constant quality near lossless where the encoder offers it (mp4.ts), this
 * rate otherwise, and a keyframe every half second so editors scrub it smoothly.
 */
export const QUALITIES = [
  { id: "standard", label: "Standard", bpp: 0.12 },
  { id: "high", label: "High", bpp: 0.2 },
  { id: "max", label: "Max", bpp: 0.35 },
  { id: "edit", label: "Edit-ready", bpp: 1.2 },
] as const;
export type ExportQuality = (typeof QUALITIES)[number]["id"];
/** Above every preset at 1440p60: a file that plays everywhere (Discord, phones). */
export const MAX_BITRATE = 80e6;
/** Edit-ready may go far higher: within H.264 level 5.1/5.2 High (300 Mbit/s). */
export const EDIT_MAX_BITRATE = 240e6;
/** Video codecs (mp4.ts probes each with VideoEncoder.isConfigSupported and falls back to H.264). */
export const CODECS = [
  { id: "avc", label: "H.264" },
  { id: "hevc", label: "HEVC" },
  { id: "av1", label: "AV1" },
] as const;
export type ExportCodec = (typeof CODECS)[number]["id"];
/**
 * Motion blur as players pick it: replay subframes per output frame and the shutter they cover (180° = half the frame
 * time, the film look). The samples also antialias edges. Custom values stay possible under Advanced.
 */
export const MOTION_BLUR = [
  { id: "off", label: "Off", temporalSamples: 1, shutterAngle: 0 },
  { id: "light", label: "Light", temporalSamples: 4, shutterAngle: 90 },
  { id: "strong", label: "Strong", temporalSamples: 8, shutterAngle: 180 },
] as const;
export type MotionBlur = (typeof MOTION_BLUR)[number]["id"] | "custom";
export const INTRO_S = 2.5;
export const OUTRO_S = 3;
export const CAPTION_LIMIT = 80;
export type ExportCam = "eye" | "chase" | "flyby" | "auto";
export interface ExportOptions {
  preset: GraphicsPreset;
  supersample: 1 | 2;
  temporalSamples: 1 | 2 | 4 | 8;
  shutterAngle: number;
  depthOfField: boolean;
  focusDistance: number;
  resolution: (typeof RESOLUTIONS)[number]["id"];
  /** Missing in older saved settings and automation: defaults to landscape. */
  format?: "landscape" | "portrait";
  fps: number;
  /** Missing in older saved settings and automation: defaults to the default options' quality. */
  quality?: ExportQuality;
  /** Missing in older settings: H.264. */
  codec?: ExportCodec;
  camera: ExportCam;
  /** Timer, sync, stats (and the speed, unless `speed` says otherwise). */
  hud: boolean;
  /** The speed number; missing in older settings and automation: follows `hud`. */
  speed?: boolean;
  /** Your crosshair (Settings), in first-person shots. */
  crosshair?: boolean;
  /**
   * The weapon in hand: in first-person shots the runner's arms (knife, guns, swings, shots, inspects: viewer/arms.ts),
   * in third person the bunny's knife / gun. Missing (automation): the viewer's V toggle for each view. Never saved:
   * the dialog starts from the viewer's toggle for the chosen camera.
   */
  weapon?: boolean;
  keys: boolean;
  graph: boolean;
  intro: boolean;
  outro: boolean;
  /** Small wordmark during gameplay and on title/results cards. */
  branding?: boolean;
  trim: boolean;
  sound: boolean;
  /** Include the speed-driven wind loop with the sound effects (off by default; missing in older settings). */
  wind?: boolean;
  music: string;
  /** Recording-relative seconds; null uses the automatic run/recording bounds. */
  clipStart?: number | null;
  clipEnd?: number | null;
  caption?: string;
}
export const SHORTS_PRESET: Partial<ExportOptions> = {
  format: "portrait", resolution: "1080p", fps: 60, camera: "eye",
  intro: false, outro: true, branding: true, trim: true, hud: true, speed: true, keys: false, graph: false,
  clipStart: null, clipEnd: null,
};
export function normalizeExportOptions(value: unknown, defaults: ExportOptions): ExportOptions {
  const v = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const o = { ...defaults };
  o.format = v.format === "portrait" ? "portrait" : "landscape";
  if (RESOLUTIONS.some(r => r.id === v.resolution)) o.resolution = v.resolution as ExportOptions["resolution"];
  if (FPS_CHOICES.some(f => f === v.fps)) o.fps = v.fps as number;
  if (QUALITIES.some(q => q.id === v.quality)) o.quality = v.quality as ExportQuality;
  o.codec = CODECS.some(c => c.id === v.codec) ? v.codec as ExportCodec : CODECS.some(c => c.id === defaults.codec) ? defaults.codec : "avc";
  if (["eye", "chase", "flyby", "auto"].includes(String(v.camera))) o.camera = v.camera as ExportCam;
  for (const key of ["hud", "keys", "graph", "intro", "outro", "branding", "trim", "sound", "wind", "depthOfField", "crosshair"] as const) if (typeof v[key] === "boolean") o[key] = v[key];
  o.speed = typeof v.speed === "boolean" ? v.speed : o.hud;
  o.crosshair = o.crosshair === true;
  if (typeof v.weapon === "boolean") o.weapon = v.weapon;
  else delete o.weapon;
  if (v.preset !== undefined) o.preset = graphicsPreset(v.preset);
  if (v.supersample === 1 || v.supersample === 2) o.supersample = v.supersample;
  if ([1, 2, 4, 8].includes(v.temporalSamples as number)) o.temporalSamples = v.temporalSamples as ExportOptions["temporalSamples"];
  if (typeof v.shutterAngle === "number") o.shutterAngle = Math.max(0, Math.min(180, v.shutterAngle || 0));
  if (typeof v.focusDistance === "number" && Number.isFinite(v.focusDistance)) o.focusDistance = v.focusDistance;
  if (typeof v.music === "string") o.music = v.music;
  for (const key of ["clipStart", "clipEnd"] as const) o[key] = typeof v[key] === "number" && Number.isFinite(v[key]) ? v[key] : null;
  o.caption = typeof v.caption === "string" ? v.caption.replace(/\s+/g, " ").trim().slice(0, CAPTION_LIMIT) : "";
  return o;
}
export function exportSize(o: ExportOptions): { w: number; h: number } {
  const r = RESOLUTIONS.find(r => r.id === o.resolution) ?? RESOLUTIONS[1];
  return o.format === "portrait" ? { w: r.h, h: r.w } : { w: r.w, h: r.h };
}
/** Requested bits per second for the size, rate and quality (pickCodec may lower it to the codec level's limit). */
export function exportBitrate(o: ExportOptions): number {
  const { w, h } = exportSize(o);
  const bpp = (QUALITIES.find(q => q.id === o.quality) ?? QUALITIES[1]).bpp;
  return Math.min(o.quality === "edit" ? EDIT_MAX_BITRATE : MAX_BITRATE, Math.round(w * h * o.fps * bpp));
}

/** Frames between keyframes: every 2 s, every half second for Edit-ready (editors seek to keyframes). */
export function keyframeInterval(o: Pick<ExportOptions, "fps" | "quality">): number {
  return Math.max(1, Math.round(o.quality === "edit" ? o.fps / 2 : o.fps * 2));
}

/** The motion blur level matching the samples and shutter, "custom" for other combinations (set under Advanced). */
export function motionBlurOf(o: Pick<ExportOptions, "temporalSamples" | "shutterAngle">): MotionBlur {
  const samples = o.temporalSamples ?? 1;
  const shutter = samples > 1 ? o.shutterAngle ?? 0 : 0;
  if (samples === 1 || shutter === 0) return samples === 1 ? "off" : "custom";
  return MOTION_BLUR.find(m => m.temporalSamples === samples && m.shutterAngle === shutter)?.id ?? "custom";
}

export function setMotionBlur(o: ExportOptions, level: Exclude<MotionBlur, "custom">): void {
  const m = MOTION_BLUR.find(m => m.id === level) ?? MOTION_BLUR[0];
  o.temporalSamples = m.temporalSamples;
  o.shutterAngle = m.shutterAngle;
}

/**
 * Relative render cost against a plain 1080p60 export of the same clip (pixels x frames x scene renders per frame), for
 * the dialog's heads-up on long renders.
 */
export function exportCost(o: ExportOptions): number {
  const { w, h } = exportSize(o);
  const samples = Math.max(1, o.temporalSamples ?? 1);
  const ss = o.supersample === 2 ? 4 : 1;
  return (w * h * o.fps * samples * ss) / (1920 * 1080 * 60);
}

/** Settings kept by "Save as my settings": everything but this clip's range and caption, and the weapon (viewer's toggle). */
export function savedSettings(o: ExportOptions): Partial<ExportOptions> {
  const { clipStart: _s, clipEnd: _e, caption: _c, weapon: _w, ...rest } = o;
  return rest;
}

/** Edit-ready preset: a clean, high-quality intermediate for an editor (no overlays, cards or music). */
export const EDITING_PRESET: Partial<ExportOptions> = {
  quality: "edit", fps: 60, hud: false, speed: false, keys: false, graph: false, crosshair: false,
  intro: false, outro: false, branding: false, music: "none", caption: "",
};
export function exportTimeline(d: { n: number; tickrate: number; startTick: number; endTick: number }, o: ExportOptions) {
  const manual = o.clipStart != null || o.clipEnd != null;
  const duration = d.n / d.tickrate;
  for (const bound of [o.clipStart, o.clipEnd]) {
    if (bound != null && (!Number.isFinite(bound) || bound < 0 || bound > duration)) {
      throw new Error(`Clip times must be between 0 and ${duration.toFixed(2)} seconds.`);
    }
  }
  // Shorts start on the timed action. Landscape keeps the historical handles.
  const before = o.format === "portrait" ? 0 : d.tickrate;
  const after = o.format === "portrait" ? Math.round(d.tickrate * .5) : Math.round(d.tickrate * 1.5);
  let from = manual ? (o.clipStart ?? 0) * d.tickrate : o.trim && d.startTick ? Math.max(0, d.startTick - before) : 0;
  let to = manual ? (o.clipEnd == null ? d.n : o.clipEnd * d.tickrate) : o.trim && d.endTick ? Math.min(d.n, d.endTick + after) : d.n;
  from = Math.min(d.n, Math.max(0, from));
  to = Math.min(d.n, Math.max(0, to));
  if (to < from || (manual && to === from)) throw new Error("Clip end must be after clip start.");
  const runFrames = Math.max(1, Math.floor((to - from) / (d.tickrate / o.fps)) + 1);
  const introFrames = o.intro ? Math.round(INTRO_S * o.fps) : 0;
  const outroFrames = o.outro ? Math.round(OUTRO_S * o.fps) : 0;
  const total = introFrames + runFrames + outroFrames;
  return { from, to, runFrames, introFrames, outroFrames, total, seconds: total / o.fps };
}
