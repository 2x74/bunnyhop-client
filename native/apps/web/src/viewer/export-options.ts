/** Pure export settings and timeline helpers, shared by the dialog and renderer. */
import { graphicsPreset, type GraphicsPreset } from "../graphics/presets";
export const RESOLUTIONS = [
  { id: "720p", w: 1280, h: 720 },
  { id: "1080p", w: 1920, h: 1080 },
  { id: "1440p", w: 2560, h: 1440 },
] as const;
export const FPS_CHOICES = [30, 60, 120] as const;
/** Video bitrate as bits per pixel per frame. Standard is the old fixed rate; fast camera turns smear at it. */
export const QUALITIES = [
  { id: "standard", label: "Standard", bpp: 0.12 },
  { id: "high", label: "High", bpp: 0.2 },
  { id: "max", label: "Max", bpp: 0.35 },
] as const;
export type ExportQuality = (typeof QUALITIES)[number]["id"];
/** Above every preset at 1440p60; keeps a long 120 fps export from holding gigabytes in memory before the save. */
export const MAX_BITRATE = 80e6;
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
  camera: ExportCam;
  hud: boolean;
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
  intro: false, outro: true, branding: true, trim: true, hud: true, keys: false, graph: false,
  clipStart: null, clipEnd: null,
};
export function normalizeExportOptions(value: unknown, defaults: ExportOptions): ExportOptions {
  const v = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const o = { ...defaults };
  o.format = v.format === "portrait" ? "portrait" : "landscape";
  if (RESOLUTIONS.some(r => r.id === v.resolution)) o.resolution = v.resolution as ExportOptions["resolution"];
  if (FPS_CHOICES.some(f => f === v.fps)) o.fps = v.fps as number;
  if (QUALITIES.some(q => q.id === v.quality)) o.quality = v.quality as ExportQuality;
  if (["eye", "chase", "flyby", "auto"].includes(String(v.camera))) o.camera = v.camera as ExportCam;
  for (const key of ["hud", "keys", "graph", "intro", "outro", "branding", "trim", "sound", "wind", "depthOfField"] as const) if (typeof v[key] === "boolean") o[key] = v[key];
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
/** Requested bits per second for the size, rate and quality (pickCodec may lower it to the H.264 level's limit). */
export function exportBitrate(o: ExportOptions): number {
  const { w, h } = exportSize(o);
  const bpp = (QUALITIES.find(q => q.id === o.quality) ?? QUALITIES[1]).bpp;
  return Math.min(MAX_BITRATE, Math.round(w * h * o.fps * bpp));
}
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
