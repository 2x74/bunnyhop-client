// Your bunny on the Loadout's stage (ui/loadout-stage.ts draws it with its own renderer: no WebGL context here).
//   solid  your bunny in its colourway, holding your knife in your gloves, wearing your hat: standing, turning slowly
//          (drag to turn it)
//   ghost  your PB ghost in its colour, hopping a small circle with its trail behind it
// Either one is framed to fit the stage at any aspect, centred: the bunny turns about the middle of its body.
// Reduced motion: no idle turn and no hopping (one still pose), dragging still turns it.

import * as THREE from "three";
import { cosmetic } from "../progression";
import type { CosmeticLoadout } from "../loadout";
import { PlayerModel, type PlayerPose } from "../player/model";
import { Trail } from "../player/trail";

export interface BunnyLook {
  /** "solid" = your bunny (colourway, hat, knife, gloves); "ghost" = your PB ghost (ghost + trail colours). */
  mode: "solid" | "ghost";
  outfit: string | null;
  playerGlow?: import("../player/glow-config").PlayerGlow | null;
  previewGlow?: boolean;
  ghost: string | null;
  trail: string | null;
  /** Knife, finish, gloves and hat the bunny wears. */
  loadout: CosmeticLoadout;
  /** Solid: a secret colourway not earned yet, as a flat "???" silhouette (no colours; drag to turn still works). */
  veil?: boolean;
}

const R = 42; // hop circle radius (units)
const SPEED = 300; // u/s
const JUMP = 301.993;
const GRAV = 800;
const HOP = (2 * JUMP) / GRAV;
const TRAIL_S = 1.1;
const STEP = 1 / 60;
/** The top of a hop (feet height, units). */
const JUMP_TOP = (JUMP * JUMP) / (2 * GRAV);
/** Camera angles from above (degrees): your bunny nearly level, the ghost's circle from higher up. */
const SOLID_PITCH = 8;
const GHOST_PITCH = 20;
/** The frame's height over what's framed (a little room above the hat and under the feet). */
const MARGIN = 1.16;
const D2R = Math.PI / 180;
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _box = new THREE.Box3();

const colorOf = (id: string | null, fallback: string) => cosmetic(id)?.color ?? fallback;
/** A two-tone item's second colour (ghost rim glow / trail tail), else null (one colour). */
const color2Of = (id: string | null) => cosmetic(id)?.color2 ?? null;
/** Source (x, y, z) -> three (x, z, -y). */
const toThree = (x: number, y: number, z: number, out: THREE.Vector3) => out.set(x, z, -y);

export class BunnyScene {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 1, 4000);
  private model: PlayerModel;
  private trail: Trail;
  private floor: THREE.Mesh;
  private ring: THREE.Mesh;
  private look: BunnyLook;
  private t = 0.35;
  private pts = new Float32Array(Math.ceil(TRAIL_S / STEP + 2) * 3);
  /** Solid: the turn (degrees) and its fling. */
  private turn = 0;
  private turnV = 0;
  /**
   * Solid: the posed body's box (bunny/model.ts bodyBox, model space, eased): where its middle sits off the model's
   * origin (cx, cy), how far it reaches from there, its feet and its top (hat included).
   */
  private body: { cx: number; cy: number; reach: number; z0: number; z1: number } | null = null;
  private reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  dragging = false;

  constructor(look: BunnyLook) {
    this.look = { ...look };
    this.floor = new THREE.Mesh(
      new THREE.CircleGeometry(R + 34, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05, depthWrite: false }),
    );
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(R - 1, R + 1, 96).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, depthWrite: false }),
    );
    this.scene.add(this.floor, this.ring);
    this.model = new PlayerModel(this.modelOptions(look));
    this.model.setNearFade(0, 0);
    this.model.setOpacity(look.mode === "ghost" ? 0.75 : 1);
    this.model.bunnyModel?.setSilhouette(!!look.veil && look.mode === "solid");
    this.trail = new Trail(colorOf(look.trail, "#ffc23d"), this.pts.length / 3, color2Of(look.trail));
    this.scene.add(this.model.root, this.trail.mesh);
    this.advance(this.reduced ? 1.2 : STEP);
  }

  private modelOptions(look: BunnyLook) {
    return look.mode === "ghost"
      ? ({ model: "bunny", style: "ghost", color: colorOf(look.ghost, "#ffc23d"), rim: color2Of(look.ghost), loadout: look.loadout } as const)
      : ({ model: "bunny", style: "solid", playerGlow: look.playerGlow ?? null, previewGlow: look.previewGlow, outfit: look.outfit ?? undefined, loadout: look.loadout } as const);
  }

  set(look: BunnyLook): void {
    const prev = this.look;
    this.look = { ...look };
    if (look.mode !== prev.mode || look.ghost !== prev.ghost) {
      this.model.setStyle(look.mode, look.mode === "ghost" ? colorOf(look.ghost, "#ffc23d") : undefined, undefined, look.mode === "ghost" ? color2Of(look.ghost) : undefined);
      this.model.setOpacity(look.mode === "ghost" ? 0.75 : 1);
    }
    if (look.outfit !== prev.outfit) this.model.bunnyModel?.setOutfit(look.outfit);
    this.model.setPlayerGlow(look.playerGlow ?? null);
    if (look.loadout !== prev.loadout) this.model.setLoadout(look.loadout);
    this.model.bunnyModel?.setSilhouette(!!look.veil && look.mode === "solid");
    this.trail.setColor(colorOf(look.trail, "#ffc23d"), color2Of(look.trail));
    if (look.mode !== prev.mode) this.advance(0);
  }

  /** A drag of dx CSS pixels (solid: turns the bunny). */
  drag(dx: number, w: number): void {
    const k = 540 / Math.max(240, w);
    this.turn += dx * k;
    this.turnV = dx * k * 60;
  }

  /** Lets go: keep a gentle fling. */
  release(): void {
    this.turnV = Math.max(-240, Math.min(240, this.turnV));
  }

  /**
   * The floor disc and its ring take a colour (the Loadout: the shown item's rarity; strength 0..1, quiet for common
   * items). null: back to the plain white floor.
   */
  setTint(color: string | null, strength = 1): void {
    const f = this.floor.material as THREE.MeshBasicMaterial;
    const r = this.ring.material as THREE.MeshBasicMaterial;
    f.color.set(color ?? 0xffffff);
    r.color.set(color ?? 0xffffff);
    f.opacity = color ? 0.05 + 0.07 * strength : 0.05;
    r.opacity = color ? 0.1 + 0.35 * strength : 0.08;
  }

  /** A little spin when something is equipped. */
  flourish(): void {
    if (!this.reduced) this.turnV += 420;
  }

  private standPose(): PlayerPose {
    return { position: [0, 0, 0], velocity: [0, 0, 0], yaw: 250 + this.turn, pitch: 4, crouched: false, grounded: true };
  }

  private hopPose(t: number): PlayerPose {
    const a = (t * SPEED) / R;
    const ph = ((t % HOP) + HOP) % HOP;
    const z = Math.max(0, JUMP * ph - 0.5 * GRAV * ph * ph);
    const yaw = (a * 180) / Math.PI + 90;
    const s = Math.sin(t * Math.PI * (2 / HOP));
    return {
      position: [Math.cos(a) * R, Math.sin(a) * R, z],
      velocity: [-Math.sin(a) * SPEED, Math.cos(a) * SPEED, JUMP - GRAV * ph],
      yaw: yaw + 12 * s,
      pitch: 6,
      crouched: false,
      grounded: ph < 0.02,
      sidemove: -450,
    };
  }

  /** Steps the model by dt (s). */
  advance(dt: number): void {
    if (this.look.mode === "solid") {
      if (!this.dragging) {
        const damp = Math.exp(-dt * 2.4);
        this.turnV *= damp;
        this.turn += (this.turnV + (this.reduced ? 0 : 14)) * dt;
      }
      this.model.setState(this.standPose());
      this.model.update(Math.max(dt, 1e-4));
      this.centre(dt);
      return;
    }
    if (this.reduced) dt = 0;
    if (dt <= 0) {
      this.model.setState(this.hopPose(this.t));
      this.model.update(1e-4);
      return;
    }
    for (let left = dt; left > 1e-6; left -= STEP) {
      this.t += Math.min(STEP, left);
      this.model.setState(this.hopPose(this.t));
      this.model.update(Math.min(STEP, left));
    }
  }

  /**
   * Solid: turns the bunny about the middle of its body rather than the model's origin (the stance stands it off it),
   * so it stays centred as it turns; and keeps the body's size for framing. Eased: the ears and the idle move the box.
   */
  private centre(dt: number): void {
    const bm = this.model.bunnyModel;
    if (!bm) return;
    const box = bm.bodyBox(_box);
    if (box.isEmpty()) return;
    const cx = (box.min.x + box.max.x) / 2, cy = (box.min.y + box.max.y) / 2;
    const m = { cx, cy, reach: Math.hypot(box.max.x - cx, box.max.y - cy), z0: box.min.z, z1: box.max.z };
    const b = this.body;
    if (!b) this.body = m;
    else {
      const k = 1 - Math.exp(-Math.max(dt, 1e-4) * 5);
      for (const key of ["cx", "cy", "reach", "z0", "z1"] as const) b[key] += (m[key] - b[key]) * k;
    }
    // The middle, turned with the feet (Source, about z), to three.js: the model's root goes the other way.
    const { cx: x, cy: y } = this.body!;
    const a = bm.feetYaw * D2R;
    const ox = x * Math.cos(a) - y * Math.sin(a), oy = x * Math.sin(a) + y * Math.cos(a);
    this.model.root.position.set(-ox, this.model.root.position.y, oy);
  }

  /** Draws into the renderer's current viewport (w x h CSS pixels). */
  render(r: THREE.WebGLRenderer, w: number, h: number): void {
    const cam = this.camera;
    cam.aspect = w / Math.max(1, h);
    const ghost = this.look.mode === "ghost";
    this.ring.visible = ghost;
    this.trail.mesh.visible = ghost;
    if (ghost) {
      // The hop circle and the highest hop, seen from a little above.
      this.frame(GHOST_PITCH, R + 18, 0, JUMP_TOP + 80);
      const n = this.pts.length / 3;
      const v = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        const tt = this.t - TRAIL_S + (TRAIL_S * i) / (n - 1);
        const p = this.hopPose(tt).position;
        toThree(p[0], p[1], p[2] + 34, v);
        this.pts[i * 3] = v.x;
        this.pts[i * 3 + 1] = v.y;
        this.pts[i * 3 + 2] = v.z;
      }
      this.trail.set(this.pts, n, cam.position, 0.9, 5);
    } else {
      // The body as it turns (a cylinder about its middle: the framing holds still while it turns), hat and ears in.
      const b = this.body;
      this.frame(SOLID_PITCH, b ? b.reach : 24, b ? b.z0 : 0, b ? b.z1 : 80);
    }
    r.render(this.scene, cam);
  }

  /**
   * Points the camera at the middle of an upright cylinder about the origin (radius `reach`, from height z0 to z1),
   * `pitch` degrees from above, just far enough back for all of it to fit with MARGIN to spare: centred in the frame
   * whatever its aspect.
   */
  private frame(pitch: number, reach: number, z0: number, z1: number): void {
    const cam = this.camera;
    const a = pitch * D2R;
    const dir = _dir.set(0, Math.sin(a), Math.cos(a));
    const up = _up.set(0, Math.cos(a), -Math.sin(a));
    const mid = (z0 + z1) / 2;
    const tanV = Math.tan((cam.fov * D2R) / 2) / MARGIN;
    const tanH = tanV * cam.aspect;
    // Per point (relative to the target): d >= its depth towards the camera + its spread / the half fov's tangent.
    let d = 0;
    for (let i = 0; i < 16; i++) {
      const t = (i / 16) * Math.PI * 2;
      const x = Math.cos(t) * reach, z = Math.sin(t) * reach;
      for (const y of [z0 - mid, z1 - mid]) {
        const depth = y * dir.y + z * dir.z;
        const vy = y * up.y + z * up.z;
        d = Math.max(d, depth + Math.abs(vy) / tanV, depth + Math.abs(x) / tanH);
      }
    }
    cam.position.set(0, mid, 0).addScaledVector(dir, d);
    cam.lookAt(0, mid, 0);
    cam.updateProjectionMatrix();
  }

  dispose(): void {
    this.model.dispose();
    this.trail.dispose();
    for (const m of [this.floor, this.ring]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
