// First-person gun effects, drawn with the gun viewmodel (its scene, after the world, depth cleared): a brief muzzle
// flash and the spent shells. Everything is allocated once (one flash mesh, two instanced shell pools of 12) and reused,
// so a P90 spray or the XM1014 at full rate never allocates or compiles anything mid-fight.
//
//   flash   three additive quads at the muzzle (a star facing down the barrel, two crossed side flames), a random roll
//           and size per shot, ~50 ms, warm and modest (never a white-out); drawn over the gun (it sits at the muzzle,
//           in front of it, but from behind the gun the slide's nose would hide most of it)
//   shells  casings thrown from the ejection port to the right (left-handed: to the left, the mirror carries over),
//           simulated in camera space (they keep up with a bhopping player instead of vanishing behind at 1000 u/s)
//           with gravity along the world's down; a tumble, and on the ground one bounce off the floor at the
//           player's feet (it loses most of its speed, the spin kicks; onBounce: the "caseMetal" / "caseShell" cues;
//           in the air: no floor, no sound, it just falls), a fade, back to the pool
//   smoke   a brief wisp off the muzzle after a shot (a pool of soft sprites, rising and widening as they fade);
//           not on Potato, nothing after a silenced shot but a thinner one
//   light   flashLight(): how bright the muzzle's light is right now (the gun material lights hands + gun with it)
// Spawns are queued at the shot and placed at the next render, when the gun's pose for that frame is known.

import * as THREE from "three";
import type { GunDef } from "./types";
import type { GunViewmodel } from "./viewmodel";

const FLASH_LIFE = 0.06;
const SHELL_LIFE = 1.1;
/** The floor a shell bounces on: this far below the eye along the world's down (Source eye height). */
const FLOOR = 62;
const SMOKE_POOL = 8;
const SMOKE_LIFE = 0.75;
/** How long the muzzle's light lasts (s). */
const LIGHT_LIFE = 0.07;
const POOL = 12;
const GRAVITY = 800;

interface Smoke {
  age: number;
  p: THREE.Vector3;
  v: THREE.Vector3;
  s: number;
  a: number;
}

interface Shell {
  alive: boolean;
  /** Bounced off the floor already (once). */
  bounced: boolean;
  age: number;
  p: THREE.Vector3;
  v: THREE.Vector3;
  q: THREE.Quaternion;
  w: THREE.Vector3;
  s: number;
}

function flashTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 64;
  const g = c.getContext("2d")!;
  // Left half: a soft five-point star; right half: a flame lobe (along +u).
  g.translate(32, 32);
  const r = g.createRadialGradient(0, 0, 0, 0, 0, 30);
  r.addColorStop(0, "rgba(255,255,240,1)");
  r.addColorStop(0.25, "rgba(255,220,140,0.9)");
  r.addColorStop(0.6, "rgba(255,150,60,0.35)");
  r.addColorStop(1, "rgba(255,120,40,0)");
  g.fillStyle = r;
  g.beginPath();
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 ? 11 : 30;
    g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  g.fill();
  g.setTransform(1, 0, 0, 1, 64, 0);
  const f = g.createLinearGradient(0, 0, 64, 0);
  f.addColorStop(0, "rgba(255,240,200,1)");
  f.addColorStop(0.35, "rgba(255,190,90,0.8)");
  f.addColorStop(1, "rgba(255,120,40,0)");
  g.fillStyle = f;
  g.beginPath();
  g.moveTo(0, 32);
  g.quadraticCurveTo(14, 12, 64, 30);
  g.quadraticCurveTo(14, 52, 0, 32);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A soft grey puff (smoke sprites). */
function smokeTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(235,232,225,0.75)");
  r.addColorStop(0.45, "rgba(215,212,205,0.35)");
  r.addColorStop(1, "rgba(200,198,192,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The flash's quads in muzzle space (x forward): two stars across the barrel (one turned), two flames along it. */
function flashGeometry(): THREE.BufferGeometry {
  const P: number[] = [], U: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], uv: number[]) => {
    P.push(...a, ...b, ...c, ...a, ...c, ...d);
    U.push(uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[1], uv[2], uv[3], uv[0], uv[3]);
  };
  const s = 0.95;
  quad([0.05, -s, -s], [0.05, s, -s], [0.05, s, s], [0.05, -s, s], [0, 0, 0.5, 1]);
  // A second, smaller star a little ahead, turned half a point: a fuller, less regular burst.
  const s2 = 0.72;
  quad([0.35, 0, -s2], [0.35, s2, 0], [0.35, 0, s2], [0.35, -s2, 0], [0, 0, 0.5, 1]);
  const L = 2.4, h = 0.6;
  quad([0, 0, -h], [L, 0, -h], [L, 0, h], [0, 0, h], [0.5, 0, 1, 1]);
  quad([0, -h, 0], [L, -h, 0], [L, h, 0], [0, h, 0], [0.5, 0, 1, 1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2));
  return g;
}

/** A casing (along +x, base at 0), vertex-coloured with baked light; `hull` colours the front part (shotgun). */
function shellGeometry(len: number, rad: number, hull: number | null): THREE.BufferGeometry {
  const sides = 7;
  const P: number[] = [], C: number[] = [];
  const brass = new THREE.Color(0xd8a640), brassDark = new THREE.Color(0xa87a28), hc = new THREE.Color(hull ?? 0xd8a640);
  const L = new THREE.Vector3(0.3, 0.5, 0.8).normalize();
  const col = (base: THREE.Color, n: THREE.Vector3) => {
    const k = 0.55 + 0.45 * Math.max(0, n.dot(L)) + 0.15 * Math.max(0, n.y);
    return [base.r * k, base.g * k, base.b * k];
  };
  const ringAt = (x: number, r: number) => Array.from({ length: sides }, (_, i) => {
    const a = (i / sides) * Math.PI * 2;
    return new THREE.Vector3(x, Math.cos(a) * r, Math.sin(a) * r);
  });
  const split = hull ? 0.28 * len : len;
  const rows: [number, number, THREE.Color][] = hull
    ? [[0, rad * 1.08, brassDark], [split, rad * 1.08, brass], [split, rad, hc], [len, rad * 0.96, hc]]
    : [[0, rad * 1.1, brassDark], [0.12 * len, rad, brass], [len * 0.82, rad, brass], [len, rad * 0.8, brass]];
  for (let j = 0; j + 1 < rows.length; j++) {
    const a = ringAt(rows[j][0], rows[j][1]), b = ringAt(rows[j + 1][0], rows[j + 1][1]);
    for (let i = 0; i < sides; i++) {
      const i1 = (i + 1) % sides;
      const n = new THREE.Vector3(0, Math.cos(((i + 0.5) / sides) * Math.PI * 2), Math.sin(((i + 0.5) / sides) * Math.PI * 2));
      const c = col(rows[j + 1][2], n);
      for (const p of [a[i], b[i], b[i1], a[i], b[i1], a[i1]]) P.push(p.x, p.y, p.z), C.push(...c);
    }
  }
  // End caps.
  for (const [x, r, cc, sgn] of [[0, rows[0][1], brassDark, -1], [len, rows[rows.length - 1][1], rows[rows.length - 1][2], 1]] as [number, number, THREE.Color, number][]) {
    const ring = ringAt(x, r);
    const c = col(cc, new THREE.Vector3(sgn, 0, 0));
    for (let i = 0; i < sides; i++) {
      const i1 = (i + 1) % sides;
      for (const p of [new THREE.Vector3(x, 0, 0), ring[sgn > 0 ? i : i1], ring[sgn > 0 ? i1 : i]]) P.push(p.x, p.y, p.z), C.push(...c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(C, 3));
  return g;
}

let shared: { tex: THREE.Texture; smoke: THREE.Texture; flash: THREE.BufferGeometry; brass: THREE.BufferGeometry; shotgun: THREE.BufferGeometry } | null = null;
const assets = () => (shared ??= { tex: flashTexture(), smoke: smokeTexture(), flash: flashGeometry(), brass: shellGeometry(0.62, 0.17, null), shotgun: shellGeometry(1.05, 0.3, 0xc43c2c) });
/** The flash texture / quads and the casings, shared with the third-person bunny's gun (player/bunny/gun-fx.ts). */
export const gunFxAssets = assets;

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export class GunFx {
  private flash: THREE.Mesh;
  private flashMat: THREE.MeshBasicMaterial;
  private flashAge = Infinity;
  private flashRoll = 0;
  private flashSize = 1;
  private camSpace = new THREE.Group();
  private pools: { mesh: THREE.InstancedMesh; shells: Shell[] }[];
  private def: GunDef | null = null;
  /** Pending spawns (placed at the next render with that frame's pose). */
  private pendingFlash = false;
  private pendingEject = 0;
  private pendingQuiet = false;
  /** The flash is a silenced shot's: a small dim puff at the silencer's tip. */
  private quiet = false;
  private gravity = new THREE.Vector3(0, -GRAVITY, 0);
  private m = new THREE.Matrix4();
  private v = new THREE.Vector3();
  private d = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private dq = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private e = new THREE.Euler();
  private soft = reduced();
  private smoke: { sprites: THREE.Sprite[]; mats: THREE.SpriteMaterial[]; puffs: Smoke[]; next: number };
  private lightAge = Infinity;
  private lightK = 1;
  private pendingSmoke = false;
  /** The player is on the ground (the viewmodel sets it from the movement): shells bounce and land only then. */
  grounded = true;
  /** Potato graphics: no smoke (the viewmodel sets it). */
  cheap = false;
  /** A case hit the floor (`hull`: a shotgun's; the "caseMetal" / "caseShell" cues). */
  onBounce: ((hull: boolean) => void) | null = null;
  private up = new THREE.Vector3();

  constructor(scene: THREE.Scene, root: THREE.Object3D) {
    const a = assets();
    this.flashMat = new THREE.MeshBasicMaterial({ map: a.tex, color: 0xffd9a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    this.flash = new THREE.Mesh(a.flash, this.flashMat);
    this.flash.matrixAutoUpdate = false;
    this.flash.frustumCulled = false;
    this.flash.visible = false;
    this.flash.renderOrder = 2;
    root.add(this.flash);
    this.camSpace.matrixAutoUpdate = false;
    scene.add(this.camSpace);
    // Smoke: sprites in camera space (they stay with you, like the shells), one material each (own opacity).
    const sprites: THREE.Sprite[] = [], mats: THREE.SpriteMaterial[] = [];
    for (let i = 0; i < SMOKE_POOL; i++) {
      const sm = new THREE.SpriteMaterial({ map: a.smoke, transparent: true, depthWrite: false, depthTest: false, opacity: 0 });
      const sp = new THREE.Sprite(sm);
      sp.visible = false;
      sp.frustumCulled = false;
      sp.renderOrder = 1;
      this.camSpace.add(sp);
      sprites.push(sp);
      mats.push(sm);
    }
    this.smoke = { sprites, mats, puffs: sprites.map(() => ({ age: Infinity, p: new THREE.Vector3(), v: new THREE.Vector3(), s: 1, a: 0 })), next: 0 };
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.pools = [a.brass, a.shotgun].map((g) => {
      const mesh = new THREE.InstancedMesh(g, mat, POOL);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.camSpace.add(mesh);
      const shells: Shell[] = Array.from({ length: POOL }, () => ({ alive: false, bounced: false, age: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), s: 1 }));
      return { mesh, shells };
    });
  }

  setGun(def: GunDef): void {
    this.def = def;
    this.flashAge = Infinity;
    this.flash.visible = false;
  }

  /** A shot: the flash, and (`eject` 1) a shell now; the M3 ejects on its pump instead (eject()). `quiet`: silenced. */
  shot(eject: number, quiet = false): void {
    this.pendingFlash = true;
    this.pendingSmoke = true;
    this.pendingQuiet = quiet;
    this.pendingEject += eject;
  }

  eject(): void {
    this.pendingEject++;
  }

  /** The muzzle light's strength now (0..1, a quick flash): the gun material lights hands + gun with it. */
  flashLight(): number {
    return this.lightAge < LIGHT_LIFE ? this.lightK * (1 - this.lightAge / LIGHT_LIFE) ** 2 : 0;
  }

  /** Ages the flash, moves the shells and the smoke (camera space). */
  update(dt: number): void {
    this.flashAge += dt;
    this.lightAge += dt;
    for (const p of this.smoke.puffs) {
      if (p.age === Infinity) continue;
      p.age += dt;
      if (p.age >= SMOKE_LIFE) {
        p.age = Infinity;
        continue;
      }
      p.v.multiplyScalar(Math.exp(-3 * dt));
      p.p.addScaledVector(p.v, dt);
      // Drifts up (against the world's down).
      p.p.addScaledVector(this.up, 6 * dt);
    }
    for (const pool of this.pools) {
      for (const s of pool.shells) {
        if (!s.alive) continue;
        s.age += dt;
        if (s.age >= SHELL_LIFE) {
          s.alive = false;
          continue;
        }
        s.v.addScaledVector(this.gravity, dt);
        s.v.multiplyScalar(Math.exp(-0.6 * dt));
        s.p.addScaledVector(s.v, dt);
        // One bounce off the floor at the feet (camera space: `up` is the world's up).
        const h = s.p.dot(this.up);
        // Only on the ground: in the air there is no floor under you (the case just falls, spins and fades, silently).
        if (!s.bounced && this.grounded && h < -FLOOR) {
          s.bounced = true;
          const vn = s.v.dot(this.up);
          if (vn < 0) s.v.addScaledVector(this.up, -vn * 1.35).multiplyScalar(0.45);
          s.p.addScaledVector(this.up, -FLOOR - h);
          s.w.multiplyScalar(-0.6).add(this.d.set(Math.random() - 0.5, 0, Math.random() - 0.5).multiplyScalar(20));
          this.onBounce?.(pool === this.pools[1]);
        }
        this.dq.setFromAxisAngle(this.d.copy(s.w).normalize(), s.w.length() * dt);
        s.q.multiply(this.dq);
      }
    }
  }

  /** Per render: place this frame's spawns on the posed gun, write the flash and the instances. */
  beforeRender(vm: GunViewmodel, cam: THREE.Camera): void {
    const def = this.def;
    if (!def) return;
    this.camSpace.matrix.copy(cam.matrixWorld);
    this.camSpace.matrixWorldNeedsUpdate = true;
    // World down in camera space (for the next update).
    this.q.copy(cam.quaternion).invert();
    this.gravity.set(0, -GRAVITY, 0).applyQuaternion(this.q);
    this.up.set(0, 1, 0).applyQuaternion(this.q);
    if (this.pendingFlash) {
      this.pendingFlash = false;
      this.flashAge = 0;
      this.flashRoll = Math.random() * Math.PI * 2;
      const big = def.cls === "shotgun" ? 1.35 : def.cls === "smg" ? 0.85 : 1;
      this.quiet = this.pendingQuiet;
      this.flashSize = big * 1.15 * (0.85 + Math.random() * 0.3) * (this.soft ? 0.7 : 1) * (this.quiet ? 0.38 : 1);
      this.lightAge = 0;
      this.lightK = (this.quiet ? 0.25 : 1) * (def.cls === "shotgun" || def.cls === "sniper" ? 1.25 : def.cls === "smg" ? 0.7 : 1);
    }
    while (this.pendingEject > 0) {
      this.pendingEject--;
      this.spawnShell(vm, def);
    }
    // Flash: on the slide's muzzle (the slide carries the barrel's mouth on the pistols), rolled, fading over its life.
    if (this.flashAge < FLASH_LIFE) {
      // With the silencer on: at its tip (it rides the frame).
      const onSil = !!def.silencer && vm.anim.silenced && vm.anim.pose.sil > 0;
      const part = onSil ? "Sil" : def.cls === "pistol" ? "Slide" : "Gun";
      const W = vm.bonesW;
      const o = vm.partIndex(part) * 12;
      const mm = onSil ? def.silencer!.tip : def.muzzle;
      this.m.set(W[o], W[o + 1], W[o + 2], W[o] * mm[0] + W[o + 1] * mm[1] + W[o + 2] * mm[2] + W[o + 3], W[o + 4], W[o + 5], W[o + 6], W[o + 4] * mm[0] + W[o + 5] * mm[1] + W[o + 6] * mm[2] + W[o + 7], W[o + 8], W[o + 9], W[o + 10], W[o + 8] * mm[0] + W[o + 9] * mm[1] + W[o + 10] * mm[2] + W[o + 11], 0, 0, 0, 1);
      const k = 1 - this.flashAge / FLASH_LIFE;
      const sz = this.flashSize * (0.8 + 0.4 * k);
      this.flash.matrix.copy(this.m).multiply(this.m.makeRotationX(this.flashRoll)).multiply(this.m.makeScale(sz, sz, sz));
      this.flash.matrixWorldNeedsUpdate = true;
      this.flashMat.opacity = (this.quiet ? 0.45 : 0.85) * k;
      this.flash.visible = true;
    } else this.flash.visible = false;
    // Smoke: a couple of puffs off the muzzle per shot (not on Potato).
    if (this.pendingSmoke) {
      this.pendingSmoke = false;
      if (!this.cheap) this.spawnSmoke(vm, def);
    }
    for (let i = 0; i < SMOKE_POOL; i++) {
      const p = this.smoke.puffs[i], sp = this.smoke.sprites[i];
      if (p.age === Infinity) {
        sp.visible = false;
        continue;
      }
      const u = p.age / SMOKE_LIFE;
      sp.visible = true;
      sp.position.copy(p.p);
      sp.scale.setScalar(p.s * (1 + 2.2 * u));
      this.smoke.mats[i].opacity = p.a * (u < 0.15 ? u / 0.15 : 1 - (u - 0.15) / 0.85);
    }
    // Shells.
    for (const pool of this.pools) {
      let n = 0;
      for (const s of pool.shells) {
        if (!s.alive) continue;
        const fade = s.age > SHELL_LIFE - 0.15 ? (SHELL_LIFE - s.age) / 0.15 : 1;
        this.s.setScalar(s.s * fade);
        this.m.compose(s.p, s.q, this.s);
        pool.mesh.setMatrixAt(n++, this.m);
      }
      pool.mesh.count = n;
      if (n) pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Two puffs at the muzzle (camera space), a little ahead along the barrel; thinner for a silenced shot. */
  private spawnSmoke(vm: GunViewmodel, def: GunDef): void {
    const onSil = !!def.silencer && vm.anim.silenced && vm.anim.pose.sil > 0;
    const part = onSil ? "Sil" : def.cls === "pistol" ? "Slide" : "Gun";
    const mm = onSil ? def.silencer!.tip : def.muzzle;
    vm.pointOn(part, mm, this.v).applyMatrix4(vm.camRel);
    vm.dirOn(part, [1, 0, 0], this.d).transformDirection(vm.camRel);
    const heavy = def.cls === "shotgun" || def.cls === "sniper";
    for (let k = 0; k < 2; k++) {
      const i = this.smoke.next;
      this.smoke.next = (i + 1) % SMOKE_POOL;
      const p = this.smoke.puffs[i];
      p.age = 0;
      p.p.copy(this.v).addScaledVector(this.d, 0.6 + k * 0.9);
      p.v.copy(this.d).multiplyScalar(14 + k * 8).add(this.s.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(5));
      p.s = (heavy ? 1.6 : 1.0) * (0.8 + Math.random() * 0.4);
      p.a = (onSil ? 0.12 : heavy ? 0.32 : 0.22) * (def.cls === "smg" ? 0.6 : 1);
    }
  }

  private spawnShell(vm: GunViewmodel, def: GunDef): void {
    const pool = this.pools[def.shell === "shotgun" ? 1 : 0];
    let s = pool.shells.find((x) => !x.alive);
    if (!s) s = pool.shells.reduce((a, b) => (a.age > b.age ? a : b));
    const part = def.cls === "pistol" ? "Slide" : "Gun";
    // Port (viewmodel space) -> camera space through the viewmodel's root (offsets, feel, hand mirror).
    vm.pointOn(part, def.eject.p, this.v).applyMatrix4(vm.camRel);
    vm.dirOn(part, def.eject.dir, this.d).transformDirection(vm.camRel);
    s.alive = true;
    s.bounced = false;
    s.age = 0;
    s.p.copy(this.v);
    const speed = def.shell === "shotgun" ? 70 : 95;
    s.v.copy(this.d).multiplyScalar(speed * (0.85 + Math.random() * 0.3));
    s.v.y += 25 + Math.random() * 20;
    // Orientation: the casing's axis across the gun (sideways out of the port), then a random tumble.
    vm.dirOn(part, [0, -1, 0.2], this.d).transformDirection(vm.camRel);
    this.q.setFromUnitVectors(this.v.set(1, 0, 0), this.d);
    this.e.set(Math.random() * 0.4, Math.random() * 0.4, Math.random() * 0.4);
    s.q.copy(this.q).multiply(this.dq.setFromEuler(this.e));
    s.w.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, 18 + Math.random() * 14);
    s.s = def.shell === "smg" ? 0.85 : 1;
  }

  dispose(): void {
    this.flashMat.dispose();
    for (const m of this.smoke.mats) m.dispose();
    for (const p of this.pools) {
      (p.mesh.material as THREE.Material).dispose();
      p.mesh.dispose();
    }
  }
}
