// CS:S's HDR look inside the Enhanced / Cinematic composer (pipeline.ts), so those looks start from what the Source
// look shows and add their effects on top: right after the scene (and its added indirect light) this meters the
// linear frame (AutoExposure), scales it, and adds CS:S's bloom (CssBloom). Only on maps with HDR lighting, like
// the Source look (source-hdr.ts); elsewhere it's disabled and the composer skips it.
//
// CS:S adds bloom to the clamped gamma-space frame. Here the frame stays linear with headroom above 1 (Cinematic's
// highlight shoulder needs it), so the pass adds the difference that addition makes to the clamped part.
import * as THREE from "three";
import { FullScreenQuad, Pass } from "three/addons/postprocessing/Pass.js";
import { AutoExposure, CssBloom } from "./source-hdr";

const FRAGMENT = `
  uniform sampler2D tDiffuse; uniform sampler2D tBloom; uniform float exposure; uniform float bloom; varying vec2 vUv;
  vec3 toGamma(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
  vec3 toLinear(vec3 g) { return mix(g / 12.92, pow((g + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), g)); }
  void main() {
    vec4 frame = texture2D(tDiffuse, vUv);
    vec3 c = frame.rgb * exposure;
    vec3 base = clamp(c, 0.0, 1.0);
    vec3 bloomed = toLinear(toGamma(base) + texture2D(tBloom, vUv).rgb * bloom);
    gl_FragColor = vec4(c + bloomed - base, frame.a);
  }`;

export class SourceHdrPass extends Pass {
  readonly auto: AutoExposure;
  /** Visual seconds since the last frame (set by the pipeline before each render). */
  dt = 0;
  /** CS:S's bloom on or off (the Bloom setting). */
  bloom = true;
  private readonly cssBloom: CssBloom;
  private readonly material = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null as THREE.Texture | null }, tBloom: { value: null as THREE.Texture | null }, exposure: { value: 1 }, bloom: { value: 1 } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: FRAGMENT,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly quad = new FullScreenQuad(this.material);

  constructor(renderer: THREE.WebGLRenderer) {
    super();
    this.auto = new AutoExposure(renderer);
    this.cssBloom = new CssBloom(renderer);
  }

  override setSize(width: number, height: number): void {
    this.cssBloom.setSize(width, height);
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    this.auto.update(readBuffer.texture, this.dt);
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.exposure.value = this.auto.value;
    u.tBloom.value = this.cssBloom.render(readBuffer.texture, this.auto.value, 1);
    u.bloom.value = this.bloom ? 1 : 0;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.auto.dispose();
    this.cssBloom.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
