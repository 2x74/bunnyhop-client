// Bullet impacts in the world, pooled: a small decal (bullet hole) on the surface, a puff of dust or a spray of sparks
// (metal), a tracer streak from the gun to the hit, and on a func_button (the badges maps' boost pads) a quick ring
// pulse so a hit on something that reacts reads at a glance. Like the knife's hit effects (effects.ts), marks on a
// brush entity ride its model's transform (a pressed button carries its holes), and they fade after a while.
//
// Everything is preallocated (64 decals + 8 rings as instanced quads, 320 particles in two Points, 12 tracers in one
// LineSegments; ring buffers), so automatic fire costs a few array writes per shot and no allocation, no new
// material and no shader compile.
//
//   const fx = new GunImpacts(); scene.add(fx.root)            Source space (Z-up) like the world
//   fx.hit(point, normal, surface, { model, transforms, from, button })
//   fx.update(dt, transforms)                                    every rendered frame
//   fx.clear()

import * as THREE from "three";
import type { BrushTransform } from "../../core";
import type { ImpactSurface } from "../../audio/impacts";

const DECALS = 64;
const RINGS = 8;
const SPARKS = 160;
const DUST = 160;
const TRACERS = 12;
const DECAL_HOLD = 9;
const DECAL_FADE = 1.2;
const TRACER_SPEED = 7000;
const TRACER_LEN = 70;

type V3 = ArrayLike<number>;

/** Dust colour / count / speed / size / life per surface (sparks on metal, a little on tile). */
const PUFF: Record<ImpactSurface, { color: number; n: number; speed: number; size: number; life: number; sparks: number }> = {
  metal: { color: 0xa9a49a, n: 3, speed: 50, size: 2.2, life: 0.4, sparks: 8 },
  concrete: { color: 0xb9b4aa, n: 7, speed: 55, size: 3.0, life: 0.55, sparks: 0 },
  dirt: { color: 0x8a6f4d, n: 8, speed: 60, size: 3.2, life: 0.6, sparks: 0 },
  wood: { color: 0xa98457, n: 6, speed: 70, size: 2.4, life: 0.45, sparks: 0 },
  tile: { color: 0xe4e2dc, n: 5, speed: 90, size: 2.0, life: 0.4, sparks: 3 },
};
const MARK_TINT: Record<ImpactSurface, number> = { metal: 0x3b3a38, concrete: 0x2a2826, dirt: 0x2b2116, wood: 0x2a1c10, tile: 0x3a3a3a };

function holeTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  // A dark core, a ragged scorched rim (white on transparent; tinted per surface).
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 30);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.22, "rgba(255,255,255,1)");
  r.addColorStop(0.4, "rgba(255,255,255,0.55)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.beginPath();
  for (let i = 0; i <= 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const rr = 25 + ((i * 7919) % 7) - 3;
    g.lineTo(32 + Math.cos(a) * rr, 32 + Math.sin(a) * rr);
  }
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function ringTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 18, 32, 32, 31);
  r.addColorStop(0, "rgba(255,255,255,0)");
  r.addColorStop(0.55, "rgba(255,255,255,1)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const POINT_VS = /* glsl */ `
attribute vec3 aColor;
attribute float aAlpha;
attribute float aSize;
varying vec3 vColor;
varying float vAlpha;
uniform float uScale;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aAlpha > 0.0 ? aSize * uScale / max(1.0, -mv.z) : 0.0;
}`;
const POINT_FS = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d) * 4.0;
  if (r > 1.0) discard;
  gl_FragColor = vec4(vColor, vAlpha * (1.0 - r));
}`;

class ParticlePool {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private alpha: Float32Array;
  private size: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private a0: Float32Array;
  private next = 0;
  private live = 0;
  private uScale = { value: 600 };

  constructor(readonly n: number, additive: boolean, private gravity: number, private drag: number) {
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.alpha = new Float32Array(n);
    this.size = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n).fill(1);
    this.a0 = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aColor", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({
      vertexShader: POINT_VS,
      fragmentShader: POINT_FS,
      uniforms: { uScale: this.uScale },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
  }

  /** Viewport height in pixels (point sizes are world units at 1 unit away, scaled by this). */
  setScale(px: number): void {
    this.uScale.value = px;
  }

  emit(p: V3, dir: THREE.Vector3, spread: number, speed: number, color: THREE.Color, size: number, life: number, alpha: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    const o = i * 3;
    const rx = Math.random() * 2 - 1, ry = Math.random() * 2 - 1, rz = Math.random() * 2 - 1;
    let dx = dir.x + rx * spread, dy = dir.y + ry * spread, dz = dir.z + rz * spread;
    const l = Math.hypot(dx, dy, dz) || 1;
    const s = speed * (0.4 + Math.random() * 0.8);
    (dx /= l), (dy /= l), (dz /= l);
    this.pos[o] = p[0] + dir.x * 0.6;
    this.pos[o + 1] = p[1] + dir.y * 0.6;
    this.pos[o + 2] = p[2] + dir.z * 0.6;
    this.vel[o] = dx * s;
    this.vel[o + 1] = dy * s;
    this.vel[o + 2] = dz * s;
    this.col[o] = color.r;
    this.col[o + 1] = color.g;
    this.col[o + 2] = color.b;
    this.size[i] = size * (0.7 + Math.random() * 0.6);
    this.age[i] = 0;
    this.life[i] = life * (0.75 + Math.random() * 0.5);
    this.a0[i] = alpha;
    this.alpha[i] = alpha;
    this.live = this.n;
  }

  update(dt: number): void {
    if (!this.live) return;
    let any = 0;
    const k = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.n; i++) {
      if (this.alpha[i] <= 0) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.alpha[i] = 0;
        continue;
      }
      any++;
      const o = i * 3;
      this.vel[o] *= k;
      this.vel[o + 1] *= k;
      this.vel[o + 2] = this.vel[o + 2] * k - this.gravity * dt;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      this.alpha[i] = this.a0[i] * (1 - this.age[i] / this.life[i]);
    }
    const g = this.points.geometry;
    g.getAttribute("position").needsUpdate = true;
    g.getAttribute("aColor").needsUpdate = true;
    g.getAttribute("aAlpha").needsUpdate = true;
    g.getAttribute("aSize").needsUpdate = true;
    this.live = any;
  }

  clear(): void {
    this.alpha.fill(0);
    this.points.geometry.getAttribute("aAlpha").needsUpdate = true;
    this.live = 0;
  }
}

interface Decal {
  age: number;
  /** Brush model the mark rides (-1: the world), its local matrix (model space). */
  model: number;
  local: THREE.Matrix4;
  base: number;
}

const Z = new THREE.Vector3(0, 0, 1);

export class GunImpacts {
  /** Source space (Z-up). Add to the scene once. */
  readonly root = new THREE.Group();
  private decals: THREE.InstancedMesh;
  private decalState: Decal[];
  private nextDecal = 0;
  private rings: THREE.InstancedMesh;
  private ringAge = new Float32Array(RINGS).fill(Infinity);
  private ringMat = Array.from({ length: RINGS }, () => new THREE.Matrix4());
  private nextRing = 0;
  private sparks = new ParticlePool(SPARKS, true, 520, 1.6);
  private dust = new ParticlePool(DUST, false, 50, 5.5);
  private tracer: THREE.LineSegments;
  private tracerPos = new Float32Array(TRACERS * 6);
  private tracerCol = new Float32Array(TRACERS * 6);
  private tracers = Array.from({ length: TRACERS }, () => ({ from: new THREE.Vector3(), dir: new THREE.Vector3(), len: 0, t: Infinity }));
  private nextTracer = 0;
  private m = new THREE.Matrix4();
  private m2 = new THREE.Matrix4();
  private n = new THREE.Vector3();
  private v = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private c = new THREE.Color();
  private white = new THREE.Color(1, 1, 1);
  private sparkCol = new THREE.Color(0xffc46b);
  private transforms: Map<number, BrushTransform> | undefined;
  private live = false;

  constructor() {
    this.root.name = "gun-impacts";
    this.root.rotation.x = -Math.PI / 2;
    const plane = new THREE.PlaneGeometry(1, 1);
    const decalMat = new THREE.MeshBasicMaterial({ map: holeTexture(), transparent: true, opacity: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.decals = new THREE.InstancedMesh(plane, decalMat, DECALS);
    this.decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.decals.count = 0;
    this.decals.frustumCulled = false;
    this.decals.renderOrder = 1;
    this.decalState = Array.from({ length: DECALS }, () => ({ age: Infinity, model: -1, local: new THREE.Matrix4(), base: 1 }));
    // instanceColor exists from the start (no buffer allocation on the first hit).
    for (let i = 0; i < DECALS; i++) this.decals.setColorAt(i, this.white);
    const ringMat = new THREE.MeshBasicMaterial({ map: ringTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
    this.rings = new THREE.InstancedMesh(plane, ringMat, RINGS);
    this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rings.count = 0;
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 2;
    for (let i = 0; i < RINGS; i++) this.rings.setColorAt(i, this.white);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(this.tracerPos, 3).setUsage(THREE.DynamicDrawUsage));
    tg.setAttribute("color", new THREE.BufferAttribute(this.tracerCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.tracer = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.tracer.frustumCulled = false;
    this.root.add(this.decals, this.rings, this.sparks.points, this.dust.points, this.tracer);
  }

  /** Viewport height in device pixels (particle sizes). */
  setViewportHeight(px: number): void {
    this.sparks.setScale(px * 0.9);
    this.dust.setScale(px * 0.9);
  }

  /**
   * A bullet hit at `p` (Source units) with surface normal `normal`. `model`: the brush model hit (its marks follow it),
   * `from`: where the tracer starts (the muzzle, roughly; omitted = no tracer), `button`: a func_button was hit (ring).
   */
  hit(p: V3, normal: V3, surface: ImpactSurface, o: { model?: number; transforms?: Map<number, BrushTransform>; from?: V3; button?: boolean; heavy?: boolean } = {}): void {
    const n = this.n.set(normal[0], normal[1], normal[2]);
    if (o.from) this.addTracer(o.from, p);
    if (n.lengthSq() < 0.25) return;
    n.normalize();
    this.live = true;
    const look = PUFF[surface];
    const heavy = o.heavy ? 1.5 : 1;
    this.c.set(look.color);
    for (let i = 0; i < Math.round(look.n * heavy); i++) this.dust.emit(p, n, 0.8, look.speed, this.c, look.size, look.life, 0.6);
    for (let i = 0; i < Math.round(look.sparks * heavy); i++) this.sparks.emit(p, n, 0.9, 180, this.sparkCol, 1.0, 0.25, 1);
    // Decal: plane +Z along the normal, random spin, a hair off the surface.
    const tf = o.transforms ?? this.transforms;
    const model = o.model !== undefined && o.model > 0 && tf?.get(o.model) ? o.model : -1;
    const d = this.decalState[this.nextDecal];
    const i = this.nextDecal;
    this.nextDecal = (this.nextDecal + 1) % DECALS;
    this.q.setFromUnitVectors(Z, n);
    this.m2.makeRotationZ(Math.random() * Math.PI * 2);
    const size = (o.heavy ? 3.2 : 2.3) * (0.85 + Math.random() * 0.3);
    this.m.compose(this.v.set(p[0] + n.x * 0.12, p[1] + n.y * 0.12, p[2] + n.z * 0.12), this.q, this.s.set(size, size, 1)).multiply(this.m2);
    if (model > 0) {
      // Into the model's space (its transform now).
      placeMatrix(tf!.get(model)!, this.m2).invert();
      d.local.multiplyMatrices(this.m2, this.m);
    } else d.local.copy(this.m);
    d.model = model;
    d.age = 0;
    d.base = size;
    this.decals.setColorAt(i, this.c.set(MARK_TINT[surface]));
    this.decals.instanceColor!.needsUpdate = true;
    this.decals.count = Math.max(this.decals.count, i + 1);
    if (o.button) {
      const r = this.nextRing;
      this.nextRing = (this.nextRing + 1) % RINGS;
      this.ringAge[r] = 0;
      this.ringMat[r].compose(this.v.set(p[0] + n.x * 0.2, p[1] + n.y * 0.2, p[2] + n.z * 0.2), this.q, this.s.set(1, 1, 1));
      this.rings.count = Math.max(this.rings.count, r + 1);
    }
  }

  private addTracer(from: V3, to: V3): void {
    const t = this.tracers[this.nextTracer];
    this.nextTracer = (this.nextTracer + 1) % TRACERS;
    t.from.set(from[0], from[1], from[2]);
    t.dir.set(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    t.len = t.dir.length();
    if (t.len < 1) return;
    t.dir.divideScalar(t.len);
    t.t = 0;
    this.live = true;
  }

  /** Per rendered frame. */
  update(dt: number, transforms?: Map<number, BrushTransform>): void {
    if (transforms) this.transforms = transforms;
    if (!this.live) return;
    let busy = false;
    // Decals: ride their model, hold, then shrink away.
    for (let i = 0; i < this.decals.count; i++) {
      const d = this.decalState[i];
      if (d.age === Infinity) {
        this.decals.setMatrixAt(i, this.m.makeScale(0, 0, 0));
        continue;
      }
      d.age += dt;
      busy = true;
      const f = d.age - DECAL_HOLD;
      if (f >= DECAL_FADE) {
        d.age = Infinity;
        this.decals.setMatrixAt(i, this.m.makeScale(0, 0, 0));
        continue;
      }
      const t = d.model > 0 ? this.transforms?.get(d.model) : undefined;
      if (t) this.m.multiplyMatrices(placeMatrix(t, this.m2), d.local);
      else this.m.copy(d.local);
      if (f > 0) this.m.multiply(this.m2.makeScale(1 - f / DECAL_FADE, 1 - f / DECAL_FADE, 1));
      this.decals.setMatrixAt(i, this.m);
    }
    this.decals.instanceMatrix.needsUpdate = true;
    // Rings: grow and fade (additive: fading the colour to black fades it out).
    for (let i = 0; i < this.rings.count; i++) {
      const a = (this.ringAge[i] += dt);
      if (a > 0.35) {
        this.rings.setMatrixAt(i, this.m.makeScale(0, 0, 0));
        continue;
      }
      busy = true;
      const k = a / 0.35;
      const s = 3 + 9 * (1 - (1 - k) * (1 - k));
      this.rings.setMatrixAt(i, this.m.copy(this.ringMat[i]).multiply(this.m2.makeScale(s, s, 1)));
      this.rings.setColorAt(i, this.c.setRGB(1, 0.85, 0.5).multiplyScalar(0.8 * (1 - k)));
    }
    this.rings.instanceMatrix.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
    this.sparks.update(dt);
    this.dust.update(dt);
    // Tracers: a streak running from the gun to the hit.
    const P = this.tracerPos, C = this.tracerCol;
    for (let i = 0; i < TRACERS; i++) {
      const t = this.tracers[i];
      const o = i * 6;
      if (t.t === Infinity) {
        P.fill(0, o, o + 6);
        C.fill(0, o, o + 6);
        continue;
      }
      t.t += dt;
      const head = Math.min(t.len, t.t * TRACER_SPEED);
      const tail = Math.max(0, head - TRACER_LEN);
      if (tail >= t.len - 1) {
        t.t = Infinity;
        P.fill(0, o, o + 6);
        C.fill(0, o, o + 6);
        continue;
      }
      busy = true;
      P[o] = t.from.x + t.dir.x * tail;
      P[o + 1] = t.from.y + t.dir.y * tail;
      P[o + 2] = t.from.z + t.dir.z * tail;
      P[o + 3] = t.from.x + t.dir.x * head;
      P[o + 4] = t.from.y + t.dir.y * head;
      P[o + 5] = t.from.z + t.dir.z * head;
      C[o] = 0.25, C[o + 1] = 0.2, C[o + 2] = 0.1;
      C[o + 3] = 0.95, C[o + 4] = 0.82, C[o + 5] = 0.55;
    }
    this.tracer.geometry.getAttribute("position").needsUpdate = true;
    this.tracer.geometry.getAttribute("color").needsUpdate = true;
    if (!busy) this.live = false;
  }

  clear(): void {
    for (const d of this.decalState) d.age = Infinity;
    this.ringAge.fill(Infinity);
    for (const t of this.tracers) t.t = Infinity;
    this.sparks.clear();
    this.dust.clear();
    this.live = true;
    this.update(0);
  }
}

/** A brush transform (render.ts convention: origin + angles ZYX) as a matrix. */
function placeMatrix(t: BrushTransform, out: THREE.Matrix4): THREE.Matrix4 {
  const D = Math.PI / 180;
  const e = placeEuler.set(t[5] * D, t[3] * D, t[4] * D, "ZYX");
  return out.makeRotationFromEuler(e).setPosition(t[0], t[1], t[2]);
}
const placeEuler = new THREE.Euler();
