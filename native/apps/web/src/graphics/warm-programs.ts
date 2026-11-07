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
//   await warmPrograms(renderer, root, camera, scene)       compiles `root`'s programs for those (serial without KHR)
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
 * everything drawn before it in that frame (research/PERF-0.0.29-STALLS.md). Without KHR, the shared renderer queue
 * instead links one material/output/side, waits on its fence, builds its uniform table, then yields to the next.
 */
export async function warmPrograms(renderer: THREE.WebGLRenderer, root: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene, diagnostics = true): Promise<void> {
  if (!renderer.extensions.has("KHR_parallel_shader_compile")) {
    await serialPrograms(renderer, root, camera, scene, diagnostics);
    return;
  }
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
  if (renderer.extensions.has("KHR_parallel_shader_compile")) {
    while (!programs().every((p) => p.isReady?.() !== false)) await nextTask();
  }
  // Drain queued draws before first-use status/log queries. Even a ready shader can otherwise wait behind
  // the GPU process's current frame, especially on software GL. The fence is polled without blocking.
  if (typeof renderer.getContext === "function") await gpuIdle(renderer);
  // Shader log queries can perform expensive backend work on software GL even after KHR reports the program
  // ready. Remote joins use the already-linked program without fetching diagnostic logs on the gameplay thread.
  const checkErrors = renderer.debug?.checkShaderErrors;
  if (!diagnostics && renderer.debug) renderer.debug.checkShaderErrors = false;
  try {
    for (const p of programs()) p.getUniforms();
  } finally {
    if (renderer.debug && checkErrors !== undefined) renderer.debug.checkShaderErrors = checkErrors;
  }
}

/** The longest a compile waits on its fence without KHR_parallel_shader_compile (the check then waits as before). */
const NO_KHR_WAIT_MS = 30000;

/** Whether this renderer compiles programs off the main thread (KHR_parallel_shader_compile). */
export const parallelCompile = (renderer: THREE.WebGLRenderer): boolean => renderer.extensions.has("KHR_parallel_shader_compile");

/**
 * `root`'s programs for where `scene` is drawn: compiled now if any is missing, then a promise of them ready
 * (warmPrograms); null when they all exist already (draw now). For a model whose look changes often (the Loadout's
 * stage): only a change that needs a new program waits on KHR drivers. No-KHR probes always use the serial queue.
 */
export function warmIfNew(renderer: THREE.WebGLRenderer, root: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene): Promise<void> | null {
  // A synchronous cache probe would link every missing material before the queue can yield.
  if (!parallelCompile(renderer)) return warmPrograms(renderer, root, camera, scene);
  const count = () => renderer.info.programs?.length ?? 0;
  const n = count();
  const where = drawTargets(scene);
  if (where.screen) bound(renderer, null, () => renderer.compile(root, camera, scene));
  if (where.offscreen) bound(renderer, probeTarget(), () => renderer.compile(root, camera, scene));
  if (count() === n) return null;
  return warmPrograms(renderer, root, camera, scene);
}

// No-KHR drivers cannot report asynchronous link completion. A renderer-wide queue keeps concurrent world,
// player and retained-material warm-ups from silently merging back into a batch. Each job gets a fresh task.
const serialQueues = new WeakMap<THREE.WebGLRenderer, Promise<void>>();
function serialTask(renderer: THREE.WebGLRenderer, run: () => void | Promise<void>, cancelled = () => false): Promise<void> {
  const previous = serialQueues.get(renderer) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    if (cancelled()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (!cancelled()) await run();
  });
  serialQueues.set(renderer, next.catch(() => {}));
  return next;
}

async function serialPrograms(renderer: THREE.WebGLRenderer, root: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene, diagnostics: boolean, onlyTargets?: (THREE.WebGLRenderTarget | null)[]): Promise<void> {
  const where = drawTargets(scene);
  const jobs: Promise<void>[] = [];
  const seen = new Set<string>();
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.material) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const sides = material.transparent && material.side === THREE.DoubleSide && !material.forceSinglePass
        ? [THREE.BackSide, THREE.FrontSide] : [material.side];
      const targets = onlyTargets ?? [
        ...(where.screen || (where.blendedOnScreen && isGammaBlend(material)) ? [null] : []),
        ...(where.offscreen ? [probeTarget()] : []),
      ];
      for (const target of targets) for (const side of sides) {
        const shape = mesh as THREE.Mesh & { isSkinnedMesh?: boolean; isInstancedMesh?: boolean; isBatchedMesh?: boolean; _colorsTexture?: unknown; instanceColor?: unknown; morphTexture?: unknown };
        const geometry = mesh.geometry;
        const key = [material.uuid, target ? "target" : "screen", side, mesh.type, !!shape.isSkinnedMesh, !!shape.isInstancedMesh,
          !!shape.instanceColor, !!shape.morphTexture, !!shape.isBatchedMesh, !!shape._colorsTexture, geometry?.attributes.color?.itemSize ?? 0,
          !!geometry?.attributes.tangent, !!geometry?.attributes.normal, !!geometry?.attributes.uv, !!geometry?.morphTargetsRelative, geometry?.morphAttributes.position?.length ?? 0,
          geometry?.morphAttributes.normal?.length ?? 0, geometry?.morphAttributes.color?.length ?? 0].join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        const copy = mesh.clone(false);
        copy.material = material;
        let disposed = false;
        const cancel = () => { disposed = true; };
        material.addEventListener("dispose", cancel);
        const job = serialTask(renderer, async () => {
          const oldSide = material.side;
          const checkErrors = renderer.debug?.checkShaderErrors;
          let program: Program | undefined;
          try {
            material.side = side;
            if (!diagnostics && renderer.debug) renderer.debug.checkShaderErrors = false;
            // A single material, output and side: compile cannot link a second program here.
            bound(renderer, target, () => renderer.compile(copy, camera, scene));
            program = (renderer.properties.get(material) as { currentProgram?: Program }).currentProgram;
          } finally {
            material.side = oldSide;
            if (renderer.debug && checkErrors !== undefined) renderer.debug.checkShaderErrors = checkErrors;
          }
          // Keep the Loadout hotfix's no-KHR fence, now once per program instead of after a batch. Hold the same
          // renderer queue until its uniform table is built, so another caller cannot enqueue links ahead of it.
          if (typeof renderer.getContext === "function") await gpuIdle(renderer, NO_KHR_WAIT_MS);
          if (disposed) return;
          if (!diagnostics && renderer.debug) renderer.debug.checkShaderErrors = false;
          try {
            program?.getUniforms();
          } finally {
            if (renderer.debug && checkErrors !== undefined) renderer.debug.checkShaderErrors = checkErrors;
          }
        }, () => disposed).finally(() => material.removeEventListener("dispose", cancel));
        jobs.push(job);
      }
    }
  });
  await Promise.all(jobs);
}

type DrawBuffer = { framebuffer: WebGLFramebuffer; color: WebGLRenderbuffer; depth: WebGLRenderbuffer };
const drawBuffers = new WeakMap<THREE.WebGLRenderer, DrawBuffer>();

function hiddenDrawBuffer(renderer: THREE.WebGLRenderer): DrawBuffer {
  const old = drawBuffers.get(renderer);
  if (old) return old;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const framebuffer = gl.createFramebuffer()!, color = gl.createRenderbuffer()!, depth = gl.createRenderbuffer()!;
  const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const renderbuffer = gl.getParameter(gl.RENDERBUFFER_BINDING) as WebGLRenderbuffer | null;
  const samples = gl.getParameter(gl.SAMPLES) as number;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.bindRenderbuffer(gl.RENDERBUFFER, color);
  if (samples) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, 32, 32);
  else gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, 32, 32);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  const stencil = gl.getContextAttributes()?.stencil;
  const format = stencil ? gl.DEPTH24_STENCIL8 : gl.DEPTH_COMPONENT24;
  if (samples) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, format, 32, 32);
  else gl.renderbufferStorage(gl.RENDERBUFFER, format, 32, 32);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, stencil ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
  gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
  if (!complete) {
    gl.deleteFramebuffer(framebuffer); gl.deleteRenderbuffer(color); gl.deleteRenderbuffer(depth);
    throw new Error("player warm-up framebuffer is incomplete");
  }
  const buffer = {framebuffer,color,depth};
  drawBuffers.set(renderer,buffer);
  return buffer;
}

async function presentedFrame(renderer: THREE.WebGLRenderer): Promise<void> {
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve,100);
    requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
  });
  await gpuIdle(renderer);
}

/** One geometry/output per task, fenced before the next: backend pipelines can depend on vertex layout as well as
 * program. A private framebuffer preserves canvas pixels; keeping three's screen output selects its exact sRGB
 * program instead of accidentally warming a new linear-output program in a regular render target. */
export async function drawHiddenPrograms(renderer: THREE.WebGLRenderer, root: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
  if (renderer.extensions.has("KHR_parallel_shader_compile")) return;
  const jobs: Promise<void>[] = [];
  const where = drawTargets(scene);
  root.updateMatrixWorld(true);
  root.traverseVisible(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.material) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const copy = mesh.clone(false);
      copy.material = material;
      copy.matrixAutoUpdate = false;
      copy.matrix.copy(mesh.matrixWorld);
      copy.frustumCulled = false;
      const scratch = new THREE.Scene();
      scratch.fog = scene.fog;
      scratch.environment = scene.environment;
      scratch.add(copy);
      const targets = [...(where.screen ? [null] : []), ...(where.offscreen ? [probeTarget()] : [])];
      const sides = material.transparent && material.side === THREE.DoubleSide && !material.forceSinglePass
        ? [THREE.BackSide,THREE.FrontSide] : [material.side];
      for (const output of targets) for (const side of sides) {
        let disposed = false;
        const cancel = () => { disposed = true; };
        material.addEventListener("dispose",cancel);
        const job = serialTask(renderer, async () => {
          // Separate uniform reflection from the first backend draw as well as successive layout draws.
          await presentedFrame(renderer);
          if (disposed) return;
          const gl = renderer.getContext() as WebGL2RenderingContext;
          const target = renderer.getRenderTarget();
          const viewport = renderer.getViewport(new THREE.Vector4());
          const scissor = renderer.getScissor(new THREE.Vector4());
          const scissorTest = renderer.getScissorTest();
          const oldSide = material.side;
          const range = { ...copy.geometry.drawRange };
          const instanced = copy.geometry as THREE.InstancedBufferGeometry;
          const instanceCount = instanced.instanceCount;
          let framebuffer: WebGLFramebuffer | null = null;
          try {
            renderer.setRenderTarget(output);
            framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
            const buffer = hiddenDrawBuffer(renderer);
            // This binding is private to the synchronous render below. Restore it before returning to three's state
            // cache or yielding: renderer still sees the real output, while no pixels can reach the user's canvas.
            gl.bindFramebuffer(gl.FRAMEBUFFER, buffer.framebuffer);
            renderer.setViewport(0,0,32,32);
            renderer.setScissor(0,0,32,32);
            renderer.setScissorTest(true);
            if (material.side !== side) { material.side = side; material.needsUpdate = true; }
            // A triangle exercises the same vertex-input and fragment pipeline as the whole model. Processing all
            // vertices (and all eight halo instances) here would duplicate the first visible frame's software work.
            copy.geometry.setDrawRange(0, Math.min(3,copy.geometry.index?.count ?? copy.geometry.attributes.position.count));
            if (instanced.isInstancedBufferGeometry) instanced.instanceCount = 1;
            renderer.render(scratch,camera);
          } finally {
            copy.geometry.setDrawRange(range.start,range.count);
            if (instanced.isInstancedBufferGeometry) instanced.instanceCount = instanceCount;
            gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
            if (material.side !== oldSide) { material.side = oldSide; material.needsUpdate = true; }
            renderer.setRenderTarget(target);
            renderer.setViewport(viewport);
            renderer.setScissor(scissor);
            renderer.setScissorTest(scissorTest);
          }
          await gpuIdle(renderer);
          await presentedFrame(renderer);
        }, () => disposed).finally(() => material.removeEventListener("dispose",cancel));
        jobs.push(job);
      }
    }
  });
  await Promise.all(jobs);
}

/** Starts compiling `root`'s programs for one output, the screen or (offscreen) any render target, without waiting. */
export function compileFor(renderer: THREE.WebGLRenderer, root: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene, offscreen: boolean): void {
  if (!renderer.extensions.has("KHR_parallel_shader_compile")) {
    void serialPrograms(renderer, root, camera, scene, true, [offscreen ? probeTarget() : null])
      .catch(e => console.warn("program warm-up failed", e));
    return;
  }
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
