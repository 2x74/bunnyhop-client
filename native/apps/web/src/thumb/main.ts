// In-engine map thumbnails (dev only: apps/web/thumb.html, driven by tools/thumbs/render.ts in headless Chromium;
// never part of a site build). Loads one map with its full hosted content exactly like the game, picks camera
// views with a heuristic search, and renders them at 1280×720 (2× supersampled).
//
// Camera search, per anchor (the main-track start zone first, then points along the course: stage zones, teleport
// destinations, the end zone):
//   1. Candidates around the anchor's eye point: 24 yaws × a few heights/pitches (slightly elevated, looking a bit
//      down), each moved up / back / sideways with core.traceRay so the camera always stays in open space.
//   2. Each candidate is scored from a tiny depth render (distance per pixel, sky = no geometry): depth (median
//      distance), variety (entropy of log distances), walls in the face, sky share (some is good, all is bad),
//      ground in the lower third, facing the course (anchor yaw / next zone) and the next zone actually in view.
//   3. The best refine with seeded random perturbations, and the top few get a small colour render scored on
//      brightness, contrast and colourfulness.
// The hero shot is the best view from the start zone (falling back to the best anchor when the start is enclosed);
// extra gallery shots are the best views from other anchors that differ from the hero.
//
// Manual use: /thumb.html?map=bhop_eazy shows the picked shots and their scores.
// /thumb.html?map=bhop_eazy&view=x,y,z,yaw,pitch renders one fixed view (Source units, degrees, pitch down > 0).
// `&raw` skips the auto-exposure (shots as the game draws them, for lighting comparisons).
// Map state for a fixed view (automation): `__thumb.sim(physics, steps)` resets the core with a physics version and
// runs steps ([forward, side, yaw, pitch, buttons, ticks], or ["at", x, y, z, yaw] to place the player), then the world
// shows the entities' state (moved doors, broken / toggled walls) for the next `renderView`.

import * as THREE from "three";
import wasmUrl from "../wasm/bunnyhop_core.wasm?url";
import { Core, setPosition, traceRay } from "../core";
import { buildWorld } from "../render";
import { styleSettings } from "../styles";
import { mapContentStatus } from "../content";
import { bspModelBounds, detectZones, parseZoneSet, trackOf, type Zone } from "../zones";

type V3 = [number, number, number];

export interface View {
  pos: V3;
  yaw: number;
  /** Degrees, positive looks down (Source convention). */
  pitch: number;
}

export interface ShotResult {
  role: "hero" | "extra";
  anchor: string;
  view: View;
  score: number;
  stats: Record<string, number>;
  /** Base64 bodies (no data: prefix). */
  webp: string;
  card?: string;
  jpg?: string;
  lqip?: string;
  /** Mean luminance of the final image (after exposure); near 0 = the map renders black. */
  lum: number;
}

export interface RenderResult {
  map: string;
  ms: number;
  content: { missing: number; materials: number; manifest: boolean; sky: string | null; skyResolved: boolean } | null;
  /** Best score per anchor (label -> score). */
  anchors: Record<string, number>;
  issues: string[];
  shots: ShotResult[];
}

export interface RenderOptions {
  /** Number of shots (hero + extras), 1–3. */
  shots?: number;
  /** Also encode the hero as a 640×360 JPEG (maps without a GameBanana preview). */
  jpg?: boolean;
  quality?: number;
  /** Fixed hero view (manual override from tools/thumbs/overrides.json). */
  hero?: View | null;
}

/** `?raw`: no auto-exposure. */
const rawShots = new URLSearchParams(location.search).has("raw");
const OUT_W = 1280;
const OUT_H = 720;
const SS = 2;
const EXTRA_W = 854;
const EXTRA_H = 480;
const JPG_W = 640;
const JPG_H = 360;
const CARD_W = 480;
const CARD_H = 270;
const LQIP_W = 16;
const LQIP_H = 9;
const DW = 112;
const DH = 63;
const CW = 192;
const CH = 108;
const VFOV = 58;
const MAX_D = 32768;
const EYE = 64;

const canvas = document.getElementById("c") as HTMLCanvasElement;
const logEl = document.getElementById("log")!;
const log = (s: string) => {
  logEl.textContent += s + "\n";
  console.info(s);
};

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
renderer.setPixelRatio(1);
const scene = new THREE.Scene();
const BACKGROUND = new THREE.Color(0x8fb3d9); // same as the game (main.ts)
scene.background = BACKGROUND;
const camera = new THREE.PerspectiveCamera(VFOV, 16 / 9, 2, 60000);
camera.rotation.order = "YXZ";

// --- math (Source space: x, y, z-up; yaw around z in degrees; pitch positive = down) -----------------

const RAD = Math.PI / 180;
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const flatDir = (yaw: number): V3 => [Math.cos(yaw * RAD), Math.sin(yaw * RAD), 0];
const forward = (yaw: number, pitch: number): V3 => [Math.cos(pitch * RAD) * Math.cos(yaw * RAD), Math.cos(pitch * RAD) * Math.sin(yaw * RAD), -Math.sin(pitch * RAD)];
const yawTo = (a: V3, b: V3) => Math.atan2(b[1] - a[1], b[0] - a[0]) / RAD;
const angDiff = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
const center = (z: Zone): V3 => [(z.mins[0] + z.maxs[0]) / 2, (z.mins[1] + z.maxs[1]) / 2, (z.mins[2] + z.maxs[2]) / 2];

function setCamera(v: View): void {
  camera.position.set(v.pos[0], v.pos[2], -v.pos[1]);
  camera.rotation.set(-v.pitch * RAD, (v.yaw - 90) * RAD, 0);
  camera.updateMatrixWorld(true);
  // The sky box follows the camera in onBeforeRender, which runs after the scene's matrices are updated: fine
  // frame-to-frame in the game, but here every render jumps elsewhere, so place it up front.
  if (sky) {
    sky.position.copy(camera.position);
    sky.updateMatrixWorld(true);
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- map + anchors -------------------------------------------------------------------------------------

interface Anchor {
  kind: "start" | "stage" | "teleport" | "end" | "spawn" | "world";
  label: string;
  eye: V3;
  /** Preferred view direction (course direction), if known. */
  yaw: number | null;
  /** Points that should ideally be in view (next zones). */
  targets: V3[];
}

let core: Core;

function trace(a: V3, b: V3, r = 6): number {
  return traceRay(core, a, b, r);
}

/** Moves from `from` towards `to` and stops `margin` units short of anything solid. */
function clampMove(from: V3, to: V3, margin = 16, r = 8): V3 {
  const len = dist(from, to);
  if (len < 1e-3) return from;
  const f = trace(from, to, r);
  if (f >= 1) return to;
  const k = Math.max(0, f * len - margin) / len;
  return [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, from[2] + (to[2] - from[2]) * k];
}

/** True when a point is enclosed by solid in every axis direction (inside a brush). */
function inSolid(p: V3): boolean {
  const dirs: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  return dirs.every((d) => trace(p, add(p, d, 8), 1) === 0);
}

/** Eye point standing on the floor below (x, y, zTop). */
function eyeAt(x: number, y: number, zTop: number, zBottom: number): V3 {
  const top: V3 = [x, y, zTop];
  const f = trace(top, [x, y, zBottom], 4);
  const floor = zTop + (zBottom - zTop) * f;
  return [x, y, floor + (f < 1 ? EYE : 0)];
}

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const parseVec = (s: string | undefined): V3 | null => {
  const v = (s ?? "").trim().split(/\s+/).map(Number);
  return v.length >= 3 && v.slice(0, 3).every(Number.isFinite) ? [v[0], v[1], v[2]] : null;
};

function anchorsFor(ents: Record<string, string>[], zones: Zone[]): Anchor[] {
  const out: Anchor[] = [];
  const point = (cls: RegExp) =>
    ents
      .filter((e) => cls.test(e.classname ?? "") && parseVec(e.origin))
      .sort((a, b) => natural.compare(a.targetname ?? "", b.targetname ?? ""))
      .map((e) => ({ pos: parseVec(e.origin)!, yaw: parseVec(e.angles)?.[1] ?? null, name: e.targetname ?? e.classname }));
  const teles = point(/^info_teleport_destination$/);
  const spawns = point(/^info_player_(start|counterterrorist|terrorist)$/);
  const main = zones.filter((z) => trackOf(z) === 0);
  const start = main.find((z) => z.kind === "start");
  const end = main.find((z) => z.kind === "end");
  const splits = main.filter((z) => z.kind === "stage" || z.kind === "checkpoint").sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const inBox = (p: V3, z: Zone, pad: number) => [0, 1, 2].every((i) => p[i] >= z.mins[i] - pad && p[i] <= z.maxs[i] + pad);
  const courseTargets = [...splits.map(center), ...(end ? [center(end)] : [])];

  const zoneEye = (z: Zone): V3 => {
    const c = center(z);
    const top = Math.min(z.maxs[2] - 4, z.mins[2] + 160);
    const e = eyeAt(c[0], c[1], top, z.mins[2] - 256);
    return e;
  };

  if (start) {
    const eye = zoneEye(start);
    // Course direction: a teleport destination / spawn inside the start zone faces down the course.
    const facing = [...teles, ...spawns].find((p) => p.yaw !== null && inBox(p.pos, start, 96));
    const yaw = facing?.yaw ?? (courseTargets[0] ? yawTo(eye, courseTargets[0]) : null);
    out.push({ kind: "start", label: "start zone", eye, yaw, targets: courseTargets.slice(0, 1) });
  } else if (spawns.length) {
    const s = spawns[0];
    out.push({ kind: "spawn", label: `spawn ${s.name}`, eye: add(s.pos, [0, 0, EYE]), yaw: s.yaw, targets: courseTargets.slice(0, 1) });
  }

  // Along the course: stage zones if the map has them, else teleport destinations (checkpoint respawns,
  // natural-sorted names usually follow course order). Spread over the course.
  const along: Anchor[] = [];
  if (splits.length >= 2) {
    splits.forEach((z, i) => along.push({ kind: "stage", label: `${z.kind} ${z.index ?? i + 1}`, eye: zoneEye(z), yaw: courseTargets[i + 1] ? yawTo(center(z), courseTargets[i + 1]) : null, targets: courseTargets.slice(i + 1, i + 2) }));
  } else {
    for (const t of teles) along.push({ kind: "teleport", label: `teleport ${t.name}`, eye: add(t.pos, [0, 0, EYE]), yaw: t.yaw, targets: [] });
  }
  const pickN = 5;
  const picked: Anchor[] = [];
  if (along.length <= pickN) picked.push(...along);
  else for (let k = 0; k < pickN; k++) picked.push(along[Math.round(((k + 0.5) / pickN) * (along.length - 1))]);
  if (end) picked.push({ kind: "end", label: "end zone", eye: zoneEye(end), yaw: null, targets: [] });
  for (const a of picked) if (!out.some((b) => dist(a.eye, b.eye) < 256)) out.push(a);
  if (out.length < 3) for (const s of spawns) if (!out.some((b) => dist(add(s.pos, [0, 0, EYE]), b.eye) < 256)) out.push({ kind: "spawn", label: `spawn ${s.name}`, eye: add(s.pos, [0, 0, EYE]), yaw: s.yaw, targets: [] });
  return out.filter((a) => !inSolid(a.eye));
}

// --- probes --------------------------------------------------------------------------------------------

const depthRT = new THREE.WebGLRenderTarget(DW, DH, { depthBuffer: true });
const depthBuf = new Uint8Array(DW * DH * 4);
const depthMat = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    varying vec3 vView;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vView = mv.xyz;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    varying vec3 vView;
    void main() {
      float d = clamp(length(vView) / ${MAX_D.toFixed(1)}, 0.0, 1.0) * 255.0;
      gl_FragColor = vec4(floor(d) / 255.0, fract(d), 0.0, 1.0);
    }`,
});
let sky: THREE.Object3D | null = null;
let skyFaces: THREE.Mesh[] = [];

/** Distance per pixel (row 0 = top), -1 = sky / void. */
function probeDepth(v: View): Float32Array {
  setCamera(v);
  camera.aspect = 16 / 9;
  camera.updateProjectionMatrix();
  if (sky) sky.visible = false;
  scene.background = null;
  scene.overrideMaterial = depthMat;
  renderer.setRenderTarget(depthRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  // Sky faces count as sky: lay down their depth first (their own colour-less material, so alpha stays 0), then
  // draw everything else with the override hidden behind them. The 3D skybox pass skips override renders (render.ts
  // sky3dPass), so its scenery counts as sky here too.
  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  for (const m of skyFaces) renderer.render(m, camera);
  for (const m of skyFaces) m.visible = false;
  renderer.render(scene, camera);
  for (const m of skyFaces) m.visible = true;
  renderer.autoClear = autoClear;
  renderer.readRenderTargetPixels(depthRT, 0, 0, DW, DH, depthBuf);
  renderer.setRenderTarget(null);
  scene.overrideMaterial = null;
  scene.background = BACKGROUND;
  renderer.setClearColor(0x000000, 1);
  if (sky) sky.visible = true;
  const out = new Float32Array(DW * DH);
  for (let y = 0; y < DH; y++) {
    const row = DH - 1 - y;
    for (let x = 0; x < DW; x++) {
      const i = (row * DW + x) * 4;
      out[y * DW + x] = depthBuf[i + 3] < 128 ? -1 : ((depthBuf[i] + depthBuf[i + 1] / 255) / 255) * MAX_D;
    }
  }
  return out;
}

interface Cand extends View {
  anchor: Anchor;
  rise: number;
  geo: number;
  color: number;
  total: number;
  stats: Record<string, number>;
}

function scoreDepth(d: Float32Array, v: View, a: Anchor, rise: number): { score: number; stats: Record<string, number> } {
  let skyN = 0;
  let near = 0;
  let fore = 0;
  let nearC = 0;
  let nC = 0;
  let bottomN = 0;
  let bottomG = 0;
  const bins = new Float32Array(11);
  const ds: number[] = [];
  for (let y = 0; y < DH; y++) {
    for (let x = 0; x < DW; x++) {
      const v = d[y * DW + x];
      const c = Math.abs(x / DW - 0.5) < 0.3 && Math.abs(y / DH - 0.5) < 0.3;
      if (c) nC++;
      if (y > DH * 0.66) bottomN++;
      if (v < 0) {
        skyN++;
        bins[10]++;
        continue;
      }
      if (y > DH * 0.66) bottomG++;
      ds.push(v);
      if (v < 56) near++;
      if (v < 200) fore++;
      if (c && v < 96) nearC++;
      bins[Math.max(0, Math.min(9, Math.floor(Math.log2(Math.max(v, 1)) - 5)))]++;
    }
  }
  const n = DW * DH;
  const skyF = skyN / n;
  ds.sort((p, q) => p - q);
  const median = ds.length ? ds[ds.length >> 1] : 0;
  const p80 = ds.length ? ds[Math.floor(ds.length * 0.8)] : 0;
  let ent = 0;
  for (const b of bins) if (b) ent -= (b / n) * Math.log(b / n);
  ent /= Math.log(11);
  const depthScore = Math.max(0, Math.min(1, (Math.log2(Math.max(median, 1)) - Math.log2(160)) / (Math.log2(2400) - Math.log2(160))));
  const farScore = Math.max(0, Math.min(1, (Math.log2(Math.max(p80, 1)) - Math.log2(400)) / (Math.log2(6000) - Math.log2(400))));
  let s = 1.2 * depthScore + 0.5 * farScore + 0.9 * ent;
  s -= 3.2 * (nC ? nearC / nC : 0) + 1.5 * (near / n) + 0.8 * (fore / n);
  if (skyF > 0.4) s -= (skyF - 0.4) * 4;
  else if (skyF > 0.04 && skyF < 0.35) s += 0.15;
  s -= 1.2 * (1 - (bottomN ? bottomG / bottomN : 0));
  let dirBonus = 0;
  if (a.yaw !== null) dirBonus = Math.max(0, Math.cos((v.yaw - a.yaw) * RAD));
  s += 0.55 * dirBonus;
  // Next zone in view and not hidden behind a wall.
  let tv = 0;
  for (const t of a.targets) {
    const p = new THREE.Vector3(t[0], t[2], -t[1]).project(camera);
    if (Math.abs(p.x) < 0.9 && Math.abs(p.y) < 0.9 && p.z < 1) {
      const px = Math.floor(((p.x + 1) / 2) * DW);
      const py = Math.floor(((1 - p.y) / 2) * DH);
      const dd = d[py * DW + px];
      if (dd < 0 || dd >= dist(v.pos, t) * 0.8) tv = 1;
    }
  }
  s += 0.4 * tv;
  // Slightly elevated cinematic angle.
  if (rise >= 48 && rise <= 320) s += 0.2;
  return { score: s, stats: { sky: skyF, fore: fore / n, median, p80, entropy: ent, nearCenter: nC ? nearC / nC : 0, ground: bottomN ? bottomG / bottomN : 0, dir: dirBonus, target: tv } };
}

const probe2d = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
probe2d.canvas.width = CW;
probe2d.canvas.height = CH;

function scoreColor(v: View): { score: number; stats: Record<string, number> } {
  renderer.setSize(CW, CH, false);
  camera.aspect = 16 / 9;
  camera.updateProjectionMatrix();
  setCamera(v);
  renderer.render(scene, camera);
  probe2d.drawImage(renderer.domElement, 0, 0, CW, CH);
  const px = probe2d.getImageData(0, 0, CW, CH).data;
  let sum = 0;
  let sum2 = 0;
  let rg = 0;
  let rg2 = 0;
  let yb = 0;
  let yb2 = 0;
  let dark = 0;
  const n = CW * CH;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    sum += l;
    sum2 += l * l;
    if (l < 0.06) dark++;
    const a = r - g;
    const c = 0.5 * (r + g) - b;
    rg += a;
    rg2 += a * a;
    yb += c;
    yb2 += c * c;
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  const sdRg = Math.sqrt(Math.max(0, rg2 / n - (rg / n) ** 2));
  const sdYb = Math.sqrt(Math.max(0, yb2 / n - (yb / n) ** 2));
  const colorful = Math.hypot(sdRg, sdYb) + 0.3 * Math.hypot(rg / n, yb / n);
  let s = 1 - Math.min(1, Math.abs(mean - 0.42) / 0.38);
  if (mean < 0.1) s -= 1;
  s += Math.min(1, std / 0.2);
  s += 0.5 * Math.min(1, colorful / 45);
  s -= 4 * Math.max(0, dark / n - 0.15);
  return { score: s, stats: { lum: mean, contrast: std, colorful, dark: dark / n } };
}

// --- search --------------------------------------------------------------------------------------------

function place(a: Anchor, yaw: number, pitch: number, rise: number, back: number, side: number): View {
  const up = clampMove(a.eye, add(a.eye, [0, 0, rise]));
  const f = flatDir(yaw);
  const r: V3 = [f[1], -f[0], 0];
  const s = clampMove(up, add(up, r, side));
  const pos = clampMove(s, add(s, f, -back));
  return { pos, yaw, pitch };
}

function evaluate(a: Anchor, v: View, rise: number): Cand {
  const { score, stats } = scoreDepth(probeDepth(v), v, a, rise);
  return { ...v, anchor: a, rise, geo: score, color: 0, total: score, stats };
}

function searchAnchor(a: Anchor, rnd: () => number): Cand[] {
  const coarse: Cand[] = [];
  const rises = [[24, 5], [112, 10], [256, 16]];
  for (let yaw = 0; yaw < 360; yaw += 15) for (const [rise, pitch] of rises) coarse.push(evaluate(a, place(a, yaw, pitch, rise, 48, 0), rise));
  coarse.sort((p, q) => q.geo - p.geo);
  const seeds: Cand[] = [];
  for (const c of coarse) if (seeds.length < 5 && !seeds.some((s) => angDiff(s.yaw, c.yaw) < 30)) seeds.push(c);
  const refined: Cand[] = [...seeds];
  for (const s of seeds) {
    for (let k = 0; k < 22; k++) {
      const yaw = s.yaw + (rnd() - 0.5) * 22;
      const rise = Math.max(16, s.rise + (rnd() - 0.5) * 200);
      const pitch = Math.max(1, Math.min(28, 4 + rise * 0.04 + (rnd() - 0.5) * 14));
      const back = rnd() * 360;
      const side = (rnd() - 0.5) * 400;
      refined.push(evaluate(a, place(a, yaw, pitch, rise, back, side), rise));
    }
  }
  refined.sort((p, q) => q.geo - p.geo);
  const top: Cand[] = [];
  for (const c of refined) if (top.length < 4 && !top.some((t) => angDiff(t.yaw, c.yaw) < 12 && dist(t.pos, c.pos) < 96)) top.push(c);
  for (const c of top) {
    const col = scoreColor(c);
    c.color = col.score;
    c.total = c.geo + col.score;
    Object.assign(c.stats, col.stats);
  }
  return top.sort((p, q) => q.total - p.total);
}

// --- output --------------------------------------------------------------------------------------------

const out2d = document.createElement("canvas").getContext("2d", { alpha: false, willReadFrequently: true })!;

async function encode(c: HTMLCanvasElement, type: string, q: number): Promise<string> {
  const blob = await new Promise<Blob>((r, j) => c.toBlob((b) => (b ? r(b) : j(new Error("encode failed"))), type, q));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Opaque canvases only: an alpha channel would add an ALPH chunk to every WebP. */
function resized(src: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { alpha: false })!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, w, h);
  return c;
}

function meanLuminance(px: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < px.length; i += 16) sum += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
  return sum / (px.length / 16);
}

/**
 * Gentle auto-exposure for dark shots: a gamma lift (shadows up, no clipping) towards a mean luminance of 0.3.
 * Returns the mean luminance before and after.
 */
function exposure(g: CanvasRenderingContext2D): { before: number; after: number; gamma: number } {
  const { width: w, height: h } = g.canvas;
  const img = g.getImageData(0, 0, w, h);
  const px = img.data;
  const mean = meanLuminance(px);
  if (mean >= 0.28 || mean <= 0.005) return { before: mean, after: mean, gamma: 1 };
  const gamma = Math.max(0.62, Math.log(0.3) / Math.log(mean));
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, gamma));
  for (let i = 0; i < px.length; i += 4) {
    px[i] = lut[px[i]];
    px[i + 1] = lut[px[i + 1]];
    px[i + 2] = lut[px[i + 2]];
  }
  g.putImageData(img, 0, 0);
  return { before: mean, after: meanLuminance(px), gamma };
}

type Encoded = Pick<ShotResult, "webp" | "card" | "jpg" | "lqip" | "lum">;

/**
 * Final render: 2× supersampled, downscaled, exposure-corrected. The hero is kept at 1280×720 (+ a 480×270 card,
 * a 16×9 LQIP and optionally a 640×360 JPEG, the size of the GameBanana copies that name otherwise holds); gallery
 * extras are 854×480 (they only ever show in the map browser's hero panel, ≤ 400 CSS px wide).
 */
async function renderShot(v: View, o: { hero: boolean; jpg: boolean; quality: number }): Promise<Encoded> {
  renderer.setSize(OUT_W * SS, OUT_H * SS, false);
  camera.aspect = 16 / 9;
  camera.updateProjectionMatrix();
  setCamera(v);
  renderer.render(scene, camera);
  out2d.canvas.width = OUT_W;
  out2d.canvas.height = OUT_H;
  out2d.imageSmoothingEnabled = true;
  out2d.imageSmoothingQuality = "high";
  out2d.drawImage(renderer.domElement, 0, 0, OUT_W, OUT_H);
  const ex = rawShots ? { after: meanLuminance(out2d.getImageData(0, 0, OUT_W, OUT_H).data) } : exposure(out2d);
  const full = out2d.canvas;
  const lum = Math.round(ex.after * 1000) / 1000;
  if (!o.hero) return { webp: await encode(resized(full, EXTRA_W, EXTRA_H), "image/webp", o.quality - 0.04), lum };
  const res: Encoded = { webp: await encode(full, "image/webp", o.quality), lum };
  res.card = await encode(resized(full, CARD_W, CARD_H), "image/webp", o.quality);
  res.lqip = await encode(resized(resized(full, 128, 72), LQIP_W, LQIP_H), "image/webp", 0.4);
  if (o.jpg) res.jpg = await encode(resized(full, JPG_W, JPG_H), "image/jpeg", 0.82);
  return res;
}

// --- driver --------------------------------------------------------------------------------------------

let ready: Promise<{ name: string; bsp: Uint8Array; zones: Zone[] }>;
let refreshWorld = () => {};

type SimStep = [number, number, number, number, number, number] | ["at", number, number, number, number];

/**
 * Resets the core with `physics` and runs `steps` (see the header), then updates the world's brush entities. Returns
 * where the player ended up and the brush models now hidden.
 */
async function sim(physics: number, steps: SimStep[]): Promise<{ position: V3; tick: number; hidden: number[] }> {
  await ready;
  core.setSettings({ ...styleSettings("autohop"), physics });
  core.reset();
  for (const s of steps) {
    if (s[0] === "at") setPosition(core, s[1], s[2], s[3], s[4]);
    else for (let i = 0; i < s[5]; i++) core.step(s[0], s[1], s[2], s[3], s[4]);
  }
  refreshWorld();
  const st = core.state();
  const hidden = [...core.brushOrigins()].filter(([, t]) => t.length > 6 && t[6] === 0).map(([m]) => m);
  return { position: st.position, tick: st.tick, hidden };
}

async function load(name: string) {
  const t0 = performance.now();
  const [bspRes, wasm] = await Promise.all([fetch(`/${name}.bsp`), fetch(wasmUrl).then((r) => r.arrayBuffer())]);
  if (!bspRes.ok || (bspRes.headers.get("content-type") ?? "").includes("text/html")) throw new Error(`/${name}.bsp: HTTP ${bspRes.status}`);
  const bsp = new Uint8Array(await bspRes.arrayBuffer());
  core = await Core.create(new Uint8Array(wasm));
  core.loadMap(bsp);
  const world = await buildWorld(core, renderer, { bsp });
  world.update(core.brushOrigins(), 12, core.effectStates());
  refreshWorld = () => world.update(core.brushOrigins(), core.state().tick * .01, core.effectStates());
  sky = world.root.children[0] ?? null;
  skyFaces = world.skyFaces;
  scene.add(world.root);
  scene.updateMatrixWorld(true);
  let zones: Zone[] = [];
  try {
    const r = await fetch(`/${name}.zones.json`);
    if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) zones = parseZoneSet(await r.json(), name, "file")?.zones ?? [];
  } catch {
    /* none */
  }
  if (!zones.length) zones = detectZones(core.entities(), bspModelBounds(bsp), name)?.zones ?? [];
  log(`${name}: loaded in ${(performance.now() - t0).toFixed(0)} ms, ${zones.length} zones`);
  return { name, bsp, zones };
}

async function run(opts: RenderOptions = {}): Promise<RenderResult> {
  const t0 = performance.now();
  const { name, zones } = await ready;
  const want = Math.max(1, Math.min(3, opts.shots ?? 3));
  const quality = opts.quality ?? 0.8;
  const issues: string[] = [];
  const rnd = mulberry32([...name].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261));
  let anchors = anchorsFor(core.entities(), zones);
  if (!zones.some((z) => z.kind === "start" && trackOf(z) === 0)) issues.push("no main start zone: hero from spawn/teleports");
  if (!anchors.length) {
    // Nothing to go by: the middle of the world's bounding box, if it's open.
    const box = new THREE.Box3().setFromObject(scene.children[0].children[1]);
    const c = box.getCenter(new THREE.Vector3());
    const eye: V3 = [c.x, -c.z, c.y];
    anchors = [{ kind: "world", label: "world centre", eye, yaw: null, targets: [] }];
    issues.push("no anchors: world centre");
  }
  const results = new Map<Anchor, Cand[]>();
  for (const a of anchors) results.set(a, searchAnchor(a, rnd));
  const all = [...results.values()].flat().sort((p, q) => q.total - p.total);
  const startA = anchors.find((a) => a.kind === "start" || a.kind === "spawn") ?? anchors[0];
  const startBest = results.get(startA)?.[0];
  const best = all[0];
  const POOR = 1.6;
  let hero: Cand | View | undefined = startBest;
  if (opts.hero) hero = opts.hero;
  // The start zone is the hero unless its best view is poor (or much worse than one further along: an empty
  // start box, a pitch-black spawn room).
  else if (!startBest || (best && ((startBest.total < POOR && best.total > startBest.total + 0.6) || best.total > startBest.total + 1.6))) {
    if (startBest) issues.push(`start view poor (${startBest.total.toFixed(2)}): hero from ${best.anchor.label}`);
    hero = best;
  }
  if (!hero) throw new Error("no view found");
  const chosen: { role: "hero" | "extra"; c: Cand | View }[] = [{ role: "hero", c: hero }];
  const distinct = (c: Cand) => chosen.every(({ c: o }) => dist(o.pos, c.pos) > 768 || (dist(o.pos, c.pos) > 160 && angDiff(o.yaw, c.yaw) > 75) || angDiff(o.yaw, c.yaw) > 120);
  for (const c of all) {
    if (chosen.length >= want) break;
    if (c.total < POOR - 0.6) break;
    if (distinct(c) && !chosen.some(({ c: o }) => "anchor" in o && o.anchor === c.anchor)) chosen.push({ role: "extra", c });
  }
  // Too few anchors: allow a second view from the same anchor if it looks elsewhere.
  for (const c of all) {
    if (chosen.length >= want) break;
    if (c.total >= POOR - 0.4 && distinct(c) && !chosen.some((x) => x.c === c)) chosen.push({ role: "extra", c });
  }
  const heroTotal = "total" in hero ? (hero as Cand).total : NaN;
  if (heroTotal < 1) issues.push(`low hero score ${heroTotal.toFixed(2)}`);
  const heroDark = "stats" in hero ? (hero as Cand).stats.dark : 0;
  if (heroDark > 0.3) issues.push(`hero ${Math.round(heroDark * 100)}% black`);
  const shots: ShotResult[] = [];
  for (const { role, c } of chosen) {
    const img = await renderShot(c, { hero: role === "hero", jpg: role === "hero" && !!opts.jpg, quality });
    const cand = "anchor" in c ? (c as Cand) : null;
    shots.push({
      role,
      anchor: cand?.anchor.label ?? "override",
      view: { pos: c.pos.map((x) => Math.round(x)) as V3, yaw: Math.round(c.yaw * 10) / 10, pitch: Math.round(c.pitch * 10) / 10 },
      score: cand ? Math.round(cand.total * 100) / 100 : 0,
      stats: cand ? Object.fromEntries(Object.entries(cand.stats).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) : {},
      ...img,
    });
  }
  if (shots[0].lum < 0.05) issues.push(`renders black (mean luminance ${shots[0].lum})`);
  const st = mapContentStatus();
  return {
    map: name,
    ms: Math.round(performance.now() - t0),
    content: st && { missing: st.missing, materials: st.materials, manifest: st.manifest, sky: st.sky, skyResolved: st.skyResolved },
    anchors: Object.fromEntries([...results].map(([a, cs]) => [a.label, Math.round((cs[0]?.total ?? -9) * 100) / 100])),
    issues,
    shots,
  };
}

async function renderView(v: View): Promise<string> {
  await ready;
  return (await renderShot(v, { hero: true, jpg: false, quality: 0.9 })).webp;
}

const params = new URLSearchParams(location.search);
const mapName = params.get("map");
Object.assign(window, { __thumb: { run, renderView, sim } });
if (mapName) {
  ready = load(mapName);
  ready.then(
    () => Object.assign(window, { __thumbReady: true }),
    (e) => Object.assign(window, { __thumbError: String(e?.message ?? e) }),
  );
  // Interactive preview (no automation): run and show the shots.
  if (!navigator.webdriver) {
    const fixed = params.get("view")?.split(",").map(Number);
    void (async () => {
      const shots = fixed && fixed.length === 5 ? [{ webp: await renderView({ pos: [fixed[0], fixed[1], fixed[2]], yaw: fixed[3], pitch: fixed[4] }), anchor: "view", score: 0, stats: {} }] : (await run()).shots;
      canvas.style.display = "none";
      for (const s of shots) {
        const img = document.createElement("img");
        img.src = `data:image/webp;base64,${s.webp}`;
        img.style.cssText = "display:block;width:min(100vw,1280px)";
        document.body.append(img);
        log(`${s.anchor}: ${s.score} ${JSON.stringify(s.stats)}`);
      }
    })();
  }
}
