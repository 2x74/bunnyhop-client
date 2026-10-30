// Compiles shader programs ahead of their first frame, for every place the current look draws them.
//
// three.js gives a material a separate program for each kind of output: the screen (sRGB) and any render target
// (linear). The Source look draws the game scene into render targets as well as (or instead of) the screen: the water
// refraction / reflection captures (water-capture.ts) and, on maps with HDR lighting, the half-float scene target
// (graphics/source-hdr.ts). A compileAsync with nothing bound only warms the screen variant, so the target variant of
// a joining player, a ghost or a part of the map first seen in the water used to compile inside a frame: a hitch of
// 100 ms to over a second on Windows / D3D (research/PERF-0.0.29-STALLS.md).
//
//   setDrawTargets((scene) => ({ screen, offscreen }))   the renderer front (pipeline.ts) says where `scene` is drawn
//   await warmPrograms(renderer, root, camera, scene)       compiles `root`'s programs for those, in parallel
import * as THREE from "three";
import { gammaBlendMeshes, isGammaBlend } from "./gamma-blend";

export interface DrawTargets {
  /** Drawn straight to the canvas. */
  screen: boolean;
  /** Drawn into a render target (any target: they all share the linear-output variant). */
  offscreen: boolean;
  /** The map's blended surfaces are drawn to the canvas even when the rest isn't (gamma-blend.ts). */
  blendedOnScreen?: boolean;
}

let drawTargets: (scene: THREE.Scene) => DrawTargets = () => ({ screen: true, offscreen: false });

/** Where the current look draws a scene (graphics/pipeline.ts sets this). */
export function setDrawTargets(f: (scene: THREE.Scene) => DrawTargets): void {
  drawTargets = f;
}

/** A 1x1 target bound while compiling, so three picks the render-target variant. */
let probe: THREE.WebGLRenderTarget | null = null;
const probeTarget = () => (probe ??= new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false }));

function bound<T>(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null, f: () => T): T {
  const previous = renderer.getRenderTarget();
  if (target !== previous) renderer.setRenderTarget(target);
  try {
    return f();
  } finally {
    if (target !== previous) renderer.setRenderTarget(previous);
  }
}

/** A three.js program as WebGLRenderer.info lists it (isReady: KHR_parallel_shader_compile's completion status). */
type Program = { isReady?: () => boolean; getUniforms: () => unknown };

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

/**
 * Compiles the programs of `root` (in `scene`, or about to be added to it; hidden objects included) for every output
 * the current look draws `scene` to, and resolves when they're ready. Every variant starts compiling first (one pass
 * over `root` per output, a task each); then the renderer's programs are polled with KHR_parallel_shader_compile, so
 * the main thread never waits on the driver. Last, three's first-use check of each program (link status, info logs,
 * uniform locations) runs here, outside a frame: in a frame its info-log query waits for the GPU process to finish
 * everything drawn before it in that frame (research/PERF-0.0.29-STALLS.md).
 */
export async function warmPrograms(renderer: THREE.WebGLRenderer, root: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
  const where = drawTargets(scene);
  const targets: (THREE.WebGLRenderTarget | null)[] = [];
  if (where.screen) targets.push(null);
  if (where.offscreen) targets.push(probeTarget());
  for (let i = 0; i < targets.length; i++) {
    if (i) await nextTask();
    bound(renderer, targets[i], () => renderer.compile(root, camera, scene));
  }
  if (where.blendedOnScreen && !where.screen) {
    await nextTask();
    // Each blended material on its own mesh's geometry, so only those get a canvas variant.
    const blended = new THREE.Group();
    for (const mesh of gammaBlendMeshes(root)) {
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (isGammaBlend(m)) blended.add(new THREE.Mesh(mesh.geometry, m));
    }
    if (blended.children.length) bound(renderer, null, () => renderer.compile(blended, camera, scene));
  }
  // All of the renderer's programs: any still compiling may be this root's, and they all finish.
  const programs = () => (renderer.info.programs ?? []) as unknown as Program[];
  if (renderer.extensions.has("KHR_parallel_shader_compile")) while (!programs().every((p) => p.isReady?.() !== false)) await nextTask();
  for (const p of programs()) p.getUniforms();
}

/** Starts compiling `root`'s programs for one output, the screen or (offscreen) any render target, without waiting. */
export function compileFor(renderer: THREE.WebGLRenderer, root: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene, offscreen: boolean): void {
  bound(renderer, offscreen ? probeTarget() : null, () => renderer.compile(root, camera, scene));
}

/**
 * Resolves once the GPU has done everything submitted so far (a fence, polled between tasks: the main thread never
 * waits), or after `timeoutMs`. Work a GPU process still has queued is otherwise waited out by the next frame's first
 * call that needs an answer from it.
 */
export function gpuIdle(renderer: THREE.WebGLRenderer, timeoutMs = 5000): Promise<void> {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  if (typeof gl.fenceSync !== "function") return Promise.resolve();
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) return Promise.resolve();
  gl.flush();
  const until = performance.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      if (gl.isContextLost() || gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED || performance.now() > until) {
        gl.deleteSync(sync);
        resolve();
      } else setTimeout(poll, 10);
    };
    setTimeout(poll, 10);
  });
}
