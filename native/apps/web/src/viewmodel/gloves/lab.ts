// DEV ONLY glove lab (glovelab.html, not a build input): glove styles (loadout.ts GLOVE_STYLE, gloves/fp.ts, tp.ts) in
// first person (the real Viewmodel), as a close-up turntable of the open hand, around the fist, and on the bunny.
//
//   ?mode=fp&cells=glove-moto-boom:karrotbit:idle,glove-sport-vice:carrot:inspect:1.2     glove:knife:action[:t]
//   ?mode=open&glove=glove-paws-snow&cells=0,90,180,270                                     bind pose, yaw[/pitch]
//   ?mode=hand&glove=glove-driver-tan&knife=carrot&cells=0,90,180                          around the posed fist
//   ?mode=tp&cells=glove-moto-boom:karrotbit:full,glove-moto-boom:karrotbit:hand           glove:knife:shot
//   &cs=1 (v_knife_t's sequences from the dev content cache) · &cols=3 · &labels=0 · &outfit=outfit-midnight · &dist=12 · fp: &zoom=1.6&cx=0.7&cy=0.7 (crop on the hand)

import * as THREE from "three";
import { DEFAULT_LOADOUT, gloveStyle, type CosmeticLoadout } from "../../loadout";
import { cosmetic } from "../../progression";
import { colourway, paletteOf } from "../../player/bunny/palettes";
import { rig as bunnyRig } from "../../player/bunny/rig";
import { playerUniforms, solidMaterial } from "../../player/materials";
import { PlayerModel } from "../../player/model";
import { prefs } from "../../ui/settings";
import { VIEWMODEL_POS } from "../defaults";
import { applyLoadoutUniforms } from "../finishes/shader";
import { CARROT_HOLD, clearGripCache } from "../knives/hold";
import { KNIVES, knifeById } from "../knives/index";
import type { KnifeDef } from "../knives/types";
import { viewmodelGeometry } from "../mesh";
import type { VmAction } from "../procedural";
import { vmRig } from "../rig";
import { Viewmodel, type ViewmodelInput } from "../viewmodel";

const q = new URLSearchParams(location.search);
const canvas = document.getElementById("c") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setClearColor(0x000000, 0);
const labels = document.getElementById("labels")!;
const info = document.getElementById("info")!;
const mode = q.get("mode") ?? "fp";
const showLabels = q.get("labels") !== "0";
const outfit = q.get("outfit") ?? "outfit-cream";
const knifeOf = (id: string | null | undefined): KnifeDef => knifeById(id) ?? KNIVES[0];
const loadoutOf = (glove: string, knife: KnifeDef): CosmeticLoadout => ({ ...DEFAULT_LOADOUT, knife: knife.cosmeticId, glove });
const gname = (id: string) => cosmetic(id)?.name ?? id;

interface Cell {
  label: string;
  draw(x: number, y: number, w: number, h: number): void;
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

function frame(): void {
  const W = innerWidth, H = innerHeight;
  renderer.setSize(W, H, false);
  const rows = Math.ceil(cells.length / cols);
  const cw = Math.floor(W / cols), ch = Math.floor(H / rows);
  renderer.setScissorTest(true);
  renderer.setViewport(0, 0, W, H);
  renderer.setScissor(0, 0, W, H);
  renderer.clear();
  cells.forEach((c, i) => {
    const x = (i % cols) * cw, y = H - (Math.floor(i / cols) + 1) * ch;
    renderer.setViewport(x, y, cw, ch);
    renderer.setScissor(x, y, cw, ch);
    c.draw(x, y, cw, ch);
  });
}

const specs = (dflt: string) => (q.get("cells") ?? dflt).split(",");

// ---------------------------------------------------------------------------------------------

async function firstPerson(): Promise<void> {
  // &cs=1: v_knife_t's real sequences (hosted content via the dev content cache), like the game.
  if (q.get("cs") === "1") {
    const { discoverPlayerContent, sha256Hex } = await import("../../content");
    const bsp = new Uint8Array(await (await fetch(`/${q.get("map") ?? "bhop_eazy"}.bsp`)).arrayBuffer());
    await discoverPlayerContent(await sha256Hex(bsp));
  }
  // Dev tuning of the carrot fist's thumb (knives/hold.ts CARROT_HOLD): &thumb=c1,c2,c3[,spread].
  const th = q.get("thumb")?.split(",").map(Number);
  if (th) Object.assign(CARROT_HOLD.thumb, { c: [th[0], th[1], th[2]], spread: th[3] ?? 0 });
  if (th) clearGripCache();
  const vm = new Viewmodel();
  if (q.get("cs") === "1") {
    const t0 = performance.now();
    while (vm.animSource !== "cs" && performance.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 100));
  }
  const world = new THREE.PerspectiveCamera(74, 1, 1, 1000);
  const still: ViewmodelInput = { velocity: [0, 0, 0], grounded: true, viewOffsetZ: 64, sidemove: 0, yaw: 0, pitch: 0, landed: 0 };
  const held = { primary: false, secondary: false };
  const pal = paletteOf(colourway(outfit));
  const zoom = Number(q.get("zoom") ?? 1), cx = Number(q.get("cx") ?? 0.5), cy = Number(q.get("cy") ?? 0.5);
  const sp = specs("glove-sport-carrot:carrot:idle,glove-sport-carrot:karrotbit:idle");
  cols = Number(q.get("cols") ?? Math.min(sp.length, 3));
  cells = sp.map((s) => {
    const [glove, kid, act = "idle", t = "0", hand = "right"] = s.split(":");
    const k = knifeOf(kid);
    return {
      label: `<b>${gname(glove)}</b> · ${k.name} · ${act}${Number(t) ? ` ${t} s` : ""}`,
      draw(_x, _y, w, h) {
        vm.uniforms.uPalette.value.forEach((c, i) => c.set(pal[i]));
        vm.setKnife(k);
        vm.setLoadout(loadoutOf(glove, k));
        prefs.get().viewmodel.hand = hand === "left" ? "left" : "right";
        vm.seek(act as VmAction | "inspect", Number(t));
        world.aspect = w / h;
        world.updateProjectionMatrix();
        if (zoom !== 1) vm.camera.setViewOffset(w, h, cx * w - w / (2 * zoom), cy * h - h / (2 * zoom), w / zoom, h / zoom);
        vm.update(0, still, held);
        vm.render(renderer, world);
      },
    };
  });
  if (mode === "hand") {
    const glove = q.get("glove") ?? "glove-sport-carrot";
    const k = knifeOf(q.get("knife"));
    const orbit = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
    const r = vmRig();
    const hb = r.bone("Right_Hand"), kb = r.bone("Knife_Handle");
    const dist = Number(q.get("dist") ?? 15);
    const v = specs("20,80,140,200,260,320");
    cols = Number(q.get("cols") ?? 3);
    cells = v.map((s, i) => {
      const [yaw, pitch = "15"] = s.split("/");
      return {
        label: i === 0 ? `<b>${gname(glove)}</b> · ${k.name} · fist ${yaw}°` : `${yaw}°/${pitch}°`,
        draw(_x, _y, w, h) {
          vm.uniforms.uPalette.value.forEach((c, j) => c.set(pal[j]));
          vm.setKnife(k);
          vm.setLoadout(loadoutOf(glove, k));
          prefs.get().viewmodel.hand = "right";
          vm.seek((q.get("act") ?? "idle") as VmAction | "inspect", Number(q.get("t") ?? 0));
          world.aspect = w / h;
          world.updateProjectionMatrix();
          vm.update(0, still, held);
          vm.render(renderer, world);
          renderer.clear();
          const bm = vm.mesh.skeleton.boneMatrices!;
          const at = (b: number) => new THREE.Vector3(r.bind[b * 12 + 3], r.bind[b * 12 + 7], r.bind[b * 12 + 11]).applyMatrix4(new THREE.Matrix4().fromArray(bm, b * 16));
          const p = at(hb).lerp(at(kb), 0.6).applyMatrix4(vm.mesh.matrixWorld);
          const a = (Number(yaw) * Math.PI) / 180, e = (Number(pitch) * Math.PI) / 180;
          orbit.aspect = w / h;
          orbit.updateProjectionMatrix();
          orbit.position.set(p.x + Math.sin(a) * Math.cos(e) * dist, p.y + Math.sin(e) * dist, p.z + Math.cos(a) * Math.cos(e) * dist);
          orbit.lookAt(p);
          renderer.render(vm.scene, orbit);
        },
      };
    });
  }
}

/** The open right hand in the bind pose (fingers straight), orbiting: every panel, pad and seam. */
function openHand(): void {
  const glove = q.get("glove") ?? "glove-sport-carrot";
  const r = vmRig();
  const geo = viewmodelGeometry(knifeOf("carrot"), gloveStyle(glove).style);
  const n = r.names.length;
  const bones = Array.from({ length: n }, () => new THREE.Bone());
  const skeleton = new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4()));
  skeleton.update = () => {
    if (skeleton.boneTexture) skeleton.boneTexture.needsUpdate = true;
  };
  const u = playerUniforms();
  const cw = colourway(outfit);
  u.uPalette.value.forEach((c, i) => c.set(paletteOf(cw)[i]));
  u.uAccent.value.set(cw.accent);
  const look = applyLoadoutUniforms(u, loadoutOf(glove, knifeOf("carrot")));
  const mesh = new THREE.SkinnedMesh(geo, solidMaterial(u, look));
  mesh.bindMode = THREE.DetachedBindMode;
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.frustumCulled = false;
  // The right hand only: the left arm and the knife collapse to a point.
  const ident = new THREE.Matrix4(), zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < n; i++) (/left|\bL_|knife|bfly/i.test(r.names[i]) ? zero : ident).toArray(skeleton.boneMatrices!, i * 16);
  // Source (x fwd, y left, z up) -> three (y up): x -> x, y -> -z, z -> y.
  const holder = new THREE.Group();
  holder.rotation.x = -Math.PI / 2;
  holder.add(mesh);
  const scene = new THREE.Scene();
  scene.add(holder);
  scene.updateMatrixWorld(true);
  const w0 = r.at("Right_Hand"), m0 = r.at("Right_Middle02");
  const c = new THREE.Vector3((w0[0] + m0[0]) / 2, (w0[1] + m0[1]) / 2, (w0[2] + m0[2]) / 2).applyMatrix4(holder.matrixWorld);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 500);
  const dist = Number(q.get("dist") ?? 14);
  const sp = specs("0,60,120,180,240,300");
  cols = Number(q.get("cols") ?? Math.min(3, sp.length));
  cells = sp.map((s, i) => {
    const [yaw, pitch = "10"] = s.split("/");
    return {
      label: i === 0 ? `<b>${gname(glove)}</b> · open hand · ${yaw}°` : `${yaw}°/${pitch}°`,
      draw(_x, _y, w, h) {
        const a = (Number(yaw) * Math.PI) / 180, p = (Number(pitch) * Math.PI) / 180;
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
        cam.position.set(c.x + Math.cos(a) * Math.cos(p) * dist, c.y + Math.sin(p) * dist, c.z + Math.sin(a) * Math.cos(p) * dist);
        cam.lookAt(c);
        renderer.render(scene, cam);
      },
    };
  });
}

/** The bunny with a glove + knife (procedural idle). Shots: full, hand, side, back, low. */
async function thirdPerson(): Promise<void> {
  const cs = q.get("cs") === "1";
  if (cs) {
    const { discoverPlayerContent, sha256Hex } = await import("../../content");
    const bsp = new Uint8Array(await (await fetch(`/${q.get("map") ?? "bhop_eazy"}.bsp`)).arrayBuffer());
    await discoverPlayerContent(await sha256Hex(bsp));
  }
  // Dev tuning of the third-person knife placement (knives/types.ts TpSpec, every knife in the cells):
  // &tpo=x,y,z &tpz=x,y,z &tpy=x,y,z &tps=scale (multiplies the knife's own scale).
  const v3 = (k: string) => q.get(k)?.split(",").map(Number) as [number, number, number] | undefined;
  if (q.has("tpo") || q.has("tpz") || q.has("tpy") || q.has("tps"))
    for (const k of KNIVES) {
      const t = k.tp ?? { o: [2.05, -1.45, 3.1], z: [0.53, 0.1, -0.84], y: [0, 1, 0], s: 1.3 };
      k.tp = { o: v3("tpo") ?? t.o, z: v3("tpz") ?? t.z, y: v3("tpy") ?? t.y, s: t.s * Number(q.get("tps") ?? 1) };
    }
  const scene = new THREE.Scene();
  const models = new Map<string, PlayerModel>();
  const yaw = Number(q.get("yaw") ?? -35);
  const T = Number(q.get("t") ?? 1.2);
  const modelFor = (glove: string, k: KnifeDef) => {
    const id = `${glove}|${k.id}`;
    let m = models.get(id);
    if (!m) {
      m = new PlayerModel({ style: "solid", knife: k, model: "bunny", outfit, loadout: loadoutOf(glove, k) });
      m.setState({ position: [0, 0, 0], velocity: [0, 0, 0], yaw, pitch: 0, crouched: false, grounded: true });
      m.snap();
      m.update(1 / 30);
      models.set(id, m);
      scene.add(m.root);
    }
    return m;
  };
  const cam = new THREE.PerspectiveCamera(30, 1, 1, 2000);
  const br = bunnyRig();
  const hb = br.bone("R_Hand");
  const handAt = (root: THREE.Object3D) => {
    let mesh: THREE.SkinnedMesh | null = null;
    root.traverse((o) => {
      if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh && o.visible) mesh = o as THREE.SkinnedMesh;
    });
    const m = mesh as THREE.SkinnedMesh | null;
    if (!m) return new THREE.Vector3(0, 45, 0);
    const bm = new THREE.Matrix4().fromArray(m.skeleton.boneMatrices!, hb * 16);
    return new THREE.Vector3(br.bind[hb * 12 + 3], br.bind[hb * 12 + 7], br.bind[hb * 12 + 11]).applyMatrix4(bm).applyMatrix4(m.matrixWorld);
  };
  const fy = (yaw * Math.PI) / 180;
  const fwd = new THREE.Vector3(Math.cos(fy), 0, -Math.sin(fy));
  const right = new THREE.Vector3(Math.sin(fy), 0, Math.cos(fy));
  const up = new THREE.Vector3(0, 1, 0);
  const at = (f: number, r: number, u: number, base: THREE.Vector3) => base.clone().addScaledVector(fwd, f).addScaledVector(right, r).addScaledVector(up, u);
  const body = new THREE.Vector3(0, 38, 0);
  const sp = specs("glove-sport-carrot:carrot:full,glove-sport-carrot:carrot:hand");
  cols = Number(q.get("cols") ?? Math.min(sp.length, 4));
  // Build every model, wait for the CS:S animations (&cs=1), then play T seconds of idle.
  const all = sp.map((s) => s.split(":")).map(([g, kid]) => modelFor(g, knifeOf(kid)));
  if (cs) {
    const t0 = performance.now();
    while (all.some((m) => m.bunnyModel?.animSource !== "cs") && performance.now() - t0 < 20000) {
      for (const m of all) m.update(1 / 30);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  for (const m of new Set(all)) {
    m.snap();
    for (let i = 0; i < Math.round(T * 30); i++) m.update(1 / 30);
  }
  cells = sp.map((s) => {
    const [glove, kid, shot = "full"] = s.split(":");
    const k = knifeOf(kid);
    return {
      label: `<b>${gname(glove)}</b> · ${k.name} · ${shot}`,
      draw(_x, _y, w, h) {
        for (const m of models.values()) m.root.visible = false;
        const m = modelFor(glove, k);
        m.root.visible = true;
        scene.updateMatrixWorld(true);
        const hand = handAt(m.root);
        const shots: Record<string, { at: THREE.Vector3; from: THREE.Vector3; fov: number }> = {
          full: { at: body, from: at(120, 60, 18, body), fov: 30 },
          far: { at: body, from: at(260, 130, 40, body), fov: 30 },
          hand: { at: hand, from: at(30, 22, 8, hand), fov: 22 },
          side: { at: hand, from: at(4, 38, 4, hand), fov: 22 },
          back: { at: hand, from: at(-24, 26, 10, hand), fov: 22 },
          low: { at: hand, from: at(26, 10, -14, hand), fov: 22 },
        };
        const sh = shots[shot] ?? shots.full;
        cam.aspect = w / h;
        cam.fov = sh.fov;
        cam.updateProjectionMatrix();
        cam.position.copy(sh.from);
        cam.lookAt(sh.at);
        renderer.render(scene, cam);
      },
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Framing + CS:S reference + scripted playback (&cs=1 needed for the reference):
//   ?mode=frame&cs=1&cells=cs:idle,vm:glove-knit:carrot:idle,vm:glove-moto-boom:karrotbit:slash1:0.1|60,1,1,-1
//      cs:<action>[:t]                      Valve's own v_knife_t (hands + knife, textured) in that action
//      vm:<glove>:<knife>:<action>[:t]      ours; "|fov_x_y_z" after a cell overrides the viewmodel settings
//   &fov=54&ox=0.6&oy=1.5&oz=-0.9 (every cell; default: the default framing, viewmodel/defaults.ts) · &hand=left · &cross=1 (crosshair)
//   ?mode=play&cs=1&glove=..&knife=..&script=a1@0.5,a2@1.4,f@3,d@5    one cell; the driver steps it with
//      window.__lab.step(dt) (deterministic; the rAF loop only redraws). &zoom/&cx/&cy crop on the hand.

async function loadCs(): Promise<void> {
  if (q.get("cs") !== "1") return;
  const { discoverPlayerContent, sha256Hex } = await import("../../content");
  const bsp = new Uint8Array(await (await fetch(`/${q.get("map") ?? "bhop_eazy"}.bsp`)).arrayBuffer());
  await discoverPlayerContent(await sha256Hex(bsp));
}

/** Valve's v_knife_t mesh on the viewmodel's root, posed from its bone setup (dev reference only). */
async function valveKnife(vm: Viewmodel): Promise<{ mesh: THREE.SkinnedMesh; pose(): void } | null> {
  type Cs = { d: import("../../player/studio/data").StudioData; bs: import("../../player/studio/pose").BoneSetup };
  const cs = (vm as unknown as { cs: Cs | null }).cs;
  if (!cs) return null;
  const { VERTEX_FLOATS } = await import("../../player/studio/data");
  const { concat34To44 } = await import("../../player/studio/pose");
  const { studioSolidMaterial } = await import("../../player/studio/materials");
  const { textureFromPayload } = await import("../../render");
  const d = cs.d;
  const v = d.vertices, n = v.length / VERTEX_FLOATS;
  const buf = new THREE.InterleavedBuffer(v, VERTEX_FLOATS);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.InterleavedBufferAttribute(buf, 3, 0));
  g.setAttribute("normal", new THREE.InterleavedBufferAttribute(buf, 3, 3));
  g.setAttribute("uv", new THREE.InterleavedBufferAttribute(buf, 2, 6));
  g.setAttribute("aTangent", new THREE.InterleavedBufferAttribute(buf, 4, 8));
  const idx = new Uint16Array(n * 4), wts = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * VERTEX_FLOATS;
    let s = 0;
    for (let k = 0; k < 3; k++) (wts[i * 4 + k] = v[o + 12 + k]), (idx[i * 4 + k] = v[o + 15 + k]), (s += v[o + 12 + k]);
    if (s <= 0) wts[i * 4] = 1;
  }
  g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(idx, 4));
  g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(wts, 4));
  g.setIndex(new THREE.BufferAttribute(d.indices, 1));
  d.info.groups.forEach((gr, gi) => g.addGroup(gr[1], gr[2], gi));
  const core = (d as unknown as { core: import("../../core").Core }).core;
  const support = { s3tc: renderer.extensions.has("WEBGL_compressed_texture_s3tc") && renderer.extensions.has("WEBGL_compressed_texture_s3tc_srgb"), anisotropy: 4 };
  const tex = (p: string | null, normal: boolean) => {
    const pl = p ? core.texturePath(p, support.s3tc, false) : null;
    if (!pl) return null;
    const t = textureFromPayload(pl, support, normal ? THREE.NoColorSpace : THREE.SRGBColorSpace);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  };
  const mats = d.info.groups.map(([m]) => {
    const mi = d.info.materials[m];
    return studioSolidMaterial(vm.uniforms, mi, { map: tex(mi?.base ?? null, false), normal: tex(mi?.bump ?? null, true) });
  });
  const bones = Array.from({ length: d.bones }, () => new THREE.Bone());
  const skeleton = new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4()));
  skeleton.update = () => {
    if (skeleton.boneTexture) skeleton.boneTexture.needsUpdate = true;
  };
  const mesh = new THREE.SkinnedMesh(g, mats);
  mesh.bindMode = THREE.DetachedBindMode;
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.frustumCulled = false;
  (vm as unknown as { root: THREE.Group }).root.add(mesh);
  return {
    mesh,
    pose() {
      const bm = skeleton.boneMatrices!;
      for (let i = 0; i < d.bones; i++) concat34To44(cs.bs.world, i * 12, d.poseToBone, i * 12, bm, i * 16);
      skeleton.update();
    },
  };
}

const vmPrefs = (s?: string) => {
  const d = VIEWMODEL_POS;
  const [fov, x, y, z] = (s ?? `${q.get("fov") ?? d.fov},${q.get("ox") ?? d.x},${q.get("oy") ?? d.y},${q.get("oz") ?? d.z}`).split(/[,_]/).map(Number);
  Object.assign(prefs.get().viewmodel, { fov, x, y, z, hand: q.get("hand") === "left" ? "left" : "right" });
};

async function framing(): Promise<void> {
  await loadCs();
  const vm = new Viewmodel();
  if (q.get("cs") === "1") {
    const t0 = performance.now();
    while (vm.animSource !== "cs" && performance.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 100));
  }
  const valve = await valveKnife(vm);
  const world = new THREE.PerspectiveCamera(74, 1, 1, 1000);
  const still: ViewmodelInput = { velocity: [0, 0, 0], grounded: true, viewOffsetZ: 64, sidemove: 0, yaw: 0, pitch: 0, landed: 0 };
  const held = { primary: false, secondary: false, inspect: false };
  const pal = paletteOf(colourway(outfit));
  vm.uniforms.uPalette.value.forEach((c, i) => c.set(pal[i]));
  const zoom = Number(q.get("zoom") ?? 1), cx = Number(q.get("cx") ?? 0.5), cy = Number(q.get("cy") ?? 0.5);
  const crop = (w: number, h: number) => {
    if (zoom !== 1) vm.camera.setViewOffset(w, h, cx * w - w / (2 * zoom), cy * h - h / (2 * zoom), w / zoom, h / zoom);
  };
  if (mode === "play") {
    const k = knifeOf(q.get("knife"));
    const glove = q.get("glove") ?? "glove-knit";
    vm.setKnife(k);
    vm.setLoadout(loadoutOf(glove, k));
    vmPrefs();
    const script = (q.get("script") ?? "").split(",").filter(Boolean).map((s) => s.split("@")).map(([k, at]) => ({ k, at: Number(at) })).sort((a, b) => a.at - b.at);
    let clock = 0, si = 0;
    vm.timeScale = 1;
    vm.draw();
    const step = (dt: number) => {
      clock += dt;
      while (si < script.length && script[si].at <= clock) {
        const { k: key } = script[si++];
        if (key === "f") vm.inspect();
        else if (key === "a1") vm.press(false);
        else if (key === "a2") vm.press(true);
        else if (key === "d") vm.draw();
        else if (key === "H1") held.primary = true;
        else if (key === "H0") held.primary = false;
      }
      vm.update(dt, still, held);
    };
    step(0);
    cells = [{ label: `<b>${gname(glove)}</b> · ${k.name}`, draw(_x, _y, w, h) {
      world.aspect = w / h;
      world.updateProjectionMatrix();
      crop(w, h);
      vm.render(renderer, world);
    } }];
    cols = 1;
    Object.assign(window, { __lab: { ready: true, step, vm, get clock() { return clock; } } });
    return;
  }
  const sp = specs("cs:idle,vm:glove-knit:carrot:idle");
  cols = Number(q.get("cols") ?? Math.min(sp.length, 2));
  cells = sp.map((s0) => {
    const [s, over] = s0.split("|");
    const p = s.split(":");
    const isCs = p[0] === "cs";
    const [glove, kid, act, t] = isCs ? ["glove-knit", "carrot", p[1] ?? "idle", p[2] ?? "0"] : [p[1], p[2], p[3] ?? "idle", p[4] ?? "0"];
    const k = knifeOf(kid);
    const pv = () => prefs.get().viewmodel;
    return {
      label: `${isCs ? "<b>CS:S v_knife_t</b>" : `<b>${gname(glove)}</b> · ${k.name}`} · ${act}${Number(t) ? ` ${t} s` : ""}`,
      draw(_x, _y, w, h) {
        vmPrefs(over);
        vm.setKnife(k);
        vm.setLoadout(loadoutOf(glove, k));
        // &hold=ox,oy,oz,ap,ay,ar,wp,wy,wr: dev override of the hold state's arm offset / angles and wrist (tuning).
        const ho = q.get("hold")?.split(",").map(Number);
        if (ho && vm.knifeHold) vm.knifeHold.devPose = (st) => (st.arm.o.splice(0, 3, ho[0], ho[1], ho[2]), st.arm.a.splice(0, 3, ho[3], ho[4], ho[5]), st.wrist.splice(0, 3, ho[6], ho[7], ho[8]));
        vm.seek(act as VmAction | "inspect", Number(t));
        world.aspect = w / h;
        world.updateProjectionMatrix();
        crop(w, h);
        vm.update(0, still, held);
        if (valve) {
          valve.mesh.visible = isCs;
          vm.mesh.visible = !isCs;
          if (isCs) valve.pose();
        }
        vm.render(renderer, world);
        void pv;
      },
    };
  });
  if (q.get("cross") === "1") {
    const st = document.createElement("style");
    st.textContent = `#labels::after{content:"";position:fixed;left:50%;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;background:linear-gradient(#0f0,#0f0) center/2px 100% no-repeat,linear-gradient(#0f0,#0f0) center/100% 2px no-repeat;opacity:.8}`;
    document.head.append(st);
  }
}

if (mode === "open") openHand();
else if (mode === "tp") await thirdPerson();
else if (mode === "frame" || mode === "play") await framing();
else await firstPerson();
info.textContent = `glove lab · ${mode}`;
layout();
addEventListener("resize", layout);
const loop = () => {
  frame();
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
