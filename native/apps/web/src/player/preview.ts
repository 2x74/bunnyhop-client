import { normalizeGlowColor, DEFAULT_PLAYER_GLOW } from "./glow-config";
// Dev preview for the player models: /player.html (vite dev server only).
//   ?model=bunny|runner|ct|t|<skin>|side (side = ?side=bunny,ct models next to each other)   ?style=solid|ghost|both
//   ?rowx=<units> (rows side by side)   ?outfits=outfit-cream,outfit-neon,... (one bunny column per colourway)   ?procedural (bunny without CS:S animations)
//   ?hats=none,crown1,hat-founder-crown,... (one bunny column per headwear: a hat id, crown1-3, or none; ?crown=1 adds the
//   rank crown under every hat, to check the hat wins)
//   ?poses=neutral,run,walk,hop,air,strafe,crouch,crouchwalk,crouchjump,look,turn   ?t=<seconds> (freeze at a time)
//   ?yaw=<deg> model facing (default 3/4 view)   ?cam=x,y,z&look=x,y,z&fov=deg close-ups   ?still=1 animated cosmetics held still   ?bench=N (time update() for N CS:S models)   ?map=<name> (content source)
//   ?gun=<id> every bunny holds that gun (a core weapon id: glock, usp, fiveseven, m3, xm1014, p90, ak47, awp)
//   ?guns=<id,id,...> one bunny column per gun (poses cycled)   ?pitch=<deg> overrides the poses' view pitch
//   ?body=feminine Model B for every column   ?potato=1 cosmetic motion held still (Potato)
//   window.preview.gunEvent(kind, seconds?, column?) plays "shot" / "reload" / "shell" (PlayerPose.gunShot, gunReload)
// Drag to orbit, wheel to zoom. window.preview exposes the scene for screenshots / tests.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PlayerModel, type PlayerModelKind, type PlayerPose } from "./model";
import { GHOST_COLORS } from "./colors";
import { discoverPlayerContent, sha256Hex } from "../content";
import { hasSkin, loadAnimRig, loadCsAsset, SKIN_LABEL, type CsSkin } from "./studio/loader";
import { cosmetic } from "../progression";
import { loadoutFor } from "../loadout";
import { resolveSkin } from "./model";
import { gunById } from "../viewmodel/guns/index";
import { setCosmeticsStill } from "../viewmodel/finishes/shader";

const q = new URLSearchParams(location.search);
const canvas = document.getElementById("c") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x151922);
const camera = new THREE.PerspectiveCamera(32, 1, 1, 5000);
const controls = new OrbitControls(camera, canvas);

// Floor: soft grid on a dark plane (Source z = 0 -> three y = 0).
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
  new THREE.ShaderMaterial({
    vertexShader: `varying vec3 w; void main(){ w = (modelMatrix*vec4(position,1.)).xyz; gl_Position = projectionMatrix*viewMatrix*vec4(w,1.); }`,
    fragmentShader: `varying vec3 w; void main(){ vec2 g = abs(fract(w.xz/32.0-0.5)-0.5)/fwidth(w.xz/32.0); float l = 1.0-min(min(g.x,g.y),1.0);
      float fade = exp(-length(w.xz)/620.0); vec3 c = mix(vec3(0.075,0.085,0.11), vec3(0.2,0.22,0.28), l*fade); gl_FragColor = vec4(c,1.0);
      #include <colorspace_fragment>
    }`,
  }),
);
scene.add(floor);

type Driver = (t: number) => PlayerPose;
const baseYaw = Number(q.get("yaw") ?? -60);
const T = Number(q.get("t") ?? NaN);
const D2R = Math.PI / 180;
const dir = (yaw: number, s: number): [number, number] => [Math.cos(yaw * D2R) * s, Math.sin(yaw * D2R) * s];
/** CS:S bhop: jump impulse sqrt(2 * 800 * 57), gravity 800, one ground tick per hop. */
const JUMP = 301.993;
const GRAV = 800;
const HOP = (2 * JUMP) / GRAV;
const hop = (t: number) => {
  const ph = ((t % HOP) + HOP) % HOP;
  return { z: JUMP * ph - 0.5 * GRAV * ph * ph, vz: JUMP - GRAV * ph, grounded: ph < 0.01 };
};

const DRIVERS: Record<string, [string, (x: number) => Driver]> = {
  neutral: ["Idle", (x) => () => ({ position: [x, 0, 0], velocity: [0, 0, 0], yaw: baseYaw, pitch: 0, crouched: false, grounded: true })],
  walk: ["Walk", (x) => () => ({ position: [x, 0, 0], velocity: [...dir(baseYaw, 130), 0], yaw: baseYaw, pitch: 4, crouched: false, grounded: true })],
  run: ["Run", (x) => () => ({ position: [x, 0, 0], velocity: [...dir(baseYaw, 250), 0], yaw: baseYaw, pitch: 4, crouched: false, grounded: true, forwardmove: 450 })],
  hop: [
    "Bhop 400 u/s",
    (x) => (t) => {
      const h = hop(t - 0.3);
      return { position: [x, 0, Math.max(0, h.z)], velocity: [...dir(baseYaw, 400), h.vz], yaw: baseYaw + 25 * Math.sin(t * Math.PI * (2 / HOP)), pitch: 8, crouched: false, grounded: h.grounded || t < 0.3, sidemove: Math.sin(t * Math.PI * (2 / HOP)) > 0 ? -450 : 450 };
    },
  ],
  runleft: ["Run left (A)", (x) => () => ({ position: [x, 0, 0], velocity: [...dir(baseYaw + 90, 250), 0], yaw: baseYaw, pitch: 4, crouched: false, grounded: true, sidemove: -450 })],
  runback: ["Run back (S)", (x) => () => ({ position: [x, 0, 0], velocity: [...dir(baseYaw + 180, 250), 0], yaw: baseYaw, pitch: 4, crouched: false, grounded: true, forwardmove: -450 })],
  air: ["Air", (x) => () => ({ position: [x, 0, 30], velocity: [...dir(baseYaw, 420), 150], yaw: baseYaw, pitch: 0, crouched: false, grounded: false })],
  strafe: [
    "Air strafe (turning left)",
    // Hopping at 700 u/s while the view swings left at its fastest (~300 deg/s) when t hits the freeze time:
    // the feet lag the eyes (mp_feetyawrate) so the torso twists into the turn, like a CS:S strafe.
    (x) => (t) => {
      const h = hop(t - 0.2);
      const w = (t - (Number.isFinite(T) ? T : 0)) * 5;
      return { position: [x, 0, Math.max(0, h.z)], velocity: [...dir(baseYaw + 60 * Math.sin(w), 700), h.vz], yaw: baseYaw + 60 * Math.sin(w), pitch: 4, crouched: false, grounded: h.grounded || t < 0.2, sidemove: Math.cos(w) > 0 ? -450 : 450 };
    },
  ],
  crouch: ["Crouch", (x) => () => ({ position: [x, 0, 0], velocity: [0, 0, 0], yaw: baseYaw, pitch: 10, crouched: true, grounded: true })],
  crouchwalk: ["Crouch walk", (x) => () => ({ position: [x, 0, 0], velocity: [...dir(baseYaw + 40, 85), 0], yaw: baseYaw, pitch: 10, crouched: true, grounded: true })],
  crouchjump: ["Crouch jump", (x) => () => ({ position: [x, 0, 30], velocity: [...dir(baseYaw, 400), 60], yaw: baseYaw, pitch: 0, crouched: true, grounded: false })],
  look: ["Look up/left", (x) => () => ({ position: [x, 0, 0], velocity: [0, 0, 0], yaw: baseYaw + 45, pitch: -35, crouched: false, grounded: true })],
  turn: ["Look right 80°", (x) => () => ({ position: [x, 0, 0], velocity: [0, 0, 0], yaw: baseYaw - 80, pitch: 0, crouched: false, grounded: true })],
};
const poseNames = (q.get("poses") ?? "neutral,run,hop,strafe,crouch").split(",").filter((p) => DRIVERS[p]);
const style = q.get("style") ?? "solid";
const modelParam = q.get("model") ?? "bunny";
const ghostColors = [GHOST_COLORS.pb, GHOST_COLORS.wr, GHOST_COLORS.custom, GHOST_COLORS.pb];

interface Entry {
  model: PlayerModel;
  drive: Driver;
  label: HTMLSpanElement;
}
const entries: Entry[] = [];
const spacing = Number(q.get("spacing") ?? 72);
const rows: { style: string; model: string }[] = [];
for (const s of style === "both" ? ["solid", "ghost"] : [style]) {
  if (modelParam === "side") for (const m of (q.get("side") ?? "bunny,ct").split(",")) rows.push({ style: s, model: m });
  else rows.push({ style: s, model: modelParam });
}

/** Columns: one per pose, or with ?models=<skin,skin,...> one per model (poses cycled). */
const modelList = q.get("models")?.split(",").filter(Boolean) ?? null;
const outfitList = q.get("outfits")?.split(",").filter(Boolean) ?? null;
const bodyList = q.get("bodies")?.split(",").filter(b => b === "classic" || b === "feminine") ?? null;
const hatList = q.get("hats")?.split(",").filter(Boolean) ?? null;
const crownQ = Number(q.get("crown")) as 1 | 2 | 3;
const headwear = (w: string) => {
  const crown = /^crown[123]$/.test(w) ? (Number(w.slice(5)) as 1 | 2 | 3) : [1, 2, 3].includes(crownQ) ? crownQ : null;
  return loadoutFor({ hat: w }, crown);
};
const gunList = q.get("guns")?.split(",").filter(Boolean) ?? null;
const columns: { pose: string; model?: string; outfit?: string; hat?: string; body?: string; gun?: string; label: string }[] = gunList
  ? gunList.map((g, i) => ({ pose: poseNames[i % poseNames.length], model: "bunny", gun: g, body: q.get("body") ?? undefined, label: gunById(g)?.name ?? g }))
  : bodyList
  ? bodyList.map((body, i) => ({ pose: poseNames[i % poseNames.length], model: "bunny", body, label: body === "feminine" ? "Model B" : "Model A" }))
  : hatList
  ? hatList.map((w, i) => ({ pose: poseNames[i % poseNames.length], model: "bunny", hat: w, label: cosmetic(w)?.name ?? w }))
  : outfitList
  ? outfitList.map((o, i) => ({ pose: poseNames[i % poseNames.length], model: "bunny", outfit: o, body: q.get("body") === "feminine" ? "feminine" : undefined, label: o === "outfit-plush" ? "Plush Bunny" : o === "outfit-bune" ? "Bun-E" : cosmetic(o)?.name ?? o }))
  : modelList
    ? modelList.map((m, i) => ({ pose: poseNames[i % poseNames.length], model: m, label: SKIN_LABEL[m as CsSkin] ?? m }))
    : poseNames.map((p) => ({ pose: p, label: DRIVERS[p][0] }));

async function setup(): Promise<void> {
  if (q.has("world")) {
    const [{ Core }, { buildWorld }, { default: wasmUrl }] = await Promise.all([import("../core"), import("../render"), import("../wasm/bunnyhop_core.wasm?url")]);
    const core = await Core.create(new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer()));
    const bsp = new Uint8Array(await (await fetch(`/${q.get("map") ?? "bhop_eazy"}.bsp`)).arrayBuffer());
    core.loadMap(bsp);
    const world = await buildWorld(core, renderer, { bsp });
    const spawn = core.state().position;
    world.root.position.set(-spawn[0] - 180, -spawn[2] + 1, spawn[1]);
    scene.add(world.root);
    scene.remove(floor);
  }
  // Player content comes from a map manifest (any map's carries it).
  const map = q.get("map") ?? "bhop_eazy";
  try {
    // ?procedural: no hosted content at all (the bunny's fallback animation; CS:S models fall back to the bunny).
    if (q.has("procedural")) throw new Error("content disabled (?procedural)");
    const bsp = new Uint8Array(await (await fetch(`/${map}.bsp`)).arrayBuffer());
    if (!(await discoverPlayerContent(await sha256Hex(bsp)))) console.warn("preview: no player content in the manifest (run tools/content/extract.ts)");
  } catch (e) {
    console.warn("preview: content discovery failed", e);
  }
  // Wait for the CS:S models so screenshots never catch the runner fallback.
  const wanted = rows.flatMap((r) => columns.map((c) => resolveSkin({ model: (c.model ?? r.model) as PlayerModelKind, style: r.style as "solid" | "ghost" })));
  const skins = new Set(wanted.filter((s) => s !== "runner" && hasSkin(s)));
  await Promise.all([...skins].map((s) => loadCsAsset(s).catch(() => null)));
  if (!q.has("procedural") && wanted.some((s) => s === "bunny" || !hasSkin(s))) await loadAnimRig().catch(() => null);

  rows.forEach((row, r) => {
    columns.forEach((col, i) => {
      const name = col.pose;
      const x = (i - (columns.length - 1) / 2) * spacing;
      const ghost = row.style === "ghost";
      const model = new PlayerModel({ playerGlow: normalizeGlowColor(q.get("glow")) ? { ...DEFAULT_PLAYER_GLOW, enabled: true, color: normalizeGlowColor(q.get("glow"))! } : null, previewGlow: true, style: ghost ? "ghost" : "solid", color: ghost ? ghostColors[i % 4] : undefined, model: (col.model ?? row.model) as PlayerModelKind, outfit: col.outfit ?? q.get("outfit") ?? undefined, ...(col.body ? { loadout: loadoutFor({ body: col.body === "feminine" ? "body-b" : "body-a" }), knife: null, outfit: col.outfit ?? q.get("outfit") ?? "outfit-cream" } : col.hat ? { loadout: headwear(col.hat) } : {}) });
      const gun = col.gun ?? q.get("gun");
      if (gun) model.setGun(gun);
      model.setOpacity(0.7);
      model.setNearFade(0, 0);
      model.setRenderOrder(20 + (r * columns.length + i) * 2);
      const label = document.createElement("span");
      label.textContent = col.label;
      if (r === 0) document.getElementById("labels")!.append(label);
      const d = DRIVERS[name][1](x);
      // Rows stand behind each other, or side by side with ?rowx=<units> (side-by-side comparisons).
      const rowx = Number(q.get("rowx") ?? 0);
      const back = rowx ? 0 : r * 70;
      const right = r * rowx;
      const pitch = q.has("pitch") ? Number(q.get("pitch")) : null;
      const drive: Driver = (t) => {
        const p = d(t);
        return { ...p, pitch: pitch ?? p.pitch, position: [p.position[0] + right, p.position[1] + back, p.position[2]] };
      };
      entries.push({ model, drive, label });
      scene.add(model.root);
    });
  });

  const span = columns.length * spacing;
  camera.position.set(0, 50, span * 1.15 + 90 + rows.length * 30);
  controls.target.set(0, 34, -((rows.length - 1) * 35));
  // ?cam=x,y,z&look=x,y,z (three.js units: y up) for close-ups; ?fov=deg.
  const v3 = (k: string) => q.get(k)?.split(",").map(Number) as [number, number, number] | undefined;
  const cam = v3("cam"), look = v3("look");
  if (cam) camera.position.set(...cam);
  if (look) controls.target.set(...look);
  if (q.has("fov")) (camera.fov = Number(q.get("fov"))), camera.updateProjectionMatrix();
  controls.update();
  if (Number.isFinite(T)) while (simT < T) step(DT);
  requestAnimationFrame(frame);
  (window as unknown as { previewReady: boolean }).previewReady = true;
  if (q.has("bench")) bench(Number(q.get("bench")) || 20);
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

let simT = 0;
const DT = 1 / 120;
/** Gun events waiting for the next step, per entry (window.preview.gunEvent). */
const gunEvents = new Map<Entry, Partial<PlayerPose>>();
function step(dt: number) {
  simT += dt;
  for (const e of entries) {
    const ev = gunEvents.get(e);
    e.model.setState(ev ? { ...e.drive(simT), ...ev } : e.drive(simT));
    gunEvents.delete(e);
    e.model.update(dt);
  }
}

/** A gun event on the next step: a shot, a reload of `seconds`, or a shell going in (one column, or all). */
function gunEvent(kind: "shot" | "reload" | "shell", seconds = 2, column?: number): void {
  entries.forEach((e, i) => {
    if (column !== undefined && column !== i) return;
    const ev = gunEvents.get(e) ?? {};
    if (kind === "shot") ev.gunShot = true;
    else ev.gunReload = { seconds, shell: kind === "shell" };
    gunEvents.set(e, ev);
  });
}
if (q.get("potato") === "1") setCosmeticsStill(true);

/** Steps the simulation to time t (seconds) at 1/120 s (for frame sheets). */
function seek(t: number): void {
  if (t < simT) {
    simT = 0;
    for (const e of entries) e.model.snap();
  }
  while (simT + DT <= t + 1e-9) step(DT);
}

const v = new THREE.Vector3();
let last = performance.now();
let paused = Number.isFinite(T);
function frame(now: number) {
  const dt = (now - last) / 1000;
  last = now;
  if (!paused) step(Math.min(dt, 0.1));
  controls.update();
  renderer.render(scene, camera);
  for (const e of entries) {
    v.copy(e.model.root.position);
    v.y = -6;
    v.project(camera);
    e.label.style.left = `${((v.x + 1) / 2) * innerWidth}px`;
    e.label.style.top = `${((1 - v.y) / 2) * innerHeight + 6}px`;
  }
  requestAnimationFrame(frame);
}

function bench(n: number): void {
  const skin = resolveSkin({ model: (modelParam === "side" ? "ct" : modelParam) as PlayerModelKind });
  const models = Array.from({ length: n }, (_, i) => {
    const m = new PlayerModel({ style: "solid", model: skin as PlayerModelKind });
    m.root.position.x = i * 40;
    return m;
  });
  const N = 600;
  const drive = DRIVERS.hop[1](0);
  // Warm up (JIT, animation decode).
  for (let i = 0; i < 60; i++) for (const m of models) (m.setState(drive(i / 120)), m.update(1 / 120));
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < models.length; k++) {
      const p = drive(i / 144 + k * 0.05);
      m_yaw(p, i, k);
      models[k].setState(p);
      models[k].update(1 / 144);
    }
  }
  const ms = (performance.now() - t0) / N;
  const info = `${n} × ${models[0].kind}: anim state + bone setup + matrices ${ms.toFixed(3)} ms/frame (${((ms / n) * 1000).toFixed(1)} µs/model)`;
  document.getElementById("info")!.textContent = info;
  console.info(info);
  Object.assign(window, { benchMs: ms, benchModels: models });
}
function m_yaw(p: PlayerPose, i: number, k: number): void {
  p.yaw += Math.sin(i * 0.05 + k) * 30;
}

Object.assign(window, {
  preview: {
    camera,
    controls,
    scene,
    renderer,
    entries,
    seek,
    step,
    gunEvent,
    pause: (p: boolean) => (paused = p),
    get t() {
      return simT;
    },
  },
});
if (outfitList?.some(o => o === "outfit-plush" || o === "outfit-bune")) {
  const ui = document.createElement("div");
  ui.id = "concept-controls";
  ui.innerHTML = `<style>
  #concept-controls { position:fixed;left:28px;top:24px; font:14px system-ui; color:#eee5d7; background:#151922e8;padding:16px 20px;border:1px solid #ffffff20;border-radius:12px; }
  #concept-controls h1 {font-size:24px; margin:4px 0 8px;letter-spacing:-.6px}
  #concept-controls small {color:#dfb968;letter-spacing:2px;text-transform:uppercase;font-size:10px}
  #concept-controls p {color:#a7acb6;margin:0 0 16px;font-size:12px}
  #concept-controls button {border:1px solid #ffffff25;background:#151922db;color:#eee5d7;border-radius:7px;padding:8px 12px;margin-right:6px;cursor:pointer}
  #concept-controls button:hover,#concept-controls button[aria-pressed=true] {border-color:#dfb968;color:#dfb968}
  #labels span {color:#eee5d7;background:#151922bb;padding:6px 12px;border-radius:7px;font-weight:600}
  </style><small>bunnyhop.lol · 3D prototypes</small><h1>Plush Bunny & Bun-E</h1><p>Drag to orbit · Scroll to zoom · Same game rig and renderer</p><div id="pose-buttons"></div>`;
  document.body.append(ui);
  const buttons = ui.querySelector("#pose-buttons")!;
  for(const [id,name] of [["neutral","Idle"],["run","Run"],["hop","Bhop"],["crouch","Crouch"]]) {
    const btn=document.createElement("button"); btn.textContent=name; btn.setAttribute("aria-pressed",String(id==="neutral"));
    btn.onclick=()=> { entries.forEach((e,i)=> { e.drive=DRIVERS[id][1]((i-(entries.length-1)/2)*spacing); e.model.snap(); }); paused=false; buttons.querySelectorAll("button").forEach(b=>b.setAttribute("aria-pressed",String(b===btn))); };
    buttons.append(btn);
  }
  const world=document.createElement("button");world.textContent=q.has("world")?"Studio":"On map";
  world.onclick=()=>{const next=new URL(location.href);if(q.has("world"))next.searchParams.delete("world");else next.searchParams.set("world","1");location.href=next.href;};buttons.append(world);
}
void setup().catch(e=>{ document.getElementById("info")!.textContent=String(e); console.error(e); });
