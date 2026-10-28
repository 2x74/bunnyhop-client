// DEV ONLY gun lab (gunlab.html, not a build input): the gun registry in first person (the real GunViewmodel over a
// simple test room, so the framing reads like in game), the world / dropped models and the bunny holding one.
//
//   ?mode=fp&cells=glock:right:idle,glock:right:reload:1.1      gun:hand:clip[:t[:dur]]   clips: idle draw fire reload
//                                                               reloadEmpty inspect pump shellStart shellInsert shellEnd
//                                                               silOn silOff (the USP's silencer) idleSil (idle, on)
//   ?mode=fp&live=1&gun=m3                                      live: click / hold = fire (at the gun's cycle; the
//                                                               Thumper bursts with B), R reload, F inspect, E dry fire,
//                                                               Q draw, 1-8 guns, H hand, W walk (bob), V silencer
//                                                               (USP: on / off over the core's 3.08 s; shots then
//                                                               silenced); &silenced=1 starts with it on
//   ?mode=world&cells=glock,usp,fiveseven,m3,xm1014,p90,ak47,awp  dropped models (turntable)
//   ?mode=tp&gun=glock                                          the bunny holding it (third person)
//   &cols=3 · &labels=0 · &cross=1 (crosshair) · &glove=sport · &outfit=outfit-...
// window.__gunlab: { vm, seek(cell, clip, t), fire(), ... } for scripted captures (tools/viewmodel/gun-shots.ts).

import * as THREE from "three";
import { prefs } from "../../ui/settings";
import { DEFAULT_LOADOUT } from "../../loadout";
import { GUNS, gunById } from "./index";
import { GunViewmodel } from "./viewmodel";
import { ARM, ELBOW } from "./pose";
import { clearGunHolds } from "./hold";
import type { BaseClip } from "./anim";
import type { GunDef } from "./types";
import { restOnFloor, worldGunGeometry, worldGunMaterial } from "./world";
import { GunImpacts } from "./impacts";

const q = new URLSearchParams(location.search);
const canvas = document.getElementById("c") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
const labels = document.getElementById("labels")!;
const info = document.getElementById("info")!;
const mode = q.get("mode") ?? "fp";
const showLabels = q.get("labels") !== "0";
const loadout = { ...DEFAULT_LOADOUT, glove: q.get("glove") ? `glove-${q.get("glove")}` : DEFAULT_LOADOUT.glove };

interface Cell {
  label: string;
  draw(x: number, y: number, w: number, h: number, dt: number): void;
}
let cells: Cell[] = [];
let cols = 1;

function layout(): void {
  labels.innerHTML = "";
  if (!showLabels) return;
  const W = innerWidth, H = innerHeight;
  const rows = Math.ceil(cells.length / cols);
  cells.forEach((c, i) => {
    const s = document.createElement("span");
    s.style.left = `${(i % cols) * (W / cols) + 10}px`;
    s.style.top = `${Math.floor(i / cols) * (H / rows) + 8}px`;
    s.innerHTML = c.label;
    labels.appendChild(s);
  });
}

let last = performance.now();
function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const W = innerWidth, H = innerHeight;
  renderer.setSize(W, H, false);
  const rows = Math.ceil(cells.length / cols);
  const cw = Math.floor(W / cols), ch = Math.floor(H / rows);
  renderer.setScissorTest(true);
  renderer.setViewport(0, 0, W, H);
  renderer.setScissor(0, 0, W, H);
  renderer.setClearColor(0x10131a, 1);
  renderer.clear();
  cells.forEach((c, i) => {
    const x = (i % cols) * cw, y = H - (Math.floor(i / cols) + 1) * ch;
    renderer.setViewport(x, y, cw, ch);
    renderer.setScissor(x, y, cw, ch);
    c.draw(x, y, cw, ch, dt);
  });
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------------------------
// A test room (world space, three.js Y-up): floor grid, a back wall, a few crates, so framing and effects read.

function testRoom(): { scene: THREE.Scene; impacts: GunImpacts } {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x6f8fb0);
  const tex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    g.fillStyle = "#8b8f95";
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = "#6c7076";
    g.lineWidth = 3;
    g.strokeRect(0, 0, 128, 128);
    g.fillStyle = "#979ba1";
    g.fillRect(6, 6, 54, 54);
    g.fillRect(68, 68, 54, 54);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const floorTex = tex.clone();
  floorTex.repeat.set(16, 16);
  floorTex.needsUpdate = true;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2048, 2048), new THREE.MeshBasicMaterial({ map: floorTex, color: 0xb8b2a6 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const wallTex = tex.clone();
  wallTex.repeat.set(16, 4);
  wallTex.needsUpdate = true;
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(2048, 512), new THREE.MeshBasicMaterial({ map: wallTex, color: 0xd8d2c4 }));
  wall.position.set(0, 256, -420);
  scene.add(wall);
  for (const [x, z, s] of [[-120, -250, 64], [90, -300, 96], [200, -180, 48]] as const) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), new THREE.MeshBasicMaterial({ color: 0xa8865a }));
    b.position.set(x, s / 2, z);
    scene.add(b);
  }
  const impacts = new GunImpacts();
  scene.add(impacts.root);
  return { scene, impacts };
}

function worldCamera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(73.74, 16 / 9, 1, 4000);
  cam.position.set(0, 64, 0);
  return cam;
}

// ---------------------------------------------------------------------------------------------
// First person

type Spec = { gun: GunDef; hand: "right" | "left"; clip: string; t: number; dur?: number };

function parseCell(s: string): Spec {
  const [id, hand = "right", clip = "idle", t = "0", dur] = s.split(":");
  return { gun: gunById(id) ?? GUNS[0], hand: hand === "left" ? "left" : "right", clip, t: Number(t), dur: dur ? Number(dur) : undefined };
}

function seekVm(vm: GunViewmodel, sp: Spec): void {
  vm.setGun(sp.gun);
  const a = vm.anim;
  if (sp.clip === "idle") a.seek("idle", 0);
  else if (sp.clip === "silOn" || sp.clip === "silOff") a.seek("silencer", sp.t, sp.dur, false, sp.clip === "silOn");
  else if (sp.clip === "idleSil") {
    a.seek("idle", 0);
    a.silenced = true;
  }
  else if (sp.clip === "fire") a.seek("fire", sp.t);
  else if (sp.clip === "reloadEmpty") a.seek("reload", sp.t, sp.dur ?? sp.gun.timing.reload, true);
  else a.seek(sp.clip as BaseClip, sp.t, sp.dur ?? (sp.clip === "pump" ? sp.gun.timing.pump?.dur : sp.clip.startsWith("shell") ? sp.gun.timing.shells?.each : undefined));
  vm.timeScale = 0;
  vm.update(0.0001);
  // A frozen shot keeps its muzzle flash (and throws a shell) for stills.
  if (sp.clip === "fire" && q.get("flash") !== "0") vm.fx.shot(sp.t < 0.03 ? 1 : 0);
}

/** Dev tuning: &frame=fx,fy,fz,p,y,r (all guns), &elbow=rx,ry,rz,lx,ly,lz, &armk=0.75, &rplace=t,d,upx,upz (Thumper-style). */
function applyTuning(): void {
  const n = (k: string) => q.get(k)?.split(",").map(Number) ?? null;
  const f = n("frame"), e = n("elbow"), k = q.get("armk");
  for (const g of GUNS) if (f) g.frame = { o: [f[0], f[1], f[2]], a: [f[3] ?? 0, f[4] ?? 0, f[5] ?? 0] };
  if (e) {
    (ELBOW.R = [e[0], e[1], e[2]]), (ELBOW.L = [e[3], e[4], e[5]]);
    for (const g of GUNS) g.elbows = { R: ELBOW.R, L: ELBOW.L };
  }
  if (k) ARM.anchor = Number(k);
  const ro = n("ro"), lo = n("lo"), rf = n("rfwd"), lu = n("lup"), lf = n("lfwd"), ru = n("rup");
  for (const g of GUNS) {
    if (ro) g.right.o = [ro[0], ro[1], ro[2]];
    if (rf) g.right.fwd = [rf[0], rf[1], rf[2]];
    if (ru) g.right.up = [ru[0], ru[1], ru[2]];
    if (lo) g.left.o = [lo[0], lo[1], lo[2]];
    if (lf) g.left.fwd = [lf[0], lf[1], lf[2]];
    if (lu) g.left.up = [lu[0], lu[1], lu[2]];
  }
  clearGunHolds();
}

function firstPerson(): void {
  applyTuning();
  const room = testRoom();
  const cam = worldCamera();
  const live = q.get("live") === "1";
  const cross = q.get("cross") === "1";
  const specs = (q.get("cells") ?? `${q.get("gun") ?? "glock"}:right:idle`).split(",").map(parseCell);
  const orbit = q.get("orbit")?.split(",").map(Number) ?? null;
  const oc = new THREE.PerspectiveCamera(35, 1, 0.1, 500);
  cols = Number(q.get("cols") ?? Math.min(specs.length, 3));
  const vms: GunViewmodel[] = [];
  const crossScene = new THREE.Scene();
  const crossCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  {
    const m = new THREE.MeshBasicMaterial({ color: 0x7dff7d });
    for (const [w, h, x, y] of [[0.012, 0.002, 0.012, 0], [0.012, 0.002, -0.012, 0], [0.002, 0.02, 0, 0.022], [0.002, 0.02, 0, -0.022]]) {
      const b = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
      b.position.set(x, y, 0);
      crossScene.add(b);
    }
  }
  cells = specs.map((sp) => {
    const vm = new GunViewmodel({ loadout });
    vm.debugHide = (q.get("hide") as "R" | "L" | null) ?? null;
    vms.push(vm);
    if (live) {
      vm.setGun(sp.gun);
      vm.setSilenced(q.get("silenced") === "1");
      vm.draw();
    } else seekVm(vm, sp);
    const cell: Cell = {
      label: `<b>${sp.gun.name}</b> · ${sp.gun.archetype} · ${sp.clip}${sp.clip === "idle" ? "" : " " + sp.t.toFixed(2)}`,
      draw: (_x, _y, w, h, dt) => {
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
        const hand = prefs.get().viewmodel.hand;
        if (hand !== sp.hand) prefs.update((p) => (p.viewmodel.hand = sp.hand));
        if (live) liveStep(vm, dt);
        else vm.update(0);
        room.impacts.update(dt);
        renderer.render(room.scene, cam);
        vm.render(renderer, cam);
        if (orbit) {
          // Debug: the same posed viewmodel from an orbit around the gun's grip (yaw, pitch, distance in Source units).
          const W = vm.bonesW, o = vm.partIndex("Gun") * 12, g = vm.def!.right.o;
          const c = new THREE.Vector3(W[o] * g[0] + W[o + 1] * g[1] + W[o + 2] * g[2] + W[o + 3], W[o + 4] * g[0] + W[o + 5] * g[1] + W[o + 6] * g[2] + W[o + 7], W[o + 8] * g[0] + W[o + 9] * g[1] + W[o + 10] * g[2] + W[o + 11]);
          c.add(new THREE.Vector3(orbit[3] ?? 0, orbit[4] ?? 0, orbit[5] ?? 0)).applyMatrix4(vm["root"].matrix);
          const yaw = (orbit[0] * Math.PI) / 180, pitch = (orbit[1] * Math.PI) / 180, d = orbit[2];
          // Around the camera's frame: yaw 0 = from the camera, 90 = from the left.
          const camQ = cam.quaternion;
          const off = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch) * -d, Math.sin(pitch) * d, Math.cos(yaw) * Math.cos(pitch) * d).applyQuaternion(camQ);
          oc.position.copy(c).add(off);
          oc.up.set(0, 1, 0).applyQuaternion(camQ);
          oc.lookAt(c);
          oc.aspect = w / h;
          oc.updateProjectionMatrix();
          renderer.setClearColor(0x3a4152, 1);
          renderer.clear();
          renderer.render(vm.scene, oc);
        }
        if (cross) {
          crossCam.left = -w / h;
          crossCam.right = w / h;
          crossCam.updateProjectionMatrix();
          renderer.autoClear = false;
          renderer.render(crossScene, crossCam);
          renderer.autoClear = true;
        }
      },
    };
    return cell;
  });
  layout();
  const lab = {
    vms,
    room,
    seek: (i: number, s: string) => seekVm(vms[i], parseCell(s)),
    fire: (i = 0) => fireOnce(vms[i]),
    reload: (i = 0, empty = false) => reload(vms[i], empty),
    inspect: (i = 0) => vms[i].inspect(),
    draw: (i = 0) => vms[i].draw(),
    dry: (i = 0) => vms[i].dryFire(),
    /** The silencer on / off over `dur` (default the core's 3.08 s), `at` seconds in. */
    silencer: (i: number, on: boolean, dur = 3.08, at = 0) => vms[i].silencer(on, dur, at),
    gun: (i: number, id: string) => {
      vms[i].setGun(gunById(id) ?? GUNS[0]);
      vms[i].draw();
    },
    hold: { fire: false },
    stats: () => vms.map((v) => v.lastUpdateMs),
  };
  Object.assign(window, { __gunlab: lab });
  if (live) installLive(vms[0], lab.hold);
}

// Live harness: fires at the gun's cycle while held, bursts, reloads, a shotgun's shells one by one, impacts on the wall.
let walk = false;
let fireHeld = false;
let burst = false;
let nextShot = 0;
let shellsLeft = 0;
let clip = 0;
let now = 0;
const burstQueue: number[] = [];

function fireOnce(vm: GunViewmodel): void {
  vm.fire(vm.anim.silenced);
  const room = (window as unknown as { __gunlab: { room: { impacts: GunImpacts } } }).__gunlab.room;
  // A hit on the floor ahead, around where the crosshair meets it (Source space: forward = +y here).
  const sx = (Math.random() - 0.5) * 16, sy = 150 + (Math.random() - 0.5) * 20;
  room.impacts.hit([sx, sy, 0], [0, 0, 1], Math.random() < 0.3 ? "metal" : "concrete", { from: [6, 18, 58], button: Math.random() < 0.2 });
}

function reload(vm: GunViewmodel, empty: boolean): void {
  const def = vm.def!;
  if (def.timing.shells) {
    vm.anim.shellStart();
    shellsLeft = Math.max(1, def.timing.ammo - clip);
    nextShell = def.timing.shells.start;
  } else vm.reload(def.timing.reload ?? 2, empty);
  clip = def.timing.ammo;
}
let nextShell = Infinity;

function liveStep(vm: GunViewmodel, dt: number): void {
  now += dt;
  const def = vm.def!;
  if (nextShell !== Infinity) {
    nextShell -= dt;
    if (nextShell <= 0) {
      if (shellsLeft > 0) {
        vm.anim.shellInsert();
        shellsLeft--;
        nextShell = def.timing.shells!.each;
      } else {
        vm.anim.shellEnd();
        nextShell = Infinity;
      }
    }
  }
  while (burstQueue.length && burstQueue[0] <= now) {
    burstQueue.shift();
    fireOnce(vm);
  }
  if (fireHeld && now >= nextShot && !vm.anim.busy) {
    if (burst && def.timing.burst) {
      for (let i = 0; i < def.timing.burst.n; i++) burstQueue.push(now + i * def.timing.burst.gap);
      nextShot = now + 0.5;
    } else {
      fireOnce(vm);
      nextShot = now + def.timing.cycle;
    }
    nextShell = Infinity;
    if (def.cls === "pistol") fireHeld = false;
  }
  vm.update(dt, walk ? walkFeel(now) : null);
}

function walkFeel(t: number): number[] {
  const b = Math.sin(t * 7.8);
  return [1, 0, 0, b * 0.25, 0, 1, 0, Math.cos(t * 3.9) * 0.35, 0, 0, 1, -Math.abs(b) * 0.4];
}

function installLive(vm: GunViewmodel, _hold: { fire: boolean }): void {
  addEventListener("mousedown", () => (fireHeld = true));
  addEventListener("mouseup", () => (fireHeld = false));
  addEventListener("keydown", (e) => {
    if (e.code === "KeyR") reload(vm, false);
    else if (e.code === "KeyF") vm.inspect();
    else if (e.code === "KeyE") vm.dryFire();
    else if (e.code === "KeyQ") vm.draw();
    else if (e.code === "KeyV" && !vm.anim.busy) vm.silencer(!vm.anim.silenced, 3.08);
    else if (e.code === "KeyB") {
      burst = !burst;
      vm.anim.modeToggle();
    } else if (e.code === "KeyW") walk = !walk;
    else if (e.code === "KeyH") prefs.update((p) => (p.viewmodel.hand = p.viewmodel.hand === "left" ? "right" : "left"));
    else if (/^Digit[1-8]$/.test(e.code)) {
      vm.setGun(GUNS[Number(e.code.slice(5)) - 1] ?? GUNS[0]);
      vm.draw();
    }
  });
  Object.assign((window as unknown as { __gunlab: object }).__gunlab, {
    hold: (on: boolean) => (fireHeld = on),
    setBurst: (on: boolean) => (burst = on),
    reloadShells: (n: number) => {
      clip = vm.def!.timing.ammo - n;
      reload(vm, false);
    },
  });
  info.textContent = "click: fire · R reload · F inspect · E dry fire · Q draw · B burst · W walk · H hand · 1-6 guns";
}

// ---------------------------------------------------------------------------------------------
// World (dropped) models: a slow turntable on a floor tile.

function worldModels(): void {
  const ids = (q.get("cells") ?? GUNS.map((g) => g.id).join(",")).split(",");
  cols = Number(q.get("cols") ?? Math.min(ids.length, 3));
  const mat = worldGunMaterial();
  cells = ids.map((id) => {
    const def = gunById(id) ?? GUNS[0];
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x2a3140);
    const root = new THREE.Group();
    root.rotation.x = -Math.PI / 2; // Source Z-up
    scene.add(root);
    const m = new THREE.Mesh(worldGunGeometry(def), mat);
    // &held=1: upright (as held), else lying on the floor like a dropped weapon.
    if (q.get("held") === "1") m.position.set(0, 0, 4);
    else restOnFloor(m, def, [0, 0, 0], 0);
    root.add(m);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 32), new THREE.MeshBasicMaterial({ color: 0x3b4456 }));
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    const cam = new THREE.PerspectiveCamera(30, 1, 1, 1000);
    const yaw0 = Number(q.get("yaw") ?? 35);
    let t = 0;
    return {
      label: `<b>${def.name}</b> · ${def.archetype}`,
      draw: (_x, _y, w, h, dt) => {
        t += dt;
        const len = def.cls === "pistol" ? 9 : def.cls === "smg" ? 16 : 26;
        const yaw = ((yaw0 + (q.get("spin") === "1" ? t * 30 : 0)) * Math.PI) / 180;
        const d = len * 2.1;
        cam.position.set(Math.sin(yaw) * d * 0.6, d * 1.1, Math.cos(yaw) * d * 0.6);
        cam.lookAt(def.cls === "pistol" ? 2.5 : def.cls === "smg" ? 0 : 6, 0, 0);
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
        renderer.render(scene, cam);
      },
    } satisfies Cell;
  });
  layout();
}

// ---------------------------------------------------------------------------------------------
// Third person: the bunny holding the gun.

async function thirdPerson(): Promise<void> {
  const { PlayerModel } = await import("../../player/model");
  const def = gunById(q.get("gun")) ?? GUNS[0];
  const views = (q.get("cells") ?? "front,side,back").split(",");
  cols = Number(q.get("cols") ?? views.length);
  cells = views.map((v) => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x2a3140);
    const m = new PlayerModel({ style: "solid", model: "bunny", loadout });
    m.setGun(def.id);
    m.setGunSilencer(q.get("silenced") === "1");
    scene.add(m.root);
    m.setState({ position: [0, 0, 0], yaw: -90, pitch: 0, crouched: false, grounded: true });
    m.snap();
    const cam = new THREE.PerspectiveCamera(30, 1, 1, 1000);
    const yaw = v === "side" ? -Math.PI / 2 : v === "back" ? Math.PI : v === "hand" ? -Math.PI * 0.35 : 0;
    const close = v === "hand";
    return {
      label: `<b>${def.name}</b> · ${v}`,
      draw: (_x, _y, w, h, dt) => {
        m.update(dt);
        const d = close ? 55 : 150;
        cam.position.set(Math.sin(yaw) * d, close ? 40 : 50, Math.cos(yaw) * d);
        cam.lookAt(0, close ? 30 : 36, 0);
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
        renderer.render(scene, cam);
      },
    } satisfies Cell;
  });
  layout();
}

if (mode === "world") worldModels();
else if (mode === "tp") await thirdPerson();
else firstPerson();
addEventListener("resize", layout);
requestAnimationFrame(frame);
