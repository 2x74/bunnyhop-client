// Weapon hit effects (physics v4 knife and map-given guns; presentation only): a short spark / dust puff and a small
// scuff, cut or bullet mark at the hit point, oriented by the surface normal, plus a brief tracer for shots.
//
// Everything lives under `root`, which is in Source space (Z-up) like the world (render.ts rotates its root the same
// way). Marks on a brush entity (a func_button, a door) ride on an anchor that follows the entity's model transform,
// so they move with it. Marks fade out after a few seconds; puffs, marks and tracers are capped (the oldest goes).
//
//   const fx = new HitEffects(); scene.add(fx.root);
//   fx.impact(point, normal, "metal", "slash", { model, transforms, along })
//   fx.tracer(from, to, 0.12)
//   fx.update(dt, transforms)   every rendered frame (brushOrigins(), the same map world.update gets)
//   fx.clear()

import * as THREE from "three";
import type { BrushTransform } from "./core";
import type { ImpactKind, ImpactSurface } from "./audio/impacts";

const MAX_MARKS = 32;
const MAX_PUFFS = 12;
const MAX_TRACERS = 8;
/** Seconds a mark stays fully visible, then fades over MARK_FADE. */
const MARK_HOLD = 7;
const MARK_FADE = 2.5;

type V3 = ArrayLike<number>;

interface Mark {
  mesh: THREE.Mesh;
  age: number;
}

interface Puff {
  points: THREE.Points;
  vel: Float32Array;
  age: number;
  life: number;
  gravity: number;
  drag: number;
}

interface Tracer {
  line: THREE.Line;
  age: number;
  life: number;
}

/** Puff look per surface: colour, particle count, speed, size, life; metal throws sparks (additive, bright). */
const PUFF: Record<ImpactSurface, { color: number; n: number; speed: number; size: number; life: number; sparks?: boolean }> = {
  metal: { color: 0xffc46b, n: 9, speed: 160, size: 1.1, life: 0.28, sparks: true },
  concrete: { color: 0xb9b4aa, n: 8, speed: 55, size: 2.6, life: 0.55 },
  dirt: { color: 0x8a6f4d, n: 9, speed: 60, size: 2.8, life: 0.6 },
  wood: { color: 0xa98457, n: 7, speed: 70, size: 2.0, life: 0.45 },
  tile: { color: 0xe4e2dc, n: 7, speed: 90, size: 1.5, life: 0.4 },
};

/** Mark tint per surface: dark on most, a pale scratch on metal. */
const MARK_TINT: Record<ImpactSurface, number> = { metal: 0xd7d5cf, concrete: 0x2a2826, dirt: 0x2b2116, wood: 0x2a1c10, tile: 0x3a3a3a };

let textures: { cut: THREE.Texture; hole: THREE.Texture; dot: THREE.Texture } | null = null;

/** Small procedural alpha textures (white on transparent; tinted by the material colour). */
function tex() {
  if (textures) return textures;
  const make = (draw: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    draw(g);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  // A knife cut: a few thin strokes along x, tapered ends.
  const cut = make((g) => {
    g.strokeStyle = "#fff";
    g.lineCap = "round";
    const strokes: [number, number, number, number, number][] = [
      [6, 30, 58, 33, 4.4],
      [12, 36, 50, 37, 2.2],
      [16, 26, 44, 28, 1.2],
    ];
    for (const [x0, y0, x1, y1, w] of strokes) {
      const grad = g.createLinearGradient(x0, 0, x1, 0);
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(0.25, "rgba(255,255,255,0.9)");
      grad.addColorStop(0.75, "rgba(255,255,255,0.9)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.strokeStyle = grad;
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
  });
  // A puncture / bullet hole: dark core, soft ragged rim.
  const hole = make((g) => {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 30);
    r.addColorStop(0, "rgba(255,255,255,1)");
    r.addColorStop(0.28, "rgba(255,255,255,0.95)");
    r.addColorStop(0.45, "rgba(255,255,255,0.45)");
    r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r;
    g.beginPath();
    for (let i = 0; i <= 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const rr = 26 + ((i * 7919) % 5) - 2;
      g.lineTo(32 + Math.cos(a) * rr, 32 + Math.sin(a) * rr);
    }
    g.fill();
  });
  // A soft round particle.
  const dot = make((g) => {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, "rgba(255,255,255,1)");
    r.addColorStop(0.5, "rgba(255,255,255,0.6)");
    r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
  });
  return (textures = { cut, hole, dot });
}

const Z = new THREE.Vector3(0, 0, 1);
const X = new THREE.Vector3(1, 0, 0);

export class HitEffects {
  /** Source space (Z-up). Add to the scene once. */
  readonly root = new THREE.Group();
  private anchors = new Map<number, THREE.Group>();
  private marks: Mark[] = [];
  private puffs: Puff[] = [];
  private tracers: Tracer[] = [];
  private markGeo = new THREE.PlaneGeometry(1, 1);
  private m4 = new THREE.Matrix4();
  private v = new THREE.Vector3();
  private n = new THREE.Vector3();
  private q = new THREE.Quaternion();

  constructor() {
    this.root.name = "hit-effects";
    this.root.rotation.x = -Math.PI / 2;
  }

  /** An anchor that follows brush model `model` (null without a transform: the world). */
  private anchor(model: number, transforms: Map<number, BrushTransform> | undefined): THREE.Object3D {
    const t = model > 0 ? transforms?.get(model) : undefined;
    if (!t) return this.root;
    let a = this.anchors.get(model);
    if (!a) {
      a = new THREE.Group();
      this.anchors.set(model, a);
      this.root.add(a);
    }
    place(a, t);
    a.updateMatrix();
    return a;
  }

  /**
   * A hit at `p` (Source units) on a surface with normal `normal`. `model`: the brush model hit (its marks follow it),
   * `along`: a direction the mark's long side follows (the slash's sweep), else random.
   */
  impact(p: V3, normal: V3, surface: ImpactSurface, kind: ImpactKind, o: { model?: number; transforms?: Map<number, BrushTransform>; along?: V3 } = {}): void {
    const n = this.n.set(normal[0], normal[1], normal[2]);
    if (n.lengthSq() < 0.25) return;
    n.normalize();
    this.puff(p, n, surface, kind);
    this.mark(p, n, surface, kind, o);
  }

  private mark(p: V3, n: THREE.Vector3, surface: ImpactSurface, kind: ImpactKind, o: { model?: number; transforms?: Map<number, BrushTransform>; along?: V3 }): void {
    const t = tex();
    const parent = this.anchor(o.model ?? -1, o.transforms);
    const mat = new THREE.MeshBasicMaterial({
      map: kind === "slash" ? t.cut : t.hole,
      color: MARK_TINT[surface],
      transparent: true,
      opacity: kind === "bullet" ? 0.85 : 0.7,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this.markGeo, mat);
    mesh.renderOrder = 1;
    // Orientation: plane +Z along the normal, then its x along `along` projected onto the surface (or a random spin).
    this.q.setFromUnitVectors(Z, n);
    mesh.quaternion.copy(this.q);
    let spin = Math.random() * Math.PI * 2;
    if (o.along) {
      const a = this.v.set(o.along[0], o.along[1], o.along[2]);
      a.addScaledVector(n, -a.dot(n));
      if (a.lengthSq() > 1e-4) {
        const x = X.clone().applyQuaternion(this.q);
        spin = Math.atan2(x.clone().cross(a.normalize()).dot(n), x.dot(a)) + (Math.random() - 0.5) * 0.3;
      }
    }
    mesh.rotateZ(spin);
    const w = kind === "slash" ? 9 : kind === "stab" ? 3.6 : 2.4;
    const h = kind === "slash" ? 4 : w;
    mesh.scale.set(w, h, 1);
    mesh.position.set(p[0] + n.x * 0.15, p[1] + n.y * 0.15, p[2] + n.z * 0.15);
    if (parent !== this.root) {
      // Into the anchor's space (its matrix is current: anchor() just placed it).
      this.m4.copy(parent.matrix).invert();
      mesh.position.applyMatrix4(this.m4);
      this.q.setFromRotationMatrix(this.m4);
      mesh.quaternion.premultiply(this.q);
    }
    parent.add(mesh);
    this.marks.push({ mesh, age: 0 });
    while (this.marks.length > MAX_MARKS) this.dropMark(this.marks.shift()!);
  }

  private puff(p: V3, n: THREE.Vector3, surface: ImpactSurface, kind: ImpactKind): void {
    const look = PUFF[surface];
    const count = Math.round(look.n * (kind === "stab" ? 1.4 : kind === "bullet" ? 0.8 : 1));
    const pos = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Mostly along the normal, spread in a cone.
      const rx = Math.random() * 2 - 1, ry = Math.random() * 2 - 1, rz = Math.random() * 2 - 1;
      const s = look.speed * (0.4 + Math.random() * 0.8);
      let dx = n.x + rx * 0.8, dy = n.y + ry * 0.8, dz = n.z + rz * 0.8;
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l, dy /= l, dz /= l;
      pos[i * 3] = p[0] + n.x * 0.5;
      pos[i * 3 + 1] = p[1] + n.y * 0.5;
      pos[i * 3 + 2] = p[2] + n.z * 0.5;
      vel[i * 3] = dx * s;
      vel[i * 3 + 1] = dy * s;
      vel[i * 3 + 2] = dz * s;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      map: tex().dot,
      color: look.color,
      size: look.size * (kind === "stab" ? 1.2 : 1),
      sizeAttenuation: true,
      transparent: true,
      opacity: look.sparks ? 1 : 0.7,
      depthWrite: false,
      blending: look.sparks ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.root.add(points);
    this.puffs.push({ points, vel, age: 0, life: look.life, gravity: look.sparks ? 500 : 60, drag: look.sparks ? 1.5 : 6 });
    while (this.puffs.length > MAX_PUFFS) this.dropPuff(this.puffs.shift()!);
  }

  /** A brief shot tracer from `from` to `to` (Source units), gone after `life` seconds. */
  tracer(from: V3, to: V3, life = 0.1): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([from[0], from[1], from[2], to[0], to[1], to[2]]), 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xffe2a8, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    this.root.add(line);
    this.tracers.push({ line, age: 0, life });
    while (this.tracers.length > MAX_TRACERS) this.dropTracer(this.tracers.shift()!);
  }

  /** Per rendered frame: ages and fades everything; anchors follow their brush models. */
  update(dt: number, transforms?: Map<number, BrushTransform>): void {
    if (transforms) for (const [model, a] of this.anchors) {
      const t = transforms.get(model);
      if (t) place(a, t);
    }
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const m = this.marks[i];
      m.age += dt;
      const f = m.age - MARK_HOLD;
      if (f >= MARK_FADE) {
        this.dropMark(m);
        this.marks.splice(i, 1);
      } else if (f > 0) {
        const mat = m.mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = (mat.userData.base ??= mat.opacity) * (1 - f / MARK_FADE);
      }
    }
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.dropPuff(p);
        this.puffs.splice(i, 1);
        continue;
      }
      const attr = p.points.geometry.getAttribute("position") as THREE.BufferAttribute;
      const pos = attr.array as Float32Array;
      const v = p.vel;
      const k = Math.exp(-p.drag * dt);
      for (let j = 0; j < v.length; j += 3) {
        v[j] *= k;
        v[j + 1] *= k;
        v[j + 2] = v[j + 2] * k - p.gravity * dt;
        pos[j] += v[j] * dt;
        pos[j + 1] += v[j + 1] * dt;
        pos[j + 2] += v[j + 2] * dt;
      }
      attr.needsUpdate = true;
      const mat = p.points.material as THREE.PointsMaterial;
      mat.opacity = (mat.userData.base ??= mat.opacity) * (1 - p.age / p.life);
    }
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.age += dt;
      if (t.age >= t.life) {
        this.dropTracer(t);
        this.tracers.splice(i, 1);
      } else (t.line.material as THREE.LineBasicMaterial).opacity = 0.75 * (1 - t.age / t.life);
    }
  }

  /** Removes every effect (restart into the replay viewer, map change). */
  clear(): void {
    for (const m of this.marks) this.dropMark(m);
    for (const p of this.puffs) this.dropPuff(p);
    for (const t of this.tracers) this.dropTracer(t);
    this.marks = [];
    this.puffs = [];
    this.tracers = [];
  }

  private dropMark(m: Mark): void {
    m.mesh.removeFromParent();
    (m.mesh.material as THREE.Material).dispose();
  }

  private dropPuff(p: Puff): void {
    p.points.removeFromParent();
    p.points.geometry.dispose();
    (p.points.material as THREE.Material).dispose();
  }

  private dropTracer(t: Tracer): void {
    t.line.removeFromParent();
    t.line.geometry.dispose();
    (t.line.material as THREE.Material).dispose();
  }
}

/** Places an object at a brush transform, exactly like render.ts's model meshes. */
function place(o: THREE.Object3D, t: BrushTransform): void {
  const D = Math.PI / 180;
  o.position.set(t[0], t[1], t[2]);
  o.rotation.set(t[5] * D, t[3] * D, t[4] * D, "ZYX");
}
