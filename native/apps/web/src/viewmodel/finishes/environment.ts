// Scene reflections for the polished-metal finishes (shader.ts FINISH 22..27) on the composer looks (Enhanced,
// Cinematic; graphics/composer-pipeline.ts calls captureFinishEnvironment each frame). A small cube map of the scene
// around the camera (256² per face, half float, mipmapped for the rougher metals), one face re-rendered per frame, so
// the whole cube refreshes every 6 frames and costs about one sixth of a tiny extra scene render. It only runs while
// a metal knife is actually drawn: the shader's uFinEnv uniform is read by three.js only when a program that declares
// it uploads its uniforms (a metal finish, not FINISH_LOD), and that read is what keeps the capture going. Nothing
// metal on screen for a second: no capture at all.
//
// The first-person glove / knife hardware (finishes/detail.ts, Enhanced / Cinematic only) shares the same cube and keeps
// it alive the same way, but only while the hand holds polished / satin metal (detail.ts wantsReflection).
//
// Source, Plain and Potato never call it: uFinEnvOn reads 0 and the metals keep their view-locked studio look.
// While the cube is being drawn uFinEnv reads null and uFinEnvOn 0, so third-person knives in the scene (which the
// capture sees) never sample the texture being rendered into.
//
// Allocation: the target and the cube camera once (on the first metal knife on a composer look); nothing per frame.

import * as THREE from "three";

const SIZE = 256;
/** Mip levels of the cube (log2 SIZE): the shader's roughness -> LOD range. */
export const FIN_ENV_LODS = Math.log2(SIZE);
/** No metal knife drawn for this long: stop capturing. */
const IDLE_MS = 1000;
/** No capture for this long (the look switched away from the composer): the metals go back to the studio look. */
const STALE_MS = 500;

let target: THREE.WebGLCubeRenderTarget | null = null;
let cube: THREE.CubeCamera | null = null;
let face = 0;
/** Faces captured since the cube was (re)started; the reflection switches on once all six are there. */
let faces = 0;
let capturing = false;
let usedAt = -Infinity;
let capturedAt = -Infinity;
const now = () => performance.now();
const ready = () => !capturing && faces >= 6 && now() - capturedAt < STALE_MS;

const sunDir = new THREE.Vector3(0.42, 0.78, 0.46).normalize();
const sunColor = new THREE.Color(1, 0.96, 0.9);

/** Shared by every player material (finishUniforms); read-only getters, evaluated at upload time like uFinTime. */
export const FIN_ENV_UNIFORMS = {
  uFinEnv: {
    get value(): THREE.Texture | null {
      usedAt = now();
      return ready() ? target!.texture : null;
    },
    set value(_: THREE.Texture | null) {
      /* read-only */
    },
  } as THREE.IUniform<THREE.Texture | null>,
  uFinEnvOn: {
    get value(): number {
      return ready() ? 1 : 0;
    },
    set value(_: number) {
      /* read-only */
    },
  } as THREE.IUniform<number>,
  /** Toward the sun (world, three.js Y up) and its colour, normalised to a peak of 1: the metals' sharp glint. */
  uFinSunDir: { value: sunDir } as THREE.IUniform<THREE.Vector3>,
  uFinSunColor: { value: sunColor } as THREE.IUniform<THREE.Color>,
};

/**
 * The same cube for the first-person glove / knife hardware (finishes/detail.ts cosEnvUniform): touch() keeps the
 * capture running like a metal finish does, the texture / ready read like uFinEnv / uFinEnvOn.
 */
export function touchFinishEnvironment(): void {
  usedAt = now();
}
export const cosEnvTexture = (): THREE.Texture | null => (ready() ? target!.texture : null);
export const cosEnvReady = (): boolean => ready();

/**
 * One step of the scene cube for the metal finishes, from `camera`'s position (call before the frame's main render,
 * with the frame's sky materials in place). `sun`: the look's sun (lighting-state.ts), if the map has one.
 */
export function captureFinishEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, sun?: { direction: THREE.Vector3; color: THREE.Color }): void {
  if (sun) {
    sunDir.copy(sun.direction).normalize();
    const peak = Math.max(sun.color.r, sun.color.g, sun.color.b, 1e-6);
    sunColor.setRGB(sun.color.r / peak, sun.color.g / peak, sun.color.b / peak);
  }
  if (now() - usedAt > IDLE_MS) {
    faces = 0;
    return;
  }
  if (!target) {
    target = new THREE.WebGLCubeRenderTarget(SIZE, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    // Near 16: the camera sits inside the player's own head in first person.
    cube = new THREE.CubeCamera(16, 40000, target);
  }
  const cam = cube!;
  camera.getWorldPosition(cam.position);
  cam.updateMatrixWorld();
  if (cam.coordinateSystem !== renderer.coordinateSystem) {
    cam.coordinateSystem = renderer.coordinateSystem;
    cam.updateCoordinateSystem();
  }
  const prevTarget = renderer.getRenderTarget(), prevFace = renderer.getActiveCubeFace(), prevLevel = renderer.getActiveMipmapLevel();
  const prevAutoClear = renderer.autoClear;
  // A fresh cube (first use, or after a pause) draws all six faces at once; then one face per frame.
  const n = faces < 6 ? 6 : 1;
  capturing = true;
  renderer.autoClear = false;
  for (let i = 0; i < n; i++) {
    // Mipmaps once per step, after its last face.
    target.texture.generateMipmaps = i === n - 1;
    renderer.setRenderTarget(target, face);
    renderer.clear();
    renderer.render(scene, cam.children[face] as THREE.Camera);
    face = (face + 1) % 6;
    faces++;
  }
  capturing = false;
  stats.faces += n;
  stats.lastDrawCalls = renderer.info.render.calls;
  stats.lastTriangles = renderer.info.render.triangles;
  renderer.autoClear = prevAutoClear;
  renderer.setRenderTarget(prevTarget, prevFace, prevLevel);
  capturedAt = now();
}

/** Capture counters for perf checks (research/knife-finishes/ingame.cjs reads them as window.__finEnv in dev). */
export const stats = { faces: 0, lastDrawCalls: 0, lastTriangles: 0 };
if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV && "window" in globalThis) Object.assign(globalThis, { __finEnv: stats });

/**
 * The scene cube while it is live, WITHOUT asking for it (unlike uFinEnv's read): the bunny's visor (player/look-tier.ts)
 * reflects it on the composer looks only while a metal knife keeps the capture running, and never keeps it running.
 * Null while a face is being drawn, like uFinEnv.
 */
export function peekFinishEnvironment(): THREE.Texture | null {
  return ready() ? target!.texture : null;
}

export function disposeFinishEnvironment(): void {
  target?.dispose();
  target = null;
  cube = null;
  faces = 0;
}
