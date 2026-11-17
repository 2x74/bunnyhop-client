// DEV ONLY charm turntable (charmturn.html, not a build input): one charm with its ring, cord and bail, hanging still
// in the first-person material under the studio light, seen from several sides at once (the QA sheets).
//
//   /charmturn.html?charm=charm-bun&angles=0,40,90,180&cosTier=2&outfit=midnight&size=100&length=100&t=0&dist=9&tilt=0&wrap=0.3
//   angles: degrees the charm is turned about its cord (0 = as the player sees it); t: the viewmodel clock (life poses)

import * as THREE from "three";
import { DEFAULT_LOADOUT, loadoutFor } from "../../loadout";
import { colourway, paletteOf } from "../../player/bunny/palettes";
import { playerUniforms, solidMaterial } from "../../player/materials";
import { applyLoadoutUniforms } from "../finishes/shader";
import { CharmRig } from "./rig";

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const canvas = document.getElementById("c") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000, 0);
renderer.autoClear = false;

const scene = new THREE.Scene();
const rig = new CharmRig(scene);
const u = playerUniforms();
const c = colourway(q.get("outfit") ?? undefined);
const pal = paletteOf(c);
u.uPalette.value.forEach((col, i) => col.set(pal[i]));
u.uAccent.value.set(c.accent);
const mat = solidMaterial(u, applyLoadoutUniforms(u, DEFAULT_LOADOUT, undefined, true));
rig.set(loadoutFor({ charm: q.get("charm") ?? "charm-bun", charmSize: q.has("size") ? num("size", 100) : undefined, charmLength: q.has("length") ? num("length", 100) : undefined }));
// The wrap as on a knife to the right of the charm: two turns round a bar `wrap` units across (0: none).
const wrap = num("wrap", 0.3);
rig.setMount(wrap > 0 ? { kind: "wrap", loop: Array.from({ length: 14 }, (_, i) => [Math.sin((i / 14) * Math.PI * 2) * wrap, 0, wrap + 0.04 - Math.cos((i / 14) * Math.PI * 2) * wrap] as [number, number, number]), normal: [0, 1, 0] } : null);
rig.setMaterial(mat);

const angles = (q.get("angles") ?? "0,40,90,180").split(",").map(Number);
const dist = num("dist", 9), tilt = num("tilt", 0);
const cam = new THREE.PerspectiveCamera(num("fov", 24), 1, 0.1, 100);
// Source eye space (x forward, y left, z up) -> three camera space (-z forward, x right, y up).
const conv = new THREE.Matrix4().set(0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 0, 1);
const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function draw(t: number): void {
  const W = innerWidth, H = innerHeight;
  renderer.setSize(W, H, false);
  renderer.setScissorTest(false);
  renderer.clear();
  // The ring `dist` ahead of the eye, lifted so the whole hang is centred.
  const hang = rig.chain.shape.cord + rig.chain.shape.link * 2;
  const top: [number, number, number] = [dist, 0, hang * 0.5 - 0.12];
  rig.chain.clear();
  rig.update(0, { velocity: [0, 0, 0], yaw: 0, pitch: 0 }, { bone: ID, at: top, colliders: [] }, t);
  rig.update(0, { velocity: [0, 0, 0], yaw: 0, pitch: 0 }, { bone: ID, at: top, colliders: [] }, t);
  const n = angles.length;
  const cw = W / n;
  cam.aspect = cw / H;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  renderer.setScissorTest(true);
  angles.forEach((deg, i) => {
    // Turned about the cord (the vertical through the ring), tilted toward the eye about the left axis.
    const M = new THREE.Matrix4().makeTranslation(top[0], 0, 0);
    M.multiply(new THREE.Matrix4().makeRotationY((-tilt * Math.PI) / 180));
    M.multiply(new THREE.Matrix4().makeRotationZ((deg * Math.PI) / 180));
    M.multiply(new THREE.Matrix4().makeTranslation(-top[0], 0, 0));
    rig.draw(new THREE.Matrix4().multiplyMatrices(cam.matrixWorld, conv).multiply(M), true);
    renderer.setViewport(i * cw, 0, cw, H);
    renderer.setScissor(i * cw, 0, cw, H);
    renderer.render(scene, cam);
  });
}

draw(num("t", 0));
Object.assign(window, { __charmturn: { ready: true, draw, rig } });
