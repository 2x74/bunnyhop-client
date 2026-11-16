// DEV ONLY hop effect lab (hoplab.html, not a build input): a bunny bhopping a strafe path with a hop effect, one cell
// per effect, seen from a chase camera behind it (the game's third person), from the side, or by a bystander at the spot.
//
//   ?fx=hop-ring,hop-dust         effects (default: all)       &trail=trail-rose   the trail colour they take
//   &speed=300 (u/s)  &bg=dark|light|both  &cols=4  &dist=100 (camera distance)
//   &view=behind|side|front|spot   spot: a camera that stays looking at where the last hop was, &az=35 degrees round from
//                                  behind, &el=20 degrees up
//   &t=2.42 (freeze at that time; absent = live)
//   &times=0.01,0.03,0.06         one row per effect and background: a frame at each time after a hop (seconds)
//   &strip=6:0.08                 the same, 6 frames 0.08 s apart from the hop's first frame
//   &edge=14                      the floor ends 14 units to the bunny's left (the pieces on the ground are cut there)
//   &slope=0.3                    the floor rises that much per unit to the bunny's left
//   &potato=1 (half the pieces, as Potato graphics)   &calm=1 (as with reduced motion)
//   &bench=16 (16 bunnies hopping round the camera, every one with the first effect; window.bench(frames) times it;
//             &sync=1: all of them hop on the same tick)

import * as THREE from "three";
import { COSMETICS, cosmetic } from "../progression";
import { DEFAULT_LOADOUT, loadoutFor } from "../loadout";
import { PlayerModel, type PlayerPose } from "./model";
import { prefs } from "../ui/settings";
import { hopLayerFor, hopQuality } from "./hop-layer";

const q = new URLSearchParams(location.search);
const canvas = document.getElementById("c") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Number(q.get("dpr") ?? Math.min(2, devicePixelRatio)));
renderer.autoClear = false;
const labels = document.getElementById("labels")!;
const SPEED = Number(q.get("speed") ?? 300);
const TICK = 1 / 100;
const VIEW = q.get("view") ?? "behind";
const DIST = Number(q.get("dist") ?? 100);
const AZ = (Number(q.get("az") ?? 35) * Math.PI) / 180, EL = (Number(q.get("el") ?? 20) * Math.PI) / 180;
const TRAIL = q.get("trail") ?? "trail-gold";
const JUMP = 301.993, GRAV = 800, HOP = (2 * JUMP) / GRAV;
const [stripN, stripDt] = (q.get("strip") ?? "").split(":").map(Number);
const TIMES = q.get("times")?.split(",").map(Number) ?? (stripN ? Array.from({ length: stripN }, (_, k) => TICK + k * stripDt) : null);
/** Frames after a hop are taken from the fourth hop of the path. */
const HOP_AT = 3 * HOP;
const FREEZE = q.has("t") ? Number(q.get("t")) : TIMES ? HOP_AT : null;
const BENCH = Number(q.get("bench") ?? 0);
const EDGE = q.has("edge") ? Number(q.get("edge")) : null;
const SLOPE = Number(q.get("slope") ?? 0);
const WEAVE = EDGE !== null || SLOPE ? 0 : 120;
const bgs = q.get("bg") === "both" ? [false, true] : [q.get("bg") === "light"];
// &potato=1: half the pieces (Potato graphics); &calm=1: reduced motion.
if (q.get("potato") === "1") hopQuality.count = 0.5;
if (q.get("calm") === "1") hopQuality.motion = 0.35;

/** A strafing bhop path along +x at SPEED, weaving, hopping (Source axes); `phase` offsets the hops, `lane` the line. */
function path(t: number, phase = 0, lane = 0): PlayerPose & { position: number[]; velocity: number[] } {
  const w = 1.7;
  const ph = (((t + phase) % HOP) + HOP) % HOP;
  const vy = WEAVE * w * Math.cos(t * w);
  const y = lane + WEAVE * Math.sin(t * w);
  return {
    visualTime: t,
    position: [SPEED * t, y, y * SLOPE + Math.max(0, JUMP * ph - 0.5 * GRAV * ph * ph)],
    velocity: [SPEED, vy, JUMP - GRAV * ph],
    yaw: (Math.atan2(vy, SPEED) * 180) / Math.PI + 18 * Math.sin(t * Math.PI * (2 / HOP)),
    pitch: 4,
    crouched: false,
    grounded: ph < TICK * 1.01,
    sidemove: Math.sin(t * Math.PI * (2 / HOP)) > 0 ? -450 : 450,
  };
}

function makeScene(light: boolean): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(light ? 0xc9cfc4 : 0x151922);
  // (A sloped floor is kept small: one 200,000 unit quad on a tilt has too little depth precision to lay decals on.)
  const geo = new THREE.PlaneGeometry(SLOPE ? 6000 : 200000, EDGE !== null ? 4000 + EDGE : SLOPE ? 1200 : 8000).rotateX(-Math.PI / 2);
  if (EDGE !== null) geo.translate(0, 0, 2000 - EDGE / 2);
  if (SLOPE) {
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, -p.getZ(i) * SLOPE);
  }
  const floor = new THREE.Mesh(
    geo,
    new THREE.ShaderMaterial({
      uniforms: { lightBg: { value: light ? 1 : 0 } },
      vertexShader: `varying vec3 w; void main(){ w = (modelMatrix*vec4(position,1.)).xyz; gl_Position = projectionMatrix*viewMatrix*vec4(w,1.); }`,
      fragmentShader: `varying vec3 w; uniform float lightBg; void main(){ vec2 g = abs(fract(w.xz/64.0-0.5)-0.5)/fwidth(w.xz/64.0); float l = 1.0-min(min(g.x,g.y),1.0);
        vec3 c = mix(mix(vec3(0.075,0.085,0.11), vec3(0.78,0.79,0.74), lightBg), mix(vec3(0.2,0.22,0.28), vec3(0.62,0.64,0.6), lightBg), l); gl_FragColor = vec4(c,1.0);
        #include <colorspace_fragment>
      }`,
    }),
  );
  floor.position.x = SLOPE ? 2000 : 90000;
  scene.add(floor);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
  return scene;
}

interface Cell {
  scene: THREE.Scene;
  models: { m: PlayerModel; phase: number; lane: number; at: number }[];
  label: string;
  /** Strip: this cell's time offset. */
  dt: number;
}

const ids = q.get("fx")?.split(",") ?? COSMETICS.filter((c) => c.slot === "hop").map((c) => c.id);
const cells: Cell[] = [];
const bunny = (fx: string) => {
  const m = new PlayerModel({ style: "solid", outfit: "outfit-cream", loadout: loadoutFor({ ...DEFAULT_LOADOUT, hop: fx, trail: TRAIL }), hops: "own" });
  // Source ground under a point: the lab's floor (its edge and slope).
  if (EDGE !== null || SLOPE) m.setGroundProbe((_x, y, z) => (EDGE !== null && y > EDGE ? null : y * SLOPE <= z && y * SLOPE > z - 48 ? y * SLOPE : null));
  return m;
};
if (BENCH) {
  const scene = makeScene(bgs[0]);
  const sync = q.get("sync") === "1";
  const models = Array.from({ length: BENCH }, (_, i) => ({ m: bunny(ids[i % ids.length]), phase: sync ? 0 : (i * 0.37) % HOP, lane: (i - BENCH / 2) * 70, at: -(i % 4) * 60 }));
  for (const x of models) scene.add(x.m.root);
  cells.push({ scene, models, label: `${BENCH} × ${ids.map((id) => cosmetic(id)?.name).join(", ")}`, dt: 0 });
} else
  for (const id of ids)
    for (const light of bgs)
      for (const dt of TIMES ?? [0]) {
        const scene = makeScene(light);
        const m = bunny(id);
        scene.add(m.root);
        cells.push({ scene, models: [{ m, phase: 0, lane: 0, at: 0 }], label: TIMES && dt !== TIMES[0] ? `${Math.round(dt * 1000)} ms` : `${cosmetic(id)?.name ?? id}`, dt });
      }

const cols = Number(q.get("cols") ?? (TIMES ? TIMES.length : Math.min(cells.length, 4)));
const camera = new THREE.PerspectiveCamera(Number(q.get("fov") ?? 74), 1, 2, 40000);

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

/** Steps a cell's bunnies to time `t` at the tick rate (from where they were, or from t - 3 s on a jump back). */
const at = new Map<PlayerModel, number>();
function step(c: Cell, t: number): void {
  for (const x of c.models) {
    let from = at.get(x.m) ?? -Infinity;
    if (from > t || t - from > 3) {
      from = Math.max(0, t - 3);
      x.m.snap();
    }
    for (let s = from + TICK; s <= t + 1e-9; s += TICK) {
      x.m.setState(path(s, x.phase, x.lane));
      x.m.update(TICK);
      // (Stepping to a frozen moment draws nothing on the way: count each tick as a frame for the layer's burst cap.)
      if (FREEZE !== null) hopLayerFor(c.scene).drawn();
    }
    at.set(x.m, Math.max(from, t));
  }
}

const target = new THREE.Vector3();
function frame(clock: number): void {
  const W = innerWidth, H = innerHeight;
  renderer.setSize(W, H, false);
  renderer.setScissorTest(false);
  renderer.clear();
  renderer.setScissorTest(true);
  const rows = Math.ceil(cells.length / cols);
  const cw = Math.floor(W / cols), ch = Math.floor(H / rows);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const t = clock + c.dt;
    step(c, t);
    const p = path(t).position;
    const fwd = path(t + 0.05).position;
    const dx = fwd[0] - p[0], dy = fwd[1] - p[1];
    const l = Math.hypot(dx, dy) || 1;
    // Source (x, y, z) -> three (x, z, -y).
    if (VIEW === "spot") {
      // A bystander: looking at where the last hop was, AZ round from behind it, EL up.
      const th = Math.floor((t - 1e-6) / HOP) * HOP;
      const s = path(th).position, v = path(th).velocity;
      const h = Math.atan2(v[1], v[0]) + Math.PI - AZ;
      camera.position.set(s[0] + Math.cos(h) * DIST * Math.cos(EL), s[2] + 6 + DIST * Math.sin(EL), -(s[1] + Math.sin(h) * DIST * Math.cos(EL)));
      target.set(s[0] + v[0] * 0.03, s[2] + 12, -s[1]);
    } else if (VIEW === "side") {
      camera.position.set(p[0] - 60, 70, -(p[1] - DIST * 2.2));
      target.set(p[0] - 60, 20, -p[1]);
    } else if (VIEW === "front") {
      camera.position.set(p[0] + (dx / l) * DIST, 50, -(p[1] + (dy / l) * DIST + 40));
      target.set(p[0], 34, -p[1]);
    } else {
      // The game's chase camera (viewer/cameras.ts): DIST behind a pivot 56 over the feet, 14 degrees above it.
      const back = DIST * Math.cos(0.244), up = 56 + DIST * Math.sin(0.244);
      camera.position.set(p[0] - (dx / l) * back, up, -(p[1] - (dy / l) * back));
      target.set(p[0], 56, -p[1]);
    }
    camera.lookAt(target);
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
    const x = (i % cols) * cw, y = H - (Math.floor(i / cols) + 1) * ch;
    renderer.setViewport(x, y, cw, ch);
    renderer.setScissor(x, y, cw, ch);
    renderer.render(c.scene, camera);
  }
}

let clock = 0;
let last = performance.now();
function loop(): void {
  const now = performance.now();
  clock = FREEZE ?? clock + Math.min(0.05, (now - last) / 1000);
  last = now;
  frame(clock);
  if (FREEZE === null) requestAnimationFrame(loop);
}
addEventListener("resize", () => {
  layout();
  if (FREEZE !== null) frame(FREEZE);
});
layout();
if (FREEZE !== null) frame(FREEZE);
else loop();
(window as unknown as { hoplab: unknown }).hoplab = { ready: true };

/**
 * Bench: `frames` frames 1/60 s apart from `from`, each drawn and finished (gl.finish), with the hop effects off, on,
 * then off again (Settings -> Hop effects, the models as other players). Mean ms per frame for each.
 */
(window as unknown as { bench: unknown }).bench = (frames = 600, from = 10) => {
  const gl = renderer.getContext();
  let t = from;
  const run = (on: boolean) => {
    prefs.update((p) => (p.showHopFx = on));
    for (const c of cells) for (const x of c.models) (x.m as unknown as { o: { hops: string } }).o.hops = "others";
    const ms: number[] = [];
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      frame((t += 1 / 60));
      gl.finish();
      ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    return { mean: ms.reduce((a, b) => a + b, 0) / ms.length, p50: ms[ms.length >> 1], p95: ms[Math.floor(ms.length * 0.95)], max: ms[ms.length - 1] };
  };
  const written = () => cells.reduce((n, c) => n + hopLayerFor(c.scene).written, 0);
  const off1 = run(false);
  const w0 = written();
  const on = run(true);
  const w1 = written();
  const off2 = run(false);
  return { on, off: off1, off2, particlesOn: w1 - w0, particlesOff: written() - w1 };
};
