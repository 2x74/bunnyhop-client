// The unlock card's 3D models, one builder per kind (notify/item-preview.ts maps a reward to a kind; notify/item3d.ts
// turns, lights and draws them). Real items reuse the game's own meshes and materials, so the card shows exactly what
// you'll equip: the knife showcase (viewmodel/knives/showcase.ts) in the production finish shader, the first-person
// glove geometry (viewmodel/gloves/fp.ts via viewmodel/mesh.ts) in the player material with the glove recolouring, the
// hats, the bunny (player/model.ts) and the trail ribbon (player/trail.ts). Card items without a mesh (title, badge,
// frame, background) are small solid objects built here: a nameplate, a medal, a little player card. They share one
// material lit like the player material (the same key, sky / ground fill and rim), with a touch of specular for metal.
//
// Everything is built once per look and cached by the caller; geometry builders cache their own meshes too.

import * as THREE from "three";
import { cleanLoadout, DEFAULT_LOADOUT, gloveStyle, loadoutFor } from "../loadout";
import { achievement } from "../progression";
import { colourway, paletteOf } from "../player/bunny/palettes";
import { hatGeometry } from "../player/bunny/hats";
import { playerUniforms, solidMaterial, type PlayerUniforms } from "../player/materials";
import { PlayerModel } from "../player/model";
import { Trail } from "../player/trail";
import { applyLoadoutUniforms, specOf } from "../viewmodel/finishes/shader";
import { carrot } from "../viewmodel/knives/carrot";
import { knifeById } from "../viewmodel/knives/index";
import { KnifeShowcase } from "../viewmodel/knives/showcase";
import { viewmodelGeometry } from "../viewmodel/mesh";
import { vmRig } from "../viewmodel/rig";
import { badgeToken } from "../ui/badges";
import type { PreviewSpec } from "./item-preview";

export interface ItemScene {
  readonly scene: THREE.Scene;
  /** Turned, scaled and lifted by the stage; the model sits centred on its origin. */
  readonly pivot: THREE.Group;
  /** Bounding radius about the pivot's origin (model units): the camera frames this. */
  readonly radius: number;
  /** Per frame, before drawing (the bunny's idle, the trail's ribbon). `reveal` 0..1 over the reveal. */
  frame?(dt: number, cam: THREE.PerspectiveCamera, reveal: number): void;
  dispose(): void;
}

/** Frees a scene's materials (and their textures); `geometry`: its geometries too (not the cached glove / hat ones). */
const disposers = (root: THREE.Object3D, geometry = false) => () =>
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (geometry) m.geometry.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      (mat as THREE.ShaderMaterial).uniforms?.uMap?.value?.dispose?.();
      mat.dispose();
    }
  });

function base(): { scene: THREE.Scene; pivot: THREE.Group } {
  const scene = new THREE.Scene();
  const pivot = new THREE.Group();
  scene.add(pivot);
  return { scene, pivot };
}

function dressColours(u: PlayerUniforms, outfit: string | undefined): void {
  const c = colourway(outfit);
  const pal = paletteOf(c);
  u.uPalette.value.forEach((col, i) => col.set(pal[i]));
  u.uAccent.value.set(c.accent);
}

// ---------------------------------------------------------------------------------------------
// Knife (knife and finish unlocks)

/** Knife-local -> world for a knife lying across the view: tip to the right, flat face to the camera. */
function knifeBasis(): THREE.Quaternion {
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0));
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

function knifeScene(spec: PreviewSpec): ItemScene {
  const { scene, pivot } = base();
  const show = new KnifeShowcase();
  show.setKnife(knifeById(spec.knife) ?? carrot);
  show.setFinish(specOf({ finish: spec.finish ?? DEFAULT_LOADOUT.finish }));
  show.setColours(spec.outfit);
  // Tip up and to the right, like a blade held up to the light.
  show.root.quaternion.copy(knifeBasis().premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.62)));
  pivot.add(show.root);
  return { scene, pivot, radius: show.radius, dispose: () => show.dispose() };
}

// ---------------------------------------------------------------------------------------------
// Gloves: the right hand of the first-person mesh, open (the bind pose), without the sleeve

const handCache = new Map<string, THREE.BufferGeometry>();

/** The right glove of a glove style: the triangles of the viewmodel mesh that follow the right hand and its fingers. */
function handGeometry(style: ReturnType<typeof gloveStyle>["style"]): THREE.BufferGeometry {
  let g = handCache.get(style);
  if (g) return g;
  const src = viewmodelGeometry(carrot, style);
  const r = vmRig();
  const hand = new Set(r.names.map((n, i) => (/Right_(Hand|Index|Middle|Ring|Pinky|Thumb)|R_wrist/.test(n) ? i : -1)).filter((i) => i >= 0));
  const SI = src.getAttribute("skinIndex"), SW = src.getAttribute("skinWeight");
  /** The bone a vertex follows most. */
  const main = (v: number) => {
    let best = 0;
    for (let k = 1; k < 4; k++) if (SW.getComponent(v, k) > SW.getComponent(v, best)) best = k;
    return SI.getComponent(v, best);
  };
  const keep: number[] = [];
  const n = src.getAttribute("position").count;
  for (let v = 0; v + 2 < n; v += 3) if (hand.has(main(v)) && hand.has(main(v + 1)) && hand.has(main(v + 2))) keep.push(v);
  g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) {
    const a = attr as THREE.BufferAttribute;
    const out = new (a.array.constructor as new (n: number) => THREE.TypedArray)(keep.length * 3 * a.itemSize);
    keep.forEach((v, j) => out.set((a.array as THREE.TypedArray).subarray(v * a.itemSize, (v + 3) * a.itemSize), j * 3 * a.itemSize));
    g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize, a.normalized));
  }
  g.computeBoundingBox();
  g.computeBoundingSphere();
  handCache.set(style, g);
  return g;
}

function gloveScene(spec: PreviewSpec): ItemScene {
  const { scene, pivot } = base();
  const geo = handGeometry(gloveStyle(spec.glove).style);
  const u = playerUniforms();
  dressColours(u, spec.outfit);
  const look = applyLoadoutUniforms(u, cleanLoadout({ ...DEFAULT_LOADOUT, glove: spec.glove }) ?? DEFAULT_LOADOUT);
  const mesh = new THREE.Mesh(geo, solidMaterial(u, look));
  mesh.frustumCulled = false;
  // Viewmodel space (x forward from the eye, y left, z up; the arm reaches along -y) -> the back of the hand to the
  // camera (it faces the eye in game), fingers up, then leaning a little.
  const holder = new THREE.Group();
  holder.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, -1, 0), new THREE.Vector3(-1, 0, 0)));
  holder.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.32));
  const c = geo.boundingBox!.getCenter(new THREE.Vector3());
  mesh.position.copy(c).multiplyScalar(-1);
  holder.add(mesh);
  pivot.add(holder);
  return { scene, pivot, radius: geo.boundingBox!.getSize(new THREE.Vector3()).length() / 2, dispose: disposers(scene) };
}

// ---------------------------------------------------------------------------------------------
// Hats

function hatScene(spec: PreviewSpec): ItemScene {
  const geo = spec.hat ? hatGeometry(spec.hat) : null;
  if (!geo) throw new Error(`no hat ${spec.hat}`);
  const { scene, pivot } = base();
  const u = playerUniforms();
  geo.computeBoundingBox();
  const mesh = new THREE.Mesh(geo, solidMaterial(u));
  mesh.frustumCulled = false;
  // Bunny model space (z up, the face toward -y) -> three (y up, facing the camera).
  const holder = new THREE.Group();
  holder.rotation.x = -Math.PI / 2;
  mesh.position.copy(geo.boundingBox!.getCenter(new THREE.Vector3())).multiplyScalar(-1);
  holder.add(mesh);
  pivot.add(holder);
  return { scene, pivot, radius: geo.boundingBox!.getSize(new THREE.Vector3()).length() / 2, dispose: disposers(scene) };
}

// ---------------------------------------------------------------------------------------------
// The bunny (colourways) and its ghost (ghost colours)

function bunnyScene(spec: PreviewSpec, ghost: boolean): ItemScene {
  const { scene, pivot } = base();
  const m = new PlayerModel(ghost ? { model: "bunny", style: "ghost", color: spec.color, rim: spec.color2 } : { model: "bunny", style: "solid", outfit: spec.outfit, loadout: loadoutFor({ body: spec.body }) });
  m.setNearFade(0, 0);
  if (ghost) m.setOpacity(0.8);
  // A secret colourway not earned yet: its shape only (player/materials.ts silhouetteMaterial).
  if (spec.veil) m.bunnyModel?.setSilhouette(true);
  // Facing the camera (Source yaw 270 = -y = three +z), moved so the middle of its body is the centre (its stance
  // stands it off the origin, and changes once the CS:S animations load: bunny/model.ts bodyBox).
  const pose = { position: [0, 0, 0], velocity: [0, 0, 0], yaw: 270, pitch: 4, crouched: false, grounded: true };
  const holder = new THREE.Group();
  holder.add(m.root);
  const box = new THREE.Box3();
  const c = new THREE.Vector3();
  const stand = (dt: number) => {
    m.setState(pose);
    m.update(dt);
    const bm = m.bunnyModel;
    if (!bm || bm.bodyBox(box).isEmpty()) return void holder.position.set(0, -37, 0);
    box.getCenter(c);
    const a = THREE.MathUtils.degToRad(bm.feetYaw);
    // Source (x, y, z) -> three (x, z, -y), turned with the feet.
    holder.position.set(-(c.x * Math.cos(a) - c.y * Math.sin(a)), -c.z, c.x * Math.sin(a) + c.y * Math.cos(a));
  };
  m.snap();
  stand(1 / 60);
  pivot.add(holder);
  return {
    scene,
    pivot,
    radius: 42,
    frame(dt) {
      stand(dt);
    },
    dispose: () => m.dispose(),
  };
}

// ---------------------------------------------------------------------------------------------
// Trail: the in-game ribbon behind a run of bunny hops, seen from the side: it draws on behind its head during the
// reveal, then the hops keep sliding through it while the card is up.

function trailScene(spec: PreviewSpec): ItemScene {
  const { scene, pivot } = base();
  const N = 120;
  const color = spec.color ?? "#ffc23d";
  const trail = new Trail(color, N, spec.color2 ?? null);
  scene.add(trail.mesh);
  const head = new THREE.Mesh(new THREE.SphereGeometry(8, 16, 10), new THREE.MeshBasicMaterial({ color }));
  pivot.add(head);
  /** Half width, hop length and height (units: a hop at 300 u/s is about this long). */
  const W = 150, L = 100, H = 58;
  const local = new THREE.Vector3();
  /** Pivot-local point i of the ribbon (0 = tail at the left, N-1 = head at the right) with the hops moved on by `phase`. */
  const at = (i: number, phase: number, out: THREE.Vector3) => {
    const x = -W + (2 * W * i) / (N - 1);
    const u = ((((x - phase) % L) + L) % L) / L;
    return out.set(x, 4 * H * u * (1 - u) - H * 0.55, 22 * Math.sin(x / 55));
  };
  const pts = new Float32Array(N * 3);
  let phase = 0;
  return {
    scene,
    pivot,
    radius: Math.hypot(W, H) + 8,
    frame(dt, cam, reveal) {
      phase += dt * 130;
      pivot.updateMatrixWorld(true);
      const n = Math.max(2, Math.round(N * reveal));
      for (let i = 0; i < n; i++) {
        at(i, phase, local).applyMatrix4(pivot.matrixWorld);
        pts[i * 3] = local.x;
        pts[i * 3 + 1] = local.y;
        pts[i * 3 + 2] = local.z;
      }
      at(n - 1, phase, head.position);
      trail.set(pts, n, cam.position, 1, 10 * pivot.scale.x);
    },
    dispose: () => {
      trail.dispose();
      head.geometry.dispose();
      (head.material as THREE.Material).dispose();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Card items: nameplate (title), medal (badge), little player card (frame, background)

const TOKEN_VERTEX = /* glsl */ `
varying vec3 vN;
varying vec3 vW;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

// The player material's light (player/materials.ts solidFragment): key from above right, sky / ground fill, rim; plus
// a Blinn highlight that grows with uMetal.
const TOKEN_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uMetal;
#ifdef HAS_MAP
uniform sampler2D uMap;
#endif
varying vec3 vN;
varying vec3 vW;
varying vec2 vUv;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vW);
  vec3 L = normalize(vec3(0.42, 0.78, 0.46));
  float key = smoothstep(-0.05, 0.55, dot(n, L));
  vec3 ambient = mix(vec3(0.30, 0.27, 0.26), vec3(0.70, 0.76, 0.88), n.y * 0.5 + 0.5) * 0.62;
  vec3 albedo = uColor;
#ifdef HAS_MAP
  vec4 tx = texture2D(uMap, vUv);
  albedo = mix(albedo, tx.rgb, tx.a);
#endif
  vec3 col = albedo * (ambient + key * vec3(0.78, 0.74, 0.68));
  float spec = pow(max(dot(n, normalize(L + V)), 0.0), mix(18.0, 64.0, uMetal)) * mix(0.1, 0.9, uMetal);
  col += spec * mix(vec3(1.0), albedo * 1.3 + 0.25, uMetal);
  col += pow(1.0 - max(dot(n, V), 0.0), 3.0) * 0.22;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function tokenMaterial(color: THREE.ColorRepresentation, metal: number, map?: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uMetal: { value: metal }, ...(map ? { uMap: { value: map } } : {}) },
    defines: map ? { HAS_MAP: 1 } : {},
    vertexShader: TOKEN_VERTEX,
    fragmentShader: TOKEN_FRAGMENT,
  });
}

function canvasTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function canvas2d(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

function roundRectShape(w: number, h: number, r: number, hole?: [number, number, number]): THREE.Shape {
  const path = (p: THREE.Path, w: number, h: number, r: number) => {
    const x = -w / 2, y = -h / 2;
    p.moveTo(x + r, y);
    p.lineTo(x + w - r, y);
    p.quadraticCurveTo(x + w, y, x + w, y + r);
    p.lineTo(x + w, y + h - r);
    p.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    p.lineTo(x + r, y + h);
    p.quadraticCurveTo(x, y + h, x, y + h - r);
    p.lineTo(x, y + r);
    p.quadraticCurveTo(x, y, x + r, y);
  };
  const s = new THREE.Shape();
  path(s, w, h, r);
  if (hole) {
    const p = new THREE.Path();
    path(p, ...hole);
    s.holes.push(p);
  }
  return s;
}

/** A slab of `shape`, `depth` thick, centred on z = 0, with a soft bevel. */
function slab(shape: THREE.Shape, depth: number, bevel = 0.045): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 5 });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  return g;
}

/** A flat face for a texture, on the front of a slab (u, v across its box). */
function face(shape: THREE.Shape, z: number): THREE.BufferGeometry {
  const g = new THREE.ShapeGeometry(shape, 6);
  g.computeBoundingBox();
  const b = g.boundingBox!;
  const P = g.getAttribute("position"), UV = g.getAttribute("uv");
  for (let i = 0; i < P.count; i++) UV.setXY(i, (P.getX(i) - b.min.x) / (b.max.x - b.min.x), (P.getY(i) - b.min.y) / (b.max.y - b.min.y));
  g.translate(0, 0, z);
  return g;
}

const fontFamily = () => getComputedStyle(document.body).fontFamily || "ui-sans-serif, system-ui, sans-serif";
const mix = (a: string, b: string, t: number) => `#${new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString()}`;

/** Engraved text: a light lip below, the dark cut above. */
function engrave(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, dark: string): void {
  ctx.fillStyle = "rgba(255, 248, 225, 0.45)";
  ctx.fillText(text, x, y + 2);
  ctx.fillStyle = dark;
  ctx.fillText(text, x, y);
}

async function plaqueScene(spec: PreviewSpec): Promise<ItemScene> {
  const { scene, pivot } = base();
  const metal = spec.color ?? "#d9a441";
  const W = 2.3, H = 0.9;
  const [c, ctx] = canvas2d(560, 219);
  // Brushed metal, an engraved inset line, the title in the game's type.
  const grad = ctx.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, mix(metal, "#fff6dc", 0.35));
  grad.addColorStop(0.55, metal);
  grad.addColorStop(1, mix(metal, "#3a2408", 0.3));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = `rgba(255, 255, 255, ${0.025 + Math.random() * 0.03})`;
    ctx.fillRect(0, Math.random() * c.height, c.width, 1);
  }
  ctx.strokeStyle = mix(metal, "#2a1a06", 0.55);
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(22, 22, c.width - 44, c.height - 44, 26);
  ctx.stroke();
  await document.fonts?.ready;
  const label = spec.label ?? "";
  let size = 104;
  ctx.font = `800 ${size}px ${fontFamily()}`;
  while (ctx.measureText(label).width > c.width - 90 && size > 30) ctx.font = `800 ${(size -= 4)}px ${fontFamily()}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  engrave(ctx, label, c.width / 2, c.height / 2 + 4, mix(metal, "#1e1204", 0.78));
  const shape = roundRectShape(W, H, 0.16);
  const body = new THREE.Mesh(slab(shape, 0.14), tokenMaterial(mix(metal, "#5a3a0c", 0.25), 0.8));
  const front = new THREE.Mesh(face(roundRectShape(W, H, 0.16), 0.07 + 0.045 + 0.002), tokenMaterial(metal, 0.75, canvasTexture(c)));
  pivot.add(body, front);
  return { scene, pivot, radius: Math.hypot(W, H) / 2 + 0.05, dispose: disposers(scene, true) };
}

const RING_METAL = ["#c98a50", "#a3adbf", "#f2b628", "#b98cff"] as const;

/** The badge glyph (ui/badges.ts), drawn in `color`. */
async function glyphImage(id: string, color: string): Promise<HTMLImageElement | null> {
  const a = achievement(id);
  const svg = a ? badgeToken(a).querySelector("svg") : null;
  if (!svg) return null;
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("width", "256");
  svg.setAttribute("height", "256");
  svg.setAttribute("color", color);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.outerHTML)}`;
  try {
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

async function medalScene(spec: PreviewSpec): Promise<ItemScene> {
  const { scene, pivot } = base();
  const ring = spec.ring ?? 0;
  const metal = RING_METAL[ring];
  const S = 512;
  const [c, ctx] = canvas2d(S, S);
  // The face: the ring's metal, lighter towards the top left (prism: a soft pink-cyan-violet sweep), the glyph cut in.
  const g = ctx.createRadialGradient(S * 0.38, S * 0.32, S * 0.05, S / 2, S / 2, S * 0.62);
  if (ring === 3) {
    g.addColorStop(0, "#ffe2f0");
    g.addColorStop(0.45, "#9fdcff");
    g.addColorStop(1, "#8a5ae0");
  } else {
    g.addColorStop(0, mix(metal, "#fffbe8", 0.3));
    g.addColorStop(0.6, metal);
    g.addColorStop(1, mix(metal, "#1a1206", 0.4));
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = mix(metal, "#1a1206", 0.45);
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S * 0.4, 0, Math.PI * 2);
  ctx.stroke();
  const dark = mix(metal, "#120c04", 0.75);
  const [lip, cut] = await Promise.all([glyphImage(spec.achievement ?? "", "rgba(255,250,235,0.5)"), glyphImage(spec.achievement ?? "", dark)]);
  const gs = S * 0.62;
  if (lip) ctx.drawImage(lip, (S - gs) / 2, (S - gs) / 2 + 5, gs, gs);
  if (cut) ctx.drawImage(cut, (S - gs) / 2, (S - gs) / 2, gs, gs);
  const R = 1, T = 0.2;
  const edge = tokenMaterial(mix(metal, "#2a1a08", 0.15), 0.85);
  const coin = new THREE.Mesh(new THREE.CylinderGeometry(R, R, T, 48).rotateX(Math.PI / 2), edge);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(R - 0.035, 0.07, 8, 48).translate(0, 0, T / 2), edge);
  const rimBack = new THREE.Mesh(new THREE.TorusGeometry(R - 0.035, 0.07, 8, 48).translate(0, 0, -T / 2), edge);
  const front = new THREE.Mesh(new THREE.CircleGeometry(R - 0.06, 48).translate(0, 0, T / 2 + 0.003), tokenMaterial(metal, 0.45, canvasTexture(c)));
  pivot.add(coin, rim, rimBack, front);
  return { scene, pivot, radius: R + 0.08, dispose: disposers(scene, true) };
}

/** A little player card (avatar, name and badges as shapes) on a background colour. */
function miniCard(bg: string, W: number, H: number): HTMLCanvasElement {
  const [c, ctx] = canvas2d(Math.round(W * 220), Math.round(H * 220));
  const w = c.width, h = c.height;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, mix(bg, "#ffffff", 0.16));
  g.addColorStop(1, mix(bg, "#000000", 0.25));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const r = h * 0.2;
  ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
  ctx.beginPath();
  ctx.arc(h * 0.34, h * 0.4, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
  ctx.beginPath();
  ctx.roundRect(h * 0.64, h * 0.28, w * 0.42, h * 0.09, h * 0.045);
  ctx.fill();
  ctx.fillStyle = "rgba(255, 255, 255, 0.24)";
  ctx.beginPath();
  ctx.roundRect(h * 0.64, h * 0.44, w * 0.28, h * 0.07, h * 0.035);
  ctx.fill();
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
    ctx.beginPath();
    ctx.roundRect(h * 0.2 + i * h * 0.2, h * 0.7, h * 0.14, h * 0.14, h * 0.04);
    ctx.fill();
  }
  return c;
}

function cardScene(spec: PreviewSpec, framed: boolean): ItemScene {
  const { scene, pivot } = base();
  const W = 2.5, H = 1.6, R = 0.16;
  const bg = framed ? "#283044" : (spec.color ?? "#151a26");
  const tex = canvasTexture(miniCard(bg, W, H));
  if (framed) {
    // The frame: a ring in its colour (metal) around a recessed card.
    const B = 0.17;
    const ring = new THREE.Mesh(slab(roundRectShape(W + 2 * B, H + 2 * B, R + B, [W, H, R]), 0.16), tokenMaterial(spec.color ?? "#9aa4b5", 0.7));
    const card = new THREE.Mesh(face(roundRectShape(W, H, R), -0.02), tokenMaterial(bg, 0.1, tex));
    const back = new THREE.Mesh(slab(roundRectShape(W, H, R), 0.08, 0.01).translate(0, 0, -0.07), tokenMaterial(mix(bg, "#000", 0.3), 0.1));
    pivot.add(ring, card, back);
  } else {
    const body = new THREE.Mesh(slab(roundRectShape(W, H, R), 0.08, 0.025), tokenMaterial(mix(bg, "#000", 0.25), 0.15));
    const front = new THREE.Mesh(face(roundRectShape(W, H, R), 0.04 + 0.025 + 0.002), tokenMaterial(bg, 0.25, tex));
    pivot.add(body, front);
  }
  return { scene, pivot, radius: Math.hypot(W, H) / 2 + 0.2, dispose: disposers(scene, true) };
}

// ---------------------------------------------------------------------------------------------

export async function buildItemScene(spec: PreviewSpec): Promise<ItemScene> {
  switch (spec.kind) {
    case "knife":
      return knifeScene(spec);
    case "glove":
      return gloveScene(spec);
    case "hat":
      return hatScene(spec);
    case "bunny":
      return bunnyScene(spec, false);
    case "ghost":
      return bunnyScene(spec, true);
    case "trail":
      return trailScene(spec);
    case "plaque":
      return plaqueScene(spec);
    case "medal":
      return medalScene(spec);
    case "frame":
      return cardScene(spec, true);
    case "card":
      return cardScene(spec, false);
  }
}
