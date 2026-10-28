// The game's renderer front (gameplay, replays, export, menu background). It draws the Source and Plain looks itself
// and loads the Enhanced / Cinematic composer (composer-pipeline.ts: post-processing, shadows, local lights, indirect
// light, sky packs, clouds) only when one of those looks is picked, so players on Source or Plain never download it.
// While it loads, frames draw in the Source look.
//
//   const pipeline = new GraphicsPipeline(renderer); pipeline.setOptions(prefs.graphics); pipeline.setSize(w, h)
//   pipeline.render(scene, camera, visualSeconds)                                                 every frame
import * as THREE from "three";
import { presetConfig, type GraphicsOptions } from "./presets";
import { resolveVisualProfile } from "./profiles";
import { publishHybridStatus } from "./hybrid-status";
import { SourceHdr } from "./source-hdr";
import { WaterCapture, type WaterCaptureQuality } from "../water-capture";
import type { ComposerPipeline } from "./composer-pipeline";

/** CS:S's expensive water (reflect world): one reflection plane, captures at half resolution. Off: the plain water shader. */
const SOURCE_WATER: WaterCaptureQuality = { reflectionScale: 0.5, refractionScale: 0.5, maxReflectionPlanes: 1 };
const NO_WATER_CAPTURE: WaterCaptureQuality = { reflectionScale: 0, refractionScale: 0, maxReflectionPlanes: 0 };

type Composer = ComposerPipeline;

export class GraphicsPipeline {
  /** Half-float targets need renderable floating point colour; without them the composer looks draw plainly. */
  readonly supported: boolean;
  private options: GraphicsOptions = { preset: "source", potato: false };
  private width = 1;
  private height = 1;
  private mapName = "";
  private mapHash = "";
  private composer: Composer | null = null;
  private composerLoad: Promise<Composer> | null = null;
  /** The composer drew the last frame (switching away resets what it changed on shared materials and the sky). */
  private composerActive = false;

  private sourceHdr: SourceHdr | null = null;
  private sourceWater: WaterCapture | null = null;
  /** The world root the Source look's water capture and exposure belong to (a new map or replay world resets them). */
  private sourceWorld: THREE.Object3D | null = null;
  private sourceTime = 0;

  constructor(readonly renderer: THREE.WebGLRenderer) {
    this.supported = renderer.extensions.has("EXT_color_buffer_float");
  }

  /** Whether these options draw through the composer (and so need it loaded). */
  private wantsComposer(options = this.options): boolean {
    return presetConfig(options).postprocessing && this.supported;
  }

  /** Loads the composer once and brings it up to date with the current options, size and map. */
  private loadComposer(): Promise<Composer> {
    this.composerLoad ??= import("./composer-pipeline").then(({ ComposerPipeline }) => {
      const c = new ComposerPipeline(this.renderer);
      c.setMap(this.mapName, this.mapHash);
      c.setOptions(this.options);
      c.setSize(this.width, this.height);
      this.composer = c;
      return c;
    });
    return this.composerLoad;
  }

  getOptions(): GraphicsOptions {
    return { ...this.options };
  }

  setOptions(options: GraphicsOptions): void {
    this.options = { ...options };
    if (this.wantsComposer()) void this.loadComposer();
    else if (options.tracedGI) publishHybridStatus({ status: "off", reason: "Requires Enhanced or Cinematic; inactive in Classic/Potato.", loaded: false });
    this.composer?.setOptions(options);
    if (presetConfig(options).preset !== "source") this.releaseSource();
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.composer?.setSize(width, height);
  }

  setMap(name: string, hash = ""): void {
    this.mapName = name;
    this.mapHash = hash;
    this.composer?.setMap(name, hash);
  }

  render(scene: THREE.Scene, camera: THREE.Camera, timeSeconds = 0): void {
    if (this.composer && this.wantsComposer()) {
      this.composerActive = true;
      this.composer.render(scene, camera, timeSeconds);
      return;
    }
    if (this.composerActive) {
      this.composerActive = false;
      this.composer?.resetEffects();
    }
    if (presetConfig(this.options).preset === "source") this.renderSource(scene, camera, timeSeconds);
    else this.renderer.render(scene, camera);
  }

  /** The Source look: CS:S water reflections everywhere, CS:S HDR (auto exposure, bloom) on maps with HDR lighting. */
  private renderSource(scene: THREE.Scene, camera: THREE.Camera, timeSeconds: number): void {
    const world = scene.children.find((o) => o.userData.lightmapHdr !== undefined) ?? null;
    const hdr = (this.sourceHdr ??= new SourceHdr(this.renderer));
    if (world !== this.sourceWorld) {
      this.sourceWater?.dispose();
      this.sourceWater = world ? new WaterCapture(scene) : null;
      this.sourceWorld = world;
      hdr.reset();
      this.sourceTime = timeSeconds;
    }
    this.sourceWater?.render(this.renderer, camera, this.options.waterReflections === false ? NO_WATER_CAPTURE : SOURCE_WATER);
    // Visual time, not the wall clock: paused views hold their exposure and exports adapt the same way every time.
    const dt = Math.max(0, timeSeconds - this.sourceTime);
    this.sourceTime = timeSeconds;
    if (!hdr.active(scene)) {
      this.renderer.render(scene, camera);
      return;
    }
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    hdr.setSize(size.x, size.y);
    hdr.bloom = this.options.bloom !== false;
    hdr.render(scene, camera, dt);
  }

  private releaseSource(): void {
    this.sourceWater?.dispose();
    this.sourceWater = null;
    this.sourceWorld = null;
    this.sourceHdr?.dispose();
    this.sourceHdr = null;
  }

  /** Current CS:S exposure (1 off maps with HDR lighting), for checks and captures. */
  getSourceExposure(): number {
    if (this.composer && this.wantsComposer()) return this.composer.getSourceExposure();
    return this.sourceHdr?.currentExposure ?? 1;
  }

  // Export: the composer looks need the composer (and its sky pack) settled before the first frame.
  async prepareForExport(): Promise<void> {
    if (this.wantsComposer()) await this.loadComposer();
    await this.composer?.prepareForExport();
  }
  finishExport(options: GraphicsOptions): void {
    if (this.composer) this.composer.finishExport(options);
    this.setOptions(options);
  }
  resetEffects(): void {
    this.composer?.resetEffects();
    this.sourceHdr?.reset();
  }
  beginCinematicFrame(count: number): void { this.composer?.beginCinematicFrame(count); }
  beginCinematicSample(index: number): void { this.composer?.beginCinematicSample(index); }
  endCinematicFrame(): void { this.composer?.endCinematicFrame(); }
  resetCinematicSampling(): void { this.composer?.resetCinematicSampling(); }
  async whenTracedGISettled(): Promise<void> { await this.composer?.whenTracedGISettled(); }

  // Status for the settings screen, export metadata and checks. Without the composer nothing extra is active.
  getProfile(): ReturnType<Composer["getProfile"]> {
    return this.composer?.getProfile() ?? resolveVisualProfile(this.mapName, this.mapHash, this.options, false);
  }
  getEffectiveEffects(): ReturnType<Composer["getEffectiveEffects"]> {
    return this.composer && this.wantsComposer() ? this.composer.getEffectiveEffects() : {
      clouds: false, customSky: false, ambienceShowcase: false, contactShading: false, atmosphere: false, sunShafts: false, depthOfField: false,
      bloom: false, localLights: false, dynamicGI: false, tracedGI: false, dynamicShadows: false, volumetric: false, spatialAA: false, materialResponse: false,
    };
  }
  getSkyState(): ReturnType<Composer["getSkyState"]> {
    return this.composer?.getSkyState() ?? { mode: "map", loading: false, error: null, asset: null, rotation: 0, exposure: 1, lightingSource: "map", lightingClamped: false };
  }
  getSkyMetadata(): ReturnType<Composer["getSkyMetadata"]> {
    return this.composer?.getSkyMetadata() ?? { mode: "map", id: null, version: null, hash: null, precision: null, rotation: 0, exposure: 1, lightingSource: "map", lightingClamped: false, error: null };
  }
  getCloudMetadata(): ReturnType<Composer["getCloudMetadata"]> {
    return this.composer?.getCloudMetadata() ?? { active: false, quality: "off", coverage: 0, density: 0, seed: 1, baseHeight: 0, steps: 0 };
  }
  getCloudStats(): ReturnType<Composer["getCloudStats"]> { return this.composer?.getCloudStats() ?? null; }
  getShadowStats(): ReturnType<Composer["getShadowStats"]> { return this.composer?.getShadowStats() ?? null; }
  getShadowSampling(): ReturnType<Composer["getShadowSampling"]> { return this.composer?.getShadowSampling() ?? null; }
  getLocalLightStats(): ReturnType<Composer["getLocalLightStats"]> { return this.composer?.getLocalLightStats() ?? null; }
  getLocalLightUniforms(): ReturnType<Composer["getLocalLightUniforms"]> { return this.composer?.getLocalLightUniforms() ?? null; }
  getGIStats(): ReturnType<Composer["getGIStats"]> { return this.composer?.getGIStats() ?? null; }
  getTracedGIStats(): ReturnType<Composer["getTracedGIStats"]> {
    return this.composer?.getTracedGIStats() ?? { loaded: false, status: "off", error: null, active: false, mode: "authored-lighting-delta", historyLimit: 8 };
  }

  dispose(): void {
    this.composer?.dispose();
    this.releaseSource();
  }
}
