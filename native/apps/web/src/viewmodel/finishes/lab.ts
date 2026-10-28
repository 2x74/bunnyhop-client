// DEV PROTOTYPE lab page (vmlab.html, not a build input): the real Viewmodel (procedural animation, your colourway)
// over a plain backdrop, with the prototype finishes / inspect, single view or a grid of cells.
//
//   /vmlab.html?vmfinish=nebula&vminspect=flip                          live; F inspects, loop=1 repeats it
//   &act=inspect&t=0.4[&trick=1]                                        freeze one pose (any action: idle, draw, slash1, stab;
//                                                                       inspect: trick of the chain, 0 = base)
//   &vminspect=karrotbit&vmknife=karrotbit                              a knife's inspect set; F taps chain tricks, hold F loops
//   &hand=left                                                          left-handed (mirrored) viewmodel
//   &cells=sunset,nebula,frost@1.2,...                                   grid (finish[@t]); cols=4; cells=all: every finish
//   &zoom=1.8&cx=0.62&cy=0.62                                           zoom the viewmodel camera around (cx, cy)
//   &labels=0                                                           hide the cell captions

import * as THREE from "three";
import { Viewmodel, type ViewmodelInput } from "../viewmodel";
import type { VmAction } from "../procedural";
import { prefs } from "../../ui/settings";
import { describe, installDevCosmetics } from "./dev";
import { FINISH_IDS, parseFinish, type FinishSpec } from "./finishes";

const q = new URLSearchParams(location.search);
const canvas = document.getElementById("c") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setClearColor(0x000000, 0);
const world = new THREE.PerspectiveCamera(74, 1, 1, 1000);

const vm = new Viewmodel();
// The constructor installs the prototype when the URL has vmfinish / vminspect; otherwise install it here.
await import("./dev");
const api = (window as unknown as { __vmcos?: ReturnType<typeof installDevCosmetics> }).__vmcos ?? installDevCosmetics(vm);

interface Cell {
  spec: FinishSpec;
  t: number | null;
}
const base: FinishSpec = { finish: parseFinish(q.get("vmfinish")) };
const cells: Cell[] = (q.get("cells") === "all" ? FINISH_IDS.join(",") : (q.get("cells") ?? ""))
  .split(",")
  .filter(Boolean)
  .map((c) => {
    const [finish, at] = c.split("@");
    return { spec: { finish: parseFinish(finish) }, t: at !== undefined ? Number(at) : null };
  });
const grid = cells.length > 0;
if (!grid) cells.push({ spec: base, t: null });
const cols = Number(q.get("cols") ?? Math.ceil(Math.sqrt(cells.length)));
const rows = Math.ceil(cells.length / cols);
const act = (q.get("act") ?? (q.has("t") ? "inspect" : "")) as VmAction | "inspect" | "";
const T = Number(q.get("t") ?? 0);
/** Inspect trick index for act=inspect / @t cells (0 = the base inspect, 1+ = the chain). */
const trick = Number(q.get("trick") ?? 0) | 0;
// &hand=left previews the left-handed (mirrored) viewmodel (saved like the Settings toggle, on this origin).
if (q.get("hand") === "left" || q.get("hand") === "right") prefs.update((p) => (p.viewmodel.hand = q.get("hand") as "left" | "right"));
const zoom = Number(q.get("zoom") ?? 1);
const cx = Number(q.get("cx") ?? 0.5), cy = Number(q.get("cy") ?? 0.5);
const loop = q.get("loop") === "1";
const showLabels = q.get("labels") !== "0";

const still: ViewmodelInput = { velocity: [0, 0, 0], grounded: true, viewOffsetZ: 64, sidemove: 0, yaw: 0, pitch: 0, landed: 0 };
const held = { primary: false, secondary: false, inspect: false };
addEventListener("keyup", (e) => {
  if (e.code === "KeyF") held.inspect = false;
});
if (act) vm.seek(act, T, trick);

const labels = document.getElementById("labels")!;
const info = document.getElementById("info")!;
info.textContent = grid ? `${cells.length} cells` : `${describe(base)} · F inspect · 1 slash · 2 stab`;
addEventListener("keydown", (e) => {
  if (e.code === "KeyF" && !e.repeat) vm.inspect();
  if (e.code === "KeyF") held.inspect = true;
  if (e.code === "Digit1") vm.press(false);
  if (e.code === "Digit2") vm.press(true);
});

function layoutLabels(w: number, h: number): void {
  labels.innerHTML = "";
  if (!grid || !showLabels) return;
  const cw = w / cols, ch = h / rows;
  cells.forEach((c, i) => {
    const s = document.createElement("span");
    s.style.left = `${(i % cols) * cw + 10}px`;
    s.style.top = `${Math.floor(i / cols) * ch + 8}px`;
    const same = cells.every((o) => JSON.stringify(o.spec) === JSON.stringify(c.spec));
    s.textContent = same && c.t !== null ? `t ${c.t.toFixed(2)} s` : describe(c.spec) + (c.t !== null ? ` · t ${c.t.toFixed(2)} s` : "");
    labels.appendChild(s);
  });
}

let W = 0, H = 0;
function resize(): void {
  const w = innerWidth, h = innerHeight;
  if (w === W && h === H) return;
  W = w, H = h;
  renderer.setSize(w, h, false);
  layoutLabels(w, h);
}

let last = performance.now();
let loopT = 99; // first inspect right away
function frame(now: number): void {
  resize();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (loop && !act) {
    loopT += dt;
    if (loopT > vm.inspects.current.clips[0].len + 0.8) (loopT = 0), vm.inspect();
  }
  renderer.setScissorTest(grid);
  renderer.clear();
  const cw = Math.floor(W / cols), ch = Math.floor(H / rows);
  cells.forEach((c, i) => {
    const x = (i % cols) * cw, y = H - (Math.floor(i / cols) + 1) * ch;
    if (grid) {
      renderer.setViewport(x, y, cw, ch);
      renderer.setScissor(x, y, cw, ch);
      api.set(c.spec, true);
      if (c.t !== null) vm.seek("inspect", c.t, trick);
    }
    world.aspect = (grid ? cw : W) / (grid ? ch : H);
    world.updateProjectionMatrix();
    const vw = grid ? cw : W, vh = grid ? ch : H;
    if (zoom !== 1) vm.camera.setViewOffset(vw, vh, cx * vw - vw / (2 * zoom), cy * vh - vh / (2 * zoom), vw / zoom, vh / zoom);
    vm.update(grid || act ? 0 : dt, still, held);
    vm.render(renderer, world);
  });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
Object.assign(window, { __vm: vm, __lab: { ready: true, renderer, world } });
