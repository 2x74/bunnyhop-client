// Motion blur for exports in the looks without the post-processing composer (Source, Plain), where the pipeline's own
// temporal accumulation (graphics/cinematic-sampling.ts) isn't there: each replay subframe is rendered to the canvas as
// usual, copied into a texture and added into a half-float target with weight 1 / samples; the average goes back to
// the canvas. Averaging happens in linear light (sRGB decoded on the way in, encoded on the way out), like a camera
// shutter. The copy target is RGB8: the game's canvas has no alpha channel, and copying it into an RGBA texture is an
// INVALID_OPERATION in WebGL2 (checked on Chrome 153 / Metal).
import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

const vertexShader = "varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}";
const toLinear = "vec3 lin(vec3 c){return mix(c/12.92,pow((c+.055)/1.055,vec3(2.4)),step(.04045,c));}";
const toSrgb = "vec3 srgb(vec3 c){c=max(c,0.);return mix(c*12.92,1.055*pow(c,vec3(1./2.4))-.055,step(.0031308,c));}";

export class FrameBlend {
  private frame: THREE.FramebufferTexture;
  private sum: THREE.WebGLRenderTarget;
  private add = new THREE.ShaderMaterial({
    uniforms: { map: { value: null as THREE.Texture | null }, weight: { value: 1 } },
    vertexShader,
    fragmentShader: `uniform sampler2D map;uniform float weight;varying vec2 vUv;${toLinear}void main(){gl_FragColor=vec4(lin(texture2D(map,vUv).rgb)*weight,1.);}`,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquation: THREE.AddEquation,
    depthTest: false,
    depthWrite: false,
  });
  private out = new THREE.ShaderMaterial({
    uniforms: { map: { value: null as THREE.Texture | null } },
    vertexShader,
    fragmentShader: `uniform sampler2D map;varying vec2 vUv;${toSrgb}void main(){gl_FragColor=vec4(srgb(texture2D(map,vUv).rgb),1.);}`,
    depthTest: false,
    depthWrite: false,
  });
  private quad = new FullScreenQuad(this.add);
  private n = 0;

  constructor(readonly width: number, readonly height: number) {
    this.frame = new THREE.FramebufferTexture(width, height);
    this.frame.format = THREE.RGBFormat;
    // three leaves RGB + UNSIGNED_BYTE unsized ("RGB"), which texStorage2D rejects (INVALID_ENUM).
    this.frame.internalFormat = "RGB8";
    this.frame.minFilter = this.frame.magFilter = THREE.NearestFilter;
    this.sum = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.add.uniforms.map.value = this.frame;
    this.out.uniforms.map.value = this.sum.texture;
  }

  begin(renderer: THREE.WebGLRenderer): void {
    const target = renderer.getRenderTarget();
    const clear = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.sum);
    renderer.setClearColor(0, 0);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(target);
    renderer.setClearColor(clear, alpha);
    this.n = 0;
  }

  /** Adds what the canvas shows now with `weight`. */
  addCanvas(renderer: THREE.WebGLRenderer, weight: number): void {
    const target = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    renderer.setRenderTarget(null);
    renderer.copyFramebufferToTexture(this.frame);
    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(this.sum);
      this.add.uniforms.weight.value = weight;
      this.quad.material = this.add;
      this.quad.render(renderer);
      this.n++;
    } finally {
      renderer.setRenderTarget(target);
      renderer.autoClear = autoClear;
    }
  }

  /** Writes the average to the canvas. */
  resolve(renderer: THREE.WebGLRenderer): void {
    const target = renderer.getRenderTarget();
    renderer.setRenderTarget(null);
    this.quad.material = this.out;
    this.quad.render(renderer);
    renderer.setRenderTarget(target);
  }

  get samples(): number {
    return this.n;
  }

  dispose(): void {
    this.frame.dispose();
    this.sum.dispose();
    this.add.dispose();
    this.out.dispose();
    this.quad.dispose();
  }
}
