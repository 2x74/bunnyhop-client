// DEV ONLY trail lab (traillab.html, not a build input): a ghost bhopping a strafe path with its trail, sampled the way
// ghost.ts samples it (every second tick of the last 2.5 s, the head last, width 2.5), one cell per trail.
//
//   ?cells=petals:trail-rose:behind:400,clover:trail-mint:side:700   shape:trail colour id:view:distance (units)
//                                                                   views: behind (a chase camera at eye height), side
//   &speed=700 (u/s)  &t=6.2 (freeze; absent = live)  &cols=3  &bg=dark|light  &opacity=0.55 (the ghost setting)
//   &tick=100

import * as THREE from "three";
import { cosmetic } from "../progression";
import { DEFAULT_LOADOUT } from "../loadout";
import { PlayerModel, type PlayerPose } from "./model";
import { Trail, trailShapeOf } from "./trail";

const q = new URLSearchParams(location.search);
const canvas = document.getElementById("c") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.autoClear = false;
const labels = document.getElementById("labels")!;
const SPEED = Number(q.get("speed") ?? 700);
const TICK = 1 / Number(q.get("tick") ?? 100);
const OPACITY = Number(q.get("opacity") ?? 0.55);
const FREEZE = q.has("t") ? Number(q.get("t")) : null;
const light = q.get("bg") === "light";
const JUMP = 301.993, GRAV = 800, HOP = (2 * JUMP) / GRAV;

/** A strafing bhop path: forward along +x at SPEED, weaving to either side, hopping (Source axes). */
function path(t: number): PlayerPose & { position: number[]; velocity: number[] } {
  const w = 1.7;
  const ph = ((t % HOP) + HOP) % HOP;
  const vy = 140 * w * Math.cos(t * w);
  return {
    position: [SPEED * t, 140 * Math.sin(t * w), Math.max(0, JUMP * ph - 0.5 * GRAV * ph * ph)],
    velocity: [SPEED, vy, JUMP - GRAV * ph],
    yaw: (Math.atan2(vy, SPEED) * 180) / Math.PI + 18 * Math.sin(t * Math.PI * (2 / HOP)),
    pitch: 4,
    crouched: false,
    grounded: ph < 0.012,
    sidemove: Math.sin(t * Math.PI * (2 / HOP)) > 0 ? -450 : 450,
  };
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(light ? 0xb9c6d6 : 0x151922);
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(60000, 6000).rotateX(-Math.PI / 2),
  new THREE.ShaderMaterial({
    uniforms: { lightBg: { value: light ? 1 : 0 } },
    vertexShader: `varying vec3 w; void main(){ w = (modelMatrix*vec4(position,1.)).xyz; gl_Position = projectionMatrix*viewMatrix*vec4(w,1.); }`,
    fragmentShader: `varying vec3 w; uniform float lightBg; void main(){ vec2 g = abs(fract(w.xz/64.0-0.5)-0.5)/fwidth(w.xz/64.0); float l = 1.0-min(min(g.x,g.y),1.0);
      vec3 c = mix(mix(vec3(0.075,0.085,0.11), vec3(0.62,0.66,0.6), lightBg), mix(vec3(0.2,0.22,0.28), vec3(0.5,0.54,0.5), lightBg), l); gl_FragColor = vec4(c,1.0);
      #include <colorspace_fragment>
    }`,
  }),
);
floor.position.x = 20000;
scene.add(floor);

interface Cell {
  model: PlayerModel;
  trail: Trail;
  view: string;
  dist: number;
  label: string;
}
const cells: Cell[] = (q.get("cells") ?? "ribbon:trail-gold:behind:400").split(",").map((spec) => {
  const [shape, color = "trail-gold", view = "behind", dist = "400"] = spec.split(":");
  const c = cosmetic(color);
  const model = new PlayerModel({ style: "ghost", color: c?.color ?? "#ffc23d", loadout: { ...DEFAULT_LOADOUT } });
  model.setOpacity(OPACITY);
  const trail = new Trail(c?.color ?? "#ffc23d", undefined, c?.color2 ?? null, trailShapeOf(shape));
  model.root.visible = trail.mesh.visible = false;
  scene.add(model.root, trail.mesh);
  return { model, trail, view, dist: Number(dist), label: `${shape} · ${c?.name ?? color} · ${view} ${dist}` };
});
const cols = Number(q.get("cols") ?? Math.min(cells.length, 3));
const camera = new THREE.PerspectiveCamera(Number(q.get("fov") ?? 59), 1, 4, 20000);
const pts = new Float32Array(400 * 3);
const eye = new THREE.Vector3();

function layout(): void {
  labels.innerHTML = "";
  const rows = Math.ceil(cells.length / cols);
  cells.forEach((c, i) => {
    const s = document.createElement("span");
    s.style.left = `${(i % cols) * (innerWidth / cols) + 10}px`;
    s.style.top = `${Math.floor(i / cols) * (innerHeight / rows) + 8}px`;
    s.textContent = c.label;
    labels.appendChild(s);
  });
}

let clock = 4;
let last = performance.now();
function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  clock = FREEZE ?? clock + dt;
  const W = innerWidth, H = innerHeight;
  renderer.setSize(W, H, false);
  renderer.setScissorTest(false);
  renderer.clear();
  renderer.setScissorTest(true);
  const rows = Math.ceil(cells.length / cols);
  const cw = Math.floor(W / cols), ch = Math.floor(H / rows);
  // The path at a whole number of ticks, like a replay.
  const t = clock / TICK;
  const head = path(clock);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    for (const o of cells) o.model.root.visible = o.trail.mesh.visible = o === c;
    c.model.setState(head);
    c.model.update(FREEZE === null ? dt : 1 / 60);
    // ghost.ts: every second tick of the last 2.5 s, then the head.
    const from = Math.max(0, t - 2.5 / TICK);
    const first = Math.ceil(from / 2) * 2;
    let n = 0;
    const push = (tt: number) => {
      const p = path(tt * TICK).position;
      pts[n * 3] = p[0];
      pts[n * 3 + 1] = p[2] + 6;
      pts[n * 3 + 2] = -p[1];
      n++;
    };
    for (let k = first; k < t && n < 398; k += 2) push(k);
    push(t);
    const p = head.position;
    if (c.view === "side") {
      // Beside the path, looking across it at the stretch behind the bunny.
      eye.set(p[0] - c.dist * 0.45, 64, -(p[1] - c.dist));
      camera.position.copy(eye);
      camera.lookAt(p[0] - c.dist * 0.45, 40, -p[1]);
    } else {
      // Behind and a little to one side, at eye height: what you see chasing your PB.
      // You, the same path a moment behind and a step to the side.
      const me = path(clock - c.dist / SPEED).position;
      eye.set(me[0], 64, -(me[1] - 36));
      camera.position.copy(eye);
      camera.lookAt(p[0], 48, -p[1]);
    }
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
    c.trail.set(pts, n, camera.position, Math.min(1, OPACITY * 1.2), 2.5, first / 2);
    const x = (i % cols) * cw, y = H - (Math.floor(i / cols) + 1) * ch;
    renderer.setViewport(x, y, cw, ch);
    renderer.setScissor(x, y, cw, ch);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
}
addEventListener("resize", layout);
layout();
frame();
