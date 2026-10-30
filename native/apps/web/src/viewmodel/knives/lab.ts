// DEV ONLY knife lab (knifelab.html, not a build input): the knife registry in first person (the real Viewmodel),
// as a close-up turntable, and in third person (the real PlayerModel bunny), optionally with a production finish.
//
//   ?mode=fp&cells=karrotbit:right:idle,karrotbit:left:idle,bunnyfly:right:slash1:0.15    knife:hand:action[:t]
//          (&act=inspect&t=.. works too: action "inspect" seeks into the knife's first trick, "inspect1" the next)
//   ?mode=turn&knife=bunnyfly&cells=0,45,90,135,180,0/30,90:180:180                     yaw[/pitch][:joint angles]
//          (&at=<z> looks at that knife-local z instead of the middle, &dist=<units>)
//   ?mode=tp&knife=karrotbit&cells=full,hand,ghost,back                                  third-person shots
//   &fin=nebula (a finish design or item id) · &cols=3 · &zoom=1.5&cx=0.6&cy=0.6 (fp) · &labels=0 · &dist=14 (turn)

import * as THREE from "three";
import { Builder } from "../../player/bunny/builder";
import { solidMaterial, playerUniforms } from "../../player/materials";
import { PlayerModel } from "../../player/model";
import { prefs } from "../../ui/settings";
import { ensureViewmodelLayout } from "../finishes/layout";
import { lookOf, setFinishUniforms, type FinishSpec } from "../finishes/shader";
import type { VmAction } from "../procedural";
import { vmRig } from "../rig";
import { Viewmodel, type ViewmodelInput } from "../viewmodel";
import { KnifeCtx } from "./ctx";
import { CARROT_HOLD, KnifeHold, tweak, type HandFrame } from "./hold";
import { KNIVES, knifeById } from "./index";
import type { KnifeDef } from "./types";
import { RARITY } from "../../progression";
import { concat, invert34, rig as bunnyRig } from "../../player/bunny/rig";
import { finishItemId, finishName, parseFinish } from "../finishes/finishes";

const q = new URLSearchParams(location.search);
const canvas = document.getElementById("c") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setClearColor(0x000000, 0);
const labels = document.getElementById("labels")!;
const info = document.getElementById("info")!;
const mode = q.get("mode") ?? "fp";
const showLabels = q.get("labels") !== "0";
const knifeOf = (id: string | null): KnifeDef => knifeById(id) ?? KNIVES[1];

const fin: FinishSpec | null = (() => {
  const kind = parseFinish(q.get("fin"));
  return kind === "none" ? null : { kind };
})();
const finName = fin ? finishName(fin.kind) : "";

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

const title = (k: KnifeDef) => `<b>${k.name}</b> · ${RARITY[k.rarity].name}`;

// ---------------------------------------------------------------------------------------------
// First person: the real Viewmodel, one knife / hand / pose per cell.

async function firstPerson(): Promise<void> {
  // &cs=1: v_knife_t's real sequences under the hold (hosted content via the dev content cache), like the game.
  if (q.get("cs") === "1") {
    const { discoverPlayerContent, sha256Hex } = await import("../../content");
    const bsp = new Uint8Array(await (await fetch(`/${q.get("map") ?? "bhop_eazy"}.bsp`)).arrayBuffer());
    await discoverPlayerContent(await sha256Hex(bsp));
  }
  const vm = new Viewmodel();
  if (q.get("cs") === "1") {
    const t0 = performance.now();
    while (vm.animSource !== "cs" && performance.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 100));
  }
  const world = new THREE.PerspectiveCamera(74, 1, 1, 1000);
  const still: ViewmodelInput = { velocity: [0, 0, 0], grounded: true, viewOffsetZ: 64, sidemove: 0, yaw: 0, pitch: 0, landed: 0 };
  const held = { primary: false, secondary: false };
  const zoom = Number(q.get("zoom") ?? 1), cx = Number(q.get("cx") ?? 0.5), cy = Number(q.get("cy") ?? 0.5);
  if (fin) {
    setFinishUniforms(vm.uniforms, fin);
    vm.mesh.material = solidMaterial(vm.uniforms, lookOf(fin, null, true));
  }
  const specs = (q.get("cells") ?? `${q.get("knife") ?? "karrotbit"}:right:idle,${q.get("knife") ?? "karrotbit"}:left:idle`).split(",");
  // Dev tuning: &place=ox,oy,oz,rx,ry,rz (knife frame in the fist), &arm=f,l,u,pitch,yaw,roll, &wrist=p,y,r.
  const nums = (k: string) => q.get(k)?.split(",").map(Number) ?? null;
  const place = nums("place"), arm = nums("arm"), wrist = nums("wrist");
  const tuned = new Map<string, KnifeDef>();
  const tune = (k: KnifeDef): KnifeDef => {
    if (!place) return k;
    let t = tuned.get(k.id);
    if (!t) {
      const base = k.hold ?? CARROT_HOLD;
      const orig = base.place ?? ((h: HandFrame) => h.carrot);
      tuned.set(k.id, (t = { ...k, hold: { ...base, place: (h) => tweak(orig(h), [place[0], place[1], place[2]], [place[3] ?? 0, place[4] ?? 0, place[5] ?? 0]) } }));
    }
    return t;
  };
  cols = Number(q.get("cols") ?? Math.min(specs.length, 2));
  cells = specs.map((sp) => {
    const [id, hand, act = "idle", t = "0"] = sp.split(":");
    const k = tune(knifeOf(id));
    return {
      label: `${title(k)} · ${hand} hand · ${act}${Number(t) ? ` ${t} s` : ""}${fin ? ` · ${finName}` : ""}`,
      draw(_x, _y, w, h) {
        vm.setKnife(k);
        if (vm.knifeHold && (arm || wrist))
          vm.knifeHold.devPose = (s) => {
            if (arm) arm.forEach((v, i) => (i < 3 ? (s.arm.o[i] += v) : (s.arm.a[i - 3] += v)));
            if (wrist) wrist.forEach((v, i) => (s.wrist[i] += v));
          };
        if (fin) ensureViewmodelLayout(vm.mesh.geometry);
        prefs.get().viewmodel.hand = hand === "left" ? "left" : "right";
        // "inspect" = the chain's first trick, "inspect1" / "inspect2" the next ones.
        if (act.startsWith("inspect")) vm.seek("inspect", Number(t), Number(act.slice(7) || 0));
        else vm.seek(act as VmAction, Number(t));
        world.aspect = w / h;
        world.updateProjectionMatrix();
        if (zoom !== 1) vm.camera.setViewOffset(w, h, cx * w - w / (2 * zoom), cy * h - h / (2 * zoom), w / zoom, h / zoom);
        vm.update(0, still, held);
        vm.render(renderer, world);
      },
    };
  });
  Object.assign(window, { __vm: vm });
  // mode=hand: orbit the posed right fist (cells = yaw[/pitch] around it) to check how the hand wraps the knife.
  if (mode === "hand") {
    const k = tune(knifeOf(q.get("knife")));
    const orbit = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
    const r = vmRig();
    const hb = r.bone("Right_Hand");
    const views = (q.get("views") ?? "0,60,120,180,240,300").split(",");
    cols = Number(q.get("cols") ?? 3);
    const dist = Number(q.get("dist") ?? 16);
    cells = views.map((v) => {
      const [yaw, pitch = "15"] = v.split("/");
      return {
        label: `${title(k)} · hand ${yaw}°/${pitch}°`,
        draw(_x, _y, w, h) {
          vm.setKnife(k);
          prefs.get().viewmodel.hand = "right";
          vm.seek("idle", 0);
          world.aspect = w / h;
          world.updateProjectionMatrix();
          vm.update(0, still, held);
          vm.render(renderer, world);
          renderer.clear();
          // Posed wrist in world space: bone matrix (skin = W * inverse bind) applied to the bind position.
          const bm = vm.mesh.skeleton.boneMatrices!;
          const m = new THREE.Matrix4().fromArray(bm, hb * 16);
          const p = new THREE.Vector3(r.bind[hb * 12 + 3], r.bind[hb * 12 + 7], r.bind[hb * 12 + 11]).applyMatrix4(m);
          const kb = r.bone("Knife_Handle");
          const mk = new THREE.Matrix4().fromArray(bm, kb * 16);
          const pk = new THREE.Vector3(r.bind[kb * 12 + 3], r.bind[kb * 12 + 7], r.bind[kb * 12 + 11]).applyMatrix4(mk);
          p.lerp(pk, 0.5).applyMatrix4(vm.mesh.matrixWorld);
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

// ---------------------------------------------------------------------------------------------
// Turntable: the knife alone in its local frame (z up on screen), the camera orbiting it.

function turntable(): void {
  const k = knifeOf(q.get("knife"));
  const r = vmRig();
  const b = new Builder();
  const kb = r.bone("Knife_Handle");
  const ctx = new KnifeCtx(b, "fp", (p) => [p[0], p[1], p[2]], (bone) => [[bone ? r.bone(bone) : kb, 1]]);
  k.build(ctx);
  const geo = b.geometry();
  const n = r.names.length;
  const bones = Array.from({ length: n }, () => new THREE.Bone());
  // Bone matrices written directly below (like the viewmodel's DirectSkeleton): don't let three recompute them.
  const skeleton = new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4()));
  skeleton.update = () => {
    if (skeleton.boneTexture) skeleton.boneTexture.needsUpdate = true;
  };
  const u = playerUniforms();
  u.uAccent.value.set(0xffb43a);
  if (fin) setFinishUniforms(u, fin);
  const mesh = new THREE.SkinnedMesh(geo, solidMaterial(u, lookOf(fin, null, true)));
  mesh.bindMode = THREE.DetachedBindMode;
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.frustumCulled = false;
  // Source knife-local (z up) -> three (y up): x -> x, y -> -z, z -> y.
  const holder = new THREE.Group();
  holder.rotation.x = -Math.PI / 2;
  holder.add(mesh);
  const scene = new THREE.Scene();
  scene.add(holder);
  // Knife-local skinning: bone j's knife-local bind BL_j = inv(bind_kb) * bind_j; posed via KnifeHold.solve.
  const hold = new KnifeHold(k, r);
  const invKb = new Float32Array(12);
  invert34(r.bind, kb * 12, invKb, 0);
  const BLinv = new Float32Array(n * 12), tmp = new Float32Array(12), W = new Float32Array(n * 12), S = new Float32Array(12);
  for (let i = 0; i < n; i++) {
    concat(invKb, 0, r.bind, i * 12, tmp, 0);
    invert34(tmp, 0, BLinv, i * 12);
  }
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const c = bb.getCenter(new THREE.Vector3());
  const size = bb.getSize(new THREE.Vector3());
  // &at=<z>: look at that knife-local z on the axis instead of the box centre (close-ups of the guard / pommel).
  const target = q.get("at") ? new THREE.Vector3(0, Number(q.get("at")), 0) : new THREE.Vector3(c.x, c.z, -c.y);
  const dist = Number(q.get("dist") ?? Math.max(size.x, size.y, size.z) * 2.3);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 500);
  const specs = (q.get("cells") ?? "0,45,90,135,180,225,270,315").split(",");
  cols = Number(q.get("cols") ?? Math.min(4, specs.length));
  cells = specs.map((sp, i) => {
    const [view, ...angles] = sp.split(":");
    const [yaw, pitch = "8"] = view.split("/");
    return {
      label: i === 0 ? `${title(k)} · ${(k.tris ?? ctx.tris).toLocaleString()} tris${fin ? ` · ${finName}` : ""}${angles.length ? ` · joints ${angles.join("/")}` : ""}` : angles.length ? `joints ${angles.join("/")}` : `${yaw}°`,
      draw(_x, _y, w, h) {
        W.fill(0);
        for (let j = 0; j < n; j++) W.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], j * 12);
        hold.state.angles.forEach((_, j) => (hold.state.angles[j] = Number(angles[j] ?? 0)));
        hold.solve(W);
        const bm = skeleton.boneMatrices!;
        for (let j = 0; j < n; j++) {
          concat(W, j * 12, BLinv, j * 12, S, 0);
          const qq = j * 16;
          bm[qq] = S[0], bm[qq + 1] = S[4], bm[qq + 2] = S[8], bm[qq + 3] = 0;
          bm[qq + 4] = S[1], bm[qq + 5] = S[5], bm[qq + 6] = S[9], bm[qq + 7] = 0;
          bm[qq + 8] = S[2], bm[qq + 9] = S[6], bm[qq + 10] = S[10], bm[qq + 11] = 0;
          bm[qq + 12] = S[3], bm[qq + 13] = S[7], bm[qq + 14] = S[11], bm[qq + 15] = 1;
        }
        const a = (Number(yaw) * Math.PI) / 180, p = (Number(pitch) * Math.PI) / 180;
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
        cam.position.set(target.x + Math.cos(a) * Math.cos(p) * dist, target.y + Math.sin(p) * dist, target.z + Math.sin(a) * Math.cos(p) * dist);
        cam.lookAt(target);
        renderer.render(scene, cam);
      },
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Third person: the bunny holding the knife (procedural idle), solid and ghost.

function thirdPerson(): void {
  const k = knifeOf(q.get("knife"));
  const scene = new THREE.Scene();
  const solid = new PlayerModel({ style: "solid", knife: k, model: "bunny" });
  const ghost = new PlayerModel({ style: "ghost", knife: k, model: "bunny", color: 0x7fd0ff });
  scene.add(solid.root, ghost.root);
  if (fin) solid.bunnyModel?.setLoadout({ knife: k.cosmeticId, finish: finishItemId(fin.kind), glove: "glove-knit" });
  const yaw = Number(q.get("yaw") ?? -35);
  const pose = { position: [0, 0, 0], velocity: [0, 0, 0], yaw, pitch: 0, crouched: false, grounded: true };
  const T = Number(q.get("t") ?? 1.2);
  for (const m of [solid, ghost]) {
    m.setState(pose);
    m.snap();
    for (let i = 0; i < Math.round(T * 30); i++) m.update(1 / 30);
  }
  const cam = new THREE.PerspectiveCamera(30, 1, 1, 2000);
  // The right hand's world position (three.js space): skinned bone matrix applied to its bind position.
  scene.updateMatrixWorld(true);
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
  const hand = handAt(solid.root);
  // Facing direction in three.js space (Source yaw: CCW from +X; Source (x, y, z) -> three (x, z, -y)).
  const fy = (yaw * Math.PI) / 180;
  const fwd = new THREE.Vector3(Math.cos(fy), 0, -Math.sin(fy));
  const right = new THREE.Vector3(Math.sin(fy), 0, Math.cos(fy));
  const up = new THREE.Vector3(0, 1, 0);
  const at = (f: number, r: number, u: number, base: THREE.Vector3) => base.clone().addScaledVector(fwd, f).addScaledVector(right, r).addScaledVector(up, u);
  const body = new THREE.Vector3(0, 38, 0);
  const shots: Record<string, { at: THREE.Vector3; from: THREE.Vector3; fov: number; ghost?: boolean }> = {
    full: { at: body, from: at(120, 60, 18, body), fov: 30 },
    hand: { at: hand, from: at(30, 22, 8, hand), fov: 22 },
    side: { at: hand, from: at(4, 38, 4, hand), fov: 22 },
    top: { at: hand, from: at(18, 6, 34, hand), fov: 22 },
    back: { at: body, from: at(-110, -50, 20, body), fov: 30 },
    ghost: { at: body, from: at(120, 60, 18, body), fov: 30, ghost: true },
    ghosthand: { at: hand, from: at(30, 22, 8, hand), fov: 22, ghost: true },
  };
  const specs = (q.get("cells") ?? "full,hand,ghost").split(",");
  cols = Number(q.get("cols") ?? specs.length);
  cells = specs.map((id, i) => {
    const s = shots[id] ?? shots.full;
    return {
      label: i === 0 ? `${title(k)} · third person${fin ? ` · ${finName}` : ""}` : id,
      draw(_x, _y, w, h) {
        solid.root.visible = !s.ghost;
        ghost.root.visible = !!s.ghost;
        cam.aspect = w / h;
        cam.fov = s.fov;
        cam.updateProjectionMatrix();
        cam.position.copy(s.from);
        cam.lookAt(s.at);
        renderer.render(scene, cam);
      },
    };
  });
}

if (mode === "turn") turntable();
else if (mode === "tp") thirdPerson();
else await firstPerson(); // fp, hand
info.textContent = `knife lab · ${mode} · ${KNIVES.map((k) => k.id).join(" ")}`;
layout();
addEventListener("resize", layout);
const loop = () => {
  frame();
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
Object.assign(window, { __lab: { ready: true } });
