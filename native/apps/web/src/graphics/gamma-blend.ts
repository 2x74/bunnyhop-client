// The map's blended surfaces (glass, $translucent and $additive materials) in the looks that draw the world into a
// linear half-float target (the Source look on maps with HDR lighting, Enhanced, Cinematic). Blended there, in linear
// light, a bright glass texture flattens everything behind it, auto exposure (up to 2x in a dark room) turns it white
// and bloom makes it glow, and it fades back as you walk up to it, because the exposure drops once the glass fills
// the view. CS:S's LDR path and the Plain look blend them in gamma space on an 8-bit frame, where what's behind
// a window stays readable. So these looks leave them out of the linear frame and draw them after the frame's final
// pass, onto the canvas, against the scene's depth, the way Plain draws them.
// Translucent surfaces take the frame's exposure, like the walls around them. Additive ones add their texture as
// is, as in CS:S's LDR path, so a dark room's exposure doesn't turn them white.
//
//   markGammaBlend(material)                            render.ts / water.ts, for the map's blended materials
//   const blend = new GammaBlend(renderer)
//   const drawn = blend.hide(scene)                     before drawing the scene into the linear target
//   ... draw, post-process, final pass to the canvas
//   if (drawn) blend.draw(camera, sceneDepth, exposure)
//
// A motion-blur export (Enhanced, Cinematic) runs the composer once per sample and overwrites the canvas each time, so
// drawing onto the canvas would leave only the last sample's surfaces: sharp, in front of a blurred world. There each
// sample draws them into a transparent layer instead (accumulate), the layers are averaged, and the average goes over
// the finished frame once (resolveAccumulated). "Over" is closed under averaging premultiplied colour and coverage, so
// this is the same integral as compositing every sample on its own frame.
//
// The canvas pass draws a scene of stand-ins: one per world mesh with blended materials, sharing its geometry (and so
// the groups cull.ts picked for this view) and its transform, with only the blended materials. A handful of objects,
// so it costs a few draws, not a second walk over the scene.
import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

/** Tags a map material as blended (drawn by GammaBlend in the HDR looks). */
export function markGammaBlend<M extends THREE.Material>(material: M): M {
  material.userData.gammaBlend = true;
  return material;
}

export const isGammaBlend = (material: THREE.Material): boolean => material.userData.gammaBlend === true;

const materialsOf = (mesh: THREE.Mesh): THREE.Material[] => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);

/** Meshes of the main view (layer 0; not the 3D skybox, drawn from its own camera) holding a blended material. */
export function gammaBlendMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.layers.isEnabled(0) && materialsOf(mesh).some(isGammaBlend)) meshes.push(mesh);
  });
  return meshes;
}

/** Whether `o` and all its parents are visible. */
function shown(o: THREE.Object3D | null): boolean {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/** Writes a depth texture into the bound target's depth buffer (colour untouched). */
const DEPTH_COPY = `
  uniform sampler2D tDepth; varying vec2 vUv;
  void main() { gl_FragDepth = texture2D(tDepth, vUv).x; gl_FragColor = vec4(0.0); }`;

/** Whether `renderer` writes linear colour now, not the canvas's encoding: see GammaBlend's layer (an XR-flagged target). */
export function outputsLinear(renderer: THREE.WebGLRenderer): boolean {
  const target = renderer.getRenderTarget() as (THREE.WebGLRenderTarget & { isXRRenderTarget?: boolean }) | null;
  return (target !== null && target.isXRRenderTarget !== true) || renderer.outputColorSpace !== THREE.SRGBColorSpace;
}

const FULLSCREEN = "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";
const SAMPLE = "uniform sampler2D map; uniform float weight; varying vec2 vUv; void main() { gl_FragColor = texture2D(map, vUv) * weight; }";

/** Skips a stand-in's other groups. */
const SKIP = new THREE.MeshBasicMaterial({ visible: false });

interface StandIn {
  mesh: THREE.Mesh;
  proxy: THREE.Mesh;
  materials: THREE.Material[];
}

export class GammaBlend {
  private readonly depthCopy = new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: { tDepth: { value: null as THREE.Texture | null } },
    vertexShader: FULLSCREEN,
    fragmentShader: DEPTH_COPY,
    colorWrite: false,
    depthTest: true,
    depthFunc: THREE.AlwaysDepth,
    depthWrite: true,
    toneMapped: false,
  }));
  /** The world root (render.ts tags it with lightmapHdr) the stand-ins were made for. */
  private world: THREE.Object3D | null = null;
  private readonly standIns: StandIn[] = [];
  private readonly proxies = new THREE.Scene();
  private readonly hidden = new Set<THREE.Material>();
  private depthTarget: THREE.WebGLRenderTarget | null = null;
  /** One sample's blended surfaces on transparent black: sRGB-encoded, premultiplied, as they'd land on the canvas. */
  private layer: THREE.WebGLRenderTarget | null = null;
  /** The running sum of the layers. */
  private layerSum: THREE.WebGLRenderTarget | null = null;
  private accumulated = false;
  private readonly layerQuad = new FullScreenQuad();
  private readonly layerAdd = new THREE.ShaderMaterial({
    uniforms: { map: { value: null as THREE.Texture | null }, weight: { value: 1 } },
    vertexShader: FULLSCREEN,
    fragmentShader: SAMPLE,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquation: THREE.AddEquation,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly layerOver = new THREE.ShaderMaterial({
    uniforms: { map: { value: null as THREE.Texture | null }, weight: { value: 1 } },
    vertexShader: FULLSCREEN,
    fragmentShader: SAMPLE,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.proxies.matrixWorldAutoUpdate = false;
  }

  private standInsFor(scene: THREE.Scene): StandIn[] {
    const world = scene.children.find((o) => o.userData.lightmapHdr !== undefined) ?? null;
    if (world !== this.world) {
      this.world = world;
      this.proxies.clear();
      this.standIns.length = 0;
      for (const mesh of world ? gammaBlendMeshes(world) : []) {
        const proxy = new THREE.Mesh(mesh.geometry);
        proxy.matrixAutoUpdate = false;
        this.proxies.add(proxy);
        this.standIns.push({ mesh, proxy, materials: [] });
      }
    }
    return this.standIns;
  }

  /**
   * Hides `scene`'s blended materials until draw() (or show()). Returns whether any were showing, i.e. whether draw()
   * has anything to do.
   */
  hide(scene: THREE.Scene): boolean {
    this.show();
    for (const { mesh } of this.standInsFor(scene)) {
      if (!mesh.visible) continue;
      for (const m of materialsOf(mesh)) {
        if (!isGammaBlend(m) || !m.visible) continue;
        m.visible = false;
        this.hidden.add(m);
      }
    }
    return this.hidden.size > 0;
  }

  /** Shows what hide() hid. */
  show(): void {
    for (const m of this.hidden) m.visible = true;
    this.hidden.clear();
  }

  /**
   * Draws the materials hide() hid onto the bound target (the canvas, holding the frame's final colour) over the
   * scene's `depth`, then shows them again. `exposure`: the frame's, for the translucent ones.
   */
  draw(camera: THREE.Camera, depth: THREE.Texture, exposure: number): void {
    const r = this.renderer;
    if (!this.hidden.size) return;
    const blended = new Set(this.hidden);
    this.show();
    this.drawBlended(blended, camera, depth, exposure);
  }

  /**
   * Motion blur: like draw(), for one of the frame's samples, into the layer sum with `weight`. The canvas isn't touched
   * until resolveAccumulated(). Leaves the render target as it found it.
   */
  accumulate(camera: THREE.Camera, depth: THREE.Texture, exposure: number, weight: number): void {
    const r = this.renderer;
    if (!this.hidden.size) return;
    const blended = new Set(this.hidden);
    this.show();
    const image = depth.image as { width: number; height: number };
    const { layer, sum } = this.layerTargets(image.width, image.height);
    const target = r.getRenderTarget();
    const clear = r.getClearColor(new THREE.Color());
    const alpha = r.getClearAlpha();
    const autoClear = r.autoClear;
    // Additive surfaces add light and cover nothing: their blend leaves the layer's coverage alone. Only the blend state
    // changes, so they keep their programs.
    const additive: THREE.Material[] = [];
    for (const m of blended) {
      if (m.blending !== THREE.AdditiveBlending) continue;
      additive.push(m);
      m.blending = THREE.CustomBlending;
      m.blendSrc = THREE.SrcAlphaFactor;
      m.blendDst = THREE.OneFactor;
      m.blendSrcAlpha = THREE.ZeroFactor;
      m.blendDstAlpha = THREE.OneFactor;
      m.blendEquation = THREE.AddEquation;
    }
    try {
      r.setClearColor(0, 0);
      if (!this.accumulated) {
        r.setRenderTarget(sum);
        r.clear(true, false, false);
        this.accumulated = true;
      }
      r.setRenderTarget(layer);
      r.clear(true, false, false);
      this.drawBlended(blended, camera, depth, exposure);
      r.autoClear = false;
      r.setRenderTarget(sum);
      this.layerAdd.uniforms.map.value = layer.texture;
      this.layerAdd.uniforms.weight.value = weight;
      this.layerQuad.material = this.layerAdd;
      this.layerQuad.render(r);
    } finally {
      for (const m of additive) m.blending = THREE.AdditiveBlending;
      r.setRenderTarget(target);
      r.setClearColor(clear, alpha);
      r.autoClear = autoClear;
    }
  }

  /** Draws the frame's averaged layers over the bound target (the canvas, holding the blurred world). */
  resolveAccumulated(): void {
    if (!this.accumulated) return;
    this.accumulated = false;
    const r = this.renderer;
    const autoClear = r.autoClear;
    try {
      r.autoClear = false;
      this.layerOver.uniforms.map.value = this.layerSum!.texture;
      this.layerQuad.material = this.layerOver;
      this.layerQuad.render(r);
    } finally {
      r.autoClear = autoClear;
    }
  }

  /** Drops a frame's layers without drawing them. */
  resetAccumulated(): void {
    this.accumulated = false;
  }

  private layerTargets(width: number, height: number): { layer: THREE.WebGLRenderTarget; sum: THREE.WebGLRenderTarget } {
    if (!this.layer) {
      this.layer = new THREE.WebGLRenderTarget(width, height, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      // The materials must write what they write to the canvas (sRGB-encoded, tone mapped, the canvas's programs); three
      // only does that for targets flagged XR. It also keeps the texture a plain RGBA8, so sampling it doesn't decode.
      (this.layer as THREE.WebGLRenderTarget & { isXRRenderTarget: boolean }).isXRRenderTarget = true;
      this.layer.texture.colorSpace = THREE.SRGBColorSpace;
      this.layerSum = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    } else if (this.layer.width !== width || this.layer.height !== height) {
      this.layer.setSize(width, height);
      this.layerSum!.setSize(width, height);
      this.accumulated = false;
    }
    return { layer: this.layer, sum: this.layerSum! };
  }

  /** Draws `blended` onto the bound target over `depth`. */
  private drawBlended(blended: ReadonlySet<THREE.Material>, camera: THREE.Camera, depth: THREE.Texture, exposure: number): void {
    const r = this.renderer;
    const autoClear = r.autoClear;
    const scaled: [THREE.MeshBasicMaterial, number, number, number][] = [];
    try {
      for (const { mesh, proxy, materials } of this.standIns) {
        proxy.visible = shown(mesh);
        if (!proxy.visible) continue;
        const source = materialsOf(mesh);
        materials.length = source.length;
        for (let i = 0; i < source.length; i++) materials[i] = blended.has(source[i]) ? source[i] : SKIP;
        proxy.material = Array.isArray(mesh.material) ? materials : materials[0];
        proxy.geometry = mesh.geometry;
        proxy.matrixWorld.copy(mesh.matrixWorld);
        proxy.renderOrder = mesh.renderOrder;
        proxy.frustumCulled = mesh.frustumCulled;
      }
      for (const m of blended) {
        if (m.blending !== THREE.NormalBlending || exposure === 1) continue; // Additive (Custom in a layer): as is.
        if (m instanceof THREE.MeshBasicMaterial) {
          scaled.push([m, m.color.r, m.color.g, m.color.b]);
          m.color.multiplyScalar(exposure);
        } else if ((m as THREE.ShaderMaterial).uniforms?.uExposure) (m as THREE.ShaderMaterial).uniforms.uExposure.value = exposure;
      }
      r.autoClear = false;
      (this.depthCopy.material as THREE.ShaderMaterial).uniforms.tDepth.value = depth;
      this.depthCopy.render(r);
      r.render(this.proxies, camera);
    } finally {
      for (const [m, cr, cg, cb] of scaled) m.color.setRGB(cr, cg, cb);
      for (const m of blended) if ((m as THREE.ShaderMaterial).uniforms?.uExposure) (m as THREE.ShaderMaterial).uniforms.uExposure.value = 1;
      r.autoClear = autoClear;
    }
  }

  /**
   * Keeps a copy of `target`'s depth (a depth texture), for a frame whose scene target the later passes draw over
   * (the composer's ping-pong targets): `capturedDepth`.
   */
  captureDepth(target: THREE.WebGLRenderTarget): void {
    const depth = target.depthTexture;
    if (!depth) return;
    let copy = this.depthTarget;
    if (!copy || copy.width !== target.width || copy.height !== target.height || copy.depthTexture!.type !== depth.type) {
      copy?.dispose();
      copy = this.depthTarget = new THREE.WebGLRenderTarget(target.width, target.height, {
        depthTexture: new THREE.DepthTexture(target.width, target.height, depth.type),
        stencilBuffer: target.stencilBuffer,
      });
      this.renderer.initRenderTarget(copy);
    }
    this.renderer.copyTextureToTexture(depth, copy.depthTexture!);
  }

  /** The depth captureDepth() copied last. */
  get capturedDepth(): THREE.DepthTexture | null {
    return this.depthTarget?.depthTexture ?? null;
  }

  dispose(): void {
    this.show();
    this.depthTarget?.dispose();
    this.depthTarget = null;
    this.proxies.clear();
    this.standIns.length = 0;
    this.world = null;
    this.depthCopy.material.dispose();
    this.depthCopy.dispose();
    this.layer?.dispose();
    this.layerSum?.dispose();
    this.layer = this.layerSum = null;
    this.accumulated = false;
    this.layerAdd.dispose();
    this.layerOver.dispose();
    this.layerQuad.dispose();
  }
}
