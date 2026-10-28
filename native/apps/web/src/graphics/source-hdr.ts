// CS:S's HDR look (mat_hdr_level 2) for maps compiled with HDR lighting: auto exposure and bloom, as SDK 2013's
// viewpostprocess.cpp does them for cstrike. LDR-only maps draw the way CS:S draws them too: exposure 1, no bloom
// (GetBloomAmount is 0 without HDR lighting), so they skip this and render straight to the screen.
//
// Per frame: the world is drawn into a half-float target (linear light, before exposure), then
// - bloom (Generate8BitBloomTexture with dev/downsample_non_hdr_cstrike): a quarter-size copy of the exposed frame
//   shaped as `luminance * colour`, blurred by BlurFilterX/Y's 13 taps, and added onto the gamma-space frame;
// - auto exposure (CLuminanceHistogramSystem's original algorithm, which cstrike forces): the mean luminance of the
//   exposed, gamma-space frame over the centre 90% x 85% sets the goal `TARGET / mean`, averaged over the last 10
//   goals and clamped to mat_autoexposure_min / max (0.5 - 2). The frame's own exposure is in that mean, so a scene
//   settles where exposure x mean = TARGET (softer than full normalisation, as in CS:S). The current exposure moves
//   toward the goal over about a second, three times faster when darkening (mat_accelerate_adjust_exposure_down 3).
// The mean is read back asynchronously from a tiny luminance target, a few times a second, so it never stalls a frame.
//
//   const hdr = new SourceHdr(renderer); hdr.setSize(w, h)
//   if (hdr.active(scene)) hdr.render(scene, camera, dtSeconds); else renderer.render(scene, camera)
// The Enhanced / Cinematic composer (pipeline.ts) uses AutoExposure on its own scene target the same way.

import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

/** Mean gamma-space luminance the exposure settles on. Calibrated so bhop_shutdown's start (pad *230, yaw 90) sits at
 * exposure 1, as in a CS:S render of that view (huddled, 2026-10-26); SDK 2013's own constant assumes its bucketed
 * occlusion-query histogram. */
const TARGET = 0.37;
const MIN_EXPOSURE = 0.5;
const MAX_EXPOSURE = 2;
const GOAL_HISTORY = 10;
/** Exposure change per second, in stops of the remaining distance (darkening is 3x faster). */
const ADAPT_RATE = 1.2;
const ADAPT_DOWN = 3;
/** Seconds between exposure measurements. */
const MEASURE_EVERY = 0.12;
/** Luminance read-back size (the centre 90% x 85% of the frame). */
const LUM_W = 32;
const LUM_H = 18;

const VERTEX = "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";
const SRGB = `
  vec3 toGamma(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }`;

/** A full-screen shader pass and its uniforms. */
class Pass<U extends Record<string, THREE.IUniform>> {
  readonly material: THREE.ShaderMaterial;
  readonly quad: FullScreenQuad;
  constructor(fragmentShader: string, readonly uniforms: U) {
    this.material = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false });
    this.quad = new FullScreenQuad(this.material);
  }
  render(renderer: THREE.WebGLRenderer): void {
    this.quad.render(renderer);
  }
  dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}

/** Downsample_nohdr_ps2x.fxc (CSTRIKE): four taps of the exposed frame, each `NTSC luminance * linear colour`. */
const DOWNSAMPLE = `
  uniform sampler2D tScene; uniform vec2 texel; uniform float exposure; varying vec2 vUv;
  vec3 shape(vec2 uv) {
    vec3 c = clamp(texture2D(tScene, uv).rgb * exposure, 0.0, 1.0);
    return dot(c, vec3(0.3, 0.59, 0.11)) * c;
  }
  void main() {
    vec2 o = texel;
    gl_FragColor = vec4((shape(vUv + vec2(-o.x, -o.y)) + shape(vUv + vec2(o.x, -o.y)) + shape(vUv + vec2(-o.x, o.y)) + shape(vUv + o)) * 0.25, 1.0);
  }`;

/** BlurFilter_ps2x.fxc: 13 taps at BlurFilterX/Y.cpp's offsets (in quarter-size texels), times `scale`. */
const BLUR = `
  uniform sampler2D tInput; uniform vec2 step; uniform float scale; varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tInput, vUv).rgb * 0.2013;
    c += (texture2D(tInput, vUv + step * 1.3366).rgb + texture2D(tInput, vUv - step * 1.3366).rgb) * 0.2185;
    c += (texture2D(tInput, vUv + step * 3.4295).rgb + texture2D(tInput, vUv - step * 3.4295).rgb) * 0.0821;
    c += (texture2D(tInput, vUv + step * 5.4264).rgb + texture2D(tInput, vUv - step * 5.4264).rgb) * 0.0461;
    c += (texture2D(tInput, vUv + step * 7.4359).rgb + texture2D(tInput, vUv - step * 7.4359).rgb) * 0.0262;
    c += (texture2D(tInput, vUv + step * 9.4436).rgb + texture2D(tInput, vUv - step * 9.4436).rgb) * 0.0162;
    c += (texture2D(tInput, vUv + step * 11.4401).rgb + texture2D(tInput, vUv - step * 11.4401).rgb) * 0.0102;
    gl_FragColor = vec4(c * scale, 1.0);
  }`;

/** Engine_Post_ps2x.fxc: the exposed frame in gamma space, plus the bloom texture as is. */
const COMPOSITE = `
  uniform sampler2D tScene; uniform sampler2D tBloom; uniform float exposure; varying vec2 vUv;
  ${SRGB}
  void main() { gl_FragColor = vec4(toGamma(texture2D(tScene, vUv).rgb * exposure) + texture2D(tBloom, vUv).rgb, 1.0); }`;

/** luminance_compare_ps2x.fxc's luminance of the exposed gamma-space frame, over the metered centre. */
const LUMINANCE = `
  uniform sampler2D tScene; uniform float exposure; varying vec2 vUv;
  ${SRGB}
  void main() {
    vec2 uv = vec2(0.05, 0.075) + vUv * vec2(0.9, 0.85);
    gl_FragColor = vec4(vec3(dot(toGamma(texture2D(tScene, uv).rgb * exposure), vec3(0.2125, 0.7154, 0.0721))), 1.0);
  }`;

/** Whether `scene` holds a world built from HDR lighting (render.ts tags its root). */
export function hdrWorld(scene: THREE.Scene): boolean {
  return scene.children.some((o) => o.userData.lightmapHdr === true);
}

/** CS:S auto exposure over a linear (pre-exposure) frame; see the top of this file. */
export class AutoExposure {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly luminance = new Pass(LUMINANCE, { tScene: { value: null as THREE.Texture | null }, exposure: { value: 1 } });
  private readonly target = new THREE.WebGLRenderTarget(LUM_W, LUM_H, { depthBuffer: false });
  private readonly pixels = new Uint8Array(LUM_W * LUM_H * 4);
  private goals: number[] = [];
  private sinceMeasure = 0;
  private reading = false;
  /** The current exposure (1 until something has been measured). */
  value = 1;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
  }

  /** A new map, or a cut: start from exposure 1 like a level load does. */
  reset(): void {
    this.value = 1;
    this.goals = [];
    this.sinceMeasure = 0;
  }

  /** Measure `frame` now and then (asynchronously) and move the exposure toward the averaged goal. */
  update(frame: THREE.Texture, dt: number): void {
    dt = Math.min(Math.max(dt, 0), 0.25);
    this.sinceMeasure += dt;
    if (!this.reading && this.sinceMeasure >= MEASURE_EVERY) {
      this.sinceMeasure = 0;
      this.reading = true;
      const r = this.renderer;
      const previous = r.getRenderTarget();
      this.luminance.uniforms.tScene.value = frame;
      this.luminance.uniforms.exposure.value = this.value;
      r.setRenderTarget(this.target);
      this.luminance.render(r);
      r.setRenderTarget(previous);
      r.readRenderTargetPixelsAsync(this.target, 0, 0, LUM_W, LUM_H, this.pixels)
        .then(() => this.addGoal())
        .catch(() => {})
        .finally(() => (this.reading = false));
    }
    if (!this.goals.length) return;
    const goal = this.goals.reduce((s, g) => s + g, 0) / this.goals.length;
    const stops = Math.log2(goal / this.value);
    const rate = ADAPT_RATE * (stops < 0 ? ADAPT_DOWN : 1);
    this.value *= 2 ** (stops * Math.min(1, rate * dt));
  }

  private addGoal(): void {
    let sum = 0;
    for (let i = 0; i < this.pixels.length; i += 4) sum += this.pixels[i];
    const mean = Math.max(1e-4, sum / (255 * LUM_W * LUM_H));
    this.goals.push(Math.min(MAX_EXPOSURE, Math.max(MIN_EXPOSURE, TARGET / mean)));
    if (this.goals.length > GOAL_HISTORY) this.goals.shift();
  }

  dispose(): void {
    this.luminance.dispose();
    this.target.dispose();
  }
}

/** CS:S's bloom texture (Generate8BitBloomTexture) of a linear frame, at quarter size. */
export class CssBloom {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly downsample = new Pass(DOWNSAMPLE, { tScene: { value: null as THREE.Texture | null }, texel: { value: new THREE.Vector2() }, exposure: { value: 1 } });
  private readonly blur = new Pass(BLUR, { tInput: { value: null as THREE.Texture | null }, step: { value: new THREE.Vector2() }, scale: { value: 1 } });
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private width = 1;
  private height = 1;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
  }

  /** Full-size frame dimensions. */
  setSize(width: number, height: number): void {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (width === this.width && height === this.height && this.targets) return;
    this.width = width;
    this.height = height;
    this.targets?.forEach((t) => t.dispose());
    const qw = Math.max(1, Math.floor(width / 4)), qh = Math.max(1, Math.floor(height / 4));
    const quarter = () => new THREE.WebGLRenderTarget(qw, qh, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.targets = [quarter(), quarter()];
  }

  /** The bloom of `frame` (linear) seen at `exposure`, times `scale`; add it to the gamma-space frame. */
  render(frame: THREE.Texture, exposure: number, scale: number): THREE.Texture {
    if (!this.targets) this.setSize(this.width, this.height);
    const [a, b] = this.targets!;
    const r = this.renderer;
    const previous = r.getRenderTarget();
    this.downsample.uniforms.tScene.value = frame;
    this.downsample.uniforms.texel.value.set(1 / this.width, 1 / this.height);
    this.downsample.uniforms.exposure.value = exposure;
    r.setRenderTarget(a);
    this.downsample.render(r);
    this.blurInto(a, b, 1 / a.width, 0, 1);
    this.blurInto(b, a, 0, 1 / a.height, scale);
    r.setRenderTarget(previous);
    return a.texture;
  }

  private blurInto(from: THREE.WebGLRenderTarget, to: THREE.WebGLRenderTarget, sx: number, sy: number, scale: number): void {
    const u = this.blur.uniforms;
    u.tInput.value = from.texture;
    u.step.value.set(sx, sy);
    u.scale.value = scale;
    this.renderer.setRenderTarget(to);
    this.blur.render(this.renderer);
  }

  dispose(): void {
    this.targets?.forEach((t) => t.dispose());
    this.targets = null;
    this.downsample.dispose();
    this.blur.dispose();
  }
}

export class SourceHdr {
  /** Half-float colour buffers are needed for the linear scene target. */
  readonly supported: boolean;
  private readonly renderer: THREE.WebGLRenderer;
  private scene: THREE.WebGLRenderTarget | null = null;
  private readonly cssBloom: CssBloom;
  private readonly composite = new Pass(COMPOSITE, { tScene: { value: null as THREE.Texture | null }, tBloom: { value: null as THREE.Texture | null }, exposure: { value: 1 } });
  private readonly exposure: AutoExposure;
  private width = 1;
  private height = 1;
  /** env_tonemap_controller's SetBloomScale (mat_bloomscale 1 otherwise). */
  bloomScale = 1;
  /** Bloom on or off (the Graphics setting); exposure still adapts without it. */
  bloom = true;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.supported = renderer.capabilities.isWebGL2 && renderer.extensions.has("EXT_color_buffer_float");
    this.exposure = new AutoExposure(renderer);
    this.cssBloom = new CssBloom(renderer);
  }

  /** Whether `scene` holds a world built from HDR lighting and this GPU can draw it that way. */
  active(scene: THREE.Scene): boolean {
    return this.supported && hdrWorld(scene);
  }

  /** The current exposure (1 until something has been measured). */
  get currentExposure(): number {
    return this.exposure.value;
  }

  /** A new map, or a cut (spectating someone, a replay seek): start from exposure 1 like a level load does. */
  reset(): void {
    this.exposure.reset();
  }

  setSize(width: number, height: number): void {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (width === this.width && height === this.height && this.scene) return;
    this.width = width;
    this.height = height;
    this.disposeTargets();
    this.cssBloom.setSize(width, height);
  }

  render(scene: THREE.Scene, camera: THREE.Camera, dt: number): void {
    const r = this.renderer;
    this.ensureTargets();
    const previous = r.getRenderTarget();
    r.setRenderTarget(this.scene);
    r.render(scene, camera);

    const exposure = this.exposure.value;
    const bloom = this.bloom && this.bloomScale > 0;
    this.composite.uniforms.tScene.value = this.scene!.texture;
    this.composite.uniforms.tBloom.value = bloom ? this.cssBloom.render(this.scene!.texture, exposure, this.bloomScale) : this.blackTexture();
    this.composite.uniforms.exposure.value = exposure;
    r.setRenderTarget(previous);
    this.composite.render(r);

    this.exposure.update(this.scene!.texture, dt);
  }

  private black: THREE.DataTexture | null = null;
  private blackTexture(): THREE.Texture {
    if (!this.black) {
      this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
      this.black.needsUpdate = true;
    }
    return this.black;
  }

  private ensureTargets(): void {
    if (this.scene) return;
    const samples = this.renderer.getContext().getContextAttributes()?.antialias ? 4 : 0;
    this.scene = new THREE.WebGLRenderTarget(this.width, this.height, { type: THREE.HalfFloatType, samples, depthBuffer: true });
  }

  private disposeTargets(): void {
    this.scene?.dispose();
    this.scene = null;
  }

  dispose(): void {
    this.disposeTargets();
    this.composite.dispose();
    this.cssBloom.dispose();
    this.exposure.dispose();
    this.black?.dispose();
  }
}
