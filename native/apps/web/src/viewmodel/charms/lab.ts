// DEV ONLY charm lab (charmlab.html, not a build input): the real Viewmodel with a charm, under scripted motion, on a
// fixed clock so captures are frame-exact.
//
//   /charmlab.html?knife=daikon&charm=charm-bun&motion=strafe&swing=30&length=100&size=100&pommel=1&hand=left
//                 &fov=64&x=0.5&y=1.5&z=0&zoom=1.6&fps=60&live=1
//                 &hilt=hilt-watcher&glove=glove-plush&back=back-robe&zoom=0.6&zx=0.5&zy=0.5
//   motion: idle | strafe (bhop strafing: yaw sweeps, hops, landings) | jump | turn (one fast flick each way) | inspect
//   live=1 runs on requestAnimationFrame at `fps`; otherwise the page waits for __charmlab.go(t) (captures).

import * as THREE from "three";
import { loadoutFor } from "../../loadout";
import { prefs } from "../../ui/settings";
import { equipKnife } from "../knives/equipped";
import { knifeById } from "../knives/index";
import { Viewmodel, type ViewmodelInput } from "../viewmodel";
import { tieOverride } from "./places";

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const canvas = document.getElementById("c") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000, 0);
const info = document.getElementById("info")!;

prefs.update((p) => {
  p.viewmodel.hand = q.get("hand") === "left" ? "left" : "right";
  p.viewmodel.fov = num("fov", 64);
  p.viewmodel.x = num("x", 0.5);
  p.viewmodel.y = num("y", 1.5);
  p.viewmodel.z = num("z", 0);
  if (q.has("bob")) p.viewmodel.bob = num("bob", 0.5);
  if (q.has("sway")) p.viewmodel.sway = num("sway", 1);
});
const knife = knifeById(q.get("knife"));
// ?tie={"turn":40,"drop":0.2}: fields laid over the knife's guard tie (places.ts), to try a place by eye.
if (q.has("tie")) tieOverride.guard = JSON.parse(q.get("tie")!);
equipKnife(knife ?? null);
const vm = new Viewmodel();
vm.setKnife(knife ?? null);
const look = () =>
  loadoutFor({
    charm: q.get("charm") ?? "charm-bun",
    charmLength: q.has("length") ? num("length", 100) : undefined,
    charmSize: q.has("size") ? num("size", 100) : undefined,
    charmSwing: q.has("swing") ? num("swing", 30) : undefined,
    charmPommel: q.get("pommel") === "1",
    glove: q.get("glove") ?? undefined,
    hilt: q.get("hilt") ?? undefined,
    back: q.get("back") ?? undefined,
    finish: q.get("finish") ?? undefined,
  });
vm.setLoadout(look());
vm.setVisible(true, false);
vm.idle();

const world = new THREE.PerspectiveCamera(90, 16 / 9, 1, 4000);
const zoom = num("zoom", 1);
const fps = num("fps", 60);
const motion = q.get("motion") ?? "idle";

/** The scripted motion at time t (s): what the game would feed the viewmodel. */
function input(t: number, dt: number): ViewmodelInput {
  const s: ViewmodelInput = { velocity: [0, 0, 0], grounded: true, viewOffsetZ: 64, sidemove: 0, yaw: 0, pitch: 0, landed: 0 };
  if (motion === "strafe") {
    // Bhop: a hop every 0.66 s, a strafe each way per hop (yaw sweeping ±28° in sync), 600 u/s forward.
    const T = 0.66, ph = (t % T) / T, n = Math.floor(t / T);
    const air = ph > 0.06;
    const dir = n % 2 ? 1 : -1;
    s.yaw = 28 * Math.sin(Math.PI * (t / T - 0.5));
    s.sidemove = dir * 450;
    const spd = Math.min(600, 260 + 60 * t);
    const yr = (s.yaw * Math.PI) / 180;
    s.velocity = [Math.cos(yr) * spd, Math.sin(yr) * spd, air ? 300 - 800 * (ph * T - 0.04) : 0];
    s.grounded = !air;
    if (n > 0 && Math.floor((t - dt) / T) !== n) s.landed = -300;
  } else if (motion === "jump") {
    // Standing hops: up at 1 s and 3 s, landing 0.75 s later.
    const hop = (t0: number) => t >= t0 && t < t0 + 0.755;
    const up = hop(1) ? t - 1 : hop(3) ? t - 3 : -1;
    s.grounded = up < 0;
    s.velocity = [0, 0, up >= 0 ? 301 - 800 * up : 0];
    if ((t >= 1.755 && t - dt < 1.755) || (t >= 3.755 && t - dt < 3.755)) s.landed = -301;
  } else if (motion === "turn") {
    // A fast flick right, a hold, a flick back.
    const e = (a: number, b: number) => Math.min(1, Math.max(0, (t - a) / (b - a)));
    const sm = (u: number) => u * u * (3 - 2 * u);
    s.yaw = -90 * sm(e(0.8, 1.05)) + 90 * sm(e(2.4, 2.65));
  }
  return s;
}

let t = 0;
let W = 0, H = 0;
const held = { primary: false, secondary: false, inspect: false };
function step(dt: number): void {
  t += dt;
  if (motion === "inspect" && t >= 0.5 && t - dt < 0.5) vm.inspect();
  vm.update(dt, input(t, dt), held);
}
function draw(): void {
  if (innerWidth !== W || innerHeight !== H) {
    W = innerWidth;
    H = innerHeight;
    renderer.setSize(W, H, false);
  }
  renderer.clear();
  world.aspect = W / H;
  world.updateProjectionMatrix();
  if (zoom !== 1) vm.camera.setViewOffset(W, H, W * num("zx", 0.62) - W / (2 * zoom), H * num("zy", 0.72) - H / (2 * zoom), W / zoom, H / zoom);
  vm.render(renderer, world);
  info.textContent = q.has("info") ? `${motion} t=${t.toFixed(2)}` : "";
}

/** Captures: advance to time `to` (s) at the fixed rate, then draw. */
function go(to: number): void {
  while (t + 1e-9 < to) step(Math.min(1 / fps, to - t));
  draw();
}

if (q.get("live") === "1") {
  const loop = () => {
    step(1 / fps);
    draw();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
} else go(0);

Object.assign(window, { __vm: vm, __charmlab: { ready: true, go, t: () => t, set: (l: Record<string, unknown>) => vm.setLoadout(loadoutFor(l)) } });
