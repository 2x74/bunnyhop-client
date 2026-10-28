// MP4 export: renders a replay offline, frame by frame, into H.264 via WebCodecs, muxed by viewer/mp4.ts.
//
// Approach borrowed from the Aimperion replay exporter (src/replay/export.js): never screen-capture. The replay is
// deterministic, so every output frame i is rendered explicitly at replay time i / fps (here: a fractional tick,
// interpolated between the cached sim ticks), at a chosen output size (not the window's), composited with a canvas
// HUD in the same pass, and handed to a VideoEncoder with backpressure (encodeQueueSize) and a yield every few
// frames so the progress bar repaints and Cancel works. A keyframe every 2 s; a codec ladder probed with
// isConfigSupported; the muxer is a hand-rolled ftyp/mdat/moov writer. Nothing reads a clock: the camera rig and the
// player model get dt = 1 / fps, and Math.random is swapped for a seeded PRNG while rendering, so the same replay and
// options produce the same frames on any machine, at any speed.
//
// Sound (optional): the replay's movement sounds, run chimes, wind and a music bed are mixed offline at 48 kHz from
// the same per-tick cache (audio/replay.ts renderReplayAudio, every sound on the sample of its tick) and encoded as
// AAC / Opus into the same MP4 (viewer/audio-track.ts).

import * as THREE from "three";
import { cinematicSampleSchedule, withCameraJitter } from "../graphics/cinematic-sampling";
import { restoreRenderState } from "../graphics/render-state";
import type { GraphicsPipeline } from "../graphics/pipeline";
import { exportRenderSize, graphicsPreset, presetConfig, type GraphicsPreset } from "../graphics/presets";
import { h } from "../ui/dom";
import { prefs, verticalFov } from "../ui/settings";
import { CameraRig, directShots, type TraceFn } from "./cameras";
import { CanvasHud, drawBranding, drawOutroCard, drawTitleCard, type CardInfo } from "./canvas-hud";
import { canEncodeVideo, Mp4Muxer, pickCodec } from "./mp4";
import type { RunData } from "./player";
import { encodeAudioTrack, pickAudioCodec } from "./audio-track";
import { exportTracks, renderReplayAudio, EXPORT_RATE } from "../audio/replay";

export interface ExportSource {
  readonly data: RunData | null;
  readonly renderer: THREE.WebGLRenderer;
  readonly graphicsPipeline?: GraphicsPipeline;
  readonly texturePacks?: readonly { id: string; version: string }[];
  readonly graphicsIdentity?: { map: string; mapSha256: string };
  readonly camera: THREE.PerspectiveCamera;
  readonly trace: TraceFn;
  readonly compareLabel: string | null;
  deltaAt(t: number): number | null;
  /** Positions everything for display tick t (camera from `rig`) and renders the scene. */
  render(t: number, dt: number, rig: CameraRig): void;
  beginExport(): void;
  /** Brings the sim (doors, platforms: what camera traces see) to tick t. */
  syncSim(t: number): void;
  endExport(): void;
  cardInfo(includeLeaderboard?: boolean): Promise<CardInfo>;
  fileName(): string;
}

import { RESOLUTIONS, FPS_CHOICES, QUALITIES, SHORTS_PRESET, CAPTION_LIMIT, INTRO_S, OUTRO_S, normalizeExportOptions, exportBitrate, exportSize, exportTimeline, type ExportCam, type ExportOptions } from "./export-options";
export { RESOLUTIONS, FPS_CHOICES, QUALITIES, SHORTS_PRESET } from "./export-options";
export type { ExportOptions, ExportCam } from "./export-options";
export const EXPORT_CAMS: { id: ExportCam; label: string }[] = [
  { id: "eye", label: "In-eye" }, { id: "chase", label: "Chase" },
  { id: "flyby", label: "Free path (flyby)" }, { id: "auto", label: "Auto-director" },
];
export const DEFAULT_EXPORT: ExportOptions = { preset: "source", supersample: 1, temporalSamples: 1, shutterAngle: 0, depthOfField: false, focusDistance: 500, resolution: "1080p", format: "landscape", fps: 60, quality: "high", camera: "chase", hud: true, keys: true, graph: false, intro: true, outro: true, branding: true, trim: true, sound: true, wind: false, music: exportTracks()[0]?.id ?? "none", clipStart: null, clipEnd: null, caption: "" };
const PREFS_KEY = "bunnyhop:export";

export interface ExportResult {
  blob: Blob;
  name: string;
  frames: number;
  seconds: number;
  codec: string;
  /** Audio codec of the sound track ("aac" / "opus"), or null for a silent video. */
  audio: string | null;
  metadata: { sky: {mode:string;id:string|null;version:string|null;hash:string|null;precision:string|null;rotation:number;exposure:number;lightingSource:string;lightingClamped:boolean;error:string|null}; clouds: {active:boolean;quality:string;coverage:number;density:number;seed:number;baseHeight:number;steps:number}; ambienceShowcase: boolean; sunDirectStrength: number; skyFill: number; localLights: number; localShadowFaces: number; localShadowFaceSize: number; localStrength: number; tracedGI:Record<string,unknown>; dynamicGI: boolean; giSources: string; shadowTransmissionLayers: number; giRange: number; giStrength: number; temporalSamples: number; shutterAngle: number; volumetric: boolean; spatialAA: boolean; materialResponse: boolean; texturePacks: { id: string; version: string }[]; version: number; clock: string; seed: number; map: string; mapSha256: string; profile: string; contactShading: boolean; atmosphere: boolean; sunShafts: boolean; dynamicShadows: boolean; shadowQuality: string; shadowResolution: number; shadowFilter: string; shadowFilterTaps: number; shadowFilterWorldRadius: number; localShadowFilterTaps: number; shadowDistance: number; shadowStrength: number; depthOfField: boolean; bloom: boolean; preset: GraphicsPreset; supersample: number; width: number; height: number; fps: number; renderWidth: number; renderHeight: number };
}

export interface ExportProgress {
  done: number;
  total: number;
  stage: "render" | "audio" | "finish";
}

const yieldTask = () => new Promise<void>((r) => setTimeout(r, 0));

/** Renders `src` to an MP4. Resolves null when cancelled. */
export async function exportMp4(src: ExportSource, o: ExportOptions, onProgress: (p: ExportProgress, preview: HTMLCanvasElement) => void, cancelled: () => boolean): Promise<ExportResult | null> {
  if (!canEncodeVideo()) throw new Error("This browser can't encode video (WebCodecs VideoEncoder is missing). Try a recent Chrome, Edge or Safari.");
  const d = src.data;
  if (!d) throw new Error("No replay loaded.");
  o = normalizeExportOptions(o, DEFAULT_EXPORT);
  const { w, h: hgt } = exportSize(o);
  const fps = o.fps;
  const bitrate = exportBitrate(o);
  const config = await pickCodec(w, hgt, bitrate, fps);
  if (!config) throw new Error(`This browser can't encode ${w}×${hgt} at ${fps} fps as H.264. Try a lower resolution or frame rate.`);

  const { from, to, runFrames, introFrames, outroFrames, total } = exportTimeline(d, o);
  const ticksPerFrame = d.tickrate / fps;
  const card = await src.cardInfo(o.outro);

  const muxer = new Mp4Muxer(w, hgt);
  let encodeError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (!muxer.hasDescription && meta?.decoderConfig?.description) muxer.setDescription(meta.decoderConfig.description);
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      muxer.addSample(buf, muxer.timescale / fps, chunk.type === "key");
    },
    error: (e) => (encodeError = e),
  });
  encoder.configure(config);

  const comp = document.createElement("canvas");
  comp.width = w;
  comp.height = hgt;
  const g = comp.getContext("2d", { alpha: false })!;
  const hud = new CanvasHud(w, hgt);
  const renderer = src.renderer;
  const camera = src.camera;
  const rig = new CameraRig();
  rig.mode = o.camera;
  if (o.camera === "auto") {
    // Shot placement traces the world: do it with the sim at a fixed tick so it doesn't depend on viewer state.
    src.syncSim(from);
    rig.setShots(directShots(d, from, to, src.trace));
  }

  const realRandom = Math.random;
  // Deterministic randomness (player model construction, ear twitches): swapped in only while building / rendering
  // the scene, so nothing else on the page can consume the sequence between frames.
  let seed = (d.n * 2654435761 + 12345) >>> 0;
  const rng = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const seeded = (f: () => void) => {
    Math.random = rng;
    try {
      f();
    } finally {
      Math.random = realRandom;
    }
  };
  const pipeline = src.graphicsPipeline;
  const restore = restoreRenderState(renderer, camera, pipeline);
  const renderSize = exportRenderSize(w, hgt, o.supersample, renderer.capabilities.maxTextureSize);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  let frame = 0;
  const emit = async () => {
    const vf = new VideoFrame(comp, { timestamp: Math.round((frame * 1e6) / fps), duration: Math.round(1e6 / fps) });
    try { encoder.encode(vf, { keyFrame: frame % (fps * 2) === 0 }); } finally { vf.close(); }
    frame++;
    if (encoder.encodeQueueSize > 6) while (encoder.encodeQueueSize > 2) {
      await yieldTask();
      if (encodeError) throw encodeError;
    }
    if (frame % 6 === 0 || frame === total) {
      onProgress({ done: frame, total, stage: "render" }, comp);
      await yieldTask();
    }
  };
  const currentSize = new THREE.Vector2();
  const exportFov = verticalFov(prefs.get().fov);
  const temporalSamples = pipeline?.supported && presetConfig({ preset: o.preset, potato: false }).postprocessing && [2,4,8].includes(o.temporalSamples) ? o.temporalSamples : 1;
  const shutterAngle = temporalSamples > 1 ? Math.max(0, Math.min(180, o.shutterAngle || 0)) : 0;
  let lastSampleTime: number | null = null;
  const scene = (t: number, dt: number, motion = true) => {
    // Window resize handlers may run while encoding yields to the UI.
    renderer.getSize(currentSize);
    if (renderer.getPixelRatio() !== 1) renderer.setPixelRatio(1);
    if (currentSize.x !== renderSize.width || currentSize.y !== renderSize.height) {
      renderer.setSize(renderSize.width, renderSize.height, false);
      pipeline?.setSize(renderSize.width, renderSize.height);
    }
    if (camera.aspect !== w / hgt || camera.fov !== exportFov) {
      camera.aspect = w / hgt;
      camera.fov = exportFov;
      camera.updateProjectionMatrix();
    }
    if (temporalSamples === 1) seeded(() => src.render(t, dt, rig));
    else {
      const samples = cinematicSampleSchedule(t / d.tickrate, fps, { samples: temporalSamples, shutterAngle: motion ? shutterAngle : 0 });
      const shot = rig.mode === "auto" ? rig.shotList.find((shot) => t >= shot.from && t < shot.to) : null;
      pipeline!.beginCinematicFrame(temporalSamples);
      try { samples.forEach((sample, index) => {
        const tick = Math.min(d.n, Math.max(shot?.from ?? 0, Math.min((shot?.to ?? d.n) - 1e-6, sample.time * d.tickrate)));
        const seconds = tick / d.tickrate;
        const sampleDt = lastSampleTime === null ? 0 : Math.max(0, seconds - lastSampleTime);
        pipeline!.beginCinematicSample(index);
        seeded(() => withCameraJitter(camera, renderSize.width, renderSize.height, sample.jitter, () => src.render(tick, sampleDt, rig)));
        lastSampleTime = seconds;
      }); pipeline!.endCinematicFrame(); } catch (error) { pipeline!.resetCinematicSampling(); throw error; }
    }
    g.drawImage(renderer.domElement, 0, 0, w, hgt);
  };
  const overlay = (t: number) => {
    hud.draw(g, d, t, src.deltaAt(t), { hud: o.hud, keys: o.keys, graph: o.graph, caption: o.caption });
    if (o.branding) drawBranding(g, w, hgt);
  };
  try {
  renderer.setPixelRatio(1);
  renderer.setSize(renderSize.width, renderSize.height, false);
  // Fresh kernels/captures ensure viewing history cannot alter deterministic export effects.
  pipeline?.resetEffects();
  pipeline?.setOptions({ preset: graphicsPreset(o.preset), potato: false, bloom: prefs.get().graphics.bloom, mapProfiles: prefs.get().graphics.mapProfiles, ambienceShowcase: prefs.get().graphics.ambienceShowcase, lightingProfile:prefs.get().graphics.lightingProfile,skyMode:prefs.get().graphics.skyMode,skyPackId:prefs.get().graphics.skyPackId,skyRotation:prefs.get().graphics.skyRotation,skyExposure:prefs.get().graphics.skyExposure,lightingSource:prefs.get().graphics.lightingSource,directContribution:prefs.get().graphics.directContribution,ambientContribution:prefs.get().graphics.ambientContribution,clouds:prefs.get().graphics.clouds,cloudQuality:prefs.get().graphics.cloudQuality,cloudCoverage:prefs.get().graphics.cloudCoverage,cloudDensity:prefs.get().graphics.cloudDensity, contactShading: prefs.get().graphics.contactShading, atmosphere: prefs.get().graphics.atmosphere, sunShafts: prefs.get().graphics.sunShafts, materialResponse: prefs.get().graphics.materialResponse, volumetric: prefs.get().graphics.volumetric, spatialAA: prefs.get().graphics.spatialAA, temporalSamples, localLights: prefs.get().graphics.localLights, localQuality: prefs.get().graphics.localQuality, localBudget: prefs.get().graphics.localBudget, localStrength: prefs.get().graphics.localStrength, dynamicGI: prefs.get().graphics.dynamicGI, tracedGI:prefs.get().graphics.tracedGI, giQuality: prefs.get().graphics.giQuality, giStrength: prefs.get().graphics.giStrength, giRange: prefs.get().graphics.giRange, dynamicShadows: prefs.get().graphics.dynamicShadows, shadowQuality: prefs.get().graphics.shadowQuality, shadowDistance: prefs.get().graphics.shadowDistance, shadowStrength: prefs.get().graphics.shadowStrength, depthOfField: o.depthOfField, focusDistance: Math.max(32, Math.min(20000, o.focusDistance || 500)) });
  pipeline?.setSize(renderSize.width, renderSize.height);
  await pipeline?.prepareForExport();
  camera.aspect = w / hgt;
  camera.fov = verticalFov(prefs.get().fov);
  camera.updateProjectionMatrix();
    seeded(() => src.beginExport());
    // Resolve the lazy BVH at the exact first replay pose before encoding.
    if (pipeline?.getOptions().tracedGI) {
      seeded(() => src.render(from, 0, rig));
      await pipeline.whenTracedGISettled();
      if (cancelled()) return null;
    }
    // Intro: the first frame, held under the title card (the camera settles meanwhile).
    for (let i = 0; i < introFrames; i++) {
      if (cancelled()) return null;
      if (encodeError) throw encodeError;
      scene(from, i === 0 ? 0 : 1 / fps, false);
      drawTitleCard(g, w, hgt, card, i / fps, INTRO_S, o.branding);
      await emit();
    }
    for (let i = 0; i < runFrames; i++) {
      if (cancelled()) return null;
      if (encodeError) throw encodeError;
      const t = Math.min(to, from + i * ticksPerFrame);
      scene(t, i === 0 && !introFrames ? 0 : 1 / fps);
      overlay(t);
      await emit();
    }
    if (outroFrames) {
      // Freeze only the world: gameplay HUD/caption should not ghost behind the results.
      scene(Math.min(to, from + (runFrames - 1) * ticksPerFrame), 0);
      const last = await createImageBitmap(comp);
      try {
        for (let i = 0; i < outroFrames; i++) {
          if (cancelled()) return null;
          if (encodeError) throw encodeError;
          g.drawImage(last, 0, 0);
          drawOutroCard(g, w, hgt, card, i / fps, o.branding);
          // Let the results settle, then end on black rather than cutting mid-card.
          const fade = Math.max(0, 1 - (outroFrames - 1 - i) / (fps * 0.5));
          if (fade > 0) {
            g.save();
            g.globalAlpha = fade;
            g.fillStyle = "#000";
            g.fillRect(0, 0, w, hgt);
            g.restore();
          }
          await emit();
        }
      } finally {
        last.close();
      }
    }
    let audio: string | null = null;
    const music = o.music !== "none" && exportTracks().some((t) => t.id === o.music) ? o.music : null;
    if (o.sound || music) {
      onProgress({ done: total, total, stage: "audio" }, comp);
      try {
        const buf = await renderReplayAudio(d, { from, to, lead: introFrames / fps, seconds: total / fps, sfx: o.sound, wind: o.wind, music });
        if (buf && !cancelled()) audio = await encodeAudioTrack(buf, muxer, cancelled);
      } catch (e) {
        console.warn("export: sound track failed, exporting without it", e);
      }
    }
    if (cancelled()) return null;
    onProgress({ done: total, total, stage: "finish" }, comp);
    await encoder.flush();
    if (encodeError) throw encodeError;
    return { blob: muxer.finalize(), name: src.fileName(), frames: muxer.frameCount, seconds: muxer.frameCount / fps, codec: config.codec, audio, metadata: { sky:pipeline?.getSkyMetadata()??{mode:"map",id:null,version:null,hash:null,precision:null,rotation:0,exposure:1,lightingSource:"map",lightingClamped:false,error:null},clouds:pipeline?.getCloudMetadata()??{active:false,quality:"off",coverage:0,density:0,seed:1,baseHeight:0,steps:0}, ambienceShowcase: !!pipeline?.getEffectiveEffects().ambienceShowcase, sunDirectStrength: pipeline?.getShadowStats()?.directStrength??0, skyFill:pipeline?.getShadowStats()?.skyFill??0, localLights: pipeline?.getLocalLightStats()?.selected ?? 0, localShadowFaces: pipeline?.getLocalLightStats()?.faces ?? 0, localShadowFaceSize: pipeline?.getLocalLightStats()?.selected ? pipeline.getLocalLightStats()?.faceSize ?? 0 : 0, localStrength: pipeline?.getLocalLightStats()?.selected ? pipeline.getOptions().localStrength ?? .2 : 0, tracedGI:pipeline?.getTracedGIStats()??{status:"off",active:false,loaded:false}, dynamicGI: !!pipeline?.getEffectiveEffects().dynamicGI, giSources: pipeline?.getGIStats()?.sources ?? "none", shadowTransmissionLayers: pipeline?.getEffectiveEffects().dynamicShadows || pipeline?.getLocalLightStats()?.selected ? 2 : 0, giRange: (pipeline?.getEffectiveEffects().dynamicGI||pipeline?.getEffectiveEffects().tracedGI) ? pipeline.getOptions().giRange ?? 256 : 0, giStrength: (pipeline?.getEffectiveEffects().dynamicGI||pipeline?.getEffectiveEffects().tracedGI) ? pipeline.getOptions().giStrength ?? .25 : 0, temporalSamples, shutterAngle, volumetric: !!pipeline?.getEffectiveEffects().volumetric, spatialAA: !!pipeline?.getEffectiveEffects().spatialAA, materialResponse: !!pipeline?.getEffectiveEffects().materialResponse, texturePacks: (src.texturePacks ?? []).map((pack) => ({ ...pack })), version: 4, clock: "replay-tick", seed: (d.n * 2654435761 + 12345) >>> 0, map: src.graphicsIdentity?.map ?? "", mapSha256: src.graphicsIdentity?.mapSha256 ?? "", profile: pipeline?.getProfile().id ?? "source-default-v1", contactShading: !!pipeline?.getEffectiveEffects().contactShading, atmosphere: !!pipeline?.getEffectiveEffects().atmosphere, sunShafts: !!pipeline?.getEffectiveEffects().sunShafts, dynamicShadows: !!pipeline?.getShadowSampling()?.active, shadowQuality: pipeline?.getShadowSampling()?.active ? ((pipeline.getShadowStats()?.size ?? 0) >= 2048 ? "high" : (pipeline.getShadowStats()?.size ?? 0) >= 1024 ? "medium" : "low") : "off", shadowResolution: pipeline?.getShadowSampling()?.active ? pipeline.getShadowStats()?.size ?? 0 : 0, shadowFilter: pipeline?.getShadowSampling()?.active ? pipeline.getShadowStats()?.filter ?? "none" : "none", shadowFilterTaps: pipeline?.getShadowSampling()?.active ? pipeline.getShadowStats()?.filterTaps ?? 0 : 0, shadowFilterWorldRadius: pipeline?.getShadowSampling()?.active ? pipeline.getShadowStats()?.filterWorldRadius ?? 0 : 0, localShadowFilterTaps: pipeline?.getLocalLightStats()?.selected ? pipeline.getLocalLightStats()?.filterTaps ?? 0 : 0, shadowDistance: pipeline?.getShadowSampling()?.active ? pipeline.getShadowStats()?.distance ?? 0 : 0, shadowStrength: pipeline?.getShadowSampling()?.active ? pipeline.getShadowSampling()?.strength ?? 0 : 0, depthOfField: !!pipeline?.getEffectiveEffects().depthOfField, bloom: !!pipeline?.getEffectiveEffects().bloom, preset: pipeline?.supported ? graphicsPreset(o.preset) : "source", supersample: renderSize.scale, width: w, height: hgt, fps, renderWidth: renderSize.width, renderHeight: renderSize.height } };
  } finally {
    try {
      encoder.close();
    } catch {
      /* closed on error */
    }
    pipeline?.resetCinematicSampling();
    try { src.endExport(); } finally {
      restore();
    }
  }
}

/** Hands a blob to the browser as a download. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function loadOptions(): ExportOptions {
  try {
    return normalizeExportOptions(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}"), DEFAULT_EXPORT);
  } catch {
    return { ...DEFAULT_EXPORT };
  }
}

/** Last export (for automation / headless checks): the blob and its stats. */
export let lastExport: ExportResult | null = null;

/** The export dialog (options, then progress + cancel, then save). */
export function openExportDialog(src: ExportSource, parent: HTMLElement, auto?: Partial<ExportOptions>): void {
  const o = normalizeExportOptions({ ...loadOptions(), ...auto }, DEFAULT_EXPORT);
  const d = src.data!;
  const supported = canEncodeVideo();
  const seg = <T extends string | number>(name: string, values: readonly { id: T; label: string }[], get: () => T, set: (v: T) => void) => {
    const row = h("div.rv-seg", { role: "radiogroup", "aria-label": name });
    const draw = () =>
      row.replaceChildren(
        ...values.map((v) =>
          h(`button.rv-seg-btn${v.id === get() ? ".on" : ""}`, { type: "button", role: "radio", "aria-checked": String(v.id === get()), onclick: () => (set(v.id), draw(), summary()) }, v.label),
        ),
      );
    draw();
    return h("div.rv-field", null, h("label", null, name), row);
  };
  const check = (label: string, key: "hud" | "keys" | "graph" | "intro" | "outro" | "branding" | "trim" | "sound" | "wind" | "depthOfField", sub?: string) => {
    const input = h("input", { type: "checkbox", checked: o[key], onchange: () => ((o[key] = input.checked), summary()) });
    return h("label.rv-check", null, input, h("span", null, label, sub ? h("small", null, sub) : null));
  };
  const info = h("p.rv-ex-info");
  const tracks = exportTracks();
  if (!tracks.some((t) => t.id === o.music)) o.music = "none";
  const audioNote = h("small.rv-ex-note");
  void pickAudioCodec(EXPORT_RATE, 2).then((c) => (audioNote.textContent = c ? `${c.id.toUpperCase()} audio track` : "This browser can't encode audio: the video will be silent"));
  const summary = () => {
    try {
      const { seconds: secs, total } = exportTimeline(d, o);
      const res = exportSize(o);
      const mb = (exportBitrate(o) * secs) / 8 / 1048576;
      info.textContent = `${res.w}×${res.h} · ${secs.toFixed(1)} s · ${total} frames · ~${mb.toFixed(0)} MB · ${src.fileName()}${o.format === "portrait" && secs > 180 ? " · Over 3 minutes: shorten for YouTube Shorts" : ""}`;
      go.disabled = !supported;
    } catch (e) {
      info.textContent = (e as Error).message;
      go.disabled = true;
    }
  };
  const go = h("button.rv-btn.rv-chip.rv-accent", { type: "button", disabled: !supported }, "Export");
  const cancel = h("button.rv-btn.rv-chip", { type: "button" }, "Cancel");
  const rangeInput = (key: "clipStart" | "clipEnd", label: string) => {
    const input = h("input", { type: "number", min: 0, max: d.n / d.tickrate, step: .01, value: o[key] == null ? "" : String(o[key]), placeholder: key === "clipStart" ? "Automatic" : "Automatic", "aria-label": label, oninput: () => {
      o[key] = input.value === "" ? null : Number(input.value);
      summary();
    } });
    return h("label.rv-check", null, label, input);
  };
  const caption = h("input", { type: "text", maxlength: CAPTION_LIMIT, value: o.caption ?? "", placeholder: "Optional caption", "aria-label": "On-video caption", oninput: () => o.caption = caption.value });
  const body = h(
    "div.rv-ex-body",
    null,
    h("button.rv-btn.rv-chip", { type: "button", onclick: () => {
      Object.assign(o, SHORTS_PRESET);
      modal.remove();
      document.removeEventListener("keydown", onKey, true);
      // Rebuild controls without triggering the automation export path.
      localStorage.setItem(PREFS_KEY, JSON.stringify(o));
      openExportDialog(src, parent);
    } }, "TikTok / YouTube Shorts preset"),
    seg("Format", [{ id: "landscape", label: "Landscape 16:9" }, { id: "portrait", label: "Portrait 9:16" }] as const, () => o.format ?? "landscape", v => o.format = v),
    seg("Resolution", RESOLUTIONS.map((r) => ({ id: r.id, label: r.id })), () => o.resolution, (v) => (o.resolution = v)),
    seg("Look", [{ id: "source", label: "Source" }, { id: "classic", label: "Plain" }, { id: "enhanced", label: "Enhanced" }, { id: "cinematic", label: "Cinematic" }], () => o.preset, (v) => (o.preset = v)),
    seg("Render quality", [{ id: 1, label: "Native" }, { id: 2, label: "2× supersampling" }], () => o.supersample, (v) => (o.supersample = v)),
    h("small.rv-ex-note", null, "Supersampling renders at twice the output width and height, then downsamples before adding the HUD. GPU texture limits reduce the scale automatically."),
    seg("Cinematic samples", [{ id: 1, label: "1 · fastest" }, { id: 2, label: "2" }, { id: 4, label: "4" }, { id: 8, label: "8 · cleanest" }], () => o.temporalSamples, (v) => (o.temporalSamples = v)),
    seg("Motion blur", [{ id: 0, label: "Off" }, { id: 90, label: "90° shutter" }, { id: 180, label: "180° shutter" }], () => o.shutterAngle, (v) => (o.shutterAngle = v)),
    h("small.rv-ex-note", null, "Multiple samples smooth geometry edges and sample motion within each replay frame. Requires Enhanced/Cinematic; adds rendering cost. Weapons, HUD and title cards stay sharp."),
    check("Depth of field", "depthOfField", "Optional subtle lens blur; Enhanced/Cinematic only. Focus distance below is in map units."),
    h("label.rv-check", null, "Focus distance", h("input", { type: "number", min: 32, max: 20000, step: 32, value: o.focusDistance, onchange: (e: Event) => { o.focusDistance = Number((e.target as HTMLInputElement).value); } })),
    seg("Frame rate", FPS_CHOICES.map((f) => ({ id: f, label: `${f} fps` })), () => o.fps, (v) => (o.fps = v)),
    seg("Quality", QUALITIES, () => o.quality ?? DEFAULT_EXPORT.quality!, (v) => (o.quality = v)),
    seg("Camera", EXPORT_CAMS, () => o.camera, (v) => (o.camera = v)),
    h(
      "div.rv-field",
      null,
      h("label", null, "Overlay"),
      h("div.rv-checks", null, check("HUD", "hud", "speed, timer, sync"), check("Keys", "keys"), check("Speed graph", "graph"), check("Title card", "intro", "map, tier, player, time, style"), check("Leaderboard outro", "outro", "results, rank and board size when available"), check("bunnyhop.lol branding", "branding", "small wordmark and branded cards"), check("Trim to the run", "trim", "1 s before / 1.5 s after; portrait starts at the run")),
    ),
    h("div.rv-field", null, h("label", null, "Sound"), h("div.rv-checks", null, check("Sound effects", "sound", "jumps, landings, footsteps, chimes"), check("Wind", "wind", "include wind with sound effects"), audioNote)),
    tracks.length ? seg("Music", [{ id: "none", label: "None" }, ...tracks.map((t) => ({ id: t.id, label: t.title }))], () => o.music, (v) => (o.music = v)) : null,
    h("div.rv-field", null, h("label", null, "Clip range (recording seconds)"), h("div.rv-ex-inputs", null, rangeInput("clipStart", "Start"), rangeInput("clipEnd", "End"), h("small", null, "Leave both blank for automatic trim. A manual range overrides trim."))),
    h("div.rv-field", null, h("label", null, "On-video caption"), h("div.rv-ex-inputs", null, caption, h("small", null, `Up to ${CAPTION_LIMIT} characters`))),
    supported ? null : h("p.rv-ex-warn", null, "This browser can't encode video: WebCodecs (VideoEncoder) is missing. MP4 export works in recent Chrome, Edge and Safari."),
    info,
  );
  const bar = h("div.rv-ex-fill");
  const status = h("div.rv-ex-status");
  const preview = h("canvas.rv-ex-preview", { width: 384, height: 216 });
  const progress = h("div.rv-ex-progress", { hidden: true }, preview, h("div.rv-ex-bar", null, bar), status);
  const modal = h(
    "div.rv-modal",
    { role: "dialog", "aria-label": "Export MP4" },
    h("div.rv-card", null, h("h3", null, "Export MP4"), body, progress, h("div.rv-ex-actions", null, cancel, go)),
  );
  parent.append(modal);
  summary();
  let running = false;
  let stop = false;
  const close = () => {
    if (running) {
      stop = true;
      return;
    }
    modal.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") (e.stopPropagation(), e.preventDefault(), close());
  };
  document.addEventListener("keydown", onKey, true);
  cancel.addEventListener("click", close);
  modal.addEventListener("click", (e) => e.target === modal && !running && close());
  const pg = preview.getContext("2d")!;
  const start = async () => {
    const size = exportSize(o);
    preview.width = o.format === "portrait" ? 216 : 384;
    preview.height = o.format === "portrait" ? 384 : 216;
    preview.style.aspectRatio = `${size.w} / ${size.h}`;
    preview.style.width = o.format === "portrait" ? "min(100%, 25.3125vh)" : "100%";
    preview.style.maxHeight = "45vh";
    preview.style.objectFit = "contain";
    localStorage.setItem(PREFS_KEY, JSON.stringify(o));
    running = true;
    stop = false;
    body.hidden = true;
    progress.hidden = false;
    go.disabled = true;
    cancel.textContent = "Cancel";
    document.documentElement.dataset.exportState = "running";
    const t0 = performance.now();
    try {
      const r = await exportMp4(
        src,
        o,
        (p, comp) => {
          bar.style.transform = `scaleX(${p.done / p.total})`;
          const el = (performance.now() - t0) / 1000;
          const eta = p.done ? (el / p.done) * (p.total - p.done) : 0;
          status.textContent = p.stage === "finish" ? "Finishing…" : p.stage === "audio" ? "Mixing the sound track…" : `Frame ${p.done} / ${p.total} · ${Math.round((p.done / p.total) * 100)}% · ${eta.toFixed(0)} s left`;
          pg.drawImage(comp, 0, 0, preview.width, preview.height);
        },
        () => stop,
      );
      running = false;
      if (!r) {
        status.textContent = "Cancelled.";
        document.documentElement.dataset.exportState = "cancelled";
        close();
        return;
      }
      lastExport = r;
      (window as unknown as { __lastExport: ExportResult }).__lastExport = r;
      saveBlob(r.blob, r.name);
      saveBlob(new Blob([JSON.stringify(r.metadata, null, 2)], { type: "application/json" }), r.name.replace(/\.mp4$/i, "") + ".graphics.json");
      document.documentElement.dataset.exportState = "saved";
      document.documentElement.dataset.exportFile = r.name;
      status.textContent = `Saved ${r.name} · ${r.frames} frames · ${r.seconds.toFixed(2)} s${r.audio ? ` · ${r.audio.toUpperCase()} sound` : ""} · ${(r.blob.size / 1048576).toFixed(1)} MB · ${(((performance.now() - t0) / 1000)).toFixed(1)} s to render`;
      cancel.textContent = "Close";
      go.disabled = false;
      go.textContent = "Save again";
      go.onclick = () => saveBlob(r.blob, r.name);
    } catch (e) {
      running = false;
      console.error(e);
      document.documentElement.dataset.exportState = "error";
      status.textContent = `Export failed: ${String((e as Error)?.message ?? e)}`;
      cancel.textContent = "Close";
    }
  };
  go.addEventListener("click", () => void start(), { once: true });
  if (auto) void start();
}
