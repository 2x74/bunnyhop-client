// DEV ONLY inspect lab (inspectlab.html, not a build input): the real Viewmodel (left) and, on the right, the real
// PlayerModel bunny as another player sees you: its inspect signals go through the room sample encoding (protocol.ts
// SF_INSPECT_*, 20 Hz samples) and arrive 100 ms later, like net/interp.ts would deliver them.
//
//   /inspectlab.html?knife=karrotbit                 F taps / hold F, 1 slash, 2 stab, D draw
//   &script=f@0.3,f@1.0,f@2.0,a1@3.1,d@4             scripted keys (f = tap F, F = F down, u = F up, a1 / a2 = attack,
//                                                    d = draw) at seconds; &loop=6 restarts the script every 6 s
//   &hand=left · &tp=0 (viewmodel only) · &vminspect=<set> (dev flags as in the game) · &zoom=1.3 · &speed=0.5
//
// The HUD line shows the combo state (trick, time, queued, loops, held, weight) and the event log.

import * as THREE from "three";
import { PlayerModel, type PlayerPose } from "../../player/model";
import { prefs } from "../../ui/settings";
import { equipKnife } from "../knives/equipped";
import { knifeById } from "../knives/index";
import { inspectField, SF_INSPECT_SHIFT } from "../../net/protocol";
import { onWeaponEvent } from "../events";
import { Viewmodel, type ViewmodelInput } from "../viewmodel";

const q = new URLSearchParams(location.search);
const canvas = document.getElementById("c") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setClearColor(0x000000, 0);
const info = document.getElementById("info")!;
const labels = document.getElementById("labels")!;

if (q.get("hand") === "left" || q.get("hand") === "right") prefs.update((p) => (p.viewmodel.hand = q.get("hand") as "left" | "right"));
const knife = knifeById(q.get("knife"));
equipKnife(knife ?? null);
const vm = new Viewmodel();
// After construction: the viewmodel follows your saved loadout's knife (viewmodel/equip.ts), the lab's wins.
vm.setKnife(knife ?? null);
if (q.get("vminspect")) {
  const dev = await import("../finishes/dev");
  dev.installDevCosmetics(vm);
}
const showTp = q.get("tp") !== "0";
const world = new THREE.PerspectiveCamera(74, 1, 1, 1000);
const zoom = Number(q.get("zoom") ?? 1);
/** &speed=0.5: slow motion (the script runs on the slowed clock too). */
const speed = Number(q.get("speed") ?? 1);

// --- Third person: the bunny, a chase-ish camera in front-right of it, signals through the sample encoding.
const scene = new THREE.Scene();
const model = new PlayerModel({ style: "solid", model: "bunny", knife: knife ?? null });
scene.add(model.root);
const tpCam = new THREE.PerspectiveCamera(28, 1, 1, 2000);
const yaw = -30;
const pose: PlayerPose = { position: [0, 0, 0], velocity: [0, 0, 0], yaw, pitch: 0, crouched: false, grounded: true };
model.setState(pose);
model.snap();

// Sender side (mp.ts): one 2-bit field per 50 ms sample: an event (start / next) or the held level.
let pendingSig = 0;
vm.inspects.onSignal = (sig) => (pendingSig = Math.max(pendingSig, sig));
let pendingAttack = 0;
vm.onAttack = (k) => (pendingAttack = k);
/** Samples in flight: [deliver at (s), flags]. */
const wire: [number, number][] = [];
let sampleClock = 0;
let receiverHeld = false;

// --- Input: keys and the script.
const held = { primary: false, secondary: false, inspect: false };
const log: string[] = [];
const keyDown = (code: string) => {
  if (code === "KeyF") {
    if (!held.inspect) vm.inspect();
    held.inspect = true;
  } else if (code === "Digit1") vm.press(false);
  else if (code === "Digit2") vm.press(true);
  else if (code === "KeyD") vm.draw();
};
addEventListener("keydown", (e) => !e.repeat && keyDown(e.code));
addEventListener("keyup", (e) => e.code === "KeyF" && (held.inspect = false));
onWeaponEvent((e) => {
  if (e.source !== "local") return;
  log.push(`${e.type}${e.trick !== undefined ? ` ${e.trick}` : ""}${e.name ? ` ${e.name}` : ""}`);
  if (log.length > 7) log.shift();
});

const script = (q.get("script") ?? "")
  .split(",")
  .filter(Boolean)
  .map((s) => {
    const [k, at] = s.split("@");
    return { k, at: Number(at) };
  })
  .sort((a, b) => a.at - b.at);
const loopLen = Number(q.get("loop") ?? 0);
let clock = 0;
let si = 0;
const runScript = (t: number) => {
  while (si < script.length && script[si].at <= t) {
    const { k } = script[si++];
    if (k === "f") {
      keyDown("KeyF");
      setTimeout(() => (held.inspect = false), 60);
    } else if (k === "F") keyDown("KeyF");
    else if (k === "u") held.inspect = false;
    else if (k === "a1") vm.press(false);
    else if (k === "a2") vm.press(true);
    else if (k === "d") vm.draw();
  }
};

const still: ViewmodelInput = { velocity: [0, 0, 0], grounded: true, viewOffsetZ: 64, sidemove: 0, yaw: 0, pitch: 0, landed: 0 };
let W = 0, H = 0;
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000) * speed;
  last = now;
  clock += dt;
  if (loopLen && clock > loopLen) (clock = 0), (si = 0);
  runScript(clock);
  if (innerWidth !== W || innerHeight !== H) {
    W = innerWidth;
    H = innerHeight;
    renderer.setSize(W, H, false);
  }
  vm.update(dt, still, held);

  // Sender: a sample every 50 ms; receiver: 100 ms later (interp delay), events once, the held level kept.
  sampleClock += dt;
  if (sampleClock >= 0.05) {
    sampleClock -= 0.05;
    const field = pendingSig || (vm.inspects.holding ? 3 : 0);
    wire.push([clock + 0.1, (field << SF_INSPECT_SHIFT) | (pendingAttack ? 16 : 0)]);
    pendingSig = 0;
    pendingAttack = 0;
  }
  let sig = 0, attack = 0;
  while (wire.length && (wire[0][0] <= clock || clock < wire[0][0] - 1)) {
    const [, flags] = wire.shift()!;
    const f = inspectField(flags);
    if (f === 1 || f === 2) sig = f;
    else receiverHeld = f === 3;
    if (flags & 16) attack = 1;
  }
  model.setState({ ...pose, inspect: sig, inspectHeld: receiverHeld, attack });
  model.update(dt);

  // Render: viewmodel on the left (or full), bunny on the right.
  renderer.setScissorTest(true);
  renderer.setScissor(0, 0, W, H);
  renderer.setViewport(0, 0, W, H);
  renderer.clear();
  // The viewmodel at 16:9 (its FOV is Hor+), the bunny in the rest of the width.
  const vw = showTp ? Math.min(W - 200, Math.round((H * 16) / 9)) : W;
  renderer.setViewport(0, 0, vw, H);
  renderer.setScissor(0, 0, vw, H);
  world.aspect = vw / H;
  world.updateProjectionMatrix();
  if (zoom !== 1) vm.camera.setViewOffset(vw, H, vw * 0.62 - vw / (2 * zoom), H * 0.6 - H / (2 * zoom), vw / zoom, H / zoom);
  vm.render(renderer, world);
  if (showTp) {
    const tw = W - vw;
    renderer.setViewport(vw, 0, tw, H);
    renderer.setScissor(vw, 0, tw, H);
    tpCam.aspect = tw / H;
    tpCam.updateProjectionMatrix();
    // In front of the bunny and to its right, at chest height (Source -> three: (x, z, -y)).
    const fy = (yaw * Math.PI) / 180;
    const f = new THREE.Vector3(Math.cos(fy), 0, -Math.sin(fy));
    const r = new THREE.Vector3(Math.sin(fy), 0, Math.cos(fy));
    const chest = new THREE.Vector3(0, 44, 0).add(model.root.position);
    tpCam.position.copy(chest).addScaledVector(f, 120).addScaledVector(r, 50).add(new THREE.Vector3(0, 8, 0));
    tpCam.lookAt(chest.clone().addScaledVector(r, 6));
    renderer.render(scene, tpCam);
  }
  renderer.setScissorTest(false);

  const c = vm.inspects.combo;
  const set = vm.inspects.current;
  const p = c.pose();
  info.textContent =
    `${set.id} · ${c.trick >= 0 ? `${set.clips[c.trick].name} t=${c.time.toFixed(2)}` : "idle"}` +
    `${c.isQueued ? " · next queued" : ""}${c.loopCount ? ` · loops ${c.loopCount}` : ""}${held.inspect ? " · F held" : ""} · w ${p.weight.toFixed(2)}` +
    ` · ${log.join(" › ")}`;
  labels.innerHTML = showTp ? `<span style="left:12px;top:8px">first person</span><span style="left:${vw + 12}px;top:8px">what others see (room samples, 100 ms)</span>` : "";
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
Object.assign(window, { __vm: vm, __lab: { ready: true }, __tp: model });
